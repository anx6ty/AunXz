const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder, ChannelType, AttachmentBuilder, PermissionFlagsBits
} = require('discord.js');
const crypto = require('node:crypto');
const db = require('./database');
const ui = require('./ui');
const sql = db.db;

// NEXORA schema is additive and isolated from existing AunXz tables.
sql.exec(`
CREATE TABLE IF NOT EXISTS nexora_schema (version INTEGER NOT NULL);
INSERT INTO nexora_schema(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM nexora_schema);
CREATE TABLE IF NOT EXISTS nexora_settings(guildId TEXT PRIMARY KEY, data TEXT NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS nexora_regions(guildId TEXT NOT NULL, regionId TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', difficulty TEXT NOT NULL DEFAULT 'Normal', minLevel INTEGER NOT NULL DEFAULT 1, travelCost INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(guildId,regionId), UNIQUE(guildId,name));
CREATE TABLE IF NOT EXISTS nexora_classes(guildId TEXT NOT NULL, classId TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', hp INTEGER NOT NULL DEFAULT 100, attack INTEGER NOT NULL DEFAULT 10, defense INTEGER NOT NULL DEFAULT 5, data TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(guildId,classId), UNIQUE(guildId,name));
CREATE TABLE IF NOT EXISTS nexora_items(guildId TEXT NOT NULL, itemId TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', itemType TEXT NOT NULL DEFAULT 'material', rarity TEXT NOT NULL DEFAULT 'Common', price INTEGER NOT NULL DEFAULT 0, stackLimit INTEGER NOT NULL DEFAULT 99, attackBonus INTEGER NOT NULL DEFAULT 0, defenseBonus INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(guildId,itemId));
CREATE TABLE IF NOT EXISTS nexora_characters(guildId TEXT NOT NULL, userId TEXT NOT NULL, name TEXT NOT NULL, classId TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, xp INTEGER NOT NULL DEFAULT 0, hp INTEGER NOT NULL DEFAULT 100, maxHp INTEGER NOT NULL DEFAULT 100, attack INTEGER NOT NULL DEFAULT 10, defense INTEGER NOT NULL DEFAULT 5, coins INTEGER NOT NULL DEFAULT 0 CHECK(coins>=0), regionId TEXT NOT NULL DEFAULT 'sunmeadow', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(guildId,userId));
CREATE TABLE IF NOT EXISTS nexora_inventory(guildId TEXT NOT NULL, userId TEXT NOT NULL, itemId TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity>=0), PRIMARY KEY(guildId,userId,itemId));
CREATE TABLE IF NOT EXISTS nexora_quests(guildId TEXT NOT NULL, questId TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', objective TEXT NOT NULL DEFAULT 'explore', goal INTEGER NOT NULL DEFAULT 1 CHECK(goal>0), rewardXp INTEGER NOT NULL DEFAULT 0 CHECK(rewardXp>=0), rewardCoins INTEGER NOT NULL DEFAULT 0 CHECK(rewardCoins>=0), minLevel INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, repeatable INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(guildId,questId));
CREATE TABLE IF NOT EXISTS nexora_quest_progress(guildId TEXT NOT NULL, userId TEXT NOT NULL, questId TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, startedAt INTEGER NOT NULL, completedAt INTEGER, claimedAt INTEGER, PRIMARY KEY(guildId,userId,questId));
CREATE TABLE IF NOT EXISTS nexora_cooldowns(guildId TEXT NOT NULL, userId TEXT NOT NULL, action TEXT NOT NULL, untilAt INTEGER NOT NULL, PRIMARY KEY(guildId,userId,action));
CREATE TABLE IF NOT EXISTS nexora_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT, guildId TEXT NOT NULL, userId TEXT NOT NULL, action TEXT NOT NULL, currencyDelta INTEGER NOT NULL DEFAULT 0, xpDelta INTEGER NOT NULL DEFAULT 0, reference TEXT NOT NULL, createdAt INTEGER NOT NULL, UNIQUE(guildId,userId,reference));
CREATE TABLE IF NOT EXISTS nexora_templates(code TEXT PRIMARY KEY, createdGuildId TEXT NOT NULL, createdBy TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS nexora_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, guildId TEXT NOT NULL, actorId TEXT, action TEXT NOT NULL, detail TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_nexora_region_guild ON nexora_regions(guildId);
CREATE INDEX IF NOT EXISTS idx_nexora_character_rank ON nexora_characters(guildId,level DESC,xp DESC);
CREATE INDEX IF NOT EXISTS idx_nexora_quest_list ON nexora_quests(guildId,enabled,minLevel);
CREATE INDEX IF NOT EXISTS idx_nexora_audit_guild ON nexora_audit(guildId,createdAt DESC);
`);

