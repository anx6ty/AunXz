'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, ChannelType, PermissionFlagsBits,
  PermissionFlagsBits: PERM, AuditLogEvent, AttachmentBuilder
} = require('discord.js');
const crypto = require('node:crypto');
const db = require('./database');

const CATEGORIES = [
  ['messages', 'Messages'], ['members', 'Members'], ['invites', 'Invites'],
  ['roles', 'Roles & Permissions'], ['channels', 'Channels & Threads'],
  ['server', 'Server Settings'], ['moderation', 'Moderation'], ['voice', 'Voice & Stage'],
  ['assets', 'Emojis & Integrations'], ['security', 'Security & AntiNuke'],
  ['system', 'Bot & System']
];
const EVENTS = [
  ['messageCreate','messages','Message created',false],
  ['messageDelete','messages','Message deleted',true],
  ['messageUpdate','messages','Message edited',true],
  ['messageBulkDelete','messages','Bulk message deletion',true],
  ['messagePin','messages','Message pinned / unpinned',true],
  ['reactionAdd','messages','Reaction added',false],
  ['reactionRemove','messages','Reaction removed',false],
  ['memberJoin','members','Member joined',true],
  ['memberLeave','members','Member left',true],
  ['memberUpdate','members','Member profile / role updated',true],
  ['memberKick','members','Member kicked (attributed only)',true],
  ['banAdd','moderation','Member banned',true],
  ['banRemove','moderation','Member unbanned',true],
  ['inviteCreate','invites','Invite created',true],
  ['inviteDelete','invites','Invite deleted',true],
  ['inviteJoin','invites','Join invite attribution',true],
  ['roleCreate','roles','Role created',true],
  ['roleDelete','roles','Role deleted',true],
  ['roleUpdate','roles','Role changed / permission diff',true],
  ['memberRoles','roles','Member roles changed',true],
  ['channelCreate','channels','Channel created',true],
  ['channelDelete','channels','Channel deleted',true],
  ['channelUpdate','channels','Channel settings / overwrite changed',true],
  ['threadCreate','channels','Thread created',true],
  ['threadUpdate','channels','Thread changed',true],
  ['threadDelete','channels','Thread deleted',true],
  ['guildUpdate','server','Server settings changed',true],
  ['voiceUpdate','voice','Voice state changed',true],
  ['emojiCreate','assets','Emoji created',true],
  ['emojiUpdate','assets','Emoji changed',true],
  ['emojiDelete','assets','Emoji deleted',true],
  ['stickerCreate','assets','Sticker created',true],
  ['stickerUpdate','assets','Sticker changed',true],
  ['stickerDelete','assets','Sticker deleted',true],
  ['webhooksUpdate','assets','Webhooks changed',true],
  ['scheduledCreate','assets','Scheduled event created',true],
  ['scheduledUpdate','assets','Scheduled event changed',true],
  ['scheduledDelete','assets','Scheduled event deleted',true],
  ['stageCreate','voice','Stage created',true],
  ['stageUpdate','voice','Stage changed',true],
  ['stageDelete','voice','Stage deleted',true],
  ['securityIncident','security','Suspicious activity correlated',true],
  ['botStartup','system','Bot startup',false]
].map(([key, category, label, enabled]) => ({key, category, label, enabled}));
const CATEGORY_KEYS = new Set(CATEGORIES.map(([k]) => k));
const EVENT_BY_KEY = new Map(EVENTS.map(e => [e.key, e]));
const eventDefault = Object.fromEntries(EVENTS.map(e => [e.key, e.enabled]));
const defaultConfig = () => ({
  enabled: false,
  categories: Object.fromEntries(CATEGORIES.map(([k]) => [k, true])),
  events: { ...eventDefault },
  channels: Object.fromEntries(CATEGORIES.map(([k]) => [k, null])),
  sharedChannelId: null,
  contentEvidence: false,
  attachmentEvidence: true,
  detail: 'detailed',
  retentionDays: 7,
  ignored: { channels: [], users: [], roles: [], bots: false },
  attributionEnabled: true,
  security: { threshold: 5, windowSeconds: 10 }
});
const sessions = new Map();
const recentByChannel = new Map();
const deletedMessages = new Set();
const usedAuditEntries = new Map();
const inviteLocks = new Map();
const webhookSnapshots = new Map();
const securityWindows = new Map();
const MAX_CACHED_CHANNEL_MESSAGES = 120;
const MAX_CACHED_MESSAGES = 5000;
let clientRef = null;
let initialized = false;

