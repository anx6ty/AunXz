// index.js — boots the client, registers slash commands, and wires every Discord event
// to the systems/commands/ui modules. This is the only file that touches gateway events.

require('dotenv').config();

process.on('uncaughtException', err => {
  console.error('[AunXz] UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', err => {
  console.error('[AunXz] UNHANDLED REJECTION:', err);
});

console.log('[AunXz] Starting index.js...');
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  ChannelType, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  StringSelectMenuBuilder, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, AuditLogEvent
} = require('discord.js');

const db = require('./database');
const ui = require('./ui');
const sys = require('./systems');
const stats = require('./stats');
const { commands, isOwner, buildModulePatch, PANEL_MODULES } = require('./commands');
require('./v2patch').apply(); // Global Components V2 conversion disabled; normal embeds/action rows are used.

const applicationSessions = new Map(); // userId -> { guildId, index, answers, waiting }
const birthdayWishesSent = new Set();
const logSetupSessions = new Map();
const rolePanelSessions = new Map(); // guild:user -> { buttonId, reactionId }
const setupMediaSessions = new Map(); // guild:user -> { kind, panelId, field, channelId, interaction, apply, render, expiresAt }

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.Reaction, Partials.User]
});

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


async function finishGiveaways() {
  for (const guild of client.guilds.cache.values()) {
    for (const g of db.listGiveaways(guild.id, 50)) {
      if (g.status !== 'active' || Date.now() < g.endsAt) continue;
      let participants=[]; try { participants=JSON.parse(g.participants||'[]'); } catch {}
      const pool=participants.filter(id => guild.members.cache.has(id));
      const shuffled=[...pool].sort(()=>Math.random()-0.5);
      const winners=shuffled.slice(0, Math.min(g.winners, shuffled.length));
      db.updateGiveaway(guild.id,g.id,{status:'ended'});
      const ch=g.channelId ? guild.channels.cache.get(g.channelId) : null;
      if (ch) {
        const text=winners.length ? winners.map(id=>`<@${id}>`).join(', ') : 'No valid entries.';
        await ch.send({embeds:[ui.base('🏆 Giveaway Ended').setDescription(`**Prize:** ${g.prize}\\n**Winner(s):** ${text}`)]}).catch(()=>{});
      }
    }
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Database: ${db.DB_PATH}`);
  client.user.setActivity('/help');
  try { await registerCommands(); } catch (e) { console.error('Command registration failed:', e); }
  await stats.refreshAll(client).catch(err => console.error('[Stats] Startup refresh:', err));
});

setInterval(() => finishGiveaways().catch(console.error), 15000);
setInterval(() => stats.refreshAll(client).catch(err => console.error('[Stats] Refresh:', err)), Math.max(60000, Number(process.env.STATS_SCAN_INTERVAL_MS || 60000)));

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

// -----------------------------------------------------------------------------
// Command guards — disabled modules must never execute, and declared permissions
// are enforced for both slash commands and prefix/mention commands.
// ----------------------------------------------------------------------------∕
const COMMAND_FEATURES = {
  antinuke:'antinuke', antilink:'antilink', antispam:'antispam', antiraid:'antiraid',
  antiwebhook:'antiwebhook', antibot:'antibot', antialt:'antialt', voicemaster:'voicemaster',
  greetmessage:'greetmessage', testgreet:'greetmessage', greetvoice:'greetvoice', leveling:'leveling', tickets:'ticket',
  ticketpanel:'ticket', ticketconfig:'ticket', claim:'ticket', close:'ticket', delete:'ticket',
  addmembertoticket:'ticket', removemembertoticket:'ticket', automod:'automod',
  antibadwordsetup:'antibadword', autorespondersetup:'autoresponder', autoreactorsetup:'autoreactor',
  honeypotsetup:'honeypot', birthdaysetup:'birthdays', birthdays:'birthdays', autorole:'autorole',
  staffapplicationssetup:'staffApplications', rank:'leveling', leaderboard:'leveling', xp:'leveling'
};

function commandSubcommand(interaction) {
  try { return interaction.options?.getSubcommand?.(false) || null; } catch { return null; }
}
function commandIsSetupOnly(interaction) {
  const name = interaction.commandName || '';
  const sub = commandSubcommand(interaction);
  return name === 'setup' || sub === 'setup' || /setup$/i.test(name) || /config$/i.test(name) || /panel$/i.test(name) || name === 'autorole';
}
function commandFeatureKey(interaction) {
  return COMMAND_FEATURES[interaction.commandName] || null;
}
function featureEnabled(cfg, key) {
  if (!key || !Object.prototype.hasOwnProperty.call(cfg, key)) return true;
  const value = cfg[key];
  return typeof value === 'boolean' ? value : value?.enabled !== false;
}
async function guardCommand(interaction, cmd) {
  if (!interaction.guild || !interaction.member) return true;
  const cfg = db.getConfig(interaction.guildId);
  const json = cmd.data.toJSON();
  const required = json.default_member_permissions;
  if (required && !interaction.member.permissions.has(BigInt(required))) {
    return interaction.reply({ embeds:[ui.errorEmbed('Missing Permissions', `You do not have the permissions required for **/${interaction.commandName}**.`)], ephemeral:true }).then(()=>false);
  }
  if (!commandIsSetupOnly(interaction)) {
    const key = commandFeatureKey(interaction);
    if (key && !featureEnabled(cfg, key)) {
      const setupName = key === 'ticket' ? '/tickets setup' : key === 'greetmessage' ? '/greetmessage setup' : `/${interaction.commandName} setup`;
      return interaction.reply({ embeds:[ui.errorEmbed('Feature Disabled', `**${key}** is currently disabled. Enable it from ${setupName}.`)], ephemeral:true }).then(()=>false);
    }
  }
  return true;
}
async function executeCommand(cmd, interaction) {
  if (!await guardCommand(interaction, cmd)) return;
  try {
    await cmd.execute(interaction);
  } catch (e) {
    console.error(`Command ${interaction.commandName} failed:`, e);
    const code = e?.code ? `\n**Discord code:** \`${e.code}\`` : '';
    const message = e?.message ? String(e.message).slice(0, 1200) : 'Something went wrong while executing the command.';
    const payload = { embeds:[ui.errorEmbed('Command Failed', `${message}${code}`)], ephemeral:true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(()=>{});
    else await interaction.reply(payload).catch(()=>{});
  }
}

// -----------------------------------------------------------------------------
// Setup media upload flow — administrators click "Send Image/GIF", then send the
// image/GIF as the very next message in the same channel. The bot saves the CDN URL
// and deletes the setup upload so no raw upload is left in the channel.
// -----------------------------------------------------------------------------
function mediaSessionKey(guildId, userId) { return `${guildId}:${userId}`; }
function startSetupMediaUpload(interaction, opts) {
  const key = mediaSessionKey(interaction.guildId, interaction.user.id);
  const old = setupMediaSessions.get(key);
  if (old?.timer) clearTimeout(old.timer);
  const session = { mediaType: 'image', ...opts, channelId: interaction.channelId, interaction, expiresAt: Date.now() + 120000 };
  session.timer = setTimeout(() => setupMediaSessions.delete(key), 120000);
  setupMediaSessions.set(key, session);
  const label = opts.label || 'this setting';
  const what = session.mediaType === 'audio' ? 'audio file' : 'image or GIF';
  return interaction.reply({
    embeds:[ui.base(session.mediaType === 'audio' ? '🎵 Send Audio Now' : '🖼️ Send Image/GIF Now')
      .setDescription(`Send the ${what} for **${label}** as your next message in this channel.\n\nI will save it and delete the upload automatically.`)],
    ephemeral:true
  });
}
async function consumeSetupMedia(message) {
  if (!message.guild || message.author.bot) return false;
  const key = mediaSessionKey(message.guild.id, message.author.id);
  const session = setupMediaSessions.get(key);
  if (!session || session.channelId !== message.channelId) return false;
  if (Date.now() > session.expiresAt) { setupMediaSessions.delete(key); return false; }
  const attachment = [...message.attachments.values()].find(a => {
    const type = String(a.contentType || '').toLowerCase();
    const name = String(a.name || '').toLowerCase();
    if (session.mediaType === 'audio') return type.startsWith('audio/') || /\.(mp3|wav|ogg|oga|opus|webm|m4a|aac|flac)$/i.test(name);
    return type.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(name);
  });
  if (!attachment) return false;
  setupMediaSessions.delete(key);
  if (session.timer) clearTimeout(session.timer);
  try {
    await session.apply(session.mediaType === 'audio' ? attachment : attachment.url, message);
    await message.delete().catch(()=>{});
    if (session.render) await session.interaction.editReply(session.render()).catch(()=>{});
    return true;
  } catch (e) {
    console.error('setup media upload:', e);
    await session.interaction.editReply({ embeds:[ui.errorEmbed('Upload Failed', e.message || 'Could not save that upload.')], components:[] }).catch(()=>{});
    return true;
  }
}

const TEXT_ALIASES = new Map([
  ['i','invites'], ['invite','invites'],
  ['si','serverinfo'], ['server','serverinfo'],
  ['av','avatar'], ['pfp','avatar'],
  ['ui','userinfo'], ['user','userinfo'],
  ['ss','serverstats'], ['stats','serverstats'],
  ['lb','leaderboard'], ['lbs','leaderboards'],
  ['rank','rank'], ['help','help'], ['h','help'],
  ['ga','giveaway']
]);

function normalizeCommandName(name) {
  const key = String(name || '').toLowerCase();
  return TEXT_ALIASES.get(key) || key;
}

async function handlePrefixCommand(message) {
  const cfg = db.getConfig(message.guild.id);
  const prefix = cfg.prefix || '!';
  let content = message.content.trim();
  const mention = new RegExp(`^<@!?${message.client.user.id}>\\s*`, 'i');

  // Both "<prefix> command" and "<@bot> command" use the same command engine.
  let isTextCommand = content.startsWith(prefix);
  if (isTextCommand) content = content.slice(prefix.length).trim();
  else if (mention.test(content)) {
    content = content.replace(mention, '').trim();
    isTextCommand = true;
  }
  if (!isTextCommand) return false;

  const tokens = tokenize(content);
  const cmdName = normalizeCommandName(tokens.shift() || '');
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
  await executeCommand(cmd, fake);
  return true;
}


module.exports = {
  client, db, ui, sys, stats, commands, isOwner, buildModulePatch, PANEL_MODULES,
  applicationSessions, birthdayWishesSent, logSetupSessions, rolePanelSessions, setupMediaSessions,
  registerCommands, finishGiveaways, executeCommand,
  startInteractionWatchdog, startSetupMediaUpload, consumeSetupMedia, handlePrefixCommand,
  stripEphemeral
};
