'use strict';
// Loads the bundled AunXz (formerly NEXORA) module with stubbed discord.js/ui and a node:sqlite-backed shim,
// so persistence and permission logic is exercised against a real SQLite engine without a Discord connection.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function chain() { return new Proxy(function () {}, { get: (_, p) => (p === 'then' ? undefined : chain()), apply: () => chain(), construct: () => chain() }); }
const FLAGS = { Administrator: 8n, ManageGuild: 32n, ViewChannel: 1024n, SendMessages: 2048n };
class PermissionsBitField { constructor(b) { this.bits = BigInt(b); } has(f) { return (this.bits & f) === f; } }
const discord = new Proxy({}, { get: (_, n) => n === 'PermissionFlagsBits' ? new Proxy(FLAGS, { get: (t, k) => t[k] ?? 1n << 40n }) : n === 'PermissionsBitField' ? PermissionsBitField : chain() });
const ui = new Proxy({}, { get: () => (...a) => ({ ui: a }) });

function makeShim(raw) {
  return {
    exec: s => raw.exec(s), pragma() {},
    prepare(q) { const st = raw.prepare(q); return { run: (...a) => { const r = st.run(...a); return { changes: Number(r.changes) }; }, get: (...a) => st.get(...a), all: (...a) => st.all(...a) }; },
    transaction(fn) { return (...a) => { raw.exec('BEGIN'); try { const r = fn(...a); raw.exec('COMMIT'); return r; } catch (e) { raw.exec('ROLLBACK'); throw e; } }; },
  };
}
function load() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const start = src.indexOf('__modules["nexora.js"]');
  const bodyStart = src.indexOf('\n', start) + 1;
  const bodyEnd = src.lastIndexOf('\n};\n', src.indexOf('__modules["logging.js"]'));
  const body = src.slice(bodyStart, bodyEnd);
  const raw = new DatabaseSync(':memory:'); const shim = makeShim(raw);
  const req = n => n === 'discord.js' ? discord : n === './database' ? { db: shim } : n === './ui' ? ui : require(n);
  const module = { exports: {} };
  new Function('module', 'exports', 'require', body)(module, module.exports, req);
  return { m: module.exports, raw, sql: shim };
}
function seedChar(raw, g, u, coins = 100) {
  raw.exec(`INSERT INTO nexora_characters(guildId,userId,name,classId,level,xp,hp,maxHp,attack,defense,coins,regionId,createdAt,updatedAt) VALUES('${g}','${u}','Hero','warrior',1,0,50,100,10,5,${coins},'sunmeadow',1,1)`);
}
const bat = (o = {}) => ({ guildId: 'g1', userId: 'u1', battleId: 'b1', won: true, coins: 40, xp: 25, playerHp: 30, maxHp: 100, ...o });

test('permission helper: admin, manage server, owner, raw payload, denial, missing context', () => {
  const { m } = load(); const { checkConfigAccess } = m._internals;
  const mk = (bits, extra = {}) => ({ guildId: 'g', user: { id: 'u' }, guild: { ownerId: 'o' }, memberPermissions: new PermissionsBitField(bits), ...extra });
  assert.equal(checkConfigAccess(mk(8n)).ok, true);
  assert.equal(checkConfigAccess(mk(32n)).ok, true);
  assert.equal(checkConfigAccess(mk(2048n)).ok, false);
  assert.equal(checkConfigAccess(mk(0n, { guild: { ownerId: 'u' } })).ok, true);
  assert.equal(checkConfigAccess(mk(0n, { guild: null, memberPermissions: null, member: { permissions: '8' } })).ok, true, 'uncached guild + raw string perms');
  assert.equal(checkConfigAccess({ guildId: null, user: { id: 'u' } }).ok, false);
  assert.equal(checkConfigAccess({ guildId: 'g', user: { id: 'u' } }).reason, 'no_permission_data');
});

test('channel gate: disabled allows all, enabled allows only listed', () => {
  const { m } = load(); const { channelGate } = m._internals;
  assert.equal(channelGate({ channelRestriction: { enabled: false, allowedChannelIds: ['1'] } }, '9').allowed, true);
  assert.equal(channelGate({ channelRestriction: { enabled: true, allowedChannelIds: ['1'] } }, '1').allowed, true);
  assert.equal(channelGate({ channelRestriction: { enabled: true, allowedChannelIds: ['1'] } }, '9').allowed, false);
  assert.ok(m._internals.GAMEPLAY_SUBS.has('fight') && !m._internals.GAMEPLAY_SUBS.has('setup'));
});

