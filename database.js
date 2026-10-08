// database.js — persistent SQLite storage for AunXz.
// Safe migrations only: existing data is never wiped.

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'bot.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
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

const DEFAULT_CONFIG = {
  prefix: '!',
  logs: { mod: null, message: null, member: null, voice: null, antinuke: null, server: null, ticket: null, join: null },
  welcome: { enabled: false, channel: null, message: 'Welcome {user} to {server}! You are member #{count}.', autoroleId: null },
  leave: { enabled: false, channel: null, message: '{user} has left the server.' },
  boost: { enabled: false, channel: null, message: '{user} just boosted the server! 🚀' },
  greetvoice: { enabled: false, roleId: null, vcId: null, ttsPrompt: null },
  greetmessage: { enabled: false, channelId: null, message: 'Welcome {user}!', image: null },
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
  staffApplications: { enabled: false, panelChannelId: null, logChannelId: null, questions: [], title: 'Staff Applications', description: 'Click Apply to start your application.', dmIntro: 'Are you ready to start your staff application?' },
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

// Owner-managed memberships
function membership(guildId){return db.prepare('SELECT * FROM memberships WHERE guildId=?').get(guildId)||null;}
function addMembership(guildId,{days=30,plan=null,note='' }={}){const n=Math.max(1,Number(days)||30);const now=Date.now();const old=membership(guildId);const start=old&&old.expiresAt>now?old.expiresAt:now;const expires=start+n*86400000;const label=plan||`${n} Days`;db.prepare('INSERT INTO memberships(guildId,plan,durationDays,createdAt,expiresAt,note) VALUES(?,?,?,?,?,?) ON CONFLICT(guildId) DO UPDATE SET plan=excluded.plan,durationDays=excluded.durationDays,createdAt=excluded.createdAt,expiresAt=excluded.expiresAt,note=excluded.note').run(guildId,label,n,now,expires,String(note||''));return membership(guildId);}
function removeMembership(guildId){db.prepare('DELETE FROM memberships WHERE guildId=?').run(guildId);}
function listMemberships(){return db.prepare('SELECT * FROM memberships ORDER BY expiresAt DESC').all().map(r=>({...r,status:Date.now()<r.expiresAt?'active':'expired'}));}

// Giveaways
function createGiveaway(guildId,hostId,opts={}){const info={prize:String(opts.prize||'Giveaway'),winners:Math.max(1,Number(opts.winners)||1),durationMs:Number(opts.durationMs)||0,endsAt:Number(opts.endsAt)||0,channelId:opts.channelId||null,createdAt:Date.now()};const q=db.prepare('INSERT INTO giveaways(guildId,hostId,prize,winners,durationMs,endsAt,channelId,status,createdAt) VALUES (?,?,?,?,?,?,?,?,?)');const result=q.run(guildId,hostId,info.prize,info.winners,info.durationMs,info.endsAt,info.channelId,'configuring',info.createdAt);return getGiveaway(guildId,result.lastInsertRowid);}
function getGiveaway(guildId,id){return db.prepare('SELECT * FROM giveaways WHERE guildId=? AND id=?').get(guildId,Number(id));}
function listGiveaways(guildId,limit=50){return db.prepare('SELECT * FROM giveaways WHERE guildId=? ORDER BY id DESC LIMIT ?').all(guildId,limit);}
function updateGiveaway(guildId,id,patch){const row=getGiveaway(guildId,id);if(!row)return null;const next={...row,...patch,participants:patch.participants??row.participants};const fields=['prize','winners','durationMs','endsAt','channelId','messageId','participants','status'];const set=fields.filter(k=>Object.prototype.hasOwnProperty.call(patch,k)).map(k=>`${k}=?`).join(',');if(set)db.prepare(`UPDATE giveaways SET ${set} WHERE guildId=? AND id=?`).run(...fields.filter(k=>Object.prototype.hasOwnProperty.call(patch,k)).map(k=>next[k]),guildId,Number(id));return getGiveaway(guildId,id);}

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

module.exports={
  db,DB_PATH,DEFAULT_CONFIG,getConfig,saveConfig,
  getLevel,setLevel,topLevels,addWarn,getWarns,clearWarns,
  createTicket,getTicket,setTicketStatus,closeTicket,openTicketsForUser,
  addVMChannel,getVMChannel,removeVMChannel,
  addToWhitelist,removeFromWhitelist,isWhitelisted,logAction,recentActions,getStickyRoles,setStickyRoles,bumpSpam,trackJoin,recentJoinCount,
  getEmojiOverride,setEmojiOverride,resetEmojiOverride,getAllEmojiOverrides,saveEmojiSnapshot,getEmojiSnapshot,applyEmojiSnapshot,
  registerEmbedText,getEmbedText,listEmbedTexts,updateEmbedText,
  getOwnerConfig,saveOwnerConfig,membership,addMembership,removeMembership,listMemberships,
  createGiveaway,getGiveaway,listGiveaways,updateGiveaway,
  saveEmbed,getEmbed,listEmbeds,deleteEmbed,
  findPanel,upsertPanel,removePanel
};
