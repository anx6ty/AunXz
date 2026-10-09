// ownertools.js — OWNER-ONLY module (slash + prefix share the same execute handlers).
// Storage: the existing SQLite database only (co-owners live in owner_config JSON; new tables are in database.js).
// Config: OWNER_ID / OWNER_IDS (main owners), OWNER_GUILD_ID (where slash commands register),
//         OWNER_COMMAND_LOG_CHANNEL_ID (private command log), OWNER_ERROR_LOG_CHANNEL_ID (already used for errors).

const {
  SlashCommandBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, version: djsVersion
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { randomBytes } = require('crypto');
const db = require('./database');
const ui = require('./ui');
const h = require('./helpers');

const raw = db.db;
const ctx = { commands: [], aliases: new Map() };
function init(o) { Object.assign(ctx, o || {}); }

// ---------------------------------------------------------------------------------
// Owner system
// ---------------------------------------------------------------------------------
const envIds = () => [process.env.OWNER_ID, ...(process.env.OWNER_IDS || '').split(',')].map(s => String(s || '').trim()).filter(Boolean);
const isMainOwner = id => envIds().includes(String(id || ''));
const coOwners = () => { const l = db.getOwnerConfig().coOwners; return Array.isArray(l) ? l : []; };
const isCoOwner = id => coOwners().some(o => o.id === String(id));
const isOwner = id => isMainOwner(id) || isCoOwner(id);
const snowflake = s => /^\d{15,25}$/.test(String(s || '').trim());
const q = name => `"${String(name).replace(/"/g, '""')}"`;
const fmtBytes = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
const isSlash = i => typeof i.fetchReply === 'function';

function describeArgs(i) {
  if (typeof i.argText === 'string') return i.argText;
  try { return (i.options?.data || []).map(o => `${o.name}=${o.options ? o.options.map(x => `${x.name}=${x.value}`).join(',') : (o.attachment ? o.attachment.name : o.value)}`).join(' '); } catch { return ''; }
}
function audit(i, name) {
  const args = describeArgs(i);
  try { db.logOwnerAudit(i.user.id, name, args, i.guildId); } catch (e) { console.error('[Owner] audit failed:', e.message); }
  const chId = process.env.OWNER_COMMAND_LOG_CHANNEL_ID || process.env.OWNER_LOG_CHANNEL_ID || db.getOwnerConfig().commandChannelId;
  if (!chId) return;
  i.client.channels.fetch(chId).then(ch => ch?.isTextBased() && ch.send({ embeds: [h.infoEmbed('Owner command used',
    `**User:** <@${i.user.id}> (\`${i.user.id}\`)\n**Command:** /${name}\n**Args:** ${h.clip(args || '—', 400)}\n**Guild:** ${i.guildId || 'DM'}\n**Time:** <t:${Math.floor(Date.now() / 1000)}:F>`)] })).catch(() => {});
}

// Every command goes through define(): owner gate -> audit log -> try/catch with a real error embed.
function define(builder, { main = false } = {}, run) {
  const name = builder.name;
  return {
    ownerOnly: true, data: builder,
    async execute(i) {
      const uid = i.user?.id;
      if (!isOwner(uid) || (main && !isMainOwner(uid))) {
        return h.safeReply(i, { embeds: [h.errorEmbed('Owner only', isOwner(uid) ? 'This command is restricted to the main owner.' : 'This command is owner-only.')], ephemeral: true });
      }
      console.log(`[Owner] /${name} by ${uid}`);
      audit(i, name);
      try { await run(i); }
      catch (e) {
        console.error(`[Owner] /${name} failed:`, e);
        await h.safeReply(i, { embeds: [h.errorEmbed(`/${name} failed`, String(e?.message || e).slice(0, 1500))], ephemeral: true });
      }
    }
  };
}
const ack = i => (i.deferReply && !i.deferred && !i.replied ? i.deferReply({ ephemeral: true }) : null);
const done = (i, payload) => (i.editReply ? i.editReply(payload) : h.safeReply(i, payload));

// ---------------------------------------------------------------------------------
// Confirm / Cancel flow — 30s timeout, buttons disable, author-only
// ---------------------------------------------------------------------------------
const pending = new Map();
async function confirmFlow(i, { title, description, yes = 'Confirm', extra = [], run }) {
  const token = randomBytes(6).toString('hex');
  const rows = (dis = false) => [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`own-c:${token}:yes`).setLabel(yes).setStyle(ButtonStyle.Danger).setDisabled(dis),
    ...extra.map(x => new ButtonBuilder().setCustomId(`own-c:${token}:${x.id}`).setLabel(x.label).setStyle(ButtonStyle.Primary).setDisabled(dis)),
    new ButtonBuilder().setCustomId(`own-c:${token}:no`).setLabel('Cancel').setStyle(ButtonStyle.Secondary).setDisabled(dis))];
  const embed = expired => h.warnEmbed(title, `${description}\n\n${expired ? '⏱ Expired — nothing was changed.' : 'Expires in 30 seconds.'}`);
  const sent = await h.safeReply(i, { embeds: [embed(false)], components: rows(), ephemeral: true });
  const rec = { userId: i.user.id, run };
  pending.set(token, rec);
  rec.timer = setTimeout(async () => {
    if (!pending.delete(token)) return;
    const p = { embeds: [embed(true)], components: rows(true) };
    try { if (isSlash(i)) await i.editReply(p); else await sent?.edit?.(p); } catch { /* message gone */ }
  }, 30000);
  rec.timer.unref?.();
}
async function handleConfirm(i) {
  const [, token, choice] = i.customId.split(':');
  const rec = pending.get(token);
  if (!rec) return void await i.reply({ embeds: [h.warnEmbed('Expired', 'Run the command again.')], ephemeral: true });
  if (i.user.id !== rec.userId) return void await h.authorOnly(i, rec.userId);
  if (!isOwner(i.user.id)) return void await i.reply({ embeds: [h.errorEmbed('Owner only', 'This command is owner-only.')], ephemeral: true });
  clearTimeout(rec.timer); pending.delete(token);
  if (choice === 'no') return void await i.update({ embeds: [h.infoEmbed('Cancelled', 'Nothing was changed.')], components: [] });
  await i.deferUpdate();
  try {
    const result = await rec.run(i, choice);
    await i.editReply({ embeds: [typeof result === 'string' ? h.successEmbed('Done', result) : result], components: [] });
  } catch (e) {
    console.error('[Owner] confirmed action failed:', e);
    await i.editReply({ embeds: [h.errorEmbed('Action failed', String(e?.message || e).slice(0, 1500))], components: [] });
  }
}

