
'use strict';
// Exercises the REAL bundled database.js (migration + saved-embed API, on a real SQLite engine via node:sqlite)
// and the REAL embedsystem.js (command/interaction logic with fake Discord interaction objects).
// Discord itself is not contacted: anything that needs a live server is listed in the final report, not asserted here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const BUNDLE = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');

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
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aunxz-')), 'test.sqlite');

// ── embedsystem.js with a stubbed discord.js (builders are inert; permission/channel enums are real values) ──
function chain() { return new Proxy(function () {}, { get: (_, p) => (p === 'then' ? undefined : chain()), apply: () => chain(), construct: () => chain() }); }
const FLAGS = { Administrator: 8n, ManageGuild: 32n, ManageMessages: 8192n, ViewChannel: 1024n, SendMessages: 2048n, SendMessagesInThreads: 1n << 38n, EmbedLinks: 16384n };
const ChannelType = { GuildText: 0, GuildAnnouncement: 5, PublicThread: 11, PrivateThread: 12, AnnouncementThread: 10, GuildVoice: 2 };
const discord = new Proxy({}, { get: (_, n) => n === 'PermissionFlagsBits' ? FLAGS : n === 'ChannelType' ? ChannelType : n === 'ButtonStyle' ? { Link: 5, Primary: 1, Secondary: 2, Success: 3, Danger: 4 } : n === 'TextInputStyle' ? { Short: 1, Paragraph: 2 } : chain() });
const uiStub = { THEME: 0x5865F2, emoji: () => '•', okEmbed: (t, d) => ({ kind: 'ok', t, d }), errorEmbed: (t, d) => ({ kind: 'err', t, d }), warnEmbed: (t, d) => ({ kind: 'warn', t, d }), infoEmbed: (t, d) => ({ kind: 'info', t, d }) };
function loadEmbedSystem(dbm) {
  const src = fs.readFileSync(path.join(ROOT, 'embedsystem.js'), 'utf8');
  const mod = { exports: {} };
  const req = n => n === 'discord.js' ? discord : n === './database' ? dbm : n === './ui' ? uiStub : n === './ownertools' ? { isOwner: id => id === 'BOTOWNER' } : require(n);
  new Function('module', 'exports', 'require', src)(mod, mod.exports, req);
  return mod.exports;
}
const perms = (...names) => ({ has: bit => names.some(n => FLAGS[n] === bit) });
function textChannel(id, { type = ChannelType.GuildText, allow = ['ViewChannel', 'SendMessages', 'EmbedLinks'], sendImpl } = {}) {
  const ch = { id, guildId: 'g1', type, sent: [], isThread: () => false, send: async p => { if (sendImpl) return sendImpl(p); ch.sent.push(p); return { url: `https://discord.com/channels/g1/${id}/1` }; }, permissionsFor: who => (who && who.id === 'bot' ? perms(...allow) : (who?.userAllow ? perms(...who.userAllow) : perms(...allow))) };
  return ch;
}
function fake({ user = 'u1', userPerms = ['ManageMessages'], customId = null, sub = null, strings = {}, channelOpt = null, channelId = 'c1', channels = [], modalFields = null, values = null } = {}) {
  const calls = [];
  const map = new Map(channels.map(c => [c.id, c]));
  const i = {
    calls, user: { id: user }, guildId: 'g1', channelId, customId,
    guild: { id: 'g1', ownerId: 'serverowner', channels: { cache: map, fetch: async id => map.get(id) || null }, members: { me: { id: 'bot' }, fetchMe: async () => ({ id: 'bot' }) } },
    member: { id: user, userAllow: null }, memberPermissions: perms(...userPerms), deferred: false, replied: false,
    reply: async p => { calls.push(['reply', p]); i.replied = true; }, followUp: async p => calls.push(['followUp', p]), update: async p => calls.push(['update', p]),
    editReply: async p => calls.push(['editReply', p]), deferReply: async () => { i.deferred = true; calls.push(['defer']); }, showModal: async m => calls.push(['modal', m]),
    isButton: () => !!customId && !modalFields && !values, isModalSubmit: () => !!modalFields, isFromMessage: () => true, isStringSelectMenu: () => !!values, values,
    fields: { getTextInputValue: k => (modalFields && modalFields[k]) || '' },
    options: { getSubcommand: () => sub, getString: k => strings[k] ?? null, getChannel: () => channelOpt, getFocused: () => '' }
  };
  return i;
}
const last = i => i.calls[i.calls.length - 1];
const titleOf = c => c[1].embeds?.[0]?.t;
const GOOD = { title: 'Rules', description: 'Be kind.' };
function fresh() {
  const dbm = loadDb(tmp());
  const es = loadEmbedSystem(dbm);
  es._internals.sessions.clear();
  return { dbm, es };
}
async function press(es, sid, action, opts = {}) {
  const i = fake({ ...opts, customId: `emb:${sid}:${action}` });
  const handled = await es.handleInteraction(i);
  return { i, handled };
}

