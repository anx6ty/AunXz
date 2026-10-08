'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const db = require('./database');

const REFRESH_MIN_SECONDS = 60;
const REFRESH_MAX_SECONDS = 86400;
const DEFAULT_REFRESH_SECONDS = 300;

const EVERYONE_DENY = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.Stream,
  PermissionFlagsBits.UseVAD,
  PermissionFlagsBits.PrioritySpeaker,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.CreateInstantInvite,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.SendTTSMessages,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.UseApplicationCommands,
  PermissionFlagsBits.UseEmbeddedActivities,
  PermissionFlagsBits.UseExternalSounds,
  PermissionFlagsBits.UseSoundboard
].filter(Boolean);

const SERVER_DEFS = {
  members: { name: 'Server Members', defaultTemplate: '👥・Members: {value}', getter: 'members' },
  humans: { name: 'Human Members', defaultTemplate: '🧑・Humans: {value}', getter: 'humans' },
  bots: { name: 'Bots', defaultTemplate: '🤖・Bots: {value}', getter: 'bots' },
  staff: { name: 'Staff (Administrator)', defaultTemplate: '🛡️・Staff: {value}', getter: 'staff' },
  online: { name: 'Online Members', defaultTemplate: '🟢・Online: {value}', getter: 'online' },
  channels: { name: 'All Channels', defaultTemplate: '📚・Channels: {value}', getter: 'channels' },
  textChannels: { name: 'Text Channels', defaultTemplate: '💬・Text: {value}', getter: 'textChannels' },
  voiceChannels: { name: 'Voice Channels', defaultTemplate: '🔊・Voice: {value}', getter: 'voiceChannels' },
  categories: { name: 'Categories', defaultTemplate: '🗂️・Categories: {value}', getter: 'categories' },
  roles: { name: 'Roles', defaultTemplate: '🎭・Roles: {value}', getter: 'roles' },
  boosts: { name: 'Server Boosts', defaultTemplate: '🚀・Boosts: {value}', getter: 'boosts' },
  inVoice: { name: 'Members in Voice', defaultTemplate: '🎧・In Voice: {value}', getter: 'inVoice' }
};

const SOCIAL_DEFS = {
  youtube: {
    name: 'YouTube',
    defaultTemplate: '▶️・YouTube: {subscribers}',
    sourceHint: 'Channel ID, /channel/UC..., or @handle',
    fields: ['subscribers', 'views', 'videos']
  },
  tiktok: {
    name: 'TikTok',
    defaultTemplate: '🎵・TikTok: {followers}',
    sourceHint: '@username or username connected to the TikTok access token',
    fields: ['followers', 'likes', 'videos']
  },
  x: {
    name: 'Twitter / X',
    defaultTemplate: '𝕏・X: {followers}',
    sourceHint: '@username, username, or x.com/username',
    fields: ['followers', 'following', 'posts']
  },
  instagram: {
    name: 'Instagram',
    defaultTemplate: '📸・Instagram: {followers}',
    sourceHint: 'Instagram user ID or `me` for the token owner',
    fields: ['followers', 'following', 'media']
  }
};

function clampRefresh(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_REFRESH_SECONDS;
  return Math.max(REFRESH_MIN_SECONDS, Math.min(REFRESH_MAX_SECONDS, Math.floor(n)));
}

function cleanTemplate(template, fallback) {
  const value = String(template || '').trim();
  return (value || fallback || '{value}').slice(0, 100);
}

function normalizeStatEntry(entry, fallback) {
  return {
    enabled: Boolean(entry?.enabled),
    source: entry?.source ? String(entry.source).trim().slice(0, 200) : '',
    template: cleanTemplate(entry?.template, fallback),
    channelId: entry?.channelId || null,
    refreshSeconds: clampRefresh(entry?.refreshSeconds),
    lastUpdated: Number(entry?.lastUpdated || 0),
    lastError: entry?.lastError ? String(entry.lastError).slice(0, 300) : null
  };
}

