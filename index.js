// index.js — boots the client, registers slash commands, and wires every Discord event
// to the systems/commands/ui modules. This is the only file that touches gateway events.

require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  ChannelType, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  AuditLogEvent
} = require('discord.js');

const db = require('./database');
const ui = require('./ui');
const sys = require('./systems');
const { commands, isOwner } = require('./commands');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildWebhooks
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

// ---------------------------------------------------------------------------------
// Slash command registration
// ---------------------------------------------------------------------------------
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const body = commands.map(c => c.data.toJSON());
  if (process.env.GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body });
    console.log(`Registered ${body.length} commands to guild ${process.env.GUILD_ID}.`);
  } else {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body });
    console.log(`Registered ${body.length} global commands.`);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity('/help');
  try { await registerCommands(); } catch (e) { console.error('Command registration failed:', e); }
});

// ---------------------------------------------------------------------------------
// interactionCreate — slash commands, buttons, select menus, modals
// ---------------------------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (db.getConfig(interaction.guildId).blacklist.includes(interaction.user.id) && !isOwner(interaction.user.id)) {
        return interaction.reply({ embeds: [ui.errorEmbed('Blacklisted', 'You are blocked from using this bot.')], ephemeral: true });
      }
      const cmd = commands.find(c => c.data.name === interaction.commandName);
      if (cmd) await cmd.execute(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'help_select') {
      const key = interaction.values[0];
      return interaction.update({ embeds: [ui.helpCategoryEmbed(key)], components: [ui.helpSelectRow()] });
    }

    if (interaction.isButton()) return handleButton(interaction);
    if (interaction.isModalSubmit()) return handleModal(interaction);
  } catch (err) {
    console.error(err);
    const payload = { embeds: [ui.errorEmbed('Error', 'Something went wrong running that.')], ephemeral: true };
    if (interaction.deferred || interaction.replied) interaction.followUp(payload).catch(() => {});
    else interaction.reply(payload).catch(() => {});
  }
});

async function handleButton(interaction) {
  const id = interaction.customId;

  // ---- Tickets ----
  if (id === 'ticket_open') {
    const cfg = db.getConfig(interaction.guildId).ticket;
    if (!cfg.enabled) return interaction.reply({ embeds: [ui.errorEmbed('Tickets Disabled', 'Ask an admin to run `/setup tickets`.')], ephemeral: true });
    const existing = db.openTicketForUser(interaction.guildId, interaction.user.id);
    if (existing) return interaction.reply({ embeds: [ui.warnEmbed('Ticket Exists', `You already have an open ticket: <#${existing.channelId}>`)], ephemeral: true });

    const overwrites = [
      { id: interaction.guild.roles.everyone, deny: ['ViewChannel'] },
      { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] },
      { id: client.user.id, allow: ['ViewChannel', 'SendMessages', 'ManageChannels'] }
    ];
    if (cfg.supportRoleId) overwrites.push({ id: cfg.supportRoleId, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] });

    const channel = await interaction.guild.channels.create({
      name: `ticket-${interaction.user.username}`.toLowerCase().slice(0, 90),
      type: ChannelType.GuildText,
      parent: cfg.categoryId || undefined,
      permissionOverwrites: overwrites
    });
    db.createTicket(channel.id, interaction.guildId, interaction.user.id);
    await channel.send({ embeds: [ui.ticketWelcomeEmbed(interaction.user)], components: [ui.ticketControlRow(false)] });
    return interaction.reply({ embeds: [ui.okEmbed('🎫 Ticket Created', `Opened ${channel}.`)], ephemeral: true });
  }
  if (id === 'ticket_claim') {
    db.setTicketStatus(interaction.channel.id, 'claimed', interaction.user.id);
    await interaction.update({ components: [ui.ticketControlRow(true)] });
    return interaction.followUp({ embeds: [ui.okEmbed('🙋 Ticket Claimed', `${interaction.user} claimed this ticket.`)] });
  }
  if (id === 'ticket_close') {
    const ticket = db.getTicket(interaction.channel.id);
    db.setTicketStatus(interaction.channel.id, 'closed');
    await interaction.reply({ embeds: [ui.warnEmbed('🔒 Closing Ticket', 'This channel will be deleted in 5 seconds.')] });
    const cfg = db.getConfig(interaction.guildId).ticket;
    if (cfg.logChannelId) {
      const log = interaction.guild.channels.cache.get(cfg.logChannelId);
      if (log) log.send({ embeds: [ui.base('🎫 Ticket Closed').setDescription(`Ticket by <@${ticket?.userId}> closed by ${interaction.user}.`)] }).catch(() => {});
    }
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    return;
  }

  // ---- Voicemaster ----
  if (id.startsWith('vm_')) {
    const vc = interaction.member.voice.channel;
    if (!vc || !db.getVMChannel(vc.id)) return interaction.reply({ embeds: [ui.errorEmbed('No Channel', 'Join a voicemaster channel first.')], ephemeral: true });
    const record = db.getVMChannel(vc.id);
    if (record.ownerId !== interaction.user.id) return interaction.reply({ embeds: [ui.errorEmbed('Not Owner', 'Only the channel owner can do that.')], ephemeral: true });

    const everyone = interaction.guild.roles.everyone;
    if (id === 'vm_lock') { await vc.permissionOverwrites.edit(everyone, { Connect: false }); return interaction.reply({ embeds: [ui.okEmbed('🔒 Locked', 'Channel locked.')], ephemeral: true }); }
    if (id === 'vm_unlock') { await vc.permissionOverwrites.edit(everyone, { Connect: true }); return interaction.reply({ embeds: [ui.okEmbed('🔓 Unlocked', 'Channel unlocked.')], ephemeral: true }); }
    if (id === 'vm_hide') { await vc.permissionOverwrites.edit(everyone, { ViewChannel: false }); return interaction.reply({ embeds: [ui.okEmbed('🙈 Hidden', 'Channel hidden.')], ephemeral: true }); }
    if (id === 'vm_unhide') { await vc.permissionOverwrites.edit(everyone, { ViewChannel: true }); return interaction.reply({ embeds: [ui.okEmbed('👁️ Visible', 'Channel visible.')], ephemeral: true }); }
    if (id === 'vm_rename' || id === 'vm_limit' || id === 'vm_transfer' || id === 'vm_kick') return openVMModal(interaction, id);
  }
}