// ───────────────────────── migration & persistence ─────────────────────────
test('legacy saved_embeds rows are migrated in place (ids, name keys, no data loss) and migration is idempotent', () => {
  const file = tmp();
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE saved_embeds (guildId TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY (guildId, name))');
  const ins = raw.prepare('INSERT INTO saved_embeds VALUES (?,?,?,?,?)');
  ins.run('g1', 'Rules', JSON.stringify({ title: 'old' }), 1, 1);
  ins.run('g1', 'rules  ', JSON.stringify({ title: 'collides' }), 2, 2);
  ins.run('g2', 'Rules', JSON.stringify({ title: 'other guild' }), 3, 3);
  raw.close();
  const dbm = loadDb(file);
  const rows = dbm.listSavedEmbeds('g1');
  assert.equal(rows.length, 2, 'no rows lost');
  assert.ok(rows.every(r => r.id && r.nameKey), 'ids + keys backfilled');
  assert.equal(new Set(rows.map(r => r.nameKey)).size, 2, 'colliding legacy names stay addressable');
  assert.equal(dbm.findSavedEmbed('g2', 'RULES').data.title, 'other guild');
  assert.equal(dbm.findSavedEmbed('g1', 'rules').ownerId, null, 'legacy rows have no owner');
  const ids = rows.map(r => r.id).sort();
  const again = loadDb(file); // simulated restart
  assert.deepEqual(again.listSavedEmbeds('g1').map(r => r.id).sort(), ids, 'second init keeps ids');
});
test('name lookup is case-insensitive, whitespace-normalised and supports spaces; duplicates rejected', () => {
  const { dbm } = fresh();
  const r = dbm.createSavedEmbed('g1', '  Server   Rules ', GOOD, 'u1');
  assert.ok(r.ok);
  assert.equal(r.embed.name, 'Server Rules');
  for (const q of ['server rules', 'SERVER   RULES', ' Server Rules  ']) assert.equal(dbm.findSavedEmbed('g1', q).id, r.embed.id);
  assert.equal(dbm.findSavedEmbed('g1', 'nope'), null);
  assert.equal(dbm.createSavedEmbed('g1', 'SERVER RULES', GOOD, 'u2').reason, 'duplicate');
  assert.ok(dbm.createSavedEmbed('g2', 'Server Rules', GOOD, 'u2').ok, 'same name allowed in another server');
});
test('embeds survive a restart and updates keep the same stable id', () => {
  const file = tmp();
  const a = loadDb(file);
  const c = a.createSavedEmbed('g1', 'Welcome', GOOD, 'u1').embed;
  const u = a.updateSavedEmbed(c.id, c.updatedAt, { ...GOOD, title: 'Changed' });
  assert.ok(u.ok);
  const b = loadDb(file);
  const row = b.findSavedEmbed('g1', 'welcome');
  assert.equal(row.id, c.id);
  assert.equal(row.data.title, 'Changed');
  assert.equal(b.listSavedEmbeds('g1').length, 1, 'no duplicate record');
});
test('stale update is rejected (concurrent edit) and missing record reported', () => {
  const { dbm } = fresh();
  const c = dbm.createSavedEmbed('g1', 'A', GOOD, 'u1').embed;
  assert.ok(dbm.updateSavedEmbed(c.id, c.updatedAt, GOOD).ok);
  assert.equal(dbm.updateSavedEmbed(c.id, c.updatedAt, GOOD).reason, 'conflict');
  assert.ok(dbm.deleteSavedEmbedById(c.id));
  assert.equal(dbm.updateSavedEmbed(c.id, c.updatedAt, GOOD).reason, 'missing');
  assert.equal(dbm.deleteSavedEmbedById(c.id), false);
});
test('legacy name-based API (template save/restore) still works', () => {
  const { dbm } = fresh();
  dbm.saveEmbed('g1', 'Tpl', { title: 'x' });
  dbm.saveEmbed('g1', 'tpl', { title: 'y' });
  assert.equal(dbm.listEmbeds('g1').length, 1);
  assert.equal(dbm.getEmbed('g1', 'TPL').data.title, 'y');
  assert.ok(dbm.deleteEmbed('g1', 'tpl'));
  assert.equal(dbm.getEmbed('g1', 'tpl'), null);
});

