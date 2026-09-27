// index.js — boots the client, registers slash commands, and wires every Discord event
// to the systems/commands/ui modules. This is the only file that touches gateway events.

require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  ChannelType, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ButtonBuilder, ButtonStyle,
  AuditLogEvent, PermissionsBitField
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
  const publicBody = commands.filter(c => !c.ownerOnly).map(c => c.data.toJSON());
  const ownerBody = commands.filter(c => c.ownerOnly).map(c => c.data.toJSON());

  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: publicBody });
  console.log(`Registered ${publicBody.length} global commands.`);

  const ownerGuildId = process.env.OWNER_GUILD_ID || process.env.GUILD_ID;
  if (ownerGuildId && ownerBody.length) {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, ownerGuildId), { body: ownerBody });
    console.log(`Registered ${ownerBody.length} owner-only commands to guild${ownerGuildId}.`);
  } else if (ownerBody.length) {
    console.log(`OWNER_GUILD_ID not set — ${ownerBody.length} owner-only command(s) not registered as slash commands.`);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity('/help');
  try { await registerCommands(); } catch (e) { console.error('Command registration failed:', e); }
});

// ---------------------------------------------------------------------------------
// Text-command engine & helpers
// ---------------------------------------------------------------------------------
const OPT = { SUBCOMMAND: 1, SUBCOMMAND_GROUP: 2, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7, ROLE: 8, MENTIONABLE: 9, NUMBER: 10 };

function tokenize(str) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

function findOptionsSchema(json, tokens) {
  let options = json.options || [];
  let group = null, subcommand = null;
  if (options.length && options[0].type === OPT.SUBCOMMAND_GROUP) {
    const name = (tokens.shift() || '').toLowerCase();
    const g = options.find(o => o.name === name && o.type === OPT.SUBCOMMAND_GROUP);
    if (!g) return null;
    group = g.name;
    options = g.options || [];
  }
  if (options.length && options[0].type === OPT.SUBCOMMAND) {
    const name = (tokens.shift() || '').toLowerCase();
    const s = options.find(o => o.name === name && o.type === OPT.SUBCOMMAND);
    if (!s) return null;
    subcommand = s.name;
    options = s.options || [];
  }
  return { leafOptions: options, subcommand, group };
}

