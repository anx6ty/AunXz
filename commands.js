// AunXz/commands.js — every slash command. Exported as a flat array.
// Owner-only commands have `ownerOnly: true`; index.js registers those to
// GUILD_ID only, so they don't appear in other servers' slash menus.
'use strict';

const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder
} = require('discord.js');
const db = require('./database');
const sys = require('./systems');
const ui = require('./ui');

// =============================================================================
// SHARED HELPERS
// =============================================================================
const isAdmin = i => i.member?.permissions.has(PermissionFlagsBits.Administrator) || sys.isOwner(i.user.id);
const requireAdmin = i => {
  if (!isAdmin(i)) { i.reply({ embeds: [ui.errEmbed('Permission Required', 'You need **Administrator**.')], ephemeral: true }).catch(() => {}); return false; }
  return true;
};
const parseColor = s => { const m = String(s || '').trim().match(/^(?:#|0x)?([0-9a-f]{6})$/i); return m ? parseInt(m[1], 16) : null; };

const commands = [];
const askHistory = new Map(); // "guildId:userId" -> [{ role, content }]

// =============================================================================
// INFORMATION COMMANDS
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('help').setDescription('Browse AunXz commands.'),
  async execute(i) { await i.reply({ ...ui.helpMenuEmbed(i.client), ephemeral: false }); }
});

commands.push({
  data: new SlashCommandBuilder().setName('ping').setDescription('Check bot latency.'),
  async execute(i) {
    const t = Date.now();
    await i.reply({ embeds: [ui.infoEmbed('Ping', 'Pinging…')] });
    await i.editReply({ embeds: [ui.infoEmbed('Pong', `**WebSocket:** ${i.client.ws.ping}ms\n**RTT:** ${Date.now() - t}ms`)] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('botinfo').setDescription('Bot information.'),
  async execute(i) {
    const up = process.uptime();
    await i.reply({ embeds: [ui.embed('AunXz').addFields(
      { name: 'Guilds', value: String(i.client.guilds.cache.size), inline: true },
      { name: 'Users', value: String(i.client.users.cache.size), inline: true },
      { name: 'Uptime', value: `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`, inline: true },
      { name: 'Node', value: process.version, inline: true },
      { name: 'discord.js', value: require('discord.js').version, inline: true },
      { name: 'AI', value: process.env.GROQ_API_KEY ? 'Groq (configured)' : 'Not configured', inline: true }
    )] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('serverinfo').setDescription('Server information.'),
  async execute(i) {
    const g = i.guild;
    await i.deferReply();
    let complete = true;
    if (g.memberCount > g.members.cache.size) {
      if (g.memberCount <= 2000) { try { await g.members.fetch({ time: 15000 }); } catch { complete = false; } }
      else complete = false;
    }
    const members = g.members.cache;
    const humans = members.filter(m => !m.user.bot).size;
    const bots = members.filter(m => m.user.bot).size;
    await i.editReply({ embeds: [ui.embed(`🏠 ${g.name}`).setThumbnail(g.iconURL({ dynamic: true })).addFields(
      { name: 'Members', value: `**${complete ? g.memberCount : members.size}** shown\n${humans} humans • ${bots} bots${complete ? '' : '\n-# cache only'}`, inline: true },
      { name: 'Channels', value: String(g.channels.cache.size), inline: true },
      { name: 'Roles', value: String(g.roles.cache.size - 1), inline: true },
      { name: 'Boosts', value: `${g.premiumSubscriptionCount || 0} (Tier ${g.premiumTier})`, inline: true },
      { name: 'Owner', value: `<@${g.ownerId}>`, inline: true },
      { name: 'Created', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true }
    )] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('userinfo').setDescription('User information.')
    .addUserOption(o => o.setName('user').setDescription('Target user')),
  async execute(i) {
    const user = i.options.getUser('user') || i.user;
    const member = await i.guild.members.fetch(user.id).catch(() => null);
    const e = ui.embed(`👤 ${user.username}`).setThumbnail(user.displayAvatarURL({ size: 256 })).addFields(
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
      if (sys.isStaff(i.guildId, i.member)) {
        e.addFields({ name: 'Moderation', value: `Warnings: ${db.getWarns(i.guildId, user.id).length}`, inline: true });
      }
    }
    await i.reply({ embeds: [e] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('avatar').setDescription('Show a user avatar.')
    .addUserOption(o => o.setName('user').setDescription('Target user')),
  async execute(i) {
    const user = i.options.getUser('user') || i.user;
    const url = user.displayAvatarURL({ size: 1024 });
    await i.reply({ embeds: [ui.embed(`${user.username}`).setImage(url).setDescription(`[Full size](${url})`)] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('snipe').setDescription('Recent deleted or edited messages.')
    .addChannelOption(o => o.setName('channel').setDescription('Channel (default: this one)')),
  async execute(i) {
    const ch = i.options.getChannel('channel') || i.channel;
    const view = sys.snipeView(i.guildId, ch.id, 0);
    await i.reply({ ...view, ephemeral: true });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('invites').setDescription('Invite statistics.')
    .addUserOption(o => o.setName('user').setDescription('Show only this user\'s invites')),
  async execute(i) {
    const me = i.guild.members.me;
    if (!me.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return i.reply({ embeds: [ui.errEmbed('Missing Permission', 'I need **Manage Server** to read invites.')], ephemeral: true });
    }
    const target = i.options.getUser('user');
    const invites = await i.guild.invites.fetch().catch(() => null);
    if (!invites) return i.reply({ embeds: [ui.errEmbed('Unavailable', 'Could not read invites.')], ephemeral: true });
    const rows = [...invites.filter(x => !target || x.inviter?.id === target.id).values()].sort((a, b) => (b.uses || 0) - (a.uses || 0));
    const total = rows.reduce((n, x) => n + (x.uses || 0), 0);
    const desc = rows.length ? rows.slice(0, 25).map((x, n) => `${n + 1}. ${x.inviter || 'Unknown'} — **${x.uses || 0}** uses — \`${x.code}\``).join('\n') : 'No invites found.';
    await i.reply({ embeds: [ui.embed(`📨 ${target ? `${target.username}'s` : 'Server'} Invites`).setDescription(desc).setFooter({ text: `Total tracked uses: ${total}` })] });
  }
});

// =============================================================================
// SETUP
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('setup').setDescription('AunXz configuration center.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('panel').setDescription('Open the module dashboard'))
    .addSubcommand(s => s.setName('wizard').setDescription('Guided setup wizard'))
    .addSubcommand(s => s.setName('health').setDescription('Run a diagnostics check'))
    .addSubcommand(s => s.setName('backup').setDescription('Download a configuration backup'))
    .addSubcommand(s => s.setName('restore').setDescription('Restore configuration from a backup')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const sub = i.options.getSubcommand();
    if (sub === 'panel') return i.reply({ ...ui.setupPanelEmbed(i.guildId), ephemeral: true });
    if (sub === 'wizard') {
      const menu = new StringSelectMenuBuilder().setCustomId('wizard:modules')
        .setPlaceholder('Choose modules to enable')
        .setMinValues(1).setMaxValues(20)
        .addOptions(ui.SETUP_MODULES.filter(m => m.cfgKey).map(m => ({ label: m.label, value: m.key, description: m.desc.slice(0, 100) })));
      return i.reply({ embeds: [ui.infoEmbed('Guided Wizard', 'Select modules. Nothing saves until you confirm.')], components: [ui.row(menu)], ephemeral: true });
    }
    if (sub === 'health') {
      await i.deferReply({ ephemeral: true });
      const issues = await sys.healthCheck(i.guild);
      const desc = issues.length
        ? issues.map(x => `${x.severity === 'high' ? '🔴' : x.severity === 'medium' ? '🟡' : '🟢'} ${x.text}`).join('\n')
        : 'All checks passed. No issues detected.';
      return i.editReply({ embeds: [ui.embed('🩺 Health Check', desc)] });
    }
    if (sub === 'backup') {
      const buf = Buffer.from(JSON.stringify(db.exportGuild(i.guildId), null, 2));
      return i.reply({ content: 'Configuration backup attached (excludes secrets).', files: [{ attachment: buf, name: `aunxz-${i.guildId}.json` }], ephemeral: true });
    }
    if (sub === 'restore') {
      const modal = new ModalBuilder().setCustomId('setup:restore:modal').setTitle('Restore Configuration');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('payload').setLabel('Paste the export JSON').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)
      ));
      return i.showModal(modal);
    }
  }
});

// =============================================================================
// MODERATION
// =============================================================================
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
      .addIntegerOption(o => o.setName('minutes').setDescription('1–40320').setRequired(true).setMinValue(1).setMaxValue(40320))
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
      .addIntegerOption(o => o.setName('count').setDescription('1–100').setRequired(true).setMinValue(1).setMaxValue(100))
      .addUserOption(o => o.setName('user').setDescription('Filter by user')))
    .addSubcommand(s => s.setName('history').setDescription('Case history')
      .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true))),
  async execute(i) {
    const sub = i.options.getSubcommand();
    const g = i.guild;
    if (sub === 'warnings' || sub === 'history') {
      const user = i.options.getUser('user', true);
      const warns = db.getWarns(g.id, user.id);
      const title = sub === 'warnings' ? `Warnings — ${user.tag}` : `Case History — ${user.tag}`;
      return i.reply({
        embeds: [ui.embed(title, warns.length
          ? warns.slice(0, 20).map((w, n) => `**${n + 1}.** ${w.reason} — <@${w.moderatorId}> <t:${Math.floor(w.timestamp / 1000)}:R>`).join('\n')
          : 'No cases on record.')],
        ephemeral: true
      });
    }
    if (sub === 'clearwarnings') {
      const user = i.options.getUser('user', true);
      db.clearWarns(g.id, user.id);
      return i.reply({ embeds: [ui.okEmbed('Cleared', `Warnings for ${user.tag} cleared.`)] });
    }
    if (sub === 'purge') {
      const count = i.options.getInteger('count', true);
      const filterUser = i.options.getUser('user');
      if (!i.channel.bulkDelete) return i.reply({ embeds: [ui.errEmbed('Unsupported', 'Bulk delete not supported here.')], ephemeral: true });
      await i.deferReply({ ephemeral: true });
      const msgs = await i.channel.messages.fetch({ limit: Math.min(count, 100) });
      const toDelete = filterUser ? msgs.filter(m => m.author.id === filterUser.id) : msgs;
      const deleted = await i.channel.bulkDelete(toDelete, true).catch(() => null);
      if (!deleted) return i.editReply({ embeds: [ui.errEmbed('Failed', 'Bulk delete rejected by Discord.')] });
      await sys.logMod(g, { action: '🧹 Purge', moderator: i.user, extra: { Channel: `<#${i.channel.id}>`, Count: deleted.size } });
      return i.editReply({ embeds: [ui.okEmbed('Purged', `Deleted ${deleted.size} message(s).`)] });
    }
    await i.deferReply({ ephemeral: true });
    const user = i.options.getUser('user') || { id: i.options.getString('user_id') };
    const target = await g.members.fetch(user.id).catch(() => null);
    const reason = i.options.getString('reason') || i.user.tag;
    if (!target && sub !== 'unban') return i.editReply({ embeds: [ui.errEmbed('Not Found', 'User not in this server.')] });
    const actionMap = { ban: 'ban', unban: 'unban', kick: 'kick', timeout: 'timeout', untimeout: 'untimeout', warn: 'warn' };
    const durationMs = sub === 'timeout' ? i.options.getInteger('minutes', true) * 60000 : undefined;
    try {
      await sys.moderate(actionMap[sub], {
        guild: g, moderator: i.member,
        target: sub === 'unban' ? { id: user.id } : target,
        reason, durationMs
      });
      await i.editReply({ embeds: [ui.okEmbed('Action Applied', `${sub} → ${user.tag || user.id}`)] });
    } catch (e) {
      await i.editReply({ embeds: [ui.errEmbed('Failed', String(e.message || e))] });
    }
  }
});

// =============================================================================
// SECURITY SETUP COMMANDS (shared shape)
// =============================================================================
function securityCommand(name, cfgKey, description) {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription(description)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand(s => s.setName('setup').setDescription('Open the setup panel')
        .addStringOption(o => o.setName('state').setDescription('Enable or disable')
          .addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }))),
    async execute(i) {
      if (!requireAdmin(i)) return;
      const state = i.options.getString('state');
      if (state) db.saveConfig(i.guildId, { [cfgKey]: { enabled: state === 'enable' } });
      const cfg = db.getConfig(i.guildId)[cfgKey];
      const fields = Object.entries(cfg).filter(([k]) => k !== 'enabled').map(([k, v]) => ({
        name: k, inline: true,
        value: v === null || v === undefined ? '—'
          : Array.isArray(v) ? (v.length ? v.join(', ') : '—')
          : typeof v === 'object' ? '`' + JSON.stringify(v) + '`'
          : String(v).slice(0, 200)
      }));
      const e = ui.buildV2({
        title: `🛡️ ${name} — Setup`,
        description: `**Status:** ${cfg.enabled ? '🟢 Enabled' : '⚪ Disabled'}`,
        fields: fields.slice(0, 25),
        components: [ui.row(
          ui.toggleButton(`setup:toggle:${cfgKey}`, !!cfg.enabled),
          ui.btn(`setup:refresh:${cfgKey}`, 'Refresh', ButtonStyle.Secondary)
        )]
      });
      await i.reply({ ...e, ephemeral: true });
      sys.refreshAutomod(i.guildId);
    }
  };
}
commands.push(securityCommand('antinuke', 'antinuke', 'Anti-Nuke protection.'));
commands.push(securityCommand('antilink', 'antilink', 'Anti-Link filter.'));
commands.push(securityCommand('antispam', 'antispam', 'Anti-Spam filter.'));
commands.push(securityCommand('antiraid', 'antiraid', 'Anti-Raid protection.'));
commands.push(securityCommand('antiwebhook', 'antiwebhook', 'Anti-Webhook protection.'));
commands.push(securityCommand('antibot', 'antibot', 'Anti-Bot protection.'));
commands.push(securityCommand('antialt', 'antialt', 'Anti-Alt protection.'));

// =============================================================================
// AUTOMOD / BADWORDS
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('automod').setDescription('AutoMod filters.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open the AutoMod panel')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).automod;
    const e = ui.buildV2({
      title: '🛡️ AutoMod',
      description: 'Independent filters, each can be toggled separately.',
      fields: [
        { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
        { name: 'Caps filter', value: cfg.capsFilter ? `${cfg.capsThreshold}%` : 'Off', inline: true },
        { name: 'Invite filter', value: cfg.inviteFilter ? 'On' : 'Off', inline: true },
        { name: 'Bad words', value: String((cfg.badWords || []).length), inline: true }
      ],
      components: [ui.row(
        ui.toggleButton('automod:toggle', cfg.enabled),
        ui.btn('automod:caps', 'Caps Filter', ButtonStyle.Secondary),
        ui.btn('automod:invite', 'Invite Filter', ButtonStyle.Secondary),
        ui.btn('automod:words', 'Bad Words', ButtonStyle.Secondary)
      )]
    });
    await i.reply({ ...e, ephemeral: true });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('antibadwordsetup').setDescription('Word-boundary bad-word filter.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).antibadword;
    const e = ui.buildV2({
      title: '🚫 Anti Bad Word',
      description: 'Word-boundary matching — "class" does not trigger on "ass".',
      fields: [
        { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
        { name: 'Action', value: cfg.action, inline: true },
        { name: 'Words', value: String((cfg.words || []).length + (cfg.customWords || []).length), inline: true }
      ],
      components: [ui.row(
        ui.toggleButton('badword:toggle', cfg.enabled),
        ui.btn('badword:words', 'Edit Words', ButtonStyle.Primary)
      )]
    });
    await i.reply({ ...e, ephemeral: true });
    sys.refreshAutomod(i.guildId);
  }
});

// =============================================================================
// WELCOME / LEAVE / GREETMESSAGE
// =============================================================================
function simpleWelcome(name, cfgKey, description) {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription(description)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand(s => s.setName('setup').setDescription('Configure')),
    async execute(i) {
      if (!requireAdmin(i)) return;
      const cfg = db.getConfig(i.guildId)[cfgKey];
      const e = ui.buildV2({
        title: `${name === 'welcome' ? '👋 Welcome' : '🚪 Leave'} — Setup`,
        description: `**Status:** ${cfg.enabled ? '🟢 Enabled' : '⚪ Disabled'}\n**Channel:** ${cfg.channel ? `<#${cfg.channel}>` : 'Not set'}\n**Message:** ${String(cfg.message || '').slice(0, 500)}`,
        components: [
          ui.row(new ChannelSelectMenuBuilder().setCustomId(`${name}:channel`).setPlaceholder('Select channel').setChannelTypes(ChannelType.GuildText)),
          ui.row(
            ui.toggleButton(`${name}:toggle`, cfg.enabled),
            ui.btn(`${name}:edit`, 'Edit Message', ButtonStyle.Primary)
          )
        ]
      });
      await i.reply({ ...e, ephemeral: true });
    }
  };
}
commands.push(simpleWelcome('welcome', 'welcome', 'Welcome messages.'));
commands.push(simpleWelcome('leave', 'leave', 'Leave messages.'));

commands.push({
  data: new SlashCommandBuilder().setName('greetmessage').setDescription('Welcome card with image and title.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open the greet message panel')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).greetmessage;
    await i.reply({ ...ui.greetMessageEmbed(cfg), ephemeral: true });
  }
});

// =============================================================================
// GREET VOICE
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('greetvoice').setDescription('Voice greeting with TTS or uploaded audio.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('setup').setDescription('Open the Greet Voice panel')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).greetvoice;
    await i.reply({ ...ui.greetVoiceEmbed(cfg), ephemeral: true });
  }
});

// =============================================================================
// TICKETS
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('tickets').setDescription('Configure the ticket system.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open the ticket setup panel')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).ticket;
    const e = ui.buildV2({
      title: '🎫 Ticket System',
      description: 'Configure the category, staff role, and log channel, then post the panel.',
      fields: [
        { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
        { name: 'Category', value: cfg.categoryId ? `<#${cfg.categoryId}>` : 'Auto-created', inline: true },
        { name: 'Support role', value: cfg.supportRoleId ? `<@&${cfg.supportRoleId}>` : 'Not set', inline: true },
        { name: 'Log channel', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Not set', inline: true }
      ],
      components: [
        ui.row(new ChannelSelectMenuBuilder().setCustomId('ticket:cfg:category').setPlaceholder('Ticket category').setChannelTypes(ChannelType.GuildCategory)),
        ui.row(new ChannelSelectMenuBuilder().setCustomId('ticket:cfg:log').setPlaceholder('Log channel').setChannelTypes(ChannelType.GuildText)),
        ui.row(new RoleSelectMenuBuilder().setCustomId('ticket:cfg:support').setPlaceholder('Support role')),
        ui.row(
          ui.toggleButton('ticket:cfg:toggle', cfg.enabled),
          ui.btn('ticket:cfg:post', 'Post Panel', ButtonStyle.Success, { emoji: '🎫' })
        )
      ]
    });
    await i.reply({ ...e, ephemeral: true });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('ticketpanel').setDescription('Post the ticket-opening panel here.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).ticket;
    if (!cfg.enabled) return i.reply({ embeds: [ui.errEmbed('Disabled', 'Enable tickets first with `/tickets setup`.')], ephemeral: true });
    await i.channel.send(ui.ticketPanelEmbed(cfg, i.guild.name));
    await i.reply({ embeds: [ui.okEmbed('Posted', 'Ticket panel is live.')], ephemeral: true });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('ticketconfig').setDescription('Customize the ticket panel appearance.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('title').setDescription('Panel title').setMaxLength(200))
    .addStringOption(o => o.setName('description').setDescription('Panel description').setMaxLength(1000))
    .addStringOption(o => o.setName('category_label').setDescription('Label shown inside a ticket').setMaxLength(100))
    .addStringOption(o => o.setName('welcome_message').setDescription('Welcome text inside a ticket').setMaxLength(500)),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const patch = {};
    const map = { title: 'panelTitle', description: 'panelDescription', category_label: 'categoryLabel', welcome_message: 'welcomeMessage' };
    for (const [opt, key] of Object.entries(map)) { const v = i.options.getString(opt); if (v !== null) patch[key] = v; }
    if (Object.keys(patch).length) db.saveConfig(i.guildId, { ticket: patch });
    const cfg = db.getConfig(i.guildId).ticket;
    await i.reply({ embeds: [ui.embed('🎫 Ticket Appearance').addFields(
      { name: 'Title', value: cfg.panelTitle || '(default)', inline: false },
      { name: 'Description', value: cfg.panelDescription || '(default)', inline: false },
      { name: 'Category label', value: cfg.categoryLabel || 'Support', inline: true },
      { name: 'Welcome', value: cfg.welcomeMessage || '(default)', inline: false }
    )], ephemeral: true });
  }
});

// =============================================================================
// LEVELING
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('leveling').setDescription('Configure XP and leveling.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open the leveling panel')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).leveling;
    await i.reply({ ...ui.levelingEmbed(cfg), ephemeral: true });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('rank').setDescription('View a member rank card.')
    .addUserOption(o => o.setName('user').setDescription('Target user')),
  async execute(i) {
    const user = i.options.getUser('user') || i.user;
    const rec = db.getLevel(i.guildId, user.id);
    const info = sys.levelFromXp(rec.xp);
    await i.reply({ embeds: [ui.embed(`${user.username}'s Rank`).setThumbnail(user.displayAvatarURL())
      .setDescription(`**Level:** ${info.level}\n**XP:** ${info.remaining} / ${info.next}\n**Total XP:** ${rec.xp}`)] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('leaderboard').setDescription('Top 25 members by XP.'),
  async execute(i) {
    const rows = db.topLevels(i.guildId, 25);
    await i.reply({ embeds: [ui.embed(`🏆 ${i.guild.name} Leaderboard`, rows.length
      ? rows.map((r, n) => `**${n + 1}.** <@${r.userId}> — Level ${r.level} • ${r.xp.toLocaleString()} XP`).join('\n')
      : 'No XP recorded yet.')] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('xp').setDescription('Manage a member XP.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand(s => s.setName('add').setDescription('Add XP').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addIntegerOption(o => o.setName('amount').setDescription('XP').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove XP').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addIntegerOption(o => o.setName('amount').setDescription('XP').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('set').setDescription('Set XP').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addIntegerOption(o => o.setName('amount').setDescription('Total').setRequired(true).setMinValue(0)))
    .addSubcommand(s => s.setName('reset').setDescription('Reset XP').addUserOption(o => o.setName('user').setDescription('User').setRequired(true))),
  async execute(i) {
    const sub = i.options.getSubcommand();
    const user = i.options.getUser('user', true);
    const rec = db.getLevel(i.guildId, user.id);
    let xp = rec.xp;
    if (sub === 'add') xp += i.options.getInteger('amount');
    else if (sub === 'remove') xp = Math.max(0, xp - i.options.getInteger('amount'));
    else if (sub === 'set') xp = i.options.getInteger('amount');
    else xp = 0;
    const { level } = sys.levelFromXp(xp);
    db.setLevel(i.guildId, user.id, xp, level, rec.lastMessage);
    await i.reply({ embeds: [ui.okEmbed('Updated', `${user.tag} — Level ${level}, ${xp} XP`)] });
  }
});

// =============================================================================
// EMBEDS
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('embed').setDescription('Manage saved embeds.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand(s => s.setName('create').setDescription('Create a saved embed')
      .addStringOption(o => o.setName('name').setDescription('Name').setRequired(true))
      .addStringOption(o => o.setName('title').setDescription('Title'))
      .addStringOption(o => o.setName('description').setDescription('Description'))
      .addStringOption(o => o.setName('color').setDescription('Hex color e.g. #000000')))
    .addSubcommand(s => s.setName('send').setDescription('Send a saved embed')
      .addStringOption(o => o.setName('name').setDescription('Name').setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Destination (default: this channel)')))
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
      let color = null;
      if (colorRaw) { color = parseColor(colorRaw); if (color === null) return i.reply({ embeds: [ui.errEmbed('Invalid', 'Color must be #rrggbb.')], ephemeral: true }); }
      if (!title && !description) return i.reply({ embeds: [ui.errEmbed('Empty', 'Provide a title or description.')], ephemeral: true });
      db.saveEmbed(i.guildId, name, { title, description, color });
      return i.reply({ embeds: [ui.okEmbed('Saved', `Embed **${name}** saved.`)], ephemeral: true });
    }
    if (sub === 'send') {
      const name = i.options.getString('name', true);
      const payload = db.getEmbed(i.guildId, name);
      if (!payload) return i.reply({ embeds: [ui.errEmbed('Not Found', 'Embed not found.')], ephemeral: true });
      const ch = i.options.getChannel('channel') || i.channel;
      if (!ch?.isTextBased()) return i.reply({ embeds: [ui.errEmbed('Invalid', 'Channel not usable.')], ephemeral: true });
      const e = new EmbedBuilder().setTimestamp().setColor(payload.data.color ?? ui.BLACK);
      if (payload.data.title) e.setTitle(payload.data.title);
      if (payload.data.description) e.setDescription(payload.data.description);
      await ch.send({ embeds: [e] });
      return i.reply({ embeds: [ui.okEmbed('Sent', `Sent to <#${ch.id}>.`)], ephemeral: true });
    }
    if (sub === 'list') {
      const list = db.listEmbeds(i.guildId);
      return i.reply({ embeds: [ui.embed('Saved Embeds', list.length ? list.map(e => `• \`${e.name}\` — <t:${Math.floor(e.updatedAt / 1000)}:R>`).join('\n') : 'None saved yet.')], ephemeral: true });
    }
    if (sub === 'delete') {
      const name = i.options.getString('name', true);
      const removed = db.deleteEmbed(i.guildId, name);
      return i.reply({ embeds: [removed ? ui.okEmbed('Deleted', `**${name}** removed.`) : ui.errEmbed('Not Found', 'No such embed.')], ephemeral: true });
    }
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('embedbuilder').setDescription('Build and post a custom embed.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const modal = new ModalBuilder().setCustomId('eb:build:modal').setTitle('Embed Builder');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(3000)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Color hex (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(7)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channel').setLabel('Destination channel ID').setStyle(TextInputStyle.Short).setRequired(true))
    );
    await i.showModal(modal);
  }
});

// =============================================================================
// GIVEAWAYS
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('giveaway').setDescription('Manage giveaways.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents)
    .addSubcommand(s => s.setName('start').setDescription('Start a giveaway')
      .addStringOption(o => o.setName('prize').setDescription('Prize').setRequired(true).setMaxLength(200))
      .addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes').setRequired(true).setMinValue(1).setMaxValue(43200))
      .addIntegerOption(o => o.setName('winners').setDescription('Winners').setMinValue(1).setMaxValue(20))
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
      if (!ch?.isTextBased()) return i.reply({ embeds: [ui.errEmbed('Invalid', 'Bad channel.')], ephemeral: true });
      await i.deferReply({ ephemeral: true });
      const g = db.createGiveaway(i.guildId, i.user.id, { prize, winners, durationMs: minutes * 60000, channelId: ch.id });
      const row = ui.row(ui.btn(`giveaway:enter:${g.id}`, 'Enter', ButtonStyle.Primary, { emoji: '🎉' }));
      const e = ui.buildV2({
        title: '🎉 Giveaway!',
        description: `**Prize:** ${prize}\n**Winners:** ${winners}\n**Ends:** <t:${Math.floor(g.endsAt / 1000)}:R>\n\nClick below to enter.`,
        components: [row]
      });
      const msg = await ch.send(e).catch(() => null);
      if (!msg) return i.editReply({ embeds: [ui.errEmbed('Failed', 'Could not post the giveaway message.')] });
      db.updateGiveaway(i.guildId, g.id, { messageId: msg.id, status: 'active' });
      return i.editReply({ embeds: [ui.okEmbed('Started', `Giveaway running in <#${ch.id}>.`)] });
    }
    if (sub === 'end') {
      const id = i.options.getInteger('id', true);
      const g = db.getGiveaway(i.guildId, id);
      if (!g || g.status !== 'active') return i.reply({ embeds: [ui.errEmbed('Not Found', 'Giveaway not found or already ended.')], ephemeral: true });
      let participants = [];
      try { participants = JSON.parse(g.participants || '[]'); } catch {}
      await i.guild.members.fetch({ user: participants.slice(0, 100) }).catch(() => {});
      const valid = participants.filter(x => i.guild.members.cache.has(x));
      const pool = [...valid], winners = [];
      while (winners.length < g.winners && pool.length) winners.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      db.updateGiveaway(i.guildId, g.id, { status: 'ended', winnerIds: JSON.stringify(winners) });
      const ch = g.channelId ? i.guild.channels.cache.get(g.channelId) : null;
      if (ch?.isTextBased()) ch.send({ content: winners.length ? `🎉 Winners for **${g.prize}**: ${winners.map(w => `<@${w}>`).join(', ')}` : `No valid entries for **${g.prize}**.` }).catch(() => {});
      return i.reply({ embeds: [ui.okEmbed('Ended', `${winners.length} winner(s) selected.`)] });
    }
    if (sub === 'reroll') {
      const id = i.options.getInteger('id', true);
      const g = db.getGiveaway(i.guildId, id);
      if (!g) return i.reply({ embeds: [ui.errEmbed('Not Found', 'Giveaway not found.')], ephemeral: true });
      let participants = [];
      try { participants = JSON.parse(g.participants || '[]'); } catch {}
      if (!participants.length) return i.reply({ embeds: [ui.errEmbed('Empty', 'No entries.')], ephemeral: true });
      const count = Math.min(i.options.getInteger('winners') || g.winners, participants.length);
      const pool = [...participants], winners = [];
      while (winners.length < count && pool.length) winners.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      db.updateGiveaway(i.guildId, g.id, { winnerIds: JSON.stringify(winners) });
      const ch = g.channelId ? i.guild.channels.cache.get(g.channelId) : null;
      if (ch?.isTextBased()) ch.send({ content: `🎉 Reroll: ${winners.map(w => `<@${w}>`).join(', ')}` }).catch(() => {});
      return i.reply({ embeds: [ui.okEmbed('Rerolled', `${winners.length} new winner(s).`)] });
    }
    if (sub === 'list') {
      const rows = db.listGiveaways(i.guildId, 25);
      const desc = rows.length ? rows.map(g => {
        let n = 0; try { n = JSON.parse(g.participants || '[]').length; } catch {}
        return `**#${g.id}** ${g.status === 'active' ? '🟢' : g.status === 'ended' ? '🏁' : '⚪'} ${g.prize} — ${g.status} • ${n} entries`;
      }).join('\n') : 'No giveaways yet.';
      return i.reply({ embeds: [ui.embed('🎉 Giveaways', desc)], ephemeral: true });
    }
  }
});

