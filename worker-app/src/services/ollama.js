const axios = require('axios');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Context window asked of Ollama (1.1.14). Ollama's default (4096 on CPU and
// small GPUs) is smaller than a chat with history, and Ollama then silently
// drops the OLDEST messages, so the model "forgets" the earlier questions.
// One fixed value for every request: a different num_ctx reloads the model.
// Override with OLLAMA_NUM_CTX or config.json `num_ctx`; 0 = Ollama default.
const DEFAULT_NUM_CTX = 8192;
// Room kept for the answer when fitting history into the window.
const REPLY_RESERVE_TOKENS = 1536;

function resolveNumCtx(configured) {
  const raw = process.env.OLLAMA_NUM_CTX !== undefined && process.env.OLLAMA_NUM_CTX !== ''
    ? process.env.OLLAMA_NUM_CTX : configured;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_NUM_CTX;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_NUM_CTX;
  return n === 0 ? 0 : Math.min(Math.max(n, 2048), 131072);
}

// Rough token count: Latin text ~4 chars/token, other scripts ~2.
function estimateTokens(text) {
  const s = String(text || '');
  let ascii = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 4 + (s.length - ascii) / 2);
}

// Drop the oldest user/assistant pairs until history + prompt leave room for
// the reply inside num_ctx — the newest turns are the ones that matter.
function fitHistory(history, prompt, numCtx) {
  const list = Array.isArray(history) ? history.slice() : [];
  const ctx = numCtx || 4096;
  const budget = ctx - REPLY_RESERVE_TOKENS - estimateTokens(prompt);
  let total = list.reduce((n, m) => n + estimateTokens(m && m.content), 0);
  while (list.length > 0 && total > budget) {
    const drop = list.length >= 2 ? 2 : 1;
    for (const m of list.splice(0, drop)) total -= estimateTokens(m && m.content);
  }
  return list;
}

class OllamaService {
  constructor(model = 'llama3.1:8b', { numCtx } = {}) {
    this.url = 'http://localhost:11434';
    this.model = model;
    this.isRunning = false;
    this.numCtx = resolveNumCtx(numCtx);
  }

  // Ollama `options` sent with every generation request.
  ollamaOptions() {
    return this.numCtx ? { options: { num_ctx: this.numCtx } } : {};
  }

  setModel(model) {
    this.model = model;
  }

  // H5: the old install() piped https://ollama.com/install.sh into a shell
  // (unpinned, root-equivalent) and had no callers at all — removed. The
  // install scripts fetch that installer sha256-verified instead.

