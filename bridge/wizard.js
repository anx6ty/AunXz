'use strict';

// Interactive AI template generator. It creates a preview first; a second, explicit
// destructive confirmation is required before the existing template loader runs.
const {
  SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder,
  ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits
} = require('discord.js');
const { generateTemplate } = require('./generate');
const templateLoader = require('../template');
const ui = require('../ui');

const sessions = new Map();
const TTL = 15 * 60 * 1000;
const THEMES = [
  { label: 'Gaming', value: 'Gaming', emoji: '🎮', desc: 'gaming community, LFG, game news and voice rooms' },
  { label: 'Marketplace', value: 'Marketplace', emoji: '🛒', desc: 'buying, selling, listings, trade rules and support' },
  { label: 'Community', value: 'Community', emoji: '🌐', desc: 'welcoming community, introductions, discussion and events' },
  { label: 'Bots Server', value: 'Bots Server', emoji: '🤖', desc: 'bot support, commands, updates, bug reports and documentation' },
  { label: 'Other', value: 'Other', emoji: '✨', desc: '' }
];
const EMOJI_MODES = [
  { label: 'Same emoji per category', value: 'category', description: 'Use a consistent emoji for each category group.' },
  { label: 'Different emoji per channel', value: 'channel', description: 'Give channels their own relevant emoji.' }
];
const NAMING = [
  { label: 'Emoji + Divider', value: 'emoji-divider' },
  { label: 'Tree Structure', value: 'tree' },
  { label: 'Decorative Unicode', value: 'unicode' },
  { label: 'Emoji + Decorative Symbols', value: 'emoji-symbols' },
  { label: 'Minimal', value: 'minimal' },
  { label: 'AI Auto-Select', value: 'auto' }
];

const command = {
  data: new SlashCommandBuilder()
    .setName('templategen')
    .setDescription('Design an AI server template, preview it, then confirm before applying it.'),
  async execute(interaction) {
    if (!interaction.guild) return interaction.reply({ embeds: [ui.errorEmbed('Server Only', 'Run /templategen inside a server.')], ephemeral: true });
    const id = key(interaction);
    sessions.set(id, { userId: interaction.user.id, guildId: interaction.guildId, step: 'theme', createdAt: Date.now(), theme: null, emojiMode: null, naming: null, prompt: '', result: null });
    return interaction.reply({ embeds: [ui.base('✨ AunXz Template Studio').setDescription('**Step 1 of 3 — Choose a server theme.**\nI will generate a preview first. Nothing in your server changes until you confirm the final apply step.')], components: [themeRow(id)], ephemeral: true });
  }
};