// ---------------------------------------------------------------------------------
// DB introspection helpers
// ---------------------------------------------------------------------------------
const userTables = () => raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
const hasGuildCol = t => raw.prepare(`PRAGMA table_info(${q(t)})`).all().some(c => c.name === 'guildId');
const KEEP_ON_RESET = new Set(['memberships', 'owner_audit', 'error_log']);   // billing + audit trail are never wiped by guild resets
const guildTables = () => userTables().filter(hasGuildCol);
const resetTables = () => guildTables().filter(t => !KEEP_ON_RESET.has(t));
const LABELS = { guild_config: 'Settings', levels: 'Levels', warns: 'Warnings', tickets: 'Tickets', giveaways: 'Giveaways', sticky_messages: 'Sticky messages', voicemaster_channels: 'Voice channels', antinuke_whitelist: 'Antinuke whitelist', action_log: 'Action log', sticky_roles: 'Sticky roles', spam_tracker: 'Spam tracker', join_tracker: 'Join tracker', saved_embeds: 'Saved embeds', staff_applications: 'Staff applications', command_usage: 'Command usage' };
const label = t => LABELS[t] || t;
function countGuild(guildId) {
  return resetTables().map(t => ({ table: t, count: raw.prepare(`SELECT COUNT(*) c FROM ${q(t)} WHERE guildId = ?`).get(guildId).c })).filter(r => r.count > 0);
}
function deleteGuildData(guildId) {
  const tables = resetTables();
  return raw.transaction(() => tables.map(t => ({ table: t, count: raw.prepare(`DELETE FROM ${q(t)} WHERE guildId = ?`).run(guildId).changes })).filter(r => r.count > 0))();
}
function guildIdsWithData() {
  const ids = new Set();
  for (const t of resetTables()) for (const r of raw.prepare(`SELECT DISTINCT guildId FROM ${q(t)}`).all()) if (snowflake(r.guildId)) ids.add(r.guildId);
  return ids;
}
const SENSITIVE = /token|secret|password|api[_-]?key|authorization|webhook.*url/i;
function sanitize(v) {
  if (Array.isArray(v)) return v.map(sanitize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !SENSITIVE.test(k)).map(([k, x]) => [k, sanitize(x)]));
  return v;
}
function exportGuild(guildId) {
  const out = { exportedAt: new Date().toISOString(), guildId, tables: {} };
  for (const t of guildTables()) {
    if (t === 'owner_audit' || t === 'error_log') continue;
    const rows = raw.prepare(`SELECT * FROM ${q(t)} WHERE guildId = ?`).all(guildId);
    if (!rows.length) continue;
    out.tables[t] = rows.map(r => { if (typeof r.data === 'string') { try { return sanitize({ ...r, data: JSON.parse(r.data) }); } catch { /* keep raw */ } } return sanitize(r); });
  }
  return out;
}
const dbSize = () => { let n = 0; for (const f of [db.DB_PATH, `${db.DB_PATH}-wal`]) { try { n += fs.statSync(f).size; } catch { /* missing */ } } return n; };

