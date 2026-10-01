import DiscordTeamkill from './discord-teamkill.js';

export default class DiscordTeamkillExtended extends DiscordTeamkill {
  static get description() {
    return (
      'The <code>DiscordTeamkillExtended</code> plugin posts teamkills to a Discord channel as one-line ' +
      'messages with Steam profile links.'
    );
  }

  static get optionsSpecification() {
    // The messages are plain text, so the embed color and CBL options of DiscordTeamkill do not apply.
    // eslint-disable-next-line no-unused-vars
    const { color, disableCBL, ...inheritedOptions } = super.optionsSpecification;
    return inheritedOptions;
  }

  async unmount() {
    // DiscordTeamkill.unmount calls removeEventListener, which EventEmitter does not provide.
    this.server.removeListener('TEAMKILL', this.onTeamkill);
  }

  async onTeamkill(info) {
    if (!info.attacker) return;

    const weapon = info.weapon ? `\`${info.weapon}\`` : 'Unknown';
    await this.sendDiscordMessage({
      content: `${this.formatPlayer(info.attacker)} killed ${this.formatPlayer(
        info.victim
      )} using ${weapon} at <t:${Math.round(info.time.valueOf() / 1000)}:T>`
    });
  }

  formatPlayer(player) {
    if (!player) return 'Unknown';
    return `[\`${player.name}\`](<https://steamcommunity.com/profiles/${player.steamID}>)`;
  }
}
