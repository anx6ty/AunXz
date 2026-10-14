// AunXz/ui.js — theme, Components V2, panels, ticket UI, emoji registry.
'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder,
  ChannelType, PermissionFlagsBits,
  ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder,
  SeparatorBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags
} = require('discord.js');
const db = require('./database');

// =============================================================================
// THEME — #8B5CF6 primary
// =============================================================================
const PRIMARY = 0x8B5CF6;   // purple accent for all normal UI
const OK = 0x22c55e;
const WARN = 0xf59e0b;
const DANGER = 0xef4444;
const INFO = PRIMARY;
const BRAND = process.env.BRAND_FOOTER || 'AunXz';
const V2_OK = typeof MessageFlags?.IsComponentsV2 === 'number' && typeof ContainerBuilder === 'function';

// =============================================================================
// EMOJI REGISTRY — every emoji the bot sends goes through ui.emoji('key')
// =============================================================================
const DEFAULT_EMOJIS = {
  // status / feedback
  success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️',
  enabled: '🟢', disabled: '🔴', loading: '⏳', question: '❔',
  // navigation / UI
  back: '◀️', next: '▶️', prev: '◀️', refresh: '🔄',
  edit: '✏️', save: '💾', close: '✖️', search: '🔍',
  // security
  shield: '🛡️', lock: '🔒', unlock: '🔓', link: '🔗',
  spam: '🚫', raid: '🚨', honeypot: '🍯', webhook: '🪝',
  security: '🔐', bot: '🤖', alt: '👤',
  // moderation
  ban: '🔨', kick: '👢', mute: '🔇', timeout: '⏱️',
  purge: '🧹', moderation: '🔨', warn: '⚠️',
  // community
  ticket: '🎫', giveaway: '🎉', birthday: '🎂', level: '📈',
  leaderboard: '🏆', rank: '🏅', claim: '🙋', chat: '💬',
  poll: '📊', suggestion: '💡', starboard: '⭐',
  // channels
  voice: '🔊', category: '📁', text: '💬', announcement: '📢',
  forum: '🧵', thread: '🧵', stage: '🎙️',
  // roles / panels
  roles: '🎭', panel: '🎨', button: '🔘', reaction: '➕',
  // applications
  applications: '📝', accept: '✅', deny: '❌', submit: '📤',
  // AI
  ai: '🤖', template: '🧩', generate: '✨',
  // owner
  owner: '👑', stats: '📊', database: '🗄️', errors: '🐞',
  maintenance: '🛠️', blacklist: '🚫', audit: '📋',
  export: '📦', import: '📥', backup: '📦', restore: '♻️',
  // members
  member_join: '📥', member_leave: '📤', member: '🤝', nick: '📛',
  // automation
  autoresponder: '💬', autoreactor: '😀', sticky: '📌',
  automation: '🛠️', trigger: '⚡', keyword: '🔑',
  // welcome / leave
  wave: '👋', leave: '🚪', welcome: '🎉', boost: '🚀', greet: '💐',
  // info
  help: '📖', list: '📋', settings: '⚙️', logs: '📜',
  tools: '🛠️', info_page: '📄', health: '🩺', wizard: '🧭',
  invites: '📨', ping: '🏓',
  // generic actions
  delete: '🗑️', add: '➕', remove: '➖', undo: '↩️',
  transcript: '📄', transfer: '🔁', limit: '🔢',
  hidden: '🙈', visible: '👁️', rewards: '🎁', post: '📤',
  external: '🌐', file: '📎', image: '🖼️', colors: '🎨',
  emoji: '😀', user: '👤', bot_user: '🤖',
  clock: '🕒', calendar: '📅', location: '📍', money: '💰', coin: '🪙',
  // panels specific
  welcome_panel: '👋', leave_panel: '🚪', greet_panel: '👋',
  greetvoice_panel: '🔊', leveling_panel: '📈', ticket_panel: '🎫',
  logging_panel: '📜', automod_panel: '🛡️', badword_panel: '🚫',
  honeypot_panel: '🍯', autoresponder_panel: '💬', autoreactor_panel: '😀',
  applications_panel: '📝', birthday_panel: '🎂', voicemaster_panel: '🔊',
  role_panel: '🎭', antiwebhook_panel: '🪝', antibot_panel: '🤖',
  antialt_panel: '👤', antinuke_panel: '🛡️', antilink_panel: '🔗',
  antispam_panel: '🚫', antiraid_panel: '🚨'
};

function emoji(key, fallback = '❔') {
  return db.getEmojiOverride(key) || DEFAULT_EMOJIS[key] || fallback;
}
function emojify(value) {
  if (typeof value !== 'string' || !value) return value;
  let out = value;
  const entries = Object.entries(DEFAULT_EMOJIS).sort((a, b) => b[1].length - a[1].length);
  for (const [key, def] of entries) {
    const replacement = db.getEmojiOverride(key) || def;
    if (replacement !== def) out = out.split(def).join(replacement);
  }
  return out;
}
function emojiKeys() { return Object.keys(DEFAULT_EMOJIS); }