// ---------------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------------
const MAX_PART = 9_000_000;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
async function snapshot(labelName) {
  const dir = path.join(db.DATA_DIR, 'backups'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `aunxz-${labelName}-${stamp()}.sqlite`);
  await raw.backup(file);
  const old = fs.readdirSync(dir).filter(f => f.startsWith('aunxz-pre-')).sort().slice(0, -5);   // keep the last 5 safety backups
  for (const f of old) fs.unlink(path.join(dir, f), () => {});
  return file;
}
function prepareFiles(file) {
  let outPath = file; let name = path.basename(file); const tmp = [];
  if (fs.statSync(file).size > MAX_PART / 2) {
    const gz = `${file}.gz`; fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(file))); outPath = gz; name += '.gz'; tmp.push(gz);
  }
  if (fs.statSync(outPath).size <= MAX_PART) return { files: [{ path: outPath, name }], tmp, split: false };
  const buf = fs.readFileSync(outPath); const files = [];
  for (let n = 0, o = 0; o < buf.length; n++, o += MAX_PART) { const p = `${outPath}.part${n + 1}`; fs.writeFileSync(p, buf.subarray(o, o + MAX_PART)); files.push({ path: p, name: `${name}.part${n + 1}` }); tmp.push(p); }
  return { files, tmp, split: true };
}
async function dmFiles(i, embed, files) {
  try {
    for (let n = 0; n < files.length; n += 5) {
      await i.user.send({ embeds: n === 0 ? [embed] : [], files: files.slice(n, n + 5).map(f => new AttachmentBuilder(f.path, { name: f.name })) });
    }
    return null;
  } catch (e) { return e; }
}
const dmClosed = e => h.errorEmbed('I could not DM you', `Your DMs are closed (${e?.message || 'DM failed'}). Enable **Direct Messages** from server members for this server, then run the command again. Backups are never posted publicly.`);
const backupCooldown = new Map();

