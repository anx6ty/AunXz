// AunXz/ui.js — black theme, Components V2 builders, panels, ticket UI, emoji registry.
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
// THEME
// =============================================================================
const BLACK = 0x000000;
const OK = 0x22c55e;
const WARN = 0xf59e0b;
const DANGER = 0xef4444;
const INFO = 0x000000;
const BRAND = process.env.BRAND_FOOTER || 'AunXz';

// Components V2 is only available on discord.js >= 14.16.x
const V2_OK = typeof MessageFlags?.IsComponentsV2 === 'number' && typeof ContainerBuilder === 'function';

// =============================================================================
// EMOJI REGISTRY
// =============================================================================
const DEFAULT_EMOJIS = {
  success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️',
  enabled: '🟢', disabled: '🔴', settings: '⚙️', ticket: '🎫',
  shield: '🛡️', voice: '🔊', level: '📈', wave: '👋',
  delete: '🗑️', lock: '🔒', unlock: '🔓', kick: '👢',
  mute: '🔇', link: '🔗', spam: '🚫', raid: '🚨',
  owner: '👑', help: '📖', list: '📋', edit: '✏️',
  add: '➕', remove: '➖', claim: '🙋', undo: '↩️',
  category: '📁', logs: '📜', tools: '🛠️'
};

function emoji(key) { return db.getEmojiOverride(key) || DEFAULT_EMOJIS[key] || '❔'; }

// Replace every registered emoji in a string with its current override value.
function emojify(value) {
  if (typeof value !== 'string' || !value) return value;
  let out = value;
  const defaults = Object.entries(DEFAULT_EMOJIS).sort((a, b) => b[1].length - a[1].length);
  for (const [key, def] of defaults) {
    const replacement = db.getEmojiOverride(key) || def;
    if (replacement !== def) out = out.split(def).join(replacement);
  }
  return out;
}

// =============================================================================
// COMPONENTS V2 BUILDER (falls back to classic embeds on older discord.js)
// =============================================================================
function buildV2({ title, description, fields, footer, thumbnail, image, components } = {}) {
  if (!V2_OK) {
    const e = new EmbedBuilder().setColor(BLACK).setTimestamp().setFooter({ text: footer || BRAND });
    if (title) e.setTitle(String(title).slice(0, 256));
    if (description) e.setDescription(String(description).slice(0, 4000));
    if (fields?.length) e.addFields(fields.slice(0, 25));
    if (thumbnail) e.setThumbnail(thumbnail);
    if (image) e.setImage(image);
    return { embeds: [e], components: (components || []).slice(0, 5) };
  }

  const c = new ContainerBuilder().setAccentColor(BLACK);

  const lines = [];
  if (title) lines.push(`## ${title}`);
  if (description) lines.push(String(description).slice(0, 3000));
  if (lines.length) {
    if (thumbnail) {
      c.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnail))
      );
    } else {
      c.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
    }
  }

  for (const f of (fields || []).slice(0, 20)) {
    const name = f.name || '\u200b';
    const value = String(f.value ?? '').slice(0, 1000) || '\u200b';
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${name}**\n${value}`));
  }

  if (image) {
    c.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(image))
    );
  }

  c.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(1));
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footer || BRAND}`.slice(0, 4000)));

  for (const row of (components || []).slice(0, 5)) c.addActionRowComponents(row);

  return { components: [c], flags: MessageFlags.IsComponentsV2 };
}

const v2Info = (title, description, opts = {}) => buildV2({ title, description, ...opts });
const v2Ok   = (title, description, opts = {}) => buildV2({ title, description, ...opts });
const v2Err  = (title, description, opts = {}) => buildV2({ title, description, ...opts });
const v2Warn = (title, description, opts = {}) => buildV2({ title, description, ...opts });

// =============================================================================
// CLASSIC EMBEDS
// =============================================================================
function embed(title, description, opts = {}) {
  const e = new EmbedBuilder()
    .setColor(opts.color ?? BLACK)
    .setTimestamp()
    .setFooter({ text: opts.footer || BRAND });
  if (title) e.setTitle(String(title).slice(0, 256));
  if (description) e.setDescription(String(description).slice(0, 4000));
  if (opts.fields?.length) e.addFields(opts.fields.slice(0, 25));
  if (opts.thumbnail) e.setThumbnail(opts.thumbnail);
  if (opts.image) e.setImage(opts.image);
  return e;
}
const okEmbed   = (t, d) => { const e = embed(t, d); e.setColor(OK); return e; };
const errEmbed  = (t, d) => { const e = embed(t, d); e.setColor(DANGER); return e; };
const warnEmbed = (t, d) => { const e = embed(t, d); e.setColor(WARN); return e; };
const infoEmbed = (t, d) => embed(t, d);

