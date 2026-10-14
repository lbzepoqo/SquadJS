import Sequelize from 'sequelize';
import tinygradient from 'tinygradient';

import { COPYRIGHT_MESSAGE } from '../utils/constants.js';

import BasePlugin from './base-plugin.js';
import StatusWebhook from './discord-webhook-server-status/status-webhook.js';

const { DataTypes } = Sequelize;

export default class DiscordWebhookServerStatus extends BasePlugin {
  static get description() {
    return (
      'The <code>DiscordWebhookServerStatus</code> plugin keeps a server status message up to date in a ' +
      'Discord channel through a webhook. The bot does not need to join that Discord server, and the ' +
      'webhook cannot send commands to SquadJS, so the channel can belong to another community. The ' +
      'plugin posts the message once and then edits it. If the message is deleted, the plugin posts a new one.'
    );
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      messageStore: {
        required: true,
        description: 'Sequelize connector name. Stores the ID of the status message.',
        connector: 'sequelize',
        default: 'sqlite'
      },
      webhookURL: {
        required: true,
        description:
          'URL of the Discord webhook. Add <code>?thread_id=...</code> to post in a thread. Treat the URL as ' +
          'a secret: anyone who has it can post in the channel.',
        default: '',
        example: 'https://discord.com/api/webhooks/123/abc'
      },
      updateInterval: {
        required: false,
        description: 'Milliseconds between two updates of the status message.',
        default: 60 * 1000
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    // A malformed URL disables this plugin only; the factory does not catch constructor errors,
    // so throwing here would stop SquadJS from starting.
    try {
      this.webhook = new StatusWebhook(this.options.webhookURL);
    } catch (error) {
      this.webhook = null;
      this.verbose(1, `Disabled: ${error.message}`);
    }
    this.StatusMessage = this.options.messageStore.define(
      `${this.constructor.name}_StatusMessage`,
      { server: DataTypes.INTEGER, webhookKey: DataTypes.STRING, messageID: DataTypes.STRING },
      { timestamps: false }
    );

    this.statusMessage = null;
    this.update = this.update.bind(this);
    this.updateTimeout = null;
    this.mounted = false;
  }

  async prepareToMount() {
    await this.StatusMessage.sync();
    if (!this.webhook) return;
    // The factory runs prepareToMount for one plugin at a time. findOrCreate uses a transaction,
    // and SQLite rejects a second transaction while another entry's transaction is open.
    [this.statusMessage] = await this.StatusMessage.findOrCreate({
      where: { server: this.server.id, webhookKey: this.webhook.storageKey }
    });
  }

  async mount() {
    if (!this.webhook) return;
    this.mounted = true;
    this.updateTimeout = setTimeout(this.update, 0);
  }

  async unmount() {
    this.mounted = false;
    clearTimeout(this.updateTimeout);
  }

  async update() {
    try {
      const payload = await this.generateMessage();
      const messageID = await this.webhook.publish(payload, this.statusMessage.messageID);
      if (messageID !== this.statusMessage.messageID) {
        this.verbose(1, `Posted a new status message (Message ID: ${messageID}).`);
        await this.statusMessage.update({ messageID });
      }
    } catch (error) {
      // The request config holds the webhook token, so only the message and Discord's
      // response body are logged.
      const details = error.response?.data ? ` ${JSON.stringify(error.response.data)}` : '';
      this.verbose(1, `Failed to update the status message: ${error.message}${details}`);
    }

    if (this.mounted) this.updateTimeout = setTimeout(this.update, this.options.updateInterval);
  }

  async generateMessage() {
    let players = `${this.server.a2sPlayerCount}`;
    if (this.server.publicQueue + this.server.reserveQueue > 0)
      players += ` (+${this.server.publicQueue + this.server.reserveQueue})`;

    players += ` / ${this.server.publicSlots}`;
    if (this.server.reserveSlots > 0) players += ` (+${this.server.reserveSlots})`;

    // Clamp the ratio between 0 and 1 to avoid tinygradient errors.
    const ratio = this.server.a2sPlayerCount / (this.server.publicSlots + this.server.reserveSlots);
    const clampedRatio = Math.min(1, Math.max(0, ratio)) || 0;
    const color = parseInt(
      tinygradient([
        { color: '#ff0000', pos: 0 },
        { color: '#ffff00', pos: 0.5 },
        { color: '#00ff00', pos: 1 }
      ])
        .rgbAt(clampedRatio)
        .toHex(),
      16
    );

    const nextLayerName =
      this.server.nextLayer?.name || (this.server.nextLayerToBeVoted ? 'To be voted' : 'Unknown');

    return {
      embeds: [
        {
          title: this.server.serverName,
          fields: [
            { name: 'Players', value: players },
            {
              name: 'Current Layer',
              value: `\`\`\`${await this.getLayerName()}\`\`\``,
              inline: true
            },
            { name: 'Next Layer', value: `\`\`\`${nextLayerName}\`\`\``, inline: true }
          ],
          color,
          footer: { text: COPYRIGHT_MESSAGE },
          timestamp: new Date().toISOString(),
          image: this.server.currentLayer
            ? {
                url: `https://raw.githubusercontent.com/Squad-Wiki/squad-wiki-pipeline-map-data/master/completed_output/_Current%20Version/images/${this.server.currentLayer.layerid}.jpg`
              }
            : undefined
        }
      ],
      allowed_mentions: { parse: [] }
    };
  }

  async getLayerName() {
    if (this.server.currentLayer?.name) return this.server.currentLayer.name;
    try {
      return (await this.server.rcon.getCurrentMap())?.layer || 'Unknown';
    } catch (error) {
      this.verbose(1, `Could not read the current map from RCON: ${error.message}`);
      return 'Unknown';
    }
  }
}
