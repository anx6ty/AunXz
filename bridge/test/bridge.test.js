'use strict';
// Run with: npm run test:bridge   (needs the project's normal dependencies installed)
const os = require('os'); const fs = require('fs'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
process.env.DATABASE_PATH = path.join(tmp, 'test.sqlite');
process.env.TEMPLATE_SECRET = 'unit-test-template-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, ChannelType } = require('discord.js');
const spec = require('../spec');
const bridge = require('../templateBridge');
const template = require('../../template');
const { createBridgeServer, sign } = require('../httpBridge');

const good = () => ({
  name: 'Squad Hub', description: 'test',
  roles: [
    { name: 'Owner', color: '#e74c3c', hoist: true, permissions: ['Administrator'], emoji: '👑' },
    { name: 'Mod', color: '#3498db', hoist: true, permissions: ['KickMembers', 'ModerateMembers'] },
    { name: 'Member', permissions: ['ViewChannel'] }
  ],
  channels: [{ name: 'welcome', type: 'text' }],
  categories: [
    { name: 'INFO', overwrites: [{ role: '@everyone', allow: ['ViewChannel'], deny: ['SendMessages'] }],
      channels: [{ name: 'rules', type: 'text', topic: 'Be kind' }, { name: 'news', type: 'announcement', overwrites: [{ role: 'Mod', allow: ['SendMessages'] }] }] },
    { name: 'VOICE', channels: [{ name: 'Lounge', type: 'voice', userLimit: 10, bitrate: 64000 }, { name: 'Stage', type: 'stage' }, { name: 'ideas', type: 'forum' }] },
    { name: 'STAFF', overwrites: [{ role: '@everyone', deny: ['ViewChannel'] }, { role: 'Mod', allow: ['ViewChannel'] }], channels: [{ name: 'staff-chat' }] }
  ],
  settings: { verificationLevel: 2, defaultNotifications: 'mentions', afkTimeout: 300 }
});

test('spec: accepts a valid spec', () => {
  const r = spec.validateSpec(good());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('spec: rejects with precise paths', () => {
  const bad = good();
  bad.roles[1].permissions.push('Fly');
  bad.categories[0].channels[0].type = 'chat';
  bad.roles.push({ name: 'owner' });
  bad.categories[1].overwrites = [{ role: 'Ghost', allow: ['ViewChannel'] }];
  bad.categories[2].channels[0].overwrites = [{ role: 'Mod', allow: ['ViewChannel'], deny: ['ViewChannel'] }];
  const r = spec.validateSpec(bad);
  assert.equal(r.ok, false);
  const paths = r.errors.map(e => e.path);
  assert.ok(paths.includes('roles[1].permissions[2]'));
  assert.ok(paths.includes('categories[0].channels[0].type'));
  assert.ok(paths.includes('roles[3].name'));
  assert.ok(paths.includes('categories[1].overwrites[0].role'));
  assert.ok(paths.some(p => p.startsWith('categories[2].channels[0].overwrites[0]')));
});

test('spec: enforces Discord limits', () => {
  const big = good();
  big.categories[0].channels = Array.from({ length: 51 }, (_, i) => ({ name: `c${i}` }));
  assert.equal(spec.validateSpec(big).ok, false);
  const huge = { name: 'x', categories: Array.from({ length: 11 }, (_, i) => ({ name: `k${i}`, channels: Array.from({ length: 49 }, (_, j) => ({ name: `c${j}` })) })) };
  assert.ok(spec.validateSpec(huge).errors.some(e => /too many channels/.test(e.message)));
  assert.equal(spec.validateSpec({ name: 'empty' }).ok, false);
  assert.equal(spec.validateSpec('nope').ok, false);
});

test('builder: round trip through the bot decoder, exact structure', () => {
  const out = bridge.buildTemplateFromSpec(good(), { requestedBy: 'tester' });
  assert.match(out.code, /^AX-TPL\./);
  const back = template.decodeSnapshot(out.code);
  assert.equal(back.v, 2);
  assert.equal(back.roles.length, 3);
  assert.equal(back.channels.length, 10);
  assert.deepEqual(back.roles.map(r => r.n), ['Owner', 'Mod', 'Member']);
  assert.equal(back.roles[0].p, new PermissionsBitField(['Administrator']).bitfield.toString());
  assert.equal(back.roles[0].c, 0xe74c3c);
  // order: loose channel first, then each category followed by its children
  assert.deepEqual(back.channels.map(c => c.n), ['welcome', 'INFO', 'rules', 'news', 'VOICE', 'Lounge', 'Stage', 'ideas', 'STAFF', 'staff-chat']);
});

test('builder: parents, types, field mapping and overwrite inheritance', () => {
  const back = template.decodeSnapshot(bridge.buildTemplateFromSpec(good(), { persist: false }).code);
  const by = n => back.channels.find(c => c.n === n);
  const idx = n => back.channels.findIndex(c => c.n === n);
  assert.equal(by('welcome').p, -1);
  assert.equal(by('INFO').t, ChannelType.GuildCategory);
  assert.equal(by('rules').p, idx('INFO'));
  assert.equal(by('news').t, ChannelType.GuildAnnouncement);
  assert.equal(by('Lounge').t, ChannelType.GuildVoice);
  assert.equal(by('Stage').t, ChannelType.GuildStageVoice);
  assert.equal(by('ideas').t, ChannelType.GuildForum);
  assert.equal(by('Lounge').ul, 10);
  assert.equal(by('Lounge').b, 64000);
  assert.equal(by('rules').tp, 'Be kind');
  // category overwrites are copied onto children; the channel's own overwrite is added on top
  const view = new PermissionsBitField(['ViewChannel']).bitfield.toString();
  const send = new PermissionsBitField(['SendMessages']).bitfield.toString();
  assert.deepEqual(by('rules').o, [['e', view, send]]);
  assert.deepEqual(by('news').o, [['e', view, send], [1, send, '0']]);   // Mod is role index 1
  assert.deepEqual(by('staff-chat').o, [['e', '0', view], [1, view, '0']]);
});

test('builder: server settings block has every key the loader reads', () => {
  const snap = template.decodeSnapshot(bridge.buildTemplateFromSpec(good(), { persist: false }).code);
  for (const k of ['n', 'vl', 'dn', 'at', 'afk', 'sys', 'sf', 'rules', 'upd', 'ev']) assert.ok(k in snap.g, `g.${k} missing`);
  assert.equal(snap.g.vl, 2); assert.equal(snap.g.dn, 1); assert.equal(snap.g.afk, -1);
  for (const k of ['emojis', 'stickers', 'panels', 'sticky', 'embeds', 'wl']) assert.deepEqual(snap[k], []);
  const noSettings = good(); delete noSettings.settings;
  assert.equal(template.decodeSnapshot(bridge.buildTemplateFromSpec(noSettings, { persist: false }).code).g, undefined);
});

test('builder: short code resolves through the bot, invalid spec throws with paths', () => {
  const out = bridge.buildTemplateFromSpec(good(), { requestedBy: 'u1' });
  assert.match(out.shortCode, /^AX-[A-Z0-9]{8}$/);
  assert.equal(template.resolveSnapshot(out.shortCode).name, 'Squad Hub');
  const bad = good(); bad.roles[0].permissions = ['Nope'];
  assert.throws(() => bridge.buildTemplateFromSpec(bad), e => e.code === 'invalid_spec' && e.errors[0].path === 'roles[0].permissions[0]');
  assert.throws(() => bridge.buildTemplateFromSpec({ name: 'x'.repeat(500000) }), e => e.code === 'too_large');
});

test('builder: tampered code is rejected by the bot decoder', () => {
  const { code } = bridge.buildTemplateFromSpec(good(), { persist: false });
  const parts = code.split('.');
  assert.throws(() => template.decodeSnapshot(`${parts[0]}.${parts[1]}.${'A'.repeat(22)}`));
});

// ---------------- HTTP bridge ----------------
const SECRET = 'a-long-test-secret-of-24+chars!!';
async function withServer(fn) {
  const server = createBridgeServer({ secret: SECRET, build: (s, o) => bridge.buildTemplateFromSpec(s, { ...o, persist: false }) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise(r => server.close(r)); server.closeAllConnections?.(); }
}
const signed = (body, { ts = String(Date.now()), secret = SECRET, type = 'application/json' } = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return { method: 'POST', body: raw, headers: { 'Content-Type': type, 'X-Bridge-Timestamp': ts, 'X-Bridge-Signature': sign(secret, ts, raw) } };
};

test('http bridge: valid request works, security checks reject the rest', async () => {
  await withServer(async base => {
    const url = `${base}/bridge/template`;
    const ok = await fetch(url, signed({ spec: good(), requestedBy: 'x' }));
    assert.equal(ok.status, 200);
    const data = await ok.json();
    assert.equal(data.ok, true); assert.match(data.code, /^AX-TPL\./);

    assert.equal((await fetch(`${base}/bridge/health`)).status, 200);

    const wrong = await fetch(url, signed({ spec: good() }, { secret: 'not-the-right-secret-at-all-123' }));
    assert.equal(wrong.status, 401);

    const stale = await fetch(url, signed({ spec: good() }, { ts: String(Date.now() - 5 * 60 * 1000) }));
    assert.equal(stale.status, 401);

    const req = signed({ spec: good() });
    assert.equal((await fetch(url, req)).status, 200);
    assert.equal((await fetch(url, req)).status, 401);                     // replay of the identical request

    const nosig = await fetch(url, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    assert.equal(nosig.status, 401);

    assert.equal((await fetch(url, signed({ spec: good() }, { type: 'text/plain' }))).status, 422);

    const invalid = good(); invalid.roles[0].permissions = ['Nope'];
    const bad = await fetch(url, signed({ spec: invalid }));
    assert.equal(bad.status, 422);
    assert.equal((await bad.json()).errors[0].path, 'roles[0].permissions[0]');

    let tooBig;
    try { tooBig = (await fetch(url, signed('{"spec":"' + 'x'.repeat(600 * 1024) + '"}'))).status; } catch { tooBig = 'reset'; }
    assert.ok(tooBig === 413 || tooBig === 'reset', `unexpected ${tooBig}`);

    assert.equal((await fetch(`${base}/other`)).status, 404);
  });
});

test('client: http transport works, and a dead bot gives the clear offline error', async () => {
  const { buildTemplate } = require('../client');
  await withServer(async base => {
    process.env.BOT_BRIDGE_URL = base; process.env.BOT_BRIDGE_SECRET = SECRET;
    const out = await buildTemplate(good(), { requestedBy: 'web-user' });
    assert.match(out.code, /^AX-TPL\./); assert.equal(out.stats.roles, 3);
    await assert.rejects(buildTemplate({ name: 'x' }), e => e.code === 'invalid_spec' && e.errors.length > 0);
    process.env.BOT_BRIDGE_SECRET = 'wrong-secret-wrong-secret-1234';
    await assert.rejects(buildTemplate(good()), e => e.code === 'unauthorized');
  });
  process.env.BOT_BRIDGE_URL = 'http://127.0.0.1:9'; process.env.BOT_BRIDGE_SECRET = SECRET;   // nothing listens here
  await assert.rejects(buildTemplate(good()), e => e.code === 'unavailable' && /offline/.test(e.message));
  delete process.env.BOT_BRIDGE_URL; delete process.env.BOT_BRIDGE_SECRET;
});

// ---------------- AI generation (only the OpenRouter network edge is mocked) ----------------
test('generate: missing key gives setup instructions, never a fake template', async () => {
  const { generateTemplate, MissingKeyError } = require('../generate');
  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(generateTemplate({ prompt: 'a gaming server' }), e => e instanceof MissingKeyError && e.code === 'missing_key' && /openrouter\.ai\/keys/.test(e.howTo));
});

test('generate: repair loop feeds exact error paths back, then succeeds via the bot', async () => {
  const { generateTemplate } = require('../generate');
  process.env.OPENROUTER_API_KEY = 'test-key'; delete process.env.BOT_BRIDGE_URL;
  const realFetch = global.fetch;
  const seenBodies = [];
  const broken = good(); broken.roles[1].permissions = ['KickMembers', 'Fly'];
  const replies = ['```json\n' + JSON.stringify(broken) + '\n```', JSON.stringify(good())];
  global.fetch = async (url, init) => {
    assert.match(String(url), /openrouter\.ai\/api\/v1\/chat\/completions/);
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    seenBodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: replies.shift() } }], usage: { total_tokens: 10 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const statuses = [];
    const out = await generateTemplate({ prompt: 'squad hub', requestedBy: 'u9', onStatus: s => statuses.push(s) });
    assert.equal(out.attempts, 2);
    assert.match(out.code, /^AX-TPL\./);
    const second = seenBodies[1].messages.map(m => m.content).join('\n');
    assert.match(second, /roles\[1\]\.permissions\[1\]/);
    assert.ok(statuses.some(s => /bot/i.test(s)));
  } finally { global.fetch = realFetch; delete process.env.OPENROUTER_API_KEY; }
});

test('generate: gives up cleanly after repeated invalid output; maps API errors', async () => {
  const { generateTemplate } = require('../generate');
  process.env.OPENROUTER_API_KEY = 'test-key';
  const realFetch = global.fetch;
  try {
    global.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not json at all' } }] }), { status: 200 });
    await assert.rejects(generateTemplate({ prompt: 'x' }), e => e.code === 'invalid_spec' && /3 attempts/.test(e.message));
    global.fetch = async () => new Response(JSON.stringify({ error: { message: 'no credits' } }), { status: 402 });
    await assert.rejects(generateTemplate({ prompt: 'x' }), e => e.code === 'ai_credits');
    global.fetch = async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
    await assert.rejects(generateTemplate({ prompt: 'x' }), e => e.code === 'ai_auth');
  } finally { global.fetch = realFetch; delete process.env.OPENROUTER_API_KEY; }
});
