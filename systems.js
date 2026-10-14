// AunXz/systems.js — business logic: logging, tickets, snipe, moderation, security, AI, leveling.
'use strict';

const { PermissionFlagsBits, ChannelType, AuditLogEvent, Collection, EmbedBuilder } = require('discord.js');
const db = require('./database');
const ui = require('./ui');

const BRAND = ui.BRAND;

// =============================================================================
// TEMPLATES
// =============================================================================
function applyTemplate(template, vars = {}, { allowMentions = false } = {}) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (full, key) => {
    const v = key.split('.').reduce((a, k) => (a == null ? undefined : a[k]), vars);
    if (v === undefined || v === null) return full;
    const s = String(v);
    return allowMentions ? s : s.replace(/@(everyone|here)/g, '@\u200b$1');
  });
}

// =============================================================================
// PERMISSIONS
// =============================================================================
const OWNER_IDS = new Set(
  [process.env.OWNER_ID, ...(process.env.OWNER_IDS || '').split(',')].map(s => String(s || '').trim()).filter(Boolean)
);
const isOwner = id => OWNER_IDS.has(String(id || ''));
const isAdmin = m => m?.permissions?.has(PermissionFlagsBits.Administrator) || isOwner(m?.id);
function isStaff(guildId, member) {
  if (!member) return false;
  const cfg = db.getConfig(guildId);
  const role = cfg.ticket?.supportRoleId || cfg.staffApplications?.acceptedRoleId;
  if (!role) return isAdmin(member);
  return member.roles?.cache?.has(role) || isAdmin(member);
}
function canModerate(guild, mod, target) {
  if (!mod || !target) return false;
  if (mod.id === target.id) return false;
  if (guild.ownerId === target.id) return false;
  if (target.id === guild.members.me.id) return false;
  return mod.roles.highest.position > target.roles.highest.position
    && guild.members.me.roles.highest.position > target.roles.highest.position;
}

// =============================================================================
// LOGGING ENGINE
// =============================================================================
const LOG_CATEGORIES = ['message', 'member', 'mod', 'voice', 'security', 'ticket', 'server', 'system'];
const auditCache = new Collection();
const AUDIT_TTL_MS = 3000;

async function auditExecutor(guild, type, targetId, { maxAgeMs = 12000 } = {}) {
  const key = `${guild.id}:${type}:${targetId || ''}`;
  const now = Date.now();
  const hit = auditCache.get(key);
  if (hit && now - hit.ts < AUDIT_TTL_MS) return hit.executor;
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    const entry = logs.entries.find(e => now - e.createdTimestamp < maxAgeMs && (!targetId || e.target?.id === targetId));
    const executor = entry?.executor || null;
    auditCache.set(key, { executor, ts: now });
    if (auditCache.size > 500) auditCache.delete(auditCache.keys().next().value);
    return executor;
  } catch { return null; }
}

function resolveLogChannel(guild, category) {
  if (!guild) return null;
  const row = db.getLogConfig(guild.id, category);
  if (row && row.enabled && row.channelId) {
    const ch = guild.channels.cache.get(row.channelId);
    if (ch?.isTextBased()) return ch;
  }
  const fb = db.getLogConfig(guild.id, 'default');
  if (fb && fb.enabled && fb.channelId) {
    const ch = guild.channels.cache.get(fb.channelId);
    if (ch?.isTextBased()) return ch;
  }
  return null;
}

async function logEvent(guild, category, payload) {
  try {
    if (!guild) return;
    const ch = resolveLogChannel(guild, category);
    if (!ch) return;
    const v2 = ui.buildV2({
      title: payload.title,
      description: payload.description,
      fields: payload.fields || [],
      footer: `${BRAND} • ${category}`
    });
    await ch.send({ ...v2, allowedMentions: { parse: [] } }).catch(() => {});
  } catch (e) { console.error('[log]', e?.message || e); }
}

async function logMessage(guild, { action, author, channel, content, newContent, attachments, jumpUrl, executor }) {
  const fields = [];
  if (author) fields.push({ name: 'Author', value: `<@${author.id}> (\`${author.tag || author.id}\`)`, inline: true });
  if (channel) fields.push({ name: 'Channel', value: `<#${channel.id}>`, inline: true });
  if (executor) fields.push({ name: 'Executor', value: `<@${executor.id}>`, inline: true });
  if (content !== undefined) fields.push({ name: action === 'edit' ? 'Before' : 'Content', value: (content || '*no content*').slice(0, 1000) });
  if (newContent !== undefined) fields.push({ name: 'After', value: (newContent || '*no content*').slice(0, 1000) });
  if (attachments?.length) fields.push({ name: `Attachments (${attachments.length})`, value: attachments.slice(0, 5).map(a => `[${a.name || 'file'}](${a.url})`).join('\n').slice(0, 1000) });
  if (jumpUrl) fields.push({ name: 'Jump', value: `[Open](${jumpUrl})`, inline: true });
  const titles = { delete: '🗑️ Message Deleted', edit: '✏️ Message Edited', bulk: '🧹 Bulk Delete', create: '📝 Message' };
  await logEvent(guild, 'message', { title: titles[action] || 'Message', fields });
}

