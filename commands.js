// AunXz/commands.js — every slash command definition + execute handler.
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

// ---------- shared helpers ----------
const isAdmin = i => i.member?.permissions.has(PermissionFlagsBits.Administrator) || sys.isOwner(i.user.id);
const requireAdmin = i => { if (!isAdmin(i)) { i.reply({ embeds: [ui.errEmbed('Permission Required', 'You need **Administrator**.')], ephemeral: true }).catch(() => {}); return false; } return true; };
const parseColor = s => { const m = String(s || '').trim().match(/^(?:#|0x)?([0-9a-f]{6})$/i); return m ? parseInt(m[1], 16) : null; };

const commands = [];
const askHistory = new Map(); // key -> [messages]

// ---------- /help ----------
commands.push({
  data: new SlashCommandBuilder().setName('help').setDescription('Browse AunXz commands.'),
  execute: async i => { const e = ui.helpMenuEmbed(i.client); await i.reply({ ...e, ephemeral: false }); }
});

// ---------- /ping ----------
commands.push({
  data: new SlashCommandBuilder().setName('ping').setDescription('Check latency.'),
  execute: async i => {
    const t = Date.now();
    await i.reply({ embeds: [ui.infoEmbed('Ping', 'Pinging…')] });
    await i.editReply({ embeds: [ui.infoEmbed('Pong', `**WebSocket:** ${i.client.ws.ping}ms\n**RTT:** ${Date.now() - t}ms`)] });
  }
});

// ---------- /botinfo ----------
commands.push({
  data: new SlashCommandBuilder().setName('botinfo').setDescription('Bot information.'),
  execute: async i => {
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

// ---------- /serverinfo ----------
commands.push({
  data: new SlashCommandBuilder().setName('serverinfo').setDescription('Server information.'),
  execute: async i => {
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

// ---------- /userinfo ----------
commands.push({
  data: new SlashCommandBuilder().setName('userinfo').setDescription('User information.')
    .addUserOption(o => o.setName('user').setDescription('Target')),
  execute: async i => {
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

// ---------- /avatar ----------
commands.push({
  data: new SlashCommandBuilder().setName('avatar').setDescription('Show a user avatar.')
    .addUserOption(o => o.setName('user').setDescription('Target')),
  execute: async i => {
    const user = i.options.getUser('user') || i.user;
    const url = user.displayAvatarURL({ size: 1024 });
    await i.reply({ embeds: [ui.embed(`${user.username}`).setImage(url).setDescription(`[Full size](${url})`)] });
  }
});

// ---------- /snipe ----------
commands.push({
  data: new SlashCommandBuilder().setName('snipe').setDescription('Recent deleted/edited messages.')
    .addChannelOption(o => o.setName('channel').setDescription('Channel (default: this one)')),
  execute: async i => {
    const ch = i.options.getChannel('channel') || i.channel;
    const view = sys.snipeView(i.guildId, ch.id, 0);
    await i.reply({ ...view, ephemeral: true });
  }
});

// ---------- /setup ----------
commands.push({
  data: new SlashCommandBuilder().setName('setup').setDescription('AunXz configuration center.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('panel').setDescription('Module dashboard'))
    .addSubcommand(s => s.setName('wizard').setDescription('Guided setup'))
    .addSubcommand(s => s.setName('health').setDescription('Run diagnostics'))
    .addSubcommand(s => s.setName('backup').setDescription('Export configuration'))
    .addSubcommand(s => s.setName('restore').setDescription('Restore from backup')),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const sub = i.options.getSubcommand();
    if (sub === 'panel') return i.reply({ ...ui.setupPanelEmbed(i.guildId), ephemeral: true });
    if (sub === 'wizard') {
      const row = ui.row(new StringSelectMenuBuilder().setCustomId('wizard:modules')
        .setPlaceholder('Modules to enable').setMinValues(1).setMaxValues(20)
        .addOptions(ui.SETUP_MODULES.filter(m => m.cfgKey).map(m => ({ label: m.label, value: m.key, description: m.desc.slice(0, 100) }))));
      return i.reply({ embeds: [ui.infoEmbed('Guided Wizard', 'Select modules to enable. Nothing is saved until you confirm.')], components: [row], ephemeral: true });
    }
    if (sub === 'health') {
      await i.deferReply({ ephemeral: true });
      const issues = await sys.healthCheck(i.guild);
      const desc = issues.length
        ? issues.map(x => `${x.severity === 'high' ? '🔴' : x.severity === 'medium' ? '🟡' : '🟢'} ${x.text}`).join('\n')
        : 'All checks passed.';
      return i.editReply({ embeds: [ui.embed('🩺 Health Check', desc)] });
    }
    if (sub === 'backup') {
      const buf = Buffer.from(JSON.stringify(db.exportGuild(i.guildId), null, 2));
      return i.reply({ content: 'Backup attached.', files: [{ attachment: buf, name: `aunxz-${i.guildId}.json` }], ephemeral: true });
    }
    if (sub === 'restore') {
      const modal = new ModalBuilder().setCustomId('setup:restore:modal').setTitle('Restore Configuration');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('payload').setLabel('Paste export JSON').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)));
      return i.showModal(modal);
    }
  }
});

// ---------- /mod ----------
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
      .addIntegerOption(o => o.setName('minutes').setDescription('1-40320').setRequired(true).setMinValue(1).setMaxValue(40320))
      .addStringOption(o => o.setName('reason').setDescription('Reason')))
    .addSubcommand(s => s.setName('untimeout').setDescription('Remove timeout')
      .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)))
    .addSubcommand(s => s.setName('warn').setDescription('Warn a user')
      .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(s => s.setName('warnings').setDescription('View warnings')
      .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)))
    .addSubcommand(s => s.setName('clearwarnings').setDescription('Clear warnings')
      .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)))
    .addSubcommand(s => s.setName('purge').setDescription('Delete messages')
      .addIntegerOption(o => o.setName('count').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100))
      .addUserOption(o => o.setName('user').setDescription('Filter by user')))
    .addSubcommand(s => s.setName('history').setDescription('Case history')
      .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true))),
  execute: async i => {
    const sub = i.options.getSubcommand();
    const g = i.guild;
    if (sub === 'warnings' || sub === 'history') {
      const user = i.options.getUser('user', true);
      const warns = db.getWarns(g.id, user.id);
      const title = sub === 'warnings' ? `Warnings — ${user.tag}` : `Case History — ${user.tag}`;
      return i.reply({ embeds: [ui.embed(title, warns.length ? warns.slice(0, 20).map((w, n) => `**${n + 1}.** ${w.reason} — <@${w.moderatorId}> <t:${Math.floor(w.timestamp / 1000)}:R>`).join('\n') : 'No cases on record.')], ephemeral: true });
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
      if (!deleted) return i.editReply({ embeds: [ui.errEmbed('Failed', 'Bulk delete rejected.')] });
      await sys.logMod(g, { action: '🧹 Purge', moderator: i.user, extra: { Channel: `<#${i.channel.id}>`, Count: deleted.size } });
      return i.editReply({ embeds: [ui.okEmbed('Purged', `Deleted ${deleted.size} message(s).`)] });
    }
    await i.deferReply({ ephemeral: true });
    const user = i.options.getUser('user') || { id: i.options.getString('user_id') };
    const target = await g.members.fetch(user.id).catch(() => null);
    const reason = i.options.getString('reason') || i.user.tag;
    if (!target && sub !== 'unban') return i.editReply({ embeds: [ui.errEmbed('Not Found', 'User not in this server.')] });
    const actions = { ban: 'ban', unban: 'unban', kick: 'kick', timeout: 'timeout', untimeout: 'untimeout', warn: 'warn' };
    const durationMs = sub === 'timeout' ? i.options.getInteger('minutes', true) * 60000 : undefined;
    try {
      await sys.moderate(actions[sub], { guild: g, moderator: i.member, target: sub === 'unban' ? { id: user.id } : target, reason, durationMs });
      await i.editReply({ embeds: [ui.okEmbed('Action Applied', `${sub} → ${user.tag || user.id}`)] });
    } catch (e) {
      await i.editReply({ embeds: [ui.errEmbed('Failed', String(e.message || e))] });
    }
  }
});

