// commands.js — every slash command: its SlashCommandBuilder definition + execute(interaction).
// Exported as a flat array so index.js can both register them with Discord and route
// interactionCreate to the right handler by command name.

const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType
} = require('discord.js');
const db = require('./database');
const ui = require('./ui');
const sys = require('./systems');

const OWNER_IDS = (process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isOwner = (id) => OWNER_IDS.includes(id);

function requireAdmin(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to use this.')], ephemeral: true });
    return false;
  }
  return true;
}

const commands = [];

// ---------------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------------
commands.push({
  data: new SlashCommandBuilder().setName('help').setDescription('Browse everything the bot can do.'),
  async execute(interaction) {
    await interaction.reply({ embeds: [ui.helpHomeEmbed(interaction.client)], components: [ui.helpSelectRow()] });
  }
});

// ---------------------------------------------------------------------------------
// Setup commands — every configurable feature follows /<feature> setup.
// ---------------------------------------------------------------------------------
const GENERIC_MODULES = [
  'welcome', 'leave', 'boost', 'autorole', 'automod', 'starboard', 'inviteTracker',
  'suggestions', 'polls', 'snipeEnabled', 'nsfwFilter', 'reactionRoles', 'birthdays'
];
const ALL_MODULE_NAMES = [
  'antinuke', 'antilink', 'antispam', 'antiraid', 'voicemaster', 'greetvoice', 'greetmessage',
  'leveling', 'tickets', 'logs', ...GENERIC_MODULES
];
const GENERIC_COMMANDS = {
  welcome: 'welcome', leave: 'leave', boost: 'boost', autorole: 'autorole', automod: 'automod',
  starboard: 'starboard', invitetracker: 'inviteTracker', suggestions: 'suggestions', polls: 'polls',
  snipe: 'snipeEnabled', nswffilter: 'nsfwFilter', reactionroles: 'reactionRoles', birthdays: 'birthdays'
};

const PANEL_MODULES = ['antinuke', 'antilink', 'antispam', 'antiraid', 'voicemaster', 'greetmessage', 'leveling', 'tickets'];

function extractModuleOptions(sub, interaction) {
  const o = { state: interaction.options.getString('state') };
  if (sub === 'antinuke') {
    o.punishment = interaction.options.getString('punishment');
    o.threshold = interaction.options.getInteger('threshold');
    o.window_seconds = interaction.options.getInteger('window_seconds');
  } else if (sub === 'antilink') {
    o.mode = interaction.options.getString('mode');
    const r = interaction.options.getRole('bypass_role'); o.bypass_role_id = r ? r.id : null;
  } else if (sub === 'antispam') {
    o.max_messages = interaction.options.getInteger('max_messages');
    o.window_seconds = interaction.options.getInteger('window_seconds');
    o.punishment = interaction.options.getString('punishment');
  } else if (sub === 'antiraid') {
    o.join_threshold = interaction.options.getInteger('join_threshold');
    o.window_seconds = interaction.options.getInteger('window_seconds');
    o.min_account_age_days = interaction.options.getInteger('min_account_age_days');
    o.action = interaction.options.getString('action');
  } else if (sub === 'voicemaster') {
    const h = interaction.options.getChannel('hub_channel'); o.hub_channel_id = h ? h.id : null;
    const c = interaction.options.getChannel('category'); o.category_id = c ? c.id : null;
  } else if (sub === 'greetmessage') {
    const c = interaction.options.getChannel('channel'); o.channel_id = c ? c.id : null;
    o.message = interaction.options.getString('message');
    o.image = interaction.options.getString('image');
  } else if (sub === 'leveling') {
    const c = interaction.options.getChannel('channel'); o.channel_id = c ? c.id : null;
    o.xp_per_message = interaction.options.getInteger('xp_per_message');
    o.cooldown_seconds = interaction.options.getInteger('cooldown_seconds');
    o.reward_level = interaction.options.getInteger('reward_level');
    const r = interaction.options.getRole('reward_role'); o.reward_role_id = r ? r.id : null;
  } else if (sub === 'tickets') {
    const c = interaction.options.getChannel('category'); o.category_id = c ? c.id : null;
    const r = interaction.options.getRole('support_role'); o.support_role_id = r ? r.id : null;
    const l = interaction.options.getChannel('log_channel'); o.log_channel_id = l ? l.id : null;
    o.panel_title = interaction.options.getString('panel_title');
    o.panel_description = interaction.options.getString('panel_description');
    o.panel_thumbnail = interaction.options.getString('panel_thumbnail');
    o.panel_image = interaction.options.getString('panel_image');
    o.category_label = interaction.options.getString('category_label');
    o.welcome_message = interaction.options.getString('welcome_message');
    o.welcome_thumbnail = interaction.options.getString('welcome_thumbnail');
    o.welcome_image = interaction.options.getString('welcome_image');
  }
  return o;
}

function buildModulePatch(sub, guildId, o) {
  const patch = {};
  const state = o.state;
  if (sub === 'antinuke') {
    patch.antinuke = {};
    if (state) patch.antinuke.enabled = state === 'enable';
    if (o.punishment) patch.antinuke.punishment = o.punishment;
    if (o.threshold) Object.assign(patch.antinuke, {
      maxChannelDeletes: o.threshold, maxChannelCreates: o.threshold, maxRoleDeletes: o.threshold,
      maxRoleCreates: o.threshold, maxBans: o.threshold, maxKicks: o.threshold,
      maxWebhookCreates: o.threshold, maxRoleUpdates: o.threshold
    });
    if (o.window_seconds) patch.antinuke.windowSeconds = o.window_seconds;
  } else if (sub === 'antilink') {
    patch.antilink = {};
    if (state) patch.antilink.enabled = state === 'enable';
    if (o.mode) patch.antilink.mode = o.mode;
    if (o.bypass_role_id) patch.antilink.bypassRoleId = o.bypass_role_id;
  } else if (sub === 'antispam') {
    patch.antispam = {};
    if (state) patch.antispam.enabled = state === 'enable';
    if (o.max_messages) patch.antispam.maxMessages = o.max_messages;
    if (o.window_seconds) patch.antispam.windowSeconds = o.window_seconds;
    if (o.punishment) patch.antispam.punishment = o.punishment;
  } else if (sub === 'antiraid') {
    patch.antiraid = {};
    if (state) patch.antiraid.enabled = state === 'enable';
    if (o.join_threshold) patch.antiraid.joinThreshold = o.join_threshold;
    if (o.window_seconds) patch.antiraid.windowSeconds = o.window_seconds;
    if (o.min_account_age_days !== null && o.min_account_age_days !== undefined) patch.antiraid.minAccountAgeDays = o.min_account_age_days;
    if (o.action) patch.antiraid.action = o.action;
  } else if (sub === 'voicemaster') {
    patch.voicemaster = {};
    if (state) patch.voicemaster.enabled = state === 'enable';
    if (o.hub_channel_id) patch.voicemaster.hubChannelId = o.hub_channel_id;
    if (o.category_id) patch.voicemaster.categoryId = o.category_id;
  } else if (sub === 'greetmessage') {
    patch.greetmessage = {};
    if (state) patch.greetmessage.enabled = state === 'enable';
    if (o.channel_id) patch.greetmessage.channelId = o.channel_id;
    if (o.message) patch.greetmessage.message = o.message;
    if (o.image) patch.greetmessage.image = o.image;
  } else if (sub === 'leveling') {
    patch.leveling = {};
    if (state) patch.leveling.enabled = state === 'enable';
    if (o.channel_id) patch.leveling.channel = o.channel_id;
    if (o.xp_per_message) patch.leveling.xpPerMessage = o.xp_per_message;
    if (o.cooldown_seconds) patch.leveling.cooldownSeconds = o.cooldown_seconds;
    if (o.reward_level && o.reward_role_id) {
      const current = db.getConfig(guildId).leveling.roleRewards;
      patch.leveling.roleRewards = { ...current, [String(o.reward_level)]: o.reward_role_id };
    }
  } else if (sub === 'tickets') {
    patch.ticket = {};
    if (state) patch.ticket.enabled = state === 'enable';
    if (o.category_id) patch.ticket.categoryId = o.category_id;
    if (o.support_role_id) patch.ticket.supportRoleId = o.support_role_id;
    if (o.log_channel_id) patch.ticket.logChannelId = o.log_channel_id;
    if (o.panel_title) patch.ticket.panelTitle = o.panel_title;
    if (o.panel_description) patch.ticket.panelDescription = o.panel_description;
    if (o.panel_thumbnail) patch.ticket.panelThumbnail = o.panel_thumbnail;
    if (o.panel_image) patch.ticket.panelImage = o.panel_image;
    if (o.category_label) patch.ticket.categoryLabel = o.category_label;
    if (o.welcome_message) patch.ticket.welcomeMessage = o.welcome_message;
    if (o.welcome_thumbnail) patch.ticket.welcomeThumbnail = o.welcome_thumbnail;
    if (o.welcome_image) patch.ticket.welcomeImage = o.welcome_image;
  }
  return patch;
}