// =============================================================================
// STICKY MESSAGES
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('stickymessage').setDescription('Sticky embeds that stay at the bottom of a channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand(s => s.setName('set').setDescription('Create or edit a sticky in this channel')
      .addStringOption(o => o.setName('title').setDescription('Title').setRequired(true).setMaxLength(200))
      .addStringOption(o => o.setName('description').setDescription('Body text').setRequired(true).setMaxLength(3000))
      .addStringOption(o => o.setName('color').setDescription('Hex color')))
    .addSubcommand(s => s.setName('remove').setDescription('Remove the sticky in this channel'))
    .addSubcommand(s => s.setName('toggle').setDescription('Enable or disable the sticky in this channel'))
    .addSubcommand(s => s.setName('list').setDescription('List all stickies in this server')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const sub = i.options.getSubcommand();
    if (sub === 'set') {
      const title = i.options.getString('title', true);
      const description = i.options.getString('description', true);
      const colorRaw = i.options.getString('color');
      let color;
      if (colorRaw) { color = parseColor(colorRaw); if (color === null) return i.reply({ embeds: [ui.errEmbed('Invalid', 'Bad color.')], ephemeral: true }); }
      db.saveSticky(i.guildId, i.channel.id, { data: { title, description, color }, enabled: true, createdBy: i.user.id });
      return i.reply({ embeds: [ui.okEmbed('Saved', 'Sticky saved. It reposts after each new message.')], ephemeral: true });
    }
    if (sub === 'remove') {
      const row = db.getSticky(i.channel.id);
      if (!row) return i.reply({ embeds: [ui.errEmbed('None', 'No sticky in this channel.')], ephemeral: true });
      if (row.lastMessageId) i.channel.messages.delete(row.lastMessageId).catch(() => {});
      db.deleteSticky(i.channel.id);
      return i.reply({ embeds: [ui.okEmbed('Removed', 'Sticky removed.')], ephemeral: true });
    }
    if (sub === 'toggle') {
      const row = db.getSticky(i.channel.id);
      if (!row) return i.reply({ embeds: [ui.errEmbed('None', 'No sticky in this channel.')], ephemeral: true });
      const next = !row.enabled;
      db.setStickyEnabled(i.channel.id, next);
      return i.reply({ embeds: [ui.okEmbed('Toggled', `Sticky ${next ? 'enabled' : 'disabled'}.`)] });
    }
    if (sub === 'list') {
      const rows = db.listStickies(i.guildId);
      return i.reply({ embeds: [ui.embed('Sticky messages', rows.length ? rows.map(r => `<#${r.channelId}> — ${r.enabled ? '🟢' : '⚪'} — ${(r.data.title || '').slice(0, 60)}`).join('\n') : 'None configured.')], ephemeral: true });
    }
  }
});