// Restore: copy tables from an ATTACHed backup inside ONE transaction, so a failure rolls back cleanly.
function restoreFrom(file) {
  raw.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS rs`);
  try {
    const live = new Set(userTables());
    const tables = raw.prepare("SELECT name FROM rs.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name).filter(t => live.has(t));
    const report = [];
    raw.exec('BEGIN');
    try {
      for (const t of tables) {
        const liveCols = raw.prepare(`PRAGMA main.table_info(${q(t)})`).all().map(c => c.name);
        const bkCols = new Set(raw.prepare(`PRAGMA rs.table_info(${q(t)})`).all().map(c => c.name));
        const cols = liveCols.filter(c => bkCols.has(c)).map(q).join(',');
        raw.exec(`DELETE FROM main.${q(t)}`);
        const n = raw.exec(`INSERT INTO main.${q(t)} (${cols}) SELECT ${cols} FROM rs.${q(t)}`);
        report.push(t);
      }
      raw.exec('COMMIT');
    } catch (e) { raw.exec('ROLLBACK'); throw e; }
    return report;
  } finally { raw.exec('DETACH DATABASE rs'); }
}
async function loadBackupAttachment(att) {
  if (!att) throw new Error('Attach a backup file (`.sqlite` or `.sqlite.gz`) to the command.');
  if (att.size > 60 * 1024 * 1024) throw new Error(`That file is ${fmtBytes(att.size)}; the limit is 60 MB.`);
  if (!/\.(sqlite|db|gz)$/i.test(att.name || '')) throw new Error('Unsupported file type. Use a `.sqlite` or `.sqlite.gz` file from `/backup`.');
  const res = await fetch(att.url);
  if (!res.ok) throw new Error(`Could not download the attachment (HTTP ${res.status}).`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf, { maxOutputLength: 200 * 1024 * 1024 });
  if (buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') throw new Error('That file is not a SQLite database.');
  const dir = path.join(db.DATA_DIR, 'backups'); fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `incoming-${stamp()}.sqlite`); fs.writeFileSync(tmp, buf);
  let Database; try { Database = require('better-sqlite3'); } catch { throw new Error('better-sqlite3 is not available to validate the file.'); }
  const probe = new Database(tmp, { readonly: true, fileMustExist: true });
  try {
    const integrity = probe.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`Integrity check failed: ${integrity}`);
    const names = probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    if (!names.includes('guild_config')) throw new Error('This does not look like an AunXz backup (missing `guild_config`).');
    const counts = Object.fromEntries(names.filter(n => !n.startsWith('sqlite_')).map(n => [n, probe.prepare(`SELECT COUNT(*) c FROM ${q(n)}`).get().c]));
    return { tmp, counts };
  } finally { probe.close(); }
}

// ---------------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------------
const dur = s => { s = Math.floor(s); const d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return `${d}d ${hh}h ${m}m ${s % 60}s`; };
async function statsEmbed(client) {
  const t0 = Date.now(); await client.rest.get('/gateway').catch(() => {}); const api = Date.now() - t0;
  const cpuStart = process.cpuUsage(); const hr = process.hrtime.bigint();
  await new Promise(r => setTimeout(r, 250));
  const used = process.cpuUsage(cpuStart); const elapsed = Number(process.hrtime.bigint() - hr) / 1000;
  const cpu = Math.min(100, ((used.user + used.system) / elapsed) * 100);
  const mem = process.memoryUsage(); const total = os.totalmem(); const free = os.freemem();
  const guilds = client.guilds.cache;
  const shardIds = client.shard ? client.shard.ids : [...(client.ws.shards?.keys?.() || [0])];
  const shardCount = client.shard ? client.shard.count : (client.ws.shards?.size || 1);
  const members = guilds.reduce((a, g) => a + g.members.cache.size, 0);
  const msgs = client.channels.cache.reduce((a, c) => a + (c.messages?.cache?.size || 0), 0);
  return ui.base('📊 Bot stats').addFields(
    { name: 'Memory', value: `System: ${fmtBytes(total - free)} / ${fmtBytes(total)}\nHeap: ${fmtBytes(mem.heapUsed)} / ${fmtBytes(mem.heapTotal)}\nRSS: ${fmtBytes(mem.rss)}`, inline: true },
    { name: 'CPU', value: `Process: ${cpu.toFixed(1)}%\nLoad avg: ${os.loadavg().map(x => x.toFixed(2)).join(' ')}\nCores: ${os.cpus().length}`, inline: true },
    { name: 'Latency', value: `WebSocket: ${client.ws.ping}ms\nAPI: ${api}ms`, inline: true },
    { name: 'Uptime', value: dur(process.uptime()), inline: true },
    { name: 'Versions', value: `Node ${process.version}\ndiscord.js ${djsVersion}`, inline: true },
    { name: 'Counts', value: `Guilds: ${guilds.size}\nUsers: ${guilds.reduce((a, g) => a + (g.memberCount || 0), 0)}\nChannels: ${client.channels.cache.size}`, inline: true },
    { name: 'Shards', value: `Count: ${shardCount}\n${shardIds.map(id => `#${id}: ${guilds.filter(g => g.shardId === id).size} guilds`).join('\n') || '—'}`, inline: true },
    { name: 'Caches', value: `Guilds ${guilds.size} • Users ${client.users.cache.size}\nChannels ${client.channels.cache.size} • Members ${members}\nMessages ${msgs}`, inline: true },
    { name: 'Bot', value: `Commands loaded: ${ctx.commands.length}\nDatabase: ${fmtBytes(dbSize())}`, inline: true });
}
const refreshRow = uid => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`own-stats:${uid}`).setLabel('Refresh').setStyle(ButtonStyle.Primary).setEmoji('🔄'));

// ---------------------------------------------------------------------------------
// Error log viewer
// ---------------------------------------------------------------------------------
const errSessions = new Map();
function errPayload(token) {
  const s = errSessions.get(token); const list = db.listErrors(s.command);
  if (!list.length) return { embeds: [h.emptyEmbed('Error log', s.command ? `No errors recorded for \`${s.command}\`.` : 'No errors recorded. 🎉')], components: [] };
  s.index = Math.max(0, Math.min(s.index, list.length - 1)); const e = list[s.index];
  const embed = ui.base(`🐞 Error #${e.id} (${s.index + 1}/${list.length})`).setColor(ui.DANGER).addFields(
    { name: 'Time', value: `<t:${Math.floor(e.ts / 1000)}:F>`, inline: true }, { name: 'Source', value: h.clip(e.source || '—', 200), inline: true },
    { name: 'Command', value: e.command ? `/${e.command}` : '—', inline: true }, { name: 'Guild', value: e.guildId || '—', inline: true }, { name: 'User', value: e.userId ? `<@${e.userId}>` : '—', inline: true },
    { name: 'Message', value: h.clip(e.message || '—', 900) }, { name: 'Stack (trimmed)', value: `\`\`\`\n${h.clip(String(e.stack || '—').replace(/```/g, "'''"), 850)}\n\`\`\`` });
  const b = (id, lab, dis, st = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(`own-e:${token}:${id}`).setLabel(lab).setStyle(st).setDisabled(dis);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(b('prev', '◀', s.index === 0), b('next', '▶', s.index >= list.length - 1), b('full', 'View full', false, ButtonStyle.Primary))] };
}
async function handleErrorButton(i) {
  const [, token, action] = i.customId.split(':'); const s = errSessions.get(token);
  if (!s) return void await i.reply({ embeds: [h.warnEmbed('Expired', 'Run `/errors view` again.')], ephemeral: true });
  if (!await h.authorOnly(i, s.userId) || !isOwner(i.user.id)) return;
  if (action === 'full') {
    const e = db.listErrors(s.command)[s.index];
    if (!e) return void await i.reply({ embeds: [h.errorEmbed('Gone', 'That entry no longer exists.')], ephemeral: true });
    const text = `Error #${e.id}\nTime: ${new Date(e.ts).toISOString()}\nSource: ${e.source}\nCommand: ${e.command}\nGuild: ${e.guildId}\nUser: ${e.userId}\n\n${e.message}\n\n${e.stack}`;
    return void await i.reply({ files: [new AttachmentBuilder(Buffer.from(text), { name: `error-${e.id}.txt` })], ephemeral: true });
  }
  s.index += action === 'next' ? 1 : -1;
  await i.update(errPayload(token));
}

// ---------------------------------------------------------------------------------
// Public hooks used by index.js
// ---------------------------------------------------------------------------------
function recordError(err, context = '', meta = {}) {
  try {
    const m = String(context).match(/^Command \/(\S+)/);
    db.recordError({ source: context, command: meta.command || (m && m[1]) || null, guildId: meta.guildId || null, userId: meta.userId || null, message: err?.message || String(err), stack: err?.stack || '' });
  } catch (e) { console.error('[Owner] could not record error:', e.message); }
}
function trackCommand(name, guildId, ok) { try { db.trackCommandUse(name, guildId, ok); } catch (e) { console.error('[Owner] tracking failed:', e.message); } }
const disabledInfo = name => { try { return db.getToggle(name); } catch { return null; } };

