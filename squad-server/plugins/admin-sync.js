import BasePlugin from './base-plugin.js';
import axios from 'axios';
import { Mutex } from 'async-mutex';
import { promises as fsPromises } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createGzip } from 'zlib';
import { AttachmentBuilder } from 'discord.js';

export default class AdminSync extends BasePlugin {
  static get description() {
    return 'Syncs the Admins.cfg file with admin data from a whitelist URL at regular intervals.';
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      whitelistUrl: {
        required: true,
        description: 'URL or array of URLs to fetch admin whitelist data from.',
        example:
          'https://example.com/whitelist.txt or ["https://example.com/whitelist1.txt", "https://example.com/whitelist2.txt"]'
      },
      adminsFilePath: {
        required: true,
        description: 'Path to the Admins.cfg file.',
        example: '/home/container/SquadGame/ServerConfig/Admins.cfg'
      },
      temporaryReservesFilePath: {
        required: false,
        description:
          'Persistent temporary grants and last valid remote data. Defaults to adminsFilePath + .temporary-reserves.json.',
        default: ''
      },
      syncInterval: {
        required: false,
        description: 'Interval in seconds between admin sync operations.',
        default: 300,
        example: 300
      },
      updateOnStartup: {
        required: false,
        description: 'Whether to update the admin list when the plugin starts.',
        default: true
      },
      chatCommands: {
        required: false,
        description: 'Array of chat commands that will trigger an admin sync.',
        default: ['!syncadmins', '!updateadmins'],
        example: ['!syncadmins', '!updateadmins']
      },
      beautifyOutput: {
        required: false,
        description:
          'Whether to beautify and organize the admin data with comments, statistics, and group sections.',
        default: false
      },
      skipUnchanged: {
        required: false,
        description:
          'Whether to skip writing the file if the permissions of every admin ID are the same as at the last sync. Comments and group names are ignored.',
        default: true
      },
      backupToDiscord: {
        required: false,
        description: 'Whether to backup the Admins.cfg file to Discord after each successful sync.',
        default: false
      },
      discordClient: {
        required: false,
        description: 'Discord connector name (required if backupToDiscord is enabled).',
        connector: 'discord',
        default: 'discord'
      },
      backupChannelID: {
        required: false,
        description:
          'The ID of the Discord channel to send backup files to (required if backupToDiscord is enabled).',
        default: '',
        example: '667741905228136459'
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.syncAdmins = this.syncAdmins.bind(this);
    this.onChatMessage = this.onChatMessage.bind(this);
    this.syncInterval = null;
    this.isCurrentlySyncing = false;
    this.lastContentHash = null;
    this.backupChannel = null;
    this.writeMutex = new Mutex();
    this.temporaryReserves = {};
    this.remoteContent = null;
    this.expiryTimeout = null;
    this.stopped = true;
    this.onReserveRequest = (request) => {
      this.grantTemporaryReserve(request).then(request.resolve, request.reject);
    };
  }

  async prepareToMount() {
    if (this.options.backupToDiscord) {
      if (!this.options.backupChannelID) {
        this.verbose(
          1,
          'backupToDiscord is enabled but backupChannelID is not set. Discord backup will be disabled.'
        );
        return;
      }

      try {
        this.backupChannel = await this.options.discordClient.channels.fetch(
          this.options.backupChannelID
        );
        this.verbose(2, `Discord backup channel initialized: ${this.options.backupChannelID}`);
      } catch (error) {
        this.verbose(
          1,
          `Could not fetch Discord channel with backupChannelID "${this.options.backupChannelID}". Error: ${error.message}`
        );
        this.verbose(2, `${error.stack}`);
      }
    }
  }

  async mount() {
    await this.loadTemporaryReserves();
    if (this.server.listenerCount('TEMPORARY_RESERVE_REQUEST') > 0) {
      throw new Error('Only one AdminSync instance may manage temporary reserves.');
    }
    this.stopped = false;
    this.server.on('TEMPORARY_RESERVE_REQUEST', this.onReserveRequest);
    this.verbose(1, 'Admin Sync plugin mounted.');

    // Register for CHAT_MESSAGE events
    this.server.on('CHAT_MESSAGE', this.onChatMessage);

    // Load existing hash from file if skipUnchanged is enabled
    if (this.options.skipUnchanged) {
      this.lastContentHash = await this.extractHashFromFile();
      if (this.lastContentHash) {
        this.verbose(2, `Loaded existing content hash: ${this.lastContentHash}`);
      }
    }

    // Run an initial sync if configured
    if (this.options.updateOnStartup) {
      this.verbose(2, 'Running initial admin sync on startup.');
      await this.syncAdmins();
    } else if (this.remoteContent !== null) {
      await this.syncAdmins(false);
    }
    this.scheduleExpiry();

    // Set up interval sync
    if (this.options.syncInterval > 0) {
      const intervalMs = this.options.syncInterval * 1000;
      this.verbose(
        2,
        `Setting up admin sync interval: ${this.options.syncInterval}s (${intervalMs}ms)`
      );
      this.syncInterval = setInterval(async () => {
        if (this.isCurrentlySyncing) {
          this.verbose(2, 'Skipping scheduled sync - another sync is already in progress.');
          return;
        }
        this.verbose(2, 'Running scheduled admin sync...');
        await this.syncAdmins();
      }, intervalMs);
    }
  }

  async unmount() {
    this.stopped = true;
    this.server.off('TEMPORARY_RESERVE_REQUEST', this.onReserveRequest);
    clearTimeout(this.expiryTimeout);
    await this.writeMutex.waitForUnlock();
    // Clear interval
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    // Remove event listeners
    this.server.off('CHAT_MESSAGE', this.onChatMessage);
  }

  async onChatMessage(info) {
    try {
      // Only process commands from admin chat
      if (info.chat !== 'ChatAdmin') return;

      // Check if the message is a command
      const message = info.message.toLowerCase().trim();
      const isCommand = this.options.chatCommands.some((cmd) => message === cmd.toLowerCase());

      if (!isCommand) return;

      if (this.isCurrentlySyncing) {
        await this.server.rcon.warn(
          info.player.eosID,
          'Admin sync is already in progress. Please wait.'
        );
        return;
      }

      this.verbose(
        2,
        `Admin ${info.player.name} (${info.player.eosID}) triggered admin sync via chat command.`
      );

      // Acknowledge the command
      await this.server.rcon.warn(
        info.player.eosID,
        'Admin sync started. Check server logs for results.'
      );

      // Sync the admins
      const success = await this.syncAdmins();

      // Notify the admin of completion
      const resultMessage = success
        ? 'Admin sync completed successfully.'
        : 'Admin sync failed. Check server logs for details.';
      await this.server.rcon.warn(info.player.eosID, resultMessage);
    } catch (error) {
      this.verbose(1, `Error processing chat command: ${error.message}`);
      try {
        await this.server.rcon.warn(info.player.eosID, 'Admin sync failed due to an error.');
      } catch (rconError) {
        this.verbose(1, `Failed to send error message to admin: ${rconError.message}`);
      }
    }
  }

  get temporaryReservesFilePath() {
    return (
      this.options.temporaryReservesFilePath ||
      `${this.options.adminsFilePath}.temporary-reserves.json`
    );
  }

  async loadTemporaryReserves() {
    try {
      const state = JSON.parse(await fsPromises.readFile(this.temporaryReservesFilePath, 'utf8'));
      if (
        typeof state.remoteContent !== 'string' ||
        !state.temporaryReserves ||
        Array.isArray(state.temporaryReserves) ||
        typeof state.temporaryReserves !== 'object'
      ) {
        throw new Error('Invalid temporary reserve state');
      }
      for (const [eosID, grant] of Object.entries(state.temporaryReserves)) {
        this.validateGrant(eosID, grant.steamID, grant.expiresAt);
      }
      this.remoteContent = state.remoteContent;
      this.temporaryReserves = state.temporaryReserves;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  validateGrant(eosID, steamID, expiresAt) {
    if (
      !/^[a-f0-9]{32}$/.test(eosID) ||
      (steamID != null && !/^76561[0-9]{12}$/.test(steamID)) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= 0
    ) {
      throw new Error('Invalid temporary reserve ID or expiry');
    }
  }

  async grantTemporaryReserve({ eosID, steamID = null, durationHours }) {
    const expiresAt = Date.now() + Math.round(durationHours * 3600000);
    this.validateGrant(eosID, steamID, expiresAt);
    if (!Number.isFinite(durationHours) || durationHours <= 0) {
      throw new Error('Temporary reserve duration must be positive and finite');
    }
    return this.writeMutex.runExclusive(async () => {
      if (this.stopped) throw new Error('AdminSync is not mounted');
      // Repeated connection events do not extend an existing grant.
      if (!(this.temporaryReserves[eosID]?.expiresAt > Date.now())) {
        this.temporaryReserves[eosID] = { steamID, expiresAt };
      }
      try {
        await this.writeMergedAdmins(false);
      } finally {
        this.scheduleExpiry();
      }
    });
  }

  scheduleExpiry() {
    clearTimeout(this.expiryTimeout);
    const expiries = Object.values(this.temporaryReserves).map((grant) => grant.expiresAt);
    if (this.stopped || !expiries.length) return;
    // Failed expiry writes retry without waiting for the remote sync interval.
    const delay = Math.min(2147483647, Math.max(1000, Math.min(...expiries) - Date.now()));
    this.expiryTimeout = setTimeout(() => this.syncAdmins(false), delay);
  }

  async syncAdmins(refreshRemote = true) {
    return this.writeMutex.runExclusive(async () => {
      if (this.stopped) return false;
      this.isCurrentlySyncing = true;
      try {
        await this.writeMergedAdmins(refreshRemote);
        return true;
      } catch (error) {
        this.verbose(1, `Error syncing admins: ${error.message}`);
        return false;
      } finally {
        this.isCurrentlySyncing = false;
        this.scheduleExpiry();
      }
    });
  }

  mergeTemporaryReserves(grants) {
    const lines = this.remoteContent.split('\n');
    const temporaryGroups = [];
    const groups = new Map();
    for (const line of lines) {
      const match = line.trim().match(/^Group=([^:]+):([^/]*)(?:\/\/.*)?$/);
      if (match)
        groups.set(
          match[1],
          match[2]
            .split(',')
            .map((permission) => permission.trim())
            .filter(Boolean)
        );
    }
    for (const [eosID, grant] of Object.entries(grants)) {
      const permissions = new Set();
      const matchingLines = [];
      for (const [index, line] of lines.entries()) {
        const match = line.trim().match(/^Admin=([^:]+):([^\s/]+)(.*)$/);
        if (!match || (match[1] !== eosID && match[1] !== grant.steamID)) continue;
        if (!groups.has(match[2])) throw new Error(`Undefined admin group: ${match[2]}`);
        groups.get(match[2]).forEach((permission) => permissions.add(permission));
        matchingLines.push(index);
      }
      if (permissions.has('reserve')) continue;
      permissions.add('reserve');
      let groupName = `SquadJSReconnect_${eosID}`;
      while (groups.has(groupName)) groupName += '_';
      groups.set(groupName, [...permissions]);
      temporaryGroups.push(`Group=${groupName}:${[...permissions].join(',')}`);
      if (matchingLines.length) {
        for (const index of matchingLines) {
          lines[index] = lines[index].replace(/^(\s*Admin=[^:]+:)[^\s/]+/, `$1${groupName}`);
        }
      } else {
        lines.push(`Admin=${eosID}:${groupName}`);
      }
    }
    return [...temporaryGroups, ...lines].join('\n');
  }

  async writeMergedAdmins(refreshRemote) {
    if (refreshRemote || this.remoteContent === null) {
      const urls = Array.isArray(this.options.whitelistUrl)
        ? this.options.whitelistUrl
        : [this.options.whitelistUrl];
      try {
        this.remoteContent = await this.fetchAdminDataFromUrls(urls);
      } catch (error) {
        if (this.remoteContent === null) throw error;
        this.verbose(1, `Keeping last valid remote admin data: ${error.message}`);
      }
    }
    if (!this.remoteContent?.trim()) throw new Error('No valid remote admin data available');
    const activeGrants = Object.fromEntries(
      Object.entries(this.temporaryReserves).filter(([, grant]) => grant.expiresAt > Date.now())
    );
    const combinedContent = this.mergeTemporaryReserves(activeGrants);
    const newContentHash = this.computeContentHash(combinedContent);
    await this.writeAtomicFile(
      this.temporaryReservesFilePath,
      JSON.stringify({
        remoteContent: this.remoteContent,
        temporaryReserves: activeGrants
      })
    );
    if (!this.options.skipUnchanged || this.lastContentHash !== newContentHash) {
      const finalContent = this.options.beautifyOutput
        ? this.beautifyAdminData(combinedContent)
        : combinedContent;
      const contentWithHash = this.prependHashComment(finalContent, newContentHash);
      await this.updateAdminsFile(contentWithHash);
      this.lastContentHash = newContentHash;
      this.server.emit('ADMINS_UPDATED');
      await this.backupFileToDiscord(contentWithHash, newContentHash);
    }
    this.temporaryReserves = activeGrants;
  }

  async writeAtomicFile(filePath, content) {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    let mode = 0o666 & ~process.umask();
    try {
      mode = (await fsPromises.stat(filePath)).mode & 0o777;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temporaryPath = `${filePath}.tmp`;
    try {
      await fsPromises.writeFile(temporaryPath, content, {
        encoding: 'utf8',
        mode
      });
      await fsPromises.chmod(temporaryPath, mode);
      await fsPromises.rename(temporaryPath, filePath);
    } finally {
      await fsPromises.rm(temporaryPath, { force: true });
    }
  }

  async updateAdminsFile(content) {
    const filePath = this.options.adminsFilePath;

    try {
      await this.writeAtomicFile(filePath, content);

      const mode = this.options.beautifyOutput ? 'beautified' : 'raw';
      this.verbose(
        1,
        `Updated Admins.cfg with ${content.length} characters of ${mode} admin data.`
      );
    } catch (error) {
      this.verbose(1, `Error updating admin file: ${error.message}`);
      throw error;
    }
  }

  beautifyAdminData(rawContent) {
    const lines = rawContent.trim().split('\n');
    const groups = new Map();
    const admins = new Map();

    // Parse groups and admins
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('//')) continue;

      if (trimmedLine.startsWith('Group=')) {
        const match = trimmedLine.match(/^Group=([^:]+):(.*?)\s*(?:\/\/.*)?$/);
        if (match) {
          const [, groupName, permissions] = match;
          groups.set(groupName, permissions);
        }
      } else if (trimmedLine.startsWith('Admin=')) {
        const match = trimmedLine.match(/^Admin=([^:]+):([^\s]+)(.*)$/);
        if (match) {
          const [, id, groupName, comment] = match;
          const isEOS = /^[0-9a-f]{32}$/.test(id);
          const isSteam = id.startsWith('76561');

          if (!admins.has(groupName)) {
            admins.set(groupName, []);
          }

          admins.get(groupName).push({
            id,
            isEOS,
            isSteam,
            comment: comment.trim(),
            original: trimmedLine
          });
        }
      }
    }

    // Calculate statistics
    let totalAdmins = 0;
    let totalEOS = 0;
    let totalSteam = 0;
    const totalGroups = groups.size;

    for (const groupAdmins of admins.values()) {
      totalAdmins += groupAdmins.length;
      totalEOS += groupAdmins.filter((admin) => admin.isEOS).length;
      totalSteam += groupAdmins.filter((admin) => admin.isSteam).length;
    }

    // Generate beautified output
    const output = [];

    // Header with statistics
    output.push('//=============================================================================');
    output.push('// Squad Server Admin Configuration File');
    output.push('// Auto-beautified and organized by AdminSync plugin');
    output.push('//=============================================================================');
    output.push('//');
    output.push(`// Total Statistics:`);
    output.push(`//   - Groups: ${totalGroups}`);
    output.push(`//   - Total Admins: ${totalAdmins}`);
    output.push(`//   - EOS IDs: ${totalEOS}`);
    output.push(`//   - Steam IDs: ${totalSteam}`);
    output.push(`//   - Last Sync: ${new Date().toISOString()}`);
    output.push('//');
    output.push('//=============================================================================');
    output.push('// GROUP DEFINITIONS');
    output.push('//=============================================================================');
    output.push('');

    // Sort groups by category
    const adminGroups = [];
    const clanGroups = [];
    const specialGroups = [];

    for (const [groupName, permissions] of groups) {
      if (groupName.startsWith('Admin')) {
        adminGroups.push([groupName, permissions]);
      } else if (groupName.startsWith('Clan')) {
        clanGroups.push([groupName, permissions]);
      } else {
        specialGroups.push([groupName, permissions]);
      }
    }

    // Output admin groups
    if (adminGroups.length > 0) {
      output.push('// Administrative Groups');
      for (const [groupName, permissions] of adminGroups.sort()) {
        const count = admins.get(groupName)?.length || 0;
        // Squad may not strip a trailing comment from a Group line, so the count goes on its own line.
        output.push(`// ${groupName}: ${count} members`, `Group=${groupName}:${permissions}`);
      }
      output.push('');
    }

    // Output special groups
    if (specialGroups.length > 0) {
      output.push('// Special Groups');
      for (const [groupName, permissions] of specialGroups.sort()) {
        const count = admins.get(groupName)?.length || 0;
        output.push(`// ${groupName}: ${count} members`, `Group=${groupName}:${permissions}`);
      }
      output.push('');
    }

    // Output clan groups
    if (clanGroups.length > 0) {
      output.push('// Clan Groups');
      for (const [groupName, permissions] of clanGroups.sort()) {
        const count = admins.get(groupName)?.length || 0;
        output.push(`// ${groupName}: ${count} members`, `Group=${groupName}:${permissions}`);
      }
      output.push('');
    }

    output.push('//=============================================================================');
    output.push('// ADMIN ASSIGNMENTS');
    output.push('//=============================================================================');
    output.push('');

    // Sort admin groups for output
    const sortedAdminGroups = Array.from(admins.keys()).sort((a, b) => {
      // Prioritize admin groups, then special, then clans
      const aIsAdmin = a.startsWith('Admin');
      const bIsAdmin = b.startsWith('Admin');
      const aIsClan = a.startsWith('Clan');
      const bIsClan = b.startsWith('Clan');

      if (aIsAdmin && !bIsAdmin) return -1;
      if (!aIsAdmin && bIsAdmin) return 1;
      if (!aIsClan && bIsClan) return -1;
      if (aIsClan && !bIsClan) return 1;

      return a.localeCompare(b);
    });

    // Output admin assignments by group
    for (const groupName of sortedAdminGroups) {
      const groupAdmins = admins.get(groupName);
      if (!groupAdmins || groupAdmins.length === 0) continue;

      const eosCount = groupAdmins.filter((admin) => admin.isEOS).length;
      const steamCount = groupAdmins.filter((admin) => admin.isSteam).length;

      output.push(
        `//-----------------------------------------------------------------------------`
      );
      output.push(
        `// ${groupName} (${groupAdmins.length} members: ${eosCount} EOS, ${steamCount} Steam)`
      );
      output.push(
        `//-----------------------------------------------------------------------------`
      );

      // Sort admins within group (EOS first, then Steam, then alphabetically)
      const sortedAdmins = [...groupAdmins].sort((a, b) => {
        if (a.isEOS && !b.isEOS) return -1;
        if (!a.isEOS && b.isEOS) return 1;
        return a.original.localeCompare(b.original);
      });

      for (const admin of sortedAdmins) {
        output.push(admin.original);
      }
      output.push('');
    }

    output.push('//=============================================================================');
    output.push('// End of Configuration');
    output.push('//=============================================================================');

    return output.join('\n');
  }

  /**
   * Computes an MD5 hash of the permissions each admin ID gets from the given content.
   * Comments and group names are not part of the hash: the Whitelister output has a
   * "Last update" comment and a randomly named group that change on every fetch.
   * @param {string} content - The admin data content
   * @returns {string} The MD5 hash in hex format
   */
  computeContentHash(content) {
    const groups = new Map();
    const adminGroups = new Map();
    for (const line of content.split('\n')) {
      const withoutComment = line.replace(/\/\/.*$/, '').trim();
      const groupMatch = withoutComment.match(/^Group=([^:]+):(.*)$/);
      if (groupMatch) {
        const permissions = groupMatch[2].split(',').map((permission) => permission.trim());
        groups.set(groupMatch[1].trim(), permissions.filter(Boolean));
        continue;
      }
      const adminMatch = withoutComment.match(/^Admin=([^:]+):(\S+)$/);
      if (adminMatch) {
        const groupNames = adminGroups.get(adminMatch[1]) || [];
        groupNames.push(adminMatch[2]);
        adminGroups.set(adminMatch[1], groupNames);
      }
    }
    const canonicalLines = [...adminGroups]
      .map(([id, groupNames]) => {
        const permissions = new Set();
        for (const groupName of groupNames) {
          const groupPermissions = groups.get(groupName) || [`undefined-group:${groupName}`];
          groupPermissions.forEach((permission) => permissions.add(permission));
        }
        return `${id}:${[...permissions].sort().join(',')}`;
      })
      .sort();
    return crypto.createHash('md5').update(canonicalLines.join('\n'), 'utf8').digest('hex');
  }

  /**
   * Extracts the content hash from an existing Admins.cfg file.
   * @returns {Promise<string|null>} The extracted hash or null if not found
   */
  async extractHashFromFile() {
    try {
      const content = await fsPromises.readFile(this.options.adminsFilePath, 'utf8');
      const match = content.match(/^\/\/ ContentHash: ([a-f0-9]{32})/m);
      return match ? match[1] : null;
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.verbose(2, 'Admins.cfg does not exist yet, no hash to extract.');
      } else {
        this.verbose(2, `Could not read existing file for hash: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Prepends the content hash comment to the output content.
   * @param {string} content - The admin data content
   * @param {string} hash - The content hash
   * @returns {string} Content with hash comment prepended
   */
  prependHashComment(content, hash) {
    const hashComment = `// ContentHash: ${hash}\n`;
    return hashComment + content;
  }

  async fetchAdminDataFromUrls(urls) {
    const axiosConfig = {
      timeout: 30000,
      headers: {
        'User-Agent': 'SquadJS-AdminSync/1.0',
        Accept: 'text/plain, */*'
      }
    };

    const fetchPromises = urls.map(async (url) => {
      if (!url) return '';

      try {
        this.verbose(2, `Fetching admin data from: ${url}`);

        // Add cache busting parameter
        const separator = url.includes('?') ? '&' : '?';
        const cacheBuster = `${separator}t=${Date.now()}`;

        const response = await axios.get(`${url}${cacheBuster}`, axiosConfig);

        if (typeof response.data !== 'string' || !/^\s*(Group|Admin)=/m.test(response.data)) {
          this.verbose(2, `No data received from whitelist URL: ${url}`);
          return '';
        }

        this.verbose(2, `Fetched ${response.data.length} characters from: ${url}`);
        return response.data;
      } catch (error) {
        this.verbose(1, `Error fetching from ${url}: ${error.message}`);
        if (error.code === 'ECONNABORTED') {
          this.verbose(2, `Request timeout for ${url}`);
        } else if (error.response) {
          this.verbose(2, `HTTP ${error.response.status} for ${url}`);
        } else if (error.request) {
          this.verbose(2, `Network error for ${url}`);
        }
        return '';
      }
    });

    const results = await Promise.allSettled(fetchPromises);

    let combinedContent = '';
    let successCount = 0;

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        if (combinedContent && !combinedContent.endsWith('\n')) {
          combinedContent += '\n';
        }
        combinedContent += result.value;
        successCount++;
      }
    }

    this.verbose(2, `Successfully fetched data from ${successCount}/${urls.length} URLs`);

    if (successCount !== urls.length || successCount === 0) {
      throw new Error('Failed to fetch valid data from every whitelist URL');
    }

    return combinedContent;
  }

  /**
   * Compresses content using gzip and returns the buffer.
   * @param {string} content - The content to compress
   * @returns {Promise<Buffer>} The compressed buffer
   */
  gzipContent(content) {
    return new Promise((resolve, reject) => {
      const gzip = createGzip();
      const chunks = [];

      gzip.on('data', (chunk) => chunks.push(chunk));
      gzip.on('end', () => resolve(Buffer.concat(chunks)));
      gzip.on('error', (error) => reject(error));

      gzip.write(content);
      gzip.end();
    });
  }

  /**
   * Backs up the Admins.cfg file to Discord.
   * @param {string} content - The file content to backup
   * @param {string} hash - The content hash for reference
   */
  async backupFileToDiscord(content, hash) {
    if (!this.options.backupToDiscord || !this.backupChannel) {
      return;
    }

    try {
      this.verbose(2, 'Backing up Admins.cfg to Discord...');

      const buffer = await this.gzipContent(content);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fileName = `Admins_${this.server.serverName}_${timestamp}.cfg.gz`
        .replace(/[^a-z\d\s._-]/gi, '')
        .split(/\s/)
        .filter((part) => part !== '')
        .join('_');

      // Send embed with metadata
      await this.backupChannel.send({
        embeds: [
          {
            title: 'Admins.cfg Backup',
            description: `Admin configuration backup for **${this.server.serverName}**`,
            color: 0x00ff00,
            fields: [
              {
                name: 'Content Hash',
                value: `\`${hash}\``,
                inline: true
              },
              {
                name: 'File Size',
                value: `${content.length} bytes (${buffer.length} bytes compressed)`,
                inline: true
              }
            ],
            timestamp: new Date().toISOString(),
            footer: {
              text: 'AdminSync Plugin'
            }
          }
        ]
      });

      // Send the file attachment
      await this.backupChannel.send({
        files: [new AttachmentBuilder(buffer, { name: fileName })]
      });

      this.verbose(1, `Successfully backed up Admins.cfg to Discord (${fileName})`);
    } catch (error) {
      this.verbose(1, `Failed to backup Admins.cfg to Discord: ${error.message}`);
      this.verbose(2, `${error.stack}`);
    }
  }
}
