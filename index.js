// AunXz/index.js — boot, event wiring, interaction routing, lifecycle.
'use strict';
require('dotenv').config();

console.log('[AunXz] Booting…');

const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder, PermissionFlagsBits, AuditLogEvent
} = require('discord.js');
const db = require('./database');
const sys = require('./systems');
const cmd = require('./commands');

// =============================================================================
// ENV VALIDATION
// =============================================================================
const REQUIRED = ['DISCORD_TOKEN', 'CLIENT_ID'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}
if (!process.env.GROQ_API_KEY) console.warn('⚠️  GROQ_API_KEY not set — AI features (/ask, /templategen) will be unavailable.');

// =============================================================================
// CLIENT
// =============================================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.Reaction]
});

// =============================================================================
// RUNTIME STORES (bounded, pruned)
// =============================================================================
const sessions = new Map(); // component state: snipe paging, wizard, etc.
const SESSION_TTL_MS = 5 * 60 * 1000;

function setSession(id, data) { sessions.set(id, { ...data, expiresAt: Date.now() + SESSION_TTL_MS }); return id; }
function getSession(id) { return sessions.get(id); }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.expiresAt && v.expiresAt < now) sessions.delete(k);
}, 60000).unref?.();

// =============================================================================
// ERROR HANDLING
// =============================================================================
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', e => { console.error('[uncaughtException]', e); });
client.on('error', e => console.error('[client error]', e?.message || e));

async function logError(err, context = '', meta = {}) {
  console.error(`[${context}]`, err?.message || err);
  try {
    db.recordError({
      source: context,
      command: meta.command,
      guildId: meta.guildId,
      userId: meta.userId,
      message: err?.message || String(err),
      stack: err?.stack || ''
    });
  } catch {}
}

// =============================================================================
// READY
// =============================================================================
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`   Database: ${db.DB_PATH}`);
  client.user.setActivity('/help', { type: 3 });

  // Command registration
  try {
    const body = uniqueByName(cmd.commands.map(c => c.data.toJSON()));
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body });
    console.log(`✅ Registered ${body.length} global commands.`);
  } catch (e) { await logError(e, 'Command registration'); }

  // Prime automod cache for guilds in the bot
  for (const g of client.guilds.cache.values()) sys.refreshAutomod(g.id);

  // Giveaway scheduler
  setInterval(async () => {
    try {
      const now = Date.now();
      for (const g of client.guilds.cache.values()) {
        for (const gw of db.listGiveaways(g.id, 50)) {
          if (gw.status === 'active' && gw.endsAt <= now) {
            await sys.endGiveaway(client, g.id, gw.id).catch(() => {});
          }
        }
      }
    } catch (e) { console.error('giveaway tick', e?.message); }
  }, 15000).unref?.();

  // Join tracker pruning
  setInterval(() => {
    for (const g of client.guilds.cache.values()) db.pruneJoins(g.id, 3600);
  }, 300000).unref?.();
});

function uniqueByName(bodies) {
  const seen = new Set();
  return bodies.filter(b => { if (seen.has(b.name)) return false; seen.add(b.name); return true; });
}

// =============================================================================
// INTERACTION ROUTER
// =============================================================================
client.on('interactionCreate', async interaction => {
  try {
    // Global blacklist check
    if (interaction.user && db.getGlobalBlacklist().includes(interaction.user.id)) {
      return interaction.reply({ content: 'You are blocked from using AunXz.', ephemeral: true }).catch(() => {});
    }
    // Maintenance mode (owner bypass)
    if (db.getOwnerConfig().maintenance && !sys.isOwner(interaction.user.id)) {
      return interaction.reply({ content: 'AunXz is in maintenance mode.', ephemeral: true }).catch(() => {});
    }

    if (interaction.isAutocomplete()) return;

    if (interaction.isChatInputCommand()) {
      const c = cmd.commands.find(x => x.data.name === interaction.commandName);
      if (!c) return;
      const disabled = db.getToggle(interaction.commandName);
      if (disabled && !sys.isOwner(interaction.user.id)) {
        return interaction.reply({ embeds: [sys.warnEmbed(interaction.guildId, `**/${interaction.commandName}** is temporarily disabled.${disabled.reason ? `\nReason: ${disabled.reason}` : ''}`)], ephemeral: true });
      }
      return await c.execute(interaction);
    }

    if (interaction.isStringSelectMenu()) return await handleSelect(interaction);
    if (interaction.isChannelSelectMenu()) return await handleChannelSelect(interaction);
    if (interaction.isRoleSelectMenu()) return await handleRoleSelect(interaction);
    if (interaction.isButton()) return await handleButton(interaction);
    if (interaction.isModalSubmit()) return await handleModal(interaction);
  } catch (e) {
    await logError(e, `Interaction ${interaction.commandName || interaction.customId || interaction.id}`, {
      command: interaction.commandName,
      guildId: interaction.guildId,
      userId: interaction.user?.id
    });
    const payload = { embeds: [sys.errEmbed(interaction.guildId, 'Something went wrong. The issue has been logged.')], ephemeral: true };
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch {}
  }
});

