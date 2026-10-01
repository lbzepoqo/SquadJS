import BasePlugin from './base-plugin.js';
import fs from 'fs';
import path from 'path';

export default class LayerRotationManager extends BasePlugin {
  static get description() {
    return 'Comments out layers in LayerVoting.cfg if the current game mode has been played recently.';
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      layerVotingFilePath: {
        required: true,
        description: 'Path to the LayerVoting.cfg file.',
        default: '/SquadGame/ServerConfig/LayerVoting.cfg',
        example: '/SquadGame/ServerConfig/LayerVoting.cfg'
      },
      gameModeSkipRounds: {
        required: false,
        description: 'JSON object defining how many rounds to skip for each game mode.',
        default: {
          AAS: 0,
          RAAS: 0,
          Invasion: 3,
          Seed: 0,
          Skirmish: 0,
          TerritoryControl: 0,
          Insurgency: 3,
          Destruction: 3
        },
        example: {
          AAS: 0,
          RAAS: 0,
          Invasion: 3,
          Seed: 0,
          Skirmish: 0,
          TerritoryControl: 0,
          Insurgency: 3,
          Destruction: 3
        }
      },
      alwaysDisabledGameModes: {
        required: false,
        description: 'Array of game modes to always keep commented out.',
        default: [],
        example: ['TerritoryControl', 'Seed']
      },
      alwaysEnabledGameModes: {
        required: false,
        description:
          'Array of game modes to always keep enabled, overriding rotation rules but not alwaysDisabledLayers/Levels.',
        default: [],
        example: ['RAAS', 'AAS']
      },
      alwaysDisabledLevels: {
        required: false,
        description: 'Array of level/map names to always keep commented out.',
        default: [],
        example: ['Fallujah', 'Logar']
      },
      alwaysEnabledLevels: {
        required: false,
        description:
          'Array of level/map names to always keep enabled, overriding other disable rules except for alwaysDisabledLayers.',
        default: [],
        example: ['Yehorivka', 'Goose']
      },
      alwaysDisabledLayers: {
        required: false,
        description:
          'Array of specific layer names to always keep commented out, regardless of game mode rotation.',
        default: [],
        example: ['ICM_AlBasrah_Invasion_v1', 'ICM_Anvil_AAS_v2']
      },
      alwaysEnabledLayers: {
        required: false,
        description:
          'Array of specific layer names to always keep enabled, overriding any other disable rules.',
        default: [],
        example: ['ICM_Fallujah_TC_v1', 'ICM_Logar_RAAS_v1']
      },
      gameModeIdentifiers: {
        required: false,
        description: 'Mapping of game mode identifiers in layer names.',
        default: {
          AAS: '_AAS_',
          RAAS: '_RAAS_',
          Invasion: '_Invasion_',
          Seed: '_Seed_',
          Skirmish: '_Skirmish_',
          TerritoryControl: '_TC_',
          Insurgency: '_Insurgency_',
          Destruction: '_Destruction_',
          KingOfTheHill: '_KOTH_',
          Siege: '_Siege_',
          Armor: '_Armor_',
          Tanks: '_Tanks_',
          Sandbox: '_Sandbox_',
          PAAS: '_PAAS_'
        }
      },
      debugMode: {
        required: false,
        description: 'Enable additional debug logging.',
        default: false
      },
      disableModesInSeedMode: {
        required: false,
        description: 'Array of game modes to comment out when the current layer is Seed mode.',
        default: ['Invasion'],
        example: ['Invasion', 'Insurgency', 'Destruction']
      },
      timezone: {
        required: false,
        description:
          'IANA timezone identifier for time-based rules (e.g., "America/New_York", "Europe/London", "UTC").',
        default: 'UTC',
        example: 'America/New_York'
      },
      timeBasedDisabledGameModes: {
        required: false,
        description:
          'Object mapping game mode names to time windows when they should be disabled. Uses 24-hour format. Supports overnight ranges (e.g., startHour: 22, endHour: 6).',
        default: {},
        example: {
          Invasion: { startHour: 22, endHour: 6 }
        }
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    // Initialize game mode counters
    this.gameModeCounters = {};
    for (const gameMode in this.options.gameModeSkipRounds) {
      this.gameModeCounters[gameMode] = 0;
    }

    // Bind methods
    this.onNewGame = this.onNewGame.bind(this);
    this.updateLayerVotingFile = this.updateLayerVotingFile.bind(this);
    this.checkCurrentGameMode = this.checkCurrentGameMode.bind(this);

    // Initialize timer reference
    this.checkIntervalId = null;
    // Track last game mode for Seed transition logic
    this.lastGameMode = null;
  }

  async mount() {
    this.verbose(1, 'Layer Rotation Manager plugin mounted.');

    // Validate timezone configuration
    try {
      new Intl.DateTimeFormat('en-US', {
        timeZone: this.options.timezone
      }).format(new Date());
    } catch (error) {
      throw new Error(
        `Invalid timezone "${this.options.timezone}". Please use a valid IANA timezone identifier (e.g., "America/New_York", "Europe/London", "UTC").`
      );
    }

    // Register for NEW_GAME events
    this.server.on('NEW_GAME', this.onNewGame);

    // Load existing counters from state file if it exists
    await this.loadState();

    // Sanitize the layer voting file to ensure consistent comment formatting
    await this.sanitizeLayerVotingFile();

    // Check current game mode on mount and update layer voting file
    // This replaces the separate checkCurrentGameMode and updateLayerVotingFile calls
    try {
      const currentMapInfo = await this.server.rcon.getCurrentMap();

      if (currentMapInfo && currentMapInfo.layer) {
        const currentLayer = currentMapInfo.layer;
        const currentGameMode = this.determineGameMode(currentLayer);

        if (currentGameMode) {
          this.verbose(1, `Current game mode on mount: ${currentGameMode}`);

          // Update the layer voting file with the current game mode
          await this.updateLayerVotingFile(currentGameMode);
        } else {
          this.verbose(1, 'Could not determine game mode from layer name on mount.');
        }
      } else {
        this.verbose(1, 'Could not determine current layer from RCON response on mount.');
      }
    } catch (error) {
      this.verbose(1, `Error checking current game mode on mount: ${error.message}`);
    }

    // Set up periodic check every 5 minutes
    this.checkIntervalId = setInterval(this.checkCurrentGameMode, 5 * 60 * 1000);
  }

  async unmount() {
    // Remove event listeners
    this.server.removeEventListener('NEW_GAME', this.onNewGame);

    // Clear interval if it exists
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }

    // Save state before unmounting
    await this.saveState();
  }

