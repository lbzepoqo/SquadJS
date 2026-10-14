import axios from 'axios';

const REQUEST_TIMEOUT_MS = 10 * 1000;

// Posts a message through a Discord webhook and edits the same message on later calls.
// A webhook can only post to its own channel and cannot read messages, so nothing on the
// Discord side can send commands to SquadJS through it.
export default class StatusWebhook {
  constructor(webhookURL, httpClient = axios) {
    this.url = new URL(webhookURL);
    this.httpClient = httpClient;

    // Path is /api/webhooks/<id>/<token>, optionally with a version such as /api/v10/webhooks/....
    // Extra segments such as /slack or /github select endpoints that do not return a message ID.
    const pathMatch = this.url.pathname.match(/^\/api(?:\/v\d+)?\/webhooks\/(\d+)\/[\w-]+\/?$/);
    if (!pathMatch)
      throw new Error(
        'The webhook URL must have the form https://discord.com/api/webhooks/<id>/<token>.'
      );

    // One status message per webhook and thread. The token is not part of the key, so it is
    // never written to the database.
    const threadID = this.url.searchParams.get('thread_id');
    this.storageKey = threadID ? `${pathMatch[1]}:${threadID}` : pathMatch[1];
  }

  // Edits the message with messageID, or posts a new message when there is no messageID or
  // the message was deleted. Returns the ID of the message that holds the payload.
  async publish(payload, messageID) {
    if (messageID) {
      try {
        await this.httpClient.patch(this.messageURL(messageID), payload, {
          timeout: REQUEST_TIMEOUT_MS
        });
        return messageID;
      } catch (error) {
        if (error.response?.status !== 404) throw error;
      }
    }

    const postURL = new URL(this.url);
    postURL.searchParams.set('wait', 'true');
    const response = await this.httpClient.post(postURL.toString(), payload, {
      timeout: REQUEST_TIMEOUT_MS
    });
    if (!response.data?.id) throw new Error('The webhook did not return a message ID.');
    return response.data.id;
  }

  messageURL(messageID) {
    // Keeps query parameters such as thread_id, which the edit endpoint also needs.
    const messageURL = new URL(this.url);
    messageURL.pathname = `${messageURL.pathname.replace(/\/$/, '')}/messages/${messageID}`;
    return messageURL.toString();
  }
}