// ---------- /antinuke /antilink /antispam /antiraid /antiwebhook /antibot /antialt ----------
function securityCommand(name, cfgKey, desc) {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription(desc)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand(s => s.setName('setup').setDescription('Open setup panel')
        .addStringOption(o => o.setName('state').setDescription('Enable or disable').addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }))),
    execute: async i => {
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
          ui.btn(`setup:toggle:${cfgKey}`, cfg.enabled ? 'Disable' : 'Enable', cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
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

// ---------- /automod ----------
commands.push({
  data: new SlashCommandBuilder().setName('automod').setDescription('AutoMod filters.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open panel')),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).automod;
    const e = ui.buildV2({
      title: '🛡️ AutoMod',
      description: 'Independent filters. Each can be toggled separately.',
      fields: [
        { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
        { name: 'Caps filter', value: cfg.capsFilter ? `${cfg.capsThreshold}%` : 'Off', inline: true },
        { name: 'Invite filter', value: cfg.inviteFilter ? 'On' : 'Off', inline: true },
        { name: 'Bad words', value: String((cfg.badWords || []).length), inline: true }
      ],
      components: [
        ui.row(
          ui.btn('automod:toggle', cfg.enabled ? 'Disable' : 'Enable', cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
          ui.btn('automod:caps', 'Caps Filter', ButtonStyle.Secondary),
          ui.btn('automod:invite', 'Invite Filter', ButtonStyle.Secondary),
          ui.btn('automod:words', 'Bad Words', ButtonStyle.Secondary)
        )
      ]
    });
    await i.reply({ ...e, ephemeral: true });
  }
});

// ---------- /antibadwordsetup ----------
commands.push({
  data: new SlashCommandBuilder().setName('antibadwordsetup').setDescription('Bad-word filter.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).antibadword;
    const e = ui.buildV2({
      title: '🚫 Anti Bad Word',
      description: 'Word-boundary matching so "class" doesn\'t trigger "ass".',
      fields: [
        { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
        { name: 'Action', value: cfg.action, inline: true },
        { name: 'Words', value: String((cfg.words || []).length + (cfg.customWords || []).length), inline: true }
      ],
      components: [ui.row(
        ui.btn('badword:toggle', cfg.enabled ? 'Disable' : 'Enable', cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        ui.btn('badword:words', 'Edit Words', ButtonStyle.Primary)
      )]
    });
    await i.reply({ ...e, ephemeral: true });
    sys.refreshAutomod(i.guildId);
  }
});

// ---------- /welcome /leave ----------
function simpleWelcome(name, cfgKey, desc) {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription(desc)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand(s => s.setName('setup').setDescription('Configure')),
    execute: async i => {
      if (!requireAdmin(i)) return;
      const cfg = db.getConfig(i.guildId)[cfgKey];
      const e = ui.buildV2({
        title: `${name === 'welcome' ? '👋 Welcome' : '🚪 Leave'} — Setup`,
        description: `**Status:** ${cfg.enabled ? '🟢 Enabled' : '⚪ Disabled'}\n**Channel:** ${cfg.channel ? `<#${cfg.channel}>` : 'Not set'}\n**Message:** ${String(cfg.message || '').slice(0, 500)}`,
        components: [
          ui.row(new ChannelSelectMenuBuilder().setCustomId(`${name}:channel`).setPlaceholder('Select channel').setChannelTypes(ChannelType.GuildText)),
          ui.row(
            ui.btn(`${name}:toggle`, cfg.enabled ? 'Disable' : 'Enable', cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
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

// ---------- /greetmessage ----------
commands.push({
  data: new SlashCommandBuilder().setName('greetmessage').setDescription('Welcome card configuration.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open panel')),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).greetmessage;
    await i.reply({ ...ui.greetMessageEmbed(cfg), ephemeral: true });
  }
});

// ---------- /tickets ----------
commands.push({
  data: new SlashCommandBuilder().setName('tickets').setDescription('Configure ticket system.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open setup panel')),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).ticket;
    const e = ui.buildV2({
      title: '🎫 Ticket System',
      description: 'Configure category, staff role, log channel, then post the panel.',
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
          ui.btn('ticket:cfg:toggle', cfg.enabled ? 'Disable' : 'Enable', cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
          ui.btn('ticket:cfg:post', 'Post Panel', ButtonStyle.Success, { emoji: '🎫' })
        )
      ]
    });
    await i.reply({ ...e, ephemeral: true });
  }
});

// ---------- /ticketpanel ----------
commands.push({
  data: new SlashCommandBuilder().setName('ticketpanel').setDescription('Post the ticket panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).ticket;
    if (!cfg.enabled) return i.reply({ embeds: [ui.errEmbed('Disabled', 'Enable tickets with /tickets setup first.')], ephemeral: true });
    const panel = ui.ticketPanelEmbed(cfg, i.guild.name);
    await i.channel.send(panel);
    await i.reply({ embeds: [ui.okEmbed('Posted', 'Ticket panel is live.')], ephemeral: true });
  }
});

// ---------- /ticketconfig ----------
commands.push({
  data: new SlashCommandBuilder().setName('ticketconfig').setDescription('Customize ticket panel appearance.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('title').setDescription('Panel title').setMaxLength(200))
    .addStringOption(o => o.setName('description').setDescription('Panel description').setMaxLength(1000))
    .addStringOption(o => o.setName('category_label').setDescription('Label inside tickets').setMaxLength(100))
    .addStringOption(o => o.setName('welcome_message').setDescription('Welcome text in ticket').setMaxLength(500)),
  execute: async i => {
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

// ---------- /leveling ----------
commands.push({
  data: new SlashCommandBuilder().setName('leveling').setDescription('XP and leveling.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open panel')),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).leveling;
    await i.reply({ ...ui.levelingEmbed(cfg), ephemeral: true });
  }
});

// ---------- /rank ----------
commands.push({
  data: new SlashCommandBuilder().setName('rank').setDescription('Level card.')
    .addUserOption(o => o.setName('user').setDescription('Target')),
  execute: async i => {
    const user = i.options.getUser('user') || i.user;
    const rec = db.getLevel(i.guildId, user.id);
    const info = sys.levelFromXp(rec.xp);
    await i.reply({ embeds: [ui.embed(`${user.username}'s Rank`).setThumbnail(user.displayAvatarURL()).setDescription(`**Level:** ${info.level}\n**XP:** ${info.remaining} / ${info.next}\n**Total XP:** ${rec.xp}`)] });
  }
});

// ---------- /leaderboard ----------
commands.push({
  data: new SlashCommandBuilder().setName('leaderboard').setDescription('Top XP.'),
  execute: async i => {
    const rows = db.topLevels(i.guildId, 25);
    await i.reply({ embeds: [ui.embed(`🏆 ${i.guild.name} Leaderboard`, rows.length
      ? rows.map((r, n) => `**${n + 1}.** <@${r.userId}> — Level ${r.level} • ${r.xp.toLocaleString()} XP`).join('\n')
      : 'No XP recorded yet.')] });
  }
});

// ---------- /xp ----------
commands.push({
  data: new SlashCommandBuilder().setName('xp').setDescription('Manage XP.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand(s => s.setName('add').setDescription('Add XP').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addIntegerOption(o => o.setName('amount').setDescription('XP').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove XP').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addIntegerOption(o => o.setName('amount').setDescription('XP').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('set').setDescription('Set XP').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addIntegerOption(o => o.setName('amount').setDescription('Total').setRequired(true).setMinValue(0)))
    .addSubcommand(s => s.setName('reset').setDescription('Reset XP').addUserOption(o => o.setName('user').setDescription('User').setRequired(true))),
  execute: async i => {
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
    await i.reply({ embeds: [ui.okEmbed('Updated', `${user.tag} — Level ${level}, ${xp} XP`)] });
  }
});

// ---------- /embed ----------
commands.push({
  data: new SlashCommandBuilder().setName('embed').setDescription('Manage saved embeds.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand(s => s.setName('create').setDescription('Save an embed')
      .addStringOption(o => o.setName('name').setDescription('Name').setRequired(true))
      .addStringOption(o => o.setName('title').setDescription('Title'))
      .addStringOption(o => o.setName('description').setDescription('Description'))
      .addStringOption(o => o.setName('color').setDescription('Hex color')))
    .addSubcommand(s => s.setName('send').setDescription('Send a saved embed')
      .addStringOption(o => o.setName('name').setDescription('Name').setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Channel')))
    .addSubcommand(s => s.setName('list').setDescription('List saved embeds'))
    .addSubcommand(s => s.setName('delete').setDescription('Delete a saved embed')
      .addStringOption(o => o.setName('name').setDescription('Name').setRequired(true))),
  execute: async i => {
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
      return i.reply({ embeds: [ui.embed('Saved Embeds', list.length ? list.map(e => `• \`${e.name}\` — <t:${Math.floor(e.updatedAt / 1000)}:R>`).join('\n') : 'None.')], ephemeral: true });
    }
    if (sub === 'delete') {
      const name = i.options.getString('name', true);
      const removed = db.deleteEmbed(i.guildId, name);
      return i.reply({ embeds: [removed ? ui.okEmbed('Deleted', `**${name}** removed.`) : ui.errEmbed('Not Found', 'No such embed.')], ephemeral: true });
    }
  }
});

// ---------- /embedbuilder ----------
commands.push({
  data: new SlashCommandBuilder().setName('embedbuilder').setDescription('Build and post an embed.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const modal = new ModalBuilder().setCustomId('eb:build:modal').setTitle('Embed Builder');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(3000)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Color hex (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(7)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channel').setLabel('Channel ID').setStyle(TextInputStyle.Short).setRequired(true))
    );
    await i.showModal(modal);
  }
});

// ---------- /giveaway ----------
commands.push({
  data: new SlashCommandBuilder().setName('giveaway').setDescription('Giveaways.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents)
    .addSubcommand(s => s.setName('start').setDescription('Start a giveaway')
      .addStringOption(o => o.setName('prize').setDescription('Prize').setRequired(true).setMaxLength(200))
      .addIntegerOption(o => o.setName('minutes').setDescription('Minutes').setRequired(true).setMinValue(1).setMaxValue(43200))
      .addIntegerOption(o => o.setName('winners').setDescription('Winners').setMinValue(1).setMaxValue(20))
      .addChannelOption(o => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s.setName('end').setDescription('End early').addIntegerOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('reroll').setDescription('Reroll').addIntegerOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true).setMinValue(1)).addIntegerOption(o => o.setName('winners').setDescription('Count').setMinValue(1).setMaxValue(20)))
    .addSubcommand(s => s.setName('list').setDescription('List')),
  execute: async i => {
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
      if (!msg) return i.editReply({ embeds: [ui.errEmbed('Failed', 'Could not post giveaway.')] });
      db.updateGiveaway(i.guildId, g.id, { messageId: msg.id, status: 'active' });
      return i.editReply({ embeds: [ui.okEmbed('Started', `Giveaway in <#${ch.id}>.`)] });
    }
    if (sub === 'end') {
      const id = i.options.getInteger('id', true);
      const g = db.getGiveaway(i.guildId, id);
      if (!g) return i.reply({ embeds: [ui.errEmbed('Not Found', 'Giveaway not found.')], ephemeral: true });
      let participants = [];
      try { participants = JSON.parse(g.participants || '[]'); } catch {}
      const valid = participants.filter(x => i.guild.members.cache.has(x));
      const pool = [...valid], winners = [];
      while (winners.length < g.winners && pool.length) winners.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      db.updateGiveaway(i.guildId, g.id, { status: 'ended', winnerIds: JSON.stringify(winners) });
      const ch = g.channelId ? i.guild.channels.cache.get(g.channelId) : null;
      if (ch?.isTextBased()) ch.send({ content: winners.length ? `🎉 Winners for **${g.prize}**: ${winners.map(w => `<@${w}>`).join(', ')}` : `No valid entries for **${g.prize}**.` }).catch(() => {});
      return i.reply({ embeds: [ui.okEmbed('Ended', `${winners.length} winner(s).`)] });
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
      }).join('\n') : 'None yet.';
      return i.reply({ embeds: [ui.embed('🎉 Giveaways', desc)], ephemeral: true });
    }
  }
});

