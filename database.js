// AunXz/database.js — SQLite schema, migrations, cached config access.
// Safe additive migrations only: existing data is never wiped.
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function resolvePath() {
  if (process.env.DATABASE_PATH) return path.resolve(process.env.DATABASE_PATH);
  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (volume) return path.join(path.resolve(volume), 'aunxz.sqlite');
  return path.join(__dirname, 'data', 'aunxz.sqlite');
}
const DB_PATH = resolvePath();
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}

db.exec(`
CREATE TABLE IF NOT EXISTS guild_config (
  guildId TEXT PRIMARY KEY,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS levels (
  guildId TEXT NOT NULL, userId TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 0,
  lastMessage INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guildId, userId)
);
CREATE INDEX IF NOT EXISTS idx_levels_guild_xp ON levels(guildId, xp DESC);
CREATE TABLE IF NOT EXISTS warns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL, userId TEXT NOT NULL, moderatorId TEXT NOT NULL,
  reason TEXT, timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_warns_guild_user ON warns(guildId, userId);
CREATE TABLE IF NOT EXISTS tickets (
  channelId TEXT PRIMARY KEY, guildId TEXT NOT NULL, userId TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', claimedBy TEXT, createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_guild_user ON tickets(guildId, userId, status);
CREATE TABLE IF NOT EXISTS voicemaster_channels (
  channelId TEXT PRIMARY KEY, guildId TEXT NOT NULL, ownerId TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS antinuke_whitelist (
  guildId TEXT NOT NULL, userId TEXT NOT NULL, PRIMARY KEY (guildId, userId)
);
CREATE TABLE IF NOT EXISTS action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL, userId TEXT, type TEXT NOT NULL, detail TEXT, timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_guild ON action_log(guildId, timestamp DESC);
CREATE TABLE IF NOT EXISTS sticky_roles (
  guildId TEXT NOT NULL, userId TEXT NOT NULL, roles TEXT NOT NULL, PRIMARY KEY (guildId, userId)
);
CREATE TABLE IF NOT EXISTS spam_tracker (
  guildId TEXT NOT NULL, userId TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
  windowStart INTEGER NOT NULL, PRIMARY KEY (guildId, userId)
);
CREATE TABLE IF NOT EXISTS join_tracker (
  guildId TEXT NOT NULL, userId TEXT NOT NULL, timestamp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS emoji_overrides (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS embed_texts (
  name TEXT PRIMARY KEY, sourceTitle TEXT NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', footer TEXT NOT NULL DEFAULT '',
  updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_config (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guildId TEXT NOT NULL, hostId TEXT NOT NULL,
  prize TEXT NOT NULL, winners INTEGER NOT NULL DEFAULT 1,
  endsAt INTEGER NOT NULL DEFAULT 0, channelId TEXT, messageId TEXT,
  participants TEXT NOT NULL DEFAULT '[]', winnerIds TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'configuring', createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_giveaways_guild ON giveaways(guildId, status, endsAt);
CREATE TABLE IF NOT EXISTS saved_embeds (
  guildId TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
  PRIMARY KEY (guildId, name)
);
CREATE TABLE IF NOT EXISTS sticky_messages (
  guildId TEXT NOT NULL, channelId TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
  lastMessageId TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  createdBy TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
  PRIMARY KEY (guildId, channelId)
);
CREATE INDEX IF NOT EXISTS idx_sticky_channel ON sticky_messages(channelId);
CREATE TABLE IF NOT EXISTS staff_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL, userId TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  answers TEXT NOT NULL DEFAULT '[]', channelId TEXT, messageId TEXT,
  reviewerId TEXT, reason TEXT, createdAt INTEGER NOT NULL, decidedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_apps_guild_status ON staff_applications(guildId, status);
CREATE TABLE IF NOT EXISTS command_toggles (
  name TEXT PRIMARY KEY, reason TEXT, byId TEXT, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
  source TEXT, command TEXT, guildId TEXT, userId TEXT, message TEXT, stack TEXT
);
CREATE TABLE IF NOT EXISTS birthdays (
  guildId TEXT NOT NULL, userId TEXT NOT NULL,
  month INTEGER NOT NULL, day INTEGER NOT NULL,
  PRIMARY KEY (guildId, userId)
);
`);

