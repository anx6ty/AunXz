'use strict';
// bridge/templateBridge.js — turns the AI's JSON spec into a signed AunXz template code.
//
// PURE COMPUTATION: no guild, channel, role or message is ever touched here. The only side effect is
// (optionally) saving the finished code in the existing `server_templates` table so it can be loaded
// later with its short code (AX-XXXXXXXX) via /template load.
//
// The bot's own template.js does the signing (encodeSnapshot) and the verification (decodeSnapshot),
// so every code made here is guaranteed to be readable by /template load.

const { PermissionsBitField, PermissionFlagsBits, ChannelType } = require('discord.js');
const { LIMITS, BridgeError, validateSpec, formatErrors } = require('./spec');

let deps = null; // { template, db } — loaded lazily so requiring this file stays cheap; replaceable in tests
function getDeps() {
  if (!deps) deps = { template: require('../template'), db: require('../database') };
  return deps;
}

const TYPE_MAP = () => ({
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  announcement: ChannelType.GuildAnnouncement,
  stage: ChannelType.GuildStageVoice,
  forum: ChannelType.GuildForum
});

const bits = names => new PermissionsBitField(names).bitfield.toString();

function buildSnapshot(spec) {
  const types = TYPE_MAP();
  const roleIndex = new Map(spec.roles.map((r, i) => [r.name, i]));
  const keyOf = role => (role === '@everyone' ? 'e' : roleIndex.get(role));

  const roles = spec.roles.map(r => ({
    n: r.name, c: r.color, h: r.hoist ? 1 : 0, m: r.mentionable ? 1 : 0,
    p: bits(r.permissions), ue: r.emoji || undefined
  }));

  const toOverwrites = list => list.map(o => [keyOf(o.role), bits(o.allow), bits(o.deny)]);

  // A channel created through the API does not inherit its category's overwrites, so we merge them in:
  // the category's overwrites first, then the channel's own (which win for the same role).
  const merged = (catOw, ownOw) => {
    const own = new Set(ownOw.map(o => o.role));
    return [...catOw.filter(o => !own.has(o.role)), ...ownOw];
  };

  const channels = [];
  const pushChannel = (c, parent, inheritedOw) => {
    const row = { n: c.name, t: types[c.type], p: parent, o: toOverwrites(merged(inheritedOw, c.overwrites)) };
    if (c.topic) row.tp = c.topic;
    if (c.nsfw) row.nsfw = 1;
    if (c.slowmode) row.rl = c.slowmode;
    if (c.bitrate) row.b = c.bitrate;
    if (c.userLimit) row.ul = c.userLimit;
    channels.push(row);
  };

  for (const c of spec.channels) pushChannel(c, -1, []);
  for (const cat of spec.categories) {
    const catIndex = channels.length;
    channels.push({ n: cat.name, t: ChannelType.GuildCategory, p: -1, o: toOverwrites(cat.overwrites) });
    for (const c of cat.channels) pushChannel(c, catIndex, cat.overwrites);
  }

  const snapshot = {
    v: 2, id: 'web', name: spec.name, at: Date.now(),
    roles, channels,
    emojis: [], stickers: [], panels: [], sticky: [], embeds: [], wl: []
  };

  // Server settings are only included when the spec asks for them. The loader needs ALL of these keys.
  if (spec.settings) {
    const s = spec.settings;
    snapshot.g = {
      n: spec.name,
      ds: spec.description && spec.description.length <= 120 ? spec.description : undefined,
      vl: s.verificationLevel, cf: s.contentFilter,
      dn: s.defaultNotifications === undefined ? undefined : (s.defaultNotifications === 'all' ? 0 : 1),
      at: s.afkTimeout,
      afk: -1, sys: -1, sf: 0, rules: -1, upd: -1, com: 0,
      ev: bits(s.everyonePermissions)
    };
  }
  return snapshot;
}

/**
 * @param {object} input   the JSON spec (see bridge/spec.js)
 * @param {object} [opts]  { requestedBy: string, persist: boolean (default true) }
 * @returns {{ code, shortCode, fitsInCommand, stats, warnings, snapshot }}
 * @throws {BridgeError}   code 'too_large' | 'invalid_spec' (with .errors[]) | 'internal'
 */
function buildTemplateFromSpec(input, opts = {}) {
  const requestedBy = String(opts.requestedBy || 'web').slice(0, 64);

  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(input) || ''); } catch { throw new BridgeError('invalid_spec', 'Spec is not valid JSON data.', [{ path: '$', message: 'not serializable' }]); }
  if (size > LIMITS.maxJsonBytes) throw new BridgeError('too_large', `Spec is too large (${size} bytes, max ${LIMITS.maxJsonBytes}).`);

  // The bot is the final authority: validate against the REAL discord.js permission names.
  const checked = validateSpec(input, { permissionNames: Object.keys(PermissionFlagsBits) });
  if (!checked.ok) throw new BridgeError('invalid_spec', `Invalid template spec:\n${formatErrors(checked.errors)}`, checked.errors);
  const warnings = [...checked.warnings];

  const { template, db } = getDeps();
  const snapshot = buildSnapshot(checked.spec);
  const code = template.encodeSnapshot(snapshot);

  // Self-check with the bot's own reader: a code that cannot be read back is never returned.
  let back;
  try { back = template.decodeSnapshot(code); }
  catch (e) { throw new BridgeError('internal', `Generated code failed its own check: ${e.message}`); }
  if (back.roles.length !== snapshot.roles.length || back.channels.length !== snapshot.channels.length) {
    throw new BridgeError('internal', 'Generated code failed its own check: counts differ after decoding.');
  }

  const fitsInCommand = code.length <= template.MAX_CODE_LENGTH;
  if (!fitsInCommand) warnings.push(`The full code is ${code.length} characters, longer than Discord allows in the /template load code option (${template.MAX_CODE_LENGTH}). Use the short code or upload the code as a .txt file with the file option.`);

  let shortCode = null;
  if (opts.persist !== false) {
    try { shortCode = db.saveTemplate(`web:${requestedBy}`, snapshot.name, code, requestedBy); }
    catch (e) { warnings.push(`Could not save a short code in the database: ${String(e.message).slice(0, 120)}`); }
  }

  const categories = snapshot.channels.filter(c => c.t === ChannelType.GuildCategory).length;
  return {
    code, shortCode, fitsInCommand,
    stats: { roles: snapshot.roles.length, categories, channels: snapshot.channels.length - categories, bytes: code.length },
    warnings, snapshot
  };
}

module.exports = {
  buildTemplateFromSpec,
  _buildSnapshot: buildSnapshot,
  _setDeps: d => { deps = d; }   // for tests
};
