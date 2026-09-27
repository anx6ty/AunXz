// ui.js — every embed / button / select-menu builder lives here so the bot has one visual style.
// Note on Discord's API: buttons and select menus can never be rendered physically inside an
// embed's body — Discord only allows components in a row attached below a message's embed(s).
// To make the bot still feel "embed native", every panel here uses ONE embed + ONE compact
// action row directly beneath it (no bare unstyled text, no naked prompts), so visually it reads
// as a single unified panel rather than "an embed, then a separate control area".

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, UserSelectMenuBuilder, RoleSelectMenuBuilder,
  ChannelType, PermissionFlagsBits
} = require('discord.js');
const db = require('./database');

const THEME = 0x2b2d31;
const OK = 0x57f287;
const WARN = 0xfee75c;
const DANGER = 0xed4245;
const BRAND_FOOTER = 'AIO • all-in-one';


// ---------------- DISCORD COMPONENTS V2 PANELS ----------------
// Classic Discord embeds cannot contain buttons. Components V2 containers can render
// the embed-like content and its buttons/select menus as one unified bordered panel.
const COMPONENTS_V2_FLAG = 1 << 15;

function componentJson(value) {
  return value && typeof value.toJSON === 'function' ? value.toJSON() : value;
}

function embedToV2Parts(embed) {
  const e = componentJson(embed) || {};
  const parts = [];
  const lines = [];
  if (e.author?.name) lines.push(`-# ${e.author.name}`);
  if (e.title) lines.push(`## ${e.title}`);
  if (e.description) lines.push(e.description);
  if (e.fields?.length) {
    for (const field of e.fields) lines.push(`**${field.name || ''}**\n${field.value || ''}`);
  }
  if (e.footer?.text) lines.push(`-# ${e.footer.text}`);
  if (lines.length) parts.push({ type: 10, content: lines.join('\n\n') });

  const media = [];
  if (e.image?.url) media.push({ media: { url: e.image.url }, description: e.title || 'Image' });
  if (e.thumbnail?.url) media.push({ media: { url: e.thumbnail.url }, description: e.title || 'Thumbnail' });
  if (media.length) parts.push({ type: 12, items: media });
  return parts;
}

function toComponentsV2(payload, force = false) {
  if (!payload || typeof payload !== 'object') return payload;
  if (payload.flags && (Number(payload.flags) & COMPONENTS_V2_FLAG)) return payload;

  const embeds = Array.isArray(payload.embeds) ? payload.embeds.filter(Boolean) : [];
  const rawComponents = payload.components
    ? (Array.isArray(payload.components) ? payload.components.flat(Infinity).filter(Boolean) : [payload.components])
    : [];
  const hasInteractiveComponents = rawComponents.length > 0;
  if (!force && !embeds.length && !hasInteractiveComponents) return payload;
  if (!embeds.length && !hasInteractiveComponents) return payload;

  const panel = [];
  if (payload.content) panel.push({ type: 10, content: String(payload.content) });

  for (let i = 0; i < embeds.length; i++) {
    panel.push(...embedToV2Parts(embeds[i]));
    if (i < embeds.length - 1) panel.push({ type: 14, spacing: 1 });
  }

  if (rawComponents.length) {
    if (panel.length) panel.push({ type: 14, spacing: 1 });
    for (const component of rawComponents) {
      const json = componentJson(component);
      if (json && typeof json === 'object') panel.push(json);
    }
  }

  if (!panel.length) return payload;
  const container = { type: 17, components: panel.slice(0, 10) };
  const first = embeds[0] ? componentJson(embeds[0]) || {} : {};
  if (first.color != null) container.accent_color = first.color;

  const out = {
    ...payload,
    components: [container],
    flags: (Number(payload.flags) || 0) | COMPONENTS_V2_FLAG
  };
  delete out.embeds;
  delete out.content;
  return out;
}

// ---------------- EMOJI REGISTRY ----------------
// Every distinct emoji found in the bot UI has one canonical key. The override is stored
// in SQLite, so changing an emoji takes effect immediately without a restart.
const DEFAULT_EMOJIS = {
  success: '✅', lock: '🔒', voice: '🔊', level: '📈', ticket: '🎫', wave: '👋', settings: '⚙️',
  kick: '👢', delete: '🗑️', enabled: '🟢', disabled: '🔴', shield: '🛡️', unlock: '🔓',
  moderation: '🔨', warning: '⚠️', claim: '🙋', undo: '↩️', add: '➕', remove: '➖',
  hidden: '🙈', visible: '👁️', rename: '✏️', limit: '🔢', transfer: '🔁', category: '📁',
  voice_mic: '🎙️', link: '🔗', spam: '🚫', tools: '🛠️', error: '❌', logs: '📜', owner: '👑',
  raid: '🚨', mute: '🔇', boost: '🚀', clear: '🧹', slow: '🐌', unknown: '❔', help: '📖',
  cancel: '✖️', emoji: '😀', nobody: '🙅', already_gone: '😅', balloon: '🎈',
  member_join: '📥', member_leave: '📤'
};