// =============================================================================
// COMPONENTS V2 BUILDER
// =============================================================================
function buildV2({ title, description, fields, footer, thumbnail, image, components } = {}) {
  if (!V2_OK) {
    const e = new EmbedBuilder().setColor(PRIMARY).setTimestamp().setFooter({ text: footer || BRAND });
    if (title) e.setTitle(String(title).slice(0, 256));
    if (description) e.setDescription(String(description).slice(0, 4000));
    if (fields?.length) e.addFields(fields.slice(0, 25));
    if (thumbnail) e.setThumbnail(thumbnail);
    if (image) e.setImage(image);
    return { embeds: [e], components: (components || []).slice(0, 5) };
  }

  const c = new ContainerBuilder().setAccentColor(PRIMARY);

  const lines = [];
  if (title) lines.push(`## ${emojify(String(title)).slice(0, 200)}`);
  if (description) lines.push(String(description).slice(0, 3000));
  const top = lines.length ? lines.join('\n') : '\u200b';

  if (thumbnail) {
    c.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(top))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnail))
    );
  } else {
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(top));
  }

  for (const f of (fields || []).slice(0, 20)) {
    const name = emojify(String(f.name || '\u200b')).slice(0, 250);
    const value = emojify(String(f.value ?? '')).slice(0, 1000) || '\u200b';
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${name}**\n${value}`));
  }

  if (image) {
    c.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(image))
    );
  }

  c.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(1));
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${emojify(footer || BRAND)}`.slice(0, 4000)));

  for (const row of (components || []).slice(0, 5)) c.addActionRowComponents(row);

  return { components: [c], flags: MessageFlags.IsComponentsV2 };
}

const v2Info = (title, description, opts = {}) => buildV2({ title, description, ...opts });
const v2Ok   = (title, description, opts = {}) => buildV2({ title, description, ...opts });
const v2Err  = (title, description, opts = {}) => buildV2({ title, description, ...opts });
const v2Warn = (title, description, opts = {}) => buildV2({ title, description, ...opts });

// =============================================================================
// CLASSIC EMBEDS (for compact replies)
// =============================================================================
function embed(title, description, opts = {}) {
  const e = new EmbedBuilder()
    .setColor(opts.color ?? PRIMARY)
    .setTimestamp()
    .setFooter({ text: opts.footer || BRAND });
  if (title) e.setTitle(emojify(String(title)).slice(0, 256));
  if (description) e.setDescription(emojify(String(description)).slice(0, 4000));
  if (opts.fields?.length) e.addFields(opts.fields.slice(0, 25).map(f => ({
    name: emojify(String(f.name)).slice(0, 256),
    value: emojify(String(f.value)).slice(0, 1024),
    inline: !!f.inline
  })));
  if (opts.thumbnail) e.setThumbnail(opts.thumbnail);
  if (opts.image) e.setImage(opts.image);
  return e;
}
const okEmbed   = (t, d) => embed(t, d).setColor(OK);
const errEmbed  = (t, d) => embed(t, d).setColor(DANGER);
const warnEmbed = (t, d) => embed(t, d).setColor(WARN);
const infoEmbed = (t, d) => embed(t, d);

// =============================================================================
// BUTTONS / ROWS
// =============================================================================
function btn(id, label, style = ButtonStyle.Secondary, opts = {}) {
  const b = new ButtonBuilder().setCustomId(id).setLabel(emojify(String(label)).slice(0, 80)).setStyle(style);
  if (opts.emoji) b.setEmoji(opts.emoji);
  if (opts.disabled) b.setDisabled(true);
  if (opts.url) b.setStyle(ButtonStyle.Link).setURL(opts.url);
  return b;
}
function row(...components) { return new ActionRowBuilder().addComponents(...components); }

// Standardised toggle — green when enabled, red when disabled, emoji reflects state.
function toggleButton(id, on, { onLabel = 'Enabled', offLabel = 'Disabled' } = {}) {
  return btn(id, on ? onLabel : offLabel, on ? ButtonStyle.Success : ButtonStyle.Danger, {
    emoji: on ? emoji('enabled') : emoji('disabled')
  });
}
function confirmRow(prefix, { yes = 'Confirm', no = 'Cancel' } = {}) {
  return row(
    btn(`${prefix}:yes`, yes, ButtonStyle.Danger, { emoji: emoji('success') }),
    btn(`${prefix}:no`, no, ButtonStyle.Secondary, { emoji: emoji('error') })
  );
}