  async loadState() {
    const stateFilePath = path.join(
      path.dirname(this.options.layerVotingFilePath),
      'layer-rotation-state.json'
    );

    try {
      if (fs.existsSync(stateFilePath)) {
        const stateData = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
        this.gameModeCounters = stateData.gameModeCounters || this.gameModeCounters;
        // Restore lastGameMode if present and valid
        if (typeof stateData.lastGameMode !== 'undefined') {
          // Validate that lastGameMode is a valid game mode string
          const validGameModes = Object.keys(this.options.gameModeIdentifiers);
          if (
            typeof stateData.lastGameMode === 'string' &&
            validGameModes.includes(stateData.lastGameMode)
          ) {
            this.lastGameMode = stateData.lastGameMode;
            this.verbose(1, `Loaded lastGameMode from state file: ${this.lastGameMode}`);
          } else {
            this.verbose(
              1,
              `Invalid lastGameMode in state file: ${stateData.lastGameMode}. Ignoring.`
            );
            this.verbose(
              1,
              `Note: If determineGameMode logic is updated to recognize new game modes not present in gameModeIdentifiers, this validation might incorrectly discard a valid lastGameMode.`
            );
          }
        }
        this.verbose(1, 'Loaded game mode counters from state file.');
      }
    } catch (error) {
      this.verbose(1, `Error loading state file: ${error.message}`);
    }
  }

  async saveState() {
    const stateFilePath = path.join(
      path.dirname(this.options.layerVotingFilePath),
      'layer-rotation-state.json'
    );

    try {
      const stateData = {
        gameModeCounters: this.gameModeCounters,
        lastGameMode: this.lastGameMode, // Persist lastGameMode
        lastUpdated: new Date().toISOString()
      };

      fs.writeFileSync(stateFilePath, JSON.stringify(stateData, null, 2), 'utf8');
      this.verbose(1, 'Saved game mode counters to state file.');
    } catch (error) {
      this.verbose(1, `Error saving state file: ${error.message}`);
    }
  }