// Backward-compatible semantic names used by existing UI builders.
const EMOJI_ALIASES = {
  ok: 'success', warn: 'warning', error: 'error',
  ticket_open: 'ticket', ticket_close: 'lock', staff_controls: 'tools',
  unclaim: 'undo', add_member: 'add', remove_member: 'remove',
  enable: 'enabled', disable: 'disabled', edit: 'settings',
  unhide: 'visible', hide: 'hidden', rename: 'rename', limit: 'limit',
  kick: 'kick', transfer: 'transfer', lock: 'lock', unlock: 'unlock',
  shield: 'shield'
};
const EMOJI_KEYS = Object.keys(DEFAULT_EMOJIS);
const DEFAULT_TO_KEY = new Map(Object.entries(DEFAULT_EMOJIS).map(([k, v]) => [v, k]));

function resolveEmojiKey(name) { return EMOJI_ALIASES[name] || name; }
function emoji(name) {
  const key = resolveEmojiKey(name);
  return db.getEmojiOverride(key) || DEFAULT_EMOJIS[key] || DEFAULT_EMOJIS.unknown;
}

// Replace every default emoji found inside user-facing text with its current configured value.
// This also covers embeds built outside of a helper such as ui.okEmbed(...).
function emojify(value) {
  if (typeof value !== 'string' || !value) return value;
  const entries = Object.entries(DEFAULT_EMOJIS).sort((a, b) => b[1].length - a[1].length);
  const overrides = db.getAllEmojiOverrides();
  const byDefault = new Map(entries.map(([key, def]) => [def, overrides[key] || def]));
  const pattern = new RegExp(entries.map(([, def]) => def.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')).join('|'), 'gu');
  return value.replace(pattern, m => byDefault.get(m) || m);
}

function decorateEmbed(embed) {
  const setTitle = embed.setTitle.bind(embed);
  const setDescription = embed.setDescription.bind(embed);
  const setFooter = embed.setFooter.bind(embed);
  const setAuthor = embed.setAuthor.bind(embed);
  const addFields = embed.addFields.bind(embed);
  embed.setTitle = value => setTitle(emojify(value));
  embed.setDescription = value => setDescription(emojify(value));
  embed.setFooter = value => {
    if (value && typeof value === 'object') return setFooter({ ...value, text: emojify(value.text) });
    return setFooter(emojify(value));
  };
  embed.setAuthor = value => {
    if (value && typeof value === 'object') return setAuthor({ ...value, name: emojify(value.name) });
    return setAuthor(value);
  };
  embed.addFields = (...fields) => addFields(...fields.map(field => {
    if (Array.isArray(field)) return field.map(f => ({ ...f, name: emojify(f.name), value: emojify(f.value) }));
    if (field && typeof field === 'object') return { ...field, name: emojify(field.name), value: emojify(field.value) };
    return field;
  }));
  return embed;
}

function base(title) {
  const embed = new EmbedBuilder().setColor(THEME).setTimestamp();
  decorateEmbed(embed);
  embed.setTitle(title).setFooter({ text: BRAND_FOOTER });
  return embed;
}
function okEmbed(title, desc) { return base(title).setColor(OK).setDescription(desc); }
function warnEmbed(title, desc) { return base(title).setColor(WARN).setDescription(desc); }
function errorEmbed(title, desc) { return base(title).setColor(DANGER).setDescription(desc); }

// ---------------- HELP MENU ----------------
const HELP_CATEGORIES = {
  protection: {
    name: 'Protection', emojiKey: 'shield',
    desc: '**/antinuke setup** — punishment, thresholds, protected owner\n' +
      '**/antilink setup** — delete/warn/mute, domain whitelist, bypass role\n' +
      '**/antispam setup** — message/mention/emoji flood limits\n' +
      '**/antiraid setup** — join-rate lockdown, min account age\n' +
      '**/whitelist add|remove** — exempt trusted staff from antinuke'
  },
  voice: {
    name: 'Voice', emojiKey: 'voice',
    desc: '**/greetvoice setup** — role-gated VC greeting with TTS\n' +
      '**/voicemaster setup** — join-to-create hub channel & category'
  },
  moderation: {
    name: 'Moderation', emojiKey: 'moderation',
    desc: '**/ban /kick /timeout /untimeout** — with mod-log embeds\n' +
      '**/warn /warnings /clearwarns** — warning system\n' +
      '**/purge** — bulk delete with filters\n' +
      '**/lock /unlock /slowmode** — channel controls\n' +
      '**/nickname /role add|remove**'
  },
  leveling: {
    name: 'Leveling', emojiKey: 'level',
    desc: '**/leveling setup** — xp rate, cooldown, level-up message, role rewards\n' +
      '**/rank** — view a level card\n' +
      '**/leaderboard** — top XP in the server'
  },
  tickets: {
    name: 'Tickets', emojiKey: 'ticket',
    desc: '**/tickets setup** — ticket category, support role, log channel\n' +
      '**/ticketpanel** — post the open-a-ticket panel\n' +
      '**/ticketconfig** — customize panel/welcome images and text'
  },
  logging: {
    name: 'Logging', emojiKey: 'logs',
    desc: '**/logs setup** — route mod/message/member/voice/antinuke/server logs to channels'
  },
  extra: {
    name: '40+ more setups', emojiKey: 'settings',
    desc: 'Use **/setup list** to see every configurable module. Smaller modules use their own **/<feature> setup** command.'
  },
  owner: {
    name: 'Owner-only', emojiKey: 'owner',
    desc: '**/maintenance** — toggle maintenance mode\n' +
      '**/blacklist add|remove** — block a user from all commands\n' +
      '**/eval** — run raw JS (bot owner only, use with care)\n' +
      '**/broadcast** — DM every server owner'
  }
};

function helpHomeEmbed(client) {
  return base(`${emoji('help')} Help Menu`)
    .setDescription(
      `Pick a category from the menu below.\n\n` +
      Object.values(HELP_CATEGORIES).map(c => `${emoji(c.emojiKey)} **${c.name}**`).join('\n')
    )
    .setThumbnail(client.user.displayAvatarURL());
}
function helpCategoryEmbed(key) {
  const cat = HELP_CATEGORIES[key];
  if (!cat) return errorEmbed('Unknown Category', 'That help category no longer exists.');
  return base(`${emoji(cat.emojiKey)} ${cat.name}`).setDescription(cat.desc);
}
function helpSelectRow() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('help_select')
    .setPlaceholder('Choose a category…')
    .addOptions(Object.entries(HELP_CATEGORIES).map(([value, c]) => ({
      label: c.name, value, emoji: emoji(c.emojiKey)
    })));
  return [new ActionRowBuilder().addComponents(menu)];
}

// ---------------- GENERIC CONFIRM / TOGGLE BUTTONS ----------------
function confirmRow(idBase) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${idBase}_confirm`).setLabel('Confirm').setStyle(ButtonStyle.Success).setEmoji(emoji('success')),
    new ButtonBuilder().setCustomId(`${idBase}_cancel`).setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji(emoji('cancel'))
  );
}

// ---------------- TICKET PANEL ----------------
// `cfg` is the guild's `ticket` config — panelTitle/panelDescription/panelThumbnail/panelImage
// let /ticketconfig fully customize the picture + message shown before a ticket is even opened.
function ticketPanelEmbed(guildName, cfg = {}) {
  const e = base(cfg.panelTitle || `${emoji('ticket_open')} ${guildName} Support`)
    .setDescription(cfg.panelDescription || 'Need help? Click **Open Ticket** below and our team will assist you shortly.');
  if (cfg.panelThumbnail) e.setThumbnail(cfg.panelThumbnail);
  if (cfg.panelImage) e.setImage(cfg.panelImage);
  return e;
}
function ticketPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_open').setLabel('Open Ticket').setStyle(ButtonStyle.Primary).setEmoji(emoji('ticket_open'))
  );
}
// Everything here is pulled from cfg (the guild's `ticket` config) so /ticketsetup's Edit Settings
// modal fully controls the title, message, thumbnail and banner image — matching a design like
// "Welcome @user / Category: X / message" + small thumbnail + big banner underneath.
function ticketWelcomeEmbed(user, cfg) {
  const text = (cfg.welcomeMessage || 'Welcome {user}! Our support team will assist you shortly.').replace('{user}', `${user}`);
  const e = base(`${cfg.categoryLabel || 'General Support'} Ticket`)
    .setDescription(`**Welcome** ${user}\n**Category:** ${cfg.categoryLabel || 'General Support'}\n${text}`);
  if (cfg.welcomeThumbnail) e.setThumbnail(cfg.welcomeThumbnail);
  if (cfg.welcomeImage) e.setImage(cfg.welcomeImage);
  return e;
}
// Matches the "embed + buttons directly beneath it" layout: Close Ticket (red) + Staff Controls
// (blue) sent in the SAME message payload as the welcome embed above.
function ticketControlRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji(emoji('ticket_close')),
    new ButtonBuilder().setCustomId('staff_controls').setLabel('Staff Controls').setStyle(ButtonStyle.Primary).setEmoji(emoji('staff_controls'))
  );
}

// ---------------- TICKET: STAFF CONTROLS SUB-PANEL ----------------
// Opened (ephemeral, staff-only) by the "Staff Controls" button on the ticket panel above.
function staffControlsEmbed(ticket) {
  const claimLine = ticket?.claimedBy ? `**Claimed by:** <@${ticket.claimedBy}>` : '**Claimed by:** nobody yet';
  return base(`${emoji('staff_controls')} Staff Controls`)
    .setDescription(`Manage this ticket. ${claimLine}`);
}
function staffControlsRow(claimed) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('staff_claim').setLabel(claimed ? 'Unclaim' : 'Claim')
        .setStyle(claimed ? ButtonStyle.Secondary : ButtonStyle.Success).setEmoji(claimed ? emoji('unclaim') : emoji('claim')),
      new ButtonBuilder().setCustomId('staff_addmember').setLabel('Add Member').setStyle(ButtonStyle.Primary).setEmoji(emoji('add_member')),
      new ButtonBuilder().setCustomId('staff_removemember').setLabel('Remove Member').setStyle(ButtonStyle.Primary).setEmoji(emoji('remove_member'))
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('staff_delete').setLabel('Delete Ticket').setStyle(ButtonStyle.Danger).setEmoji(emoji('delete'))
    )
  ];
}

// ---------------- VOICEMASTER CONTROL PANEL ----------------
function vmControlEmbed(owner) {
  return base(`${emoji('voice')} Voice Channel Controls`)
    .setDescription(`Owned by ${owner}. Use the buttons below to manage this room.`);
}
// `overrides` lets a caller that JUST changed lock/hide state pass the fresh values directly,
// instead of relying on `vc`'s permission-overwrite cache which may not have settled yet.
function vmControlRows(vc, overrides = {}) {
  const everyone = vc.guild.roles.everyone;
  const overwrite = vc.permissionOverwrites.cache.get(everyone.id);
  const locked = overrides.locked !== undefined ? overrides.locked
    : !!(overwrite && overwrite.deny.has(PermissionFlagsBits.Connect));
  const hidden = overrides.hidden !== undefined ? overrides.hidden
    : !!(overwrite && overwrite.deny.has(PermissionFlagsBits.ViewChannel));

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vm_togglelock').setLabel(locked ? 'Unlock' : 'Lock')
        .setStyle(locked ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji(locked ? emoji('unlock') : emoji('lock')),
      new ButtonBuilder().setCustomId('vm_togglehide').setLabel(hidden ? 'Unhide' : 'Hide')
        .setStyle(hidden ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji(hidden ? emoji('visible') : emoji('hidden')),
      new ButtonBuilder().setCustomId('vm_rename').setLabel('Rename').setStyle(ButtonStyle.Primary).setEmoji(emoji('rename')),
      new ButtonBuilder().setCustomId('vm_limit').setLabel('Set Limit').setStyle(ButtonStyle.Primary).setEmoji(emoji('limit'))
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vm_kick').setLabel('Kick').setStyle(ButtonStyle.Danger).setEmoji(emoji('kick')),
      new ButtonBuilder().setCustomId('vm_transfer').setLabel('Transfer').setStyle(ButtonStyle.Danger).setEmoji(emoji('transfer'))
    )
  ];
}

// ---------------- VOICEMASTER: DEDICATED SETUP PANEL ----------------
// A themed embed + a row of exactly 3 buttons: pick the join-to-create category, pick the
// "join to create" hub voice channel, and flip the module on/off. Each of the first two opens
// a native Discord channel-select menu (ephemeral) so the admin picks from every category /
// every voice channel in the server instead of typing an ID.
function vmSetupEmbed(cfg) {
  const vm = cfg.voicemaster;
  const status = vm.enabled ? `${emoji('enabled')} Enabled` : `${emoji('disabled')} Disabled`;
  return base(`${emoji('voice')} Voicemaster — Join to Create`)
    .setDescription(
      `Give members their own temporary voice channel the moment they join a hub VC.\n\n` +
      `**Status:** ${status}\n` +
      `**${emoji('category')} Category:** ${vm.categoryId ? `<#${vm.categoryId}>` : '*not set*'} — new temp channels are created here.\n` +
      `**${emoji('voice_mic')} Join-to-Create Channel:** ${vm.hubChannelId ? `<#${vm.hubChannelId}>` : '*not set*'} — joining this VC spins up a fresh temp channel.\n\n` +
      `Use the buttons below to configure each piece, or flip the whole module on/off.`
    );
}
function vmSetupRow(cfg) {
  const enabled = cfg.voicemaster.enabled;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vm_setup_category').setLabel('Category').setStyle(ButtonStyle.Secondary).setEmoji(emoji('category')),
    new ButtonBuilder().setCustomId('vm_setup_channel').setLabel('Voice Channel').setStyle(ButtonStyle.Secondary).setEmoji(emoji('voice_mic')),
    new ButtonBuilder().setCustomId('vm_setup_toggle').setLabel(enabled ? 'Disable' : 'Enable')
      .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(enabled ? emoji('disabled') : emoji('enabled'))
  );
}
function vmCategoryPromptEmbed() {
  return base(`${emoji('category')} Pick a Category`).setDescription('Choose the category temp voice channels should be created under.');
}
function vmCategorySelectRow() {
  const menu = new ChannelSelectMenuBuilder().setCustomId('vm_setup_category_select')
    .setPlaceholder('Choose a category…').addChannelTypes(ChannelType.GuildCategory);
  return new ActionRowBuilder().addComponents(menu);
}
function vmChannelPromptEmbed() {
  return base(`${emoji('voice_mic')} Pick a Voice Channel`).setDescription('Choose the voice channel members join to get their own temp channel.');
}
function vmChannelSelectRow() {
  const menu = new ChannelSelectMenuBuilder().setCustomId('vm_setup_channel_select')
    .setPlaceholder('Choose a voice channel…').addChannelTypes(ChannelType.GuildVoice);
  return new ActionRowBuilder().addComponents(menu);
}

// ---------------- TICKET: ADD/REMOVE MEMBER PICKER ----------------
function ticketMemberPromptEmbed(action) {
  return base(`${action === 'add' ? emoji('add_member') : emoji('remove_member')} ${action === 'add' ? 'Add' : 'Remove'} Member`)
    .setDescription(`Pick the member to ${action === 'add' ? 'add to' : 'remove from'} this ticket.`);
}
function ticketMemberSelectRow(action) {
  const menu = new UserSelectMenuBuilder().setCustomId(`ticket_${action}member_select`).setPlaceholder('Choose a member…');
  return new ActionRowBuilder().addComponents(menu);
}

// ---------------- OWNER: /emoji ----------------
function emojisListEmbed(overrides = {}) {
  const lines = EMOJI_KEYS.map((key, i) => {
    const value = overrides[key] || DEFAULT_EMOJIS[key];
    const custom = overrides[key] ? ' *(custom)*' : '';
    return `**${i + 1}. ${key}:** ${value}${custom}`;
  });
  return base(`${emoji('emoji')} Bot Emoji Registry`)
    .setDescription(lines.join('\n') + '\n\nChange any entry with **/emoji set**. Reset with **/emoji reset**. Changes apply to buttons and embed text immediately.');
}

// ---------------- LEVELING ----------------
function levelUpEmbed(text) {
  return base(`${emoji('level')} Level Up!`).setColor(OK).setDescription(text);
}
function leaderboardEmbed(guildName, rows, startRank = 1) {
  const desc = rows.length
    ? rows.map((r, i) => `**#${startRank + i}** <@${r.userId}> — Level ${r.level} (${r.xp} XP)`).join('\n')
    : 'No XP recorded yet.';
  return base(`${emoji('level')} ${guildName} Leaderboard`).setDescription(desc);
}