// ---------- /stickymessage ----------
commands.push({
  data: new SlashCommandBuilder().setName('stickymessage').setDescription('Sticky embeds.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand(s => s.setName('set').setDescription('Create/edit sticky here')
      .addStringOption(o => o.setName('title').setDescription('Title').setRequired(true).setMaxLength(200))
      .addStringOption(o => o.setName('description').setDescription('Body').setRequired(true).setMaxLength(3000))
      .addStringOption(o => o.setName('color').setDescription('Hex color')))
    .addSubcommand(s => s.setName('remove').setDescription('Remove sticky here'))
    .addSubcommand(s => s.setName('toggle').setDescription('Enable/disable sticky here'))
    .addSubcommand(s => s.setName('list').setDescription('List stickies')),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const sub = i.options.getSubcommand();
    if (sub === 'set') {
      const title = i.options.getString('title', true);
      const description = i.options.getString('description', true);
      const colorRaw = i.options.getString('color');
      let color;
      if (colorRaw) { color = parseColor(colorRaw); if (color === null) return i.reply({ embeds: [ui.errEmbed('Invalid', 'Bad color.')], ephemeral: true }); }
      db.saveSticky(i.guildId, i.channel.id, { data: { title, description, color }, enabled: true, createdBy: i.user.id });
      return i.reply({ embeds: [ui.okEmbed('Saved', 'Sticky set. It will be reposted after each message.')], ephemeral: true });
    }
    if (sub === 'remove') {
      const row = db.getSticky(i.channel.id);
      if (!row) return i.reply({ embeds: [ui.errEmbed('None', 'No sticky here.')], ephemeral: true });
      if (row.lastMessageId) i.channel.messages.delete(row.lastMessageId).catch(() => {});
      db.deleteSticky(i.channel.id);
      return i.reply({ embeds: [ui.okEmbed('Removed', 'Sticky removed.')], ephemeral: true });
    }
    if (sub === 'toggle') {
      const row = db.getSticky(i.channel.id);
      if (!row) return i.reply({ embeds: [ui.errEmbed('None', 'No sticky here.')], ephemeral: true });
      db.setStickyEnabled(i.channel.id, !row.enabled);
      return i.reply({ embeds: [ui.okEmbed('Toggled', `Sticky ${!row.enabled ? 'enabled' : 'disabled'}.`)] });
    }
    if (sub === 'list') {
      const rows = db.listStickies(i.guildId);
      return i.reply({ embeds: [ui.embed('Sticky messages', rows.length ? rows.map(r => `<#${r.channelId}> — ${r.enabled ? '🟢' : '⚪'} — ${(r.data.title || '').slice(0, 60)}`).join('\n') : 'None.')], ephemeral: true });
    }
  }
});

