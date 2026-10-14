// AunXz/ui.js — black theme, Components V2 builders, panels, ticket UI, emoji registry.
'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder,
  ChannelType, ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder,
  SeparatorBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags
} = require('discord.js');
const db = require('./database');

// === BLACK THEME ===
const BLACK = 0x000000;
const OK = 0x22c55e;
const WARN = 0xf59e0b;
const DANGER = 0xef4444;
const INFO = 0x000000;
const BRAND = process.env.BRAND_FOOTER || 'AunXz';
const V2_OK = typeof MessageFlags?.IsComponentsV2 === 'number' && typeof ContainerBuilder === 'function';

// === EMOJI ===
const EMOJI = {
  success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️', enabled: '🟢', disabled: '🔴',
  settings: '⚙️', ticket: '🎫', shield: '🛡️', voice: '🔊', level: '📈', wave: '👋',
  delete: '🗑️', lock: '🔒', unlock: '🔓', kick: '👢', mute: '🔇', link: '🔗',
  spam: '🚫', raid: '🚨', owner: '👑', help: '📖', list: '📋', edit: '✏️',
  add: '➕', remove: '➖', claim: '🙋', undo: '↩️', category: '📁', shield_check: '🛡️'
};
function emoji(k) { return db.getEmojiOverride(k) || EMOJI[k] || '❔'; }

// === COMPONENTS V2 / CLASSIC BUILDER ===
function buildV2({ title, description, fields, footer, thumbnail, image, components } = {}) {
  if (!V2_OK) {
    const e = new EmbedBuilder().setColor(BLACK).setTimestamp();
    if (title) e.setTitle(title);
    if (description) e.setDescription(description);
    if (fields?.length) e.addFields(fields);
    if (footer) e.setFooter({ text: footer }); else e.setFooter({ text: BRAND });
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
        new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n'))).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnail))
      );
    } else {
      c.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
    }
  }
  for (const f of (fields || []).slice(0, 20)) {
    const nm = f.name || '\u200b';
    const val = String(f.value ?? '').slice(0, 1000) || '\u200b';
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${nm}**\n${val}`));
  }
  if (image) c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(image)));
  const foot = footer ? `-# ${footer}` : `-# ${BRAND}`;
  c.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(1));
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(foot.slice(0, 4000)));
  for (const row of (components || []).slice(0, 5)) c.addActionRowComponents(row);
  return { components: [c], flags: MessageFlags.IsComponentsV2 };
}

const v2Info = (title, description, opts = {}) => buildV2({ title, description, ...opts });
const v2Ok = (title, description, opts = {}) => buildV2({ title, description, ...opts });
const v2Err = (title, description, opts = {}) => buildV2({ title, description, ...opts });
const v2Warn = (title, description, opts = {}) => buildV2({ title, description, ...opts });

// === CLASSIC EMBEDS (fallback + simple replies) ===
function embed(title, description, opts = {}) {
  const e = new EmbedBuilder().setColor(BLACK).setTimestamp().setFooter({ text: opts.footer || BRAND });
  if (title) e.setTitle(String(title).slice(0, 256));
  if (description) e.setDescription(String(description).slice(0, 4000));
  if (opts.fields?.length) e.addFields(opts.fields.slice(0, 25));
  if (opts.thumbnail) e.setThumbnail(opts.thumbnail);
  if (opts.image) e.setImage(opts.image);
  return e;
}
const okEmbed = (t, d) => { const e = embed(t, d); e.setColor(OK); return e; };
const errEmbed = (t, d) => { const e = embed(t, d); e.setColor(DANGER); return e; };
const warnEmbed = (t, d) => { const e = embed(t, d); e.setColor(WARN); return e; };
const infoEmbed = (t, d) => embed(t, d);

