// template.js — full server templates for /template save | load | list | delete.
//
// SAVE  (createSnapshot) stores:
//   • guild settings  : name, icon, banner, invite splash, description, language, verification level,
//                       content filter, default notifications, AFK channel/timeout, system channel + flags,
//                       rules / public-updates channels, @everyone permissions
//   • roles           : name, colour, hoist, mentionable, permissions, unicode icon, exact order
//   • channels        : categories / text / voice / announcement / stage / forum, topic, nsfw, slowmode, bitrate,
//                       user limit, region, forum tags … and role permission overwrites, exact order + parents
//   • emojis + stickers (as images)
//   • bot settings    : the whole guild config (channel / role IDs are remapped on load), sticky messages,
//                       saved embeds, anti-nuke whitelist (restored only into the same server)
//   • panels          : ticket panel, staff-application panel, birthday panel, button-role + reaction-role panels
//                       (detected by scanning the bot's own messages) — they are re-posted on load
//
// The snapshot is stored in the bot database under a short code (AX-XXXXXXXX) and is also DM'd as a signed
// file (works without the database; load it with the `file:` option). Old VX-TPL codes still load.
//
// LOAD  (runLoad) creates a private progress channel FIRST, wipes the old layout, rebuilds everything in the
// original order and reports live progress there. The interaction is never touched after the channels are
// deleted (that was the "Unknown Channel" crash). When finished, a completion message with a Delete button is
// posted in the progress channel.

const zlib = require('zlib');
const crypto = require('crypto');
const {
  ChannelType, PermissionsBitField, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder
} = require('discord.js');
const db = require('./database');
const ui = require('./ui');

const PREFIX = 'AX-TPL';
const LEGACY_PREFIX = 'VX-TPL';
const MAX_CODE_LENGTH = 6000;                  // Discord's maximum for a slash-command string option
const MAX_ROLES = 250;
const MAX_CHANNELS = 500;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

const secret = () => process.env.TEMPLATE_SECRET || process.env.DISCORD_TOKEN || 'aunxz-template';
const sign = payload => crypto.createHmac('sha256', secret()).update(payload).digest('base64url').slice(0, 22);
const wait = ms => new Promise(r => setTimeout(r, ms));
const short = e => String(e?.rawError?.message || e?.message || e).replace(/\s+/g, ' ').slice(0, 140);
const codeOf = e => e?.code ?? e?.rawError?.code;

const SAVED_TYPES = new Set([
  ChannelType.GuildCategory, ChannelType.GuildText, ChannelType.GuildVoice,
  ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum
]);
const TEXTY = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
// channel types that need a Community server; they fall back to the plain type when creation fails
const FALLBACK_TYPE = {
  [ChannelType.GuildAnnouncement]: ChannelType.GuildText,
  [ChannelType.GuildForum]: ChannelType.GuildText,
  [ChannelType.GuildStageVoice]: ChannelType.GuildVoice
};

// ---------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------
async function pool(items, size, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const k = next++; await fn(items[k], k); }
  });
  await Promise.all(workers);
}

async function fetchBuffer(url, max = MAX_ASSET_BYTES) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > max) return null;
    return { buf, type: (res.headers.get('content-type') || 'image/png').split(';')[0] };
  } catch { return null; }
}
async function fetchDataUri(url) {
  const r = await fetchBuffer(url);
  return r ? `data:${r.type};base64,${r.buf.toString('base64')}` : undefined;
}

// --- ID remapping for the bot config -----------------------------------------------
// On save every channel / role ID inside the config becomes a token (\u0001c<index> / \u0001r<index>),
// on load the tokens are replaced by the IDs of the freshly created channels / roles.
const SNOWFLAKE = /^\d{16,20}$/;
function encodeIds(value, chMap, roleMap) {
  const enc = s => {
    if (SNOWFLAKE.test(s)) {
      if (chMap.has(s)) return `\u0001c${chMap.get(s)}`;
      if (roleMap.has(s)) return `\u0001r${roleMap.get(s)}`;
      return s;
    }
    return s
      .replace(/<#(\d{16,20})>/g, (m, id) => (chMap.has(id) ? `<#\u0001c${chMap.get(id)}>` : m))
      .replace(/<@&(\d{16,20})>/g, (m, id) => (roleMap.has(id) ? `<@&\u0001r${roleMap.get(id)}>` : m));
  };
  const walk = v => {
    if (typeof v === 'string') return enc(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[enc(k)] = walk(x); return o; }
    return v;
  };
  return walk(value);
}
function decodeIds(value, chIds, roleIds) {
  const lookup = (t, i) => (t === 'c' ? chIds[Number(i)] : roleIds[Number(i)]) || null;
  const dec = s => {
    const whole = /^\u0001([cr])(\d+)$/.exec(s);
    if (whole) return lookup(whole[1], whole[2]);
    return s.replace(/\u0001([cr])(\d+)/g, (m, t, i) => lookup(t, i) || '0');
  };
  const walk = v => {
    if (typeof v === 'string') return dec(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) { const nk = dec(k); if (nk) o[nk] = walk(x); }
      return o;
    }
    return v;
  };
  return walk(value);
}

