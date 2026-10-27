// Coder API v3.43.0: sk_ keys + OpenAI-compatible /v1 (2 coders only).

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

jest.mock('../src/database/pool', () => {
  const state = { queryImpl: async () => ({ rows: [] }) };
  return {
    __state: state,
    query: (sql, params) => state.queryImpl(sql, params),
    connect: async () => ({ query: async () => ({ rows: [] }), release: jest.fn() }),
  };
});

jest.mock('../src/services/billing', () => ({
  WORKER_REVENUE_SHARE: 0.9,
  settleMessage: jest.fn(async () => ({
    paymentStatus: 'tokens',
    workerCreditRemaining: null,
    freeRemaining: 0,
    tokenBalanceRemaining: 999000,
    upgradeNotice: false,
    freeLow: false,
    freeExhausted: false,
  })),
}));

const pool = require('../src/database/pool');
const apiKeyRoutes = require('../src/routes/apikeys');
const v1Routes = require('../src/routes/v1');

const SECRET = process.env.JWT_SECRET;
const userToken = (id = 7) => jwt.sign({ id, role: 'user', token_version: 0 }, SECRET, {
  algorithm: 'HS256',
  expiresIn: '1h',
});

function keysApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/keys', apiKeyRoutes);
  return app;
}

function v1App(wsServer) {
  const app = express();
  app.use(express.json());
  app.set('wsServer', wsServer);
  app.use('/v1', v1Routes);
  return app;
}

const fakeWs = () => ({
  findWorkersForModel: jest.fn(() => [{ workerId: 1, model: 'qwen3-coder:30b' }]),
  countUsableWorkers: jest.fn(() => 1),
  onlineModelCounts: jest.fn(() => ({})),
  pickCandidate: jest.fn(({ exclude } = {}) => (exclude && exclude.size > 0 ? null : { workerId: 1, model: 'qwen3-coder:30b' })),
  recordModelResult: jest.fn(),
  dispatchTask: jest.fn(async () => ({ response: 'print(1)', tokens_used: 5 })),
});

beforeEach(() => {
  pool.__state.queryImpl = async () => ({ rows: [] });
});

describe('API keys', () => {
  const app = keysApp();

  function authDb() {
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes('token_version')) return { rows: [{ token_version: 0, banned: false }] };
      return { rows: [] };
    };
  }

  it('mints a key once (raw secret only in the create response)', async () => {
    authDb();
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes('token_version')) return { rows: [{ token_version: 0, banned: false }] };
      if (String(sql).includes('COUNT(*)')) return { rows: [{ n: 0 }] };
      if (String(sql).includes('INSERT INTO api_keys')) {
        return { rows: [{ id: 3, name: 'ci', key_prefix: 'sk_abc', active: true, created_at: 'x' }] };
      }
      return { rows: [] };
    };
    const res = await request(app).post('/api/keys').set('Authorization', `Bearer ${userToken()}`).send({ name: 'ci' });
    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^sk_[0-9a-f]{48}$/);
    expect(res.body.api_key).not.toHaveProperty('key_hash');
  });

  it('lists without hashes and revokes owned keys', async () => {
    authDb();
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes('token_version')) return { rows: [{ token_version: 0, banned: false }] };
      if (String(sql).includes('FROM api_keys WHERE user_id')) {
        return { rows: [{ id: 3, name: 'ci', key_prefix: 'sk_abc', active: true, rate_limit: 100, last_used_at: null, created_at: 'x' }] };
      }
      return { rows: [] };
    };
    const list = await request(app).get('/api/keys').set('Authorization', `Bearer ${userToken()}`);
    expect(list.status).toBe(200);
    expect(list.body.keys[0]).not.toHaveProperty('key_hash');

    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes('token_version')) return { rows: [{ token_version: 0, banned: false }] };
      if (String(sql).includes('UPDATE api_keys')) return { rows: [{ id: 3 }] };
      return { rows: [] };
    };
    const del = await request(app).delete('/api/keys/3').set('Authorization', `Bearer ${userToken()}`);
    expect(del.status).toBe(200);
    expect(del.body.revoked).toBe(true);
  });

  it('rejects blank names and caps at 10 active keys', async () => {
    authDb();
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes('token_version')) return { rows: [{ token_version: 0, banned: false }] };
      if (String(sql).includes('COUNT(*)')) return { rows: [{ n: 10 }] };
      return { rows: [] };
    };
    const blank = await request(app).post('/api/keys').set('Authorization', `Bearer ${userToken()}`).send({ name: '  ' });
    expect(blank.status).toBe(400);
    const capped = await request(app).post('/api/keys').set('Authorization', `Bearer ${userToken()}`).send({ name: 'x' });
    expect(capped.status).toBe(400);
  });
});

