// ui.js — every embed / button / select-menu builder lives here so the bot has one visual style.
// Note on Discord's API: buttons and select menus can never be rendered physically inside an
// embed's body — Discord only allows components in a row attached below a message's embed(s).
// To make the bot still feel "embed native", every panel here uses ONE embed + ONE compact
// action row directly beneath it (no bare unstyled text, no naked prompts), so visually it reads
// as a single unified panel rather than "an embed, then a separate control area".

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder,
  ChannelType, PermissionFlagsBits,
  ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder, SeparatorBuilder, MessageFlags
} = require('discord.js');
const db = require('./database');
const embedStyles = require('./embeds');

const THEME = embedStyles.COLORS.info;
const OK = embedStyles.COLORS.success;
const WARN = embedStyles.COLORS.warning;
const DANGER = embedStyles.COLORS.error;
const BRAND_FOOTER = embedStyles.BRAND_FOOTER;

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
  member_join: '📥', member_leave: '📤', info: 'ℹ️'
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
function isCustomEmoji(value) { return /^<a?:[A-Za-z0-9_~.-]+:\d+>$/.test(String(value || '').trim()); }
function customEmojiKey(value) {
  const m = String(value || '').trim().match(/^<a?:([^:>]+):(\d+)>$/);
  return m ? `custom_${m[1]}` : null;
}
function unicodeEmojiKey(value) {
  const cps = [...String(value || '')].map(ch => ch.codePointAt(0).toString(16)).join('-');
  return cps ? `unicode_${cps}` : null;
}
function emojiTokenKey(value) {
  return customEmojiKey(value) || unicodeEmojiKey(value);
}
function emojiDisplayValue(value) {
  const key = emojiTokenKey(value);
  return key ? (db.getEmojiOverride(key) || value) : value;
}
function extractEmojiTokens(text) {
  if (typeof text !== 'string' || !text) return [];
  const custom = text.match(/<a?:[A-Za-z0-9_~.-]+:\d+>/g) || [];
  const unicode = text.match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu) || [];
  return [...new Set([...custom, ...unicode])];
}
function dynamicEmojiEntries() {
  const usedRows = db.listEmbedTexts(500);
  const found = new Set();
  for (const row of usedRows) {
    for (const value of extractEmojiTokens(`${row.title || ''} ${row.description || ''} ${row.footer || ''}`)) found.add(value);
  }
  for (const value of Object.values(DEFAULT_EMOJIS)) found.delete(value);
  return [...found].map(value => {
    const key = emojiTokenKey(value) || `auto_${Buffer.from(value).toString('hex').slice(0, 20)}`;
    const current = db.getEmojiOverride(key) || value;
    const custom = /^<a?:([^:>]+):(\d+)>$/.exec(value);
    return {
      key,
      value: current,
      originalValue: value,
      custom: true,
      usedIn: usedRows.filter(r => `${r.title || ''} ${r.description || ''} ${r.footer || ''}`.includes(value)).slice(0, 8).map(r => r.name)
    };
  });
}

function emoji(name) {
  const key = resolveEmojiKey(name);
  return db.getEmojiOverride(key) || DEFAULT_EMOJIS[key] || DEFAULT_EMOJIS.unknown;
}

// Replace both built-in emojis and dynamically discovered embed emojis with their current values.
function emojify(value) {
  if (typeof value !== 'string' || !value) return value;
  let out = value;
  const defaults = Object.entries(DEFAULT_EMOJIS).sort((a, b) => b[1].length - a[1].length);
  for (const [key, def] of defaults) {
    const replacement = db.getEmojiOverride(key) || def;
    if (replacement !== def) out = out.split(def).join(replacement);
  }
  for (const entry of dynamicEmojiEntries()) {
    if (entry.originalValue && entry.value !== entry.originalValue) out = out.split(entry.originalValue).join(entry.value);
  }
  return out;
}

