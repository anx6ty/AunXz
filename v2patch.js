// v2patch.js — turns every embed the bot sends into a Discord Components V2 container
// (accent bar, text, thumbnail, image, footer) with the message's buttons / select menus
// placed INSIDE the container. It also makes interaction responses resilient:
//   • reply() after defer/reply  -> editReply()/followUp()   (no "already acknowledged")
//   • update() after defer       -> editReply()
//   • editReply()/update() that hit Unknown Message (10008) -> followUp()/channel.send()
//   • an auto-defer watchdog so slow handlers never miss Discord's 3-second window
// Works as a drop-in: require('./v2patch').apply() once at startup.

const D = require('discord.js');
const {
  ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder, MediaGalleryBuilder,
  MediaGalleryItemBuilder, SeparatorBuilder, SeparatorSpacingSize, FileBuilder, MessageFlags,
  MessagePayload, Message, ActionRowBuilder
} = D;

const V2 = MessageFlags.IsComponentsV2;
const EPH = MessageFlags.Ephemeral;
const MAX_TEXT = 3900;      // Discord: ~4000 chars of text across a whole V2 message
const MAX_COMPONENTS = 40;  // Discord: 40 components per V2 message (nested ones count)
const IMG = /\.(png|jpe?g|gif|webp)(\?|$)/i;

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s; };
const asJSON = x => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);
const flagBits = f => { try { return Number(new D.MessageFlagsBitField(f ?? 0).bitfield); } catch { return Number(f || 0); } };
const isHttpOrAttachment = u => /^(https?:\/\/|attachment:\/\/)/i.test(String(u || ''));

// ---------------------------------------------------------------------------------
// embed -> container
// ---------------------------------------------------------------------------------
function embedText(e) {
  const parts = [];
  if (e.title) parts.push(`## ${e.title}`);
  if (e.author?.name) parts.push(`**${e.author.name}**`);
  if (e.description) parts.push(e.description);
  const fields = e.fields || [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    parts.push(`**${f.name}**\n${f.value}`);
  }
  return parts;
}

function embedToContainer(embedLike, rows = [], budget = { left: MAX_TEXT }) {
  const e = asJSON(embedLike) || {};
  const c = new ContainerBuilder();
  if (typeof e.color === 'number') c.setAccentColor(e.color);

  let body = embedText(e).join('\n\n');
  const footer = [e.footer?.text, e.timestamp ? `<t:${Math.floor(new Date(e.timestamp).getTime() / 1000)}:f>` : null].filter(Boolean).join(' • ');
  const reserve = footer ? Math.min(footer.length + 4, 300) : 0;
  body = clip(body || '\u200b', Math.max(200, budget.left - reserve));
  budget.left -= body.length;

  const thumb = e.thumbnail?.url;
  if (thumb && isHttpOrAttachment(thumb)) {
    c.addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)));
  } else {
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  }
  if (e.image?.url && isHttpOrAttachment(e.image.url)) {
    c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(e.image.url)));
  }
  if (footer) {
    const f = clip(footer, Math.max(0, budget.left));
    if (f) { c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${f}`)); budget.left -= f.length + 3; }
  }
  if (rows.length) {
    c.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    for (const r of rows) c.addActionRowComponents(r);
  }
  return c;
}

function countRow(r) { const j = asJSON(r); return 1 + (j?.components?.length || 0); }
function rowsOf(components) {
  const flat = [];
  const walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v) flat.push(v); };
  walk(components);                                   // callers sometimes pass [[row, row]]
  return flat.map(r => (r instanceof ActionRowBuilder ? r : ActionRowBuilder.from(asJSON(r))))
    .filter(r => (asJSON(r)?.components?.length || 0) > 0);   // Discord rejects empty rows
}
/**
 * Convert legacy { content, embeds, components, files } into a V2 payload.
 * `edit` adds content:null / embeds:[] so a legacy message can be turned into a V2 one.
 */
function toV2(options, { edit = false, force = false } = {}) {
  if (!options || typeof options !== 'object' || options instanceof MessagePayload) return options;
  if (flagBits(options.flags) & V2) return options;                      // already V2
  const embeds = (options.embeds || []).filter(Boolean);
  const rows = rowsOf(options.components);
  const hasContent = typeof options.content === 'string' && options.content.length > 0;
  const needs = embeds.length > 0 || (rows.length > 0 && hasContent) || (force && (hasContent || rows.length > 0));
  if (!needs) return options;

  const budget = { left: MAX_TEXT };
  const top = [];
  if (hasContent) {
    const t = clip(options.content, 1500); budget.left -= t.length;
    top.push(new TextDisplayBuilder().setContent(t));
  }
  const files = options.files || [];
  const fileNames = files.map(f => f?.name || f?.attachment?.name || (typeof f === 'string' ? f.split('/').pop() : null)).filter(Boolean);

  // distribute component budget: 1 per container + rows (+children) + text pieces
  let used = top.length + fileNames.length;
  const out = [...top];
  const pieces = embeds.length ? embeds : [{}];
  let rowsLeft = rows.slice();
  pieces.forEach((emb, idx) => {
    const last = idx === pieces.length - 1;
    let mine = [];
    if (last) {
      // keep as many rows as fit
      let cost = used + 6 + (pieces.length - idx - 1) * 3;
      for (const r of rowsLeft) { const n = countRow(r); if (cost + n + 2 > MAX_COMPONENTS) break; mine.push(r); cost += n; }
    }
    const c = embedToContainer(emb, mine, { left: Math.max(300, Math.floor(budget.left / (pieces.length - idx))) });
    used += 5 + mine.reduce((a, r) => a + countRow(r), 0);
    out.push(c);
  });
  // a message made only of components (no embed) but with rows, e.g. content+rows already handled above
  for (const n of fileNames) {
    if (IMG.test(n)) out.push(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${n}`)));
    else out.push(new FileBuilder().setURL(`attachment://${n}`));
  }

  const next = { ...options, components: out };
  delete next.embeds; delete next.content;
  let flags = flagBits(options.flags) | V2;
  if (options.ephemeral) { flags |= EPH; delete next.ephemeral; }
  next.flags = flags;
  if (edit) { next.content = null; next.embeds = []; delete next.flags; next.flags = flags & ~EPH; }
  return next;
}

