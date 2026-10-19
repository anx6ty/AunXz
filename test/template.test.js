'use strict';
process.env.TEMPLATE_WAIT_SCALE = '0'; // skip the loader's rate-limit pauses (production keeps them)
// Exercises the REAL template.js (snapshot save, v1/v2 upgrade, role/channel/embed restore) and the REAL embedsystem.js and
// database.js (on node:sqlite) against a FAKE Discord guild that mimics how Discord inserts roles/channels, reorders them and
// inherits category permissions. Nothing here talks to Discord: behaviour that needs a live server is listed in the final report.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const BUNDLE = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');

// ── database.js from the bundle, on node:sqlite ──
class BetterSqliteShim {
  constructor(file) { this.raw = new DatabaseSync(file); }
  pragma() {}
  exec(s) { return this.raw.exec(s); }
  prepare(q) { const st = this.raw.prepare(q); return { run: (...a) => ({ changes: Number(st.run(...a).changes) }), get: (...a) => st.get(...a), all: (...a) => st.all(...a) }; }
  transaction(fn) { return (...a) => { this.raw.exec('BEGIN'); try { const r = fn(...a); this.raw.exec('COMMIT'); return r; } catch (e) { this.raw.exec('ROLLBACK'); throw e; } }; }
  close() { this.raw.close(); }
}
function sliceModule(name, nextName) {
  const start = BUNDLE.indexOf(`__modules["${name}"]`);
  const bodyStart = BUNDLE.indexOf('\n', start) + 1;
  const bodyEnd = BUNDLE.lastIndexOf('\n};\n', BUNDLE.indexOf(`__modules["${nextName}"]`));
  return BUNDLE.slice(bodyStart, bodyEnd);
}
const DB_SRC = sliceModule('database.js', 'embedsystem.js');
function loadDb(file) {
  process.env.DATABASE_PATH = file;
  const mod = { exports: {} };
  const req = n => (n === 'better-sqlite3' ? BetterSqliteShim : require(n));
  new Function('module', 'exports', 'require', '__filename', '__dirname', DB_SRC)(mod, mod.exports, req, file, path.dirname(file));
  return mod.exports;
}
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aunxz-tpl-')), 'test.sqlite');

// ── discord.js stub: real enum values, recording builders so sent embeds/buttons can be inspected ──
const FLAGS = {
  Administrator: 1n << 3n, ManageChannels: 1n << 4n, ManageRoles: 1n << 28n, ViewChannel: 1n << 10n, SendMessages: 1n << 11n,
  EmbedLinks: 1n << 14n, ReadMessageHistory: 1n << 16n, SendMessagesInThreads: 1n << 38n, ManageGuild: 1n << 5n, ManageMessages: 1n << 13n
};
const ALL = Object.values(FLAGS).reduce((a, b) => a | b, 0n);
const ChannelType = { GuildText: 0, GuildVoice: 2, GuildCategory: 4, GuildAnnouncement: 5, GuildStageVoice: 13, GuildForum: 15, PublicThread: 11, PrivateThread: 12, AnnouncementThread: 10 };
class PermissionsBitField {
  constructor(b = 0n) { this.bitfield = typeof b === 'bigint' ? b : BigInt(b); }
  has(f) { return (this.bitfield & f) === f; }
}
class Rec {
  constructor(...a) {
    this.ctor = a; this.calls = [];
    const proxy = new Proxy(this, { get: (t, p) => (p in t || typeof p === 'symbol' || p === 'then') ? t[p] : (...args) => { t.calls.push({ m: p, a: args }); return proxy; } });
    return proxy;
  }
  arg(m) { return this.calls.find(c => c.m === m)?.a[0]; }
}
function chain() { return new Proxy(function () {}, { get: (_, p) => (p === 'then' ? undefined : chain()), apply: () => chain(), construct: () => chain() }); }
const discord = {
  PermissionFlagsBits: FLAGS, PermissionsBitField, ChannelType,
  ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 },
  ActionRowBuilder: class extends Rec { constructor() { const p = super(); p.parts = []; p.addComponents = (...c) => { p.parts.push(...c.flat()); return p; }; return p; } },
  ButtonBuilder: Rec, StringSelectMenuBuilder: Rec, EmbedBuilder: Rec, SlashCommandBuilder: chain(),
  ModalBuilder: Rec, TextInputBuilder: Rec, TextInputStyle: { Short: 1, Paragraph: 2 }
};
const ui = {
  THEME: 0x5865F2, emoji: () => '•',
  slim: t => ({ t }), slimOk: (t, d) => ({ kind: 'ok', t, d }), slimWarn: (t, d) => ({ kind: 'warn', t, d }), slimError: (t, d) => ({ kind: 'err', t, d }), slimInfo: (t, d) => ({ kind: 'info', t, d }),
  okEmbed: (t, d) => ({ kind: 'ok', t, d }), errorEmbed: (t, d) => ({ kind: 'err', t, d }), warnEmbed: (t, d) => ({ kind: 'warn', t, d }), infoEmbed: (t, d) => ({ kind: 'info', t, d })
};
function loadModules(dbm) {
  const load = (file, extra = {}) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const mod = { exports: {} };
    const cache = loadModules.cache;
    const req = n => n === 'discord.js' ? discord : n === './database' ? dbm : n === './ui' ? ui : n === './ownertools' ? { isOwner: () => false }
      : n === './embedsystem' ? cache.embed : n in extra ? extra[n] : require(n);
    new Function('module', 'exports', 'require', src)(mod, mod.exports, req);
    return mod.exports;
  };
  loadModules.cache = {};
  loadModules.cache.embed = load('embedsystem.js');
  return { embed: loadModules.cache.embed, tpl: load('template.js') };
}

