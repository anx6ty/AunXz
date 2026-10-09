'use strict';

// AFK tracking is durable in SQLite; snipe history is intentionally in-memory with a 24h TTL.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits
} = require('discord.js');
const db = require('./database');
const ui = require('./ui');

const AFK_PING_CAP = 15;
const SNIPE_TTL_MS = 24 * 60 * 60 * 1000;
const SNIPE_PER_CHANNEL_CAP = 50;
const AFK_BUTTON_TTL_MS = 60 * 1000;
const SNIPE_BUTTON_TTL_MS = 2 * 60 * 1000;
const snipeByChannel = new Map();
const activeAfkPanels = new Map();
const afkCache = new Map();
let afkCacheLoaded = false;
let cleanupTimer = null;

const silentMentions = { parse: [] };
const sql = db.db;

function canManageSnipe(interaction) {
  const permissions = interaction.member?.permissions;
  return Boolean(permissions?.has(PermissionFlagsBits.Administrator) || permissions?.has(PermissionFlagsBits.ManageMessages));
}

function safeText(value, max = 1500) {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function durationText(start, end = Date.now()) {
  let seconds = Math.max(0, Math.floor((end - Number(start || end)) / 1000));
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || parts.length) parts.push(`${hours}h`);
  if (minutes || parts.length) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function afkKey(userId, scope, guildId = '') {
  return `${String(userId)}:${scope}:${scope === 'global' ? '' : String(guildId || '')}`;
}

function hydrateAfkCache() {
  if (afkCacheLoaded) return;
  afkCache.clear();
  for (const row of sql.prepare('SELECT * FROM afk_entries').all()) {
    afkCache.set(afkKey(row.userId, row.scope, row.guildId), row);
  }
  afkCacheLoaded = true;
}

function setAfk(userId, scope, guildId, reason) {
  const id = scope === 'global' ? '' : String(guildId || '');
  if (scope === 'guild' && !id) throw new Error('Server AFK must be selected from inside a server.');
  const entry = { userId: String(userId), scope, guildId: id, reason: safeText(reason || 'No reason provided', 500), timestamp: Date.now() };
  sql.prepare(`INSERT INTO afk_entries(userId,scope,guildId,reason,timestamp) VALUES(?,?,?,?,?)
    ON CONFLICT(userId,scope,guildId) DO UPDATE SET reason=excluded.reason,timestamp=excluded.timestamp`)
    .run(entry.userId, entry.scope, entry.guildId, entry.reason, entry.timestamp);
  hydrateAfkCache();
  afkCache.set(afkKey(entry.userId, entry.scope, entry.guildId), entry);
  return entry;
}

function afkRecordsForUserInGuild(userId, guildId) {
  hydrateAfkCache();
  const rows = [];
  const local = afkCache.get(afkKey(userId, 'guild', guildId));
  const global = afkCache.get(afkKey(userId, 'global', ''));
  // Local scope takes precedence for notifications in this guild, but both records
  // are returned when the AFK user comes back so their entire applicable status clears.
  if (local) rows.push(local);
  if (global) rows.push(global);
  return rows;
}

function activeAfkForUserInGuild(userId, guildId) {
  const rows = afkRecordsForUserInGuild(userId, guildId);
  return rows.find(row => row.scope === 'guild') || rows.find(row => row.scope === 'global') || null;
}

function clearAfkRecords(rows) {
  if (!rows.length) return;
  const transaction = sql.transaction((items) => {
    for (const row of items) {
      sql.prepare('DELETE FROM afk_entries WHERE userId=? AND scope=? AND guildId=?').run(row.userId, row.scope, row.guildId);
      sql.prepare('DELETE FROM afk_pings WHERE afkUserId=? AND scope=? AND guildId=?').run(row.userId, row.scope, row.guildId);
    }
  });
  transaction(rows);
  hydrateAfkCache();
  for (const row of rows) afkCache.delete(afkKey(row.userId, row.scope, row.guildId));
}

function insertAfkPing(entry, pingerId, messageUrl) {
  const guildKey = entry.scope === 'global' ? '' : String(entry.guildId);
  sql.prepare('INSERT INTO afk_pings(afkUserId,scope,guildId,pingerId,messageUrl,timestamp) VALUES(?,?,?,?,?,?)')
    .run(entry.userId, entry.scope, guildKey, String(pingerId), String(messageUrl || ''), Date.now());
  sql.prepare(`DELETE FROM afk_pings WHERE afkUserId=? AND scope=? AND guildId=? AND id NOT IN
    (SELECT id FROM afk_pings WHERE afkUserId=? AND scope=? AND guildId=? ORDER BY timestamp DESC,id DESC LIMIT ?)`)
    .run(entry.userId, entry.scope, guildKey, entry.userId, entry.scope, guildKey, AFK_PING_CAP);
}

function pingsForRows(rows) {
  if (!rows.length) return [];
  const all = [];
  for (const row of rows) {
    all.push(...sql.prepare('SELECT * FROM afk_pings WHERE afkUserId=? AND scope=? AND guildId=? ORDER BY timestamp DESC,id DESC LIMIT ?')
      .all(row.userId, row.scope, row.guildId, AFK_PING_CAP));
  }
  const seen = new Set();
  return all.sort((a, b) => b.timestamp - a.timestamp).filter(p => {
    const key = `${p.messageUrl}:${p.pingerId}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, AFK_PING_CAP);
}

function buildAfkWelcomeBack(userId, rows, pings) {
  const oldest = rows.reduce((min, row) => Math.min(min, Number(row.timestamp || Date.now())), Date.now());
  let content = `Welcome back <@${userId}>!\nYou were AFK for ${durationText(oldest)}.`;
  if (!pings.length) content += '\nNo pings.';
  else {
    content += '\nPings:\n' + pings.map(p => `<@${p.pingerId}> • ${p.messageUrl || '(message link unavailable)'}`).join('\n');
  }
  return safeText(content, 1950);
}

async function sendSafeChannelMessage(channel, content) {
  if (!channel?.isTextBased?.() || !channel.send) return false;
  const me = channel.guild?.members?.me;
  if (me && !channel.permissionsFor?.(me)?.has(PermissionFlagsBits.SendMessages)) {
    console.warn(`[AFK] Cannot post in channel ${channel.id}: bot is missing Send Messages.`);
    return false;
  }
  try { await channel.send({ content: safeText(content, 1950), allowedMentions: silentMentions }); return true; }
  catch (error) { console.warn(`[AFK] Could not post in channel ${channel.id}:`, error?.message || error); return false; }
}

async function handleMessage(message) {
  if (!message || message.author?.bot || !message.guild || !message.channel) return;

  // A user's message clears the applicable AFK entries before scanning their mentions.
  const ownRows = afkRecordsForUserInGuild(message.author.id, message.guild.id);
  if (ownRows.length) {
    const pings = pingsForRows(ownRows);
    const content = buildAfkWelcomeBack(message.author.id, ownRows, pings);
    clearAfkRecords(ownRows);
    await sendSafeChannelMessage(message.channel, content);
  }

  const targets = new Map();
  for (const [id, user] of message.mentions?.users || []) {
    if (id !== message.author.id && !user.bot) targets.set(id, user);
  }
  if (message.reference?.messageId) {
    try {
      const referenced = await message.fetchReference();
      const user = referenced?.author;
      if (user && !user.bot && user.id !== message.author.id) targets.set(user.id, user);
    } catch { /* The reference may have been deleted or inaccessible; mentions still work. */ }
  }

  for (const [targetId] of targets) {
    // A global AFK should apply only in servers the AFK user actually belongs to.
    const member = message.guild.members.cache.get(targetId) || await message.guild.members.fetch(targetId).catch(() => null);
    if (!member) continue;
    const entry = activeAfkForUserInGuild(targetId, message.guild.id);
    if (!entry) continue;
    insertAfkPing(entry, message.author.id, message.url);
    await sendSafeChannelMessage(message.channel, `<@${targetId}> is AFK: ${safeText(entry.reason || 'No reason provided', 500)}`);
  }
}

function disabledComponents(rows) {
  return (rows || []).map(row => ({
    type: 1,
    components: (row.components || []).map(component => ({ ...component.toJSON(), disabled: true }))
  }));
}

async function afkCommand(interaction) {
  const reason = safeText(interaction.options.getString('reason') || 'No reason provided', 500);
  if (!interaction.guildId) return interaction.reply({ embeds: [ui.errorEmbed('Server Only', 'Run `/afk` from a server so you can choose your AFK scope.')], ephemeral: true });
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`afk-scope:${interaction.user.id}:global:${interaction.id}`).setLabel('Global AFK').setEmoji('🌍').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`afk-scope:${interaction.user.id}:guild:${interaction.id}`).setLabel('Server AFK').setEmoji('🏠').setStyle(ButtonStyle.Secondary)
  )];
  const panelKey = `${interaction.user.id}:${interaction.id}`;
  activeAfkPanels.set(panelKey, { userId: interaction.user.id, guildId: interaction.guildId, reason, expiresAt: Date.now() + AFK_BUTTON_TTL_MS });
  await interaction.reply({ embeds: [ui.base('💤 Set AFK').setDescription(`**Reason:** ${reason}\n\nChoose where your AFK status should apply.\n**Global AFK** works in every server where both you and AunXz are present.\n**Server AFK** works only in this server. Buttons expire in 60 seconds.`)], components: rows, ephemeral: true, allowedMentions: silentMentions });
  const timer = setTimeout(async () => {
    if (!activeAfkPanels.has(panelKey)) return;
    activeAfkPanels.delete(panelKey);
    await interaction.editReply({ embeds: [ui.base('💤 AFK Choice Expired').setDescription('Run `/afk` again to choose your AFK scope.')], components: disabledComponents(rows), allowedMentions: silentMentions }).catch(() => {});
  }, AFK_BUTTON_TTL_MS);
  timer.unref?.();
}

function channelEventKey(guildId, channelId) { return `${guildId}:${channelId}`; }
function trimSnipeCache(key) {
  const cutoff = Date.now() - SNIPE_TTL_MS;
  const rows = (snipeByChannel.get(key) || []).filter(row => row.timestamp >= cutoff).sort((a,b) => b.timestamp-a.timestamp).slice(0, SNIPE_PER_CHANNEL_CAP);
  if (rows.length) snipeByChannel.set(key, rows); else snipeByChannel.delete(key);
}
function cacheSnipe(row) {
  if (!row?.guildId || !row.channelId || !row.authorId || row.isBot) return;
  const key = channelEventKey(row.guildId, row.channelId);
  trimSnipeCache(key);
  const rows = snipeByChannel.get(key) || [];
  rows.unshift({ ...row, timestamp: Number(row.timestamp || Date.now()) });
  snipeByChannel.set(key, rows.slice(0, SNIPE_PER_CHANNEL_CAP));
}

async function ensureFullMessage(message) {
  if (!message) return null;
  if (message.partial && typeof message.fetch === 'function') return message.fetch().catch(() => message);
  return message;
}

async function recordDelete(message) {
  try {
    const full = await ensureFullMessage(message);
    const guild = full?.guild || message?.guild || message?.channel?.guild;
    const channel = full?.channel || message?.channel;
    if (!guild || !channel || !(full?.id || message?.id)) return;
    const author = full?.author || message?.author || null;
    if (author?.bot) return;
    const messageId = String(full?.id || message?.id);
    let previousUrl = null;
    const botMember = guild.members?.me;
    const canReadHistory = !botMember || Boolean(channel.permissionsFor?.(botMember)?.has(PermissionFlagsBits.ViewChannel) && channel.permissionsFor?.(botMember)?.has(PermissionFlagsBits.ReadMessageHistory));
    if (canReadHistory && channel.messages?.fetch) {
      const previous = await channel.messages.fetch({ before: messageId, limit: 1 }).catch(() => null);
      const beforeMessage = previous?.first?.();
      if (beforeMessage) previousUrl = beforeMessage.url || `https://discord.com/channels/${guild.id}/${channel.id}/${beforeMessage.id}`;
    }
    const attachments = [...(full?.attachments?.values?.() || message?.attachments?.values?.() || [])].map(a => a.url).filter(Boolean).slice(0, 5);
    const authorId = author?.id || 'unknown';
    const content = typeof full?.content === 'string' && full.content.length
      ? full.content
      : full?.partial || message?.partial || !author
        ? '(message details unavailable: Discord delivered a partial message event)'
        : '(no text content)';
    cacheSnipe({ type: 'deleted', guildId: guild.id, channelId: channel.id, messageId, authorId, isBot: Boolean(author?.bot), content: safeText(content, 5000), attachments, previousUrl, link: `https://discord.com/channels/${guild.id}/${channel.id}/${messageId}`, timestamp: Date.now(), createdTimestamp: full?.createdTimestamp || message?.createdTimestamp || 0 });
  } catch (error) { console.warn('[Snipe] Could not capture deleted message:', error?.message || error); }
}

async function recordUpdate(oldMessage, newMessage) {
  try {
    // Do not fetch the old partial: the REST fetch returns the already-edited version
    // and would erase the only chance to retain the event's before-state.
    const before = oldMessage || null;
    const after = await ensureFullMessage(newMessage);
    const guild = after?.guild || before?.guild || after?.channel?.guild;
    const channel = after?.channel || before?.channel;
    const author = after?.author || before?.author;
    if (!guild || !channel || !author || author.bot || !after?.id) return;
    const beforeWasPartial = Boolean(before?.partial);
    const beforeContent = typeof before?.content === 'string'
      ? before.content
      : beforeWasPartial ? '(before content unavailable: partial gateway event)' : '';
    const afterContent = String(after?.content || '');
    if (!beforeWasPartial && beforeContent === afterContent) return;
    cacheSnipe({
      type: 'edited', guildId: guild.id, channelId: channel.id, messageId: after.id,
      authorId: author.id, isBot: Boolean(author.bot),
      beforeContent: safeText(beforeContent, 5000), afterContent: safeText(afterContent, 5000),
      link: `https://discord.com/channels/${guild.id}/${channel.id}/${after.id}`,
      timestamp: Date.now(), createdTimestamp: after.createdTimestamp || before?.createdTimestamp || 0
    });
  } catch (error) { console.warn('[Snipe] Could not capture edited message:', error?.message || error); }
}

function getSnipeEvents(guildId, channelId) {
  const key = channelEventKey(guildId, channelId);
  trimSnipeCache(key);
  return [...(snipeByChannel.get(key) || [])].sort((a,b) => b.timestamp-a.timestamp);
}

function snipeEmbed(entry, page, total) {
  const channelMention = `<#${entry.channelId}>`;
  const when = `<t:${Math.floor(entry.timestamp / 1000)}:R>`;
  const embed = ui.base(entry.type === 'deleted' ? '🗑️ Deleted Message' : '✏️ Edited Message');
  const authorText = entry.authorId && entry.authorId !== 'unknown' ? `<@${entry.authorId}>` : 'Unknown user (partial event)';
  embed.setDescription(entry.type === 'deleted'
    ? `**Deleted:** ${authorText} deleted a message\n**Channel:** ${channelMention}\n**Message before it:** ${entry.previousUrl ? `[Jump to previous message](${entry.previousUrl})` : 'Unavailable'}\n\n**Content:**\n${safeText(entry.content || '(no text content)', 1400)}${entry.attachments?.length ? `\n\n**Attachments:**\n${entry.attachments.map((url,i)=>`[Attachment ${i+1}](${String(url).slice(0,500)})`).join(' • ')}` : ''}`
    : `**Edited:** ${authorText} edited a message\n**Channel:** ${channelMention}\n[Jump to message](${entry.link})\n\n**Before:**\n${safeText(entry.beforeContent || '(empty)', 900)}\n\n**Edited:**\n${safeText(entry.afterContent || '(empty)', 900)}`);
  embed.setFooter({ text: `Page ${page}/${total} • ${when} • Event time` });
  return embed;
}

function snipeRows(userId, channelId, page, total) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`snipe-page:${userId}:${channelId}:${page-1}`).setLabel('《').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`snipe-page:${userId}:${channelId}:indicator`).setLabel(`${page}/${total}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`snipe-page:${userId}:${channelId}:${page+1}`).setLabel('》').setStyle(ButtonStyle.Secondary).setDisabled(page >= total)
  )];
}

async function snipeCommand(interaction) {
  if (!interaction.guildId || !interaction.channelId) return interaction.reply({ embeds: [ui.errorEmbed('Server Only', 'Use `/snipe` inside a server text channel.')], ephemeral: true });
  if (!canManageSnipe(interaction)) return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Manage Messages** or **Administrator** to use `/snipe`.')], ephemeral: true });
  const entries = getSnipeEvents(interaction.guildId, interaction.channelId);
  if (!entries.length) return interaction.reply({ embeds: [ui.infoEmbed('Nothing to Snipe', 'No deleted or edited user messages have been recorded in this channel during the last 24 hours.')], ephemeral: true });
  const page = 1;
  const rows = snipeRows(interaction.user.id, interaction.channelId, page, entries.length);
  await interaction.reply({ embeds: [snipeEmbed(entries[0], page, entries.length)], components: rows, ephemeral: true, allowedMentions: silentMentions });
  const timer = setTimeout(async () => {
    try {
      const current = await interaction.fetchReply();
      const currentRows = current.components || rows;
      await interaction.editReply({ components: disabledComponents(currentRows), allowedMentions: silentMentions });
    } catch { /* The ephemeral reply may already have expired or been deleted. */ }
  }, SNIPE_BUTTON_TTL_MS);
  timer.unref?.();
}

async function handleInteraction(interaction) {
  const customId = String(interaction.customId || '');
  try {
    if (customId.startsWith('afk-scope:')) {
      const [, ownerId, scope, panelId] = customId.split(':');
      if (interaction.user.id !== ownerId) return interaction.reply({ embeds: [ui.errorEmbed('Not Your AFK Menu', 'Only the person who invoked `/afk` can choose its scope.')], ephemeral: true, allowedMentions: silentMentions });
      if (!['global','guild'].includes(scope)) return interaction.reply({ embeds: [ui.errorEmbed('Invalid AFK Scope', 'Run `/afk` again and choose a valid scope.')], ephemeral: true });
      if (scope === 'guild' && !interaction.guildId) return interaction.reply({ embeds: [ui.errorEmbed('Server AFK Unavailable', 'Server AFK must be selected inside a server.')], ephemeral: true });
      const panelKey = `${ownerId}:${panelId || ''}`;
      const panel = activeAfkPanels.get(panelKey);
      if (!panel || panel.expiresAt <= Date.now() || panel.guildId !== interaction.guildId) {
        return interaction.reply({ embeds: [ui.errorEmbed('AFK Menu Expired', 'Run `/afk` again to choose your AFK scope.')], ephemeral: true, allowedMentions: silentMentions });
      }
      await interaction.deferUpdate();
      try {
        setAfk(ownerId, scope, scope === 'global' ? '' : String(interaction.guildId), panel.reason);
        activeAfkPanels.delete(panelKey);
        await interaction.editReply({ embeds: [ui.okEmbed('💤 AFK Enabled', scope === 'global' ? `Your global AFK is active in every server where both you and AunXz are present.\n**Reason:** ${panel.reason}` : `Your AFK is active in **${interaction.guild.name}** only.\n**Reason:** ${panel.reason}`)], components: disabledComponents(interaction.message?.components || []), allowedMentions: silentMentions });
      } catch (error) {
        activeAfkPanels.delete(panelKey);
        await interaction.editReply({ embeds: [ui.errorEmbed('Could Not Set AFK', String(error?.message || error).slice(0,1000))], components: disabledComponents(interaction.message?.components || []), allowedMentions: silentMentions }).catch(() => {});
      }
      return true;
    }
    if (customId.startsWith('snipe-page:')) {
      const [, ownerId, channelId, rawPage] = customId.split(':');
      if (interaction.user.id !== ownerId) return interaction.reply({ embeds: [ui.errorEmbed('Not Your Snipe Panel', 'Only the person who ran `/snipe` can use these buttons.')], ephemeral: true, allowedMentions: silentMentions });
      if (interaction.guildId === null || !interaction.guildId) return interaction.reply({ embeds: [ui.errorEmbed('Server Only', 'This panel belongs to a server.')], ephemeral: true });
      if (!canManageSnipe(interaction)) return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Manage Messages** or **Administrator** to use `/snipe`.')], ephemeral: true });
      await interaction.deferUpdate();
      const entries = getSnipeEvents(interaction.guildId, channelId);
      if (!entries.length) return interaction.editReply({ embeds: [ui.infoEmbed('Nothing to Snipe', 'The snipe history expired or was cleared.')], components: [] });
      const total = entries.length;
      const page = Math.max(1, Math.min(total, Number(rawPage) || 1));
      return interaction.editReply({ embeds: [snipeEmbed(entries[page-1], page, total)], components: snipeRows(ownerId, channelId, page, total), allowedMentions: silentMentions });
    }
    return false;
  } catch (error) {
    console.error('[AFK/Snipe] Interaction failed:', error);
    const payload = { embeds: [ui.errorEmbed('Interaction Failed', safeText(error?.message || error, 1200))], ephemeral: true, allowedMentions: silentMentions };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
    return true;
  }
}

function start() {
  if (cleanupTimer) return;
  hydrateAfkCache();
  cleanupTimer = setInterval(() => {
    for (const key of snipeByChannel.keys()) trimSnipeCache(key);
    // AFK entries persist until the user speaks again; only inactive choice panels expire.
    for (const [key, session] of activeAfkPanels) if (session.expiresAt < Date.now()) activeAfkPanels.delete(key);
  }, 60 * 60 * 1000);
  cleanupTimer.unref?.();
}

module.exports = { afkCommand, snipeCommand, handleInteraction, handleMessage, recordDelete, recordUpdate, start, getSnipeEvents };