// =============================================================================
// BUTTON / ROW HELPERS
// =============================================================================
function btn(id, label, style = ButtonStyle.Secondary, opts = {}) {
  const b = new ButtonBuilder().setCustomId(id).setLabel(String(label).slice(0, 80)).setStyle(style);
  if (opts.emoji) b.setEmoji(opts.emoji);
  if (opts.disabled) b.setDisabled(true);
  if (opts.url) { b.setStyle(ButtonStyle.Link).setURL(opts.url); }
  return b;
}
function row(...components) { return new ActionRowBuilder().addComponents(...components); }
function toggleButton(id, on, { onLabel = 'Enabled', offLabel = 'Disabled' } = {}) {
  return btn(id, on ? onLabel : offLabel, on ? ButtonStyle.Success : ButtonStyle.Danger, {
    emoji: on ? emoji('enabled') : emoji('disabled')
  });
}
function confirmRow(prefix, { yes = 'Confirm', no = 'Cancel' } = {}) {
  return row(btn(`${prefix}:yes`, yes, ButtonStyle.Danger), btn(`${prefix}:no`, no, ButtonStyle.Secondary));
}
function disableRows(rows) {
  for (const r of rows || []) for (const c of r.components || []) c.setDisabled?.(true);
  return rows;
}

// =============================================================================
// HELP MENU
// =============================================================================
const HELP_CATEGORIES = {
  protection: {
    name: 'Protection', emoji: '🛡️',
    desc:
      '**/antinuke setup** — punishment, thresholds, protected owner\n' +
      '**/antilink setup** — delete/warn/mute, domain whitelist, bypass role\n' +
      '**/antispam setup** — message/mention/emoji flood limits\n' +
      '**/antiraid setup** — join-rate lockdown, min account age\n' +
      '**/antiwebhook setup** — webhook action, bypass role, security log\n' +
      '**/antibot setup** — bot action, bypass role, security log\n' +
      '**/antialt setup** — minimum account age, action\n' +
      '**/antibadwordsetup** — word-boundary profanity filter\n' +
      '**/whitelist add|remove|list** — Anti-Nuke exemptions'
  },
  voice: {
    name: 'Voice', emoji: '🔊',
    desc:
      '**/voicemaster setup** — join-to-create hub channel & category\n' +
      '**/greetvoice** — VC greeting with TTS or uploaded audio'
  },
  moderation: {
    name: 'Moderation', emoji: '🔨',
    desc:
      '**/mod ban|unban|kick|timeout|untimeout** — with mod-log embeds\n' +
      '**/mod warn|warnings|clearwarnings** — warning system\n' +
      '**/mod purge** — bulk delete with filters\n' +
      '**/mod history** — case records for a user\n' +
      '**/lock /unlock /slowmode** — channel controls\n' +
      '**/role add|remove** — manual role management'
  },
  leveling: {
    name: 'Leveling', emoji: '📈',
    desc:
      '**/leveling setup** — xp rate, cooldown, level-up message, role rewards\n' +
      '**/rank** — level card\n' +
      '**/leaderboard** — top 25 by XP\n' +
      '**/xp add|remove|set|reset** — admin XP tools'
  },
  tickets: {
    name: 'Tickets', emoji: '🎫',
    desc:
      '**/tickets setup** — category, support role, log channel\n' +
      '**/ticketpanel** — publish the panel\n' +
      '**/ticketconfig** — customize panel appearance\n' +
      'Inside a ticket: **Claim · Add · Remove · Rename · Close · Reopen · Transcript · Delete**'
  },
  logging: {
    name: 'Logging', emoji: '📜',
    desc:
      '**/logsetup** — configure logging per category\n' +
      'Categories: `default` `message` `member` `mod` `voice` `security` `ticket` `server` `system`\n' +
      'Each category logs independently and falls back to `default`.'
  },
  automation: {
    name: 'Automation & Content', emoji: '🛠️',
    desc:
      '**/autoresponder setup** — auto-reply on keyword match\n' +
      '**/autoreactor setup** — auto-react on keyword match\n' +
      '**/embedbuilder** — build a custom embed and post it\n' +
      '**/embed create|send|list|delete** — saved embeds\n' +
      '**/stickymessage set|remove|toggle|list** — pinned embeds\n' +
      '**/honeypot setup** — trap channel\n' +
      '**/buttonrolesetup** / **/reactionrolesetup** — self-service role panels\n' +
      '**/rolepanel create|list** — quick button role panels\n' +
      '**/giveaway start|end|reroll|list** — prize draws\n' +
      '**/birthdaysetup** — birthday panel + wishes'
  },
  applications: {
    name: 'Applications', emoji: '📝',
    desc:
      '**/staffapplicationssetup** — configure the application workflow\n' +
      'Applicants press **Apply**, answer by DM or pop-up form, results land in the review channel.\n' +
      'Staff can Accept or Deny directly from the review message.'
  },
  ai: {
    name: 'AI', emoji: '🤖',
    desc:
      '**/ask <question>** — ask the Groq-powered assistant\n' +
      '**/templategen** — generate a Discord server structure with AI'
  },
  settings: {
    name: 'Settings', emoji: '⚙️',
    desc:
      '**/prefix** — server command prefix\n' +
      '**/welcome setup** / **/leave setup** — welcome & leave messages\n' +
      '**/greetmessage setup** — welcome card with image/title\n' +
      '**/autorole target:<humans|bots|everyone> role:<role>**\n' +
      '**/emojis list|set|reset** — emoji registry\n' +
      '**/setup panel** / **/setup wizard** / **/setup health** / **/setup backup** / **/setup restore**'
  },
  info: {
    name: 'Info & Utility', emoji: 'ℹ️',
    desc:
      '**/help** — this menu\n' +
      '**/ping** **/botinfo** **/serverinfo** **/userinfo** **/avatar**\n' +
      '**/snipe [channel]** — recent deleted/edited messages\n' +
      '**/invites [user]** — invite stats'
  }
};

