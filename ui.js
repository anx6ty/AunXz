// ui.js — every embed / button / select-menu builder lives here so the bot has one visual style.
// Note on Discord's API: buttons and select menus can never be rendered physically inside an
// embed's body — Discord only allows components in a row attached below a message's embed(s).
// To make the bot still feel "embed native", every panel here uses ONE embed + ONE compact
// action row directly beneath it (no bare unstyled text, no naked prompts), so visually it reads
// as a single unified panel rather than "an embed, then a separate control area".

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, PermissionFlagsBits
} = require('discord.js');
const db = require('./database');

const THEME = 0x2b2d31;
const OK = 0x57f287;
const WARN = 0xfee75c;
const DANGER = 0xed4245;
const BRAND_FOOTER = 'AIO • all-in-one';

// ---------------- EMOJI REGISTRY ----------------
// Every icon used on a button (and a few on embed titles) is looked up through emoji(name)
// instead of being hardcoded, so the owner-only /emojis command can restyle the bot without
// touching code. Falls back to this default the first time / until overridden.
const DEFAULT_EMOJIS = {
  lock: '🔒', unlock: '🔓', hide: '🙈', unhide: '👁️', rename: '✏️', limit: '🔢', kick: '👢', transfer: '🔁',
  ticket_open: '🎫', ticket_close: '🔒', staff_controls: '🛠️', claim: '🙋', unclaim: '↩️',
  add_member: '➕', remove_member: '➖', delete: '🗑️',
  enable: '🟢', disable: '🔴', edit: '⚙️',
  ok: '✅', warn: '⚠️', error: '❌', shield: '🛡️'
};
const EMOJI_KEYS = Object.keys(DEFAULT_EMOJIS);
function emoji(name) {
  return db.getEmojiOverride(name) || DEFAULT_EMOJIS[name] || '❔';
}

function base(title) {
  return new EmbedBuilder()
    .setColor(THEME)
    .setTitle(title)
    .setFooter({ text: BRAND_FOOTER })
    .setTimestamp();
}
function okEmbed(title, desc) { return base(title).setColor(OK).setDescription(desc); }
function warnEmbed(title, desc) { return base(title).setColor(WARN).setDescription(desc); }
function errorEmbed(title, desc) { return base(title).setColor(DANGER).setDescription(desc); }

// ---------------- HELP MENU ----------------
const HELP_CATEGORIES = {
  protection: {
    label: '🛡️ Protection', emoji: '🛡️',
    desc: '**/setup antinuke** — punishment, thresholds, protected owner\n' +
      '**/setup antilink** — delete/warn/mute, domain whitelist, bypass role\n' +
      '**/setup antispam** — message/mention/emoji flood limits\n' +
      '**/setup antiraid** — join-rate lockdown, min account age\n' +
      '**/whitelist add|remove** — exempt trusted staff from antinuke'
  },
  voice: {
    label: '🔊 Voice', emoji: '🔊',
    desc: '**/greetvoice** `<role> <vc> <prompt>` — role-gated VC greeting with TTS\n' +
      '**/setup voicemaster** — join-to-create hub channel & category'
  },
  moderation: {
    label: '🔨 Moderation', emoji: '🔨',
    desc: '**/ban /kick /timeout /untimeout** — with mod-log embeds\n' +
      '**/warn /warnings /clearwarns** — warning system\n' +
      '**/purge** — bulk delete with filters\n' +
      '**/lock /unlock /slowmode** — channel controls\n' +
      '**/nickname /role add|remove**'
  },
  leveling: {
    label: '📈 Leveling', emoji: '📈',
    desc: '**/setup leveling** — xp rate, cooldown, level-up message, role rewards\n' +
      '**/rank** — view a level card\n' +
      '**/leaderboard** — top XP in the server'
  },
  tickets: {
    label: '🎫 Tickets', emoji: '🎫',
    desc: '**/setup tickets** — category, support role, log channel\n' +
      '**/ticketpanel** — post the open-a-ticket button panel'
  },
  logging: {
    label: '📜 Logging', emoji: '📜',
    desc: '**/setup logs** — route mod/message/member/voice/antinuke/server logs to channels'
  },
  extra: {
    label: '⚙️ 40+ more setups', emoji: '⚙️',
    desc: 'Use **/setup list** to see every configurable module: welcome, leave, boost, ' +
      'autorole, sticky roles, reaction roles, starboard, invite tracker, birthdays, suggestions, ' +
      'polls, automod word filter, caps filter, invite filter, nsfw filter, snipe, afk, and more. ' +
      'Each is toggled with **/setup \\<module\\> enable|disable** plus its own options.\n' +
      '**/setup greetmessage** — text-channel welcome message on join (not voice-related)'
  },
  owner: {
    label: '👑 Owner-only', emoji: '👑',
    desc: '**/maintenance** — toggle maintenance mode\n' +
      '**/blacklist add|remove** — block a user from all commands\n' +
      '**/eval** — run raw JS (bot owner only, use with care)\n' +
      '**/broadcast** — DM every server owner'
  }
};

