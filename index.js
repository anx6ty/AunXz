// AunXz/index.js — boot, event wiring, interaction router.
'use strict';
require('dotenv').config();
console.log('[AunXz] Booting…');

const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
  PermissionFlagsBits, AuditLogEvent
} = require('discord.js');
const db = require('./database');
const sys = require('./systems');
const ui = require('./ui');
const cmd = require('./commands');

// ================= ENV =================
const REQUIRED = ['DISCORD_TOKEN', 'CLIENT_ID'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) { console.error(`❌ Missing env vars: ${missing.join(', ')}`); process.exit(1); }
if (!process.env.GROQ_API_KEY) console.warn('⚠️  GROQ_API_KEY not set — /ask and /templategen disabled.');

// ================= CLIENT =================
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

// ================= SESSIONS =================
const sessions = new Map();
const SESSION_TTL_MS = 5 * 60 * 1000;
const setSession = (id, data) => { sessions.set(id, { ...data, expiresAt: Date.now() + SESSION_TTL_MS }); return id; };
const getSession = id => sessions.get(id);
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.expiresAt && v.expiresAt < now) sessions.delete(k);
}, 60000).unref?.();

// ================= ERROR HANDLING =================
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e));
client.on('error', e => console.error('[client error]', e?.message || e));

async function logError(err, ctx = '', meta = {}) {
  console.error(`[${ctx}]`, err?.message || err);
  try { db.recordError({ source: ctx, command: meta.command, guildId: meta.guildId, userId: meta.userId, message: err?.message || String(err), stack: err?.stack || '' }); } catch {}
}

// ================= READY =================
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`   Database: ${db.DB_PATH}`);
  client.user.setActivity('/help', { type: 3 });

  try {
    const body = uniqueByName(cmd.commands.map(c => c.data.toJSON()));
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body });
    console.log(`✅ Registered ${body.length} commands.`);
  } catch (e) { await logError(e, 'Command registration'); }

  for (const g of client.guilds.cache.values()) sys.refreshAutomod(g.id);

  // Giveaway scheduler
  setInterval(async () => {
    try {
      const now = Date.now();
      for (const g of db.listActiveGiveaways()) {
        if (g.endsAt <= now) {
          const guild = client.guilds.cache.get(g.guildId);
          if (!guild) continue;
          let participants = [];
          try { participants = JSON.parse(g.participants || '[]'); } catch {}
          const valid = participants.filter(x => guild.members.cache.has(x));
          const pool = [...valid], winners = [];
          while (winners.length < g.winners && pool.length) winners.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
          db.updateGiveaway(g.guildId, g.id, { status: 'ended', winnerIds: JSON.stringify(winners) });
          const ch = g.channelId ? guild.channels.cache.get(g.channelId) : null;
          if (ch?.isTextBased()) ch.send({ content: winners.length ? `🎉 Giveaway ended! Winners for **${g.prize}**: ${winners.map(w => `<@${w}>`).join(', ')}` : `No valid entries for **${g.prize}**.` }).catch(() => {});
        }
      }
    } catch (e) { console.error('giveaway tick', e?.message); }
  }, 15000).unref?.();

  // Join tracker pruning
  setInterval(() => {
    for (const g of client.guilds.cache.values()) db.pruneJoins(g.id, 3600);
  }, 300000).unref?.();
});

function uniqueByName(list) {
  const seen = new Set();
  return list.filter(b => { if (seen.has(b.name)) return false; seen.add(b.name); return true; });
}

// ================= INTERACTION ROUTER =================
client.on('interactionCreate', async interaction => {
  try {
    // Global blacklist + maintenance
    if (interaction.user && db.getGlobalBlacklist().includes(interaction.user.id)) {
      return interaction.reply({ content: 'You are blocked from using AunXz.', ephemeral: true }).catch(() => {});
    }
    if (db.getOwnerConfig().maintenance && !sys.isOwner(interaction.user.id)) {
      return interaction.reply({ content: 'AunXz is in maintenance mode.', ephemeral: true }).catch(() => {});
    }

    if (interaction.isAutocomplete()) return;

    if (interaction.isChatInputCommand()) {
      const c = cmd.commands.find(x => x.data.name === interaction.commandName);
      if (!c) return;
      const disabled = db.getToggle(interaction.commandName);
      if (disabled && !sys.isOwner(interaction.user.id)) {
        return interaction.reply({ embeds: [ui.warnEmbed('Disabled', `**/${interaction.commandName}** is temporarily disabled.${disabled.reason ? `\n${disabled.reason}` : ''}`)], ephemeral: true });
      }
      return await c.execute(interaction);
    }

    if (interaction.isStringSelectMenu()) return await handleSelect(interaction);
    if (interaction.isChannelSelectMenu()) return await handleChannelSelect(interaction);
    if (interaction.isRoleSelectMenu()) return await handleRoleSelect(interaction);
    if (interaction.isUserSelectMenu()) return await handleUserSelect(interaction);
    if (interaction.isButton()) return await handleButton(interaction);
    if (interaction.isModalSubmit()) return await handleModal(interaction);
  } catch (e) {
    await logError(e, `Interaction ${interaction.commandName || interaction.customId}`, {
      command: interaction.commandName, guildId: interaction.guildId, userId: interaction.user?.id
    });
    const payload = { embeds: [ui.errEmbed('Error', 'Something went wrong. The issue has been logged.')], ephemeral: true };
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch {}
  }
});

