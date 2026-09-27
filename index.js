// index.js — boots the client, registers slash commands, and wires every Discord event
// to the systems/commands/ui modules. This is the only file that touches gateway events.

require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  ChannelType, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, PermissionFlagsBits,
  AuditLogEvent
} = require('discord.js');

const db = require('./database');
const ui = require('./ui');
const sys = require('./systems');
const { commands, isOwner, buildModulePatch, PANEL_MODULES } = require('./commands');

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



function wrapInteraction(interaction) {
  const methods = new Set(['reply', 'update', 'followUp', 'editReply']);
  return new Proxy(interaction, {
    get(target, prop, receiver) {
      if (methods.has(prop)) {
        return (...args) => {
          if (args.length && args[0] && typeof args[0] === 'object') {
            args[0] = ui.toComponentsV2(args[0]);
          }
          return target[prop](...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

// ---------------------------------------------------------------------------------
// Slash command registration
// ---------------------------------------------------------------------------------
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const publicBody = commands.filter(c => !c.ownerOnly).map(c => c.data.toJSON());
  const ownerBody = commands.filter(c => c.ownerOnly).map(c => c.data.toJSON());

  // Public commands go out globally so every server the bot is in gets them (takes up to ~1h to
  // propagate on first deploy; instant after that on updates within the same command set).
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: publicBody });
  console.log(`Registered ${publicBody.length} global commands.`);

  // Owner-only commands are deliberately NOT registered globally — they're guild-scoped to a
  // single "home" server (OWNER_GUILD_ID, falling back to GUILD_ID for backward compatibility)
  // so they don't show up as slash commands in every server the bot joins. They're still usable
  // everywhere as text commands (<prefix>eval ..., <prefix>maintenance ...) since execute()
  // itself checks isOwner() regardless of how it was invoked.
  const ownerGuildId = process.env.OWNER_GUILD_ID || process.env.GUILD_ID;
  if (ownerGuildId && ownerBody.length) {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, ownerGuildId), { body: ownerBody });
    console.log(`Registered ${ownerBody.length} owner-only commands to guild ${ownerGuildId}.`);
  } else if (ownerBody.length) {
    console.log(`OWNER_GUILD_ID not set — ${ownerBody.length} owner-only command(s) not registered as slash commands (still usable as text commands, e.g. !eval).`);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity('/help');
  try { await registerCommands(); } catch (e) { console.error('Command registration failed:', e); }
});

// ---------------------------------------------------------------------------------
// Text-command engine — "<prefix> <cmd> ..." runs the exact same execute(interaction)
// handlers as slash commands, via a small adapter that mimics the ChatInputCommandInteraction
// surface those handlers use (options.getX, reply, member, guild, etc).
// ---------------------------------------------------------------------------------
const OPT = { SUBCOMMAND: 1, SUBCOMMAND_GROUP: 2, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7, ROLE: 8, MENTIONABLE: 9, NUMBER: 10 };

function tokenize(str) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

// Walks a command's option tree to find which subcommand/group (if any) the user typed,
// consuming those tokens, and returns the flat list of leaf (non-subcommand) options left to fill.
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
    default: return raw; // STRING and anything else passes through as text
  }
}

// Positionally fills leaf options from tokens. The last option, if it's a STRING, greedily
// swallows every remaining token (so reasons/messages/prompts don't need quotes).
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
    reply: async (payload) => { fake.replied = true; return message.reply(stripEphemeral(ui.toComponentsV2(payload))); },
    followUp: async (payload) => message.channel.send(stripEphemeral(ui.toComponentsV2(payload))),
    editReply: async (payload) => message.channel.send(stripEphemeral(ui.toComponentsV2(payload))),
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
    message.reply(ui.toComponentsV2({ embeds: [ui.errorEmbed('Invalid Usage', usageLines(prefix, json).map(l => `\`${l}\``).join('\n'))] })).catch(() => {});
    return true;
  }
  try {
    await cmd.execute(fake);
  } catch (e) {
    console.error(e);
    message.reply(ui.toComponentsV2({ embeds: [ui.errorEmbed('Error', 'Something went wrong running that.')] })).catch(() => {});
  }
  return true;
}