// ---------- /autoresponder ----------
commands.push({
  data: new SlashCommandBuilder().setName('autoresponder').setDescription('Keyword auto-replies.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open panel')),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).autoresponder;
    await i.reply({ ...ui.autoresponderEmbed(cfg), ephemeral: true });
  }
});

// ---------- /autoreactor ----------
commands.push({
  data: new SlashCommandBuilder().setName('autoreactor').setDescription('Keyword auto-reactions.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open panel')),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).autoreactor;
    await i.reply({ ...ui.autoreactorEmbed(cfg), ephemeral: true });
  }
});

// ---------- /honeypot ----------
commands.push({
  data: new SlashCommandBuilder().setName('honeypot').setDescription('Trap channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open panel')),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).honeypot;
    await i.reply({ ...ui.honeypotEmbed(cfg), ephemeral: true });
  }
});

// ---------- /logsetup ----------
commands.push({
  data: new SlashCommandBuilder().setName('logsetup').setDescription('Configure logging channels.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  execute: async i => {
    if (!requireAdmin(i)) return;
    await i.reply({ ...ui.logSetupEmbed(i.guildId), ephemeral: true });
  }
});

// ---------- /buttonrolesetup ----------
commands.push({
  data: new SlashCommandBuilder().setName('buttonrolesetup').setDescription('Button role panels.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const panels = db.getConfig(i.guildId).buttonRolePanels || [];
    const e = ui.rolePanelListEmbed(panels, 'button');
    await i.reply({ ...e, ephemeral: true });
  }
});