function resolveOptionValue(type, raw, message) {
  if (raw === undefined || raw === null) return null;
  switch (type) {
    case OPT.INTEGER: { const n = parseInt(raw, 10); return Number.isNaN(n) ? null : n; }
    case OPT.NUMBER: { const n = parseFloat(raw); return Number.isNaN(n) ? null : n; }
    case OPT.BOOLEAN: return /^(true|yes|on|enable)$/i.test(raw);
    case OPT.USER: {
      const id = raw.replace(/[<@!>]/g, '');
      return message.mentions.users.get(id) || message.client.users.cache.get(id) || null;
    }
    case OPT.ROLE: {
      const id = raw.replace(/[<@&>]/g, '');
      return message.mentions.roles.get(id) || message.guild.roles.cache.get(id) ||
        message.guild.roles.cache.find(r => r.name.toLowerCase() === raw.toLowerCase()) || null;
    }
    case OPT.CHANNEL: {
      const id = raw.replace(/[<#>]/g, '');
      return message.mentions.channels.get(id) || message.guild.channels.cache.get(id) || null;
    }
    default: return raw;
  }
}

function parseLeafArgs(leafOptions, tokens) {
  const raw = {};
  for (let i = 0; i < leafOptions.length; i++) {
    const opt = leafOptions[i];
    if (i === leafOptions.length - 1 && opt.type === OPT.STRING) {
      const rest = tokens.slice(i).join(' ');
      if (rest) raw[opt.name] = rest;
      else if (opt.required) return null;
      break;
    }
    const tok = tokens[i];
    if (tok === undefined) { if (opt.required) return null; continue; }
    raw[opt.name] = tok;
  }
  return raw;
}

function usageLines(prefix, json) {
  function walk(options, pathParts) {
    if (!options || !options.length) {
      return [`${prefix}${json.name}${pathParts.length ? ' ' + pathParts.join(' ') : ''}`];
    }
    if (options[0].type === OPT.SUBCOMMAND || options[0].type === OPT.SUBCOMMAND_GROUP) {
      return options.flatMap(o => walk(o.options, [...pathParts, o.name]));
    }
    const argStr = options.map(o => o.required ? `<${o.name}>` : `[${o.name}]`).join(' ');
    return [`${prefix}${json.name}${pathParts.length ? ' ' + pathParts.join(' ') : ''}${argStr ? ' ' + argStr : ''}`];
  }
  return walk(json.options, []);
}

function buildFakeInteraction(message, json, tokens) {
  const schema = findOptionsSchema(json, tokens);
  if (!schema) return null;
  const rawValues = parseLeafArgs(schema.leafOptions, tokens);
  if (rawValues === null) return null;

  const values = {};
  for (const opt of schema.leafOptions) {
    if (rawValues[opt.name] === undefined) continue;
    values[opt.name] = opt.type === OPT.STRING ? rawValues[opt.name] : resolveOptionValue(opt.type, rawValues[opt.name], message);
  }

  const getter = (name) => (values[name] === undefined ? null : values[name]);
  const fake = {
    isChatInputCommand: () => true,
    commandName: json.name,
    guild: message.guild,
    guildId: message.guildId,
    member: message.member,
    user: message.author,
    channel: message.channel,
    client: message.client,
    deferred: false,
    replied: false,
    options: {
      getString: getter, getInteger: getter, getNumber: getter, getBoolean: getter,
      getUser: getter, getRole: getter, getChannel: getter, getMentionable: getter,
      getSubcommand: () => schema.subcommand
    },
    reply: async (payload) => { fake.replied = true; return message.reply(stripEphemeral(payload)); },
    followUp: async (payload) => message.channel.send(stripEphemeral(payload)),
    editReply: async (payload) => message.channel.send(stripEphemeral(payload)),
    deferReply: async () => { fake.deferred = true; },
    showModal: async () => message.reply({ embeds: [ui.warnEmbed('Slash Command Needed', 'That action opens a popup form — use the `/' + json.name + '` slash command instead.')] })
  };
  return fake;
}

function stripEphemeral(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const { ephemeral, ...rest } = payload;
  return rest;
}

async function handlePrefixCommand(message) {
  const cfg = db.getConfig(message.guild.id);
  const prefix = cfg.prefix || '!';
  if (!message.content.startsWith(prefix)) return false;
  const tokens = tokenize(message.content.slice(prefix.length).trim());
  const cmdName = (tokens.shift() || '').toLowerCase();
  if (!cmdName) return false;
  const cmd = commands.find(c => c.data.name === cmdName);
  if (!cmd) return false;

  if (cfg.blacklist.includes(message.author.id) && !isOwner(message.author.id)) {
    message.reply({ embeds: [ui.errorEmbed('Blacklisted', 'You are blocked from using this bot.')] }).catch(() => {});
    return true;
  }

  const json = cmd.data.toJSON();
  const fake = buildFakeInteraction(message, json, tokens);
  if (!fake) {
    message.reply({ embeds: [ui.errorEmbed('Invalid Usage', usageLines(prefix, json).map(l => `\`${l}\``).join('\n'))] }).catch(() => {});
    return true;
  }
  try {
    await cmd.execute(fake);
  } catch (e) {
    console.error(e);
    message.reply({ embeds: [ui.errorEmbed('Error', 'Something went wrong running that.')] }).catch(() => {});
  }
  return true;
}

// ---------------------------------------------------------------------------------
// interactionCreate — slash commands, interactive setup views, buttons, select menus, modals
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

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'help_select') {
        const key = interaction.values[0];
        return interaction.update({ embeds: [ui.helpCategoryEmbed(key)], components: [ui.helpSelectRow()] });
      }

      // Handle Select Menu for Kicking Members from Temp VC
      if (interaction.customId.startsWith('vm_kick_select_')) {
        return handleVCKickSelect(interaction);
      }
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

  // ---- Temp VC / Voicemaster Control Buttons ----
  if (id.startsWith('vm_')) {
    const vc = interaction.member.voice.channel;
    if (!vc || !db.getVMChannel(vc.id)) return interaction.reply({ embeds: [ui.errorEmbed('No Channel', 'You are not inside your temporary voice channel.')], ephemeral: true });
    
    const record = db.getVMChannel(vc.id);
    if (record.ownerId !== interaction.user.id) {
      return interaction.reply({ embeds: [ui.errorEmbed('Access Denied 🚫', 'Only the owner of this Voice Channel can use these controls.')], ephemeral: true });
    }

    const everyone = interaction.guild.roles.everyone;

    // Toggle Lock / Unlock
    if (id === 'vm_lock' || id === 'vm_unlock') {
      const isLocked = vc.permissionsFor(everyone).has(PermissionsBitField.Flags.Connect) === false;
      await vc.permissionOverwrites.edit(everyone, { Connect: isLocked ? null : false });
      return interaction.reply({
        embeds: [ui.okEmbed(isLocked ? '🔓 Channel Unlocked' : '🔒 Channel Locked', isLocked ? 'Your Voice Channel is now **unlocked** for everyone.' : 'Your Voice Channel is now **locked**.')],
        ephemeral: true
      });
    }

    // Toggle Hide / Unhide
    if (id === 'vm_hide' || id === 'vm_unhide') {
      const isHidden = vc.permissionsFor(everyone).has(PermissionsBitField.Flags.ViewChannel) === false;
      await vc.permissionOverwrites.edit(everyone, { ViewChannel: isHidden ? null : false });
      return interaction.reply({
        embeds: [ui.okEmbed(isHidden ? '👁️ Channel Visible' : '🙈 Channel Hidden', isHidden ? 'Your Voice Channel is now **visible** to all members.' : 'Your Voice Channel is now **hidden**.')],
        ephemeral: true
      });
    }

    // Interactive Kick Selection Menu Trigger
    if (id === 'vm_kick') {
      const membersInVc = vc.members.filter(m => m.id !== interaction.user.id);

      if (membersInVc.size === 0) {
        return interaction.reply({
          embeds: [ui.warnEmbed('⚠️ Voice Channel Empty', 'There are currently no other members in your Voice Channel to disconnect.')],
          ephemeral: true
        });
      }

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`vm_kick_select_${interaction.user.id}`)
        .setPlaceholder('Select a member to disconnect...');

      membersInVc.forEach(m => {
        selectMenu.addOptions(
          new StringSelectMenuOptionBuilder()
            .setLabel(m.displayName)
            .setValue(m.id)
            .setDescription(`User ID: ${m.id}`)
            .setEmoji('👤')
        );
      });

      const menuRow = new ActionRowBuilder().addComponents(selectMenu);
      const kickEmbed = ui.base('👢 Kick Voice Channel Member')
        .setDescription('Select a member from the dropdown menu below to disconnect them from your Voice Channel.')
        .setColor(0xE67E22);

      return interaction.reply({ embeds: [kickEmbed], components: [menuRow], ephemeral: true });
    }

    if (id === 'vm_rename' || id === 'vm_limit' || id === 'vm_transfer') return openVMModal(interaction, id);
  }
}