// ---------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------
const commands = [];
const add = (builder, opts, run) => { const c = define(builder, opts, run); commands.push(c); return c; };
const S = (name, desc) => new SlashCommandBuilder().setName(name).setDescription(desc);

add(S('owneradd', 'Add a co-owner.').addUserOption(o => o.setName('user').setDescription('User to add').setRequired(true)), { main: true }, async i => {
  const u = i.options.getUser('user');
  if (!u) return h.safeReply(i, { embeds: [h.errorEmbed('User not found', 'Mention a valid user.')], ephemeral: true });
  if (u.bot) return h.safeReply(i, { embeds: [h.errorEmbed('Invalid user', 'Bots cannot be co-owners.')], ephemeral: true });
  if (isMainOwner(u.id)) return h.safeReply(i, { embeds: [h.errorEmbed('Already owner', 'That user is a main owner.')], ephemeral: true });
  if (isCoOwner(u.id)) return h.safeReply(i, { embeds: [h.errorEmbed('Already added', `${u} is already a co-owner.`)], ephemeral: true });
  await confirmFlow(i, { title: 'Add co-owner?', description: `${u} will be able to use every owner command except \`owneradd\`, \`ownerremove\`, \`restore\` and \`resetguild\`.`, yes: 'Add',
    run: async () => { db.saveOwnerConfig({ coOwners: [...coOwners(), { id: u.id, addedBy: i.user.id, addedAt: Date.now() }] }); return `${u} is now a co-owner.`; } });
});
add(S('ownerremove', 'Remove a co-owner.').addUserOption(o => o.setName('user').setDescription('Co-owner to remove').setRequired(true)), { main: true }, async i => {
  const u = i.options.getUser('user');
  if (!u) return h.safeReply(i, { embeds: [h.errorEmbed('User not found', 'Mention a valid user.')], ephemeral: true });
  if (isMainOwner(u.id)) return h.safeReply(i, { embeds: [h.errorEmbed('Not allowed', 'The main owner cannot be removed.')], ephemeral: true });
  if (!isCoOwner(u.id)) return h.safeReply(i, { embeds: [h.errorEmbed('Not a co-owner', `${u} is not in the co-owner list.`)], ephemeral: true });
  await confirmFlow(i, { title: 'Remove co-owner?', description: `${u} will lose all owner commands.`, yes: 'Remove',
    run: async () => { db.saveOwnerConfig({ coOwners: coOwners().filter(o => o.id !== u.id) }); return `${u} is no longer a co-owner.`; } });
});
add(S('owners', 'List owners and co-owners.'), {}, async i => {
  const lines = [...envIds().map(id => `👑 <@${id}> — main owner (config)`), ...coOwners().map(o => `🔑 <@${o.id}> — added <t:${Math.floor(o.addedAt / 1000)}:D> by <@${o.addedBy}>`)];
  await h.paginate(i, h.listPages({ title: '👑 Bot owners', lines, emptyHint: 'Set OWNER_ID in your environment.' }), { ephemeral: true });
});

add(S('backup', 'Send a database backup to your DMs.'), {}, async i => {
  const wait = 60000 - (Date.now() - (backupCooldown.get(i.user.id) || 0));
  if (wait > 0) return h.safeReply(i, { embeds: [h.warnEmbed('Cooldown', `Try again in ${Math.ceil(wait / 1000)}s.`)], ephemeral: true });
  await ack(i);
  const file = await snapshot('backup'); const prep = prepareFiles(file);
  const size = prep.files.reduce((a, f) => a + fs.statSync(f.path).size, 0);
  const err = await dmFiles(i, h.successEmbed('Database backup', `Created <t:${Math.floor(Date.now() / 1000)}:F>\n**Size:** ${fmtBytes(size)}${prep.split ? `\n**Split into ${prep.files.length} parts.** Join them with \`cat *.part* > backup.sqlite.gz\` and gunzip.` : ''}`), prep.files);
  for (const f of [file, ...prep.tmp]) fs.unlink(f, () => {});
  if (err) return done(i, { embeds: [dmClosed(err)] });
  backupCooldown.set(i.user.id, Date.now()); db.saveOwnerConfig({ lastBackupAt: Date.now() });
  await done(i, { embeds: [h.successEmbed('Backup sent', `Check your DMs (${fmtBytes(size)}, ${prep.files.length} file(s)).`)] });
});

add(S('restore', 'Restore the database from a backup file.').addAttachmentOption(o => o.setName('file').setDescription('Backup (.sqlite / .sqlite.gz)')), { main: true }, async i => {
  await ack(i);
  const att = i.options.getAttachment?.('file') || null;
  const { tmp, counts } = await loadBackupAttachment(att);
  const safety = await snapshot('pre-restore');
  const live = Object.fromEntries(userTables().map(t => [t, raw.prepare(`SELECT COUNT(*) c FROM ${q(t)}`).get().c]));
  const lines = Object.keys(counts).filter(t => t in live).slice(0, 25).map(t => `• \`${t}\`: ${live[t]} → **${counts[t]}** rows`);
  await confirmFlow(i, { title: 'Restore database?', yes: 'Restore now',
    description: `This **overwrites** every table below with the backup's data.\nA safety backup was saved to \`${path.basename(safety)}\` (host: \`data/backups\`).\n\n${h.clip(lines.join('\n'), 2500)}\n\nIf anything fails, the whole restore is rolled back.`,
    run: async () => {
      try { const t = restoreFrom(tmp); return h.successEmbed('Restore complete', `Restored **${t.length}** tables. Safety backup: \`${path.basename(safety)}\`.`); }
      finally { fs.unlink(tmp, () => {}); }
    } });
});