// =============================================================================
// BUTTON HANDLERS
// =============================================================================
async function handleButton(interaction) {
  const id = interaction.customId;

  // Help category select is handled in handleSelect (StringSelectMenu).

  // Setup health/backup buttons
  if (id === 'setup:health') {
    await interaction.deferReply({ ephemeral: true });
    const issues = await sys.healthCheck(interaction.guild);
    const e = sys.embed(interaction.guildId, issues.length ? 'warning' : 'success', {
      title: '🩺 Health Check',
      description: issues.length
        ? issues.map(x => `${x.severity === 'high' ? '🔴' : x.severity === 'medium' ? '🟡' : '🟢'} ${x.text}`).join('\n')
        : 'All checks passed.'
    });
    return interaction.editReply({ embeds: [e] });
  }
  if (id === 'setup:backup') {
    const data = db.exportGuild(interaction.guildId);
    const buf = Buffer.from(JSON.stringify(data, null, 2));
    return interaction.reply({ content: 'Backup attached.', files: [{ attachment: buf, name: `aunxz-${interaction.guildId}.json` }], ephemeral: true });
  }
  if (id === 'setup:wizard') {
    return interaction.reply({ embeds: [cmd.wizardStartEmbed(interaction.guildId)], components: [cmd.wizardModuleRow()], ephemeral: true });
  }

  // Ticket open
  if (id === 'ticket_open') {
    const cfg = db.getConfig(interaction.guildId).ticket;
    if (!cfg.enabled) return interaction.reply({ embeds: [sys.errEmbed(interaction.guildId, 'Tickets are disabled.')], ephemeral: true });
    const open = db.openTicketsForUser(interaction.guildId, interaction.user.id);
    for (const t of open) {
      if (interaction.guild.channels.cache.has(t.channelId)) {
        return interaction.reply({ embeds: [sys.warnEmbed(interaction.guildId, `You already have an open ticket: <#${t.channelId}>`)], ephemeral: true });
      }
      db.setTicketStatus(t.channelId, 'closed');
    }
    await interaction.deferReply({ ephemeral: true });
    const overwrites = [
      { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }
    ];
    if (cfg.supportRoleId) overwrites.push({ id: cfg.supportRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    const channel = await interaction.guild.channels.create({
      name: `ticket-${interaction.user.username}`.toLowerCase().slice(0, 90),
      type: 0, parent: cfg.categoryId || undefined, permissionOverwrites: overwrites
    }).catch(e => { logError(e, 'Ticket channel creation'); return null; });
    if (!channel) return interaction.editReply({ embeds: [sys.errEmbed(interaction.guildId, 'Could not create the ticket channel.')] });
    db.createTicket(channel.id, interaction.guildId, interaction.user.id);
    await channel.send({ embeds: [sys.ticketWelcomeEmbed(interaction.guildId, interaction.user, cfg)], components: [sys.ticketControlRow()] }).catch(() => {});
    return interaction.editReply({ embeds: [sys.okEmbed(interaction.guildId, `Ticket opened: ${channel}`)] });
  }

  // Ticket close
  if (id === 'ticket_close') {
    const t = db.getTicket(interaction.channel.id);
    if (!t) return interaction.reply({ embeds: [sys.errEmbed(interaction.guildId, 'Not a ticket channel.')], ephemeral: true });
    db.setTicketStatus(interaction.channel.id, 'closed');
    await interaction.reply({ embeds: [sys.warnEmbed(interaction.guildId, 'Closing in 5 seconds…')] });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    return;
  }

  // Staff controls
  if (id === 'staff_controls') {
    const t = db.getTicket(interaction.channel.id);
    if (!t) return interaction.reply({ embeds: [sys.errEmbed(interaction.guildId, 'Not a ticket.')], ephemeral: true });
    const cfg = db.getConfig(interaction.guildId).ticket;
    const isSupport = cfg.supportRoleId && interaction.member.roles.cache.has(cfg.supportRoleId);
    if (!isSupport && !sys.isAdmin(interaction.member)) return interaction.reply({ embeds: [sys.errEmbed(interaction.guildId, 'Support role or Administrator required.')], ephemeral: true });
    return interaction.reply({ embeds: [sys.infoEmbed(interaction.guildId, `**Claimed by:** ${t.claimedBy ? `<@${t.claimedBy}>` : 'nobody'}`)], components: sys.staffControlsRows(!!t.claimedBy), ephemeral: true });
  }
  if (id === 'staff_claim' || id === 'staff_unclaim') {
    const t = db.getTicket(interaction.channel.id);
    if (!t) return interaction.reply({ embeds: [sys.errEmbed(interaction.guildId, 'Not a ticket.')], ephemeral: true });
    const claimed = !t.claimedBy;
    // FIX: pass explicit null so setTicketStatus nulls the column instead of leaving it alone.
    db.setTicketStatus(interaction.channel.id, t.status, claimed ? interaction.user.id : null);
    const updated = db.getTicket(interaction.channel.id);
    await interaction.update({ embeds: [sys.infoEmbed(interaction.guildId, `**Claimed by:** ${updated.claimedBy ? `<@${updated.claimedBy}>` : 'nobody'}`)], components: sys.staffControlsRows(!!updated.claimedBy) });
    return;
  }
  if (id === 'staff_delete') {
    const t = db.getTicket(interaction.channel.id);
    db.setTicketStatus(interaction.channel.id, 'closed');
    await interaction.reply({ embeds: [sys.warnEmbed(interaction.guildId, 'Deleting now…')] });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 1500);
    return;
  }
  if (id === 'staff_addmember') {
    const row = new ActionRowBuilder().addComponents(
      new (require('discord.js').UserSelectMenuBuilder)().setCustomId('ticket:add:select').setPlaceholder('Pick a member')
    );
    return interaction.reply({ embeds: [sys.infoEmbed(interaction.guildId, 'Pick the member to add.')], components: [row], ephemeral: true });
  }
  if (id === 'staff_removemember') {
    const row = new ActionRowBuilder().addComponents(
      new (require('discord.js').UserSelectMenuBuilder)().setCustomId('ticket:remove:select').setPlaceholder('Pick a member')
    );
    return interaction.reply({ embeds: [sys.infoEmbed(interaction.guildId, 'Pick the member to remove.')], components: [row], ephemeral: true });
  }

  // Snipe navigation
  if (id.startsWith('snipe:nav:')) {
    const [, , guildId, channelId, offsetStr] = id.split(':');
    const offset = parseInt(offsetStr, 10);
    const records = cmd.snipeStore.get(`${guildId}:${channelId}`) || [];
    if (!records.length) return interaction.update({ embeds: [sys.infoEmbed(guildId, 'No records.')], components: [] });
    const idx = Math.max(0, Math.min(offset, records.length - 1));
    const e = sys.snipeEmbed(guildId, records[idx], idx, records.length, interaction.user.tag);
    return interaction.update({ embeds: [e], components: sys.snipeComponents(guildId, channelId, idx, records.length) });
  }

  // Automod buttons
  if (id === 'automod:toggle' || id === 'automod:caps' || id === 'automod:invite' || id === 'automod:words') {
    if (!sys.isAdmin(interaction.member)) return interaction.reply({ embeds: [sys.errEmbed(interaction.guildId, 'Administrator required.')], ephemeral: true });
    const cfg = db.getConfig(interaction.guildId).automod;
    if (id === 'automod:toggle') db.saveConfig(interaction.guildId, { automod: { enabled: !cfg.enabled } });
    else if (id === 'automod:caps') db.saveConfig(interaction.guildId, { automod: { capsFilter: !cfg.capsFilter } });
    else if (id === 'automod:invite') db.saveConfig(interaction.guildId, { automod: { inviteFilter: !cfg.inviteFilter } });
    else if (id === 'automod:words') {
      const modal = new ModalBuilder().setCustomId('automod:words:modal').setTitle('Bad Words');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('words').setLabel('Comma-separated words').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue((cfg.badWords || []).join(', ').slice(0, 4000))
      ));
      return interaction.showModal(modal);
    }
    const next = db.getConfig(interaction.guildId).automod;
    sys.refreshAutomod(interaction.guildId);
    return interaction.update({
      embeds: [sys.baseEmbed(interaction.guildId, '🛡️ AutoMod').setDescription(`**Status:** ${next.enabled ? '🟢 Enabled' : '⚪ Disabled'}\n**Caps:** ${next.capsFilter ? `${next.capsThreshold}%` : 'Off'}\n**Invites:** ${next.inviteFilter ? 'On' : 'Off'}\n**Bad words:** ${(next.badWords || []).length}`)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('automod:toggle').setLabel(next.enabled ? 'Disable' : 'Enable').setStyle(next.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('automod:caps').setLabel('Caps Filter').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('automod:invite').setLabel('Invite Filter').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('automod:words').setLabel('Bad Words').setStyle(ButtonStyle.Secondary)
      )]
    });
  }
  if (id === 'badword:toggle') {
    const cur = db.getConfig(interaction.guildId).antibadword;
    db.saveConfig(interaction.guildId, { antibadword: { enabled: !cur.enabled } });
    sys.refreshAutomod(interaction.guildId);
    return interaction.update({ embeds: [sys.infoEmbed(interaction.guildId, `Bad-word filter ${!cur.enabled ? 'enabled' : 'disabled'}.`)], components: [] });
  }
  if (id === 'badword:words') {
    const modal = new ModalBuilder().setCustomId('badword:words:modal').setTitle('Custom Bad Words');
    const cur = db.getConfig(interaction.guildId).antibadword;
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('words').setLabel('Comma-separated words').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue((cur.customWords || []).join(', ').slice(0, 4000))
    ));
    return interaction.showModal(modal);
  }

  // Greet message buttons
  if (id === 'greetmsg:toggle') {
    const cur = db.getConfig(interaction.guildId).greetmessage;
    db.saveConfig(interaction.guildId, { greetmessage: { enabled: !cur.enabled } });
    return interaction.update({ embeds: [sys.infoEmbed(interaction.guildId, `Greet message ${!cur.enabled ? 'enabled' : 'disabled'}.`)], components: [] });
  }
  if (id === 'greetmsg:edit') {
    const cur = db.getConfig(interaction.guildId).greetmessage;
    const modal = new ModalBuilder().setCustomId('greetmsg:edit:modal').setTitle('Edit Welcome Message');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200).setValue(String(cur.title || '').slice(0, 200))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel('Message ({user} {server} {count})').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500).setValue(String(cur.message || '').slice(0, 1500)))
    );
    return interaction.showModal(modal);
  }
  if (id === 'greetmsg:test') {
    const cur = db.getConfig(interaction.guildId).greetmessage;
    const text = sys.applyTemplate(cur.message, { user: `<@${interaction.user.id}>`, username: interaction.user.username, server: interaction.guild.name, count: interaction.guild.memberCount });
    const e = sys.baseEmbed(interaction.guildId, cur.title || '👋 Welcome! (Test)').setDescription(text);
    if (cur.image) e.setImage(cur.image);
    return interaction.reply({ embeds: [e], ephemeral: true });
  }

  // Welcome/leave buttons
  if (id === 'welcome:toggle' || id === 'leave:toggle') {
    const key = id.split(':')[0];
    const cur = db.getConfig(interaction.guildId)[key];
    db.saveConfig(interaction.guildId, { [key]: { enabled: !cur.enabled } });
    return interaction.update({ embeds: [sys.infoEmbed(interaction.guildId, `${key} ${!cur.enabled ? 'enabled' : 'disabled'}.`)], components: [] });
  }
  if (id === 'welcome:edit' || id === 'leave:edit') {
    const key = id.split(':')[0];
    const cur = db.getConfig(interaction.guildId)[key];
    const modal = new ModalBuilder().setCustomId(`${key}:edit:modal`).setTitle(`Edit ${key} message`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('message').setLabel('Message ({user} {server} {count})').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500).setValue(String(cur.message || '').slice(0, 1500))
    ));
    return interaction.showModal(modal);
  }

  // Ticket setup buttons
  if (id === 'ticket:toggle') {
    const cur = db.getConfig(interaction.guildId).ticket;
    db.saveConfig(interaction.guildId, { ticket: { enabled: !cur.enabled } });
    return interaction.update({ embeds: [sys.infoEmbed(interaction.guildId, `Tickets ${!cur.enabled ? 'enabled' : 'disabled'}.`)], components: [] });
  }
  if (id === 'ticket:post') {
    const cfg = db.getConfig(interaction.guildId).ticket;
    if (!cfg.enabled) return interaction.reply({ embeds: [sys.errEmbed(interaction.guildId, 'Enable tickets first.')], ephemeral: true });
    await interaction.channel.send({ embeds: [sys.ticketPanelEmbed(interaction.guildId, cfg)], components: [sys.ticketPanelRow()] });
    return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, 'Panel posted.')], ephemeral: true });
  }

  // Leveling buttons
  if (id === 'leveling:toggle') {
    const cur = db.getConfig(interaction.guildId).leveling;
    db.saveConfig(interaction.guildId, { leveling: { enabled: !cur.enabled } });
    return interaction.update({ embeds: [sys.infoEmbed(interaction.guildId, `Leveling ${!cur.enabled ? 'enabled' : 'disabled'}.`)], components: [] });
  }
  if (id === 'leveling:rewards') {
    const cfg = db.getConfig(interaction.guildId).leveling;
    const modal = new ModalBuilder().setCustomId('leveling:rewards:modal').setTitle('Role Rewards');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('rewards').setLabel('Format: level=roleId, level2=roleId2').setStyle(TextInputStyle.Paragraph).setRequired(false)
        .setValue(Object.entries(cfg.roleRewards || {}).map(([l, r]) => `${l}=${r}`).join(', ').slice(0, 4000))
    ));
    return interaction.showModal(modal);
  }

  // Honeypot buttons
  if (id === 'honeypot:toggle') {
    const cur = db.getConfig(interaction.guildId).honeypot;
    db.saveConfig(interaction.guildId, { honeypot: { enabled: !cur.enabled } });
    return interaction.update({ embeds: [sys.infoEmbed(interaction.guildId, `Honeypot ${!cur.enabled ? 'enabled' : 'disabled'}.`)], components: [] });
  }

  // Autoresponder buttons
  if (id === 'ar:toggle' || id === 'arr:toggle') {
    const key = id === 'ar:toggle' ? 'autoresponder' : 'autoreactor';
    const cur = db.getConfig(interaction.guildId)[key];
    db.saveConfig(interaction.guildId, { [key]: { enabled: !cur.enabled } });
    return interaction.update({ embeds: [sys.infoEmbed(interaction.guildId, `${key} ${!cur.enabled ? 'enabled' : 'disabled'}.`)], components: [] });
  }
  if (id === 'ar:add') {
    const modal = new ModalBuilder().setCustomId('ar:add:modal').setTitle('Add Auto Responder');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('match').setLabel('Trigger phrase').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mode').setLabel('exact or contains').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20).setValue('contains')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('response').setLabel('Response text').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500))
    );
    return interaction.showModal(modal);
  }
  if (id === 'arr:add') {
    const modal = new ModalBuilder().setCustomId('arr:add:modal').setTitle('Add Auto Reactor');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('match').setLabel('Trigger phrase').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mode').setLabel('exact or contains').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20).setValue('contains')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emojis').setLabel('Emojis (space-separated, max 5)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200))
    );
    return interaction.showModal(modal);
  }

  // Role panel buttons
  if (id.startsWith('rolepanel:')) {
    const [, action, panelId] = id.split(':');
    const panel = db.findPanel(interaction.guildId, 'button', panelId);
    if (!panel) return interaction.reply({ embeds: [sys.errEmbed(interaction.guildId, 'Panel not found.')], ephemeral: true });
    if (action === 'post') {
      try {
        const msg = await sys.postButtonPanel(interaction.guild, panel);
        return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, `Panel posted in <#${msg.channel.id}>.`)], ephemeral: true });
      } catch (e) { return interaction.reply({ embeds: [sys.errEmbed(interaction.guildId, String(e.message))], ephemeral: true }); }
    }
    if (action === 'delete') {
      db.removePanel(interaction.guildId, 'button', panelId);
      return interaction.update({ embeds: [sys.okEmbed(interaction.guildId, 'Panel deleted.')], components: [] });
    }
    if (action === 'edit') {
      const modal = new ModalBuilder().setCustomId(`rolepanel:edit:modal:${panelId}`).setTitle('Edit Panel');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200).setValue(panel.title || '')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500).setValue(panel.description || ''))
      );
      return interaction.showModal(modal);
    }
    return;
  }

  // Role button click
  if (id.startsWith('rolebtn:')) {
    const [, panelId, roleId] = id.split(':');
    const panel = db.findPanel(interaction.guildId, 'button', panelId);
    if (panel?.enabled === false) return interaction.reply({ embeds: [sys.errEmbed(interaction.guildId, 'Panel disabled.')], ephemeral: true });
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) return interaction.reply({ embeds: [sys.errEmbed(interaction.guildId, 'Role no longer exists.')], ephemeral: true });
    const me = interaction.guild.members.me;
    if (role.position >= me.roles.highest.position) return interaction.reply({ embeds: [sys.errEmbed(interaction.guildId, 'My role is below this one.')], ephemeral: true });
    try {
      const has = interaction.member.roles.cache.has(roleId);
      if (has) await interaction.member.roles.remove(role);
      else await interaction.member.roles.add(role);
      return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, has ? `Removed ${role}.` : `Added ${role}.`)], ephemeral: true });
    } catch (e) { return interaction.reply({ embeds: [sys.errEmbed(interaction.guildId, 'Role change failed.')], ephemeral: true }); }
  }

  // Giveaway entry
  if (id.startsWith('giveaway:enter:')) {
    const gid = parseInt(id.split(':')[2], 10);
    const g = db.getGiveaway(interaction.guildId, gid);
    if (!g || g.status !== 'active' || g.endsAt <= Date.now()) return interaction.reply({ content: 'This giveaway has ended.', ephemeral: true });
    let participants = [];
    try { participants = JSON.parse(g.participants || '[]'); } catch {}
    const has = participants.includes(interaction.user.id);
    participants = has ? participants.filter(x => x !== interaction.user.id) : [...participants, interaction.user.id];
    db.updateGiveaway(interaction.guildId, g.id, { participants: JSON.stringify(participants) });
    return interaction.reply({ content: has ? 'You left the giveaway.' : `You are entered! ${participants.length} participant(s).`, ephemeral: true });
  }

  // Wizard modules select handled by handleSelect.

  // Templategen steps
  if (id.startsWith('tgen:type:')) {
    const type = id.split(':')[2];
    const sid = setSession(`tgen:${interaction.user.id}`, { type, step: 'naming' });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tgen:naming:${sid}:emoji_divider`).setLabel('Emoji + Divider').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`tgen:naming:${sid}:tree`).setLabel('Tree Structure').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`tgen:naming:${sid}:decorative`).setLabel('Decorative').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`tgen:naming:${sid}:emoji_decor`).setLabel('Emoji + Decor').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`tgen:naming:${sid}:minimal`).setLabel('Minimal').setStyle(ButtonStyle.Secondary)
    );
    return interaction.update({ embeds: [sys.infoEmbed(interaction.guildId, `Type: **${type}**. Step 2: Choose naming style.`)], components: [row] });
  }
  if (id.startsWith('tgen:naming:')) {
    const [, , sid, style] = id.split(':');
    const s = getSession(sid);
    if (!s) return interaction.reply({ content: 'Session expired.', ephemeral: true });
    s.naming = style;
    return interaction.update({
      embeds: [sys.infoEmbed(interaction.guildId, `Ready to generate: **${s.type}**, style **${style}**.`)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`tgen:go:${sid}`).setLabel('Generate').setStyle(ButtonStyle.Success).setEmoji('🧩')
      )]
    });
  }
  if (id.startsWith('tgen:go:')) {
    const sid = id.split(':')[2];
    const s = getSession(sid);
    if (!s) return interaction.reply({ content: 'Session expired.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const tpl = await sys.generateTemplate({ serverType: s.type, namingStyle: s.naming, emojiMode: 'individual', guildName: interaction.guild.name });
      s.template = tpl;
      const preview = tpl.categories.map(c => `**${c.emoji || ''} ${c.name}**\n${c.channels.map(ch => `  ${ch.type === 'voice' ? '🔊' : '#'} ${ch.emoji || ''} ${ch.name}`).join('\n')}`).join('\n\n');
      const e = sys.baseEmbed(interaction.guildId, '🧩 Preview').setDescription(preview.slice(0, 4000) || 'empty');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`tgen:apply:${sid}`).setLabel('Apply').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`tgen:cancel:${sid}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      );
      return interaction.editReply({ embeds: [e], components: [row] });
    } catch (err) {
      await logError(err, 'templategen');
      return interaction.editReply({ embeds: [sys.errEmbed(interaction.guildId, `Generation failed: ${err.message}`)] });
    }
  }
  if (id.startsWith('tgen:apply:')) {
    const sid = id.split(':')[2];
    const s = getSession(sid);
    if (!s?.template) return interaction.reply({ content: 'Session expired.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const results = await applyTemplateToGuild(interaction.guild, s.template, s.naming);
    const e = sys.embed(interaction.guildId, 'success', {
      title: '✅ Template Applied',
      fields: [
        { name: 'Categories', value: String(results.categories), inline: true },
        { name: 'Channels', value: String(results.channels), inline: true },
        { name: 'Roles', value: String(results.roles), inline: true },
        { name: 'Errors', value: results.errors.length ? results.errors.slice(0, 10).join('\n').slice(0, 1000) : 'None' }
      ]
    });
    sessions.delete(sid);
    return interaction.editReply({ embeds: [e], components: [] });
  }
  if (id.startsWith('tgen:cancel:')) {
    sessions.delete(id.split(':')[2]);
    return interaction.update({ embeds: [sys.infoEmbed(interaction.guildId, 'Cancelled.')], components: [] });
  }
}

// Apply a generated template to the guild — bounded concurrency, rate-limit aware.
async function applyTemplateToGuild(guild, template, namingStyle) {
  const results = { categories: 0, channels: 0, roles: 0, errors: [] };
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    results.errors.push('Bot lacks Manage Channels.');
    return results;
  }
  const style = namingStyle === 'ai' ? 'emoji_divider' : namingStyle;

  for (const r of template.roles || []) {
    try {
      if (!guild.roles.cache.find(x => x.name === r.name)) {
        await guild.roles.create({ name: r.name, color: r.color || 0, hoist: !!r.hoist, reason: 'AunXz template' });
        results.roles++;
      }
    } catch (e) { results.errors.push(`role ${r.name}: ${e.message}`); }
  }

  for (const cat of template.categories || []) {
    try {
      let category = guild.channels.cache.find(c => c.type === 4 && c.name === cat.name);
      if (!category) {
        category = await guild.channels.create({ name: cat.name.slice(0, 100), type: 4 });
        results.categories++;
      }
      const total = cat.channels.length;
      let i = 0;
      for (const ch of cat.channels) {
        i++;
        const name = sys.applyNaming(style, ch.emoji || '💬', ch.name, { first: i === 1, last: i === total });
        try {
          await guild.channels.create({
            name: name.slice(0, 100),
            type: ch.type === 'voice' ? 2 : 0,
            parent: category.id,
            topic: ch.type === 'voice' ? undefined : (ch.topic || '').slice(0, 1024)
          });
          results.channels++;
        } catch (e) { results.errors.push(`${name}: ${e.message}`); }
      }
    } catch (e) { results.errors.push(`category ${cat.name}: ${e.message}`); }
  }
  return results;
}