describe('sk_ auth', () => {
  it('401s missing/non-sk/unknown keys without enumeration', async () => {
    const app = v1App(fakeWs());
    const missing = await request(app).get('/v1/models');
    expect(missing.status).toBe(401);
    const wrong = await request(app).get('/v1/models').set('Authorization', 'Bearer xyz');
    expect(wrong.status).toBe(401);
    pool.__state.queryImpl = async () => ({ rows: [] });
    const unknown = await request(app).get('/v1/models')
      .set('Authorization', 'Bearer sk_' + 'a'.repeat(48));
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe('Invalid API key.');
  });

  it('401s banned owners', async () => {
    pool.__state.queryImpl = async () => ({ rows: [{ id: 1, user_id: 7, name: 'x', banned: true }] });
    const app = v1App(fakeWs());
    const res = await request(app).get('/v1/models').set('Authorization', 'Bearer sk_' + 'b'.repeat(48));
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/models', () => {
  it('lists exactly the two coders in OpenAI shape', async () => {
    pool.__state.queryImpl = async () => ({ rows: [{ id: 1, user_id: 7, name: 'x', banned: false }] });
    const app = v1App(fakeWs());
    const res = await request(app).get('/v1/models').set('Authorization', 'Bearer sk_' + 'c'.repeat(48));
    expect(res.status).toBe(200);
    expect(res.body.object).toBe('list');
    expect(res.body.data.map((m) => m.id).sort()).toEqual(['qwen2.5-coder:32b', 'qwen3-coder:30b']);
    expect(res.body.data[0]).toMatchObject({ object: 'model', owned_by: 'plankton' });
  });
});

describe('POST /v1/chat/completions', () => {
  function authedDb({ pot = 1000000 } = {}) {
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes('FROM api_keys')) return { rows: [{ id: 1, user_id: 7, name: 'x', banned: false }] };
      if (String(sql).includes('user_token_balances')) return { rows: [{ tokens: pot }] };
      if (String(sql).includes('INSERT INTO tasks')) return { rows: [{ id: 7 }] };
      return { rows: [] };
    };
  }

  const key = () => `Bearer sk_${'d'.repeat(48)}`;
  const body = (over = {}) => ({
    model: 'qwen3-coder:30b',
    messages: [{ role: 'user', content: 'write fizzbuzz' }],
    ...over,
  });

  it('validates model/messages/stream/tools', async () => {
    authedDb();
    const app = v1App(fakeWs());
    const badModel = await request(app).post('/v1/chat/completions').set('Authorization', key()).send(body({ model: 'llama3.1:8b' }));
    expect(badModel.status).toBe(400);
    expect(badModel.body.error.code).toBe('model_not_found');
    const empty = await request(app).post('/v1/chat/completions').set('Authorization', key()).send(body({ messages: [] }));
    expect(empty.status).toBe(400);
    const stream = await request(app).post('/v1/chat/completions').set('Authorization', key()).send(body({ stream: true }));
    expect(stream.status).toBe(400);
    expect(stream.body.error.code).toBe('stream_not_supported');
    const tools = await request(app).post('/v1/chat/completions').set('Authorization', key()).send(body({ tools: [] }));
    expect(tools.status).toBe(400);
    expect(tools.body.error.code).toBe('tool_not_supported');
  });

  it('402s free-plan owners with nothing owned (api_payment_required)', async () => {
    authedDb({ pot: 0 });
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes('FROM api_keys')) return { rows: [{ id: 1, user_id: 7, name: 'x', banned: false }] };
      if (String(sql).includes('user_token_balances')) return { rows: [{ tokens: 0 }] };
      if (String(sql).includes('user_coin_balances')) return { rows: [{ available: 0 }] };
      if (String(sql).includes('FROM user_plans')) return { rows: [] };
      return { rows: [] };
    };
    const app = v1App(fakeWs());
    const res = await request(app).post('/v1/chat/completions').set('Authorization', key()).send(body());
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('api_payment_required');
    expect(res.body.error.plans.length).toBeGreaterThan(0);
  });

  it('serves pot owners in OpenAI shape with usage', async () => {
    authedDb({ pot: 1000000 });
    const ws = fakeWs();
    const app = v1App(ws);
    const res = await request(app).post('/v1/chat/completions').set('Authorization', key()).send(body({
      messages: [
        { role: 'system', content: 'you are terse' },
        { role: 'user', content: 'write fizzbuzz' },
      ],
    }));
    expect(res.status).toBe(200);
    expect(res.body.object).toBe('chat.completion');
    expect(res.body.model).toBe('qwen3-coder:30b');
    expect(res.body.choices[0].message).toEqual({ role: 'assistant', content: 'print(1)' });
    expect(res.body.usage).toEqual({ prompt_tokens: expect.any(Number), completion_tokens: 5, total_tokens: expect.any(Number) });
    // system prefix + user prompt dispatched; id format OpenAI-like
    expect(res.body.id).toMatch(/^chatcmpl-/);
    const [, , dispatched] = ws.dispatchTask.mock.calls[0];
    expect(dispatched).toMatch(/^System: you are terse/);
  });

  it('503s retryable when workers are down', async () => {
    authedDb({ pot: 1000000 });
    const ws = fakeWs();
    ws.findWorkersForModel.mockReturnValue([]);
    ws.countUsableWorkers.mockReturnValue(0);
    const app = v1App(ws);
    const res = await request(app).post('/v1/chat/completions').set('Authorization', key()).send(body());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('worker_offline');
  });
});
