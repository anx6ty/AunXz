// sticky.js — /stickymessage (and `<prefix> stickymessage`): keeps an embed as the LAST message
// of a channel. One sticky per channel, multiple channels per server.
//
// Design notes
//  * The sticky is posted/deleted through the REST API directly so it is a REAL embed with exactly
//    the colors/footer/image the admin chose (the global v2patch would otherwise wrap it in a container).
//  * Reposts go through a per-channel debounce + serial queue: a burst of messages produces ONE repost,
//    a repost can never overlap another one, and a message that arrives mid-repost schedules one more run.
//  * Database: table `sticky_messages` (channelId, embed data, lastMessageId, enabled).

const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, Routes
} = require('discord.js');
const db = require('./database');
const ui = require('./ui');
const h = require('./helpers');

const REQUIRED_PERMS = [
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages
];
const DEBOUNCE_MS = 1500;   // wait this long after the last message before reposting
const MAX_WAIT_MS = 5000;   // ...but never delay longer than this on a busy channel
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const drafts = new Map();   // `${guildId}:${userId}` -> { channelId, data, existed }
const draftKey = (guildId, userId) => `${guildId}:${userId}`;

// ---------------------------------------------------------------------------------
// Embed data -> raw embed JSON / preview
// ---------------------------------------------------------------------------------
function embedJSON(data = {}) {
  const e = {};
  if (data.title) e.title = String(data.title).slice(0, 256);
  if (data.description) e.description = String(data.description).slice(0, 4096);
  if (Number.isInteger(data.color)) e.color = data.color;
  else e.color = ui.THEME;
  if (data.footer) e.footer = { text: String(data.footer).slice(0, 2048) };
  if (data.image) e.image = { url: data.image };
  if (!e.title && !e.description) e.description = '\u200b';
  return e;
}
function previewEmbed(data = {}) {
  const hasContent = data.title || data.description;
  return EmbedBuilder.from(hasContent ? embedJSON(data) : { title: 'Live preview', description: '*Press **Write Embed** to design your sticky message.*', color: ui.THEME });
}

// ---------------------------------------------------------------------------------
// Repost engine (debounced, serialised per channel)
// ---------------------------------------------------------------------------------
const queues = new Map();      // channelId -> { timer, running, dirty, first }
const lastNotice = new Map();  // channelId -> timestamp of last "I can't repost" notice

async function repost(client, channelId) {
  const row = db.getSticky(channelId);
  if (!row || !row.enabled) return { skipped: true };

  let channel = client.channels.cache.get(channelId);
  if (!channel) {
    try { channel = await client.channels.fetch(channelId); }
    catch (e) {
      if (e?.code === 10003) { db.deleteSticky(channelId); console.warn(`[Sticky] channel ${channelId} was deleted — sticky removed.`); return { removed: true }; }
      throw new Error(`I can no longer access <#${channelId}> (${e?.message || 'unknown error'}).`);
    }
  }
  const missing = h.missingChannelPerms(channel, channel.guild?.members?.me, REQUIRED_PERMS);
  if (missing.length) throw new Error(`I'm missing **${missing.join(', ')}** in ${channel}.`);

  // Delete the previous sticky (already-deleted is fine), then send the new one.
  if (row.lastMessageId) {
    await client.rest.delete(Routes.channelMessage(channelId, row.lastMessageId)).catch(e => {
      if (e?.code !== 10008) console.warn(`[Sticky] could not delete old sticky in ${channelId}: ${e?.message || e}`);
    });
  }
  const sent = await client.rest.post(Routes.channelMessages(channelId), { body: { embeds: [embedJSON(row.data)] } });
  db.setStickyMessageId(channelId, sent.id);
  return { messageId: sent.id };
}

