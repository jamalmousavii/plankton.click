const WSServer = require('../src/ws');
const { computeWeight } = require('../src/ws');

describe('computeWeight GPU tiers (v3.42.0)', () => {
  it('tiers NVIDIA GPUs and Apple Silicon, defaults unknown to 1', () => {
    expect(computeWeight('NVIDIA GeForce RTX 4090')).toBe(8);
    expect(computeWeight('Apple M4')).toBe(7);
    expect(computeWeight('Apple M1 Pro')).toBe(4);
    expect(computeWeight('')).toBe(1);
    expect(computeWeight(null)).toBe(1);
    expect(computeWeight('Some Mystery iGPU 3000')).toBe(1);
  });
});

// findWorkerForModel / workerSupportsMedia are plain logic on the worker map —
// build a bare instance so no HTTP server or socket is needed.
function makeServer(workers) {
  const ws = Object.create(WSServer.prototype);
  ws.workers = new Map();
  ws.taskCallbacks = new Map();
  ws.affinity = new Map();
  ws.wrr = new Map();
  workers.forEach((m, i) => ws.workers.set(m.id || i + 1, {
    models: [],
    modelHealth: {},
    weight: 1,
    ...m,
  }));
  return ws;
}

// Settle a dispatchTask promise without waiting for the 180s timeout.
async function settle(ws, taskId) {
  const cb = ws.taskCallbacks.get(taskId);
  clearTimeout(cb.timeout);
  ws.taskCallbacks.delete(taskId);
  cb.resolve({ response: 'ok' });
}

const online = (over = {}) => ({
  status: 'online',
  current_model: 'llama3.1:8b',
  app_version: null,
  ...over,
});

describe('findWorkerForModel media gating (v3.20.0)', () => {
  it('routes media to any worker advertising >= 3.20.0', () => {
    const ws = makeServer([online({ app_version: '3.20.0' })]);
    expect(ws.findWorkerForModel('llama3.1:8b', true)).toEqual({ workerId: 1, model: 'llama3.1:8b' });
  });

  it('never routes media to workers without a version (old binaries)', () => {
    const ws = makeServer([online({ app_version: null })]);
    expect(ws.findWorkerForModel('llama3.1:8b', true)).toBeNull();
  });

  it('never routes media to pre-3.20.0 workers', () => {
    for (const v of ['3.19.1', '3.0.0', '2.99.9', 'v3.19.0']) {
      const ws = makeServer([online({ app_version: v })]);
      expect(ws.findWorkerForModel('llama3.1:8b', true)).toBeNull();
    }
  });

  it('handles future major/minor versions', () => {
    for (const v of ['4.0.0', '3.21.0', 'v3.20.5']) {
      const ws = makeServer([online({ app_version: v })]);
      expect(ws.findWorkerForModel('llama3.1:8b', true)).not.toBeNull();
    }
  });

  it('still serves text tasks to old workers', () => {
    const ws = makeServer([online({ app_version: '3.19.1' })]);
    expect(ws.findWorkerForModel('llama3.1:8b', false)).toEqual({ workerId: 1, model: 'llama3.1:8b' });
    expect(ws.findWorkerForModel('llama3.1:8b')).not.toBeNull();
  });

  it('never substitutes another model (v3.40.0 exact-model rule)', () => {
    const ws = makeServer([
      online({ id: 1, app_version: '3.20.0', current_model: 'other' }),
      online({ id: 2, app_version: '3.19.1', current_model: 'llama3.1:8b' }),
    ]);
    // worker 2 matches the model but is too old, worker 1 is new but holds a
    // different model → no substitution, caller gets MODEL_UNAVAILABLE.
    expect(ws.findWorkerForModel('llama3.1:8b', true)).toBeNull();
  });

  it('ignores offline workers even when new enough', () => {
    const ws = makeServer([online({ status: 'offline', app_version: '3.20.0' })]);
    expect(ws.findWorkerForModel('llama3.1:8b', true)).toBeNull();
  });
});

describe('findWorkersForModel / counts (v3.40.0)', () => {
  it('returns every exact-model worker in registration order', () => {
    const ws = makeServer([
      online({ id: 1, current_model: 'llama3.1:8b' }),
      online({ id: 2, current_model: 'other' }),
      online({ id: 3, current_model: 'llama3.1:8b' }),
    ]);
    expect(ws.findWorkersForModel('llama3.1:8b', false)).toEqual([
      { workerId: 1, model: 'llama3.1:8b' },
      { workerId: 3, model: 'llama3.1:8b' },
    ]);
  });

  it('counts usable workers with and without media gating', () => {
    const ws = makeServer([
      online({ id: 1, app_version: '3.20.0' }),
      online({ id: 2, app_version: '3.19.1' }),
      online({ id: 3, status: 'offline', app_version: '3.20.0' }),
    ]);
    expect(ws.countUsableWorkers(false)).toBe(2);
    expect(ws.countUsableWorkers(true)).toBe(1);
  });

  it('reports online counts per model', () => {
    const ws = makeServer([
      online({ id: 1, app_version: '3.20.0', current_model: 'llama3.1:8b' }),
      online({ id: 2, app_version: '3.20.0', current_model: 'llama3.1:8b' }),
      online({ id: 3, app_version: '3.20.0', current_model: 'other' }),
    ]);
    expect(ws.onlineModelCounts(false)).toEqual({ 'llama3.1:8b': 2, other: 1 });
  });
});