// ================= BUTTONS =================
async function handleButton(i) {
  const id = i.customId;

  // Help refresh
  if (id === 'help:refresh') return i.update(ui.helpMenuEmbed(i.client));

  // Setup
  if (id === 'setup:health') {
    await i.deferReply({ ephemeral: true });
    const issues = await sys.healthCheck(i.guild);
    const desc = issues.length
      ? issues.map(x => `${x.severity === 'high' ? '🔴' : x.severity === 'medium' ? '🟡' : '🟢'} ${x.text}`).join('\n')
      : 'All checks passed.';
    return i.editReply({ embeds: [ui.embed('🩺 Health Check', desc)] });
  }
  if (id === 'setup:backup') {
    const buf = Buffer.from(JSON.stringify(db.exportGuild(i.guildId), null, 2));
    return i.reply({ content: 'Backup attached.', files: [{ attachment: buf, name: `aunxz-${i.guildId}.json` }], ephemeral: true });
  }
  if (id === 'setup:wizard') {
    const row = ui.row(new StringSelectMenuBuilder().setCustomId('wizard:modules')
      .setPlaceholder('Modules to enable').setMinValues(1).setMaxValues(20)
      .addOptions(ui.SETUP_MODULES.filter(m => m.cfgKey).map(m => ({ label: m.label, value: m.key, description: m.desc.slice(0, 100) }))));
    return i.reply({ embeds: [ui.infoEmbed('Guided Wizard', 'Select modules to enable.')], components: [row], ephemeral: true });
  }
  if (id.startsWith('setup:toggle:')) {
    if (!cmd.requireAdmin(i)) return;
    const key = id.split(':')[2];
    const mod = ui.SETUP_MODULES.find(m => m.cfgKey === key);
    if (!mod) return i.reply({ content: 'Unknown module.', ephemeral: true });
    const cur = db.getConfig(i.guildId)[key];
    const curEnabled = typeof cur === 'boolean' ? cur : cur?.enabled;
    db.saveConfig(i.guildId, { [key]: { enabled: !curEnabled } });
    sys.refreshAutomod(i.guildId);
    return i.reply({ embeds: [ui.okEmbed('Updated', `${mod.label}: ${!curEnabled ? 'enabled' : 'disabled'}.`)], ephemeral: true });
  }
  if (id.startsWith('setup:refresh:')) {
    if (!cmd.requireAdmin(i)) return;
    const key = id.split(':')[2];
    const cfg = db.getConfig(i.guildId)[key];
    const fields = Object.entries(cfg).filter(([k]) => k !== 'enabled').map(([k, v]) => ({
      name: k, inline: true,
      value: v === null || v === undefined ? '—' : Array.isArray(v) ? (v.length ? v.join(', ') : '—') : typeof v === 'object' ? '`' + JSON.stringify(v) + '`' : String(v).slice(0, 200)
    }));
    const e = ui.buildV2({
      title: `🛡️ ${key} — Setup`,
      description: `**Status:** ${cfg.enabled ? '🟢 Enabled' : '⚪ Disabled'}`,
      fields: fields.slice(0, 25),
      components: [ui.row(
        ui.btn(`setup:toggle:${key}`, cfg.enabled ? 'Disable' : 'Enable', cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        ui.btn(`setup:refresh:${key}`, 'Refresh', ButtonStyle.Secondary)
      )]
    });
    return i.update({ ...e, ephemeral: true });
  }

  // Ticket open — panel handles select; this handles any legacy button
  if (id === 'ticket:open') {
    await i.deferReply({ ephemeral: true });
    try {
      const { channel } = await sys.openTicket(i.guild, i.user);
      await i.editReply({ embeds: [ui.okEmbed('Opened', `Ticket: ${channel}`)] });
    } catch (e) {
      await i.editReply({ embeds: [ui.errEmbed('Failed', String(e.message || e))] });
    }
    return;
  }

  // Ticket controls
  if (id === 'ticket:claim' || id === 'ticket:unclaim') {
    const t = db.getTicket(i.channel.id);
    if (!t) return i.reply({ embeds: [ui.errEmbed('Not a ticket', 'This button only works inside a ticket.')], ephemeral: true });
    const cfg = db.getConfig(i.guildId).ticket;
    const isSupport = (cfg.supportRoleId && i.member.roles.cache.has(cfg.supportRoleId)) || sys.isAdmin(i.member);
    if (!isSupport) return i.reply({ embeds: [ui.errEmbed('Denied', 'Support role required.')], ephemeral: true });
    const claiming = !t.claimedBy;
    db.setTicketStatus(i.channel.id, t.status, claiming ? i.user.id : null);
    db.logTicketEvent(i.guildId, i.channel.id, i.user.id, claiming ? 'claim' : 'unclaim');
    await i.reply({ embeds: [ui.okEmbed(claiming ? 'Claimed' : 'Unclaimed', claiming ? `${i.user} claimed this ticket.` : `${i.user} unclaimed.`)] });
    return;
  }
  if (id === 'ticket:add') {
    return i.reply({ embeds: [ui.infoEmbed('Add member', 'Pick a member below.')],
      components: [ui.row(new UserSelectMenuBuilder().setCustomId('ticket:add:select').setPlaceholder('Member to add'))], ephemeral: true });
  }
  if (id === 'ticket:remove') {
    return i.reply({ embeds: [ui.infoEmbed('Remove member', 'Pick a member below.')],
      components: [ui.row(new UserSelectMenuBuilder().setCustomId('ticket:remove:select').setPlaceholder('Member to remove'))], ephemeral: true });
  }
  if (id === 'ticket:rename') {
    const t = db.getTicket(i.channel.id);
    if (!t) return i.reply({ embeds: [ui.errEmbed('Not a ticket', 'Not in a ticket.')], ephemeral: true });
    const modal = new ModalBuilder().setCustomId('ticket:rename:modal').setTitle('Rename Ticket');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('name').setLabel('New name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(90).setValue(i.channel.name)
    ));
    return i.showModal(modal);
  }
  if (id === 'ticket:close') {
    const t = db.getTicket(i.channel.id);
    if (!t) return i.reply({ embeds: [ui.errEmbed('Not a ticket', 'Not in a ticket.')], ephemeral: true });
    const cfg = db.getConfig(i.guildId).ticket;
    const isSupport = (cfg.supportRoleId && i.member.roles.cache.has(cfg.supportRoleId)) || sys.isAdmin(i.member);
    if (!isSupport && i.user.id !== t.userId) return i.reply({ embeds: [ui.errEmbed('Denied', 'Only staff or the ticket owner can close.')], ephemeral: true });
    await i.deferReply({ ephemeral: true });
    try {
      await sys.closeTicketWith(i.channel, i.guild, i.user, 'Closed via button');
      await i.editReply({ embeds: [ui.okEmbed('Closed', 'Ticket closed. Use **Reopen** if needed.')] });
    } catch (e) { await i.editReply({ embeds: [ui.errEmbed('Failed', String(e.message || e))] }); }
    return;
  }
  if (id === 'ticket:reopen') {
    const t = db.getTicket(i.channel.id);
    if (!t) return i.reply({ embeds: [ui.errEmbed('Not a ticket', 'Not in a ticket.')], ephemeral: true });
    const cfg = db.getConfig(i.guildId).ticket;
    const isSupport = (cfg.supportRoleId && i.member.roles.cache.has(cfg.supportRoleId)) || sys.isAdmin(i.member);
    if (!isSupport) return i.reply({ embeds: [ui.errEmbed('Denied', 'Support role required.')], ephemeral: true });
    await i.deferReply({ ephemeral: true });
    try {
      await sys.reopenTicket(i.channel, i.guild, i.user);
      await i.editReply({ embeds: [ui.okEmbed('Reopened', 'Ticket reopened.')] });
    } catch (e) { await i.editReply({ embeds: [ui.errEmbed('Failed', String(e.message || e))] }); }
    return;
  }
  if (id === 'ticket:transcript') {
    const t = db.getTicket(i.channel.id);
    if (!t) return i.reply({ embeds: [ui.errEmbed('Not a ticket', 'Not in a ticket.')], ephemeral: true });
    await i.deferReply({ ephemeral: true });
    const buf = await sys.buildTranscript(i.channel, t);
    if (!buf) return i.editReply({ embeds: [ui.errEmbed('Failed', 'Could not build the transcript.')] });
    const cfg = db.getConfig(i.guildId).ticket;
    if (cfg.logChannelId) {
      const logCh = i.guild.channels.cache.get(cfg.logChannelId);
      if (logCh?.isTextBased()) logCh.send({ content: `Transcript for <#${i.channel.id}>`, files: [{ attachment: buf, name: `transcript-${i.channel.id}.txt` }] }).catch(() => {});
    }
    return i.editReply({ content: 'Transcript', files: [{ attachment: buf, name: `transcript-${i.channel.id}.txt` }] });
  }
  if (id === 'ticket:delete') {
    const t = db.getTicket(i.channel.id);
    if (!t) return i.reply({ embeds: [ui.errEmbed('Not a ticket', 'Not in a ticket.')], ephemeral: true });
    const cfg = db.getConfig(i.guildId).ticket;
    const isSupport = (cfg.supportRoleId && i.member.roles.cache.has(cfg.supportRoleId)) || sys.isAdmin(i.member);
    if (!isSupport) return i.reply({ embeds: [ui.errEmbed('Denied', 'Support role required.')], ephemeral: true });
    db.setTicketStatus(i.channel.id, 'closed');
    db.logTicketEvent(i.guildId, i.channel.id, i.user.id, 'delete', null);
    await i.reply({ embeds: [ui.warnEmbed('Deleting', 'Channel will be removed.')] });
    setTimeout(() => i.channel.delete().catch(() => {}), 1500);
    return;
  }

  // Ticket config buttons
  if (id === 'ticket:cfg:toggle') {
    if (!cmd.requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).ticket;
    db.saveConfig(i.guildId, { ticket: { enabled: !cfg.enabled } });
    return i.reply({ embeds: [ui.okEmbed('Updated', `Tickets ${!cfg.enabled ? 'enabled' : 'disabled'}.`)], ephemeral: true });
  }
  if (id === 'ticket:cfg:post') {
    if (!cmd.requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).ticket;
    if (!cfg.enabled) return i.reply({ embeds: [ui.errEmbed('Disabled', 'Enable tickets first.')], ephemeral: true });
    const panel = ui.ticketPanelEmbed(cfg, i.guild.name);
    await i.channel.send(panel);
    return i.reply({ embeds: [ui.okEmbed('Posted', 'Panel is live.')], ephemeral: true });
  }

  // Giveaway entry
  if (id.startsWith('giveaway:enter:')) {
    const gid = parseInt(id.split(':')[2], 10);
    const g = db.getGiveaway(i.guildId, gid);
    if (!g || g.status !== 'active' || g.endsAt <= Date.now()) return i.reply({ content: 'This giveaway has ended.', ephemeral: true });
    let participants = [];
    try { participants = JSON.parse(g.participants || '[]'); } catch {}
    const has = participants.includes(i.user.id);
    participants = has ? participants.filter(x => x !== i.user.id) : [...participants, i.user.id];
    db.updateGiveaway(i.guildId, g.id, { participants: JSON.stringify(participants) });
    return i.reply({ content: has ? 'You left the giveaway.' : `Entered! ${participants.length} participant(s).`, ephemeral: true });
  }

  // Snipe navigation
  if (id.startsWith('snipe:nav:')) {
    const [, , guildId, channelId, offsetStr] = id.split(':');
    const view = sys.snipeView(guildId, channelId, parseInt(offsetStr, 10));
    return i.update({ ...view, ephemeral: true });
  }

  // VoiceMaster
  if (id.startsWith('vm_')) {
    const vc = i.member.voice.channel;
    if (!vc || !db.getVMChannel(vc.id)) return i.reply({ embeds: [ui.errEmbed('No channel', 'Join your VoiceMaster channel first.')], ephemeral: true });
    const rec = db.getVMChannel(vc.id);
    if (rec.ownerId !== i.user.id) return i.reply({ embeds: [ui.errEmbed('Denied', 'Only the channel owner can do that.')], ephemeral: true });
    const everyone = i.guild.roles.everyone;
    const ow = vc.permissionOverwrites.cache.get(everyone.id);
    if (id === 'vm_lock') {
      const locked = !!(ow && ow.deny.has(PermissionFlagsBits.Connect));
      await vc.permissionOverwrites.edit(everyone, { Connect: locked ? null : false });
      return i.reply({ embeds: [ui.okEmbed(locked ? 'Unlocked' : 'Locked', locked ? 'Anyone can join.' : 'Only allowed members can join.')] });
    }
    if (id === 'vm_hide') {
      const hidden = !!(ow && ow.deny.has(PermissionFlagsBits.ViewChannel));
      await vc.permissionOverwrites.edit(everyone, { ViewChannel: hidden ? null : false });
      return i.reply({ embeds: [ui.okEmbed(hidden ? 'Visible' : 'Hidden', hidden ? 'Visible again.' : 'Hidden from others.')] });
    }
    if (id === 'vm_rename') {
      const modal = new ModalBuilder().setCustomId('vm:rename:modal').setTitle('Rename Channel');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('New name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(90).setValue(vc.name)));
      return i.showModal(modal);
    }
    if (id === 'vm_limit') {
      const modal = new ModalBuilder().setCustomId('vm:limit:modal').setTitle('Set User Limit');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('limit').setLabel('0-99').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2).setValue(String(vc.userLimit))));
      return i.showModal(modal);
    }
    if (id === 'vm_kick') {
      const others = vc.members.filter(m => m.id !== i.user.id);
      if (!others.size) return i.reply({ embeds: [ui.infoEmbed('Nobody to kick', 'You are alone.')], ephemeral: true });
      return i.reply({ embeds: [ui.infoEmbed('Kick who?', 'Choose a member.')],
        components: [ui.row(new StringSelectMenuBuilder().setCustomId('vm:kick:select').setPlaceholder('Choose a member')
          .addOptions(others.slice(0, 25).map(m => ({ label: m.displayName.slice(0, 100), value: m.id }))))], ephemeral: true });
    }
    if (id === 'vm_transfer') {
      const modal = new ModalBuilder().setCustomId('vm:transfer:modal').setTitle('Transfer Ownership');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('userId').setLabel('User ID').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(25)));
      return i.showModal(modal);
    }
    return;
  }

  // VoiceMaster setup panel
  if (id === 'vm:cfg:toggle') {
    if (!cmd.requireAdmin(i)) return;
    const cur = db.getConfig(i.guildId).voicemaster;
    db.saveConfig(i.guildId, { voicemaster: { enabled: !cur.enabled } });
    return i.reply({ embeds: [ui.okEmbed('Updated', `VoiceMaster ${!cur.enabled ? 'enabled' : 'disabled'}.`)], ephemeral: true });
  }
  if (id === 'vm:cfg:name') {
    const cur = db.getConfig(i.guildId).voicemaster;
    const modal = new ModalBuilder().setCustomId('vm:cfg:name:modal').setTitle('Name Template');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tpl').setLabel('{user} = username').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(90).setValue(cur.nameTemplate)));
    return i.showModal(modal);
  }

  // Automod
  if (id === 'automod:toggle' || id === 'automod:caps' || id === 'automod:invite' || id === 'automod:words') {
    if (!cmd.requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).automod;
    if (id === 'automod:toggle') db.saveConfig(i.guildId, { automod: { enabled: !cfg.enabled } });
    else if (id === 'automod:caps') db.saveConfig(i.guildId, { automod: { capsFilter: !cfg.capsFilter } });
    else if (id === 'automod:invite') db.saveConfig(i.guildId, { automod: { inviteFilter: !cfg.inviteFilter } });
    else {
      const modal = new ModalBuilder().setCustomId('automod:words:modal').setTitle('Bad Words');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('words').setLabel('Comma-separated words').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000).setValue((cfg.badWords || []).join(', '))
      ));
      return i.showModal(modal);
    }
    const next = db.getConfig(i.guildId).automod;
    sys.refreshAutomod(i.guildId);
    const e = ui.buildV2({
      title: '🛡️ AutoMod',
      fields: [
        { name: 'Status', value: next.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
        { name: 'Caps', value: next.capsFilter ? `${next.capsThreshold}%` : 'Off', inline: true },
        { name: 'Invites', value: next.inviteFilter ? 'On' : 'Off', inline: true },
        { name: 'Bad words', value: String((next.badWords || []).length), inline: true }
      ],
      components: [ui.row(
        ui.btn('automod:toggle', next.enabled ? 'Disable' : 'Enable', next.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        ui.btn('automod:caps', 'Caps Filter', ButtonStyle.Secondary),
        ui.btn('automod:invite', 'Invite Filter', ButtonStyle.Secondary),
        ui.btn('automod:words', 'Bad Words', ButtonStyle.Secondary)
      )]
    });
    return i.update({ ...e, ephemeral: true });
  }

  // Badword
  if (id === 'badword:toggle') {
    if (!cmd.requireAdmin(i)) return;
    const cur = db.getConfig(i.guildId).antibadword;
    db.saveConfig(i.guildId, { antibadword: { enabled: !cur.enabled } });
    sys.refreshAutomod(i.guildId);
    return i.reply({ embeds: [ui.okEmbed('Updated', `Bad-word filter ${!cur.enabled ? 'enabled' : 'disabled'}.`)], ephemeral: true });
  }
  if (id === 'badword:words') {
    const cur = db.getConfig(i.guildId).antibadword;
    const modal = new ModalBuilder().setCustomId('badword:words:modal').setTitle('Custom Bad Words');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('words').setLabel('Comma-separated').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000).setValue((cur.customWords || []).join(', '))
    ));
    return i.showModal(modal);
  }

  // Welcome/leave
  if (id === 'welcome:toggle' || id === 'leave:toggle') {
    const key = id.split(':')[0];
    if (!cmd.requireAdmin(i)) return;
    const cur = db.getConfig(i.guildId)[key];
    db.saveConfig(i.guildId, { [key]: { enabled: !cur.enabled } });
    return i.reply({ embeds: [ui.okEmbed('Updated', `${key} ${!cur.enabled ? 'enabled' : 'disabled'}.`)], ephemeral: true });
  }
  if (id === 'welcome:edit' || id === 'leave:edit') {
    const key = id.split(':')[0];
    const cur = db.getConfig(i.guildId)[key];
    const modal = new ModalBuilder().setCustomId(`${key}:edit:modal`).setTitle(`Edit ${key} message`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('message').setLabel('Message ({user} {server} {count})').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500).setValue(String(cur.message || ''))
    ));
    return i.showModal(modal);
  }

  // Greet message
  if (id === 'greetmsg:toggle' || id === 'greetmsg:ping') {
    if (!cmd.requireAdmin(i)) return;
    const cur = db.getConfig(i.guildId).greetmessage;
    if (id === 'greetmsg:toggle') db.saveConfig(i.guildId, { greetmessage: { enabled: !cur.enabled } });
    else db.saveConfig(i.guildId, { greetmessage: { ping: cur.ping === false } });
    return i.reply({ embeds: [ui.okEmbed('Updated', 'Greet message updated.')], ephemeral: true });
  }
  if (id === 'greetmsg:edit') {
    const cur = db.getConfig(i.guildId).greetmessage;
    const modal = new ModalBuilder().setCustomId('greetmsg:edit:modal').setTitle('Edit Welcome');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200).setValue(String(cur.title || ''))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel('Message').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500).setValue(String(cur.message || '')))
    );
    return i.showModal(modal);
  }
  if (id === 'greetmsg:test') {
    const cur = db.getConfig(i.guildId).greetmessage;
    const text = sys.applyTemplate(cur.message, { user: `<@${i.user.id}>`, username: i.user.username, server: i.guild.name, count: i.guild.memberCount });
    const e = ui.embed(cur.title || 'Welcome', text).setThumbnail(i.user.displayAvatarURL());
    if (cur.image) e.setImage(cur.image);
    return i.reply({ embeds: [e], ephemeral: true });
  }

  // Leveling
  if (id === 'leveling:toggle') {
    if (!cmd.requireAdmin(i)) return;
    const cur = db.getConfig(i.guildId).leveling;
    db.saveConfig(i.guildId, { leveling: { enabled: !cur.enabled } });
    return i.reply({ embeds: [ui.okEmbed('Updated', `Leveling ${!cur.enabled ? 'enabled' : 'disabled'}.`)], ephemeral: true });
  }
  if (id === 'leveling:rewards') {
    const cur = db.getConfig(i.guildId).leveling;
    const modal = new ModalBuilder().setCustomId('leveling:rewards:modal').setTitle('Role Rewards');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('rewards').setLabel('Format: level=roleId, level2=roleId2').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000)
        .setValue(Object.entries(cur.roleRewards || {}).map(([l, r]) => `${l}=${r}`).join(', '))
    ));
    return i.showModal(modal);
  }
  if (id === 'leveling:xp') {
    const modal = new ModalBuilder().setCustomId('leveling:xp:modal').setTitle('XP Rate');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('xp').setLabel('XP per message').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6).setValue(String(db.getConfig(i.guildId).leveling.xpPerMessage))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cd').setLabel('Cooldown seconds').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6).setValue(String(db.getConfig(i.guildId).leveling.cooldownSeconds)))
    );
    return i.showModal(modal);
  }

  // Honeypot
  if (id === 'honeypot:toggle') {
    if (!cmd.requireAdmin(i)) return;
    const cur = db.getConfig(i.guildId).honeypot;
    db.saveConfig(i.guildId, { honeypot: { enabled: !cur.enabled } });
    return i.reply({ embeds: [ui.okEmbed('Updated', `Honeypot ${!cur.enabled ? 'enabled' : 'disabled'}.`)], ephemeral: true });
  }
  if (id === 'honeypot:log') {
    return i.reply({ embeds: [ui.infoEmbed('Set log channel', 'Pick a channel below.')],
      components: [ui.row(new ChannelSelectMenuBuilder().setCustomId('honeypot:log:select').setPlaceholder('Log channel').setChannelTypes(ChannelType.GuildText))], ephemeral: true });
  }

  // Autoresponder / autoreactor
  if (id === 'ar:toggle' || id === 'arr:toggle') {
    if (!cmd.requireAdmin(i)) return;
    const key = id === 'ar:toggle' ? 'autoresponder' : 'autoreactor';
    const cur = db.getConfig(i.guildId)[key];
    db.saveConfig(i.guildId, { [key]: { enabled: !cur.enabled } });
    return i.reply({ embeds: [ui.okEmbed('Updated', `${key} ${!cur.enabled ? 'enabled' : 'disabled'}.`)], ephemeral: true });
  }
  if (id === 'ar:add' || id === 'arr:add') {
    const isAr = id === 'ar:add';
    const modal = new ModalBuilder().setCustomId(isAr ? 'ar:add:modal' : 'arr:add:modal').setTitle(isAr ? 'Add Auto Responder' : 'Add Auto Reactor');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('match').setLabel('Trigger phrase').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mode').setLabel('exact or contains').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20).setValue('contains')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(isAr ? 'response' : 'emojis').setLabel(isAr ? 'Response text' : 'Emojis (space-separated)').setStyle(isAr ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(true).setMaxLength(1500))
    );
    return i.showModal(modal);
  }
  if (id === 'ar:case' || id === 'arr:case') {
    if (!cmd.requireAdmin(i)) return;
    const key = id.startsWith('ar:') ? 'autoresponder' : 'autoreactor';
    const cur = db.getConfig(i.guildId)[key];
    db.saveConfig(i.guildId, { [key]: { ignoreCase: !cur.ignoreCase } });
    return i.reply({ embeds: [ui.okEmbed('Updated', `Case ${!cur.ignoreCase ? 'insensitive' : 'sensitive'}.`)], ephemeral: true });
  }

  // Role panel buttons
  if (id.startsWith('brp:') || id.startsWith('rrp:')) {
    if (!cmd.requireAdmin(i)) return;
    const [, action, panelId] = id.split(':');
    const mode = id.startsWith('brp:') ? 'button' : 'reaction';
    const panels = db.getConfig(i.guildId)[mode === 'button' ? 'buttonRolePanels' : 'reactionRolePanels'] || [];
    if (action === 'new') {
      const panel = { id: `${mode === 'button' ? 'btn' : 'rr'}_${Date.now().toString(36)}`, enabled: true, channelId: null, title: 'Choose your roles', description: 'Press a button / react to get a role.', buttons: [], mappings: [] };
      db.upsertPanel(i.guildId, mode, panel);
      const e = ui.rolePanelEmbed(panel, mode);
      return i.update({ ...e, ephemeral: true });
    }
    if (action === 'back') {
      const e = ui.rolePanelListEmbed(panels, mode);
      return i.update({ ...e, ephemeral: true });
    }
    if (action === 'select_first') {
      const p = panels[0];
      if (!p) return i.reply({ content: 'No panels yet.', ephemeral: true });
      const e = ui.rolePanelEmbed(p, mode);
      return i.update({ ...e, ephemeral: true });
    }
    const panel = db.findPanel(i.guildId, mode, panelId);
    if (!panel) return i.reply({ embeds: [ui.errEmbed('Not Found', 'Panel no longer exists.')], ephemeral: true });
    if (action === 'toggle') {
      db.upsertPanel(i.guildId, mode, { ...panel, enabled: panel.enabled === false });
      return i.update({ ...ui.rolePanelEmbed(db.findPanel(i.guildId, mode, panelId), mode), ephemeral: true });
    }
    if (action === 'del') {
      db.removePanel(i.guildId, mode, panelId);
      const e = ui.rolePanelListEmbed((db.getConfig(i.guildId)[mode === 'button' ? 'buttonRolePanels' : 'reactionRolePanels'] || []), mode);
      return i.update({ ...e, ephemeral: true });
    }
    if (action === 'edit') {
      const modal = new ModalBuilder().setCustomId(`${mode === 'button' ? 'brp' : 'rrp'}:edit:modal:${panelId}`).setTitle('Edit Panel');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200).setValue(panel.title || '')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500).setValue(panel.description || ''))
      );
      return i.showModal(modal);
    }
    if (action === 'post') {
      if (!panel.channelId) return i.reply({ embeds: [ui.errEmbed('No channel', 'Set a channel first.')], ephemeral: true });
      const ch = i.guild.channels.cache.get(panel.channelId);
      if (!ch?.isTextBased()) return i.reply({ embeds: [ui.errEmbed('Missing', 'Channel not accessible.')], ephemeral: true });
      try {
        if (mode === 'button') {
          const items = panel.buttons || [];
          if (!items.length) throw new Error('Add at least one role first.');
          const e = ui.embed(panel.title, panel.description || 'Click a button to get or remove a role.');
          const rows = [];
          for (let n = 0; n < items.length; n += 5) {
            const r = ui.row();
            for (const b of items.slice(n, n + 5)) r.addComponents(ui.btn(`rolebtn:${panel.id}:${b.roleId}`, b.label || 'Role', ButtonStyle.Primary));
            rows.push(r);
          }
          const msg = await ch.send({ embeds: [e], components: rows });
          db.upsertPanel(i.guildId, mode, { ...panel, messageId: msg.id });
        } else {
          const items = panel.mappings || [];
          if (!items.length) throw new Error('Add at least one mapping first.');
          const msg = await ch.send({ embeds: [ui.embed(panel.title, panel.description || 'React below to get a role.')] });
          for (const m of items) await msg.react(m.emoji).catch(() => {});
          db.upsertPanel(i.guildId, mode, { ...panel, messageId: msg.id });
        }
        return i.reply({ embeds: [ui.okEmbed('Posted', `Panel live in ${ch}.`)], ephemeral: true });
      } catch (e) { return i.reply({ embeds: [ui.errEmbed('Failed', String(e.message || e))], ephemeral: true }); }
    }
    return;
  }

  // Role button click
  if (id.startsWith('rolebtn:')) {
    const [, panelId, roleId] = id.split(':');
    const panel = db.findPanel(i.guildId, 'button', panelId);
    if (panel?.enabled === false) return i.reply({ embeds: [ui.errEmbed('Disabled', 'Panel disabled.')], ephemeral: true });
    const role = i.guild.roles.cache.get(roleId);
    if (!role) return i.reply({ embeds: [ui.errEmbed('Missing', 'Role no longer exists.')], ephemeral: true });
    const me = i.guild.members.me;
    if (role.position >= me.roles.highest.position) return i.reply({ embeds: [ui.errEmbed('Hierarchy', 'My role is below this one.')], ephemeral: true });
    try {
      const has = i.member.roles.cache.has(roleId);
      if (has) await i.member.roles.remove(role); else await i.member.roles.add(role);
      return i.reply({ embeds: [ui.okEmbed(has ? 'Removed' : 'Added', `${role}`)], ephemeral: true });
    } catch { return i.reply({ embeds: [ui.errEmbed('Failed', 'Role change failed.')], ephemeral: true }); }
  }

  // Staff app panel
  if (id === 'staffapp:apply') {
    const cfg = db.getConfig(i.guildId).staffApplications;
    if (!cfg.enabled || !(cfg.questions || []).length) return i.reply({ embeds: [ui.errEmbed('Unavailable', 'Applications not open.')], ephemeral: true });
    if (db.pendingApplicationForUser(i.guildId, i.user.id)) return i.reply({ embeds: [ui.warnEmbed('Pending', 'You already have a pending application.')], ephemeral: true });
    // Simple modal-based application: opens a modal with the first 5 questions
    const modal = new ModalBuilder().setCustomId('staffapp:submit:modal').setTitle('Application');
    for (let n = 0; n < Math.min(cfg.questions.length, 5); n++) {
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(`q${n}`).setLabel(cfg.questions[n].slice(0, 45)).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)
      ));
    }
    return i.showModal(modal);
  }

  // Application review
  if (id.startsWith('app:review:')) {
    const [, , decision, appId] = id.split(':');
    if (!cmd.requireAdmin(i)) return;
    const app = db.getApplication(parseInt(appId, 10));
    if (!app) return i.reply({ embeds: [ui.errEmbed('Not Found', 'Application missing.')], ephemeral: true });
    db.updateApplication(app.id, { status: decision, reviewerId: i.user.id, decidedAt: Date.now() });
    const user = await i.client.users.fetch(app.userId).catch(() => null);
    if (user) user.send({ embeds: [ui.embed(`Application ${decision}`, `Your application has been **${decision}** by ${i.user.tag}.`)] }).catch(() => {});
    return i.update({ embeds: [ui.okEmbed('Recorded', `Application #${app.id} ${decision}.`)], components: [] });
  }

  // Birthdays
  if (id === 'bday:set') {
    const modal = new ModalBuilder().setCustomId('bday:set:modal').setTitle('Set Birthday');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel('Birthday (DD-MM)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)));
    return i.showModal(modal);
  }
  if (id === 'bday:cfg:toggle') {
    if (!cmd.requireAdmin(i)) return;
    const cur = db.getConfig(i.guildId).birthdays;
    db.saveConfig(i.guildId, { birthdays: { enabled: !cur.enabled } });
    return i.reply({ embeds: [ui.okEmbed('Updated', `Birthdays ${!cur.enabled ? 'enabled' : 'disabled'}.`)], ephemeral: true });
  }
  if (id === 'bday:cfg:message') {
    const cur = db.getConfig(i.guildId).birthdays;
    const modal = new ModalBuilder().setCustomId('bday:cfg:message:modal').setTitle('Wish Message');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('msg').setLabel('Use {user}').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500).setValue(cur.wishMessage)));
    return i.showModal(modal);
  }
  if (id === 'bday:cfg:post') {
    if (!cmd.requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).birthdays;
    const chId = cfg.panelChannelId || i.channel.id;
    const ch = i.guild.channels.cache.get(chId);
    if (!ch?.isTextBased()) return i.reply({ embeds: [ui.errEmbed('Missing', 'Channel not set.')], ephemeral: true });
    const e = ui.buildV2({
      title: '🎂 Birthday Panel',
      description: 'Press the button to set your birthday.',
      components: [ui.row(ui.btn('bday:set', 'Set Birthday', ButtonStyle.Primary, { emoji: '🎂' }))]
    });
    await ch.send(e);
    return i.reply({ embeds: [ui.okEmbed('Posted', `Posted in ${ch}.`)], ephemeral: true });
  }

  // Staff application setup buttons
  if (id === 'app:cfg:toggle') {
    if (!cmd.requireAdmin(i)) return;
    const cur = db.getConfig(i.guildId).staffApplications;
    db.saveConfig(i.guildId, { staffApplications: { enabled: !cur.enabled } });
    return i.reply({ embeds: [ui.okEmbed('Updated', `Applications ${!cur.enabled ? 'enabled' : 'disabled'}.`)], ephemeral: true });
  }
  if (id === 'app:cfg:questions') {
    const cur = db.getConfig(i.guildId).staffApplications;
    const modal = new ModalBuilder().setCustomId('app:cfg:questions:modal').setTitle('Application Questions');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('q').setLabel('One question per line (max 10)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000)
        .setValue((cur.questions || []).join('\n'))
    ));
    return i.showModal(modal);
  }
  if (id === 'app:cfg:post') {
    if (!cmd.requireAdmin(i)) return;
    const cfg = db.getConfig(i.guildId).staffApplications;
    const chId = cfg.panelChannelId || i.channel.id;
    const ch = i.guild.channels.cache.get(chId);
    if (!ch?.isTextBased()) return i.reply({ embeds: [ui.errEmbed('Missing', 'Panel channel not set.')], ephemeral: true });
    const e = ui.buildV2({
      title: cfg.title || 'Staff Applications',
      description: cfg.description || 'Click Apply to start your application.',
      components: [ui.row(ui.btn('staffapp:apply', 'Apply', ButtonStyle.Success, { emoji: '📝' }))]
    });
    await ch.send(e);
    return i.reply({ embeds: [ui.okEmbed('Posted', `Posted in ${ch}.`)], ephemeral: true });
  }

  // Templategen
  if (id.startsWith('tgen:type:')) {
    const type = id.split(':')[2];
    const sid = setSession(`tgen:${i.user.id}`, { type, step: 'naming' });
    const row = ui.row(
      ui.btn(`tgen:naming:${sid}:emoji_divider`, 'Emoji + Divider', ButtonStyle.Secondary),
      ui.btn(`tgen:naming:${sid}:tree`, 'Tree Structure', ButtonStyle.Secondary),
      ui.btn(`tgen:naming:${sid}:decorative`, 'Decorative', ButtonStyle.Secondary),
      ui.btn(`tgen:naming:${sid}:minimal`, 'Minimal', ButtonStyle.Secondary)
    );
    return i.update({ embeds: [ui.embed('Step 2', `Type: **${type}**. Choose naming style.`)], components: [row] });
  }
  if (id.startsWith('tgen:naming:')) {
    const [, , sid, style] = id.split(':');
    const s = getSession(sid);
    if (!s) return i.reply({ content: 'Session expired.', ephemeral: true });
    s.naming = style;
    return i.update({
      embeds: [ui.embed('Ready', `Type **${s.type}**, style **${style}**.`)],
      components: [ui.row(ui.btn(`tgen:go:${sid}`, 'Generate', ButtonStyle.Success, { emoji: '🧩' }))]
    });
  }
  if (id.startsWith('tgen:go:')) {
    const sid = id.split(':')[2];
    const s = getSession(sid);
    if (!s) return i.reply({ content: 'Session expired.', ephemeral: true });
    await i.deferReply({ ephemeral: true });
    try {
      const tpl = await sys.generateTemplate({ serverType: s.type, namingStyle: s.naming, guildName: i.guild.name });
      s.template = tpl;
      const preview = tpl.categories.map(c => `**${c.emoji || ''} ${c.name}**\n${c.channels.map(ch => `  ${ch.type === 'voice' ? '🔊' : '#'} ${ch.emoji || ''} ${ch.name}`).join('\n')}`).join('\n\n');
      const e = ui.buildV2({ title: '🧩 Preview', description: preview.slice(0, 3900) || 'empty',
        components: [ui.row(
          ui.btn(`tgen:apply:${sid}`, 'Apply', ButtonStyle.Success),
          ui.btn(`tgen:cancel:${sid}`, 'Cancel', ButtonStyle.Secondary)
        )] });
      return i.editReply({ ...e });
    } catch (e) {
      await logError(e, 'templategen');
      return i.editReply({ embeds: [ui.errEmbed('Failed', String(e.message))] });
    }
  }
  if (id.startsWith('tgen:apply:')) {
    const sid = id.split(':')[2];
    const s = getSession(sid);
    if (!s?.template) return i.reply({ content: 'Session expired.', ephemeral: true });
    await i.deferReply({ ephemeral: true });
    const results = await sys.applyTemplateToGuild(i.guild, s.template, s.naming);
    const e = ui.embed('✅ Template Applied', null).addFields(
      { name: 'Categories', value: String(results.categories), inline: true },
      { name: 'Channels', value: String(results.channels), inline: true },
      { name: 'Roles', value: String(results.roles), inline: true },
      { name: 'Errors', value: results.errors.length ? results.errors.slice(0, 10).join('\n').slice(0, 1000) : 'None' }
    );
    sessions.delete(sid);
    return i.editReply({ embeds: [e] });
  }
  if (id.startsWith('tgen:cancel:')) {
    sessions.delete(id.split(':')[2]);
    return i.update({ embeds: [ui.infoEmbed('Cancelled', 'No changes made.')], components: [] });
  }

  return;
}