function addStateOption(subcommand) {
  return subcommand.addStringOption(o => o.setName('state').setDescription('enable or disable').setRequired(false)
    .addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }));
}

function panelSetupData(name, description, optionBuilder) {
  const command = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => {
      sub.setName('setup').setDescription(`Open the ${name} configuration panel.`);
      addStateOption(sub);
      return optionBuilder ? optionBuilder(sub) : sub;
    });
  return command;
}

function panelSetupCommand(name, description, optionBuilder) {
  return {
    data: panelSetupData(name, description, optionBuilder),
    async execute(interaction) {
      if (!requireAdmin(interaction)) return;
      const guildId = interaction.guildId;
      const sub = interaction.options.getSubcommand();
      if (sub !== 'setup') return;
      const o = extractModuleOptions(name, interaction);
      const patch = buildModulePatch(name, guildId, o);
      const cfg = db.saveConfig(guildId, patch);
      if (name === 'voicemaster') {
        return interaction.reply({ embeds: [ui.vmSetupEmbed(cfg)], components: [ui.vmSetupRow(cfg)] });
      }
      return interaction.reply({ embeds: [ui.setupPanelEmbed(name, cfg)], components: [ui.setupPanelRow(name, cfg)] });
    }
  };
}

commands.push({
  data: new SlashCommandBuilder().setName('setup').setDescription('List configurable bot modules.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('list').setDescription('List every configurable module.')),
  async execute(interaction) {
    if (!requireAdmin(interaction)) return;
    await interaction.reply({ embeds: [ui.moduleListEmbed(ALL_MODULE_NAMES)], ephemeral: true });
  }
});

commands.push(panelSetupCommand('antinuke', 'Configure antinuke protection.', sub => sub
  .addStringOption(o => o.setName('punishment').setDescription('ban/kick/strip_roles')
    .addChoices({ name: 'ban', value: 'ban' }, { name: 'kick', value: 'kick' }, { name: 'strip_roles', value: 'strip_roles' }))
  .addIntegerOption(o => o.setName('threshold').setDescription('actions allowed before punishment'))
  .addIntegerOption(o => o.setName('window_seconds').setDescription('time window in seconds'))));

commands.push(panelSetupCommand('antilink', 'Configure antilink.', sub => sub
  .addStringOption(o => o.setName('mode').setDescription('delete/warn/mute')
    .addChoices({ name: 'delete', value: 'delete' }, { name: 'warn', value: 'warn' }, { name: 'mute', value: 'mute' }))
  .addRoleOption(o => o.setName('bypass_role').setDescription('role exempt from antilink'))));

commands.push(panelSetupCommand('antispam', 'Configure antispam.', sub => sub
  .addIntegerOption(o => o.setName('max_messages').setDescription('messages allowed per window'))
  .addIntegerOption(o => o.setName('window_seconds').setDescription('window length in seconds'))
  .addStringOption(o => o.setName('punishment').setDescription('mute/kick/ban')
    .addChoices({ name: 'mute', value: 'mute' }, { name: 'kick', value: 'kick' }, { name: 'ban', value: 'ban' }))));

commands.push(panelSetupCommand('antiraid', 'Configure antiraid.', sub => sub
  .addIntegerOption(o => o.setName('join_threshold').setDescription('joins allowed per window'))
  .addIntegerOption(o => o.setName('window_seconds').setDescription('window length in seconds'))
  .addIntegerOption(o => o.setName('min_account_age_days').setDescription('min account age to allow join'))
  .addStringOption(o => o.setName('action').setDescription('lockdown/kick_new')
    .addChoices({ name: 'lockdown', value: 'lockdown' }, { name: 'kick_new', value: 'kick_new' }))));

commands.push(panelSetupCommand('voicemaster', 'Configure join-to-create voice.', sub => sub
  .addChannelOption(o => o.setName('hub_channel').setDescription('join-to-create voice channel').addChannelTypes(ChannelType.GuildVoice))
  .addChannelOption(o => o.setName('category').setDescription('category for new temporary channels').addChannelTypes(ChannelType.GuildCategory))));

commands.push(panelSetupCommand('greetmessage', 'Configure the text welcome message.', sub => sub
  .addChannelOption(o => o.setName('channel').setDescription('channel to post in').addChannelTypes(ChannelType.GuildText))
  .addStringOption(o => o.setName('message').setDescription('use {user} and {server}'))
  .addStringOption(o => o.setName('image').setDescription('image/GIF URL shown with the greet message'))));

commands.push(panelSetupCommand('leveling', 'Configure the XP/leveling system.', sub => sub
  .addChannelOption(o => o.setName('channel').setDescription('level-up announcement channel').addChannelTypes(ChannelType.GuildText))
  .addIntegerOption(o => o.setName('xp_per_message').setDescription('XP per eligible message'))
  .addIntegerOption(o => o.setName('cooldown_seconds').setDescription('seconds between XP gains'))
  .addIntegerOption(o => o.setName('reward_level').setDescription('level for a role reward'))
  .addRoleOption(o => o.setName('reward_role').setDescription('role granted at reward_level'))));

commands.push(panelSetupCommand('tickets', 'Configure the ticket system.', sub => sub
  .addChannelOption(o => o.setName('category').setDescription('category tickets are created under').addChannelTypes(ChannelType.GuildCategory))
  .addRoleOption(o => o.setName('support_role').setDescription('role that can see/claim tickets'))
  .addChannelOption(o => o.setName('log_channel').setDescription('ticket transcript/log channel').addChannelTypes(ChannelType.GuildText))
  .addStringOption(o => o.setName('panel_title').setDescription('title of the ticket panel'))
  .addStringOption(o => o.setName('panel_description').setDescription('message shown on the ticket panel'))
  .addStringOption(o => o.setName('panel_thumbnail').setDescription('panel thumbnail image/GIF URL'))
  .addStringOption(o => o.setName('panel_image').setDescription('panel banner image/GIF URL'))
  .addStringOption(o => o.setName('category_label').setDescription('category shown inside new tickets'))
  .addStringOption(o => o.setName('welcome_message').setDescription('message shown when a ticket opens'))
  .addStringOption(o => o.setName('welcome_thumbnail').setDescription('ticket welcome thumbnail image/GIF URL'))
  .addStringOption(o => o.setName('welcome_image').setDescription('ticket welcome banner image/GIF URL'))));

commands.push({
  data: new SlashCommandBuilder().setName('logs').setDescription('Configure logging destinations.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Route a log type to a channel.')
      .addStringOption(o => o.setName('type').setDescription('log category').setRequired(true).addChoices(
        { name: 'moderation', value: 'mod' }, { name: 'messages', value: 'message' }, { name: 'members', value: 'member' },
        { name: 'voice', value: 'voice' }, { name: 'antinuke', value: 'antinuke' }, { name: 'server', value: 'server' },
        { name: 'tickets', value: 'ticket' }, { name: 'joins/leaves', value: 'join' }))
      .addChannelOption(o => o.setName('channel').setDescription('channel to send this log type to').setRequired(true).addChannelTypes(ChannelType.GuildText))),
  async execute(interaction) {
    if (!requireAdmin(interaction)) return;
    const type = interaction.options.getString('type');
    const channel = interaction.options.getChannel('channel');
    const cfg = db.saveConfig(interaction.guildId, { logs: { [type]: channel.id } });
    await interaction.reply({ embeds: [ui.configSummaryEmbed('logs', cfg.logs)] });
  }
});

