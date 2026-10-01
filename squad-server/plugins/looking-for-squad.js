import BasePlugin from './base-plugin.js';

export default class LookingForSquad extends BasePlugin {
  static get description() {
    return 'The <code>LookingForSquad</code> plugin allows players to request invites to locked squads via chat commands. Supports targeting specific squads or players, with spam protection and detailed validation.';
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      commands: {
        required: false,
        description: 'Commands that trigger the invite system.',
        default: ['!inv', '!invite', '!lfs']
      },
      cooldownSeconds: {
        required: false,
        description:
          'Number of seconds that must pass before the same user can send another invite request.',
        default: 10
      },
      maxSquadSize: {
        required: false,
        description: 'Maximum squad size (squads at this size are considered full).',
        default: 9
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.onChatMessage = this.onChatMessage.bind(this);
    this.warn = (steamid, msg) => this.server.rcon.warn(steamid, msg);
    this.lastUsed = new Map(); // Store last used time for rate limiting
  }

  async mount() {
    this.verbose(1, 'Mounted.');
    this.server.on('CHAT_MESSAGE', this.onChatMessage);
    this.server.on('NEW_GAME', this.onNewGame.bind(this));
  }

  async unmount() {
    this.server.removeEventListener('CHAT_MESSAGE', this.onChatMessage);
  }

  // Clean up cooldowns on new round
  async onNewGame() {
    this.lastUsed.clear();
    this.verbose(1, 'Cleared invite request cooldowns for new game.');
  }

  // Handle general invite request (!inv or !invite or !lfs)
  async handleGeneralInvite(event) {
    const { steamID } = event;

    // Check for cooldown before processing any invite commands
    if (this.shouldRateLimit(steamID)) {
      const remaining = this.getCooldownRemaining(steamID);
      this.warn(steamID, `Please wait ${remaining} seconds before sending another invite request.`);
      return;
    }

    try {
      const player = await this.getPlayer(steamID);
      if (!player) {
        this.warn(steamID, 'Could not find your player information. Please try again.');
        return;
      }

      // Check if player is already in a squad
      if (player.squadID !== null && player.squadID > 0) {
        this.warn(
          steamID,
          'You are already in a squad. Leave your current squad before requesting invites.'
        );
        return;
      }

      const eligibleLeaders = await this.getEligibleSquadLeaders(player.teamID);

      if (eligibleLeaders.length === 0) {
        this.warn(steamID, 'No locked squads with available slots found on your team.');
        return;
      }

      // Send requests to all eligible leaders
      let successfulRequests = 0;
      for (const item of eligibleLeaders) {
        if (await this.sendInviteRequest(item.leader, player, item.squad)) {
          successfulRequests++;
        }
      }

      if (successfulRequests > 0) {
        this.warn(
          steamID,
          `Invite request sent to ${successfulRequests} squad leader(s) with locked squads.`
        );
      } else {
        this.warn(steamID, 'No valid squads found to send invite requests to.');
      }
    } catch (error) {
      console.error('Error handling general invite:', error);
      this.warn(steamID, 'An error occurred. Please try again later.');
    }
  }

  // Handle squad-specific invite request (!inv 8)
  async handleSquadSpecificInvite(event, squadNumber) {
    const { steamID } = event;

    // Check for cooldown before processing any invite commands
    if (this.shouldRateLimit(steamID)) {
      const remaining = this.getCooldownRemaining(steamID);
      this.warn(steamID, `Please wait ${remaining} seconds before sending another invite request.`);
      return false;
    }

    try {
      const player = await this.getPlayer(steamID);
      if (!player) {
        this.warn(steamID, 'Could not find your player information. Please try again.');
        return false;
      }

      // Check if player is already in a squad
      if (player.squadID !== null && player.squadID > 0) {
        this.warn(
          steamID,
          'You are already in a squad. Leave your current squad before requesting invites.'
        );
        return false;
      }

      const squad = await this.findSquadById(squadNumber, player.teamID);
      if (!squad) {
        this.warn(steamID, `Squad ${squadNumber} does not exist on your team.`);
        return false;
      }

      const squadLeader = await this.getSquadLeader(squad);
      if (!squadLeader) {
        this.warn(steamID, `Squad ${squadNumber} does not have a leader.`);
        return false;
      }

      // Check if squad is locked
      if (squad.locked !== 'True') {
        this.warn(
          steamID,
          `Squad ${squad.squadID} (${
            squad.squadName || 'Unnamed'
          }) is not locked. You can join directly without an invite.`
        );
        return false;
      }

      // Check if squad is full
      if (squad.size >= this.options.maxSquadSize) {
        this.warn(
          steamID,
          `Squad ${squad.squadID} (${squad.squadName || 'Unnamed'}) is full (${squad.size}/${
            this.options.maxSquadSize
          } players). Invite request sent anyway in case someone leaves.`
        );
      } else {
        this.warn(
          steamID,
          `Invite request sent to Squad ${squad.squadID} (${squad.squadName || 'Unnamed'}) leader.`
        );
      }

      return await this.sendInviteRequest(squadLeader, player, squad);
    } catch (error) {
      console.error('Error handling squad-specific invite:', error);
      this.warn(steamID, 'An error occurred. Please try again later.');
      return false;
    }
  }

  // Handle player-specific invite request (!inv Player Name)
  async handlePlayerSpecificInvite(event, playerName) {
    const { steamID } = event;

    // Check for cooldown before processing any invite commands
    if (this.shouldRateLimit(steamID)) {
      const remaining = this.getCooldownRemaining(steamID);
      this.warn(steamID, `Please wait ${remaining} seconds before sending another invite request.`);
      return;
    }

    try {
      const player = await this.getPlayer(steamID);
      if (!player) {
        this.warn(steamID, 'Could not find your player information. Please try again.');
        return;
      }

      // Check if player is already in a squad
      if (player.squadID !== null && player.squadID > 0) {
        this.warn(
          steamID,
          'You are already in a squad. Leave your current squad before requesting invites.'
        );
        return;
      }

      // Strip whitespace and find target player using fuzzy matching
      const normalizedName = playerName.replace(/\s+/g, '');
      const targetPlayer = await this.matchPlayerName(normalizedName, player);
      if (!targetPlayer) {
        return; // matchPlayerName already handles error messaging
      }

      // Check if target is on same team
      if (targetPlayer.teamID !== player.teamID) {
        this.warn(steamID, `${targetPlayer.name} is on the opposing team.`);
        return;
      }

      // Check if target is a squad leader
      if (!targetPlayer.isLeader) {
        this.warn(steamID, `${targetPlayer.name} is not a squad leader.`);
        return;
      }

      const squad = await this.findSquadById(targetPlayer.squadID, targetPlayer.teamID);
      if (!squad) {
        this.warn(steamID, `${targetPlayer.name} is not in a squad.`);
        return;
      }

      // Check if squad is locked
      if (squad.locked !== 'True') {
        this.warn(
          steamID,
          `${targetPlayer.name}'s squad (${
            squad.squadName || 'Unnamed'
          }) is not locked. You can join directly without an invite.`
        );
        return;
      }

      // Check if squad is full
      if (squad.size >= this.options.maxSquadSize) {
        this.warn(
          steamID,
          `${targetPlayer.name}'s squad (${squad.squadName || 'Unnamed'}) is full (${squad.size}/${
            this.options.maxSquadSize
          } players). Invite request sent anyway in case someone leaves.`
        );
      } else {
        this.warn(
          steamID,
          `Invite request sent to ${targetPlayer.name} (Squad ${squad.squadID}: ${
            squad.squadName || 'Unnamed'
          }).`
        );
      }

      await this.sendInviteRequest(targetPlayer, player, squad);
    } catch (error) {
      console.error('Error handling player-specific invite:', error);
      this.warn(steamID, 'An error occurred. Please try again later.');
    }
  }

  async onChatMessage(event) {
    // Strip leading and trailing whitespace
    const strippedMessage = event.message.trim();

    // Check if this is an invite command
    const words = strippedMessage.toLowerCase().split(/\s+/);
    const command = words[0];

    if (!this.options.commands.includes(command)) {
      return;
    }

    // Get everything after the command as arguments
    const args = strippedMessage.slice(command.length).trim();

    // Handle different cases based on arguments
    if (args === '') {
      // General invite (!inv or !invite or !lfs with no arguments)
      await this.handleGeneralInvite(event);
    } else {
      // Check if args is a pure number (prioritize squad numbers for numeric input)
      const squadNumber = parseInt(args, 10);
      if (!isNaN(squadNumber) && /^\d+$/.test(args)) {
        // Squad-specific invite for pure numeric input
        const success = await this.handleSquadSpecificInvite(event, squadNumber);
        if (!success) {
          this.warn(
            event.steamID,
            'If you meant to invite a player with a numeric name, try adding letters.'
          );
        }
      } else {
        // Player-specific invite for non-numeric or mixed input
        await this.handlePlayerSpecificInvite(event, args);
      }
    }
  }

  shouldRateLimit(steamID) {
    const now = Date.now();
    const lastUsed = this.lastUsed.get(steamID) || 0;
    const timeSinceLastUsed = now - lastUsed;
    const shouldLimit = timeSinceLastUsed < this.options.cooldownSeconds * 1000;

    if (!shouldLimit) {
      this.lastUsed.set(steamID, now); // Update last used time
    }

    return shouldLimit;
  }

  getCooldownRemaining(steamID) {
    const now = Date.now();
    const lastUsed = this.lastUsed.get(steamID) || 0;
    const timeSinceLastUsed = now - lastUsed;
    return Math.max(0, Math.ceil((this.options.cooldownSeconds * 1000 - timeSinceLastUsed) / 1000));
  }

  async getPlayer(steamID) {
    const players = await this.server.rcon.getListPlayers();
    return players.find((player) => player.steamID === steamID);
  }

  // Helper function to find squad by ID on a specific team
  async findSquadById(squadId, teamId) {
    const squads = await this.server.rcon.getSquads();
    return squads.find((squad) => squad.squadID === squadId && squad.teamID === teamId);
  }

  // Helper function to get squad leader for a squad
  async getSquadLeader(squad) {
    const players = await this.server.rcon.getListPlayers();
    return players.find(
      (player) =>
        player.teamID === squad.teamID &&
        player.squadID === squad.squadID &&
        player.isLeader === true
    );
  }

  // Helper function to get all eligible squad leaders on a team
  async getEligibleSquadLeaders(teamId) {
    const players = await this.server.rcon.getListPlayers();
    const squads = await this.server.rcon.getSquads();
    const eligibleLeaders = [];

    // Create a map of squad_id to squad for the specified team
    const squadMap = {};
    for (const squad of squads) {
      if (squad.teamID === teamId) {
        squadMap[squad.squadID] = squad;
      }
    }

    // Find eligible leaders by checking players once
    for (const player of players) {
      if (player.teamID === teamId && player.isLeader === true && player.squadID) {
        const squad = squadMap[player.squadID];
        if (squad && squad.locked === 'True' && squad.size < this.options.maxSquadSize) {
          eligibleLeaders.push({
            leader: player,
            squad: squad
          });
        }
      }
    }

    return eligibleLeaders;
  }

  // Fuzzy player name matching
  async matchPlayerName(normalizedName, sender) {
    const players = await this.server.rcon.getListPlayers();

    // Try exact match first
    let matches = players.filter(
      (player) => player.name.replace(/\s+/g, '').toLowerCase() === normalizedName.toLowerCase()
    );

    if (matches.length === 1) {
      return matches[0];
    }

    if (matches.length > 1) {
      this.warn(
        sender.steamID,
        `Multiple players found with similar names. Please be more specific.`
      );
      return null;
    }

    // Try partial match
    matches = players.filter((player) =>
      player.name.replace(/\s+/g, '').toLowerCase().includes(normalizedName.toLowerCase())
    );

    if (matches.length === 1) {
      return matches[0];
    }

    if (matches.length > 1) {
      this.warn(
        sender.steamID,
        `Multiple players found matching "${normalizedName}". Please be more specific.`
      );
      return null;
    }

    this.warn(sender.steamID, `Player "${normalizedName}" not found.`);
    return null;
  }

  // Helper function to send invite request to squad leader
  async sendInviteRequest(squadLeader, requestingPlayer, squad) {
    try {
      const message = `[INVITE REQUEST] ${requestingPlayer.name} is requesting an invite.\nSquad: ${squad.size}/${this.options.maxSquadSize} players`;
      this.warn(squadLeader.steamID, message);
      return true;
    } catch (error) {
      console.error('Error sending invite request:', error);
      return false;
    }
  }
}
