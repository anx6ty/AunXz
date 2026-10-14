// AunXz/commands.js — every slash command + its execute handler.
// Exported as a flat array so index.js can register and route by name.
'use strict';

const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder
} = require('discord.js');
const db = require('./database');
const sys = require('./systems');

// =============================================================================
// SHARED HELPERS
// =============================================================================
function isAdmin(interaction) {
  return interaction.member?.permissions.has(PermissionFlagsBits.Administrator) || sys.isOwner(interaction.user.id);
}
function requireAdmin(interaction) {
  if (!isAdmin(interaction)) {
    interaction.reply({ embeds: [sys.errEmbed(interaction.guildId, 'You need **Administrator**.')], ephemeral: true });
    return false;
  }
  return true;
}
function parseHexColor(input) {
  const m = String(input || '').trim().match(/^(?:#|0x)?([0-9a-f]{6})$/i);
  return m ? parseInt(m[1], 16) : null;
}
function safeReply(interaction, payload) {
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => {});
  return interaction.reply(payload).catch(() => {});
}

// =============================================================================
// CONVERSATION MEMORY for /ask
// =============================================================================
const askHistory = new Map(); // key -> [{role, content}, ...]

// =============================================================================
// COMMANDS
// =============================================================================
const commands = [];

// ---------- /ping ----------
commands.push({
  data: new SlashCommandBuilder().setName('ping').setDescription('Check bot latency.'),
  async execute(i) {
    const sent = Date.now();
    await i.reply({ embeds: [sys.infoEmbed(i.guildId, 'Pinging…')] });
    const rtt = Date.now() - sent;
    await i.editReply({ embeds: [sys.infoEmbed(i.guildId, `**WebSocket:** ${i.client.ws.ping}ms\n**Round-trip:** ${rtt}ms`)] });
  }
});

// ---------- /botinfo ----------
commands.push({
  data: new SlashCommandBuilder().setName('botinfo').setDescription('Show AunXz information.'),
  async execute(i) {
    const uptime = process.uptime();
    const e = sys.baseEmbed(i.guildId, '🤖 AunXz').addFields(
      { name: 'Guilds', value: String(i.client.guilds.cache.size), inline: true },
      { name: 'Users', value: String(i.client.users.cache.size), inline: true },
      { name: 'Uptime', value: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`, inline: true },
      { name: 'Node', value: process.version, inline: true },
      { name: 'discord.js', value: require('discord.js').version, inline: true },
      { name: 'AI', value: process.env.GROQ_API_KEY ? 'Groq (configured)' : 'Not configured', inline: true }
    );
    await i.reply({ embeds: [e] });
  }
});

// ---------- /serverinfo ----------
commands.push({
  data: new SlashCommandBuilder().setName('serverinfo').setDescription('Show server information.'),
  async execute(i) {
    const g = i.guild;
    await i.deferReply();
    // Full fetch only when the cache is incomplete and the guild is small enough that it's cheap.
    let complete = true;
    if (g.memberCount > g.members.cache.size) {
      if (g.memberCount <= 2000) {
        try { await g.members.fetch({ time: 15000 }); } catch { complete = false; }
      } else complete = false;
    }
    const members = g.members.cache;
    const humans = members.filter(m => !m.user.bot).size;
    const bots = members.filter(m => m.user.bot).size;
    const e = sys.baseEmbed(g.id, `🏠 ${g.name}`).setThumbnail(g.iconURL({ dynamic: true })).addFields(
      { name: '📊 Members', value: `**${complete ? g.memberCount : members.size}** shown\n${humans} humans • ${bots} bots${complete ? '' : '\n-# cache-based (large server)'}`, inline: true },
      { name: '💬 Channels', value: `${g.channels.cache.size} total`, inline: true },
      { name: '🎭 Roles', value: `${g.roles.cache.size - 1} custom`, inline: true },
      { name: '🚀 Boosts', value: `${g.premiumSubscriptionCount || 0} (Tier ${g.premiumTier})`, inline: true },
      { name: '👑 Owner', value: `<@${g.ownerId}>`, inline: true },
      { name: '📅 Created', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true }
    );
    await i.editReply({ embeds: [e] });
  }
});

// ---------- /userinfo ----------
commands.push({
  data: new SlashCommandBuilder().setName('userinfo').setDescription('Show user information.')
    .addUserOption(o => o.setName('user').setDescription('Target user')),
  async execute(i) {
    const user = i.options.getUser('user') || i.user;
    const member = await i.guild.members.fetch(user.id).catch(() => null);
    const e = sys.baseEmbed(i.guildId, `👤 ${user.username}`).setThumbnail(user.displayAvatarURL({ size: 256 })).addFields(
      { name: 'ID', value: user.id, inline: true },
      { name: 'Bot', value: user.bot ? 'Yes' : 'No', inline: true },
      { name: 'Account created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true }
    );
    if (member) {
      e.addFields(
        { name: 'Display name', value: member.displayName, inline: true },
        { name: 'Joined', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true },
        { name: 'Highest role', value: `<@&${member.roles.highest.id}>`, inline: true },
        { name: 'Roles', value: member.roles.cache.filter(r => r.id !== i.guildId).map(r => `<@&${r.id}>`).slice(0, 20).join(', ') || 'none' }
      );
      if (sys.isStaff(i.guildId, i.member) || isAdmin(i)) {
        const warns = db.getWarns(i.guildId, user.id).length;
        e.addFields({ name: '⚠️ Moderation', value: `Warnings: ${warns}`, inline: true });
      }
    }
    await i.reply({ embeds: [e] });
  }
});

// ---------- /avatar ----------
commands.push({
  data: new SlashCommandBuilder().setName('avatar').setDescription('Show a user avatar.')
    .addUserOption(o => o.setName('user').setDescription('Target user')),
  async execute(i) {
    const user = i.options.getUser('user') || i.user;
    const url = user.displayAvatarURL({ size: 1024 });
    await i.reply({ embeds: [sys.baseEmbed(i.guildId, `🖼️ ${user.username}`).setImage(url).setDescription(`[Open full size](${url})`)] });
  }
});

// ---------- /help ----------
const HELP_CATEGORIES = {
  setup: { name: 'Setup & Config', emoji: '⚙️', desc: '`/setup panel` — module dashboard\n`/setup wizard` — guided setup\n`/setup health` — diagnostics\n`/setup backup` — download config\n`/help` — this menu' },
  mod: { name: 'Moderation', emoji: '🔨', desc: '`/mod ban|kick|timeout|untimeout` — apply actions\n`/mod warn|warnings|clearwarnings` — warning system\n`/mod purge` — bulk delete\n`/mod history|case` — case records' },
  security: { name: 'Security', emoji: '🛡️', desc: '`/antinuke setup` — Anti-Nuke\n`/antilink setup` — link filter\n`/antispam setup` — spam filter\n`/antiraid setup` — raid protection\n`/antiwebhook|antibot|antialt setup`\n`/whitelist add|remove|list`' },
  community: { name: 'Community', emoji: '🎉', desc: '`/leveling setup` — XP & rewards\n`/rank` `/leaderboard`\n`/ticket` `/ticketpanel`\n`/giveaway create|reroll|list`\n`/stickymessage` — pinned embeds\n`/rolepanel` — self-service roles' },
  messaging: { name: 'Messages', emoji: '💬', desc: '`/greetmessage setup` — welcome\n`/welcome setup` `/leave setup`\n`/embedbuilder` — custom embeds\n`/embed` — saved embeds\n`/autoresponder setup`\n`/autoreactor setup`' },
  ai: { name: 'AI', emoji: '🤖', desc: '`/ask <question>` — assistant\n`/templategen` — AI server builder' },
  info: { name: 'Info', emoji: 'ℹ️', desc: '`/userinfo` `/serverinfo` `/botinfo`\n`/avatar` `/ping` `/snipe`' }
};
function helpHomeEmbed(client) {
  return sys.baseEmbed(null, '📖 AunXz Help')
    .setDescription('Pick a category from the menu below. All commands are available as slash commands.')
    .addFields(...Object.values(HELP_CATEGORIES).map(c => ({ name: `${c.emoji} ${c.name}`, value: c.desc.split('\n')[0], inline: false })))
    .setThumbnail(client.user.displayAvatarURL());
}
function helpSelectRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('help_select').setPlaceholder('Choose a category…')
      .addOptions(Object.entries(HELP_CATEGORIES).map(([value, c]) => ({ label: c.name, value, emoji: c.emoji })))
  );
}
commands.push({
  data: new SlashCommandBuilder().setName('help').setDescription('Browse AunXz commands.'),
  async execute(i) {
    await i.reply({ embeds: [helpHomeEmbed(i.client)], components: [helpSelectRow()] });
  }
});

// ---------- /setup ----------
const MODULES = [
  { key: 'moderation', label: 'Moderation', cfgKey: null, desc: 'Ban, kick, timeout, warnings, purge' },
  { key: 'automod', label: 'AutoMod', cfgKey: 'automod', desc: 'Caps, invites, bad-word filters' },
  { key: 'antinuke', label: 'Anti-Nuke', cfgKey: 'antinuke', desc: 'Mass-action protection' },
  { key: 'antilink', label: 'Anti-Link', cfgKey: 'antilink', desc: 'Link removal with bypass roles' },
  { key: 'antispam', label: 'Anti-Spam', cfgKey: 'antispam', desc: 'Message/mention/emoji flood' },
  { key: 'antiraid', label: 'Anti-Raid', cfgKey: 'antiraid', desc: 'Join-rate lockdown' },
  { key: 'antiwebhook', label: 'Anti-Webhook', cfgKey: 'antiwebhook', desc: 'Block unauthorized webhooks' },
  { key: 'antibot', label: 'Anti-Bot', cfgKey: 'antibot', desc: 'Control bot invites' },
  { key: 'antialt', label: 'Anti-Alt', cfgKey: 'antialt', desc: 'Block young accounts' },
  { key: 'logging', label: 'Logging', cfgKey: 'logs', desc: 'Per-category destinations' },
  { key: 'welcome', label: 'Welcome & Leave', cfgKey: 'welcome', desc: 'Join/leave messages' },
  { key: 'tickets', label: 'Tickets', cfgKey: 'ticket', desc: 'Support ticket system' },
  { key: 'leveling', label: 'Leveling', cfgKey: 'leveling', desc: 'XP and role rewards' },
  { key: 'roles', label: 'Role Panels', cfgKey: null, desc: 'Button and reaction roles' },
  { key: 'applications', label: 'Applications', cfgKey: 'staffApplications', desc: 'Staff application workflow' },
  { key: 'giveaways', label: 'Giveaways', cfgKey: null, desc: 'Prize draws' },
  { key: 'community', label: 'Community', cfgKey: null, desc: 'Sticky, responders, birthdays' },
  { key: 'voicemaster', label: 'VoiceMaster', cfgKey: 'voicemaster', desc: 'Join-to-create voice channels' },
  { key: 'ai', label: 'AI Assistant', cfgKey: 'ai', desc: 'Groq-powered /ask and /templategen' }
];

function setupPanelEmbed(guildId) {
  const cfg = db.getConfig(guildId);
  const fields = MODULES.map(m => {
    let status = '⚪';
    if (m.cfgKey) {
      const mod = m.cfgKey.split('.').reduce((a, k) => a?.[k], cfg);
      if (typeof mod === 'boolean') status = mod ? '🟢' : '⚪';
      else if (mod?.enabled) status = '🟢';
    } else if (m.key === 'logging') {
      status = Object.values(cfg.logs || {}).some(v => v) ? '🟢' : '⚪';
    }
    return { name: `${status} ${m.label}`, value: m.desc, inline: true };
  });
  return sys.baseEmbed(guildId, '⚙️ AunXz Setup Center').setDescription('Select a module below to configure it. All settings are per-server.').addFields(fields);
}
function setupPanelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('setup_module').setPlaceholder('Choose a module…')
        .addOptions(MODULES.map(m => ({ label: m.label, value: m.key, description: m.desc.slice(0, 100) })))
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('setup:health').setLabel('Health Check').setStyle(ButtonStyle.Secondary).setEmoji('🩺'),
      new ButtonBuilder().setCustomId('setup:wizard').setLabel('Guided Wizard').setStyle(ButtonStyle.Primary).setEmoji('🧭'),
      new ButtonBuilder().setCustomId('setup:backup').setLabel('Backup').setStyle(ButtonStyle.Secondary).setEmoji('📦')
    )
  ];
}

commands.push({
  data: new SlashCommandBuilder().setName('setup').setDescription('Open AunXz configuration.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('panel').setDescription('Module dashboard'))
    .addSubcommand(s => s.setName('wizard').setDescription('Guided setup wizard'))
    .addSubcommand(s => s.setName('health').setDescription('Run diagnostics'))
    .addSubcommand(s => s.setName('backup').setDescription('Export configuration'))
    .addSubcommand(s => s.setName('restore').setDescription('Restore from backup')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const sub = i.options.getSubcommand();
    if (sub === 'panel') return i.reply({ embeds: [setupPanelEmbed(i.guildId)], components: setupPanelRows(), ephemeral: true });
    if (sub === 'wizard') return i.reply({ embeds: [wizardStartEmbed(i.guildId)], components: [wizardModuleRow()], ephemeral: true });
    if (sub === 'health') {
      await i.deferReply({ ephemeral: true });
      const issues = await sys.healthCheck(i.guild);
      const e = sys.embed(i.guildId, issues.some(x => x.severity === 'high') ? 'warning' : issues.length ? 'info' : 'success', {
        title: '🩺 Health Check',
        description: issues.length
          ? issues.map(x => `${x.severity === 'high' ? '🔴' : x.severity === 'medium' ? '🟡' : '🟢'} ${x.text}`).join('\n')
          : 'All checks passed. No issues detected.'
      });
      return i.editReply({ embeds: [e] });
    }
    if (sub === 'backup') {
      const data = db.exportGuild(i.guildId);
      const buf = Buffer.from(JSON.stringify(data, null, 2));
      return i.reply({
        content: 'Configuration export attached (excludes secrets).',
        files: [{ attachment: buf, name: `aunxz-${i.guildId}.json` }],
        ephemeral: true
      });
    }
    if (sub === 'restore') {
      const modal = new ModalBuilder().setCustomId('setup:restore').setTitle('Restore Configuration');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('payload').setLabel('Paste the export JSON').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)
      ));
      return i.showModal(modal);
    }
  }
});

function wizardStartEmbed(guildId) {
  return sys.baseEmbed(guildId, '🧭 Guided Setup')
    .setDescription('Step 1 of 3 — Choose which modules to enable. Nothing is saved until you confirm at the end.\n\nRecommended: AutoMod, Anti-Nuke, Logging, Welcome.');
}
function wizardModuleRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('wizard:modules').setPlaceholder('Choose modules (multi-select)').setMinValues(1).setMaxValues(15)
      .addOptions(MODULES.filter(m => m.cfgKey).map(m => ({ label: m.label, value: m.key, description: m.desc.slice(0, 100) })))
  );
}

// ---------- /ask ----------
commands.push({
  data: new SlashCommandBuilder().setName('ask').setDescription('Ask the AunXz AI assistant.')
    .addStringOption(o => o.setName('question').setDescription('Your question').setRequired(true).setMaxLength(1500))
    .addBooleanOption(o => o.setName('clear').setDescription('Reset your conversation memory')),
  async execute(i) {
    if (!process.env.GROQ_API_KEY) return i.reply({ embeds: [sys.errEmbed(i.guildId, 'Groq is not configured. Set `GROQ_API_KEY` in your environment.')], ephemeral: true });
    const question = i.options.getString('question', true).trim();
    const clear = i.options.getBoolean('clear');
    const key = `${i.guildId || 'dm'}:${i.user.id}`;
    if (clear) askHistory.delete(key);

    await i.deferReply();
    const history = askHistory.get(key) || [];
    const commandList = commands.map(c => `/${c.data.name}`).join(', ');
    const cfg = i.guildId ? db.getConfig(i.guildId) : {};
    const prefix = cfg.prefix || '!';
    const sysPrompt = `You are AunXz's assistant. Answer concisely and factually.
Commands available: ${commandList}.
Guild prefix: ${prefix}.
Only reference the commands listed above. Never invent commands or claim to have performed actions.
If a capability is not in the list, say you cannot verify it.`;
    const messages = [
      { role: 'system', content: sysPrompt },
      ...history.slice(-6),
      { role: 'user', content: question }
    ];
    try {
      const result = await sys.groqChat(messages, { maxTokens: 700, temperature: 0.3 });
      askHistory.set(key, [...history, { role: 'user', content: question }, { role: 'assistant', content: result.content }].slice(-8));
      const e = sys.embed(i.guildId, 'info', { title: '🤖 AunXz Assistant', description: result.content.slice(0, 4000) })
        .setFooter({ text: `Groq • ${result.model}` });
      await i.editReply({ embeds: [e] });
    } catch (err) {
      const msg = {
        ai_missing_key: 'Groq is not configured.',
        ai_auth: 'Groq rejected the API credentials.',
        ai_model: 'The configured model was not found.',
        ai_rate_limited: 'Groq rate-limited the request. Try again shortly.',
        ai_timeout: 'Groq took too long to respond.',
        ai_validation: 'The request was rejected by Groq.'
      }[err.code] || 'The AI is unavailable right now.';
      await i.editReply({ embeds: [sys.errEmbed(i.guildId, msg)] });
    }
  }
});

// ---------- /templategen ----------
commands.push({
  data: new SlashCommandBuilder().setName('templategen').setDescription('Generate a server template with AI.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(i) {
    if (!requireAdmin(i)) return;
    if (!process.env.GROQ_API_KEY) return i.reply({ embeds: [sys.errEmbed(i.guildId, 'Groq is not configured.')], ephemeral: true });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tgen:type:gaming').setLabel('Gaming').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('tgen:type:community').setLabel('Community').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('tgen:type:creator').setLabel('Creator').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('tgen:type:support').setLabel('Support').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('tgen:type:other').setLabel('Other…').setStyle(ButtonStyle.Secondary)
    );
    await i.reply({ embeds: [sys.baseEmbed(i.guildId, '🧩 Template Generator').setDescription('Step 1: Choose the server type.')], components: [row], ephemeral: true });
  }
});

// ---------- /snipe ----------
commands.push({
  data: new SlashCommandBuilder().setName('snipe').setDescription('Show recent deleted/edited messages.')
    .addChannelOption(o => o.setName('channel').setDescription('Channel (default: this one)')),
  async execute(i) {
    const channel = i.options.getChannel('channel') || i.channel;
    const records = snipeStore.get(`${i.guildId}:${channel.id}`) || [];
    if (!records.length) return i.reply({ embeds: [sys.infoEmbed(i.guildId, `No deleted/edited messages cached for ${channel}.`)], ephemeral: true });
    const e = sys.snipeEmbed(i.guildId, records[0], 0, records.length, i.user.tag);
    const row = sys.snipeComponents(i.guildId, channel.id, 0, records.length);
    await i.reply({ embeds: [e], components: row, ephemeral: true });
  }
});
// In-memory snipe store — populated by index.js messageDelete/messageUpdate handlers.
const snipeStore = new Map();
function recordSnipe(guildId, channelId, entry) {
  const key = `${guildId}:${channelId}`;
  const arr = snipeStore.get(key) || [];
  arr.unshift({ ...entry, timestamp: Date.now() });
  if (arr.length > 50) arr.length = 50;
  snipeStore.set(key, arr);
}

// ---------- /mod ----------
const modActionMap = {
  ban: { action: 'ban', target: 'user' },
  unban: { action: 'unban' },
  kick: { action: 'kick', target: 'user' },
  timeout: { action: 'timeout', target: 'user', duration: 'minutes' },
  untimeout: { action: 'untimeout', target: 'user' },
  warn: { action: 'warn', target: 'user' }
};
commands.push({
  data: new SlashCommandBuilder().setName('mod').setDescription('Moderation commands.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand(s => s.setName('ban').setDescription('Ban a user')
      .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason')))
    .addSubcommand(s => s.setName('unban').setDescription('Unban by ID')
      .addStringOption(o => o.setName('user_id').setDescription('User ID').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason')))
    .addSubcommand(s => s.setName('kick').setDescription('Kick a user')
      .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason')))
    .addSubcommand(s => s.setName('timeout').setDescription('Timeout a user')
      .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true))
      .addIntegerOption(o => o.setName('minutes').setDescription('Minutes (1-40320)').setRequired(true).setMinValue(1).setMaxValue(40320))
      .addStringOption(o => o.setName('reason').setDescription('Reason')))
    .addSubcommand(s => s.setName('untimeout').setDescription('Remove a timeout')
      .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)))
    .addSubcommand(s => s.setName('warn').setDescription('Warn a user')
      .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(s => s.setName('warnings').setDescription('View warnings')
      .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)))
    .addSubcommand(s => s.setName('clearwarnings').setDescription('Clear warnings')
      .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)))
    .addSubcommand(s => s.setName('purge').setDescription('Bulk delete messages')
      .addIntegerOption(o => o.setName('count').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100))
      .addUserOption(o => o.setName('user').setDescription('Filter by user')))
    .addSubcommand(s => s.setName('history').setDescription('Case history for a user')
      .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true))),
  async execute(i) {
    const sub = i.options.getSubcommand();
    const g = i.guild;

    if (sub === 'warnings' || sub === 'history') {
      const user = i.options.getUser('user', true);
      if (sub === 'warnings') {
        const warns = db.getWarns(g.id, user.id);
        if (!warns.length) return i.reply({ embeds: [sys.infoEmbed(g.id, `${user.tag} has no warnings.`)], ephemeral: true });
        return i.reply({ embeds: [sys.embed(g.id, 'warning', {
          title: `Warnings — ${user.tag}`,
          description: warns.slice(0, 20).map((w, n) => `**${n + 1}.** ${w.reason} — <@${w.moderatorId}> <t:${Math.floor(w.timestamp / 1000)}:R>`).join('\n')
        })], ephemeral: true });
      }
      const warns = db.getWarns(g.id, user.id);
      return i.reply({ embeds: [sys.embed(g.id, 'info', {
        title: `Case History — ${user.tag}`,
        description: warns.length ? warns.slice(0, 20).map(w => `• warn — ${w.reason} — <t:${Math.floor(w.timestamp / 1000)}:R>`).join('\n') : 'No cases on record.'
      })], ephemeral: true });
    }

    if (sub === 'clearwarnings') {
      const user = i.options.getUser('user', true);
      db.clearWarns(g.id, user.id);
      return i.reply({ embeds: [sys.okEmbed(g.id, `Cleared warnings for ${user.tag}.`)] });
    }

    if (sub === 'purge') {
      const count = i.options.getInteger('count', true);
      const filterUser = i.options.getUser('user');
      if (!i.channel.isTextBased() || !i.channel.bulkDelete) return i.reply({ embeds: [sys.errEmbed(g.id, 'This channel does not support bulk delete.')], ephemeral: true });
      await i.deferReply({ ephemeral: true });
      const messages = await i.channel.messages.fetch({ limit: Math.min(count, 100) });
      const toDelete = filterUser ? messages.filter(m => m.author.id === filterUser.id) : messages;
      const deleted = await i.channel.bulkDelete(toDelete, true).catch(() => null);
      if (!deleted) return i.editReply({ embeds: [sys.errEmbed(g.id, 'Bulk delete failed.')] });
      return i.editReply({ embeds: [sys.okEmbed(g.id, `Deleted ${deleted.size} message(s).`)] });
    }

    // Actual moderation actions
    await i.deferReply({ ephemeral: true });
    const user = i.options.getUser('user') || { id: i.options.getString('user_id') };
    const target = await g.members.fetch(user.id).catch(() => null);
    const reason = i.options.getString('reason') || `${i.user.tag}`;

    if (!target && sub !== 'unban') return i.editReply({ embeds: [sys.errEmbed(g.id, 'User not found in this server.')] });

    const cfg = modActionMap[sub];
    if (!cfg) return i.editReply({ embeds: [sys.errEmbed(g.id, 'Unknown subcommand.')] });

    const opts = {
      guild: g, moderator: i.member,
      target: sub === 'unban' ? { id: user.id } : target,
      reason,
      durationMs: sub === 'timeout' ? i.options.getInteger('minutes', true) * 60000 : undefined
    };
    try {
      await sys.moderate(cfg.action, opts);
      await i.editReply({ embeds: [sys.okEmbed(g.id, `${sub} applied to ${user.tag || user.id}.`)] });
    } catch (e) {
      await i.editReply({ embeds: [sys.errEmbed(g.id, String(e.message || e))] });
    }
  }
});

// ---------- /whitelist ----------
commands.push({
  data: new SlashCommandBuilder().setName('whitelist').setDescription('Manage Anti-Nuke exemptions.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('add').setDescription('Exempt a user').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove exemption').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('List exempt users')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
      const ids = db.listWhitelist(i.guildId);
      return i.reply({ embeds: [sys.baseEmbed(i.guildId, '🛡️ Anti-Nuke Whitelist').setDescription(ids.length ? ids.map((id, n) => `${n + 1}. <@${id}>`).join('\n') : 'No exempt users.')], ephemeral: true });
    }
    const user = i.options.getUser('user', true);
    if (sub === 'add') { db.addToWhitelist(i.guildId, user.id); return i.reply({ embeds: [sys.okEmbed(i.guildId, `${user} added to the whitelist.`)] }); }
    db.removeFromWhitelist(i.guildId, user.id);
    return i.reply({ embeds: [sys.okEmbed(i.guildId, `${user} removed from the whitelist.`)] });
  }
});

// ---------- /antinuke /antilink /antispam /antiraid /antiwebhook /antibot /antialt ----------
function securitySetupCommand(name, cfgKey, description) {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription(description)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand(s => s.setName('setup').setDescription('Open the config panel')
        .addStringOption(o => o.setName('state').setDescription('enable or disable').addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }))),
    async execute(i) {
      if (!requireAdmin(i)) return;
      const state = i.options.getString('state');
      if (state) db.saveConfig(i.guildId, { [cfgKey]: { enabled: state === 'enable' } });
      const cfg = db.getConfig(i.guildId);
      const mod = cfg[cfgKey];
      const fields = Object.entries(mod).filter(([k]) => k !== 'enabled').map(([k, v]) => ({
        name: k,
        value: v === null || v === undefined ? '—' : Array.isArray(v) ? (v.length ? v.join(', ') : '—') : typeof v === 'object' ? '`' + JSON.stringify(v) + '`' : String(v).slice(0, 200),
        inline: true
      }));
      const e = sys.baseEmbed(i.guildId, `🛡️ ${name} — Setup`)
        .setDescription(`**Status:** ${mod.enabled ? '🟢 Enabled' : '⚪ Disabled'}`)
        .addFields(fields.slice(0, 25));
      await i.reply({ embeds: [e], ephemeral: true });
      sys.refreshAutomod(i.guildId);
    }
  };
}
commands.push(securitySetupCommand('antinuke', 'antinuke', 'Configure Anti-Nuke protection.'));
commands.push(securitySetupCommand('antilink', 'antilink', 'Configure Anti-Link.'));
commands.push(securitySetupCommand('antispam', 'antispam', 'Configure Anti-Spam.'));
commands.push(securitySetupCommand('antiraid', 'antiraid', 'Configure Anti-Raid.'));
commands.push(securitySetupCommand('antiwebhook', 'antiwebhook', 'Configure Anti-Webhook.'));
commands.push(securitySetupCommand('antibot', 'antibot', 'Configure Anti-Bot.'));
commands.push(securitySetupCommand('antialt', 'antialt', 'Configure Anti-Alt.'));

// ---------- /automod ----------
commands.push({
  data: new SlashCommandBuilder().setName('automod').setDescription('Configure AutoMod filters.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open the AutoMod panel')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).automod;
    const e = sys.baseEmbed(i.guildId, '🛡️ AutoMod')
      .setDescription(`**Status:** ${cfg.enabled ? '🟢 Enabled' : '⚪ Disabled'}\n**Caps filter:** ${cfg.capsFilter ? `${cfg.capsThreshold}%` : 'Off'}\n**Invite filter:** ${cfg.inviteFilter ? 'On' : 'Off'}\n**Bad words:** ${(cfg.badWords || []).length}`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('automod:toggle').setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('automod:caps').setLabel('Caps Filter').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('automod:invite').setLabel('Invite Filter').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('automod:words').setLabel('Bad Words').setStyle(ButtonStyle.Secondary)
    );
    await i.reply({ embeds: [e], components: [row], ephemeral: true });
  }
});

// ---------- /antibadwordsetup ----------
commands.push({
  data: new SlashCommandBuilder().setName('antibadwordsetup').setDescription('Configure the bad-word filter.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).antibadword;
    const e = sys.baseEmbed(i.guildId, '🚫 Anti Bad Word')
      .setDescription(`**Status:** ${cfg.enabled ? '🟢 Enabled' : '⚪ Disabled'}\n**Action:** ${cfg.action}\n**Words:** ${(cfg.words || []).length + (cfg.customWords || []).length}`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('badword:toggle').setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('badword:words').setLabel('Edit Words').setStyle(ButtonStyle.Primary)
    );
    await i.reply({ embeds: [e], components: [row], ephemeral: true });
    sys.refreshAutomod(i.guildId);
  }
});

// ---------- /greetmessage ----------
commands.push({
  data: new SlashCommandBuilder().setName('greetmessage').setDescription('Configure the welcome message.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open setup panel')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).greetmessage;
    const e = sys.baseEmbed(i.guildId, '👋 Greet Message')
      .setDescription(`**Status:** ${cfg.enabled ? '🟢 Enabled' : '⚪ Disabled'}\n**Channel:** ${cfg.channelId ? `<#${cfg.channelId}>` : 'Not set'}\n**Message:** ${String(cfg.message || '').slice(0, 500)}\n\nPlaceholders: \`{user}\` \`{server}\` \`{count}\``);
    const row = new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId('greetmsg:channel').setPlaceholder('Welcome channel').setChannelTypes(ChannelType.GuildText),
      new ButtonBuilder().setCustomId('greetmsg:toggle').setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('greetmsg:edit').setLabel('Edit Message').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('greetmsg:test').setLabel('Test').setStyle(ButtonStyle.Secondary)
    );
    await i.reply({ embeds: [e], components: [row], ephemeral: true });
  }
});

// ---------- /welcome /leave ----------
function simpleSetup(name, cfgKey, description) {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription(description)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand(s => s.setName('setup').setDescription('Configure')),
    async execute(i) {
      if (!requireAdmin(i)) return;
      const cfg = db.getConfig(i.guildId)[cfgKey];
      const e = sys.baseEmbed(i.guildId, `${name === 'welcome' ? '👋 Welcome' : '🚪 Leave'} — Setup`)
        .setDescription(`**Status:** ${cfg.enabled ? '🟢 Enabled' : '⚪ Disabled'}\n**Channel:** ${cfg.channel ? `<#${cfg.channel}>` : 'Not set'}\n**Message:** ${String(cfg.message || '').slice(0, 500)}`);
      const row = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder().setCustomId(`${name}:channel`).setPlaceholder('Select channel').setChannelTypes(ChannelType.GuildText),
        new ButtonBuilder().setCustomId(`${name}:toggle`).setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${name}:edit`).setLabel('Edit Message').setStyle(ButtonStyle.Primary)
      );
      await i.reply({ embeds: [e], components: [row], ephemeral: true });
    }
  };
}
commands.push(simpleSetup('welcome', 'welcome', 'Configure welcome messages.'));
commands.push(simpleSetup('leave', 'leave', 'Configure leave messages.'));

// ---------- /tickets ----------
commands.push({
  data: new SlashCommandBuilder().setName('tickets').setDescription('Configure the ticket system.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open ticket configuration')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).ticket;
    const e = sys.baseEmbed(i.guildId, '🎫 Ticket System')
      .setDescription(`**Status:** ${cfg.enabled ? '🟢 Enabled' : '⚪ Disabled'}\n**Category:** ${cfg.categoryId ? `<#${cfg.categoryId}>` : 'Not set'}\n**Support role:** ${cfg.supportRoleId ? `<@&${cfg.supportRoleId}>` : 'Not set'}\n**Log channel:** ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Not set'}`);
    const row1 = new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId('ticket:category').setPlaceholder('Ticket category').setChannelTypes(ChannelType.GuildCategory),
      new ChannelSelectMenuBuilder().setCustomId('ticket:log').setPlaceholder('Log channel').setChannelTypes(ChannelType.GuildText)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder().setCustomId('ticket:support').setPlaceholder('Support role'),
      new ButtonBuilder().setCustomId('ticket:toggle').setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ticket:post').setLabel('Post Panel').setStyle(ButtonStyle.Success).setEmoji('🎫')
    );
    await i.reply({ embeds: [e], components: [row1, row2], ephemeral: true });
  }
});