// ================= SELECT MENUS =================
async function handleSelect(i) {
  const id = i.customId;
  if (id === 'help_select') {
    const c = ui.HELP_CATEGORIES[i.values[0]];
    if (!c) return;
    return i.update(ui.buildV2({ title: `${c.emoji} ${c.name}`, description: c.desc, components: [ui.helpSelectRow()] }));
  }
  if (id === 'setup_module') {
    const mod = ui.SETUP_MODULES.find(m => m.key === i.values[0]);
    if (!mod) return;
    const cfg = db.getConfig(i.guildId);
    const val = mod.cfgKey ? mod.cfgKey.split('.').reduce((a, k) => a?.[k], cfg) : null;
    const enabled = typeof val === 'boolean' ? val : val?.enabled;
    return i.update(ui.buildV2({
      title: `⚙️ ${mod.label}`,
      description: `**Status:** ${enabled ? '🟢 Enabled' : '⚪ Disabled'}\n\n${mod.desc}`,
      components: [ui.row(
        ui.btn(`setup:toggle:${mod.cfgKey}`, enabled ? 'Disable' : 'Enable', enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        ui.btn('setup:back', 'Back', ButtonStyle.Secondary)
      )]
    }));
  }
  if (id === 'wizard:modules') {
    for (const m of i.values) {
      const mod = ui.SETUP_MODULES.find(x => x.key === m);
      if (mod?.cfgKey) db.saveConfig(i.guildId, { [mod.cfgKey]: { enabled: true } });
    }
    sys.refreshAutomod(i.guildId);
    return i.update({ embeds: [ui.okEmbed('Enabled', i.values.join(', '))], components: [] });
  }
  if (id === 'logsetup:cat') {
    setSession(`logs:${i.user.id}`, { key: i.values[0] });
    return i.reply({ content: `Selected **${i.values[0]}**. Now pick a channel.`, ephemeral: true });
  }
  if (id === 'ticket:open:select') {
    await i.deferReply({ ephemeral: true });
    try {
      const { channel } = await sys.openTicket(i.guild, i.user, { type: i.values[0] });
      await i.editReply({ embeds: [ui.okEmbed('Opened', `Ticket created: ${channel}`)] });
    } catch (e) {
      await i.editReply({ embeds: [ui.errEmbed('Failed', String(e.message || e))] });
    }
    return;
  }
  if (id === 'honeypot:action') {
    if (!cmd.requireAdmin(i)) return;
    db.saveConfig(i.guildId, { honeypot: { action: i.values[0] } });
    return i.reply({ embeds: [ui.okEmbed('Updated', `Action: ${i.values[0]}.`)], ephemeral: true });
  }
  if (id === 'ar:remove' || id === 'arr:remove') {
    if (!cmd.requireAdmin(i)) return;
    const key = id === 'ar:remove' ? 'autoresponder' : 'autoreactor';
    const cur = db.getConfig(i.guildId)[key];
    db.saveConfig(i.guildId, { [key]: { triggers: (cur.triggers || []).filter(t => t.id !== i.values[0]) } });
    return i.reply({ embeds: [ui.okEmbed('Removed', 'Trigger removed.')], ephemeral: true });
  }
  if (id === 'vm:kick:select') {
    const vc = i.member.voice.channel;
    if (!vc) return i.reply({ content: 'You are not in a voice channel.', ephemeral: true });
    const rec = db.getVMChannel(vc.id);
    if (!rec || rec.ownerId !== i.user.id) return i.reply({ content: 'Not allowed.', ephemeral: true });
    const m = vc.members.get(i.values[0]);
    if (m) await m.voice.disconnect('Removed by channel owner').catch(() => {});
    return i.update({ embeds: [ui.okEmbed('Kicked', 'Member removed.')], components: [] });
  }
}

// ================= CHANNEL SELECTS =================
async function handleChannelSelect(i) {
  const id = i.customId;
  const ch = i.values[0];
  if (id === 'welcome:channel') { db.saveConfig(i.guildId, { welcome: { channel: ch } }); return i.reply({ embeds: [ui.okEmbed('Set', `Welcome channel: <#${ch}>.`)], ephemeral: true }); }
  if (id === 'leave:channel') { db.saveConfig(i.guildId, { leave: { channel: ch } }); return i.reply({ embeds: [ui.okEmbed('Set', `Leave channel: <#${ch}>.`)], ephemeral: true }); }
  if (id === 'greetmsg:channel') { db.saveConfig(i.guildId, { greetmessage: { channelId: ch } }); return i.reply({ embeds: [ui.okEmbed('Set', 'Greet channel saved.')], ephemeral: true }); }
  if (id === 'ticket:cfg:category') { db.saveConfig(i.guildId, { ticket: { categoryId: ch } }); return i.reply({ embeds: [ui.okEmbed('Set', 'Ticket category set.')], ephemeral: true }); }
  if (id === 'ticket:cfg:log') { db.saveConfig(i.guildId, { ticket: { logChannelId: ch } }); return i.reply({ embeds: [ui.okEmbed('Set', 'Ticket log channel set.')], ephemeral: true }); }
  if (id === 'leveling:channel') { db.saveConfig(i.guildId, { leveling: { channel: ch } }); return i.reply({ embeds: [ui.okEmbed('Set', 'Level-up channel saved.')], ephemeral: true }); }
  if (id === 'honeypot:channel') { db.saveConfig(i.guildId, { honeypot: { channelId: ch } }); return i.reply({ embeds: [ui.okEmbed('Set', 'Honeypot channel set.')], ephemeral: true }); }
  if (id === 'honeypot:log:select') { db.saveConfig(i.guildId, { honeypot: { logChannelId: ch } }); return i.reply({ embeds: [ui.okEmbed('Set', 'Log channel set.')], ephemeral: true }); }
  if (id === 'vm:cfg:hub') { db.saveConfig(i.guildId, { voicemaster: { hubChannelId: ch } }); return i.reply({ embeds: [ui.okEmbed('Set', 'Hub channel saved.')], ephemeral: true }); }
  if (id === 'vm:cfg:category') { db.saveConfig(i.guildId, { voicemaster: { categoryId: ch } }); return i.reply({ embeds: [ui.okEmbed('Set', 'Category saved.')], ephemeral: true }); }
  if (id === 'app:cfg:review') { db.saveConfig(i.guildId, { staffApplications: { logChannelId: ch } }); return i.reply({ embeds: [ui.okEmbed('Set', 'Review channel set.')], ephemeral: true }); }
  if (id === 'app:cfg:panel') { db.saveConfig(i.guildId, { staffApplications: { panelChannelId: ch } }); return i.reply({ embeds: [ui.okEmbed('Set', 'Panel channel saved.')], ephemeral: true }); }
  if (id === 'bday:cfg:panel') { db.saveConfig(i.guildId, { birthdays: { panelChannelId: ch } }); return i.reply({ embeds: [ui.okEmbed('Set', 'Panel channel saved.')], ephemeral: true }); }
  if (id === 'bday:cfg:wish') { db.saveConfig(i.guildId, { birthdays: { wishChannelId: ch } }); return i.reply({ embeds: [ui.okEmbed('Set', 'Wish channel saved.')], ephemeral: true }); }
  if (id === 'logsetup:channel') {
    const s = getSession(`logs:${i.user.id}`);
    if (!s?.key) return i.reply({ content: 'Pick a category first.', ephemeral: true });
    db.setLogConfig(i.guildId, s.key, { channelId: ch, enabled: 1 });
    sessions.delete(`logs:${i.user.id}`);
    return i.reply({ embeds: [ui.okEmbed('Set', `**${s.key}** logs → <#${ch}>.`)], ephemeral: true });
  }
  if (id.startsWith('brp:channel:') || id.startsWith('rrp:channel:')) {
    const mode = id.startsWith('brp:') ? 'button' : 'reaction';
    const panelId = id.split(':')[2];
    const panel = db.findPanel(i.guildId, mode, panelId);
    if (!panel) return i.reply({ content: 'Not found.', ephemeral: true });
    db.upsertPanel(i.guildId, mode, { ...panel, channelId: ch });
    return i.update({ ...ui.rolePanelEmbed(db.findPanel(i.guildId, mode, panelId), mode), ephemeral: true });
  }
}

async function handleRoleSelect(i) {
  const id = i.customId;
  const roleId = i.values[0];
  if (id === 'ticket:cfg:support') { db.saveConfig(i.guildId, { ticket: { supportRoleId: roleId } }); return i.reply({ embeds: [ui.okEmbed('Set', 'Support role saved.')], ephemeral: true }); }
  if (id.startsWith('brp:addrole:') || id.startsWith('rrp:addrole:')) {
    const mode = id.startsWith('brp:') ? 'button' : 'reaction';
    const panelId = id.split(':')[2];
    const panel = db.findPanel(i.guildId, mode, panelId);
    if (!panel) return i.reply({ content: 'Not found.', ephemeral: true });
    const role = i.guild.roles.cache.get(roleId);
    if (mode === 'button') {
      const list = [...(panel.buttons || []).filter(b => b.roleId !== roleId), { roleId, label: role?.name || 'Role' }];
      db.upsertPanel(i.guildId, mode, { ...panel, buttons: list });
    } else {
      const modal = new ModalBuilder().setCustomId(`rrp:addrole:modal:${panelId}:${roleId}`).setTitle('Add Reaction Role');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emoji').setLabel('Emoji (unicode or <:name:id>)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)));
      return i.showModal(modal);
    }
    return i.update({ ...ui.rolePanelEmbed(db.findPanel(i.guildId, mode, panelId), mode), ephemeral: true });
  }
}

