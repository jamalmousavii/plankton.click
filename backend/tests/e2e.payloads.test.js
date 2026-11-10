// 1.1.15: E2E workers silently lost the conversation window and attachments.
// encrypt() returns an object, but workers only decrypted `history` /
// `attachment` when they were strings, so the model never saw earlier turns
// ("There is no previous message.") and images arrived as ciphertext.
// These run the real server dispatch into the real worker handler.
jest.mock('ws', () => { const E = require('events'); class W extends E { constructor() { super(); this.readyState = 1; } send() {} close() {} } W.OPEN = 1; return W; });
const WSServer = require('../src/ws');
const { deriveKey } = require('../src/services/e2e');
const WorkerWebSocket = require('../../worker-app/src/services/websocket');

const TOKEN = 'pw_' + 'ab'.repeat(16);
const HISTORY = [
  { role: 'user', content: 'Give me a secret word.' },
  { role: 'assistant', content: 'The secret word is ZEBRA-77.' },
];

function makeServer(worker) {
  const ws = Object.create(WSServer.prototype);
  ws.workers = new Map([[1, { id: 1, status: 'online', models: [], modelHealth: {}, weight: 1, ...worker }]]);
  ws.taskCallbacks = new Map();
  return ws;
}

// Dispatch on the server, deliver the exact wire message to a worker.
async function roundTrip({ protocol, e2e = true, media = null, history = HISTORY }) {
  const sent = [];
  const ws = makeServer({
    protocol,
    e2eKey: e2e ? deriveKey(TOKEN) : undefined,
    ws: { readyState: 1, send: (s) => sent.push(JSON.parse(s)) },
  });
  const pending = ws.dispatchTask(1, 7, 'What was the secret word?', 'llama3.1:8b', media, history);
  let got = null;
  const worker = new WorkerWebSocket(TOKEN, async (prompt, model, m, h) => {
    got = { prompt, media: m, history: h };
    return { response: 'ok', eval_count: 1 };
  });
  worker.authed = true;
  worker.e2eEnabled = e2e;
  worker.sendResult = () => {};
  await worker.handleTask(sent[0]);
  const cb = ws.taskCallbacks.get(7);
  clearTimeout(cb.timeout);
  cb.resolve({ response: 'ok' });
  await pending;
  return { got, wire: sent[0] };
}

describe('E2E task payloads reach the model', () => {
  test('protocol-4 worker decrypts the encrypted history', async () => {
    const { got, wire } = await roundTrip({ protocol: 4 });
    expect(wire.history).toHaveProperty('iv'); // still encrypted on the wire
    expect(got.history).toEqual(HISTORY);
    expect(got.prompt).toBe('What was the secret word?');
  });

  test('older E2E workers get the window folded into the (encrypted) prompt', async () => {
    const { got, wire } = await roundTrip({ protocol: 3 });
    expect(wire.history).toBeUndefined();
    expect(wire.prompt).toHaveProperty('iv');
    expect(got.history).toEqual([]);
    expect(got.prompt).toContain('Assistant: The secret word is ZEBRA-77.');
    expect(got.prompt.endsWith('What was the secret word?')).toBe(true);
  });

  test('plaintext (no E2E) workers keep the history field', async () => {
    const { got, wire } = await roundTrip({ protocol: 3, e2e: false });
    expect(wire.history).toEqual(HISTORY);
    expect(got.history).toEqual(HISTORY);
  });

  test('protocol-4 worker decrypts the attachment', async () => {
    const media = { type: 'image', name: 'a.png', mime: 'image/png', data: 'iVBORw0KGgo=' };
    const { got } = await roundTrip({ protocol: 4, media, history: [] });
    expect(got.media).toEqual(media);
  });

  test('worker advertises protocol 4', () => {
    const w = new WorkerWebSocket(TOKEN, async () => ({}), async () => ({}));
    const sent = [];
    w.send = (m) => sent.push(m);
    w.authenticate();
    expect(sent[0].protocol).toBe(WSServer.E2E_PAYLOAD_PROTOCOL);
  });
});