// ---------- /ticketpanel ----------
commands.push({
  data: new SlashCommandBuilder().setName('ticketpanel').setDescription('Post the ticket panel here.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).ticket;
    if (!cfg.enabled) return i.reply({ embeds: [sys.errEmbed(i.guildId, 'Enable tickets first with `/tickets setup`.')], ephemeral: true });
    await i.channel.send({ embeds: [sys.ticketPanelEmbed(i.guildId, cfg)], components: [sys.ticketPanelRow()] });
    await i.reply({ embeds: [sys.okEmbed(i.guildId, 'Ticket panel posted.')], ephemeral: true });
  }
});

// ---------- /leveling ----------
commands.push({
  data: new SlashCommandBuilder().setName('leveling').setDescription('Configure XP and leveling.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open the leveling panel')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).leveling;
    const e = sys.baseEmbed(i.guildId, '📈 Leveling')
      .setDescription(`**Status:** ${cfg.enabled ? '🟢 Enabled' : '⚪ Disabled'}\n**XP per message:** ${cfg.xpPerMessage}\n**Cooldown:** ${cfg.cooldownSeconds}s\n**Announcement channel:** ${cfg.channel ? `<#${cfg.channel}>` : 'Current channel'}\n**Role rewards:** ${Object.keys(cfg.roleRewards || {}).length}`);
    const row = new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId('leveling:channel').setPlaceholder('Announcement channel').setChannelTypes(ChannelType.GuildText),
      new ButtonBuilder().setCustomId('leveling:toggle').setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('leveling:rewards').setLabel('Role Rewards').setStyle(ButtonStyle.Primary)
    );
    await i.reply({ embeds: [e], components: [row], ephemeral: true });
  }
});