// ---------------- SETUP SUMMARY ----------------
function configSummaryEmbed(moduleName, cfgObject) {
  const lines = Object.entries(cfgObject).map(([k, v]) => {
    let val = v;
    if (val === null || val === undefined) val = '—';
    if (Array.isArray(val)) val = val.length ? val.join(', ') : '—';
    if (typeof val === 'object') val = '`' + JSON.stringify(val) + '`';
    return `**${k}:** ${val}`;
  });
  return base(`${emoji('settings')} ${moduleName} Settings`).setDescription(lines.join('\n') || 'No settings.');
}

function moduleListEmbed(modules) {
  return base(`${emoji('settings')} All Setup Modules`)
    .setDescription(modules.map(m => `• \`${m}\``).join('\n'))
    .setFooter({ text: `${BRAND_FOOTER} • Use /<module> setup to configure` });
}

// ---------------- INTERACTIVE SETUP PANEL ----------------
// Every dedicated /<feature> setup command replies with one of these instead of a static summary:
// a single embed showing current settings + a row of buttons to toggle it on/off or open an
// edit modal — fully customizable, nothing here is gated or locked behind anything.
const SETUP_MODULE_META = {
  antinuke: { emojiKey: 'shield', title: 'Antinuke', cfgKey: 'antinuke' },
  antilink: { emojiKey: 'link', title: 'Antilink', cfgKey: 'antilink' },
  antispam: { emojiKey: 'spam', title: 'Antispam', cfgKey: 'antispam' },
  antiraid: { emojiKey: 'raid', title: 'Antiraid', cfgKey: 'antiraid' },
  automod: { emojiKey: 'shield', title: 'Automod', cfgKey: 'automod' },
  voicemaster: { emojiKey: 'voice', title: 'Voicemaster', cfgKey: 'voicemaster' },
  greetmessage: { emojiKey: 'wave', title: 'Greet Message', cfgKey: 'greetmessage' },
  leveling: { emojiKey: 'level', title: 'Leveling', cfgKey: 'leveling' },
  tickets: { emojiKey: 'ticket', title: 'Tickets', cfgKey: 'ticket' }
};