async function openVMModal(interaction, id) {
  const fieldMap = {
    vm_rename: { title: 'Rename Channel', label: 'New name', id: 'value' },
    vm_limit: { title: 'Set User Limit', label: 'Limit (0 = unlimited)', id: 'value' },
    vm_transfer: { title: 'Transfer Ownership', label: 'User ID to transfer to', id: 'value' },
    vm_kick: { title: 'Kick From Channel', label: 'User ID to kick', id: 'value' }
  };
  const f = fieldMap[id];
  const modal = new ModalBuilder().setCustomId(id).setTitle(f.title).addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(f.id).setLabel(f.label).setStyle(TextInputStyle.Short).setRequired(true))
  );
  return interaction.showModal(modal);
}

async function handleModal(interaction) {
  const vc = interaction.member.voice.channel;
  if (!vc) return interaction.reply({ embeds: [ui.errorEmbed('No Channel', 'You left the voice channel.')], ephemeral: true });
  const value = interaction.fields.getTextInputValue('value');

  if (interaction.customId === 'vm_rename') { await vc.setName(value.slice(0, 100)); return interaction.reply({ embeds: [ui.okEmbed('✏️ Renamed', `Now called **${value}**.`)], ephemeral: true }); }
  if (interaction.customId === 'vm_limit') { await vc.setUserLimit(Math.max(0, Math.min(99, parseInt(value) || 0))); return interaction.reply({ embeds: [ui.okEmbed('🔢 Limit Set', `User limit is now ${value}.`)], ephemeral: true }); }
  if (interaction.customId === 'vm_kick') {
    const member = vc.members.get(value.trim());
    await member?.voice.disconnect().catch(() => {});
    return interaction.reply({ embeds: [ui.okEmbed('👢 Kicked', member ? `${member.user.tag} removed.` : 'User not found in channel.')], ephemeral: true });
  }
  if (interaction.customId === 'vm_transfer') {
    db.removeVMChannel(vc.id);
    db.addVMChannel(vc.id, interaction.guildId, value.trim());
    return interaction.reply({ embeds: [ui.okEmbed('🔁 Ownership Transferred', `New owner: <@${value.trim()}>`)], ephemeral: true });
  }
}

// ---------------------------------------------------------------------------------
// guildMemberAdd — antiraid, greetvoice, welcome, autorole, sticky roles
// ---------------------------------------------------------------------------------
client.on('guildMemberAdd', async (member) => {
  await sys.handleAntiraidJoin(member).catch(() => {});
  await sys.onMemberJoinGreetvoice(member).catch(() => {});

  const cfg = db.getConfig(member.guild.id);
  if (cfg.welcome.enabled && cfg.welcome.channel) {
    const ch = member.guild.channels.cache.get(cfg.welcome.channel);
    const text = cfg.welcome.message.replace('{user}', `${member}`).replace('{server}', member.guild.name).replace('{count}', member.guild.memberCount);
    if (ch?.isTextBased()) ch.send({ embeds: [ui.okEmbed('👋 Welcome!', text)] }).catch(() => {});
    if (cfg.welcome.autoroleId) member.roles.add(cfg.welcome.autoroleId).catch(() => {});
  }
  if (cfg.greetmessage.enabled && cfg.greetmessage.channelId) {
    const ch = member.guild.channels.cache.get(cfg.greetmessage.channelId);
    const text = cfg.greetmessage.message.replace('{user}', `${member}`).replace('{server}', member.guild.name);
    if (ch?.isTextBased()) ch.send({ embeds: [ui.okEmbed('👋 Welcome', text)] }).catch(() => {});
  }
  if (cfg.autorole.enabled && cfg.autorole.roleId) member.roles.add(cfg.autorole.roleId).catch(() => {});

  const sticky = db.getStickyRoles(member.guild.id, member.id);
  if (sticky.length) member.roles.add(sticky).catch(() => {});

  const log = await sys.getLogChannel(member.guild, 'join');
  if (log) log.send({ embeds: [ui.okEmbed('📥 Member Joined', `${member} (${member.user.tag})`)] }).catch(() => {});
});