function helpMenuEmbed(client) {
  const lines = ['Pick a category from the menu below.'];
  for (const [, c] of Object.entries(HELP_CATEGORIES)) lines.push(`${c.emoji} ${c.name}`);
  return buildV2({
    title: '📖 Help Menu',
    description: lines.join('\n'),
    footer: `AIO • all-in-one • <t:${Math.floor(Date.now() / 1000)}:f>`,
    components: [helpSelectRow()]
  });
}

function helpSelectRow() {
  return row(
    new StringSelectMenuBuilder()
      .setCustomId('help_select')
      .setPlaceholder('Choose a category…')
      .addOptions(Object.entries(HELP_CATEGORIES).map(([value, c]) => ({ label: c.name, value, emoji: c.emoji })))
  );
}

// =============================================================================
// SETUP MODULES (for /setup panel + wizard)
// =============================================================================
const SETUP_MODULES = [
  { key: 'automod',           label: 'AutoMod',           cfgKey: 'automod',           desc: 'Caps, invites, bad words' },
  { key: 'antinuke',          label: 'Anti-Nuke',         cfgKey: 'antinuke',          desc: 'Mass-action protection' },
  { key: 'antilink',          label: 'Anti-Link',         cfgKey: 'antilink',          desc: 'Link filter with bypasses' },
  { key: 'antispam',          label: 'Anti-Spam',         cfgKey: 'antispam',          desc: 'Message flood limits' },
  { key: 'antiraid',          label: 'Anti-Raid',         cfgKey: 'antiraid',          desc: 'Join-rate lockdown' },
  { key: 'antiwebhook',       label: 'Anti-Webhook',      cfgKey: 'antiwebhook',       desc: 'Block unauthorized webhooks' },
  { key: 'antibot',           label: 'Anti-Bot',          cfgKey: 'antibot',           desc: 'Control bot invites' },
  { key: 'antialt',           label: 'Anti-Alt',          cfgKey: 'antialt',           desc: 'Block young accounts' },
  { key: 'antibadword',       label: 'Anti-Bad-Word',     cfgKey: 'antibadword',       desc: 'Word-boundary profanity filter' },
  { key: 'logging',           label: 'Logging',           cfgKey: 'logs',              desc: 'Per-category destinations' },
  { key: 'welcome',           label: 'Welcome',           cfgKey: 'welcome',           desc: 'Join messages' },
  { key: 'leave',             label: 'Leave',             cfgKey: 'leave',             desc: 'Leave messages' },
  { key: 'greetmessage',      label: 'Greet Message',     cfgKey: 'greetmessage',      desc: 'Welcome card with image' },
  { key: 'greetvoice',        label: 'Greet Voice',       cfgKey: 'greetvoice',        desc: 'VC greeting with TTS' },
  { key: 'tickets',           label: 'Tickets',           cfgKey: 'ticket',            desc: 'Support ticket system' },
  { key: 'leveling',          label: 'Leveling',          cfgKey: 'leveling',          desc: 'XP and role rewards' },
  { key: 'voicemaster',       label: 'VoiceMaster',       cfgKey: 'voicemaster',       desc: 'Join-to-create voice' },
  { key: 'honeypot',          label: 'Honeypot',          cfgKey: 'honeypot',          desc: 'Trap channel' },
  { key: 'autoresponder',     label: 'Auto Responder',    cfgKey: 'autoresponder',     desc: 'Keyword replies' },
  { key: 'autoreactor',       label: 'Auto Reactor',      cfgKey: 'autoreactor',       desc: 'Keyword reactions' },
  { key: 'applications',      label: 'Applications',      cfgKey: 'staffApplications', desc: 'Staff application workflow' },
  { key: 'birthdays',         label: 'Birthdays',         cfgKey: 'birthdays',         desc: 'Birthday panel + wishes' },
  { key: 'ai',                label: 'AI Assistant',      cfgKey: 'ai',                desc: 'Groq /ask and /templategen' }
];

