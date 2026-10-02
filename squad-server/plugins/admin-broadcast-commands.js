import fs from 'fs';

import BasePlugin from './base-plugin.js';
import ForumBroadcasts from './admin-broadcast-commands/forum-broadcasts.js';

export default class AdminBroadcastCommands extends BasePlugin {
  static get description() {
    return (
      'Handles admin chat commands for broadcasting preset messages with support for aliases, partial matching, and delay mode. ' +
      'The broadcasts can be kept in a Discord forum channel: one post per broadcast, the post title is ' +
      '<code>Name | alias1, alias2</code>, and the newest message in the post that has text and does not start ' +
      'with <code>//</code> is the broadcast text. The pinned post is skipped, so it can hold instructions. ' +
      'Changes apply without a restart.'
    );
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      commandPrefixes: {
        required: false,
        description: 'A list of prefixes used for the broadcast command.',
        default: ['!broadcast', '!bc']
      },
      delayMode: {
        required: false,
        description: 'Whether to use delay mode when sending multiple messages.',
        default: false
      },
      delayBetweenMessages: {
        required: false,
        description: 'The delay in milliseconds between messages in delay mode.',
        default: 5000
      },
      showAliasesInList: {
        required: false,
        description: 'Whether to show aliases in the broadcast options list.',
        default: false
      },
      multipartMessagePrefix: {
        required: false,
        description: 'Prefix to add to continuation messages when splitting long broadcasts.',
        default: '(cont.) '
      },
      broadcasts: {
        required: false,
        description:
          'An array of broadcast options with name, aliases, and message. With a forum channel, these are used ' +
          'until the forum is loaded, and to create the first posts when the forum is empty.',
        default: []
      },
      discordClient: {
        required: false,
        description: 'Discord connector name. Needed only for a forum channel.',
        connector: 'discord',
        default: 'discord'
      },
      forumChannelID: {
        required: false,
        description:
          'ID of the Discord forum channel with the broadcasts. Leave empty to use only the config.',
        default: ''
      },
      editorRoleIDs: {
        required: false,
        description:
          'Role IDs whose messages count as broadcast text. Leave empty to accept every message that ' +
          'the channel permissions allow.',
        default: []
      },
      order: {
        required: false,
        description:
          'Order of the forum broadcasts in the list: "created" (oldest post first, new posts are added at ' +
          'the end) or "name".',
        default: 'created'
      },
      seedForumFromConfig: {
        required: false,
        description: 'When the forum has no posts, create one post per configured broadcast.',
        default: true
      },
      reloadInterval: {
        required: false,
        description:
          'Time between full reloads of the forum, in milliseconds. Edits of older messages are not ' +
          'always reported by Discord, so they are picked up by this reload.',
        default: 10 * 60 * 1000
      },
      stateFile: {
        required: false,
        description:
          'File for the last list loaded from the forum, used when Discord is not available at startup.',
        default: './admin-broadcast-commands-state.json'
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.onChatMessage = this.onChatMessage.bind(this);
    this.onForumEvent = this.onForumEvent.bind(this);
    this.reloadForum = this.reloadForum.bind(this);

    this.broadcasts = this.options.broadcasts;
    this.reloadRunning = false;
    this.reloadPending = false;
  }

  async mount() {
    this.server.on('CHAT_MESSAGE', this.onChatMessage);

    if (!this.options.forumChannelID) return;
    if (!this.options.discordClient) {
      this.verbose(
        1,
        'forumChannelID is set, but the Discord connector is missing. Using the config.'
      );
      return;
    }

    this.loadState();
    this.forum = new ForumBroadcasts({
      client: this.options.discordClient,
      forumChannelID: this.options.forumChannelID,
      editorRoleIDs: this.options.editorRoleIDs,
      order: this.options.order,
      verbose: (...args) => this.verbose(...args)
    });

    this.forumEvents = [
      'threadCreate',
      'threadUpdate',
      'threadDelete',
      'messageCreate',
      'messageUpdate',
      'messageDelete'
    ];
    for (const event of this.forumEvents) this.options.discordClient.on(event, this.onForumEvent);
    this.reloadTimer = setInterval(this.reloadForum, this.options.reloadInterval);

    await this.reloadForum();
  }

  async unmount() {
    this.server.removeListener('CHAT_MESSAGE', this.onChatMessage);
    if (this.forumEvents)
      for (const event of this.forumEvents)
        this.options.discordClient.removeListener(event, this.onForumEvent);
    clearInterval(this.reloadTimer);
    clearTimeout(this.reloadDebounce);
  }

  // Thread events pass the thread; message events pass the message, whose channel is the thread.
  onForumEvent(item) {
    const thread = item?.isThread?.() ? item : item?.channel;
    const parentID =
      thread?.parentId ?? this.options.discordClient.channels.cache.get(item?.channelId)?.parentId;
    if (parentID !== this.options.forumChannelID) return;

    // Several changes in a few seconds lead to one reload.
    clearTimeout(this.reloadDebounce);
    this.reloadDebounce = setTimeout(this.reloadForum, 3000);
  }

  async reloadForum() {
    if (this.reloadRunning) {
      this.reloadPending = true;
      return;
    }
    this.reloadRunning = true;

    try {
      let result = await this.forum.load();
      if (
        result.postCount === 0 &&
        this.options.seedForumFromConfig &&
        this.options.broadcasts.length > 0
      ) {
        await this.forum.seed(this.options.broadcasts);
        result = await this.forum.load();
      }

      if (result.broadcasts.length === 0) {
        this.verbose(1, 'The forum has no usable broadcasts. The previous list stays in use.');
      } else {
        this.broadcasts = result.broadcasts;
        await this.saveState();
        this.verbose(1, `Loaded ${this.broadcasts.length} broadcasts from the forum.`);
      }
    } catch (error) {
      this.verbose(1, `Could not load the forum. The previous list stays in use: ${error.message}`);
    } finally {
      this.reloadRunning = false;
      if (this.reloadPending) {
        this.reloadPending = false;
        this.reloadForum();
      }
    }
  }

  loadState() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.options.stateFile, 'utf8'));
      if (Array.isArray(saved.broadcasts) && saved.broadcasts.length > 0) {
        this.broadcasts = saved.broadcasts;
        this.verbose(1, `Using ${saved.broadcasts.length} broadcasts saved at ${saved.savedAt}.`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT')
        this.verbose(1, `Could not read ${this.options.stateFile}: ${error.message}`);
    }
  }

  // Written to a temporary file and renamed, so a stop during the write cannot leave a broken file.
  async saveState() {
    const state = { savedAt: new Date().toISOString(), broadcasts: this.broadcasts };
    const temporaryFile = `${this.options.stateFile}.tmp`;
    try {
      await fs.promises.writeFile(temporaryFile, JSON.stringify(state, null, 2));
      await fs.promises.rename(temporaryFile, this.options.stateFile);
    } catch (error) {
      this.verbose(1, `Could not write ${this.options.stateFile}: ${error.message}`);
    }
  }

  async onChatMessage(info) {
    if (info.chat !== 'ChatAdmin') return;

    const prefix = this.options.commandPrefixes.find((p) => info.message.startsWith(p));
    if (!prefix) return;

    const args = info.message.slice(prefix.length).trim().split(' ');

    if (args.length === 0 || args[0] === '') {
      await this.sendBroadcastOptions(info.player.eosID);
    } else {
      await this.handleBroadcastCommand(info.player.eosID, args.join(' '));
    }
  }

  async handleBroadcastCommand(adminEosID, arg) {
    const matchedBroadcasts = this.findMatchingBroadcasts(arg);

    if (matchedBroadcasts.length === 0) {
      await this.server.rcon.warn(
        adminEosID,
        'No matching broadcast found. Please select a valid option from the list below:'
      );
      await this.sendBroadcastOptions(adminEosID);
    } else if (matchedBroadcasts.length > 1) {
      const names = matchedBroadcasts.map((b) => b.name).join(', ');
      await this.server.rcon.warn(
        adminEosID,
        `Multiple matches found: ${names}. Please be more specific.`
      );
    } else {
      const broadcast = matchedBroadcasts[0];
      await this.sendMultipartBroadcast(broadcast.message);
      await this.server.rcon.warn(adminEosID, `Broadcast sent: ${broadcast.name}`);
    }
  }

  async sendMultipartBroadcast(message) {
    const MAX_MESSAGE_LENGTH = 200;
    const prefix = this.options.multipartMessagePrefix;

    // If message is short enough, send it as a single broadcast
    if (message.length <= MAX_MESSAGE_LENGTH) {
      await this.server.rcon.broadcast(message);
      return;
    }

    // Split message into parts
    const parts = [];
    let remainingMessage = message;

    while (remainingMessage.length > 0) {
      // For second part onwards, account for prefix length in available space
      const availableLength =
        parts.length === 0 ? MAX_MESSAGE_LENGTH : MAX_MESSAGE_LENGTH - prefix.length;

      // If remaining message fits within the limit
      if (remainingMessage.length <= availableLength) {
        parts.push(remainingMessage);
        break;
      }

      // Find a good breaking point (space, period, comma, etc.)
      let breakPoint = availableLength;
      while (breakPoint > 0 && '.,!?; \n'.indexOf(remainingMessage.charAt(breakPoint)) === -1) {
        breakPoint--;
      }

      // If no good breaking point found, force break at the limit
      if (breakPoint === 0) breakPoint = availableLength;

      // Add part and prepare for next iteration
      parts.push(remainingMessage.substring(0, breakPoint + 1).trim());
      remainingMessage = remainingMessage.substring(breakPoint + 1).trim();
    }

    // Send each part with optional delay
    if (this.options.delayMode) {
      let isFirst = true;
      for (const part of parts) {
        const formattedPart = isFirst ? part : `${prefix}${part}`;
        await this.server.rcon.broadcast(formattedPart);
        await new Promise((resolve) => setTimeout(resolve, this.options.delayBetweenMessages));
        isFirst = false;
      }
    } else {
      let isFirst = true;
      for (const part of parts) {
        const formattedPart = isFirst ? part : `${prefix}${part}`;
        await this.server.rcon.broadcast(formattedPart);
        isFirst = false;
      }
    }
  }

  findMatchingBroadcasts(arg) {
    const lowercaseArg = arg.toLowerCase();
    return this.broadcasts.filter((broadcast, index) => {
      if ((index + 1).toString() === arg) return true;
      if (broadcast.name.toLowerCase().includes(lowercaseArg)) return true;
      return broadcast.aliases.some((alias) => alias.toLowerCase().includes(lowercaseArg));
    });
  }

  async sendBroadcastOptions(adminEosID) {
    const messages = ['Available broadcast options:'];
    let currentMessage = '';

    this.broadcasts.forEach((broadcast, index) => {
      const optionText = `\n${index + 1}. ${broadcast.name}${
        this.options.showAliasesInList ? ` (${broadcast.aliases.join(', ')})` : ''
      }`;
      if (currentMessage.length + optionText.length > 200) {
        messages.push(currentMessage);
        currentMessage = 'Broadcast options (continued):';
      }
      currentMessage += optionText;
    });

    if (currentMessage !== 'Broadcast options (continued):') {
      messages.push(currentMessage);
    }

    messages.push(`To use a broadcast, type '!b <number/name/alias>' (e.g., '!b 1' or '!b Mines')`);

    if (this.options.delayMode) {
      for (const message of messages) {
        await this.server.rcon.warn(adminEosID, message);
        await new Promise((resolve) => setTimeout(resolve, this.options.delayBetweenMessages));
      }
    } else {
      for (const message of messages) {
        await this.server.rcon.warn(adminEosID, message);
      }
    }
  }
}