// Dedicated setup modules. They all use the same panel so every /<feature> setup
// command has a consistent enable/disable + settings UI.
const EXTRA_SETUP_META = {
  sticky:'Sticky Messages', counters:'Counters', reminders:'Reminders', customcommands:'Custom Commands',
  autoresponder:'Autoresponder', verification:'Verification', tempchannels:'Temporary Channels', messagefilter:'Message Filter',
  wordfilter:'Word Filter', capsfilter:'Caps Filter', mentionguard:'Mention Guard', raidmode:'Raid Mode',
  serverstats:'Server Stats', memberlogs:'Member Logs', rolelogs:'Role Logs', channellogs:'Channel Logs',
  voicelogs:'Voice Logs', mediaonly:'Media Only', linkfilter:'Link Filter', antiemoji:'Anti Emoji Spam',
  antimention:'Anti Mention Spam', nicknameguard:'Nickname Guard', ghostping:'Ghost Ping Protection', selfroles:'Self Roles',
  reactionrolesplus:'Reaction Roles Plus', suggestionbox:'Suggestion Box', confessions:'Confessions', applications:'Applications',
  forms:'Forms', feedback:'Feedback', serverbackup:'Server Backup', autorename:'Auto Rename', autothread:'Auto Thread',
  threadguard:'Thread Guard', activityroles:'Activity Roles', inactivity:'Inactivity', commandlogs:'Command Logs',
  moderatorroles:'Moderator Roles', staffnotify:'Staff Notifications', welcomeimages:'Welcome Images', goodbyeimages:'Goodbye Images'
};
for (const [key, title] of Object.entries(EXTRA_SETUP_META)) {
  SETUP_MODULE_META[key] = { emojiKey: 'settings', title, cfgKey: key };
}

