// AunXz/database.js — SQLite schema, exhaustive migrations, cached config access.
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// =============================================================================
// PATH RESOLUTION + LEGACY MIGRATION
// =============================================================================
function resolvePath() {
  if (process.env.DATABASE_PATH) return path.resolve(process.env.DATABASE_PATH);
  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (volume) return path.join(path.resolve(volume), 'aunxz.sqlite');
  return path.join(__dirname, 'data', 'aunxz.sqlite');
}
const DB_PATH = resolvePath();
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

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
// SCHEMA — idempotent (only creates missing tables)
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
  createdAt INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS emoji_snapshots (
  code TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  createdAt INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS memberships (
  guildId TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT '30 Days',
  durationDays INTEGER NOT NULL DEFAULT 30,
  createdAt INTEGER NOT NULL DEFAULT 0,
  expiresAt INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL,
  hostId TEXT NOT NULL,
  prize TEXT NOT NULL,
  winners INTEGER NOT NULL DEFAULT 1,
  durationMs INTEGER NOT NULL DEFAULT 0,
  endsAt INTEGER NOT NULL DEFAULT 0,
  channelId TEXT,
  messageId TEXT,
  participants TEXT NOT NULL DEFAULT '[]',
  winnerIds TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'configuring',
  createdAt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_giveaways_guild ON giveaways(guildId, status, endsAt);

CREATE TABLE IF NOT EXISTS saved_embeds (
  guildId TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  createdAt INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guildId, name)
);

CREATE TABLE IF NOT EXISTS sticky_messages (
  guildId TEXT NOT NULL,
  channelId TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  lastMessageId TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  createdBy TEXT,
  createdAt INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL DEFAULT 0,
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
  createdAt INTEGER NOT NULL DEFAULT 0,
  decidedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_apps_guild_status ON staff_applications(guildId, status);

CREATE TABLE IF NOT EXISTS command_toggles (
  name TEXT PRIMARY KEY,
  reason TEXT,
  byId TEXT,
  at INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS owner_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT NOT NULL,
  command TEXT NOT NULL,
  args TEXT,
  guildId TEXT,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS command_usage (
  day TEXT NOT NULL,
  guildId TEXT NOT NULL,
  name TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  fail INTEGER NOT NULL DEFAULT 0,
  lastUsed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, guildId, name)
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

CREATE TABLE IF NOT EXISTS server_templates (
  code TEXT PRIMARY KEY,
  guildId TEXT NOT NULL,
  guildName TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL,
  createdBy TEXT,
  createdAt INTEGER NOT NULL DEFAULT 0
);
`);

// =============================================================================
// MIGRATIONS — explicit list for every known column
// =============================================================================
function hasColumn(table, column) {
  try {
    return db.prepare(`PRAGMA table_info("${table}")`).all().some(c => c.name === column);
  } catch { return false; }
}
function addColumn(table, column, definition) {
  if (!hasColumn(table, column)) {
    try {
      db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
      console.log(`[migration] added ${table}.${column}`);
    } catch (e) {
      console.error(`[migration] failed to add ${table}.${column}: ${e.message}`);
    }
  }
}

// Every column that may be missing from an older version of a table.
// The definition here is the one used when ALTER TABLE has to add it.
const COLUMN_MIGRATIONS = {
  // tickets
  'tickets.type':             "TEXT NOT NULL DEFAULT 'general'",
  'tickets.priority':         "TEXT NOT NULL DEFAULT 'normal'",
  'tickets.closedBy':         'TEXT',
  'tickets.closeReason':      'TEXT',
  'tickets.lastActivityAt':   'INTEGER NOT NULL DEFAULT 0',
  'tickets.createdAt':        'INTEGER NOT NULL DEFAULT 0',
  'tickets.claimedBy':        'TEXT',

  // snipe_entries
  'snipe_entries.jumpUrl':     'TEXT',
  'snipe_entries.attachments': "TEXT DEFAULT '[]'",

  // giveaways
  'giveaways.messageId':     'TEXT',
  'giveaways.participants':  "TEXT NOT NULL DEFAULT '[]'",
  'giveaways.winnerIds':     "TEXT NOT NULL DEFAULT '[]'",
  'giveaways.status':        "TEXT NOT NULL DEFAULT 'configuring'",
  'giveaways.createdAt':     'INTEGER NOT NULL DEFAULT 0',
  'giveaways.channelId':     'TEXT',
  'giveaways.durationMs':    'INTEGER NOT NULL DEFAULT 0',
  'giveaways.endsAt':        'INTEGER NOT NULL DEFAULT 0',

  // sticky_messages — the block that was missing
  'sticky_messages.data':          "TEXT NOT NULL DEFAULT '{}'",
  'sticky_messages.lastMessageId': 'TEXT',
  'sticky_messages.enabled':       'INTEGER NOT NULL DEFAULT 1',
  'sticky_messages.createdBy':     'TEXT',
  'sticky_messages.createdAt':     'INTEGER NOT NULL DEFAULT 0',
  'sticky_messages.updatedAt':     'INTEGER NOT NULL DEFAULT 0',

  // staff_applications
  'staff_applications.decidedAt':  'INTEGER',
  'staff_applications.reason':     'TEXT',
  'staff_applications.channelId':  'TEXT',
  'staff_applications.messageId':  'TEXT',
  'staff_applications.reviewerId': 'TEXT',
  'staff_applications.createdAt':  'INTEGER NOT NULL DEFAULT 0',

  // memberships
  'memberships.plan':         "TEXT NOT NULL DEFAULT '30 Days'",
  'memberships.durationDays': 'INTEGER NOT NULL DEFAULT 30',
  'memberships.note':         "TEXT NOT NULL DEFAULT ''",
  'memberships.expiresAt':    'INTEGER NOT NULL DEFAULT 0',
  'memberships.createdAt':    'INTEGER NOT NULL DEFAULT 0',

  // levels / warns / action_log / embed_texts / saved_embeds
  'levels.lastMessage':       'INTEGER NOT NULL DEFAULT 0',
  'warns.reason':             'TEXT',
  'action_log.detail':        'TEXT',
  'action_log.userId':        'TEXT',
  'embed_texts.description':  "TEXT NOT NULL DEFAULT ''",
  'embed_texts.footer':       "TEXT NOT NULL DEFAULT ''",
  'saved_embeds.createdAt':   'INTEGER NOT NULL DEFAULT 0',
  'saved_embeds.updatedAt':   'INTEGER NOT NULL DEFAULT 0',

  // command_toggles / command_usage
  'command_toggles.at':       'INTEGER NOT NULL DEFAULT 0',
  'command_usage.lastUsed':   'INTEGER NOT NULL DEFAULT 0',

  // server_templates
  'server_templates.createdAt': 'INTEGER NOT NULL DEFAULT 0'
};

for (const [key, def] of Object.entries(COLUMN_MIGRATIONS)) {
  const dot = key.indexOf('.');
  addColumn(key.slice(0, dot), key.slice(dot + 1), def);
}

// =============================================================================
// CATCH-ALL FALLBACK
// Safety net that guarantees startup can never be blocked again by a column
// that was forgotten from COLUMN_MIGRATIONS above. Adds any still-missing
// column as nullable TEXT, which is safe for any column whose only role is
// being read or written with a value.
// =============================================================================
(function catchAllMigrations() {
  const SAFETY = {
    tickets: ['type', 'priority', 'closedBy', 'closeReason', 'lastActivityAt', 'createdAt', 'claimedBy', 'status', 'userId', 'guildId'],
    snipe_entries: ['jumpUrl', 'attachments', 'content', 'newContent', 'authorTag'],
    giveaways: ['messageId', 'participants', 'winnerIds', 'status', 'createdAt', 'channelId', 'durationMs', 'endsAt', 'prize', 'winners'],
    sticky_messages: ['data', 'lastMessageId', 'enabled', 'createdBy', 'createdAt', 'updatedAt', 'guildId', 'channelId'],
    staff_applications: ['decidedAt', 'reason', 'channelId', 'messageId', 'reviewerId', 'createdAt', 'answers', 'status'],
    memberships: ['plan', 'durationDays', 'note', 'expiresAt', 'createdAt'],
    levels: ['lastMessage', 'xp', 'level'],
    warns: ['reason', 'moderatorId', 'timestamp'],
    action_log: ['detail', 'userId', 'type', 'timestamp'],
    embed_texts: ['description', 'footer', 'title', 'sourceTitle', 'updatedAt'],
    saved_embeds: ['createdAt', 'updatedAt', 'data', 'name'],
    tickets_events: ['detail', 'actorId', 'event', 'ts'],
    ticket_events: ['detail', 'actorId', 'event', 'ts', 'guildId', 'channelId'],
    command_toggles: ['at', 'reason', 'byId'],
    command_usage: ['lastUsed', 'ok', 'fail'],
    server_templates: ['createdAt', 'guildName', 'createdBy', 'data'],
    snipe: ['jumpUrl'],
    log_config: ['enabled', 'details', 'channelId'],
    birthdays: ['month', 'day'],
    voicemaster_channels: ['guildId', 'ownerId'],
    antinuke_whitelist: ['userId'],
    sticky_roles: ['roles'],
    spam_tracker: ['count', 'windowStart'],
    join_tracker: ['timestamp'],
    emoji_overrides: ['value'],
    emoji_snapshots: ['data', 'createdAt'],
    owner_config: ['data'],
    error_log: ['source', 'command', 'guildId', 'userId', 'message', 'stack', 'ts'],
    owner_audit: ['userId', 'command', 'args', 'guildId', 'ts'],
    scheduled_events: ['messageId', 'kind', 'data', 'at'],
    guild_config: ['data']
  };
  let added = 0;
  for (const [table, cols] of Object.entries(SAFETY)) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    for (const col of cols) {
      if (!hasColumn(table, col)) {
        try {
          db.exec(`ALTER TABLE "${table}" ADD COLUMN "${col}" TEXT`);
          console.log(`[migration] catch-all added ${table}.${col}`);
          added++;
        } catch (e) {
          console.error(`[migration] catch-all failed for ${table}.${col}: ${e.message}`);
        }
      }
    }
  }
  if (added) console.log(`[migration] catch-all added ${added} column(s).`);
})();

// =============================================================================
// MIGRATION VALIDATION
// Fail loudly if a column every query needs is still missing.
// =============================================================================
const REQUIRED_COLUMNS = {
  guild_config:           ['guildId', 'data'],
  levels:                 ['guildId', 'userId', 'xp', 'level', 'lastMessage'],
  warns:                  ['id', 'guildId', 'userId', 'moderatorId', 'reason', 'timestamp'],
  tickets:                ['channelId', 'guildId', 'userId', 'status', 'claimedBy', 'type', 'priority', 'closedBy', 'closeReason', 'lastActivityAt', 'createdAt'],
  ticket_events:          ['id', 'guildId', 'channelId', 'actorId', 'event', 'detail', 'ts'],
  voicemaster_channels:   ['channelId', 'guildId', 'ownerId'],
  antinuke_whitelist:     ['guildId', 'userId'],
  action_log:             ['id', 'guildId', 'userId', 'type', 'detail', 'timestamp'],
  sticky_roles:           ['guildId', 'userId', 'roles'],
  spam_tracker:           ['guildId', 'userId', 'count', 'windowStart'],
  join_tracker:           ['guildId', 'userId', 'timestamp'],
  emoji_overrides:        ['name', 'value'],
  emoji_snapshots:        ['code', 'data', 'createdAt'],
  embed_texts:            ['name', 'sourceTitle', 'title', 'description', 'footer', 'updatedAt'],
  owner_config:           ['id', 'data'],
  memberships:            ['guildId', 'plan', 'durationDays', 'createdAt', 'expiresAt', 'note'],
  giveaways:              ['id', 'guildId', 'hostId', 'prize', 'winners', 'durationMs', 'endsAt', 'channelId', 'messageId', 'participants', 'winnerIds', 'status', 'createdAt'],
  saved_embeds:           ['guildId', 'name', 'data', 'createdAt', 'updatedAt'],
  sticky_messages:        ['guildId', 'channelId', 'data', 'lastMessageId', 'enabled', 'createdBy', 'createdAt', 'updatedAt'],
  staff_applications:     ['id', 'guildId', 'userId', 'status', 'answers', 'channelId', 'messageId', 'reviewerId', 'reason', 'createdAt', 'decidedAt'],
  command_toggles:        ['name', 'reason', 'byId', 'at'],
  error_log:              ['id', 'ts', 'source', 'command', 'guildId', 'userId', 'message', 'stack'],
  owner_audit:            ['id', 'userId', 'command', 'args', 'guildId', 'ts'],
  command_usage:          ['day', 'guildId', 'name', 'ok', 'fail', 'lastUsed'],
  birthdays:              ['guildId', 'userId', 'month', 'day'],
  log_config:             ['guildId', 'category', 'channelId', 'enabled', 'details'],
  snipe_entries:          ['id', 'guildId', 'channelId', 'messageId', 'authorId', 'authorTag', 'action', 'content', 'newContent', 'attachments', 'jumpUrl', 'ts'],
  scheduled_events:       ['id', 'guildId', 'channelId', 'messageId', 'kind', 'data', 'at'],
  server_templates:       ['code', 'guildId', 'guildName', 'data', 'createdBy', 'createdAt']
};
{
  const problems = [];
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    for (const c of cols) if (!hasColumn(table, c)) problems.push(`${table}.${c}`);
  }
  if (problems.length) {
    console.error('❌ Database validation failed. Missing column(s):');
    for (const p of problems) console.error(`   • ${p}`);
    console.error(`   DB path: ${DB_PATH}`);
    console.error('   The volume is likely read-only or full.');
    process.exit(1);
  }
  console.log(`[AunXz] Database schema OK (${Object.keys(REQUIRED_COLUMNS).length} tables).`);
}

// =============================================================================
// DEFAULT CONFIG
// =============================================================================
const DEFAULT_CONFIG = {
  prefix: '!',
  logs: { default: null, message: null, member: null, mod: null, voice: null, security: null, ticket: null, server: null, system: null, antinuke: null, join: null },
  appearance: { color: null, preset: 'black' },
  welcome: { enabled: false, channel: null, message: 'Welcome {user} to {server}! You are member #{count}.', autoroleId: null, image: null, ping: true, showAvatar: true, title: 'Welcome' },
  leave: { enabled: false, channel: null, message: '{user} has left the server.' },
  boost: { enabled: false, channel: null, message: '{user} just boosted the server!' },
  greetmessage: { enabled: false, channelId: null, message: 'Welcome {user}!', image: null, title: 'Welcome', color: null, showAvatar: true, ping: true },
  greetvoice: { enabled: false, roleId: null, vcId: null, ttsPrompt: null, ttsVoice: 'us', audioPath: null, mode: 'tts', cooldownSeconds: 30 },
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
  suggestions: { enabled: false, channelId: null },
  polls: { enabled: true },
  snipeEnabled: true,
  nsfwFilter: { enabled: false },
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
    enabled: true, channelId: null, action: 'kick', cleanupWindow: 'none', createInvite: false,
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
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}

// =============================================================================
// CONFIG (cached, 5s TTL)
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
  try { stored = row ? JSON.parse(row.data) : {}; } catch {}
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
const levelGet = db.prepare('SELECT * FROM levels WHERE guildId=? AND userId=?');
const levelUpsert = db.prepare(`INSERT INTO levels (guildId,userId,xp,level,lastMessage) VALUES (?,?,?,?,?)
  ON CONFLICT(guildId,userId) DO UPDATE SET xp=excluded.xp, level=excluded.level, lastMessage=excluded.lastMessage`);
const levelTop = db.prepare('SELECT * FROM levels WHERE guildId=? ORDER BY xp DESC LIMIT ?');
function getLevel(g, u) { return levelGet.get(g, u) || { guildId: g, userId: u, xp: 0, level: 0, lastMessage: 0 }; }
function setLevel(g, u, xp, level, last) { levelUpsert.run(g, u, xp, level, last); }
function topLevels(g, limit = 10) { return levelTop.all(g, limit); }

// =============================================================================
// WARNS
// =============================================================================
const warnAdd = db.prepare('INSERT INTO warns (guildId,userId,moderatorId,reason,timestamp) VALUES (?,?,?,?,?)');
const warnGet = db.prepare('SELECT * FROM warns WHERE guildId=? AND userId=? ORDER BY timestamp DESC');
const warnClear = db.prepare('DELETE FROM warns WHERE guildId=? AND userId=?');
function addWarn(g, u, m, r) { warnAdd.run(g, u, m, r, Date.now()); }
function getWarns(g, u) { return warnGet.all(g, u); }
function clearWarns(g, u) { warnClear.run(g, u); }

// =============================================================================
// TICKETS
// =============================================================================
const ticketCreate = db.prepare('INSERT INTO tickets(channelId,guildId,userId,status,createdAt) VALUES (?,?,?,?,?)');
const ticketGet = db.prepare('SELECT * FROM tickets WHERE channelId = ?');
const ticketSetWithClaim = db.prepare('UPDATE tickets SET status=?, claimedBy=?, lastActivityAt=? WHERE channelId=?');
const ticketSetOnly = db.prepare('UPDATE tickets SET status=?, lastActivityAt=? WHERE channelId=?');
const ticketOpen = db.prepare("SELECT * FROM tickets WHERE guildId=? AND userId=? AND status='open'");
const ticketSetType = db.prepare('UPDATE tickets SET type=? WHERE channelId=?');
const ticketSetClose = db.prepare('UPDATE tickets SET closedBy=?, closeReason=? WHERE channelId=?');

function createTicket(c, g, u) {
  ticketCreate.run(c, g, u, 'open', Date.now());
  return getTicket(c);
}
function getTicket(c) { return ticketGet.get(c); }
function setTicketStatus(c, s, claimedBy) {
  const now = Date.now();
  if (claimedBy === undefined) ticketSetOnly.run(s, now, c);
  else ticketSetWithClaim.run(s, claimedBy, now, c);
}
function openTicketsForUser(g, u) { return ticketOpen.all(g, u); }
function setTicketType(c, t) { ticketSetType.run(String(t || 'general'), c); }
function setTicketClose(c, by, reason) { ticketSetClose.run(by || null, reason || null, c); }

const teIns = db.prepare('INSERT INTO ticket_events (guildId,channelId,actorId,event,detail,ts) VALUES (?,?,?,?,?,?)');
const teList = db.prepare('SELECT * FROM ticket_events WHERE guildId=? AND channelId=? ORDER BY id DESC LIMIT ?');
function logTicketEvent(g, c, actor, event, detail) {
  teIns.run(g, c, actor || null, event, detail || null, Date.now());
}
function ticketEventsFor(g, c, limit = 100) { return teList.all(g, c, limit); }

// =============================================================================
// VOICEMASTER
// =============================================================================
const vmAdd = db.prepare('INSERT OR REPLACE INTO voicemaster_channels(channelId,guildId,ownerId) VALUES (?,?,?)');
const vmGet = db.prepare('SELECT * FROM voicemaster_channels WHERE channelId = ?');
const vmDel = db.prepare('DELETE FROM voicemaster_channels WHERE channelId = ?');
function addVMChannel(c, g, o) { vmAdd.run(c, g, o); }
function getVMChannel(c) { return vmGet.get(c); }
function removeVMChannel(c) { vmDel.run(c); }

// =============================================================================
// WHITELIST
// =============================================================================
const wlAdd = db.prepare('INSERT OR IGNORE INTO antinuke_whitelist(guildId,userId) VALUES (?,?)');
const wlRem = db.prepare('DELETE FROM antinuke_whitelist WHERE guildId=? AND userId=?');
const wlCheck = db.prepare('SELECT 1 FROM antinuke_whitelist WHERE guildId=? AND userId=?');
const wlList = db.prepare('SELECT userId FROM antinuke_whitelist WHERE guildId=?');
function addToWhitelist(g, u) { wlAdd.run(g, u); }
function removeFromWhitelist(g, u) { wlRem.run(g, u); }
function isWhitelisted(g, u) { return !!wlCheck.get(g, u); }
function listWhitelist(g) { return wlList.all(g).map(r => r.userId); }

// =============================================================================
// ACTION LOG
// =============================================================================
const actLog = db.prepare('INSERT INTO action_log(guildId,userId,type,detail,timestamp) VALUES (?,?,?,?,?)');
const actRecent = db.prepare('SELECT * FROM action_log WHERE guildId=? ORDER BY timestamp DESC LIMIT ?');
function logAction(g, u, t, d) { actLog.run(g, u, t, d || null, Date.now()); }
function recentActions(g, limit = 15) { return actRecent.all(g, limit); }

// =============================================================================
// STICKY ROLES
// =============================================================================
const srGet = db.prepare('SELECT roles FROM sticky_roles WHERE guildId=? AND userId=?');
const srSet = db.prepare('INSERT INTO sticky_roles(guildId,userId,roles) VALUES (?,?,?) ON CONFLICT(guildId,userId) DO UPDATE SET roles=excluded.roles');
function getStickyRoles(g, u) { const r = srGet.get(g, u); try { return r ? JSON.parse(r.roles) : []; } catch { return []; } }
function setStickyRoles(g, u, roles) { srSet.run(g, u, JSON.stringify(roles || [])); }

// =============================================================================
// SPAM / JOINS
// =============================================================================
const spamGet = db.prepare('SELECT * FROM spam_tracker WHERE guildId=? AND userId=?');
const spamIns = db.prepare('INSERT OR REPLACE INTO spam_tracker(guildId,userId,count,windowStart) VALUES (?,?,?,?)');
const spamUpd = db.prepare('UPDATE spam_tracker SET count=? WHERE guildId=? AND userId=?');
function bumpSpam(g, u, windowSec) {
  const now = Date.now();
  const r = spamGet.get(g, u);
  if (!r || now - r.windowStart > windowSec * 1000) { spamIns.run(g, u, 1, now); return 1; }
  const n = r.count + 1; spamUpd.run(n, g, u); return n;
}
const joinAdd = db.prepare('INSERT INTO join_tracker(guildId,userId,timestamp) VALUES (?,?,?)');
const joinCount = db.prepare('SELECT COUNT(*) c FROM join_tracker WHERE guildId=? AND timestamp>?');
const joinPurge = db.prepare('DELETE FROM join_tracker WHERE guildId=? AND timestamp<?');
function trackJoin(g, u) { joinAdd.run(g, u, Date.now()); }
function recentJoinCount(g, w) { return joinCount.get(g, Date.now() - w * 1000).c; }
function pruneJoins(g, sec) { joinPurge.run(g, Date.now() - sec * 1000); }

// =============================================================================
// EMOJIS
// =============================================================================
const eoGet = db.prepare('SELECT value FROM emoji_overrides WHERE name=?');
const eoSet = db.prepare('INSERT INTO emoji_overrides(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value');
const eoDel = db.prepare('DELETE FROM emoji_overrides WHERE name=?');
const eoAll = db.prepare('SELECT name,value FROM emoji_overrides');
function getEmojiOverride(n) { return eoGet.get(n)?.value || null; }
function setEmojiOverride(n, v) { eoSet.run(n, v); }
function resetEmojiOverride(n) { eoDel.run(n); }
function getAllEmojiOverrides() { const o = {}; for (const r of eoAll.all()) o[r.name] = r.value; return o; }

const esSave = db.prepare('INSERT INTO emoji_snapshots(code,data,createdAt) VALUES (?,?,?)');
const esGet = db.prepare('SELECT data FROM emoji_snapshots WHERE code=?');
function saveEmojiSnapshot(values) {
  const code = 'EM-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
  esSave.run(code, JSON.stringify(values || {}), Date.now());
  return code;
}
function getEmojiSnapshot(code) {
  const r = esGet.get(String(code || '').trim());
  if (!r) return null;
  try { return JSON.parse(r.data); } catch { return null; }
}

// =============================================================================
// EMBED TEXTS
// =============================================================================
const etGet = db.prepare('SELECT * FROM embed_texts WHERE lower(name)=lower(?) OR lower(sourceTitle)=lower(?) LIMIT 1');
const etUpsert = db.prepare(`INSERT INTO embed_texts(name,sourceTitle,title,description,footer,updatedAt) VALUES (?,?,?,?,?,?)
  ON CONFLICT(name) DO UPDATE SET sourceTitle=excluded.sourceTitle, updatedAt=excluded.updatedAt`);
const etList = db.prepare('SELECT * FROM embed_texts ORDER BY updatedAt DESC LIMIT ?');
const etUpdate = db.prepare('UPDATE embed_texts SET title=?, description=?, footer=?, updatedAt=? WHERE name=?');

function registerEmbedText(sourceTitle, description = '', footer = '') {
  const name = String(sourceTitle || 'embed')
    .replace(/<@!?\d+>/g, '@user')
    .replace(/\d{15,25}/g, 'id')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim().replace(/\s+/g, '-').toLowerCase().slice(0, 70) || 'embed';
  etUpsert.run(name, String(sourceTitle), String(sourceTitle), String(description || ''), String(footer || ''), Date.now());
  return etGet.get(name, name);
}
function getEmbedText(name) { return etGet.get(name, name) || null; }
function listEmbedTexts(limit = 500) { return etList.all(limit); }
function updateEmbedText(name, patch) {
  const row = getEmbedText(name);
  if (!row) return null;
  etUpdate.run(patch.title ?? row.title, patch.description ?? row.description, patch.footer ?? row.footer, Date.now(), row.name);
  return getEmbedText(row.name);
}

// =============================================================================
// OWNER
// =============================================================================
const ocGet = db.prepare('SELECT data FROM owner_config WHERE id = 1');
const ocUpsert = db.prepare('INSERT INTO owner_config(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data');
function getOwnerConfig() {
  const r = ocGet.get();
  if (!r) return {};
  try { return JSON.parse(r.data) || {}; } catch { return {}; }
}
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

const oaIns = db.prepare('INSERT INTO owner_audit (userId,command,args,guildId,ts) VALUES (?,?,?,?,?)');
const oaPrune = db.prepare('DELETE FROM owner_audit WHERE id NOT IN (SELECT id FROM owner_audit ORDER BY id DESC LIMIT 1000)');
function logOwnerAudit(userId, command, args, guildId) {
  oaIns.run(String(userId), String(command), String(args || '').slice(0, 500), guildId ? String(guildId) : null, Date.now());
  oaPrune.run();
}

// =============================================================================
// MEMBERSHIPS
// =============================================================================
const msGet = db.prepare('SELECT * FROM memberships WHERE guildId=?');
const msUpsert = db.prepare(`INSERT INTO memberships(guildId,plan,durationDays,createdAt,expiresAt,note) VALUES (?,?,?,?,?,?)
  ON CONFLICT(guildId) DO UPDATE SET plan=excluded.plan, durationDays=excluded.durationDays, createdAt=excluded.createdAt, expiresAt=excluded.expiresAt, note=excluded.note`);
const msDel = db.prepare('DELETE FROM memberships WHERE guildId=?');
const msList = db.prepare('SELECT * FROM memberships ORDER BY expiresAt DESC');
function membership(g) { return msGet.get(g) || null; }
function addMembership(g, { days = 30, plan = null, note = '' } = {}) {
  const n = Math.max(1, Number(days) || 30);
  const now = Date.now();
  const old = membership(g);
  const start = old && old.expiresAt > now ? old.expiresAt : now;
  const expires = start + n * 86400000;
  const label = plan || `${n} Days`;
  msUpsert.run(g, label, n, now, expires, String(note || ''));
  return membership(g);
}
function removeMembership(g) { msDel.run(g); }
function listMemberships() {
  return msList.all().map(r => ({ ...r, status: Date.now() < r.expiresAt ? 'active' : 'expired' }));
}

// =============================================================================
// GIVEAWAYS
// =============================================================================
const gCreate = db.prepare('INSERT INTO giveaways(guildId,hostId,prize,winners,durationMs,endsAt,channelId,status,createdAt) VALUES (?,?,?,?,?,?,?,?,?)');
const gGet = db.prepare('SELECT * FROM giveaways WHERE guildId=? AND id=?');
const gList = db.prepare('SELECT * FROM giveaways WHERE guildId=? ORDER BY id DESC LIMIT ?');
const gActive = db.prepare("SELECT * FROM giveaways WHERE status='active' ORDER BY endsAt ASC");

function createGiveaway(guildId, hostId, { prize, winners = 1, durationMs, channelId }) {
  const now = Date.now();
  const r = gCreate.run(
    guildId, hostId, String(prize), Math.max(1, Number(winners) || 1),
    Number(durationMs) || 0, now + (Number(durationMs) || 0),
    channelId || null, 'configuring', now
  );
  return getGiveaway(guildId, r.lastInsertRowid);
}
function getGiveaway(g, id) { return gGet.get(g, Number(id)); }
function listGiveaways(g, limit = 50) { return gList.all(g, limit); }
function listActiveGiveaways() { return gActive.all(); }
function updateGiveaway(g, id, patch) {
  const row = getGiveaway(g, id);
  if (!row) return null;
  const allowed = ['prize', 'winners', 'endsAt', 'durationMs', 'channelId', 'messageId', 'participants', 'status', 'winnerIds'];
  const fields = Object.keys(patch).filter(k => allowed.includes(k));
  if (!fields.length) return row;
  const set = fields.map(f => `${f}=?`).join(',');
  db.prepare(`UPDATE giveaways SET ${set} WHERE guildId=? AND id=?`).run(...fields.map(f => patch[f]), g, Number(id));
  return getGiveaway(g, id);
}

// =============================================================================
// SAVED EMBEDS
// =============================================================================
const eSave = db.prepare('INSERT INTO saved_embeds(guildId,name,data,createdAt,updatedAt) VALUES (?,?,?,?,?) ON CONFLICT(guildId,name) DO UPDATE SET data=excluded.data,updatedAt=excluded.updatedAt');
const eGet = db.prepare('SELECT * FROM saved_embeds WHERE guildId=? AND lower(name)=lower(?)');
const eList = db.prepare('SELECT * FROM saved_embeds WHERE guildId=? ORDER BY updatedAt DESC');
const eDel = db.prepare('DELETE FROM saved_embeds WHERE guildId=? AND lower(name)=lower(?)');
function saveEmbed(g, name, data) {
  const now = Date.now();
  eSave.run(g, name, JSON.stringify(data), now, now);
  return getEmbed(g, name);
}
function getEmbed(g, name) {
  const r = eGet.get(g, name);
  if (!r) return null;
  try { return { ...r, data: JSON.parse(r.data) }; } catch { return null; }
}
function listEmbeds(g) { return eList.all(g).map(r => { try { return { ...r, data: JSON.parse(r.data) }; } catch { return r; } }); }
function deleteEmbed(g, name) { return eDel.run(g, name).changes > 0; }

// =============================================================================
// ROLE PANELS (stored inside guild_config JSON)
// =============================================================================
function panelKey(kind) { return kind === 'button' ? 'buttonRolePanels' : 'reactionRolePanels'; }
function findPanel(g, kind, id) { return (getConfig(g)[panelKey(kind)] || []).find(p => p.id === id) || null; }
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
    ...r,
    enabled: !!r.enabled,
    data: (() => { try { return JSON.parse(r.data); } catch { return {}; } })()
  } : null;
}
const sGet = db.prepare('SELECT * FROM sticky_messages WHERE channelId = ?');
const sList = db.prepare('SELECT * FROM sticky_messages WHERE guildId = ? ORDER BY createdAt ASC');
const sSave = db.prepare(`INSERT INTO sticky_messages (guildId,channelId,data,enabled,createdBy,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(guildId, channelId) DO UPDATE SET data=excluded.data, enabled=excluded.enabled, updatedAt=excluded.updatedAt`);
const sMsgId = db.prepare('UPDATE sticky_messages SET lastMessageId=?, updatedAt=? WHERE channelId=?');
const sEnable = db.prepare('UPDATE sticky_messages SET enabled=?, updatedAt=? WHERE channelId=?');
const sDel = db.prepare('DELETE FROM sticky_messages WHERE channelId=?');

function getSticky(c) { return stickyRow(sGet.get(c)); }
function listStickies(g) { return sList.all(g).map(stickyRow); }
function saveSticky(g, c, { data, enabled = true, createdBy = null } = {}) {
  const now = Date.now();
  sSave.run(g, c, JSON.stringify(data || {}), enabled ? 1 : 0, createdBy, now, now);
  return getSticky(c);
}
function setStickyMessageId(c, m) { sMsgId.run(m || null, Date.now(), c); }
function setStickyEnabled(c, e) { sEnable.run(e ? 1 : 0, Date.now(), c); return getSticky(c); }
function deleteSticky(c) { return sDel.run(c).changes > 0; }

// =============================================================================
// STAFF APPLICATIONS
// =============================================================================
function appRow(r) {
  return r ? { ...r, answers: (() => { try { return JSON.parse(r.answers); } catch { return []; } })() } : null;
}
const aCreate = db.prepare('INSERT INTO staff_applications(guildId,userId,status,answers,createdAt) VALUES (?,?,?,?,?)');
const aGet = db.prepare('SELECT * FROM staff_applications WHERE id=?');
const aPending = db.prepare("SELECT * FROM staff_applications WHERE guildId=? AND userId=? AND status='pending' ORDER BY id DESC LIMIT 1");
const aLast = db.prepare('SELECT * FROM staff_applications WHERE guildId=? AND userId=? ORDER BY id DESC LIMIT 1');

function createApplication(g, u, answers) {
  const r = aCreate.run(g, u, 'pending', JSON.stringify(answers || []), Date.now());
  return getApplication(r.lastInsertRowid);
}
function getApplication(id) { return appRow(aGet.get(Number(id))); }
function pendingApplicationForUser(g, u) { return appRow(aPending.get(g, u)); }
function lastApplicationForUser(g, u) { return appRow(aLast.get(g, u)); }
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
const tList = db.prepare('SELECT * FROM command_toggles ORDER BY at DESC');
const tSet = db.prepare('INSERT INTO command_toggles(name,reason,byId,at) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET reason=excluded.reason,byId=excluded.byId,at=excluded.at');
const tDel = db.prepare('DELETE FROM command_toggles WHERE name=?');
function listToggles() {
  if (!toggleCache) {
    toggleCache = tList.all();
    setTimeout(() => { toggleCache = null; }, 10000).unref?.();
  }
  return toggleCache;
}
function getToggle(name) { return listToggles().find(t => t.name === String(name).toLowerCase()) || null; }
function setToggle(name, reason, byId) {
  tSet.run(String(name).toLowerCase(), reason || null, String(byId), Date.now());
  toggleCache = null;
}
function removeToggle(name) {
  const c = tDel.run(String(name).toLowerCase()).changes;
  toggleCache = null;
  return c > 0;
}

// =============================================================================
// ERRORS
// =============================================================================
const errIns = db.prepare('INSERT INTO error_log(ts,source,command,guildId,userId,message,stack) VALUES (?,?,?,?,?,?,?)');
const errPrune = db.prepare('DELETE FROM error_log WHERE id NOT IN (SELECT id FROM error_log ORDER BY id DESC LIMIT 200)');
const errList = db.prepare('SELECT * FROM error_log ORDER BY id DESC');
const errListCmd = db.prepare('SELECT * FROM error_log WHERE lower(command)=lower(?) ORDER BY id DESC');
const errClear = db.prepare('DELETE FROM error_log');
const errClearCmd = db.prepare('DELETE FROM error_log WHERE lower(command)=lower(?)');
function recordError({ source = null, command = null, guildId = null, userId = null, message = '', stack = '' } = {}) {
  errIns.run(
    Date.now(), source, command, guildId, userId,
    String(message || '').slice(0, 2000),
    String(stack || '').slice(0, 20000)
  );
  errPrune.run();
}
function listErrors(command = null) { return command ? errListCmd.all(command) : errList.all(); }
function clearErrors(command = null) { return (command ? errClearCmd.run(command) : errClear.run()).changes; }

// =============================================================================
// COMMAND USAGE
// =============================================================================
const cuUpsert = db.prepare(`INSERT INTO command_usage (day,guildId,name,ok,fail,lastUsed) VALUES (?,?,?,?,?,?)
  ON CONFLICT(day,guildId,name) DO UPDATE SET ok=ok+excluded.ok, fail=fail+excluded.fail, lastUsed=excluded.lastUsed`);
function utcDay(ts = Date.now()) { return new Date(ts).toISOString().slice(0, 10); }
function trackCommandUse(name, guildId, ok) {
  cuUpsert.run(utcDay(), guildId || 'dm', String(name), ok ? 1 : 0, ok ? 0 : 1, Date.now());
}
function commandUsage({ range = 'all', guildId = null } = {}) {
  const where = []; const args = [];
  if (range === 'today') { where.push('day = ?'); args.push(utcDay()); }
  else if (range === 'week') { where.push('day >= ?'); args.push(utcDay(Date.now() - 6 * 86400000)); }
  if (guildId) { where.push('guildId = ?'); args.push(guildId); }
  return db.prepare(`SELECT name, SUM(ok) ok, SUM(fail) fail, MAX(lastUsed) lastUsed FROM command_usage ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY name ORDER BY (SUM(ok)+SUM(fail)) DESC`).all(...args);
}

// =============================================================================
// BIRTHDAYS
// =============================================================================
const bSet = db.prepare('INSERT INTO birthdays(guildId,userId,month,day) VALUES (?,?,?,?) ON CONFLICT(guildId,userId) DO UPDATE SET month=excluded.month, day=excluded.day');
const bFor = db.prepare('SELECT * FROM birthdays WHERE month=? AND day=?');
function setBirthday(g, u, m, d) { bSet.run(g, u, m, d); }
function birthdaysFor(m, d) { return bFor.all(m, d); }

// =============================================================================
// LOG CONFIG
// =============================================================================
const lGet = db.prepare('SELECT * FROM log_config WHERE guildId=? AND category=?');
const lList = db.prepare('SELECT * FROM log_config WHERE guildId=?');
const lSet = db.prepare(`INSERT INTO log_config (guildId,category,channelId,enabled,details) VALUES (?,?,?,?,?)
  ON CONFLICT(guildId,category) DO UPDATE SET channelId=excluded.channelId, enabled=excluded.enabled, details=excluded.details`);
function getLogConfig(g, cat) { return lGet.get(g, cat) || null; }
function listLogConfig(g) { return lList.all(g); }
function setLogConfig(g, cat, patch) {
  const cur = getLogConfig(g, cat) || { guildId: g, category: cat, channelId: null, enabled: 1, details: 1 };
  const next = { ...cur, ...patch };
  lSet.run(g, cat, next.channelId, next.enabled ? 1 : 0, next.details ? 1 : 0);
  return getLogConfig(g, cat);
}

// =============================================================================
// SNIPE
// =============================================================================
const snIns = db.prepare(`INSERT INTO snipe_entries (guildId,channelId,messageId,authorId,authorTag,action,content,newContent,attachments,jumpUrl,ts) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const snTrim = db.prepare(`DELETE FROM snipe_entries WHERE id NOT IN (SELECT id FROM snipe_entries WHERE guildId=? AND channelId=? ORDER BY id DESC LIMIT 50) AND guildId=? AND channelId=?`);
const snList = db.prepare('SELECT * FROM snipe_entries WHERE guildId=? AND channelId=? ORDER BY id DESC LIMIT ?');
const snAt = db.prepare('SELECT * FROM snipe_entries WHERE guildId=? AND channelId=? ORDER BY id DESC LIMIT 1 OFFSET ?');
const snCount = db.prepare('SELECT COUNT(*) c FROM snipe_entries WHERE guildId=? AND channelId=?');
const snPrune = db.prepare('DELETE FROM snipe_entries WHERE guildId=? AND ts<?');
function parseAtt(s) { try { return JSON.parse(s || '[]'); } catch { return []; } }
function addSnipe(e) {
  snIns.run(
    e.guildId, e.channelId, e.messageId, e.authorId, e.authorTag || null, e.action,
    e.content || null, e.newContent || null,
    JSON.stringify(e.attachments || []), e.jumpUrl || null, Date.now()
  );
  snTrim.run(e.guildId, e.channelId, e.guildId, e.channelId);
}
function getSnipes(g, c, limit = 50) {
  return snList.all(g, c, limit).map(r => ({ ...r, attachments: parseAtt(r.attachments) }));
}
function getSnipeAt(g, c, offset) {
  const r = snAt.get(g, c, offset);
  return r ? { ...r, attachments: parseAtt(r.attachments) } : null;
}
function snipesCount(g, c) { return snCount.get(g, c).c; }
function pruneSnipes(g, days = 7) { return snPrune.run(g, Date.now() - days * 86400000).changes; }

// =============================================================================
// SCHEDULED EVENTS
// =============================================================================
const seIns = db.prepare('INSERT INTO scheduled_events(guildId,channelId,messageId,kind,data,at) VALUES (?,?,?,?,?,?)');
const seDue = db.prepare('SELECT * FROM scheduled_events WHERE at <= ? ORDER BY at ASC LIMIT ?');
const seDel = db.prepare('DELETE FROM scheduled_events WHERE id=?');
function scheduleEvent(g, c, messageId, kind, data, at) {
  return seIns.run(g, c, messageId || null, kind, JSON.stringify(data || {}), at).lastInsertRowid;
}
function dueEvents(now = Date.now(), limit = 25) { return seDue.all(now, limit); }
function deleteEvent(id) { seDel.run(id); }

// =============================================================================
// SERVER TEMPLATES
// =============================================================================
const tplIns = db.prepare('INSERT INTO server_templates(code,guildId,guildName,data,createdBy,createdAt) VALUES (?,?,?,?,?,?)');
const tplGet = db.prepare('SELECT * FROM server_templates WHERE code=?');
const tplList = db.prepare('SELECT code,guildId,guildName,createdBy,createdAt,length(data) AS size FROM server_templates WHERE guildId=? ORDER BY createdAt DESC');
const tplDel = db.prepare('DELETE FROM server_templates WHERE code=? AND guildId=?');
function newTemplateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return 'AX-' + out;
}
function saveTemplate(g, name, data, by) {
  let code = newTemplateCode();
  while (tplGet.get(code)) code = newTemplateCode();
  tplIns.run(code, g, String(name || ''), data, by || null, Date.now());
  return code;
}
function getTemplate(code) { return tplGet.get(String(code || '').trim().toUpperCase()) || null; }
function listTemplates(g) { return tplList.all(g); }
function deleteTemplate(code, g) { return tplDel.run(String(code || '').trim().toUpperCase(), g).changes > 0; }

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
  saveEmojiSnapshot, getEmojiSnapshot,

  // embed texts
  registerEmbedText, getEmbedText, listEmbedTexts, updateEmbedText,

  // owner
  getOwnerConfig, saveOwnerConfig, getGlobalBlacklist, addGlobalBlacklist, removeGlobalBlacklist,
  logOwnerAudit,

  // memberships
  membership, addMembership, removeMembership, listMemberships,

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

  // command usage
  trackCommandUse, commandUsage,

  // birthdays
  setBirthday, birthdaysFor,

  // logging
  getLogConfig, listLogConfig, setLogConfig,

  // snipe
  addSnipe, getSnipes, getSnipeAt, snipesCount, pruneSnipes,

  // scheduled events
  scheduleEvent, dueEvents, deleteEvent,

  // server templates
  saveTemplate, getTemplate, listTemplates, deleteTemplate,

  // backup / restore
  exportGuild, importGuild
};