function decorateEmbed(embed) {
  const setTitle = embed.setTitle.bind(embed);
  const setDescription = embed.setDescription.bind(embed);
  const setFooter = embed.setFooter.bind(embed);
  const setAuthor = embed.setAuthor.bind(embed);
  const addFields = embed.addFields.bind(embed);

  embed.setTitle = value => {
    const source = String(value ?? '');
    embed.__aunxzSourceTitle = source;
    const override = db.getEmbedText(source);
    const actual = override?.title || emojify(source);
    db.registerEmbedText(source, override?.description || '', override?.footer || '');
    return setTitle(actual);
  };
  embed.setDescription = value => {
    const source = String(value ?? '');
    const sourceTitle = embed.__aunxzSourceTitle || '';
    const override = sourceTitle ? db.getEmbedText(sourceTitle) : null;
    const actual = override && override.description ? override.description : emojify(source);
    if (sourceTitle) db.registerEmbedText(sourceTitle, source, override?.footer || '');
    return setDescription(actual);
  };
  embed.setFooter = value => {
    if (value && typeof value === 'object') {
      const text = emojify(value.text);
      if (embed.__aunxzSourceTitle) db.registerEmbedText(embed.__aunxzSourceTitle, '', text);
      return setFooter({ ...value, text });
    }
    if (embed.__aunxzSourceTitle) db.registerEmbedText(embed.__aunxzSourceTitle, '', String(value || ''));
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
  embed.setTitle(title);
  return embedStyles.applySharedStyle(embed, 'info');
}
function okEmbed(title, desc) { return base(title).setColor(OK).setDescription(desc); }
function warnEmbed(title, desc) { return base(title).setColor(WARN).setDescription(desc); }
function errorEmbed(title, desc) { return base(title).setColor(DANGER).setDescription(desc); }
function infoEmbed(title, desc) { return base(title).setColor(THEME).setDescription(desc); }

// ---------------- HELP MENU ----------------
const HELP_CATEGORIES = {
  protection: {
    name: 'Protection', emojiKey: 'shield',
    desc: '**/antinuke setup** — punishment, thresholds, protected owner\n' +
      '**/antilink setup** — delete/warn/mute, domain whitelist, bypass role\n' +
      '**/antispam setup** — message/mention/emoji flood limits\n' +
      '**/antiraid setup** — join-rate lockdown, min account age\n' +
      '**/antiwebhook setup** — webhook action, bypass role, security log\n' +
      '**/antibot setup** — bot action, bypass role, security log\n' +
      '**/antialt setup** — minimum account age, action, security log\n' +
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
  automation: {
    name: 'Automation & Content', emojiKey: 'tools',
    desc: '**/autorespondersetup** — auto-reply when a message matches a phrase\n' +
      '**/autoreactorsetup** — auto-react with emoji when a message matches a phrase\n' +
      '**/embedbuilder** — build a custom embed with link buttons and post it\n' +
      '**/honeypotsetup** — trap channel that punishes anyone who posts in it\n' +
      '**/antibadwordsetup** — multilingual profanity filter\n' +
      '**/greetvoicesetup** — easy panel for the role-gated VC greeting\n' +
      '**/birthdaysetup** — birthday panel + automatic wishes'
  },
  extra: {
    name: '40+ more setups', emojiKey: 'settings',
    desc: '**/statsetup** — create and manage live social/server voice counters\n' +
      '**/giveaway create /reroll** — configure giveaways or pick a new winner\n' +
      '**/stickymessage** — create and manage persistent channel embeds\n' +
      'Use **/setup list** to see every configurable module. Smaller modules use their own **/<feature> setup** command.'
  },
  owner: {
    name: 'Owner-only', emojiKey: 'owner',
    desc: '**/maintenance** — toggle maintenance mode\n' +
      '**/blacklist add|remove** — block a user from all commands\n' +
      '**/broadcast** — DM every server owner'
  }
};

function helpHomeEmbed(client, includeOwner = false) {
  const categories = Object.entries(HELP_CATEGORIES).filter(([key]) => includeOwner || key !== 'owner');
  return base(`${emoji('help')} Help Menu`)
    .setDescription(`Pick a category from the menu below.\n\n` + categories.map(([, c]) => `${emoji(c.emojiKey)} **${c.name}**`).join('\n'))
    .setThumbnail(client.user.displayAvatarURL());
}
function helpCategoryEmbed(key) {
  const cat = HELP_CATEGORIES[key];
  if (!cat) return errorEmbed('Unknown Category', 'That help category no longer exists.');
  return base(`${emoji(cat.emojiKey)} ${cat.name}`).setDescription(cat.desc);
}
function helpSelectRow(includeOwner = false) {
  const entries = Object.entries(HELP_CATEGORIES).filter(([key]) => includeOwner || key !== 'owner');
  const menu = new StringSelectMenuBuilder()
    .setCustomId('help_select')
    .setPlaceholder('Choose a category…')
    .addOptions(entries.map(([value, c]) => ({ label: c.name, value, emoji: emoji(c.emojiKey) })));
  return new ActionRowBuilder().addComponents(menu);
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

function automodSetupEmbed(cfg = {}) {
  const a = cfg.automod || cfg;
  return base(`${emoji('shield')} AutoMod`)
    .setDescription(`**Status:** ${a.enabled !== false ? `${emoji('enabled')} Enabled` : `${emoji('disabled')} Disabled`}\n**Bad Words:** ${a.badWordFilter ? 'On' : 'Off'}\n**Caps:** ${a.capsFilter ? `${a.capsThreshold || 70}%` : 'Off'}\n**Invites:** ${a.inviteFilter ? 'On' : 'Off'}\n\nUse the controls below to configure AutoMod.`);
}
function automodSetupRows(cfg = {}) {
  const a = cfg.automod || cfg;
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('automod_cfg:toggle').setLabel(a.enabled === false ? 'Enable' : 'Disable').setStyle(a.enabled === false ? ButtonStyle.Success : ButtonStyle.Danger).setEmoji(a.enabled === false ? emoji('enabled') : emoji('disabled')),
    new ButtonBuilder().setCustomId('automod_cfg:words').setLabel('Bad Words').setStyle(ButtonStyle.Secondary).setEmoji(emoji('warning')),
    new ButtonBuilder().setCustomId('automod_cfg:caps').setLabel('Caps').setStyle(ButtonStyle.Secondary).setEmoji('🔠'),
    new ButtonBuilder().setCustomId('automod_cfg:invite').setLabel('Invites').setStyle(ButtonStyle.Secondary).setEmoji(emoji('link'))
  )];
}

// ---------------- OWNER: /emoji ----------------
function emojiRegistryEntries() {
  return [
    ...EMOJI_KEYS.map(key => ({ key, value: emoji(key), originalValue: DEFAULT_EMOJIS[key], custom: !!db.getEmojiOverride(key), dynamic: false, usedIn: [] })),
    ...dynamicEmojiEntries()
  ];
}
function emojiSnapshotObject() {
  const values = {};
  for (const entry of emojiRegistryEntries()) values[entry.key] = entry.value;
  return values;
}
function formatEmojiSnapshot(values = {}) {
  return Object.entries(values).map(([key, value]) => {
    const custom = String(value).match(/^<a?:([^:>]+):(\d+)>$/);
    return `${key}: ${custom ? `${custom[1]}/${custom[2]} ${value}` : value}`;
  }).join('\n');
}
function emojisListEmbed(overrides = {}, page = 1, pageSize = 8) {
  const all = emojiRegistryEntries();
  const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
  const safePage = Math.min(totalPages, Math.max(1, Number(page) || 1));
  const slice = all.slice((safePage - 1) * pageSize, safePage * pageSize);
  const lines = slice.map((entry, i) => {
    const mark = entry.custom ? ' *(custom)*' : '';
    const used = entry.usedIn?.length ? `\n   Used in: ${entry.usedIn.map(x => `\`${x}\``).join(', ')}` : '';
    const custom = String(entry.value).match(/^<a?:([^:>]+):(\d+)>$/);
    const copy = custom ? `\`${custom[1]}/${custom[2]}\` • ${entry.value}` : entry.value;
    return `**${(safePage - 1) * pageSize + i + 1}. ${entry.key}:** ${copy}${mark}${used}`;
  });
  return base(`${emoji('emoji')} AunXz Emojis`)
    .setDescription(`**STATUS**\n${emoji('enabled')} **Registry:** \`${all.length} entries\`\n\n${lines.join('\n\n') || 'No emojis registered yet.'}\n\nUse **/emoji set** for named defaults. Use **/em add** for a custom emoji. Use **/em edit** to edit embed text. Emojis used in registered embeds appear here automatically and disappear when no longer used.\n\n**Page ${safePage}/${totalPages}**`);
}
function emojisListRows(page = 1, pageSize = 8) {
  const total = emojiRegistryEntries().length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safe = Math.min(totalPages, Math.max(1, Number(page) || 1));
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`emoji:list:prev:${Math.max(1, safe - 1)}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(safe <= 1).setEmoji('◀️'),
    new ButtonBuilder().setCustomId(`emoji:page:${safe}`).setLabel(`${safe}/${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`emoji:list:next:${Math.min(totalPages, safe + 1)}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(safe >= totalPages).setEmoji('▶️')
  )];
}

function embedTextsListEmbed(page = 1, pageSize = 6) {
  const rows = db.listEmbedTexts(500);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(totalPages, Math.max(1, Number(page) || 1));
  const slice = rows.slice((safePage - 1) * pageSize, safePage * pageSize);
  const lines = slice.map((r, i) => `**${(safePage - 1) * pageSize + i + 1}. \`${r.name}\`**\n**Title:** ${r.title || r.sourceTitle}\n**Description:** ${(r.description || '*none*').slice(0, 650)}`);
  return base(`${emoji('emoji')} Embed Text Registry`)
    .setDescription(`${lines.join('\n\n') || 'No embed texts have been registered yet. Use the bot normally, then run this again.'}\n\n**Page ${safePage}/${totalPages} • ${rows.length} registered embeds**`);
}
function embedTextsListRows(page = 1, pageSize = 6) {
  const total = Math.max(1, Math.ceil(db.listEmbedTexts(500).length / pageSize));
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`em:list:prev:${Math.max(1, page - 1)}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1).setEmoji('◀️'),
    new ButtonBuilder().setCustomId(`em:page:${page}`).setLabel(`${page}/${total}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`em:list:next:${Math.min(total, page + 1)}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= total).setEmoji('▶️')
  )];
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
  antiwebhook: { emojiKey: 'shield', title: 'Anti-Webhook', cfgKey: 'antiwebhook' },
  antibot: { emojiKey: 'shield', title: 'Anti-Bot', cfgKey: 'antibot' },
  antialt: { emojiKey: 'shield', title: 'Anti-Alt', cfgKey: 'antialt' },
  voicemaster: { emojiKey: 'voice', title: 'Voicemaster', cfgKey: 'voicemaster' },
  greetmessage: { emojiKey: 'wave', title: 'Greet Message', cfgKey: 'greetmessage' },
  leveling: { emojiKey: 'level', title: 'Leveling', cfgKey: 'leveling' },
  tickets: { emojiKey: 'ticket', title: 'Tickets', cfgKey: 'ticket' }
};

function setupPanelEmbed(sub, cfg) {
  const meta = SETUP_MODULE_META[sub];
  const modcfg = cfg[meta.cfgKey];
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

function setupPanelRow(sub, cfg) {
  const meta = SETUP_MODULE_META[sub]; const enabled = cfg[meta.cfgKey].enabled;
  if (['antiwebhook','antibot','antialt'].includes(sub)) {
    const rows=[new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`setup_toggle:${sub}`).setLabel(enabled?'Disable':'Enable').setStyle(enabled?ButtonStyle.Danger:ButtonStyle.Success).setEmoji(enabled?emoji('disabled'):emoji('enabled')),
      new ButtonBuilder().setCustomId(`setup_edit:${sub}`).setLabel('Edit Settings').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings'))
    )];
    if(sub==='antiwebhook'){
      rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('security_cfg:antiwebhook:action').setPlaceholder('Choose webhook action…').addOptions({label:'Delete webhook',value:'delete',emoji:'🗑️'},{label:'Kick creator',value:'kick',emoji:'👢'},{label:'Ban creator',value:'ban',emoji:'🔨'},{label:'Strip roles',value:'strip_roles',emoji:'🔒'})));
      rows.push(new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('security_cfg:antiwebhook:bypass').setPlaceholder('Select trusted inviter role…')));
    } else if(sub==='antibot'){
      rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('security_cfg:antibot:action').setPlaceholder('Choose unapproved bot action…').addOptions({label:'Kick',value:'kick',emoji:'👢'},{label:'Ban',value:'ban',emoji:'🔨'},{label:'Strip roles',value:'strip_roles',emoji:'🔒'})));
      rows.push(new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('security_cfg:antibot:bypass').setPlaceholder('Select bypass role…')));
    } else {
      rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('security_cfg:antialt:action').setPlaceholder('Choose new-account action…').addOptions({label:'Kick',value:'kick',emoji:'👢'},{label:'Ban',value:'ban',emoji:'🔨'})));
      rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('security_cfg:antialt:age').setPlaceholder('Minimum account age…').addOptions([1,3,7,14,30,60,90].map(v=>({label:`${v} day${v===1?'':'s'}`,value:String(v)})))));
    }
    rows.push(new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`security_cfg:${sub}:log`).setPlaceholder('Select security log channel…').addChannelTypes(ChannelType.GuildText)));
    return rows;
  }
  return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`setup_toggle:${sub}`).setLabel(enabled?'Disable':'Enable').setStyle(enabled?ButtonStyle.Danger:ButtonStyle.Success).setEmoji(enabled?emoji('disabled'):emoji('enabled')),new ButtonBuilder().setCustomId(`setup_edit:${sub}`).setLabel('Edit Settings').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')))];
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

// ---------------- FEATURE SETUP SELECTION PANELS ----------------
function featureSetupEmbed(title, description, fields=[]) {
  const e = base(`${emoji('settings')} ${title}`).setDescription(description);
  if (fields.length) e.addFields(fields.slice(0, 25));
  return e;
}
function featureSetupRow(prefix, buttons=['edit','post']) {
  const map = { edit:['Edit Settings',ButtonStyle.Primary,'settings'], post:['Post Panel',ButtonStyle.Success,'success'], test:['Test','test','success'] };
  return new ActionRowBuilder().addComponents(buttons.map(k => {
    const [label,style,key]=map[k] || [k,ButtonStyle.Secondary,'settings'];
    return new ButtonBuilder().setCustomId(`${prefix}:${k}`).setLabel(label).setStyle(style === 'test' ? ButtonStyle.Secondary : style).setEmoji(emoji(key));
  }));
}
function selectedPanel(cfg, kind, selectedId) {
  const key = kind === 'button' ? 'buttonRolePanels' : 'reactionRolePanels';
  const list = Array.isArray(cfg[key]) ? cfg[key] : [];
  return list.find(p => p.id === selectedId) || list[0] || null;
}
function panelStatus(panel) { return panel?.enabled === false ? `${emoji('disabled')} Disabled` : `${emoji('enabled')} Enabled`; }
function buttonRoleEmbed(cfg, selectedId) {
  const panels = Array.isArray(cfg.buttonRolePanels) ? cfg.buttonRolePanels : [];
  const panel = selectedPanel(cfg, 'button', selectedId);
  const list = panels.slice(0, 12).map((p, i) => `${i + 1}. **${p.title || `Panel ${i + 1}`}** — ${p.enabled === false ? 'Disabled' : 'Enabled'} — ${p.buttons?.length || 0} role(s)${p.messageId ? ' • posted' : ''}`).join('\n') || 'No panels yet. Press **Create Panel**.';
  return featureSetupEmbed('Button Roles', 'Create multiple independent role panels. Roles are selected with Discord’s native role picker — no role IDs to copy.', [
    {name:'Panels',value:list,inline:false},
    {name:'Selected',value:panel ? `${panel.title || 'Untitled'}
${panel.channelId ? `<#${panel.channelId}>` : 'Channel not set'}
${panelStatus(panel)}` : 'None',inline:false},
    {name:'Role buttons',value:panel ? String((panel.buttons||[]).length) : '0',inline:true},
    {name:'Style',value:panel?.embedType||'embed',inline:true}
  ]);
}
function buttonRoleSetupRows(cfg, selectedId) {
  const panels = Array.isArray(cfg.buttonRolePanels) ? cfg.buttonRolePanels : [];
  const panel = selectedPanel(cfg, 'button', selectedId);
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('buttonroles_cfg:create').setLabel('Create Panel').setStyle(ButtonStyle.Success).setEmoji(emoji('add')),
    new ButtonBuilder().setCustomId('buttonroles_cfg:toggle').setLabel(panel?.enabled === false ? 'Enable' : 'Disable').setStyle(panel?.enabled === false ? ButtonStyle.Success : ButtonStyle.Danger).setDisabled(!panel),
    new ButtonBuilder().setCustomId('buttonroles_cfg:delete').setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji(emoji('delete')).setDisabled(!panel)
  )];
  if (panels.length) rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('buttonroles_cfg:select').setPlaceholder('Select a button-role panel…')
      .addOptions(panels.slice(0,25).map((p,i)=>({label:(p.title || `Panel ${i+1}`).slice(0,100),value:p.id,description:`${p.buttons?.length||0} role(s) • ${p.enabled === false ? 'disabled' : 'enabled'}`})))
  ));
  if (panel) {
    rows.push(new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(`buttonroles_cfg:channel:${panel.id}`).setPlaceholder('Select where this panel should be posted…').setChannelTypes(ChannelType.GuildText)
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`buttonroles_cfg:settings:${panel.id}`).setLabel('Panel Text').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')),
      new ButtonBuilder().setCustomId(`buttonroles_cfg:addrole:${panel.id}`).setLabel('Add Role').setStyle(ButtonStyle.Primary).setEmoji(emoji('add'))
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`buttonroles_cfg:upload:${panel.id}`).setLabel('Send Image/GIF').setStyle(ButtonStyle.Secondary).setEmoji('🖼️'),
      new ButtonBuilder().setCustomId(`buttonroles_cfg:remove_image:${panel.id}`).setLabel('Remove Image').setStyle(ButtonStyle.Secondary).setDisabled(!panel.image),
      new ButtonBuilder().setCustomId(`buttonroles_cfg:post:${panel.id}`).setLabel(panel.messageId ? 'Post Again' : 'Post Panel').setStyle(ButtonStyle.Success)
    ));
    const roles = panel.buttons || [];
    if (roles.length) rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`buttonroles_cfg:remove_role:${panel.id}`).setPlaceholder('Remove a role button…')
        .addOptions(roles.slice(0,25).map((r,i)=>({label:(r.label || `Role ${i+1}`).slice(0,100),value:r.roleId})))
    ));
  }
  return rows.slice(0,5);
}
function reactionRoleSetupEmbed(cfg, selectedId) {
  const panels = Array.isArray(cfg.reactionRolePanels) ? cfg.reactionRolePanels : [];
  const panel = selectedPanel(cfg, 'reaction', selectedId);
  const list = panels.slice(0,12).map((p,i)=>`${i+1}. **${p.title || `Panel ${i+1}`}** — ${p.enabled === false ? 'Disabled' : 'Enabled'} — ${p.mappings?.length || 0} role(s)${p.messageId ? ' • posted' : ''}`).join('\n') || 'No panels yet. Press **Create Panel**.';
  return featureSetupEmbed('Reaction Roles', 'Create multiple independent reaction-role panels. Roles are selected with Discord’s native role picker — no role IDs to copy.', [
    {name:'Panels',value:list,inline:false},
    {name:'Selected',value:panel ? `${panel.title || 'Untitled'}
${panel.channelId ? `<#${panel.channelId}>` : 'Channel not set'}
${panelStatus(panel)}` : 'None',inline:false},
    {name:'Mappings',value:panel ? String((panel.mappings||[]).length) : '0',inline:true},
    {name:'Message',value:panel?.messageId ? `#${panel.messageId}` : 'Not posted',inline:true}
  ]);
}
function reactionRoleSetupRows(cfg, selectedId) {
  const panels = Array.isArray(cfg.reactionRolePanels) ? cfg.reactionRolePanels : [];
  const panel = selectedPanel(cfg, 'reaction', selectedId);
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('reactionroles_cfg:create').setLabel('Create Panel').setStyle(ButtonStyle.Success).setEmoji(emoji('add')),
    new ButtonBuilder().setCustomId('reactionroles_cfg:toggle').setLabel(panel?.enabled === false ? 'Enable' : 'Disable').setStyle(panel?.enabled === false ? ButtonStyle.Success : ButtonStyle.Danger).setDisabled(!panel),
    new ButtonBuilder().setCustomId('reactionroles_cfg:delete').setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji(emoji('delete')).setDisabled(!panel)
  )];
  if (panels.length) rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('reactionroles_cfg:select').setPlaceholder('Select a reaction-role panel…')
      .addOptions(panels.slice(0,25).map((p,i)=>({label:(p.title || `Panel ${i+1}`).slice(0,100),value:p.id,description:`${p.mappings?.length||0} role(s) • ${p.enabled === false ? 'disabled' : 'enabled'}`})))
  ));
  if (panel) {
    rows.push(new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(`reactionroles_cfg:channel:${panel.id}`).setPlaceholder('Select where this panel should be posted…').setChannelTypes(ChannelType.GuildText)
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`reactionroles_cfg:settings:${panel.id}`).setLabel('Panel Text').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')),
      new ButtonBuilder().setCustomId(`reactionroles_cfg:addrole:${panel.id}`).setLabel('Add Role').setStyle(ButtonStyle.Primary).setEmoji(emoji('add'))
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`reactionroles_cfg:post:${panel.id}`).setLabel(panel.messageId ? 'Post Again' : 'Post Panel').setStyle(ButtonStyle.Success)
    ));
    const roles = panel.mappings || [];
    if (roles.length) rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`reactionroles_cfg:remove_role:${panel.id}`).setPlaceholder('Remove a reaction-role mapping…')
        .addOptions(roles.slice(0,25).map((r,i)=>({label:(r.label || r.emoji || `Role ${i+1}`).slice(0,100),value:r.roleId})) )
    ));
  }
  return rows.slice(0,5);
}
function staffApplicationEmbed(cfg) { return featureSetupEmbed('Staff Applications', 'Members press Apply, receive a DM, choose Ready, then answer your questions one by one.', [
  {name:'Questions',value:String((cfg.questions||[]).length),inline:true}, {name:'Application log',value:cfg.logChannelId ? `<#${cfg.logChannelId}>`:'Not set',inline:true}
]); }
function birthdaySetupEmbed(cfg) { return featureSetupEmbed('Birthday System', 'Members press the birthday button and enter a date such as 8-8. The bot posts wishes in the configured wish channel.', [
  {name:'Panel',value:cfg.panelChannelId ? `<#${cfg.panelChannelId}>`:'Not set',inline:true}, {name:'Wish channel',value:cfg.wishChannelId ? `<#${cfg.wishChannelId}>`:'Not set',inline:true}
]); }
function honeypotSetupEmbed(cfg = {}) { return featureSetupEmbed('Honeypot', 'This channel is a no-message zone. Messages trigger the selected action when enabled.', [
  {name:'Status',value:cfg.enabled?'🟢 Enabled':'🔴 Disabled',inline:true},
  {name:'Channel',value:cfg.channelId ? `<#${cfg.channelId}>`:'Not set',inline:true},
  {name:'Action',value:cfg.action||'kick',inline:true},
  {name:'Log Channel',value:cfg.logChannelId ? `<#${cfg.logChannelId}>`:'Not set',inline:true},
  {name:'Cleanup',value:cfg.cleanupWindow||'none',inline:true},
  {name:'Whitelisted Roles',value:Array.isArray(cfg.whitelistRoleIds)&&cfg.whitelistRoleIds.length?cfg.whitelistRoleIds.map(id=>`<@&${id}>`).join(', ').slice(0,1000):'None',inline:false}
]); }
function birthdaySetupRow(cfg) {
  return [
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('birthday_cfg:panel').setPlaceholder('Select birthday panel channel').setChannelTypes(ChannelType.GuildText)),
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('birthday_cfg:wish').setPlaceholder('Select birthday wish channel').setChannelTypes(ChannelType.GuildText)),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('birthday_cfg:message').setLabel('Set Wish Message').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')), new ButtonBuilder().setCustomId('birthday_cfg:post').setLabel('Post / Refresh Panel').setStyle(ButtonStyle.Success).setEmoji(emoji('success')))
  ];
}
function antiBadwordSetupEmbed(cfg) { return featureSetupEmbed('Anti Bad Word', 'Multilingual profanity protection with Unicode normalization and Hinglish/romanized profanity patterns. Choose the log channel and action below.', [
  {name:'Status',value:cfg.enabled?'Enabled':'Disabled',inline:true}, {name:'Log',value:cfg.logChannelId?`<#${cfg.logChannelId}>`:'Not set',inline:true}, {name:'Action',value:cfg.action||'delete',inline:true}, {name:'Custom words',value:String((cfg.customWords||[]).length),inline:true}
]); }
function antiBadwordSetupRow(cfg) { return [
  new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('antibadword_cfg:log').setPlaceholder('Select logging channel').setChannelTypes(ChannelType.GuildText)),
  new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('antibadword_cfg:action').setPlaceholder(`Action: ${cfg.action||'delete'}`).addOptions({label:'Delete only',value:'delete',emoji:emoji('delete')},{label:'Delete + timeout',value:'timeout',emoji:emoji('mute')})),
  new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('antibadword_cfg:words').setLabel('Add Custom Words').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')), new ButtonBuilder().setCustomId('antibadword_cfg:toggle').setLabel(cfg.enabled?'Disable':'Enable').setStyle(cfg.enabled?ButtonStyle.Danger:ButtonStyle.Success).setEmoji(cfg.enabled?emoji('disabled'):emoji('enabled')))
]; }
function honeypotSetupRow(cfg = {}) { return [
  new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('honeypot_cfg:channel').setPlaceholder('Select honeypot channel').setChannelTypes(ChannelType.GuildText)),
  new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('honeypot_cfg:action').setPlaceholder(`Action: ${cfg.action||'kick'}`).addOptions({label:'Kick',value:'kick',emoji:emoji('kick')},{label:'Ban',value:'ban',emoji:emoji('shield')},{label:'Timeout',value:'timeout',emoji:emoji('mute')},{label:'Delete only',value:'delete',emoji:emoji('delete')})),
  new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('honeypot_cfg:log').setPlaceholder(cfg.logChannelId?'Change log channel':'Select log channel').setChannelTypes(ChannelType.GuildText)),
  new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('honeypot_cfg:whitelist').setPlaceholder('Select whitelisted roles (replaces list)').setMinValues(1).setMaxValues(10)),
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('honeypot_cfg:toggle').setLabel(cfg.enabled?'Enabled':'Disabled').setStyle(cfg.enabled?ButtonStyle.Success:ButtonStyle.Danger).setEmoji(cfg.enabled?emoji('enabled'):emoji('disabled')),
    new ButtonBuilder().setCustomId('honeypot_cfg:cleanup').setLabel(`Cleanup: ${cfg.cleanupWindow||'none'}`).setStyle(ButtonStyle.Secondary).setEmoji('🧹'),
    new ButtonBuilder().setCustomId('honeypot_cfg:invite').setLabel(cfg.createInvite?'Invite DM: ON':'Invite DM: OFF').setStyle(cfg.createInvite?ButtonStyle.Success:ButtonStyle.Secondary).setEmoji(emoji('link')),
    new ButtonBuilder().setCustomId('honeypot_cfg:dm').setLabel('Set Kick DM').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')),
    new ButtonBuilder().setCustomId('honeypot_cfg:whitelist-clear').setLabel('Clear Roles').setStyle(ButtonStyle.Secondary).setEmoji(emoji('remove'))
  )
]; }
function greetVoiceSetupEmbed(cfg) {
  const mode = cfg.mode === 'audio' ? 'Uploaded audio' : 'TTS';
  const audio = cfg.audioPath ? 'Uploaded and saved' : 'Not uploaded';
  return featureSetupEmbed('Greet Voice', 'New members receive the gate role, join the selected voice channel, hear the configured greeting, then are disconnected and released. The feature only runs when Status is Enabled.', [
    {name:'Status',value:cfg.enabled?'Enabled':'Disabled',inline:true},
    {name:'Mode',value:mode,inline:true},
    {name:'Role',value:cfg.roleId?`<@&${cfg.roleId}>`:'Not set',inline:true},
    {name:'Voice',value:cfg.vcId?`<#${cfg.vcId}>`:'Not set',inline:true},
    {name:'TTS Prompt',value:cfg.ttsPrompt||'Not set',inline:false},
    {name:'Audio',value:audio,inline:false}
  ]);
}
function greetVoiceSetupRow(cfg) { return [
  new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('greetvoice_cfg:voice').setPlaceholder('Choose the welcome voice channel').setChannelTypes(ChannelType.GuildVoice)
  ),
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('greetvoice_cfg:role').setLabel('Gate Role').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')),
    new ButtonBuilder().setCustomId('greetvoice_cfg:prompt').setLabel('Set TTS Message').setStyle(ButtonStyle.Primary).setEmoji(emoji('voice')),
    new ButtonBuilder().setCustomId('greetvoice_cfg:audio').setLabel(cfg.audioPath ? 'Replace Audio' : 'Upload Audio').setStyle(ButtonStyle.Secondary).setEmoji('🎵'),
    new ButtonBuilder().setCustomId('greetvoice_cfg:test').setLabel('Test Greeting').setStyle(ButtonStyle.Secondary).setEmoji(emoji('success')),
    new ButtonBuilder().setCustomId('greetvoice_cfg:toggle').setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(cfg.enabled ? emoji('disabled') : emoji('enabled'))
  )
]; }