function setupPanelEmbed(sub, cfg) {
  const meta = SETUP_MODULE_META[sub];
  const modcfg = (cfg[meta.cfgKey] && typeof cfg[meta.cfgKey] === 'object') ? cfg[meta.cfgKey] : { enabled: false };
  const status = modcfg.enabled ? `${emoji('enabled')} Enabled` : `${emoji('disabled')} Disabled`;
  const lines = Object.entries(modcfg).filter(([k]) => k !== 'enabled').map(([k, v]) => {
    let val = v;
    if (val === null || val === undefined) val = '—';
    if (Array.isArray(val)) val = val.length ? val.join(', ') : '—';
    if (typeof val === 'object') val = '`' + JSON.stringify(val) + '`';
    return `**${k}:** ${val}`;
  });
  return base(`${emoji(meta.emojiKey)} ${meta.title} — Setup`)
    .setDescription(`**Status:** ${status}\n\n${lines.join('\n')}\n\n` +
      'Every option below is fully unlocked for you to customize — use the buttons to toggle it or edit its settings.');
}

const SETUP_SETTING_OPTIONS = {
  antinuke: [
    ['punishment', 'Punishment', 'Choose ban, kick or strip roles'],
    ['threshold', 'Action threshold', 'Choose the action limit'],
    ['window_seconds', 'Time window', 'Choose the detection window']
  ],
  antilink: [
    ['mode', 'Link action', 'Choose delete, warn or mute'],
    ['bypass_role', 'Bypass role', 'Choose a role that can post links']
  ],
  antispam: [
    ['max_messages', 'Message limit', 'Choose messages allowed in the window'],
    ['window_seconds', 'Time window', 'Choose the detection window'],
    ['punishment', 'Spam action', 'Choose mute, kick or ban']
  ],
  automod: [
    ['bad_word_filter', 'Bad-word filter', 'Enable or disable bad-word filtering'],
    ['bad_words', 'Blocked words', 'Edit the comma-separated blocked-word list'],
    ['caps_filter', 'Caps filter', 'Enable or disable excessive-caps filtering'],
    ['caps_threshold', 'Caps threshold', 'Set the caps percentage threshold'],
    ['invite_filter', 'Invite filter', 'Enable or disable Discord invite filtering']
  ],
  antiraid: [
    ['join_threshold', 'Join limit', 'Choose joins allowed in the window'],
    ['window_seconds', 'Time window', 'Choose the detection window'],
    ['min_account_age_days', 'Account age', 'Choose minimum account age'],
    ['action', 'Raid action', 'Choose lockdown or kick new accounts']
  ],
  voicemaster: [
    ['hub_channel', 'Hub channel', 'Select the join-to-create voice channel'],
    ['category', 'Category', 'Select where temporary channels are created']
  ],
  greetmessage: [
    ['channel', 'Welcome channel', 'Select where welcome messages are posted'],
    ['message', 'Welcome message', 'Edit the message text'],
    ['image', 'Welcome image', 'Set an image/GIF URL']
  ],
  leveling: [
    ['channel', 'Level-up channel', 'Select where level-ups are posted'],
    ['xp_per_message', 'XP per message', 'Choose XP earned per message'],
    ['level_up_message', 'Level-up message', 'Customize the message sent when someone levels up'],
    ['cooldown_seconds', 'XP cooldown', 'Choose seconds between XP gains']
  ],
  tickets: [
    ['category', 'Ticket category', 'Select where tickets are created'],
    ['support_role', 'Support role', 'Select who can manage tickets'],
    ['log_channel', 'Log channel', 'Select where ticket logs go'],
    ['panel_text', 'Panel text', 'Edit the ticket panel title and message'],
    ['panel_media', 'Panel media', 'Set panel thumbnail/banner URLs'],
    ['welcome_text', 'Welcome text', 'Edit the message shown inside tickets'],
    ['welcome_media', 'Welcome media', 'Set welcome thumbnail/banner URLs']
  ]
};