function collectCustomIds(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => collectCustomIds(n, out)); return out; }
  if (node.custom_id) out.push(node.custom_id);
  if (node.components) collectCustomIds(node.components, out);
  if (node.accessory) collectCustomIds(node.accessory, out);
  return out;
}

// ---------------------------------------------------------------------------------
// SAVE
// ---------------------------------------------------------------------------------
async function createSnapshot(guild, onStage = async () => {}) {
  await onStage('Reading roles & channels…');
  await guild.channels.fetch().catch(() => {});
  await guild.roles.fetch().catch(() => {});

  const roles = [...guild.roles.cache.values()]
    .filter(r => r.id !== guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)           // top → bottom
    .slice(0, MAX_ROLES);
  const roleIndex = new Map(roles.map((r, i) => [r.id, i]));

  // skip live ticket channels and temporary VoiceMaster rooms — they are runtime data, not layout
  const runtime = c => { try { return !!(db.getTicket(c.id)?.status === 'open' || db.getVMChannel(c.id)); } catch { return false; } };
  const channels = [...guild.channels.cache.values()]
    .filter(c => SAVED_TYPES.has(c.type) && !c.isThread?.() && !runtime(c))
    .sort((a, b) => (a.rawPosition ?? a.position) - (b.rawPosition ?? b.position))
    .slice(0, MAX_CHANNELS);
  const chIndex = new Map(channels.map((c, i) => [c.id, i]));
  const idx = id => (id && chIndex.has(id) ? chIndex.get(id) : -1);

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

  // ---- guild settings ----
  await onStage('Reading server settings & images…');
  const g = {
    n: guild.name, ds: guild.description || undefined,
    ic: await fetchDataUri(guild.iconURL({ size: 1024, forceStatic: false })),
    bn: await fetchDataUri(guild.bannerURL?.({ size: 1024, forceStatic: false })),
    sp: await fetchDataUri(guild.splashURL?.({ size: 1024 })),
    vl: guild.verificationLevel, cf: guild.explicitContentFilter, dn: guild.defaultMessageNotifications,
    at: guild.afkTimeout, afk: idx(guild.afkChannelId), sys: idx(guild.systemChannelId),
    sf: Number(guild.systemChannelFlags?.bitfield ?? 0), loc: guild.preferredLocale,
    rules: idx(guild.rulesChannelId), upd: idx(guild.publicUpdatesChannelId),
    com: guild.features?.includes('COMMUNITY') ? 1 : 0,
    ev: guild.roles.everyone.permissions.bitfield.toString()
  };

  // ---- emojis / stickers ----
  await onStage('Reading emojis & stickers…');
  await guild.emojis.fetch().catch(() => {});
  const emojiList = [...guild.emojis.cache.values()].filter(e => !e.managed);
  const emojis = [];
  await pool(emojiList, 6, async e => {
    const url = e.imageURL?.({ extension: e.animated ? 'gif' : 'png' }) || e.url;
    const d = await fetchDataUri(url);
    if (d) emojis.push({ n: e.name, d });
  });
  await guild.stickers.fetch().catch(() => {});
  const stickerList = [...guild.stickers.cache.values()].filter(s => s.format !== 3);   // 3 = Lottie (bots cannot create)
  const stickers = [];
  await pool(stickerList, 4, async s => {
    const r = await fetchBuffer(s.url, 2 * 1024 * 1024);
    if (r) stickers.push({ n: s.name, tg: s.tags || s.name, ds: s.description || undefined, d: r.buf.toString('base64'), f: s.format });
  });

  // ---- panels (scan the bot's own messages) ----
  const panels = await scanPanels(guild, channels, chIndex, async (done, total) => onStage(`Scanning panels… ${done}/${total} channels`));

  // ---- bot settings ----
  await onStage('Reading bot settings…');
  const cfg = JSON.parse(JSON.stringify(db.getConfig(guild.id)));
  for (const k of ['afk', 'blacklist', 'maintenance']) delete cfg[k];                 // per-member / per-server runtime data
  if (cfg.birthdays) cfg.birthdays.entries = {};
  if (cfg.ticket) cfg.ticket.counter = 0;
  const config = encodeIds(cfg, chIndex, roleIndex);

  const sticky = [];
  try {
    for (const s of db.listStickies(guild.id)) {
      if (!chIndex.has(s.channelId)) continue;
      sticky.push({ ch: chIndex.get(s.channelId), data: encodeIds(s.data, chIndex, roleIndex), en: s.enabled ? 1 : 0, by: s.createdBy || undefined });
    }
  } catch { /* table missing on very old DBs */ }
  const embeds = [];
  try { for (const e of db.listEmbeds(guild.id)) embeds.push({ name: e.name, data: encodeIds(e.data, chIndex, roleIndex) }); } catch {}
  let wl = [];
  try { wl = db.db.prepare('SELECT userId FROM antinuke_whitelist WHERE guildId=?').all(guild.id).map(r => r.userId); } catch {}

  return {
    v: 2, id: guild.id, name: guild.name, at: Date.now(), g,
    roles: roles.map(r => ({ n: r.name, c: r.color, h: r.hoist ? 1 : 0, m: r.mentionable ? 1 : 0, p: r.permissions.bitfield.toString(), ue: r.unicodeEmoji || undefined })),
    channels: channels.map(c => ({
      n: c.name, t: c.type,
      p: c.parentId && chIndex.has(c.parentId) ? chIndex.get(c.parentId) : -1,
      tp: c.topic || undefined, nsfw: c.nsfw ? 1 : undefined, rl: c.rateLimitPerUser || undefined,
      b: c.bitrate || undefined, ul: c.userLimit || undefined, rg: c.rtcRegion || undefined,
      vq: c.videoQualityMode || undefined, aa: c.defaultAutoArchiveDuration || undefined,
      tags: c.availableTags?.length ? c.availableTags.map(t => ({ name: t.name, moderated: !!t.moderated, emoji: t.emoji?.name && !t.emoji?.id ? t.emoji.name : undefined })) : undefined,
      so: c.defaultSortOrder ?? undefined, fl: c.defaultForumLayout || undefined,
      tr: c.defaultThreadRateLimitPerUser || undefined,
      o: overwritesOf(c)
    })),
    emojis, stickers, panels, config, sticky, embeds, wl
  };
}