const logMember = (guild, { action, target, executor, reason, extra }) => {
  const fields = [];
  if (target) fields.push({ name: 'Target', value: `<@${target.id}> (\`${target.id}\`)`, inline: true });
  if (executor) fields.push({ name: 'Executor', value: `<@${executor.id}>`, inline: true });
  if (reason) fields.push({ name: 'Reason', value: String(reason).slice(0, 500) });
  if (extra) for (const [k, v] of Object.entries(extra)) fields.push({ name: k, value: String(v).slice(0, 500) });
  return logEvent(guild, 'member', { title: action, fields });
};
const logMod = (guild, { action, target, moderator, reason, extra }) => {
  const fields = [];
  if (target) fields.push({ name: 'Target', value: `<@${target.id}> (\`${target.id}\`)`, inline: true });
  if (moderator) fields.push({ name: 'Moderator', value: `<@${moderator.id}>`, inline: true });
  if (reason) fields.push({ name: 'Reason', value: String(reason).slice(0, 500) });
  if (extra) for (const [k, v] of Object.entries(extra)) fields.push({ name: k, value: String(v).slice(0, 500) });
  return logEvent(guild, 'mod', { title: action, fields });
};
const logSecurity = (guild, { action, target, executor, threshold, outcome }) => {
  const fields = [];
  if (executor) fields.push({ name: 'Executor', value: `<@${executor.id}> (\`${executor.id}\`)`, inline: true });
  if (target) fields.push({ name: 'Target', value: `<@${target.id}>`, inline: true });
  if (threshold) fields.push({ name: 'Threshold', value: String(threshold), inline: true });
  if (outcome) fields.push({ name: 'Outcome', value: outcome });
  return logEvent(guild, 'security', { title: action, fields });
};
const logTicket = (guild, { action, ticket, actor, detail }) => {
  const fields = [];
  if (ticket) {
    fields.push({ name: 'Ticket', value: `<#${ticket.channelId}>`, inline: true });
    fields.push({ name: 'Owner', value: `<@${ticket.userId}>`, inline: true });
    fields.push({ name: 'Status', value: ticket.status, inline: true });
  }
  if (actor) fields.push({ name: 'Actor', value: `<@${actor.id}>`, inline: true });
  if (detail) fields.push({ name: 'Detail', value: String(detail).slice(0, 1000) });
  return logEvent(guild, 'ticket', { title: action, fields });
};
const logVoice = (guild, { action, member, from, to }) => {
  const fields = [];
  if (member) fields.push({ name: 'Member', value: `<@${member.id}>`, inline: true });
  if (from) fields.push({ name: 'From', value: `<#${from}>`, inline: true });
  if (to) fields.push({ name: 'To', value: `<#${to}>`, inline: true });
  return logEvent(guild, 'voice', { title: action, fields });
};
const logServer = (guild, { action, fields = [] }) => logEvent(guild, 'server', { title: action, fields });

// =============================================================================
// MODERATION
// =============================================================================
async function moderate(action, { guild, moderator, target, reason, durationMs }) {
  const me = guild.members.me;
  const need = {
    ban: PermissionFlagsBits.BanMembers,
    unban: PermissionFlagsBits.BanMembers,
    kick: PermissionFlagsBits.KickMembers,
    timeout: PermissionFlagsBits.ModerateMembers,
    untimeout: PermissionFlagsBits.ModerateMembers
  }[action];
  if (need && !me.permissions.has(need)) throw new Error('Bot lacks the required permission.');
  if (target?.id && !canModerate(guild, moderator, target)) throw new Error('You cannot act on this user (hierarchy or self).');

  switch (action) {
    case 'ban': await guild.members.ban(target.id, { reason }); break;
    case 'unban': await guild.bans.remove(target.id, reason); break;
    case 'kick': await target.kick(reason); break;
    case 'timeout':
      if (!durationMs || durationMs < 1000 || durationMs > 28 * 86400000) throw new Error('Timeout must be 1s–28d.');
      await target.timeout(durationMs, reason); break;
    case 'untimeout': await target.timeout(null, reason); break;
    case 'warn': db.addWarn(guild.id, target.id, moderator.id, reason); break;
    default: throw new Error(`Unknown action: ${action}`);
  }
  db.logAction(guild.id, target?.id || 'unknown', action, reason || '');
  await logMod(guild, { action: `🔨 Moderation — ${action}`, target, moderator, reason });
}

// =============================================================================
// AUTOMOD
// =============================================================================
const automodState = new Collection();
function refreshAutomod(guildId) {
  const cfg = db.getConfig(guildId);
  const words = [...(cfg.antibadword?.words || []), ...(cfg.antibadword?.customWords || [])].filter(Boolean);
  const pattern = words.length
    ? new RegExp(words.map(w => `(?:^|[^a-z0-9])${String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`).join('|'), 'i')
    : null;
  const prev = automodState.get(guildId);
  if (prev?.window) prev.window.clear?.();
  automodState.set(guildId, { cfg, wordsPattern: pattern, window: prev?.window || new Map() });
}
function getAutomodRules(guildId) {
  let s = automodState.get(guildId);
  if (!s) { refreshAutomod(guildId); s = automodState.get(guildId); }
  return s;
}