  async pullModel(modelName) {
    const model = modelName || this.model;
    return new Promise((resolve, reject) => {
      exec(`ollama pull ${model}`, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      });
    });
  }

  async start() {
    // If Ollama already responds, nothing to do.
    try {
      await axios.get(`${this.url}/api/tags`, { timeout: 3000 });
      this.isRunning = true;
      console.log('Ollama already running');
      return;
    } catch (e) {
      // Not running — start it below.
    }

    // NOTE: never use exec('ollama serve &') — the backgrounded child
    // inherits the stdio pipes so exec's callback never fires and the
    // worker hangs forever at "Starting Ollama...". Spawn detached with
    // ignored stdio instead, then poll for readiness.
    const { spawn } = require('child_process');
    try {
      const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (err) {
      throw new Error('Failed to start Ollama: ' + err.message);
    }

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        await axios.get(`${this.url}/api/tags`, { timeout: 2000 });
        this.isRunning = true;
        return;
      } catch (e) {
        // Still starting — keep polling.
      }
    }
    throw new Error('Ollama failed to start (timeout waiting for :11434)');
  }

  async stop() {
    this.isRunning = false;
  }

  async generate(prompt, model) {
    try {
      // M5: a bound below the server's 180s dispatch timeout — a late result
      // would arrive after the server's fallback and rewrite history.
      const response = await axios.post(`${this.url}/api/generate`, {
        model: model || this.model,
        prompt: prompt,
        stream: false,
        ...this.ollamaOptions(),
      }, { timeout: 170000 });
      return response.data;
    } catch (error) {
      throw new Error('Ollama not available');
    }
  }

  // chat with an attachment. Images and audio (base64 WAV) both ride
  // the `images` slot of a chat message — Ollama detects RIFF/WAVE audio by
  // magic bytes and routes it to the audio encoder on supported platforms.
  async chat(prompt, model, media) {
    if (!media || !media.data) {
      throw new Error('No attachment data');
    }
    try {
      const response = await axios.post(`${this.url}/api/chat`, {
        model: model || this.model,
        messages: [{
          role: 'user',
          content: prompt,
          images: [media.data],
        }],
        stream: false,
        ...this.ollamaOptions(),
      }, { timeout: 170000 });
      return {
        response: (response.data.message && response.data.message.content) || '',
        eval_count: response.data.eval_count || 0,
      };
    } catch (error) {
      throw new Error('Ollama could not process the attachment');
    }
  }

  // answer with conversation context. History entries are
  // [{ role: 'user'|'assistant', content }] (already capped server-side);
  // media still rides the `images` slot of the final user message.
  async chatWithHistory(prompt, model, media, history) {
    const messages = fitHistory(history, prompt, this.numCtx);
    const last = { role: 'user', content: prompt };
    if (media && media.data) last.images = [media.data];
    messages.push(last);
    try {
      const response = await axios.post(`${this.url}/api/chat`, {
        model: model || this.model,
        messages,
        stream: false,
        ...this.ollamaOptions(),
      }, { timeout: 170000 });
      return {
        response: (response.data.message && response.data.message.content) || '',
        eval_count: response.data.eval_count || 0,
      };
    } catch (error) {
      throw new Error('Ollama could not process the request');
    }
  }

  // Vector embeddings for a batch of inputs (POST /api/embed). Returns
  // { embeddings: number[][], prompt_eval_count }. Bounded below the
  // server's 120s embed dispatch timeout.
  async embed(model, inputs) {
    const response = await axios.post(`${this.url}/api/embed`, {
      model,
      input: inputs,
      truncate: true,
    }, { timeout: 110000 });
    return response.data;
  }

  // Download a model through Ollama's HTTP API (1.2.0 remote management).
  // Ollama streams NDJSON status lines; layer sizes arrive per digest, so the
  // overall progress is the sum over digests. onProgress({ status,
  // completed, total }) fires for every line. Resolves when Ollama reports
  // success; rejects on an error line, a dropped stream, or `stallMs`
  // without any data (a stuck download must not hold the worker forever).
  pullModel(model, onProgress = () => {}, { stallMs = 10 * 60 * 1000 } = {}) {
    return new Promise((resolve, reject) => {
      const layers = new Map();
      let buffer = '';
      let done = false;
      let stallTimer = null;
      const controller = new AbortController();
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(stallTimer);
        if (err) { controller.abort(); reject(err); } else resolve();
      };
      const armStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => finish(new Error('Download stalled (no data for 10 minutes)')), stallMs);
        if (stallTimer.unref) stallTimer.unref();
      };
      const handleLine = (line) => {
        if (!line.trim()) return;
        let evt;
        try { evt = JSON.parse(line); } catch (e) { return; }
        if (evt.error) { finish(new Error(String(evt.error).slice(0, 200))); return; }
        if (evt.digest && Number.isFinite(evt.total)) {
          layers.set(evt.digest, { total: evt.total, completed: Number(evt.completed) || 0 });
        }
        let total = 0;
        let completed = 0;
        for (const l of layers.values()) { total += l.total; completed += Math.min(l.completed, l.total); }
        onProgress({ status: String(evt.status || '').slice(0, 80), completed, total });
        if (evt.status === 'success') finish();
      };
      armStall();
      axios.post(`${this.url}/api/pull`, { model, stream: true }, {
        responseType: 'stream',
        timeout: 0,
        signal: controller.signal,
      }).then((response) => {
        response.data.on('data', (chunk) => {
          armStall();
          buffer += chunk.toString('utf8');
          let nl;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            handleLine(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
          }
        });
        response.data.on('end', () => {
          if (buffer) handleLine(buffer);
          finish(new Error('Download ended before Ollama reported success'));
        });
        response.data.on('error', (err) => finish(new Error(`Download failed: ${err.message}`)));
      }).catch((err) => {
        const msg = err.response && err.response.status
          ? `Ollama refused the download (HTTP ${err.response.status})`
          : `Ollama not reachable: ${err.message}`;
        finish(new Error(msg));
      });
    });
  }

  // Remove a model from Ollama (DELETE /api/delete). A model that is not
  // present counts as removed.
  async deleteModel(model) {
    try {
      await axios.delete(`${this.url}/api/delete`, { data: { model }, timeout: 60000 });
    } catch (err) {
      if (err.response && err.response.status === 404) return;
      throw new Error(err.response ? `Ollama could not remove ${model} (HTTP ${err.response.status})` : `Ollama not reachable: ${err.message}`);
    }
  }

  async getStatus() {
    try {
      const response = await axios.get(`${this.url}/api/tags`, { timeout: 5000 });
      return {
        running: true,
        models: response.data.models,
      };
    } catch (error) {
      return {
        running: false,
        models: [],
      };
    }
  }
}

module.exports = OllamaService;
module.exports.fitHistory = fitHistory;
module.exports.resolveNumCtx = resolveNumCtx;
module.exports.estimateTokens = estimateTokens;
module.exports.DEFAULT_NUM_CTX = DEFAULT_NUM_CTX;