const SETUP_MODAL_SPECS = {
  antinuke: { punishment: [{ id:'value', label:'Punishment', value:c=>c.antinuke.punishment }], threshold:[{id:'value',label:'Action threshold',value:c=>String(c.antinuke.maxBans)}], window_seconds:[{id:'value',label:'Time window (seconds)',value:c=>String(c.antinuke.windowSeconds)}] },
  antilink: { mode:[{id:'value',label:'Link action',value:c=>c.antilink.mode}] },
  antispam: { max_messages:[{id:'value',label:'Max messages',value:c=>String(c.antispam.maxMessages)}], window_seconds:[{id:'value',label:'Window seconds',value:c=>String(c.antispam.windowSeconds)}], punishment:[{id:'value',label:'Spam action',value:c=>c.antispam.punishment}] },
  antiraid: { join_threshold:[{id:'value',label:'Join threshold',value:c=>String(c.antiraid.joinThreshold)}], window_seconds:[{id:'value',label:'Window seconds',value:c=>String(c.antiraid.windowSeconds)}], min_account_age_days:[{id:'value',label:'Minimum account age (days)',value:c=>String(c.antiraid.minAccountAgeDays)}], action:[{id:'value',label:'Raid action',value:c=>c.antiraid.action}] },
  greetmessage: { message:[{id:'value',label:'Welcome message',style:TextInputStyle.Paragraph,value:c=>c.greetmessage.message||''}], image:[{id:'value',label:'Image/GIF URL',value:c=>c.greetmessage.image||''}] },
  leveling: { xp_per_message:[{id:'value',label:'XP per message',value:c=>String(c.leveling.xpPerMessage)}], cooldown_seconds:[{id:'value',label:'Cooldown seconds',value:c=>String(c.leveling.cooldownSeconds)}] },
  tickets: {
    panel_text:[{id:'title',label:'Panel title',value:c=>c.ticket.panelTitle||''},{id:'description',label:'Panel message',style:TextInputStyle.Paragraph,value:c=>c.ticket.panelDescription||''}],
    panel_media:[{id:'thumbnail',label:'Panel thumbnail URL',value:c=>c.ticket.panelThumbnail||''},{id:'image',label:'Panel banner URL',value:c=>c.ticket.panelImage||''}],
    welcome_text:[{id:'category',label:'Ticket category label',value:c=>c.ticket.categoryLabel||''},{id:'message',label:'Welcome message',style:TextInputStyle.Paragraph,value:c=>c.ticket.welcomeMessage||''}],
    welcome_media:[{id:'thumbnail',label:'Welcome thumbnail URL',value:c=>c.ticket.welcomeThumbnail||''},{id:'image',label:'Welcome banner URL',value:c=>c.ticket.welcomeImage||''}]
  }
};

function setupChannelSelect(interaction, sub, field) {
  const menu=new ChannelSelectMenuBuilder().setCustomId(`setup_channel_pick:${sub}:${field}`).setPlaceholder('Select a channel…');
  if(field==='hub_channel') menu.setChannelTypes(ChannelType.GuildVoice);
  else if(field==='category') menu.setChannelTypes(ChannelType.GuildCategory);
  else menu.setChannelTypes(ChannelType.GuildText);
  return interaction.reply({embeds:[ui.base(`${ui.emoji('settings')} Select ${field.replace(/_/g,' ')}`).setDescription('Pick the Discord channel below. No IDs to copy or paste.')],components:[new ActionRowBuilder().addComponents(menu)],ephemeral:true});
}
function setupRoleSelect(interaction, sub, field) {
  const menu=new RoleSelectMenuBuilder().setCustomId(`setup_role_pick:${sub}:${field}`).setPlaceholder('Select a role…');
  return interaction.reply({embeds:[ui.base(`${ui.emoji('settings')} Select role`).setDescription('Pick the role below. No role IDs to copy or paste.')],components:[new ActionRowBuilder().addComponents(menu)],ephemeral:true});
}
async function openSimpleSetupSetting(interaction,sub,setting){
  if(['hub_channel','category','channel','log_channel'].includes(setting)) return setupChannelSelect(interaction,sub,setting);
  if(['bypass_role','support_role'].includes(setting)) return setupRoleSelect(interaction,sub,setting);
  const spec=SETUP_MODAL_SPECS[sub]?.[setting];
  if(!spec) return interaction.reply({embeds:[ui.errorEmbed('Unavailable','That setting is not available here.')],ephemeral:true});
  const cfg=db.getConfig(interaction.guildId); const modal=new ModalBuilder().setCustomId(`setup_setting_modal:${sub}:${setting}`).setTitle(`Edit ${ui.SETUP_MODULE_META[sub].title}`);
  for(const f of spec){const input=new TextInputBuilder().setCustomId(f.id).setLabel(f.label.slice(0,45)).setStyle(f.style||TextInputStyle.Short).setRequired(false);const v=f.value(cfg);if(v)input.setValue(String(v).slice(0,4000));modal.addComponents(new ActionRowBuilder().addComponents(input));}
  return interaction.showModal(modal);
}
async function openTicketConfigSetting(interaction,setting){
  if(setting==='preview'){const cfg=db.getConfig(interaction.guildId).ticket;return interaction.update({embeds:[ui.ticketPanelEmbed(interaction.guild.name,cfg),ui.ticketWelcomeEmbed(interaction.user,cfg)],components:ui.ticketConfigRow()});}
  return openSimpleSetupSetting(interaction,'tickets',setting);
}