function helpHomeEmbed(client) {
  return base('📖 Help Menu')
    .setDescription(
      `Pick a category from the menu below.\n\n` +
      Object.values(HELP_CATEGORIES).map(c => `${c.emoji} **${c.label.split(' ').slice(1).join(' ')}**`).join('\n')
    )
    .setThumbnail(client.user.displayAvatarURL());
}
function helpCategoryEmbed(key) {
  const cat = HELP_CATEGORIES[key];
  return base(cat.label).setDescription(cat.desc);
}
function helpSelectRow() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('help_select')
    .setPlaceholder('Choose a category…')
    .addOptions(Object.entries(HELP_CATEGORIES).map(([value, c]) => ({
      label: c.label.replace(/^\S+\s/, ''), value, emoji: c.emoji
    })));
  return new ActionRowBuilder().addComponents(menu);
}

// ---------------- GENERIC CONFIRM / TOGGLE BUTTONS ----------------
function confirmRow(idBase) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${idBase}_confirm`).setLabel('Confirm').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId(`${idBase}_cancel`).setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji('✖️')
  );
}

// ---------------- TICKET PANEL ----------------
function ticketPanelEmbed(guildName) {
  return base(`${emoji('ticket_open')} ${guildName} Support`)
    .setDescription('Need help? Click **Open Ticket** below and our team will assist you shortly.');
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
  return base('🔊 Voice Channel Controls')
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
        .setStyle(locked ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji(locked ? '🔓' : '🔒'),
      new ButtonBuilder().setCustomId('vm_togglehide').setLabel(hidden ? 'Unhide' : 'Hide')
        .setStyle(hidden ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji(hidden ? '👁️' : '🙈'),
      new ButtonBuilder().setCustomId('vm_rename').setLabel('Rename').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
      new ButtonBuilder().setCustomId('vm_limit').setLabel('Set Limit').setStyle(ButtonStyle.Primary).setEmoji('🔢')
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vm_kick').setLabel('Kick').setStyle(ButtonStyle.Danger).setEmoji('👢'),
      new ButtonBuilder().setCustomId('vm_transfer').setLabel('Transfer').setStyle(ButtonStyle.Danger).setEmoji('🔁')
    )
  ];
}

// ---------------- LEVELING ----------------
function levelUpEmbed(text) {
  return base('📈 Level Up!').setColor(OK).setDescription(text);
}
function leaderboardEmbed(guildName, rows, startRank = 1) {
  const desc = rows.length
    ? rows.map((r, i) => `**#${startRank + i}** <@${r.userId}> — Level ${r.level} (${r.xp} XP)`).join('\n')
    : 'No XP recorded yet.';
  return base(`📈 ${guildName} Leaderboard`).setDescription(desc);
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
  return base(`⚙️ ${moduleName} Settings`).setDescription(lines.join('\n') || 'No settings.');
}

function moduleListEmbed(modules) {
  return base('⚙️ All Setup Modules')
    .setDescription(modules.map(m => `• \`${m}\``).join('\n'))
    .setFooter({ text: `${BRAND_FOOTER} • Use /setup <module> to configure` });
}

