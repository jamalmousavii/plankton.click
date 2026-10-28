// Vector embeddings served by workers (protocol >= 3, see ws.js).
//
// One shared path for the public /v1/embeddings API and for chat RAG over
// large attached files: a task row is recorded, the request is dispatched to
// a worker holding the embedding model (sticky-free weighted pick with
// failover), and the result is settled through the same billing chain as
// chat. Embeddings have no output text, so they are priced on their INPUT
// tokens at the model's catalog input price.
const pool = require('../database/pool');
const MODELS = require('../models');
const { modelInputPrice } = require('./plans');
const { settleMessage } = require('./billing');
const { resolveCap } = require('./org');
const { logger } = require('../logger');

// The model every worker installs by default (multilingual, incl. Persian).
const DEFAULT_EMBED_MODEL = 'bge-m3';
const EMBED_MODELS = MODELS.filter((m) => m.category === 'embedding').map((m) => m.id);

const MAX_INPUTS = 64;
const MAX_INPUT_CHARS = 8192;
const MAX_TOTAL_CHARS = 200000;

class EmbedError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Normalise OpenAI-style `input` (string | string[]) and enforce bounds.
function normaliseInputs(input) {
  const list = typeof input === 'string' ? [input] : input;
  if (!Array.isArray(list) || list.length === 0) {
    throw new EmbedError('input must be a non-empty string or array of strings', 'invalid_input', 400);
  }
  if (list.length > MAX_INPUTS) {
    throw new EmbedError(`at most ${MAX_INPUTS} inputs per request`, 'too_many_inputs', 400);
  }
  let total = 0;
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new EmbedError('every input must be a non-empty string', 'invalid_input', 400);
    }
    if (item.length > MAX_INPUT_CHARS) {
      throw new EmbedError(`each input is limited to ${MAX_INPUT_CHARS} characters`, 'input_too_long', 400);
    }
    total += item.length;
  }
  if (total > MAX_TOTAL_CHARS) {
    throw new EmbedError(`total input is limited to ${MAX_TOTAL_CHARS} characters`, 'input_too_long', 400);
  }
  return { inputs: list, totalChars: total };
}

// Embed `input` for a user (or a guest by IP) and settle the cost.
// Returns { embeddings, tokensUsed, cost, workerId, taskId }.
async function embed({ wsServer, userId = null, guestKey = null, model = DEFAULT_EMBED_MODEL, input }) {
  if (!EMBED_MODELS.includes(model)) {
    throw new EmbedError(`Unknown embedding model '${model}'. Available: ${EMBED_MODELS.join(', ')}`, 'model_not_found', 400);
  }
  const { inputs, totalChars } = normaliseInputs(input);

  if (!wsServer || wsServer.findWorkersForModel(model, false, false, true).length === 0) {
    throw new EmbedError(`No online worker serves ${model} right now — retry with backoff.`, 'worker_offline', 503);
  }

  const taskResult = await pool.query(
    `INSERT INTO tasks (user_id, worker_id, prompt, model, status)
     VALUES ($1, NULL, $2, $3, 'pending') RETURNING id`,
    [userId, `[embeddings] ${inputs.length} input(s), ${totalChars} chars`, model]
  );
  const taskId = taskResult.rows[0].id;

  // A token is at least ~1 char; anything beyond that bound is a forged
  // count (it drives the charge and the worker share).
  const maxTokens = totalChars + 16 * inputs.length;
  const tried = new Set();
  let result = null;
  let workerId = null;
  for (;;) {
    const cand = wsServer.pickCandidate({ model, needEmbed: true, exclude: tried });
    if (!cand) break;
    tried.add(cand.workerId);
    try {
      await pool.query("UPDATE tasks SET status = 'processing', worker_id = $1 WHERE id = $2", [cand.workerId, taskId]);
      const r = await wsServer.dispatchEmbed(cand.workerId, taskId, model, inputs);
      const tokens = Number(r.tokens_used);
      if (r.error || !Number.isFinite(tokens) || tokens < 0 || tokens > maxTokens) {
        logger.warn({ taskId, workerId: cand.workerId, err: r.error, tokens_used: r.tokens_used }, 'Embedding failed on worker, trying next');
        wsServer.recordModelResult(cand.workerId, model, false);
        continue;
      }
      wsServer.recordModelResult(cand.workerId, model, true);
      result = { embeddings: r.embeddings, tokensUsed: tokens };
      workerId = cand.workerId;
      break;
    } catch (err) {
      logger.warn({ taskId, err: err.message }, 'Embedding dispatch failed, trying next worker');
      wsServer.recordModelResult(cand.workerId, model, false);
    }
  }

  if (!result) {
    await pool.query(
      "UPDATE tasks SET response = $1, status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = $2 AND status IN ('pending', 'processing')",
      ['All workers failed for this embedding', taskId]
    );
    throw new EmbedError('Workers failed to embed the input — retry with backoff.', 'worker_offline', 503);
  }

  const cost = (result.tokensUsed * modelInputPrice(model)) / 1000000;
  await pool.query(
    `UPDATE tasks SET response = $1, tokens_used = $2, cost = $3, status = 'completed', completed_at = CURRENT_TIMESTAMP
      WHERE id = $4`,
    [`[embeddings] ${inputs.length} x ${result.embeddings[0].length}`, result.tokensUsed, cost, taskId]
  );
  await pool.query('UPDATE workers SET total_tasks = total_tasks + 1 WHERE id = $1', [workerId])
    .catch((err) => logger.error({ err, workerId }, 'Failed to increment worker total_tasks'));

  // Same settlement chain as chat; a failure parks the task for the
  // maintenance job (nothing was charged — settleMessage is one transaction).
  try {
    const resolved = await resolveCap(userId, guestKey);
    await settleMessage({
      userId, guestKey, tokensUsed: result.tokensUsed, cost, workerId, servedByWorker: true,
      freeCap: resolved.cap, freeRemainingInit: null,
      bucketUserId: resolved.bucketUserId, paymentCoin: 'USD', taskId,
    });
  } catch (err) {
    logger.error({ err, taskId }, 'Embedding settlement failed — marked billing_pending');
    await pool.query(
      "UPDATE tasks SET billing_status = 'pending', billing_attempts = billing_attempts + 1 WHERE id = $1",
      [taskId]
    ).catch((e) => logger.error({ err: e, taskId }, 'Failed to mark billing_pending'));
  }

  return { embeddings: result.embeddings, tokensUsed: result.tokensUsed, cost, workerId, taskId };
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

module.exports = {
  embed,
  normaliseInputs,
  cosine,
  EmbedError,
  DEFAULT_EMBED_MODEL,
  EMBED_MODELS,
  MAX_INPUTS,
  MAX_INPUT_CHARS,
};
