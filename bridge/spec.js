'use strict';
// bridge/spec.js — the instruction format the AI sends to the bot, and its validator.
//
// No discord.js import here on purpose: the web side and the tests can validate quickly without it.
// The bot's templateBridge.js passes the REAL discord.js permission names via `opts.permissionNames`,
// so the bot stays the final authority even if this static list drifts.

const SPEC_VERSION = 1;

const LIMITS = {
  roles: 250,                 // same as template.js MAX_ROLES
  channels: 500,              // same as template.js MAX_CHANNELS (categories count too)
  perCategory: 50,            // Discord hard limit
  name: 100,
  topic: 1024,
  description: 500,
  overwritesPerChannel: 50,
  maxJsonBytes: 400 * 1024
};

// Static copy of discord.js v14 PermissionFlagsBits keys (used when the bot's list is not supplied).
const PERMISSION_NAMES = [
  'CreateInstantInvite', 'KickMembers', 'BanMembers', 'Administrator', 'ManageChannels', 'ManageGuild',
  'AddReactions', 'ViewAuditLog', 'PrioritySpeaker', 'Stream', 'ViewChannel', 'SendMessages',
  'SendTTSMessages', 'ManageMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'MentionEveryone',
  'UseExternalEmojis', 'ViewGuildInsights', 'Connect', 'Speak', 'MuteMembers', 'DeafenMembers', 'MoveMembers',
  'UseVAD', 'ChangeNickname', 'ManageNicknames', 'ManageRoles', 'ManageWebhooks', 'ManageGuildExpressions',
  'UseApplicationCommands', 'RequestToSpeak', 'ManageEvents', 'ManageThreads', 'CreatePublicThreads',
  'CreatePrivateThreads', 'UseExternalStickers', 'SendMessagesInThreads', 'UseEmbeddedActivities',
  'ModerateMembers', 'ViewCreatorMonetizationAnalytics', 'UseSoundboard', 'CreateGuildExpressions',
  'CreateEvents', 'UseExternalSounds', 'SendVoiceMessages', 'SendPolls', 'UseExternalApps'
];

const CHANNEL_TYPES = ['text', 'voice', 'announcement', 'stage', 'forum'];
const TEXTY = new Set(['text', 'announcement', 'forum']);
const VOICEY = new Set(['voice', 'stage']);

// Baseline @everyone permissions used when settings are supplied without everyonePermissions.
const DEFAULT_EVERYONE = [
  'CreateInstantInvite', 'ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads',
  'EmbedLinks', 'AttachFiles', 'AddReactions', 'UseExternalEmojis', 'ReadMessageHistory', 'Connect', 'Speak',
  'Stream', 'UseVAD', 'ChangeNickname', 'UseApplicationCommands'
];

class BridgeError extends Error {
  constructor(code, message, errors) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;          // invalid_spec | too_large | unavailable | unauthorized | rate_limited | internal
    this.errors = errors || [];
  }
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v.trim() : '');