try {
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS advanced_invite_snapshot (
      guildId TEXT NOT NULL, code TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
      inviterId TEXT, expiresAt INTEGER, updatedAt INTEGER NOT NULL,
      PRIMARY KEY(guildId, code)
    );
    CREATE TABLE IF NOT EXISTS advanced_invite_history (
      guildId TEXT NOT NULL, userId TEXT NOT NULL, code TEXT, inviterId TEXT,
      confidence TEXT NOT NULL, joinedAt INTEGER NOT NULL,
      PRIMARY KEY(guildId, userId)
    );
    CREATE INDEX IF NOT EXISTS idx_advanced_invite_history_inviter ON advanced_invite_history(guildId,inviterId,joinedAt DESC);
  `);
} catch (e) { console.error('[AdvancedLogging] schema initialization failed:', e.message); }

const safe = (v, max = 900) => String(v ?? 'Unavailable')
  .replace(/@everyone|@here/gi, '@\u200b$&')
  .replace(/<(?:@!?|@&)\d{15,22}>/g, match => match.replace('<@', '<@\u200b'))
  .slice(0, max);
const mentionSafe = value => String(value ?? '').replace(/@everyone|@here/gi, '@\u200b$&');
function merge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) out[key] = merge(out[key], value);
    else out[key] = value;
  }
  return out;
}
function getConfig(guildId) {
  return merge(defaultConfig(), db.getConfig(guildId).advancedLogging || {});
}
function saveConfig(guildId, patch, actorId) {
  const next = merge(getConfig(guildId), patch || {});
  db.saveConfig(guildId, { advancedLogging: next });
  if (actorId) db.logAction(guildId, actorId, 'advanced_logging_config', safe(JSON.stringify(patch), 900));
  return next;
}
function isAdmin(i) {
  return !!i.guild && (i.guild.ownerId === i.user.id || i.memberPermissions?.has(PERM.Administrator) || i.memberPermissions?.has(PERM.ManageGuild));
}
function canLog(guild, category, eventKey) {
  const cfg = getConfig(guild.id);
  if (!cfg.enabled || !cfg.categories[category] || cfg.events[eventKey] === false) return null;
  if (cfg.ignored?.bots && clientRef?.user?.id && eventKey !== 'botStartup') return cfg;
  return cfg;
}
function isIgnored(cfg, event) {
  const i = cfg.ignored || {};
  if (event.channelId && (i.channels || []).includes(event.channelId)) return true;
  if (event.userId && (i.users || []).includes(event.userId)) return true;
  if (event.roleIds && event.roleIds.some(id => (i.roles || []).includes(id))) return true;
  if (event.isBot && i.bots && event.eventKey !== 'botStartup') return true;
  return false;
}
function clip(value, max=1000) { return safe(value, max) || '—'; }
function stamp(ms=Date.now()) { return `<t:${Math.floor(ms/1000)}:F> (<t:${Math.floor(ms/1000)}:R>)`; }
function baseEmbed(guild, title, description, severity='info') {
  const colors = {info:0x5865F2, success:0x22C55E, warning:0xF59E0B, danger:0xEF4444};
  return new EmbedBuilder().setColor(colors[severity] || colors.info).setTitle(clip(title, 250)).setDescription(clip(description || '\u200b', 3900))
    .setFooter({text:`${safe(guild.name,80)} • ${guild.id} • Advanced Logs`}).setTimestamp(new Date());
}
function addFields(embed, fields) {
  const prepared = (fields || []).filter(f => f && f.value !== undefined && f.value !== null && String(f.value).length)
    .slice(0,25).map(f => ({name:clip(f.name,256), value:clip(f.value,1024), inline:!!f.inline}));
  if (prepared.length) embed.addFields(prepared);
  return embed;
}
function isEventEnabled(cfg, eventKey) {
  const ev = EVENT_BY_KEY.get(eventKey);
  if (!ev || !cfg.enabled || !cfg.categories[ev.category]) return false;
  return cfg.events[eventKey] ?? ev.enabled;
}
async function resolveLogChannel(guild, category, cfg = getConfig(guild.id)) {
  const id = cfg.channels?.[category] || cfg.sharedChannelId || null;
  if (!id) return null;
  let ch = guild.channels.cache.get(id);
  if (!ch) ch = await guild.channels.fetch(id).catch(() => null);
  if (!ch?.isTextBased?.() || !ch.send) return null;
  const me = guild.members.me;
  if (me && !ch.permissionsFor(me)?.has([PERM.ViewChannel, PERM.SendMessages, PERM.EmbedLinks])) return null;
  return ch;
}
async function emit(guild, category, eventKey, title, description, fields=[], severity='info', extra={}) {
  try {
    const cfg = getConfig(guild.id);
    if (!isEventEnabled(cfg, eventKey)) return false;
    if (isIgnored(cfg, { eventKey, channelId: extra.channelId, userId: extra.userId, roleIds: extra.roleIds, isBot: extra.isBot })) return false;
    const channel = await resolveLogChannel(guild, category, cfg);
    if (!channel) return false;
    const embed = addFields(baseEmbed(guild, title, description, severity), fields);
    if (cfg.detail !== 'compact') {
      embed.addFields({name:'Event',value:`\`${eventKey}\``,inline:true},{name:'Detected',value:stamp(),inline:true});
      if (extra.actor) embed.addFields({name:'Actor',value:clip(extra.actor,900),inline:false});
      if (extra.attribution) embed.addFields({name:'Attribution',value:clip(extra.attribution,400),inline:false});
    }
    await channel.send({embeds:[embed],allowedMentions:{parse:[]}});
    return true;
  } catch (e) {
    console.warn(`[AdvancedLogging] ${eventKey} delivery failed in ${guild?.id || 'unknown guild'}:`, e?.message || e);
    return false;
  }
}
function snapshotMessage(message, cfg=getConfig(message.guildId)) {
  const attaches = [...(message.attachments?.values?.() || [])].map(a => ({id:a.id,name:a.name,size:a.size,url:a.url,contentType:a.contentType||null}));
  return {
    id: String(message.id), guildId: message.guildId, channelId: message.channelId,
    authorId: message.author?.id || null, authorTag: message.author?.tag || message.author?.username || 'Unknown',
    displayName: message.member?.displayName || message.author?.globalName || message.author?.username || 'Unknown',
    avatar: message.author?.displayAvatarURL?.({size:64}) || null,
    content: cfg.contentEvidence ? String(message.content || '').slice(0,4000) : null,
    createdTimestamp: message.createdTimestamp || Date.now(), attachments: attaches,
    embeds: Number(message.embeds?.length || 0), referenceId: message.reference?.messageId || null,
    webhookId: message.webhookId || null, pinned: !!message.pinned, isBot: !!message.author?.bot
  };
}
function cacheMessage(message) {
  if (!message?.guildId || !message.channelId || !message.id) return;
  const cfg=getConfig(message.guildId);
  if (!cfg.enabled) return;
  let channel=recentByChannel.get(message.channelId);
  if (!channel) { channel=new Map(); recentByChannel.set(message.channelId,channel); }
  channel.set(String(message.id),snapshotMessage(message,cfg));
  while(channel.size>MAX_CACHED_CHANNEL_MESSAGES) channel.delete(channel.keys().next().value);
  let total=0; for(const m of recentByChannel.values()) total+=m.size;
  while(total>MAX_CACHED_MESSAGES && recentByChannel.size) {
    const [oldId, oldMap]=recentByChannel.entries().next().value;
    if(oldMap.size){oldMap.delete(oldMap.keys().next().value);total--;}
    if(!oldMap.size) recentByChannel.delete(oldId);
  }
}
function compareSnowflakes(a,b) { try { const aa=BigInt(a),bb=BigInt(b);return aa<bb?-1:aa>bb?1:0; } catch { return String(a).localeCompare(String(b)); } }
function messageContext(channelId, deletedId) {
  const map=recentByChannel.get(channelId); if(!map)return {previous:null,next:null};
  const rows=[...map.values()].filter(x=>x.id!==String(deletedId)&&!deletedMessages.has(x.id)).sort((a,b)=>compareSnowflakes(a.id,b.id));
  let previous=null,next=null;
  for(const row of rows){const cmp=compareSnowflakes(row.id,deletedId);if(cmp<0)previous=row;else if(cmp>0){next=row;break;}}
  return {previous,next};
}
function jumpLink(guildId,channelId,messageId) { return messageId&&guildId&&channelId?`https://discord.com/channels/${guildId}/${channelId}/${messageId}`:null; }
function contextDescription(row) {
  if(!row)return 'Previous message unavailable';
  const link=jumpLink(row.guildId,row.channelId,row.id);
  return `${safe(row.displayName,80)} (${row.authorId?`\`${row.authorId}\``:'unknown ID'}) • ${stamp(row.createdTimestamp)}\n${row.content?clip(row.content,300):'(content not retained by privacy settings)'}${link?`\n[Open actual message](${link})`:''}`;
}
function attachmentFields(atts, label='Attachments') {
  if(!Array.isArray(atts)||!atts.length)return [];
  return [{name:label,value:atts.slice(0,8).map(a=>`• ${clip(a.name||a.id,90)} (${Number(a.size||0).toLocaleString()} bytes)${a.url?` — ${a.url}`:''}`).join('\n').slice(0,1000)}];
}
function attachmentDiff(oldA, newA) {
  const oldMap=new Map((oldA||[]).map(a=>[a.id,a])); const newMap=new Map((newA||[]).map(a=>[a.id,a]));
  return {added:[...newMap.values()].filter(a=>!oldMap.has(a.id)),removed:[...oldMap.values()].filter(a=>!newMap.has(a.id))};
}
const ATTRIBUTION_ACTIONS = {
  roleCreate: AuditLogEvent.RoleCreate, roleDelete: AuditLogEvent.RoleDelete, roleUpdate: AuditLogEvent.RoleUpdate,
  channelCreate: AuditLogEvent.ChannelCreate, channelDelete: AuditLogEvent.ChannelDelete, channelUpdate: AuditLogEvent.ChannelUpdate,
  banAdd: AuditLogEvent.MemberBanAdd, banRemove: AuditLogEvent.MemberBanRemove,
  memberKick: AuditLogEvent.MemberKick, messageDelete: AuditLogEvent.MessageDelete, inviteCreate: AuditLogEvent.InviteCreate, inviteDelete: AuditLogEvent.InviteDelete,
  emojiCreate: AuditLogEvent.EmojiCreate, emojiUpdate: AuditLogEvent.EmojiUpdate, emojiDelete: AuditLogEvent.EmojiDelete
};
async function findActor(guild, actionKey, targetId, eventTimestamp=Date.now(), metaCheck=null) {
  const type=ATTRIBUTION_ACTIONS[actionKey];
  if(!type||!targetId||!getConfig(guild.id).attributionEnabled)return {actor:null,source:'unavailable',confidence:'unknown',reason:'No reliable attribution available'};
  try {
    const fetched=await guild.fetchAuditLogs({type,limit:10});
    const candidates=[...fetched.entries.values()].filter(entry=>{
      if(!entry.target||entry.target.id!==String(targetId))return false;
      if(Math.abs(Number(eventTimestamp)-entry.createdTimestamp)>8000)return false;
      if(metaCheck&&!metaCheck(entry))return false;
      const used=usedAuditEntries.get(guild.id)||new Set();
      return !used.has(entry.id);
    });
    if(candidates.length!==1)return {actor:null,source:'audit log',confidence:'unknown',reason:candidates.length?'Multiple audit entries match; actor not guessed':'No exact target/action/time match'};
    const entry=candidates[0]; const used=usedAuditEntries.get(guild.id)||new Set(); used.add(entry.id); while(used.size>1000)used.delete(used.values().next().value);usedAuditEntries.set(guild.id,used);
    return {actor:entry.executor||null,source:'Discord audit log',confidence:'matched target/action/time',reason:entry.reason||null,entryId:entry.id};
  } catch(e) { return {actor:null,source:'audit log unavailable',confidence:'unknown',reason:e?.message||'Missing permission or API error'}; }
}
function actorFields(attribution) {
  if(attribution?.actor)return [{name:'Actor',value:`${attribution.actor.tag||attribution.actor.username} (${attribution.actor})\nID: \`${attribution.actor.id}\``,inline:false}, ...(attribution.reason?[{name:'Audit reason',value:clip(attribution.reason,800)}]:[]),{name:'Attribution',value:`${attribution.source} • ${attribution.confidence}`,inline:false}];
  return [{name:'Actor',value:'Unknown — Discord did not provide reliable attribution.',inline:false},{name:'Attribution',value:`${attribution?.source||'unavailable'} • ${attribution?.confidence||'unknown'}${attribution?.reason?` • ${clip(attribution.reason,180)}`:''}`,inline:false}];
}
function permissionNames(bits) {
  const n=BigInt(bits||0); const out=[]; let known=0n;
  for(const [name,value] of Object.entries(PERM)) { let bit;try{bit=BigInt(value);}catch{continue;} if((n&bit)===bit){out.push(name.replace(/([a-z])([A-Z])/g,'$1 $2'));known|=bit;} }
  const unknown=n&~known;
  if(unknown>0n)out.push(`Unknown permission bits 0x${unknown.toString(16)}`);
  return out;
}
function permissionDiff(oldBits,newBits) {
  const a=BigInt(oldBits||0),b=BigInt(newBits||0), enabled=b&~a,disabled=a&~b;
  const out=[];const en=permissionNames(enabled),dis=permissionNames(disabled);
  if(en.length)out.push({name:'✅ Enabled Permissions',value:en.map(x=>`✅ ${x}${['Administrator','Manage Guild','Manage Roles','Manage Webhooks','Ban Members','Kick Members'].includes(x)?' ⚠️ PRIVILEGED':''}`).join('\n').slice(0,1024)});
  if(dis.length)out.push({name:'❌ Disabled Permissions',value:dis.map(x=>`❌ ${x}`).join('\n').slice(0,1024)});
  return out;
}
function idSet(collection) { return new Set([...(collection?.keys?.() || [])].map(String)); }
function diffSets(oldIds,newIds) { return {added:[...newIds].filter(id=>!oldIds.has(id)),removed:[...oldIds].filter(id=>!newIds.has(id))}; }
function stringifyOverwrite(overwrite) { return overwrite?`allow: ${permissionNames(overwrite.allow?.bitfield||0).join(', ')||'none'}\ndeny: ${permissionNames(overwrite.deny?.bitfield||0).join(', ')||'none'}`:'No explicit overwrite'; }
function changedFields(oldObj,newObj, pairs) { const result=[];for(const [k,label,fmt=(v)=>String(v??'—')] of pairs){if(oldObj[k]!==newObj[k])result.push({name:label,value:`Before: ${clip(fmt(oldObj[k]),450)}\nAfter: ${clip(fmt(newObj[k]),450)}`});}return result; }

