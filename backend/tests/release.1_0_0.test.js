// 1.0.0 relaunch regressions: capability negotiation survives the version
// reset, worker heartbeats are whitelisted/clamped, and deleting a paid chat
// session keeps the money trail instead of failing on the earnings FK.

jest.mock('../src/database/pool', () => {
  const state = { statements: [], params: [], queryImpl: async () => ({ rows: [] }) };
  const query = (sql, params) => {
    state.statements.push(String(sql).trim().replace(/\s+/g, ' '));
    state.params.push(params);
    return state.queryImpl(sql, params);
  };
  return {
    __state: state,
    query,
    connect: async () => ({ query, release: () => {} }),
  };
});

const WSServer = require('../src/ws');
const pool = require('../src/database/pool');

beforeEach(() => {
  pool.__state.statements.length = 0;
  pool.__state.params.length = 0;
  pool.__state.queryImpl = async () => ({ rows: [] });
});

describe('capability negotiation after the 1.0.0 version reset', () => {
  const { workerSupportsHistory } = WSServer;

  it('treats a protocol-2 worker as fully capable whatever its app version', () => {
    expect(workerSupportsHistory('1.0.0', 2)).toBe(true);
  });

  it('does not trust a bare 1.x version without the protocol field', () => {
    expect(workerSupportsHistory('1.0.0')).toBe(false);
  });

  it('keeps the legacy semver gate for pre-1.0 binaries', () => {
    expect(workerSupportsHistory('3.41.0')).toBe(true);
    expect(workerSupportsHistory('3.40.9')).toBe(false);
  });

  it('routes media + history tasks to a protocol-2 worker', () => {
    const ws = Object.create(WSServer.prototype);
    ws.workers = new Map([[1, {
      id: 1, status: 'online', app_version: '1.0.0', protocol: 2,
      models: ['llama3.1:8b'], modelHealth: {},
    }]]);
    expect(ws.findWorkersForModel('llama3.1:8b', true, true)).toHaveLength(1);
  });
});

describe('WS heartbeat hardening', () => {
  function makeServer() {
    const ws = Object.create(WSServer.prototype);
    ws.workers = new Map();
    const socket = { send: jest.fn() };
    ws.workers.set(3, { id: 3, ws: socket, models: [], modelHealth: {}, status: 'online' });
    return { ws, socket };
  }

  it('never lets a worker mark itself removed and clamps usage to 0-100', async () => {
    const { ws, socket } = makeServer();
    await ws.handleHeartbeat(socket, {
      type: 'heartbeat', status: 'removed', gpu_usage: 1e9, cpu_usage: -5, ram_usage: 'x',
      current_model: 'm'.repeat(500),
    });
    const idx = pool.__state.statements.findIndex((s) => s.startsWith('UPDATE workers SET status = $1'));
    expect(idx).toBeGreaterThanOrEqual(0);
    const [status, , model, gpu, ram, cpu] = pool.__state.params[idx];
    expect(status).toBe('online');
    expect(model).toHaveLength(50);
    expect(gpu).toBe(100);
    expect(ram).toBe(0);
    expect(cpu).toBe(0);
    expect(ws.workers.get(3).status).toBe('online');
  });
});

describe('chat session delete', () => {
  const express = require('express');
  const request = require('supertest');
  const jwt = require('jsonwebtoken');

  it('detaches and wipes tasks instead of deleting rows referenced by earnings', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/chat', require('../src/routes/chat'));
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes('token_version')) return { rows: [{ token_version: 0, banned: false }] };
      if (String(sql).includes('SELECT * FROM chat_sessions')) return { rows: [{ id: 12, user_id: 4 }] };
      return { rows: [] };
    };
    const token = jwt.sign({ id: 4, token_version: 0 }, process.env.JWT_SECRET, { algorithm: 'HS256' });

    const res = await request(app).delete('/api/chat/sessions/12').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const joined = pool.__state.statements.join('\n');
    expect(joined).not.toMatch(/DELETE FROM tasks/);
    expect(joined).toMatch(/UPDATE tasks SET session_id = NULL, prompt = ''/);
    expect(joined).toMatch(/DELETE FROM chat_sessions/);
  });
});

describe('pre-1.0 worker compatibility', () => {
  const { deriveKey } = require('../src/services/e2e');
  const crypto = require('crypto');

  it('derives kz_ keys with the original salt so installed workers can decrypt', () => {
    const token = 'kz_' + 'a'.repeat(64);
    const legacy = Buffer.from(crypto.hkdfSync('sha256', token, Buffer.from('krelz-e2e-v1'), Buffer.from('task-payload'), 32));
    expect(deriveKey(token).equals(legacy)).toBe(true);
    expect(deriveKey('pw_' + 'a'.repeat(64)).equals(legacy)).toBe(false);
  });

  it('accepts the legacy token field on WS auth and echoes the legacy id', async () => {
    const ws = Object.create(WSServer.prototype);
    ws.workers = new Map();
    ws.authFails = new Map();
    const socket = { send: jest.fn(), _clientIp: '203.0.113.5' };
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes('FROM workers WHERE worker_token')) return { rows: [{ id: 9, status: 'offline', gpu_model: null }] };
      return { rows: [] };
    };
    await ws.handleAuth(socket, { type: 'auth', miner_token: 'kz_' + 'b'.repeat(64), e2e: 1 });
    const reply = JSON.parse(socket.send.mock.calls.at(-1)[0]);
    expect(reply).toMatchObject({ type: 'auth_ok', worker_id: 9, miner_id: 9, e2e: true });
  });
});
