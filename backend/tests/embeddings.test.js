// Embeddings: worker protocol 3 (`embed` / `embed_result`), the shared
// embeddings service, POST /v1/embeddings, and RAG over large chat files.

const express = require('express');
const request = require('supertest');

jest.mock('../src/database/pool', () => {
  const state = { statements: [], queryImpl: async () => ({ rows: [] }) };
  const query = (sql, params) => {
    state.statements.push(String(sql).trim().replace(/\s+/g, ' '));
    return state.queryImpl(sql, params);
  };
  return { __state: state, query, connect: async () => ({ query, release: jest.fn() }) };
});

jest.mock('../src/services/billing', () => ({
  WORKER_REVENUE_SHARE: 0.9,
  settleMessage: jest.fn(async () => ({ paymentStatus: 'tokens' })),
}));

const pool = require('../src/database/pool');
const { settleMessage } = require('../src/services/billing');
const WSServer = require('../src/ws');
const { embed, normaliseInputs, cosine, EmbedError } = require('../src/services/embeddings');
const v1Routes = require('../src/routes/v1');
const chatRoutes = require('../src/routes/chat');

beforeEach(() => {
  pool.__state.statements.length = 0;
  pool.__state.queryImpl = async (sql) => {
    if (String(sql).includes('INSERT INTO tasks')) return { rows: [{ id: 41 }] };
    return { rows: [] };
  };
  settleMessage.mockClear();
});

// A fake WS server whose single worker returns the given vectors.
function fakeWs(vectorsFor, { tokens = 12, error = null } = {}) {
  return {
    findWorkersForModel: jest.fn(() => [{ workerId: 3, model: 'bge-m3' }]),
    pickCandidate: jest.fn(({ exclude } = {}) => (exclude && exclude.size > 0 ? null : { workerId: 3, model: 'bge-m3' })),
    recordModelResult: jest.fn(),
    dispatchEmbed: jest.fn(async (workerId, taskId, model, inputs) => (
      error ? { error } : { embeddings: vectorsFor(inputs), tokens_used: tokens }
    )),
  };
}

describe('WS embed protocol', () => {
  function server(protocol = 3) {
    const ws = Object.create(WSServer.prototype);
    ws.workers = new Map();
    ws.taskCallbacks = new Map();
    const socket = { send: jest.fn() };
    ws.workers.set(3, { id: 3, ws: socket, status: 'online', protocol, models: ['bge-m3'], modelHealth: {} });
    return { ws, socket };
  }

  it('routes embed tasks only to protocol >= 3 workers', () => {
    expect(server(3).ws.findWorkersForModel('bge-m3', false, false, true)).toHaveLength(1);
    expect(server(2).ws.findWorkersForModel('bge-m3', false, false, true)).toHaveLength(0);
  });

  it('resolves a well-formed embed_result', async () => {
    const { ws, socket } = server();
    const p = ws.dispatchEmbed(3, 9, 'bge-m3', ['a', 'b']);
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({ type: 'embed', task_id: 9, input: ['a', 'b'] });
    await ws.handleEmbedResult(socket, { type: 'embed_result', task_id: 9, embeddings: [[1, 0], [0, 1]], tokens_used: 4 });
    await expect(p).resolves.toEqual({ embeddings: [[1, 0], [0, 1]], tokens_used: 4 });
  });

  it('rejects malformed vectors (wrong count, NaN, ragged)', async () => {
    for (const bad of [[[1, 0]], [[1, 0], [NaN, 1]], [[1, 0], [1]]]) {
      const { ws, socket } = server();
      const p = ws.dispatchEmbed(3, 9, 'bge-m3', ['a', 'b']);
      await ws.handleEmbedResult(socket, { type: 'embed_result', task_id: 9, embeddings: bad, tokens_used: 4 });
      await expect(p).resolves.toEqual({ error: 'invalid embeddings payload' });
    }
  });

  it('ignores an embed_result from a worker the task was not sent to', async () => {
    const { ws } = server();
    const stranger = { send: jest.fn() };
    ws.workers.set(4, { id: 4, ws: stranger, status: 'online', protocol: 3, models: [], modelHealth: {} });
    ws.dispatchEmbed(3, 9, 'bge-m3', ['a']).catch(() => {});
    await ws.handleEmbedResult(stranger, { type: 'embed_result', task_id: 9, embeddings: [[1]], tokens_used: 1 });
    expect(JSON.parse(stranger.send.mock.calls[0][0]).message).toBe('Task not assigned to this worker');
    expect(ws.taskCallbacks.has(9)).toBe(true);
    clearTimeout(ws.taskCallbacks.get(9).timeout);
  });
});

