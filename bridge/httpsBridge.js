'use strict';
// bridge/httpBridge.js — small authenticated HTTP endpoint on the bot, used only when the web app runs
// as a SEPARATE service. When the web app runs inside the bot process this file is never started.
//
//   POST /bridge/template   body: the JSON spec
//     X-Bridge-Timestamp: <ms since epoch>
//     X-Bridge-Signature: hex( HMAC-SHA256( BOT_BRIDGE_SECRET, `${timestamp}.${rawBody}` ) )
//   GET  /bridge/health     -> { ok: true }   (no data, no auth)
//
// Rejected: bad/missing signature, timestamp older/newer than 60 s, replayed signature, body > 512 KB,
// non-JSON content type, and anything over the rate limits.

const http = require('http');
const crypto = require('crypto');
const { BridgeError } = require('./spec');

const MAX_BODY = 512 * 1024;
const MAX_SKEW_MS = 60 * 1000;
const PER_IP_PER_MIN = 30;
const GLOBAL_PER_MIN = 120;

const STATUS = { invalid_spec: 422, too_large: 413, unauthorized: 401, rate_limited: 429 };

function sign(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

function createBridgeServer({ secret, build, now = Date.now }) {
  if (!secret || String(secret).length < 24) throw new Error('BOT_BRIDGE_SECRET must be at least 24 characters.');
  const seen = new Map();            // signature -> expiry (replay protection)
  const hits = new Map();            // ip -> { minute, n }
  let globalWindow = { minute: 0, n: 0 };

  const rateLimited = ip => {
    const minute = Math.floor(now() / 60000);
    if (globalWindow.minute !== minute) globalWindow = { minute, n: 0 };
    if (++globalWindow.n > GLOBAL_PER_MIN) return true;
    const h = hits.get(ip);
    if (!h || h.minute !== minute) { hits.set(ip, { minute, n: 1 }); }
    else if (++h.n > PER_IP_PER_MIN) return true;
    if (hits.size > 5000) for (const [k, v] of hits) if (v.minute !== minute) hits.delete(k);
    return false;
  };

  const send = (res, status, body) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
    res.end(data);
  };
  const fail = (res, code, message, errors) => send(res, STATUS[code] || 500, { ok: false, code, message, errors: errors || [] });

  const server = http.createServer((req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const url = (req.url || '').split('?')[0];

    if (req.method === 'GET' && url === '/bridge/health') return send(res, 200, { ok: true });
    if (req.method !== 'POST' || url !== '/bridge/template') return send(res, 404, { ok: false, code: 'not_found', message: 'Not found.' });
    if (rateLimited(ip)) return fail(res, 'rate_limited', 'Too many requests.');
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return fail(res, 'invalid_spec', 'Content-Type must be application/json.');

    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY) { fail(res, 'too_large', 'Body too large.'); return req.destroy(); }

    const chunks = []; let size = 0; let aborted = false;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { aborted = true; fail(res, 'too_large', 'Body too large.'); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', () => {});
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      const ts = String(req.headers['x-bridge-timestamp'] || '');
      const sig = String(req.headers['x-bridge-signature'] || '');
      const t = Number(ts);

      if (!ts || !sig || !Number.isFinite(t) || Math.abs(now() - t) > MAX_SKEW_MS) return fail(res, 'unauthorized', 'Missing, invalid, or expired signature.');
      const good = Buffer.from(sign(secret, ts, raw));
      const given = Buffer.from(sig);
      if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) return fail(res, 'unauthorized', 'Missing, invalid, or expired signature.');

      for (const [k, exp] of seen) if (exp < now()) seen.delete(k);
      if (seen.has(sig)) return fail(res, 'unauthorized', 'Request already used.');
      seen.set(sig, now() + 2 * MAX_SKEW_MS);

      let payload;
      try { payload = JSON.parse(raw); } catch { return fail(res, 'invalid_spec', 'Body is not valid JSON.'); }
      const spec = payload && payload.spec;
      const requestedBy = payload && typeof payload.requestedBy === 'string' ? payload.requestedBy : 'web';
      try {
        const result = build(spec, { requestedBy });
        send(res, 200, { ok: true, ...result });
      } catch (e) {
        if (e instanceof BridgeError) return fail(res, e.code, e.message, e.errors);
        console.error('[bridge] internal error:', e);
        fail(res, 'internal', 'Internal error while building the template.');
      }
    });
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  return server;
}

module.exports = { createBridgeServer, sign, MAX_BODY, MAX_SKEW_MS };