// ---------- /rank ----------
commands.push({
  data: new SlashCommandBuilder().setName('rank').setDescription('View a rank card.')
    .addUserOption(o => o.setName('user').setDescription('Target user')),
  async execute(i) {
    const user = i.options.getUser('user') || i.user;
    const rec = db.getLevel(i.guildId, user.id);
    const info = sys.levelFromXp(rec.xp);
    const e = sys.baseEmbed(i.guildId, `📈 ${user.username}'s Rank`).setThumbnail(user.displayAvatarURL())
      .setDescription(`**Level:** ${info.level}\n**XP:** ${info.remaining} / ${info.next}\n**Total XP:** ${rec.xp}`);
    await i.reply({ embeds: [e] });
  }
});

// ---------- /leaderboard ----------
commands.push({
  data: new SlashCommandBuilder().setName('leaderboard').setDescription('Top XP in this server.'),
  async execute(i) {
    const rows = db.topLevels(i.guildId, 25);
    if (!rows.length) return i.reply({ embeds: [sys.infoEmbed(i.guildId, 'No XP recorded yet.')] });
    const e = sys.baseEmbed(i.guildId, `🏆 ${i.guild.name} Leaderboard`)
      .setDescription(rows.map((r, n) => `**${n + 1}.** <@${r.userId}> — Level ${r.level} • ${r.xp.toLocaleString()} XP`).join('\n'));
    await i.reply({ embeds: [e] });
  }
});