  async onNewGame(info) {
    this.verbose(1, 'New game started, checking current layer...');
    try {
      // Get current map information using getCurrentMap method
      const currentMapInfo = await this.server.rcon.getCurrentMap();
      // The layer is directly available from the getCurrentMap response
      const currentLayer = currentMapInfo.layer;
      if (!currentLayer) {
        this.verbose(1, 'Could not determine current layer from RCON response.');
        return;
      }
      this.verbose(1, `Current layer: ${currentLayer}`);
      // Determine which game mode is being played
      const currentGameMode = this.determineGameMode(currentLayer);
      if (!currentGameMode) {
        this.verbose(1, 'Could not determine game mode from layer name.');
        return;
      }
      this.verbose(1, `Current game mode: ${currentGameMode}`);
      // Special handling for Seed mode
      if (
        currentGameMode === 'Seed' &&
        this.options.disableModesInSeedMode &&
        this.options.disableModesInSeedMode.length > 0
      ) {
        this.verbose(1, 'Seed mode detected. Will disable specified game modes in layer voting.');
      }
      // --- Seed transition logic ---
      // Extract common conditions into named constants for better readability
      const isTransitioningFromSeed = this.lastGameMode === 'Seed' && currentGameMode !== 'Seed';

      if (isTransitioningFromSeed) {
        this.handleSeedTransition(currentGameMode);
      }

      /*
       * GAME MODE COUNTER MANAGEMENT LOGIC
       *
       * This section handles the complex interaction between standard counter decrementing,
       * default skip rounds, and post-Seed transition logic. The logic flow is:
       *
       * 1. SEED TRANSITION ENFORCEMENT (handled above):
       *    - When transitioning FROM Seed mode, modes in disableModesInSeedMode get their
       *      counters set to at least 1 (or their configured skip value, whichever is higher)
       *    - This ensures these modes are disabled after Seed, even if their normal skip value is 0
       *
       * 2. STANDARD DECREMENTING (below):
       *    - All other game mode counters are decremented by 1 each round
       *    - Exceptions: current game mode and modes just set by Seed transition
       *    - Only counters > 0 are decremented to prevent negative values
       *
       * 3. CURRENT GAME MODE RESET (below):
       *    - Normally, the current game mode counter gets reset to its default skip value
       *    - Exception: If this mode was just configured by Seed transition, preserve that value
       *    - This maintains the post-Seed disable behavior for the currently playing game mode
       *
       * The conditions wasForceSkippedAfterSeed and wasJustSetBySeeding ensure proper
       * coordination between these three behaviors to prevent conflicts and maintain
       * the intended game mode rotation logic.
       */

      // Decrement counters for other game modes (except those just set above)
      for (const gameMode in this.gameModeCounters) {
        // Only decrement if not the current game mode and not just set by Seed transition
        const wasForceSkippedAfterSeed =
          isTransitioningFromSeed && (this.options.disableModesInSeedMode || []).includes(gameMode);
        if (
          gameMode !== currentGameMode &&
          !wasForceSkippedAfterSeed &&
          this.gameModeCounters[gameMode] > 0
        ) {
          this.gameModeCounters[gameMode]--;
        }
      }

      // Reset the counter for the current game mode to its default skip rounds value.
      // However, preserve the enforced skip counter if this game mode was just configured
      // by Seed transition logic to ensure post-Seed disable behavior is maintained.
      const wasJustSetBySeeding =
        isTransitioningFromSeed &&
        (this.options.disableModesInSeedMode || []).includes(currentGameMode);
      if (!wasJustSetBySeeding) {
        this.gameModeCounters[currentGameMode] =
          this.options.gameModeSkipRounds[currentGameMode] || 0;
      }
      // Track last game mode for next round (move before saveState to persist correctly)
      this.lastGameMode = currentGameMode;
      // Save the updated state
      await this.saveState();
      // Update the layer voting file
      await this.updateLayerVotingFile(currentGameMode);
      // Execute AdminReloadServerConfig command to reload the server configuration
      await this.server.rcon.execute('AdminReloadServerConfig');
      this.verbose(1, 'Executed AdminReloadServerConfig command to refresh server configuration.');
      if (currentGameMode) {
        this.verbose(
          1,
          `Game mode ${currentGameMode} will be skipped for the next ${this.gameModeCounters[currentGameMode]} rounds.`
        );
      }
    } catch (error) {
      this.verbose(1, `Error processing new game event: ${error.message}`);
    }
  }

