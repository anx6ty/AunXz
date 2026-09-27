// ui.js — every embed / button / select-menu builder lives here so the bot has one visual style.
// Note on Discord's API: buttons and select menus can never be rendered physically inside an
// embed's body — Discord only allows components in a row attached below a message's embed(s).
// To make the bot still feel "embed native", every panel here uses ONE embed + ONE compact
// action row directly beneath it (no bare unstyled text, no naked prompts), so visually it reads
// as a single unified panel rather than "an embed, then a separate control area".

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, UserSelectMenuBuilder,
  ChannelType, PermissionFlagsBits
} = require('discord.js');
const db = require('./database');

const THEME = 0x2b2d31;
const OK = 0x57f287;
const WARN = 0xfee75c;
const DANGER = 0xed4245;
const BRAND_FOOTER = 'AIO • all-in-one';

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


// ---------------- DISCORD COMPONENTS V2 ----------------
// Discord Components V2 messages cannot contain legacy `embeds`/`content`; the visual panel
// is built from Container + Text Display + Media Gallery + Action Row components instead.
// This helper is intentionally used at the final send/edit boundary so existing command code
// can keep building normal EmbedBuilder instances while every embed that has controls becomes
// one unified V2 container with the buttons/selects INSIDE that container.
const COMPONENTS_V2_FLAG = 32768;
const EPHEMERAL_FLAG = 64;

function jsonOf(value) {
  if (!value) return value;
  if (typeof value.toJSON === 'function') return value.toJSON();
  return value;
}

function embedToV2Parts(embedLike) {
  const e = jsonOf(embedLike) || {};
  const lines = [];
  if (e.author?.name) lines.push(`*${e.author.name}*`);
  if (e.title) lines.push(e.url ? `## [${e.title}](${e.url})` : `## ${e.title}`);
  if (e.description) lines.push(e.description);
  for (const field of (e.fields || [])) {
    if (!field) continue;
    lines.push(`**${field.name || ''}**\n${field.value || ''}`);
  }
  if (e.footer?.text) lines.push(`-# ${e.footer.text}`);
  if (e.timestamp) lines.push(`-# ${new Date(e.timestamp).toLocaleString()}`);
  const content = lines.join('\n\n').trim() || '\u200b';
  const text = { type: 10, content: content.slice(0, 4000) };
  return {
    text,
    thumbnail: e.thumbnail?.url ? { type: 11, media: { url: e.thumbnail.url }, description: e.thumbnail.description || undefined } : null,
    image: e.image?.url ? { type: 12, items: [{ media: { url: e.image.url }, description: e.image.description || undefined }] } : null,
    color: Number.isInteger(e.color) ? e.color : THEME
  };
}

function componentsV2Payload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const embeds = Array.isArray(payload.embeds) ? payload.embeds : [];
  const components = Array.isArray(payload.components) ? payload.components : [];
  if (!components.length) return payload;

  const normalizedComponents = components.map(jsonOf);
  let flags = Number(payload.flags) || 0;
  flags |= COMPONENTS_V2_FLAG;
  if (payload.ephemeral) flags |= EPHEMERAL_FLAG;

  // Already a V2 container: just keep it and enforce the V2 flag.
  if (normalizedComponents.length === 1 && normalizedComponents[0]?.type === 17) {
    const next = { ...payload, components: normalizedComponents, flags };
    delete next.embeds;
    delete next.content;
    delete next.ephemeral;
    return next;
  }

  const container = {
    type: 17,
    accent_color: embeds.length ? embedToV2Parts(embeds[0]).color : THEME,
    components: []
  };

  if (embeds.length) {
    const parts = embeds.map(embedToV2Parts);
    for (const part of parts) {
      if (part.thumbnail) {
        container.components.push({ type: 9, components: [part.text], accessory: part.thumbnail });
      } else {
        container.components.push(part.text);
      }
      if (part.image) container.components.push(part.image);
    }
  } else if (payload.content) {
    container.components.push({ type: 10, content: String(payload.content).slice(0, 4000) });
  }

  // Put every existing action row (buttons/selects) INSIDE the same container.
  for (const component of normalizedComponents) {
    if (component?.type === 1) container.components.push(component);
  }

  // Container limit is 10 child components. Preserve controls whenever possible.
  if (container.components.length > 10) {
    const controls = container.components.filter(c => c.type === 1);
    const contentParts = container.components.filter(c => c.type !== 1);
    const room = Math.max(0, 10 - controls.length);
    container.components = [...contentParts.slice(0, room), ...controls].slice(0, 10);
  }

  const next = { ...payload, components: [container], flags };
  delete next.embeds;
  delete next.content;
  delete next.ephemeral;
  return next;
}

