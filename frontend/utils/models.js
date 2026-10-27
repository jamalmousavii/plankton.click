// Shared model-list helpers (v3.40.0): worker-count sorting + category
// grouping, used by the chat composer, the /worker page and the
// MODEL_UNAVAILABLE alternatives. Array.prototype.sort is stable (ES2019+),
// so ties keep catalog order.

export const CATEGORY_ORDER = ['chat', 'code', 'vision', 'embedding'];

export const CATEGORY_ICONS = { chat: '💬', code: '💻', vision: '👁️', embedding: '🔗' };

// i18n keys for the group headers (chat.catChat / catCode / catVision / catEmbedding).
export const CATEGORY_I18N_KEY = {
  chat: 'chat.catChat',
  code: 'chat.catCode',
  vision: 'chat.catVision',
  embedding: 'chat.catEmbedding',
};

export function workerCount(m) {
  return Number(m && m.workers_online) || 0;
}

// Busiest model first; ties keep their relative (catalog) order.
export function sortModels(models) {
  return [...(models || [])].sort((a, b) => workerCount(b) - workerCount(a));
}

// [{ category, items }] in CATEGORY_ORDER (unknown categories last).
// Inside a group: online first (count desc), then offline.
export function groupModels(models) {
  const byCat = new Map();
  for (const m of models || []) {
    const cat = (m && m.category) || 'other';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(m);
  }
  const ordered = [
    ...CATEGORY_ORDER.filter((c) => byCat.has(c)),
    ...[...byCat.keys()].filter((c) => !CATEGORY_ORDER.includes(c)),
  ];
  return ordered.map((category) => ({
    category,
    items: byCat.get(category).sort((a, b) => {
      const onA = workerCount(a) > 0 ? 0 : 1;
      const onB = workerCount(b) > 0 ? 0 : 1;
      return onA - onB || workerCount(b) - workerCount(a);
    }),
  }));
}

// First model with workers online (for auto-switch + default picks).
export function topOnlineModel(models) {
  const sorted = sortModels(models);
  return sorted.find((m) => workerCount(m) > 0) || null;
}
