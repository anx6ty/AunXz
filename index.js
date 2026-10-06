/**
 * AunXz — All-in-One Discord Bot
 * Developed for maximum functionality, ease of use, and complete server management.
 */

const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
  REST,
  Routes
} = require('discord.js');

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const db = require('./database');
const {
  getGuildConfig,
  updateGuildConfig,
  getBotStats,
  logAction,
  addWarn,
  getWarns,
  clearWarns,
  setUserBalance,
  getUserBalance,
  addXp,
  getUserLevel,
  createTicket,
  getTicket,
  closeTicket,
  saveGiveaway,
  getGiveaways,
  deleteGiveaway
} = db;

const systems = require('./systems');
const ui = require('./ui');
const v2patch = require('./v2patch');

// Create Client instance
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildIntegrations,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [
    Partials.User,
    Partials.Channel,
    Partials.GuildMember,
    Partials.Message,
    Partials.Reaction,
    Partials.GuildScheduledEvent,
    Partials.ThreadMember
  ]
});

client.commands = new Collection();
client.cooldowns = new Collection();

// Auxiliary helper to log to configured channel
async function sendLogMessage(guild, title, description, color = 0x3498db, fields = []) {
  try {
    const cfg = getGuildConfig(guild.id);
    if (!cfg || !cfg.log_channel_id) return;
    const channel = guild.channels.cache.get(cfg.log_channel_id);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(color)
      .setTimestamp();

    if (fields.length > 0) embed.addFields(fields);

    await channel.send({ embeds: [embed] }).catch(() => {});
  } catch (err) {
    console.error('Error sending log message:', err);
  }
}

// Ready event
client.once('ready', async () => {
  console.log(`========================================`);
  console.log(`[READY] Logged in as ${client.user.tag} (${client.user.id})`);
  console.log(`[READY] Serving ${client.guilds.cache.size} guilds`);
  console.log(`========================================`);

  // Initialize modular systems
  if (v2patch && typeof v2patch.init === 'function') v2patch.init(client);
  if (systems && typeof systems.init === 'function') systems.init(client);

  client.user.setActivity('Managing servers | /help', { type: 3 });
});

// Member join handler (Welcome system & Auto-role)
client.on('guildMemberAdd', async (member) => {
  try {
    const cfg = getGuildConfig(member.guild.id);
    if (!cfg) return;

    // Auto Role
    if (cfg.auto_role_id) {
      const role = member.guild.roles.cache.get(cfg.auto_role_id);
      if (role) {
        await member.roles.add(role).catch(() => {});
      }
    }

    // Welcome Message
    if (cfg.welcome_channel_id) {
      const channel = member.guild.channels.cache.get(cfg.welcome_channel_id);
      if (channel) {
        const welcomeMsg = (cfg.welcome_message || 'Welcome to the server, {user}!')
          .replace(/{user}/g, `${member}`)
          .replace(/{username}/g, member.user.username)
          .replace(/{server}/g, member.guild.name)
          .replace(/{count}/g, member.guild.memberCount);

        const embed = new EmbedBuilder()
          .setTitle('Welcome!')
          .setDescription(welcomeMsg)
          .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
          .setColor(0x2ecc71)
          .setTimestamp();

        await channel.send({ content: `${member}`, embeds: [embed] }).catch(() => {});
      }
    }

    sendLogMessage(
      member.guild,
      'Member Joined',
      `${member} (${member.user.tag}) joined the server. Total members: **${member.guild.memberCount}**`,
      0x2ecc71
    );
  } catch (err) {
    console.error('Error on guildMemberAdd:', err);
  }
});

// Member leave handler
client.on('guildMemberRemove', async (member) => {
  try {
    sendLogMessage(
      member.guild,
      'Member Left',
      `**${member.user.tag}** (${member.id}) has left the server.`,
      0xe74c3c
    );
  } catch (err) {
    console.error('Error on guildMemberRemove:', err);
  }
});