// =============================================================================
// SELECT MENU HANDLERS
// =============================================================================
async function handleSelect(interaction) {
  const id = interaction.customId;

  if (id === 'help_select') {
    const cat = cmd.HELP_CATEGORIES[interaction.values[0]];
    if (!cat) return;
    return interaction.update({ embeds: [sys.baseEmbed(interaction.guildId, `${cat.emoji} ${cat.name}`).setDescription(cat.desc)], components: [cmd.helpSelectRow()] });
  }

  if (id === 'setup_module') {
    const key = interaction.values[0];
    const mod = cmd.MODULES.find(m => m.key === key);
    if (!mod) return;
    if (mod.cfgKey) {
      const cfg = db.getConfig(interaction.guildId);
      const val = mod.cfgKey.split('.').reduce((a, k) => a?.[k], cfg);
      const status = typeof val === 'boolean' ? val : val?.enabled;
      return interaction.update({
        embeds: [sys.baseEmbed(interaction.guildId, `⚙️ ${mod.label}`).setDescription(`**Status:** ${status ? '🟢 Enabled' : '⚪ Disabled'}\n\n${mod.desc}`)],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`setup:toggle:${mod.key}`).setLabel(status ? 'Disable' : 'Enable').setStyle(status ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`setup:back`).setLabel('Back').setStyle(ButtonStyle.Secondary)
          )
        ]
      });
    }
    return interaction.update({ embeds: [cmd.setupPanelEmbed(interaction.guildId)], components: cmd.setupPanelRows() });
  }

  if (id === 'wizard:modules') {
    for (const m of interaction.values) {
      const mod = cmd.MODULES.find(x => x.key === m);
      if (mod?.cfgKey) db.saveConfig(interaction.guildId, { [mod.cfgKey]: { enabled: true } });
    }
    sys.refreshAutomod(interaction.guildId);
    return interaction.update({
      embeds: [sys.okEmbed(interaction.guildId, `Enabled: ${interaction.values.join(', ')}\n\nUse \`/setup panel\` to configure each module's channels and roles.`)],
      components: []
    });
  }

  if (id === 'logs:cat') {
    const key = interaction.values[0];
    // remember selection on the message via session keyed by user
    setSession(`logs:${interaction.user.id}`, { key });
    return interaction.reply({ content: `Selected **${key}**. Now pick a channel in the second menu.`, ephemeral: true });
  }

  if (id === 'honeypot:action') {
    db.saveConfig(interaction.guildId, { honeypot: { action: interaction.values[0] } });
    return interaction.update({ embeds: [sys.infoEmbed(interaction.guildId, `Action set to **${interaction.values[0]}**.`)], components: [] });
  }

  if (id === 'ar:remove' || id === 'arr:remove') {
    const key = id === 'ar:remove' ? 'autoresponder' : 'autoreactor';
    const cur = db.getConfig(interaction.guildId)[key];
    const triggers = (cur.triggers || []).filter(t => t.id !== interaction.values[0]);
    db.saveConfig(interaction.guildId, { [key]: { triggers } });
    return interaction.update({ embeds: [sys.infoEmbed(interaction.guildId, `Trigger removed. ${triggers.length} remaining.`)], components: [] });
  }
}