async function scanPanels(guild, channels, chIndex, onProgress) {
  const me = guild.members.me;
  const found = [];
  const targets = channels.filter(c => TEXTY.has(c.type)).filter(c => {
    const p = c.permissionsFor(me);
    return p?.has(PermissionFlagsBits.ViewChannel) && p?.has(PermissionFlagsBits.ReadMessageHistory);
  });
  let done = 0, lastReport = 0;
  await pool(targets, 5, async ch => {
    try {
      const msgs = await ch.messages.fetch({ limit: 30 });
      const types = new Set();
      for (const m of msgs.values()) {
        if (m.author?.id !== guild.client.user.id) continue;
        let ids = [];
        try { ids = collectCustomIds(m.components.map(c => (typeof c.toJSON === 'function' ? c.toJSON() : c))); } catch {}
        if (ids.includes('ticket_open')) types.add('ticket');
        if (ids.includes('staffapp_apply')) types.add('staffapp');
        if (ids.includes('birthday_set')) types.add('birthday');
      }
      for (const t of types) found.push({ type: t, ch: chIndex.get(ch.id) });
    } catch { /* no access */ }
    done++;
    if (Date.now() - lastReport > 2500) { lastReport = Date.now(); await onProgress?.(done, targets.length).catch?.(() => {}); }
  });
  // fall back to the channel stored in the config when no live panel was found
  try {
    const t = db.getConfig(guild.id).ticket;
    if (t?.panelChannelId && chIndex.has(t.panelChannelId) && !found.some(f => f.type === 'ticket')) found.push({ type: 'ticket', ch: chIndex.get(t.panelChannelId) });
  } catch {}
  return found;
}

function encodeSnapshot(snapshot) {
  const body = zlib.gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 9 }).toString('base64url');
  return `${PREFIX}.${body}.${sign(body)}`;
}

function decodeSnapshot(code) {
  const parts = String(code || '').trim().split('.');
  if (parts.length !== 3 || (parts[0] !== PREFIX && parts[0] !== LEGACY_PREFIX)) throw new Error('That is not a valid AunXz template code or file.');
  const [, body, sig] = parts;
  const good = Buffer.from(sign(body)); const given = Buffer.from(sig);
  if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) throw new Error('This template is corrupted or was created by a different AunXz bot.');
  let data;
  try { data = JSON.parse(zlib.gunzipSync(Buffer.from(body, 'base64url')).toString('utf8')); }
  catch { throw new Error('This template could not be read.'); }
  if (!data || ![1, 2].includes(data.v) || !Array.isArray(data.roles) || !Array.isArray(data.channels)) throw new Error('Unsupported template version.');
  return data;
}

// Resolve whatever the user supplied (database code, legacy code or raw file text) into a snapshot.
function resolveSnapshot(input) {
  const text = String(input || '').trim();
  if (/^AX-[A-Z0-9]{8}$/i.test(text)) {
    const row = db.getTemplate(text);
    if (!row) throw new Error('No saved template with that code exists. (Template codes only work with the bot that saved them.)');
    return decodeSnapshot(row.data);
  }
  return decodeSnapshot(text);
}

// ---------------------------------------------------------------------------------
// LOAD
// ---------------------------------------------------------------------------------
const running = new Set();
const DELETE_ID = 'tplprog:del';