for (const key of Object.keys(EXTRA_SETUP_META)) {
  SETUP_SETTING_OPTIONS[key] = [
    ['channel', 'Channel', 'Select the channel used by this module'],
    ['role', 'Role', 'Select the role used by this module'],
    ['message', 'Message', "Customize this module's message"]
  ];
}

function setupPanelRow(sub, cfg) {
  const meta = SETUP_MODULE_META[sub];
  const enabled = cfg[meta.cfgKey].enabled;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`setup_setting:${sub}`)
    .setPlaceholder('Choose a setting to edit…')
    .addOptions((SETUP_SETTING_OPTIONS[sub] || []).map(([value, label, description]) => ({ value, label, description, emoji: emoji('settings') })));
  return [
    new ActionRowBuilder().addComponents(menu),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`setup_toggle:${sub}`).setLabel(enabled ? 'Disable' : 'Enable')
        .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(enabled ? emoji('disabled') : emoji('enabled'))
    )
  ];
}

function ticketConfigPanelEmbed(cfg = {}) {
  return base(`${emoji('ticket')} Ticket Configuration`)
    .setDescription('Choose exactly what you want to change. Text, media, category, support role and logging are separated so setup stays simple.')
    .addFields(
      { name: 'Panel', value: `${cfg.panelTitle || 'Default title'}\n${cfg.panelDescription || 'Default description'}`.slice(0, 1024) },
      { name: 'Welcome', value: `${cfg.categoryLabel || 'General Support'}\n${cfg.welcomeMessage || 'Default welcome message'}`.slice(0, 1024) }
    );
}
function ticketConfigRow() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticketconfig_setting')
    .setPlaceholder('Choose what to configure…')
    .addOptions(
      { label: 'Panel text', value: 'panel_text', description: 'Title and opening message', emoji: emoji('settings') },
      { label: 'Panel media', value: 'panel_media', description: 'Thumbnail and banner image/GIF URLs', emoji: '🖼️' },
      { label: 'Welcome text', value: 'welcome_text', description: 'Category and ticket welcome message', emoji: emoji('wave') },
      { label: 'Welcome media', value: 'welcome_media', description: 'Thumbnail and banner image/GIF URLs', emoji: '🖼️' },
      { label: 'Preview', value: 'preview', description: 'Show the current ticket design', emoji: '👀' }
    );
  return [new ActionRowBuilder().addComponents(menu)];
}