function key(i) { return `${i.guildId || 'dm'}:${i.user.id}`; }
function cid(i) { return String(i.customId || '').split(':'); }
function getSession(i, parts) {
  const s = sessions.get(`${parts[2]}:${parts[3]}`);
  if (!s || s.userId !== i.user.id || s.guildId !== i.guildId || Date.now() - s.createdAt > TTL) return null;
  return s;
}
function themeRow(id) {
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`tg:theme:${id.split(':').join(':')}`).setPlaceholder('Choose a theme').addOptions(THEMES.map(t => ({ label: t.label, value: t.value, emoji: t.emoji }))));
}
function emojiRow(id) {
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`tg:emoji:${id}`).setPlaceholder('Choose emoji assignment').addOptions(EMOJI_MODES.map(x => ({ label: x.label, value: x.value, description: x.description }))));
}
function namingRow(id) {
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`tg:naming:${id}`).setPlaceholder('Choose channel naming style').addOptions(NAMING.map(x => ({ label: x.label, value: x.value }))));
}
function buttons(id, confirm = false) {
  const row = new ActionRowBuilder();
  if (confirm) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`tg:apply:${id}`).setLabel('Confirm & Apply').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`tg:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );
  } else {
    row.addComponents(
      new ButtonBuilder().setCustomId(`tg:edit:${id}`).setLabel('Edit prompt').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`tg:regen:${id}`).setLabel('Regenerate').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`tg:applyask:${id}`).setLabel('Apply template…').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`tg:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );
  }
  return row;
}
function promptModal(id, initial = '') {
  const modal = new ModalBuilder().setCustomId(`tg:prompt:${id}`).setTitle('Describe your server');
  const input = new TextInputBuilder().setCustomId('description').setLabel('Describe your server').setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Channels, roles, vibe, features and any naming preferences…').setMinLength(3).setMaxLength(1500).setRequired(true);
  if (initial) input.setValue(initial.slice(0, 1500));
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}
function themePrompt(s, description) {
  const theme = THEMES.find(t => t.value === s.theme);
  const style = NAMING.find(n => n.value === s.naming);
  const emoji = EMOJI_MODES.find(n => n.value === s.emojiMode);
  const namingGuidance = {
    'emoji-divider': 'Format channel names with a relevant emoji and a readable divider.',
    tree: 'Use tree-like category/channel naming with ╭, │ and ╰ markers where appropriate.',
    unicode: 'Use tasteful decorative Unicode separators without making names hard to read.',
    'emoji-symbols': 'Use relevant emoji plus tasteful decorative symbols.',
    minimal: 'Keep channel names clean, short and mostly plain.',
    auto: 'Choose the best naming style for the requested theme.'
  }[s.naming] || '';
  const emojiGuidance = s.emojiMode === 'category' ? 'Use a consistent emoji motif per category.' : 'Use distinct relevant emoji for individual channels.';
  return `NAMING_STYLE=${s.naming}\nCreate a Discord server template for the ${s.theme} theme (${theme?.desc || 'custom theme'}).\n${emojiGuidance}\n${namingGuidance}\nUser requirements: ${description}`;
}
function previewEmbed(s) {
  const snap = s.result.snapshot;
  const cats = snap.channels.filter(c => c.t === 4);
  const channels = snap.channels.length - cats.length;
  const roles = snap.roles.map(r => `• ${r.ue || '◆'} ${r.n}`).slice(0, 15).join('\n') || 'No custom roles';
  const groups = [];
  let current = null;
  for (const c of snap.channels) {
    if (c.t === 4) { current = { name: c.n, channels: [] }; groups.push(current); }
    else if (current && c.p >= 0) current.channels.push(c.n);
    else groups.push({ name: c.n, channels: [] });
  }
  const layout = groups.slice(0, 12).map(g => `**${g.name}**${g.channels.length ? '\n' + g.channels.slice(0, 7).map(n => `┊ #${n}`).join('\n') : ''}`).join('\n');
  return ui.base('✨ Template Preview').setDescription(
    `**${snap.name}**\n${s.prompt.slice(0, 350)}\n\n` +
    `**Layout**\n${layout.slice(0, 1800) || 'No channels'}\n\n` +
    `**Roles**\n${roles}\n\n` +
    `**Summary:** ${rolesCount(snap)} roles · ${cats.length} categories · ${channels} channels\n` +
    `**Short code:** ${s.result.shortCode ? `\`${s.result.shortCode}\`` : 'not saved'}\n` +
    `**Style:** ${s.naming} · **Emoji assignment:** ${s.emojiMode}`
  ).setFooter({ text: 'Preview only — no server changes have been made.' });
}
function rolesCount(snap) { return snap.roles.length; }

async function runGeneration(i, s, { regenerate = false } = {}) {
  await i.deferUpdate();
  try {
    const result = await generateTemplate({
      prompt: s.prompt,
      requestedBy: i.user.id,
      onStatus: status => console.log(`[templategen] ${status}`)
    });
    s.result = result;
    s.step = 'preview';
    await i.editReply({ embeds: [previewEmbed(s)], components: [buttons(`${s.guildId}:${s.userId}`)] });
  } catch (e) {
    const detail = e.code === 'missing_key' ? `${e.message}\n${e.howTo || ''}` : String(e.message || e);
    await i.editReply({ embeds: [ui.errorEmbed('Template Generation Failed', detail.slice(0, 3500))], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tg:edit:${s.guildId}:${s.userId}`).setLabel('Edit prompt').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`tg:cancel:${s.guildId}:${s.userId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))] });
  }
}

async function handleInteraction(i) {
  if (!i.customId?.startsWith('tg:')) return false;
  const p = cid(i);
  const action = p[1];
  const s = getSession(i, p);
  if (!s) {
    const payload = { embeds: [ui.errorEmbed('Session Expired', 'Run /templategen again. This wizard is private to its creator.')], components: [], ephemeral: true };
    if (i.isModalSubmit()) await i.reply(payload).catch(() => {});
    else await i.reply(payload).catch(() => {});
    return true;
  }
  if (action === 'cancel') {
    sessions.delete(`${s.guildId}:${s.userId}`);
    if (i.isModalSubmit()) await i.reply({ embeds: [ui.infoEmbed('Cancelled', 'No server changes were made.')], ephemeral: true });
    else await i.update({ embeds: [ui.infoEmbed('Cancelled', 'No server changes were made.')], components: [] });
    return true;
  }
  if (action === 'theme' && i.isStringSelectMenu()) {
    s.theme = i.values[0];
    if (s.theme === 'Other') {
      s.emojiMode = 'channel'; s.naming = 'auto';
      return i.showModal(promptModal(`${s.guildId}:${s.userId}`));
    }
    s.step = 'emoji';
    return i.update({ embeds: [ui.base('✨ AunXz Template Studio').setDescription('**Step 2 of 3 — Emoji assignment.**')], components: [emojiRow(`${s.guildId}:${s.userId}`)] });
  }
  if (action === 'emoji' && i.isStringSelectMenu()) {
    s.emojiMode = i.values[0]; s.step = 'naming';
    return i.update({ embeds: [ui.base('✨ AunXz Template Studio').setDescription('**Step 3 of 3 — Channel naming style.**')], components: [namingRow(`${s.guildId}:${s.userId}`)] });
  }
  if (action === 'naming' && i.isStringSelectMenu()) {
    s.naming = i.values[0];
    return i.showModal(promptModal(`${s.guildId}:${s.userId}`));
  }
  if (action === 'prompt' && i.isModalSubmit()) {
    const description = i.fields.getTextInputValue('description').trim();
    if (description.length < 3) return i.reply({ embeds: [ui.errorEmbed('Description Too Short', 'Please describe your server in at least 3 characters.')], ephemeral: true });
    s.prompt = themePrompt(s, description);
    // Modal submit must be acknowledged with a new ephemeral response.
    await i.deferReply({ ephemeral: true });
    try {
      s.result = await generateTemplate({ prompt: s.prompt, requestedBy: i.user.id, onStatus: status => console.log(`[templategen] ${status}`) });
      s.step = 'preview';
      return i.editReply({ embeds: [previewEmbed(s)], components: [buttons(`${s.guildId}:${s.userId}`)] });
    } catch (e) {
      const detail = e.code === 'missing_key' ? `${e.message}\n${e.howTo || ''}` : String(e.message || e);
      return i.editReply({ embeds: [ui.errorEmbed('Template Generation Failed', detail.slice(0, 3500))], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tg:edit:${s.guildId}:${s.userId}`).setLabel('Edit prompt').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`tg:cancel:${s.guildId}:${s.userId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))] });
    }
  }
  if (action === 'edit') return i.showModal(promptModal(`${s.guildId}:${s.userId}`, s.prompt.replace(/^Create a Discord server template[\s\S]*?User requirements: /, '').slice(0, 1500)));
  if (action === 'regen') {
    await i.deferUpdate();
    try {
      s.result = await generateTemplate({ prompt: s.prompt, requestedBy: i.user.id, onStatus: status => console.log(`[templategen] ${status}`) });
      return i.editReply({ embeds: [previewEmbed(s)], components: [buttons(`${s.guildId}:${s.userId}`)] });
    } catch (e) { return i.editReply({ embeds: [ui.errorEmbed('Regeneration Failed', String(e.message || e).slice(0, 3000))], components: [buttons(`${s.guildId}:${s.userId}`)] }); }
  }
  if (action === 'applyask') {
    if (!i.memberPermissions?.has(PermissionFlagsBits.Administrator)) return i.reply({ embeds: [ui.errorEmbed('Administrator Required', 'Only a server Administrator can apply a generated template.')], ephemeral: true });
    s.step = 'confirm';
    return i.update({ embeds: [ui.warnEmbed('⚠️ Confirm Server Rebuild', 'Applying this template will rebuild the server using AunXz’s existing template loader. Existing channels, roles and configured template data may be changed or removed.\n\n**No changes have been made yet.** Press **Confirm & Apply** only if you want to proceed.')], components: [buttons(`${s.guildId}:${s.userId}`, true)] });
  }
  if (action === 'apply') {
    if (s.step !== 'confirm') return i.reply({ embeds: [ui.errorEmbed('Confirmation Required', 'Review the preview and use Apply template first.')], ephemeral: true });
    if (!i.memberPermissions?.has(PermissionFlagsBits.Administrator)) return i.reply({ embeds: [ui.errorEmbed('Administrator Required', 'Only a server Administrator can apply a generated template.')], ephemeral: true });
    await i.deferUpdate();
    try {
      await i.editReply({ embeds: [ui.base('⏳ Applying Template').setDescription('Preflight passed. Starting the existing AunXz template loader…')], components: [] });
      const result = await templateLoader.runLoad(i.guild, s.result.snapshot, i.user);
      sessions.delete(`${s.guildId}:${s.userId}`);
      const summary = typeof result === 'string' ? result : 'The template loader finished. Check its progress/completion message for the detailed result.';
      return i.editReply({ embeds: [ui.okEmbed('Template Applied', summary.slice(0, 3000))], components: [] });
    } catch (e) {
      return i.editReply({ embeds: [ui.errorEmbed('Apply Failed', String(e.message || e).slice(0, 3000))], components: [] });
    }
  }
  return false;
}

module.exports = { command, handleInteraction };