async function runAutomod(message) {
  if (!message.guild || message.author.bot) return false;
  const { cfg, wordsPattern, window: spamWindow } = getAutomodRules(message.guild.id);
  const me = message.guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageMessages)) return false;
  if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return false;
  if (cfg.antilink.bypassRoleId && message.member?.roles.cache.has(cfg.antilink.bypassRoleId)) return false;

  const content = message.content;
  let action = null, reason = null;

  if (cfg.antilink.enabled) {
    const links = content.match(/(https?:\/\/[^\s]+|discord\.gg\/[^\s]+)/gi);
    if (links && !links.every(l => cfg.antilink.whitelistedDomains.some(d => l.includes(d)))) { action = 'delete'; reason = 'antilink'; }
  }
  if (!action && cfg.antibadword.enabled && wordsPattern && wordsPattern.test(content)) { action = cfg.antibadword.action || 'delete'; reason = 'badword'; }
  if (!action && cfg.automod.enabled && cfg.automod.capsFilter) {
    const letters = content.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 8) {
      const caps = letters.replace(/[^A-Z]/g, '').length;
      if ((caps / letters.length) * 100 >= (cfg.automod.capsThreshold || 70)) { action = 'delete'; reason = 'caps'; }
    }
  }
  if (!action && cfg.automod.enabled && cfg.automod.inviteFilter && /(?:discord\.gg|discord(?:app)?\.com\/invite)\/\S+/i.test(content)) { action = 'delete'; reason = 'invite'; }
  if (!action && cfg.antispam.enabled) {
    const key = `${message.channel.id}:${message.author.id}`;
    const now = Date.now();
    const win = cfg.antispam.windowSeconds * 1000;
    const bucket = (spamWindow.get(key) || []).filter(t => now - t < win);
    bucket.push(now); spamWindow.set(key, bucket);
    if (bucket.length > cfg.antispam.maxMessages) { action = cfg.antispam.punishment || 'mute'; reason = 'spam'; }
  }
  if (!action && cfg.antispam.enabled && (message.mentions.users.size + message.mentions.roles.size) > cfg.antispam.maxMentions) { action = 'delete'; reason = 'mentions'; }

  if (!action) return false;
  await message.delete().catch(() => {});
  if (action === 'mute' && message.member) {
    await message.member.timeout((cfg.antispam.muteMinutes || 5) * 60000, `Automod: ${reason}`).catch(() => {});
  }
  await logMessage(message.guild, {
    action: 'delete', author: message.author, channel: message.channel,
    content: content.slice(0, 1000),
    executor: { id: me.id, tag: 'AutoMod' }
  });
  return true;
}

// =============================================================================
// ANTI-NUKE
// =============================================================================
const nukeWindows = new Map();
async function antinukeStrike(guild, executorId, actionKey) {
  const cfg = db.getConfig(guild.id).antinuke;
  if (!cfg.enabled || !executorId) return false;
  if (executorId === guild.client.user.id) return false;
  if (executorId === guild.ownerId && cfg.protectOwner) return false;
  if (db.isWhitelisted(guild.id, executorId)) return false;

  const limits = {
    channelDelete: cfg.maxChannelDeletes, channelCreate: cfg.maxChannelCreates,
    roleDelete: cfg.maxRoleDeletes, roleCreate: cfg.maxRoleCreates,
    ban: cfg.maxBans, kick: cfg.maxKicks,
    webhookCreate: cfg.maxWebhookCreates, roleUpdate: cfg.maxRoleUpdates
  };
  const limit = limits[actionKey] ?? 3;
  const key = `${guild.id}:${executorId}:${actionKey}`;
  const now = Date.now();
  const w = nukeWindows.get(key);
  let count;
  if (!w || now - w.start > cfg.windowSeconds * 1000) { count = 1; nukeWindows.set(key, { start: now, count }); }
  else { count = w.count + 1; w.count = count; }
  if (count < limit) return false;
  nukeWindows.delete(key);

  const member = await guild.members.fetch(executorId).catch(() => null);
  let taken = 'none';
  try {
    if (member) {
      if (cfg.punishment === 'ban') { await member.ban({ reason: `Antinuke: ${actionKey}` }); taken = 'banned'; }
      else if (cfg.punishment === 'kick') { await member.kick(`Antinuke: ${actionKey}`); taken = 'kicked'; }
      else if (cfg.punishment === 'strip_roles') { await member.roles.set([], `Antinuke: ${actionKey}`); taken = 'stripped roles'; }
    }
  } catch (e) { taken = `failed (${e.message})`; }
  db.logAction(guild.id, executorId, 'antinuke', `${actionKey} × ${count} → ${taken}`);
  await logSecurity(guild, { action: '🛡️ Anti-Nuke Triggered', target: { id: executorId }, threshold: `${count}/${limit}`, outcome: taken });
  return true;
}

