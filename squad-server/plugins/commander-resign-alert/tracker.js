// Squad has no commander role in RCON or in the game log. The commander is the leader of the squad that the game
// renames to "Command Squad" when its leader takes command. When the commander resigns, the game gives the squad
// its default name ("Squad <ID>") again. When the squad disappears (disband, map change), there is no resign.
export default class CommanderTracker {
  constructor(commandSquadName) {
    this.commandSquadName = commandSquadName;
    this.terms = new Map();
    this.initialized = false;
  }

  // Squad IDs are per team, and the game reuses the ID of a disbanded squad, so the creator is part of the key.
  static squadKey(squad) {
    return `${squad.teamID}:${squad.squadID}:${squad.creatorEOSID}`;
  }

  // squads and players are the parsed results of ListSquads and ListPlayers taken at the same time.
  // Returns the resigns found in this update: { commander, squad, startTime, endTime, heldMs }.
  update(squads, players, now) {
    const resigns = [];
    const currentSquads = new Map(squads.map((squad) => [CommanderTracker.squadKey(squad), squad]));

    for (const [key, term] of this.terms) {
      const squad = currentSquads.get(key);
      if (!squad) {
        this.terms.delete(key);
        continue;
      }
      if (squad.squadName === this.commandSquadName) continue;

      this.terms.delete(key);
      // A term that was already running when the plugin started has no known start.
      if (term.startTime === null) continue;
      // A commander who left the server did not resign, and a disconnect does not start the cooldown.
      const stillConnected = players.some((player) => player.eosID === term.commander.eosID);
      if (!stillConnected) continue;

      resigns.push({
        commander: term.commander,
        squad,
        startTime: term.startTime,
        endTime: now,
        heldMs: now - term.startTime
      });
    }

    for (const [key, squad] of currentSquads) {
      if (squad.squadName !== this.commandSquadName || this.terms.has(key)) continue;
      const leader = players.find(
        (player) =>
          player.teamID === squad.teamID && player.squadID === squad.squadID && player.isLeader
      );
      const commander = leader
        ? { name: leader.name.trim(), eosID: leader.eosID, steamID: leader.steamID }
        : {
            name: squad.creatorName.trim(),
            eosID: squad.creatorEOSID,
            steamID: squad.creatorSteamID
          };
      this.terms.set(key, { commander, startTime: this.initialized ? now : null });
    }

    this.initialized = true;
    return resigns;
  }
}