// =============================================================================
// HELP MENU
// =============================================================================
const HELP_CATEGORIES = {
  protection: {
    name: 'Protection', key: 'shield',
    desc:
      `**/antinuke setup** — punishment, thresholds, protected owner\n` +
      `**/antilink setup** — delete/warn/mute, domain whitelist, bypass role\n` +
      `**/antispam setup** — message/mention/emoji flood limits\n` +
      `**/antiraid setup** — join-rate lockdown, min account age\n` +
      `**/antiwebhook setup** — webhook action, bypass role, security log\n` +
      `**/antibot setup** — bot action, bypass role, security log\n` +
      `**/antialt setup** — minimum account age, action\n` +
      `**/antibadwordsetup** — word-boundary profanity filter\n` +
      `**/whitelist add|remove|list** — Anti-Nuke exemptions`
  },
  voice: {
    name: 'Voice', key: 'voice',
    desc:
      `**/voicemaster setup** — join-to-create hub channel & category\n` +
      `**/greetvoice setup** — VC greeting with TTS or uploaded audio`
  },
  moderation: {
    name: 'Moderation', key: 'moderation',
    desc:
      `**/mod ban|unban|kick|timeout|untimeout** — with mod-log embeds\n` +
      `**/mod warn|warnings|clearwarnings** — warning system\n` +
      `**/mod purge** — bulk delete with filters\n` +
      `**/mod history** — case records for a user`
  },
  leveling: {
    name: 'Leveling', key: 'level',
    desc:
      `**/leveling setup** — xp rate, cooldown, level-up message, role rewards\n` +
      `**/rank** — level card\n` +
      `**/leaderboard** — top 25 by XP\n` +
      `**/xp add|remove|set|reset** — admin XP tools`
  },
  tickets: {
    name: 'Tickets', key: 'ticket',
    desc:
      `**/tickets setup** — category, support role, log channel, panel types\n` +
      `**/ticketpanel** — publish the panel\n` +
      `**/ticketconfig** — customize panel appearance\n` +
      `**Each ticket type creates its own category** — \`staff\`, \`reports\`, \`tickets\`…\n` +
      `Ticket channels are named \`<panel>-<username>\`.`
  },
  logging: {
    name: 'Logging', key: 'logs',
    desc:
      `**/logsetup** — configure logging per category\n` +
      `Categories: \`default\` \`message\` \`member\` \`mod\` \`voice\` \`security\` \`ticket\` \`server\` \`system\``
  },
  automation: {
    name: 'Automation & Content', key: 'tools',
    desc:
      `**/autoresponder setup** — auto-reply on keyword match\n` +
      `**/autoreactor setup** — auto-react on keyword match\n` +
      `**/embedbuilder** — build a custom embed and post it\n` +
      `**/embed create|send|list|delete** — saved embeds\n` +
      `**/stickymessage set|remove|toggle|list** — pinned embeds\n` +
      `**/honeypot setup** — trap channel\n` +
      `**/buttonrolesetup** / **/reactionrolesetup** — self-service role panels\n` +
      `**/giveaway start|end|reroll|list** — prize draws\n` +
      `**/birthdaysetup** — birthday panel + wishes`
  },
  applications: {
    name: 'Applications', key: 'applications',
    desc:
      `**/staffapplicationssetup** — configure the application workflow\n` +
      `Applicants press **Apply**, answer by DM or pop-up form.`
  },
  ai: {
    name: 'AI', key: 'ai',
    desc:
      `**/ask <question>** — ask the Groq-powered assistant\n` +
      `**/templategen** — generate a Discord server structure with AI`
  },
  settings: {
    name: 'Settings', key: 'settings',
    desc:
      `**/prefix** — server command prefix\n` +
      `**/welcome setup** / **/leave setup** — welcome & leave\n` +
      `**/greetmessage setup** — welcome card with image/title\n` +
      `**/autorole target role** — auto-role for new members\n` +
      `**/emojis list|set|reset** — emoji registry\n` +
      `**/setup panel** / **wizard** / **health** / **backup** / **restore**`
  },
  info: {
    name: 'Info & Utility', key: 'info_page',
    desc:
      `**/help** — this menu\n` +
      `**/ping** **/botinfo** **/serverinfo** **/userinfo** **/avatar**\n` +
      `**/snipe [channel]** — recent deleted/edited messages\n` +
      `**/invites [user]** — invite stats`
  }
};

function helpMenuEmbed(client) {
  const lines = ['Pick a category from the menu below.'];
  for (const [, c] of Object.entries(HELP_CATEGORIES)) lines.push(`${emoji(c.key)} ${c.name}`);
  return buildV2({
    title: `${emoji('help')} Help Menu`,
    description: lines.join('\n'),
    footer: `AIO • all-in-one • <t:${Math.floor(Date.now() / 1000)}:f>`,
    components: [helpSelectRow()]
  });
}
function helpSelectRow() {
  return row(new StringSelectMenuBuilder()
    .setCustomId('help_select')
    .setPlaceholder('Choose a category…')
    .addOptions(Object.entries(HELP_CATEGORIES).map(([value, c]) => ({ label: c.name, value, emoji: emoji(c.key) }))));
}

// =============================================================================
// SETUP MODULES
// =============================================================================
const SETUP_MODULES = [
  { key: 'automod',       label: 'AutoMod',         cfgKey: 'automod',           key2: 'automod_panel',      desc: 'Caps, invites, bad words' },
  { key: 'antinuke',      label: 'Anti-Nuke',       cfgKey: 'antinuke',          key2: 'antinuke_panel',     desc: 'Mass-action protection' },
  { key: 'antilink',      label: 'Anti-Link',       cfgKey: 'antilink',          key2: 'antilink_panel',     desc: 'Link filter with bypasses' },
  { key: 'antispam',      label: 'Anti-Spam',       cfgKey: 'antispam',          key2: 'antispam_panel',     desc: 'Message flood limits' },
  { key: 'antiraid',      label: 'Anti-Raid',       cfgKey: 'antiraid',          key2: 'antiraid_panel',     desc: 'Join-rate lockdown' },
  { key: 'antiwebhook',   label: 'Anti-Webhook',    cfgKey: 'antiwebhook',       key2: 'antiwebhook_panel',  desc: 'Block unauthorized webhooks' },
  { key: 'antibot',       label: 'Anti-Bot',        cfgKey: 'antibot',           key2: 'antibot_panel',      desc: 'Control bot invites' },
  { key: 'antialt',       label: 'Anti-Alt',        cfgKey: 'antialt',           key2: 'antialt_panel',      desc: 'Block young accounts' },
  { key: 'antibadword',   label: 'Anti-Bad-Word',   cfgKey: 'antibadword',       key2: 'badword_panel',      desc: 'Word-boundary profanity filter' },
  { key: 'logging',       label: 'Logging',         cfgKey: 'logs',              key2: 'logging_panel',      desc: 'Per-category destinations' },
  { key: 'welcome',       label: 'Welcome',         cfgKey: 'welcome',           key2: 'welcome_panel',      desc: 'Join messages' },
  { key: 'leave',         label: 'Leave',           cfgKey: 'leave',             key2: 'leave_panel',        desc: 'Leave messages' },
  { key: 'greetmessage',  label: 'Greet Message',   cfgKey: 'greetmessage',      key2: 'greet_panel',        desc: 'Welcome card with image' },
  { key: 'greetvoice',    label: 'Greet Voice',     cfgKey: 'greetvoice',        key2: 'greetvoice_panel',   desc: 'VC greeting with TTS' },
  { key: 'tickets',       label: 'Tickets',         cfgKey: 'ticket',            key2: 'ticket_panel',       desc: 'Support ticket system' },
  { key: 'leveling',      label: 'Leveling',        cfgKey: 'leveling',          key2: 'leveling_panel',     desc: 'XP and role rewards' },
  { key: 'voicemaster',   label: 'VoiceMaster',     cfgKey: 'voicemaster',       key2: 'voicemaster_panel',  desc: 'Join-to-create voice' },
  { key: 'honeypot',      label: 'Honeypot',        cfgKey: 'honeypot',          key2: 'honeypot_panel',     desc: 'Trap channel' },
  { key: 'autoresponder', label: 'Auto Responder',  cfgKey: 'autoresponder',     key2: 'autoresponder_panel',desc: 'Keyword replies' },
  { key: 'autoreactor',   label: 'Auto Reactor',    cfgKey: 'autoreactor',       key2: 'autoreactor_panel',  desc: 'Keyword reactions' },
  { key: 'applications',  label: 'Applications',    cfgKey: 'staffApplications', key2: 'applications_panel', desc: 'Staff application workflow' },
  { key: 'birthdays',     label: 'Birthdays',       cfgKey: 'birthdays',         key2: 'birthday_panel',     desc: 'Birthday panel + wishes' },
  { key: 'ai',            label: 'AI Assistant',    cfgKey: 'ai',                key2: 'ai',                 desc: 'Groq /ask and /templategen' }
];

