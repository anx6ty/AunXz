// database.js — persistent SQLite storage for AunXz.
// Safe migrations only: existing data is never wiped.

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function ensureParent(filePath) {
  const parent = path.dirname(filePath);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
}

function resolveDatabasePath() {
  if (process.env.DATABASE_PATH) return path.resolve(process.env.DATABASE_PATH);
  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (volume) return path.join(path.resolve(volume), 'aunxz.sqlite');
  return path.join(__dirname, 'data', 'aunxz.sqlite');
}

const DB_PATH = resolveDatabasePath();
const DATA_DIR = path.dirname(DB_PATH);
ensureParent(DB_PATH);

// When a Railway Volume was attached after the bot had already been using a local
// SQLite file, move the old database into the volume once, before opening the new DB.
// SQLite WAL is checkpointed first so no uncommitted pages are lost during migration.
function migrateLegacyDatabase(target) {
  if (fs.existsSync(target)) return;
  const candidates = [
    path.join(__dirname, 'bot.sqlite'),
    path.join(__dirname, 'aunxz.sqlite'),
    path.join(__dirname, 'data', 'bot.sqlite')
  ];
  const source = candidates.find(file => file !== target && fs.existsSync(file));
  if (!source) return;
  try {
    const legacy = new Database(source);
    try { legacy.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    try { legacy.close(); } catch {}
    fs.copyFileSync(source, target);
    console.log(`[AunXz] Migrated legacy SQLite database to persistent path: ${target}`);
  } catch (error) {
    console.error('[AunXz] Legacy SQLite migration failed:', error);
  }
}

migrateLegacyDatabase(DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}
function addColumn(table, column, definition) {
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

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
CREATE TABLE IF NOT EXISTS embed_texts (
  name TEXT PRIMARY KEY,
  sourceTitle TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  footer TEXT NOT NULL DEFAULT '',
  uses INTEGER NOT NULL DEFAULT 0,
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
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
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
  status TEXT NOT NULL DEFAULT 'configuring',
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_embeds (
  guildId TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (guildId, name)
);
`);

// Safe migration for old giveaway tables created before durationMs existed.
addColumn('giveaways', 'durationMs', 'INTEGER NOT NULL DEFAULT 0');
addColumn('giveaways', 'endsAt', 'INTEGER NOT NULL DEFAULT 0');
addColumn('giveaways', 'messageId', 'TEXT');
addColumn('giveaways', 'participants', "TEXT NOT NULL DEFAULT '[]'");
addColumn('giveaways', 'status', "TEXT NOT NULL DEFAULT 'configuring'");
addColumn('giveaways', 'createdAt', 'INTEGER NOT NULL DEFAULT 0');
addColumn('giveaways', 'winnerIds', "TEXT NOT NULL DEFAULT '[]'"); // reroll support

// Additive tables only (CREATE IF NOT EXISTS) — no existing table or key is touched.
db.exec(`
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
CREATE TABLE IF NOT EXISTS owner_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT NOT NULL,
  command TEXT NOT NULL,
  args TEXT,
  guildId TEXT,
  ts INTEGER NOT NULL
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
CREATE TABLE IF NOT EXISTS command_usage (
  day TEXT NOT NULL,
  guildId TEXT NOT NULL,
  name TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  fail INTEGER NOT NULL DEFAULT 0,
  lastUsed INTEGER NOT NULL,
  PRIMARY KEY (day, guildId, name)
);
CREATE TABLE IF NOT EXISTS command_toggles (
  name TEXT PRIMARY KEY,
  reason TEXT,
  byId TEXT,
  at INTEGER NOT NULL
);
`);

// Server templates (/template save) — full snapshots stored by short code, additive table only.
db.exec(`
CREATE TABLE IF NOT EXISTS server_templates (
  code TEXT PRIMARY KEY,
  guildId TEXT NOT NULL,
  guildName TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL,
  createdBy TEXT,
  createdAt INTEGER NOT NULL
);
`);

const DEFAULT_CONFIG = {
  prefix: '!',
  logs: { mod: null, message: null, member: null, voice: null, antinuke: null, server: null, ticket: null, join: null },
  welcome: { enabled: false, channel: null, message: 'Welcome {user} to {server}! You are member #{count}.', autoroleId: null },
  leave: { enabled: false, channel: null, message: '{user} has left the server.' },
  boost: { enabled: false, channel: null, message: '{user} just boosted the server! 🚀' },
  greetvoice: { enabled: false, roleId: null, vcId: null, ttsPrompt: null, ttsVoice: 'us', audioPath: null, mode: 'tts', cooldownSeconds: 30 },
  greetmessage: { enabled: false, channelId: null, message: 'Welcome {user}!', image: null, title: '👋 Welcome!', color: null, showAvatar: true, ping: true },
  antinuke: {
    enabled: false, punishment: 'ban', maxChannelDeletes: 3, maxChannelCreates: 5, maxRoleDeletes: 3, maxRoleCreates: 5,
    maxBans: 3, maxKicks: 3, maxWebhookCreates: 3, maxRoleUpdates: 5, windowSeconds: 10, protectOwner: true
  },
  antilink: { enabled: false, mode: 'delete', whitelistedDomains: ['discord.gg', 'discord.com/invite'], bypassRoleId: null, whitelistedChannels: [] },
  antispam: { enabled: false, maxMessages: 6, windowSeconds: 7, punishment: 'mute', muteMinutes: 5, maxMentions: 5, maxEmojis: 10 },
  antiraid: { enabled: false, joinThreshold: 8, windowSeconds: 10, action: 'lockdown', minAccountAgeDays: 3 },
  antiwebhook: { enabled: false, action: 'delete', bypassRoleId: null, logChannelId: null },
  antibot: { enabled: false, action: 'kick', bypassRoleId: null, logChannelId: null },
  antialt: { enabled: false, action: 'kick', minAccountAgeDays: 3, logChannelId: null },
  voicemaster: { enabled: false, hubChannelId: null, categoryId: null, nameTemplate: "{user}'s room" },
  leveling: { enabled: false, channel: null, xpPerMessage: 15, cooldownSeconds: 60, levelUpMessage: '{user} reached level {level}!', roleRewards: {} },
  ticket: { enabled: false, categoryId: null, panelChannelId: null, supportRoleId: null, logChannelId: null, counter: 0, panelTitle: null, panelDescription: null, panelThumbnail: null, panelImage: null, categoryLabel: 'General Support', welcomeMessage: 'Our support team will assist you shortly.', welcomeThumbnail: null, welcomeImage: null },
  automod: { enabled: true, badWordFilter: false, badWords: [], capsFilter: false, capsThreshold: 70, inviteFilter: false },
  antibadword: { enabled: false, words: [], customWords: [] },
  autoresponder: { enabled: false, ignoreCase: true, triggers: [] },
  autoreactor: { enabled: false, ignoreCase: true, triggers: [] },
  afk: {},
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
  staffApplications: { enabled: false, panelChannelId: null, logChannelId: null, questions: [], title: 'Staff Applications', description: 'Click Apply to start your application.', dmIntro: 'Are you ready to start your staff application?', applicantRoleId: null, acceptedRoleId: null, cooldownHours: 24, acceptMessage: 'Congratulations! Your application was accepted.', denyMessage: 'Thank you for applying. Your application was not accepted this time.' },
  // FIX (Task 2): this key was missing, so db.getConfig(guild).honeypot was undefined and
  // every read of .channelId threw "Cannot read properties of undefined (reading 'channelId')".
  honeypot: { enabled: true, channelId: null, action: 'kick', cleanupWindow: 'none', createInvite: false, dmMessage: 'You were removed for posting in the honeypot channel. {invite}', logChannelId: null, whitelistRoleIds: [] },
  maintenance: false,
  blacklist: []
};

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(override || {})) {
    if (override[k] && typeof override[k] === 'object' && !Array.isArray(override[k]) && base[k] && typeof base[k] === 'object') out[k] = deepMerge(base[k], override[k]);
    else out[k] = override[k];
  }
  return out;
}

const getConfigStmt = db.prepare('SELECT data FROM guild_config WHERE guildId = ?');
const upsertConfigStmt = db.prepare('INSERT INTO guild_config (guildId, data) VALUES (@guildId, @data) ON CONFLICT(guildId) DO UPDATE SET data = @data');
function getConfig(guildId) {
  const row = getConfigStmt.get(guildId);
  let stored = {};
  try { stored = row ? JSON.parse(row.data) : {}; } catch { stored = {}; }
  return deepMerge(DEFAULT_CONFIG, stored);
}
function saveConfig(guildId, partial) {
  const merged = deepMerge(getConfig(guildId), partial || {});
  upsertConfigStmt.run({ guildId, data: JSON.stringify(merged) });
  return merged;
}

// Levels
const getLevelStmt = db.prepare('SELECT * FROM levels WHERE guildId = ? AND userId = ?');
const upsertLevelStmt = db.prepare('INSERT INTO levels (guildId, userId, xp, level, lastMessage) VALUES (?, ?, ?, ?, ?) ON CONFLICT(guildId, userId) DO UPDATE SET xp=excluded.xp, level=excluded.level, lastMessage=excluded.lastMessage');
const topLevelsStmt = db.prepare('SELECT * FROM levels WHERE guildId = ? ORDER BY xp DESC LIMIT ?');
function getLevel(guildId, userId) { return getLevelStmt.get(guildId, userId) || { guildId, userId, xp: 0, level: 0, lastMessage: 0 }; }
function setLevel(guildId, userId, xp, level, lastMessage) { upsertLevelStmt.run(guildId, userId, xp, level, lastMessage); }
function topLevels(guildId, limit = 10) { return topLevelsStmt.all(guildId, limit); }

// Warnings
const addWarnStmt = db.prepare('INSERT INTO warns (guildId,userId,moderatorId,reason,timestamp) VALUES (?,?,?,?,?)');
const getWarnsStmt = db.prepare('SELECT * FROM warns WHERE guildId=? AND userId=? ORDER BY timestamp DESC');
const clearWarnsStmt = db.prepare('DELETE FROM warns WHERE guildId=? AND userId=?');
function addWarn(guildId,userId,moderatorId,reason){addWarnStmt.run(guildId,userId,moderatorId,reason,Date.now());}
function getWarns(guildId,userId){return getWarnsStmt.all(guildId,userId);}
function clearWarns(guildId,userId){clearWarnsStmt.run(guildId,userId);}

// Tickets
const createTicketStmt = db.prepare('INSERT INTO tickets(channelId,guildId,userId,status,createdAt) VALUES (?,?,?,?,?)');
function createTicket(channelId,guildId,userId){createTicketStmt.run(channelId,guildId,userId,'open',Date.now());}
function getTicket(channelId){return db.prepare('SELECT * FROM tickets WHERE channelId=?').get(channelId);}
function setTicketStatus(channelId,status,claimedBy=null){db.prepare('UPDATE tickets SET status=?, claimedBy=? WHERE channelId=?').run(status,claimedBy,channelId);}
function closeTicket(channelId){db.prepare("UPDATE tickets SET status='closed' WHERE channelId=?").run(channelId);}
function openTicketsForUser(guildId,userId){return db.prepare("SELECT * FROM tickets WHERE guildId=? AND userId=? AND status='open'").all(guildId,userId);}

// Voice master
function addVMChannel(channelId,guildId,ownerId){db.prepare('INSERT OR REPLACE INTO voicemaster_channels(channelId,guildId,ownerId) VALUES (?,?,?)').run(channelId,guildId,ownerId);}
function getVMChannel(channelId){return db.prepare('SELECT * FROM voicemaster_channels WHERE channelId=?').get(channelId);}
function removeVMChannel(channelId){db.prepare('DELETE FROM voicemaster_channels WHERE channelId=?').run(channelId);}

// Whitelist / action logs / sticky roles / spam / joins
function addToWhitelist(guildId,userId){db.prepare('INSERT OR IGNORE INTO antinuke_whitelist(guildId,userId) VALUES (?,?)').run(guildId,userId);}
function removeFromWhitelist(guildId,userId){db.prepare('DELETE FROM antinuke_whitelist WHERE guildId=? AND userId=?').run(guildId,userId);}
function isWhitelisted(guildId,userId){return !!db.prepare('SELECT 1 FROM antinuke_whitelist WHERE guildId=? AND userId=?').get(guildId,userId);}
function logAction(guildId,userId,type,detail){db.prepare('INSERT INTO action_log(guildId,userId,type,detail,timestamp) VALUES (?,?,?,?,?)').run(guildId,userId,type,detail,Date.now());}
function recentActions(guildId,limit=15){return db.prepare('SELECT * FROM action_log WHERE guildId=? ORDER BY timestamp DESC LIMIT ?').all(guildId,limit);}
function getStickyRoles(guildId,userId){const r=db.prepare('SELECT roles FROM sticky_roles WHERE guildId=? AND userId=?').get(guildId,userId); try{return r?JSON.parse(r.roles):[];}catch{return[];}}
function setStickyRoles(guildId,userId,roles){db.prepare('INSERT INTO sticky_roles(guildId,userId,roles) VALUES (?,?,?) ON CONFLICT(guildId,userId) DO UPDATE SET roles=excluded.roles').run(guildId,userId,JSON.stringify(roles));}
function bumpSpam(guildId,userId,windowSeconds){const now=Date.now();const r=db.prepare('SELECT * FROM spam_tracker WHERE guildId=? AND userId=?').get(guildId,userId);if(!r||now-r.windowStart>windowSeconds*1000){db.prepare('INSERT OR REPLACE INTO spam_tracker(guildId,userId,count,windowStart) VALUES (?,?,?,?)').run(guildId,userId,1,now);return 1;}const n=r.count+1;db.prepare('UPDATE spam_tracker SET count=? WHERE guildId=? AND userId=?').run(n,guildId,userId);return n;}
function trackJoin(guildId,userId){db.prepare('INSERT INTO join_tracker(guildId,userId,timestamp) VALUES (?,?,?)').run(guildId,userId,Date.now());}
function recentJoinCount(guildId,windowSeconds){return db.prepare('SELECT COUNT(*) c FROM join_tracker WHERE guildId=? AND timestamp>?').get(guildId,Date.now()-windowSeconds*1000).c;}

// Emoji overrides
function getEmojiOverride(name){return db.prepare('SELECT value FROM emoji_overrides WHERE name=?').get(name)?.value||null;}
function setEmojiOverride(name,value){db.prepare('INSERT INTO emoji_overrides(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name,value);}
function resetEmojiOverride(name){db.prepare('DELETE FROM emoji_overrides WHERE name=?').run(name);}
function getAllEmojiOverrides(){const out={};for(const r of db.prepare('SELECT name,value FROM emoji_overrides').all())out[r.name]=r.value;return out;}
function saveEmojiSnapshot(values){const code='EM-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,7).toUpperCase();db.prepare('INSERT INTO emoji_snapshots(code,data,createdAt) VALUES (?,?,?)').run(code,JSON.stringify(values||{}),Date.now());return code;}
function getEmojiSnapshot(code){const r=db.prepare('SELECT data FROM emoji_snapshots WHERE code=?').get(String(code||'').trim());if(!r)return null;try{return JSON.parse(r.data);}catch{return null;}}
function applyEmojiSnapshot(values={}){const tx=db.transaction(obj=>{for(const [key,value] of Object.entries(obj||{})){if(value===undefined||value===null||value==='')continue;db.prepare('INSERT INTO emoji_overrides(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(String(key),String(value));}});tx(values);return getAllEmojiOverrides();}

// Dynamic embed text registry
function slugifyEmbedName(sourceTitle){
  return String(sourceTitle||'embed').replace(/<@!?\d+>/g,'@user').replace(/\d{15,25}/g,'id').replace(/[^a-zA-Z0-9 _-]/g,'').trim().replace(/\s+/g,'-').toLowerCase().slice(0,70) || 'embed';
}
function registerEmbedText(sourceTitle, description='', footer=''){
  const name=slugifyEmbedName(sourceTitle);
  const existing=db.prepare('SELECT * FROM embed_texts WHERE name=?').get(name);
  if(existing){
    db.prepare('UPDATE embed_texts SET sourceTitle=?, uses=uses+1, updatedAt=? WHERE name=?').run(String(sourceTitle),Date.now(),name);
    return existing;
  }
  db.prepare('INSERT INTO embed_texts(name,sourceTitle,title,description,footer,uses,updatedAt) VALUES (?,?,?,?,?,?,?)').run(name,String(sourceTitle),String(sourceTitle),String(description||''),String(footer||''),1,Date.now());
  return db.prepare('SELECT * FROM embed_texts WHERE name=?').get(name);
}
function getEmbedText(name){return db.prepare('SELECT * FROM embed_texts WHERE lower(name)=lower(?) OR lower(sourceTitle)=lower(?) LIMIT 1').get(name,name)||null;}
function listEmbedTexts(limit=500){return db.prepare('SELECT * FROM embed_texts ORDER BY updatedAt DESC LIMIT ?').all(limit);}
function updateEmbedText(name, patch){
  const row=getEmbedText(name); if(!row) return null;
  const next={title:patch.title??row.title,description:patch.description??row.description,footer:patch.footer??row.footer};
  db.prepare('UPDATE embed_texts SET title=?,description=?,footer=?,updatedAt=? WHERE name=?').run(next.title,next.description,next.footer,Date.now(),row.name);
  return db.prepare('SELECT * FROM embed_texts WHERE name=?').get(row.name);
}

// Owner-global config
function getOwnerConfig(){const r=db.prepare('SELECT data FROM owner_config WHERE id=1').get();if(!r)return {};try{return JSON.parse(r.data)||{};}catch{return {};}}
function saveOwnerConfig(partial){const current=getOwnerConfig();const merged=deepMerge(current,partial||{});db.prepare('INSERT INTO owner_config(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(merged));return merged;}
function getGlobalBlacklist(){const ids=getOwnerConfig().blacklistedGuildOwnerIds;return [...new Set((Array.isArray(ids)?ids:[]).map(x=>String(x).trim()).filter(x=>/^\d{15,25}$/.test(x)))];}
function addGlobalBlacklist(userId){const id=String(userId||'').trim();if(!/^\d{15,25}$/.test(id))throw new Error('Enter a valid Discord user ID.');const ids=getGlobalBlacklist();if(!ids.includes(id))ids.push(id);saveOwnerConfig({blacklistedGuildOwnerIds:ids});return ids;}
function removeGlobalBlacklist(userId){const id=String(userId||'').trim();const ids=getGlobalBlacklist().filter(x=>x!==id);saveOwnerConfig({blacklistedGuildOwnerIds:ids});return ids;}

// Owner-managed memberships
function membership(guildId){return db.prepare('SELECT * FROM memberships WHERE guildId=?').get(guildId)||null;}
function addMembership(guildId,{days=30,plan=null,note='' }={}){const n=Math.max(1,Number(days)||30);const now=Date.now();const old=membership(guildId);const start=old&&old.expiresAt>now?old.expiresAt:now;const expires=start+n*86400000;const label=plan||`${n} Days`;db.prepare('INSERT INTO memberships(guildId,plan,durationDays,createdAt,expiresAt,note) VALUES(?,?,?,?,?,?) ON CONFLICT(guildId) DO UPDATE SET plan=excluded.plan,durationDays=excluded.durationDays,createdAt=excluded.createdAt,expiresAt=excluded.expiresAt,note=excluded.note').run(guildId,label,n,now,expires,String(note||''));return membership(guildId);}
function removeMembership(guildId){db.prepare('DELETE FROM memberships WHERE guildId=?').run(guildId);}
function listMemberships(){return db.prepare('SELECT * FROM memberships ORDER BY expiresAt DESC').all().map(r=>({...r,status:Date.now()<r.expiresAt?'active':'expired'}));}

// Giveaways
function createGiveaway(guildId,hostId,opts={}){const info={prize:String(opts.prize||'Giveaway'),winners:Math.max(1,Number(opts.winners)||1),durationMs:Number(opts.durationMs)||0,endsAt:Number(opts.endsAt)||0,channelId:opts.channelId||null,createdAt:Date.now()};const q=db.prepare('INSERT INTO giveaways(guildId,hostId,prize,winners,durationMs,endsAt,channelId,status,createdAt) VALUES (?,?,?,?,?,?,?,?,?)');const result=q.run(guildId,hostId,info.prize,info.winners,info.durationMs,info.endsAt,info.channelId,'configuring',info.createdAt);return getGiveaway(guildId,result.lastInsertRowid);}
function getGiveaway(guildId,id){return db.prepare('SELECT * FROM giveaways WHERE guildId=? AND id=?').get(guildId,Number(id));}
function listGiveaways(guildId,limit=50){return db.prepare('SELECT * FROM giveaways WHERE guildId=? ORDER BY id DESC LIMIT ?').all(guildId,limit);}
function updateGiveaway(guildId,id,patch){const row=getGiveaway(guildId,id);if(!row)return null;const next={...row,...patch,participants:patch.participants??row.participants};const fields=['prize','winners','durationMs','endsAt','channelId','messageId','participants','status','winnerIds'];const set=fields.filter(k=>Object.prototype.hasOwnProperty.call(patch,k)).map(k=>`${k}=?`).join(',');if(set)db.prepare(`UPDATE giveaways SET ${set} WHERE guildId=? AND id=?`).run(...fields.filter(k=>Object.prototype.hasOwnProperty.call(patch,k)).map(k=>next[k]),guildId,Number(id));return getGiveaway(guildId,id);}

// Saved embeds used by /embed load/delete/list from recent builds.
function saveEmbed(guildId,name,data){const now=Date.now();db.prepare('INSERT INTO saved_embeds(guildId,name,data,createdAt,updatedAt) VALUES(?,?,?,?,?) ON CONFLICT(guildId,name) DO UPDATE SET data=excluded.data,updatedAt=excluded.updatedAt').run(guildId,name,JSON.stringify(data),now,now);return getEmbed(guildId,name);}
function getEmbed(guildId,name){const r=db.prepare('SELECT * FROM saved_embeds WHERE guildId=? AND lower(name)=lower(?)').get(guildId,name);if(!r)return null;try{return {...r,data:JSON.parse(r.data)};}catch{return null;}}
function listEmbeds(guildId){return db.prepare('SELECT * FROM saved_embeds WHERE guildId=? ORDER BY updatedAt DESC').all(guildId).map(r=>{try{return {...r,data:JSON.parse(r.data)};}catch{return r;}});}
function deleteEmbed(guildId,name){return db.prepare('DELETE FROM saved_embeds WHERE guildId=? AND lower(name)=lower(?)').run(guildId,name).changes>0;}

// Role panels stored inside the JSON config, so no extra migration is needed.
function panelArrayKey(kind){return kind==='button'?'buttonRolePanels':'reactionRolePanels';}
function findPanel(guildId,kind,panelId){const arr=getConfig(guildId)[panelArrayKey(kind)]||[];return arr.find(p=>p.id===panelId)||null;}
function upsertPanel(guildId,kind,panel){const key=panelArrayKey(kind);const arr=[...(getConfig(guildId)[key]||[])];const i=arr.findIndex(p=>p.id===panel.id);if(i>=0)arr[i]=panel;else arr.push(panel);return saveConfig(guildId,{[key]:arr})[key].find(p=>p.id===panel.id);}
function removePanel(guildId,kind,panelId){const key=panelArrayKey(kind);return saveConfig(guildId,{[key]:(getConfig(guildId)[key]||[]).filter(p=>p.id!==panelId)})[key];}

// ---------------------------------------------------------------------------------
// Sticky messages (one per channel)
// ---------------------------------------------------------------------------------
function parseJSON(text, fallback) { try { const v = JSON.parse(text); return v ?? fallback; } catch { return fallback; } }
function stickyRow(r) { return r ? { ...r, enabled: !!r.enabled, data: parseJSON(r.data, {}) } : null; }
const getStickyByChannelStmt = db.prepare('SELECT * FROM sticky_messages WHERE channelId = ?');
function getSticky(channelId) { return stickyRow(getStickyByChannelStmt.get(String(channelId))); }
function listStickies(guildId) { return db.prepare('SELECT * FROM sticky_messages WHERE guildId = ? ORDER BY createdAt ASC').all(guildId).map(stickyRow); }
function saveSticky(guildId, channelId, { data, enabled = true, createdBy = null } = {}) {
  const now = Date.now();
  db.prepare(`INSERT INTO sticky_messages (guildId, channelId, data, enabled, createdBy, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(guildId, channelId) DO UPDATE SET data = excluded.data, enabled = excluded.enabled, updatedAt = excluded.updatedAt`)
    .run(guildId, channelId, JSON.stringify(data || {}), enabled ? 1 : 0, createdBy, now, now);
  return getSticky(channelId);
}
function setStickyMessageId(channelId, messageId) { db.prepare('UPDATE sticky_messages SET lastMessageId = ?, updatedAt = ? WHERE channelId = ?').run(messageId || null, Date.now(), channelId); }
function setStickyEnabled(channelId, enabled) { db.prepare('UPDATE sticky_messages SET enabled = ?, updatedAt = ? WHERE channelId = ?').run(enabled ? 1 : 0, Date.now(), channelId); return getSticky(channelId); }
function deleteSticky(channelId) { return db.prepare('DELETE FROM sticky_messages WHERE channelId = ?').run(channelId).changes > 0; }

// ---------------------------------------------------------------------------------
// Staff applications
// ---------------------------------------------------------------------------------
function appRow(r) { return r ? { ...r, answers: parseJSON(r.answers, []) } : null; }
function createApplication(guildId, userId, answers) {
  const res = db.prepare('INSERT INTO staff_applications (guildId,userId,status,answers,createdAt) VALUES (?,?,?,?,?)').run(guildId, userId, 'pending', JSON.stringify(answers || []), Date.now());
  return getApplication(res.lastInsertRowid);
}
function getApplication(id) { return appRow(db.prepare('SELECT * FROM staff_applications WHERE id = ?').get(Number(id))); }
function pendingApplicationForUser(guildId, userId) { return appRow(db.prepare("SELECT * FROM staff_applications WHERE guildId=? AND userId=? AND status='pending' ORDER BY id DESC LIMIT 1").get(guildId, userId)); }
function lastApplicationForUser(guildId, userId) { return appRow(db.prepare('SELECT * FROM staff_applications WHERE guildId=? AND userId=? ORDER BY id DESC LIMIT 1').get(guildId, userId)); }
function updateApplication(id, patch) {
  const allowed = ['status', 'channelId', 'messageId', 'reviewerId', 'reason', 'decidedAt'];
  const keys = Object.keys(patch || {}).filter(k => allowed.includes(k));
  if (keys.length) db.prepare(`UPDATE staff_applications SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k => patch[k]), Number(id));
  return getApplication(id);
}

// ---------------------------------------------------------------------------------
// Owner module storage: audit log, error log (latest 200), command usage, command toggles
// ---------------------------------------------------------------------------------
function logOwnerAudit(userId, command, args, guildId) {
  db.prepare('INSERT INTO owner_audit (userId,command,args,guildId,ts) VALUES (?,?,?,?,?)').run(String(userId), String(command), String(args || '').slice(0, 500), guildId ? String(guildId) : null, Date.now());
  db.prepare('DELETE FROM owner_audit WHERE id NOT IN (SELECT id FROM owner_audit ORDER BY id DESC LIMIT 1000)').run();
}
function recordError({ source = null, command = null, guildId = null, userId = null, message = '', stack = '' } = {}) {
  db.prepare('INSERT INTO error_log (ts,source,command,guildId,userId,message,stack) VALUES (?,?,?,?,?,?,?)')
    .run(Date.now(), source, command, guildId, userId, String(message || '').slice(0, 2000), String(stack || '').slice(0, 20000));
  db.prepare('DELETE FROM error_log WHERE id NOT IN (SELECT id FROM error_log ORDER BY id DESC LIMIT 200)').run(); // keep latest 200
}
function listErrors(command = null) {
  return command
    ? db.prepare('SELECT * FROM error_log WHERE lower(command)=lower(?) ORDER BY id DESC').all(command)
    : db.prepare('SELECT * FROM error_log ORDER BY id DESC').all();
}
function clearErrors(command = null) {
  return (command ? db.prepare('DELETE FROM error_log WHERE lower(command)=lower(?)').run(command) : db.prepare('DELETE FROM error_log').run()).changes;
}
function utcDay(ts = Date.now()) { return new Date(ts).toISOString().slice(0, 10); }
function trackCommandUse(name, guildId, ok) {
  const now = Date.now();
  db.prepare(`INSERT INTO command_usage (day,guildId,name,ok,fail,lastUsed) VALUES (?,?,?,?,?,?)
    ON CONFLICT(day,guildId,name) DO UPDATE SET ok = ok + excluded.ok, fail = fail + excluded.fail, lastUsed = excluded.lastUsed`)
    .run(utcDay(now), guildId || 'dm', String(name), ok ? 1 : 0, ok ? 0 : 1, now);
}
function commandUsage({ range = 'all', guildId = null } = {}) {
  const where = []; const args = [];
  if (range === 'today') { where.push('day = ?'); args.push(utcDay()); }
  else if (range === 'week') { where.push('day >= ?'); args.push(utcDay(Date.now() - 6 * 86400000)); }
  if (guildId) { where.push('guildId = ?'); args.push(guildId); }
  return db.prepare(`SELECT name, SUM(ok) ok, SUM(fail) fail, MAX(lastUsed) lastUsed FROM command_usage ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY name ORDER BY (SUM(ok)+SUM(fail)) DESC`).all(...args);
}
function getToggle(name) { return db.prepare('SELECT * FROM command_toggles WHERE name = ?').get(String(name).toLowerCase()) || null; }
function listToggles() { return db.prepare('SELECT * FROM command_toggles ORDER BY at DESC').all(); }
function setToggle(name, reason, byId) { db.prepare('INSERT INTO command_toggles (name,reason,byId,at) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET reason=excluded.reason, byId=excluded.byId, at=excluded.at').run(String(name).toLowerCase(), reason || null, String(byId), Date.now()); }
function removeToggle(name) { return db.prepare('DELETE FROM command_toggles WHERE name = ?').run(String(name).toLowerCase()).changes > 0; }

// Antinuke whitelist listing (used by /whitelist list)
function listWhitelist(guildId) { return db.prepare('SELECT userId FROM antinuke_whitelist WHERE guildId = ?').all(guildId).map(r => r.userId); }

// Replace a guild's whole stored config (used by /template load so stale keys do not survive a deepMerge).
function replaceConfig(guildId, data) {
  upsertConfigStmt.run({ guildId, data: JSON.stringify(data || {}) });
  return getConfig(guildId);
}

// Server templates
function newTemplateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return 'AX-' + out;
}
function saveTemplate(guildId, guildName, data, createdBy) {
  let code = newTemplateCode();
  while (db.prepare('SELECT 1 FROM server_templates WHERE code=?').get(code)) code = newTemplateCode();
  db.prepare('INSERT INTO server_templates(code,guildId,guildName,data,createdBy,createdAt) VALUES (?,?,?,?,?,?)').run(code, guildId, String(guildName || ''), data, createdBy || null, Date.now());
  return code;
}
function getTemplate(code) { return db.prepare('SELECT * FROM server_templates WHERE code=?').get(String(code || '').trim().toUpperCase()) || null; }
function listTemplates(guildId) { return db.prepare('SELECT code,guildId,guildName,createdBy,createdAt,length(data) AS size FROM server_templates WHERE guildId=? ORDER BY createdAt DESC').all(guildId); }
function deleteTemplate(code, guildId) { return db.prepare('DELETE FROM server_templates WHERE code=? AND guildId=?').run(String(code || '').trim().toUpperCase(), guildId).changes > 0; }

