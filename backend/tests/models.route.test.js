// GET /api/models worker counts (v3.41.0): live multi-model roster first,
// DB GROUP BY current_model only as fallback.

const express = require('express');
const request = require('supertest');

jest.mock('../src/database/pool', () => {
  const state = { queryImpl: async () => ({ rows: [] }) };
  return {
    __state: state,
    query: (sql, params) => state.queryImpl(sql, params),
    connect: async () => { throw new Error('connectImpl not scripted'); },
  };
});

const pool = require('../src/database/pool');
const modelRoutes = require('../src/routes/models');

function buildApp(wsServer) {
  const app = express();
  if (wsServer !== undefined) app.set('wsServer', wsServer);
  app.use('/api/models', modelRoutes);
  return app;
}

beforeEach(() => {
  pool.__state.queryImpl = async (sql) => {
    if (String(sql).includes('COUNT(*)::int AS n')) return { rows: [{ n: 1 }] };
    if (String(sql).includes('GROUP BY current_model')) {
      return { rows: [{ current_model: 'llama3.1:8b', cnt: '1' }] };
    }
    return { rows: [] };
  };
});

describe('GET /api/models counts (v3.41.0)', () => {
  it('uses live multi-model counts when the WS registry is available', async () => {
    const ws = { onlineModelCounts: jest.fn(() => ({ 'llama3.1:8b': 1, 'qwen3:32b': 1 })) };
    const res = await request(buildApp(ws)).get('/api/models');
    expect(res.status).toBe(200);
    expect(ws.onlineModelCounts).toHaveBeenCalledWith(false);
    const byId = Object.fromEntries(res.body.models.map((m) => [m.id, m.workers_online]));
    // One multi-model worker counts once in EVERY bucket it serves.
    expect(byId['llama3.1:8b']).toBe(1);
    expect(byId['qwen3:32b']).toBe(1);
    expect(byId['deepseek-r1:70b']).toBe(0);
    expect(res.body.workers_online_total).toBe(1);
  });

  it('falls back to DB current_model grouping without WS', async () => {
    const res = await request(buildApp(undefined)).get('/api/models');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.models.map((m) => [m.id, m.workers_online]));
    expect(byId['llama3.1:8b']).toBe(1);
    expect(byId['qwen3:32b']).toBe(0);
  });
});