// ---------------- AUTORESPONDER ----------------
function autoresponderSetupEmbed(cfg) {
  const triggers = cfg.triggers || [];
  const list = triggers.slice(0, 10).map((t, i) => `**${i + 1}.** \`${t.match}\` (${t.mode}) → ${String(t.response || '').slice(0, 60)}`).join('\n') || 'No triggers yet — press Add Trigger to create one.';
  return featureSetupEmbed('Auto Responder', 'Automatically replies when a message matches a phrase. Use `{user}` and `{server}` in the response text.', [
    { name: 'Status', value: cfg.enabled ? 'Enabled' : 'Disabled', inline: true },
    { name: 'Triggers', value: String(triggers.length), inline: true },
    { name: 'Matching', value: cfg.ignoreCase ? 'Case-insensitive' : 'Case-sensitive', inline: true },
    { name: 'Current triggers', value: list, inline: false }
  ]);
}
function autoresponderSetupRow(cfg) {
  const triggers = cfg.triggers || [];
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('autoresponder_cfg:toggle').setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(cfg.enabled ? emoji('disabled') : emoji('enabled')),
    new ButtonBuilder().setCustomId('autoresponder_cfg:add').setLabel('Add Trigger').setStyle(ButtonStyle.Primary).setEmoji(emoji('add')),
    new ButtonBuilder().setCustomId('autoresponder_cfg:case').setLabel(cfg.ignoreCase ? 'Case: Insensitive' : 'Case: Sensitive').setStyle(ButtonStyle.Secondary).setEmoji(emoji('settings'))
  )];
  if (triggers.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('autoresponder_cfg:remove').setPlaceholder('Remove a trigger…')
        .addOptions(triggers.slice(0, 25).map(t => ({ label: (t.match || '(empty)').slice(0, 90), value: t.id, emoji: emoji('remove') })))
    ));
  }
  return rows;
}

