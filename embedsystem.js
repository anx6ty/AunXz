'use strict';
// AunXz saved-embed system: /embed create | edit | delete | send | list.
// Embeds are looked up by NAME (case-insensitive, whitespace-normalised) and stored under a stable internal id.
const crypto = require('crypto');
const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, ChannelType
} = require('discord.js');
const dbm = require('./database');
const ui = require('./ui');

const LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, fields: 25, footer: 2048, author: 256, total: 6000, buttons: 10, buttonLabel: 80, buttonUrl: 512, name: 64, perGuild: 250 };
const SESSION_TTL = 20 * 60 * 1000;
const CONFIRM_TTL = 2 * 60 * 1000;
const MAX_EDITORS_PER_USER = 5;
const sessions = new Map();

// ───────────────────────── pure helpers ─────────────────────────
const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
function isHttpUrl(value, max = 2048) {
    const s = str(value).trim();
    if (!s || s.length > max)
        return false;
    try {
        const u = new URL(s);
        return u.protocol === 'https:' || u.protocol === 'http:';
    }
    catch {
        return false;
    }
}
function parseColor(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xFFFFFF)
        return value;
    let s = str(value).trim().replace(/^#/, '').replace(/^0x/i, '');
    if (/^[0-9a-f]{3}$/i.test(s))
        s = s.split('').map(c => c + c).join('');
    return /^[0-9a-f]{6}$/i.test(s) ? parseInt(s, 16) : null;
}
function isValidButtonEmoji(value) {
    const s = str(value).trim();
    return /^<a?:[A-Za-z0-9_~.-]{2,32}:\d{15,25}>$/.test(s) || /^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\uFE0F)*$/u.test(s);
}
function emptyDraft() {
    return { v: 2, title: '', titleUrl: '', description: '', color: '', author: { name: '', iconUrl: '', url: '' }, footer: { text: '', iconUrl: '' }, thumbnailUrl: '', imageUrl: '', timestamp: false, fields: [], buttons: [] };
}
// Accepts the v2 shape AND older/foreign shapes (e.g. template snapshots) without throwing.
function normalizeDraft(raw) {
    const d = emptyDraft();
    if (!raw || typeof raw !== 'object')
        return d;
    d.title = str(raw.title).slice(0, LIMITS.title);
    d.titleUrl = str(raw.titleUrl || raw.url);
    d.description = str(raw.description).slice(0, LIMITS.description);
    if (typeof raw.color === 'number')
        d.color = '#' + raw.color.toString(16).padStart(6, '0').toUpperCase();
    else
        d.color = str(raw.color);
    const a = raw.author;
    if (a && typeof a === 'object')
        d.author = { name: str(a.name), iconUrl: str(a.iconUrl || a.icon_url), url: str(a.url) };
    else if (typeof a === 'string')
        d.author.name = a;
    const f = raw.footer;
    if (f && typeof f === 'object')
        d.footer = { text: str(f.text), iconUrl: str(f.iconUrl || f.icon_url) };
    else if (typeof f === 'string')
        d.footer.text = f;
    const img = raw.imageUrl ?? raw.image;
    d.imageUrl = str(img && typeof img === 'object' ? img.url : img);
    const th = raw.thumbnailUrl ?? raw.thumbnail;
    d.thumbnailUrl = str(th && typeof th === 'object' ? th.url : th);
    d.timestamp = !!raw.timestamp;
    if (Array.isArray(raw.fields))
        d.fields = raw.fields.filter(x => x && (x.name || x.value)).slice(0, LIMITS.fields).map(x => ({ name: str(x.name).slice(0, LIMITS.fieldName), value: str(x.value).slice(0, LIMITS.fieldValue), inline: !!x.inline }));
    if (Array.isArray(raw.buttons))
        d.buttons = raw.buttons.filter(b => b && b.label && (b.url || b.targetId)).slice(0, LIMITS.buttons).map(b => (b.targetId
            ? { label: str(b.label).slice(0, LIMITS.buttonLabel), targetId: str(b.targetId), targetName: str(b.targetName), emoji: b.emoji ? str(b.emoji) : '' }
            : { label: str(b.label).slice(0, LIMITS.buttonLabel), url: str(b.url), emoji: b.emoji ? str(b.emoji) : '' }));
    return d;
}
function embedLength(d) {
    return d.title.length + d.description.length + d.footer.text.length + d.author.name.length +
        d.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
}
function hasContent(d) {
    return !!(d.title || d.description || d.fields.length || d.imageUrl || d.author.name || d.footer.text);
}
// Returns a list of human-readable problems; empty list = safe to save/send.
function validateDraft(d) {
    const p = [];
    if (!hasContent(d))
        p.push('The embed is empty — add a title, description, field, image, author or footer.');
    if (d.title.length > LIMITS.title)
        p.push(`Title is over ${LIMITS.title} characters.`);
    if (d.description.length > LIMITS.description)
        p.push(`Description is over ${LIMITS.description} characters.`);
    if (d.author.name.length > LIMITS.author)
        p.push(`Author name is over ${LIMITS.author} characters.`);
    if (d.footer.text.length > LIMITS.footer)
        p.push(`Footer is over ${LIMITS.footer} characters.`);
    if (d.fields.length > LIMITS.fields)
        p.push(`Too many fields (max ${LIMITS.fields}).`);
    d.fields.forEach((f, i) => {
        if (!f.name || !f.value)
            p.push(`Field ${i + 1} needs both a name and a value.`);
        if (f.name.length > LIMITS.fieldName || f.value.length > LIMITS.fieldValue)
            p.push(`Field ${i + 1} is too long.`);
    });
    if (embedLength(d) > LIMITS.total)
        p.push(`Total embed text is ${embedLength(d)}/${LIMITS.total} characters.`);
    if (d.color && parseColor(d.color) === null)
        p.push('Color must be a hex code like #5865F2.');
    for (const [label, v] of [['Title link', d.titleUrl], ['Author link', d.author.url], ['Author icon', d.author.iconUrl], ['Footer icon', d.footer.iconUrl], ['Image', d.imageUrl], ['Thumbnail', d.thumbnailUrl]])
        if (v && !isHttpUrl(v))
            p.push(`${label} must be a valid http(s) URL.`);
    if ((d.author.iconUrl || d.author.url) && !d.author.name)
        p.push('Author icon/link need an author name.');
    if (d.footer.iconUrl && !d.footer.text)
        p.push('Footer icon needs footer text.');
    if (d.buttons.length > LIMITS.buttons)
        p.push(`Too many buttons (max ${LIMITS.buttons}).`);
    d.buttons.forEach((b, i) => {
        if (!b.label || b.label.length > LIMITS.buttonLabel)
            p.push(`Button ${i + 1} needs a label (max ${LIMITS.buttonLabel}).`);
        if (b.targetId) {
            if (typeof b.targetId !== 'string' || b.targetId.length > 64)
                p.push(`Button ${i + 1} has an invalid target embed.`);
        }
        else if (!isHttpUrl(b.url, LIMITS.buttonUrl))
            p.push(`Button ${i + 1} needs a target embed.`);
        if (b.emoji && !isValidButtonEmoji(b.emoji))
            p.push(`Button ${i + 1} has an invalid emoji.`);
    });
    return p;
}
function buildEmbed(d, { placeholder = false } = {}) {
    const e = new EmbedBuilder().setColor(parseColor(d.color) ?? ui.THEME);
    if (d.title)
        e.setTitle(d.title);
    if (d.titleUrl && d.title && isHttpUrl(d.titleUrl))
        e.setURL(d.titleUrl);
    if (d.description)
        e.setDescription(d.description);
    else if (placeholder && !hasContent(d))
        e.setDescription('*Empty embed — use the buttons below to start building.*');
    if (d.author.name)
        e.setAuthor({ name: d.author.name, ...(isHttpUrl(d.author.iconUrl) ? { iconURL: d.author.iconUrl } : {}), ...(isHttpUrl(d.author.url) ? { url: d.author.url } : {}) });
    if (d.footer.text)
        e.setFooter({ text: d.footer.text, ...(isHttpUrl(d.footer.iconUrl) ? { iconURL: d.footer.iconUrl } : {}) });
    if (isHttpUrl(d.imageUrl))
        e.setImage(d.imageUrl);
    if (isHttpUrl(d.thumbnailUrl))
        e.setThumbnail(d.thumbnailUrl);
    if (d.fields.length)
        e.addFields(d.fields.map(f => ({ name: f.name, value: f.value, inline: !!f.inline })));
    if (d.timestamp)
        e.setTimestamp();
    return e;
}
// Buttons: reveal buttons (customId embreveal:<embedId>) show another saved embed privately; legacy URL buttons stay link buttons.
function buildLinkRows(d) {
    const btns = d.buttons.map(b => {
        const btn = b.targetId
            ? new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel(b.label).setCustomId(`embreveal:${b.targetId}`)
            : new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(b.label).setURL(b.url);
        if (b.emoji)
            btn.setEmoji(b.emoji.trim());
        return btn;
    });
    const rows = [];
    for (let k = 0; k < btns.length; k += 5)
        rows.push(new ActionRowBuilder().addComponents(btns.slice(k, k + 5)));
    return rows;
}
// Every reveal button must point at an existing, readable embed of THIS server.
function targetProblems(d, guildId) {
    const p = [];
    d.buttons.forEach((b, i) => {
        if (!b.targetId) return;
        const row = dbm.getSavedEmbedById(b.targetId);
        if (!row || row.guildId !== guildId) p.push(`Button ${i + 1} points to an embed that no longer exists.`);
        else if (!row.data) p.push(`Button ${i + 1} points to an unreadable embed.`);
    });
    return p;
}
function cleanName(name) { return dbm.normalizeEmbedName(name); }
function validateName(name) {
    const n = cleanName(name);
    if (!n)
        return { error: 'Give the embed a name (letters, numbers and spaces).' };
    if (n.length > LIMITS.name)
        return { error: `Embed names are limited to ${LIMITS.name} characters.` };
    return { name: n };
}