async function handleUserSelect(i) {
  const id = i.customId;
  const userId = i.values[0];
  if (id === 'ticket:add:select') {
    if (!db.getTicket(i.channel.id)) return i.reply({ content: 'Not a ticket.', ephemeral: true });
    await i.channel.permissionOverwrites.edit(userId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
    db.logTicketEvent(i.guildId, i.channel.id, i.user.id, 'add-user', userId);
    return i.update({ embeds: [ui.okEmbed('Added', `<@${userId}> now has access.`)], components: [] });
  }
  if (id === 'ticket:remove:select') {
    if (!db.getTicket(i.channel.id)) return i.reply({ content: 'Not a ticket.', ephemeral: true });
    await i.channel.permissionOverwrites.delete(userId).catch(() => {});
    db.logTicketEvent(i.guildId, i.channel.id, i.user.id, 'remove-user', userId);
    return i.update({ embeds: [ui.okEmbed('Removed', `<@${userId}> access revoked.`)], components: [] });
  }
}

// ================= MODALS =================
async function handleModal(i) {
  const id = i.customId;

  if (id === 'setup:restore:modal') {
    try {
      const payload = JSON.parse(i.fields.getTextInputValue('payload'));
      db.importGuild(i.guildId, payload);
      return i.reply({ embeds: [ui.okEmbed('Restored', 'Configuration restored.')], ephemeral: true });
    } catch (e) { return i.reply({ embeds: [ui.errEmbed('Failed', String(e.message))], ephemeral: true }); }
  }
  if (id === 'automod:words:modal') {
    const words = i.fields.getTextInputValue('words').split(',').map(x => x.trim()).filter(Boolean).slice(0, 500);
    db.saveConfig(i.guildId, { automod: { badWords: words } });
    sys.refreshAutomod(i.guildId);
    return i.reply({ embeds: [ui.okEmbed('Saved', `${words.length} word(s).`)], ephemeral: true });
  }
  if (id === 'badword:words:modal') {
    const words = i.fields.getTextInputValue('words').split(',').map(x => x.trim()).filter(Boolean).slice(0, 500);
    db.saveConfig(i.guildId, { antibadword: { customWords: words } });
    sys.refreshAutomod(i.guildId);
    return i.reply({ embeds: [ui.okEmbed('Saved', `${words.length} word(s).`)], ephemeral: true });
  }
  if (id === 'greetmsg:edit:modal') {
    db.saveConfig(i.guildId, { greetmessage: { title: i.fields.getTextInputValue('title') || 'Welcome', message: i.fields.getTextInputValue('message') } });
    return i.reply({ embeds: [ui.okEmbed('Saved', 'Greet message saved.')], ephemeral: true });
  }
  if (id === 'welcome:edit:modal' || id === 'leave:edit:modal') {
    const key = id.split(':')[0];
    db.saveConfig(i.guildId, { [key]: { message: i.fields.getTextInputValue('message') } });
    return i.reply({ embeds: [ui.okEmbed('Saved', 'Message updated.')], ephemeral: true });
  }
  if (id === 'leveling:rewards:modal') {
    const map = {};
    for (const pair of i.fields.getTextInputValue('rewards').split(',')) {
      const [l, r] = pair.split('=').map(s => s.trim());
      if (/^\d+$/.test(l) && /^\d{15,25}$/.test(r)) map[l] = r;
    }
    db.saveConfig(i.guildId, { leveling: { roleRewards: map } });
    return i.reply({ embeds: [ui.okEmbed('Saved', `${Object.keys(map).length} reward(s).`)], ephemeral: true });
  }
  if (id === 'leveling:xp:modal') {
    const xp = Math.max(1, Math.min(500, parseInt(i.fields.getTextInputValue('xp'), 10) || 15));
    const cd = Math.max(0, Math.min(3600, parseInt(i.fields.getTextInputValue('cd'), 10) || 60));
    db.saveConfig(i.guildId, { leveling: { xpPerMessage: xp, cooldownSeconds: cd } });
    return i.reply({ embeds: [ui.okEmbed('Saved', `XP: ${xp}, cooldown: ${cd}s.`)], ephemeral: true });
  }
  if (id === 'ar:add:modal' || id === 'arr:add:modal') {
    const key = id === 'ar:add:modal' ? 'autoresponder' : 'autoreactor';
    const match = i.fields.getTextInputValue('match').trim();
    const mode = /^exact$/i.test(i.fields.getTextInputValue('mode').trim()) ? 'exact' : 'contains';
    const cur = db.getConfig(i.guildId)[key];
    let trigger;
    if (key === 'autoresponder') {
      trigger = { id: Math.random().toString(36).slice(2, 10), match, mode, response: i.fields.getTextInputValue('response').trim() };
    } else {
      trigger = { id: Math.random().toString(36).slice(2, 10), match, mode, emojis: i.fields.getTextInputValue('emojis').trim().split(/\s+/).filter(Boolean).slice(0, 5) };
    }
    db.saveConfig(i.guildId, { [key]: { triggers: [...(cur.triggers || []), trigger] } });
    return i.reply({ embeds: [ui.okEmbed('Saved', 'Trigger added.')], ephemeral: true });
  }
  if (id.startsWith('brp:edit:modal:') || id.startsWith('rrp:edit:modal:')) {
    const mode = id.startsWith('brp:') ? 'button' : 'reaction';
    const panelId = id.split(':')[3];
    const panel = db.findPanel(i.guildId, mode, panelId);
    if (!panel) return i.reply({ content: 'Not found.', ephemeral: true });
    db.upsertPanel(i.guildId, mode, { ...panel, title: i.fields.getTextInputValue('title'), description: i.fields.getTextInputValue('description') });
    return i.reply({ embeds: [ui.okEmbed('Saved', 'Panel updated.')], ephemeral: true });
  }
  if (id.startsWith('rrp:addrole:modal:')) {
    const [, , , panelId, roleId] = id.split(':');
    const panel = db.findPanel(i.guildId, 'reaction', panelId);
    if (!panel) return i.reply({ content: 'Not found.', ephemeral: true });
    const emoji = i.fields.getTextInputValue('emoji').trim();
    const list = [...(panel.mappings || []).filter(m => m.roleId !== roleId), { roleId, emoji }];
    db.upsertPanel(i.guildId, 'reaction', { ...panel, mappings: list });
    return i.reply({ embeds: [ui.okEmbed('Added', 'Mapping added.')], ephemeral: true });
  }
  if (id === 'ticket:rename:modal') {
    const t = db.getTicket(i.channel.id);
    if (!t) return i.reply({ content: 'Not a ticket.', ephemeral: true });
    const name = i.fields.getTextInputValue('name').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90);
    if (!name) return i.reply({ embeds: [ui.errEmbed('Invalid', 'Name empty after cleaning.')], ephemeral: true });
    await i.channel.setName(name);
    db.logTicketEvent(i.guildId, i.channel.id, i.user.id, 'rename', name);
    return i.reply({ embeds: [ui.okEmbed('Renamed', `Channel renamed to \`${name}\`.`)], ephemeral: true });
  }
  if (id === 'vm:rename:modal') {
    const vc = i.member.voice.channel;
    if (!vc) return i.reply({ content: 'Not in voice.', ephemeral: true });
    const rec = db.getVMChannel(vc.id);
    if (!rec || rec.ownerId !== i.user.id) return i.reply({ content: 'Not allowed.', ephemeral: true });
    const name = i.fields.getTextInputValue('name').trim().slice(0, 90);
    await vc.setName(name).catch(() => {});
    return i.reply({ embeds: [ui.okEmbed('Renamed', `Channel is now **${name}**.`)], ephemeral: true });
  }
  if (id === 'vm:limit:modal') {
    const vc = i.member.voice.channel;
    if (!vc) return i.reply({ content: 'Not in voice.', ephemeral: true });
    const rec = db.getVMChannel(vc.id);
    if (!rec || rec.ownerId !== i.user.id) return i.reply({ content: 'Not allowed.', ephemeral: true });
    const limit = Math.max(0, Math.min(99, parseInt(i.fields.getTextInputValue('limit'), 10) || 0));
    await vc.setUserLimit(limit).catch(() => {});
    return i.reply({ embeds: [ui.okEmbed('Set', `User limit: ${limit}.`)], ephemeral: true });
  }
  if (id === 'vm:transfer:modal') {
    const vc = i.member.voice.channel;
    if (!vc) return i.reply({ content: 'Not in voice.', ephemeral: true });
    const rec = db.getVMChannel(vc.id);
    if (!rec || rec.ownerId !== i.user.id) return i.reply({ content: 'Not allowed.', ephemeral: true });
    const userId = i.fields.getTextInputValue('userId').trim();
    if (!/^\d{15,25}$/.test(userId)) return i.reply({ embeds: [ui.errEmbed('Invalid', 'Not a valid ID.')], ephemeral: true });
    db.removeVMChannel(vc.id);
    db.addVMChannel(vc.id, i.guildId, userId);
    return i.reply({ embeds: [ui.okEmbed('Transferred', `Ownership → <@${userId}>.`)], ephemeral: true });
  }
  if (id === 'vm:cfg:name:modal') {
    db.saveConfig(i.guildId, { voicemaster: { nameTemplate: i.fields.getTextInputValue('tpl').trim().slice(0, 90) || "{user}'s room" } });
    return i.reply({ embeds: [ui.okEmbed('Saved', 'Name template saved.')], ephemeral: true });
  }
  if (id === 'bday:set:modal') {
    const raw = i.fields.getTextInputValue('date').trim().replace(/\s+/g, '');
    const m = raw.match(/^(\d{1,2})[-\/.](\d{1,2})$/);
    if (!m) return i.reply({ embeds: [ui.errEmbed('Invalid', 'Use DD-MM.')], ephemeral: true });
    const [day, month] = [Number(m[1]), Number(m[2])];
    const check = new Date(Date.UTC(2000, month - 1, day));
    if (check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return i.reply({ embeds: [ui.errEmbed('Invalid', 'Not a real date.')], ephemeral: true });
    db.setBirthday(i.guildId, i.user.id, month, day);
    return i.reply({ embeds: [ui.okEmbed('Saved', `Your birthday is **${day}-${month}**.`)], ephemeral: true });
  }
  if (id === 'bday:cfg:message:modal') {
    db.saveConfig(i.guildId, { birthdays: { wishMessage: i.fields.getTextInputValue('msg') } });
    return i.reply({ embeds: [ui.okEmbed('Saved', 'Message updated.')], ephemeral: true });
  }
  if (id === 'app:cfg:questions:modal') {
    const questions = i.fields.getTextInputValue('q').split('\n').map(x => x.trim()).filter(Boolean).slice(0, 10);
    db.saveConfig(i.guildId, { staffApplications: { questions } });
    return i.reply({ embeds: [ui.okEmbed('Saved', `${questions.length} question(s).`)], ephemeral: true });
  }
  if (id === 'staffapp:submit:modal') {
    const cfg = db.getConfig(i.guildId).staffApplications;
    if (!cfg.enabled || !(cfg.questions || []).length) return i.reply({ embeds: [ui.errEmbed('Unavailable', 'Applications closed.')], ephemeral: true });
    if (db.pendingApplicationForUser(i.guildId, i.user.id)) return i.reply({ embeds: [ui.warnEmbed('Pending', 'Already applied.')], ephemeral: true });
    const answers = [];
    for (let n = 0; n < Math.min(cfg.questions.length, 5); n++) {
      try { answers.push(i.fields.getTextInputValue(`q${n}`)); } catch { answers.push(''); }
    }
    const app = db.createApplication(i.guildId, i.user.id, answers);
    if (cfg.logChannelId) {
      const ch = i.guild.channels.cache.get(cfg.logChannelId);
      if (ch?.isTextBased()) {
        const e = ui.embed(`Application #${app.id}`, `**Applicant:** ${i.user} (\`${i.user.id}\`)`).addFields(
          cfg.questions.slice(0, 5).map((q, n) => ({ name: `${n + 1}. ${q.slice(0, 200)}`, value: (answers[n] || '—').slice(0, 1000), inline: false }))
        );
        const row = ui.row(
          ui.btn(`app:review:accepted:${app.id}`, 'Accept', ButtonStyle.Success),
          ui.btn(`app:review:denied:${app.id}`, 'Deny', ButtonStyle.Danger)
        );
        ch.send({ embeds: [e], components: [row] }).catch(() => {});
      }
    }
    return i.reply({ embeds: [ui.okEmbed('Submitted', `Application #${app.id} sent to staff.`)], ephemeral: true });
  }
  if (id === 'eb:build:modal') {
    const title = i.fields.getTextInputValue('title');
    const description = i.fields.getTextInputValue('description');
    const colorRaw = i.fields.getTextInputValue('color');
    const channelRaw = i.fields.getTextInputValue('channel');
    let color;
    if (colorRaw) { color = cmd.parseColor(colorRaw); if (color === null) return i.reply({ content: 'Invalid color.', ephemeral: true }); }
    const chId = channelRaw.replace(/[<#>]/g, '');
    const ch = i.guild.channels.cache.get(chId);
    if (!ch?.isTextBased()) return i.reply({ content: 'Channel not found.', ephemeral: true });
    const e = new EmbedBuilder().setColor(color ?? ui.BLACK).setDescription(description).setTimestamp();
    if (title) e.setTitle(title);
    await ch.send({ embeds: [e] }).catch(() => {});
    return i.reply({ embeds: [ui.okEmbed('Posted', `Embed posted in ${ch}.`)], ephemeral: true });
  }
}

// ================= MESSAGE EVENTS =================
client.on('messageCreate', async message => {
  try {
    if (!message.guild || message.author.bot) return;
    const cfg = db.getConfig(message.guild.id);

    // Ping reply
    if (message.mentions.users.has(client.user.id) && !message.mentions.everyone && message.content.trim().startsWith('<@')) {
      const prefix = cfg.prefix || '!';
      return message.reply({ embeds: [ui.embed(`🤖 ${client.user.username}`, `Welcome to **${message.guild.name}**!\n\nStart with **${prefix}help** or **/help**.\n**Prefix:** \`${prefix}\`\n**Ping:** \`${client.ws.ping}ms\``)] }).catch(() => {});
    }
    if (db.getGlobalBlacklist().includes(message.guild.ownerId)) return;

    // Automod (single authoritative path)
    const blocked = await sys.runAutomod(message).catch(e => { console.error('[automod]', e?.message); return false; });
    if (blocked) return;

    // Leveling
    await sys.handleLevelingMessage(message).catch(() => {});

    // Autoresponder
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

    // Honeypot
    const hp = cfg.honeypot;
    if (hp.enabled && hp.channelId === message.channel.id && message.author.id !== message.guild.ownerId) {
      const whitelisted = (hp.whitelistRoleIds || []).some(r => message.member?.roles.cache.has(r));
      if (!whitelisted) {
        await message.delete().catch(() => {});
        await sys.logSecurity(message.guild, { action: '🍯 Honeypot Triggered', target: message.author, outcome: hp.action });
        const member = await message.guild.members.fetch(message.author.id).catch(() => null);
        if (member) {
          if (hp.action === 'kick') await member.kick('Honeypot').catch(() => {});
          else if (hp.action === 'ban') await member.ban({ reason: 'Honeypot' }).catch(() => {});
          else if (hp.action === 'timeout') await member.timeout(10 * 60000, 'Honeypot').catch(() => {});
        }
      }
    }

    // Sticky message repost
    const sticky = db.getSticky(message.channel.id);
    if (sticky?.enabled) scheduleStickyRepost(message.channel.id);
  } catch (e) {
    await logError(e, 'messageCreate', { guildId: message.guildId, userId: message.author?.id });
  }
});

// Sticky repost engine
const stickyQueues = new Map();
function scheduleStickyRepost(channelId) {
  let q = stickyQueues.get(channelId);
  if (q?.running) { q.dirty = true; return; }
  if (q) clearTimeout(q.timer);
  q = { running: false, dirty: false, timer: null };
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
        const e = new EmbedBuilder().setColor(row.data.color ?? ui.BLACK).setTimestamp();
        if (row.data.title) e.setTitle(row.data.title);
        if (row.data.description) e.setDescription(row.data.description);
        const sent = await channel.send({ embeds: [e] }).catch(() => null);
        if (sent) db.setStickyMessageId(channelId, sent.id);
      } while (q.dirty);
    } catch (e) { console.error('[sticky]', e?.message); }
    q.running = false;
    stickyQueues.delete(channelId);
  }, 1500);
  q.timer.unref?.();
}