// === BUTTON HELPERS ===
const btn = (id, label, style = ButtonStyle.Secondary, opts = {}) => {
  const b = new ButtonBuilder().setCustomId(id).setLabel(String(label).slice(0, 80)).setStyle(style);
  if (opts.emoji) b.setEmoji(opts.emoji);
  if (opts.disabled) b.setDisabled(true);
  if (opts.url) { b.setStyle(ButtonStyle.Link).setURL(opts.url); }
  return b;
};
function row(...components) { return new ActionRowBuilder().addComponents(...components); }
function toggleButton(id, on, { onLabel = 'Enabled', offLabel = 'Disabled' } = {}) {
  return btn(id, on ? onLabel : offLabel, on ? ButtonStyle.Success : ButtonStyle.Danger, { emoji: on ? emoji('enabled') : emoji('disabled') });
}
function confirmRow(prefix, { yes = 'Confirm', no = 'Cancel' } = {}) {
  return row(
    btn(`${prefix}:yes`, yes, ButtonStyle.Danger),
    btn(`${prefix}:no`, no, ButtonStyle.Secondary)
  );
}

// === HELP MENU ===
const HELP_CATEGORIES = {
  protection: { name: 'Protection', emoji: '🛡️', desc: '**/antinuke setup** — punishment, thresholds, owner protection\n**/antilink setup** — link filter, bypass roles\n**/antispam setup** — flood limits\n**/antiraid setup** — join-rate lockdown\n**/antiwebhook setup** — webhook defense\n**/antibot setup** — bot invite control\n**/antialt setup** — new-account filter\n**/whitelist add|remove|list** — Anti-Nuke exemptions' },
  voice: { name: 'Voice', emoji: '🔊', desc: '**/voicemaster setup** — join-to-create hub\n**/greetvoice setup** — VC greeting (TTS deferred)' },
  moderation: { name: 'Moderation', emoji: '🔨', desc: '**/mod ban|kick|timeout|untimeout**\n**/mod warn|warnings|clearwarnings**\n**/mod purge** — bulk delete\n**/mod history** — case records\n**/lock /unlock /slowmode**' },
  leveling: { name: 'Leveling', emoji: '📈', desc: '**/leveling setup** — XP rate, cooldowns, rewards\n**/rank** — level card\n**/leaderboard** — top 25\n**/xp add|remove|set|reset**' },
  tickets: { name: 'Tickets', emoji: '🎫', desc: '**/tickets setup** — category, roles, channels\n**/ticketpanel** — publish the panel\n**/ticketconfig** — customize appearance\nInside a ticket: **Claim · Add · Remove · Rename · Close · Transcript**' },
  logging: { name: 'Logging', emoji: '📜', desc: '**/logsetup** — configure channels per category\nCategories: message · member · moderation · voice · security · ticket · server · system' },
  automation: { name: 'Automation & Content', emoji: '⚙️', desc: '**/autoresponder setup** — keyword replies\n**/autoreactor setup** — keyword reactions\n**/embedbuilder** — custom embeds\n**/embed** — saved embeds\n**/stickymessage** — pinned embeds\n**/honeypot setup** — trap channel\n**/antibadwordsetup** — profanity filter\n**/buttonrolesetup** / **/reactionrolesetup**\n**/rolepanel** — self-service roles\n**/giveaway** — prize draws\n**/birthdaysetup** — birthday system' },
  applications: { name: 'Applications', emoji: '📝', desc: '**/staffapplicationssetup** — staff application workflow\nApplicants press **Apply**, answer by DM or pop-up form, results land in the review channel.' },
  ai: { name: 'AI', emoji: '🤖', desc: '**/ask <question>** — Groq AI assistant\n**/templategen** — AI server builder' },
  settings: { name: 'Settings', emoji: '⚙️', desc: '**/prefix** — command prefix\n**/welcome setup** / **/leave setup**\n**/greetmessage setup**\n**/emojis list|set|reset**\n**/autorole**' },
  info: { name: 'Info & Utility', emoji: 'ℹ️', desc: '**/help** — this menu\n**/ping** **/botinfo** **/serverinfo** **/userinfo** **/avatar**\n**/snipe** — recent deleted/edited messages\n**/setup health** — diagnostics' }
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
  return row(new StringSelectMenuBuilder().setCustomId('help_select').setPlaceholder('Choose a category…')
    .addOptions(Object.entries(HELP_CATEGORIES).map(([value, c]) => ({ label: c.name, value, emoji: c.emoji }))));
}