// ---------------- AUTOREACTOR ----------------
function autoreactorSetupEmbed(cfg) {
  const triggers = cfg.triggers || [];
  const list = triggers.slice(0, 10).map((t, i) => `**${i + 1}.** \`${t.match}\` (${t.mode}) → ${(t.emojis || []).join(' ')}`).join('\n') || 'No triggers yet — press Add Trigger to create one.';
  return featureSetupEmbed('Auto Reactor', 'Automatically reacts with emoji when a message matches a phrase.', [
    { name: 'Status', value: cfg.enabled ? 'Enabled' : 'Disabled', inline: true },
    { name: 'Triggers', value: String(triggers.length), inline: true },
    { name: 'Matching', value: cfg.ignoreCase ? 'Case-insensitive' : 'Case-sensitive', inline: true },
    { name: 'Current triggers', value: list, inline: false }
  ]);
}
function autoreactorSetupRow(cfg) {
  const triggers = cfg.triggers || [];
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('autoreactor_cfg:toggle').setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(cfg.enabled ? emoji('disabled') : emoji('enabled')),
    new ButtonBuilder().setCustomId('autoreactor_cfg:add').setLabel('Add Trigger').setStyle(ButtonStyle.Primary).setEmoji(emoji('add')),
    new ButtonBuilder().setCustomId('autoreactor_cfg:case').setLabel(cfg.ignoreCase ? 'Case: Insensitive' : 'Case: Sensitive').setStyle(ButtonStyle.Secondary).setEmoji(emoji('settings'))
  )];
  if (triggers.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('autoreactor_cfg:remove').setPlaceholder('Remove a trigger…')
        .addOptions(triggers.slice(0, 25).map(t => ({ label: (t.match || '(empty)').slice(0, 90), value: t.id, emoji: emoji('remove') })))
    ));
  }
  return rows;
}