for (const [commandName, moduleName] of Object.entries(GENERIC_COMMANDS)) {
  commands.push({
    data: new SlashCommandBuilder().setName(commandName).setDescription(`Configure ${moduleName}.`)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand(s => s.setName('setup').setDescription(`Enable or disable ${moduleName}.`)
        .addStringOption(o => o.setName('state').setDescription('enable or disable').setRequired(true)
          .addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }))
        .addChannelOption(o => o.setName('channel').setDescription('channel this module should use, if any'))),
    async execute(interaction) {
      if (!requireAdmin(interaction)) return;
      const state = interaction.options.getString('state') === 'enable';
      const channel = interaction.options.getChannel('channel');
      const currentVal = db.getConfig(interaction.guildId)[moduleName];
      const patch = typeof currentVal === 'boolean'
        ? { [moduleName]: state }
        : { [moduleName]: { enabled: state, ...(channel ? { channelId: channel.id } : {}) } };
      const cfg = db.saveConfig(interaction.guildId, patch);
      const display = typeof cfg[moduleName] === 'boolean' ? { enabled: cfg[moduleName] } : cfg[moduleName];
      await interaction.reply({ embeds: [ui.configSummaryEmbed(moduleName, display)] });
    }
  });
}

// ---------------------------------------------------------------------------------
// /greetvoice setup
// ---------------------------------------------------------------------------------
commands.push({
  data: new SlashCommandBuilder()
    .setName('greetvoice')
    .setDescription('Configure the role-gated voice greeting system.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Set the role, voice channel and TTS prompt.')
      .addRoleOption(o => o.setName('role').setDescription('role granted to new members until they complete the greet').setRequired(true))
      .addChannelOption(o => o.setName('vc').setDescription('the only voice channel the role can see/join').setRequired(true).addChannelTypes(ChannelType.GuildVoice))
      .addStringOption(o => o.setName('prompt').setDescription('TTS text played when a gated member joins the VC').setRequired(true))),
  async execute(interaction) {
    if (!requireAdmin(interaction)) return;
    if (interaction.options.getSubcommand() !== 'setup') return;
    const role = interaction.options.getRole('role');
    const vc = interaction.options.getChannel('vc');
    const prompt = interaction.options.getString('prompt');

    db.saveConfig(interaction.guildId, { greetvoice: { enabled: true, roleId: role.id, vcId: vc.id, ttsPrompt: prompt } });

    await interaction.reply({ embeds: [ui.okEmbed(`${ui.emoji('voice')} Greetvoice Configured`,
      `**Role:** ${role}\n**Voice channel:** ${vc}\n**Prompt:** ${prompt}\n\nLocking that role out of every other channel and joining the VC now…`)] });

    await sys.lockRoleToSingleChannel(interaction.guild, role, vc.id);
    await sys.joinAndStayInVC(vc);
  }
});

