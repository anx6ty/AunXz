// AunXz/database.js — SQLite schema, additive migrations, cached config access.
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
CREATE TABLE IF NOT EXISTS guild_config (guildId TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS levels (
  guildId TEXT NOT NULL, userId TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 0,
  lastMessage INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guildId, userId)
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
  status TEXT NOT NULL DEFAULT 'open', claimedBy TEXT,
  type TEXT NOT NULL DEFAULT 'general', priority TEXT NOT NULL DEFAULT 'normal',
  closedBy TEXT, closeReason TEXT, lastActivityAt INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_guild_user ON tickets(guildId, userId, status);
CREATE TABLE IF NOT EXISTS ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL, channelId TEXT NOT NULL, actorId TEXT,
  event TEXT NOT NULL, detail TEXT, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_events ON ticket_events(guildId, channelId, ts DESC);
CREATE TABLE IF NOT EXISTS voicemaster_channels (channelId TEXT PRIMARY KEY, guildId TEXT NOT NULL, ownerId TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS antinuke_whitelist (guildId TEXT NOT NULL, userId TEXT NOT NULL, PRIMARY KEY (guildId, userId));
CREATE TABLE IF NOT EXISTS action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL, userId TEXT, type TEXT NOT NULL, detail TEXT, timestamp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sticky_roles (guildId TEXT NOT NULL, userId TEXT NOT NULL, roles TEXT NOT NULL, PRIMARY KEY (guildId, userId));
CREATE TABLE IF NOT EXISTS spam_tracker (guildId TEXT NOT NULL, userId TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, windowStart INTEGER NOT NULL, PRIMARY KEY (guildId, userId));
CREATE TABLE IF NOT EXISTS join_tracker (guildId TEXT NOT NULL, userId TEXT NOT NULL, timestamp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS emoji_overrides (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS embed_texts (
  name TEXT PRIMARY KEY, sourceTitle TEXT NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', footer TEXT NOT NULL DEFAULT '',
  updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_config (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guildId TEXT NOT NULL, hostId TEXT NOT NULL,
  prize TEXT NOT NULL, winners INTEGER NOT NULL DEFAULT 1, endsAt INTEGER NOT NULL DEFAULT 0,
  channelId TEXT, messageId TEXT, participants TEXT NOT NULL DEFAULT '[]',
  winnerIds TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'configuring', createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_giveaways_guild ON giveaways(guildId, status, endsAt);
CREATE TABLE IF NOT EXISTS saved_embeds (
  guildId TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY (guildId, name)
);
CREATE TABLE IF NOT EXISTS sticky_messages (
  guildId TEXT NOT NULL, channelId TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
  lastMessageId TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  createdBy TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
  PRIMARY KEY (guildId, channelId)
);
CREATE TABLE IF NOT EXISTS staff_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL, userId TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  answers TEXT NOT NULL DEFAULT '[]', channelId TEXT, messageId TEXT,
  reviewerId TEXT, reason TEXT, createdAt INTEGER NOT NULL, decidedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_apps_guild_status ON staff_applications(guildId, status);
CREATE TABLE IF NOT EXISTS command_toggles (name TEXT PRIMARY KEY, reason TEXT, byId TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
  source TEXT, command TEXT, guildId TEXT, userId TEXT, message TEXT, stack TEXT
);
CREATE TABLE IF NOT EXISTS birthdays (
  guildId TEXT NOT NULL, userId TEXT NOT NULL,
  month INTEGER NOT NULL, day INTEGER NOT NULL, PRIMARY KEY (guildId, userId)
);
CREATE TABLE IF NOT EXISTS log_config (
  guildId TEXT NOT NULL, category TEXT NOT NULL,
  channelId TEXT, enabled INTEGER NOT NULL DEFAULT 1, details INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (guildId, category)
);
CREATE TABLE IF NOT EXISTS snipe_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL, channelId TEXT NOT NULL, messageId TEXT NOT NULL,
  authorId TEXT NOT NULL, authorTag TEXT, action TEXT NOT NULL,
  content TEXT, newContent TEXT, attachments TEXT DEFAULT '[]', jumpUrl TEXT, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snipe_lookup ON snipe_entries(guildId, channelId, id DESC);
CREATE TABLE IF NOT EXISTS scheduled_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guildId TEXT NOT NULL, channelId TEXT NOT NULL,
  messageId TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sched_at ON scheduled_events(at);
`);

const DEFAULT_CONFIG = {
  prefix: '!',
  appearance: { color: null, preset: 'black' },
  logs: { default: null, message: null, member: null, mod: null, voice: null, security: null, ticket: null, server: null, system: null },
  welcome: { enabled: false, channel: null, message: 'Welcome {user} to {server}! You are member #{count}.', autoroleId: null, image: null, ping: true, showAvatar: true, title: 'Welcome' },
  leave: { enabled: false, channel: null, message: '{user} has left the server.' },
  boost: { enabled: false, channel: null, message: '{user} just boosted the server!' },
  greetmessage: { enabled: false, channelId: null, message: 'Welcome {user}!', image: null, title: 'Welcome', color: null, showAvatar: true, ping: true },
  antinuke: { enabled: false, punishment: 'ban', maxChannelDeletes: 3, maxChannelCreates: 5, maxRoleDeletes: 3, maxRoleCreates: 5, maxBans: 3, maxKicks: 3, maxWebhookCreates: 3, maxRoleUpdates: 5, windowSeconds: 10, protectOwner: true },
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
    categoryLabel: 'Support', welcomeMessage: 'Our support team will assist you shortly.',
    welcomeThumbnail: null, welcomeImage: null,
    types: [
      { value: 'general', label: 'General Support', emoji: '🎫' },
      { value: 'report', label: 'User Report', emoji: '🚨' },
      { value: 'partnership', label: 'Partnership', emoji: '🤝' },
      { value: 'other', label: 'Other', emoji: '❔' }
    ]
  },
  automod: { enabled: true, badWordFilter: false, badWords: [], capsFilter: false, capsThreshold: 70, inviteFilter: false },
  autoresponder: { enabled: false, ignoreCase: true, triggers: [] },
  autoreactor: { enabled: false, ignoreCase: true, triggers: [] },
  autorole: { enabled: false, roleId: null, target: 'everyone' },
  reactionRoles: { enabled: true },
  reactionRolePanels: [],
  buttonRolePanels: [],
  snipeEnabled: true,
  birthdays: { enabled: false, panelChannelId: null, wishChannelId: null, wishMessage: 'Happy Birthday {user}!', entries: {} },
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

const CONFIG_TTL_MS = 5000;
const configCache = new Map();
const getStmt = db.prepare('SELECT data FROM guild_config WHERE guildId = ?');
const upsertStmt = db.prepare('INSERT INTO guild_config (guildId, data) VALUES (@guildId, @data) ON CONFLICT(guildId) DO UPDATE SET data = @data');

function getConfig(guildId) {
  const hit = configCache.get(guildId);
  if (hit && Date.now() - hit.ts < CONFIG_TTL_MS) return hit.value;
  const row = getStmt.get(guildId);
  let stored = {};
  try { stored = row ? JSON.parse(row.data) : {}; } catch {}
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

const levelGet = db.prepare('SELECT * FROM levels WHERE guildId = ? AND userId = ?');
const levelUpsert = db.prepare(`INSERT INTO levels (guildId, userId, xp, level, lastMessage) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(guildId, userId) DO UPDATE SET xp=excluded.xp, level=excluded.level, lastMessage=excluded.lastMessage`);
const levelTop = db.prepare('SELECT * FROM levels WHERE guildId = ? ORDER BY xp DESC LIMIT ?');
function getLevel(g, u) { return levelGet.get(g, u) || { guildId: g, userId: u, xp: 0, level: 0, lastMessage: 0 }; }
function setLevel(g, u, xp, lvl, last) { levelUpsert.run(g, u, xp, lvl, last); }
function topLevels(g, limit = 10) { return levelTop.all(g, limit); }

const warnAdd = db.prepare('INSERT INTO warns (guildId,userId,moderatorId,reason,timestamp) VALUES (?,?,?,?,?)');
const warnGet = db.prepare('SELECT * FROM warns WHERE guildId=? AND userId=? ORDER BY timestamp DESC');
const warnClear = db.prepare('DELETE FROM warns WHERE guildId=? AND userId=?');
function addWarn(g, u, m, r) { warnAdd.run(g, u, m, r, Date.now()); }
function getWarns(g, u) { return warnGet.all(g, u); }
function clearWarns(g, u) { warnClear.run(g, u); }

const ticketCreate = db.prepare('INSERT INTO tickets(channelId,guildId,userId,status,createdAt) VALUES (?,?,?,?,?)');
const ticketGet = db.prepare('SELECT * FROM tickets WHERE channelId = ?');
const ticketSetStatusWithClaim = db.prepare('UPDATE tickets SET status = ?, claimedBy = ?, lastActivityAt = ? WHERE channelId = ?');
const ticketSetStatusOnly = db.prepare('UPDATE tickets SET status = ?, lastActivityAt = ? WHERE channelId = ?');
const ticketOpenForUser = db.prepare("SELECT * FROM tickets WHERE guildId = ? AND userId = ? AND status = 'open'");
function createTicket(c, g, u) { ticketCreate.run(c, g, u, 'open', Date.now()); return getTicket(c); }
function getTicket(c) { return ticketGet.get(c); }
function setTicketStatus(channelId, status, claimedBy) {
  const now = Date.now();
  if (claimedBy === undefined) ticketSetStatusOnly.run(status, now, channelId);
  else ticketSetStatusWithClaim.run(status, claimedBy, now, channelId);
}
function openTicketsForUser(g, u) { return ticketOpenForUser.all(g, u); }

const vmAdd = db.prepare('INSERT OR REPLACE INTO voicemaster_channels(channelId,guildId,ownerId) VALUES (?,?,?)');
const vmGet = db.prepare('SELECT * FROM voicemaster_channels WHERE channelId = ?');
const vmDel = db.prepare('DELETE FROM voicemaster_channels WHERE channelId = ?');
function addVMChannel(c, g, o) { vmAdd.run(c, g, o); }
function getVMChannel(c) { return vmGet.get(c); }
function removeVMChannel(c) { vmDel.run(c); }

const wlAdd = db.prepare('INSERT OR IGNORE INTO antinuke_whitelist(guildId,userId) VALUES (?,?)');
const wlRem = db.prepare('DELETE FROM antinuke_whitelist WHERE guildId=? AND userId=?');
const wlCheck = db.prepare('SELECT 1 FROM antinuke_whitelist WHERE guildId=? AND userId=?');
const wlList = db.prepare('SELECT userId FROM antinuke_whitelist WHERE guildId = ?');
function addToWhitelist(g, u) { wlAdd.run(g, u); }
function removeFromWhitelist(g, u) { wlRem.run(g, u); }
function isWhitelisted(g, u) { return !!wlCheck.get(g, u); }
function listWhitelist(g) { return wlList.all(g).map(r => r.userId); }

const actLog = db.prepare('INSERT INTO action_log(guildId,userId,type,detail,timestamp) VALUES (?,?,?,?,?)');
const actRecent = db.prepare('SELECT * FROM action_log WHERE guildId=? ORDER BY timestamp DESC LIMIT ?');
function logAction(g, u, t, d) { actLog.run(g, u, t, d || null, Date.now()); }
function recentActions(g, limit = 15) { return actRecent.all(g, limit); }

const srGet = db.prepare('SELECT roles FROM sticky_roles WHERE guildId=? AND userId=?');
const srSet = db.prepare('INSERT INTO sticky_roles(guildId,userId,roles) VALUES (?,?,?) ON CONFLICT(guildId,userId) DO UPDATE SET roles=excluded.roles');
function getStickyRoles(g, u) { const r = srGet.get(g, u); try { return r ? JSON.parse(r.roles) : []; } catch { return []; } }
function setStickyRoles(g, u, roles) { srSet.run(g, u, JSON.stringify(roles || [])); }

const spamGet = db.prepare('SELECT * FROM spam_tracker WHERE guildId=? AND userId=?');
const spamInsert = db.prepare('INSERT OR REPLACE INTO spam_tracker(guildId,userId,count,windowStart) VALUES (?,?,?,?)');
const spamUpdate = db.prepare('UPDATE spam_tracker SET count=? WHERE guildId=? AND userId=?');
function bumpSpam(g, u, windowSec) {
  const now = Date.now();
  const r = spamGet.get(g, u);
  if (!r || now - r.windowStart > windowSec * 1000) { spamInsert.run(g, u, 1, now); return 1; }
  const n = r.count + 1; spamUpdate.run(n, g, u); return n;
}

const joinAdd = db.prepare('INSERT INTO join_tracker(guildId,userId,timestamp) VALUES (?,?,?)');
const joinCount = db.prepare('SELECT COUNT(*) c FROM join_tracker WHERE guildId=? AND timestamp>?');
const joinPurge = db.prepare('DELETE FROM join_tracker WHERE guildId=? AND timestamp<?');
function trackJoin(g, u) { joinAdd.run(g, u, Date.now()); }
function recentJoinCount(g, w) { return joinCount.get(g, Date.now() - w * 1000).c; }
function pruneJoins(g, olderThanSec) { joinPurge.run(g, Date.now() - olderThanSec * 1000); }

const eoGet = db.prepare('SELECT value FROM emoji_overrides WHERE name = ?');
const eoSet = db.prepare('INSERT INTO emoji_overrides(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value');
const eoDel = db.prepare('DELETE FROM emoji_overrides WHERE name = ?');
const eoAll = db.prepare('SELECT name,value FROM emoji_overrides');
function getEmojiOverride(n) { return eoGet.get(n)?.value || null; }
function setEmojiOverride(n, v) { eoSet.run(n, v); }
function resetEmojiOverride(n) { eoDel.run(n); }
function getAllEmojiOverrides() { const o = {}; for (const r of eoAll.all()) o[r.name] = r.value; return o; }

const etGet = db.prepare('SELECT * FROM embed_texts WHERE lower(name)=lower(?) OR lower(sourceTitle)=lower(?) LIMIT 1');
const etUpsert = db.prepare(`INSERT INTO embed_texts(name,sourceTitle,title,description,footer,updatedAt) VALUES (?,?,?,?,?,?)
  ON CONFLICT(name) DO UPDATE SET sourceTitle=excluded.sourceTitle, updatedAt=excluded.updatedAt`);
function registerEmbedText(sourceTitle, description = '', footer = '') {
  const name = String(sourceTitle || 'embed').replace(/<@!?\d+>/g, '@user').replace(/\d{15,25}/g, 'id')
    .replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 70) || 'embed';
  etUpsert.run(name, String(sourceTitle), String(sourceTitle), String(description || ''), String(footer || ''), Date.now());
  return etGet.get(name, name);
}
function getEmbedText(name) { return etGet.get(name, name) || null; }
function listEmbedTexts(limit = 500) { return db.prepare('SELECT * FROM embed_texts ORDER BY updatedAt DESC LIMIT ?').all(limit); }

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
  saveOwnerConfig({ blacklistedGuildOwnerIds: ids }); return ids;
}
function removeGlobalBlacklist(id) {
  const ids = getGlobalBlacklist().filter(x => x !== String(id).trim());
  saveOwnerConfig({ blacklistedGuildOwnerIds: ids }); return ids;
}

function createGiveaway(guildId, hostId, { prize, winners = 1, durationMs, channelId }) {
  const now = Date.now();
  const info = db.prepare('INSERT INTO giveaways(guildId,hostId,prize,winners,endsAt,channelId,status,createdAt) VALUES (?,?,?,?,?,?,?,?)')
    .run(guildId, hostId, String(prize), Math.max(1, Number(winners) || 1), now + (Number(durationMs) || 0), channelId || null, 'configuring', now);
  return getGiveaway(guildId, info.lastInsertRowid);
}
function getGiveaway(g, id) { return db.prepare('SELECT * FROM giveaways WHERE guildId=? AND id=?').get(g, Number(id)); }
function listGiveaways(g, limit = 50) { return db.prepare('SELECT * FROM giveaways WHERE guildId=? ORDER BY id DESC LIMIT ?').all(g, limit); }
function listActiveGiveaways() { return db.prepare("SELECT * FROM giveaways WHERE status = 'active' ORDER BY endsAt ASC").all(); }
function updateGiveaway(g, id, patch) {
  const row = getGiveaway(g, id); if (!row) return null;
  const fields = Object.keys(patch).filter(k => ['prize','winners','endsAt','channelId','messageId','participants','status','winnerIds'].includes(k));
  if (!fields.length) return row;
  db.prepare(`UPDATE giveaways SET ${fields.map(f => `${f}=?`).join(',')} WHERE guildId=? AND id=?`)
    .run(...fields.map(f => patch[f]), g, Number(id));
  return getGiveaway(g, id);
}

function saveEmbed(g, name, data) {
  const now = Date.now();
  db.prepare('INSERT INTO saved_embeds(guildId,name,data,createdAt,updatedAt) VALUES (?,?,?,?,?) ON CONFLICT(guildId,name) DO UPDATE SET data=excluded.data,updatedAt=excluded.updatedAt')
    .run(g, name, JSON.stringify(data), now, now);
  return getEmbed(g, name);
}
function getEmbed(g, name) {
  const r = db.prepare('SELECT * FROM saved_embeds WHERE guildId=? AND lower(name)=lower(?)').get(g, name);
  if (!r) return null;
  try { return { ...r, data: JSON.parse(r.data) }; } catch { return null; }
}
function listEmbeds(g) {
  return db.prepare('SELECT * FROM saved_embeds WHERE guildId=? ORDER BY updatedAt DESC').all(g)
    .map(r => { try { return { ...r, data: JSON.parse(r.data) }; } catch { return r; } });
}
function deleteEmbed(g, name) { return db.prepare('DELETE FROM saved_embeds WHERE guildId=? AND lower(name)=lower(?)').run(g, name).changes > 0; }

function panelKey(kind) { return kind === 'button' ? 'buttonRolePanels' : 'reactionRolePanels'; }
function findPanel(g, kind, id) { return (getConfig(g)[panelKey(kind)] || []).find(p => p.id === id) || null; }
function upsertPanel(g, kind, panel) {
  const key = panelKey(kind);
  const arr = [...(getConfig(g)[key] || [])];
  const i = arr.findIndex(p => p.id === panel.id);
  if (i >= 0) arr[i] = panel; else arr.push(panel);
  saveConfig(g, { [key]: arr }); return panel;
}
function removePanel(g, kind, id) {
  const key = panelKey(kind);
  saveConfig(g, { [key]: (getConfig(g)[key] || []).filter(p => p.id !== id) });
}

function stickyRow(r) { return r ? { ...r, enabled: !!r.enabled, data: (() => { try { return JSON.parse(r.data); } catch { return {}; } })() } : null; }
function getSticky(c) { return stickyRow(db.prepare('SELECT * FROM sticky_messages WHERE channelId = ?').get(c)); }
function listStickies(g) { return db.prepare('SELECT * FROM sticky_messages WHERE guildId = ? ORDER BY createdAt ASC').all(g).map(stickyRow); }
function saveSticky(g, c, { data, enabled = true, createdBy = null } = {}) {
  const now = Date.now();
  db.prepare(`INSERT INTO sticky_messages (guildId,channelId,data,enabled,createdBy,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(guildId, channelId) DO UPDATE SET data=excluded.data, enabled=excluded.enabled, updatedAt=excluded.updatedAt`)
    .run(g, c, JSON.stringify(data || {}), enabled ? 1 : 0, createdBy, now, now);
  return getSticky(c);
}
function setStickyMessageId(c, m) { db.prepare('UPDATE sticky_messages SET lastMessageId=?, updatedAt=? WHERE channelId=?').run(m || null, Date.now(), c); }
function setStickyEnabled(c, enabled) { db.prepare('UPDATE sticky_messages SET enabled=?, updatedAt=? WHERE channelId=?').run(enabled ? 1 : 0, Date.now(), c); return getSticky(c); }
function deleteSticky(c) { return db.prepare('DELETE FROM sticky_messages WHERE channelId = ?').run(c).changes > 0; }

function appRow(r) { return r ? { ...r, answers: (() => { try { return JSON.parse(r.answers); } catch { return []; } })() } : null; }
function createApplication(g, u, answers) {
  const info = db.prepare('INSERT INTO staff_applications(guildId,userId,status,answers,createdAt) VALUES (?,?,?,?,?)')
    .run(g, u, 'pending', JSON.stringify(answers || []), Date.now());
  return getApplication(info.lastInsertRowid);
}
function getApplication(id) { return appRow(db.prepare('SELECT * FROM staff_applications WHERE id = ?').get(Number(id))); }
function pendingApplicationForUser(g, u) {
  return appRow(db.prepare("SELECT * FROM staff_applications WHERE guildId=? AND userId=? AND status='pending' ORDER BY id DESC LIMIT 1").get(g, u));
}
function lastApplicationForUser(g, u) {
  return appRow(db.prepare('SELECT * FROM staff_applications WHERE guildId=? AND userId=? ORDER BY id DESC LIMIT 1').get(g, u));
}
function updateApplication(id, patch) {
  const allowed = ['status', 'channelId', 'messageId', 'reviewerId', 'reason', 'decidedAt'];
  const keys = Object.keys(patch || {}).filter(k => allowed.includes(k));
  if (keys.length) db.prepare(`UPDATE staff_applications SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k => patch[k]), Number(id));
  return getApplication(id);
}

let toggleCache = null;
function listToggles() {
  if (!toggleCache) { toggleCache = db.prepare('SELECT * FROM command_toggles ORDER BY at DESC').all(); setTimeout(() => { toggleCache = null; }, 10000).unref?.(); }
  return toggleCache;
}
function getToggle(name) { return listToggles().find(t => t.name === String(name).toLowerCase()) || null; }
function setToggle(name, reason, byId) {
  db.prepare('INSERT INTO command_toggles(name,reason,byId,at) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET reason=excluded.reason,byId=excluded.byId,at=excluded.at')
    .run(String(name).toLowerCase(), reason || null, String(byId), Date.now());
  toggleCache = null;
}
function removeToggle(name) { const c = db.prepare('DELETE FROM command_toggles WHERE name=?').run(String(name).toLowerCase()).changes; toggleCache = null; return c > 0; }

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
  return (command ? db.prepare('DELETE FROM error_log WHERE lower(command)=lower(?)').run(command) : db.prepare('DELETE FROM error_log').run()).changes;
}

function setBirthday(g, u, m, d) {
  db.prepare('INSERT INTO birthdays(guildId,userId,month,day) VALUES (?,?,?,?) ON CONFLICT(guildId,userId) DO UPDATE SET month=excluded.month, day=excluded.day').run(g, u, m, d);
}
function birthdaysFor(m, d) { return db.prepare('SELECT * FROM birthdays WHERE month=? AND day=?').all(m, d); }

function getLogConfig(g, cat) { return db.prepare('SELECT * FROM log_config WHERE guildId=? AND category=?').get(g, cat) || null; }
function listLogConfig(g) { return db.prepare('SELECT * FROM log_config WHERE guildId=?').all(g); }
function setLogConfig(g, cat, patch) {
  const cur = getLogConfig(g, cat) || { guildId: g, category: cat, channelId: null, enabled: 1, details: 1 };
  const next = { ...cur, ...patch };
  db.prepare(`INSERT INTO log_config (guildId,category,channelId,enabled,details) VALUES (?,?,?,?,?)
    ON CONFLICT(guildId,category) DO UPDATE SET channelId=excluded.channelId, enabled=excluded.enabled, details=excluded.details`)
    .run(g, cat, next.channelId, next.enabled ? 1 : 0, next.details ? 1 : 0);
  return getLogConfig(g, cat);
}

function addSnipe(e) {
  db.prepare(`INSERT INTO snipe_entries (guildId,channelId,messageId,authorId,authorTag,action,content,newContent,attachments,jumpUrl,ts) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(e.guildId, e.channelId, e.messageId, e.authorId, e.authorTag || null, e.action, e.content || null, e.newContent || null, JSON.stringify(e.attachments || []), e.jumpUrl || null, Date.now());
  db.prepare(`DELETE FROM snipe_entries WHERE id NOT IN (SELECT id FROM snipe_entries WHERE guildId=? AND channelId=? ORDER BY id DESC LIMIT 50) AND guildId=? AND channelId=?`)
    .run(e.guildId, e.channelId, e.guildId, e.channelId);
}
function getSnipes(g, c, limit = 50) {
  return db.prepare('SELECT * FROM snipe_entries WHERE guildId=? AND channelId=? ORDER BY id DESC LIMIT ?').all(g, c, limit)
    .map(r => ({ ...r, attachments: (() => { try { return JSON.parse(r.attachments || '[]'); } catch { return []; } })() }));
}
function getSnipeAt(g, c, offset) {
  const r = db.prepare('SELECT * FROM snipe_entries WHERE guildId=? AND channelId=? ORDER BY id DESC LIMIT 1 OFFSET ?').get(g, c, offset);
  return r ? { ...r, attachments: (() => { try { return JSON.parse(r.attachments || '[]'); } catch { return []; } })() } : null;
}
function snipesCount(g, c) { return db.prepare('SELECT COUNT(*) c FROM snipe_entries WHERE guildId=? AND channelId=?').get(g, c).c; }
function pruneSnipes(g, maxAgeDays = 7) { return db.prepare('DELETE FROM snipe_entries WHERE guildId=? AND ts<?').run(g, Date.now() - maxAgeDays * 86400000).changes; }

function logTicketEvent(g, c, actorId, event, detail) {
  db.prepare('INSERT INTO ticket_events (guildId,channelId,actorId,event,detail,ts) VALUES (?,?,?,?,?,?)')
    .run(g, c, actorId || null, event, detail || null, Date.now());
}
function ticketEventsFor(g, c) { return db.prepare('SELECT * FROM ticket_events WHERE guildId=? AND channelId=? ORDER BY id DESC LIMIT 100').all(g, c); }

function scheduleEvent(g, c, messageId, kind, data, at) {
  return db.prepare('INSERT INTO scheduled_events(guildId,channelId,messageId,kind,data,at) VALUES (?,?,?,?,?,?)')
    .run(g, c, messageId || null, kind, JSON.stringify(data || {}), at).lastInsertRowid;
}
function dueEvents(now = Date.now(), limit = 25) {
  return db.prepare('SELECT * FROM scheduled_events WHERE at <= ? ORDER BY at ASC LIMIT ?').all(now, limit);
}
function deleteEvent(id) { db.prepare('DELETE FROM scheduled_events WHERE id = ?').run(id); }

function exportGuild(g) {
  return {
    version: 1, guildId: g, exportedAt: Date.now(),
    settings: getConfig(g),
    embeds: listEmbeds(g).map(e => ({ name: e.name, data: e.data })),
    stickies: listStickies(g)
  };
}
function importGuild(g, payload) {
  if (!payload || payload.version !== 1) throw new Error('Unsupported backup format.');
  if (payload.settings) replaceConfig(g, payload.settings);
  for (const e of payload.embeds || []) saveEmbed(g, e.name, e.data);
}

module.exports = {
  db, DB_PATH, DEFAULT_CONFIG,
  getConfig, saveConfig, replaceConfig, invalidateConfig,
  getLevel, setLevel, topLevels,
  addWarn, getWarns, clearWarns,
  createTicket, getTicket, setTicketStatus, openTicketsForUser,
  addVMChannel, getVMChannel, removeVMChannel,
  addToWhitelist, removeFromWhitelist, isWhitelisted, listWhitelist,
  logAction, recentActions,
  getStickyRoles, setStickyRoles,
  bumpSpam, trackJoin, recentJoinCount, pruneJoins,
  getEmojiOverride, setEmojiOverride, resetEmojiOverride, getAllEmojiOverrides,
  registerEmbedText, getEmbedText, listEmbedTexts,
  getOwnerConfig, saveOwnerConfig, getGlobalBlacklist, addGlobalBlacklist, removeGlobalBlacklist,
  createGiveaway, getGiveaway, listGiveaways, listActiveGiveaways, updateGiveaway,
  saveEmbed, getEmbed, listEmbeds, deleteEmbed,
  findPanel, upsertPanel, removePanel,
  getSticky, listStickies, saveSticky, setStickyMessageId, setStickyEnabled, deleteSticky,
  createApplication, getApplication, pendingApplicationForUser, lastApplicationForUser, updateApplication,
  getToggle, listToggles, setToggle, removeToggle,
  recordError, listErrors, clearErrors,
  setBirthday, birthdaysFor,
  getLogConfig, listLogConfig, setLogConfig,
  addSnipe, getSnipes, getSnipeAt, snipesCount, pruneSnipes,
  logTicketEvent, ticketEventsFor,
  scheduleEvent, dueEvents, deleteEvent,
  exportGuild, importGuild
};