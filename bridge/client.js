'use strict';
// bridge/client.js — used by the web backend to ask the bot for a template code.
//
//   BOT_BRIDGE_URL set   -> signed HTTP request to the bot (web app is a separate service)
//   BOT_BRIDGE_URL empty -> direct in-process call (web app runs inside the bot process)
//
// Both return the same shape: { code, shortCode, fitsInCommand, stats, warnings, snapshot }
// and both throw BridgeError (code: invalid_spec | too_large | unavailable | unauthorized | rate_limited | internal).

const { BridgeError } = require('./spec');
const { sign } = require('./httpBridge');

const TIMEOUT_MS = 20000;

async function viaHttp(spec, { requestedBy, signal }) {
  const base = String(process.env.BOT_BRIDGE_URL).replace(/\/+$/, '');
  const secret = process.env.BOT_BRIDGE_SECRET;
  if (!secret) throw new BridgeError('unavailable', 'BOT_BRIDGE_SECRET is not set, so the web app cannot talk to the bot.');

  const raw = JSON.stringify({ spec, requestedBy: requestedBy || 'web' });
  const ts = String(Date.now());
  const signals = [AbortSignal.timeout(TIMEOUT_MS)];
  if (signal) signals.push(signal);

  let res;
  try {
    res = await fetch(`${base}/bridge/template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Timestamp': ts, 'X-Bridge-Signature': sign(secret, ts, raw) },
      body: raw,
      signal: AbortSignal.any(signals)
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new BridgeError('unavailable', 'The bot is offline or unreachable, so a template code cannot be generated right now. You can still export the JSON or the Markdown guide.');
  }

  let data = null;
  try { data = await res.json(); } catch { /* handled below */ }
  if (res.ok && data?.ok) { const { ok, ...result } = data; return result; }
  const code = data?.code || (res.status === 401 ? 'unauthorized' : res.status === 429 ? 'rate_limited' : 'internal');
  throw new BridgeError(code, data?.message || `Bot bridge returned HTTP ${res.status}.`, data?.errors);
}

async function inProcess(spec, { requestedBy }) {
  let mod;
  try { mod = require('./templateBridge'); }
  catch {
    throw new BridgeError('unavailable', 'The bot bridge is not available in this process. Run the web app inside the bot (WEB_ENABLED=true) or set BOT_BRIDGE_URL and BOT_BRIDGE_SECRET.');
  }
  return mod.buildTemplateFromSpec(spec, { requestedBy });
}

async function buildTemplate(spec, opts = {}) {
  return process.env.BOT_BRIDGE_URL ? viaHttp(spec, opts) : inProcess(spec, opts);
}

module.exports = { buildTemplate };
