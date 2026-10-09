// settings.js — standalone top-level commands for settings that used to live only inside setup panels.
// Each command reads/writes the SAME config keys as setup (db.getConfig/saveConfig), so a change made here
// shows up in setup and vice versa. Every command has subcommands: set | view | reset  (slash + prefix).
//   /welcomemessage set text:Hello {user}     !welcomemessage view      !welcomemessage reset

const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const db = require('./database');
const ui = require('./ui');
const h = require('./helpers');

const TEXT = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
// type: channel | category | role | text | number | toggle
const SETTINGS = [
  { name: 'welcomechannel', desc: 'Welcome channel', path: ['welcome', 'channel'], type: 'channel' },
  { name: 'welcomemessage', desc: 'Welcome message', path: ['welcome', 'message'], type: 'text' },
  { name: 'welcometoggle', desc: 'Welcome messages on/off', path: ['welcome', 'enabled'], type: 'toggle' },
  { name: 'leavechannel', desc: 'Leave channel', path: ['leave', 'channel'], type: 'channel' },
  { name: 'leavemessage', desc: 'Leave message', path: ['leave', 'message'], type: 'text' },
  { name: 'leavetoggle', desc: 'Leave messages on/off', path: ['leave', 'enabled'], type: 'toggle' },
  { name: 'setautorole', desc: 'Auto-role given to new members', path: ['autorole', 'roleId'], type: 'role', hierarchy: true },
  { name: 'ticketcategory', desc: 'Ticket category', path: ['ticket', 'categoryId'], type: 'category' },
  { name: 'ticketsupportrole', desc: 'Ticket support role', path: ['ticket', 'supportRoleId'], type: 'role' },
  { name: 'ticketlogchannel', desc: 'Ticket log channel', path: ['ticket', 'logChannelId'], type: 'channel' },
  { name: 'ticketsetwelcomemsg', desc: 'Ticket welcome message', path: ['ticket', 'welcomeMessage'], type: 'text' },
  { name: 'levelchannel', desc: 'Level-up announcement channel', path: ['leveling', 'channel'], type: 'channel' },
  { name: 'levelupmessage', desc: 'Level-up message', path: ['leveling', 'levelUpMessage'], type: 'text' },
  { name: 'suggestionchannel', desc: 'Suggestions channel', path: ['suggestions', 'channelId'], type: 'channel' },
  { name: 'greetmessagechannel', desc: 'Greet message channel', path: ['greetmessage', 'channelId'], type: 'channel' },
  { name: 'greetmessagetext', desc: 'Greet message text', path: ['greetmessage', 'message'], type: 'text' },
  { name: 'birthdaymessage', desc: 'Birthday wish message', path: ['birthdays', 'wishMessage'], type: 'text' },
  { name: 'honeypotchannel', desc: 'Honeypot trap channel', path: ['honeypot', 'channelId'], type: 'channel' },
  { name: 'antispamlimit', desc: 'Antispam: max messages per window', path: ['antispam', 'maxMessages'], type: 'number', min: 2, max: 50 },
  { name: 'antiraidthreshold', desc: 'Antiraid: joins per window that trigger it', path: ['antiraid', 'joinThreshold'], type: 'number', min: 2, max: 100 }
];

const getPath = (obj, p) => p.reduce((o, k) => (o == null ? o : o[k]), obj);
const patchOf = (p, v) => p.reduceRight((acc, k) => ({ [k]: acc }), v);
const defaultOf = s => getPath(db.DEFAULT_CONFIG, s.path) ?? null;
const vars = (text, i) => String(text).replace(/\{user\}/g, `${i.user}`).replace(/\{server\}/g, i.guild?.name || 'Server')
  .replace(/\{(membercount|count)\}/g, String(i.guild?.memberCount ?? 0)).replace(/\{level\}/g, '5');