add(S('resetguild', 'Delete ALL stored data for a server.').addStringOption(o => o.setName('guild_id').setDescription('Server ID').setRequired(true)), { main: true }, async i => {
  const gid = String(i.options.getString('guild_id') || '').trim();
  if (!snowflake(gid)) return h.safeReply(i, { embeds: [h.errorEmbed('Invalid ID', 'Provide a numeric server ID.')], ephemeral: true });
  const counts = countGuild(gid);
  if (!counts.length) return h.safeReply(i, { embeds: [h.infoEmbed('Nothing stored', `No data exists for \`${gid}\`.`)], ephemeral: true });
  const total = counts.reduce((a, c) => a + c.count, 0);
  await confirmFlow(i, { title: `Delete all data for ${gid}?`, yes: 'Delete',
    description: `**${total}** records will be deleted:\n${counts.map(c => `• ${label(c.table)}: **${c.count}**`).join('\n')}\n\nKept: memberships and the owner audit/error logs.`,
    extra: [{ id: 'backup', label: 'Backup then delete' }],
    run: async (btn, choice) => {
      if (choice === 'backup') {
        const f = path.join(os.tmpdir(), `guild-${gid}-${stamp()}.json`); fs.writeFileSync(f, JSON.stringify(exportGuild(gid), null, 2));
        const err = await dmFiles(i, h.infoEmbed('Guild data backup', `Backup of \`${gid}\` before deletion.`), [{ path: f, name: `guild-${gid}.json` }]); fs.unlink(f, () => {});
        if (err) throw new Error('Could not DM the backup (DMs closed), so nothing was deleted.');
      }
      const removed = deleteGuildData(gid);
      for (const ext of ['.mp3', '.wav', '.ogg', '.m4a', '.audio', '.opus', '.aac', '.flac', '.webm', '.oga']) fs.unlink(path.join(db.DATA_DIR, 'greetvoice', `${gid}${ext}`), () => {});
      return h.successEmbed('Guild data deleted', removed.map(c => `• ${label(c.table)}: ${c.count}`).join('\n') || 'Nothing removed.');
    } });
});

add(S('dbstats', 'Database size and record counts.'), {}, async i => {
  const tables = userTables().map(t => ({ t, n: raw.prepare(`SELECT COUNT(*) c FROM ${q(t)}`).get().c })).sort((a, b) => b.n - a.n);
  const per = new Map();
  for (const t of resetTables()) for (const r of raw.prepare(`SELECT guildId, COUNT(*) c FROM ${q(t)} GROUP BY guildId`).all()) if (snowflake(r.guildId)) per.set(r.guildId, (per.get(r.guildId) || 0) + r.c);
  const top = [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g, n], k) => `${k + 1}. ${i.client.guilds.cache.get(g)?.name || g} — **${n}** records`);
  const last = db.getOwnerConfig().lastBackupAt;
  const lines = tables.map(x => `\`${x.t}\` ${x.n}`);
  const half = Math.ceil(lines.length / 2);
  await h.safeReply(i, { embeds: [ui.base('🗄️ Database stats').addFields(
    { name: 'Size', value: fmtBytes(dbSize()), inline: true }, { name: 'Guilds with data', value: String(per.size), inline: true }, { name: 'Last backup', value: last ? `<t:${Math.floor(last / 1000)}:R>` : 'Never', inline: true },
    { name: 'Records per table', value: h.clip(lines.slice(0, half).join('\n') || '—', 1000), inline: true }, { name: '\u200b', value: h.clip(lines.slice(half).join('\n') || '\u200b', 1000), inline: true },
    { name: 'Largest guilds', value: h.clip(top.join('\n') || '—', 1000) })], ephemeral: true });
});