function renderProgress(prog, title = '🔄 Loading Server Template') {
  const lines = [];
  const row = (emoji, key, label) => { const c = prog.c[key]; if (c.total > 0) lines.push(`${emoji} **${c.done}/${c.total}** ${label}`); };
  row('📁', 'channels', 'channels created');
  row('🏷️', 'roles', 'roles created');
  row('⚙️', 'server', 'server settings loaded');
  row('🤖', 'bot', 'bot settings loaded');
  row('😀', 'emojis', 'emojis created');
  row('🏷️', 'stickers', 'stickers created');
  row('🎟️', 'panels', 'panels posted');
  const secs = Math.round((Date.now() - prog.started) / 1000);
  return ui.base(title).setDescription(`**${prog.stage}**\n\n${lines.join('\n')}\n\n-# Elapsed ${Math.floor(secs / 60)}m ${secs % 60}s`);
}

async function createProgressChannel(guild, user, me) {
  return guild.channels.create({
    name: 'template-progress', type: ChannelType.GuildText,
    topic: 'Live progress of the template load. Delete this channel when it finishes.',
    permissionOverwrites: [
      { id: guild.id, type: 0, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, type: 1, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
      { id: me.id, type: 1, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] }
    ],
    reason: `AunXz /template load by ${user.tag || user.id}`
  });
}

async function runLoad(guild, snapshot, user, { onReady } = {}) {
  if (running.has(guild.id)) throw new Error('A template is already loading in this server. Wait for it to finish.');
  running.add(guild.id);
  try { return await loadSnapshot(guild, snapshot, user, onReady); }
  finally { running.delete(guild.id); }
}