// ---------- /xp ----------
commands.push({
  data: new SlashCommandBuilder().setName('xp').setDescription('Manage a member\'s XP.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand(s => s.setName('add').setDescription('Add XP')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('XP').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove XP')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('XP').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('set').setDescription('Set XP')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('Total XP').setRequired(true).setMinValue(0)))
    .addSubcommand(s => s.setName('reset').setDescription('Reset XP')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))),
  async execute(i) {
    const sub = i.options.getSubcommand();
    const user = i.options.getUser('user', true);
    const rec = db.getLevel(i.guildId, user.id);
    let xp = rec.xp;
    if (sub === 'add') xp += i.options.getInteger('amount');
    else if (sub === 'remove') xp = Math.max(0, xp - i.options.getInteger('amount'));
    else if (sub === 'set') xp = i.options.getInteger('amount');
    else if (sub === 'reset') xp = 0;
    const { level } = sys.levelFromXp(xp);
    db.setLevel(i.guildId, user.id, xp, level, rec.lastMessage);
    await i.reply({ embeds: [sys.okEmbed(i.guildId, `${user.tag} — Level ${level}, ${xp} XP`)] });
  }
});

// ---------- /embed ----------
commands.push({
  data: new SlashCommandBuilder().setName('embed').setDescription('Manage saved embeds.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand(s => s.setName('create').setDescription('Create a saved embed')
      .addStringOption(o => o.setName('name').setDescription('Name').setRequired(true))
      .addStringOption(o => o.setName('title').setDescription('Title'))
      .addStringOption(o => o.setName('description').setDescription('Description'))
      .addStringOption(o => o.setName('color').setDescription('Hex color e.g. #8b5cf6')))
    .addSubcommand(s => s.setName('send').setDescription('Send a saved embed')
      .addStringOption(o => o.setName('name').setDescription('Name').setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Destination (defaults to current channel)')))
    .addSubcommand(s => s.setName('list').setDescription('List saved embeds'))
    .addSubcommand(s => s.setName('delete').setDescription('Delete a saved embed')
      .addStringOption(o => o.setName('name').setDescription('Name').setRequired(true))),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const sub = i.options.getSubcommand();
    if (sub === 'create') {
      const name = i.options.getString('name', true).trim();
      const title = i.options.getString('title');
      const description = i.options.getString('description');
      const colorRaw = i.options.getString('color');
      let color;
      if (colorRaw) { color = parseHexColor(colorRaw); if (color === null) return i.reply({ embeds: [sys.errEmbed(i.guildId, 'Color must be a hex code like `#8b5cf6`.')], ephemeral: true }); }
      if (!title && !description) return i.reply({ embeds: [sys.errEmbed(i.guildId, 'Provide at least a title or description.')], ephemeral: true });
      db.saveEmbed(i.guildId, name, { title, description, color });
      return i.reply({ embeds: [sys.okEmbed(i.guildId, `Saved embed **${name}**.`)], ephemeral: true });
    }
    if (sub === 'send') {
      const name = i.options.getString('name', true);
      const payload = db.getEmbed(i.guildId, name);
      if (!payload) return i.reply({ embeds: [sys.errEmbed(i.guildId, 'Embed not found.')], ephemeral: true });
      const ch = i.options.getChannel('channel') || i.channel;
      if (!ch?.isTextBased()) return i.reply({ embeds: [sys.errEmbed(i.guildId, 'Invalid destination channel.')], ephemeral: true });
      const e = new EmbedBuilder();
      const d = payload.data;
      if (d.title) e.setTitle(d.title);
      if (d.description) e.setDescription(d.description);
      if (typeof d.color === 'number') e.setColor(d.color);
      e.setTimestamp();
      await ch.send({ embeds: [e] }).catch(() => {});
      return i.reply({ embeds: [sys.okEmbed(i.guildId, `Sent **${name}** to <#${ch.id}>.`)], ephemeral: true });
    }
    if (sub === 'list') {
      const list = db.listEmbeds(i.guildId);
      return i.reply({ embeds: [sys.baseEmbed(i.guildId, 'Saved Embeds').setDescription(list.length ? list.map(e => `• \`${e.name}\` — <t:${Math.floor(e.updatedAt / 1000)}:R>`).join('\n') : 'None saved yet.')], ephemeral: true });
    }
    if (sub === 'delete') {
      const name = i.options.getString('name', true);
      const removed = db.deleteEmbed(i.guildId, name);
      return i.reply({ embeds: [removed ? sys.okEmbed(i.guildId, `Deleted **${name}**.`) : sys.errEmbed(i.guildId, 'Not found.')], ephemeral: true });
    }
  }
});

// ---------- /embedbuilder ----------
commands.push({
  data: new SlashCommandBuilder().setName('embedbuilder').setDescription('Build and post a custom embed.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const modal = new ModalBuilder().setCustomId('eb:build').setTitle('Embed Builder');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(3000)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Color (hex, optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(7)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channel').setLabel('Channel ID or #mention').setStyle(TextInputStyle.Short).setRequired(true))
    );
    await i.showModal(modal);
  }
});

