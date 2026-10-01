import DiscordBasePlugin from './discord-base-plugin.js';

export default class DiscordAdminSyncChat extends DiscordBasePlugin {
  static get description() {
    return (
      'The <code>DiscordAdminSyncChat</code> plugin provides a bidirectional bridge between a ' +
      'Discord channel and in-game admin chat. In-game <code>ChatAdmin</code> messages are ' +
      'forwarded to Discord, and Discord messages in the channel are sent as warnings to all ' +
      'in-game admins with the <code>canseeadminchat</code> permission.'
    );
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      ...DiscordBasePlugin.optionsSpecification,
      channelID: {
        required: true,
        description: 'The ID of the Discord channel to use for admin sync chat.',
        default: '',
        example: '667741905228136459'
      },
      warnDelayMs: {
        required: false,
        description:
          'Delay in milliseconds between consecutive warn messages when a long message is split.',
        default: 3000
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.onChatMessage = this.onChatMessage.bind(this);
    this.onDiscordMessage = this.onDiscordMessage.bind(this);
  }

  async mount() {
    this.server.on('CHAT_MESSAGE', this.onChatMessage);
    this.options.discordClient.on('messageCreate', this.onDiscordMessage);
  }

  async unmount() {
    this.server.removeEventListener('CHAT_MESSAGE', this.onChatMessage);
    this.options.discordClient.removeEventListener('messageCreate', this.onDiscordMessage);
  }

  async onChatMessage(info) {
    if (info.chat !== 'ChatAdmin') return;

    await this.sendDiscordMessage({
      content: `**${info.player.name}**: ${info.message}`
    });
  }

  async onDiscordMessage(message) {
    if (message.author.bot) return;
    if (message.channel.id !== this.options.channelID) return;

    const adminEosIDs = this.server.getAdminsWithPermission('canseeadminchat', 'eosID');
    const onlineAdmins = this.server.players.filter((player) => adminEosIDs.includes(player.eosID));

    if (onlineAdmins.length === 0) return;

    const prefix = `[Discord] ${message.member?.displayName || message.author.username}: `;
    const maxLength = 80;
    const chunks = this.splitMessage(prefix, message.content, maxLength);

    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await this.delay(this.options.warnDelayMs);
      for (const player of onlineAdmins) {
        await this.server.rcon.warn(player.eosID, chunks[i]);
      }
    }
  }

  splitMessage(prefix, content, maxLength) {
    const firstAvailable = maxLength - prefix.length - 3;
    if (prefix.length + content.length <= maxLength) return [`${prefix}${content}`];

    const chunks = [];
    let remaining = content;
    const continuationAvailable = maxLength - 3;

    // First chunk: prefix + text + ...
    let splitAt = remaining.lastIndexOf(' ', firstAvailable);
    if (splitAt <= 0) splitAt = firstAvailable;
    chunks.push(`${prefix}${remaining.slice(0, splitAt)}...`);
    remaining = remaining.slice(splitAt).trimStart();

    // Subsequent chunks: ...text... or ...text
    while (remaining.length > 0) {
      if (remaining.length + 3 <= maxLength) {
        chunks.push(`...${remaining}`);
        break;
      }
      splitAt = remaining.lastIndexOf(' ', continuationAvailable);
      if (splitAt <= 0) splitAt = continuationAvailable;
      chunks.push(`...${remaining.slice(0, splitAt)}...`);
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
