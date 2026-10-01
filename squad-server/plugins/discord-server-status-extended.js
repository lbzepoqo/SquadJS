import DiscordServerStatus from './discord-server-status.js';

export default class DiscordServerStatusExtended extends DiscordServerStatus {
  static get description() {
    return (
      'The <code>DiscordServerStatusExtended</code> plugin works like <code>DiscordServerStatus</code>. When ' +
      'the current layer is unknown, the bot status uses the layer that RCON reports.'
    );
  }

  async updateStatus() {
    if (!this.options.setBotStatus) return;

    let players = this.server.a2sPlayerCount;
    if (this.server.publicQueue || this.server.reserveQueue)
      players += `+${this.server.publicQueue + this.server.reserveQueue}`;

    let slots = this.server.publicSlots;
    if (this.server.reserveSlots) slots += `+${this.server.reserveSlots}`;

    await this.options.discordClient.user.setActivity(
      `(${players}/${slots}) ${await this.getLayerName()}`,
      { type: 4 }
    );
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
