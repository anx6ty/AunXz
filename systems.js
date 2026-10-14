// AunXz/systems.js — all business logic: security, moderation, logging, tickets,
// leveling, role panels, applications, giveaways, automations, AI, health checks.
'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelType, PermissionFlagsBits, AuditLogEvent, Collection
} = require('discord.js');
const db = require('./database');

// =============================================================================
// THEME
// =============================================================================
const THEME = 0x8b5cf6;
const OK = 0x57f287;
const WARN = 0xfee75c;
const DANGER = 0xed4245;
const INFO = 0x5865f2;
const BRAND = process.env.BRAND_FOOTER || 'AunXz';

const EMOJI_DEFAULTS = {
  success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️', enabled: '🟢', disabled: '🔴',
  settings: '⚙️', ticket: '🎫', shield: '🛡️', voice: '🔊', level: '📈', wave: '👋',
  delete: '🗑️', lock: '🔒', unlock: '🔓', kick: '👢', mute: '🔇', link: '🔗',
  spam: '🚫', raid: '🚨', owner: '👑', help: '📖', list: '📋', edit: '✏️',
  add: '➕', remove: '➖', claim: '🙋', undo: '↩️', category: '📁'
};
function emoji(key) { return db.getEmojiOverride(key) || EMOJI_DEFAULTS[key] || '❔'; }

function accent(guildId, kind = 'info') {
  const c = guildId ? db.getConfig(guildId).appearance?.color : null;
  if (typeof c === 'number') return c;
  return { success: OK, warning: WARN, error: DANGER, info: THEME }[kind] || THEME;
}
function embed(guildId, kind, { title, description, fields, footer, thumbnail, image, author } = {}) {
  const e = new EmbedBuilder().setColor(accent(guildId, kind)).setTimestamp();
  if (title) e.setTitle(String(title).slice(0, 256));
  if (description) e.setDescription(String(description).slice(0, 4000));
  if (fields?.length) e.addFields(fields.slice(0, 25));
  if (footer) e.setFooter(typeof footer === 'string' ? { text: footer.slice(0, 2048) } : footer);
  if (thumbnail) e.setThumbnail(thumbnail);
  if (image) e.setImage(image);
  if (author) e.setAuthor(author);
  return e;
}
const okEmbed = (g, d) => embed(g, 'success', { description: `${emoji('success')} ${d}` });
const errEmbed = (g, d) => embed(g, 'error', { description: `${emoji('error')} ${d}` });
const warnEmbed = (g, d) => embed(g, 'warning', { description: `${emoji('warning')} ${d}` });
const infoEmbed = (g, d) => embed(g, 'info', { description: d });
const baseEmbed = (g, title) => embed(g, 'info', { title });

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
function isOwner(id) { return OWNER_IDS.has(String(id || '')); }
function isAdmin(m) { return m?.permissions?.has(PermissionFlagsBits.Administrator) || isOwner(m?.id); }
function isStaff(guildId, member) {
  const role = db.getConfig(guildId).staffApplications?.acceptedRoleId;
  if (!role) return isAdmin(member);
  return member?.roles?.cache?.has(role) || isAdmin(member);
}
function canModerate(guild, mod, target) {
  if (!mod || !target) return false;
  if (mod.id === target.id) return false;
  if (guild.ownerId === target.id) return false;
  if (target.id === guild.members.me.id) return false;
  return mod.roles.highest.position > target.roles.highest.position
    && guild.members.me.roles.highest.position > target.roles.highest.position;
}
function missingChannelPerms(channel, member, flags) {
  if (!channel || !member) return ['View Channel'];
  const perms = channel.permissionsFor(member);
  if (!perms) return ['View Channel'];
  return flags.filter(f => !perms.has(f));
}