// ───────────────────────── permissions ─────────────────────────
function botOwner(id) {
    try { return !!require('./ownertools').isOwner(id); }
    catch { return false; }
}
function isManager(i) {
    const p = i.memberPermissions || i.member?.permissions;
    return !!(botOwner(i.user?.id) || i.guild?.ownerId === i.user?.id || p?.has(PermissionFlagsBits.Administrator) || p?.has(PermissionFlagsBits.ManageGuild));
}
function canUse(i) {
    const p = i.memberPermissions || i.member?.permissions;
    return isManager(i) || !!p?.has(PermissionFlagsBits.ManageMessages);
}
// Owner of the embed, or a server manager / bot owner. Legacy rows (no owner) are manager-only.
function canModify(i, row) {
    return !!row && ((row.ownerId && row.ownerId === i.user.id) || isManager(i));
}

// ───────────────────────── response helpers ─────────────────────────
const E = {
    err: (t, d) => ui.errorEmbed(t, d), ok: (t, d) => ui.okEmbed(t, d), warn: (t, d) => ui.warnEmbed(t, d), info: (t, d) => ui.infoEmbed(t, d)
};
async function respond(i, payload) {
    const p = { ephemeral: true, ...payload };
    if (i.deferred)
        return i.editReply(payload);
    if (i.replied)
        return i.followUp(p);
    return i.reply(p);
}
const fail = (i, title, text) => respond(i, { embeds: [E.err(title, text)] });
function friendlyError(e) {
    const code = e?.code;
    if (code === 50013 || code === 50001) return 'I am missing permissions in that channel (View Channel, Send Messages and Embed Links are required).';
    if (code === 10003) return 'That channel no longer exists.';
    if (code === 50035) return 'Discord rejected the embed (invalid content or size). Preview it and fix any warnings.';
    if (code === 40062 || e?.status === 429) return 'Discord is rate-limiting me right now. Try again in a few seconds.';
    if (code === 10062 || code === 10008) return 'That interaction expired. Run the command again.';
    return 'Something went wrong. The error was logged for the bot owner.';
}
function logError(where, e, i) {
    console.error(`[Embed] ${where} failed (guild ${i?.guildId || '?'}, user ${i?.user?.id || '?'}):`, e);
}