// ---------------- LOG SETUP ----------------
function logSetupEmbed(cfg) {
  const labels = [
    ['mod','Moderation'],['message','Messages'],['member','Members'],['voice','Voice'],
    ['antinuke','Anti-Nuke'],['server','Server'],['ticket','Tickets'],['join','Join/Leave']
  ];
  const text = labels.map(([key,label]) => `**${label}:** ${cfg[key] ? `<#${cfg[key]}>` : 'Not set'}`).join('\n');
  return featureSetupEmbed('Logging', 'Choose where each type of log should be sent. Each selector controls one independent log stream.', [
    {name:'Status',value:'Configured per log type',inline:false},
    {name:'Destinations',value:text,inline:false}
  ]);
}
function logSetupRows(cfg) {
  const labels = [
    ['mod', 'Moderation'], ['message', 'Messages'], ['member', 'Members'], ['voice', 'Voice'],
    ['antinuke', 'Anti-Nuke'], ['server', 'Server'], ['ticket', 'Tickets'], ['join', 'Join/Leave']
  ];
  const typeMenu = new StringSelectMenuBuilder()
    .setCustomId('logsetup:type')
    .setPlaceholder('1. Select a log type…')
    .addOptions(labels.map(([value, label]) => ({
      label,
      value,
      description: cfg[value] ? `Currently: ${cfg[value]}` : 'Not configured yet'
    })));
  const channelMenu = new ChannelSelectMenuBuilder()
    .setCustomId('logsetup:channel')
    .setPlaceholder('2. Select the destination channel…')
    .setChannelTypes(ChannelType.GuildText);
  return [
    new ActionRowBuilder().addComponents(typeMenu),
    new ActionRowBuilder().addComponents(channelMenu)
  ];
}

// ---------------- OWNER LOGS / MEMBERSHIP ----------------
function ownerLogSetupEmbed(cfg = {}) {
  const e = base(`${emoji('owner')} Owner Log Control Center`);
  e.setDescription(
    `Configure where AunXz sends its global owner logs.\n\n` +
    `**Error logs:** ${cfg.errorChannelId ? `<#${cfg.errorChannelId}>` : '*not set*'}\n` +
    `**Online/offline logs:** ${cfg.onlineChannelId ? `<#${cfg.onlineChannelId}>` : '*not set*'}\n` +
    `**Join logs:** ${cfg.joinChannelId ? `<#${cfg.joinChannelId}>` : '*not set*'}\n\n` +
    `The selected channels are global to the bot and are only configurable by bot owners.`
  );
  return e;
}
function ownerLogSetupRows(cfg = {}) {
  return [
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('ownerlogsetup:error').setPlaceholder(cfg.errorChannelId ? 'Change error log channel…' : 'Select error log channel…').setChannelTypes(ChannelType.GuildText)),
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('ownerlogsetup:online').setPlaceholder(cfg.onlineChannelId ? 'Change online/offline channel…' : 'Select online/offline channel…').setChannelTypes(ChannelType.GuildText)),
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('ownerlogsetup:join').setPlaceholder(cfg.joinChannelId ? 'Change join log channel…' : 'Select join log channel…').setChannelTypes(ChannelType.GuildText))
  ];
}
function ownerJoinLogEmbed(guild) {
  return base(`${emoji('owner')} AunXz Joined a Server`)
    .setDescription(
      `**Server:** ${guild.name}\n` +
      `**ID:** \`${guild.id}\`\n` +
      `**Owner:** <@${guild.ownerId}>\n` +
      `**Members:** ${guild.memberCount || 0}\n` +
      `**Created:** <t:${Math.floor(guild.createdTimestamp / 1000)}:F>\n\n` +
      `Use **AunXz** for owner-only controls.`
    );
}
function ownerJoinLogRows(guildId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`owner:guild:${guildId}`).setLabel('AunXz').setStyle(ButtonStyle.Primary).setEmoji(emoji('owner'))
  )];
}
function ownerGuildControlEmbed(guild) {
  return base(`${emoji('owner')} Server Controls`)
    .setDescription(`**${guild.name}**\n\`${guild.id}\`\n\nChoose an owner action below.`);
}
function ownerGuildControlRows(guildId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`owner:infoask:${guildId}`).setLabel('Server Info').setStyle(ButtonStyle.Primary).setEmoji(emoji('info') || 'ℹ️'),
    new ButtonBuilder().setCustomId(`owner:leave:${guildId}`).setLabel('Leave').setStyle(ButtonStyle.Danger).setEmoji(emoji('delete')),
    new ButtonBuilder().setCustomId(`owner:invite:${guildId}`).setLabel('Generate Invite').setStyle(ButtonStyle.Success).setEmoji(emoji('add'))
  )];
}
function ownerInfoChoiceEmbed(guild) {
  return base(`${emoji('owner')} Server Info Access`)
    .setDescription(`Choose which member group should be included with the server report for **${guild.name}**.`);
}
function ownerInfoChoiceRows(guildId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`owner:info:admins:${guildId}`).setLabel('Admins').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`owner:info:higher:${guildId}`).setLabel('Higher Roles').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`owner:info:none:${guildId}`).setLabel('Server Only').setStyle(ButtonStyle.Secondary)
  )];
}
function membershipListEmbed(rows, page = 1, pageSize = 5) {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safe = Math.min(totalPages, Math.max(1, Number(page) || 1));
  const slice = rows.slice((safe - 1) * pageSize, safe * pageSize);
  const now = Date.now();
  const lines = slice.map((r, i) => {
    const active = now < r.expiresAt;
    return `${(safe - 1) * pageSize + i + 1}. **${r.plan || 'Membership'}**\n` +
      `\`${r.guildId}\`\n` +
      `• Plan: **${r.plan}** | Status: ${active ? `${emoji('enabled')} Active` : `${emoji('disabled')} Expired`}\n` +
      `• Expires: <t:${Math.floor(r.expiresAt / 1000)}:F> (<t:${Math.floor(r.expiresAt / 1000)}:R>)`;
  });
  return base(`${emoji('owner')} AunXz Memberships`)
    .setDescription(`${lines.join('\n\n') || 'No memberships configured yet.'}\n\n**Page ${safe} of ${totalPages} • Total Subscriptions: ${rows.length}**`);
}
function membershipListRows(rows, page = 1, pageSize = 5) {
  const total = Math.max(1, Math.ceil(rows.length / pageSize));
  const safe = Math.min(total, Math.max(1, Number(page) || 1));
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ms:list:prev:${Math.max(1, safe - 1)}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(safe <= 1).setEmoji('◀️'),
    new ButtonBuilder().setCustomId(`ms:page:${safe}`).setLabel(`${safe}/${total}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`ms:list:next:${Math.min(total, safe + 1)}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(safe >= total).setEmoji('▶️')
  )];
}