// ── fake Discord guild ──
let SEQ = 1000;
const snow = () => String(100000000000000000n + BigInt(SEQ++));
function makeGuild({ id = snow(), name = 'Guild', botAdmin = true, roleInsert = 'bottom', bulkRoleMoves = true, singleRoleMoves = true, channelInsert = 'end', channelMoves = 'ok', inheritOnEmpty = false, denyChannelSend = new Set() } = {}) {
  const g = { id, name, premiumTier: 0, maximumBitrate: 96000, features: [], preferredLocale: 'en-US', sent: [] };
  const rolesMap = new Map();
  const chMap = new Map();
  const mkRole = (props) => {
    const r = { id: snow(), name: 'role', color: 0, hoist: false, mentionable: false, managed: false, position: 0, permissions: new PermissionsBitField(0n), unicodeEmoji: null, ...props };
    r.delete = async () => { rolesMap.delete(r.id); renumber(); };
    r.setPosition = async (pos) => { if (!singleRoleMoves) return r; moveTo(r, pos); return r; };
    r.guild = g;
    rolesMap.set(r.id, r);
    return r;
  };
  const sortedRoles = () => [...rolesMap.values()].sort((a, b) => a.position - b.position);
  function renumber() { sortedRoles().forEach((r, i) => { r.position = i; }); }
  function moveTo(role, pos) { const list = sortedRoles().filter(r => r !== role); list.splice(Math.max(0, Math.min(pos, list.length)), 0, role); list.forEach((r, i) => { r.position = i; }); }
  g.everyone = mkRole({ id, name: '@everyone', position: 0, permissions: new PermissionsBitField(0n) });
  const botRole = mkRole({ name: 'AunXz', managed: true, position: 1, permissions: new PermissionsBitField(botAdmin ? FLAGS.Administrator : (FLAGS.ManageChannels | FLAGS.ManageRoles | FLAGS.ViewChannel | FLAGS.SendMessages | FLAGS.EmbedLinks)) });
  g.roles = {
    cache: { get: id2 => rolesMap.get(id2), has: id2 => rolesMap.has(id2), values: () => rolesMap.values(), get size() { return rolesMap.size; } },
    everyone: g.everyone,
    fetch: async () => g.roles.cache,
    create: async opts => {
      const r = mkRole({ name: opts.name, color: opts.color || 0, hoist: !!opts.hoist, mentionable: !!opts.mentionable, permissions: new PermissionsBitField(opts.permissions?.bitfield ?? 0n), unicodeEmoji: opts.unicodeEmoji || null, position: 1 });
      if (roleInsert === 'bottom') { // Discord: new roles land directly above @everyone, pushing everything else up
        for (const o of rolesMap.values()) if (o !== r && o.position >= 1) o.position++;
        r.position = 1;
      } else { // hostile: new roles land just BELOW the bot's role, i.e. on top of earlier creations
        const others = sortedRoles().filter(x => x !== r);
        const botIdx = others.indexOf(botRole);
        others.splice(botIdx, 0, r);
        others.forEach((x, i) => { x.position = i; });
      }
      return r;
    },
    setPositions: async updates => {
      if (!bulkRoleMoves) return g;
      const moved = updates.map(u => ({ r: rolesMap.get(typeof u.role === 'string' ? u.role : u.role.id), p: u.position }));
      const rest = sortedRoles().filter(r => !moved.some(m => m.r === r));
      const out = [...rest];
      for (const m of moved.sort((a, b) => a.p - b.p)) out.splice(Math.min(m.p, out.length), 0, m.r);
      out.forEach((r, i) => { r.position = i; });
      return g;
    }
  };
  const me = { id: 'BOT', permissions: new PermissionsBitField(botAdmin ? FLAGS.Administrator : (FLAGS.ManageChannels | FLAGS.ManageRoles)), roles: { get highest() { return botRole; } } };
  g.members = { me, fetchMe: async () => me };
  g.botRole = botRole;
  g.emojis = { cache: new Map(), fetch: async () => { } };
  g.stickers = { cache: new Map(), fetch: async () => { } };
  g.client = { user: { id: 'BOT' } };
  g.iconURL = () => null; g.bannerURL = () => null; g.splashURL = () => null;
  g.verificationLevel = 0; g.explicitContentFilter = 0; g.defaultMessageNotifications = 0; g.afkTimeout = 300; g.systemChannelFlags = { bitfield: 0 };
  g.afkChannelId = null; g.systemChannelId = null; g.rulesChannelId = null; g.publicUpdatesChannelId = null; g.description = null;
  g.edit = async () => g;
  const mkChannel = (props) => {
    const ch = { id: snow(), name: 'c', type: 0, parentId: null, rawPosition: 0, topic: null, nsfw: false, rateLimitPerUser: 0, guild: g, ...props };
    const ows = new Map();
    ch.permissionOverwrites = {
      cache: ows,
      set: async (list) => { ows.clear(); for (const o of list) ows.set(o.id, { id: o.id, type: o.type ?? 0, allow: new PermissionsBitField(o.allow), deny: new PermissionsBitField(o.deny) }); }
    };
    ch.delete = async () => { chMap.delete(ch.id); };
    ch.isThread = () => false;
    ch.isTextBased = () => [0, 5].includes(ch.type);
    ch.sentMessages = [];
    ch.messages = { fetch: async mid => { const m = ch.sentMessages.find(x => x.id === mid); if (!m) throw Object.assign(new Error('Unknown Message'), { code: 10008 }); return m; } };
    ch.send = async payload => {
      if (denyChannelSend.has(ch.name)) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
      const msg = { id: snow(), payload, edit: async () => msg, channelId: ch.id };
      ch.sentMessages.push(msg);
      g.sent.push({ channelId: ch.id, payload, id: msg.id });
      return msg;
    };
    ch.permissionsFor = () => new PermissionsBitField(denyChannelSend.has(ch.name) ? FLAGS.ViewChannel : ALL);
    chMap.set(ch.id, ch);
    return ch;
  };
  const siblings = parentId => [...chMap.values()].filter(c => (c.parentId || null) === (parentId || null) && !(parentId == null && c.type !== 4 && false));
  g.channels = {
    cache: { get: id2 => chMap.get(id2), has: id2 => chMap.has(id2), values: () => chMap.values() },
    fetch: async id2 => (id2 ? chMap.get(id2) || null : g.channels.cache),
    create: async opts => {
      const parentId = opts.parent && opts.parent.id ? opts.parent.id : (opts.parent || null);
      const sib = siblings(parentId);
      let pos = sib.length ? Math.max(...sib.map(c => c.rawPosition)) + 1 : 0;
      if (channelInsert === 'top') { sib.forEach(c => { c.rawPosition++; }); pos = 0; }
      const ch = mkChannel({ name: opts.name, type: opts.type, parentId, rawPosition: pos, topic: opts.topic || null });
      const list = opts.permissionOverwrites || [];
      if (!list.length && inheritOnEmpty && parentId) { // Discord syncs a new child with its category when no overwrites are given
        for (const [k, v] of chMap.get(parentId).permissionOverwrites.cache) ch.permissionOverwrites.cache.set(k, v);
      } else await ch.permissionOverwrites.set(list);
      return ch;
    },
    setPositions: async updates => {
      if (channelMoves === 'never') return g;
      if (channelMoves === 'first-ignored') { channelMoves = 'ok'; return g; }
      for (const u of updates) {
        const ch = chMap.get(typeof u.channel === 'string' ? u.channel : u.channel.id);
        ch.rawPosition = u.position;
        if (u.parent !== undefined) ch.parentId = u.parent;
        assert.notEqual(u.lockPermissions, true, 'must never sync permissions from the category');
      }
      return g;
    }
  };
  g.addRole = (props) => mkRole(props);
  g.addChannel = (props) => mkChannel(props);
  g.listRoles = () => sortedRoles().filter(r => r.id !== id && !r.managed);
  g.layout = () => {
    const out = [];
    const skip = new Set(['template-progress', 'old-channel']);
    const bySort = (a, b) => a.rawPosition - b.rawPosition;
    const top = [...chMap.values()].filter(c => !c.parentId && !skip.has(c.name)).sort(bySort);
    for (const t of top) { out.push(t.name); if (t.type === 4) for (const c of [...chMap.values()].filter(x => x.parentId === t.id).sort(bySort)) out.push(`  ${c.name}`); }
    return out;
  };
  return g;
}
const user = { id: 'U1', tag: 'admin#0001' };
const EMBED_A = { v: 2, title: 'Server Rules', description: 'Be kind.', color: '#5865F2', fields: [{ name: 'One', value: 'No spam', inline: false }], buttons: [] };
const EMBED_B = { v: 2, title: 'Welcome', description: 'Hello!', color: '#57F287', fields: [], buttons: [] };

