// 1.2.5: Ollama lists an untagged pull as "<name>:latest" in /api/tags, while
// config.json and the catalog use the bare name. Before the fix "bge-m3"
// never matched "bge-m3:latest", so workers stopped advertising bge-m3, got
// no embedding tasks, and the panel offered to "install" it.
jest.mock('../src/database/pool', () => ({
  query: jest.fn(async () => ({ rows: [] })),
  connect: jest.fn(async () => ({ query: jest.fn(async () => ({ rows: [] })), release: () => {} })),
}));

const { installedModels, modelKey } = require('../../worker-app/src/services/manager');
const WSServer = require('../src/ws');

// Shape of a real Ollama /api/tags response.
const TAGS = [
  { name: 'llama3.1:8b', model: 'llama3.1:8b' },
  { name: 'bge-m3:latest', model: 'bge-m3:latest' },
  { name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest' },
];

describe('worker: installed models vs Ollama tags', () => {
  test('bare config names match ":latest" tags', () => {
    expect(installedModels('llama3.1:8b,bge-m3', TAGS)).toEqual(['llama3.1:8b', 'bge-m3']);
    expect(installedModels('nomic-embed-text,llama3.1:8b', TAGS)).toEqual(['nomic-embed-text', 'llama3.1:8b']);
  });

  test('a model not pulled is still dropped', () => {
    expect(installedModels('llama3.1:8b,bge-m3,phi4:14b', TAGS)).toEqual(['llama3.1:8b', 'bge-m3']);
  });

  test('a different tag of the same model is not a match', () => {
    expect(installedModels('llama3.1:70b,bge-m3', TAGS)).toEqual(['bge-m3']);
  });

  test('no tags (Ollama down) keeps the configured list; nothing verified keeps it too', () => {
    expect(installedModels('llama3.1:8b,bge-m3', null)).toEqual(['llama3.1:8b', 'bge-m3']);
    expect(installedModels('qwen3:32b', TAGS)).toEqual(['qwen3:32b']);
  });

  test('modelKey', () => {
    expect(modelKey('bge-m3:latest')).toBe('bge-m3');
    expect(modelKey('BGE-M3')).toBe('bge-m3');
    expect(modelKey('llama3.1:8b')).toBe('llama3.1:8b');
  });
});

describe('server: reported model names are normalised', () => {
  function ws() {
    const s = Object.create(WSServer.prototype);
    s.workers = new Map();
    s.taskCallbacks = new Map();
    return s;
  }

  test('a heartbeat with "bge-m3:latest" makes the worker serve bge-m3 embeddings', async () => {
    const s = ws();
    const sock = { readyState: 1, send: () => {} };
    s.workers.set(9, { id: 9, ws: sock, status: 'online', protocol: 4, models: ['llama3.1:8b'], modelHealth: {} });
    await s.handleHeartbeat(sock, { type: 'heartbeat', models: ['llama3.1:8b', 'bge-m3:latest', 'bge-m3', 7] });
    expect(s.workers.get(9).models).toEqual(['llama3.1:8b', 'bge-m3']);
    expect(s.findWorkersForModel('bge-m3', false, false, true).map((w) => w.workerId)).toEqual([9]);
  });
});
