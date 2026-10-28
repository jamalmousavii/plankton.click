const express = require('express');
const router = express.Router();
const pool = require('../database/pool');
const { authenticate, strictIfHeader } = require('../middleware/auth');
const { validate, chatRules } = require('../middleware/validate');

// Workers control task_result.error, and that text is reflected into the 503
// below — strip control characters/markup and cap it so a hostile worker can't
// forge response content or log lines.
function sanitizeWorkerDetail(raw) {
  return String(raw)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 80);
}
const MODELS = require('../models');
const { logger } = require('../logger');
const { prepareAttachment, AttachmentError } = require('../services/attachments');
const { getWorkerCreditStatus } = require('../services/workerCredit');
const { getFreeStatus } = require('../services/freeAllowance');
const { FREE_DAILY_TOKENS, TOKEN_BUNDLE, listPlans, modelOutputPrice, MAX_TASK_TOKENS } = require('../services/plans');
const { getTokenBalance } = require('../services/tokenBundles');
const { settleMessage, WORKER_REVENUE_SHARE } = require('../services/billing');
const { resolveCap } = require('../services/org');
const { withTransaction } = require('../database/tx');
const { embed, cosine, DEFAULT_EMBED_MODEL } = require('../services/embeddings');

// Single source of truth for the default model (was split between
// 'llama3:8b' — which exists in no catalog — and 'llama3.1:8b').
const DEFAULT_MODEL = 'llama3.1:8b';
// H1: the hard per-task output-token bound (MAX_TASK_TOKENS) lives in
// services/plans.js (v3.45.0) so chat, v1 and the WS result handler share
// one number. tokens_used comes from the worker (it both drives the user
// charge and the 90% worker share), so an inflated or NaN count must fail the
// task instead of minting money.

// Conversation window (v3.41.0): the last turns sent with every dispatch so
// workers can actually use context. Sliding window — newest first until the
// soft token budget, hard cap above that. Estimate ~4 chars/token.
const HISTORY_TURNS = 10;
const HISTORY_TOKENS = 6000;
const HISTORY_HARD_TOKENS = 16000;

// RAG over large attached files: past RAG_MIN_CHARS the file is chunked,
// embedded together with the question on a worker (bge-m3), and only the
// RAG_TOP_K most relevant chunks are sent to the chat model. Bounds keep one
// request within the embeddings service limits (64 inputs, 200k chars).
const RAG_MIN_CHARS = 12000;
const RAG_CHUNK = 1800;
const RAG_STEP = 1600;
const RAG_MAX_CHUNKS = 63;
const RAG_TOP_K = 6;

function chunkText(text) {
  const chunks = [];
  for (let i = 0; i < text.length && chunks.length < RAG_MAX_CHUNKS; i += RAG_STEP) {
    const piece = text.slice(i, i + RAG_CHUNK);
    if (piece.trim()) chunks.push({ index: chunks.length, text: piece });
  }
  return chunks;
}