// ================= MESSAGE DELETE / UPDATE =================
client.on('messageDelete', async message => {
  try {
    if (!message.guild || message.author?.bot) return;
    const attachments = [...(message.attachments?.values?.() || [])].map(a => ({ name: a.name, url: a.url }));
    db.addSnipe({
      guildId: message.guild.id, channelId: message.channel.id, messageId: message.id,
      authorId: message.author.id, authorTag: message.author.tag, action: 'delete',
      content: message.content || '', attachments,
      jumpUrl: `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`
    });
    // Try to attribute deletion via audit log (limited — self-deletes are not attributed)
    const exec = await sys.auditExecutor(message.guild, AuditLogEvent.MessageDelete, message.author.id);
    await sys.logMessage(message.guild, {
      action: 'delete', author: message.author, channel: message.channel,
      content: message.content || '', attachments,
      jumpUrl: `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`,
      executor: exec || null
    });
  } catch (e) { await logError(e, 'messageDelete', { guildId: message.guild?.id }); }
});

client.on('messageUpdate', async (oldMsg, newMsg) => {
  try {
    if (!newMsg.guild || newMsg.author?.bot) return;
    if (oldMsg.content === newMsg.content) return;
    db.addSnipe({
      guildId: newMsg.guild.id, channelId: newMsg.channel.id, messageId: newMsg.id,
      authorId: newMsg.author.id, authorTag: newMsg.author.tag, action: 'edit',
      content: oldMsg.content || '', newContent: newMsg.content || '',
      jumpUrl: `https://discord.com/channels/${newMsg.guild.id}/${newMsg.channel.id}/${newMsg.id}`
    });
    await sys.logMessage(newMsg.guild, {
      action: 'edit', author: newMsg.author, channel: newMsg.channel,
      content: oldMsg.content || '', newContent: newMsg.content || '',
      jumpUrl: `https://discord.com/channels/${newMsg.guild.id}/${newMsg.channel.id}/${newMsg.id}`
    });
  } catch (e) { await logError(e, 'messageUpdate', { guildId: newMsg.guild?.id }); }
});

