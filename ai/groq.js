'use strict';

// Shared Groq chat-completions service for AunXz. Node.js >=22, no extra SDK required.
// Prompts, user messages, response bodies, authorization headers, and API keys are never logged.
const crypto = require('node:crypto');

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'openai/gpt-oss-20b';
const inFlight = new Map();
const rateWindows = new Map();
const samples = new Map();
const activeGuilds = new Map();
const activeUsers = new Map();
let activeGlobal = 0;

class GroqError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'GroqError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.retryable = Boolean(options.retryable);
  }
}

const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeInt = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function apiBaseUrl() {
  const value = String(process.env.GROQ_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(value); } catch { throw new GroqError('ai_config', 'GROQ_BASE_URL must be a valid HTTP(S) URL.'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new GroqError('ai_config', 'GROQ_BASE_URL must be an HTTP(S) URL without embedded credentials.');
  }
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new GroqError('ai_config', 'GROQ_BASE_URL must use HTTPS except for localhost development.');
  }
  return value;
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 24) {
    throw new GroqError('ai_validation', 'An AI request must contain between 1 and 24 messages.');
  }
  let totalChars = 0;
  const normalized = messages.map((message, index) => {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
      throw new GroqError('ai_validation', `AI message ${index + 1} is invalid.`);
    }
    if (message.content.length > 16000) throw new GroqError('ai_validation', 'A single AI message exceeds 16,000 characters.');
    totalChars += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (totalChars > 32000) throw new GroqError('ai_validation', 'The AI request exceeds the 32,000-character context limit.');
  return normalized;
}

function rateLimit(scope, limit, windowMs) {
  const now = Date.now();
  let record = rateWindows.get(scope);
  if (!record || now - record.startedAt >= windowMs) record = { startedAt: now, count: 0 };
  record.count++;
  rateWindows.set(scope, record);
  if (rateWindows.size > 10000) {
    for (const [key, item] of rateWindows) if (now - item.startedAt > windowMs * 2) rateWindows.delete(key);
    while (rateWindows.size > 10000) rateWindows.delete(rateWindows.keys().next().value);
  }
  if (record.count > limit) {
    throw new GroqError('ai_rate_limited', 'The AI usage limit was reached. Please try again shortly.', {
      retryAfterMs: Math.max(1000, windowMs - (now - record.startedAt)), retryable: true
    });
  }
}

function acquireSlot(guildId, userId) {
  const guild = String(guildId || 'dm');
  const user = String(userId || 'unknown');
  const maxGlobal = safeInt(process.env.GROQ_MAX_CONCURRENCY, 6, 1, 32);
  const maxGuild = safeInt(process.env.GROQ_MAX_GUILD_CONCURRENCY, 2, 1, 12);
  const maxUser = safeInt(process.env.GROQ_MAX_USER_CONCURRENCY, 1, 1, 4);
  if (activeGlobal >= maxGlobal || (activeGuilds.get(guild) || 0) >= maxGuild || (activeUsers.get(user) || 0) >= maxUser) {
    throw new GroqError('ai_busy', 'AunXz is handling other AI requests right now. Try again in a moment.', { retryable: true });
  }
  activeGlobal++;
  activeGuilds.set(guild, (activeGuilds.get(guild) || 0) + 1);
  activeUsers.set(user, (activeUsers.get(user) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeGlobal = Math.max(0, activeGlobal - 1);
    const guildCount = (activeGuilds.get(guild) || 1) - 1;
    const userCount = (activeUsers.get(user) || 1) - 1;
    if (guildCount) activeGuilds.set(guild, guildCount); else activeGuilds.delete(guild);
    if (userCount) activeUsers.set(user, userCount); else activeUsers.delete(user);
  };
}

function getRetryDelay(response, body) {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, Math.min(5000, seconds * 1000));
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, Math.min(5000, date - Date.now()));
  }
  const text = String(body?.error?.message || '');
  const match = text.match(/retry after\s+(\d+(?:\.\d+)?)\s*s/i);
  return match ? Math.min(5000, Number(match[1]) * 1000) : 0;
}

