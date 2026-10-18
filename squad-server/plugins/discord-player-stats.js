import {
  ApplicationCommandOptionType,
  AttachmentBuilder,
  escapeMarkdown,
  MessageFlags
} from 'discord.js';

import DiscordBasePlugin from './discord-base-plugin.js';
import LinkResolver from './discord-player-stats/link-resolver.js';
import {
  fetchFirstMatchTime,
  fetchLeaderboard,
  fetchPlayerStats,
  rankPlayer
} from './discord-player-stats/stats-query.js';

// Discord's error code when the bot was invited without the applications.commands scope.
const MISSING_ACCESS = 50001;
const FIRST_LEADERBOARD_DELAY_MS = 60 * 1000;
// Bounds for the refresh intervals: each rankings rebuild scans the event tables, and timers run delays
// above 2^31 - 1 ms at once.
const MINIMUM_REFRESH_MS = 10 * 60 * 1000;
const MAXIMUM_REFRESH_MS = 2147483647;

function boundedInterval(milliseconds) {
  return Math.min(MAXIMUM_REFRESH_MS, Math.max(MINIMUM_REFRESH_MS, Number(milliseconds) || 0));
}

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
        description:
          'Look up the account link on MySquadStats when the Whitelister has none. Needs ' +
          '<code>mySquadStatsAccessToken</code>.',
        default: true
      },
      mySquadStatsAccessToken: {
        required: false,
        description:
          'MySquadStats access token, the same one the <code>MySquadStats</code> plugin uses. Leave empty to ' +
          'skip the MySquadStats lookup.',
        default: ''
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
        description: 'Milliseconds between two rebuilds of the rankings, at least 10 minutes.',
        default: 6 * 60 * 60 * 1000
      },
      backgroundChannelID: {
        required: false,
        description:
          'ID of a forum or media channel whose posts give the card a random background photo. Leave empty ' +
          'for the plain background.',
        default: '',
        example: '667741905228136459'
      },
      backgroundTagID: {
        required: false,
        description:
          'ID of the tag that approves a post in the background channel. Only tagged posts are used, so make ' +
          'the tag moderated: then only members who can manage threads can set it.',
        default: ''
      },
      backgroundMaxFileSize: {
        required: false,
        description:
          'Largest photo in bytes that is used as a background. PNG, JPEG and GIF are supported.',
        default: 10 * 1024 * 1024
      },
      backgroundRefreshInterval: {
        required: false,
        description:
          'Milliseconds between two reads of the background channel, at least 10 minutes. New, ' +
          'changed and deleted posts are also picked up within seconds when the bot sees the change.',
        default: 60 * 60 * 1000
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.linkResolver = new LinkResolver({
      whitelisterApiUrl: this.options.whitelisterApiUrl,
      whitelisterApiKey: this.options.whitelisterApiKey,
      useMySquadStats: this.options.useMySquadStats,
      mySquadStatsAccessToken: this.options.mySquadStatsAccessToken,
      log: (message) => this.verbose(1, message)
    });
    this.leaderboard = null;
    this.statsSince = null;
    this.leaderboardTimeout = null;
    this.leaderboardBuild = null;
    this.leaderboardAttempted = false;
    this.renderCard = null;
    this.backgrounds = null;
    this.mounted = false;
    this.onInteraction = this.onInteraction.bind(this);
    this.refreshLeaderboard = this.refreshLeaderboard.bind(this);
  }

  // No channel to fetch: the plugin only answers commands.
  async prepareToMount() {}

  async mount() {
    // Loaded here so the native canvas module is only needed when this plugin is enabled.
    ({ renderCard: this.renderCard } = await import('./discord-player-stats/card.js'));
    this.mounted = true;
    this.options.discordClient.on('interactionCreate', this.onInteraction);
    await this.registerCommand();
    this.leaderboardTimeout = setTimeout(this.refreshLeaderboard, FIRST_LEADERBOARD_DELAY_MS);
    if (this.options.backgroundChannelID) await this.mountBackgrounds();
  }

  async mountBackgrounds() {
    if (!this.options.backgroundTagID) {
      this.verbose(1, 'Backgrounds are off: backgroundChannelID is set without a backgroundTagID.');
      return;
    }
    const { default: BackgroundLibrary } = await import('./discord-player-stats/backgrounds.js');
    this.backgrounds = new BackgroundLibrary({
      client: this.options.discordClient,
      channelID: this.options.backgroundChannelID,
      tagID: this.options.backgroundTagID,
      maxBytes: this.options.backgroundMaxFileSize,
      refreshInterval: boundedInterval(this.options.backgroundRefreshInterval),
      log: (message) => this.verbose(1, message)
    });
    this.backgrounds.start();
  }

  async unmount() {
    this.mounted = false;
    this.options.discordClient.removeListener('interactionCreate', this.onInteraction);
    clearTimeout(this.leaderboardTimeout);
    this.backgrounds?.stop();
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

  // Rebuilds now and schedules the next rebuild one interval later, replacing any pending one.
  async refreshLeaderboard() {
    await this.rebuildLeaderboard();

    clearTimeout(this.leaderboardTimeout);
    if (this.mounted)
      this.leaderboardTimeout = setTimeout(
        this.refreshLeaderboard,
        boundedInterval(this.options.leaderboardRefreshInterval)
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
    this.leaderboardAttempted = true;
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

      // Before the first scheduled build (shortly after startup), build the rankings now. A failed build
      // is left to the timer, so commands do not repeat the scans while the database struggles.
      if (!this.leaderboardAttempted) await this.refreshLeaderboard();
      else if (this.leaderboardBuild) await this.leaderboardBuild;
      const stats = await fetchPlayerStats(this.options.database, link.steamID);
      const background = await this.backgrounds?.pick();
      const card = this.renderCard(stats, {
        title: this.options.cardTitle,
        since: this.statsSince ? formatDate(this.statsSince) : 'the first recorded match',
        ranks: rankPlayer(this.leaderboard, stats, this.options.leaderboardMinimumDeaths),
        rankedPlayers: this.leaderboard?.size,
        unrankedNote: this.unrankedNote(stats),
        background
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