// Builds a populated SOURCE server + DB, as a real admin would have: roles with a deliberate hierarchy, categories with
// children, role-specific overwrites, two saved embeds (B has a reveal button to A) sent into two different channels.
function buildSource(dbm, mods) {
  const src = makeGuild({ name: 'Source' });
  const admin = src.addRole({ name: 'Admin', color: 0xFF0000, hoist: true, mentionable: false, position: 0, permissions: new PermissionsBitField(FLAGS.Administrator) });
  const mod = src.addRole({ name: 'Moderator', color: 0x00FF00, hoist: true, mentionable: true, permissions: new PermissionsBitField(FLAGS.ManageChannels | FLAGS.ViewChannel) });
  const member = src.addRole({ name: 'Member', color: 0x0000FF, permissions: new PermissionsBitField(FLAGS.ViewChannel | FLAGS.SendMessages) });
  const muted = src.addRole({ name: 'Muted', color: 0x808080, permissions: new PermissionsBitField(0n) });
  // hierarchy (top→bottom): [bot] Admin, Moderator, Member, Muted, @everyone
  [muted, member, mod, admin].forEach((r, i) => { r.position = 1 + i; });
  src.botRole.position = 5;
  src.addChannel({ name: 'welcome-lobby', type: 0, rawPosition: 0 });
  const info = src.addChannel({ name: 'INFO', type: 4, rawPosition: 1 });
  const rules = src.addChannel({ name: 'rules', type: 0, parentId: info.id, rawPosition: 0 });
  const news = src.addChannel({ name: 'news', type: 0, parentId: info.id, rawPosition: 1 });
  const chat = src.addChannel({ name: 'CHAT', type: 4, rawPosition: 2 });
  const general = src.addChannel({ name: 'general', type: 0, parentId: chat.id, rawPosition: 0 });
  src.addChannel({ name: 'voice-1', type: 2, parentId: chat.id, rawPosition: 1 });
  src.addChannel({ name: 'staff', type: 0, parentId: chat.id, rawPosition: 2 });
  const setOw = (ch, id, allow, deny) => ch.permissionOverwrites.cache.set(id, { id, type: 0, allow: new PermissionsBitField(allow), deny: new PermissionsBitField(deny) });
  setOw(chat, src.id, 0n, FLAGS.SendMessages);
  setOw([...src.channels.cache.values()].find(c => c.name === 'staff'), mod.id, FLAGS.ViewChannel, 0n);
  setOw([...src.channels.cache.values()].find(c => c.name === 'staff'), src.id, 0n, FLAGS.ViewChannel);
  setOw(rules, muted.id, 0n, FLAGS.SendMessages);
  const a = dbm.createSavedEmbed(src.id, 'Rules', EMBED_A, 'U1').embed;
  const b = dbm.createSavedEmbed(src.id, 'Welcome', { ...EMBED_B, buttons: [{ label: 'Read rules', targetId: a.id, targetName: 'Rules', emoji: '' }] }, 'U1').embed;
  dbm.recordEmbedPost(src.id, a.id, rules.id, '1');
  dbm.recordEmbedPost(src.id, b.id, general.id, '2');
  dbm.recordEmbedPost(src.id, a.id, news.id, '3');
  return { src, ids: { a: a.id, b: b.id }, channels: { rules, general, news } };
}
const roleNames = g => g.listRoles().sort((x, y) => y.position - x.position).map(r => r.name);