function classifyResponse(status, retryAfterMs) {
  if (status === 401 || status === 403) return new GroqError('ai_auth', 'Groq authentication failed. Check GROQ_API_KEY and account/model access.', { status });
  if (status === 404) return new GroqError('ai_model', 'The configured Groq model or endpoint was not found. Verify GROQ_MODEL against the current Groq model catalogue.', { status });
  if (status === 400 || status === 422) return new GroqError('ai_validation', 'Groq rejected the request format. Check the configured model and request options.', { status });
  if (status === 429) return new GroqError('ai_rate_limited', 'Groq rate-limited the request.', { status, retryAfterMs, retryable: true });
  if (status >= 500) return new GroqError('ai_provider', `Groq returned provider status ${status}.`, { status, retryable: true });
  return new GroqError('ai_provider', `Groq request failed with status ${status}.`, { status });
}

function recordMetric(task, elapsedMs, success) {
  const key = String(task || 'chat').slice(0, 48);
  let item = samples.get(key);
  if (!item) { item = { durations: [], successful: 0, failed: 0 }; samples.set(key, item); }
  item.durations.push(Math.max(0, elapsedMs));
  if (item.durations.length > 2048) item.durations.shift();
  if (success) item.successful++; else item.failed++;
}

async function requestModel(messages, model, options, apiKey, timeoutMs, retries) {
  const endpoint = `${apiBaseUrl()}/chat/completions`;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) throw new GroqError('ai_cancelled', 'The AI request was cancelled.');
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
    const body = { model, messages, temperature: options.temperature, max_tokens: options.maxTokens, stream: false };
    if (options.jsonMode) body.response_format = { type: 'json_object' };
    const startedAt = monotonicMs();
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal
      });
    } catch (error) {
      if (options.signal?.aborted) throw new GroqError('ai_cancelled', 'The AI request was cancelled.');
      const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      lastError = new GroqError(isTimeout ? 'ai_timeout' : 'ai_network', isTimeout ? `Groq request timed out after ${timeoutMs} ms.` : 'Could not reach the Groq API.', { retryable: true });
      console.warn(`[Groq] model=${model} failure=${lastError.code} attempt=${attempt + 1}`);
      if (attempt >= retries) throw lastError;
      await wait(Math.min(2500, 200 * (2 ** attempt)) * (0.75 + Math.random() * 0.5));
      continue;
    }

    const responseMs = monotonicMs() - startedAt;
    const data = await response.json().catch(() => null);
    if (response.ok) {
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new GroqError('ai_empty_response', 'Groq returned an empty response.', { status: response.status });
      return {
        content: content.trim(), model: String(data?.model || model), usage: data?.usage || null,
        requestId: String(response.headers.get('x-request-id') || response.headers.get('request-id') || '').slice(0, 100),
        durationMs: responseMs
      };
    }

    const retryAfterMs = getRetryDelay(response, data);
    lastError = classifyResponse(response.status, retryAfterMs);
    // Only sanitized request metadata reaches logs; provider body and user content are omitted.
    console.warn(`[Groq] status=${response.status} model=${model} latency_ms=${Math.round(responseMs)} attempt=${attempt + 1}`);
    if (!lastError.retryable || attempt >= retries) throw lastError;
    const exponential = Math.min(2500, 200 * (2 ** attempt)) * (0.75 + Math.random() * 0.5);
    await wait(Math.max(retryAfterMs, exponential));
  }
  throw lastError || new GroqError('ai_provider', 'Groq request failed.');
}