function patchInteractionV2(interaction) {
  if (!interaction || interaction.__componentsV2Patched) return interaction;
  interaction.__componentsV2Patched = true;
  for (const method of ['reply', 'update', 'editReply', 'followUp']) {
    if (typeof interaction[method] !== 'function') continue;
    const original = interaction[method].bind(interaction);
    interaction[method] = payload => original(componentsV2Payload(payload));
  }
  return interaction;
}

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
  const meta = SETUP_MODULE_META[sub];
  const enabled = cfg[meta.cfgKey].enabled;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup_toggle:${sub}`).setLabel(enabled ? 'Disable' : 'Enable')
      .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(enabled ? emoji('disabled') : emoji('enabled')),
    new ButtonBuilder().setCustomId(`setup_edit:${sub}`).setLabel('Edit Settings').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings'))
  );
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
function buttonRoleEmbed(cfg) { return featureSetupEmbed('Button Roles', 'Choose a role button below. Each button can add, remove, or toggle a role.', [
  {name:'Panel',value:`${cfg.title || 'Choose your roles'}
${cfg.description || ''}`,inline:false},
  {name:'Buttons',value:String((cfg.buttons||[]).length),inline:true}, {name:'Style',value:cfg.embedType||'embed',inline:true}
]); }
function staffApplicationEmbed(cfg) { return featureSetupEmbed('Staff Applications', 'Members press Apply, receive a DM, choose Ready, then answer your questions one by one.', [
  {name:'Questions',value:String((cfg.questions||[]).length),inline:true}, {name:'Application log',value:cfg.logChannelId ? `<#${cfg.logChannelId}>`:'Not set',inline:true}
]); }
function birthdaySetupEmbed(cfg) { return featureSetupEmbed('Birthday System', 'Members press the birthday button and enter a date such as 8-8. The bot posts wishes in the configured wish channel.', [
  {name:'Panel',value:cfg.panelChannelId ? `<#${cfg.panelChannelId}>`:'Not set',inline:true}, {name:'Wish channel',value:cfg.wishChannelId ? `<#${cfg.wishChannelId}>`:'Not set',inline:true}
]); }
function honeypotSetupEmbed(cfg) { return featureSetupEmbed('Honeypot', 'This channel is a no-message zone. A message or image sent there triggers your selected action.', [
  {name:'Channel',value:cfg.channelId ? `<#${cfg.channelId}>`:'Not set',inline:true}, {name:'Action',value:cfg.action||'kick',inline:true}, {name:'Cleanup',value:cfg.cleanupWindow||'none',inline:true}
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
function honeypotSetupRow(cfg) { return [
  new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('honeypot_cfg:channel').setPlaceholder('Select honeypot channel').setChannelTypes(ChannelType.GuildText)),
  new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('honeypot_cfg:action').setPlaceholder(`Action: ${cfg.action||'kick'}`).addOptions({label:'Kick',value:'kick',emoji:emoji('kick')},{label:'Ban',value:'ban',emoji:emoji('shield')},{label:'Timeout',value:'timeout',emoji:emoji('mute')},{label:'Delete only',value:'delete',emoji:emoji('delete')})),
  new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('honeypot_cfg:cleanup').setPlaceholder(`Cleanup: ${cfg.cleanupWindow||'none'}`).addOptions({label:'No cleanup',value:'none'},{label:'Last 10 minutes',value:'10m'},{label:'Last 1 hour',value:'1h'},{label:'Last 24 hours',value:'24h'})),
  new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('honeypot_cfg:invite').setLabel(cfg.createInvite?'Invite DM: ON':'Invite DM: OFF').setStyle(cfg.createInvite?ButtonStyle.Success:ButtonStyle.Secondary).setEmoji(emoji('link')), new ButtonBuilder().setCustomId('honeypot_cfg:dm').setLabel('Set Kick DM').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')))
]; }
function greetVoiceSetupEmbed(cfg) { return featureSetupEmbed('Greet Voice', 'New members receive the gate role, join the selected voice channel, hear the TTS greeting, then are disconnected and released.', [
  {name:'Role',value:cfg.roleId?`<@&${cfg.roleId}>`:'Not set',inline:true}, {name:'Voice',value:cfg.vcId?`<#${cfg.vcId}>`:'Not set',inline:true}, {name:'Prompt',value:cfg.ttsPrompt||'Not set',inline:false}
]); }
function greetVoiceSetupRow(cfg) { return [
  new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('greetvoice_cfg:voice').setPlaceholder('Select greeting voice channel').setChannelTypes(ChannelType.GuildVoice)),
  new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('greetvoice_cfg:role').setLabel('Select Gate Role').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')), new ButtonBuilder().setCustomId('greetvoice_cfg:prompt').setLabel('Set TTS Prompt').setStyle(ButtonStyle.Primary).setEmoji(emoji('voice')), new ButtonBuilder().setCustomId('greetvoice_cfg:test').setLabel('Test Voice').setStyle(ButtonStyle.Success).setEmoji(emoji('success')))
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

// ---------------- EMBED BUILDER ----------------
function embedBuilderPreviewEmbed(draft) {
  const e = base(draft.title || 'Untitled Embed');
  e.setDescription(draft.description || '*No description set — press Edit Text.*');
  if (draft.color) { const n = parseInt(String(draft.color).replace('#', ''), 16); if (!Number.isNaN(n)) e.setColor(n); }
  if (draft.imageUrl) e.setImage(draft.imageUrl);
  if (draft.thumbnailUrl) e.setThumbnail(draft.thumbnailUrl);
  if (draft.footer) e.setFooter({ text: draft.footer.slice(0, 200) });
  return e;
}
function embedBuilderRow(draft) {
  const buttons = draft.buttons || [];
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('embedbuilder:text').setLabel('Edit Text').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')),
    new ButtonBuilder().setCustomId('embedbuilder:image').setLabel('Edit Images').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')),
    new ButtonBuilder().setCustomId('embedbuilder:addbutton').setLabel('Add Button').setStyle(ButtonStyle.Secondary).setEmoji(emoji('add')),
    new ButtonBuilder().setCustomId('embedbuilder:post').setLabel('Post').setStyle(ButtonStyle.Success).setEmoji(emoji('success'))
  )];
  if (buttons.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('embedbuilder:removebutton').setPlaceholder(`Remove a button… (${buttons.length} added)`)
        .addOptions(buttons.slice(0, 25).map((b, i) => ({ label: (b.label || 'Button').slice(0, 90), value: String(i), emoji: emoji('remove') })))
    ));
  }
  return rows;
}

module.exports.featureSetupEmbed = featureSetupEmbed;
module.exports.featureSetupRow = featureSetupRow;
module.exports.buttonRoleEmbed = buttonRoleEmbed;
module.exports.staffApplicationEmbed = staffApplicationEmbed;
module.exports.birthdaySetupEmbed = birthdaySetupEmbed;
module.exports.honeypotSetupEmbed = honeypotSetupEmbed;

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
  featureSetupEmbed, featureSetupRow, buttonRoleEmbed, staffApplicationEmbed, birthdaySetupEmbed, honeypotSetupEmbed, birthdaySetupRow, antiBadwordSetupEmbed, antiBadwordSetupRow, honeypotSetupRow, greetVoiceSetupEmbed, greetVoiceSetupRow,
  autoresponderSetupEmbed, autoresponderSetupRow, autoreactorSetupEmbed, autoreactorSetupRow,
  embedBuilderPreviewEmbed, embedBuilderRow,
  SETUP_MODULE_META, setupPanelEmbed, setupPanelRow
};
