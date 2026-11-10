const fs = require('fs');
const path = require('path');
const OllamaService = require('./services/ollama');
const { ModelManager } = require('./services/manager');
const WorkerService = require('./services/worker');
const WorkerWebSocket = require('./services/websocket');

const configPath = path.join(__dirname, '../config.json');
let config = { models: 'llama3.1:8b', default_model: 'llama3.1:8b', worker_token: '', machine_id: '', name: '' };
if (fs.existsSync(configPath)) {
  try {
    // Strip a UTF-8 BOM: Windows PowerShell 5.1 installers wrote one, and
    // JSON.parse rejects it (the worker then saw no worker_token).
    config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.error('Failed to read config.json:', e.message);
  }
}

if (!config.worker_token) {
  console.error('❌ No worker_token in config.json. Run the install script first.');
  process.exit(1);
}

console.log('🚀 Plankton Worker starting...');
console.log(`   Model: ${config.default_model}`);
console.log(`   Context window (num_ctx): ${OllamaService.resolveNumCtx(config.num_ctx) || "Ollama default"}`);

const ollama = new OllamaService(config.default_model, { numCtx: config.num_ctx });
const worker = new WorkerService();

const ws = new WorkerWebSocket(
  config.worker_token,
  async (prompt, model, media, history) => {
    ollama.setModel(model);
    // tasks with conversation context go through /api/chat with
    // the window; plain single-prompt tasks keep the legacy paths.
    if (history && history.length > 0) {
      return ollama.chatWithHistory(prompt, model, media, history);
    }
    if (media) {
      return ollama.chat(prompt, model, media);
    }
    const result = await ollama.generate(prompt, model);
    return result;
  },
  (model, inputs) => ollama.embed(model, inputs)
);

// 1.2.0: the owner installs/removes models from the worker panel. After a
// change the served list is re-verified against Ollama and re-advertised at
// once (heartbeat), so routing picks the new model up without a restart.
const manager = new ModelManager({
  ollama,
  configPath,
  onModels: async (models) => {
    try { Object.assign(config, manager.readConfig()); } catch (e) { config.models = models.join(','); }
    ws.heartbeatDefaultModel = config.default_model;
    try {
      const status = await ollama.getStatus();
      ws.setModels(installedModels(config.models, status.models));
    } catch (e) {
      ws.setModels(installedModels(config.models, null));
    }
    ws.sendHeartbeat('online', { current_model: config.default_model });
  },
});
ws.setManager(manager);
console.log(`   Remote model management: ${manager.enabled() ? 'on' : 'off (config.json remote_manage=false)'}`);

// Installed models (config.csv `models`) verified against `ollama list` —
// what the server routes to this worker (multi-model).
function installedModels(configModels, tags) {
  const wanted = String(configModels || 'llama3.1:8b')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  if (!tags) return wanted;
  const have = new Set(tags.map((t) => String(t.name || t)));
  const verified = wanted.filter((m) => have.has(m) || have.has(m.split(':')[0]));
  return verified.length > 0 ? verified : wanted;
}

async function start() {
  try {
    console.log('📦 Starting Ollama...');
    await ollama.start();
    console.log('✅ Ollama ready');

    try {
      const status = await ollama.getStatus();
      ws.setModels(installedModels(config.models, status.models));
    } catch (e) {
      ws.setModels(installedModels(config.models, null));
    }
    console.log(`   Serving models: ${ws.installedModels.join(', ') || config.default_model}`);

    console.log('⚙️  Starting worker service...');
    await worker.start();

    console.log('🔌 Connecting to Plankton Network...');
    ws.startHeartbeat(worker, config.default_model);
    ws.connect();

    console.log('✅ Worker is running! Press Ctrl+C to stop.');
  } catch (err) {
    console.error('❌ Failed to start:', err.message);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  console.log('\n🛑 Stopping worker...');
  ws.disconnect();
  worker.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  ws.disconnect();
  worker.stop();
  process.exit(0);
});

start();