async function logMessageDelete(message) {
  const guild=message.guild;if(!guild)return;const cfg=getConfig(guild.id);
  const cached=recentByChannel.get(message.channelId)?.get(String(message.id));
  const snap=cached||snapshotMessage(message,cfg);const ctx=messageContext(message.channelId,message.id);
  recentByChannel.get(message.channelId)?.delete(String(message.id));deletedMessages.add(String(message.id));if(deletedMessages.size>5000)deletedMessages.delete(deletedMessages.values().next().value);
  const fields=[{name:'Author',value:`${snap.displayName} (${snap.authorTag})\nID: \`${snap.authorId||'unknown'}\``},{name:'Channel',value:`<#${message.channelId}> • \`${message.channelId}\``},{name:'Message',value:`ID: \`${message.id}\`\nCreated: ${stamp(snap.createdTimestamp)}\nDeleted: ${stamp()}\nAge: ${Math.max(0,Math.round((Date.now()-snap.createdTimestamp)/1000))} seconds`},{name:'Previous Message — Context',value:contextDescription(ctx.previous)},{name:'Next Message — Context',value:ctx.next?contextDescription(ctx.next):'Next message unavailable'}];
  if(cfg.contentEvidence)fields.push({name:'Original content (captured before deletion)',value:clip(snap.content||message.content||'(empty or unavailable)',1024)});
  if(snap.referenceId)fields.push({name:'Reply reference',value:`Message ID: \`${snap.referenceId}\`\n${jumpLink(guild.id,message.channelId,snap.referenceId)||''}`});
  if(cfg.attachmentEvidence)fields.push(...attachmentFields(snap.attachments));
  const attribution=await findActor(guild,'messageDelete',snap.authorId,Date.now(),entry=>String(entry.extra?.channel?.id||entry.extra?.channelId||'')===String(message.channelId)&&Number(entry.extra?.count??1)===1);
  await emit(guild,'messages','messageDelete','🗑️ Message Deleted',cfg.detail==='compact'?'A message was deleted.':`Message deleted from <#${message.channelId}>.`,[...fields,...actorFields(attribution)],'warning',{channelId:message.channelId,userId:snap.authorId,isBot:snap.isBot});
}
async function logMessageUpdate(oldMessage,newMessage) {
  if(!newMessage.guild)return;const cfg=getConfig(newMessage.guild.id);const oldSnap=recentByChannel.get(newMessage.channelId)?.get(String(newMessage.id))||snapshotMessage(oldMessage,cfg);const fresh=snapshotMessage(newMessage,cfg);
  const contentChanged=String(oldMessage.content??oldSnap.content??'')!==String(newMessage.content??'');
  const pinChanged=oldSnap.pinned!==fresh.pinned;
  const attachmentChanged=JSON.stringify(oldSnap.attachments)!==JSON.stringify(fresh.attachments);
  const embedChanged=Number(oldMessage.embeds?.length||oldSnap.embeds)!==Number(newMessage.embeds?.length||fresh.embeds);
  if(!contentChanged&&!pinChanged&&!attachmentChanged&&!embedChanged){cacheMessage(newMessage);return;}
  const ctx=messageContext(newMessage.channelId,newMessage.id);cacheMessage(newMessage);
  if(pinChanged)await emit(newMessage.guild,'messages','messagePin',fresh.pinned?'📌 Message Pinned':'📌 Message Unpinned',`Message pin state changed in <#${newMessage.channelId}>.`,[{name:'Author',value:`${fresh.displayName} • \`${fresh.authorId||'unknown'}\``},{name:'Message',value:`\`${newMessage.id}\`\n[Open actual message](${jumpLink(newMessage.guildId,newMessage.channelId,newMessage.id)})`},{name:'Pin state',value:`Before: ${oldSnap.pinned?'Pinned':'Not pinned'}\nAfter: ${fresh.pinned?'Pinned':'Not pinned'}`}],'info',{channelId:newMessage.channelId,userId:fresh.authorId,isBot:fresh.isBot});
  const fields=[{name:'Author',value:`${fresh.displayName} (${fresh.authorTag})\nID: \`${fresh.authorId||'unknown'}\``},{name:'Channel',value:`<#${newMessage.channelId}>`},{name:'Message',value:`ID: \`${newMessage.id}\`\nCreated: ${stamp(fresh.createdTimestamp)}\n[Open actual message](${jumpLink(newMessage.guildId,newMessage.channelId,newMessage.id)})`},{name:'Previous Message — Context',value:contextDescription(ctx.previous)},{name:'Next Message — Context',value:ctx.next?contextDescription(ctx.next):'Next message unavailable'}];
  if(oldMessage.pinned!==newMessage.pinned)fields.push({name:'Pin state',value:`Before: ${oldMessage.pinned?'Pinned':'Not pinned'}\nAfter: ${newMessage.pinned?'Pinned':'Not pinned'}`});
  if(cfg.contentEvidence&&String(oldMessage.content??oldSnap.content??'')!==String(newMessage.content??'')){fields.push({name:'Before',value:clip(oldMessage.content??oldSnap.content??'(uncached)',1024)},{name:'After',value:clip(newMessage.content||'(empty)',1024)});}
  if(cfg.attachmentEvidence){const diff=attachmentDiff(oldSnap.attachments,fresh.attachments);fields.push(...attachmentFields(diff.added,'Attachments Added'),...attachmentFields(diff.removed,'Attachments Removed'));}
  if(oldSnap.referenceId)fields.push({name:'Reply reference',value:`\`${oldSnap.referenceId}\` ${jumpLink(newMessage.guildId,newMessage.channelId,oldSnap.referenceId)||''}`});
  if(contentChanged||attachmentChanged||embedChanged)await emit(newMessage.guild,'messages','messageUpdate','✏️ Message Updated',`Message changed in <#${newMessage.channelId}>. Actor attribution is not available from the gateway event.`,fields,'info',{channelId:newMessage.channelId,userId:fresh.authorId,isBot:fresh.isBot});
}
async function logBulkDelete(messages,channel) {
  const first=messages.first?.();const guild=first?.guild||channel?.guild;if(!guild)return;const cfg=getConfig(guild.id);const items=[];
  for(const m of messages.values()){const snap=recentByChannel.get(m.channelId)?.get(String(m.id))||snapshotMessage(m,cfg);items.push({snap,ctx:messageContext(m.channelId,m.id)});recentByChannel.get(m.channelId)?.delete(String(m.id));deletedMessages.add(String(m.id));}
  const fields=[{name:'Channel',value:channel?.id?`<#${channel.id}> • \`${channel.id}\``:'Unknown'},{name:'Detection time',value:stamp()},{name:'Messages deleted',value:String(messages.size)}];
  const lines=items.slice(0,40).map(({snap,ctx})=>`• ${snap.authorTag} • ID \`${snap.id}\` • <t:${Math.floor(snap.createdTimestamp/1000)}:R>${cfg.contentEvidence?`\n  ${clip(snap.content||'(empty)',180)}`:''}\n  Previous: ${ctx.previous?`[${clip(ctx.previous.displayName,50)}](${jumpLink(guild.id,ctx.previous.channelId,ctx.previous.id)})`:'unavailable'}`);
  if(lines.length)fields.push({name:'Captured evidence (up to 40 messages)',value:lines.join('\n').slice(0,1024)});
  if(messages.size>40){
    const text=items.map(({snap,ctx})=>[`Message ${snap.id}`,`Author: ${snap.authorTag} (${snap.authorId||'unknown'})`,`Created: ${new Date(snap.createdTimestamp).toISOString()}`,`Content: ${cfg.contentEvidence?(snap.content||'(empty)'):'(not retained by privacy setting)'}`,`Previous: ${ctx.previous?jumpLink(guild.id,ctx.previous.channelId,ctx.previous.id):'unavailable'}`,`Next: ${ctx.next?jumpLink(guild.id,ctx.next.channelId,ctx.next.id):'unavailable'}`].join('\n')).join('\n\n');
    await emit(guild,'messages','messageBulkDelete','🧹 Bulk Message Deletion',`${messages.size} messages were deleted from <#${channel?.id||'unknown'}>. Detailed evidence is attached.`,fields,'warning',{channelId:channel?.id});
    const logCh=await resolveLogChannel(guild,'messages',cfg);
    if(logCh)await logCh.send({files:[new AttachmentBuilder(Buffer.from(text,'utf8'),{name:`bulk-delete-${guild.id}-${Date.now()}.txt`})],allowedMentions:{parse:[]}}).catch(e=>console.warn('[AdvancedLogging] evidence attachment failed:',e.message));
    return;
  }
  await emit(guild,'messages','messageBulkDelete','🧹 Bulk Message Deletion',`${messages.size} messages were deleted from <#${channel?.id||'unknown'}>.`,fields,'warning',{channelId:channel?.id});
}

