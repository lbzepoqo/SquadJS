import DiscordBasePlugin from './discord-base-plugin.js';

export default class SquadLeaderRoleValidator extends DiscordBasePlugin {
  static get description() {
    return 'Enforces proper Squad Leader roles and disbands squads that do not comply after warnings.';
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      ...DiscordBasePlugin.optionsSpecification,
      channelID: {
        required: true,
        description: 'The ID of the channel to log enforcement actions to.',
        default: '',
        example: '667741905228136459'
      },
      warningIntervalSeconds: {
        required: false,
        description: 'Interval between warnings for improper SL roles (in seconds).',
        default: 30
      },
      disbandTimeoutSeconds: {
        required: false,
        description: 'Time before disbanding a squad with improper SL role (in seconds).',
        default: 300 // 5 minutes
      },
      requiredRolePattern: {
        required: false,
        description: 'Regular expression pattern that valid SL roles must match.',
        default: 'SL',
        example: 'SL|SQUAD LEAD|LEADER'
      },
      enableAutoDisbanding: {
        required: false,
        description:
          'Whether to automatically disband squads that do not comply with role requirements.',
        default: true
      },
      notifyAdmins: {
        required: false,
        description: 'Whether to notify online admins when a squad is disbanded.',
        default: true
      },
      checkIntervalSeconds: {
        required: false,
        description: 'How often to check for squad leader roles (in seconds).',
        default: 10
      },
      exemptedLayers: {
        required: false,
        description:
          'Array of layer names that are exempted from SL role validation (e.g., seeding, training layers).',
        default: ['Jensen', 'Seed', 'Training'],
        example: ["Jensen's Range", 'Seed', 'Training']
      },
      playerThreshold: {
        required: false,
        description: 'Minimum number of players required for SL role validation to be active.',
        default: 30
      },
      ignoreAdmins: {
        required: false,
        description:
          'Whether to ignore admins from SL role validation. If true, admins will not be subject to SL role requirements.',
        default: false
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    // Admin permission for detecting admins
    this.adminPermission = 'canseeadminchat';

    // Bind methods
    this.checkSquads = this.checkSquads.bind(this);
    this.processSquad = this.processSquad.bind(this);
    this.handleSquadWarning = this.handleSquadWarning.bind(this);
    this.isValidSlRole = this.isValidSlRole.bind(this);
    this.isExemptedLayer = this.isExemptedLayer.bind(this);

    // Initialize state

    // Convert exemptedLayers to lowercase for case-insensitive comparison
    this.options.exemptedLayers = Array.isArray(this.options.exemptedLayers)
      ? this.options.exemptedLayers.map((layer) => layer.toLowerCase())
      : ['jensen', 'seed', 'training'];

    try {
      this.requiredRoleRegex = new RegExp(this.options.requiredRolePattern, 'i');
    } catch (error) {
      throw new Error(
        `${this.constructor.name}: Failed to compile requiredRolePattern "${this.options.requiredRolePattern}": ${error.message}`
      );
    }

    this.isChecking = false;
    this.squadTracking = new Map(); // Use Map for tracking (key: teamId_squadId, value: tracking data)
    this.checkInterval = null;
  }

  async mount() {
    this.verbose(1, 'Squad Leader Role Validator mounted.');
    // Start regular check interval
    this.checkInterval = setInterval(this.checkSquads, this.options.checkIntervalSeconds * 1000);
  }

  async unmount() {
    // Clean up interval on unmount
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.verbose(1, 'Squad Leader Role Validator unmounted.');
  }

  /**
   * Check if a role matches the required pattern for squad leaders
   * @param {string} role The role to check
   * @returns {boolean} Whether the role is valid for a squad leader
   */
  isValidSlRole(role) {
    if (!role) return false;

    return this.requiredRoleRegex.test(role);
  }

  /**
   * Format time remaining in a human-readable format (minutes and seconds)
   * @param {number} seconds Seconds remaining
   * @returns {string} Formatted time string
   */
  formatTimeRemaining(seconds) {
    if (seconds < 60) {
      return `${seconds} seconds`;
    } else if (seconds < 120) {
      return `1 minute and ${seconds % 60} seconds`;
    } else {
      return `${Math.floor(seconds / 60)} minutes and ${seconds % 60} seconds`;
    }
  }

  /**
   * Check if the current layer is exempted from SL role validation
   * @param {string} layerName The current layer name
   * @returns {boolean} Whether the layer is exempted
   */
  isExemptedLayer(layerName) {
    if (!layerName) return false;

    layerName = layerName.toLowerCase();
    return this.options.exemptedLayers.some((exemptedLayer) =>
      layerName.includes(exemptedLayer.toLowerCase())
    );
  }

  /**
   * Main function to check all squads on the server
   */
  async checkSquads() {
    if (this.isChecking) {
      this.verbose(2, 'Skipping SL role validation: previous run still in progress.');
      return;
    }

    this.isChecking = true;
    try {
      // Get current server state
      const players = await this.server.rcon.getListPlayers();
      const currentMap = await this.server.rcon.getCurrentMap();
      const squads = await this.server.rcon.getSquads();

      // Check if validation should be skipped
      const playerCount = players.length;
      const isExemptedLayer = this.isExemptedLayer(currentMap.layer);

      if (playerCount < this.options.playerThreshold) {
        this.verbose(
          1,
          `Skipping SL role validation: Player count (${playerCount}) is below threshold (${this.options.playerThreshold}).`
        );
        return;
      }

      if (isExemptedLayer) {
        this.verbose(
          1,
          `Skipping SL role validation: Current layer (${currentMap.layer}) is exempted.`
        );
        return;
      }

      // Get admin metadata for ignore/notification handling
      const adminEosIDs = this.server.getAdminsWithPermission(this.adminPermission, 'eosID');
      const adminPlayers = this.options.notifyAdmins
        ? this.server.getAdminsWithPermission(this.adminPermission, 'player')
        : [];

      const adminContext = {
        eosIDs: adminEosIDs,
        players: adminPlayers
      };

      // Current timestamp for tracking
      const nowTimestamp = Math.floor(Date.now() / 1000);

      // Process each squad
      for (const squad of squads) {
        await this.processSquad(squad, players, nowTimestamp, adminContext);
      }

      // Clean up tracking for squads that no longer exist
      const currentSquadKeys = squads.map((squad) => `${squad.teamID}_${squad.squadID}`);
      for (const [squadKey] of this.squadTracking) {
        if (!currentSquadKeys.includes(squadKey)) {
          this.squadTracking.delete(squadKey);
        }
      }
    } catch (error) {
      this.verbose(1, `Error checking squads: ${error.message}`);
      this.verbose(2, error.stack);
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Process a single squad to check if its leader has a valid role
   * @param {Object} squad The squad object
   * @param {Array} players List of all players
   * @param {number} nowTimestamp Current timestamp
   * @param {Object} adminContext Admin metadata (eosIDs array and online player objects)
   */
  async processSquad(squad, players, nowTimestamp, adminContext) {
    const squadKey = `${squad.teamID}_${squad.squadID}`;

    // Find the squad leader
    const squadLeader = players.find(
      (player) =>
        player.teamID === squad.teamID && player.squadID === squad.squadID && player.isLeader
    );

    // Check if squad leader is an admin and should be ignored
    if (
      squadLeader &&
      this.options.ignoreAdmins &&
      adminContext.eosIDs.includes(squadLeader.eosID)
    ) {
      // Admin squad leader, remove from tracking if previously tracked
      if (this.squadTracking.has(squadKey)) {
        this.squadTracking.delete(squadKey);
        this.verbose(
          1,
          `Squad ${squad.squadName} (ID: ${squad.squadID}) on team ${squad.teamID} leader is an admin - ignoring SL role validation.`
        );
      }
      return;
    }

    // Check if we need to track this squad
    const hasValidRole = squadLeader && this.isValidSlRole(squadLeader.role);

    if (hasValidRole) {
      // SL has correct role, remove from tracking if previously tracked
      if (this.squadTracking.has(squadKey)) {
        this.squadTracking.delete(squadKey);
        this.verbose(
          1,
          `Squad ${squad.squadName} (ID: ${squad.squadID}) on team ${squad.teamID} now has a proper SL role.`
        );

        // Always notify when a tracked squad's leader selects the correct role
        await this.notifyRoleCorrected(squad, squadLeader, players);
      }
    } else {
      // Either no SL or SL has invalid role

      // If already tracking
      if (this.squadTracking.has(squadKey)) {
        const trackData = this.squadTracking.get(squadKey);

        // Check if warning interval has passed
        if (nowTimestamp - trackData.lastWarning >= this.options.warningIntervalSeconds) {
          // Handle warning and possibly disband
          await this.handleSquadWarning(
            squad,
            squadLeader,
            players,
            trackData,
            nowTimestamp,
            adminContext
          );
        }
      } else {
        // Start tracking
        this.squadTracking.set(squadKey, {
          firstDetected: nowTimestamp,
          lastWarning: nowTimestamp - this.options.warningIntervalSeconds, // Ensure immediate warning
          squadID: squad.squadID,
          teamID: squad.teamID,
          squadName: squad.squadName
        });

        this.verbose(
          1,
          `Started tracking squad ${squad.squadName} (ID: ${squad.squadID}) on team ${squad.teamID} for invalid SL role.`
        );
      }
    }
  }

  /**
   * Handle warnings and possibly disbanding for a squad
   * @param {Object} squad The squad object
   * @param {Object} squadLeader The squad leader object (if exists)
   * @param {Array} players List of all players
   * @param {Object} trackData Tracking data for the squad
   * @param {number} nowTimestamp Current timestamp
   * @param {Object} adminContext Admin metadata (eosIDs array and online player objects)
   */
  async handleSquadWarning(squad, squadLeader, players, trackData, nowTimestamp, adminContext) {
    // Calculate time remaining
    const elapsed = nowTimestamp - trackData.firstDetected;
    const remaining = this.options.disbandTimeoutSeconds - elapsed;

    if (remaining <= 0 && this.options.enableAutoDisbanding) {
      // Final check of squad leader's role before disbanding
      const currentSquadLeader = players.find(
        (player) =>
          player.teamID === squad.teamID && player.squadID === squad.squadID && player.isLeader
      );

      // Check if the current squad leader is an admin and should be ignored
      if (
        currentSquadLeader &&
        this.options.ignoreAdmins &&
        adminContext.eosIDs.includes(currentSquadLeader.eosID)
      ) {
        this.verbose(
          1,
          `Squad ${squad.squadName} (ID: ${squad.squadID}) on team ${squad.teamID} leader is now an admin - ignoring SL role validation.`
        );
        this.squadTracking.delete(`${squad.teamID}_${squad.squadID}`);
        return;
      }

      // If the SL now has a valid role, don't disband
      if (currentSquadLeader && this.isValidSlRole(currentSquadLeader.role)) {
        this.verbose(
          1,
          `Squad ${squad.squadName} (ID: ${squad.squadID}) on team ${squad.teamID} corrected SL role at the last minute. Not disbanding.`
        );
        // Update tracking data
        trackData.lastWarning = nowTimestamp;
        this.squadTracking.delete(`${squad.teamID}_${squad.squadID}`);
        // Notify about the corrected role
        await this.notifyRoleCorrected(squad, currentSquadLeader, players);
        return;
      }

      // Time's up, disband the squad
      try {
        // Gather all relevant information before disbanding
        // Get squad members
        const squadMembers = players.filter(
          (player) => player.teamID === squad.teamID && player.squadID === squad.squadID
        );

        // Find team name
        const teamName = squad.teamName || `Team ${squad.teamID}`;

        // Store information about the disbanded squad for the embed
        const disbandInfo = {
          squadName: squad.squadName,
          squadID: squad.squadID,
          teamID: squad.teamID,
          teamName: teamName,
          squadLeader: squadLeader || { name: 'Unknown', steamID: 'Unknown', role: 'None' },
          squadMembers: squadMembers,
          disbandReason: `No proper SL role for ${this.formatTimeRemaining(
            this.options.disbandTimeoutSeconds
          )}`,
          requiredRolePattern: this.options.requiredRolePattern
        };

        // Now disband the squad
        await this.server.rcon.execute(`AdminDisbandSquad ${squad.teamID} ${squad.squadID}`);

        // Notify about disbanding
        const message = `Squad ${squad.squadName} (ID: ${squad.squadID}) on team ${teamName} was disbanded for not having a proper SL role for ${this.options.disbandTimeoutSeconds} seconds.`;
        this.verbose(1, message);

        // Create a detailed Discord embed
        const embedFields = [
          {
            name: '⚠️ Squad Information',
            value: `**Name:** ${disbandInfo.squadName}\n**ID:** ${disbandInfo.squadID}\n**Team:** ${disbandInfo.teamName} (${disbandInfo.teamID})`,
            inline: false
          },
          {
            name: '👤 Squad Leader',
            value: `**Name:** ${disbandInfo.squadLeader.name}\n**SteamID:** ${
              disbandInfo.squadLeader.steamID
            }\n**Role:** ${disbandInfo.squadLeader.role || 'None'}`,
            inline: false
          },
          {
            name: '❌ Disband Reason',
            value: `Squad Leader did not have required role pattern: **${
              disbandInfo.requiredRolePattern
            }**\nTime elapsed: **${this.formatTimeRemaining(this.options.disbandTimeoutSeconds)}**`,
            inline: false
          }
        ];

        // Add squad members section if there are any
        if (disbandInfo.squadMembers.length > 0) {
          const membersField = {
            name: `👥 Squad Members (${disbandInfo.squadMembers.length})`,
            value: '',
            inline: false
          };

          // Format squad members list, limit to first 10 if there are many
          const displayMembers = disbandInfo.squadMembers.slice(0, 10);
          membersField.value = displayMembers
            .map(
              (member, index) =>
                `${index + 1}. **${member.name}**${member.isLeader ? ' (Leader)' : ''}`
            )
            .join('\n');

          if (disbandInfo.squadMembers.length > 10) {
            membersField.value += `\n...and ${disbandInfo.squadMembers.length - 10} more members`;
          }

          embedFields.push(membersField);
        }

        // Send to Discord
        await this.sendDiscordMessage({
          embed: {
            title: '⛔ Squad Disbanded - Invalid SL Role',
            color: 0xff0000,
            description: `A squad has been automatically disbanded due to the Squad Leader not using the proper role designation.`,
            fields: embedFields,
            footer: {
              text: `Squad Leader Role Validator | ${new Date().toLocaleString()}`
            },
            timestamp: new Date().toISOString()
          }
        });

        await this.notifyAdminsOfDisband(disbandInfo, adminContext.players);

        // Notify players in that squad
        const squadPlayers = players.filter(
          (player) => player.teamID === squad.teamID && player.squadID === squad.squadID
        );

        for (const player of squadPlayers) {
          await this.server.rcon.warn(
            player.steamID,
            'Your squad has been disbanded due to not having a proper Squad Leader role.'
          );
        }

        // Remove tracking
        this.squadTracking.delete(`${squad.teamID}_${squad.squadID}`);
      } catch (error) {
        this.verbose(1, `Error disbanding squad: ${error.message}`);
      }
    } else {
      // Send warning to squad members
      const timeDisplay = this.formatTimeRemaining(Math.max(0, remaining));
      let warning;

      // Final warning (less than or equal to warning interval seconds remaining)
      if (remaining <= this.options.warningIntervalSeconds) {
        warning = `FINAL WARNING: Squad Leader needs proper role! Squad will be disbanded IMMEDIATELY if not fixed!`;
      } else {
        // Regular warning
        warning = `Squad Leader needs proper role! Squad will disband in ${timeDisplay}.`;
      }

      try {
        // Warn the squad leader if available
        if (squadLeader) {
          await this.server.rcon.warn(squadLeader.steamID, warning);
        }

        // Warn all squad members (excluding the SL who was already warned)
        const squadMembers = players.filter(
          (player) =>
            player.teamID === squad.teamID &&
            player.squadID === squad.squadID &&
            (!squadLeader || player.steamID !== squadLeader.steamID)
        );

        for (const member of squadMembers) {
          await this.server.rcon.warn(member.steamID, warning);
        }

        // Update tracking
        trackData.lastWarning = nowTimestamp;
        this.squadTracking.set(`${squad.teamID}_${squad.squadID}`, trackData);

        this.verbose(
          1,
          `Warned squad ${squad.squadName} (ID: ${squad.squadID}) on team ${squad.teamID} about invalid SL role. Time remaining: ${timeDisplay}`
        );
      } catch (error) {
        this.verbose(1, `Error warning squad: ${error.message}`);
      }
    }
  }

  /**
   * Notify online admins when a squad is disbanded.
   * @param {Object} disbandInfo Details about the disbanded squad
   * @param {Array} adminPlayers Online admin player objects
   */
  async notifyAdminsOfDisband(disbandInfo, adminPlayers) {
    if (!this.options.notifyAdmins || !Array.isArray(adminPlayers) || adminPlayers.length === 0) {
      return;
    }

    const notification = `Admin Notice: Squad ${disbandInfo.squadName} (${disbandInfo.teamName}) was disbanded for missing required SL role pattern "${disbandInfo.requiredRolePattern}".`;
    const notified = new Set();

    for (const admin of adminPlayers) {
      const steamID = admin?.steamID;
      if (!steamID || notified.has(steamID)) continue;

      try {
        await this.server.rcon.warn(steamID, notification);
        notified.add(steamID);
      } catch (error) {
        this.verbose(1, `Error notifying admin ${admin?.name || steamID}: ${error.message}`);
      }
    }
  }

  /**
   * Send a positive notification to the squad when their leader selects the proper role
   * @param {Object} squad The squad object
   * @param {Object} squadLeader The squad leader object
   * @param {Array} players List of all players
   */
  async notifyRoleCorrected(squad, squadLeader, players) {
    try {
      // Get all members of the squad
      const squadMembers = players.filter(
        (player) => player.teamID === squad.teamID && player.squadID === squad.squadID
      );

      // Thank the squad leader
      const thankMessage = `Thank you for selecting the proper Squad Leader role! Your squad will not be disbanded.`;
      await this.server.rcon.warn(squadLeader.steamID, thankMessage);

      // Notify other squad members
      const memberMessage = `Your Squad Leader has selected the proper role. Squad will not be disbanded.`;
      for (const member of squadMembers) {
        if (member.steamID !== squadLeader.steamID) {
          await this.server.rcon.warn(member.steamID, memberMessage);
        }
      }

      // Log to Discord if enabled
      if (this.channel) {
        const teamName = squad.teamName || `Team ${squad.teamID}`;

        await this.sendDiscordMessage({
          embed: {
            title: '✅ Squad Leader Role Corrected',
            color: 0x00ff00,
            description: `The Squad Leader of ${squad.squadName} (ID: ${squad.squadID}) on team ${teamName} has selected the proper role.`,
            fields: [
              {
                name: '👤 Squad Leader',
                value: `**Name:** ${squadLeader.name}\n**Role:** ${squadLeader.role}`,
                inline: false
              },
              {
                name: '🛡️ Squad Information',
                value: `**Name:** ${squad.squadName}\n**Size:** ${squadMembers.length} members\n**Team:** ${teamName}`,
                inline: false
              }
            ],
            timestamp: new Date().toISOString()
          }
        });
      }
    } catch (error) {
      this.verbose(1, `Error sending role corrected notification: ${error.message}`);
    }
  }
}