const DEFAULT_CONFIG = {
  prefix: '!',
  logs: { mod: null, message: null, member: null, voice: null, antinuke: null, server: null, ticket: null, join: null },
  welcome: { enabled: false, channel: null, message: 'Welcome {user} to {server}! You are member #{count}.', autoroleId: null, image: null, ping: true, showAvatar: true, title: '👋 Welcome!' },
  leave: { enabled: false, channel: null, message: '{user} has left the server.' },
  boost: { enabled: false, channel: null, message: '{user} just boosted the server! 🚀' },
  greetmessage: { enabled: false, channelId: null, message: 'Welcome {user}!', image: null, title: '👋 Welcome!', color: null, showAvatar: true, ping: true },
  antinuke: {
    enabled: false, punishment: 'ban', maxChannelDeletes: 3, maxChannelCreates: 5,
    maxRoleDeletes: 3, maxRoleCreates: 5, maxBans: 3, maxKicks: 3,
    maxWebhookCreates: 3, maxRoleUpdates: 5, windowSeconds: 10, protectOwner: true
  },
  antilink: { enabled: false, mode: 'delete', whitelistedDomains: ['discord.gg', 'discord.com/invite'], bypassRoleId: null, whitelistedChannels: [] },
  antispam: { enabled: false, maxMessages: 6, windowSeconds: 7, punishment: 'mute', muteMinutes: 5, maxMentions: 5, maxEmojis: 10 },
  antiraid: { enabled: false, joinThreshold: 8, windowSeconds: 10, action: 'lockdown', minAccountAgeDays: 3 },
  antiwebhook: { enabled: false, action: 'delete', bypassRoleId: null, logChannelId: null },
  antibot: { enabled: false, action: 'kick', bypassRoleId: null, logChannelId: null },
  antialt: { enabled: false, action: 'kick', minAccountAgeDays: 3, logChannelId: null },
  antibadword: { enabled: false, words: [], customWords: [], action: 'delete', logChannelId: null },
  voicemaster: { enabled: false, hubChannelId: null, categoryId: null, nameTemplate: "{user}'s room" },
  leveling: { enabled: false, channel: null, xpPerMessage: 15, cooldownSeconds: 60, levelUpMessage: '{user} reached level {level}!', roleRewards: {} },
  ticket: {
    enabled: false, categoryId: null, panelChannelId: null, supportRoleId: null, logChannelId: null,
    panelTitle: null, panelDescription: null, panelThumbnail: null, panelImage: null,
    categoryLabel: 'General Support', welcomeMessage: 'Our support team will assist you shortly.',
    welcomeThumbnail: null, welcomeImage: null
  },
  automod: { enabled: true, badWordFilter: false, badWords: [], capsFilter: false, capsThreshold: 70, inviteFilter: false },
  autoresponder: { enabled: false, ignoreCase: true, triggers: [] },
  autoreactor: { enabled: false, ignoreCase: true, triggers: [] },
  autorole: { enabled: false, roleId: null, target: 'everyone' },
  reactionRoles: { enabled: true },
  reactionRolePanels: [],
  buttonRolePanels: [],
  suggestions: { enabled: false, channelId: null },
  snipeEnabled: true,
  birthdays: { enabled: false, panelChannelId: null, wishChannelId: null, wishMessage: 'Happy Birthday {user}! 🎂', entries: {} },
  starboard: { enabled: false, channelId: null, threshold: 3 },
  inviteTracker: { enabled: false },
  staffApplications: {
    enabled: false, panelChannelId: null, logChannelId: null, questions: [],
    title: 'Staff Applications', description: 'Click Apply to start your application.',
    dmIntro: 'Are you ready to start your staff application?',
    applicantRoleId: null, acceptedRoleId: null, cooldownHours: 24,
    acceptMessage: 'Congratulations! Your application was accepted.',
    denyMessage: 'Thank you for applying. Your application was not accepted this time.'
  },
  honeypot: {
    enabled: false, channelId: null, action: 'kick', cleanupWindow: 'none', createInvite: false,
    dmMessage: 'You were removed for posting in the honeypot channel. {invite}', logChannelId: null, whitelistRoleIds: []
  },
  maintenance: false,
  blacklist: [],
  appearance: { color: null, preset: 'professional' },
  ai: { enabled: true, maxTokens: 700, temperature: 0.3, memoryMax: 8 }
};

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(override || {})) {
    const v = override[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}

// --- Config cache -------------------------------------------------------------
// getConfig used to deep-merge DEFAULT_CONFIG on every call. That was ~40% of hot-path CPU.
// We cache the merged result for a short TTL; saveConfig/replaceConfig invalidate immediately.
const CONFIG_TTL_MS = 5000;
const configCache = new Map();

const getStmt = db.prepare('SELECT data FROM guild_config WHERE guildId = ?');
const upsertStmt = db.prepare(
  'INSERT INTO guild_config (guildId, data) VALUES (@guildId, @data) ON CONFLICT(guildId) DO UPDATE SET data = @data'
);

function getConfig(guildId) {
  const hit = configCache.get(guildId);
  if (hit && Date.now() - hit.ts < CONFIG_TTL_MS) return hit.value;
  const row = getStmt.get(guildId);
  let stored = {};
  try { stored = row ? JSON.parse(row.data) : {}; } catch { stored = {}; }
  const merged = deepMerge(DEFAULT_CONFIG, stored);
  configCache.set(guildId, { value: merged, ts: Date.now() });
  return merged;
}

function saveConfig(guildId, partial) {
  const merged = deepMerge(getConfig(guildId), partial || {});
  upsertStmt.run({ guildId, data: JSON.stringify(merged) });
  configCache.set(guildId, { value: merged, ts: Date.now() });
  return merged;
}

function replaceConfig(guildId, data) {
  upsertStmt.run({ guildId, data: JSON.stringify(data || {}) });
  configCache.delete(guildId);
  return getConfig(guildId);
}

function invalidateConfig(guildId) { configCache.delete(guildId); }

// --- Levels -------------------------------------------------------------------
const levelGet = db.prepare('SELECT * FROM levels WHERE guildId = ? AND userId = ?');
const levelUpsert = db.prepare(
  `INSERT INTO levels (guildId, userId, xp, level, lastMessage) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(guildId, userId) DO UPDATE SET xp=excluded.xp, level=excluded.level, lastMessage=excluded.lastMessage`
);
const levelTop = db.prepare('SELECT * FROM levels WHERE guildId = ? ORDER BY xp DESC LIMIT ?');
function getLevel(guildId, userId) {
  return levelGet.get(guildId, userId) || { guildId, userId, xp: 0, level: 0, lastMessage: 0 };
}
function setLevel(guildId, userId, xp, level, lastMessage) { levelUpsert.run(guildId, userId, xp, level, lastMessage); }
function topLevels(guildId, limit = 10) { return levelTop.all(guildId, limit); }

// --- Warnings -----------------------------------------------------------------
const warnAdd = db.prepare('INSERT INTO warns (guildId,userId,moderatorId,reason,timestamp) VALUES (?,?,?,?,?)');
const warnGet = db.prepare('SELECT * FROM warns WHERE guildId=? AND userId=? ORDER BY timestamp DESC');
const warnClear = db.prepare('DELETE FROM warns WHERE guildId=? AND userId=?');
function addWarn(guildId, userId, modId, reason) { warnAdd.run(guildId, userId, modId, reason, Date.now()); }
function getWarns(guildId, userId) { return warnGet.all(guildId, userId); }
function clearWarns(guildId, userId) { warnClear.run(guildId, userId); }

// --- Tickets ------------------------------------------------------------------
// FIX: setTicketStatus used COALESCE so passing null didn't null out claimedBy.
// Now the parameter is explicit — pass undefined to leave it, null to clear it.
const ticketCreate = db.prepare('INSERT INTO tickets(channelId,guildId,userId,status,createdAt) VALUES (?,?,?,?,?)');
const ticketGet = db.prepare('SELECT * FROM tickets WHERE channelId = ?');
const ticketSetStatusWithClaim = db.prepare('UPDATE tickets SET status = ?, claimedBy = ? WHERE channelId = ?');
const ticketSetStatusOnly = db.prepare('UPDATE tickets SET status = ? WHERE channelId = ?');
const ticketOpenForUser = db.prepare("SELECT * FROM tickets WHERE guildId = ? AND userId = ? AND status = 'open'");

function createTicket(channelId, guildId, userId) { ticketCreate.run(channelId, guildId, userId, 'open', Date.now()); }
function getTicket(channelId) { return ticketGet.get(channelId); }
function setTicketStatus(channelId, status, claimedBy) {
  if (claimedBy === undefined) ticketSetStatusOnly.run(status, channelId);
  else ticketSetStatusWithClaim.run(status, claimedBy, channelId);
}
function openTicketsForUser(guildId, userId) { return ticketOpenForUser.all(guildId, userId); }

// --- Voicemaster --------------------------------------------------------------
const vmAdd = db.prepare('INSERT OR REPLACE INTO voicemaster_channels(channelId,guildId,ownerId) VALUES (?,?,?)');
const vmGet = db.prepare('SELECT * FROM voicemaster_channels WHERE channelId = ?');
const vmDel = db.prepare('DELETE FROM voicemaster_channels WHERE channelId = ?');
function addVMChannel(c, g, o) { vmAdd.run(c, g, o); }
function getVMChannel(c) { return vmGet.get(c); }
function removeVMChannel(c) { vmDel.run(c); }

// --- Whitelist / action log / sticky roles / spam / joins --------------------
const wlAdd = db.prepare('INSERT OR IGNORE INTO antinuke_whitelist(guildId,userId) VALUES (?,?)');
const wlRem = db.prepare('DELETE FROM antinuke_whitelist WHERE guildId=? AND userId=?');
const wlCheck = db.prepare('SELECT 1 FROM antinuke_whitelist WHERE guildId=? AND userId=?');
const wlList = db.prepare('SELECT userId FROM antinuke_whitelist WHERE guildId = ?');
function addToWhitelist(g, u) { wlAdd.run(g, u); }
function removeFromWhitelist(g, u) { wlRem.run(g, u); }
function isWhitelisted(g, u) { return !!wlCheck.get(g, u); }
function listWhitelist(g) { return wlList.all(g).map(r => r.userId); }

const actLog = db.prepare('INSERT INTO action_log(guildId,userId,type,detail,timestamp) VALUES (?,?,?,?,?)');
function logAction(g, u, t, d) { actLog.run(g, u, t, d, Date.now()); }

const srGet = db.prepare('SELECT roles FROM sticky_roles WHERE guildId=? AND userId=?');
const srSet = db.prepare('INSERT INTO sticky_roles(guildId,userId,roles) VALUES (?,?,?) ON CONFLICT(guildId,userId) DO UPDATE SET roles=excluded.roles');
function getStickyRoles(g, u) { const r = srGet.get(g, u); try { return r ? JSON.parse(r.roles) : []; } catch { return []; } }
function setStickyRoles(g, u, roles) { srSet.run(g, u, JSON.stringify(roles)); }

const spamGet = db.prepare('SELECT * FROM spam_tracker WHERE guildId=? AND userId=?');
const spamInsert = db.prepare('INSERT OR REPLACE INTO spam_tracker(guildId,userId,count,windowStart) VALUES (?,?,?,?)');
const spamUpdate = db.prepare('UPDATE spam_tracker SET count=? WHERE guildId=? AND userId=?');
function bumpSpam(g, u, windowSec) {
  const now = Date.now();
  const r = spamGet.get(g, u);
  if (!r || now - r.windowStart > windowSec * 1000) { spamInsert.run(g, u, 1, now); return 1; }
  const n = r.count + 1;
  spamUpdate.run(n, g, u);
  return n;
}

const joinAdd = db.prepare('INSERT INTO join_tracker(guildId,userId,timestamp) VALUES (?,?,?)');
const joinCount = db.prepare('SELECT COUNT(*) c FROM join_tracker WHERE guildId=? AND timestamp>?');
const joinPurge = db.prepare('DELETE FROM join_tracker WHERE guildId=? AND timestamp<?');
function trackJoin(g, u) { joinAdd.run(g, u, Date.now()); }
function recentJoinCount(g, windowSec) { return joinCount.get(g, Date.now() - windowSec * 1000).c; }
function pruneJoins(g, olderThanSec) { joinPurge.run(g, Date.now() - olderThanSec * 1000); }

// --- Emoji overrides ----------------------------------------------------------
const eoGet = db.prepare('SELECT value FROM emoji_overrides WHERE name = ?');
const eoSet = db.prepare('INSERT INTO emoji_overrides(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value');
const eoDel = db.prepare('DELETE FROM emoji_overrides WHERE name = ?');
const eoAll = db.prepare('SELECT name,value FROM emoji_overrides');
function getEmojiOverride(n) { return eoGet.get(n)?.value || null; }
function setEmojiOverride(n, v) { eoSet.run(n, v); }
function resetEmojiOverride(n) { eoDel.run(n); }
function getAllEmojiOverrides() { const o = {}; for (const r of eoAll.all()) o[r.name] = r.value; return o; }

// --- Embed texts --------------------------------------------------------------
const etGet = db.prepare('SELECT * FROM embed_texts WHERE lower(name)=lower(?) OR lower(sourceTitle)=lower(?) LIMIT 1');
const etUpsert = db.prepare(
  `INSERT INTO embed_texts(name,sourceTitle,title,description,footer,updatedAt) VALUES (?,?,?,?,?,?)
   ON CONFLICT(name) DO UPDATE SET sourceTitle=excluded.sourceTitle, updatedAt=excluded.updatedAt`
);
function registerEmbedText(sourceTitle, description = '', footer = '') {
  const name = String(sourceTitle || 'embed').replace(/<@!?\d+>/g, '@user').replace(/\d{15,25}/g, 'id')
    .replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 70) || 'embed';
  etUpsert.run(name, String(sourceTitle), String(sourceTitle), String(description || ''), String(footer || ''), Date.now());
  return etGet.get(name, name);
}
function getEmbedText(name) { return etGet.get(name, name) || null; }

