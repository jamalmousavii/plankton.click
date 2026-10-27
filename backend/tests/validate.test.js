const express = require('express');
const request = require('supertest');
const { registerRules, loginRules, chatRules, validate } = require('../src/middleware/validate');

function buildApp(rules) {
  const app = express();
  app.use(express.json());
  app.post('/x', rules, validate, (req, res) => res.json({ ok: true }));
  return app;
}

describe('register validation', () => {
  const app = buildApp(registerRules);

  it('rejects a self-registration that claims the admin role', async () => {
    const res = await request(app)
      .post('/x')
      .send({ email: 'a@b.co', password: 'secret1', role: 'admin' });

    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => d.field === 'role')).toBe(true);
  });

  it('accepts role=worker and role=user', async () => {
    for (const role of ['user', 'worker']) {
      const res = await request(app).post('/x').send({ email: 'a@b.co', password: 'Secret123', role });
      expect(res.status).toBe(200);
    }
  });

  it('rejects a too-short password', async () => {
    const res = await request(app).post('/x').send({ email: 'a@b.co', password: '123' });
    expect(res.status).toBe(400);
  });

  it('rejects a weak password without uppercase/number', async () => {
    const res = await request(app).post('/x').send({ email: 'a@b.co', password: 'weakpass' });
    expect(res.status).toBe(400);
  });
});

describe('login validation', () => {
  const app = buildApp(loginRules);

  it('rejects a missing password', async () => {
    const res = await request(app).post('/x').send({ email: 'a@b.co' });
    expect(res.status).toBe(400);
  });
});

describe('chat validation', () => {
  const app = buildApp(chatRules);

  it('rejects an oversized message before it reaches the GPU', async () => {
    const res = await request(app).post('/x').send({ message: 'x'.repeat(10001) });
    expect(res.status).toBe(400);
  });

  it('rejects an empty message', async () => {
    const res = await request(app).post('/x').send({ message: '   ' });
    expect(res.status).toBe(400);
  });

  it('accepts a normal message', async () => {
    const res = await request(app).post('/x').send({ message: 'hello', model: 'llama3.1:8b' });
    expect(res.status).toBe(200);
  });
});