// =============================================================================
// LOGGING
// =============================================================================
const LOG_KEYS = ['mod', 'message', 'member', 'voice', 'antinuke', 'server', 'ticket', 'join'];
function logChannel(guild, key) {
  const cfg = db.getConfig(guild.id).logs || {};
  const id = cfg[key] || cfg.mod;
  if (!id) return null;
  return guild.channels.cache.get(id) || null;
}
async function logEvent(guild, key, { title, description, color, fields } = {}) {
  try {
    const ch = logChannel(guild, key);
    if (!ch?.isTextBased()) return;
    const e = embed(guild.id, 'info', { title, description, fields });
    if (color !== undefined) e.setColor(color);
    await ch.send({ embeds: [e], allowedMentions: { parse: [] } }).catch(() => {});
  } catch (e) { console.error('[log]', e); }
}

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
  if (target && target.id && !canModerate(guild, moderator, target)) {
    throw new Error('You cannot act on this user (role hierarchy or self).');
  }
  switch (action) {
    case 'ban': await guild.members.ban(target.id, { reason }); break;
    case 'unban': await guild.bans.remove(target.id, reason); break;
    case 'kick': await target.kick(reason); break;
    case 'timeout':
      if (!durationMs || durationMs < 1000 || durationMs > 28 * 24 * 3600 * 1000) throw new Error('Timeout must be 1s–28d.');
      await target.timeout(durationMs, reason); break;
    case 'untimeout': await target.timeout(null, reason); break;
    case 'warn': db.addWarn(guild.id, target.id, moderator.id, reason); break;
    case 'nick': await target.setNickname(reason ?? null); break;
    default: throw new Error(`Unknown action: ${action}`);
  }
  db.logAction(guild.id, target?.id || 'unknown', action, reason || '');
  await logEvent(guild, 'mod', {
    title: `Moderation — ${action}`,
    description: `**User:** <@${target?.id || 'unknown'}>\n**Moderator:** <@${moderator.id}>\n**Reason:** ${reason || 'None'}`
  });
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
  automodState.set(guildId, { cfg, wordsPattern: pattern, window: new Map() });
}
function getAutomodRules(guildId) {
  let state = automodState.get(guildId);
  if (!state) { refreshAutomod(guildId); state = automodState.get(guildId); }
  return state;
}

async function runAutomod(message) {
  if (!message.guild || message.author.bot) return false;
  const { cfg, wordsPattern, window: spamWindow } = getAutomodRules(message.guild.id);
  const me = message.guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageMessages)) return false;

  if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return false;
  if (cfg.antilink.bypassRoleId && message.member?.roles.cache.has(cfg.antilink.bypassRoleId)) return false;

  const content = message.content;
  let action = null;
  let reason = null;

  // Antilink
  if (cfg.antilink.enabled) {
    const links = content.match(/(https?:\/\/[^\s]+|discord\.gg\/[^\s]+)/gi);
    if (links && !links.every(l => cfg.antilink.whitelistedDomains.some(d => l.includes(d)))) {
      action = 'delete'; reason = 'antilink';
    }
  }

  // Bad words (word-boundary, pre-compiled)
  if (!action && cfg.antibadword.enabled && wordsPattern && wordsPattern.test(content)) {
    action = cfg.antibadword.action || 'delete'; reason = 'badword';
  }

  // Caps
  if (!action && cfg.automod.enabled && cfg.automod.capsFilter) {
    const letters = content.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 8) {
      const caps = letters.replace(/[^A-Z]/g, '').length;
      if ((caps / letters.length) * 100 >= (cfg.automod.capsThreshold || 70)) { action = 'delete'; reason = 'caps'; }
    }
  }

  // Invites
  if (!action && cfg.automod.enabled && cfg.automod.inviteFilter &&
      /(?:discord\.gg|discord(?:app)?\.com\/invite)\/\S+/i.test(content)) {
    action = 'delete'; reason = 'invite';
  }

  // Spam (per-guild window)
  if (!action && cfg.antispam.enabled) {
    const key = `${message.channel.id}:${message.author.id}`;
    const now = Date.now();
    const win = cfg.antispam.windowSeconds * 1000;
    const bucket = (spamWindow.get(key) || []).filter(t => now - t < win);
    bucket.push(now);
    spamWindow.set(key, bucket);
    if (bucket.length > cfg.antispam.maxMessages) { action = cfg.antispam.punishment || 'mute'; reason = 'spam'; }
  }

  // Mentions flood
  if (!action && cfg.antispam.enabled && (message.mentions.users.size + message.mentions.roles.size) > cfg.antispam.maxMentions) {
    action = 'delete'; reason = 'mentions';
  }

  if (!action) return false;

  await message.delete().catch(() => {});

  if (action === 'mute' && message.member) {
    await message.member.timeout((cfg.antispam.muteMinutes || 5) * 60 * 1000, `Automod: ${reason}`).catch(() => {});
  }

  await logEvent(message.guild, reason === 'spam' ? 'message' : 'message', {
    title: `AutoMod — ${reason}`,
    description: `**User:** ${message.author} (${message.author.id})\n**Channel:** <#${message.channel.id}>`,
    color: DANGER
  });

  return true;
}