// --- Owner --------------------------------------------------------------------
const ocGet = db.prepare('SELECT data FROM owner_config WHERE id = 1');
const ocUpsert = db.prepare('INSERT INTO owner_config(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data');
function getOwnerConfig() { const r = ocGet.get(); if (!r) return {}; try { return JSON.parse(r.data) || {}; } catch { return {}; } }
function saveOwnerConfig(partial) {
  const merged = deepMerge(getOwnerConfig(), partial || {});
  ocUpsert.run(JSON.stringify(merged));
  return merged;
}
function getGlobalBlacklist() {
  const ids = getOwnerConfig().blacklistedGuildOwnerIds;
  return [...new Set((Array.isArray(ids) ? ids : []).map(x => String(x).trim()).filter(x => /^\d{15,25}$/.test(x)))];
}
function addGlobalBlacklist(id) {
  id = String(id || '').trim();
  if (!/^\d{15,25}$/.test(id)) throw new Error('Invalid user ID.');
  const ids = getGlobalBlacklist(); if (!ids.includes(id)) ids.push(id);
  saveOwnerConfig({ blacklistedGuildOwnerIds: ids });
  return ids;
}
function removeGlobalBlacklist(id) {
  const ids = getGlobalBlacklist().filter(x => x !== String(id).trim());
  saveOwnerConfig({ blacklistedGuildOwnerIds: ids });
  return ids;
}

