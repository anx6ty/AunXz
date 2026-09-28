// database.js — single SQLite file, all persistence for the bot.
// Guild-level toggles/config are stored as one JSON blob per guild so we can support
// dozens of setup options without needing a column for every single one.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Railway persistent volume support: DATA_DIR=/data (or /data when it exists).
// Never store the live database beside the application when a persistent volume is available.
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'bot.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS guild_config (
  guildId TEXT PRIMARY KEY,
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS levels (
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 0,
  lastMessage INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guildId, userId)
);

CREATE TABLE IF NOT EXISTS warns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  moderatorId TEXT NOT NULL,
  reason TEXT,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  channelId TEXT PRIMARY KEY,
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  claimedBy TEXT,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS voicemaster_channels (
  channelId TEXT PRIMARY KEY,
  guildId TEXT NOT NULL,
  ownerId TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS antinuke_whitelist (
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  PRIMARY KEY (guildId, userId)
);

CREATE TABLE IF NOT EXISTS action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL,
  userId TEXT,
  type TEXT NOT NULL,
  detail TEXT,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sticky_roles (
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  roles TEXT NOT NULL,
  PRIMARY KEY (guildId, userId)
);

CREATE TABLE IF NOT EXISTS spam_tracker (
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  windowStart INTEGER NOT NULL,
  PRIMARY KEY (guildId, userId)
);

CREATE TABLE IF NOT EXISTS join_tracker (
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS emoji_overrides (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emoji_snapshots (
  code TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL,
  channelId TEXT,
  messageId TEXT,
  hostId TEXT NOT NULL,
  prize TEXT NOT NULL,
  winners INTEGER NOT NULL DEFAULT 1,
  durationMs INTEGER NOT NULL DEFAULT 86400000,
  endsAt INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'configuring',
  participants TEXT NOT NULL DEFAULT '[]',
  createdAt INTEGER NOT NULL
);
`);

// ---------- lightweight schema migrations ----------
// Existing Railway volumes keep the old SQLite file. CREATE TABLE IF NOT EXISTS does
// not add columns to an already-existing table, so every new column must be migrated.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Giveaways were introduced after some installations already had an older giveaways table.
// These migrations are safe to run on every startup.
ensureColumn('giveaways', 'channelId', 'TEXT');
ensureColumn('giveaways', 'messageId', 'TEXT');
ensureColumn('giveaways', 'hostId', "TEXT NOT NULL DEFAULT ''");
ensureColumn('giveaways', 'prize', "TEXT NOT NULL DEFAULT 'Giveaway'");
ensureColumn('giveaways', 'winners', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('giveaways', 'durationMs', 'INTEGER NOT NULL DEFAULT 86400000');
ensureColumn('giveaways', 'endsAt', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('giveaways', 'status', "TEXT NOT NULL DEFAULT 'configuring'");
ensureColumn('giveaways', 'participants', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('giveaways', 'createdAt', 'INTEGER NOT NULL DEFAULT 0');

// Repair old rows that were created before the new fields existed.
db.prepare("UPDATE giveaways SET durationMs = 86400000 WHERE durationMs IS NULL OR durationMs <= 0").run();
db.prepare("UPDATE giveaways SET createdAt = COALESCE(createdAt, 0) WHERE createdAt IS NULL").run();
db.prepare("UPDATE giveaways SET endsAt = createdAt + durationMs WHERE (endsAt IS NULL OR endsAt = 0) AND createdAt > 0").run();
db.prepare("UPDATE giveaways SET participants = '[]' WHERE participants IS NULL OR participants = ''").run();

// ---------- default config shape ----------
// Every guild setting the bot supports lives in here. Missing keys fall back to these defaults.
const DEFAULT_CONFIG = {
  prefix: '!',
  logs: {
    mod: null, message: null, member: null, voice: null,
    antinuke: null, server: null, ticket: null, join: null
  },
  welcome: { enabled: false, channel: null, message: 'Welcome {user} to {server}! You are member #{count}.', autoroleId: null },
  leave: { enabled: false, channel: null, message: '{user} has left the server.' },
  boost: { enabled: false, channel: null, message: '{user} just boosted the server! Thank you! 🚀' },
  greetvoice: { enabled: false, roleId: null, vcId: null, ttsPrompt: null },
  greetmessage: { enabled: false, channelId: null, message: 'Welcome {user}!', image: null },
  antinuke: {
    enabled: false, punishment: 'ban', // ban | kick | strip_roles
    maxChannelDeletes: 3, maxChannelCreates: 5, maxRoleDeletes: 3, maxRoleCreates: 5,
    maxBans: 3, maxKicks: 3, maxWebhookCreates: 3, maxRoleUpdates: 5,
    windowSeconds: 10, protectOwner: true
  },
  antilink: { enabled: false, mode: 'delete', whitelistedDomains: ['discord.gg', 'discord.com/invite'], bypassRoleId: null, whitelistedChannels: [] },
  antispam: { enabled: false, maxMessages: 6, windowSeconds: 7, punishment: 'mute', muteMinutes: 5, maxMentions: 5, maxEmojis: 10 },
  antiraid: { enabled: false, joinThreshold: 8, windowSeconds: 10, action: 'lockdown', minAccountAgeDays: 3 },
  voicemaster: { enabled: false, hubChannelId: null, categoryId: null, nameTemplate: "{user}'s room" },
  leveling: { enabled: false, channel: null, xpPerMessage: 15, cooldownSeconds: 60, levelUpMessage: '{user} reached level {level}!', roleRewards: {} },
  ticket: {
    enabled: false, categoryId: null, panelChannelId: null, supportRoleId: null, logChannelId: null, counter: 0,
    // The "Open Ticket" panel message (posted by /ticketpanel).
    panelTitle: null, panelDescription: null, panelThumbnail: null, panelImage: null,
    // The embed sent inside a freshly-created ticket channel (matches the "Welcome @user /
    // Category: X / message" + thumbnail + banner layout).
    categoryLabel: 'General Support', welcomeMessage: 'Our support team will assist you shortly.',
    welcomeThumbnail: null, welcomeImage: null
  },
  automod: { badWordFilter: false, badWords: [], capsFilter: false, capsThreshold: 70, inviteFilter: false },
  afk: {},
  autorole: { enabled: false, target: 'everyone', roleId: null },
  reactionRoles: { enabled: false, channelId: null, messageId: null, mappings: [] },
  suggestions: { enabled: false, channelId: null },
  polls: { enabled: true },
  snipeEnabled: true,
  nsfwFilter: { enabled: false },
  birthdays: { enabled: false, panelChannelId: null, wishChannelId: null, wishMessage: 'Happy Birthday {user}! 🎂', entries: {} },
  buttonRoles: { enabled: false, channelId: null, title: 'Choose your roles', description: 'Press a button to get or remove a role.', image: null, embedType: 'embed', buttons: [] },
  staffApplications: { enabled: false, panelChannelId: null, logChannelId: null, title: 'Staff Applications', description: 'Click Apply to start your application.', questions: [], dmIntro: 'Are you ready to start your staff application?', acceptingRoleId: null },
  antibadword: { enabled: false, logChannelId: null, customWords: [], action: 'delete' },
  autoresponder: { enabled: false, ignoreCase: true, triggers: [] },
  autoreactor: { enabled: false, ignoreCase: true, triggers: [] },
  honeypot: { enabled: false, channelId: null, action: 'kick', logChannelId: null, createInvite: true, dmMessage: 'You were removed for posting in the honeypot channel. Here is an invite back: {invite}', cleanupWindow: 'none' },
  starboard: { enabled: false, channelId: null, threshold: 3 },
  inviteTracker: { enabled: false },
  maintenance: false,
  blacklist: []
};

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(override || {})) {
    if (override[k] && typeof override[k] === 'object' && !Array.isArray(override[k]) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], override[k]);
    } else {
      out[k] = override[k];
    }
  }
  return out;
}

const getConfigStmt = db.prepare('SELECT data FROM guild_config WHERE guildId = ?');
const upsertConfigStmt = db.prepare(`
  INSERT INTO guild_config (guildId, data) VALUES (@guildId, @data)
  ON CONFLICT(guildId) DO UPDATE SET data = @data
`);

function getConfig(guildId) {
  const row = getConfigStmt.get(guildId);
  const stored = row ? JSON.parse(row.data) : {};
  return deepMerge(DEFAULT_CONFIG, stored);
}

function saveConfig(guildId, partial) {
  const current = getConfig(guildId);
  const merged = deepMerge(current, partial);
  upsertConfigStmt.run({ guildId, data: JSON.stringify(merged) });
  return merged;
}

// ---------- leveling ----------
const getLevelStmt = db.prepare('SELECT * FROM levels WHERE guildId = ? AND userId = ?');
const upsertLevelStmt = db.prepare(`
  INSERT INTO levels (guildId, userId, xp, level, lastMessage) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(guildId, userId) DO UPDATE SET xp = excluded.xp, level = excluded.level, lastMessage = excluded.lastMessage
`);
const topLevelsStmt = db.prepare('SELECT * FROM levels WHERE guildId = ? ORDER BY xp DESC LIMIT ?');

function getLevel(guildId, userId) {
  return getLevelStmt.get(guildId, userId) || { guildId, userId, xp: 0, level: 0, lastMessage: 0 };
}
function setLevel(guildId, userId, xp, level, lastMessage) {
  upsertLevelStmt.run(guildId, userId, xp, level, lastMessage);
}
function topLevels(guildId, limit = 10) {
  return topLevelsStmt.all(guildId, limit);
}


// ---------- giveaways ----------
const insertGiveawayStmt = db.prepare(`
  INSERT INTO giveaways
  (guildId, channelId, messageId, hostId, prize, winners, durationMs, endsAt, status, participants, createdAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getGiveawayStmt = db.prepare('SELECT * FROM giveaways WHERE id = ? AND guildId = ?');
const updateGiveawayStmt = db.prepare('UPDATE giveaways SET channelId=?, messageId=?, prize=?, winners=?, durationMs=?, endsAt=?, status=?, participants=? WHERE id=? AND guildId=?');
const listGiveawaysStmt = db.prepare('SELECT * FROM giveaways WHERE guildId = ? ORDER BY createdAt DESC LIMIT ?');

function createGiveaway(guildId, hostId, data = {}) {
  const now = Date.now();
  const durationMs = Number(data.durationMs || 86400000);
  const result = insertGiveawayStmt.run(
    guildId, data.channelId || null, data.messageId || null, hostId,
    String(data.prize || 'Giveaway'), Math.max(1, Number(data.winners || 1)),
    durationMs, Number(data.endsAt || now + durationMs),
    data.status || 'configuring', JSON.stringify(data.participants || []), now
  );
  return getGiveawayStmt.get(result.lastInsertRowid, guildId);
}
function getGiveaway(guildId, id) { return getGiveawayStmt.get(id, guildId); }
function updateGiveaway(guildId, id, patch = {}) {
  const cur = getGiveaway(guildId, id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  updateGiveawayStmt.run(
    next.channelId, next.messageId, next.prize, next.winners, next.durationMs,
    next.endsAt, next.status, typeof next.participants === 'string' ? next.participants : JSON.stringify(next.participants || []),
    id, guildId
  );
  return getGiveaway(guildId, id);
}
function listGiveaways(guildId, limit = 25) { return listGiveawaysStmt.all(guildId, limit); }

// ---------- warns ----------
const addWarnStmt = db.prepare('INSERT INTO warns (guildId, userId, moderatorId, reason, timestamp) VALUES (?, ?, ?, ?, ?)');
const getWarnsStmt = db.prepare('SELECT * FROM warns WHERE guildId = ? AND userId = ? ORDER BY timestamp DESC');
const clearWarnsStmt = db.prepare('DELETE FROM warns WHERE guildId = ? AND userId = ?');

function addWarn(guildId, userId, moderatorId, reason) {
  addWarnStmt.run(guildId, userId, moderatorId, reason, Date.now());
}
function getWarns(guildId, userId) {
  return getWarnsStmt.all(guildId, userId);
}
function clearWarns(guildId, userId) {
  clearWarnsStmt.run(guildId, userId);
}

// ---------- tickets ----------
const createTicketStmt = db.prepare('INSERT INTO tickets (channelId, guildId, userId, status, createdAt) VALUES (?, ?, ?, ?, ?)');
const getTicketStmt = db.prepare('SELECT * FROM tickets WHERE channelId = ?');
const setTicketStatusStmt = db.prepare('UPDATE tickets SET status = ?, claimedBy = COALESCE(?, claimedBy) WHERE channelId = ?');
const openTicketForUserStmt = db.prepare("SELECT * FROM tickets WHERE guildId = ? AND userId = ? AND status = 'open' ORDER BY createdAt DESC");
const openTicketsForUserStmt = db.prepare("SELECT * FROM tickets WHERE guildId = ? AND userId = ? AND status = 'open' ORDER BY createdAt DESC");

function createTicket(channelId, guildId, userId) {
  createTicketStmt.run(channelId, guildId, userId, 'open', Date.now());
}
function getTicket(channelId) {
  return getTicketStmt.get(channelId);
}
function closeTicket(channelId) {
  db.prepare("UPDATE tickets SET status = 'closed' WHERE channelId = ?").run(channelId);
}
function setTicketStatus(channelId, status, claimedBy = null) {
  setTicketStatusStmt.run(status, claimedBy, channelId);
}
function openTicketForUser(guildId, userId) {
  return openTicketForUserStmt.get(guildId, userId);
}
function openTicketsForUser(guildId, userId) {
  return openTicketsForUserStmt.all(guildId, userId);
}

// ---------- voicemaster ----------
const addVMChannelStmt = db.prepare('INSERT INTO voicemaster_channels (channelId, guildId, ownerId) VALUES (?, ?, ?)');
const getVMChannelStmt = db.prepare('SELECT * FROM voicemaster_channels WHERE channelId = ?');
const removeVMChannelStmt = db.prepare('DELETE FROM voicemaster_channels WHERE channelId = ?');

function addVMChannel(channelId, guildId, ownerId) {
  addVMChannelStmt.run(channelId, guildId, ownerId);
}
function getVMChannel(channelId) {
  return getVMChannelStmt.get(channelId);
}
function removeVMChannel(channelId) {
  removeVMChannelStmt.run(channelId);
}

// ---------- antinuke whitelist ----------
const addWhitelistStmt = db.prepare('INSERT OR IGNORE INTO antinuke_whitelist (guildId, userId) VALUES (?, ?)');
const removeWhitelistStmt = db.prepare('DELETE FROM antinuke_whitelist WHERE guildId = ? AND userId = ?');
const isWhitelistedStmt = db.prepare('SELECT 1 FROM antinuke_whitelist WHERE guildId = ? AND userId = ?');

function addToWhitelist(guildId, userId) { addWhitelistStmt.run(guildId, userId); }
function removeFromWhitelist(guildId, userId) { removeWhitelistStmt.run(guildId, userId); }
function isWhitelisted(guildId, userId) { return !!isWhitelistedStmt.get(guildId, userId); }

// ---------- action log (antinuke / audit trail shown in /logs) ----------
const addActionLogStmt = db.prepare('INSERT INTO action_log (guildId, userId, type, detail, timestamp) VALUES (?, ?, ?, ?, ?)');
const recentActionLogStmt = db.prepare('SELECT * FROM action_log WHERE guildId = ? ORDER BY timestamp DESC LIMIT ?');

function logAction(guildId, userId, type, detail) {
  addActionLogStmt.run(guildId, userId, type, detail, Date.now());
}
function recentActions(guildId, limit = 15) {
  return recentActionLogStmt.all(guildId, limit);
}

// ---------- sticky roles ----------
const getStickyStmt = db.prepare('SELECT roles FROM sticky_roles WHERE guildId = ? AND userId = ?');
const setStickyStmt = db.prepare(`
  INSERT INTO sticky_roles (guildId, userId, roles) VALUES (?, ?, ?)
  ON CONFLICT(guildId, userId) DO UPDATE SET roles = excluded.roles
`);

function getStickyRoles(guildId, userId) {
  const row = getStickyStmt.get(guildId, userId);
  return row ? JSON.parse(row.roles) : [];
}
function setStickyRoles(guildId, userId, roles) {
  setStickyStmt.run(guildId, userId, JSON.stringify(roles));
}

// ---------- spam tracker (rolling window counters, cleaned lazily) ----------
const getSpamStmt = db.prepare('SELECT * FROM spam_tracker WHERE guildId = ? AND userId = ?');
const setSpamStmt = db.prepare(`
  INSERT INTO spam_tracker (guildId, userId, count, windowStart) VALUES (?, ?, ?, ?)
  ON CONFLICT(guildId, userId) DO UPDATE SET count = excluded.count, windowStart = excluded.windowStart
`);

function bumpSpam(guildId, userId, windowSeconds) {
  const now = Date.now();
  const row = getSpamStmt.get(guildId, userId);
  if (!row || now - row.windowStart > windowSeconds * 1000) {
    setSpamStmt.run(guildId, userId, 1, now);
    return 1;
  }
  const count = row.count + 1;
  setSpamStmt.run(guildId, userId, count, row.windowStart);
  return count;
}

// ---------- join tracker (antiraid) ----------
const addJoinStmt = db.prepare('INSERT INTO join_tracker (guildId, userId, timestamp) VALUES (?, ?, ?)');
const recentJoinsStmt = db.prepare('SELECT COUNT(*) as c FROM join_tracker WHERE guildId = ? AND timestamp > ?');

function trackJoin(guildId, userId) {
  addJoinStmt.run(guildId, userId, Date.now());
}
function recentJoinCount(guildId, windowSeconds) {
  return recentJoinsStmt.get(guildId, Date.now() - windowSeconds * 1000).c;
}

// ---------- emoji overrides (bot-wide, owner-configurable via /emoji) ----------
const getEmojiStmt = db.prepare('SELECT value FROM emoji_overrides WHERE name = ?');
const setEmojiStmt = db.prepare(`
  INSERT INTO emoji_overrides (name, value) VALUES (?, ?)
  ON CONFLICT(name) DO UPDATE SET value = excluded.value
`);
const deleteEmojiStmt = db.prepare('DELETE FROM emoji_overrides WHERE name = ?');
const allEmojiStmt = db.prepare('SELECT name, value FROM emoji_overrides');
const saveEmojiSnapshotStmt = db.prepare('INSERT INTO emoji_snapshots (code, data, createdAt) VALUES (?, ?, ?)');
const getEmojiSnapshotStmt = db.prepare('SELECT data FROM emoji_snapshots WHERE code = ?');

function getEmojiOverride(name) {
  const row = getEmojiStmt.get(name);
  return row ? row.value : null;
}
function setEmojiOverride(name, value) {
  setEmojiStmt.run(name, value);
}
function resetEmojiOverride(name) {
  deleteEmojiStmt.run(name);
}
function getAllEmojiOverrides() {
  const out = {};
  for (const row of allEmojiStmt.all()) out[row.name] = row.value;
  return out;
}
function randomSnapshotCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let code = '';
  do { code = Array.from({length: 12}, () => chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while (getEmojiSnapshotStmt.get(code));
  return code;
}
function saveEmojiSnapshot(values) {
  const code = randomSnapshotCode();
  saveEmojiSnapshotStmt.run(code, JSON.stringify(values || {}), Date.now());
  return code;
}
function getEmojiSnapshot(code) {
  const row = getEmojiSnapshotStmt.get(String(code || '').trim());
  return row ? JSON.parse(row.data) : null;
}

module.exports = {
  db, DEFAULT_CONFIG,
  getConfig, saveConfig,
  getLevel, setLevel, topLevels,
  addWarn, getWarns, clearWarns,
  createTicket, getTicket, closeTicket, setTicketStatus, openTicketForUser, openTicketsForUser,
  addVMChannel, getVMChannel, removeVMChannel,
  addToWhitelist, removeFromWhitelist, isWhitelisted,
  logAction, recentActions,
  getStickyRoles, setStickyRoles,
  bumpSpam, trackJoin, recentJoinCount,
  getEmojiOverride, setEmojiOverride, resetEmojiOverride, getAllEmojiOverrides,
  saveEmojiSnapshot, getEmojiSnapshot, DB_PATH, DATA_DIR,
  createGiveaway, getGiveaway, updateGiveaway, listGiveaways,
};