test('v3 snapshot: stable role/channel ids, explicit positions and ordering, embeds with their destination channels', async () => {
  const dbm = loadDb(tmp()); const { tpl } = loadModules(dbm);
  const { src, ids } = buildSource(dbm, null);
  const snap = await tpl.createSnapshot(src);
  assert.equal(snap.v, 3);
  assert.deepEqual(snap.roles.map(r => r.n), ['Admin', 'Moderator', 'Member', 'Muted'], 'hierarchy order, managed bot role excluded');
  assert.deepEqual(snap.roles.map(r => r.id), ['r0', 'r1', 'r2', 'r3']);
  assert.ok(snap.roles.every(r => Number.isInteger(r.pos)), 'original positions are stored');
  assert.equal(snap.skipped.managedRoles, 1);
  assert.ok(snap.channels.every(c => typeof c.id === 'string' && Number.isInteger(c.ord)));
  const rules = snap.channels.find(c => c.n === 'rules');
  assert.equal(rules.pid, snap.channels.find(c => c.n === 'INFO').id);
  assert.deepEqual(snap.embeds.map(e => e.id), [ids.a, ids.b], 'stable internal ids are saved');
  assert.deepEqual(snap.posts.map(p => [p.e === ids.a ? 'A' : 'B', snap.channels[p.ch].n]), [['A', 'rules'], ['B', 'general'], ['A', 'news']], 'each embed keeps its source channel, in send order');
  assert.ok(snap.posts.every(p => p.cid === snap.channels[p.ch].id));
  const round = tpl.decodeSnapshot(tpl.encodeSnapshot(snap));
  assert.deepEqual(round.posts.map(p => p.cid), snap.posts.map(p => p.cid));
});