// =============================================================================
// AUTORESPONDER / AUTOREACTOR
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('autoresponder').setDescription('Auto-reply on keyword match.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open the Auto Responder panel')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).autoresponder;
    await i.reply({ ...ui.autoresponderEmbed(cfg), ephemeral: true });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('autoreactor').setDescription('Auto-react on keyword match.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open the Auto Reactor panel')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).autoreactor;
    await i.reply({ ...ui.autoreactorEmbed(cfg), ephemeral: true });
  }
});

// =============================================================================
// HONEYPOT
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('honeypot').setDescription('Trap channel setup.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open the honeypot panel')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).honeypot;
    await i.reply({ ...ui.honeypotEmbed(cfg), ephemeral: true });
  }
});

// =============================================================================
// LOGGING
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('logsetup').setDescription('Configure logging channels per category.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(i) {
    if (!requireAdmin(i)) return;
    await i.reply({ ...ui.logSetupEmbed(i.guildId), ephemeral: true });
  }
});

// =============================================================================
// ROLE PANELS
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('buttonrolesetup').setDescription('Self-service button role panels.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const panels = db.getConfig(i.guildId).buttonRolePanels || [];
    await i.reply({ ...ui.rolePanelListEmbed(panels, 'button'), ephemeral: true });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('reactionrolesetup').setDescription('Reaction role panels.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const panels = db.getConfig(i.guildId).reactionRolePanels || [];
    await i.reply({ ...ui.rolePanelListEmbed(panels, 'reaction'), ephemeral: true });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('rolepanel').setDescription('Quick button role panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const panels = db.getConfig(i.guildId).buttonRolePanels || [];
    await i.reply({ ...ui.rolePanelListEmbed(panels, 'button'), ephemeral: true });
  }
});