// Message create handler (Automod, Economy XP, Prefix commands support)
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  // Leveling / XP System
  try {
    const xpToAdd = Math.floor(Math.random() * 10) + 15;
    const res = addXp(message.guild.id, message.author.id, xpToAdd);
    if (res && res.leveledUp) {
      message.channel.send(`🎉 Congratulations ${message.author}! You reached **Level ${res.newLevel}**!`).catch(() => {});
    }
  } catch (err) {
    console.error('Error adding XP:', err);
  }

  // Automod system execution
  if (systems && typeof systems.handleMessage === 'function') {
    const intercepted = await systems.handleMessage(message);
    if (intercepted) return;
  }
});

// Interaction handler (Slash commands, Buttons, Select Menus, Modals)
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      // Built-in basic commands handling
      if (commandName === 'ping') {
        const pingEmbed = new EmbedBuilder()
          .setTitle('🏓 Pong!')
          .addFields(
            { name: 'Bot Latency', value: `${Math.round(client.ws.ping)}ms`, inline: true },
            { name: 'API Latency', value: `${Date.now() - interaction.createdTimestamp}ms`, inline: true }
          )
          .setColor(0x3498db);
        return interaction.reply({ embeds: [pingEmbed], ephemeral: true });
      }

      if (commandName === 'serverinfo') {
        const { guild } = interaction;
        const embed = new EmbedBuilder()
          .setTitle(`Server Info - ${guild.name}`)
          .setThumbnail(guild.iconURL({ dynamic: true }))
          .addFields(
            { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
            { name: 'Members', value: `${guild.memberCount}`, inline: true },
            { name: 'Created At', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
            { name: 'Roles', value: `${guild.roles.cache.size}`, inline: true },
            { name: 'Channels', value: `${guild.channels.cache.size}`, inline: true }
          )
          .setColor(0x9b59b6);
        return interaction.reply({ embeds: [embed] });
      }

      if (commandName === 'userinfo') {
        const target = interaction.options.getUser('target') || interaction.user;
        const member = await interaction.guild.members.fetch(target.id).catch(() => null);

        const embed = new EmbedBuilder()
          .setTitle(`User Info - ${target.tag}`)
          .setThumbnail(target.displayAvatarURL({ dynamic: true }))
          .addFields(
            { name: 'ID', value: target.id, inline: true },
            { name: 'Joined Server', value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Unknown', inline: true },
            { name: 'Account Created', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:R>`, inline: true }
          )
          .setColor(0x3498db);
        return interaction.reply({ embeds: [embed] });
      }

      if (commandName === 'kick') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.KickMembers)) {
          return interaction.reply({ content: '❌ You do not have permission to kick members.', ephemeral: true });
        }
        const user = interaction.options.getUser('target');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);

        if (!member) return interaction.reply({ content: 'User not found in this server.', ephemeral: true });
        if (!member.kickable) return interaction.reply({ content: 'I cannot kick this member.', ephemeral: true });

        await member.kick(reason);
        sendLogMessage(interaction.guild, 'Member Kicked', `**${user.tag}** was kicked by ${interaction.user}.\n**Reason:** ${reason}`, 0xe67e22);
        return interaction.reply({ content: `✅ Kicked **${user.tag}** for: ${reason}` });
      }

      if (commandName === 'ban') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.BanMembers)) {
          return interaction.reply({ content: '❌ You do not have permission to ban members.', ephemeral: true });
        }
        const user = interaction.options.getUser('target');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);

        if (member && !member.bannable) return interaction.reply({ content: 'I cannot ban this member.', ephemeral: true });

        await interaction.guild.members.ban(user.id, { reason });
        sendLogMessage(interaction.guild, 'Member Banned', `**${user.tag}** was banned by ${interaction.user}.\n**Reason:** ${reason}`, 0xe74c3c);
        return interaction.reply({ content: `✅ Banned **${user.tag}** for: ${reason}` });
      }

      if (commandName === 'clear') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
          return interaction.reply({ content: '❌ You lack permission to manage messages.', ephemeral: true });
        }
        const amount = interaction.options.getInteger('amount');
        if (amount < 1 || amount > 100) return interaction.reply({ content: 'Please specify a number between 1 and 100.', ephemeral: true });

        const deleted = await interaction.channel.bulkDelete(amount, true);
        return interaction.reply({ content: `🧹 Deleted ${deleted.size} messages.`, ephemeral: true });
      }

      if (commandName === 'warn') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
          return interaction.reply({ content: '❌ Missing permission to warn members.', ephemeral: true });
        }
        const user = interaction.options.getUser('target');
        const reason = interaction.options.getString('reason') || 'No reason provided';

        addWarn(interaction.guild.id, user.id, interaction.user.id, reason);
        const warns = getWarns(interaction.guild.id, user.id);

        sendLogMessage(interaction.guild, 'Member Warned', `**${user.tag}** received a warning from ${interaction.user}.\n**Reason:** ${reason}\n**Total Warnings:** ${warns.length}`, 0xf1c40f);
        return interaction.reply({ content: `⚠️ Warned **${user.tag}**. They now have **${warns.length}** warning(s).` });
      }

      if (commandName === 'warnings') {
        const user = interaction.options.getUser('target') || interaction.user;
        const warns = getWarns(interaction.guild.id, user.id);

        if (warns.length === 0) {
          return interaction.reply({ content: `**${user.tag}** has no warnings.`, ephemeral: true });
        }

        const embed = new EmbedBuilder()
          .setTitle(`Warnings for ${user.tag}`)
          .setColor(0xf1c40f)
          .setDescription(warns.map((w, i) => `**#${i + 1}** by <@${w.moderator_id}>: ${w.reason} (<t:${Math.floor(w.timestamp / 1000)}:R>)`).join('\n'));

        return interaction.reply({ embeds: [embed] });
      }

      if (commandName === 'clearwarns') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '❌ Administrator permission required.', ephemeral: true });
        }
        const user = interaction.options.getUser('target');
        clearWarns(interaction.guild.id, user.id);
        return interaction.reply({ content: `✅ Cleared all warnings for **${user.tag}**.` });
      }

      if (commandName === 'level') {
        const target = interaction.options.getUser('target') || interaction.user;
        const data = getUserLevel(interaction.guild.id, target.id);

        const embed = new EmbedBuilder()
          .setTitle(`Level Info - ${target.username}`)
          .addFields(
            { name: 'Level', value: `${data.level}`, inline: true },
            { name: 'XP', value: `${data.xp} / ${data.level * 100}`, inline: true }
          )
          .setColor(0x3498db);

        return interaction.reply({ embeds: [embed] });
      }

      if (commandName === 'ticket-setup') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '❌ Administrator permission required.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
          .setTitle('📩 Support Tickets')
          .setDescription('Need help or have questions? Click the button below to open a ticket!')
          .setColor(0x3498db);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('create_ticket')
            .setLabel('Open Ticket')
            .setEmoji('🎫')
            .setStyle(ButtonStyle.Primary)
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: '✅ Ticket system setup complete!', ephemeral: true });
      }

      // Execute custom commands if loaded into collection
      const command = client.commands.get(commandName);
      if (command) {
        await command.execute(interaction, client);
      }
    } else if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
      // Delegate interaction handling to UI module
      if (ui && typeof ui.handleInteraction === 'function') {
        await ui.handleInteraction(interaction, client);
      }
    }
  } catch (error) {
    console.error('[ERROR] Interaction execution error:', error);
    const replyPayload = { content: '❌ An error occurred while executing this action!', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(replyPayload).catch(() => {});
    } else {
      await interaction.reply(replyPayload).catch(() => {});
    }
  }
});

// Full settings configuration mapping (Including line 1258 fix)
const settingsConfig = [
  { key: 'log_channel', oKey: 'log_channel_id', label: 'Log Channel ID', parse: v => v.replace(/[<#>]/g, '') },
  { key: 'welcome_channel', oKey: 'welcome_channel_id', label: 'Welcome Channel ID', parse: v => v.replace(/[<#>]/g, '') },
  { key: 'auto_role', oKey: 'auto_role_id', label: 'Auto Role ID', parse: v => v.replace(/[<@&>]/g, '') },
  { key: 'mute_role', oKey: 'mute_role_id', label: 'Mute Role ID', parse: v => v.replace(/[<@&>]/g, '') },
  { key: 'bypass_role', oKey: 'bypass_role_id', label: 'Trusted inviter role ID (blank = none)', parse: v => v.replace(/[<@&>]/g, '') }
];

// Unhandled Promise Rejection & Exception protection
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED_REJECTION]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT_EXCEPTION]', err);
});

// Login client
client.login(process.env.DISCORD_TOKEN || process.env.TOKEN);