// ---------------------------------------------------------------------------------
// interactionCreate — slash commands, buttons, select menus, modals
// ---------------------------------------------------------------------------------
client.on('interactionCreate', async (rawInteraction) => {
  const interaction = wrapInteraction(rawInteraction);
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

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('setup_setting:')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need Administrator to change setup settings.')], ephemeral: true });
      return openSimpleSetupSetting(interaction, interaction.customId.split(':')[1], interaction.values[0]);
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticketconfig_setting') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need Administrator to change ticket settings.')], ephemeral: true });
      return openTicketConfigSetting(interaction, interaction.values[0]);
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'vm_kick_pick') return handleVMKickPick(interaction);

    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('setup_channel_pick:')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need Administrator to change setup settings.')], ephemeral: true });
      const [,sub,field]=interaction.customId.split(':'); const id=interaction.values[0];
      const map={hub_channel:{key:'voicemaster',prop:'hubChannelId'},category:sub==='voicemaster'?{key:'voicemaster',prop:'categoryId'}:sub==='tickets'?{key:'ticket',prop:'categoryId'}:null,channel:{key:sub,prop:sub==='leveling'?'channel':'channelId'},log_channel:{key:'ticket',prop:'logChannelId'}}; const target=map[field];
      if(!target) return interaction.reply({embeds:[ui.errorEmbed('Unavailable','That channel setting is not available.')],ephemeral:true});
      const cfg=db.saveConfig(interaction.guildId,{[target.key]:{[target.prop]:id}}); return interaction.update({embeds:[ui.setupPanelEmbed(sub,cfg)],components:ui.setupPanelRow(sub,cfg)});
    }
    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('setup_role_pick:')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need Administrator to change setup settings.')], ephemeral: true });
      const [,sub,field]=interaction.customId.split(':'); const id=interaction.values[0]; const map={bypass_role:{key:'antilink',prop:'bypassRoleId'},support_role:{key:'ticket',prop:'supportRoleId'}}; const target=map[field];
      if(!target) return interaction.reply({embeds:[ui.errorEmbed('Unavailable','That role setting is not available.')],ephemeral:true});
      const cfg=db.saveConfig(interaction.guildId,{[target.key]:{[target.prop]:id}}); return interaction.update({embeds:[ui.setupPanelEmbed(sub,cfg)],components:ui.setupPanelRow(sub,cfg)});
    }

    if (interaction.isChannelSelectMenu() && interaction.customId === 'vm_setup_category_select') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to use this.')], ephemeral: true });
      }
      const cfg = db.saveConfig(interaction.guildId, { voicemaster: { categoryId: interaction.values[0] } });
      return interaction.update({ embeds: [ui.vmSetupEmbed(cfg)], components: [ui.vmSetupRow(cfg)] });
    }
    if (interaction.isChannelSelectMenu() && interaction.customId === 'vm_setup_channel_select') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to use this.')], ephemeral: true });
      }
      const cfg = db.saveConfig(interaction.guildId, { voicemaster: { hubChannelId: interaction.values[0] } });
      return interaction.update({ embeds: [ui.vmSetupEmbed(cfg)], components: [ui.vmSetupRow(cfg)] });
    }
    if (interaction.isUserSelectMenu() && interaction.customId === 'ticket_addmember_select') return handleTicketMemberSelect(interaction, 'add');
    if (interaction.isUserSelectMenu() && interaction.customId === 'ticket_removemember_select') return handleTicketMemberSelect(interaction, 'remove');

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
    if (!cfg.enabled) return interaction.reply({ embeds: [ui.errorEmbed('Tickets Disabled', 'Ask an admin to run `/tickets setup`.')], ephemeral: true });
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
    await channel.send({ embeds: [ui.ticketWelcomeEmbed(interaction.user, cfg)], components: [ui.ticketControlRow()] });
    return interaction.reply({ embeds: [ui.okEmbed('🎫 Ticket Created', `Opened ${channel}.`)], ephemeral: true });
  }
  if (id === 'staff_controls') {
    const ticket = db.getTicket(interaction.channel.id);
    if (!ticket) return interaction.reply({ embeds: [ui.errorEmbed('Not a Ticket', 'This only works inside a ticket channel.')], ephemeral: true });
    const ticketCfg = db.getConfig(interaction.guildId).ticket;
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    const hasRole = ticketCfg.supportRoleId && interaction.member.roles.cache.has(ticketCfg.supportRoleId);
    if (!isAdmin && !hasRole) return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need the support role or Administrator.')], ephemeral: true });
    return interaction.reply({ embeds: [ui.staffControlsEmbed(ticket)], components: ui.staffControlsRow(!!ticket.claimedBy), ephemeral: true });
  }
  if (id === 'staff_claim' || id === 'staff_unclaim') {
    const ticket = db.getTicket(interaction.channel.id);
    if (!ticket) return interaction.reply({ embeds: [ui.errorEmbed('Not a Ticket', 'This only works inside a ticket channel.')], ephemeral: true });
    const claiming = !ticket.claimedBy;
    db.setTicketStatus(interaction.channel.id, ticket.status, claiming ? interaction.user.id : null);
    // "unclaim" clears claimedBy explicitly since setTicketStatus's COALESCE won't null it out.
    if (!claiming) db.db.prepare('UPDATE tickets SET claimedBy = NULL WHERE channelId = ?').run(interaction.channel.id);
    const updated = db.getTicket(interaction.channel.id);
    await interaction.update({ embeds: [ui.staffControlsEmbed(updated)], components: ui.staffControlsRow(!!updated.claimedBy) });
    return interaction.followUp({ embeds: [ui.okEmbed(claiming ? '🙋 Ticket Claimed' : '↩️ Ticket Unclaimed', claiming ? `${interaction.user} claimed this ticket.` : `${interaction.user} unclaimed this ticket.`)] });
  }
  if (id === 'staff_addmember' || id === 'staff_removemember') {
    const action = id === 'staff_addmember' ? 'add' : 'remove';
    return interaction.reply({ embeds: [ui.ticketMemberPromptEmbed(action)], components: [ui.ticketMemberSelectRow(action)], ephemeral: true });
  }
  if (id === 'staff_delete') {
    const ticket = db.getTicket(interaction.channel.id);
    db.setTicketStatus(interaction.channel.id, 'closed');
    await interaction.reply({ embeds: [ui.warnEmbed('🗑️ Deleting Ticket', 'This channel is being deleted now.')] });
    const ticketCfg = db.getConfig(interaction.guildId).ticket;
    if (ticketCfg.logChannelId) {
      const log = interaction.guild.channels.cache.get(ticketCfg.logChannelId);
      if (log) log.send({ embeds: [ui.base('🗑️ Ticket Deleted').setDescription(`Ticket by <@${ticket?.userId}> deleted by ${interaction.user}.`)] }).catch(() => {});
    }
    setTimeout(() => interaction.channel.delete().catch(() => {}), 1500);
    return;
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

  // ---- Voicemaster: dedicated setup panel (admin-only, from /voicemaster setup) ----
  if (id === 'vm_setup_category' || id === 'vm_setup_channel' || id === 'vm_setup_toggle') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to use this.')], ephemeral: true });
    }
    if (id === 'vm_setup_category') return interaction.reply({ embeds: [ui.vmCategoryPromptEmbed()], components: [ui.vmCategorySelectRow()], ephemeral: true });
    if (id === 'vm_setup_channel') return interaction.reply({ embeds: [ui.vmChannelPromptEmbed()], components: [ui.vmChannelSelectRow()], ephemeral: true });
    // toggle
    const current = db.getConfig(interaction.guildId).voicemaster.enabled;
    const cfg = db.saveConfig(interaction.guildId, { voicemaster: { enabled: !current } });
    return interaction.update({ embeds: [ui.vmSetupEmbed(cfg)], components: [ui.vmSetupRow(cfg)] });
  }

  // ---- Voicemaster: per-channel owner controls (Lock/Hide/Rename/Limit/Kick/Transfer) ----
  if (id.startsWith('vm_')) {
    const vc = interaction.member.voice.channel;
    if (!vc || !db.getVMChannel(vc.id)) return interaction.reply({ embeds: [ui.errorEmbed('No Channel', 'Join a voicemaster channel first.')], ephemeral: true });
    const record = db.getVMChannel(vc.id);
    if (record.ownerId !== interaction.user.id) return interaction.reply({ embeds: [ui.errorEmbed('Not Owner', 'Only the channel owner can do that.')], ephemeral: true });

    const everyone = interaction.guild.roles.everyone;
    const overwrite = vc.permissionOverwrites.cache.get(everyone.id);

    if (id === 'vm_togglelock') {
      const locked = !!(overwrite && overwrite.deny.has(PermissionFlagsBits.Connect));
      await vc.permissionOverwrites.edit(everyone, { Connect: locked ? null : false });
      await interaction.update({ embeds: [ui.vmControlEmbed(interaction.user)], components: ui.vmControlRows(vc, { locked: !locked }) });
      return interaction.followUp({
        embeds: [ui.okEmbed(locked ? '🔓 Unlocked' : '🔒 Locked', locked ? 'Anyone can join the channel again.' : 'Only allowed members can join now.')],
        ephemeral: true
      });
    }
    if (id === 'vm_togglehide') {
      const hidden = !!(overwrite && overwrite.deny.has(PermissionFlagsBits.ViewChannel));
      await vc.permissionOverwrites.edit(everyone, { ViewChannel: hidden ? null : false });
      await interaction.update({ embeds: [ui.vmControlEmbed(interaction.user)], components: ui.vmControlRows(vc, { hidden: !hidden }) });
      return interaction.followUp({
        embeds: [ui.okEmbed(hidden ? '👁️ Visible' : '🙈 Hidden', hidden ? 'Channel is visible again.' : 'Channel is now hidden from everyone else.')],
        ephemeral: true
      });
    }
    if (id === 'vm_kick') {
      const others = vc.members.filter(m => m.id !== interaction.user.id);
      if (!others.size) return interaction.reply({ embeds: [ui.vmKickNobodyEmbed()], ephemeral: true });
      return interaction.reply({ embeds: [ui.vmKickPromptEmbed()], components: [ui.vmKickSelectRow([...others.values()])], ephemeral: true });
    }
    if (id === 'vm_rename' || id === 'vm_limit' || id === 'vm_transfer') return openVMModal(interaction, id);
  }

  // ---- Setup panel (toggle / edit) ----
  if (id.startsWith('setup_toggle:') || id.startsWith('setup_edit:')) {
    const [action, sub] = id.split(':');
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to use this.')], ephemeral: true });
    }
    if (action === 'setup_edit') return openSetupModal(interaction, sub);

    const moduleKey = ui.SETUP_MODULE_META[sub].cfgKey;
    const enabled = !db.getConfig(interaction.guildId)[moduleKey].enabled;
    const cfg = db.saveConfig(interaction.guildId, { [moduleKey]: { enabled } });
    return interaction.update({ embeds: [ui.setupPanelEmbed(sub, cfg)], components: [ui.setupPanelRow(sub, cfg)] });
  }
}