describe('multi-model matching (v3.41.0)', () => {
  it('matches any installed model, not just current_model', () => {
    const ws = makeServer([online({ id: 1, models: ['llama3.1:8b', 'qwen3:32b'], current_model: 'llama3.1:8b' })]);
    expect(ws.findWorkersForModel('qwen3:32b', false)).toEqual([{ workerId: 1, model: 'qwen3:32b' }]);
  });

  it('skips down-marked models after 3 consecutive failures, recovers on success', () => {
    const ws = makeServer([online({ id: 1, models: ['llama3.1:8b'] })]);
    ws.recordModelResult(1, 'llama3.1:8b', false);
    ws.recordModelResult(1, 'llama3.1:8b', false);
    expect(ws.findWorkersForModel('llama3.1:8b', false)).toHaveLength(1);
    ws.recordModelResult(1, 'llama3.1:8b', false);
    expect(ws.findWorkersForModel('llama3.1:8b', false)).toHaveLength(0);
    ws.recordModelResult(1, 'llama3.1:8b', true);
    expect(ws.findWorkersForModel('llama3.1:8b', false)).toHaveLength(1);
  });

  it('counts a multi-model worker once per served bucket', () => {
    const ws = makeServer([online({ id: 1, models: ['a', 'b'] })]);
    expect(ws.onlineModelCounts(false)).toEqual({ a: 1, b: 1 });
  });
});

describe('history gating (v3.41.0)', () => {
  it('requires >= 3.41 workers only when history is non-empty', () => {
    const ws = makeServer([online({ id: 1, app_version: '3.40.0', models: ['llama3.1:8b'] })]);
    expect(ws.findWorkersForModel('llama3.1:8b', false, false)).toHaveLength(1);
    expect(ws.findWorkersForModel('llama3.1:8b', false, true)).toHaveLength(0);
    const ws2 = makeServer([online({ id: 1, app_version: '3.41.0', models: ['llama3.1:8b'] })]);
    expect(ws2.findWorkersForModel('llama3.1:8b', false, true)).toHaveLength(1);
  });
});

describe('sticky + weighted routing (v3.41.0)', () => {
  const two = () => makeServer([
    online({ id: 1, weight: 1, models: ['llama3.1:8b'] }),
    online({ id: 2, weight: 1, models: ['llama3.1:8b'] }),
  ]);

  it('sticks a session to its worker', () => {
    const ws = two();
    const first = ws.pickCandidate({ model: 'llama3.1:8b', sessionKey: 's:9' });
    const second = ws.pickCandidate({ model: 'llama3.1:8b', sessionKey: 's:9' });
    expect(second.workerId).toBe(first.workerId);
  });

  it('spills over past 2 in-flight tasks', () => {
    const ws = two();
    const first = ws.pickCandidate({ model: 'llama3.1:8b', sessionKey: 's:9' });
    expect(first.workerId).toBe(1);
    ws.taskCallbacks.set(11, { workerId: 1 });
    ws.taskCallbacks.set(12, { workerId: 1 });
    const spilled = ws.pickCandidate({ model: 'llama3.1:8b', sessionKey: 's:9' });
    expect(spilled.workerId).toBe(2);
  });

  it('splits new sessions ~proportionally to weight', () => {
    const ws = makeServer([
      online({ id: 1, weight: 3, models: ['llama3.1:8b'] }),
      online({ id: 2, weight: 1, models: ['llama3.1:8b'] }),
    ]);
    const picks = [1, 2, 3, 4].map((i) =>
      ws.pickCandidate({ model: 'llama3.1:8b', sessionKey: `s:${i}` }).workerId
    );
    expect(picks.filter((id) => id === 1)).toHaveLength(3);
    expect(picks.filter((id) => id === 2)).toHaveLength(1);
  });

  it('reassigns when the sticky worker disappears', () => {
    const ws = two();
    const first = ws.pickCandidate({ model: 'llama3.1:8b', sessionKey: 's:9' });
    expect(first.workerId).toBe(1);
    ws.workers.get(1).status = 'offline';
    const again = ws.pickCandidate({ model: 'llama3.1:8b', sessionKey: 's:9' });
    expect(again.workerId).toBe(2);
  });
});

describe('dispatchTask attachment payload', () => {
  const fakeSocket = () => {
    const sent = [];
    return {
      sent,
      ws: { readyState: 1, sent, send: (str) => sent.push(JSON.parse(str)) },
    };
  };

  it('includes media as a plaintext attachment when no e2e key', async () => {
    const worker = { ...online({ app_version: '3.20.0' }), ws: fakeSocket().ws };
    const ws = makeServer([worker]);
    const pending = ws.dispatchTask(1, 99, 'prompt', 'llama3.1:8b', { type: 'image', data: 'AAAA' });
    expect(worker.ws.sent[0].attachment).toEqual({ type: 'image', data: 'AAAA' });
    expect(worker.ws.sent[0].prompt).toBe('prompt');
    // settle so the 180s timeout timer doesn't linger
    await settle(ws, 99);
    await pending;
  });

  it('omits attachment for plain text tasks', async () => {
    const worker = { ...online(), ws: fakeSocket().ws };
    const ws = makeServer([worker]);
    const pending = ws.dispatchTask(1, 100, 'prompt', 'llama3.1:8b', null);
    expect(worker.ws.sent[0]).not.toHaveProperty('attachment');
    await settle(ws, 100);
    await pending;
  });
});