async function inviteSnapshot(guild, updateStored=true) {
  const invites=await guild.invites.fetch();
  const out=new Map();
  const up=db.db.prepare('INSERT INTO advanced_invite_snapshot(guildId,code,uses,inviterId,expiresAt,updatedAt) VALUES(?,?,?,?,?,?) ON CONFLICT(guildId,code) DO UPDATE SET uses=excluded.uses,inviterId=excluded.inviterId,expiresAt=excluded.expiresAt,updatedAt=excluded.updatedAt');
  for(const inv of invites.values()) {const item={code:inv.code,uses:Number(inv.uses||0),inviterId:inv.inviter?.id||null,expiresAt:inv.expiresTimestamp||null};out.set(inv.code,item);if(updateStored)up.run(guild.id,item.code,item.uses,item.inviterId,item.expiresAt,Date.now());}
  if(updateStored) {
    const codes=[...out.keys()];
    if(codes.length)db.db.prepare(`DELETE FROM advanced_invite_snapshot WHERE guildId=? AND code NOT IN (${codes.map(()=>'?').join(',')})`).run(guild.id,...codes);
    else db.db.prepare('DELETE FROM advanced_invite_snapshot WHERE guildId=?').run(guild.id);
  }
  return out;
}
async function refreshInviteSnapshot(guild) { try { await inviteSnapshot(guild,true); } catch(e) { console.warn(`[AdvancedLogging] invite snapshot unavailable in ${guild.id}:`,e?.message||e); } }
function withGuildLock(guildId,work) {
  const before=inviteLocks.get(guildId)||Promise.resolve();
  const next=before.catch(()=>{}).then(work);
  inviteLocks.set(guildId,next.finally(()=>{if(inviteLocks.get(guildId)===next)inviteLocks.delete(guildId);}));
  return next;
}
async function attributeJoin(member) {
  return withGuildLock(member.guild.id,async()=>{
    let code=null, inviterId=null, confidence='unknown';
    try {
      const current=await inviteSnapshot(member.guild,false);
      const previous=db.db.prepare('SELECT code,uses,inviterId FROM advanced_invite_snapshot WHERE guildId=?').all(member.guild.id);
      const prevMap=new Map(previous.map(r=>[r.code,{uses:Number(r.uses||0),inviterId:r.inviterId}]));
      const increases=[...current.values()].filter(x=>x.uses>(prevMap.get(x.code)?.uses??-1));
      if(increases.length===1){code=increases[0].code;inviterId=increases[0].inviterId;confidence='single invite usage increase';}
      const up=db.db.prepare('INSERT INTO advanced_invite_snapshot(guildId,code,uses,inviterId,expiresAt,updatedAt) VALUES(?,?,?,?,?,?) ON CONFLICT(guildId,code) DO UPDATE SET uses=excluded.uses,inviterId=excluded.inviterId,expiresAt=excluded.expiresAt,updatedAt=excluded.updatedAt');
      for(const inv of current.values())up.run(member.guild.id,inv.code,inv.uses,inv.inviterId,inv.expiresAt,Date.now());
      if(current.size)db.db.prepare(`DELETE FROM advanced_invite_snapshot WHERE guildId=? AND code NOT IN (${[...current.keys()].map(()=>'?').join(',')})`).run(member.guild.id,...current.keys());
      else db.db.prepare('DELETE FROM advanced_invite_snapshot WHERE guildId=?').run(member.guild.id);
    } catch(e) { confidence=`unknown: invite access failed`; }
    db.db.prepare('INSERT INTO advanced_invite_history(guildId,userId,code,inviterId,confidence,joinedAt) VALUES(?,?,?,?,?,?) ON CONFLICT(guildId,userId) DO UPDATE SET code=excluded.code,inviterId=excluded.inviterId,confidence=excluded.confidence,joinedAt=excluded.joinedAt').run(member.guild.id,member.id,code,inviterId,confidence,Date.now());
    return {code,inviterId,confidence};
  });
}
async function auditActorSafe(guild,key,targetId,eventTime) { return findActor(guild,key,targetId,eventTime); }
async function securityObserve(guild, actorId, action, objectId) {
  const cfg=getConfig(guild.id);if(!cfg.enabled||!cfg.categories.security||!cfg.events.securityIncident)return;
  const key=`${guild.id}:${actorId||'unknown'}:${action}`;const now=Date.now();const prev=securityWindows.get(key);const windowMs=Math.max(5,Number(cfg.security?.windowSeconds)||10)*1000;
  const record=!prev||now-prev.start>windowMs?{start:now,count:1,objects:[objectId].filter(Boolean)}:{...prev,count:prev.count+1,objects:[...prev.objects,objectId].filter(Boolean).slice(-20)};
  securityWindows.set(key,record);const threshold=Math.max(3,Math.min(100,Number(cfg.security?.threshold)||5));
  if(record.count===threshold){await emit(guild,'security','securityIncident','⚠️ Suspicious activity pattern',`Observed ${record.count} **${action}** events by ${actorId?`<@${actorId}>`:'an unattributed actor'} within ${Math.round((now-record.start)/1000)} seconds. This is a suspicious pattern, not proof of an attack.`,[{name:'Incident ID',value:crypto.randomUUID()},{name:'Affected objects',value:record.objects.map(x=>`\`${x}\``).join(', ')||'Unavailable'},{name:'Threshold',value:`${threshold} events / ${windowMs/1000}s`},{name:'Evidence',value:'Counted from observed gateway events; protective actions were not taken.'}],'danger',{userId:actorId});}
}

