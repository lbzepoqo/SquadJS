import DiscordBasePlugin from './discord-base-plugin.js';

export default class DiscordReloadConfig extends DiscordBasePlugin {
  static get description() {
    return (
      'The <code>DiscordReloadConfig</code> plugin allows authorized Discord users to activate whitelist ' +
      'and configuration changes by sending <code>!activate</code> in a specified Discord channel or its threads. ' +
      'Typically used after adding players to the priority queue following donations.'
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
        description:
          'ID of channel where the activate command can be used. Also works in threads within this channel. Ignored if allowAnyChannel is true.',
        default: '',
        example: '667741905228136459'
      },
      allowAnyChannel: {
        required: false,
        description:
          'Whether to allow the activate command in any channel/thread. When true, channelID restriction is bypassed.',
        default: false,
        example: true
      },
      permissions: {
        required: false,
        description:
          'List of Discord role IDs that are allowed to use the activate command. If empty, all users can use it.',
        default: [],
        example: ['123456789123456789', '987654321987654321']
      },
      embedImageURL: {
        required: false,
        description:
          'Image URL shown in the confirmation embed. Leave empty for no image. Use a permanent URL, because Discord attachment links expire.',
        default: ''
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.onMessage = this.onMessage.bind(this);
  }

  async mount() {
    this.verbose(
      1,
      `Mounting DiscordReloadConfig (Activate) - Channel: ${
        this.options.allowAnyChannel ? 'Any (unrestricted)' : this.options.channelID
      } | Roles: ${
        this.options.permissions.length > 0
          ? `[${this.options.permissions.join(', ')}]`
          : 'None (all users allowed)'
      }`
    );
    this.verbose(2, `Discord client: ${this.options.discordClient.user?.tag || 'Unknown'}`);

    this.options.discordClient.on('messageCreate', this.onMessage);
    this.verbose(1, `DiscordReloadConfig mounted successfully`);
  }

  async unmount() {
    this.options.discordClient.removeEventListener('messageCreate', this.onMessage);
  }

  async onMessage(message) {
    // check the author of the message is not a bot
    if (message.author.bot) {
      this.verbose(3, `Ignoring message from bot: ${message.author.username}`);
      return;
    }

    this.verbose(2, `Processing message from ${message.author.username} (${message.author.id})`);
    this.verbose(
      3,
      `Message: "${message.content}" | Channel: ${message.channel.id} (${
        message.channel.name || 'Unknown'
      }) | Thread: ${message.channel.isThread} | Parent: ${
        message.channel.parentId || 'None'
      } | Expected: ${this.options.channelID}`
    );

    // check if the message is in the correct channel OR if any channel is allowed
    if (!this.options.allowAnyChannel) {
      const isInCorrectChannel = message.channel.id === this.options.channelID;
      const isInThread =
        message.channel.isThread && message.channel.parentId === this.options.channelID;

      this.verbose(
        2,
        `Channel check - isInCorrectChannel: ${isInCorrectChannel}, isInThread: ${isInThread}, allowAnyChannel: ${this.options.allowAnyChannel}`
      );

      if (!isInCorrectChannel && !isInThread) {
        this.verbose(
          1,
          `Message ignored: not in configured channel (${this.options.channelID}) or its threads. Received from channel: ${message.channel.id}`
        );
        return;
      }
    } else {
      this.verbose(2, `Channel check bypassed - allowAnyChannel is enabled`);
    }

    this.verbose(
      2,
      `Channel check passed - processing message in ${
        message.channel.isThread ? 'thread' : 'channel'
      }: ${message.channel.name || message.channel.id}`
    );

    // check if the message is the activate command
    if (!message.content.toLowerCase().startsWith('!activate')) {
      this.verbose(3, `Message ignored: not an activate command. Content: "${message.content}"`);
      return;
    }

    this.verbose(
      1,
      `Activate command detected from ${message.author.username} in ${
        message.channel.isThread ? 'thread' : 'channel'
      }: ${message.channel.name || message.channel.id}`
    );

    // check permissions if any are specified
    if (this.options.permissions.length > 0) {
      const memberRoleIDs = [...message.member.roles.cache.keys()];
      this.verbose(
        2,
        `Checking permissions - Required: [${this.options.permissions.join(
          ', '
        )}] | User: [${memberRoleIDs.join(', ')}]`
      );

      const hasPermission = this.options.permissions.some((roleId) =>
        message.member.roles.cache.has(roleId)
      );

      this.verbose(2, `Permission check result: ${hasPermission}`);

      if (!hasPermission) {
        this.verbose(
          1,
          `Permission denied for ${
            message.author.username
          }. Required roles: [${this.options.permissions.join(
            ', '
          )}], User roles: [${memberRoleIDs.join(', ')}]`
        );
        await message.reply('You do not have permission to activate whitelist changes.');
        return;
      }

      this.verbose(1, `Permission granted for ${message.author.username}`);
    } else {
      this.verbose(2, `No permission restrictions configured - allowing all users`);
    }

    try {
      this.verbose(1, `Executing AdminReloadServerConfig...`);
      // execute the reload command
      const response = await this.server.rcon.execute('AdminReloadServerConfig');
      this.verbose(1, `AdminReloadServerConfig completed successfully`);
      this.verbose(2, `RCON response: ${response}`);

      // Create donation/whitelist friendly embed
      const embed = {
        title: '🎉 Priority Queue Activated!',
        description:
          'Your whitelist access has been successfully activated and is now live on the server!',
        color: 0x00ff00,
        fields: [
          {
            name: '✅ Status',
            value: 'Server configuration reloaded successfully',
            inline: true
          },
          {
            name: "🚀 What's Next?",
            value: 'You can now join the server and skip the queue!',
            inline: true
          }
        ],
        footer: {
          text: 'Thank you for your support! 💖'
        },
        timestamp: new Date().toISOString()
      };

      if (this.options.embedImageURL) embed.image = { url: this.options.embedImageURL };

      await message.reply({ embeds: [embed] });
    } catch (error) {
      this.verbose(1, `AdminReloadServerConfig failed: ${error.message}`);
      this.verbose(2, `Error stack: ${error.stack}`);
      await message.reply(`❌ Failed to activate whitelist changes: ${error.message}`);
    }
  }
}
