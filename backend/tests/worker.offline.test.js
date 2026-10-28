// v3.40.0 worker-only inference — no local fallback.
// Pattern: mock the DB pool + billing services, inject a fake wsServer, so
// every path here is deterministic and offline (no Postgres, no workers).

const express = require('express');
const request = require('supertest');

jest.mock('../src/database/pool', () => {
  const state = {
    statements: [],
    queryImpl: async () => ({ rows: [] }),
    connectImpl: async () => { throw new Error('connectImpl not scripted'); },
  };
  const push = (sql) => state.statements.push(String(sql).trim().replace(/\s+/g, ' '));
  return {
    __state: state,
    query: (sql, params) => { push(sql); return state.queryImpl(sql, params, push); },
    connect: () => state.connectImpl(push),
  };
});

jest.mock('../src/services/freeAllowance', () => ({
  getFreeStatus: jest.fn(async () => ({ limit: 2000000, used: 0, remaining: 1000000 })),
  chargeFreeTokens: jest.fn(async () => ({ charged: true, remaining: 999990 })),
}));

jest.mock('../src/services/plans', () => {
  const actual = jest.requireActual('../src/services/plans');
  return { ...actual, getDailyCap: jest.fn(async () => 2000000) };
});

const pool = require('../src/database/pool');
const chatRoutes = require('../src/routes/chat');

function buildApp(wsServer) {
  const app = express();
  app.use(express.json());
  app.set('wsServer', wsServer);
  app.use('/api/chat', chatRoutes);
  return app;
}

function fakeWs(over = {}) {
  // Default pickCandidate mirrors the old first-match order so legacy
  // scenarios keep working; tests override per-case as needed.
  const fake = {
    findWorkersForModel: jest.fn(() => []),
    countUsableWorkers: jest.fn(() => 0),
    onlineModelCounts: jest.fn(() => ({})),
    dispatchTask: jest.fn(),
    recordModelResult: jest.fn(),
    pickCandidate: jest.fn(({ exclude } = {}) => {
      const list = fake.findWorkersForModel();
      return list.find((c) => !(exclude && exclude.has(c.workerId))) || null;
    }),
    ...over,
  };
  return fake;
}

beforeEach(() => {
  pool.__state.statements.length = 0;
  pool.__state.queryImpl = async (sql) => {
    if (String(sql).includes('INSERT INTO tasks')) return { rows: [{ id: 7 }] };
    return { rows: [] };
  };
  pool.__state.connectImpl = async () => { throw new Error('connectImpl not scripted'); };
});

function postChat(app, body = {}) {
  return request(app).post('/api/chat').send({ message: 'hello', ...body });
}

describe('WORKER_OFFLINE — no workers online (v3.40.0)', () => {
  it('503s with a retryable code instead of a local reply', async () => {
    const ws = fakeWs();
    const res = await postChat(buildApp(ws));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('WORKER_OFFLINE');
    expect(res.body.retryable).toBe(true);
    expect(res.body.task_id).toBe(7);
  });

  it('never touches billing when nothing was served', async () => {
    const ws = fakeWs();
    await postChat(buildApp(ws));
    const joined = pool.__state.statements.join('\n');
    expect(joined).toMatch(/UPDATE tasks SET response/);
    expect(joined).not.toMatch(/BEGIN/);
    expect(joined).not.toMatch(/user_coin_balances/);
    expect(joined).not.toMatch(/chargeFreeTokens|daily_tokens/);
  });
});

