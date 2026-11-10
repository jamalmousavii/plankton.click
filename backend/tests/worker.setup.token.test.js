// 1.2.1: installing a worker asks only for the worker token — no email.
// POST /api/workers/setup must bind the machine from the token alone, and
// old installers that still send an email must keep working.

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');

jest.mock('../src/database/pool', () => {
  const state = { queryImpl: async () => ({ rows: [] }), calls: [] };
  return {
    __state: state,
    query: (sql, params) => { state.calls.push([String(sql), params]); return state.queryImpl(String(sql), params); },
    connect: async () => { throw new Error('not used'); },
  };
});

const pool = require('../src/database/pool');
const workerRoutes = require('../src/routes/workers');

const WORKER_TOKEN = 'pw_' + 'a'.repeat(64);
const ACCOUNT_TOKEN = 'pw_' + 'b'.repeat(64);

function app() {
  pool.__state.calls = [];
  pool.__state.queryImpl = async (sql, params) => {
    if (sql.includes('FROM workers WHERE worker_token')) {
      return params[0] === WORKER_TOKEN ? { rows: [{ id: 5, user_id: 7, status: 'offline' }] } : { rows: [] };
    }
    if (sql.startsWith('UPDATE workers')) return { rows: [{ id: sql.includes('machine_id') ? params[6] : params[params.length - 1] }] };
    if (sql.includes('FROM users WHERE worker_token')) {
      return params[0] === ACCOUNT_TOKEN ? { rows: [{ id: 7 }] } : { rows: [] };
    }
    if (sql.includes('FROM workers WHERE user_id')) return { rows: [{ id: 3 }] };
    return { rows: [] };
  };
  const a = express();
  a.use(express.json());
  a.use('/api/workers', workerRoutes);
  return a;
}

const body = (extra) => ({ name: 'box', gpu_model: 'CPU', ram: '16 GB', cpu: 'x', models: ['llama3.1:8b'], ...extra });

describe('worker setup with the token only', () => {
  test('a per-worker token alone registers the machine', async () => {
    const res = await request(app()).post('/api/workers/setup').send(body({ worker_token: WORKER_TOKEN }));
    expect(res.status).toBe(200);
    expect(res.body.worker.id).toBe(5);
  });

  test('an old installer that still sends an email keeps working', async () => {
    const res = await request(app()).post('/api/workers/setup')
      .send(body({ worker_token: WORKER_TOKEN, email: 'someone-else@example.com' }));
    expect(res.status).toBe(200);
    expect(res.body.worker.id).toBe(5);
  });

  test('a legacy account token works without an email', async () => {
    const res = await request(app()).post('/api/workers/setup').send(body({ worker_token: ACCOUNT_TOKEN }));
    expect(res.status).toBe(200);
    expect(res.body.worker.id).toBe(3);
    const lookup = pool.__state.calls.find(([sql]) => sql.includes('FROM users WHERE worker_token'));
    expect(lookup[1]).toEqual([ACCOUNT_TOKEN]);
  });

  test('an unknown token is still refused', async () => {
    const res = await request(app()).post('/api/workers/setup').send(body({ worker_token: 'pw_' + 'c'.repeat(64) }));
    expect(res.status).toBe(401);
  });

  test('a missing token is refused', async () => {
    const res = await request(app()).post('/api/workers/setup').send(body({}));
    expect(res.status).toBe(400);
  });
});

describe('installers no longer ask for an email', () => {
  const dir = path.join(__dirname, '../../worker-app');
  for (const f of ['install-ubuntu.sh', 'install-redhat.sh', 'install-macos.sh', 'install-windows.ps1']) {
    test(f, () => {
      const s = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(s).not.toMatch(/read -r -p "  Email/);
      expect(s).not.toMatch(/Read-Host "  Email"/);
      expect(s).not.toMatch(/email: \$email|email = \$Email/);
      // the old flag is still accepted so copied commands keep working
      expect(s).toMatch(/--email\) shift 2|\[string\]\$Email/);
    });
  }
});

describe('worker name without an installer prompt (1.2.3)', () => {
  const setupUpdate = () => pool.__state.calls.find(([sql]) => sql.startsWith('UPDATE workers'));

  test('the hostname is sent separately and the panel name is not overwritten', async () => {
    await request(app()).post('/api/workers/setup')
      .send({ worker_token: WORKER_TOKEN, name: '', default_name: 'gpu-box-01', models: ['llama3.1:8b'] });
    const [sql, params] = setupUpdate();
    // explicit name, else the panel's (unless it is the placeholder), else hostname
    expect(sql).toContain("name = COALESCE($6::text, CASE WHEN name IS NULL OR name IN ('', 'worker1') THEN $8::text END, name)");
    expect(params[5]).toBeNull();
    expect(params[7]).toBe('gpu-box-01');
  });

  test('--name still wins', async () => {
    await request(app()).post('/api/workers/setup')
      .send({ worker_token: WORKER_TOKEN, name: ' my-box ', default_name: 'host' });
    const [, params] = setupUpdate();
    expect(params[5]).toBe('my-box');
  });

  test('a non-string or blank hostname is ignored', async () => {
    await request(app()).post('/api/workers/setup')
      .send({ worker_token: WORKER_TOKEN, default_name: { x: 1 } });
    expect(setupUpdate()[1][7]).toBeNull();
    await request(app()).post('/api/workers/setup')
      .send({ worker_token: WORKER_TOKEN, default_name: '   ' });
    expect(setupUpdate()[1][7]).toBeNull();
  });

  const dir = path.join(__dirname, '../../worker-app');
  for (const f of ['install-ubuntu.sh', 'install-redhat.sh', 'install-macos.sh']) {
    test(`${f} does not prompt for a name and sends the hostname`, () => {
      const s = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(s).not.toMatch(/Worker Name \[/);
      expect(s).toMatch(/--name\) WORKER_NAME="\$2"/);
      expect(s).toContain('default_name: $host');
      expect(s).toContain(".worker.name // empty");
    });
  }
  test('install-windows.ps1 does not prompt for a name and sends the computer name', () => {
    const s = fs.readFileSync(path.join(dir, 'install-windows.ps1'), 'utf8');
    expect(s).not.toMatch(/Read-Host "  Worker Name/);
    expect(s).toContain('default_name = $hn');
    expect(s).toMatch(/\[string\]\$Name = ""/);
  });
});
