// v3.39.0 — admin ticket management (routes/admin.js, ticket section).
// Distinct JWT ids per case: requireAdmin's role cache and authenticate's
// auth-state cache are module-level and live for the whole suite.

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
const adminRouter = require('../src/routes/admin');

const SECRET = process.env.JWT_SECRET;

function sign(payload) {
  return jwt.sign(payload, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

const ADMIN = sign({ id: 1, email: 'admin@plankton.click', role: 'admin', token_version: 0 });
const PLAIN = sign({ id: 2, email: 'plain@t.t', role: 'user', token_version: 0 });

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', adminRouter);
  return a;
}

function resetPool() {
  pool.__state.statements.length = 0;
  pool.__state.queryImpl = async () => ({ rows: [] });
}

function authAs(role) {
  return async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
    if (/SELECT role FROM users/.test(sql)) return { rows: [{ role }] };
    return { rows: [] };
  };
}

beforeEach(resetPool);

it('rejects a non-admin (403) but lets an admin through', async () => {
  pool.__state.queryImpl = authAs('user');
  const denied = await request(app()).get('/api/admin/tickets').set('Authorization', `Bearer ${PLAIN}`);
  expect(denied.status).toBe(403);

  pool.__state.statements.length = 0;
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
    if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: 'admin' }] };
    return { rows: [{ id: 1, subject: 'Hi', status: 'open', email: 'u@t.t' }] };
  };
  const allowed = await request(app()).get('/api/admin/tickets').set('Authorization', `Bearer ${ADMIN}`);
  expect(allowed.status).toBe(200);
  expect(allowed.body.tickets).toHaveLength(1);
});

it('GET /tickets?status= filters and ?q= searches', async () => {
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
    if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: 'admin' }] };
    return { rows: [] };
  };
  const res = await request(app())
    .get('/api/admin/tickets?status=open&q=billing')
    .set('Authorization', `Bearer ${ADMIN}`);
  expect(res.status).toBe(200);
  const listSql = pool.__state.statements.find((s) => s.includes('FROM tickets t'));
  expect(listSql).toMatch(/t\.status = \$1/);
  expect(listSql).toMatch(/ILIKE/);
});

it('GET /tickets/:id — 404 unknown, thread returned for a real ticket', async () => {
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
    if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: 'admin' }] };
    if (/SELECT t\.\*, u\.email, u\.name FROM tickets/.test(sql)) {
      return { rows: [{ id: 7, user_id: 4, subject: 'S', status: 'open', email: 'x@t.t', name: 'X' }] };
    }
    if (/FROM ticket_messages WHERE ticket_id/.test(sql)) {
      return { rows: [{ id: 1, user_id: 4, is_admin: false, body: 'help' }] };
    }
    return { rows: [] };
  };
  const found = await request(app()).get('/api/admin/tickets/7').set('Authorization', `Bearer ${ADMIN}`);
  expect(found.status).toBe(200);
  expect(found.body.messages).toHaveLength(1);

  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
    if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: 'admin' }] };
    return { rows: [] };
  };
  const missing = await request(app()).get('/api/admin/tickets/999').set('Authorization', `Bearer ${ADMIN}`);
  expect(missing.status).toBe(404);
});

it('POST /tickets/:id/messages — admin reply sets status answered (201)', async () => {
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
    if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: 'admin' }] };
    if (/SELECT id, status FROM tickets WHERE id/.test(sql)) return { rows: [{ id: 7, status: 'open' }] };
    if (/INSERT INTO ticket_messages/.test(sql)) {
      return { rows: [{ id: 33, ticket_id: 7, is_admin: true, body: 'on it' }] };
    }
    if (/UPDATE tickets SET status = 'answered'/.test(sql)) {
      return { rows: [{ id: 7, status: 'answered' }] };
    }
    return { rows: [] };
  };
  const res = await request(app()).post('/api/admin/tickets/7/messages')
    .set('Authorization', `Bearer ${ADMIN}`).send({ body: 'on it' });
  expect(res.status).toBe(201);
  expect(res.body.ticket.status).toBe('answered');
  expect(res.body.message.is_admin).toBe(true);
  expect(pool.__state.statements.join(' ')).toMatch(/BEGIN[\s\S]*COMMIT/);

  const noBody = await request(app()).post('/api/admin/tickets/7/messages')
    .set('Authorization', `Bearer ${ADMIN}`).send({ body: '' });
  expect(noBody.status).toBe(400);
});

it('POST /tickets/:id/status — reopen/close writes an audit row; bad status 400', async () => {
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
    if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: 'admin' }] };
    if (/SELECT status FROM tickets WHERE id/.test(sql)) return { rows: [{ status: 'closed' }] };
    if (/UPDATE tickets SET status/.test(sql)) return { rows: [{ id: 7, status: 'open' }] };
    if (/INSERT INTO admin_audit_log/.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  const ok = await request(app()).post('/api/admin/tickets/7/status')
    .set('Authorization', `Bearer ${ADMIN}`).send({ status: 'open' });
  expect(ok.status).toBe(200);
  expect(ok.body.ticket.status).toBe('open');
  expect(pool.__state.statements.join(' ')).toMatch(/INSERT INTO admin_audit_log/);

  const bad = await request(app()).post('/api/admin/tickets/7/status')
    .set('Authorization', `Bearer ${ADMIN}`).send({ status: 'archived' });
  expect(bad.status).toBe(400);
});

it('admin reply on a closed ticket → 409', async () => {
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
    if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: 'admin' }] };
    if (/SELECT id, status FROM tickets WHERE id/.test(sql)) return { rows: [{ id: 7, status: 'closed' }] };
    return { rows: [] };
  };
  const res = await request(app()).post('/api/admin/tickets/7/messages')
    .set('Authorization', `Bearer ${ADMIN}`).send({ body: 'late reply' });
  expect(res.status).toBe(409);
});
