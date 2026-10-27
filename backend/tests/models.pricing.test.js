const MODELS = require('../src/models');
const chat = require('../src/routes/chat');
const { modelOutputPrice } = require('../src/services/plans');

describe('model catalog', () => {
  it('has unique ids', () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('prices every model with non-negative numbers', () => {
    for (const m of MODELS) {
      expect(typeof m.inputPrice).toBe('number');
      expect(typeof m.outputPrice).toBe('number');
      expect(m.inputPrice).toBeGreaterThanOrEqual(0);
      expect(m.outputPrice).toBeGreaterThanOrEqual(0);
    }
  });

  it('contains only ids that can actually be pulled from Ollama', () => {
    // Regression: a menu/catalog entry for a model that does not exist made
    // workers advertise a model the dispatcher could never route to.
    const allowed = new Set([
      'llama3.1:8b', 'llama3.3:70b', 'deepseek-r1:70b', 'qwen3:32b',
      'gpt-oss:20b', 'phi4:14b', 'llama3.2:3b',
      'qwen3-coder:30b', 'qwen2.5-coder:32b',
      'qwen3-vl:8b', 'gemma4:12b', 'gemma3:27b', 'mistral-small3.2:24b',
      'embeddinggemma', 'nomic-embed-text', 'bge-m3',
    ]);
    for (const m of MODELS) {
      expect(allowed.has(m.id)).toBe(true);
    }
  });

  it('exposes a default model that exists in the catalog', () => {
    expect(MODELS.some((m) => m.id === chat.DEFAULT_MODEL)).toBe(true);
  });
});

describe('chat pricing', () => {
  it('uses the catalog price for a known model', () => {
    const m = MODELS.find((x) => x.id === 'llama3.1:8b');
    expect(modelOutputPrice('llama3.1:8b')).toBe(m.outputPrice);
  });

  it('falls back to a conservative price for an unknown model', () => {
    // v3.45.0: chat and v1 resolve through services/plans.js — one shared
    // fallback instead of three divergent literals.
    expect(modelOutputPrice('does-not-exist:99b')).toBeGreaterThan(0);
  });

  it('keeps the revenue split as documented', () => {
    expect(chat.WORKER_REVENUE_SHARE).toBe(0.9);
  });
});