// ---------------- EMBED BUILDER ----------------
function embedBuilderPreviewEmbed(draft) {
  const e = base(draft.title || 'Untitled Embed');
  e.setDescription(draft.description || '*No description set — press Edit Text.*');
  if (draft.color) { const n = parseInt(String(draft.color).replace('#', ''), 16); if (!Number.isNaN(n)) e.setColor(n); }
  if (draft.imageUrl) e.setImage(draft.imageUrl);
  if (draft.thumbnailUrl) e.setThumbnail(draft.thumbnailUrl);
  if (draft.footer) e.setFooter({ text: draft.footer.slice(0, 200) });
  if (draft.buttons?.length) e.addFields({ name: 'Buttons', value: draft.buttons.map((b,i)=>`${i+1}. **${b.label}** → ${b.response?.title || 'Private response'}`).join('\n').slice(0,1024), inline:false });
  return e;
}
function embedBuilderRow(draft) {
  const buttons = draft.buttons || [];
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('embedbuilder:text').setLabel('Edit Text').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')),
    new ButtonBuilder().setCustomId('embedbuilder:image').setLabel('Edit Images').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')),
    new ButtonBuilder().setCustomId('embedbuilder:addbutton').setLabel('Add Response Button').setStyle(ButtonStyle.Secondary).setEmoji(emoji('add')),
    new ButtonBuilder().setCustomId('embedbuilder:save').setLabel('Save').setStyle(ButtonStyle.Success).setEmoji(emoji('success'))
  )];
  if (buttons.length) rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('embedbuilder:removebutton').setPlaceholder(`Remove a button… (${buttons.length} added)`)
      .addOptions(buttons.slice(0,25).map((b,i)=>({label:(b.label||'Button').slice(0,100),value:String(i),emoji:emoji('remove')})))
  ));
  return rows;
}