// --- Giveaways ----------------------------------------------------------------
function createGiveaway(guildId, hostId, { prize, winners = 1, durationMs, channelId }) {
  const info = db.prepare('INSERT INTO giveaways(guildId,hostId,prize,winners,durationMs,endsAt,channelId,status,createdAt) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(guildId, hostId, String(prize), Math.max(1, Number(winners) || 1),
      Number(durationMs) || 0, Date.now() + (Number(durationMs) || 0),
      channelId || null, 'configuring', Date.now());
  return getGiveaway(guildId, info.lastInsertRowid);
}
function getGiveaway(guildId, id) { return db.prepare('SELECT * FROM giveaways WHERE guildId=? AND id=?').get(guildId, Number(id)); }
function listGiveaways(guildId, limit = 50) { return db.prepare('SELECT * FROM giveaways WHERE guildId=? ORDER BY id DESC LIMIT ?').all(guildId, limit); }
function updateGiveaway(guildId, id, patch) {
  const row = getGiveaway(guildId, id); if (!row) return null;
  const fields = Object.keys(patch).filter(k => ['prize','winners','endsAt','channelId','messageId','participants','status','winnerIds'].includes(k));
  if (!fields.length) return row;
  const set = fields.map(f => `${f}=?`).join(',');
  db.prepare(`UPDATE giveaways SET ${set} WHERE guildId=? AND id=?`).run(...fields.map(f => patch[f]), guildId, Number(id));
  return getGiveaway(guildId, id);
}