// ---------------- VOICEMASTER: KICK-FROM-VC SELECTION ----------------
function vmKickPromptEmbed() {
  return base(`${emoji('kick')} Kick From Voice Channel`)
    .setDescription(`Pick the member you'd like to disconnect from your channel below. ${emoji('lock')} Only you can see and use this menu.`);
}
function vmKickSelectRow(members) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('vm_kick_pick')
    .setPlaceholder('Choose a member to disconnect…')
    .addOptions(members.slice(0, 25).map(m => ({ label: m.displayName.slice(0, 100), value: m.id, emoji: emoji('mute') })));
  return new ActionRowBuilder().addComponents(menu);
}
function vmKickNobodyEmbed() {
  return warnEmbed(`${emoji('nobody')} Nobody To Kick`, 'There\'s no one else in your voice channel right now.');
}
function vmKickGoneEmbed(userId) {
  return warnEmbed(`${emoji('already_gone')} Already Gone`, `Looks like <@${userId}> isn't in the voice channel anymore — nothing to do here! ${emoji('balloon')}`);
}
function vmKickedEmbed(tag) {
  return okEmbed(`${emoji('kick')} Member Removed`, `**${tag}** has been disconnected from the voice channel. ${emoji('wave')}`);
}


// ---------------- SERVER / MEMBER INFO ----------------
function requestedFooter(footer) {
  return footer || { text: BRAND_FOOTER };
}

function serverInfoEmbed(guild, stats = {}) {
  const owner = stats.owner ? `${stats.owner.user}` : guild.ownerId ? `<@${guild.ownerId}>` : 'Unknown';
  const humanCount = stats.humans ?? guild.members.cache.filter(m => !m.user.bot).size;
  const botCount = stats.bots ?? guild.members.cache.filter(m => m.user.bot).size;
  const boostLevel = guild.premiumTier ? String(guild.premiumTier).replace('TIER_', 'Level ') : 'Level 0';
  return base(`📊 Server Information`)
    .setAuthor({ name: guild.name, iconURL: guild.iconURL({ size: 64 }) || undefined })
    .setDescription(guild.description || 'No server description has been set.')
    .setThumbnail(guild.iconURL({ size: 256 }) || null)
    .addFields(
      { name: '🌙 General Info', value: `**Name:** ${guild.name}\n**Server ID:** ${guild.id}\n**Owner:** ${owner}\n**Created:** <t:${Math.floor(guild.createdTimestamp / 1000)}:F>`, inline: false },
      { name: '👥 Members & Roles', value: `**Members:** ${guild.memberCount}\n**Humans:** ${humanCount}\n**Bots:** ${botCount}\n**Roles:** ${guild.roles.cache.size - 1}\n**Verification Level:** ${guild.verificationLevel}`, inline: false },
      { name: '💎 Boost Status', value: `**Level:** ${boostLevel}\n**Boosts:** ${guild.premiumSubscriptionCount || 0}\n**AFK Timeout:** ${guild.afkTimeout || 0} sec`, inline: false },
      { name: '📁 Channels', value: `**Text:** ${stats.text ?? guild.channels.cache.filter(c => c.type === ChannelType.GuildText).size}\n**Voice:** ${stats.voice ?? guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice).size}\n**Categories:** ${stats.categories ?? guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).size}\n**Threads:** ${stats.threads ?? guild.channels.cache.filter(c => c.isThread?.()).size}`, inline: false },
      { name: '✨ Server Assets', value: `**Emojis:** ${guild.emojis.cache.size}\n**Stickers:** ${guild.stickers.cache.size}\n**Features:** ${guild.features.length ? guild.features.slice(0, 8).join(', ') : 'None'}`, inline: false }
    )
    .setFooter(requestedFooter(stats.footer));
}