// ───────────────────────── validation ─────────────────────────
test('Discord limits are enforced before saving', () => {
  const { es } = fresh();
  const { normalizeDraft, validateDraft, emptyDraft, embedLength, parseColor, isValidButtonEmoji } = es._internals;
  assert.ok(validateDraft(emptyDraft()).length, 'empty embed rejected');
  assert.deepEqual(validateDraft(normalizeDraft(GOOD)), []);
  const d = (o) => ({ ...emptyDraft(), description: 'x', ...o });
  assert.ok(validateDraft(d({ title: 'a'.repeat(257) })).some(p => /Title/.test(p)));
  assert.ok(validateDraft(d({ description: 'a'.repeat(4097) })).some(p => /Description/.test(p)));
  assert.ok(validateDraft(d({ fields: Array.from({ length: 26 }, () => ({ name: 'n', value: 'v' })) })).some(p => /Too many fields/.test(p)));
  assert.ok(validateDraft(d({ description: 'a'.repeat(4000), fields: [{ name: 'n', value: 'v'.repeat(1000) }, { name: 'n', value: 'v'.repeat(1000) }, { name: 'n', value: 'v' }] })).some(p => /Total/.test(p)));
  assert.ok(validateDraft(d({ color: 'purple' })).some(p => /Color/.test(p)));
  assert.ok(validateDraft(d({ imageUrl: 'javascript:alert(1)' })).some(p => /Image/.test(p)));
  assert.ok(validateDraft(d({ footer: { text: '', iconUrl: 'https://x.io/a.png' } })).some(p => /Footer icon/.test(p)));
  assert.ok(validateDraft(d({ buttons: [{ label: 'x', url: 'ftp://nope', emoji: '' }] })).some(p => /Button 1/.test(p)));
  assert.ok(validateDraft(d({ buttons: [{ label: 'x', url: 'https://a.io', emoji: 'abc' }] })).some(p => /emoji/.test(p)));
  assert.equal(parseColor('#5865F2'), 0x5865F2);
  assert.equal(parseColor('fff'), 0xFFFFFF);
  assert.equal(parseColor('zzz'), null);
  assert.ok(isValidButtonEmoji('🎮') && isValidButtonEmoji('<:x1:123456789012345678>') && !isValidButtonEmoji('hello'));
  assert.equal(embedLength(normalizeDraft(GOOD)), 'Rules'.length + 'Be kind.'.length);
});
test('older/foreign saved shapes load without throwing and keep their values', () => {
  const { es } = fresh();
  const n = es._internals.normalizeDraft({ title: 'T', color: 0x123456, image: { url: 'https://a.io/i.png' }, thumbnail: 'https://a.io/t.png', footer: 'foot', fields: [{ name: 'a', value: 'b', inline: true }], buttons: [{ label: 'L', response: {} }] });
  assert.equal(n.color, '#123456');
  assert.equal(n.imageUrl, 'https://a.io/i.png');
  assert.equal(n.footer.text, 'foot');
  assert.equal(n.fields[0].inline, true);
  assert.deepEqual(n.buttons, [], 'legacy response-buttons without URL are dropped, not crashed on');
  assert.deepEqual(es._internals.normalizeDraft(null), es._internals.emptyDraft());
});
test('modal input is validated and never mutates the draft on error', () => {
  const { es } = fresh();
  const { applyModal, emptyDraft } = es._internals;
  const d = emptyDraft();
  assert.match(applyModal(d, 'style', k => ({ color: 'nope', titleUrl: '' }[k])).error, /Color/);
  assert.match(applyModal(d, 'images', k => ({ imageUrl: 'not a url', thumbnailUrl: '' }[k])).error, /Image/);
  assert.match(applyModal(d, 'field', k => ({ name: '', value: 'v', inline: '' }[k])).error, /name and a value/);
  const ok = applyModal(d, 'field', k => ({ name: 'n', value: 'v', inline: 'yes' }[k]));
  assert.equal(ok.draft.fields[0].inline, true);
  assert.equal(d.fields.length, 0, 'original untouched');
  assert.match(applyModal({ ...d, description: 'a'.repeat(5990) }, 'text', k => ({ title: 'b'.repeat(256), description: 'a'.repeat(5990) }[k])).error, /6000/);
});

