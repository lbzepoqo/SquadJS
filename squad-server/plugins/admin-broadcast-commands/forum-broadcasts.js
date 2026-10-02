import { ChannelFlags, ChannelType } from 'discord.js';

const IN_USE = '✅';
const SKIPPED = '⚠️';
const TITLE_MAX_LENGTH = 100;
const MESSAGES_PER_POST = 50;

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

// A message counts as broadcast text when it has text and does not start with "//".
export function isBroadcastText(message) {
  const text = (message.content || '').trim();
  return text.length > 0 && !text.startsWith('//');
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

      let current = null;
      for (const message of messages) {
        if (!isBroadcastText(message)) continue;
        if (!(await this.isEditor(post, message))) {
          await this.setReaction(message, SKIPPED, true);
          this.verbose(
            1,
            `Post "${post.name}": message by ${message.author?.tag} skipped, no editor role.`
          );
          continue;
        }
        current = message;
        break;
      }

      let problem = null;
      if (!name) problem = 'the title has no name';
      else if (!current) problem = 'no message with text';
      else if (names.has(name.toLowerCase()))
        problem = `the name "${name}" is used by an older post`;

      if (problem) {
        this.verbose(1, `Post "${post.name}" skipped: ${problem}.`);
        if (current) await this.setReaction(current, SKIPPED, true);
        continue;
      }

      names.add(name.toLowerCase());
      broadcasts.push({ name, aliases, message: current.content.trim() });
      await this.markCurrent(messages, current);
    }

    if (this.order === 'name') broadcasts.sort((a, b) => a.name.localeCompare(b.name));
    return { broadcasts, postCount: posts.length };
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
    for (const message of messages) {
      await this.setReaction(message, IN_USE, message === current);
      if (message === current) await this.setReaction(message, SKIPPED, false);
    }
  }

  async setReaction(message, emoji, wanted) {
    try {
      // "⚠️" can be stored with or without the variation selector U+FE0F.
      const plain = emoji.replace(/️/g, '');
      const reaction = message.reactions.cache.find(
        (candidate) => (candidate.emoji.name || '').replace(/️/g, '') === plain
      );
      const present = !!reaction?.me;
      if (wanted && !present) await message.react(emoji);
      if (!wanted && present) await reaction.users.remove(this.client.user.id);
    } catch (error) {
      this.verbose(2, `Could not update the ${emoji} reaction: ${error.message}`);
    }
  }
}
