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

// Modules the generic /setup module toggle understands, beyond the dedicated subcommands.
const GENERIC_MODULES = [
  'welcome', 'leave', 'boost', 'autorole', 'automod', 'starboard', 'inviteTracker',
  'suggestions', 'polls', 'snipeEnabled', 'nsfwFilter', 'reactionRoles', 'birthdays'
];
const ALL_MODULE_NAMES = [
  'antinuke', 'antilink', 'antispam', 'antiraid', 'voicemaster', 'greetvoice', 'greetmessage',
  'leveling', 'tickets', 'logs', ...GENERIC_MODULES
];

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
// /setup — the mega config command
// ---------------------------------------------------------------------------------
const setupCmd = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Configure a bot module.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(s => s.setName('list').setDescription('List every configurable module.'))
  .addSubcommand(s => s.setName('antinuke').setDescription('Configure antinuke protection.')
    .addStringOption(o => o.setName('state').setDescription('enable/disable').addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }))
    .addStringOption(o => o.setName('punishment').setDescription('ban/kick/strip_roles').addChoices({ name: 'ban', value: 'ban' }, { name: 'kick', value: 'kick' }, { name: 'strip_roles', value: 'strip_roles' }))
    .addIntegerOption(o => o.setName('threshold').setDescription('actions allowed before punishment (applies to all antinuke limits)'))
    .addIntegerOption(o => o.setName('window_seconds').setDescription('time window in seconds')))
  .addSubcommand(s => s.setName('antilink').setDescription('Configure antilink.')
    .addStringOption(o => o.setName('state').setDescription('enable/disable').addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }))
    .addStringOption(o => o.setName('mode').setDescription('delete/warn/mute').addChoices({ name: 'delete', value: 'delete' }, { name: 'warn', value: 'warn' }, { name: 'mute', value: 'mute' }))
    .addRoleOption(o => o.setName('bypass_role').setDescription('role exempt from antilink')))
  .addSubcommand(s => s.setName('antispam').setDescription('Configure antispam.')
    .addStringOption(o => o.setName('state').setDescription('enable/disable').addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }))
    .addIntegerOption(o => o.setName('max_messages').setDescription('messages allowed per window'))
    .addIntegerOption(o => o.setName('window_seconds').setDescription('window length in seconds'))
    .addStringOption(o => o.setName('punishment').setDescription('mute/kick/ban').addChoices({ name: 'mute', value: 'mute' }, { name: 'kick', value: 'kick' }, { name: 'ban', value: 'ban' })))
  .addSubcommand(s => s.setName('antiraid').setDescription('Configure antiraid.')
    .addStringOption(o => o.setName('state').setDescription('enable/disable').addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }))
    .addIntegerOption(o => o.setName('join_threshold').setDescription('joins allowed per window'))
    .addIntegerOption(o => o.setName('window_seconds').setDescription('window length in seconds'))
    .addIntegerOption(o => o.setName('min_account_age_days').setDescription('min account age to allow join'))
    .addStringOption(o => o.setName('action').setDescription('lockdown/kick_new').addChoices({ name: 'lockdown', value: 'lockdown' }, { name: 'kick_new', value: 'kick_new' })))
  .addSubcommand(s => s.setName('voicemaster').setDescription('Configure join-to-create voice.')
    .addStringOption(o => o.setName('state').setDescription('enable/disable').addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }))
    .addChannelOption(o => o.setName('hub_channel').setDescription('the "join to create" voice channel').addChannelTypes(ChannelType.GuildVoice))
    .addChannelOption(o => o.setName('category').setDescription('category new channels are created under').addChannelTypes(ChannelType.GuildCategory)))
  .addSubcommand(s => s.setName('greetmessage').setDescription('Configure the text welcome message.')
    .addStringOption(o => o.setName('state').setDescription('enable/disable').addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }))
    .addChannelOption(o => o.setName('channel').setDescription('channel to post in').addChannelTypes(ChannelType.GuildText))
    .addStringOption(o => o.setName('message').setDescription('use {user} and {server}')))
  .addSubcommand(s => s.setName('leveling').setDescription('Configure the XP/leveling system.')
    .addStringOption(o => o.setName('state').setDescription('enable/disable').addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }))
    .addChannelOption(o => o.setName('channel').setDescription('level-up announcement channel').addChannelTypes(ChannelType.GuildText))
    .addIntegerOption(o => o.setName('xp_per_message').setDescription('XP per eligible message'))
    .addIntegerOption(o => o.setName('cooldown_seconds').setDescription('seconds between XP gains'))
    .addIntegerOption(o => o.setName('reward_level').setDescription('level to attach a role reward to'))
    .addRoleOption(o => o.setName('reward_role').setDescription('role granted at reward_level')))
  .addSubcommand(s => s.setName('tickets').setDescription('Configure the ticket system.')
    .addStringOption(o => o.setName('state').setDescription('enable/disable').addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }))
    .addChannelOption(o => o.setName('category').setDescription('category tickets are created under').addChannelTypes(ChannelType.GuildCategory))
    .addRoleOption(o => o.setName('support_role').setDescription('role that can see/claim tickets'))
    .addChannelOption(o => o.setName('log_channel').setDescription('ticket transcript/log channel').addChannelTypes(ChannelType.GuildText)))
  .addSubcommand(s => s.setName('logs').setDescription('Route a log type to a channel.')
    .addStringOption(o => o.setName('type').setDescription('log category').setRequired(true)
      .addChoices(
        { name: 'moderation', value: 'mod' }, { name: 'messages', value: 'message' }, { name: 'members', value: 'member' },
        { name: 'voice', value: 'voice' }, { name: 'antinuke', value: 'antinuke' }, { name: 'server', value: 'server' },
        { name: 'tickets', value: 'ticket' }, { name: 'joins/leaves', value: 'join' }))
    .addChannelOption(o => o.setName('channel').setDescription('channel to send this log type to').setRequired(true).addChannelTypes(ChannelType.GuildText)))
  .addSubcommand(s => s.setName('module').setDescription('Enable/disable one of the 40+ smaller modules.')
    .addStringOption(o => o.setName('name').setDescription('module name').setRequired(true).addChoices(...GENERIC_MODULES.map(m => ({ name: m, value: m }))))
    .addStringOption(o => o.setName('state').setDescription('enable/disable').setRequired(true).addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }))
    .addChannelOption(o => o.setName('channel').setDescription('channel this module should use, if any')));