// ---------- /giveaway ----------
commands.push({
  data: new SlashCommandBuilder().setName('giveaway').setDescription('Manage giveaways.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents)
    .addSubcommand(s => s.setName('start').setDescription('Start a giveaway')
      .addStringOption(o => o.setName('prize').setDescription('Prize').setRequired(true).setMaxLength(200))
      .addIntegerOption(o => o.setName('minutes').setDescription('Duration (minutes)').setRequired(true).setMinValue(1).setMaxValue(43200))
      .addIntegerOption(o => o.setName('winners').setDescription('Number of winners').setMinValue(1).setMaxValue(20))
      .addChannelOption(o => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s.setName('end').setDescription('End a giveaway early')
      .addIntegerOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('reroll').setDescription('Reroll winners')
      .addIntegerOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true).setMinValue(1))
      .addIntegerOption(o => o.setName('winners').setDescription('Count').setMinValue(1).setMaxValue(20)))
    .addSubcommand(s => s.setName('list').setDescription('List giveaways')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const sub = i.options.getSubcommand();

    if (sub === 'start') {
      const prize = i.options.getString('prize', true);
      const minutes = i.options.getInteger('minutes', true);
      const winners = i.options.getInteger('winners') ?? 1;
      const ch = i.options.getChannel('channel') || i.channel;
      if (!ch?.isTextBased()) return i.reply({ embeds: [sys.errEmbed(i.guildId, 'Invalid channel.')], ephemeral: true });
      await i.deferReply({ ephemeral: true });

      const g = db.createGiveaway(i.guildId, i.user.id, { prize, winners, durationMs: minutes * 60000, channelId: ch.id });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`giveaway:enter:${g.id}`).setLabel('Enter').setEmoji('🎉').setStyle(ButtonStyle.Primary)
      );
      const e = sys.baseEmbed(i.guildId, '🎉 Giveaway!').setDescription(`**Prize:** ${prize}\n**Winners:** ${winners}\n**Ends:** <t:${Math.floor(g.endsAt / 1000)}:R>\n\nClick the button to enter.`);
      const msg = await ch.send({ embeds: [e], components: [row] }).catch(() => null);
      if (!msg) return i.editReply({ embeds: [sys.errEmbed(i.guildId, 'Could not post the giveaway message.')] });
      db.updateGiveaway(i.guildId, g.id, { messageId: msg.id, status: 'active' });
      return i.editReply({ embeds: [sys.okEmbed(i.guildId, `Giveaway started in <#${ch.id}>.`) ] });
    }
    if (sub === 'end') {
      const id = i.options.getInteger('id', true);
      const winners = await sys.endGiveaway(i.client, i.guildId, id);
      if (winners === null) return i.reply({ embeds: [sys.errEmbed(i.guildId, 'Giveaway not found or already ended.')], ephemeral: true });
      return i.reply({ embeds: [sys.okEmbed(i.guildId, `Giveaway ended. ${winners.length} winner(s) picked.`)] });
    }
    if (sub === 'reroll') {
      const id = i.options.getInteger('id', true);
      const g = db.getGiveaway(i.guildId, id);
      if (!g) return i.reply({ embeds: [sys.errEmbed(i.guildId, 'Giveaway not found.')], ephemeral: true });
      let participants = [];
      try { participants = JSON.parse(g.participants || '[]'); } catch {}
      if (!participants.length) return i.reply({ embeds: [sys.errEmbed(i.guildId, 'No entries.')], ephemeral: true });
      const count = Math.min(i.options.getInteger('winners') || g.winners, participants.length);
      const pool = [...participants];
      const winners = [];
      while (winners.length < count && pool.length) winners.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      db.updateGiveaway(i.guildId, g.id, { winnerIds: JSON.stringify(winners) });
      const ch = g.channelId ? i.guild.channels.cache.get(g.channelId) : null;
      if (ch?.isTextBased()) ch.send({ content: `🎉 Reroll winners for **${g.prize}**: ${winners.map(w => `<@${w}>`).join(', ')}` }).catch(() => {});
      return i.reply({ embeds: [sys.okEmbed(i.guildId, `New winners: ${winners.map(w => `<@${w}>`).join(', ')}`)] });
    }
    if (sub === 'list') {
      const rows = db.listGiveaways(i.guildId, 25);
      return i.reply({ embeds: [sys.baseEmbed(i.guildId, '🎉 Giveaways').setDescription(rows.length ? rows.map(g => {
        let n = 0; try { n = JSON.parse(g.participants || '[]').length; } catch {}
        return `**#${g.id}** ${g.status === 'active' ? '🟢' : g.status === 'ended' ? '🏁' : '⚪'} ${g.prize} — ${g.status} • ${n} entries`;
      }).join('\n') : 'No giveaways yet.')], ephemeral: true });
    }
  }
});