// =============================================================================
// VOICEMASTER
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('voicemaster').setDescription('VoiceMaster — join-to-create voice.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open the VoiceMaster panel')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId);
    await i.reply({ ...ui.vmSetupEmbed(cfg), ephemeral: true });
  }
});

// =============================================================================
// MASSROLE / PREFIX / AUTOROLE
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('massrole').setDescription('Give a role to every human or bot.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(s => s.setName('humans').setDescription('All non-bot members')
      .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand(s => s.setName('bots').setDescription('All bots')
      .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true))),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const sub = i.options.getSubcommand();
    const role = i.options.getRole('role', true);
    const me = i.guild.members.me;
    if (role.position >= me.roles.highest.position) return i.reply({ embeds: [ui.errEmbed('Hierarchy', 'Role is above mine.')], ephemeral: true });
    await i.deferReply({ ephemeral: true });
    const wantBots = sub === 'bots';
    await i.guild.members.fetch().catch(() => {});
    const targets = [...i.guild.members.cache.values()].filter(m => (wantBots ? m.user.bot : !m.user.bot) && !m.roles.cache.has(role.id));
    let ok = 0, failed = 0;
    for (let n = 0; n < targets.length; n += 5) {
      const batch = targets.slice(n, n + 5);
      const r = await Promise.allSettled(batch.map(m => m.roles.add(role, 'massrole')));
      for (const x of r) x.status === 'fulfilled' ? ok++ : failed++;
    }
    await i.editReply({ embeds: [ui.okEmbed('Done', `${ok} updated, ${failed} failed.`)] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('prefix').setDescription('Set the server command prefix.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('prefix').setDescription('New prefix').setRequired(true).setMaxLength(5)),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const p = i.options.getString('prefix', true).trim();
    if (!p) return i.reply({ embeds: [ui.errEmbed('Invalid', 'Empty prefix.')], ephemeral: true });
    db.saveConfig(i.guildId, { prefix: p });
    await i.reply({ embeds: [ui.okEmbed('Updated', `Prefix is now \`${p}\`.`) ] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('autorole').setDescription('Set the auto-role for new members.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('target').setDescription('Who gets it').setRequired(true)
      .addChoices({ name: 'Humans', value: 'humans' }, { name: 'Bots', value: 'bots' }, { name: 'Everyone', value: 'everyone' }))
    .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const target = i.options.getString('target', true);
    const role = i.options.getRole('role', true);
    db.saveConfig(i.guildId, { autorole: { enabled: true, target, roleId: role.id } });
    await i.reply({ embeds: [ui.okEmbed('Autorole set', `**${target}** → ${role}`)] });
  }
});

// =============================================================================
// WHITELIST
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('whitelist').setDescription('Anti-Nuke exemptions.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('add').setDescription('Exempt a user').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove exemption').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('List exempt users')),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
      const ids = db.listWhitelist(i.guildId);
      return i.reply({ embeds: [ui.embed('🛡️ Anti-Nuke Whitelist', ids.length ? ids.map((id, n) => `${n + 1}. <@${id}>`).join('\n') : 'Empty.')], ephemeral: true });
    }
    const user = i.options.getUser('user', true);
    if (sub === 'add') { db.addToWhitelist(i.guildId, user.id); return i.reply({ embeds: [ui.okEmbed('Added', `${user} whitelisted.`)] }); }
    db.removeFromWhitelist(i.guildId, user.id);
    return i.reply({ embeds: [ui.okEmbed('Removed', `${user} removed.`)] });
  }
});

