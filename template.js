const zlib = require('zlib');
const crypto = require('crypto');
const { ChannelType, PermissionsBitField, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const db = require('./database');
const ui = require('./ui');
const PREFIX = 'AX-TPL';
const LEGACY_PREFIX = 'VX-TPL';
const MAX_CODE_LENGTH = 6000;
const MAX_ROLES = 250;
const MAX_CHANNELS = 500;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const secret = () => process.env.TEMPLATE_SECRET || process.env.DISCORD_TOKEN || 'aunxz-template';
const sign = payload => crypto.createHmac('sha256', secret()).update(payload).digest('base64url').slice(0, 22);
// TEMPLATE_WAIT_SCALE only exists so tests can run the loader without its rate-limit pauses; leave it unset in production.
const WAIT_SCALE = Number.isFinite(Number(process.env.TEMPLATE_WAIT_SCALE)) && process.env.TEMPLATE_WAIT_SCALE !== undefined ? Number(process.env.TEMPLATE_WAIT_SCALE) : 1;
const wait = ms => new Promise(r => setTimeout(r, ms * WAIT_SCALE));
const short = e => String(e?.rawError?.message || e?.message || e).replace(/\s+/g, ' ').slice(0, 140);
const codeOf = e => e?.code ?? e?.rawError?.code;
const SAVED_TYPES = new Set([
    ChannelType.GuildCategory, ChannelType.GuildText, ChannelType.GuildVoice,
    ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum
]);
const TEXTY = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const FALLBACK_TYPE = {
    [ChannelType.GuildAnnouncement]: ChannelType.GuildText,
    [ChannelType.GuildForum]: ChannelType.GuildText,
    [ChannelType.GuildStageVoice]: ChannelType.GuildVoice
};
async function pool(items, size, fn) {
    let next = 0;
    const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
        while (next < items.length) {
            const k = next++;
            await fn(items[k], k);
        }
    });
    await Promise.all(workers);
}
async function fetchBuffer(url, max = MAX_ASSET_BYTES) {
    if (!url)
        return null;
    try {
        const res = await fetch(url);
        if (!res.ok)
            return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length || buf.length > max)
            return null;
        return { buf, type: (res.headers.get('content-type') || 'image/png').split(';')[0] };
    }
    catch {
        return null;
    }
}
async function fetchDataUri(url) {
    const r = await fetchBuffer(url);
    return r ? `data:${r.type};base64,${r.buf.toString('base64')}` : undefined;
}
const SNOWFLAKE = /^\d{16,20}$/;
function encodeIds(value, chMap, roleMap) {
    const enc = s => {
        if (SNOWFLAKE.test(s)) {
            if (chMap.has(s))
                return `\u0001c${chMap.get(s)}`;
            if (roleMap.has(s))
                return `\u0001r${roleMap.get(s)}`;
            return s;
        }
        return s
            .replace(/<#(\d{16,20})>/g, (m, id) => (chMap.has(id) ? `<#\u0001c${chMap.get(id)}>` : m))
            .replace(/<@&(\d{16,20})>/g, (m, id) => (roleMap.has(id) ? `<@&\u0001r${roleMap.get(id)}>` : m));
    };
    const walk = v => {
        if (typeof v === 'string')
            return enc(v);
        if (Array.isArray(v))
            return v.map(walk);
        if (v && typeof v === 'object') {
            const o = {};
            for (const [k, x] of Object.entries(v))
                o[enc(k)] = walk(x);
            return o;
        }
        return v;
    };
    return walk(value);
}
function decodeIds(value, chIds, roleIds) {
    const lookup = (t, i) => (t === 'c' ? chIds[Number(i)] : roleIds[Number(i)]) || null;
    const dec = s => {
        const whole = /^\u0001([cr])(\d+)$/.exec(s);
        if (whole)
            return lookup(whole[1], whole[2]);
        return s.replace(/\u0001([cr])(\d+)/g, (m, t, i) => lookup(t, i) || '0');
    };
    const walk = v => {
        if (typeof v === 'string')
            return dec(v);
        if (Array.isArray(v))
            return v.map(walk);
        if (v && typeof v === 'object') {
            const o = {};
            for (const [k, x] of Object.entries(v)) {
                const nk = dec(k);
                if (nk)
                    o[nk] = walk(x);
            }
            return o;
        }
        return v;
    };
    return walk(value);
}
function collectCustomIds(node, out = []) {
    if (!node || typeof node !== 'object')
        return out;
    if (Array.isArray(node)) {
        node.forEach(n => collectCustomIds(n, out));
        return out;
    }
    if (node.custom_id)
        out.push(node.custom_id);
    if (node.components)
        collectCustomIds(node.components, out);
    if (node.accessory)
        collectCustomIds(node.accessory, out);
    return out;
}
// ───────────────────────── template data model (v3) ─────────────────────────
// v3 adds explicit, template-local identifiers and ordering so a template never depends on Discord snowflakes:
//   roles[]    { id:'r<n>', pos:<original role position>, ... }          (array order = top of hierarchy first)
//   channels[] { id:'c<n>', ord:<position in the saved layout>, pid:<parent local id>, p:<parent index>, ... }
//   embeds[]   { id:<stable saved-embed id>, name, data }
//   posts[]    { e:<embed id>, ch:<channel index>, cid:<channel local id>, o:<send order> }
// Overwrite keys are 'e' (@everyone), a role local id ('r3'), or - in v1/v2 templates - the role's array index.
// Older (v1/v2) templates are upgraded in memory by normalizeSnapshot using the best information they contain.
const big = (v, fallback = 0n) => { try { return BigInt(v); } catch { return fallback; } };
function normalizeSnapshot(snap) {
    if (!snap || typeof snap !== 'object')
        throw new Error('Template data is missing.');
    if (snap.__normalized)
        return snap;
    if (!Array.isArray(snap.roles) || !Array.isArray(snap.channels))
        throw new Error('Template has no role/channel data.');
    const notes = [];
    const uniq = (arr, prefix) => {
        const seen = new Set();
        arr.forEach((x, i) => {
            let id = typeof x.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x.id) ? x.id : `${prefix}${i}`;
            if (seen.has(id))
                id = `${prefix}${i}`;
            while (seen.has(id))
                id += '_';
            seen.add(id);
            x.id = id;
        });
    };
    snap.roles = snap.roles.filter(r => r && typeof r === 'object').slice(0, MAX_ROLES);
    for (const r of snap.roles) {
        r.n = String(r.n ?? 'role').slice(0, 100) || 'role';
        r.c = Number.isInteger(r.c) && r.c >= 0 && r.c <= 0xFFFFFF ? r.c : 0;
        r.p = String(big(r.p, 0n));
    }
    snap.channels = snap.channels.filter(c => c && typeof c === 'object').slice(0, MAX_CHANNELS);
    uniq(snap.roles, 'r');
    uniq(snap.channels, 'c');
    // roles: array order is the saved hierarchy (top first). `pos` is kept for reference; legacy templates get a synthetic one.
    const n = snap.roles.length;
    snap.roles.forEach((r, i) => { if (!Number.isInteger(r.pos))
        r.pos = n - i; });
    snap.roleOrder = snap.roles.map((r, i) => i).sort((a, b) => (snap.roles[b].pos - snap.roles[a].pos) || (a - b));
    // channels
    snap.channels.forEach((c, i) => {
        c.n = String(c.n ?? 'channel').slice(0, 100) || 'channel';
        if (!Number.isInteger(c.ord))
            c.ord = i;
        let parent = -1;
        if (typeof c.pid === 'string') {
            const j = snap.channels.findIndex(x => x.id === c.pid);
            if (j >= 0 && j !== i)
                parent = j;
        }
        else if (Number.isInteger(c.p) && c.p >= 0 && c.p < snap.channels.length && c.p !== i) {
            parent = c.p;
        }
        if (parent >= 0 && snap.channels[parent].t !== ChannelType.GuildCategory)
            parent = -1;
        if (c.t === ChannelType.GuildCategory)
            parent = -1;
        c.p = parent;
        c.pid = parent >= 0 ? snap.channels[parent].id : null;
    });
    snap.channelOrder = snap.channels.map((c, i) => i).sort((a, b) => (snap.channels[a].ord - snap.channels[b].ord) || (a - b));
    // embeds & their destination channels
    snap.embeds = (Array.isArray(snap.embeds) ? snap.embeds : []).filter(e => e && e.name && e.data && typeof e.data === 'object');
    snap.embeds.forEach((e, i) => { if (typeof e.id !== 'string' || !e.id)
        e.id = `legacy-${i}`; });
    const embedIds = new Set(snap.embeds.map(e => e.id));
    snap.posts = (Array.isArray(snap.posts) ? snap.posts : []).map(po => {
        if (!po || !embedIds.has(po.e))
            return null;
        let idx = typeof po.cid === 'string' ? snap.channels.findIndex(c => c.id === po.cid) : -1;
        if (idx < 0 && Number.isInteger(po.ch) && po.ch >= 0 && po.ch < snap.channels.length)
            idx = po.ch;
        return idx >= 0 ? { e: po.e, ch: idx, cid: snap.channels[idx].id, o: Number.isFinite(po.o) ? po.o : 0 } : null;
    }).filter(Boolean).sort((a, b) => a.o - b.o);
    Object.defineProperty(snap, '__normalized', { value: true, enumerable: false });
    return snap;
}
const hashKey = text => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 24);
async function createSnapshot(guild, onStage = async () => { }) {
    await onStage('Reading roles & channels…');
    await guild.channels.fetch().catch(() => { });
    await guild.roles.fetch().catch(() => { });
    const roles = [...guild.roles.cache.values()]
        .filter(r => r.id !== guild.id && !r.managed)
        .sort((a, b) => (b.position - a.position) || (a.id < b.id ? -1 : 1))
        .slice(0, MAX_ROLES);
    const skippedManaged = [...guild.roles.cache.values()].filter(r => r.id !== guild.id && r.managed).length;
    const roleIndex = new Map(roles.map((r, i) => [r.id, i]));
    const runtime = c => { try {
        return !!(db.getTicket(c.id)?.status === 'open' || db.getVMChannel(c.id));
    }
    catch {
        return false;
    } };
    const channels = [...guild.channels.cache.values()]
        .filter(c => SAVED_TYPES.has(c.type) && !c.isThread?.() && !runtime(c))
        .sort((a, b) => (a.rawPosition ?? a.position) - (b.rawPosition ?? b.position))
        .slice(0, MAX_CHANNELS);
    const chIndex = new Map(channels.map((c, i) => [c.id, i]));
    const idx = id => (id && chIndex.has(id) ? chIndex.get(id) : -1);
    const overwritesOf = ch => {
        const out = [];
        for (const ow of ch.permissionOverwrites?.cache?.values?.() || []) {
            if (ow.type !== 0)
                continue;
            const idx = roleIndex.get(ow.id);
            const key = ow.id === guild.id ? 'e' : (idx === undefined ? undefined : `r${idx}`);
            if (key === undefined)
                continue;
            out.push([key, ow.allow.bitfield.toString(), ow.deny.bitfield.toString()]);
        }
        return out;
    };
    await onStage('Reading server settings & images…');
    const g = {
        n: guild.name, ds: guild.description || undefined,
        ic: await fetchDataUri(guild.iconURL({ size: 1024, forceStatic: false })),
        bn: await fetchDataUri(guild.bannerURL?.({ size: 1024, forceStatic: false })),
        sp: await fetchDataUri(guild.splashURL?.({ size: 1024 })),
        vl: guild.verificationLevel, cf: guild.explicitContentFilter, dn: guild.defaultMessageNotifications,
        at: guild.afkTimeout, afk: idx(guild.afkChannelId), sys: idx(guild.systemChannelId),
        sf: Number(guild.systemChannelFlags?.bitfield ?? 0), loc: guild.preferredLocale,
        rules: idx(guild.rulesChannelId), upd: idx(guild.publicUpdatesChannelId),
        com: guild.features?.includes('COMMUNITY') ? 1 : 0,
        ev: guild.roles.everyone.permissions.bitfield.toString()
    };
    await onStage('Reading emojis & stickers…');
    await guild.emojis.fetch().catch(() => { });
    const emojiList = [...guild.emojis.cache.values()].filter(e => !e.managed);
    const emojis = [];
    await pool(emojiList, 6, async (e) => {
        const url = e.imageURL?.({ extension: e.animated ? 'gif' : 'png' }) || e.url;
        const d = await fetchDataUri(url);
        if (d)
            emojis.push({ n: e.name, d });
    });
    await guild.stickers.fetch().catch(() => { });
    const stickerList = [...guild.stickers.cache.values()].filter(s => s.format !== 3);
    const stickers = [];
    await pool(stickerList, 4, async (s) => {
        const r = await fetchBuffer(s.url, 2 * 1024 * 1024);
        if (r)
            stickers.push({ n: s.name, tg: s.tags || s.name, ds: s.description || undefined, d: r.buf.toString('base64'), f: s.format });
    });
    const panels = await scanPanels(guild, channels, chIndex, async (done, total) => onStage(`Scanning panels… ${done}/${total} channels`));
    await onStage('Reading bot settings…');
    const cfg = JSON.parse(JSON.stringify(db.getConfig(guild.id)));
    for (const k of ['afk', 'blacklist', 'maintenance'])
        delete cfg[k];
    if (cfg.birthdays)
        cfg.birthdays.entries = {};
    if (cfg.ticket)
        cfg.ticket.counter = 0;
    const config = encodeIds(cfg, chIndex, roleIndex);
    const sticky = [];
    try {
        for (const s of db.listStickies(guild.id)) {
            if (!chIndex.has(s.channelId))
                continue;
            sticky.push({ ch: chIndex.get(s.channelId), data: encodeIds(s.data, chIndex, roleIndex), en: s.enabled ? 1 : 0, by: s.createdBy || undefined });
        }
    }
    catch { }
    const embeds = [];
    const posts = [];
    try {
        // oldest first so the saved order matches the order the embeds were created in
        for (const e of [...db.listEmbeds(guild.id)].filter(x => x.data).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)))
            embeds.push({ id: e.id, name: e.name, data: encodeIds(e.data, chIndex, roleIndex) });
        const known = new Set(embeds.map(e => e.id));
        let seq = 0;
        for (const po of db.listEmbedPosts(guild.id)) {
            if (!known.has(po.embedId) || !chIndex.has(po.channelId))
                continue;
            const ci = chIndex.get(po.channelId);
            if (!TEXTY.has(channels[ci].type))
                continue;
            posts.push({ e: po.embedId, ch: ci, cid: `c${ci}`, o: seq++ });
        }
    }
    catch { }
    let wl = [];
    try {
        wl = db.db.prepare('SELECT userId FROM antinuke_whitelist WHERE guildId=?').all(guild.id).map(r => r.userId);
    }
    catch { }
    return {
        v: 3, id: guild.id, name: guild.name, at: Date.now(), g,
        skipped: { managedRoles: skippedManaged },
        roles: roles.map((r, i) => ({ id: `r${i}`, pos: r.position, n: r.name, c: r.color, h: r.hoist ? 1 : 0, m: r.mentionable ? 1 : 0, p: r.permissions.bitfield.toString(), ue: r.unicodeEmoji || undefined })),
        channels: channels.map((c, i) => ({
            id: `c${i}`, ord: i,
            n: c.name, t: c.type,
            p: c.parentId && chIndex.has(c.parentId) ? chIndex.get(c.parentId) : -1,
            pid: c.parentId && chIndex.has(c.parentId) ? `c${chIndex.get(c.parentId)}` : null,
            tp: c.topic || undefined, nsfw: c.nsfw ? 1 : undefined, rl: c.rateLimitPerUser || undefined,
            b: c.bitrate || undefined, ul: c.userLimit || undefined, rg: c.rtcRegion || undefined,
            vq: c.videoQualityMode || undefined, aa: c.defaultAutoArchiveDuration || undefined,
            tags: c.availableTags?.length ? c.availableTags.map(t => ({ name: t.name, moderated: !!t.moderated, emoji: t.emoji?.name && !t.emoji?.id ? t.emoji.name : undefined })) : undefined,
            so: c.defaultSortOrder ?? undefined, fl: c.defaultForumLayout || undefined,
            tr: c.defaultThreadRateLimitPerUser || undefined,
            o: overwritesOf(c)
        })),
        emojis, stickers, panels, config, sticky, embeds, posts, wl
    };
}
async function scanPanels(guild, channels, chIndex, onProgress) {
    const me = guild.members.me;
    const found = [];
    const targets = channels.filter(c => TEXTY.has(c.type)).filter(c => {
        const p = c.permissionsFor(me);
        return p?.has(PermissionFlagsBits.ViewChannel) && p?.has(PermissionFlagsBits.ReadMessageHistory);
    });
    let done = 0, lastReport = 0;
    await pool(targets, 5, async (ch) => {
        try {
            const msgs = await ch.messages.fetch({ limit: 30 });
            const types = new Set();
            for (const m of msgs.values()) {
                if (m.author?.id !== guild.client.user.id)
                    continue;
                let ids = [];
                try {
                    ids = collectCustomIds(m.components.map(c => (typeof c.toJSON === 'function' ? c.toJSON() : c)));
                }
                catch { }
                if (ids.includes('ticket_open'))
                    types.add('ticket');
                if (ids.includes('staffapp_apply'))
                    types.add('staffapp');
                if (ids.includes('birthday_set'))
                    types.add('birthday');
            }
            for (const t of types)
                found.push({ type: t, ch: chIndex.get(ch.id) });
        }
        catch { }
        done++;
        if (Date.now() - lastReport > 2500) {
            lastReport = Date.now();
            await onProgress?.(done, targets.length).catch?.(() => { });
        }
    });
    try {
        const t = db.getConfig(guild.id).ticket;
        if (t?.panelChannelId && chIndex.has(t.panelChannelId) && !found.some(f => f.type === 'ticket'))
            found.push({ type: 'ticket', ch: chIndex.get(t.panelChannelId) });
    }
    catch { }
    return found;
}
function encodeSnapshot(snapshot) {
    const body = zlib.gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 9 }).toString('base64url');
    return `${PREFIX}.${body}.${sign(body)}`;
}
function decodeSnapshot(code) {
    const parts = String(code || '').trim().split('.');
    if (parts.length !== 3 || (parts[0] !== PREFIX && parts[0] !== LEGACY_PREFIX))
        throw new Error('That is not a valid AunXz template code or file.');
    const [, body, sig] = parts;
    const good = Buffer.from(sign(body));
    const given = Buffer.from(sig);
    if (good.length !== given.length || !crypto.timingSafeEqual(good, given))
        throw new Error('This template is corrupted or was created by a different AunXz bot.');
    let data;
    try {
        data = JSON.parse(zlib.gunzipSync(Buffer.from(body, 'base64url')).toString('utf8'));
    }
    catch {
        throw new Error('This template could not be read.');
    }
    if (!data || ![1, 2, 3].includes(data.v) || !Array.isArray(data.roles) || !Array.isArray(data.channels))
        throw new Error('Unsupported template version.');
    return normalizeSnapshot(data);
}
function resolveSnapshot(input) {
    const text = String(input || '').trim();
    if (/^AX-[A-Z0-9]{8}$/i.test(text)) {
        const row = db.getTemplate(text);
        if (!row)
            throw new Error('No saved template with that code exists. (Template codes only work with the bot that saved them.)');
        return decodeSnapshot(row.data);
    }
    return decodeSnapshot(text);
}
// ───────────────────────── arrangement helpers ─────────────────────────
// Puts the given roles (top of hierarchy first) into that relative order and VERIFIES the result against Discord.
// Returns { verified, total, misplaced[] }; never claims success that was not read back from the server.
async function arrangeRoles(guild, me, ordered, reason) {
    const total = ordered.length;
    if (!total)
        return { verified: true, total: 0, misplaced: [] };
    const state = async () => {
        await guild.roles.fetch();
        return ordered.filter(x => guild.roles.cache.has(x.id)).map(x => ({ ...x, pos: guild.roles.cache.get(x.id).position }));
    };
    const misplacedOf = cur => {
        const bad = new Set();
        for (let k = 0; k < cur.length - 1; k++)
            if (!(cur[k].pos > cur[k + 1].pos))
                bad.add(cur[k].name);
        return [...bad];
    };
    let cur = await state();
    let bad = misplacedOf(cur);
    if (!bad.length)
        return { verified: cur.length === total, total, misplaced: [] };
    const myTop = me.roles.highest.position;
    const slots = cur.map(x => x.pos).sort((a, b) => a - b);
    const targets = cur.map((x, k) => ({ ...x, target: slots[slots.length - 1 - k] }));
    let lastError = null;
    // pass 1: a single bulk request
    try {
        const updates = targets.filter(t => t.pos !== t.target && t.target < myTop).map(t => ({ role: t.id, position: t.target }));
        if (updates.length)
            await guild.roles.setPositions(updates);
    }
    catch (e) {
        lastError = e;
    }
    cur = await state();
    bad = misplacedOf(cur);
    // pass 2: move roles one at a time, lowest first, re-reading the server between moves
    if (bad.length) {
        for (let k = targets.length - 1; k >= 0; k--) {
            const t = targets[k];
            const role = guild.roles.cache.get(t.id);
            if (!role || role.position === t.target || t.target >= myTop)
                continue;
            try {
                await role.setPosition(t.target, { reason });
            }
            catch (e) {
                lastError = e;
            }
            await wait(250);
        }
        cur = await state();
        bad = misplacedOf(cur);
    }
    return { verified: !bad.length && cur.length === total, total, misplaced: bad, error: bad.length && lastError ? short(lastError) : undefined };
}
// Places categories and channels in their saved order, one request per parent so positions are relative to that parent,
// with lockPermissions:false so a category can never overwrite a channel's own permissions. Verified by re-reading Discord.
async function arrangeChannels(guild, snapshot, chIds, reason) {
    const groups = new Map();
    for (const i of snapshot.channelOrder) {
        if (!chIds[i])
            continue;
        const c = snapshot.channels[i];
        const parentId = c.t !== ChannelType.GuildCategory && c.p >= 0 ? chIds[c.p] : null;
        const key = parentId || 'top';
        if (!groups.has(key))
            groups.set(key, []);
        groups.get(key).push({ id: chIds[i], name: c.n });
    }
    const apply = async (key, list) => {
        const updates = list.map((x, k) => ({ channel: x.id, position: k, ...(key === 'top' ? {} : { parent: key, lockPermissions: false }) }));
        await guild.channels.setPositions(updates);
    };
    const check = async () => {
        await guild.channels.fetch().catch(() => { });
        const bad = [];
        for (const [key, list] of groups) {
            const live = list.map(x => ({ name: x.name, ch: guild.channels.cache.get(x.id) })).filter(x => x.ch);
            for (const x of live)
                if ((x.ch.parentId || 'top') !== key)
                    bad.push(x.name);
            for (let k = 0; k < live.length - 1; k++)
                if (!((live[k].ch.rawPosition ?? live[k].ch.position) < (live[k + 1].ch.rawPosition ?? live[k + 1].ch.position)))
                    bad.push(live[k].name);
        }
        return [...new Set(bad)];
    };
    let lastError = null;
    for (const [key, list] of groups) {
        try {
            await apply(key, list);
        }
        catch (e) {
            lastError = e;
        }
        await wait(300);
    }
    let bad = await check();
    if (bad.length) {
        // second attempt, again group by group
        for (const [key, list] of groups) {
            try {
                await apply(key, list);
            }
            catch (e) {
                lastError = e;
            }
            await wait(400);
        }
        bad = await check();
    }
    const total = [...groups.values()].reduce((n, l) => n + l.length, 0);
    return { verified: !bad.length, total, misplaced: bad, error: bad.length && lastError ? short(lastError) : undefined };
}
// Ensures a freshly created channel carries exactly the saved overwrites. Returns true when it had to correct them.
async function syncOverwrites(ch, expected, reason) {
    if (!ch?.permissionOverwrites?.cache)
        return false;
    const sig = (id, type, allow, deny) => `${id}:${type}:${allow}:${deny}`;
    const want = new Set(expected.map(o => sig(o.id, o.type, big(o.allow), big(o.deny))));
    const have = new Set([...ch.permissionOverwrites.cache.values()].map(o => sig(o.id, o.type, o.allow.bitfield, o.deny.bitfield)));
    const same = want.size === have.size && [...want].every(x => have.has(x));
    if (same)
        return false;
    await ch.permissionOverwrites.set(expected, reason);
    return true;
}
// Recreates the template's saved embeds (keeping their stable ids where free) and remaps reveal-button targets to the restored ids.
function restoreSavedEmbeds(guildId, snapshot, chIds, roleIds, failed) {
    const idMap = new Map();
    const created = [];
    for (const e of snapshot.embeds) {
        const data = decodeIds(e.data, chIds, roleIds);
        let r = db.createSavedEmbed(guildId, e.name, data, null, e.id);
        for (let n = 2; !r.ok && r.reason === 'duplicate' && n < 10; n++)
            r = db.createSavedEmbed(guildId, `${String(e.name).slice(0, 58)} (${n})`, data, null, e.id);
        if (!r.ok) {
            failed.push(`embed "${String(e.name).slice(0, 40)}": could not be saved (${r.reason})`);
            continue;
        }
        idMap.set(e.id, r.embed.id);
        created.push(r.embed);
    }
    for (const row of created) {
        const d = row.data;
        if (!Array.isArray(d?.buttons) || !d.buttons.some(b => b.targetId))
            continue;
        const buttons = [];
        for (const b of d.buttons) {
            if (!b.targetId) {
                buttons.push(b);
                continue;
            }
            const nid = idMap.get(b.targetId);
            if (nid)
                buttons.push({ ...b, targetId: nid, targetName: db.getSavedEmbedById(nid)?.name || b.targetName });
            else
                failed.push(`embed "${row.name}": button "${String(b.label).slice(0, 30)}" removed (its target embed is not in the template)`);
        }
        db.updateSavedEmbed(row.id, row.updatedAt, { ...d, buttons });
    }
    return idMap;
}
const needsOf = (perms, thread) => [['ViewChannel', 'View Channel'], [thread ? 'SendMessagesInThreads' : 'SendMessages', 'Send Messages'], ['EmbedLinks', 'Embed Links']]
    .filter(([f]) => !perms?.has(PermissionFlagsBits[f])).map(([, l]) => l);