// ---------- /stickymessage ----------
commands.push({
  data: new SlashCommandBuilder().setName('stickymessage').setDescription('Manage a sticky embed in a channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand(s => s.setName('set').setDescription('Create or edit the sticky in this channel')
      .addStringOption(o => o.setName('title').setDescription('Title').setRequired(true).setMaxLength(200))
      .addStringOption(o => o.setName('description').setDescription('Body text').setRequired(true).setMaxLength(3000))
      .addStringOption(o => o.setName('color').setDescription('Hex color')))
    .addSubcommand(s => s.setName('remove').setDescription('Remove the sticky in this channel'))
    .addSubcommand(s => s.setName('toggle').setDescription('Enable or disable the sticky in this channel'))
    .addSubcommand(s => s.setName('list').setDescription('List stickies in this server')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const sub = i.options.getSubcommand();
    if (sub === 'set') {
      const title = i.options.getString('title', true);
      const description = i.options.getString('description', true);
      const colorRaw = i.options.getString('color');
      let color;
      if (colorRaw) { color = parseHexColor(colorRaw); if (color === null) return i.reply({ embeds: [sys.errEmbed(i.guildId, 'Invalid color.')], ephemeral: true }); }
      db.saveSticky(i.guildId, i.channel.id, { data: { title, description, color }, enabled: true, createdBy: i.user.id });
      return i.reply({ embeds: [sys.okEmbed(i.guildId, 'Sticky saved. It will be reposted as the last message after each new message.')], ephemeral: true });
    }
    if (sub === 'remove') {
      const row = db.getSticky(i.channel.id);
      if (!row) return i.reply({ embeds: [sys.errEmbed(i.guildId, 'No sticky in this channel.')], ephemeral: true });
      if (row.lastMessageId) i.channel.messages.delete(row.lastMessageId).catch(() => {});
      db.deleteSticky(i.channel.id);
      return i.reply({ embeds: [sys.okEmbed(i.guildId, 'Sticky removed.')], ephemeral: true });
    }
    if (sub === 'toggle') {
      const row = db.getSticky(i.channel.id);
      if (!row) return i.reply({ embeds: [sys.errEmbed(i.guildId, 'No sticky in this channel.')], ephemeral: true });
      const enabled = !row.enabled;
      db.setStickyEnabled(i.channel.id, enabled);
      return i.reply({ embeds: [sys.okEmbed(i.guildId, `Sticky ${enabled ? 'enabled' : 'disabled'}.`)] });
    }
    if (sub === 'list') {
      const rows = db.listStickies(i.guildId);
      return i.reply({ embeds: [sys.baseEmbed(i.guildId, 'Sticky messages').setDescription(rows.length ? rows.map(r => `<#${r.channelId}> — ${r.enabled ? '🟢' : '⚪'} — ${(r.data.title || '').slice(0, 60)}`).join('\n') : 'None configured.')], ephemeral: true });
    }
  }
});