// =============================================================================
// EMOJIS (public — admins can change their own server emoji overrides)
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('emojis').setDescription('Manage the emoji registry.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('list').setDescription('List registered emojis'))
    .addSubcommand(s => s.setName('set').setDescription('Set an emoji override')
      .addStringOption(o => o.setName('key').setDescription('Key').setRequired(true))
      .addStringOption(o => o.setName('value').setDescription('Emoji character or <:name:id>').setRequired(true)))
    .addSubcommand(s => s.setName('reset').setDescription('Reset to default')
      .addStringOption(o => o.setName('key').setDescription('Key').setRequired(true))),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
      const overrides = db.getAllEmojiOverrides();
      const keys = Object.keys(ui.EMOJI);
      const lines = keys.map(k => `\`${k}\` → ${overrides[k] || 'default'} ${ui.emoji(k)}`);
      return i.reply({ embeds: [ui.embed('😀 Emoji Registry', lines.join('\n'))], ephemeral: true });
    }
    if (sub === 'set') {
      const key = i.options.getString('key', true);
      const value = i.options.getString('value', true).trim();
      if (!value) return i.reply({ embeds: [ui.errEmbed('Invalid', 'Empty value.')], ephemeral: true });
      db.setEmojiOverride(key, value);
      return i.reply({ embeds: [ui.okEmbed('Set', `\`${key}\` → ${value}`)] });
    }
    db.resetEmojiOverride(i.options.getString('key', true));
    return i.reply({ embeds: [ui.okEmbed('Reset', 'Emoji reset.')] });
  }
});