// ---------- /reactionrolesetup ----------
commands.push({
  data: new SlashCommandBuilder().setName('reactionrolesetup').setDescription('Reaction role panels.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const panels = db.getConfig(i.guildId).reactionRolePanels || [];
    const e = ui.rolePanelListEmbed(panels, 'reaction');
    await i.reply({ ...e, ephemeral: true });
  }
});

// ---------- /rolepanel (legacy compatibility) ----------
commands.push({
  data: new SlashCommandBuilder().setName('rolepanel').setDescription('Manage role panels.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const panels = db.getConfig(i.guildId).buttonRolePanels || [];
    const e = ui.rolePanelListEmbed(panels, 'button');
    await i.reply({ ...e, ephemeral: true });
  }
});

// ---------- /voicemaster ----------
commands.push({
  data: new SlashCommandBuilder().setName('voicemaster').setDescription('VoiceMaster setup.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open setup panel')),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).voicemaster;
    const e = ui.buildV2({
      title: '🔊 VoiceMaster — Join to Create',
      description: `**Status:** ${cfg.enabled ? '🟢 Enabled' : '⚪ Disabled'}`,
      fields: [
        { name: 'Hub channel', value: cfg.hubChannelId ? `<#${cfg.hubChannelId}>` : 'Not set', inline: true },
        { name: 'Category', value: cfg.categoryId ? `<#${cfg.categoryId}>` : 'Hub parent', inline: true },
        { name: 'Name template', value: cfg.nameTemplate, inline: false }
      ],
      components: [
        ui.row(new ChannelSelectMenuBuilder().setCustomId('vm:cfg:hub').setPlaceholder('Hub voice channel').setChannelTypes(ChannelType.GuildVoice)),
        ui.row(new ChannelSelectMenuBuilder().setCustomId('vm:cfg:category').setPlaceholder('Category').setChannelTypes(ChannelType.GuildCategory)),
        ui.row(
          ui.btn('vm:cfg:toggle', cfg.enabled ? 'Disable' : 'Enable', cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
          ui.btn('vm:cfg:name', 'Edit Name Template', ButtonStyle.Primary)
        )
      ]
    });
    await i.reply({ ...e, ephemeral: true });
  }
});