async function handleChannelSelect(interaction) {
  const id = interaction.customId;
  const channelId = interaction.values[0];

  if (id.startsWith('welcome:channel')) { db.saveConfig(interaction.guildId, { welcome: { channel: channelId } }); return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, `Welcome channel set to <#${channelId}>.`)], ephemeral: true }); }
  if (id.startsWith('leave:channel')) { db.saveConfig(interaction.guildId, { leave: { channel: channelId } }); return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, `Leave channel set to <#${channelId}>.`)], ephemeral: true }); }
  if (id.startsWith('greetmsg:channel')) { db.saveConfig(interaction.guildId, { greetmessage: { channelId } }); return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, `Welcome channel set.`)], ephemeral: true }); }
  if (id === 'ticket:category') { db.saveConfig(interaction.guildId, { ticket: { categoryId: channelId } }); return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, `Ticket category set.`)], ephemeral: true }); }
  if (id === 'ticket:log') { db.saveConfig(interaction.guildId, { ticket: { logChannelId: channelId } }); return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, `Ticket log channel set.`)], ephemeral: true }); }
  if (id.startsWith('leveling:channel')) { db.saveConfig(interaction.guildId, { leveling: { channel: channelId } }); return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, `Level-up channel set.`)], ephemeral: true }); }
  if (id.startsWith('honeypot:channel')) { db.saveConfig(interaction.guildId, { honeypot: { channelId } }); return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, `Trap channel set.`)], ephemeral: true }); }
  if (id.startsWith('rolepanel:channel:')) {
    const panelId = id.split(':')[2];
    const panel = db.findPanel(interaction.guildId, 'button', panelId);
    if (!panel) return;
    db.upsertPanel(interaction.guildId, 'button', { ...panel, channelId });
    return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, `Panel channel set.`)], ephemeral: true });
  }
  if (id === 'logs:channel') {
    const s = getSession(`logs:${interaction.user.id}`);
    if (!s?.key) return interaction.reply({ content: 'Pick a category first.', ephemeral: true });
    db.saveConfig(interaction.guildId, { logs: { [s.key]: channelId } });
    sessions.delete(`logs:${interaction.user.id}`);
    return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, `${s.key} logs → <#${channelId}>.`)], ephemeral: true });
  }
}