// =============================================================================
// ANTI-RAID / ANTI-BOT / ANTI-ALT / ANTI-WEBHOOK
// =============================================================================
const pool = async (items, size, fn) => {
  const arr = [...items]; let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, arr.length) }, async () => {
    while (i < arr.length) { const k = i++; await fn(arr[k]); }
  }));
};
async function handleAntiraidJoin(member) {
  const cfg = db.getConfig(member.guild.id).antiraid;
  if (!cfg.enabled) return;
  db.trackJoin(member.guild.id, member.id);
  const ageDays = (Date.now() - member.user.createdTimestamp) / 86400000;
  if (ageDays < cfg.minAccountAgeDays) {
    await member.kick(`Antiraid: age ${ageDays.toFixed(1)}d`).catch(() => {});
    return;
  }
  const joins = db.recentJoinCount(member.guild.id, cfg.windowSeconds);
  if (joins >= cfg.joinThreshold) {
    await logSecurity(member.guild, { action: '🚨 Raid Detected', threshold: `${joins}/${cfg.windowSeconds}s`, outcome: cfg.action });
    if (cfg.action === 'lockdown') {
      const everyone = member.guild.roles.everyone;
      const chs = member.guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
      await pool(chs.values(), 5, ch => ch.permissionOverwrites.edit(everyone, { SendMessages: false }, { reason: 'Anti-raid' }).catch(() => {}));
    } else if (cfg.action === 'kick_new') {
      await member.kick('Antiraid').catch(() => {});
    }
  }
}
async function handleAntiBotJoin(member) {
  const cfg = db.getConfig(member.guild.id).antibot;
  if (!cfg.enabled || !member.user.bot) return;
  if (cfg.bypassRoleId) {
    const exec = await auditExecutor(member.guild, AuditLogEvent.BotAdd, member.id);
    const inviter = exec ? await member.guild.members.fetch(exec.id).catch(() => null) : null;
    if (inviter?.roles.cache.has(cfg.bypassRoleId)) return;
  }
  if (cfg.action === 'ban') await member.ban({ reason: 'Anti-Bot' }).catch(() => {});
  else if (cfg.action === 'strip_roles') await member.roles.set([], 'Anti-Bot').catch(() => {});
  else await member.kick('Anti-Bot').catch(() => {});
  await logSecurity(member.guild, { action: '🤖 Anti-Bot Triggered', target: member.user, outcome: cfg.action });
}
async function handleAntiAltJoin(member) {
  const cfg = db.getConfig(member.guild.id).antialt;
  if (!cfg.enabled || member.user.bot) return;
  const ageDays = (Date.now() - member.user.createdTimestamp) / 86400000;
  if (ageDays >= Number(cfg.minAccountAgeDays || 0)) return;
  if (cfg.action === 'ban') await member.ban({ reason: 'Anti-Alt' }).catch(() => {});
  else await member.kick('Anti-Alt').catch(() => {});
  await logSecurity(member.guild, { action: '🛡️ Anti-Alt Triggered', target: member.user, threshold: `${ageDays.toFixed(1)}d < ${cfg.minAccountAgeDays}d`, outcome: cfg.action });
}
async function handleAntiWebhookCreate(channel) {
  const cfg = db.getConfig(channel.guild.id).antiwebhook;
  if (!cfg.enabled) return;
  const exec = await auditExecutor(channel.guild, AuditLogEvent.WebhookCreate, null);
  if (!exec || exec.id === channel.client.user.id) return;
  const member = await channel.guild.members.fetch(exec.id).catch(() => null);
  if (!member) return;
  if (cfg.bypassRoleId && member.roles.cache.has(cfg.bypassRoleId)) return;
  try {
    const hooks = await channel.fetchWebhooks().catch(() => null);
    if (hooks) for (const h of hooks.values()) if (h.owner?.id === exec.id) await h.delete('Anti-Webhook').catch(() => {});
    if (cfg.action === 'ban') await member.ban({ reason: 'Anti-Webhook' }).catch(() => {});
    else if (cfg.action === 'kick') await member.kick('Anti-Webhook').catch(() => {});
    else if (cfg.action === 'strip_roles') await member.roles.set([], 'Anti-Webhook').catch(() => {});
  } finally {
    await logSecurity(channel.guild, { action: '🪝 Anti-Webhook Triggered', target: exec, outcome: cfg.action });
  }
}