async function chatCompletion({
  messages, guildId = 'dm', userId = 'unknown', task = 'chat', signal,
  model, maxTokens = 600, temperature = 0.2, jsonMode = false, deduplicate = true
} = {}) {
  const startedAt = monotonicMs();
  let released = null;
  let succeeded = false;
  try {
    const apiKey = String(process.env.GROQ_API_KEY || '').trim();
    if (!apiKey) throw new GroqError('ai_missing_key', 'Groq AI is not configured. Set GROQ_API_KEY in your bot environment.');
    const cleanMessages = validateMessages(messages);
    const primary = String(model || process.env.GROQ_MODEL || DEFAULT_MODEL).trim();
    if (!/^[a-zA-Z0-9._:/-]{1,128}$/.test(primary)) throw new GroqError('ai_config', 'GROQ_MODEL has an invalid format.');
    const fallback = String(process.env.GROQ_FALLBACK_MODEL || '').trim();
    if (fallback && !/^[a-zA-Z0-9._:/-]{1,128}$/.test(fallback)) throw new GroqError('ai_config', 'GROQ_FALLBACK_MODEL has an invalid format.');
    const models = [...new Set([primary, ...(fallback && fallback !== primary ? [fallback] : [])])];
    const timeoutMs = safeInt(process.env.GROQ_TIMEOUT_MS, 15000, 1000, 120000);
    const retries = safeInt(process.env.GROQ_MAX_RETRIES, 1, 0, 3);
    const outputTokens = safeInt(maxTokens, 600, 1, 8192);
    const temp = Number(temperature);
    if (!Number.isFinite(temp) || temp < 0 || temp > 2) throw new GroqError('ai_validation', 'temperature must be between 0 and 2.');

    const dedupKey = sha256(JSON.stringify({ guildId, userId, task, models, cleanMessages, outputTokens, temp, jsonMode }));
    // Do not share a cancellable request between callers with independent AbortSignals.
    if (deduplicate && !signal && inFlight.has(dedupKey)) {
      const shared = await inFlight.get(dedupKey);
      succeeded = true;
      return shared;
    }

    rateLimit(`user:${guildId}:${userId}`, safeInt(process.env.GROQ_USER_RPM, 12, 1, 120), 60000);
    rateLimit(`guild:${guildId}`, safeInt(process.env.GROQ_GUILD_RPM, 60, 1, 600), 60000);
    released = acquireSlot(guildId, userId);

    const promise = (async () => {
      let lastError;
      for (let index = 0; index < models.length; index++) {
        try {
          const result = await requestModel(cleanMessages, models[index], { signal, maxTokens: outputTokens, temperature: temp, jsonMode }, apiKey, timeoutMs, retries);
          console.info(`[Groq] task=${String(task).slice(0, 32)} model=${result.model} latency_ms=${Math.round(result.durationMs)} tokens=${Number(result.usage?.total_tokens) || 0}`);
          return { ...result, task };
        } catch (error) {
          lastError = error;
          const fallbackAllowed = index < models.length - 1 && !['ai_auth', 'ai_cancelled', 'ai_validation', 'ai_config'].includes(error?.code);
          if (!fallbackAllowed) throw error;
          console.warn(`[Groq] trying_fallback=true cause=${String(error?.code || 'unknown').slice(0, 32)}`);
        }
      }
      throw lastError || new GroqError('ai_provider', 'Groq request failed.');
    })();
    if (deduplicate && !signal) {
      inFlight.set(dedupKey, promise);
      if (inFlight.size > 256) inFlight.delete(inFlight.keys().next().value);
    }
    try {
      const result = await promise;
      succeeded = true;
      return result;
    } finally {
      if (deduplicate && !signal && inFlight.get(dedupKey) === promise) inFlight.delete(dedupKey);
    }
  } finally {
    if (released) released();
    recordMetric(task, monotonicMs() - startedAt, succeeded);
    if (rateWindows.size > 5000) {
      const cutoff = Date.now() - 120000;
      for (const [key, row] of rateWindows) if (row.startedAt < cutoff) rateWindows.delete(key);
    }
  }
}

function getMetrics() {
  const percentile = (values, p) => values.length ? values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] : null;
  return Object.fromEntries([...samples.entries()].map(([key, item]) => [key, {
    samples: item.durations.length, successful: item.successful, failed: item.failed,
    medianMs: percentile(item.durations, 0.5), p95Ms: percentile(item.durations, 0.95), p99Ms: percentile(item.durations, 0.99)
  }]));
}

module.exports = {
  chatCompletion, GroqError, getMetrics, DEFAULT_MODEL, DEFAULT_BASE_URL,
  _internals: {
    validateMessages, apiBaseUrl, classifyResponse,
    resetForTests() { inFlight.clear(); rateWindows.clear(); samples.clear(); activeGuilds.clear(); activeUsers.clear(); activeGlobal = 0; }
  }
};