// --- Embeds -------------------------------------------------------------------
function saveEmbed(guildId, name, data) {
  const now = Date.now();
  db.prepare('INSERT INTO saved_embeds(guildId,name,data,createdAt,updatedAt) VALUES (?,?,?,?,?) ON CONFLICT(guildId,name) DO UPDATE SET data=excluded.data,updatedAt=excluded.updatedAt')
    .run(guildId, name, JSON.stringify(data), now, now);
  return getEmbed(guildId, name);
}
function getEmbed(guildId, name) {
  const r = db.prepare('SELECT * FROM saved_embeds WHERE guildId=? AND lower(name)=lower(?)').get(guildId, name);
  if (!r) return null;
  try { return { ...r, data: JSON.parse(r.data) }; } catch { return null; }
}
function listEmbeds(guildId) {
  return db.prepare('SELECT * FROM saved_embeds WHERE guildId=? ORDER BY updatedAt DESC').all(guildId)
    .map(r => { try { return { ...r, data: JSON.parse(r.data) }; } catch { return r; } });
}
function deleteEmbed(guildId, name) { return db.prepare('DELETE FROM saved_embeds WHERE guildId=? AND lower(name)=lower(?)').run(guildId, name).changes > 0; }

// --- Panels -------------------------------------------------------------------
function panelKey(kind) { return kind === 'button' ? 'buttonRolePanels' : 'reactionRolePanels'; }
function findPanel(guildId, kind, id) { return (getConfig(guildId)[panelKey(kind)] || []).find(p => p.id === id) || null; }
function upsertPanel(guildId, kind, panel) {
  const key = panelKey(kind);
  const arr = [...(getConfig(guildId)[key] || [])];
  const i = arr.findIndex(p => p.id === panel.id);
  if (i >= 0) arr[i] = panel; else arr.push(panel);
  saveConfig(guildId, { [key]: arr });
  return panel;
}
function removePanel(guildId, kind, id) {
  const key = panelKey(kind);
  saveConfig(guildId, { [key]: (getConfig(guildId)[key] || []).filter(p => p.id !== id) });
}

