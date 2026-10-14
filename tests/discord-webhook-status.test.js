import assert from 'assert';
import http from 'http';
import { after, before, beforeEach, describe, it } from 'node:test';

import StatusWebhook from '../squad-server/plugins/discord-webhook-server-status/status-webhook.js';

// Minimal stand-in for the two Discord webhook endpoints the plugin uses.
const requests = [];
const existingMessages = new Set();
let nextMessageID = 1000;

const fakeDiscord = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    requests.push({ method: request.method, url: request.url, body: JSON.parse(body) });
    const editMatch = request.url.match(/\/messages\/(\d+)/);

    if (request.method === 'PATCH' && editMatch && !existingMessages.has(editMatch[1])) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: 'Unknown Message', code: 10008 }));
      return;
    }

    let messageID = editMatch?.[1];
    if (request.method === 'POST') {
      messageID = String(nextMessageID++);
      existingMessages.add(messageID);
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: messageID }));
  });
});

let baseURL;

before(async () => {
  await new Promise((resolve) => fakeDiscord.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${fakeDiscord.address().port}/api/webhooks/123/token`;
});

after(() => fakeDiscord.close());

beforeEach(() => {
  requests.length = 0;
});

describe('StatusWebhook', () => {
  it('posts a new message when there is no message ID yet', async () => {
    const webhook = new StatusWebhook(baseURL);
    const messageID = await webhook.publish({ content: 'status' });

    assert.strictEqual(webhook.storageKey, '123');
    assert.ok(existingMessages.has(messageID));
    assert.deepStrictEqual(
      requests.map((request) => `${request.method} ${request.url}`),
      ['POST /api/webhooks/123/token?wait=true']
    );
  });

  it('edits the existing message and keeps thread_id', async () => {
    const webhook = new StatusWebhook(`${baseURL}?thread_id=55`);
    assert.strictEqual(webhook.storageKey, '123:55');
    const messageID = await webhook.publish({ content: 'first' });
    const editedID = await webhook.publish({ content: 'second' }, messageID);

    assert.strictEqual(editedID, messageID);
    assert.deepStrictEqual(
      requests.map((request) => `${request.method} ${request.url}`),
      [
        'POST /api/webhooks/123/token?thread_id=55&wait=true',
        `PATCH /api/webhooks/123/token/messages/${messageID}?thread_id=55`
      ]
    );
    assert.strictEqual(requests[1].body.content, 'second');
  });

  it('posts a new message when the old one was deleted', async () => {
    const webhook = new StatusWebhook(baseURL);
    const messageID = await webhook.publish({ content: 'status' }, '999');

    assert.notStrictEqual(messageID, '999');
    assert.deepStrictEqual(
      requests.map((request) => request.method),
      ['PATCH', 'POST']
    );
  });

  it('rejects a URL that is not a webhook URL', () => {
    assert.throws(() => new StatusWebhook('https://discord.com/channels/1/2'));
    assert.throws(() => new StatusWebhook('https://discord.com/api/webhooks/1/token/slack'));
  });
});
