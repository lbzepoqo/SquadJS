import BasePlugin from './base-plugin.js';
import fs, { promises as fsPromises } from 'fs';
import axios from 'axios';

export default class BansCfgCleaner extends BasePlugin {
  static get description() {
    return (
      'The <code>BansCfgCleaner</code> plugin automatically clears entries from <code>Bans.cfg</code> ' +
      'and reloads the server configuration when entries are detected. ' +
      'Designed for servers that use BattleMetrics exclusively for banning — any native ban entry is unintended.'
    );
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      bansCfgPath: {
        required: true,
        description: 'Absolute path to the Bans.cfg file.',
        default: '',
        example: '/home/container/SquadGame/ServerConfig/Bans.cfg'
      },
      webhookUrl: {
        required: false,
        description:
          'Discord-compatible webhook URL for notifications when entries are cleared. Leave empty to disable.',
        default: '',
        example: 'https://discord.com/api/webhooks/123/abc'
      },
      debounceDelay: {
        required: false,
        description:
          'Milliseconds to wait after a file change event before acting. Absorbs double-fire quirks from fs.watch().',
        default: 500,
        example: 500
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);
    this.fileWatcher = null;
    this.debounceTimer = null;
    this.processing = false;
    this.processBansFile = this.processBansFile.bind(this);
    this.onFileChange = this.onFileChange.bind(this);
  }

  async mount() {
    this.verbose(1, `Watching Bans.cfg at: ${this.options.bansCfgPath}`);
    await this.processBansFile();

    try {
      this.fileWatcher = fs.watch(this.options.bansCfgPath, this.onFileChange);
      this.fileWatcher.on('error', (error) => {
        this.verbose(1, `File watcher error: ${error.message}`);
      });
      this.verbose(1, 'File watcher attached.');
    } catch (error) {
      this.verbose(
        1,
        `Could not watch ${this.options.bansCfgPath}: ${error.message}. Bans.cfg must exist at startup for live watching to work.`
      );
    }
  }

  async unmount() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
  }

  async processBansFile() {
    if (this.processing) return;
    this.processing = true;

    try {
      await this.processBansFileInner();
    } finally {
      this.processing = false;
    }
  }

  async processBansFileInner() {
    let content;
    try {
      content = await fsPromises.readFile(this.options.bansCfgPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.verbose(1, `Bans.cfg not found at ${this.options.bansCfgPath}. Skipping.`);
      } else {
        this.verbose(1, `Error reading Bans.cfg: ${error.message}`);
      }
      return;
    }

    const banEntries = readBanEntries(content);
    if (banEntries.length === 0) return;

    this.verbose(
      1,
      `Detected ${banEntries.length} ban entr${
        banEntries.length === 1 ? 'y' : 'ies'
      } in Bans.cfg. Clearing...`
    );

    try {
      await fsPromises.writeFile(this.options.bansCfgPath, '', 'utf8');
      this.verbose(1, 'Bans.cfg cleared.');
    } catch (writeError) {
      this.verbose(1, `Failed to clear Bans.cfg: ${writeError.message}`);
      return;
    }

    try {
      await this.server.rcon.execute('AdminReloadServerConfig');
      this.verbose(1, 'AdminReloadServerConfig executed successfully.');
    } catch (rconError) {
      this.verbose(1, `AdminReloadServerConfig failed: ${rconError.message}`);
    }

    if (this.options.webhookUrl) {
      await this.sendWebhookNotification(banEntries);
    }
  }

  async sendWebhookNotification(banEntries) {
    try {
      await axios.post(this.options.webhookUrl, {
        embeds: [
          {
            title: 'Bans.cfg auto-cleared',
            description: `${banEntries.length} ban entr${
              banEntries.length === 1 ? 'y' : 'ies'
            } detected and removed. Server config reloaded.`,
            color: 16776960,
            fields: [
              {
                name: 'Removed entries',
                value: truncateAtNewline(banEntries.join('\n'), 1024),
                inline: false
              }
            ],
            footer: { text: 'BansCfgCleaner' },
            timestamp: new Date().toISOString()
          }
        ]
      });
      this.verbose(2, 'Webhook notification sent.');
    } catch (error) {
      this.verbose(1, `Webhook notification failed: ${error.message}`);
    }
  }

  onFileChange() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(this.processBansFile, this.options.debounceDelay);
  }
}

function readBanEntries(content) {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'));
}

function truncateAtNewline(text, limit) {
  if (text.length <= limit) return text;
  const ellipsis = '\n…';
  const truncated = text.slice(0, limit - ellipsis.length).replace(/\n[^\n]*$/, '');
  return truncated + ellipsis;
}