function normalizeStatsConfig(stats) {
  const raw = stats || {};
  const server = {};
  const social = {};
  for (const [key, def] of Object.entries(SERVER_DEFS)) server[key] = normalizeStatEntry(raw.server?.[key], def.defaultTemplate);
  for (const [key, def] of Object.entries(SOCIAL_DEFS)) social[key] = normalizeStatEntry(raw.social?.[key], def.defaultTemplate);
  return {
    enabled: Boolean(raw.enabled),
    categoryId: raw.categoryId || null,
    categoryName: String(raw.categoryName || '📊・server-stats').slice(0, 100),
    refreshSeconds: clampRefresh(raw.refreshSeconds),
    server,
    social,
    custom: Array.isArray(raw.custom) ? raw.custom.map(x => ({
      id: String(x.id || `custom_${Date.now()}`),
      name: String(x.name || 'Custom Stat').slice(0, 60),
      source: String(x.source || 'manual').slice(0, 200),
      value: String(x.value ?? '0').slice(0, 100),
      enabled: Boolean(x.enabled),
      template: cleanTemplate(x.template, '{value}'),
      channelId: x.channelId || null,
      refreshSeconds: clampRefresh(x.refreshSeconds),
      lastUpdated: Number(x.lastUpdated || 0),
      lastError: x.lastError ? String(x.lastError).slice(0, 300) : null
    })) : []
  };
}

function readStats(guildId) {
  return normalizeStatsConfig(db.getConfig(guildId).stats);
}

function saveStats(guildId, stats) {
  return db.saveConfig(guildId, { stats: normalizeStatsConfig(stats) }).stats;
}

function getDefaultTemplate(category, key) {
  if (category === 'server') return SERVER_DEFS[key]?.defaultTemplate || '{value}';
  if (category === 'social') return SOCIAL_DEFS[key]?.defaultTemplate || '{value}';
  return '{value}';
}

function enabledStatsCount(stats) {
  const cfg = normalizeStatsConfig(stats);
  return [
    ...Object.values(cfg.server),
    ...Object.values(cfg.social),
    ...cfg.custom
  ].filter(x => x.enabled).length;
}

function getStat(guildId, category, key) {
  const cfg = readStats(guildId);
  if (category === 'server') return cfg.server[key] || null;
  if (category === 'social') return cfg.social[key] || null;
  return cfg.custom.find(x => x.id === key) || null;
}