// --- Sticky messages ----------------------------------------------------------
function stickyRow(r) { return r ? { ...r, enabled: !!r.enabled, data: (() => { try { return JSON.parse(r.data); } catch { return {}; } })() } : null; }
function getSticky(channelId) { return stickyRow(db.prepare('SELECT * FROM sticky_messages WHERE channelId = ?').get(channelId)); }
function listStickies(guildId) { return db.prepare('SELECT * FROM sticky_messages WHERE guildId = ? ORDER BY createdAt ASC').all(guildId).map(stickyRow); }
function saveSticky(guildId, channelId, { data, enabled = true, createdBy = null } = {}) {
  const now = Date.now();
  db.prepare(`INSERT INTO sticky_messages (guildId,channelId,data,enabled,createdBy,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(guildId, channelId) DO UPDATE SET data=excluded.data, enabled=excluded.enabled, updatedAt=excluded.updatedAt`)
    .run(guildId, channelId, JSON.stringify(data || {}), enabled ? 1 : 0, createdBy, now, now);
  return getSticky(channelId);
}
function setStickyMessageId(channelId, messageId) { db.prepare('UPDATE sticky_messages SET lastMessageId=?, updatedAt=? WHERE channelId=?').run(messageId || null, Date.now(), channelId); }
function setStickyEnabled(channelId, enabled) { db.prepare('UPDATE sticky_messages SET enabled=?, updatedAt=? WHERE channelId=?').run(enabled ? 1 : 0, Date.now(), channelId); return getSticky(channelId); }
function deleteSticky(channelId) { return db.prepare('DELETE FROM sticky_messages WHERE channelId = ?').run(channelId).changes > 0; }