function scheduleRepost(client, channelId) {
  let q = queues.get(channelId);
  if (!q) { q = { timer: null, running: false, dirty: false, first: 0 }; queues.set(channelId, q); }
  if (q.running) { q.dirty = true; return; }           // a repost is in flight: run once more afterwards
  if (!q.first) q.first = Date.now();
  clearTimeout(q.timer);
  const wait = Math.min(DEBOUNCE_MS, Math.max(0, MAX_WAIT_MS - (Date.now() - q.first)));
  q.timer = setTimeout(() => runQueue(client, channelId, q), wait);
  q.timer.unref?.();
}
async function runQueue(client, channelId, q) {
  q.running = true; q.first = 0;
  try {
    do {
      q.dirty = false;
      try { await repost(client, channelId); }
      catch (e) { await notifyFailure(client, channelId, e); }
    } while (q.dirty);
  } finally { q.running = false; if (!q.dirty) queues.delete(channelId); }
}
async function notifyFailure(client, channelId, error) {
  console.error(`[Sticky] repost failed in ${channelId}:`, error?.message || error);
  const row = db.getSticky(channelId);
  if (!row || Date.now() - (lastNotice.get(channelId) || 0) < 3600000) return;   // at most 1 notice/hour/channel
  lastNotice.set(channelId, Date.now());
  const logId = db.getConfig(row.guildId).logs?.server || db.getConfig(row.guildId).logs?.mod;
  const log = logId ? client.channels.cache.get(logId) : null;
  if (log?.isTextBased()) log.send({ embeds: [h.errorEmbed('Sticky message could not be reposted', `${String(error?.message || error).slice(0, 900)}\n**Channel:** <#${channelId}>`)] }).catch(() => {});
}

// Wired once from index.js. Separate from the command engine so a sticky always follows chat.
function attach(client) {
  client.on('messageCreate', message => {
    try {
      if (!message.guild || message.author?.bot || message.system) return;
      const row = db.getSticky(message.channelId);
      if (row?.enabled) scheduleRepost(client, message.channelId);
    } catch (e) { console.error('[Sticky] messageCreate hook failed:', e); }
  });
  client.on('channelDelete', channel => {
    try { if (db.deleteSticky(channel.id)) console.log(`[Sticky] removed sticky for deleted channel ${channel.id}`); }
    catch (e) { console.error('[Sticky] channelDelete hook failed:', e); }
  });
}

