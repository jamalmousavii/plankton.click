// 1.2.0 remote model management, end to end over real sockets: the real
// WSServer on a local port, the real worker WebSocket client + ModelManager,
// and a fake Ollama HTTP server that streams pull progress like Ollama does.
// Only Postgres is mocked.

// The worker app resolves `ws` / `axios` from its own (uninstalled in CI)
// node_modules — hand it the backend's real copies.
jest.mock('ws', () => jest.requireActual('ws'));
jest.mock('axios', () => jest.requireActual('axios'));
jest.mock('../src/database/pool', () => ({
  query: jest.fn(async (sql) => (String(sql).includes('FROM workers WHERE worker_token')
    ? { rows: [{ id: 9, status: 'offline', gpu_model: null, ram: '16 GB' }] }
    : { rows: [] })),
  connect: jest.fn(async () => ({ query: jest.fn(async () => ({ rows: [] })), release: () => {} })),
}));

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WSServer = require('../src/ws');
const WorkerWebSocket = require('../../worker-app/src/services/websocket');
const OllamaService = require('../../worker-app/src/services/ollama');
const { ModelManager } = require('../../worker-app/src/services/manager');

const TOKEN = 'pw_' + 'c'.repeat(64);
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const waitFor = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = cond();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};

describe('remote model management over real sockets', () => {
  let server; let wss; let ollamaSrv; let worker; let dir; let cfgPath; const deleted = [];

  beforeAll(async () => {
    process.env.PLANKTON_PIN = '0';
    // Fake Ollama: /api/pull streams NDJSON in chunks, /api/delete records.
    ollamaSrv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url === '/api/pull') {
          const { model } = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          if (model === 'qwen3:32b') {
            res.end('{"error":"pull model manifest: file does not exist"}\n');
            return;
          }
          const lines = [
            '{"status":"pulling manifest"}',
            '{"status":"pulling aaa","digest":"sha256:aaa","total":4000,"completed":1000}',
            '{"status":"pulling aaa","digest":"sha256:aaa","total":4000,"completed":4000}',
            '{"status":"verifying sha256 digest"}',
            '{"status":"success"}',
          ];
          let i = 0;
          const tick = () => {
            if (i >= lines.length) { res.end(); return; }
            res.write(lines[i++] + '\n');
            setTimeout(tick, 1100); // > the worker's 1 s progress throttle
          };
          tick();
        } else if (req.url === '/api/delete') {
          deleted.push(JSON.parse(body).model);
          res.end('{}');
        } else if (req.url === '/api/tags') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ models: [{ name: 'llama3.1:8b' }, { name: 'bge-m3' }, { name: 'phi4:14b' }] }));
        } else {
          res.writeHead(404); res.end();
        }
      });
    });
    const ollamaPort = await listen(ollamaSrv);

    server = http.createServer();
    const port = await listen(server);
    wss = new WSServer(server);

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-int-'));
    cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ models: 'llama3.1:8b,bge-m3', default_model: 'llama3.1:8b', worker_token: TOKEN }));

    process.env.API_WS_URL = `ws://127.0.0.1:${port}/ws`;
    const ollama = new OllamaService('llama3.1:8b');
    ollama.url = `http://127.0.0.1:${ollamaPort}`;
    worker = new WorkerWebSocket(TOKEN, async () => ({ response: 'x' }), async () => ({ embeddings: [] }));
    const manager = new ModelManager({
      ollama,
      configPath: cfgPath,
      onModels: (models) => worker.setModels(models),
      freeBytes: () => 500 * 1024 ** 3,
    });
    worker.setManager(manager);
    worker.setModels(['llama3.1:8b', 'bge-m3']);
    worker.connect();
    await waitFor(() => wss.workers.get(9) && wss.workers.get(9).manage === 'on');
  }, 20000);

  afterAll(async () => {
    worker.disconnect();
    clearInterval(wss.cleanupTimer);
    for (const c of wss.wss.clients) c.terminate();
    wss.wss.close();
    server.closeAllConnections();
    ollamaSrv.closeAllConnections();
    await new Promise((r) => server.close(r));
    await new Promise((r) => ollamaSrv.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.API_WS_URL;
  });

  test('install: live progress, then the new model is served and persisted', async () => {
    const { job } = wss.startManage(9, 'pull', 'phi4:14b', 9);
    const mid = await waitFor(() => {
      const j = wss.getManageJob(9);
      return j && j.total === 4000 && j.completed > 0 && j.completed < 4000 ? { ...j } : null;
    }, 8000);
    expect(mid).toMatchObject({ id: job.id, status: 'running', total: 4000 });
    const done = await waitFor(() => (wss.getManageJob(9).status !== 'running' ? wss.getManageJob(9) : null), 10000);
    expect(done).toMatchObject({ status: 'done', completed: 4000, error: null });
    expect(wss.workers.get(9).models).toEqual(['llama3.1:8b', 'bge-m3', 'phi4:14b']);
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).models).toBe('llama3.1:8b,bge-m3,phi4:14b');
  }, 20000);

  test('an Ollama error is reported back as a failed job', async () => {
    wss.startManage(9, 'pull', 'qwen3:32b', 20);
    const j = await waitFor(() => (wss.getManageJob(9).status !== 'running' ? wss.getManageJob(9) : null));
    expect(j).toMatchObject({ status: 'failed', error: 'pull model manifest: file does not exist' });
    expect(wss.workers.get(9).models).not.toContain('qwen3:32b');
  });

  test('remove deletes it in Ollama and drops it from routing', async () => {
    wss.startManage(9, 'remove', 'phi4:14b');
    const j = await waitFor(() => (wss.getManageJob(9).status !== 'running' ? wss.getManageJob(9) : null));
    expect(j.status).toBe('done');
    expect(deleted).toEqual(['phi4:14b']);
    expect(wss.workers.get(9).models).toEqual(['llama3.1:8b', 'bge-m3']);
  });
});
