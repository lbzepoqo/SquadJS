import { loadImage } from 'canvas';

import { cropToCard } from './card.js';

// node-canvas decodes these; WebP and other types are skipped.
const DECODABLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif']);
// A decoded photo takes 4 bytes per pixel in memory, so 50 megapixels take about 200 MB while it is cropped.
const MAX_MEGAPIXELS = 50;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const EVENT_REFRESH_DELAY_MS = 5 * 1000;
const THREAD_EVENTS = ['threadCreate', 'threadUpdate', 'threadDelete'];

const megabytes = (bytes) => `${Number((bytes / 1024 / 1024).toPrecision(2))} MB`;

/**
 * The image attachment of a post's starter message to use as a background (null when the post has none
 * that fits), and why other images were passed over.
 */
export function backgroundAttachment(message, maxBytes) {
  const reasons = [];
  for (const attachment of message?.attachments?.values() ?? []) {
    if (!attachment.contentType?.startsWith('image/')) continue;
    if (!DECODABLE_TYPES.has(attachment.contentType.split(';')[0]))
      reasons.push(`${attachment.name} is ${attachment.contentType}, use PNG, JPEG or GIF`);
    else if (attachment.size > maxBytes)
      reasons.push(`${attachment.name} is larger than ${megabytes(maxBytes)}`);
    else if ((attachment.width * attachment.height) / 1e6 > MAX_MEGAPIXELS)
      reasons.push(
        `${attachment.name} is ${attachment.width}x${attachment.height} pixels, more than ${MAX_MEGAPIXELS} megapixels`
      );
    else return { attachment, reasons };
  }
  return { attachment: null, reasons };
}

/**
 * Card backgrounds from the posts of a Discord forum or media channel. Only posts with the approval tag are
 * used; a moderated tag can only be set by members who can manage threads.
 * The photos are kept in memory, already cropped to the card size, keyed by thread. Discord's attachment URLs
 * expire, so each photo is downloaded once, when its post is first seen.
 */
export default class BackgroundLibrary {
  constructor({ client, channelID, tagID, maxBytes, refreshInterval, log }) {
    this.client = client;
    this.channelID = channelID;
    this.tagID = tagID;
    this.maxBytes = maxBytes;
    this.refreshInterval = refreshInterval;
    this.log = log;
    this.backgrounds = new Map();
    this.skippedThreads = new Set();
    this.refreshing = null;
    this.isRefreshDue = false;
    this.eventTimeout = null;
    this.refreshTimer = null;
    this.onThreadEvent = this.onThreadEvent.bind(this);
  }

  start() {
    for (const event of THREAD_EVENTS) this.client.on(event, this.onThreadEvent);
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), this.refreshInterval);
  }

  stop() {
    for (const event of THREAD_EVENTS) this.client.removeListener(event, this.onThreadEvent);
    this.isRefreshDue = false;
    clearTimeout(this.eventTimeout);
    clearInterval(this.refreshTimer);
  }

  // Thread events only bring the next refresh forward; the refresh reads the channel itself. discord.js
  // emits threadUpdate and threadDelete only for cached threads, so the refresh caches the posts it reads.
  // The first argument of threadCreate, threadUpdate and threadDelete is always a thread of the channel.
  onThreadEvent(thread) {
    if (thread.parentId !== this.channelID) return;
    clearTimeout(this.eventTimeout);
    this.eventTimeout = setTimeout(() => this.refresh(), EVENT_REFRESH_DELAY_MS);
  }

  // A refresh asked for during a read runs once more after it, since that read may predate the change.
  refresh() {
    if (this.refreshing) {
      this.isRefreshDue = true;
      return this.refreshing;
    }
    this.refreshing = this.readChannel()
      .catch((error) => this.log(`Could not read the background channel: ${error.message}`))
      .finally(() => {
        this.refreshing = null;
        if (!this.isRefreshDue) return;
        this.isRefreshDue = false;
        this.refresh();
      });
    return this.refreshing;
  }

  // Posts are archived after a time without activity, so archived posts are read as well. Keyed by ID,
  // because a post archived between the two requests can appear in both.
  async fetchPosts() {
    const channel = await this.client.channels.fetch(this.channelID);
    const posts = new Map((await channel.threads.fetchActive()).threads);
    let before;
    for (;;) {
      const archived = await channel.threads.fetchArchived({ type: 'public', before, limit: 100 });
      for (const [id, thread] of archived.threads) posts.set(id, thread);
      if (!archived.hasMore || archived.threads.size === 0) break;
      before = archived.threads.last().archivedAt;
    }
    return [...posts.values()];
  }

  async readChannel() {
    const approved = (await this.fetchPosts()).filter((thread) =>
      thread.appliedTags.includes(this.tagID)
    );
    const approvedIDs = new Set(approved.map((thread) => thread.id));
    for (const threadID of this.backgrounds.keys())
      if (!approvedIDs.has(threadID)) this.backgrounds.delete(threadID);
    for (const threadID of this.skippedThreads)
      if (!approvedIDs.has(threadID)) this.skippedThreads.delete(threadID);

    for (const thread of approved) {
      if (this.backgrounds.has(thread.id) || this.skippedThreads.has(thread.id)) continue;
      try {
        await this.addPost(thread);
      } catch (error) {
        this.log(`Skipped background post "${thread.name}": ${error.message}`);
      }
    }
    this.log(`Backgrounds: ${this.backgrounds.size} approved photos.`);
  }

  async addPost(thread) {
    const message = await thread.fetchStarterMessage();
    const { attachment, reasons } = backgroundAttachment(message, this.maxBytes);
    if (!attachment) {
      // Remembered so the log line is written once; an edited post is read again after a restart.
      this.skippedThreads.add(thread.id);
      this.log(`Skipped background post "${thread.name}": ${reasons.join('; ') || 'no image'}.`);
      return;
    }
    const response = await fetch(attachment.url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
    const file = Buffer.from(await response.arrayBuffer());
    let image;
    try {
      image = await cropToCard(file);
    } catch (error) {
      // A file that cannot be decoded is not downloaded again; a failed download is retried.
      this.skippedThreads.add(thread.id);
      throw new Error(`the image cannot be read (${error.message})`);
    }
    this.backgrounds.set(thread.id, {
      image,
      credit: message.member?.displayName ?? message.author.displayName
    });
  }

  /** A random approved photo as `{ image, credit }`, or null when there is none or it cannot be read. */
  async pick() {
    const choices = [...this.backgrounds.values()];
    if (choices.length === 0) return null;
    const { image, credit } = choices[Math.floor(Math.random() * choices.length)];
    try {
      return { image: await loadImage(image), credit };
    } catch (error) {
      this.log(`Could not load a background photo: ${error.message}`);
      return null;
    }
  }
}