commands.push({
  data: setupCmd,
  async execute(interaction) {
    if (!requireAdmin(interaction)) return;
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'list') {
      return interaction.reply({ embeds: [ui.moduleListEmbed(ALL_MODULE_NAMES)], ephemeral: true });
    }

    if (sub === 'module') {
      const name = interaction.options.getString('name');
      const state = interaction.options.getString('state') === 'enable';
      const channel = interaction.options.getChannel('channel');
      const patch = { [name]: { enabled: state } };
      if (channel) patch[name].channelId = channel.id;
      const cfg = db.saveConfig(guildId, patch);
      return interaction.reply({ embeds: [ui.configSummaryEmbed(name, cfg[name])] });
    }

    const patch = {};
    const state = interaction.options.getString('state');
    if (sub === 'antinuke') {
      patch.antinuke = {};
      if (state) patch.antinuke.enabled = state === 'enable';
      const punishment = interaction.options.getString('punishment'); if (punishment) patch.antinuke.punishment = punishment;
      const threshold = interaction.options.getInteger('threshold');
      if (threshold) Object.assign(patch.antinuke, {
        maxChannelDeletes: threshold, maxChannelCreates: threshold, maxRoleDeletes: threshold,
        maxRoleCreates: threshold, maxBans: threshold, maxKicks: threshold, maxWebhookCreates: threshold, maxRoleUpdates: threshold
      });
      const win = interaction.options.getInteger('window_seconds'); if (win) patch.antinuke.windowSeconds = win;
    } else if (sub === 'antilink') {
      patch.antilink = {};
      if (state) patch.antilink.enabled = state === 'enable';
      const mode = interaction.options.getString('mode'); if (mode) patch.antilink.mode = mode;
      const role = interaction.options.getRole('bypass_role'); if (role) patch.antilink.bypassRoleId = role.id;
    } else if (sub === 'antispam') {
      patch.antispam = {};
      if (state) patch.antispam.enabled = state === 'enable';
      const mm = interaction.options.getInteger('max_messages'); if (mm) patch.antispam.maxMessages = mm;
      const win = interaction.options.getInteger('window_seconds'); if (win) patch.antispam.windowSeconds = win;
      const p = interaction.options.getString('punishment'); if (p) patch.antispam.punishment = p;
    } else if (sub === 'antiraid') {
      patch.antiraid = {};
      if (state) patch.antiraid.enabled = state === 'enable';
      const jt = interaction.options.getInteger('join_threshold'); if (jt) patch.antiraid.joinThreshold = jt;
      const win = interaction.options.getInteger('window_seconds'); if (win) patch.antiraid.windowSeconds = win;
      const age = interaction.options.getInteger('min_account_age_days'); if (age !== null) patch.antiraid.minAccountAgeDays = age;
      const act = interaction.options.getString('action'); if (act) patch.antiraid.action = act;
    } else if (sub === 'voicemaster') {
      patch.voicemaster = {};
      if (state) patch.voicemaster.enabled = state === 'enable';
      const hub = interaction.options.getChannel('hub_channel'); if (hub) patch.voicemaster.hubChannelId = hub.id;
      const cat = interaction.options.getChannel('category'); if (cat) patch.voicemaster.categoryId = cat.id;
    } else if (sub === 'greetmessage') {
      patch.greetmessage = {};
      if (state) patch.greetmessage.enabled = state === 'enable';
      const ch = interaction.options.getChannel('channel'); if (ch) patch.greetmessage.channelId = ch.id;
      const msg = interaction.options.getString('message'); if (msg) patch.greetmessage.message = msg;
    } else if (sub === 'leveling') {
      patch.leveling = {};
      if (state) patch.leveling.enabled = state === 'enable';
      const ch = interaction.options.getChannel('channel'); if (ch) patch.leveling.channel = ch.id;
      const xp = interaction.options.getInteger('xp_per_message'); if (xp) patch.leveling.xpPerMessage = xp;
      const cd = interaction.options.getInteger('cooldown_seconds'); if (cd) patch.leveling.cooldownSeconds = cd;
      const rl = interaction.options.getInteger('reward_level'); const rr = interaction.options.getRole('reward_role');
      if (rl && rr) {
        const current = db.getConfig(guildId).leveling.roleRewards;
        patch.leveling.roleRewards = { ...current, [String(rl)]: rr.id };
      }
    } else if (sub === 'tickets') {
      patch.ticket = {};
      if (state) patch.ticket.enabled = state === 'enable';
      const cat = interaction.options.getChannel('category'); if (cat) patch.ticket.categoryId = cat.id;
      const role = interaction.options.getRole('support_role'); if (role) patch.ticket.supportRoleId = role.id;
      const log = interaction.options.getChannel('log_channel'); if (log) patch.ticket.logChannelId = log.id;
    } else if (sub === 'logs') {
      const type = interaction.options.getString('type');
      const channel = interaction.options.getChannel('channel');
      patch.logs = { [type]: channel.id };
    }

    const cfg = db.saveConfig(guildId, patch);
    const moduleKey = sub === 'logs' ? 'logs' : (sub === 'tickets' ? 'ticket' : sub);
    return interaction.reply({ embeds: [ui.configSummaryEmbed(sub, cfg[moduleKey])] });
  }
});