module.exports={
  db,DB_PATH,DATA_DIR,DEFAULT_CONFIG,getConfig,saveConfig,replaceConfig,saveTemplate,getTemplate,listTemplates,deleteTemplate,
  getLevel,setLevel,topLevels,addWarn,getWarns,clearWarns,
  createTicket,getTicket,setTicketStatus,closeTicket,openTicketsForUser,
  addVMChannel,getVMChannel,removeVMChannel,
  addToWhitelist,removeFromWhitelist,isWhitelisted,logAction,recentActions,getStickyRoles,setStickyRoles,bumpSpam,trackJoin,recentJoinCount,
  getEmojiOverride,setEmojiOverride,resetEmojiOverride,getAllEmojiOverrides,saveEmojiSnapshot,getEmojiSnapshot,applyEmojiSnapshot,
  registerEmbedText,getEmbedText,listEmbedTexts,updateEmbedText,
  getOwnerConfig,saveOwnerConfig,getGlobalBlacklist,addGlobalBlacklist,removeGlobalBlacklist,membership,addMembership,removeMembership,listMemberships,
  createGiveaway,getGiveaway,listGiveaways,updateGiveaway,
  saveEmbed,getEmbed,listEmbeds,deleteEmbed,
  findPanel,upsertPanel,removePanel,
  getSticky,listStickies,saveSticky,setStickyMessageId,setStickyEnabled,deleteSticky,
  createApplication,getApplication,pendingApplicationForUser,lastApplicationForUser,updateApplication,
  logOwnerAudit,recordError,listErrors,clearErrors,trackCommandUse,commandUsage,getToggle,listToggles,setToggle,removeToggle,listWhitelist
};
