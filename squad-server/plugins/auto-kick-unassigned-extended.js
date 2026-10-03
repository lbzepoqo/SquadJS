import AutoKickUnassigned from './auto-kick-unassigned.js';

export default class AutoKickUnassignedExtended extends AutoKickUnassigned {
  static get description() {
    return (
      'The <code>AutoKickUnassignedExtended</code> plugin works like <code>AutoKickUnassigned</code> and can ' +
      'limit warnings and kicks to times when the public queue has players.'
    );
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      ...super.optionsSpecification,
      onlyKickIfQueue: {
        required: false,
        description:
          '<ul>' +
          "<li><code>true</code>: Only warn and kick unassigned players if there's a public queue</li>" +
          '<li><code>false</code>: Always warn and kick unassigned players</li>' +
          '</ul>',
        default: false
      },
      finalWarnings: {
        required: false,
        description:
          'Extra warnings in the last seconds before the kick, as a list of seconds before the kick, ' +
          'for example <code>[15, 10, 5]</code>. They are sent in addition to the regular warnings.',
        default: [],
        example: [15, 10, 5]
      }
    };
  }

  trackPlayer(info) {
    const tracker = super.trackPlayer(info);

    tracker.finalWarningTimerIDs = [];
    for (const secondsLeft of this.options.finalWarnings) {
      const msLeft = secondsLeft * 1000;
      if (msLeft <= 0 || msLeft >= this.kickTimeout) continue;

      // Regular warnings are sent every warningInterval after tracking starts; skip those times.
      const msAfterStart = this.kickTimeout - msLeft;
      if (msAfterStart % this.warningInterval === 0) continue;

      const timerID = setTimeout(() => {
        const timeLeft = this.msFormat(msLeft);
        this.server.rcon.warn(tracker.player.eosID, `${this.options.warningMessage} - ${timeLeft}`);
        this.verbose(2, `Final warning: ${tracker.player.name} (${timeLeft})`);
      }, msAfterStart);
      tracker.finalWarningTimerIDs.push(timerID);
    }

    return tracker;
  }

  untrackPlayer(eosID) {
    const tracker = this.trackedPlayers[eosID];
    if (tracker) for (const timerID of tracker.finalWarningTimerIDs || []) clearTimeout(timerID);
    super.untrackPlayer(eosID);
  }

  async updateTrackingList(forceUpdate = false) {
    if (this.options.onlyKickIfQueue && this.server.publicQueue === 0) {
      this.verbose(3, 'Update Tracking List? false (public queue is empty)');
      for (const eosID of Object.keys(this.trackedPlayers)) this.untrackPlayer(eosID);
      return;
    }
    return super.updateTrackingList(forceUpdate);
  }

  async clearDisconnectedPlayers() {
    // AutoKickUnassigned uses `in` on an array of EOS IDs, which tests indexes, so it untracks every player.
    const onlineEosIDs = new Set(this.server.players.map((player) => player.eosID));
    for (const eosID of Object.keys(this.trackedPlayers)) {
      if (!onlineEosIDs.has(eosID)) this.untrackPlayer(eosID);
    }
  }
}