// ───────────────────────── command flows ─────────────────────────
test('create: opens editor, rejects duplicates/invalid names, saves only after Save and records owner', async () => {
  const { dbm, es } = fresh();
  const cmd = es.command;
  let i = fake({ sub: 'create', strings: { name: 'My Embed' } });
  await cmd.execute(i);
  assert.equal(last(i)[0], 'reply');
  assert.equal(es._internals.sessions.size, 1);
  assert.equal(dbm.findSavedEmbed('g1', 'my embed'), null, 'nothing persisted before Save');
  const sid = [...es._internals.sessions.keys()][0];
  // Save while empty is refused
  let r = await press(es, sid, 'save');
  assert.equal(titleOf(last(r.i)), 'Cannot Save Yet');
  assert.equal(dbm.findSavedEmbed('g1', 'my embed'), null);
  // fill via modal then preview then save
  r = await press(es, sid, 'm_text', { modalFields: { title: 'Hello', description: 'World' } });
  assert.equal(last(r.i)[0], 'update');
  r = await press(es, sid, 'preview');
  assert.equal(last(r.i)[0], 'reply');
  r = await press(es, sid, 'save');
  const row = dbm.findSavedEmbed('g1', 'MY   EMBED');
  assert.ok(row, 'persisted');
  assert.equal(row.ownerId, 'u1');
  assert.equal(row.data.title, 'Hello');
  assert.match(last(r.i)[1].content, /saved/);
  assert.equal(es._internals.sessions.has(sid), false);
  // duplicate + invalid names
  i = fake({ sub: 'create', strings: { name: 'my EMBED' } });
  await cmd.execute(i);
  assert.equal(titleOf(last(i)), 'Name Already Used');
  i = fake({ sub: 'create', strings: { name: '   ' } });
  await cmd.execute(i);
  assert.equal(titleOf(last(i)), 'Invalid Name');
  i = fake({ sub: 'create', strings: { name: 'x'.repeat(65) } });
  await cmd.execute(i);
  assert.equal(titleOf(last(i)), 'Invalid Name');
});
test('create: cancel discards; foreign users and expired sessions are rejected', async () => {
  const { dbm, es } = fresh();
  await es.command.execute(fake({ sub: 'create', strings: { name: 'Temp' } }));
  const sid = [...es._internals.sessions.keys()][0];
  let r = await press(es, sid, 'text', { user: 'intruder' });
  assert.equal(titleOf(last(r.i)), 'Not Your Session');
  assert.equal(last(r.i)[0], 'reply', 'no modal opened for the intruder');
  r = await press(es, sid, 'cancel', { user: 'intruder' });
  assert.ok(es._internals.sessions.has(sid), 'intruder cannot cancel');
  r = await press(es, sid, 'text', { userPerms: [] });
  assert.equal(titleOf(last(r.i)), 'Missing Permissions');
  r = await press(es, sid, 'cancel');
  assert.equal(last(r.i)[0], 'update');
  assert.equal(es._internals.sessions.has(sid), false);
  assert.equal(dbm.findSavedEmbed('g1', 'temp'), null);
  r = await press(es, sid, 'save');
  assert.equal(titleOf(last(r.i)), 'Expired');
  await es.command.execute(fake({ sub: 'create', strings: { name: 'Timed' } }));
  const sid2 = [...es._internals.sessions.keys()][0];
  es._internals.sessions.get(sid2).expiresAt = Date.now() - 1;
  r = await press(es, sid2, 'save');
  assert.equal(titleOf(last(r.i)), 'Expired');
});
test('edit: loads by name with values, saves to the SAME record, respects ownership and concurrent changes', async () => {
  const { dbm, es } = fresh();
  const made = dbm.createSavedEmbed('g1', 'News', { ...GOOD, title: 'Original' }, 'owner1').embed;
  // not owner, only Manage Messages -> denied
  let i = fake({ sub: 'edit', user: 'other', strings: { name: 'news' } });
  await es.command.execute(i);
  assert.equal(titleOf(last(i)), 'Not Your Embed');
  assert.equal(es._internals.sessions.size, 0);
  // missing
  i = fake({ sub: 'edit', user: 'owner1', strings: { name: 'ghost' } });
  await es.command.execute(i);
  assert.equal(titleOf(last(i)), 'Embed Not Found');
  // owner opens, values populated, edits, saves
  i = fake({ sub: 'edit', user: 'owner1', strings: { name: 'NEWS' } });
  await es.command.execute(i);
  const sid = [...es._internals.sessions.keys()][0];
  assert.equal(es._internals.sessions.get(sid).draft.title, 'Original');
  assert.equal(es._internals.sessions.get(sid).embedId, made.id);
  await press(es, sid, 'm_text', { user: 'owner1', modalFields: { title: 'Edited', description: 'Be kind.' } });
  await press(es, sid, 'save', { user: 'owner1' });
  assert.equal(dbm.listSavedEmbeds('g1').length, 1);
  const after = dbm.findSavedEmbed('g1', 'news');
  assert.equal(after.id, made.id);
  assert.equal(after.data.title, 'Edited');
  // a server manager may edit someone else's embed
  i = fake({ sub: 'edit', user: 'admin', userPerms: ['ManageGuild'], strings: { name: 'news' } });
  await es.command.execute(i);
  assert.equal(last(i)[0], 'reply');
  assert.equal(es._internals.sessions.size, 1, 'editor opened for the manager');
  assert.equal([...es._internals.sessions.values()][0].embedId, made.id);
  // concurrent change: open, someone else saves, then we save -> conflict, theirs preserved
  es._internals.sessions.clear();
  await es.command.execute(fake({ sub: 'edit', user: 'owner1', strings: { name: 'news' } }));
  const sid2 = [...es._internals.sessions.keys()][0];
  const cur = dbm.findSavedEmbed('g1', 'news');
  dbm.updateSavedEmbed(cur.id, cur.updatedAt, { ...GOOD, title: 'Theirs' });
  await press(es, sid2, 'm_text', { user: 'owner1', modalFields: { title: 'Mine', description: 'x' } });
  const r = await press(es, sid2, 'save', { user: 'owner1' });
  assert.equal(titleOf(last(r.i)), 'Save Conflict');
  assert.equal(dbm.findSavedEmbed('g1', 'news').data.title, 'Theirs');
});
test('delete: confirm shows name; cancel keeps; wrong user blocked; confirm deletes; double-delete handled', async () => {
  const { dbm, es } = fresh();
  dbm.createSavedEmbed('g1', 'Old Post', GOOD, 'owner1');
  let i = fake({ sub: 'delete', user: 'other', strings: { name: 'old post' } });
  await es.command.execute(i);
  assert.equal(titleOf(last(i)), 'Not Your Embed');
  i = fake({ sub: 'delete', user: 'owner1', strings: { name: 'nothing' } });
  await es.command.execute(i);
  assert.equal(titleOf(last(i)), 'Embed Not Found');
  i = fake({ sub: 'delete', user: 'owner1', strings: { name: 'OLD   POST' } });
  await es.command.execute(i);
  assert.match(last(i)[1].embeds[0].d, /Old Post/);
  const sid = [...es._internals.sessions.keys()][0];
  let r = await press(es, sid, 'delyes', { user: 'other' });
  assert.equal(titleOf(last(r.i)), 'Not Your Session');
  assert.ok(dbm.findSavedEmbed('g1', 'old post'), 'still there');
  r = await press(es, sid, 'delno', { user: 'owner1' });
  assert.ok(dbm.findSavedEmbed('g1', 'old post'), 'cancel leaves it');
  // new prompt, confirm
  i = fake({ sub: 'delete', user: 'owner1', strings: { name: 'old post' } });
  await es.command.execute(i);
  const sid2 = [...es._internals.sessions.keys()][0];
  r = await press(es, sid2, 'delyes', { user: 'owner1' });
  assert.equal(dbm.findSavedEmbed('g1', 'old post'), null);
  assert.equal(titleOf(last(r.i).length ? last(r.i) : null), 'Embed Deleted');
  // already deleted between prompt and confirm
  dbm.createSavedEmbed('g1', 'Ghost', GOOD, 'owner1');
  i = fake({ sub: 'delete', user: 'owner1', strings: { name: 'ghost' } });
  await es.command.execute(i);
  const sid3 = [...es._internals.sessions.keys()][0];
  dbm.deleteEmbed('g1', 'ghost');
  r = await press(es, sid3, 'delyes', { user: 'owner1' });
  assert.equal(titleOf(last(r.i)), 'Already Deleted');
  // legacy (ownerless) rows: only managers
  dbm.createSavedEmbed('g1', 'Legacy', GOOD, null);
  i = fake({ sub: 'delete', user: 'u9', strings: { name: 'legacy' } });
  await es.command.execute(i);
  assert.equal(titleOf(last(i)), 'Not Your Embed');
  i = fake({ sub: 'delete', user: 'u9', userPerms: ['Administrator'], strings: { name: 'legacy' } });
  await es.command.execute(i);
  assert.equal(titleOf(last(i)), 'Delete Embed?');
});
test('delete confirmation expires', async () => {
  const { dbm, es } = fresh();
  dbm.createSavedEmbed('g1', 'Soon', GOOD, 'u1');
  await es.command.execute(fake({ sub: 'delete', strings: { name: 'soon' } }));
  const sid = [...es._internals.sessions.keys()][0];
  es._internals.sessions.get(sid).expiresAt = Date.now() - 1;
  const r = await press(es, sid, 'delyes');
  assert.equal(titleOf(last(r.i)), 'Expired');
  assert.ok(dbm.findSavedEmbed('g1', 'soon'));
});
test('send: current channel by default, explicit channel, validation and permission errors, success only after delivery', async () => {
  const { dbm, es } = fresh();
  dbm.createSavedEmbed('g1', 'Announce', { ...GOOD, buttons: [{ label: 'Docs', url: 'https://example.com', emoji: '' }] }, 'u1');
  const here = textChannel('c1'), other = textChannel('c2');
  // default -> this channel
  let i = fake({ sub: 'send', strings: { name: 'ANNOUNCE' }, channels: [here, other] });
  await es.command.execute(i);
  assert.equal(here.sent.length, 1);
  assert.equal(other.sent.length, 0);
  assert.equal(here.sent[0].allowedMentions.parse.length, 0);
  assert.equal(titleOf(last(i)), 'Embed Sent');
  // explicit channel
  i = fake({ sub: 'send', strings: { name: 'announce' }, channelOpt: { id: 'c2' }, channels: [here, other] });
  await es.command.execute(i);
  assert.equal(other.sent.length, 1);
  assert.equal(here.sent.length, 1);
  // missing embed -> nothing sent
  i = fake({ sub: 'send', strings: { name: 'nope' }, channels: [here] });
  await es.command.execute(i);
  assert.equal(titleOf(last(i)), 'Embed Not Found');
  // wrong type (voice) and inaccessible channel
  const voice = textChannel('v1', { type: ChannelType.GuildVoice });
  i = fake({ sub: 'send', strings: { name: 'announce' }, channelOpt: { id: 'v1' }, channels: [voice] });
  await es.command.execute(i);
  assert.equal(titleOf(last(i)), 'Invalid Channel');
  i = fake({ sub: 'send', strings: { name: 'announce' }, channelOpt: { id: 'ghost' }, channels: [here] });
  await es.command.execute(i);
  assert.equal(titleOf(last(i)), 'Channel Not Found');
  // bot lacks Embed Links
  const noEmbed = textChannel('c3', { allow: ['ViewChannel', 'SendMessages'] });
  i = fake({ sub: 'send', strings: { name: 'announce' }, channelOpt: { id: 'c3' }, channels: [noEmbed] });
  await es.command.execute(i);
  assert.equal(titleOf(last(i)), 'I Cannot Send There');
  assert.match(last(i)[1].embeds[0].d, /Embed Links/);
  assert.equal(noEmbed.sent.length, 0);
  // user lacks Send Messages there
  const userBlocked = textChannel('c4');
  userBlocked.permissionsFor = who => (who.id === 'bot' ? perms('ViewChannel', 'SendMessages', 'EmbedLinks') : perms('ViewChannel'));
  i = fake({ sub: 'send', strings: { name: 'announce' }, channelOpt: { id: 'c4' }, channels: [userBlocked] });
  await es.command.execute(i);
  assert.equal(titleOf(last(i)), 'You Cannot Send There');
  assert.equal(userBlocked.sent.length, 0);
  // Discord rejects the send -> error reported, never a success message
  const boom = textChannel('c5', { sendImpl: async () => { const e = new Error('Missing Permissions'); e.code = 50013; throw e; } });
  const origErr = console.error; console.error = () => {};
  i = fake({ sub: 'send', strings: { name: 'announce' }, channelOpt: { id: 'c5' }, channels: [boom] });
  await es.command.execute(i);
  console.error = origErr;
  assert.equal(titleOf(last(i)), 'Send Failed');
  assert.ok(!i.calls.some(c => c[1]?.embeds?.[0]?.t === 'Embed Sent'));
  // too little permission to use the command at all
  i = fake({ sub: 'send', userPerms: [], strings: { name: 'announce' }, channels: [here] });
  await es.command.execute(i);
  assert.equal(titleOf(last(i)), 'Missing Permissions');
});
test('list works and the obsolete /embedbuilder command is gone from the shipped bundle', async () => {
  const { dbm, es } = fresh();
  dbm.createSavedEmbed('g1', 'One', GOOD, 'u1');
  const i = fake({ sub: 'list' });
  await es.command.execute(i);
  assert.match(last(i)[1].embeds[0].d, /One/);
  assert.ok(!/embedbuilder|embedBuilder/.test(BUNDLE), 'no /embedbuilder references remain');
  assert.match(BUNDLE, /commands\.push\(\.\.\.require\('\.\/embedsystem'\)\.commands\)/);
  assert.match(BUNDLE, /embedSystem\.handleInteraction\(interaction\)/);
  assert.match(BUNDLE, /embedSystem\.handleAutocomplete\(interaction\)/);
  assert.equal((BUNDLE.match(/embedSystem\.handleInteraction/g) || []).length, 1, 'handler registered once');
});