// =============================================================================
// AI
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('ask').setDescription('Ask the AunXz AI assistant.')
    .addStringOption(o => o.setName('question').setDescription('Your question').setRequired(true).setMaxLength(1500))
    .addBooleanOption(o => o.setName('clear').setDescription('Reset your conversation memory')),
  async execute(i) {
    if (!process.env.GROQ_API_KEY) return i.reply({ embeds: [ui.errEmbed('Not Configured', 'Set `GROQ_API_KEY` in your environment.')], ephemeral: true });
    const question = i.options.getString('question', true).trim();
    const clear = i.options.getBoolean('clear');
    const key = `${i.guildId || 'dm'}:${i.user.id}`;
    if (clear) askHistory.delete(key);
    await i.deferReply();
    const history = askHistory.get(key) || [];
    const cmdList = commands.map(c => `/${c.data.name}`).join(', ');
    const cfg = i.guildId ? db.getConfig(i.guildId) : {};
    const prompt = `You are AunXz's assistant. Commands: ${cmdList}.
Guild prefix: ${cfg.prefix || '!'}.
Only reference the commands above. Never invent commands or claim to perform actions. Be concise.`;
    try {
      const result = await sys.groqChat([
        { role: 'system', content: prompt },
        ...history.slice(-6),
        { role: 'user', content: question }
      ], { maxTokens: 700, temperature: 0.3 });
      askHistory.set(key, [...history, { role: 'user', content: question }, { role: 'assistant', content: result.content }].slice(-8));
      await i.editReply({ embeds: [ui.embed('🤖 AunXz Assistant', result.content.slice(0, 4000)).setFooter({ text: `Groq • ${result.model}` })] });
    } catch (e) {
      const msg = {
        ai_missing_key: 'Groq is not configured.',
        ai_auth: 'Groq rejected the API credentials.',
        ai_model: 'Configured model not found.',
        ai_rate_limited: 'Rate-limited. Try again shortly.',
        ai_timeout: 'Groq took too long.'
      }[e.code] || 'AI unavailable.';
      await i.editReply({ embeds: [ui.errEmbed('AI Error', msg)] });
    }
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('templategen').setDescription('AI-powered server template generator.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(i) {
    if (!requireAdmin(i)) return;
    if (!process.env.GROQ_API_KEY) return i.reply({ embeds: [ui.errEmbed('Not Configured', 'Groq not configured.')], ephemeral: true });
    const row = ui.row(
      ui.btn('tgen:type:gaming', 'Gaming', ButtonStyle.Primary),
      ui.btn('tgen:type:community', 'Community', ButtonStyle.Primary),
      ui.btn('tgen:type:creator', 'Creator', ButtonStyle.Primary),
      ui.btn('tgen:type:support', 'Support', ButtonStyle.Primary),
      ui.btn('tgen:type:other', 'Other…', ButtonStyle.Secondary)
    );
    await i.reply({ embeds: [ui.embed('🧩 Template Generator', 'Step 1: Choose the server type.')], components: [row], ephemeral: true });
  }
});