async function roundTrip(opts = {}) {
  const dbm = loadDb(tmp()); const mods = loadModules(dbm);
  const { src, ids } = buildSource(dbm, mods);
  const snap = mods.tpl.decodeSnapshot(mods.tpl.encodeSnapshot(await mods.tpl.createSnapshot(src)));
  // the destination is a different server that already has leftover content which must be replaced
  const dst = makeGuild({ name: 'Target', ...opts });
  dst.addRole({ name: 'Old role', position: 1 });
  dst.botRole.position = 2;
  dst.addChannel({ name: 'old-channel', type: 0 });
  const result = await mods.tpl.runLoad(dst, snap, user);
  return { dbm, mods, src, dst, snap, result, ids };
}

test('restore: roles come back in the saved hierarchy with their properties, and the order is verified', async () => {
  const { dst, result } = await roundTrip();
  assert.deepEqual(roleNames(dst), ['Admin', 'Moderator', 'Member', 'Muted']);
  assert.ok(!dst.listRoles().some(r => r.name === 'Old role'), 'old unmanaged role was replaced');
  const byName = Object.fromEntries(dst.listRoles().map(r => [r.name, r]));
  assert.equal(byName.Admin.color, 0xFF0000); assert.equal(byName.Admin.hoist, true);
  assert.equal(byName.Moderator.mentionable, true);
  assert.equal(byName.Moderator.permissions.bitfield, FLAGS.ManageChannels | FLAGS.ViewChannel);
  assert.equal(result.rolesCreated, 4);
  assert.equal(result.roleOrder.verified, true);
  assert.equal(result.roleOrder.total, 4);
  assert.ok(dst.botRole.position > byName.Admin.position, 'new roles stay below the bot role');
});

test('restore: hierarchy is still correct when Discord inserts new roles at the top (reverse of the saved order)', async () => {
  const { dst, result } = await roundTrip({ roleInsert: 'top' });
  assert.deepEqual(roleNames(dst), ['Admin', 'Moderator', 'Member', 'Muted']);
  assert.equal(result.roleOrder.verified, true);
});

test('restore: falls back to role-by-role moves when the bulk reorder is silently ignored', async () => {
  const { dst, result } = await roundTrip({ roleInsert: 'top', bulkRoleMoves: false });
  assert.deepEqual(roleNames(dst), ['Admin', 'Moderator', 'Member', 'Muted']);
  assert.equal(result.roleOrder.verified, true);
});

test('restore: when roles genuinely cannot be reordered the loader says so instead of claiming success', async () => {
  const { dst, result } = await roundTrip({ roleInsert: 'top', bulkRoleMoves: false, singleRoleMoves: false });
  assert.notDeepEqual(roleNames(dst), ['Admin', 'Moderator', 'Member', 'Muted']);
  assert.equal(result.roleOrder.verified, false);
  assert.ok(result.roleOrder.misplaced.length > 0);
  assert.ok(result.failed.some(f => /role order/.test(f)));
  const done = require('node:util').inspect(loadModules.cache.tplDone || '', { depth: 0 });
  assert.ok(done !== undefined);
});

test('restore: categories, children and uncategorized channels keep their saved order and parents', async () => {
  const { dst, result } = await roundTrip();
  assert.deepEqual(dst.layout(), ['welcome-lobby', 'INFO', '  rules', '  news', 'CHAT', '  general', '  voice-1', '  staff']);
  assert.equal(result.channelsCreated, 8);
  assert.equal(result.channelOrder.verified, true);
});

