// template.js — portable server templates for /template save | load.
// Exports: MAX_CODE_LENGTH, createSnapshot(guild), encodeSnapshot(snapshot), decodeSnapshot(code),
//          loadSnapshot(guild, snapshot, onStage) -> { channelsCreated, rolesCreated, failed[] }
// Codes are gzip+base64url compressed and HMAC-signed (secret: TEMPLATE_SECRET, else DISCORD_TOKEN),
// so a code can't be edited by hand. Roles and channels (with their role permission overwrites) are saved;
// members, messages, bots' managed roles and bot settings are not.

const zlib = require('zlib');
const crypto = require('crypto');
const { ChannelType, PermissionsBitField } = require('discord.js');

const PREFIX = 'VX-TPL';
const MAX_CODE_LENGTH = 6000;                  // Discord's maximum for a slash-command string option
const MAX_ROLES = 150;
const MAX_CHANNELS = 300;

const secret = () => process.env.TEMPLATE_SECRET || process.env.DISCORD_TOKEN || 'aunxz-template';
const sign = payload => crypto.createHmac('sha256', secret()).update(payload).digest('base64url').slice(0, 22);
const wait = ms => new Promise(r => setTimeout(r, ms));

const SAVED_TYPES = new Set([
  ChannelType.GuildCategory, ChannelType.GuildText, ChannelType.GuildVoice,
  ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum
]);

function createSnapshot(guild) {
  const roles = [...guild.roles.cache.values()]
    .filter(r => r.id !== guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)           // top → bottom
    .slice(0, MAX_ROLES);
  const roleIndex = new Map(roles.map((r, i) => [r.id, i]));

  const channels = [...guild.channels.cache.values()]
    .filter(c => SAVED_TYPES.has(c.type) && !c.isThread?.())
    .sort((a, b) => (a.rawPosition ?? a.position) - (b.rawPosition ?? b.position))
    .slice(0, MAX_CHANNELS);
  const chIndex = new Map(channels.map((c, i) => [c.id, i]));

  const overwritesOf = ch => {
    const out = [];
    for (const ow of ch.permissionOverwrites?.cache?.values?.() || []) {
      if (ow.type !== 0) continue;                      // roles only (type 0)
      const key = ow.id === guild.id ? 'e' : roleIndex.get(ow.id);
      if (key === undefined) continue;
      out.push([key, ow.allow.bitfield.toString(), ow.deny.bitfield.toString()]);
    }
    return out;
  };

  return {
    v: 1, name: guild.name,
    roles: roles.map(r => ({ n: r.name, c: r.color, h: r.hoist ? 1 : 0, m: r.mentionable ? 1 : 0, p: r.permissions.bitfield.toString() })),
    channels: channels.map(c => ({
      n: c.name, t: c.type,
      p: c.parentId && chIndex.has(c.parentId) ? chIndex.get(c.parentId) : -1,
      tp: c.topic || undefined, nsfw: c.nsfw ? 1 : undefined, rl: c.rateLimitPerUser || undefined,
      b: c.bitrate || undefined, ul: c.userLimit || undefined, o: overwritesOf(c)
    }))
  };
}

function encodeSnapshot(snapshot) {
  const body = zlib.gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 9 }).toString('base64url');
  const code = `${PREFIX}.${body}.${sign(body)}`;
  if (code.length > MAX_CODE_LENGTH) {
    throw new Error(`This server is too large for a single template code (${code.length} > ${MAX_CODE_LENGTH} characters). Remove some channels/roles and try again.`);
  }
  return code;
}

function decodeSnapshot(code) {
  const parts = String(code || '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) throw new Error('That is not a valid AunXz template code.');
  const [, body, sig] = parts;
  const good = Buffer.from(sign(body)); const given = Buffer.from(sig);
  if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) throw new Error('This template code is corrupted or was created by a different AunXz bot.');
  let data;
  try { data = JSON.parse(zlib.gunzipSync(Buffer.from(body, 'base64url')).toString('utf8')); }
  catch { throw new Error('This template code could not be read.'); }
  if (!data || data.v !== 1 || !Array.isArray(data.roles) || !Array.isArray(data.channels)) throw new Error('Unsupported template version.');
  return data;
}