  handleSeedTransition(currentGameMode) {
    // When transitioning from Seed mode, enforce skip counters for modes in disableModesInSeedMode.
    // This ensures these modes are disabled for at least 1 round (or their configured skip value, whichever is higher).
    // This prevents modes with gameModeSkipRounds=0 from being immediately available after Seed.
    for (const mode of this.options.disableModesInSeedMode || []) {
      // Initialize counter for this mode if it doesn't exist (prevents undefined counters)
      if (!(mode in this.gameModeCounters)) {
        this.gameModeCounters[mode] = 0;
        this.verbose(1, `Initialized counter for previously unknown game mode: ${mode}`);
      }

      // Ensure at least 1 round is skipped after Seed, unless configured higher
      const skipRounds = Math.max(1, this.options.gameModeSkipRounds[mode] || 0);
      this.gameModeCounters[mode] = skipRounds;
      this.verbose(
        1,
        `After Seed mode, set skip counter for ${mode}: ${this.gameModeCounters[mode]}`
      );
    }
  }

  determineGameMode(layerName) {
    if (this.options.debugMode) {
      this.verbose(1, `Determining game mode for layer: ${layerName}`);
    }

    for (const [gameMode, identifier] of Object.entries(this.options.gameModeIdentifiers)) {
      if (layerName.includes(identifier)) {
        if (this.options.debugMode) {
          this.verbose(
            1,
            `Found game mode ${gameMode} with identifier ${identifier} in layer ${layerName}`
          );
        }
        return gameMode;
      }
    }

    if (this.options.debugMode) {
      this.verbose(1, `Could not determine game mode for layer: ${layerName}`);
      this.verbose(1, `Available identifiers: ${JSON.stringify(this.options.gameModeIdentifiers)}`);
    }

    return null;
  }

  isGameModeTimeDisabled(gameMode) {
    const rules = this.options.timeBasedDisabledGameModes;
    if (!rules || !rules[gameMode]) {
      return false;
    }

    try {
      const { startHour, endHour } = rules[gameMode];
      const now = new Date();
      const currentHour = parseInt(
        new Intl.DateTimeFormat('en-US', {
          timeZone: this.options.timezone,
          hour: 'numeric',
          hour12: false
        }).format(now)
      );

      // Handle overnight ranges (e.g., 22 to 6 means 22:00-05:59)
      if (startHour > endHour) {
        return currentHour >= startHour || currentHour < endHour;
      }
      // Standard range (e.g., 8 to 18 means 08:00-17:59)
      return currentHour >= startHour && currentHour < endHour;
    } catch (error) {
      this.verbose(1, `Error checking time-based rule for ${gameMode}: ${error.message}`);
      return false;
    }
  }

  extractLevelName(layerName) {
    if (this.options.debugMode) {
      this.verbose(1, `Extracting level name from layer: ${layerName}`);
    }

    // First, strip off any faction specifiers if present (e.g., "|INS|", "|+Armored INS|+Armored|")
    let cleanLayerName = layerName;
    if (layerName.includes('|')) {
      cleanLayerName = layerName.split('|')[0].trim();
      if (this.options.debugMode) {
        this.verbose(1, `Removed faction specifiers, now: ${cleanLayerName}`);
      }
    }

    // For modded layers like "ICM_Sanxian_RAAS_v1" or "RS_HLP_Gorodok_RAAS_v1", remove all leading all-caps prefixes
    let withoutPrefix = cleanLayerName;
    if (cleanLayerName.includes('_')) {
      const parts = cleanLayerName.split('_');
      let start = 0;
      while (start < parts.length - 1 && /^[A-Z]{2,4}$/.test(parts[start])) {
        start++;
      }
      if (start > 0) {
        withoutPrefix = parts.slice(start).join('_');
        if (this.options.debugMode) {
          this.verbose(1, `Removed ${start} prefix(es), now: ${withoutPrefix}`);
        }
      }
    }

    // Now extract the level name using game mode identifiers
    for (const identifier of Object.values(this.options.gameModeIdentifiers)) {
      if (withoutPrefix.includes(identifier)) {
        const levelName = withoutPrefix.split(identifier)[0].replace(/_$/, '');
        if (this.options.debugMode) {
          this.verbose(
            1,
            `Found level name "${levelName}" using game mode identifier "${identifier}"`
          );
        }
        return levelName;
      }
    }

    // If we can't determine the level using game mode identifiers, try a more generic approach
    // For both vanilla (Sanxian_RAAS_v1) and modded (ICM_Sanxian_RAAS_v1) formats
    const parts = withoutPrefix.split('_');
    if (parts.length >= 2) {
      // For vanilla layers like "Sanxian_RAAS_v1", the first part is the level name
      // For remaining modded layers, it should be the first part of withoutPrefix
      const levelName = parts[0];
      if (this.options.debugMode) {
        this.verbose(1, `Used generic approach to find level name: ${levelName}`);
      }
      return levelName;
    }

    // If all else fails
    if (this.options.debugMode) {
      this.verbose(1, `Could not extract level name from layer: ${layerName}`);
    }
    return null;
  }