// ---------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------
function panelPayload(guildId, userId, guild) {
  const draft = drafts.get(draftKey(guildId, userId)) || { channelId: null, data: {}, existed: false };
  const d = draft.data || {};
  const existing = draft.channelId ? db.getSticky(draft.channelId) : null;
  const ready = !!(draft.channelId && (d.title || d.description));
  const embed = ui.base(`${h.THEME.emoji.settings()} Sticky Message`).setDescription(
    'Pick a channel, write the embed, check the preview, then **Save**. The sticky is re-posted after every member message so it stays the last message.'
  ).addFields(
    { name: 'Channel', value: draft.channelId ? `<#${draft.channelId}>` : 'Not selected', inline: true },
    { name: 'Mode', value: draft.existed ? 'Editing existing' : (existing ? 'Will replace existing' : 'New sticky'), inline: true },
    { name: 'Ready to save', value: ready ? 'Yes' : 'Needs channel + title/description', inline: true }
  );
  const select = new ChannelSelectMenuBuilder().setCustomId(`stk:channel:${userId}`).setPlaceholder(draft.channelId ? 'Change channel…' : 'Select the sticky channel…').setChannelTypes(...TEXT_CHANNELS);
  if (draft.channelId) select.setDefaultChannels(draft.channelId);
  return {
    embeds: [embed, previewEmbed(d)],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`stk:write:${userId}`).setLabel('Write Embed').setStyle(ButtonStyle.Primary).setEmoji(h.THEME.emoji.edit),
        new ButtonBuilder().setCustomId(`stk:save:${userId}`).setLabel('Save').setStyle(ButtonStyle.Success).setEmoji(h.THEME.emoji.ok()).setDisabled(!ready),
        new ButtonBuilder().setCustomId(`stk:cancel:${userId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger)
      )
    ]
  };
}

function writeModal(userId, data = {}) {
  const input = (id, label, style, required, max, value, placeholder) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max);
    if (placeholder) t.setPlaceholder(placeholder);
    if (value !== undefined && value !== null && value !== '') t.setValue(String(value).slice(0, max));
    return new ActionRowBuilder().addComponents(t);
  };
  return new ModalBuilder().setCustomId(`stk:modal:${userId}`).setTitle('Sticky Message Embed').addComponents(
    input('title', 'Title (optional)', TextInputStyle.Short, false, 256, data.title),
    input('description', 'Description', TextInputStyle.Paragraph, true, 4000, data.description),
    input('color', 'Color hex (optional)', TextInputStyle.Short, false, 7, Number.isInteger(data.color) ? '#' + data.color.toString(16).padStart(6, '0') : '', '#5865F2'),
    input('footer', 'Footer (optional)', TextInputStyle.Short, false, 200, data.footer),
    input('image', 'Image URL (optional)', TextInputStyle.Short, false, 500, data.image, 'https://…')
  );
}

// ---------------------------------------------------------------------------------
// Actions shared by panel + command
// ---------------------------------------------------------------------------------
async function saveFromDraft(interaction, draft) {
  const channel = interaction.guild.channels.cache.get(draft.channelId) || await interaction.guild.channels.fetch(draft.channelId).catch(() => null);
  if (!channel) throw new Error('That channel no longer exists. Pick another channel.');
  const missing = h.missingChannelPerms(channel, interaction.guild.members.me, REQUIRED_PERMS);
  if (missing.length) throw new Error(`I'm missing **${missing.join(', ')}** in ${channel}. Grant those permissions and press Save again.`);

  const prev = db.getSticky(draft.channelId);
  db.saveSticky(interaction.guildId, draft.channelId, { data: draft.data, enabled: true, createdBy: interaction.user.id });
  try {
    await repost(interaction.client, draft.channelId);
  } catch (e) {
    // Roll back so we never report a sticky that does not exist.
    if (prev) db.saveSticky(interaction.guildId, draft.channelId, { data: prev.data, enabled: prev.enabled, createdBy: prev.createdBy });
    else db.deleteSticky(draft.channelId);
    throw e;
  }
  return channel;
}

function describeRow(row, guild) {
  const ch = guild.channels.cache.get(row.channelId);
  const title = row.data?.title || String(row.data?.description || '').replace(/\s+/g, ' ').slice(0, 60) || '(empty)';
  const link = row.lastMessageId ? ` • [jump](https://discord.com/channels/${row.guildId}/${row.channelId}/${row.lastMessageId})` : '';
  return `${ch ? `<#${row.channelId}>` : `~~${row.channelId}~~ *(channel missing)*`} — ${row.enabled ? `${h.THEME.emoji.on()} On` : `${h.THEME.emoji.off()} Off`} — **${h.clip(title, 60)}**${link}`;
}

// ---------------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------------
const command = {
  data: new SlashCommandBuilder().setName('stickymessage').setDescription('Keep an embed pinned as the last message in a channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption(o => o.setName('action').setDescription('What to do (default: open the setup panel)')
      .addChoices({ name: 'panel — create or replace a sticky', value: 'panel' }, { name: 'edit — edit a channel\'s sticky', value: 'edit' },
        { name: 'view — show a channel\'s sticky', value: 'view' }, { name: 'list — all stickies in this server', value: 'list' },
        { name: 'toggle — turn a channel\'s sticky on/off', value: 'toggle' }, { name: 'remove — delete a channel\'s sticky', value: 'remove' }))
    .addChannelOption(o => o.setName('channel').setDescription('Target channel (default: this channel)').addChannelTypes(...TEXT_CHANNELS)),

  async execute(interaction) {
    if (!interaction.guild) return h.safeReply(interaction, { embeds: [h.errorEmbed('Server only', 'Sticky messages only work inside a server.')], ephemeral: true });
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return h.safeReply(interaction, { embeds: [h.errorEmbed('Missing permissions', 'You need **Manage Messages** to manage sticky messages.')], ephemeral: true });
    }
    const action = interaction.options.getString('action') || 'panel';
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const guild = interaction.guild;

    if (action === 'list') {
      const lines = db.listStickies(guild.id).map(r => describeRow(r, guild));
      return h.paginate(interaction, h.listPages({ title: `${h.THEME.emoji.list} Sticky messages`, lines, emptyHint: 'Create one with `/stickymessage`.', perPage: 8 }), { ephemeral: true });
    }

    if (action === 'panel' || action === 'edit') {
      const existing = db.getSticky(channel.id);
      if (action === 'edit' && !existing) {
        return h.safeReply(interaction, { embeds: [h.errorEmbed('No sticky here', `${channel} has no sticky message yet. Use \`/stickymessage\` to create one.`)], ephemeral: true });
      }
      drafts.set(draftKey(guild.id, interaction.user.id), {
        channelId: TEXT_CHANNELS.includes(channel.type) ? channel.id : null,
        data: existing ? { ...existing.data } : {}, existed: !!existing
      });
      const render = () => panelPayload(guild.id, interaction.user.id, guild);
      const sent = await h.safeReply(interaction, { ...render(), ephemeral: true });
      h.watchPanel(interaction, sent, render);
      return;
    }

    // view / toggle / remove need an existing sticky in the chosen channel
    const row = db.getSticky(channel.id);
    if (!row) return h.safeReply(interaction, { embeds: [h.errorEmbed('No sticky here', `${channel} has no sticky message. Use \`/stickymessage\` to create one.`)], ephemeral: true });

    if (action === 'view') {
      const info = ui.base(`${h.THEME.emoji.list} Sticky in #${channel.name}`).setDescription(describeRow(row, guild))
        .addFields({ name: 'Status', value: row.enabled ? 'Enabled' : 'Disabled', inline: true }, { name: 'Updated', value: `<t:${Math.floor(row.updatedAt / 1000)}:R>`, inline: true });
      return h.safeReply(interaction, { embeds: [info, previewEmbed(row.data)], ephemeral: true });
    }

    if (action === 'toggle') {
      const next = !row.enabled;
      db.setStickyEnabled(channel.id, next);
      if (next) {
        try { await repost(interaction.client, channel.id); }
        catch (e) {
          db.setStickyEnabled(channel.id, false);
          return h.safeReply(interaction, { embeds: [h.errorEmbed('Could not enable sticky', String(e.message || e))], ephemeral: true });
        }
      }
      return h.safeReply(interaction, { embeds: [h.successEmbed('Sticky updated', `Sticky message in ${channel} is now **${next ? 'enabled' : 'disabled'}**.`)], ephemeral: true });
    }

    if (action === 'remove') {
      const render = () => ({
        embeds: [h.warnEmbed('Remove sticky message?', `This deletes the sticky in ${channel} and its saved embed.`)],
        components: [h.confirmRow(`stk:rm:${interaction.user.id}:${channel.id}`, { yes: 'Remove' })]
      });
      const sent = await h.safeReply(interaction, { ...render(), ephemeral: true });
      h.watchPanel(interaction, sent, render, 30000);   // buttons disable after 30s
    }
  }
};