// ───────────────────────── sessions ─────────────────────────
const newSid = () => crypto.randomBytes(5).toString('hex');
function sweep() {
    const now = Date.now();
    for (const [k, s] of sessions)
        if (s.expiresAt < now)
            sessions.delete(k);
}
const sweeper = setInterval(sweep, 60 * 1000);
if (sweeper.unref) sweeper.unref();
function openSession(data, ttl = SESSION_TTL) {
    sweep();
    if (data.type === 'editor') {
        const mine = [...sessions.entries()].filter(([, s]) => s.type === 'editor' && s.userId === data.userId && s.guildId === data.guildId);
        while (mine.length >= MAX_EDITORS_PER_USER)
            sessions.delete(mine.shift()[0]);
    }
    const sid = newSid();
    sessions.set(sid, { ...data, ttl, expiresAt: Date.now() + ttl });
    return sid;
}

// ───────────────────────── editor UI ─────────────────────────
function editorPayload(sid, s) {
    const d = s.draft;
    const problems = validateDraft(d).filter(x => !(x.startsWith('The embed is empty') && !hasContent(d)) || true);
    const head = `${ui.emoji('settings')} **AunXz Embed Editor** · ${s.mode === 'edit' ? 'editing' : 'creating'} **${s.name}** · ${embedLength(d)}/${LIMITS.total} chars` +
        (problems.length ? `\n⚠️ ${problems.slice(0, 3).join(' · ')}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ''}` : '\n✅ Ready to save — press **Preview** to see the final result.');
    const b = (action, label, style, emoji, disabled = false) => {
        const x = new ButtonBuilder().setCustomId(`emb:${sid}:${action}`).setLabel(label).setStyle(style);
        if (emoji) x.setEmoji(emoji);
        return x.setDisabled(!!disabled);
    };
    const S = ButtonStyle;
    const rows = [
        new ActionRowBuilder().addComponents(b('text', 'Text', S.Primary, '📝'), b('style', 'Style', S.Primary, '🎨'), b('author', 'Author', S.Secondary, '👤'), b('footer', 'Footer', S.Secondary, '🔻'), b('images', 'Images', S.Secondary, '🖼️')),
        new ActionRowBuilder().addComponents(b('field', 'Field', S.Secondary, '➕', d.fields.length >= LIMITS.fields), b('button', 'Button', S.Secondary, '🔘', d.buttons.length >= LIMITS.buttons), b('ts', d.timestamp ? 'Time: On' : 'Time: Off', d.timestamp ? S.Success : S.Secondary, '🕒'), b('preview', 'Preview', S.Primary, '👁️'))
    ];
    if (d.fields.length)
        rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`emb:${sid}:rmf`).setPlaceholder(`Remove a field (${d.fields.length})…`)
            .addOptions(d.fields.slice(0, 25).map((f, i) => ({ label: `${i + 1}. ${f.name}`.slice(0, 100), value: String(i) })))));
    if (d.buttons.length)
        rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`emb:${sid}:rmb`).setPlaceholder(`Remove a button (${d.buttons.length})…`)
            .addOptions(d.buttons.slice(0, 10).map((x, i) => ({ label: `${i + 1}. ${x.label}${x.targetName ? ` → ${x.targetName}` : ''}`.slice(0, 100), value: String(i) })))));
    const last = [b('save', 'Save', S.Success, '💾'), b('cancel', 'Cancel', S.Secondary, '✖️')];
    if (s.mode === 'edit')
        last.push(b('del', 'Delete', S.Danger, '🗑️'));
    rows.push(new ActionRowBuilder().addComponents(last));
    return { content: head, embeds: [buildEmbed(d, { placeholder: true })], components: rows };
}
const input = (id, label, { long = false, value = '', max, placeholder, required = false } = {}) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label.slice(0, 45)).setStyle(long ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(required);
    if (max) t.setMaxLength(max);
    if (placeholder) t.setPlaceholder(placeholder.slice(0, 100));
    if (value) t.setValue(str(value).slice(0, max || 4000));
    return new ActionRowBuilder().addComponents(t);
};
function modalFor(sid, kind, d) {
    const m = new ModalBuilder().setCustomId(`emb:${sid}:m_${kind}`);
    switch (kind) {
        case 'text': return m.setTitle('Title & Description').addComponents(input('title', 'Title', { value: d.title, max: LIMITS.title }), input('description', 'Description', { long: true, value: d.description, max: 4000 }));
        case 'style': return m.setTitle('Color & Title Link').addComponents(input('color', 'Color (hex, blank = default)', { value: d.color, max: 9, placeholder: '#5865F2' }), input('titleUrl', 'Title link (https://…)', { value: d.titleUrl, max: 500 }));
        case 'author': return m.setTitle('Author').addComponents(input('name', 'Author name', { value: d.author.name, max: LIMITS.author }), input('iconUrl', 'Author icon URL', { value: d.author.iconUrl, max: 500 }), input('url', 'Author link URL', { value: d.author.url, max: 500 }));
        case 'footer': return m.setTitle('Footer').addComponents(input('text', 'Footer text', { value: d.footer.text, max: LIMITS.footer }), input('iconUrl', 'Footer icon URL', { value: d.footer.iconUrl, max: 500 }));
        case 'images': return m.setTitle('Images').addComponents(input('imageUrl', 'Large image URL', { value: d.imageUrl, max: 500 }), input('thumbnailUrl', 'Thumbnail URL', { value: d.thumbnailUrl, max: 500 }));
        case 'field': return m.setTitle('Add Field').addComponents(input('name', 'Field name', { required: true, max: LIMITS.fieldName }), input('value', 'Field value', { long: true, required: true, max: LIMITS.fieldValue }), input('inline', 'Inline? (yes / no)', { max: 5, placeholder: 'no' }));
        case 'button': return m.setTitle('Add Embed Button').addComponents(input('label', 'Button label', { required: true, max: LIMITS.buttonLabel }), input('embed', 'Name of the saved embed to reveal', { required: true, max: LIMITS.name }), input('emoji', 'Emoji (optional)', { max: 64 }));
        default: return null;
    }
}
// Applies a modal submission to a COPY of the draft. Returns { draft } or { error }.
function applyModal(draft, kind, get, resolve = () => null) {
    const n = JSON.parse(JSON.stringify(draft));
    const url = (v, label) => (v && !isHttpUrl(v) ? `${label} must be a valid http(s) URL.` : null);
    let err = null;
    if (kind === 'text') { n.title = get('title'); n.description = get('description'); }
    else if (kind === 'style') {
        n.color = get('color'); n.titleUrl = get('titleUrl');
        err = (n.color && parseColor(n.color) === null ? 'Color must be a hex code like #5865F2.' : null) || url(n.titleUrl, 'Title link');
        if (!err && n.color) n.color = '#' + parseColor(n.color).toString(16).padStart(6, '0').toUpperCase();
    }
    else if (kind === 'author') {
        n.author = { name: get('name'), iconUrl: get('iconUrl'), url: get('url') };
        err = url(n.author.iconUrl, 'Author icon') || url(n.author.url, 'Author link') || ((n.author.iconUrl || n.author.url) && !n.author.name ? 'Author icon/link need an author name.' : null);
    }
    else if (kind === 'footer') {
        n.footer = { text: get('text'), iconUrl: get('iconUrl') };
        err = url(n.footer.iconUrl, 'Footer icon') || (n.footer.iconUrl && !n.footer.text ? 'Footer icon needs footer text.' : null);
    }
    else if (kind === 'images') {
        n.imageUrl = get('imageUrl'); n.thumbnailUrl = get('thumbnailUrl');
        err = url(n.imageUrl, 'Image') || url(n.thumbnailUrl, 'Thumbnail');
    }
    else if (kind === 'field') {
        if (n.fields.length >= LIMITS.fields) err = `An embed can have at most ${LIMITS.fields} fields.`;
        else if (!get('name') || !get('value')) err = 'A field needs both a name and a value.';
        else n.fields.push({ name: get('name'), value: get('value'), inline: /^(y|yes|true|1|on)$/i.test(get('inline')) });
    }
    else if (kind === 'button') {
        const label = get('label'), emoji = get('emoji');
        const target = get('embed') ? resolve(get('embed')) : null;
        if (n.buttons.length >= LIMITS.buttons) err = `At most ${LIMITS.buttons} buttons fit on one embed.`;
        else if (!label) err = 'A button needs a label.';
        else if (!get('embed')) err = 'Enter the name of the saved embed this button should reveal.';
        else if (!target) err = `No saved embed named **${cleanName(get('embed')).slice(0, 64)}** exists in this server. Create it first with \`/embed create\`.`;
        else if (!target.data) err = `**${target.name}** has damaged data and cannot be used.`;
        else if (emoji && !isValidButtonEmoji(emoji)) err = 'That emoji is not valid. Use a standard emoji or <:name:id>.';
        else n.buttons.push({ label, targetId: target.id, targetName: target.name, emoji });
    }
    else err = 'Unknown editor section.';
    if (!err && embedLength(n) > LIMITS.total) err = `That would push the embed over Discord's ${LIMITS.total}-character limit (${embedLength(n)}).`;
    return err ? { error: err } : { draft: n };
}

