import axios from 'axios';

const REQUEST_TIMEOUT_MS = 10000;

/**
 * Finds the steamID linked to a Discord user: Squad Whitelister first, then MySquadStats.
 * Results are cached for `cacheMs`, since the Whitelister allows 50 requests per minute.
 */
export default class LinkResolver {
  constructor({
    whitelisterApiUrl,
    whitelisterApiKey,
    useMySquadStats = true,
    cacheMs = 300000,
    log
  }) {
    this.whitelisterApiUrl = whitelisterApiUrl?.replace(/\/+$/, '');
    this.whitelisterApiKey = whitelisterApiKey;
    this.useMySquadStats = useMySquadStats;
    this.cacheMs = cacheMs;
    this.log = log ?? (() => {});
    this.cache = new Map();
  }

  /** Returns { steamID, source } or null when no linked account is found. */
  async resolve(discordUserID) {
    const cached = this.cache.get(discordUserID);
    if (cached && cached.expires > Date.now()) return cached.link;

    const link =
      (await this.fromWhitelister(discordUserID)) ?? (await this.fromMySquadStats(discordUserID));
    this.cache.set(discordUserID, { link, expires: Date.now() + this.cacheMs });
    return link;
  }

  async fromWhitelister(discordUserID) {
    if (!this.whitelisterApiUrl || !this.whitelisterApiKey) return null;
    try {
      const response = await axios.get(
        `${this.whitelisterApiUrl}/api/players/read/from/discordUserId/${encodeURIComponent(
          discordUserID
        )}`,
        { params: { apiKey: this.whitelisterApiKey }, timeout: REQUEST_TIMEOUT_MS }
      );
      // A rejected key gets the login page with status 200 instead of an error.
      if (typeof response.data === 'string' && response.data.trimStart().startsWith('<')) {
        this.log('Whitelister returned its login page: check whitelisterApiKey.');
        return null;
      }
      // An unknown user is an empty body. The Discord role sync also creates documents
      // that hold only the Discord ID, so a document without steamid64 is not a link.
      const steamID = response.data?.steamid64;
      return steamID ? { steamID, source: 'Whitelister' } : null;
    } catch (error) {
      this.log(`Whitelister lookup failed for Discord user ${discordUserID}: ${error.message}`);
      return null;
    }
  }

  async fromMySquadStats(discordUserID) {
    if (!this.useMySquadStats) return null;
    try {
      const response = await axios.get('https://api.mysquadstats.com/playerLink', {
        params: { discordID: discordUserID },
        timeout: REQUEST_TIMEOUT_MS
      });
      const steamID = response.data?.status === 'Success' ? response.data.data?.steamID : null;
      return steamID ? { steamID, source: 'MySquadStats' } : null;
    } catch (error) {
      this.log(`MySquadStats lookup failed for Discord user ${discordUserID}: ${error.message}`);
      return null;
    }
  }
}