client.on('guildMemberRemove', async (member) => {
  const cfg = db.getConfig(member.guild.id);
  if (cfg.leave.enabled && cfg.leave.channel) {
    const ch = member.guild.channels.cache.get(cfg.leave.channel);
    const text = cfg.leave.message.replace('{user}', member.user.tag);
    if (ch?.isTextBased()) ch.send({ embeds: [ui.warnEmbed('👋 Member Left', text)] }).catch(() => {});
  }
  if (member.roles?.cache?.size) {
    db.setStickyRoles(member.guild.id, member.id, member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.id));
  }
  const log = await sys.getLogChannel(member.guild, 'join');
  if (log) log.send({ embeds: [ui.warnEmbed('📤 Member Left', `${member.user.tag}`)] }).catch(() => {});

  const executor = await sys.findAuditExecutor(member.guild, AuditLogEvent.MemberKick, member.id);
  if (executor) await sys.antinukeStrike(member.guild, executor, 'kick').catch(() => {});
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const cfg = db.getConfig(newMember.guild.id);
  if (!oldMember.premiumSince && newMember.premiumSince && cfg.boost.enabled && cfg.boost.channel) {
    const ch = newMember.guild.channels.cache.get(cfg.boost.channel);
    const text = cfg.boost.message.replace('{user}', `${newMember}`);
    if (ch?.isTextBased()) ch.send({ embeds: [ui.okEmbed('🚀 Server Boost!', text)] }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------------
// messageCreate — antilink, antispam, leveling, automod, prefix-less utility
// ---------------------------------------------------------------------------------
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  await sys.handleAntilink(message).catch(() => {});
  await sys.handleAntispam(message).catch(() => {});
  await sys.handleLevelingMessage(message).catch(() => {});

  const cfg = db.getConfig(message.guild.id).automod;
  if (cfg.badWordFilter && cfg.badWords.some(w => message.content.toLowerCase().includes(w.toLowerCase()))) {
    await message.delete().catch(() => {});
  }
});

// ---------------------------------------------------------------------------------
// voiceStateUpdate — greetvoice TTS gate, voicemaster join-to-create
// ---------------------------------------------------------------------------------
client.on('voiceStateUpdate', async (oldState, newState) => {
  if (newState.channelId && newState.channelId !== oldState.channelId) {
    await sys.onVoiceJoinGreetvoice(oldState, newState).catch(() => {});
  }
  await sys.handleVoicemasterJoin(oldState, newState).catch(() => {});

  const log = await sys.getLogChannel(newState.guild, 'voice');
  if (log && newState.channelId !== oldState.channelId) {
    const desc = newState.channelId
      ? `${newState.member} joined <#${newState.channelId}>`
      : `${newState.member} left <#${oldState.channelId}>`;
    log.send({ embeds: [ui.base('🔊 Voice Update').setDescription(desc)] }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------------
// Antinuke event hooks
// ---------------------------------------------------------------------------------
client.on('channelDelete', async (channel) => {
  if (!channel.guild) return;
  const executor = await sys.findAuditExecutor(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
  if (executor) await sys.antinukeStrike(channel.guild, executor, 'channelDelete');
});
client.on('channelCreate', async (channel) => {
  if (!channel.guild) return;
  await sys.onChannelCreateGreetvoiceSync(channel).catch(() => {});
  const executor = await sys.findAuditExecutor(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
  if (executor) await sys.antinukeStrike(channel.guild, executor, 'channelCreate');
});
client.on('roleDelete', async (role) => {
  const executor = await sys.findAuditExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
  if (executor) await sys.antinukeStrike(role.guild, executor, 'roleDelete');
});
client.on('roleCreate', async (role) => {
  const executor = await sys.findAuditExecutor(role.guild, AuditLogEvent.RoleCreate, role.id);
  if (executor) await sys.antinukeStrike(role.guild, executor, 'roleCreate');
});
client.on('roleUpdate', async (oldRole, newRole) => {
  if (oldRole.permissions.bitfield === newRole.permissions.bitfield) return;
  const executor = await sys.findAuditExecutor(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
  if (executor) await sys.antinukeStrike(newRole.guild, executor, 'roleUpdate');
});
client.on('guildBanAdd', async (ban) => {
  const executor = await sys.findAuditExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  if (executor) await sys.antinukeStrike(ban.guild, executor, 'ban');
});
client.on('webhooksUpdate', async (channel) => {
  const executor = await sys.findAuditExecutor(channel.guild, AuditLogEvent.WebhookCreate);
  if (executor) await sys.antinukeStrike(channel.guild, executor, 'webhookCreate');
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

client.login(process.env.DISCORD_TOKEN);