// ---------------------------------------------------------------------------------
// /whitelist — antinuke exemptions
// ---------------------------------------------------------------------------------
commands.push({
  data: new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('Manage antinuke-exempt users.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('add').setDescription('exempt a user').addUserOption(o => o.setName('user').setDescription('user').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('remove exemption').addUserOption(o => o.setName('user').setDescription('user').setRequired(true))),
  async execute(interaction) {
    if (!requireAdmin(interaction)) return;
    const sub = interaction.options.getSubcommand();
    const user = interaction.options.getUser('user');
    if (sub === 'add') { db.addToWhitelist(interaction.guildId, user.id); return interaction.reply({ embeds: [ui.okEmbed('✅ Whitelisted', `${user} is now exempt from antinuke.`)] }); }
    db.removeFromWhitelist(interaction.guildId, user.id);
    return interaction.reply({ embeds: [ui.okEmbed('✅ Removed', `${user} is no longer exempt.`)] });
  }
});

// ---------------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------------
function modLog(interaction, embed) {
  sys.getLogChannel(interaction.guild, 'mod').then(ch => ch?.send({ embeds: [embed] }).catch(() => {}));
}

commands.push({
  data: new SlashCommandBuilder().setName('ban').setDescription('Ban a member.')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason')),
  async execute(interaction) {
    const user = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    await interaction.guild.members.ban(user.id, { reason }).catch(() => {});
    const embed = ui.errorEmbed('🔨 Member Banned', `**User:** ${user.tag}\n**By:** ${interaction.user}\n**Reason:** ${reason}`);
    await interaction.reply({ embeds: [embed] });
    modLog(interaction, embed);
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('kick').setDescription('Kick a member.')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason')),
  async execute(interaction) {
    const user = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    await member?.kick(reason).catch(() => {});
    const embed = ui.errorEmbed('👢 Member Kicked', `**User:** ${user.tag}\n**By:** ${interaction.user}\n**Reason:** ${reason}`);
    await interaction.reply({ embeds: [embed] });
    modLog(interaction, embed);
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('timeout').setDescription('Timeout a member.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('duration in minutes').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason')),
  async execute(interaction) {
    const user = interaction.options.getUser('user');
    const minutes = interaction.options.getInteger('minutes');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    await member?.timeout(minutes * 60_000, reason).catch(() => {});
    const embed = ui.warnEmbed('⏱️ Member Timed Out', `**User:** ${user.tag}\n**Duration:** ${minutes}m\n**By:** ${interaction.user}\n**Reason:** ${reason}`);
    await interaction.reply({ embeds: [embed] });
    modLog(interaction, embed);
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('untimeout').setDescription('Remove a member\'s timeout.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true)),
  async execute(interaction) {
    const user = interaction.options.getUser('user');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    await member?.timeout(null).catch(() => {});
    await interaction.reply({ embeds: [ui.okEmbed('✅ Timeout Removed', `${user} can speak again.`)] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('warn').setDescription('Warn a member.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(true)),
  async execute(interaction) {
    const user = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason');
    db.addWarn(interaction.guildId, user.id, interaction.user.id, reason);
    const embed = ui.warnEmbed('⚠️ Member Warned', `**User:** ${user.tag}\n**By:** ${interaction.user}\n**Reason:** ${reason}`);
    await interaction.reply({ embeds: [embed] });
    modLog(interaction, embed);
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('warnings').setDescription('View a member\'s warnings.')
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true)),
  async execute(interaction) {
    const user = interaction.options.getUser('user');
    const warns = db.getWarns(interaction.guildId, user.id);
    const desc = warns.length ? warns.map((w, i) => `**${i + 1}.** ${w.reason} — <@${w.moderatorId}> <t:${Math.floor(w.timestamp / 1000)}:R>`).join('\n') : 'No warnings.';
    await interaction.reply({ embeds: [ui.base(`⚠️ Warnings — ${user.tag}`).setDescription(desc)] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('clearwarns').setDescription('Clear a member\'s warnings.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true)),
  async execute(interaction) {
    const user = interaction.options.getUser('user');
    db.clearWarns(interaction.guildId, user.id);
    await interaction.reply({ embeds: [ui.okEmbed('✅ Warnings Cleared', `${user}'s warnings were cleared.`)] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('purge').setDescription('Bulk delete messages.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(o => o.setName('amount').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100))
    .addUserOption(o => o.setName('user').setDescription('only delete this user\'s messages')),
  async execute(interaction) {
    const amount = interaction.options.getInteger('amount');
    const user = interaction.options.getUser('user');
    const msgs = await interaction.channel.messages.fetch({ limit: amount });
    const filtered = user ? msgs.filter(m => m.author.id === user.id) : msgs;
    await interaction.channel.bulkDelete(filtered, true).catch(() => {});
    await interaction.reply({ embeds: [ui.okEmbed('🧹 Purged', `Deleted ${filtered.size} messages.`)], ephemeral: true });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('lock').setDescription('Lock the current channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  async execute(interaction) {
    await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false });
    await interaction.reply({ embeds: [ui.warnEmbed('🔒 Channel Locked', `${interaction.channel} has been locked.`)] });
  }
});
commands.push({
  data: new SlashCommandBuilder().setName('unlock').setDescription('Unlock the current channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  async execute(interaction) {
    await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: null });
    await interaction.reply({ embeds: [ui.okEmbed('🔓 Channel Unlocked', `${interaction.channel} has been unlocked.`)] });
  }
});
commands.push({
  data: new SlashCommandBuilder().setName('slowmode').setDescription('Set channel slowmode.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption(o => o.setName('seconds').setDescription('0-21600').setRequired(true).setMinValue(0).setMaxValue(21600)),
  async execute(interaction) {
    const seconds = interaction.options.getInteger('seconds');
    await interaction.channel.setRateLimitPerUser(seconds);
    await interaction.reply({ embeds: [ui.okEmbed('🐌 Slowmode Set', `Slowmode is now ${seconds}s in ${interaction.channel}.`)] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('role').setDescription('Add or remove a role from a member.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(s => s.setName('add').setDescription('add a role').addUserOption(o => o.setName('user').setDescription('user').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('role').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('remove a role').addUserOption(o => o.setName('user').setDescription('user').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('role').setRequired(true))),
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const user = interaction.options.getUser('user');
    const role = interaction.options.getRole('role');
    const member = await interaction.guild.members.fetch(user.id);
    if (sub === 'add') await member.roles.add(role); else await member.roles.remove(role);
    await interaction.reply({ embeds: [ui.okEmbed('✅ Role Updated', `${role} ${sub === 'add' ? 'added to' : 'removed from'} ${user}.`)] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('nickname').setDescription('Change a member\'s nickname.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true))
    .addStringOption(o => o.setName('nickname').setDescription('leave blank to reset')),
  async execute(interaction) {
    const user = interaction.options.getUser('user');
    const nickname = interaction.options.getString('nickname') || null;
    const member = await interaction.guild.members.fetch(user.id);
    await member.setNickname(nickname).catch(() => {});
    await interaction.reply({ embeds: [ui.okEmbed('✅ Nickname Updated', `${user}'s nickname is now **${nickname || user.username}**.`)] });
  }
});

// ---------------------------------------------------------------------------------
// Leveling
// ---------------------------------------------------------------------------------
commands.push({
  data: new SlashCommandBuilder().setName('rank').setDescription('View a level card.')
    .addUserOption(o => o.setName('user').setDescription('user')),
  async execute(interaction) {
    const user = interaction.options.getUser('user') || interaction.user;
    const rec = db.getLevel(interaction.guildId, user.id);
    const need = sys.xpForLevel(rec.level);
    await interaction.reply({ embeds: [ui.base(`📈 ${user.username}'s Rank`).setDescription(`**Level:** ${rec.level}\n**XP:** ${rec.xp} / ${need}`).setThumbnail(user.displayAvatarURL())] });
  }
});
commands.push({
  data: new SlashCommandBuilder().setName('leaderboard').setDescription('Top XP in this server.'),
  async execute(interaction) {
    const rows = db.topLevels(interaction.guildId, 10);
    await interaction.reply({ embeds: [ui.leaderboardEmbed(interaction.guild.name, rows)] });
  }
});

// ---------------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------------
commands.push({
  data: new SlashCommandBuilder().setName('ticketpanel').setDescription('Post the ticket-opening panel here.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction) {
    const cfg = db.getConfig(interaction.guildId).ticket;
    if (!cfg.enabled) return interaction.reply({ embeds: [ui.errorEmbed('Tickets Disabled', 'Run `/tickets setup state:enable` first.')], ephemeral: true });
    await interaction.channel.send({ embeds: [ui.ticketPanelEmbed(interaction.guild.name, cfg)], components: [ui.ticketPanelRow()] });
    await interaction.reply({ embeds: [ui.okEmbed('✅ Panel Posted', 'The ticket panel is live.')], ephemeral: true });
  }
});

// ---------------------------------------------------------------------------------
// /ticketconfig — the picture + message shown on the panel and inside every new ticket
// ---------------------------------------------------------------------------------
commands.push({
  data: new SlashCommandBuilder().setName('ticketconfig').setDescription('Customize the ticket panel and welcome embed (images + text).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('panel_title').setDescription('Title of the "Open Ticket" panel'))
    .addStringOption(o => o.setName('panel_description').setDescription('Body text of the "Open Ticket" panel'))
    .addStringOption(o => o.setName('panel_thumbnail').setDescription('Small image URL for the panel (top-right)'))
    .addStringOption(o => o.setName('panel_image').setDescription('Big banner image/GIF URL for the panel'))
    .addStringOption(o => o.setName('category_label').setDescription('Category name shown when a ticket opens, e.g. "General Support"'))
    .addStringOption(o => o.setName('welcome_message').setDescription('Extra line shown under Welcome/Category in a new ticket'))
    .addStringOption(o => o.setName('welcome_thumbnail').setDescription('Small image URL shown in a new ticket (top-right)'))
    .addStringOption(o => o.setName('welcome_image').setDescription('Big banner image/GIF URL shown in a new ticket')),
  async execute(interaction) {
    if (!requireAdmin(interaction)) return;
    const map = {
      panel_title: 'panelTitle', panel_description: 'panelDescription', panel_thumbnail: 'panelThumbnail', panel_image: 'panelImage',
      category_label: 'categoryLabel', welcome_message: 'welcomeMessage', welcome_thumbnail: 'welcomeThumbnail', welcome_image: 'welcomeImage'
    };
    const patch = { ticket: {} };
    let changed = false;
    for (const [opt, key] of Object.entries(map)) {
      const val = interaction.options.getString(opt);
      if (val !== null) { patch.ticket[key] = val; changed = true; }
    }
    const cfg = changed ? db.saveConfig(interaction.guildId, patch).ticket : db.getConfig(interaction.guildId).ticket;
    await interaction.reply({
      content: changed ? `${ui.emoji('success')} Ticket appearance updated. Previews below:` : 'Current ticket appearance — previews below:',
      embeds: [ui.ticketPanelEmbed(interaction.guild.name, cfg), ui.ticketWelcomeEmbed(interaction.user, cfg)],
      ephemeral: true
    });
  }
});

// ---------------------------------------------------------------------------------
// Dedicated ticket-action commands — usable inside a ticket channel by staff/admins,
// as an alternative to the Staff Controls buttons.
// ---------------------------------------------------------------------------------
function requireTicketStaff(interaction, ticketCfg) {
  const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
  const hasRole = ticketCfg.supportRoleId && interaction.member.roles.cache.has(ticketCfg.supportRoleId);
  if (!isAdmin && !hasRole) {
    interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need the support role or Administrator to manage tickets.')], ephemeral: true });
    return false;
  }
  return true;
}
function requireInTicket(interaction) {
  const ticket = db.getTicket(interaction.channel.id);
  if (!ticket) {
    interaction.reply({ embeds: [ui.errorEmbed('Not a Ticket', 'This command only works inside a ticket channel.')], ephemeral: true });
    return null;
  }
  return ticket;
}

commands.push({
  data: new SlashCommandBuilder().setName('claim').setDescription('Claim this ticket.'),
  async execute(interaction) {
    const ticket = requireInTicket(interaction); if (!ticket) return;
    const ticketCfg = db.getConfig(interaction.guildId).ticket;
    if (!requireTicketStaff(interaction, ticketCfg)) return;
    if (ticket.claimedBy) return interaction.reply({ embeds: [ui.warnEmbed('Already Claimed', `Already claimed by <@${ticket.claimedBy}>.`)], ephemeral: true });
    db.setTicketStatus(interaction.channel.id, 'claimed', interaction.user.id);
    await interaction.reply({ embeds: [ui.okEmbed('🙋 Ticket Claimed', `${interaction.user} claimed this ticket.`)] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('close').setDescription('Close this ticket (deletes it shortly after).'),
  async execute(interaction) {
    const ticket = requireInTicket(interaction); if (!ticket) return;
    const ticketCfg = db.getConfig(interaction.guildId).ticket;
    if (!requireTicketStaff(interaction, ticketCfg) && interaction.user.id !== ticket.userId) return;
    db.setTicketStatus(interaction.channel.id, 'closed');
    await interaction.reply({ embeds: [ui.warnEmbed('🔒 Closing Ticket', `Closed by ${interaction.user}. This channel will be deleted in 5 seconds.`)] });
    if (ticketCfg.logChannelId) {
      const log = interaction.guild.channels.cache.get(ticketCfg.logChannelId);
      if (log) log.send({ embeds: [ui.base('🎫 Ticket Closed').setDescription(`Ticket by <@${ticket.userId}> closed by ${interaction.user}.`)] }).catch(() => {});
    }
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('delete').setDescription('Immediately delete this ticket, no grace period.'),
  async execute(interaction) {
    const ticket = requireInTicket(interaction); if (!ticket) return;
    const ticketCfg = db.getConfig(interaction.guildId).ticket;
    if (!requireTicketStaff(interaction, ticketCfg)) return;
    await interaction.reply({ embeds: [ui.warnEmbed('🗑️ Deleting Ticket', 'This channel is being deleted now.')] });
    if (ticketCfg.logChannelId) {
      const log = interaction.guild.channels.cache.get(ticketCfg.logChannelId);
      if (log) log.send({ embeds: [ui.base('🗑️ Ticket Deleted').setDescription(`Ticket by <@${ticket.userId}> deleted by ${interaction.user}.`)] }).catch(() => {});
    }
    setTimeout(() => interaction.channel.delete().catch(() => {}), 1500);
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('addmembertoticket').setDescription('Add a member to this ticket.')
    .addUserOption(o => o.setName('user').setDescription('member to add').setRequired(true)),
  async execute(interaction) {
    const ticket = requireInTicket(interaction); if (!ticket) return;
    const ticketCfg = db.getConfig(interaction.guildId).ticket;
    if (!requireTicketStaff(interaction, ticketCfg)) return;
    const user = interaction.options.getUser('user');
    await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
    await interaction.reply({ embeds: [ui.okEmbed('➕ Member Added', `${user} can now see this ticket.`)] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('removemembertoticket').setDescription('Remove a member from this ticket.')
    .addUserOption(o => o.setName('user').setDescription('member to remove').setRequired(true)),
  async execute(interaction) {
    const ticket = requireInTicket(interaction); if (!ticket) return;
    const ticketCfg = db.getConfig(interaction.guildId).ticket;
    if (!requireTicketStaff(interaction, ticketCfg)) return;
    const user = interaction.options.getUser('user');
    await interaction.channel.permissionOverwrites.delete(user.id).catch(() => {});
    await interaction.reply({ embeds: [ui.okEmbed('➖ Member Removed', `${user} can no longer see this ticket.`)] });
  }
});

// ---------------------------------------------------------------------------------
// /prefix — configure the text-command prefix ("<prefix> <cmd> ...")
// ---------------------------------------------------------------------------------
commands.push({
  data: new SlashCommandBuilder()
    .setName('prefix')
    .setDescription('Set this server\'s prefix for text commands (e.g. !ban @user spamming).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('prefix').setDescription('new prefix, e.g. ! or ? or >').setRequired(true)),
  async execute(interaction) {
    if (!requireAdmin(interaction)) return;
    const prefix = interaction.options.getString('prefix').trim().slice(0, 5);
    if (!prefix) return interaction.reply({ embeds: [ui.errorEmbed('Invalid Prefix', 'Prefix can\'t be empty.')], ephemeral: true });
    db.saveConfig(interaction.guildId, { prefix });
    await interaction.reply({ embeds: [ui.okEmbed('✅ Prefix Updated', `Text commands now use \`${prefix}\`. Example: \`${prefix}help\``)] });
  }
});

// ---------------------------------------------------------------------------------
// /testgreet — preview the greet message (supports a picture/GIF) without a real member join
// ---------------------------------------------------------------------------------
commands.push({
  data: new SlashCommandBuilder().setName('testgreet').setDescription('Preview the greet message, optionally with a custom image or GIF.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('message').setDescription('override text, use {user} and {server} (defaults to the configured message)'))
    .addStringOption(o => o.setName('image').setDescription('image/GIF URL to attach (defaults to the configured one, if any)'))
    .addAttachmentOption(o => o.setName('attachment').setDescription('upload an image/GIF directly instead of a URL'))
    .addChannelOption(o => o.setName('channel').setDescription('post the preview here instead of this channel').addChannelTypes(ChannelType.GuildText)),
  async execute(interaction) {
    if (!requireAdmin(interaction)) return;
    const cfg = db.getConfig(interaction.guildId).greetmessage;
    const attachment = interaction.options.getAttachment('attachment');
    const imageUrl = attachment ? attachment.url : (interaction.options.getString('image') || cfg.image || null);
    const text = (interaction.options.getString('message') || cfg.message || 'Welcome {user}!')
      .replace('{user}', `${interaction.user}`).replace('{server}', interaction.guild.name);
    const embed = ui.okEmbed('👋 Welcome! (Test)', text);
    if (imageUrl) embed.setImage(imageUrl);
    const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
    await targetChannel.send({ embeds: [embed] });
    if (targetChannel.id !== interaction.channel.id) {
      await interaction.reply({ embeds: [ui.okEmbed('✅ Preview Sent', `Posted in ${targetChannel}.`)], ephemeral: true });
    } else {
      await interaction.reply({ content: ui.emojify(`${ui.emoji('success')} Preview posted above (this test does not save the image as your permanent config — use /greetmessage setup for that).`), ephemeral: true });
    }
  }
});

// ---------------------------------------------------------------------------------
// /xp — admin XP management
// ---------------------------------------------------------------------------------
commands.push({
  data: new SlashCommandBuilder().setName('xp').setDescription('Manage a member\'s XP/level.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand(s => s.setName('add').setDescription('add XP to a member')
      .addUserOption(o => o.setName('user').setDescription('member').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('XP to add').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('remove XP from a member')
      .addUserOption(o => o.setName('user').setDescription('member').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('XP to remove').setRequired(true)))
    .addSubcommand(s => s.setName('set').setDescription('set a member\'s XP directly')
      .addUserOption(o => o.setName('user').setDescription('member').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('new XP total').setRequired(true)))
    .addSubcommand(s => s.setName('setlevel').setDescription('set a member\'s level directly')
      .addUserOption(o => o.setName('user').setDescription('member').setRequired(true))
      .addIntegerOption(o => o.setName('level').setDescription('new level').setRequired(true)))
    .addSubcommand(s => s.setName('reset').setDescription('reset a member\'s XP and level to 0')
      .addUserOption(o => o.setName('user').setDescription('member').setRequired(true))),
  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers) && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Moderate Members** or **Administrator**.')], ephemeral: true });
    }
    const sub = interaction.options.getSubcommand();
    const user = interaction.options.getUser('user');
    const rec = db.getLevel(interaction.guildId, user.id);
    let xp = rec.xp, level = rec.level;
    if (sub === 'add') xp = Math.max(0, xp + interaction.options.getInteger('amount'));
    else if (sub === 'remove') xp = Math.max(0, xp - interaction.options.getInteger('amount'));
    else if (sub === 'set') xp = Math.max(0, interaction.options.getInteger('amount'));
    else if (sub === 'setlevel') level = Math.max(0, interaction.options.getInteger('level'));
    else if (sub === 'reset') { xp = 0; level = 0; }
    db.setLevel(interaction.guildId, user.id, xp, level, rec.lastMessage);
    await interaction.reply({ embeds: [ui.okEmbed('📈 XP Updated', `${user} — **Level:** ${level} **XP:** ${xp}`)] });
  }
});


// ---------------------------------------------------------------------------------
// DIRECT SETUP COMMANDS
// Every configurable feature also has a simple /<feature>setup command.
// These are standalone commands (no /feature setup subcommand) so admins can
// configure a feature directly from one command.
// ---------------------------------------------------------------------------------
function addDirectState(command) {
  return command.addStringOption(o => o.setName('state').setDescription('enable or disable')
    .setRequired(true).addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }));
}

function directSetupCommand(name, description, optionBuilder, handler) {
  const data = new SlashCommandBuilder().setName(name).setDescription(description)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
  if (optionBuilder) optionBuilder(data);
  commands.push({ data, async execute(interaction) {
    if (!requireAdmin(interaction)) return;
    await handler(interaction);
  }});
}

function directState(interaction) {
  return interaction.options.getString('state') === 'enable';
}

// Security

directSetupCommand('antinukesetup', 'Fully configure antinuke protection.', d => {
  addDirectState(d);
  d.addStringOption(o => o.setName('punishment').setDescription('Action when a threshold is exceeded')
    .addChoices({name:'ban',value:'ban'},{name:'kick',value:'kick'},{name:'strip_roles',value:'strip_roles'}));
  d.addIntegerOption(o => o.setName('threshold').setDescription('Actions allowed before punishment').setMinValue(1).setMaxValue(100));
  d.addIntegerOption(o => o.setName('window_seconds').setDescription('Detection window in seconds').setMinValue(1).setMaxValue(3600));
}, async i => {
  const cfg={enabled:directState(i)};
  const p=i.options.getString('punishment'); const t=i.options.getInteger('threshold'); const w=i.options.getInteger('window_seconds');
  if(p) cfg.punishment=p; if(t) Object.assign(cfg,{maxChannelDeletes:t,maxChannelCreates:t,maxRoleDeletes:t,maxRoleCreates:t,maxBans:t,maxKicks:t,maxWebhookCreates:t,maxRoleUpdates:t}); if(w) cfg.windowSeconds=w;
  const out=db.saveConfig(i.guildId,{antinuke:cfg}); await i.reply({embeds:[ui.configSummaryEmbed('antinuke',out.antinuke)]});
});

directSetupCommand('antilinksetup', 'Fully configure anti-link protection.', d => {
  addDirectState(d);
  d.addStringOption(o => o.setName('mode').setDescription('What to do with detected links').addChoices({name:'delete',value:'delete'},{name:'warn',value:'warn'},{name:'mute',value:'mute'}));
  d.addRoleOption(o => o.setName('bypass_role').setDescription('Role allowed to post links'));
}, async i => {
  const cfg={enabled:directState(i)}; const m=i.options.getString('mode'); const r=i.options.getRole('bypass_role'); if(m) cfg.mode=m; if(r) cfg.bypassRoleId=r.id;
  const out=db.saveConfig(i.guildId,{antilink:cfg}); await i.reply({embeds:[ui.configSummaryEmbed('antilink',out.antilink)]});
});

directSetupCommand('antispamsetup', 'Fully configure anti-spam protection.', d => {
  addDirectState(d); d.addIntegerOption(o=>o.setName('max_messages').setDescription('Messages allowed in the window').setMinValue(2).setMaxValue(100)); d.addIntegerOption(o=>o.setName('window_seconds').setDescription('Window in seconds').setMinValue(1).setMaxValue(300)); d.addStringOption(o=>o.setName('punishment').setDescription('Action').addChoices({name:'mute',value:'mute'},{name:'kick',value:'kick'},{name:'ban',value:'ban'}));
}, async i => { const cfg={enabled:directState(i)}; const a=i.options.getInteger('max_messages'),w=i.options.getInteger('window_seconds'),p=i.options.getString('punishment'); if(a)cfg.maxMessages=a;if(w)cfg.windowSeconds=w;if(p)cfg.punishment=p;const out=db.saveConfig(i.guildId,{antispam:cfg});await i.reply({embeds:[ui.configSummaryEmbed('antispam',out.antispam)]}); });

directSetupCommand('antiraidsetup', 'Fully configure anti-raid protection.', d => {
  addDirectState(d); d.addIntegerOption(o=>o.setName('join_threshold').setDescription('Joins allowed in the window').setMinValue(1).setMaxValue(100)); d.addIntegerOption(o=>o.setName('window_seconds').setDescription('Window in seconds').setMinValue(1).setMaxValue(600)); d.addIntegerOption(o=>o.setName('min_account_age_days').setDescription('Minimum account age in days').setMinValue(0)); d.addStringOption(o=>o.setName('action').setDescription('Raid action').addChoices({name:'lockdown',value:'lockdown'},{name:'kick_new',value:'kick_new'}));
}, async i => { const cfg={enabled:directState(i)}; const j=i.options.getInteger('join_threshold'),w=i.options.getInteger('window_seconds'),a=i.options.getInteger('min_account_age_days'),x=i.options.getString('action');if(j)cfg.joinThreshold=j;if(w)cfg.windowSeconds=w;if(a!==null)cfg.minAccountAgeDays=a;if(x)cfg.action=x;const out=db.saveConfig(i.guildId,{antiraid:cfg});await i.reply({embeds:[ui.configSummaryEmbed('antiraid',out.antiraid)]}); });

directSetupCommand('antibadwordsetup', 'Configure multilingual bad-word filtering.', d => {
  addDirectState(d); d.addStringOption(o=>o.setName('words').setDescription('Comma-separated words or phrases to block')); d.addChannelOption(o=>o.setName('log_channel').setDescription('Channel for filter logs').addChannelTypes(ChannelType.GuildText)); d.addStringOption(o=>o.setName('action').setDescription('Action').addChoices({name:'delete',value:'delete'},{name:'delete_and_warn',value:'delete_and_warn'}));
}, async i => { const words=(i.options.getString('words')||'').split(',').map(x=>x.trim()).filter(Boolean); const ch=i.options.getChannel('log_channel'); const cfg={enabled:directState(i),words,logChannelId:ch?.id||null,action:i.options.getString('action')||'delete'}; const out=db.saveConfig(i.guildId,{antibadword:cfg}); await i.reply({embeds:[ui.configSummaryEmbed('antibadword',out.antibadword)]}); });

directSetupCommand('honeypotsetup', 'Configure a honeypot channel and response.', d => {
  addDirectState(d); d.addChannelOption(o=>o.setName('channel').setDescription('Honeypot text channel').setRequired(true).addChannelTypes(ChannelType.GuildText)); d.addStringOption(o=>o.setName('action').setDescription('Action for a trigger').addChoices({name:'delete',value:'delete'},{name:'kick',value:'kick'})); d.addStringOption(o=>o.setName('delete_history').setDescription('Delete the user\'s recent messages').addChoices({name:'none',value:'none'},{name:'10_minutes',value:'10_minutes'},{name:'1_hour',value:'1_hour'},{name:'24_hours',value:'24_hours'})); d.addChannelOption(o=>o.setName('log_channel').setDescription('Honeypot log channel').addChannelTypes(ChannelType.GuildText));
}, async i => { const ch=i.options.getChannel('channel'),log=i.options.getChannel('log_channel'); const cfg={enabled:directState(i),channelId:ch.id,action:i.options.getString('action')||'delete',deleteHistory:i.options.getString('delete_history')||'none',logChannelId:log?.id||null}; const out=db.saveConfig(i.guildId,{honeypot:cfg}); await i.reply({embeds:[ui.configSummaryEmbed('honeypot',out.honeypot)]}); });

// Member/community setup
for (const [name,key,label] of [
  ['welcomesetup','welcome','welcome'],['leavesetup','leave','leave'],['boostsetup','boost','boost'],['autorolesetup','autorole','autorole'],
  ['automodsetup','automod','automod'],['starboardsetup','starboard','starboard'],['invitetrackersetup','inviteTracker','invite tracker'],
  ['suggestionssetup','suggestions','suggestions'],['pollssetup','polls','polls'],['snipesetup','snipeEnabled','snipe'],['nswffiltersetup','nsfwFilter','NSFW filter']
]) {
  directSetupCommand(name, `Configure ${label}.`, d => { addDirectState(d); d.addChannelOption(o=>o.setName('channel').setDescription(`Channel for ${label}`).addChannelTypes(ChannelType.GuildText)); }, async i => {
    const ch=i.options.getChannel('channel'); const current=db.getConfig(i.guildId)[key]; const value=typeof current==='boolean'?directState(i):{enabled:directState(i),...(ch?{channelId:ch.id}:{})}; const out=db.saveConfig(i.guildId,{[key]:value}); await i.reply({embeds:[ui.configSummaryEmbed(key,typeof out[key]==='boolean'?{enabled:out[key]}:out[key])]});
  });
}

directSetupCommand('reactionrolessetup','Configure reaction/button roles.',d=>{addDirectState(d);d.addChannelOption(o=>o.setName('channel').setDescription('Panel channel').setRequired(true).addChannelTypes(ChannelType.GuildText));d.addStringOption(o=>o.setName('title').setDescription('Panel title'));d.addStringOption(o=>o.setName('description').setDescription('Panel description'));d.addRoleOption(o=>o.setName('role').setDescription('Role to assign'));d.addStringOption(o=>o.setName('button_label').setDescription('Button label'));},async i=>{const cfg={enabled:directState(i),channelId:i.options.getChannel('channel').id,title:i.options.getString('title'),description:i.options.getString('description'),roleId:i.options.getRole('role')?.id||null,buttonLabel:i.options.getString('button_label')||'Claim Role'};const out=db.saveConfig(i.guildId,{reactionRoles:cfg});await i.reply({embeds:[ui.configSummaryEmbed('reactionRoles',out.reactionRoles)]});});

directSetupCommand('birthdaysetup','Configure birthday panel and wishes.',d=>{addDirectState(d);d.addChannelOption(o=>o.setName('panel_channel').setDescription('Channel for birthday setup panel').addChannelTypes(ChannelType.GuildText));d.addChannelOption(o=>o.setName('wish_channel').setDescription('Channel where wishes are sent').addChannelTypes(ChannelType.GuildText));d.addStringOption(o=>o.setName('message').setDescription('Wish message; use {user}'));d.addStringOption(o=>o.setName('panel_title').setDescription('Panel title'));},async i=>{const p=i.options.getChannel('panel_channel'),w=i.options.getChannel('wish_channel');const cfg={enabled:directState(i),panelChannelId:p?.id||null,wishChannelId:w?.id||null,message:i.options.getString('message')||'Happy Birthday {user}! 🎂',panelTitle:i.options.getString('panel_title')||'Set your birthday'};const out=db.saveConfig(i.guildId,{birthdays:cfg});await i.reply({embeds:[ui.configSummaryEmbed('birthdays',out.birthdays)]});});

directSetupCommand('greetmessagesetup','Fully configure welcome messages including images/GIFs.',d=>{addDirectState(d);d.addChannelOption(o=>o.setName('channel').setDescription('Welcome channel').addChannelTypes(ChannelType.GuildText));d.addStringOption(o=>o.setName('message').setDescription('Message; {user} and {server} supported'));d.addStringOption(o=>o.setName('image').setDescription('Image or GIF URL'));},async i=>{const c=i.options.getChannel('channel');const cfg={enabled:directState(i),channelId:c?.id||null,message:i.options.getString('message')||'Welcome {user} to {server}!',image:i.options.getString('image')||null};const out=db.saveConfig(i.guildId,{greetmessage:cfg});await i.reply({embeds:[ui.configSummaryEmbed('greetmessage',out.greetmessage)]});});

directSetupCommand('greetvoicesetup','Configure gated voice greeting and TTS.',d=>{addDirectState(d);d.addRoleOption(o=>o.setName('role').setDescription('Gate role').setRequired(true));d.addChannelOption(o=>o.setName('vc').setDescription('Welcome voice channel').setRequired(true).addChannelTypes(ChannelType.GuildVoice));d.addStringOption(o=>o.setName('prompt').setDescription('TTS prompt').setRequired(true));},async i=>{const role=i.options.getRole('role'),vc=i.options.getChannel('vc'),prompt=i.options.getString('prompt');db.saveConfig(i.guildId,{greetvoice:{enabled:directState(i),roleId:role.id,vcId:vc.id,ttsPrompt:prompt}});await i.reply({embeds:[ui.okEmbed(`${ui.emoji('voice')} Greet Voice Configured`,`**Role:** ${role}\n**Voice:** ${vc}\n**Prompt:** ${prompt}`)]});await sys.lockRoleToSingleChannel(i.guild,role,vc.id);await sys.joinAndStayInVC(vc);});

directSetupCommand('voicemasersetup','Configure VoiceMaster.',d=>{addDirectState(d);d.addChannelOption(o=>o.setName('hub_channel').setDescription('Join-to-create channel').addChannelTypes(ChannelType.GuildVoice));d.addChannelOption(o=>o.setName('category').setDescription('Temporary VC category').addChannelTypes(ChannelType.GuildCategory));},async i=>{const h=i.options.getChannel('hub_channel'),c=i.options.getChannel('category');const out=db.saveConfig(i.guildId,{voicemaster:{enabled:directState(i),hubChannelId:h?.id||null,categoryId:c?.id||null}});await i.reply({embeds:[ui.configSummaryEmbed('voicemaster',out.voicemaster)]});});

directSetupCommand('levelingsetup','Fully configure leveling.',d=>{addDirectState(d);d.addChannelOption(o=>o.setName('channel').setDescription('Level-up channel').addChannelTypes(ChannelType.GuildText));d.addIntegerOption(o=>o.setName('xp_per_message').setDescription('XP per message'));d.addIntegerOption(o=>o.setName('cooldown_seconds').setDescription('XP cooldown'));d.addIntegerOption(o=>o.setName('reward_level').setDescription('Reward level'));d.addRoleOption(o=>o.setName('reward_role').setDescription('Reward role'));},async i=>{const c=i.options.getChannel('channel'),r=i.options.getRole('reward_role'),lvl=i.options.getInteger('reward_level');const cfg={enabled:directState(i),channel:c?.id||null,xpPerMessage:i.options.getInteger('xp_per_message')||null,cooldownSeconds:i.options.getInteger('cooldown_seconds')||null,roleRewards:(lvl&&r)?{[String(lvl)]:r.id}:db.getConfig(i.guildId).leveling.roleRewards};const out=db.saveConfig(i.guildId,{leveling:cfg});await i.reply({embeds:[ui.configSummaryEmbed('leveling',out.leveling)]});});

// Tickets: one command with all panel + ticket-open customization.
directSetupCommand('ticketsetup','Fully configure tickets, panel and ticket welcome message.',d=>{addDirectState(d);d.addChannelOption(o=>o.setName('category').setDescription('Ticket category').addChannelTypes(ChannelType.GuildCategory));d.addRoleOption(o=>o.setName('support_role').setDescription('Support role'));d.addChannelOption(o=>o.setName('log_channel').setDescription('Ticket log channel').addChannelTypes(ChannelType.GuildText));d.addStringOption(o=>o.setName('panel_title').setDescription('Panel title'));d.addStringOption(o=>o.setName('panel_description').setDescription('Panel message'));d.addStringOption(o=>o.setName('panel_thumbnail').setDescription('Panel thumbnail URL'));d.addStringOption(o=>o.setName('panel_image').setDescription('Panel image/GIF URL'));d.addStringOption(o=>o.setName('category_label').setDescription('Ticket category label'));d.addStringOption(o=>o.setName('welcome_message').setDescription('Message when ticket opens'));d.addStringOption(o=>o.setName('welcome_thumbnail').setDescription('Ticket thumbnail URL'));d.addStringOption(o=>o.setName('welcome_image').setDescription('Ticket image/GIF URL'));},async i=>{const cfg={enabled:directState(i),categoryId:i.options.getChannel('category')?.id||null,supportRoleId:i.options.getRole('support_role')?.id||null,logChannelId:i.options.getChannel('log_channel')?.id||null,panelTitle:i.options.getString('panel_title'),panelDescription:i.options.getString('panel_description'),panelThumbnail:i.options.getString('panel_thumbnail'),panelImage:i.options.getString('panel_image'),categoryLabel:i.options.getString('category_label'),welcomeMessage:i.options.getString('welcome_message'),welcomeThumbnail:i.options.getString('welcome_thumbnail'),welcomeImage:i.options.getString('welcome_image')};const out=db.saveConfig(i.guildId,{ticket:cfg});await i.reply({embeds:[ui.configSummaryEmbed('tickets',out.ticket)]});});

// Logs
commands.push({data:new SlashCommandBuilder().setName('logssetup').setDescription('Fully configure a logging destination.').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addStringOption(o=>o.setName('type').setDescription('Log type').setRequired(true).addChoices({name:'moderation',value:'mod'},{name:'messages',value:'message'},{name:'members',value:'member'},{name:'voice',value:'voice'},{name:'antinuke',value:'antinuke'},{name:'server',value:'server'},{name:'tickets',value:'ticket'},{name:'joins/leaves',value:'join'})).addChannelOption(o=>o.setName('channel').setDescription('Destination').setRequired(true).addChannelTypes(ChannelType.GuildText)),async execute(i){if(!requireAdmin(i))return;const type=i.options.getString('type'),ch=i.options.getChannel('channel');const out=db.saveConfig(i.guildId,{logs:{[type]:ch.id}});await i.reply({embeds:[ui.configSummaryEmbed('logs',out.logs)]});}});

// Button-role panel and staff applications.
directSetupCommand('buttonrolesetup','Configure a role-claim button panel.',d=>{addDirectState(d);d.addChannelOption(o=>o.setName('channel').setDescription('Panel channel').setRequired(true).addChannelTypes(ChannelType.GuildText));d.addRoleOption(o=>o.setName('role').setDescription('Role users claim').setRequired(true));d.addStringOption(o=>o.setName('title').setDescription('Embed title'));d.addStringOption(o=>o.setName('description').setDescription('Embed description'));d.addStringOption(o=>o.setName('button_label').setDescription('Button text'));d.addStringOption(o=>o.setName('image').setDescription('Embed image/GIF URL'));},async i=>{const out=db.saveConfig(i.guildId,{buttonRoles:{enabled:directState(i),channelId:i.options.getChannel('channel').id,roleId:i.options.getRole('role').id,title:i.options.getString('title')||'Choose your role',description:i.options.getString('description')||'Press the button below to claim your role.',buttonLabel:i.options.getString('button_label')||'Claim Role',image:i.options.getString('image')||null}});await i.reply({embeds:[ui.configSummaryEmbed('buttonRoles',out.buttonRoles)]});});

directSetupCommand('staffapplicationssetup','Configure staff applications.',d=>{addDirectState(d);d.addChannelOption(o=>o.setName('panel_channel').setDescription('Application panel channel').setRequired(true).addChannelTypes(ChannelType.GuildText));d.addChannelOption(o=>o.setName('log_channel').setDescription('Application log channel').setRequired(true).addChannelTypes(ChannelType.GuildText));d.addRoleOption(o=>o.setName('staff_role').setDescription('Role allowed to review'));d.addStringOption(o=>o.setName('questions').setDescription('Questions separated by |').setRequired(true));d.addStringOption(o=>o.setName('title').setDescription('Panel title'));d.addStringOption(o=>o.setName('description').setDescription('Panel description'));},async i=>{const out=db.saveConfig(i.guildId,{staffApplications:{enabled:directState(i),panelChannelId:i.options.getChannel('panel_channel').id,logChannelId:i.options.getChannel('log_channel').id,staffRoleId:i.options.getRole('staff_role')?.id||null,questions:(i.options.getString('questions')||'').split('|').map(x=>x.trim()).filter(Boolean),title:i.options.getString('title')||'Staff Applications',description:i.options.getString('description')||'Press Apply to begin.'}});await i.reply({embeds:[ui.configSummaryEmbed('staffApplications',out.staffApplications)]});});

// ---------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------
// Owner-only
// ---------------------------------------------------------------------------------
commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('maintenance').setDescription('[Owner] Toggle maintenance mode.')
    .addStringOption(o => o.setName('state').setDescription('on/off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
  async execute(interaction) {
    if (!isOwner(interaction.user.id)) return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
    const state = interaction.options.getString('state') === 'on';
    db.saveConfig(interaction.guildId, { maintenance: state });
    await interaction.reply({ embeds: [ui.okEmbed('🛠️ Maintenance Mode', `Maintenance mode is now **${state ? 'ON' : 'OFF'}**.`)] });
  }
});
commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('blacklist').setDescription('[Owner] Block a user from using the bot.')
    .addSubcommand(s => s.setName('add').setDescription('block a user').addUserOption(o => o.setName('user').setDescription('user').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('unblock a user').addUserOption(o => o.setName('user').setDescription('user').setRequired(true))),
  async execute(interaction) {
    if (!isOwner(interaction.user.id)) return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
    const sub = interaction.options.getSubcommand();
    const user = interaction.options.getUser('user');
    const cfg = db.getConfig(interaction.guildId);
    const list = sub === 'add' ? [...new Set([...cfg.blacklist, user.id])] : cfg.blacklist.filter(id => id !== user.id);
    db.saveConfig(interaction.guildId, { blacklist: list });
    await interaction.reply({ embeds: [ui.okEmbed('✅ Blacklist Updated', `${user} ${sub === 'add' ? 'blocked' : 'unblocked'}.`)] });
  }
});
commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('emoji').setDescription('[Owner] View or change every emoji the bot uses.')
    .addSubcommand(s => s.setName('list').setDescription('Show every emoji currently used by the bot.'))
    .addSubcommand(s => s.setName('set').setDescription('Change one emoji everywhere it is used.')
      .addStringOption(o => o.setName('name').setDescription('Name from /emoji list').setRequired(true))
      .addStringOption(o => o.setName('value').setDescription('Unicode emoji or custom emoji such as <:name:id>.').setRequired(true)))
    .addSubcommand(s => s.setName('reset').setDescription('Restore one emoji to its default.')
      .addStringOption(o => o.setName('name').setDescription('Name from /emoji list').setRequired(true))),
  async execute(interaction) {
    if (!isOwner(interaction.user.id)) return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      return interaction.reply({ embeds: [ui.emojisListEmbed(db.getAllEmojiOverrides())], ephemeral: true });
    }
    const name = interaction.options.getString('name').trim().toLowerCase();
    if (!ui.EMOJI_KEYS.includes(name)) {
      return interaction.reply({ embeds: [ui.errorEmbed('Unknown Emoji', `**${name}** is not a valid emoji name. Use **/emoji list** first.`)], ephemeral: true });
    }
    if (sub === 'set') {
      const value = interaction.options.getString('value').trim();
      if (!value) return interaction.reply({ embeds: [ui.errorEmbed('Invalid Emoji', 'The emoji value cannot be empty.')], ephemeral: true });
      db.setEmojiOverride(name, value);
      return interaction.reply({ embeds: [ui.okEmbed(`${ui.emoji('success')} Emoji Updated`, `**${name}** is now ${value}. All matching button icons and embed text use it immediately.`)] });
    }
    db.resetEmojiOverride(name);
    return interaction.reply({ embeds: [ui.okEmbed(`${ui.emoji('success')} Emoji Reset`, `**${name}** is back to its default: ${ui.DEFAULT_EMOJIS[name]}`)] });
  }
});

commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('eval').setDescription('[Owner] Run raw JavaScript.')
    .addStringOption(o => o.setName('code').setDescription('code to run').setRequired(true)),
  async execute(interaction) {
    if (!isOwner(interaction.user.id)) return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
    try {
      let result = eval(interaction.options.getString('code')); // eslint-disable-line no-eval
      if (typeof result !== 'string') result = require('util').inspect(result, { depth: 1 });
      await interaction.reply({ embeds: [ui.okEmbed('✅ Eval Result', '```js\n' + result.slice(0, 3800) + '\n```')], ephemeral: true });
    } catch (e) {
      await interaction.reply({ embeds: [ui.errorEmbed('❌ Eval Error', '```\n' + e.message + '\n```')], ephemeral: true });
    }
  }
});

// Discord requires every top-level application command name to be unique.
// Fail fast with a useful diagnostic instead of sending an invalid command payload.
const _commandNameCounts = new Map();
for (const command of commands) {
  const name = command?.data?.name;
  if (name) _commandNameCounts.set(name, (_commandNameCounts.get(name) || 0) + 1);
}
const duplicateCommandNames = [..._commandNameCounts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
if (duplicateCommandNames.length) {
  throw new Error(`Duplicate application command names: ${duplicateCommandNames.join(', ')}`);
}

module.exports = { commands, isOwner, buildModulePatch, PANEL_MODULES };