function setupPanelEmbed(guildId) {
  const cfg = db.getConfig(guildId);
  const fields = SETUP_MODULES.map(m => {
    const mod = m.cfgKey.split('.').reduce((a, k) => a?.[k], cfg);
    let status = '⚪';
    if (typeof mod === 'boolean') status = mod ? '🟢' : '⚪';
    else if (mod?.enabled) status = '🟢';
    return { name: `${status} ${m.label}`, value: m.desc, inline: true };
  });
  return buildV2({
    title: '⚙️ Setup Center',
    description: 'Select a module below to configure it. All settings are per-server.',
    fields,
    components: [setupModuleRow(), setupExtraRow()]
  });
}
function setupModuleRow() {
  return row(new StringSelectMenuBuilder()
    .setCustomId('setup_module')
    .setPlaceholder('Choose a module…')
    .addOptions(SETUP_MODULES.map(m => ({ label: m.label, value: m.key, description: m.desc.slice(0, 100) }))));
}
function setupExtraRow() {
  return row(
    btn('setup:health', 'Health Check', ButtonStyle.Secondary, { emoji: '🩺' }),
    btn('setup:wizard', 'Guided Wizard', ButtonStyle.Primary, { emoji: '🧭' }),
    btn('setup:backup', 'Backup Config', ButtonStyle.Secondary, { emoji: '📦' })
  );
}

// =============================================================================
// TICKET UI
// =============================================================================
function ticketPanelEmbed(cfg, guildName) {
  return buildV2({
    title: cfg.panelTitle || `🎫 ${guildName} Support`,
    description: cfg.panelDescription || 'Choose a category below to open a ticket. A private channel will be created for you.',
    thumbnail: cfg.panelThumbnail || undefined,
    image: cfg.panelImage || undefined,
    components: ticketPanelRows(cfg)
  });
}
function ticketPanelRows(cfg) {
  const types = (cfg.types && cfg.types.length ? cfg.types : [
    { value: 'general',     label: 'General Support', emoji: '🎫' },
    { value: 'report',      label: 'User Report',     emoji: '🚨' },
    { value: 'partnership', label: 'Partnership',     emoji: '🤝' },
    { value: 'other',       label: 'Other',           emoji: '❔' }
  ]);
  return [
    row(new StringSelectMenuBuilder()
      .setCustomId('ticket:open:select')
      .setPlaceholder('Choose a ticket type…')
      .addOptions(types.slice(0, 25).map(t => ({ label: t.label, value: t.value, emoji: t.emoji }))))
  ];
}
function ticketWelcome(cfg, user) {
  const desc = (cfg.welcomeMessage || 'Our support team will assist you shortly.').replace('{user}', `${user}`);
  return buildV2({
    title: `🎫 ${cfg.categoryLabel || 'Support'} Ticket`,
    description: `**Welcome** ${user}\n\n${desc}`,
    thumbnail: cfg.welcomeThumbnail || undefined,
    image: cfg.welcomeImage || undefined,
    components: ticketControlRows(false)
  });
}
function ticketControlRows(claimed) {
  return [
    row(
      btn('ticket:claim', claimed ? 'Unclaim' : 'Claim', ButtonStyle.Secondary, { emoji: claimed ? '↩️' : '🙋' }),
      btn('ticket:add', 'Add', ButtonStyle.Secondary, { emoji: '➕' }),
      btn('ticket:remove', 'Remove', ButtonStyle.Secondary, { emoji: '➖' }),
      btn('ticket:rename', 'Rename', ButtonStyle.Secondary, { emoji: '✏️' })
    ),
    row(
      btn('ticket:close', 'Close', ButtonStyle.Danger, { emoji: '🔒' }),
      btn('ticket:transcript', 'Transcript', ButtonStyle.Secondary, { emoji: '📄' }),
      btn('ticket:reopen', 'Reopen', ButtonStyle.Success, { emoji: '🔓' }),
      btn('ticket:delete', 'Delete', ButtonStyle.Danger, { emoji: '🗑️' })
    )
  ];
}