function setupPanelEmbed(guildId) {
  const cfg = db.getConfig(guildId);
  const fields = SETUP_MODULES.map(m => {
    const mod = m.cfgKey.split('.').reduce((a, k) => a?.[k], cfg);
    let status = emoji('disabled');
    if (typeof mod === 'boolean') status = mod ? emoji('enabled') : emoji('disabled');
    else if (mod?.enabled) status = emoji('enabled');
    return { name: `${status} ${emoji(m.key2)} ${m.label}`, value: m.desc, inline: true };
  });
  return buildV2({
    title: `${emoji('settings')} Setup Center`,
    description: 'Select a module below to configure it. All settings are per-server.',
    fields,
    components: [setupModuleRow(), setupExtraRow()]
  });
}
function setupModuleRow() {
  return row(new StringSelectMenuBuilder()
    .setCustomId('setup_module')
    .setPlaceholder('Choose a module…')
    .addOptions(SETUP_MODULES.map(m => ({ label: m.label, value: m.key, description: m.desc.slice(0, 100), emoji: emoji(m.key2) }))));
}
function setupExtraRow() {
  return row(
    btn('setup:health', 'Health Check', ButtonStyle.Secondary, { emoji: emoji('health') }),
    btn('setup:wizard', 'Guided Wizard', ButtonStyle.Primary, { emoji: emoji('wizard') }),
    btn('setup:backup', 'Backup Config', ButtonStyle.Secondary, { emoji: emoji('backup') })
  );
}

// =============================================================================
// TICKET UI
// =============================================================================
function ticketPanelEmbed(cfg, guildName) {
  return buildV2({
    title: emojify(cfg.panelTitle || `${emoji('ticket')} ${guildName} Support`),
    description: cfg.panelDescription || 'Choose a category below to open a ticket. A private channel will be created for you.',
    thumbnail: cfg.panelThumbnail || undefined,
    image: cfg.panelImage || undefined,
    components: ticketPanelRows(cfg)
  });
}
function ticketPanelRows(cfg) {
  const types = (cfg.types && cfg.types.length ? cfg.types : [
    { value: 'general',     label: 'General Support', emoji: '🎫', category: 'Support' },
    { value: 'report',      label: 'User Report',     emoji: '🚨', category: 'Reports' },
    { value: 'staff',       label: 'Staff Application', emoji: '📝', category: 'Staff' },
    { value: 'partnership', label: 'Partnership',     emoji: '🤝', category: 'Partnerships' },
    { value: 'other',       label: 'Other',           emoji: '❔', category: 'Tickets' }
  ]);
  return [row(new StringSelectMenuBuilder()
    .setCustomId('ticket:open:select')
    .setPlaceholder('Choose a ticket type…')
    .addOptions(types.slice(0, 25).map(t => ({ label: t.label, value: t.value, emoji: t.emoji || emoji('ticket') }))))];
}
function ticketWelcome(cfg, user) {
  const desc = (cfg.welcomeMessage || 'Our support team will assist you shortly.').replace('{user}', `${user}`);
  return buildV2({
    title: `${emoji('ticket')} ${cfg.categoryLabel || 'Support'} Ticket`,
    description: `**Welcome** ${user}\n\n${desc}`,
    thumbnail: cfg.welcomeThumbnail || undefined,
    image: cfg.welcomeImage || undefined,
    components: ticketControlRows(false)
  });
}
function ticketControlRows(claimed) {
  return [
    row(
      btn('ticket:claim', claimed ? 'Unclaim' : 'Claim', ButtonStyle.Secondary, { emoji: claimed ? emoji('undo') : emoji('claim') }),
      btn('ticket:add', 'Add', ButtonStyle.Secondary, { emoji: emoji('add') }),
      btn('ticket:remove', 'Remove', ButtonStyle.Secondary, { emoji: emoji('remove') }),
      btn('ticket:rename', 'Rename', ButtonStyle.Secondary, { emoji: emoji('edit') })
    ),
    row(
      btn('ticket:close', 'Close', ButtonStyle.Danger, { emoji: emoji('lock') }),
      btn('ticket:transcript', 'Transcript', ButtonStyle.Secondary, { emoji: emoji('transcript') }),
      btn('ticket:reopen', 'Reopen', ButtonStyle.Success, { emoji: emoji('unlock') }),
      btn('ticket:delete', 'Delete', ButtonStyle.Danger, { emoji: emoji('delete') })
    )
  ];
}