// ---------- /autoresponder ----------
commands.push({
  data: new SlashCommandBuilder().setName('autoresponder').setDescription('Auto-reply to matching messages.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open the panel')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).autoresponder;
    const e = sys.baseEmbed(i.guildId, '💬 Auto Responder')
      .setDescription(`**Status:** ${cfg.enabled ? '🟢 Enabled' : '⚪ Disabled'}\n**Triggers:** ${(cfg.triggers || []).length}\n\nUse **Add Trigger** to create a rule.`);
    const rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ar:toggle').setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ar:add').setLabel('Add Trigger').setStyle(ButtonStyle.Primary).setEmoji('➕')
    )];
    if ((cfg.triggers || []).length) {
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('ar:remove').setPlaceholder('Remove a trigger…')
          .addOptions(cfg.triggers.slice(0, 25).map(t => ({ label: (t.match || '').slice(0, 90), value: t.id })))
      ));
    }
    await i.reply({ embeds: [e], components: rows, ephemeral: true });
  }
});

// ---------- /autoreactor ----------
commands.push({
  data: new SlashCommandBuilder().setName('autoreactor').setDescription('Auto-react to matching messages.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open the panel')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).autoreactor;
    const e = sys.baseEmbed(i.guildId, '😀 Auto Reactor')
      .setDescription(`**Status:** ${cfg.enabled ? '🟢 Enabled' : '⚪ Disabled'}\n**Triggers:** ${(cfg.triggers || []).length}`);
    const rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('arr:toggle').setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('arr:add').setLabel('Add Trigger').setStyle(ButtonStyle.Primary).setEmoji('➕')
    )];
    if ((cfg.triggers || []).length) {
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('arr:remove').setPlaceholder('Remove a trigger…')
          .addOptions(cfg.triggers.slice(0, 25).map(t => ({ label: (t.match || '').slice(0, 90), value: t.id })))
      ));
    }
    await i.reply({ embeds: [e], components: rows, ephemeral: true });
  }
});

// ---------- /honeypot ----------
commands.push({
  data: new SlashCommandBuilder().setName('honeypot').setDescription('Set up a trap channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open the honeypot panel')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).honeypot;
    const e = sys.baseEmbed(i.guildId, '🍯 Honeypot')
      .setDescription(`**Status:** ${cfg.enabled ? '🟢 Enabled' : '⚪ Disabled'}\n**Channel:** ${cfg.channelId ? `<#${cfg.channelId}>` : 'Not set'}\n**Action:** ${cfg.action}`);
    const rows = [
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder().setCustomId('honeypot:channel').setPlaceholder('Trap channel').setChannelTypes(ChannelType.GuildText)
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('honeypot:action').setPlaceholder('Action on trigger')
          .addOptions(
            { label: 'Kick', value: 'kick', emoji: '👢' },
            { label: 'Ban', value: 'ban', emoji: '🔨' },
            { label: 'Timeout (10m)', value: 'timeout', emoji: '🔇' },
            { label: 'Delete only', value: 'delete', emoji: '🗑️' }
          )
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('honeypot:toggle').setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success)
      )
    ];
    await i.reply({ embeds: [e], components: rows, ephemeral: true });
  }
});

