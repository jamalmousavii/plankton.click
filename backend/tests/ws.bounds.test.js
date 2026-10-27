// v3.45.0 — the WS task-result handler is the LAST trust boundary for
// worker-reported numbers: tokens_used drives both the user charge and the
// worker share, so out-of-bounds reports are rejected here (marked failed,
// resolved as an error for failover) and never persisted.

jest.mock('../src/database/pool', () => {
  const state = { statements: [], queryImpl: async () => ({ rows: [] }) };
  return {
    __state: state,
    query: (sql, params) => {
      state.statements.push(String(sql).trim().replace(/\s+/g, ' '));
      return state.queryImpl(sql, params);
    },
    connect: async () => { throw new Error('connect not used'); },
  };
});

const WSServer = require('../src/ws');
const pool = require('../src/database/pool');

function makeServer() {
  const ws = Object.create(WSServer.prototype);
  ws.workers = new Map();
  ws.taskCallbacks = new Map();
  const socket = { send: jest.fn() };
  ws.workers.set(5, { id: 5, ws: socket, models: [], modelHealth: {} });
  return { ws, socket };
}

function armCallback(ws, taskId) {
  const resolve = jest.fn();
  ws.taskCallbacks.set(taskId, { resolve, timeout: setTimeout(() => {}, 60_000) });
  return resolve;
}

beforeEach(() => {
  pool.__state.statements.length = 0;
  pool.__state.queryImpl = async () => ({ rows: [] });
});

describe('handleTaskResult token bounds (v3.45.0)', () => {
  it('persists a sane report and resolves the callback with it', async () => {
    const { ws, socket } = makeServer();
    const resolve = armCallback(ws, 7);
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes('SELECT worker_id FROM tasks')) return { rows: [{ worker_id: 5 }] };
      if (String(sql).includes('UPDATE tasks')) return { rows: [{ id: 7 }] };
      return { rows: [] };
    };

    await ws.handleTaskResult(socket, { task_id: 7, response: 'hi', tokens_used: 10 });

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ tokens_used: 10 }));
    const joined = pool.__state.statements.join('\n');
    expect(joined).toMatch(/tokens_used = \$2, status = 'completed'/);
  });

  it('rejects an inflated report without persisting the number', async () => {
    const { ws, socket } = makeServer();
    const resolve = armCallback(ws, 8);
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes('SELECT worker_id FROM tasks')) return { rows: [{ worker_id: 5 }] };
      if (String(sql).includes('UPDATE tasks')) return { rows: [{ id: 8 }] };
      return { rows: [] };
    };

    await ws.handleTaskResult(socket, { task_id: 8, response: 'hi', tokens_used: 999999 });

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ error: 'tokens_used out of bounds' }));
    const joined = pool.__state.statements.join('\n');
    expect(joined).toMatch(/status = 'failed'/);
    expect(joined).not.toMatch(/tokens_used = \$2, status = 'completed'/);
    expect(joined).not.toMatch(/999999/);
  });

  it('rejects NaN reports too', async () => {
    const { ws, socket } = makeServer();
    const resolve = armCallback(ws, 9);
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes('SELECT worker_id FROM tasks')) return { rows: [{ worker_id: 5 }] };
      if (String(sql).includes('UPDATE tasks')) return { rows: [{ id: 9 }] };
      return { rows: [] };
    };

    await ws.handleTaskResult(socket, { task_id: 9, response: 'hi', tokens_used: 'lots' });

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ error: 'tokens_used out of bounds' }));
  });
});