// =============================================================================
// VOICEMASTER CONTROL
// =============================================================================
function vmControlEmbed(owner, guildId) {
  return buildV2({
    title: '🔊 Voice Channel Controls',
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
      btn('vm_lock', locked ? 'Unlock' : 'Lock', locked ? ButtonStyle.Success : ButtonStyle.Secondary, { emoji: locked ? '🔓' : '🔒' }),
      btn('vm_hide', hidden ? 'Unhide' : 'Hide', hidden ? ButtonStyle.Success : ButtonStyle.Secondary, { emoji: hidden ? '👁️' : '🙈' }),
      btn('vm_rename', 'Rename', ButtonStyle.Primary, { emoji: '✏️' }),
      btn('vm_limit', 'Limit', ButtonStyle.Primary, { emoji: '🔢' })
    ),
    row(
      btn('vm_kick', 'Kick', ButtonStyle.Danger, { emoji: '👢' }),
      btn('vm_transfer', 'Transfer', ButtonStyle.Danger, { emoji: '🔁' })
    )
  ];
}
function vmSetupEmbed(cfg) {
  const vm = cfg.voicemaster;
  return buildV2({
    title: '🔊 VoiceMaster — Join to Create',
    description: 'Give members their own temporary voice channel the moment they join a hub VC.',
    fields: [
      { name: 'Status', value: vm.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
      { name: 'Hub channel', value: vm.hubChannelId ? `<#${vm.hubChannelId}>` : 'Not set', inline: true },
      { name: 'Category', value: vm.categoryId ? `<#${vm.categoryId}>` : 'Hub parent', inline: true },
      { name: 'Name template', value: vm.nameTemplate, inline: false }
    ],
    components: [
      row(new ChannelSelectMenuBuilder().setCustomId('vm:cfg:hub').setPlaceholder('Hub voice channel').setChannelTypes(ChannelType.GuildVoice)),
      row(new ChannelSelectMenuBuilder().setCustomId('vm:cfg:category').setPlaceholder('Category').setChannelTypes(ChannelType.GuildCategory)),
      row(
        toggleButton('vm:cfg:toggle', vm.enabled),
        btn('vm:cfg:name', 'Edit Name Template', ButtonStyle.Primary, { emoji: '✏️' })
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
        value: `${(p.buttons || p.mappings || []).length} roles • ${p.channelId ? `<#${p.channelId}>` : 'No channel'} • ${p.enabled === false ? 'Disabled' : 'Enabled'}`,
        inline: false
      }))
    : [{ name: 'Panels', value: 'None yet. Click **New Panel** below.' }];
  return buildV2({
    title: `🎭 ${label}`,
    description: 'Create multiple self-service panels. Use the native role picker to add roles — no IDs to copy.',
    fields,
    components: [
      row(
        btn(`${prefix}:new`, 'New Panel', ButtonStyle.Primary, { emoji: '➕' }),
        ...(panels.length ? [btn(`${prefix}:select_first`, 'Configure First', ButtonStyle.Secondary)] : [])
      )
    ]
  });
}
function rolePanelEmbed(panel, mode) {
  const items = mode === 'button' ? (panel.buttons || []) : (panel.mappings || []);
  return buildV2({
    title: `🎭 ${panel.title || 'Untitled Panel'}`,
    description: panel.description || (mode === 'button' ? 'Click a button to get or remove a role.' : 'React below to receive or remove a role.'),
    fields: [
      { name: 'Channel', value: panel.channelId ? `<#${panel.channelId}>` : 'Not set', inline: true },
      { name: 'Roles', value: String(items.length), inline: true },
      { name: 'Status', value: panel.enabled === false ? 'Disabled' : 'Enabled', inline: true }
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
      btn(`${prefix}:edit:${panel.id}`, 'Edit Text', ButtonStyle.Primary, { emoji: '✏️' }),
      toggleButton(`${prefix}:toggle:${panel.id}`, panel.enabled !== false, { onLabel: 'Enabled', offLabel: 'Disabled' }),
      btn(`${prefix}:post:${panel.id}`, panel.messageId ? 'Post Again' : 'Post Panel', ButtonStyle.Success, { emoji: '📤' }),
      btn(`${prefix}:del:${panel.id}`, 'Delete', ButtonStyle.Danger, { emoji: '🗑️' })
    ),
    row(btn(`${prefix}:back`, 'Back to List', ButtonStyle.Secondary))
  ].slice(0, 5);
}

// =============================================================================
// LOGGING PANEL
// =============================================================================
const LOG_LABELS = {
  default: 'Default (fallback)',
  message: 'Messages', member: 'Members', mod: 'Moderation',
  voice: 'Voice', security: 'Security', ticket: 'Tickets',
  server: 'Server & Roles', system: 'System'
};
function logSetupEmbed(guildId) {
  const rows = db.listLogConfig(guildId);
  const byCat = Object.fromEntries(rows.map(r => [r.category, r]));
  const fields = Object.entries(LOG_LABELS).map(([k, label]) => {
    const r = byCat[k];
    return { name: label, value: r?.channelId ? `${r.enabled ? '🟢' : '⚪'} <#${r.channelId}>` : '⚪ Not set', inline: true };
  });
  return buildV2({
    title: '📜 Logging',
    description: 'Pick a category, then choose a channel. Each category logs independently. "Default" is used as a fallback when a specific category has no channel.',
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
// AUTORESPONDER / AUTOREACTOR PANELS
// =============================================================================
function autoresponderEmbed(cfg) {
  const triggers = cfg.triggers || [];
  return buildV2({
    title: '💬 Auto Responder',
    description: 'Replies with a message when a keyword is matched. Placeholders: `{user}` `{username}` `{server}`',
    fields: [
      { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
      { name: 'Triggers', value: String(triggers.length), inline: true },
      { name: 'Case', value: cfg.ignoreCase ? 'Insensitive' : 'Sensitive', inline: true },
      ...triggers.slice(0, 10).map((t, n) => ({ name: `${n + 1}. ${t.match}`, value: `${t.mode} → ${String(t.response || '').slice(0, 100)}`, inline: false }))
    ],
    components: [
      row(
        toggleButton('ar:toggle', cfg.enabled),
        btn('ar:add', 'Add Trigger', ButtonStyle.Primary, { emoji: '➕' }),
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
    title: '😀 Auto Reactor',
    description: 'Reacts with emoji when a keyword is matched.',
    fields: [
      { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
      { name: 'Triggers', value: String(triggers.length), inline: true },
      { name: 'Case', value: cfg.ignoreCase ? 'Insensitive' : 'Sensitive', inline: true },
      ...triggers.slice(0, 10).map((t, n) => ({ name: `${n + 1}. ${t.match}`, value: `${t.mode} → ${(t.emojis || []).join(' ')}`, inline: false }))
    ],
    components: [
      row(
        toggleButton('arr:toggle', cfg.enabled),
        btn('arr:add', 'Add Trigger', ButtonStyle.Primary, { emoji: '➕' }),
        btn('arr:case', cfg.ignoreCase ? 'Case: Insensitive' : 'Case: Sensitive', ButtonStyle.Secondary)
      ),
      ...(triggers.length ? [row(new StringSelectMenuBuilder().setCustomId('arr:remove').setPlaceholder('Remove a trigger…')
        .addOptions(triggers.slice(0, 25).map(t => ({ label: String(t.match).slice(0, 90), value: t.id }))))] : [])
    ].slice(0, 5)
  });
}

// =============================================================================
// HONEYPOT PANEL
// =============================================================================
function honeypotEmbed(cfg) {
  return buildV2({
    title: '🍯 Honeypot',
    description: 'A trap channel. Anyone who posts in it is acted on. Owner is always exempt.',
    fields: [
      { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
      { name: 'Channel', value: cfg.channelId ? `<#${cfg.channelId}>` : 'Not set', inline: true },
      { name: 'Action', value: cfg.action, inline: true },
      { name: 'Log', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Not set', inline: true },
      { name: 'Cleanup', value: cfg.cleanupWindow || 'none', inline: true }
    ],
    components: [
      row(new ChannelSelectMenuBuilder().setCustomId('honeypot:channel').setPlaceholder('Trap channel').setChannelTypes(ChannelType.GuildText)),
      row(new StringSelectMenuBuilder().setCustomId('honeypot:action').setPlaceholder('Action on trigger')
        .addOptions(
          { label: 'Kick', value: 'kick', emoji: '👢' },
          { label: 'Ban', value: 'ban', emoji: '🔨' },
          { label: 'Timeout (10m)', value: 'timeout', emoji: '🔇' },
          { label: 'Delete only', value: 'delete', emoji: '🗑️' }
        )),
      row(
        toggleButton('honeypot:toggle', cfg.enabled),
        btn('honeypot:log', 'Set Log Channel', ButtonStyle.Secondary)
      )
    ]
  });
}

// =============================================================================
// LEVELING PANEL
// =============================================================================
function levelingEmbed(cfg) {
  const rewards = Object.entries(cfg.roleRewards || {}).map(([l, r]) => `Level ${l} → <@&${r}>`).join('\n') || 'None';
  return buildV2({
    title: '📈 Leveling',
    description: 'Members gain XP for eligible messages.',
    fields: [
      { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
      { name: 'XP per message', value: String(cfg.xpPerMessage), inline: true },
      { name: 'Cooldown', value: `${cfg.cooldownSeconds}s`, inline: true },
      { name: 'Channel', value: cfg.channel ? `<#${cfg.channel}>` : 'Current channel', inline: true },
      { name: 'Role rewards', value: rewards, inline: false }
    ],
    components: [
      row(new ChannelSelectMenuBuilder().setCustomId('leveling:channel').setPlaceholder('Announcement channel').setChannelTypes(ChannelType.GuildText)),
      row(
        toggleButton('leveling:toggle', cfg.enabled),
        btn('leveling:rewards', 'Role Rewards', ButtonStyle.Primary, { emoji: '🎁' }),
        btn('leveling:xp', 'XP Rate', ButtonStyle.Secondary)
      )
    ]
  });
}

// =============================================================================
// GREET MESSAGE PANEL
// =============================================================================
function greetMessageEmbed(cfg) {
  return buildV2({
    title: '👋 Greet Message',
    description: 'Posts a welcome card when someone joins. Placeholders: `{user}` `{username}` `{server}` `{count}`',
    fields: [
      { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
      { name: 'Channel', value: cfg.channelId ? `<#${cfg.channelId}>` : 'Not set', inline: true },
      { name: 'Ping', value: cfg.ping === false ? 'Off' : 'On', inline: true },
      { name: 'Title', value: String(cfg.title || 'Welcome').slice(0, 200), inline: false },
      { name: 'Message', value: String(cfg.message || '').slice(0, 500), inline: false }
    ],
    components: [
      row(new ChannelSelectMenuBuilder().setCustomId('greetmsg:channel').setPlaceholder('Welcome channel').setChannelTypes(ChannelType.GuildText)),
      row(
        toggleButton('greetmsg:toggle', cfg.enabled),
        btn('greetmsg:edit', 'Edit Message', ButtonStyle.Primary, { emoji: '✏️' }),
        btn('greetmsg:ping', cfg.ping === false ? 'Ping: Off' : 'Ping: On', ButtonStyle.Secondary),
        btn('greetmsg:test', 'Test', ButtonStyle.Secondary)
      )
    ]
  });
}

// =============================================================================
// GREET VOICE PANEL
// =============================================================================
function ttsVoiceMeta(key) {
  try {
    const voices = require('./systems').TTS_VOICES;
    return voices[key] || voices.us;
  } catch { return { label: 'US English', description: '' }; }
}
function greetVoiceEmbed(cfg, notes = []) {
  const mode = cfg.mode === 'audio' ? '🎵 Uploaded audio' : '🗣️ Text-to-speech';
  const fields = [
    { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
    { name: 'Mode', value: mode, inline: true },
    { name: 'TTS Voice', value: ttsVoiceMeta(cfg.ttsVoice).label, inline: true },
    { name: 'Gate Role', value: cfg.roleId ? `<@&${cfg.roleId}>` : 'Not set', inline: true },
    { name: 'Greeting VC', value: cfg.vcId ? `<#${cfg.vcId}>` : 'Not set', inline: true },
    { name: 'Audio File', value: cfg.audioPath ? 'Uploaded' : 'Not uploaded', inline: true },
    { name: 'TTS Prompt', value: cfg.ttsPrompt ? String(cfg.ttsPrompt).slice(0, 600) : 'Not set', inline: false }
  ];
  if (notes.length) fields.push({ name: 'Setup Report', value: notes.join('\n').slice(0, 900), inline: false });
  return buildV2({
    title: '🔊 Greet Voice',
    description: 'New members get the gate role → join the greeting voice channel → hear your TTS/audio greeting → are disconnected and the role is removed.',
    fields,
    components: greetVoiceRows(cfg)
  });
}
function greetVoiceRows(cfg) {
  const voices = (() => {
    try { return require('./systems').TTS_VOICES; }
    catch { return { us: { label: 'US English', description: '' } }; }
  })();
  const voiceMenu = new StringSelectMenuBuilder()
    .setCustomId('greetvoice_cfg:ttsvoice')
    .setPlaceholder('TTS voice / accent')
    .addOptions(Object.entries(voices).map(([value, v]) => ({
      label: v.label.slice(0, 100),
      description: String(v.description || '').slice(0, 100),
      value,
      default: (cfg.ttsVoice || 'us') === value
    })));
  const channelMenu = new ChannelSelectMenuBuilder().setCustomId('greetvoice_cfg:voice').setPlaceholder('Greeting voice channel').setChannelTypes(ChannelType.GuildVoice);
  if (cfg.vcId) channelMenu.setDefaultChannels(cfg.vcId);
  const roleMenu = new RoleSelectMenuBuilder().setCustomId('greetvoice_cfg:role_select').setPlaceholder('Gate role');
  if (cfg.roleId) roleMenu.setDefaultRoles(cfg.roleId);
  return [
    row(channelMenu),
    row(roleMenu),
    row(voiceMenu),
    row(
      btn('greetvoice_cfg:prompt', 'Set Prompt', ButtonStyle.Primary, { emoji: '✏️' }),
      btn('greetvoice_cfg:audio', cfg.audioPath ? 'Replace Audio' : 'Upload Audio', ButtonStyle.Secondary, { emoji: '🎵' }),
      btn('greetvoice_cfg:mode', cfg.mode === 'audio' ? 'Use TTS' : 'Use Audio', ButtonStyle.Secondary, { emoji: '🔁' }),
      btn('greetvoice_cfg:test', 'Test', ButtonStyle.Secondary, { emoji: '▶️' }),
      toggleButton('greetvoice_cfg:toggle', cfg.enabled)
    )
  ];
}

// =============================================================================
// APPLICATIONS PANEL
// =============================================================================
function applicationsEmbed(cfg) {
  return buildV2({
    title: '📝 Staff Applications',
    description: 'Applicants press Apply, answer questions by DM or form, results land in the review channel.',
    fields: [
      { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
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
        btn('app:cfg:questions', 'Edit Questions', ButtonStyle.Primary, { emoji: '📝' }),
        btn('app:cfg:post', 'Post Panel', ButtonStyle.Success, { emoji: '📤' })
      )
    ]
  });
}

// =============================================================================
// BIRTHDAY PANEL
// =============================================================================
function birthdayEmbed(cfg) {
  return buildV2({
    title: '🎂 Birthday System',
    description: 'Members set their birthday. The bot posts a wish on the configured channel.',
    fields: [
      { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
      { name: 'Panel channel', value: cfg.panelChannelId ? `<#${cfg.panelChannelId}>` : 'Not set', inline: true },
      { name: 'Wish channel', value: cfg.wishChannelId ? `<#${cfg.wishChannelId}>` : 'Not set', inline: true },
      { name: 'Message', value: cfg.wishMessage, inline: false }
    ],
    components: [
      row(new ChannelSelectMenuBuilder().setCustomId('bday:cfg:panel').setPlaceholder('Panel channel').setChannelTypes(ChannelType.GuildText)),
      row(new ChannelSelectMenuBuilder().setCustomId('bday:cfg:wish').setPlaceholder('Wish channel').setChannelTypes(ChannelType.GuildText)),
      row(
        toggleButton('bday:cfg:toggle', cfg.enabled),
        btn('bday:cfg:message', 'Edit Message', ButtonStyle.Primary),
        btn('bday:cfg:post', 'Post Panel', ButtonStyle.Success, { emoji: '📤' })
      )
    ]
  });
}

// =============================================================================
// OWNER LOG SETUP
// =============================================================================
function ownerLogSetupEmbed(cfg = {}) {
  return buildV2({
    title: '👑 Owner Log Control',
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

// =============================================================================
// EMBED BUILDER
// =============================================================================
function embedBuilderPreview(draft) {
  const e = new EmbedBuilder().setColor(draft.color || BLACK).setTimestamp();
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
  // theme
  BLACK, OK, WARN, DANGER, INFO, BRAND, V2_OK,
  // emoji
  emoji, emojify, EMOJI: DEFAULT_EMOJIS,
  // V2
  buildV2, v2Info, v2Ok, v2Err, v2Warn,
  // classic
  embed, okEmbed, errEmbed, warnEmbed, infoEmbed,
  // buttons
  btn, row, toggleButton, confirmRow, disableRows,
  // help
  HELP_CATEGORIES, helpMenuEmbed, helpSelectRow,
  // setup
  SETUP_MODULES, setupPanelEmbed, setupModuleRow, setupExtraRow,
  // logging
  LOG_LABELS, logSetupEmbed,
  // tickets
  ticketPanelEmbed, ticketPanelRows, ticketWelcome, ticketControlRows,
  // voicemaster
  vmControlEmbed, vmControlRows, vmSetupEmbed,
  // role panels
  newPanelId, rolePanelListEmbed, rolePanelEmbed, rolePanelEditRows,
  // responders
  autoresponderEmbed, autoreactorEmbed,
  // other panels
  honeypotEmbed, levelingEmbed, greetMessageEmbed, greetVoiceEmbed, applicationsEmbed, birthdayEmbed,
  ownerLogSetupEmbed,
  // embed builder
  embedBuilderPreview
};