const { app, BrowserWindow, ipcMain, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const OllamaService = require('./services/ollama');
const WorkerService = require('./services/worker');
const ApiService = require('./services/api');
const WorkerWebSocket = require('./services/websocket');

let mainWindow;
let tray;
let ollamaService;
let workerService;
let apiService;
let wsClient;

// Read config
let config = { models: 'llama3.1:8b', default_model: 'llama3.1:8b', worker_token: '', machine_id: '', name: '' };
const configPath = path.join(__dirname, '../config.json');
if (fs.existsSync(configPath)) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    icon: path.join(__dirname, '../assets/icon.png'),
    title: 'Plankton Worker',
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  tray = new Tray(path.join(__dirname, '../assets/tray-icon.png'));
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show', click: () => mainWindow.show() },
    { label: 'Start Working', click: () => startWorking() },
    { label: 'Stop Working', click: () => stopWorking() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setToolTip('Plankton Worker');
  tray.setContextMenu(contextMenu);
}

async function startWorking() {
  try {
    await ollamaService.start();
    await workerService.start();
    wsClient.connect();
    mainWindow.webContents.send('working-started');
  } catch (error) {
    console.error('Error starting working:', error);
  }
}

async function stopWorking() {
  try {
    await workerService.stop();
    await ollamaService.stop();
    wsClient.disconnect();
    mainWindow.webContents.send('working-stopped');
  } catch (error) {
    console.error('Error stopping working:', error);
  }
}

app.whenReady().then(() => {
  ollamaService = new OllamaService();
  workerService = new WorkerService();
  apiService = new ApiService();

  wsClient = new WorkerWebSocket(
    config.worker_token || process.env.WALLET_ADDRESS || '',
    async (prompt, model, media, history) => {
      ollamaService.setModel(model);
      // tasks with conversation context go through /api/chat with
      // the window; plain single-prompt tasks keep the legacy paths.
      if (history && history.length > 0) {
        return ollamaService.chatWithHistory(prompt, model, media, history);
      }
      if (media) {
        return ollamaService.chat(prompt, model, media);
      }
      const result = await ollamaService.generate(prompt, model);
      return result;
    },
    (model, inputs) => ollamaService.embed(model, inputs)
  );
  try {
    const wanted = String(config.models || config.default_model || 'llama3.1:8b')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    wsClient.setModels(wanted);
  } catch (e) {}

  createWindow();
  createTray();

  ipcMain.handle('start-working', startWorking);
  ipcMain.handle('stop-working', stopWorking);
  ipcMain.handle('get-stats', () => workerService.getStats());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