// ---------- /rolepanel ----------
commands.push({
  data: new SlashCommandBuilder().setName('rolepanel').setDescription('Create self-service role panels.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(s => s.setName('create').setDescription('Create a new panel'))
    .addSubcommand(s => s.setName('list').setDescription('List panels')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const sub = i.options.getSubcommand();
    if (sub === 'create') {
      const panel = { id: sys.newPanelId('btn'), enabled: true, channelId: null, title: 'Choose your roles', description: 'Click a button to get or remove a role.', buttons: [] };
      db.upsertPanel(i.guildId, 'button', panel);
      return i.reply({ embeds: [panelEditEmbed(i.guildId, panel)], components: panelEditRows(panel), ephemeral: true });
    }
    if (sub === 'list') {
      const panels = db.getConfig(i.guildId).buttonRolePanels || [];
      return i.reply({ embeds: [sys.baseEmbed(i.guildId, '🎭 Role Panels').setDescription(panels.length ? panels.map(p => `• **${p.title}** — ${(p.buttons || []).length} roles — ${p.channelId ? `<#${p.channelId}>` : 'no channel'}`).join('\n') : 'None configured.')], ephemeral: true });
    }
  }
});
function panelEditEmbed(guildId, panel) {
  return sys.baseEmbed(guildId, '🎭 Edit Panel')
    .setDescription(`**Title:** ${panel.title}\n**Roles:** ${(panel.buttons || []).length}\n**Channel:** ${panel.channelId ? `<#${panel.channelId}>` : 'Not set'}`);
}
function panelEditRows(panel) {
  return [
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(`rolepanel:channel:${panel.id}`).setPlaceholder('Panel channel').setChannelTypes(ChannelType.GuildText),
      new RoleSelectMenuBuilder().setCustomId(`rolepanel:addrole:${panel.id}`).setPlaceholder('Add a role')
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rolepanel:edit:${panel.id}`).setLabel('Edit Title/Description').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`rolepanel:post:${panel.id}`).setLabel('Post Panel').setStyle(ButtonStyle.Success).setEmoji('📤'),
      new ButtonBuilder().setCustomId(`rolepanel:delete:${panel.id}`).setLabel('Delete').setStyle(ButtonStyle.Danger)
    )
  ];
}

// ---------- /automation ----------
commands.push({
  data: new SlashCommandBuilder().setName('automation').setDescription('Manage custom automations.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('list').setDescription('List automations')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    await i.reply({ embeds: [sys.infoEmbed(i.guildId, 'Automations are configured through the setup panel. Use `/setup panel` to begin.')], ephemeral: true });
  }
});

// ---------- /owner ----------
commands.push({
  data: new SlashCommandBuilder().setName('owner').setDescription('[Owner] Bot management.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('stats').setDescription('Bot stats'))
    .addSubcommand(s => s.setName('blacklist').setDescription('Blacklist a user')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason')))
    .addSubcommand(s => s.setName('unblacklist').setDescription('Remove from blacklist')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('maintenance').setDescription('Toggle maintenance mode'))
    .addSubcommand(s => s.setName('errors').setDescription('Show recent errors')),
  async execute(i) {
    if (!sys.isOwner(i.user.id)) return i.reply({ embeds: [sys.errEmbed(i.guildId, 'Owner only.')], ephemeral: true });
    const sub = i.options.getSubcommand();
    if (sub === 'stats') {
      const mem = process.memoryUsage();
      return i.reply({ embeds: [sys.baseEmbed(i.guildId, '📊 Bot Stats').addFields(
        { name: 'Guilds', value: String(i.client.guilds.cache.size), inline: true },
        { name: 'Users', value: String(i.client.users.cache.size), inline: true },
        { name: 'WS ping', value: `${i.client.ws.ping}ms`, inline: true },
        { name: 'RSS', value: `${(mem.rss / 1048576).toFixed(1)} MB`, inline: true },
        { name: 'Uptime', value: `${Math.floor(process.uptime() / 3600)}h`, inline: true },
        { name: 'Maintenance', value: String(db.getOwnerConfig().maintenance || false), inline: true }
      )], ephemeral: true });
    }
    if (sub === 'blacklist') {
      const user = i.options.getUser('user', true);
      db.addGlobalBlacklist(user.id);
      return i.reply({ embeds: [sys.okEmbed(i.guildId, `Blacklisted ${user.tag}.`)] });
    }
    if (sub === 'unblacklist') {
      const user = i.options.getUser('user', true);
      db.removeGlobalBlacklist(user.id);
      return i.reply({ embeds: [sys.okEmbed(i.guildId, `Removed ${user.tag} from the blacklist.`)] });
    }
    if (sub === 'maintenance') {
      const cur = db.getOwnerConfig().maintenance || false;
      db.saveOwnerConfig({ maintenance: !cur });
      return i.reply({ embeds: [sys.okEmbed(i.guildId, `Maintenance mode: **${!cur}**`)] });
    }
    if (sub === 'errors') {
      const rows = db.listErrors().slice(0, 10);
      return i.reply({ embeds: [sys.baseEmbed(i.guildId, 'Recent Errors').setDescription(rows.length ? rows.map(r => `**#${r.id}** — <t:${Math.floor(r.ts / 1000)}:R> — ${(r.message || '').slice(0, 150)}`).join('\n') : 'No errors logged.')], ephemeral: true });
    }
  }
});

// ---------- /emojis ----------
commands.push({
  data: new SlashCommandBuilder().setName('emojis').setDescription('Manage the emoji registry.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('list').setDescription('List registered emojis'))
    .addSubcommand(s => s.setName('set').setDescription('Set an emoji')
      .addStringOption(o => o.setName('key').setDescription('Registry key').setRequired(true))
      .addStringOption(o => o.setName('value').setDescription('Emoji character or <:name:id>').setRequired(true)))
    .addSubcommand(s => s.setName('reset').setDescription('Reset an emoji')
      .addStringOption(o => o.setName('key').setDescription('Registry key').setRequired(true))),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
      const overrides = db.getAllEmojiOverrides();
      const keys = Object.keys(sys.emoji ? {} : {}); // placeholder
      const defaults = ['success','error','warning','info','enabled','disabled','settings','ticket','shield','voice','level','wave','delete','lock','unlock','kick','mute','link','spam','raid','owner','help','list','edit','add','remove','claim','undo','category'];
      const lines = defaults.map(k => `\`${k}\` → ${db.getEmojiOverride(k) || 'default'}`);
      return i.reply({ embeds: [sys.baseEmbed(i.guildId, '😀 Emoji Registry').setDescription(lines.join('\n'))], ephemeral: true });
    }
    if (sub === 'set') {
      const key = i.options.getString('key', true);
      const value = i.options.getString('value', true).trim();
      if (!value) return i.reply({ embeds: [sys.errEmbed(i.guildId, 'Emoji value cannot be empty.')], ephemeral: true });
      db.setEmojiOverride(key, value);
      return i.reply({ embeds: [sys.okEmbed(i.guildId, `Set \`${key}\` → ${value}`)] });
    }
    if (sub === 'reset') {
      const key = i.options.getString('key', true);
      db.resetEmojiOverride(key);
      return i.reply({ embeds: [sys.okEmbed(i.guildId, `Reset \`${key}\`.`)] });
    }
  }
});

// ---------- /logs ----------
commands.push({
  data: new SlashCommandBuilder().setName('logs').setDescription('Configure logging destinations.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open the logging panel')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).logs;
    const rows = [];
    const lines = [];
    for (const key of sys.LOG_KEYS) {
      lines.push(`**${key}:** ${cfg[key] ? `<#${cfg[key]}>` : 'Not set'}`);
    }
    const e = sys.baseEmbed(i.guildId, '📜 Logging').setDescription(lines.join('\n') + '\n\nSelect a category below, then pick a channel.');
    const catMenu = new StringSelectMenuBuilder().setCustomId('logs:cat').setPlaceholder('1. Category')
      .addOptions(sys.LOG_KEYS.map(k => ({ label: k, value: k })));
    const chMenu = new ChannelSelectMenuBuilder().setCustomId('logs:channel').setPlaceholder('2. Channel').setChannelTypes(ChannelType.GuildText);
    await i.reply({ embeds: [e], components: [new ActionRowBuilder().addComponents(catMenu), new ActionRowBuilder().addComponents(chMenu)], ephemeral: true });
  }
});

// ---------- Export ----------
module.exports = {
  commands,
  MODULES,
  setupPanelEmbed, setupPanelRows,
  wizardStartEmbed, wizardModuleRow,
  helpHomeEmbed, helpSelectRow, HELP_CATEGORIES,
  snipeStore, recordSnipe,
  panelEditEmbed, panelEditRows,
  askHistory,
  isAdmin, requireAdmin, parseHexColor, safeReply
};