const SECTION_LIST = [
  ['general','General Settings','game'], ['world','World Builder','world'], ['exploration','Regions & Exploration','exploration'],
  ['characters','Character System','characters'], ['classes','Classes & Skills','classes'], ['combat','Combat & Enemies','combat'],
  ['quests','Quests & Storylines','quests'], ['bosses','Bosses & Dungeons','bosses'], ['inventory','Inventory & Items','inventory'],
  ['crafting','Crafting & Resources','crafting'], ['pets','Pets & Collections','pets'], ['guilds','Guilds & Factions','guilds'],
  ['trading','Trading & Economy','trading'], ['events','Events & Tournaments','events'], ['minigames','Minigames','minigames'],
  ['rewards','Rewards & Achievements','rewards'], ['leaderboards','Levels & Leaderboards','leaderboards'], ['channels','Channels & Roles','channels'],
  ['ai','AI Story Generator','ai'], ['seasons','Seasons & Resets','seasons'], ['backup','Backups & Restoration','backup'], ['advanced','Advanced Settings','advanced']
];
const AVAILABLE = new Set(['game','world','exploration','characters','classes','combat','quests','inventory','crafting','trading','leaderboards','channels','backup','advanced']);
const DEFAULT_SETTINGS = {
  enabled: true, gameName: 'NEXORA', worldTitle: 'The Shattered Realms', description: 'A living world shaped by its adventurers.', theme: 'Fantasy RPG',
  currencyName: 'Crowns', currencySymbol: '✦', difficulty: 'Normal', mode: 'mixed', participation: 'public', startingCoins: 100,
  travelCooldownSeconds: 10, battleCooldownSeconds: 30, levelCap: 50, xpCurve: 'quadratic', maintenance: false,
  notificationChannelId: null, announcementChannelId: null, commandChannelId: null, adminRoleIds: [], allowedRoleIds: [], restrictedRoleIds: [],
  modules: { game:true, world:true, exploration:true, characters:true, classes:true, combat:true, quests:true, inventory:true, crafting:true, trading:true, leaderboards:true, channels:true, backup:true, advanced:true, bosses:false, pets:false, guilds:false, events:false, minigames:false, rewards:true, ai:false, seasons:false },
  ai: { provider:'openrouter', model:'', tone:'adventurous', enabled:false, maxRequestsPerHour:10 },
  security: { maxActionPerMinute:8, maxInventoryStack:999, maxRewardCoins:5000, maxRewardXp:5000 },
  season: { enabled:false, lengthDays:90, resetProgress:false }
};
const sessions = new Map();
const restoreSessions = new Map();
const now = () => Date.now();
const safeText = (s, n=500) => String(s ?? '').replace(/@everyone|@here/g, '@\u200b$&').slice(0,n);
const slug = s => String(s||'').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,40) || `item_${crypto.randomBytes(3).toString('hex')}`;
function merge(base, patch) {
  const out = { ...base };
  for (const [k,v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = merge(out[k],v);
    else out[k] = v;
  }
  return out;
}
function getSettings(guildId) {
  const row = sql.prepare('SELECT data FROM nexora_settings WHERE guildId=?').get(guildId);
  let stored = {}; try { stored = row ? JSON.parse(row.data) : {}; } catch {}
  return merge(DEFAULT_SETTINGS, stored);
}
function saveSettings(guildId, patch, actorId=null) {
  const next = merge(getSettings(guildId), patch);
  sql.prepare('INSERT INTO nexora_settings(guildId,data,updatedAt) VALUES(?,?,?) ON CONFLICT(guildId) DO UPDATE SET data=excluded.data,updatedAt=excluded.updatedAt').run(guildId, JSON.stringify(next), now());
  if (actorId) sql.prepare('INSERT INTO nexora_audit(guildId,actorId,action,detail,createdAt) VALUES(?,?,?,?,?)').run(guildId, actorId, 'settings_update', safeText(JSON.stringify(patch), 1000), now());
  return next;
}
function audit(guildId, actorId, action, detail) { sql.prepare('INSERT INTO nexora_audit(guildId,actorId,action,detail,createdAt) VALUES(?,?,?,?,?)').run(guildId, actorId || null, action, safeText(detail,1000), now()); }
function seedWorld(guildId) {
  const insRegion = sql.prepare('INSERT OR IGNORE INTO nexora_regions(guildId,regionId,name,description,difficulty,minLevel,travelCost,data) VALUES(?,?,?,?,?,?,?,?)');
  const tx = sql.transaction(() => {
    insRegion.run(guildId,'sunmeadow','Sunmeadow','A quiet grassland where new adventurers begin.','Easy',1,0,'{}');
    insRegion.run(guildId,'whispering_woods','Whispering Woods','Old trees hide strange tracks and restless creatures.','Normal',3,20,'{}');
    insRegion.run(guildId,'ember_caverns','Ember Caverns','A dangerous cavern filled with glowing ore.','Hard',7,60,'{}');
    const cls = sql.prepare('INSERT OR IGNORE INTO nexora_classes(guildId,classId,name,description,hp,attack,defense,data) VALUES(?,?,?,?,?,?,?,?)');
    cls.run(guildId,'vanguard','Vanguard','A durable front-line fighter.',125,12,9,'{}');
    cls.run(guildId,'ranger','Ranger','A nimble hunter with balanced stats.',95,15,5,'{}');
    cls.run(guildId,'arcanist','Arcanist','A fragile but powerful spellcaster.',80,19,3,'{}');
    const item = sql.prepare('INSERT OR IGNORE INTO nexora_items(guildId,itemId,name,description,itemType,rarity,price,stackLimit,attackBonus,defenseBonus,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    item.run(guildId,'small_potion','Small Potion','Restore 30 HP after a battle.','consumable','Common',15,20,0,0,JSON.stringify({effect:'heal',amount:30}));
    item.run(guildId,'iron_ore','Iron Ore','Raw iron for crafting.','material','Common',8,99,0,0,'{}');
    item.run(guildId,'wood','Timber','Useful crafting timber.','material','Common',4,99,0,0,'{}');
    item.run(guildId,'iron_blade','Iron Blade','A crafted weapon.','equipment','Uncommon',75,1,5,0,JSON.stringify({recipe:[{itemId:'iron_ore',quantity:3},{itemId:'wood',quantity:2}]}));
    item.run(guildId,'hide_vest','Hide Vest','A simple protective vest.','equipment','Common',55,1,0,3,JSON.stringify({recipe:[{itemId:'wood',quantity:2}]}));
    const q = sql.prepare('INSERT OR IGNORE INTO nexora_quests(guildId,questId,name,description,objective,goal,rewardXp,rewardCoins,minLevel,enabled,repeatable,data) VALUES(?,?,?,?,?,?,?,?,?,1,0,?)');
    q.run(guildId,'first_steps','First Steps','Travel to a region to learn how exploration works.','explore',1,40,25,1,'{}');
    q.run(guildId,'first_battle','A Test of Courage','Win a battle against a regional enemy.','battle',1,60,40,1,'{}');
    q.run(guildId,'woodland_roamer','Woodland Roamer','Explore three times.','explore',3,90,55,2,'{}');
  });
  tx();
  if (!sql.prepare('SELECT 1 FROM nexora_settings WHERE guildId=?').get(guildId)) saveSettings(guildId, {});
}
function requireAdmin(i) { return !!i.guild && (i.guild.ownerId === i.user.id || i.memberPermissions?.has(PermissionFlagsBits.Administrator) || i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)); }
function adminError() { return { embeds:[ui.errorEmbed('Administrator only','Manage Server or Administrator is required to configure NEXORA.')], ephemeral:true }; }
function allRows(table,guildId,order='name') { return sql.prepare(`SELECT * FROM ${table} WHERE guildId=? ORDER BY ${order}`).all(guildId); }
function getCharacter(guildId,userId) { return sql.prepare('SELECT * FROM nexora_characters WHERE guildId=? AND userId=?').get(guildId,userId) || null; }
function addInventory(guildId,userId,itemId,qty) {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('Quantity must be a positive integer.');
  sql.prepare('INSERT INTO nexora_inventory(guildId,userId,itemId,quantity) VALUES(?,?,?,?) ON CONFLICT(guildId,userId,itemId) DO UPDATE SET quantity=quantity+excluded.quantity').run(guildId,userId,itemId,qty);
}
function trackObjective(guildId,userId,objective,count=1) {
  const quests = sql.prepare('SELECT * FROM nexora_quests WHERE guildId=? AND enabled=1 AND objective=?').all(guildId,objective);
  for (const q of quests) {
    const p = sql.prepare('SELECT * FROM nexora_quest_progress WHERE guildId=? AND userId=? AND questId=?').get(guildId,userId,q.questId);
    if (!p || p.claimedAt || (p.completedAt && !q.repeatable)) continue;
    const next = Math.min(q.goal, (p?.progress || 0) + count);
    sql.prepare('INSERT INTO nexora_quest_progress(guildId,userId,questId,progress,startedAt,completedAt,claimedAt) VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(guildId,userId,questId) DO UPDATE SET progress=excluded.progress,completedAt=CASE WHEN excluded.progress >= ? THEN COALESCE(nexora_quest_progress.completedAt, excluded.completedAt) ELSE nexora_quest_progress.completedAt END').run(guildId,userId,q.questId,next,p?.startedAt || now(),next>=q.goal?now():null,q.goal);
  }
}
function cooldownRemaining(guildId,userId,action) { const row=sql.prepare('SELECT untilAt FROM nexora_cooldowns WHERE guildId=? AND userId=? AND action=?').get(guildId,userId,action); return Math.max(0,(row?.untilAt||0)-now()); }
function setCooldown(guildId,userId,action,ms) { sql.prepare('INSERT INTO nexora_cooldowns(guildId,userId,action,untilAt) VALUES(?,?,?,?) ON CONFLICT(guildId,userId,action) DO UPDATE SET untilAt=excluded.untilAt').run(guildId,userId,action,now()+ms); }
function xpNeeded(level, settings) {
  const lvl=Math.max(1,Math.min(Number(settings.levelCap)||50,level));
  if (settings.xpCurve==='linear') return lvl*100;
  if (settings.xpCurve==='exponential') return Math.min(1_000_000,Math.round(100*Math.pow(1.22,lvl-1)));
  return 75*lvl*lvl;
}
function grantXp(guildId,userId,amount,settings) {
  const c=getCharacter(guildId,userId); if(!c) return null;
  let xp=c.xp+Math.max(0,Math.floor(amount)), level=c.level, max=Math.max(1,Math.min(200,Number(settings.levelCap)||50));
  while(level<max && xp>=xpNeeded(level,settings)){xp-=xpNeeded(level,settings);level++;}
  sql.prepare('UPDATE nexora_characters SET xp=?,level=?,maxHp=maxHp+?,hp=MIN(maxHp+?,hp+?),attack=attack+?,updatedAt=? WHERE guildId=? AND userId=?').run(xp,level,(level-c.level)*5,(level-c.level)*5,(level-c.level)*5,(level-c.level)>0?1:0,now(),guildId,userId);
  return sql.prepare('SELECT * FROM nexora_characters WHERE guildId=? AND userId=?').get(guildId,userId);
}
function characterEmbed(guild, user, c) {
  const settings=getSettings(guild.id), region=sql.prepare('SELECT name FROM nexora_regions WHERE guildId=? AND regionId=?').get(guild.id,c.regionId);
  const klass=sql.prepare('SELECT name FROM nexora_classes WHERE guildId=? AND classId=?').get(guild.id,c.classId);
  const next=xpNeeded(c.level,settings);
  return new EmbedBuilder().setColor(0x8B5CF6).setTitle(`${c.name} — Level ${c.level}`).setDescription(`**${safeText(klass?.name||c.classId,80)}** • ${safeText(region?.name||'Unknown region',100)}\n${user}`).addFields(
    {name:'Health',value:`${c.hp}/${c.maxHp}`,inline:true},{name:'Attack',value:String(c.attack),inline:true},{name:'Defense',value:String(c.defense),inline:true},
    {name:'Experience',value:`${c.xp}/${next}`,inline:true},{name:settings.currencyName,value:`${settings.currencySymbol} ${c.coins}`,inline:true},{name:'World',value:safeText(settings.worldTitle,100),inline:true}
  ).setThumbnail(user.displayAvatarURL?.({extension:'png',size:128})||null).setFooter({text:`${settings.gameName} • Guild ${guild.id}`});
}
const sectionByKey = new Map(SECTION_LIST.map(s=>[s[0],s]));
const moduleSection = {general:'game',world:'world',exploration:'exploration',characters:'characters',classes:'classes',combat:'combat',quests:'quests',bosses:'bosses',inventory:'inventory',crafting:'crafting',pets:'pets',guilds:'guilds',trading:'trading',events:'events',minigames:'minigames',rewards:'rewards',leaderboards:'leaderboards',channels:'channels',ai:'ai',seasons:'seasons',backup:'backup',advanced:'advanced'};
function isModuleAvailable(key) { return AVAILABLE.has(key); }
function dashboardEmbed(guildId, section='dashboard') {
  const s=getSettings(guildId); const regions=sql.prepare('SELECT COUNT(*) n FROM nexora_regions WHERE guildId=?').get(guildId).n;
  const chars=sql.prepare('SELECT COUNT(*) n FROM nexora_characters WHERE guildId=?').get(guildId).n;
  const quests=sql.prepare('SELECT COUNT(*) n FROM nexora_quests WHERE guildId=? AND enabled=1').get(guildId).n;
  if(section==='dashboard') {
    const enabled=Object.entries(s.modules).filter(([k,v])=>v && isModuleAvailable(k)).length;
    const available=[...AVAILABLE].length;
    return new EmbedBuilder().setColor(0x8B5CF6).setTitle(`✦ ${safeText(s.gameName,80)} — World Engine`).setDescription(`${safeText(s.description,800)}\n\n**World:** ${safeText(s.worldTitle,100)}\n**Theme:** ${safeText(s.theme,80)} • **Difficulty:** ${safeText(s.difficulty,30)}\n**System:** ${s.enabled?'🟢 Enabled':'🔴 Disabled'} • **Maintenance:** ${s.maintenance?'On':'Off'}\n**Playable modules:** ${enabled}/${available}\n**Regions:** ${regions} • **Characters:** ${chars} • **Published quests:** ${quests}\n\nChoose a section below. Unsupported gameplay modules are visibly marked and cannot be enabled until implemented.`).setFooter({text:`Per-server world • setup persists to SQLite • ${guildId}`});
  }
  const sec=sectionByKey.get(section); if(!sec) return dashboardEmbed(guildId);
  const mod=moduleSection[section]; const available=isModuleAvailable(mod); const enabled=!!s.modules[mod];
  let details=`**Status:** ${available?(enabled?'🟢 Enabled':'🔴 Disabled'):'⚪ Not available in this build'}\n**Description:** ${sec[1]}\n`;
  if(section==='general') details+=`\n**Game:** ${s.gameName}\n**World:** ${s.worldTitle}\n**Currency:** ${s.currencySymbol} ${s.currencyName}\n**Difficulty:** ${s.difficulty}\n**Mode:** ${s.mode}\n**Starting coins:** ${s.startingCoins}\n**Level cap:** ${s.levelCap}\n**XP curve:** ${s.xpCurve}\n**Maintenance:** ${s.maintenance?'On':'Off'}`;
  if(section==='world'||section==='exploration') { const r=allRows('nexora_regions',guildId); details+=`\n\n**Regions (${r.length})**\n`+(r.slice(0,12).map(x=>`• **${safeText(x.name,80)}** — level ${x.minLevel}+ / ${safeText(x.difficulty,20)} / travel ${x.travelCost}`).join('\n')||'No regions configured.'); }
  if(section==='classes') { const r=allRows('nexora_classes',guildId); details+=`\n\n**Classes (${r.length})**\n`+(r.map(x=>`• **${safeText(x.name,80)}** — HP ${x.hp}, ATK ${x.attack}, DEF ${x.defense}`).join('\n')||'No classes.'); }
  if(section==='quests') { const r=allRows('nexora_quests',guildId); details+=`\n\n**Quests (${r.length})**\n`+(r.slice(0,12).map(x=>`• **${safeText(x.name,80)}** — ${x.objective} ×${x.goal} • ${x.rewardXp} XP / ${x.rewardCoins} coins ${x.enabled?'':'(disabled)'}`).join('\n')||'No quests.'); }
  if(section==='inventory'||section==='crafting') { const r=allRows('nexora_items',guildId); details+=`\n\n**Items (${r.length})**\n`+(r.slice(0,12).map(x=>`• **${safeText(x.name,70)}** — ${x.itemType}, ${x.rarity}, ${s.currencySymbol}${x.price}`).join('\n')||'No items.'); }
  if(section==='channels') details+=`\n\n**Command channel:** ${s.commandChannelId?`<#${s.commandChannelId}>`:'Not restricted'}\n**Notification channel:** ${s.notificationChannelId?`<#${s.notificationChannelId}>`:'Not set'}\n**Announcement channel:** ${s.announcementChannelId?`<#${s.announcementChannelId}>`:'Not set'}`;
  if(section==='ai') details+=`\n\n**Provider:** ${safeText(s.ai.provider,40)}\n**Model:** ${safeText(s.ai.model||'Use environment default',100)}\n**Story tone:** ${safeText(s.ai.tone,80)}\n**AI enabled:** ${s.ai.enabled?'Yes':'No'}\nAI content generation is not activated by this compact module unless a validated provider integration is available.`;
  if(section==='backup') details+='\n\nExport uses a versioned JSON archive. A preview and explicit confirmation are required before restore; only NEXORA tables are affected.';
  if(section==='advanced') details+=`\n\n**Max actions/min:** ${s.security.maxActionPerMinute}\n**Max reward coins:** ${s.security.maxRewardCoins}\n**Max reward XP:** ${s.security.maxRewardXp}\n**Travel cooldown:** ${s.travelCooldownSeconds}s\n**Battle cooldown:** ${s.battleCooldownSeconds}s`;
  if(['guilds','pets','events','minigames','bosses','rewards','seasons','trading'].includes(section) && !available) details+='\n\nThis module has no gameplay handlers in this build. It remains disabled to avoid displaying non-functional controls.';
  if(section==='trading'&&available) details+='\n\nShop purchases and crafting recipes are supported. Player-to-player trading requires a separate confirmation and transfer service and is not enabled in this build.';
  return new EmbedBuilder().setColor(0x8B5CF6).setTitle(`NEXORA Setup • ${sec[1]}`).setDescription(details).setFooter({text:'Use Back to return • changes persist immediately • disabling never deletes progress'});
}
function sectionSelect() {
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('nexora:section').setPlaceholder('Open a configuration section…').addOptions(SECTION_LIST.slice(0,25).map(([value,label])=>({label, value, description: isModuleAvailable(moduleSection[value])?'Configure live settings':'Not implemented in this build'}))));
}
function sectionRows(session, section='dashboard') {
  const rows=[]; const s=getSettings(session.guildId);
  if(section==='dashboard') {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('nexora:preset').setPlaceholder('Apply a world preset…').addOptions([
      {label:'Fantasy RPG',value:'fantasy',description:'Balanced fantasy starter world'}, {label:'Anime Adventure',value:'anime',description:'Fast-paced adventure theme'},
      {label:'Minecraft Survival',value:'minecraft',description:'Gathering and crafting theme'}, {label:'Casual Community',value:'casual',description:'Lower difficulty and gentler progression'},
      {label:'Cooperative World',value:'cooperative',description:'Exploration-focused settings'}, {label:'Custom Blank World',value:'blank',description:'Minimal world configuration'}
    ])));
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('nexora:toggle-system').setLabel(s.enabled?'Disable World':'Enable World').setStyle(s.enabled?ButtonStyle.Danger:ButtonStyle.Success),new ButtonBuilder().setCustomId('nexora:section:general').setLabel('General Settings').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('nexora:section:world').setLabel('World Builder').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('nexora:section:backup').setLabel('Backup / Restore').setStyle(ButtonStyle.Secondary)));
  } else {
    const mod=moduleSection[section], supported=isModuleAvailable(mod);
    const buttonRows=[];
    if(supported) buttonRows.push(new ButtonBuilder().setCustomId(`nexora:toggle:${mod}`).setLabel(s.modules[mod]?'Disable module':'Enable module').setStyle(s.modules[mod]?ButtonStyle.Danger:ButtonStyle.Success));
    if(section==='general') buttonRows.push(new ButtonBuilder().setCustomId('nexora:edit-general').setLabel('Edit world settings').setStyle(ButtonStyle.Primary));
    if(section==='world'||section==='exploration') buttonRows.push(new ButtonBuilder().setCustomId('nexora:add-region').setLabel('Add region').setStyle(ButtonStyle.Primary));
    if(section==='classes') buttonRows.push(new ButtonBuilder().setCustomId('nexora:add-class').setLabel('Add class').setStyle(ButtonStyle.Primary));
    if(section==='quests') buttonRows.push(new ButtonBuilder().setCustomId('nexora:add-quest').setLabel('Add quest').setStyle(ButtonStyle.Primary));
    if(section==='inventory'||section==='crafting') buttonRows.push(new ButtonBuilder().setCustomId('nexora:add-item').setLabel('Add item').setStyle(ButtonStyle.Primary));
    if(section==='channels') buttonRows.push(new ButtonBuilder().setCustomId('nexora:channel-picker').setLabel('Set command channel').setStyle(ButtonStyle.Primary));
    if(section==='backup') buttonRows.push(new ButtonBuilder().setCustomId('nexora:backup-info').setLabel('Backup instructions').setStyle(ButtonStyle.Secondary));
    if(buttonRows.length) rows.push(new ActionRowBuilder().addComponents(buttonRows.slice(0,5)));
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('nexora:back').setLabel('Back to dashboard').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(`nexora:section:${section}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary)));
    if(section==='channels') rows.push(new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('nexora:channel-select').setPlaceholder('Select a channel for NEXORA commands / updates').setChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement)));
  }
  return [sectionSelect(),...rows];
}
function setSessionComponent(session, id) { return `nexora:${session.token}:${id}`; }
function sectionRowsForSession(session, section) {
  const rows=sectionRows(session,section);
  for(const row of rows) for(const component of row.components) {
    const old=component.data?.custom_id || component.toJSON?.().custom_id;
    if(old && old.startsWith('nexora:') && !old.startsWith(`nexora:${session.token}:`)) component.setCustomId(`nexora:${session.token}:${old.slice('nexora:'.length)}`);
  }
  return rows;
}
function sectionEmbedSession(session, section) { return dashboardEmbed(session.guildId,section); }
function input(id,label,value,style=TextInputStyle.Short,required=false,max=100) {
  const x=new TextInputBuilder().setCustomId(id).setLabel(label.slice(0,45)).setStyle(style).setRequired(required).setMaxLength(max);
  if(value!==undefined&&value!==null&&String(value).length) x.setValue(String(value).slice(0,Math.min(max,4000)));
  return new ActionRowBuilder().addComponents(x);
}
function showGeneralModal(i, session) {
  const s=getSettings(session.guildId);
  const modal=new ModalBuilder().setCustomId(`nexora:${session.token}:modal:general`).setTitle('General World Settings');
  modal.addComponents(input('gameName','Game name',s.gameName,TextInputStyle.Short,true,80),input('worldTitle','World title',s.worldTitle,TextInputStyle.Short,true,100),input('currencyName','Currency name',s.currencyName,TextInputStyle.Short,true,30),input('currencySymbol','Currency symbol',s.currencySymbol,TextInputStyle.Short,true,8),input('difficulty','Difficulty (Easy/Normal/Hard/Extreme/Custom)',s.difficulty,TextInputStyle.Short,true,20));
  return i.showModal(modal);
}
function showAddRegionModal(i,session) {
  const modal=new ModalBuilder().setCustomId(`nexora:${session.token}:modal:region`).setTitle('Create a World Region');
  modal.addComponents(input('name','Region name',null,TextInputStyle.Short,true,70),input('description','Region lore / description',null,TextInputStyle.Paragraph,false,700),input('minLevel','Minimum recommended level','1',TextInputStyle.Short,true,3),input('travelCost','Travel cost in currency','0',TextInputStyle.Short,true,8),input('difficulty','Difficulty (Easy/Normal/Hard/Extreme)','Normal',TextInputStyle.Short,true,20));
  return i.showModal(modal);
}
function showAddClassModal(i,session) {
  const modal=new ModalBuilder().setCustomId(`nexora:${session.token}:modal:class`).setTitle('Create a Character Class');
  modal.addComponents(input('name','Class name',null,TextInputStyle.Short,true,70),input('description','Description',null,TextInputStyle.Paragraph,false,500),input('hp','Base health (20–1000)','100',TextInputStyle.Short,true,4),input('attack','Base attack (1–250)','10',TextInputStyle.Short,true,3),input('defense','Base defense (0–200)','5',TextInputStyle.Short,true,3));
  return i.showModal(modal);
}
function showAddQuestModal(i,session) {
  const modal=new ModalBuilder().setCustomId(`nexora:${session.token}:modal:quest`).setTitle('Create a Quest');
  modal.addComponents(input('name','Quest name',null,TextInputStyle.Short,true,80),input('description','Description',null,TextInputStyle.Paragraph,false,500),input('objective','Objective type (explore or battle)','explore',TextInputStyle.Short,true,10),input('goal','Required objective count','1',TextInputStyle.Short,true,4),input('rewards','Rewards: XP,coins (e.g. 50,25)','50,25',TextInputStyle.Short,true,25));
  return i.showModal(modal);
}
function showAddItemModal(i,session) {
  const modal=new ModalBuilder().setCustomId(`nexora:${session.token}:modal:item`).setTitle('Create an Item');
  modal.addComponents(input('id','Item ID (letters, numbers, underscores)',null,TextInputStyle.Short,true,40),input('name','Item name',null,TextInputStyle.Short,true,70),input('description','Description',null,TextInputStyle.Paragraph,false,400),input('price','Shop price (0–1000000)','10',TextInputStyle.Short,true,10),input('type','Type: material/equipment/consumable','material',TextInputStyle.Short,true,20));
  return i.showModal(modal);
}
function presetPatch(preset) {
  const map={fantasy:{theme:'Fantasy RPG',difficulty:'Normal',mode:'mixed',startingCoins:100},anime:{theme:'Anime Adventure',difficulty:'Hard',mode:'competitive',startingCoins:150},minecraft:{theme:'Minecraft Survival',difficulty:'Normal',mode:'cooperative',startingCoins:80},casual:{theme:'Casual Community',difficulty:'Easy',mode:'casual',startingCoins:200},cooperative:{theme:'Cooperative World Adventure',difficulty:'Normal',mode:'cooperative',startingCoins:125},blank:{theme:'Custom Blank World',difficulty:'Custom',mode:'mixed',startingCoins:0}};
  return map[preset]||map.fantasy;
}
function makeBackup(guildId, includePlayers=true) {
  seedWorld(guildId);
  const settings=getSettings(guildId);
  const read=(table)=>sql.prepare(`SELECT * FROM ${table} WHERE guildId=?`).all(guildId);
  const data={format:'NEXORA-BACKUP',schemaVersion:1,guildId,createdAt:new Date().toISOString(),settings,regions:read('nexora_regions'),classes:read('nexora_classes'),items:read('nexora_items'),quests:read('nexora_quests')};
  if(includePlayers){data.characters=read('nexora_characters');data.inventory=read('nexora_inventory');data.questProgress=read('nexora_quest_progress');data.ledger=read('nexora_ledger');}
  return data;
}
function validateBackup(data) {
  if(!data||data.format!=='NEXORA-BACKUP'||data.schemaVersion!==1) throw new Error('This is not a supported NEXORA backup (expected version 1).');
  for(const key of ['regions','classes','items','quests']) if(!Array.isArray(data[key])||data[key].length>10000) throw new Error(`Invalid ${key} list in backup.`);
  if(!data.settings||typeof data.settings!=='object') throw new Error('Missing settings object.');
  for(const key of ['characters','inventory','questProgress','ledger']) if(data[key]!==undefined&&(!Array.isArray(data[key])||data[key].length>100000)) throw new Error(`Invalid ${key} list in backup.`);
  for(const r of data.regions) if(!/^[a-z0-9_]{1,40}$/.test(String(r.regionId||''))||!String(r.name||'').trim()) throw new Error('A region has an invalid ID or name.');
  for(const c of data.classes) if(!/^[a-z0-9_]{1,40}$/.test(String(c.classId||''))||!String(c.name||'').trim()||!Number.isFinite(Number(c.hp))||Number(c.hp)<20||Number(c.hp)>1000) throw new Error('A class has invalid fields.');
  for(const it of data.items) if(!/^[a-z0-9_]{1,40}$/.test(String(it.itemId||''))||!String(it.name||'').trim()||Number(it.price)<0||Number(it.price)>1000000) throw new Error('An item has invalid fields.');
  for(const q of data.quests) if(!/^[a-z0-9_]{1,40}$/.test(String(q.questId||''))||Number(q.goal)<1||Number(q.goal)>100000) throw new Error('A quest has invalid fields.');
  return true;
}
function applyBackup(guildId, userId, data, restorePlayers=true) {
  validateBackup(data);
  const tx=sql.transaction(()=>{
    saveSettings(guildId,data.settings,userId);
    for(const [table,rows,cols] of [
      ['nexora_regions',data.regions,['regionId','name','description','difficulty','minLevel','travelCost','data']],
      ['nexora_classes',data.classes,['classId','name','description','hp','attack','defense','data']],
      ['nexora_items',data.items,['itemId','name','description','itemType','rarity','price','stackLimit','attackBonus','defenseBonus','data']],
      ['nexora_quests',data.quests,['questId','name','description','objective','goal','rewardXp','rewardCoins','minLevel','enabled','repeatable','data']]
    ]) {
      const q=`INSERT INTO ${table}(guildId,${cols.join(',')}) VALUES(${['?','?'].concat(cols.slice(1).map(()=>'?')).join(',')}) ON CONFLICT(guildId,${cols[0]}) DO UPDATE SET ${cols.slice(1).map(c=>`${c}=excluded.${c}`).join(',')}`;
      const stmt=sql.prepare(q);
      for(const row of rows) stmt.run(guildId,...cols.map(c=>row[c] ?? (c==='data'?'{}':c==='description'?'':c==='enabled'?1:c==='repeatable'?0:c==='minLevel'?1:c==='travelCost'?0:c==='price'?0:c==='stackLimit'?99:c==='attackBonus'||c==='defenseBonus'?0:c==='difficulty'?'Normal':c==='itemType'?'material':c==='rarity'?'Common':c==='objective'?'explore':c==='goal'?1:c==='rewardXp'||c==='rewardCoins'?0:c==='hp'?100:c==='attack'?10:c==='defense'?5:'')));
    }
    if(restorePlayers && Array.isArray(data.characters)) {
      const st=sql.prepare('INSERT INTO nexora_characters(guildId,userId,name,classId,level,xp,hp,maxHp,attack,defense,coins,regionId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(guildId,userId) DO UPDATE SET name=excluded.name,classId=excluded.classId,level=excluded.level,xp=excluded.xp,hp=excluded.hp,maxHp=excluded.maxHp,attack=excluded.attack,defense=excluded.defense,coins=excluded.coins,regionId=excluded.regionId,updatedAt=excluded.updatedAt');
      for(const r of data.characters) if(r.userId && Number(r.coins)>=0 && Number(r.level)>=1) st.run(guildId,r.userId,r.name,r.classId,r.level,r.xp,r.hp,r.maxHp,r.attack,r.defense,r.coins,r.regionId,r.createdAt||now(),now());
      const inv=sql.prepare('INSERT INTO nexora_inventory(guildId,userId,itemId,quantity) VALUES(?,?,?,?) ON CONFLICT(guildId,userId,itemId) DO UPDATE SET quantity=excluded.quantity');
      for(const r of data.inventory||[]) if(r.userId&&r.itemId&&Number(r.quantity)>=0) inv.run(guildId,r.userId,r.itemId,r.quantity);
      const qp=sql.prepare('INSERT INTO nexora_quest_progress(guildId,userId,questId,progress,startedAt,completedAt,claimedAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(guildId,userId,questId) DO UPDATE SET progress=excluded.progress,startedAt=excluded.startedAt,completedAt=excluded.completedAt,claimedAt=excluded.claimedAt');
      for(const r of data.questProgress||[]) if(r.userId&&r.questId) qp.run(guildId,r.userId,r.questId,r.progress,r.startedAt||now(),r.completedAt||null,r.claimedAt||null);
    }
    audit(guildId,userId,'backup_restore',`Applied NEXORA backup from ${safeText(data.guildId||'unknown guild',30)}; player data ${restorePlayers?'included':'skipped'}.`);
  });
  tx();
}
function starterCheck(i) { if(!i.guildId||!i.guild) return false; seedWorld(i.guildId); const s=getSettings(i.guildId); if(!s.enabled) { i.reply({embeds:[ui.warnEmbed('NEXORA is disabled','An administrator can enable the game with `/nexora setup`.')],ephemeral:true}).catch(()=>{});return false; } if(s.maintenance && !requireAdmin(i)){i.reply({embeds:[ui.warnEmbed('World maintenance','The game is temporarily unavailable while administrators configure it.')],ephemeral:true}).catch(()=>{});return false;} if(s.commandChannelId && i.channelId!==s.commandChannelId && !requireAdmin(i)){i.reply({embeds:[ui.warnEmbed('Wrong channel',`Use NEXORA in <#${s.commandChannelId}>.`)],ephemeral:true}).catch(()=>{});return false;} if((s.restrictedRoleIds||[]).some(id=>i.member?.roles?.cache?.has(id))&&!requireAdmin(i)){i.reply({embeds:[ui.warnEmbed('Restricted access','Your roles are not allowed to use this game.')],ephemeral:true}).catch(()=>{});return false;} if(s.allowedRoleIds?.length && !s.allowedRoleIds.some(id=>i.member?.roles?.cache?.has(id))&&!requireAdmin(i)){i.reply({embeds:[ui.warnEmbed('Role required', 'Your roles do not meet this game’s participation rules.')],ephemeral:true}).catch(()=>{});return false;} return true; }
function characterCreate(i) {
  const s=getSettings(i.guildId); const existing=getCharacter(i.guildId,i.user.id);
  if(existing) return i.reply({embeds:[ui.warnEmbed('Character already exists',`Use your existing character **${safeText(existing.name,80)}**. Your progress was not reset.`)],ephemeral:true});
  const name=safeText(i.options.getString('name',true).trim(),30); if(name.length<2) return i.reply({embeds:[ui.errorEmbed('Invalid name','Character names must contain at least 2 characters.')],ephemeral:true});
  const classId=i.options.getString('class',true); const klass=sql.prepare('SELECT * FROM nexora_classes WHERE guildId=? AND classId=?').get(i.guildId,classId);
  if(!klass) return i.reply({embeds:[ui.errorEmbed('Unknown class','Choose a class shown by `/nexora classes`.')],ephemeral:true});
  const region=sql.prepare('SELECT regionId FROM nexora_regions WHERE guildId=? ORDER BY minLevel LIMIT 1').get(i.guildId); const time=now();
  const tx=sql.transaction(()=>{sql.prepare('INSERT INTO nexora_characters(guildId,userId,name,classId,level,xp,hp,maxHp,attack,defense,coins,regionId,createdAt,updatedAt) VALUES(?,?,?,?,1,0,?,?,?,?,?,?,?,?)').run(i.guildId,i.user.id,name,klass.classId,klass.hp,klass.hp,klass.attack,klass.defense,Math.max(0,Math.min(1000000,s.startingCoins)),region?.regionId||'sunmeadow',time,time);sql.prepare('INSERT OR IGNORE INTO nexora_ledger(guildId,userId,action,currencyDelta,xpDelta,reference,createdAt) VALUES(?,?,?,?,?,?,?)').run(i.guildId,i.user.id,'character_start',s.startingCoins,0,`create:${i.id}`,time);});
  tx();audit(i.guildId,i.user.id,'character_create',name); const c=getCharacter(i.guildId,i.user.id);
  return i.reply({embeds:[characterEmbed(i.guild,i.user,c),new EmbedBuilder().setColor(0x22C55E).setTitle('Welcome, adventurer').setDescription('Your character has been created. Use `/nexora explore`, `/nexora fight`, and `/nexora quests` to begin.')],ephemeral:true});
}
function requireCharacter(i) { const c=getCharacter(i.guildId,i.user.id); if(!c) i.reply({embeds:[ui.warnEmbed('No character yet','Create one with `/nexora create` first.')],ephemeral:true}).catch(()=>{}); return c; }
function cmd(name,description) { return new SlashCommandBuilder().setName(name).setDescription(description); }
const base = new SlashCommandBuilder().setName('nexora').setDescription('NEXORA — The Living World Engine');
base.addSubcommand(s=>s.setName('setup').setDescription('Open the per-server NEXORA setup dashboard.'));
base.addSubcommand(s=>s.setName('play').setDescription('View the world dashboard and available activities.'));
base.addSubcommand(s=>s.setName('create').setDescription('Create your character.').addStringOption(o=>o.setName('name').setDescription('Character name').setRequired(true).setMaxLength(30)).addStringOption(o=>o.setName('class').setDescription('Class ID shown by /nexora classes').setRequired(true).setMaxLength(40)));
base.addSubcommand(s=>s.setName('profile').setDescription('View your character profile.'));
base.addSubcommand(s=>s.setName('classes').setDescription('List available character classes.'));
base.addSubcommand(s=>s.setName('regions').setDescription('List regions in this server world.'));
base.addSubcommand(s=>s.setName('explore').setDescription('Travel to a region.').addStringOption(o=>o.setName('region').setDescription('Region ID, e.g. whispering_woods').setRequired(true).setMaxLength(40)));
base.addSubcommand(s=>s.setName('quests').setDescription('List quests and your current progress.'));
base.addSubcommand(s=>s.setName('quest-start').setDescription('Start tracking a quest.').addStringOption(o=>o.setName('quest_id').setDescription('Quest ID shown by /nexora quests').setRequired(true).setMaxLength(40)));
base.addSubcommand(s=>s.setName('quest-claim').setDescription('Claim a completed quest reward.').addStringOption(o=>o.setName('quest_id').setDescription('Quest ID').setRequired(true).setMaxLength(40)));
base.addSubcommand(s=>s.setName('fight').setDescription('Fight a server-calculated enemy in your current region.'));
base.addSubcommand(s=>s.setName('inventory').setDescription('View your inventory.'));
base.addSubcommand(s=>s.setName('shop').setDescription('View items available in the world shop.'));
base.addSubcommand(s=>s.setName('buy').setDescription('Buy an item with your world currency.').addStringOption(o=>o.setName('item_id').setDescription('Item ID shown in the shop').setRequired(true).setMaxLength(40)).addIntegerOption(o=>o.setName('quantity').setDescription('Quantity (1–10)').setMinValue(1).setMaxValue(10)));
base.addSubcommand(s=>s.setName('craft').setDescription('Craft an item using its configured recipe.').addStringOption(o=>o.setName('item_id').setDescription('Craftable item ID').setRequired(true).setMaxLength(40)));
base.addSubcommand(s=>s.setName('leaderboard').setDescription('Show this server’s NEXORA leaderboard.'));
base.addSubcommand(s=>s.setName('backup').setDescription('Export NEXORA settings, world data, and player progress as a JSON file.').addBooleanOption(o=>o.setName('include_players').setDescription('Include character and inventory progress (default true)')));
base.addSubcommand(s=>s.setName('restore').setDescription('Preview and restore a NEXORA JSON backup.').addAttachmentOption(o=>o.setName('file').setDescription('NEXORA backup JSON').setRequired(true)).addBooleanOption(o=>o.setName('include_players').setDescription('Restore player progress too (default true)')));
base.addSubcommand(s=>s.setName('template-save').setDescription('Save the world definitions as a reusable cross-server template.').addStringOption(o=>o.setName('name').setDescription('Template name').setRequired(true).setMaxLength(60)));
base.addSubcommand(s=>s.setName('template-load').setDescription('Preview and load a reusable NEXORA template by code.').addStringOption(o=>o.setName('code').setDescription('Template code').setRequired(true).setMaxLength(20)));

const commands=[{data:base,async execute(i){
  if(!i.guild) return i.reply({content:'NEXORA can only be used in a server.',ephemeral:true});
  const sub=i.options.getSubcommand(); const s=seedWorld(i.guildId) || getSettings(i.guildId);
  if(sub==='setup') {
    if(!requireAdmin(i)) return i.reply(adminError());
    const token=crypto.randomBytes(5).toString('hex'); sessions.set(token,{token,guildId:i.guildId,userId:i.user.id,expiresAt:now()+15*60*1000,section:'dashboard'});
    const reply=await i.reply({embeds:[dashboardEmbed(i.guildId)],components:sectionRowsForSession(sessions.get(token),'dashboard'),ephemeral:true,fetchReply:true});
    const session=sessions.get(token);session.messageId=reply?.id||null; return;
  }
  if(sub==='play') { const regions=sql.prepare('SELECT name,description,minLevel,difficulty FROM nexora_regions WHERE guildId=? ORDER BY minLevel LIMIT 10').all(i.guildId);return i.reply({embeds:[new EmbedBuilder().setColor(0x8B5CF6).setTitle(`✦ ${safeText(s.gameName,80)}`).setDescription(`${safeText(s.worldTitle,100)}\n${safeText(s.description,500)}\n\n**Difficulty:** ${s.difficulty} • **Currency:** ${s.currencySymbol} ${s.currencyName}\n**Your character:** ${getCharacter(i.guildId,i.user.id)?'Created':'Not created yet'}\n\n**Regions**\n${regions.map(r=>`• **${safeText(r.name,70)}** — level ${r.minLevel}+ (${r.difficulty})`).join('\n')}`).setFooter({text:'Create a character with /nexora create'})],ephemeral:true}); }
  if(!starterCheck(i)) return;
  if(sub==='create') return characterCreate(i);
  if(sub==='profile'){const c=getCharacter(i.guildId,i.user.id);return c?i.reply({embeds:[characterEmbed(i.guild,i.user,c)],ephemeral:true}):i.reply({embeds:[ui.warnEmbed('No character','Use `/nexora create` to start your adventure.')],ephemeral:true});}
  if(sub==='classes'){const rows=sql.prepare('SELECT classId,name,description,hp,attack,defense FROM nexora_classes WHERE guildId=? ORDER BY name').all(i.guildId);return i.reply({embeds:[new EmbedBuilder().setColor(0x8B5CF6).setTitle('Available Classes').setDescription(rows.map(x=>`**${safeText(x.name,80)}** · ID \`${x.classId}\`\n${safeText(x.description,200)}\nHP ${x.hp} • ATK ${x.attack} • DEF ${x.defense}`).join('\n\n').slice(0,4000)||'No classes available.')],ephemeral:true});}
  if(sub==='regions'){const c=getCharacter(i.guildId,i.user.id);const rows=sql.prepare('SELECT * FROM nexora_regions WHERE guildId=? ORDER BY minLevel,name').all(i.guildId);return i.reply({embeds:[new EmbedBuilder().setColor(0x8B5CF6).setTitle('World Regions').setDescription(rows.map(r=>`**${safeText(r.name,70)}** · ID \`${r.regionId}\`\nLevel ${r.minLevel}+ • ${r.difficulty} • Travel cost ${s.currencySymbol}${r.travelCost}${c&&c.level<r.minLevel?' — 🔒 level too low':''}\n${safeText(r.description,180)}`).join('\n\n').slice(0,4000))],ephemeral:true});}
  if(sub==='explore'){
    const c=requireCharacter(i);if(!c)return; if(!s.modules.exploration)return i.reply({embeds:[ui.warnEmbed('Exploration disabled','An administrator disabled exploration.')],ephemeral:true});
    const remain=cooldownRemaining(i.guildId,i.user.id,'travel');if(remain) return i.reply({embeds:[ui.warnEmbed('Travel cooldown',`Wait ${(remain/1000).toFixed(1)} seconds before travelling again.`)],ephemeral:true});
    const id=slug(i.options.getString('region',true));const r=sql.prepare('SELECT * FROM nexora_regions WHERE guildId=? AND regionId=?').get(i.guildId,id);if(!r)return i.reply({embeds:[ui.errorEmbed('Region not found','Use `/nexora regions` to see valid region IDs.')],ephemeral:true});if(c.level<r.minLevel)return i.reply({embeds:[ui.warnEmbed('Region locked',`You need level **${r.minLevel}** to enter **${r.name}**.`)],ephemeral:true});if(c.coins<r.travelCost)return i.reply({embeds:[ui.warnEmbed('Not enough currency',`Travel costs ${s.currencySymbol}${r.travelCost}; you have ${s.currencySymbol}${c.coins}.`)],ephemeral:true});
    const tx=sql.transaction(()=>{const fresh=getCharacter(i.guildId,i.user.id);if(!fresh||fresh.coins<r.travelCost)throw new Error('Currency changed before travel.');sql.prepare('UPDATE nexora_characters SET coins=coins-?,regionId=?,updatedAt=? WHERE guildId=? AND userId=?').run(r.travelCost,r.regionId,now(),i.guildId,i.user.id);sql.prepare('INSERT INTO nexora_ledger(guildId,userId,action,currencyDelta,xpDelta,reference,createdAt) VALUES(?,?,?,?,?,?,?)').run(i.guildId,i.user.id,'travel',-r.travelCost,0,`travel:${i.id}`,now());});try{tx();}catch(e){return i.reply({embeds:[ui.errorEmbed('Travel failed',e.message)],ephemeral:true});}
    setCooldown(i.guildId,i.user.id,'travel',Math.max(1,Number(s.travelCooldownSeconds)||10)*1000);trackObjective(i.guildId,i.user.id,'explore',1);const loc=sql.prepare('SELECT * FROM nexora_characters WHERE guildId=? AND userId=?').get(i.guildId,i.user.id);return i.reply({embeds:[new EmbedBuilder().setColor(0x22C55E).setTitle(`Discovered: ${r.name}`).setDescription(`${safeText(r.description,800)}\n\n**Difficulty:** ${r.difficulty}\n**Travel cost:** ${s.currencySymbol}${r.travelCost}\n**Remaining:** ${s.currencySymbol}${loc.coins}\n\nExploration progress has been updated for any active quests.`)],ephemeral:true});
  }
  if(sub==='quests') {const c=getCharacter(i.guildId,i.user.id);if(!c)return i.reply({embeds:[ui.warnEmbed('No character','Create a character first.')],ephemeral:true});const rows=sql.prepare('SELECT q.*,p.progress,p.completedAt,p.claimedAt FROM nexora_quests q LEFT JOIN nexora_quest_progress p ON p.guildId=q.guildId AND p.questId=q.questId AND p.userId=? WHERE q.guildId=? AND q.enabled=1 AND q.minLevel<=? ORDER BY q.name').all(i.user.id,i.guildId,c.level);return i.reply({embeds:[new EmbedBuilder().setColor(0x8B5CF6).setTitle('Quest Journal').setDescription(rows.map(q=>`**${safeText(q.name,90)}** · ID \`${q.questId}\`\n${safeText(q.description,200)}\nProgress: ${q.claimedAt?'✅ Claimed':q.completedAt?'🏆 Ready to claim':`${q.progress||0}/${q.goal} • ${q.objective}`}\nReward: ${q.rewardXp} XP / ${s.currencySymbol}${q.rewardCoins}`).join('\n\n').slice(0,4000)||'No available quests.')],ephemeral:true});}
  if(sub==='quest-start') {const c=requireCharacter(i);if(!c)return;const q=sql.prepare('SELECT * FROM nexora_quests WHERE guildId=? AND questId=? AND enabled=1').get(i.guildId,slug(i.options.getString('quest_id',true)));if(!q)return i.reply({embeds:[ui.errorEmbed('Quest not found','That quest does not exist or is disabled.')],ephemeral:true});if(c.level<q.minLevel)return i.reply({embeds:[ui.warnEmbed('Level requirement',`This quest requires level ${q.minLevel}.`)],ephemeral:true});const p=sql.prepare('SELECT * FROM nexora_quest_progress WHERE guildId=? AND userId=? AND questId=?').get(i.guildId,i.user.id,q.questId);if(p?.claimedAt&&!q.repeatable)return i.reply({embeds:[ui.warnEmbed('Already claimed','This quest can only be claimed once.')],ephemeral:true});sql.prepare('INSERT OR IGNORE INTO nexora_quest_progress(guildId,userId,questId,progress,startedAt) VALUES(?,?,?,?,?)').run(i.guildId,i.user.id,q.questId,0,now());return i.reply({embeds:[ui.okEmbed('Quest started',`**${q.name}**\n${q.description}\n\nTrack progress with \`/nexora quests\`.`)],ephemeral:true});}
  if(sub==='quest-claim') {const c=requireCharacter(i);if(!c)return;const q=sql.prepare('SELECT * FROM nexora_quests WHERE guildId=? AND questId=? AND enabled=1').get(i.guildId,slug(i.options.getString('quest_id',true)));if(!q)return i.reply({embeds:[ui.errorEmbed('Quest not found','That quest does not exist or is disabled.')],ephemeral:true});const tx=sql.transaction(()=>{const p=sql.prepare('SELECT * FROM nexora_quest_progress WHERE guildId=? AND userId=? AND questId=?').get(i.guildId,i.user.id,q.questId);if(!p||p.progress<q.goal)throw new Error('Objective is not complete yet.');if(p.claimedAt&&!q.repeatable)throw new Error('This reward has already been claimed.');const ref=`quest:${q.questId}:${q.repeatable?Math.floor(now()/86400000):'once'}`;const inserted=sql.prepare('INSERT OR IGNORE INTO nexora_ledger(guildId,userId,action,currencyDelta,xpDelta,reference,createdAt) VALUES(?,?,?,?,?,?,?)').run(i.guildId,i.user.id,'quest_reward',q.rewardCoins,q.rewardXp,ref,now());if(!inserted.changes)throw new Error('This reward has already been processed.');sql.prepare('UPDATE nexora_characters SET coins=coins+?,updatedAt=? WHERE guildId=? AND userId=?').run(q.rewardCoins,now(),i.guildId,i.user.id);grantXp(i.guildId,i.user.id,q.rewardXp,s);sql.prepare('UPDATE nexora_quest_progress SET claimedAt=?,completedAt=COALESCE(completedAt,?) WHERE guildId=? AND userId=? AND questId=?').run(now(),now(),i.guildId,i.user.id,q.questId);});try{tx();}catch(e){return i.reply({embeds:[ui.warnEmbed('Cannot claim reward',e.message)],ephemeral:true});}return i.reply({embeds:[ui.okEmbed('Quest rewards claimed',`**${q.name}**\n+${q.rewardXp} XP\n+${s.currencySymbol}${q.rewardCoins}`)],ephemeral:true});}
  if(sub==='fight') {
    const c=requireCharacter(i);if(!c)return;if(!s.modules.combat)return i.reply({embeds:[ui.warnEmbed('Combat disabled','An administrator disabled combat.')],ephemeral:true});const remain=cooldownRemaining(i.guildId,i.user.id,'battle');if(remain)return i.reply({embeds:[ui.warnEmbed('Battle cooldown',`Wait ${(remain/1000).toFixed(1)} seconds before fighting again.`)],ephemeral:true});const r=sql.prepare('SELECT * FROM nexora_regions WHERE guildId=? AND regionId=?').get(i.guildId,c.regionId);if(!r)return i.reply({embeds:[ui.errorEmbed('Region unavailable','Your current region no longer exists. Ask an administrator to repair the world.')],ephemeral:true});
    const difficulty={Easy:0.7,Normal:1,Hard:1.35,Extreme:1.8,Custom:1}[s.difficulty]||1;const enemyList=[{name:'Moss Slime',hp:25,atk:7,def:1,reward:12},{name:'Wayward Wolf',hp:40,atk:10,def:3,reward:20},{name:'Ashling',hp:55,atk:13,def:5,reward:28}];const baseEnemy=enemyList[Math.min(enemyList.length-1,Math.max(0,Math.floor((r.minLevel-1)/3)))];const enemy={...baseEnemy,hp:Math.round((baseEnemy.hp+(r.minLevel-1)*6)*difficulty),atk:Math.round((baseEnemy.atk+(r.minLevel-1)*1.5)*difficulty),def:Math.round(baseEnemy.def*difficulty)};let playerHp=c.hp,enemyHp=enemy.hp,rounds=0,lines=[];while(playerHp>0&&enemyHp>0&&rounds<12){rounds++;const damage=Math.max(1,c.attack+Math.floor(Math.random()*7)-enemy.def);enemyHp=Math.max(0,enemyHp-damage);lines.push(`Round ${rounds}: you dealt ${damage} damage.`);if(enemyHp>0){const hit=Math.max(1,enemy.atk+Math.floor(Math.random()*5)-c.defense);playerHp=Math.max(0,playerHp-hit);lines.push(`${enemy.name} dealt ${hit} damage.`);}}
    const won=enemyHp===0;const coins=won?Math.min(500,Math.max(1,Math.round((enemy.reward+r.minLevel*3)*difficulty))):0;const xp=won?Math.min(1000,Math.max(5,Math.round((enemy.reward*2+r.minLevel*5)*difficulty))):Math.max(1,Math.floor(r.minLevel*2));const tx=sql.transaction(()=>{const ref=`battle:${i.id}`;sql.prepare('INSERT INTO nexora_ledger(guildId,userId,action,currencyDelta,xpDelta,reference,createdAt) VALUES(?,?,?,?,?,?,?)').run(i.guildId,i.user.id,won?'battle_win':'battle_loss',won?coins:0,xp,ref,now());sql.prepare('UPDATE nexora_characters SET hp=?,coins=coins+?,updatedAt=? WHERE guildId=? AND userId=?').run(Math.max(1,playerHp||Math.floor(c.maxHp*.5)),coins,now(),i.guildId,i.user.id);grantXp(i.guildId,i.user.id,xp,s);if(won){const gather=Math.random()<0.55?'iron_ore':'wood';addInventory(i.guildId,i.user.id,gather,1);}});try{tx();}catch(e){return i.reply({embeds:[ui.errorEmbed('Battle failed','The battle could not be saved safely. No reward was claimed.')],ephemeral:true});}setCooldown(i.guildId,i.user.id,'battle',Math.max(1,Number(s.battleCooldownSeconds)||30)*1000);if(won)trackObjective(i.guildId,i.user.id,'battle',1);const latest=getCharacter(i.guildId,i.user.id);const log=lines.slice(0,16).join('\n');return i.reply({embeds:[new EmbedBuilder().setColor(won?0x22C55E:0xEF4444).setTitle(won?`Victory — ${enemy.name}`:`Defeat — ${enemy.name}`).setDescription(`${log}\n\n**Enemy HP:** ${enemyHp}/${enemy.hp}\n**Your HP:** ${latest.hp}/${latest.maxHp}\n**Rewards:** ${won?`${s.currencySymbol}${coins} and ${xp} XP plus one resource`:`${xp} XP for the attempt`}`)],ephemeral:true});
  }
  if(sub==='inventory'){const c=requireCharacter(i);if(!c)return;const rows=sql.prepare('SELECT i.itemId,i.name,i.itemType,i.rarity,inv.quantity FROM nexora_inventory inv JOIN nexora_items i ON i.guildId=inv.guildId AND i.itemId=inv.itemId WHERE inv.guildId=? AND inv.userId=? AND inv.quantity>0 ORDER BY i.name').all(i.guildId,i.user.id);return i.reply({embeds:[new EmbedBuilder().setColor(0x8B5CF6).setTitle(`${c.name} — Inventory`).setDescription(rows.map(x=>`• **${safeText(x.name,70)}** ×${x.quantity} · ${x.rarity} · \`${x.itemId}\``).join('\n').slice(0,4000)||'Your inventory is empty. Fight enemies to find resources, or buy an item from `/nexora shop`.')],ephemeral:true});}
  if(sub==='shop'){const rows=sql.prepare('SELECT itemId,name,description,itemType,rarity,price FROM nexora_items WHERE guildId=? ORDER BY price,name LIMIT 25').all(i.guildId);return i.reply({embeds:[new EmbedBuilder().setColor(0x8B5CF6).setTitle('World Shop').setDescription(rows.map(x=>`**${safeText(x.name,70)}** · \`${x.itemId}\` · ${s.currencySymbol}${x.price}\n${safeText(x.description,140)} · ${x.itemType} (${x.rarity})`).join('\n\n').slice(0,4000)||'The shop is empty.')],ephemeral:true});}
  if(sub==='buy'){const c=requireCharacter(i);if(!c)return;const item=sql.prepare('SELECT * FROM nexora_items WHERE guildId=? AND itemId=?').get(i.guildId,slug(i.options.getString('item_id',true)));if(!item)return i.reply({embeds:[ui.errorEmbed('Item not found','Use `/nexora shop` to find valid item IDs.')],ephemeral:true});const qty=i.options.getInteger('quantity')||1;const total=item.price*qty;if(!Number.isSafeInteger(total)||total<0||total>1_000_000_000)return i.reply({embeds:[ui.errorEmbed('Invalid purchase','The price is outside allowed bounds.')],ephemeral:true});const tx=sql.transaction(()=>{const fresh=getCharacter(i.guildId,i.user.id);if(!fresh||fresh.coins<total)throw new Error('Not enough currency.');const inv=sql.prepare('SELECT quantity FROM nexora_inventory WHERE guildId=? AND userId=? AND itemId=?').get(i.guildId,i.user.id,item.itemId);if((inv?.quantity||0)+qty>Math.min(item.stackLimit,s.security.maxInventoryStack))throw new Error('Inventory stack limit reached.');sql.prepare('UPDATE nexora_characters SET coins=coins-?,updatedAt=? WHERE guildId=? AND userId=?').run(total,now(),i.guildId,i.user.id);addInventory(i.guildId,i.user.id,item.itemId,qty);sql.prepare('INSERT INTO nexora_ledger(guildId,userId,action,currencyDelta,xpDelta,reference,createdAt) VALUES(?,?,?,?,?,?,?)').run(i.guildId,i.user.id,'shop_purchase',-total,0,`buy:${i.id}`,now());});try{tx();}catch(e){return i.reply({embeds:[ui.warnEmbed('Purchase rejected',e.message)],ephemeral:true});}return i.reply({embeds:[ui.okEmbed('Purchase complete',`Bought **${qty}× ${item.name}** for ${s.currencySymbol}${total}.`)],ephemeral:true});}
  if(sub==='craft'){const c=requireCharacter(i);if(!c)return;const item=sql.prepare('SELECT * FROM nexora_items WHERE guildId=? AND itemId=?').get(i.guildId,slug(i.options.getString('item_id',true)));if(!item)return i.reply({embeds:[ui.errorEmbed('Item not found','That item is not registered in this world.')],ephemeral:true});let d={};try{d=JSON.parse(item.data||'{}');}catch{}const recipe=d.recipe;if(!Array.isArray(recipe)||!recipe.length)return i.reply({embeds:[ui.warnEmbed('Not craftable','This item does not have a crafting recipe configured.')],ephemeral:true});const tx=sql.transaction(()=>{for(const ing of recipe){if(!/^[a-z0-9_]{1,40}$/.test(String(ing.itemId||''))||!Number.isInteger(ing.quantity)||ing.quantity<1||ing.quantity>100)throw new Error('The recipe is invalid.');const inv=sql.prepare('SELECT quantity FROM nexora_inventory WHERE guildId=? AND userId=? AND itemId=?').get(i.guildId,i.user.id,ing.itemId);if((inv?.quantity||0)<ing.quantity)throw new Error(`Not enough ingredients: ${ing.itemId} ×${ing.quantity}.`);}for(const ing of recipe){sql.prepare('UPDATE nexora_inventory SET quantity=quantity-? WHERE guildId=? AND userId=? AND itemId=?').run(ing.quantity,i.guildId,i.user.id,ing.itemId);}addInventory(i.guildId,i.user.id,item.itemId,1);sql.prepare('DELETE FROM nexora_inventory WHERE guildId=? AND userId=? AND quantity<=0').run(i.guildId,i.user.id);sql.prepare('INSERT INTO nexora_ledger(guildId,userId,action,currencyDelta,xpDelta,reference,createdAt) VALUES(?,?,?,?,?,?,?)').run(i.guildId,i.user.id,'craft',0,0,`craft:${i.id}`,now());});try{tx();}catch(e){return i.reply({embeds:[ui.warnEmbed('Crafting failed',e.message)],ephemeral:true});}return i.reply({embeds:[ui.okEmbed('Crafting complete',`Created **${item.name}**.`)],ephemeral:true});}
  if(sub==='leaderboard'){const rows=sql.prepare('SELECT userId,name,level,xp,coins FROM nexora_characters WHERE guildId=? ORDER BY level DESC,xp DESC LIMIT 10').all(i.guildId);return i.reply({embeds:[new EmbedBuilder().setColor(0x8B5CF6).setTitle('NEXORA Leaderboard').setDescription(rows.map((x,n)=>`**${n+1}.** <@${x.userId}> — **Lv. ${x.level} ${safeText(x.name,40)}** · ${x.xp} XP · ${s.currencySymbol}${x.coins}`).join('\n')||'No characters have been created yet.')],ephemeral:false,allowedMentions:{parse:[]}});}
  if(sub==='backup') {if(!requireAdmin(i))return i.reply(adminError());const data=makeBackup(i.guildId,i.options.getBoolean('include_players')!==false);const file=new AttachmentBuilder(Buffer.from(JSON.stringify(data,null,2)),{name:`nexora-${i.guildId}-${Date.now()}.json`});audit(i.guildId,i.user.id,'backup_export',`Players included: ${!!data.characters}`);return i.reply({embeds:[ui.okEmbed('NEXORA backup created',`Version ${data.schemaVersion}. Contains ${data.regions.length} regions, ${data.classes.length} classes, ${data.items.length} items and ${data.quests.length} quests.${data.characters?` Includes ${data.characters.length} characters.`:''}\nKeep this file somewhere outside Railway's volume.`)],files:[file],ephemeral:true});}
  if(sub==='restore') {if(!requireAdmin(i))return i.reply(adminError());const a=i.options.getAttachment('file',true);if(a.size>5*1024*1024)return i.reply({embeds:[ui.errorEmbed('Backup too large','NEXORA restore accepts JSON files up to 5 MB.')],ephemeral:true});let data;try{const res=await fetch(a.url);if(!res.ok)throw new Error(`Download failed (${res.status}).`);data=await res.json();validateBackup(data);}catch(e){return i.reply({embeds:[ui.errorEmbed('Backup rejected',safeText(e.message||'Invalid backup',500))],ephemeral:true});}const token=crypto.randomBytes(5).toString('hex');restoreSessions.set(token,{guildId:i.guildId,userId:i.user.id,data,includePlayers:i.options.getBoolean('include_players')!==false,expiresAt:now()+5*60*1000});const preview=`**Source guild:** ${safeText(data.guildId||'unknown',40)}\n**Version:** ${data.schemaVersion}\n**Regions:** ${data.regions.length}\n**Classes:** ${data.classes.length}\n**Items:** ${data.items.length}\n**Quests:** ${data.quests.length}\n**Characters:** ${data.characters?.length||0}\n**Player data:** ${i.options.getBoolean('include_players')!==false?'will be restored':'will be skipped'}\n\nThis replaces/updates matching NEXORA definitions only. Unrelated AunXz settings are untouched.`;return i.reply({embeds:[ui.warnEmbed('Restore preview — confirmation required',preview)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`nexora:restore-confirm:${token}`).setLabel('Confirm restore').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId(`nexora:restore-cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))],ephemeral:true});}
  if(sub==='template-save') {if(!requireAdmin(i))return i.reply(adminError());const name=safeText(i.options.getString('name',true).trim(),60);if(name.length<2)return i.reply({embeds:[ui.errorEmbed('Invalid name','Template name must contain at least 2 characters.')],ephemeral:true});const d=makeBackup(i.guildId,false);const payload={format:'NEXORA-TEMPLATE',schemaVersion:1,settings:d.settings,regions:d.regions,classes:d.classes,items:d.items,quests:d.quests};const code=`NX-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;sql.prepare('INSERT INTO nexora_templates(code,createdGuildId,createdBy,name,payload,createdAt) VALUES(?,?,?,?,?,?)').run(code,i.guildId,i.user.id,name,JSON.stringify(payload),now());audit(i.guildId,i.user.id,'template_save',`${name} (${code})`);return i.reply({embeds:[ui.okEmbed('Template saved',`**${name}**\nTemplate code: \`${code}\`\nThis template contains world definitions only, no player data or secrets. Use \`/nexora template-load code:${code}\` in the destination server.`)],ephemeral:true});}
  if(sub==='template-load') {if(!requireAdmin(i))return i.reply(adminError());const code=i.options.getString('code',true).trim().toUpperCase();const row=sql.prepare('SELECT * FROM nexora_templates WHERE code=?').get(code);if(!row)return i.reply({embeds:[ui.errorEmbed('Template not found','Check the template code. Templates currently reside in this bot database and are shared across guilds only while that database is retained.')],ephemeral:true});let data;try{data=JSON.parse(row.payload);}catch{return i.reply({embeds:[ui.errorEmbed('Template invalid','Stored template could not be parsed.')],ephemeral:true});}if(data.format!=='NEXORA-TEMPLATE'||data.schemaVersion!==1)return i.reply({embeds:[ui.errorEmbed('Unsupported template','This template version is not supported.')],ephemeral:true});const token=crypto.randomBytes(5).toString('hex');restoreSessions.set(token,{guildId:i.guildId,userId:i.user.id,data:{...data,format:'NEXORA-BACKUP',guildId:row.createdGuildId,schemaVersion:1},includePlayers:false,expiresAt:now()+5*60*1000});return i.reply({embeds:[ui.warnEmbed('Template preview',`**${safeText(row.name,60)}**\nRegions: ${data.regions.length} • Classes: ${data.classes.length} • Items: ${data.items.length} • Quests: ${data.quests.length}\n\nApplying this template does not import player data.`)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`nexora:restore-confirm:${token}`).setLabel('Apply template').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`nexora:restore-cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))],ephemeral:true});}
}}];

async function handleInteraction(i) {
  if(!i.customId?.startsWith('nexora:')) return false;
  const bits=i.customId.split(':');
  if(bits[1]==='restore-confirm'||bits[1]==='restore-cancel') {
    if(!i.guildId||!requireAdmin(i)) {await i.reply(adminError()).catch(()=>{});return true;}
    const token=bits[2], session=restoreSessions.get(token);
    if(!session||session.expiresAt<now()||session.guildId!==i.guildId||session.userId!==i.user.id){restoreSessions.delete(token);await i.reply({embeds:[ui.warnEmbed('Restore session expired','Run the restore or template-load command again.')],ephemeral:true}).catch(()=>{});return true;}
    restoreSessions.delete(token);
    if(bits[1]==='restore-cancel') {await i.update({embeds:[ui.warnEmbed('Cancelled','No NEXORA data was changed.')],components:[]}).catch(()=>{});return true;}
    try{applyBackup(i.guildId,i.user.id,session.data,session.includePlayers);await i.update({embeds:[ui.okEmbed('NEXORA restored',`World definitions restored successfully. ${session.includePlayers?'Player progress was included when present.':'Player progress was not imported.'} Existing matching definitions were updated; unrelated bot settings were not touched.`)],components:[]});}catch(e){await i.update({embeds:[ui.errorEmbed('Restore failed',safeText(e.message||e,700))],components:[]}).catch(()=>{});}return true;
  }
  if(bits[1]==='section' && bits.length===2) return true;
  if(bits[1]==='modal') return true;
  const token=bits[1]; let session=sessions.get(token);
  if(!session||session.expiresAt<now()) {sessions.delete(token);if(i.isRepliable()) await i.reply({embeds:[ui.warnEmbed('Setup expired','Run `/nexora setup` again to open a fresh setup panel.')],ephemeral:true}).catch(()=>{});return true;}
  if(!i.guildId||i.guildId!==session.guildId||!requireAdmin(i)){await i.reply(adminError()).catch(()=>{});return true;}
  session.expiresAt=now()+15*60*1000;
  const action=bits.slice(2).join(':');
  if(action==='section' && i.isStringSelectMenu()) {session.section=i.values[0];await i.update({embeds:[sectionEmbedSession(session,session.section)],components:sectionRowsForSession(session,session.section)});return true;}
  if(action.startsWith('section:')) {session.section=action.split(':')[1];await i.update({embeds:[sectionEmbedSession(session,session.section)],components:sectionRowsForSession(session,session.section)});return true;}
  if(action==='back'){session.section='dashboard';await i.update({embeds:[dashboardEmbed(session.guildId)],components:sectionRowsForSession(session,'dashboard')});return true;}
  if(action==='toggle-system'){const cfg=saveSettings(session.guildId,{enabled:!getSettings(session.guildId).enabled},i.user.id);await i.update({embeds:[dashboardEmbed(session.guildId)],components:sectionRowsForSession(session,'dashboard')});return true;}
  if(action.startsWith('toggle:')){const mod=action.slice(7);if(!AVAILABLE.has(mod)){await i.reply({embeds:[ui.warnEmbed('Module unavailable','That module has no gameplay handler in this build; it cannot be enabled.')],ephemeral:true});return true;}const cfg=getSettings(session.guildId);saveSettings(session.guildId,{modules:{[mod]:!cfg.modules[mod]}},i.user.id);await i.update({embeds:[dashboardEmbed(session.guildId,session.section)],components:sectionRowsForSession(session,session.section)});return true;}
  if(action==='preset'&&i.isStringSelectMenu()){const p=presetPatch(i.values[0]);const names={fantasy:'Fantasy RPG',anime:'Anime Adventure',minecraft:'Minecraft Survival',casual:'Casual Community Games',cooperative:'Cooperative World Adventure',blank:'Custom Blank World'};saveSettings(session.guildId,{...p,gameName:'NEXORA',worldTitle:names[i.values[0]],theme:p.theme,modules:i.values[0]==='blank'?{world:false,exploration:false,combat:false,quests:false}:{}},i.user.id);session.section='dashboard';await i.update({embeds:[dashboardEmbed(session.guildId)],components:sectionRowsForSession(session,'dashboard')});return true;}
  if(action==='edit-general'){return showGeneralModal(i,session);}
  if(action==='add-region')return showAddRegionModal(i,session);
  if(action==='add-class')return showAddClassModal(i,session);
  if(action==='add-quest')return showAddQuestModal(i,session);
  if(action==='add-item')return showAddItemModal(i,session);
  if(action==='channel-picker'){await i.reply({embeds:[new EmbedBuilder().setColor(0x8B5CF6).setTitle('Channel settings').setDescription('Select a NEXORA command channel from the selector below.')],components:sectionRowsForSession(session,'channels'),ephemeral:true});return true;}
  if(action==='channel-select'&&i.isChannelSelectMenu()){const ch=i.guild.channels.cache.get(i.values[0]);if(!ch?.isTextBased()){await i.reply({content:'Select a text channel.',ephemeral:true});return true;}saveSettings(session.guildId,{commandChannelId:ch.id},i.user.id);session.section='channels';await i.update({embeds:[dashboardEmbed(session.guildId,'channels')],components:sectionRowsForSession(session,'channels')});return true;}
  if(action==='backup-info'){await i.reply({embeds:[ui.infoEmbed('NEXORA Backup & Restore','Use `/nexora backup` to export JSON and store it outside the Railway volume. Use `/nexora restore file:<attachment>` to preview and then explicitly confirm a restore. Only NEXORA tables are modified.')],ephemeral:true});return true;}
  if(action.startsWith('modal:')&&i.isModalSubmit()) {
    const kind=action.slice(6);const v=id=>i.fields.getTextInputValue(id).trim();
    try {
      if(kind==='general') {const diff=v('difficulty');if(!['easy','normal','hard','extreme','custom'].includes(diff.toLowerCase()))throw new Error('Difficulty must be Easy, Normal, Hard, Extreme, or Custom.');const patch={gameName:safeText(v('gameName'),80),worldTitle:safeText(v('worldTitle'),100),currencyName:safeText(v('currencyName'),30),currencySymbol:safeText(v('currencySymbol'),8),difficulty:diff[0].toUpperCase()+diff.slice(1).toLowerCase()};if(!patch.gameName||!patch.worldTitle||!patch.currencyName||!patch.currencySymbol)throw new Error('Game, world, currency name, and symbol cannot be empty.');saveSettings(session.guildId,patch,i.user.id);session.section='general';}
      else if(kind==='region'){const name=safeText(v('name'),70);const minLevel=Number(v('minLevel')),cost=Number(v('travelCost')),difficulty=v('difficulty');if(!name||!Number.isInteger(minLevel)||minLevel<1||minLevel>200||!Number.isInteger(cost)||cost<0||cost>1000000)throw new Error('Level must be 1–200 and travel cost 0–1,000,000.');if(!['easy','normal','hard','extreme'].includes(difficulty.toLowerCase()))throw new Error('Difficulty must be Easy, Normal, Hard, or Extreme.');sql.prepare('INSERT INTO nexora_regions(guildId,regionId,name,description,difficulty,minLevel,travelCost,data) VALUES(?,?,?,?,?,?,?,?)').run(session.guildId,slug(name),name,safeText(v('description'),700),difficulty[0].toUpperCase()+difficulty.slice(1).toLowerCase(),minLevel,cost,'{}');audit(session.guildId,i.user.id,'region_create',name);session.section='world';}
      else if(kind==='class'){const name=safeText(v('name'),70),hp=Number(v('hp')),attack=Number(v('attack')),defense=Number(v('defense'));if(!name||!Number.isInteger(hp)||hp<20||hp>1000||!Number.isInteger(attack)||attack<1||attack>250||!Number.isInteger(defense)||defense<0||defense>200)throw new Error('HP must be 20–1000, attack 1–250, defense 0–200.');sql.prepare('INSERT INTO nexora_classes(guildId,classId,name,description,hp,attack,defense,data) VALUES(?,?,?,?,?,?,?,?)').run(session.guildId,slug(name),name,safeText(v('description'),500),hp,attack,defense,'{}');audit(session.guildId,i.user.id,'class_create',name);session.section='classes';}
      else if(kind==='quest'){const name=safeText(v('name'),80),objective=v('objective').toLowerCase(),goal=Number(v('goal')),rewards=v('rewards').split(',').map(Number);if(!name||!['explore','battle'].includes(objective))throw new Error('Objective type must be explore or battle.');if(!Number.isInteger(goal)||goal<1||goal>1000)throw new Error('Goal must be an integer from 1–1000.');if(rewards.length!==2||rewards.some(n=>!Number.isInteger(n)||n<0||n>5000))throw new Error('Rewards must be two non-negative integers up to 5000: XP,coins.');sql.prepare('INSERT INTO nexora_quests(guildId,questId,name,description,objective,goal,rewardXp,rewardCoins,minLevel,enabled,repeatable,data) VALUES(?,?,?,?,?,?,?,?,1,1,0,?)').run(session.guildId,slug(name),name,safeText(v('description'),500),objective,goal,rewards[0],rewards[1],'{}');audit(session.guildId,i.user.id,'quest_create',name);session.section='quests';}
      else if(kind==='item'){const id=slug(v('id')),name=safeText(v('name'),70),price=Number(v('price')),type=v('type').toLowerCase();if(!/^[a-z0-9_]{1,40}$/.test(id)||!name)throw new Error('Provide a valid item ID and name.');if(!Number.isInteger(price)||price<0||price>1000000)throw new Error('Price must be 0–1,000,000.');if(!['material','equipment','consumable'].includes(type))throw new Error('Type must be material, equipment, or consumable.');sql.prepare('INSERT INTO nexora_items(guildId,itemId,name,description,itemType,rarity,price,stackLimit,attackBonus,defenseBonus,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(session.guildId,id,name,safeText(v('description'),400),type,'Common',price,type==='equipment'?1:99,0,0,'{}');audit(session.guildId,i.user.id,'item_create',`${id} ${name}`);session.section='inventory';}
      await i.reply({embeds:[ui.okEmbed('NEXORA settings saved','The change was validated and stored in this server’s database. Press Refresh in your setup panel to view it.')],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`nexora:${session.token}:section:${session.section}`).setLabel('Refresh setup panel').setStyle(ButtonStyle.Primary))],ephemeral:true});
    } catch(e){await i.reply({embeds:[ui.errorEmbed('Could not save setting',safeText(e.message||e,800))],ephemeral:true}).catch(()=>{});}return true;
  }
  await i.reply({embeds:[ui.warnEmbed('NEXORA control','This control is not available in this version.')],ephemeral:true}).catch(()=>{});return true;
}

module.exports={commands,handleInteraction,makeBackup,validateBackup,getSettings,_internals:{sql,SECTION_LIST,AVAILABLE,trackObjective,xpNeeded}};