// ---------------------------------------------------------------------------------
// Interaction routing (customIds start with `stk:`). Returns true when handled.
// ---------------------------------------------------------------------------------
async function handleInteraction(interaction) {
  const id = interaction.customId;
  if (!id || !id.startsWith('stk:')) return false;
  const parts = id.split(':');
  const action = parts[1];

  try {
    if (action === 'rm') {                                    // stk:rm:<userId>:<channelId>:yes|no
      const [, , userId, channelId, choice] = parts;
      if (!await h.authorOnly(interaction, userId)) return true;
      if (choice !== 'yes') return void await interaction.update({ embeds: [h.infoEmbed('Cancelled', 'The sticky message was kept.')], components: [] });
      const row = db.getSticky(channelId);
      if (row?.lastMessageId) await interaction.client.rest.delete(Routes.channelMessage(channelId, row.lastMessageId)).catch(() => {});
      const removed = db.deleteSticky(channelId);
      return void await interaction.update({ embeds: [removed ? h.successEmbed('Sticky removed', `The sticky in <#${channelId}> was deleted.`) : h.errorEmbed('Nothing to remove', 'That sticky no longer exists.')], components: [] });
    }

    const userId = parts[2];
    if (!await h.authorOnly(interaction, userId)) return true;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.reply({ embeds: [h.errorEmbed('Missing permissions', 'You need **Manage Messages** to use this panel.')], ephemeral: true });
      return true;
    }
    const key = draftKey(interaction.guildId, userId);
    const draft = drafts.get(key);
    if (!draft && action !== 'cancel') {
      await interaction.reply({ embeds: [h.warnEmbed('Panel expired', 'Run `/stickymessage` again to start a new panel.')], ephemeral: true });
      return true;
    }

    if (action === 'channel' && interaction.isChannelSelectMenu()) {
      draft.channelId = interaction.values[0];
      draft.existed = false;
      return void await interaction.update(panelPayload(interaction.guildId, userId, interaction.guild));
    }
    if (action === 'write' && interaction.isButton()) return void await interaction.showModal(writeModal(userId, draft.data));
    if (action === 'cancel') {
      drafts.delete(key);
      return void await interaction.update({ embeds: [h.infoEmbed('Cancelled', 'No sticky message was changed.')], components: [] });
    }
    if (action === 'modal' && interaction.isModalSubmit()) {
      const get = name => interaction.fields.getTextInputValue(name).trim();
      const colorRaw = get('color'); const image = get('image');
      const color = colorRaw ? h.parseHexColor(colorRaw) : null;
      const problems = [];
      if (colorRaw && color === null) problems.push('Color must be a hex code like `#5865F2`.');
      if (image && !h.isHttpUrl(image)) problems.push('Image must be a valid `https://` link.');
      if (!get('description')) problems.push('Description cannot be empty.');
      if (problems.length) {
        return void await interaction.reply({ embeds: [h.errorEmbed('Invalid input', problems.join('\n'))], ephemeral: true });
      }
      draft.data = { title: get('title') || undefined, description: get('description'), color: color ?? undefined, footer: get('footer') || undefined, image: image || undefined };
      const payload = panelPayload(interaction.guildId, userId, interaction.guild);
      return void await (interaction.isFromMessage?.() ? interaction.update(payload) : interaction.reply({ ...payload, ephemeral: true }));
    }
    if (action === 'save' && interaction.isButton()) {
      await interaction.deferUpdate();
      try {
        const channel = await saveFromDraft(interaction, draft);
        drafts.delete(key);
        return void await interaction.editReply({ embeds: [h.successEmbed('Sticky message saved', `The sticky is live in ${channel}. It will be re-posted after each member message.`), previewEmbed(draft.data)], components: [] });
      } catch (e) {
        console.error('[Sticky] save failed:', e);
        return void await interaction.followUp({ embeds: [h.errorEmbed('Could not save sticky', String(e.message || e).slice(0, 1500))], ephemeral: true });
      }
    }
  } catch (e) {
    console.error('[Sticky] interaction failed:', e);
    await h.safeReply(interaction, { embeds: [h.errorEmbed('Sticky message error', String(e.message || e).slice(0, 1500))], ephemeral: true });
  }
  return true;
}

module.exports = { command, commands: [command], attach, handleInteraction, repost, scheduleRepost, _internals: { embedJSON, queues } };
