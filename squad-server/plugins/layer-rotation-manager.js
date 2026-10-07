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
    let fileChanged = await this.sanitizeLayerVotingFile();

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
          if (await this.updateLayerVotingFile(currentGameMode)) fileChanged = true;
        } else {
          this.verbose(1, 'Could not determine game mode from layer name on mount.');
        }
      } else {
        this.verbose(1, 'Could not determine current layer from RCON response on mount.');
      }
    } catch (error) {
      this.verbose(1, `Error checking current game mode on mount: ${error.message}`);
    }

    // The game reads LayerVoting.cfg only at map load and on AdminReloadServerConfig.
    if (fileChanged) await this.reloadServerConfig();

    // Set up periodic check every 5 minutes
    this.checkIntervalId = setInterval(this.checkCurrentGameMode, 5 * 60 * 1000);
  }

  async unmount() {
    // Remove event listeners
    this.server.removeListener('NEW_GAME', this.onNewGame);

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
      // The event carries the layer from the log line, so no RCON round trip is needed.
      // layerClassname covers layers that are missing from the SquadJS layer list.
      const currentLayer = info?.layer?.layerid ?? info?.layerClassname;
      if (!currentLayer) {
        this.verbose(1, 'Could not determine current layer from the NEW_GAME event.');
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
      // The game already read the file at map load, so a reload is needed only after a change.
      if (await this.updateLayerVotingFile(currentGameMode)) {
        await this.reloadServerConfig();
      }
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

  parseLayerVotingLine(line) {
    const trimmedLine = line.trim();

    // Empty lines and header comments (// NOTE, // LAYER_VOTING) are kept as they are.
    if (
      trimmedLine === '' ||
      trimmedLine.startsWith('// NOTE') ||
      trimmedLine.startsWith('// LAYER_VOTING')
    ) {
      return null;
    }

    // A layer line is commented as either '// LayerName' or '//LayerName'.
    if (trimmedLine.startsWith('//')) {
      return { isCommented: true, layerLine: trimmedLine.substring(2).trim() };
    }
    return { isCommented: false, layerLine: trimmedLine };
  }

  listOptionIncludes(optionName, value) {
    return (this.options[optionName] || []).includes(value);
  }

  // Returns whether a layer should be enabled and why. enabled is null when no rule applies.
  // Rule order follows the option descriptions: a specific layer rule beats a level rule,
  // and a level rule beats a game mode rule.
  getLayerRule(layerLine, currentGameMode) {
    if (this.listOptionIncludes('alwaysEnabledLayers', layerLine)) {
      return { enabled: true, reason: 'always enabled layer' };
    }
    if (this.listOptionIncludes('alwaysDisabledLayers', layerLine)) {
      return { enabled: false, reason: 'always disabled layer' };
    }

    const levelName = this.extractLevelName(layerLine);
    if (levelName && this.listOptionIncludes('alwaysEnabledLevels', levelName)) {
      return { enabled: true, reason: `always enabled level: ${levelName}` };
    }
    if (levelName && this.listOptionIncludes('alwaysDisabledLevels', levelName)) {
      return { enabled: false, reason: `always disabled level: ${levelName}` };
    }

    const layerGameMode = this.determineGameMode(layerLine);
    if (!layerGameMode) {
      return { enabled: null };
    }
    if (this.listOptionIncludes('alwaysEnabledGameModes', layerGameMode)) {
      return { enabled: true, reason: `always enabled game mode: ${layerGameMode}` };
    }
    if (this.listOptionIncludes('alwaysDisabledGameModes', layerGameMode)) {
      return { enabled: false, reason: `always disabled game mode: ${layerGameMode}` };
    }
    if (this.isGameModeTimeDisabled(layerGameMode)) {
      return { enabled: false, reason: `${layerGameMode} disabled by time-based rule` };
    }
    if (
      currentGameMode === 'Seed' &&
      this.listOptionIncludes('disableModesInSeedMode', layerGameMode)
    ) {
      return { enabled: false, reason: `${layerGameMode} disabled during Seed mode` };
    }

    const skipCount = this.gameModeCounters[layerGameMode] || 0;
    if (skipCount > 0) {
      return { enabled: false, reason: `${layerGameMode}, skip count: ${skipCount}` };
    }
    return { enabled: true, reason: layerGameMode };
  }

  // Returns true when the file content changed, so the caller knows a config reload is needed.
  async updateLayerVotingFile(currentGameMode) {
    try {
      const filePath = this.options.layerVotingFilePath;

      // Check if the file exists
      if (!fs.existsSync(filePath)) {
        this.verbose(1, `LayerVoting.cfg file not found at ${filePath}`);
        return false;
      }

      const originalContent = fs.readFileSync(filePath, 'utf8');
      const updatedLines = [];

      // Debug information
      if (this.options.debugMode) {
        this.verbose(1, 'Current game mode counters:');
        for (const [gameMode, count] of Object.entries(this.gameModeCounters)) {
          this.verbose(1, `  ${gameMode}: ${count}`);
        }
        this.verbose(1, `Current game mode: ${currentGameMode}`);
        this.verbose(1, `Is Seed mode: ${currentGameMode === 'Seed'}`);
        this.verbose(
          1,
          `Modes to disable in Seed: ${JSON.stringify(this.options.disableModesInSeedMode || [])}`
        );
      }

      for (const line of originalContent.split('\n')) {
        const parsedLine = this.parseLayerVotingLine(line);
        if (!parsedLine) {
          updatedLines.push(line);
          continue;
        }

        const { isCommented, layerLine } = parsedLine;
        const { enabled, reason } = this.getLayerRule(layerLine, currentGameMode);

        if (enabled === true && isCommented) {
          updatedLines.push(layerLine);
          if (this.options.debugMode) {
            this.verbose(1, `Uncommenting layer: ${layerLine} (${reason})`);
          }
        } else if (enabled === false && !isCommented) {
          updatedLines.push(`// ${layerLine}`);
          if (this.options.debugMode) {
            this.verbose(1, `Commenting out layer: ${layerLine} (${reason})`);
          }
        } else {
          updatedLines.push(line);
        }
      }

      const updatedContent = updatedLines.join('\n');
      if (updatedContent === originalContent) {
        this.verbose(1, 'LayerVoting.cfg is already up to date.');
        return false;
      }

      fs.writeFileSync(filePath, updatedContent, 'utf8');
      this.verbose(1, `Updated LayerVoting.cfg file successfully.`);
      return true;
    } catch (error) {
      this.verbose(1, `Error updating LayerVoting.cfg file: ${error.message}`);
      return false;
    }
  }

  // Returns true when the file content changed.
  async sanitizeLayerVotingFile() {
    try {
      const filePath = this.options.layerVotingFilePath;
      // Check if the file exists
      if (!fs.existsSync(filePath)) {
        this.verbose(1, `LayerVoting.cfg file not found at ${filePath}`);
        return false;
      }
      const originalContent = fs.readFileSync(filePath, 'utf8');
      const sanitizedLines = originalContent.split('\n').map((line) => {
        const parsedLine = this.parseLayerVotingLine(line);
        if (!parsedLine) return line;
        return parsedLine.isCommented ? `// ${parsedLine.layerLine}` : parsedLine.layerLine;
      });
      const sanitizedContent = sanitizedLines.join('\n');
      if (sanitizedContent === originalContent) return false;

      fs.writeFileSync(filePath, sanitizedContent, 'utf8');
      this.verbose(1, `Sanitized LayerVoting.cfg file to ensure consistent comment formatting.`);
      return true;
    } catch (error) {
      this.verbose(1, `Error sanitizing LayerVoting.cfg file: ${error.message}`);
      return false;
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
        if (await this.updateLayerVotingFile(currentGameMode)) {
          await this.reloadServerConfig();
        }
      }
    } catch (error) {
      this.verbose(1, `Error checking current game mode: ${error.message}`);
    }
  }

  async reloadServerConfig() {
    try {
      await this.server.rcon.execute('AdminReloadServerConfig');
      this.verbose(1, 'Executed AdminReloadServerConfig command to refresh server configuration.');
    } catch (error) {
      this.verbose(1, `AdminReloadServerConfig failed: ${error.message}`);
    }
  }
}