// ───────────────────────── embed-name (reveal) buttons ─────────────────────────
test('button modal takes an embed NAME, resolves it to a stable id, and rejects unknown/duplicate-cap targets', async () => {
  const { dbm, es } = fresh();
  const target = dbm.createSavedEmbed('g1', 'Rules Detail', GOOD, 'u1').embed;
  const resolve = n => dbm.findSavedEmbed('g1', n);
  const { applyModal, emptyDraft, validateDraft } = es._internals;
  const ok = applyModal(emptyDraft(), 'button', k => ({ label: 'More', embed: '  rules   DETAIL ', emoji: '' }[k]), resolve);
  assert.equal(ok.draft.buttons[0].targetId, target.id);
  assert.equal(ok.draft.buttons[0].targetName, 'Rules Detail');
  assert.ok(!('url' in ok.draft.buttons[0]));
  assert.deepEqual(validateDraft({ ...ok.draft, description: 'x' }), []);
  assert.match(applyModal(emptyDraft(), 'button', k => ({ label: 'More', embed: 'ghost', emoji: '' }[k]), resolve).error, /No saved embed named/);
  assert.match(applyModal(emptyDraft(), 'button', k => ({ label: 'More', embed: '', emoji: '' }[k]), resolve).error, /name of the saved embed/);
  assert.match(applyModal(emptyDraft(), 'button', k => ({ label: 'More', embed: 'rules detail', emoji: 'abc' }[k]), resolve).error, /emoji/);
  let d = emptyDraft();
  for (let n = 0; n < 10; n++) d = applyModal(d, 'button', k => ({ label: 'b' + n, embed: 'rules detail', emoji: '' }[k]), resolve).draft;
  assert.match(applyModal(d, 'button', k => ({ label: 'x', embed: 'rules detail', emoji: '' }[k]), resolve).error, /At most 10/);
});
test('clicking a reveal button privately shows the target; missing, foreign-server and damaged targets are handled', async () => {
  const { dbm, es } = fresh();
  const target = dbm.createSavedEmbed('g1', 'Details', { ...GOOD, title: 'Secret details' }, 'u1').embed;
  let i = fake({ user: 'anyone', userPerms: [], customId: `embreveal:${target.id}` });
  assert.equal(await es.handleInteraction(i), true);
  assert.equal(last(i)[0], 'reply');
  assert.equal(last(i)[1].ephemeral, true);
  assert.ok(last(i)[1].embeds.length === 1 && last(i)[1].components);
  // chained: target with its own reveal button
  const chain2 = dbm.createSavedEmbed('g1', 'Chain', { ...GOOD, buttons: [{ label: 'Next', targetId: target.id, targetName: 'Details', emoji: '' }] }, 'u1').embed;
  i = fake({ customId: `embreveal:${chain2.id}` });
  await es.handleInteraction(i);
  assert.equal(last(i)[0], 'reply');
  // other server cannot reveal it
  const foreign = fake({ customId: `embreveal:${target.id}` }); foreign.guildId = 'g2';
  await es.handleInteraction(foreign);
  assert.equal(titleOf(last(foreign)), 'Embed Not Found');
  // deleted target
  dbm.deleteSavedEmbedById(target.id);
  i = fake({ customId: `embreveal:${target.id}` });
  await es.handleInteraction(i);
  assert.equal(titleOf(last(i)), 'Embed Not Found');
  // garbage id
  i = fake({ customId: 'embreveal:not-a-real-id' });
  await es.handleInteraction(i);
  assert.equal(titleOf(last(i)), 'Embed Not Found');
  // damaged data
  const bad = dbm.createSavedEmbed('g1', 'Broken', GOOD, 'u1').embed;
  dbm.db.prepare('UPDATE saved_embeds SET data=? WHERE id=?').run('{not json', bad.id);
  i = fake({ customId: `embreveal:${bad.id}` });
  await es.handleInteraction(i);
  assert.equal(titleOf(last(i)), 'Embed Unavailable');
});
test('saving or sending an embed whose button target was deleted is refused', async () => {
  const { dbm, es } = fresh();
  const target = dbm.createSavedEmbed('g1', 'Target', GOOD, 'u1').embed;
  await es.command.execute(fake({ sub: 'create', strings: { name: 'Host' } }));
  const sid = [...es._internals.sessions.keys()][0];
  await press(es, sid, 'm_text', { modalFields: { title: 'Host', description: 'x' } });
  await press(es, sid, 'm_button', { modalFields: { label: 'Open', embed: 'target' } });
  assert.equal(es._internals.sessions.get(sid).draft.buttons.length, 1);
  dbm.deleteSavedEmbedById(target.id);
  const r = await press(es, sid, 'save');
  assert.equal(titleOf(last(r.i)), 'Cannot Save Yet');
  assert.equal(dbm.findSavedEmbed('g1', 'host'), null);
  // already-saved host whose target disappears cannot be sent
  const t2 = dbm.createSavedEmbed('g1', 'T2', GOOD, 'u1').embed;
  dbm.createSavedEmbed('g1', 'Host2', { ...GOOD, buttons: [{ label: 'x', targetId: t2.id, targetName: 'T2', emoji: '' }] }, 'u1');
  dbm.deleteSavedEmbedById(t2.id);
  const ch = textChannel('c1');
  const i = fake({ sub: 'send', strings: { name: 'host2' }, channels: [ch] });
  await es.command.execute(i);
  assert.equal(titleOf(last(i)), 'Embed Is Invalid');
  assert.equal(ch.sent.length, 0);
});
test('reveal clicks are routed by the bundle dispatcher and legacy URL buttons still load', () => {
  const { es } = fresh();
  const n = es._internals.normalizeDraft({ buttons: [{ label: 'Docs', url: 'https://a.io' }, { label: 'R', targetId: 'abc', targetName: 'X' }, { label: 'bad' }] });
  assert.equal(n.buttons.length, 2);
  assert.equal(n.buttons[0].url, 'https://a.io');
  assert.equal(n.buttons[1].targetId, 'abc');
  assert.match(BUNDLE, /embreveal:/);
});