// =============================================================================
// ANTI-NUKE
// =============================================================================
const nukeWindows = new Map();
const auditCache = new Map();

async function findAuditExecutor(guild, type, targetId, { maxAgeMs = 12000 } = {}) {
  const cacheKey = `${guild.id}:${type}:${targetId || ''}`;
  const now = Date.now();
  const hit = auditCache.get(cacheKey);
  if (hit && now - hit.ts < 3000) return hit.executor;
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    const entry = logs.entries.find(e => now - e.createdTimestamp < maxAgeMs && (!targetId || e.target?.id === targetId));
    const executor = entry?.executor || null;
    auditCache.set(cacheKey, { executor, ts: now });
    if (auditCache.size > 500) auditCache.delete(auditCache.keys().next().value);
    return executor;
  } catch { return null; }
}

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
      else if (cfg.punishment === 'strip_roles') { await member.roles.set([], `Antinuke: ${actionKey}`); taken = 'stripped'; }
    }
  } catch (e) { taken = `failed (${e.message})`; }

  db.logAction(guild.id, executorId, 'antinuke', `${actionKey} × ${count} → ${taken}`);
  await logEvent(guild, 'antinuke', {
    title: '🛡️ Anti-Nuke Triggered',
    description: `**User:** <@${executorId}>\n**Trigger:** ${actionKey} (${count}/${limit})\n**Action:** ${taken}`,
    color: DANGER
  });
  return true;
}

// =============================================================================
// ANTI-RAID
// =============================================================================
const pool = async (items, size, fn) => {
  const arr = [...items];
  let i = 0;
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
    await member.kick(`Antiraid: account age ${ageDays.toFixed(1)}d < ${cfg.minAccountAgeDays}d`).catch(() => {});
    db.logAction(member.guild.id, member.id, 'antiraid', 'kicked-new-account');
    return;
  }

  const joins = db.recentJoinCount(member.guild.id, cfg.windowSeconds);
  if (joins >= cfg.joinThreshold) {
    db.logAction(member.guild.id, member.id, 'antiraid', `raid: ${joins}/${cfg.windowSeconds}s`);
    await logEvent(member.guild, 'antinuke', {
      title: '🚨 Raid Detected', description: `${joins} joins in ${cfg.windowSeconds}s. Action: **${cfg.action}**`,
      color: DANGER
    });

    if (cfg.action === 'lockdown') {
      const everyone = member.guild.roles.everyone;
      const textChannels = member.guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
      // Bounded concurrency: was sequential, took 60s+ on 200-channel servers and ate rate limits.
      await pool(textChannels.values(), 5, async ch => {
        await ch.permissionOverwrites.edit(everyone, { SendMessages: false }, { reason: 'Anti-raid lockdown' }).catch(() => {});
      });
    } else if (cfg.action === 'kick_new') {
      await member.kick('Antiraid').catch(() => {});
    }
  }
}