// =============================================================================
// STAFF APPLICATIONS
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('staffapplicationssetup').setDescription('Configure the staff application workflow.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).staffApplications;
    await i.reply({ ...ui.applicationsEmbed(cfg), ephemeral: true });
  }
});

// =============================================================================
// BIRTHDAYS
// =============================================================================
commands.push({
  data: new SlashCommandBuilder().setName('birthdaysetup').setDescription('Configure the birthday system.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(i) {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).birthdays;
    await i.reply({ ...ui.birthdayEmbed(cfg), ephemeral: true });
  }
});

// =============================================================================
// OWNER-ONLY COMMANDS
// All are marked ownerOnly: true, so index.js registers them only to
// GUILD_ID / OWNER_GUILD_ID instead of globally.
// =============================================================================
commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('owner').setDescription('[Owner] Bot management.')
    .addSubcommand(s => s.setName('stats').setDescription('Bot stats'))
    .addSubcommand(s => s.setName('blacklist').setDescription('Block a user globally')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason')))
    .addSubcommand(s => s.setName('unblacklist').setDescription('Remove from blacklist')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('maintenance').setDescription('Toggle maintenance mode'))
    .addSubcommand(s => s.setName('errors').setDescription('Show recent errors')),
  async execute(i) {
    if (!sys.isOwner(i.user.id)) return i.reply({ embeds: [ui.errEmbed('Denied', 'Owner only.')], ephemeral: true });
    const sub = i.options.getSubcommand();
    if (sub === 'stats') {
      const mem = process.memoryUsage();
      return i.reply({ embeds: [ui.embed('📊 Bot Stats').addFields(
        { name: 'Guilds', value: String(i.client.guilds.cache.size), inline: true },
        { name: 'Users', value: String(i.client.users.cache.size), inline: true },
        { name: 'WS ping', value: `${i.client.ws.ping}ms`, inline: true },
        { name: 'RSS', value: `${(mem.rss / 1048576).toFixed(1)} MB`, inline: true },
        { name: 'Uptime', value: `${Math.floor(process.uptime() / 3600)}h`, inline: true },
        { name: 'Maintenance', value: String(db.getOwnerConfig().maintenance || false), inline: true }
      )], ephemeral: true });
    }
    if (sub === 'blacklist') { const u = i.options.getUser('user', true); db.addGlobalBlacklist(u.id); return i.reply({ embeds: [ui.okEmbed('Blacklisted', `${u.tag}`)] }); }
    if (sub === 'unblacklist') { const u = i.options.getUser('user', true); db.removeGlobalBlacklist(u.id); return i.reply({ embeds: [ui.okEmbed('Removed', `${u.tag}`)] }); }
    if (sub === 'maintenance') {
      const cur = db.getOwnerConfig().maintenance || false;
      db.saveOwnerConfig({ maintenance: !cur });
      return i.reply({ embeds: [ui.okEmbed('Maintenance', `Now: ${!cur}`)] });
    }
    if (sub === 'errors') {
      const rows = db.listErrors().slice(0, 10);
      return i.reply({ embeds: [ui.embed('Recent Errors', rows.length ? rows.map(r => `**#${r.id}** — <t:${Math.floor(r.ts / 1000)}:R> — ${(r.message || '').slice(0, 150)}`).join('\n') : 'No errors logged.')], ephemeral: true });
    }
  }
});

// Short helper for the very small owner-only utilities
function ownerShort(name, description, build) {
  const b = new SlashCommandBuilder().setName(name).setDescription(description);
  build?.(b);
  return {
    ownerOnly: true,
    data: b,
    async execute(i) {
      if (!sys.isOwner(i.user.id)) return i.reply({ embeds: [ui.errEmbed('Denied', 'Owner only.')], ephemeral: true });
      return await build ? build._run(i) : i.reply({ embeds: [ui.infoEmbed(name, 'No implementation yet.')], ephemeral: true });
    }
  };
}

commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('backup').setDescription('[Owner] Download a full SQLite backup of the bot database.'),
  async execute(i) {
    if (!sys.isOwner(i.user.id)) return i.reply({ embeds: [ui.errEmbed('Denied', 'Owner only.')], ephemeral: true });
    await i.deferReply({ ephemeral: true });
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const tmp = path.join(os.tmpdir(), `aunxz-backup-${Date.now()}.sqlite`);
      await db.db.backup(tmp);
      const buf = fs.readFileSync(tmp);
      fs.unlinkSync(tmp);
      await i.editReply({ content: 'Database backup', files: [{ attachment: buf, name: 'aunxz-backup.sqlite' }] });
    } catch (e) {
      await i.editReply({ embeds: [ui.errEmbed('Backup failed', String(e.message || e))] });
    }
  }
});

commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('dbstats').setDescription('[Owner] Database size and record counts.'),
  async execute(i) {
    if (!sys.isOwner(i.user.id)) return i.reply({ embeds: [ui.errEmbed('Denied', 'Owner only.')], ephemeral: true });
    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const lines = tables.map(t => `\`${t.name}\` — ${db.db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get().c} rows`);
    await i.reply({ embeds: [ui.embed('🗄️ Database Stats', lines.join('\n').slice(0, 3900))], ephemeral: true });
  }
});

commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('stats').setDescription('[Owner] Bot resource statistics.'),
  async execute(i) {
    if (!sys.isOwner(i.user.id)) return i.reply({ embeds: [ui.errEmbed('Denied', 'Owner only.')], ephemeral: true });
    const mem = process.memoryUsage();
    const os = require('os');
    await i.reply({ embeds: [ui.embed('📊 Resource Stats').addFields(
      { name: 'RSS', value: `${(mem.rss / 1048576).toFixed(1)} MB`, inline: true },
      { name: 'Heap', value: `${(mem.heapUsed / 1048576).toFixed(1)} MB`, inline: true },
      { name: 'System', value: `${((os.totalmem() - os.freemem()) / 1048576).toFixed(0)} / ${(os.totalmem() / 1048576).toFixed(0)} MB`, inline: true },
      { name: 'CPU cores', value: String(os.cpus().length), inline: true },
      { name: 'Load', value: os.loadavg().map(x => x.toFixed(2)).join(' '), inline: true },
      { name: 'Uptime', value: `${Math.floor(process.uptime() / 3600)}h`, inline: true }
    )], ephemeral: true });
  }
});

commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('errors').setDescription('[Owner] Browse the error log.')
    .addStringOption(o => o.setName('command').setDescription('Filter by command name'))
    .addBooleanOption(o => o.setName('clear').setDescription('Clear the log')),
  async execute(i) {
    if (!sys.isOwner(i.user.id)) return i.reply({ embeds: [ui.errEmbed('Denied', 'Owner only.')], ephemeral: true });
    const command = i.options.getString('command');
    if (i.options.getBoolean('clear')) {
      const n = db.clearErrors(command);
      return i.reply({ embeds: [ui.okEmbed('Cleared', `Removed ${n} error(s).`)], ephemeral: true });
    }
    const rows = db.listErrors(command).slice(0, 15);
    await i.reply({ embeds: [ui.embed('🐞 Error Log', rows.length ? rows.map(r => `**#${r.id}** <t:${Math.floor(r.ts / 1000)}:R> — ${r.command || 'n/a'} — ${(r.message || '').slice(0, 180)}`).join('\n').slice(0, 3900) : 'No errors.')], ephemeral: true });
  }
});

commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('commandstats').setDescription('[Owner] Command usage stats.'),
  async execute(i) {
    if (!sys.isOwner(i.user.id)) return i.reply({ embeds: [ui.errEmbed('Denied', 'Owner only.')], ephemeral: true });
    const rows = db.commandUsage({ range: 'all' });
    const lines = rows.slice(0, 30).map((r, n) => {
      const total = (r.ok || 0) + (r.fail || 0);
      return `**${n + 1}.** \`/${r.name}\` — ${total} uses • ${total ? (((r.fail || 0) / total) * 100).toFixed(1) : '0.0'}% fail`;
    });
    await i.reply({ embeds: [ui.embed('📈 Command Usage', lines.join('\n').slice(0, 3900) || 'No usage yet.')], ephemeral: true });
  }
});

commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('commandtoggle').setDescription('[Owner] Enable or disable a command.')
    .addStringOption(o => o.setName('name').setDescription('Command name').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason shown to users')),
  async execute(i) {
    if (!sys.isOwner(i.user.id)) return i.reply({ embeds: [ui.errEmbed('Denied', 'Owner only.')], ephemeral: true });
    const name = i.options.getString('name', true).toLowerCase().replace(/^\//, '');
    const reason = (i.options.getString('reason') || '').slice(0, 200) || null;
    const existing = db.getToggle(name);
    if (existing) { db.removeToggle(name); return i.reply({ embeds: [ui.okEmbed('Enabled', `\`/${name}\` re-enabled.`)] }); }
    db.setToggle(name, reason, i.user.id);
    return i.reply({ embeds: [ui.okEmbed('Disabled', `\`/${name}\` disabled${reason ? ` — ${reason}` : ''}.`)] });
  }
});

commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('bl').setDescription('[Owner] Block commands in servers owned by a user.')
    .addSubcommand(s => s.setName('add').setDescription('Blacklist a server owner')
      .addStringOption(o => o.setName('user_id').setDescription('Discord user ID').setRequired(true).setMinLength(15).setMaxLength(25)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove from blacklist')
      .addStringOption(o => o.setName('user_id').setDescription('Discord user ID').setRequired(true).setMinLength(15).setMaxLength(25)))
    .addSubcommand(s => s.setName('list').setDescription('List blacklisted server owners')),
  async execute(i) {
    if (!sys.isOwner(i.user.id)) return i.reply({ embeds: [ui.errEmbed('Denied', 'Owner only.')], ephemeral: true });
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
      const ids = db.getGlobalBlacklist();
      return i.reply({ embeds: [ui.embed('🛡️ Global Server-Owner Blacklist', ids.length ? ids.map((id, n) => `**${n + 1}.** <@${id}> — \`${id}\``).join('\n') : 'Empty.')], ephemeral: true });
    }
    const id = i.options.getString('user_id', true).trim();
    if (!/^\d{15,25}$/.test(id)) return i.reply({ embeds: [ui.errEmbed('Invalid', 'Enter a numeric user ID.')], ephemeral: true });
    if (sub === 'add') { db.addGlobalBlacklist(id); return i.reply({ embeds: [ui.okEmbed('Added', `<@${id}> blacklisted.`)] }); }
    db.removeGlobalBlacklist(id);
    return i.reply({ embeds: [ui.okEmbed('Removed', `<@${id}> removed.`)] });
  }
});

commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('maintenance').setDescription('[Owner] Toggle maintenance mode.'),
  async execute(i) {
    if (!sys.isOwner(i.user.id)) return i.reply({ embeds: [ui.errEmbed('Denied', 'Owner only.')], ephemeral: true });
    const cur = db.getOwnerConfig().maintenance || false;
    db.saveOwnerConfig({ maintenance: !cur });
    await i.reply({ embeds: [ui.okEmbed('Maintenance', `Now: ${!cur}`)] });
  }
});

commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('ownerlogsetup').setDescription('[Owner] Configure global owner logging channels.'),
  async execute(i) {
    if (!sys.isOwner(i.user.id)) return i.reply({ embeds: [ui.errEmbed('Denied', 'Owner only.')], ephemeral: true });
    const cfg = db.getOwnerConfig();
    await i.reply({ ...ui.ownerLogSetupEmbed(cfg), ephemeral: true });
  }
});

commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('export').setDescription('[Owner] Export a guild configuration.')
    .addStringOption(o => o.setName('guild_id').setDescription('Server ID (default: this server)')),
  async execute(i) {
    if (!sys.isOwner(i.user.id)) return i.reply({ embeds: [ui.errEmbed('Denied', 'Owner only.')], ephemeral: true });
    const gid = String(i.options.getString('guild_id') || i.guildId || '').trim();
    if (!/^\d{15,25}$/.test(gid)) return i.reply({ embeds: [ui.errEmbed('Invalid', 'Provide a valid server ID.')], ephemeral: true });
    const data = db.exportGuild(gid);
    const buf = Buffer.from(JSON.stringify(data, null, 2));
    await i.reply({ content: `Export for \`${gid}\``, files: [{ attachment: buf, name: `guild-${gid}.json` }], ephemeral: true });
  }
});

// =============================================================================
// EXPORTS
// =============================================================================
module.exports = {
  commands,
  askHistory,
  isAdmin, requireAdmin, parseColor
};