describe('MODEL_UNAVAILABLE — workers online, model missing (v3.40.0)', () => {
  it('409s with same-category alternatives first', async () => {
    const ws = fakeWs({
      countUsableWorkers: jest.fn(() => 11),
      onlineModelCounts: jest.fn(() => ({ 'qwen3-coder:30b': 9, 'llama3.2:3b': 2 })),
    });
    const res = await postChat(buildApp(ws), { model: 'llama3.1:8b' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MODEL_UNAVAILABLE');
    expect(res.body.requested_model).toBe('llama3.1:8b');
    // Same category (chat) wins over raw count: llama3.2:3b (2) before qwen3-coder (9).
    expect(res.body.alternatives.map((a) => a.id)).toEqual(['llama3.2:3b', 'qwen3-coder:30b']);
    expect(res.body.alternatives[0]).toMatchObject({ workers_online: 2, category: 'chat' });
    expect(res.body.retryable).toBe(false);
  });

  it('never silently substitutes another model', async () => {
    const ws = fakeWs({
      findWorkersForModel: jest.fn(() => []),
      countUsableWorkers: jest.fn(() => 3),
      onlineModelCounts: jest.fn(() => ({ 'qwen3:32b': 3 })),
    });
    const res = await postChat(buildApp(ws), { model: 'deepseek-r1:70b' });
    expect(res.status).toBe(409);
    expect(ws.dispatchTask).not.toHaveBeenCalled();
  });
});

describe('dispatch resilience (v3.40.0)', () => {
  it('tries every exact-model candidate before giving up', async () => {
    const ws = fakeWs({
      findWorkersForModel: jest.fn(() => [
        { workerId: 1, model: 'llama3.1:8b' },
        { workerId: 2, model: 'llama3.1:8b' },
      ]),
      countUsableWorkers: jest.fn(() => 2),
    });
    ws.dispatchTask
      .mockRejectedValueOnce(new Error('Worker disconnected'))
      .mockResolvedValueOnce({ error: 'stale session' });
    const res = await postChat(buildApp(ws), { model: 'llama3.1:8b' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('WORKER_OFFLINE');
    expect(ws.dispatchTask).toHaveBeenCalledTimes(2);
  });

  it('serves from the second candidate when the first fails', async () => {
    pool.__state.connectImpl = async () => ({
      query: async () => ({ rows: [] }),
      release: jest.fn(),
    });
    const ws = fakeWs({
      findWorkersForModel: jest.fn(() => [
        { workerId: 1, model: 'llama3.1:8b' },
        { workerId: 2, model: 'llama3.1:8b' },
      ]),
    });
    ws.dispatchTask
      .mockRejectedValueOnce(new Error('Worker disconnected'))
      .mockResolvedValueOnce({ response: 'hi', tokens_used: 10 });
    const res = await postChat(buildApp(ws), { model: 'llama3.1:8b' });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('worker');
    expect(res.body.worker_id).toBe(2);
    // Health counters saw both outcomes.
    expect(ws.recordModelResult).toHaveBeenCalledWith(1, 'llama3.1:8b', false);
    expect(ws.recordModelResult).toHaveBeenCalledWith(2, 'llama3.1:8b', true);
  });

  it('history never inflates the charge (v3.41.0 billing lock)', async () => {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ id: 1, role: 'user', token_version: 0 }, process.env.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '1h',
    });
    pool.__state.connectImpl = async () => ({
      query: async () => ({ rows: [] }),
      release: jest.fn(),
    });
    // Signed-in + session: one completed prior turn → history built...
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes('token_version')) return { rows: [{ token_version: 0, banned: false }] };
      if (String(sql).includes('FROM chat_sessions')) return { rows: [{ id: 5 }] };
      if (String(sql).includes('INSERT INTO tasks')) return { rows: [{ id: 7 }] };
      if (String(sql).includes('SELECT prompt, response FROM tasks')) {
        return { rows: [{ prompt: 'old question', response: 'old answer' }] };
      }
      return { rows: [] };
    };
    const ws = fakeWs({
      findWorkersForModel: jest.fn(() => [{ workerId: 1, model: 'llama3.1:8b' }]),
    });
    ws.dispatchTask.mockResolvedValueOnce({ response: 'hi', tokens_used: 10 });
    const res = await request(buildApp(ws))
      .post('/api/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'hello', model: 'llama3.1:8b', session_id: 5 });
    expect(res.status).toBe(200);
    // ...but cost is output-only: 10 tokens × llama3.1:8b output price.
    expect(res.body.cost).toBeCloseTo((10 * 0.025) / 1000000, 12);
    const [, , , , , histArg] = ws.dispatchTask.mock.calls[0];
    expect(histArg).toEqual([
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
    ]);
  });
});

describe('free quota flags (v3.42.1)', () => {
  const freeAllowance = require('../src/services/freeAllowance');

  function successSetup(remaining) {
    pool.__state.connectImpl = async () => ({
      query: async () => ({ rows: [] }),
      release: jest.fn(),
    });
    freeAllowance.chargeFreeTokens.mockResolvedValueOnce({ charged: true, remaining });
    const ws = fakeWs({
      findWorkersForModel: jest.fn(() => [{ workerId: 1, model: 'llama3.1:8b' }]),
    });
    ws.dispatchTask.mockResolvedValueOnce({ response: 'hi', tokens_used: 10 });
    return ws;
  }

  it('flags free_exhausted when the charge drains the allowance', async () => {
    const res = await postChat(buildApp(successSetup(0)), { model: 'llama3.1:8b' });
    expect(res.status).toBe(200);
    expect(res.body.free_exhausted).toBe(true);
    expect(res.body.free_low).toBeUndefined();
  });

  it('flags free_low under 10% remaining', async () => {
    const res = await postChat(buildApp(successSetup(100000)), { model: 'llama3.1:8b' });
    expect(res.status).toBe(200);
    expect(res.body.free_low).toBe(true);
    expect(res.body.free_exhausted).toBeUndefined();
  });

  it('flags neither when allowance is healthy', async () => {
    const res = await postChat(buildApp(successSetup(1500000)), { model: 'llama3.1:8b' });
    expect(res.status).toBe(200);
    expect(res.body.free_low).toBeUndefined();
    expect(res.body.free_exhausted).toBeUndefined();
  });
});

describe('buildAlternatives ordering (v3.40.0)', () => {
  it('sorts same-category first, then by worker count', () => {
    const alts = chatRoutes.__buildAlternatives('llama3.1:8b', {
      'qwen3-coder:30b': 9,
      'llama3.2:3b': 2,
      'llama3.1:8b': 4, // requested model itself is excluded
    });
    expect(alts.map((a) => a.id)).toEqual(['llama3.2:3b', 'qwen3-coder:30b']);
  });
});
