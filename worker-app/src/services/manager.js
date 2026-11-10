// Remote model management (1.2.0): the owner installs or removes Ollama
// models from the worker panel on plankton.click instead of a console.
//
// Deliberately narrow. The server can only ask for two actions, `pull` and
// `remove`, of a model NAME; nothing here runs a shell command, and the name
// is checked against Ollama's tag syntax before it reaches Ollama's HTTP API.
// The owner can switch it off with `"remote_manage": false` in config.json
// or PLANKTON_REMOTE_MANAGE=0 — the worker then refuses every request.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,79}(:[a-z0-9][a-z0-9._-]{0,39})?$/i;
// Serves embeddings (/v1/embeddings + chat RAG) — every worker keeps it.
const REQUIRED_MODELS = new Set(['bge-m3']);
const EMBED_ONLY = new Set(['bge-m3', 'embeddinggemma', 'nomic-embed-text']);
const PROGRESS_INTERVAL_MS = 1000;

function remoteManageEnabled(config) {
  if (process.env.PLANKTON_REMOTE_MANAGE === '0') return false;
  return !(config && config.remote_manage === false);
}

function parseModels(value) {
  return String(value || '').split(',').map((m) => m.trim()).filter(Boolean);
}

// Where Ollama keeps its blobs, for the free-space check. Walks up to the
// nearest directory that exists (the models dir may not exist yet).
function modelsDir() {
  const candidates = [process.env.OLLAMA_MODELS];
  if (process.platform === 'linux') candidates.push('/usr/share/ollama/.ollama/models');
  candidates.push(path.join(os.homedir(), '.ollama', 'models'));
  for (const c of candidates.filter(Boolean)) {
    if (fs.existsSync(c)) return c;
  }
  return os.homedir();
}

function freeBytes(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null; // Node < 18.15
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch (e) {
    return null;
  }
}

// Ollama names an untagged pull "<name>:latest" in /api/tags, while the
// catalog and config.json use the bare name ("bge-m3"). Compare both forms.
function modelKey(name) {
  const s = String(name || '').trim().toLowerCase();
  return s.endsWith(':latest') ? s.slice(0, -':latest'.length) : s;
}

// Installed models (config.json `models`) verified against Ollama's tags —
// what the server routes to this worker. Before 1.2.5 "bge-m3" never matched
// "bge-m3:latest", so every worker silently stopped advertising bge-m3 and
// got no embedding tasks.
function installedModels(configModels, tags) {
  const wanted = parseModels(configModels || 'llama3.1:8b');
  if (!tags) return wanted;
  const have = new Set(tags.map((t) => modelKey(t && typeof t === 'object' ? (t.name || t.model) : t)));
  const verified = wanted.filter((m) => have.has(modelKey(m)));
  return verified.length > 0 ? verified : wanted;
}

class ModelManager {
  /**
   * @param {object} opts
   * @param {object} opts.ollama       OllamaService (pullModel, deleteModel, getStatus)
   * @param {string} opts.configPath   worker-app/config.json
   * @param {Function} opts.onModels   (servedModels[]) => void, after a change
   * @param {Function} [opts.freeBytes] override for tests
   */
  constructor({ ollama, configPath, onModels, freeBytes: free = null }) {
    this.ollama = ollama;
    this.configPath = configPath;
    this.onModels = onModels || (() => {});
    this.freeBytes = free || (() => freeBytes(modelsDir()));
    this.job = null;
  }

  readConfig() {
    return JSON.parse(fs.readFileSync(this.configPath, 'utf8').replace(/^﻿/, ''));
  }

  enabled() {
    try { return remoteManageEnabled(this.readConfig()); } catch (e) { return false; }
  }

  // Rewrite config.json in place (keeps the file's owner-only permissions
  // and, on Windows, its ACL — a rename would replace both).
  writeModels(models) {
    const cfg = this.readConfig();
    cfg.models = models.join(',');
    if (!models.includes(cfg.default_model)) {
      cfg.default_model = models.find((m) => !EMBED_ONLY.has(m)) || models[0];
    }
    fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2));
    return cfg;
  }

  /**
   * Handle one `manage` message. `send` delivers manage_progress /
   * manage_result frames to the server.
   */
  async handle(msg, send) {
    const id = typeof msg.id === 'string' ? msg.id.slice(0, 64) : '';
    const action = msg.action;
    const model = typeof msg.model === 'string' ? msg.model.trim() : '';
    const fail = (error) => send({ type: 'manage_result', id, ok: false, action, model, error });

    if (!id) return undefined;
    if (!this.enabled()) return fail('Remote management is turned off on this worker');
    if (action !== 'pull' && action !== 'remove') return fail('Unknown action');
    if (!MODEL_RE.test(model)) return fail('Invalid model name');
    if (this.job) return fail(`Busy: ${this.job.action} ${this.job.model} is still running`);

    this.job = { id, action, model };
    console.log(`🛠️  Remote ${action}: ${model}`);
    try {
      const models = action === 'pull'
        ? await this.pull(id, model, Number(msg.size_gb) || 0, send)
        : await this.remove(model);
      this.onModels(models);
      console.log(`✅ Remote ${action} done: ${model} (now serving: ${models.join(', ')})`);
      send({ type: 'manage_result', id, ok: true, action, model, models });
    } catch (err) {
      console.error(`❌ Remote ${action} failed: ${model}: ${err.message}`);
      fail(String(err.message || err).slice(0, 200));
    } finally {
      this.job = null;
    }
    return undefined;
  }

  async pull(id, model, sizeGb, send) {
    if (sizeGb > 0) {
      const free = this.freeBytes();
      const need = sizeGb * 1.1 * 1024 ** 3; // catalog size + 10% headroom
      if (free !== null && free < need) {
        throw new Error(`Not enough disk space: ${(free / 1024 ** 3).toFixed(1)} GB free, about ${Math.ceil(sizeGb * 1.1)} GB needed`);
      }
    }
    let last = 0;
    await this.ollama.pullModel(model, (p) => {
      const now = Date.now();
      if (now - last < PROGRESS_INTERVAL_MS) return;
      last = now;
      send({ type: 'manage_progress', id, status: p.status, completed: p.completed, total: p.total });
    });
    const current = parseModels(this.readConfig().models);
    const next = current.includes(model) ? current : [...current, model];
    this.writeModels(next);
    return next;
  }

  async remove(model) {
    if (REQUIRED_MODELS.has(model)) throw new Error(`${model} is required (it serves embeddings) and cannot be removed`);
    const current = parseModels(this.readConfig().models);
    const next = current.filter((m) => m !== model);
    if (!next.some((m) => !EMBED_ONLY.has(m))) {
      throw new Error('Refusing to remove the last chat model — install another one first');
    }
    await this.ollama.deleteModel(model);
    this.writeModels(next);
    return next;
  }
}

module.exports = { ModelManager, remoteManageEnabled, MODEL_RE, installedModels, modelKey };