// =============================================================================
// TICKETS
// =============================================================================
async function getOrCreateTicketCategory(guild, cfg) {
  if (cfg.categoryId) {
    const ch = guild.channels.cache.get(cfg.categoryId);
    if (ch && ch.type === ChannelType.GuildCategory) return ch;
  }
  return await guild.channels.create({ name: 'Tickets', type: ChannelType.GuildCategory, reason: 'AunXz ticket system' });
}
function ticketPermissionOverwrites(guild, opener, supportRoleId) {
  const ow = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: opener.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
    { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] }
  ];
  if (supportRoleId && guild.roles.cache.has(supportRoleId)) {
    ow.push({ id: supportRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] });
  }
  return ow;
}
async function openTicket(guild, opener, { type = 'general', subject = null } = {}) {
  const cfg = db.getConfig(guild.id).ticket;
  if (!cfg.enabled) throw new Error('Tickets are disabled.');
  const existing = db.openTicketsForUser(guild.id, opener.id);
  for (const t of existing) {
    if (guild.channels.cache.has(t.channelId)) throw new Error(`You already have an open ticket: <#${t.channelId}>`);
    db.setTicketStatus(t.channelId, 'closed');
  }
  const me = guild.members.me;
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error('Bot lacks **Manage Channels** permission.');
  const category = await getOrCreateTicketCategory(guild, cfg);
  const baseName = `ticket-${opener.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 80) || 'ticket';
  const channel = await guild.channels.create({
    name: baseName,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `Ticket by ${opener.tag} • ${type}`.slice(0, 1024),
    permissionOverwrites: ticketPermissionOverwrites(guild, opener, cfg.supportRoleId),
    reason: `Ticket opened by ${opener.tag}`
  }).catch(e => {
    if (e.code === 50013) throw new Error('Bot lacks Manage Channels permission.');
    if (e.code === 50035) throw new Error('Discord rejected the channel name. Try again.');
    throw e;
  });
  db.createTicket(channel.id, guild.id, opener.id);
  db.db.prepare('UPDATE tickets SET type = ? WHERE channelId = ?').run(type, channel.id);
  db.logTicketEvent(guild.id, channel.id, opener.id, 'open', type);

  const welcome = ui.ticketWelcome(cfg, opener);
  try {
    await channel.send({ content: `<@${opener.id}>`, ...welcome, allowedMentions: { users: [opener.id] } });
  } catch (e) { console.error('[ticket] welcome post failed:', e?.message || e); }

  await logTicket(guild, { action: '🎫 Ticket Opened', ticket: db.getTicket(channel.id), actor: opener, detail: `Type: ${type}` });
  return { channel, ticket: db.getTicket(channel.id) };
}
async function closeTicketWith(channel, guild, actor, reason) {
  const ticket = db.getTicket(channel.id);
  if (!ticket) throw new Error('Not a ticket channel.');
  if (ticket.status === 'closed') throw new Error('Ticket is already closed.');
  db.setTicketStatus(channel.id, 'closed', ticket.claimedBy);
  db.db.prepare('UPDATE tickets SET closedBy = ?, closeReason = ? WHERE channelId = ?').run(actor.id, reason || null, channel.id);
  db.logTicketEvent(guild.id, channel.id, actor.id, 'close', reason);
  await logTicket(guild, { action: '🔒 Ticket Closed', ticket, actor, detail: reason });
  if (!channel.name.startsWith('closed-')) await channel.setName(`closed-${channel.name}`.slice(0, 100)).catch(() => {});
  await channel.permissionOverwrites.edit(ticket.userId, { SendMessages: false }).catch(() => {});
}
async function reopenTicket(channel, guild, actor) {
  const ticket = db.getTicket(channel.id);
  if (!ticket) throw new Error('Not a ticket channel.');
  if (ticket.status !== 'closed') throw new Error('Ticket is already open.');
  db.setTicketStatus(channel.id, 'open', ticket.claimedBy);
  db.logTicketEvent(guild.id, channel.id, actor.id, 'reopen', null);
  await logTicket(guild, { action: '🔓 Ticket Reopened', ticket, actor });
  if (channel.name.startsWith('closed-')) await channel.setName(channel.name.replace(/^closed-/, '')).catch(() => {});
  await channel.permissionOverwrites.edit(ticket.userId, { SendMessages: true }).catch(() => {});
}
async function buildTranscript(channel, ticket) {
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return null;
  const lines = messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map(m => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag} (${m.author.id}): ${m.content}`);
  const header = `Ticket transcript — #${channel.name} (${channel.id})\nOwner: ${ticket.userId}\nGenerated: ${new Date().toISOString()}\n\n`;
  return Buffer.from(header + lines.join('\n'), 'utf8');
}