  async updateLayerVotingFile(currentGameMode) {
    try {
      const filePath = this.options.layerVotingFilePath;

      // Check if the file exists
      if (!fs.existsSync(filePath)) {
        this.verbose(1, `LayerVoting.cfg file not found at ${filePath}`);
        return;
      }

      // Read the current file content
      const fileLines = fs.readFileSync(filePath, 'utf8').split('\n');
      const updatedLines = [];

      // Debug information
      if (this.options.debugMode) {
        this.verbose(1, 'Current game mode counters:');
        for (const [gameMode, count] of Object.entries(this.gameModeCounters)) {
          this.verbose(1, `  ${gameMode}: ${count}`);
        }
      }

      // Check if current game mode is Seed
      const isSeedMode = currentGameMode === 'Seed';
      if (this.options.debugMode) {
        this.verbose(1, `Current game mode: ${currentGameMode}`);
        this.verbose(1, `Is Seed mode: ${isSeedMode}`);
        this.verbose(
          1,
          `Modes to disable in Seed: ${JSON.stringify(this.options.disableModesInSeedMode || [])}`
        );
      }

      // Process each line
      for (const line of fileLines) {
        // Skip comment lines that are not layer lines (like // NOTE or // LAYER_VOTING)
        if (line.trim().startsWith('// NOTE') || line.trim().startsWith('// LAYER_VOTING')) {
          updatedLines.push(line);
          continue;
        }

        // Skip empty lines
        if (line.trim() === '') {
          updatedLines.push(line);
          continue;
        }

        // Process layer lines (both commented and uncommented)
        const trimmedLine = line.trim();
        let isCommented = false;
        let layerLine = trimmedLine;

        // Check if the line is commented (either '// LayerName' or '//LayerName')
        if (trimmedLine.startsWith('// ')) {
          isCommented = true;
          layerLine = trimmedLine.substring(3).trim();
        } else if (trimmedLine.startsWith('//')) {
          isCommented = true;
          layerLine = trimmedLine.substring(2).trim();
        }

        // Always use consistent comment format with a space after //
        const commentPrefix = '// ';

        // Check if this layer is in the always enabled list - this overrides all other rules
        if (
          this.options.alwaysEnabledLayers &&
          this.options.alwaysEnabledLayers.includes(layerLine)
        ) {
          // This layer should always be enabled
          if (isCommented) {
            updatedLines.push(layerLine);
            if (this.options.debugMode) {
              this.verbose(1, `Uncommenting layer: ${layerLine} (always enabled layer)`);
            }
          } else {
            updatedLines.push(line);
          }
          continue;
        }

        // Determine the game mode of this layer
        const layerGameMode = this.determineGameMode(layerLine);

        // Check if this game mode is in the always enabled list - this overrides level-based rules
        if (
          layerGameMode &&
          this.options.alwaysEnabledGameModes &&
          this.options.alwaysEnabledGameModes.includes(layerGameMode)
        ) {
          // This game mode should always be enabled
          if (isCommented) {
            updatedLines.push(layerLine);
            if (this.options.debugMode) {
              this.verbose(
                1,
                `Uncommenting layer: ${layerLine} (always enabled game mode: ${layerGameMode})`
              );
            }
          } else {
            updatedLines.push(line);
          }
          continue;
        }

        // Extract the level name for this layer
        const levelName = this.extractLevelName(layerLine);

        // Check if this layer's level is in the always enabled levels list
        if (
          levelName &&
          this.options.alwaysEnabledLevels &&
          this.options.alwaysEnabledLevels.includes(levelName)
        ) {
          // This level should always be enabled
          if (isCommented) {
            updatedLines.push(layerLine);
            if (this.options.debugMode) {
              this.verbose(
                1,
                `Uncommenting layer: ${layerLine} (always enabled level: ${levelName})`
              );
            }
          } else {
            updatedLines.push(line);
          }
          continue;
        }

        // Check if this layer is in the always disabled list
        if (
          this.options.alwaysDisabledLayers &&
          this.options.alwaysDisabledLayers.includes(layerLine)
        ) {
          // This layer should always be commented out
          if (!isCommented) {
            updatedLines.push(`${commentPrefix}${layerLine}`);
            if (this.options.debugMode) {
              this.verbose(1, `Commenting out layer: ${layerLine} (always disabled layer)`);
            }
          } else {
            updatedLines.push(line);
          }
          continue;
        }

        // Check if this layer's level is in the always disabled levels list
        if (
          levelName &&
          this.options.alwaysDisabledLevels &&
          this.options.alwaysDisabledLevels.includes(levelName)
        ) {
          // This level should always be commented out
          if (!isCommented) {
            updatedLines.push(`${commentPrefix}${layerLine}`);
            if (this.options.debugMode) {
              this.verbose(
                1,
                `Commenting out layer: ${layerLine} (always disabled level: ${levelName})`
              );
            }
          } else {
            updatedLines.push(line);
          }
          continue;
        }

        // Check if this game mode is in the always disabled list
        if (
          layerGameMode &&
          this.options.alwaysDisabledGameModes &&
          this.options.alwaysDisabledGameModes.includes(layerGameMode)
        ) {
          // This game mode should always be commented out
          if (!isCommented) {
            updatedLines.push(`${commentPrefix}${layerLine}`);
            if (this.options.debugMode) {
              this.verbose(
                1,
                `Commenting out layer: ${layerLine} (always disabled game mode: ${layerGameMode})`
              );
            }
          } else {
            updatedLines.push(line);
          }
          continue;
        }

        // Check if this game mode is time-disabled based on current time
        if (layerGameMode && this.isGameModeTimeDisabled(layerGameMode)) {
          if (!isCommented) {
            updatedLines.push(`${commentPrefix}${layerLine}`);
            if (this.options.debugMode) {
              this.verbose(
                1,
                `Commenting out layer: ${layerLine} (${layerGameMode} disabled by time-based rule)`
              );
            }
          } else {
            updatedLines.push(line);
          }
          continue;
        }

        // Check if we should disable this game mode because we're in Seed mode
        if (
          isSeedMode &&
          layerGameMode &&
          this.options.disableModesInSeedMode &&
          this.options.disableModesInSeedMode.includes(layerGameMode)
        ) {
          // Always comment out this layer in Seed mode, regardless of skip counter or skip rounds value
          if (!isCommented) {
            updatedLines.push(`${commentPrefix}${layerLine}`);
            if (this.options.debugMode) {
              this.verbose(
                1,
                `Commenting out layer: ${layerLine} (${layerGameMode} disabled during Seed mode)`
              );
            }
          } else {
            updatedLines.push(line);
          }
          continue;
        }

        // Check if this game mode should be commented out based on rotation
        if (layerGameMode) {
          const skipCount = this.gameModeCounters[layerGameMode] || 0;

          if (skipCount > 0) {
            // This game mode should be commented out
            if (!isCommented) {
              updatedLines.push(`${commentPrefix}${layerLine}`);
              if (this.options.debugMode) {
                this.verbose(
                  1,
                  `Commenting out layer: ${layerLine} (${layerGameMode}, skip count: ${skipCount})`
                );
              }
            } else {
              updatedLines.push(line);
            }
          } else {
            // This game mode should be uncommented
            if (isCommented) {
              updatedLines.push(layerLine);
              if (this.options.debugMode) {
                this.verbose(1, `Uncommenting layer: ${layerLine} (${layerGameMode})`);
              }
            } else {
              updatedLines.push(line);
            }
          }
        } else {
          // If we can't determine the game mode, leave the line as is
          updatedLines.push(line);
        }
      }

      // Write the updated content back to the file
      fs.writeFileSync(filePath, updatedLines.join('\n'), 'utf8');

      this.verbose(1, `Updated LayerVoting.cfg file successfully.`);
    } catch (error) {
      this.verbose(1, `Error updating LayerVoting.cfg file: ${error.message}`);
    }
  }

