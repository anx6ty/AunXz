'use strict';

// In-memory deleted-message history + rich server audit logging.
// Discord does not emit the moderator who deleted a message for ordinary users' own deletions;
// an actor is displayed only when a recent matching Audit Log entry can be verified.
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AuditLogEvent
} = require('discord.js');
const crypto = require('node:crypto');

const MAX_SNIPE_PER_CHANNEL = 100;
const MAX_SNAPSHOTS = 6000;
const RECENT_MESSAGES = new Map(); // messageId -> last observed content/details
const HISTORY = new Map(); // `${guildId}:${channelId}` -> newest-first deleted messages
const SESSIONS = new Map(); // random token -> command's private list of snipes
let attached = false;

function clip(value, max = 1024) {
  const s = String(value ?? '').trim();
  return s.length > max ? `${s.slice(0, max - 15)}… [truncated]` : (s || '—');
}
function cacheKey(guildId, channelId) { return `${guildId}:${channelId}`; }
function unix(ms) { return Math.floor(Number(ms || Date.now()) / 1000); }
function snapshot(message) {
  const author = message.author || message.member?.user || null;
  return {
    messageId: message.id,
    guildId: message.guildId || message.guild?.id || null,
    guildName: message.guild?.name || 'Unknown server',
    channelId: message.channelId || message.channel?.id || null,
    channelName: message.channel?.name || 'Unknown channel',
    authorId: author?.id || null,
    authorTag: author?.tag || author?.username || 'Unknown user',
    authorUsername: author?.username || 'Unknown user',
    avatarURL: author?.displayAvatarURL?.({ extension: 'png', size: 256 }) || null,
    content: String(message.content || ''),
    createdAt: Number(message.createdTimestamp || message.createdAt?.getTime?.() || Date.now()),
    attachments: [...(message.attachments?.values?.() || [])].map(a => ({
      name: a.name || 'attachment', url: a.url || a.proxyURL || null,
      proxyURL: a.proxyURL || a.url || null, contentType: a.contentType || null, size: a.size || null
    })).slice(0, 10),
    webhookId: message.webhookId || null
  };
}
function rememberMessage(message) {
  if (!message?.id || !message?.guild || message.author?.bot) return;
  const s = snapshot(message);
  RECENT_MESSAGES.set(s.messageId, s);
  if (RECENT_MESSAGES.size > MAX_SNAPSHOTS) {
    const removeCount = RECENT_MESSAGES.size - MAX_SNAPSHOTS;
    let removed = 0;
    for (const key of RECENT_MESSAGES.keys()) {
      RECENT_MESSAGES.delete(key);
      if (++removed >= removeCount) break;
    }
  }
}
function storeSnipe(entry) {
  if (!entry.guildId || !entry.channelId || !entry.messageId) return;
  const key = cacheKey(entry.guildId, entry.channelId);
  const history = HISTORY.get(key) || [];
  const next = [entry, ...history.filter(x => x.messageId !== entry.messageId)].slice(0, MAX_SNIPE_PER_CHANNEL);
  HISTORY.set(key, next);
}
function getSnipes(guildId, channelId) {
  return [...(HISTORY.get(cacheKey(guildId, channelId)) || [])];
}
function removeSnipe(guildId, channelId, messageId) {
  const key = cacheKey(guildId, channelId);
  const before = HISTORY.get(key) || [];
  const after = before.filter(x => x.messageId !== messageId);
  if (after.length) HISTORY.set(key, after); else HISTORY.delete(key);
  return after.length !== before.length;
}
function getLogChannel(guild, db, sys, key) {
  try { return sys.getLogChannel(guild, key); } catch { return null; }
}
async function sendLog(guild, db, sys, embed, key = 'message') {
  try {
    const channel = await getLogChannel(guild, db, sys, key);
    if (!channel?.isTextBased()) {
      console.warn(`[Log] No usable ${key} log channel configured for guild ${guild.id}. Configure it with /logs setup.`);
      return false;
    }
    await channel.send({ embeds: [embed] });
    return true;
  } catch (error) {
    console.error(`[Log] Failed to send ${key} log for guild ${guild?.id}:`, error?.stack || error);
    return false;
  }
}
async function findDeleteActor(guild, entry, channelId) {
  try {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 8 });
    const now = Date.now();
    const match = [...logs.entries.values()]
      .filter(row => row.target?.id === entry.authorId && row.extra?.channel?.id === channelId && Math.abs(now - row.createdTimestamp) <= 7000)
      .sort((a, b) => Math.abs(now - a.createdTimestamp) - Math.abs(now - b.createdTimestamp))[0];
    return match?.executor || null;
  } catch (error) {
    console.warn(`[Log] Could not resolve message-delete actor in guild ${guild.id}: ${error?.message || error}`);
    return null;
  }
}
function messageLogEmbed(entry, title, actorLabel) {
  const embed = new EmbedBuilder().setColor(title.includes('Deleted') ? 0xED4245 : 0xFEE75C)
    .setTitle(title)
    .addFields(
      { name: 'Message Author', value: `${entry.authorId ? `<@${entry.authorId}>` : 'Unknown'}\n${clip(entry.authorTag, 180)}\nID: \`${entry.authorId || 'unknown'}\``, inline: true },
      { name: 'Channel', value: `${entry.channelId ? `<#${entry.channelId}>` : 'Unknown'}\n\`${entry.channelId || 'unknown'}\``, inline: true },
      { name: title.includes('Deleted') ? 'Deleted By' : 'Edited By', value: clip(actorLabel || 'Unknown', 300), inline: true },
      { name: 'Message Sent', value: `<t:${unix(entry.createdAt)}:F>\n<t:${unix(entry.createdAt)}:R>`, inline: true },
      { name: title.includes('Deleted') ? 'Deleted At' : 'Edited At', value: `<t:${unix(entry.deletedAt || entry.editedAt)}:F>\n<t:${unix(entry.deletedAt || entry.editedAt)}:R>`, inline: true },
      { name: 'Message ID', value: `\`${entry.messageId}\``, inline: true },
      { name: 'Message Content', value: clip(entry.content || '(no text content)', 1024), inline: false }
    );
  if (entry.attachments?.length) {
    const links = entry.attachments.slice(0, 5).map(a => `[${clip(a.name, 80)}](${a.url || a.proxyURL})${a.size ? ` (${Math.ceil(a.size / 1024)} KB)` : ''}`).join('\n');
    embed.addFields({ name: `Attachments (${entry.attachments.length})`, value: clip(links || 'Attachment URL unavailable', 1024), inline: false });
    const image = entry.attachments.find(a => String(a.contentType || '').startsWith('image/'));
    if (image?.proxyURL || image?.url) embed.setThumbnail(image.proxyURL || image.url);
  }
  embed.setFooter({ text: `AunXz message logging • ${entry.guildName}` }).setTimestamp(new Date(entry.deletedAt || entry.editedAt || Date.now()));
  return embed;
}
function snipeEmbed(entry, index, total, requesterTag) {
  const ago = `<t:${unix(entry.deletedAt)}:R>`;
  const content = entry.content ? clip(entry.content, 3900) : '*No text content*';
  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('Sniped Message')
    .setDescription(`▶ **${clip(entry.authorTag, 180)}** — Deleted ${ago}\n\n${content}`)
    .setFooter({ text: `Page ${index + 1}/${total} | Requested by ${clip(requesterTag, 200)}` })
    .setTimestamp(new Date(entry.deletedAt || Date.now()));
  if (entry.avatarURL) embed.setAuthor({ name: entry.authorTag || 'Unknown user', iconURL: entry.avatarURL });
  const image = entry.attachments?.find(a => String(a.contentType || '').startsWith('image/') || /\.(png|jpe?g|gif|webp)(?:\?|$)/i.test(a.url || ''));
  if (image?.proxyURL || image?.url) embed.setThumbnail(image.proxyURL || image.url);
  else if (entry.avatarURL) embed.setThumbnail(entry.avatarURL);
  if (entry.attachments?.length) {
    const files = entry.attachments.slice(0, 5).map(a => `[${clip(a.name, 80)}](${a.url || a.proxyURL})`).join(' • ');
    embed.addFields({ name: 'Attachments', value: clip(files, 1024), inline: false });
  }
  return embed;
}
function snipeComponents(session) {
  const total = session.items.length;
  const make = (action, label, disabled = false, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`snipe:${session.token}:${action}`).setLabel(label).setStyle(style).setDisabled(disabled);
  return [new ActionRowBuilder().addComponents(
    make('prev', '〈', session.index <= 0),
    make('remove', '🗑', total <= 0, ButtonStyle.Danger),
    make('next', '〉', session.index >= total - 1),
    make('sort', session.oldestFirst ? '↓' : '↑', total <= 1),
    make('page', `${Math.min(session.index + 1, Math.max(total, 1))}/${Math.max(total, 1)}`, true)
  )];
}
function snipePayload(session) {
  if (!session.items.length) return { content: 'There are no more deleted messages in this channel.', embeds: [], components: [] };
  session.index = Math.max(0, Math.min(session.index, session.items.length - 1));
  return { content: '', embeds: [snipeEmbed(session.items[session.index], session.index, session.items.length, session.requesterTag)], components: snipeComponents(session) };
}

function startSession(session) {
  session.token = session.token || crypto.randomBytes(6).toString('hex');
  SESSIONS.set(session.token, session);
  const timer = setTimeout(() => SESSIONS.delete(session.token), 120000);
  timer.unref?.();
  return session.token;
}
function createSnipePayload(session) { return snipePayload(session); }

async function handleInteraction(interaction) {
  if (!interaction.isButton?.() || !String(interaction.customId || '').startsWith('snipe:')) return false;
  const [, token, action] = interaction.customId.split(':');
  const session = SESSIONS.get(token);
  if (!session) {
    await interaction.reply({ content: 'This snipe session expired or the bot restarted. Run `/snipe` again.', ephemeral: true }).catch(() => {});
    return true;
  }
  if (interaction.user.id !== session.userId) {
    await interaction.reply({ content: 'Only the person who opened this snipe list can use these buttons.', ephemeral: true }).catch(() => {});
    return true;
  }
  try { await interaction.deferUpdate(); } catch (error) { return true; }
  if (action === 'prev') session.index = Math.max(0, session.index - 1);
  else if (action === 'next') session.index = Math.min(session.items.length - 1, session.index + 1);
  else if (action === 'sort') {
    session.oldestFirst = !session.oldestFirst;
    session.items.reverse();
    session.index = 0;
  } else if (action === 'remove') {
    const current = session.items[session.index];
    if (current) removeSnipe(session.guildId, session.channelId, current.messageId);
    session.items.splice(session.index, 1);
    if (session.index >= session.items.length) session.index = Math.max(0, session.items.length - 1);
  }
  if (!session.items.length) SESSIONS.delete(token);
  await interaction.editReply(snipePayload(session)).catch(async error => {
    console.warn('[Snipe] button update failed:', error?.message || error);
    await interaction.followUp({ content: 'Could not update this snipe page. Run `/snipe` again.', ephemeral: true }).catch(() => {});
  });
  return true;
}

function attach(client, { db, sys } = {}) {
  if (attached) return;
  attached = true;
  client.on('messageCreate', message => {
    try { rememberMessage(message); } catch (error) { console.warn('[Snipe] failed to cache message:', error?.message || error); }
  });

  client.on('messageDelete', async message => {
    const guild = message.guild || (message.guildId ? client.guilds.cache.get(message.guildId) : null);
    if (!guild) return;
    const cached = RECENT_MESSAGES.get(message.id);
    const now = Date.now();
    const live = snapshot(message);
    const entry = { ...(cached || live), ...(!message.partial ? live : {}), deletedAt: now };
    if (!entry.content && cached?.content) entry.content = cached.content;
    if ((!entry.attachments || !entry.attachments.length) && cached?.attachments?.length) entry.attachments = cached.attachments;
    if (!entry.authorId && cached?.authorId) entry.authorId = cached.authorId;
    storeSnipe(entry);
    RECENT_MESSAGES.delete(message.id);

    const actor = await findDeleteActor(guild, entry, entry.channelId);
    const actorLabel = actor ? `${actor.tag || actor.username} (<@${actor.id}>) • confirmed by Audit Log` : 'Unknown — Discord does not expose self-deletes; check audit-log permissions for moderator deletions.';
    const embed = messageLogEmbed(entry, 'Message Deleted', actorLabel);
    await sendLog(guild, db, sys, embed, 'message');
  });

  client.on('messageDeleteBulk', async (messages, channel) => {
    const guild = channel?.guild;
    if (!guild) return;
    const records = [...messages.values()].map(m => {
      const cached = RECENT_MESSAGES.get(m.id);
      const live = snapshot(m);
      const entry = { ...(cached || live), ...(!m.partial ? live : {}), deletedAt: Date.now() };
      if (!entry.content && cached?.content) entry.content = cached.content;
      storeSnipe(entry);
      RECENT_MESSAGES.delete(m.id);
      return entry;
    });
    const embed = new EmbedBuilder().setColor(0xED4245).setTitle('Bulk Message Delete')
      .setDescription(`**Messages deleted:** ${records.length}\n**Channel:** ${channel}\n**Channel ID:** \`${channel.id}\`\n**Deleted at:** <t:${unix(Date.now())}:F>`)
      .addFields({ name: 'Sample of deleted messages', value: clip(records.slice(0, 5).map(r => `**${r.authorTag}:** ${r.content || '(no text)'}`).join('\n'), 1024) })
      .setFooter({ text: 'Actor is not reported unless verified from the Audit Log.' }).setTimestamp();
    await sendLog(guild, db, sys, embed, 'message');
  });

  client.on('messageUpdate', async (oldMessage, newMessage) => {
    const guild = newMessage.guild || oldMessage.guild;
    if (!guild) return;
    const cached = RECENT_MESSAGES.get(newMessage.id);
    const oldContent = String(oldMessage.content || cached?.content || '');
    const current = snapshot(newMessage);
    if (oldMessage.partial && !cached && !oldContent && !current.content) { rememberMessage(newMessage); return; }
    if (oldContent === current.content) { rememberMessage(newMessage); return; }
    current.editedAt = Date.now();
    current.beforeContent = oldContent;
    const embed = new EmbedBuilder().setColor(0xFEE75C).setTitle('Message Edited')
      .addFields(
        { name: 'Author', value: `${current.authorId ? `<@${current.authorId}>` : current.authorTag}\n\`${current.authorId || 'unknown'}\``, inline: true },
        { name: 'Channel', value: `${current.channelId ? `<#${current.channelId}>` : 'Unknown'}\n\`${current.channelId || 'unknown'}\``, inline: true },
        { name: 'Sent at', value: `<t:${unix(current.createdAt)}:F>`, inline: true },
        { name: 'Before', value: clip(oldContent || '(no text content)', 1024), inline: false },
        { name: 'After', value: clip(current.content || '(no text content)', 1024), inline: false },
        { name: 'Message ID', value: `\`${current.messageId}\``, inline: true },
        { name: 'Edited at', value: `<t:${unix(current.editedAt)}:F> • <t:${unix(current.editedAt)}:R>`, inline: true }
      ).setFooter({ text: `Message edit logging • ${current.guildName}` }).setTimestamp();
    await sendLog(guild, db, sys, embed, 'message');
    rememberMessage(newMessage);
  });

  // Server structure logs complement the dedicated antinuke security events.
  client.on('channelCreate', channel => logStructure(channel.guild, db, sys, 'Channel Created', `**Channel:** ${channel}\n**Name:** ${channel.name}\n**Type:** ${channel.type}\n**ID:** \`${channel.id}\``, 0x57F287));
  client.on('channelDelete', channel => logStructure(channel.guild, db, sys, 'Channel Deleted', `**Name:** ${channel.name}\n**Type:** ${channel.type}\n**ID:** \`${channel.id}\`\n**Deleted at:** <t:${unix(Date.now())}:F>`, 0xED4245));
  client.on('channelUpdate', (before, after) => {
    const changes = [];
    for (const [key, label] of [['name','Name'], ['topic','Topic'], ['nsfw','NSFW'], ['rateLimitPerUser','Slowmode'], ['parentId','Category']]) {
      if (before[key] !== after[key]) changes.push(`**${label}:** ${clip(before[key] ?? 'None', 300)} → ${clip(after[key] ?? 'None', 300)}`);
    }
    if (changes.length) logStructure(after.guild, db, sys, 'Channel Updated', `**Channel:** ${after}\n**ID:** \`${after.id}\`\n${changes.join('\n')}`, 0xFEE75C);
  });
  client.on('roleCreate', role => logStructure(role.guild, db, sys, 'Role Created', `**Role:** ${role}\n**Name:** ${role.name}\n**ID:** \`${role.id}\`\n**Color:** \`${role.hexColor}\`\n**Position:** ${role.position}`, 0x57F287));
  client.on('roleDelete', role => logStructure(role.guild, db, sys, 'Role Deleted', `**Name:** ${role.name}\n**ID:** \`${role.id}\`\n**Color:** \`${role.hexColor}\`\n**Deleted at:** <t:${unix(Date.now())}:F>`, 0xED4245));
  client.on('roleUpdate', (before, after) => {
    const changes = [];
    for (const [key, label] of [['name','Name'], ['hexColor','Color'], ['hoist','Hoisted'], ['mentionable','Mentionable'], ['position','Position']]) {
      if (before[key] !== after[key]) changes.push(`**${label}:** ${clip(before[key] ?? 'None', 200)} → ${clip(after[key] ?? 'None', 200)}`);
    }
    if (before.permissions.bitfield !== after.permissions.bitfield) changes.push('**Permissions:** changed');
    if (changes.length) logStructure(after.guild, db, sys, 'Role Updated', `**Role:** ${after}\n**ID:** \`${after.id}\`\n${changes.join('\n')}`, 0xFEE75C);
  });
  client.on('guildUpdate', (before, after) => {
    const changes = [];
    for (const [key, label] of [['name','Name'], ['description','Description'], ['verificationLevel','Verification Level'], ['explicitContentFilter','Content Filter'], ['preferredLocale','Locale']]) {
      if (before[key] !== after[key]) changes.push(`**${label}:** ${clip(before[key] ?? 'None', 300)} → ${clip(after[key] ?? 'None', 300)}`);
    }
    if (before.icon !== after.icon) changes.push('**Icon:** changed');
    if (changes.length) logStructure(after, db, sys, 'Server Updated', `**Server ID:** \`${after.id}\`\n${changes.join('\n')}`, 0xFEE75C);
  });
}
async function logStructure(guild, db, sys, title, description, color) {
  if (!guild) return;
  const embed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(clip(description, 4000)).setTimestamp().setFooter({ text: `Server audit • ${guild.name}` });
  await sendLog(guild, db, sys, embed, 'server');
}

module.exports = { attach, handleInteraction, getSnipes, removeSnipe, createSnipePayload, startSession, getRecentMessageCount: () => RECENT_MESSAGES.size };