function buildPanel(guildId, session) {
  const cfg=getConfig(guildId);const [category,label]=CATEGORIES.find(([k])=>k===session.category)||CATEGORIES[0];
  const all=EVENTS.filter(e=>e.category===category);const perPage=20;const pages=Math.max(1,Math.ceil(all.length/perPage));session.page=Math.min(Math.max(0,session.page||0),pages-1);const pageRows=all.slice(session.page*perPage,(session.page+1)*perPage);
  const enabledCount=EVENTS.filter(e=>isEventEnabled(cfg,e.key)).length;const categoriesOn=CATEGORIES.filter(([k])=>cfg.categories[k]).length;const configured=CATEGORIES.filter(([k])=>cfg.channels[k]).length;
  let body=`**System:** ${cfg.enabled?'🟢 Enabled':'🔴 Disabled'}\n**Categories enabled:** ${categoriesOn}/${CATEGORIES.length}\n**Event types enabled:** ${enabledCount}/${EVENTS.length}\n**Dedicated channels:** ${configured}/${CATEGORIES.length}\n**Content evidence:** ${cfg.contentEvidence?'Opted in':'Off by default'}\n**Retention setting:** ${cfg.retentionDays} days (Discord-channel retention depends on the selected channel)\n**Detail mode:** ${cfg.detail}\n\n**${label}** — ${cfg.categories[category]?'enabled':'disabled'}\n**Destination:** ${cfg.channels[category]?`<#${cfg.channels[category]}>`:cfg.sharedChannelId?`Shared <#${cfg.sharedChannelId}>`:'Not configured'}`;
  const embed=baseEmbed({name:'AunXz'},'AunXz • Advanced Logging Dashboard',body,'info').setFooter({text:`Selected: ${label} • Page ${session.page+1}/${pages} • per-guild settings persist in SQLite`});
  const eventOptions=pageRows.map(e=>({label:`${cfg.events[e.key]??e.enabled?'ON':'OFF'} • ${e.label}`.slice(0,100),value:e.key,description:`${cfg.events[e.key]??e.enabled?'Currently enabled':'Currently disabled'} • ${e.key}`.slice(0,100)}));
  const rows=[];
  const categoryMenu = new StringSelectMenuBuilder().setCustomId(`logsetup:adv:${session.userId}:category`).setPlaceholder(`Select category • ${label}`).addOptions(CATEGORIES.map(([value,name]) => ({ label:name, value, default:value===category })) );
  rows.push(new ActionRowBuilder().addComponents(categoryMenu));
  rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`logsetup:adv:${session.userId}:event`).setPlaceholder(`Toggle event type (${session.page+1}/${pages})`).addOptions(eventOptions.length?eventOptions:[{label:'No event types',value:'noop'}])));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`logsetup:adv:${session.userId}:system`).setLabel(cfg.enabled?'Disable logging':'Enable logging').setStyle(cfg.enabled?ButtonStyle.Danger:ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`logsetup:adv:${session.userId}:cat`).setLabel(cfg.categories[category]?'Disable category':'Enable category').setStyle(cfg.categories[category]?ButtonStyle.Secondary:ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`logsetup:adv:${session.userId}:allOn`).setLabel('Enable all events').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`logsetup:adv:${session.userId}:allOff`).setLabel('Disable all').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`logsetup:adv:${session.userId}:prev`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(session.page<=0)
  ));
  rows.push(new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`logsetup:adv:${session.userId}:channel`).setPlaceholder(cfg.channels[category]?`Change ${label} destination…`:`Choose ${label} destination…`).setChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement)));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`logsetup:adv:${session.userId}:next`).setLabel('▶ Events').setStyle(ButtonStyle.Secondary).setDisabled(session.page>=pages-1),
    new ButtonBuilder().setCustomId(`logsetup:adv:${session.userId}:content`).setLabel(cfg.contentEvidence?'Content evidence: ON':'Content evidence: OFF').setStyle(cfg.contentEvidence?ButtonStyle.Success:ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`logsetup:adv:${session.userId}:detail`).setLabel(`Detail: ${cfg.detail}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`logsetup:adv:${session.userId}:test`).setLabel('Test selected log').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`logsetup:adv:${session.userId}:ignored`).setLabel('Ignored entities').setStyle(ButtonStyle.Secondary)
  ));
  return {embeds:[embed],components:rows};
}
async function openSetup(interaction) {
  if(!interaction.guild)return interaction.reply({embeds:[baseEmbed({name:'AunXz'},'Server only','Use /logsetup inside a server.')],ephemeral:true});
  if(!isAdmin(interaction))return interaction.reply({embeds:[baseEmbed(interaction.guild,'Administrator required','Manage Server or Administrator is required.','warning')],ephemeral:true});
  const key=`${interaction.guildId}:${interaction.user.id}`;const session={guildId:interaction.guildId,userId:interaction.user.id,category:'messages',page:0,expiresAt:Date.now()+15*60*1000};sessions.set(key,session);
  return interaction.reply({...buildPanel(interaction.guildId,session),ephemeral:true});
}
function modalInput(id,label,value,max=1000,style=TextInputStyle.Short) {
  const t=new TextInputBuilder().setCustomId(id).setLabel(label.slice(0,45)).setStyle(style).setRequired(false).setMaxLength(max);if(value)t.setValue(String(value).slice(0,max));return new ActionRowBuilder().addComponents(t);
}
async function handleInteraction(i) {
  if(!i.customId?.startsWith('logsetup:adv:'))return false;
  const [, , userId, action, ...rest]=i.customId.split(':');
  if(!i.guildId||i.user.id!==userId||!isAdmin(i)) {await i.reply({content:'This logging panel belongs to its administrator. Open `/logsetup` to create your own.',ephemeral:true}).catch(()=>{});return true;}
  const key=`${i.guildId}:${i.user.id}`,session=sessions.get(key);
  if(!session||session.expiresAt<Date.now()){sessions.delete(key);await i.reply({content:'This setup session expired. Run `/logsetup` again.',ephemeral:true}).catch(()=>{});return true;}
  session.expiresAt=Date.now()+15*60*1000;const cfg=getConfig(i.guildId);const category=session.category;
  try {
    if(action==='category'&&i.isStringSelectMenu()){session.category=i.values[0];session.page=0;return i.update(buildPanel(i.guildId,session));}
    if(action==='event'&&i.isStringSelectMenu()){const e=EVENT_BY_KEY.get(i.values[0]);if(!e)return i.update(buildPanel(i.guildId,session));const current=getConfig(i.guildId);saveConfig(i.guildId,{events:{[e.key]:!(current.events[e.key]??e.enabled)}},i.user.id);return i.update(buildPanel(i.guildId,session));}
    if(action==='channel'&&i.isChannelSelectMenu()) {const ch=i.guild.channels.cache.get(i.values[0]);if(!ch?.isTextBased?.())throw new Error('Choose a text or announcement channel.');const me=i.guild.members.me;if(me&&!ch.permissionsFor(me)?.has([PERM.ViewChannel,PERM.SendMessages,PERM.EmbedLinks]))throw new Error('I need View Channel, Send Messages and Embed Links in that destination.');saveConfig(i.guildId,{channels:{[category]:ch.id}},i.user.id);return i.update(buildPanel(i.guildId,session));}
    if(action==='system'){saveConfig(i.guildId,{enabled:!cfg.enabled},i.user.id);return i.update(buildPanel(i.guildId,session));}
    if(action==='cat'){saveConfig(i.guildId,{categories:{[category]:!cfg.categories[category]}},i.user.id);return i.update(buildPanel(i.guildId,session));}
    if(action==='allOn'||action==='allOff'){const patch={};for(const e of EVENTS)patch[e.key]=action==='allOn';saveConfig(i.guildId,{events:patch},i.user.id);return i.update(buildPanel(i.guildId,session));}
    if(action==='prev'){session.page=Math.max(0,session.page-1);return i.update(buildPanel(i.guildId,session));}
    if(action==='next'){session.page++;return i.update(buildPanel(i.guildId,session));}
    if(action==='content'){saveConfig(i.guildId,{contentEvidence:!cfg.contentEvidence},i.user.id);return i.update(buildPanel(i.guildId,session));}
    if(action==='detail'){saveConfig(i.guildId,{detail:cfg.detail==='detailed'?'compact':'detailed'},i.user.id);return i.update(buildPanel(i.guildId,session));}
    if(action==='test'){const ch=await resolveLogChannel(i.guild,category,cfg);if(!ch)throw new Error('Choose a log destination for this category first.');await ch.send({embeds:[baseEmbed(i.guild,'✅ Logging Test',`Test from /logsetup. Category: **${CATEGORIES.find(x=>x[0]===category)?.[1]}**. No server event is being claimed.`, 'success')],allowedMentions:{parse:[]}});await i.reply({content:'Test log sent.',ephemeral:true});return true;}
    if(action==='ignored'){const modal=new ModalBuilder().setCustomId(`logsetup:adv:${userId}:ignoredModal`).setTitle('Ignored Entities');modal.addComponents(modalInput('channels','Ignored channel IDs',cfg.ignored.channels.join(', '),1000),modalInput('users','Ignored user IDs',cfg.ignored.users.join(', '),1000),modalInput('roles','Ignored role IDs',cfg.ignored.roles.join(', '),1000));return i.showModal(modal);}
    if(action==='ignoredModal'&&i.isModalSubmit()){const parse=field=>{const vals=i.fields.getTextInputValue(field).split(/[\s,]+/).map(x=>x.trim()).filter(Boolean);if(vals.some(x=>!/^\d{15,22}$/.test(x)))throw new Error(`The ${field} list contains an invalid Discord ID.`);return [...new Set(vals)].slice(0,100);};saveConfig(i.guildId,{ignored:{channels:parse('channels'),users:parse('users'),roles:parse('roles')}},i.user.id);return i.reply({content:'Ignored entities saved.',ephemeral:true});}
  } catch(e) { const msg=clip(e?.message||e,800);if(i.deferred||i.replied)await i.followUp({content:msg,ephemeral:true}).catch(()=>{});else await i.reply({content:msg,ephemeral:true}).catch(()=>{});return true; }
  await i.reply({content:'This control is not available.',ephemeral:true}).catch(()=>{});return true;
}

function register(client, eventName, fn) { client.on(eventName,(...args)=>Promise.resolve(fn(...args)).catch(e=>console.warn(`[AdvancedLogging] ${eventName} handler failed:`,e?.message||e))); }
function init(client) {
  if(initialized)return;initialized=true;clientRef=client;
  register(client,'ready',async()=>{
    for(const guild of client.guilds.cache.values()) {
      await refreshInviteSnapshot(guild);
      try {const hooks=await guild.fetchWebhooks();webhookSnapshots.set(guild.id,new Map([...hooks.values()].map(h=>[h.id,{name:h.name,channelId:h.channelId,ownerId:h.owner?.id||null}])));}catch{}
    }
    for(const guild of client.guilds.cache.values())await emit(guild,'system','botStartup','AunXz Started','The bot is connected and the advanced logging module is ready.',[],'success');
  });
  register(client,'messageCreate',async m=>{if(m.guild){cacheMessage(m);const cfg=getConfig(m.guild.id);if(cfg.contentEvidence&&m.author?.bot&&m.author.id===client.user?.id)return;const snap=snapshotMessage(m,cfg);await emit(m.guild,'messages','messageCreate','💬 Message Created',`A message was created in <#${m.channelId}>.`,[{name:'Author',value:`${snap.displayName} (${snap.authorTag})\nID: \`${snap.authorId}\``},{name:'Channel',value:`<#${m.channelId}>`},...(cfg.contentEvidence?[{name:'Content',value:clip(snap.content||'(empty)',1024)}]:[]),...(cfg.attachmentEvidence?attachmentFields(snap.attachments):[])],'info',{channelId:m.channelId,userId:m.author?.id,isBot:m.author?.bot});}});
  register(client,'messageDelete',logMessageDelete);
  register(client,'messageUpdate',logMessageUpdate);
  register(client,'messageDeleteBulk',logBulkDelete);
  register(client,'messageReactionAdd',async(r,u)=>{if(!r.guild)return;const m=r.message.partial?await r.message.fetch().catch(()=>null):r.message;if(!m)return;await emit(r.guild,'messages','reactionAdd','➕ Reaction Added',`${u} reacted in <#${m.channelId}>.`,[{name:'Message',value:`ID \`${m.id}\`\n${jumpLink(r.guild.id,m.channelId,m.id)}`},{name:'Emoji',value:r.emoji?.toString()||'Unknown'}],'info',{channelId:m.channelId,userId:u.id,isBot:u.bot});});
  register(client,'messageReactionRemove',async(r,u)=>{if(!r.guild)return;const m=r.message.partial?await r.message.fetch().catch(()=>null):r.message;if(!m)return;await emit(r.guild,'messages','reactionRemove','➖ Reaction Removed',`${u} removed a reaction in <#${m.channelId}>.`,[{name:'Message',value:`ID \`${m.id}\`\n${jumpLink(r.guild.id,m.channelId,m.id)}`},{name:'Emoji',value:r.emoji?.toString()||'Unknown'}],'info',{channelId:m.channelId,userId:u.id,isBot:u.bot});});
  register(client,'guildMemberAdd',async m=>{const inv=await attributeJoin(m);await emit(m.guild,'members','memberJoin','📥 Member Joined',`${m} joined the server.`,[{name:'Member',value:`${m.user.tag} (${m.user})\nID: \`${m.id}\`\nBot: ${m.user.bot?'yes':'no'}`},{name:'Account created',value:stamp(m.user.createdTimestamp)},{name:'Joined',value:stamp(m.joinedTimestamp||Date.now())},{name:'Member count',value:String(m.guild.memberCount||'unknown')}],'success',{userId:m.id,isBot:m.user.bot});await emit(m.guild,'invites','inviteJoin','📨 Invite Attribution',`${m.user.tag} joined. Attribution is stored as historical evidence.`,[{name:'Invite code',value:inv.code||'Unknown'},{name:'Inviter',value:inv.inviterId?`<@${inv.inviterId}> (\`${inv.inviterId}\`)`:'Unknown'},{name:'Confidence',value:inv.confidence}],'info',{userId:m.id,isBot:m.user.bot});});
  register(client,'guildMemberRemove',async m=>{const attribution=await auditActorSafe(m.guild,'memberKick',m.id,Date.now());const kicked=!!attribution.actor;const duration=m.joinedTimestamp?Math.max(0,Date.now()-m.joinedTimestamp):null;const roles=[...(m.roles?.cache?.values?.()||[])].filter(r=>r.id!==m.guild.id).map(r=>`${r.name} (\`${r.id}\`)`).slice(0,15);await emit(m.guild,'members',kicked?'memberKick':'memberLeave',kicked?'📤 Member Kicked':'📤 Member Left',`${m.user?.tag||m.id} left the server. ${kicked?'Audit attribution matched a kick entry.':'A departure is not labelled a kick because no reliable matching kick entry was found.'}`,[{name:'Member',value:`${m.user?.tag||'Unknown'} • \`${m.id}\``},{name:'Join date',value:m.joinedTimestamp?stamp(m.joinedTimestamp):'Unavailable'},{name:'Membership duration',value:duration===null?'Unavailable':`${Math.floor(duration/86400000)}d ${Math.floor(duration%86400000/3600000)}h`},{name:'Roles held (if cache had them)',value:roles.join(', ')||'Unavailable'},...actorFields(attribution),...(db.db.prepare('SELECT code,inviterId,confidence,joinedAt FROM advanced_invite_history WHERE guildId=? AND userId=?').get(m.guild.id,m.id)?(()=>{const hist=db.db.prepare('SELECT code,inviterId,confidence,joinedAt FROM advanced_invite_history WHERE guildId=? AND userId=?').get(m.guild.id,m.id);return [{name:'Original invite attribution',value:`Code: ${hist.code||'Unknown'}\nInviter: ${hist.inviterId?`<@${hist.inviterId}>`:'Unknown'}\nConfidence: ${hist.confidence}\nJoined: ${stamp(hist.joinedAt)}`}];})():[])],'warning',{userId:m.id,isBot:m.user?.bot});});
  register(client,'guildBanAdd',async b=>{const a=await auditActorSafe(b.guild,'banAdd',b.user.id,Date.now());await emit(b.guild,'moderation','banAdd','🔨 Member Banned',`${b.user.tag||b.user.id} was banned.`,[{name:'Target',value:`${b.user} • \`${b.user.id}\``},...actorFields(a)],'danger',{userId:b.user.id,isBot:b.user.bot});await securityObserve(b.guild,a.actor?.id,'ban',b.user.id);});
  register(client,'guildBanRemove',async b=>{const a=await auditActorSafe(b.guild,'banRemove',b.user.id,Date.now());await emit(b.guild,'moderation','banRemove','🔓 Member Unbanned',`${b.user.tag||b.user.id} was unbanned.`,[{name:'Target',value:`${b.user} • \`${b.user.id}\``},...actorFields(a)],'success',{userId:b.user.id,isBot:b.user.bot});});
  register(client,'inviteCreate',async inv=>{if(inv.guild)await emit(inv.guild,'invites','inviteCreate','📨 Invite Created',`Invite \`${inv.code}\` was created.`,[{name:'Channel',value:inv.channel?`${inv.channel} • \`${inv.channel.id}\``:'Unknown'},{name:'Uses',value:String(inv.maxUses||'Unlimited')},{name:'Inviter',value:inv.inviter?`${inv.inviter.tag} (\`${inv.inviter.id}\`)`:'Unknown'}]);if(inv.guild)await refreshInviteSnapshot(inv.guild);});
  register(client,'inviteDelete',async inv=>{if(inv.guild)await emit(inv.guild,'invites','inviteDelete','🗑️ Invite Deleted',`Invite \`${inv.code}\` was deleted.`,[{name:'Channel',value:inv.channel?`${inv.channel} • \`${inv.channel.id}\``:'Unknown'},{name:'Inviter',value:inv.inviter?`${inv.inviter.tag} (\`${inv.inviter.id}\`)`:'Unknown'}]);if(inv.guild)await refreshInviteSnapshot(inv.guild);});
  register(client,'roleCreate',async r=>{const a=await auditActorSafe(r.guild,'roleCreate',r.id,r.createdTimestamp||Date.now());await emit(r.guild,'roles','roleCreate','🎭 Role Created',`Role ${r} was created.`,[{name:'Role',value:`${safe(r.name,200)} • \`${r.id}\``},{name:'Permissions',value:permissionNames(r.permissions.bitfield).slice(0,50).join(', ')||'No permissions'},...actorFields(a)],'success',{roleIds:[r.id]});await securityObserve(r.guild,a.actor?.id,'role create',r.id);});
  register(client,'roleDelete',async r=>{const a=await auditActorSafe(r.guild,'roleDelete',r.id,Date.now());await emit(r.guild,'roles','roleDelete','🗑️ Role Deleted',`Role **${safe(r.name,200)}** was deleted.`,[{name:'Role',value:`${safe(r.name,200)} • \`${r.id}\``},...actorFields(a)],'warning',{roleIds:[r.id]});await securityObserve(r.guild,a.actor?.id,'role delete',r.id);});
  register(client,'roleUpdate',async(oldR,newR)=>{const fields=changedFields(oldR,newR,[['name','Role name'],['hexColor','Color'],['hoist','Hoisted'],['mentionable','Mentionable'],['position','Position']]);const pd=permissionDiff(oldR.permissions?.bitfield,newR.permissions?.bitfield);if(pd.length)fields.push(...pd);if(!fields.length)return;const a=await auditActorSafe(newR.guild,'roleUpdate',newR.id,Date.now());await emit(newR.guild,'roles','roleUpdate','🎭 Role Updated',`Role ${newR} changed. Permission sections are shown only when actual permission bits changed.`,[{name:'Role',value:`${safe(newR.name,200)} • \`${newR.id}\``},...fields,...actorFields(a)],pd.length?'danger':'info',{roleIds:[newR.id]});if(pd.length)await securityObserve(newR.guild,a.actor?.id,'role permission change',newR.id);});
  register(client,'guildMemberUpdate',async(oldM,newM)=>{const fields=[];if(oldM.nickname!==newM.nickname)fields.push({name:'Nickname',value:`Before: ${clip(oldM.nickname||'(none)',200)}\nAfter: ${clip(newM.nickname||'(none)',200)}`});const sets=diffSets(idSet(oldM.roles.cache),idSet(newM.roles.cache));sets.added=sets.added.filter(x=>x!==newM.guild.id);sets.removed=sets.removed.filter(x=>x!==newM.guild.id);if(sets.added.length)fields.push({name:'Roles Added',value:sets.added.map(id=>`✅ <@&${id}> — \`${id}\``).join('\n').slice(0,1024)});if(sets.removed.length)fields.push({name:'Roles Removed',value:sets.removed.map(id=>`❌ <@&${id}> — \`${id}\``).join('\n').slice(0,1024)});if(oldM.communicationDisabledUntilTimestamp!==newM.communicationDisabledUntilTimestamp)fields.push({name:'Timeout',value:`Before: ${oldM.communicationDisabledUntilTimestamp?stamp(oldM.communicationDisabledUntilTimestamp):'none'}\nAfter: ${newM.communicationDisabledUntilTimestamp?stamp(newM.communicationDisabledUntilTimestamp):'none'}`});if(!oldM.premiumSinceTimestamp&&newM.premiumSinceTimestamp)fields.push({name:'Boost',value:'Started boosting'});if(oldM.premiumSinceTimestamp&&!newM.premiumSinceTimestamp)fields.push({name:'Boost',value:'Stopped boosting'});if(!fields.length)return;await emit(newM.guild,sets.added.length||sets.removed.length?'roles':'members',sets.added.length||sets.removed.length?'memberRoles':'memberUpdate','👤 Member Updated',`${newM.user.tag} has observable member changes.`,[{name:'Member',value:`${newM} • \`${newM.id}\``},...fields],'info',{userId:newM.id,isBot:newM.user.bot,roleIds:[...sets.added,...sets.removed]});});
  register(client,'channelCreate',async ch=>{if(!ch.guild)return;const a=await auditActorSafe(ch.guild,'channelCreate',ch.id,Date.now());await emit(ch.guild,'channels','channelCreate','📁 Channel Created',`${ch} was created.`,[{name:'Channel',value:`${safe(ch.name,200)} • \`${ch.id}\``},{name:'Type',value:String(ch.type)},{name:'Parent category',value:ch.parent?`${ch.parent.name} • \`${ch.parent.id}\``:'None'},...actorFields(a)],'success',{channelId:ch.id});await securityObserve(ch.guild,a.actor?.id,'channel create',ch.id);});
  register(client,'channelDelete',async ch=>{if(!ch.guild)return;const a=await auditActorSafe(ch.guild,'channelDelete',ch.id,Date.now());await emit(ch.guild,'channels','channelDelete','🗑️ Channel Deleted',`Channel **${safe(ch.name,200)}** was deleted.`,[{name:'Channel',value:`${safe(ch.name,200)} • \`${ch.id}\``},{name:'Type',value:String(ch.type)},...actorFields(a)],'warning',{channelId:ch.id});await securityObserve(ch.guild,a.actor?.id,'channel delete',ch.id);});
  register(client,'channelUpdate',async(oldCh,newCh)=>{if(!newCh.guild)return;const fields=changedFields(oldCh,newCh,[['name','Name'],['topic','Topic'],['nsfw','NSFW'],['rateLimitPerUser','Slowmode seconds'],['bitrate','Bitrate'],['userLimit','User limit'],['parentId','Parent category ID'],['rtcRegion','RTC region']]);if(oldCh.permissionOverwrites?.cache&&newCh.permissionOverwrites?.cache){const oldMap=oldCh.permissionOverwrites.cache,newMap=newCh.permissionOverwrites.cache;const all=new Set([...oldMap.keys(),...newMap.keys()]);for(const targetId of all){const a=oldMap.get(targetId),b=newMap.get(targetId);if((a?.allow.bitfield||0n)===(b?.allow.bitfield||0n)&&(a?.deny.bitfield||0n)===(b?.deny.bitfield||0n))continue;fields.push({name:`Explicit overwrite target ${targetId}`,value:`Before:\n${stringifyOverwrite(a)}\nAfter:\n${stringifyOverwrite(b)}`});}}if(!fields.length)return;const a=await auditActorSafe(newCh.guild,'channelUpdate',newCh.id,Date.now());await emit(newCh.guild,'channels','channelUpdate','📁 Channel Updated',`${newCh} changed. Overwrite comparisons refer only to explicit entries on this channel.`,[{name:'Channel',value:`${newCh} • \`${newCh.id}\``},...fields,...actorFields(a)],'info',{channelId:newCh.id});});
  register(client,'guildUpdate',async(oldG,newG)=>{const fields=changedFields(oldG,newG,[['name','Server name'],['verificationLevel','Verification level'],['explicitContentFilter','Content filter'],['defaultMessageNotifications','Default notifications'],['afkTimeout','AFK timeout'],['afkChannelId','AFK channel ID'],['systemChannelId','System channel ID'],['rulesChannelId','Rules channel ID'],['publicUpdatesChannelId','Updates channel ID'],['vanityURLCode','Vanity code']]);if(oldG.icon!==newG.icon)fields.push({name:'Icon',value:`Before: ${oldG.iconURL?.()||'none'}\nAfter: ${newG.iconURL?.()||'none'}`});if(oldG.banner!==newG.banner)fields.push({name:'Banner',value:`Before: ${oldG.bannerURL?.()||'none'}\nAfter: ${newG.bannerURL?.()||'none'}`});if(!fields.length)return;const a=await findActor(newG,'guildUpdate',newG.id,Date.now());await emit(newG,'server','guildUpdate','🏛️ Server Settings Changed','Observable server settings changed. Values not available from the gateway are not inferred.',[...fields,...actorFields(a)],'info');});
  register(client,'voiceStateUpdate',async(oldS,newS)=>{const guild=newS.guild;const fields=[];if(oldS.channelId!==newS.channelId)fields.push({name:'Channel',value:`Before: ${oldS.channel?`${oldS.channel.name} (\`${oldS.channelId}\`)`:'Not in voice'}\nAfter: ${newS.channel?`${newS.channel.name} (\`${newS.channelId}\`)`:'Not in voice'}`});for(const [key,label] of [['selfMute','Self mute'],['selfDeaf','Self deafen'],['serverMute','Server mute'],['serverDeaf','Server deafen'],['selfVideo','Video'],['streaming','Streaming']])if(oldS[key]!==newS[key])fields.push({name:label,value:`Before: ${!!oldS[key]}\nAfter: ${!!newS[key]}`});if(!fields.length)return;await emit(guild,'voice','voiceUpdate','🔊 Voice State Changed',`${newS.member?.user?.tag||newS.id} had a voice-state update. Related fields are grouped together.`,[{name:'Member',value:`<@${newS.id}> • \`${newS.id}\``},...fields],'info',{userId:newS.id,isBot:newS.member?.user?.bot});});
  for(const [eventName,key,category,title] of [['emojiCreate','emojiCreate','assets','😀 Emoji Created'],['emojiDelete','emojiDelete','assets','🗑️ Emoji Deleted'],['stickerCreate','stickerCreate','assets','🏷️ Sticker Created'],['stickerDelete','stickerDelete','assets','🗑️ Sticker Deleted'],['threadCreate','threadCreate','channels','🧵 Thread Created'],['threadDelete','threadDelete','channels','🗑️ Thread Deleted'],['stageInstanceCreate','stageCreate','voice','🎙️ Stage Created'],['stageInstanceDelete','stageDelete','voice','🎙️ Stage Deleted'],['guildScheduledEventCreate','scheduledCreate','assets','📅 Scheduled Event Created'],['guildScheduledEventDelete','scheduledDelete','assets','🗑️ Scheduled Event Deleted']])register(client,eventName,async obj=>{const g=obj.guild||obj.channel?.guild;if(!g)return;const id=obj.id||'unknown';await emit(g,category,key,title,`${safe(obj.name||obj.tag||obj.topic||'Object',150)} was observed.`,[{name:'Name',value:safe(obj.name||obj.tag||obj.topic||'Unknown',200)},{name:'ID',value:`\`${id}\``}],'info',{channelId:obj.channelId||obj.channel?.id});});
  register(client,'emojiUpdate',async(o,n)=>{const fields=changedFields(o,n,[['name','Name']]);if(!fields.length)return;await emit(n.guild,'assets','emojiUpdate','😀 Emoji Updated',`${o} changed.`,[{name:'ID',value:`\`${n.id}\``},...fields]);});
  register(client,'stickerUpdate',async(o,n)=>{const fields=changedFields(o,n,[['name','Name'],['description','Description'],['tags','Tags']]);if(!fields.length)return;await emit(n.guild,'assets','stickerUpdate','🏷️ Sticker Updated',`${safe(n.name,200)} changed.`,[{name:'ID',value:`\`${n.id}\``},...fields]);});
  register(client,'threadUpdate',async(o,n)=>{const fields=changedFields(o,n,[['name','Name'],['archived','Archived'],['locked','Locked'],['autoArchiveDuration','Auto archive duration'],['rateLimitPerUser','Slowmode']]);if(fields.length)await emit(n.guild,'channels','threadUpdate','🧵 Thread Updated',`${n} changed.`,[{name:'ID',value:`\`${n.id}\``},...fields],'info',{channelId:n.id});});
  register(client,'guildScheduledEventUpdate',async(o,n)=>{const fields=changedFields(o,n,[['name','Name'],['description','Description'],['status','Status'],['scheduledStartTimestamp','Start time'],['scheduledEndTimestamp','End time'],['channelId','Channel ID'],['entityType','Event type']]);if(fields.length)await emit(n.guild,'assets','scheduledUpdate','📅 Scheduled Event Updated',`${safe(n.name,200)} changed.`,[{name:'ID',value:`\`${n.id}\``},...fields]);});
  register(client,'webhooksUpdate',async ch=>{const g=ch.guild;if(!g)return;let changed=[];try{const hs=await g.fetchWebhooks();const current=new Map([...hs.values()].map(h=>[h.id,{name:h.name,channelId:h.channelId,ownerId:h.owner?.id||null}]));const prev=webhookSnapshots.get(g.id)||new Map();for(const [id,h] of current){if(!prev.has(id))changed.push(`Created/appeared: ${h.name} (${id}) in ${h.channelId}`);else if(JSON.stringify(prev.get(id))!==JSON.stringify(h))changed.push(`Changed: ${h.name} (${id}) channel ${h.channelId}`);}for(const [id,h]of prev)if(!current.has(id))changed.push(`Deleted/disappeared: ${h.name} (${id})`);webhookSnapshots.set(g.id,current);}catch(e){changed.push(`Webhook details unavailable (${e?.message||'missing Manage Webhooks permission'}).`);}await emit(g,'assets','webhooksUpdate','🪝 Webhooks Changed',`Discord reported a webhook update in <#${ch.id}>. Tokens and credentials are never logged.`,[{name:'Observed changes',value:changed.slice(0,10).join('\n')||'No reliable before/after difference could be identified.'}],'warning',{channelId:ch.id});});
}
module.exports={init,openSetup,handleInteraction,getConfig,saveConfig,EVENTS,CATEGORIES,_internals:{permissionDiff,messageContext,attachmentDiff,findActor,attributeJoin,defaultConfig}};
