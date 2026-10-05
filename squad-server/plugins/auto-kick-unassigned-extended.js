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
      }
    };
  }

  async updateTrackingList() {
    if (this.options.onlyKickIfQueue && this.server.publicQueue === 0) {
      this.verbose(3, 'Update Tracking List? false (public queue is empty)');
      for (const eosID of Object.keys(this.trackedPlayers)) this.untrackPlayer(eosID);
      return;
    }
    return super.updateTrackingList();
  }
}