function show(s, value, guild) {
  if (value === null || value === undefined || value === '') return '*Not set*';
  if (s.type === 'channel' || s.type === 'category') return `<#${value}>`;
  if (s.type === 'role') return `<@&${value}>`;
  if (s.type === 'toggle') return value ? `${h.THEME.emoji.on()} Enabled` : `${h.THEME.emoji.off()} Disabled`;
  return h.clip(String(value), 900);
}
function viewEmbed(s, i, title = s.desc, color) {
  const value = getPath(db.getConfig(i.guildId), s.path);
  const e = ui.base(`${h.THEME.emoji.settings()} ${title}`).addFields({ name: 'Current value', value: show(s, value), inline: false });
  if (s.type === 'text' && value) e.addFields({ name: 'Live preview', value: h.clip(vars(value, i), 1000) }, { name: 'Variables', value: '`{user}` `{server}` `{membercount}` `{level}`' });
  if (color) e.setColor(color);
  return e;
}
const editRow = (s, uid) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`cfgset:edit:${uid}:${s.name}`).setLabel('Edit').setStyle(ButtonStyle.Primary).setEmoji(h.THEME.emoji.edit));

function applyValue(s, patchValue, guildId) { db.saveConfig(guildId, patchOf(s.path, patchValue)); }

function build(s) {
  const b = new SlashCommandBuilder().setName(s.name).setDescription(`${s.desc} (set / view / reset).`).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  b.addSubcommand(c => c.setName('view').setDescription(`Show the current ${s.desc.toLowerCase()}.`));
  b.addSubcommand(c => {
    c.setName('set').setDescription(`Change the ${s.desc.toLowerCase()}.`);
    if (s.type === 'channel') c.addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT));
    else if (s.type === 'category') c.addChannelOption(o => o.setName('category').setDescription('Category').setRequired(true).addChannelTypes(ChannelType.GuildCategory));
    else if (s.type === 'role') c.addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true));
    else if (s.type === 'text') c.addStringOption(o => o.setName('text').setDescription('Text (supports {user} {server} {membercount})').setRequired(true));
    else if (s.type === 'number') c.addIntegerOption(o => o.setName('value').setDescription(`${s.min}–${s.max}`).setRequired(true).setMinValue(s.min).setMaxValue(s.max));
    else c.addBooleanOption(o => o.setName('enabled').setDescription('on / off').setRequired(true));
    return c;
  });
  b.addSubcommand(c => c.setName('reset').setDescription(`Restore the default ${s.desc.toLowerCase()}.`));
  return b;
}

async function validate(s, i) {
  const me = i.guild.members.me;
  if (s.type === 'channel') {
    const ch = i.options.getChannel('channel');
    if (!ch || !TEXT.includes(ch.type)) return { error: 'Choose a text or announcement channel.' };
    const missing = h.missingChannelPerms(ch, me, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
    if (missing.length) return { error: `I'm missing **${missing.join(', ')}** in ${ch}. Grant those first so the setting actually works.` };
    return { value: ch.id };
  }
  if (s.type === 'category') {
    const ch = i.options.getChannel('category');
    if (!ch || ch.type !== ChannelType.GuildCategory) return { error: 'Choose a category channel.' };
    if (!ch.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels)) return { error: `I need **Manage Channels** in ${ch.name} to create ticket channels there.` };
    return { value: ch.id };
  }
  if (s.type === 'role') {
    const role = i.options.getRole('role');
    if (!role) return { error: 'That role was not found.' };
    if (role.id === i.guild.id) return { error: '`@everyone` cannot be used here.' };
    if (s.hierarchy) {
      if (role.managed) return { error: `${role} is managed by an integration and cannot be assigned.` };
      if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return { error: 'I need the **Manage Roles** permission to hand out this role.' };
      if (role.position >= me.roles.highest.position) return { error: `${role} is equal to or above my highest role. Move my role above it in Server Settings → Roles.` };
    }
    return { value: role.id };
  }
  if (s.type === 'text') {
    const text = String(i.options.getString('text') || '').trim();
    if (!text) return { error: 'The text cannot be empty.' };
    if (text.length > 1000) return { error: `Too long: ${text.length}/1000 characters.` };
    return { value: text };
  }
  if (s.type === 'number') {
    const n = i.options.getInteger('value');
    if (!Number.isInteger(n) || n < s.min || n > s.max) return { error: `Enter a whole number from ${s.min} to ${s.max}.` };
    return { value: n };
  }
  const en = i.options.getBoolean('enabled');
  return en === null ? { error: 'Specify `enabled` as true or false.' } : { value: en };
}

