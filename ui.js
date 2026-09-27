// ui.js — every embed / button / select-menu builder lives here so the bot has one visual style.
// Note on Discord's API: buttons and select menus can never be rendered physically inside an
// embed's body — Discord only allows components in a row attached below a message's embed(s).
// To make the bot still feel "embed native", every panel here uses ONE embed + ONE compact
// action row directly beneath it (no bare unstyled text, no naked prompts), so visually it reads
// as a single unified panel rather than "an embed, then a separate control area".

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder
} = require('discord.js');

const THEME = 0x2b2d31;
const OK = 0x57f287;
const WARN = 0xfee75c;
const DANGER = 0xed4245;
const BRAND_FOOTER = 'AIO • all-in-one';

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
      '**/setup voicemaster** — join-to-create hub channel & category\n' +
      '**/setup greetmessage** — welcome text channel message'
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
      'Each is toggled with **/setup \\<module\\> enable|disable** plus its own options.'
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
  return base(`🎫 ${guildName} Support`)
    .setDescription('Need help? Click **Open Ticket** below and our team will assist you shortly.');
}
function ticketPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_open').setLabel('Open Ticket').setStyle(ButtonStyle.Primary).setEmoji('🎫')
  );
}
function ticketControlRow(claimed) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_claim').setLabel(claimed ? 'Claimed' : 'Claim').setStyle(ButtonStyle.Secondary).setEmoji('🙋').setDisabled(!!claimed),
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒')
  );
}
function ticketWelcomeEmbed(user) {
  return base('🎫 New Ticket')
    .setDescription(`Hi ${user}, thanks for reaching out. Describe your issue and a staff member will be with you soon.\n\nStaff can **Claim** or **Close** this ticket using the buttons below.`);
}

// ---------------- VOICEMASTER CONTROL PANEL ----------------
function vmControlEmbed(owner) {
  return base('🔊 Voice Channel Controls')
    .setDescription(`Owned by ${owner}. Use the buttons below to manage this room.`);
}
function vmControlRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vm_lock').setLabel('Lock').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
      new ButtonBuilder().setCustomId('vm_unlock').setLabel('Unlock').setStyle(ButtonStyle.Secondary).setEmoji('🔓'),
      new ButtonBuilder().setCustomId('vm_hide').setLabel('Hide').setStyle(ButtonStyle.Secondary).setEmoji('🙈'),
      new ButtonBuilder().setCustomId('vm_unhide').setLabel('Unhide').setStyle(ButtonStyle.Secondary).setEmoji('👁️')
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vm_rename').setLabel('Rename').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
      new ButtonBuilder().setCustomId('vm_limit').setLabel('Set Limit').setStyle(ButtonStyle.Primary).setEmoji('🔢'),
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

module.exports = {
  THEME, OK, WARN, DANGER,
  base, okEmbed, warnEmbed, errorEmbed,
  HELP_CATEGORIES, helpHomeEmbed, helpCategoryEmbed, helpSelectRow,
  confirmRow,
  ticketPanelEmbed, ticketPanelRow, ticketControlRow, ticketWelcomeEmbed,
  vmControlEmbed, vmControlRows,
  levelUpEmbed, leaderboardEmbed,
  configSummaryEmbed, moduleListEmbed
};
