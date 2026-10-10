'use strict';
// bridge/generate.js — user prompt -> OpenRouter AI -> JSON spec -> bot builds the code.
//
//   const { generateTemplate } = require('./bridge/generate');
//   const out = await generateTemplate({ prompt, requestedBy: 'user-42', onStatus: s => ... });
//   // out = { spec, code, shortCode, fitsInCommand, stats, warnings, snapshot, attempts, usage }
//
// The AI only ever produces DATA (the spec). The bot validates it and does all signing.
// Up to 2 automatic repair rounds feed exact error paths back to the model.

const { PERMISSION_NAMES, CHANNEL_TYPES, LIMITS, BridgeError, validateSpec, formatErrors } = require('./spec');
const { buildTemplate } = require('./client');

const API = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_ATTEMPTS = 3;           // 1 first try + 2 repair rounds
const MAX_PROMPT = 2000;

class MissingKeyError extends Error {
  constructor() {
    super('OPENROUTER_API_KEY is not set, so AI features are disabled.');
    this.name = 'MissingKeyError';
    this.code = 'missing_key';
    this.howTo = [
      '1. Create a key at https://openrouter.ai/keys (add a little credit if the model you choose is paid).',
      '2. Set it as the environment variable OPENROUTER_API_KEY — in a local .env file, or in the Variables tab on Railway.',
      '3. Restart the app. Never put the key in frontend code or commit it to GitHub.'
    ].join('\n');
  }
}

const SYSTEM_PROMPT = `You design Discord server templates. Reply with ONE JSON object and nothing else (no markdown, no commentary).

SCHEMA
{
  "specVersion": 1,
  "name": string (1-${LIMITS.name} chars),
  "description": string (optional, short),
  "roles": [ { "name": string, "color": "#rrggbb", "hoist": boolean, "mentionable": boolean, "permissions": [PermissionName], "emoji": "single unicode emoji (optional)" } ],
  "channels": [ Channel ]            // optional: channels that sit outside any category
  "categories": [ { "name": string, "overwrites": [Overwrite], "channels": [ Channel ] } ],
  "settings": { "verificationLevel": 0-4, "contentFilter": 0-2, "defaultNotifications": "all"|"mentions", "afkTimeout": 60|300|900|1800|3600 }   // optional
}
Channel   = { "name": string, "type": ${CHANNEL_TYPES.map(t => `"${t}"`).join('|')}, "topic": string (text/announcement/forum only, max ${LIMITS.topic}), "nsfw": boolean, "slowmode": 0-21600 (seconds), "userLimit": 0-99 (voice), "bitrate": 8000-96000 (voice/stage), "overwrites": [Overwrite] }
Overwrite = { "role": "@everyone" | an exact role name from "roles", "allow": [PermissionName], "deny": [PermissionName] }
PermissionName must be exactly one of: ${PERMISSION_NAMES.join(', ')}.

HARD RULES
- Roles are listed from the HIGHEST rank to the LOWEST. Unique names. Never name a role everyone/@everyone.
- At most ${LIMITS.roles} roles, ${LIMITS.perCategory} channels per category, ${LIMITS.channels} channels in total (each category counts as one).
- Text/announcement/forum channel names: lowercase, words joined by hyphens. Voice/stage/category names can use capitals, spaces and emoji.
- Overwrites may only reference "@everyone" or role names that exist in "roles". A permission may not be in both allow and deny of one overwrite.
- Category overwrites are applied to every channel inside it automatically; do not repeat them on each channel.
- Do not output anything outside the schema.

DESIGN GUIDANCE
- Make it genuinely usable: a clear welcome/info area (rules, announcements), community channels, voice channels, and a staff area hidden from @everyone (deny ViewChannel for @everyone, allow it for staff roles).
- Give staff a sensible hierarchy (owner, admin, moderator, helper) with least-privilege permissions; only the top role gets Administrator.
- Read-only info channels: deny SendMessages for @everyone. Write useful channel topics.
- Match the user's theme in names, colours and emoji, but keep names short and readable.
- Size the server to the request. Do not pad it with filler channels.`;

function extractJson(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a === -1 || b <= a) throw new Error('no JSON object found in the reply');
  return JSON.parse(t.slice(a, b + 1));
}