// =============================================================================
// LEVELING
// =============================================================================
function xpForLevel(level) { return 5 * (level ** 2) + 50 * level + 100; }
function levelFromXp(total) {
  let level = 0, remaining = total;
  while (remaining >= xpForLevel(level)) { remaining -= xpForLevel(level); level++; }
  return { level, remaining, next: xpForLevel(level) };
}
async function handleLevelingMessage(message) {
  const cfg = db.getConfig(message.guild.id).leveling;
  if (!cfg.enabled) return;
  const rec = db.getLevel(message.guild.id, message.author.id);
  const now = Date.now();
  if (now - rec.lastMessage < cfg.cooldownSeconds * 1000) return;
  const totalXp = rec.xp + cfg.xpPerMessage;
  const before = rec.level;
  const { level } = levelFromXp(totalXp);
  db.setLevel(message.guild.id, message.author.id, totalXp, level, now);
  if (level > before) {
    const text = applyTemplate(cfg.levelUpMessage, {
      user: `<@${message.author.id}>`, username: message.author.username, level, xp: totalXp
    });
    const ch = cfg.channel ? message.guild.channels.cache.get(cfg.channel) : message.channel;
    if (ch?.isTextBased()) ch.send({ content: text, allowedMentions: { users: [message.author.id] } }).catch(() => {});
    const reward = cfg.roleRewards[String(level)];
    if (reward) {
      const role = message.guild.roles.cache.get(reward);
      const me = message.guild.members.me;
      if (role && me && role.position < me.roles.highest.position) {
        await message.member.roles.add(role, `Level ${level} reward`).catch(() => {});
      }
    }
    await logEvent(message.guild, 'system', { title: '📈 Level Up', fields: [
      { name: 'User', value: `<@${message.author.id}>`, inline: true },
      { name: 'New level', value: String(level), inline: true }
    ]});
  }
}

// =============================================================================
// VOICEMASTER
// =============================================================================
async function handleVoicemasterJoin(oldState, newState) {
  const cfg = db.getConfig(newState.guild.id).voicemaster;
  if (!cfg.enabled || !cfg.hubChannelId) return;
  if (newState.channelId === cfg.hubChannelId) {
    const guild = newState.guild;
    const me = guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) return;
    try {
      const name = applyTemplate(cfg.nameTemplate, { user: newState.member.displayName, username: newState.member.user.username }).slice(0, 100);
      const channel = await guild.channels.create({
        name: name || 'voice',
        type: ChannelType.GuildVoice,
        parent: cfg.categoryId || newState.channel.parentId || undefined,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
          { id: newState.member.id, allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers] }
        ],
        reason: 'VoiceMaster'
      });
      db.addVMChannel(channel.id, guild.id, newState.member.id);
      await newState.member.voice.setChannel(channel).catch(() => {});
      await channel.send(ui.vmControlEmbed(newState.member, guild.id)).catch(() => {});
    } catch (e) { console.error('[vm]', e?.message); }
    return;
  }
  if (oldState.channelId && oldState.channel) {
    const rec = db.getVMChannel(oldState.channelId);
    if (rec && oldState.channel.members.size === 0) {
      await oldState.channel.delete().catch(() => {});
      db.removeVMChannel(oldState.channelId);
    }
  }
}

// =============================================================================
// SNIPE
// =============================================================================
function snipeView(guildId, channelId, offset) {
  const total = db.snipesCount(guildId, channelId);
  if (total === 0) {
    return { ...ui.v2Info('Snipe', 'No deleted or edited messages cached for this channel.'), __empty: true };
  }
  const idx = Math.max(0, Math.min(offset, total - 1));
  const e = db.getSnipeAt(guildId, channelId, idx);
  if (!e) return { ...ui.v2Info('Snipe', 'Record unavailable.'), __empty: true };

  const fields = [
    { name: 'Author', value: `<@${e.authorId}> (\`${e.authorId}\`)`, inline: true },
    { name: 'Channel', value: `<#${e.channelId}>`, inline: true },
    { name: 'When', value: `<t:${Math.floor(e.ts / 1000)}:R>`, inline: true }
  ];
  if (e.action === 'edit') {
    fields.push({ name: 'Before', value: (e.content || '*empty*').slice(0, 1000) });
    fields.push({ name: 'After', value: (e.newContent || '*empty*').slice(0, 1000) });
  } else {
    fields.push({ name: 'Content', value: (e.content || '*no content*').slice(0, 1000) });
  }
  if (e.attachments?.length) {
    fields.push({ name: `Attachments (${e.attachments.length})`, value: e.attachments.slice(0, 5).map(a => `[${a.name || 'file'}](${a.url})`).join('\n').slice(0, 1000) });
  }
  if (e.jumpUrl) fields.push({ name: 'Jump', value: `[Open message](${e.jumpUrl})` });

  const components = [ui.row(
    ui.btn(`snipe:nav:${guildId}:${channelId}:${idx - 1}`, '‹ Previous', 2, { disabled: idx <= 0 }),
    ui.btn(`snipe:page:${guildId}:${channelId}:${idx}`, `${idx + 1} / ${total}`, 2, { disabled: true }),
    ui.btn(`snipe:nav:${guildId}:${channelId}:${idx + 1}`, 'Next ›', 2, { disabled: idx >= total - 1 })
  )];
  return ui.buildV2({
    title: e.action === 'edit' ? '✏️ Edited Message' : '🗑️ Deleted Message',
    fields,
    footer: `${BRAND} • Record ${idx + 1} of ${total}`,
    components
  });
}

