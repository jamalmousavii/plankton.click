const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../database/pool');
const { authenticateApiKey } = require('../middleware/apiKey');
const MODELS = require('../models');
const { listPlans, TOKEN_BUNDLE, modelOutputPrice, MAX_TASK_TOKENS, getActivePlan } = require('../services/plans');
const { getTokenBalance } = require('../services/tokenBundles');
const { settleMessage } = require('../services/billing');
const { resolveCap, getActiveOrg } = require('../services/org');
const { logger } = require('../logger');

// OpenAI-compatible coder API (v3.43.0) for agents (opencode et al).
// Phase 1: non-streaming chat completions on the two coder models only.
// Everything is keyed off the API key owner: same workers, same billing
// chain as chat, no guests. Tools/streaming come in later phases with
// explicit 400 codes (never silent misbehaviour).
const CODER_MODELS = ['qwen3-coder:30b', 'qwen2.5-coder:32b'];
const PAID_PLANS = ['plus', 'pro', 'max'];
// Defensive inbound-history cap (agents resend full history every call).
const IN_HISTORY_TOKENS = 6000;

router.use(authenticateApiKey);

function openAiError(status, message, code, extra = {}) {
  return { status, body: { error: { message, type: code === 'invalid_request_error' ? 'invalid_request_error' : 'server_error', code, ...extra } } };
}

// GET /v1/models — OpenAI list shape; ids match the catalog exactly.
router.get('/models', (req, res) => {
  res.json({
    object: 'list',
    data: CODER_MODELS.map((id) => {
      const m = MODELS.find((x) => x.id === id);
      return { id, object: 'model', created: 0, owned_by: 'plankton', name: m ? m.name : id };
    }),
  });
});

// Ownership gate (locked): free-plan users with nothing owned cannot use
// the coder API — token pot, USD wallet, or an active paid plan is required.
// Caps then fall out of what they own (pot balance / tier daily cap / wallet).
async function checkApiCoverage(userId) {
  try {
    const pot = await getTokenBalance(userId);
    if (pot > 0) return { covered: true };
    const bal = await pool.query(
      "SELECT available FROM user_coin_balances WHERE user_id = $1 AND coin = 'USD'",
      [userId]
    );
    if (parseFloat(bal.rows[0]?.available || 0) > 0) return { covered: true };
    const plan = await pool.query(
      `SELECT plan_type FROM user_plans WHERE user_id = $1 AND status = 'active' AND expires_at > now()`,
      [userId]
    );
    if (plan.rows.some((row) => PAID_PLANS.includes(row.plan_type))) return { covered: true };
    // v3.44.0 org: a member rides the leader's paid plan.
    const org = await getActiveOrg(userId);
    if (org) {
      const leaderPlan = await getActivePlan(org.leader_user_id);
      if (leaderPlan && PAID_PLANS.includes(leaderPlan.plan_type)) return { covered: true };
    }
  } catch (err) {
    logger.error({ err }, 'v1 coverage check failed (failing closed)');
    return { covered: false };
  }
  return { covered: false };
}

// Flatten OpenAI messages: system/developer prefixes the prompt, the last
// user message IS the prompt, earlier user/assistant pairs become history.
function splitMessages(messages) {
  const system = [];
  const turns = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') {
      system.push(String(m.content || ''));
    } else if (m.role === 'user' || m.role === 'assistant') {
      turns.push({ role: m.role, content: String(m.content || '') });
    }
  }
  let prompt = '';
  let history = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user' && prompt === '') {
      prompt = turns[i].content;
    } else {
      history.unshift(turns[i]);
    }
  }
  if (system.length > 0) prompt = `System: ${system.join('\n')}\n\n${prompt}`;
  // Defensive cap (newest-first already ordered: drop oldest past budget).
  let tokens = 0;
  const kept = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const t = Math.ceil(String(history[i].content).length / 4);
    if (tokens + t > IN_HISTORY_TOKENS) break;
    tokens += t;
    kept.unshift(history[i]);
  }
  return { prompt, history: kept };
}