// ================= MEMBER EVENTS =================
client.on('guildMemberAdd', async member => {
  try {
    // Parallel security — was sequential
    await Promise.allSettled([
      sys.handleAntiBotJoin(member),
      sys.handleAntiAltJoin(member),
      sys.handleAntiraidJoin(member)
    ]);
    const cfg = db.getConfig(member.guild.id);

    if (cfg.greetmessage.enabled && cfg.greetmessage.channelId) {
      const ch = member.guild.channels.cache.get(cfg.greetmessage.channelId);
      if (ch?.isTextBased()) {
        const text = sys.applyTemplate(cfg.greetmessage.message, { user: `<@${member.id}>`, username: member.user.username, server: member.guild.name, count: member.guild.memberCount });
        const e = new EmbedBuilder().setColor(ui.BLACK).setDescription(text).setTimestamp();
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
        await ch.send({ embeds: [ui.okEmbed(null, text)], allowedMentions: { parse: [] } }).catch(() => {});
      }
    }
    if (cfg.autorole.enabled && cfg.autorole.roleId) {
      const target = cfg.autorole.target || 'everyone';
      if ((target === 'everyone') || (target === 'bots' && member.user.bot) || (target === 'humans' && !member.user.bot)) {
        const role = member.guild.roles.cache.get(cfg.autorole.roleId);
        const me = member.guild.members.me;
        if (role && me && role.position < me.roles.highest.position) await member.roles.add(role).catch(() => {});
      }
    }
    const sticky = db.getStickyRoles(member.guild.id, member.id);
    if (sticky.length) {
      const me = member.guild.members.me;
      const valid = sticky.filter(r => { const role = member.guild.roles.cache.get(r); return role && role.position < me.roles.highest.position; });
      if (valid.length) await member.roles.add(valid).catch(() => {});
    }
    await sys.logMember(member.guild, { action: '📥 Member Joined', target: member.user, extra: { Account: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>` } });
  } catch (e) { await logError(e, 'guildMemberAdd', { guildId: member.guild?.id }); }
});

client.on('guildMemberRemove', async member => {
  try {
    const cfg = db.getConfig(member.guild.id);
    if (cfg.leave.enabled && cfg.leave.channel) {
      const ch = member.guild.channels.cache.get(cfg.leave.channel);
      if (ch?.isTextBased()) {
        const text = sys.applyTemplate(cfg.leave.message, { user: member.user.tag, server: member.guild.name });
        await ch.send({ embeds: [ui.warnEmbed(null, text)], allowedMentions: { parse: [] } }).catch(() => {});
      }
    }
    if (member.roles?.cache?.size) db.setStickyRoles(member.guild.id, member.id, member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.id));
    await sys.logMember(member.guild, { action: '📤 Member Left', target: member.user });
  } catch (e) { await logError(e, 'guildMemberRemove', { guildId: member.guild?.id }); }
});

client.on('guildMemberUpdate', async (oldM, newM) => {
  try {
    if (oldM.nickname !== newM.nickname) {
      await sys.logMember(newM.guild, { action: 'Nickname Changed', target: newM.user, extra: { Before: oldM.nickname || '—', After: newM.nickname || '—' } });
    }
    const added = newM.roles.cache.filter(r => !oldM.roles.cache.has(r.id));
    const removed = oldM.roles.cache.filter(r => !newM.roles.cache.has(r.id));
    if (added.size || removed.size) {
      await sys.logMember(newM.guild, {
        action: 'Roles Updated',
        target: newM.user,
        extra: {
          Added: added.size ? added.map(r => `<@&${r.id}>`).join(', ').slice(0, 500) : '—',
          Removed: removed.size ? removed.map(r => `<@&${r.id}>`).join(', ').slice(0, 500) : '—'
        }
      });
    }
    if (!oldM.premiumSince && newM.premiumSince) {
      const cfg = db.getConfig(newM.guild.id).boost;
      if (cfg.enabled && cfg.channel) {
        const ch = newM.guild.channels.cache.get(cfg.channel);
        if (ch?.isTextBased()) ch.send({ content: sys.applyTemplate(cfg.message, { user: `<@${newM.id}>` }) }).catch(() => {});
      }
    }
  } catch (e) { await logError(e, 'guildMemberUpdate', { guildId: newM.guild?.id }); }
});

// ================= AUDIT-LOG EVENTS =================
client.on('channelCreate', async ch => {
  if (!ch.guild) return;
  const exec = await sys.auditExecutor(ch.guild, AuditLogEvent.ChannelCreate, ch.id);
  if (exec) await sys.antinukeStrike(ch.guild, exec.id, 'channelCreate').catch(() => {});
  await sys.logServer(ch.guild, { action: 'Channel Created', fields: [
    { name: 'Channel', value: `${ch}`, inline: true },
    { name: 'Type', value: String(ch.type), inline: true },
    ...(exec ? [{ name: 'Executor', value: `<@${exec.id}>`, inline: true }] : [])
  ]});
});
client.on('channelDelete', async ch => {
  if (!ch.guild) return;
  const exec = await sys.auditExecutor(ch.guild, AuditLogEvent.ChannelDelete, ch.id);
  if (exec) await sys.antinukeStrike(ch.guild, exec.id, 'channelDelete').catch(() => {});
  await sys.logServer(ch.guild, { action: 'Channel Deleted', fields: [
    { name: 'Name', value: ch.name || '—', inline: true },
    { name: 'Type', value: String(ch.type), inline: true },
    ...(exec ? [{ name: 'Executor', value: `<@${exec.id}>`, inline: true }] : [])
  ]});
});
client.on('roleCreate', async role => {
  const exec = await sys.auditExecutor(role.guild, AuditLogEvent.RoleCreate, role.id);
  if (exec) await sys.antinukeStrike(role.guild, exec.id, 'roleCreate').catch(() => {});
  await sys.logServer(role.guild, { action: 'Role Created', fields: [
    { name: 'Name', value: role.name, inline: true },
    ...(exec ? [{ name: 'Executor', value: `<@${exec.id}>`, inline: true }] : [])
  ]});
});
client.on('roleDelete', async role => {
  const exec = await sys.auditExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
  if (exec) await sys.antinukeStrike(role.guild, exec.id, 'roleDelete').catch(() => {});
  await sys.logServer(role.guild, { action: 'Role Deleted', fields: [
    { name: 'Name', value: role.name, inline: true },
    ...(exec ? [{ name: 'Executor', value: `<@${exec.id}>`, inline: true }] : [])
  ]});
});
client.on('guildBanAdd', async ban => {
  const exec = await sys.auditExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  if (exec) await sys.antinukeStrike(ban.guild, exec.id, 'ban').catch(() => {});
  await sys.logMod(ban.guild, { action: '🔨 Member Banned', target: ban.user, moderator: exec });
});
client.on('guildBanRemove', async ban => {
  const exec = await sys.auditExecutor(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
  await sys.logMod(ban.guild, { action: '✅ Member Unbanned', target: ban.user, moderator: exec });
});
client.on('webhookUpdate', async channel => {
  await sys.handleAntiWebhookCreate(channel).catch(() => {});
});

// ================= VOICE =================
client.on('voiceStateUpdate', async (oldS, newS) => {
  try {
    await sys.handleVoicemasterJoin(oldS, newS).catch(() => {});
    const member = newS.member;
    if (!member || member.user.bot) return;
    if (oldS.channelId !== newS.channelId) {
      if (!oldS.channelId && newS.channelId) await sys.logVoice(newS.guild, { action: 'Joined Voice', member: member.user, to: newS.channelId });
      else if (oldS.channelId && !newS.channelId) await sys.logVoice(oldS.guild, { action: 'Left Voice', member: member.user, from: oldS.channelId });
      else await sys.logVoice(newS.guild, { action: 'Moved Voice', member: member.user, from: oldS.channelId, to: newS.channelId });
    }
  } catch (e) { console.error('[voice]', e?.message); }
});

// ================= SHUTDOWN =================
async function shutdown(sig) {
  console.log(`\n${sig} received — shutting down.`);
  try { await client.destroy(); } catch {}
  try { db.db.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ================= LOGIN =================
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Login failed:', err.message);
  process.exit(1);
});