import BasePlugin from './base-plugin.js';

export default class AdminBroadcastCommands extends BasePlugin {
  static get description() {
    return 'Handles admin chat commands for broadcasting preset messages with support for aliases, partial matching, and delay mode.';
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
        required: true,
        description: 'An array of broadcast options with name, aliases, and message.',
        default: []
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.onChatMessage = this.onChatMessage.bind(this);
  }

  async mount() {
    this.server.on('CHAT_MESSAGE', this.onChatMessage);
  }

  async unmount() {
    this.server.removeListener('CHAT_MESSAGE', this.onChatMessage);
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
    return this.options.broadcasts.filter((broadcast, index) => {
      if ((index + 1).toString() === arg) return true;
      if (broadcast.name.toLowerCase().includes(lowercaseArg)) return true;
      return broadcast.aliases.some((alias) => alias.toLowerCase().includes(lowercaseArg));
    });
  }

  async sendBroadcastOptions(adminEosID) {
    const messages = ['Available broadcast options:'];
    let currentMessage = '';

    this.options.broadcasts.forEach((broadcast, index) => {
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
