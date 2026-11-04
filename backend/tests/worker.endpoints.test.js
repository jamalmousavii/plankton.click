// 1.1.11: workers prefer the direct origin endpoint (ws.plankton.click,
// DNS-only) and fall back to the Cloudflare-proxied one.
jest.mock('ws', () => {
  const { EventEmitter } = require('events');
  class FakeWS extends EventEmitter {
    constructor(url, opts) { super(); this.url = url; this.opts = opts; this.readyState = 0; FakeWS.instances.push(this); }
    send() {}
    close() { this.readyState = 3; }
  }
  FakeWS.instances = [];
  FakeWS.OPEN = 1; FakeWS.CONNECTING = 0; FakeWS.CLOSED = 3;
  return FakeWS;
});
const FakeWS = require('ws');
const WorkerWebSocket = require('../../worker-app/src/services/websocket');

beforeEach(() => { FakeWS.instances.length = 0; delete process.env.API_WS_URL; jest.useFakeTimers(); });
afterEach(() => jest.useRealTimers());

const last = () => FakeWS.instances[FakeWS.instances.length - 1];

it('tries the direct endpoint first with a matching TLS servername', () => {
  const w = new WorkerWebSocket('pw_deadbeef', async () => ({}));
  w.connect();
  expect(last().url).toBe('wss://ws.plankton.click/ws');
  expect(last().opts.servername).toBe('ws.plankton.click');
  expect(last().opts.handshakeTimeout).toBe(15000);
});

it('falls back to Cloudflare within ~1 s when the direct endpoint fails', () => {
  const w = new WorkerWebSocket('pw_deadbeef', async () => ({}));
  w.connect();
  last().emit('error', new Error('getaddrinfo ENOTFOUND ws.plankton.click'));
  last().emit('close', 1006, Buffer.from(''));
  jest.advanceTimersByTime(1000);
  expect(last().url).toBe('wss://plankton.click:443/ws');
  expect(last().opts.servername).toBe('plankton.click');
});

it('returns to the direct endpoint after a session that worked', () => {
  const w = new WorkerWebSocket('pw_deadbeef', async () => ({}));
  w.connect();
  last().emit('close', 1006, Buffer.from(''));      // direct failed
  jest.advanceTimersByTime(1000);                     // → cloudflare
  const cf = last();
  cf.readyState = 1; cf.emit('open');
  w.handleMessage({ type: 'auth_ok', worker_id: 7 }); // good session on cloudflare
  cf.readyState = 3; cf.emit('close', 1006, Buffer.from(''));
  jest.advanceTimersByTime(5000);
  expect(last().url).toBe('wss://ws.plankton.click/ws');
  w.disconnect();
});

it('backs off once every endpoint failed in a row', () => {
  const w = new WorkerWebSocket('pw_deadbeef', async () => ({}));
  w.connect();
  last().emit('close', 1006, Buffer.from(''));
  jest.advanceTimersByTime(1000);
  last().emit('close', 1006, Buffer.from(''));      // both failed
  const count = FakeWS.instances.length;
  jest.advanceTimersByTime(1000);
  expect(FakeWS.instances.length).toBe(count);        // no fast retry
  jest.advanceTimersByTime(5000);
  expect(last().url).toBe('wss://ws.plankton.click/ws');
  w.disconnect();
});

it('API_WS_URL still overrides the list', () => {
  process.env.API_WS_URL = 'ws://127.0.0.1:8444/ws';
  const w = new WorkerWebSocket('pw_deadbeef', async () => ({}));
  w.connect();
  expect(last().url).toBe('ws://127.0.0.1:8444/ws');
  w.disconnect();
});