async function callOpenRouter(messages, { signal, useJsonMode = true } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new MissingKeyError();
  const model = process.env.OPENROUTER_MODEL || 'openrouter/auto';
  const body = { model, messages, temperature: 0.7, max_tokens: Number(process.env.OPENROUTER_MAX_TOKENS) || 8000 };
  if (useJsonMode) body.response_format = { type: 'json_object' };

  const signals = [AbortSignal.timeout(120000)];
  if (signal) signals.push(signal);

  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
        'HTTP-Referer': process.env.SITE_URL || 'http://localhost:3000', 'X-Title': 'ANXAI'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals)
    });
    if (res.status !== 429 && res.status < 500) break;
    await new Promise(r => setTimeout(r, 1500));
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = String(data?.error?.message || res.statusText || '').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 200);
    if (res.status === 400 && useJsonMode) return callOpenRouter(messages, { signal, useJsonMode: false }); // model without JSON mode
    if (res.status === 401) throw new BridgeError('ai_auth', 'OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY.');
    if (res.status === 402) throw new BridgeError('ai_credits', 'OpenRouter reports not enough credits (402). Add credits or choose a free model in OPENROUTER_MODEL.');
    if (res.status === 429) throw new BridgeError('ai_rate_limited', 'OpenRouter rate limit reached. Try again in a moment.');
    throw new BridgeError('ai_error', `OpenRouter error ${res.status}: ${detail}`);
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text || !String(text).trim()) throw new BridgeError('ai_error', 'The AI returned an empty reply. Try again or pick another model.');
  return { text: String(text), usage: data.usage || null };
}

/**
 * @param {object} p
 * @param {string} p.prompt        what the user wants
 * @param {object} [p.refineFrom]  current spec to modify (refinement)
 * @param {string} [p.requestedBy] id used for the saved short code
 * @param {(s:string)=>void} [p.onStatus]
 * @param {AbortSignal} [p.signal]
 */
async function generateTemplate({ prompt, refineFrom, requestedBy, onStatus = () => {}, signal } = {}) {
  const userPrompt = String(prompt || '').trim().slice(0, MAX_PROMPT);
  if (!userPrompt) throw new BridgeError('invalid_spec', 'Describe the server you want first.');
  if (!process.env.OPENROUTER_API_KEY) throw new MissingKeyError();

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  messages.push({
    role: 'user',
    content: refineFrom
      ? `Here is the current template:\n${JSON.stringify(refineFrom)}\n\nApply this change and return the COMPLETE updated template as JSON:\n${userPrompt}`
      : `Design this server:\n${userPrompt}`
  });

  let lastErrors = [];
  let usage = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    onStatus(attempt === 1 ? 'Designing your server…' : `Fixing issues the bot found (round ${attempt - 1} of ${MAX_ATTEMPTS - 1})…`);
    const { text, usage: u } = await callOpenRouter(messages, { signal });
    usage = u || usage;
    messages.push({ role: 'assistant', content: text });

    let parsed;
    try { parsed = extractJson(text); }
    catch (e) {
      lastErrors = [{ path: '$', message: `reply was not valid JSON (${e.message})` }];
      messages.push({ role: 'user', content: `Your reply could not be parsed: ${e.message}. Reply again with ONE valid JSON object only.` });
      continue;
    }

    const local = validateSpec(parsed);
    if (!local.ok) {
      lastErrors = local.errors;
      messages.push({ role: 'user', content: `The template has errors. Fix them and return the COMPLETE corrected JSON:\n${formatErrors(local.errors)}` });
      continue;
    }

    onStatus('Asking the bot to build the template code…');
    try {
      // Send the AI's original JSON (hex colours etc.): the bot validates and normalises it itself.
      const built = await buildTemplate(parsed, { requestedBy, signal });
      return { spec: parsed, ...built, attempts: attempt, usage };
    } catch (e) {
      if (e instanceof BridgeError && e.code === 'invalid_spec') {
        lastErrors = e.errors;
        messages.push({ role: 'user', content: `The bot rejected the template. Fix these and return the COMPLETE corrected JSON:\n${formatErrors(e.errors)}` });
        continue;
      }
      throw e; // bot offline, unauthorized, rate limited, internal: not the AI's fault
    }
  }
  throw new BridgeError('invalid_spec', `The AI could not produce a valid template after ${MAX_ATTEMPTS} attempts.`, lastErrors);
}

module.exports = { generateTemplate, MissingKeyError, SYSTEM_PROMPT, _extractJson: extractJson };