// ---------------------------------------------------------------------------------
// /greetvoice <role> <vc> <ttsprompt>
// ---------------------------------------------------------------------------------
commands.push({
  data: new SlashCommandBuilder()
    .setName('greetvoice')
    .setDescription('Set up the role-gated voice greeting system.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(o => o.setName('role').setDescription('role granted to new members until they complete the greet').setRequired(true))
    .addChannelOption(o => o.setName('vc').setDescription('the only voice channel the role can see/join').setRequired(true).addChannelTypes(ChannelType.GuildVoice))
    .addStringOption(o => o.setName('prompt').setDescription('TTS text played when a gated member joins the VC').setRequired(true)),
  async execute(interaction) {
    if (!requireAdmin(interaction)) return;
    const role = interaction.options.getRole('role');
    const vc = interaction.options.getChannel('vc');
    const prompt = interaction.options.getString('prompt');

    db.saveConfig(interaction.guildId, { greetvoice: { enabled: true, roleId: role.id, vcId: vc.id, ttsPrompt: prompt } });

    await interaction.reply({ embeds: [ui.okEmbed('🔊 Greetvoice Configured',
      `**Role:** ${role}\n**Voice channel:** ${vc}\n**Prompt:** ${prompt}\n\nLocking that role out of every other channel and joining the VC now…`)] });

    await sys.lockRoleToSingleChannel(interaction.guild, role, vc.id);
    await sys.joinAndStayInVC(vc); // bot joins immediately and stays, per spec
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
    if (!cfg.enabled) return interaction.reply({ embeds: [ui.errorEmbed('Tickets Disabled', 'Run `/setup tickets state:enable` first.')], ephemeral: true });
    await interaction.channel.send({ embeds: [ui.ticketPanelEmbed(interaction.guild.name)], components: [ui.ticketPanelRow()] });
    await interaction.reply({ embeds: [ui.okEmbed('✅ Panel Posted', 'The ticket panel is live.')], ephemeral: true });
  }
});

// ---------------------------------------------------------------------------------
// Owner-only
// ---------------------------------------------------------------------------------
commands.push({
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

module.exports = { commands, isOwner };