test('legacy NEXORA game name is migrated and defaults carry channelRestriction', () => {
  const { m, raw } = load();
  raw.exec(`INSERT INTO nexora_settings(guildId,data,updatedAt) VALUES('g1','{"gameName":"NEXORA"}',1)`);
  const s = m.getSettings('g1');
  assert.equal(s.gameName, 'AunXz'); assert.equal(s.channelRestriction.enabled, false);
});

test('successful battle commits ledger, coins and xp together', () => {
  const { m, raw } = load(); seedChar(raw, 'g1', 'u1'); const s = m.getSettings('g1');
  m._internals.persistBattle({ ...bat(), settings: s });
  const c = raw.prepare("SELECT coins,hp,xp FROM nexora_characters WHERE guildId='g1'").get();
  assert.equal(c.coins, 140); assert.equal(c.xp, 25); assert.equal(c.hp, 30);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM nexora_ledger').get().n, 1);
});

test('missing player record fails cleanly with NO_CHARACTER and writes nothing', () => {
  const { m, raw } = load(); const s = m.getSettings('g1');
  assert.throws(() => m._internals.persistBattle({ ...bat(), settings: s }), e => e.battleCode === 'NO_CHARACTER');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM nexora_ledger').get().n, 0);
});

test('duplicate resolution / double reward claim is rejected', () => {
  const { m, raw } = load(); seedChar(raw, 'g1', 'u1'); const s = m.getSettings('g1');
  m._internals.persistBattle({ ...bat(), settings: s });
  assert.throws(() => m._internals.persistBattle({ ...bat(), settings: s }), e => e.battleCode === 'DUPLICATE');
  assert.equal(raw.prepare("SELECT coins FROM nexora_characters").get().coins, 140, 'reward not paid twice');
});

test('concurrent resolutions of the same battle id: exactly one wins', async () => {
  const { m, raw } = load(); seedChar(raw, 'g1', 'u1'); const s = m.getSettings('g1');
  const results = await Promise.allSettled([1, 2, 3, 4].map(async () => m._internals.persistBattle({ ...bat(), settings: s })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(raw.prepare('SELECT coins FROM nexora_characters').get().coins, 140);
});

test('rollback after partial failure (XP step throws after ledger+coins were written)', () => {
  const { m, raw } = load(); seedChar(raw, 'g1', 'u1'); 
  assert.throws(() => m._internals.persistBattle({ ...bat(), settings: undefined }));
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM nexora_ledger').get().n, 0);
  assert.equal(raw.prepare('SELECT coins FROM nexora_characters').get().coins, 100);
});

test('database error during loot/reward update rolls everything back', () => {
  const { m, raw } = load(); seedChar(raw, 'g1', 'u1'); const s = m.getSettings('g1');
  raw.exec(`INSERT OR IGNORE INTO nexora_items(guildId,itemId,name,stackLimit) VALUES('g1','iron_ore','Iron',99),('g1','wood','Wood',99)`);
  raw.exec(`CREATE TRIGGER boom BEFORE INSERT ON nexora_inventory BEGIN SELECT RAISE(ABORT,'disk full'); END`);
  assert.throws(() => m._internals.persistBattle({ ...bat(), settings: s }), /disk full/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM nexora_ledger').get().n, 0);
  const c = raw.prepare('SELECT coins,xp,hp FROM nexora_characters').get();
  assert.deepEqual({ ...c }, { coins: 100, xp: 0, hp: 50 });
});

test('a lost battle pays no coins but still records xp atomically', () => {
  const { m, raw } = load(); seedChar(raw, 'g1', 'u1'); const s = m.getSettings('g1');
  m._internals.persistBattle({ ...bat({ won: false, coins: 0, xp: 3, playerHp: 0 }), settings: s });
  const c = raw.prepare('SELECT coins,xp,hp FROM nexora_characters').get();
  assert.equal(c.coins, 100); assert.equal(c.xp, 3); assert.equal(c.hp, 50);
});
