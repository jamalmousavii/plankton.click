// v3.39.0 — user support tickets (routes/tickets.js).
// Pattern: jest.mock the pool (no Postgres), sign a JWT per case, assert
// status + the SQL that actually ran. Cache-sensitive cases use distinct
// user ids so the auth-state cache never bleeds between tests.

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/database/pool', () => {
  const state = {
    statements: [],
    queryImpl: async () => ({ rows: [] }),
  };
  const norm = (sql) => String(sql).trim().replace(/\s+/g, ' ');
  const run = (sql, params) => {
    state.statements.push(norm(sql));
    return state.queryImpl(sql, params);
  };
  return {
    __state: state,
    query: run,
    connect: async () => ({ query: run, release: () => {} }),
  };
});

const pool = require('../src/database/pool');
const ticketsRouter = require('../src/routes/tickets');

const SECRET = process.env.JWT_SECRET;

function sign(payload) {
  return jwt.sign(payload, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/tickets', ticketsRouter);
  return a;
}

function resetPool() {
  pool.__state.statements.length = 0;
  pool.__state.queryImpl = async () => ({ rows: [] });
}

beforeEach(resetPool);

// Auth-state lookups (authenticate): version 0, not banned — user 7.
function allowUser(id = 7) {
  pool.__state.queryImpl = async (sql, params) => {
    if (/SELECT token_version, banned/.test(sql)) {
      return { rows: [{ token_version: 0, banned: false }] };
    }
    if (/INSERT INTO tickets/.test(sql)) {
      return { rows: [{ id: 11, user_id: params[0], subject: params[1], category: params[2], status: 'open' }] };
    }
    if (/INSERT INTO ticket_messages/.test(sql)) {
      return { rows: [{ id: 21, ticket_id: params[0], user_id: params[1], is_admin: params[2], body: params[3] }] };
    }
    if (/UPDATE tickets SET status/.test(sql)) {
      return { rows: [{ id: params[params.length - 1], status: sql.includes("'closed'") ? 'closed' : 'open' }] };
    }
    return { rows: [] };
  };
  return sign({ id, email: `u${id}@t.t`, role: 'user', token_version: 0 });
}

it('POST / requires a token (401)', async () => {
  const res = await request(app()).post('/api/tickets').send({ subject: 's', body: 'b' });
  expect(res.status).toBe(401);
});

it('POST / validates subject and body (400)', async () => {
  const token = allowUser();
  const noSubject = await request(app()).post('/api/tickets')
    .set('Authorization', `Bearer ${token}`).send({ body: 'hello' });
  expect(noSubject.status).toBe(400);

  const noBody = await request(app()).post('/api/tickets')
    .set('Authorization', `Bearer ${token}`).send({ subject: 'hi' });
  expect(noBody.status).toBe(400);
});

it('POST / creates the ticket and first message in one transaction', async () => {
  const token = allowUser();
  const res = await request(app()).post('/api/tickets')
    .set('Authorization', `Bearer ${token}`)
    .send({ subject: 'Worker offline', body: 'My rig stopped', category: 'worker' });
  expect(res.status).toBe(201);
  expect(res.body.ticket).toMatchObject({ id: 11, subject: 'Worker offline', status: 'open' });
  const sql = pool.__state.statements.join('\n');
  expect(sql).toMatch(/BEGIN/);
  expect(sql).toMatch(/INSERT INTO tickets/);
  expect(sql).toMatch(/INSERT INTO ticket_messages/);
  expect(sql).toMatch(/COMMIT/);
});

it('POST / rejects an unknown category by falling back to support', async () => {
  const token = allowUser();
  const res = await request(app()).post('/api/tickets')
    .set('Authorization', `Bearer ${token}`)
    .send({ subject: 's', body: 'b', category: 'drop-tables' });
  expect(res.status).toBe(201);
  expect(res.body.ticket.category).toBe('support');
});

it('GET / lists only the caller tickets', async () => {
  const token = allowUser();
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) {
      return { rows: [{ token_version: 0, banned: false }] };
    }
    return { rows: [{ id: 3, subject: 'Mine', status: 'open', last_message: 'hey', message_count: 2 }] };
  };
  const res = await request(app()).get('/api/tickets').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.tickets).toHaveLength(1);
  expect(pool.__state.statements.join(' ')).toMatch(/WHERE t\.user_id = \$1/);
});

it('GET /:id — 404 unknown, 403 another user ticket', async () => {
  const token = allowUser();
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) {
      return { rows: [{ token_version: 0, banned: false }] };
    }
    if (/SELECT \* FROM tickets WHERE id/.test(sql)) {
      return { rows: [{ id: 5, user_id: 99, status: 'open' }] };
    }
    return { rows: [] };
  };
  const foreign = await request(app()).get('/api/tickets/5').set('Authorization', `Bearer ${token}`);
  expect(foreign.status).toBe(403);

  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) {
      return { rows: [{ token_version: 0, banned: false }] };
    }
    return { rows: [] };
  };
  const missing = await request(app()).get('/api/tickets/404').set('Authorization', `Bearer ${token}`);
  expect(missing.status).toBe(404);
});

it('POST /:id/messages — 409 on a closed ticket, 401 for a banned account', async () => {
  const token = allowUser();
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) {
      return { rows: [{ token_version: 0, banned: false }] };
    }
    if (/SELECT \* FROM tickets WHERE id/.test(sql)) {
      return { rows: [{ id: 5, user_id: 7, status: 'closed' }] };
    }
    return { rows: [] };
  };
  const closed = await request(app()).post('/api/tickets/5/messages')
    .set('Authorization', `Bearer ${token}`).send({ body: 'again' });
  expect(closed.status).toBe(409);

  // Distinct user id → fresh auth-state cache entry → banned row.
  const bannedToken = sign({ id: 31, email: 'b@t.t', role: 'user', token_version: 0 });
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) {
      return { rows: [{ token_version: 0, banned: true }] };
    }
    return { rows: [] };
  };
  const banned = await request(app()).post('/api/tickets/5/messages')
    .set('Authorization', `Bearer ${bannedToken}`).send({ body: 'hi' });
  expect(banned.status).toBe(403);
  expect(banned.body.error).toBe('Account banned.');
});

it('POST /:id/close closes the caller ticket', async () => {
  const token = allowUser();
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) {
      return { rows: [{ token_version: 0, banned: false }] };
    }
    if (/SELECT \* FROM tickets WHERE id/.test(sql)) {
      return { rows: [{ id: 5, user_id: 7, status: 'open' }] };
    }
    if (/UPDATE tickets SET status = 'closed'/.test(sql)) {
      return { rows: [{ id: 5, status: 'closed' }] };
    }
    return { rows: [] };
  };
  const res = await request(app()).post('/api/tickets/5/close').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.ticket.status).toBe('closed');
});
