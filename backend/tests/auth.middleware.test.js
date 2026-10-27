const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { authenticate, optionalAuth, strictIfHeader, requireAdmin } = require('../src/middleware/auth');

const SECRET = process.env.JWT_SECRET;

function buildApp() {
  const app = express();
  // A handler that stops before any DB access: these tests are about the
  // guard itself, not about the data behind it.
  app.get('/protected', authenticate, (req, res) => res.json({ user: req.user }));
  app.get('/admin', authenticate, requireAdmin, (req, res) => res.json({ ok: true }));
  // requireAdmin on its own (no authenticate in front) must fail closed.
  app.get('/admin-raw', requireAdmin, (req, res) => res.json({ ok: true }));
  // Optional auth (GET /api/plans): the snapshot must stay public — a bad
  // token degrades to anonymous instead of 401ing the catalog (v3.29.1).
  app.get('/public', optionalAuth, (req, res) => res.json({ user: req.user || null }));
  // F4 (v3.32.0): POST /api/chat — guests pass, a PRESENT bad bearer 401s.
  app.get('/chat-strict', strictIfHeader, (req, res) => res.json({ user: req.user || null }));
  return app;
}

describe('authenticate', () => {
  const app = buildApp();

  it('rejects a request with no token', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
  });

  it('rejects a garbage token', async () => {
    const res = await request(app).get('/protected').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = jwt.sign({ id: 1, role: 'user' }, 'attacker-secret-attacker-secret-attacker', {
      algorithm: 'HS256',
      expiresIn: '1h',
    });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('rejects an alg:none token (algorithm pinning)', async () => {
    // jsonwebtoken refuses to mint these, so build the JWT by hand.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ id: 1, role: 'admin' })).toString('base64url');
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${header}.${payload}.`);
    expect(res.status).toBe(401);
  });

  it('accepts a token signed with HS256 and our secret', async () => {
    const token = jwt.sign({ id: 7, role: 'worker' }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(7);
  });
});

describe('requireAdmin', () => {
  const app = buildApp();

  it('rejects unauthenticated callers at the authenticate layer with 401', async () => {
    const res = await request(app).get('/admin');
    expect(res.status).toBe(401);
  });

  it('rejects an unauthenticated caller with 403 when it runs stand-alone', async () => {
    const res = await request(app).get('/admin-raw');
    expect(res.status).toBe(403);
  });

  it('rejects a non-admin before trusting the JWT role claim', async () => {
    // Even a token that *claims* admin must not pass: requireAdmin re-reads the
    // role from the database (and fails closed when the DB is unreachable).
    const token = jwt.sign({ id: 99, role: 'admin' }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    const res = await request(app).get('/admin').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe('optionalAuth', () => {
  const app = buildApp();

  it('serves the public snapshot with no token at all', async () => {
    const res = await request(app).get('/public');
    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });

  it('degrades a garbage token to anonymous instead of 401 (v3.29.1)', async () => {
    const res = await request(app).get('/public').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });

  it('degrades a wrong-secret token to anonymous instead of 401', async () => {
    const token = jwt.sign({ id: 1, role: 'user' }, 'attacker-secret-attacker-secret-attacker', {
      algorithm: 'HS256',
      expiresIn: '1h',
    });
    const res = await request(app).get('/public').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });

  it('populates req.user for a valid token', async () => {
    const token = jwt.sign({ id: 7, role: 'worker' }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    const res = await request(app).get('/public').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(7);
  });
});

describe('strictIfHeader (F4: chat stays public, bad bearer never silently guests)', () => {
  const app = buildApp();

  it('serves a guest with NO Authorization header', async () => {
    const res = await request(app).get('/chat-strict');
    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });

  it('401s a garbage bearer instead of downgrading to anonymous', async () => {
    const res = await request(app).get('/chat-strict').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
  });

  it('401s a wrong-secret token (expired-session clean logout path)', async () => {
    const token = jwt.sign({ id: 1, role: 'user' }, 'attacker-secret-attacker-secret-attacker', {
      algorithm: 'HS256',
      expiresIn: '1h',
    });
    const res = await request(app).get('/chat-strict').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('populates req.user for a valid token', async () => {
    const token = jwt.sign({ id: 7, role: 'user' }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    const res = await request(app).get('/chat-strict').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(7);
  });
});
