// Long worker dispatches vs. the Cloudflare proxy.
//
// plankton.click is proxied by Cloudflare, which aborts a request whose
// response has not started within 100 s (HTTP 524). The browser then sees a
// network error ("Error connecting to server") even though the worker is
// still generating; CPU workers and big models routinely need longer.
//
// Once a dispatch has run for `delayMs`, this commits a 200 with a JSON
// content type and trickles single spaces (valid leading JSON whitespace)
// until the real body is ready. Because the status is already sent by then,
// a late error keeps its real status in the body as `http_status`; the
// frontend's apiFetch turns that back into an ApiError. Fast replies never
// start the trickle and keep their normal status codes.

const DEFAULT_DELAY_MS = 20000;
const DEFAULT_INTERVAL_MS = 15000;

function startKeepAlive(res, { delayMs = DEFAULT_DELAY_MS, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  let started = false;
  let finished = false;
  let ticker = null;

  const stop = () => {
    clearTimeout(starter);
    if (ticker) clearInterval(ticker);
    ticker = null;
  };

  const tick = () => {
    if (finished || res.writableEnded || res.destroyed) return stop();
    res.write(' ');
    if (typeof res.flush === 'function') res.flush();
  };

  const starter = setTimeout(() => {
    if (finished || res.headersSent || res.destroyed) return;
    started = true;
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // no-transform: the compression middleware skips the response, so each
    // space leaves immediately instead of waiting in a gzip buffer.
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx: do not buffer
    res.flushHeaders();
    tick();
    ticker = setInterval(tick, intervalMs);
  }, delayMs);

  // Client went away (tab closed, proxy gave up): stop writing.
  res.on('close', () => { finished = true; stop(); });

  return {
    get started() { return started; },
    /** Send the final response: normal status if the trickle never began. */
    send(status, body) {
      finished = true;
      stop();
      if (res.writableEnded || res.destroyed) return undefined;
      if (!started) return res.status(status).json(body);
      const payload = status >= 400 && body && typeof body === 'object' && !Array.isArray(body)
        ? { ...body, http_status: status }
        : body;
      return res.end(JSON.stringify(payload));
    },
    /** Stop the trickle without answering (the caller responds itself). */
    cancel() { finished = true; stop(); },
  };
}

module.exports = { startKeepAlive, DEFAULT_DELAY_MS, DEFAULT_INTERVAL_MS };