  async sanitizeLayerVotingFile() {
    try {
      const filePath = this.options.layerVotingFilePath;
      // Check if the file exists
      if (!fs.existsSync(filePath)) {
        this.verbose(1, `LayerVoting.cfg file not found at ${filePath}`);
        return;
      }
      // Read the current file content
      const fileLines = fs.readFileSync(filePath, 'utf8').split('\n');
      const sanitizedLines = [];
      // Process each line
      for (const line of fileLines) {
        const trimmedLine = line.trim();
        // Skip empty lines
        if (trimmedLine === '') {
          sanitizedLines.push(line);
          continue;
        }
        // Handle comment lines that are not layer lines
        if (trimmedLine.startsWith('// NOTE') || trimmedLine.startsWith('// LAYER_VOTING')) {
          sanitizedLines.push(line);
          continue;
        }
        // Process layer lines (both commented and uncommented)
        let isCommented = false;
        let layerLine = trimmedLine;
        // Check if the line is commented (either '// LayerName' or '//LayerName')
        if (trimmedLine.startsWith('// ')) {
          isCommented = true;
          layerLine = trimmedLine.substring(3).trim();
        } else if (trimmedLine.startsWith('//')) {
          isCommented = true;
          layerLine = trimmedLine.substring(2).trim();
        }
        // Sanitize the line format
        if (isCommented) {
          sanitizedLines.push(`// ${layerLine}`);
        } else {
          sanitizedLines.push(layerLine);
        }
      }
      // Write the sanitized content back to the file
      fs.writeFileSync(filePath, sanitizedLines.join('\n'), 'utf8');
      this.verbose(1, `Sanitized LayerVoting.cfg file to ensure consistent comment formatting.`);
    } catch (error) {
      this.verbose(1, `Error sanitizing LayerVoting.cfg file: ${error.message}`);
    }
  }

