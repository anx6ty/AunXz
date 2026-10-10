// helpers.js — shared UI/UX helpers used by every new or rebuilt panel.
// One theme, one set of embed builders, one paginator, one toggle button, one confirm row.
// Everything delegates to ui.js so the look stays identical to the rest of the bot.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { randomBytes } = require('crypto');
const ui = require('./ui');

// ---------------------------------------------------------------------------------
// Theme (single source of truth for colors/emojis used by the new modules)
// ---------------------------------------------------------------------------------
const THEME = {
  main: ui.THEME, success: ui.OK, error: ui.DANGER, warning: ui.WARN, info: 0x5865F2,
  emoji: {
    on: () => ui.emoji('enabled'), off: () => ui.emoji('disabled'), ok: () => ui.emoji('success'),
    err: () => ui.emoji('error'), warn: () => ui.emoji('warning'), settings: () => ui.emoji('settings'),
    back: '◀️', home: '🏠', list: '📋', edit: '✏️', trash: () => ui.emoji('delete')
  }
};

const clip = (text, max) => { const t = String(text ?? ''); return t.length > max ? t.slice(0, Math.max(0, max - 1)) + '…' : t; };

const successEmbed = (title, desc) => ui.okEmbed(`${THEME.emoji.ok()} ${title}`, clip(desc, 4096));
const errorEmbed = (title, desc) => ui.errorEmbed(`${THEME.emoji.err()} ${title}`, clip(desc, 4096));
const warnEmbed = (title, desc) => ui.warnEmbed(`${THEME.emoji.warn()} ${title}`, clip(desc, 4096));
const infoEmbed = (title, desc) => ui.infoEmbed(title, clip(desc, 4096));
// Friendly empty state used by every list ("nothing here yet").
const emptyEmbed = (title, hint) => ui.infoEmbed(`${THEME.emoji.list} ${title}`, `Nothing here yet.${hint ? `\n${hint}` : ''}`);

// ---------------------------------------------------------------------------------
// Component builders
// ---------------------------------------------------------------------------------
// ONE button that flips state: label, emoji and color all follow `enabled`.
function toggleButton(customId, enabled, { on = 'Enabled', off = 'Disabled', prefix = '' } = {}) {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(`${prefix}${enabled ? on : off}`.slice(0, 80))
    .setStyle(enabled ? ButtonStyle.Success : ButtonStyle.Danger)
    .setEmoji(enabled ? THEME.emoji.on() : THEME.emoji.off());
}
// Confirm / Cancel row. IDs become `${prefix}:yes` and `${prefix}:no`.
function confirmRow(prefix, { yes = 'Confirm', no = 'Cancel', danger = true } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}:yes`).setLabel(yes).setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${prefix}:no`).setLabel(no).setStyle(ButtonStyle.Secondary)
  );
}
function disableRows(rows) {
  for (const row of rows || []) for (const c of row.components || []) c.setDisabled?.(true);
  return rows;
}
function backHomeRow(prefix, { back = true, home = true } = {}) {
  const row = new ActionRowBuilder();
  if (back) row.addComponents(new ButtonBuilder().setCustomId(`${prefix}:back`).setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji(THEME.emoji.back));
  if (home) row.addComponents(new ButtonBuilder().setCustomId(`${prefix}:home`).setLabel('Home').setStyle(ButtonStyle.Secondary).setEmoji(THEME.emoji.home));
  return row;
}

// ---------------------------------------------------------------------------------
// Replies that can never be left hanging
// ---------------------------------------------------------------------------------
async function safeReply(interaction, payload) {
  try {
    if (interaction.deferred && !interaction.replied) return await interaction.editReply(payload);
    if (interaction.replied || interaction.deferred) return await interaction.followUp(payload);
    return await interaction.reply(payload);
  } catch (e) {
    console.error('[helpers] safeReply failed:', e?.message || e);
    return null;
  }
}
// Component interactions: update in place, fall back to a reply.
async function safeUpdate(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply(payload);
    return await interaction.update(payload);
  } catch (e) {
    console.error('[helpers] safeUpdate failed:', e?.message || e);
    return safeReply(interaction, { ...payload, ephemeral: true });
  }
}
// Only the command author may use a panel. Everyone else gets an ephemeral notice.
async function authorOnly(interaction, ownerId) {
  if (!ownerId || interaction.user.id === ownerId) return true;
  await interaction.reply({ embeds: [errorEmbed("This isn't your menu", 'Run the command yourself to get your own panel.')], ephemeral: true }).catch(() => {});
  return false;
}