// ---------------------------------------------------------------------------------
// resilient responses
// ---------------------------------------------------------------------------------
const DEAD = new Set([10008, 10062, 10015, 40060]);
const codeOf = e => e?.code ?? e?.rawError?.code;

async function withFallback(primary, fallback) {
  try { return await primary(); }
  catch (e) {
    if (!DEAD.has(codeOf(e)) || !fallback) throw e;
    try { return await fallback(e); }
    catch (e2) { if (DEAD.has(codeOf(e2))) { console.warn('[v2patch] response target is gone:', e2.message); return null; } throw e2; }
  }
}

function patchInteractionClass(Cls) {
  if (!Cls || Cls.prototype.__v2patched) return;
  const p = Cls.prototype; p.__v2patched = true;
  const { reply, editReply, followUp, update } = p;

  const stripEdit = o => { const { ephemeral, ...rest } = o || {}; return rest; };

  if (reply) p.reply = function (options) {
    if (this.deferred || this.replied) {
      return (this.deferred && !this.replied ? this.editReply(stripEdit(options)) : this.followUp(options));
    }
    return reply.call(this, toV2(options));
  };
  if (followUp) p.followUp = function (options) {
    const o = toV2(options);
    return withFallback(() => followUp.call(this, o), () => this.channel?.send?.(stripEdit(toV2(options))));
  };
  if (editReply) p.editReply = function (options) {
    const force = !!(this.message?.flags && flagBits(this.message.flags) & V2) || !!this.__v2;
    const o = typeof options === 'string' ? { content: options } : options;
    const v = toV2(o, { edit: true, force });
    if (v !== o) this.__v2 = true;
    return withFallback(() => editReply.call(this, v), () => followUp.call(this, { ...toV2(stripEdit(o)), ephemeral: this.ephemeral ?? true }));
  };
  if (update) p.update = function (options) {
    if (this.deferred || this.replied) return this.editReply(options);
    const force = !!(this.message?.flags && flagBits(this.message.flags) & V2);
    const o = typeof options === 'string' ? { content: options } : options;
    return withFallback(() => update.call(this, toV2(o, { edit: true, force })), () => this.followUp({ ...stripEdit(o), ephemeral: true }));
  };
}

let applied = false;
function apply() {
  if (applied) return; applied = true;
  for (const n of ['CommandInteraction', 'MessageComponentInteraction', 'ModalSubmitInteraction']) patchInteractionClass(D[n]);

  // Every outgoing message body (channel.send, message.reply, webhooks…) passes through here.
  const origResolve = MessagePayload.prototype.resolveBody;
  MessagePayload.prototype.resolveBody = function () {
    if (this.body) return this;
    try { if (this.options && typeof this.options === 'object') this.options = toV2(this.options); }
    catch (e) { console.warn('[v2patch] conversion skipped:', e.message); }
    return origResolve.call(this);
  };

  // Message.edit on an existing message must null the legacy fields when turning it into V2.
  const origEdit = Message.prototype.edit;
  Message.prototype.edit = function (options) {
    const force = !!(flagBits(this.flags) & V2);
    const o = typeof options === 'string' ? { content: options } : options;
    return origEdit.call(this, toV2(o, { edit: true, force }));
  };
}

// Auto-ack: if a handler has not answered within `ms`, defer so the token never expires.
function wrapInteraction(interaction, ms = 2200) {
  if (!interaction || interaction.__v2watch || interaction.isAutocomplete?.()) return interaction;
  interaction.__v2watch = true;
  const t = setTimeout(async () => {
    if (interaction.replied || interaction.deferred) return;
    try {
      if (interaction.isMessageComponent?.() || (interaction.isModalSubmit?.() && interaction.message)) await interaction.deferUpdate();
      else await interaction.deferReply({ ephemeral: true });
    } catch (e) { /* already answered */ }
  }, ms);
  t.unref?.();
  return interaction;
}

module.exports = { apply, wrapInteraction, withFallback, toV2, embedToContainer, V2 };