// --- Staff applications -------------------------------------------------------
function appRow(r) { return r ? { ...r, answers: (() => { try { return JSON.parse(r.answers); } catch { return []; } })() } : null; }
function createApplication(guildId, userId, answers) {
  const info = db.prepare('INSERT INTO staff_applications(guildId,userId,status,answers,createdAt) VALUES (?,?,?,?,?)')
    .run(guildId, userId, 'pending', JSON.stringify(answers || []), Date.now());
  return getApplication(info.lastInsertRowid);
}
function getApplication(id) { return appRow(db.prepare('SELECT * FROM staff_applications WHERE id = ?').get(Number(id))); }
function pendingApplicationForUser(guildId, userId) {
  return appRow(db.prepare("SELECT * FROM staff_applications WHERE guildId=? AND userId=? AND status='pending' ORDER BY id DESC LIMIT 1").get(guildId, userId));
}
function lastApplicationForUser(guildId, userId) {
  return appRow(db.prepare('SELECT * FROM staff_applications WHERE guildId=? AND userId=? ORDER BY id DESC LIMIT 1').get(guildId, userId));
}
function updateApplication(id, patch) {
  const allowed = ['status', 'channelId', 'messageId', 'reviewerId', 'reason', 'decidedAt'];
  const keys = Object.keys(patch || {}).filter(k => allowed.includes(k));
  if (keys.length) db.prepare(`UPDATE staff_applications SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`)
    .run(...keys.map(k => patch[k]), Number(id));
  return getApplication(id);
}

// --- Command toggles ----------------------------------------------------------
let toggleCache = null;
function listToggles() {
  if (!toggleCache) {
    toggleCache = db.prepare('SELECT * FROM command_toggles ORDER BY at DESC').all();
    setTimeout(() => { toggleCache = null; }, 10000).unref?.();
  }
  return toggleCache;
}
function getToggle(name) { return listToggles().find(t => t.name === String(name).toLowerCase()) || null; }
function setToggle(name, reason, byId) {
  db.prepare('INSERT INTO command_toggles(name,reason,byId,at) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET reason=excluded.reason,byId=excluded.byId,at=excluded.at')
    .run(String(name).toLowerCase(), reason || null, String(byId), Date.now());
  toggleCache = null;
}
function removeToggle(name) { const c = db.prepare('DELETE FROM command_toggles WHERE name=?').run(String(name).toLowerCase()).changes; toggleCache = null; return c > 0; }