// ---------------- COMPONENTS V2 CONVERSION ----------------
// Converts an embed into a Components V2 Container (title/description/fields/images/footer as
// text displays, sections and media galleries). Buttons/selects are added inside the container by toComponentsV2.
// Rewrites { embeds, components, content, ephemeral } into a Components V2 payload.
// Every payload that contains at least one embed is converted (with or without buttons/selects).
// Payloads without embeds pass through untouched. `force` is kept for API compatibility.
function flattenComponentRows(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) { for (const item of value) flattenComponentRows(item, out); return out; }
  if (value instanceof ActionRowBuilder || value?.type === 1 || value?.data?.type === 1) out.push(value);
  else if (value?.toJSON && value.toJSON()?.type === 1) out.push(value);
  return out;
}

// Discord rejects a whole message when two interactive children share a custom_id.
// This validator is deliberately conservative: it preserves the first control and
// drops only later duplicates, which is especially important for disabled pagination
// buttons where a one-page list naturally used to generate identical Prev/Next IDs.
function sanitizeUniqueCustomIds(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const data = typeof row?.toJSON === 'function' ? row.toJSON() : row;
    const children = Array.isArray(data?.components) ? data.components : [];
    if (!children.length) continue;
    const kept = [];
    for (const child of children) {
      const id = child?.custom_id;
      if (id && seen.has(id)) {
        console.warn(`[AunXz] Removed duplicate component custom_id: ${id}`);
        continue;
      }
      if (id) seen.add(id);
      kept.push(child);
    }
    if (kept.length) out.push(new ActionRowBuilder({ type: 1, components: kept }));
  }
  return out;
}

