const WebSocket = require('ws');
const { PINNED_ROOTS } = require('./tls-roots');
const { deriveKey, encrypt, decrypt, isEncrypted } = require('./e2e');

// pw_ tokens (1.0.0+) and legacy kz_ tokens both carry an e2e-capable identity.
const isWorkerToken = (t) => typeof t === 'string' && /^(pw|kz)_/.test(t);
// Capability protocol advertised at auth (server: FULL_PROTOCOL in ws.js).
// 2 = understands `attachment` + `history` on task messages;
// 3 = also answers `embed` messages (only when an embed handler is wired).
const PROTOCOL_CHAT = 2;
const PROTOCOL_EMBED = 3;

class WorkerWebSocket {
  constructor(walletAddress, onTask, onEmbed = null) {
    this.walletAddress = walletAddress;
    this.onTask = onTask;
    // (model, inputs) => { embeddings, prompt_eval_count }
    this.onEmbed = onEmbed;
    this.lastReauthAt = 0;
    this.ws = null;
    this.workerId = null;
    this.connected = false;
    this.reconnectDelay = 5000;
    this.reconnectTimer = null;
    this.intentionalClose = false;
    this.authed = false;
    this.heartbeatInterval = null;
    this.heartbeatWorkerService = null;
    this.heartbeatDefaultModel = null;
    // every installed model (verified against `ollama list` by the
    // entry point) — reported at auth + heartbeat so the server can route
    // any of them to this worker.
    this.installedModels = [];
    this.e2eEnabled = false;
    // M3: consecutive auth rejections — the server may reject a rotated or
    // revoked token forever; retrying silently writes DB rows every few
    // seconds for the lifetime of the box. Cap it and die loudly instead.
    this.authFailCount = 0;
    // M4: task results produced while the socket was down are held here and
    // flushed on the next successful auth instead of being dropped.
    this.pendingResults = [];
  }