// ---------- /massrole ----------
commands.push({
  data: new SlashCommandBuilder().setName('massrole').setDescription('Give a role to every human or bot.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(s => s.setName('humans').setDescription('All non-bot members')
      .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand(s => s.setName('bots').setDescription('All bots')
      .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true))),
  execute: async i => {
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

// ---------- /prefix ----------
commands.push({
  data: new SlashCommandBuilder().setName('prefix').setDescription('Set the server prefix.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('prefix').setDescription('New prefix').setRequired(true).setMaxLength(5)),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const p = i.options.getString('prefix', true).trim();
    if (!p) return i.reply({ embeds: [ui.errEmbed('Invalid', 'Empty prefix.')], ephemeral: true });
    db.saveConfig(i.guildId, { prefix: p });
    await i.reply({ embeds: [ui.okEmbed('Updated', `Prefix is now \`${p}\`.`)] });
  }
});

// ---------- /whitelist ----------
commands.push({
  data: new SlashCommandBuilder().setName('whitelist').setDescription('Anti-Nuke exemptions.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('add').setDescription('Exempt a user').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove exemption').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('List')),
  execute: async i => {
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

// ---------- /emojis ----------
commands.push({
  data: new SlashCommandBuilder().setName('emojis').setDescription('Emoji registry.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('list').setDescription('List overrides'))
    .addSubcommand(s => s.setName('set').setDescription('Set an emoji')
      .addStringOption(o => o.setName('key').setDescription('Key').setRequired(true))
      .addStringOption(o => o.setName('value').setDescription('Emoji').setRequired(true)))
    .addSubcommand(s => s.setName('reset').setDescription('Reset to default')
      .addStringOption(o => o.setName('key').setDescription('Key').setRequired(true))),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
      const overrides = db.getAllEmojiOverrides();
      const keys = Object.keys(ui.EMOJI);
      return i.reply({ embeds: [ui.embed('😀 Emoji Registry', keys.map(k => `\`${k}\` → ${overrides[k] || 'default'} ${ui.emoji(k)}`).join('\n'))], ephemeral: true });
    }
    if (sub === 'set') {
      const key = i.options.getString('key', true);
      const value = i.options.getString('value', true).trim();
      if (!value) return i.reply({ embeds: [ui.errEmbed('Invalid', 'Empty value.')], ephemeral: true });
      db.setEmojiOverride(key, value);
      return i.reply({ embeds: [ui.okEmbed('Set', `\`${key}\` → ${value}`)] });
    }
    if (sub === 'reset') {
      db.resetEmojiOverride(i.options.getString('key', true));
      return i.reply({ embeds: [ui.okEmbed('Reset', 'Emoji reset.')] });
    }
  }
});

// ---------- /ask ----------
commands.push({
  data: new SlashCommandBuilder().setName('ask').setDescription('Ask the AI assistant.')
    .addStringOption(o => o.setName('question').setDescription('Question').setRequired(true).setMaxLength(1500))
    .addBooleanOption(o => o.setName('clear').setDescription('Reset memory')),
  execute: async i => {
    if (!process.env.GROQ_API_KEY) return i.reply({ embeds: [ui.errEmbed('Not Configured', 'Set GROQ_API_KEY in your environment.')], ephemeral: true });
    const question = i.options.getString('question', true).trim();
    const clear = i.options.getBoolean('clear');
    const key = `${i.guildId || 'dm'}:${i.user.id}`;
    if (clear) askHistory.delete(key);
    await i.deferReply();
    const history = askHistory.get(key) || [];
    const cmdList = commands.map(c => `/${c.data.name}`).join(', ');
    const cfg = i.guildId ? db.getConfig(i.guildId) : {};
    const prompt = `You are AunXz's assistant. Commands available: ${cmdList}.
Guild prefix: ${cfg.prefix || '!'}.
Only reference commands listed above. Never invent commands or claim to perform actions. Be concise.`;
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

// ---------- /templategen ----------
commands.push({
  data: new SlashCommandBuilder().setName('templategen').setDescription('AI server template generator.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  execute: async i => {
    if (!requireAdmin(i)) return;
    if (!process.env.GROQ_API_KEY) return i.reply({ embeds: [ui.errEmbed('Not Configured', 'Groq not configured.')], ephemeral: true });
    const row = ui.row(
      ui.btn('tgen:type:gaming', 'Gaming', ButtonStyle.Primary),
      ui.btn('tgen:type:community', 'Community', ButtonStyle.Primary),
      ui.btn('tgen:type:creator', 'Creator', ButtonStyle.Primary),
      ui.btn('tgen:type:support', 'Support', ButtonStyle.Primary),
      ui.btn('tgen:type:other', 'Other…', ButtonStyle.Secondary)
    );
    await i.reply({ embeds: [ui.embed('🧩 Template Generator', 'Step 1: Choose server type.')], components: [row], ephemeral: true });
  }
});

// ---------- /staffapplicationssetup ----------
commands.push({
  data: new SlashCommandBuilder().setName('staffapplicationssetup').setDescription('Staff application workflow.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).staffApplications;
    const e = ui.buildV2({
      title: '📝 Staff Applications',
      description: 'Applicants press Apply, answer questions by DM or form, results go to the review channel.',
      fields: [
        { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
        { name: 'Questions', value: String((cfg.questions || []).length), inline: true },
        { name: 'Review channel', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Not set', inline: true },
        { name: 'Panel channel', value: cfg.panelChannelId ? `<#${cfg.panelChannelId}>` : 'Not set', inline: true }
      ],
      components: [
        ui.row(new ChannelSelectMenuBuilder().setCustomId('app:cfg:review').setPlaceholder('Review channel').setChannelTypes(ChannelType.GuildText)),
        ui.row(new ChannelSelectMenuBuilder().setCustomId('app:cfg:panel').setPlaceholder('Panel channel').setChannelTypes(ChannelType.GuildText)),
        ui.row(
          ui.btn('app:cfg:toggle', cfg.enabled ? 'Disable' : 'Enable', cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
          ui.btn('app:cfg:questions', 'Edit Questions', ButtonStyle.Primary),
          ui.btn('app:cfg:post', 'Post Panel', ButtonStyle.Success)
        )
      ]
    });
    await i.reply({ ...e, ephemeral: true });
  }
});

// ---------- /birthdaysetup ----------
commands.push({
  data: new SlashCommandBuilder().setName('birthdaysetup').setDescription('Birthday system.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  execute: async i => {
    if (!requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).birthdays;
    const e = ui.buildV2({
      title: '🎂 Birthday System',
      description: 'Members set their birthday. The bot posts a wish on the configured channel.',
      fields: [
        { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
        { name: 'Panel channel', value: cfg.panelChannelId ? `<#${cfg.panelChannelId}>` : 'Not set', inline: true },
        { name: 'Wish channel', value: cfg.wishChannelId ? `<#${cfg.wishChannelId}>` : 'Not set', inline: true },
        { name: 'Message', value: cfg.wishMessage, inline: false }
      ],
      components: [
        ui.row(new ChannelSelectMenuBuilder().setCustomId('bday:cfg:panel').setPlaceholder('Panel channel').setChannelTypes(ChannelType.GuildText)),
        ui.row(new ChannelSelectMenuBuilder().setCustomId('bday:cfg:wish').setPlaceholder('Wish channel').setChannelTypes(ChannelType.GuildText)),
        ui.row(
          ui.btn('bday:cfg:toggle', cfg.enabled ? 'Disable' : 'Enable', cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
          ui.btn('bday:cfg:message', 'Edit Message', ButtonStyle.Primary),
          ui.btn('bday:cfg:post', 'Post Panel', ButtonStyle.Success)
        )
      ]
    });
    await i.reply({ ...e, ephemeral: true });
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
    .addSubcommand(s => s.setName('maintenance').setDescription('Toggle maintenance'))
    .addSubcommand(s => s.setName('errors').setDescription('Recent errors')),
  execute: async i => {
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
    if (sub === 'maintenance') { const cur = db.getOwnerConfig().maintenance || false; db.saveOwnerConfig({ maintenance: !cur }); return i.reply({ embeds: [ui.okEmbed('Maintenance', `Now: ${!cur}`)] }); }
    if (sub === 'errors') {
      const rows = db.listErrors().slice(0, 10);
      return i.reply({ embeds: [ui.embed('Recent Errors', rows.length ? rows.map(r => `**#${r.id}** — <t:${Math.floor(r.ts / 1000)}:R> — ${(r.message || '').slice(0, 150)}`).join('\n') : 'No errors.')], ephemeral: true });
    }
  }
});

module.exports = { commands, askHistory, isAdmin, requireAdmin, parseColor };