// =============================================================================
// ANTI-BOT / ANTI-ALT / ANTI-WEBHOOK
// =============================================================================
async function handleAntiBotJoin(member) {
  const cfg = db.getConfig(member.guild.id).antibot;
  if (!cfg.enabled || !member.user.bot) return;
  if (cfg.bypassRoleId) {
    const exec = await findAuditExecutor(member.guild, AuditLogEvent.BotAdd, member.id);
    const inviter = exec ? await member.guild.members.fetch(exec.id).catch(() => null) : null;
    if (inviter?.roles.cache.has(cfg.bypassRoleId)) return;
  }
  if (cfg.action === 'ban') await member.ban({ reason: 'Anti-Bot' }).catch(() => {});
  else if (cfg.action === 'strip_roles') await member.roles.set([], 'Anti-Bot').catch(() => {});
  else await member.kick('Anti-Bot').catch(() => {});
  await logEvent(member.guild, 'antinuke', {
    title: '🤖 Anti-Bot Triggered',
    description: `**Bot:** ${member.user.tag} (<@${member.id}>)\n**Action:** ${cfg.action}`
  });
}
async function handleAntiAltJoin(member) {
  const cfg = db.getConfig(member.guild.id).antialt;
  if (!cfg.enabled || member.user.bot) return;
  const ageDays = (Date.now() - member.user.createdTimestamp) / 86400000;
  if (ageDays >= Number(cfg.minAccountAgeDays || 0)) return;
  if (cfg.action === 'ban') await member.ban({ reason: 'Anti-Alt' }).catch(() => {});
  else await member.kick('Anti-Alt').catch(() => {});
  await logEvent(member.guild, 'antinuke', {
    title: '🛡️ Anti-Alt Triggered',
    description: `**User:** ${member.user.tag}\n**Age:** ${ageDays.toFixed(1)}d (min ${cfg.minAccountAgeDays}d)\n**Action:** ${cfg.action}`
  });
}
async function handleAntiWebhookCreate(channel) {
  const cfg = db.getConfig(channel.guild.id).antiwebhook;
  if (!cfg.enabled) return;
  const exec = await findAuditExecutor(channel.guild, AuditLogEvent.WebhookCreate, null);
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
    await logEvent(channel.guild, 'antinuke', {
      title: '🪝 Anti-Webhook Triggered',
      description: `**Executor:** <@${exec.id}>\n**Channel:** ${channel}\n**Action:** ${cfg.action}`
    });
  }
}

// =============================================================================
// LEVELING
// =============================================================================
function xpForLevel(level) { return 5 * (level ** 2) + 50 * level + 100; }
function levelFromXp(totalXp) {
  let level = 0, remaining = totalXp;
  while (remaining >= xpForLevel(level)) { remaining -= xpForLevel(level); level++; }
  return { level, remaining, next: xpForLevel(level) };
}
async function handleLevelingMessage(message) {
  const cfg = db.getConfig(message.guild.id).leveling;
  if (!cfg.enabled) return;
  const rec = db.getLevel(message.guild.id, message.author.id);
  const now = Date.now();
  if (now - rec.lastMessage < cfg.cooldownSeconds * 1000) return;

  const gain = cfg.xpPerMessage;
  const xpTotal = rec.xp + gain;
  const beforeLevel = rec.level;
  const { level } = levelFromXp(xpTotal);
  db.setLevel(message.guild.id, message.author.id, xpTotal, level, now);

  if (level > beforeLevel) {
    const text = applyTemplate(cfg.levelUpMessage, {
      user: `<@${message.author.id}>`, username: message.author.username,
      level, xp: xpTotal
    });
    const ch = cfg.channel ? message.guild.channels.cache.get(cfg.channel) : message.channel;
    if (ch?.isTextBased()) ch.send({ content: text, allowedMentions: { users: [message.author.id] } }).catch(() => {});

    const rewardRole = cfg.roleRewards[String(level)];
    if (rewardRole) {
      const role = message.guild.roles.cache.get(rewardRole);
      const me = message.guild.members.me;
      if (role && me && role.position < me.roles.highest.position) {
        await message.member.roles.add(role, `Level ${level} reward`).catch(() => {});
      }
    }
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
      const name = applyTemplate(cfg.nameTemplate, { user: newState.member.displayName, username: newState.member.user.username });
      const channel = await guild.channels.create({
        name: name.slice(0, 100), type: ChannelType.GuildVoice,
        parent: cfg.categoryId || newState.channel.parentId || undefined,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
          { id: newState.member.id, allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers] }
        ],
        reason: 'VoiceMaster'
      });
      db.addVMChannel(channel.id, guild.id, newState.member.id);
      await newState.member.voice.setChannel(channel).catch(() => {});
      await channel.send({
        embeds: [baseEmbed(guild.id, `${emoji('voice')} Your channel`).setDescription(`Owned by ${newState.member}. Use the buttons below.`)],
        components: vmControlRows(channel)
      }).catch(() => {});
    } catch (e) { console.error('[vm]', e); }
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
function vmControlRows(vc) {
  const everyone = vc.guild.roles.everyone;
  const ow = vc.permissionOverwrites.cache.get(everyone.id);
  const locked = !!(ow && ow.deny.has(PermissionFlagsBits.Connect));
  const hidden = !!(ow && ow.deny.has(PermissionFlagsBits.ViewChannel));
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vm_lock').setLabel(locked ? 'Unlock' : 'Lock').setStyle(locked ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji(locked ? '🔓' : '🔒'),
      new ButtonBuilder().setCustomId('vm_hide').setLabel(hidden ? 'Unhide' : 'Hide').setStyle(hidden ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji(hidden ? '👁️' : '🙈'),
      new ButtonBuilder().setCustomId('vm_rename').setLabel('Rename').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
      new ButtonBuilder().setCustomId('vm_limit').setLabel('Limit').setStyle(ButtonStyle.Primary).setEmoji('🔢')
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vm_kick').setLabel('Kick').setStyle(ButtonStyle.Danger).setEmoji('👢'),
      new ButtonBuilder().setCustomId('vm_transfer').setLabel('Transfer').setStyle(ButtonStyle.Danger).setEmoji('🔁')
    )
  ];
}

