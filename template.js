// template.js — portable AunXz server templates.
// Stores a compressed, HMAC-signed snapshot inside the template code itself.

const crypto = require('crypto');
const zlib = require('zlib');
const { ChannelType, PermissionsBitField } = require('discord.js');
const db = require('./database');

const VERSION = 1;
const PREFIX = `VX-TPL-${VERSION}`;
const MAX_CODE_LENGTH = 3800;

function secret() {
  return process.env.TEMPLATE_SECRET || process.env.DISCORD_TOKEN || 'aunxz-template-fallback-secret';
}

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromB64url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function sign(body) {
  return b64url(crypto.createHmac('sha256', secret()).update(body).digest());
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// These values are guild/member/message state, not portable server configuration.
const DROP_KEYS = new Set([
  'messageId', 'panelMessageId', 'participants', 'blacklist', 'entries',
  'createdAt', 'endsAt', 'hostId', 'userId', 'claimedBy', 'audioPath'
]);

function sanitizeConfig(value, key = '') {
  if (Array.isArray(value)) return value.map(v => sanitizeConfig(v, key));
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (DROP_KEYS.has(k)) continue;
    if (k === 'counter') {
      out[k] = 0;
      continue;
    }
    out[k] = sanitizeConfig(v, k);
  }
  return out;
}

function snapshotOverwrite(overwrite, guild) {
  const id = overwrite.id;
  const isEveryone = id === guild.id;
  const isRole = isEveryone || guild.roles.cache.has(id);
  const isMember = guild.members.cache.has(id);
  if (!isRole && !isMember) return null;

  return {
    id,
    kind: isRole ? 'role' : 'member',
    allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString()
  };
}

function snapshotChannel(channel, guild) {
  const supported = new Set([
    ChannelType.GuildCategory,
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildVoice,
    ChannelType.GuildStageVoice,
    ChannelType.GuildForum
  ]);
  if (!supported.has(channel.type)) return null;

  const data = {
    id: channel.id,
    type: channel.type,
    name: channel.name,
    parentId: channel.parentId || null,
    position: Number(channel.rawPosition || channel.position || 0),
    topic: channel.topic ?? null,
    nsfw: Boolean(channel.nsfw),
    rateLimitPerUser: Number(channel.rateLimitPerUser || 0),
    bitrate: Number(channel.bitrate || 0),
    userLimit: Number(channel.userLimit || 0),
    rtcRegion: channel.rtcRegion || null,
    videoQualityMode: channel.videoQualityMode ?? null,
    defaultAutoArchiveDuration: channel.defaultAutoArchiveDuration ?? null,
    defaultThreadRateLimitPerUser: channel.defaultThreadRateLimitPerUser ?? null,
    permissionOverwrites: []
  };

  for (const overwrite of channel.permissionOverwrites?.cache?.values?.() || []) {
    const item = snapshotOverwrite(overwrite, guild);
    if (item) data.permissionOverwrites.push(item);
  }

  return data;
}

function createSnapshot(guild) {
  const roles = guild.roles.cache
    .filter(role => role.id !== guild.id && !role.managed)
    .sort((a, b) => a.position - b.position)
    .map(role => ({
      id: role.id,
      name: role.name,
      color: role.hexColor,
      hoist: Boolean(role.hoist),
      mentionable: Boolean(role.mentionable),
      permissions: role.permissions.bitfield.toString(),
      position: Number(role.position || 0)
    }));

  const channels = guild.channels.cache
    .sort((a, b) => Number(a.rawPosition || a.position || 0) - Number(b.rawPosition || b.position || 0))
    .map(channel => snapshotChannel(channel, guild))
    .filter(Boolean);

  return {
    version: VERSION,
    exportedAt: Date.now(),
    source: {
      guildName: guild.name,
      guildId: guild.id
    },
    everyonePermissions: guild.roles.everyone.permissions.bitfield.toString(),
    roles,
    channels,
    config: sanitizeConfig(clone(db.getConfig(guild.id)))
  };
}

