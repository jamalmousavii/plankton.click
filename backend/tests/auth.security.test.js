const express = require('express');
const request = require('supertest');

const authRoutes = require('../src/routes/auth');
const { isEmailConfigured } = require('../src/services/email');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  return app;
}

describe('password reset flow', () => {
  const app = buildApp();

  it('has no email transport configured in this suite', () => {
    expect(isEmailConfigured()).toBe(false);
  });

  it('fails with 503 (not 200) when no email provider is wired up', async () => {
    // Checked BEFORE any account lookup, so the status code cannot be used to
    // enumerate accounts, and the caller never believes a mail was sent.
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'victim@plankton.click' });
    expect(res.status).toBe(503);
    expect(res.body.reset_token).toBeUndefined();
  });

  it('never returns a reset token', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'victim@plankton.click' });
    expect(JSON.stringify(res.body)).not.toMatch(/reset_token/);
  });

  it('rejects a reset request without a token', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({ password: 'newsecret1' });
    expect(res.status).toBe(400);
  });

  it('requires an email on forgot-password', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({});
    expect(res.status).toBe(400);
  });
});

describe('auth input validation (before any DB access)', () => {
  const app = buildApp();

  it('rejects login without a password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'a@b.co' });
    expect(res.status).toBe(400);
  });

  it('rejects registration with role=admin', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'a@b.co', password: 'secret1', role: 'admin' });
    expect(res.status).toBe(400);
  });
});