// =============================================================================
// TICKETS
// =============================================================================
function ticketPanelEmbed(guildId, cfg = {}) {
  const e = baseEmbed(guildId, cfg.panelTitle || `${emoji('ticket')} Support`)
    .setDescription(cfg.panelDescription || 'Need help? Click **Open Ticket** and our team will assist you.');
  if (cfg.panelThumbnail) e.setThumbnail(cfg.panelThumbnail);
  if (cfg.panelImage) e.setImage(cfg.panelImage);
  return e;
}
function ticketPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_open').setLabel('Open Ticket').setStyle(ButtonStyle.Primary).setEmoji(emoji('ticket'))
  );
}
function ticketWelcomeEmbed(guildId, user, cfg) {
  const text = (cfg.welcomeMessage || 'Welcome {user}!').replace('{user}', `${user}`);
  const e = baseEmbed(guildId, `${cfg.categoryLabel || 'Support'} Ticket`)
    .setDescription(`**Welcome** ${user}\n**Category:** ${cfg.categoryLabel || 'Support'}\n${text}`);
  if (cfg.welcomeThumbnail) e.setThumbnail(cfg.welcomeThumbnail);
  if (cfg.welcomeImage) e.setImage(cfg.welcomeImage);
  return e;
}
function ticketControlRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
    new ButtonBuilder().setCustomId('staff_controls').setLabel('Staff Controls').setStyle(ButtonStyle.Primary).setEmoji('🛠️')
  );
}
function staffControlsRows(claimed) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('staff_claim').setLabel(claimed ? 'Unclaim' : 'Claim').setStyle(claimed ? ButtonStyle.Secondary : ButtonStyle.Success).setEmoji(claimed ? '↩️' : '🙋'),
      new ButtonBuilder().setCustomId('staff_addmember').setLabel('Add').setStyle(ButtonStyle.Primary).setEmoji('➕'),
      new ButtonBuilder().setCustomId('staff_removemember').setLabel('Remove').setStyle(ButtonStyle.Primary).setEmoji('➖')
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('staff_delete').setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
    )
  ];
}

// =============================================================================
// ROLE PANELS
// =============================================================================
function newPanelId(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

async function postButtonPanel(guild, panel) {
  if (!panel.channelId) throw new Error('Select a channel first.');
  if (panel.enabled === false) throw new Error('Panel is disabled.');
  if (!(panel.buttons || []).length) throw new Error('Add at least one role.');
  const channel = guild.channels.cache.get(panel.channelId);
  if (!channel?.isTextBased()) throw new Error('Panel channel is unavailable.');
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('I need **Manage Roles**.');
  for (const b of panel.buttons) {
    const role = guild.roles.cache.get(b.roleId);
    if (!role) throw new Error(`Role ${b.roleId} no longer exists.`);
    if (role.position >= me.roles.highest.position) throw new Error(`I cannot manage ${role.name}.`);
  }
  const e = baseEmbed(guild.id, panel.title || 'Choose your roles').setDescription(panel.description || 'Click a button to get or remove a role.');
  if (panel.image) e.setImage(panel.image);
  const rows = [];
  for (let i = 0; i < panel.buttons.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const b of panel.buttons.slice(i, i + 5)) {
      row.addComponents(new ButtonBuilder().setCustomId(`rolebtn:${panel.id}:${b.roleId}`).setLabel((b.label || 'Role').slice(0, 80)).setStyle(ButtonStyle.Primary));
    }
    rows.push(row);
  }
  const msg = await channel.send({ embeds: [e], components: rows });
  db.upsertPanel(guild.id, 'button', { ...panel, messageId: msg.id });
  return msg;
}