// POST /v1/chat/completions
router.post('/chat/completions', async (req, res) => {
  try {
    const { model, messages, max_tokens, temperature, stream, tools, tool_choice } = req.body || {};

    if (!model || !CODER_MODELS.includes(model)) {
      const r = openAiError(400, `Unknown model '${model}'. Available: ${CODER_MODELS.join(', ')}`, 'invalid_request_error', { code: 'model_not_found' });
      return res.status(r.status).json(r.body);
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      const r = openAiError(400, 'messages must be a non-empty array', 'invalid_request_error');
      return res.status(r.status).json(r.body);
    }
    for (const m of messages) {
      if (!m || typeof m.content !== 'string' || !['system', 'developer', 'user', 'assistant'].includes(m.role)) {
        const r = openAiError(400, 'each message needs {role: system|developer|user|assistant, content: string}', 'invalid_request_error');
        return res.status(r.status).json(r.body);
      }
    }
    if (tools !== undefined || tool_choice !== undefined) {
      const r = openAiError(400, 'tool calling is not supported yet (phase 2)', 'invalid_request_error', { code: 'tool_not_supported' });
      return res.status(r.status).json(r.body);
    }
    if (stream) {
      const r = openAiError(400, 'streaming is not supported yet (phase 2); retry with stream:false', 'invalid_request_error', { code: 'stream_not_supported' });
      return res.status(r.status).json(r.body);
    }
    void max_tokens;
    void temperature;

    const userId = req.user.id;
    const coverage = await checkApiCoverage(userId);
    if (!coverage.covered) {
      return res.status(402).json({
        error: {
          message: 'Coder API needs a token balance, wallet funds, or an active Plus/Pro/Max plan. Free plan alone cannot use it.',
          type: 'server_error',
          code: 'api_payment_required',
          plans: listPlans(),
          token_bundle: {
            price_per_million: TOKEN_BUNDLE.price_per_million,
            tokens_per_usd: TOKEN_BUNDLE.tokens_per_usd,
            min_usd: TOKEN_BUNDLE.min_usd,
            max_usd: TOKEN_BUNDLE.max_usd,
          },
        },
      });
    }

    const { prompt, history } = splitMessages(messages);
    if (!prompt.trim()) {
      const r = openAiError(400, 'no user message to answer', 'invalid_request_error');
      return res.status(r.status).json(r.body);
    }
    const needHistory = history.length > 0;

    const wsServer = req.app.get('wsServer');
    const candidates = wsServer ? wsServer.findWorkersForModel(model, false, needHistory) : [];
    const taskResult = await pool.query(
      `INSERT INTO tasks (user_id, worker_id, prompt, model, status, session_id, media, prepared_prompt, history)
       VALUES ($1, NULL, $2, $3, 'pending', NULL, NULL, NULL, $4)
       RETURNING id`,
      [userId, prompt, model, JSON.stringify(history)]
    );
    const taskId = taskResult.rows[0].id;

    const failTask = async (note) => {
      // Status-guarded (v3.45.0): never flip a completed task back to failed.
      await pool.query(
        "UPDATE tasks SET response = $1, status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = $2 AND status IN ('pending', 'processing')",
        [note, taskId]
      );
    };

    if (candidates.length === 0) {
      const usable = wsServer ? wsServer.countUsableWorkers(false) : 0;
      await failTask(usable === 0 ? 'No workers online' : 'No worker holds the requested model');
      if (usable === 0) {
        const r = openAiError(503, 'No workers online right now — retry with backoff.', 'server_error', { code: 'worker_offline', retryable: true });
        return res.status(r.status).json(r.body);
      }
      const r = openAiError(400, `No online worker serves ${model} right now.`, 'invalid_request_error', { code: 'model_unavailable', alternatives: CODER_MODELS.filter((m) => m !== model) });
      return res.status(r.status).json(r.body);
    }

    let response = null;
    let tokensUsed = 0;
    let workerId = null;
    const tried = new Set();
    for (;;) {
      const cand = wsServer.pickCandidate({ model, needsMedia: false, needHistory, sessionKey: null, exclude: tried });
      if (!cand) break;
      tried.add(cand.workerId);
      try {
        await pool.query("UPDATE tasks SET status = 'processing', worker_id = $1 WHERE id = $2", [cand.workerId, taskId]);
        const result = await wsServer.dispatchTask(cand.workerId, taskId, prompt, cand.model, null, history);
        if (result.error) {
          wsServer.recordModelResult(cand.workerId, model, false);
          continue;
        }
        const reported = Number(result.tokens_used);
        if (!Number.isFinite(reported) || reported < 0 || reported > MAX_TASK_TOKENS) {
          wsServer.recordModelResult(cand.workerId, model, false);
          continue;
        }
        response = result.response;
        tokensUsed = reported;
        workerId = cand.workerId;
        wsServer.recordModelResult(cand.workerId, model, true);
        break;
      } catch (e) {
        wsServer.recordModelResult(cand.workerId, model, false);
      }
    }

    if (response === null) {
      await failTask('All workers failed for this task');
      const r = openAiError(503, 'Workers failed to answer — retry with backoff.', 'server_error', { code: 'worker_offline', retryable: true });
      return res.status(r.status).json(r.body);
    }

    // Output-only charge at the single shared catalog price (v3.45.0).
    const cost = (tokensUsed * modelOutputPrice(model)) / 1000000;

    await pool.query(
      `UPDATE tasks SET response = $1, tokens_used = $2, cost = $3, status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = $4`,
      [response, tokensUsed, cost, taskId]
    );
    // v3.44.0 org: members settle against the shared bucket when the org
    // plan wins (same max rule as chat). v3.45.0: a settlement failure must
    // not 500 after the completion was already produced — the task is marked
    // billing_pending for the maintenance retry (nothing was charged).
    try {
      const resolved = await resolveCap(userId, null);
      await settleMessage({ userId, guestKey: null, tokensUsed, cost, workerId, servedByWorker: true, freeCap: resolved.cap, freeRemainingInit: null, bucketUserId: resolved.bucketUserId, paymentCoin: 'USD', taskId });
    } catch (err) {
      logger.error({ err, taskId }, 'Settlement failed after task completed — marked billing_pending');
      await pool.query(
        "UPDATE tasks SET billing_status = 'pending', billing_attempts = billing_attempts + 1 WHERE id = $1",
        [taskId]
      ).catch((e) => logger.error({ err: e, taskId }, 'Failed to mark billing_pending'));
    }

    // prompt_tokens estimated (~4 chars/token); billing stays output-only.
    const promptTokens = Math.ceil(prompt.length / 4);
    res.json({
      id: `chatcmpl-${crypto.randomBytes(12).toString('hex')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: response }, finish_reason: 'stop' }],
      usage: { prompt_tokens: promptTokens, completion_tokens: tokensUsed, total_tokens: promptTokens + tokensUsed },
    });
  } catch (err) {
    logger.error({ err }, 'POST /v1/chat/completions failed');
    res.status(500).json({ error: { message: 'Server error', type: 'server_error', code: 'internal' } });
  }
});

module.exports = router;
module.exports.CODER_MODELS = CODER_MODELS;