// Handler for the Ephemeral Kick Selection Menu Callback
async function handleVCKickSelect(interaction) {
  const targetId = interaction.values[0];
  const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
  const ownerVoiceChannel = interaction.member.voice.channel;

  if (!targetMember || !targetMember.voice.channelId || targetMember.voice.channelId !== ownerVoiceChannel?.id) {
    return interaction.reply({
      embeds: [ui.errorEmbed('❌ Member Unavailable', 'The selected user is **no longer present** inside your Voice Channel.')],
      ephemeral: true
    });
  }

  await targetMember.voice.disconnect().catch(() => {});

  return interaction.reply({
    embeds: [ui.okEmbed('👢 Member Disconnected', `Successfully kicked **${targetMember.user.tag}** from **${ownerVoiceChannel.name}**.`)],
    ephemeral: true
  });
}

async function openVMModal(interaction, id) {
  const fieldMap = {
    vm_rename: { title: 'Rename Channel', label: 'New name', id: 'value' },
    vm_limit: { title: 'Set User Limit', label: 'Limit (0 = unlimited)', id: 'value' },
    vm_transfer: { title: 'Transfer Ownership', label: 'User ID to transfer to', id: 'value' }
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
  if (interaction.customId === 'vm_transfer') {
    db.removeVMChannel(vc.id);
    db.addVMChannel(vc.id, interaction.guildId, value.trim());
    return interaction.reply({ embeds: [ui.okEmbed('🔁 Ownership Transferred', `New owner: <@${value.trim()}>`)], ephemeral: true });
  }
}

// ---------------------------------------------------------------------------------
// guildMemberAdd — antiraid, welcome, autorole, sticky roles (GreetVoice Excluded)
// ---------------------------------------------------------------------------------
client.on('guildMemberAdd', async (member) => {
  await sys.handleAntiraidJoin(member).catch(() => {});

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
// messageCreate — antilink, antispam, leveling, automod, prefix commands
// ---------------------------------------------------------------------------------
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  const wasCommand = await handlePrefixCommand(message).catch((e) => { console.error(e); return false; });
  if (wasCommand) return;
  await sys.handleAntilink(message).catch(() => {});
  await sys.handleAntispam(message).catch(() => {});
  await sys.handleLevelingMessage(message).catch(() => {});

  const cfg = db.getConfig(message.guild.id).automod;
  if (cfg.badWordFilter && cfg.badWords.some(w => message.content.toLowerCase().includes(w.toLowerCase()))) {
    await message.delete().catch(() => {});
  }
});

// ---------------------------------------------------------------------------------
// voiceStateUpdate — greetvoice state management, voicemaster join-to-create
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
