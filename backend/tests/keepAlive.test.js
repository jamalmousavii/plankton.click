// 1.1.9: slow worker replies must not be cut by Cloudflare's 100 s limit.
// The keep-alive commits a 200 early and trickles whitespace; late errors
// carry their real status as `http_status`.
const express = require('express');
const compression = require('compression');
const http = require('http');
const { startKeepAlive } = require('../src/services/keepAlive');

function serve(handler) {
  const app = express();
  app.use(compression());
  app.get('/t', handler);
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function get(srv) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const firstAt = { t: null };
    const t0 = Date.now();
    http.get({ host: '127.0.0.1', port: srv.address().port, path: '/t', headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      res.on('data', (c) => { if (firstAt.t === null) firstAt.t = Date.now() - t0; chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), firstByteMs: firstAt.t, totalMs: Date.now() - t0 }));
    }).on('error', reject);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('keepAlive', () => {
  it('fast replies keep their real status and body (no trickle)', async () => {
    const srv = await serve(async (req, res) => {
      const ka = startKeepAlive(res, { delayMs: 200, intervalMs: 50 });
      ka.send(503, { error: 'no workers', code: 'WORKER_OFFLINE' });
    });
    const r = await get(srv); srv.close();
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body)).toEqual({ error: 'no workers', code: 'WORKER_OFFLINE' });
  });

  it('slow replies start streaming early (uncompressed) and end as valid JSON', async () => {
    const srv = await serve(async (req, res) => {
      const ka = startKeepAlive(res, { delayMs: 50, intervalMs: 30 });
      await wait(250);
      ka.send(200, { success: true, response: 'hello' });
    });
    const r = await get(srv); srv.close();
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(r.headers['x-accel-buffering']).toBe('no');
    expect(r.firstByteMs).toBeLessThan(200); // first space long before the answer
    expect(r.body.startsWith('  ')).toBe(true);
    expect(JSON.parse(r.body)).toEqual({ success: true, response: 'hello' });
  });

  it('a late error keeps its real status in the body', async () => {
    const srv = await serve(async (req, res) => {
      const ka = startKeepAlive(res, { delayMs: 30, intervalMs: 30 });
      await wait(120);
      ka.send(503, { error: 'Workers failed', code: 'WORKER_OFFLINE' });
    });
    const r = await get(srv); srv.close();
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ error: 'Workers failed', code: 'WORKER_OFFLINE', http_status: 503 });
  });
});