  connect() {
    // Never stack sockets — close any previous connection first
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.intentionalClose = true;
      try {
        this.ws.removeAllListeners();
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close();
        }
      } catch (e) {}
      this.ws = null;
    }

    this.intentionalClose = false;
    this.authed = false;
    const wsUrl = process.env.API_WS_URL || 'wss://plankton.click:443/ws';
    const isLocal = /^wss?:\/\/(127\.0\.0\.1|localhost|::1)/.test(wsUrl);
    // full TLS verification with pinned ISRG roots (PLANKTON_PIN=0 → system CAs)
    const pinEnabled = process.env.PLANKTON_PIN !== '0';
    const ws = new WebSocket(wsUrl, isLocal ? {} : {
      ca: pinEnabled ? PINNED_ROOTS : undefined,
      servername: 'plankton.click',
    });
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      console.log('🔌 Connected to Plankton Network');
      this.connected = true;
      this.reconnectDelay = 5000;
      this.authenticate();
    });

    ws.on('message', (data) => {
      if (this.ws !== ws) return;
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (err) {
        console.error('Invalid WS message:', err.message);
      }
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;
      console.log('🔌 Disconnected from Plankton Network');
      this.connected = false;
      this.authed = false;
      this.stopHeartbeat();
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      if (this.ws !== ws) return;
      console.error('WebSocket error:', err.message);
    });
  }

  setModels(models) {
    if (Array.isArray(models)) {
      this.installedModels = models
        .filter((m) => typeof m === 'string')
        .map((m) => m.slice(0, 100))
        .slice(0, 32);
    }
  }

  authenticate() {
    // Send worker_token (primary) or wallet_address (legacy).
    // each server-worker has its own unique token, and the token
    // IS the worker identity — no machine_id needed.
    const authMsg = { type: 'auth' };
    // the server only routes media tasks (images/voice notes) to
    // workers that advertise a version new enough to handle `attachment`.
    authMsg.app_version = require('../../package.json').version;
    authMsg.protocol = this.onEmbed ? PROTOCOL_EMBED : PROTOCOL_CHAT;
    // advertise every installed model for multi-model routing.
    if (this.installedModels.length > 0) authMsg.models = this.installedModels;
    if (isWorkerToken(this.walletAddress)) {
      authMsg.worker_token = this.walletAddress;
      authMsg.e2e = 1;
    } else {
      authMsg.wallet_address = this.walletAddress;
    }
    this.send(authMsg);
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'auth_ok':
        this.workerId = msg.worker_id;
        this.authed = true;
        this.authFailCount = 0;
        this.e2eEnabled = !!msg.e2e && isWorkerToken(this.walletAddress);
        console.log(`✅ Authenticated as worker #${this.workerId}${this.e2eEnabled ? ' (e2e)' : ''}`);
        this.ensureHeartbeat();
        // Push model immediately so DB current_model updates without waiting 30s
        this.sendHeartbeat('online', { current_model: this.heartbeatDefaultModel });
        // M4: deliver results the previous socket dropped, then ask the
        // server for anything already assigned/pending (polling branch).
        this.flushResults();
        this.requestTask();
        break;

      case 'auth_error':
        // M3: an auth rejection is not a transient network blip — stop the
        // heartbeat (no more DB writes), retry a bounded number of times,
        // then exit non-zero so `systemctl status` shows the failure.
        this.stopHeartbeat();
        this.authFailCount += 1;
        console.error(`Auth failed (${this.authFailCount}/5): ${msg.message}`);
        if (this.authFailCount >= 5) {
          console.error('❌ Fatal: authentication keeps being rejected — check the worker token in the dashboard (plankton.click/profile). Giving up.');
          this.intentionalClose = true;
          process.exit(1);
        }
        try {
          if (this.ws) this.ws.close();
        } catch (e) {}
        break;

      case 'heartbeat_ok':
        break;

      case 'task':
        this.handleTask(msg);
        break;

      case 'embed':
        this.handleEmbed(msg);
        break;

      case 'error':
        console.error('Server error:', msg.message);
        if (
          msg.message === 'Not authenticated' &&
          this.workerId &&
          this.ws && this.ws.readyState === WebSocket.OPEN &&
          Date.now() - this.lastReauthAt > 10000
        ) {
          this.lastReauthAt = Date.now();
          console.log('🔄 Re-authenticating...');
          this.authenticate();
        }
        // "Replaced by newer connection" → close handler will reconnect once
        break;
    }
  }

  async handleTask(msg) {
    const { task_id, prompt, model, attachment } = msg;
    console.log(`📥 Received task #${task_id} (${model})`);

    try {
      let plainPrompt = prompt;
      if (isEncrypted(prompt)) {
        if (!isWorkerToken(this.walletAddress)) {
          throw new Error('Encrypted task but no e2e key');
        }
        plainPrompt = decrypt(deriveKey(this.walletAddress), prompt);
      }

      // optional media payload — { type, name, mime, data(base64) }.
      // Encrypted as a JSON string when e2e is negotiated, plain object otherwise.
      let media = null;
      if (attachment) {
        let plainAttachment = attachment;
        if (typeof attachment === 'string' && isEncrypted(attachment)) {
          if (!isWorkerToken(this.walletAddress)) {
            throw new Error('Encrypted attachment but no e2e key');
          }
          plainAttachment = decrypt(deriveKey(this.walletAddress), attachment);
        }
        media = typeof plainAttachment === 'string' ? JSON.parse(plainAttachment) : plainAttachment;
      }

      // optional conversation window — [{ role, content }...],
      // encrypted as a JSON string when e2e is negotiated. Old entry points
      // ignore the 4th onTask argument (backward compatible).
      let history = [];
      if (msg.history) {
        let plainHistory = msg.history;
        if (typeof msg.history === 'string' && isEncrypted(msg.history)) {
          if (!isWorkerToken(this.walletAddress)) {
            throw new Error('Encrypted history but no e2e key');
          }
          plainHistory = decrypt(deriveKey(this.walletAddress), msg.history);
        }
        const parsed = typeof plainHistory === 'string' ? JSON.parse(plainHistory) : plainHistory;
        if (Array.isArray(parsed)) {
          history = parsed
            .filter((h) => h && typeof h.content === 'string')
            .map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content.slice(0, 65536) }))
            .slice(-32);
        }
      }

      const result = await this.onTask(plainPrompt, model, media, history);

      if (!result || !result.response) {
        throw new Error('Empty response from model');
      }

      this.sendResult({
        type: 'task_result',
        task_id,
        response: this.e2eEnabled
          ? encrypt(deriveKey(this.walletAddress), result.response)
          : result.response,
        tokens_used: result.eval_count || 0
      });

      console.log(`✅ Task #${task_id} completed (${result.eval_count || 0} tokens)`);

    } catch (err) {
      console.error(`❌ Task #${task_id} failed:`, err.message);
      this.sendResult({
        type: 'task_result',
        task_id,
        error: err.message
      });
    }
  }

  async handleEmbed(msg) {
    const { task_id, model } = msg;
    try {
      if (!this.onEmbed) throw new Error('Embeddings not supported by this worker');
      let inputs = msg.input;
      if (isEncrypted(inputs)) {
        if (!isWorkerToken(this.walletAddress)) throw new Error('Encrypted input but no e2e key');
        inputs = JSON.parse(decrypt(deriveKey(this.walletAddress), inputs));
      }
      if (!Array.isArray(inputs) || inputs.some((x) => typeof x !== 'string')) {
        throw new Error('Invalid embed input');
      }
      console.log(`📥 Received embed #${task_id} (${model}, ${inputs.length} input(s))`);
      const out = await this.onEmbed(model, inputs);
      if (!out || !Array.isArray(out.embeddings) || out.embeddings.length !== inputs.length) {
        throw new Error('Embedding model returned no vectors');
      }
      this.send({
        type: 'embed_result',
        task_id,
        embeddings: this.e2eEnabled
          ? encrypt(deriveKey(this.walletAddress), JSON.stringify(out.embeddings))
          : out.embeddings,
        tokens_used: out.prompt_eval_count || 0,
      });
      console.log(`✅ Embed #${task_id} completed (${out.prompt_eval_count || 0} tokens)`);
    } catch (err) {
      console.error(`❌ Embed #${task_id} failed:`, err.message);
      this.send({ type: 'embed_result', task_id, error: err.message });
    }
  }

  sendHeartbeat(status = 'online', stats = {}) {
    const payload = {
      type: 'heartbeat',
      status,
      cpu_usage: stats.cpu_usage || 0,
      ram_usage: stats.ram_usage || 0,
      gpu_usage: stats.gpu_usage || 0,
      disk_usage: stats.disk_usage || 0,
      current_model: stats.current_model
    };
    // re-report installed models so added/removed models take
    // effect without reconnecting.
    if (this.installedModels.length > 0) payload.models = this.installedModels;
    console.log(`💓 Sending heartbeat (model: ${stats.current_model || '?'}, ws: ${this.ws ? this.ws.readyState : 'none'})`);
    this.send(payload);
  }

  requestTask() {
    this.send({ type: 'task_request' });
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  // M4: task results must never be dropped because the socket died while
  // Ollama was generating — buffer them while offline and flush after the
  // next auth_ok. The buffer is capped so a long outage can't grow it
  // without bound; the server ignores results for already-resolved tasks.
  sendResult(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
      return;
    }
    this.pendingResults.push(data);
    if (this.pendingResults.length > 20) {
      this.pendingResults.shift();
      console.warn('⚠️  Result buffer full — dropped the oldest pending result');
    }
    console.log(`📦 Socket offline — buffered task result (${this.pendingResults.length} pending)`);
  }

  flushResults() {
    if (this.pendingResults.length === 0) return;
    const pending = this.pendingResults;
    this.pendingResults = [];
    for (const data of pending) {
      this.sendResult(data); // re-buffers itself if the socket closed again
    }
    console.log(`📤 Flushed buffered results (${pending.length} attempted)`);
  }

  startHeartbeat(workerService, defaultModel) {
    this.heartbeatWorkerService = workerService;
    this.heartbeatDefaultModel = defaultModel;
    this.ensureHeartbeat();
  }

  ensureHeartbeat() {
    if (this.heartbeatInterval) return;
    if (!this.heartbeatWorkerService && !this.heartbeatDefaultModel) return;
    console.log(`💓 Heartbeat started (every 30s, model: ${this.heartbeatDefaultModel})`);
    this.heartbeatInterval = setInterval(() => {
      const stats = this.heartbeatWorkerService
        ? this.heartbeatWorkerService.getStats()
        : {};
      stats.current_model = this.heartbeatDefaultModel;
      this.sendHeartbeat('online', stats);
    }, 30000);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    console.log(`Reconnecting in ${this.reconnectDelay / 1000}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
  }

  disconnect() {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    this.connected = false;
    this.authed = false;
  }
}

module.exports = WorkerWebSocket;