  async checkCurrentGameMode() {
    try {
      this.verbose(1, 'Checking current game mode...');
      // Get current map information
      const currentMapInfo = await this.server.rcon.getCurrentMap();
      if (!currentMapInfo || !currentMapInfo.layer) {
        this.verbose(1, 'Could not determine current layer from RCON response.');
        return;
      }
      const currentLayer = currentMapInfo.layer;
      const currentGameMode = this.determineGameMode(currentLayer);
      if (!currentGameMode) {
        this.verbose(1, 'Could not determine game mode from layer name.');
        return;
      }
      this.verbose(1, `Current game mode: ${currentGameMode}`);
      // Enhanced debug logging
      if (this.options.debugMode) {
        this.verbose(1, `Current layer: ${currentLayer}`);
        this.verbose(1, `Detected game mode: ${currentGameMode}`);
        this.verbose(1, `Is Seed mode: ${currentGameMode === 'Seed'}`);
        this.verbose(
          1,
          `Modes to disable in Seed: ${JSON.stringify(this.options.disableModesInSeedMode || [])}`
        );
      }
      const hasTimeBasedRules =
        this.options.timeBasedDisabledGameModes &&
        Object.keys(this.options.timeBasedDisabledGameModes).length > 0;
      const isSeedWithDisableRules =
        currentGameMode === 'Seed' &&
        this.options.disableModesInSeedMode &&
        this.options.disableModesInSeedMode.length > 0;

      // Update the layer voting file if time-based rules exist or we're in Seed mode
      if (hasTimeBasedRules || isSeedWithDisableRules) {
        if (isSeedWithDisableRules) {
          this.verbose(1, 'Seed mode detected during periodic check. Updating layer voting file.');
        }
        if (hasTimeBasedRules) {
          this.verbose(1, 'Time-based rules configured. Updating layer voting file.');
        }
        await this.updateLayerVotingFile(currentGameMode);
      }
    } catch (error) {
      this.verbose(1, `Error checking current game mode: ${error.message}`);
    }
  }
}
