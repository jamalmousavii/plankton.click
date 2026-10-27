// Phase 4 (v3.34.0) — worker-app security & reliability:
// M3 fatal auth_error, M4 result buffer + task_request + server-side reset
// of stranded `processing` rows, M5 Ollama timeouts, plus script contracts
// for H4/H5/M1/M2/M6/M7/M8/M10 (installers are shell — guarded by reading
// the sources so a regression can't silently reintroduce the old patterns).

const fs = require('fs');
const path = require('path');

jest.mock('../src/database/pool', () => {
  const state = { statements: [], queryImpl: async () => ({ rows: [] }) };
  const push = (sql) => state.statements.push(String(sql).trim().replace(/\s+/g, ' '));
  return {
    __state: state,
    query: (sql, params) => { push(sql); return state.queryImpl(sql, params); },
    connect: async () => { throw new Error('connect not used'); },
  };
});

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

const pool = require('../src/database/pool');
const axios = require('axios');
const WorkerWebSocket = require('../../worker-app/src/services/websocket');
const OllamaService = require('../../worker-app/src/services/ollama');
const WSServer = require('../src/ws');

const openSocket = () => ({ readyState: 1, send: jest.fn(), close: jest.fn() });

beforeEach(() => {
  pool.__state.statements.length = 0;
});