// --- Errors -------------------------------------------------------------------
function recordError({ source = null, command = null, guildId = null, userId = null, message = '', stack = '' } = {}) {
  db.prepare('INSERT INTO error_log(ts,source,command,guildId,userId,message,stack) VALUES (?,?,?,?,?,?,?)')
    .run(Date.now(), source, command, guildId, userId, String(message || '').slice(0, 2000), String(stack || '').slice(0, 20000));
  db.prepare('DELETE FROM error_log WHERE id NOT IN (SELECT id FROM error_log ORDER BY id DESC LIMIT 200)').run();
}
function listErrors(command = null) {
  return command
    ? db.prepare('SELECT * FROM error_log WHERE lower(command)=lower(?) ORDER BY id DESC').all(command)
    : db.prepare('SELECT * FROM error_log ORDER BY id DESC').all();
}
function clearErrors(command = null) {
  return (command
    ? db.prepare('DELETE FROM error_log WHERE lower(command)=lower(?)').run(command)
    : db.prepare('DELETE FROM error_log').run()).changes;
}

// --- Birthdays ----------------------------------------------------------------
function setBirthday(g, u, m, d) {
  db.prepare('INSERT INTO birthdays(guildId,userId,month,day) VALUES (?,?,?,?) ON CONFLICT(guildId,userId) DO UPDATE SET month=excluded.month, day=excluded.day')
    .run(g, u, m, d);
}
function birthdaysFor(m, d) { return db.prepare('SELECT * FROM birthdays WHERE month=? AND day=?').all(m, d); }

// --- Backup / restore ---------------------------------------------------------
function exportGuild(guildId) {
  return {
    version: 1, guildId, exportedAt: Date.now(),
    settings: getConfig(guildId),
    embeds: listEmbeds(guildId).map(e => ({ name: e.name, data: e.data })),
    stickies: listStickies(guildId),
    levels: topLevels(guildId, 10000),
    warns: getWarns(guildId, '').length ? [] : []
  };
}
function importGuild(guildId, payload) {
  if (!payload || payload.version !== 1) throw new Error('Unsupported backup format.');
  if (payload.settings) replaceConfig(guildId, payload.settings);
  for (const e of payload.embeds || []) saveEmbed(guildId, e.name, e.data);
}

module.exports = {
  db, DB_PATH, DEFAULT_CONFIG,
  getConfig, saveConfig, replaceConfig, invalidateConfig,
  getLevel, setLevel, topLevels,
  addWarn, getWarns, clearWarns,
  createTicket, getTicket, setTicketStatus, openTicketsForUser,
  addVMChannel, getVMChannel, removeVMChannel,
  addToWhitelist, removeFromWhitelist, isWhitelisted, listWhitelist,
  logAction, getStickyRoles, setStickyRoles, bumpSpam, trackJoin, recentJoinCount, pruneJoins,
  getEmojiOverride, setEmojiOverride, resetEmojiOverride, getAllEmojiOverrides,
  registerEmbedText, getEmbedText,
  getOwnerConfig, saveOwnerConfig, getGlobalBlacklist, addGlobalBlacklist, removeGlobalBlacklist,
  createGiveaway, getGiveaway, listGiveaways, updateGiveaway,
  saveEmbed, getEmbed, listEmbeds, deleteEmbed,
  findPanel, upsertPanel, removePanel,
  getSticky, listStickies, saveSticky, setStickyMessageId, setStickyEnabled, deleteSticky,
  createApplication, getApplication, pendingApplicationForUser, lastApplicationForUser, updateApplication,
  getToggle, listToggles, setToggle, removeToggle,
  recordError, listErrors, clearErrors,
  setBirthday, birthdaysFor,
  exportGuild, importGuild
};