async function fetchJson(url, options = {}) {
  const { headers = {}, ...rest } = options;
  const response = await fetch(url, { ...rest, headers: { Accept: 'application/json', ...headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.error?.message || body?.error?.description || body?.message || `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return body;
}

function extractUsername(source) {
  return String(source || '')
    .trim()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/^[@#]/, '')
    .replace(/^youtube\.com\/@/i, '')
    .replace(/^twitter\.com\//i, '')
    .replace(/^x\.com\//i, '')
    .replace(/^tiktok\.com\/@/i, '')
    .replace(/^instagram\.com\//i, '')
    .split(/[/?#]/)[0]
    .trim();
}

async function fetchYouTube(source) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error('YouTube is not connected. Add YOUTUBE_API_KEY in Railway variables.');
  const raw = String(source || '').trim();
  let query;
  if (/^UC[\w-]{10,}$/i.test(raw)) query = `id=${encodeURIComponent(raw)}`;
  else if (/youtube\.com\/channel\//i.test(raw)) query = `id=${encodeURIComponent(raw.split('/channel/')[1].split(/[/?#]/)[0])}`;
  else query = `forHandle=${encodeURIComponent(raw.replace(/^@/, '').replace(/^.*youtube\.com\/@/i, '').split(/[/?#]/)[0])}`;
  const body = await fetchJson(`https://www.googleapis.com/youtube/v3/channels?part=statistics&${query}&key=${encodeURIComponent(key)}`);
  const item = body.items?.[0];
  if (!item) throw new Error('YouTube channel was not found.');
  const s = item.statistics || {};
  return { subscribers: Number(s.subscriberCount || 0), views: Number(s.viewCount || 0), videos: Number(s.videoCount || 0) };
}

async function fetchTikTok(source) {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  if (!token) throw new Error('TikTok is not connected. Add TIKTOK_ACCESS_TOKEN in Railway variables.');
  const fields = 'open_id,username,follower_count,following_count,likes_count,video_count';
  const body = await fetchJson(`https://open.tiktokapis.com/v2/user/info/?fields=${fields}`, { headers: { Authorization: `Bearer ${token}` } });
  const user = body.data?.user;
  if (!user) throw new Error('TikTok returned no connected user. Re-authorize the TikTok Display API account.');
  const requested = extractUsername(source);
  if (requested && !['me', 'self'].includes(requested.toLowerCase()) && requested.toLowerCase() !== String(user.username || '').toLowerCase()) {
    throw new Error(`The current TikTok token belongs to @${user.username || 'another account'}, not @${requested}.`);
  }
  return {
    followers: Number(user.follower_count || 0),
    likes: Number(user.likes_count || 0),
    videos: Number(user.video_count || 0)
  };
}

async function fetchX(source) {
  const token = process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN;
  if (!token) throw new Error('X/Twitter is not connected. Add X_BEARER_TOKEN in Railway variables.');
  const username = extractUsername(source);
  if (!username) throw new Error('Enter an X/Twitter username.');
  const body = await fetchJson(`https://api.x.com/2/users/by/username/${encodeURIComponent(username)}?user.fields=public_metrics`, { headers: { Authorization: `Bearer ${token}` } });
  const metrics = body.data?.public_metrics;
  if (!metrics) throw new Error('X/Twitter user was not found.');
  return {
    followers: Number(metrics.followers_count || 0),
    following: Number(metrics.following_count || 0),
    posts: Number(metrics.tweet_count || 0)
  };
}

async function fetchInstagram(source) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) throw new Error('Instagram is not connected. Add INSTAGRAM_ACCESS_TOKEN in Railway variables.');
  const raw = String(source || 'me').trim();
  const target = ['me', 'self'].includes(raw.toLowerCase()) ? 'me' : raw.replace(/^.*instagram\.com\//i, '').split(/[/?#]/)[0];
  if (!/^\d+$/.test(target) && target !== 'me') {
    throw new Error('For Instagram, use `me` or the numeric Instagram user ID supported by your access token.');
  }
  const version = process.env.INSTAGRAM_GRAPH_VERSION || 'v23.0';
  const body = await fetchJson(`https://graph.instagram.com/${version}/${target}?fields=username,followers_count,follows_count,media_count&access_token=${encodeURIComponent(token)}`);
  return {
    followers: Number(body.followers_count || 0),
    following: Number(body.follows_count || 0),
    media: Number(body.media_count || 0)
  };
}

async function fetchSocial(platform, source) {
  if (platform === 'youtube') return fetchYouTube(source);
  if (platform === 'tiktok') return fetchTikTok(source);
  if (platform === 'x') return fetchX(source);
  if (platform === 'instagram') return fetchInstagram(source);
  throw new Error('Unknown social platform.');
}

async function fetchServer(guild) {
  await guild.members.fetch().catch(() => null);
  const members = guild.members.cache;
  const bots = members.filter(m => m.user.bot).size;
  const humans = Math.max(0, Number(guild.memberCount || members.size) - bots);
  const staff = members.filter(m => !m.user.bot && m.permissions.has(PermissionFlagsBits.Administrator)).size;
  const online = members.filter(m => m.presence && m.presence.status !== 'offline').size;
  const channels = guild.channels.cache;
  const textChannels = channels.filter(c => [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(c.type)).size;
  const voiceChannels = channels.filter(c => [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(c.type)).size;
  const categories = channels.filter(c => c.type === ChannelType.GuildCategory).size;
  const roles = Math.max(0, guild.roles.cache.size - 1);
  let inVoice = 0;
  for (const state of guild.voiceStates.cache.values()) if (state.channelId) inVoice++;
  return {
    members: Number(guild.memberCount || members.size),
    humans,
    bots,
    staff,
    online,
    channels: channels.size,
    textChannels,
    voiceChannels,
    categories,
    roles,
    boosts: Number(guild.premiumSubscriptionCount || 0),
    inVoice
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(Number(value || 0));
}

function templateReplace(template, values) {
  let out = String(template || '{value}');
  const source = { ...values };
  if (source.value !== undefined) source.value = formatNumber(source.value);
  const aliases = {
    subcount: 'subscribers', subscriberscount: 'subscribers', subscriber: 'subscribers', subscriber_count: 'subscribers',
    follower: 'followers', followerscount: 'followers', followingcount: 'following', like: 'likes', likescount: 'likes',
    videocount: 'videos', viewcount: 'views', membercount: 'members', usercount: 'members', botcount: 'bots', staffcount: 'staff',
    onlinecount: 'online', channelcount: 'channels', textcount: 'textChannels', voicecount: 'voiceChannels', boostcount: 'boosts'
  };
  for (const [alias, key] of Object.entries(aliases)) if (source[key] !== undefined) source[alias] = source[key];
  if (source.name === undefined && source.label !== undefined) source.name = source.label;
  for (const [key, value] of Object.entries(source)) {
    const rendered = String(value ?? 0);
    out = out.replace(new RegExp(`\\{${key}\\}`, 'gi'), rendered);
    out = out.replace(new RegExp(`<${key}>`, 'gi'), rendered);
  }
  return out.slice(0, 100);
}

function serverTemplateValues(values) {
  return { ...values, value: values.value };
}

async function ensureCategory(guild, stats) {
  let category = stats.categoryId ? guild.channels.cache.get(stats.categoryId) : null;
  if (!category || category.type !== ChannelType.GuildCategory) {
    category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === stats.categoryName) || null;
  }
  if (!category) {
    category = await guild.channels.create({
      name: stats.categoryName,
      type: ChannelType.GuildCategory,
      permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }]
    });
  }
  if (stats.categoryId !== category.id) {
    stats.categoryId = category.id;
    await saveStats(guild.id, stats);
  }
  return category;
}

async function ensureStatChannel(guild, category, entry, displayName) {
  let channel = entry.channelId ? guild.channels.cache.get(entry.channelId) : null;
  if (!channel || channel.type !== ChannelType.GuildVoice) channel = null;
  if (!channel) {
    channel = await guild.channels.create({
      name: displayName,
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: EVERYONE_DENY },
        { id: guild.members.me?.id || guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels] }
      ]
    });
  } else {
    await channel.setParent(category.id).catch(() => {});
    await channel.permissionOverwrites.edit(guild.roles.everyone.id, { ViewChannel: false, Connect: false, Speak: false }).catch(() => {});
  }
  if (channel.name !== displayName) await channel.setName(displayName).catch(() => {});
  entry.channelId = channel.id;
  return channel;
}

function activeEntries(stats) {
  const list = [];
  for (const [key, entry] of Object.entries(stats.server)) if (entry.enabled) list.push({ category: 'server', key, entry });
  for (const [key, entry] of Object.entries(stats.social)) if (entry.enabled) list.push({ category: 'social', key, entry });
  for (const entry of stats.custom) if (entry.enabled) list.push({ category: 'custom', key: entry.id, entry });
  return list;
}

async function refreshOne(guild, stats, category, key, entry, serverValues) {
  const now = Date.now();
  const refreshMs = clampRefresh(entry.refreshSeconds) * 1000;
  if (entry.lastUpdated && now - entry.lastUpdated < refreshMs && entry.channelId) return false;

  try {
    let values;
    if (category === 'server') values = serverValues || await fetchServer(guild);
    else if (category === 'social') values = await fetchSocial(key, entry.source);
    else values = { value: entry.value, name: entry.name, label: entry.name };
    const merged = { ...values, value: values.value ?? values[Object.keys(values)[0]] ?? entry.value ?? 0 };
    const name = templateReplace(entry.template, serverTemplateValues(merged));
    const channel = await ensureStatChannel(guild, await ensureCategory(guild, stats), entry, name);
    if (!channel) throw new Error('Unable to create the stat channel.');
    entry.lastUpdated = now;
    entry.lastError = null;
    return true;
  } catch (error) {
    entry.lastError = String(error?.message || error).slice(0, 300);
    entry.lastUpdated = now;
    try {
      const fallback = String(entry.template || '{value}')
        .replace(/\{[^}]+\}/g, 'N/A')
        .replace(/<[^>]+>/g, 'N/A')
        .slice(0, 100);
      await ensureStatChannel(guild, await ensureCategory(guild, stats), entry, fallback);
    } catch {}
    return true;
  }
}

async function refreshGuild(guild) {
  if (!guild) return;
  const stats = readStats(guild.id);
  if (!stats.enabled && enabledStatsCount(stats) === 0) return false;
  let dirty = false;
  let serverValues = null;
  const needsServer = Object.values(stats.server).some(x => x.enabled);
  if (needsServer) serverValues = await fetchServer(guild).catch(() => null);
  for (const item of activeEntries(stats)) {
    const changed = await refreshOne(guild, stats, item.category, item.key, item.entry, serverValues);
    dirty = dirty || changed;
  }
  if (dirty) {
    stats.enabled = enabledStatsCount(stats) > 0;
    saveStats(guild.id, stats);
  }
  return dirty;
}

async function refreshAll(client) {
  const guilds = client?.guilds?.cache;
  if (!guilds) return;
  for (const guild of guilds.values()) await refreshGuild(guild).catch(err => console.error(`[Stats] ${guild.id}:`, err));
}

async function configure(guildId, category, key, patch) {
  const cfg = readStats(guildId);
  const target = category === 'server' ? cfg.server[key] : category === 'social' ? cfg.social[key] : cfg.custom.find(x => x.id === key);
  if (!target) throw new Error('Stat not found.');
  Object.assign(target, patch || {});
  target.refreshSeconds = clampRefresh(target.refreshSeconds);
  target.template = cleanTemplate(target.template, getDefaultTemplate(category, key));
  target.enabled = true;
  cfg.enabled = true;
  saveStats(guildId, cfg);
  return target;
}

function toggle(guildId, category, key) {
  const cfg = readStats(guildId);
  const target = category === 'server' ? cfg.server[key] : category === 'social' ? cfg.social[key] : cfg.custom.find(x => x.id === key);
  if (!target) throw new Error('Stat not found.');
  target.enabled = !target.enabled;
  cfg.enabled = enabledStatsCount(cfg) > 0;
  saveStats(guildId, cfg);
  return target;
}

function createCustom(guildId, data) {
  const cfg = readStats(guildId);
  const custom = {
    id: `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: String(data.name || 'Custom Stat').slice(0, 60),
    source: String(data.source || 'manual').slice(0, 200),
    value: String(data.value ?? '0').slice(0, 100),
    enabled: true,
    template: cleanTemplate(data.template, '{value}'),
    channelId: null,
    refreshSeconds: clampRefresh(data.refreshSeconds),
    lastUpdated: 0,
    lastError: null
  };
  cfg.custom.push(custom);
  cfg.enabled = true;
  saveStats(guildId, cfg);
  return custom;
}

function remove(guildId, category, key) {
  const cfg = readStats(guildId);
  if (category === 'custom') {
    const index = cfg.custom.findIndex(x => x.id === key);
    if (index === -1) return null;
    const removed = cfg.custom.splice(index, 1)[0];
    cfg.enabled = enabledStatsCount(cfg) > 0;
    saveStats(guildId, cfg);
    return removed;
  }
  const target = category === 'server' ? cfg.server[key] : cfg.social[key];
  if (!target) return null;
  target.enabled = false;
  cfg.enabled = enabledStatsCount(cfg) > 0;
  saveStats(guildId, cfg);
  return target;
}

function setCategory(guildId, channel) {
  const cfg = readStats(guildId);
  cfg.categoryId = channel?.id || null;
  if (channel?.name) cfg.categoryName = channel.name;
  saveStats(guildId, cfg);
  return cfg;
}

function createDefaultServerStats(guildId) {
  const cfg = readStats(guildId);
  for (const [key, def] of Object.entries(SERVER_DEFS)) {
    cfg.server[key].enabled = true;
    cfg.server[key].template = cfg.server[key].template || def.defaultTemplate;
  }
  cfg.enabled = true;
  saveStats(guildId, cfg);
  return cfg;
}

function resetGuild(guildId) {
  const current = readStats(guildId);
  const reset = normalizeStatsConfig({ categoryName: current.categoryName });
  saveStats(guildId, reset);
  return reset;
}

module.exports = {
  SERVER_DEFS,
  SOCIAL_DEFS,
  REFRESH_MIN_SECONDS,
  DEFAULT_REFRESH_SECONDS,
  normalizeStatsConfig,
  readStats,
  saveStats,
  enabledStatsCount,
  getStat,
  getDefaultTemplate,
  refreshGuild,
  refreshAll,
  configure,
  toggle,
  createCustom,
  remove,
  setCategory,
  createDefaultServerStats,
  resetGuild
};