function embedToContainer(embedLike, rows = []) {
  const d = typeof embedLike?.toJSON === 'function' ? embedLike.toJSON() : (embedLike || {});
  const brand = embedStyles.getContainerBranding(d);
  const container = new ContainerBuilder();
  container.setAccentColor(brand.color);
  const intro = [];
  if (d.author?.name) intro.push(`**${emojify(d.author.name)}**`);
  if (d.title) intro.push(d.url ? `## [${emojify(d.title)}](${d.url})` : `## ${emojify(d.title)}`);
  if (d.description) intro.push(emojify(d.description));
  const introText = intro.join('\n').slice(0, 4000) || '\u200b';
  if (brand.thumbnail) {
    container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(introText)).setThumbnailAccessory(new ThumbnailBuilder().setURL(brand.thumbnail)));
  } else {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(introText));
  }
  if (d.fields?.length) {
    for (const field of d.fields.slice(0, 25)) {
      const text = `**${emojify(field.name || 'Field')}**\n${emojify(field.value || '')}`.slice(0, 4000);
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
    }
  }
  if (d.image?.url) container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(d.image.url)));
  const foot = [emojify(brand.footer)];
  foot.push(new Date(brand.timestamp).toUTCString());
  if (foot.length) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${foot.join(' • ')}`.slice(0, 4000)));
  }
  const validRows = sanitizeUniqueCustomIds(flattenComponentRows(rows));
  if (validRows.length) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(false));
    container.addActionRowComponents(...validRows);
  }
  return container;
}

function toComponentsV2(payload, force = false) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const embeds = Array.isArray(payload.embeds) ? payload.embeds : [];
  if (!embeds.length) return payload;

  const { embeds: _e, components: rawRows, content, ephemeral, flags, stickers, poll, ...rest } = payload;
  const rows = flattenComponentRows(rawRows);
  const out = [];
  if (content) out.push(new TextDisplayBuilder().setContent(String(content).slice(0, 4000)));
  embeds.forEach((embed, index) => out.push(embedToContainer(embed, index === embeds.length - 1 ? rows : [])));
  let bits = (typeof flags === 'number' ? flags : 0) | MessageFlags.IsComponentsV2;
  if (ephemeral) bits |= MessageFlags.Ephemeral;
  return { ...rest, components: out, flags: bits };
}

module.exports.featureSetupEmbed = featureSetupEmbed;
module.exports.featureSetupRow = featureSetupRow;
module.exports.buttonRoleEmbed = buttonRoleEmbed;
module.exports.staffApplicationEmbed = staffApplicationEmbed;
module.exports.birthdaySetupEmbed = birthdaySetupEmbed;
module.exports.honeypotSetupEmbed = honeypotSetupEmbed;

module.exports = {
  THEME, OK, WARN, DANGER, emoji, emojify, EMOJI_KEYS, DEFAULT_EMOJIS, emojiRegistryEntries, emojiSnapshotObject, formatEmojiSnapshot,
  base, okEmbed, warnEmbed, errorEmbed, infoEmbed, automodSetupEmbed, automodSetupRows,
  HELP_CATEGORIES, helpHomeEmbed, helpCategoryEmbed, helpSelectRow,
  confirmRow,
  ticketPanelEmbed, ticketPanelRow, ticketControlRow, ticketWelcomeEmbed,
  staffControlsEmbed, staffControlsRow,
  ticketMemberPromptEmbed, ticketMemberSelectRow,
  vmControlEmbed, vmControlRows,
  vmSetupEmbed, vmSetupRow, vmCategoryPromptEmbed, vmCategorySelectRow, vmChannelPromptEmbed, vmChannelSelectRow,
  vmKickPromptEmbed, vmKickSelectRow, vmKickNobodyEmbed, vmKickGoneEmbed, vmKickedEmbed,
  levelUpEmbed, leaderboardEmbed,
  configSummaryEmbed, moduleListEmbed, emojisListEmbed, emojisListRows, embedTextsListEmbed, embedTextsListRows,
  featureSetupEmbed, featureSetupRow, buttonRoleEmbed, buttonRoleSetupRows, reactionRoleSetupEmbed, reactionRoleSetupRows, staffApplicationEmbed, birthdaySetupEmbed, honeypotSetupEmbed, birthdaySetupRow, antiBadwordSetupEmbed, antiBadwordSetupRow, honeypotSetupRow, greetVoiceSetupEmbed, greetVoiceSetupRow,
  autoresponderSetupEmbed, autoresponderSetupRow, autoreactorSetupEmbed, autoreactorSetupRow,
  logSetupEmbed, logSetupRows, ownerLogSetupEmbed, ownerLogSetupRows, ownerJoinLogEmbed, ownerJoinLogRows, ownerGuildControlEmbed, ownerGuildControlRows, ownerInfoChoiceEmbed, ownerInfoChoiceRows, membershipListEmbed, membershipListRows,
  embedBuilderPreviewEmbed, embedBuilderRow, toComponentsV2, embedToContainer,
  SETUP_MODULE_META, setupPanelEmbed, setupPanelRow
};