add(S('cleanup', 'Delete data for servers the bot has left.').addBooleanOption(o => o.setName('dry_run').setDescription('Preview only')), {}, async i => {
  const stale = [...guildIdsWithData()].filter(g => !i.client.guilds.cache.has(g));
  if (!stale.length) return h.safeReply(i, { embeds: [h.successEmbed('Nothing to clean', 'Every stored guild is one I am still in.')], ephemeral: true });
  const per = stale.map(g => ({ g, n: countGuild(g).reduce((a, c) => a + c.count, 0) }));
  const total = per.reduce((a, c) => a + c.n, 0);
  const preview = `**${stale.length}** departed server(s), **${total}** records:\n${per.slice(0, 15).map(p => `• \`${p.g}\` — ${p.n}`).join('\n')}${per.length > 15 ? `\n…and ${per.length - 15} more` : ''}`;
  if (i.options.getBoolean('dry_run')) return h.safeReply(i, { embeds: [h.infoEmbed('Cleanup dry run', `${preview}\n\nNothing was deleted.`)], ephemeral: true });
  await confirmFlow(i, { title: 'Delete data for departed servers?', description: preview, yes: 'Delete',
    run: async () => { const before = dbSize(); let n = 0; for (const g of stale) n += deleteGuildData(g).reduce((a, c) => a + c.count, 0);
      try { raw.exec('VACUUM'); } catch { /* best effort */ }
      return h.successEmbed('Cleanup complete', `Removed **${n}** records from **${stale.length}** servers.\nReclaimed ≈ ${fmtBytes(Math.max(0, before - dbSize()))}.`); } });
});

add(S('export', 'Export a server\'s settings and data as JSON (sent by DM).').addStringOption(o => o.setName('guild_id').setDescription('Server ID (default: this server)')), {}, async i => {
  const gid = String(i.options.getString('guild_id') || i.guildId || '').trim();
  if (!snowflake(gid)) return h.safeReply(i, { embeds: [h.errorEmbed('Server required', 'Use this in a server or pass `guild_id`.')], ephemeral: true });
  await ack(i);
  const data = exportGuild(gid);
  if (!Object.keys(data.tables).length) return done(i, { embeds: [h.infoEmbed('Nothing to export', `No data stored for \`${gid}\`.`)] });
  const f = path.join(os.tmpdir(), `guild-${gid}-${stamp()}.json`); fs.writeFileSync(f, JSON.stringify(data, null, 2));
  const err = await dmFiles(i, h.successEmbed('Guild export', `Server \`${gid}\` • tokens/secrets excluded.`), [{ path: f, name: `guild-${gid}.json` }]);
  if (err && isSlash(i)) { await i.editReply({ embeds: [h.warnEmbed('DMs closed', 'Attached here (only you can see this).')], files: [new AttachmentBuilder(f, { name: `guild-${gid}.json` })] }); fs.unlink(f, () => {}); return; }
  fs.unlink(f, () => {});
  if (err) return done(i, { embeds: [dmClosed(err)] });
  await done(i, { embeds: [h.successEmbed('Export sent', 'Check your DMs.')] });
});

add(S('stats', 'Bot resource and cache statistics.'), {}, async i => {
  await ack(i);
  await done(i, { embeds: [await statsEmbed(i.client)], components: [refreshRow(i.user.id)] });
});

add(S('errors', 'Recent errors and crashes.')
  .addSubcommand(s => s.setName('view').setDescription('Browse recent errors.').addStringOption(o => o.setName('command').setDescription('Filter by command name')))
  .addSubcommand(s => s.setName('clear').setDescription('Delete logged errors.').addStringOption(o => o.setName('command').setDescription('Only this command'))), {}, async i => {
  const command = (i.options.getString('command') || '').replace(/^\//, '').trim() || null;
  if (i.options.getSubcommand() === 'clear') {
    const n = db.listErrors(command).length;
    if (!n) return h.safeReply(i, { embeds: [h.infoEmbed('Nothing to clear', 'The error log is already empty.')], ephemeral: true });
    return confirmFlow(i, { title: 'Clear error log?', description: `Delete **${n}** logged error(s)${command ? ` for \`${command}\`` : ''}.`, yes: 'Clear', run: async () => `Deleted ${db.clearErrors(command)} error(s).` });
  }
  const token = randomBytes(5).toString('hex'); errSessions.set(token, { userId: i.user.id, command, index: 0 }); setTimeout(() => errSessions.delete(token), 600000).unref?.();
  await h.safeReply(i, { ...errPayload(token), ephemeral: true });
});

add(S('commandstats', 'Command usage statistics.')
  .addStringOption(o => o.setName('range').setDescription('Time range (default all-time)').addChoices({ name: 'today', value: 'today' }, { name: 'week', value: 'week' }, { name: 'all-time', value: 'all' }))
  .addBooleanOption(o => o.setName('this_server').setDescription('Only this server')), {}, async i => {
  const range = i.options.getString('range') || 'all'; const guildOnly = !!i.options.getBoolean('this_server') && i.guildId;
  const rows = db.commandUsage({ range, guildId: guildOnly ? i.guildId : null });
  const lines = rows.map((r, k) => { const n = r.ok + r.fail; return `**${k + 1}. /${r.name}** — ${n} uses • ${n ? ((r.fail / n) * 100).toFixed(1) : '0.0'}% failed • <t:${Math.floor(r.lastUsed / 1000)}:R>`; });
  await h.paginate(i, h.listPages({ title: `📈 Command stats — ${range === 'all' ? 'all-time' : range}${guildOnly ? ' (this server)' : ''}`, lines, emptyHint: 'No commands have been used in this range.' }), { ephemeral: true });
});

const PROTECTED = () => new Set(['help', 'commandtoggle', ...ctx.commands.filter(c => c.ownerOnly).map(c => c.data.name)]);
const CONFIRM_FIRST = new Set(['setup', 'ban', 'kick', 'timeout', 'untimeout', 'purge', 'role', 'lock', 'unlock', 'ticketpanel', 'giveaway', 'warn']);
function resolveCommandName(input) {
  const n = String(input || '').toLowerCase().replace(/^\//, '').trim();
  const real = ctx.aliases.get(n) || n;
  return ctx.commands.find(c => c.data.name === real)?.data.name || null;
}
add(S('commandtoggle', 'Globally enable/disable a command.')
  .addSubcommand(s => s.setName('toggle').setDescription('Flip a command on/off.').addStringOption(o => o.setName('name').setDescription('Command name or alias').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason shown to users')))
  .addSubcommand(s => s.setName('list').setDescription('Show disabled commands.')), {}, async i => {
  if (i.options.getSubcommand() === 'list') {
    const lines = db.listToggles().map(t => `**/${t.name}** — ${t.reason || 'no reason'} • by <@${t.byId}> • <t:${Math.floor(t.at / 1000)}:R>`);
    return h.paginate(i, h.listPages({ title: '🚫 Disabled commands', lines, emptyHint: 'Every command is enabled.' }), { ephemeral: true });
  }
  const name = resolveCommandName(i.options.getString('name'));
  if (!name) return h.safeReply(i, { embeds: [h.errorEmbed('Unknown command', `No command or alias called \`${i.options.getString('name')}\`.`)], ephemeral: true });
  if (PROTECTED().has(name)) return h.safeReply(i, { embeds: [h.errorEmbed('Protected command', `\`/${name}\` is a core command and cannot be disabled.`)], ephemeral: true });
  const reason = (i.options.getString('reason') || '').slice(0, 200) || null;
  const was = db.getToggle(name);
  const apply = async () => { if (was) { db.removeToggle(name); return `\`/${name}\` is **enabled** again.`; } db.setToggle(name, reason, i.user.id); return `\`/${name}\` is now **disabled**${reason ? ` — ${reason}` : ''}.`; };
  if (!was && (CONFIRM_FIRST.has(name) || /setup$/.test(name))) return confirmFlow(i, { title: `Disable /${name}?`, description: 'This is a core command. It will be disabled for everyone until re-enabled.', yes: 'Disable', run: apply });
  await h.safeReply(i, { embeds: [h.successEmbed('Command updated', await apply())], ephemeral: true });
});