function encodeSnapshot(snapshot) {
  const raw = Buffer.from(JSON.stringify(snapshot), 'utf8');
  const compressed = zlib.deflateRawSync(raw, { level: 9 });
  const body = b64url(compressed);
  const code = `${PREFIX}.${body}.${sign(body)}`;
  if (code.length > MAX_CODE_LENGTH) {
    throw new Error(`This server template is too large for one Discord command option (${code.length}/${MAX_CODE_LENGTH} characters).`);
  }
  return code;
}

function decodeSnapshot(code) {
  const normalized = String(code || '').trim();
  if (!normalized) throw new Error('Template code is empty.');
  if (normalized.length > MAX_CODE_LENGTH) throw new Error('Template code is too long.');

  const parts = normalized.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) throw new Error('Invalid template code.');
  const [, body, providedSig] = parts;
  const expectedSig = sign(body);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Template signature is invalid or the code was edited.');

  let snapshot;
  try {
    snapshot = JSON.parse(zlib.inflateRawSync(fromB64url(body)).toString('utf8'));
  } catch {
    throw new Error('Template data is corrupted or unreadable.');
  }
  if (!snapshot || snapshot.version !== VERSION || !Array.isArray(snapshot.roles) || !Array.isArray(snapshot.channels)) {
    throw new Error('Unsupported template version.');
  }
  return snapshot;
}

function remapConfigIds(value, roleMap, channelMap) {
  if (Array.isArray(value)) return value.map(v => remapConfigIds(v, roleMap, channelMap));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') return channelMap.get(value) || roleMap.get(value) || value;
    return value;
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = remapConfigIds(child, roleMap, channelMap);
  return out;
}

function roleCreateOptions(role) {
  let permissions = [];
  try {
    permissions = new PermissionsBitField(BigInt(role.permissions || '0')).toArray();
  } catch {}
  return {
    name: String(role.name || 'Imported Role').slice(0, 100),
    color: role.color && role.color !== '#000000' ? role.color : undefined,
    hoist: Boolean(role.hoist),
    mentionable: Boolean(role.mentionable),
    permissions
  };
}

function channelCreateOptions(data, parentId, roleMap, guild, sourceGuildId) {
  const base = {
    name: String(data.name || 'imported-channel').slice(0, 100),
    type: data.type,
    parent: parentId || undefined,
    permissionOverwrites: []
  };

  if (data.type === ChannelType.GuildText || data.type === ChannelType.GuildAnnouncement) {
    if (data.topic) base.topic = String(data.topic).slice(0, 4096);
    base.nsfw = Boolean(data.nsfw);
    if (Number(data.rateLimitPerUser) > 0) base.rateLimitPerUser = Number(data.rateLimitPerUser);
  }

  if (data.type === ChannelType.GuildVoice || data.type === ChannelType.GuildStageVoice) {
    if (Number(data.bitrate) > 0) {
      const max = Number(guild.maximumBitrate || data.bitrate);
      base.bitrate = Math.min(Number(data.bitrate), max);
    }
    if (Number(data.userLimit) > 0) base.userLimit = Number(data.userLimit);
    if (data.rtcRegion) base.rtcRegion = data.rtcRegion;
    if (data.videoQualityMode != null) base.videoQualityMode = data.videoQualityMode;
  }

  if (data.type === ChannelType.GuildForum) {
    base.nsfw = Boolean(data.nsfw);
    if (Number(data.rateLimitPerUser) > 0) base.rateLimitPerUser = Number(data.rateLimitPerUser);
    if (data.defaultAutoArchiveDuration) base.defaultAutoArchiveDuration = data.defaultAutoArchiveDuration;
    if (data.defaultThreadRateLimitPerUser != null) base.defaultThreadRateLimitPerUser = data.defaultThreadRateLimitPerUser;
  }

  for (const ow of data.permissionOverwrites || []) {
    let targetId = null;
    if (ow.kind === 'role') targetId = ow.id === sourceGuildId ? guild.id : roleMap.get(ow.id);
    else if (ow.kind === 'member' && guild.members.cache.has(ow.id)) targetId = ow.id;
    if (!targetId) continue;

    let allow = [], deny = [];
    try {
      allow = new PermissionsBitField(BigInt(ow.allow || '0')).toArray();
      deny = new PermissionsBitField(BigInt(ow.deny || '0')).toArray();
    } catch {}
    base.permissionOverwrites.push({ id: targetId, allow, deny });
  }

  return base;
}