// === SETUP MODULES (for /setup panel) ===
const SETUP_MODULES = [
  { key: 'automod', label: 'AutoMod', cfgKey: 'automod', desc: 'Caps, invites, custom bad words' },
  { key: 'antinuke', label: 'Anti-Nuke', cfgKey: 'antinuke', desc: 'Mass-action protection' },
  { key: 'antilink', label: 'Anti-Link', cfgKey: 'antilink', desc: 'Link filter with bypasses' },
  { key: 'antispam', label: 'Anti-Spam', cfgKey: 'antispam', desc: 'Message flood limits' },
  { key: 'antiraid', label: 'Anti-Raid', cfgKey: 'antiraid', desc: 'Join-rate lockdown' },
  { key: 'antiwebhook', label: 'Anti-Webhook', cfgKey: 'antiwebhook', desc: 'Block unauthorized webhooks' },
  { key: 'antibot', label: 'Anti-Bot', cfgKey: 'antibot', desc: 'Control bot invites' },
  { key: 'antialt', label: 'Anti-Alt', cfgKey: 'antialt', desc: 'Block young accounts' },
  { key: 'antibadword', label: 'Anti-Bad-Word', cfgKey: 'antibadword', desc: 'Word-boundary profanity filter' },
  { key: 'logging', label: 'Logging', cfgKey: 'logs', desc: 'Per-category destinations' },
  { key: 'welcome', label: 'Welcome', cfgKey: 'welcome', desc: 'Join messages' },
  { key: 'leave', label: 'Leave', cfgKey: 'leave', desc: 'Leave messages' },
  { key: 'greetmessage', label: 'Greet Message', cfgKey: 'greetmessage', desc: 'Welcome card (image/title)' },
  { key: 'tickets', label: 'Tickets', cfgKey: 'ticket', desc: 'Support ticket system' },
  { key: 'leveling', label: 'Leveling', cfgKey: 'leveling', desc: 'XP and role rewards' },
  { key: 'voicemaster', label: 'VoiceMaster', cfgKey: 'voicemaster', desc: 'Join-to-create voice' },
  { key: 'honeypot', label: 'Honeypot', cfgKey: 'honeypot', desc: 'Trap channel' },
  { key: 'autoresponder', label: 'Auto Responder', cfgKey: 'autoresponder', desc: 'Keyword replies' },
  { key: 'autoreactor', label: 'Auto Reactor', cfgKey: 'autoreactor', desc: 'Keyword reactions' },
  { key: 'staffApplications', label: 'Applications', cfgKey: 'staffApplications', desc: 'Staff application workflow' },
  { key: 'ai', label: 'AI Assistant', cfgKey: 'ai', desc: 'Groq /ask and /templategen' }
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
  return row(new StringSelectMenuBuilder().setCustomId('setup_module').setPlaceholder('Choose a module…')
    .addOptions(SETUP_MODULES.map(m => ({ label: m.label, value: m.key, description: m.desc.slice(0, 100) }))));
}
function setupExtraRow() {
  return row(
    btn('setup:health', 'Health Check', ButtonStyle.Secondary, { emoji: '🩺' }),
    btn('setup:wizard', 'Guided Wizard', ButtonStyle.Primary, { emoji: '🧭' }),
    btn('setup:backup', 'Backup Config', ButtonStyle.Secondary, { emoji: '📦' })
  );
}