const HELP = {
  access: ['🔑 Owners & access', '`/owneradd` `/ownerremove` — manage co-owners (main owner only)\n`/owners` — list owners'],
  data: ['🗄️ Database', '`/backup` — DM a backup\n`/restore` — restore (main owner)\n`/resetguild` — wipe a server (main owner)\n`/dbstats` `/cleanup` `/export`'],
  monitor: ['📊 Monitoring', '`/stats` — resources & caches\n`/errors view|clear` — crash log\n`/commandstats` — usage & failure rates'],
  commands: ['🧰 Commands', '`/commandtoggle toggle|list` — globally disable commands\n`/ownerhelp` — this menu']
};
add(S('ownerhelp', 'Owner command reference.'), {}, async i => {
  const render = key => ({ embeds: [ui.base(HELP[key][0]).setDescription(HELP[key][1])], components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`own-help:${i.user.id}`).setPlaceholder('Choose a category…').addOptions(Object.entries(HELP).map(([v, x]) => ({ label: x[0].replace(/^\S+\s/, ''), value: v, emoji: x[0].split(' ')[0], default: v === key })))) ] });
  await h.safeReply(i, { ...render('access'), ephemeral: true });
});

// ---------------------------------------------------------------------------------
// Router (returns true when handled)
// ---------------------------------------------------------------------------------
async function handleInteraction(i) {
  const id = i.customId;
  if (!id || !/^own-(c|stats|e|help)[:]/.test(id)) return false;
  try {
    if (!isOwner(i.user.id)) { await i.reply({ embeds: [h.errorEmbed('Owner only', 'This command is owner-only.')], ephemeral: true }); return true; }
    if (id.startsWith('own-c:')) await handleConfirm(i);
    else if (id.startsWith('own-e:')) await handleErrorButton(i);
    else if (id.startsWith('own-stats:')) { if (!await h.authorOnly(i, id.split(':')[1])) return true; await i.deferUpdate(); await i.editReply({ embeds: [await statsEmbed(i.client)], components: [refreshRow(i.user.id)] }); }
    else if (id.startsWith('own-help:')) {
      if (!await h.authorOnly(i, id.split(':')[1])) return true;
      const key = i.values[0];
      await i.update({ embeds: [ui.base(HELP[key][0]).setDescription(HELP[key][1])], components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`own-help:${i.user.id}`).setPlaceholder('Choose a category…').addOptions(Object.entries(HELP).map(([v, x]) => ({ label: x[0].replace(/^\S+\s/, ''), value: v, emoji: x[0].split(' ')[0], default: v === key }))))] });
    }
  } catch (e) { console.error('[Owner] component failed:', e); await h.safeReply(i, { embeds: [h.errorEmbed('Owner error', String(e?.message || e).slice(0, 1000))], ephemeral: true }); }
  return true;
}

module.exports = { _t: { countGuild, deleteGuildData, restoreFrom, exportGuild, guildIdsWithData, snapshot }, commands, init, isOwner, isMainOwner, isCoOwner, handleInteraction, recordError, trackCommand, disabledInfo };
