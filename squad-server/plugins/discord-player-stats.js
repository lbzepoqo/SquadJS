import {
  ApplicationCommandOptionType,
  AttachmentBuilder,
  escapeMarkdown,
  MessageFlags
} from 'discord.js';

import DiscordBasePlugin from './discord-base-plugin.js';
import LinkResolver from './discord-player-stats/link-resolver.js';
import { renderCard } from './discord-player-stats/card.js';
import {
  fetchFirstMatchTime,
  fetchLeaderboard,
  fetchPlayerStats,
  rankPlayer
} from './discord-player-stats/stats-query.js';

// Discord's error code when the bot was invited without the applications.commands scope.
const MISSING_ACCESS = 50001;
const FIRST_LEADERBOARD_DELAY_MS = 60 * 1000;

export default class DiscordPlayerStats extends DiscordBasePlugin {
  static get description() {
    return (
      'The <code>DiscordPlayerStats</code> plugin adds a Discord slash command that answers with an image ' +
      "card of a player's kills, deaths, revives and rankings on this server, read from the " +
      '<code>DBLog</code> database. The Discord account is matched to the game account through the Squad ' +
      'Whitelister and then MySquadStats. Requires <code>DBLog</code> and a bot invited with the ' +
      '<code>applications.commands</code> scope.'
    );
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      ...DiscordBasePlugin.optionsSpecification,
      database: {
        required: true,
        connector: 'sequelize',
        description: 'The Sequelize connector that DBLog writes to.',
        default: 'mysql'
      },
      guildID: {
        required: true,
        description: 'ID of the Discord server where the command is registered.',
        default: '',
        example: '667741905228136459'
      },
      commandName: {
        required: false,
        description: 'Name of the slash command.',
        default: 'stats'
      },
      cardTitle: {
        required: false,
        description: 'Title at the top of the card, for example the server name.',
        default: 'Player stats'
      },
      whitelisterApiUrl: {
        required: false,
        description:
          'Base URL of the Squad Whitelister. Leave empty to skip the Whitelister lookup.',
        default: ''
      },
      whitelisterApiKey: {
        required: false,
        description: 'Whitelister API key with read access to players.',
        default: ''
      },
      useMySquadStats: {
        required: false,
        description: 'Look up the account link on MySquadStats when the Whitelister has none.',
        default: true
      },
      linkUrl: {
        required: false,
        description:
          'Page where players link their game account, shown when no linked account is found.',
        default: 'https://mysquadstats.com/link'
      },
      leaderboardMinimumDeaths: {
        required: false,
        description:
          'Players with fewer deaths are not ranked, so short visits do not count in "Top X%".',
        default: 20
      },
      leaderboardRefreshInterval: {
        required: false,
        description: 'Milliseconds between two rebuilds of the rankings.',
        default: 6 * 60 * 60 * 1000
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.linkResolver = new LinkResolver({
      whitelisterApiUrl: this.options.whitelisterApiUrl,
      whitelisterApiKey: this.options.whitelisterApiKey,
      useMySquadStats: this.options.useMySquadStats,
      log: (message) => this.verbose(1, message)
    });
    this.leaderboard = null;
    this.statsSince = null;
    this.leaderboardTimeout = null;
    this.leaderboardBuild = null;
    this.mounted = false;
    this.onInteraction = this.onInteraction.bind(this);
    this.refreshLeaderboard = this.refreshLeaderboard.bind(this);
  }

  // No channel to fetch: the plugin only answers commands.
  async prepareToMount() {}

  async mount() {
    this.mounted = true;
    this.options.discordClient.on('interactionCreate', this.onInteraction);
    await this.registerCommand();
    this.leaderboardTimeout = setTimeout(this.refreshLeaderboard, FIRST_LEADERBOARD_DELAY_MS);
  }

  async unmount() {
    this.mounted = false;
    this.options.discordClient.removeListener('interactionCreate', this.onInteraction);
    clearTimeout(this.leaderboardTimeout);
  }

  async registerCommand() {
    try {
      const guild = await this.options.discordClient.guilds.fetch(this.options.guildID);
      // Creating a command with an existing name replaces it, so this is safe on every start.
      await guild.commands.create({
        name: this.options.commandName,
        description: 'Show your stats on this server, or those of another member.',
        options: [
          {
            type: ApplicationCommandOptionType.User,
            name: 'member',
            description: 'Show the stats of this member instead.',
            required: false
          }
        ]
      });
      this.verbose(1, `Registered /${this.options.commandName} in guild ${this.options.guildID}.`);
    } catch (error) {
      const hint =
        error.code === MISSING_ACCESS
          ? ' Re-invite the bot with the applications.commands scope.'
          : '';
      this.verbose(1, `Could not register /${this.options.commandName}: ${error.message}.${hint}`);
    }
  }

  async refreshLeaderboard() {
    await this.rebuildLeaderboard();

    // setTimeout runs delays above 2^31 - 1 ms at once, so the interval is capped.
    if (this.mounted)
      this.leaderboardTimeout = setTimeout(
        this.refreshLeaderboard,
        Math.min(2147483647, this.options.leaderboardRefreshInterval)
      );
  }

  // Shared by the timer and by a command that arrives before the first build, so two builds never run at once.
  rebuildLeaderboard() {
    if (!this.leaderboardBuild)
      this.leaderboardBuild = this.buildLeaderboard().finally(() => {
        this.leaderboardBuild = null;
      });
    return this.leaderboardBuild;
  }

  async buildLeaderboard() {
    try {
      const started = Date.now();
      this.leaderboard = await fetchLeaderboard(
        this.options.database,
        this.options.leaderboardMinimumDeaths
      );
      this.statsSince = await fetchFirstMatchTime(this.options.database);
      this.verbose(
        1,
        `Rankings rebuilt: ${this.leaderboard.size} players in ${Date.now() - started} ms.`
      );
    } catch (error) {
      this.verbose(1, `Could not rebuild the rankings: ${error.message}`);
    }
  }

  // Why the card has no ranks, or undefined when it has them.
  unrankedNote(stats) {
    if (!this.leaderboard) return 'Rankings are not built yet';
    const missing = this.options.leaderboardMinimumDeaths - stats.deaths;
    if (missing > 0) return `${missing} more ${missing === 1 ? 'death' : 'deaths'} needed`;
  }

  async onInteraction(interaction) {
    if (
      !interaction.isChatInputCommand() ||
      interaction.commandName !== this.options.commandName ||
      interaction.guildId !== this.options.guildID
    )
      return;

    const member = interaction.options.getUser('member');
    const discordUser = member ?? interaction.user;
    const memberName =
      member &&
      escapeMarkdown(interaction.options.getMember('member')?.displayName ?? member.displayName);
    try {
      if (member?.bot) {
        await interaction.reply({
          content: `${memberName} is a bot and has no game account.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      // Discord needs a first answer within 3 seconds, and the account lookups can take longer.
      await interaction.deferReply();
      const link = await this.linkResolver.resolve(discordUser.id);
      if (!link) {
        // Angle brackets stop Discord from adding a link preview.
        const linkUrl = `<${this.options.linkUrl}>`;
        const reply = member
          ? `**${memberName}** has no linked game account yet. They can link it at ${linkUrl}.`
          : `Your Discord account has no linked game account yet. Link it at ${linkUrl}, then run /${this.options.commandName} again.`;
        // The deferred reply is public, so it is replaced by a message only the user sees.
        await interaction.deleteReply();
        await interaction.followUp({ content: reply, flags: MessageFlags.Ephemeral });
        return;
      }

      // Before the first scheduled build (shortly after startup), build the rankings now.
      if (!this.leaderboard) await this.rebuildLeaderboard();
      const stats = await fetchPlayerStats(this.options.database, link.steamID);
      const card = renderCard(stats, {
        title: this.options.cardTitle,
        since: this.statsSince ? formatDate(this.statsSince) : 'the first recorded match',
        ranks: rankPlayer(this.leaderboard, stats, this.options.leaderboardMinimumDeaths),
        rankedPlayers: this.leaderboard?.size,
        unrankedNote: this.unrankedNote(stats)
      });
      await interaction.editReply({
        files: [new AttachmentBuilder(card, { name: 'stats.png' })]
      });
    } catch (error) {
      this.verbose(1, `Could not answer /${this.options.commandName}: ${error.message}`);
      const reply = { content: 'Could not load the stats right now. Try again later.' };
      if (interaction.deferred) await interaction.editReply(reply).catch(() => {});
      else await interaction.reply({ ...reply, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}

function formatDate(date) {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  });
}