async function loadSnapshot(guild, snapshot, onProgress = async () => {}) {
  const bot = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!bot) throw new Error('I could not find my bot member in this server. AunXz must be installed to this server for loading.');
  if (!bot.permissions.has('ManageChannels') || !bot.permissions.has('ManageRoles')) {
    throw new Error('I need **Manage Channels** and **Manage Roles** to rebuild this server.');
  }

  const failed = [];
  const roleMap = new Map();
  const channelMap = new Map();

  await onProgress('Removing existing channels…');
  for (const channel of [...guild.channels.cache.values()]) {
    try { await channel.delete('AunXz template rebuild'); }
    catch (e) { failed.push(`channel ${channel.name}: ${e.message}`); }
  }

  await onProgress('Removing existing user-managed roles…');
  for (const role of [...guild.roles.cache.values()]) {
    if (role.id === guild.id || role.managed || role.id === bot.roles.highest.id) continue;
    try { await role.delete('AunXz template rebuild'); }
    catch (e) { failed.push(`role ${role.name}: ${e.message}`); }
  }

  await onProgress('Rebuilding roles…');
  for (const role of [...snapshot.roles].sort((a, b) => a.position - b.position)) {
    try {
      const created = await guild.roles.create({ ...roleCreateOptions(role), reason: 'AunXz template rebuild' });
      roleMap.set(role.id, created.id);
    } catch (e) {
      failed.push(`role ${role.name}: ${e.message}`);
    }
  }

  // @everyone permissions are portable and do not depend on IDs.
  if (snapshot.everyonePermissions) {
    try {
      const permissions = new PermissionsBitField(BigInt(snapshot.everyonePermissions)).toArray();
      await guild.roles.everyone.setPermissions(permissions, 'AunXz template rebuild');
    } catch (e) {
      failed.push(`@everyone permissions: ${e.message}`);
    }
  }

  await onProgress('Rebuilding channels…');
  const channelRecords = [...snapshot.channels].sort((a, b) => {
    const ac = a.type === ChannelType.GuildCategory ? 0 : 1;
    const bc = b.type === ChannelType.GuildCategory ? 0 : 1;
    return ac - bc || (a.position || 0) - (b.position || 0);
  });

  for (const data of channelRecords) {
    const parentId = data.parentId ? channelMap.get(data.parentId) : null;
    try {
      const options = channelCreateOptions(data, parentId, roleMap, guild, snapshot.source.guildId);
      const created = await guild.channels.create(options);
      channelMap.set(data.id, created.id);
    } catch (e) {
      failed.push(`channel ${data.name}: ${e.message}`);
    }
  }

  await onProgress('Restoring channel order…');
  for (const data of channelRecords) {
    const channel = guild.channels.cache.get(channelMap.get(data.id));
    if (!channel) continue;
    try { await channel.setPosition(Number(data.position || 0)); } catch {}
  }

  await onProgress('Restoring AunXz settings…');
  const mappedConfig = remapConfigIds(snapshot.config, roleMap, channelMap);
  db.saveConfig(guild.id, mappedConfig);

  return {
    rolesCreated: roleMap.size,
    channelsCreated: channelMap.size,
    failed
  };
}

module.exports = {
  VERSION,
  MAX_CODE_LENGTH,
  createSnapshot,
  encodeSnapshot,
  decodeSnapshot,
  loadSnapshot
};