// =============================================================================
// GIVEAWAYS
// =============================================================================
async function endGiveaway(client, guildId, giveawayId) {
  const g = db.getGiveaway(guildId, giveawayId);
  if (!g || g.status === 'ended' || g.status === 'cancelled') return null;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;

  let participants = [];
  try { participants = JSON.parse(g.participants || '[]'); } catch {}
  await guild.members.fetch({ user: participants.slice(0, 100) }).catch(() => {});
  const valid = participants.filter(id => guild.members.cache.has(id));

  const winners = [];
  const pool = [...valid];
  while (winners.length < g.winners && pool.length) {
    winners.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }

  db.updateGiveaway(guildId, g.id, { status: 'ended', winnerIds: JSON.stringify(winners) });

  const ch = g.channelId ? guild.channels.cache.get(g.channelId) : null;
  if (ch?.isTextBased()) {
    const text = winners.length
      ? `🎉 Giveaway ended! Winners for **${g.prize}**: ${winners.map(w => `<@${w}>`).join(', ')}`
      : `🎉 Giveaway for **${g.prize}** ended with no valid entries.`;
    await ch.send({ content: text, allowedMentions: { users: winners } }).catch(() => {});
  }
  return winners;
}

// =============================================================================
// SNIPE
// =============================================================================
function snipeEmbed(guildId, entry, index, total, requesterTag) {
  if (!entry) return infoEmbed(guildId, 'No snipes available.');
  const isEdit = entry.action === 'edit';
  const e = embed(guildId, isEdit ? 'warning' : 'error', {
    title: isEdit ? '✏️ Edited Message' : '🗑️ Deleted Message',
    description: entry.content ? String(entry.content).slice(0, 3900) : '*No text content cached*',
    fields: [
      { name: 'Author', value: `<@${entry.authorId}> (${entry.authorTag || 'unknown'})`, inline: true },
      { name: 'When', value: `<t:${Math.floor(entry.timestamp / 1000)}:R>`, inline: true },
      { name: 'Channel', value: `<#${entry.channelId}>`, inline: true }
    ]
  });
  if (isEdit && entry.newContent) e.addFields({ name: 'New content', value: String(entry.newContent).slice(0, 1024) });
  if (entry.attachments?.length) {
    e.addFields({ name: `Attachments (${entry.attachments.length})`, value: entry.attachments.slice(0, 5).map(a => `[${a.name}](${a.url})`).join('\n').slice(0, 1024) });
  }
  e.setFooter({ text: `Record ${index + 1}/${total} • Requested by ${requesterTag}` });
  return e;
}
function snipeComponents(guildId, channelId, index, total) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`snipe:nav:${guildId}:${channelId}:${index - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(index <= 0),
    new ButtonBuilder().setCustomId(`snipe:page:${guildId}:${channelId}:${index}`).setLabel(`${index + 1} / ${total}`).setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId(`snipe:nav:${guildId}:${channelId}:${index + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(index >= total - 1)
  )];
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
  for (const [name, bit] of required) {
    if (!me.permissions.has(bit)) issues.push({ severity: 'high', text: `Bot missing permission: **${name}**` });
  }

  const cfg = db.getConfig(guild.id);
  const checkChannel = (path, label) => {
    const val = path.split('.').reduce((a, k) => a?.[k], cfg);
    if (!val) return;
    if (!guild.channels.cache.has(val)) issues.push({ severity: 'medium', text: `${label} is configured but the channel no longer exists (\`${val}\`).` });
  };
  const checkRole = (path, label) => {
    const val = path.split('.').reduce((a, k) => a?.[k], cfg);
    if (!val) return;
    if (!guild.roles.cache.has(val)) issues.push({ severity: 'medium', text: `${label} is configured but the role no longer exists (\`${val}\`).` });
  };
  for (const k of LOG_KEYS) checkChannel(`logs.${k}`, `Log channel (${k})`);
  checkChannel('welcome.channel', 'Welcome channel');
  checkChannel('leave.channel', 'Leave channel');
  checkChannel('ticket.categoryId', 'Ticket category');
  checkRole('ticket.supportRoleId', 'Ticket support role');
  checkRole('staffApplications.acceptedRoleId', 'Staff accepted role');

  if (me.roles.highest.position <= 1) {
    issues.push({ severity: 'high', text: 'Bot role position is at the bottom — moderation will fail on almost all members.' });
  }
  return issues;
}