function validateSpec(input, opts = {}) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push(`${path}: ${message}`);
  const permSet = new Set(opts.permissionNames || PERMISSION_NAMES);

  if (!isObj(input)) { err('$', 'spec must be a JSON object'); return { ok: false, errors, warnings }; }
  if (input.specVersion !== undefined && input.specVersion !== SPEC_VERSION) err('specVersion', `must be ${SPEC_VERSION}`);

  const out = { specVersion: SPEC_VERSION, name: '', description: '', roles: [], channels: [], categories: [], settings: null };

  // ---- name / description ----
  out.name = str(input.name);
  if (!out.name || out.name.length > LIMITS.name) err('name', `required, 1-${LIMITS.name} characters`);
  if (input.description !== undefined) {
    if (typeof input.description !== 'string' || input.description.length > LIMITS.description) err('description', `must be a string up to ${LIMITS.description} characters`);
    else out.description = input.description.trim();
  }

  const checkPerms = (path, list) => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) { err(path, 'must be an array of permission names'); return []; }
    const seen = new Set();
    list.forEach((p, i) => {
      if (typeof p !== 'string' || !permSet.has(p)) err(`${path}[${i}]`, `unknown permission ${JSON.stringify(p)}`);
      else seen.add(p);
    });
    return [...seen];
  };

  // ---- roles ----
  const roleNames = new Map(); // lower-case name -> canonical name
  if (input.roles !== undefined && !Array.isArray(input.roles)) err('roles', 'must be an array');
  const rolesIn = Array.isArray(input.roles) ? input.roles : [];
  if (rolesIn.length > LIMITS.roles) err('roles', `at most ${LIMITS.roles} roles`);
  rolesIn.slice(0, LIMITS.roles).forEach((r, i) => {
    const p = `roles[${i}]`;
    if (!isObj(r)) return err(p, 'must be an object');
    const name = str(r.name);
    if (!name || name.length > LIMITS.name) return err(`${p}.name`, `required, 1-${LIMITS.name} characters`);
    if (/^@?everyone$/i.test(name) || name === '@here') return err(`${p}.name`, 'reserved name');
    if (roleNames.has(name.toLowerCase())) return err(`${p}.name`, `duplicate role name ${JSON.stringify(name)}`);
    roleNames.set(name.toLowerCase(), name);
    let color = 0;
    if (r.color !== undefined && r.color !== null && r.color !== '') {
      if (typeof r.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(r.color)) err(`${p}.color`, 'must be a hex color like "#5865f2"');
      else color = parseInt(r.color.slice(1), 16);
    }
    let emoji;
    if (r.emoji !== undefined && r.emoji !== null && r.emoji !== '') {
      if (typeof r.emoji !== 'string' || r.emoji.length > 16 || /[A-Za-z0-9]/.test(r.emoji)) err(`${p}.emoji`, 'must be a single unicode emoji');
      else emoji = r.emoji;
    }
    out.roles.push({
      name, color, hoist: !!r.hoist, mentionable: !!r.mentionable,
      permissions: checkPerms(`${p}.permissions`, r.permissions), emoji
    });
  });

  // ---- overwrites ----
  const checkOverwrites = (path, list) => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) { err(path, 'must be an array'); return []; }
    if (list.length > LIMITS.overwritesPerChannel) err(path, `at most ${LIMITS.overwritesPerChannel} overwrites`);
    const res = [];
    const used = new Set();
    list.slice(0, LIMITS.overwritesPerChannel).forEach((o, i) => {
      const p = `${path}[${i}]`;
      if (!isObj(o)) return err(p, 'must be an object');
      const rn = str(o.role);
      let role;
      if (/^@?everyone$/i.test(rn)) role = '@everyone';
      else if (roleNames.has(rn.toLowerCase())) role = roleNames.get(rn.toLowerCase());
      else return err(`${p}.role`, `unknown role ${JSON.stringify(o.role)} (use "@everyone" or a name from roles)`);
      if (used.has(role)) return err(`${p}.role`, `duplicate overwrite for ${JSON.stringify(role)}`);
      used.add(role);
      const allow = checkPerms(`${p}.allow`, o.allow);
      const deny = checkPerms(`${p}.deny`, o.deny);
      const both = allow.filter(x => deny.includes(x));
      if (both.length) err(p, `permission(s) in both allow and deny: ${both.join(', ')}`);
      if (!allow.length && !deny.length) { warn(p, 'empty overwrite ignored'); return; }
      res.push({ role, allow, deny });
    });
    return res;
  };

  // ---- channels ----
  let channelTotal = 0;
  const parseChannel = (c, path) => {
    if (!isObj(c)) { err(path, 'must be an object'); return null; }
    const type = c.type === undefined ? 'text' : c.type;
    if (!CHANNEL_TYPES.includes(type)) { err(`${path}.type`, `unknown type ${JSON.stringify(c.type)}; use ${CHANNEL_TYPES.join(', ')}`); return null; }
    let name = str(c.name);
    if (!name || name.length > LIMITS.name) { err(`${path}.name`, `required, 1-${LIMITS.name} characters`); return null; }
    if (TEXTY.has(type)) {
      const fixed = name.toLowerCase().replace(/\s+/g, '-');
      if (fixed !== name) { warn(`${path}.name`, `${JSON.stringify(name)} adjusted to ${JSON.stringify(fixed)} (text channel names are lowercase, no spaces)`); name = fixed; }
    }
    const ch = { name, type, overwrites: checkOverwrites(`${path}.overwrites`, c.overwrites) };
    const intIn = (key, min, max) => {
      if (c[key] === undefined || c[key] === null) return undefined;
      if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) { err(`${path}.${key}`, `must be an integer ${min}-${max}`); return undefined; }
      return c[key];
    };
    if (c.topic !== undefined && c.topic !== null && c.topic !== '') {
      if (typeof c.topic !== 'string' || c.topic.length > LIMITS.topic) err(`${path}.topic`, `must be a string up to ${LIMITS.topic} characters`);
      else if (TEXTY.has(type)) ch.topic = c.topic.trim();
      else warn(`${path}.topic`, `ignored for ${type} channels`);
    }
    if (c.nsfw !== undefined && TEXTY.has(type)) ch.nsfw = !!c.nsfw;
    if (TEXTY.has(type)) { const s = intIn('slowmode', 0, 21600); if (s) ch.slowmode = s; }
    if (VOICEY.has(type)) {
      const b = intIn('bitrate', 8000, 96000); if (b) ch.bitrate = b;
      const u = intIn('userLimit', 0, type === 'stage' ? 10000 : 99); if (u) ch.userLimit = u;
    }
    channelTotal++;
    return ch;
  };

  if (input.channels !== undefined && !Array.isArray(input.channels)) err('channels', 'must be an array (channels without a category)');
  (Array.isArray(input.channels) ? input.channels : []).forEach((c, i) => {
    const ch = parseChannel(c, `channels[${i}]`);
    if (ch) out.channels.push(ch);
  });

  if (input.categories !== undefined && !Array.isArray(input.categories)) err('categories', 'must be an array');
  (Array.isArray(input.categories) ? input.categories : []).forEach((cat, i) => {
    const p = `categories[${i}]`;
    if (!isObj(cat)) return err(p, 'must be an object');
    const name = str(cat.name);
    if (!name || name.length > LIMITS.name) return err(`${p}.name`, `required, 1-${LIMITS.name} characters`);
    channelTotal++; // the category itself is a channel for Discord's 500 cap
    const kids = [];
    if (cat.channels !== undefined && !Array.isArray(cat.channels)) err(`${p}.channels`, 'must be an array');
    const list = Array.isArray(cat.channels) ? cat.channels : [];
    if (list.length > LIMITS.perCategory) err(`${p}.channels`, `a category holds at most ${LIMITS.perCategory} channels`);
    list.slice(0, LIMITS.perCategory).forEach((c, j) => {
      const ch = parseChannel(c, `${p}.channels[${j}]`);
      if (ch) kids.push(ch);
    });
    out.categories.push({ name, overwrites: checkOverwrites(`${p}.overwrites`, cat.overwrites), channels: kids });
  });
  if (channelTotal > LIMITS.channels) err('categories', `too many channels: ${channelTotal} (categories count too, max ${LIMITS.channels})`);
  if (!out.channels.length && !out.categories.length) err('categories', 'the template needs at least one channel');

  // ---- settings (optional) ----
  if (input.settings !== undefined && input.settings !== null) {
    const s = input.settings;
    if (!isObj(s)) err('settings', 'must be an object');
    else {
      const set = { };
      if (s.verificationLevel !== undefined) {
        if (!Number.isInteger(s.verificationLevel) || s.verificationLevel < 0 || s.verificationLevel > 4) err('settings.verificationLevel', 'must be an integer 0-4');
        else set.verificationLevel = s.verificationLevel;
      }
      if (s.contentFilter !== undefined) {
        if (!Number.isInteger(s.contentFilter) || s.contentFilter < 0 || s.contentFilter > 2) err('settings.contentFilter', 'must be an integer 0-2');
        else set.contentFilter = s.contentFilter;
      }
      if (s.defaultNotifications !== undefined) {
        if (!['all', 'mentions'].includes(s.defaultNotifications)) err('settings.defaultNotifications', 'must be "all" or "mentions"');
        else set.defaultNotifications = s.defaultNotifications;
      }
      if (s.afkTimeout !== undefined) {
        if (![60, 300, 900, 1800, 3600].includes(s.afkTimeout)) err('settings.afkTimeout', 'must be one of 60, 300, 900, 1800, 3600');
        else set.afkTimeout = s.afkTimeout;
      }
      set.everyonePermissions = s.everyonePermissions === undefined ? DEFAULT_EVERYONE.filter(p => permSet.has(p)) : checkPerms('settings.everyonePermissions', s.everyonePermissions);
      out.settings = set;
    }
  }

  return { ok: errors.length === 0, errors, warnings, spec: errors.length ? undefined : out };
}

const formatErrors = errors => errors.map(e => `${e.path}: ${e.message}`).join('\n');

module.exports = {
  SPEC_VERSION, LIMITS, PERMISSION_NAMES, CHANNEL_TYPES, DEFAULT_EVERYONE, BridgeError, validateSpec, formatErrors
};