function makeCommand(s) {
  return {
    data: build(s),
    async execute(i) {
      if (!i.guild) return h.safeReply(i, { embeds: [h.errorEmbed('Server only', 'Use this inside a server.')], ephemeral: true });
      if (!i.member.permissions.has(PermissionFlagsBits.ManageGuild)) return h.safeReply(i, { embeds: [h.errorEmbed('Missing permissions', 'You need **Manage Server** to change this setting.')], ephemeral: true });
      const sub = i.options.getSubcommand();
      if (sub === 'view') return h.safeReply(i, { embeds: [viewEmbed(s, i)], components: s.type === 'text' ? [editRow(s, i.user.id)] : [], ephemeral: true });
      if (sub === 'reset') {
        return h.safeReply(i, { embeds: [h.warnEmbed('Reset to default?', `**${s.desc}** will go back to: ${show(s, defaultOf(s))}`)], components: [h.confirmRow(`cfgset:rst:${i.user.id}:${s.name}`, { yes: 'Reset' })], ephemeral: true });
      }
      const res = await validate(s, i);
      if (res.error) return h.safeReply(i, { embeds: [h.errorEmbed('Invalid value', res.error)], ephemeral: true });
      applyValue(s, res.value, i.guildId);
      return h.safeReply(i, { embeds: [viewEmbed(s, i, `${s.desc} updated`, ui.OK)], components: s.type === 'text' ? [editRow(s, i.user.id)] : [], ephemeral: true });
    }
  };
}

// customIds: cfgset:rst:<uid>:<name>:yes|no   cfgset:edit:<uid>:<name>   cfgset:modal:<uid>:<name>
async function handleInteraction(i) {
  const id = i.customId;
  if (!id || !id.startsWith('cfgset:')) return false;
  const [, action, uid, name, choice] = id.split(':');
  const s = SETTINGS.find(x => x.name === name);
  try {
    if (!await h.authorOnly(i, uid)) return true;
    if (!s || !i.guild) { await h.safeReply(i, { embeds: [h.errorEmbed('Unavailable', 'That setting no longer exists.')], ephemeral: true }); return true; }
    if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) { await i.reply({ embeds: [h.errorEmbed('Missing permissions', 'You need **Manage Server**.')], ephemeral: true }); return true; }
    if (action === 'rst') {
      if (choice !== 'yes') { await i.update({ embeds: [h.infoEmbed('Cancelled', 'Nothing changed.')], components: [] }); return true; }
      applyValue(s, defaultOf(s), i.guildId);
      await i.update({ embeds: [viewEmbed(s, i, `${s.desc} reset`, ui.OK)], components: [] });
    } else if (action === 'edit') {
      const cur = getPath(db.getConfig(i.guildId), s.path);
      const input = new TextInputBuilder().setCustomId('text').setLabel(s.desc.slice(0, 45)).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
      if (cur) input.setValue(String(cur).slice(0, 1000));
      await i.showModal(new ModalBuilder().setCustomId(`cfgset:modal:${uid}:${s.name}`).setTitle(`Edit ${s.desc}`.slice(0, 45)).addComponents(new ActionRowBuilder().addComponents(input)));
    } else if (action === 'modal') {
      const text = i.fields.getTextInputValue('text').trim();
      if (!text) { await i.reply({ embeds: [h.errorEmbed('Invalid value', 'The text cannot be empty.')], ephemeral: true }); return true; }
      applyValue(s, text, i.guildId);
      await i.reply({ embeds: [viewEmbed(s, i, `${s.desc} updated`, ui.OK)], components: [editRow(s, uid)], ephemeral: true });
    }
  } catch (e) {
    console.error('[Settings] interaction failed:', e);
    await h.safeReply(i, { embeds: [h.errorEmbed('Settings error', String(e?.message || e).slice(0, 1000))], ephemeral: true });
  }
  return true;
}

const commands = SETTINGS.map(makeCommand);
module.exports = { commands, handleInteraction, SETTINGS };
