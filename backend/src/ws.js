const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const pool = require('./database/pool');
const { invalidateCache } = require('./cache');
const { deriveKey, encrypt, decrypt, isEncrypted } = require('./services/e2e');
const { MAX_TASK_TOKENS } = require('./services/plans');
const { logger } = require('./logger');

// pw_ = Plankton worker token; kz_ tokens issued before the 1.0.0 relaunch
// stay valid so already-installed workers keep connecting.
const TOKEN_RE = /^(pw|kz)_[0-9a-f]{32,64}$/;
// Wire names used by pre-1.0 binaries (auth field in, id field out of auth_ok;
// the old client re-auths only once it has stored that id).
const { LEGACY_TOKEN_FIELD, LEGACY_ID_FIELD } = require('./legacy');
const AUTH_FAIL_LIMIT = 10;
const AUTH_FAIL_WINDOW = 5 * 60 * 1000;
// v3.41.0 multi-model routing tunables.
const MODEL_DOWN_AFTER_FAILS = 3; // consecutive task errors before a model is skipped for that worker
const SPILL_CAP = 2; // in-flight tasks before a sticky session spills to the next worker
const HISTORY_APP_VERSION = { major: 3, minor: 41 }; // legacy (pre-1.0) binaries at/above this understand `history`
// 1.0.0 reset app versions, so capabilities are negotiated with an explicit
// protocol number instead: protocol >= 2 understands attachment + history.
const FULL_PROTOCOL = 2;
// protocol >= 3 also answers `embed` messages (vector embeddings via Ollama).
const EMBED_PROTOCOL = 3;
// protocol >= 4 (worker 1.1.15+) decrypts E2E `history` / `attachment`.
// Before that the worker only decrypted them when they arrived as a STRING,
// but encrypt() yields an object, so every E2E worker silently dropped the
// conversation window (chats "forgot" earlier turns) and got ciphertext as
// the image. Older E2E workers get the window folded into the prompt, which
// they do decrypt, so context works without an update.
const E2E_PAYLOAD_PROTOCOL = 4;

// Worker-supplied error text shown in the panel: no control chars or markup.
function sanitizeWorkerText(raw) {
  return String(raw || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, 200);
}