// ---------------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------------
function humanPerms(names) { return names.map(n => String(n).replace(/([a-z])([A-Z])/g, '$1 $2')).join(', '); }
function missingChannelPerms(channel, member, flags) {
  if (!channel || !member) return ['View Channel'];
  const perms = channel.permissionsFor(member);
  if (!perms) return ['View Channel'];
  return new PermissionsBitField(flags).toArray().filter(name => !perms.has(PermissionsBitField.Flags[name])).map(n => n.replace(/([a-z])([A-Z])/g, '$1 $2'));
}

// ---------------------------------------------------------------------------------
// Pagination — one helper for every list. First / Prev / page / Next / Last,
// author-only, disables itself on timeout. State lives in memory keyed by a token.
// ---------------------------------------------------------------------------------
const pageSessions = new Map();
const DEFAULT_TIMEOUT = 120000;

// Split lines into pages that respect the 4096-char description limit and a max line count.
function chunkLines(lines, { maxChars = 3800, maxLines = 10 } = {}) {
  const pages = []; let cur = []; let len = 0;
  for (const raw of lines) {
    const line = clip(raw, 900);
    if (cur.length && (cur.length >= maxLines || len + line.length + 1 > maxChars)) { pages.push(cur); cur = []; len = 0; }
    cur.push(line); len += line.length + 1;
  }
  if (cur.length) pages.push(cur);
  return pages;
}
// Build embeds from lines. Empty data -> one friendly "nothing here yet" embed.
function listPages({ title, lines, emptyHint, color, perPage = 10, thumbnail }) {
  if (!lines || !lines.length) return [emptyEmbed(title, emptyHint)];
  return chunkLines(lines, { maxLines: perPage }).map(chunk => {
    const e = ui.base(title).setDescription(chunk.join('\n'));
    if (color) e.setColor(color);
    if (thumbnail) e.setThumbnail(thumbnail);
    return e;
  });
}
function pageRow(token, index, total, disabled = false) {
  const b = (id, label, dis) => new ButtonBuilder().setCustomId(`pg:${token}:${id}`).setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(disabled || dis);
  return new ActionRowBuilder().addComponents(
    b('first', '⏮', index === 0), b('prev', '◀', index === 0),
    b('ind', `${index + 1}/${total}`, true),
    b('next', '▶', index >= total - 1), b('last', '⏭', index >= total - 1)
  );
}
function pagePayload(session, disabled = false) {
  const total = session.pages.length;
  const embed = EmbedBuilder.from(session.pages[session.index]);
  embed.setFooter({ text: disabled ? `⏱ Expired • Page ${session.index + 1}/${total}` : `Page ${session.index + 1}/${total}` });
  return { embeds: [embed], components: total > 1 ? [pageRow(session.token, session.index, total, disabled)] : [] };
}
async function paginate(interaction, pages, { ephemeral = false, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  if (!Array.isArray(pages) || !pages.length) pages = [emptyEmbed('Nothing here yet')];
  const session = {
    token: randomBytes(5).toString('hex'), userId: interaction.user.id, pages, index: 0,
    interaction, sent: null, timer: null, timeoutMs,
    isSlash: typeof interaction.fetchReply === 'function'
  };
  const payload = pagePayload(session);
  const sent = await safeReply(interaction, { ...payload, ephemeral });
  if (pages.length < 2) return sent;           // nothing to page through, no session needed
  session.sent = sent;
  pageSessions.set(session.token, session);
  armPageTimer(session);
  return sent;
}
function armPageTimer(session) {
  clearTimeout(session.timer);
  session.timer = setTimeout(async () => {
    pageSessions.delete(session.token);
    const payload = pagePayload(session, true);
    try {
      if (session.isSlash) await session.interaction.editReply(payload);
      else await session.sent?.edit?.(payload);
    } catch (e) { console.warn('[paginate] could not disable expired list:', e?.message || e); }
  }, session.timeoutMs);
  session.timer.unref?.();
}
// Routed from interactionCreate. Returns true when the interaction was a pagination button.
// The button is acknowledged FIRST (deferUpdate) so a slow render or a vanished message can never
// leave the click hanging; the page is then drawn with editReply, falling back to a fresh message.
async function handlePaginationButton(interaction) {
  if (!interaction.isButton?.() || !interaction.customId.startsWith('pg:')) return false;
  const [, token, action] = interaction.customId.split(':');
  const session = pageSessions.get(token);
  if (!session) {
    // Session lost (restart / expired): grey out the old buttons instead of ignoring the click.
    try {
      await interaction.deferUpdate();
      const disabled = (interaction.message.components || []).length;
      await interaction.editReply({ embeds: [warnEmbed('List expired', 'Run the command again to get a fresh list.')], components: [] });
      void disabled;
    } catch (e) { await interaction.reply({ embeds: [warnEmbed('List expired', 'Run the command again to get a fresh list.')], ephemeral: true }).catch(() => {}); }
    return true;
  }
  if (interaction.user.id !== session.userId) { await authorOnly(interaction, session.userId); return true; }
  try { await interaction.deferUpdate(); } catch (e) { console.warn('[paginate] deferUpdate failed:', e?.message || e); return true; }
  const last = session.pages.length - 1;
  if (action === 'first') session.index = 0;
  else if (action === 'prev') session.index = Math.max(0, session.index - 1);
  else if (action === 'next') session.index = Math.min(last, session.index + 1);
  else if (action === 'last') session.index = last;
  armPageTimer(session);
  try { await interaction.editReply(pagePayload(session)); }
  catch (e) { console.warn('[paginate] could not edit page:', e?.message || e); }
  return true;
}

// ---------------------------------------------------------------------------------
// "Send a message below to save" capture — used by setup panels (TTS prompt, greet message …).
// The admin clicks a button, the panel switches to a "send your text now" state, and the next
// message they type in that channel is saved, deleted, and the panel is redrawn.
// ---------------------------------------------------------------------------------
const textCaptures = new Map(); // `${guildId}:${userId}` -> session
async function startTextCapture(interaction, { title, hint, accept = 'text', maxLength = 1000, ttlMs = 180000, current = null, cancelPanel, onSave, render }) {
  const key = `${interaction.guildId}:${interaction.user.id}`;
  const old = textCaptures.get(key); if (old) clearTimeout(old.timer);
  const session = { interaction, accept, channelId: interaction.channelId, maxLength, onSave, render, cancelPanel, expiresAt: Date.now() + ttlMs };
  session.timer = setTimeout(async () => {
    if (textCaptures.get(key) !== session) return;
    textCaptures.delete(key);
    try { await interaction.editReply(await render()); } catch { /* message gone */ }
  }, ttlMs);
  session.timer.unref?.();
  textCaptures.set(key, session);
  const lines = [hint, `Maximum **${maxLength}** characters. Type \`cancel\` to go back.`];
  if (current) lines.push(`**Current:**\n${clip(current, 500)}`);
  const payload = { embeds: [infoEmbed(title, lines.join('\n\n'))], components: [] };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.update(payload);
}
async function consumeTextCapture(message) {
  if (!message.guild || message.author.bot) return false;
  const key = `${message.guild.id}:${message.author.id}`;
  const session = textCaptures.get(key);
  if (!session || session.channelId !== message.channelId) return false;
  if (Date.now() > session.expiresAt) { textCaptures.delete(key); return false; }
  const text = String(message.content || '').trim();
  const att = [...message.attachments.values()].find(a => {
    const type = String(a.contentType || '').toLowerCase(); const name = String(a.name || '').toLowerCase();
    if (session.accept === 'audio') return type.startsWith('audio/') || /\.(mp3|wav|ogg|oga|opus|webm|m4a|aac|flac)$/i.test(name);
    if (session.accept === 'image') return type.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(name);
    return false;
  });
  if (session.accept === 'text' && !text) return false;
  if (session.accept !== 'text' && !att && !(session.accept === 'image' && isHttpUrl(text)) && !/^cancel$/i.test(text)) return false;
  textCaptures.delete(key); clearTimeout(session.timer);
  try {
    let note = null;
    if (/^cancel$/i.test(text)) { /* leave config untouched */ }
    else if (session.accept === 'text' && text.length > session.maxLength) note = `That was ${text.length} characters — the limit is ${session.maxLength}. Nothing was saved.`;
    else if (session.accept === 'text') await session.onSave(text, message);
    else await session.onSave(att || text, message);
    await message.delete().catch(() => {});
    const payload = await session.render();
    if (note && payload.embeds?.[0]?.setFooter) payload.embeds[0].setFooter({ text: note });
    await session.interaction.editReply(payload).catch(e => console.warn('[capture] redraw failed:', e?.message || e));
  } catch (e) {
    console.error('[capture] save failed:', e);
    await session.interaction.editReply({ embeds: [errorEmbed('Could not save', String(e?.message || e).slice(0, 1500))], components: [] }).catch(() => {});
  }
  return true;
}

// ---------------------------------------------------------------------------------
// Panel expiry — any panel registered here has its components disabled after it sits idle.
// Interaction router calls touchPanel(message.id) on every component click to reset the idle clock.
// ---------------------------------------------------------------------------------
const panels = new Map(); // messageId -> { interaction, sent, render, last, ms, timer }
function watchPanel(interaction, sent, render, ms = 300000) {
  const isSlash = typeof interaction.fetchReply === 'function';
  const arm = async () => {
    let id = null;
    try { id = isSlash ? (await interaction.fetchReply()).id : sent?.id; } catch { /* ignore */ }
    if (!id) return;
    const rec = { interaction, sent, render, last: Date.now(), ms, isSlash };
    const check = async () => {
      const idle = Date.now() - rec.last;
      if (idle < rec.ms) { rec.timer = setTimeout(check, rec.ms - idle); rec.timer.unref?.(); return; }
      panels.delete(id);
      try {
        const payload = await rec.render();
        disableRows(payload.components);
        if (payload.embeds?.[0]?.setFooter) payload.embeds[0].setFooter({ text: '⏱ Panel expired — run the command again' });
        if (rec.isSlash) await rec.interaction.editReply(payload); else await rec.sent?.edit?.(payload);
      } catch (e) { console.warn('[panel] could not disable expired panel:', e?.message || e); }
    };
    rec.timer = setTimeout(check, ms); rec.timer.unref?.();
    panels.set(id, rec);
  };
  arm().catch(() => {});
}
function touchPanel(messageId) { const rec = panels.get(messageId); if (rec) rec.last = Date.now(); }

// Parses #RRGGBB / RRGGBB / 0xRRGGBB. Returns an integer or null.
function parseHexColor(input) {
  const m = String(input || '').trim().match(/^(?:#|0x)?([0-9a-f]{6})$/i);
  return m ? parseInt(m[1], 16) : null;
}
function isHttpUrl(value) { try { const u = new URL(String(value)); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; } }

module.exports = {
  THEME, clip, successEmbed, errorEmbed, warnEmbed, infoEmbed, emptyEmbed,
  toggleButton, confirmRow, disableRows, backHomeRow,
  safeReply, safeUpdate, authorOnly, humanPerms, missingChannelPerms,
  chunkLines, listPages, paginate, handlePaginationButton, startTextCapture, consumeTextCapture, watchPanel, touchPanel,
  parseHexColor, isHttpUrl
};
