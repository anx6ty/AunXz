// greetmessage.js — /greetmessagesetup: select menus for options, buttons for toggles/triggers,
// modals for short values, and "send a message below to save" capture for long text / images.
// Uses the same `greetmessage` config key as /greetmessage setup, /testgreet and the join handler.

const {
  SlashCommandBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder
} = require('discord.js');
const db = require('./database');
const ui = require('./ui');
const h = require('./helpers');

const cfgOf = gid => db.getConfig(gid).greetmessage;
const save = (gid, patch) => db.saveConfig(gid, { greetmessage: patch }).greetmessage;
const isAdmin = i => i.memberPermissions?.has(PermissionFlagsBits.Administrator) || i.member?.permissions?.has?.(PermissionFlagsBits.Administrator);
const render = (gid, notes = []) => { const c = cfgOf(gid); return { embeds: [ui.greetMessageSetupEmbed(c, notes)], components: ui.greetMessageSetupRow(c) }; };

// Shared by the join handler, the preview button and /testgreet so all three look identical.
function fill(text, user, guild) {
  return String(text || 'Welcome {user}!').replace(/{user}/g, `${user}`).replace(/{server}/g, guild.name).replace(/{count}/g, String(guild.memberCount));
}
function buildGreetPayload(guild, user, cfg, { test = false } = {}) {
  const e = ui.base(`${cfg.title || '👋 Welcome!'}${test ? ' (Preview)' : ''}`).setDescription(fill(cfg.message, user, guild));
  if (cfg.color) e.setColor(Number(cfg.color));
  if (cfg.showAvatar !== false && user.displayAvatarURL) e.setThumbnail(user.displayAvatarURL({ extension: 'png', size: 256 }));
  if (cfg.image) e.setImage(cfg.image);
  const payload = { embeds: [e] };
  if (cfg.ping !== false) { payload.content = `${user}`; payload.allowedMentions = { users: [user.id] }; }
  return payload;
}

const command = {
  data: new SlashCommandBuilder().setName('greetmessagesetup').setDescription('Open the easy Greet Message setup panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(i) {
    if (!i.guild) return h.safeReply(i, { embeds: [h.errorEmbed('Server only', 'Use this inside a server.')], ephemeral: true });
    if (!isAdmin(i)) return h.safeReply(i, { embeds: [h.errorEmbed('Missing Permissions', 'You need **Administrator**.')], ephemeral: true });
    return h.safeReply(i, { ...render(i.guildId), ephemeral: true });
  }
};

async function handleInteraction(i) {
  const id = i.customId || '';
  if (!id.startsWith('greetmessage_cfg')) return false;
  const gid = i.guildId;
  try {
    if (!isAdmin(i)) { await i.reply({ embeds: [h.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true }); return true; }

    // ---- modal submits (title / color) -------------------------------------------------
    if (i.isModalSubmit()) {
      const field = id.split(':')[1];
      let note = null;
      if (field === 'title') {
        const v = i.fields.getTextInputValue('value').trim().slice(0, 100);
        save(gid, { title: v || '👋 Welcome!' });
      } else if (field === 'color') {
        const raw = i.fields.getTextInputValue('value').trim();
        if (!raw) save(gid, { color: null });
        else { const c = h.parseHexColor(raw); if (c === null) note = '⚠️ Invalid color — use a hex code like `#5865F2`.'; else save(gid, { color: c }); }
      }
      if (i.message) { await i.deferUpdate(); return void await i.editReply(render(gid, note ? [note] : [])); }
      return void await i.reply({ ...render(gid, note ? [note] : []), ephemeral: true });
    }

    if (id === 'greetmessage_cfg:channel' && i.isChannelSelectMenu()) {
      await i.deferUpdate(); save(gid, { channelId: i.values[0] });
      return void await i.editReply(render(gid));
    }

    if (id === 'greetmessage_cfg:option' && i.isStringSelectMenu()) {
      const opt = i.values[0];
      if (opt === 'title' || opt === 'color') {
        const c = cfgOf(gid);
        const input = new TextInputBuilder().setCustomId('value').setStyle(TextInputStyle.Short).setRequired(opt === 'title')
          .setLabel(opt === 'title' ? 'Card title' : 'Accent color (hex, blank = default)').setMaxLength(100);
        const cur = opt === 'title' ? c.title : (c.color ? `#${Number(c.color).toString(16).padStart(6, '0')}` : '');
        if (cur) input.setValue(String(cur).slice(0, 100));
        return void await i.showModal(new ModalBuilder().setCustomId(`greetmessage_cfg_modal:${opt}`).setTitle(opt === 'title' ? 'Greet Message Title' : 'Greet Message Color').addComponents(new ActionRowBuilder().addComponents(input)));
      }
      if (opt === 'message') {
        return void await h.startTextCapture(i, {
          title: '💬 Send your welcome message', hint: 'Send the message text **below this panel**. Use `{user}`, `{server}` and `{count}`.',
          maxLength: 1500, current: cfgOf(gid).message,
          onSave: async text => { save(gid, { message: text }); },
          render: () => render(gid, ['✅ Message saved.'])
        });
      }
      if (opt === 'image') {
        return void await h.startTextCapture(i, {
          title: '🖼️ Send your image or GIF', hint: 'Upload an image/GIF **or** paste an image link as a message below.', accept: 'image',
          onSave: async v => { save(gid, { image: typeof v === 'string' ? v : v.url }); },
          render: () => render(gid, ['✅ Image saved.'])
        });
      }
      if (opt === 'clear_image') { await i.deferUpdate(); save(gid, { image: null }); return void await i.editReply(render(gid, ['🗑️ Image removed.'])); }
      return true;
    }

    if (i.isButton()) {
      const action = id.split(':')[1];
      if (action === 'test') {
        await i.deferUpdate();
        const c = cfgOf(gid); const ch = i.channel;
        await ch.send(buildGreetPayload(i.guild, i.user, c, { test: true })).catch(() => {});
        return void await i.editReply(render(gid, ['👁️ Preview posted in this channel.']));
      }
      await i.deferUpdate();
      const c = cfgOf(gid);
      if (action === 'toggle') {
        if (!c.enabled && !c.channelId) return void await i.editReply(render(gid, ['⚠️ Choose a welcome channel first.']));
        save(gid, { enabled: !c.enabled });
      } else if (action === 'ping') save(gid, { ping: c.ping === false });
      else if (action === 'avatar') save(gid, { showAvatar: c.showAvatar === false });
      else if (action === 'reset') save(gid, { ...db.DEFAULT_CONFIG.greetmessage });
      return void await i.editReply(render(gid));
    }
  } catch (e) {
    console.error('[GreetMessage] interaction failed:', e);
    await h.safeReply(i, { embeds: [h.errorEmbed('Greet Message error', String(e?.message || e).slice(0, 1200))], ephemeral: true });
  }
  return true;
}

module.exports = { commands: [command], handleInteraction, buildGreetPayload };