// ---------------------------------------------------------------------------
// M3 — auth_error stops the heartbeat, caps retries, exits non-zero.
// ---------------------------------------------------------------------------
describe('M3: auth_error is bounded and fatal', () => {
  it('stops the heartbeat and exits after 5 consecutive rejections', () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const ws = new WorkerWebSocket('pw_deadbeef', async () => ({}));
    ws.ws = openSocket();
    ws.heartbeatInterval = setInterval(() => {}, 60000);

    for (let i = 0; i < 4; i++) {
      ws.handleMessage({ type: 'auth_error', message: 'Invalid worker token' });
    }
    expect(exitSpy).not.toHaveBeenCalled();
    expect(ws.heartbeatInterval).toBeNull(); // stopped on the first rejection
    expect(ws.authFailCount).toBe(4);

    ws.handleMessage({ type: 'auth_error', message: 'Invalid worker token' });
    expect(exitSpy).toHaveBeenCalledWith(1);

    clearInterval(ws.heartbeatInterval || setInterval(() => {}, 60000));
    exitSpy.mockRestore();
  });

  it('resets the failure streak on a successful auth', () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const ws = new WorkerWebSocket('pw_deadbeef', async () => ({}));
    ws.ws = openSocket();

    for (let i = 0; i < 4; i++) ws.handleMessage({ type: 'auth_error', message: 'nope' });
    ws.handleMessage({ type: 'auth_ok', worker_id: 3 });

    expect(ws.authFailCount).toBe(0);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// M4 (client) — buffered results flush on auth_ok; task_request follows.
// ---------------------------------------------------------------------------
describe('M4 client: result buffer + task_request', () => {
  it('buffers a task result while the socket is down and flushes it on auth_ok', () => {
    const ws = new WorkerWebSocket('pw_deadbeef', async () => ({}));
    ws.ws = { readyState: 3, send: jest.fn() }; // CLOSED
    ws.sendResult({ type: 'task_result', task_id: 11, response: 'hi' });
    expect(ws.pendingResults).toHaveLength(1);
    expect(ws.ws.send).not.toHaveBeenCalled();

    ws.ws = openSocket(); // reconnect happened
    ws.handleMessage({ type: 'auth_ok', worker_id: 5 });

    const sent = ws.ws.send.mock.calls.map((c) => JSON.parse(c[0]));
    const types = sent.map((m) => m.type);
    expect(types).toContain('task_result');
    expect(types).toContain('task_request'); // polling branch gets exercised
    expect(sent.find((m) => m.type === 'task_result').task_id).toBe(11);
    expect(ws.pendingResults).toHaveLength(0);
  });

  it('keeps the result buffered when the flush socket is already gone again', () => {
    const ws = new WorkerWebSocket('pw_deadbeef', async () => ({}));
    ws.pendingResults = [{ type: 'task_result', task_id: 12, response: 'x' }];
    ws.ws = { readyState: 3, send: jest.fn() }; // CLOSED at flush time
    ws.flushResults();
    expect(ws.pendingResults).toHaveLength(1); // not lost, re-buffered
  });

  it('caps the buffer so a long outage cannot grow it unbounded', () => {
    const ws = new WorkerWebSocket('pw_deadbeef', async () => ({}));
    ws.ws = { readyState: 3, send: jest.fn() };
    for (let i = 0; i < 30; i++) ws.sendResult({ type: 'task_result', task_id: i });
    expect(ws.pendingResults).toHaveLength(20);
    expect(ws.pendingResults[ws.pendingResults.length - 1].task_id).toBe(29); // newest kept
  });
});

// ---------------------------------------------------------------------------
// M4 (server) — stranded `processing` rows are handed back to `pending`.
// ---------------------------------------------------------------------------
function bareServer() {
  const server = Object.create(WSServer.prototype);
  server.workers = new Map();
  server.taskCallbacks = new Map();
  server.authFails = new Map();
  return server;
}

describe('M4 server: no stranded processing rows', () => {
  it('resets the row when a dispatch times out', async () => {
    const server = bareServer();
    server.workers.set(9, { id: 9, ws: { readyState: 1, send: jest.fn() }, status: 'online', current_model: 'm', e2eKey: null });

    await expect(server.dispatchTask(9, 501, 'p', 'm', null, 15)).rejects.toThrow('Task timeout');

    expect(pool.__state.statements.join('\n')).toMatch(
      /UPDATE tasks SET status = 'pending' WHERE id = \$1 AND status = 'processing'/
    );
  });

  it("resets the worker's claimed rows on disconnect", async () => {
    const server = bareServer();
    const handlers = {};
    const fakeWs = {
      on: (ev, fn) => { handlers[ev] = fn; },
      send: jest.fn(),
      close: jest.fn(),
      _socket: { remoteAddress: '203.0.113.9' },
    };
    server.handleConnection(fakeWs, { headers: {} });
    server.workers.set(4, { id: 4, ws: fakeWs, status: 'online', current_model: 'm', e2eKey: null });

    handlers.close();

    expect(pool.__state.statements.join('\n')).toMatch(
      /UPDATE tasks SET status = 'pending' WHERE worker_id = \$1 AND status = 'processing'/
    );
    expect(pool.__state.statements.join('\n')).toMatch(/UPDATE workers SET status = 'offline'/);
  });
});

// ---------------------------------------------------------------------------
// M5 — every Ollama HTTP call has a timeout.
// ---------------------------------------------------------------------------
describe('M5: Ollama axios timeouts', () => {
  it('caps /api/generate below the server dispatch timeout', async () => {
    axios.post.mockResolvedValue({ data: { response: 'ok', eval_count: 1 } });
    await new OllamaService('llama3.1:8b').generate('hi', 'llama3.1:8b');
    expect(axios.post).toHaveBeenCalledWith(
      'http://localhost:11434/api/generate',
      expect.any(Object),
      { timeout: 170000 }
    );
  });

  it('caps /api/chat the same way', async () => {
    axios.post.mockResolvedValue({ data: { message: { content: 'ok' }, eval_count: 2 } });
    await new OllamaService().chat('hi', 'm', { data: 'AAA' });
    expect(axios.post).toHaveBeenLastCalledWith(
      'http://localhost:11434/api/chat',
      expect.any(Object),
      { timeout: 170000 }
    );
  });

  it('caps the status probe so health checks cannot hang', async () => {
    axios.get.mockResolvedValue({ data: { models: [] } });
    await new OllamaService().getStatus();
    expect(axios.get).toHaveBeenCalledWith('http://localhost:11434/api/tags', { timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// Installer contracts (H4/H5/M1/M2/M6/M7/M8/M10) — the scripts are shell, so
// their guarantees are enforced by checking the shipped source text.
// ---------------------------------------------------------------------------
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const ubuntu = read('worker-app/install-ubuntu.sh');
const redhat = read('worker-app/install-redhat.sh');

describe('installer script contracts', () => {
  it('H5: remote installers are fetched and sha256-verified, never piped raw', () => {
    for (const script of [ubuntu, redhat]) {
      expect(script).toContain('fetch_verified');
      expect(script).toContain('PIN_OLLAMA_SHA256=');
      expect(script).not.toMatch(/curl -fsSL https:\/\/(ollama\.com\/install\.sh|.*nodesource.*setup[^"]*)\s*\|\s*(sh|.*bash)/);
    }
    expect(ubuntu).toContain('2c4c6683a17b6f4128898a7b521e3c8bb725a99ffaf1b5e32ac97c6fa7d381be'); // deb pin
    expect(redhat).toContain('23ae8de502785a06421a83736e519004e02ab85b2e61464a52a5259833a1c27d'); // rpm pin
  });

  it('H4/M6: registration and config never place the token on an argv or break on quotes', () => {
    for (const script of [ubuntu, redhat]) {
      expect(script).toContain('--data-binary @-'); // body over stdin, not -d "$json"
      expect(script).toContain('jq -n');            // JSON built with jq, not interpolation
      expect(script).toContain('chmod 600');        // config.json owner-only
      expect(script).toContain('--token-file');     // token off the command line
      expect(script).not.toContain('-d "{\\"email\\"'); // the old interpolated body
    }
  });

  it('M1/M2: failing steps show their log and registration failures abort', () => {
    for (const script of [ubuntu, redhat]) {
      expect(script).toMatch(/tail -n 20 "\$logfile"/);  // visible failure output
      expect(script).toContain('sudo -v');               // password asked up front
      expect(script).toMatch(/Registration failed[\s\S]{0,400}exit 1/); // M2
    }
  });

  it('M7/M8/M10: lockfile install, guarded self-delete, templated hardened unit', () => {
    for (const script of [ubuntu, redhat]) {
      expect(script).toContain('npm ci --omit=dev');
      expect(script).toMatch(/head -n 6 "\$SELF" \| grep -q "Plankton Network Worker - \.\* Install"/);
      expect(script).toContain('UNIT_TEMPLATE=');
      expect(script).not.toMatch(/^rm -f "\$0"$/m); // unguarded self-delete gone
    }
    const unit = read('worker-app/plankton-worker.service');
    expect(unit).toContain('@USER@');
    expect(unit).toContain('@WORKDIR@');
    expect(unit).toContain('NoNewPrivileges=true');
    expect(unit).toContain('ProtectHome=read-only');
    expect(unit).toContain('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6');
  });

  it('M9: uninstallers remove the system Ollama store too', () => {
    for (const script of [read('worker-app/uninstall-ubuntu.sh'), read('worker-app/uninstall-redhat.sh')]) {
      expect(script).toContain('/usr/share/ollama/.ollama');
      expect(script).toMatch(/worker_token/);
      expect(script).toContain('--data-binary @-'); // unregister token also off argv
    }
  });
});

// ---------------------------------------------------------------------------
// macOS + Windows installers (v3.42.0) — same contract family, platform
// native: launchd plist / Task Scheduler, Homebrew / winget, manager menu.
// ---------------------------------------------------------------------------
const macos = read('worker-app/install-macos.sh');
const macosUn = read('worker-app/uninstall-macos.sh');
const winps1 = read('worker-app/install-windows.ps1');
const winunps1 = read('worker-app/uninstall-windows.ps1');

describe('macOS installer contracts (v3.42.0)', () => {
  it('requires bash 4+ with a Homebrew re-exec (stock macOS ships 3.2)', () => {
    expect(macos).toMatch(/BASH_VERSINFO\[0\].*-lt 4/);
    expect(macos).toMatch(/\/opt\/homebrew\/bin\/bash/);
    expect(macos).toMatch(/\/usr\/local\/bin\/bash/);
  });

  it('uses Homebrew (no apt/dnf/systemd) and a launchd plist template', () => {
    expect(macos).toContain('brew install');
    expect(macos).not.toContain('apt-get');
    expect(macos).not.toContain('systemctl enable');
    expect(macos).toContain('UNIT_TEMPLATE=');
    expect(macos).toContain('click.plankton.worker.plist');
    expect(macos).toContain('launchctl load');
    const plist = read('worker-app/click.plankton.worker.plist');
    expect(plist).toContain('@NODE@');
    expect(plist).toContain('@WORKDIR@');
    expect(plist).toContain('KeepAlive');
  });

  it('rejects pre-AVX2 Intel Macs and keeps token/config hygiene', () => {
    expect(macos).toMatch(/AVX2/);
    expect(macos).toContain('chmod 600');
    expect(macos).toContain('--token-file');
    expect(macos).toMatch(/read -r -p "  Worker Token: "/); // visible input (option B)
    expect(macos).not.toMatch(/read -rsp "  Worker Token: "/);
  });

  it('manager menu and uninstaller mirror the Linux contract', () => {
    expect(macos).toContain('Plankton Worker Manager');
    expect(macos).toContain('--fresh');
    expect(macosUn).toContain('Plankton Worker Uninstaller (macOS)');
    expect(macosUn).toContain('launchctl unload');
    expect(macosUn).toMatch(/worker_token/);
  });
});

describe('Windows installer contracts (v3.42.0)', () => {
  it('uses winget + Task Scheduler (no third-party service wrapper)', () => {
    expect(winps1).toContain('winget install');
    expect(winps1).toContain('Ollama.Ollama');
    expect(winps1).toContain('OpenJS.NodeJS.LTS');
    expect(winps1).toContain('Register-ScheduledTask');
    expect(winps1).toContain('New-ScheduledTaskTrigger');
    expect(winps1).not.toContain('systemctl');
  });

  it('keeps token/config hygiene and PowerShell-safe JSON', () => {
    expect(winps1).toMatch(/\^\(pw\|kz\)_\[0-9a-f\]\{32,64\}\$/); // same token format gate (pw_ + legacy kz_)
    expect(winps1).toContain('ConvertTo-Json');
    expect(winps1).toContain('icacls'); // user-only ACL instead of chmod 600
    expect(winps1).toContain('[string]$TokenFile');
  });

  it('manager menu and uninstaller mirror the Linux contract', () => {
    expect(winps1).toContain('Plankton Worker Manager');
    expect(winps1).toContain('[switch]$Fresh');
    expect(winunps1).toContain('Plankton Worker Uninstaller (Windows)');
    expect(winunps1).toContain('Unregister-ScheduledTask');
    expect(winunps1).toContain('worker_token');
  });
});
