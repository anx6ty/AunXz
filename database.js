// AunXz/database.js — SQLite schema, additive migrations, cached config access.
// Safe additive migrations only: existing data is never wiped.
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// =============================================================================
// PATH RESOLUTION
// =============================================================================
function resolvePath() {
  if (process.env.DATABASE_PATH) return path.resolve(process.env.DATABASE_PATH);
  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (volume) return path.join(path.resolve(volume), 'aunxz.sqlite');
  return path.join(__dirname, 'data', 'aunxz.sqlite');
}
const DB_PATH = resolvePath();
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Migrate legacy local DB into the volume the first time we see an empty volume.
// Prevents data loss when a volume is attached after the bot already ran without one.
function migrateLegacyDatabase(target) {
  if (fs.existsSync(target)) return;
  const candidates = [
    path.join(__dirname, 'bot.sqlite'),
    path.join(__dirname, 'aunxz.sqlite'),
    path.join(__dirname, 'data', 'bot.sqlite'),
    path.join(__dirname, 'data', 'aunxz.sqlite')
  ];
  const source = candidates.find(f => f !== target && fs.existsSync(f));
  if (!source) return;
  try {
    const legacy = new Database(source);
    try { legacy.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    try { legacy.close(); } catch {}
    fs.copyFileSync(source, target);
    console.log(`[AunXz] Migrated legacy SQLite database: ${source} → ${target}`);
  } catch (e) {
    console.error('[AunXz] Legacy database migration failed:', e?.message || e);
  }
}
migrateLegacyDatabase(DB_PATH);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

// =============================================================================
// SCHEMA
// =============================================================================
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
CREATE INDEX IF NOT EXISTS idx_levels_guild_xp ON levels(guildId, xp DESC);

CREATE TABLE IF NOT EXISTS warns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  moderatorId TEXT NOT NULL,
  reason TEXT,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_warns_guild_user ON warns(guildId, userId);

CREATE TABLE IF NOT EXISTS tickets (
  channelId TEXT PRIMARY KEY,
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  claimedBy TEXT,
  type TEXT NOT NULL DEFAULT 'general',
  priority TEXT NOT NULL DEFAULT 'normal',
  closedBy TEXT,
  closeReason TEXT,
  lastActivityAt INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_guild_user ON tickets(guildId, userId, status);

CREATE TABLE IF NOT EXISTS ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL,
  channelId TEXT NOT NULL,
  actorId TEXT,
  event TEXT NOT NULL,
  detail TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_events ON ticket_events(guildId, channelId, ts DESC);

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
CREATE INDEX IF NOT EXISTS idx_action_guild ON action_log(guildId, timestamp DESC);

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

CREATE TABLE IF NOT EXISTS embed_texts (
  name TEXT PRIMARY KEY,
  sourceTitle TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  footer TEXT NOT NULL DEFAULT '',
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL,
  hostId TEXT NOT NULL,
  prize TEXT NOT NULL,
  winners INTEGER NOT NULL DEFAULT 1,
  endsAt INTEGER NOT NULL DEFAULT 0,
  channelId TEXT,
  messageId TEXT,
  participants TEXT NOT NULL DEFAULT '[]',
  winnerIds TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'configuring',
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_giveaways_guild ON giveaways(guildId, status, endsAt);

CREATE TABLE IF NOT EXISTS saved_embeds (
  guildId TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (guildId, name)
);

CREATE TABLE IF NOT EXISTS sticky_messages (
  guildId TEXT NOT NULL,
  channelId TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  lastMessageId TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  createdBy TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (guildId, channelId)
);
CREATE INDEX IF NOT EXISTS idx_sticky_channel ON sticky_messages(channelId);

CREATE TABLE IF NOT EXISTS staff_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  answers TEXT NOT NULL DEFAULT '[]',
  channelId TEXT,
  messageId TEXT,
  reviewerId TEXT,
  reason TEXT,
  createdAt INTEGER NOT NULL,
  decidedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_apps_guild_status ON staff_applications(guildId, status);

CREATE TABLE IF NOT EXISTS command_toggles (
  name TEXT PRIMARY KEY,
  reason TEXT,
  byId TEXT,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT,
  command TEXT,
  guildId TEXT,
  userId TEXT,
  message TEXT,
  stack TEXT
);

CREATE TABLE IF NOT EXISTS birthdays (
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  PRIMARY KEY (guildId, userId)
);

CREATE TABLE IF NOT EXISTS log_config (
  guildId TEXT NOT NULL,
  category TEXT NOT NULL,
  channelId TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  details INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (guildId, category)
);

CREATE TABLE IF NOT EXISTS snipe_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL,
  channelId TEXT NOT NULL,
  messageId TEXT NOT NULL,
  authorId TEXT NOT NULL,
  authorTag TEXT,
  action TEXT NOT NULL,
  content TEXT,
  newContent TEXT,
  attachments TEXT DEFAULT '[]',
  jumpUrl TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snipe_lookup ON snipe_entries(guildId, channelId, id DESC);

CREATE TABLE IF NOT EXISTS scheduled_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL,
  channelId TEXT NOT NULL,
  messageId TEXT,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sched_at ON scheduled_events(at);
`);

// =============================================================================
// ADDITIVE MIGRATIONS
// =============================================================================
// `CREATE TABLE IF NOT EXISTS` is a no-op when the table already exists, so any
// column that was added AFTER the first release of a table must be applied via
// ALTER TABLE. This must run BEFORE any db.prepare() that references the column.
// =============================================================================

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}
function addColumn(table, column, definition) {
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// tickets (added: type, priority, closedBy, closeReason, lastActivityAt)
addColumn('tickets', 'type', "TEXT NOT NULL DEFAULT 'general'");
addColumn('tickets', 'priority', "TEXT NOT NULL DEFAULT 'normal'");
addColumn('tickets', 'closedBy', 'TEXT');
addColumn('tickets', 'closeReason', 'TEXT');
addColumn('tickets', 'lastActivityAt', 'INTEGER NOT NULL DEFAULT 0');

// snipe_entries (added: jumpUrl)
addColumn('snipe_entries', 'jumpUrl', 'TEXT');

// giveaways (added: messageId, participants, winnerIds, status)
addColumn('giveaways', 'messageId', 'TEXT');
addColumn('giveaways', 'participants', "TEXT NOT NULL DEFAULT '[]'");
addColumn('giveaways', 'winnerIds', "TEXT NOT NULL DEFAULT '[]'");
addColumn('giveaways', 'status', "TEXT NOT NULL DEFAULT 'configuring'");

// =============================================================================
// MIGRATION VALIDATION — fail loudly with a useful message instead of
// letting better-sqlite3 throw an opaque SQLITE_ERROR later.
// =============================================================================
{
  const required = {
    tickets: ['type', 'priority', 'closedBy', 'closeReason', 'lastActivityAt', 'createdAt'],
    snipe_entries: ['jumpUrl', 'attachments'],
    giveaways: ['messageId', 'participants', 'winnerIds', 'status']
  };
  const problems = [];
  for (const [table, cols] of Object.entries(required)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    for (const c of cols) if (!have.has(c)) problems.push(`${table}.${c}`);
  }
  if (problems.length) {
    console.error('❌ Database migration failed. Missing column(s):');
    for (const p of problems) console.error(`   • ${p}`);
    console.error(`   DB path: ${DB_PATH}`);
    console.error('   This usually means the volume is read-only, full, or the ALTER TABLE was blocked.');
    process.exit(1);
  }
}

// =============================================================================
// DEFAULT CONFIG (deep-merged with what's stored per guild)
// =============================================================================
const DEFAULT_CONFIG = {
  prefix: '!',
  appearance: { color: null, preset: 'black' },
  logs: { default: null, message: null, member: null, mod: null, voice: null, security: null, ticket: null, server: null, system: null },
  welcome: {
    enabled: false, channel: null, message: 'Welcome {user} to {server}! You are member #{count}.',
    autoroleId: null, image: null, ping: true, showAvatar: true, title: 'Welcome'
  },
  leave: { enabled: false, channel: null, message: '{user} has left the server.' },
  boost: { enabled: false, channel: null, message: '{user} just boosted the server!' },
  greetmessage: {
    enabled: false, channelId: null, message: 'Welcome {user}!',
    image: null, title: 'Welcome', color: null, showAvatar: true, ping: true
  },
  antinuke: {
    enabled: false, punishment: 'ban',
    maxChannelDeletes: 3, maxChannelCreates: 5,
    maxRoleDeletes: 3, maxRoleCreates: 5,
    maxBans: 3, maxKicks: 3,
    maxWebhookCreates: 3, maxRoleUpdates: 5,
    windowSeconds: 10, protectOwner: true
  },
  antilink: {
    enabled: false, mode: 'delete',
    whitelistedDomains: ['discord.gg', 'discord.com/invite'],
    bypassRoleId: null, whitelistedChannels: []
  },
  antispam: {
    enabled: false, maxMessages: 6, windowSeconds: 7,
    punishment: 'mute', muteMinutes: 5,
    maxMentions: 5, maxEmojis: 10
  },
  antiraid: {
    enabled: false, joinThreshold: 8, windowSeconds: 10,
    action: 'lockdown', minAccountAgeDays: 3
  },
  antiwebhook: { enabled: false, action: 'delete', bypassRoleId: null, logChannelId: null },
  antibot: { enabled: false, action: 'kick', bypassRoleId: null, logChannelId: null },
  antialt: { enabled: false, action: 'kick', minAccountAgeDays: 3, logChannelId: null },
  antibadword: { enabled: false, words: [], customWords: [], action: 'delete', logChannelId: null },
  voicemaster: {
    enabled: false, hubChannelId: null, categoryId: null,
    nameTemplate: "{user}'s room"
  },
  leveling: {
    enabled: false, channel: null, xpPerMessage: 15, cooldownSeconds: 60,
    levelUpMessage: '{user} reached level {level}!', roleRewards: {}
  },
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
  birthdays: {
    enabled: false, panelChannelId: null, wishChannelId: null,
    wishMessage: 'Happy Birthday {user}!', entries: {}
  },
  staffApplications: {
    enabled: false, panelChannelId: null, logChannelId: null, questions: [],
    title: 'Staff Applications',
    description: 'Click Apply to start your application.',
    dmIntro: 'Are you ready to start your staff application?',
    applicantRoleId: null, acceptedRoleId: null, cooldownHours: 24,
    acceptMessage: 'Congratulations! Your application was accepted.',
    denyMessage: 'Thank you for applying. Your application was not accepted this time.'
  },
  honeypot: {
    enabled: false, channelId: null, action: 'kick',
    cleanupWindow: 'none', createInvite: false,
    dmMessage: 'You were removed for posting in the honeypot channel. {invite}',
    logChannelId: null, whitelistRoleIds: []
  },
  maintenance: false,
  blacklist: [],
  ai: { enabled: true, maxTokens: 700, temperature: 0.3, memoryMax: 8 }
};

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(override || {})) {
    const v = override[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// =============================================================================
// GUILD CONFIG — cached, invalidated on write
// =============================================================================
const CONFIG_TTL_MS = 5000;
const configCache = new Map();
const getConfigStmt = db.prepare('SELECT data FROM guild_config WHERE guildId = ?');
const upsertConfigStmt = db.prepare(
  'INSERT INTO guild_config (guildId, data) VALUES (@guildId, @data) ON CONFLICT(guildId) DO UPDATE SET data = @data'
);

function getConfig(guildId) {
  const hit = configCache.get(guildId);
  if (hit && Date.now() - hit.ts < CONFIG_TTL_MS) return hit.value;
  const row = getConfigStmt.get(guildId);
  let stored = {};
  try { stored = row ? JSON.parse(row.data) : {}; } catch { stored = {}; }
  const merged = deepMerge(DEFAULT_CONFIG, stored);
  configCache.set(guildId, { value: merged, ts: Date.now() });
  return merged;
}
function saveConfig(guildId, partial) {
  const merged = deepMerge(getConfig(guildId), partial || {});
  upsertConfigStmt.run({ guildId, data: JSON.stringify(merged) });
  configCache.set(guildId, { value: merged, ts: Date.now() });
  return merged;
}
function replaceConfig(guildId, data) {
  upsertConfigStmt.run({ guildId, data: JSON.stringify(data || {}) });
  configCache.delete(guildId);
  return getConfig(guildId);
}
function invalidateConfig(guildId) { configCache.delete(guildId); }

// =============================================================================
// LEVELS
// =============================================================================
const levelGetStmt = db.prepare('SELECT * FROM levels WHERE guildId = ? AND userId = ?');
const levelUpsertStmt = db.prepare(
  `INSERT INTO levels (guildId, userId, xp, level, lastMessage) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(guildId, userId) DO UPDATE SET xp=excluded.xp, level=excluded.level, lastMessage=excluded.lastMessage`
);
const levelTopStmt = db.prepare('SELECT * FROM levels WHERE guildId = ? ORDER BY xp DESC LIMIT ?');

function getLevel(guildId, userId) {
  return levelGetStmt.get(guildId, userId) || { guildId, userId, xp: 0, level: 0, lastMessage: 0 };
}
function setLevel(guildId, userId, xp, level, lastMessage) {
  levelUpsertStmt.run(guildId, userId, xp, level, lastMessage);
}
function topLevels(guildId, limit = 10) { return levelTopStmt.all(guildId, limit); }

// =============================================================================
// WARNINGS
// =============================================================================
const warnAddStmt = db.prepare('INSERT INTO warns (guildId,userId,moderatorId,reason,timestamp) VALUES (?,?,?,?,?)');
const warnGetStmt = db.prepare('SELECT * FROM warns WHERE guildId=? AND userId=? ORDER BY timestamp DESC');
const warnClearStmt = db.prepare('DELETE FROM warns WHERE guildId=? AND userId=?');

function addWarn(guildId, userId, moderatorId, reason) {
  warnAddStmt.run(guildId, userId, moderatorId, reason, Date.now());
}
function getWarns(guildId, userId) { return warnGetStmt.all(guildId, userId); }
function clearWarns(guildId, userId) { warnClearStmt.run(guildId, userId); }

// =============================================================================
// TICKETS
// =============================================================================
const ticketCreateStmt = db.prepare(
  'INSERT INTO tickets(channelId,guildId,userId,status,createdAt) VALUES (?,?,?,?,?)'
);
const ticketGetStmt = db.prepare('SELECT * FROM tickets WHERE channelId = ?');
const ticketSetStatusWithClaimStmt = db.prepare(
  'UPDATE tickets SET status = ?, claimedBy = ?, lastActivityAt = ? WHERE channelId = ?'
);
const ticketSetStatusOnlyStmt = db.prepare(
  'UPDATE tickets SET status = ?, lastActivityAt = ? WHERE channelId = ?'
);
const ticketOpenForUserStmt = db.prepare(
  "SELECT * FROM tickets WHERE guildId = ? AND userId = ? AND status = 'open'"
);
const ticketSetTypeStmt = db.prepare('UPDATE tickets SET type = ? WHERE channelId = ?');
const ticketSetCloseStmt = db.prepare('UPDATE tickets SET closedBy = ?, closeReason = ? WHERE channelId = ?');

function createTicket(channelId, guildId, userId) {
  ticketCreateStmt.run(channelId, guildId, userId, 'open', Date.now());
  return getTicket(channelId);
}
function getTicket(channelId) { return ticketGetStmt.get(channelId); }
function setTicketStatus(channelId, status, claimedBy) {
  const now = Date.now();
  if (claimedBy === undefined) ticketSetStatusOnlyStmt.run(status, now, channelId);
  else ticketSetStatusWithClaimStmt.run(status, claimedBy, now, channelId);
}
function openTicketsForUser(guildId, userId) { return ticketOpenForUserStmt.all(guildId, userId); }
function setTicketType(channelId, type) { ticketSetTypeStmt.run(String(type || 'general'), channelId); }
function setTicketClose(channelId, closedBy, closeReason) { ticketSetCloseStmt.run(closedBy || null, closeReason || null, channelId); }

// =============================================================================
// TICKET EVENTS
// =============================================================================
const ticketEventInsert = db.prepare(
  'INSERT INTO ticket_events (guildId,channelId,actorId,event,detail,ts) VALUES (?,?,?,?,?,?)'
);
const ticketEventList = db.prepare(
  'SELECT * FROM ticket_events WHERE guildId=? AND channelId=? ORDER BY id DESC LIMIT ?'
);
function logTicketEvent(guildId, channelId, actorId, event, detail) {
  ticketEventInsert.run(guildId, channelId, actorId || null, event, detail || null, Date.now());
}
function ticketEventsFor(guildId, channelId, limit = 100) { return ticketEventList.all(guildId, channelId, limit); }

// =============================================================================
// VOICEMASTER
// =============================================================================
const vmAddStmt = db.prepare('INSERT OR REPLACE INTO voicemaster_channels(channelId,guildId,ownerId) VALUES (?,?,?)');
const vmGetStmt = db.prepare('SELECT * FROM voicemaster_channels WHERE channelId = ?');
const vmDelStmt = db.prepare('DELETE FROM voicemaster_channels WHERE channelId = ?');
function addVMChannel(c, g, o) { vmAddStmt.run(c, g, o); }
function getVMChannel(c) { return vmGetStmt.get(c); }
function removeVMChannel(c) { vmDelStmt.run(c); }

// =============================================================================
// WHITELIST
// =============================================================================
const wlAddStmt = db.prepare('INSERT OR IGNORE INTO antinuke_whitelist(guildId,userId) VALUES (?,?)');
const wlRemStmt = db.prepare('DELETE FROM antinuke_whitelist WHERE guildId=? AND userId=?');
const wlCheckStmt = db.prepare('SELECT 1 FROM antinuke_whitelist WHERE guildId=? AND userId=?');
const wlListStmt = db.prepare('SELECT userId FROM antinuke_whitelist WHERE guildId = ?');
function addToWhitelist(g, u) { wlAddStmt.run(g, u); }
function removeFromWhitelist(g, u) { wlRemStmt.run(g, u); }
function isWhitelisted(g, u) { return !!wlCheckStmt.get(g, u); }
function listWhitelist(g) { return wlListStmt.all(g).map(r => r.userId); }

// =============================================================================
// ACTION LOG
// =============================================================================
const actLogStmt = db.prepare('INSERT INTO action_log(guildId,userId,type,detail,timestamp) VALUES (?,?,?,?,?)');
const actRecentStmt = db.prepare('SELECT * FROM action_log WHERE guildId=? ORDER BY timestamp DESC LIMIT ?');
function logAction(g, u, t, d) { actLogStmt.run(g, u, t, d || null, Date.now()); }
function recentActions(g, limit = 15) { return actRecentStmt.all(g, limit); }

// =============================================================================
// STICKY ROLES
// =============================================================================
const srGetStmt = db.prepare('SELECT roles FROM sticky_roles WHERE guildId=? AND userId=?');
const srSetStmt = db.prepare(
  'INSERT INTO sticky_roles(guildId,userId,roles) VALUES (?,?,?) ON CONFLICT(guildId,userId) DO UPDATE SET roles=excluded.roles'
);
function getStickyRoles(g, u) {
  const r = srGetStmt.get(g, u);
  try { return r ? JSON.parse(r.roles) : []; } catch { return []; }
}
function setStickyRoles(g, u, roles) { srSetStmt.run(g, u, JSON.stringify(roles || [])); }

// =============================================================================
// SPAM TRACKER
// =============================================================================
const spamGetStmt = db.prepare('SELECT * FROM spam_tracker WHERE guildId=? AND userId=?');
const spamInsertStmt = db.prepare('INSERT OR REPLACE INTO spam_tracker(guildId,userId,count,windowStart) VALUES (?,?,?,?)');
const spamUpdateStmt = db.prepare('UPDATE spam_tracker SET count=? WHERE guildId=? AND userId=?');
function bumpSpam(g, u, windowSec) {
  const now = Date.now();
  const r = spamGetStmt.get(g, u);
  if (!r || now - r.windowStart > windowSec * 1000) {
    spamInsertStmt.run(g, u, 1, now);
    return 1;
  }
  const n = r.count + 1;
  spamUpdateStmt.run(n, g, u);
  return n;
}

// =============================================================================
// JOIN TRACKER
// =============================================================================
const joinAddStmt = db.prepare('INSERT INTO join_tracker(guildId,userId,timestamp) VALUES (?,?,?)');
const joinCountStmt = db.prepare('SELECT COUNT(*) c FROM join_tracker WHERE guildId=? AND timestamp>?');
const joinPurgeStmt = db.prepare('DELETE FROM join_tracker WHERE guildId=? AND timestamp<?');
function trackJoin(g, u) { joinAddStmt.run(g, u, Date.now()); }
function recentJoinCount(g, w) { return joinCountStmt.get(g, Date.now() - w * 1000).c; }
function pruneJoins(g, olderThanSec) { joinPurgeStmt.run(g, Date.now() - olderThanSec * 1000); }

// =============================================================================
// EMOJI OVERRIDES
// =============================================================================
const eoGetStmt = db.prepare('SELECT value FROM emoji_overrides WHERE name = ?');
const eoSetStmt = db.prepare('INSERT INTO emoji_overrides(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value');
const eoDelStmt = db.prepare('DELETE FROM emoji_overrides WHERE name = ?');
const eoAllStmt = db.prepare('SELECT name,value FROM emoji_overrides');
function getEmojiOverride(n) { return eoGetStmt.get(n)?.value || null; }
function setEmojiOverride(n, v) { eoSetStmt.run(n, v); }
function resetEmojiOverride(n) { eoDelStmt.run(n); }
function getAllEmojiOverrides() {
  const o = {};
  for (const r of eoAllStmt.all()) o[r.name] = r.value;
  return o;
}

// =============================================================================
// EMBED TEXTS
// =============================================================================
const etGetStmt = db.prepare('SELECT * FROM embed_texts WHERE lower(name)=lower(?) OR lower(sourceTitle)=lower(?) LIMIT 1');
const etUpsertStmt = db.prepare(
  `INSERT INTO embed_texts(name,sourceTitle,title,description,footer,updatedAt) VALUES (?,?,?,?,?,?)
   ON CONFLICT(name) DO UPDATE SET sourceTitle=excluded.sourceTitle, updatedAt=excluded.updatedAt`
);
const etListStmt = db.prepare('SELECT * FROM embed_texts ORDER BY updatedAt DESC LIMIT ?');

function registerEmbedText(sourceTitle, description = '', footer = '') {
  const name = String(sourceTitle || 'embed')
    .replace(/<@!?\d+>/g, '@user')
    .replace(/\d{15,25}/g, 'id')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim().replace(/\s+/g, '-').toLowerCase().slice(0, 70) || 'embed';
  etUpsertStmt.run(name, String(sourceTitle), String(sourceTitle), String(description || ''), String(footer || ''), Date.now());
  return etGetStmt.get(name, name);
}
function getEmbedText(name) { return etGetStmt.get(name, name) || null; }
function listEmbedTexts(limit = 500) { return etListStmt.all(limit); }

// =============================================================================
// OWNER CONFIG
// =============================================================================
const ocGetStmt = db.prepare('SELECT data FROM owner_config WHERE id = 1');
const ocUpsertStmt = db.prepare('INSERT INTO owner_config(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data');
function getOwnerConfig() {
  const r = ocGetStmt.get();
  if (!r) return {};
  try { return JSON.parse(r.data) || {}; } catch { return {}; }
}
function saveOwnerConfig(partial) {
  const merged = deepMerge(getOwnerConfig(), partial || {});
  ocUpsertStmt.run(JSON.stringify(merged));
  return merged;
}
function getGlobalBlacklist() {
  const ids = getOwnerConfig().blacklistedGuildOwnerIds;
  return [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map(x => String(x).trim())
      .filter(x => /^\d{15,25}$/.test(x))
  )];
}
function addGlobalBlacklist(id) {
  id = String(id || '').trim();
  if (!/^\d{15,25}$/.test(id)) throw new Error('Invalid user ID.');
  const ids = getGlobalBlacklist();
  if (!ids.includes(id)) ids.push(id);
  saveOwnerConfig({ blacklistedGuildOwnerIds: ids });
  return ids;
}
function removeGlobalBlacklist(id) {
  const ids = getGlobalBlacklist().filter(x => x !== String(id).trim());
  saveOwnerConfig({ blacklistedGuildOwnerIds: ids });
  return ids;
}

// =============================================================================
// GIVEAWAYS
// =============================================================================
const giveawayCreateStmt = db.prepare(
  'INSERT INTO giveaways(guildId,hostId,prize,winners,endsAt,channelId,status,createdAt) VALUES (?,?,?,?,?,?,?,?)'
);
const giveawayGetStmt = db.prepare('SELECT * FROM giveaways WHERE guildId=? AND id=?');
const giveawayListStmt = db.prepare('SELECT * FROM giveaways WHERE guildId=? ORDER BY id DESC LIMIT ?');
const giveawayActiveStmt = db.prepare("SELECT * FROM giveaways WHERE status = 'active' ORDER BY endsAt ASC");

function createGiveaway(guildId, hostId, { prize, winners = 1, durationMs, channelId }) {
  const now = Date.now();
  const info = giveawayCreateStmt.run(
    guildId, hostId, String(prize), Math.max(1, Number(winners) || 1),
    now + (Number(durationMs) || 0), channelId || null, 'configuring', now
  );
  return getGiveaway(guildId, info.lastInsertRowid);
}
function getGiveaway(g, id) { return giveawayGetStmt.get(g, Number(id)); }
function listGiveaways(g, limit = 50) { return giveawayListStmt.all(g, limit); }
function listActiveGiveaways() { return giveawayActiveStmt.all(); }
function updateGiveaway(g, id, patch) {
  const row = getGiveaway(g, id);
  if (!row) return null;
  const allowed = ['prize', 'winners', 'endsAt', 'channelId', 'messageId', 'participants', 'status', 'winnerIds'];
  const fields = Object.keys(patch).filter(k => allowed.includes(k));
  if (!fields.length) return row;
  const set = fields.map(f => `${f}=?`).join(',');
  db.prepare(`UPDATE giveaways SET ${set} WHERE guildId=? AND id=?`)
    .run(...fields.map(f => patch[f]), g, Number(id));
  return getGiveaway(g, id);
}

// =============================================================================
// SAVED EMBEDS
// =============================================================================
const embedSaveStmt = db.prepare(
  'INSERT INTO saved_embeds(guildId,name,data,createdAt,updatedAt) VALUES (?,?,?,?,?) ON CONFLICT(guildId,name) DO UPDATE SET data=excluded.data,updatedAt=excluded.updatedAt'
);
const embedGetStmt = db.prepare('SELECT * FROM saved_embeds WHERE guildId=? AND lower(name)=lower(?)');
const embedListStmt = db.prepare('SELECT * FROM saved_embeds WHERE guildId=? ORDER BY updatedAt DESC');
const embedDelStmt = db.prepare('DELETE FROM saved_embeds WHERE guildId=? AND lower(name)=lower(?)');

function saveEmbed(g, name, data) {
  const now = Date.now();
  embedSaveStmt.run(g, name, JSON.stringify(data), now, now);
  return getEmbed(g, name);
}
function getEmbed(g, name) {
  const r = embedGetStmt.get(g, name);
  if (!r) return null;
  try { return { ...r, data: JSON.parse(r.data) }; } catch { return null; }
}
function listEmbeds(g) {
  return embedListStmt.all(g).map(r => {
    try { return { ...r, data: JSON.parse(r.data) }; } catch { return r; }
  });
}
function deleteEmbed(g, name) { return embedDelStmt.run(g, name).changes > 0; }

// =============================================================================
// ROLE PANELS (stored inside guild_config JSON)
// =============================================================================
function panelKey(kind) { return kind === 'button' ? 'buttonRolePanels' : 'reactionRolePanels'; }
function findPanel(g, kind, id) {
  return (getConfig(g)[panelKey(kind)] || []).find(p => p.id === id) || null;
}
function upsertPanel(g, kind, panel) {
  const key = panelKey(kind);
  const arr = [...(getConfig(g)[key] || [])];
  const i = arr.findIndex(p => p.id === panel.id);
  if (i >= 0) arr[i] = panel; else arr.push(panel);
  saveConfig(g, { [key]: arr });
  return panel;
}
function removePanel(g, kind, id) {
  const key = panelKey(kind);
  saveConfig(g, { [key]: (getConfig(g)[key] || []).filter(p => p.id !== id) });
}

// =============================================================================
// STICKY MESSAGES
// =============================================================================
function stickyRow(r) {
  return r ? {
    ...r, enabled: !!r.enabled,
    data: (() => { try { return JSON.parse(r.data); } catch { return {}; } })()
  } : null;
}
const stickyGetStmt = db.prepare('SELECT * FROM sticky_messages WHERE channelId = ?');
const stickyListStmt = db.prepare('SELECT * FROM sticky_messages WHERE guildId = ? ORDER BY createdAt ASC');
const stickySaveStmt = db.prepare(
  `INSERT INTO sticky_messages (guildId,channelId,data,enabled,createdBy,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)
   ON CONFLICT(guildId, channelId) DO UPDATE SET data=excluded.data, enabled=excluded.enabled, updatedAt=excluded.updatedAt`
);
const stickyMsgIdStmt = db.prepare('UPDATE sticky_messages SET lastMessageId=?, updatedAt=? WHERE channelId=?');
const stickyEnableStmt = db.prepare('UPDATE sticky_messages SET enabled=?, updatedAt=? WHERE channelId=?');
const stickyDelStmt = db.prepare('DELETE FROM sticky_messages WHERE channelId = ?');

function getSticky(c) { return stickyRow(stickyGetStmt.get(c)); }
function listStickies(g) { return stickyListStmt.all(g).map(stickyRow); }
function saveSticky(g, c, { data, enabled = true, createdBy = null } = {}) {
  const now = Date.now();
  stickySaveStmt.run(g, c, JSON.stringify(data || {}), enabled ? 1 : 0, createdBy, now, now);
  return getSticky(c);
}
function setStickyMessageId(c, m) { stickyMsgIdStmt.run(m || null, Date.now(), c); }
function setStickyEnabled(c, enabled) { stickyEnableStmt.run(enabled ? 1 : 0, Date.now(), c); return getSticky(c); }
function deleteSticky(c) { return stickyDelStmt.run(c).changes > 0; }

// =============================================================================
// STAFF APPLICATIONS
// =============================================================================
function appRow(r) {
  return r ? { ...r, answers: (() => { try { return JSON.parse(r.answers); } catch { return []; } })() } : null;
}
const appCreateStmt = db.prepare(
  'INSERT INTO staff_applications(guildId,userId,status,answers,createdAt) VALUES (?,?,?,?,?)'
);
const appGetStmt = db.prepare('SELECT * FROM staff_applications WHERE id = ?');
const appPendingStmt = db.prepare(
  "SELECT * FROM staff_applications WHERE guildId=? AND userId=? AND status='pending' ORDER BY id DESC LIMIT 1"
);
const appLastStmt = db.prepare('SELECT * FROM staff_applications WHERE guildId=? AND userId=? ORDER BY id DESC LIMIT 1');

function createApplication(g, u, answers) {
  const info = appCreateStmt.run(g, u, 'pending', JSON.stringify(answers || []), Date.now());
  return getApplication(info.lastInsertRowid);
}
function getApplication(id) { return appRow(appGetStmt.get(Number(id))); }
function pendingApplicationForUser(g, u) { return appRow(appPendingStmt.get(g, u)); }
function lastApplicationForUser(g, u) { return appRow(appLastStmt.get(g, u)); }
function updateApplication(id, patch) {
  const allowed = ['status', 'channelId', 'messageId', 'reviewerId', 'reason', 'decidedAt'];
  const keys = Object.keys(patch || {}).filter(k => allowed.includes(k));
  if (keys.length) {
    db.prepare(`UPDATE staff_applications SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`)
      .run(...keys.map(k => patch[k]), Number(id));
  }
  return getApplication(id);
}

// =============================================================================
// COMMAND TOGGLES
// =============================================================================
let toggleCache = null;
const toggleListStmt = db.prepare('SELECT * FROM command_toggles ORDER BY at DESC');
const toggleSetStmt = db.prepare(
  'INSERT INTO command_toggles(name,reason,byId,at) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET reason=excluded.reason,byId=excluded.byId,at=excluded.at'
);
const toggleDelStmt = db.prepare('DELETE FROM command_toggles WHERE name=?');

function listToggles() {
  if (!toggleCache) {
    toggleCache = toggleListStmt.all();
    setTimeout(() => { toggleCache = null; }, 10000).unref?.();
  }
  return toggleCache;
}
function getToggle(name) { return listToggles().find(t => t.name === String(name).toLowerCase()) || null; }
function setToggle(name, reason, byId) {
  toggleSetStmt.run(String(name).toLowerCase(), reason || null, String(byId), Date.now());
  toggleCache = null;
}
function removeToggle(name) {
  const c = toggleDelStmt.run(String(name).toLowerCase()).changes;
  toggleCache = null;
  return c > 0;
}

// =============================================================================
// ERRORS
// =============================================================================
const errInsertStmt = db.prepare(
  'INSERT INTO error_log(ts,source,command,guildId,userId,message,stack) VALUES (?,?,?,?,?,?,?)'
);
const errPruneStmt = db.prepare(
  'DELETE FROM error_log WHERE id NOT IN (SELECT id FROM error_log ORDER BY id DESC LIMIT 200)'
);
const errListStmt = db.prepare('SELECT * FROM error_log ORDER BY id DESC');
const errListByCmdStmt = db.prepare('SELECT * FROM error_log WHERE lower(command)=lower(?) ORDER BY id DESC');
const errClearStmt = db.prepare('DELETE FROM error_log');
const errClearByCmdStmt = db.prepare('DELETE FROM error_log WHERE lower(command)=lower(?)');

function recordError({ source = null, command = null, guildId = null, userId = null, message = '', stack = '' } = {}) {
  errInsertStmt.run(
    Date.now(), source, command, guildId, userId,
    String(message || '').slice(0, 2000),
    String(stack || '').slice(0, 20000)
  );
  errPruneStmt.run();
}
function listErrors(command = null) {
  return command ? errListByCmdStmt.all(command) : errListStmt.all();
}
function clearErrors(command = null) {
  return (command ? errClearByCmdStmt.run(command) : errClearStmt.run()).changes;
}

// =============================================================================
// BIRTHDAYS
// =============================================================================
const bdaySetStmt = db.prepare(
  'INSERT INTO birthdays(guildId,userId,month,day) VALUES (?,?,?,?) ON CONFLICT(guildId,userId) DO UPDATE SET month=excluded.month, day=excluded.day'
);
const bdayForStmt = db.prepare('SELECT * FROM birthdays WHERE month=? AND day=?');
function setBirthday(g, u, m, d) { bdaySetStmt.run(g, u, m, d); }
function birthdaysFor(m, d) { return bdayForStmt.all(m, d); }

// =============================================================================
// LOG CONFIG
// =============================================================================
const logGetStmt = db.prepare('SELECT * FROM log_config WHERE guildId=? AND category=?');
const logListStmt = db.prepare('SELECT * FROM log_config WHERE guildId=?');
const logSetStmt = db.prepare(
  `INSERT INTO log_config (guildId,category,channelId,enabled,details) VALUES (?,?,?,?,?)
   ON CONFLICT(guildId,category) DO UPDATE SET channelId=excluded.channelId, enabled=excluded.enabled, details=excluded.details`
);
function getLogConfig(g, cat) { return logGetStmt.get(g, cat) || null; }
function listLogConfig(g) { return logListStmt.all(g); }
function setLogConfig(g, cat, patch) {
  const cur = getLogConfig(g, cat) || { guildId: g, category: cat, channelId: null, enabled: 1, details: 1 };
  const next = { ...cur, ...patch };
  logSetStmt.run(g, cat, next.channelId, next.enabled ? 1 : 0, next.details ? 1 : 0);
  return getLogConfig(g, cat);
}

// =============================================================================
// SNIPE ENTRIES
// =============================================================================
const snipeInsertStmt = db.prepare(
  `INSERT INTO snipe_entries (guildId,channelId,messageId,authorId,authorTag,action,content,newContent,attachments,jumpUrl,ts)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`
);
const snipeTrimStmt = db.prepare(
  `DELETE FROM snipe_entries WHERE id NOT IN (
     SELECT id FROM snipe_entries WHERE guildId=? AND channelId=? ORDER BY id DESC LIMIT 50
   ) AND guildId=? AND channelId=?`
);
const snipeListStmt = db.prepare(
  'SELECT * FROM snipe_entries WHERE guildId=? AND channelId=? ORDER BY id DESC LIMIT ?'
);
const snipeAtStmt = db.prepare(
  'SELECT * FROM snipe_entries WHERE guildId=? AND channelId=? ORDER BY id DESC LIMIT 1 OFFSET ?'
);
const snipeCountStmt = db.prepare(
  'SELECT COUNT(*) c FROM snipe_entries WHERE guildId=? AND channelId=?'
);
const snipePruneStmt = db.prepare('DELETE FROM snipe_entries WHERE guildId=? AND ts<?');

function parseAttachments(s) {
  try { return JSON.parse(s || '[]'); } catch { return []; }
}
function addSnipe(e) {
  snipeInsertStmt.run(
    e.guildId, e.channelId, e.messageId, e.authorId, e.authorTag || null, e.action,
    e.content || null, e.newContent || null,
    JSON.stringify(e.attachments || []), e.jumpUrl || null, Date.now()
  );
  snipeTrimStmt.run(e.guildId, e.channelId, e.guildId, e.channelId);
}
function getSnipes(g, c, limit = 50) {
  return snipeListStmt.all(g, c, limit).map(r => ({ ...r, attachments: parseAttachments(r.attachments) }));
}
function getSnipeAt(g, c, offset) {
  const r = snipeAtStmt.get(g, c, offset);
  return r ? { ...r, attachments: parseAttachments(r.attachments) } : null;
}
function snipesCount(g, c) { return snipeCountStmt.get(g, c).c; }
function pruneSnipes(g, maxAgeDays = 7) { return snipePruneStmt.run(g, Date.now() - maxAgeDays * 86400000).changes; }

// =============================================================================
// SCHEDULED EVENTS
// =============================================================================
const schedInsertStmt = db.prepare(
  'INSERT INTO scheduled_events(guildId,channelId,messageId,kind,data,at) VALUES (?,?,?,?,?,?)'
);
const schedDueStmt = db.prepare('SELECT * FROM scheduled_events WHERE at <= ? ORDER BY at ASC LIMIT ?');
const schedDelStmt = db.prepare('DELETE FROM scheduled_events WHERE id = ?');
function scheduleEvent(g, c, messageId, kind, data, at) {
  return schedInsertStmt.run(g, c, messageId || null, kind, JSON.stringify(data || {}), at).lastInsertRowid;
}
function dueEvents(now = Date.now(), limit = 25) { return schedDueStmt.all(now, limit); }
function deleteEvent(id) { schedDelStmt.run(id); }

// =============================================================================
// BACKUP / RESTORE
// =============================================================================
function exportGuild(g) {
  return {
    version: 1,
    guildId: g,
    exportedAt: Date.now(),
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

// =============================================================================
// EXPORTS
// =============================================================================
module.exports = {
  db, DB_PATH, DEFAULT_CONFIG,

  // config
  getConfig, saveConfig, replaceConfig, invalidateConfig,

  // levels
  getLevel, setLevel, topLevels,

  // warnings
  addWarn, getWarns, clearWarns,

  // tickets
  createTicket, getTicket, setTicketStatus, openTicketsForUser,
  setTicketType, setTicketClose,
  logTicketEvent, ticketEventsFor,

  // voicemaster
  addVMChannel, getVMChannel, removeVMChannel,

  // whitelist
  addToWhitelist, removeFromWhitelist, isWhitelisted, listWhitelist,

  // action log
  logAction, recentActions,

  // sticky roles
  getStickyRoles, setStickyRoles,

  // spam / joins
  bumpSpam, trackJoin, recentJoinCount, pruneJoins,

  // emoji
  getEmojiOverride, setEmojiOverride, resetEmojiOverride, getAllEmojiOverrides,

  // embed texts
  registerEmbedText, getEmbedText, listEmbedTexts,

  // owner
  getOwnerConfig, saveOwnerConfig, getGlobalBlacklist, addGlobalBlacklist, removeGlobalBlacklist,

  // giveaways
  createGiveaway, getGiveaway, listGiveaways, listActiveGiveaways, updateGiveaway,

  // saved embeds
  saveEmbed, getEmbed, listEmbeds, deleteEmbed,

  // role panels
  findPanel, upsertPanel, removePanel,

  // sticky messages
  getSticky, listStickies, saveSticky, setStickyMessageId, setStickyEnabled, deleteSticky,

  // applications
  createApplication, getApplication, pendingApplicationForUser, lastApplicationForUser, updateApplication,

  // command toggles
  getToggle, listToggles, setToggle, removeToggle,

  // errors
  recordError, listErrors, clearErrors,

  // birthdays
  setBirthday, birthdaysFor,

  // logging
  getLogConfig, listLogConfig, setLogConfig,

  // snipe
  addSnipe, getSnipes, getSnipeAt, snipesCount, pruneSnipes,

  // scheduled events
  scheduleEvent, dueEvents, deleteEvent,

  // backup / restore
  exportGuild, importGuild
};