test('restore: channel order is enforced when Discord puts new channels at the top, and retried when the first reorder is ignored', async () => {
  let r = await roundTrip({ channelInsert: 'top' });
  assert.deepEqual(r.dst.layout(), ['welcome-lobby', 'INFO', '  rules', '  news', 'CHAT', '  general', '  voice-1', '  staff']);
  assert.equal(r.result.channelOrder.verified, true);
  r = await roundTrip({ channelInsert: 'top', channelMoves: 'first-ignored' });
  assert.deepEqual(r.dst.layout(), ['welcome-lobby', 'INFO', '  rules', '  news', 'CHAT', '  general', '  voice-1', '  staff']);
  assert.equal(r.result.channelOrder.verified, true);
});

test('restore: unverifiable channel order is reported, not hidden', async () => {
  const { result } = await roundTrip({ channelInsert: 'top', channelMoves: 'never' });
  assert.equal(result.channelOrder.verified, false);
  assert.ok(result.failed.some(f => /channel order/.test(f)));
});

test('restore: role overwrites follow the NEW role ids; category overwrites are not copied onto children', async () => {
  const { dst } = await roundTrip({ inheritOnEmpty: true });
  const ch = n => [...dst.channels.cache.values()].find(c => c.name === n);
  const roleId = n => dst.listRoles().find(r => r.name === n).id;
  const staff = ch('staff');
  const own = [...staff.permissionOverwrites.cache.values()].map(o => [o.id, o.allow.bitfield, o.deny.bitfield]).sort();
  assert.deepEqual(own, [[roleId('Moderator'), FLAGS.ViewChannel, 0n], [dst.id, 0n, FLAGS.ViewChannel]].sort());
  assert.equal(ch('CHAT').permissionOverwrites.cache.get(dst.id).deny.bitfield, FLAGS.SendMessages);
  // 'general' had NO overwrites of its own: it must not have inherited the category's @everyone deny
  assert.equal(ch('general').permissionOverwrites.cache.size, 0);
  assert.equal(ch('rules').permissionOverwrites.cache.get(roleId('Muted')).deny.bitfield, FLAGS.SendMessages);
});

test('restore: saved embeds keep their ids, reveal buttons are remapped, and each embed lands in the RESTORED channel it came from', async () => {
  const { dbm, dst, result, ids } = await roundTrip();
  const rows = dbm.listSavedEmbeds(dst.id);
  assert.deepEqual(rows.map(r => r.name).sort(), ['Rules', 'Welcome']);
  const a = dbm.findSavedEmbed(dst.id, 'rules'), b = dbm.findSavedEmbed(dst.id, 'welcome');
  assert.equal(b.data.buttons[0].targetId, a.id, 'button points at the restored embed');
  assert.notEqual(a.id, ids.a, 'the source server still owns the original id, so a new one was issued');
  const chId = n => [...dst.channels.cache.values()].find(c => c.name === n).id;
  const where = dst.sent.map(s => [s.payload.embeds[0].arg('setTitle'), s.channelId]);
  assert.deepEqual(where, [['Server Rules', chId('rules')], ['Welcome', chId('general')], ['Server Rules', chId('news')]], 'order and destinations preserved');
  assert.ok(dst.sent.every(s => s.payload.rawEmbeds === true), 'sent as real embeds, not flattened');
  assert.equal(dst.sent[1].payload.components[0].parts[0].arg('setCustomId'), `embreveal:${a.id}`, 'reveal button uses the restored id');
  assert.equal(result.embedsPosted, 3); assert.equal(result.embedsFailed, 0); assert.equal(result.embedsSkipped, 0);
  assert.equal(dbm.listEmbedPosts(dst.id).length, 3, 'new posts are recorded so the next template save keeps them');
  assert.ok(!dst.sent.some(s => s.channelId === [...dst.channels.cache.values()].find(c => c.name === 'template-progress')?.id && s.payload.embeds?.[0]?.arg?.('setTitle')), 'nothing is sent to the channel the command ran in');
});

test('restore: original embed ids are kept when this server does not already hold them', async () => {
  const dbm = loadDb(tmp()); const mods = loadModules(dbm);
  const { src, ids } = buildSource(dbm, mods);
  const snap = mods.tpl.decodeSnapshot(mods.tpl.encodeSnapshot(await mods.tpl.createSnapshot(src)));
  dbm.deleteSavedEmbedById(ids.a); dbm.deleteSavedEmbedById(ids.b); // as if the template were loaded on a fresh bot/database
  const dst = makeGuild();
  await mods.tpl.runLoad(dst, snap, user);
  assert.equal(dbm.findSavedEmbed(dst.id, 'rules').id, ids.a);
});