function memberCountEmbed(guild, humans, bots, footer, type = 'all') {
  const total = humans + bots;
  const lines = type === 'humans' ? `**Humans:** ${humans}` : type === 'bots' ? `**Bots:** ${bots}` : `**Total:** ${total}\n**Humans:** ${humans}\n**Bots:** ${bots}`;
  return base(`👥 ${guild.name} Members`)
    .setThumbnail(guild.iconURL({ size: 256 }) || null)
    .setDescription(lines)
    .setFooter(requestedFooter(footer));
}

function userInfoEmbed(user, member, footer) {
  const roles = member ? member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r).slice(0, 15).join(' ') : 'Not in this server';
  return base(`👤 ${user.tag}`)
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: 'General', value: `**User ID:** ${user.id}\n**Bot:** ${user.bot ? 'Yes' : 'No'}\n**Created:** <t:${Math.floor(user.createdTimestamp / 1000)}:F>`, inline: false },
      { name: 'Server', value: member ? `**Joined:** <t:${Math.floor(member.joinedTimestamp / 1000)}:F>\n**Nickname:** ${member.nickname || 'None'}\n**Roles:** ${roles || 'None'}` : 'Not a member of this server.', inline: false }
    )
    .setFooter(requestedFooter(footer));
}

function avatarEmbed(user, footer) {
  return base(`🖼️ ${user.tag}'s Avatar`).setImage(user.displayAvatarURL({ size: 1024, extension: 'png' })).setFooter(requestedFooter(footer));
}
function bannerEmbed(user, footer) {
  return base(`🖼️ ${user.tag}'s Banner`).setImage(user.bannerURL({ size: 1024, extension: 'png' })).setFooter(requestedFooter(footer));
}
function invitesEmbed(guild, user, uses, codes, active, footer) {
  return base(`✉️ Invites — ${user.tag}`)
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .setDescription(`**Total invite uses:** ${uses}\n**Invite codes:** ${codes}\n**Active codes:** ${active}\n\nCalculated from the server's currently visible invite codes.`)
    .setFooter(requestedFooter(footer));
}

// ---------------- GIVEAWAYS ----------------
function giveawayEmbed({ id, prize, winners, host, endsAt, entrants = 0, ended = false, winnerIds = [] }) {
  const status = ended ? 'Ended' : 'Ends';
  const winnerText = winnerIds.length ? winnerIds.map(id => `<@${id}>`).join(', ') : 'Not drawn yet';
  return base(`🎉 Giveaway • ${prize}`)
    .setDescription(`**Prize:** ${prize}\n**Winners:** ${winners}\n**Host:** ${host}\n**Entrants:** ${entrants}\n\n**${status}:** <t:${Math.floor(endsAt / 1000)}:R>${ended ? `\n\n**Winners:** ${winnerText}` : '\n\nClick the button below to enter.'}`)
    .setFooter({ text: `Giveaway ID: ${id} • ${BRAND_FOOTER}` });
}
function giveawayButtonRow(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`giveaway_enter:${id}`).setLabel('Enter Giveaway').setStyle(ButtonStyle.Success).setEmoji('🎉')
  );
}
function giveawayListEmbed(rows) {
  if (!rows.length) return base('🎉 Giveaways').setDescription('No giveaways have been created yet.');
  return base('🎉 Recent Giveaways').setDescription(rows.map(r => `**${r.id}** — ${r.prize} — ${r.ended ? 'Ended' : `<t:${Math.floor(r.endsAt / 1000)}:R>`} — ${r.winners} winner(s)`).join('\n'));
}

module.exports = {
  THEME, OK, WARN, DANGER, emoji, emojify, EMOJI_KEYS, DEFAULT_EMOJIS,
  base, okEmbed, warnEmbed, errorEmbed,
  HELP_CATEGORIES, helpHomeEmbed, helpCategoryEmbed, helpSelectRow,
  confirmRow,
  ticketPanelEmbed, ticketPanelRow, ticketControlRow, ticketWelcomeEmbed,
  staffControlsEmbed, staffControlsRow,
  ticketMemberPromptEmbed, ticketMemberSelectRow,
  vmControlEmbed, vmControlRows,
  vmSetupEmbed, vmSetupRow, vmCategoryPromptEmbed, vmCategorySelectRow, vmChannelPromptEmbed, vmChannelSelectRow,
  vmKickPromptEmbed, vmKickSelectRow, vmKickNobodyEmbed, vmKickGoneEmbed, vmKickedEmbed,
  levelUpEmbed, leaderboardEmbed,
  configSummaryEmbed, moduleListEmbed, emojisListEmbed,
  serverInfoEmbed, memberCountEmbed, userInfoEmbed, avatarEmbed, bannerEmbed, invitesEmbed,
  giveawayEmbed, giveawayButtonRow, giveawayListEmbed,
  SETUP_MODULE_META, SETUP_SETTING_OPTIONS, setupPanelEmbed, setupPanelRow,
  ticketConfigPanelEmbed, ticketConfigRow,
  toComponentsV2, COMPONENTS_V2_FLAG
};