// === TICKET UI ===
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
    { value: 'general', label: 'General Support', emoji: '🎫' },
    { value: 'report', label: 'User Report', emoji: '🚨' },
    { value: 'partnership', label: 'Partnership', emoji: '🤝' },
    { value: 'other', label: 'Other', emoji: '❔' }
  ]);
  return [row(new StringSelectMenuBuilder().setCustomId('ticket:open:select').setPlaceholder('Choose a ticket type…')
    .addOptions(types.slice(0, 25).map(t => ({ label: t.label, value: t.value, emoji: t.emoji }))))];
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

// === VOICEMASTER CONTROL ===
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
  const locked = !!(ow && ow.deny.has(1n << 20n)); // Connect
  const hidden = !!(ow && ow.deny.has(1n << 10n)); // ViewChannel
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

// === ROLE PANEL EDITOR ===
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
      btn(`${prefix}:toggle:${panel.id}`, panel.enabled === false ? 'Enable' : 'Disable', panel.enabled === false ? ButtonStyle.Success : ButtonStyle.Danger),
      btn(`${prefix}:post:${panel.id}`, panel.messageId ? 'Post Again' : 'Post Panel', ButtonStyle.Success, { emoji: '📤' }),
      btn(`${prefix}:del:${panel.id}`, 'Delete', ButtonStyle.Danger, { emoji: '🗑️' })
    ),
    row(btn(`${prefix}:back`, 'Back to List', ButtonStyle.Secondary))
  ].slice(0, 5);
}
function rolePanelListEmbed(panels, mode) {
  const prefix = mode === 'button' ? 'brp' : 'rrp';
  const label = mode === 'button' ? 'Button Roles' : 'Reaction Roles';
  const fields = panels.length
    ? panels.map((p, n) => ({ name: `${n + 1}. ${p.title || 'Untitled'}`, value: `${(p.buttons || p.mappings || []).length} roles • ${p.channelId ? `<#${p.channelId}>` : 'No channel'} • ${p.enabled === false ? 'Disabled' : 'Enabled'}`, inline: false }))
    : [{ name: 'Panels', value: 'None yet. Click **New Panel** below.' }];
  return buildV2({
    title: `🎭 ${label}`,
    description: 'Create multiple self-service panels. Use the native role picker to add roles — no IDs to copy.',
    fields,
    components: [row(
      btn(`${prefix}:new`, 'New Panel', ButtonStyle.Primary, { emoji: '➕' }),
      panels.length ? btn(`${prefix}:select_first`, 'Configure First', ButtonStyle.Secondary) : null
    ).components.filter(Boolean)]
  });
}

// === LOGGING PANEL ===
const LOG_LABELS = {
  default: 'Default (fallback)', message: 'Messages', member: 'Members', mod: 'Moderation',
  voice: 'Voice', security: 'Security', ticket: 'Tickets', server: 'Server & Roles', system: 'System'
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

// === AUTORESPONDER / AUTOREACTOR ===
function autoresponderEmbed(cfg) {
  const triggers = cfg.triggers || [];
  return buildV2({
    title: '💬 Auto Responder',
    description: `Replies with a message when a keyword is matched. Placeholders: \`{user}\` \`{username}\` \`{server}\``,
    fields: [
      { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
      { name: 'Triggers', value: String(triggers.length), inline: true },
      { name: 'Case', value: cfg.ignoreCase ? 'Insensitive' : 'Sensitive', inline: true },
      ...(triggers.slice(0, 10).map((t, n) => ({ name: `${n + 1}. ${t.match}`, value: `${t.mode} → ${String(t.response || '').slice(0, 100)}`, inline: false })))
    ],
    components: [
      row(
        btn('ar:toggle', cfg.enabled ? 'Disable' : 'Enable', cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
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
      ...(triggers.slice(0, 10).map((t, n) => ({ name: `${n + 1}. ${t.match}`, value: `${t.mode} → ${(t.emojis || []).join(' ')}`, inline: false })))
    ],
    components: [
      row(
        btn('arr:toggle', cfg.enabled ? 'Disable' : 'Enable', cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        btn('arr:add', 'Add Trigger', ButtonStyle.Primary, { emoji: '➕' }),
        btn('arr:case', cfg.ignoreCase ? 'Case: Insensitive' : 'Case: Sensitive', ButtonStyle.Secondary)
      ),
      ...(triggers.length ? [row(new StringSelectMenuBuilder().setCustomId('arr:remove').setPlaceholder('Remove a trigger…')
        .addOptions(triggers.slice(0, 25).map(t => ({ label: String(t.match).slice(0, 90), value: t.id }))))] : [])
    ].slice(0, 5)
  });
}

// === HONEYPOT ===
function honeypotEmbed(cfg) {
  return buildV2({
    title: '🍯 Honeypot',
    description: 'A trap channel. Anyone who posts in it is acted on. Owner is always exempt.',
    fields: [
      { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
      { name: 'Channel', value: cfg.channelId ? `<#${cfg.channelId}>` : 'Not set', inline: true },
      { name: 'Action', value: cfg.action, inline: true },
      { name: 'Log', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Not set', inline: true }
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
        btn('honeypot:toggle', cfg.enabled ? 'Disable' : 'Enable', cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        btn('honeypot:log', 'Set Log Channel', ButtonStyle.Secondary)
      )
    ]
  });
}

// === LEVELING ===
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
        btn('leveling:toggle', cfg.enabled ? 'Disable' : 'Enable', cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        btn('leveling:rewards', 'Role Rewards', ButtonStyle.Primary, { emoji: '🎁' }),
        btn('leveling:xp', 'XP Rate', ButtonStyle.Secondary)
      )
    ]
  });
}

// === GREET MESSAGE ===
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
        btn('greetmsg:toggle', cfg.enabled ? 'Disable' : 'Enable', cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        btn('greetmsg:edit', 'Edit Message', ButtonStyle.Primary, { emoji: '✏️' }),
        btn('greetmsg:ping', cfg.ping === false ? 'Ping: Off' : 'Ping: On', ButtonStyle.Secondary),
        btn('greetmsg:test', 'Test', ButtonStyle.Secondary)
      )
    ]
  });
}

// === EMBED BUILDER PREVIEW ===
function embedBuilderPreview(draft) {
  const e = new EmbedBuilder().setColor(draft.color || BLACK).setTimestamp();
  if (draft.title) e.setTitle(String(draft.title).slice(0, 200));
  e.setDescription(String(draft.description || '*No description set — press Edit Text.*').slice(0, 4000));
  if (draft.imageUrl) e.setImage(draft.imageUrl);
  if (draft.thumbnailUrl) e.setThumbnail(draft.thumbnailUrl);
  if (draft.footer) e.setFooter({ text: String(draft.footer).slice(0, 200) });
  return { embeds: [e] };
}

module.exports = {
  BLACK, OK, WARN, DANGER, INFO, BRAND, V2_OK,
  emoji, EMOJI,
  buildV2, v2Info, v2Ok, v2Err, v2Warn,
  embed, okEmbed, errEmbed, warnEmbed, infoEmbed,
  btn, row, toggleButton, confirmRow,
  HELP_CATEGORIES, helpMenuEmbed, helpSelectRow,
  SETUP_MODULES, setupPanelEmbed, setupModuleRow, setupExtraRow,
  LOG_LABELS, logSetupEmbed,
  ticketPanelEmbed, ticketPanelRows, ticketWelcome, ticketControlRows,
  vmControlEmbed, vmControlRows,
  rolePanelEmbed, rolePanelEditRows, rolePanelListEmbed,
  autoresponderEmbed, autoreactorEmbed,
  honeypotEmbed, levelingEmbed, greetMessageEmbed,
  embedBuilderPreview
};