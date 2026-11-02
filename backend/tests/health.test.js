// /health: worker capacity (online_workers / chat) is admin-only (1.1.5).
// Public callers get a DB-based status and never see the worker count.

jest.mock('../src/database/pool', () => {
  const state = { role: 'user', dbDown: false };
  return {
    __state: state,
    query: async (sql) => {
      if (state.dbDown) throw new Error('db down');
      if (/FROM workers/.test(sql)) return { rows: [{ n: 0 }] };
      if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: state.role }] };
      return { rows: [{ '?column?': 1 }] };
    },
  };
});
jest.mock('../src/cache', () => ({ getCacheStats: () => ({ connected: true }) }));

const pool = require('../src/database/pool');
const health = require('../src/routes/health');

function call(user) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, body: b }); } };
    health({ user }, res);
  });
}

beforeEach(() => { pool.__state.role = 'user'; pool.__state.dbDown = false; });

it('anonymous: ok status, no worker count even with zero workers', async () => {
  const { code, body } = await call(undefined);
  expect(code).toBe(200);
  expect(body.status).toBe('ok');
  expect(body).not.toHaveProperty('online_workers');
  expect(body).not.toHaveProperty('chat');
  expect(body.version).toBe(require('../package.json').version);
});

it('signed-in non-admin: still no worker count', async () => {
  const { body } = await call({ id: 101 });
  expect(body).not.toHaveProperty('online_workers');
});

it('admin: sees online_workers and chat state', async () => {
  pool.__state.role = 'admin';
  const { body } = await call({ id: 102 });
  expect(body.online_workers).toBe(0);
  expect(body.chat).toBe('no_workers');
  expect(body.status).toBe('ok');
});

it('db down: 503 degraded', async () => {
  pool.__state.dbDown = true;
  const { code, body } = await call(undefined);
  expect(code).toBe(503);
  expect(body.status).toBe('degraded');
});