async function loadSnapshot(guild, snapshot, user, onReady) {
  const failed = [];
  const kept = [];
  const reason = `AunXz /template load by ${user.tag || user.id}`;
  const me = guild.members.me || await guild.members.fetchMe();
  const isAdmin = me.permissions.has(PermissionFlagsBits.Administrator);
  const missing = ['ManageChannels', 'ManageRoles'].filter(p => !isAdmin && !me.permissions.has(PermissionFlagsBits[p]));
  if (missing.length) throw new Error(`I need **${missing.join('**, **')}** to load a template.`);
  const meBits = me.permissions.bitfield;
  const g = snapshot.g || null;
  const sameGuild = snapshot.id === guild.id;

  const sections = snapshot.config ? Object.keys(snapshot.config) : [];
  const extra = [(snapshot.sticky || []).length ? 'sticky' : null, (snapshot.embeds || []).length ? 'embeds' : null, sameGuild && (snapshot.wl || []).length ? 'whitelist' : null].filter(Boolean);
  const rolePanelCount = ((snapshot.config?.buttonRolePanels || []).filter(p => p.channelId && (p.buttons || []).length && p.enabled !== false).length)
    + ((snapshot.config?.reactionRolePanels || []).filter(p => p.channelId && (p.mappings || []).length && p.enabled !== false).length);

  const prog = {
    stage: 'Preparing…', started: Date.now(),
    c: {
      channels: { done: 0, total: snapshot.channels.length },
      roles: { done: 0, total: snapshot.roles.length },
      server: { done: 0, total: g ? 12 : 0 },
      bot: { done: 0, total: sections.length + extra.length },
      emojis: { done: 0, total: (snapshot.emojis || []).length },
      stickers: { done: 0, total: (snapshot.stickers || []).length },
      panels: { done: 0, total: (snapshot.panels || []).length + rolePanelCount }
    }
  };

  // ---- 0) progress channel (created BEFORE anything is deleted) ----
  let pch = null; let pmsg = null;
  const openProgress = async () => {
    try {
      pch = await createProgressChannel(guild, user, me);
      pmsg = await pch.send({ embeds: [renderProgress(prog)] });
      if (onReady) await Promise.resolve(onReady(pch)).catch(() => {});
    } catch (e) { pch = null; pmsg = null; failed.push(`progress channel: ${short(e)}`); }
  };
  await openProgress();

  let lastEdit = 0; let editing = false;
  const flush = async (force = false) => {
    if (!pmsg) return;
    const now = Date.now();
    if (!force && now - lastEdit < 1600) return;
    if (editing) return;
    editing = true; lastEdit = now;
    try { await pmsg.edit({ embeds: [renderProgress(prog)] }); } catch { /* channel deleted by someone — keep going */ }
    editing = false;
  };
  const stage = async text => { prog.stage = text; await flush(true); };

  // ---- 1) remove current channels (everything except the progress channel) ----
  await stage('Removing current channels…');
  await guild.channels.fetch().catch(() => {});
  const oldChannels = [...guild.channels.cache.values()].filter(c => !c.isThread?.() && c.id !== pch?.id);
  let n = 0;
  for (const ch of oldChannels) {
    try { await ch.delete(reason); }
    catch (e) {
      if (codeOf(e) === 10003) { /* already gone */ }
      else if (codeOf(e) === 50074) kept.push(ch);             // required by Community — retried after the settings step
      else failed.push(`delete #${ch.name}: ${short(e)}`);
    }
    n++; if (n % 3 === 0) { prog.stage = `Removing current channels… ${n}/${oldChannels.length}`; await flush(); }
  }

  // progress channel could not be created earlier (e.g. channel limit) — try again now that space exists
  if (!pch) { await openProgress(); }

  // ---- 2) remove current roles I am allowed to remove ----
  await stage('Removing current roles…');
  await guild.roles.fetch().catch(() => {});
  const oldRoles = [...guild.roles.cache.values()].filter(r => r.id !== guild.id && !r.managed && r.position < me.roles.highest.position);
  n = 0;
  for (const role of oldRoles) {
    try { await role.delete(reason); } catch (e) { if (codeOf(e) !== 10011) failed.push(`delete @${role.name}: ${short(e)}`); }
    n++; if (n % 3 === 0) { prog.stage = `Removing current roles… ${n}/${oldRoles.length}`; await flush(); }
    await wait(120);
  }

  // ---- 3) create roles, then put them in the saved order ----
  await stage('Creating roles…');
  const roleIds = new Array(snapshot.roles.length).fill(null);
  for (let i = snapshot.roles.length - 1; i >= 0; i--) {
    const r = snapshot.roles[i];
    try {
      const opts = { name: r.n, color: r.c || 0, hoist: !!r.h, mentionable: !!r.m, permissions: new PermissionsBitField(isAdmin ? BigInt(r.p) : (BigInt(r.p) & meBits)), reason };
      if (r.ue && (guild.premiumTier || 0) >= 2) opts.unicodeEmoji = r.ue;
      const role = await guild.roles.create(opts).catch(async e => { if (opts.unicodeEmoji) { delete opts.unicodeEmoji; return guild.roles.create(opts); } throw e; });
      roleIds[i] = role.id; prog.c.roles.done++;
    } catch (e) { failed.push(`role @${r.n}: ${short(e)}`); }
    await flush(); await wait(200);
  }
  try {
    await stage('Arranging roles…');
    await guild.roles.fetch();
    const made = roleIds.map((id, i) => ({ id, i })).filter(x => x.id && guild.roles.cache.has(x.id));
    // the slots (positions) the new roles occupy — top-most saved role takes the highest slot
    const slots = made.map(x => guild.roles.cache.get(x.id).position).sort((a, b) => a - b);
    const ordered = [...made].sort((a, b) => a.i - b.i);
    const updates = ordered.map((x, k) => ({ role: x.id, position: slots[slots.length - 1 - k] }));
    if (updates.length) await guild.roles.setPositions(updates);
  } catch (e) { failed.push(`role order: ${short(e)}`); }

  // ---- 4) create channels (categories first so children can be parented) ----
  await stage('Creating channels…');
  const chIds = new Array(snapshot.channels.length).fill(null);
  const overwrites = list => (list || []).map(([key, allow, deny]) => {
    const id = key === 'e' ? guild.id : roleIds[key];
    if (!id) return null;
    const a = isAdmin ? BigInt(allow) : (BigInt(allow) & meBits);
    return { id, type: 0, allow: a, deny: BigInt(deny) };
  }).filter(Boolean);
  const order = [
    ...snapshot.channels.map((c, i) => [c, i]).filter(([c]) => c.t === ChannelType.GuildCategory),
    ...snapshot.channels.map((c, i) => [c, i]).filter(([c]) => c.t !== ChannelType.GuildCategory)
  ];
  for (const [c, i] of order) {
    const build = type => {
      const opts = { name: c.n, type, permissionOverwrites: overwrites(c.o), reason };
      if (c.p >= 0 && chIds[c.p]) opts.parent = chIds[c.p];
      if (TEXTY.has(type) || type === ChannelType.GuildForum) {
        if (c.tp) opts.topic = c.tp;
        if (c.nsfw) opts.nsfw = true;
        if (c.rl) opts.rateLimitPerUser = c.rl;
        if (c.aa) opts.defaultAutoArchiveDuration = c.aa;
      }
      if (type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice) {
        if (c.b) opts.bitrate = Math.min(c.b, guild.maximumBitrate || 96000);
        if (c.ul) opts.userLimit = c.ul;
        if (c.rg) opts.rtcRegion = c.rg;
        if (c.vq && type === ChannelType.GuildVoice) opts.videoQualityMode = c.vq;
        if (c.nsfw) opts.nsfw = true;
      }
      if (type === ChannelType.GuildForum) {
        if (c.tags?.length) opts.availableTags = c.tags.map(t => ({ name: t.name, moderated: !!t.moderated, ...(t.emoji ? { emoji: { id: null, name: t.emoji } } : {}) }));
        if (c.so !== undefined) opts.defaultSortOrder = c.so;
        if (c.fl) opts.defaultForumLayout = c.fl;
        if (c.tr) opts.defaultThreadRateLimitPerUser = c.tr;
      }
      return opts;
    };
    try {
      let ch;
      try { ch = await guild.channels.create(build(c.t)); }
      catch (e) {
        const fb = FALLBACK_TYPE[c.t];
        if (fb === undefined) throw e;                          // note: GuildText is 0, so never test it for truthiness
        ch = await guild.channels.create(build(fb));            // Community-only type on a normal server
        failed.push(`#${c.n}: created as ${ChannelType[fb] ?? fb} (original type needs Community)`);
      }
      chIds[i] = ch.id; prog.c.channels.done++;
    } catch (e) { failed.push(`channel ${c.n}: ${short(e)}`); }
    await flush(); await wait(200);
  }
  try {
    await stage('Arranging channels…');
    // Every channel gets its rank inside its own group (categories + uncategorised together, or one category).
    // The snapshot is already sorted by the original position, so the rank reproduces the original order.
    const groups = new Map();
    snapshot.channels.forEach((c, i) => {
      if (!chIds[i]) return;
      const key = c.t === ChannelType.GuildCategory ? 'top' : (c.p >= 0 && chIds[c.p] ? `p${c.p}` : 'top');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(chIds[i]);
    });
    const updates = [];
    for (const ids of groups.values()) ids.forEach((id, k) => updates.push({ channel: id, position: k }));
    if (updates.length) await guild.channels.setPositions(updates);
  } catch (e) { failed.push(`channel order: ${short(e)}`); }

  // ---- 5) server settings ----
  const steps = [];
  if (g) {
    const edit = (label, patch, skip = false) => steps.push({ label, skip, run: () => guild.edit({ ...patch, reason }) });
    edit('server name', { name: g.n });
    edit('server icon', { icon: g.ic || null }, !g.ic && !guild.icon);
    edit('server banner', { banner: g.bn || null }, !g.bn && !guild.banner);
    edit('invite splash', { splash: g.sp || null }, !g.sp && !guild.splash);
    edit('description & language', { preferredLocale: g.loc, ...(g.ds || guild.description ? { description: g.ds || null } : {}) });
    edit('verification level', { verificationLevel: g.vl });
    edit('content filter', { explicitContentFilter: g.cf });
    edit('default notifications', { defaultMessageNotifications: g.dn });
    edit('AFK channel', { afkChannel: g.afk >= 0 ? chIds[g.afk] || null : null, afkTimeout: g.at });
    edit('system channel', { systemChannel: g.sys >= 0 ? chIds[g.sys] || null : null, systemChannelFlags: g.sf });
    steps.push({
      label: 'rules / updates channels', skip: !guild.features?.includes('COMMUNITY') || (g.rules < 0 && g.upd < 0),
      run: () => guild.edit({ rulesChannel: g.rules >= 0 ? chIds[g.rules] || null : undefined, publicUpdatesChannel: g.upd >= 0 ? chIds[g.upd] || null : undefined, reason })
    });
    steps.push({ label: '@everyone permissions', run: () => guild.roles.everyone.setPermissions(new PermissionsBitField(isAdmin ? BigInt(g.ev) : (BigInt(g.ev) & meBits)), reason) });
  }
  prog.c.server.total = steps.length;
  if (steps.length) {
    await stage('Applying server settings…');
    for (const s of steps) {
      if (!s.skip) { try { await s.run(); } catch (e) { failed.push(`${s.label}: ${short(e)}`); await flush(); await wait(300); continue; } }
      prog.c.server.done++; await flush(); await wait(300);
    }
  }
  // Community-required channels (rules / updates) can be deleted once the server points at new ones.
  // If the template did not define them, point both at the first new text channel (Community needs *some* channel).
  if (kept.length && guild.features?.includes('COMMUNITY')) {
    try {
      const firstText = chIds.find((id, i) => id && snapshot.channels[i].t === ChannelType.GuildText) || null;
      const rulesId = (g && g.rules >= 0 && chIds[g.rules]) || firstText;
      const updId = (g && g.upd >= 0 && chIds[g.upd]) || firstText;
      if (rulesId || updId) await guild.edit({ ...(rulesId ? { rulesChannel: rulesId } : {}), ...(updId ? { publicUpdatesChannel: updId } : {}), reason });
    } catch (e) { failed.push(`rules / updates channels: ${short(e)}`); }
  }
  for (const ch of kept) {
    try { await ch.delete(reason); }
    catch (e) { failed.push(`#${ch.name} was kept (${codeOf(e) === 50074 ? 'required by Community' : short(e)})`); }
  }

  // ---- 6) emojis & stickers ----
  if (prog.c.emojis.total || prog.c.stickers.total) {
    await stage('Replacing emojis & stickers…');
    await guild.emojis.fetch().catch(() => {});
    for (const e of [...guild.emojis.cache.values()]) if (!e.managed) await e.delete(reason).catch(() => {});
    await guild.stickers.fetch().catch(() => {});
    for (const s of [...guild.stickers.cache.values()]) await s.delete(reason).catch(() => {});
  }
  if (prog.c.emojis.total) {
    await stage('Creating emojis…');
    for (const e of snapshot.emojis) {
      try { await guild.emojis.create({ attachment: e.d, name: e.n, reason }); prog.c.emojis.done++; }
      catch (err) { failed.push(`emoji :${e.n}: ${short(err)}`); if (/maximum|limit|30008/i.test(String(err?.message)) || codeOf(err) === 30008) break; }
      await flush(); await wait(400);
    }
  }
  if (prog.c.stickers.total) {
    await stage('Creating stickers…');
    for (const s of snapshot.stickers) {
      try {
        await guild.stickers.create({ file: { attachment: Buffer.from(s.d, 'base64'), name: s.f === 4 ? 'sticker.gif' : 'sticker.png' }, name: s.n, tags: s.tg || s.n, description: s.ds, reason });
        prog.c.stickers.done++;
      } catch (err) { failed.push(`sticker ${s.n}: ${short(err)}`); if (codeOf(err) === 30039) break; }
      await flush(); await wait(500);
    }
  }

  // ---- 7) bot settings ----
  if (prog.c.bot.total) {
    await stage('Loading bot settings…');
    const decoded = snapshot.config ? decodeIds(snapshot.config, chIds, roleIds) : {};
    const before = db.getConfig(guild.id);
    let current = { ...before };
    for (const key of sections) {
      try {
        current[key] = decoded[key];
        if (key === 'birthdays' && current[key]) current[key] = { ...current[key], entries: before.birthdays?.entries || {} };
        db.replaceConfig(guild.id, current);
        prog.c.bot.done++;
      } catch (e) { failed.push(`bot setting ${key}: ${short(e)}`); }
      await flush(); await wait(40);
    }
    if (extra.includes('sticky')) {
      try {
        for (const s of db.listStickies(guild.id)) db.deleteSticky(s.channelId);
        for (const s of snapshot.sticky) { const id = chIds[s.ch]; if (id) db.saveSticky(guild.id, id, { data: decodeIds(s.data, chIds, roleIds), enabled: !!s.en, createdBy: s.by || null }); }
        prog.c.bot.done++;
      } catch (e) { failed.push(`sticky messages: ${short(e)}`); }
      await flush();
    }
    if (extra.includes('embeds')) {
      try {
        for (const e of db.listEmbeds(guild.id)) db.deleteEmbed(guild.id, e.name);
        for (const e of snapshot.embeds) db.saveEmbed(guild.id, e.name, decodeIds(e.data, chIds, roleIds));
        prog.c.bot.done++;
      } catch (e) { failed.push(`saved embeds: ${short(e)}`); }
      await flush();
    }
    if (extra.includes('whitelist')) {
      try { for (const uid of snapshot.wl) db.addToWhitelist(guild.id, uid); prog.c.bot.done++; }
      catch (e) { failed.push(`anti-nuke whitelist: ${short(e)}`); }
      await flush();
    }
  }

  // ---- 8) panels (ticket / applications / birthdays / role panels) ----
  const cfgNow = db.getConfig(guild.id);
  const jobs = [];
  for (const p of snapshot.panels || []) if (chIds[p.ch]) jobs.push({ kind: p.type, channelId: chIds[p.ch] });
  for (const p of cfgNow.buttonRolePanels || []) if (p.channelId && (p.buttons || []).length && p.enabled !== false) jobs.push({ kind: 'buttonrole', panel: p, channelId: p.channelId });
  for (const p of cfgNow.reactionRolePanels || []) if (p.channelId && (p.mappings || []).length && p.enabled !== false) jobs.push({ kind: 'reactionrole', panel: p, channelId: p.channelId });
  prog.c.panels.total = jobs.length;
  if (jobs.length) {
    await stage('Posting panels…');
    for (const job of jobs) {
      try { await postPanel(guild, job); prog.c.panels.done++; }
      catch (e) { failed.push(`${job.kind} panel: ${short(e)}`); }
      await flush(); await wait(400);
    }
  }

  // ---- 9) finish ----
  await stage('Finished ✅');
  await flush(true);
  const result = {
    channelsCreated: prog.c.channels.done, rolesCreated: prog.c.roles.done, serverSettings: prog.c.server.done,
    botSettings: prog.c.bot.done, emojis: prog.c.emojis.done, stickers: prog.c.stickers.done, panels: prog.c.panels.done,
    failed, progressChannel: pch, totals: Object.fromEntries(Object.entries(prog.c).map(([k, v]) => [k, v.total]))
  };

  if (pch) {
    try {
      const t = result.totals;
      const summary = [
        `📁 **${result.channelsCreated}/${t.channels}** channels created`,
        `🏷️ **${result.rolesCreated}/${t.roles}** roles created`,
        t.server ? `⚙️ **${result.serverSettings}/${t.server}** server settings loaded` : null,
        t.bot ? `🤖 **${result.botSettings}/${t.bot}** bot settings loaded` : null,
        t.emojis ? `😀 **${result.emojis}/${t.emojis}** emojis created` : null,
        t.stickers ? `🏷️ **${result.stickers}/${t.stickers}** stickers created` : null,
        t.panels ? `🎟️ **${result.panels}/${t.panels}** panels posted` : null
      ].filter(Boolean).join('\n');
      const problems = failed.length ? `\n\n**${failed.length} item(s) had problems:**\n${failed.slice(0, 12).map(x => '• ' + x).join('\n')}${failed.length > 12 ? `\n• …and ${failed.length - 12} more` : ''}` : '';
      const note = '\n\n-# Members\' role assignments are not part of a template — give your roles back to members as needed.';
      const embed = (failed.length ? ui.warnEmbed : ui.okEmbed)('✅ Template Loaded', `The server was rebuilt from **${snapshot.name || 'the template'}**.\n\n${summary}${problems}${note}`);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${DELETE_ID}:${user.id}`).setLabel('Delete Progress Channel').setStyle(ButtonStyle.Danger)
      );
      await pch.send({ embeds: [embed], components: [row] });
    } catch (e) { console.error('[Template] completion message failed:', e); }
  }
  return result;
}

// ---- panel re-posting (mirrors the bot's own panel builders) ------------------------
async function postPanel(guild, job) {
  const channel = guild.channels.cache.get(job.channelId) || await guild.channels.fetch(job.channelId).catch(() => null);
  if (!channel?.isTextBased()) throw new Error('panel channel is unavailable');
  const cfg = db.getConfig(guild.id);

  if (job.kind === 'ticket') {
    db.saveConfig(guild.id, { ticket: { panelChannelId: channel.id } });
    return channel.send({ embeds: [ui.ticketPanelEmbed(guild.name, db.getConfig(guild.id).ticket)], components: [ui.ticketPanelRow()] });
  }
  if (job.kind === 'staffapp') {
    const a = cfg.staffApplications || {};
    db.saveConfig(guild.id, { staffApplications: { panelChannelId: channel.id } });
    return channel.send({
      embeds: [ui.base(a.title || 'Staff Applications').setDescription(a.description || 'Click Apply to start your application.')],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('staffapp_apply').setLabel('Apply').setStyle(ButtonStyle.Success))]
    });
  }
  if (job.kind === 'birthday') {
    db.saveConfig(guild.id, { birthdays: { panelChannelId: channel.id } });
    return channel.send({
      embeds: [ui.birthdaySetupEmbed(db.getConfig(guild.id).birthdays)],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('birthday_set').setLabel('Set Birthday').setStyle(ButtonStyle.Primary))]
    });
  }
  if (job.kind === 'buttonrole') {
    const p = job.panel;
    const buttons = (p.buttons || []).filter(b => guild.roles.cache.has(b.roleId));
    if (!buttons.length) throw new Error('none of the panel roles exist');
    const e = ui.base(p.title || 'Choose your roles').setDescription(p.description || 'Press a button to get or remove a role.');
    if (p.image) e.setImage(p.image);
    let components = [];
    for (let i = 0; i < buttons.length; i += 5) {
      const row = new ActionRowBuilder();
      for (const b of buttons.slice(i, i + 5)) row.addComponents(new ButtonBuilder().setCustomId(`rolebtn:${p.id}:${b.roleId}`).setLabel(b.label || 'Role').setStyle(ButtonStyle.Primary));
      components.push(row);
    }
    if (p.embedType === 'selection') {
      const menu = new StringSelectMenuBuilder().setCustomId(`role_select:${p.id}`).setPlaceholder('Choose a role…')
        .addOptions(buttons.slice(0, 25).map(b => ({ label: (b.label || 'Role').slice(0, 100), value: b.roleId })));
      components = [new ActionRowBuilder().addComponents(menu)];
    }
    const msg = await channel.send({ embeds: [e], components });
    db.upsertPanel(guild.id, 'button', { ...p, buttons, messageId: msg.id });
    return msg;
  }
  if (job.kind === 'reactionrole') {
    const p = job.panel;
    const mappings = (p.mappings || []).filter(m => guild.roles.cache.has(m.roleId));
    if (!mappings.length) throw new Error('none of the panel roles exist');
    const e = ui.base(p.title || 'Choose your roles').setDescription(p.description || 'React below to receive or remove a role.');
    if (p.image) e.setImage(p.image);
    const msg = await channel.send({ embeds: [e] });
    for (const m of mappings) await msg.react(m.emoji).catch(() => {});
    db.upsertPanel(guild.id, 'reaction', { ...p, mappings, messageId: msg.id });
    return msg;
  }
  throw new Error(`unknown panel type ${job.kind}`);
}

// ---- "Delete Progress Channel" button ----------------------------------------------
async function handleInteraction(i) {
  const id = i.customId;
  if (!id || !id.startsWith(`${DELETE_ID}:`)) return false;
  const uid = id.split(':')[2];
  const allowed = i.user.id === uid || i.memberPermissions?.has(PermissionFlagsBits.Administrator);
  if (!allowed) {
    await i.reply({ embeds: [ui.errorEmbed('Not Allowed', 'Only the person who loaded the template or an Administrator can delete this channel.')], ephemeral: true }).catch(() => {});
    return true;
  }
  await i.deferUpdate().catch(() => {});
  try { await i.channel.delete('AunXz /template load finished — progress channel removed'); }
  catch (e) { await i.followUp({ embeds: [ui.errorEmbed('Could Not Delete', short(e))], ephemeral: true }).catch(() => {}); }
  return true;
}

module.exports = {
  MAX_CODE_LENGTH, createSnapshot, encodeSnapshot, decodeSnapshot, resolveSnapshot, runLoad, handleInteraction,
  _internal: { encodeIds, decodeIds, collectCustomIds }
};