describe('embeddings service', () => {
  it('validates inputs', () => {
    expect(normaliseInputs('hi').inputs).toEqual(['hi']);
    expect(() => normaliseInputs([])).toThrow(EmbedError);
    expect(() => normaliseInputs(['ok', 3])).toThrow(EmbedError);
    expect(() => normaliseInputs(new Array(65).fill('x'))).toThrow(/at most 64/);
    expect(() => normaliseInputs('x'.repeat(8193))).toThrow(/8192/);
  });

  it('embeds, records the task and settles on input tokens', async () => {
    const ws = fakeWs((inputs) => inputs.map(() => [0.1, 0.2]), { tokens: 10 });
    const out = await embed({ wsServer: ws, userId: 7, input: ['a', 'b'] });
    expect(out.embeddings).toHaveLength(2);
    expect(out.tokensUsed).toBe(10);
    expect(out.cost).toBeCloseTo((10 * 0.008) / 1e6, 12);
    expect(settleMessage).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, tokensUsed: 10, workerId: 3, taskId: 41 }));
    expect(pool.__state.statements.join('\n')).toMatch(/status = 'completed'/);
  });

  it('rejects a forged token count instead of charging it', async () => {
    const ws = fakeWs((inputs) => inputs.map(() => [1]), { tokens: 1e9 });
    await expect(embed({ wsServer: ws, userId: 7, input: 'short' })).rejects.toMatchObject({ code: 'worker_offline' });
    expect(settleMessage).not.toHaveBeenCalled();
  });

  it('refuses non-embedding models and reports no workers', async () => {
    await expect(embed({ wsServer: fakeWs(() => []), userId: 7, model: 'llama3.1:8b', input: 'x' }))
      .rejects.toMatchObject({ code: 'model_not_found', status: 400 });
    const empty = { findWorkersForModel: () => [] };
    await expect(embed({ wsServer: empty, userId: 7, input: 'x' })).rejects.toMatchObject({ code: 'worker_offline', status: 503 });
  });

  it('computes cosine similarity', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
});

describe('POST /v1/embeddings', () => {
  function app(ws) {
    const a = express();
    a.use(express.json());
    a.set('wsServer', ws);
    a.use('/v1', v1Routes);
    return a;
  }
  const key = `Bearer sk_${'e'.repeat(48)}`;

  it('returns OpenAI-shaped vectors for a covered key', async () => {
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes('FROM api_keys')) return { rows: [{ id: 1, user_id: 7, name: 'x', banned: false }] };
      if (String(sql).includes('user_token_balances')) return { rows: [{ tokens: 5000 }] };
      if (String(sql).includes('INSERT INTO tasks')) return { rows: [{ id: 41 }] };
      return { rows: [] };
    };
    const res = await request(app(fakeWs((inputs) => inputs.map(() => [0.5, 0.5]), { tokens: 3 })))
      .post('/v1/embeddings').set('Authorization', key).send({ model: 'bge-m3', input: ['hello', 'world'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: 'list', model: 'bge-m3', usage: { prompt_tokens: 3, total_tokens: 3 },
      data: [{ object: 'embedding', index: 0, embedding: [0.5, 0.5] }, { object: 'embedding', index: 1 }],
    });
  });

  it('requires coverage (402) and a known embedding model (400)', async () => {
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes('FROM api_keys')) return { rows: [{ id: 1, user_id: 7, name: 'x', banned: false }] };
      return { rows: [] };
    };
    const broke = await request(app(fakeWs(() => []))).post('/v1/embeddings').set('Authorization', key).send({ model: 'bge-m3', input: 'x' });
    expect(broke.status).toBe(402);
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes('FROM api_keys')) return { rows: [{ id: 1, user_id: 7, name: 'x', banned: false }] };
      if (String(sql).includes('user_token_balances')) return { rows: [{ tokens: 5000 }] };
      return { rows: [] };
    };
    const bad = await request(app(fakeWs(() => []))).post('/v1/embeddings').set('Authorization', key).send({ model: 'qwen3:32b', input: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('model_not_found');
  });
});