// =============================================================================
// VOICEMASTER
// =============================================================================
function vmControlEmbed(owner, guildId) {
  return buildV2({
    title: `${emoji('voice')} Voice Channel Controls`,
    description: `Owned by ${owner}. Use the buttons below to manage this room.`,
    components: vmControlRows(null)
  });
}
function vmControlRows(vc) {
  const everyone = vc?.guild?.roles?.everyone;
  const ow = everyone ? vc.permissionOverwrites.cache.get(everyone.id) : null;
  const locked = !!(ow && ow.deny.has(PermissionFlagsBits.Connect));
  const hidden = !!(ow && ow.deny.has(PermissionFlagsBits.ViewChannel));
  return [
    row(
      btn('vm_lock', locked ? 'Unlock' : 'Lock', locked ? ButtonStyle.Success : ButtonStyle.Secondary, { emoji: locked ? emoji('unlock') : emoji('lock') }),
      btn('vm_hide', hidden ? 'Unhide' : 'Hide', hidden ? ButtonStyle.Success : ButtonStyle.Secondary, { emoji: hidden ? emoji('visible') : emoji('hidden') }),
      btn('vm_rename', 'Rename', ButtonStyle.Primary, { emoji: emoji('edit') }),
      btn('vm_limit', 'Limit', ButtonStyle.Primary, { emoji: emoji('limit') })
    ),
    row(
      btn('vm_kick', 'Kick', ButtonStyle.Danger, { emoji: emoji('kick') }),
      btn('vm_transfer', 'Transfer', ButtonStyle.Danger, { emoji: emoji('transfer') })
    )
  ];
}
function vmSetupEmbed(cfg) {
  const vm = cfg.voicemaster;
  return buildV2({
    title: `${emoji('voice')} VoiceMaster — Join to Create`,
    description: 'Give members their own temporary voice channel the moment they join a hub VC.',
    fields: [
      { name: 'Status', value: vm.enabled ? `${emoji('enabled')} Enabled` : `${emoji('disabled')} Disabled`, inline: true },
      { name: 'Hub channel', value: vm.hubChannelId ? `<#${vm.hubChannelId}>` : 'Not set', inline: true },
      { name: 'Category', value: vm.categoryId ? `<#${vm.categoryId}>` : 'Hub parent', inline: true },
      { name: 'Name template', value: vm.nameTemplate, inline: false }
    ],
    components: [
      row(new ChannelSelectMenuBuilder().setCustomId('vm:cfg:hub').setPlaceholder('Hub voice channel').setChannelTypes(ChannelType.GuildVoice)),
      row(new ChannelSelectMenuBuilder().setCustomId('vm:cfg:category').setPlaceholder('Category').setChannelTypes(ChannelType.GuildCategory)),
      row(
        toggleButton('vm:cfg:toggle', vm.enabled),
        btn('vm:cfg:name', 'Edit Name Template', ButtonStyle.Primary, { emoji: emoji('edit') })
      )
    ]
  });
}

