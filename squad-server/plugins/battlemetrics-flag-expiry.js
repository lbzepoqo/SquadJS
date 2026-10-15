import Sequelize from 'sequelize';

import DiscordBasePlugin from './discord-base-plugin.js';
import BattleMetricsFlagClient from './battlemetrics-flag-expiry/flag-client.js';
import {
  activationKey,
  selectExpiredFlags,
  trackActivations
} from './battlemetrics-flag-expiry/expiry.js';

const { DataTypes } = Sequelize;

const REMOVAL_GAP_MS = 500;
const EMBED_DESCRIPTION_LIMIT = 4000;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const escapeMarkdown = (text) => String(text).replace(/[\\*_~`|[\]()<>]/g, '\\$&');

export default class BattleMetricsFlagExpiry extends DiscordBasePlugin {
  static get description() {
    return (
      'The <code>BattleMetricsFlagExpiry</code> plugin removes BattleMetrics player flags after a set number ' +
      'of days, for example flags that restrict a player from squad leader or pilot roles. It checks the flags ' +
      'on a timer through the BattleMetrics API, so players do not need to be online. Flags belong to the ' +
      'BattleMetrics organization, so a removal applies on every server of that organization.'
    );
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      ...DiscordBasePlugin.optionsSpecification,
      flagStore: {
        required: true,
        description:
          'Sequelize connector name. Stores since when each flag is active, because BattleMetrics keeps the ' +
          'first added time when a removed flag is added again.',
        connector: 'sequelize',
        default: 'sqlite'
      },
      channelID: {
        required: false,
        description:
          'The ID of the channel to report removed flags to. Leave empty to only log them. The Discord ' +
          'connector is required either way.',
        default: '',
        example: '667741905228136459'
      },
      battlemetricsToken: {
        required: true,
        description:
          'BattleMetrics API token that can read and remove player flags. Use a token with only the flag ' +
          'permissions.',
        default: ''
      },
      flagIDs: {
        required: true,
        description: 'IDs of the BattleMetrics player flags that expire.',
        default: [],
        example: ['01234567-89ab-cdef-0123-456789abcdef']
      },
      maxAgeDays: {
        required: false,
        description: 'A flag is removed once it has been on a player for this many days.',
        default: 10
      },
      checkInterval: {
        required: false,
        description: 'Milliseconds between two checks.',
        default: 60 * 60 * 1000
      },
      dryRun: {
        required: false,
        description:
          'Only log the flags that would be removed, without removing them or posting to Discord. ' +
          'The plugin still records since when each flag is active.',
        default: true
      },
      color: {
        required: false,
        description: 'The color of the embed.',
        default: 3447003
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.client = new BattleMetricsFlagClient(this.options.battlemetricsToken);
    this.FlagActivation = this.options.flagStore.define(
      `${this.constructor.name}_FlagActivation`,
      {
        playerID: { type: DataTypes.STRING, primaryKey: true },
        flagID: { type: DataTypes.STRING, primaryKey: true },
        activeSince: DataTypes.STRING,
        active: DataTypes.BOOLEAN
      },
      { timestamps: false }
    );
    this.dryRunListed = false;
    this.check = this.check.bind(this);
    this.checkTimeout = null;
    this.mounted = false;
  }

  async prepareToMount() {
    await this.FlagActivation.sync();
    if (this.options.channelID) await super.prepareToMount();
  }

  async mount() {
    this.mounted = true;
    this.checkTimeout = setTimeout(this.check, 0);
  }

  async unmount() {
    this.mounted = false;
    clearTimeout(this.checkTimeout);
  }

  async check() {
    try {
      await this.removeExpiredFlags();
    } catch (error) {
      // The request config holds the token, so only the message and the API response are logged.
      this.verbose(1, `Flag check failed: ${error.message}${this.responseDetails(error)}`);
    }

    // setTimeout runs delays above 2^31 - 1 ms at once, so the interval is capped.
    if (this.mounted)
      this.checkTimeout = setTimeout(this.check, Math.min(2147483647, this.options.checkInterval));
  }

  async removeExpiredFlags() {
    const entries = [];
    for (const flagID of this.options.flagIDs) {
      entries.push(...(await this.client.listActiveFlags(flagID)));
    }

    const previousActivations = await this.loadActivations();
    const { activations, activeEntries } = trackActivations(previousActivations, entries);
    await this.saveActivations(previousActivations, activations);

    const expired = selectExpiredFlags(activeEntries, this.options.maxAgeDays);
    if (expired.length === 0) return;

    // The names are only for the log and the report, so a failed lookup falls back to the flag IDs.
    let flagNames = {};
    try {
      flagNames = await this.client.getFlagNames();
    } catch (error) {
      this.verbose(
        1,
        `Could not read the flag names: ${error.message}${this.responseDetails(error)}`
      );
    }

    if (this.options.dryRun) {
      this.verbose(1, `Dry run: ${expired.length} flags would be removed.`);
      // The full list is logged once per start; later checks log the count only.
      if (!this.dryRunListed) {
        for (const entry of expired)
          this.verbose(1, `Dry run: would remove ${this.describe(entry, flagNames)}.`);
        this.dryRunListed = true;
      }
      return;
    }

    const removed = [];
    const failed = [];
    for (const entry of expired) {
      try {
        await this.client.removeFlag(entry.playerID, entry.flagID);
        removed.push(entry);
        this.verbose(1, `Removed ${this.describe(entry, flagNames)}.`);
      } catch (error) {
        failed.push(entry);
        this.verbose(
          1,
          `Could not remove ${this.describe(entry, flagNames)}: ${
            error.message
          }${this.responseDetails(error)}`
        );
        await sleep(REMOVAL_GAP_MS);
        continue;
      }

      // Marked inactive now, so a re-add before the next check counts as a new activation.
      try {
        await this.FlagActivation.update(
          { active: false },
          { where: { playerID: entry.playerID, flagID: entry.flagID } }
        );
      } catch (error) {
        this.verbose(
          1,
          `Could not record the removal of ${this.describe(entry, flagNames)}: ${error.message}`
        );
      }
      await sleep(REMOVAL_GAP_MS);
    }

    await this.report(
      `Removed ${removed.length} flags older than ${this.options.maxAgeDays} days`,
      removed,
      flagNames
    );
    await this.report(`Could not remove ${failed.length} flags`, failed, flagNames);
  }

  async loadActivations() {
    const rows = await this.FlagActivation.findAll();
    return new Map(
      rows.map((row) => [
        activationKey(row.playerID, row.flagID),
        {
          playerID: row.playerID,
          flagID: row.flagID,
          activeSince: row.activeSince,
          active: row.active
        }
      ])
    );
  }

  async saveActivations(previousActivations, activations) {
    for (const [key, activation] of activations) {
      const previous = previousActivations.get(key);
      if (
        previous?.active === activation.active &&
        previous?.activeSince === activation.activeSince
      )
        continue;
      await this.FlagActivation.upsert(activation);
    }
  }

  describe(entry, flagNames) {
    return `${flagNames[entry.flagID] ?? entry.flagID} from ${
      entry.playerName
    } (BattleMetrics player ${entry.playerID}, active since ${entry.activeSince})`;
  }

  responseDetails(error) {
    return error.response?.data ? ` ${JSON.stringify(error.response.data)}` : '';
  }

  // Posts the entries as embeds, splitting the list to stay under the embed description limit.
  async report(title, entries, flagNames) {
    if (!this.channel || entries.length === 0) return;

    const lines = entries.map(
      (entry) =>
        `[${escapeMarkdown(entry.playerName)}](https://www.battlemetrics.com/rcon/players/${
          entry.playerID
        }) · ${escapeMarkdown(
          flagNames[entry.flagID] ?? entry.flagID
        )} · since ${entry.activeSince.slice(0, 10)}`
    );

    const descriptions = [];
    let current = '';
    for (const line of lines) {
      if (current && current.length + line.length + 1 > EMBED_DESCRIPTION_LIMIT) {
        descriptions.push(current);
        current = '';
      }
      current = current ? `${current}\n${line}` : line;
    }
    descriptions.push(current);

    for (const [index, description] of descriptions.entries()) {
      const part = descriptions.length > 1 ? ` (${index + 1}/${descriptions.length})` : '';
      try {
        await this.sendDiscordMessage({
          embed: { title: `${title}${part}`, color: this.options.color, description }
        });
      } catch (error) {
        this.verbose(1, `Could not send the Discord report: ${error.message}`);
      }
    }
  }
}
