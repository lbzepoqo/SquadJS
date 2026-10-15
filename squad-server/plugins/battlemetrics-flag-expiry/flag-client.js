import axios from 'axios';

const API_BASE_URL = 'https://api.battlemetrics.com';
const REQUEST_TIMEOUT_MS = 15 * 1000;
const MAX_ATTEMPTS = 3;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Reads and removes player flags through the BattleMetrics API.
export default class BattleMetricsFlagClient {
  constructor(token, { httpClient = axios, baseURL = API_BASE_URL } = {}) {
    this.token = token;
    this.httpClient = httpClient;
    this.baseURL = baseURL;
  }

  // Returns { id: name } for the organization's flag definitions.
  async getFlagNames() {
    const response = await this.request('get', `${this.baseURL}/player-flags?page[size]=100`);
    return Object.fromEntries(
      (response.data.data ?? []).map((flag) => [flag.id, flag.attributes?.name ?? flag.id])
    );
  }

  // Returns one entry per active flagPlayer record of flagID: { playerID, playerName, flagID, addedAt }.
  async listActiveFlags(flagID) {
    const entries = [];
    let url = `${this.baseURL}/players?filter[playerFlags]=${flagID}&include=flagPlayer&page[size]=100`;

    while (url) {
      const { data: body } = await this.request('get', url);
      const playerNames = new Map(
        (body.data ?? []).map((player) => [player.id, player.attributes?.name])
      );

      // include=flagPlayer returns every flag the listed players hold, not only flagID.
      for (const record of body.included ?? []) {
        if (record.type !== 'flagPlayer') continue;
        if (record.relationships?.playerFlag?.data?.id !== flagID) continue;
        if (record.attributes?.removedAt) continue;

        const playerID = record.relationships?.player?.data?.id;
        if (!playerID) continue;

        entries.push({
          playerID,
          playerName: playerNames.get(playerID) ?? playerID,
          flagID,
          addedAt: record.attributes.addedAt
        });
      }

      url = body.links?.next ?? null;
    }

    return entries;
  }

  async removeFlag(playerID, flagID) {
    await this.request(
      'delete',
      `${this.baseURL}/players/${playerID}/relationships/flags/${flagID}`
    );
  }

  // Retries after a 429 response, waiting for Retry-After (seconds) or 60 seconds.
  async request(method, url) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.httpClient.request({
          method,
          url,
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
          timeout: REQUEST_TIMEOUT_MS
        });
      } catch (error) {
        if (error.response?.status !== 429 || attempt >= MAX_ATTEMPTS) throw error;
        const retryAfterSeconds = Number(error.response.headers?.['retry-after']) || 60;
        await sleep(retryAfterSeconds * 1000);
      }
    }
  }
}