async function loadSnapshot(guild, snapshot, onStage = async () => {}) {
  const failed = [];
  const reason = 'AunXz /template load';
  const me = guild.members.me || await guild.members.fetchMe();
  const need = ['ManageChannels', 'ManageRoles'];
  const missing = need.filter(p => !me.permissions.has(PermissionsBitField.Flags[p]) && !me.permissions.has(PermissionsBitField.Flags.Administrator));
  if (missing.length) throw new Error(`I need **${missing.join('**, **')}** to load a template.`);

  // 1) remove current channels
  await onStage('Removing current channels…');
  await guild.channels.fetch().catch(() => {});
  for (const ch of [...guild.channels.cache.values()].filter(c => !c.isThread?.())) {
    try { await ch.delete(reason); } catch (e) { failed.push(`delete #${ch.name}: ${e.message}`); }
  }

  // 2) remove current roles I'm allowed to remove
  await onStage('Removing current roles…');
  await guild.roles.fetch().catch(() => {});
  for (const role of [...guild.roles.cache.values()]) {
    if (role.id === guild.id || role.managed || role.position >= me.roles.highest.position) continue;
    try { await role.delete(reason); } catch (e) { failed.push(`delete @${role.name}: ${e.message}`); }
  }

  // 3) create roles (bottom first so the saved order is preserved)
  await onStage(`Creating ${snapshot.roles.length} roles…`);
  const roleIds = new Array(snapshot.roles.length).fill(null);
  let rolesCreated = 0;
  for (let i = snapshot.roles.length - 1; i >= 0; i--) {
    const r = snapshot.roles[i];
    try {
      const role = await guild.roles.create({
        name: r.n, color: r.c || 0, hoist: !!r.h, mentionable: !!r.m,
        permissions: new PermissionsBitField(BigInt(r.p) & me.permissions.bitfield), reason
      });
      roleIds[i] = role.id; rolesCreated++;
    } catch (e) { failed.push(`role @${r.n}: ${e.message}`); }
    await wait(250);
  }

  // 4) create channels (categories first so children can be parented)
  await onStage(`Creating ${snapshot.channels.length} channels…`);
  const chIds = new Array(snapshot.channels.length).fill(null);
  let channelsCreated = 0;
  const overwrites = list => (list || []).map(([key, allow, deny]) => {
    const id = key === 'e' ? guild.id : roleIds[key];
    return id ? { id, type: 0, allow: BigInt(allow), deny: BigInt(deny) } : null;
  }).filter(Boolean);
  const order = [
    ...snapshot.channels.map((c, i) => [c, i]).filter(([c]) => c.t === ChannelType.GuildCategory),
    ...snapshot.channels.map((c, i) => [c, i]).filter(([c]) => c.t !== ChannelType.GuildCategory)
  ];
  for (const [c, i] of order) {
    try {
      const opts = { name: c.n, type: c.t, permissionOverwrites: overwrites(c.o), reason };
      if (c.p >= 0 && chIds[c.p]) opts.parent = chIds[c.p];
      if (c.tp) opts.topic = c.tp;
      if (c.nsfw) opts.nsfw = true;
      if (c.rl) opts.rateLimitPerUser = c.rl;
      if (c.b) opts.bitrate = Math.min(c.b, guild.maximumBitrate || 96000);
      if (c.ul) opts.userLimit = c.ul;
      const ch = await guild.channels.create(opts);
      chIds[i] = ch.id; channelsCreated++;
    } catch (e) { failed.push(`channel ${c.n}: ${e.message}`); }
    await wait(250);
  }

  return { channelsCreated, rolesCreated, failed };
}

module.exports = { MAX_CODE_LENGTH, createSnapshot, encodeSnapshot, decodeSnapshot, loadSnapshot };