// Render a conversation window as plain text in front of the new message.
function foldHistoryIntoPrompt(history, prompt) {
  const turns = history.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`);
  return '[Earlier in this conversation]\n'
    + `${turns.join('\n\n')}\n`
    + '[End of earlier conversation. Use it as context and reply to the new message below.]\n\n'
    + prompt;
}
// Embedding vectors: bounded so a hostile worker cannot balloon memory.
const MAX_EMBED_DIM = 8192;
const HEARTBEAT_STATUSES = new Set(['online', 'busy', 'offline']);
// How long an in-flight task waits for its worker to reconnect (1.1.10).
const RECONNECT_GRACE_MS = parseInt(process.env.WS_RECONNECT_GRACE_MS || '60000', 10);
const clampPct = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
};

// Power weight from free-form setup strings (gpu_model like
// "NVIDIA GeForce RTX 4090", ram like "16GB"). Unknown → 1. Used by the
// smooth weighted round-robin so stronger workers get proportionally more
// new sessions.
const GPU_TIERS = [
  [/h100|h800/i, 10], [/a100/i, 9], [/rtx\s*4090|a6000|a40/i, 8],
  [/rtx\s*4080|rtx\s*3090|apple\s*m4/i, 7], [/rtx\s*4070|rtx\s*3080|v100|apple\s*m3/i, 6],
  [/rtx\s*3070|rtx\s*4060\s*ti|apple\s*m2/i, 5], [/rtx\s*4060|rtx\s*3060|apple\s*m1/i, 4],
  [/tesla\s*t4|rtx\s*3050|rtx\s*2080|rtx\s*2070/i, 3],
  [/gtx\s*16|rtx\s*2060|quadro/i, 2],
];
function computeWeight(gpuModel) {
  if (typeof gpuModel !== 'string' || !gpuModel.trim()) return 1;
  for (const [re, tier] of GPU_TIERS) {
    if (re.test(gpuModel)) return tier;
  }
  return 1;
}

// History protocol gate (same scheme as workerSupportsMedia).
function workerSupportsHistory(version, protocol = 0) {
  if (Number(protocol) >= FULL_PROTOCOL) return true;
  if (!version) return false;
  const [maj = 0, min = 0] = String(version).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  return maj > HISTORY_APP_VERSION.major
    || (maj === HISTORY_APP_VERSION.major && min >= HISTORY_APP_VERSION.minor);
}

// v3.20.0 added the `attachment` field on task messages (images/voice notes).
// Older worker binaries destructure only {task_id, prompt, model} and would
// silently drop the attachment, so media tasks must only be handed to workers
// that advertised app_version >= 3.20.0 at auth. No version = old binary.
function workerSupportsMedia(version, protocol = 0) {
  if (Number(protocol) >= FULL_PROTOCOL) return true;
  if (!version) return false;
  const [maj = 0, min = 0] = String(version).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  return maj > 3 || (maj === 3 && min >= 20);
}

// Resolve the real client IP behind the reverse proxy.
// Trust order matters: nginx overwrites X-Real-IP and APPENDS the real peer to
// X-Forwarded-For, so the LAST hop is the only trustworthy one. Client-supplied
// CF-Connecting-IP / the first XFF entry must never be trusted — otherwise a
// spoofed 127.0.0.1 bypasses the auth rate limiter and the session-replacement
// guard (isLocalClient).
function resolveClientIp(headers, ws) {
  const realIp = headers['x-real-ip'];
  if (realIp) return String(realIp).trim();

  const xff = headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }

  if (ws._socket && ws._socket.remoteAddress) return ws._socket.remoteAddress;
  return 'unknown';
}

function isLocalClient(ws) {
  // Trust only the client-facing IP (_clientIp). Behind nginx, socket.remoteAddress
  // is always 127.0.0.1 and would wrongly mark every proxied worker as local.
  const ip = String(ws._clientIp || '');
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.endsWith('::ffff:127.0.0.1')
  );
}

class WSServer {
  constructor(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.workers = new Map();
    this.taskQueue = new Map();
    this.taskCallbacks = new Map();
    this.taskIdCounter = 1;
    // v3.41.0 routing state: session affinity + smooth-WRR cursors.
    this.affinity = new Map(); // sessionKey -> workerId
    this.wrr = new Map(); // routing key -> { workerId: currentWeight }
    // Per-IP failed WS auth attempts (rate limit)
    this.authFails = new Map();

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    this.wss.on('error', (err) => {
      logger.error({ err }, 'WebSocket server error');
    });

    // Cleanup dead workers every 60s (unref so the process can exit on shutdown)
    this.cleanupTimer = setInterval(() => this.cleanupWorkers(), 60000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();

    logger.info('WebSocket server started on /ws');
  }

  handleConnection(ws, req) {
    const headers = (req && req.headers) || (ws.upgradeReq && ws.upgradeReq.headers) || {};
    ws._clientIp = resolveClientIp(headers, ws);
    logger.info({ ip: ws._clientIp }, 'New WebSocket connection');

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        await this.handleMessage(ws, msg);
      } catch (err) {
        logger.error({ err }, 'WS message error');
        ws.send(JSON.stringify({ type: 'error', message: err.message || 'Invalid message format' }));
      }
    });

    ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf ? String(reasonBuf).slice(0, 120) : '';
      for (const [workerId, worker] of this.workers) {
        if (worker.ws === ws) {
          this.workers.delete(workerId);
          // B6 + 1.1.10: in-flight tasks used to be rejected the moment the
          // socket closed. Workers behind flaky links (NAT/proxy rotation)
          // drop and re-auth within seconds while Ollama keeps generating, and
          // send the result on the NEW socket — so hold each in-flight task
          // for RECONNECT_GRACE_MS and only then give up (the chat route
          // still answers WORKER_OFFLINE, retryable). The dispatch timeout
          // keeps running underneath, so nothing waits longer than before.
          const held = [];
          for (const [taskId, cb] of this.taskCallbacks) {
            if (cb.workerId === workerId && !cb.orphanTimer) {
              held.push(taskId);
              cb.orphanTimer = setTimeout(() => {
                const cur = this.taskCallbacks.get(taskId);
                if (cur !== cb) return;
                if (this.workers.has(workerId)) {
                  // Back online: keep waiting for the result (dispatch timeout applies).
                  cb.orphanTimer = null;
                  return;
                }
                clearTimeout(cb.timeout);
                this.taskCallbacks.delete(taskId);
                cb.reject(new Error('Worker disconnected'));
              }, RECONNECT_GRACE_MS);
              if (cb.orphanTimer.unref) cb.orphanTimer.unref();
            }
          }
          // M4: every row this worker had claimed ('processing' via chat
          // dispatch or a task_request poll) goes back to pending — except the
          // held chat dispatches above, which must stay claimed by this worker
          // so its result on the next socket is still accepted.
          pool.query(
            "UPDATE tasks SET status = 'pending' WHERE worker_id = $1 AND status = 'processing' AND NOT (id = ANY($2::int[]))",
            [workerId, held]
          ).catch((err) => logger.error({ err, workerId }, 'Failed to reset stranded processing tasks'));
          pool.query("UPDATE workers SET status = 'offline' WHERE id = $1", [workerId])
            .catch((err) => logger.error({ err, workerId }, 'Failed to mark worker offline'));
          invalidateCache('/api/workers');
          invalidateCache('/api/models');
          invalidateCache('/api/stats');
          this.interruptManageJob(workerId);
          logger.info({ workerId, code, reason, inFlight: held.length }, 'Worker disconnected');
        }
      }
    });

    ws.on('error', (err) => {
      logger.error({ err }, 'WebSocket error');
    });
  }

  async handleMessage(ws, msg) {
    switch (msg.type) {
      case 'auth':
        await this.handleAuth(ws, msg);
        break;
      case 'heartbeat':
        await this.handleHeartbeat(ws, msg);
        break;
      case 'task_result':
        await this.handleTaskResult(ws, msg);
        break;
      case 'embed_result':
        await this.handleEmbedResult(ws, msg);
        break;
      case 'task_request':
        await this.handleTaskRequest(ws, msg);
        break;
      case 'manage_progress':
        this.handleManageProgress(ws, msg);
        break;
      case 'manage_result':
        await this.handleManageResult(ws, msg);
        break;
      default:
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
    }
  }

  // Returns true when this IP has burned through its failed-auth budget
  authRateLimited(ws) {
    // Localhost (VPS-resident, incl. our own worker + proxied nginx path is NOT
    // local — _clientIp is the real client IP there) is trusted: rate limiting
    // targets remote token brute-force.
    if (isLocalClient(ws)) return false;
    const ip = ws._clientIp || 'unknown';
    const now = Date.now();
    const rec = this.authFails.get(ip);
    if (!rec || now - rec.windowStart > AUTH_FAIL_WINDOW) {
      if (rec) this.authFails.delete(ip);
      return false;
    }
    if (rec.count >= AUTH_FAIL_LIMIT) {
      ws.send(JSON.stringify({ type: 'auth_error', message: 'Too many failed attempts. Try again in 5 minutes.' }));
      try { ws.close(); } catch (e) {}
      return true;
    }
    return false;
  }

  recordAuthFailure(ws) {
    const ip = ws._clientIp || 'unknown';
    const now = Date.now();
    const rec = this.authFails.get(ip);
    if (!rec || now - rec.windowStart > AUTH_FAIL_WINDOW) {
      this.authFails.set(ip, { count: 1, windowStart: now });
    } else {
      rec.count += 1;
    }
  }

  async handleAuth(ws, msg) {
    const { wallet_address, e2e } = msg;
    // Pre-1.0 worker binaries still send the token under its old field name.
    const worker_token = msg.worker_token || msg[LEGACY_TOKEN_FIELD];
    // v3.20.0: workers advertise their version at auth so media dispatch can
    // target only workers that understand the `attachment` field on tasks.
    const appVersion = typeof msg.app_version === 'string' && msg.app_version
      ? msg.app_version.slice(0, 32)
      : null;
    const protocol = Number.isInteger(msg.protocol) ? msg.protocol : 0;
    // 1.2.0 remote model management: 'on' / 'off' (owner disabled it) /
    // null (worker app too old to support it).
    const manage = msg.manage === true ? 'on' : (msg.manage === false ? 'off' : null);
    // v3.41.0: workers report every installed model (verified against
    // `ollama list` client-side). Old binaries send nothing → single-model
    // fallback to current_model below.
    const reportedModels = Array.isArray(msg.models)
      ? msg.models.filter((m) => typeof m === 'string').map((m) => m.slice(0, 100)).slice(0, 32)
      : [];

    if (this.authRateLimited(ws)) return;

    // v3.31.0 (C1): worker_token is the ONLY worker identity. The old
    // "wallet_address or worker_token" check let anyone who knew (or guessed)
    // a wallet address authenticate as that worker — and auto-registered a row
    // when none existed — hijacking dispatches and earning share for a stranger.
    if (!worker_token) {
      this.recordAuthFailure(ws);
      ws.send(JSON.stringify({ type: 'auth_error', message: 'worker_token required (legacy wallet auth removed in v3.31.0 — get your token from the dashboard)' }));
      return;
    }

    // Token hygiene: reject malformed tokens before touching the DB
    if (!TOKEN_RE.test(worker_token)) {
      this.recordAuthFailure(ws);
      ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid worker token' }));
      return;
    }

    let result;
    let workerId;
    let authGpuModel = null;

    // If worker_token provided, find user's worker via token
    // v3.13.0 token-first model: each server-worker has its own unique token,
    // and the token IS the worker identity (unlimited workers per user).
    if (worker_token) {
      const workerRow = await pool.query(
        'SELECT id, status, gpu_model, ram FROM workers WHERE worker_token = $1',
        [worker_token]
      );
      if (workerRow.rows.length > 0) {
        if (workerRow.rows[0].status === 'removed') {
          ws.send(JSON.stringify({ type: 'auth_error', message: 'This worker was removed. Re-add it from your profile to use it again.' }));
          return;
        }
        workerId = workerRow.rows[0].id;
        authGpuModel = workerRow.rows[0].gpu_model || null;
        // v3.14.0: first successful auth marks token as used (hide from profile)
        await pool.query(
          "UPDATE workers SET status = 'online', token_used_at = COALESCE(token_used_at, CURRENT_TIMESTAMP), last_seen = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
          [workerId]
        );
        invalidateCache('/api/workers');
      } else {
        // Legacy account token (users.worker_token): unambiguous only when the
        // user has exactly 1 active worker.
        const userResult = await pool.query('SELECT id FROM users WHERE worker_token = $1', [worker_token]);
        if (userResult.rows.length === 0) {
          this.recordAuthFailure(ws);
          ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid worker token' }));
          return;
        }
        const userId = userResult.rows[0].id;
        const owned = await pool.query(
          `SELECT id FROM workers WHERE user_id = $1 AND (status IS NULL OR status != 'removed')
           ORDER BY id ASC`,
          [userId]
        );
        if (owned.rows.length === 1) {
          workerId = owned.rows[0].id;
          await pool.query("UPDATE workers SET status = 'online', last_seen = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [workerId]);
        } else if (owned.rows.length > 1) {
          ws.send(JSON.stringify({ type: 'auth_error', message: 'Multiple workers found. Use the per-worker token from your profile for this machine.' }));
          return;
        } else {
          const freshToken = 'pw_' + crypto.randomBytes(32).toString('hex');
          result = await pool.query(
            "INSERT INTO workers (user_id, wallet_address, worker_token, status) VALUES ($1, $2, $3, 'online') RETURNING id",
            [userId, wallet_address || '', freshToken]
          );
          workerId = result.rows[0].id;
        }
      }
    }
    // v3.31.0 (C1): the legacy wallet_address-only branch was removed here —
    // it trusted a client-supplied wallet with no proof and INSERTed worker
    // rows for it. worker_token (checked above) is now mandatory.

    // If this worker already has a live entry (stale/zombie connection),
    // close the old socket first so the map always points at the newest
    // connection. Otherwise dispatches and heartbeats split across two
    // sockets and the live worker gets "Not authenticated".
    const existing = this.workers.get(workerId);
    // Idempotent re-auth on the same socket: skip replace + duplicate work
    if (existing && existing.ws === ws) {
      existing.lastHeartbeat = Date.now();
      existing.status = 'online';
      if (appVersion) existing.app_version = appVersion;
      existing.protocol = protocol;
      existing.manage = manage;
      if (reportedModels.length > 0) existing.models = reportedModels;
      if (e2e && worker_token) {
        existing.e2eKey = deriveKey(worker_token);
      }
      ws.send(JSON.stringify({ type: 'auth_ok', worker_id: workerId, [LEGACY_ID_FIELD]: workerId, e2e: !!(existing.e2eKey) }));
      return;
    }
    if (existing && existing.ws && existing.ws !== ws) {
      // Heartbeat every 30s → allow up to 45s skew before treating as stale
      const oldHealthy = Date.now() - (existing.lastHeartbeat || 0) < 45000;
      const newIsLocal = isLocalClient(ws);
      if (oldHealthy && !newIsLocal) {
        logger.warn({ workerId, ip: ws._clientIp, existingIp: existing.ws._clientIp }, 'Rejected duplicate worker session');
        this.recordAuthFailure(ws);
        ws.send(JSON.stringify({ type: 'auth_error', message: 'Worker already connected. Stop the other session or wait for it to go offline.' }));
        try { ws.close(); } catch (e) {}
        return;
      }
      try {
        if (existing.ws.readyState === 1) {
          existing.ws.send(JSON.stringify({ type: 'error', message: 'Replaced by newer connection' }));
          existing.ws.close();
        }
      } catch (e) {}
      logger.info({ workerId, oldIp: existing.ws && existing.ws._clientIp, newIp: ws._clientIp }, 'Worker session replaced');
    }

    if (appVersion) {
      await pool.query('UPDATE workers SET app_version = $1 WHERE id = $2', [appVersion, workerId])
        .catch((err) => logger.warn({ err, workerId }, 'Failed to persist worker app_version'));
    }

    // v3.41.0: the live entry carries every installed model (dispatch
    // matches on the list, not just current_model) plus a power weight and
    // per-model failure counters for the down-marking below.
    this.workers.set(workerId, {
      id: workerId,
      ws,
      wallet_address: wallet_address || '',
      lastHeartbeat: Date.now(),
      models: reportedModels,
      modelHealth: (existing && existing.modelHealth) || {},
      weight: computeWeight(authGpuModel),
      status: 'online',
      current_model: (existing && existing.current_model) || null,
      app_version: appVersion || (existing && existing.app_version) || null,
      protocol,
      manage,
      // E2E key only when THIS auth advertised e2e support (never inherit from
      // a replaced session — an old worker binary replacing it must stay plaintext)
      e2eKey: (e2e && worker_token) ? deriveKey(worker_token) : null
    });

    // Update DB (v3.14.0: also mark token_used on first auth)
    await pool.query(
      "UPDATE workers SET status = 'online', token_used_at = COALESCE(token_used_at, CURRENT_TIMESTAMP), last_seen = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [workerId]
    );
    if (reportedModels.length > 0) {
      await pool.query('UPDATE workers SET models = $1::jsonb WHERE id = $2', [JSON.stringify(reportedModels), workerId])
        .catch((err) => logger.warn({ err, workerId }, 'Failed to persist worker models'));
    }
    invalidateCache('/api/workers');
    invalidateCache('/api/models');
    invalidateCache('/api/stats');

    // Successful auth resets this IP's failed-attempt counter
    this.authFails.delete(ws._clientIp || 'unknown');
    const session = this.workers.get(workerId);
    ws.send(JSON.stringify({ type: 'auth_ok', worker_id: workerId, [LEGACY_ID_FIELD]: workerId, e2e: !!session.e2eKey }));
    logger.info({ workerId, ip: ws._clientIp, e2e: !!session.e2eKey }, 'Worker authenticated');
  }

  async handleHeartbeat(ws, msg) {
    const worker = this.findWorkerByWs(ws);
    if (!worker) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      return;
    }

    const { gpu_usage, ram_usage, cpu_usage, disk_usage } = msg;
    // Every heartbeat field is worker-controlled: whitelist the status (a
    // worker must never mark itself 'removed'), bound the model name to the
    // column width and clamp usage to a percentage (NUMERIC(5,2) overflow
    // used to roll the whole heartbeat back).
    const status = HEARTBEAT_STATUSES.has(msg.status) ? msg.status : 'online';
    const current_model = typeof msg.current_model === 'string' && msg.current_model
      ? msg.current_model.slice(0, 50)
      : null;
    // v3.41.0: workers re-report every installed model each heartbeat (verified
    // against `ollama list` client-side). Old binaries omit it → keep Map state.
    const hbModels = Array.isArray(msg.models)
      ? msg.models.filter((m) => typeof m === 'string').map((m) => m.slice(0, 100)).slice(0, 32)
      : null;

    worker.lastHeartbeat = Date.now();
    worker.status = status;
    if (current_model) worker.current_model = current_model;
    let modelsChanged = false;
    if (hbModels && hbModels.length > 0) {
      const before = [...(worker.models || [])].sort().join(',');
      modelsChanged = hbModels.slice().sort().join(',') !== before;
      if (modelsChanged) worker.models = hbModels;
    }

    const statusValue = status;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE workers
         SET status = $1,
             uptime = CASE WHEN $8 = 'online' THEN LEAST(uptime + 0.1, 100) ELSE uptime END,
             current_model = COALESCE($3, current_model),
             gpu_usage = $4,
             ram_usage = $5,
             cpu_usage = $6,
             disk_usage = $7,
             last_seen = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [statusValue, worker.id, current_model,
         clampPct(gpu_usage), clampPct(ram_usage), clampPct(cpu_usage), clampPct(disk_usage), statusValue]
      );
      // Persist the installed-models list only when it actually changed —
      // not on every 30s heartbeat (write amplification).
      if (modelsChanged) {
        await client.query('UPDATE workers SET models = $1::jsonb WHERE id = $2', [JSON.stringify(hbModels), worker.id]);
      }
      invalidateCache('/api/workers');
      invalidateCache('/api/models');
      invalidateCache('/api/stats');
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, workerId: worker.id }, 'Heartbeat DB error');
    } finally {
      client.release();
    }

    ws.send(JSON.stringify({ type: 'heartbeat_ok' }));
  }

  async handleTaskResult(ws, msg) {
    let { task_id, response, tokens_used, error } = msg;

    if (!task_id) return;

    // v3.18.4: results only accepted from an authenticated worker session,
    // and only for tasks assigned to that worker (stops result forgery).
    const worker = this.findWorkerByWs(ws);
    if (!worker) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      return;
    }

    const taskRow = await pool.query('SELECT worker_id FROM tasks WHERE id = $1', [task_id]);
    if (taskRow.rows.length === 0) {
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown task' }));
      return;
    }
    if (taskRow.rows[0].worker_id !== worker.id) {
      // NULL worker_id tasks are never dispatched over WS, so a strict match
      // here blocks forged/foreign results without breaking legitimate flows.
      ws.send(JSON.stringify({ type: 'error', message: 'Task not assigned to this worker' }));
      return;
    }

    // Decrypt e2e payload when the session negotiated encryption
    let plainResponse = response;
    if (worker.e2eKey && response !== undefined && !isEncrypted(response)) {
      // Session negotiated e2e but plaintext arrived — refuse (downgrade/forge)
      logger.error({ taskId: task_id, workerId: worker.id }, 'Plaintext result rejected (e2e negotiated)');
      ws.send(JSON.stringify({ type: 'error', message: 'Plaintext result rejected (e2e required)' }));
      return;
    }
    if (isEncrypted(response)) {
      if (!worker.e2eKey) {
        ws.send(JSON.stringify({ type: 'error', message: 'E2E not negotiated' }));
        return;
      }
      try {
        plainResponse = decrypt(worker.e2eKey, response);
      } catch (err) {
        logger.error({ err, taskId: task_id, workerId: worker.id }, 'E2E decrypt failed');
        ws.send(JSON.stringify({ type: 'error', message: 'E2E decrypt failed' }));
        return;
      }
    }

    if (error) {
      // Same replay guard as the success branch: a duplicate error result for
      // an already-resolved (or re-dispatched-and-resolved) task must not
      // flip it back to failed or resolve a new pending callback.
      const failed = await pool.query(
        "UPDATE tasks SET response = $1, status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = $2 AND status IN ('pending', 'processing') RETURNING id",
        [error, task_id]
      );
      if (failed.rows.length === 0) {
        logger.warn({ taskId: task_id, workerId: worker.id }, 'Ignored replayed task_result (error)');
        return;
      }
    } else {
      // This handler only records the raw result. Billing (cost, worker earnings,
      // daily tokens) is owned exclusively by routes/chat.js so a task is never
      // paid twice and the user is always charged the published model price.
      // v3.45.0 (H1): tokens_used is worker-controlled and drives both the user
      // charge and the worker share — an out-of-bounds report is rejected here
      // (never persisted, never clamped) and resolved as a worker error so the
      // dispatcher fails over to the next candidate.
      const reported = Number(tokens_used);
      if (!Number.isFinite(reported) || reported < 0 || reported > MAX_TASK_TOKENS) {
        logger.warn(
          { taskId: task_id, workerId: worker.id, tokens_used },
          'Rejected worker result: tokens_used out of bounds'
        );
        const failed = await pool.query(
          "UPDATE tasks SET response = $1, status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = $2 AND status IN ('pending', 'processing') RETURNING id",
          ['tokens_used out of bounds', task_id]
        );
        if (failed.rows.length === 0) {
          logger.warn({ taskId: task_id, workerId: worker.id }, 'Ignored replayed task_result (error)');
          return;
        }
        error = 'tokens_used out of bounds';
      } else {
        const updated = await pool.query(
          `UPDATE tasks
              SET response = $1, tokens_used = $2, status = 'completed', completed_at = CURRENT_TIMESTAMP
            WHERE id = $3 AND status IN ('pending', 'processing')
            RETURNING id`,
          [plainResponse, reported, task_id]
        );

        if (updated.rows.length === 0) {
          // Replay of an already-resolved task: do not touch counters or state.
          logger.warn({ taskId: task_id, workerId: worker.id }, 'Ignored replayed task_result');
          return;
        }
        tokens_used = reported;
      }
    }

    // Callback for pending task
    const callback = this.taskCallbacks.get(task_id);
    if (callback) {
      clearTimeout(callback.timeout);
      if (callback.orphanTimer) clearTimeout(callback.orphanTimer);
      this.taskCallbacks.delete(task_id);
      callback.resolve({ response: plainResponse, tokens_used, error });
    }
  }

  async handleTaskRequest(ws, msg) {
    // Worker is requesting a task (polling mode)
    const worker = this.findWorkerByWs(ws);
    if (!worker) return;

    // Find pending task for this worker. Older workers must not pick up media
    // tasks (they would silently drop the attachment) — those stay pending
    // until a v3.20.0+ worker asks or the request path fails explicitly.
    const mediaCapable = workerSupportsMedia(worker.app_version, worker.protocol);
    const result = await pool.query(
      `SELECT id, prompt, prepared_prompt, media, model FROM tasks
        WHERE worker_id = $1 AND status = 'pending'
        ORDER BY created_at ASC LIMIT 50`,
      [worker.id]
    );

    for (const task of result.rows) {
      const needsMedia = task.media && (task.media.type === 'image' || task.media.type === 'audio');
      if (needsMedia && !mediaCapable) continue;

      const upd = await pool.query(
        "UPDATE tasks SET status = 'processing' WHERE id = $1 AND status = 'pending' RETURNING id",
        [task.id]
      );
      if (upd.rows.length === 0) continue; // another connection claimed it
      const payload = {
        type: 'task',
        task_id: task.id,
        prompt: worker.e2eKey ? encrypt(worker.e2eKey, task.prepared_prompt || task.prompt) : (task.prepared_prompt || task.prompt),
        model: task.model
      };
      if (needsMedia) {
        payload.attachment = worker.e2eKey ? encrypt(worker.e2eKey, JSON.stringify(task.media)) : task.media;
      }
      ws.send(JSON.stringify(payload));
      return;
    }
  }

  findWorkerByWs(ws) {
    for (const [, worker] of this.workers) {
      if (worker.ws === ws) return worker;
    }
    return null;
  }

  // Dispatch task to a specific worker
  // NOTE: CPU-only workers need ~2-3 min for an 8B model (model load + inference),
  // so the timeout must stay well above the 60s it used to be.
  // media (image/audio {type,name,mime,data} base64) rides as `attachment`,
  // encrypted the same way the prompt is when E2E is negotiated.
  // history (v3.41.0: [{role, content}...], sliding window built by the chat
  // route) rides the same way — old workers simply never receive it because
  // the router only picks history-capable workers when history is non-empty.
  async dispatchTask(workerId, taskId, prompt, model, media = null, history = [], timeoutMs = 180000) {
    // Back-compat: dispatchTask(id, task, prompt, model, media, timeoutMs) —
    // history was inserted before timeoutMs in v3.41.0.
    if (typeof history === 'number') {
      timeoutMs = history;
      history = [];
    }
    return new Promise((resolve, reject) => {
      const worker = this.workers.get(workerId);
      if (!worker) {
        reject(new Error('Worker not connected'));
        return;
      }

      const timeout = setTimeout(() => {
        this.taskCallbacks.delete(taskId);
        // M4: nobody will answer this dispatch — hand the row back to
        // 'pending' instead of leaving it stranded in 'processing' (the chat
        // request answers WORKER_OFFLINE; the worker can re-claim via its
        // task_request poll if it comes back).
        pool.query("UPDATE tasks SET status = 'pending' WHERE id = $1 AND status = 'processing'", [taskId])
          .catch((err) => logger.error({ err, taskId }, 'Failed to reset timed-out task'));
        reject(new Error('Task timeout'));
      }, timeoutMs);

      // workerId lets the close handler find this worker's in-flight tasks
      // (held for RECONNECT_GRACE_MS, then rejected — B6 / 1.1.10).
      this.taskCallbacks.set(taskId, { resolve, reject, timeout, workerId });

      const histWindow = Array.isArray(history) ? history.slice(-32) : [];
      // Old E2E workers cannot read an encrypted `history` field (see
      // E2E_PAYLOAD_PROTOCOL): give them the window inside the prompt.
      const foldHistory = histWindow.length > 0 && !!worker.e2eKey
        && !(Number(worker.protocol) >= E2E_PAYLOAD_PROTOCOL);
      const text = foldHistory ? foldHistoryIntoPrompt(histWindow, prompt) : prompt;
      const payload = {
        type: 'task',
        task_id: taskId,
        prompt: worker.e2eKey ? encrypt(worker.e2eKey, text) : text,
        model
      };
      if (media) {
        payload.attachment = worker.e2eKey
          ? encrypt(worker.e2eKey, JSON.stringify(media))
          : media;
      }
      if (histWindow.length > 0 && !foldHistory) {
        payload.history = worker.e2eKey
          ? encrypt(worker.e2eKey, JSON.stringify(histWindow))
          : histWindow;
      }
      worker.ws.send(JSON.stringify(payload));
    });
  }

  // Embedding dispatch: `inputs` is an array of strings; the worker answers
  // with `embed_result` { task_id, embeddings: number[][], tokens_used }.
  // Encrypted like every other payload when E2E was negotiated.
  async dispatchEmbed(workerId, taskId, model, inputs, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const worker = this.workers.get(workerId);
      if (!worker) {
        reject(new Error('Worker not connected'));
        return;
      }
      const timeout = setTimeout(() => {
        this.taskCallbacks.delete(taskId);
        reject(new Error('Task timeout'));
      }, timeoutMs);
      this.taskCallbacks.set(taskId, { resolve, reject, timeout, workerId, embed: inputs.length });
      worker.ws.send(JSON.stringify({
        type: 'embed',
        task_id: taskId,
        model,
        input: worker.e2eKey ? encrypt(worker.e2eKey, JSON.stringify(inputs)) : inputs,
      }));
    });
  }

  async handleEmbedResult(ws, msg) {
    const worker = this.findWorkerByWs(ws);
    if (!worker) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      return;
    }
    const cb = this.taskCallbacks.get(msg.task_id);
    // Only the worker this embed was dispatched to may answer it, once.
    if (!cb || !cb.embed || cb.workerId !== worker.id) {
      ws.send(JSON.stringify({ type: 'error', message: 'Task not assigned to this worker' }));
      return;
    }
    this.taskCallbacks.delete(msg.task_id);
    clearTimeout(cb.timeout);
    if (cb.orphanTimer) clearTimeout(cb.orphanTimer);

    if (msg.error) {
      cb.resolve({ error: String(msg.error).slice(0, 200) });
      return;
    }
    let vectors = msg.embeddings;
    try {
      if (worker.e2eKey) {
        if (!isEncrypted(vectors)) throw new Error('Plaintext result rejected (e2e required)');
        vectors = JSON.parse(decrypt(worker.e2eKey, vectors));
      } else if (isEncrypted(vectors)) {
        throw new Error('E2E not negotiated');
      }
    } catch (err) {
      cb.resolve({ error: err.message });
      return;
    }
    const valid = Array.isArray(vectors)
      && vectors.length === cb.embed
      && vectors.every((v) => Array.isArray(v) && v.length > 0 && v.length <= MAX_EMBED_DIM
        && v.length === vectors[0].length && v.every((x) => typeof x === 'number' && Number.isFinite(x)));
    if (!valid) {
      cb.resolve({ error: 'invalid embeddings payload' });
      return;
    }
    cb.resolve({ embeddings: vectors, tokens_used: msg.tokens_used });
  }

  // Effective installed list: reported models, or the single legacy
  // current_model for old binaries that never send `models`.
  effectiveModels(worker) {
    if (Array.isArray(worker.models) && worker.models.length > 0) return worker.models;
    return worker.current_model ? [worker.current_model] : [];
  }

  // Failure-driven health (v3.41.0): N consecutive task errors take a model
  // out of rotation for that worker — no active probing, no GPU burned.
  // A success resets the counter; the panel reads this via liveModels().
  modelDown(worker, model) {
    return ((worker.modelHealth || {})[model] || 0) >= MODEL_DOWN_AFTER_FAILS;
  }

  recordModelResult(workerId, model, ok) {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    worker.modelHealth = worker.modelHealth || {};
    if (ok) {
      if (worker.modelHealth[model]) delete worker.modelHealth[model];
    } else {
      worker.modelHealth[model] = (worker.modelHealth[model] || 0) + 1;
      if (worker.modelHealth[model] === MODEL_DOWN_AFTER_FAILS) {
        logger.warn({ workerId, model }, 'Model marked down for worker after consecutive failures');
      }
    }
  }

  // Single predicate for "can this worker serve this task right now".
  workerServes(worker, model, needsMedia = false, needHistory = false, needEmbed = false) {
    if (!worker || worker.status !== 'online') return false;
    if (needEmbed && !(Number(worker.protocol) >= EMBED_PROTOCOL)) return false;
    if (needsMedia && !workerSupportsMedia(worker.app_version, worker.protocol)) return false;
    if (needHistory && !workerSupportsHistory(worker.app_version, worker.protocol)) return false;
    if (!this.effectiveModels(worker).includes(model)) return false;
    if (this.modelDown(worker, model)) return false;
    return true;
  }

  // Find best available worker for a model (v3.40.0: EXACT match only).
  // The chat route never substitutes another model's output anymore — a
  // non-exact request gets MODEL_UNAVAILABLE with alternatives instead.
  // needsMedia: only workers running >= 3.20.0 (which understand `attachment`).
  findWorkerForModel(model, needsMedia = false) {
    const all = this.findWorkersForModel(model, needsMedia);
    return all.length > 0 ? all[0] : null;
  }

  // All online workers holding the exact model, in registration order.
  // v3.41.0: matches on the installed-models list (multi-model workers serve
  // every pulled model at once), honours per-model down-marking, and can
  // require history support when the task carries conversation context.
  findWorkersForModel(model, needsMedia = false, needHistory = false, needEmbed = false) {
    const out = [];
    for (const [workerId, worker] of this.workers) {
      if (this.workerServes(worker, model, needsMedia, needHistory, needEmbed)) {
        out.push({ workerId, model });
      }
    }
    return out;
  }

  // Usable workers regardless of model — lets the chat route tell
  // WORKER_OFFLINE (nothing online) apart from MODEL_UNAVAILABLE.
  countUsableWorkers(needsMedia = false) {
    let n = 0;
    for (const [, worker] of this.workers) {
      if (worker.status === 'online' && (!needsMedia || workerSupportsMedia(worker.app_version, worker.protocol))) n++;
    }
    return n;
  }

  // Online worker counts per model — feeds MODEL_UNAVAILABLE alternatives.
  // v3.41.0: a multi-model worker counts once in every bucket it serves.
  // historyCapable narrows to workers that understand the `history` field.
  onlineModelCounts(needsMedia = false, historyCapable = false) {
    const counts = {};
    for (const [, worker] of this.workers) {
      if (worker.status !== 'online') continue;
      if (needsMedia && !workerSupportsMedia(worker.app_version, worker.protocol)) continue;
      if (historyCapable && !workerSupportsHistory(worker.app_version, worker.protocol)) continue;
      const models = this.effectiveModels(worker);
      const list = models.length > 0 ? models : ['llama3.1:8b'];
      for (const m of new Set(list)) {
        if (this.modelDown(worker, m)) continue;
        counts[m] = (counts[m] || 0) + 1;
      }
    }
    return counts;
  }

  // In-flight dispatches per worker (spillover guard below).
  inflightCount(workerId) {
    let n = 0;
    for (const [, cb] of this.taskCallbacks) {
      if (cb.workerId === workerId) n++;
    }
    return n;
  }

  // Smooth weighted round-robin (nginx-style): stronger workers win new
  // sessions proportionally more often. State is per routing key.
  pickWeighted(candidates, key) {
    if (candidates.length === 1) return candidates[0];
    let state = this.wrr.get(key);
    if (!state) {
      state = {};
      this.wrr.set(key, state);
    }
    let total = 0;
    let best = null;
    for (const cand of candidates) {
      const worker = this.workers.get(cand.workerId);
      const w = Math.max(1, Number((worker && worker.weight) || 1));
      total += w;
      const cur = (state[cand.workerId] || 0) + w;
      state[cand.workerId] = cur;
      if (!best || cur > state[best.workerId]) best = cand;
    }
    state[best.workerId] -= total;
    return best;
  }

  // v3.41.0 routing: sticky session + weighted RR + spillover.
  // - A known session sticks to its worker while that worker stays capable
  //   (online + holds the model + media/history ok + not down-marked).
  // - If the sticky worker has SPILL_CAP in-flight tasks, overflow goes to
  //   the WRR pick instead of queueing behind it.
  // - Unknown sessions (guests without session, first message) go straight
  //   to WRR. `exclude` skips already-tried workers during failover.
  pickCandidate({ model, needsMedia = false, needHistory = false, needEmbed = false, sessionKey = null, exclude = null }) {
    const cands = this.findWorkersForModel(model, needsMedia, needHistory, needEmbed)
      .filter((c) => !(exclude && exclude.has(c.workerId)));
    if (cands.length === 0) return null;
    if (sessionKey) {
      const mapped = this.affinity.get(sessionKey);
      const sticky = mapped && cands.find((c) => c.workerId === mapped);
      if (sticky && this.inflightCount(sticky.workerId) < SPILL_CAP) return sticky;
    }
    const pick = this.pickWeighted(cands, `${model}#${needsMedia ? 'm' : ''}${needHistory ? 'h' : ''}${needEmbed ? 'e' : ''}`);
    if (sessionKey) {
      this.affinity.set(sessionKey, pick.workerId);
      if (this.affinity.size > 50000) {
        const first = this.affinity.keys().next();
        if (!first.done) this.affinity.delete(first.value);
      }
    }
    return pick;
  }

  // Live per-worker model roster for the panel (installed + down-marked).
  // ---- Remote model management (1.2.0) --------------------------------
  // One job per worker, held in memory: the panel polls it for progress.
  // The worker only accepts `pull` / `remove` of a model name (see
  // worker-app/src/services/manager.js); the route checks ownership and the
  // catalog before anything reaches here.

  manageJobs() {
    if (!this.manageJobMap) this.manageJobMap = new Map();
    return this.manageJobMap;
  }

  getManageJob(workerId) {
    return this.manageJobs().get(workerId) || null;
  }

  // Returns { job } or { error, code }.
  startManage(workerId, action, model, sizeGb = 0) {
    const worker = this.workers.get(workerId);
    if (!worker || worker.status !== 'online' || !worker.ws) return { error: 'Worker is offline', code: 'WORKER_OFFLINE' };
    if (worker.manage === 'off') return { error: 'Remote management is turned off on this worker', code: 'MANAGE_DISABLED' };
    if (worker.manage !== 'on') return { error: 'Update the worker app once to manage models from the panel', code: 'MANAGE_UNSUPPORTED' };
    const current = this.getManageJob(workerId);
    if (current && current.status === 'running') return { error: `Busy: ${current.action} ${current.model} is still running`, code: 'MANAGE_BUSY' };
    const job = {
      id: crypto.randomUUID(),
      action,
      model,
      status: 'running',
      phase: '',
      completed: 0,
      total: 0,
      error: null,
      started_at: new Date().toISOString(),
      finished_at: null,
    };
    try {
      worker.ws.send(JSON.stringify({ type: 'manage', id: job.id, action, model, size_gb: sizeGb }));
    } catch (err) {
      return { error: 'Worker is offline', code: 'WORKER_OFFLINE' };
    }
    this.manageJobs().set(workerId, job);
    return { job };
  }

  manageJobFor(ws, msg) {
    const worker = this.findWorkerByWs(ws);
    if (!worker) return null;
    const job = this.getManageJob(worker.id);
    if (!job || job.id !== msg.id || job.status !== 'running') return null;
    return { worker, job };
  }

  handleManageProgress(ws, msg) {
    const hit = this.manageJobFor(ws, msg);
    if (!hit) return;
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);
    hit.job.phase = typeof msg.status === 'string' ? msg.status.replace(/[^\w .:-]/g, '').slice(0, 60) : '';
    hit.job.total = num(msg.total);
    hit.job.completed = Math.min(num(msg.completed), hit.job.total || num(msg.completed));
  }

  async handleManageResult(ws, msg) {
    const hit = this.manageJobFor(ws, msg);
    if (!hit) return;
    const { worker, job } = hit;
    job.finished_at = new Date().toISOString();
    if (!msg.ok) {
      job.status = 'failed';
      job.error = sanitizeWorkerText(msg.error) || 'Failed';
      logger.warn({ workerId: worker.id, action: job.action, model: job.model, err: job.error }, 'Remote model management failed');
      return;
    }
    job.status = 'done';
    if (job.total) job.completed = job.total;
    const models = Array.isArray(msg.models)
      ? msg.models.filter((m) => typeof m === 'string').map((m) => m.slice(0, 100)).slice(0, 32)
      : [];
    if (models.length > 0) {
      worker.models = models;
      if (job.action === 'pull' && worker.modelHealth) delete worker.modelHealth[job.model];
      await pool.query('UPDATE workers SET models = $1::jsonb WHERE id = $2', [JSON.stringify(models), worker.id])
        .catch((err) => logger.warn({ err, workerId: worker.id }, 'Failed to persist worker models'));
      invalidateCache('/api/workers');
      invalidateCache('/api/models');
    }
    logger.info({ workerId: worker.id, action: job.action, model: job.model }, 'Remote model management done');
  }

  interruptManageJob(workerId) {
    const job = this.getManageJob(workerId);
    if (job && job.status === 'running') {
      job.status = 'failed';
      job.error = 'Worker disconnected during the operation';
      job.finished_at = new Date().toISOString();
    }
  }

  liveModels() {
    const out = {};
    for (const [workerId, worker] of this.workers) {
      if (worker.status !== 'online') continue;
      out[workerId] = this.effectiveModels(worker).map((m) => ({
        id: m,
        down: this.modelDown(worker, m),
      }));
    }
    return out;
  }

  cleanupWorkers() {
    const now = Date.now();
    for (const [workerId, worker] of this.workers) {
      if (now - worker.lastHeartbeat > 120000) {
        this.workers.delete(workerId);
        pool.query("UPDATE workers SET status = 'offline' WHERE id = $1", [workerId])
          .catch((err) => logger.error({ err, workerId }, 'Failed to mark worker offline'));
        invalidateCache('/api/workers');
        invalidateCache('/api/models');
        invalidateCache('/api/stats');
        logger.info({ workerId }, 'Worker marked offline (no heartbeat)');
      }
    }
  }

  // Graceful shutdown: drop timers, fail in-flight dispatches, close sockets.
  async close() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const [, cb] of this.taskCallbacks) {
      clearTimeout(cb.timeout);
      if (cb.orphanTimer) clearTimeout(cb.orphanTimer);
      try { cb.reject(new Error('Server shutting down')); } catch (e) { /* already settled */ }
    }
    this.taskCallbacks.clear();
    for (const [, worker] of this.workers) {
      try { worker.ws.close(); } catch (e) { /* noop */ }
    }
    this.workers.clear();
    await new Promise((resolve) => this.wss.close(() => resolve()));
  }

  getOnlineWorkers() {
    const online = [];
    for (const [workerId, worker] of this.workers) {
      if (worker.status === 'online') {
        online.push({ id: workerId, wallet_address: worker.wallet_address, model: worker.current_model });
      }
    }
    return online;
  }
}

module.exports = WSServer;
module.exports.computeWeight = computeWeight;
module.exports.workerSupportsHistory = workerSupportsHistory;
module.exports.EMBED_PROTOCOL = EMBED_PROTOCOL;
module.exports.E2E_PAYLOAD_PROTOCOL = E2E_PAYLOAD_PROTOCOL;
module.exports.foldHistoryIntoPrompt = foldHistoryIntoPrompt;