test('restore: a missing/denied destination is reported per embed; the others are still posted', async () => {
  const { result, dst } = await roundTrip({ denyChannelSend: new Set(['general']) });
  assert.equal(result.embedsPosted, 2); assert.equal(result.embedsFailed, 1);
  assert.ok(result.failed.some(f => /embed "Welcome"/.test(f) && /general/.test(f)));
  assert.equal(dst.sent.length, 2);
});

test('retry: re-running the embed step of the same run does not post duplicates', async () => {
  const dbm = loadDb(tmp()); const mods = loadModules(dbm);
  const { src } = buildSource(dbm, mods);
  const snap = mods.tpl.decodeSnapshot(mods.tpl.encodeSnapshot(await mods.tpl.createSnapshot(src)));
  const dst = makeGuild();
  await mods.tpl.runLoad(dst, snap, user);
  const before = dst.sent.length;
  // simulate a retry of just the posting step with the same restored channels/embeds
  const chIds = snap.channels.map(c => [...dst.channels.cache.values()].find(x => x.name === c.n)?.id || null);
  const idMap = new Map(snap.embeds.map(e => [e.id, dbm.findSavedEmbed(dst.id, e.name).id]));
  const report = { posted: 0, failed: 0, skipped: 0 };
  const prog = { c: { embeds: { done: 0, total: 3 } } };
  const runKey = require('node:crypto').createHash('sha256').update(`${snap.id}|${snap.at}|${dst.id}`).digest('hex').slice(0, 24);
  await mods.tpl._internal.postSavedEmbeds(dst, dst.members.me, snap, chIds, idMap, runKey, report, prog, [], async () => { });
  assert.equal(dst.sent.length, before, 'nothing was sent a second time');
  assert.equal(report.posted, 3, 'already-restored embeds count as restored');
});

test('legacy v2 templates (no ids/ord/posts) still load: array order is used and nothing is dropped', async () => {
  const dbm = loadDb(tmp()); const mods = loadModules(dbm);
  const legacy = {
    v: 2, id: 'web', name: 'Old', at: 1,
    roles: [{ n: 'Boss', c: 1, h: 1, m: 0, p: '8' }, { n: 'Crew', c: 2, h: 0, m: 1, p: '1024' }],
    channels: [
      { n: 'lobby', t: 0, p: -1, o: [['e', '0', '1024']] },
      { n: 'HQ', t: 4, p: -1, o: [] },
      { n: 'ops', t: 0, p: 1, o: [[0, '1024', '0']] },
      { n: 'general', t: 0, p: 1, o: [] }
    ],
    emojis: [], stickers: [], panels: [], sticky: [], wl: [],
    embeds: [{ name: 'Old Embed', data: { title: 'Hello', description: 'World' } }]
  };
  const dst = makeGuild({ roleInsert: 'top', channelInsert: 'top' });
  const result = await mods.tpl.runLoad(dst, mods.tpl.decodeSnapshot(mods.tpl.encodeSnapshot(legacy)), user);
  assert.deepEqual(roleNames(dst), ['Boss', 'Crew']);
  assert.deepEqual(dst.layout(), ['lobby', 'HQ', '  ops', '  general']);
  assert.equal(result.roleOrder.verified, true); assert.equal(result.channelOrder.verified, true);
  assert.ok(dbm.findSavedEmbed(dst.id, 'old embed'), 'legacy embed is stored');
  assert.equal(dst.sent.filter(s => s.payload.embeds).length, 0, 'no channel was recorded for it, so none is posted');
  assert.ok(result.notes.some(n => /no recorded channel/.test(n)), 'and the loader says why');
  const ops = [...dst.channels.cache.values()].find(c => c.name === 'ops');
  assert.equal([...ops.permissionOverwrites.cache.values()][0].id, dst.listRoles().find(r => r.name === 'Boss').id, 'index-keyed overwrites still resolve');
});

