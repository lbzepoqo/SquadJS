import { createCanvas, loadImage } from 'canvas';

import { CARD_HEIGHT, CARD_WIDTH } from './card.js';

// node-canvas decodes these; WebP and other types are skipped.
const DECODABLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif']);
const EVENT_REFRESH_DELAY_MS = 5 * 1000;

/**
 * The image attachment of a post's starter message to use as a background, or null when the post has
 * none that fits. `skipped` collects why an image was passed over.
 */
export function backgroundAttachment(message, maxBytes, skipped = []) {
  for (const attachment of message?.attachments?.values() ?? []) {
    if (!attachment.contentType?.startsWith('image/')) continue;
    if (!DECODABLE_TYPES.has(attachment.contentType.split(';')[0]))
      skipped.push(`${attachment.name} is ${attachment.contentType}, use PNG or JPEG`);
    else if (attachment.size > maxBytes)
      skipped.push(`${attachment.name} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    else return attachment;
  }
  return null;
}

// Scales the photo to cover the whole card and crops the overflow evenly from both sides.
async function coverCrop(imageBuffer) {
  const image = await loadImage(imageBuffer);
  const scale = Math.max(CARD_WIDTH / image.width, CARD_HEIGHT / image.height);
  const sourceWidth = CARD_WIDTH / scale;
  const sourceHeight = CARD_HEIGHT / scale;
  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  canvas
    .getContext('2d')
    .drawImage(
      image,
      (image.width - sourceWidth) / 2,
      (image.height - sourceHeight) / 2,
      sourceWidth,
      sourceHeight,
      0,
      0,
      CARD_WIDTH,
      CARD_HEIGHT
    );
  return canvas.toBuffer('image/jpeg', { quality: 0.9 });
}

/**
 * Card backgrounds from the posts of a Discord forum or media channel. Only posts with the approval tag are
 * used; a moderated tag can only be set by members who can manage threads.
 * The photos are kept in memory, already cropped to the card size, keyed by thread. Discord's attachment URLs
 * expire, so each photo is downloaded once, when its post is first seen.
 */
export default class BackgroundLibrary {
  constructor({ client, channelID, tagID, maxBytes, log }) {
    this.client = client;
    this.channelID = channelID;
    this.tagID = tagID;
    this.maxBytes = maxBytes;
    this.log = log;
    this.backgrounds = new Map();
    this.skippedThreads = new Set();
    this.refreshing = null;
    this.eventTimeout = null;
    this.onThreadEvent = this.onThreadEvent.bind(this);
  }

  // Thread events only bring the next refresh forward; the refresh reads the channel itself, because
  // Discord sends threadUpdate only for threads the bot has cached.
  // The first argument of threadCreate, threadUpdate and threadDelete is always a thread of the channel.
  onThreadEvent(thread) {
    if (thread.parentId !== this.channelID) return;
    clearTimeout(this.eventTimeout);
    this.eventTimeout = setTimeout(() => this.refresh(), EVENT_REFRESH_DELAY_MS);
  }

  stop() {
    clearTimeout(this.eventTimeout);
  }

  refresh() {
    if (!this.refreshing)
      this.refreshing = this.readChannel()
        .catch((error) => this.log(`Could not read the background channel: ${error.message}`))
        .finally(() => {
          this.refreshing = null;
        });
    return this.refreshing;
  }

  async readChannel() {
    const channel = await this.client.channels.fetch(this.channelID);
    const threads = [...(await channel.threads.fetchActive(false)).threads.values()];
    let before;
    let hasMore = true;
    while (hasMore) {
      const page = await channel.threads.fetchArchived(
        { type: 'public', before, limit: 100 },
        false
      );
      threads.push(...page.threads.values());
      hasMore = page.hasMore && page.threads.size > 0;
      before = page.threads.last()?.archivedAt;
    }

    const approved = threads.filter((thread) => thread.appliedTags.includes(this.tagID));
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
    const skipped = [];
    const attachment = backgroundAttachment(message, this.maxBytes, skipped);
    if (!attachment) {
      const reason = skipped.length > 0 ? skipped.join('; ') : 'no image';
      // Remembered so the log line is written once; an edited post is read again after a restart.
      this.skippedThreads.add(thread.id);
      this.log(`Skipped background post "${thread.name}": ${reason}.`);
      return;
    }
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
    this.backgrounds.set(thread.id, {
      image: await coverCrop(Buffer.from(await response.arrayBuffer())),
      credit: message.member?.displayName ?? message.author.displayName
    });
  }

  /** A random approved photo as `{ image, credit }`, or null when there is none. */
  async pick() {
    const choices = [...this.backgrounds.values()];
    if (choices.length === 0) return null;
    const { image, credit } = choices[Math.floor(Math.random() * choices.length)];
    return { image: await loadImage(image), credit };
  }
}