describe('chat + embeddings', () => {
  it('refuses to chat with an embedding model', async () => {
    const a = express();
    a.use(express.json());
    a.use('/api/chat', chatRoutes);
    const res = await request(a).post('/api/chat').send({ message: 'hi', model: 'bge-m3' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MODEL_NOT_CHAT');
  });

  it('chunks long text within the embed service bounds', () => {
    const chunks = chatRoutes.__chunkText('a'.repeat(200000));
    expect(chunks.length).toBeLessThanOrEqual(63);
    expect(chunks.every((c) => c.text.length <= 1800)).toBe(true);
  });

  it('RAG keeps only the excerpts most similar to the question', async () => {
    const fileText = 'alpha '.repeat(400) + 'NEEDLE '.repeat(300) + 'omega '.repeat(2000);
    // Question + any chunk containing NEEDLE point the same way; others orthogonal.
    const ws = fakeWs((inputs) => inputs.map((t, i) => (i === 0 || t.includes('NEEDLE') ? [1, 0] : [0, 1])));
    const out = await chatRoutes.__ragPrompt({ wsServer: ws, userId: 7, guestKey: null, fileName: 'doc.txt', fileText, question: 'where is the needle?' });
    expect(out).toMatch(/most relevant of \d+ excerpts/);
    expect(out).toContain('NEEDLE');
    expect(out.endsWith('where is the needle?')).toBe(true);
    expect(out.length).toBeLessThan(fileText.length);
  });

  it('RAG falls back (null) for small files or when embedding fails', async () => {
    const ok = fakeWs((inputs) => inputs.map(() => [1]));
    expect(await chatRoutes.__ragPrompt({ wsServer: ok, fileName: 'a', fileText: 'short', question: 'q' })).toBeNull();
    const failing = fakeWs(() => [], { error: 'boom' });
    expect(await chatRoutes.__ragPrompt({ wsServer: failing, fileName: 'a', fileText: 'x'.repeat(20000), question: 'q' })).toBeNull();
  });
});

describe('worker app embed handler', () => {
  const WorkerWebSocket = require('../../worker-app/src/services/websocket');

  it('advertises protocol 3 only when an embed handler is wired', () => {
    const withEmbed = new WorkerWebSocket('pw_' + 'a'.repeat(64), async () => ({}), async () => ({}));
    const sent = [];
    withEmbed.send = (m) => sent.push(m);
    withEmbed.authenticate();
    expect(sent[0].protocol).toBe(3);
    const chatOnly = new WorkerWebSocket('pw_' + 'a'.repeat(64), async () => ({}));
    chatOnly.send = (m) => sent.push(m);
    chatOnly.authenticate();
    expect(sent[1].protocol).toBe(2);
  });

  it('answers embed with vectors and the prompt token count', async () => {
    const onEmbed = jest.fn(async (model, inputs) => ({ embeddings: inputs.map(() => [0.1]), prompt_eval_count: 7 }));
    const w = new WorkerWebSocket('pw_' + 'a'.repeat(64), async () => ({}), onEmbed);
    const sent = [];
    w.send = (m) => sent.push(m);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await w.handleEmbed({ type: 'embed', task_id: 5, model: 'bge-m3', input: ['x', 'y'] });
    expect(onEmbed).toHaveBeenCalledWith('bge-m3', ['x', 'y']);
    expect(sent[0]).toEqual({ type: 'embed_result', task_id: 5, embeddings: [[0.1], [0.1]], tokens_used: 7 });
    console.log.mockRestore();
  });
});