// ───────────────────────── command ─────────────────────────
const nameOption = (o, desc = 'Embed name') => o.setName('name').setDescription(desc).setRequired(true).setMaxLength(LIMITS.name);
const SEND_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread];
const command = {
    data: new SlashCommandBuilder().setName('embed').setDescription('Create, edit, send and delete saved embeds by name.')
        .setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addSubcommand(s => s.setName('create').setDescription('Build and save a new embed.').addStringOption(o => nameOption(o, 'Name for the new embed')))
        .addSubcommand(s => s.setName('edit').setDescription('Edit a saved embed.').addStringOption(o => nameOption(o).setAutocomplete(true)))
        .addSubcommand(s => s.setName('delete').setDescription('Delete a saved embed.').addStringOption(o => nameOption(o).setAutocomplete(true)))
        .addSubcommand(s => s.setName('send').setDescription('Send a saved embed to a channel.').addStringOption(o => nameOption(o).setAutocomplete(true))
            .addChannelOption(o => o.setName('channel').setDescription('Where to send it (default: this channel)').addChannelTypes(...SEND_TYPES).setRequired(false)))
        .addSubcommand(s => s.setName('list').setDescription('List the saved embeds in this server.')),
    async execute(i) {
        if (!i.guildId || !i.guild)
            return fail(i, 'Server Only', 'Embeds are saved per server — use this command inside a server.');
        if (!canUse(i))
            return fail(i, 'Missing Permissions', 'You need **Manage Messages** (or Manage Server) to use `/embed`.');
        const sub = i.options.getSubcommand();
        try {
            if (sub === 'create') return await cmdCreate(i);
            if (sub === 'edit') return await cmdEdit(i);
            if (sub === 'delete') return await cmdDelete(i);
            if (sub === 'send') return await cmdSend(i);
            if (sub === 'list') return await cmdList(i);
        }
        catch (e) {
            logError(`/embed ${sub}`, e, i);
            return fail(i, 'Embed Error', friendlyError(e)).catch(() => { });
        }
    }
};
function notFound(i, name) {
    return fail(i, 'Embed Not Found', `No saved embed named **${cleanName(name).slice(0, 64)}** in this server. Names are not case-sensitive — try \`/embed list\`.`);
}
async function lookup(i) {
    const v = validateName(i.options.getString('name'));
    if (v.error)
        return { error: v.error };
    const row = dbm.findSavedEmbed(i.guildId, v.name);
    return row ? { row, name: v.name } : { missing: v.name };
}
async function cmdCreate(i) {
    const v = validateName(i.options.getString('name'));
    if (v.error)
        return fail(i, 'Invalid Name', v.error);
    if (dbm.findSavedEmbed(i.guildId, v.name))
        return fail(i, 'Name Already Used', `An embed named **${v.name}** already exists. Pick another name, or change it with \`/embed edit\`.`);
    if (dbm.listSavedEmbeds(i.guildId).length >= LIMITS.perGuild)
        return fail(i, 'Limit Reached', `This server already has ${LIMITS.perGuild} saved embeds. Delete some first.`);
    const s = { type: 'editor', mode: 'create', userId: i.user.id, guildId: i.guildId, name: v.name, embedId: null, version: 0, draft: emptyDraft() };
    const sid = openSession(s);
    return i.reply({ ...editorPayload(sid, sessions.get(sid)), ephemeral: true });
}
async function cmdEdit(i) {
    const r = await lookup(i);
    if (r.error) return fail(i, 'Invalid Name', r.error);
    if (r.missing) return notFound(i, r.missing);
    if (!canModify(i, r.row))
        return fail(i, 'Not Your Embed', `**${r.row.name}** belongs to ${r.row.ownerId ? `<@${r.row.ownerId}>` : 'the server'}. Only its owner or a server manager can edit it.`);
    if (!r.row.data)
        return fail(i, 'Embed Unreadable', `**${r.row.name}** has damaged data and cannot be opened. A manager can remove it with \`/embed delete\`.`);
    const s = { type: 'editor', mode: 'edit', userId: i.user.id, guildId: i.guildId, name: r.row.name, embedId: r.row.id, version: r.row.updatedAt, draft: normalizeDraft(r.row.data) };
    const sid = openSession(s);
    return i.reply({ ...editorPayload(sid, sessions.get(sid)), ephemeral: true });
}
function deletePrompt(i, row) {
    const sid = openSession({ type: 'delete', userId: i.user.id, guildId: i.guildId, embedId: row.id, name: row.name }, CONFIRM_TTL);
    const mk = (a, l, st) => new ButtonBuilder().setCustomId(`emb:${sid}:${a}`).setLabel(l).setStyle(st);
    return {
        embeds: [E.warn('Delete Embed?', `This permanently deletes the saved embed **${row.name}**. Messages already sent are not affected.\nThis prompt expires in 2 minutes.`)],
        components: [new ActionRowBuilder().addComponents(mk('delyes', 'Confirm Delete', ButtonStyle.Danger), mk('delno', 'Cancel', ButtonStyle.Secondary))]
    };
}
async function cmdDelete(i) {
    const r = await lookup(i);
    if (r.error) return fail(i, 'Invalid Name', r.error);
    if (r.missing) return notFound(i, r.missing);
    if (!canModify(i, r.row))
        return fail(i, 'Not Your Embed', `Only the owner of **${r.row.name}** or a server manager can delete it.`);
    return i.reply({ ...deletePrompt(i, r.row), ephemeral: true });
}
const SEND_NEEDS = [['ViewChannel', 'View Channel'], ['SendMessages', 'Send Messages'], ['EmbedLinks', 'Embed Links']];
function missingPerms(perms, isThread) {
    const needs = SEND_NEEDS.map(x => x.slice());
    if (isThread) needs[1] = ['SendMessagesInThreads', 'Send Messages in Threads'];
    return needs.filter(([flag]) => !perms || !perms.has(PermissionFlagsBits[flag])).map(([, label]) => label);
}
async function cmdSend(i) {
    const r = await lookup(i);
    if (r.error) return fail(i, 'Invalid Name', r.error);
    if (r.missing) return notFound(i, r.missing);
    if (!r.row.data)
        return fail(i, 'Embed Unreadable', `**${r.row.name}** has damaged data and cannot be sent.`);
    const opt = i.options.getChannel('channel');
    const channelId = opt ? opt.id : i.channelId;
    let channel = i.guild.channels.cache.get(channelId) || await i.guild.channels.fetch(channelId).catch(() => null);
    if (!channel)
        return fail(i, 'Channel Not Found', opt ? 'I cannot see that channel.' : 'I cannot access this channel to send the embed.');
    if (channel.guildId !== i.guildId || !SEND_TYPES.includes(channel.type) || typeof channel.send !== 'function')
        return fail(i, 'Invalid Channel', 'Pick a text, announcement or thread channel in this server.');
    const isThread = typeof channel.isThread === 'function' && channel.isThread();
    const me = i.guild.members.me || await i.guild.members.fetchMe().catch(() => null);
    const botMissing = missingPerms(me ? channel.permissionsFor(me) : null, isThread);
    if (botMissing.length)
        return fail(i, 'I Cannot Send There', `I am missing in ${channel}: **${botMissing.join(', ')}**.`);
    const userMissing = missingPerms(channel.permissionsFor(i.member), isThread);
    if (userMissing.length)
        return fail(i, 'You Cannot Send There', `You are missing in ${channel}: **${userMissing.join(', ')}**.`);
    const draft = normalizeDraft(r.row.data);
    const problems = [...validateDraft(draft), ...targetProblems(draft, i.guildId)];
    if (problems.length)
        return fail(i, 'Embed Is Invalid', `Fix this with \`/embed edit\` first:\n• ${problems.slice(0, 5).join('\n• ')}`);
    await i.deferReply({ ephemeral: true });
    let sent;
    try {
        sent = await channel.send({ embeds: [buildEmbed(draft)], components: buildLinkRows(draft), allowedMentions: { parse: [] } });
    }
    catch (e) {
        logError('/embed send', e, i);
        return i.editReply({ embeds: [E.err('Send Failed', friendlyError(e))] });
    }
    return i.editReply({ embeds: [E.ok('Embed Sent', `**${r.row.name}** was posted in ${channel}${sent?.url ? ` — [jump to message](${sent.url})` : ''}.`)] });
}
async function cmdList(i) {
    const rows = dbm.listSavedEmbeds(i.guildId);
    if (!rows.length)
        return respond(i, { embeds: [E.info('Saved Embeds', 'No saved embeds yet. Create one with `/embed create`.')] });
    const lines = rows.slice(0, 25).map(r => `• **${r.name}** — ${r.ownerId ? `<@${r.ownerId}>` : 'server'} · <t:${Math.floor(r.updatedAt / 1000)}:R>`);
    return respond(i, { embeds: [E.info(`Saved Embeds (${rows.length})`, lines.join('\n') + (rows.length > 25 ? `\n…and ${rows.length - 25} more.` : ''))] });
}
async function handleAutocomplete(i) {
    if (i.commandName !== 'embed')
        return false;
    try {
        if (!i.guildId) return await i.respond([]), true;
        const q = dbm.embedNameKey(i.options.getFocused());
        const out = dbm.listSavedEmbeds(i.guildId).filter(r => !q || dbm.embedNameKey(r.name).includes(q)).slice(0, 25).map(r => ({ name: r.name.slice(0, 100), value: r.name }));
        await i.respond(out);
    }
    catch { await i.respond([]).catch(() => { }); }
    return true;
}