// Sends each saved embed to the restored counterpart of the channel it was posted in. Tracks what it sent so a retry of the
// same run does not post the same embed twice, and reports posted / skipped / failed honestly.
async function postSavedEmbeds(guild, me, snapshot, chIds, idMap, runKey, report, prog, failed, flush) {
    const es = require('./embedsystem');
    for (let k = 0; k < snapshot.posts.length; k++) {
        const po = snapshot.posts[k];
        const name = snapshot.embeds.find(e => e.id === po.e)?.name || 'embed';
        const chId = chIds[po.ch];
        const newId = idMap.get(po.e);
        const label = `embed "${String(name).slice(0, 30)}"`;
        if (!chId || !newId) {
            report.skipped++;
            failed.push(`${label}: skipped (${!chId ? 'its channel was not restored' : 'the embed was not restored'})`);
            continue;
        }
        const channel = guild.channels.cache.get(chId) || await guild.channels.fetch(chId).catch(() => null);
        if (!channel?.isTextBased?.()) {
            report.skipped++;
            failed.push(`${label}: skipped (channel unavailable)`);
            continue;
        }
        const itemKey = `${po.e}|${snapshot.channels[po.ch].id}|${k}`;
        const logged = db.getRestoreLog(runKey, itemKey);
        if (logged?.messageId && logged.channelId === chId && await channel.messages.fetch(logged.messageId).then(() => true).catch(() => false)) {
            report.posted++;
            prog.c.embeds.done++;
            continue;
        }
        const missing = needsOf(channel.permissionsFor(me), false);
        if (missing.length) {
            report.failed++;
            failed.push(`${label} → #${channel.name}: I lack ${missing.join(', ')}`);
            continue;
        }
        const row = db.getSavedEmbedById(newId);
        const draft = es.normalizeDraft(row?.data);
        const problems = es.validateDraft(draft);
        if (problems.length) {
            report.failed++;
            failed.push(`${label}: not sent (${problems[0]})`);
            continue;
        }
        let sent = null;
        let lastErr = null;
        for (let attempt = 1; attempt <= 3 && !sent; attempt++) {
            try {
                sent = await channel.send({ embeds: [es.buildEmbed(draft)], components: es.buildLinkRows(draft), allowedMentions: { parse: [] }, rawEmbeds: true });
            }
            catch (e) {
                lastErr = e;
                const c = codeOf(e);
                if ([50013, 50001, 10003, 50035].includes(c))
                    break;
                await wait(1200 * attempt);
            }
        }
        if (!sent) {
            report.failed++;
            failed.push(`${label} → #${channel.name}: ${short(lastErr)}`);
            continue;
        }
        try {
            db.putRestoreLog(runKey, itemKey, guild.id, chId, sent.id);
            db.recordEmbedPost(guild.id, newId, chId, sent.id);
        }
        catch { }
        report.posted++;
        prog.c.embeds.done++;
        await flush();
        await wait(350);
    }
}
const running = new Set();
const DELETE_ID = 'tplprog:del';
function renderProgress(prog, title = 'Loading template') {
    const parts = [];
    const add = (label, key) => { const c = prog.c[key]; if (c && c.total > 0)
        parts.push(`${label} **${c.done}/${c.total}**`); };
    add('Roles', 'roles');
    add('Channels', 'channels');
    add('Settings', 'server');
    add('Bot', 'bot');
    add('Embeds', 'embeds');
    add('Emojis', 'emojis');
    add('Stickers', 'stickers');
    add('Panels', 'panels');
    const secs = Math.round((Date.now() - prog.started) / 1000);
    return ui.slimInfo(title, `**${prog.stage}**\n${parts.join(' · ')}\n-# ${Math.floor(secs / 60)}m ${secs % 60}s`);
}
async function createProgressChannel(guild, user, me) {
    return guild.channels.create({
        name: 'template-progress', type: ChannelType.GuildText,
        topic: 'Template load progress. Delete this channel when it finishes.',
        permissionOverwrites: [
            { id: guild.id, type: 0, deny: [PermissionFlagsBits.ViewChannel] },
            { id: user.id, type: 1, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
            { id: me.id, type: 1, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] }
        ],
        reason: `AunXz /template load by ${user.tag || user.id}`
    });
}
async function runLoad(guild, snapshot, user, { onReady } = {}) {
    if (running.has(guild.id))
        throw new Error('A template is already loading in this server. Wait for it to finish.');
    running.add(guild.id);
    try {
        return await loadSnapshot(guild, snapshot, user, onReady);
    }
    finally {
        running.delete(guild.id);
    }
}
async function loadSnapshot(guild, snapshot, user, onReady) {
    snapshot = normalizeSnapshot(snapshot);
    const failed = [];
    const notes = [];
    const orderReport = { roles: null, channels: null };
    const embedReport = { posted: 0, failed: 0, skipped: 0, stored: 0 };
    const kept = [];
    const reason = `AunXz /template load by ${user.tag || user.id}`;
    const me = guild.members.me || await guild.members.fetchMe();
    const isAdmin = me.permissions.has(PermissionFlagsBits.Administrator);
    const missing = ['ManageChannels', 'ManageRoles'].filter(p => !isAdmin && !me.permissions.has(PermissionFlagsBits[p]));
    if (missing.length)
        throw new Error(`I need **${missing.join('**, **')}** to load a template.`);
    const meBits = me.permissions.bitfield;
    const g = snapshot.g || null;
    const sameGuild = snapshot.id === guild.id;
    const sections = snapshot.config ? Object.keys(snapshot.config) : [];
    const extra = [(snapshot.sticky || []).length ? 'sticky' : null, (snapshot.embeds || []).length ? 'embeds' : null, sameGuild && (snapshot.wl || []).length ? 'whitelist' : null].filter(Boolean);
    const rolePanelCount = ((snapshot.config?.buttonRolePanels || []).filter(p => p.channelId && (p.buttons || []).length && p.enabled !== false).length)
        + ((snapshot.config?.reactionRolePanels || []).filter(p => p.channelId && (p.mappings || []).length && p.enabled !== false).length);
    const prog = {
        stage: 'Preparing…', started: Date.now(),
        c: {
            channels: { done: 0, total: snapshot.channels.length },
            roles: { done: 0, total: snapshot.roles.length },
            server: { done: 0, total: g ? 12 : 0 },
            bot: { done: 0, total: sections.length + extra.length },
            emojis: { done: 0, total: (snapshot.emojis || []).length },
            stickers: { done: 0, total: (snapshot.stickers || []).length },
            panels: { done: 0, total: (snapshot.panels || []).length + rolePanelCount },
            embeds: { done: 0, total: (snapshot.posts || []).length }
        }
    };
    let pch = null;
    let pmsg = null;
    const openProgress = async () => {
        try {
            pch = await createProgressChannel(guild, user, me);
            pmsg = await pch.send({ embeds: [renderProgress(prog)] });
            if (onReady)
                await Promise.resolve(onReady(pch)).catch(() => { });
        }
        catch (e) {
            pch = null;
            pmsg = null;
            failed.push(`progress channel: ${short(e)}`);
        }
    };
    await openProgress();
    let lastEdit = 0;
    let editing = false;
    const flush = async (force = false) => {
        if (!pmsg)
            return;
        const now = Date.now();
        if (!force && now - lastEdit < 1600)
            return;
        if (editing)
            return;
        editing = true;
        lastEdit = now;
        try {
            await pmsg.edit({ embeds: [renderProgress(prog)] });
        }
        catch { }
        editing = false;
    };
    const stage = async (text) => { prog.stage = text; await flush(true); };
    await stage('Removing current channels…');
    await guild.channels.fetch().catch(() => { });
    const oldChannels = [...guild.channels.cache.values()].filter(c => !c.isThread?.() && c.id !== pch?.id);
    let n = 0;
    for (const ch of oldChannels) {
        try {
            await ch.delete(reason);
        }
        catch (e) {
            if (codeOf(e) === 10003) { }
            else if (codeOf(e) === 50074)
                kept.push(ch);
            else
                failed.push(`delete #${ch.name}: ${short(e)}`);
        }
        n++;
        if (n % 3 === 0) {
            prog.stage = `Removing current channels… ${n}/${oldChannels.length}`;
            await flush();
        }
    }
    if (!pch) {
        await openProgress();
    }
    await stage('Removing current roles…');
    await guild.roles.fetch().catch(() => { });
    const oldRoles = [...guild.roles.cache.values()].filter(r => r.id !== guild.id && !r.managed && r.position < me.roles.highest.position);
    n = 0;
    for (const role of oldRoles) {
        try {
            await role.delete(reason);
        }
        catch (e) {
            if (codeOf(e) !== 10011)
                failed.push(`delete @${role.name}: ${short(e)}`);
        }
        n++;
        if (n % 3 === 0) {
            prog.stage = `Removing current roles… ${n}/${oldRoles.length}`;
            await flush();
        }
        await wait(120);
    }
    await stage('Creating roles…');
    const roleIds = new Array(snapshot.roles.length).fill(null);   // template index -> restored role id
    const roleById = new Map();                                     // template-local id -> restored role id
    const reducedPerms = [];
    // Discord puts every new role directly above @everyone, so creating from the TOP of the saved hierarchy down leaves the
    // roles in the right relative order. The arrange step below still enforces and verifies the final order.
    for (const i of snapshot.roleOrder) {
        const r = snapshot.roles[i];
        try {
            const want = big(r.p);
            const grant = isAdmin ? want : (want & meBits);
            if (grant !== want)
                reducedPerms.push(r.n);
            const opts = { name: r.n, color: r.c || 0, hoist: !!r.h, mentionable: !!r.m, permissions: new PermissionsBitField(grant), reason };
            if (r.ue && (guild.premiumTier || 0) >= 2)
                opts.unicodeEmoji = r.ue;
            const role = await guild.roles.create(opts).catch(async (e) => { if (opts.unicodeEmoji) {
                delete opts.unicodeEmoji;
                return guild.roles.create(opts);
            } throw e; });
            roleIds[i] = role.id;
            roleById.set(r.id, role.id);
            prog.c.roles.done++;
        }
        catch (e) {
            failed.push(`role @${r.n}: ${short(e)}`);
        }
        await flush();
        await wait(200);
    }
    if (reducedPerms.length)
        notes.push(`${reducedPerms.length} role(s) got fewer permissions than saved because I do not hold them myself (${reducedPerms.slice(0, 3).join(', ')}${reducedPerms.length > 3 ? '…' : ''})`);
    if (snapshot.skipped?.managedRoles)
        notes.push(`${snapshot.skipped.managedRoles} bot/integration role(s) were not part of the template`);
    await stage('Arranging roles…');
    try {
        orderReport.roles = await arrangeRoles(guild, me, snapshot.roleOrder.map(i => ({ id: roleIds[i], name: snapshot.roles[i].n })).filter(x => x.id), reason);
    }
    catch (e) {
        orderReport.roles = { verified: false, total: 0, misplaced: [], error: short(e) };
        failed.push(`role order: ${short(e)}`);
    }
    if (orderReport.roles && !orderReport.roles.verified && orderReport.roles.misplaced?.length)
        failed.push(`role order: ${orderReport.roles.misplaced.length} role(s) could not be placed exactly (${orderReport.roles.misplaced.slice(0, 4).join(', ')}${orderReport.roles.misplaced.length > 4 ? '…' : ''})`);

    await stage('Creating channels…');
    const chIds = new Array(snapshot.channels.length).fill(null);   // template index -> restored channel id
    const chById = new Map();                                       // template-local id -> restored channel id
    const roleRef = key => (key === 'e' ? guild.id : typeof key === 'number' ? roleIds[key] : roleById.get(key));
    const overwrites = list => (list || []).map(([key, allow, deny]) => {
        const id = roleRef(key);
        if (!id)
            return null;
        const a = isAdmin ? big(allow) : (big(allow) & meBits);
        return { id, type: 0, allow: a, deny: big(deny) };
    }).filter(Boolean);
    // categories first (so children can be created under them), each group in its saved order
    const order = [
        ...snapshot.channelOrder.filter(i => snapshot.channels[i].t === ChannelType.GuildCategory),
        ...snapshot.channelOrder.filter(i => snapshot.channels[i].t !== ChannelType.GuildCategory)
    ];
    for (const i of order) {
        const c = snapshot.channels[i];
        const expected = overwrites(c.o);
        const build = type => {
            // Overwrites are always sent explicitly (even when empty) so a channel never silently inherits its category's.
            const opts = { name: c.n, type, permissionOverwrites: expected, reason };
            if (c.p >= 0 && chIds[c.p])
                opts.parent = chIds[c.p];
            if (TEXTY.has(type) || type === ChannelType.GuildForum) {
                if (c.tp)
                    opts.topic = c.tp;
                if (c.nsfw)
                    opts.nsfw = true;
                if (c.rl)
                    opts.rateLimitPerUser = c.rl;
                if (c.aa)
                    opts.defaultAutoArchiveDuration = c.aa;
            }
            if (type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice) {
                if (c.b)
                    opts.bitrate = Math.min(c.b, guild.maximumBitrate || 96000);
                if (c.ul)
                    opts.userLimit = c.ul;
                if (c.rg)
                    opts.rtcRegion = c.rg;
                if (c.vq && type === ChannelType.GuildVoice)
                    opts.videoQualityMode = c.vq;
                if (c.nsfw)
                    opts.nsfw = true;
            }
            if (type === ChannelType.GuildForum) {
                if (c.tags?.length)
                    opts.availableTags = c.tags.map(t => ({ name: t.name, moderated: !!t.moderated, ...(t.emoji ? { emoji: { id: null, name: t.emoji } } : {}) }));
                if (c.so !== undefined)
                    opts.defaultSortOrder = c.so;
                if (c.fl)
                    opts.defaultForumLayout = c.fl;
                if (c.tr)
                    opts.defaultThreadRateLimitPerUser = c.tr;
            }
            return opts;
        };
        try {
            let ch;
            try {
                ch = await guild.channels.create(build(c.t));
            }
            catch (e) {
                const fb = FALLBACK_TYPE[c.t];
                if (fb === undefined)
                    throw e;
                ch = await guild.channels.create(build(fb));
                failed.push(`#${c.n}: created as ${ChannelType[fb] ?? fb} (original type needs Community)`);
            }
            chIds[i] = ch.id;
            chById.set(c.id, ch.id);
            prog.c.channels.done++;
            // Make sure the channel kept ITS OWN overwrites and did not inherit the category's.
            try {
                const mismatch = await syncOverwrites(ch, expected, reason);
                if (mismatch)
                    notes.push(`#${c.n}: permission overwrites were re-applied after creation`);
            }
            catch (e) {
                failed.push(`#${c.n} permissions: ${short(e)}`);
            }
        }
        catch (e) {
            failed.push(`channel ${c.n}: ${short(e)}`);
        }
        await flush();
        await wait(200);
    }
    await stage('Arranging channels…');
    try {
        orderReport.channels = await arrangeChannels(guild, snapshot, chIds, reason);
    }
    catch (e) {
        orderReport.channels = { verified: false, total: 0, misplaced: [], error: short(e) };
        failed.push(`channel order: ${short(e)}`);
    }
    if (orderReport.channels && !orderReport.channels.verified && orderReport.channels.misplaced?.length)
        failed.push(`channel order: ${orderReport.channels.misplaced.length} channel(s) are not in their saved position (${orderReport.channels.misplaced.slice(0, 4).join(', ')}${orderReport.channels.misplaced.length > 4 ? '…' : ''})`);
    const steps = [];
    if (g) {
        const edit = (label, patch, skip = false) => steps.push({ label, skip, run: () => guild.edit({ ...patch, reason }) });
        edit('server name', { name: g.n });
        edit('server icon', { icon: g.ic || null }, !g.ic && !guild.icon);
        edit('server banner', { banner: g.bn || null }, !g.bn && !guild.banner);
        edit('invite splash', { splash: g.sp || null }, !g.sp && !guild.splash);
        edit('description & language', { preferredLocale: g.loc, ...(g.ds || guild.description ? { description: g.ds || null } : {}) });
        edit('verification level', { verificationLevel: g.vl });
        edit('content filter', { explicitContentFilter: g.cf });
        edit('default notifications', { defaultMessageNotifications: g.dn });
        edit('AFK channel', { afkChannel: g.afk >= 0 ? chIds[g.afk] || null : null, afkTimeout: g.at });
        edit('system channel', { systemChannel: g.sys >= 0 ? chIds[g.sys] || null : null, systemChannelFlags: g.sf });
        steps.push({
            label: 'rules / updates channels', skip: !guild.features?.includes('COMMUNITY') || (g.rules < 0 && g.upd < 0),
            run: () => guild.edit({ rulesChannel: g.rules >= 0 ? chIds[g.rules] || null : undefined, publicUpdatesChannel: g.upd >= 0 ? chIds[g.upd] || null : undefined, reason })
        });
        steps.push({ label: '@everyone permissions', run: () => guild.roles.everyone.setPermissions(new PermissionsBitField(isAdmin ? BigInt(g.ev) : (BigInt(g.ev) & meBits)), reason) });
    }
    prog.c.server.total = steps.length;
    if (steps.length) {
        await stage('Applying server settings…');
        for (const s of steps) {
            if (!s.skip) {
                try {
                    await s.run();
                }
                catch (e) {
                    failed.push(`${s.label}: ${short(e)}`);
                    await flush();
                    await wait(300);
                    continue;
                }
            }
            prog.c.server.done++;
            await flush();
            await wait(300);
        }
    }
    if (kept.length && guild.features?.includes('COMMUNITY')) {
        try {
            const firstText = chIds.find((id, i) => id && snapshot.channels[i].t === ChannelType.GuildText) || null;
            const rulesId = (g && g.rules >= 0 && chIds[g.rules]) || firstText;
            const updId = (g && g.upd >= 0 && chIds[g.upd]) || firstText;
            if (rulesId || updId)
                await guild.edit({ ...(rulesId ? { rulesChannel: rulesId } : {}), ...(updId ? { publicUpdatesChannel: updId } : {}), reason });
        }
        catch (e) {
            failed.push(`rules / updates channels: ${short(e)}`);
        }
    }
    for (const ch of kept) {
        try {
            await ch.delete(reason);
        }
        catch (e) {
            failed.push(`#${ch.name} was kept (${codeOf(e) === 50074 ? 'required by Community' : short(e)})`);
        }
    }
    if (prog.c.emojis.total || prog.c.stickers.total) {
        await stage('Replacing emojis & stickers…');
        await guild.emojis.fetch().catch(() => { });
        for (const e of [...guild.emojis.cache.values()])
            if (!e.managed)
                await e.delete(reason).catch(() => { });
        await guild.stickers.fetch().catch(() => { });
        for (const s of [...guild.stickers.cache.values()])
            await s.delete(reason).catch(() => { });
    }
    if (prog.c.emojis.total) {
        await stage('Creating emojis…');
        for (const e of snapshot.emojis) {
            try {
                await guild.emojis.create({ attachment: e.d, name: e.n, reason });
                prog.c.emojis.done++;
            }
            catch (err) {
                failed.push(`emoji :${e.n}: ${short(err)}`);
                if (/maximum|limit|30008/i.test(String(err?.message)) || codeOf(err) === 30008)
                    break;
            }
            await flush();
            await wait(400);
        }
    }
    if (prog.c.stickers.total) {
        await stage('Creating stickers…');
        for (const s of snapshot.stickers) {
            try {
                await guild.stickers.create({ file: { attachment: Buffer.from(s.d, 'base64'), name: s.f === 4 ? 'sticker.gif' : 'sticker.png' }, name: s.n, tags: s.tg || s.n, description: s.ds, reason });
                prog.c.stickers.done++;
            }
            catch (err) {
                failed.push(`sticker ${s.n}: ${short(err)}`);
                if (codeOf(err) === 30039)
                    break;
            }
            await flush();
            await wait(500);
        }
    }
    let embedIdMap = new Map();
    if (prog.c.bot.total) {
        await stage('Loading bot settings…');
        const decoded = snapshot.config ? decodeIds(snapshot.config, chIds, roleIds) : {};
        const before = db.getConfig(guild.id);
        let current = { ...before };
        for (const key of sections) {
            try {
                current[key] = decoded[key];
                if (key === 'birthdays' && current[key])
                    current[key] = { ...current[key], entries: before.birthdays?.entries || {} };
                db.replaceConfig(guild.id, current);
                prog.c.bot.done++;
            }
            catch (e) {
                failed.push(`bot setting ${key}: ${short(e)}`);
            }
            await flush();
            await wait(40);
        }
        if (extra.includes('sticky')) {
            try {
                for (const s of db.listStickies(guild.id))
                    db.deleteSticky(s.channelId);
                for (const s of snapshot.sticky) {
                    const id = chIds[s.ch];
                    if (id)
                        db.saveSticky(guild.id, id, { data: decodeIds(s.data, chIds, roleIds), enabled: !!s.en, createdBy: s.by || null });
                }
                prog.c.bot.done++;
            }
            catch (e) {
                failed.push(`sticky messages: ${short(e)}`);
            }
            await flush();
        }
        if (extra.includes('embeds')) {
            try {
                for (const e of db.listEmbeds(guild.id))
                    db.deleteEmbed(guild.id, e.name);
                db.deleteEmbedPostsForGuild(guild.id);
                embedIdMap = restoreSavedEmbeds(guild.id, snapshot, chIds, roleIds, failed);
                embedReport.stored = embedIdMap.size;
                prog.c.bot.done++;
            }
            catch (e) {
                failed.push(`saved embeds: ${short(e)}`);
            }
            await flush();
        }
        if (extra.includes('whitelist')) {
            try {
                for (const uid of snapshot.wl)
                    db.addToWhitelist(guild.id, uid);
                prog.c.bot.done++;
            }
            catch (e) {
                failed.push(`anti-nuke whitelist: ${short(e)}`);
            }
            await flush();
        }
    }
    if (snapshot.posts.length && embedIdMap.size) {
        await stage('Posting embeds…');
        try {
            const runKey = hashKey(`${snapshot.id}|${snapshot.at}|${guild.id}`);
            await postSavedEmbeds(guild, me, snapshot, chIds, embedIdMap, runKey, embedReport, prog, failed, flush);
        }
        catch (e) {
            failed.push(`embeds: ${short(e)}`);
        }
    }
    else if (embedReport.stored) {
        notes.push(`${embedReport.stored} saved embed(s) were restored, but this template has no recorded channel for them, so none were posted (use /embed send)`);
    }
    const cfgNow = db.getConfig(guild.id);
    const jobs = [];
    for (const p of snapshot.panels || [])
        if (chIds[p.ch])
            jobs.push({ kind: p.type, channelId: chIds[p.ch] });
    for (const p of cfgNow.buttonRolePanels || [])
        if (p.channelId && (p.buttons || []).length && p.enabled !== false)
            jobs.push({ kind: 'buttonrole', panel: p, channelId: p.channelId });
    for (const p of cfgNow.reactionRolePanels || [])
        if (p.channelId && (p.mappings || []).length && p.enabled !== false)
            jobs.push({ kind: 'reactionrole', panel: p, channelId: p.channelId });
    prog.c.panels.total = jobs.length;
    if (jobs.length) {
        await stage('Posting panels…');
        for (const job of jobs) {
            try {
                await postPanel(guild, job);
                prog.c.panels.done++;
            }
            catch (e) {
                failed.push(`${job.kind} panel: ${short(e)}`);
            }
            await flush();
            await wait(400);
        }
    }
    await stage('Finished');
    await flush(true);
    const result = {
        channelsCreated: prog.c.channels.done, rolesCreated: prog.c.roles.done, serverSettings: prog.c.server.done,
        botSettings: prog.c.bot.done, emojis: prog.c.emojis.done, stickers: prog.c.stickers.done, panels: prog.c.panels.done,
        embedsPosted: embedReport.posted, embedsFailed: embedReport.failed, embedsSkipped: embedReport.skipped, embedsRestored: embedReport.stored,
        roleOrder: orderReport.roles, channelOrder: orderReport.channels, notes,
        failed, progressChannel: pch, totals: Object.fromEntries(Object.entries(prog.c).map(([k, v]) => [k, v.total]))
    };
    if (pch) {
        try {
            await pch.send({ embeds: [completionEmbed(snapshot, result)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${DELETE_ID}:${user.id}`).setLabel('Delete this channel').setStyle(ButtonStyle.Danger))] });
        }
        catch (e) {
            console.error('[Template] completion message failed:', e);
        }
    }
    return result;
}
function orderLine(label, rep, done, total) {
    if (!total)
        return null;
    if (!rep)
        return `${label} **${done}/${total}** · order not checked`;
    const mark = rep.verified ? 'order verified' : `order **not exact** (${rep.misplaced?.length || '?'} off)`;
    return `${label} **${done}/${total}** · ${mark}`;
}
// Compact summary: only what happened, nothing decorative.
function completionEmbed(snapshot, result) {
    const t = result.totals;
    const lines = [
        orderLine('Roles', result.roleOrder, result.rolesCreated, t.roles),
        orderLine('Channels', result.channelOrder, result.channelsCreated, t.channels),
        t.embeds || result.embedsRestored ? `Embeds **${result.embedsPosted}/${t.embeds}** posted${result.embedsFailed || result.embedsSkipped ? ` · ${result.embedsFailed} failed · ${result.embedsSkipped} skipped` : ''}` : null,
        t.server ? `Server settings **${result.serverSettings}/${t.server}**` : null,
        t.bot ? `Bot settings **${result.botSettings}/${t.bot}**` : null,
        t.emojis ? `Emojis **${result.emojis}/${t.emojis}**` : null,
        t.stickers ? `Stickers **${result.stickers}/${t.stickers}**` : null,
        t.panels ? `Panels **${result.panels}/${t.panels}**` : null
    ].filter(Boolean);
    const issues = result.failed.length ? `\n\n**Issues (${result.failed.length})**\n${result.failed.slice(0, 8).map(x => '• ' + x).join('\n')}${result.failed.length > 8 ? `\n• +${result.failed.length - 8} more` : ''}` : '';
    const notes = result.notes?.length ? `\n\n${result.notes.slice(0, 4).map(x => `-# ${x}`).join('\n')}` : '';
    const exact = result.roleOrder?.verified !== false && result.channelOrder?.verified !== false;
    return (result.failed.length || !exact ? ui.slimWarn : ui.slimOk)(result.failed.length || !exact ? 'Template loaded with issues' : 'Template loaded', `**${String(snapshot.name || 'Template').slice(0, 80)}**\n${lines.join('\n')}${issues}${notes}\n\n-# Member role assignments are not part of a template.`);
}
async function postPanel(guild, job) {
    const channel = guild.channels.cache.get(job.channelId) || await guild.channels.fetch(job.channelId).catch(() => null);
    if (!channel?.isTextBased())
        throw new Error('panel channel is unavailable');
    const cfg = db.getConfig(guild.id);
    if (job.kind === 'ticket') {
        db.saveConfig(guild.id, { ticket: { panelChannelId: channel.id } });
        return channel.send({ embeds: [ui.ticketPanelEmbed(guild.name, db.getConfig(guild.id).ticket)], components: [ui.ticketPanelRow()] });
    }
    if (job.kind === 'staffapp') {
        const a = cfg.staffApplications || {};
        db.saveConfig(guild.id, { staffApplications: { panelChannelId: channel.id } });
        return channel.send({
            embeds: [ui.base(a.title || 'Staff Applications').setDescription(a.description || 'Click Apply to start your application.')],
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('staffapp_apply').setLabel('Apply').setStyle(ButtonStyle.Success))]
        });
    }
    if (job.kind === 'birthday') {
        db.saveConfig(guild.id, { birthdays: { panelChannelId: channel.id } });
        return channel.send({
            embeds: [ui.birthdaySetupEmbed(db.getConfig(guild.id).birthdays)],
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('birthday_set').setLabel('Set Birthday').setStyle(ButtonStyle.Primary))]
        });
    }
    if (job.kind === 'buttonrole') {
        const p = job.panel;
        const buttons = (p.buttons || []).filter(b => guild.roles.cache.has(b.roleId));
        if (!buttons.length)
            throw new Error('none of the panel roles exist');
        const e = ui.base(p.title || 'Choose your roles').setDescription(p.description || 'Press a button to get or remove a role.');
        if (p.image)
            e.setImage(p.image);
        let components = [];
        for (let i = 0; i < buttons.length; i += 5) {
            const row = new ActionRowBuilder();
            for (const b of buttons.slice(i, i + 5))
                row.addComponents(new ButtonBuilder().setCustomId(`rolebtn:${p.id}:${b.roleId}`).setLabel(b.label || 'Role').setStyle(ButtonStyle.Primary));
            components.push(row);
        }
        if (p.embedType === 'selection') {
            const menu = new StringSelectMenuBuilder().setCustomId(`role_select:${p.id}`).setPlaceholder('Choose a role…')
                .addOptions(buttons.slice(0, 25).map(b => ({ label: (b.label || 'Role').slice(0, 100), value: b.roleId })));
            components = [new ActionRowBuilder().addComponents(menu)];
        }
        const msg = await channel.send({ embeds: [e], components });
        db.upsertPanel(guild.id, 'button', { ...p, buttons, messageId: msg.id });
        return msg;
    }
    if (job.kind === 'reactionrole') {
        const p = job.panel;
        const mappings = (p.mappings || []).filter(m => guild.roles.cache.has(m.roleId));
        if (!mappings.length)
            throw new Error('none of the panel roles exist');
        const e = ui.base(p.title || 'Choose your roles').setDescription(p.description || 'React below to receive or remove a role.');
        if (p.image)
            e.setImage(p.image);
        const msg = await channel.send({ embeds: [e] });
        for (const m of mappings)
            await msg.react(m.emoji).catch(() => { });
        db.upsertPanel(guild.id, 'reaction', { ...p, mappings, messageId: msg.id });
        return msg;
    }
    throw new Error(`unknown panel type ${job.kind}`);
}
async function handleInteraction(i) {
    const id = i.customId;
    if (!id || !id.startsWith(`${DELETE_ID}:`))
        return false;
    const uid = id.split(':')[2];
    const allowed = i.user.id === uid || i.memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (!allowed) {
        await i.reply({ embeds: [ui.slimError('Not allowed', 'Only the person who loaded the template or an Administrator can delete this channel.')], ephemeral: true }).catch(() => { });
        return true;
    }
    await i.deferUpdate().catch(() => { });
    try {
        await i.channel.delete('AunXz /template load finished — progress channel removed');
    }
    catch (e) {
        await i.followUp({ embeds: [ui.slimError('Could not delete', short(e))], ephemeral: true }).catch(() => { });
    }
    return true;
}
module.exports = {
    MAX_CODE_LENGTH, createSnapshot, encodeSnapshot, decodeSnapshot, resolveSnapshot, runLoad, handleInteraction, normalizeSnapshot, completionEmbed,
    _internal: { encodeIds, decodeIds, collectCustomIds, arrangeRoles, arrangeChannels, syncOverwrites, restoreSavedEmbeds, postSavedEmbeds, completionEmbed }
};

