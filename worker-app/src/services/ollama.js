const axios = require('axios');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

class OllamaService {
  constructor(model = 'llama3.1:8b') {
    this.url = 'http://localhost:11434';
    this.model = model;
    this.isRunning = false;
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
    const messages = [...(Array.isArray(history) ? history : [])];
    const last = { role: 'user', content: prompt };
    if (media && media.data) last.images = [media.data];
    messages.push(last);
    try {
      const response = await axios.post(`${this.url}/api/chat`, {
        model: model || this.model,
        messages,
        stream: false,
      }, { timeout: 170000 });
      return {
        response: (response.data.message && response.data.message.content) || '',
        eval_count: response.data.eval_count || 0,
      };
    } catch (error) {
      throw new Error('Ollama could not process the request');
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