// ---------------- INTERACTIVE SETUP PANEL ----------------
// Every dedicated /setup subcommand replies with one of these instead of a static summary:
// a single embed showing current settings + a row of buttons to toggle it on/off or open an
// edit modal — fully customizable, nothing here is gated or locked behind anything.
const SETUP_MODULE_META = {
  antinuke: { emoji: '🛡️', title: 'Antinuke', cfgKey: 'antinuke' },
  antilink: { emoji: '🔗', title: 'Antilink', cfgKey: 'antilink' },
  antispam: { emoji: '🚫', title: 'Antispam', cfgKey: 'antispam' },
  antiraid: { emoji: '🚨', title: 'Antiraid', cfgKey: 'antiraid' },
  voicemaster: { emoji: '🔊', title: 'Voicemaster', cfgKey: 'voicemaster' },
  greetmessage: { emoji: '👋', title: 'Greet Message', cfgKey: 'greetmessage' },
  leveling: { emoji: '📈', title: 'Leveling', cfgKey: 'leveling' },
  tickets: { emoji: '🎫', title: 'Tickets', cfgKey: 'ticket' }
};

function setupPanelEmbed(sub, cfg) {
  const meta = SETUP_MODULE_META[sub];
  const modcfg = cfg[meta.cfgKey];
  const status = modcfg.enabled ? '🟢 Enabled' : '🔴 Disabled';
  const lines = Object.entries(modcfg).filter(([k]) => k !== 'enabled').map(([k, v]) => {
    let val = v;
    if (val === null || val === undefined) val = '—';
    if (Array.isArray(val)) val = val.length ? val.join(', ') : '—';
    if (typeof val === 'object') val = '`' + JSON.stringify(val) + '`';
    return `**${k}:** ${val}`;
  });
  return base(`${meta.emoji} ${meta.title} — Setup`)
    .setDescription(`**Status:** ${status}\n\n${lines.join('\n')}\n\n` +
      'Every option below is fully unlocked for you to customize — use the buttons to toggle it or edit its settings.');
}

function setupPanelRow(sub, cfg) {
  const meta = SETUP_MODULE_META[sub];
  const enabled = cfg[meta.cfgKey].enabled;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup_toggle:${sub}`).setLabel(enabled ? 'Disable' : 'Enable')
      .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(enabled ? '🔴' : '🟢'),
    new ButtonBuilder().setCustomId(`setup_edit:${sub}`).setLabel('Edit Settings').setStyle(ButtonStyle.Primary).setEmoji('⚙️')
  );
}

// ---------------- VOICEMASTER: KICK-FROM-VC SELECTION ----------------
function vmKickPromptEmbed() {
  return base('👢 Kick From Voice Channel')
    .setDescription('Pick the member you\'d like to disconnect from your channel below. 🔒 Only you can see and use this menu.');
}
function vmKickSelectRow(members) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('vm_kick_pick')
    .setPlaceholder('Choose a member to disconnect…')
    .addOptions(members.slice(0, 25).map(m => ({ label: m.displayName.slice(0, 100), value: m.id, emoji: '🔇' })));
  return new ActionRowBuilder().addComponents(menu);
}
function vmKickNobodyEmbed() {
  return warnEmbed('🙅 Nobody To Kick', 'There\'s no one else in your voice channel right now.');
}
function vmKickGoneEmbed(userId) {
  return warnEmbed('😅 Already Gone', `Looks like <@${userId}> isn't in the voice channel anymore — nothing to do here! 🎈`);
}
function vmKickedEmbed(tag) {
  return okEmbed('👢 Member Removed', `**${tag}** has been disconnected from the voice channel. 👋`);
}

module.exports = {
  THEME, OK, WARN, DANGER,
  base, okEmbed, warnEmbed, errorEmbed,
  HELP_CATEGORIES, helpHomeEmbed, helpCategoryEmbed, helpSelectRow,
  confirmRow,
  ticketPanelEmbed, ticketPanelRow, ticketControlRow, ticketWelcomeEmbed,
  vmControlEmbed, vmControlRows,
  vmKickPromptEmbed, vmKickSelectRow, vmKickNobodyEmbed, vmKickGoneEmbed, vmKickedEmbed,
  levelUpEmbed, leaderboardEmbed,
  configSummaryEmbed, moduleListEmbed,
  SETUP_MODULE_META, setupPanelEmbed, setupPanelRow
};
