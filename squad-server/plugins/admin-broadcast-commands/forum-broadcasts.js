import { ChannelFlags, ChannelType } from 'discord.js';

const IN_USE = '✅';
const SKIPPED = '⚠️';
const TITLE_MAX_LENGTH = 100;
const MESSAGES_PER_POST = 100;
const SET_COMMAND = /^!set(?:\s+|$)/i;

// A post title is "Name | alias1, alias2". Without "|", the whole title is the name.
export function parseTitle(title) {
  const separator = title.indexOf('|');
  if (separator === -1) return { name: title.trim(), aliases: [] };
  return {
    name: title.slice(0, separator).trim(),
    aliases: title
      .slice(separator + 1)
      .split(',')
      .map((alias) => alias.trim())
      .filter(Boolean)
  };
}

export function buildTitle(broadcast) {
  const aliases = broadcast.aliases?.length ? ` | ${broadcast.aliases.join(', ')}` : '';
  return `${broadcast.name}${aliases}`.slice(0, TITLE_MAX_LENGTH);
}

// Returns the new text of a "!set <text>" reply, "" for "!set" without text, or null for other messages.
export function parseSetCommand(content) {
  const text = (content || '').trim();
  if (!SET_COMMAND.test(text)) return null;
  return text.replace(SET_COMMAND, '').trim();
}

export default class ForumBroadcasts {
  constructor({ client, forumChannelID, editorRoleIDs = [], order = 'created', verbose }) {
    this.client = client;
    this.forumChannelID = forumChannelID;
    this.editorRoleIDs = editorRoleIDs;
    this.order = order;
    this.verbose = verbose;
  }

  async fetchForum() {
    const forum = await this.client.channels.fetch(this.forumChannelID);
    if (!forum || forum.type !== ChannelType.GuildForum)
      throw new Error(`Channel ${this.forumChannelID} is not a forum channel.`);
    return forum;
  }

  // Forum posts are archived after a time without activity, so archived posts are read as well.
  async fetchPosts(forum) {
    const posts = new Map();
    const active = await forum.threads.fetchActive();
    for (const [id, thread] of active.threads) posts.set(id, thread);

    let before;
    for (;;) {
      const archived = await forum.threads.fetchArchived({ type: 'public', before, limit: 100 });
      for (const [id, thread] of archived.threads) posts.set(id, thread);
      if (!archived.hasMore || archived.threads.size === 0) break;
      before = archived.threads.last();
    }
    return [...posts.values()];
  }

  // Creates one post per broadcast, in the given order, so that list numbers stay the same.
  async seed(broadcasts) {
    const forum = await this.fetchForum();
    for (const broadcast of broadcasts) {
      await forum.threads.create({
        name: buildTitle(broadcast),
        message: { content: broadcast.message }
      });
    }
    this.verbose(1, `Created ${broadcasts.length} forum posts from the configured broadcasts.`);
  }

  // Returns { broadcasts, postCount }. Marks the message in use with ✅ and skipped posts with ⚠️.
  async load() {
    const forum = await this.fetchForum();
    // The pinned post holds instructions for the admins, not a broadcast.
    const posts = (await this.fetchPosts(forum)).filter(
      (post) => !post.flags?.has?.(ChannelFlags.Pinned)
    );
    posts.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const broadcasts = [];
    const names = new Set();
    for (const post of posts) {
      const { name, aliases } = parseTitle(post.name);
      const messages = [...(await post.messages.fetch({ limit: MESSAGES_PER_POST })).values()].sort(
        (a, b) => b.createdTimestamp - a.createdTimestamp
      );
      // The first message of a post can be older than the fetched messages in a long post.
      const starter =
        messages.find((message) => message.id === post.id) ??
        (await post.fetchStarterMessage().catch(() => null));

      // The text is the newest "!set <text>" reply, or else the first message of the post.
      // Other replies are discussion and change nothing.
      let current = null;
      let text = null;
      for (const message of messages) {
        if (message === starter) continue;
        const newText = parseSetCommand(message.content);
        if (newText === null) continue;
        if (!newText) {
          await this.setReaction(message, SKIPPED, true);
          this.verbose(1, `Post "${post.name}": "!set" without text skipped.`);
          continue;
        }
        if (!(await this.isEditor(post, message))) {
          await this.setReaction(message, SKIPPED, true);
          this.verbose(
            1,
            `Post "${post.name}": "!set" by ${message.author?.tag} skipped, no editor role.`
          );
          continue;
        }
        current = message;
        text = newText;
        break;
      }
      if (!current && starter) {
        const starterText = parseSetCommand(starter.content) ?? (starter.content || '').trim();
        if (starterText) {
          current = starter;
          text = starterText;
        }
      }

      let problem = null;
      if (!name) problem = 'the title has no name';
      else if (!current) problem = 'no text';
      else if (names.has(name.toLowerCase()))
        problem = `the name "${name}" is used by an older post`;

      if (problem) {
        this.verbose(1, `Post "${post.name}" skipped: ${problem}.`);
        await this.setReaction(current ?? starter ?? messages[0], SKIPPED, true);
        continue;
      }

      names.add(name.toLowerCase());
      broadcasts.push({ name, aliases, message: text });
      await this.markCurrent([...messages, starter].filter(Boolean), current);
      await this.updateStarter(starter, text);
    }

    if (this.order === 'name') broadcasts.sort((a, b) => a.name.localeCompare(b.name));
    return { broadcasts, postCount: posts.length };
  }

  // The bot can only edit its own messages. For posts it created, the first message always shows the
  // current text, so the top of the post is what players see.
  async updateStarter(starter, text) {
    if (!starter || starter.author?.id !== this.client.user?.id || starter.content === text) return;
    try {
      await starter.edit(text);
    } catch (error) {
      this.verbose(1, `Could not update the first message of a post: ${error.message}`);
    }
  }

  async isEditor(post, message) {
    if (this.editorRoleIDs.length === 0) return true;
    if (message.author?.id === this.client.user?.id) return true;
    const member =
      message.member ?? (await post.guild.members.fetch(message.author.id).catch(() => null));
    return !!member && this.editorRoleIDs.some((roleID) => member.roles.cache.has(roleID));
  }

  // Only the message in use keeps ✅. Reactions are changed only when they differ, to keep API calls low.
  async markCurrent(messages, current) {
    for (const message of new Set(messages)) {
      await this.setReaction(message, IN_USE, message === current);
      if (message === current) await this.setReaction(message, SKIPPED, false);
    }
  }

  async setReaction(message, emoji, wanted) {
    if (!message) return;
    try {
      // "⚠️" can be stored with or without the variation selector U+FE0F.
      const plain = emoji.replace(/\uFE0F/g, '');
      const reaction = message.reactions.cache.find(
        (candidate) => (candidate.emoji.name || '').replace(/\uFE0F/g, '') === plain
      );
      const present = !!reaction?.me;
      if (wanted && !present) await message.react(emoji);
      if (!wanted && present) await reaction.users.remove(this.client.user.id);
    } catch (error) {
      this.verbose(2, `Could not update the ${emoji} reaction: ${error.message}`);
    }
  }
}