async function handleVMKickPick(interaction) {
  const vc = interaction.member.voice.channel;
  if (!vc || !db.getVMChannel(vc.id)) return interaction.update({ embeds: [ui.errorEmbed('No Channel', 'You left the voice channel.')], components: [] });
  const record = db.getVMChannel(vc.id);
  if (record.ownerId !== interaction.user.id) return interaction.update({ embeds: [ui.errorEmbed('Not Owner', 'Only the channel owner can do that.')], components: [] });

  const targetId = interaction.values[0];
  const member = vc.members.get(targetId);
  if (!member) return interaction.update({ embeds: [ui.vmKickGoneEmbed(targetId)], components: [] });

  await member.voice.disconnect('Removed by channel owner').catch(() => {});
  return interaction.update({ embeds: [ui.vmKickedEmbed(member.user.tag)], components: [] });
}

// Handles the UserSelectMenu opened by the Staff Controls "Add Member" / "Remove Member"
// buttons — grants or revokes that member's view/send access on the ticket channel.
async function handleTicketMemberSelect(interaction, action) {
  const ticket = db.getTicket(interaction.channel.id);
  if (!ticket) return interaction.update({ embeds: [ui.errorEmbed('Not a Ticket', 'This only works inside a ticket channel.')], components: [] });
  const userId = interaction.values[0];
  if (action === 'add') {
    await interaction.channel.permissionOverwrites.edit(userId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
    return interaction.update({ embeds: [ui.okEmbed('➕ Member Added', `<@${userId}> can now see this ticket.`)], components: [] });
  }
  await interaction.channel.permissionOverwrites.delete(userId).catch(() => {});
  return interaction.update({ embeds: [ui.okEmbed('➖ Member Removed', `<@${userId}> can no longer see this ticket.`)], components: [] });
}

// Field spec for each panel module's "Edit Settings" modal. `oKey` matches the flat key
// buildModulePatch() (in commands.js) expects; `parse` turns the raw text field into that
// shape (IDs are stored as plain strings, buildModulePatch only ever needs `.id`).
const SETUP_EDIT_FIELDS = {
  antinuke: [
    { key: 'punishment', oKey: 'punishment', label: 'Punishment: ban / kick / strip_roles', parse: v => v, get: cfg => cfg.antinuke.punishment },
    { key: 'threshold', oKey: 'threshold', label: 'Action threshold (number)', parse: v => parseInt(v, 10) || null, get: cfg => String(cfg.antinuke.maxBans) },
    { key: 'window_seconds', oKey: 'window_seconds', label: 'Time window (seconds)', parse: v => parseInt(v, 10) || null, get: cfg => String(cfg.antinuke.windowSeconds) }
  ],
  antilink: [
    { key: 'mode', oKey: 'mode', label: 'Mode: delete / warn / mute', parse: v => v, get: cfg => cfg.antilink.mode },
    { key: 'bypass_role', oKey: 'bypass_role_id', label: 'Bypass role ID (blank = none)', parse: v => v.replace(/[<@&>]/g, ''), get: cfg => cfg.antilink.bypassRoleId || '' }
  ],
  antispam: [
    { key: 'max_messages', oKey: 'max_messages', label: 'Max messages per window', parse: v => parseInt(v, 10) || null, get: cfg => String(cfg.antispam.maxMessages) },
    { key: 'window_seconds', oKey: 'window_seconds', label: 'Window length (seconds)', parse: v => parseInt(v, 10) || null, get: cfg => String(cfg.antispam.windowSeconds) },
    { key: 'punishment', oKey: 'punishment', label: 'Punishment: mute / kick / ban', parse: v => v, get: cfg => cfg.antispam.punishment }
  ],
  antiraid: [
    { key: 'join_threshold', oKey: 'join_threshold', label: 'Joins allowed per window', parse: v => parseInt(v, 10) || null, get: cfg => String(cfg.antiraid.joinThreshold) },
    { key: 'window_seconds', oKey: 'window_seconds', label: 'Window length (seconds)', parse: v => parseInt(v, 10) || null, get: cfg => String(cfg.antiraid.windowSeconds) },
    { key: 'min_account_age_days', oKey: 'min_account_age_days', label: 'Min account age (days)', parse: v => parseInt(v, 10), get: cfg => String(cfg.antiraid.minAccountAgeDays) },
    { key: 'action', oKey: 'action', label: 'Action: lockdown / kick_new', parse: v => v, get: cfg => cfg.antiraid.action }
  ],
  voicemaster: [
    { key: 'hub_channel', oKey: 'hub_channel_id', label: 'Hub voice channel ID', parse: v => v.replace(/[<#>]/g, ''), get: cfg => cfg.voicemaster.hubChannelId || '' },
    { key: 'category', oKey: 'category_id', label: 'Category ID for new channels', parse: v => v.replace(/[<#>]/g, ''), get: cfg => cfg.voicemaster.categoryId || '' }
  ],
  greetmessage: [
    { key: 'channel', oKey: 'channel_id', label: 'Welcome channel ID', parse: v => v.replace(/[<#>]/g, ''), get: cfg => cfg.greetmessage.channelId || '' },
    { key: 'message', oKey: 'message', label: 'Message (use {user} and {server})', parse: v => v, get: cfg => cfg.greetmessage.message || '' },
    { key: 'image', oKey: 'image', label: 'Image/GIF URL (optional)', parse: v => v, get: cfg => cfg.greetmessage.image || '' }
  ],
  leveling: [
    { key: 'channel', oKey: 'channel_id', label: 'Level-up announcement channel ID', parse: v => v.replace(/[<#>]/g, ''), get: cfg => cfg.leveling.channel || '' },
    { key: 'xp_per_message', oKey: 'xp_per_message', label: 'XP per eligible message', parse: v => parseInt(v, 10) || null, get: cfg => String(cfg.leveling.xpPerMessage) },
    { key: 'cooldown_seconds', oKey: 'cooldown_seconds', label: 'Cooldown between XP gains (seconds)', parse: v => parseInt(v, 10) || null, get: cfg => String(cfg.leveling.cooldownSeconds) }
  ],
  tickets: [
    { key: 'category', oKey: 'category_id', label: 'Ticket category ID', parse: v => v.replace(/[<#>]/g, ''), get: cfg => cfg.ticket.categoryId || '' },
    { key: 'support_role', oKey: 'support_role_id', label: 'Support role ID', parse: v => v.replace(/[<@&>]/g, ''), get: cfg => cfg.ticket.supportRoleId || '' },
    { key: 'log_channel', oKey: 'log_channel_id', label: 'Ticket log channel ID', parse: v => v.replace(/[<#>]/g, ''), get: cfg => cfg.ticket.logChannelId || '' }
  ]
};

async function openSetupModal(interaction, sub) {
  const cfg = db.getConfig(interaction.guildId);
  const fields = SETUP_EDIT_FIELDS[sub];
  const modal = new ModalBuilder().setCustomId(`setup_modal:${sub}`).setTitle(`Edit ${ui.SETUP_MODULE_META[sub].title}`);
  for (const f of fields) {
    const current = f.get(cfg);
    const input = new TextInputBuilder().setCustomId(f.key).setLabel(f.label.slice(0, 45)).setStyle(TextInputStyle.Short).setRequired(false);
    if (current) input.setValue(String(current).slice(0, 100));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return interaction.showModal(modal);
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
  if (interaction.customId.startsWith('setup_setting_modal:')) {
    const [,sub,setting]=interaction.customId.split(':');
    if(!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','You need Administrator to change setup settings.')],ephemeral:true});
    const values={}; for(const key of ['value','title','description','thumbnail','image','category','message']){try{const v=interaction.fields.getTextInputValue(key).trim();if(v)values[key]=v;}catch{}}
    let o={}; if(sub==='tickets'){const map={panel_text:{panel_title:values.title,panel_description:values.description},panel_media:{panel_thumbnail:values.thumbnail,panel_image:values.image},welcome_text:{category_label:values.category,welcome_message:values.message},welcome_media:{welcome_thumbnail:values.thumbnail,welcome_image:values.image}};o=map[setting]||{};} else {const k=setting;if(values.value)o[k]=values.value;if(['threshold','window_seconds','max_messages','join_threshold','min_account_age_days','xp_per_message','cooldown_seconds'].includes(setting))o[k]=parseInt(values.value,10);}
    const patch=buildModulePatch(sub,interaction.guildId,o); const cfg=db.saveConfig(interaction.guildId,patch);
    if(interaction.message) return interaction.update({embeds:[ui.setupPanelEmbed(sub,cfg)],components:ui.setupPanelRow(sub,cfg)});
    return interaction.reply({embeds:[ui.setupPanelEmbed(sub,cfg)],components:ui.setupPanelRow(sub,cfg),ephemeral:true});
  }

  if (interaction.customId.startsWith('setup_modal:')) {
    const sub = interaction.customId.split(':')[1];
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to use this.')], ephemeral: true });
    }
    const o = {};
    for (const f of SETUP_EDIT_FIELDS[sub]) {
      const raw = interaction.fields.getTextInputValue(f.key).trim();
      if (raw) o[f.oKey] = f.parse(raw);
    }
    const patch = buildModulePatch(sub, interaction.guildId, o);
    const cfg = db.saveConfig(interaction.guildId, patch);
    return interaction.update({ embeds: [ui.setupPanelEmbed(sub, cfg)], components: [ui.setupPanelRow(sub, cfg)] });
  }

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
    if (cfg.greetmessage.image) {
      const embed = ui.okEmbed('👋 Welcome!', text).setImage(cfg.greetmessage.image);
      if (ch?.isTextBased()) ch.send({ embeds: [embed] }).catch(() => {});
    } else
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