async function handleRoleSelect(interaction) {
  const id = interaction.customId;
  const roleId = interaction.values[0];
  if (id === 'ticket:support') {
    db.saveConfig(interaction.guildId, { ticket: { supportRoleId: roleId } });
    return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, `Support role set.`)], ephemeral: true });
  }
  if (id.startsWith('rolepanel:addrole:')) {
    const panelId = id.split(':')[2];
    const panel = db.findPanel(interaction.guildId, 'button', panelId);
    if (!panel) return interaction.reply({ embeds: [sys.errEmbed(interaction.guildId, 'Panel not found.')], ephemeral: true });
    const role = interaction.guild.roles.cache.get(roleId);
    const existing = (panel.buttons || []).filter(b => b.roleId !== roleId);
    existing.push({ roleId, label: role?.name || 'Role' });
    db.upsertPanel(interaction.guildId, 'button', { ...panel, buttons: existing });
    return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, `Added ${role}.`)], ephemeral: true });
  }
}

// =============================================================================
// MODAL HANDLERS
// =============================================================================
async function handleModal(interaction) {
  const id = interaction.customId;

  if (id === 'setup:restore') {
    try {
      const payload = JSON.parse(interaction.fields.getTextInputValue('payload'));
      db.importGuild(interaction.guildId, payload);
      return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, 'Configuration restored.')], ephemeral: true });
    } catch (e) { return interaction.reply({ embeds: [sys.errEmbed(interaction.guildId, `Restore failed: ${e.message}`)], ephemeral: true }); }
  }
  if (id === 'automod:words:modal') {
    const words = interaction.fields.getTextInputValue('words').split(',').map(x => x.trim()).filter(Boolean).slice(0, 500);
    db.saveConfig(interaction.guildId, { automod: { badWords: words } });
    sys.refreshAutomod(interaction.guildId);
    return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, `Saved ${words.length} word(s).`)], ephemeral: true });
  }
  if (id === 'badword:words:modal') {
    const words = interaction.fields.getTextInputValue('words').split(',').map(x => x.trim()).filter(Boolean).slice(0, 500);
    db.saveConfig(interaction.guildId, { antibadword: { customWords: words } });
    sys.refreshAutomod(interaction.guildId);
    return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, `Saved ${words.length} word(s).`)], ephemeral: true });
  }
  if (id === 'greetmsg:edit:modal') {
    const title = interaction.fields.getTextInputValue('title') || '👋 Welcome!';
    const message = interaction.fields.getTextInputValue('message');
    db.saveConfig(interaction.guildId, { greetmessage: { title, message } });
    return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, 'Message saved.')], ephemeral: true });
  }
  if (id === 'welcome:edit:modal' || id === 'leave:edit:modal') {
    const key = id.split(':')[0];
    const message = interaction.fields.getTextInputValue('message');
    db.saveConfig(interaction.guildId, { [key]: { message } });
    return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, 'Message saved.')], ephemeral: true });
  }
  if (id === 'leveling:rewards:modal') {
    const raw = interaction.fields.getTextInputValue('rewards');
    const map = {};
    for (const pair of raw.split(',')) {
      const [lvl, rid] = pair.split('=').map(s => s.trim());
      if (/^\d+$/.test(lvl) && /^\d{15,25}$/.test(rid)) map[lvl] = rid;
    }
    db.saveConfig(interaction.guildId, { leveling: { roleRewards: map } });
    return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, `Saved ${Object.keys(map).length} reward(s).`)], ephemeral: true });
  }
  if (id === 'ar:add:modal') {
    const match = interaction.fields.getTextInputValue('match').trim();
    const mode = /^exact$/i.test(interaction.fields.getTextInputValue('mode').trim()) ? 'exact' : 'contains';
    const response = interaction.fields.getTextInputValue('response').trim();
    const cfg = db.getConfig(interaction.guildId).autoresponder;
    const triggers = [...(cfg.triggers || []), { id: Math.random().toString(36).slice(2, 10), match, mode, response }];
    db.saveConfig(interaction.guildId, { autoresponder: { triggers } });
    return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, `Trigger added. ${triggers.length} total.`)], ephemeral: true });
  }
  if (id === 'arr:add:modal') {
    const match = interaction.fields.getTextInputValue('match').trim();
    const mode = /^exact$/i.test(interaction.fields.getTextInputValue('mode').trim()) ? 'exact' : 'contains';
    const emojis = interaction.fields.getTextInputValue('emojis').trim().split(/\s+/).filter(Boolean).slice(0, 5);
    const cfg = db.getConfig(interaction.guildId).autoreactor;
    const triggers = [...(cfg.triggers || []), { id: Math.random().toString(36).slice(2, 10), match, mode, emojis }];
    db.saveConfig(interaction.guildId, { autoreactor: { triggers } });
    return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, `Trigger added. ${triggers.length} total.`)], ephemeral: true });
  }
  if (id.startsWith('rolepanel:edit:modal:')) {
    const panelId = id.split(':')[3];
    const panel = db.findPanel(interaction.guildId, 'button', panelId);
    if (!panel) return interaction.reply({ embeds: [sys.errEmbed(interaction.guildId, 'Panel not found.')], ephemeral: true });
    const title = interaction.fields.getTextInputValue('title');
    const description = interaction.fields.getTextInputValue('description');
    db.upsertPanel(interaction.guildId, 'button', { ...panel, title, description });
    return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, 'Panel saved.')], ephemeral: true });
  }
  if (id === 'eb:build') {
    const title = interaction.fields.getTextInputValue('title');
    const description = interaction.fields.getTextInputValue('description');
    const colorRaw = interaction.fields.getTextInputValue('color');
    const channelRaw = interaction.fields.getTextInputValue('channel');
    let color; if (colorRaw) { color = cmd.parseHexColor(colorRaw); if (color === null) return interaction.reply({ content: 'Invalid color.', ephemeral: true }); }
    const channelId = channelRaw.replace(/[<#>]/g, '');
    const ch = interaction.guild.channels.cache.get(channelId);
    if (!ch?.isTextBased()) return interaction.reply({ content: 'Channel not found.', ephemeral: true });
    const e = new EmbedBuilder();
    if (title) e.setTitle(title);
    e.setDescription(description);
    if (color !== undefined) e.setColor(color);
    e.setTimestamp();
    await ch.send({ embeds: [e] }).catch(() => {});
    return interaction.reply({ embeds: [sys.okEmbed(interaction.guildId, `Embed posted in <#${ch.id}>.`)], ephemeral: true });
  }
}

// =============================================================================
// USER SELECT MENU (ticket add/remove)
// =============================================================================
client.on('interactionCreate', async interaction => {
  if (!interaction.isUserSelectMenu?.()) return;
  const id = interaction.customId;
  try {
    if (id === 'ticket:add:select') {
      const userId = interaction.values[0];
      await interaction.channel.permissionOverwrites.edit(userId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
      return interaction.update({ embeds: [sys.okEmbed(interaction.guildId, `Added <@${userId}>.`)], components: [] });
    }
    if (id === 'ticket:remove:select') {
      const userId = interaction.values[0];
      await interaction.channel.permissionOverwrites.delete(userId).catch(() => {});
      return interaction.update({ embeds: [sys.okEmbed(interaction.guildId, `Removed <@${userId}>.`)], components: [] });
    }
  } catch (e) { await logError(e, 'userSelect'); }
});

// =============================================================================
// MESSAGE EVENTS
// =============================================================================
client.on('messageCreate', async message => {
  try {
    if (!message.guild || message.author.bot) return;
    const cfg = db.getConfig(message.guild.id);

    // Client mention ping
    if (message.mentions.users.has(client.user.id) && !message.mentions.everyone && message.content.trim().startsWith('<@')) {
      const prefix = cfg.prefix || '!';
      return message.reply({
        embeds: [sys.baseEmbed(message.guild.id, `🤖 ${client.user.username}`).setDescription(
          `Welcome to **${message.guild.name}**!\n\nStart with **${prefix}help** or **/help**.\n**Prefix:** \`${prefix}\`\n**Ping:** \`${client.ws.ping}ms\``
        )]
      }).catch(() => {});
    }

    // Global blacklist silences prefix commands but not automod
    if (db.getGlobalBlacklist().includes(message.guild.ownerId)) {
      return;
    }

    // Automod — the SINGLE authoritative path for antilink, bad words, caps, invites, spam.
    const blocked = await sys.runAutomod(message).catch(e => { console.error('[automod]', e?.message); return false; });
    if (blocked) return;

    // Leveling
    await sys.handleLevelingMessage(message).catch(() => {});

    // Autoresponder / autoreactor
    if (cfg.autoresponder?.enabled && cfg.autoresponder.triggers?.length) {
      const content = cfg.autoresponder.ignoreCase ? message.content.toLowerCase() : message.content;
      for (const t of cfg.autoresponder.triggers) {
        const match = cfg.autoresponder.ignoreCase ? String(t.match).toLowerCase() : String(t.match);
        if (t.mode === 'exact' ? content.trim() === match.trim() : content.includes(match)) {
          const response = sys.applyTemplate(t.response, { user: `${message.author}`, username: message.author.username, server: message.guild.name });
          await message.channel.send({ content: response.slice(0, 2000), allowedMentions: { repliedUser: false } }).catch(() => {});
          break;
        }
      }
    }
    if (cfg.autoreactor?.enabled && cfg.autoreactor.triggers?.length) {
      const content = cfg.autoreactor.ignoreCase ? message.content.toLowerCase() : message.content;
      for (const t of cfg.autoreactor.triggers) {
        const match = cfg.autoreactor.ignoreCase ? String(t.match).toLowerCase() : String(t.match);
        if (t.mode === 'exact' ? content.trim() === match.trim() : content.includes(match)) {
          for (const em of (t.emojis || []).slice(0, 5)) await message.react(em).catch(() => {});
          break;
        }
      }
    }

    // Honeypot — FIX: was defined but never wired in the old index.js.
    const hp = cfg.honeypot;
    if (hp.enabled && hp.channelId === message.channel.id && message.author.id !== message.guild.ownerId) {
      const whitelisted = (hp.whitelistRoleIds || []).some(r => message.member?.roles.cache.has(r));
      if (!whitelisted) {
        await message.delete().catch(() => {});
        await sys.logEvent(message.guild, 'mod', {
          title: '🍯 Honeypot Triggered',
          description: `**User:** ${message.author}\n**Action:** ${hp.action}`
        });
        const member = await message.guild.members.fetch(message.author.id).catch(() => null);
        if (member) {
          if (hp.action === 'kick') await member.kick('Honeypot').catch(() => {});
          else if (hp.action === 'ban') await member.ban({ reason: 'Honeypot' }).catch(() => {});
          else if (hp.action === 'timeout') await member.timeout(10 * 60 * 1000, 'Honeypot').catch(() => {});
        }
      }
    }

    // Sticky message repost
    const sticky = db.getSticky(message.channel.id);
    if (sticky?.enabled) scheduleStickyRepost(client, message.channel.id);
  } catch (e) {
    await logError(e, 'messageCreate', { guildId: message.guildId, userId: message.author?.id });
  }
});

// Sticky repost engine — debounced per channel
const stickyQueues = new Map();
function scheduleStickyRepost(client, channelId) {
  const existing = stickyQueues.get(channelId);
  if (existing?.running) { existing.dirty = true; return; }
  if (existing) clearTimeout(existing.timer);
  const q = { running: false, dirty: false, timer: null };
  stickyQueues.set(channelId, q);
  q.timer = setTimeout(async () => {
    q.running = true;
    try {
      do {
        q.dirty = false;
        const row = db.getSticky(channelId);
        if (!row?.enabled) break;
        const channel = client.channels.cache.get(channelId);
        if (!channel?.isTextBased()) break;
        if (row.lastMessageId) await channel.messages.delete(row.lastMessageId).catch(() => {});
        const e = new EmbedBuilder();
        if (row.data.title) e.setTitle(row.data.title);
        if (row.data.description) e.setDescription(row.data.description);
        if (typeof row.data.color === 'number') e.setColor(row.data.color);
        e.setTimestamp();
        const sent = await channel.send({ embeds: [e] }).catch(() => null);
        if (sent) db.setStickyMessageId(channelId, sent.id);
      } while (q.dirty);
    } catch (e) { console.error('[sticky]', e?.message); }
    q.running = false;
    stickyQueues.delete(channelId);
  }, 1500);
  q.timer.unref?.();
}

// =============================================================================
// MESSAGE DELETE / UPDATE — snipe + logging
// =============================================================================
client.on('messageDelete', async message => {
  try {
    if (!message.guild || message.author?.bot) return;
    cmd.recordSnipe(message.guild.id, message.channel.id, {
      authorId: message.author?.id,
      authorTag: message.author?.tag,
      action: 'delete',
      content: message.content || '',
      attachments: [...(message.attachments?.values?.() || [])].map(a => ({ name: a.name, url: a.url }))
    });
    await sys.logEvent(message.guild, 'message', {
      title: '🗑️ Message Deleted',
      description: `**Author:** ${message.author}\n**Channel:** <#${message.channel.id}>\n**Content:** ${(message.content || '*no content*').slice(0, 1800)}`
    });
  } catch (e) { await logError(e, 'messageDelete', { guildId: message.guild?.id }); }
});

client.on('messageUpdate', async (oldMsg, newMsg) => {
  try {
    if (!newMsg.guild || newMsg.author?.bot) return;
    if (oldMsg.content === newMsg.content) return;
    cmd.recordSnipe(newMsg.guild.id, newMsg.channel.id, {
      authorId: newMsg.author.id,
      authorTag: newMsg.author.tag,
      action: 'edit',
      content: oldMsg.content || '',
      newContent: newMsg.content || '',
      attachments: []
    });
    await sys.logEvent(newMsg.guild, 'message', {
      title: '✏️ Message Edited',
      description: `**Author:** ${newMsg.author}\n**Channel:** <#${newMsg.channel.id}>\n**Before:** ${(oldMsg.content || '*none*').slice(0, 900)}\n**After:** ${(newMsg.content || '*none*').slice(0, 900)}`
    });
  } catch (e) { await logError(e, 'messageUpdate', { guildId: newMsg.guild?.id }); }
});

// =============================================================================
// MEMBER EVENTS
// =============================================================================
client.on('guildMemberAdd', async member => {
  try {
    // Run security handlers in parallel — previously sequential, added ~1.5s to every join.
    await Promise.allSettled([
      sys.handleAntiBotJoin(member),
      sys.handleAntiAltJoin(member),
      sys.handleAntiraidJoin(member)
    ]);

    const cfg = db.getConfig(member.guild.id);

    // Welcome / greet message
    if (cfg.greetmessage.enabled && cfg.greetmessage.channelId) {
      const ch = member.guild.channels.cache.get(cfg.greetmessage.channelId);
      if (ch?.isTextBased()) {
        const text = sys.applyTemplate(cfg.greetmessage.message, {
          user: `<@${member.id}>`, username: member.user.username,
          server: member.guild.name, count: member.guild.memberCount
        });
        const e = new EmbedBuilder().setColor(0x8b5cf6).setDescription(text).setTimestamp();
        if (cfg.greetmessage.title) e.setTitle(cfg.greetmessage.title);
        if (cfg.greetmessage.showAvatar !== false) e.setThumbnail(member.user.displayAvatarURL({ size: 256 }));
        if (cfg.greetmessage.image) e.setImage(cfg.greetmessage.image);
        await ch.send({ embeds: [e], content: cfg.greetmessage.ping !== false ? `<@${member.id}>` : undefined, allowedMentions: cfg.greetmessage.ping !== false ? { users: [member.id] } : { parse: [] } }).catch(() => {});
      }
    }
    if (cfg.welcome.enabled && cfg.welcome.channel) {
      const ch = member.guild.channels.cache.get(cfg.welcome.channel);
      if (ch?.isTextBased()) {
        const text = sys.applyTemplate(cfg.welcome.message, { user: `<@${member.id}>`, server: member.guild.name, count: member.guild.memberCount });
        await ch.send({ embeds: [sys.okEmbed(member.guild.id, text)], allowedMentions: { parse: [] } }).catch(() => {});
      }
    }
    // Autorole
    if (cfg.autorole.enabled && cfg.autorole.roleId) {
      const target = cfg.autorole.target || 'everyone';
      if ((target === 'everyone') || (target === 'bots' && member.user.bot) || (target === 'humans' && !member.user.bot)) {
        const role = member.guild.roles.cache.get(cfg.autorole.roleId);
        const me = member.guild.members.me;
        if (role && me && role.position < me.roles.highest.position) {
          await member.roles.add(role).catch(() => {});
        }
      }
    }
    // Sticky roles restore
    const sticky = db.getStickyRoles(member.guild.id, member.id);
    if (sticky.length) {
      const me = member.guild.members.me;
      const valid = sticky.filter(r => { const role = member.guild.roles.cache.get(r); return role && role.position < me.roles.highest.position; });
      if (valid.length) await member.roles.add(valid).catch(() => {});
    }

    await sys.logEvent(member.guild, 'join', {
      title: '📥 Member Joined',
      description: `${member.user.tag} (<@${member.id}>)`
    });
  } catch (e) { await logError(e, 'guildMemberAdd', { guildId: member.guild?.id }); }
});

client.on('guildMemberRemove', async member => {
  try {
    const cfg = db.getConfig(member.guild.id);
    if (cfg.leave.enabled && cfg.leave.channel) {
      const ch = member.guild.channels.cache.get(cfg.leave.channel);
      if (ch?.isTextBased()) {
        const text = sys.applyTemplate(cfg.leave.message, { user: member.user.tag, server: member.guild.name });
        await ch.send({ embeds: [sys.warnEmbed(member.guild.id, text)], allowedMentions: { parse: [] } }).catch(() => {});
      }
    }
    if (member.roles?.cache?.size) {
      db.setStickyRoles(member.guild.id, member.id, member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.id));
    }
    await sys.logEvent(member.guild, 'join', { title: '📤 Member Left', description: `${member.user.tag}` });
  } catch (e) { await logError(e, 'guildMemberRemove', { guildId: member.guild?.id }); }
});

// =============================================================================
// ANTI-NUKE AUDIT EVENTS
// =============================================================================
client.on('channelDelete', async ch => {
  if (!ch.guild) return;
  const exec = await sys.findAuditExecutor(ch.guild, AuditLogEvent.ChannelDelete, ch.id);
  if (exec) await sys.antinukeStrike(ch.guild, exec.id, 'channelDelete').catch(() => {});
  await sys.logEvent(ch.guild, 'server', { title: 'Channel Deleted', description: `#${ch.name}` });
});
client.on('channelCreate', async ch => {
  if (!ch.guild) return;
  const exec = await sys.findAuditExecutor(ch.guild, AuditLogEvent.ChannelCreate, ch.id);
  if (exec) await sys.antinukeStrike(ch.guild, exec.id, 'channelCreate').catch(() => {});
  await sys.logEvent(ch.guild, 'server', { title: 'Channel Created', description: `${ch}` });
});
client.on('roleDelete', async role => {
  const exec = await sys.findAuditExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
  if (exec) await sys.antinukeStrike(role.guild, exec.id, 'roleDelete').catch(() => {});
  await sys.logEvent(role.guild, 'server', { title: 'Role Deleted', description: `${role.name}` });
});
client.on('roleCreate', async role => {
  const exec = await sys.findAuditExecutor(role.guild, AuditLogEvent.RoleCreate, role.id);
  if (exec) await sys.antinukeStrike(role.guild, exec.id, 'roleCreate').catch(() => {});
});
client.on('guildBanAdd', async ban => {
  const exec = await sys.findAuditExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  if (exec) await sys.antinukeStrike(ban.guild, exec.id, 'ban').catch(() => {});
  await sys.logEvent(ban.guild, 'mod', { title: 'Member Banned', description: `<@${ban.user.id}>` });
});
client.on('webhookUpdate', async channel => {
  await sys.handleAntiWebhookCreate(channel).catch(() => {});
});

// =============================================================================
// VOICE STATE
// =============================================================================
client.on('voiceStateUpdate', async (oldState, newState) => {
  await sys.handleVoicemasterJoin(oldState, newState).catch(e => console.error('[voice]', e?.message));
});

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================
async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down.`);
  try { await client.destroy(); } catch {}
  try { db.db.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// =============================================================================
// LOGIN
// =============================================================================
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Login failed:', err.message);
  process.exit(1);
});