// =============================================================================
// ROLE PANELS
// =============================================================================
function newPanelId(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function rolePanelListEmbed(panels, mode) {
  const prefix = mode === 'button' ? 'brp' : 'rrp';
  const label = mode === 'button' ? 'Button Roles' : 'Reaction Roles';
  const fields = panels.length
    ? panels.map((p, n) => ({
        name: `${n + 1}. ${p.title || 'Untitled'}`,
        value: `${(p.buttons || p.mappings || []).length} roles • ${p.channelId ? `<#${p.channelId}>` : 'No channel'} • ${p.enabled === false ? emoji('disabled') + ' Disabled' : emoji('enabled') + ' Enabled'}`,
        inline: false
      }))
    : [{ name: 'Panels', value: 'None yet. Click **New Panel** below.' }];
  return buildV2({
    title: `${emoji('role_panel')} ${label}`,
    description: 'Create multiple self-service panels. Use the native role picker to add roles — no IDs to copy.',
    fields,
    components: [row(
      btn(`${prefix}:new`, 'New Panel', ButtonStyle.Primary, { emoji: emoji('add') }),
      ...(panels.length ? [btn(`${prefix}:select_first`, 'Configure First', ButtonStyle.Secondary)] : [])
    )]
  });
}
function rolePanelEmbed(panel, mode) {
  const items = mode === 'button' ? (panel.buttons || []) : (panel.mappings || []);
  return buildV2({
    title: `${emoji('role_panel')} ${panel.title || 'Untitled Panel'}`,
    description: panel.description || (mode === 'button' ? 'Click a button to get or remove a role.' : 'React below to receive or remove a role.'),
    fields: [
      { name: 'Channel', value: panel.channelId ? `<#${panel.channelId}>` : 'Not set', inline: true },
      { name: 'Roles', value: String(items.length), inline: true },
      { name: 'Status', value: panel.enabled === false ? emoji('disabled') + ' Disabled' : emoji('enabled') + ' Enabled', inline: true }
    ],
    components: rolePanelEditRows(panel, mode)
  });
}
function rolePanelEditRows(panel, mode) {
  const prefix = mode === 'button' ? 'brp' : 'rrp';
  return [
    row(new ChannelSelectMenuBuilder().setCustomId(`${prefix}:channel:${panel.id}`).setPlaceholder('Post channel').setChannelTypes(ChannelType.GuildText)),
    row(new RoleSelectMenuBuilder().setCustomId(`${prefix}:addrole:${panel.id}`).setPlaceholder('Add a role to this panel')),
    row(
      btn(`${prefix}:edit:${panel.id}`, 'Edit Text', ButtonStyle.Primary, { emoji: emoji('edit') }),
      toggleButton(`${prefix}:toggle:${panel.id}`, panel.enabled !== false),
      btn(`${prefix}:post:${panel.id}`, panel.messageId ? 'Post Again' : 'Post Panel', ButtonStyle.Success, { emoji: emoji('post') }),
      btn(`${prefix}:del:${panel.id}`, 'Delete', ButtonStyle.Danger, { emoji: emoji('delete') })
    ),
    row(btn(`${prefix}:back`, 'Back to List', ButtonStyle.Secondary, { emoji: emoji('back') }))
  ].slice(0, 5);
}

// =============================================================================
// LOGGING PANEL
// =============================================================================
const LOG_LABELS = {
  default: 'Default (fallback)', message: 'Messages', member: 'Members',
  mod: 'Moderation', voice: 'Voice', security: 'Security',
  ticket: 'Tickets', server: 'Server & Roles', system: 'System'
};
function logSetupEmbed(guildId) {
  const rows = db.listLogConfig(guildId);
  const byCat = Object.fromEntries(rows.map(r => [r.category, r]));
  const fields = Object.entries(LOG_LABELS).map(([k, label]) => {
    const r = byCat[k];
    return { name: label, value: r?.channelId ? `${r.enabled ? emoji('enabled') : emoji('disabled')} <#${r.channelId}>` : `${emoji('disabled')} Not set`, inline: true };
  });
  return buildV2({
    title: `${emoji('logging_panel')} Logging`,
    description: 'Pick a category, then choose a channel. Each category logs independently.',
    fields,
    components: [
      row(new StringSelectMenuBuilder().setCustomId('logsetup:cat').setPlaceholder('1. Category').addOptions(
        Object.entries(LOG_LABELS).map(([value, label]) => ({ label, value }))
      )),
      row(new ChannelSelectMenuBuilder().setCustomId('logsetup:channel').setPlaceholder('2. Channel').setChannelTypes(ChannelType.GuildText))
    ]
  });
}

// =============================================================================
// AUTORESPONDER / AUTOREACTOR
// =============================================================================
function autoresponderEmbed(cfg) {
  const triggers = cfg.triggers || [];
  return buildV2({
    title: `${emoji('autoresponder_panel')} Auto Responder`,
    description: 'Replies with a message when a keyword is matched. Placeholders: `{user}` `{username}` `{server}`',
    fields: [
      { name: 'Status', value: cfg.enabled ? `${emoji('enabled')} Enabled` : `${emoji('disabled')} Disabled`, inline: true },
      { name: 'Triggers', value: String(triggers.length), inline: true },
      { name: 'Case', value: cfg.ignoreCase ? 'Insensitive' : 'Sensitive', inline: true },
      ...triggers.slice(0, 10).map((t, n) => ({ name: `${n + 1}. ${t.match}`, value: `${t.mode} → ${String(t.response || '').slice(0, 100)}`, inline: false }))
    ],
    components: [
      row(
        toggleButton('ar:toggle', cfg.enabled),
        btn('ar:add', 'Add Trigger', ButtonStyle.Primary, { emoji: emoji('add') }),
        btn('ar:case', cfg.ignoreCase ? 'Case: Insensitive' : 'Case: Sensitive', ButtonStyle.Secondary)
      ),
      ...(triggers.length ? [row(new StringSelectMenuBuilder().setCustomId('ar:remove').setPlaceholder('Remove a trigger…')
        .addOptions(triggers.slice(0, 25).map(t => ({ label: String(t.match).slice(0, 90), value: t.id }))))] : [])
    ].slice(0, 5)
  });
}
function autoreactorEmbed(cfg) {
  const triggers = cfg.triggers || [];
  return buildV2({
    title: `${emoji('autoreactor_panel')} Auto Reactor`,
    description: 'Reacts with emoji when a keyword is matched.',
    fields: [
      { name: 'Status', value: cfg.enabled ? `${emoji('enabled')} Enabled` : `${emoji('disabled')} Disabled`, inline: true },
      { name: 'Triggers', value: String(triggers.length), inline: true },
      { name: 'Case', value: cfg.ignoreCase ? 'Insensitive' : 'Sensitive', inline: true },
      ...triggers.slice(0, 10).map((t, n) => ({ name: `${n + 1}. ${t.match}`, value: `${t.mode} → ${(t.emojis || []).join(' ')}`, inline: false }))
    ],
    components: [
      row(
        toggleButton('arr:toggle', cfg.enabled),
        btn('arr:add', 'Add Trigger', ButtonStyle.Primary, { emoji: emoji('add') }),
        btn('arr:case', cfg.ignoreCase ? 'Case: Insensitive' : 'Case: Sensitive', ButtonStyle.Secondary)
      ),
      ...(triggers.length ? [row(new StringSelectMenuBuilder().setCustomId('arr:remove').setPlaceholder('Remove a trigger…')
        .addOptions(triggers.slice(0, 25).map(t => ({ label: String(t.match).slice(0, 90), value: t.id }))))] : [])
    ].slice(0, 5)
  });
}

// =============================================================================
// OTHER PANELS
// =============================================================================
function honeypotEmbed(cfg) {
  return buildV2({
    title: `${emoji('honeypot_panel')} Honeypot`,
    description: 'A trap channel. Anyone who posts in it is acted on. Owner is always exempt.',
    fields: [
      { name: 'Status', value: cfg.enabled ? `${emoji('enabled')} Enabled` : `${emoji('disabled')} Disabled`, inline: true },
      { name: 'Channel', value: cfg.channelId ? `<#${cfg.channelId}>` : 'Not set', inline: true },
      { name: 'Action', value: cfg.action, inline: true },
      { name: 'Log', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Not set', inline: true },
      { name: 'Cleanup', value: cfg.cleanupWindow || 'none', inline: true }
    ],
    components: [
      row(new ChannelSelectMenuBuilder().setCustomId('honeypot:channel').setPlaceholder('Trap channel').setChannelTypes(ChannelType.GuildText)),
      row(new StringSelectMenuBuilder().setCustomId('honeypot:action').setPlaceholder('Action on trigger')
        .addOptions(
          { label: 'Kick', value: 'kick', emoji: emoji('kick') },
          { label: 'Ban', value: 'ban', emoji: emoji('ban') },
          { label: 'Timeout (10m)', value: 'timeout', emoji: emoji('timeout') },
          { label: 'Delete only', value: 'delete', emoji: emoji('delete') }
        )),
      row(
        toggleButton('honeypot:toggle', cfg.enabled),
        btn('honeypot:log', 'Set Log Channel', ButtonStyle.Secondary, { emoji: emoji('logs') })
      )
    ]
  });
}
function levelingEmbed(cfg) {
  const rewards = Object.entries(cfg.roleRewards || {}).map(([l, r]) => `Level ${l} → <@&${r}>`).join('\n') || 'None';
  return buildV2({
    title: `${emoji('leveling_panel')} Leveling`,
    description: 'Members gain XP for eligible messages.',
    fields: [
      { name: 'Status', value: cfg.enabled ? `${emoji('enabled')} Enabled` : `${emoji('disabled')} Disabled`, inline: true },
      { name: 'XP per message', value: String(cfg.xpPerMessage), inline: true },
      { name: 'Cooldown', value: `${cfg.cooldownSeconds}s`, inline: true },
      { name: 'Channel', value: cfg.channel ? `<#${cfg.channel}>` : 'Current channel', inline: true },
      { name: 'Role rewards', value: rewards, inline: false }
    ],
    components: [
      row(new ChannelSelectMenuBuilder().setCustomId('leveling:channel').setPlaceholder('Announcement channel').setChannelTypes(ChannelType.GuildText)),
      row(
        toggleButton('leveling:toggle', cfg.enabled),
        btn('leveling:rewards', 'Role Rewards', ButtonStyle.Primary, { emoji: emoji('rewards') }),
        btn('leveling:xp', 'XP Rate', ButtonStyle.Secondary, { emoji: emoji('level') })
      )
    ]
  });
}
function greetMessageEmbed(cfg) {
  return buildV2({
    title: `${emoji('greet_panel')} Greet Message`,
    description: 'Posts a welcome card when someone joins. Placeholders: `{user}` `{username}` `{server}` `{count}`',
    fields: [
      { name: 'Status', value: cfg.enabled ? `${emoji('enabled')} Enabled` : `${emoji('disabled')} Disabled`, inline: true },
      { name: 'Channel', value: cfg.channelId ? `<#${cfg.channelId}>` : 'Not set', inline: true },
      { name: 'Ping', value: cfg.ping === false ? 'Off' : 'On', inline: true },
      { name: 'Title', value: String(cfg.title || 'Welcome').slice(0, 200), inline: false },
      { name: 'Message', value: String(cfg.message || '').slice(0, 500), inline: false }
    ],
    components: [
      row(new ChannelSelectMenuBuilder().setCustomId('greetmsg:channel').setPlaceholder('Welcome channel').setChannelTypes(ChannelType.GuildText)),
      row(
        toggleButton('greetmsg:toggle', cfg.enabled),
        btn('greetmsg:edit', 'Edit Message', ButtonStyle.Primary, { emoji: emoji('edit') }),
        btn('greetmsg:ping', cfg.ping === false ? 'Ping: Off' : 'Ping: On', ButtonStyle.Secondary),
        btn('greetmsg:test', 'Test', ButtonStyle.Secondary, { emoji: emoji('external') })
      )
    ]
  });
}
function greetVoiceEmbed(cfg, notes = []) {
  const mode = cfg.mode === 'audio' ? '🎵 Uploaded audio' : '🗣️ Text-to-speech';
  const fields = [
    { name: 'Status', value: cfg.enabled ? `${emoji('enabled')} Enabled` : `${emoji('disabled')} Disabled`, inline: true },
    { name: 'Mode', value: mode, inline: true },
    { name: 'Gate Role', value: cfg.roleId ? `<@&${cfg.roleId}>` : 'Not set', inline: true },
    { name: 'Greeting VC', value: cfg.vcId ? `<#${cfg.vcId}>` : 'Not set', inline: true },
    { name: 'Audio File', value: cfg.audioPath ? 'Uploaded' : 'Not uploaded', inline: true },
    { name: 'TTS Prompt', value: cfg.ttsPrompt ? String(cfg.ttsPrompt).slice(0, 600) : 'Not set', inline: false }
  ];
  if (notes.length) fields.push({ name: 'Setup Report', value: notes.join('\n').slice(0, 900), inline: false });
  return buildV2({
    title: `${emoji('greetvoice_panel')} Greet Voice`,
    description: 'New members get the gate role → join the greeting voice channel → hear the greeting → are disconnected.',
    fields,
    components: [
      row(new ChannelSelectMenuBuilder().setCustomId('greetvoice_cfg:voice').setPlaceholder('Greeting voice channel').setChannelTypes(ChannelType.GuildVoice)),
      row(new RoleSelectMenuBuilder().setCustomId('greetvoice_cfg:role_select').setPlaceholder('Gate role')),
      row(
        toggleButton('greetvoice_cfg:toggle', cfg.enabled),
        btn('greetvoice_cfg:prompt', 'Set Prompt', ButtonStyle.Primary, { emoji: emoji('edit') }),
        btn('greetvoice_cfg:test', 'Test', ButtonStyle.Secondary, { emoji: emoji('external') })
      )
    ]
  });
}
function applicationsEmbed(cfg) {
  return buildV2({
    title: `${emoji('applications_panel')} Staff Applications`,
    description: 'Applicants press Apply, answer by DM or form, results land in the review channel.',
    fields: [
      { name: 'Status', value: cfg.enabled ? `${emoji('enabled')} Enabled` : `${emoji('disabled')} Disabled`, inline: true },
      { name: 'Questions', value: String((cfg.questions || []).length), inline: true },
      { name: 'Review channel', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Not set', inline: true },
      { name: 'Panel channel', value: cfg.panelChannelId ? `<#${cfg.panelChannelId}>` : 'Not set', inline: true },
      { name: 'Cooldown', value: `${cfg.cooldownHours ?? 24}h`, inline: true }
    ],
    components: [
      row(new ChannelSelectMenuBuilder().setCustomId('app:cfg:review').setPlaceholder('Review channel').setChannelTypes(ChannelType.GuildText)),
      row(new ChannelSelectMenuBuilder().setCustomId('app:cfg:panel').setPlaceholder('Panel channel').setChannelTypes(ChannelType.GuildText)),
      row(
        toggleButton('app:cfg:toggle', cfg.enabled),
        btn('app:cfg:questions', 'Edit Questions', ButtonStyle.Primary, { emoji: emoji('applications') }),
        btn('app:cfg:post', 'Post Panel', ButtonStyle.Success, { emoji: emoji('post') })
      )
    ]
  });
}
function birthdayEmbed(cfg) {
  return buildV2({
    title: `${emoji('birthday_panel')} Birthday System`,
    description: 'Members set their birthday. The bot posts a wish on the configured channel.',
    fields: [
      { name: 'Status', value: cfg.enabled ? `${emoji('enabled')} Enabled` : `${emoji('disabled')} Disabled`, inline: true },
      { name: 'Panel channel', value: cfg.panelChannelId ? `<#${cfg.panelChannelId}>` : 'Not set', inline: true },
      { name: 'Wish channel', value: cfg.wishChannelId ? `<#${cfg.wishChannelId}>` : 'Not set', inline: true },
      { name: 'Message', value: cfg.wishMessage, inline: false }
    ],
    components: [
      row(new ChannelSelectMenuBuilder().setCustomId('bday:cfg:panel').setPlaceholder('Panel channel').setChannelTypes(ChannelType.GuildText)),
      row(new ChannelSelectMenuBuilder().setCustomId('bday:cfg:wish').setPlaceholder('Wish channel').setChannelTypes(ChannelType.GuildText)),
      row(
        toggleButton('bday:cfg:toggle', cfg.enabled),
        btn('bday:cfg:message', 'Edit Message', ButtonStyle.Primary, { emoji: emoji('edit') }),
        btn('bday:cfg:post', 'Post Panel', ButtonStyle.Success, { emoji: emoji('post') })
      )
    ]
  });
}
function ownerLogSetupEmbed(cfg = {}) {
  return buildV2({
    title: `${emoji('owner')} Owner Log Control`,
    description: 'Global logging destinations. Only bot owners can configure these.',
    fields: [
      { name: 'Error logs', value: cfg.errorChannelId ? `<#${cfg.errorChannelId}>` : 'Not set', inline: true },
      { name: 'Online logs', value: cfg.onlineChannelId ? `<#${cfg.onlineChannelId}>` : 'Not set', inline: true },
      { name: 'Join logs', value: cfg.joinChannelId ? `<#${cfg.joinChannelId}>` : 'Not set', inline: true }
    ],
    components: [
      row(new ChannelSelectMenuBuilder().setCustomId('ownerlogsetup:error').setPlaceholder('Error log channel').setChannelTypes(ChannelType.GuildText)),
      row(new ChannelSelectMenuBuilder().setCustomId('ownerlogsetup:online').setPlaceholder('Online/offline channel').setChannelTypes(ChannelType.GuildText)),
      row(new ChannelSelectMenuBuilder().setCustomId('ownerlogsetup:join').setPlaceholder('Join log channel').setChannelTypes(ChannelType.GuildText))
    ]
  });
}
function embedBuilderPreview(draft) {
  const e = new EmbedBuilder().setColor(draft.color || PRIMARY).setTimestamp();
  if (draft.title) e.setTitle(String(draft.title).slice(0, 200));
  e.setDescription(String(draft.description || '*No description set — press Edit Text.*').slice(0, 4000));
  if (draft.imageUrl) e.setImage(draft.imageUrl);
  if (draft.thumbnailUrl) e.setThumbnail(draft.thumbnailUrl);
  if (draft.footer) e.setFooter({ text: String(draft.footer).slice(0, 200) });
  return { embeds: [e] };
}

// =============================================================================
// EXPORTS
// =============================================================================
module.exports = {
  PRIMARY, OK, WARN, DANGER, INFO, BRAND, V2_OK,
  BLACK: PRIMARY, // legacy alias
  emoji, emojify, emojiKeys, EMOJI: DEFAULT_EMOJIS,
  buildV2, v2Info, v2Ok, v2Err, v2Warn,
  embed, okEmbed, errEmbed, warnEmbed, infoEmbed,
  btn, row, toggleButton, confirmRow,
  HELP_CATEGORIES, helpMenuEmbed, helpSelectRow,
  SETUP_MODULES, setupPanelEmbed, setupModuleRow, setupExtraRow,
  LOG_LABELS, logSetupEmbed,
  ticketPanelEmbed, ticketPanelRows, ticketWelcome, ticketControlRows,
  vmControlEmbed, vmControlRows, vmSetupEmbed,
  newPanelId, rolePanelListEmbed, rolePanelEmbed, rolePanelEditRows,
  autoresponderEmbed, autoreactorEmbed,
  honeypotEmbed, levelingEmbed, greetMessageEmbed, greetVoiceEmbed, applicationsEmbed, birthdayEmbed,
  ownerLogSetupEmbed, embedBuilderPreview
};