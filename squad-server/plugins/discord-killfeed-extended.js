import DiscordKillFeed from './discord-killfeed.js';

const BATTLEMETRICS_PLAYER_SEARCH_URL = 'https://www.battlemetrics.com/rcon/players';

export default class DiscordKillFeedExtended extends DiscordKillFeed {
  static get description() {
    return (
      'The <code>DiscordKillFeedExtended</code> plugin posts wounds and kills to a Discord channel as ' +
      'one-line messages with Steam and BattleMetrics links, after a delay. It marks same-team hits ' +
      'and helicopter crashes, and can ping a role when a helicopter crashes.'
    );
  }

  static get optionsSpecification() {
    // The messages are plain text, so the embed color and CBL options of DiscordKillFeed do not apply.
    // eslint-disable-next-line no-unused-vars
    const { color, disableCBL, ...inheritedOptions } = super.optionsSpecification;
    return {
      ...inheritedOptions,
      messageDelay: {
        required: false,
        description: 'Delay in milliseconds before each kill feed message is sent.',
        default: 60000
      },
      helis: {
        required: false,
        description:
          'Helicopter weapon IDs. A wound or kill by one of these where the attacker is the victim is reported as a crash.',
        default: [
          'BP_MI8_VDV',
          'BP_UH1Y',
          'BP_UH60',
          'BP_UH1H_Desert',
          'BP_UH1H',
          'BP_CH178',
          'BP_MI8',
          'BP_CH146',
          'BP_MI17_MEA',
          'BP_Z8G',
          'BP_CH146_Desert',
          'BP_SA330',
          'BP_UH60_AUS',
          'BP_MRH90_Mag58',
          'BP_Z8J'
        ],
        example: ['BP_MI8_VDV']
      },
      heliCrashRoleID: {
        required: false,
        description:
          'Discord role ID to ping when a helicopter crash is reported. Leave empty for no ping.',
        default: '',
        example: '667741905228136459'
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.onDeath = this.onDeath.bind(this);
    this.pendingMessages = new Set();
  }

  async mount() {
    await super.mount();
    this.server.on('PLAYER_DIED', this.onDeath);
  }

  async unmount() {
    // DiscordKillFeed.unmount calls removeEventListener, which EventEmitter does not provide.
    this.server.removeListener('PLAYER_WOUNDED', this.onWound);
    this.server.removeListener('PLAYER_DIED', this.onDeath);
    for (const pendingMessage of this.pendingMessages) clearTimeout(pendingMessage);
    this.pendingMessages.clear();
  }

  async onWound(info) {
    this.queueMessage('wound', info);
  }

  async onDeath(info) {
    // A death by a soldier blueprint is a downed player giving up, which is not a kill.
    if (info.weapon?.startsWith('BP_Soldier')) return;
    this.queueMessage('die', info);
  }

  queueMessage(eventType, info) {
    const content = this.formatMessage(eventType, info);
    const pendingMessage = setTimeout(async () => {
      this.pendingMessages.delete(pendingMessage);
      try {
        await this.sendDiscordMessage({ content });
      } catch (error) {
        this.verbose(1, `Failed to send kill feed message: ${error.message}`);
      }
    }, this.options.messageDelay);
    this.pendingMessages.add(pendingMessage);
  }

  formatMessage(eventType, info) {
    const { attacker, victim, weapon } = info;
    const action = eventType === 'die' ? 'killed' : 'wounded';
    const weaponLabel = weapon ? `\`${weapon}\`` : '`Unknown`';
    const time = `<t:${Math.round(info.time.valueOf() / 1000)}:T>`;

    const bothKnown = Boolean(attacker && victim);
    const isHeliCrash =
      bothKnown && this.options.helis.includes(weapon) && attacker.eosID === victim.eosID;
    const rolePing = this.options.heliCrashRoleID ? ` ||<@&${this.options.heliCrashRoleID}>||` : '';

    const markers = [
      isHeliCrash ? ` 🚁💥${rolePing}` : '',
      eventType === 'wound' && weapon?.startsWith('BP_Soldier') ? ' 🪖' : '',
      bothKnown && attacker.teamID === victim.teamID ? ' 🟰' : ''
    ].join('');

    return `${this.formatPlayer(attacker)} ${action} ${this.formatPlayer(
      victim
    )} using ${weaponLabel} at ${time}${markers}`;
  }

  formatPlayer(player) {
    if (!player) return '`Unknown`';
    const profileUrl = `https://steamcommunity.com/profiles/${player.steamID}`;
    const battlemetricsUrl = `${BATTLEMETRICS_PLAYER_SEARCH_URL}?filter[search]=${player.steamID}&method=quick&redirect=1`;
    return `[\`${player.name}\`](<${profileUrl}>) [\`${player.teamID}\`][[\`BM\`](<${battlemetricsUrl}>)]`;
  }
}