test('normalizeSnapshot is idempotent, repairs duplicate ids and dangling references', () => {
  const dbm = loadDb(tmp()); const { tpl } = loadModules(dbm);
  const snap = tpl.normalizeSnapshot({
    v: 3, roles: [{ id: 'x', n: 'a', p: '0' }, { id: 'x', n: 'b', p: '0' }],
    channels: [{ id: 'k', n: 'one', t: 0, p: 9, o: [] }, { id: 'k', n: 'two', t: 4, p: -1, o: [] }, { n: 'three', t: 0, pid: 'nope', p: -1, o: [] }],
    embeds: [{ id: 'e1', name: 'E', data: { title: 't' } }], posts: [{ e: 'e1', cid: 'gone', ch: 99 }, { e: 'missing', ch: 0 }, { e: 'e1', ch: 0, o: 2 }]
  });
  assert.equal(new Set(snap.roles.map(r => r.id)).size, 2);
  assert.equal(new Set(snap.channels.map(c => c.id)).size, 3);
  assert.ok(snap.channels.every(c => c.p === -1));
  assert.equal(snap.posts.length, 1);
  assert.equal(tpl.normalizeSnapshot(snap), snap);
});

test('database migration is additive and idempotent; old saved embeds survive and can be deleted together with their posts', () => {
  const file = tmp();
  let dbm = loadDb(file);
  const a = dbm.createSavedEmbed('g1', 'Keep', { title: 'x' }, 'u').embed;
  dbm.recordEmbedPost('g1', a.id, 'c1', 'm1');
  dbm.recordEmbedPost('g1', a.id, 'c2', 'm2');
  dbm.putRestoreLog('run', 'item', 'g1', 'c1', 'm1');
  assert.equal(dbm.getRestoreLog('run', 'item').messageId, 'm1');
  dbm = loadDb(file); // second start-up on the same file: migrations must not fail or wipe anything
  assert.equal(dbm.findSavedEmbed('g1', 'keep').id, a.id);
  assert.equal(dbm.listEmbedPosts('g1').length, 2);
  assert.equal(dbm.deleteSavedEmbedById(a.id), true);
  assert.equal(dbm.listEmbedPosts('g1').length, 0, 'posts of a deleted embed are removed');
  const forced = dbm.createSavedEmbed('g1', 'Forced', { title: 'y' }, null, 'abcdef12-forced-id');
  assert.equal(forced.embed.id, 'abcdef12-forced-id');
  const clash = dbm.createSavedEmbed('g2', 'Clash', { title: 'z' }, null, 'abcdef12-forced-id');
  assert.notEqual(clash.embed.id, 'abcdef12-forced-id', 'an id owned by another record is never reused');
});

test('/embed send records the destination channel and /embed view shows a saved embed as a real embed', async () => {
  const dbm = loadDb(tmp()); const { embed } = loadModules(dbm);
  const row = dbm.createSavedEmbed('g1', 'Rules', EMBED_A, 'm1').embed;
  const sent = [];
  const channel = { id: 'c9', guildId: 'g1', type: 0, isThread: () => false, send: async p => { sent.push(p); return { id: 'msg9', url: 'u' }; }, permissionsFor: () => ({ has: () => true }) };
  const calls = [];
  const i = {
    guildId: 'g1', guild: { id: 'g1', channels: { cache: new Map([['c9', channel]]), fetch: async () => channel }, members: { me: {} }, ownerId: 'x' }, channelId: 'c9', user: { id: 'm1' }, member: {},
    memberPermissions: { has: f => f === FLAGS.ManageMessages || f === FLAGS.ManageGuild },
    options: { getSubcommand: () => 'send', getString: () => 'rules', getChannel: () => null },
    deferred: false, replied: false, deferReply: async function () { this.deferred = true; }, editReply: async p => { calls.push(p); }, reply: async p => { calls.push(p); }
  };
  await embed.command.execute(i);
  assert.equal(sent.length, 1); assert.equal(sent[0].rawEmbeds, true);
  assert.deepEqual(dbm.listEmbedPosts('g1').map(p => [p.embedId, p.channelId, p.messageId]), [[row.id, 'c9', 'msg9']]);
  const v = { ...i, deferred: false, options: { getSubcommand: () => 'view', getString: () => 'RULES' } };
  await embed.command.execute(v);
  const shown = calls.at(-1);
  assert.equal(shown.ephemeral, true); assert.equal(shown.rawEmbeds, true);
  assert.equal(shown.embeds[0].arg('setTitle'), 'Server Rules');
});

test('bundle and standalone sources are identical', () => {
  for (const name of ['embedsystem.js', 'template.js']) {
    const start = BUNDLE.indexOf(`__modules["${name}"]`);
    const bodyStart = BUNDLE.indexOf('\n', start) + 1;
    const ends = [BUNDLE.indexOf('\n};\n__modules["', bodyStart), BUNDLE.indexOf('\n};\n\nconst __cache', bodyStart)].filter(x => x >= 0);
    const bodyEnd = Math.min(...ends);
    assert.equal(fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/\n$/, ''), BUNDLE.slice(bodyStart, bodyEnd), `${name} differs from the bundle - run node tools/sync-bundle.js`);
  }
});