// ───────────────────────── component / modal handling ─────────────────────────
async function showModalSafe(i, modal) { return i.showModal(modal); }
async function refresh(i, sid, s) {
    const payload = editorPayload(sid, s);
    if (i.isModalSubmit?.() && !i.isFromMessage?.())
        return i.reply({ ...payload, ephemeral: true });
    return i.update(payload);
}
// A reveal button on a sent embed: shows the target saved embed privately to whoever clicked it.
async function handleReveal(i) {
    try {
        const row = i.guildId ? dbm.getSavedEmbedById(i.customId.slice('embreveal:'.length)) : null;
        if (!row || row.guildId !== i.guildId) {
            await respond(i, { embeds: [E.warn('Embed Not Found', 'The embed this button points to no longer exists.')] });
            return true;
        }
        const draft = row.data ? normalizeDraft(row.data) : null;
        if (!draft || validateDraft(draft).length) {
            await respond(i, { embeds: [E.warn('Embed Unavailable', 'This embed is damaged or invalid. Ask a server manager to fix it with `/embed edit`.')] });
            return true;
        }
        await i.reply({ embeds: [buildEmbed(draft)], components: buildLinkRows(draft), ephemeral: true });
    }
    catch (e) {
        logError('reveal', e, i);
        await respond(i, { embeds: [E.err('Embed Error', friendlyError(e))] }).catch(() => { });
    }
    return true;
}
async function handleInteraction(i) {
    const id = i.customId;
    if (typeof id === 'string' && id.startsWith('embreveal:') && i.isButton?.())
        return handleReveal(i);
    if (typeof id !== 'string' || !id.startsWith('emb:'))
        return false;
    try {
        const [, sid, action] = id.split(':');
        const s = sessions.get(sid);
        if (!s || s.expiresAt < Date.now()) {
            sessions.delete(sid);
            await respond(i, { embeds: [E.warn('Expired', 'This editor or prompt has expired. Run the `/embed` command again.')] });
            return true;
        }
        if (i.user.id !== s.userId) {
            await respond(i, { embeds: [E.err('Not Your Session', 'Only the person who opened this can use these controls.')] });
            return true;
        }
        if (i.guildId !== s.guildId || !canUse(i)) {
            await respond(i, { embeds: [E.err('Missing Permissions', 'You no longer have permission to manage embeds here.')] });
            return true;
        }
        s.expiresAt = Date.now() + (s.ttl || SESSION_TTL);
        if (s.type === 'delete')
            return await handleDelete(i, sid, s, action);
        return await handleEditor(i, sid, s, action);
    }
    catch (e) {
        logError('interaction', e, i);
        await respond(i, { embeds: [E.err('Embed Error', friendlyError(e))] }).catch(() => { });
        return true;
    }
}
async function handleDelete(i, sid, s, action) {
    sessions.delete(sid);
    if (action === 'delno')
        return await i.update({ embeds: [E.info('Delete Cancelled', `**${s.name}** was not deleted.`)], components: [] }), true;
    if (action !== 'delyes')
        return true;
    const row = dbm.getSavedEmbedById(s.embedId);
    if (!row)
        return await i.update({ embeds: [E.info('Already Deleted', `**${s.name}** no longer exists.`)], components: [] }), true;
    if (!canModify(i, row))
        return await i.update({ embeds: [E.err('Not Allowed', 'Only the owner or a server manager can delete this embed.')], components: [] }), true;
    const ok = dbm.deleteSavedEmbedById(row.id);
    await i.update({ embeds: [ok ? E.ok('Embed Deleted', `**${row.name}** was deleted.`) : E.info('Already Deleted', `**${row.name}** no longer exists.`)], components: [] });
    return true;
}
async function handleEditor(i, sid, s, action) {
    const d = s.draft;
    if (i.isModalSubmit?.()) {
        const kind = action.replace(/^m_/, '');
        const r = applyModal(d, kind, k => str(i.fields.getTextInputValue(k)).trim(), n => dbm.findSavedEmbed(i.guildId, n));
        if (r.error) {
            await respond(i, { embeds: [E.err('Invalid Input', r.error)] });
            return true;
        }
        s.draft = r.draft;
        await refresh(i, sid, s);
        return true;
    }
    if (i.isStringSelectMenu?.()) {
        const idx = Number(i.values?.[0]);
        if (action === 'rmf' && Number.isInteger(idx) && idx >= 0 && idx < d.fields.length) d.fields.splice(idx, 1);
        else if (action === 'rmb' && Number.isInteger(idx) && idx >= 0 && idx < d.buttons.length) d.buttons.splice(idx, 1);
        await i.update(editorPayload(sid, s));
        return true;
    }
    switch (action) {
        case 'text': case 'style': case 'author': case 'footer': case 'images': case 'field': case 'button':
            await showModalSafe(i, modalFor(sid, action, d));
            return true;
        case 'ts':
            d.timestamp = !d.timestamp;
            await i.update(editorPayload(sid, s));
            return true;
        case 'preview': {
            const problems = validateDraft(d);
            await i.reply({
                content: problems.length ? `⚠️ Not ready to save:\n• ${problems.slice(0, 6).join('\n• ')}` : '👁️ Preview — exactly what will be sent:',
                embeds: [buildEmbed(d, { placeholder: true })], components: problems.some(p => p.startsWith('Button')) ? [] : buildLinkRows(d), ephemeral: true
            });
            return true;
        }
        case 'cancel':
            sessions.delete(sid);
            await i.update({ content: null, embeds: [E.info('Cancelled', 'Nothing was saved.')], components: [] });
            return true;
        case 'del': {
            const row = dbm.getSavedEmbedById(s.embedId);
            if (!row) { await respond(i, { embeds: [E.info('Already Deleted', `**${s.name}** no longer exists.`)] }); return true; }
            if (!canModify(i, row)) { await respond(i, { embeds: [E.err('Not Allowed', 'Only the owner or a server manager can delete this embed.')] }); return true; }
            await i.reply({ ...deletePrompt(i, row), ephemeral: true });
            return true;
        }
        case 'save':
            return await saveSession(i, sid, s);
        default:
            return true;
    }
}
async function saveSession(i, sid, s) {
    const problems = [...validateDraft(s.draft), ...targetProblems(s.draft, i.guildId)];
    if (problems.length) {
        await respond(i, { embeds: [E.err('Cannot Save Yet', `• ${problems.slice(0, 8).join('\n• ')}`)] });
        return true;
    }
    const data = { ...s.draft, v: 2 };
    let result;
    try {
        if (s.mode === 'create') {
            result = dbm.createSavedEmbed(i.guildId, s.name, data, s.userId);
        }
        else {
            const row = dbm.getSavedEmbedById(s.embedId);
            if (!row) { sessions.delete(sid); await i.update({ content: null, embeds: [E.err('Embed Deleted', `**${s.name}** was deleted while you were editing, so your changes were not saved.`)], components: [] }); return true; }
            if (!canModify(i, row)) { await respond(i, { embeds: [E.err('Not Allowed', 'You can no longer modify this embed.')] }); return true; }
            result = dbm.updateSavedEmbed(s.embedId, s.version, data);
        }
    }
    catch (e) {
        logError('save', e, i);
        await respond(i, { embeds: [E.err('Save Failed', 'The embed could not be saved. Your editor is still open — try again.')] });
        return true;
    }
    if (!result.ok) {
        const msg = result.reason === 'duplicate' ? `Another embed named **${s.name}** was created while you were editing. Cancel and use \`/embed edit ${s.name}\`.`
            : result.reason === 'missing' ? `**${s.name}** was deleted while you were editing.`
                : `**${s.name}** was changed by someone else while you were editing. Cancel and re-open it with \`/embed edit\` so you don't overwrite their changes.`;
        await respond(i, { embeds: [E.err('Save Conflict', msg)] });
        return true;
    }
    sessions.delete(sid);
    await i.update({ content: `✅ **${s.name}** ${s.mode === 'create' ? 'saved' : 'updated'}. Send it with \`/embed send name:${s.name}\`.`, embeds: [buildEmbed(s.draft)], components: [] });
    return true;
}

module.exports = {
    command, commands: [command], handleInteraction, handleAutocomplete,
    _internals: { sessions, LIMITS, normalizeDraft, validateDraft, applyModal, parseColor, isHttpUrl, isValidButtonEmoji, embedLength, canModify, canUse, missingPerms, emptyDraft, openSession, cmdSend }
};