// =============================================================================
// AI (GROQ)
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
          method: 'POST',
          signal: ctrl.signal,
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
        const body = await res.text().catch(() => '');
        if (status === 401 || status === 403) throw new GroqError('ai_auth', 'Groq authentication failed.');
        if (status === 404) throw new GroqError('ai_model', 'Groq model or endpoint not found.');
        if (status === 429) { lastErr = new GroqError('ai_rate_limited', 'Groq rate-limited.', { retryable: true, status }); }
        else if (status >= 500) { lastErr = new GroqError('ai_provider', `Groq returned ${status}.`, { retryable: true, status }); }
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
// TEMPLATE GENERATOR (naming assets + wizard helpers)
// =============================================================================
const EMOJI_POOL = ['❄','🥮','🍂','🍁','💨','💢','🪵','☃️','⚡','🪢','🧶','♣️','♟','🎃','⚰️','💎','⚜️','🔱','♻️'];
const DIVIDERS = ['〢', '・', '┊', '┃', '┆', '︱'];
const NAMING_STYLES = ['emoji_divider', 'tree', 'decorative', 'emoji_decor', 'minimal', 'ai'];

function cleanChannelName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\- _]/gu, '')  // keep letters, numbers, hyphen, space, underscore
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90) || 'channel';
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

async function generateTemplate({ serverType, namingStyle, emojiMode, description = '', guildName = '' }) {
  const system = 'You are AunXz\'s Discord server template designer. Respond with STRICT JSON only. No prose, no code fences.';
  const user = `Design a Discord server structure.
Server name: ${guildName || 'the server'}
Server type: ${serverType}
Naming style: ${namingStyle}
Emoji mode: ${emojiMode === 'individual' ? 'a unique emoji per channel' : 'one consistent emoji per category'}
${description ? `User description: ${description}` : ''}

Return JSON matching:
{
  "categories": [
    { "name": string, "emoji": string (single char), "channels": [
      { "name": string, "type": "text"|"voice", "emoji": string, "topic": string }
    ] }
  ],
  "roles": [ { "name": string, "color": "#RRGGBB", "hoist": boolean } ]
}
Use 3-6 categories, 3-10 channels per category. Keep names short. No extra text.`;
  const { content } = await groqChat([
    { role: 'system', content: system },
    { role: 'user', content: user }
  ], { maxTokens: 2000, temperature: 0.4, jsonMode: true });
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed.categories)) throw new Error('AI returned malformed template.');
  return parsed;
}

// =============================================================================
// EXPORTS
// =============================================================================
module.exports = {
  THEME, OK, WARN, DANGER, INFO,
  emoji, embed, okEmbed, errEmbed, warnEmbed, infoEmbed, baseEmbed,
  applyTemplate,
  isOwner, isAdmin, isStaff, canModerate, missingChannelPerms,
  LOG_KEYS, logChannel, logEvent,
  moderate,
  runAutomod, refreshAutomod, getAutomodRules,
  findAuditExecutor, antinukeStrike,
  handleAntiraidJoin, handleAntiBotJoin, handleAntiAltJoin, handleAntiWebhookCreate,
  handleVoicemasterJoin, vmControlRows,
  xpForLevel, levelFromXp, handleLevelingMessage,
  ticketPanelEmbed, ticketPanelRow, ticketWelcomeEmbed, ticketControlRow, staffControlsRows,
  newPanelId, postButtonPanel,
  endGiveaway,
  snipeEmbed, snipeComponents,
  healthCheck,
  GroqError, groqChat,
  EMOJI_POOL, DIVIDERS, NAMING_STYLES, applyNaming, cleanChannelName,
  generateTemplate,
  pool
};