// =============================================================================
// GROQ AI
// =============================================================================
const GROQ_BASE = (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const GROQ_TIMEOUT_MS = Math.max(1000, Math.min(120000, parseInt(process.env.GROQ_TIMEOUT_MS || '15000', 10) || 15000));
const GROQ_PRIMARY = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_FALLBACK = process.env.GROQ_FALLBACK_MODEL || 'llama-3.1-8b-instant';
const GROQ_MAX_RETRIES = Math.max(0, Math.min(3, parseInt(process.env.GROQ_MAX_RETRIES || '1', 10)));

class GroqError extends Error {
  constructor(code, message, opts = {}) { super(message); this.code = code; this.status = opts.status ?? null; this.retryable = !!opts.retryable; }
}

async function groqChat(messages, { model, maxTokens = 700, temperature = 0.2, jsonMode = false } = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new GroqError('ai_missing_key', 'GROQ_API_KEY is not configured.');
  if (!Array.isArray(messages) || !messages.length) throw new GroqError('ai_validation', 'Messages must be a non-empty array.');
  const models = [...new Set([model || GROQ_PRIMARY, GROQ_FALLBACK].filter(Boolean))];
  let lastErr;
  for (let i = 0; i < models.length; i++) {
    for (let attempt = 0; attempt <= GROQ_MAX_RETRIES; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), GROQ_TIMEOUT_MS);
      try {
        const res = await fetch(`${GROQ_BASE}/chat/completions`, {
          method: 'POST', signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: models[i], messages, temperature, max_tokens: maxTokens, ...(jsonMode ? { response_format: { type: 'json_object' } } : {}) })
        });
        clearTimeout(timer);
        if (res.ok) {
          const data = await res.json();
          const content = data?.choices?.[0]?.message?.content;
          if (typeof content !== 'string' || !content.trim()) throw new GroqError('ai_empty', 'Groq returned empty.');
          return { content: content.trim(), model: data.model || models[i], usage: data.usage || null };
        }
        const status = res.status;
        await res.text().catch(() => '');
        if (status === 401 || status === 403) throw new GroqError('ai_auth', 'Groq authentication failed.');
        if (status === 404) throw new GroqError('ai_model', 'Groq model or endpoint not found.');
        if (status === 429) lastErr = new GroqError('ai_rate_limited', 'Groq rate-limited.', { retryable: true, status });
        else if (status >= 500) lastErr = new GroqError('ai_provider', `Groq returned ${status}.`, { retryable: true, status });
        else { lastErr = new GroqError('ai_validation', `Groq rejected the request (${status}).`, { status }); throw lastErr; }
        if (attempt < GROQ_MAX_RETRIES) await new Promise(r => setTimeout(r, 250 * (2 ** attempt)));
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof GroqError) { lastErr = e; if (!e.retryable) { if (i < models.length - 1) break; throw e; } }
        else if (e.name === 'AbortError' || e.name === 'TimeoutError') lastErr = new GroqError('ai_timeout', 'Groq request timed out.', { retryable: true });
        else lastErr = new GroqError('ai_network', 'Could not reach Groq.', { retryable: true });
        if (attempt < GROQ_MAX_RETRIES) await new Promise(r => setTimeout(r, 250 * (2 ** attempt)));
      }
    }
  }
  throw lastErr || new GroqError('ai_provider', 'Groq request failed.');
}

// =============================================================================
// TEMPLATE GENERATOR
// =============================================================================
const EMOJI_POOL = ['❄','🥮','🍂','🍁','💨','💢','🪵','☃️','⚡','🪢','🧶','♣️','♟','🎃','⚰️','💎','⚜️','🔱','♻️'];
const DIVIDERS = ['〢', '・', '┊', '┃', '┆', '︱'];
function cleanChannelName(name) {
  return String(name || '').toLowerCase().replace(/[^\p{L}\p{N}\- _]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'channel';
}
function applyNaming(style, emojiChar, name, { first = false, last = false, divider = '〢' } = {}) {
  const clean = cleanChannelName(name);
  switch (style) {
    case 'tree': return `${first ? '╭' : last ? '╰' : '│'} ${clean}`.slice(0, 100);
    case 'decorative': return `${emojiChar}﹒${clean}`.slice(0, 100);
    case 'emoji_decor': return `${emojiChar} ${divider} ${clean}`.slice(0, 100);
    case 'minimal': return clean.slice(0, 100);
    case 'emoji_divider':
    default: return `${emojiChar}︱${clean}`.slice(0, 100);
  }
}
async function generateTemplate({ serverType, namingStyle, emojiMode = 'individual', description = '', guildName = '' }) {
  const system = `You design Discord server structures. Respond with STRICT JSON only.`;
  const user = `Design a Discord server structure.
Server name: ${guildName || 'the server'}
Type: ${serverType}
Naming style: ${namingStyle}
Emoji mode: ${emojiMode === 'individual' ? 'unique emoji per channel' : 'one consistent emoji per category'}
${description ? `Description: ${description}` : ''}

Return JSON:
{
  "categories": [{ "name": string, "emoji": string, "channels": [{ "name": string, "type": "text"|"voice", "emoji": string, "topic": string }] }],
  "roles": [{ "name": string, "color": "#RRGGBB", "hoist": boolean }]
}
3-6 categories, 3-10 channels each. No extra text.`;
  const { content } = await groqChat([{ role: 'system', content: system }, { role: 'user', content: user }], { maxTokens: 2000, temperature: 0.4, jsonMode: true });
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed.categories)) throw new Error('AI returned malformed template.');
  return parsed;
}
async function applyTemplateToGuild(guild, template, namingStyle) {
  const results = { categories: 0, channels: 0, roles: 0, errors: [] };
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) { results.errors.push('Bot lacks Manage Channels.'); return results; }
  const style = namingStyle === 'ai' ? 'emoji_divider' : namingStyle;
  for (const r of template.roles || []) {
    try {
      if (!guild.roles.cache.find(x => x.name === r.name)) {
        await guild.roles.create({ name: r.name, color: r.color || 0, hoist: !!r.hoist, reason: 'AunXz template' });
        results.roles++;
      }
    } catch (e) { results.errors.push(`role ${r.name}: ${e.message}`); }
  }
  for (const cat of template.categories || []) {
    try {
      let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === cat.name);
      if (!category) { category = await guild.channels.create({ name: cat.name.slice(0, 100), type: ChannelType.GuildCategory }); results.categories++; }
      const total = cat.channels.length; let i = 0;
      for (const ch of cat.channels) {
        i++;
        const name = applyNaming(style, ch.emoji || '💬', ch.name, { first: i === 1, last: i === total });
        try {
          await guild.channels.create({
            name: name.slice(0, 100),
            type: ch.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
            parent: category.id,
            topic: ch.type === 'voice' ? undefined : (ch.topic || '').slice(0, 1024)
          });
          results.channels++;
        } catch (e) { results.errors.push(`${name}: ${e.message}`); }
      }
    } catch (e) { results.errors.push(`category ${cat.name}: ${e.message}`); }
  }
  return results;
}