// Returns the prompt with the file replaced by its most relevant excerpts,
// or null when RAG does not apply / fails (caller keeps the full text).
async function ragPrompt({ wsServer, userId, guestKey, fileName, fileText, question }) {
  if (!fileText || fileText.length < RAG_MIN_CHARS || !question.trim()) return null;
  const chunks = chunkText(fileText);
  try {
    const out = await embed({
      wsServer, userId, guestKey, model: DEFAULT_EMBED_MODEL,
      input: [question.slice(0, 8000), ...chunks.map((c) => c.text)],
    });
    const [q, ...vectors] = out.embeddings;
    const best = chunks
      .map((c, i) => ({ ...c, score: cosine(q, vectors[i]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, RAG_TOP_K)
      .sort((a, b) => a.index - b.index); // keep document order for the model
    const excerpts = best.map((c) => `[Excerpt ${c.index + 1}/${chunks.length}]\n${c.text}`).join('\n…\n');
    return `[File: ${fileName} — the ${best.length} most relevant of ${chunks.length} excerpts]\n${excerpts}\n---\n\n${question}`;
  } catch (err) {
    logger.warn({ err: err.message }, 'RAG embedding failed — sending the full file text instead');
    return null;
  }
}

async function buildHistory(sessionId) {
  if (!sessionId) return { history: [], truncated: false, tokens: 0 };
  const rows = await pool.query(
    `SELECT prompt, response FROM tasks
      WHERE session_id = $1 AND status = 'completed'
        AND response IS NOT NULL AND response <> ''
      ORDER BY id DESC LIMIT $2`,
    [sessionId, HISTORY_TURNS]
  );
  const history = [];
  let tokens = 0;
  let truncated = rows.rows.length === HISTORY_TURNS;
  for (const row of rows.rows) { // newest first: most relevant wins the budget
    const u = String(row.prompt || '');
    const a = String(row.response || '');
    const t = Math.ceil((u.length + a.length) / 4);
    if (t > HISTORY_HARD_TOKENS) { truncated = true; continue; } // single giant pair (e.g. file dump) never fits
    if (tokens + t > HISTORY_TOKENS) { truncated = true; break; }
    tokens += t;
    history.unshift({ role: 'user', content: u }, { role: 'assistant', content: a });
  }
  return { history, truncated, tokens };
}

// MODEL_UNAVAILABLE alternatives (v3.40.0): catalog models that have online
// workers right now, same category as the request first, then by worker count
// desc. Shape mirrors GET /api/models so the client can render directly.
function buildAlternatives(requestedModel, counts) {
  const requested = MODELS.find(m => m.id === requestedModel);
  const reqCat = requested ? requested.category : null;
  return MODELS
    .filter(m => (counts[m.id] || 0) > 0 && m.id !== requestedModel && m.category !== 'embedding')
    .map(m => ({
      id: m.id, name: m.name, size: m.size, ram: m.ram,
      category: m.category, vision: m.vision, audio: m.audio,
      workers_online: counts[m.id],
    }))
    .sort((a, b) =>
      (((b.category === reqCat) ? 1 : 0) - ((a.category === reqCat) ? 1 : 0))
      || (b.workers_online - a.workers_online));
}

// ======== SESSION CRUD ========

// GET /api/chat/sessions — list user sessions
router.get('/sessions', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `SELECT cs.*,
              COUNT(t.id) FILTER (WHERE t.id IS NOT NULL) AS message_count,
              MAX(t.created_at) AS last_message_at
       FROM chat_sessions cs
       LEFT JOIN tasks t ON t.session_id = cs.id
       WHERE cs.user_id = $1
       GROUP BY cs.id
       ORDER BY COALESCE(MAX(t.created_at), cs.updated_at) DESC`,
      [userId]
    );

    res.json({ success: true, sessions: result.rows });
  } catch (err) {
    logger.error({ err }, 'Sessions list failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/chat/sessions/:id — get session messages
router.get('/sessions/:id', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const sessionId = parseInt(req.params.id);

    const sessionResult = await pool.query(
      'SELECT * FROM chat_sessions WHERE id = $1 AND user_id = $2',
      [sessionId, userId]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const messagesResult = await pool.query(
      `SELECT prompt AS content, 'user' AS role, created_at, media
       FROM tasks WHERE session_id = $1 AND user_id = $2
       UNION ALL
       SELECT response AS content, 'assistant' AS role, completed_at AS created_at, NULL::jsonb AS media
       FROM tasks WHERE session_id = $1 AND user_id = $2 AND response IS NOT NULL AND status = 'completed'
       ORDER BY created_at ASC`,
      [sessionId, userId]
    );

    res.json({
      success: true,
      session: sessionResult.rows[0],
      messages: messagesResult.rows
    });
  } catch (err) {
    logger.error({ err }, 'Session get failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/chat/sessions — create new session
router.post('/sessions', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { subject, model } = req.body;

    const result = await pool.query(
      `INSERT INTO chat_sessions (user_id, subject, model)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, String(subject || 'New Chat').slice(0, 255), model ? String(model).slice(0, 100) : null]
    );

    res.status(201).json({ success: true, session: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Session create failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/chat/sessions/:id — update subject
router.put('/sessions/:id', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const sessionId = parseInt(req.params.id);
    const { subject } = req.body;

    if (typeof subject !== 'string' || !subject.trim()) {
      return res.status(400).json({ error: 'Subject is required' });
    }
    if (subject.trim().length > 255) {
      return res.status(400).json({ error: 'Subject must be at most 255 characters' });
    }

    const result = await pool.query(
      `UPDATE chat_sessions
       SET subject = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [subject.trim(), sessionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({ success: true, session: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Session update failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/chat/sessions/:id — delete session + messages
router.delete('/sessions/:id', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const sessionId = parseInt(req.params.id);

    const sessionResult = await pool.query(
      'SELECT * FROM chat_sessions WHERE id = $1 AND user_id = $2',
      [sessionId, userId]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Paid tasks are referenced by worker_coin_earnings (FK), so a hard
    // DELETE failed with 500 for any session that ever cost money. Wipe the
    // conversation content instead and detach the rows: the user's text is
    // gone, the money trail (tokens, cost, earnings) stays intact.
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE tasks
            SET session_id = NULL, prompt = '', response = NULL, media = NULL,
                prepared_prompt = NULL, history = NULL
          WHERE session_id = $1`,
        [sessionId]
      );
      await client.query('DELETE FROM chat_sessions WHERE id = $1', [sessionId]);
    });

    res.json({ success: true, message: 'Session deleted' });
  } catch (err) {
    logger.error({ err }, 'Session delete failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// ======== CHAT (with session support) ========

// POST /api/chat — send message (supports session_id)
// F4: guests still work (no header), but a bad bearer → 401, never silent-guest.
router.post('/', strictIfHeader, chatRules, validate, async (req, res) => {
  try {
    const { message: rawMessage, model, session_id, attachment } = req.body;
    // Image-only / voice-only sends arrive with an empty message (the
    // validator allows that exactly when an attachment is present).
    const message = typeof rawMessage === 'string' ? rawMessage : '';
    const userId = req.user?.id;
    const paymentCoin = 'USD';

    if (!message.trim() && !attachment) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Capability gate: images need a vision model, voice notes an audio-capable
    // one. Reject up front so the UI can explain exactly why — the attachment
    // must never be silently dropped.
    const requestedModel = model || DEFAULT_MODEL;
    const caps = MODELS.find(m => m.id === requestedModel);
    // Embedding models produce vectors, not replies: they are served through
    // /v1/embeddings and chat RAG, never as a chat partner.
    if (caps && caps.category === 'embedding') {
      return res.status(400).json({
        error: `${requestedModel} is an embedding model and cannot chat. Pick a chat model.`,
        code: 'MODEL_NOT_CHAT',
      });
    }
    if (attachment && attachment.type === 'image' && !(caps && caps.vision)) {
      return res.status(400).json({
        error: `Model ${requestedModel} cannot read images. Pick a vision-capable model or remove the image.`,
        code: 'ATTACHMENT_UNSUPPORTED',
      });
    }
    if (attachment && attachment.type === 'audio' && !(caps && caps.audio)) {
      return res.status(400).json({
        error: `Model ${requestedModel} cannot process voice notes. Pick an audio-capable model or record again.`,
        code: 'ATTACHMENT_UNSUPPORTED',
      });
    }

    // Normalize the attachment before anything is persisted or dispatched:
    // images/audio pass through as Ollama media, files are parsed to text and
    // prepended to the prompt (so any chat model can answer them).
    let effectiveMessage = message;
    let media = null;
    let dbAttachment = null;
    let fileText = null;
    let fileName = null;
    if (attachment) {
      try {
        ({ effectiveMessage, media, dbAttachment, fileText, fileName } = await prepareAttachment(attachment, message));
      } catch (err) {
        if (err instanceof AttachmentError) {
          return res.status(400).json({ error: err.message, code: err.code });
        }
        logger.error({ err }, 'Attachment preparation failed');
        return res.status(400).json({ error: 'Could not process attachment', code: 'ATTACHMENT_INVALID' });
      }
    }

    // Coverage pre-flight (v3.27.0). v3.26 removed payment blocking entirely;
    // v3.27 brings back a *narrow* gate: a subject with NO coverage at all —
    // daily free allowance exhausted, no worker credit, empty token pot and
    // empty wallet — gets the upgrade wall (402 upgrade_required) instead of
    // a wasted dispatch. Anyone with a single unit of coverage is served
    // exactly as before. Failures here never block chat (availability first).
    const guestKey = userId ? null : (req.ip || null);
    let freeCap = FREE_DAILY_TOKENS;
    // v3.44.0 org shared bucket: members drain the leader's row when the
    // org plan wins (max rule); everything else stays per-user.
    let bucketUserId = userId || null;
    let preFlightFree = null;
    try {
      const resolved = await resolveCap(userId, guestKey);
      freeCap = resolved.cap;
      if (resolved.bucketUserId) bucketUserId = resolved.bucketUserId;
      preFlightFree = await getFreeStatus({ userId: bucketUserId, guestKey: bucketUserId ? null : guestKey, cap: freeCap });
    } catch (err) {
      logger.error({ err }, 'Free allowance pre-flight failed (proceeding)');
    }

    if (preFlightFree && preFlightFree.remaining <= 0) {
      let covered = false;
      if (userId) {
        try {
          const credit = await getWorkerCreditStatus(userId);
          covered = credit.eligible && credit.remaining > 0;
          if (!covered) {
            const pot = await getTokenBalance(userId);
            covered = pot > 0;
          }
          if (!covered) {
            const bal = await pool.query(
              "SELECT available FROM user_coin_balances WHERE user_id = $1 AND coin = 'USD'",
              [userId]
            );
            covered = parseFloat(bal.rows[0]?.available || 0) > 0;
          }
        } catch (err) {
          logger.error({ err }, 'Coverage check failed (proceeding)');
          covered = true;
        }
      }

      if (!covered) {
        return res.status(402).json({
          error: 'Daily free allowance exhausted and no funds left.',
          code: 'upgrade_required',
          free: { limit: freeCap, used: preFlightFree.used, remaining: 0 },
          plans: listPlans(),
          token_bundle: {
            price_per_million: TOKEN_BUNDLE.price_per_million,
            tokens_per_usd: TOKEN_BUNDLE.tokens_per_usd,
            min_usd: TOKEN_BUNDLE.min_usd,
            max_usd: TOKEN_BUNDLE.max_usd,
          },
          signed_in: !!userId,
        });
      }
    }

    // Large file + a real question: retrieve the relevant excerpts instead of
    // shipping (and truncating) the whole document. Runs after the coverage
    // wall so an uncovered subject is never charged for the embedding.
    if (fileText) {
      const rag = await ragPrompt({
        wsServer: req.app.get('wsServer'), userId, guestKey, fileName, fileText, question: message,
      });
      if (rag) effectiveMessage = rag;
    }

    // Resolve or create session
    let sessionId = session_id ? parseInt(session_id, 10) : null;
    if (sessionId !== null && Number.isNaN(sessionId)) sessionId = null;

    if (userId) {
      if (sessionId) {
        // Verify session belongs to user
        const check = await pool.query(
          'SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2',
          [sessionId, userId]
        );
        if (check.rows.length === 0) {
          sessionId = null; // invalid session, will create new one
        }
      }

      if (!sessionId) {
        // Create new session with auto-generated subject. Attachment-only
        // messages have no text — name the session after the file instead.
        const subjectSource = message || (attachment && attachment.name) || 'New Chat';
        const subject = (subjectSource.length > 50 ? subjectSource.substring(0, 50) + '...' : subjectSource).slice(0, 255);
        const sessionResult = await pool.query(
          `INSERT INTO chat_sessions (user_id, subject, model)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [userId, subject, model || DEFAULT_MODEL]
        );
        sessionId = sessionResult.rows[0].id;
      }
    }

    const wsServer = req.app.get('wsServer');
    // v3.40.0 worker-only inference (exact-model rule): the user asked for THIS
    // model. Media (image/audio) may only go to a worker new enough to
    // understand the `attachment` field on task messages (v3.20.0+).
    // There is no local fallback anymore — an unservable request gets an
    // explicit, actionable error (WORKER_OFFLINE / MODEL_UNAVAILABLE) instead
    // of a silently substituted reply. All three early returns below happen
    // BEFORE billing, so an unserved message never consumes allowance or
    // wallet.
    const needsMedia = !!media;

    // v3.41.0 conversation window: recent turns ride every dispatch so the
    // worker answers with context. Guests and fresh sessions send none.
    // Billing is OUTPUT-only (locked): history tokens never enter `cost` —
    // neither the user charge nor the worker earning below.
    let history = [];
    let historyTruncated = false;
    let historyTokens = 0;
    try {
      const built = await buildHistory(sessionId);
      history = built.history;
      historyTruncated = built.truncated;
      historyTokens = built.tokens;
    } catch (err) {
      logger.error({ err }, 'History window failed (proceeding without context)');
    }
    const needHistory = history.length > 0;
    // Sticky sessions: one session sticks to one worker (style + context
    // continuity). Guests have no session → pure weighted round-robin.
    const sessionKey = sessionId ? `s:${sessionId}` : null;

    const hasCandidates = wsServer
      && wsServer.findWorkersForModel(requestedModel, needsMedia, needHistory).length > 0;

    // Create task (worker_id is claimed below once a candidate takes it).
    // The history snapshot is stored for audit/repro of what was dispatched.
    const taskResult = await pool.query(
      `INSERT INTO tasks (user_id, worker_id, prompt, model, status, session_id, media, prepared_prompt, history)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)
       RETURNING id`,
      [userId, null, message, requestedModel, sessionId, dbAttachment,
       effectiveMessage !== message ? effectiveMessage : null,
       JSON.stringify(history)]
    );

    const taskId = taskResult.rows[0].id;
    let response, tokensUsed, cost;
    let lastWorkerError = null;
    let servedByWorker = false;
    let workerId = null;

    const failTask = async (note) => {
      // Status-guarded (v3.45.0): never flip a task that already completed
      // (e.g. a late dispatch failure after a successful worker result).
      await pool.query(
        "UPDATE tasks SET response = $1, status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = $2 AND status IN ('pending', 'processing')",
        [note, taskId]
      );
    };

    if (!hasCandidates) {
      const usableCount = wsServer ? wsServer.countUsableWorkers(needsMedia) : 0;
      if (usableCount === 0) {
        // No workers online at all — the client shows a waiting state and
        // auto-retries (retryable: true).
        await failTask('No workers online');
        return res.status(503).json({
          error: 'No GPU workers are online right now. Your message is kept — please wait for a worker to connect and retry.',
          code: 'WORKER_OFFLINE',
          task_id: taskId,
          retryable: true,
        });
      }
      // Workers are online, but none holds the requested model — suggest a
      // switch instead of silently serving another model's output.
      const counts = wsServer.onlineModelCounts(needsMedia, needHistory);
      const alternatives = buildAlternatives(requestedModel, counts).slice(0, 6);
      await failTask('No worker holds the requested model');
      return res.status(409).json({
        error: `No online worker serves ${requestedModel} right now. Switch to one of these models or wait.`,
        code: 'MODEL_UNAVAILABLE',
        requested_model: requestedModel,
        alternatives,
        task_id: taskId,
        retryable: false,
      });
    }

    // Sticky + weighted-RR selection with failover: each pick honours the
    // session affinity (spilling past SPILL_CAP in-flight tasks), and every
    // outcome feeds the per-model health counters.
    const tried = new Set();
    for (;;) {
      const cand = wsServer.pickCandidate({
        model: requestedModel, needsMedia, needHistory, sessionKey, exclude: tried,
      });
      if (!cand) break;
      tried.add(cand.workerId);
      try {
        await pool.query("UPDATE tasks SET status = 'processing', worker_id = $1 WHERE id = $2", [cand.workerId, taskId]);

        logger.debug({
          taskId, workerId: cand.workerId, model: cand.model,
          media: needsMedia, historyTurns: history.length / 2, historyTokens, historyTruncated,
        }, 'Dispatching task to worker');
        const result = await wsServer.dispatchTask(cand.workerId, taskId, effectiveMessage, cand.model, media, history);

        if (result.error) {
          logger.warn({ taskId, workerId: cand.workerId, err: result.error }, 'Worker task failed, trying next worker');
          wsServer.recordModelResult(cand.workerId, requestedModel, false);
          lastWorkerError = result.error;
          continue;
        }
        const reported = Number(result.tokens_used);
        if (!Number.isFinite(reported) || reported < 0 || reported > MAX_TASK_TOKENS) {
          // Out-of-bounds report: reject the worker result and try the next
          // candidate — never charge the user or pay the worker for it.
          logger.warn({ taskId, workerId: cand.workerId, tokens_used: result.tokens_used }, 'Rejecting worker result: tokens_used out of bounds');
          wsServer.recordModelResult(cand.workerId, requestedModel, false);
          lastWorkerError = 'tokens_used out of bounds';
          continue;
        }
        response = result.response;
        tokensUsed = reported;
        servedByWorker = true;
        workerId = cand.workerId;
        wsServer.recordModelResult(cand.workerId, requestedModel, true);
        // Output-only charge at the single shared catalog price (v3.45.0).
        cost = (tokensUsed * modelOutputPrice(requestedModel)) / 1000000;
        break;

      } catch (wsError) {
        logger.warn({ taskId, err: wsError.message }, 'WebSocket dispatch failed, trying next worker');
        wsServer.recordModelResult(cand.workerId, requestedModel, false);
        lastWorkerError = wsError.message;
      }
    }

    if (!response) {
      // Every exact-model candidate failed — retryable, like offline.
      await failTask('All workers failed for this task');
      const detail = lastWorkerError
        ? ` (worker: ${sanitizeWorkerDetail(lastWorkerError)})`
        : '';
      return res.status(503).json({
        error: `Workers failed to answer right now. Your message is kept — please retry shortly.${detail}`,
        code: 'WORKER_OFFLINE',
        task_id: taskId,
        retryable: true,
      });
    }

    // Update task with result
    await pool.query(
      `UPDATE tasks
       SET response = $1, tokens_used = $2, cost = $3, status = 'completed', completed_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [response, tokensUsed, cost, taskId]
    );

    // Worker throughput counter. Revenue is accounted for separately below, so
    // a guest (free) task still counts as completed work for the worker.
    if (servedByWorker && workerId) {
      await pool.query('UPDATE workers SET total_tasks = total_tasks + 1 WHERE id = $1', [workerId])
        .catch((err) => logger.error({ err, workerId }, 'Failed to increment worker total_tasks'));
    }

    // Payment: single shared settlement (services/billing.js) — the same
    // chain serves chat and the v1 agent API. See that module for the
    // leg-by-leg rules; behavior here is unchanged.
    // A subject with no coverage never reaches here: the pre-flight wall
    // (402 upgrade_required) rejected it before dispatch.
    // v3.45.0: a settlement failure must not 500 after the answer was served.
    // The task is marked billing_pending and the maintenance job retries
    // it — nothing was charged (settleMessage is one rolled-back transaction).
    let settled = null;
    let billingPending = false;
    try {
      settled = await settleMessage({
        userId,
        guestKey,
        tokensUsed,
        cost,
        workerId,
        servedByWorker,
        freeCap,
        freeRemainingInit: preFlightFree ? preFlightFree.remaining : null,
        bucketUserId,
        paymentCoin,
        taskId,
      });
    } catch (err) {
      billingPending = true;
      logger.error({ err, taskId }, 'Settlement failed after task completed — marked billing_pending');
      await pool.query(
        "UPDATE tasks SET billing_status = 'pending', billing_attempts = billing_attempts + 1 WHERE id = $1",
        [taskId]
      ).catch((e) => logger.error({ err: e, taskId }, 'Failed to mark billing_pending'));
    }
    const {
      paymentStatus,
      workerCreditRemaining,
      freeRemaining,
      tokenBalanceRemaining,
      upgradeNotice,
      freeLow,
      freeExhausted,
    } = settled || {};

    res.json({
      success: true,
      response,
      task_id: taskId,
      session_id: sessionId,
      tokens_used: tokensUsed,
      cost,
      coin: paymentCoin,
      payment_status: billingPending ? 'pending' : paymentStatus,
      worker_id: servedByWorker ? workerId : null,
      source: 'worker',
      worker_credit_remaining: workerCreditRemaining,
      free_tokens_remaining: freeRemaining,
      ...(billingPending ? { billing_pending: true } : {}),
      ...(freeLow ? { free_low: true } : {}),
      ...(freeExhausted ? { free_exhausted: true } : {}),
      ...(tokenBalanceRemaining !== null && tokenBalanceRemaining !== undefined ? { token_balance_remaining: tokenBalanceRemaining } : {}),
      ...(upgradeNotice ? {
        notice: 'upgrade_recommended',
        plans: listPlans(),
        token_bundle: {
          price_per_million: TOKEN_BUNDLE.price_per_million,
          tokens_per_usd: TOKEN_BUNDLE.tokens_per_usd,
          min_usd: TOKEN_BUNDLE.min_usd,
          max_usd: TOKEN_BUNDLE.max_usd,
        },
      } : {}),
    });

  } catch (err) {
    logger.error({ err }, 'POST /api/chat failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/chat/history — legacy endpoint (backward compatibility)
router.get('/history', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      'SELECT * FROM tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [userId]
    );

    res.json({ success: true, tasks: result.rows });

  } catch (err) {
    logger.error({ err }, 'Request failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// Exposed for the test suite (pricing rules are money-adjacent).
router.DEFAULT_MODEL = DEFAULT_MODEL;
router.WORKER_REVENUE_SHARE = WORKER_REVENUE_SHARE;

// Test hook: the 503 detail sanitiser is module-private; expose it the same
// way stats.js exposes its aggregate reset.
router.__sanitizeWorkerDetail = sanitizeWorkerDetail;
router.__buildAlternatives = buildAlternatives;
router.__chunkText = chunkText;
router.__ragPrompt = ragPrompt;

module.exports = router;