// =============================================================================
// HEALTH CHECK
// =============================================================================
async function healthCheck(guild) {
  const issues = [];
  const me = guild.members.me;
  if (!me) return [{ severity: 'high', text: 'Bot is not in the guild cache.' }];
  const required = [
    ['Manage Roles', PermissionFlagsBits.ManageRoles],
    ['Manage Channels', PermissionFlagsBits.ManageChannels],
    ['Manage Messages', PermissionFlagsBits.ManageMessages],
    ['Kick Members', PermissionFlagsBits.KickMembers],
    ['Ban Members', PermissionFlagsBits.BanMembers],
    ['Moderate Members', PermissionFlagsBits.ModerateMembers],
    ['View Audit Log', PermissionFlagsBits.ViewAuditLog]
  ];
  for (const [name, bit] of required) if (!me.permissions.has(bit)) issues.push({ severity: 'high', text: `Bot missing permission: **${name}**` });

  const cfg = db.getConfig(guild.id);
  const checkChannel = (val, label) => { if (val && !guild.channels.cache.has(val)) issues.push({ severity: 'medium', text: `${label} configured but channel missing (\`${val}\`)` }); };
  const checkRole = (val, label) => { if (val && !guild.roles.cache.has(val)) issues.push({ severity: 'medium', text: `${label} configured but role missing (\`${val}\`)` }); };
  checkChannel(cfg.ticket.categoryId, 'Ticket category');
  checkChannel(cfg.ticket.logChannelId, 'Ticket log channel');
  checkChannel(cfg.welcome.channel, 'Welcome channel');
  checkChannel(cfg.leave.channel, 'Leave channel');
  checkChannel(cfg.greetmessage.channelId, 'Greet message channel');
  checkChannel(cfg.logs.default, 'Default log channel');
  for (const k of LOG_CATEGORIES) checkChannel(cfg.logs[k], `Log channel (${k})`);
  checkRole(cfg.ticket.supportRoleId, 'Ticket support role');
  checkRole(cfg.staffApplications.acceptedRoleId, 'Accepted staff role');

  if (me.roles.highest.position <= 1) issues.push({ severity: 'high', text: 'Bot role position is too low for moderation.' });
  return issues;
}

module.exports = {
  // permissions
  isOwner, isAdmin, isStaff, canModerate,
  // logging
  LOG_CATEGORIES, auditExecutor, resolveLogChannel, logEvent,
  logMessage, logMember, logMod, logSecurity, logTicket, logVoice, logServer,
  // automod
  refreshAutomod, getAutomodRules, runAutomod,
  // moderation
  moderate,
  // security
  antinukeStrike, handleAntiraidJoin, handleAntiBotJoin, handleAntiAltJoin, handleAntiWebhookCreate,
  // tickets
  openTicket, closeTicketWith, reopenTicket, buildTranscript,
  // leveling
  xpForLevel, levelFromXp, handleLevelingMessage,
  // voicemaster
  handleVoicemasterJoin,
  // snipe
  snipeView,
  // ai
  GroqError, groqChat,
  // template
  EMOJI_POOL, DIVIDERS, applyNaming, cleanChannelName, generateTemplate, applyTemplateToGuild,
  // health
  healthCheck,
  // helpers
  applyTemplate, pool
};