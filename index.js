'use strict';
const __nativeRequire = require;
const __path = __nativeRequire('node:path');
const __baseDir = __dirname;
const __modules = Object.create(null);
__modules["applications.js"] = function(module, exports, require, __filename, __dirname) {
const { PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder, ChannelType, EmbedBuilder } = require('discord.js');
const db = require('./database');
const ui = require('./ui');
const h = require('./helpers');
const sessions = new Map();
const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;
const SESSION_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_QUESTIONS = 25;
const REVIEW_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
const cfgOf = guildId => db.getConfig(guildId).staffApplications || {};
const bar = (i, n) => '▰'.repeat(i) + '▱'.repeat(Math.max(0, n - i));
const btn = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
function clearSession(userId) {
    const s = sessions.get(userId);
    if (s?.timer)
        clearTimeout(s.timer);
    sessions.delete(userId);
}
function armTimeout(session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(async () => {
        if (sessions.get(session.userId) !== session)
            return;
        sessions.delete(session.userId);
        console.log(`[Applications] session for ${session.userId} timed out`);
        await session.user?.send({ embeds: [h.warnEmbed('Application timed out', 'You took too long to answer. Press **Apply** in the server to start again.')] }).catch(() => { });
    }, QUESTION_TIMEOUT_MS);
    session.timer.unref?.();
}
function liveSession(userId) {
    const s = sessions.get(userId);
    if (s && Date.now() - s.startedAt > SESSION_MAX_AGE_MS) {
        clearSession(userId);
        return null;
    }
    return s || null;
}
async function checkEligibility(interaction) {
    const guild = interaction.guild;
    const cfg = cfgOf(guild.id);
    if (!cfg.enabled || !(cfg.questions || []).length)
        return 'Applications are not open right now (disabled or no questions configured).';
    const review = cfg.logChannelId ? (guild.channels.cache.get(cfg.logChannelId) || await guild.channels.fetch(cfg.logChannelId).catch(() => null)) : null;
    if (!review)
        return 'Staff have not set a review channel yet (or it was deleted). Please tell an admin.';
    const missing = h.missingChannelPerms(review, guild.members.me, REVIEW_PERMS);
    if (missing.length)
        return `The review channel ${review} is not usable: I am missing **${missing.join(', ')}** there. Please tell an admin.`;
    if (db.pendingApplicationForUser(guild.id, interaction.user.id))
        return 'You already have an application waiting for review. You will be notified when staff decide.';
    const last = db.lastApplicationForUser(guild.id, interaction.user.id);
    const cooldownMs = Math.max(0, Number(cfg.cooldownHours ?? 24)) * 3600000;
    if (last && cooldownMs && Date.now() - last.createdAt < cooldownMs) {
        return `You can apply again <t:${Math.floor((last.createdAt + cooldownMs) / 1000)}:R> (cooldown: ${cfg.cooldownHours}h).`;
    }
    return null;
}
async function handleApply(interaction) {
    await interaction.deferReply({ ephemeral: true });
    console.log(`[Applications] apply pressed by ${interaction.user.id} in ${interaction.guildId}`);
    const problem = await checkEligibility(interaction);
    if (problem)
        return interaction.editReply({ embeds: [h.errorEmbed('Cannot apply', problem)] });
    if (liveSession(interaction.user.id)) {
        return interaction.editReply({
            embeds: [h.warnEmbed('Application in progress', 'You already have an application open. Continue it, or cancel it and start over.')],
            components: [new ActionRowBuilder().addComponents(btn('staffapp_reset', 'Cancel & start over', ButtonStyle.Danger))]
        });
    }
    const cfg = cfgOf(interaction.guildId);
    const intro = ui.base(cfg.title || 'Staff Applications').setDescription(`${cfg.dmIntro || 'Are you ready to start your staff application?'}\n\n**${cfg.questions.length}** question(s) • you have ${QUESTION_TIMEOUT_MS / 60000} minutes per answer.`)
        .setFooter({ text: `Server: ${interaction.guild.name}` });
    try {
        const dm = await interaction.user.createDM();
        await dm.send({ embeds: [intro], components: [new ActionRowBuilder().addComponents(btn('staffapp_ready', 'Ready', ButtonStyle.Success), btn('staffapp_notready', 'Not now'))] });
    }
    catch (e) {
        console.warn(`[Applications] DM to ${interaction.user.id} failed: ${e?.code || ''} ${e?.message || e}`);
        return interaction.editReply({
            embeds: [h.warnEmbed('I could not DM you', `Your DMs look closed (${e?.code === 50007 ? 'Discord error 50007: cannot send messages to this user' : e?.message || 'DM failed'}).\n\n**Option 1:** enable *Direct Messages* for this server in Privacy Settings and press Apply again.\n**Option 2:** answer right here in pop-up forms — no DMs needed.`)],
            components: [new ActionRowBuilder().addComponents(btn('staffapp_modalstart', 'Answer here instead', ButtonStyle.Primary))]
        });
    }
    sessions.set(interaction.user.id, { userId: interaction.user.id, user: interaction.user, guildId: interaction.guildId, mode: 'dm', step: 'intro', answers: [], index: 0, startedAt: Date.now() });
    return interaction.editReply({ embeds: [h.successEmbed('Check your DMs', 'I sent you the application. Press **Ready** there to begin.')] });
}
function questionPayload(session) {
    const qs = cfgOf(session.guildId).questions || [];
    const n = qs.length;
    const i = session.index;
    return {
        embeds: [ui.base(`Question ${i + 1}/${n}`).setDescription(`${h.clip(qs[i], 1500)}\n\n\`${bar(i, n)}\` ${Math.round((i / n) * 100)}%\n*Reply to this message with your answer.*`)],
        components: [new ActionRowBuilder().addComponents(btn('staffapp_cancel', 'Cancel application', ButtonStyle.Danger))]
    };
}
function reviewPayload(session) {
    const qs = cfgOf(session.guildId).questions || [];
    const embed = ui.base('Review your application').setDescription('Check your answers, then **Submit** or **Cancel**.');
    qs.slice(0, 10).forEach((q, i) => embed.addFields({ name: h.clip(`${i + 1}. ${q}`, 250), value: h.clip(session.answers[i] || '—', 300) }));
    if (qs.length > 10)
        embed.setFooter({ text: `Showing 10 of ${qs.length} answers` });
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(btn('staffapp_submit', 'Submit', ButtonStyle.Success), btn('staffapp_cancel', 'Cancel', ButtonStyle.Danger))] };
}
async function handleDM(message) {
    const session = liveSession(message.author.id);
    if (!session || session.mode !== 'dm' || session.step !== 'asking')
        return false;
    const text = [message.content?.trim(), ...[...message.attachments.values()].map(a => a.url)].filter(Boolean).join('\n');
    if (!text)
        return true;
    const qs = cfgOf(session.guildId).questions || [];
    session.answers[session.index] = text.slice(0, 1500);
    session.index += 1;
    if (session.index < qs.length) {
        armTimeout(session);
        await message.author.send(questionPayload(session)).catch(e => console.warn('[Applications] could not send next question:', e?.message));
    }
    else {
        session.step = 'review';
        clearTimeout(session.timer);
        await message.author.send(reviewPayload(session)).catch(e => console.warn('[Applications] could not send review:', e?.message));
    }
    return true;
}
function modalFor(session) {
    const qs = cfgOf(session.guildId).questions || [];
    const pages = Math.ceil(qs.length / 5);
    const start = session.page * 5;
    const modal = new ModalBuilder().setCustomId(`staffapp_modal:${session.page}`).setTitle(`Application ${session.page + 1}/${pages}`.slice(0, 45));
    qs.slice(start, start + 5).forEach((q, k) => {
        const input = new TextInputBuilder().setCustomId(`q${start + k}`).setLabel(h.clip(`${start + k + 1}. ${q}`, 45)).setPlaceholder(h.clip(q, 100))
            .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
        if (session.answers[start + k])
            input.setValue(session.answers[start + k].slice(0, 1000));
        modal.addComponents(new ActionRowBuilder().addComponents(input));
    });
    return modal;
}
function pageIntro(session) {
    const qs = cfgOf(session.guildId).questions || [];
    const start = session.page * 5;
    const pages = Math.ceil(qs.length / 5);
    const lines = qs.slice(start, start + 5).map((q, k) => `**${start + k + 1}.** ${h.clip(q, 300)}`);
    return {
        embeds: [ui.base(`Page ${session.page + 1}/${pages}`).setDescription(`${lines.join('\n')}\n\n\`${bar(session.page, pages)}\``)],
        components: [new ActionRowBuilder().addComponents(btn('staffapp_next', 'Open form', ButtonStyle.Primary), btn('staffapp_cancel', 'Cancel', ButtonStyle.Danger))]
    };
}
async function startModalFlow(interaction) {
    const problem = await checkEligibility(interaction);
    if (problem)
        return interaction.reply({ embeds: [h.errorEmbed('Cannot apply', problem)], ephemeral: true });
    clearSession(interaction.user.id);
    const session = { userId: interaction.user.id, user: interaction.user, guildId: interaction.guildId, mode: 'modal', step: 'asking', answers: [], page: 0, index: 0, startedAt: Date.now() };
    sessions.set(interaction.user.id, session);
    return interaction.showModal(modalFor(session));
}
function reviewEmbeds(app, user, cfg, { status = 'Pending review', color = ui.THEME, reviewer = null, reason = null } = {}) {
    const head = ui.base(`Staff Application #${app.id}`).setColor(color).setDescription(`**Applicant:** <@${app.userId}> (\`${user?.tag || app.userId}\`)\n**Submitted:** <t:${Math.floor(app.createdAt / 1000)}:R>\n**Status:** ${status}` +
        (reviewer ? `\n**Reviewed by:** <@${reviewer}>` : '') + (reason ? `\n**Reason:** ${h.clip(reason, 500)}` : ''));
    if (user?.displayAvatarURL)
        head.setThumbnail(user.displayAvatarURL());
    const embeds = [head];
    let cur = head;
    let used = 0;
    let fields = 0;
    (cfg.questions || []).slice(0, MAX_QUESTIONS).forEach((q, i) => {
        const name = h.clip(`${i + 1}. ${q}`, 250);
        const value = h.clip(app.answers[i] || 'No answer', 1000);
        if (fields >= 12 || used + name.length + value.length > 3500) {
            cur = ui.base(`Application #${app.id} (cont.)`).setColor(color);
            embeds.push(cur);
            used = 0;
            fields = 0;
        }
        cur.addFields({ name, value });
        used += name.length + value.length;
        fields += 1;
    });
    return embeds.slice(0, 10);
}
function reviewRow(id, disabled = false) {
    return new ActionRowBuilder().addComponents(btn(`staffapp_review:accept:${id}`, 'Accept', ButtonStyle.Success).setDisabled(disabled), btn(`staffapp_review:deny:${id}`, 'Deny', ButtonStyle.Danger).setDisabled(disabled), btn(`staffapp_review:ask:${id}`, 'Ask Question', ButtonStyle.Primary).setDisabled(disabled));
}
async function submitApplication(interaction, session) {
    const guild = interaction.client.guilds.cache.get(session.guildId);
    if (!guild)
        throw new Error('I am no longer in that server.');
    const cfg = cfgOf(guild.id);
    const fakeCtx = { guild, user: interaction.user };
    const problem = await checkEligibility(fakeCtx);
    if (problem)
        throw new Error(problem);
    const review = guild.channels.cache.get(cfg.logChannelId) || await guild.channels.fetch(cfg.logChannelId).catch(() => null);
    const app = db.createApplication(guild.id, session.userId, session.answers);
    try {
        const msg = await review.send({ embeds: reviewEmbeds(app, interaction.user, cfg), components: [reviewRow(app.id)] });
        db.updateApplication(app.id, { channelId: review.id, messageId: msg.id });
    }
    catch (e) {
        db.updateApplication(app.id, { status: 'failed' });
        throw new Error(`I could not post your application to the review channel: ${e?.message || e}`);
    }
    if (cfg.applicantRoleId) {
        const member = await guild.members.fetch(session.userId).catch(() => null);
        const role = guild.roles.cache.get(cfg.applicantRoleId);
        if (member && role && role.position < guild.members.me.roles.highest.position)
            await member.roles.add(role, 'Staff application submitted').catch(e => console.warn('[Applications] applicant role failed:', e?.message));
    }
    clearSession(session.userId);
    return app;
}
async function reviewButton(interaction) {
    const [, action, idRaw] = interaction.customId.split(':');
    if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ embeds: [h.errorEmbed('Missing permissions', 'You need **Manage Server** to review applications.')], ephemeral: true });
    }
    const app = db.getApplication(idRaw);
    if (!app || app.status !== 'pending')
        return interaction.reply({ embeds: [h.warnEmbed('Already handled', 'That application is no longer pending.')], ephemeral: true });
    if (action === 'ask') {
        return interaction.showModal(new ModalBuilder().setCustomId(`staffapp_ask:${app.id}`).setTitle('Ask the applicant').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('question').setLabel('Your question').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000))));
    }
    return interaction.showModal(new ModalBuilder().setCustomId(`staffapp_reason:${action}:${app.id}`).setTitle(action === 'accept' ? 'Accept application' : 'Deny application').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(800))));
}
async function legacyDecide(interaction) {
    const [, decision, userId] = interaction.customId.split(':');
    const app = db.pendingApplicationForUser(interaction.guildId, userId);
    if (app) {
        interaction.customId = `staffapp_review:${decision === 'accept' ? 'accept' : 'deny'}:${app.id}`;
        return reviewButton(interaction);
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))
        return interaction.reply({ embeds: [h.errorEmbed('Missing permissions', 'You need **Manage Server** to review applications.')], ephemeral: true });
    return interaction.showModal(new ModalBuilder().setCustomId(`staffapp_reason:${decision === 'accept' ? 'accept' : 'deny'}:u${userId}`).setTitle(decision === 'accept' ? 'Accept application' : 'Deny application').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false))));
}
async function reasonModal(interaction) {
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.editReply({ embeds: [h.errorEmbed('Missing permissions', 'You need **Manage Server**.')] });
    }
    let [, decision, ref] = interaction.customId.split(':');
    decision = decision === 'accept' ? 'accept' : 'deny';
    const reason = interaction.fields.getTextInputValue('reason').trim() || null;
    const cfg = cfgOf(interaction.guildId);
    let app = null;
    let userId;
    if (/^u?\d{15,25}$/.test(ref))
        userId = ref.replace(/^u/, '');
    else {
        app = db.getApplication(ref);
        if (!app || app.status !== 'pending')
            return interaction.editReply({ embeds: [h.warnEmbed('Already handled', 'That application is no longer pending.')] });
        userId = app.userId;
    }
    const results = [];
    const user = await interaction.client.users.fetch(userId).catch(() => null);
    const guild = interaction.guild;
    if (decision === 'accept' && cfg.acceptedRoleId) {
        const member = await guild.members.fetch(userId).catch(() => null);
        const role = guild.roles.cache.get(cfg.acceptedRoleId);
        const me = guild.members.me;
        if (!member)
            results.push(`${h.THEME.emoji.err()} Accepted role not given: the applicant is no longer in the server.`);
        else if (!role)
            results.push(`${h.THEME.emoji.err()} Accepted role not given: the configured role no longer exists.`);
        else if (!me.permissions.has(PermissionFlagsBits.ManageRoles))
            results.push(`${h.THEME.emoji.err()} Accepted role not given: I need **Manage Roles**.`);
        else if (role.position >= me.roles.highest.position)
            results.push(`${h.THEME.emoji.err()} Accepted role not given: ${role} is equal to or above my highest role (move my role higher).`);
        else {
            try {
                await member.roles.add(role, `Staff application #${app?.id ?? '?'} accepted by ${interaction.user.tag}`);
                if (cfg.applicantRoleId && cfg.applicantRoleId !== role.id)
                    await member.roles.remove(cfg.applicantRoleId).catch(() => { });
                results.push(`${h.THEME.emoji.ok()} Gave ${role} to <@${userId}>.`);
            }
            catch (e) {
                results.push(`${h.THEME.emoji.err()} Role change failed: ${e?.message || e}`);
            }
        }
    }
    const dmText = decision === 'accept' ? (cfg.acceptMessage || 'Your application was accepted.') : (cfg.denyMessage || 'Your application was not accepted.');
    if (!user)
        results.push(`${h.THEME.emoji.err()} Could not DM the applicant (user not found).`);
    else {
        const embed = decision === 'accept' ? h.successEmbed('Application accepted', `${dmText}${reason ? `\n\n**Note from staff:** ${reason}` : ''}`) : h.errorEmbed('Application not accepted', `${dmText}${reason ? `\n\n**Note from staff:** ${reason}` : ''}`);
        const sent = await user.send({ embeds: [embed.setFooter({ text: guild.name })] }).then(() => true).catch(() => false);
        results.push(sent ? `${h.THEME.emoji.ok()} Applicant notified by DM.` : `${h.THEME.emoji.err()} Could not DM the applicant (their DMs are closed).`);
    }
    if (app) {
        db.updateApplication(app.id, { status: decision === 'accept' ? 'accepted' : 'denied', reviewerId: interaction.user.id, reason, decidedAt: Date.now() });
        try {
            const ch = await interaction.client.channels.fetch(app.channelId);
            const msg = await ch.messages.fetch(app.messageId);
            await msg.edit({
                embeds: reviewEmbeds(db.getApplication(app.id), user, cfg, { status: decision === 'accept' ? `${h.THEME.emoji.ok()} Accepted` : `${h.THEME.emoji.err()} Denied`, color: decision === 'accept' ? ui.OK : ui.DANGER, reviewer: interaction.user.id, reason }),
                components: [reviewRow(app.id, true)]
            });
        }
        catch (e) {
            results.push(`${h.THEME.emoji.warn()} Decision saved, but I could not update the review message: ${e?.message || e}`);
        }
    }
    return interaction.editReply({ embeds: [h.successEmbed(`Application ${decision === 'accept' ? 'accepted' : 'denied'}`, `<@${userId}>${reason ? `\n**Reason:** ${reason}` : ''}\n\n${results.join('\n')}`)] });
}
async function askModal(interaction) {
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))
        return interaction.editReply({ embeds: [h.errorEmbed('Missing permissions', 'You need **Manage Server**.')] });
    const app = db.getApplication(interaction.customId.split(':')[1]);
    if (!app || app.status !== 'pending')
        return interaction.editReply({ embeds: [h.warnEmbed('Already handled', 'That application is no longer pending.')] });
    const question = interaction.fields.getTextInputValue('question').trim();
    const user = await interaction.client.users.fetch(app.userId).catch(() => null);
    if (!user)
        return interaction.editReply({ embeds: [h.errorEmbed('Applicant not found', 'I could not find that user.')] });
    try {
        await user.send({ embeds: [ui.base('Question about your application').setDescription(`**${interaction.guild.name}** staff asks:\n\n${h.clip(question, 1500)}`)], components: [new ActionRowBuilder().addComponents(btn(`staffapp_answer:${app.id}`, 'Answer', ButtonStyle.Primary))] });
    }
    catch (e) {
        return interaction.editReply({ embeds: [h.errorEmbed('Could not DM the applicant', `Their DMs are closed (${e?.message || 'DM failed'}). Contact them another way.`)] });
    }
    return interaction.editReply({ embeds: [h.successEmbed('Question sent', `Asked <@${app.userId}>. Their reply will appear in the review channel.`)] });
}
async function answerModal(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const app = db.getApplication(interaction.customId.split(':')[1]);
    if (!app || app.userId !== interaction.user.id)
        return interaction.editReply({ embeds: [h.errorEmbed('Not available', 'This question is no longer valid.')] });
    const answer = interaction.fields.getTextInputValue('answer').trim();
    try {
        const ch = await interaction.client.channels.fetch(app.channelId);
        await ch.send({ embeds: [ui.base(`Answer from applicant — #${app.id}`).setDescription(`<@${app.userId}> replied:\n\n${h.clip(answer, 3500)}`)], reply: { messageReference: app.messageId, failIfNotExists: false } });
    }
    catch (e) {
        return interaction.editReply({ embeds: [h.errorEmbed('Could not deliver your answer', String(e?.message || e))] });
    }
    return interaction.editReply({ embeds: [h.successEmbed('Answer sent', 'Staff received your reply.')] });
}
const qState = new Map();
const sk = (g, u) => `${g}:${u}`;
function homePayload(guild, userId) {
    const cfg = cfgOf(guild.id);
    const ch = id => (id ? `<#${id}>` : 'Not set');
    const role = id => (id ? `<@&${id}>` : 'Not set');
    const embed = ui.base(`${h.THEME.emoji.settings()} Staff Applications`).setDescription('Members press **Apply** and answer your questions by DM (or pop-up forms if their DMs are closed). Answers land in the review channel with Accept / Deny / Ask buttons.')
        .addFields({ name: 'Status', value: cfg.enabled ? `${h.THEME.emoji.on()} Enabled` : `${h.THEME.emoji.off()} Disabled`, inline: true }, { name: 'Questions', value: String((cfg.questions || []).length), inline: true }, { name: 'Cooldown', value: `${cfg.cooldownHours ?? 24}h`, inline: true }, { name: 'Review channel', value: ch(cfg.logChannelId), inline: true }, { name: 'Apply panel channel', value: ch(cfg.panelChannelId), inline: true }, { name: 'Applicant role', value: role(cfg.applicantRoleId), inline: true }, { name: 'Accepted role', value: role(cfg.acceptedRoleId), inline: true }, { name: 'Panel text', value: h.clip(`**${cfg.title || '—'}** — ${cfg.description || '—'}`, 300) });
    const roleSelect = (id, ph, cur) => { const m = new RoleSelectMenuBuilder().setCustomId(`staffcfg:${id}:${userId}`).setPlaceholder(ph).setMinValues(0).setMaxValues(1); if (cur)
        m.setDefaultRoles(cur); return new ActionRowBuilder().addComponents(m); };
    const chSelect = (id, ph, cur) => { const m = new ChannelSelectMenuBuilder().setCustomId(`staffcfg:${id}:${userId}`).setPlaceholder(ph).setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement); if (cur)
        m.setDefaultChannels(cur); return new ActionRowBuilder().addComponents(m); };
    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(h.toggleButton(`staffcfg:toggle:${userId}`, !!cfg.enabled), btn(`staffcfg:questions:${userId}`, 'Questions', ButtonStyle.Primary), btn(`staffcfg:msgs:${userId}`, 'Messages', ButtonStyle.Primary), btn(`staffcfg:cooldown:${userId}`, 'Cooldown'), btn(`staffcfg:post:${userId}`, 'Post Apply Panel', ButtonStyle.Success)),
            chSelect('review', 'Review channel…', cfg.logChannelId), chSelect('panelch', 'Apply panel channel…', cfg.panelChannelId),
            roleSelect('applicant', 'Applicant role (clear to remove)…', cfg.applicantRoleId), roleSelect('accepted', 'Accepted role (clear to remove)…', cfg.acceptedRoleId)
        ]
    };
}
function questionsPayload(guild, userId) {
    const cfg = cfgOf(guild.id);
    const qs = cfg.questions || [];
    const sel = qState.get(sk(guild.id, userId));
    const lines = qs.map((q, i) => `${i === sel ? '▶️' : '▫️'} **${i + 1}.** ${h.clip(q, 110)}`);
    const embed = ui.base(`${h.THEME.emoji.list} Application questions`).setDescription(lines.join('\n') || 'No questions yet — press **Add**.').addFields({ name: 'Selected', value: sel !== undefined && qs[sel] ? h.clip(qs[sel], 500) : 'None — pick one in the menu', inline: false }, { name: 'Limit', value: `${qs.length}/${MAX_QUESTIONS}`, inline: true });
    const rows = [];
    if (qs.length)
        rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`staffcfg:qsel:${userId}`).setPlaceholder('Select a question to edit/move/remove…').addOptions(qs.map((q, i) => ({ label: h.clip(`${i + 1}. ${q}`, 100), value: String(i), default: i === sel })))));
    const has = sel !== undefined && qs[sel] !== undefined;
    rows.push(new ActionRowBuilder().addComponents(btn(`staffcfg:qadd:${userId}`, 'Add', ButtonStyle.Success).setDisabled(qs.length >= MAX_QUESTIONS), btn(`staffcfg:qedit:${userId}`, 'Edit', ButtonStyle.Primary).setDisabled(!has), btn(`staffcfg:qrm:${userId}`, 'Remove', ButtonStyle.Danger).setDisabled(!has), btn(`staffcfg:qup:${userId}`, '▲').setDisabled(!has || sel === 0), btn(`staffcfg:qdown:${userId}`, '▼').setDisabled(!has || sel === qs.length - 1)));
    rows.push(new ActionRowBuilder().addComponents(btn(`staffcfg:home:${userId}`, 'Back', ButtonStyle.Secondary).setEmoji(h.THEME.emoji.back), btn(`staffcfg:qclear:${userId}`, 'Clear all', ButtonStyle.Danger).setDisabled(!qs.length)));
    return { embeds: [embed], components: rows };
}
async function openSetup(interaction) {
    if (!interaction.guild)
        return h.safeReply(interaction, { embeds: [h.errorEmbed('Server only', 'Use this inside a server.')], ephemeral: true });
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
        return h.safeReply(interaction, { embeds: [h.errorEmbed('Missing permissions', 'You need **Administrator**.')], ephemeral: true });
    const render = () => homePayload(interaction.guild, interaction.user.id);
    const sent = await h.safeReply(interaction, { ...render(), ephemeral: true });
    h.watchPanel(interaction, sent, render);
}
const textModal = (id, title, fields) => new ModalBuilder().setCustomId(id).setTitle(title).addComponents(fields.map(f => { const t = new TextInputBuilder().setCustomId(f.id).setLabel(f.label).setStyle(f.long ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(f.required !== false).setMaxLength(f.max || 200); if (f.value)
    t.setValue(String(f.value).slice(0, f.max || 200)); return new ActionRowBuilder().addComponents(t); }));
async function setupInteraction(interaction) {
    const parts = interaction.customId.split(':');
    const action = parts[1];
    const userId = parts[2];
    if (!await h.authorOnly(interaction, userId))
        return;
    if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ embeds: [h.errorEmbed('Missing permissions', 'You need **Administrator**.')], ephemeral: true });
    }
    const g = interaction.guild;
    const gid = g.id;
    const cfg = cfgOf(gid);
    const key = sk(gid, userId);
    const save = patch => db.saveConfig(gid, { staffApplications: patch });
    const home = () => interaction.update(homePayload(g, userId));
    const qs = [...(cfg.questions || [])];
    if (interaction.isChannelSelectMenu()) {
        save(action === 'review' ? { logChannelId: interaction.values[0] } : { panelChannelId: interaction.values[0] });
        return home();
    }
    if (interaction.isRoleSelectMenu()) {
        save({ [action === 'applicant' ? 'applicantRoleId' : 'acceptedRoleId']: interaction.values[0] || null });
        return home();
    }
    if (interaction.isStringSelectMenu() && action === 'qsel') {
        qState.set(key, Number(interaction.values[0]));
        return interaction.update(questionsPayload(g, userId));
    }
    if (interaction.isModalSubmit()) {
        const f = id => interaction.fields.getTextInputValue(id).trim();
        const back = payload => (interaction.isFromMessage?.() ? interaction.update(payload) : interaction.reply({ ...payload, ephemeral: true }));
        if (action === 'msg') {
            const next = { title: f('title') || 'Staff Applications', description: f('description') || 'Click Apply to start your application.', dmIntro: f('dmIntro') || 'Are you ready to start your staff application?', acceptMessage: f('accept') || 'Your application was accepted.', denyMessage: f('deny') || 'Your application was not accepted.' };
            save(next);
            return back(homePayload(g, userId));
        }
        if (action === 'cd') {
            const hours = Number(f('hours'));
            if (!Number.isFinite(hours) || hours < 0 || hours > 720)
                return interaction.reply({ embeds: [h.errorEmbed('Invalid cooldown', 'Enter a number of hours between 0 and 720.')], ephemeral: true });
            save({ cooldownHours: Math.floor(hours) });
            return back(homePayload(g, userId));
        }
        if (action === 'qadd_m' || action === 'qedit_m') {
            const text = f('q');
            if (!text)
                return interaction.reply({ embeds: [h.errorEmbed('Invalid question', 'The question cannot be empty.')], ephemeral: true });
            if (action === 'qadd_m') {
                if (qs.length >= MAX_QUESTIONS)
                    return interaction.reply({ embeds: [h.errorEmbed('Limit reached', `Max ${MAX_QUESTIONS} questions.`)], ephemeral: true });
                qs.push(text);
                qState.set(key, qs.length - 1);
            }
            else {
                const i = qState.get(key);
                if (i === undefined || qs[i] === undefined)
                    return interaction.reply({ embeds: [h.errorEmbed('No question selected', 'Pick a question first.')], ephemeral: true });
                qs[i] = text;
            }
            save({ questions: qs });
            return back(questionsPayload(g, userId));
        }
        return;
    }
    const sel = qState.get(key);
    switch (action) {
        case 'toggle': {
            if (!cfg.enabled && (!qs.length || !cfg.logChannelId))
                return interaction.reply({ embeds: [h.errorEmbed('Not ready', 'Add at least one question and choose a review channel before enabling applications.')], ephemeral: true });
            save({ enabled: !cfg.enabled });
            return home();
        }
        case 'home': return home();
        case 'questions': return interaction.update(questionsPayload(g, userId));
        case 'msgs': return interaction.showModal(textModal(`staffcfg:msg:${userId}`, 'Customize messages', [
            { id: 'title', label: 'Panel title', max: 100, value: cfg.title }, { id: 'description', label: 'Panel description', long: true, max: 500, value: cfg.description },
            { id: 'dmIntro', label: 'DM intro text', long: true, max: 500, value: cfg.dmIntro }, { id: 'accept', label: 'Accepted message', long: true, max: 500, value: cfg.acceptMessage }, { id: 'deny', label: 'Denied message', long: true, max: 500, value: cfg.denyMessage }
        ]));
        case 'cooldown': return interaction.showModal(textModal(`staffcfg:cd:${userId}`, 'Application cooldown', [{ id: 'hours', label: 'Cooldown in hours (0 = none)', max: 3, value: cfg.cooldownHours ?? 24 }]));
        case 'qadd': return interaction.showModal(textModal(`staffcfg:qadd_m:${userId}`, 'Add question', [{ id: 'q', label: 'Question', long: true, max: 500 }]));
        case 'qedit': return sel !== undefined && qs[sel] !== undefined ? interaction.showModal(textModal(`staffcfg:qedit_m:${userId}`, 'Edit question', [{ id: 'q', label: 'Question', long: true, max: 500, value: qs[sel] }])) : interaction.reply({ embeds: [h.errorEmbed('No question selected', 'Pick one in the menu.')], ephemeral: true });
        case 'qrm':
            if (sel !== undefined && qs[sel] !== undefined) {
                qs.splice(sel, 1);
                qState.delete(key);
                save({ questions: qs });
            }
            return interaction.update(questionsPayload(g, userId));
        case 'qup':
        case 'qdown': {
            const j = action === 'qup' ? sel - 1 : sel + 1;
            if (sel !== undefined && qs[sel] !== undefined && qs[j] !== undefined) {
                [qs[sel], qs[j]] = [qs[j], qs[sel]];
                qState.set(key, j);
                save({ questions: qs });
            }
            return interaction.update(questionsPayload(g, userId));
        }
        case 'qclear': return interaction.update({ embeds: [h.warnEmbed('Clear all questions?', 'This removes every application question. This cannot be undone.')], components: [h.confirmRow(`staffcfg:qclearc:${userId}`, { yes: 'Clear all' })] });
        case 'qclearc': {
            if (parts[3] === 'yes') {
                save({ questions: [] });
                qState.delete(key);
            }
            return interaction.update(questionsPayload(g, userId));
        }
        case 'post': {
            if (!cfg.panelChannelId)
                return interaction.reply({ embeds: [h.errorEmbed('No panel channel', 'Choose the **Apply panel channel** first.')], ephemeral: true });
            if (!qs.length)
                return interaction.reply({ embeds: [h.errorEmbed('No questions', 'Add at least one question first.')], ephemeral: true });
            const ch = g.channels.cache.get(cfg.panelChannelId) || await g.channels.fetch(cfg.panelChannelId).catch(() => null);
            if (!ch)
                return interaction.reply({ embeds: [h.errorEmbed('Channel missing', 'The panel channel no longer exists.')], ephemeral: true });
            const missing = h.missingChannelPerms(ch, g.members.me, REVIEW_PERMS);
            if (missing.length)
                return interaction.reply({ embeds: [h.errorEmbed('Missing permissions', `I need **${missing.join(', ')}** in ${ch}.`)], ephemeral: true });
            try {
                const msg = await ch.send({ embeds: [ui.base(cfg.title || 'Staff Applications').setDescription(cfg.description || 'Click Apply to start your application.')], components: [new ActionRowBuilder().addComponents(btn('staffapp_apply', 'Apply', ButtonStyle.Success))] });
                return interaction.reply({ embeds: [h.successEmbed('Apply panel posted', `Posted in ${ch}: ${msg.url}`)], ephemeral: true });
            }
            catch (e) {
                return interaction.reply({ embeds: [h.errorEmbed('Could not post the panel', String(e?.message || e))], ephemeral: true });
            }
        }
    }
}
async function handleInteraction(interaction) {
    const id = interaction.customId;
    if (!id || !(id.startsWith('staffapp_') || id.startsWith('staffcfg:')))
        return false;
    try {
        if (id.startsWith('staffcfg:')) {
            await setupInteraction(interaction);
            return true;
        }
        const base = id.split(':')[0];
        if (interaction.isButton()) {
            switch (base) {
                case 'staffapp_apply':
                    await handleApply(interaction);
                    return true;
                case 'staffapp_ready': {
                    const s = liveSession(interaction.user.id);
                    if (!s || s.mode !== 'dm') {
                        await interaction.reply({ embeds: [h.errorEmbed('No application', 'Press **Apply** in the server first.')], ephemeral: true });
                        return true;
                    }
                    s.step = 'asking';
                    s.index = 0;
                    s.answers = [];
                    armTimeout(s);
                    await interaction.update({ embeds: [h.successEmbed('Application started', 'Answer each question by replying in this chat.')], components: [] });
                    await interaction.followUp(questionPayload(s));
                    return true;
                }
                case 'staffapp_notready':
                    clearSession(interaction.user.id);
                    await interaction.update({ embeds: [h.warnEmbed('Not started', 'No application was started. Press Apply again when ready.')], components: [] });
                    return true;
                case 'staffapp_cancel':
                    clearSession(interaction.user.id);
                    await interaction.update({ embeds: [h.infoEmbed('Application cancelled', 'Nothing was submitted. Press Apply again any time.')], components: [] });
                    return true;
                case 'staffapp_reset':
                    clearSession(interaction.user.id);
                    await interaction.update({ embeds: [h.infoEmbed('Cleared', 'Your previous application was cancelled. Press **Apply** again.')], components: [] });
                    return true;
                case 'staffapp_modalstart':
                    await startModalFlow(interaction);
                    return true;
                case 'staffapp_next': {
                    const s = liveSession(interaction.user.id);
                    if (!s || s.mode !== 'modal') {
                        await interaction.reply({ embeds: [h.warnEmbed('Session expired', 'Press **Apply** again.')], ephemeral: true });
                        return true;
                    }
                    await interaction.showModal(modalFor(s));
                    return true;
                }
                case 'staffapp_submit': {
                    const s = liveSession(interaction.user.id);
                    if (!s || s.step !== 'review') {
                        await interaction.reply({ embeds: [h.warnEmbed('Nothing to submit', 'Your session expired. Press **Apply** again.')], ephemeral: true });
                        return true;
                    }
                    await interaction.deferUpdate();
                    try {
                        const app = await submitApplication(interaction, s);
                        await interaction.editReply({ embeds: [h.successEmbed('Application submitted', `Application **#${app.id}** was sent to staff. You will be notified here when they decide.`)], components: [] });
                    }
                    catch (e) {
                        console.error('[Applications] submit failed:', e);
                        await interaction.editReply({ embeds: [h.errorEmbed('Could not submit', String(e?.message || e).slice(0, 1500))], components: s.mode === 'modal' || s.mode === 'dm' ? [new ActionRowBuilder().addComponents(btn('staffapp_submit', 'Try again', ButtonStyle.Primary), btn('staffapp_cancel', 'Cancel', ButtonStyle.Danger))] : [] });
                    }
                    return true;
                }
                case 'staffapp_review':
                    await reviewButton(interaction);
                    return true;
                case 'staffapp_decide':
                    await legacyDecide(interaction);
                    return true;
                case 'staffapp_answer': {
                    const app = db.getApplication(id.split(':')[1]);
                    if (!app || app.userId !== interaction.user.id) {
                        await interaction.reply({ embeds: [h.errorEmbed('Not available', 'This question is no longer valid.')], ephemeral: true });
                        return true;
                    }
                    await interaction.showModal(textModal(`staffapp_answer_modal:${app.id}`, 'Answer staff question', [{ id: 'answer', label: 'Your answer', long: true, max: 1500 }]));
                    return true;
                }
            }
            return false;
        }
        if (interaction.isModalSubmit()) {
            if (base === 'staffapp_modal') {
                const s = liveSession(interaction.user.id);
                if (!s || s.mode !== 'modal') {
                    await interaction.reply({ embeds: [h.warnEmbed('Session expired', 'Press **Apply** again.')], ephemeral: true });
                    return true;
                }
                const qs = cfgOf(s.guildId).questions || [];
                const start = s.page * 5;
                for (let i = start; i < Math.min(qs.length, start + 5); i++)
                    s.answers[i] = interaction.fields.getTextInputValue(`q${i}`).trim();
                s.page += 1;
                if (s.page * 5 < qs.length)
                    await interaction.reply({ ...pageIntro(s), ephemeral: true });
                else {
                    s.step = 'review';
                    await interaction.reply({ ...reviewPayload(s), ephemeral: true });
                }
                return true;
            }
            if (base === 'staffapp_reason') {
                await reasonModal(interaction);
                return true;
            }
            if (base === 'staffapp_ask') {
                await askModal(interaction);
                return true;
            }
            if (base === 'staffapp_answer_modal') {
                await answerModal(interaction);
                return true;
            }
        }
    }
    catch (e) {
        console.error(`[Applications] handler failed for ${id}:`, e);
        await h.safeReply(interaction, { embeds: [h.errorEmbed('Application error', String(e?.message || e).slice(0, 1500))], ephemeral: true });
    }
    return true;
}
module.exports = { handleInteraction, handleDM, openSetup, _sessions: sessions };

};
__modules["bridge/client.js"] = function(module, exports, require, __filename, __dirname) {
'use strict';
const { BridgeError } = require('./spec');
async function buildTemplate(spec, opts = {}) {
    try {
        return require('./templateBridge').buildTemplateFromSpec(spec, { requestedBy: opts.requestedBy });
    }
    catch (error) {
        if (error instanceof BridgeError)
            throw error;
        throw new BridgeError('internal', String(error?.message || error));
    }
}
module.exports = { buildTemplate };

};
__modules["bridge/generate.js"] = function(module, exports, require, __filename, __dirname) {
'use strict';
const { PERMISSION_NAMES, CHANNEL_TYPES, LIMITS, BridgeError, validateSpec, formatErrors } = require('./spec');
const { buildTemplate } = require('./client');
const API = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_ATTEMPTS = 3;
const MAX_PROMPT = 2000;
class MissingKeyError extends Error {
    constructor() {
        super('OPENROUTER_API_KEY is not set, so AI features are disabled.');
        this.name = 'MissingKeyError';
        this.code = 'missing_key';
        this.howTo = [
            '1. Create a key at https://openrouter.ai/keys (add a little credit if the model you choose is paid).',
            '2. Set it as the environment variable OPENROUTER_API_KEY — in a local .env file, or in the Variables tab on Railway.',
            '3. Restart the app. Never put the key in frontend code or commit it to GitHub.'
        ].join('\n');
    }
}
const SYSTEM_PROMPT = `You design Discord server templates. Reply with ONE JSON object and nothing else (no markdown, no commentary).

SCHEMA
{
  "specVersion": 1,
  "name": string (1-${LIMITS.name} chars),
  "description": string (optional, short),
  "roles": [ { "name": string, "color": "#rrggbb", "hoist": boolean, "mentionable": boolean, "permissions": [PermissionName], "emoji": "single unicode emoji (optional)" } ],
  "channels": [ Channel ]            // optional: channels that sit outside any category
  "categories": [ { "name": string, "overwrites": [Overwrite], "channels": [ Channel ] } ],
  "settings": { "verificationLevel": 0-4, "contentFilter": 0-2, "defaultNotifications": "all"|"mentions", "afkTimeout": 60|300|900|1800|3600 }   // optional
}
Channel   = { "name": string, "type": ${CHANNEL_TYPES.map(t => `"${t}"`).join('|')}, "topic": string (text/announcement/forum only, max ${LIMITS.topic}), "nsfw": boolean, "slowmode": 0-21600 (seconds), "userLimit": 0-99 (voice), "bitrate": 8000-96000 (voice/stage), "overwrites": [Overwrite] }
Overwrite = { "role": "@everyone" | an exact role name from "roles", "allow": [PermissionName], "deny": [PermissionName] }
PermissionName must be exactly one of: ${PERMISSION_NAMES.join(', ')}.

HARD RULES
- Roles are listed from the HIGHEST rank to the LOWEST. Unique names. Never name a role everyone/@everyone.
- At most ${LIMITS.roles} roles, ${LIMITS.perCategory} channels per category, ${LIMITS.channels} channels in total (each category counts as one).
- Text/announcement/forum channel names: lowercase, words joined by hyphens. Voice/stage/category names can use capitals, spaces and emoji.
- Overwrites may only reference "@everyone" or role names that exist in "roles". A permission may not be in both allow and deny of one overwrite.
- Category overwrites are applied to every channel inside it automatically; do not repeat them on each channel.
- Do not output anything outside the schema.

DESIGN GUIDANCE
- Make it genuinely usable: a clear welcome/info area (rules, announcements), community channels, voice channels, and a staff area hidden from @everyone (deny ViewChannel for @everyone, allow it for staff roles).
- Give staff a sensible hierarchy (owner, admin, moderator, helper) with least-privilege permissions; only the top role gets Administrator.
- Read-only info channels: deny SendMessages for @everyone. Write useful channel topics.
- Match the user's theme in names, colours and emoji, but keep names short and readable.
- Size the server to the request. Do not pad it with filler channels.`;
function extractJson(text) {
    let t = String(text || '').trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence)
        t = fence[1].trim();
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a === -1 || b <= a)
        throw new Error('no JSON object found in the reply');
    return JSON.parse(t.slice(a, b + 1));
}
async function callOpenRouter(messages, { signal, useJsonMode = true } = {}) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key)
        throw new MissingKeyError();
    const primary = process.env.OPENROUTER_MODEL || 'openrouter/auto';
    const fallback = String(process.env.OPENROUTER_FALLBACK_MODEL || '').trim();
    const models = [...new Set([primary, fallback].filter(Boolean))];
    const timeoutMs = Math.max(5000, Math.min(120000, Number(process.env.OPENROUTER_TIMEOUT_MS) || 30000));
    const retries = Math.max(0, Math.min(4, Number(process.env.OPENROUTER_MAX_RETRIES ?? 2)));
    let lastError;
    for (const model of models) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            const body = { model, messages, temperature: 0.7, max_tokens: Math.max(512, Math.min(12000, Number(process.env.OPENROUTER_MAX_TOKENS) || 8000)) };
            if (useJsonMode)
                body.response_format = { type: 'json_object' };
            const signals = [AbortSignal.timeout(timeoutMs)];
            if (signal)
                signals.push(signal);
            const started = Date.now();
            let res;
            try {
                res = await fetch(API, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
                        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || process.env.SITE_URL || 'https://github.com/anx6ty/AunXz',
                        'X-Title': process.env.OPENROUTER_APP_NAME || 'AunXz Template Studio'
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.any(signals)
                });
            }
            catch (e) {
                if (signal?.aborted)
                    throw e;
                lastError = new BridgeError('ai_error', `OpenRouter request failed or timed out (${timeoutMs} ms).`);
                console.warn(`[OpenRouter] model=${model} attempt=${attempt + 1} latency_ms=${Date.now() - started} error=${e?.name || 'network'}`);
                if (attempt < retries) {
                    await new Promise(r => setTimeout(r, Math.min(1000 * (attempt + 1), 3000)));
                    continue;
                }
                break;
            }
            const requestId = String(res.headers.get('x-request-id') || res.headers.get('x-openrouter-request-id') || 'n/a').slice(0, 100);
            const data = await res.json().catch(() => null);
            console.log(`[OpenRouter] model=${model} status=${res.status} latency_ms=${Date.now() - started} request_id=${requestId} tokens=${Number(data?.usage?.total_tokens) || 0}`);
            if (res.ok) {
                const text = data?.choices?.[0]?.message?.content;
                if (text && String(text).trim())
                    return { text: String(text), usage: data.usage || null, model, requestId, latencyMs: Date.now() - started };
                lastError = new BridgeError('ai_error', 'The AI returned an empty reply. Try again or pick another model.');
                break;
            }
            const detail = String(data?.error?.message || res.statusText || '').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 200);
            if (res.status === 400 && useJsonMode)
                return callOpenRouter(messages, { signal, useJsonMode: false });
            if (res.status === 401)
                throw new BridgeError('ai_auth', 'OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY.');
            if (res.status === 402) {
                lastError = new BridgeError('ai_credits', 'OpenRouter reports not enough credits (402). Add credits or choose a free model.');
                break;
            }
            if (res.status === 429)
                lastError = new BridgeError('ai_rate_limited', 'OpenRouter rate limit reached. Try again in a moment.');
            else if (res.status >= 500)
                lastError = new BridgeError('ai_error', `OpenRouter provider error ${res.status}.`);
            else {
                lastError = new BridgeError('ai_error', `OpenRouter error ${res.status}: ${detail}`);
                break;
            }
            if (attempt < retries)
                await new Promise(r => setTimeout(r, Math.min(1000 * (attempt + 1), 3000)));
        }
        console.warn(`[OpenRouter] switching_to_fallback=${models.indexOf(model) < models.length - 1}`);
    }
    throw lastError || new BridgeError('ai_error', 'OpenRouter request failed.');
}
function applyNamingStyle(spec, prompt) {
    const text = String(prompt || '');
    const style = (text.match(/NAMING_STYLE=([a-z-]+)/i) || [])[1];
    if (!style || style === 'auto' || style === 'minimal')
        return spec;
    const clean = value => String(value || '').replace(/^[\s﹒ꔫεïз໒୨ৎゝ𓂃╭│╰〢・┊┃┆︱﹕›»「」『』⟡୨୧꒰꒱♡✦✧⋆༄]+|[\s﹒ꔫεïз໒୨ৎゝ𓂃╭│╰〢・┊┃┆︱﹕›»「」『』⟡୨୧꒰꒱♡✦✧⋆༄]+$/gu, '').trim();
    const wrap = (name, emoji, isLast = false) => {
        const n = clean(name).replace(/\s+/g, '-').toLowerCase().slice(0, 70) || 'channel';
        if (style === 'emoji-divider')
            return `${emoji || '✦'}・${n}`;
        if (style === 'tree')
            return `${isLast ? '╰' : '╭'}・${n}`;
        if (style === 'unicode')
            return `﹒𓂃﹒${n}﹒𓂃﹒`;
        if (style === 'emoji-symbols')
            return `${emoji || '✦'}﹒${n}﹒୨ৎ`;
        return name;
    };
    if (Array.isArray(spec.channels))
        spec.channels = spec.channels.map((c, i) => ({ ...c, name: wrap(c.name, c.emoji, i === spec.channels.length - 1) }));
    if (Array.isArray(spec.categories))
        spec.categories = spec.categories.map((cat, ci) => ({
            ...cat,
            name: style === 'tree' ? `${ci === spec.categories.length - 1 ? '╰' : '╭'}・${clean(cat.name).slice(0, 70)}` : wrap(cat.name, cat.emoji, ci === spec.categories.length - 1),
            channels: (cat.channels || []).map((c, i, a) => ({ ...c, name: wrap(c.name, c.emoji, i === a.length - 1) }))
        }));
    return spec;
}
async function generateTemplate({ prompt, refineFrom, requestedBy, onStatus = () => { }, signal } = {}) {
    const userPrompt = String(prompt || '').trim().slice(0, MAX_PROMPT);
    if (!userPrompt)
        throw new BridgeError('invalid_spec', 'Describe the server you want first.');
    if (!process.env.OPENROUTER_API_KEY)
        throw new MissingKeyError();
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    messages.push({
        role: 'user',
        content: refineFrom
            ? `Here is the current template:\n${JSON.stringify(refineFrom)}\n\nApply this change and return the COMPLETE updated template as JSON:\n${userPrompt}`
            : `Design this server:\n${userPrompt}`
    });
    let lastErrors = [];
    let usage = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        onStatus(attempt === 1 ? 'Designing your server…' : `Fixing issues the bot found (round ${attempt - 1} of ${MAX_ATTEMPTS - 1})…`);
        const { text, usage: u } = await callOpenRouter(messages, { signal });
        usage = u || usage;
        messages.push({ role: 'assistant', content: text });
        let parsed;
        try {
            parsed = extractJson(text);
            parsed = applyNamingStyle(parsed, userPrompt);
        }
        catch (e) {
            lastErrors = [{ path: '$', message: `reply was not valid JSON (${e.message})` }];
            messages.push({ role: 'user', content: `Your reply could not be parsed: ${e.message}. Reply again with ONE valid JSON object only.` });
            continue;
        }
        const local = validateSpec(parsed);
        if (!local.ok) {
            lastErrors = local.errors;
            messages.push({ role: 'user', content: `The template has errors. Fix them and return the COMPLETE corrected JSON:\n${formatErrors(local.errors)}` });
            continue;
        }
        onStatus('Asking the bot to build the template code…');
        try {
            const built = await buildTemplate(parsed, { requestedBy, signal });
            return { spec: parsed, ...built, attempts: attempt, usage, model: u?.model || null, latencyMs: u?.latencyMs || null, requestId: u?.requestId || null };
        }
        catch (e) {
            if (e instanceof BridgeError && e.code === 'invalid_spec') {
                lastErrors = e.errors;
                messages.push({ role: 'user', content: `The bot rejected the template. Fix these and return the COMPLETE corrected JSON:\n${formatErrors(e.errors)}` });
                continue;
            }
            throw e;
        }
    }
    throw new BridgeError('invalid_spec', `The AI could not produce a valid template after ${MAX_ATTEMPTS} attempts.`, lastErrors);
}
module.exports = { generateTemplate, MissingKeyError, SYSTEM_PROMPT, _extractJson: extractJson };

};
__modules["bridge/spec.js"] = function(module, exports, require, __filename, __dirname) {
'use strict';
const SPEC_VERSION = 1;
const LIMITS = {
    roles: 250,
    channels: 500,
    perCategory: 50,
    name: 100,
    topic: 1024,
    description: 500,
    overwritesPerChannel: 50,
    maxJsonBytes: 400 * 1024
};
const PERMISSION_NAMES = [
    'CreateInstantInvite', 'KickMembers', 'BanMembers', 'Administrator', 'ManageChannels', 'ManageGuild',
    'AddReactions', 'ViewAuditLog', 'PrioritySpeaker', 'Stream', 'ViewChannel', 'SendMessages',
    'SendTTSMessages', 'ManageMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'MentionEveryone',
    'UseExternalEmojis', 'ViewGuildInsights', 'Connect', 'Speak', 'MuteMembers', 'DeafenMembers', 'MoveMembers',
    'UseVAD', 'ChangeNickname', 'ManageNicknames', 'ManageRoles', 'ManageWebhooks', 'ManageGuildExpressions',
    'UseApplicationCommands', 'RequestToSpeak', 'ManageEvents', 'ManageThreads', 'CreatePublicThreads',
    'CreatePrivateThreads', 'UseExternalStickers', 'SendMessagesInThreads', 'UseEmbeddedActivities',
    'ModerateMembers', 'ViewCreatorMonetizationAnalytics', 'UseSoundboard', 'CreateGuildExpressions',
    'CreateEvents', 'UseExternalSounds', 'SendVoiceMessages', 'SendPolls', 'UseExternalApps'
];
const CHANNEL_TYPES = ['text', 'voice', 'announcement', 'stage', 'forum'];
const TEXTY = new Set(['text', 'announcement', 'forum']);
const VOICEY = new Set(['voice', 'stage']);
const DEFAULT_EVERYONE = [
    'CreateInstantInvite', 'ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads',
    'EmbedLinks', 'AttachFiles', 'AddReactions', 'UseExternalEmojis', 'ReadMessageHistory', 'Connect', 'Speak',
    'Stream', 'UseVAD', 'ChangeNickname', 'UseApplicationCommands'
];
class BridgeError extends Error {
    constructor(code, message, errors) {
        super(message);
        this.name = 'BridgeError';
        this.code = code;
        this.errors = errors || [];
    }
}
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v.trim() : '');
function validateSpec(input, opts = {}) {
    const errors = [];
    const warnings = [];
    const err = (path, message) => errors.push({ path, message });
    const warn = (path, message) => warnings.push(`${path}: ${message}`);
    const permSet = new Set(opts.permissionNames || PERMISSION_NAMES);
    if (!isObj(input)) {
        err('$', 'spec must be a JSON object');
        return { ok: false, errors, warnings };
    }
    if (input.specVersion !== undefined && input.specVersion !== SPEC_VERSION)
        err('specVersion', `must be ${SPEC_VERSION}`);
    const out = { specVersion: SPEC_VERSION, name: '', description: '', roles: [], channels: [], categories: [], settings: null };
    out.name = str(input.name);
    if (!out.name || out.name.length > LIMITS.name)
        err('name', `required, 1-${LIMITS.name} characters`);
    if (input.description !== undefined) {
        if (typeof input.description !== 'string' || input.description.length > LIMITS.description)
            err('description', `must be a string up to ${LIMITS.description} characters`);
        else
            out.description = input.description.trim();
    }
    const checkPerms = (path, list) => {
        if (list === undefined)
            return [];
        if (!Array.isArray(list)) {
            err(path, 'must be an array of permission names');
            return [];
        }
        const seen = new Set();
        list.forEach((p, i) => {
            if (typeof p !== 'string' || !permSet.has(p))
                err(`${path}[${i}]`, `unknown permission ${JSON.stringify(p)}`);
            else
                seen.add(p);
        });
        return [...seen];
    };
    const roleNames = new Map();
    if (input.roles !== undefined && !Array.isArray(input.roles))
        err('roles', 'must be an array');
    const rolesIn = Array.isArray(input.roles) ? input.roles : [];
    if (rolesIn.length > LIMITS.roles)
        err('roles', `at most ${LIMITS.roles} roles`);
    rolesIn.slice(0, LIMITS.roles).forEach((r, i) => {
        const p = `roles[${i}]`;
        if (!isObj(r))
            return err(p, 'must be an object');
        const name = str(r.name);
        if (!name || name.length > LIMITS.name)
            return err(`${p}.name`, `required, 1-${LIMITS.name} characters`);
        if (/^@?everyone$/i.test(name) || name === '@here')
            return err(`${p}.name`, 'reserved name');
        if (roleNames.has(name.toLowerCase()))
            return err(`${p}.name`, `duplicate role name ${JSON.stringify(name)}`);
        roleNames.set(name.toLowerCase(), name);
        let color = 0;
        if (r.color !== undefined && r.color !== null && r.color !== '') {
            if (typeof r.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(r.color))
                err(`${p}.color`, 'must be a hex color like "#5865f2"');
            else
                color = parseInt(r.color.slice(1), 16);
        }
        let emoji;
        if (r.emoji !== undefined && r.emoji !== null && r.emoji !== '') {
            if (typeof r.emoji !== 'string' || r.emoji.length > 16 || /[A-Za-z0-9]/.test(r.emoji))
                err(`${p}.emoji`, 'must be a single unicode emoji');
            else
                emoji = r.emoji;
        }
        out.roles.push({
            name, color, hoist: !!r.hoist, mentionable: !!r.mentionable,
            permissions: checkPerms(`${p}.permissions`, r.permissions), emoji
        });
    });
    const checkOverwrites = (path, list) => {
        if (list === undefined)
            return [];
        if (!Array.isArray(list)) {
            err(path, 'must be an array');
            return [];
        }
        if (list.length > LIMITS.overwritesPerChannel)
            err(path, `at most ${LIMITS.overwritesPerChannel} overwrites`);
        const res = [];
        const used = new Set();
        list.slice(0, LIMITS.overwritesPerChannel).forEach((o, i) => {
            const p = `${path}[${i}]`;
            if (!isObj(o))
                return err(p, 'must be an object');
            const rn = str(o.role);
            let role;
            if (/^@?everyone$/i.test(rn))
                role = '@everyone';
            else if (roleNames.has(rn.toLowerCase()))
                role = roleNames.get(rn.toLowerCase());
            else
                return err(`${p}.role`, `unknown role ${JSON.stringify(o.role)} (use "@everyone" or a name from roles)`);
            if (used.has(role))
                return err(`${p}.role`, `duplicate overwrite for ${JSON.stringify(role)}`);
            used.add(role);
            const allow = checkPerms(`${p}.allow`, o.allow);
            const deny = checkPerms(`${p}.deny`, o.deny);
            const both = allow.filter(x => deny.includes(x));
            if (both.length)
                err(p, `permission(s) in both allow and deny: ${both.join(', ')}`);
            if (!allow.length && !deny.length) {
                warn(p, 'empty overwrite ignored');
                return;
            }
            res.push({ role, allow, deny });
        });
        return res;
    };
    let channelTotal = 0;
    const parseChannel = (c, path) => {
        if (!isObj(c)) {
            err(path, 'must be an object');
            return null;
        }
        const type = c.type === undefined ? 'text' : c.type;
        if (!CHANNEL_TYPES.includes(type)) {
            err(`${path}.type`, `unknown type ${JSON.stringify(c.type)}; use ${CHANNEL_TYPES.join(', ')}`);
            return null;
        }
        let name = str(c.name);
        if (!name || name.length > LIMITS.name) {
            err(`${path}.name`, `required, 1-${LIMITS.name} characters`);
            return null;
        }
        if (TEXTY.has(type)) {
            const fixed = name.toLowerCase().replace(/\s+/g, '-');
            if (fixed !== name) {
                warn(`${path}.name`, `${JSON.stringify(name)} adjusted to ${JSON.stringify(fixed)} (text channel names are lowercase, no spaces)`);
                name = fixed;
            }
        }
        const ch = { name, type, overwrites: checkOverwrites(`${path}.overwrites`, c.overwrites) };
        const intIn = (key, min, max) => {
            if (c[key] === undefined || c[key] === null)
                return undefined;
            if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) {
                err(`${path}.${key}`, `must be an integer ${min}-${max}`);
                return undefined;
            }
            return c[key];
        };
        if (c.topic !== undefined && c.topic !== null && c.topic !== '') {
            if (typeof c.topic !== 'string' || c.topic.length > LIMITS.topic)
                err(`${path}.topic`, `must be a string up to ${LIMITS.topic} characters`);
            else if (TEXTY.has(type))
                ch.topic = c.topic.trim();
            else
                warn(`${path}.topic`, `ignored for ${type} channels`);
        }
        if (c.nsfw !== undefined && TEXTY.has(type))
            ch.nsfw = !!c.nsfw;
        if (TEXTY.has(type)) {
            const s = intIn('slowmode', 0, 21600);
            if (s)
                ch.slowmode = s;
        }
        if (VOICEY.has(type)) {
            const b = intIn('bitrate', 8000, 96000);
            if (b)
                ch.bitrate = b;
            const u = intIn('userLimit', 0, type === 'stage' ? 10000 : 99);
            if (u)
                ch.userLimit = u;
        }
        channelTotal++;
        return ch;
    };
    if (input.channels !== undefined && !Array.isArray(input.channels))
        err('channels', 'must be an array (channels without a category)');
    (Array.isArray(input.channels) ? input.channels : []).forEach((c, i) => {
        const ch = parseChannel(c, `channels[${i}]`);
        if (ch)
            out.channels.push(ch);
    });
    if (input.categories !== undefined && !Array.isArray(input.categories))
        err('categories', 'must be an array');
    (Array.isArray(input.categories) ? input.categories : []).forEach((cat, i) => {
        const p = `categories[${i}]`;
        if (!isObj(cat))
            return err(p, 'must be an object');
        const name = str(cat.name);
        if (!name || name.length > LIMITS.name)
            return err(`${p}.name`, `required, 1-${LIMITS.name} characters`);
        channelTotal++;
        const kids = [];
        if (cat.channels !== undefined && !Array.isArray(cat.channels))
            err(`${p}.channels`, 'must be an array');
        const list = Array.isArray(cat.channels) ? cat.channels : [];
        if (list.length > LIMITS.perCategory)
            err(`${p}.channels`, `a category holds at most ${LIMITS.perCategory} channels`);
        list.slice(0, LIMITS.perCategory).forEach((c, j) => {
            const ch = parseChannel(c, `${p}.channels[${j}]`);
            if (ch)
                kids.push(ch);
        });
        out.categories.push({ name, overwrites: checkOverwrites(`${p}.overwrites`, cat.overwrites), channels: kids });
    });
    if (channelTotal > LIMITS.channels)
        err('categories', `too many channels: ${channelTotal} (categories count too, max ${LIMITS.channels})`);
    if (!out.channels.length && !out.categories.length)
        err('categories', 'the template needs at least one channel');
    if (input.settings !== undefined && input.settings !== null) {
        const s = input.settings;
        if (!isObj(s))
            err('settings', 'must be an object');
        else {
            const set = {};
            if (s.verificationLevel !== undefined) {
                if (!Number.isInteger(s.verificationLevel) || s.verificationLevel < 0 || s.verificationLevel > 4)
                    err('settings.verificationLevel', 'must be an integer 0-4');
                else
                    set.verificationLevel = s.verificationLevel;
            }
            if (s.contentFilter !== undefined) {
                if (!Number.isInteger(s.contentFilter) || s.contentFilter < 0 || s.contentFilter > 2)
                    err('settings.contentFilter', 'must be an integer 0-2');
                else
                    set.contentFilter = s.contentFilter;
            }
            if (s.defaultNotifications !== undefined) {
                if (!['all', 'mentions'].includes(s.defaultNotifications))
                    err('settings.defaultNotifications', 'must be "all" or "mentions"');
                else
                    set.defaultNotifications = s.defaultNotifications;
            }
            if (s.afkTimeout !== undefined) {
                if (![60, 300, 900, 1800, 3600].includes(s.afkTimeout))
                    err('settings.afkTimeout', 'must be one of 60, 300, 900, 1800, 3600');
                else
                    set.afkTimeout = s.afkTimeout;
            }
            set.everyonePermissions = s.everyonePermissions === undefined ? DEFAULT_EVERYONE.filter(p => permSet.has(p)) : checkPerms('settings.everyonePermissions', s.everyonePermissions);
            out.settings = set;
        }
    }
    return { ok: errors.length === 0, errors, warnings, spec: errors.length ? undefined : out };
}
const formatErrors = errors => errors.map(e => `${e.path}: ${e.message}`).join('\n');
module.exports = {
    SPEC_VERSION, LIMITS, PERMISSION_NAMES, CHANNEL_TYPES, DEFAULT_EVERYONE, BridgeError, validateSpec, formatErrors
};

};
__modules["bridge/templateBridge.js"] = function(module, exports, require, __filename, __dirname) {
'use strict';
const { PermissionsBitField, PermissionFlagsBits, ChannelType } = require('discord.js');
const { LIMITS, BridgeError, validateSpec, formatErrors } = require('./spec');
let deps = null;
function getDeps() {
    if (!deps)
        deps = { template: require('../template'), db: require('../database') };
    return deps;
}
const TYPE_MAP = () => ({
    text: ChannelType.GuildText,
    voice: ChannelType.GuildVoice,
    announcement: ChannelType.GuildAnnouncement,
    stage: ChannelType.GuildStageVoice,
    forum: ChannelType.GuildForum
});
const bits = names => new PermissionsBitField(names).bitfield.toString();
function buildSnapshot(spec) {
    const types = TYPE_MAP();
    const roleIndex = new Map(spec.roles.map((r, i) => [r.name, i]));
    const keyOf = role => (role === '@everyone' ? 'e' : roleIndex.get(role));
    const roles = spec.roles.map(r => ({
        n: r.name, c: r.color, h: r.hoist ? 1 : 0, m: r.mentionable ? 1 : 0,
        p: bits(r.permissions), ue: r.emoji || undefined
    }));
    const toOverwrites = list => list.map(o => [keyOf(o.role), bits(o.allow), bits(o.deny)]);
    const merged = (catOw, ownOw) => {
        const own = new Set(ownOw.map(o => o.role));
        return [...catOw.filter(o => !own.has(o.role)), ...ownOw];
    };
    const channels = [];
    const pushChannel = (c, parent, inheritedOw) => {
        const row = { n: c.name, t: types[c.type], p: parent, o: toOverwrites(merged(inheritedOw, c.overwrites)) };
        if (c.topic)
            row.tp = c.topic;
        if (c.nsfw)
            row.nsfw = 1;
        if (c.slowmode)
            row.rl = c.slowmode;
        if (c.bitrate)
            row.b = c.bitrate;
        if (c.userLimit)
            row.ul = c.userLimit;
        channels.push(row);
    };
    for (const c of spec.channels)
        pushChannel(c, -1, []);
    for (const cat of spec.categories) {
        const catIndex = channels.length;
        channels.push({ n: cat.name, t: ChannelType.GuildCategory, p: -1, o: toOverwrites(cat.overwrites) });
        for (const c of cat.channels)
            pushChannel(c, catIndex, cat.overwrites);
    }
    const snapshot = {
        v: 2, id: 'web', name: spec.name, at: Date.now(),
        roles, channels,
        emojis: [], stickers: [], panels: [], sticky: [], embeds: [], wl: []
    };
    if (spec.settings) {
        const s = spec.settings;
        snapshot.g = {
            n: spec.name,
            ds: spec.description && spec.description.length <= 120 ? spec.description : undefined,
            vl: s.verificationLevel, cf: s.contentFilter,
            dn: s.defaultNotifications === undefined ? undefined : (s.defaultNotifications === 'all' ? 0 : 1),
            at: s.afkTimeout,
            afk: -1, sys: -1, sf: 0, rules: -1, upd: -1, com: 0,
            ev: bits(s.everyonePermissions)
        };
    }
    return snapshot;
}
function buildTemplateFromSpec(input, opts = {}) {
    const requestedBy = String(opts.requestedBy || 'web').slice(0, 64);
    let size = 0;
    try {
        size = Buffer.byteLength(JSON.stringify(input) || '');
    }
    catch {
        throw new BridgeError('invalid_spec', 'Spec is not valid JSON data.', [{ path: '$', message: 'not serializable' }]);
    }
    if (size > LIMITS.maxJsonBytes)
        throw new BridgeError('too_large', `Spec is too large (${size} bytes, max ${LIMITS.maxJsonBytes}).`);
    const checked = validateSpec(input, { permissionNames: Object.keys(PermissionFlagsBits) });
    if (!checked.ok)
        throw new BridgeError('invalid_spec', `Invalid template spec:\n${formatErrors(checked.errors)}`, checked.errors);
    const warnings = [...checked.warnings];
    const { template, db } = getDeps();
    const snapshot = buildSnapshot(checked.spec);
    const code = template.encodeSnapshot(snapshot);
    let back;
    try {
        back = template.decodeSnapshot(code);
    }
    catch (e) {
        throw new BridgeError('internal', `Generated code failed its own check: ${e.message}`);
    }
    if (back.roles.length !== snapshot.roles.length || back.channels.length !== snapshot.channels.length) {
        throw new BridgeError('internal', 'Generated code failed its own check: counts differ after decoding.');
    }
    const fitsInCommand = code.length <= template.MAX_CODE_LENGTH;
    if (!fitsInCommand)
        warnings.push(`The full code is ${code.length} characters, longer than Discord allows in the /template load code option (${template.MAX_CODE_LENGTH}). Use the short code or upload the code as a .txt file with the file option.`);
    let shortCode = null;
    if (opts.persist !== false) {
        try {
            shortCode = db.saveTemplate(`web:${requestedBy}`, snapshot.name, code, requestedBy);
        }
        catch (e) {
            warnings.push(`Could not save a short code in the database: ${String(e.message).slice(0, 120)}`);
        }
    }
    const categories = snapshot.channels.filter(c => c.t === ChannelType.GuildCategory).length;
    return {
        code, shortCode, fitsInCommand,
        stats: { roles: snapshot.roles.length, categories, channels: snapshot.channels.length - categories, bytes: code.length },
        warnings, snapshot
    };
}
module.exports = {
    buildTemplateFromSpec,
    _buildSnapshot: buildSnapshot,
    _setDeps: d => { deps = d; }
};

};
__modules["bridge/wizard.js"] = function(module, exports, require, __filename, __dirname) {
'use strict';
const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } = require('discord.js');
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
        if (!interaction.guild)
            return interaction.reply({ embeds: [ui.errorEmbed('Server Only', 'Run /templategen inside a server.')], ephemeral: true });
        const id = key(interaction);
        sessions.set(id, { userId: interaction.user.id, guildId: interaction.guildId, step: 'theme', createdAt: Date.now(), theme: null, emojiMode: null, naming: null, prompt: '', result: null });
        return interaction.reply({ embeds: [ui.base('✨ AunXz Template Studio').setDescription('**Step 1 of 3 — Choose a server theme.**\nI will generate a preview first. Nothing in your server changes until you confirm the final apply step.')], components: [themeRow(id)], ephemeral: true });
    }
};
function key(i) { return `${i.guildId || 'dm'}:${i.user.id}`; }
function cid(i) { return String(i.customId || '').split(':'); }
function getSession(i, parts) {
    const s = sessions.get(`${parts[2]}:${parts[3]}`);
    if (!s || s.userId !== i.user.id || s.guildId !== i.guildId || Date.now() - s.createdAt > TTL)
        return null;
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
        row.addComponents(new ButtonBuilder().setCustomId(`tg:apply:${id}`).setLabel('Confirm & Apply').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`tg:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
    }
    else {
        row.addComponents(new ButtonBuilder().setCustomId(`tg:edit:${id}`).setLabel('Edit prompt').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`tg:regen:${id}`).setLabel('Regenerate').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`tg:applyask:${id}`).setLabel('Apply template…').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`tg:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
    }
    return row;
}
function promptModal(id, initial = '') {
    const modal = new ModalBuilder().setCustomId(`tg:prompt:${id}`).setTitle('Describe your server');
    const input = new TextInputBuilder().setCustomId('description').setLabel('Describe your server').setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Channels, roles, vibe, features and any naming preferences…').setMinLength(3).setMaxLength(1500).setRequired(true);
    if (initial)
        input.setValue(initial.slice(0, 1500));
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
        if (c.t === 4) {
            current = { name: c.n, channels: [] };
            groups.push(current);
        }
        else if (current && c.p >= 0)
            current.channels.push(c.n);
        else
            groups.push({ name: c.n, channels: [] });
    }
    const layout = groups.slice(0, 12).map(g => `**${g.name}**${g.channels.length ? '\n' + g.channels.slice(0, 7).map(n => `┊ #${n}`).join('\n') : ''}`).join('\n');
    return ui.base('✨ Template Preview').setDescription(`**${snap.name}**\n${s.prompt.slice(0, 350)}\n\n` +
        `**Layout**\n${layout.slice(0, 1800) || 'No channels'}\n\n` +
        `**Roles**\n${roles}\n\n` +
        `**Summary:** ${rolesCount(snap)} roles · ${cats.length} categories · ${channels} channels\n` +
        `**Short code:** ${s.result.shortCode ? `\`${s.result.shortCode}\`` : 'not saved'}\n` +
        `**Style:** ${s.naming} · **Emoji assignment:** ${s.emojiMode}`).setFooter({ text: 'Preview only — no server changes have been made.' });
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
    }
    catch (e) {
        const detail = e.code === 'missing_key' ? `${e.message}\n${e.howTo || ''}` : String(e.message || e);
        await i.editReply({ embeds: [ui.errorEmbed('Template Generation Failed', detail.slice(0, 3500))], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tg:edit:${s.guildId}:${s.userId}`).setLabel('Edit prompt').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`tg:cancel:${s.guildId}:${s.userId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))] });
    }
}
async function handleInteraction(i) {
    if (!i.customId?.startsWith('tg:'))
        return false;
    const p = cid(i);
    const action = p[1];
    const s = getSession(i, p);
    if (!s) {
        const payload = { embeds: [ui.errorEmbed('Session Expired', 'Run /templategen again. This wizard is private to its creator.')], components: [], ephemeral: true };
        if (i.isModalSubmit())
            await i.reply(payload).catch(() => { });
        else
            await i.reply(payload).catch(() => { });
        return true;
    }
    if (action === 'cancel') {
        sessions.delete(`${s.guildId}:${s.userId}`);
        if (i.isModalSubmit())
            await i.reply({ embeds: [ui.infoEmbed('Cancelled', 'No server changes were made.')], ephemeral: true });
        else
            await i.update({ embeds: [ui.infoEmbed('Cancelled', 'No server changes were made.')], components: [] });
        return true;
    }
    if (action === 'theme' && i.isStringSelectMenu()) {
        s.theme = i.values[0];
        if (s.theme === 'Other') {
            s.emojiMode = 'channel';
            s.naming = 'auto';
            return i.showModal(promptModal(`${s.guildId}:${s.userId}`));
        }
        s.step = 'emoji';
        return i.update({ embeds: [ui.base('✨ AunXz Template Studio').setDescription('**Step 2 of 3 — Emoji assignment.**')], components: [emojiRow(`${s.guildId}:${s.userId}`)] });
    }
    if (action === 'emoji' && i.isStringSelectMenu()) {
        s.emojiMode = i.values[0];
        s.step = 'naming';
        return i.update({ embeds: [ui.base('✨ AunXz Template Studio').setDescription('**Step 3 of 3 — Channel naming style.**')], components: [namingRow(`${s.guildId}:${s.userId}`)] });
    }
    if (action === 'naming' && i.isStringSelectMenu()) {
        s.naming = i.values[0];
        return i.showModal(promptModal(`${s.guildId}:${s.userId}`));
    }
    if (action === 'prompt' && i.isModalSubmit()) {
        const description = i.fields.getTextInputValue('description').trim();
        if (description.length < 3)
            return i.reply({ embeds: [ui.errorEmbed('Description Too Short', 'Please describe your server in at least 3 characters.')], ephemeral: true });
        s.prompt = themePrompt(s, description);
        await i.deferReply({ ephemeral: true });
        try {
            s.result = await generateTemplate({ prompt: s.prompt, requestedBy: i.user.id, onStatus: status => console.log(`[templategen] ${status}`) });
            s.step = 'preview';
            return i.editReply({ embeds: [previewEmbed(s)], components: [buttons(`${s.guildId}:${s.userId}`)] });
        }
        catch (e) {
            const detail = e.code === 'missing_key' ? `${e.message}\n${e.howTo || ''}` : String(e.message || e);
            return i.editReply({ embeds: [ui.errorEmbed('Template Generation Failed', detail.slice(0, 3500))], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tg:edit:${s.guildId}:${s.userId}`).setLabel('Edit prompt').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`tg:cancel:${s.guildId}:${s.userId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))] });
        }
    }
    if (action === 'edit')
        return i.showModal(promptModal(`${s.guildId}:${s.userId}`, s.prompt.replace(/^Create a Discord server template[\s\S]*?User requirements: /, '').slice(0, 1500)));
    if (action === 'regen') {
        await i.deferUpdate();
        try {
            s.result = await generateTemplate({ prompt: s.prompt, requestedBy: i.user.id, onStatus: status => console.log(`[templategen] ${status}`) });
            return i.editReply({ embeds: [previewEmbed(s)], components: [buttons(`${s.guildId}:${s.userId}`)] });
        }
        catch (e) {
            return i.editReply({ embeds: [ui.errorEmbed('Regeneration Failed', String(e.message || e).slice(0, 3000))], components: [buttons(`${s.guildId}:${s.userId}`)] });
        }
    }
    if (action === 'applyask') {
        if (!i.memberPermissions?.has(PermissionFlagsBits.Administrator))
            return i.reply({ embeds: [ui.errorEmbed('Administrator Required', 'Only a server Administrator can apply a generated template.')], ephemeral: true });
        s.step = 'confirm';
        return i.update({ embeds: [ui.warnEmbed('⚠️ Confirm Server Rebuild', 'Applying this template will rebuild the server using AunXz’s existing template loader. Existing channels, roles and configured template data may be changed or removed.\n\n**No changes have been made yet.** Press **Confirm & Apply** only if you want to proceed.')], components: [buttons(`${s.guildId}:${s.userId}`, true)] });
    }
    if (action === 'apply') {
        if (s.step !== 'confirm')
            return i.reply({ embeds: [ui.errorEmbed('Confirmation Required', 'Review the preview and use Apply template first.')], ephemeral: true });
        if (!i.memberPermissions?.has(PermissionFlagsBits.Administrator))
            return i.reply({ embeds: [ui.errorEmbed('Administrator Required', 'Only a server Administrator can apply a generated template.')], ephemeral: true });
        await i.deferUpdate();
        try {
            await i.editReply({ embeds: [ui.base('⏳ Applying Template').setDescription('Preflight passed. Starting the existing AunXz template loader…')], components: [] });
            const result = await templateLoader.runLoad(i.guild, s.result.snapshot, i.user);
            sessions.delete(`${s.guildId}:${s.userId}`);
            const summary = typeof result === 'string' ? result : 'The template loader finished. Check its progress/completion message for the detailed result.';
            return i.editReply({ embeds: [ui.okEmbed('Template Applied', summary.slice(0, 3000))], components: [] });
        }
        catch (e) {
            return i.editReply({ embeds: [ui.errorEmbed('Apply Failed', String(e.message || e).slice(0, 3000))], components: [] });
        }
    }
    return false;
}
module.exports = { command, handleInteraction };

};
__modules["commands.js"] = function(module, exports, require, __filename, __dirname) {
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('./database');
const ui = require('./ui');
const sys = require('./systems');
const templates = require('./template');
const { randomBytes, createHash } = require('crypto');
const { execFileSync } = require('child_process');
const OWNER_IDS = (process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isOwner = (id) => OWNER_IDS.includes(String(id || '')) || require('./ownertools').isOwner(id);
const pendingDangerousActions = new Map();
function askForConfirmation(interaction, { title, description, actionLabel, run }) {
    const token = randomBytes(8).toString('hex');
    const record = { userId: interaction.user.id, guildId: interaction.guildId, actionLabel, run, expiresAt: Date.now() + 90000 };
    pendingDangerousActions.set(token, record);
    setTimeout(() => pendingDangerousActions.delete(token), 90000).unref?.();
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`danger-confirm:${token}:yes`).setLabel('Confirm').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`danger-confirm:${token}:no`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
    return interaction.reply({ embeds: [ui.warnEmbed(`⚠️ ${title}`, `${description}\n\nThis confirmation expires in 90 seconds.`)], components: [row], ephemeral: true });
}
async function handleDangerousConfirmation(interaction) {
    const parts = String(interaction.customId || '').split(':');
    const token = parts[1];
    const choice = parts[2];
    const pending = pendingDangerousActions.get(token);
    if (pending && (interaction.user.id !== pending.userId || interaction.guildId !== pending.guildId)) {
        return interaction.reply({ embeds: [ui.errorEmbed('Not Your Confirmation', 'Only the person who started this action can confirm or cancel it.')], ephemeral: true });
    }
    try {
        await interaction.deferUpdate();
    }
    catch (e) {
        console.warn('[confirm] deferUpdate failed:', e?.message || e);
    }
    const show = payload => interaction.editReply(payload).catch(e => console.warn('[confirm] could not show result:', e?.message || e));
    if (!pending || Date.now() > pending.expiresAt) {
        pendingDangerousActions.delete(token);
        return show({ embeds: [ui.errorEmbed('Confirmation Expired', 'Run the command again to start a new confirmation.')], components: [] });
    }
    pendingDangerousActions.delete(token);
    if (choice !== 'yes')
        return show({ embeds: [ui.infoEmbed('Action Cancelled', `Cancelled: **${pending.actionLabel}**. Nothing was changed.`)], components: [] });
    await show({ embeds: [ui.infoEmbed('⏳ Working…', `Running **${pending.actionLabel}**…`)], components: [] });
    try {
        const result = await pending.run(interaction);
        const embed = result && typeof result.toJSON === 'function' ? result : ui.okEmbed('Action Complete', `**${pending.actionLabel}** completed.`);
        return show({ embeds: [embed], components: [] });
    }
    catch (error) {
        console.error(`Confirmed action failed (${pending.actionLabel}):`, error);
        return show({ embeds: [ui.errorEmbed('Action Failed', String(error?.message || error).slice(0, 1500))], components: [] });
    }
}
function requireAdmin(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to use this.')], ephemeral: true });
        return false;
    }
    return true;
}
function getImageAttachment(interaction, optionName) {
    const attachment = interaction.options.getAttachment(optionName);
    if (!attachment)
        return null;
    if (attachment.contentType && !attachment.contentType.startsWith('image/'))
        return null;
    return attachment;
}
function botMember(interaction) {
    return interaction.guild?.members?.me || interaction.guild?.members?.cache?.get(interaction.client.user.id) || null;
}
function actionPermissionError(interaction, permission, label) {
    const member = interaction.member;
    if (!member?.permissions?.has(permission) && !member?.permissions?.has(PermissionFlagsBits.Administrator)) {
        return ui.errorEmbed('Missing Permissions', `You need **${label}** to use this action.`);
    }
    const bot = botMember(interaction);
    if (!bot?.permissions?.has(permission) && !bot?.permissions?.has(PermissionFlagsBits.Administrator)) {
        return ui.errorEmbed('Bot Missing Permissions', `I need **${label}** before I can perform this action.`);
    }
    return null;
}
function hierarchyError(interaction, target, actionLabel) {
    const bot = botMember(interaction);
    if (!bot || !target)
        return null;
    if (target.id === interaction.guild.ownerId)
        return ui.errorEmbed('Action Blocked', `I cannot ${actionLabel} the server owner.`);
    if (target.id === interaction.client.user.id)
        return ui.errorEmbed('Action Blocked', `I cannot ${actionLabel} myself.`);
    if (target.roles?.highest?.position >= bot.roles.highest.position)
        return ui.errorEmbed('Role Hierarchy', `I cannot ${actionLabel} **${target.user.tag}** because their highest role is equal to or higher than my highest role.`);
    if (interaction.member.id !== interaction.guild.ownerId && target.roles?.highest?.position >= interaction.member.roles.highest.position) {
        return ui.errorEmbed('Role Hierarchy', `You cannot ${actionLabel} **${target.user.tag}** because their highest role is equal to or higher than your highest role.`);
    }
    return null;
}
function actionPreflight(interaction, target, permission, permissionLabel, actionLabel) {
    return actionPermissionError(interaction, permission, permissionLabel) || hierarchyError(interaction, target, actionLabel);
}
const commands = [];
commands.push(require('./bridge/wizard').command);
{
    const { AttachmentBuilder } = require('discord.js');
    const builder = new SlashCommandBuilder()
        .setName('template')
        .setDescription('Save, load, list or delete full AunXz server templates.')
        .addSubcommand(s => s
        .setName('save')
        .setDescription('Save this whole server (settings, roles, channels, emojis, bot settings, panels).'))
        .addSubcommand(s => s
        .setName('load')
        .setDescription('Rebuild this server from a saved template.')
        .addBooleanOption(o => o
        .setName('confirm')
        .setDescription('Confirm that the current channels, roles and emojis may be replaced.')
        .setRequired(true))
        .addStringOption(o => o
        .setName('code')
        .setDescription('Template code (AX-XXXXXXXX) or an old VX-TPL code.')
        .setMaxLength(templates.MAX_CODE_LENGTH))
        .addAttachmentOption(o => o
        .setName('file')
        .setDescription('Template file that was sent to your DMs when you saved it.')))
        .addSubcommand(s => s
        .setName('list')
        .setDescription('List the templates saved from this server.'))
        .addSubcommand(s => s
        .setName('delete')
        .setDescription('Delete a template saved from this server.')
        .addStringOption(o => o.setName('code').setDescription('Template code (AX-XXXXXXXX).').setRequired(true)));
    if (typeof builder.setIntegrationTypes === 'function') {
        builder.setIntegrationTypes(0, 1);
    }
    if (typeof builder.setContexts === 'function') {
        builder.setContexts(0);
    }
    const isAdmin = i => !!(i.memberPermissions?.has(PermissionFlagsBits.Administrator) || i.member?.permissions?.has?.(PermissionFlagsBits.Administrator));
    const throttle = (fn, ms = 2500) => { let last = 0; return async (...a) => { if (Date.now() - last < ms)
        return; last = Date.now(); try {
        await fn(...a);
    }
    catch { } }; };
    commands.push({
        data: builder,
        async execute(interaction) {
            const sub = interaction.options.getSubcommand();
            if (sub === 'save') {
                const guild = interaction.guild || (interaction.guildId ? interaction.client.guilds.cache.get(interaction.guildId) : null);
                if (!guild) {
                    return interaction.reply({
                        embeds: [ui.errorEmbed('AunXz Bot Required', 'Discord only gives a user-installed app the channel for this command, not the server structure. Add AunXz to this server as a bot, then run **/template save** again.')],
                        ephemeral: true
                    });
                }
                if (!isAdmin(interaction)) {
                    return interaction.reply({ embeds: [ui.errorEmbed('Administrator Required', 'Only an Administrator can save a server template.')], ephemeral: true });
                }
                await interaction.deferReply({ ephemeral: true });
                try {
                    const stage = throttle(text => interaction.editReply({ embeds: [ui.base('📦 Saving Server Template').setDescription('**' + text + '**')] }), 2000);
                    const snapshot = await templates.createSnapshot(guild, stage);
                    const encoded = templates.encodeSnapshot(snapshot);
                    const code = db.saveTemplate(guild.id, guild.name, encoded, interaction.user.id);
                    const stats = [
                        `🏷️ **${snapshot.roles.length}** roles`, `📁 **${snapshot.channels.length}** channels`,
                        `😀 **${snapshot.emojis.length}** emojis`, `🏷️ **${snapshot.stickers.length}** stickers`,
                        `🤖 **${Object.keys(snapshot.config).length}** bot settings`, `🎟️ **${snapshot.panels.length}** panels found`
                    ].join(' • ');
                    let dmNote = '';
                    if (Buffer.byteLength(encoded) < 24 * 1024 * 1024) {
                        try {
                            const file = new AttachmentBuilder(Buffer.from(encoded, 'utf8'), { name: `template-${guild.id}.txt` });
                            await interaction.user.send({ content: `📦 Template **${guild.name}** — code \`${code}\`. Backup file: run **/template load** and attach this file in the \`file\` option.`, files: [file] });
                            dmNote = '\nA backup file was also sent to your DMs.';
                        }
                        catch (e) {
                            dmNote = '\n-# I could not DM you the backup file (DMs closed) — keep the code safe.';
                        }
                    }
                    return interaction.editReply({
                        embeds: [ui.okEmbed('📦 Template Saved', `Code: \`${code}\`\n${stats}\n\nLoad it in any server where AunXz is installed:\n\`/template load code:${code} confirm:True\`${dmNote}`)]
                    });
                }
                catch (e) {
                    console.error('[Template] save failed:', e);
                    return interaction.editReply({ embeds: [ui.errorEmbed('Template Save Failed', String(e.message || e))] });
                }
            }
            if (!interaction.guild) {
                return interaction.reply({
                    embeds: [ui.errorEmbed('Server Only', 'Use **/template** inside a server where AunXz is installed as a bot.')],
                    ephemeral: true
                });
            }
            if (!isAdmin(interaction)) {
                return interaction.reply({
                    embeds: [ui.errorEmbed('Administrator Required', 'Only an Administrator can use templates.')],
                    ephemeral: true
                });
            }
            if (sub === 'list') {
                const rows = db.listTemplates(interaction.guildId);
                const body = rows.length
                    ? rows.slice(0, 20).map(r => `\`${r.code}\` • <t:${Math.floor(r.createdAt / 1000)}:R> • ${(r.size / 1024).toFixed(0)} KB`).join('\n')
                    : 'No templates saved from this server yet. Use **/template save**.';
                return interaction.reply({ embeds: [ui.base('📦 Saved Templates').setDescription(body)], ephemeral: true });
            }
            if (sub === 'delete') {
                const code = interaction.options.getString('code', true);
                const ok = db.deleteTemplate(code, interaction.guildId);
                return interaction.reply({
                    embeds: [ok ? ui.okEmbed('Template Deleted', `\`${code.toUpperCase()}\` was removed.`) : ui.errorEmbed('Not Found', 'No template with that code was saved from this server.')],
                    ephemeral: true
                });
            }
            const bot = interaction.guild.members?.me || await interaction.guild.members.fetchMe().catch(() => null);
            if (!bot) {
                return interaction.reply({
                    embeds: [ui.errorEmbed('AunXz Is Not Installed', 'Install AunXz in this server as a bot before using **/template load**.')],
                    ephemeral: true
                });
            }
            if (!interaction.options.getBoolean('confirm', true)) {
                return interaction.reply({
                    embeds: [ui.errorEmbed('Confirmation Required', 'Loading a template replaces ALL current channels, roles, emojis and bot settings. Re-run **/template load** with **confirm: True** when ready.')],
                    ephemeral: true
                });
            }
            const codeOpt = interaction.options.getString('code');
            const fileOpt = interaction.options.getAttachment('file');
            if (!codeOpt && !fileOpt) {
                return interaction.reply({ embeds: [ui.errorEmbed('Template Missing', 'Give a template **code** or attach the template **file**.')], ephemeral: true });
            }
            await interaction.deferReply({ ephemeral: true });
            let snapshot;
            try {
                if (fileOpt) {
                    if (fileOpt.size > 25 * 1024 * 1024)
                        throw new Error('That file is too large.');
                    const res = await fetch(fileOpt.url);
                    if (!res.ok)
                        throw new Error('Could not download the attached file.');
                    snapshot = templates.decodeSnapshot(await res.text());
                }
                else {
                    snapshot = templates.resolveSnapshot(codeOpt);
                }
            }
            catch (e) {
                return interaction.editReply({ embeds: [ui.errorEmbed('Invalid Template', String(e.message || e))] });
            }
            try {
                const result = await templates.runLoad(interaction.guild, snapshot, interaction.user, {
                    onReady: ch => interaction.editReply({
                        embeds: [ui.base('🔄 Template Load Started').setDescription(`Live progress is in ${ch}.\nThis channel will be replaced while the server is rebuilt.`)]
                    })
                });
                if (!result.progressChannel) {
                    const msg = `Created **${result.channelsCreated}** channels and **${result.rolesCreated}** roles.` +
                        (result.failed.length ? `\n\n**${result.failed.length} item(s) failed:**\n${result.failed.slice(0, 8).map(x => '• ' + x).join('\n')}` : '');
                    await interaction.user.send({ embeds: [ui.okEmbed('✅ Template Loaded', msg)] }).catch(() => { });
                }
            }
            catch (e) {
                console.error('[Template] load failed:', e);
                await interaction.editReply({ embeds: [ui.errorEmbed('Template Load Failed', String(e.message || e))] }).catch(() => { });
            }
        }
    });
}
async function fetchAllMembers(guild) {
    try {
        const all = await guild.members.fetch({ time: 60000 });
        return { members: all, complete: true };
    }
    catch (e) {
        console.warn('[members] full fetch failed, using cache:', e?.message || e);
        return { members: guild.members.cache, complete: false };
    }
}
commands.push({
    data: new SlashCommandBuilder().setName('serverinfo').setDescription('Show advanced information and statistics about this server.'),
    async execute(interaction) {
        if (interaction.deferReply && !interaction.deferred && !interaction.replied)
            await interaction.deferReply();
        const g = interaction.guild;
        const owner = await g.fetchOwner().catch(() => null);
        const { members, complete } = await fetchAllMembers(g);
        const channels = g.channels.cache;
        const roles = g.roles.cache.filter(r => r.id !== g.id);
        const bots = members.filter(m => m.user.bot).size;
        const humans = members.filter(m => !m.user.bot).size;
        const total = complete ? members.size : g.memberCount;
        const text = channels.filter(c => c.type === ChannelType.GuildText).size;
        const voice = channels.filter(c => c.type === ChannelType.GuildVoice).size;
        const cats = channels.filter(c => c.type === ChannelType.GuildCategory).size;
        const boosts = g.premiumSubscriptionCount || 0;
        const e = ui.base(`🏠 ${g.name}`)
            .setThumbnail(g.iconURL({ dynamic: true }))
            .addFields({ name: '📊 Members', value: `**${total.toLocaleString()}** total\n👤 ${humans.toLocaleString()} humans • 🤖 ${bots.toLocaleString()} bots${complete ? '' : '\n-# counts from cache (full fetch failed)'}`, inline: true }, { name: '💬 Channels', value: `**${channels.size}** total\n${text} text • ${voice} voice • ${cats} categories`, inline: true }, { name: '🎭 Roles', value: `**${roles.size}** custom roles`, inline: true }, { name: '🚀 Boosts', value: `**${boosts}** boosts\nLevel ${g.premiumTier}`, inline: true }, { name: '👑 Owner', value: owner ? `${owner.user.tag}\n\`${owner.id}\`` : 'Unknown', inline: true }, { name: '🆔 Server ID', value: `\`${g.id}\``, inline: true }, { name: '📅 Created', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:F>`, inline: false });
        await (interaction.deferred ? interaction.editReply({ embeds: [e] }) : interaction.reply({ embeds: [e] }));
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('invites').setDescription('Show server invite statistics.')
        .addUserOption(o => o.setName('user').setDescription('Show stats for one member')),
    async execute(interaction) {
        const target = interaction.options.getUser('user');
        if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permission', 'I need **Manage Server** to read invite usage.')], ephemeral: true });
        }
        const invites = await interaction.guild.invites.fetch().catch(() => null);
        if (!invites)
            return interaction.reply({ embeds: [ui.errorEmbed('Invite Stats Unavailable', 'I could not read this server’s invites.')], ephemeral: true });
        const h = require('./helpers');
        const rows = [...invites.filter(i => !target || i.inviter?.id === target.id).values()].sort((x, y) => (y.uses || 0) - (x.uses || 0));
        const total = rows.reduce((n, i) => n + (i.uses || 0), 0);
        const lines = rows.map((i, n) => `${n + 1}. ${i.inviter || 'Unknown'} — **${i.uses || 0}** uses — \`${i.code}\``);
        const pages = h.listPages({ title: `📨 ${target ? `${target.username}'s` : 'Server'} Invites`, lines, emptyHint: 'No invite data found.' });
        if (lines.length)
            pages.forEach(p => p.addFields({ name: 'Tracked uses', value: String(total), inline: true }));
        await h.paginate(interaction, pages);
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('avatar').setDescription('Show a member avatar in high resolution.')
        .addUserOption(o => o.setName('user').setDescription('Member')),
    async execute(interaction) {
        const user = interaction.options.getUser('user') || interaction.user;
        const url = user.displayAvatarURL({ size: 4096, extension: 'png', forceStatic: false });
        await interaction.reply({ embeds: [ui.base(`🖼️ ${user.username}'s Avatar`).setImage(url).setDescription(`[Open full resolution](${url})`)] });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('userinfo').setDescription('Show detailed information about a member.')
        .addUserOption(o => o.setName('user').setDescription('Member')),
    async execute(interaction) {
        const user = interaction.options.getUser('user') || interaction.user;
        const m = await interaction.guild.members.fetch(user.id).catch(() => null);
        const roles = m ? m.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => r.toString()).slice(-20).join(', ') || 'None' : 'Not cached';
        await interaction.reply({ embeds: [ui.base(`👤 ${user.tag}`)
                    .setThumbnail(user.displayAvatarURL({ dynamic: true }))
                    .setDescription(`**ID:** \`${user.id}\`\n**Bot:** ${user.bot ? 'Yes' : 'No'}\n**Account:** <t:${Math.floor(user.createdTimestamp / 1000)}:F>\n**Joined:** ${m?.joinedTimestamp ? `<t:${Math.floor(m.joinedTimestamp / 1000)}:F>` : 'Unknown'}\n**Roles:** ${roles}`)] });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('serverstats').setDescription('Show advanced live server statistics.'),
    async execute(interaction) {
        const g = interaction.guild;
        await g.members.fetch().catch(() => { });
        const members = g.members.cache;
        const online = members.filter(m => m.presence?.status && m.presence.status !== 'offline').size;
        const bots = members.filter(m => m.user.bot).size;
        const humans = members.filter(m => !m.user.bot).size;
        const voice = members.filter(m => m.voice?.channelId).size;
        const roleCounts = new Map();
        for (const m of members.values())
            for (const r of m.roles.cache.values())
                if (r.id !== g.id)
                    roleCounts.set(r.id, (roleCounts.get(r.id) || 0) + 1);
        const topRoles = [...roleCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, n], i) => `${i + 1}. <@&${id}> — **${n}**`).join('\n') || 'No custom roles.';
        await interaction.reply({ embeds: [ui.base(`📊 ${g.name} — Advanced Stats`)
                    .addFields({ name: 'Members', value: `Total **${members.size}**\nHumans **${humans}**\nBots **${bots}**`, inline: true }, { name: 'Activity', value: `Online/active **${online}**\nIn voice **${voice}**`, inline: true }, { name: 'Server', value: `Channels **${g.channels.cache.size}**\nRoles **${g.roles.cache.size - 1}**\nBoosts **${g.premiumSubscriptionCount || 0}`, inline: true }, { name: 'Most-used roles', value: topRoles, inline: false })] });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('leaderboards').setDescription('Show advanced server leaderboards.')
        .addStringOption(o => o.setName('type').setDescription('Leaderboard type').setRequired(true)
        .addChoices({ name: 'XP', value: 'xp' }, { name: 'Messages/XP', value: 'messages' }, { name: 'Invites', value: 'invites' })),
    async execute(interaction) {
        const type = interaction.options.getString('type');
        if (type === 'xp' || type === 'messages') {
            const rows = db.topLevels(interaction.guildId, 100);
            const lines = rows.map((r, i) => `${i + 1}. <@${r.userId}> — **${r.xp.toLocaleString()} XP** • Level **${r.level}**`);
            {
                const h = require('./helpers');
                return h.paginate(interaction, h.listPages({ title: `🏆 ${interaction.guild.name} — ${type === 'xp' ? 'XP' : 'Activity'} Leaderboard`, lines, emptyHint: 'Chat to earn XP.' }));
            }
        }
        if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ManageGuild))
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permission', 'I need Manage Server to read invite usage.')], ephemeral: true });
        const invites = await interaction.guild.invites.fetch().catch(() => null);
        const byUser = new Map();
        for (const i of invites?.values() || [])
            if (i.inviter)
                byUser.set(i.inviter.id, (byUser.get(i.inviter.id) || 0) + (i.uses || 0));
        const lines = [...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100).map(([id, n], i) => `${i + 1}. <@${id}> — **${n} invites**`);
        {
            const h = require('./helpers');
            await h.paginate(interaction, h.listPages({ title: `🏆 ${interaction.guild.name} — Invite Leaderboard`, lines, emptyHint: 'No invite data yet.' }));
        }
    }
});
async function giveawayExtra(interaction, sub) {
    const h = require('./helpers');
    const gid = interaction.guildId;
    if (sub === 'list') {
        const lines = db.listGiveaways(gid, 100).map(g => { let n = 0; try {
            n = JSON.parse(g.participants || '[]').length;
        }
        catch { } return `**#${g.id}** ${g.status === 'active' ? '🟢' : g.status === 'ended' ? '🏁' : '⚪'} ${h.clip(g.prize, 60)} — ${g.status} • ${n} entries • ${g.status === 'active' ? `ends <t:${Math.floor(g.endsAt / 1000)}:R>` : `${g.winners} winner(s)`}`; });
        return h.paginate(interaction, h.listPages({ title: '🎉 Giveaways', lines, emptyHint: 'Start one with `/giveaway create`.' }), { ephemeral: true });
    }
    const idOpt = interaction.options.getInteger('id');
    const g = idOpt ? db.getGiveaway(gid, idOpt) : db.listGiveaways(gid, 100).find(x => x.status === 'ended');
    if (!g)
        return interaction.reply({ embeds: [h.errorEmbed('Giveaway not found', idOpt ? `No giveaway #${idOpt} in this server.` : 'There is no ended giveaway to reroll.')], ephemeral: true });
    if (g.hostId !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))
        return interaction.reply({ embeds: [h.errorEmbed('Denied', 'Only the host or a server manager can reroll.')], ephemeral: true });
    if (g.status !== 'ended')
        return interaction.reply({ embeds: [h.errorEmbed('Not ended yet', `Giveaway #${g.id} is **${g.status}**. Only ended giveaways can be rerolled.`)], ephemeral: true });
    let entries = [], prev = [];
    try {
        entries = JSON.parse(g.participants || '[]');
    }
    catch { }
    try {
        prev = JSON.parse(g.winnerIds || '[]');
    }
    catch { }
    await interaction.guild.members.fetch({ user: entries.slice(0, 100) }).catch(() => { });
    const valid = entries.filter(id => interaction.guild.members.cache.has(id));
    let pool = valid.filter(id => !prev.includes(id));
    if (!pool.length)
        pool = valid;
    if (!pool.length)
        return interaction.reply({ embeds: [h.errorEmbed('No valid entrants', 'Nobody who entered is still in the server.')], ephemeral: true });
    const count = Math.min(interaction.options.getInteger('winners') || g.winners, pool.length);
    const winners = [...pool].sort(() => Math.random() - 0.5).slice(0, count);
    db.updateGiveaway(gid, g.id, { winnerIds: JSON.stringify(winners) });
    const text = winners.map(id => `<@${id}>`).join(', ');
    const ch = g.channelId ? interaction.guild.channels.cache.get(g.channelId) : null;
    const embed = ui.base('🔁 Giveaway Rerolled').setDescription(`**Prize:** ${g.prize}\n**New winner(s):** ${text}`);
    if (ch?.isTextBased() && ch.id !== interaction.channelId) {
        await ch.send({ embeds: [embed] }).catch(() => { });
        return interaction.reply({ embeds: [h.successEmbed('Rerolled', `New winner(s) announced in ${ch}: ${text}`)], ephemeral: true });
    }
    return interaction.reply({ embeds: [embed] });
}
commands.push({
    data: new SlashCommandBuilder().setName('giveaway').setDescription('Create and configure a giveaway.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(s => s.setName('create').setDescription('Create a giveaway configuration panel.')
        .addStringOption(o => o.setName('prize').setDescription('Prize').setRequired(true))
        .addIntegerOption(o => o.setName('winners').setDescription('Number of winners').setMinValue(1).setMaxValue(20))
        .addIntegerOption(o => o.setName('duration_minutes').setDescription('Duration in minutes').setMinValue(1).setMaxValue(43200))
        .addChannelOption(o => o.setName('channel').setDescription('Giveaway channel').addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(s => s.setName('reroll').setDescription('Pick new winner(s) for an ended giveaway.')
        .addIntegerOption(o => o.setName('id').setDescription('Giveaway ID (default: latest ended)').setMinValue(1))
        .addIntegerOption(o => o.setName('winners').setDescription('How many new winners (default: original count)').setMinValue(1).setMaxValue(20)))
        .addSubcommand(s => s.setName('list').setDescription('List this server\'s giveaways.')),
    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Manage Server is required.')], ephemeral: true });
        const gsub = interaction.options.getSubcommand(false);
        if (gsub === 'reroll' || gsub === 'list')
            return giveawayExtra(interaction, gsub);
        const prize = interaction.options.getString('prize');
        const winners = interaction.options.getInteger('winners') || 1;
        const duration = (interaction.options.getInteger('duration_minutes') || 1440) * 60000;
        const channel = interaction.options.getChannel('channel') || interaction.channel;
        const g = db.createGiveaway(interaction.guildId, interaction.user.id, { prize, winners, durationMs: duration, endsAt: Date.now() + duration, channelId: channel.id });
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`giveaway_publish:${g.id}`).setLabel('Publish Giveaway').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`giveaway_cancel:${g.id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger));
        await interaction.reply({ embeds: [ui.base('🎉 Giveaway Configuration')
                    .setDescription(`Configure and publish this giveaway.\n\n**Prize:** ${prize}\n**Winners:** ${winners}\n**Duration:** <t:${Math.floor(g.endsAt / 1000)}:R>\n**Channel:** ${channel}`)
                    .setFooter({ text: `Giveaway #${g.id} • Hosted by ${interaction.user.tag}` })], components: [row], ephemeral: true });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('help').setDescription('Browse everything the bot can do.'),
    async execute(interaction) {
        await interaction.reply({ embeds: [ui.helpHomeEmbed(interaction.client)], components: [ui.helpSelectRow()] });
    }
});
const GENERIC_MODULES = [
    'welcome', 'leave', 'boost', 'starboard', 'inviteTracker',
    'suggestions', 'polls', 'snipeEnabled', 'nsfwFilter', 'birthdays'
];
const ALL_MODULE_NAMES = [
    'antinuke', 'antilink', 'antispam', 'antiraid', 'antiwebhook', 'antibot', 'antialt', 'voicemaster', 'greetvoice', 'greetmessage',
    'leveling', 'tickets', 'logs', ...GENERIC_MODULES
];
const GENERIC_COMMANDS = {
    welcome: 'welcome', leave: 'leave', boost: 'boost', starboard: 'starboard', invitetracker: 'inviteTracker', suggestions: 'suggestions', polls: 'polls',
    snipe: 'snipeEnabled', nswffilter: 'nsfwFilter', birthdays: 'birthdays'
};
const PANEL_MODULES = ['antinuke', 'antilink', 'antispam', 'antiraid', 'antiwebhook', 'antibot', 'antialt', 'voicemaster', 'greetmessage', 'leveling', 'tickets'];
function extractModuleOptions(sub, interaction) {
    const o = { state: interaction.options.getString('state') };
    if (sub === 'antinuke') {
        o.punishment = interaction.options.getString('punishment');
        o.threshold = interaction.options.getInteger('threshold');
        o.window_seconds = interaction.options.getInteger('window_seconds');
    }
    else if (sub === 'antilink') {
        o.mode = interaction.options.getString('mode');
        const r = interaction.options.getRole('bypass_role');
        o.bypass_role_id = r ? r.id : null;
    }
    else if (sub === 'antispam') {
        o.max_messages = interaction.options.getInteger('max_messages');
        o.window_seconds = interaction.options.getInteger('window_seconds');
        o.punishment = interaction.options.getString('punishment');
    }
    else if (sub === 'antiraid') {
        o.join_threshold = interaction.options.getInteger('join_threshold');
        o.window_seconds = interaction.options.getInteger('window_seconds');
        o.min_account_age_days = interaction.options.getInteger('min_account_age_days');
        o.action = interaction.options.getString('action');
    }
    else if (sub === 'antiwebhook') {
        o.action = interaction.options.getString('action');
        const r = interaction.options.getRole('bypass_role');
        o.bypass_role_id = r ? r.id : null;
        const c = interaction.options.getChannel('log_channel');
        o.log_channel_id = c ? c.id : null;
    }
    else if (sub === 'antibot') {
        o.action = interaction.options.getString('action');
        const r = interaction.options.getRole('bypass_role');
        o.bypass_role_id = r ? r.id : null;
        const c = interaction.options.getChannel('log_channel');
        o.log_channel_id = c ? c.id : null;
    }
    else if (sub === 'antialt') {
        o.action = interaction.options.getString('action');
        o.min_account_age_days = interaction.options.getInteger('min_account_age_days');
        const c = interaction.options.getChannel('log_channel');
        o.log_channel_id = c ? c.id : null;
    }
    else if (sub === 'voicemaster') {
        const h = interaction.options.getChannel('hub_channel');
        o.hub_channel_id = h ? h.id : null;
        const c = interaction.options.getChannel('category');
        o.category_id = c ? c.id : null;
        const ic = interaction.options.getChannel('interface_channel');
        o.interface_channel_id = ic ? ic.id : null;
    }
    else if (sub === 'greetmessage') {
        const c = interaction.options.getChannel('channel');
        o.channel_id = c ? c.id : null;
        o.message = interaction.options.getString('message');
        o.image = interaction.options.getString('image');
        const imageFile = getImageAttachment(interaction, 'image_file');
        o.image_file = imageFile ? imageFile.url : null;
    }
    else if (sub === 'leveling') {
        const c = interaction.options.getChannel('channel');
        o.channel_id = c ? c.id : null;
        o.xp_per_message = interaction.options.getInteger('xp_per_message');
        o.cooldown_seconds = interaction.options.getInteger('cooldown_seconds');
        o.reward_level = interaction.options.getInteger('reward_level');
        const r = interaction.options.getRole('reward_role');
        o.reward_role_id = r ? r.id : null;
    }
    else if (sub === 'tickets') {
        const c = interaction.options.getChannel('category');
        o.category_id = c ? c.id : null;
        const r = interaction.options.getRole('support_role');
        o.support_role_id = r ? r.id : null;
        const l = interaction.options.getChannel('log_channel');
        o.log_channel_id = l ? l.id : null;
        o.panel_title = interaction.options.getString('panel_title');
        o.panel_description = interaction.options.getString('panel_description');
        o.panel_thumbnail = interaction.options.getString('panel_thumbnail');
        o.panel_image = interaction.options.getString('panel_image');
        o.panel_thumbnail_file = (getImageAttachment(interaction, 'panel_thumbnail_file') || {}).url || null;
        o.panel_image_file = (getImageAttachment(interaction, 'panel_image_file') || {}).url || null;
        o.category_label = interaction.options.getString('category_label');
        o.welcome_message = interaction.options.getString('welcome_message');
        o.welcome_thumbnail = interaction.options.getString('welcome_thumbnail');
        o.welcome_image = interaction.options.getString('welcome_image');
        o.welcome_thumbnail_file = (getImageAttachment(interaction, 'welcome_thumbnail_file') || {}).url || null;
        o.welcome_image_file = (getImageAttachment(interaction, 'welcome_image_file') || {}).url || null;
    }
    return o;
}
function buildModulePatch(sub, guildId, o) {
    const patch = {};
    const state = o.state;
    if (sub === 'antinuke') {
        patch.antinuke = {};
        if (state)
            patch.antinuke.enabled = state === 'enable';
        if (o.punishment)
            patch.antinuke.punishment = o.punishment;
        if (o.threshold)
            Object.assign(patch.antinuke, {
                maxChannelDeletes: o.threshold, maxChannelCreates: o.threshold, maxRoleDeletes: o.threshold,
                maxRoleCreates: o.threshold, maxBans: o.threshold, maxKicks: o.threshold,
                maxWebhookCreates: o.threshold, maxRoleUpdates: o.threshold
            });
        if (o.window_seconds)
            patch.antinuke.windowSeconds = o.window_seconds;
    }
    else if (sub === 'antilink') {
        patch.antilink = {};
        if (state)
            patch.antilink.enabled = state === 'enable';
        if (o.mode)
            patch.antilink.mode = o.mode;
        if (o.bypass_role_id)
            patch.antilink.bypassRoleId = o.bypass_role_id;
    }
    else if (sub === 'antispam') {
        patch.antispam = {};
        if (state)
            patch.antispam.enabled = state === 'enable';
        if (o.max_messages)
            patch.antispam.maxMessages = o.max_messages;
        if (o.window_seconds)
            patch.antispam.windowSeconds = o.window_seconds;
        if (o.punishment)
            patch.antispam.punishment = o.punishment;
    }
    else if (sub === 'antiraid') {
        patch.antiraid = {};
        if (state)
            patch.antiraid.enabled = state === 'enable';
        if (o.join_threshold)
            patch.antiraid.joinThreshold = o.join_threshold;
        if (o.window_seconds)
            patch.antiraid.windowSeconds = o.window_seconds;
        if (o.min_account_age_days !== null && o.min_account_age_days !== undefined)
            patch.antiraid.minAccountAgeDays = o.min_account_age_days;
        if (o.action)
            patch.antiraid.action = o.action;
    }
    else if (sub === 'antiwebhook') {
        patch.antiwebhook = {};
        if (state)
            patch.antiwebhook.enabled = state === 'enable';
        if (o.action)
            patch.antiwebhook.action = o.action;
        if (o.bypass_role_id)
            patch.antiwebhook.bypassRoleId = o.bypass_role_id;
        if (o.log_channel_id)
            patch.antiwebhook.logChannelId = o.log_channel_id;
    }
    else if (sub === 'antibot') {
        patch.antibot = {};
        if (state)
            patch.antibot.enabled = state === 'enable';
        if (o.action)
            patch.antibot.action = o.action;
        if (o.bypass_role_id)
            patch.antibot.bypassRoleId = o.bypass_role_id;
        if (o.log_channel_id)
            patch.antibot.logChannelId = o.log_channel_id;
    }
    else if (sub === 'antialt') {
        patch.antialt = {};
        if (state)
            patch.antialt.enabled = state === 'enable';
        if (o.action)
            patch.antialt.action = o.action;
        if (o.min_account_age_days !== null && o.min_account_age_days !== undefined)
            patch.antialt.minAccountAgeDays = o.min_account_age_days;
        if (o.log_channel_id)
            patch.antialt.logChannelId = o.log_channel_id;
    }
    else if (sub === 'voicemaster') {
        patch.voicemaster = {};
        if (state)
            patch.voicemaster.enabled = state === 'enable';
        if (o.hub_channel_id)
            patch.voicemaster.hubChannelId = o.hub_channel_id;
        if (o.category_id)
            patch.voicemaster.categoryId = o.category_id;
        if (o.interface_channel_id)
            patch.voicemaster.interfaceChannelId = o.interface_channel_id;
    }
    else if (sub === 'greetmessage') {
        patch.greetmessage = {};
        if (state)
            patch.greetmessage.enabled = state === 'enable';
        if (o.channel_id)
            patch.greetmessage.channelId = o.channel_id;
        if (o.message)
            patch.greetmessage.message = o.message;
        if (o.image_file)
            patch.greetmessage.image = o.image_file;
        else if (o.image)
            patch.greetmessage.image = o.image;
    }
    else if (sub === 'leveling') {
        patch.leveling = {};
        if (state)
            patch.leveling.enabled = state === 'enable';
        if (o.channel_id)
            patch.leveling.channel = o.channel_id;
        if (o.xp_per_message)
            patch.leveling.xpPerMessage = o.xp_per_message;
        if (o.cooldown_seconds)
            patch.leveling.cooldownSeconds = o.cooldown_seconds;
        if (o.reward_level && o.reward_role_id) {
            const current = db.getConfig(guildId).leveling.roleRewards;
            patch.leveling.roleRewards = { ...current, [String(o.reward_level)]: o.reward_role_id };
        }
    }
    else if (sub === 'tickets') {
        patch.ticket = {};
        if (state)
            patch.ticket.enabled = state === 'enable';
        if (o.category_id)
            patch.ticket.categoryId = o.category_id;
        if (o.support_role_id)
            patch.ticket.supportRoleId = o.support_role_id;
        if (o.log_channel_id)
            patch.ticket.logChannelId = o.log_channel_id;
        if (o.panel_title)
            patch.ticket.panelTitle = o.panel_title;
        if (o.panel_description)
            patch.ticket.panelDescription = o.panel_description;
        if (o.panel_thumbnail_file)
            patch.ticket.panelThumbnail = o.panel_thumbnail_file;
        else if (o.panel_thumbnail)
            patch.ticket.panelThumbnail = o.panel_thumbnail;
        if (o.panel_image_file)
            patch.ticket.panelImage = o.panel_image_file;
        else if (o.panel_image)
            patch.ticket.panelImage = o.panel_image;
        if (o.category_label)
            patch.ticket.categoryLabel = o.category_label;
        if (o.welcome_message)
            patch.ticket.welcomeMessage = o.welcome_message;
        if (o.welcome_thumbnail_file)
            patch.ticket.welcomeThumbnail = o.welcome_thumbnail_file;
        else if (o.welcome_thumbnail)
            patch.ticket.welcomeThumbnail = o.welcome_thumbnail;
        if (o.welcome_image_file)
            patch.ticket.welcomeImage = o.welcome_image_file;
        else if (o.welcome_image)
            patch.ticket.welcomeImage = o.welcome_image;
    }
    return patch;
}
function addStateOption(subcommand) {
    return subcommand.addStringOption(o => o.setName('state').setDescription('enable or disable').setRequired(false)
        .addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }));
}
function panelSetupData(name, description, optionBuilder) {
    const command = new SlashCommandBuilder()
        .setName(name)
        .setDescription(description)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub => {
        sub.setName('setup').setDescription(`Open the ${name} configuration panel.`);
        addStateOption(sub);
        return optionBuilder ? optionBuilder(sub) : sub;
    });
    return command;
}
function panelSetupCommand(name, description, optionBuilder) {
    return {
        data: panelSetupData(name, description, optionBuilder),
        async execute(interaction) {
            if (!requireAdmin(interaction))
                return;
            const guildId = interaction.guildId;
            const sub = interaction.options.getSubcommand();
            if (sub !== 'setup')
                return;
            const o = extractModuleOptions(name, interaction);
            const patch = buildModulePatch(name, guildId, o);
            const before = name === 'voicemaster' ? db.getConfig(guildId).voicemaster : null;
            const cfg = db.saveConfig(guildId, patch);
            if (name === 'voicemaster') {
                await interaction.deferReply();
                let note = null;
                if (o.interface_channel_id) {
                    if (before.interfaceChannelId && before.interfaceChannelId !== o.interface_channel_id)
                        await sys.vmRemoveInterfaceMessage(interaction.guild, before);
                    if (before.interfaceChannelId !== o.interface_channel_id)
                        db.saveConfig(guildId, { voicemaster: { interfaceMessageId: null } });
                    const res = await sys.postVoiceInterface(interaction.guild);
                    note = res.ok ? ui.okEmbed('Interface Posted', `The control panel is now in ${res.channel}. New temp VCs will **not** get their own panel.`)
                        : ui.errorEmbed('Interface Saved, Panel Not Posted', res.error);
                }
                const fresh = db.getConfig(guildId);
                return interaction.editReply({ embeds: note ? [ui.vmSetupEmbed(fresh), note] : [ui.vmSetupEmbed(fresh)], components: ui.vmSetupRows(fresh) });
            }
            return interaction.reply({ embeds: [ui.setupPanelEmbed(name, cfg)], components: [ui.setupPanelRow(name, cfg)] });
        }
    };
}
commands.push({
    data: new SlashCommandBuilder().setName('setup').setDescription('List configurable bot modules.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(s => s.setName('list').setDescription('List every configurable module.')),
    async execute(interaction) {
        if (!requireAdmin(interaction))
            return;
        await interaction.reply({ embeds: [ui.moduleListEmbed(ALL_MODULE_NAMES)], ephemeral: true });
    }
});
commands.push(panelSetupCommand('antinuke', 'Configure antinuke protection.', sub => sub
    .addStringOption(o => o.setName('punishment').setDescription('ban/kick/strip_roles')
    .addChoices({ name: 'ban', value: 'ban' }, { name: 'kick', value: 'kick' }, { name: 'strip_roles', value: 'strip_roles' }))
    .addIntegerOption(o => o.setName('threshold').setDescription('actions allowed before punishment'))
    .addIntegerOption(o => o.setName('window_seconds').setDescription('time window in seconds'))));
commands.push(panelSetupCommand('antilink', 'Configure antilink.', sub => sub
    .addStringOption(o => o.setName('mode').setDescription('delete/warn/mute')
    .addChoices({ name: 'delete', value: 'delete' }, { name: 'warn', value: 'warn' }, { name: 'mute', value: 'mute' }))
    .addRoleOption(o => o.setName('bypass_role').setDescription('role exempt from antilink'))));
commands.push(panelSetupCommand('antispam', 'Configure antispam.', sub => sub
    .addIntegerOption(o => o.setName('max_messages').setDescription('messages allowed per window'))
    .addIntegerOption(o => o.setName('window_seconds').setDescription('window length in seconds'))
    .addStringOption(o => o.setName('punishment').setDescription('mute/kick/ban')
    .addChoices({ name: 'mute', value: 'mute' }, { name: 'kick', value: 'kick' }, { name: 'ban', value: 'ban' }))));
commands.push(panelSetupCommand('antiraid', 'Configure antiraid.', sub => sub
    .addIntegerOption(o => o.setName('join_threshold').setDescription('joins allowed per window'))
    .addIntegerOption(o => o.setName('window_seconds').setDescription('window length in seconds'))
    .addIntegerOption(o => o.setName('min_account_age_days').setDescription('min account age to allow join'))
    .addStringOption(o => o.setName('action').setDescription('lockdown/kick_new')
    .addChoices({ name: 'lockdown', value: 'lockdown' }, { name: 'kick_new', value: 'kick_new' }))));
commands.push(panelSetupCommand('antiwebhook', 'Protect the server from unauthorized webhook creation.', sub => sub
    .addStringOption(o => o.setName('action').setDescription('action for unauthorized webhook creators').addChoices({ name: 'delete webhook', value: 'delete' }, { name: 'kick creator', value: 'kick' }, { name: 'ban creator', value: 'ban' }, { name: 'strip roles', value: 'strip_roles' }))
    .addRoleOption(o => o.setName('bypass_role').setDescription('role exempt from anti-webhook'))
    .addChannelOption(o => o.setName('log_channel').setDescription('security log channel').addChannelTypes(ChannelType.GuildText))));
commands.push(panelSetupCommand('antibot', 'Control newly added bot accounts.', sub => sub
    .addStringOption(o => o.setName('action').setDescription('action for unapproved bots').addChoices({ name: 'kick', value: 'kick' }, { name: 'ban', value: 'ban' }, { name: 'strip roles', value: 'strip_roles' }))
    .addRoleOption(o => o.setName('bypass_role').setDescription('role exempt from antibot checks'))
    .addChannelOption(o => o.setName('log_channel').setDescription('security log channel').addChannelTypes(ChannelType.GuildText))));
commands.push(panelSetupCommand('antialt', 'Block accounts younger than your selected age.', sub => sub
    .addStringOption(o => o.setName('action').setDescription('action for accounts that are too new').addChoices({ name: 'kick', value: 'kick' }, { name: 'ban', value: 'ban' }))
    .addIntegerOption(o => o.setName('min_account_age_days').setDescription('minimum account age in days'))
    .addChannelOption(o => o.setName('log_channel').setDescription('security log channel').addChannelTypes(ChannelType.GuildText))));
commands.push(panelSetupCommand('voicemaster', 'Configure join-to-create voice.', sub => sub
    .addChannelOption(o => o.setName('hub_channel').setDescription('join-to-create voice channel').addChannelTypes(ChannelType.GuildVoice))
    .addChannelOption(o => o.setName('category').setDescription('category for new temporary channels').addChannelTypes(ChannelType.GuildCategory))
    .addChannelOption(o => o.setName('interface_channel').setDescription('text channel for the control panel (not posted in each temp VC)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))));
commands.push({
    data: (() => {
        const user = (o, d = 'member') => o.setName('user').setDescription(d).setRequired(true);
        const b = new SlashCommandBuilder().setName('voice').setDescription('Customize your temporary VoiceMaster channel.');
        b.addSubcommand(x => x.setName('lock').setDescription('Lock your channel so nobody new can join.'))
            .addSubcommand(x => x.setName('unlock').setDescription('Unlock your channel.'))
            .addSubcommand(x => x.setName('hide').setDescription('Hide your channel from everyone else.'))
            .addSubcommand(x => x.setName('unhide').setDescription('Make your channel visible again.'))
            .addSubcommand(x => x.setName('rename').setDescription('Rename your channel.').addStringOption(o => o.setName('name').setDescription('new channel name').setRequired(true).setMaxLength(100)))
            .addSubcommand(x => x.setName('limit').setDescription('Set the user limit (0 = unlimited).').addIntegerOption(o => o.setName('amount').setDescription('0-99').setRequired(true).setMinValue(0).setMaxValue(99)))
            .addSubcommand(x => x.setName('bitrate').setDescription('Set the audio bitrate in kbps.').addIntegerOption(o => o.setName('kbps').setDescription('8 up to your server maximum').setRequired(true).setMinValue(8).setMaxValue(384)))
            .addSubcommand(x => x.setName('permit').setDescription('Always allow a member in, even while locked/hidden.').addUserOption(o => user(o)))
            .addSubcommand(x => x.setName('reject').setDescription('Block a member from your channel.').addUserOption(o => user(o)))
            .addSubcommand(x => x.setName('kick').setDescription('Disconnect a member from your channel.').addUserOption(o => user(o)))
            .addSubcommand(x => x.setName('claim').setDescription('Claim the channel when its owner has left.'))
            .addSubcommand(x => x.setName('transfer').setDescription('Give ownership to a member inside your channel.').addUserOption(o => user(o, 'new owner')))
            .addSubcommand(x => x.setName('region').setDescription('Change the voice region.').addStringOption(o => o.setName('region').setDescription('voice region').setRequired(true).addChoices(...ui.VM_REGIONS.map(([value, name]) => ({ name, value })))))
            .addSubcommand(x => x.setName('info').setDescription('Show your channel\'s settings.'))
            .addSubcommand(x => x.setName('reset').setDescription('Reset access, limit and region to the server defaults.'))
            .addSubcommand(x => x.setName('save').setDescription('Save this layout as your profile for future rooms.'))
            .addSubcommand(x => x.setName('forget').setDescription('Clear your saved profile.'))
            .addSubcommand(x => x.setName('delete').setDescription('Delete your temporary channel.'))
            .addSubcommand(x => x.setName('panel').setDescription('(Admin) Re-post the control panel in the interface channel.'));
        return b;
    })(),
    async execute(interaction) {
        if (!interaction.guild || !interaction.member)
            return interaction.reply({ embeds: [ui.errorEmbed('Server Only', 'Use this inside a server.')], ephemeral: true });
        const sub = interaction.options.getSubcommand();
        const member = interaction.member;
        const ops = sys.vmOps;
        await interaction.deferReply({ ephemeral: true });
        if (sub === 'panel') {
            if (!member.permissions.has(PermissionFlagsBits.Administrator))
                return sys.vmRespond(interaction, { ok: false, title: 'Missing Permissions', text: 'You need **Administrator** to use this.' });
            if (!db.getConfig(interaction.guildId).voicemaster.interfaceChannelId)
                return sys.vmRespond(interaction, { ok: false, title: 'No Interface Channel', text: 'Pick one with `/voicemaster setup` → **Interface Channel**.' });
            const res = await sys.postVoiceInterface(interaction.guild);
            return sys.vmRespond(interaction, res.ok ? { ok: true, title: 'Interface Posted', text: `Control panel sent to ${res.channel}.` } : { ok: false, title: 'Could Not Post', text: res.error });
        }
        const userId = () => interaction.options.getUser('user')?.id;
        const calls = {
            lock: () => ops.lock(member, true), unlock: () => ops.lock(member, false), hide: () => ops.hide(member, true), unhide: () => ops.hide(member, false),
            rename: () => ops.rename(member, interaction.options.getString('name')), limit: () => ops.limit(member, interaction.options.getInteger('amount')),
            bitrate: () => ops.bitrate(member, interaction.options.getInteger('kbps')), permit: () => ops.permit(member, userId()), reject: () => ops.reject(member, userId()),
            kick: () => ops.kick(member, userId()), claim: () => ops.claim(member), transfer: () => ops.transfer(member, userId()),
            region: () => ops.region(member, interaction.options.getString('region')), info: () => ops.info(member), reset: () => ops.reset(member),
            save: () => ops.save(member), forget: () => ops.forget(member), delete: () => ops.delete(member)
        };
        if (['permit', 'reject', 'kick', 'transfer'].includes(sub) && !userId())
            return sys.vmRespond(interaction, { ok: false, title: 'Member Not Found', text: 'Mention a member or give their ID.' });
        return sys.vmRespond(interaction, await calls[sub]());
    }
});
commands.push(panelSetupCommand('greetmessage', 'Configure the text welcome message.', sub => sub
    .addChannelOption(o => o.setName('channel').setDescription('channel to post in').addChannelTypes(ChannelType.GuildText))
    .addStringOption(o => o.setName('message').setDescription('use {user} and {server}'))
    .addStringOption(o => o.setName('image').setDescription('image/GIF URL shown with the greet message'))
    .addAttachmentOption(o => o.setName('image_file').setDescription('upload an image/GIF for the greet message'))));
commands.push(panelSetupCommand('leveling', 'Configure the XP/leveling system.', sub => sub
    .addChannelOption(o => o.setName('channel').setDescription('level-up announcement channel').addChannelTypes(ChannelType.GuildText))
    .addIntegerOption(o => o.setName('xp_per_message').setDescription('XP per eligible message'))
    .addIntegerOption(o => o.setName('cooldown_seconds').setDescription('seconds between XP gains'))
    .addIntegerOption(o => o.setName('reward_level').setDescription('level for a role reward'))
    .addRoleOption(o => o.setName('reward_role').setDescription('role granted at reward_level'))));
commands.push(panelSetupCommand('tickets', 'Configure the ticket system.', sub => sub
    .addChannelOption(o => o.setName('category').setDescription('category tickets are created under').addChannelTypes(ChannelType.GuildCategory))
    .addRoleOption(o => o.setName('support_role').setDescription('role that can see/claim tickets'))
    .addChannelOption(o => o.setName('log_channel').setDescription('ticket transcript/log channel').addChannelTypes(ChannelType.GuildText))
    .addStringOption(o => o.setName('panel_title').setDescription('title of the ticket panel'))
    .addStringOption(o => o.setName('panel_description').setDescription('message shown on the ticket panel'))
    .addStringOption(o => o.setName('panel_thumbnail').setDescription('panel thumbnail image/GIF URL'))
    .addAttachmentOption(o => o.setName('panel_thumbnail_file').setDescription('upload the panel thumbnail image/GIF'))
    .addStringOption(o => o.setName('panel_image').setDescription('panel banner image/GIF URL'))
    .addAttachmentOption(o => o.setName('panel_image_file').setDescription('upload the panel banner image/GIF'))
    .addStringOption(o => o.setName('category_label').setDescription('category shown inside new tickets'))
    .addStringOption(o => o.setName('welcome_message').setDescription('message shown when a ticket opens'))
    .addStringOption(o => o.setName('welcome_thumbnail').setDescription('ticket welcome thumbnail image/GIF URL'))
    .addAttachmentOption(o => o.setName('welcome_thumbnail_file').setDescription('upload the ticket welcome thumbnail image/GIF'))
    .addStringOption(o => o.setName('welcome_image').setDescription('ticket welcome banner image/GIF URL'))
    .addAttachmentOption(o => o.setName('welcome_image_file').setDescription('upload the ticket welcome banner image/GIF'))));
commands.push({
    data: new SlashCommandBuilder().setName('logsetup').setDescription('Open the easy logging setup panel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        if (!requireAdmin(interaction))
            return;
        const cfg = db.getConfig(interaction.guildId).logs;
        await interaction.reply({ embeds: [ui.logSetupEmbed(cfg)], components: ui.logSetupRows(cfg), ephemeral: true });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('autorole').setDescription('Set the automatic role for bots or humans.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(o => o.setName('target').setDescription('Who should receive the role?').setRequired(true)
        .addChoices({ name: 'Humans', value: 'humans' }, { name: 'Bots', value: 'bots' }, { name: 'Everyone', value: 'everyone' }))
        .addRoleOption(o => o.setName('role').setDescription('Role to assign automatically').setRequired(true)),
    async execute(interaction) {
        if (!requireAdmin(interaction))
            return;
        const target = interaction.options.getString('target');
        const role = interaction.options.getRole('role');
        const next = db.saveConfig(interaction.guildId, { autorole: { enabled: true, target, roleId: role.id } }).autorole;
        await interaction.reply({ embeds: [ui.okEmbed('Autorole Updated', `**Target:** ${target}\n**Role:** ${role}`)] });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('automod').setDescription('Open the fully customizable AutoMod setup panel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(s => s.setName('setup').setDescription('Open AutoMod configuration.')),
    async execute(interaction) {
        if (!requireAdmin(interaction))
            return;
        const cfg = db.getConfig(interaction.guildId).automod;
        await interaction.reply({ embeds: [ui.automodSetupEmbed(cfg)], components: ui.automodSetupRows(cfg), ephemeral: true });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('reactionrolesetup').setDescription('Open the multi-panel reaction-role manager.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        if (!requireAdmin(interaction))
            return;
        const cfg = db.getConfig(interaction.guildId);
        await interaction.reply({ embeds: [ui.reactionRoleSetupEmbed(cfg)], components: ui.reactionRoleSetupRows(cfg), ephemeral: true });
    }
});
for (const [commandName, moduleName] of Object.entries(GENERIC_COMMANDS)) {
    commands.push({
        data: new SlashCommandBuilder().setName(commandName).setDescription(`Configure ${moduleName}.`)
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addSubcommand(s => s.setName('setup').setDescription(`Enable or disable ${moduleName}.`)
            .addStringOption(o => o.setName('state').setDescription('enable or disable').setRequired(true)
            .addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }))
            .addChannelOption(o => o.setName('channel').setDescription('channel this module should use, if any'))),
        async execute(interaction) {
            if (!requireAdmin(interaction))
                return;
            const state = interaction.options.getString('state') === 'enable';
            const channel = interaction.options.getChannel('channel');
            const currentVal = db.getConfig(interaction.guildId)[moduleName];
            const patch = typeof currentVal === 'boolean'
                ? { [moduleName]: state }
                : { [moduleName]: { enabled: state, ...(channel ? { channelId: channel.id } : {}) } };
            const cfg = db.saveConfig(interaction.guildId, patch);
            const display = typeof cfg[moduleName] === 'boolean' ? { enabled: cfg[moduleName] } : cfg[moduleName];
            await interaction.reply({ embeds: [ui.configSummaryEmbed(moduleName, display)] });
        }
    });
}
function parseButtonRoles(text) {
    return String(text || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 20).map((entry, i) => {
        const [rawRole, ...labelParts] = entry.split('=');
        const roleId = rawRole.replace(/[<@&>]/g, '').trim();
        const label = (labelParts.join('=') || `Role ${i + 1}`).trim().slice(0, 80);
        return { roleId, label, mode: 'toggle' };
    }).filter(x => /^\d{15,25}$/.test(x.roleId));
}
commands.push({
    data: new SlashCommandBuilder().setName('buttonrolesetup').setDescription('Open the multi-panel button-role manager.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        if (!requireAdmin(interaction))
            return;
        const cfg = db.getConfig(interaction.guildId);
        await interaction.reply({ embeds: [ui.buttonRoleEmbed(cfg)], components: ui.buttonRoleSetupRows(cfg), ephemeral: true });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('staffapplicationssetup').setDescription('Configure DM staff applications and publish an Apply panel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addChannelOption(o => o.setName('panel_channel').setDescription('Apply panel channel').addChannelTypes(ChannelType.GuildText))
        .addChannelOption(o => o.setName('log_channel').setDescription('Application results/log channel').addChannelTypes(ChannelType.GuildText))
        .addStringOption(o => o.setName('questions').setDescription('Questions separated by | (omit to open the setup panel)'))
        .addStringOption(o => o.setName('title').setDescription('Panel title'))
        .addStringOption(o => o.setName('description').setDescription('Panel description'))
        .addStringOption(o => o.setName('dm_intro').setDescription('Ready message sent in DM')),
    async execute(interaction) {
        if (!requireAdmin(interaction))
            return;
        if (!interaction.options.getString('questions') || !interaction.options.getChannel('panel_channel') || !interaction.options.getChannel('log_channel'))
            return require('./applications').openSetup(interaction);
        const questions = interaction.options.getString('questions').split('|').map(x => x.trim()).filter(Boolean).slice(0, 25);
        if (!questions.length)
            return interaction.reply({ embeds: [ui.errorEmbed('No questions', 'Separate questions with `|`.')], ephemeral: true });
        const cfg = db.saveConfig(interaction.guildId, { staffApplications: { enabled: true, panelChannelId: interaction.options.getChannel('panel_channel').id, logChannelId: interaction.options.getChannel('log_channel').id, questions, title: interaction.options.getString('title') || 'Staff Applications', description: interaction.options.getString('description') || 'Click Apply to start your application.', dmIntro: interaction.options.getString('dm_intro') || 'Are you ready to start your staff application?' } });
        const ch = interaction.options.getChannel('panel_channel');
        await ch.send({ embeds: [ui.base(cfg.staffApplications.title).setDescription(cfg.staffApplications.description)], components: [new (require('discord.js').ActionRowBuilder)().addComponents(new (require('discord.js').ButtonBuilder)().setCustomId('staffapp_apply').setLabel('Apply').setStyle(require('discord.js').ButtonStyle.Success))] });
        await interaction.reply({ embeds: [ui.staffApplicationEmbed(cfg.staffApplications), ui.okEmbed('Panel Published', `Application panel posted in ${ch}.`)], ephemeral: true });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('birthdaysetup').setDescription('Open the easy Birthday setup panel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        if (!requireAdmin(interaction))
            return;
        const cfg = db.getConfig(interaction.guildId).birthdays;
        await interaction.reply({ embeds: [ui.birthdaySetupEmbed(cfg)], components: ui.birthdaySetupRow(cfg), ephemeral: true });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('antibadwordsetup').setDescription('Open the multilingual Anti Bad Word setup panel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        if (!requireAdmin(interaction))
            return;
        const cfg = db.getConfig(interaction.guildId).antibadword;
        await interaction.reply({ embeds: [ui.antiBadwordSetupEmbed(cfg)], components: ui.antiBadwordSetupRow(cfg), ephemeral: true });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('honeypotsetup').setDescription('Open the easy Honeypot setup panel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        if (!requireAdmin(interaction))
            return;
        const cfg = db.getConfig(interaction.guildId).honeypot;
        await interaction.reply({ embeds: [ui.honeypotSetupEmbed(cfg)], components: ui.honeypotSetupRow(cfg), ephemeral: true });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('autorespondersetup').setDescription('Open the easy Auto Responder setup panel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        if (!requireAdmin(interaction))
            return;
        const cfg = db.getConfig(interaction.guildId).autoresponder;
        await interaction.reply({ embeds: [ui.autoresponderSetupEmbed(cfg)], components: ui.autoresponderSetupRow(cfg), ephemeral: true });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('autoreactorsetup').setDescription('Open the easy Auto Reactor setup panel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        if (!requireAdmin(interaction))
            return;
        const cfg = db.getConfig(interaction.guildId).autoreactor;
        await interaction.reply({ embeds: [ui.autoreactorSetupEmbed(cfg)], components: ui.autoreactorSetupRow(cfg), ephemeral: true });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('embedbuilder').setDescription('Build a custom embed with buttons and post it to a channel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    async execute(interaction) {
        if (!requireAdmin(interaction))
            return;
        sys.embedBuilderSessions.set(interaction.user.id, { title: '', description: '', color: '', imageUrl: '', thumbnailUrl: '', footer: '', buttons: [] });
        const draft = sys.embedBuilderSessions.get(interaction.user.id);
        await interaction.reply({ embeds: [ui.embedBuilderPreviewEmbed(draft)], components: ui.embedBuilderRow(draft), ephemeral: true });
    }
});
commands.push({
    data: new SlashCommandBuilder()
        .setName('whitelist')
        .setDescription('Manage antinuke-exempt users.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(s => s.setName('add').setDescription('exempt a user').addUserOption(o => o.setName('user').setDescription('user').setRequired(true)))
        .addSubcommand(s => s.setName('remove').setDescription('remove exemption').addUserOption(o => o.setName('user').setDescription('user').setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('List exempt users')),
    async execute(interaction) {
        if (!requireAdmin(interaction))
            return;
        const sub = interaction.options.getSubcommand();
        const user = interaction.options.getUser('user');
        if (sub === 'list') {
            const h = require('./helpers');
            return h.paginate(interaction, h.listPages({ title: '🛡️ Antinuke whitelist', lines: db.listWhitelist(interaction.guildId).map((id, n) => `${n + 1}. <@${id}> (\`${id}\`)`), emptyHint: 'Add someone with `/whitelist add`.' }), { ephemeral: true });
        }
        if (!user)
            return interaction.reply({ embeds: [ui.errorEmbed('User required', 'Mention a user.')], ephemeral: true });
        if (sub === 'add') {
            db.addToWhitelist(interaction.guildId, user.id);
            return interaction.reply({ embeds: [ui.okEmbed('✅ Whitelisted', `${user} is now exempt from antinuke.`)] });
        }
        db.removeFromWhitelist(interaction.guildId, user.id);
        return interaction.reply({ embeds: [ui.okEmbed('✅ Removed', `${user} is no longer exempt.`)] });
    }
});
function modLog(interaction, embed) {
    sys.getLogChannel(interaction.guild, 'mod').then(ch => ch?.send({ embeds: [embed] }).catch(() => { }));
}
commands.push({
    data: new SlashCommandBuilder().setName('ban').setDescription('Ban a member after confirmation.')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .addUserOption(o => o.setName('user').setDescription('user').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('reason')),
    async execute(interaction) {
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        if (user.id === interaction.guild.ownerId)
            return interaction.reply({ embeds: [ui.errorEmbed('Action Blocked', 'The server owner cannot be banned.')], ephemeral: true });
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        const preflight = actionPreflight(interaction, member, PermissionFlagsBits.BanMembers, 'Ban Members', 'ban');
        if (preflight)
            return interaction.reply({ embeds: [preflight], ephemeral: true });
        const bot = botMember(interaction);
        if (!bot?.permissions?.has(PermissionFlagsBits.BanMembers) && !bot?.permissions?.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ embeds: [ui.errorEmbed('Bot Missing Permissions', 'I need **Ban Members** permission to ban members.')], ephemeral: true });
        }
        if (member && !member.bannable)
            return interaction.reply({ embeds: [ui.errorEmbed('Cannot Ban Member', `Discord does not allow me to ban **${user.tag}**. Check my highest role and the target's role.`)], ephemeral: true });
        return askForConfirmation(interaction, {
            title: 'Confirm Ban',
            description: `Ban **${user.tag}** (\`${user.id}\`)?\n**Reason:** ${reason}`,
            actionLabel: `ban ${user.tag}`,
            run: async (confirmed) => {
                if (user.id === confirmed.guild.ownerId)
                    return ui.errorEmbed('Action Blocked', 'The server owner cannot be banned.');
                const freshMember = await confirmed.guild.members.fetch(user.id).catch(() => null);
                const check = actionPreflight(confirmed, freshMember, PermissionFlagsBits.BanMembers, 'Ban Members', 'ban');
                if (check)
                    return check;
                const freshBot = botMember(confirmed);
                if (!freshBot?.permissions?.has(PermissionFlagsBits.BanMembers) && !freshBot?.permissions?.has(PermissionFlagsBits.Administrator))
                    return ui.errorEmbed('Bot Missing Permissions', 'I need **Ban Members** permission to ban members.');
                if (freshMember && !freshMember.bannable)
                    return ui.errorEmbed('Cannot Ban Member', `Discord does not allow me to ban **${user.tag}**. Check my highest role and the target's role.`);
                try {
                    await confirmed.guild.bans.create(user.id, { reason: `${reason} | Requested by ${confirmed.user.tag}`.slice(0, 512) });
                }
                catch (e) {
                    const detail = e.code === 50013 ? 'I do not have permission, or my role is not high enough.' : (e.message || 'Unknown error');
                    return ui.errorEmbed('Ban Failed', `Discord rejected the ban. **${e.code || 'Unknown error'}** — ${detail}`);
                }
                const embed = ui.okEmbed('🔨 Member Banned', `**User:** ${user.tag}\n**By:** ${confirmed.user}\n**Reason:** ${reason}`);
                modLog(confirmed, embed);
                return embed;
            }
        });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('kick').setDescription('Kick a member after confirmation.')
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
        .addUserOption(o => o.setName('user').setDescription('user').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('reason')),
    async execute(interaction) {
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member)
            return interaction.reply({ embeds: [ui.errorEmbed('Member Not Found', 'That user is not currently a member of this server.')], ephemeral: true });
        const preflight = actionPreflight(interaction, member, PermissionFlagsBits.KickMembers, 'Kick Members', 'kick');
        if (preflight)
            return interaction.reply({ embeds: [preflight], ephemeral: true });
        if (!member.kickable)
            return interaction.reply({ embeds: [ui.errorEmbed('Cannot Kick Member', `Discord does not allow me to kick **${user.tag}**. Check my highest role and the target's role.`)], ephemeral: true });
        return askForConfirmation(interaction, {
            title: 'Confirm Kick',
            description: `Kick **${user.tag}** (\`${user.id}\`)?\n**Reason:** ${reason}`,
            actionLabel: `kick ${user.tag}`,
            run: async (confirmed) => {
                const freshMember = await confirmed.guild.members.fetch(user.id).catch(() => null);
                if (!freshMember)
                    return ui.errorEmbed('Member Not Found', 'That user is no longer in this server.');
                const check = actionPreflight(confirmed, freshMember, PermissionFlagsBits.KickMembers, 'Kick Members', 'kick');
                if (check)
                    return check;
                if (!freshMember.kickable)
                    return ui.errorEmbed('Cannot Kick Member', `Discord does not allow me to kick **${user.tag}**. Check my highest role and the target's role.`);
                try {
                    await freshMember.kick(reason);
                }
                catch (e) {
                    return ui.errorEmbed('Kick Failed', `Discord rejected the kick. **${e.code || 'Unknown error'}** — ${e.message || 'Unknown error'}`);
                }
                const embed = ui.okEmbed('👢 Member Kicked', `**User:** ${user.tag}\n**By:** ${confirmed.user}\n**Reason:** ${reason}`);
                modLog(confirmed, embed);
                return embed;
            }
        });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('timeout').setDescription('Timeout a member.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(o => o.setName('user').setDescription('user').setRequired(true))
        .addIntegerOption(o => o.setName('minutes').setDescription('duration in minutes').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('reason')),
    async execute(interaction) {
        const user = interaction.options.getUser('user');
        const minutes = interaction.options.getInteger('minutes');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        const preflight = actionPreflight(interaction, member, PermissionFlagsBits.ModerateMembers, 'Moderate Members', 'timeout');
        if (preflight)
            return interaction.reply({ embeds: [preflight], ephemeral: true });
        try {
            await member.timeout(minutes * 60_000, reason);
        }
        catch (e) {
            return interaction.reply({ embeds: [ui.errorEmbed('Timeout Failed', `Discord rejected the action. **${e.code || 'Unknown error'}** — ${e.message || 'unknown error'}`)], ephemeral: true });
        }
        const embed = ui.warnEmbed('⏱️ Member Timed Out', `**User:** ${user.tag}\n**Duration:** ${minutes}m\n**By:** ${interaction.user}\n**Reason:** ${reason}`);
        await interaction.reply({ embeds: [embed] });
        modLog(interaction, embed);
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('untimeout').setDescription('Remove a member\'s timeout.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(o => o.setName('user').setDescription('user').setRequired(true)),
    async execute(interaction) {
        const user = interaction.options.getUser('user');
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        const preflight = actionPreflight(interaction, member, PermissionFlagsBits.ModerateMembers, 'Moderate Members', 'remove the timeout from');
        if (preflight)
            return interaction.reply({ embeds: [preflight], ephemeral: true });
        try {
            await member.timeout(null);
        }
        catch (e) {
            return interaction.reply({ embeds: [ui.errorEmbed('Timeout Removal Failed', `Discord rejected the action. **${e.code || 'Unknown error'}** — ${e.message || 'unknown error'}`)], ephemeral: true });
        }
        await interaction.reply({ embeds: [ui.okEmbed('✅ Timeout Removed', `${user} can speak again.`)] });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('warn').setDescription('Warn a member.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(o => o.setName('user').setDescription('user').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(true)),
    async execute(interaction) {
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason');
        db.addWarn(interaction.guildId, user.id, interaction.user.id, reason);
        const embed = ui.warnEmbed('⚠️ Member Warned', `**User:** ${user.tag}\n**By:** ${interaction.user}\n**Reason:** ${reason}`);
        await interaction.reply({ embeds: [embed] });
        modLog(interaction, embed);
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('warnings').setDescription('View a member\'s warnings.')
        .addUserOption(o => o.setName('user').setDescription('user').setRequired(true)),
    async execute(interaction) {
        const user = interaction.options.getUser('user');
        const warns = db.getWarns(interaction.guildId, user.id);
        const h = require('./helpers');
        const lines = (warns || []).map((w, i) => `**${i + 1}.** ${h.clip(w.reason || 'No reason given', 300)} — <@${w.moderatorId}> <t:${Math.floor(w.timestamp / 1000)}:R>`);
        await h.paginate(interaction, h.listPages({ title: `⚠️ Warnings — ${user.tag}`, lines, emptyHint: 'This member has a clean record.', perPage: 8 }));
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('clearwarns').setDescription('Clear a member\'s warnings.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(o => o.setName('user').setDescription('user').setRequired(true)),
    async execute(interaction) {
        const user = interaction.options.getUser('user');
        db.clearWarns(interaction.guildId, user.id);
        await interaction.reply({ embeds: [ui.okEmbed('✅ Warnings Cleared', `${user}'s warnings were cleared.`)] });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('purge').setDescription('Bulk delete messages after confirmation.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addIntegerOption(o => o.setName('amount').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100))
        .addUserOption(o => o.setName('user').setDescription("only delete this user's messages")),
    async execute(interaction) {
        const amount = interaction.options.getInteger('amount');
        const user = interaction.options.getUser('user');
        const permissionError = actionPermissionError(interaction, PermissionFlagsBits.ManageMessages, 'Manage Messages');
        if (permissionError)
            return interaction.reply({ embeds: [permissionError], ephemeral: true });
        if (!interaction.channel?.isTextBased?.() || !interaction.channel.messages?.fetch || !interaction.channel.bulkDelete) {
            return interaction.reply({ embeds: [ui.errorEmbed('Unsupported Channel', 'Purge works in regular text channels and threads that support bulk deletion.')], ephemeral: true });
        }
        return askForConfirmation(interaction, {
            title: 'Confirm Purge',
            description: `Delete up to **${amount}** recent messages${user ? ` from ${user}` : ''} in ${interaction.channel}? Messages older than 14 days cannot be bulk-deleted.`,
            actionLabel: `purge ${amount} messages`,
            run: async (confirmed) => {
                const check = actionPermissionError(confirmed, PermissionFlagsBits.ManageMessages, 'Manage Messages');
                if (check)
                    return check;
                const channel = confirmed.channel;
                const messages = await channel.messages.fetch({ limit: amount });
                const filtered = user ? messages.filter(m => m.author.id === user.id) : messages;
                if (!filtered.size)
                    return ui.warnEmbed('Nothing To Purge', 'No matching recent messages were found.');
                let deleted;
                try {
                    deleted = await channel.bulkDelete(filtered, true);
                }
                catch (e) {
                    return ui.errorEmbed('Purge Failed', `Discord rejected the deletion. **${e.code || 'Unknown error'}** — ${e.message || 'Unknown error'}`);
                }
                return ui.okEmbed('🧹 Messages Purged', `Successfully deleted **${deleted.size}** message(s)${user ? ` from ${user}` : ''}.`);
            }
        });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('lock').setDescription('Lock the current channel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
    async execute(interaction) {
        try {
            await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false });
        }
        catch (e) {
            return interaction.reply({ embeds: [ui.errorEmbed('Lock Failed', `Discord rejected the action. **${e.code || 'Unknown error'}** — ${e.message || 'unknown error'}`)], ephemeral: true });
        }
        await interaction.reply({ embeds: [ui.warnEmbed('🔒 Channel Locked', `${interaction.channel} has been locked.`)] });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('unlock').setDescription('Unlock the current channel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
    async execute(interaction) {
        try {
            await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: null });
        }
        catch (e) {
            return interaction.reply({ embeds: [ui.errorEmbed('Unlock Failed', `Discord rejected the action. **${e.code || 'Unknown error'}** — ${e.message || 'unknown error'}`)], ephemeral: true });
        }
        await interaction.reply({ embeds: [ui.okEmbed('🔓 Channel Unlocked', `${interaction.channel} has been unlocked.`)] });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('slowmode').setDescription('Set channel slowmode.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addIntegerOption(o => o.setName('seconds').setDescription('0-21600').setRequired(true).setMinValue(0).setMaxValue(21600)),
    async execute(interaction) {
        const seconds = interaction.options.getInteger('seconds');
        await interaction.channel.setRateLimitPerUser(seconds);
        await interaction.reply({ embeds: [ui.okEmbed('🐌 Slowmode Set', `Slowmode is now ${seconds}s in ${interaction.channel}.`)] });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('role').setDescription('Add or remove a role from a member.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
        .addSubcommand(s => s.setName('add').setDescription('add a role').addUserOption(o => o.setName('user').setDescription('user').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('role').setRequired(true)))
        .addSubcommand(s => s.setName('remove').setDescription('remove a role').addUserOption(o => o.setName('user').setDescription('user').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('role').setRequired(true))),
    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const user = interaction.options.getUser('user');
        const role = interaction.options.getRole('role');
        const member = await interaction.guild.members.fetch(user.id);
        const perm = actionPermissionError(interaction, PermissionFlagsBits.ManageRoles, 'Manage Roles');
        if (perm)
            return interaction.reply({ embeds: [perm], ephemeral: true });
        const bot = botMember(interaction);
        if (role.position >= bot.roles.highest.position)
            return interaction.reply({ embeds: [ui.errorEmbed('Role Hierarchy', `I cannot ${sub} **${role.name}** because that role is equal to or higher than my highest role.`)], ephemeral: true });
        if (interaction.member.id !== interaction.guild.ownerId && role.position >= interaction.member.roles.highest.position)
            return interaction.reply({ embeds: [ui.errorEmbed('Role Hierarchy', `You cannot ${sub} **${role.name}** because it is equal to or higher than your highest role.`)], ephemeral: true });
        const targetCheck = hierarchyError(interaction, member, sub === 'add' ? 'add roles to' : 'remove roles from');
        if (targetCheck)
            return interaction.reply({ embeds: [targetCheck], ephemeral: true });
        try {
            if (sub === 'add')
                await member.roles.add(role);
            else
                await member.roles.remove(role);
        }
        catch (e) {
            return interaction.reply({ embeds: [ui.errorEmbed('Role Action Failed', `Discord rejected the action. **${e.code || 'Unknown error'}** — ${e.message || 'unknown error'}`)], ephemeral: true });
        }
        await interaction.reply({ embeds: [ui.okEmbed('✅ Role Updated', `${role} ${sub === 'add' ? 'added to' : 'removed from'} ${user}.`)] });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('nickname').setDescription('Change a member\'s nickname.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)
        .addUserOption(o => o.setName('user').setDescription('user').setRequired(true))
        .addStringOption(o => o.setName('nickname').setDescription('leave blank to reset')),
    async execute(interaction) {
        const user = interaction.options.getUser('user');
        const nickname = interaction.options.getString('nickname') || null;
        const member = await interaction.guild.members.fetch(user.id);
        const targetCheck = hierarchyError(interaction, member, 'change the nickname of');
        if (targetCheck)
            return interaction.reply({ embeds: [targetCheck], ephemeral: true });
        try {
            await member.setNickname(nickname);
        }
        catch (e) {
            return interaction.reply({ embeds: [ui.errorEmbed('Nickname Update Failed', `Discord rejected the action. **${e.code || 'Unknown error'}** — ${e.message || 'unknown error'}`)], ephemeral: true });
        }
        await interaction.reply({ embeds: [ui.okEmbed('✅ Nickname Updated', `${user}'s nickname is now **${nickname || user.username}**.`)] });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('rank').setDescription('View a level card.')
        .addUserOption(o => o.setName('user').setDescription('user')),
    async execute(interaction) {
        const user = interaction.options.getUser('user') || interaction.user;
        const rec = db.getLevel(interaction.guildId, user.id);
        const need = sys.xpForLevel(rec.level);
        await interaction.reply({ embeds: [ui.base(`📈 ${user.username}'s Rank`).setDescription(`**Level:** ${rec.level}\n**XP:** ${rec.xp} / ${need}`).setThumbnail(user.displayAvatarURL())] });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('leaderboard').setDescription('Top XP in this server.'),
    async execute(interaction) {
        const h = require('./helpers');
        const rows = db.topLevels(interaction.guildId, 100) || [];
        const lines = rows.map((r, i) => `**${i + 1}.** <@${r.userId}> — Level **${r.level}** • ${Number(r.xp || 0).toLocaleString()} XP`);
        await h.paginate(interaction, h.listPages({ title: `🏆 ${interaction.guild.name} — XP Leaderboard`, lines, emptyHint: 'Chat to earn XP.' }));
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('ticketpanel').setDescription('Post the ticket-opening panel here.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        const cfg = db.getConfig(interaction.guildId).ticket;
        if (!cfg.enabled)
            return interaction.reply({ embeds: [ui.errorEmbed('Tickets Disabled', 'Run `/tickets setup state:enable` first.')], ephemeral: true });
        await interaction.channel.send({ embeds: [ui.ticketPanelEmbed(interaction.guild.name, cfg)], components: [ui.ticketPanelRow()] });
        await interaction.reply({ embeds: [ui.okEmbed('✅ Panel Posted', 'The ticket panel is live.')], ephemeral: true });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('ticketconfig').setDescription('Customize the ticket panel and welcome embed (images + text).')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(o => o.setName('panel_title').setDescription('Title of the "Open Ticket" panel'))
        .addStringOption(o => o.setName('panel_description').setDescription('Body text of the "Open Ticket" panel'))
        .addStringOption(o => o.setName('panel_thumbnail').setDescription('Small image URL for the panel (top-right)'))
        .addAttachmentOption(o => o.setName('panel_thumbnail_file').setDescription('Upload the panel thumbnail image/GIF'))
        .addStringOption(o => o.setName('panel_image').setDescription('Big banner image/GIF URL for the panel'))
        .addAttachmentOption(o => o.setName('panel_image_file').setDescription('Upload the panel banner image/GIF'))
        .addStringOption(o => o.setName('category_label').setDescription('Category name shown when a ticket opens, e.g. "General Support"'))
        .addStringOption(o => o.setName('welcome_message').setDescription('Extra line shown under Welcome/Category in a new ticket'))
        .addStringOption(o => o.setName('welcome_thumbnail').setDescription('Small image URL shown in a new ticket (top-right)'))
        .addAttachmentOption(o => o.setName('welcome_thumbnail_file').setDescription('Upload the ticket welcome thumbnail image/GIF'))
        .addStringOption(o => o.setName('welcome_image').setDescription('Big banner image/GIF URL shown in a new ticket'))
        .addAttachmentOption(o => o.setName('welcome_image_file').setDescription('Upload the ticket welcome banner image/GIF')),
    async execute(interaction) {
        if (!requireAdmin(interaction))
            return;
        const map = {
            panel_title: 'panelTitle', panel_description: 'panelDescription', panel_thumbnail: 'panelThumbnail', panel_image: 'panelImage',
            category_label: 'categoryLabel', welcome_message: 'welcomeMessage', welcome_thumbnail: 'welcomeThumbnail', welcome_image: 'welcomeImage'
        };
        const patch = { ticket: {} };
        let changed = false;
        for (const [opt, key] of Object.entries(map)) {
            const val = interaction.options.getString(opt);
            if (val !== null) {
                patch.ticket[key] = val;
                changed = true;
            }
        }
        const fileMap = {
            panel_thumbnail_file: 'panelThumbnail', panel_image_file: 'panelImage',
            welcome_thumbnail_file: 'welcomeThumbnail', welcome_image_file: 'welcomeImage'
        };
        for (const [opt, key] of Object.entries(fileMap)) {
            const attachment = getImageAttachment(interaction, opt);
            if (attachment) {
                patch.ticket[key] = attachment.url;
                changed = true;
            }
        }
        const cfg = changed ? db.saveConfig(interaction.guildId, patch).ticket : db.getConfig(interaction.guildId).ticket;
        await interaction.reply({
            content: changed ? `${ui.emoji('success')} Ticket appearance updated. Previews below:` : 'Current ticket appearance — previews below:',
            embeds: [ui.ticketPanelEmbed(interaction.guild.name, cfg), ui.ticketWelcomeEmbed(interaction.user, cfg)],
            ephemeral: true
        });
    }
});
function requireTicketStaff(interaction, ticketCfg) {
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    const hasRole = ticketCfg.supportRoleId && interaction.member.roles.cache.has(ticketCfg.supportRoleId);
    if (!isAdmin && !hasRole) {
        interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need the support role or Administrator to manage tickets.')], ephemeral: true });
        return false;
    }
    return true;
}
function requireInTicket(interaction) {
    const ticket = db.getTicket(interaction.channel.id);
    if (!ticket) {
        interaction.reply({ embeds: [ui.errorEmbed('Not a Ticket', 'This command only works inside a ticket channel.')], ephemeral: true });
        return null;
    }
    return ticket;
}
commands.push({
    data: new SlashCommandBuilder().setName('claim').setDescription('Claim this ticket.'),
    async execute(interaction) {
        const ticket = requireInTicket(interaction);
        if (!ticket)
            return;
        const ticketCfg = db.getConfig(interaction.guildId).ticket;
        if (!requireTicketStaff(interaction, ticketCfg))
            return;
        if (ticket.claimedBy)
            return interaction.reply({ embeds: [ui.warnEmbed('Already Claimed', `Already claimed by <@${ticket.claimedBy}>.`)], ephemeral: true });
        db.setTicketStatus(interaction.channel.id, 'claimed', interaction.user.id);
        await interaction.reply({ embeds: [ui.okEmbed('🙋 Ticket Claimed', `${interaction.user} claimed this ticket.`)] });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('close').setDescription('Close this ticket (deletes it shortly after).'),
    async execute(interaction) {
        const ticket = requireInTicket(interaction);
        if (!ticket)
            return;
        const ticketCfg = db.getConfig(interaction.guildId).ticket;
        if (!requireTicketStaff(interaction, ticketCfg) && interaction.user.id !== ticket.userId)
            return;
        db.setTicketStatus(interaction.channel.id, 'closed');
        await interaction.reply({ embeds: [ui.warnEmbed('🔒 Closing Ticket', `Closed by ${interaction.user}. This channel will be deleted in 5 seconds.`)] });
        if (ticketCfg.logChannelId) {
            const log = interaction.guild.channels.cache.get(ticketCfg.logChannelId);
            if (log)
                log.send({ embeds: [ui.base('🎫 Ticket Closed').setDescription(`Ticket by <@${ticket.userId}> closed by ${interaction.user}.`)] }).catch(() => { });
        }
        setTimeout(() => interaction.channel.delete().catch(() => { }), 5000);
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('delete').setDescription('Immediately delete this ticket, no grace period.'),
    async execute(interaction) {
        const ticket = requireInTicket(interaction);
        if (!ticket)
            return;
        const ticketCfg = db.getConfig(interaction.guildId).ticket;
        if (!requireTicketStaff(interaction, ticketCfg))
            return;
        await interaction.reply({ embeds: [ui.warnEmbed('🗑️ Deleting Ticket', 'This channel is being deleted now.')] });
        if (ticketCfg.logChannelId) {
            const log = interaction.guild.channels.cache.get(ticketCfg.logChannelId);
            if (log)
                log.send({ embeds: [ui.base('🗑️ Ticket Deleted').setDescription(`Ticket by <@${ticket.userId}> deleted by ${interaction.user}.`)] }).catch(() => { });
        }
        setTimeout(() => interaction.channel.delete().catch(() => { }), 1500);
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('addmembertoticket').setDescription('Add a member to this ticket.')
        .addUserOption(o => o.setName('user').setDescription('member to add').setRequired(true)),
    async execute(interaction) {
        const ticket = requireInTicket(interaction);
        if (!ticket)
            return;
        const ticketCfg = db.getConfig(interaction.guildId).ticket;
        if (!requireTicketStaff(interaction, ticketCfg))
            return;
        const user = interaction.options.getUser('user');
        await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        await interaction.reply({ embeds: [ui.okEmbed('➕ Member Added', `${user} can now see this ticket.`)] });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('removemembertoticket').setDescription('Remove a member from this ticket.')
        .addUserOption(o => o.setName('user').setDescription('member to remove').setRequired(true)),
    async execute(interaction) {
        const ticket = requireInTicket(interaction);
        if (!ticket)
            return;
        const ticketCfg = db.getConfig(interaction.guildId).ticket;
        if (!requireTicketStaff(interaction, ticketCfg))
            return;
        const user = interaction.options.getUser('user');
        await interaction.channel.permissionOverwrites.delete(user.id).catch(() => { });
        await interaction.reply({ embeds: [ui.okEmbed('➖ Member Removed', `${user} can no longer see this ticket.`)] });
    }
});
commands.push({
    data: new SlashCommandBuilder()
        .setName('prefix')
        .setDescription('Set this server\'s prefix for text commands (e.g. !ban @user spamming).')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(o => o.setName('prefix').setDescription('new prefix, e.g. ! or ? or >').setRequired(true)),
    async execute(interaction) {
        if (!requireAdmin(interaction))
            return;
        const prefix = interaction.options.getString('prefix').trim().slice(0, 5);
        if (!prefix)
            return interaction.reply({ embeds: [ui.errorEmbed('Invalid Prefix', 'Prefix can\'t be empty.')], ephemeral: true });
        db.saveConfig(interaction.guildId, { prefix });
        await interaction.reply({ embeds: [ui.okEmbed('✅ Prefix Updated', `Text commands now use \`${prefix}\`. Example: \`${prefix}help\``)] });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('testgreet').setDescription('Preview the greet message, optionally with a custom image or GIF.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(o => o.setName('message').setDescription('override text, use {user} and {server} (defaults to the configured message)'))
        .addStringOption(o => o.setName('image').setDescription('image/GIF URL to attach (defaults to the configured one, if any)'))
        .addAttachmentOption(o => o.setName('attachment').setDescription('upload an image/GIF directly instead of a URL'))
        .addChannelOption(o => o.setName('channel').setDescription('post the preview here instead of this channel').addChannelTypes(ChannelType.GuildText)),
    async execute(interaction) {
        if (!requireAdmin(interaction))
            return;
        const cfg = db.getConfig(interaction.guildId).greetmessage;
        const attachment = interaction.options.getAttachment('attachment');
        const imageUrl = attachment ? attachment.url : (interaction.options.getString('image') || cfg.image || null);
        const text = (interaction.options.getString('message') || cfg.message || 'Welcome {user}!')
            .replace('{user}', `${interaction.user}`).replace('{server}', interaction.guild.name);
        const embed = ui.okEmbed('👋 Welcome! (Test)', text);
        if (imageUrl)
            embed.setImage(imageUrl);
        const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
        await targetChannel.send({ embeds: [embed] });
        if (targetChannel.id !== interaction.channel.id) {
            await interaction.reply({ embeds: [ui.okEmbed('✅ Preview Sent', `Posted in ${targetChannel}.`)], ephemeral: true });
        }
        else {
            await interaction.reply({ content: ui.emojify(`${ui.emoji('success')} Preview posted above (this test does not save the image as your permanent config — use /greetmessage setup for that).`), ephemeral: true });
        }
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('xp').setDescription('Manage a member\'s XP/level.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addSubcommand(s => s.setName('add').setDescription('add XP to a member')
        .addUserOption(o => o.setName('user').setDescription('member').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('XP to add').setRequired(true)))
        .addSubcommand(s => s.setName('remove').setDescription('remove XP from a member')
        .addUserOption(o => o.setName('user').setDescription('member').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('XP to remove').setRequired(true)))
        .addSubcommand(s => s.setName('set').setDescription('set a member\'s XP directly')
        .addUserOption(o => o.setName('user').setDescription('member').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('new XP total').setRequired(true)))
        .addSubcommand(s => s.setName('setlevel').setDescription('set a member\'s level directly')
        .addUserOption(o => o.setName('user').setDescription('member').setRequired(true))
        .addIntegerOption(o => o.setName('level').setDescription('new level').setRequired(true)))
        .addSubcommand(s => s.setName('reset').setDescription('reset a member\'s XP and level to 0')
        .addUserOption(o => o.setName('user').setDescription('member').setRequired(true))),
    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers) && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Moderate Members** or **Administrator**.')], ephemeral: true });
        }
        const sub = interaction.options.getSubcommand();
        const user = interaction.options.getUser('user');
        const rec = db.getLevel(interaction.guildId, user.id);
        let xp = rec.xp, level = rec.level;
        if (sub === 'add')
            xp = Math.max(0, xp + interaction.options.getInteger('amount'));
        else if (sub === 'remove')
            xp = Math.max(0, xp - interaction.options.getInteger('amount'));
        else if (sub === 'set')
            xp = Math.max(0, interaction.options.getInteger('amount'));
        else if (sub === 'setlevel')
            level = Math.max(0, interaction.options.getInteger('level'));
        else if (sub === 'reset') {
            xp = 0;
            level = 0;
        }
        db.setLevel(interaction.guildId, user.id, xp, level, rec.lastMessage);
        await interaction.reply({ embeds: [ui.okEmbed('📈 XP Updated', `${user} — **Level:** ${level} **XP:** ${xp}`)] });
    }
});
commands.push({
    ownerOnly: true,
    data: new SlashCommandBuilder().setName('bl').setDescription('[Owner] Block command use in servers owned by a user.')
        .addSubcommand(s => s.setName('add').setDescription('Blacklist all servers owned by a user.')
        .addStringOption(o => o.setName('user_id').setDescription('Discord user ID of the server owner').setRequired(true).setMinLength(15).setMaxLength(25)))
        .addSubcommand(s => s.setName('remove').setDescription('Remove a user from the global server blacklist.')
        .addStringOption(o => o.setName('user_id').setDescription('Discord user ID').setRequired(true).setMinLength(15).setMaxLength(25)))
        .addSubcommand(s => s.setName('list').setDescription('List globally blacklisted server owners.')),
    async execute(interaction) {
        if (!isOwner(interaction.user?.id))
            return interaction.reply({ embeds: [ui.errorEmbed('⛔ Owner Only', 'This command is restricted to IDs listed in `OWNER_IDS`.')], ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (sub === 'list') {
            const ids = db.getGlobalBlacklist();
            const lines = ids.map((id, index) => `**${index + 1}.** <@${id}> — \`${id}\``);
            return interaction.reply({ embeds: [ui.infoEmbed('🛡️ Global Server Blacklist', lines.join('\n').slice(0, 3900) || 'The global blacklist is empty.')], ephemeral: true });
        }
        const userId = String(interaction.options.getString('user_id', true)).trim();
        if (!/^\d{15,25}$/.test(userId))
            return interaction.reply({ embeds: [ui.errorEmbed('Invalid User ID', 'Enter a valid Discord user ID containing 15–25 digits.')], ephemeral: true });
        if (sub === 'add') {
            const ids = db.addGlobalBlacklist(userId);
            const ownedGuilds = interaction.client.guilds.cache.filter(g => g.ownerId === userId).map(g => g.name);
            return interaction.reply({ embeds: [ui.okEmbed('🚫 Owner Blacklisted', `AunXz will silently ignore commands in servers owned by <@${userId}>.\n**Currently joined matching servers:** ${ownedGuilds.length}${ownedGuilds.length ? `\n${ownedGuilds.slice(0, 8).map(name => `• ${name}`).join('\n')}` : ''}\n**Total blacklisted owners:** ${ids.length}`)], ephemeral: true });
        }
        const ids = db.removeGlobalBlacklist(userId);
        return interaction.reply({ embeds: [ui.okEmbed('✅ Owner Removed From Blacklist', `Commands are no longer blocked based on server ownership for <@${userId}>.\n**Total blacklisted owners:** ${ids.length}`)], ephemeral: true });
    }
});
commands.push({
    ownerOnly: true,
    data: new SlashCommandBuilder().setName('maintenance').setDescription('[Owner] Toggle maintenance mode.')
        .addStringOption(o => o.setName('state').setDescription('on/off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
    async execute(interaction) {
        if (!isOwner(interaction.user.id))
            return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
        const state = interaction.options.getString('state') === 'on';
        db.saveConfig(interaction.guildId, { maintenance: state });
        await interaction.reply({ embeds: [ui.okEmbed('🛠️ Maintenance Mode', `Maintenance mode is now **${state ? 'ON' : 'OFF'}**.`)] });
    }
});
commands.push({
    ownerOnly: true,
    data: new SlashCommandBuilder().setName('blacklist').setDescription('[Owner] Block a user from using the bot.')
        .addSubcommand(s => s.setName('add').setDescription('block a user').addUserOption(o => o.setName('user').setDescription('user').setRequired(true)))
        .addSubcommand(s => s.setName('remove').setDescription('unblock a user').addUserOption(o => o.setName('user').setDescription('user').setRequired(true))),
    async execute(interaction) {
        if (!isOwner(interaction.user.id))
            return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
        const sub = interaction.options.getSubcommand();
        const user = interaction.options.getUser('user');
        const cfg = db.getConfig(interaction.guildId);
        const list = sub === 'add' ? [...new Set([...cfg.blacklist, user.id])] : cfg.blacklist.filter(id => id !== user.id);
        db.saveConfig(interaction.guildId, { blacklist: list });
        await interaction.reply({ embeds: [ui.okEmbed('✅ Blacklist Updated', `${user} ${sub === 'add' ? 'blocked' : 'unblocked'}.`)] });
    }
});
commands.push({
    ownerOnly: true,
    data: new SlashCommandBuilder().setName('emoji').setDescription('[Owner] View or change every emoji the bot uses.')
        .addSubcommand(s => s.setName('list').setDescription('Show every emoji currently used by the bot.'))
        .addSubcommand(s => s.setName('set').setDescription('Change one emoji everywhere it is used.')
        .addStringOption(o => o.setName('name').setDescription('Name from /emoji list').setRequired(true))
        .addStringOption(o => o.setName('value').setDescription('Unicode emoji or custom emoji such as <:name:id>.').setRequired(true)))
        .addSubcommand(s => s.setName('reset').setDescription('Restore one emoji to its default.')
        .addStringOption(o => o.setName('name').setDescription('Name from /emoji list').setRequired(true)))
        .addSubcommand(s => s.setName('save').setDescription('Save a snapshot of every bot emoji and return a random restore code.'))
        .addSubcommand(s => s.setName('load').setDescription('Load an emoji snapshot using its random code.')
        .addStringOption(o => o.setName('code').setDescription('Snapshot code from /emoji save').setRequired(true))),
    async execute(interaction) {
        if (!isOwner(interaction.user.id))
            return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (sub === 'list') {
            return interaction.reply({ embeds: [ui.emojisListEmbed(db.getAllEmojiOverrides(), 1)], components: ui.emojisListRows(1), ephemeral: true });
        }
        if (sub === 'save') {
            const values = {};
            for (const key of ui.EMOJI_KEYS)
                values[key] = ui.emoji(key);
            const code = db.saveEmojiSnapshot(values);
            return interaction.reply({ embeds: [ui.okEmbed('💾 Emoji Snapshot Saved', `Snapshot saved.

**Code:** \`${code}\`\n
Use **/emoji load** with this code to restore these emojis later.`)], ephemeral: true });
        }
        if (sub === 'load') {
            const code = interaction.options.getString('code').trim();
            const snapshot = db.getEmojiSnapshot(code);
            if (!snapshot)
                return interaction.reply({ embeds: [ui.errorEmbed('Snapshot Not Found', `No emoji snapshot exists for \`${code}\`.`)], ephemeral: true });
            for (const key of ui.EMOJI_KEYS) {
                const value = snapshot[key];
                if (value)
                    db.setEmojiOverride(key, value);
            }
            return interaction.reply({ embeds: [ui.okEmbed('📥 Emoji Snapshot Loaded', `Restored **${Object.keys(snapshot).length}** emoji values from snapshot \`${code}\`.`)] });
        }
        const name = interaction.options.getString('name').trim().toLowerCase();
        if (!ui.EMOJI_KEYS.includes(name)) {
            return interaction.reply({ embeds: [ui.errorEmbed('Unknown Emoji', `**${name}** is not a valid emoji name. Use **/emoji list** first.`)], ephemeral: true });
        }
        if (sub === 'set') {
            const value = interaction.options.getString('value').trim();
            if (!value)
                return interaction.reply({ embeds: [ui.errorEmbed('Invalid Emoji', 'The emoji value cannot be empty.')], ephemeral: true });
            db.setEmojiOverride(name, value);
            return interaction.reply({ embeds: [ui.okEmbed(`${ui.emoji('success')} Emoji Updated`, `**${name}** is now ${value}. All matching button icons and embed text use it immediately.`)] });
        }
        db.resetEmojiOverride(name);
        return interaction.reply({ embeds: [ui.okEmbed(`${ui.emoji('success')} Emoji Reset`, `**${name}** is back to its default: ${ui.DEFAULT_EMOJIS[name]}`)] });
    }
});
commands.push({
    ownerOnly: true,
    data: new SlashCommandBuilder().setName('em').setDescription('[Owner] Browse and edit AunXz embed text and emojis.')
        .addSubcommand(s => s.setName('list').setDescription('List registered embed texts and discovered emojis.'))
        .addSubcommand(s => s.setName('edit').setDescription('Edit one registered embed text.')
        .addStringOption(o => o.setName('name').setDescription('Name shown by /em list').setRequired(true).setAutocomplete(true))),
    async execute(interaction) {
        if (!isOwner(interaction.user.id))
            return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (sub === 'list')
            return interaction.reply({ embeds: [ui.embedTextsListEmbed(1)], components: ui.embedTextsListRows(1), ephemeral: true });
        const name = interaction.options.getString('name', true).trim();
        const row = db.getEmbedText(name);
        if (!row)
            return interaction.reply({ embeds: [ui.errorEmbed('Embed Not Found', `No registered embed named **${name}** exists. Run **/em list** first.`)], ephemeral: true });
        const { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
        const modal = new ModalBuilder().setCustomId(`em_edit_modal:${row.name}`).setTitle(`Edit ${row.name}`.slice(0, 45));
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(row.title || row.sourceTitle).slice(0, 256))), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue(String(row.description || '').slice(0, 4000))), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('footer').setLabel('Footer').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(row.footer || '').slice(0, 200))));
        return interaction.showModal(modal);
    }
});
commands.push({
    ownerOnly: true,
    data: new SlashCommandBuilder().setName('ms').setDescription('[Owner] Manage AunXz server memberships.')
        .addSubcommand(s => s.setName('add').setDescription('Add or extend a server membership.')
        .addStringOption(o => o.setName('server_id').setDescription('Discord server ID').setRequired(true))
        .addIntegerOption(o => o.setName('days').setDescription('Membership length in days').setMinValue(1).setMaxValue(3650))
        .addStringOption(o => o.setName('plan').setDescription('Plan label, for example 30 Days'))
        .addStringOption(o => o.setName('note').setDescription('Optional internal note')))
        .addSubcommand(s => s.setName('remove').setDescription('Remove a server membership.')
        .addStringOption(o => o.setName('server_id').setDescription('Discord server ID').setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('List all server memberships.')),
    async execute(interaction) {
        if (!isOwner(interaction.user.id))
            return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (sub === 'add') {
            const serverId = interaction.options.getString('server_id', true).trim();
            if (!/^\d{15,25}$/.test(serverId))
                return interaction.reply({ embeds: [ui.errorEmbed('Invalid Server ID', 'Enter a valid Discord server ID.')], ephemeral: true });
            const days = interaction.options.getInteger('days') || 30;
            const plan = interaction.options.getString('plan') || `${days} Days`;
            const note = interaction.options.getString('note') || '';
            const row = db.addMembership(serverId, { days, plan, note });
            return interaction.reply({ embeds: [ui.okEmbed('Membership Added', `**Server:** \`${serverId}\`\n**Plan:** ${row.plan}\n**Expires:** <t:${Math.floor(row.expiresAt / 1000)}:F> (<t:${Math.floor(row.expiresAt / 1000)}:R>)`)] });
        }
        if (sub === 'remove') {
            const serverId = interaction.options.getString('server_id', true).trim();
            db.removeMembership(serverId);
            return interaction.reply({ embeds: [ui.okEmbed('Membership Removed', `Membership for \`${serverId}\` has been removed.`)] });
        }
        return interaction.reply({ embeds: [ui.membershipListEmbed(db.listMemberships(), 1)], components: ui.membershipListRows(db.listMemberships(), 1), ephemeral: true });
    }
});
commands.push({
    ownerOnly: true,
    data: new SlashCommandBuilder().setName('ownerlogsetup').setDescription('[Owner] Configure global bot logs in the owner server.'),
    async execute(interaction) {
        if (!isOwner(interaction.user.id))
            return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
        const cfg = db.getOwnerConfig();
        return interaction.reply({ embeds: [ui.ownerLogSetupEmbed(cfg)], components: ui.ownerLogSetupRows(cfg), ephemeral: true });
    }
});
commands.push({
    data: new SlashCommandBuilder().setName('massrole').setDescription('Give a role to every human or every bot in the server.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
        .addSubcommand(s => s.setName('humans').setDescription('Assign a role to every non-bot member.')
        .addRoleOption(o => o.setName('role').setDescription('Role to assign').setRequired(true)))
        .addSubcommand(s => s.setName('bots').setDescription('Assign a role to every bot account.')
        .addRoleOption(o => o.setName('role').setDescription('Role to assign').setRequired(true))),
    async execute(interaction) {
        if (!interaction.guild)
            return interaction.reply({ embeds: [ui.errorEmbed('Server Only', 'Use this inside a server.')], ephemeral: true });
        const sub = interaction.options.getSubcommand();
        const role = interaction.options.getRole('role');
        const wantBots = sub === 'bots';
        const permissionError = actionPermissionError(interaction, PermissionFlagsBits.ManageRoles, 'Manage Roles');
        if (permissionError)
            return interaction.reply({ embeds: [permissionError], ephemeral: true });
        if (!role || role.id === interaction.guild.id)
            return interaction.reply({ embeds: [ui.errorEmbed('Invalid Role', '@everyone cannot be mass-assigned.')], ephemeral: true });
        if (role.managed)
            return interaction.reply({ embeds: [ui.errorEmbed('Invalid Role', `${role} is managed by an integration and cannot be assigned.`)], ephemeral: true });
        const bot = botMember(interaction);
        if (!bot || role.position >= bot.roles.highest.position)
            return interaction.reply({ embeds: [ui.errorEmbed('Role Hierarchy', `${role} is equal to or above my highest role. Move my role higher first.`)], ephemeral: true });
        if (interaction.member.id !== interaction.guild.ownerId && role.position >= interaction.member.roles.highest.position) {
            return interaction.reply({ embeds: [ui.errorEmbed('Role Hierarchy', `${role} is equal to or above your highest role.`)], ephemeral: true });
        }
        return askForConfirmation(interaction, {
            title: `Mass role → ${wantBots ? 'bots' : 'humans'}`,
            description: `Give ${role} to **every ${wantBots ? 'bot account' : 'non-bot member'}** that does not already have it?`,
            actionLabel: `massrole ${sub} ${role.name}`,
            run: async (confirmed) => {
                const guild = confirmed.guild;
                const { members } = await fetchAllMembers(guild);
                const targets = [...members.values()].filter(m => (wantBots ? m.user.bot : !m.user.bot) && !m.roles.cache.has(role.id));
                if (!targets.length)
                    return ui.infoEmbed('Nothing To Do', `Every ${wantBots ? 'bot' : 'human'} already has ${role}.`);
                let ok = 0, failed = 0;
                const started = Date.now();
                let stopped = false;
                for (let i = 0; i < targets.length; i += 5) {
                    if (Date.now() - started > 13 * 60 * 1000) {
                        stopped = true;
                        break;
                    }
                    const batch = targets.slice(i, i + 5);
                    const res = await Promise.allSettled(batch.map(m => m.roles.add(role, `massrole ${sub} by ${confirmed.user.tag}`)));
                    for (const r of res)
                        r.status === 'fulfilled' ? ok++ : failed++;
                    if ((i / 5) % 10 === 9)
                        await confirmed.editReply({ embeds: [ui.infoEmbed('⏳ Mass role running…', `${ok + failed}/${targets.length} processed (${ok} done, ${failed} failed).`)], components: [] }).catch(() => { });
                }
                const left = targets.length - ok - failed;
                return ui.okEmbed('✅ Mass role finished', `${role} → **${ok}** ${wantBots ? 'bot' : 'human'}(s) updated${failed ? `, **${failed}** failed (hierarchy/permissions)` : ''}.${stopped ? `\n⏱ Stopped early with **${left}** remaining — run the command again to continue.` : ''}`);
            }
        });
    }
});
commands.push(...require('./sticky').commands);
commands.push(...require('./greetmessage').commands);
commands.push(...require('./greetvoice').commands);
commands.push(...require('./settings').commands);
commands.push(...require('./ownertools').commands);
module.exports = { commands, isOwner, buildModulePatch, PANEL_MODULES, handleDangerousConfirmation };

};
__modules["database.js"] = function(module, exports, require, __filename, __dirname) {
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
function ensureParent(filePath) {
    const parent = path.dirname(filePath);
    if (!fs.existsSync(parent))
        fs.mkdirSync(parent, { recursive: true });
}
function resolveDatabasePath() {
    if (process.env.DATABASE_PATH)
        return path.resolve(process.env.DATABASE_PATH);
    const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
    if (volume)
        return path.join(path.resolve(volume), 'aunxz.sqlite');
    return path.join(__dirname, 'data', 'aunxz.sqlite');
}
const DB_PATH = resolveDatabasePath();
const DATA_DIR = path.dirname(DB_PATH);
ensureParent(DB_PATH);
function migrateLegacyDatabase(target) {
    if (fs.existsSync(target))
        return;
    const candidates = [
        path.join(__dirname, 'bot.sqlite'),
        path.join(__dirname, 'aunxz.sqlite'),
        path.join(__dirname, 'data', 'bot.sqlite')
    ];
    const source = candidates.find(file => file !== target && fs.existsSync(file));
    if (!source)
        return;
    try {
        const legacy = new Database(source);
        try {
            legacy.pragma('wal_checkpoint(TRUNCATE)');
        }
        catch { }
        try {
            legacy.close();
        }
        catch { }
        fs.copyFileSync(source, target);
        console.log(`[AunXz] Migrated legacy SQLite database to persistent path: ${target}`);
    }
    catch (error) {
        console.error('[AunXz] Legacy SQLite migration failed:', error);
    }
}
migrateLegacyDatabase(DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
function hasColumn(table, column) {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}
function addColumn(table, column, definition) {
    if (!hasColumn(table, column))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
db.exec(`
CREATE TABLE IF NOT EXISTS guild_config (
  guildId TEXT PRIMARY KEY,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS levels (
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 0,
  lastMessage INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guildId, userId)
);
CREATE TABLE IF NOT EXISTS warns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  moderatorId TEXT NOT NULL,
  reason TEXT,
  timestamp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  channelId TEXT PRIMARY KEY,
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  claimedBy TEXT,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS voicemaster_channels (
  channelId TEXT PRIMARY KEY,
  guildId TEXT NOT NULL,
  ownerId TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS voicemaster_profiles (
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  name TEXT,
  userLimit INTEGER,
  bitrate INTEGER,
  region TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guildId, userId)
);
CREATE TABLE IF NOT EXISTS antinuke_whitelist (
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  PRIMARY KEY (guildId, userId)
);
CREATE TABLE IF NOT EXISTS action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL,
  userId TEXT,
  type TEXT NOT NULL,
  detail TEXT,
  timestamp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sticky_roles (
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  roles TEXT NOT NULL,
  PRIMARY KEY (guildId, userId)
);
CREATE TABLE IF NOT EXISTS spam_tracker (
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  windowStart INTEGER NOT NULL,
  PRIMARY KEY (guildId, userId)
);
CREATE TABLE IF NOT EXISTS join_tracker (
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS emoji_overrides (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS emoji_snapshots (
  code TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS embed_texts (
  name TEXT PRIMARY KEY,
  sourceTitle TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  footer TEXT NOT NULL DEFAULT '',
  uses INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS memberships (
  guildId TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT '30 Days',
  durationDays INTEGER NOT NULL DEFAULT 30,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL,
  hostId TEXT NOT NULL,
  prize TEXT NOT NULL,
  winners INTEGER NOT NULL DEFAULT 1,
  durationMs INTEGER NOT NULL DEFAULT 0,
  endsAt INTEGER NOT NULL DEFAULT 0,
  channelId TEXT,
  messageId TEXT,
  participants TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'configuring',
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_embeds (
  guildId TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (guildId, name)
);
`);
addColumn('giveaways', 'durationMs', 'INTEGER NOT NULL DEFAULT 0');
addColumn('giveaways', 'endsAt', 'INTEGER NOT NULL DEFAULT 0');
addColumn('giveaways', 'messageId', 'TEXT');
addColumn('giveaways', 'participants', "TEXT NOT NULL DEFAULT '[]'");
addColumn('giveaways', 'status', "TEXT NOT NULL DEFAULT 'configuring'");
addColumn('giveaways', 'createdAt', 'INTEGER NOT NULL DEFAULT 0');
addColumn('giveaways', 'winnerIds', "TEXT NOT NULL DEFAULT '[]'");
db.exec(`
CREATE TABLE IF NOT EXISTS sticky_messages (
  guildId TEXT NOT NULL,
  channelId TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  lastMessageId TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  createdBy TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (guildId, channelId)
);
CREATE INDEX IF NOT EXISTS idx_sticky_channel ON sticky_messages(channelId);
CREATE TABLE IF NOT EXISTS staff_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  answers TEXT NOT NULL DEFAULT '[]',
  channelId TEXT,
  messageId TEXT,
  reviewerId TEXT,
  reason TEXT,
  createdAt INTEGER NOT NULL,
  decidedAt INTEGER
);
CREATE TABLE IF NOT EXISTS owner_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT NOT NULL,
  command TEXT NOT NULL,
  args TEXT,
  guildId TEXT,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT,
  command TEXT,
  guildId TEXT,
  userId TEXT,
  message TEXT,
  stack TEXT
);
CREATE TABLE IF NOT EXISTS command_usage (
  day TEXT NOT NULL,
  guildId TEXT NOT NULL,
  name TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  fail INTEGER NOT NULL DEFAULT 0,
  lastUsed INTEGER NOT NULL,
  PRIMARY KEY (day, guildId, name)
);
CREATE TABLE IF NOT EXISTS command_toggles (
  name TEXT PRIMARY KEY,
  reason TEXT,
  byId TEXT,
  at INTEGER NOT NULL
);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS server_templates (
  code TEXT PRIMARY KEY,
  guildId TEXT NOT NULL,
  guildName TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL,
  createdBy TEXT,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_sessions (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  deviceId TEXT,
  meta TEXT,
  createdAt INTEGER NOT NULL,
  lastActiveAt INTEGER NOT NULL,
  expiresAt INTEGER,
  revokedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_owner_sessions_user ON owner_sessions(userId);
CREATE TABLE IF NOT EXISTS owner_devices (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  platform TEXT,
  pushToken TEXT,
  createdAt INTEGER NOT NULL,
  lastSeenAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_devices_user ON owner_devices(userId);
CREATE TABLE IF NOT EXISTS owner_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT NOT NULL,
  deviceId TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ts INTEGER NOT NULL
);
`);
const DEFAULT_CONFIG = {
    prefix: '!',
    logs: { enabled: true, mod: null, message: null, member: null, voice: null, antinuke: null, server: null, ticket: null, join: null, detailMode: 'detailed', contentLogging: true, evidenceRetentionDays: 7, ignoreBots: false, ignoredChannelIds: [], ignoredUserIds: [], ignoredRoleIds: [], events: { messageCreate: false, messageDelete: true, messageUpdate: true, bulkDelete: true, memberJoin: true, memberLeave: true, memberUpdate: true, memberRoles: true, roleCreate: true, roleDelete: true, roleUpdate: true, channelCreate: true, channelDelete: true, channelUpdate: true, guildUpdate: true, banAdd: true, banRemove: true, voiceStateUpdate: true, inviteCreate: true, inviteDelete: true } },
    welcome: { enabled: false, channel: null, message: 'Welcome {user} to {server}! You are member #{count}.', autoroleId: null },
    leave: { enabled: false, channel: null, message: '{user} has left the server.' },
    boost: { enabled: false, channel: null, message: '{user} just boosted the server! 🚀' },
    greetvoice: { enabled: false, roleId: null, vcId: null, ttsPrompt: null, ttsVoice: 'us', audioPath: null, mode: 'tts', cooldownSeconds: 30 },
    greetmessage: { enabled: false, channelId: null, message: 'Welcome {user}!', image: null, title: '👋 Welcome!', color: null, showAvatar: true, ping: true },
    antinuke: {
        enabled: false, punishment: 'ban', maxChannelDeletes: 3, maxChannelCreates: 5, maxRoleDeletes: 3, maxRoleCreates: 5,
        maxBans: 3, maxKicks: 3, maxWebhookCreates: 3, maxRoleUpdates: 5, windowSeconds: 10, protectOwner: true
    },
    antilink: { enabled: false, mode: 'delete', whitelistedDomains: ['discord.gg', 'discord.com/invite'], bypassRoleId: null, whitelistedChannels: [] },
    antispam: { enabled: false, maxMessages: 6, windowSeconds: 7, punishment: 'mute', muteMinutes: 5, maxMentions: 5, maxEmojis: 10 },
    antiraid: { enabled: false, joinThreshold: 8, windowSeconds: 10, action: 'lockdown', minAccountAgeDays: 3 },
    antiwebhook: { enabled: false, action: 'delete', bypassRoleId: null, logChannelId: null },
    antibot: { enabled: false, action: 'kick', bypassRoleId: null, logChannelId: null },
    antialt: { enabled: false, action: 'kick', minAccountAgeDays: 3, logChannelId: null },
    voicemaster: { enabled: false, hubChannelId: null, categoryId: null, nameTemplate: "{user}'s room", interfaceChannelId: null, interfaceMessageId: null, defaultLimit: 0, defaultBitrate: null, profilesEnabled: true },
    leveling: { enabled: false, channel: null, xpPerMessage: 15, cooldownSeconds: 60, levelUpMessage: '{user} reached level {level}!', roleRewards: {} },
    ticket: { enabled: false, categoryId: null, panelChannelId: null, supportRoleId: null, logChannelId: null, counter: 0, panelTitle: null, panelDescription: null, panelThumbnail: null, panelImage: null, categoryLabel: 'General Support', welcomeMessage: 'Our support team will assist you shortly.', welcomeThumbnail: null, welcomeImage: null },
    automod: { enabled: true, badWordFilter: false, badWords: [], capsFilter: false, capsThreshold: 70, inviteFilter: false },
    antibadword: { enabled: false, words: [], customWords: [] },
    autoresponder: { enabled: false, ignoreCase: true, triggers: [] },
    autoreactor: { enabled: false, ignoreCase: true, triggers: [] },
    afk: {},
    autorole: { enabled: false, roleId: null, target: 'everyone' },
    reactionRoles: { enabled: true },
    reactionRolePanels: [],
    buttonRolePanels: [],
    suggestions: { enabled: false, channelId: null },
    polls: { enabled: true },
    snipeEnabled: true,
    nsfwFilter: { enabled: false },
    birthdays: { enabled: false, panelChannelId: null, wishChannelId: null, wishMessage: 'Happy Birthday {user}! 🎂', entries: {} },
    starboard: { enabled: false, channelId: null, threshold: 3 },
    inviteTracker: { enabled: false },
    staffApplications: { enabled: false, panelChannelId: null, logChannelId: null, questions: [], title: 'Staff Applications', description: 'Click Apply to start your application.', dmIntro: 'Are you ready to start your staff application?', applicantRoleId: null, acceptedRoleId: null, cooldownHours: 24, acceptMessage: 'Congratulations! Your application was accepted.', denyMessage: 'Thank you for applying. Your application was not accepted this time.' },
    honeypot: { enabled: true, channelId: null, action: 'kick', cleanupWindow: 'none', createInvite: false, dmMessage: 'You were removed for posting in the honeypot channel. {invite}', logChannelId: null, whitelistRoleIds: [] },
    maintenance: false,
    blacklist: []
};
function deepMerge(base, override) {
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const k of Object.keys(override || {})) {
        if (override[k] && typeof override[k] === 'object' && !Array.isArray(override[k]) && base[k] && typeof base[k] === 'object')
            out[k] = deepMerge(base[k], override[k]);
        else
            out[k] = override[k];
    }
    return out;
}
const getConfigStmt = db.prepare('SELECT data FROM guild_config WHERE guildId = ?');
const upsertConfigStmt = db.prepare('INSERT INTO guild_config (guildId, data) VALUES (@guildId, @data) ON CONFLICT(guildId) DO UPDATE SET data = @data');
function getConfig(guildId) {
    const row = getConfigStmt.get(guildId);
    let stored = {};
    try {
        stored = row ? JSON.parse(row.data) : {};
    }
    catch {
        stored = {};
    }
    return deepMerge(DEFAULT_CONFIG, stored);
}
function saveConfig(guildId, partial) {
    const merged = deepMerge(getConfig(guildId), partial || {});
    upsertConfigStmt.run({ guildId, data: JSON.stringify(merged) });
    return merged;
}
const getLevelStmt = db.prepare('SELECT * FROM levels WHERE guildId = ? AND userId = ?');
const upsertLevelStmt = db.prepare('INSERT INTO levels (guildId, userId, xp, level, lastMessage) VALUES (?, ?, ?, ?, ?) ON CONFLICT(guildId, userId) DO UPDATE SET xp=excluded.xp, level=excluded.level, lastMessage=excluded.lastMessage');
const topLevelsStmt = db.prepare('SELECT * FROM levels WHERE guildId = ? ORDER BY xp DESC LIMIT ?');
function getLevel(guildId, userId) { return getLevelStmt.get(guildId, userId) || { guildId, userId, xp: 0, level: 0, lastMessage: 0 }; }
function setLevel(guildId, userId, xp, level, lastMessage) { upsertLevelStmt.run(guildId, userId, xp, level, lastMessage); }
function topLevels(guildId, limit = 10) { return topLevelsStmt.all(guildId, limit); }
const addWarnStmt = db.prepare('INSERT INTO warns (guildId,userId,moderatorId,reason,timestamp) VALUES (?,?,?,?,?)');
const getWarnsStmt = db.prepare('SELECT * FROM warns WHERE guildId=? AND userId=? ORDER BY timestamp DESC');
const clearWarnsStmt = db.prepare('DELETE FROM warns WHERE guildId=? AND userId=?');
function addWarn(guildId, userId, moderatorId, reason) { addWarnStmt.run(guildId, userId, moderatorId, reason, Date.now()); }
function getWarns(guildId, userId) { return getWarnsStmt.all(guildId, userId); }
function clearWarns(guildId, userId) { clearWarnsStmt.run(guildId, userId); }
const createTicketStmt = db.prepare('INSERT INTO tickets(channelId,guildId,userId,status,createdAt) VALUES (?,?,?,?,?)');
function createTicket(channelId, guildId, userId) { createTicketStmt.run(channelId, guildId, userId, 'open', Date.now()); }
function getTicket(channelId) { return db.prepare('SELECT * FROM tickets WHERE channelId=?').get(channelId); }
function setTicketStatus(channelId, status, claimedBy = null) { db.prepare('UPDATE tickets SET status=?, claimedBy=? WHERE channelId=?').run(status, claimedBy, channelId); }
function closeTicket(channelId) { db.prepare("UPDATE tickets SET status='closed' WHERE channelId=?").run(channelId); }
function openTicketsForUser(guildId, userId) { return db.prepare("SELECT * FROM tickets WHERE guildId=? AND userId=? AND status='open'").all(guildId, userId); }
function addVMChannel(channelId, guildId, ownerId) { db.prepare('INSERT OR REPLACE INTO voicemaster_channels(channelId,guildId,ownerId) VALUES (?,?,?)').run(channelId, guildId, ownerId); }
function getVMChannel(channelId) { return db.prepare('SELECT * FROM voicemaster_channels WHERE channelId=?').get(channelId); }
function removeVMChannel(channelId) { db.prepare('DELETE FROM voicemaster_channels WHERE channelId=?').run(channelId); }
function listVMChannels() { return db.prepare('SELECT * FROM voicemaster_channels').all(); }
function getVMChannelsByOwner(guildId, ownerId) { return db.prepare('SELECT * FROM voicemaster_channels WHERE guildId=? AND ownerId=?').all(guildId, ownerId); }
function getVMProfile(guildId, userId) { return db.prepare('SELECT * FROM voicemaster_profiles WHERE guildId=? AND userId=?').get(guildId, userId) || null; }
function saveVMProfile(guildId, userId, p) {
    db.prepare('INSERT INTO voicemaster_profiles(guildId,userId,name,userLimit,bitrate,region,locked,hidden,updatedAt) VALUES (?,?,?,?,?,?,?,?,?) ' +
        'ON CONFLICT(guildId,userId) DO UPDATE SET name=excluded.name,userLimit=excluded.userLimit,bitrate=excluded.bitrate,region=excluded.region,locked=excluded.locked,hidden=excluded.hidden,updatedAt=excluded.updatedAt')
        .run(guildId, userId, p.name || null, p.userLimit ?? null, p.bitrate ?? null, p.region || null, p.locked ? 1 : 0, p.hidden ? 1 : 0, Date.now());
}
function deleteVMProfile(guildId, userId) { return db.prepare('DELETE FROM voicemaster_profiles WHERE guildId=? AND userId=?').run(guildId, userId).changes > 0; }
function addToWhitelist(guildId, userId) { db.prepare('INSERT OR IGNORE INTO antinuke_whitelist(guildId,userId) VALUES (?,?)').run(guildId, userId); }
function removeFromWhitelist(guildId, userId) { db.prepare('DELETE FROM antinuke_whitelist WHERE guildId=? AND userId=?').run(guildId, userId); }
function isWhitelisted(guildId, userId) { return !!db.prepare('SELECT 1 FROM antinuke_whitelist WHERE guildId=? AND userId=?').get(guildId, userId); }
function logAction(guildId, userId, type, detail) { db.prepare('INSERT INTO action_log(guildId,userId,type,detail,timestamp) VALUES (?,?,?,?,?)').run(guildId, userId, type, detail, Date.now()); }
function recentActions(guildId, limit = 15) { return db.prepare('SELECT * FROM action_log WHERE guildId=? ORDER BY timestamp DESC LIMIT ?').all(guildId, limit); }
function getStickyRoles(guildId, userId) { const r = db.prepare('SELECT roles FROM sticky_roles WHERE guildId=? AND userId=?').get(guildId, userId); try {
    return r ? JSON.parse(r.roles) : [];
}
catch {
    return [];
} }
function setStickyRoles(guildId, userId, roles) { db.prepare('INSERT INTO sticky_roles(guildId,userId,roles) VALUES (?,?,?) ON CONFLICT(guildId,userId) DO UPDATE SET roles=excluded.roles').run(guildId, userId, JSON.stringify(roles)); }
function bumpSpam(guildId, userId, windowSeconds) { const now = Date.now(); const r = db.prepare('SELECT * FROM spam_tracker WHERE guildId=? AND userId=?').get(guildId, userId); if (!r || now - r.windowStart > windowSeconds * 1000) {
    db.prepare('INSERT OR REPLACE INTO spam_tracker(guildId,userId,count,windowStart) VALUES (?,?,?,?)').run(guildId, userId, 1, now);
    return 1;
} const n = r.count + 1; db.prepare('UPDATE spam_tracker SET count=? WHERE guildId=? AND userId=?').run(n, guildId, userId); return n; }
function trackJoin(guildId, userId) { db.prepare('INSERT INTO join_tracker(guildId,userId,timestamp) VALUES (?,?,?)').run(guildId, userId, Date.now()); }
function recentJoinCount(guildId, windowSeconds) { return db.prepare('SELECT COUNT(*) c FROM join_tracker WHERE guildId=? AND timestamp>?').get(guildId, Date.now() - windowSeconds * 1000).c; }
function getEmojiOverride(name) { return db.prepare('SELECT value FROM emoji_overrides WHERE name=?').get(name)?.value || null; }
function setEmojiOverride(name, value) { db.prepare('INSERT INTO emoji_overrides(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name, value); }
function resetEmojiOverride(name) { db.prepare('DELETE FROM emoji_overrides WHERE name=?').run(name); }
function getAllEmojiOverrides() { const out = {}; for (const r of db.prepare('SELECT name,value FROM emoji_overrides').all())
    out[r.name] = r.value; return out; }
function saveEmojiSnapshot(values) { const code = 'EM-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase(); db.prepare('INSERT INTO emoji_snapshots(code,data,createdAt) VALUES (?,?,?)').run(code, JSON.stringify(values || {}), Date.now()); return code; }
function getEmojiSnapshot(code) { const r = db.prepare('SELECT data FROM emoji_snapshots WHERE code=?').get(String(code || '').trim()); if (!r)
    return null; try {
    return JSON.parse(r.data);
}
catch {
    return null;
} }
function applyEmojiSnapshot(values = {}) { const tx = db.transaction(obj => { for (const [key, value] of Object.entries(obj || {})) {
    if (value === undefined || value === null || value === '')
        continue;
    db.prepare('INSERT INTO emoji_overrides(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(String(key), String(value));
} }); tx(values); return getAllEmojiOverrides(); }
function slugifyEmbedName(sourceTitle) {
    return String(sourceTitle || 'embed').replace(/<@!?\d+>/g, '@user').replace(/\d{15,25}/g, 'id').replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 70) || 'embed';
}
function registerEmbedText(sourceTitle, description = '', footer = '') {
    const name = slugifyEmbedName(sourceTitle);
    const existing = db.prepare('SELECT * FROM embed_texts WHERE name=?').get(name);
    if (existing) {
        db.prepare('UPDATE embed_texts SET sourceTitle=?, uses=uses+1, updatedAt=? WHERE name=?').run(String(sourceTitle), Date.now(), name);
        return existing;
    }
    db.prepare('INSERT INTO embed_texts(name,sourceTitle,title,description,footer,uses,updatedAt) VALUES (?,?,?,?,?,?,?)').run(name, String(sourceTitle), String(sourceTitle), String(description || ''), String(footer || ''), 1, Date.now());
    return db.prepare('SELECT * FROM embed_texts WHERE name=?').get(name);
}
function getEmbedText(name) { return db.prepare('SELECT * FROM embed_texts WHERE lower(name)=lower(?) OR lower(sourceTitle)=lower(?) LIMIT 1').get(name, name) || null; }
function listEmbedTexts(limit = 500) { return db.prepare('SELECT * FROM embed_texts ORDER BY updatedAt DESC LIMIT ?').all(limit); }
function updateEmbedText(name, patch) {
    const row = getEmbedText(name);
    if (!row)
        return null;
    const next = { title: patch.title ?? row.title, description: patch.description ?? row.description, footer: patch.footer ?? row.footer };
    db.prepare('UPDATE embed_texts SET title=?,description=?,footer=?,updatedAt=? WHERE name=?').run(next.title, next.description, next.footer, Date.now(), row.name);
    return db.prepare('SELECT * FROM embed_texts WHERE name=?').get(row.name);
}
function getOwnerConfig() { const r = db.prepare('SELECT data FROM owner_config WHERE id=1').get(); if (!r)
    return {}; try {
    return JSON.parse(r.data) || {};
}
catch {
    return {};
} }
function saveOwnerConfig(partial) { const current = getOwnerConfig(); const merged = deepMerge(current, partial || {}); db.prepare('INSERT INTO owner_config(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(merged)); return merged; }
function getGlobalBlacklist() { const ids = getOwnerConfig().blacklistedGuildOwnerIds; return [...new Set((Array.isArray(ids) ? ids : []).map(x => String(x).trim()).filter(x => /^\d{15,25}$/.test(x)))]; }
function addGlobalBlacklist(userId) { const id = String(userId || '').trim(); if (!/^\d{15,25}$/.test(id))
    throw new Error('Enter a valid Discord user ID.'); const ids = getGlobalBlacklist(); if (!ids.includes(id))
    ids.push(id); saveOwnerConfig({ blacklistedGuildOwnerIds: ids }); return ids; }
function removeGlobalBlacklist(userId) { const id = String(userId || '').trim(); const ids = getGlobalBlacklist().filter(x => x !== id); saveOwnerConfig({ blacklistedGuildOwnerIds: ids }); return ids; }
function membership(guildId) { return db.prepare('SELECT * FROM memberships WHERE guildId=?').get(guildId) || null; }
function addMembership(guildId, { days = 30, plan = null, note = '' } = {}) { const n = Math.max(1, Number(days) || 30); const now = Date.now(); const old = membership(guildId); const start = old && old.expiresAt > now ? old.expiresAt : now; const expires = start + n * 86400000; const label = plan || `${n} Days`; db.prepare('INSERT INTO memberships(guildId,plan,durationDays,createdAt,expiresAt,note) VALUES(?,?,?,?,?,?) ON CONFLICT(guildId) DO UPDATE SET plan=excluded.plan,durationDays=excluded.durationDays,createdAt=excluded.createdAt,expiresAt=excluded.expiresAt,note=excluded.note').run(guildId, label, n, now, expires, String(note || '')); return membership(guildId); }
function removeMembership(guildId) { db.prepare('DELETE FROM memberships WHERE guildId=?').run(guildId); }
function listMemberships() { return db.prepare('SELECT * FROM memberships ORDER BY expiresAt DESC').all().map(r => ({ ...r, status: Date.now() < r.expiresAt ? 'active' : 'expired' })); }
function createGiveaway(guildId, hostId, opts = {}) { const info = { prize: String(opts.prize || 'Giveaway'), winners: Math.max(1, Number(opts.winners) || 1), durationMs: Number(opts.durationMs) || 0, endsAt: Number(opts.endsAt) || 0, channelId: opts.channelId || null, createdAt: Date.now() }; const q = db.prepare('INSERT INTO giveaways(guildId,hostId,prize,winners,durationMs,endsAt,channelId,status,createdAt) VALUES (?,?,?,?,?,?,?,?,?)'); const result = q.run(guildId, hostId, info.prize, info.winners, info.durationMs, info.endsAt, info.channelId, 'configuring', info.createdAt); return getGiveaway(guildId, result.lastInsertRowid); }
function getGiveaway(guildId, id) { return db.prepare('SELECT * FROM giveaways WHERE guildId=? AND id=?').get(guildId, Number(id)); }
function listGiveaways(guildId, limit = 50) { return db.prepare('SELECT * FROM giveaways WHERE guildId=? ORDER BY id DESC LIMIT ?').all(guildId, limit); }
function updateGiveaway(guildId, id, patch) { const row = getGiveaway(guildId, id); if (!row)
    return null; const next = { ...row, ...patch, participants: patch.participants ?? row.participants }; const fields = ['prize', 'winners', 'durationMs', 'endsAt', 'channelId', 'messageId', 'participants', 'status', 'winnerIds']; const set = fields.filter(k => Object.prototype.hasOwnProperty.call(patch, k)).map(k => `${k}=?`).join(','); if (set)
    db.prepare(`UPDATE giveaways SET ${set} WHERE guildId=? AND id=?`).run(...fields.filter(k => Object.prototype.hasOwnProperty.call(patch, k)).map(k => next[k]), guildId, Number(id)); return getGiveaway(guildId, id); }
function saveEmbed(guildId, name, data) { const now = Date.now(); db.prepare('INSERT INTO saved_embeds(guildId,name,data,createdAt,updatedAt) VALUES(?,?,?,?,?) ON CONFLICT(guildId,name) DO UPDATE SET data=excluded.data,updatedAt=excluded.updatedAt').run(guildId, name, JSON.stringify(data), now, now); return getEmbed(guildId, name); }
function getEmbed(guildId, name) { const r = db.prepare('SELECT * FROM saved_embeds WHERE guildId=? AND lower(name)=lower(?)').get(guildId, name); if (!r)
    return null; try {
    return { ...r, data: JSON.parse(r.data) };
}
catch {
    return null;
} }
function listEmbeds(guildId) { return db.prepare('SELECT * FROM saved_embeds WHERE guildId=? ORDER BY updatedAt DESC').all(guildId).map(r => { try {
    return { ...r, data: JSON.parse(r.data) };
}
catch {
    return r;
} }); }
function deleteEmbed(guildId, name) { return db.prepare('DELETE FROM saved_embeds WHERE guildId=? AND lower(name)=lower(?)').run(guildId, name).changes > 0; }
function panelArrayKey(kind) { return kind === 'button' ? 'buttonRolePanels' : 'reactionRolePanels'; }
function findPanel(guildId, kind, panelId) { const arr = getConfig(guildId)[panelArrayKey(kind)] || []; return arr.find(p => p.id === panelId) || null; }
function upsertPanel(guildId, kind, panel) { const key = panelArrayKey(kind); const arr = [...(getConfig(guildId)[key] || [])]; const i = arr.findIndex(p => p.id === panel.id); if (i >= 0)
    arr[i] = panel;
else
    arr.push(panel); return saveConfig(guildId, { [key]: arr })[key].find(p => p.id === panel.id); }
function removePanel(guildId, kind, panelId) { const key = panelArrayKey(kind); return saveConfig(guildId, { [key]: (getConfig(guildId)[key] || []).filter(p => p.id !== panelId) })[key]; }
function parseJSON(text, fallback) { try {
    const v = JSON.parse(text);
    return v ?? fallback;
}
catch {
    return fallback;
} }
function stickyRow(r) { return r ? { ...r, enabled: !!r.enabled, data: parseJSON(r.data, {}) } : null; }
const getStickyByChannelStmt = db.prepare('SELECT * FROM sticky_messages WHERE channelId = ?');
function getSticky(channelId) { return stickyRow(getStickyByChannelStmt.get(String(channelId))); }
function listStickies(guildId) { return db.prepare('SELECT * FROM sticky_messages WHERE guildId = ? ORDER BY createdAt ASC').all(guildId).map(stickyRow); }
function saveSticky(guildId, channelId, { data, enabled = true, createdBy = null } = {}) {
    const now = Date.now();
    db.prepare(`INSERT INTO sticky_messages (guildId, channelId, data, enabled, createdBy, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(guildId, channelId) DO UPDATE SET data = excluded.data, enabled = excluded.enabled, updatedAt = excluded.updatedAt`)
        .run(guildId, channelId, JSON.stringify(data || {}), enabled ? 1 : 0, createdBy, now, now);
    return getSticky(channelId);
}
function setStickyMessageId(channelId, messageId) { db.prepare('UPDATE sticky_messages SET lastMessageId = ?, updatedAt = ? WHERE channelId = ?').run(messageId || null, Date.now(), channelId); }
function setStickyEnabled(channelId, enabled) { db.prepare('UPDATE sticky_messages SET enabled = ?, updatedAt = ? WHERE channelId = ?').run(enabled ? 1 : 0, Date.now(), channelId); return getSticky(channelId); }
function deleteSticky(channelId) { return db.prepare('DELETE FROM sticky_messages WHERE channelId = ?').run(channelId).changes > 0; }
function appRow(r) { return r ? { ...r, answers: parseJSON(r.answers, []) } : null; }
function createApplication(guildId, userId, answers) {
    const res = db.prepare('INSERT INTO staff_applications (guildId,userId,status,answers,createdAt) VALUES (?,?,?,?,?)').run(guildId, userId, 'pending', JSON.stringify(answers || []), Date.now());
    return getApplication(res.lastInsertRowid);
}
function getApplication(id) { return appRow(db.prepare('SELECT * FROM staff_applications WHERE id = ?').get(Number(id))); }
function pendingApplicationForUser(guildId, userId) { return appRow(db.prepare("SELECT * FROM staff_applications WHERE guildId=? AND userId=? AND status='pending' ORDER BY id DESC LIMIT 1").get(guildId, userId)); }
function lastApplicationForUser(guildId, userId) { return appRow(db.prepare('SELECT * FROM staff_applications WHERE guildId=? AND userId=? ORDER BY id DESC LIMIT 1').get(guildId, userId)); }
function updateApplication(id, patch) {
    const allowed = ['status', 'channelId', 'messageId', 'reviewerId', 'reason', 'decidedAt'];
    const keys = Object.keys(patch || {}).filter(k => allowed.includes(k));
    if (keys.length)
        db.prepare(`UPDATE staff_applications SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k => patch[k]), Number(id));
    return getApplication(id);
}
function logOwnerAudit(userId, command, args, guildId) {
    db.prepare('INSERT INTO owner_audit (userId,command,args,guildId,ts) VALUES (?,?,?,?,?)').run(String(userId), String(command), String(args || '').slice(0, 500), guildId ? String(guildId) : null, Date.now());
    db.prepare('DELETE FROM owner_audit WHERE id NOT IN (SELECT id FROM owner_audit ORDER BY id DESC LIMIT 1000)').run();
}
function createOwnerSession(userId, { deviceId = null, ttlMs = 30 * 24 * 60 * 60 * 1000, meta = null } = {}) {
    const id = require('crypto').randomBytes(32).toString('hex');
    const now = Date.now();
    db.prepare('INSERT INTO owner_sessions (id,userId,deviceId,meta,createdAt,lastActiveAt,expiresAt) VALUES (?,?,?,?,?,?,?)')
        .run(id, String(userId), deviceId ? String(deviceId) : null, meta ? JSON.stringify(meta) : null, now, now, ttlMs ? now + ttlMs : null);
    return id;
}
function getOwnerSession(id) {
    if (!id) return null;
    const r = db.prepare('SELECT * FROM owner_sessions WHERE id=? AND revokedAt IS NULL').get(String(id));
    if (!r) return null;
    if (r.expiresAt && r.expiresAt < Date.now()) return null;
    return r;
}
function updateOwnerSessionActivity(id) { return db.prepare('UPDATE owner_sessions SET lastActiveAt=? WHERE id=? AND revokedAt IS NULL').run(Date.now(), String(id || '')).changes > 0; }
function revokeOwnerSession(id) { return db.prepare('UPDATE owner_sessions SET revokedAt=? WHERE id=? AND revokedAt IS NULL').run(Date.now(), String(id || '')).changes > 0; }
function revokeAllOwnerSessions(userId = null) {
    if (userId) return db.prepare('UPDATE owner_sessions SET revokedAt=? WHERE userId=? AND revokedAt IS NULL').run(Date.now(), String(userId)).changes;
    return db.prepare('UPDATE owner_sessions SET revokedAt=? WHERE revokedAt IS NULL').run(Date.now()).changes;
}
function registerOwnerDevice(userId, { id = null, name = '', platform = null, pushToken = null } = {}) {
    const deviceId = id ? String(id) : require('crypto').randomBytes(16).toString('hex');
    const now = Date.now();
    db.prepare('INSERT INTO owner_devices (id,userId,name,platform,pushToken,createdAt,lastSeenAt) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET userId=excluded.userId, name=excluded.name, platform=excluded.platform, pushToken=COALESCE(excluded.pushToken, owner_devices.pushToken), lastSeenAt=excluded.lastSeenAt')
        .run(deviceId, String(userId), String(name || ''), platform ? String(platform) : null, pushToken ? String(pushToken) : null, now, now);
    return getOwnerDevice(deviceId);
}
function getOwnerDevice(id) { return db.prepare('SELECT * FROM owner_devices WHERE id=?').get(String(id || '')) || null; }
function listOwnerDevices(userId = null) {
    if (userId) return db.prepare('SELECT * FROM owner_devices WHERE userId=? ORDER BY lastSeenAt DESC').all(String(userId));
    return db.prepare('SELECT * FROM owner_devices ORDER BY lastSeenAt DESC').all();
}
function savePushToken(deviceId, pushToken) { return db.prepare('UPDATE owner_devices SET pushToken=?, lastSeenAt=? WHERE id=?').run(pushToken ? String(pushToken) : null, Date.now(), String(deviceId || '')).changes > 0; }
function recordOwnerAction(userId, action, detail = null, deviceId = null) {
    db.prepare('INSERT INTO owner_actions (userId,deviceId,action,detail,ts) VALUES (?,?,?,?,?)')
        .run(String(userId), deviceId ? String(deviceId) : null, String(action), detail == null ? null : String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 2000), Date.now());
    db.prepare('DELETE FROM owner_actions WHERE id NOT IN (SELECT id FROM owner_actions ORDER BY id DESC LIMIT 1000)').run();
}
function listOwnerActions(limit = 50) { return db.prepare('SELECT * FROM owner_actions ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(500, Number(limit) || 50))); }
function recordError({ source = null, command = null, guildId = null, userId = null, message = '', stack = '' } = {}) {
    db.prepare('INSERT INTO error_log (ts,source,command,guildId,userId,message,stack) VALUES (?,?,?,?,?,?,?)')
        .run(Date.now(), source, command, guildId, userId, String(message || '').slice(0, 2000), String(stack || '').slice(0, 20000));
    db.prepare('DELETE FROM error_log WHERE id NOT IN (SELECT id FROM error_log ORDER BY id DESC LIMIT 200)').run();
}
function listErrors(command = null) {
    return command
        ? db.prepare('SELECT * FROM error_log WHERE lower(command)=lower(?) ORDER BY id DESC').all(command)
        : db.prepare('SELECT * FROM error_log ORDER BY id DESC').all();
}
function clearErrors(command = null) {
    return (command ? db.prepare('DELETE FROM error_log WHERE lower(command)=lower(?)').run(command) : db.prepare('DELETE FROM error_log').run()).changes;
}
function utcDay(ts = Date.now()) { return new Date(ts).toISOString().slice(0, 10); }
function trackCommandUse(name, guildId, ok) {
    const now = Date.now();
    db.prepare(`INSERT INTO command_usage (day,guildId,name,ok,fail,lastUsed) VALUES (?,?,?,?,?,?)
    ON CONFLICT(day,guildId,name) DO UPDATE SET ok = ok + excluded.ok, fail = fail + excluded.fail, lastUsed = excluded.lastUsed`)
        .run(utcDay(now), guildId || 'dm', String(name), ok ? 1 : 0, ok ? 0 : 1, now);
}
function commandUsage({ range = 'all', guildId = null } = {}) {
    const where = [];
    const args = [];
    if (range === 'today') {
        where.push('day = ?');
        args.push(utcDay());
    }
    else if (range === 'week') {
        where.push('day >= ?');
        args.push(utcDay(Date.now() - 6 * 86400000));
    }
    if (guildId) {
        where.push('guildId = ?');
        args.push(guildId);
    }
    return db.prepare(`SELECT name, SUM(ok) ok, SUM(fail) fail, MAX(lastUsed) lastUsed FROM command_usage ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY name ORDER BY (SUM(ok)+SUM(fail)) DESC`).all(...args);
}
function getToggle(name) { return db.prepare('SELECT * FROM command_toggles WHERE name = ?').get(String(name).toLowerCase()) || null; }
function listToggles() { return db.prepare('SELECT * FROM command_toggles ORDER BY at DESC').all(); }
function setToggle(name, reason, byId) { db.prepare('INSERT INTO command_toggles (name,reason,byId,at) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET reason=excluded.reason, byId=excluded.byId, at=excluded.at').run(String(name).toLowerCase(), reason || null, String(byId), Date.now()); }
function removeToggle(name) { return db.prepare('DELETE FROM command_toggles WHERE name = ?').run(String(name).toLowerCase()).changes > 0; }
function listWhitelist(guildId) { return db.prepare('SELECT userId FROM antinuke_whitelist WHERE guildId = ?').all(guildId).map(r => r.userId); }
function replaceConfig(guildId, data) {
    upsertConfigStmt.run({ guildId, data: JSON.stringify(data || {}) });
    return getConfig(guildId);
}
function newTemplateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 8; i++)
        out += chars[Math.floor(Math.random() * chars.length)];
    return 'AX-' + out;
}
function saveTemplate(guildId, guildName, data, createdBy) {
    let code = newTemplateCode();
    while (db.prepare('SELECT 1 FROM server_templates WHERE code=?').get(code))
        code = newTemplateCode();
    db.prepare('INSERT INTO server_templates(code,guildId,guildName,data,createdBy,createdAt) VALUES (?,?,?,?,?,?)').run(code, guildId, String(guildName || ''), data, createdBy || null, Date.now());
    return code;
}
function getTemplate(code) { return db.prepare('SELECT * FROM server_templates WHERE code=?').get(String(code || '').trim().toUpperCase()) || null; }
function listTemplates(guildId) { return db.prepare('SELECT code,guildId,guildName,createdBy,createdAt,length(data) AS size FROM server_templates WHERE guildId=? ORDER BY createdAt DESC').all(guildId); }
function deleteTemplate(code, guildId) { return db.prepare('DELETE FROM server_templates WHERE code=? AND guildId=?').run(String(code || '').trim().toUpperCase(), guildId).changes > 0; }
module.exports = {
    db, DB_PATH, DATA_DIR, DEFAULT_CONFIG, getConfig, saveConfig, replaceConfig, saveTemplate, getTemplate, listTemplates, deleteTemplate,
    getLevel, setLevel, topLevels, addWarn, getWarns, clearWarns,
    createTicket, getTicket, setTicketStatus, closeTicket, openTicketsForUser,
    addVMChannel, getVMChannel, removeVMChannel, listVMChannels, getVMChannelsByOwner, getVMProfile, saveVMProfile, deleteVMProfile,
    addToWhitelist, removeFromWhitelist, isWhitelisted, logAction, recentActions, getStickyRoles, setStickyRoles, bumpSpam, trackJoin, recentJoinCount,
    getEmojiOverride, setEmojiOverride, resetEmojiOverride, getAllEmojiOverrides, saveEmojiSnapshot, getEmojiSnapshot, applyEmojiSnapshot,
    registerEmbedText, getEmbedText, listEmbedTexts, updateEmbedText,
    getOwnerConfig, saveOwnerConfig, getGlobalBlacklist, addGlobalBlacklist, removeGlobalBlacklist, membership, addMembership, removeMembership, listMemberships,
    createGiveaway, getGiveaway, listGiveaways, updateGiveaway,
    saveEmbed, getEmbed, listEmbeds, deleteEmbed,
    findPanel, upsertPanel, removePanel,
    getSticky, listStickies, saveSticky, setStickyMessageId, setStickyEnabled, deleteSticky,
    createApplication, getApplication, pendingApplicationForUser, lastApplicationForUser, updateApplication,
    logOwnerAudit, recordError, listErrors, clearErrors, trackCommandUse, commandUsage, getToggle, listToggles, setToggle, removeToggle, listWhitelist,
    createOwnerSession, getOwnerSession, updateOwnerSessionActivity, revokeOwnerSession, revokeAllOwnerSessions,
    registerOwnerDevice, getOwnerDevice, listOwnerDevices, recordOwnerAction, listOwnerActions, savePushToken
};

};
__modules["embeds.js"] = function(module, exports, require, __filename, __dirname) {
const COLORS = {
    info: 0x5865F2,
    success: 0x57F287,
    warning: 0xFEE75C,
    error: 0xED4245
};
const BRAND_FOOTER = process.env.BRAND_FOOTER || 'AIO • all-in-one';
const defaultThumbnail = () => process.env.EMBED_THUMBNAIL_URL || process.env.BOT_AVATAR_URL || null;
function applySharedStyle(embed, kind = 'info') {
    embed.setColor(COLORS[kind] ?? COLORS.info);
    embed.setFooter({ text: BRAND_FOOTER });
    const thumb = defaultThumbnail();
    if (thumb && /^https?:\/\//i.test(thumb))
        embed.setThumbnail(thumb);
    return embed;
}
function getContainerBranding(d = {}) {
    const thumb = d.thumbnail?.url || defaultThumbnail();
    return {
        color: typeof d.color === 'number' ? d.color : COLORS.info,
        thumbnail: thumb && /^(https?:\/\/|attachment:\/\/)/i.test(thumb) ? thumb : null,
        footer: d.footer?.text || BRAND_FOOTER,
        timestamp: d.timestamp || Date.now()
    };
}
module.exports = { COLORS, BRAND_FOOTER, applySharedStyle, getContainerBranding };

};
__modules["greetmessage.js"] = function(module, exports, require, __filename, __dirname) {
const { SlashCommandBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const db = require('./database');
const ui = require('./ui');
const h = require('./helpers');
const cfgOf = gid => db.getConfig(gid).greetmessage;
const save = (gid, patch) => db.saveConfig(gid, { greetmessage: patch }).greetmessage;
const isAdmin = i => i.memberPermissions?.has(PermissionFlagsBits.Administrator) || i.member?.permissions?.has?.(PermissionFlagsBits.Administrator);
const render = (gid, notes = []) => { const c = cfgOf(gid); return { embeds: [ui.greetMessageSetupEmbed(c, notes)], components: ui.greetMessageSetupRow(c) }; };
function fill(text, user, guild) {
    return String(text || 'Welcome {user}!').replace(/{user}/g, `${user}`).replace(/{server}/g, guild.name).replace(/{count}/g, String(guild.memberCount));
}
function buildGreetPayload(guild, user, cfg, { test = false } = {}) {
    const e = ui.base(`${cfg.title || '👋 Welcome!'}${test ? ' (Preview)' : ''}`).setDescription(fill(cfg.message, user, guild));
    if (cfg.color)
        e.setColor(Number(cfg.color));
    if (cfg.showAvatar !== false && user.displayAvatarURL)
        e.setThumbnail(user.displayAvatarURL({ extension: 'png', size: 256 }));
    if (cfg.image)
        e.setImage(cfg.image);
    const payload = { embeds: [e] };
    if (cfg.ping !== false) {
        payload.content = `${user}`;
        payload.allowedMentions = { users: [user.id] };
    }
    return payload;
}
const command = {
    data: new SlashCommandBuilder().setName('greetmessagesetup').setDescription('Open the easy Greet Message setup panel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(i) {
        if (!i.guild)
            return h.safeReply(i, { embeds: [h.errorEmbed('Server only', 'Use this inside a server.')], ephemeral: true });
        if (!isAdmin(i))
            return h.safeReply(i, { embeds: [h.errorEmbed('Missing Permissions', 'You need **Administrator**.')], ephemeral: true });
        return h.safeReply(i, { ...render(i.guildId), ephemeral: true });
    }
};
async function handleInteraction(i) {
    const id = i.customId || '';
    if (!id.startsWith('greetmessage_cfg'))
        return false;
    const gid = i.guildId;
    try {
        if (!isAdmin(i)) {
            await i.reply({ embeds: [h.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
            return true;
        }
        if (i.isModalSubmit()) {
            const field = id.split(':')[1];
            let note = null;
            if (field === 'title') {
                const v = i.fields.getTextInputValue('value').trim().slice(0, 100);
                save(gid, { title: v || '👋 Welcome!' });
            }
            else if (field === 'color') {
                const raw = i.fields.getTextInputValue('value').trim();
                if (!raw)
                    save(gid, { color: null });
                else {
                    const c = h.parseHexColor(raw);
                    if (c === null)
                        note = '⚠️ Invalid color — use a hex code like `#5865F2`.';
                    else
                        save(gid, { color: c });
                }
            }
            if (i.message) {
                await i.deferUpdate();
                return void await i.editReply(render(gid, note ? [note] : []));
            }
            return void await i.reply({ ...render(gid, note ? [note] : []), ephemeral: true });
        }
        if (id === 'greetmessage_cfg:channel' && i.isChannelSelectMenu()) {
            await i.deferUpdate();
            save(gid, { channelId: i.values[0] });
            return void await i.editReply(render(gid));
        }
        if (id === 'greetmessage_cfg:option' && i.isStringSelectMenu()) {
            const opt = i.values[0];
            if (opt === 'title' || opt === 'color') {
                const c = cfgOf(gid);
                const input = new TextInputBuilder().setCustomId('value').setStyle(TextInputStyle.Short).setRequired(opt === 'title')
                    .setLabel(opt === 'title' ? 'Card title' : 'Accent color (hex, blank = default)').setMaxLength(100);
                const cur = opt === 'title' ? c.title : (c.color ? `#${Number(c.color).toString(16).padStart(6, '0')}` : '');
                if (cur)
                    input.setValue(String(cur).slice(0, 100));
                return void await i.showModal(new ModalBuilder().setCustomId(`greetmessage_cfg_modal:${opt}`).setTitle(opt === 'title' ? 'Greet Message Title' : 'Greet Message Color').addComponents(new ActionRowBuilder().addComponents(input)));
            }
            if (opt === 'message') {
                return void await h.startTextCapture(i, {
                    title: '💬 Send your welcome message', hint: 'Send the message text **below this panel**. Use `{user}`, `{server}` and `{count}`.',
                    maxLength: 1500, current: cfgOf(gid).message,
                    onSave: async (text) => { save(gid, { message: text }); },
                    render: () => render(gid, ['✅ Message saved.'])
                });
            }
            if (opt === 'image') {
                return void await h.startTextCapture(i, {
                    title: '🖼️ Send your image or GIF', hint: 'Upload an image/GIF **or** paste an image link as a message below.', accept: 'image',
                    onSave: async (v) => { save(gid, { image: typeof v === 'string' ? v : v.url }); },
                    render: () => render(gid, ['✅ Image saved.'])
                });
            }
            if (opt === 'clear_image') {
                await i.deferUpdate();
                save(gid, { image: null });
                return void await i.editReply(render(gid, ['🗑️ Image removed.']));
            }
            return true;
        }
        if (i.isButton()) {
            const action = id.split(':')[1];
            if (action === 'test') {
                await i.deferUpdate();
                const c = cfgOf(gid);
                const ch = i.channel;
                await ch.send(buildGreetPayload(i.guild, i.user, c, { test: true })).catch(() => { });
                return void await i.editReply(render(gid, ['👁️ Preview posted in this channel.']));
            }
            await i.deferUpdate();
            const c = cfgOf(gid);
            if (action === 'toggle') {
                if (!c.enabled && !c.channelId)
                    return void await i.editReply(render(gid, ['⚠️ Choose a welcome channel first.']));
                save(gid, { enabled: !c.enabled });
            }
            else if (action === 'ping')
                save(gid, { ping: c.ping === false });
            else if (action === 'avatar')
                save(gid, { showAvatar: c.showAvatar === false });
            else if (action === 'reset')
                save(gid, { ...db.DEFAULT_CONFIG.greetmessage });
            return void await i.editReply(render(gid));
        }
    }
    catch (e) {
        console.error('[GreetMessage] interaction failed:', e);
        await h.safeReply(i, { embeds: [h.errorEmbed('Greet Message error', String(e?.message || e).slice(0, 1200))], ephemeral: true });
    }
    return true;
}
module.exports = { commands: [command], handleInteraction, buildGreetPayload };

};
__modules["greetvoice.js"] = function(module, exports, require, __filename, __dirname) {
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const db = require('./database');
const ui = require('./ui');
const sys = require('./systems');
const h = require('./helpers');
const cfgOf = gid => db.getConfig(gid).greetvoice;
const save = (gid, patch) => db.saveConfig(gid, { greetvoice: patch }).greetvoice;
const VOICE_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];
const sync = (guild, cfg) => {
    const role = cfg.roleId && guild.roles.cache.get(cfg.roleId);
    if (cfg.enabled && role && cfg.vcId)
        sys.lockRoleToSingleChannel(guild, role, cfg.vcId).catch(e => console.error('[GreetVoice] role sync failed:', e?.message || e));
};
const panel = cfg => ui.greetVoiceSetupEmbed(cfg).addFields({ name: 'Cooldown', value: `${cfg.cooldownSeconds ?? 30}s per user`, inline: true });
const command = {
    data: new SlashCommandBuilder().setName('greetvoice').setDescription('Voice-channel greeting settings.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(s => s.setName('view').setDescription('Show current Greet Voice settings.'))
        .addSubcommand(s => s.setName('toggle').setDescription('Turn Greet Voice on or off.'))
        .addSubcommand(s => s.setName('channel').setDescription('Set the greeting voice channel.').addChannelOption(o => o.setName('channel').setDescription('Voice channel').setRequired(true).addChannelTypes(ChannelType.GuildVoice)))
        .addSubcommand(s => s.setName('role').setDescription('Set the optional gate role.').addRoleOption(o => o.setName('role').setDescription('Gate role').setRequired(true)))
        .addSubcommand(s => s.setName('message').setDescription('Set the spoken (TTS) greeting.').addStringOption(o => o.setName('text').setDescription('Text to speak (max 1000 chars)').setRequired(true)))
        .addSubcommand(s => s.setName('voice').setDescription('Choose the TTS voice / accent.').addStringOption(o => o.setName('voice').setDescription('Voice').setRequired(true).addChoices(...Object.entries(sys.TTS_VOICES).slice(0, 25).map(([value, v]) => ({ name: v.label, value })))))
        .addSubcommand(s => s.setName('audio').setDescription('Use an uploaded audio file as the greeting.').addAttachmentOption(o => o.setName('file').setDescription('mp3 / wav / ogg / m4a')))
        .addSubcommand(s => s.setName('test').setDescription('Play the greeting now to check it works.'))
        .addSubcommand(s => s.setName('reset').setDescription('Reset all Greet Voice settings.')),
    async execute(i) {
        if (!i.guild)
            return h.safeReply(i, { embeds: [h.errorEmbed('Server only', 'Use this inside a server.')], ephemeral: true });
        if (!i.member.permissions.has(PermissionFlagsBits.ManageGuild))
            return h.safeReply(i, { embeds: [h.errorEmbed('Missing permissions', 'You need **Manage Server**.')], ephemeral: true });
        const g = i.guild;
        const gid = g.id;
        const me = g.members.me;
        const sub = i.options.getSubcommand();
        const cfg = cfgOf(gid);
        const reply = (embed, extra = {}) => h.safeReply(i, { embeds: [embed], ephemeral: true, ...extra });
        if (sub === 'view')
            return reply(panel(cfg));
        if (sub === 'toggle') {
            if (!cfg.enabled) {
                if (!cfg.vcId)
                    return reply(h.errorEmbed('Cannot enable', 'Set a greeting voice channel first with `/greetvoice channel`.'));
                if (!cfg.ttsPrompt && !cfg.audioPath)
                    return reply(h.errorEmbed('Cannot enable', 'Set a greeting first: `/greetvoice message` or `/greetvoice audio`.'));
                const vc = g.channels.cache.get(cfg.vcId);
                if (!vc)
                    return reply(h.errorEmbed('Cannot enable', 'The saved voice channel was deleted. Pick a new one with `/greetvoice channel`.'));
                const missing = h.missingChannelPerms(vc, me, VOICE_PERMS);
                if (missing.length)
                    return reply(h.errorEmbed('Cannot enable', `I'm missing **${missing.join(', ')}** in ${vc}.`));
            }
            const next = save(gid, { enabled: !cfg.enabled });
            sync(g, next);
            return reply(panel(next).setColor(next.enabled ? ui.OK : ui.DANGER).setTitle(`${next.enabled ? 'Greet Voice enabled' : 'Greet Voice disabled'}`));
        }
        if (sub === 'channel') {
            const ch = i.options.getChannel('channel');
            if (!ch || ch.type !== ChannelType.GuildVoice)
                return reply(h.errorEmbed('Invalid channel', 'Choose a normal voice channel (not a stage or text channel).'));
            const missing = h.missingChannelPerms(ch, me, VOICE_PERMS);
            if (missing.length)
                return reply(h.errorEmbed('Missing permissions', `I need **${missing.join(', ')}** in ${ch}.`));
            const next = save(gid, { vcId: ch.id });
            sync(g, next);
            return reply(panel(next).setColor(ui.OK));
        }
        if (sub === 'role') {
            const role = i.options.getRole('role');
            if (!role || role.id === gid)
                return reply(h.errorEmbed('Invalid role', '`@everyone` cannot be the gate role.'));
            if (role.managed)
                return reply(h.errorEmbed('Invalid role', `${role} is managed by an integration.`));
            if (!me.permissions.has(PermissionFlagsBits.ManageRoles))
                return reply(h.errorEmbed('Missing permissions', 'I need **Manage Roles** to assign the gate role.'));
            if (role.position >= me.roles.highest.position)
                return reply(h.errorEmbed('Role hierarchy', `${role} is equal to or above my highest role. Move my role higher.`));
            const next = save(gid, { roleId: role.id });
            sync(g, next);
            return reply(panel(next).setColor(ui.OK));
        }
        if (sub === 'message') {
            const text = String(i.options.getString('text') || '').trim();
            if (!text)
                return reply(h.errorEmbed('Invalid text', 'The message cannot be empty.'));
            if (text.length > 1000)
                return reply(h.errorEmbed('Too long', `TTS text is limited to 1000 characters (you sent ${text.length}).`));
            if (cfg.audioPath)
                await sys.removeGreetvoiceAudio(cfg.audioPath);
            return reply(panel(save(gid, { ttsPrompt: text, audioPath: null, mode: 'tts' })).setColor(ui.OK));
        }
        if (sub === 'voice') {
            const key = i.options.getString('voice');
            if (!sys.TTS_VOICES[key])
                return reply(h.errorEmbed('Unknown voice', 'Pick one from the list.'));
            return reply(panel(save(gid, { ttsVoice: key })).setColor(ui.OK));
        }
        if (sub === 'audio') {
            const att = i.options.getAttachment?.('file');
            if (!att)
                return reply(h.errorEmbed('No file', 'Attach an audio file (mp3, wav, ogg, m4a…) to the command.'));
            if (isSlashLike(i))
                await i.deferReply({ ephemeral: true });
            try {
                const saved = await sys.saveGreetvoiceAudio(gid, att);
                return h.safeReply(i, { embeds: [panel(save(gid, { audioPath: saved, mode: 'audio' })).setColor(ui.OK)], ephemeral: true });
            }
            catch (e) {
                return h.safeReply(i, { embeds: [h.errorEmbed('Could not save audio', String(e?.message || e))], ephemeral: true });
            }
        }
        if (sub === 'test') {
            if (isSlashLike(i))
                await i.deferReply({ ephemeral: true });
            try {
                console.log(`[GreetVoice] test requested by ${i.user.id}`);
                await sys.playGreetvoiceGreeting(g, cfg);
                return h.safeReply(i, { embeds: [h.successEmbed('Greeting played', 'Playback finished without errors.')], ephemeral: true });
            }
            catch (e) {
                console.error('[GreetVoice] test failed:', e);
                return h.safeReply(i, { embeds: [h.errorEmbed('Greeting failed', `${String(e?.message || e).slice(0, 1200)}\n\nCheck: **Connect/Speak** in the channel, \`@discordjs/voice\` ≥ 0.19 with \`@snazzah/davey\`, and Node ≥ 22.12 (see the console for the dependency report).`)], ephemeral: true });
            }
        }
        if (sub === 'reset') {
            return h.safeReply(i, { embeds: [h.warnEmbed('Reset Greet Voice?', 'All Greet Voice settings (channel, role, message, audio) will be cleared and the feature disabled.')], components: [h.confirmRow(`gvreset:${i.user.id}`, { yes: 'Reset' })], ephemeral: true });
        }
    }
};
const isSlashLike = i => typeof i.fetchReply === 'function';
const isAdmin = i => i.memberPermissions?.has(PermissionFlagsBits.Administrator) || i.member?.permissions?.has?.(PermissionFlagsBits.Administrator);
const renderPanel = (gid, notes = []) => { const cfg = cfgOf(gid); return { embeds: [ui.greetVoiceSetupEmbed(cfg, notes)], components: ui.greetVoiceSetupRow(cfg) }; };
async function applyVoiceSetup(guild, cfg) {
    const notes = [];
    if (cfg.vcId) {
        try {
            const r = await sys.ensureBotInVC(guild, cfg.vcId);
            notes.push(r.joined ? `🔊 Joined ${r.channel}.` : `🔊 Already connected to ${r.channel}.`);
        }
        catch (e) {
            notes.push(`⚠️ Could not join the voice channel: ${e.message}`);
        }
    }
    const role = cfg.roleId && guild.roles.cache.get(cfg.roleId);
    if (role && cfg.vcId) {
        try {
            const r = await sys.lockRoleToSingleChannel(guild, role, cfg.vcId);
            notes.push(`🔒 ${role}: hid **${r.hidden}** channel(s), **${r.alreadyHidden}** already hidden, greeting VC visible.`);
            if (r.adminBypass)
                notes.push('⚠️ That role has **Administrator**, which ignores channel permissions. Remove it from the role.');
            if (r.failed.length)
                notes.push(`⚠️ ${r.failed.length} channel(s) could not be changed (check my Manage Channels/role position).`);
        }
        catch (e) {
            notes.push(`⚠️ Permission sweep failed: ${e.message}`);
        }
    }
    else if (!role)
        notes.push('ℹ️ Choose a gate role to lock it to the greeting channel.');
    return notes;
}
const setupCommand = {
    data: new SlashCommandBuilder().setName('greetvoicesetup').setDescription('Open the easy Greet Voice setup panel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(i) {
        if (!i.guild)
            return h.safeReply(i, { embeds: [h.errorEmbed('Server only', 'Use this inside a server.')], ephemeral: true });
        if (!isAdmin(i))
            return h.safeReply(i, { embeds: [h.errorEmbed('Missing Permissions', 'You need **Administrator**.')], ephemeral: true });
        if (isSlashLike(i))
            await i.deferReply({ ephemeral: true });
        const cfg = cfgOf(i.guildId);
        const notes = cfg.vcId || cfg.roleId ? await applyVoiceSetup(i.guild, cfg) : [];
        return h.safeReply(i, { ...renderPanel(i.guildId, notes), ephemeral: true });
    }
};
async function handleSetupInteraction(i) {
    const id = i.customId;
    const gid = i.guildId;
    const g = i.guild;
    if (!isAdmin(i)) {
        await i.reply({ embeds: [h.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
        return true;
    }
    const redraw = (notes = []) => i.editReply(renderPanel(gid, notes));
    if (id === 'greetvoice_cfg:voice' && i.isChannelSelectMenu()) {
        await i.deferUpdate();
        const cfg = save(gid, { vcId: i.values[0] });
        return void await redraw(await applyVoiceSetup(g, cfg));
    }
    if (id === 'greetvoice_cfg:role_select' && i.isRoleSelectMenu()) {
        const role = g.roles.cache.get(i.values[0]);
        const me = g.members.me;
        const bad = !role ? 'That role no longer exists.' : role.id === gid ? '@everyone cannot be the Greet Voice role.' : role.managed ? 'That role is managed by an integration.'
            : !me?.permissions.has(PermissionFlagsBits.ManageRoles) ? 'I need **Manage Roles**.' : role.position >= me.roles.highest.position ? `${role} is equal to or above my highest role — move my role higher.` : null;
        await i.deferUpdate();
        if (bad)
            return void await redraw([`⚠️ ${bad}`]);
        const cfg = save(gid, { roleId: role.id });
        return void await redraw(await applyVoiceSetup(g, cfg));
    }
    if (id === 'greetvoice_cfg:ttsvoice' && i.isStringSelectMenu()) {
        await i.deferUpdate();
        save(gid, { ttsVoice: i.values[0] });
        return void await redraw();
    }
    if (id === 'greetvoice_cfg:prompt') {
        return void await h.startTextCapture(i, {
            title: '✏️ Send your TTS prompt', hint: 'Send the text the bot should speak as a **message below this panel**. I will save it and delete your message.',
            maxLength: 1000, current: cfgOf(gid).ttsPrompt,
            onSave: async (text) => { const c = cfgOf(gid); if (c.audioPath)
                await sys.removeGreetvoiceAudio(c.audioPath); save(gid, { ttsPrompt: text, audioPath: null, mode: 'tts' }); },
            render: () => renderPanel(gid, ['✅ Prompt saved.'])
        });
    }
    if (id === 'greetvoice_cfg:audio') {
        return void await h.startTextCapture(i, {
            title: '🎵 Send your audio file', hint: 'Upload an **mp3 / wav / ogg / m4a** file as a message below. I will save it and delete the upload.', accept: 'audio',
            onSave: async (att) => { const old = cfgOf(gid).audioPath; const saved = await sys.saveGreetvoiceAudio(gid, att); save(gid, { audioPath: saved, mode: 'audio' }); if (old && old !== saved)
                await sys.removeGreetvoiceAudio(old); },
            render: () => renderPanel(gid, ['✅ Audio saved.'])
        });
    }
    if (id === 'greetvoice_cfg:remove_audio') {
        await i.deferUpdate();
        const c = cfgOf(gid);
        if (c.audioPath)
            await sys.removeGreetvoiceAudio(c.audioPath);
        save(gid, { audioPath: null, mode: 'tts' });
        return void await redraw();
    }
    if (id === 'greetvoice_cfg:mode') {
        await i.deferUpdate();
        const c = cfgOf(gid);
        const next = c.mode === 'audio' ? 'tts' : 'audio';
        if (next === 'audio' && !c.audioPath)
            return void await redraw(['⚠️ Upload an audio file first.']);
        if (next === 'tts' && !c.ttsPrompt)
            return void await redraw(['⚠️ Set a TTS prompt first.']);
        save(gid, { mode: next });
        return void await redraw();
    }
    if (id === 'greetvoice_cfg:toggle') {
        await i.deferUpdate();
        const c = cfgOf(gid);
        if (!c.enabled && (!c.vcId || !c.roleId || (c.mode === 'audio' ? !c.audioPath : !String(c.ttsPrompt || '').trim()))) {
            return void await redraw(['⚠️ Choose a voice channel, a gate role and a prompt/audio before enabling.']);
        }
        const next = save(gid, { enabled: !c.enabled });
        return void await redraw(next.enabled ? await applyVoiceSetup(g, next) : []);
    }
    if (id === 'greetvoice_cfg:test') {
        await i.deferUpdate();
        const c = cfgOf(gid);
        if (!c.vcId || (!c.ttsPrompt && !c.audioPath))
            return void await redraw(['⚠️ Choose a voice channel and set a prompt/audio first.']);
        await redraw(['▶️ Playing the greeting…']);
        try {
            await sys.playGreetvoiceGreeting(g, c);
            return void await redraw(['✅ Test finished playing.']);
        }
        catch (e) {
            return void await redraw([`⚠️ Test failed: ${String(e?.message || e).slice(0, 300)}`]);
        }
    }
    return false;
}
async function handleInteraction(i) {
    const id = i.customId;
    if (id && id.startsWith('greetvoice_cfg:')) {
        try {
            const r = await handleSetupInteraction(i);
            return r !== false;
        }
        catch (e) {
            console.error('[GreetVoice] setup interaction failed:', e);
            await h.safeReply(i, { embeds: [h.errorEmbed('Greet Voice error', String(e?.message || e).slice(0, 1200))], ephemeral: true });
            return true;
        }
    }
    if (!id || !id.startsWith('gvreset:'))
        return false;
    const [, uid, choice] = id.split(':');
    try {
        if (!await h.authorOnly(i, uid))
            return true;
        if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await i.reply({ embeds: [h.errorEmbed('Missing permissions', 'You need **Manage Server**.')], ephemeral: true });
            return true;
        }
        if (choice !== 'yes') {
            await i.update({ embeds: [h.infoEmbed('Cancelled', 'Nothing changed.')], components: [] });
            return true;
        }
        const cfg = cfgOf(i.guildId);
        if (cfg.audioPath)
            await sys.removeGreetvoiceAudio(cfg.audioPath);
        const next = save(i.guildId, { ...db.DEFAULT_CONFIG.greetvoice });
        await i.update({ embeds: [panel(next).setColor(ui.OK).setTitle('Greet Voice reset')], components: [] });
    }
    catch (e) {
        console.error('[GreetVoice] reset failed:', e);
        await h.safeReply(i, { embeds: [h.errorEmbed('Reset failed', String(e?.message || e))], ephemeral: true });
    }
    return true;
}
module.exports = { commands: [command, setupCommand], handleInteraction, applyVoiceSetup };

};
__modules["helpers.js"] = function(module, exports, require, __filename, __dirname) {
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { randomBytes } = require('crypto');
const ui = require('./ui');
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
const emptyEmbed = (title, hint) => ui.infoEmbed(`${THEME.emoji.list} ${title}`, `Nothing here yet.${hint ? `\n${hint}` : ''}`);
function toggleButton(customId, enabled, { on = 'Enabled', off = 'Disabled', prefix = '' } = {}) {
    return new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(`${prefix}${enabled ? on : off}`.slice(0, 80))
        .setStyle(enabled ? ButtonStyle.Success : ButtonStyle.Danger)
        .setEmoji(enabled ? THEME.emoji.on() : THEME.emoji.off());
}
function confirmRow(prefix, { yes = 'Confirm', no = 'Cancel', danger = true } = {}) {
    return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${prefix}:yes`).setLabel(yes).setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Success), new ButtonBuilder().setCustomId(`${prefix}:no`).setLabel(no).setStyle(ButtonStyle.Secondary));
}
function disableRows(rows) {
    for (const row of rows || [])
        for (const c of row.components || [])
            c.setDisabled?.(true);
    return rows;
}
function backHomeRow(prefix, { back = true, home = true } = {}) {
    const row = new ActionRowBuilder();
    if (back)
        row.addComponents(new ButtonBuilder().setCustomId(`${prefix}:back`).setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji(THEME.emoji.back));
    if (home)
        row.addComponents(new ButtonBuilder().setCustomId(`${prefix}:home`).setLabel('Home').setStyle(ButtonStyle.Secondary).setEmoji(THEME.emoji.home));
    return row;
}
async function safeReply(interaction, payload) {
    try {
        if (interaction.deferred && !interaction.replied)
            return await interaction.editReply(payload);
        if (interaction.replied || interaction.deferred)
            return await interaction.followUp(payload);
        return await interaction.reply(payload);
    }
    catch (e) {
        console.error('[helpers] safeReply failed:', e?.message || e);
        return null;
    }
}
async function safeUpdate(interaction, payload) {
    try {
        if (interaction.deferred || interaction.replied)
            return await interaction.editReply(payload);
        return await interaction.update(payload);
    }
    catch (e) {
        console.error('[helpers] safeUpdate failed:', e?.message || e);
        return safeReply(interaction, { ...payload, ephemeral: true });
    }
}
async function authorOnly(interaction, ownerId) {
    if (!ownerId || interaction.user.id === ownerId)
        return true;
    await interaction.reply({ embeds: [errorEmbed("This isn't your menu", 'Run the command yourself to get your own panel.')], ephemeral: true }).catch(() => { });
    return false;
}
function humanPerms(names) { return names.map(n => String(n).replace(/([a-z])([A-Z])/g, '$1 $2')).join(', '); }
function missingChannelPerms(channel, member, flags) {
    if (!channel || !member)
        return ['View Channel'];
    const perms = channel.permissionsFor(member);
    if (!perms)
        return ['View Channel'];
    return new PermissionsBitField(flags).toArray().filter(name => !perms.has(PermissionsBitField.Flags[name])).map(n => n.replace(/([a-z])([A-Z])/g, '$1 $2'));
}
const pageSessions = new Map();
const DEFAULT_TIMEOUT = 120000;
function chunkLines(lines, { maxChars = 3800, maxLines = 10 } = {}) {
    const pages = [];
    let cur = [];
    let len = 0;
    for (const raw of lines) {
        const line = clip(raw, 900);
        if (cur.length && (cur.length >= maxLines || len + line.length + 1 > maxChars)) {
            pages.push(cur);
            cur = [];
            len = 0;
        }
        cur.push(line);
        len += line.length + 1;
    }
    if (cur.length)
        pages.push(cur);
    return pages;
}
function listPages({ title, lines, emptyHint, color, perPage = 10, thumbnail }) {
    if (!lines || !lines.length)
        return [emptyEmbed(title, emptyHint)];
    return chunkLines(lines, { maxLines: perPage }).map(chunk => {
        const e = ui.base(title).setDescription(chunk.join('\n'));
        if (color)
            e.setColor(color);
        if (thumbnail)
            e.setThumbnail(thumbnail);
        return e;
    });
}
function pageRow(token, index, total, disabled = false) {
    const b = (id, label, dis) => new ButtonBuilder().setCustomId(`pg:${token}:${id}`).setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(disabled || dis);
    return new ActionRowBuilder().addComponents(b('first', '⏮', index === 0), b('prev', '◀', index === 0), b('ind', `${index + 1}/${total}`, true), b('next', '▶', index >= total - 1), b('last', '⏭', index >= total - 1));
}
function pagePayload(session, disabled = false) {
    const total = session.pages.length;
    const embed = EmbedBuilder.from(session.pages[session.index]);
    embed.setFooter({ text: disabled ? `⏱ Expired • Page ${session.index + 1}/${total}` : `Page ${session.index + 1}/${total}` });
    return { embeds: [embed], components: total > 1 ? [pageRow(session.token, session.index, total, disabled)] : [] };
}
async function paginate(interaction, pages, { ephemeral = false, timeoutMs = DEFAULT_TIMEOUT } = {}) {
    if (!Array.isArray(pages) || !pages.length)
        pages = [emptyEmbed('Nothing here yet')];
    const session = {
        token: randomBytes(5).toString('hex'), userId: interaction.user.id, pages, index: 0,
        interaction, sent: null, timer: null, timeoutMs,
        isSlash: typeof interaction.fetchReply === 'function'
    };
    const payload = pagePayload(session);
    const sent = await safeReply(interaction, { ...payload, ephemeral });
    if (pages.length < 2)
        return sent;
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
            if (session.isSlash)
                await session.interaction.editReply(payload);
            else
                await session.sent?.edit?.(payload);
        }
        catch (e) {
            console.warn('[paginate] could not disable expired list:', e?.message || e);
        }
    }, session.timeoutMs);
    session.timer.unref?.();
}
async function handlePaginationButton(interaction) {
    if (!interaction.isButton?.() || !interaction.customId.startsWith('pg:'))
        return false;
    const [, token, action] = interaction.customId.split(':');
    const session = pageSessions.get(token);
    if (!session) {
        try {
            await interaction.deferUpdate();
            const disabled = (interaction.message.components || []).length;
            await interaction.editReply({ embeds: [warnEmbed('List expired', 'Run the command again to get a fresh list.')], components: [] });
            void disabled;
        }
        catch (e) {
            await interaction.reply({ embeds: [warnEmbed('List expired', 'Run the command again to get a fresh list.')], ephemeral: true }).catch(() => { });
        }
        return true;
    }
    if (interaction.user.id !== session.userId) {
        await authorOnly(interaction, session.userId);
        return true;
    }
    try {
        await interaction.deferUpdate();
    }
    catch (e) {
        console.warn('[paginate] deferUpdate failed:', e?.message || e);
        return true;
    }
    const last = session.pages.length - 1;
    if (action === 'first')
        session.index = 0;
    else if (action === 'prev')
        session.index = Math.max(0, session.index - 1);
    else if (action === 'next')
        session.index = Math.min(last, session.index + 1);
    else if (action === 'last')
        session.index = last;
    armPageTimer(session);
    try {
        await interaction.editReply(pagePayload(session));
    }
    catch (e) {
        console.warn('[paginate] could not edit page:', e?.message || e);
    }
    return true;
}
const textCaptures = new Map();
async function startTextCapture(interaction, { title, hint, accept = 'text', maxLength = 1000, ttlMs = 180000, current = null, cancelPanel, onSave, render }) {
    const key = `${interaction.guildId}:${interaction.user.id}`;
    const old = textCaptures.get(key);
    if (old)
        clearTimeout(old.timer);
    const session = { interaction, accept, channelId: interaction.channelId, maxLength, onSave, render, cancelPanel, expiresAt: Date.now() + ttlMs };
    session.timer = setTimeout(async () => {
        if (textCaptures.get(key) !== session)
            return;
        textCaptures.delete(key);
        try {
            await interaction.editReply(await render());
        }
        catch { }
    }, ttlMs);
    session.timer.unref?.();
    textCaptures.set(key, session);
    const lines = [hint, `Maximum **${maxLength}** characters. Type \`cancel\` to go back.`];
    if (current)
        lines.push(`**Current:**\n${clip(current, 500)}`);
    const payload = { embeds: [infoEmbed(title, lines.join('\n\n'))], components: [] };
    if (interaction.deferred || interaction.replied)
        return interaction.editReply(payload);
    return interaction.update(payload);
}
async function consumeTextCapture(message) {
    if (!message.guild || message.author.bot)
        return false;
    const key = `${message.guild.id}:${message.author.id}`;
    const session = textCaptures.get(key);
    if (!session || session.channelId !== message.channelId)
        return false;
    if (Date.now() > session.expiresAt) {
        textCaptures.delete(key);
        return false;
    }
    const text = String(message.content || '').trim();
    const att = [...message.attachments.values()].find(a => {
        const type = String(a.contentType || '').toLowerCase();
        const name = String(a.name || '').toLowerCase();
        if (session.accept === 'audio')
            return type.startsWith('audio/') || /\.(mp3|wav|ogg|oga|opus|webm|m4a|aac|flac)$/i.test(name);
        if (session.accept === 'image')
            return type.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(name);
        return false;
    });
    if (session.accept === 'text' && !text)
        return false;
    if (session.accept !== 'text' && !att && !(session.accept === 'image' && isHttpUrl(text)) && !/^cancel$/i.test(text))
        return false;
    textCaptures.delete(key);
    clearTimeout(session.timer);
    try {
        let note = null;
        if (/^cancel$/i.test(text)) { }
        else if (session.accept === 'text' && text.length > session.maxLength)
            note = `That was ${text.length} characters — the limit is ${session.maxLength}. Nothing was saved.`;
        else if (session.accept === 'text')
            await session.onSave(text, message);
        else
            await session.onSave(att || text, message);
        await message.delete().catch(() => { });
        const payload = await session.render();
        if (note && payload.embeds?.[0]?.setFooter)
            payload.embeds[0].setFooter({ text: note });
        await session.interaction.editReply(payload).catch(e => console.warn('[capture] redraw failed:', e?.message || e));
    }
    catch (e) {
        console.error('[capture] save failed:', e);
        await session.interaction.editReply({ embeds: [errorEmbed('Could not save', String(e?.message || e).slice(0, 1500))], components: [] }).catch(() => { });
    }
    return true;
}
const panels = new Map();
function watchPanel(interaction, sent, render, ms = 300000) {
    const isSlash = typeof interaction.fetchReply === 'function';
    const arm = async () => {
        let id = null;
        try {
            id = isSlash ? (await interaction.fetchReply()).id : sent?.id;
        }
        catch { }
        if (!id)
            return;
        const rec = { interaction, sent, render, last: Date.now(), ms, isSlash };
        const check = async () => {
            const idle = Date.now() - rec.last;
            if (idle < rec.ms) {
                rec.timer = setTimeout(check, rec.ms - idle);
                rec.timer.unref?.();
                return;
            }
            panels.delete(id);
            try {
                const payload = await rec.render();
                disableRows(payload.components);
                if (payload.embeds?.[0]?.setFooter)
                    payload.embeds[0].setFooter({ text: '⏱ Panel expired — run the command again' });
                if (rec.isSlash)
                    await rec.interaction.editReply(payload);
                else
                    await rec.sent?.edit?.(payload);
            }
            catch (e) {
                console.warn('[panel] could not disable expired panel:', e?.message || e);
            }
        };
        rec.timer = setTimeout(check, ms);
        rec.timer.unref?.();
        panels.set(id, rec);
    };
    arm().catch(() => { });
}
function touchPanel(messageId) { const rec = panels.get(messageId); if (rec)
    rec.last = Date.now(); }
function parseHexColor(input) {
    const m = String(input || '').trim().match(/^(?:#|0x)?([0-9a-f]{6})$/i);
    return m ? parseInt(m[1], 16) : null;
}
function isHttpUrl(value) { try {
    const u = new URL(String(value));
    return u.protocol === 'https:' || u.protocol === 'http:';
}
catch {
    return false;
} }
module.exports = {
    THEME, clip, successEmbed, errorEmbed, warnEmbed, infoEmbed, emptyEmbed,
    toggleButton, confirmRow, disableRows, backHomeRow,
    safeReply, safeUpdate, authorOnly, humanPerms, missingChannelPerms,
    chunkLines, listPages, paginate, handlePaginationButton, startTextCapture, consumeTextCapture, watchPanel, touchPanel,
    parseHexColor, isHttpUrl
};

};

__modules["nexora.js"] = function(module, exports, require, __filename, __dirname) {
const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder, ChannelType, AttachmentBuilder, PermissionFlagsBits
} = require('discord.js');
const crypto = require('node:crypto');
const db = require('./database');
const ui = require('./ui');
const sql = db.db;

// NEXORA schema is additive and isolated from existing AunXz tables.
sql.exec(`
CREATE TABLE IF NOT EXISTS nexora_schema (version INTEGER NOT NULL);
INSERT INTO nexora_schema(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM nexora_schema);
CREATE TABLE IF NOT EXISTS nexora_settings(guildId TEXT PRIMARY KEY, data TEXT NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS nexora_regions(guildId TEXT NOT NULL, regionId TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', difficulty TEXT NOT NULL DEFAULT 'Normal', minLevel INTEGER NOT NULL DEFAULT 1, travelCost INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(guildId,regionId), UNIQUE(guildId,name));
CREATE TABLE IF NOT EXISTS nexora_classes(guildId TEXT NOT NULL, classId TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', hp INTEGER NOT NULL DEFAULT 100, attack INTEGER NOT NULL DEFAULT 10, defense INTEGER NOT NULL DEFAULT 5, data TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(guildId,classId), UNIQUE(guildId,name));
CREATE TABLE IF NOT EXISTS nexora_items(guildId TEXT NOT NULL, itemId TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', itemType TEXT NOT NULL DEFAULT 'material', rarity TEXT NOT NULL DEFAULT 'Common', price INTEGER NOT NULL DEFAULT 0, stackLimit INTEGER NOT NULL DEFAULT 99, attackBonus INTEGER NOT NULL DEFAULT 0, defenseBonus INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(guildId,itemId));
CREATE TABLE IF NOT EXISTS nexora_characters(guildId TEXT NOT NULL, userId TEXT NOT NULL, name TEXT NOT NULL, classId TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, xp INTEGER NOT NULL DEFAULT 0, hp INTEGER NOT NULL DEFAULT 100, maxHp INTEGER NOT NULL DEFAULT 100, attack INTEGER NOT NULL DEFAULT 10, defense INTEGER NOT NULL DEFAULT 5, coins INTEGER NOT NULL DEFAULT 0 CHECK(coins>=0), regionId TEXT NOT NULL DEFAULT 'sunmeadow', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(guildId,userId));
CREATE TABLE IF NOT EXISTS nexora_inventory(guildId TEXT NOT NULL, userId TEXT NOT NULL, itemId TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity>=0), PRIMARY KEY(guildId,userId,itemId));
CREATE TABLE IF NOT EXISTS nexora_quests(guildId TEXT NOT NULL, questId TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', objective TEXT NOT NULL DEFAULT 'explore', goal INTEGER NOT NULL DEFAULT 1 CHECK(goal>0), rewardXp INTEGER NOT NULL DEFAULT 0 CHECK(rewardXp>=0), rewardCoins INTEGER NOT NULL DEFAULT 0 CHECK(rewardCoins>=0), minLevel INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, repeatable INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(guildId,questId));
CREATE TABLE IF NOT EXISTS nexora_quest_progress(guildId TEXT NOT NULL, userId TEXT NOT NULL, questId TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, startedAt INTEGER NOT NULL, completedAt INTEGER, claimedAt INTEGER, PRIMARY KEY(guildId,userId,questId));
CREATE TABLE IF NOT EXISTS nexora_cooldowns(guildId TEXT NOT NULL, userId TEXT NOT NULL, action TEXT NOT NULL, untilAt INTEGER NOT NULL, PRIMARY KEY(guildId,userId,action));
CREATE TABLE IF NOT EXISTS nexora_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT, guildId TEXT NOT NULL, userId TEXT NOT NULL, action TEXT NOT NULL, currencyDelta INTEGER NOT NULL DEFAULT 0, xpDelta INTEGER NOT NULL DEFAULT 0, reference TEXT NOT NULL, createdAt INTEGER NOT NULL, UNIQUE(guildId,userId,reference));
CREATE TABLE IF NOT EXISTS nexora_templates(code TEXT PRIMARY KEY, createdGuildId TEXT NOT NULL, createdBy TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS nexora_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, guildId TEXT NOT NULL, actorId TEXT, action TEXT NOT NULL, detail TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_nexora_region_guild ON nexora_regions(guildId);
CREATE INDEX IF NOT EXISTS idx_nexora_character_rank ON nexora_characters(guildId,level DESC,xp DESC);
CREATE INDEX IF NOT EXISTS idx_nexora_quest_list ON nexora_quests(guildId,enabled,minLevel);
CREATE INDEX IF NOT EXISTS idx_nexora_audit_guild ON nexora_audit(guildId,createdAt DESC);
`);

const SECTION_LIST = [
  ['general','General Settings','game'], ['world','World Builder','world'], ['exploration','Regions & Exploration','exploration'],
  ['characters','Character System','characters'], ['classes','Classes & Skills','classes'], ['combat','Combat & Enemies','combat'],
  ['quests','Quests & Storylines','quests'], ['bosses','Bosses & Dungeons','bosses'], ['inventory','Inventory & Items','inventory'],
  ['crafting','Crafting & Resources','crafting'], ['pets','Pets & Collections','pets'], ['guilds','Guilds & Factions','guilds'],
  ['trading','Trading & Economy','trading'], ['events','Events & Tournaments','events'], ['minigames','Minigames','minigames'],
  ['rewards','Rewards & Achievements','rewards'], ['leaderboards','Levels & Leaderboards','leaderboards'], ['channels','Channels & Roles','channels'],
  ['ai','AI Story Generator','ai'], ['seasons','Seasons & Resets','seasons'], ['backup','Backups & Restoration','backup'], ['advanced','Advanced Settings','advanced']
];
const AVAILABLE = new Set(['game','world','exploration','characters','classes','combat','quests','inventory','crafting','trading','leaderboards','channels','backup','advanced']);
const DEFAULT_SETTINGS = {
  enabled: true, gameName: 'NEXORA', worldTitle: 'The Shattered Realms', description: 'A living world shaped by its adventurers.', theme: 'Fantasy RPG',
  currencyName: 'Crowns', currencySymbol: '✦', difficulty: 'Normal', mode: 'mixed', participation: 'public', startingCoins: 100,
  travelCooldownSeconds: 10, battleCooldownSeconds: 30, levelCap: 50, xpCurve: 'quadratic', maintenance: false,
  notificationChannelId: null, announcementChannelId: null, commandChannelId: null, adminRoleIds: [], allowedRoleIds: [], restrictedRoleIds: [],
  modules: { game:true, world:true, exploration:true, characters:true, classes:true, combat:true, quests:true, inventory:true, crafting:true, trading:true, leaderboards:true, channels:true, backup:true, advanced:true, bosses:false, pets:false, guilds:false, events:false, minigames:false, rewards:true, ai:false, seasons:false },
  ai: { provider:'openrouter', model:'', tone:'adventurous', enabled:false, maxRequestsPerHour:10 },
  security: { maxActionPerMinute:8, maxInventoryStack:999, maxRewardCoins:5000, maxRewardXp:5000 },
  season: { enabled:false, lengthDays:90, resetProgress:false }
};
const sessions = new Map();
const restoreSessions = new Map();
const now = () => Date.now();
const safeText = (s, n=500) => String(s ?? '').replace(/@everyone|@here/g, '@\u200b$&').slice(0,n);
const slug = s => String(s||'').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,40) || `item_${crypto.randomBytes(3).toString('hex')}`;
function merge(base, patch) {
  const out = { ...base };
  for (const [k,v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = merge(out[k],v);
    else out[k] = v;
  }
  return out;
}
function getSettings(guildId) {
  const row = sql.prepare('SELECT data FROM nexora_settings WHERE guildId=?').get(guildId);
  let stored = {}; try { stored = row ? JSON.parse(row.data) : {}; } catch {}
  return merge(DEFAULT_SETTINGS, stored);
}
function saveSettings(guildId, patch, actorId=null) {
  const next = merge(getSettings(guildId), patch);
  sql.prepare('INSERT INTO nexora_settings(guildId,data,updatedAt) VALUES(?,?,?) ON CONFLICT(guildId) DO UPDATE SET data=excluded.data,updatedAt=excluded.updatedAt').run(guildId, JSON.stringify(next), now());
  if (actorId) sql.prepare('INSERT INTO nexora_audit(guildId,actorId,action,detail,createdAt) VALUES(?,?,?,?,?)').run(guildId, actorId, 'settings_update', safeText(JSON.stringify(patch), 1000), now());
  return next;
}
function audit(guildId, actorId, action, detail) { sql.prepare('INSERT INTO nexora_audit(guildId,actorId,action,detail,createdAt) VALUES(?,?,?,?,?)').run(guildId, actorId || null, action, safeText(detail,1000), now()); }
function seedWorld(guildId) {
  const insRegion = sql.prepare('INSERT OR IGNORE INTO nexora_regions(guildId,regionId,name,description,difficulty,minLevel,travelCost,data) VALUES(?,?,?,?,?,?,?,?)');
  const tx = sql.transaction(() => {
    insRegion.run(guildId,'sunmeadow','Sunmeadow','A quiet grassland where new adventurers begin.','Easy',1,0,'{}');
    insRegion.run(guildId,'whispering_woods','Whispering Woods','Old trees hide strange tracks and restless creatures.','Normal',3,20,'{}');
    insRegion.run(guildId,'ember_caverns','Ember Caverns','A dangerous cavern filled with glowing ore.','Hard',7,60,'{}');
    const cls = sql.prepare('INSERT OR IGNORE INTO nexora_classes(guildId,classId,name,description,hp,attack,defense,data) VALUES(?,?,?,?,?,?,?,?)');
    cls.run(guildId,'vanguard','Vanguard','A durable front-line fighter.',125,12,9,'{}');
    cls.run(guildId,'ranger','Ranger','A nimble hunter with balanced stats.',95,15,5,'{}');
    cls.run(guildId,'arcanist','Arcanist','A fragile but powerful spellcaster.',80,19,3,'{}');
    const item = sql.prepare('INSERT OR IGNORE INTO nexora_items(guildId,itemId,name,description,itemType,rarity,price,stackLimit,attackBonus,defenseBonus,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    item.run(guildId,'small_potion','Small Potion','Restore 30 HP after a battle.','consumable','Common',15,20,0,0,JSON.stringify({effect:'heal',amount:30}));
    item.run(guildId,'iron_ore','Iron Ore','Raw iron for crafting.','material','Common',8,99,0,0,'{}');
    item.run(guildId,'wood','Timber','Useful crafting timber.','material','Common',4,99,0,0,'{}');
    item.run(guildId,'iron_blade','Iron Blade','A crafted weapon.','equipment','Uncommon',75,1,5,0,JSON.stringify({recipe:[{itemId:'iron_ore',quantity:3},{itemId:'wood',quantity:2}]}));
    item.run(guildId,'hide_vest','Hide Vest','A simple protective vest.','equipment','Common',55,1,0,3,JSON.stringify({recipe:[{itemId:'wood',quantity:2}]}));
    const q = sql.prepare('INSERT OR IGNORE INTO nexora_quests(guildId,questId,name,description,objective,goal,rewardXp,rewardCoins,minLevel,enabled,repeatable,data) VALUES(?,?,?,?,?,?,?,?,?,1,0,?)');
    q.run(guildId,'first_steps','First Steps','Travel to a region to learn how exploration works.','explore',1,40,25,1,'{}');
    q.run(guildId,'first_battle','A Test of Courage','Win a battle against a regional enemy.','battle',1,60,40,1,'{}');
    q.run(guildId,'woodland_roamer','Woodland Roamer','Explore three times.','explore',3,90,55,2,'{}');
  });
  tx();
  if (!sql.prepare('SELECT 1 FROM nexora_settings WHERE guildId=?').get(guildId)) saveSettings(guildId, {});
}
function requireAdmin(i) { return !!i.guild && (i.guild.ownerId === i.user.id || i.memberPermissions?.has(PermissionFlagsBits.Administrator) || i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)); }
function adminError() { return { embeds:[ui.errorEmbed('Administrator only','Manage Server or Administrator is required to configure NEXORA.')], ephemeral:true }; }
function allRows(table,guildId,order='name') { return sql.prepare(`SELECT * FROM ${table} WHERE guildId=? ORDER BY ${order}`).all(guildId); }
function getCharacter(guildId,userId) { return sql.prepare('SELECT * FROM nexora_characters WHERE guildId=? AND userId=?').get(guildId,userId) || null; }
function addInventory(guildId,userId,itemId,qty) {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('Quantity must be a positive integer.');
  sql.prepare('INSERT INTO nexora_inventory(guildId,userId,itemId,quantity) VALUES(?,?,?,?) ON CONFLICT(guildId,userId,itemId) DO UPDATE SET quantity=quantity+excluded.quantity').run(guildId,userId,itemId,qty);
}
function trackObjective(guildId,userId,objective,count=1) {
  const quests = sql.prepare('SELECT * FROM nexora_quests WHERE guildId=? AND enabled=1 AND objective=?').all(guildId,objective);
  for (const q of quests) {
    const p = sql.prepare('SELECT * FROM nexora_quest_progress WHERE guildId=? AND userId=? AND questId=?').get(guildId,userId,q.questId);
    if (!p || p.claimedAt || (p.completedAt && !q.repeatable)) continue;
    const next = Math.min(q.goal, (p?.progress || 0) + count);
    sql.prepare('INSERT INTO nexora_quest_progress(guildId,userId,questId,progress,startedAt,completedAt,claimedAt) VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(guildId,userId,questId) DO UPDATE SET progress=excluded.progress,completedAt=CASE WHEN excluded.progress >= ? THEN COALESCE(nexora_quest_progress.completedAt, excluded.completedAt) ELSE nexora_quest_progress.completedAt END').run(guildId,userId,q.questId,next,p?.startedAt || now(),next>=q.goal?now():null,q.goal);
  }
}
function cooldownRemaining(guildId,userId,action) { const row=sql.prepare('SELECT untilAt FROM nexora_cooldowns WHERE guildId=? AND userId=? AND action=?').get(guildId,userId,action); return Math.max(0,(row?.untilAt||0)-now()); }
function setCooldown(guildId,userId,action,ms) { sql.prepare('INSERT INTO nexora_cooldowns(guildId,userId,action,untilAt) VALUES(?,?,?,?) ON CONFLICT(guildId,userId,action) DO UPDATE SET untilAt=excluded.untilAt').run(guildId,userId,action,now()+ms); }
function xpNeeded(level, settings) {
  const lvl=Math.max(1,Math.min(Number(settings.levelCap)||50,level));
  if (settings.xpCurve==='linear') return lvl*100;
  if (settings.xpCurve==='exponential') return Math.min(1_000_000,Math.round(100*Math.pow(1.22,lvl-1)));
  return 75*lvl*lvl;
}
function grantXp(guildId,userId,amount,settings) {
  const c=getCharacter(guildId,userId); if(!c) return null;
  let xp=c.xp+Math.max(0,Math.floor(amount)), level=c.level, max=Math.max(1,Math.min(200,Number(settings.levelCap)||50));
  while(level<max && xp>=xpNeeded(level,settings)){xp-=xpNeeded(level,settings);level++;}
  sql.prepare('UPDATE nexora_characters SET xp=?,level=?,maxHp=maxHp+?,hp=MIN(maxHp+?,hp+?),attack=attack+?,updatedAt=? WHERE guildId=? AND userId=?').run(xp,level,(level-c.level)*5,(level-c.level)*5,(level-c.level)*5,(level-c.level)>0?1:0,now(),guildId,userId);
  return sql.prepare('SELECT * FROM nexora_characters WHERE guildId=? AND userId=?').get(guildId,userId);
}
function characterEmbed(guild, user, c) {
  const settings=getSettings(guild.id), region=sql.prepare('SELECT name FROM nexora_regions WHERE guildId=? AND regionId=?').get(guild.id,c.regionId);
  const klass=sql.prepare('SELECT name FROM nexora_classes WHERE guildId=? AND classId=?').get(guild.id,c.classId);
  const next=xpNeeded(c.level,settings);
  return new EmbedBuilder().setColor(0x8B5CF6).setTitle(`${c.name} — Level ${c.level}`).setDescription(`**${safeText(klass?.name||c.classId,80)}** • ${safeText(region?.name||'Unknown region',100)}\n${user}`).addFields(
    {name:'Health',value:`${c.hp}/${c.maxHp}`,inline:true},{name:'Attack',value:String(c.attack),inline:true},{name:'Defense',value:String(c.defense),inline:true},
    {name:'Experience',value:`${c.xp}/${next}`,inline:true},{name:settings.currencyName,value:`${settings.currencySymbol} ${c.coins}`,inline:true},{name:'World',value:safeText(settings.worldTitle,100),inline:true}
  ).setThumbnail(user.displayAvatarURL?.({extension:'png',size:128})||null).setFooter({text:`${settings.gameName} • Guild ${guild.id}`});
}
const sectionByKey = new Map(SECTION_LIST.map(s=>[s[0],s]));
const moduleSection = {general:'game',world:'world',exploration:'exploration',characters:'characters',classes:'classes',combat:'combat',quests:'quests',bosses:'bosses',inventory:'inventory',crafting:'crafting',pets:'pets',guilds:'guilds',trading:'trading',events:'events',minigames:'minigames',rewards:'rewards',leaderboards:'leaderboards',channels:'channels',ai:'ai',seasons:'seasons',backup:'backup',advanced:'advanced'};
function isModuleAvailable(key) { return AVAILABLE.has(key); }
function dashboardEmbed(guildId, section='dashboard') {
  const s=getSettings(guildId); const regions=sql.prepare('SELECT COUNT(*) n FROM nexora_regions WHERE guildId=?').get(guildId).n;
  const chars=sql.prepare('SELECT COUNT(*) n FROM nexora_characters WHERE guildId=?').get(guildId).n;
  const quests=sql.prepare('SELECT COUNT(*) n FROM nexora_quests WHERE guildId=? AND enabled=1').get(guildId).n;
  if(section==='dashboard') {
    const enabled=Object.entries(s.modules).filter(([k,v])=>v && isModuleAvailable(k)).length;
    const available=[...AVAILABLE].length;
    return new EmbedBuilder().setColor(0x8B5CF6).setTitle(`✦ ${safeText(s.gameName,80)} — World Engine`).setDescription(`${safeText(s.description,800)}\n\n**World:** ${safeText(s.worldTitle,100)}\n**Theme:** ${safeText(s.theme,80)} • **Difficulty:** ${safeText(s.difficulty,30)}\n**System:** ${s.enabled?'🟢 Enabled':'🔴 Disabled'} • **Maintenance:** ${s.maintenance?'On':'Off'}\n**Playable modules:** ${enabled}/${available}\n**Regions:** ${regions} • **Characters:** ${chars} • **Published quests:** ${quests}\n\nChoose a section below. Unsupported gameplay modules are visibly marked and cannot be enabled until implemented.`).setFooter({text:`Per-server world • setup persists to SQLite • ${guildId}`});
  }
  const sec=sectionByKey.get(section); if(!sec) return dashboardEmbed(guildId);
  const mod=moduleSection[section]; const available=isModuleAvailable(mod); const enabled=!!s.modules[mod];
  let details=`**Status:** ${available?(enabled?'🟢 Enabled':'🔴 Disabled'):'⚪ Not available in this build'}\n**Description:** ${sec[1]}\n`;
  if(section==='general') details+=`\n**Game:** ${s.gameName}\n**World:** ${s.worldTitle}\n**Currency:** ${s.currencySymbol} ${s.currencyName}\n**Difficulty:** ${s.difficulty}\n**Mode:** ${s.mode}\n**Starting coins:** ${s.startingCoins}\n**Level cap:** ${s.levelCap}\n**XP curve:** ${s.xpCurve}\n**Maintenance:** ${s.maintenance?'On':'Off'}`;
  if(section==='world'||section==='exploration') { const r=allRows('nexora_regions',guildId); details+=`\n\n**Regions (${r.length})**\n`+(r.slice(0,12).map(x=>`• **${safeText(x.name,80)}** — level ${x.minLevel}+ / ${safeText(x.difficulty,20)} / travel ${x.travelCost}`).join('\n')||'No regions configured.'); }
  if(section==='classes') { const r=allRows('nexora_classes',guildId); details+=`\n\n**Classes (${r.length})**\n`+(r.map(x=>`• **${safeText(x.name,80)}** — HP ${x.hp}, ATK ${x.attack}, DEF ${x.defense}`).join('\n')||'No classes.'); }
  if(section==='quests') { const r=allRows('nexora_quests',guildId); details+=`\n\n**Quests (${r.length})**\n`+(r.slice(0,12).map(x=>`• **${safeText(x.name,80)}** — ${x.objective} ×${x.goal} • ${x.rewardXp} XP / ${x.rewardCoins} coins ${x.enabled?'':'(disabled)'}`).join('\n')||'No quests.'); }
  if(section==='inventory'||section==='crafting') { const r=allRows('nexora_items',guildId); details+=`\n\n**Items (${r.length})**\n`+(r.slice(0,12).map(x=>`• **${safeText(x.name,70)}** — ${x.itemType}, ${x.rarity}, ${s.currencySymbol}${x.price}`).join('\n')||'No items.'); }
  if(section==='channels') details+=`\n\n**Command channel:** ${s.commandChannelId?`<#${s.commandChannelId}>`:'Not restricted'}\n**Notification channel:** ${s.notificationChannelId?`<#${s.notificationChannelId}>`:'Not set'}\n**Announcement channel:** ${s.announcementChannelId?`<#${s.announcementChannelId}>`:'Not set'}`;
  if(section==='ai') details+=`\n\n**Provider:** ${safeText(s.ai.provider,40)}\n**Model:** ${safeText(s.ai.model||'Use environment default',100)}\n**Story tone:** ${safeText(s.ai.tone,80)}\n**AI enabled:** ${s.ai.enabled?'Yes':'No'}\nAI content generation is not activated by this compact module unless a validated provider integration is available.`;
  if(section==='backup') details+='\n\nExport uses a versioned JSON archive. A preview and explicit confirmation are required before restore; only NEXORA tables are affected.';
  if(section==='advanced') details+=`\n\n**Max actions/min:** ${s.security.maxActionPerMinute}\n**Max reward coins:** ${s.security.maxRewardCoins}\n**Max reward XP:** ${s.security.maxRewardXp}\n**Travel cooldown:** ${s.travelCooldownSeconds}s\n**Battle cooldown:** ${s.battleCooldownSeconds}s`;
  if(['guilds','pets','events','minigames','bosses','rewards','seasons','trading'].includes(section) && !available) details+='\n\nThis module has no gameplay handlers in this build. It remains disabled to avoid displaying non-functional controls.';
  if(section==='trading'&&available) details+='\n\nShop purchases and crafting recipes are supported. Player-to-player trading requires a separate confirmation and transfer service and is not enabled in this build.';
  return new EmbedBuilder().setColor(0x8B5CF6).setTitle(`NEXORA Setup • ${sec[1]}`).setDescription(details).setFooter({text:'Use Back to return • changes persist immediately • disabling never deletes progress'});
}
function sectionSelect() {
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('nexora:section').setPlaceholder('Open a configuration section…').addOptions(SECTION_LIST.slice(0,25).map(([value,label])=>({label, value, description: isModuleAvailable(moduleSection[value])?'Configure live settings':'Not implemented in this build'}))));
}
function sectionRows(session, section='dashboard') {
  const rows=[]; const s=getSettings(session.guildId);
  if(section==='dashboard') {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('nexora:preset').setPlaceholder('Apply a world preset…').addOptions([
      {label:'Fantasy RPG',value:'fantasy',description:'Balanced fantasy starter world'}, {label:'Anime Adventure',value:'anime',description:'Fast-paced adventure theme'},
      {label:'Minecraft Survival',value:'minecraft',description:'Gathering and crafting theme'}, {label:'Casual Community',value:'casual',description:'Lower difficulty and gentler progression'},
      {label:'Cooperative World',value:'cooperative',description:'Exploration-focused settings'}, {label:'Custom Blank World',value:'blank',description:'Minimal world configuration'}
    ])));
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('nexora:toggle-system').setLabel(s.enabled?'Disable World':'Enable World').setStyle(s.enabled?ButtonStyle.Danger:ButtonStyle.Success),new ButtonBuilder().setCustomId('nexora:section:general').setLabel('General Settings').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('nexora:section:world').setLabel('World Builder').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('nexora:section:backup').setLabel('Backup / Restore').setStyle(ButtonStyle.Secondary)));
  } else {
    const mod=moduleSection[section], supported=isModuleAvailable(mod);
    const buttonRows=[];
    if(supported) buttonRows.push(new ButtonBuilder().setCustomId(`nexora:toggle:${mod}`).setLabel(s.modules[mod]?'Disable module':'Enable module').setStyle(s.modules[mod]?ButtonStyle.Danger:ButtonStyle.Success));
    if(section==='general') buttonRows.push(new ButtonBuilder().setCustomId('nexora:edit-general').setLabel('Edit world settings').setStyle(ButtonStyle.Primary));
    if(section==='world'||section==='exploration') buttonRows.push(new ButtonBuilder().setCustomId('nexora:add-region').setLabel('Add region').setStyle(ButtonStyle.Primary));
    if(section==='classes') buttonRows.push(new ButtonBuilder().setCustomId('nexora:add-class').setLabel('Add class').setStyle(ButtonStyle.Primary));
    if(section==='quests') buttonRows.push(new ButtonBuilder().setCustomId('nexora:add-quest').setLabel('Add quest').setStyle(ButtonStyle.Primary));
    if(section==='inventory'||section==='crafting') buttonRows.push(new ButtonBuilder().setCustomId('nexora:add-item').setLabel('Add item').setStyle(ButtonStyle.Primary));
    if(section==='channels') buttonRows.push(new ButtonBuilder().setCustomId('nexora:channel-picker').setLabel('Set command channel').setStyle(ButtonStyle.Primary));
    if(section==='backup') buttonRows.push(new ButtonBuilder().setCustomId('nexora:backup-info').setLabel('Backup instructions').setStyle(ButtonStyle.Secondary));
    if(buttonRows.length) rows.push(new ActionRowBuilder().addComponents(buttonRows.slice(0,5)));
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('nexora:back').setLabel('Back to dashboard').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(`nexora:section:${section}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary)));
    if(section==='channels') rows.push(new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('nexora:channel-select').setPlaceholder('Select a channel for NEXORA commands / updates').setChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement)));
  }
  return [sectionSelect(),...rows];
}
function setSessionComponent(session, id) { return `nexora:${session.token}:${id}`; }
function sectionRowsForSession(session, section) {
  const rows=sectionRows(session,section);
  for(const row of rows) for(const component of row.components) {
    const old=component.data?.custom_id || component.toJSON?.().custom_id;
    if(old && old.startsWith('nexora:') && !old.startsWith(`nexora:${session.token}:`)) component.setCustomId(`nexora:${session.token}:${old.slice('nexora:'.length)}`);
  }
  return rows;
}
function sectionEmbedSession(session, section) { return dashboardEmbed(session.guildId,section); }
function input(id,label,value,style=TextInputStyle.Short,required=false,max=100) {
  const x=new TextInputBuilder().setCustomId(id).setLabel(label.slice(0,45)).setStyle(style).setRequired(required).setMaxLength(max);
  if(value!==undefined&&value!==null&&String(value).length) x.setValue(String(value).slice(0,Math.min(max,4000)));
  return new ActionRowBuilder().addComponents(x);
}
function showGeneralModal(i, session) {
  const s=getSettings(session.guildId);
  const modal=new ModalBuilder().setCustomId(`nexora:${session.token}:modal:general`).setTitle('General World Settings');
  modal.addComponents(input('gameName','Game name',s.gameName,TextInputStyle.Short,true,80),input('worldTitle','World title',s.worldTitle,TextInputStyle.Short,true,100),input('currencyName','Currency name',s.currencyName,TextInputStyle.Short,true,30),input('currencySymbol','Currency symbol',s.currencySymbol,TextInputStyle.Short,true,8),input('difficulty','Difficulty (Easy/Normal/Hard/Extreme/Custom)',s.difficulty,TextInputStyle.Short,true,20));
  return i.showModal(modal);
}
function showAddRegionModal(i,session) {
  const modal=new ModalBuilder().setCustomId(`nexora:${session.token}:modal:region`).setTitle('Create a World Region');
  modal.addComponents(input('name','Region name',null,TextInputStyle.Short,true,70),input('description','Region lore / description',null,TextInputStyle.Paragraph,false,700),input('minLevel','Minimum recommended level','1',TextInputStyle.Short,true,3),input('travelCost','Travel cost in currency','0',TextInputStyle.Short,true,8),input('difficulty','Difficulty (Easy/Normal/Hard/Extreme)','Normal',TextInputStyle.Short,true,20));
  return i.showModal(modal);
}
function showAddClassModal(i,session) {
  const modal=new ModalBuilder().setCustomId(`nexora:${session.token}:modal:class`).setTitle('Create a Character Class');
  modal.addComponents(input('name','Class name',null,TextInputStyle.Short,true,70),input('description','Description',null,TextInputStyle.Paragraph,false,500),input('hp','Base health (20–1000)','100',TextInputStyle.Short,true,4),input('attack','Base attack (1–250)','10',TextInputStyle.Short,true,3),input('defense','Base defense (0–200)','5',TextInputStyle.Short,true,3));
  return i.showModal(modal);
}
function showAddQuestModal(i,session) {
  const modal=new ModalBuilder().setCustomId(`nexora:${session.token}:modal:quest`).setTitle('Create a Quest');
  modal.addComponents(input('name','Quest name',null,TextInputStyle.Short,true,80),input('description','Description',null,TextInputStyle.Paragraph,false,500),input('objective','Objective type (explore or battle)','explore',TextInputStyle.Short,true,10),input('goal','Required objective count','1',TextInputStyle.Short,true,4),input('rewards','Rewards: XP,coins (e.g. 50,25)','50,25',TextInputStyle.Short,true,25));
  return i.showModal(modal);
}
function showAddItemModal(i,session) {
  const modal=new ModalBuilder().setCustomId(`nexora:${session.token}:modal:item`).setTitle('Create an Item');
  modal.addComponents(input('id','Item ID (letters, numbers, underscores)',null,TextInputStyle.Short,true,40),input('name','Item name',null,TextInputStyle.Short,true,70),input('description','Description',null,TextInputStyle.Paragraph,false,400),input('price','Shop price (0–1000000)','10',TextInputStyle.Short,true,10),input('type','Type: material/equipment/consumable','material',TextInputStyle.Short,true,20));
  return i.showModal(modal);
}
function presetPatch(preset) {
  const map={fantasy:{theme:'Fantasy RPG',difficulty:'Normal',mode:'mixed',startingCoins:100},anime:{theme:'Anime Adventure',difficulty:'Hard',mode:'competitive',startingCoins:150},minecraft:{theme:'Minecraft Survival',difficulty:'Normal',mode:'cooperative',startingCoins:80},casual:{theme:'Casual Community',difficulty:'Easy',mode:'casual',startingCoins:200},cooperative:{theme:'Cooperative World Adventure',difficulty:'Normal',mode:'cooperative',startingCoins:125},blank:{theme:'Custom Blank World',difficulty:'Custom',mode:'mixed',startingCoins:0}};
  return map[preset]||map.fantasy;
}
function makeBackup(guildId, includePlayers=true) {
  seedWorld(guildId);
  const settings=getSettings(guildId);
  const read=(table)=>sql.prepare(`SELECT * FROM ${table} WHERE guildId=?`).all(guildId);
  const data={format:'NEXORA-BACKUP',schemaVersion:1,guildId,createdAt:new Date().toISOString(),settings,regions:read('nexora_regions'),classes:read('nexora_classes'),items:read('nexora_items'),quests:read('nexora_quests')};
  if(includePlayers){data.characters=read('nexora_characters');data.inventory=read('nexora_inventory');data.questProgress=read('nexora_quest_progress');data.ledger=read('nexora_ledger');}
  return data;
}
function validateBackup(data) {
  if(!data||data.format!=='NEXORA-BACKUP'||data.schemaVersion!==1) throw new Error('This is not a supported NEXORA backup (expected version 1).');
  for(const key of ['regions','classes','items','quests']) if(!Array.isArray(data[key])||data[key].length>10000) throw new Error(`Invalid ${key} list in backup.`);
  if(!data.settings||typeof data.settings!=='object') throw new Error('Missing settings object.');
  for(const key of ['characters','inventory','questProgress','ledger']) if(data[key]!==undefined&&(!Array.isArray(data[key])||data[key].length>100000)) throw new Error(`Invalid ${key} list in backup.`);
  for(const r of data.regions) if(!/^[a-z0-9_]{1,40}$/.test(String(r.regionId||''))||!String(r.name||'').trim()) throw new Error('A region has an invalid ID or name.');
  for(const c of data.classes) if(!/^[a-z0-9_]{1,40}$/.test(String(c.classId||''))||!String(c.name||'').trim()||!Number.isFinite(Number(c.hp))||Number(c.hp)<20||Number(c.hp)>1000) throw new Error('A class has invalid fields.');
  for(const it of data.items) if(!/^[a-z0-9_]{1,40}$/.test(String(it.itemId||''))||!String(it.name||'').trim()||Number(it.price)<0||Number(it.price)>1000000) throw new Error('An item has invalid fields.');
  for(const q of data.quests) if(!/^[a-z0-9_]{1,40}$/.test(String(q.questId||''))||Number(q.goal)<1||Number(q.goal)>100000) throw new Error('A quest has invalid fields.');
  return true;
}
function applyBackup(guildId, userId, data, restorePlayers=true) {
  validateBackup(data);
  const tx=sql.transaction(()=>{
    saveSettings(guildId,data.settings,userId);
    for(const [table,rows,cols] of [
      ['nexora_regions',data.regions,['regionId','name','description','difficulty','minLevel','travelCost','data']],
      ['nexora_classes',data.classes,['classId','name','description','hp','attack','defense','data']],
      ['nexora_items',data.items,['itemId','name','description','itemType','rarity','price','stackLimit','attackBonus','defenseBonus','data']],
      ['nexora_quests',data.quests,['questId','name','description','objective','goal','rewardXp','rewardCoins','minLevel','enabled','repeatable','data']]
    ]) {
      const q=`INSERT INTO ${table}(guildId,${cols.join(',')}) VALUES(${['?','?'].concat(cols.slice(1).map(()=>'?')).join(',')}) ON CONFLICT(guildId,${cols[0]}) DO UPDATE SET ${cols.slice(1).map(c=>`${c}=excluded.${c}`).join(',')}`;
      const stmt=sql.prepare(q);
      for(const row of rows) stmt.run(guildId,...cols.map(c=>row[c] ?? (c==='data'?'{}':c==='description'?'':c==='enabled'?1:c==='repeatable'?0:c==='minLevel'?1:c==='travelCost'?0:c==='price'?0:c==='stackLimit'?99:c==='attackBonus'||c==='defenseBonus'?0:c==='difficulty'?'Normal':c==='itemType'?'material':c==='rarity'?'Common':c==='objective'?'explore':c==='goal'?1:c==='rewardXp'||c==='rewardCoins'?0:c==='hp'?100:c==='attack'?10:c==='defense'?5:'')));
    }
    if(restorePlayers && Array.isArray(data.characters)) {
      const st=sql.prepare('INSERT INTO nexora_characters(guildId,userId,name,classId,level,xp,hp,maxHp,attack,defense,coins,regionId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(guildId,userId) DO UPDATE SET name=excluded.name,classId=excluded.classId,level=excluded.level,xp=excluded.xp,hp=excluded.hp,maxHp=excluded.maxHp,attack=excluded.attack,defense=excluded.defense,coins=excluded.coins,regionId=excluded.regionId,updatedAt=excluded.updatedAt');
      for(const r of data.characters) if(r.userId && Number(r.coins)>=0 && Number(r.level)>=1) st.run(guildId,r.userId,r.name,r.classId,r.level,r.xp,r.hp,r.maxHp,r.attack,r.defense,r.coins,r.regionId,r.createdAt||now(),now());
      const inv=sql.prepare('INSERT INTO nexora_inventory(guildId,userId,itemId,quantity) VALUES(?,?,?,?) ON CONFLICT(guildId,userId,itemId) DO UPDATE SET quantity=excluded.quantity');
      for(const r of data.inventory||[]) if(r.userId&&r.itemId&&Number(r.quantity)>=0) inv.run(guildId,r.userId,r.itemId,r.quantity);
      const qp=sql.prepare('INSERT INTO nexora_quest_progress(guildId,userId,questId,progress,startedAt,completedAt,claimedAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(guildId,userId,questId) DO UPDATE SET progress=excluded.progress,startedAt=excluded.startedAt,completedAt=excluded.completedAt,claimedAt=excluded.claimedAt');
      for(const r of data.questProgress||[]) if(r.userId&&r.questId) qp.run(guildId,r.userId,r.questId,r.progress,r.startedAt||now(),r.completedAt||null,r.claimedAt||null);
    }
    audit(guildId,userId,'backup_restore',`Applied NEXORA backup from ${safeText(data.guildId||'unknown guild',30)}; player data ${restorePlayers?'included':'skipped'}.`);
  });
  tx();
}
function starterCheck(i) { if(!i.guildId||!i.guild) return false; seedWorld(i.guildId); const s=getSettings(i.guildId); if(!s.enabled) { i.reply({embeds:[ui.warnEmbed('NEXORA is disabled','An administrator can enable the game with `/nexora setup`.')],ephemeral:true}).catch(()=>{});return false; } if(s.maintenance && !requireAdmin(i)){i.reply({embeds:[ui.warnEmbed('World maintenance','The game is temporarily unavailable while administrators configure it.')],ephemeral:true}).catch(()=>{});return false;} if(s.commandChannelId && i.channelId!==s.commandChannelId && !requireAdmin(i)){i.reply({embeds:[ui.warnEmbed('Wrong channel',`Use NEXORA in <#${s.commandChannelId}>.`)],ephemeral:true}).catch(()=>{});return false;} if((s.restrictedRoleIds||[]).some(id=>i.member?.roles?.cache?.has(id))&&!requireAdmin(i)){i.reply({embeds:[ui.warnEmbed('Restricted access','Your roles are not allowed to use this game.')],ephemeral:true}).catch(()=>{});return false;} if(s.allowedRoleIds?.length && !s.allowedRoleIds.some(id=>i.member?.roles?.cache?.has(id))&&!requireAdmin(i)){i.reply({embeds:[ui.warnEmbed('Role required', 'Your roles do not meet this game’s participation rules.')],ephemeral:true}).catch(()=>{});return false;} return true; }
function characterCreate(i) {
  const s=getSettings(i.guildId); const existing=getCharacter(i.guildId,i.user.id);
  if(existing) return i.reply({embeds:[ui.warnEmbed('Character already exists',`Use your existing character **${safeText(existing.name,80)}**. Your progress was not reset.`)],ephemeral:true});
  const name=safeText(i.options.getString('name',true).trim(),30); if(name.length<2) return i.reply({embeds:[ui.errorEmbed('Invalid name','Character names must contain at least 2 characters.')],ephemeral:true});
  const classId=i.options.getString('class',true); const klass=sql.prepare('SELECT * FROM nexora_classes WHERE guildId=? AND classId=?').get(i.guildId,classId);
  if(!klass) return i.reply({embeds:[ui.errorEmbed('Unknown class','Choose a class shown by `/nexora classes`.')],ephemeral:true});
  const region=sql.prepare('SELECT regionId FROM nexora_regions WHERE guildId=? ORDER BY minLevel LIMIT 1').get(i.guildId); const time=now();
  const tx=sql.transaction(()=>{sql.prepare('INSERT INTO nexora_characters(guildId,userId,name,classId,level,xp,hp,maxHp,attack,defense,coins,regionId,createdAt,updatedAt) VALUES(?,?,?,?,1,0,?,?,?,?,?,?,?,?)').run(i.guildId,i.user.id,name,klass.classId,klass.hp,klass.hp,klass.attack,klass.defense,Math.max(0,Math.min(1000000,s.startingCoins)),region?.regionId||'sunmeadow',time,time);sql.prepare('INSERT OR IGNORE INTO nexora_ledger(guildId,userId,action,currencyDelta,xpDelta,reference,createdAt) VALUES(?,?,?,?,?,?,?)').run(i.guildId,i.user.id,'character_start',s.startingCoins,0,`create:${i.id}`,time);});
  tx();audit(i.guildId,i.user.id,'character_create',name); const c=getCharacter(i.guildId,i.user.id);
  return i.reply({embeds:[characterEmbed(i.guild,i.user,c),new EmbedBuilder().setColor(0x22C55E).setTitle('Welcome, adventurer').setDescription('Your character has been created. Use `/nexora explore`, `/nexora fight`, and `/nexora quests` to begin.')],ephemeral:true});
}
function requireCharacter(i) { const c=getCharacter(i.guildId,i.user.id); if(!c) i.reply({embeds:[ui.warnEmbed('No character yet','Create one with `/nexora create` first.')],ephemeral:true}).catch(()=>{}); return c; }
function cmd(name,description) { return new SlashCommandBuilder().setName(name).setDescription(description); }
const base = new SlashCommandBuilder().setName('nexora').setDescription('NEXORA — The Living World Engine');
base.addSubcommand(s=>s.setName('setup').setDescription('Open the per-server NEXORA setup dashboard.'));
base.addSubcommand(s=>s.setName('play').setDescription('View the world dashboard and available activities.'));
base.addSubcommand(s=>s.setName('create').setDescription('Create your character.').addStringOption(o=>o.setName('name').setDescription('Character name').setRequired(true).setMaxLength(30)).addStringOption(o=>o.setName('class').setDescription('Class ID shown by /nexora classes').setRequired(true).setMaxLength(40)));
base.addSubcommand(s=>s.setName('profile').setDescription('View your character profile.'));
base.addSubcommand(s=>s.setName('classes').setDescription('List available character classes.'));
base.addSubcommand(s=>s.setName('regions').setDescription('List regions in this server world.'));
base.addSubcommand(s=>s.setName('explore').setDescription('Travel to a region.').addStringOption(o=>o.setName('region').setDescription('Region ID, e.g. whispering_woods').setRequired(true).setMaxLength(40)));
base.addSubcommand(s=>s.setName('quests').setDescription('List quests and your current progress.'));
base.addSubcommand(s=>s.setName('quest-start').setDescription('Start tracking a quest.').addStringOption(o=>o.setName('quest_id').setDescription('Quest ID shown by /nexora quests').setRequired(true).setMaxLength(40)));
base.addSubcommand(s=>s.setName('quest-claim').setDescription('Claim a completed quest reward.').addStringOption(o=>o.setName('quest_id').setDescription('Quest ID').setRequired(true).setMaxLength(40)));
base.addSubcommand(s=>s.setName('fight').setDescription('Fight a server-calculated enemy in your current region.'));
base.addSubcommand(s=>s.setName('inventory').setDescription('View your inventory.'));
base.addSubcommand(s=>s.setName('shop').setDescription('View items available in the world shop.'));
base.addSubcommand(s=>s.setName('buy').setDescription('Buy an item with your world currency.').addStringOption(o=>o.setName('item_id').setDescription('Item ID shown in the shop').setRequired(true).setMaxLength(40)).addIntegerOption(o=>o.setName('quantity').setDescription('Quantity (1–10)').setMinValue(1).setMaxValue(10)));
base.addSubcommand(s=>s.setName('craft').setDescription('Craft an item using its configured recipe.').addStringOption(o=>o.setName('item_id').setDescription('Craftable item ID').setRequired(true).setMaxLength(40)));
base.addSubcommand(s=>s.setName('leaderboard').setDescription('Show this server’s NEXORA leaderboard.'));
base.addSubcommand(s=>s.setName('backup').setDescription('Export NEXORA settings, world data, and player progress as a JSON file.').addBooleanOption(o=>o.setName('include_players').setDescription('Include character and inventory progress (default true)')));
base.addSubcommand(s=>s.setName('restore').setDescription('Preview and restore a NEXORA JSON backup.').addAttachmentOption(o=>o.setName('file').setDescription('NEXORA backup JSON').setRequired(true)).addBooleanOption(o=>o.setName('include_players').setDescription('Restore player progress too (default true)')));
base.addSubcommand(s=>s.setName('template-save').setDescription('Save the world definitions as a reusable cross-server template.').addStringOption(o=>o.setName('name').setDescription('Template name').setRequired(true).setMaxLength(60)));
base.addSubcommand(s=>s.setName('template-load').setDescription('Preview and load a reusable NEXORA template by code.').addStringOption(o=>o.setName('code').setDescription('Template code').setRequired(true).setMaxLength(20)));

const commands=[{data:base,async execute(i){
  if(!i.guild) return i.reply({content:'NEXORA can only be used in a server.',ephemeral:true});
  const sub=i.options.getSubcommand(); const s=seedWorld(i.guildId) || getSettings(i.guildId);
  if(sub==='setup') {
    if(!requireAdmin(i)) return i.reply(adminError());
    const token=crypto.randomBytes(5).toString('hex'); sessions.set(token,{token,guildId:i.guildId,userId:i.user.id,expiresAt:now()+15*60*1000,section:'dashboard'});
    const reply=await i.reply({embeds:[dashboardEmbed(i.guildId)],components:sectionRowsForSession(sessions.get(token),'dashboard'),ephemeral:true,fetchReply:true});
    const session=sessions.get(token);session.messageId=reply?.id||null; return;
  }
  const requiredModule = ({play:'world',create:'characters',profile:'characters',classes:'classes',regions:'exploration',explore:'exploration',quests:'quests','quest-start':'quests','quest-claim':'quests',fight:'combat',inventory:'inventory',shop:'trading',buy:'trading',craft:'crafting',leaderboard:'leaderboards',backup:'backup',restore:'backup','template-save':'backup','template-load':'backup'})[sub];
  if(requiredModule && !s.modules[requiredModule]) return i.reply({embeds:[ui.warnEmbed('Module disabled',`An administrator disabled the **${requiredModule}** module for this server. No game data was changed.`)],ephemeral:true});
  if(sub==='play') { if(!starterCheck(i))return; const regions=sql.prepare('SELECT name,description,minLevel,difficulty FROM nexora_regions WHERE guildId=? ORDER BY minLevel LIMIT 10').all(i.guildId);return i.reply({embeds:[new EmbedBuilder().setColor(0x8B5CF6).setTitle(`✦ ${safeText(s.gameName,80)}`).setDescription(`${safeText(s.worldTitle,100)}\n${safeText(s.description,500)}\n\n**Difficulty:** ${s.difficulty} • **Currency:** ${s.currencySymbol} ${s.currencyName}\n**Your character:** ${getCharacter(i.guildId,i.user.id)?'Created':'Not created yet'}\n\n**Regions**\n${regions.map(r=>`• **${safeText(r.name,70)}** — level ${r.minLevel}+ (${r.difficulty})`).join('\n')}`).setFooter({text:'Create a character with /nexora create'})],ephemeral:true}); }
  if(!starterCheck(i)) return;
  if(sub==='create') return characterCreate(i);
  if(sub==='profile'){const c=getCharacter(i.guildId,i.user.id);return c?i.reply({embeds:[characterEmbed(i.guild,i.user,c)],ephemeral:true}):i.reply({embeds:[ui.warnEmbed('No character','Use `/nexora create` to start your adventure.')],ephemeral:true});}
  if(sub==='classes'){const rows=sql.prepare('SELECT classId,name,description,hp,attack,defense FROM nexora_classes WHERE guildId=? ORDER BY name').all(i.guildId);return i.reply({embeds:[new EmbedBuilder().setColor(0x8B5CF6).setTitle('Available Classes').setDescription(rows.map(x=>`**${safeText(x.name,80)}** · ID \`${x.classId}\`\n${safeText(x.description,200)}\nHP ${x.hp} • ATK ${x.attack} • DEF ${x.defense}`).join('\n\n').slice(0,4000)||'No classes available.')],ephemeral:true});}
  if(sub==='regions'){const c=getCharacter(i.guildId,i.user.id);const rows=sql.prepare('SELECT * FROM nexora_regions WHERE guildId=? ORDER BY minLevel,name').all(i.guildId);return i.reply({embeds:[new EmbedBuilder().setColor(0x8B5CF6).setTitle('World Regions').setDescription(rows.map(r=>`**${safeText(r.name,70)}** · ID \`${r.regionId}\`\nLevel ${r.minLevel}+ • ${r.difficulty} • Travel cost ${s.currencySymbol}${r.travelCost}${c&&c.level<r.minLevel?' — 🔒 level too low':''}\n${safeText(r.description,180)}`).join('\n\n').slice(0,4000))],ephemeral:true});}
  if(sub==='explore'){
    const c=requireCharacter(i);if(!c)return; if(!s.modules.exploration)return i.reply({embeds:[ui.warnEmbed('Exploration disabled','An administrator disabled exploration.')],ephemeral:true});
    const remain=cooldownRemaining(i.guildId,i.user.id,'travel');if(remain) return i.reply({embeds:[ui.warnEmbed('Travel cooldown',`Wait ${(remain/1000).toFixed(1)} seconds before travelling again.`)],ephemeral:true});
    const id=slug(i.options.getString('region',true));const r=sql.prepare('SELECT * FROM nexora_regions WHERE guildId=? AND regionId=?').get(i.guildId,id);if(!r)return i.reply({embeds:[ui.errorEmbed('Region not found','Use `/nexora regions` to see valid region IDs.')],ephemeral:true});if(c.level<r.minLevel)return i.reply({embeds:[ui.warnEmbed('Region locked',`You need level **${r.minLevel}** to enter **${r.name}**.`)],ephemeral:true});if(c.coins<r.travelCost)return i.reply({embeds:[ui.warnEmbed('Not enough currency',`Travel costs ${s.currencySymbol}${r.travelCost}; you have ${s.currencySymbol}${c.coins}.`)],ephemeral:true});
    const tx=sql.transaction(()=>{const fresh=getCharacter(i.guildId,i.user.id);if(!fresh||fresh.coins<r.travelCost)throw new Error('Currency changed before travel.');sql.prepare('UPDATE nexora_characters SET coins=coins-?,regionId=?,updatedAt=? WHERE guildId=? AND userId=?').run(r.travelCost,r.regionId,now(),i.guildId,i.user.id);sql.prepare('INSERT INTO nexora_ledger(guildId,userId,action,currencyDelta,xpDelta,reference,createdAt) VALUES(?,?,?,?,?,?,?)').run(i.guildId,i.user.id,'travel',-r.travelCost,0,`travel:${i.id}`,now());});try{tx();}catch(e){return i.reply({embeds:[ui.errorEmbed('Travel failed',e.message)],ephemeral:true});}
    setCooldown(i.guildId,i.user.id,'travel',Math.max(1,Number(s.travelCooldownSeconds)||10)*1000);trackObjective(i.guildId,i.user.id,'explore',1);const loc=sql.prepare('SELECT * FROM nexora_characters WHERE guildId=? AND userId=?').get(i.guildId,i.user.id);return i.reply({embeds:[new EmbedBuilder().setColor(0x22C55E).setTitle(`Discovered: ${r.name}`).setDescription(`${safeText(r.description,800)}\n\n**Difficulty:** ${r.difficulty}\n**Travel cost:** ${s.currencySymbol}${r.travelCost}\n**Remaining:** ${s.currencySymbol}${loc.coins}\n\nExploration progress has been updated for any active quests.`)],ephemeral:true});
  }
  if(sub==='quests') {const c=getCharacter(i.guildId,i.user.id);if(!c)return i.reply({embeds:[ui.warnEmbed('No character','Create a character first.')],ephemeral:true});const rows=sql.prepare('SELECT q.*,p.progress,p.completedAt,p.claimedAt FROM nexora_quests q LEFT JOIN nexora_quest_progress p ON p.guildId=q.guildId AND p.questId=q.questId AND p.userId=? WHERE q.guildId=? AND q.enabled=1 AND q.minLevel<=? ORDER BY q.name').all(i.user.id,i.guildId,c.level);return i.reply({embeds:[new EmbedBuilder().setColor(0x8B5CF6).setTitle('Quest Journal').setDescription(rows.map(q=>`**${safeText(q.name,90)}** · ID \`${q.questId}\`\n${safeText(q.description,200)}\nProgress: ${q.claimedAt?'✅ Claimed':q.completedAt?'🏆 Ready to claim':`${q.progress||0}/${q.goal} • ${q.objective}`}\nReward: ${q.rewardXp} XP / ${s.currencySymbol}${q.rewardCoins}`).join('\n\n').slice(0,4000)||'No available quests.')],ephemeral:true});}
  if(sub==='quest-start') {const c=requireCharacter(i);if(!c)return;const q=sql.prepare('SELECT * FROM nexora_quests WHERE guildId=? AND questId=? AND enabled=1').get(i.guildId,slug(i.options.getString('quest_id',true)));if(!q)return i.reply({embeds:[ui.errorEmbed('Quest not found','That quest does not exist or is disabled.')],ephemeral:true});if(c.level<q.minLevel)return i.reply({embeds:[ui.warnEmbed('Level requirement',`This quest requires level ${q.minLevel}.`)],ephemeral:true});const p=sql.prepare('SELECT * FROM nexora_quest_progress WHERE guildId=? AND userId=? AND questId=?').get(i.guildId,i.user.id,q.questId);if(p?.claimedAt&&!q.repeatable)return i.reply({embeds:[ui.warnEmbed('Already claimed','This quest can only be claimed once.')],ephemeral:true});if(p?.claimedAt&&q.repeatable)sql.prepare('UPDATE nexora_quest_progress SET progress=0,startedAt=?,completedAt=NULL,claimedAt=NULL WHERE guildId=? AND userId=? AND questId=?').run(now(),i.guildId,i.user.id,q.questId);else sql.prepare('INSERT OR IGNORE INTO nexora_quest_progress(guildId,userId,questId,progress,startedAt) VALUES(?,?,?,?,?)').run(i.guildId,i.user.id,q.questId,0,now());return i.reply({embeds:[ui.okEmbed('Quest started',`**${q.name}**\n${q.description}\n\nTrack progress with \`/nexora quests\`.`)],ephemeral:true});}
  if(sub==='quest-claim') {const c=requireCharacter(i);if(!c)return;const q=sql.prepare('SELECT * FROM nexora_quests WHERE guildId=? AND questId=? AND enabled=1').get(i.guildId,slug(i.options.getString('quest_id',true)));if(!q)return i.reply({embeds:[ui.errorEmbed('Quest not found','That quest does not exist or is disabled.')],ephemeral:true});const tx=sql.transaction(()=>{const p=sql.prepare('SELECT * FROM nexora_quest_progress WHERE guildId=? AND userId=? AND questId=?').get(i.guildId,i.user.id,q.questId);if(!p||p.progress<q.goal)throw new Error('Objective is not complete yet.');if(p.claimedAt&&!q.repeatable)throw new Error('This reward has already been claimed.');const ref=`quest:${q.questId}:${q.repeatable?p.startedAt:'once'}`;const inserted=sql.prepare('INSERT OR IGNORE INTO nexora_ledger(guildId,userId,action,currencyDelta,xpDelta,reference,createdAt) VALUES(?,?,?,?,?,?,?)').run(i.guildId,i.user.id,'quest_reward',q.rewardCoins,q.rewardXp,ref,now());if(!inserted.changes)throw new Error('This reward has already been processed.');sql.prepare('UPDATE nexora_characters SET coins=coins+?,updatedAt=? WHERE guildId=? AND userId=?').run(q.rewardCoins,now(),i.guildId,i.user.id);grantXp(i.guildId,i.user.id,q.rewardXp,s);sql.prepare('UPDATE nexora_quest_progress SET claimedAt=?,completedAt=COALESCE(completedAt,?) WHERE guildId=? AND userId=? AND questId=?').run(now(),now(),i.guildId,i.user.id,q.questId);});try{tx();}catch(e){return i.reply({embeds:[ui.warnEmbed('Cannot claim reward',e.message)],ephemeral:true});}return i.reply({embeds:[ui.okEmbed('Quest rewards claimed',`**${q.name}**\n+${q.rewardXp} XP\n+${s.currencySymbol}${q.rewardCoins}`)],ephemeral:true});}
  if(sub==='fight') {
    const c=requireCharacter(i);if(!c)return;if(!s.modules.combat)return i.reply({embeds:[ui.warnEmbed('Combat disabled','An administrator disabled combat.')],ephemeral:true});const remain=cooldownRemaining(i.guildId,i.user.id,'battle');if(remain)return i.reply({embeds:[ui.warnEmbed('Battle cooldown',`Wait ${(remain/1000).toFixed(1)} seconds before fighting again.`)],ephemeral:true});const r=sql.prepare('SELECT * FROM nexora_regions WHERE guildId=? AND regionId=?').get(i.guildId,c.regionId);if(!r)return i.reply({embeds:[ui.errorEmbed('Region unavailable','Your current region no longer exists. Ask an administrator to repair the world.')],ephemeral:true});
    const difficulty={Easy:0.7,Normal:1,Hard:1.35,Extreme:1.8,Custom:1}[s.difficulty]||1;const enemyList=[{name:'Moss Slime',hp:25,atk:7,def:1,reward:12},{name:'Wayward Wolf',hp:40,atk:10,def:3,reward:20},{name:'Ashling',hp:55,atk:13,def:5,reward:28}];const baseEnemy=enemyList[Math.min(enemyList.length-1,Math.max(0,Math.floor((r.minLevel-1)/3)))];const enemy={...baseEnemy,hp:Math.round((baseEnemy.hp+(r.minLevel-1)*6)*difficulty),atk:Math.round((baseEnemy.atk+(r.minLevel-1)*1.5)*difficulty),def:Math.round(baseEnemy.def*difficulty)};let playerHp=c.hp,enemyHp=enemy.hp,rounds=0,lines=[];while(playerHp>0&&enemyHp>0&&rounds<12){rounds++;const damage=Math.max(1,c.attack+Math.floor(Math.random()*7)-enemy.def);enemyHp=Math.max(0,enemyHp-damage);lines.push(`Round ${rounds}: you dealt ${damage} damage.`);if(enemyHp>0){const hit=Math.max(1,enemy.atk+Math.floor(Math.random()*5)-c.defense);playerHp=Math.max(0,playerHp-hit);lines.push(`${enemy.name} dealt ${hit} damage.`);}}
    const won=enemyHp===0;const coins=won?Math.min(500,Math.max(1,Math.round((enemy.reward+r.minLevel*3)*difficulty))):0;const xp=won?Math.min(1000,Math.max(5,Math.round((enemy.reward*2+r.minLevel*5)*difficulty))):Math.max(1,Math.floor(r.minLevel*2));const tx=sql.transaction(()=>{const ref=`battle:${i.id}`;sql.prepare('INSERT INTO nexora_ledger(guildId,userId,action,currencyDelta,xpDelta,reference,createdAt) VALUES(?,?,?,?,?,?,?)').run(i.guildId,i.user.id,won?'battle_win':'battle_loss',won?coins:0,xp,ref,now());sql.prepare('UPDATE nexora_characters SET hp=?,coins=coins+?,updatedAt=? WHERE guildId=? AND userId=?').run(Math.max(1,playerHp||Math.floor(c.maxHp*.5)),coins,now(),i.guildId,i.user.id);grantXp(i.guildId,i.user.id,xp,s);if(won){const gather=Math.random()<0.55?'iron_ore':'wood';const itemRow=sql.prepare('SELECT stackLimit FROM nexora_items WHERE guildId=? AND itemId=?').get(i.guildId,gather);const invRow=sql.prepare('SELECT quantity FROM nexora_inventory WHERE guildId=? AND userId=? AND itemId=?').get(i.guildId,i.user.id,gather);if(itemRow&&(invRow?.quantity||0)<Math.min(itemRow.stackLimit,s.security.maxInventoryStack))addInventory(i.guildId,i.user.id,gather,1);}});try{tx();}catch(e){return i.reply({embeds:[ui.errorEmbed('Battle failed','The battle could not be saved safely. No reward was claimed.')],ephemeral:true});}setCooldown(i.guildId,i.user.id,'battle',Math.max(1,Number(s.battleCooldownSeconds)||30)*1000);if(won)trackObjective(i.guildId,i.user.id,'battle',1);const latest=getCharacter(i.guildId,i.user.id);const log=lines.slice(0,16).join('\n');return i.reply({embeds:[new EmbedBuilder().setColor(won?0x22C55E:0xEF4444).setTitle(won?`Victory — ${enemy.name}`:`Defeat — ${enemy.name}`).setDescription(`${log}\n\n**Enemy HP:** ${enemyHp}/${enemy.hp}\n**Your HP:** ${latest.hp}/${latest.maxHp}\n**Rewards:** ${won?`${s.currencySymbol}${coins} and ${xp} XP plus one resource`:`${xp} XP for the attempt`}`)],ephemeral:true});
  }
  if(sub==='inventory'){const c=requireCharacter(i);if(!c)return;const rows=sql.prepare('SELECT i.itemId,i.name,i.itemType,i.rarity,inv.quantity FROM nexora_inventory inv JOIN nexora_items i ON i.guildId=inv.guildId AND i.itemId=inv.itemId WHERE inv.guildId=? AND inv.userId=? AND inv.quantity>0 ORDER BY i.name').all(i.guildId,i.user.id);return i.reply({embeds:[new EmbedBuilder().setColor(0x8B5CF6).setTitle(`${c.name} — Inventory`).setDescription(rows.map(x=>`• **${safeText(x.name,70)}** ×${x.quantity} · ${x.rarity} · \`${x.itemId}\``).join('\n').slice(0,4000)||'Your inventory is empty. Fight enemies to find resources, or buy an item from `/nexora shop`.')],ephemeral:true});}
  if(sub==='shop'){const rows=sql.prepare('SELECT itemId,name,description,itemType,rarity,price FROM nexora_items WHERE guildId=? ORDER BY price,name LIMIT 25').all(i.guildId);return i.reply({embeds:[new EmbedBuilder().setColor(0x8B5CF6).setTitle('World Shop').setDescription(rows.map(x=>`**${safeText(x.name,70)}** · \`${x.itemId}\` · ${s.currencySymbol}${x.price}\n${safeText(x.description,140)} · ${x.itemType} (${x.rarity})`).join('\n\n').slice(0,4000)||'The shop is empty.')],ephemeral:true});}
  if(sub==='buy'){const c=requireCharacter(i);if(!c)return;const item=sql.prepare('SELECT * FROM nexora_items WHERE guildId=? AND itemId=?').get(i.guildId,slug(i.options.getString('item_id',true)));if(!item)return i.reply({embeds:[ui.errorEmbed('Item not found','Use `/nexora shop` to find valid item IDs.')],ephemeral:true});const qty=i.options.getInteger('quantity')||1;const total=item.price*qty;if(!Number.isSafeInteger(total)||total<0||total>1_000_000_000)return i.reply({embeds:[ui.errorEmbed('Invalid purchase','The price is outside allowed bounds.')],ephemeral:true});const tx=sql.transaction(()=>{const fresh=getCharacter(i.guildId,i.user.id);if(!fresh||fresh.coins<total)throw new Error('Not enough currency.');const inv=sql.prepare('SELECT quantity FROM nexora_inventory WHERE guildId=? AND userId=? AND itemId=?').get(i.guildId,i.user.id,item.itemId);if((inv?.quantity||0)+qty>Math.min(item.stackLimit,s.security.maxInventoryStack))throw new Error('Inventory stack limit reached.');sql.prepare('UPDATE nexora_characters SET coins=coins-?,updatedAt=? WHERE guildId=? AND userId=?').run(total,now(),i.guildId,i.user.id);addInventory(i.guildId,i.user.id,item.itemId,qty);sql.prepare('INSERT INTO nexora_ledger(guildId,userId,action,currencyDelta,xpDelta,reference,createdAt) VALUES(?,?,?,?,?,?,?)').run(i.guildId,i.user.id,'shop_purchase',-total,0,`buy:${i.id}`,now());});try{tx();}catch(e){return i.reply({embeds:[ui.warnEmbed('Purchase rejected',e.message)],ephemeral:true});}return i.reply({embeds:[ui.okEmbed('Purchase complete',`Bought **${qty}× ${item.name}** for ${s.currencySymbol}${total}.`)],ephemeral:true});}
  if(sub==='craft'){const c=requireCharacter(i);if(!c)return;const item=sql.prepare('SELECT * FROM nexora_items WHERE guildId=? AND itemId=?').get(i.guildId,slug(i.options.getString('item_id',true)));if(!item)return i.reply({embeds:[ui.errorEmbed('Item not found','That item is not registered in this world.')],ephemeral:true});let d={};try{d=JSON.parse(item.data||'{}');}catch{}const recipe=d.recipe;if(!Array.isArray(recipe)||!recipe.length)return i.reply({embeds:[ui.warnEmbed('Not craftable','This item does not have a crafting recipe configured.')],ephemeral:true});const ingredientTotals=new Map();for(const ing of recipe){if(!/^[a-z0-9_]{1,40}$/.test(String(ing.itemId||''))||!Number.isInteger(ing.quantity)||ing.quantity<1||ing.quantity>100)return i.reply({embeds:[ui.errorEmbed('Invalid recipe','Each ingredient must have a valid item ID and quantity from 1–100.')],ephemeral:true});ingredientTotals.set(ing.itemId,(ingredientTotals.get(ing.itemId)||0)+ing.quantity);}const normalizedRecipe=[...ingredientTotals].map(([itemId,quantity])=>({itemId,quantity}));if(normalizedRecipe.some(x=>x.quantity>1000))return i.reply({embeds:[ui.errorEmbed('Invalid recipe','Combined ingredient quantity cannot exceed 1,000 per item.')],ephemeral:true});const tx=sql.transaction(()=>{const outputInv=sql.prepare('SELECT quantity FROM nexora_inventory WHERE guildId=? AND userId=? AND itemId=?').get(i.guildId,i.user.id,item.itemId);if((outputInv?.quantity||0)+1>Math.min(item.stackLimit,s.security.maxInventoryStack))throw new Error('Inventory stack limit reached for the crafted item.');for(const ing of normalizedRecipe){const inv=sql.prepare('SELECT quantity FROM nexora_inventory WHERE guildId=? AND userId=? AND itemId=?').get(i.guildId,i.user.id,ing.itemId);if((inv?.quantity||0)<ing.quantity)throw new Error(`Not enough ingredients: ${ing.itemId} ×${ing.quantity}.`);}for(const ing of normalizedRecipe){sql.prepare('UPDATE nexora_inventory SET quantity=quantity-? WHERE guildId=? AND userId=? AND itemId=?').run(ing.quantity,i.guildId,i.user.id,ing.itemId);}addInventory(i.guildId,i.user.id,item.itemId,1);sql.prepare('DELETE FROM nexora_inventory WHERE guildId=? AND userId=? AND quantity<=0').run(i.guildId,i.user.id);sql.prepare('INSERT INTO nexora_ledger(guildId,userId,action,currencyDelta,xpDelta,reference,createdAt) VALUES(?,?,?,?,?,?,?)').run(i.guildId,i.user.id,'craft',0,0,`craft:${i.id}`,now());});try{tx();}catch(e){return i.reply({embeds:[ui.warnEmbed('Crafting failed',e.message)],ephemeral:true});}return i.reply({embeds:[ui.okEmbed('Crafting complete',`Created **${item.name}**.`)],ephemeral:true});}
  if(sub==='leaderboard'){const rows=sql.prepare('SELECT userId,name,level,xp,coins FROM nexora_characters WHERE guildId=? ORDER BY level DESC,xp DESC LIMIT 10').all(i.guildId);return i.reply({embeds:[new EmbedBuilder().setColor(0x8B5CF6).setTitle('NEXORA Leaderboard').setDescription(rows.map((x,n)=>`**${n+1}.** <@${x.userId}> — **Lv. ${x.level} ${safeText(x.name,40)}** · ${x.xp} XP · ${s.currencySymbol}${x.coins}`).join('\n')||'No characters have been created yet.')],ephemeral:false,allowedMentions:{parse:[]}});}
  if(sub==='backup') {if(!requireAdmin(i))return i.reply(adminError());const data=makeBackup(i.guildId,i.options.getBoolean('include_players')!==false);const file=new AttachmentBuilder(Buffer.from(JSON.stringify(data,null,2)),{name:`nexora-${i.guildId}-${Date.now()}.json`});audit(i.guildId,i.user.id,'backup_export',`Players included: ${!!data.characters}`);return i.reply({embeds:[ui.okEmbed('NEXORA backup created',`Version ${data.schemaVersion}. Contains ${data.regions.length} regions, ${data.classes.length} classes, ${data.items.length} items and ${data.quests.length} quests.${data.characters?` Includes ${data.characters.length} characters.`:''}\nKeep this file somewhere outside Railway's volume.`)],files:[file],ephemeral:true});}
  if(sub==='restore') {if(!requireAdmin(i))return i.reply(adminError());const a=i.options.getAttachment('file',true);if(a.size>5*1024*1024)return i.reply({embeds:[ui.errorEmbed('Backup too large','NEXORA restore accepts JSON files up to 5 MB.')],ephemeral:true});let data;try{const res=await fetch(a.url);if(!res.ok)throw new Error(`Download failed (${res.status}).`);data=await res.json();validateBackup(data);}catch(e){return i.reply({embeds:[ui.errorEmbed('Backup rejected',safeText(e.message||'Invalid backup',500))],ephemeral:true});}const token=crypto.randomBytes(5).toString('hex');restoreSessions.set(token,{guildId:i.guildId,userId:i.user.id,data,includePlayers:i.options.getBoolean('include_players')!==false,expiresAt:now()+5*60*1000});const preview=`**Source guild:** ${safeText(data.guildId||'unknown',40)}\n**Version:** ${data.schemaVersion}\n**Regions:** ${data.regions.length}\n**Classes:** ${data.classes.length}\n**Items:** ${data.items.length}\n**Quests:** ${data.quests.length}\n**Characters:** ${data.characters?.length||0}\n**Player data:** ${i.options.getBoolean('include_players')!==false?'will be restored':'will be skipped'}\n\nThis replaces/updates matching NEXORA definitions only. Unrelated AunXz settings are untouched.`;return i.reply({embeds:[ui.warnEmbed('Restore preview — confirmation required',preview)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`nexora:restore-confirm:${token}`).setLabel('Confirm restore').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId(`nexora:restore-cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))],ephemeral:true});}
  if(sub==='template-save') {if(!requireAdmin(i))return i.reply(adminError());const name=safeText(i.options.getString('name',true).trim(),60);if(name.length<2)return i.reply({embeds:[ui.errorEmbed('Invalid name','Template name must contain at least 2 characters.')],ephemeral:true});const d=makeBackup(i.guildId,false);const payload={format:'NEXORA-TEMPLATE',schemaVersion:1,settings:d.settings,regions:d.regions,classes:d.classes,items:d.items,quests:d.quests};const code=`NX-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;sql.prepare('INSERT INTO nexora_templates(code,createdGuildId,createdBy,name,payload,createdAt) VALUES(?,?,?,?,?,?)').run(code,i.guildId,i.user.id,name,JSON.stringify(payload),now());audit(i.guildId,i.user.id,'template_save',`${name} (${code})`);return i.reply({embeds:[ui.okEmbed('Template saved',`**${name}**\nTemplate code: \`${code}\`\nThis template contains world definitions only, no player data or secrets. Use \`/nexora template-load code:${code}\` in the destination server.`)],ephemeral:true});}
  if(sub==='template-load') {if(!requireAdmin(i))return i.reply(adminError());const code=i.options.getString('code',true).trim().toUpperCase();const row=sql.prepare('SELECT * FROM nexora_templates WHERE code=?').get(code);if(!row)return i.reply({embeds:[ui.errorEmbed('Template not found','Check the template code. Templates currently reside in this bot database and are shared across guilds only while that database is retained.')],ephemeral:true});let data;try{data=JSON.parse(row.payload);}catch{return i.reply({embeds:[ui.errorEmbed('Template invalid','Stored template could not be parsed.')],ephemeral:true});}if(data.format!=='NEXORA-TEMPLATE'||data.schemaVersion!==1)return i.reply({embeds:[ui.errorEmbed('Unsupported template','This template version is not supported.')],ephemeral:true});const token=crypto.randomBytes(5).toString('hex');restoreSessions.set(token,{guildId:i.guildId,userId:i.user.id,data:{...data,format:'NEXORA-BACKUP',guildId:row.createdGuildId,schemaVersion:1},includePlayers:false,expiresAt:now()+5*60*1000});return i.reply({embeds:[ui.warnEmbed('Template preview',`**${safeText(row.name,60)}**\nRegions: ${data.regions.length} • Classes: ${data.classes.length} • Items: ${data.items.length} • Quests: ${data.quests.length}\n\nApplying this template does not import player data.`)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`nexora:restore-confirm:${token}`).setLabel('Apply template').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`nexora:restore-cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))],ephemeral:true});}
}}];

async function handleInteraction(i) {
  if(!i.customId?.startsWith('nexora:')) return false;
  const bits=i.customId.split(':');
  if(bits[1]==='restore-confirm'||bits[1]==='restore-cancel') {
    if(!i.guildId||!requireAdmin(i)) {await i.reply(adminError()).catch(()=>{});return true;}
    const token=bits[2], session=restoreSessions.get(token);
    if(!session||session.expiresAt<now()||session.guildId!==i.guildId||session.userId!==i.user.id){restoreSessions.delete(token);await i.reply({embeds:[ui.warnEmbed('Restore session expired','Run the restore or template-load command again.')],ephemeral:true}).catch(()=>{});return true;}
    restoreSessions.delete(token);
    if(bits[1]==='restore-cancel') {await i.update({embeds:[ui.warnEmbed('Cancelled','No NEXORA data was changed.')],components:[]}).catch(()=>{});return true;}
    try{applyBackup(i.guildId,i.user.id,session.data,session.includePlayers);await i.update({embeds:[ui.okEmbed('NEXORA restored',`World definitions restored successfully. ${session.includePlayers?'Player progress was included when present.':'Player progress was not imported.'} Existing matching definitions were updated; unrelated bot settings were not touched.`)],components:[]});}catch(e){await i.update({embeds:[ui.errorEmbed('Restore failed',safeText(e.message||e,700))],components:[]}).catch(()=>{});}return true;
  }
  if(bits[1]==='section' && bits.length===2) return true;
  if(bits[1]==='modal') return true;
  const token=bits[1]; let session=sessions.get(token);
  if(!session||session.expiresAt<now()) {sessions.delete(token);if(i.isRepliable()) await i.reply({embeds:[ui.warnEmbed('Setup expired','Run `/nexora setup` again to open a fresh setup panel.')],ephemeral:true}).catch(()=>{});return true;}
  if(!i.guildId||i.guildId!==session.guildId||!requireAdmin(i)){await i.reply(adminError()).catch(()=>{});return true;}
  session.expiresAt=now()+15*60*1000;
  const action=bits.slice(2).join(':');
  if(action==='section' && i.isStringSelectMenu()) {session.section=i.values[0];await i.update({embeds:[sectionEmbedSession(session,session.section)],components:sectionRowsForSession(session,session.section)});return true;}
  if(action.startsWith('section:')) {session.section=action.split(':')[1];await i.update({embeds:[sectionEmbedSession(session,session.section)],components:sectionRowsForSession(session,session.section)});return true;}
  if(action==='back'){session.section='dashboard';await i.update({embeds:[dashboardEmbed(session.guildId)],components:sectionRowsForSession(session,'dashboard')});return true;}
  if(action==='toggle-system'){const cfg=saveSettings(session.guildId,{enabled:!getSettings(session.guildId).enabled},i.user.id);await i.update({embeds:[dashboardEmbed(session.guildId)],components:sectionRowsForSession(session,'dashboard')});return true;}
  if(action.startsWith('toggle:')){const mod=action.slice(7);if(!AVAILABLE.has(mod)){await i.reply({embeds:[ui.warnEmbed('Module unavailable','That module has no gameplay handler in this build; it cannot be enabled.')],ephemeral:true});return true;}const cfg=getSettings(session.guildId);saveSettings(session.guildId,{modules:{[mod]:!cfg.modules[mod]}},i.user.id);await i.update({embeds:[dashboardEmbed(session.guildId,session.section)],components:sectionRowsForSession(session,session.section)});return true;}
  if(action==='preset'&&i.isStringSelectMenu()){const p=presetPatch(i.values[0]);const names={fantasy:'Fantasy RPG',anime:'Anime Adventure',minecraft:'Minecraft Survival',casual:'Casual Community Games',cooperative:'Cooperative World Adventure',blank:'Custom Blank World'};saveSettings(session.guildId,{...p,gameName:'NEXORA',worldTitle:names[i.values[0]],theme:p.theme,modules:i.values[0]==='blank'?{world:false,exploration:false,combat:false,quests:false}:{}},i.user.id);session.section='dashboard';await i.update({embeds:[dashboardEmbed(session.guildId)],components:sectionRowsForSession(session,'dashboard')});return true;}
  if(action==='edit-general'){return showGeneralModal(i,session);}
  if(action==='add-region')return showAddRegionModal(i,session);
  if(action==='add-class')return showAddClassModal(i,session);
  if(action==='add-quest')return showAddQuestModal(i,session);
  if(action==='add-item')return showAddItemModal(i,session);
  if(action==='channel-picker'){await i.reply({embeds:[new EmbedBuilder().setColor(0x8B5CF6).setTitle('Channel settings').setDescription('Select a NEXORA command channel from the selector below.')],components:sectionRowsForSession(session,'channels'),ephemeral:true});return true;}
  if(action==='channel-select'&&i.isChannelSelectMenu()){const ch=i.guild.channels.cache.get(i.values[0]);if(!ch?.isTextBased()){await i.reply({content:'Select a text channel.',ephemeral:true});return true;}saveSettings(session.guildId,{commandChannelId:ch.id},i.user.id);session.section='channels';await i.update({embeds:[dashboardEmbed(session.guildId,'channels')],components:sectionRowsForSession(session,'channels')});return true;}
  if(action==='backup-info'){await i.reply({embeds:[ui.infoEmbed('NEXORA Backup & Restore','Use `/nexora backup` to export JSON and store it outside the Railway volume. Use `/nexora restore file:<attachment>` to preview and then explicitly confirm a restore. Only NEXORA tables are modified.')],ephemeral:true});return true;}
  if(action.startsWith('modal:')&&i.isModalSubmit()) {
    const kind=action.slice(6);const v=id=>i.fields.getTextInputValue(id).trim();
    try {
      if(kind==='general') {const diff=v('difficulty');if(!['easy','normal','hard','extreme','custom'].includes(diff.toLowerCase()))throw new Error('Difficulty must be Easy, Normal, Hard, Extreme, or Custom.');const patch={gameName:safeText(v('gameName'),80),worldTitle:safeText(v('worldTitle'),100),currencyName:safeText(v('currencyName'),30),currencySymbol:safeText(v('currencySymbol'),8),difficulty:diff[0].toUpperCase()+diff.slice(1).toLowerCase()};if(!patch.gameName||!patch.worldTitle||!patch.currencyName||!patch.currencySymbol)throw new Error('Game, world, currency name, and symbol cannot be empty.');saveSettings(session.guildId,patch,i.user.id);session.section='general';}
      else if(kind==='region'){const name=safeText(v('name'),70);const minLevel=Number(v('minLevel')),cost=Number(v('travelCost')),difficulty=v('difficulty');if(!name||!Number.isInteger(minLevel)||minLevel<1||minLevel>200||!Number.isInteger(cost)||cost<0||cost>1000000)throw new Error('Level must be 1–200 and travel cost 0–1,000,000.');if(!['easy','normal','hard','extreme'].includes(difficulty.toLowerCase()))throw new Error('Difficulty must be Easy, Normal, Hard, or Extreme.');sql.prepare('INSERT INTO nexora_regions(guildId,regionId,name,description,difficulty,minLevel,travelCost,data) VALUES(?,?,?,?,?,?,?,?)').run(session.guildId,slug(name),name,safeText(v('description'),700),difficulty[0].toUpperCase()+difficulty.slice(1).toLowerCase(),minLevel,cost,'{}');audit(session.guildId,i.user.id,'region_create',name);session.section='world';}
      else if(kind==='class'){const name=safeText(v('name'),70),hp=Number(v('hp')),attack=Number(v('attack')),defense=Number(v('defense'));if(!name||!Number.isInteger(hp)||hp<20||hp>1000||!Number.isInteger(attack)||attack<1||attack>250||!Number.isInteger(defense)||defense<0||defense>200)throw new Error('HP must be 20–1000, attack 1–250, defense 0–200.');sql.prepare('INSERT INTO nexora_classes(guildId,classId,name,description,hp,attack,defense,data) VALUES(?,?,?,?,?,?,?,?)').run(session.guildId,slug(name),name,safeText(v('description'),500),hp,attack,defense,'{}');audit(session.guildId,i.user.id,'class_create',name);session.section='classes';}
      else if(kind==='quest'){const name=safeText(v('name'),80),objective=v('objective').toLowerCase(),goal=Number(v('goal')),rewards=v('rewards').split(',').map(Number);if(!name||!['explore','battle'].includes(objective))throw new Error('Objective type must be explore or battle.');if(!Number.isInteger(goal)||goal<1||goal>1000)throw new Error('Goal must be an integer from 1–1000.');if(rewards.length!==2||rewards.some(n=>!Number.isInteger(n)||n<0||n>5000))throw new Error('Rewards must be two non-negative integers up to 5000: XP,coins.');sql.prepare('INSERT INTO nexora_quests(guildId,questId,name,description,objective,goal,rewardXp,rewardCoins,minLevel,enabled,repeatable,data) VALUES(?,?,?,?,?,?,?,?,1,1,0,?)').run(session.guildId,slug(name),name,safeText(v('description'),500),objective,goal,rewards[0],rewards[1],'{}');audit(session.guildId,i.user.id,'quest_create',name);session.section='quests';}
      else if(kind==='item'){const id=slug(v('id')),name=safeText(v('name'),70),price=Number(v('price')),type=v('type').toLowerCase();if(!/^[a-z0-9_]{1,40}$/.test(id)||!name)throw new Error('Provide a valid item ID and name.');if(!Number.isInteger(price)||price<0||price>1000000)throw new Error('Price must be 0–1,000,000.');if(!['material','equipment','consumable'].includes(type))throw new Error('Type must be material, equipment, or consumable.');sql.prepare('INSERT INTO nexora_items(guildId,itemId,name,description,itemType,rarity,price,stackLimit,attackBonus,defenseBonus,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(session.guildId,id,name,safeText(v('description'),400),type,'Common',price,type==='equipment'?1:99,0,0,'{}');audit(session.guildId,i.user.id,'item_create',`${id} ${name}`);session.section='inventory';}
      await i.reply({embeds:[ui.okEmbed('NEXORA settings saved','The change was validated and stored in this server’s database. Press Refresh in your setup panel to view it.')],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`nexora:${session.token}:section:${session.section}`).setLabel('Refresh setup panel').setStyle(ButtonStyle.Primary))],ephemeral:true});
    } catch(e){await i.reply({embeds:[ui.errorEmbed('Could not save setting',safeText(e.message||e,800))],ephemeral:true}).catch(()=>{});}return true;
  }
  await i.reply({embeds:[ui.warnEmbed('NEXORA control','This control is not available in this version.')],ephemeral:true}).catch(()=>{});return true;
}

module.exports={commands,handleInteraction,makeBackup,validateBackup,getSettings,_internals:{sql,SECTION_LIST,AVAILABLE,trackObjective,xpNeeded}};

};

__modules["logging.js"] = function(module, exports, require, __filename, __dirname) {
const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType, PermissionFlagsBits,
  PermissionsBitField, AuditLogEvent, AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const db = require('./database');
const ui = require('./ui');
const sql = db.db;
const now = () => Date.now();
const clip = (v, n = 1000) => String(v ?? '').replace(/@everyone/gi, '@\u200beveryone').replace(/@here/gi, '@\u200bhere').slice(0, n) || '—';
const sid = v => String(v ?? '');
const safeId = v => /^\d{15,25}$/.test(sid(v));
const perms = PermissionsBitField.Flags;
const DANGEROUS = new Set(['Administrator','ManageGuild','ManageRoles','ManageChannels','ManageWebhooks','ManageMessages','BanMembers','KickMembers','ModerateMembers','MentionEveryone','ManageGuildExpressions','ManageEvents']);

const CATEGORIES = {
  messages: { label:'Messages', events:[['messageCreate','Message created',false],['messageDelete','Message deleted',true],['messageUpdate','Message edited',true],['messageDeleteBulk','Bulk deletion',true],['messagePin','Message pinned/unpinned',true],['reactionAdd','Reaction added',false],['reactionRemove','Reaction removed',false]] },
  members: { label:'Members', events:[['memberJoin','Member joined',true],['memberLeave','Member left',true],['memberUpdate','Member profile updated',true],['memberRoleAdd','Member roles added',true],['memberRoleRemove','Member roles removed',true],['memberBanAdd','Member banned',true],['memberBanRemove','Member unbanned',true]] },
  invites: { label:'Invites', events:[['inviteCreate','Invite created',true],['inviteDelete','Invite deleted',true],['inviteJoin','Join attribution',true]] },
  roles: { label:'Roles & Permissions', events:[['roleCreate','Role created',true],['roleDelete','Role deleted',true],['roleUpdate','Role properties updated',true],['rolePermissions','Exact permission differences',true],['channelOverwriteUpdate','Channel overwrite changes',true]] },
  channels: { label:'Channels & Threads', events:[['channelCreate','Channel created',true],['channelDelete','Channel deleted',true],['channelUpdate','Channel updated',true],['threadCreate','Thread created',true],['threadDelete','Thread deleted',true]] },
  server: { label:'Server Settings', events:[['guildUpdate','Server settings updated',true]] },
  moderation: { label:'Moderation', events:[['moderationKick','Member kicked',true],['moderationTimeout','Timeout changed',true],['moderationBan','Ban/unban events',true]] },
  voice: { label:'Voice & Stage', events:[['voiceJoin','Joined voice',true],['voiceLeave','Left voice',true],['voiceMove','Moved voice channel',true],['voiceMute','Mute state changed',true],['voiceDeafen','Deafen state changed',true],['voiceOther','Video/stream/stage changes',true]] },
  emojis: { label:'Emojis & Stickers', events:[['emojiCreate','Emoji created',true],['emojiDelete','Emoji deleted',true],['emojiUpdate','Emoji updated',true],['stickerCreate','Sticker created',true],['stickerDelete','Sticker deleted',true],['stickerUpdate','Sticker updated',true]] },
  webhooks: { label:'Webhooks & Integrations', events:[['webhookUpdate','Webhook list updated',true],['botAdd','Bot/application added',true]] },
  scheduled: { label:'Scheduled Events', events:[['scheduledCreate','Scheduled event created',true],['scheduledUpdate','Scheduled event updated',true],['scheduledDelete','Scheduled event deleted',true]] },
  security: { label:'Security & AntiNuke', events:[['securityBurst','Suspicious change burst',true],['securityDangerousRole','Dangerous permission granted',true]] },
  bot: { label:'Bot & System', events:[['botReady','Bot startup',true],['commandExecuted','Command executed',false]] },
  tickets: { label:'Tickets & Staff', events:[['ticketActivity','Ticket/staff activity',true]] },
  economy: { label:'Economy & Levels', events:[['economyActivity','Economy/level activity',true]] },
  other: { label:'Other Events', events:[['otherReaction','Other supported events',true]] }
};
const DEFAULT_CONFIG = {
  enabled:true, categories:Object.fromEntries(Object.keys(CATEGORIES).map(k=>[k,true])), events:Object.fromEntries(Object.values(CATEGORIES).flatMap(c=>c.events.map(([k,_l,v])=>[k,v]))),
  channels:{}, sharedChannelId:null, detail:'detailed', contentCapture:true, attachmentCapture:true, retentionDays:3,
  ignoredChannelIds:[], ignoredUserIds:[], ignoredRoleIds:[], inviteTracking:true,
  security:{burstThreshold:5,windowSeconds:10,alertCooldownSeconds:30}, timezone:'UTC'
};
const sessions = new Map();
const attached = new WeakSet();
const messageCache = new Map();
const inviteCache = new Map();
const guildLocks = new Map();
const consumedAudit = new Map();
const burstEvents = new Map();
const burstAlertAt = new Map();
let cachedMessages = 0;
const MAX_MESSAGES_PER_CHANNEL = 250;
const MAX_MESSAGES_GLOBAL = 20000;

sql.exec(`
CREATE TABLE IF NOT EXISTS log_v2_config (guildId TEXT PRIMARY KEY, data TEXT NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS log_v2_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, guildId TEXT NOT NULL, actorId TEXT, action TEXT NOT NULL, detail TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_log_v2_audit_guild_time ON log_v2_audit(guildId,createdAt DESC);
CREATE TABLE IF NOT EXISTS log_v2_message_cache (guildId TEXT NOT NULL, channelId TEXT NOT NULL, messageId TEXT NOT NULL, authorId TEXT, authorName TEXT, content TEXT NOT NULL DEFAULT '', createdAt INTEGER NOT NULL, attachments TEXT NOT NULL DEFAULT '[]', referenceId TEXT, updatedAt INTEGER NOT NULL, PRIMARY KEY(guildId,channelId,messageId));
CREATE INDEX IF NOT EXISTS idx_log_v2_msg_context ON log_v2_message_cache(guildId,channelId,messageId DESC);
CREATE INDEX IF NOT EXISTS idx_log_v2_msg_retention ON log_v2_message_cache(guildId,updatedAt);
CREATE TABLE IF NOT EXISTS log_v2_invites (guildId TEXT NOT NULL, code TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0, inviterId TEXT, expiresAt INTEGER, updatedAt INTEGER NOT NULL, PRIMARY KEY(guildId,code));
CREATE TABLE IF NOT EXISTS log_v2_join_history (guildId TEXT NOT NULL, userId TEXT NOT NULL, joinedAt INTEGER NOT NULL, inviteCode TEXT, inviterId TEXT, confidence TEXT NOT NULL, PRIMARY KEY(guildId,userId,joinedAt));
CREATE INDEX IF NOT EXISTS idx_log_v2_join_inviter ON log_v2_join_history(guildId,inviterId,joinedAt DESC);
`);

function merge(base, next) {
  const out = { ...base };
  for (const [k,v] of Object.entries(next || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? merge(out[k],v) : v;
  }
  return out;
}
function getConfig(guildId) {
  let row;
  try { row = sql.prepare('SELECT data FROM log_v2_config WHERE guildId=?').get(guildId); } catch { row = null; }
  let saved = {}; try { saved = row ? JSON.parse(row.data) : {}; } catch { saved = {}; }
  return merge(DEFAULT_CONFIG, saved);
}
function recordAudit(guildId, actorId, action, detail) {
  try { sql.prepare('INSERT INTO log_v2_audit(guildId,actorId,action,detail,createdAt) VALUES(?,?,?,?,?)').run(guildId,actorId||null,action,clip(detail,1500),now()); } catch (e) { console.warn('[logging] audit write failed:',e?.message||e); }
}
function saveConfig(guildId, patch, actorId, action='settings_update') {
  const next = merge(getConfig(guildId), patch);
  sql.prepare('INSERT INTO log_v2_config(guildId,data,updatedAt) VALUES(?,?,?) ON CONFLICT(guildId) DO UPDATE SET data=excluded.data,updatedAt=excluded.updatedAt').run(guildId,JSON.stringify(next),now());
  recordAudit(guildId,actorId,action,JSON.stringify(patch));
  return next;
}
function isAdmin(i) {
  return !!i.guild && (i.guild.ownerId === i.user.id || i.memberPermissions?.has(PermissionFlagsBits.Administrator) || i.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}
function adminError() { return { embeds:[ui.errorEmbed('Administrator only','Manage Server or Administrator is required to configure logging.')],ephemeral:true }; }
function fmtTime(ms) { return ms ? `<t:${Math.floor(ms/1000)}:F>` : 'Unknown'; }
function jump(guildId,channelId,messageId) { return safeId(guildId)&&safeId(channelId)&&safeId(messageId) ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}` : null; }
function embed(guild, title, description, fields=[]) {
  const e = new EmbedBuilder().setColor(0x8B5CF6).setTitle(clip(title,256)).setTimestamp(new Date());
  if (description) e.setDescription(clip(description,4000));
  const fs = fields.filter(f=>f && f.value != null).slice(0,25).map(f=>({name:clip(f.name,256),value:clip(f.value,1024),inline:!!f.inline}));
  if (fs.length) e.addFields(fs);
  e.setFooter({text:`${clip(guild?.name||'Discord Server',90)} • ${guild?.id||''} • AunXz Logging`});
  return e;
}
function eventStatus(cfg, cat, key) { return cfg.enabled && cfg.categories[cat] !== false && cfg.events[key] !== false; }
function skipped(guildId, cfg, channelId, userId, member=null) {
  if ((cfg.ignoredChannelIds||[]).includes(sid(channelId))) return true;
  if (userId && (cfg.ignoredUserIds||[]).includes(sid(userId))) return true;
  if (member && (cfg.ignoredRoleIds||[]).some(id=>member.roles?.cache?.has(id))) return true;
  return false;
}
async function resolveLogChannel(guild, cfg, category) {
  const channelId = cfg.channels?.[category] || cfg.sharedChannelId;
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(()=>null);
  if (!channel?.isTextBased?.() || channel.isDMBased?.()) return null;
  const me = guild.members.me;
  const permissions = me ? channel.permissionsFor(me) : null;
  if (permissions && (!permissions.has(PermissionFlagsBits.SendMessages) || !permissions.has(PermissionFlagsBits.EmbedLinks))) return null;
  return channel;
}
async function sendLog(guild, category, eventKey, logEmbed, extra={}) {
  try {
    if (!guild?.id) return false;
    const cfg = getConfig(guild.id);
    if (!extra.force && !eventStatus(cfg,category,eventKey)) return false;
    if (skipped(guild.id,cfg,extra.channelId,extra.userId,extra.member)) return false;
    const channel = await resolveLogChannel(guild,cfg,category);
    if (!channel) return false;
    if (extra.files?.length) await channel.send({embeds:[logEmbed],files:extra.files,allowedMentions:{parse:[]}});
    else await channel.send({embeds:[logEmbed],allowedMentions:{parse:[]}});
    return true;
  } catch (e) { console.warn(`[logging] delivery failed (${category}/${eventKey}):`,e?.message||e); return false; }
}
function attachmentData(m) {
  const cfg = getConfig(m.guildId || m.guild?.id);
  if (!cfg.attachmentCapture) return [];
  const items = m.attachments?.values ? [...m.attachments.values()] : [];
  return items.slice(0,30).map(a=>({id:a.id,name:a.name||'attachment',size:a.size||0,contentType:a.contentType||null,url:a.url||null}));
}
function cacheChannelKey(guildId,channelId) { return `${guildId}:${channelId}`; }
function cacheGet(guildId,channelId,messageId) {
  const ch = messageCache.get(cacheChannelKey(guildId,channelId));
  if (ch?.has(sid(messageId))) return ch.get(sid(messageId));
  try {
    const r = sql.prepare('SELECT * FROM log_v2_message_cache WHERE guildId=? AND channelId=? AND messageId=?').get(guildId,channelId,sid(messageId));
    if (!r) return null;
    return {guildId:r.guildId,channelId:r.channelId,messageId:r.messageId,authorId:r.authorId,authorName:r.authorName,content:r.content,createdAt:r.createdAt,attachments:JSON.parse(r.attachments||'[]'),referenceId:r.referenceId,updatedAt:r.updatedAt};
  } catch { return null; }
}
function cacheSet(m) {
  const guildId = m.guildId || m.guild?.id;
  if (!guildId || !m.channelId || !m.id) return null;
  const cfg = getConfig(guildId);
  const snap = {guildId,channelId:m.channelId,messageId:sid(m.id),authorId:m.author?.id||null,authorName:m.member?.displayName||m.author?.tag||m.author?.username||'Unknown',content:cfg.contentCapture?String(m.content||'').slice(0,5000):'',createdAt:m.createdTimestamp||now(),attachments:attachmentData(m),referenceId:m.reference?.messageId||null,updatedAt:now()};
  const key=cacheChannelKey(guildId,m.channelId);
  if(!messageCache.has(key)) messageCache.set(key,new Map());
  const entries=messageCache.get(key);
  if(!entries.has(snap.messageId)) cachedMessages++;
  entries.set(snap.messageId,snap);
  if(entries.size>MAX_MESSAGES_PER_CHANNEL){const sorted=[...entries.keys()].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);const remove=entries.size-MAX_MESSAGES_PER_CHANNEL;for(let x=0;x<remove;x++){entries.delete(sorted[x]);cachedMessages--;}}
  if(cfg.contentCapture && cfg.retentionDays>0){
    try {
      const up=sql.prepare('INSERT INTO log_v2_message_cache(guildId,channelId,messageId,authorId,authorName,content,createdAt,attachments,referenceId,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(guildId,channelId,messageId) DO UPDATE SET authorId=excluded.authorId,authorName=excluded.authorName,content=excluded.content,attachments=excluded.attachments,referenceId=excluded.referenceId,updatedAt=excluded.updatedAt');
      up.run(snap.guildId,snap.channelId,snap.messageId,snap.authorId,snap.authorName,snap.content,snap.createdAt,JSON.stringify(snap.attachments),snap.referenceId,snap.updatedAt);
      if(Math.random()<0.02){const cutoff=now()-Math.max(1,Math.min(30,cfg.retentionDays))*86400000;sql.prepare('DELETE FROM log_v2_message_cache WHERE guildId=? AND updatedAt<?').run(guildId,cutoff);sql.prepare('DELETE FROM log_v2_message_cache WHERE guildId=? AND rowid NOT IN (SELECT rowid FROM log_v2_message_cache WHERE guildId=? ORDER BY updatedAt DESC LIMIT 5000)').run(guildId,guildId);}
    } catch(e){console.warn('[logging] evidence cache write failed:',e?.message||e);}
  }
  while(cachedMessages>MAX_MESSAGES_GLOBAL){const first=messageCache.keys().next().value;if(!first)break;const map=messageCache.get(first);const id=map?.keys().next().value;if(id&&map.delete(id))cachedMessages--;if(!map?.size)messageCache.delete(first);}
  return snap;
}
function cacheDelete(guildId,channelId,messageId){const key=cacheChannelKey(guildId,channelId),map=messageCache.get(key);if(map?.delete(sid(messageId)))cachedMessages--;if(map&&!map.size)messageCache.delete(key);try{sql.prepare('DELETE FROM log_v2_message_cache WHERE guildId=? AND channelId=? AND messageId=?').run(guildId,channelId,sid(messageId));}catch{}}
function snowCompare(a,b){try{return BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;}catch{return 0;}}
async function findContext(message, direction, cfg) {
  const guildId=message.guildId||message.guild?.id, channelId=message.channelId, target=sid(message.id);
  const map=messageCache.get(cacheChannelKey(guildId,channelId));
  if(map?.size){const candidates=[...map.values()].filter(x=>direction==='previous'?snowCompare(x.messageId,target)<0:snowCompare(x.messageId,target)>0).sort((a,b)=>snowCompare(a.messageId,b.messageId)*(direction==='previous'?-1:1));if(candidates.length)return candidates[0];}
  if(!message.channel?.messages?.fetch)return null;
  try{
    const fetched=await message.channel.messages.fetch({[direction==='previous'?'before':'after']:target,limit:20});
    const candidates=[...fetched.values()].filter(x=>x.id!==target && (direction==='previous'?snowCompare(x.id,target)<0:snowCompare(x.id,target)>0)).sort((a,b)=>snowCompare(a.id,b.id)*(direction==='previous'?-1:1));
    const m=candidates[0];if(!m)return null;
    return {guildId,channelId,messageId:m.id,authorId:m.author?.id,authorName:m.member?.displayName||m.author?.tag||m.author?.username||'Unknown',content:cfg.contentCapture?String(m.content||'').slice(0,5000):'',createdAt:m.createdTimestamp,attachments:attachmentData(m),referenceId:m.reference?.messageId||null};
  }catch{return null;}
}
function contextField(label,snap,guildId,channelId){if(!snap)return {name:label,value:'Unavailable — no reliable preceding/following message was found.'};const link=jump(guildId,channelId,snap.messageId);return {name:label,value:`**${clip(snap.authorName,100)}**${snap.authorId?` (\`${snap.authorId}\`)`:''}\n${clip(snap.content||'[content not captured]',600)}\n${fmtTime(snap.createdAt)}${link?` • [Jump to message](${link})`:''}`};}
function attachmentText(items){if(!items?.length)return 'None captured';return items.slice(0,12).map(a=>`• ${clip(a.name,90)} (${a.size||0} bytes)${a.url?` — ${a.url}`:''}`).join('\n').slice(0,1000);}
function contentText(s){return s ? `\`\`\`\n${String(s).replace(/```/g,'ˋˋˋ').slice(0,850)}\n\`\`\`` : '[content unavailable or not captured]';}
function auditConsumed(guildId, entryId){const k=`${guildId}:${entryId}`;const ttl=consumedAudit.get(k);if(ttl&&ttl>now())return true;consumedAudit.set(k,now()+60000);if(consumedAudit.size>3000){for(const [key,until] of consumedAudit)if(until<now())consumedAudit.delete(key);}return false;}
async function attribute(guild, action, targetId, eventTime=now()) {
  if(!action||!targetId||!guild?.members?.me?.permissions?.has(PermissionFlagsBits.ViewAuditLog))return {actor:null,confidence:'Unknown',source:'Discord did not provide reliable attribution',reason:null};
  const lockKey=`${guild.id}:${action}`;const old=guildLocks.get(lockKey)||Promise.resolve();let release;const gate=new Promise(r=>release=r);guildLocks.set(lockKey,old.then(()=>gate));await old.catch(()=>{});
  try{
    for(let attempt=0;attempt<2;attempt++){
      if(attempt) await new Promise(r=>setTimeout(r,350));
      const logs=await guild.fetchAuditLogs({type:action,limit:8}).catch(()=>null);if(!logs)continue;
      const all=[...logs.entries.values()].filter(e=>sid(e.target?.id)===sid(targetId)&&Math.abs(Number(e.createdTimestamp||0)-Number(eventTime))<=8000&&!auditConsumed(guild.id,e.id));
      if(all.length===1){const entry=all[0];auditConsumed(guild.id,entry.id);return {actor:entry.executor||null,confidence:'High',source:'Matched audit-log action, target and timestamp',reason:entry.reason||null,entryId:entry.id};}
      if(all.length>1)return {actor:null,confidence:'Unknown',source:'Multiple plausible audit-log entries; attribution is ambiguous',reason:null};
    }
    return {actor:null,confidence:'Unknown',source:'No unique matching audit-log entry',reason:null};
  }finally{release();}
}
function attributionFields(a){return [{name:'Actor',value:a?.actor?`${a.actor.tag||a.actor.username} (<@${a.actor.id}>)`:'Unknown — Discord did not provide reliable attribution.'},{name:'Attribution',value:`${a?.confidence||'Unknown'} • ${clip(a?.source||'Not available',450)}`},...(a?.reason?[{name:'Audit reason',value:clip(a.reason,900)}]:[])];}
function permissionDiff(before,after){
  const b=BigInt(before||0),a=BigInt(after||0),enabled=[],disabled=[];let knownMask=0n;
  const seenBits=new Set();for(const [name,bitValue] of Object.entries(perms)){let bit;try{bit=BigInt(bitValue);}catch{continue;}if(bit===0n)continue;knownMask|=bit;const bitKey=bit.toString();if(seenBits.has(bitKey))continue;seenBits.add(bitKey);const was=(b&bit)!==0n,is=(a&bit)!==0n;if(!was&&is)enabled.push({name,danger:DANGEROUS.has(name)});else if(was&&!is)disabled.push({name,danger:DANGEROUS.has(name)});}
  const unknownEnabled=(~b&a)&~knownMask,unknownDisabled=(b&~a)&~knownMask;
  if(unknownEnabled)enabled.push({name:`Unknown permission bits 0x${unknownEnabled.toString(16)}`,danger:true});
  if(unknownDisabled)disabled.push({name:`Unknown permission bits 0x${unknownDisabled.toString(16)}`,danger:false});
  return {enabled,disabled,unchangedCount:Math.max(0,Object.keys(perms).length-enabled.length-disabled.length)};
}
function formatPermissionItems(items){return items.map(p=>`${p.danger?'⚠️ ':''}• ${p.name}`).join('\n').slice(0,1000);}
function permissionFields(diff){const out=[];if(diff.enabled.length)out.push({name:'✅ Enabled Permissions',value:formatPermissionItems(diff.enabled)});if(diff.disabled.length)out.push({name:'❌ Disabled Permissions',value:formatPermissionItems(diff.disabled)});return out;}
function textDiffChanged(oldText,newText){return String(oldText||'')!==String(newText||'');}
async function logMessageDelete(message,bulk=false){
  const guild=message.guild;if(!guild)return;const cfg=getConfig(guild.id);const saved=cacheGet(guild.id,message.channelId,message.id);const content=cfg.contentCapture?(saved?.content||(!message.partial?String(message.content||''):'')):'';
  const previous=await findContext(message,'previous',cfg);const next=await findContext(message,'next',cfg);const createdAt=saved?.createdAt||message.createdTimestamp||null;const attachments=cfg.attachmentCapture?(saved?.attachments||attachmentData(message)):[];
  const fields=[{name:'Author',value:`${clip(saved?.authorName||message.member?.displayName||message.author?.tag||'Unknown',150)}${message.author?.id?` (<@${message.author.id}>)`:''}\nID: \`${message.author?.id||saved?.authorId||'unknown'}\``},{name:'Channel',value:`<#${message.channelId}> (\`${message.channelId}\`)`},{name:'Message ID',value:`\`${message.id}\``},{name:'Created',value:fmtTime(createdAt)},{name:'Deleted / detected',value:fmtTime(now())},{name:'Message age',value:createdAt?`${Math.max(0,Math.round((now()-createdAt)/60000))} minutes`:'Unknown'},{name:'Original content',value:contentText(content)},{name:'Attachments',value:attachmentText(attachments)},contextField('Previous Message — Context',previous,guild.id,message.channelId),contextField('Next Message — Context',next,guild.id,message.channelId),{name:'Evidence source',value:saved?'Captured before deletion':'Limited — message was not in the logger cache'}];
  const emb=embed(guild,bulk?'Message Deleted (Bulk Evidence)':'Message Deleted',`${bulk?'Bulk deletion evidence':'A message was deleted'} in <#${message.channelId}>. ${jump(guild.id,message.channelId,message.id)?`[Message link](${jump(guild.id,message.channelId,message.id)})`:''}`,fields);
  await sendLog(guild,'messages',bulk?'messageDeleteBulk':'messageDelete',emb,{channelId:message.channelId,userId:message.author?.id});cacheDelete(guild.id,message.channelId,message.id);
}
function rememberInvite(guildId, invite){try{sql.prepare('INSERT INTO log_v2_invites(guildId,code,uses,inviterId,expiresAt,updatedAt) VALUES(?,?,?,?,?,?) ON CONFLICT(guildId,code) DO UPDATE SET uses=excluded.uses,inviterId=excluded.inviterId,expiresAt=excluded.expiresAt,updatedAt=excluded.updatedAt').run(guildId,invite.code,invite.uses||0,invite.inviter?.id||null,invite.expiresTimestamp||null,now());}catch{}}
async function refreshInvites(guild){
  if(!guild?.id)return null;const invites=await guild.invites.fetch().catch(()=>null);if(!invites)return null;const map=new Map();for(const inv of invites.values()){map.set(inv.code,{uses:inv.uses||0,inviterId:inv.inviter?.id||null,expiresTimestamp:inv.expiresTimestamp||null});rememberInvite(guild.id,inv);}inviteCache.set(guild.id,map);return map;
}
async function inviteForJoin(member){
  const guild=member.guild;const previous=inviteCache.get(guild.id);const current=await guild.invites.fetch().catch(()=>null);if(!current){sql.prepare('INSERT OR REPLACE INTO log_v2_join_history(guildId,userId,joinedAt,inviteCode,inviterId,confidence) VALUES(?,?,?,?,?,?)').run(guild.id,member.id,now(),null,null,'Unknown');return {code:null,inviterId:null,confidence:'Unknown — invite list unavailable'};}
  const changed=[];for(const inv of current.values()){const old=previous?.get(inv.code);if(old && Number(inv.uses||0)>Number(old.uses||0))changed.push(inv);rememberInvite(guild.id,inv);}
  const result=changed.length===1?{code:changed[0].code,inviterId:changed[0].inviter?.id||null,confidence:'Likely — one invite usage increment detected'}:{code:null,inviterId:null,confidence:changed.length?'Unknown — multiple invite changes were observed':'Unknown — no reliable invite usage change'};
  const map=new Map();for(const inv of current.values())map.set(inv.code,{uses:inv.uses||0,inviterId:inv.inviter?.id||null,expiresTimestamp:inv.expiresTimestamp||null});inviteCache.set(guild.id,map);
  sql.prepare('INSERT OR REPLACE INTO log_v2_join_history(guildId,userId,joinedAt,inviteCode,inviterId,confidence) VALUES(?,?,?,?,?,?)').run(guild.id,member.id,now(),result.code,result.inviterId,result.confidence.startsWith('Likely')?'Likely':'Unknown');return result;
}
function burstTrack(guild, type, target){
  const cfg=getConfig(guild.id), t=now(), key=guild.id;const items=(burstEvents.get(key)||[]).filter(x=>t-x.at<=Math.max(2,Math.min(60,cfg.security.windowSeconds||10)));items.push({at:t,type,target});burstEvents.set(key,items);
  const threshold=Math.max(3,Math.min(50,Number(cfg.security.burstThreshold)||5));if(items.length<threshold)return;
  const last=burstAlertAt.get(key)||0;if(t-last<(cfg.security.alertCooldownSeconds||30)*1000)return;burstAlertAt.set(key,t);
  const types=[...new Set(items.map(x=>x.type))];const emb=embed(guild,'⚠️ Suspicious Change Burst','A high-rate cluster of server changes was observed. This is a signal for review, not proof of an attack.',[{name:'Events in window',value:String(items.length)},{name:'Window',value:`${cfg.security.windowSeconds||10} seconds`},{name:'Event types',value:types.join(', ').slice(0,900)},{name:'Sample targets',value:items.slice(-10).map(x=>`${x.type}: ${clip(x.target,80)}`).join('\n').slice(0,1000)}]);sendLog(guild,'security','securityBurst',emb).catch(()=>{});
}

function moreSettingsEmbed(guildId){const c=getConfig(guildId);return embed({id:guildId,name:'AunXz'},'Logging • Privacy & Advanced Settings','Configure evidence retention, capture policy, invite tracking, ignored entities and security burst thresholds. Changes save to this guild immediately.',[
  {name:'Message content',value:c.contentCapture?'Captured according to retention policy':'Not stored'},
  {name:'Attachment metadata',value:c.attachmentCapture?'Captured where available':'Not stored'},
  {name:'Evidence retention',value:`${c.retentionDays} day(s) • 0 disables persistent evidence storage`},
  {name:'Invite tracking',value:c.inviteTracking?'Enabled; attribution may still be Unknown':'Disabled'},
  {name:'Ignored IDs',value:`Channels: ${(c.ignoredChannelIds||[]).length} • Users: ${(c.ignoredUserIds||[]).length} • Roles: ${(c.ignoredRoleIds||[]).length}`},
  {name:'Security alert threshold',value:`${c.security.burstThreshold} events in ${c.security.windowSeconds}s • cooldown ${c.security.alertCooldownSeconds}s`}
]);}
function moreSettingsRows(guildId){const c=getConfig(guildId);return [
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('logv2:content').setLabel(`Content: ${c.contentCapture?'ON':'OFF'}`).setStyle(c.contentCapture?ButtonStyle.Success:ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('logv2:attachments').setLabel(`Attachments: ${c.attachmentCapture?'ON':'OFF'}`).setStyle(c.attachmentCapture?ButtonStyle.Success:ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('logv2:invites').setLabel(`Invites: ${c.inviteTracking?'ON':'OFF'}`).setStyle(c.inviteTracking?ButtonStyle.Success:ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('logv2:retention').setLabel('Retention').setStyle(ButtonStyle.Primary)
  ),
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('logv2:ignored').setLabel('Ignored Entities').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('logv2:security-settings').setLabel('Security Thresholds').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('logv2:settings-back').setLabel('Back to Dashboard').setStyle(ButtonStyle.Primary)
  )
];}
function openLogModal(i,kind){
  const c=getConfig(i.guildId);const modal=new ModalBuilder();
  const add=(id,label,value,style=TextInputStyle.Short,max=100,required=true)=>{const input=new TextInputBuilder().setCustomId(id).setLabel(label.slice(0,45)).setStyle(style).setRequired(required).setMaxLength(max);if(value!==undefined&&value!==null&&String(value).length)input.setValue(String(value).slice(0,max));modal.addComponents(new ActionRowBuilder().addComponents(input));};
  if(kind==='retention'){modal.setCustomId('logv2:modal:retention').setTitle('Evidence Retention');add('days','Retention days (0–30)',c.retentionDays,TextInputStyle.Short,2,true);}
  else if(kind==='ignored'){modal.setCustomId('logv2:modal:ignored').setTitle('Ignored Entity IDs');add('channels','Ignored channel IDs (comma-separated)',(c.ignoredChannelIds||[]).join(','),TextInputStyle.Short,1000,false);add('users','Ignored user IDs (comma-separated)',(c.ignoredUserIds||[]).join(','),TextInputStyle.Short,1000,false);add('roles','Ignored role IDs (comma-separated)',(c.ignoredRoleIds||[]).join(','),TextInputStyle.Short,1000,false);}
  else {modal.setCustomId('logv2:modal:security').setTitle('Security Alert Thresholds');add('threshold','Burst threshold (3–50)',c.security.burstThreshold,TextInputStyle.Short,2,true);add('window','Window seconds (2–60)',c.security.windowSeconds,TextInputStyle.Short,2,true);add('cooldown','Alert cooldown seconds (5–600)',c.security.alertCooldownSeconds,TextInputStyle.Short,3,true);}
  return i.showModal(modal);
}
function dashboardEmbed(guildId){const cfg=getConfig(guildId);const enabledCats=Object.keys(CATEGORIES).filter(k=>cfg.categories[k]!==false).length;const enabledEvents=Object.values(CATEGORIES).flatMap(c=>c.events).filter(([k])=>cfg.events[k]!==false).length;const destinations=Object.values(cfg.channels||{}).filter(Boolean).length+(cfg.sharedChannelId?1:0);const cats=Object.entries(CATEGORIES).map(([key,v])=>`${cfg.categories[key]===false?'🔴':'🟢'} **${v.label}:** ${cfg.channels?.[key]?`<#${cfg.channels[key]}>`:'No channel'}`).join('\n');return new EmbedBuilder().setColor(0x8B5CF6).setTitle('AunXz • Logging Control Center').setDescription(`**System:** ${cfg.enabled?'Enabled':'Disabled'}\n**Categories enabled:** ${enabledCats}/${Object.keys(CATEGORIES).length}\n**Individual event types enabled:** ${enabledEvents}\n**Configured channels:** ${destinations}\n**Message evidence:** ${cfg.contentCapture?'Enabled':'Disabled'} • retention ${cfg.retentionDays} day(s)\n**Attribution:** strict audit-log matching; unknown when ambiguous\n**Security alerts:** threshold ${cfg.security.burstThreshold} events / ${cfg.security.windowSeconds}s\n\n${cats}`).setFooter({text:'Changes save immediately • Discord attribution may be unavailable'}).setTimestamp();}
function currentCategory(session){return session.category&&CATEGORIES[session.category]?session.category:'messages';}
function setupRows(session){const cfg=getConfig(session.guildId), cat=currentCategory(session), meta=CATEGORIES[cat];const options=Object.entries(CATEGORIES).map(([value,v])=>({label:v.label,value,description:`${cfg.categories[value]===false?'Disabled':'Enabled'} • ${cfg.channels?.[value]?'channel set':'no channel set'}`}));const eventOptions=meta.events.map(([value,label,defaultOn])=>({label:`${cfg.events[value]===false?'OFF':'ON'} • ${label}`.slice(0,100),value,description:`Toggle ${label.toLowerCase()} (default ${defaultOn?'on':'off'})`}));const rows=[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('logv2:category').setPlaceholder(`Category: ${meta.label}`).addOptions(options)),new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('logv2:event').setPlaceholder('Toggle an event in this category').addOptions(eventOptions)),new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('logv2:channel').setPlaceholder(`Set ${meta.label} log channel`).setChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement))];rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('logv2:system').setLabel(cfg.enabled?'Disable system':'Enable system').setStyle(cfg.enabled?ButtonStyle.Danger:ButtonStyle.Success),new ButtonBuilder().setCustomId('logv2:category-toggle').setLabel(cfg.categories[cat]===false?'Enable category':'Disable category').setStyle(cfg.categories[cat]===false?ButtonStyle.Success:ButtonStyle.Secondary),new ButtonBuilder().setCustomId('logv2:enable-all').setLabel('Enable all').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId('logv2:disable-all').setLabel('Disable all').setStyle(ButtonStyle.Secondary)));rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('logv2:test').setLabel('Test logging').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('logv2:shared-open').setLabel('Set shared channel').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('logv2:more').setLabel('More Settings').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('logv2:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('logv2:reset').setLabel('Reset').setStyle(ButtonStyle.Danger)));return rows;}
const command={data:new SlashCommandBuilder().setName('logsetup').setDescription('Open the full customizable logging dashboard.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),async execute(i){if(!i.guild)return i.reply({content:'Use /logsetup inside a server.',ephemeral:true});if(!isAdmin(i))return i.reply(adminError());const key=`${i.guildId}:${i.user.id}`;sessions.set(key,{guildId:i.guildId,userId:i.user.id,category:'messages',expiresAt:now()+15*60*1000});return i.reply({embeds:[dashboardEmbed(i.guildId)],components:setupRows(sessions.get(key)),ephemeral:true});}};
async function handleInteraction(i,client){if(!i.customId?.startsWith('logv2:'))return false;const key=`${i.guildId}:${i.user.id}`,s=sessions.get(key);if(!s||s.expiresAt<now()||!i.guildId||s.guildId!==i.guildId){if(i.isRepliable())await i.reply({embeds:[ui.warnEmbed('Session expired','Run `/logsetup` again to open a fresh panel.')],ephemeral:true}).catch(()=>{});return true;}if(!isAdmin(i)){if(i.isRepliable())await i.reply(adminError()).catch(()=>{});return true;}s.expiresAt=now()+15*60*1000;const cfg=getConfig(i.guildId);const refresh=async()=>i.update({embeds:[dashboardEmbed(i.guildId)],components:setupRows(s)});
  if(i.isStringSelectMenu()&&i.customId==='logv2:category'){if(!CATEGORIES[i.values[0]])return true;s.category=i.values[0];return refresh();}
  if(i.isStringSelectMenu()&&i.customId==='logv2:event'){const e=i.values[0],meta=CATEGORIES[s.category];if(!meta?.events.some(x=>x[0]===e))return true;saveConfig(i.guildId,{events:{[e]:cfg.events[e]===false}},i.user.id,'event_toggle');return refresh();}
  if(i.isChannelSelectMenu()&&i.customId==='logv2:channel'){const ch=i.guild.channels.cache.get(i.values[0]);if(!ch||![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(ch.type))return i.reply({content:'Choose a text or announcement channel.',ephemeral:true});const botPerms=ch.permissionsFor(i.guild.members.me);if(!botPerms?.has([PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks]))return i.reply({embeds:[ui.errorEmbed('Missing bot permissions','I need Send Messages and Embed Links in that channel.')],ephemeral:true});saveConfig(i.guildId,{channels:{[s.category]:ch.id}},i.user.id,'channel_change');return refresh();}
  if(i.isChannelSelectMenu()&&i.customId==='logv2:shared'){const ch=i.guild.channels.cache.get(i.values[0]);if(!ch||![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(ch.type))return i.reply({content:'Choose a text or announcement channel.',ephemeral:true});if(!ch.permissionsFor(i.guild.members.me)?.has([PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks]))return i.reply({content:'I need Send Messages and Embed Links in that channel.',ephemeral:true});saveConfig(i.guildId,{sharedChannelId:ch.id},i.user.id,'shared_channel_change');s.category='messages';return i.update({embeds:[dashboardEmbed(i.guildId)],components:setupRows(s)});}
  if(i.isModalSubmit()&&i.customId.startsWith('logv2:modal:')){
    const kind=i.customId.slice('logv2:modal:'.length);const val=id=>i.fields.getTextInputValue(id).trim();
    try{
      if(kind==='retention'){const days=Number(val('days'));if(!Number.isInteger(days)||days<0||days>30)throw new Error('Retention must be an integer from 0 to 30 days.');saveConfig(i.guildId,{retentionDays:days},i.user.id,'retention_change');}
      else if(kind==='ignored'){const parse=(raw,label)=>{const ids=raw.split(',').map(x=>x.trim()).filter(Boolean);if(ids.length>100)throw new Error(`${label} can contain at most 100 IDs.`);if(ids.some(id=>!/^[0-9]{15,25}$/.test(id)))throw new Error(`${label} must contain valid Discord snowflake IDs separated by commas.`);return [...new Set(ids)];};saveConfig(i.guildId,{ignoredChannelIds:parse(val('channels'),'Ignored channels'),ignoredUserIds:parse(val('users'),'Ignored users'),ignoredRoleIds:parse(val('roles'),'Ignored roles')},i.user.id,'ignored_entities_change');}
      else if(kind==='security'){const threshold=Number(val('threshold')),windowSeconds=Number(val('window')),alertCooldownSeconds=Number(val('cooldown'));if(!Number.isInteger(threshold)||threshold<3||threshold>50)throw new Error('Threshold must be an integer from 3 to 50.');if(!Number.isInteger(windowSeconds)||windowSeconds<2||windowSeconds>60)throw new Error('Window must be an integer from 2 to 60 seconds.');if(!Number.isInteger(alertCooldownSeconds)||alertCooldownSeconds<5||alertCooldownSeconds>600)throw new Error('Cooldown must be an integer from 5 to 600 seconds.');saveConfig(i.guildId,{security:{burstThreshold:threshold,windowSeconds,alertCooldownSeconds}},i.user.id,'security_threshold_change');}
      else throw new Error('Unknown settings form.');
      return i.reply({embeds:[ui.okEmbed('Logging settings saved','Validated settings were saved for this server.')],ephemeral:true});
    }catch(e){return i.reply({embeds:[ui.errorEmbed('Settings not saved',clip(e.message||e,800))],ephemeral:true});}
  }
  if(!i.isButton())return true;
  if(i.customId==='logv2:more')return i.reply({embeds:[moreSettingsEmbed(i.guildId)],components:moreSettingsRows(i.guildId),ephemeral:true});
  else if(i.customId==='logv2:settings-back')return i.update({embeds:[dashboardEmbed(i.guildId)],components:setupRows(s)});
  else if(i.customId==='logv2:content'){saveConfig(i.guildId,{contentCapture:!cfg.contentCapture},i.user.id,'content_capture_toggle');return i.update({embeds:[moreSettingsEmbed(i.guildId)],components:moreSettingsRows(i.guildId)});}
  else if(i.customId==='logv2:attachments'){saveConfig(i.guildId,{attachmentCapture:!cfg.attachmentCapture},i.user.id,'attachment_capture_toggle');return i.update({embeds:[moreSettingsEmbed(i.guildId)],components:moreSettingsRows(i.guildId)});}
  else if(i.customId==='logv2:invites'){saveConfig(i.guildId,{inviteTracking:!cfg.inviteTracking},i.user.id,'invite_tracking_toggle');return i.update({embeds:[moreSettingsEmbed(i.guildId)],components:moreSettingsRows(i.guildId)});}
  else if(i.customId==='logv2:retention')return openLogModal(i,'retention');
  else if(i.customId==='logv2:ignored')return openLogModal(i,'ignored');
  else if(i.customId==='logv2:security-settings')return openLogModal(i,'security');
  else if(i.customId==='logv2:system')saveConfig(i.guildId,{enabled:!cfg.enabled},i.user.id,'system_toggle');
  else if(i.customId==='logv2:category-toggle')saveConfig(i.guildId,{categories:{[s.category]:cfg.categories[s.category]===false}},i.user.id,'category_toggle');
  else if(i.customId==='logv2:enable-all'){saveConfig(i.guildId,{enabled:true,categories:Object.fromEntries(Object.keys(CATEGORIES).map(k=>[k,true])),events:Object.fromEntries(Object.values(CATEGORIES).flatMap(c=>c.events.map(([k])=>[k,true])))},i.user.id,'enable_all');}
  else if(i.customId==='logv2:disable-all'){saveConfig(i.guildId,{enabled:false,categories:Object.fromEntries(Object.keys(CATEGORIES).map(k=>[k,false])),events:Object.fromEntries(Object.values(CATEGORIES).flatMap(c=>c.events.map(([k])=>[k,false])))},i.user.id,'disable_all');}
  else if(i.customId==='logv2:refresh'){}
  else if(i.customId==='logv2:privacy'){saveConfig(i.guildId,{contentCapture:!cfg.contentCapture},i.user.id,'content_capture_toggle');}
  else if(i.customId==='logv2:shared-open'){return i.reply({embeds:[ui.infoEmbed('Shared log channel','Choose a shared destination for categories that do not have their own channel.')],components:[new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('logv2:shared').setPlaceholder('Select shared log channel').setChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement))],ephemeral:true});}
  else if(i.customId==='logv2:test'){const test=embed(i.guild,'Logging Test','This is a real delivery test from the `/logsetup` dashboard.',[{name:'Category',value:CATEGORIES[s.category].label},{name:'Timestamp',value:fmtTime(now())},{name:'Delivery',value:'The bot successfully sent this test event.'}]);const ok=await sendLog(i.guild,s.category,CATEGORIES[s.category].events.find(([k])=>cfg.events[k]!==false)?.[0]||CATEGORIES[s.category].events[0][0],test,{force:true});if(!ok)return i.reply({embeds:[ui.errorEmbed('Test failed','No valid destination is configured for this category, or the bot lacks Send Messages / Embed Links.')],ephemeral:true});return i.reply({embeds:[ui.okEmbed('Test delivered',`A test embed was sent for **${CATEGORIES[s.category].label}**.`)],ephemeral:true});}
  else if(i.customId==='logv2:reset'){return i.reply({embeds:[ui.warnEmbed('Reset logging settings?','This resets logging configuration only. Existing logs and message evidence are not deleted.')],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('logv2:reset-confirm').setLabel('Confirm reset').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId('logv2:reset-cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary))],ephemeral:true});}
  else if(i.customId==='logv2:reset-cancel'){return i.update({embeds:[ui.infoEmbed('Cancelled','Logging settings were not changed.')],components:[]});}
  else if(i.customId==='logv2:reset-confirm'){saveConfig(i.guildId,DEFAULT_CONFIG,i.user.id,'settings_reset');recordAudit(i.guildId,i.user.id,'settings_reset_confirmed','Defaults restored; evidence retained');s.category='messages';return i.update({embeds:[dashboardEmbed(i.guildId)],components:setupRows(s)});}
  return refresh();
}

function addFieldIf(fields,name,value,inline=false){fields.push({name,value:clip(value,1024),inline});}
async function attach(client){if(attached.has(client))return;attached.add(client);
  client.once('ready',()=>{for(const g of client.guilds.cache.values()){const cfg=getConfig(g.id);if(cfg.inviteTracking&&cfg.enabled&&cfg.categories.invites!==false&&(cfg.channels.invites||cfg.sharedChannelId))refreshInvites(g).catch(()=>{});if(eventStatus(cfg,'bot','botReady'))sendLog(g,'bot','botReady',embed(g,'AunXz Online','The bot has connected to Discord.')).catch(()=>{});}});
  client.on('messageCreate',m=>{if(!m.guild)return;try{cacheSet(m);}catch(e){console.warn('[logging] message cache error:',e?.message||e);}if(m.author?.bot)return;const cfg=getConfig(m.guild.id);if(!cfg.events.messageCreate||!eventStatus(cfg,'messages','messageCreate'))return;const fields=[{name:'Author',value:`${clip(m.member?.displayName||m.author.tag,100)} (<@${m.author.id}>)`},{name:'Channel',value:`<#${m.channelId}>`},{name:'Content',value:contentText(cfg.contentCapture?m.content:'[content capture disabled]')},{name:'Attachments',value:attachmentText(attachmentData(m))},{name:'Message',value:`[Jump to message](${m.url})`}];sendLog(m.guild,'messages','messageCreate',embed(m.guild,'Message Created',`A message was posted in <#${m.channelId}>.`,fields),{channelId:m.channelId,userId:m.author.id,member:m.member}).catch(()=>{});});
  client.on('messageUpdate',async(oldM,newM)=>{
    if(!newM.guild)return;
    const cfg=getConfig(newM.guild.id);
    const pinsChanged=Boolean(oldM.pinned)!==Boolean(newM.pinned);
    if(pinsChanged)sendLog(newM.guild,'messages','messagePin',embed(newM.guild,newM.pinned?'Message Pinned':'Message Unpinned',`Message [${newM.id}](${newM.url}) in <#${newM.channelId}> changed pin state.`,[{name:'Author',value:newM.author?`${newM.author.tag} (\`${newM.author.id}\`)`:'Unknown'}]),{channelId:newM.channelId}).catch(()=>{});
    const saved=cacheGet(newM.guild.id,newM.channelId,newM.id);
    const oldText=oldM.partial?(saved?.content||''):(oldM.content??saved?.content??'');
    const newText=String(newM.content||'');
    const oldAttachments=saved?.attachments || (!oldM.partial ? attachmentData(oldM) : []);
    const newAttachments=attachmentData(newM);
    const oldIds=new Set(oldAttachments.map(a=>String(a.id||a.url||a.name)));
    const newIds=new Set(newAttachments.map(a=>String(a.id||a.url||a.name)));
    const addedAttachments=newAttachments.filter(a=>!oldIds.has(String(a.id||a.url||a.name)));
    const removedAttachments=oldAttachments.filter(a=>!newIds.has(String(a.id||a.url||a.name)));
    const attachmentsChanged=addedAttachments.length>0||removedAttachments.length>0;
    const oldEmbeds=!oldM.partial ? JSON.stringify((oldM.embeds||[]).map(e=>e.toJSON?.()||e)) : null;
    const newEmbeds=JSON.stringify((newM.embeds||[]).map(e=>e.toJSON?.()||e));
    const embedsChanged=oldEmbeds!==null&&oldEmbeds!==newEmbeds;
    const contentChanged=oldText!==newText;
    if(!contentChanged&&!attachmentsChanged&&!embedsChanged){cacheSet(newM);return;}
    const previous=await findContext(newM,'previous',cfg);
    const next=await findContext(newM,'next',cfg);
    const attachmentChanges=[...addedAttachments.map(a=>`Added: ${a.name||a.id||'attachment'} (${a.size||0} bytes)${a.url?` — ${a.url}`:''}`),...removedAttachments.map(a=>`Removed: ${a.name||a.id||'attachment'} (${a.size||0} bytes)`)].join('\n');
    const fields=[
      {name:'Author',value:`${clip(saved?.authorName||newM.member?.displayName||newM.author?.tag||'Unknown',120)} (<@${newM.author?.id||saved?.authorId||'unknown'}>)`},
      {name:'Channel',value:`<#${newM.channelId}>`},
      {name:'Message ID',value:`\`${newM.id}\``},
      {name:'Created',value:fmtTime(saved?.createdAt||newM.createdTimestamp)},
      {name:'Edited',value:fmtTime(now())},
      {name:'Original content',value:contentText(cfg.contentCapture?oldText:'[content capture disabled]')},
      {name:'Updated content',value:contentText(cfg.contentCapture?newText:'[content capture disabled]')},
      {name:'Attachment changes',value:cfg.attachmentCapture?(attachmentChanges||'No attachment changes detected'):'Attachment capture disabled'},
      {name:'Embed changes',value:embedsChanged?'Embed data changed (full embed content may not be recoverable).':oldEmbeds===null?'Previous embed state unavailable':'No embed changes detected'},
      contextField('Previous Message — Context',previous,newM.guild.id,newM.channelId),
      contextField('Next Message — Context',next,newM.guild.id,newM.channelId),
      {name:'Actor',value:'Unknown — Discord does not provide reliable attribution for edits to another user’s message.'}
    ];
    sendLog(newM.guild,'messages','messageUpdate',embed(newM.guild,'Message Edited',`Message \`${newM.id}\` in <#${newM.channelId}> changed.`,fields),{channelId:newM.channelId,userId:newM.author?.id,member:newM.member}).catch(()=>{});
    cacheSet(newM);
  });
  client.on('messageDelete',m=>{if(m.guild)logMessageDelete(m,false).catch(e=>console.warn('[logging] delete handler:',e?.message||e));});
  client.on('messageDeleteBulk',async(collection,channel)=>{const guild=channel?.guild;if(!guild)return;const cfg=getConfig(guild.id);const list=[...collection.values()];const lines=[];for(const m of list){const s=cacheGet(guild.id,channel.id,m.id);lines.push({id:m.id,author:s?.authorName||m.author?.tag||'Unknown',userId:s?.authorId||m.author?.id||null,content:cfg.contentCapture?(s?.content||(!m.partial?m.content:'')):'[content capture disabled]',createdAt:s?.createdAt||m.createdTimestamp||null,attachments:s?.attachments||[]});}const summary=embed(guild,'Bulk Message Deletion',`${list.length} message(s) were deleted from <#${channel.id}>. Actor: Unknown — Discord did not provide reliable attribution.`,[{name:'Channel',value:`<#${channel.id}> (\`${channel.id}\`)`},{name:'Count',value:String(list.length)},{name:'Detected',value:fmtTime(now())},{name:'Evidence',value:`${lines.length} message record(s) captured where available.`}]);let files=[];if(lines.length){const body=lines.map(x=>`Message ${x.id}\nAuthor: ${x.author} (${x.userId||'unknown'})\nCreated: ${fmtTime(x.createdAt)}\nContent: ${x.content||'[not captured]'}\nAttachments: ${x.attachments.map(a=>a.url||a.name).join(', ')||'none'}\n`).join('\n------------------------------\n');if(body.length>1000)files=[new AttachmentBuilder(Buffer.from(body,'utf8'),{name:`bulk-delete-${guild.id}-${now()}.txt`})];}await sendLog(guild,'messages','messageDeleteBulk',summary,{channelId:channel.id,files});for(const m of list)cacheDelete(guild.id,channel.id,m.id);});
  client.on('messageReactionAdd',(r,u)=>reactionLog(r,u,'reactionAdd').catch(()=>{}));client.on('messageReactionRemove',(r,u)=>reactionLog(r,u,'reactionRemove').catch(()=>{}));
  client.on('guildMemberAdd',async member=>{const guild=member.guild;let invite={code:null,inviterId:null,confidence:'Unknown'};const cfg=getConfig(guild.id);if(cfg.inviteTracking)invite=await inviteForJoin(member).catch(()=>invite);else sql.prepare('INSERT OR REPLACE INTO log_v2_join_history(guildId,userId,joinedAt,inviteCode,inviterId,confidence) VALUES(?,?,?,?,?,?)').run(guild.id,member.id,now(),null,null,'Disabled');const age=Math.max(0,Math.floor((now()-member.user.createdTimestamp)/86400000));const fields=[{name:'Member',value:`${member.user.tag} (<@${member.id}>)\nID: \`${member.id}\``},{name:'Account created',value:`${fmtTime(member.user.createdTimestamp)} • ${age} day(s) old`},{name:'Joined',value:fmtTime(member.joinedTimestamp||now())},{name:'Member count',value:String(guild.memberCount||'Unknown')},{name:'Invite attribution',value:invite.code?`Code \`${invite.code}\` • inviter <@${invite.inviterId||'unknown'}>\n${invite.confidence}`:invite.confidence}];await sendLog(guild,'members','memberJoin',embed(guild,member.user.bot?'Bot Joined':'Member Joined',`${member} joined **${guild.name}**.`,fields),{userId:member.id,member});});
  client.on('guildMemberRemove',async member=>{const guild=member.guild;const actor=await attribute(guild,AuditLogEvent.MemberKick,member.id,now());const wasKicked=!!actor.actor;const fields=[{name:'Member',value:`${member.user?.tag||member.id} (\`${member.id}\`)`},{name:'Joined',value:fmtTime(member.joinedTimestamp)},{name:'Departure detected',value:fmtTime(now())},{name:'Roles held',value:member.roles?.cache?.filter(r=>r.id!==guild.id).map(r=>`• ${r.name} (\`${r.id}\`)`).join('\n').slice(0,1000)||'Role cache unavailable'},...attributionFields(wasKicked?actor:{actor:null,confidence:'Unknown',source:'A departure alone does not prove a kick'})];await sendLog(guild,'members','memberLeave',embed(guild,wasKicked?'Member Kicked':'Member Left',`${member.user?.tag||member.id} left **${guild.name}**.`,fields),{userId:member.id});if(wasKicked)await sendLog(guild,'moderation','moderationKick',embed(guild,'Member Kicked',`<@${member.id}> was kicked.`,attributionFields(actor)),{userId:member.id});});
  client.on('guildMemberUpdate',async(oldM,newM)=>{const guild=newM.guild;const oldRoles=new Set(oldM.roles.cache.keys()),newRoles=new Set(newM.roles.cache.keys());const added=[...newRoles].filter(x=>!oldRoles.has(x)&&x!==guild.id),removed=[...oldRoles].filter(x=>!newRoles.has(x)&&x!==guild.id);const changed=[];if(oldM.nickname!==newM.nickname)changed.push({name:'Nickname',value:`${clip(oldM.nickname||oldM.user.username,100)} → ${clip(newM.nickname||newM.user.username,100)}`});if(oldM.communicationDisabledUntilTimestamp!==newM.communicationDisabledUntilTimestamp)changed.push({name:'Timeout',value:`${fmtTime(oldM.communicationDisabledUntilTimestamp)} → ${fmtTime(newM.communicationDisabledUntilTimestamp)}`});if(changed.length)await sendLog(guild,'members','memberUpdate',embed(guild,'Member Updated',`${newM.user.tag} (<@${newM.id}>) changed.`,changed),{userId:newM.id,member:newM});if(added.length){const actor=await attribute(guild,AuditLogEvent.MemberRoleUpdate,newM.id,now());await sendLog(guild,'members','memberRoleAdd',embed(guild,'Member Roles Added',`${newM.user.tag} (<@${newM.id}>) gained roles.`,[{name:'Roles Added',value:added.map(id=>`✅ <@&${id}> — \`${id}\``).join('\n').slice(0,1000)},...attributionFields(actor)]),{userId:newM.id,member:newM});}if(removed.length){const actor=await attribute(guild,AuditLogEvent.MemberRoleUpdate,newM.id,now());await sendLog(guild,'members','memberRoleRemove',embed(guild,'Member Roles Removed',`${newM.user.tag} (<@${newM.id}>) lost roles.`,[{name:'Roles Removed',value:removed.map(id=>`❌ <@&${id}> — \`${id}\``).join('\n').slice(0,1000)},...attributionFields(actor)]),{userId:newM.id,member:newM});}if(oldM.communicationDisabledUntilTimestamp!==newM.communicationDisabledUntilTimestamp)await sendLog(guild,'moderation','moderationTimeout',embed(guild,'Member Timeout Changed',`${newM.user.tag} (<@${newM.id}>) timeout status changed.`,[{name:'Before',value:fmtTime(oldM.communicationDisabledUntilTimestamp)},{name:'After',value:fmtTime(newM.communicationDisabledUntilTimestamp)}]),{userId:newM.id,member:newM});});
  client.on('guildBanAdd',async ban=>{const a=await attribute(ban.guild,AuditLogEvent.MemberBanAdd,ban.user.id,now());const fields=[{name:'Target',value:`${ban.user.tag} (\`${ban.user.id}\`)`},...attributionFields(a)];await sendLog(ban.guild,'members','memberBanAdd',embed(ban.guild,'Member Banned',`${ban.user.tag} was banned.`,fields),{userId:ban.user.id});await sendLog(ban.guild,'moderation','moderationBan',embed(ban.guild,'Ban Added',`${ban.user.tag} was banned.`,fields),{userId:ban.user.id});});
  client.on('guildBanRemove',async ban=>{const a=await attribute(ban.guild,AuditLogEvent.MemberBanRemove,ban.user.id,now());const fields=[{name:'Target',value:`${ban.user.tag} (\`${ban.user.id}\`)`},...attributionFields(a)];await sendLog(ban.guild,'members','memberBanRemove',embed(ban.guild,'Member Unbanned',`${ban.user.tag} was unbanned.`,fields),{userId:ban.user.id});await sendLog(ban.guild,'moderation','moderationBan',embed(ban.guild,'Ban Removed',`${ban.user.tag} was unbanned.`,fields),{userId:ban.user.id});});
  client.on('roleCreate',async role=>{const a=await attribute(role.guild,AuditLogEvent.RoleCreate,role.id,now());await sendLog(role.guild,'roles','roleCreate',embed(role.guild,'Role Created',`${role.toString()} (\`${role.id}\`) created.`,[{name:'Color',value:role.hexColor},{name:'Permissions',value:role.permissions.toArray().join(', ')||'None'},...attributionFields(a)]));burstTrack(role.guild,'roleCreate',role.name);if(role.permissions.has(PermissionFlagsBits.Administrator)||role.permissions.has(PermissionFlagsBits.ManageGuild))await sendLog(role.guild,'security','securityDangerousRole',embed(role.guild,'Dangerous Role Created',`${role} was created with elevated permissions.`,[{name:'Permissions',value:role.permissions.toArray().filter(p=>DANGEROUS.has(p)).join(', ')||'Elevated permission bit detected'},...attributionFields(a)]));});
  client.on('roleDelete',async role=>{const a=await attribute(role.guild,AuditLogEvent.RoleDelete,role.id,now());await sendLog(role.guild,'roles','roleDelete',embed(role.guild,'Role Deleted',`**${clip(role.name,100)}** (\`${role.id}\`) deleted.`,[{name:'Permissions before deletion',value:role.permissions.toArray().join(', ').slice(0,1000)||'None'},...attributionFields(a)]));burstTrack(role.guild,'roleDelete',role.name);});
  client.on('roleUpdate',async(oldR,newR)=>{const guild=newR.guild;const diff=permissionDiff(oldR.permissions.bitfield,newR.permissions.bitfield);const other=[];for(const [key,label] of [['name','Name'],['hexColor','Color'],['hoist','Hoist'],['mentionable','Mentionable'],['position','Position']])if(oldR[key]!==newR[key])other.push({name:label,value:`${clip(oldR[key],100)} → ${clip(newR[key],100)}`});if(other.length)await sendLog(guild,'roles','roleUpdate',embed(guild,'Role Updated',`${newR} (\`${newR.id}\`) properties changed.`,other));if(diff.enabled.length||diff.disabled.length){const a=await attribute(guild,AuditLogEvent.RoleUpdate,newR.id,now());const fields=[...permissionFields(diff),{name:'Source',value:'Before/after role permission bitfields from Discord gateway update'},...attributionFields(a)];await sendLog(guild,'roles','rolePermissions',embed(guild,`Role Permission Changes — ${clip(newR.name,100)}`,`Role <@&${newR.id}> (\`${newR.id}\`) permissions changed.`,fields));if(diff.enabled.some(p=>p.danger))await sendLog(guild,'security','securityDangerousRole',embed(guild,'Dangerous Permission Granted',`Role <@&${newR.id}> received one or more elevated permissions.`,[...permissionFields(diff),...attributionFields(a)]));burstTrack(guild,'roleUpdate',newR.name);}});
  client.on('channelCreate',async ch=>{if(!ch.guild)return;const a=await attribute(ch.guild,AuditLogEvent.ChannelCreate,ch.id,now());await sendLog(ch.guild,'channels','channelCreate',embed(ch.guild,'Channel Created',`${ch} (\`${ch.id}\`) created.`,[{name:'Type',value:String(ch.type)},{name:'Category',value:ch.parent?`${ch.parent.name} (\`${ch.parentId}\`)`:'None'},...attributionFields(a)]));burstTrack(ch.guild,'channelCreate',ch.name);});
  client.on('channelDelete',async ch=>{if(!ch.guild)return;const a=await attribute(ch.guild,AuditLogEvent.ChannelDelete,ch.id,now());await sendLog(ch.guild,'channels','channelDelete',embed(ch.guild,'Channel Deleted',`**${clip(ch.name,100)}** (\`${ch.id}\`) deleted.`,[{name:'Type',value:String(ch.type)},{name:'Category before deletion',value:ch.parent?.name||'Unknown'},...attributionFields(a)]));burstTrack(ch.guild,'channelDelete',ch.name);});
  client.on('channelUpdate',async(oldC,newC)=>{if(!newC.guild)return;const changes=[];for(const [k,label] of [['name','Name'],['topic','Topic'],['rateLimitPerUser','Slowmode'],['nsfw','NSFW'],['parentId','Category'],['bitrate','Bitrate'],['userLimit','User limit'],['rtcRegion','RTC region']])if(oldC[k]!==newC[k])changes.push({name:label,value:`${clip(oldC[k],400)} → ${clip(newC[k],400)}`});if(changes.length)await sendLog(newC.guild,'channels','channelUpdate',embed(newC.guild,'Channel Updated',`${newC} (\`${newC.id}\`) settings changed.`,changes));const before=oldC.permissionOverwrites?.cache,after=newC.permissionOverwrites?.cache;if(before&&after){const ids=new Set([...before.keys(),...after.keys()]);for(const id of ids){const b=before.get(id),a=after.get(id);if(!b||!a){const o=a||b;changes.push({name:'Overwrite',value:`${a?'Created':'Deleted'} explicit overwrite for ${o.type===0?`role <@&${id}>`:`member <@${id}>`} (\`${id}\`)`});continue;}const ba=BigInt(b.allow.bitfield),aa=BigInt(a.allow.bitfield),bd=BigInt(b.deny.bitfield),ad=BigInt(a.deny.bitfield);if(ba===aa&&bd===ad)continue;const adiff=permissionDiff(ba,aa),ddiff=permissionDiff(bd,ad);const allowed=adiff.enabled.map(p=>`✅ ${p.name}`).concat(adiff.disabled.map(p=>`❌ removed allow: ${p.name}`));const denied=ddiff.enabled.map(p=>`⛔ ${p.name}`).concat(ddiff.disabled.map(p=>`❌ removed deny: ${p.name}`));await sendLog(newC.guild,'roles','channelOverwriteUpdate',embed(newC.guild,'Channel Permission Overwrite Changed',`Channel ${newC} • target ${a.type===0?`role <@&${id}>`:`member <@${id}>`} (\`${id}\`). Only explicit overwrites are shown; inherited role/category permissions are not represented.`,[{name:'Explicit allow changes',value:allowed.join('\n').slice(0,1000)||'No allow bit changed'},{name:'Explicit deny changes',value:denied.join('\n').slice(0,1000)||'No deny bit changed'}]));}}});
  client.on('guildUpdate',async(oldG,newG)=>{const fields=[];for(const [k,label] of [['name','Name'],['verificationLevel','Verification level'],['defaultMessageNotifications','Default notifications'],['explicitContentFilter','Explicit content filter'],['afkTimeout','AFK timeout'],['afkChannelId','AFK channel'],['systemChannelId','System channel'],['rulesChannelId','Rules channel'],['publicUpdatesChannelId','Updates channel'],['vanityURLCode','Vanity URL']])if(oldG[k]!==newG[k])fields.push({name:label,value:`${clip(oldG[k],200)} → ${clip(newG[k],200)}`});if(fields.length)await sendLog(newG,'server','guildUpdate',embed(newG,'Server Settings Updated','Observable guild settings changed.',fields));});
  client.on('inviteCreate',async inv=>{if(!inv.guild)return;const map=inviteCache.get(inv.guild.id)||new Map();map.set(inv.code,{uses:inv.uses||0,inviterId:inv.inviter?.id||null,expiresTimestamp:inv.expiresTimestamp||null});inviteCache.set(inv.guild.id,map);rememberInvite(inv.guild.id,inv);await sendLog(inv.guild,'invites','inviteCreate',embed(inv.guild,'Invite Created',`Invite \`${inv.code}\` created.`,[{name:'Channel',value:inv.channel?`<#${inv.channel.id}>`:'Unknown'},{name:'Inviter',value:inv.inviter?`${inv.inviter.tag} (<@${inv.inviter.id}>)`:'Unknown'},{name:'Max uses',value:String(inv.maxUses||'Unlimited')},{name:'Expires',value:fmtTime(inv.expiresTimestamp)}]));});
  client.on('inviteDelete',async inv=>{if(!inv.guild)return;inviteCache.get(inv.guild.id)?.delete(inv.code);await sendLog(inv.guild,'invites','inviteDelete',embed(inv.guild,'Invite Deleted',`Invite \`${inv.code}\` was deleted or expired.`,[{name:'Channel',value:inv.channel?`<#${inv.channel.id}>`:'Unknown'},{name:'Original inviter',value:inv.inviter?`<@${inv.inviter.id}>`:'Unknown'}]));});
  client.on('emojiCreate',e=>sendLog(e.guild,'emojis','emojiCreate',embed(e.guild,'Emoji Created',`${e} • \`${e.name}\` (\`${e.id}\`)`)).catch(()=>{}));
  client.on('emojiDelete',e=>sendLog(e.guild,'emojis','emojiDelete',embed(e.guild,'Emoji Deleted',`\`${e.name}\` (\`${e.id}\`) deleted.`)).catch(()=>{}));
  client.on('emojiUpdate',(oldE,newE)=>sendLog(newE.guild,'emojis','emojiUpdate',embed(newE.guild,'Emoji Updated',`\`${oldE.name}\` → \`${newE.name}\` • \`${newE.id}\``)).catch(()=>{}));
  client.on('stickerCreate',s=>sendLog(s.guild,'emojis','stickerCreate',embed(s.guild,'Sticker Created',`**${clip(s.name,100)}** (\`${s.id}\`) created.`)).catch(()=>{}));
  client.on('stickerDelete',s=>sendLog(s.guild,'emojis','stickerDelete',embed(s.guild,'Sticker Deleted',`**${clip(s.name,100)}** (\`${s.id}\`) deleted.`)).catch(()=>{}));
  client.on('stickerUpdate',(oldS,newS)=>sendLog(newS.guild,'emojis','stickerUpdate',embed(newS.guild,'Sticker Updated',`**${clip(oldS.name,100)}** → **${clip(newS.name,100)}** (\`${newS.id}\`)`)).catch(()=>{}));
  client.on('webhookUpdate',ch=>{if(ch.guild)sendLog(ch.guild,'webhooks','webhookUpdate',embed(ch.guild,'Webhook Configuration Changed',`Discord reported webhook changes in ${ch}. The event does not expose secret webhook tokens or reliable individual webhook details.`),{channelId:ch.id}).catch(()=>{});});
  client.on('guildScheduledEventCreate',e=>sendLog(e.guild,'scheduled','scheduledCreate',embed(e.guild,'Scheduled Event Created',`**${clip(e.name,100)}** (\`${e.id}\`)`,[{name:'Start',value:fmtTime(e.scheduledStartTimestamp)},{name:'Channel',value:e.channelId?`<#${e.channelId}>`:'Not specified'}])).catch(()=>{}));
  client.on('guildScheduledEventUpdate',(oldE,newE)=>sendLog(newE.guild,'scheduled','scheduledUpdate',embed(newE.guild,'Scheduled Event Updated',`**${clip(oldE.name,100)}** → **${clip(newE.name,100)}** (\`${newE.id}\`)`,[{name:'Start before',value:fmtTime(oldE.scheduledStartTimestamp)},{name:'Start after',value:fmtTime(newE.scheduledStartTimestamp)},{name:'Status',value:`${oldE.status} → ${newE.status}`}])).catch(()=>{}));
  client.on('guildScheduledEventDelete',e=>sendLog(e.guild,'scheduled','scheduledDelete',embed(e.guild,'Scheduled Event Deleted',`**${clip(e.name,100)}** (\`${e.id}\`) deleted.`)).catch(()=>{}));
  client.on('threadCreate',t=>sendLog(t.guild,'channels','threadCreate',embed(t.guild,'Thread Created',`${t} (\`${t.id}\`) created in <#${t.parentId}>.`),{channelId:t.parentId}).catch(()=>{}));
  client.on('threadDelete',t=>sendLog(t.guild,'channels','threadDelete',embed(t.guild,'Thread Deleted',`**${clip(t.name,100)}** (\`${t.id}\`) deleted from <#${t.parentId}>.`),{channelId:t.parentId}).catch(()=>{}));
}
async function reactionLog(reaction,user,eventKey){if(reaction.partial)await reaction.fetch().catch(()=>null);const m=reaction.message;if(!m?.guild||!user||user.bot)return;await sendLog(m.guild,'messages',eventKey,embed(m.guild,eventKey==='reactionAdd'?'Reaction Added':'Reaction Removed',`${user.tag||user.username} (<@${user.id}>) ${eventKey==='reactionAdd'?'added':'removed'} ${reaction.emoji} in <#${m.channelId}>.`,[{name:'Message',value:`[Jump to message](${m.url})`},{name:'Message author',value:m.author?`${m.author.tag} (\`${m.author.id}\`)`:'Unknown'}]),{channelId:m.channelId,userId:user.id});}
function trackCommand(i){if(!i.guild||!i.commandName)return;const guild=i.guild;sendLog(guild,'bot','commandExecuted',embed(guild,'Command Executed',`/${clip(i.commandName,100)} was invoked.`,[{name:'User',value:`${i.user.tag} (<@${i.user.id}>)`},{name:'Channel',value:i.channelId?`<#${i.channelId}>`:'Unknown'},{name:'Note',value:'Option values are intentionally omitted from command logs.'}]),{channelId:i.channelId,userId:i.user.id,member:i.member}).catch(()=>{});}

module.exports={command,attach,handleInteraction,getConfig,saveConfig,sendLog,trackCommand,CATEGORIES,permissionDiff,_internals:{cacheGet,cacheSet,findContext,attribute,permissionDiff,permissionFields,DEFAULT_CONFIG,sql}};

};

__modules["index.js"] = function(module, exports, require, __filename, __dirname) {
require('dotenv').config();
console.log('[AunXz] Starting index.js...');
const { Client, GatewayIntentBits, Partials, REST, Routes, ChannelType, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, StringSelectMenuBuilder, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, AuditLogEvent } = require('discord.js');
const db = require('./database');
const ui = require('./ui');
const sys = require('./systems');
const { commands, isOwner, buildModulePatch, PANEL_MODULES, handleDangerousConfirmation } = require('./commands');
const v2patch = require('./v2patch');
const helpers = require('./helpers');
const sticky = require('./sticky');
const apps = require('./applications');
const ownerTools = require('./ownertools');
const settingsCmds = require('./settings');
const greetvoiceCmd = require('./greetvoice');
const greetMessageCmd = require('./greetmessage');
const templateMod = require('./template');
const nexoraMod = require('./nexora');
const loggingMod = require('./logging');
const legacyLogSetupIndex = commands.findIndex(c => c?.data?.name === 'logsetup');
if (legacyLogSetupIndex >= 0) commands.splice(legacyLogSetupIndex, 1);
commands.push(...nexoraMod.commands, loggingMod.command);
v2patch.apply();
const applicationSessions = new Map();
const birthdayWishesSent = new Set();
const logSetupSessions = new Map();
const rolePanelSessions = new Map();
const setupMediaSessions = new Map();
const commandCooldowns = new Map();
const COMMAND_COOLDOWN_MS = 5000;
const recentMessageEvidence = new Map();
const MAX_MESSAGE_EVIDENCE = 4000;
const MESSAGE_EVIDENCE_TTL = 20 * 60 * 1000;
const usedAuditEntries = new Map();
const inviteLocks = new Map();
const LOG_EVENT_DEFAULTS = {
    messageCreate: false, messageDelete: true, messageUpdate: true, bulkDelete: true,
    memberJoin: true, memberLeave: true, memberUpdate: true, memberRoles: true,
    roleCreate: true, roleDelete: true, roleUpdate: true, channelCreate: true, channelDelete: true,
    channelUpdate: true, guildUpdate: true, banAdd: true, banRemove: true, voiceStateUpdate: true,
    inviteCreate: true, inviteDelete: true
};
function cleanLogText(value, max = 1000) {
    const text = String(value ?? 'Unavailable').replace(/@everyone|@here/g, '@\u200b$&').replace(/<@([!&]?\d+)>/g, '<\u200b@$1>');
    return text.length > max ? `${text.slice(0, Math.max(0, max - 18))}… [${text.length} chars]` : text;
}
function eventIsEnabled(cfg, eventKey) {
    if (cfg.enabled === false) return false;
    const events = cfg.events || {};
    if (typeof events[eventKey] === 'boolean') return events[eventKey];
    return LOG_EVENT_DEFAULTS[eventKey] !== false;
}
function requiredLogChannelType(eventKey) {
    if (/^memberJoin$|^memberLeave$/.test(eventKey)) return 'join';
    if (/^member/.test(eventKey)) return 'member';
    if (/^(banAdd|banRemove)$/.test(eventKey)) return 'mod';
    if (/^voice/.test(eventKey)) return 'voice';
    if (/^invite/.test(eventKey)) return 'join';
    if (/^(role|channel|guild)/.test(eventKey)) return 'server';
    if (eventKey === 'ticket') return 'ticket';
    if (eventKey === 'security') return 'antinuke';
    return 'message';
}
async function sendGuildAuditLog(guild, type, eventKey, title, description, detailFields = [], files = []) {
    try {
        if (!guild?.id || !eventIsEnabled(db.getConfig(guild.id).logs || {}, eventKey)) return false;
        const cfg = db.getConfig(guild.id).logs || {};
        const key = type || requiredLogChannelType(eventKey);
        const channelId = cfg[key] || null;
        if (!channelId) return false;
        const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased?.() || !channel.send) return false;
        const me = guild.members.me;
        const perms = channel.permissionsFor?.(me);
        if (perms && [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks].some(flag => !perms.has(flag))) return false;
        const embed = ui.base(cleanLogText(title, 240))
            .setDescription(cleanLogText(description, 3900))
            .setTimestamp(new Date())
            .setFooter({ text: `${guild.name} • ${guild.id} • ${eventKey} • ${Date.now().toString(36)}` });
        for (const field of (detailFields || []).slice(0, 20)) {
            if (!field?.name) continue;
            embed.addFields({ name: cleanLogText(field.name, 250), value: cleanLogText(field.value, 1024), inline: !!field.inline });
        }
        await channel.send({ embeds: [embed], files, allowedMentions: { parse: [] } });
        return true;
    }
    catch (err) {
        console.warn(`[logging] delivery failed for ${eventKey}:`, err?.message || err);
        return false;
    }
}
function cacheEvidenceKey(channelId, messageId) { return `${channelId}:${messageId}`; }
function messageEvidence(message) {
    return {
        guildId: message.guildId || message.guild?.id || null,
        channelId: message.channelId || message.channel?.id || null,
        messageId: message.id,
        authorId: message.author?.id || null,
        authorName: message.author?.tag || message.author?.username || 'Unknown author',
        content: String(message.content || '').slice(0, 4000),
        createdTimestamp: message.createdTimestamp || null,
        attachments: [...(message.attachments?.values?.() || [])].map(a => ({ name: a.name, size: a.size, contentType: a.contentType || null, url: a.url })).slice(0, 20),
        referenceId: message.reference?.messageId || null,
        cachedAt: Date.now()
    };
}
function rememberMessageEvidence(message) {
    if (!message?.guildId || !message?.channelId || !message?.id) return;
    const key = cacheEvidenceKey(message.channelId, message.id);
    recentMessageEvidence.delete(key);
    recentMessageEvidence.set(key, messageEvidence(message));
    const now = Date.now();
    for (const [k, v] of recentMessageEvidence) {
        if (now - v.cachedAt > MESSAGE_EVIDENCE_TTL || recentMessageEvidence.size > MAX_MESSAGE_EVIDENCE) recentMessageEvidence.delete(k);
        else if (recentMessageEvidence.size <= MAX_MESSAGE_EVIDENCE && now - v.cachedAt <= MESSAGE_EVIDENCE_TTL) break;
    }
}
function compareSnowflakes(a, b) {
    try { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
    catch { return String(a).localeCompare(String(b)); }
}
async function findAdjacentMessage(message, direction = 'previous') {
    const targetId = String(message.id || '');
    const candidates = [...recentMessageEvidence.values()].filter(x => x.channelId === message.channelId && x.messageId !== targetId && (direction === 'previous' ? compareSnowflakes(x.messageId, targetId) < 0 : compareSnowflakes(x.messageId, targetId) > 0));
    candidates.sort((a, b) => compareSnowflakes(a.messageId, b.messageId));
    let found = direction === 'previous' ? candidates[candidates.length - 1] : candidates[0];
    if (found) return found;
    if (!message.channel?.messages?.fetch || !message.guildId) return null;
    try {
        const fetched = await message.channel.messages.fetch({ [direction === 'previous' ? 'before' : 'after']: targetId, limit: 25 });
        const entries = [...fetched.values()].filter(x => x.id !== targetId && (direction === 'previous' ? compareSnowflakes(x.id, targetId) < 0 : compareSnowflakes(x.id, targetId) > 0));
        entries.sort((a, b) => compareSnowflakes(a.id, b.id));
        const msg = direction === 'previous' ? entries[entries.length - 1] : entries[0];
        return msg ? messageEvidence(msg) : null;
    }
    catch { return null; }
}
function contextField(context, label) {
    if (!context) return { name: label, value: 'Previous message unavailable. The bot had no cached evidence or could not access bounded channel history.', inline: false };
    const jump = `https://discord.com/channels/${context.guildId}/${context.channelId}/${context.messageId}`;
    return { name: label, value: `**${cleanLogText(context.authorName, 120)}**${context.authorId ? ` (ID: ${context.authorId})` : ''}\n${cleanLogText(context.content || '(no text content)', 500)}\n${context.createdTimestamp ? `<t:${Math.floor(context.createdTimestamp / 1000)}:F>` : 'Timestamp unavailable'}\n[Open actual message](${jump})`, inline: false };
}
async function matchAuditActor(guild, action, targetId, eventTimestamp = Date.now()) {
    if (!guild?.fetchAuditLogs || !targetId) return { actor: null, source: 'unavailable', confidence: 'unknown', reason: null };
    for (const [id, ts] of usedAuditEntries) if (Date.now() - ts > 120000) usedAuditEntries.delete(id);
    try {
        const logs = await guild.fetchAuditLogs({ type: action, limit: 8 });
        const matches = [...logs.entries.values()].filter(entry => {
            if (!entry.target?.id || String(entry.target.id) !== String(targetId)) return false;
            if (Math.abs(Number(entry.createdTimestamp || 0) - Number(eventTimestamp)) > 10000) return false;
            if (usedAuditEntries.has(entry.id)) return false;
            return true;
        });
        if (matches.length !== 1) return { actor: null, source: 'audit log ambiguous', confidence: 'unknown', reason: null };
        const entry = matches[0];
        usedAuditEntries.set(entry.id, Date.now());
        return { actor: entry.executor || null, source: `audit log action ${action}`, confidence: 'matched target + action + timestamp', reason: entry.reason || null };
    }
    catch { return { actor: null, source: 'audit log unavailable', confidence: 'unknown', reason: null }; }
}
function actorFields(match) {
    const who = match?.actor ? `${match.actor.tag || match.actor.username} (ID: ${match.actor.id})` : 'Unknown — Discord did not provide reliable attribution.';
    return [
        { name: 'Actor', value: who, inline: false },
        { name: 'Attribution', value: `${match?.source || 'not available'} • ${match?.confidence || 'unknown'}${match?.reason ? `\nReason: ${cleanLogText(match.reason, 300)}` : ''}`, inline: false }
    ];
}
const PERMISSION_LABELS = Object.entries(PermissionFlagsBits).map(([name, bit]) => [name, BigInt(bit)]);
const PRIVILEGED_PERMISSIONS = new Set(['Administrator','ManageGuild','ManageRoles','ManageChannels','ManageWebhooks','ManageMessages','BanMembers','KickMembers','ModerateMembers','MentionEveryone','ManageThreads','ManageEvents','ManageGuildExpressions','ManageNicknames']);
function permissionDiff(oldBits, newBits) {
    const before = BigInt(oldBits), after = BigInt(newBits);
    const seen = new Set(), added = [], removed = [];
    for (const [name, bit] of PERMISSION_LABELS) {
        const key = bit.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        const had = (before & bit) !== 0n, has = (after & bit) !== 0n;
        if (!had && has) added.push(`${PRIVILEGED_PERMISSIONS.has(name) ? '⚠️ ' : '✅ '}${name}${PRIVILEGED_PERMISSIONS.has(name) ? ' — PRIVILEGED' : ''}`);
        if (had && !has) removed.push(`${PRIVILEGED_PERMISSIONS.has(name) ? '⚠️ ' : '❌ '}${name}${PRIVILEGED_PERMISSIONS.has(name) ? ' — PRIVILEGED' : ''}`);
    }
    return { added, removed };
}
function permissionDiffFields(diff) {
    const fields = [];
    if (diff.added.length) fields.push({ name: '✅ Enabled Permissions', value: diff.added.join('\n').slice(0, 1024), inline: false });
    if (diff.removed.length) fields.push({ name: '❌ Disabled Permissions', value: diff.removed.join('\n').slice(0, 1024), inline: false });
    return fields;
}
function diffPermissionOverwrite(oldOw, newOw) {
    const oldAllow = BigInt(oldOw?.allow?.bitfield ?? 0n), oldDeny = BigInt(oldOw?.deny?.bitfield ?? 0n);
    const newAllow = BigInt(newOw?.allow?.bitfield ?? 0n), newDeny = BigInt(newOw?.deny?.bitfield ?? 0n);
    const calc = (before, after) => permissionDiff(before, after);
    return { allow: calc(oldAllow, newAllow), deny: calc(oldDeny, newDeny), created: !oldOw && !!newOw, deleted: !!oldOw && !newOw };
}
async function logMessageDelete(message) {
    const guild = message.guild;
    if (!guild || !message.channelId || !message.id) return;
    const key = cacheEvidenceKey(message.channelId, message.id);
    const cached = recentMessageEvidence.get(key) || (message.content ? messageEvidence(message) : null);
    recentMessageEvidence.delete(key);
    const previous = await findAdjacentMessage(message, 'previous');
    const next = await findAdjacentMessage(message, 'next');
    const attachments = cached?.attachments?.map(a => `${a.name || 'attachment'} (${a.size ?? '?'} bytes)${a.contentType ? `, ${a.contentType}` : ''}\n${a.url || ''}`).join('\n') || 'None captured';
    const jump = `https://discord.com/channels/${guild.id}/${message.channelId}/${message.id}`;
    const details = [
        { name: 'Author', value: `${cached?.authorName || message.author?.tag || 'Unknown'}${cached?.authorId ? ` • ID ${cached.authorId}` : message.author?.id ? ` • ID ${message.author.id}` : ''}`, inline: false },
        { name: 'Channel', value: `<#${message.channelId}> • ID ${message.channelId}`, inline: false },
        { name: 'Message ID', value: message.id, inline: true },
        { name: 'Created', value: cached?.createdTimestamp ? `<t:${Math.floor(cached.createdTimestamp / 1000)}:F>` : 'Unavailable (message was not cached)', inline: true },
        { name: 'Evidence source', value: cached ? 'Bounded in-memory evidence cache' : 'No cached message content was available', inline: false },
        { name: 'Original content', value: cached?.content ? cleanLogText(cached.content, 1024) : 'Unavailable — bot did not capture this message before deletion.', inline: false },
        { name: 'Attachments', value: cleanLogText(attachments, 1024), inline: false },
        contextField(previous, 'Previous Message — Context'),
        contextField(next, 'Next Message — Context'),
        { name: 'Deleted message link', value: `https://discord.com/channels/${guild.id}/${message.channelId}/${message.id} (may no longer be accessible)`, inline: false }
    ];
    await sendGuildAuditLog(guild, 'message', 'messageDelete', '🗑️ Message Deleted', `A message was deleted in <#${message.channelId}>. Actor: Unknown — Discord did not provide reliable attribution.`, details);
}
async function logMessageUpdate(oldMessage, newMessage) {
    const message = newMessage, guild = message.guild;
    if (!guild || !message.channelId || !message.id) return;
    const key = cacheEvidenceKey(message.channelId, message.id);
    const cached = recentMessageEvidence.get(key);
    const beforeText = oldMessage?.content ?? cached?.content ?? '';
    const afterText = message.content ?? '';
    const beforeAttachments = new Set((oldMessage?.attachments?.values?.() || cached?.attachments || []).map(a => a.id || a.url || a.name));
    const afterAttachments = new Set([...(message.attachments?.values?.() || [])].map(a => a.id || a.url || a.name));
    const attachmentsChanged = beforeAttachments.size !== afterAttachments.size || [...beforeAttachments].some(x => !afterAttachments.has(x));
    const embedsChanged = JSON.stringify(oldMessage?.embeds?.map(e => e.toJSON?.() || e) || []) !== JSON.stringify(message.embeds?.map(e => e.toJSON?.() || e) || []);
    if (beforeText === afterText && !attachmentsChanged && !embedsChanged) { rememberMessageEvidence(message); return; }
    const previous = await findAdjacentMessage(message, 'previous');
    const next = await findAdjacentMessage(message, 'next');
    const changedAttachments = [
        ...[...afterAttachments].filter(x => !beforeAttachments.has(x)).map(x => `Added: ${x}`),
        ...[...beforeAttachments].filter(x => !afterAttachments.has(x)).map(x => `Removed: ${x}`)
    ];
    await sendGuildAuditLog(guild, 'message', 'messageUpdate', '✏️ Message Edited', `Message by ${message.author ? `${message.author.tag} (ID: ${message.author.id})` : 'unknown author'} was edited in <#${message.channelId}>. Actor: Unknown — Discord does not expose who edited another user's message.`, [
        { name: 'Message ID', value: message.id, inline: true },
        { name: 'Created', value: message.createdTimestamp ? `<t:${Math.floor(message.createdTimestamp/1000)}:F>` : 'Unavailable', inline: true },
        { name: 'Jump link', value: `https://discord.com/channels/${guild.id}/${message.channelId}/${message.id}`, inline: false },
        { name: 'Before', value: beforeText ? cleanLogText(beforeText, 1024) : 'Previous content unavailable (message was not cached).', inline: false },
        { name: 'After', value: afterText ? cleanLogText(afterText, 1024) : '(No text content)', inline: false },
        { name: 'Attachments', value: changedAttachments.length ? cleanLogText(changedAttachments.join('\n'), 1024) : (attachmentsChanged ? 'Attachment metadata changed' : 'No attachment change detected'), inline: false },
        { name: 'Embeds', value: embedsChanged ? 'Embed data changed (full embed content may not be recoverable).' : 'No embed change detected', inline: false },
        contextField(previous, 'Previous Message — Context'), contextField(next, 'Next Message — Context')
    ]);
    rememberMessageEvidence(message);
}

function isGlobalBlacklistedGuild(guild) {
    if (!guild?.ownerId)
        return false;
    try {
        return db.getGlobalBlacklist().includes(String(guild.ownerId));
    }
    catch {
        return false;
    }
}
function consumeCommandCooldown(interaction) {
    const guildId = interaction.guildId || 'dm';
    if (guildId !== 'dm') {
        const membership = db.membership(guildId);
        if (membership && Number(membership.expiresAt) > Date.now())
            return 0;
    }
    const userId = interaction.user?.id || interaction.member?.id || 'unknown';
    const key = `${guildId}:${userId}`;
    const now = Date.now();
    const expiresAt = commandCooldowns.get(key) || 0;
    if (expiresAt > now)
        return expiresAt - now;
    commandCooldowns.set(key, now + COMMAND_COOLDOWN_MS);
    if (commandCooldowns.size > 5000) {
        for (const [cooldownKey, until] of commandCooldowns)
            if (until <= now)
                commandCooldowns.delete(cooldownKey);
    }
    return 0;
}
let client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.GuildExpressions,
        GatewayIntentBits.GuildScheduledEvents,
        GatewayIntentBits.GuildWebhooks,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.Reaction, Partials.User]
});
loggingMod.attach(client).catch(err => console.error('[logging] attach failed:', err));
function ownerLogChannelId(type) {
    const cfg = db.getOwnerConfig();
    if (type === 'error')
        return cfg.errorChannelId || process.env.OWNER_ERROR_LOG_CHANNEL_ID || process.env.OWNER_LOG_CHANNEL_ID || null;
    if (type === 'online')
        return cfg.onlineChannelId || process.env.OWNER_ONLINE_LOG_CHANNEL_ID || process.env.OWNER_LOG_CHANNEL_ID || null;
    return cfg.joinChannelId || process.env.OWNER_JOIN_LOG_CHANNEL_ID || process.env.OWNER_LOG_CHANNEL_ID || null;
}
async function getOwnerLogChannel(type) {
    const id = ownerLogChannelId(type);
    if (!id || !client)
        return null;
    return client.channels.cache.get(id) || await client.channels.fetch(id).catch(() => null);
}
async function sendOwnerLog(type, embed, components = []) {
    try {
        const channel = await getOwnerLogChannel(type);
        if (!channel?.isTextBased())
            return false;
        await channel.send({ embeds: [embed], components }).catch(() => { });
        return true;
    }
    catch (e) {
        console.error('[AunXz] owner log failed:', e);
        return false;
    }
}
async function logOwnerError(error, context = '', meta = {}) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(err);
    ownerTools.recordError(err, context, meta);
    const text = (context ? `**Context:** ${context}\n` : '') + `**Error:** \`${String(err.message || err).slice(0, 1800)}\`` + (err.stack ? `\n**Stack:**\n\`\`\`\n${err.stack.slice(0, 3000)}\n\`\`\`` : '');
    await sendOwnerLog('error', ui.errorEmbed(`${ui.emoji('error')} Bot Error`, text));
}
async function publishOwnerDashboard() {
    const channelId = process.env.OWNER_MAIN_CHANNEL_ID;
    if (!channelId || !client?.user)
        return;
    const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased())
        return;
    const ownerCommands = commands.filter(c => c.ownerOnly).map(c => `• **/${c.data.name}**`).join('\n') || 'No owner commands registered.';
    const embed = ui.base(`${ui.emoji('owner')} AunXz Owner Control Center`)
        .setDescription(`**Owner-only commands**\n${ownerCommands}\n\n**Global controls**\\n• Configure logs with **/ownerlogsetup**\n• Manage memberships with **/ms**\n• Manage embed text/emojis with **/em** and **/emoji**\n\nThis channel is controlled by your environment configuration.`);
    const existingId = db.getOwnerConfig().dashboardMessageId;
    if (existingId) {
        const old = await channel.messages.fetch(existingId).catch(() => null);
        if (old) {
            await old.edit({ embeds: [embed] }).catch(() => { });
            return;
        }
    }
    const msg = await channel.send({ embeds: [embed] }).catch(() => null);
    if (msg)
        db.saveOwnerConfig({ dashboardMessageId: msg.id });
}
async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const publicBody = uniqueByName(commands.filter(c => !c.ownerOnly).map(c => c.data.toJSON()));
    const ownerBody = uniqueByName(commands.filter(c => c.ownerOnly).map(c => c.data.toJSON()));
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: publicBody });
    console.log(`Registered ${publicBody.length} global commands.`);
    const ownerGuildId = process.env.OWNER_GUILD_ID || process.env.GUILD_ID;
    if (ownerGuildId && ownerBody.length) {
        await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, ownerGuildId), { body: ownerBody });
        console.log(`Registered ${ownerBody.length} owner-only commands to guild ${ownerGuildId}.`);
    }
    else if (ownerBody.length) {
        console.log(`OWNER_GUILD_ID not set — ${ownerBody.length} owner-only command(s) not registered as slash commands (still usable as text commands, e.g. !maintenance).`);
    }
}
async function finishGiveaways() {
    for (const guild of client.guilds.cache.values()) {
        for (const g of db.listGiveaways(guild.id, 50)) {
            if (g.status !== 'active' || Date.now() < g.endsAt)
                continue;
            let participants = [];
            try {
                participants = JSON.parse(g.participants || '[]');
            }
            catch { }
            const pool = participants.filter(id => guild.members.cache.has(id));
            const shuffled = [...pool].sort(() => Math.random() - 0.5);
            const winners = shuffled.slice(0, Math.min(g.winners, shuffled.length));
            db.updateGiveaway(guild.id, g.id, { status: 'ended', winnerIds: JSON.stringify(winners) });
            const ch = g.channelId ? guild.channels.cache.get(g.channelId) : null;
            if (ch) {
                const text = winners.length ? winners.map(id => `<@${id}>`).join(', ') : 'No valid entries.';
                await ch.send({ embeds: [ui.base('🏆 Giveaway Ended').setDescription(`**Prize:** ${g.prize}\n**Winner(s):** ${text}`)] }).catch(() => { });
            }
        }
    }
}
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    if (!process.env.EMBED_THUMBNAIL_URL && !process.env.BOT_AVATAR_URL) {
        process.env.EMBED_THUMBNAIL_URL = client.user.displayAvatarURL({ extension: 'png', size: 128 });
    }
    console.log(`Database: ${db.DB_PATH}`);
    client.user.setActivity('/help');
    ownerTools.init({ commands, aliases: TEXT_ALIASES });
    auditCommands();
    try {
        sys.logVoiceDependencies();
    }
    catch (e) {
        console.warn('[GreetVoice] dependency report failed:', e.message);
    }
    try {
        await registerCommands();
    }
    catch (e) {
        await logOwnerError(e, 'Slash command registration');
    }
    await publishOwnerDashboard().catch(e => logOwnerError(e, 'Owner dashboard'));
    sys.vmSweep(client).catch(e => console.warn('[VoiceMaster] startup sweep failed:', e.message));
    await sendOwnerLog('online', ui.okEmbed(`${ui.emoji('online')} AunXz Online`, `AunXz is online as **${client.user.tag}**.\n**Guilds:** ${client.guilds.cache.size}\n**Ping:** ${client.ws.ping}ms`));
});
process.on('uncaughtException', err => { logOwnerError(err, 'uncaughtException').catch(() => { }); });
process.on('unhandledRejection', err => { logOwnerError(err, 'unhandledRejection').catch(() => { }); });
client.on('error', error => { logOwnerError(error, 'discord.js client error').catch(() => { }); });
client.on('shardReconnecting', () => { sendOwnerLog('online', ui.warnEmbed(`${ui.emoji('offline')} AunXz Reconnecting`, 'Discord gateway reconnecting…')).catch(() => { }); });
client.on('shardDisconnect', event => { sendOwnerLog('online', ui.warnEmbed(`${ui.emoji('offline')} AunXz Offline`, `Gateway disconnected (code ${event?.code ?? 'unknown'}).`)).catch(() => { }); });
client.on('shardResume', (_id, replayed) => { sendOwnerLog('online', ui.okEmbed(`${ui.emoji('online')} AunXz Resumed`, `Gateway connection resumed. Replayed ${replayed ?? 0} events.`)).catch(() => { }); });
client.on('guildCreate', async (guild) => {
    await sendOwnerLog('join', ui.ownerJoinLogEmbed(guild), ui.ownerJoinLogRows(guild.id));
    await publishOwnerDashboard().catch(() => { });
});
setInterval(() => finishGiveaways().catch(console.error), 15000);
const OPT = { SUBCOMMAND: 1, SUBCOMMAND_GROUP: 2, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7, ROLE: 8, MENTIONABLE: 9, NUMBER: 10 };
function tokenize(str) {
    const tokens = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(str)))
        tokens.push(m[1] ?? m[2] ?? m[3]);
    return tokens;
}
function findOptionsSchema(json, tokens) {
    let options = json.options || [];
    let group = null, subcommand = null;
    if (options.length && options[0].type === OPT.SUBCOMMAND_GROUP) {
        const name = (tokens.shift() || '').toLowerCase();
        const g = options.find(o => o.name === name && o.type === OPT.SUBCOMMAND_GROUP);
        if (!g)
            return null;
        group = g.name;
        options = g.options || [];
    }
    if (options.length && options[0].type === OPT.SUBCOMMAND) {
        const name = (tokens.shift() || '').toLowerCase();
        const s = options.find(o => o.name === name && o.type === OPT.SUBCOMMAND);
        if (!s)
            return null;
        subcommand = s.name;
        options = s.options || [];
    }
    return { leafOptions: options, subcommand, group };
}
function resolveOptionValue(type, raw, message) {
    if (raw === undefined || raw === null)
        return null;
    switch (type) {
        case OPT.INTEGER: {
            const n = parseInt(raw, 10);
            return Number.isNaN(n) ? null : n;
        }
        case OPT.NUMBER: {
            const n = parseFloat(raw);
            return Number.isNaN(n) ? null : n;
        }
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
        default: return raw;
    }
}
function parseLeafArgs(leafOptions, tokens) {
    const raw = {};
    for (let i = 0; i < leafOptions.length; i++) {
        const opt = leafOptions[i];
        if (i === leafOptions.length - 1 && opt.type === OPT.STRING) {
            const rest = tokens.slice(i).join(' ');
            if (rest)
                raw[opt.name] = rest;
            else if (opt.required)
                return null;
            break;
        }
        const tok = tokens[i];
        if (tok === undefined) {
            if (opt.required)
                return null;
            continue;
        }
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
    const argText = tokens.join(' ');
    const schema = findOptionsSchema(json, tokens);
    if (!schema)
        return null;
    const rawValues = parseLeafArgs(schema.leafOptions, tokens);
    if (rawValues === null)
        return null;
    const values = {};
    for (const opt of schema.leafOptions) {
        if (rawValues[opt.name] === undefined)
            continue;
        values[opt.name] = opt.type === OPT.STRING ? rawValues[opt.name] : resolveOptionValue(opt.type, rawValues[opt.name], message);
    }
    const getter = (name) => (values[name] === undefined ? null : values[name]);
    const fake = {
        isChatInputCommand: () => true,
        commandName: json.name,
        argText,
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
            getSubcommand: () => schema.subcommand,
            getSubcommandGroup: () => schema.group,
            getAttachment: () => message.attachments?.first() || null
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
    if (!payload || typeof payload !== 'object')
        return payload;
    const { ephemeral, ...rest } = payload;
    return rest;
}
const COMMAND_FEATURES = {
    antinuke: 'antinuke', antilink: 'antilink', antispam: 'antispam', antiraid: 'antiraid',
    antiwebhook: 'antiwebhook', antibot: 'antibot', antialt: 'antialt', voicemaster: 'voicemaster',
    greetmessage: 'greetmessage', testgreet: 'greetmessage', greetvoice: 'greetvoice', leveling: 'leveling', tickets: 'ticket',
    ticketpanel: 'ticket', ticketconfig: 'ticket', claim: 'ticket', close: 'ticket', delete: 'ticket',
    addmembertoticket: 'ticket', removemembertoticket: 'ticket', automod: 'automod',
    voice: 'voicemaster', antibadwordsetup: 'antibadword', autorespondersetup: 'autoresponder', autoreactorsetup: 'autoreactor',
    honeypotsetup: 'honeypot', birthdaysetup: 'birthdays', birthdays: 'birthdays', autorole: 'autorole',
    staffapplicationssetup: 'staffApplications', rank: 'leveling', leaderboard: 'leveling', xp: 'leveling'
};
function commandSubcommand(interaction) {
    try {
        return interaction.options?.getSubcommand?.(false) || null;
    }
    catch {
        return null;
    }
}
function commandIsSetupOnly(interaction) {
    const name = interaction.commandName || '';
    const sub = commandSubcommand(interaction);
    return name === 'setup' || name === 'greetvoice' || name === 'stickymessage' || sub === 'setup' || /setup$/i.test(name) || /config$/i.test(name) || /panel$/i.test(name) || name === 'autorole';
}
function commandFeatureKey(interaction) {
    return COMMAND_FEATURES[interaction.commandName] || null;
}
function featureEnabled(cfg, key) {
    if (!key || !Object.prototype.hasOwnProperty.call(cfg, key))
        return true;
    const value = cfg[key];
    return typeof value === 'boolean' ? value : value?.enabled !== false;
}
async function guardCommand(interaction, cmd) {
    if (!interaction.guild || !interaction.member)
        return true;
    const cfg = db.getConfig(interaction.guildId);
    const json = cmd.data.toJSON();
    const required = json.default_member_permissions;
    if (required && !interaction.member.permissions.has(BigInt(required))) {
        return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', `You do not have the permissions required for **/${interaction.commandName}**.`)], ephemeral: true }).then(() => false);
    }
    if (!commandIsSetupOnly(interaction)) {
        const key = commandFeatureKey(interaction);
        if (key && !featureEnabled(cfg, key)) {
            const setupName = key === 'ticket' ? '/tickets setup' : key === 'greetmessage' ? '/greetmessage setup' : `/${interaction.commandName} setup`;
            return interaction.reply({ embeds: [ui.errorEmbed('Feature Disabled', `**${key}** is currently disabled. Enable it from ${setupName}.`)], ephemeral: true }).then(() => false);
        }
    }
    return true;
}
async function executeCommand(cmd, interaction) {
    const remaining = consumeCommandCooldown(interaction);
    if (remaining > 0) {
        const waitSeconds = (remaining / 1000).toFixed(1).replace(/\.0$/, '');
        const payload = { embeds: [ui.warnEmbed('⏳ Command Cooldown', `Please wait **${waitSeconds}s** before using another command. Active server memberships skip this cooldown.`)], ephemeral: true };
        if (interaction.deferred || interaction.replied)
            await interaction.followUp(payload).catch(() => { });
        else
            await interaction.reply(payload).catch(() => { });
        return;
    }
    const off = ownerTools.disabledInfo(interaction.commandName);
    if (off && !ownerTools.isOwner(interaction.user?.id)) {
        const payload = { embeds: [ui.warnEmbed('Command disabled', `**/${interaction.commandName}** is temporarily disabled.${off.reason ? `\n**Reason:** ${off.reason}` : ''}`)], ephemeral: true };
        if (interaction.deferred || interaction.replied)
            await interaction.followUp(payload).catch(() => { });
        else
            await interaction.reply(payload).catch(() => { });
        return;
    }
    if (!await guardCommand(interaction, cmd))
        return;
    try {
        await cmd.execute(interaction);
        ownerTools.trackCommand(interaction.commandName, interaction.guildId, true);
    }
    catch (e) {
        ownerTools.trackCommand(interaction.commandName, interaction.guildId, false);
        console.error(`Command ${interaction.commandName} failed:`, e);
        logOwnerError(e, `Command /${interaction.commandName}`, { command: interaction.commandName, guildId: interaction.guildId, userId: interaction.user?.id }).catch(() => { });
        const code = e?.code ? `\n**Discord code:** \`${e.code}\`` : '';
        const message = e?.message ? String(e.message).slice(0, 1200) : 'Something went wrong while executing the command.';
        const payload = { embeds: [ui.errorEmbed('Command Failed', `${message}${code}`)], ephemeral: true };
        if (interaction.deferred || interaction.replied)
            await interaction.followUp(payload).catch(() => { });
        else
            await interaction.reply(payload).catch(() => { });
    }
}
function mediaSessionKey(guildId, userId) { return `${guildId}:${userId}`; }
function startSetupMediaUpload(interaction, opts) {
    const key = mediaSessionKey(interaction.guildId, interaction.user.id);
    const old = setupMediaSessions.get(key);
    if (old?.timer)
        clearTimeout(old.timer);
    const session = { mediaType: 'image', ...opts, channelId: interaction.channelId, interaction, expiresAt: Date.now() + 120000 };
    session.timer = setTimeout(() => setupMediaSessions.delete(key), 120000);
    setupMediaSessions.set(key, session);
    const label = opts.label || 'this setting';
    const what = session.mediaType === 'audio' ? 'audio file' : 'image or GIF';
    return interaction.reply({
        embeds: [ui.base(session.mediaType === 'audio' ? '🎵 Send Audio Now' : '🖼️ Send Image/GIF Now')
                .setDescription(`Send the ${what} for **${label}** as your next message in this channel.\n\nI will save it and delete the upload automatically.`)],
        ephemeral: true
    });
}
async function consumeSetupMedia(message) {
    if (!message.guild || message.author.bot)
        return false;
    const key = mediaSessionKey(message.guild.id, message.author.id);
    const session = setupMediaSessions.get(key);
    if (!session || session.channelId !== message.channelId)
        return false;
    if (Date.now() > session.expiresAt) {
        setupMediaSessions.delete(key);
        return false;
    }
    const attachment = [...message.attachments.values()].find(a => {
        const type = String(a.contentType || '').toLowerCase();
        const name = String(a.name || '').toLowerCase();
        if (session.mediaType === 'audio')
            return type.startsWith('audio/') || /\.(mp3|wav|ogg|oga|opus|webm|m4a|aac|flac)$/i.test(name);
        return type.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(name);
    });
    if (!attachment)
        return false;
    setupMediaSessions.delete(key);
    if (session.timer)
        clearTimeout(session.timer);
    try {
        await session.apply(session.mediaType === 'audio' ? attachment : attachment.url, message);
        await message.delete().catch(() => { });
        if (session.render)
            await session.interaction.editReply(session.render()).catch(() => { });
        return true;
    }
    catch (e) {
        console.error('setup media upload:', e);
        await session.interaction.editReply({ embeds: [ui.errorEmbed('Upload Failed', e.message || 'Could not save that upload.')], components: [] }).catch(() => { });
        return true;
    }
}
const TEXT_ALIASES = new Map([
    ['i', 'invites'], ['invite', 'invites'],
    ['si', 'serverinfo'], ['server', 'serverinfo'],
    ['av', 'avatar'], ['pfp', 'avatar'],
    ['ui', 'userinfo'], ['user', 'userinfo'],
    ['ss', 'serverstats'], ['stats', 'serverstats'],
    ['lb', 'leaderboard'], ['lbs', 'leaderboards'],
    ['rank', 'rank'], ['help', 'help'], ['h', 'help'],
    ['ga', 'giveaway'], ['vc', 'voice']
]);
async function handleOwnerDM(message) {
    const prefix = process.env.OWNER_DM_PREFIX || '!';
    if (!message.content.startsWith(prefix) || !ownerTools.isOwner(message.author.id))
        return false;
    const tokens = tokenize(message.content.slice(prefix.length).trim());
    const cmd = commands.find(c => c.ownerOnly && c.data.name === String(tokens.shift() || '').toLowerCase());
    if (!cmd)
        return false;
    const json = cmd.data.toJSON();
    const fake = buildFakeInteraction(message, json, tokens);
    if (!fake) {
        await message.reply({ embeds: [ui.errorEmbed('Invalid Usage', usageLines(prefix, json).map(l => `\`${l}\``).join('\n'))] }).catch(() => { });
        return true;
    }
    await executeCommand(cmd, fake);
    return true;
}
function auditCommands() {
    const seen = new Set();
    for (const c of commands) {
        const n = c.data.name;
        if (seen.has(n))
            console.warn(`[AunXz] WARNING: duplicate command name registered: /${n}`);
        seen.add(n);
    }
    for (const [alias, target] of TEXT_ALIASES) {
        const clash = commands.find(c => c.data.name === alias);
        if (alias !== target && clash && !clash.ownerOnly)
            console.warn(`[AunXz] WARNING: alias "${alias}" (-> ${target}) collides with command /${alias}`);
    }
    console.log(`[AunXz] Command audit complete: ${commands.length} commands, ${TEXT_ALIASES.size} aliases.`);
}
function uniqueByName(bodies) {
    const seen = new Set();
    return bodies.filter(b => { if (seen.has(b.name)) {
        console.warn(`[AunXz] Dropped duplicate slash registration: /${b.name}`);
        return false;
    } seen.add(b.name); return true; });
}
function normalizeCommandName(name) {
    const key = String(name || '').toLowerCase();
    return TEXT_ALIASES.get(key) || key;
}
async function handlePrefixCommand(message) {
    if (isGlobalBlacklistedGuild(message.guild))
        return true;
    const cfg = db.getConfig(message.guild.id);
    const prefix = cfg.prefix || '!';
    let content = message.content.trim();
    const mention = new RegExp(`^<@!?${message.client.user.id}>\\s*`, 'i');
    let isTextCommand = content.startsWith(prefix);
    if (isTextCommand)
        content = content.slice(prefix.length).trim();
    else if (mention.test(content)) {
        content = content.replace(mention, '').trim();
        isTextCommand = true;
    }
    if (!isTextCommand)
        return false;
    const tokens = tokenize(content);
    const rawName = String(tokens.shift() || '').toLowerCase();
    const ownerCmd = ownerTools.isOwner(message.author.id) ? commands.find(c => c.ownerOnly && c.data.name === rawName) : null;
    const cmdName = ownerCmd ? ownerCmd.data.name : normalizeCommandName(rawName);
    if (!cmdName)
        return false;
    const cmd = ownerCmd || commands.find(c => c.data.name === cmdName);
    if (!cmd)
        return false;
    if (cfg.blacklist.includes(message.author.id)) {
        message.reply({ embeds: [ui.errorEmbed('Blacklisted', 'You are blocked from using this bot.')] }).catch(() => { });
        return true;
    }
    const json = cmd.data.toJSON();
    const fake = buildFakeInteraction(message, json, tokens);
    if (!fake) {
        message.reply({ embeds: [ui.errorEmbed('Invalid Usage', usageLines(prefix, json).map(l => `\`${l}\``).join('\n'))] }).catch(() => { });
        return true;
    }
    await executeCommand(cmd, fake);
    return true;
}
function startInteractionWatchdog(interaction) {
    if (interaction?.isRepliable?.() && !interaction.isAutocomplete?.())
        v2patch.wrapInteraction(interaction);
    if (!interaction?.isRepliable?.() || interaction.isAutocomplete?.())
        return () => { };
    const timer = setTimeout(() => {
        if (!interaction.replied && !interaction.deferred) {
            console.warn(`[AunXz] Slow interaction acknowledgement: ${interaction.commandName || interaction.customId || interaction.id}`);
        }
    }, 2500);
    return () => clearTimeout(timer);
}
client.on('interactionCreate', async (interaction) => {
    const stopInteractionWatchdog = startInteractionWatchdog(interaction);
    try {
        if (interaction.guild && isGlobalBlacklistedGuild(interaction.guild)) {
            if (interaction.isAutocomplete())
                return interaction.respond([]).catch(() => { });
            if (interaction.isMessageComponent?.())
                return interaction.deferUpdate().catch(() => { });
            if (interaction.isRepliable?.()) {
                await interaction.deferReply({ ephemeral: true }).catch(() => { });
                return interaction.deleteReply().catch(() => { });
            }
            return;
        }
        helpers.touchPanel(interaction.message?.id);
        if (await helpers.handlePaginationButton(interaction))
            return;
        if (interaction.customId && !interaction.isChatInputCommand?.() && !interaction.isAutocomplete?.()) {
            if (await nexoraMod.handleInteraction(interaction))
                return;
            if (await require('./bridge/wizard').handleInteraction(interaction))
                return;
            if (await loggingMod.handleInteraction(interaction, client))
                return;
            if (await templateMod.handleInteraction(interaction))
                return;
            if (await sticky.handleInteraction(interaction))
                return;
            if (await apps.handleInteraction(interaction))
                return;
            if (await settingsCmds.handleInteraction(interaction))
                return;
            if (await greetvoiceCmd.handleInteraction(interaction))
                return;
            if (await greetMessageCmd.handleInteraction(interaction))
                return;
            if (await sys.handleVoicemasterInteraction(interaction))
                return;
            if (await ownerTools.handleInteraction(interaction))
                return;
        }
        if (interaction.isButton() && interaction.customId.startsWith('danger-confirm:')) {
            return await handleDangerousConfirmation(interaction);
        }
        if (interaction.isAutocomplete()) {
            if (interaction.commandName === 'em') {
                const focused = String(interaction.options.getString('name') || '').toLowerCase();
                const rows = db.listEmbedTexts(500).filter(r => `${r.name} ${r.sourceTitle}`.toLowerCase().includes(focused)).slice(0, 25);
                return interaction.respond(rows.map(r => ({ name: `${r.name} — ${r.sourceTitle}`.slice(0, 100), value: r.name })));
            }
            return interaction.respond([]);
        }
        if (interaction.isButton() && interaction.customId.startsWith('emoji:list:')) {
            if (!isOwner(interaction.user.id))
                return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
            const page = Number(interaction.customId.split(':')[2]) || 1;
            return interaction.update({ embeds: [ui.emojisListEmbed(db.getAllEmojiOverrides(), page)], components: ui.emojisListRows(page) });
        }
        if (interaction.isButton() && interaction.customId.startsWith('em:list:')) {
            if (!isOwner(interaction.user.id))
                return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
            const page = Number(interaction.customId.split(':')[2]) || 1;
            return interaction.update({ embeds: [ui.embedTextsListEmbed(page)], components: ui.embedTextsListRows(page) });
        }
        if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('ownerlogsetup:')) {
            if (!isOwner(interaction.user.id))
                return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
            const kind = interaction.customId.split(':')[1];
            const patch = kind === 'error' ? { errorChannelId: interaction.values[0] } : kind === 'online' ? { onlineChannelId: interaction.values[0] } : { joinChannelId: interaction.values[0] };
            const cfg = db.saveOwnerConfig(patch);
            return interaction.update({ embeds: [ui.ownerLogSetupEmbed(cfg)], components: ui.ownerLogSetupRows(cfg) });
        }
        if (interaction.isButton() && interaction.customId.startsWith('owner:guild:')) {
            if (!isOwner(interaction.user.id))
                return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
            const guildId = interaction.customId.split(':')[2];
            const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
            if (!guild)
                return interaction.reply({ embeds: [ui.errorEmbed('Server Unavailable', 'AunXz is no longer in that server.')], ephemeral: true });
            return interaction.reply({ embeds: [ui.ownerGuildControlEmbed(guild)], components: ui.ownerGuildControlRows(guild.id), ephemeral: true });
        }
        if (interaction.isButton() && interaction.customId.startsWith('owner:infoask:')) {
            if (!isOwner(interaction.user.id))
                return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
            const guildId = interaction.customId.split(':')[2];
            const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
            if (!guild)
                return interaction.reply({ embeds: [ui.errorEmbed('Server Unavailable', 'AunXz is no longer in that server.')], ephemeral: true });
            return interaction.update({ embeds: [ui.ownerInfoChoiceEmbed(guild)], components: ui.ownerInfoChoiceRows(guild.id) });
        }
        if (interaction.isButton() && interaction.customId.startsWith('owner:leave:')) {
            if (!isOwner(interaction.user.id))
                return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
            const guildId = interaction.customId.split(':')[2];
            const guild = client.guilds.cache.get(guildId);
            if (!guild)
                return interaction.reply({ embeds: [ui.errorEmbed('Server Unavailable', 'That server is no longer available.')], ephemeral: true });
            const name = guild.name;
            await interaction.update({ embeds: [ui.warnEmbed('Leaving Server', `Leaving **${name}** (\`${guildId}\`) now.`)], components: [] }).catch(() => { });
            await guild.leave().catch(e => logOwnerError(e, `Leave ${guildId}`));
            return;
        }
        if (interaction.isButton() && interaction.customId.startsWith('owner:invite:')) {
            if (!isOwner(interaction.user.id))
                return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
            const guildId = interaction.customId.split(':')[2];
            const guild = client.guilds.cache.get(guildId);
            if (!guild)
                return interaction.reply({ embeds: [ui.errorEmbed('Server Unavailable', 'That server is no longer available.')], ephemeral: true });
            const channel = guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.CreateInstantInvite));
            if (!channel)
                return interaction.reply({ embeds: [ui.errorEmbed('Invite Unavailable', 'I could not find a channel where I can create an invite.')], ephemeral: true });
            const invite = await channel.createInvite({ maxAge: 86400, maxUses: 1, unique: true, reason: 'AunXz owner requested an invite' }).catch(() => null);
            if (!invite)
                return interaction.reply({ embeds: [ui.errorEmbed('Invite Failed', 'Discord rejected the invite creation request.')], ephemeral: true });
            return interaction.reply({ embeds: [ui.okEmbed('Invite Generated', `${invite.url}\nExpires in 24 hours; one use.`)], ephemeral: true });
        }
        if (interaction.isButton() && interaction.customId.startsWith('owner:info:')) {
            if (!isOwner(interaction.user.id))
                return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
            const parts = interaction.customId.split(':');
            const scope = parts[2];
            const guildId = parts[3];
            const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
            if (!guild)
                return interaction.update({ embeds: [ui.errorEmbed('Server Unavailable', 'AunXz is no longer in that server.')], components: [] });
            await guild.members.fetch().catch(() => { });
            const roles = guild.roles.cache.filter(r => r.id !== guild.id).sort((a, b) => b.position - a.position).first(15);
            const channels = guild.channels.cache;
            const owner = await guild.fetchOwner().catch(() => null);
            const memberLines = [];
            if (scope === 'admins' || scope === 'higher') {
                const members = scope === 'admins'
                    ? [...guild.members.cache.values()].filter(m => m.permissions.has(PermissionFlagsBits.Administrator))
                    : [...guild.members.cache.values()].filter(m => {
                        const botPosition = guild.members.me?.roles?.highest?.position || 0;
                        return m.roles.highest.position > botPosition;
                    });
                memberLines.push(`**Selected members (${members.length}):**`, ...members.slice(0, 35).map(m => `• ${m.user.tag} — \`${m.id}\` — ${m.roles.highest.name}`));
            }
            const desc = `**Server:** ${guild.name}\n**ID:** \`${guild.id}\`\n**Owner:** ${owner ? `${owner.user.tag} (\`${owner.id}\`)` : `<@${guild.ownerId}>`}\n**Created:** <t:${Math.floor(guild.createdTimestamp / 1000)}:F>\n**Members:** ${guild.memberCount}\n**Channels:** ${channels.size}\n**Roles:** ${guild.roles.cache.size - 1}\n**Emojis:** ${guild.emojis.cache.size}\n**Boosts:** ${guild.premiumSubscriptionCount || 0} (Tier ${guild.premiumTier || 0})\n**Verification:** ${guild.verificationLevel}\n**Features:** ${(guild.features || []).join(', ') || 'None'}${memberLines.length ? `\n\n${memberLines.join('\n').slice(0, 2600)}` : ''}`;
            return interaction.update({ embeds: [ui.base(`${ui.emoji('info')} ${guild.name}`).setDescription(desc)], components: [] });
        }
        if (interaction.isModalSubmit() && interaction.customId.startsWith('em_edit_modal:')) {
            if (!isOwner(interaction.user.id))
                return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
            const name = interaction.customId.split(':')[1];
            const title = interaction.fields.getTextInputValue('title').trim();
            const description = interaction.fields.getTextInputValue('description').trim();
            const footer = interaction.fields.getTextInputValue('footer').trim();
            const row = db.updateEmbedText(name, { title, description, footer });
            if (!row)
                return interaction.reply({ embeds: [ui.errorEmbed('Embed Not Found', `The embed **${name}** no longer exists.`)], ephemeral: true });
            return interaction.reply({ embeds: [ui.okEmbed('Embed Updated', `Updated **${row.name}**. Future matching embeds will use the new text. Emojis are rescanned automatically.`)], ephemeral: true });
        }
        if (interaction.isChatInputCommand()) {
            if (interaction.guildId && db.getConfig(interaction.guildId).blacklist.includes(interaction.user.id)) {
                return interaction.reply({ embeds: [ui.errorEmbed('Blacklisted', 'You are blocked from using this bot.')], ephemeral: true });
            }
            const cmd = commands.find(c => c.data.name === interaction.commandName);
            if (cmd) {
                loggingMod.trackCommand(interaction);
                await executeCommand(cmd, interaction);
            }
            return;
        }
        if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('buttonroles_role_select:')) {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
            const panelId = interaction.customId.split(':')[1], panel = getPanel(interaction.guildId, 'button', panelId), role = interaction.guild.roles.cache.get(interaction.values[0]);
            if (!panel)
                return interaction.reply({ embeds: [ui.errorEmbed('Panel Not Found', 'That button-role panel no longer exists.')], ephemeral: true });
            if (!role)
                return interaction.reply({ embeds: [ui.errorEmbed('Role Not Found', 'That role is no longer available.')], ephemeral: true });
            if (role.id === interaction.guild.id)
                return interaction.reply({ embeds: [ui.errorEmbed('Invalid Role', '@everyone cannot be used.')], ephemeral: true });
            const bot = interaction.guild.members.me;
            if (role.position >= bot.roles.highest.position)
                return interaction.reply({ embeds: [ui.errorEmbed('Role Hierarchy', `I cannot manage **${role.name}** because it is equal to or higher than my highest role.`)], ephemeral: true });
            db.upsertPanel(interaction.guildId, 'button', { ...panel, buttons: [...(panel.buttons || []).filter(b => b.roleId !== role.id), { roleId: role.id, label: role.name.slice(0, 80), mode: 'toggle' }] });
            rememberSelectedPanel(interaction.guildId, interaction.user.id, 'button', panelId);
            return interaction.update(panelManagerPayload(interaction.guildId, interaction.user.id, 'button'));
        }
        if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('reactionroles_role_select:')) {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
            const panelId = interaction.customId.split(':')[1], panel = getPanel(interaction.guildId, 'reaction', panelId), role = interaction.guild.roles.cache.get(interaction.values[0]);
            if (!panel)
                return interaction.reply({ embeds: [ui.errorEmbed('Panel Not Found', 'That reaction-role panel no longer exists.')], ephemeral: true });
            if (!role)
                return interaction.reply({ embeds: [ui.errorEmbed('Role Not Found', 'That role is no longer available.')], ephemeral: true });
            const bot = interaction.guild.members.me;
            if (role.position >= bot.roles.highest.position)
                return interaction.reply({ embeds: [ui.errorEmbed('Role Hierarchy', `I cannot manage **${role.name}** because it is equal to or higher than my highest role.`)], ephemeral: true });
            const modal = new ModalBuilder().setCustomId(`reactionroles_add_modal:${panelId}:${role.id}`).setTitle('Add Reaction Role');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emoji').setLabel('Emoji').setPlaceholder('🎮 or <:name:id>').setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('label').setLabel('Label (optional)').setPlaceholder(role.name).setStyle(TextInputStyle.Short).setRequired(false)));
            return interaction.showModal(modal);
        }
        if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('buttonroles_cfg:channel:')) {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
            const panelId = interaction.customId.split(':')[2], panel = getPanel(interaction.guildId, 'button', panelId);
            if (!panel)
                return interaction.reply({ embeds: [ui.errorEmbed('Panel Not Found', 'That panel no longer exists.')], ephemeral: true });
            db.upsertPanel(interaction.guildId, 'button', { ...panel, channelId: interaction.values[0] });
            rememberSelectedPanel(interaction.guildId, interaction.user.id, 'button', panelId);
            return interaction.update(panelManagerPayload(interaction.guildId, interaction.user.id, 'button'));
        }
        if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('reactionroles_cfg:channel:')) {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
            const panelId = interaction.customId.split(':')[2], panel = getPanel(interaction.guildId, 'reaction', panelId);
            if (!panel)
                return interaction.reply({ embeds: [ui.errorEmbed('Panel Not Found', 'That panel no longer exists.')], ephemeral: true });
            db.upsertPanel(interaction.guildId, 'reaction', { ...panel, channelId: interaction.values[0] });
            rememberSelectedPanel(interaction.guildId, interaction.user.id, 'reaction', panelId);
            return interaction.update(panelManagerPayload(interaction.guildId, interaction.user.id, 'reaction'));
        }
        if (interaction.isStringSelectMenu() && interaction.customId === 'buttonroles_cfg:select') {
            rememberSelectedPanel(interaction.guildId, interaction.user.id, 'button', interaction.values[0]);
            return interaction.update(panelManagerPayload(interaction.guildId, interaction.user.id, 'button'));
        }
        if (interaction.isStringSelectMenu() && interaction.customId === 'reactionroles_cfg:select') {
            rememberSelectedPanel(interaction.guildId, interaction.user.id, 'reaction', interaction.values[0]);
            return interaction.update(panelManagerPayload(interaction.guildId, interaction.user.id, 'reaction'));
        }
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('buttonroles_cfg:remove_role:')) {
            const panelId = interaction.customId.split(':')[2], panel = getPanel(interaction.guildId, 'button', panelId);
            if (!panel)
                return interaction.reply({ embeds: [ui.errorEmbed('Panel Not Found', 'That panel no longer exists.')], ephemeral: true });
            db.upsertPanel(interaction.guildId, 'button', { ...panel, buttons: (panel.buttons || []).filter(b => b.roleId !== interaction.values[0]) });
            rememberSelectedPanel(interaction.guildId, interaction.user.id, 'button', panelId);
            return interaction.update(panelManagerPayload(interaction.guildId, interaction.user.id, 'button'));
        }
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('reactionroles_cfg:remove_role:')) {
            const panelId = interaction.customId.split(':')[2], panel = getPanel(interaction.guildId, 'reaction', panelId);
            if (!panel)
                return interaction.reply({ embeds: [ui.errorEmbed('Panel Not Found', 'That panel no longer exists.')], ephemeral: true });
            db.upsertPanel(interaction.guildId, 'reaction', { ...panel, mappings: (panel.mappings || []).filter(m => m.roleId !== interaction.values[0]) });
            rememberSelectedPanel(interaction.guildId, interaction.user.id, 'reaction', panelId);
            return interaction.update(panelManagerPayload(interaction.guildId, interaction.user.id, 'reaction'));
        }
        if (interaction.isButton() && interaction.customId.startsWith('giveaway_publish:')) {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Manage Server is required.')], ephemeral: true });
            const id = Number(interaction.customId.split(':')[1]);
            const g = db.getGiveaway(interaction.guildId, id);
            if (!g || g.status !== 'configuring')
                return interaction.reply({ embeds: [ui.errorEmbed('Giveaway Unavailable', 'That giveaway no longer exists or was already published.')], ephemeral: true });
            const ch = interaction.guild.channels.cache.get(g.channelId) || interaction.channel;
            const row = new (require('discord.js').ActionRowBuilder)().addComponents(new (require('discord.js').ButtonBuilder)().setCustomId(`giveaway_join:${g.id}`).setLabel('🎉 Enter Giveaway').setStyle(require('discord.js').ButtonStyle.Success));
            const msg = await ch.send({ embeds: [ui.base('🎉 Giveaway')
                        .setDescription(`**Prize:** ${g.prize}\n**Winners:** **${g.winners}**\n**Ends:** <t:${Math.floor(g.endsAt / 1000)}:R>\n\nClick the button below to enter.`)
                        .setFooter({ text: `Hosted by ${interaction.user.tag} • Giveaway #${g.id}` })], components: [row] });
            db.updateGiveaway(interaction.guildId, id, { messageId: msg.id, channelId: ch.id, status: 'active' });
            return interaction.update({ embeds: [ui.okEmbed('🎉 Giveaway Published', `Published in ${ch}.\n\n**Prize:** ${g.prize}\n**Ends:** <t:${Math.floor(g.endsAt / 1000)}:R>`)], components: [] });
        }
        if (interaction.isButton() && interaction.customId.startsWith('giveaway_cancel:')) {
            const id = Number(interaction.customId.split(':')[1]);
            const g = db.getGiveaway(interaction.guildId, id);
            if (!g)
                return interaction.reply({ embeds: [ui.errorEmbed('Not Found', 'Giveaway not found.')], ephemeral: true });
            if (g.hostId !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))
                return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Only the host or a server manager can cancel it.')], ephemeral: true });
            db.updateGiveaway(interaction.guildId, id, { status: 'cancelled' });
            return interaction.update({ embeds: [ui.okEmbed('Giveaway Cancelled', `Giveaway #${id} was cancelled.`)], components: [] });
        }
        if (interaction.isButton() && interaction.customId.startsWith('giveaway_join:')) {
            const id = Number(interaction.customId.split(':')[1]);
            const g = db.getGiveaway(interaction.guildId, id);
            if (!g || g.status !== 'active' || Date.now() >= g.endsAt)
                return interaction.reply({ embeds: [ui.errorEmbed('Giveaway Ended', 'This giveaway is no longer accepting entries.')], ephemeral: true });
            let participants = [];
            try {
                participants = JSON.parse(g.participants || '[]');
            }
            catch { }
            const exists = participants.includes(interaction.user.id);
            participants = exists ? participants.filter(x => x !== interaction.user.id) : [...participants, interaction.user.id];
            db.updateGiveaway(interaction.guildId, id, { participants: JSON.stringify(participants) });
            return interaction.reply({ embeds: [ui.okEmbed(exists ? 'Entry Removed' : '🎉 Entry Added', exists ? 'You left the giveaway.' : `You are entered! **${participants.length}** participant(s).`)], ephemeral: true });
        }
        if (interaction.isStringSelectMenu() && interaction.customId === 'help_select') {
            const key = interaction.values[0];
            return interaction.update({ embeds: [ui.helpCategoryEmbed(key)], components: [ui.helpSelectRow()] });
        }
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('automod_cfg:')) {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
            const part = interaction.customId.split(':')[1], value = interaction.values[0];
            const patch = part === 'status' ? { enabled: value === 'enable' } :
                part === 'filter' ? ({ badWordFilter: value === 'badwords' ? !db.getConfig(interaction.guildId).automod.badWordFilter :
                        db.getConfig(interaction.guildId).automod.badWordFilter,
                    capsFilter: value === 'caps' ? !db.getConfig(interaction.guildId).automod.capsFilter : db.getConfig(interaction.guildId).automod.capsFilter,
                    inviteFilter: value === 'invites' ? !db.getConfig(interaction.guildId).automod.inviteFilter : db.getConfig(interaction.guildId).automod.inviteFilter }) : {};
            const cfg = db.saveConfig(interaction.guildId, { automod: patch }).automod;
            return interaction.update({ embeds: [ui.automodSetupEmbed(cfg)], components: ui.automodSetupRows(cfg) });
        }
        if (interaction.customId?.startsWith('logsetup:') && !interaction.guildId) {
            return interaction.reply({ embeds: [ui.errorEmbed('Server Only', 'Logging setup must be used inside a server.')], ephemeral: true });
        }
        if (interaction.customId?.startsWith('logsetup:')) {
            const perms = interaction.memberPermissions || interaction.member?.permissions;
            if (!(interaction.guild?.ownerId === interaction.user.id || perms?.has(PermissionFlagsBits.Administrator) || perms?.has(PermissionFlagsBits.ManageGuild))) {
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Server owner, Administrator, or Manage Server is required.')], ephemeral: true });
            }
        }
        if (interaction.isStringSelectMenu() && interaction.customId === 'logsetup:type') {
            logSetupSessions.set(`${interaction.guildId}:${interaction.user.id}`, interaction.values[0]);
            const cfg = db.getConfig(interaction.guildId).logs;
            return interaction.update({ embeds: [ui.logSetupEmbed(cfg)], components: ui.logSetupRows(cfg) });
        }
        if (interaction.isStringSelectMenu() && interaction.customId === 'logsetup:event') {
            const eventKey = interaction.values[0];
            const cfgNow = db.getConfig(interaction.guildId).logs || {};
            const events = { ...(cfgNow.events || {}) };
            const currentlyEnabled = typeof events[eventKey] === 'boolean' ? events[eventKey] : LOG_EVENT_DEFAULTS[eventKey] !== false;
            events[eventKey] = !currentlyEnabled;
            const cfg = db.saveConfig(interaction.guildId, { logs: { events } }).logs;
            return interaction.update({ embeds: [ui.logSetupEmbed(cfg)], components: ui.logSetupRows(cfg) });
        }
        if (interaction.isChannelSelectMenu() && interaction.customId === 'logsetup:channel') {
            const key = `${interaction.guildId}:${interaction.user.id}`, type = logSetupSessions.get(key);
            if (!type)
                return interaction.reply({ embeds: [ui.errorEmbed('Select Log Type First', 'Choose a log stream in the first menu, then choose its destination channel.')], ephemeral: true });
            const channel = interaction.guild.channels.cache.get(interaction.values[0]);
            if (!channel?.isTextBased?.())
                return interaction.reply({ embeds: [ui.errorEmbed('Invalid Channel', 'Choose a text or announcement channel.')], ephemeral: true });
            const missing = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks].filter(flag => !channel.permissionsFor(interaction.guild.members.me)?.has(flag));
            if (missing.length)
                return interaction.reply({ embeds: [ui.errorEmbed('Channel Not Usable', 'I need View Channel, Send Messages, and Embed Links in the selected channel.')], ephemeral: true });
            const cfg = db.saveConfig(interaction.guildId, { logs: { [type]: channel.id } }).logs;
            logSetupSessions.delete(key);
            return interaction.update({ embeds: [ui.logSetupEmbed(cfg)], components: ui.logSetupRows(cfg) });
        }
        if (interaction.isButton() && interaction.customId.startsWith('logsetup:')) {
            const old = db.getConfig(interaction.guildId).logs || {};
            let patch = {};
            if (interaction.customId === 'logsetup:toggle-system') patch = { enabled: old.enabled === false };
            else if (interaction.customId === 'logsetup:all-on' || interaction.customId === 'logsetup:all-off') {
                const turnOn = interaction.customId.endsWith('all-on');
                patch = { events: Object.fromEntries(Object.keys(LOG_EVENT_DEFAULTS).map(k => [k, turnOn])) };
                if (turnOn) patch.events.messageCreate = true;
            }
            else if (interaction.customId === 'logsetup:refresh') {
                return interaction.update({ embeds: [ui.logSetupEmbed(old)], components: ui.logSetupRows(old) });
            }
            else if (interaction.customId === 'logsetup:test') {
                const type = logSetupSessions.get(`${interaction.guildId}:${interaction.user.id}`) || 'message';
                const sent = await sendGuildAuditLog(interaction.guild, type, 'loggingTest', '✅ Logging Test', `The **${type}** log stream can deliver messages to this channel. Requested by ${interaction.user.tag} (${interaction.user.id}).`, [{ name: 'Test result', value: 'This is a real test delivery; no server event was fabricated.', inline: false }]);
                if (!sent) return interaction.reply({ embeds: [ui.errorEmbed('Test Not Sent', 'Select a stream, configure its destination, ensure logging is enabled, and check my channel permissions. No test log was sent.')], ephemeral: true });
                return interaction.reply({ embeds: [ui.okEmbed('Test Sent', `A test log was delivered to the configured **${type}** stream.`)], ephemeral: true });
            }
            const cfg = db.saveConfig(interaction.guildId, { logs: patch }).logs;
            return interaction.update({ embeds: [ui.logSetupEmbed(cfg)], components: ui.logSetupRows(cfg) });
        }
        if (interaction.isChannelSelectMenu() && interaction.customId === 'buttonroles_cfg:channel') {
            const cfg = db.saveConfig(interaction.guildId, { buttonRoles: { channelId: interaction.values[0] } }).buttonRoles;
            return interaction.update({ embeds: [ui.buttonRoleEmbed(cfg)], components: ui.buttonRoleSetupRows(cfg) });
        }
        if (interaction.isChannelSelectMenu() && interaction.customId === 'reactionroles_cfg:channel') {
            const cfg = db.saveConfig(interaction.guildId, { reactionRoles: { channelId: interaction.values[0] } }).reactionRoles;
            return interaction.update({ embeds: [ui.reactionRoleSetupEmbed(cfg)], components: ui.reactionRoleSetupRows(cfg) });
        }
        if (interaction.isStringSelectMenu() && interaction.customId === 'role_select')
            return handleButton(interaction);
        if (interaction.isStringSelectMenu() && interaction.customId === 'role_select')
            return handleButton(interaction);
        if (interaction.isChannelSelectMenu() && interaction.customId === 'vm_setup_category_select') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to use this.')], ephemeral: true });
            }
            const cfg = db.saveConfig(interaction.guildId, { voicemaster: { categoryId: interaction.values[0] } });
            return interaction.update({ embeds: [ui.vmSetupEmbed(cfg)], components: ui.vmSetupRows(cfg) });
        }
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('security_cfg:')) {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
            const [, module, field] = interaction.customId.split(':');
            const value = interaction.values[0];
            const keyMap = { action: { antiwebhook: 'action', antibot: 'action', antialt: 'action' }, age: { antialt: 'minAccountAgeDays' } };
            const key = keyMap[field]?.[module];
            if (!key)
                return interaction.reply({ embeds: [ui.errorEmbed('Invalid Setting', 'That security setting is unavailable.')], ephemeral: true });
            const cfg = db.saveConfig(interaction.guildId, { [module]: { [key]: field === 'age' ? Number(value) : value } });
            return interaction.update({ embeds: [ui.setupPanelEmbed(module, cfg)], components: ui.setupPanelRow(module, cfg) });
        }
        if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('security_cfg:')) {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
            const [, module, field] = interaction.customId.split(':');
            if (field !== 'bypass')
                return;
            const cfg = db.saveConfig(interaction.guildId, { [module]: { bypassRoleId: interaction.values[0] } });
            return interaction.update({ embeds: [ui.setupPanelEmbed(module, cfg)], components: ui.setupPanelRow(module, cfg) });
        }
        if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('security_cfg:')) {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
            const [, module, field] = interaction.customId.split(':');
            if (field !== 'log')
                return;
            const cfg = db.saveConfig(interaction.guildId, { [module]: { logChannelId: interaction.values[0] } });
            return interaction.update({ embeds: [ui.setupPanelEmbed(module, cfg)], components: ui.setupPanelRow(module, cfg) });
        }
        if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('birthday_cfg:')) {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
            const part = interaction.customId.split(':')[1];
            const patch = part === 'panel' ? { birthdays: { panelChannelId: interaction.values[0] } } : { birthdays: { wishChannelId: interaction.values[0] } };
            const cfg = db.saveConfig(interaction.guildId, patch).birthdays;
            return interaction.update({ embeds: [ui.birthdaySetupEmbed(cfg)], components: ui.birthdaySetupRow(cfg) });
        }
        if (interaction.isRoleSelectMenu() && interaction.customId === 'honeypot_cfg:roles') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Manage Server**.')], ephemeral: true });
            const cfg = db.saveConfig(interaction.guildId, { honeypot: { whitelistRoleIds: [...interaction.values] } }).honeypot;
            return interaction.update({ embeds: [ui.honeypotSetupEmbed(cfg)], components: ui.honeypotSetupRow(cfg) });
        }
        if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('honeypot_cfg:')) {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
            const part = interaction.customId.split(':')[1];
            if (part === 'channel')
                db.saveConfig(interaction.guildId, { honeypot: { channelId: interaction.values[0] } });
            else if (part === 'log')
                db.saveConfig(interaction.guildId, { honeypot: { logChannelId: interaction.values[0] } });
            const cfg = db.getConfig(interaction.guildId).honeypot;
            return interaction.update({ embeds: [ui.honeypotSetupEmbed(cfg)], components: ui.honeypotSetupRow(cfg) });
        }
        if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('antibadword_cfg:')) {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
            db.saveConfig(interaction.guildId, { antibadword: { logChannelId: interaction.values[0] } });
            const cfg = db.getConfig(interaction.guildId).antibadword;
            return interaction.update({ embeds: [ui.antiBadwordSetupEmbed(cfg)], components: ui.antiBadwordSetupRow(cfg) });
        }
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('honeypot_cfg:')) {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
            const part = interaction.customId.split(':')[1];
            const value = interaction.values[0];
            db.saveConfig(interaction.guildId, { honeypot: part === 'action' ? { action: value } : { cleanupWindow: value } });
            const cfg = db.getConfig(interaction.guildId).honeypot;
            return interaction.update({ embeds: [ui.honeypotSetupEmbed(cfg)], components: ui.honeypotSetupRow(cfg) });
        }
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('antibadword_cfg:')) {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
            db.saveConfig(interaction.guildId, { antibadword: { action: interaction.values[0] } });
            const cfg = db.getConfig(interaction.guildId).antibadword;
            return interaction.update({ embeds: [ui.antiBadwordSetupEmbed(cfg)], components: ui.antiBadwordSetupRow(cfg) });
        }
        if (interaction.isStringSelectMenu() && interaction.customId === 'autoresponder_cfg:remove') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
            const cfg = db.getConfig(interaction.guildId).autoresponder;
            const triggers = (cfg.triggers || []).filter(t => t.id !== interaction.values[0]);
            const next = db.saveConfig(interaction.guildId, { autoresponder: { triggers } }).autoresponder;
            return interaction.update({ embeds: [ui.autoresponderSetupEmbed(next)], components: ui.autoresponderSetupRow(next) });
        }
        if (interaction.isStringSelectMenu() && interaction.customId === 'autoreactor_cfg:remove') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
            const cfg = db.getConfig(interaction.guildId).autoreactor;
            const triggers = (cfg.triggers || []).filter(t => t.id !== interaction.values[0]);
            const next = db.saveConfig(interaction.guildId, { autoreactor: { triggers } }).autoreactor;
            return interaction.update({ embeds: [ui.autoreactorSetupEmbed(next)], components: ui.autoreactorSetupRow(next) });
        }
        if (interaction.isStringSelectMenu() && interaction.customId === 'embedbuilder:removebutton') {
            const draft = sys.embedBuilderSessions.get(interaction.user.id);
            if (!draft)
                return interaction.reply({ embeds: [ui.errorEmbed('Session Expired', 'Run `/embedbuilder` again to start a fresh draft.')], ephemeral: true });
            draft.buttons.splice(Number(interaction.values[0]), 1);
            return interaction.update({ embeds: [ui.embedBuilderPreviewEmbed(draft)], components: ui.embedBuilderRow(draft) });
        }
        if (interaction.isChannelSelectMenu() && interaction.customId === 'embedbuilder:post_channel') {
            const draft = sys.embedBuilderSessions.get(interaction.user.id);
            if (!draft)
                return interaction.update({ content: 'Session expired — run `/embedbuilder` again.', components: [] });
            const channel = interaction.guild.channels.cache.get(interaction.values[0]);
            if (!channel?.isTextBased())
                return interaction.update({ content: 'That channel is not usable — pick a text channel.', components: [] });
            const embed = ui.embedBuilderPreviewEmbed(draft);
            const buttonComponents = (draft.buttons || []).map(b => {
                const btn = new ButtonBuilder().setLabel(b.label.slice(0, 80)).setStyle(ButtonStyle.Link).setURL(b.url);
                if (b.emoji)
                    btn.setEmoji(b.emoji);
                return btn;
            });
            const rows = buttonComponents.length ? [new ActionRowBuilder().addComponents(buttonComponents)] : [];
            await channel.send({ embeds: [embed], components: rows }).catch(() => { });
            sys.embedBuilderSessions.delete(interaction.user.id);
            return interaction.update({ content: `Posted in ${channel}.`, components: [] });
        }
        if (interaction.isChannelSelectMenu() && interaction.customId === 'vm_setup_channel_select') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to use this.')], ephemeral: true });
            }
            const cfg = db.saveConfig(interaction.guildId, { voicemaster: { hubChannelId: interaction.values[0] } });
            return interaction.update({ embeds: [ui.vmSetupEmbed(cfg)], components: ui.vmSetupRows(cfg) });
        }
        if (interaction.isUserSelectMenu() && interaction.customId === 'ticket_addmember_select')
            return handleTicketMemberSelect(interaction, 'add');
        if (interaction.isUserSelectMenu() && interaction.customId === 'ticket_removemember_select')
            return handleTicketMemberSelect(interaction, 'remove');
        if (interaction.isButton())
            return handleButton(interaction);
        if (interaction.isModalSubmit())
            return handleModal(interaction);
    }
    catch (err) {
        logOwnerError(err, `Interaction ${interaction.commandName || interaction.customId || interaction.id}`, { command: interaction.commandName, guildId: interaction.guildId, userId: interaction.user?.id }).catch(() => { });
        const payload = { embeds: [ui.errorEmbed('Error', 'Something went wrong running that.')], ephemeral: true };
        if (interaction.deferred || interaction.replied)
            interaction.followUp(payload).catch(() => { });
        else
            interaction.reply(payload).catch(() => { });
    }
    finally {
        stopInteractionWatchdog();
    }
});
function rolePanelKey(guildId, userId) { return `${guildId}:${userId}`; }
function rolePanelState(guildId, userId) {
    const key = rolePanelKey(guildId, userId);
    const current = rolePanelSessions.get(key) || { buttonId: null, reactionId: null };
    rolePanelSessions.set(key, current);
    return current;
}
function newPanelId(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function getPanel(guildId, kind, panelId) { return db.findPanel(guildId, kind, panelId); }
function rememberSelectedPanel(guildId, userId, kind, panelId) {
    const state = rolePanelState(guildId, userId);
    if (kind === 'button')
        state.buttonId = panelId;
    else
        state.reactionId = panelId;
    rolePanelSessions.set(rolePanelKey(guildId, userId), state);
}
function panelManagerPayload(guildId, userId, kind) {
    const cfg = db.getConfig(guildId), state = rolePanelState(guildId, userId);
    const selectedId = kind === 'button' ? state.buttonId : state.reactionId;
    return kind === 'button'
        ? { embeds: [ui.buttonRoleEmbed(cfg, selectedId)], components: ui.buttonRoleSetupRows(cfg, selectedId) }
        : { embeds: [ui.reactionRoleSetupEmbed(cfg, selectedId)], components: ui.reactionRoleSetupRows(cfg, selectedId) };
}
function createButtonPanel() {
    return { id: newPanelId('btn'), enabled: true, channelId: null, title: 'Choose your roles', description: 'Press a button to get or remove a role.', image: null, embedType: 'embed', buttons: [] };
}
function createReactionPanel() {
    return { id: newPanelId('react'), enabled: true, channelId: null, messageId: null, title: 'Choose your roles', description: 'React below to receive or remove a role.', image: null, mappings: [] };
}
async function postButtonRolePanel(guild, cfg) {
    if (!cfg.channelId)
        throw new Error('Select a panel channel first.');
    if (cfg.enabled === false)
        throw new Error('This panel is disabled. Enable it before posting.');
    if (!(cfg.buttons || []).length)
        throw new Error('Add at least one role button first.');
    const channel = guild.channels.cache.get(cfg.channelId);
    if (!channel?.isTextBased())
        throw new Error('The configured panel channel is unavailable.');
    const bot = guild.members.me;
    if (!bot?.permissions.has(PermissionFlagsBits.ManageRoles) && !bot?.permissions.has(PermissionFlagsBits.Administrator))
        throw new Error('I need Manage Roles to create a role panel.');
    for (const b of cfg.buttons) {
        const role = guild.roles.cache.get(b.roleId);
        if (!role)
            throw new Error(`The role for **${b.label || b.roleId}** no longer exists.`);
        if (role.position >= bot.roles.highest.position)
            throw new Error(`I cannot manage **${role.name}** because it is equal to or higher than my highest role.`);
    }
    const e = ui.base(cfg.title || 'Choose your roles').setDescription(cfg.description || 'Press a button to get or remove a role.');
    if (cfg.image)
        e.setImage(cfg.image);
    const components = [];
    for (let i = 0; i < cfg.buttons.length; i += 5) {
        const row = new ActionRowBuilder();
        for (const b of cfg.buttons.slice(i, i + 5))
            row.addComponents(new ButtonBuilder().setCustomId(`rolebtn:${cfg.id}:${b.roleId}`).setLabel(b.label || 'Role').setStyle(ButtonStyle.Primary));
        components.push(row);
    }
    if (cfg.embedType === 'selection') {
        const menu = new StringSelectMenuBuilder().setCustomId(`role_select:${cfg.id}`).setPlaceholder('Choose a role…').addOptions(cfg.buttons.slice(0, 25).map(b => ({ label: (b.label || 'Role').slice(0, 100), value: b.roleId })));
        components.splice(0, components.length, new ActionRowBuilder().addComponents(menu));
    }
    return channel.send({ embeds: [e], components });
}
async function postReactionRolePanel(guild, cfg) {
    if (!cfg.channelId)
        throw new Error('Select a panel channel first.');
    if (cfg.enabled === false)
        throw new Error('This panel is disabled. Enable it before posting.');
    if (!(cfg.mappings || []).length)
        throw new Error('Add at least one role mapping first.');
    const channel = guild.channels.cache.get(cfg.channelId);
    if (!channel?.isTextBased())
        throw new Error('The configured panel channel is unavailable.');
    const bot = guild.members.me;
    if (!bot?.permissions.has(PermissionFlagsBits.ManageRoles) && !bot?.permissions.has(PermissionFlagsBits.Administrator))
        throw new Error('I need Manage Roles to create a role panel.');
    for (const m of cfg.mappings) {
        const role = guild.roles.cache.get(m.roleId);
        if (!role)
            throw new Error(`The role for **${m.label || m.roleId}** no longer exists.`);
        if (role.position >= bot.roles.highest.position)
            throw new Error(`I cannot manage **${role.name}** because it is equal to or higher than my highest role.`);
    }
    if (cfg.messageId) {
        const old = await channel.messages.fetch(cfg.messageId).catch(() => null);
        if (old)
            await old.delete().catch(() => { });
    }
    const e = ui.base(cfg.title || 'Choose your roles').setDescription(cfg.description || 'React below to receive or remove a role.');
    if (cfg.image)
        e.setImage(cfg.image);
    const msg = await channel.send({ embeds: [e] });
    for (const m of cfg.mappings)
        await msg.react(m.emoji).catch(() => { });
    return msg;
}
async function handleButton(interaction) {
    const id = interaction.customId;
    if (id === 'buttonroles_cfg:create' || id === 'reactionroles_cfg:create') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
        const kind = id.startsWith('button') ? 'button' : 'reaction';
        const panel = kind === 'button' ? createButtonPanel() : createReactionPanel();
        db.upsertPanel(interaction.guildId, kind, panel);
        rememberSelectedPanel(interaction.guildId, interaction.user.id, kind, panel.id);
        return interaction.update(panelManagerPayload(interaction.guildId, interaction.user.id, kind));
    }
    if (id === 'buttonroles_cfg:toggle' || id === 'buttonroles_cfg:delete') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
        const state = rolePanelState(interaction.guildId, interaction.user.id), panel = getPanel(interaction.guildId, 'button', state.buttonId);
        if (!panel)
            return interaction.reply({ embeds: [ui.errorEmbed('No Panel Selected', 'Create or select a button-role panel first.')], ephemeral: true });
        if (id.endsWith(':delete')) {
            db.removePanel(interaction.guildId, 'button', panel.id);
            state.buttonId = null;
        }
        else
            db.upsertPanel(interaction.guildId, 'button', { ...panel, enabled: panel.enabled === false });
        return interaction.update(panelManagerPayload(interaction.guildId, interaction.user.id, 'button'));
    }
    if (id === 'reactionroles_cfg:toggle' || id === 'reactionroles_cfg:delete') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
        const state = rolePanelState(interaction.guildId, interaction.user.id), panel = getPanel(interaction.guildId, 'reaction', state.reactionId);
        if (!panel)
            return interaction.reply({ embeds: [ui.errorEmbed('No Panel Selected', 'Create or select a reaction-role panel first.')], ephemeral: true });
        if (id.endsWith(':delete')) {
            db.removePanel(interaction.guildId, 'reaction', panel.id);
            state.reactionId = null;
        }
        else
            db.upsertPanel(interaction.guildId, 'reaction', { ...panel, enabled: panel.enabled === false });
        return interaction.update(panelManagerPayload(interaction.guildId, interaction.user.id, 'reaction'));
    }
    if (id.startsWith('buttonroles_cfg:settings:')) {
        const panelId = id.split(':')[2], panel = getPanel(interaction.guildId, 'button', panelId);
        if (!panel)
            return interaction.reply({ embeds: [ui.errorEmbed('Panel Not Found', 'That panel no longer exists.')], ephemeral: true });
        const modal = new ModalBuilder().setCustomId(`buttonroles_panel_modal:${panelId}`).setTitle('Button Role Panel Text');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Panel title').setStyle(TextInputStyle.Short).setRequired(true).setValue((panel.title || 'Choose your roles').slice(0, 100))), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Panel message').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue((panel.description || 'Press a button to get or remove a role.').slice(0, 1000))), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('style').setLabel('Style: embed or selection').setStyle(TextInputStyle.Short).setRequired(true).setValue(panel.embedType || 'embed')));
        return interaction.showModal(modal);
    }
    if (id.startsWith('reactionroles_cfg:settings:')) {
        const panelId = id.split(':')[2], panel = getPanel(interaction.guildId, 'reaction', panelId);
        if (!panel)
            return interaction.reply({ embeds: [ui.errorEmbed('Panel Not Found', 'That panel no longer exists.')], ephemeral: true });
        const modal = new ModalBuilder().setCustomId(`reactionroles_panel_modal:${panelId}`).setTitle('Reaction Role Panel Text');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Panel title').setStyle(TextInputStyle.Short).setRequired(true).setValue((panel.title || 'Choose your roles').slice(0, 100))), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Panel message').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue((panel.description || 'React below to receive or remove a role.').slice(0, 1000))));
        return interaction.showModal(modal);
    }
    if (id.startsWith('buttonroles_cfg:addrole:')) {
        const panelId = id.split(':')[2];
        return interaction.reply({ embeds: [ui.base('🎭 Select Role').setDescription('Choose the role to add. No role ID is needed.')], components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`buttonroles_role_select:${panelId}`).setPlaceholder('Select a role…'))], ephemeral: true });
    }
    if (id.startsWith('reactionroles_cfg:addrole:')) {
        const panelId = id.split(':')[2];
        return interaction.reply({ embeds: [ui.base('🎭 Select Role').setDescription('Choose the role to add. I will ask for the emoji next.')], components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`reactionroles_role_select:${panelId}`).setPlaceholder('Select a role…'))], ephemeral: true });
    }
    if (id.startsWith('buttonroles_cfg:upload:')) {
        const panelId = id.split(':')[2], panel = getPanel(interaction.guildId, 'button', panelId);
        if (!panel)
            return interaction.reply({ embeds: [ui.errorEmbed('Panel Not Found', 'That panel no longer exists.')], ephemeral: true });
        return startSetupMediaUpload(interaction, { label: 'the button-role panel', apply: async (url) => db.upsertPanel(interaction.guildId, 'button', { ...panel, image: url }), render: () => panelManagerPayload(interaction.guildId, interaction.user.id, 'button') });
    }
    if (id.startsWith('buttonroles_cfg:remove_image:')) {
        const panelId = id.split(':')[2], panel = getPanel(interaction.guildId, 'button', panelId);
        if (!panel)
            return interaction.reply({ embeds: [ui.errorEmbed('Panel Not Found', 'That panel no longer exists.')], ephemeral: true });
        db.upsertPanel(interaction.guildId, 'button', { ...panel, image: null });
        return interaction.update(panelManagerPayload(interaction.guildId, interaction.user.id, 'button'));
    }
    if (id.startsWith('buttonroles_cfg:post:')) {
        const panelId = id.split(':')[2], panel = getPanel(interaction.guildId, 'button', panelId);
        if (!panel)
            return interaction.reply({ embeds: [ui.errorEmbed('Panel Not Found', 'That panel no longer exists.')], ephemeral: true });
        try {
            const msg = await postButtonRolePanel(interaction.guild, panel);
            db.upsertPanel(interaction.guildId, 'button', { ...panel, messageId: msg.id });
            return interaction.reply({ embeds: [ui.okEmbed('✅ Panel Posted', `Button-role panel posted in <#${msg.channel.id}>.`)], ephemeral: true });
        }
        catch (e) {
            return interaction.reply({ embeds: [ui.errorEmbed('Cannot Post Panel', e.message)], ephemeral: true });
        }
    }
    if (id.startsWith('reactionroles_cfg:upload:')) {
        const panelId = id.split(':')[2], panel = getPanel(interaction.guildId, 'reaction', panelId);
        if (!panel)
            return interaction.reply({ embeds: [ui.errorEmbed('Panel Not Found', 'That panel no longer exists.')], ephemeral: true });
        return startSetupMediaUpload(interaction, { label: 'the reaction-role panel', apply: async (url) => db.upsertPanel(interaction.guildId, 'reaction', { ...panel, image: url }), render: () => panelManagerPayload(interaction.guildId, interaction.user.id, 'reaction') });
    }
    if (id.startsWith('reactionroles_cfg:remove_image:')) {
        const panelId = id.split(':')[2], panel = getPanel(interaction.guildId, 'reaction', panelId);
        if (!panel)
            return interaction.reply({ embeds: [ui.errorEmbed('Panel Not Found', 'That panel no longer exists.')], ephemeral: true });
        db.upsertPanel(interaction.guildId, 'reaction', { ...panel, image: null });
        return interaction.update(panelManagerPayload(interaction.guildId, interaction.user.id, 'reaction'));
    }
    if (id.startsWith('reactionroles_cfg:post:')) {
        const panelId = id.split(':')[2], panel = getPanel(interaction.guildId, 'reaction', panelId);
        if (!panel)
            return interaction.reply({ embeds: [ui.errorEmbed('Panel Not Found', 'That panel no longer exists.')], ephemeral: true });
        try {
            const msg = await postReactionRolePanel(interaction.guild, panel);
            db.upsertPanel(interaction.guildId, 'reaction', { ...panel, messageId: msg.id });
            return interaction.reply({ embeds: [ui.okEmbed('✅ Panel Posted', `Reaction-role panel posted in <#${msg.channel.id}>.`)], ephemeral: true });
        }
        catch (e) {
            return interaction.reply({ embeds: [ui.errorEmbed('Cannot Post Panel', e.message)], ephemeral: true });
        }
    }
    if (id === 'buttonroles_cfg:panel') {
        const cfg = db.getConfig(interaction.guildId).buttonRoles;
        const modal = new ModalBuilder().setCustomId('buttonroles_panel_modal').setTitle('Edit Button Role Panel').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Panel title').setStyle(TextInputStyle.Short).setRequired(true).setValue((cfg.title || 'Choose your roles').slice(0, 100))), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Panel description').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue((cfg.description || 'Press a button to get or remove a role.').slice(0, 1000))), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image').setLabel('Image/GIF URL (optional)').setStyle(TextInputStyle.Short).setRequired(false).setValue((cfg.image || '').slice(0, 400))), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('style').setLabel('Style: embed or selection').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.embedType || 'embed')));
        return interaction.showModal(modal);
    }
    if (id === 'buttonroles_cfg:buttons') {
        const cfg = db.getConfig(interaction.guildId).buttonRoles;
        const value = (cfg.buttons || []).map(b => `${b.roleId}=${b.label}`).join(', ');
        const modal = new ModalBuilder().setCustomId('buttonroles_buttons_modal').setTitle('Edit Role Buttons').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('buttons').setLabel('role ID=label, separated by commas').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(value.slice(0, 4000))));
        return interaction.showModal(modal);
    }
    if (id === 'buttonroles_cfg:post') {
        try {
            await postButtonRolePanel(interaction.guild, db.getConfig(interaction.guildId).buttonRoles);
            return interaction.reply({ embeds: [ui.okEmbed('Button Role Panel Posted', 'The current panel configuration was posted/refreshed.')], ephemeral: true });
        }
        catch (e) {
            return interaction.reply({ embeds: [ui.errorEmbed('Cannot Post Panel', e.message)], ephemeral: true });
        }
    }
    if (id === 'automod_cfg:words') {
        const cfg = db.getConfig(interaction.guildId).automod;
        return interaction.showModal(new ModalBuilder().setCustomId('automod_words_modal').setTitle('AutoMod Bad Words').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('words').setLabel('Comma-separated custom words').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue((cfg.badWords || []).join(', ').slice(0, 4000)))));
    }
    if (id === 'automod_cfg:caps') {
        const cfg = db.getConfig(interaction.guildId).automod;
        return interaction.showModal(new ModalBuilder().setCustomId('automod_caps_modal').setTitle('Caps Threshold').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('threshold').setLabel('Percentage, 1-100').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.capsThreshold || 70)))));
    }
    if (id === 'reactionroles_cfg:message') {
        return interaction.showModal(new ModalBuilder().setCustomId('reactionroles_message_modal').setTitle('Reaction Role Message').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel('Message ID').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('123456789012345678'))));
    }
    if (id === 'reactionroles_cfg:mappings') {
        const cfg = db.getConfig(interaction.guildId).reactionRoles;
        const value = (cfg.mappings || []).map(x => `${x.emoji}=${x.roleId}`).join(', ');
        return interaction.showModal(new ModalBuilder().setCustomId('reactionroles_mappings_modal').setTitle('Edit Reaction Roles').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mappings').setLabel('emoji=role ID, comma separated').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(value.slice(0, 4000)))));
    }
    if (id === 'reactionroles_cfg:toggle') {
        const cfg = db.saveConfig(interaction.guildId, { reactionRoles: { enabled: !db.getConfig(interaction.guildId).reactionRoles.enabled } }).reactionRoles;
        return interaction.update({ embeds: [ui.reactionRoleSetupEmbed(cfg)], components: ui.reactionRoleSetupRows(cfg) });
    }
    if (id === 'birthday_cfg:message') {
        return interaction.showModal(new ModalBuilder().setCustomId('birthday_cfg_modal').setTitle('Birthday Wish Message').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel('Wish message ({user}, {date})').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(db.getConfig(interaction.guildId).birthdays.wishMessage.slice(0, 400)))));
    }
    if (id === 'birthday_cfg:post') {
        const cfg = db.getConfig(interaction.guildId).birthdays;
        const ch = cfg.panelChannelId ? interaction.guild.channels.cache.get(cfg.panelChannelId) : null;
        if (!ch?.isTextBased())
            return interaction.reply({ embeds: [ui.errorEmbed('Panel Channel Missing', 'Select a panel channel first.')], ephemeral: true });
        const row = new ActionRowBuilder().addComponents(new (require('discord.js').ButtonBuilder)().setCustomId('birthday_set').setLabel('Set Birthday').setStyle(require('discord.js').ButtonStyle.Primary));
        await ch.send({ embeds: [ui.birthdaySetupEmbed(cfg)], components: [row] });
        return interaction.reply({ embeds: [ui.okEmbed('Birthday Panel Posted', `Posted in ${ch}.`)], ephemeral: true });
    }
    if (id === 'antibadword_cfg:words')
        return interaction.showModal(new ModalBuilder().setCustomId('antibadword_cfg_modal').setTitle('Custom Bad Words').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('words').setLabel('Words/phrases separated by commas').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue((db.getConfig(interaction.guildId).antibadword.customWords || []).join(', ').slice(0, 400)))));
    if (id === 'antibadword_cfg:toggle') {
        const cfg = db.getConfig(interaction.guildId).antibadword;
        const next = db.saveConfig(interaction.guildId, { antibadword: { enabled: !cfg.enabled } }).antibadword;
        return interaction.update({ embeds: [ui.antiBadwordSetupEmbed(next)], components: ui.antiBadwordSetupRow(next) });
    }
    if (id === 'honeypot_cfg:cleanupcycle') {
        const order = ['none', '10m', '1h', '24h'];
        const cur = db.getConfig(interaction.guildId).honeypot;
        const next = db.saveConfig(interaction.guildId, { honeypot: { cleanupWindow: order[(order.indexOf(cur.cleanupWindow) + 1) % order.length] } }).honeypot;
        return interaction.update({ embeds: [ui.honeypotSetupEmbed(next)], components: ui.honeypotSetupRow(next) });
    }
    if (id === 'honeypot_cfg:toggle') {
        const cur = db.getConfig(interaction.guildId).honeypot;
        const next = db.saveConfig(interaction.guildId, { honeypot: { enabled: cur.enabled === false } }).honeypot;
        return interaction.update({ embeds: [ui.honeypotSetupEmbed(next)], components: ui.honeypotSetupRow(next) });
    }
    if (id === 'honeypot_cfg:invite') {
        const cfg = db.getConfig(interaction.guildId).honeypot;
        const next = db.saveConfig(interaction.guildId, { honeypot: { createInvite: !cfg.createInvite } }).honeypot;
        return interaction.update({ embeds: [ui.honeypotSetupEmbed(next)], components: ui.honeypotSetupRow(next) });
    }
    if (id === 'honeypot_cfg:dm')
        return interaction.showModal(new ModalBuilder().setCustomId('honeypot_cfg_dm_modal').setTitle('Honeypot Kick DM').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel('DM text; use {invite}').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(db.getConfig(interaction.guildId).honeypot.dmMessage.slice(0, 400)))));
    if (id === 'autoresponder_cfg:toggle') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
        const cfg = db.getConfig(interaction.guildId).autoresponder;
        const next = db.saveConfig(interaction.guildId, { autoresponder: { enabled: !cfg.enabled } }).autoresponder;
        return interaction.update({ embeds: [ui.autoresponderSetupEmbed(next)], components: ui.autoresponderSetupRow(next) });
    }
    if (id === 'autoresponder_cfg:case') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
        const cfg = db.getConfig(interaction.guildId).autoresponder;
        const next = db.saveConfig(interaction.guildId, { autoresponder: { ignoreCase: !cfg.ignoreCase } }).autoresponder;
        return interaction.update({ embeds: [ui.autoresponderSetupEmbed(next)], components: ui.autoresponderSetupRow(next) });
    }
    if (id === 'autoresponder_cfg:add') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
        const modal = new ModalBuilder().setCustomId('autoresponder_add_modal').setTitle('Add Auto Responder Trigger');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('match').setLabel('Trigger phrase').setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mode').setLabel('Mode: exact or contains').setStyle(TextInputStyle.Short).setValue('contains').setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('response').setLabel('Response ({user}, {server})').setStyle(TextInputStyle.Paragraph).setRequired(true)));
        return interaction.showModal(modal);
    }
    if (id === 'autoreactor_cfg:toggle') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
        const cfg = db.getConfig(interaction.guildId).autoreactor;
        const next = db.saveConfig(interaction.guildId, { autoreactor: { enabled: !cfg.enabled } }).autoreactor;
        return interaction.update({ embeds: [ui.autoreactorSetupEmbed(next)], components: ui.autoreactorSetupRow(next) });
    }
    if (id === 'autoreactor_cfg:case') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
        const cfg = db.getConfig(interaction.guildId).autoreactor;
        const next = db.saveConfig(interaction.guildId, { autoreactor: { ignoreCase: !cfg.ignoreCase } }).autoreactor;
        return interaction.update({ embeds: [ui.autoreactorSetupEmbed(next)], components: ui.autoreactorSetupRow(next) });
    }
    if (id === 'autoreactor_cfg:add') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
        const modal = new ModalBuilder().setCustomId('autoreactor_add_modal').setTitle('Add Auto Reactor Trigger');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('match').setLabel('Trigger phrase').setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mode').setLabel('Mode: exact or contains').setStyle(TextInputStyle.Short).setValue('contains').setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emojis').setLabel('Emojis, space separated (max 5)').setStyle(TextInputStyle.Short).setRequired(true)));
        return interaction.showModal(modal);
    }
    if (id === 'embedbuilder:text') {
        const draft = sys.embedBuilderSessions.get(interaction.user.id) || { title: '', description: '', color: '', footer: '' };
        const modal = new ModalBuilder().setCustomId('embedbuilder_text_modal').setTitle('Edit Embed Text');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(false).setValue((draft.title || '').slice(0, 200))), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue((draft.description || '').slice(0, 3000))), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Color hex, e.g. #5865F2').setStyle(TextInputStyle.Short).setRequired(false).setValue((draft.color || '').slice(0, 10))), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('footer').setLabel('Footer text').setStyle(TextInputStyle.Short).setRequired(false).setValue((draft.footer || '').slice(0, 200))));
        return interaction.showModal(modal);
    }
    if (id === 'embedbuilder:image') {
        const draft = sys.embedBuilderSessions.get(interaction.user.id) || { imageUrl: '', thumbnailUrl: '' };
        const modal = new ModalBuilder().setCustomId('embedbuilder_image_modal').setTitle('Edit Embed Images');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('imageUrl').setLabel('Large image URL').setStyle(TextInputStyle.Short).setRequired(false).setValue((draft.imageUrl || '').slice(0, 500))), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('thumbnailUrl').setLabel('Thumbnail URL').setStyle(TextInputStyle.Short).setRequired(false).setValue((draft.thumbnailUrl || '').slice(0, 500))));
        return interaction.showModal(modal);
    }
    if (id === 'embedbuilder:addbutton') {
        const draft = sys.embedBuilderSessions.get(interaction.user.id);
        if (!draft)
            return interaction.reply({ embeds: [ui.errorEmbed('Session Expired', 'Run `/embedbuilder` again to start a fresh draft.')], ephemeral: true });
        if ((draft.buttons || []).length >= 5)
            return interaction.reply({ embeds: [ui.errorEmbed('Button Limit', 'A single row supports at most 5 buttons.')], ephemeral: true });
        const modal = new ModalBuilder().setCustomId('embedbuilder_button_modal').setTitle('Add Link Button');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('label').setLabel('Button label').setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('url').setLabel('URL (https://…)').setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emoji').setLabel('Emoji (optional)').setStyle(TextInputStyle.Short).setRequired(false)));
        return interaction.showModal(modal);
    }
    if (id === 'embedbuilder:post') {
        const draft = sys.embedBuilderSessions.get(interaction.user.id);
        if (!draft)
            return interaction.reply({ embeds: [ui.errorEmbed('Session Expired', 'Run `/embedbuilder` again to start a fresh draft.')], ephemeral: true });
        return interaction.reply({ content: 'Select the channel to post this embed in.', components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('embedbuilder:post_channel').setPlaceholder('Select a channel').setChannelTypes(ChannelType.GuildText))], ephemeral: true });
    }
    if (id.startsWith('rolebtn:')) {
        const parts = id.split(':');
        const panelId = parts.length >= 3 ? parts[1] : null;
        const roleId = parts.length >= 3 ? parts[2] : parts[1];
        const cfg = db.getConfig(interaction.guildId);
        const panel = panelId ? getPanel(interaction.guildId, 'button', panelId) : null;
        if (panel && panel.enabled === false)
            return interaction.reply({ embeds: [ui.errorEmbed('Panel Disabled', 'This role panel is currently disabled.')], ephemeral: true });
        const role = interaction.guild.roles.cache.get(roleId);
        if (!role)
            return interaction.reply({ embeds: [ui.errorEmbed('Role Missing', 'That role no longer exists.')], ephemeral: true });
        if (role.id === interaction.guild.id)
            return interaction.reply({ embeds: [ui.errorEmbed('Invalid Role', '@everyone cannot be assigned.')], ephemeral: true });
        const bot = interaction.guild.members.me;
        if (!bot || role.position >= bot.roles.highest.position)
            return interaction.reply({ embeds: [ui.errorEmbed('Role Hierarchy', `I cannot manage **${role.name}** because it is equal to or higher than my highest role.`)], ephemeral: true });
        const member = interaction.member;
        try {
            if (member.roles.cache.has(role.id)) {
                await member.roles.remove(role);
                return interaction.reply({ embeds: [ui.okEmbed('Role Removed', `${role} removed from you.`)], ephemeral: true });
            }
            await member.roles.add(role);
            return interaction.reply({ embeds: [ui.okEmbed('Role Added', `${role} added to you.`)], ephemeral: true });
        }
        catch (e) {
            return interaction.reply({ embeds: [ui.errorEmbed('Role Update Failed', `${e?.message || 'Discord rejected the role change.'}${e?.code ? `\n**Discord code:** \`${e.code}\`` : ''}`)], ephemeral: true });
        }
    }
    if (id.startsWith('role_select:') || id === 'role_select') {
        const panelId = id.includes(':') ? id.split(':')[1] : null;
        const roleId = interaction.values[0];
        const role = interaction.guild.roles.cache.get(roleId);
        if (!role)
            return interaction.reply({ embeds: [ui.errorEmbed('Role Missing', 'That role no longer exists.')], ephemeral: true });
        const panel = panelId ? getPanel(interaction.guildId, 'button', panelId) : null;
        if (panel && panel.enabled === false)
            return interaction.reply({ embeds: [ui.errorEmbed('Panel Disabled', 'This role panel is currently disabled.')], ephemeral: true });
        const bot = interaction.guild.members.me;
        if (!bot || role.position >= bot.roles.highest.position)
            return interaction.reply({ embeds: [ui.errorEmbed('Role Hierarchy', `I cannot manage **${role.name}** because it is equal to or higher than my highest role.`)], ephemeral: true });
        try {
            if (interaction.member.roles.cache.has(role.id))
                await interaction.member.roles.remove(role);
            else
                await interaction.member.roles.add(role);
            return interaction.reply({ embeds: [ui.okEmbed('Role Updated', `${role} has been toggled.`)], ephemeral: true });
        }
        catch (e) {
            return interaction.reply({ embeds: [ui.errorEmbed('Role Update Failed', `${e?.message || 'Discord rejected the role change.'}${e?.code ? `\n**Discord code:** \`${e.code}\`` : ''}`)], ephemeral: true });
        }
    }
    if (id === 'staffapp_apply') {
        const cfg = db.getConfig(interaction.guildId).staffApplications;
        if (!cfg.enabled || !cfg.questions?.length)
            return interaction.reply({ embeds: [ui.errorEmbed('Unavailable', 'Applications are not configured yet.')], ephemeral: true });
        if (applicationSessions.has(interaction.user.id))
            return interaction.reply({ embeds: [ui.warnEmbed('Application In Progress', 'You already have an application in progress in your DMs.')], ephemeral: true });
        applicationSessions.set(interaction.user.id, { guildId: interaction.guildId, index: 0, answers: [], waiting: false });
        const dm = await interaction.user.createDM();
        await dm.send({ embeds: [ui.base(cfg.staffApplications.title).setDescription(cfg.staffApplications.dmIntro)], components: [new ActionRowBuilder().addComponents(new (require('discord.js').ButtonBuilder)().setCustomId('staffapp_ready').setLabel('Ready').setStyle(require('discord.js').ButtonStyle.Success), new (require('discord.js').ButtonBuilder)().setCustomId('staffapp_notready').setLabel('Not Ready').setStyle(require('discord.js').ButtonStyle.Secondary))] });
        return interaction.reply({ embeds: [ui.okEmbed('Check your DMs', 'I sent you the application start message.')], ephemeral: true });
    }
    if (id === 'staffapp_ready') {
        const session = applicationSessions.get(interaction.user.id);
        if (!session)
            return interaction.reply({ embeds: [ui.errorEmbed('No Application', 'Press Apply in the server first.')], ephemeral: true });
        const cfg = db.getConfig(session.guildId).staffApplications;
        session.waiting = true;
        session.index = 0;
        await interaction.update({ embeds: [ui.okEmbed('Application Started', 'Answer each question in this DM. I will send the next one after every answer.')], components: [] });
        return interaction.followUp({ content: `**Question 1/${cfg.questions.length}:**\n${cfg.questions[0]}` });
    }
    if (id === 'staffapp_notready') {
        applicationSessions.delete(interaction.user.id);
        return interaction.update({ embeds: [ui.warnEmbed('Not Started', 'No application was started. You can press Apply again when ready.')], components: [] });
    }
    if (id.startsWith('staffapp_decide:')) {
        if (!interaction.guild || !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need Manage Server to review applications.')], ephemeral: true });
        const [, decision, userId] = id.split(':');
        const modal = new ModalBuilder().setCustomId(`staffapp_reason:${decision}:${userId}`).setTitle(decision === 'accept' ? 'Accept Application' : 'Reject Application');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false)));
        return interaction.showModal(modal);
    }
    if (id === 'birthday_set') {
        const modal = new ModalBuilder().setCustomId('birthday_modal').setTitle('Set Birthday');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel('Birthday (DD-MM or D-M)').setPlaceholder('8-8').setStyle(TextInputStyle.Short).setRequired(true)));
        return interaction.showModal(modal);
    }
    if (id === 'ticket_open') {
        const cfg = db.getConfig(interaction.guildId).ticket;
        if (!cfg.enabled)
            return interaction.reply({ embeds: [ui.errorEmbed('Tickets Disabled', 'Ask an admin to run `/tickets setup`.')], ephemeral: true });
        const openTickets = db.openTicketsForUser(interaction.guildId, interaction.user.id);
        for (const existing of openTickets) {
            const existingChannel = interaction.guild.channels.cache.get(existing.channelId);
            if (existingChannel) {
                return interaction.reply({ embeds: [ui.warnEmbed('Ticket Exists', `You already have an open ticket: <#${existing.channelId}>`)], ephemeral: true });
            }
            db.closeTicket(existing.channelId);
        }
        const overwrites = [
            { id: interaction.guild.roles.everyone, deny: ['ViewChannel'] },
            { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] },
            { id: client.user.id, allow: ['ViewChannel', 'SendMessages', 'ManageChannels'] }
        ];
        if (cfg.supportRoleId)
            overwrites.push({ id: cfg.supportRoleId, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] });
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
        if (!ticket)
            return interaction.reply({ embeds: [ui.errorEmbed('Not a Ticket', 'This only works inside a ticket channel.')], ephemeral: true });
        const ticketCfg = db.getConfig(interaction.guildId).ticket;
        const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
        const hasRole = ticketCfg.supportRoleId && interaction.member.roles.cache.has(ticketCfg.supportRoleId);
        if (!isAdmin && !hasRole)
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need the support role or Administrator.')], ephemeral: true });
        return interaction.reply({ embeds: [ui.staffControlsEmbed(ticket)], components: ui.staffControlsRow(!!ticket.claimedBy), ephemeral: true });
    }
    if (id === 'staff_claim' || id === 'staff_unclaim') {
        const ticket = db.getTicket(interaction.channel.id);
        if (!ticket)
            return interaction.reply({ embeds: [ui.errorEmbed('Not a Ticket', 'This only works inside a ticket channel.')], ephemeral: true });
        const claiming = !ticket.claimedBy;
        db.setTicketStatus(interaction.channel.id, ticket.status, claiming ? interaction.user.id : null);
        if (!claiming)
            db.db.prepare('UPDATE tickets SET claimedBy = NULL WHERE channelId = ?').run(interaction.channel.id);
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
            if (log)
                log.send({ embeds: [ui.base('🗑️ Ticket Deleted').setDescription(`Ticket by <@${ticket?.userId}> deleted by ${interaction.user}.`)] }).catch(() => { });
        }
        setTimeout(() => interaction.channel.delete().catch(() => { }), 1500);
        return;
    }
    if (id === 'ticket_close') {
        const ticket = db.getTicket(interaction.channel.id);
        db.setTicketStatus(interaction.channel.id, 'closed');
        await interaction.reply({ embeds: [ui.warnEmbed('🔒 Closing Ticket', 'This channel will be deleted in 5 seconds.')] });
        const cfg = db.getConfig(interaction.guildId).ticket;
        if (cfg.logChannelId) {
            const log = interaction.guild.channels.cache.get(cfg.logChannelId);
            if (log)
                log.send({ embeds: [ui.base('🎫 Ticket Closed').setDescription(`Ticket by <@${ticket?.userId}> closed by ${interaction.user}.`)] }).catch(() => { });
        }
        setTimeout(() => interaction.channel.delete().catch(() => { }), 5000);
        return;
    }
    if (id === 'vm_setup_category' || id === 'vm_setup_channel' || id === 'vm_setup_toggle') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to use this.')], ephemeral: true });
        }
        if (id === 'vm_setup_category')
            return interaction.reply({ embeds: [ui.vmCategoryPromptEmbed()], components: [ui.vmCategorySelectRow()], ephemeral: true });
        if (id === 'vm_setup_channel')
            return interaction.reply({ embeds: [ui.vmChannelPromptEmbed()], components: [ui.vmChannelSelectRow()], ephemeral: true });
        const current = db.getConfig(interaction.guildId).voicemaster.enabled;
        const cfg = db.saveConfig(interaction.guildId, { voicemaster: { enabled: !current } });
        return interaction.update({ embeds: [ui.vmSetupEmbed(cfg)], components: ui.vmSetupRows(cfg) });
    }
    if (id.startsWith('setup_toggle:') || id.startsWith('setup_edit:')) {
        const [action, sub] = id.split(':');
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to use this.')], ephemeral: true });
        }
        if (action === 'setup_edit')
            return openSetupModal(interaction, sub);
        const moduleKey = ui.SETUP_MODULE_META[sub].cfgKey;
        const enabled = !db.getConfig(interaction.guildId)[moduleKey].enabled;
        const cfg = db.saveConfig(interaction.guildId, { [moduleKey]: { enabled } });
        return interaction.update({ embeds: [ui.setupPanelEmbed(sub, cfg)], components: [ui.setupPanelRow(sub, cfg)] });
    }
}
async function handleTicketMemberSelect(interaction, action) {
    const ticket = db.getTicket(interaction.channel.id);
    if (!ticket)
        return interaction.update({ embeds: [ui.errorEmbed('Not a Ticket', 'This only works inside a ticket channel.')], components: [] });
    const userId = interaction.values[0];
    if (action === 'add') {
        await interaction.channel.permissionOverwrites.edit(userId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        return interaction.update({ embeds: [ui.okEmbed('➕ Member Added', `<@${userId}> can now see this ticket.`)], components: [] });
    }
    await interaction.channel.permissionOverwrites.delete(userId).catch(() => { });
    return interaction.update({ embeds: [ui.okEmbed('➖ Member Removed', `<@${userId}> can no longer see this ticket.`)], components: [] });
}
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
    antiwebhook: [
        { key: 'action', oKey: 'action', label: 'Action: delete / kick / ban / strip_roles', parse: v => v, get: cfg => cfg.antiwebhook.action },
        { key: 'bypass_role', oKey: 'bypass_role_id', label: 'Bypass role ID (blank = none)', parse: v => v.replace(/[<@&>]/g, ''), get: cfg => cfg.antiwebhook.bypassRoleId || '' },
        { key: 'log_channel', oKey: 'log_channel_id', label: 'Security log channel ID', parse: v => v.replace(/[<#>]/g, ''), get: cfg => cfg.antiwebhook.logChannelId || '' }
    ],
    antibot: [
        { key: 'action', oKey: 'action', label: 'Action: kick / ban / strip_roles', parse: v => v, get: cfg => cfg.antibot.action },
        { key: 'bypass_role', oKey: 'bypass_role_id', label: 'Trusted inviter role ID (blank = none)', parse: v => v.replace(/[<@&>]/g, ''), get: cfg => cfg.antibot.bypassRoleId || '' },
        { key: 'log_channel', oKey: 'log_channel_id', label: 'Security log channel ID', parse: v => v.replace(/[<#>]/g, ''), get: cfg => cfg.antibot.logChannelId || '' }
    ],
    antialt: [
        { key: 'action', oKey: 'action', label: 'Action: kick / ban', parse: v => v, get: cfg => cfg.antialt.action },
        { key: 'min_account_age_days', oKey: 'min_account_age_days', label: 'Minimum account age (days)', parse: v => parseInt(v, 10) || null, get: cfg => String(cfg.antialt.minAccountAgeDays) },
        { key: 'log_channel', oKey: 'log_channel_id', label: 'Security log channel ID', parse: v => v.replace(/[<#>]/g, ''), get: cfg => cfg.antialt.logChannelId || '' }
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
        if (current)
            input.setValue(String(current).slice(0, 100));
        modal.addComponents(new ActionRowBuilder().addComponents(input));
    }
    return interaction.showModal(modal);
}
async function handleModal(interaction) {
    if (interaction.customId.startsWith('buttonroles_panel_modal:')) {
        const panelId = interaction.customId.split(':')[1], panel = getPanel(interaction.guildId, 'button', panelId);
        if (!panel)
            return interaction.reply({ embeds: [ui.errorEmbed('Panel Not Found', 'That panel no longer exists.')], ephemeral: true });
        const title = interaction.fields.getTextInputValue('title').trim() || 'Choose your roles';
        const description = interaction.fields.getTextInputValue('description').trim() || 'Press a button to get or remove a role.';
        const style = /^selection$/i.test(interaction.fields.getTextInputValue('style').trim()) ? 'selection' : 'embed';
        const cfg = db.upsertPanel(interaction.guildId, 'button', { ...panel, title, description, embedType: style });
        return interaction.reply({ embeds: [ui.buttonRoleEmbed(db.getConfig(interaction.guildId), panelId)], components: ui.buttonRoleSetupRows(db.getConfig(interaction.guildId), panelId), ephemeral: true });
    }
    if (interaction.customId.startsWith('reactionroles_panel_modal:')) {
        const panelId = interaction.customId.split(':')[1], panel = getPanel(interaction.guildId, 'reaction', panelId);
        if (!panel)
            return interaction.reply({ embeds: [ui.errorEmbed('Panel Not Found', 'That panel no longer exists.')], ephemeral: true });
        const title = interaction.fields.getTextInputValue('title').trim() || 'Choose your roles';
        const description = interaction.fields.getTextInputValue('description').trim() || 'React below to receive or remove a role.';
        db.upsertPanel(interaction.guildId, 'reaction', { ...panel, title, description });
        const cfg = db.getConfig(interaction.guildId);
        return interaction.reply({ embeds: [ui.reactionRoleSetupEmbed(cfg, panelId)], components: ui.reactionRoleSetupRows(cfg, panelId), ephemeral: true });
    }
    if (interaction.customId.startsWith('reactionroles_add_modal:')) {
        const [, panelId, roleId] = interaction.customId.split(':');
        const panel = getPanel(interaction.guildId, 'reaction', panelId);
        if (!panel)
            return interaction.reply({ embeds: [ui.errorEmbed('Panel Not Found', 'That reaction-role panel no longer exists.')], ephemeral: true });
        const emoji = interaction.fields.getTextInputValue('emoji').trim();
        const role = interaction.guild.roles.cache.get(roleId);
        if (!role)
            return interaction.reply({ embeds: [ui.errorEmbed('Role Not Found', 'That role no longer exists.')], ephemeral: true });
        db.upsertPanel(interaction.guildId, 'reaction', { ...panel, mappings: [...(panel.mappings || []).filter(x => x.roleId !== roleId), { emoji, roleId, label: (interaction.fields.getTextInputValue('label').trim() || role.name).slice(0, 80) }] });
        const cfg = db.getConfig(interaction.guildId);
        return interaction.reply({ embeds: [ui.reactionRoleSetupEmbed(cfg, panelId)], components: ui.reactionRoleSetupRows(cfg, panelId), ephemeral: true });
    }
    if (interaction.customId === 'buttonroles_panel_modal') {
        const title = interaction.fields.getTextInputValue('title').trim();
        const description = interaction.fields.getTextInputValue('description').trim();
        const image = interaction.fields.getTextInputValue('image').trim() || null;
        const style = /^selection$/i.test(interaction.fields.getTextInputValue('style').trim()) ? 'selection' : 'embed';
        const cfg = db.saveConfig(interaction.guildId, { buttonRoles: { title, description, image, embedType: style } }).buttonRoles;
        return interaction.reply({ embeds: [ui.buttonRoleEmbed(cfg)], components: ui.buttonRoleSetupRows(cfg), ephemeral: true });
    }
    if (interaction.customId === 'buttonroles_buttons_modal') {
        const raw = interaction.fields.getTextInputValue('buttons');
        const buttons = raw.split(',').map(x => x.trim()).filter(Boolean).slice(0, 25).map((entry, i) => {
            const [roleId, ...parts] = entry.split('=');
            return { roleId: roleId.replace(/[<@&>]/g, '').trim(), label: (parts.join('=') || `Role ${i + 1}`).trim().slice(0, 80), mode: 'toggle' };
        }).filter(x => /^\d{15,25}$/.test(x.roleId));
        if (!buttons.length)
            return interaction.reply({ embeds: [ui.errorEmbed('No valid buttons', 'Use `ROLE_ID=Button Label` entries separated by commas.')], ephemeral: true });
        const cfg = db.saveConfig(interaction.guildId, { buttonRoles: { buttons } }).buttonRoles;
        return interaction.reply({ embeds: [ui.buttonRoleEmbed(cfg)], components: ui.buttonRoleSetupRows(cfg), ephemeral: true });
    }
    if (interaction.customId === 'automod_words_modal') {
        const words = interaction.fields.getTextInputValue('words').split(',').map(x => x.trim()).filter(Boolean).slice(0, 300);
        const cfg = db.saveConfig(interaction.guildId, { automod: { badWords: words, badWordFilter: true } }).automod;
        return interaction.reply({ embeds: [ui.automodSetupEmbed(cfg)], components: ui.automodSetupRows(cfg), ephemeral: true });
    }
    if (interaction.customId === 'automod_caps_modal') {
        const n = Math.max(1, Math.min(100, parseInt(interaction.fields.getTextInputValue('threshold'), 10) || 70));
        const cfg = db.saveConfig(interaction.guildId, { automod: { capsThreshold: n, capsFilter: true } }).automod;
        return interaction.reply({ embeds: [ui.automodSetupEmbed(cfg)], components: ui.automodSetupRows(cfg), ephemeral: true });
    }
    if (interaction.customId === 'reactionroles_message_modal') {
        const messageId = interaction.fields.getTextInputValue('message').trim();
        if (!/^\d{15,25}$/.test(messageId))
            return interaction.reply({ embeds: [ui.errorEmbed('Invalid Message ID', 'Paste a valid Discord message ID.')], ephemeral: true });
        const cfg = db.saveConfig(interaction.guildId, { reactionRoles: { messageId } }).reactionRoles;
        return interaction.reply({ embeds: [ui.reactionRoleSetupEmbed(cfg)], components: ui.reactionRoleSetupRows(cfg), ephemeral: true });
    }
    if (interaction.customId === 'reactionroles_mappings_modal') {
        const raw = interaction.fields.getTextInputValue('mappings');
        const mappings = raw.split(',').map(x => x.trim()).filter(Boolean).map(entry => {
            const [emoji, ...parts] = entry.split('=');
            return { emoji: emoji.trim(), roleId: (parts.join('=') || '').replace(/[<@&>]/g, '').trim() };
        }).filter(x => x.emoji && /^\d{15,25}$/.test(x.roleId)).slice(0, 20);
        if (!mappings.length)
            return interaction.reply({ embeds: [ui.errorEmbed('No valid mappings', 'Use `😀=ROLE_ID, 🎮=ROLE_ID` or custom emoji IDs.')], ephemeral: true });
        const cfg = db.saveConfig(interaction.guildId, { reactionRoles: { mappings } }).reactionRoles;
        if (cfg.messageId) {
            const channel = interaction.guild.channels.cache.get(cfg.channelId);
            const msg = channel ? await channel.messages.fetch(cfg.messageId).catch(() => null) : null;
            if (msg)
                for (const m of mappings)
                    await msg.react(m.emoji).catch(() => { });
        }
        return interaction.reply({ embeds: [ui.reactionRoleSetupEmbed(cfg)], components: ui.reactionRoleSetupRows(cfg), ephemeral: true });
    }
    if (interaction.customId === 'birthday_cfg_modal') {
        const msg = interaction.fields.getTextInputValue('message').trim();
        const cfg = db.saveConfig(interaction.guildId, { birthdays: { wishMessage: msg || 'Happy Birthday {user}! 🎂' } }).birthdays;
        return interaction.reply({ embeds: [ui.birthdaySetupEmbed(cfg)], components: ui.birthdaySetupRow(cfg), ephemeral: true });
    }
    if (interaction.customId === 'antibadword_cfg_modal') {
        const words = interaction.fields.getTextInputValue('words').split(',').map(x => x.trim()).filter(Boolean).slice(0, 300);
        const cfg = db.saveConfig(interaction.guildId, { antibadword: { customWords: words } }).antibadword;
        return interaction.reply({ embeds: [ui.antiBadwordSetupEmbed(cfg)], components: ui.antiBadwordSetupRow(cfg), ephemeral: true });
    }
    if (interaction.customId === 'honeypot_cfg_dm_modal') {
        const msg = interaction.fields.getTextInputValue('message').trim();
        const cfg = db.saveConfig(interaction.guildId, { honeypot: { dmMessage: msg || 'You were removed. {invite}' } }).honeypot;
        return interaction.reply({ embeds: [ui.honeypotSetupEmbed(cfg)], components: ui.honeypotSetupRow(cfg), ephemeral: true });
    }
    if (interaction.customId === 'autoresponder_add_modal') {
        const match = interaction.fields.getTextInputValue('match').trim();
        const mode = /^exact$/i.test(interaction.fields.getTextInputValue('mode').trim()) ? 'exact' : 'contains';
        const response = interaction.fields.getTextInputValue('response').trim();
        if (!match || !response)
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Info', 'Both a trigger phrase and a response are required.')], ephemeral: true });
        const cfg = db.getConfig(interaction.guildId).autoresponder;
        const triggers = [...(cfg.triggers || []), { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, match, mode, response }];
        const next = db.saveConfig(interaction.guildId, { autoresponder: { triggers } }).autoresponder;
        return interaction.reply({ embeds: [ui.autoresponderSetupEmbed(next)], components: ui.autoresponderSetupRow(next), ephemeral: true });
    }
    if (interaction.customId === 'autoreactor_add_modal') {
        const match = interaction.fields.getTextInputValue('match').trim();
        const mode = /^exact$/i.test(interaction.fields.getTextInputValue('mode').trim()) ? 'exact' : 'contains';
        const emojis = interaction.fields.getTextInputValue('emojis').trim().split(/\s+/).filter(Boolean).slice(0, 5);
        if (!match || !emojis.length)
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Info', 'A trigger phrase and at least one emoji are required.')], ephemeral: true });
        const cfg = db.getConfig(interaction.guildId).autoreactor;
        const triggers = [...(cfg.triggers || []), { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, match, mode, emojis }];
        const next = db.saveConfig(interaction.guildId, { autoreactor: { triggers } }).autoreactor;
        return interaction.reply({ embeds: [ui.autoreactorSetupEmbed(next)], components: ui.autoreactorSetupRow(next), ephemeral: true });
    }
    if (interaction.customId === 'embedbuilder_text_modal') {
        const draft = sys.embedBuilderSessions.get(interaction.user.id) || { buttons: [] };
        draft.title = interaction.fields.getTextInputValue('title').trim();
        draft.description = interaction.fields.getTextInputValue('description').trim();
        draft.color = interaction.fields.getTextInputValue('color').trim();
        draft.footer = interaction.fields.getTextInputValue('footer').trim();
        sys.embedBuilderSessions.set(interaction.user.id, draft);
        return interaction.reply({ embeds: [ui.embedBuilderPreviewEmbed(draft)], components: ui.embedBuilderRow(draft), ephemeral: true });
    }
    if (interaction.customId === 'embedbuilder_image_modal') {
        const draft = sys.embedBuilderSessions.get(interaction.user.id) || { buttons: [] };
        draft.imageUrl = interaction.fields.getTextInputValue('imageUrl').trim();
        draft.thumbnailUrl = interaction.fields.getTextInputValue('thumbnailUrl').trim();
        sys.embedBuilderSessions.set(interaction.user.id, draft);
        return interaction.reply({ embeds: [ui.embedBuilderPreviewEmbed(draft)], components: ui.embedBuilderRow(draft), ephemeral: true });
    }
    if (interaction.customId === 'embedbuilder_button_modal') {
        const draft = sys.embedBuilderSessions.get(interaction.user.id);
        if (!draft)
            return interaction.reply({ embeds: [ui.errorEmbed('Session Expired', 'Run `/embedbuilder` again to start a fresh draft.')], ephemeral: true });
        const label = interaction.fields.getTextInputValue('label').trim();
        const url = interaction.fields.getTextInputValue('url').trim();
        const btnEmoji = interaction.fields.getTextInputValue('emoji').trim();
        if (!label || !/^https?:\/\//i.test(url))
            return interaction.reply({ embeds: [ui.errorEmbed('Invalid Button', 'Provide a label and a valid https:// URL.')], ephemeral: true });
        draft.buttons = [...(draft.buttons || []), { label, url, emoji: btnEmoji || null }];
        return interaction.reply({ embeds: [ui.embedBuilderPreviewEmbed(draft)], components: ui.embedBuilderRow(draft), ephemeral: true });
    }
    if (interaction.customId === 'birthday_modal') {
        const raw = interaction.fields.getTextInputValue('date').trim().replace(/\s+/g, '');
        const m = raw.match(/^(\d{1,2})[-\/.](\d{1,2})$/);
        if (!m)
            return interaction.reply({ embeds: [ui.errorEmbed('Invalid Date', 'Use a format like `8-8` or `1-9`.')], ephemeral: true });
        const day = Number(m[1]), month = Number(m[2]);
        const d = new Date(Date.UTC(2000, month - 1, day));
        if (d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day)
            return interaction.reply({ embeds: [ui.errorEmbed('Invalid Date', 'That date is not valid.')], ephemeral: true });
        const cfg = db.getConfig(interaction.guildId);
        db.saveConfig(interaction.guildId, { birthdays: { entries: { ...(cfg.birthdays.entries || {}), [interaction.user.id]: `${month}-${day}` } } });
        return interaction.reply({ embeds: [ui.okEmbed('🎂 Birthday Saved', `Your birthday is set to **${day}-${month}**.`)], ephemeral: true });
    }
    if (interaction.customId.startsWith('staffapp_reason:')) {
        if (!interaction.guild || !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need Manage Server.')], ephemeral: true });
        const [, decision, userId] = interaction.customId.split(':');
        const reason = interaction.fields.getTextInputValue('reason').trim() || 'No reason provided.';
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user)
            return interaction.reply({ embeds: [ui.errorEmbed('User Not Found', 'Could not DM the applicant.')], ephemeral: true });
        await user.send({ embeds: [decision === 'accept' ? ui.okEmbed('Application Accepted', reason) : ui.errorEmbed('Application Rejected', reason)] }).catch(() => { });
        return interaction.reply({ embeds: [ui.okEmbed('Decision Recorded', `${decision === 'accept' ? 'Accepted' : 'Rejected'} <@${userId}>. Reason: ${reason}`)] });
    }
    if (interaction.customId.startsWith('setup_modal:')) {
        const sub = interaction.customId.split(':')[1];
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to use this.')], ephemeral: true });
        }
        const o = {};
        for (const f of SETUP_EDIT_FIELDS[sub]) {
            const raw = interaction.fields.getTextInputValue(f.key).trim();
            if (raw)
                o[f.oKey] = f.parse(raw);
        }
        const patch = buildModulePatch(sub, interaction.guildId, o);
        const cfg = db.saveConfig(interaction.guildId, patch);
        return interaction.update({ embeds: [ui.setupPanelEmbed(sub, cfg)], components: [ui.setupPanelRow(sub, cfg)] });
    }
}
client.on('guildMemberAdd', async (member) => {
    await sys.handleAntiBotJoin(member).catch(() => { });
    await sys.handleAntiAltJoin(member).catch(() => { });
    await sys.handleAntiraidJoin(member).catch(() => { });
    await sys.onMemberJoinGreetvoice(member).catch(() => { });
    const cfg = db.getConfig(member.guild.id);
    if (cfg.welcome.enabled && cfg.welcome.channel) {
        const ch = member.guild.channels.cache.get(cfg.welcome.channel);
        const text = cfg.welcome.message.replace('{user}', `${member}`).replace('{server}', member.guild.name).replace('{count}', member.guild.memberCount);
        if (ch?.isTextBased())
            ch.send({ embeds: [ui.okEmbed('👋 Welcome!', text)] }).catch(() => { });
        if (cfg.welcome.autoroleId)
            member.roles.add(cfg.welcome.autoroleId).catch(() => { });
    }
    if (cfg.greetmessage.enabled && cfg.greetmessage.channelId) {
        const ch = member.guild.channels.cache.get(cfg.greetmessage.channelId);
        if (ch?.isTextBased())
            ch.send(greetMessageCmd.buildGreetPayload(member.guild, member.user, cfg.greetmessage)).catch(() => { });
    }
    if (cfg.autorole.enabled && cfg.autorole.roleId) {
        const target = cfg.autorole.target || 'everyone';
        if (target === 'everyone' || (target === 'bots' && member.user.bot) || (target === 'humans' && !member.user.bot)) {
            member.roles.add(cfg.autorole.roleId).catch(() => { });
        }
    }
    const sticky = db.getStickyRoles(member.guild.id, member.id);
    if (sticky.length)
        member.roles.add(sticky).catch(() => { });
    const log = await sys.getLogChannel(member.guild, 'join');
    if (log)
        log.send({ embeds: [ui.okEmbed('📥 Member Joined', `${member} (${member.user.tag})`)] }).catch(() => { });
});
client.on('guildMemberRemove', async (member) => {
    const cfg = db.getConfig(member.guild.id);
    if (cfg.leave.enabled && cfg.leave.channel) {
        const ch = member.guild.channels.cache.get(cfg.leave.channel);
        const text = cfg.leave.message.replace('{user}', member.user.tag);
        if (ch?.isTextBased())
            ch.send({ embeds: [ui.warnEmbed('👋 Member Left', text)] }).catch(() => { });
    }
    if (member.roles?.cache?.size) {
        db.setStickyRoles(member.guild.id, member.id, member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.id));
    }
    const log = await sys.getLogChannel(member.guild, 'join');
    if (log)
        log.send({ embeds: [ui.warnEmbed('📤 Member Left', `${member.user.tag}`)] }).catch(() => { });
    const executor = await sys.findAuditExecutor(member.guild, AuditLogEvent.MemberKick, member.id);
    if (executor)
        await sys.antinukeStrike(member.guild, executor, 'kick').catch(() => { });
});
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    const cfg = db.getConfig(newMember.guild.id);
    if (!oldMember.premiumSince && newMember.premiumSince && cfg.boost.enabled && cfg.boost.channel) {
        const ch = newMember.guild.channels.cache.get(cfg.boost.channel);
        const text = cfg.boost.message.replace('{user}', `${newMember}`);
        if (ch?.isTextBased())
            ch.send({ embeds: [ui.okEmbed('🚀 Server Boost!', text)] }).catch(() => { });
    }
});
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function handleApplicationDM(message) {
    const session = applicationSessions.get(message.author.id);
    if (!session || !session.waiting)
        return;
    if (message.content.trim().length === 0 && message.attachments.size === 0)
        return;
    const guild = client.guilds.cache.get(session.guildId);
    if (!guild) {
        applicationSessions.delete(message.author.id);
        return;
    }
    const cfg = db.getConfig(guild.id).staffApplications;
    session.answers.push(message.content.slice(0, 1500));
    session.index += 1;
    if (session.index < cfg.questions.length) {
        return message.author.send(`**Question ${session.index + 1}/${cfg.questions.length}:**\n${cfg.questions[session.index]}`).catch(() => { });
    }
    session.waiting = false;
    const log = cfg.logChannelId ? guild.channels.cache.get(cfg.logChannelId) : null;
    if (log?.isTextBased()) {
        const embed = ui.base('📝 Staff Application').setDescription(`Application from ${message.author} (<@${message.author.id}>)`);
        cfg.questions.slice(0, 25).forEach((q, i) => embed.addFields({ name: `${i + 1}. ${q}`.slice(0, 256), value: (session.answers[i] || 'No answer').slice(0, 1024), inline: false }));
        await log.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new (require('discord.js').ButtonBuilder)().setCustomId(`staffapp_decide:accept:${message.author.id}`).setLabel('Accept').setStyle(require('discord.js').ButtonStyle.Success), new (require('discord.js').ButtonBuilder)().setCustomId(`staffapp_decide:reject:${message.author.id}`).setLabel('Reject').setStyle(require('discord.js').ButtonStyle.Danger))] }).catch(() => { });
    }
    await message.author.send('Your application has been submitted. Staff will review it and notify you.').catch(() => { });
    applicationSessions.delete(message.author.id);
}
function honeypotFail(message, cfg, action, e) {
    console.warn(`[Honeypot] ${action} failed for ${message.author.id}: ${e?.message || e}`);
    const log = cfg.logChannelId ? message.guild.channels.cache.get(cfg.logChannelId) : null;
    if (log?.isTextBased())
        log.send({ embeds: [ui.errorEmbed('🍯 Honeypot action failed', `Could not **${action}** ${message.author}: ${String(e?.message || e).slice(0, 500)}\nCheck my permissions and that my role is above theirs.`)] }).catch(() => { });
}
async function handleHoneypot(message) {
    const cfg = { ...db.DEFAULT_CONFIG.honeypot, ...(db.getConfig(message.guild.id).honeypot || {}) };
    await message.delete().catch(() => { });
    const log = cfg.logChannelId ? message.guild.channels.cache.get(cfg.logChannelId) : null;
    if (log?.isTextBased())
        log.send({ embeds: [ui.errorEmbed('🍯 Honeypot Triggered', `${message.author} posted in <#${cfg.channelId}>. Action: **${cfg.action}**.`)] }).catch(() => { });
    if (cfg.cleanupWindow !== 'none') {
        const ms = cfg.cleanupWindow === '10m' ? 10 * 60e3 : cfg.cleanupWindow === '1h' ? 60 * 60e3 : 24 * 60 * 60e3;
        const cutoff = Date.now() - ms;
        for (const ch of message.guild.channels.cache.values()) {
            if (!ch.isTextBased() || !ch.messages?.fetch)
                continue;
            let before;
            for (let page = 0; page < 5; page++) {
                const opts = { limit: 100 };
                if (before)
                    opts.before = before;
                const msgs = await ch.messages.fetch(opts).catch(() => null);
                if (!msgs?.size)
                    break;
                const mine = [...msgs.values()].filter(m => m.author.id === message.author.id && m.createdTimestamp >= cutoff && m.id !== message.id);
                await Promise.allSettled(mine.map(m => m.delete().catch(() => { })));
                const oldest = msgs.last();
                if (!oldest || oldest.createdTimestamp < cutoff || msgs.size < 100)
                    break;
                before = oldest.id;
            }
        }
    }
    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (cfg.action === 'kick' || cfg.action === 'ban') {
        let invite = '';
        if (cfg.action === 'kick' && cfg.createInvite) {
            const target = message.guild.channels.cache.get(cfg.channelId) || message.guild.systemChannel;
            if (target?.isTextBased() && target.permissionsFor(message.guild.members.me)?.has(PermissionFlagsBits.CreateInstantInvite)) {
                invite = await target.createInvite({ maxAge: 86400, maxUses: 1, unique: true, reason: 'Honeypot recovery invite' }).then(i => i.url).catch(() => '');
            }
        }
        if (cfg.action === 'kick') {
            await member?.kick('Honeypot trigger').catch(e => honeypotFail(message, cfg, 'kick', e));
            const dm = (cfg.dmMessage || 'You were removed for posting in the honeypot channel. {invite}').replace('{invite}', invite || '');
            await message.author.send(dm).catch(() => { });
        }
        else
            await member?.ban({ reason: 'Honeypot trigger' }).catch(e => honeypotFail(message, cfg, 'ban', e));
    }
    else if (cfg.action === 'timeout')
        await member?.timeout(10 * 60e3, 'Honeypot trigger').catch(e => honeypotFail(message, cfg, 'timeout', e));
}
function birthdayKey(date) { return `${date.getUTCMonth() + 1}-${date.getUTCDate()}`; }
async function sendBirthdayWishes() {
    const now = new Date();
    const key = birthdayKey(now);
    const dayToken = `${now.getUTCFullYear()}-${key}`;
    for (const guild of client.guilds.cache.values()) {
        const cfg = db.getConfig(guild.id).birthdays;
        if (!cfg.enabled || !cfg.wishChannelId)
            continue;
        const channel = guild.channels.cache.get(cfg.wishChannelId);
        if (!channel?.isTextBased())
            continue;
        const entries = cfg.entries || {};
        for (const [userId, date] of Object.entries(entries)) {
            if (date !== key || birthdayWishesSent.has(`${guild.id}:${userId}:${dayToken}`))
                continue;
            birthdayWishesSent.add(`${guild.id}:${userId}:${dayToken}`);
            const text = (cfg.wishMessage || 'Happy Birthday {user}! 🎂').replace('{user}', `<@${userId}>`).replace('{date}', key);
            channel.send({ embeds: [ui.okEmbed('🎂 Happy Birthday!', text)] }).catch(() => { });
        }
    }
}
async function handleReactionRole(reaction, user, adding) {
    if (user?.bot)
        return;
    try {
        if (reaction.partial)
            await reaction.fetch();
        const guild = reaction.message.guild;
        if (!guild)
            return;
        const all = db.getConfig(guild.id);
        const panels = Array.isArray(all.reactionRolePanels) ? all.reactionRolePanels : [];
        let panel = panels.find(p => p.messageId === reaction.message.id);
        let mappings = panel?.mappings || [];
        if (!panel) {
            const legacy = all.reactionRoles;
            if (legacy.enabled === false || legacy.messageId !== reaction.message.id)
                return;
            panel = legacy;
            mappings = legacy.mappings || [];
        }
        if (panel.enabled === false)
            return;
        const key = reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;
        const mapping = mappings.find(x => x.emoji === key || x.emoji === reaction.emoji.name);
        if (!mapping)
            return;
        const member = await guild.members.fetch(user.id);
        const role = guild.roles.cache.get(mapping.roleId);
        const bot = guild.members.me;
        if (!role || !bot || role.position >= bot.roles.highest.position) {
            await reaction.users.remove(user.id).catch(() => { });
            return;
        }
        if (adding)
            await member.roles.add(role);
        else
            await member.roles.remove(role);
    }
    catch (e) {
        console.error('reaction role action failed:', e);
    }
}
client.on('messageReactionAdd', (reaction, user) => handleReactionRole(reaction, user, true));
client.on('messageReactionRemove', (reaction, user) => handleReactionRole(reaction, user, false));
client.on('messageCreate', async (message) => {
    if (message.author.bot)
        return;
    if (!message.guild) {
        if (await handleOwnerDM(message).catch(() => false))
            return;
        return apps.handleDM(message).catch(console.error);
    }
    const cfgAll = db.getConfig(message.guild.id);
    if (await consumeSetupMedia(message))
        return;
    if (await helpers.consumeTextCapture(message))
        return;
    try {
        const hp = cfgAll.honeypot || {};
        if (hp.enabled !== false && hp.channelId && message.channelId === hp.channelId && message.author.id !== message.guild.ownerId &&
            !(hp.whitelistRoleIds || []).some(r => message.member?.roles?.cache?.has(r))) {
            await handleHoneypot(message);
            return;
        }
    }
    catch (e) {
        logOwnerError(e, 'Honeypot handler').catch(() => { });
    }
    if (!isGlobalBlacklistedGuild(message.guild)) {
        const mentionOnly = new RegExp(`^<@!?${client.user.id}\\s*$`);
        if (mentionOnly.test(message.content.trim())) {
            const prefix = cfgAll.prefix || '!';
            return message.reply({ embeds: [ui.base(`🤖 ${client.user.username}`).setDescription(`Welcome to **${message.guild.name}**!\n\n` +
                        `Start with **${prefix}help** or **/help** to see what I can do.\n\n` +
                        `**Server Prefix:** \`${prefix}\`\n**Bot Ping:** \`${client.ws.ping}ms\``)] }).catch(() => { });
        }
        const handled = await handlePrefixCommand(message).catch(err => {
            console.error('Prefix command error:', err);
            return false;
        });
        if (handled)
            return;
    }
    const cfg = db.getConfig(message.guild.id);
    if (cfg.antilink.enabled &&
        /(?:https?:\/\/|www\.|discord\.gg\/|discord(?:app)?\.com\/invite\/)/i.test(message.content) &&
        !message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await message.delete().catch(() => { });
        const log = await sys.getLogChannel(message.guild, 'message');
        if (log?.isTextBased()) {
            log.send({
                embeds: [
                    ui.errorEmbed('🔗 Anti-Link', `**User:** ${message.author}\n**Channel:** ${message.channel}`)
                ]
            }).catch(() => { });
        }
        return;
    }
    if (cfg.antispam.enabled) {
        const result = sys.handleAntispam?.(message);
        if (result?.blocked)
            return;
    }
    if (cfg.leveling.enabled) {
        sys.handleLevelingMessage?.(message).catch(() => { });
    }
    if (cfg.autoresponder?.enabled) {
        const triggers = cfg.autoresponder.triggers || [];
        for (const trigger of triggers) {
            const content = message.content.toLowerCase();
            const matchText = String(trigger.match || '').toLowerCase();
            const matched = trigger.mode === 'exact'
                ? content === matchText
                : content.includes(matchText);
            if (matched) {
                await message.channel.send(trigger.response).catch(() => { });
                break;
            }
        }
    }
    if (cfg.autoreactor?.enabled) {
        const triggers = cfg.autoreactor.triggers || [];
        for (const trigger of triggers) {
            const content = message.content.toLowerCase();
            const matchText = String(trigger.match || '').toLowerCase();
            const matched = trigger.mode === 'exact'
                ? content === matchText
                : content.includes(matchText);
            if (!matched)
                continue;
            for (const emoji of trigger.emojis || []) {
                await message.react(emoji).catch(() => { });
            }
            break;
        }
    }
    const bad = cfg.antibadword;
    if (bad?.enabled !== false) {
        const words = [
            ...(bad.words || []),
            ...(bad.customWords || [])
        ].map(x => String(x).toLowerCase()).filter(Boolean);
        if (words.length &&
            words.some(word => message.content.toLowerCase().includes(word)) &&
            !message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
            await message.delete().catch(() => { });
            const log = await sys.getLogChannel(message.guild, 'message');
            if (log?.isTextBased()) {
                log.send({
                    embeds: [
                        ui.errorEmbed('🚫 Bad Word Filter', `**User:** ${message.author}\n**Channel:** ${message.channel}`)
                    ]
                }).catch(() => { });
            }
            return;
        }
    }
    const auto = cfg.automod;
    if (auto.enabled !== false) {
        const letters = message.content.replace(/[^A-Za-z]/g, '');
        if (auto.capsFilter && letters.length >= 8) {
            const caps = letters.replace(/[^A-Z]/g, '').length;
            if ((caps / letters.length) * 100 >= (auto.capsThreshold || 70)) {
                await message.delete().catch(() => { });
                const log = await sys.getLogChannel(message.guild, 'message');
                if (log?.isTextBased()) {
                    log.send({
                        embeds: [
                            ui.errorEmbed('🔠 Caps Filter', `**User:** ${message.author}\n**Channel:** ${message.channel}`)
                        ]
                    }).catch(() => { });
                }
                return;
            }
        }
        if (auto.inviteFilter &&
            /(?:discord\.gg|discord(?:app)?\.com\/invite)\/\S+/i.test(message.content)) {
            if (!message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
                await message.delete().catch(() => { });
                const log = await sys.getLogChannel(message.guild, 'message');
                if (log?.isTextBased()) {
                    log.send({
                        embeds: [
                            ui.errorEmbed('🔗 Invite Filter', `**User:** ${message.author}\n**Channel:** ${message.channel}`)
                        ]
                    }).catch(() => { });
                }
                return;
            }
        }
    }
});
client.on('voiceStateUpdate', async (oldState, newState) => {
    await sys.handleVoiceStateUpdate(oldState, newState)
        .catch(err => console.error('voiceStateUpdate:', err));
});
client.on('channelDelete', channel => {
    try {
        sys.onVoicemasterChannelDelete(channel);
    }
    catch (e) {
        console.warn('[VoiceMaster] channelDelete cleanup failed:', e.message);
    }
});
setInterval(() => sendBirthdayWishes().catch(console.error), 60 * 60 * 1000);
sendBirthdayWishes().catch(() => { });
sticky.attach(client);
client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error('Failed to log in:', err);
    process.exit(1);
});

};
__modules["ownertools.js"] = function(module, exports, require, __filename, __dirname) {
const { SlashCommandBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, version: djsVersion } = require('discord.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { randomBytes } = require('crypto');
const db = require('./database');
const ui = require('./ui');
const h = require('./helpers');
const raw = db.db;
const ctx = { commands: [], aliases: new Map() };
function init(o) { Object.assign(ctx, o || {}); }
const envIds = () => [process.env.OWNER_ID, ...(process.env.OWNER_IDS || '').split(',')].map(s => String(s || '').trim()).filter(Boolean);
const isMainOwner = id => envIds().includes(String(id || ''));
const coOwners = () => { const l = db.getOwnerConfig().coOwners; return Array.isArray(l) ? l : []; };
const isCoOwner = id => coOwners().some(o => o.id === String(id));
const isOwner = id => isMainOwner(id) || isCoOwner(id);
const snowflake = s => /^\d{15,25}$/.test(String(s || '').trim());
const q = name => `"${String(name).replace(/"/g, '""')}"`;
const fmtBytes = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
const isSlash = i => typeof i.fetchReply === 'function';
function describeArgs(i) {
    if (typeof i.argText === 'string')
        return i.argText;
    try {
        return (i.options?.data || []).map(o => `${o.name}=${o.options ? o.options.map(x => `${x.name}=${x.value}`).join(',') : (o.attachment ? o.attachment.name : o.value)}`).join(' ');
    }
    catch {
        return '';
    }
}
function audit(i, name) {
    const args = describeArgs(i);
    try {
        db.logOwnerAudit(i.user.id, name, args, i.guildId);
    }
    catch (e) {
        console.error('[Owner] audit failed:', e.message);
    }
    const chId = process.env.OWNER_COMMAND_LOG_CHANNEL_ID || process.env.OWNER_LOG_CHANNEL_ID || db.getOwnerConfig().commandChannelId;
    if (!chId)
        return;
    i.client.channels.fetch(chId).then(ch => ch?.isTextBased() && ch.send({ embeds: [h.infoEmbed('Owner command used', `**User:** <@${i.user.id}> (\`${i.user.id}\`)\n**Command:** /${name}\n**Args:** ${h.clip(args || '—', 400)}\n**Guild:** ${i.guildId || 'DM'}\n**Time:** <t:${Math.floor(Date.now() / 1000)}:F>`)] })).catch(() => { });
}
function define(builder, { main = false } = {}, run) {
    const name = builder.name;
    return {
        ownerOnly: true, data: builder,
        async execute(i) {
            const uid = i.user?.id;
            if (!isOwner(uid) || (main && !isMainOwner(uid))) {
                return h.safeReply(i, { embeds: [h.errorEmbed('Owner only', isOwner(uid) ? 'This command is restricted to the main owner.' : 'This command is owner-only.')], ephemeral: true });
            }
            console.log(`[Owner] /${name} by ${uid}`);
            audit(i, name);
            try {
                await run(i);
            }
            catch (e) {
                console.error(`[Owner] /${name} failed:`, e);
                await h.safeReply(i, { embeds: [h.errorEmbed(`/${name} failed`, String(e?.message || e).slice(0, 1500))], ephemeral: true });
            }
        }
    };
}
const ack = i => (i.deferReply && !i.deferred && !i.replied ? i.deferReply({ ephemeral: true }) : null);
const done = (i, payload) => (i.editReply ? i.editReply(payload) : h.safeReply(i, payload));
const pending = new Map();
async function confirmFlow(i, { title, description, yes = 'Confirm', extra = [], run }) {
    const token = randomBytes(6).toString('hex');
    const rows = (dis = false) => [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`own-c:${token}:yes`).setLabel(yes).setStyle(ButtonStyle.Danger).setDisabled(dis), ...extra.map(x => new ButtonBuilder().setCustomId(`own-c:${token}:${x.id}`).setLabel(x.label).setStyle(ButtonStyle.Primary).setDisabled(dis)), new ButtonBuilder().setCustomId(`own-c:${token}:no`).setLabel('Cancel').setStyle(ButtonStyle.Secondary).setDisabled(dis))];
    const embed = expired => h.warnEmbed(title, `${description}\n\n${expired ? '⏱ Expired — nothing was changed.' : 'Expires in 30 seconds.'}`);
    const sent = await h.safeReply(i, { embeds: [embed(false)], components: rows(), ephemeral: true });
    const rec = { userId: i.user.id, run };
    pending.set(token, rec);
    rec.timer = setTimeout(async () => {
        if (!pending.delete(token))
            return;
        const p = { embeds: [embed(true)], components: rows(true) };
        try {
            if (isSlash(i))
                await i.editReply(p);
            else
                await sent?.edit?.(p);
        }
        catch { }
    }, 30000);
    rec.timer.unref?.();
}
async function handleConfirm(i) {
    const [, token, choice] = i.customId.split(':');
    const rec = pending.get(token);
    if (!rec)
        return void await i.reply({ embeds: [h.warnEmbed('Expired', 'Run the command again.')], ephemeral: true });
    if (i.user.id !== rec.userId)
        return void await h.authorOnly(i, rec.userId);
    if (!isOwner(i.user.id))
        return void await i.reply({ embeds: [h.errorEmbed('Owner only', 'This command is owner-only.')], ephemeral: true });
    clearTimeout(rec.timer);
    pending.delete(token);
    if (choice === 'no')
        return void await i.update({ embeds: [h.infoEmbed('Cancelled', 'Nothing was changed.')], components: [] });
    await i.deferUpdate();
    try {
        const result = await rec.run(i, choice);
        await i.editReply({ embeds: [typeof result === 'string' ? h.successEmbed('Done', result) : result], components: [] });
    }
    catch (e) {
        console.error('[Owner] confirmed action failed:', e);
        await i.editReply({ embeds: [h.errorEmbed('Action failed', String(e?.message || e).slice(0, 1500))], components: [] });
    }
}
const userTables = () => raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
const hasGuildCol = t => raw.prepare(`PRAGMA table_info(${q(t)})`).all().some(c => c.name === 'guildId');
const KEEP_ON_RESET = new Set(['memberships', 'owner_audit', 'error_log']);
const guildTables = () => userTables().filter(hasGuildCol);
const resetTables = () => guildTables().filter(t => !KEEP_ON_RESET.has(t));
const LABELS = { guild_config: 'Settings', levels: 'Levels', warns: 'Warnings', tickets: 'Tickets', giveaways: 'Giveaways', sticky_messages: 'Sticky messages', voicemaster_channels: 'Voice channels', antinuke_whitelist: 'Antinuke whitelist', action_log: 'Action log', sticky_roles: 'Sticky roles', spam_tracker: 'Spam tracker', join_tracker: 'Join tracker', saved_embeds: 'Saved embeds', staff_applications: 'Staff applications', command_usage: 'Command usage' };
const label = t => LABELS[t] || t;
function countGuild(guildId) {
    return resetTables().map(t => ({ table: t, count: raw.prepare(`SELECT COUNT(*) c FROM ${q(t)} WHERE guildId = ?`).get(guildId).c })).filter(r => r.count > 0);
}
function deleteGuildData(guildId) {
    const tables = resetTables();
    return raw.transaction(() => tables.map(t => ({ table: t, count: raw.prepare(`DELETE FROM ${q(t)} WHERE guildId = ?`).run(guildId).changes })).filter(r => r.count > 0))();
}
function guildIdsWithData() {
    const ids = new Set();
    for (const t of resetTables())
        for (const r of raw.prepare(`SELECT DISTINCT guildId FROM ${q(t)}`).all())
            if (snowflake(r.guildId))
                ids.add(r.guildId);
    return ids;
}
const SENSITIVE = /token|secret|password|api[_-]?key|authorization|webhook.*url/i;
function sanitize(v) {
    if (Array.isArray(v))
        return v.map(sanitize);
    if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v).filter(([k]) => !SENSITIVE.test(k)).map(([k, x]) => [k, sanitize(x)]));
    return v;
}
function exportGuild(guildId) {
    const out = { exportedAt: new Date().toISOString(), guildId, tables: {} };
    for (const t of guildTables()) {
        if (t === 'owner_audit' || t === 'error_log')
            continue;
        const rows = raw.prepare(`SELECT * FROM ${q(t)} WHERE guildId = ?`).all(guildId);
        if (!rows.length)
            continue;
        out.tables[t] = rows.map(r => { if (typeof r.data === 'string') {
            try {
                return sanitize({ ...r, data: JSON.parse(r.data) });
            }
            catch { }
        } return sanitize(r); });
    }
    return out;
}
const dbSize = () => { let n = 0; for (const f of [db.DB_PATH, `${db.DB_PATH}-wal`]) {
    try {
        n += fs.statSync(f).size;
    }
    catch { }
} return n; };
const MAX_PART = 9_000_000;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
async function snapshot(labelName) {
    const dir = path.join(db.DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `aunxz-${labelName}-${stamp()}.sqlite`);
    await raw.backup(file);
    const old = fs.readdirSync(dir).filter(f => f.startsWith('aunxz-pre-')).sort().slice(0, -5);
    for (const f of old)
        fs.unlink(path.join(dir, f), () => { });
    return file;
}
function prepareFiles(file) {
    let outPath = file;
    let name = path.basename(file);
    const tmp = [];
    if (fs.statSync(file).size > MAX_PART / 2) {
        const gz = `${file}.gz`;
        fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(file)));
        outPath = gz;
        name += '.gz';
        tmp.push(gz);
    }
    if (fs.statSync(outPath).size <= MAX_PART)
        return { files: [{ path: outPath, name }], tmp, split: false };
    const buf = fs.readFileSync(outPath);
    const files = [];
    for (let n = 0, o = 0; o < buf.length; n++, o += MAX_PART) {
        const p = `${outPath}.part${n + 1}`;
        fs.writeFileSync(p, buf.subarray(o, o + MAX_PART));
        files.push({ path: p, name: `${name}.part${n + 1}` });
        tmp.push(p);
    }
    return { files, tmp, split: true };
}
function isDatabaseSidecar(abs) {
    const resolved = path.resolve(abs);
    return resolved === path.resolve(db.DB_PATH) || resolved === path.resolve(`${db.DB_PATH}-wal`) || resolved === path.resolve(`${db.DB_PATH}-shm`);
}
function copyVolumeTree(source, target, base = source, manifestFiles = []) {
    if (!fs.existsSync(source)) return manifestFiles;
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const abs = path.join(source, entry.name);
        const rel = path.relative(base, abs).split(path.sep).join('/');
        if (rel === 'backups' || rel.startsWith('backups/') || isDatabaseSidecar(abs)) continue;
        if (entry.isSymbolicLink()) continue;
        const out = path.join(target, rel);
        if (entry.isDirectory()) {
            fs.mkdirSync(out, { recursive: true });
            copyVolumeTree(abs, target, base, manifestFiles);
        }
        else if (entry.isFile()) {
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.copyFileSync(abs, out);
            const data = fs.readFileSync(abs);
            manifestFiles.push({ path: rel, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
        }
    }
    return manifestFiles;
}
async function createPortableBackup(databaseFile) {
    const code = randomBytes(6).toString('hex').toUpperCase();
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'aunxz-pack-'));
    const archive = path.join(os.tmpdir(), `aunxz-backup-${code}.tar.gz`);
    const volDir = path.join(stage, 'volume');
    fs.mkdirSync(volDir, { recursive: true });
    const projectRootIsData = path.resolve(db.DATA_DIR) === path.resolve(__dirname);
    const assetRoot = projectRootIsData ? path.join(db.DATA_DIR, 'data') : db.DATA_DIR;
    const assetRootLabel = projectRootIsData ? 'data' : '.';
    const backupDb = path.join(stage, 'backup.sqlite');
    fs.copyFileSync(databaseFile, backupDb);
    const files = copyVolumeTree(assetRoot, volDir, assetRoot, []);
    const dbHash = createHash('sha256').update(fs.readFileSync(backupDb)).digest('hex');
    const manifest = {
        format: 'AUNXZ_FULL_BACKUP', version: 1, code, createdAt: new Date().toISOString(),
        database: 'backup.sqlite', databaseSha256: dbHash, assetRoot: assetRootLabel,
        volumeFiles: files, guildSettingsIncluded: true
    };
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
    try {
        execFileSync('tar', ['-czf', archive, '-C', stage, '.'], { stdio: 'pipe', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
    }
    catch (e) {
        fs.rmSync(archive, { force: true });
        throw new Error(`Could not package the volume backup: ${String(e.stderr || e.message || e).slice(0, 300)}`);
    }
    finally {
        fs.rmSync(stage, { recursive: true, force: true });
    }
    return { archive, code, manifest, size: fs.statSync(archive).size };
}
function splitPortableBackup(archive, code) {
    const size = fs.statSync(archive).size;
    if (size <= MAX_PART) return [{ path: archive, name: `aunxz-backup-${code}.tar.gz` }];
    const count = Math.ceil(size / MAX_PART);
    if (count > 10) throw new Error(`This backup is ${fmtBytes(size)} and needs ${count} parts. The restore command supports up to 10 parts (90 MB).`);
    const buf = fs.readFileSync(archive);
    const parts = [];
    for (let n = 0; n < count; n++) {
        const file = `${archive}.part${String(n + 1).padStart(3, '0')}`;
        fs.writeFileSync(file, buf.subarray(n * MAX_PART, Math.min(buf.length, (n + 1) * MAX_PART)));
        parts.push({ path: file, name: `aunxz-backup-${code}.tar.gz.part${String(n + 1).padStart(3, '0')}` });
    }
    return parts;
}
function progressEmbed(percent, title, detail) {
    const p = Math.max(0, Math.min(100, Math.floor(percent)));
    const filled = Math.round(p / 5);
    return ui.base(title || '♻️ Restoring AunXz')
        .setDescription(`\`${'█'.repeat(filled)}${'░'.repeat(20 - filled)}\` **${p}%**\n${detail || 'Working…'}`)
        .setFooter({ text: 'Keep the bot online until the restore finishes.' });
}
function copyRestoredVolume(volumeDir, assetRootLabel) {
    if (!volumeDir || !fs.existsSync(volumeDir)) return 0;
    const targetRoot = assetRootLabel === 'data' ? path.join(db.DATA_DIR, 'data') : db.DATA_DIR;
    fs.mkdirSync(targetRoot, { recursive: true });
    let copied = 0;
    function walk(src, dst) {
        for (const e of fs.readdirSync(src, { withFileTypes: true })) {
            const from = path.join(src, e.name);
            const to = path.join(dst, e.name);
            if (e.isSymbolicLink() || e.name === 'backups') continue;
            if (e.isDirectory()) {
                fs.mkdirSync(to, { recursive: true });
                walk(from, to);
            }
            else if (e.isFile()) {
                fs.mkdirSync(path.dirname(to), { recursive: true });
                fs.copyFileSync(from, to);
                copied++;
            }
        }
    }
    walk(volumeDir, targetRoot);
    return copied;
}
async function dmFiles(i, embed, files) {
    try {
        for (let n = 0; n < files.length; n += 5) {
            await i.user.send({ embeds: n === 0 ? [embed] : [], files: files.slice(n, n + 5).map(f => new AttachmentBuilder(fs.readFileSync(f.path), { name: f.name })) });
        }
        return null;
    }
    catch (e) {
        return e;
    }
}
const dmClosed = e => h.errorEmbed('I could not DM you', `Your DMs are closed (${e?.message || 'DM failed'}). Enable **Direct Messages** from server members for this server, then run the command again. Backups are never posted publicly.`);
const backupCooldown = new Map();
async function restoreFrom(file, onProgress = async () => {}) {
    raw.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS rs`);
    try {
        const live = new Set(userTables());
        const tables = raw.prepare("SELECT name FROM rs.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name).filter(t => live.has(t));
        const report = [];
        raw.exec('BEGIN');
        try {
            const stepEvery = Math.max(1, Math.ceil(tables.length / 7));
            for (let idx = 0; idx < tables.length; idx++) {
                const t = tables[idx];
                const liveCols = raw.prepare(`PRAGMA main.table_info(${q(t)})`).all().map(c => c.name);
                const bkCols = new Set(raw.prepare(`PRAGMA rs.table_info(${q(t)})`).all().map(c => c.name));
                const cols = liveCols.filter(c => bkCols.has(c)).map(q).join(',');
                if (!cols) continue;
                raw.exec(`DELETE FROM main.${q(t)}`);
                raw.exec(`INSERT INTO main.${q(t)} (${cols}) SELECT ${cols} FROM rs.${q(t)}`);
                report.push(t);
                if ((idx + 1) % stepEvery === 0 || idx === tables.length - 1)
                    await onProgress(idx + 1, tables.length, t);
            }
            raw.exec('COMMIT');
        }
        catch (e) {
            raw.exec('ROLLBACK');
            throw e;
        }
        return report;
    }
    finally {
        raw.exec('DETACH DATABASE rs');
    }
}

async function loadBackupAttachment(attachments, onProgress = async () => {}) {
    const atts = (Array.isArray(attachments) ? attachments : [attachments]).filter(Boolean);
    if (!atts.length) throw new Error('Attach the `.tar.gz` backup file from `/backup`. For split backups, attach every part in order.');
    if (atts.length > 10) throw new Error('Up to 10 backup parts can be uploaded at once.');
    const totalDeclared = atts.reduce((n, a) => n + Number(a.size || 0), 0);
    if (totalDeclared > 100 * 1024 * 1024) throw new Error(`The selected files total ${fmtBytes(totalDeclared)}; the limit is 100 MB.`);
    const firstName = String(atts[0].name || '');
    const isParts = atts.length > 1 || /\.part\d+$/i.test(firstName);
    let name = firstName.replace(/\.part\d+$/i, '');
    if (!isParts && !/\.(sqlite|db|gz|tgz|tar\.gz)$/i.test(name))
        throw new Error('Unsupported file. Use the `.tar.gz` full-volume backup from `/backup`, or an older `.sqlite` backup.');
    if (isParts) {
        const parsed = atts.map(a => ({ name: String(a.name || ''), n: Number((String(a.name || '').match(/\.part(\d+)$/i) || [])[1]) }));
        if (parsed.some(x => !x.n) || parsed.some(x => x.name.replace(/\.part\d+$/i, '') !== name))
            throw new Error('Multipart backup filenames do not match. Attach every part from the same backup.');
        parsed.sort((a, b) => a.n - b.n);
        for (let n = 0; n < parsed.length; n++) if (parsed[n].n !== n + 1) throw new Error(`Missing backup part ${String(n + 1).padStart(3, '0')}.`);
        const sortedAtts = parsed.map(x => atts.find(a => String(a.name || '') === x.name));
        atts.splice(0, atts.length, ...sortedAtts);
    }
    const dir = path.join(db.DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aunxz-restore-'));
    const inputPath = path.join(workDir, name.endsWith('.tar.gz') || name.endsWith('.tgz') ? 'incoming.tar.gz' : 'incoming.bin');
    let written = 0;
    try {
        const chunks = [];
        for (let n = 0; n < atts.length; n++) {
            const res = await fetch(atts[n].url);
            if (!res.ok) throw new Error(`Could not download attachment ${n + 1} (HTTP ${res.status}).`);
            const data = Buffer.from(await res.arrayBuffer());
            written += data.length;
            if (written > 100 * 1024 * 1024) throw new Error('Combined backup exceeds the 100 MB limit.');
            chunks.push(data);
            await onProgress(5 + Math.round((n + 1) / atts.length * 10), `Downloaded backup part ${n + 1}/${atts.length}.`);
        }
        let buf = Buffer.concat(chunks);
        const looksGzip = buf[0] === 0x1f && buf[1] === 0x8b;
        const isTarName = /\.(tar\.gz|tgz)$/i.test(name);
        if (isTarName || (isParts && looksGzip && !/\.(sqlite|db)(\.gz)?$/i.test(name))) {
            fs.writeFileSync(inputPath, buf);
            const listed = execFileSync('tar', ['-tzf', inputPath], { encoding: 'utf8', timeout: 30000, maxBuffer: 20 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean);
            const verbose = execFileSync('tar', ['-tvzf', inputPath], { encoding: 'utf8', timeout: 30000, maxBuffer: 20 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean);
            if (verbose.some(line => !['-', 'd'].includes(line[0]))) throw new Error('Backup archive contains links or special files and was rejected.');
            for (const rawName of listed) {
                const entry = rawName.replace(/^\.\//, '').replace(/\/$/, '');
                if (!entry || entry === '.') continue;
                if (path.posix.isAbsolute(entry) || entry.split('/').some(x => x === '..' || x === '')) throw new Error('Backup archive contains an unsafe path.');
                if (!['backup.sqlite', 'manifest.json', 'volume'].includes(entry.split('/')[0])) throw new Error(`Unexpected archive entry: ${entry.slice(0, 100)}`);
            }
            const extracted = path.join(workDir, 'unpacked');
            fs.mkdirSync(extracted, { recursive: true });
            execFileSync('tar', ['-xzf', inputPath, '-C', extracted, '--no-same-owner', '--no-same-permissions'], { stdio: 'pipe', timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
            const tmp = path.join(extracted, 'backup.sqlite');
            const manifestPath = path.join(extracted, 'manifest.json');
            if (!fs.existsSync(tmp) || !fs.existsSync(manifestPath)) throw new Error('This archive is missing its AunXz backup manifest or database.');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (manifest.format !== 'AUNXZ_FULL_BACKUP' || manifest.version !== 1 || !['.', 'data'].includes(manifest.assetRoot)) throw new Error('This is not a supported AunXz full-volume backup.');
            const hash = createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
            if (hash !== manifest.databaseSha256) throw new Error('The backup database checksum does not match; the file may be corrupted.');
            const counts = validateBackupDatabase(tmp);
            return { tmp, counts, workDir, filesDir: path.join(extracted, 'volume'), manifest, isFull: true, archiveCode: String(manifest.code || '') };
        }
        if (looksGzip) {
            try { buf = zlib.gunzipSync(buf, { maxOutputLength: 200 * 1024 * 1024 }); }
            catch (e) { throw new Error(`Could not decompress the backup: ${e.message}`); }
        }
        if (buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') throw new Error('This file is not a SQLite backup or AunXz full-volume archive.');
        const tmp = path.join(workDir, 'incoming.sqlite');
        fs.writeFileSync(tmp, buf);
        const counts = validateBackupDatabase(tmp);
        return { tmp, counts, workDir, filesDir: null, manifest: null, isFull: false, archiveCode: '' };
    }
    catch (e) {
        fs.rmSync(workDir, { recursive: true, force: true });
        if (e && (e.code === 'ENOENT' && /tar/.test(String(e.message)))) throw new Error('The server is missing the `tar` utility needed to read full-volume backups.');
        throw e;
    }
}
function validateBackupDatabase(tmp) {
    let Database;
    try { Database = require('better-sqlite3'); }
    catch { throw new Error('better-sqlite3 is not available to validate the file.'); }
    const probe = new Database(tmp, { readonly: true, fileMustExist: true });
    try {
        const integrity = probe.pragma('integrity_check', { simple: true });
        if (integrity !== 'ok') throw new Error(`Integrity check failed: ${integrity}`);
        const names = probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
        if (!names.includes('guild_config')) throw new Error('This does not look like an AunXz backup (missing `guild_config`).');
        return Object.fromEntries(names.filter(n => !n.startsWith('sqlite_')).map(n => [n, probe.prepare(`SELECT COUNT(*) c FROM ${q(n)}`).get().c]));
    }
    finally { probe.close(); }
}
function cleanupLoadedBackup(loaded) {
    if (loaded?.workDir) fs.rmSync(loaded.workDir, { recursive: true, force: true });
}

const dur = s => { s = Math.floor(s); const d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return `${d}d ${hh}h ${m}m ${s % 60}s`; };
async function statsEmbed(client) {
    const t0 = Date.now();
    await client.rest.get('/gateway').catch(() => { });
    const api = Date.now() - t0;
    const cpuStart = process.cpuUsage();
    const hr = process.hrtime.bigint();
    await new Promise(r => setTimeout(r, 250));
    const used = process.cpuUsage(cpuStart);
    const elapsed = Number(process.hrtime.bigint() - hr) / 1000;
    const cpu = Math.min(100, ((used.user + used.system) / elapsed) * 100);
    const mem = process.memoryUsage();
    const total = os.totalmem();
    const free = os.freemem();
    const guilds = client.guilds.cache;
    const shardIds = client.shard ? client.shard.ids : [...(client.ws.shards?.keys?.() || [0])];
    const shardCount = client.shard ? client.shard.count : (client.ws.shards?.size || 1);
    const members = guilds.reduce((a, g) => a + g.members.cache.size, 0);
    const msgs = client.channels.cache.reduce((a, c) => a + (c.messages?.cache?.size || 0), 0);
    return ui.base('📊 Bot stats').addFields({ name: 'Memory', value: `System: ${fmtBytes(total - free)} / ${fmtBytes(total)}\nHeap: ${fmtBytes(mem.heapUsed)} / ${fmtBytes(mem.heapTotal)}\nRSS: ${fmtBytes(mem.rss)}`, inline: true }, { name: 'CPU', value: `Process: ${cpu.toFixed(1)}%\nLoad avg: ${os.loadavg().map(x => x.toFixed(2)).join(' ')}\nCores: ${os.cpus().length}`, inline: true }, { name: 'Latency', value: `WebSocket: ${client.ws.ping}ms\nAPI: ${api}ms`, inline: true }, { name: 'Uptime', value: dur(process.uptime()), inline: true }, { name: 'Versions', value: `Node ${process.version}\ndiscord.js ${djsVersion}`, inline: true }, { name: 'Counts', value: `Guilds: ${guilds.size}\nUsers: ${guilds.reduce((a, g) => a + (g.memberCount || 0), 0)}\nChannels: ${client.channels.cache.size}`, inline: true }, { name: 'Shards', value: `Count: ${shardCount}\n${shardIds.map(id => `#${id}: ${guilds.filter(g => g.shardId === id).size} guilds`).join('\n') || '—'}`, inline: true }, { name: 'Caches', value: `Guilds ${guilds.size} • Users ${client.users.cache.size}\nChannels ${client.channels.cache.size} • Members ${members}\nMessages ${msgs}`, inline: true }, { name: 'Bot', value: `Commands loaded: ${ctx.commands.length}\nDatabase: ${fmtBytes(dbSize())}`, inline: true });
}
const refreshRow = uid => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`own-stats:${uid}`).setLabel('Refresh').setStyle(ButtonStyle.Primary).setEmoji('🔄'));
const errSessions = new Map();
function errPayload(token) {
    const s = errSessions.get(token);
    const list = db.listErrors(s.command);
    if (!list.length)
        return { embeds: [h.emptyEmbed('Error log', s.command ? `No errors recorded for \`${s.command}\`.` : 'No errors recorded. 🎉')], components: [] };
    s.index = Math.max(0, Math.min(s.index, list.length - 1));
    const e = list[s.index];
    const embed = ui.base(`🐞 Error #${e.id} (${s.index + 1}/${list.length})`).setColor(ui.DANGER).addFields({ name: 'Time', value: `<t:${Math.floor(e.ts / 1000)}:F>`, inline: true }, { name: 'Source', value: h.clip(e.source || '—', 200), inline: true }, { name: 'Command', value: e.command ? `/${e.command}` : '—', inline: true }, { name: 'Guild', value: e.guildId || '—', inline: true }, { name: 'User', value: e.userId ? `<@${e.userId}>` : '—', inline: true }, { name: 'Message', value: h.clip(e.message || '—', 900) }, { name: 'Stack (trimmed)', value: `\`\`\`\n${h.clip(String(e.stack || '—').replace(/```/g, "'''"), 850)}\n\`\`\`` });
    const b = (id, lab, dis, st = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(`own-e:${token}:${id}`).setLabel(lab).setStyle(st).setDisabled(dis);
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(b('prev', '◀', s.index === 0), b('next', '▶', s.index >= list.length - 1), b('full', 'View full', false, ButtonStyle.Primary))] };
}
async function handleErrorButton(i) {
    const [, token, action] = i.customId.split(':');
    const s = errSessions.get(token);
    if (!s)
        return void await i.reply({ embeds: [h.warnEmbed('Expired', 'Run `/errors view` again.')], ephemeral: true });
    if (!await h.authorOnly(i, s.userId) || !isOwner(i.user.id))
        return;
    if (action === 'full') {
        const e = db.listErrors(s.command)[s.index];
        if (!e)
            return void await i.reply({ embeds: [h.errorEmbed('Gone', 'That entry no longer exists.')], ephemeral: true });
        const text = `Error #${e.id}\nTime: ${new Date(e.ts).toISOString()}\nSource: ${e.source}\nCommand: ${e.command}\nGuild: ${e.guildId}\nUser: ${e.userId}\n\n${e.message}\n\n${e.stack}`;
        return void await i.reply({ files: [new AttachmentBuilder(Buffer.from(text), { name: `error-${e.id}.txt` })], ephemeral: true });
    }
    s.index += action === 'next' ? 1 : -1;
    await i.update(errPayload(token));
}
function recordError(err, context = '', meta = {}) {
    try {
        const m = String(context).match(/^Command \/(\S+)/);
        db.recordError({ source: context, command: meta.command || (m && m[1]) || null, guildId: meta.guildId || null, userId: meta.userId || null, message: err?.message || String(err), stack: err?.stack || '' });
    }
    catch (e) {
        console.error('[Owner] could not record error:', e.message);
    }
}
function trackCommand(name, guildId, ok) { try {
    db.trackCommandUse(name, guildId, ok);
}
catch (e) {
    console.error('[Owner] tracking failed:', e.message);
} }
const disabledInfo = name => { try {
    return db.getToggle(name);
}
catch {
    return null;
} };
const commands = [];
const add = (builder, opts, run) => { const c = define(builder, opts, run); commands.push(c); return c; };
const S = (name, desc) => new SlashCommandBuilder().setName(name).setDescription(desc);
add(S('owneradd', 'Add a co-owner.').addUserOption(o => o.setName('user').setDescription('User to add').setRequired(true)), { main: true }, async (i) => {
    const u = i.options.getUser('user');
    if (!u)
        return h.safeReply(i, { embeds: [h.errorEmbed('User not found', 'Mention a valid user.')], ephemeral: true });
    if (u.bot)
        return h.safeReply(i, { embeds: [h.errorEmbed('Invalid user', 'Bots cannot be co-owners.')], ephemeral: true });
    if (isMainOwner(u.id))
        return h.safeReply(i, { embeds: [h.errorEmbed('Already owner', 'That user is a main owner.')], ephemeral: true });
    if (isCoOwner(u.id))
        return h.safeReply(i, { embeds: [h.errorEmbed('Already added', `${u} is already a co-owner.`)], ephemeral: true });
    await confirmFlow(i, { title: 'Add co-owner?', description: `${u} will be able to use every owner command except \`owneradd\`, \`ownerremove\`, \`restore\` and \`resetguild\`.`, yes: 'Add',
        run: async () => { db.saveOwnerConfig({ coOwners: [...coOwners(), { id: u.id, addedBy: i.user.id, addedAt: Date.now() }] }); return `${u} is now a co-owner.`; } });
});
add(S('ownerremove', 'Remove a co-owner.').addUserOption(o => o.setName('user').setDescription('Co-owner to remove').setRequired(true)), { main: true }, async (i) => {
    const u = i.options.getUser('user');
    if (!u)
        return h.safeReply(i, { embeds: [h.errorEmbed('User not found', 'Mention a valid user.')], ephemeral: true });
    if (isMainOwner(u.id))
        return h.safeReply(i, { embeds: [h.errorEmbed('Not allowed', 'The main owner cannot be removed.')], ephemeral: true });
    if (!isCoOwner(u.id))
        return h.safeReply(i, { embeds: [h.errorEmbed('Not a co-owner', `${u} is not in the co-owner list.`)], ephemeral: true });
    await confirmFlow(i, { title: 'Remove co-owner?', description: `${u} will lose all owner commands.`, yes: 'Remove',
        run: async () => { db.saveOwnerConfig({ coOwners: coOwners().filter(o => o.id !== u.id) }); return `${u} is no longer a co-owner.`; } });
});
add(S('owners', 'List owners and co-owners.'), {}, async (i) => {
    const lines = [...envIds().map(id => `👑 <@${id}> — main owner (config)`), ...coOwners().map(o => `🔑 <@${o.id}> — added <t:${Math.floor(o.addedAt / 1000)}:D> by <@${o.addedBy}>`)];
    await h.paginate(i, h.listPages({ title: '👑 Bot owners', lines, emptyHint: 'Set OWNER_ID in your environment.' }), { ephemeral: true });
});
add(S('backup', 'Create a full-volume backup and DM the archive plus its code.'), {}, async (i) => {
    const wait = 60000 - (Date.now() - (backupCooldown.get(i.user.id) || 0));
    if (wait > 0) return h.safeReply(i, { embeds: [h.warnEmbed('Cooldown', `Try again in ${Math.ceil(wait / 1000)}s.`)], ephemeral: true });
    await ack(i);
    let sqlFile = null, packaged = null, parts = [];
    try {
        await done(i, { embeds: [progressEmbed(8, '📦 Preparing full backup', 'Creating a consistent database snapshot…')] });
        sqlFile = await snapshot('backup');
        await done(i, { embeds: [progressEmbed(30, '📦 Preparing full backup', 'Packaging server settings, prefixes, setup records, and persistent volume files…')] });
        packaged = await createPortableBackup(sqlFile);
        parts = splitPortableBackup(packaged.archive, packaged.code);
        if (parts.length > 10) throw new Error('Backup requires too many Discord attachments.');
        await done(i, { embeds: [progressEmbed(75, '📦 Sending backup', `Backup **${packaged.code}** • ${fmtBytes(packaged.size)} • ${parts.length} part(s). DM delivery is in progress…`)] });
        for (let n = 0; n < parts.length; n++) {
            const file = parts[n];
            const header = n === 0
                ? `📦 **AunXz Full-Volume Backup**\n**Backup code:** \`${packaged.code}\`\n**Created:** ${new Date(packaged.manifest.createdAt).toISOString()}\n**Size:** ${fmtBytes(packaged.size)}\n**Included:** all SQLite-backed server settings/prefixes/setup records plus persistent files in the bot's data volume.\n\nKeep every attachment. To restore, run **/restore** and upload this file. If split into parts, put the first piece in the file option and the next pieces in part2, part3, and so on in order.`
                : `AunXz backup **${packaged.code}** — part ${n + 1}/${parts.length}. Keep this with the other parts.`;
            await i.user.send({ content: header, files: [new AttachmentBuilder(fs.readFileSync(file.path), { name: file.name })] });
        }
        backupCooldown.set(i.user.id, Date.now());
        db.saveOwnerConfig({ lastBackupAt: Date.now() });
        await done(i, { embeds: [h.successEmbed('Full backup sent', `Check your DMs.\n**Code:** \`${packaged.code}\`\n**Size:** ${fmtBytes(packaged.size)}\n**Parts:** ${parts.length}\n\nThis file can restore the database-backed settings and persistent files even if the Railway volume or project is deleted.`)] });
    }
    catch (e) {
        console.error('[Owner] full backup failed:', e);
        await done(i, { embeds: [h.errorEmbed('Backup failed', `${String(e?.message || e).slice(0, 1100)}\n\nIf the file is too large, use the platform's larger attachment limit or back up less stored media.`)] });
    }
    finally {
        for (const f of [sqlFile, packaged?.archive, ...parts.map(x => x.path)]) if (f) fs.rm(f, { force: true }, () => { });
    }
});
add(S('restore', 'Restore server settings and volume files from a full backup.').addAttachmentOption(o => o.setName('file').setDescription('Backup file, or part 001').setRequired(true))
    .addAttachmentOption(o => o.setName('part2').setDescription('Optional backup part 002'))
    .addAttachmentOption(o => o.setName('part3').setDescription('Optional backup part 003'))
    .addAttachmentOption(o => o.setName('part4').setDescription('Optional backup part 004'))
    .addAttachmentOption(o => o.setName('part5').setDescription('Optional backup part 005'))
    .addAttachmentOption(o => o.setName('part6').setDescription('Optional backup part 006'))
    .addAttachmentOption(o => o.setName('part7').setDescription('Optional backup part 007'))
    .addAttachmentOption(o => o.setName('part8').setDescription('Optional backup part 008'))
    .addAttachmentOption(o => o.setName('part9').setDescription('Optional backup part 009'))
    .addAttachmentOption(o => o.setName('part10').setDescription('Optional backup part 010')), { main: true }, async (i) => {
    await ack(i);
    const attachmentNames = ['file', 'part2', 'part3', 'part4', 'part5', 'part6', 'part7', 'part8', 'part9', 'part10'];
    const atts = attachmentNames.map(n => i.options.getAttachment(n)).filter(Boolean);
    let loaded = null;
    try {
        await done(i, { embeds: [progressEmbed(3, '♻️ Preparing restore', 'Downloading and validating the backup. Nothing has been changed yet…')] });
        loaded = await loadBackupAttachment(atts, async (pct, text) => done(i, { embeds: [progressEmbed(pct, '♻️ Preparing restore', text)] }));
        await done(i, { embeds: [progressEmbed(20, '♻️ Backup verified', `Integrity check passed. ${Object.keys(loaded.counts).length} database tables found${loaded.isFull ? ` • code \`${loaded.archiveCode || 'verified'}\` • ${loaded.manifest.volumeFiles?.length || 0} volume files` : ''}. Preparing a safety backup…`)] });
        const safetyDb = await snapshot('pre-restore');
        let safetyArchive = null;
        try {
            const pack = await createPortableBackup(safetyDb);
            const safeDir = path.join(db.DATA_DIR, 'backups');
            safetyArchive = path.join(safeDir, `aunxz-pre-restore-${stamp()}.tar.gz`);
            fs.copyFileSync(pack.archive, safetyArchive);
            fs.rmSync(pack.archive, { force: true });
        }
        catch (e) {
            console.warn('[Owner] could not create full safety archive:', e.message);
        }
        const live = Object.fromEntries(userTables().map(t => [t, raw.prepare(`SELECT COUNT(*) c FROM ${q(t)}`).get().c]));
        const lines = Object.keys(loaded.counts).filter(t => t in live).slice(0, 18).map(t => `• \`${t}\`: ${live[t]} → **${loaded.counts[t]}** rows`);
        const targetDesc = `Verified backup${loaded.isFull ? ` • code \`${loaded.archiveCode || 'verified'}\` • ${loaded.manifest.volumeFiles?.length || 0} persistent volume file(s)` : ' • legacy database-only format'}.\n\nThis overwrites database tables available in both versions${loaded.isFull ? ' and copies backed-up persistent volume files' : ''}. A pre-restore safety backup was saved in the bot data directory.\n\n${h.clip(lines.join('\n') || 'Database table counts are ready.', 1800)}\n\nPress **Restore now** to begin.`;
        await confirmFlow(i, { title: 'Restore AunXz backup?', description: targetDesc, yes: 'Restore now', run: async (btn) => {
            const update = (pct, detail) => btn.editReply({ embeds: [progressEmbed(pct, '♻️ Restoring AunXz', detail)], components: [] }).catch(e => { console.warn('[Owner] restore progress update failed:', e.message); });
            try {
                await update(35, 'Starting database restore. Current settings have been saved to a safety backup…');
                const restoredCode = loaded.archiveCode || '';
                const restoredTables = await restoreFrom(loaded.tmp, async (doneCount, totalCount, table) => {
                    const pct = 40 + Math.round((doneCount / Math.max(1, totalCount)) * 40);
                    await update(pct, `Restoring database table **${table}**\nTables processed: **${doneCount}/${totalCount}**.`);
                });
                let fileCount = 0;
                if (loaded.isFull) {
                    await update(85, 'Database restored. Copying persistent files from the backup…');
                    fileCount = copyRestoredVolume(loaded.filesDir, loaded.manifest.assetRoot);
                }
                await update(97, 'Verifying the restored database and files…');
                const finalIntegrity = raw.pragma('integrity_check', { simple: true });
                if (finalIntegrity !== 'ok') throw new Error(`Post-restore integrity check failed: ${finalIntegrity}`);
                cleanupLoadedBackup(loaded); loaded = null;
                return h.successEmbed('✅ Restore complete', `**${restoredTables.length}** database tables restored${fileCount ? `\n**${fileCount}** persistent files copied` : ''}.\n**Safety backup:** \`${path.basename(safetyArchive || safetyDb)}\`\n\n${restoredCode ? `Backup code: \`${restoredCode}\`` : 'Keep the original backup file in a safe place.'}\nThe bot may need a restart if restored files affect active features.`);
            }
            catch (e) {
                throw new Error(`Restore stopped: ${e.message}. The database transaction is rolled back if the database restore itself failed. Safety backup: ${path.basename(safetyArchive || safetyDb)}.`);
            }
            finally {
                cleanupLoadedBackup(loaded);
                if (safetyArchive) fs.rm(safetyDb, { force: true }, () => { });
            }
        } });
    }
    catch (e) {
        console.error('[Owner] restore failed:', e);
        cleanupLoadedBackup(loaded);
        await done(i, { embeds: [h.errorEmbed('Restore failed', String(e?.message || e).slice(0, 1400))] });
    }
});
add(S('resetguild', 'Delete ALL stored data for a server.').addStringOption(o => o.setName('guild_id').setDescription('Server ID').setRequired(true)), { main: true }, async (i) => {
    const gid = String(i.options.getString('guild_id') || '').trim();
    if (!snowflake(gid))
        return h.safeReply(i, { embeds: [h.errorEmbed('Invalid ID', 'Provide a numeric server ID.')], ephemeral: true });
    const counts = countGuild(gid);
    if (!counts.length)
        return h.safeReply(i, { embeds: [h.infoEmbed('Nothing stored', `No data exists for \`${gid}\`.`)], ephemeral: true });
    const total = counts.reduce((a, c) => a + c.count, 0);
    await confirmFlow(i, { title: `Delete all data for ${gid}?`, yes: 'Delete',
        description: `**${total}** records will be deleted:\n${counts.map(c => `• ${label(c.table)}: **${c.count}**`).join('\n')}\n\nKept: memberships and the owner audit/error logs.`,
        extra: [{ id: 'backup', label: 'Backup then delete' }],
        run: async (btn, choice) => {
            if (choice === 'backup') {
                const f = path.join(os.tmpdir(), `guild-${gid}-${stamp()}.json`);
                fs.writeFileSync(f, JSON.stringify(exportGuild(gid), null, 2));
                const err = await dmFiles(i, h.infoEmbed('Guild data backup', `Backup of \`${gid}\` before deletion.`), [{ path: f, name: `guild-${gid}.json` }]);
                fs.unlink(f, () => { });
                if (err)
                    throw new Error('Could not DM the backup (DMs closed), so nothing was deleted.');
            }
            const removed = deleteGuildData(gid);
            for (const ext of ['.mp3', '.wav', '.ogg', '.m4a', '.audio', '.opus', '.aac', '.flac', '.webm', '.oga'])
                fs.unlink(path.join(db.DATA_DIR, 'greetvoice', `${gid}${ext}`), () => { });
            return h.successEmbed('Guild data deleted', removed.map(c => `• ${label(c.table)}: ${c.count}`).join('\n') || 'Nothing removed.');
        } });
});
add(S('dbstats', 'Database size and record counts.'), {}, async (i) => {
    const tables = userTables().map(t => ({ t, n: raw.prepare(`SELECT COUNT(*) c FROM ${q(t)}`).get().c })).sort((a, b) => b.n - a.n);
    const per = new Map();
    for (const t of resetTables())
        for (const r of raw.prepare(`SELECT guildId, COUNT(*) c FROM ${q(t)} GROUP BY guildId`).all())
            if (snowflake(r.guildId))
                per.set(r.guildId, (per.get(r.guildId) || 0) + r.c);
    const top = [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g, n], k) => `${k + 1}. ${i.client.guilds.cache.get(g)?.name || g} — **${n}** records`);
    const last = db.getOwnerConfig().lastBackupAt;
    const lines = tables.map(x => `\`${x.t}\` ${x.n}`);
    const half = Math.ceil(lines.length / 2);
    await h.safeReply(i, { embeds: [ui.base('🗄️ Database stats').addFields({ name: 'Size', value: fmtBytes(dbSize()), inline: true }, { name: 'Guilds with data', value: String(per.size), inline: true }, { name: 'Last backup', value: last ? `<t:${Math.floor(last / 1000)}:R>` : 'Never', inline: true }, { name: 'Records per table', value: h.clip(lines.slice(0, half).join('\n') || '—', 1000), inline: true }, { name: '\u200b', value: h.clip(lines.slice(half).join('\n') || '\u200b', 1000), inline: true }, { name: 'Largest guilds', value: h.clip(top.join('\n') || '—', 1000) })], ephemeral: true });
});
add(S('cleanup', 'Delete data for servers the bot has left.').addBooleanOption(o => o.setName('dry_run').setDescription('Preview only')), {}, async (i) => {
    const stale = [...guildIdsWithData()].filter(g => !i.client.guilds.cache.has(g));
    if (!stale.length)
        return h.safeReply(i, { embeds: [h.successEmbed('Nothing to clean', 'Every stored guild is one I am still in.')], ephemeral: true });
    const per = stale.map(g => ({ g, n: countGuild(g).reduce((a, c) => a + c.count, 0) }));
    const total = per.reduce((a, c) => a + c.n, 0);
    const preview = `**${stale.length}** departed server(s), **${total}** records:\n${per.slice(0, 15).map(p => `• \`${p.g}\` — ${p.n}`).join('\n')}${per.length > 15 ? `\n…and ${per.length - 15} more` : ''}`;
    if (i.options.getBoolean('dry_run'))
        return h.safeReply(i, { embeds: [h.infoEmbed('Cleanup dry run', `${preview}\n\nNothing was deleted.`)], ephemeral: true });
    await confirmFlow(i, { title: 'Delete data for departed servers?', description: preview, yes: 'Delete',
        run: async () => {
            const before = dbSize();
            let n = 0;
            for (const g of stale)
                n += deleteGuildData(g).reduce((a, c) => a + c.count, 0);
            try {
                raw.exec('VACUUM');
            }
            catch { }
            return h.successEmbed('Cleanup complete', `Removed **${n}** records from **${stale.length}** servers.\nReclaimed ≈ ${fmtBytes(Math.max(0, before - dbSize()))}.`);
        } });
});
add(S('export', 'Export a server\'s settings and data as JSON (sent by DM).').addStringOption(o => o.setName('guild_id').setDescription('Server ID (default: this server)')), {}, async (i) => {
    const gid = String(i.options.getString('guild_id') || i.guildId || '').trim();
    if (!snowflake(gid))
        return h.safeReply(i, { embeds: [h.errorEmbed('Server required', 'Use this in a server or pass `guild_id`.')], ephemeral: true });
    await ack(i);
    const data = exportGuild(gid);
    if (!Object.keys(data.tables).length)
        return done(i, { embeds: [h.infoEmbed('Nothing to export', `No data stored for \`${gid}\`.`)] });
    const f = path.join(os.tmpdir(), `guild-${gid}-${stamp()}.json`);
    fs.writeFileSync(f, JSON.stringify(data, null, 2));
    const err = await dmFiles(i, h.successEmbed('Guild export', `Server \`${gid}\` • tokens/secrets excluded.`), [{ path: f, name: `guild-${gid}.json` }]);
    if (err && isSlash(i)) {
        await i.editReply({ embeds: [h.warnEmbed('DMs closed', 'Attached here (only you can see this).')], files: [new AttachmentBuilder(f, { name: `guild-${gid}.json` })] });
        fs.unlink(f, () => { });
        return;
    }
    fs.unlink(f, () => { });
    if (err)
        return done(i, { embeds: [dmClosed(err)] });
    await done(i, { embeds: [h.successEmbed('Export sent', 'Check your DMs.')] });
});
add(S('stats', 'Bot resource and cache statistics.'), {}, async (i) => {
    await ack(i);
    await done(i, { embeds: [await statsEmbed(i.client)], components: [refreshRow(i.user.id)] });
});
add(S('errors', 'Recent errors and crashes.')
    .addSubcommand(s => s.setName('view').setDescription('Browse recent errors.').addStringOption(o => o.setName('command').setDescription('Filter by command name')))
    .addSubcommand(s => s.setName('clear').setDescription('Delete logged errors.').addStringOption(o => o.setName('command').setDescription('Only this command'))), {}, async (i) => {
    const command = (i.options.getString('command') || '').replace(/^\//, '').trim() || null;
    if (i.options.getSubcommand() === 'clear') {
        const n = db.listErrors(command).length;
        if (!n)
            return h.safeReply(i, { embeds: [h.infoEmbed('Nothing to clear', 'The error log is already empty.')], ephemeral: true });
        return confirmFlow(i, { title: 'Clear error log?', description: `Delete **${n}** logged error(s)${command ? ` for \`${command}\`` : ''}.`, yes: 'Clear', run: async () => `Deleted ${db.clearErrors(command)} error(s).` });
    }
    const token = randomBytes(5).toString('hex');
    errSessions.set(token, { userId: i.user.id, command, index: 0 });
    setTimeout(() => errSessions.delete(token), 600000).unref?.();
    await h.safeReply(i, { ...errPayload(token), ephemeral: true });
});
add(S('commandstats', 'Command usage statistics.')
    .addStringOption(o => o.setName('range').setDescription('Time range (default all-time)').addChoices({ name: 'today', value: 'today' }, { name: 'week', value: 'week' }, { name: 'all-time', value: 'all' }))
    .addBooleanOption(o => o.setName('this_server').setDescription('Only this server')), {}, async (i) => {
    const range = i.options.getString('range') || 'all';
    const guildOnly = !!i.options.getBoolean('this_server') && i.guildId;
    const rows = db.commandUsage({ range, guildId: guildOnly ? i.guildId : null });
    const lines = rows.map((r, k) => { const n = r.ok + r.fail; return `**${k + 1}. /${r.name}** — ${n} uses • ${n ? ((r.fail / n) * 100).toFixed(1) : '0.0'}% failed • <t:${Math.floor(r.lastUsed / 1000)}:R>`; });
    await h.paginate(i, h.listPages({ title: `📈 Command stats — ${range === 'all' ? 'all-time' : range}${guildOnly ? ' (this server)' : ''}`, lines, emptyHint: 'No commands have been used in this range.' }), { ephemeral: true });
});
const PROTECTED = () => new Set(['help', 'commandtoggle', ...ctx.commands.filter(c => c.ownerOnly).map(c => c.data.name)]);
const CONFIRM_FIRST = new Set(['setup', 'ban', 'kick', 'timeout', 'untimeout', 'purge', 'role', 'lock', 'unlock', 'ticketpanel', 'giveaway', 'warn']);
function resolveCommandName(input) {
    const n = String(input || '').toLowerCase().replace(/^\//, '').trim();
    const real = ctx.aliases.get(n) || n;
    return ctx.commands.find(c => c.data.name === real)?.data.name || null;
}
add(S('commandtoggle', 'Globally enable/disable a command.')
    .addSubcommand(s => s.setName('toggle').setDescription('Flip a command on/off.').addStringOption(o => o.setName('name').setDescription('Command name or alias').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason shown to users')))
    .addSubcommand(s => s.setName('list').setDescription('Show disabled commands.')), {}, async (i) => {
    if (i.options.getSubcommand() === 'list') {
        const lines = db.listToggles().map(t => `**/${t.name}** — ${t.reason || 'no reason'} • by <@${t.byId}> • <t:${Math.floor(t.at / 1000)}:R>`);
        return h.paginate(i, h.listPages({ title: '🚫 Disabled commands', lines, emptyHint: 'Every command is enabled.' }), { ephemeral: true });
    }
    const name = resolveCommandName(i.options.getString('name'));
    if (!name)
        return h.safeReply(i, { embeds: [h.errorEmbed('Unknown command', `No command or alias called \`${i.options.getString('name')}\`.`)], ephemeral: true });
    if (PROTECTED().has(name))
        return h.safeReply(i, { embeds: [h.errorEmbed('Protected command', `\`/${name}\` is a core command and cannot be disabled.`)], ephemeral: true });
    const reason = (i.options.getString('reason') || '').slice(0, 200) || null;
    const was = db.getToggle(name);
    const apply = async () => { if (was) {
        db.removeToggle(name);
        return `\`/${name}\` is **enabled** again.`;
    } db.setToggle(name, reason, i.user.id); return `\`/${name}\` is now **disabled**${reason ? ` — ${reason}` : ''}.`; };
    if (!was && (CONFIRM_FIRST.has(name) || /setup$/.test(name)))
        return confirmFlow(i, { title: `Disable /${name}?`, description: 'This is a core command. It will be disabled for everyone until re-enabled.', yes: 'Disable', run: apply });
    await h.safeReply(i, { embeds: [h.successEmbed('Command updated', await apply())], ephemeral: true });
});
const HELP = {
    access: ['🔑 Owners & access', '`/owneradd` `/ownerremove` — manage co-owners (main owner only)\n`/owners` — list owners'],
    data: ['🗄️ Database', '`/backup` — DM a full-volume backup + code\n`/restore` — restore with progress (main owner)\n`/resetguild` — wipe a server (main owner)\n`/dbstats` `/cleanup` `/export`'],
    monitor: ['📊 Monitoring', '`/stats` — resources & caches\n`/errors view|clear` — crash log\n`/commandstats` — usage & failure rates'],
    commands: ['🧰 Commands', '`/commandtoggle toggle|list` — globally disable commands\n`/ownerhelp` — this menu']
};
add(S('ownerhelp', 'Owner command reference.'), {}, async (i) => {
    const render = key => ({ embeds: [ui.base(HELP[key][0]).setDescription(HELP[key][1])], components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`own-help:${i.user.id}`).setPlaceholder('Choose a category…').addOptions(Object.entries(HELP).map(([v, x]) => ({ label: x[0].replace(/^\S+\s/, ''), value: v, emoji: x[0].split(' ')[0], default: v === key }))))] });
    await h.safeReply(i, { ...render('access'), ephemeral: true });
});
async function handleInteraction(i) {
    const id = i.customId;
    if (!id || !/^own-(c|stats|e|help)[:]/.test(id))
        return false;
    try {
        if (!isOwner(i.user.id)) {
            await i.reply({ embeds: [h.errorEmbed('Owner only', 'This command is owner-only.')], ephemeral: true });
            return true;
        }
        if (id.startsWith('own-c:'))
            await handleConfirm(i);
        else if (id.startsWith('own-e:'))
            await handleErrorButton(i);
        else if (id.startsWith('own-stats:')) {
            if (!await h.authorOnly(i, id.split(':')[1]))
                return true;
            await i.deferUpdate();
            await i.editReply({ embeds: [await statsEmbed(i.client)], components: [refreshRow(i.user.id)] });
        }
        else if (id.startsWith('own-help:')) {
            if (!await h.authorOnly(i, id.split(':')[1]))
                return true;
            const key = i.values[0];
            await i.update({ embeds: [ui.base(HELP[key][0]).setDescription(HELP[key][1])], components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`own-help:${i.user.id}`).setPlaceholder('Choose a category…').addOptions(Object.entries(HELP).map(([v, x]) => ({ label: x[0].replace(/^\S+\s/, ''), value: v, emoji: x[0].split(' ')[0], default: v === key }))))] });
        }
    }
    catch (e) {
        console.error('[Owner] component failed:', e);
        await h.safeReply(i, { embeds: [h.errorEmbed('Owner error', String(e?.message || e).slice(0, 1000))], ephemeral: true });
    }
    return true;
}
module.exports = { _t: { countGuild, deleteGuildData, restoreFrom, exportGuild, guildIdsWithData, snapshot }, commands, init, isOwner, isMainOwner, isCoOwner, handleInteraction, recordError, trackCommand, disabledInfo };

};
__modules["settings.js"] = function(module, exports, require, __filename, __dirname) {
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const db = require('./database');
const ui = require('./ui');
const h = require('./helpers');
const TEXT = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
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
    if (value === null || value === undefined || value === '')
        return '*Not set*';
    if (s.type === 'channel' || s.type === 'category')
        return `<#${value}>`;
    if (s.type === 'role')
        return `<@&${value}>`;
    if (s.type === 'toggle')
        return value ? `${h.THEME.emoji.on()} Enabled` : `${h.THEME.emoji.off()} Disabled`;
    return h.clip(String(value), 900);
}
function viewEmbed(s, i, title = s.desc, color) {
    const value = getPath(db.getConfig(i.guildId), s.path);
    const e = ui.base(`${h.THEME.emoji.settings()} ${title}`).addFields({ name: 'Current value', value: show(s, value), inline: false });
    if (s.type === 'text' && value)
        e.addFields({ name: 'Live preview', value: h.clip(vars(value, i), 1000) }, { name: 'Variables', value: '`{user}` `{server}` `{membercount}` `{level}`' });
    if (color)
        e.setColor(color);
    return e;
}
const editRow = (s, uid) => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`cfgset:edit:${uid}:${s.name}`).setLabel('Edit').setStyle(ButtonStyle.Primary).setEmoji(h.THEME.emoji.edit));
function applyValue(s, patchValue, guildId) { db.saveConfig(guildId, patchOf(s.path, patchValue)); }
function build(s) {
    const b = new SlashCommandBuilder().setName(s.name).setDescription(`${s.desc} (set / view / reset).`).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
    b.addSubcommand(c => c.setName('view').setDescription(`Show the current ${s.desc.toLowerCase()}.`));
    b.addSubcommand(c => {
        c.setName('set').setDescription(`Change the ${s.desc.toLowerCase()}.`);
        if (s.type === 'channel')
            c.addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT));
        else if (s.type === 'category')
            c.addChannelOption(o => o.setName('category').setDescription('Category').setRequired(true).addChannelTypes(ChannelType.GuildCategory));
        else if (s.type === 'role')
            c.addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true));
        else if (s.type === 'text')
            c.addStringOption(o => o.setName('text').setDescription('Text (supports {user} {server} {membercount})').setRequired(true));
        else if (s.type === 'number')
            c.addIntegerOption(o => o.setName('value').setDescription(`${s.min}–${s.max}`).setRequired(true).setMinValue(s.min).setMaxValue(s.max));
        else
            c.addBooleanOption(o => o.setName('enabled').setDescription('on / off').setRequired(true));
        return c;
    });
    b.addSubcommand(c => c.setName('reset').setDescription(`Restore the default ${s.desc.toLowerCase()}.`));
    return b;
}
async function validate(s, i) {
    const me = i.guild.members.me;
    if (s.type === 'channel') {
        const ch = i.options.getChannel('channel');
        if (!ch || !TEXT.includes(ch.type))
            return { error: 'Choose a text or announcement channel.' };
        const missing = h.missingChannelPerms(ch, me, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
        if (missing.length)
            return { error: `I'm missing **${missing.join(', ')}** in ${ch}. Grant those first so the setting actually works.` };
        return { value: ch.id };
    }
    if (s.type === 'category') {
        const ch = i.options.getChannel('category');
        if (!ch || ch.type !== ChannelType.GuildCategory)
            return { error: 'Choose a category channel.' };
        if (!ch.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels))
            return { error: `I need **Manage Channels** in ${ch.name} to create ticket channels there.` };
        return { value: ch.id };
    }
    if (s.type === 'role') {
        const role = i.options.getRole('role');
        if (!role)
            return { error: 'That role was not found.' };
        if (role.id === i.guild.id)
            return { error: '`@everyone` cannot be used here.' };
        if (s.hierarchy) {
            if (role.managed)
                return { error: `${role} is managed by an integration and cannot be assigned.` };
            if (!me.permissions.has(PermissionFlagsBits.ManageRoles))
                return { error: 'I need the **Manage Roles** permission to hand out this role.' };
            if (role.position >= me.roles.highest.position)
                return { error: `${role} is equal to or above my highest role. Move my role above it in Server Settings → Roles.` };
        }
        return { value: role.id };
    }
    if (s.type === 'text') {
        const text = String(i.options.getString('text') || '').trim();
        if (!text)
            return { error: 'The text cannot be empty.' };
        if (text.length > 1000)
            return { error: `Too long: ${text.length}/1000 characters.` };
        return { value: text };
    }
    if (s.type === 'number') {
        const n = i.options.getInteger('value');
        if (!Number.isInteger(n) || n < s.min || n > s.max)
            return { error: `Enter a whole number from ${s.min} to ${s.max}.` };
        return { value: n };
    }
    const en = i.options.getBoolean('enabled');
    return en === null ? { error: 'Specify `enabled` as true or false.' } : { value: en };
}
function makeCommand(s) {
    return {
        data: build(s),
        async execute(i) {
            if (!i.guild)
                return h.safeReply(i, { embeds: [h.errorEmbed('Server only', 'Use this inside a server.')], ephemeral: true });
            if (!i.member.permissions.has(PermissionFlagsBits.ManageGuild))
                return h.safeReply(i, { embeds: [h.errorEmbed('Missing permissions', 'You need **Manage Server** to change this setting.')], ephemeral: true });
            const sub = i.options.getSubcommand();
            if (sub === 'view')
                return h.safeReply(i, { embeds: [viewEmbed(s, i)], components: s.type === 'text' ? [editRow(s, i.user.id)] : [], ephemeral: true });
            if (sub === 'reset') {
                return h.safeReply(i, { embeds: [h.warnEmbed('Reset to default?', `**${s.desc}** will go back to: ${show(s, defaultOf(s))}`)], components: [h.confirmRow(`cfgset:rst:${i.user.id}:${s.name}`, { yes: 'Reset' })], ephemeral: true });
            }
            const res = await validate(s, i);
            if (res.error)
                return h.safeReply(i, { embeds: [h.errorEmbed('Invalid value', res.error)], ephemeral: true });
            applyValue(s, res.value, i.guildId);
            return h.safeReply(i, { embeds: [viewEmbed(s, i, `${s.desc} updated`, ui.OK)], components: s.type === 'text' ? [editRow(s, i.user.id)] : [], ephemeral: true });
        }
    };
}
async function handleInteraction(i) {
    const id = i.customId;
    if (!id || !id.startsWith('cfgset:'))
        return false;
    const [, action, uid, name, choice] = id.split(':');
    const s = SETTINGS.find(x => x.name === name);
    try {
        if (!await h.authorOnly(i, uid))
            return true;
        if (!s || !i.guild) {
            await h.safeReply(i, { embeds: [h.errorEmbed('Unavailable', 'That setting no longer exists.')], ephemeral: true });
            return true;
        }
        if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await i.reply({ embeds: [h.errorEmbed('Missing permissions', 'You need **Manage Server**.')], ephemeral: true });
            return true;
        }
        if (action === 'rst') {
            if (choice !== 'yes') {
                await i.update({ embeds: [h.infoEmbed('Cancelled', 'Nothing changed.')], components: [] });
                return true;
            }
            applyValue(s, defaultOf(s), i.guildId);
            await i.update({ embeds: [viewEmbed(s, i, `${s.desc} reset`, ui.OK)], components: [] });
        }
        else if (action === 'edit') {
            const cur = getPath(db.getConfig(i.guildId), s.path);
            const input = new TextInputBuilder().setCustomId('text').setLabel(s.desc.slice(0, 45)).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
            if (cur)
                input.setValue(String(cur).slice(0, 1000));
            await i.showModal(new ModalBuilder().setCustomId(`cfgset:modal:${uid}:${s.name}`).setTitle(`Edit ${s.desc}`.slice(0, 45)).addComponents(new ActionRowBuilder().addComponents(input)));
        }
        else if (action === 'modal') {
            const text = i.fields.getTextInputValue('text').trim();
            if (!text) {
                await i.reply({ embeds: [h.errorEmbed('Invalid value', 'The text cannot be empty.')], ephemeral: true });
                return true;
            }
            applyValue(s, text, i.guildId);
            await i.reply({ embeds: [viewEmbed(s, i, `${s.desc} updated`, ui.OK)], components: [editRow(s, uid)], ephemeral: true });
        }
    }
    catch (e) {
        console.error('[Settings] interaction failed:', e);
        await h.safeReply(i, { embeds: [h.errorEmbed('Settings error', String(e?.message || e).slice(0, 1000))], ephemeral: true });
    }
    return true;
}
const commands = SETTINGS.map(makeCommand);
module.exports = { commands, handleInteraction, SETTINGS };

};
__modules["sticky.js"] = function(module, exports, require, __filename, __dirname) {
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, Routes } = require('discord.js');
const db = require('./database');
const ui = require('./ui');
const h = require('./helpers');
const REQUIRED_PERMS = [
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages
];
const DEBOUNCE_MS = 1500;
const MAX_WAIT_MS = 5000;
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const drafts = new Map();
const draftKey = (guildId, userId) => `${guildId}:${userId}`;
function embedJSON(data = {}) {
    const e = {};
    if (data.title)
        e.title = String(data.title).slice(0, 256);
    if (data.description)
        e.description = String(data.description).slice(0, 4096);
    if (Number.isInteger(data.color))
        e.color = data.color;
    else
        e.color = ui.THEME;
    if (data.footer)
        e.footer = { text: String(data.footer).slice(0, 2048) };
    if (data.image)
        e.image = { url: data.image };
    if (!e.title && !e.description)
        e.description = '\u200b';
    return e;
}
function previewEmbed(data = {}) {
    const hasContent = data.title || data.description;
    return EmbedBuilder.from(hasContent ? embedJSON(data) : { title: 'Live preview', description: '*Press **Write Embed** to design your sticky message.*', color: ui.THEME });
}
const queues = new Map();
const lastNotice = new Map();
async function repost(client, channelId) {
    const row = db.getSticky(channelId);
    if (!row || !row.enabled)
        return { skipped: true };
    let channel = client.channels.cache.get(channelId);
    if (!channel) {
        try {
            channel = await client.channels.fetch(channelId);
        }
        catch (e) {
            if (e?.code === 10003) {
                db.deleteSticky(channelId);
                console.warn(`[Sticky] channel ${channelId} was deleted — sticky removed.`);
                return { removed: true };
            }
            throw new Error(`I can no longer access <#${channelId}> (${e?.message || 'unknown error'}).`);
        }
    }
    const missing = h.missingChannelPerms(channel, channel.guild?.members?.me, REQUIRED_PERMS);
    if (missing.length)
        throw new Error(`I'm missing **${missing.join(', ')}** in ${channel}.`);
    if (row.lastMessageId) {
        await client.rest.delete(Routes.channelMessage(channelId, row.lastMessageId)).catch(e => {
            if (e?.code !== 10008)
                console.warn(`[Sticky] could not delete old sticky in ${channelId}: ${e?.message || e}`);
        });
    }
    const sent = await client.rest.post(Routes.channelMessages(channelId), { body: { embeds: [embedJSON(row.data)] } });
    db.setStickyMessageId(channelId, sent.id);
    return { messageId: sent.id };
}
function scheduleRepost(client, channelId) {
    let q = queues.get(channelId);
    if (!q) {
        q = { timer: null, running: false, dirty: false, first: 0 };
        queues.set(channelId, q);
    }
    if (q.running) {
        q.dirty = true;
        return;
    }
    if (!q.first)
        q.first = Date.now();
    clearTimeout(q.timer);
    const wait = Math.min(DEBOUNCE_MS, Math.max(0, MAX_WAIT_MS - (Date.now() - q.first)));
    q.timer = setTimeout(() => runQueue(client, channelId, q), wait);
    q.timer.unref?.();
}
async function runQueue(client, channelId, q) {
    q.running = true;
    q.first = 0;
    try {
        do {
            q.dirty = false;
            try {
                await repost(client, channelId);
            }
            catch (e) {
                await notifyFailure(client, channelId, e);
            }
        } while (q.dirty);
    }
    finally {
        q.running = false;
        if (!q.dirty)
            queues.delete(channelId);
    }
}
async function notifyFailure(client, channelId, error) {
    console.error(`[Sticky] repost failed in ${channelId}:`, error?.message || error);
    const row = db.getSticky(channelId);
    if (!row || Date.now() - (lastNotice.get(channelId) || 0) < 3600000)
        return;
    lastNotice.set(channelId, Date.now());
    const logId = db.getConfig(row.guildId).logs?.server || db.getConfig(row.guildId).logs?.mod;
    const log = logId ? client.channels.cache.get(logId) : null;
    if (log?.isTextBased())
        log.send({ embeds: [h.errorEmbed('Sticky message could not be reposted', `${String(error?.message || error).slice(0, 900)}\n**Channel:** <#${channelId}>`)] }).catch(() => { });
}
function attach(client) {
    client.on('messageCreate', message => {
        try {
            if (!message.guild || message.author?.bot || message.system)
                return;
            const row = db.getSticky(message.channelId);
            if (row?.enabled)
                scheduleRepost(client, message.channelId);
        }
        catch (e) {
            console.error('[Sticky] messageCreate hook failed:', e);
        }
    });
    client.on('channelDelete', channel => {
        try {
            if (db.deleteSticky(channel.id))
                console.log(`[Sticky] removed sticky for deleted channel ${channel.id}`);
        }
        catch (e) {
            console.error('[Sticky] channelDelete hook failed:', e);
        }
    });
}
function panelPayload(guildId, userId, guild) {
    const draft = drafts.get(draftKey(guildId, userId)) || { channelId: null, data: {}, existed: false };
    const d = draft.data || {};
    const existing = draft.channelId ? db.getSticky(draft.channelId) : null;
    const ready = !!(draft.channelId && (d.title || d.description));
    const embed = ui.base(`${h.THEME.emoji.settings()} Sticky Message`).setDescription('Pick a channel, write the embed, check the preview, then **Save**. The sticky is re-posted after every member message so it stays the last message.').addFields({ name: 'Channel', value: draft.channelId ? `<#${draft.channelId}>` : 'Not selected', inline: true }, { name: 'Mode', value: draft.existed ? 'Editing existing' : (existing ? 'Will replace existing' : 'New sticky'), inline: true }, { name: 'Ready to save', value: ready ? 'Yes' : 'Needs channel + title/description', inline: true });
    const select = new ChannelSelectMenuBuilder().setCustomId(`stk:channel:${userId}`).setPlaceholder(draft.channelId ? 'Change channel…' : 'Select the sticky channel…').setChannelTypes(...TEXT_CHANNELS);
    if (draft.channelId)
        select.setDefaultChannels(draft.channelId);
    return {
        embeds: [embed, previewEmbed(d)],
        components: [
            new ActionRowBuilder().addComponents(select),
            new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`stk:write:${userId}`).setLabel('Write Embed').setStyle(ButtonStyle.Primary).setEmoji(h.THEME.emoji.edit), new ButtonBuilder().setCustomId(`stk:save:${userId}`).setLabel('Save').setStyle(ButtonStyle.Success).setEmoji(h.THEME.emoji.ok()).setDisabled(!ready), new ButtonBuilder().setCustomId(`stk:cancel:${userId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger))
        ]
    };
}
function writeModal(userId, data = {}) {
    const input = (id, label, style, required, max, value, placeholder) => {
        const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max);
        if (placeholder)
            t.setPlaceholder(placeholder);
        if (value !== undefined && value !== null && value !== '')
            t.setValue(String(value).slice(0, max));
        return new ActionRowBuilder().addComponents(t);
    };
    return new ModalBuilder().setCustomId(`stk:modal:${userId}`).setTitle('Sticky Message Embed').addComponents(input('title', 'Title (optional)', TextInputStyle.Short, false, 256, data.title), input('description', 'Description', TextInputStyle.Paragraph, true, 4000, data.description), input('color', 'Color hex (optional)', TextInputStyle.Short, false, 7, Number.isInteger(data.color) ? '#' + data.color.toString(16).padStart(6, '0') : '', '#5865F2'), input('footer', 'Footer (optional)', TextInputStyle.Short, false, 200, data.footer), input('image', 'Image URL (optional)', TextInputStyle.Short, false, 500, data.image, 'https://…'));
}
async function saveFromDraft(interaction, draft) {
    const channel = interaction.guild.channels.cache.get(draft.channelId) || await interaction.guild.channels.fetch(draft.channelId).catch(() => null);
    if (!channel)
        throw new Error('That channel no longer exists. Pick another channel.');
    const missing = h.missingChannelPerms(channel, interaction.guild.members.me, REQUIRED_PERMS);
    if (missing.length)
        throw new Error(`I'm missing **${missing.join(', ')}** in ${channel}. Grant those permissions and press Save again.`);
    const prev = db.getSticky(draft.channelId);
    db.saveSticky(interaction.guildId, draft.channelId, { data: draft.data, enabled: true, createdBy: interaction.user.id });
    try {
        await repost(interaction.client, draft.channelId);
    }
    catch (e) {
        if (prev)
            db.saveSticky(interaction.guildId, draft.channelId, { data: prev.data, enabled: prev.enabled, createdBy: prev.createdBy });
        else
            db.deleteSticky(draft.channelId);
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
const command = {
    data: new SlashCommandBuilder().setName('stickymessage').setDescription('Keep an embed pinned as the last message in a channel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addStringOption(o => o.setName('action').setDescription('What to do (default: open the setup panel)')
        .addChoices({ name: 'panel — create or replace a sticky', value: 'panel' }, { name: 'edit — edit a channel\'s sticky', value: 'edit' }, { name: 'view — show a channel\'s sticky', value: 'view' }, { name: 'list — all stickies in this server', value: 'list' }, { name: 'toggle — turn a channel\'s sticky on/off', value: 'toggle' }, { name: 'remove — delete a channel\'s sticky', value: 'remove' }))
        .addChannelOption(o => o.setName('channel').setDescription('Target channel (default: this channel)').addChannelTypes(...TEXT_CHANNELS)),
    async execute(interaction) {
        if (!interaction.guild)
            return h.safeReply(interaction, { embeds: [h.errorEmbed('Server only', 'Sticky messages only work inside a server.')], ephemeral: true });
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
        const row = db.getSticky(channel.id);
        if (!row)
            return h.safeReply(interaction, { embeds: [h.errorEmbed('No sticky here', `${channel} has no sticky message. Use \`/stickymessage\` to create one.`)], ephemeral: true });
        if (action === 'view') {
            const info = ui.base(`${h.THEME.emoji.list} Sticky in #${channel.name}`).setDescription(describeRow(row, guild))
                .addFields({ name: 'Status', value: row.enabled ? 'Enabled' : 'Disabled', inline: true }, { name: 'Updated', value: `<t:${Math.floor(row.updatedAt / 1000)}:R>`, inline: true });
            return h.safeReply(interaction, { embeds: [info, previewEmbed(row.data)], ephemeral: true });
        }
        if (action === 'toggle') {
            const next = !row.enabled;
            db.setStickyEnabled(channel.id, next);
            if (next) {
                try {
                    await repost(interaction.client, channel.id);
                }
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
            h.watchPanel(interaction, sent, render, 30000);
        }
    }
};
async function handleInteraction(interaction) {
    const id = interaction.customId;
    if (!id || !id.startsWith('stk:'))
        return false;
    const parts = id.split(':');
    const action = parts[1];
    try {
        if (action === 'rm') {
            const [, , userId, channelId, choice] = parts;
            if (!await h.authorOnly(interaction, userId))
                return true;
            if (choice !== 'yes')
                return void await interaction.update({ embeds: [h.infoEmbed('Cancelled', 'The sticky message was kept.')], components: [] });
            const row = db.getSticky(channelId);
            if (row?.lastMessageId)
                await interaction.client.rest.delete(Routes.channelMessage(channelId, row.lastMessageId)).catch(() => { });
            const removed = db.deleteSticky(channelId);
            return void await interaction.update({ embeds: [removed ? h.successEmbed('Sticky removed', `The sticky in <#${channelId}> was deleted.`) : h.errorEmbed('Nothing to remove', 'That sticky no longer exists.')], components: [] });
        }
        const userId = parts[2];
        if (!await h.authorOnly(interaction, userId))
            return true;
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
        if (action === 'write' && interaction.isButton())
            return void await interaction.showModal(writeModal(userId, draft.data));
        if (action === 'cancel') {
            drafts.delete(key);
            return void await interaction.update({ embeds: [h.infoEmbed('Cancelled', 'No sticky message was changed.')], components: [] });
        }
        if (action === 'modal' && interaction.isModalSubmit()) {
            const get = name => interaction.fields.getTextInputValue(name).trim();
            const colorRaw = get('color');
            const image = get('image');
            const color = colorRaw ? h.parseHexColor(colorRaw) : null;
            const problems = [];
            if (colorRaw && color === null)
                problems.push('Color must be a hex code like `#5865F2`.');
            if (image && !h.isHttpUrl(image))
                problems.push('Image must be a valid `https://` link.');
            if (!get('description'))
                problems.push('Description cannot be empty.');
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
            }
            catch (e) {
                console.error('[Sticky] save failed:', e);
                return void await interaction.followUp({ embeds: [h.errorEmbed('Could not save sticky', String(e.message || e).slice(0, 1500))], ephemeral: true });
            }
        }
    }
    catch (e) {
        console.error('[Sticky] interaction failed:', e);
        await h.safeReply(interaction, { embeds: [h.errorEmbed('Sticky message error', String(e.message || e).slice(0, 1500))], ephemeral: true });
    }
    return true;
}
module.exports = { command, commands: [command], attach, handleInteraction, repost, scheduleRepost, _internals: { embedJSON, queues } };

};
__modules["systems.js"] = function(module, exports, require, __filename, __dirname) {
const { PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, StreamType, entersState, getVoiceConnection, generateDependencyReport } = require('@discordjs/voice');
const googleTTS = require('google-tts-api');
const db = require('./database');
const ui = require('./ui');
const { Readable } = require('stream');
try {
    const ffmpegPath = require('ffmpeg-static');
    if (ffmpegPath) {
        process.env.FFMPEG_BIN = ffmpegPath;
        process.env.FFMPEG_PATH = ffmpegPath;
        const ffmpegDir = path.dirname(ffmpegPath);
        process.env.PATH = `${ffmpegDir}${path.delimiter}${process.env.PATH || ''}`;
    }
}
catch (e) {
    console.warn('[AunXz] ffmpeg-static could not be loaded:', e.message);
}
const persistentConnections = new Map();
async function joinAndStayInVC(voiceChannel) {
    let connection = getVoiceConnection(voiceChannel.guild.id);
    if (connection && connection.joinConfig?.channelId !== voiceChannel.id) {
        try {
            connection.destroy();
        }
        catch { }
        persistentConnections.delete(voiceChannel.guild.id);
        connection = null;
    }
    if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
        connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });
        persistentConnections.set(voiceChannel.guild.id, connection);
        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 5000)
                ]);
            }
            catch {
                const freshChannel = voiceChannel.guild.channels.cache.get(voiceChannel.id);
                if (freshChannel) {
                    try {
                        connection.destroy();
                    }
                    catch { }
                    persistentConnections.delete(voiceChannel.guild.id);
                    setTimeout(() => joinAndStayInVC(freshChannel).catch(() => { }), 1000);
                }
            }
        });
    }
    await entersState(connection, VoiceConnectionStatus.Ready, 15000);
    return connection;
}
async function ensureBotInVC(guild, vcId) {
    const channel = guild.channels.cache.get(vcId) || await guild.channels.fetch(vcId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildVoice)
        throw new Error('That is not a voice channel.');
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const perms = me?.permissionsIn(channel);
    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.Connect))
        throw new Error(`I need **View Channel** and **Connect** in ${channel}.`);
    const existing = getVoiceConnection(guild.id);
    const already = me?.voice?.channelId === channel.id && existing && existing.state.status !== VoiceConnectionStatus.Destroyed;
    if (already)
        return { joined: false, channel };
    await joinAndStayInVC(channel);
    return { joined: true, channel };
}
function downloadAudio(url) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const req = https.get(url, { headers: { 'User-Agent': 'AunXz/1.0' } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return downloadAudio(res.headers.location).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`TTS HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.setTimeout(15000, () => req.destroy(new Error('TTS request timed out')));
        req.on('error', reject);
    });
}
function binaryDownload(url, label = 'audio') {
    return new Promise((resolve, reject) => {
        const client = String(url).startsWith('http://') ? require('http') : require('https');
        const request = client.get(url, { headers: { 'User-Agent': 'AunXz/1.0' } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return binaryDownload(res.headers.location, label).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`${label} download failed with HTTP ${res.statusCode}.`));
            }
            const chunks = [];
            let size = 0;
            res.on('data', chunk => {
                size += chunk.length;
                if (size > 25 * 1024 * 1024) {
                    request.destroy(new Error(`${label} is larger than 25 MB.`));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        request.setTimeout(20000, () => request.destroy(new Error(`${label} download timed out.`)));
        request.on('error', reject);
    });
}
async function playAudioInput(guild, vcId, input, label = 'audio') {
    if (!guild || !vcId)
        throw new Error('Choose a Greet Voice channel before testing playback.');
    const channel = guild.channels.cache.get(vcId) || await guild.channels.fetch(vcId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildVoice)
        throw new Error('The configured Greet Voice channel was not found or is not a voice channel.');
    if (typeof input === 'string' && !fs.existsSync(input))
        throw new Error(`${label} file is missing on disk. Upload it again from Greet Voice setup.`);
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me?.permissionsIn(channel).has(PermissionFlagsBits.Connect)) {
        throw new Error(`I cannot **Connect** to ${channel}.`);
    }
    if (!me.permissionsIn(channel).has(PermissionFlagsBits.Speak)) {
        throw new Error(`I cannot **Speak** in ${channel}.`);
    }
    const connection = await joinAndStayInVC(channel);
    const player = createAudioPlayer({ behaviors: { noSubscriber: 'stop' } });
    const subscription = connection.subscribe(player);
    if (!subscription)
        throw new Error('The bot could not subscribe its audio player to the voice connection.');
    const resource = createAudioResource(input, {
        inputType: StreamType.Arbitrary,
        silencePaddingFrames: 5
    });
    await new Promise((resolve, reject) => {
        let settled = false;
        const finish = err => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            try {
                player.stop(true);
            }
            catch { }
            err ? reject(err) : resolve();
        };
        const timer = setTimeout(() => finish(new Error(`${label} playback timed out after 3 minutes.`)), 180000);
        player.once(AudioPlayerStatus.Idle, () => setTimeout(() => finish(), 600));
        player.once('error', err => finish(new Error(`Voice audio playback failed: ${err.message || err}`)));
        try {
            player.play(resource);
        }
        catch (e) {
            finish(e);
        }
    }).catch(err => {
        let dependency = '';
        try {
            dependency = generateDependencyReport();
        }
        catch { }
        if (dependency)
            console.error('[AunXz] Voice dependency report:\n' + dependency);
        throw err;
    });
}
const TTS_VOICES = {
    us: { label: 'US English', description: 'Standard American voice', lang: 'en', host: 'https://translate.google.com' },
    uk: { label: 'British English', description: 'UK accent', lang: 'en-GB', host: 'https://translate.google.co.uk' },
    au: { label: 'Australian English', description: 'Australian accent', lang: 'en-AU', host: 'https://translate.google.com.au' },
    in: { label: 'Indian English', description: 'Indian accent', lang: 'en-IN', host: 'https://translate.google.co.in' },
    slow: { label: 'US English (slow)', description: 'Slower, clearer reading', lang: 'en', host: 'https://translate.google.com', slow: true },
    deep: { label: 'Deep voice', description: 'Lower pitch', lang: 'en', host: 'https://translate.google.com', filter: 'asetrate=24000*0.78,aresample=48000,atempo=1.28' },
    high: { label: 'High voice', description: 'Higher pitch', lang: 'en', host: 'https://translate.google.com', filter: 'asetrate=24000*1.3,aresample=48000,atempo=0.77' },
    robot: { label: 'Robot', description: 'Metallic robot effect', lang: 'en', host: 'https://translate.google.com', filter: 'asetrate=24000*0.92,aresample=48000,atempo=1.087,tremolo=f=45:d=0.7,aecho=0.8:0.88:12:0.5' },
    es: { label: 'Spanish', description: 'Español', lang: 'es', host: 'https://translate.google.com' },
    fr: { label: 'French', description: 'Français', lang: 'fr', host: 'https://translate.google.com' },
    de: { label: 'German', description: 'Deutsch', lang: 'de', host: 'https://translate.google.com' },
    hi: { label: 'Hindi', description: 'हिन्दी', lang: 'hi', host: 'https://translate.google.com' },
    ar: { label: 'Arabic', description: 'العربية', lang: 'ar', host: 'https://translate.google.com' }
};
const TTS_MAX_CHARS = 1000;
function applyVoiceFilter(buffer, filter) {
    return new Promise(resolve => {
        try {
            const { spawn } = require('child_process');
            const bin = process.env.FFMPEG_PATH || 'ffmpeg';
            const ff = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-af', filter, '-f', 'mp3', 'pipe:1']);
            const out = [];
            let failed = false;
            ff.stdout.on('data', c => out.push(c));
            ff.on('error', () => { failed = true; resolve(buffer); });
            ff.on('close', code => { if (failed)
                return; const b = Buffer.concat(out); resolve(code === 0 && b.length ? b : buffer); });
            ff.stdin.on('error', () => { });
            ff.stdin.end(buffer);
        }
        catch {
            resolve(buffer);
        }
    });
}
async function buildTTSBuffer(prompt, voiceKey = 'us') {
    const text = String(prompt || 'Welcome!').replace(/\s+/g, ' ').trim().slice(0, TTS_MAX_CHARS) || 'Welcome!';
    const voice = TTS_VOICES[voiceKey] || TTS_VOICES.us;
    const parts = googleTTS.getAllAudioUrls(text, { lang: voice.lang, slow: !!voice.slow, host: voice.host, splitPunct: ',.?!;:\n' });
    const buffers = [];
    for (const part of parts) {
        const b = await binaryDownload(part.url, 'TTS audio');
        if (b.length)
            buffers.push(b);
    }
    if (!buffers.length)
        throw new Error('TTS returned an empty audio file.');
    let out = Buffer.concat(buffers);
    if (voice.filter)
        out = await applyVoiceFilter(out, voice.filter);
    return out;
}
async function playTTSInChannel(guild, vcId, prompt, voiceKey = 'us') {
    const buffer = await buildTTSBuffer(prompt, voiceKey);
    return playAudioInput(guild, vcId, Readable.from(buffer), 'TTS');
}
async function saveGreetvoiceAudio(guildId, attachment) {
    if (!/^\d{15,25}$/.test(String(guildId || '')))
        throw new Error('A valid server ID is required to save this audio file.');
    if (!attachment?.url)
        throw new Error('No audio attachment was provided. Try uploading the file again.');
    const name = String(attachment.name || attachment.filename || '').toLowerCase();
    const type = String(attachment.contentType || '').toLowerCase();
    const audioByType = type.startsWith('audio/');
    const audioByExt = /\.(mp3|wav|ogg|oga|opus|webm|m4a|aac|flac)$/i.test(name);
    if (!audioByType && !audioByExt)
        throw new Error('Please upload an audio file such as MP3, WAV, OGG, M4A, AAC, or FLAC.');
    const dataDir = typeof db.DATA_DIR === 'string' && db.DATA_DIR.trim() ? db.DATA_DIR : path.dirname(db.DB_PATH);
    if (!dataDir)
        throw new Error('Audio storage is not configured. Check DATABASE_PATH or RAILWAY_VOLUME_MOUNT_PATH.');
    const dir = path.join(path.resolve(dataDir), 'greetvoice');
    await fs.promises.mkdir(dir, { recursive: true });
    const extMatch = name.match(/\.[a-z0-9]+$/i);
    const ext = extMatch ? extMatch[0].toLowerCase() : '.audio';
    const target = path.join(dir, `${guildId}${ext}`);
    const buffer = await binaryDownload(attachment.url, 'Greet Voice audio');
    if (!buffer?.length)
        throw new Error('Discord returned an empty audio file. Upload it again.');
    await fs.promises.writeFile(target, buffer);
    return target;
}
async function removeGreetvoiceAudio(audioPath) {
    if (!audioPath)
        return;
    const resolved = path.resolve(audioPath);
    const dataDir = typeof db.DATA_DIR === 'string' && db.DATA_DIR.trim() ? db.DATA_DIR : path.dirname(db.DB_PATH || __dirname);
    const root = path.resolve(path.join(dataDir, 'greetvoice'));
    if (!resolved.startsWith(root + path.sep))
        return;
    await fs.promises.unlink(resolved).catch(() => { });
}
async function playGreetvoiceGreeting(guild, cfg) {
    if (!cfg?.vcId)
        throw new Error('Select a greeting voice channel in Greet Voice setup first.');
    if (cfg.mode === 'audio') {
        if (!cfg.audioPath)
            throw new Error('Audio mode is selected but no audio file is saved. Upload an audio greeting or set a TTS message.');
        return playAudioInput(guild, cfg.vcId, cfg.audioPath, 'Greet Voice audio');
    }
    if (cfg.ttsPrompt && String(cfg.ttsPrompt).trim())
        return playTTSInChannel(guild, cfg.vcId, cfg.ttsPrompt, cfg.ttsVoice || 'us');
    if (cfg.audioPath)
        return playAudioInput(guild, cfg.vcId, cfg.audioPath, 'Greet Voice audio');
    throw new Error('Set a TTS message or upload an audio file in Greet Voice setup.');
}
const nukeWindows = new Map();
async function getLogChannel(guild, key) {
    const cfg = db.getConfig(guild.id);
    const id = cfg.logs[key] || cfg.logs.antinuke;
    if (!id)
        return null;
    const ch = guild.channels.cache.get(id);
    return ch && ch.isTextBased() ? ch : null;
}
async function findAuditExecutor(guild, actionType, targetId) {
    try {
        const logs = await guild.fetchAuditLogs({ type: actionType, limit: 5 });
        const entry = logs.entries.find(e => Date.now() - e.createdTimestamp < 10_000 &&
            (!targetId || e.target?.id === targetId));
        return entry ? entry.executor : null;
    }
    catch {
        return null;
    }
}
async function antinukeStrike(guild, executor, actionLabel) {
    const cfg = db.getConfig(guild.id).antinuke;
    if (!cfg.enabled || !executor)
        return false;
    if (executor.id === guild.client.user.id)
        return false;
    if (executor.id === guild.ownerId && cfg.protectOwner)
        return false;
    if (db.isWhitelisted(guild.id, executor.id))
        return false;
    const limitMap = {
        channelDelete: cfg.maxChannelDeletes, channelCreate: cfg.maxChannelCreates,
        roleDelete: cfg.maxRoleDeletes, roleCreate: cfg.maxRoleCreates,
        ban: cfg.maxBans, kick: cfg.maxKicks,
        webhookCreate: cfg.maxWebhookCreates, roleUpdate: cfg.maxRoleUpdates
    };
    const limit = limitMap[actionLabel] ?? 3;
    const key = `${guild.id}:${executor.id}:${actionLabel}`;
    const now = Date.now();
    const w = nukeWindows.get(key);
    let count;
    if (!w || now - w.start > cfg.windowSeconds * 1000) {
        count = 1;
        nukeWindows.set(key, { start: now, count });
    }
    else {
        count = w.count + 1;
        w.count = count;
    }
    if (count < limit)
        return false;
    nukeWindows.delete(key);
    const member = await guild.members.fetch(executor.id).catch(() => null);
    let action = 'none';
    try {
        if (member) {
            if (cfg.punishment === 'ban') {
                await member.ban({ reason: `Antinuke: ${actionLabel} flood` });
                action = 'banned';
            }
            else if (cfg.punishment === 'kick') {
                await member.kick(`Antinuke: ${actionLabel} flood`);
                action = 'kicked';
            }
            else {
                await member.roles.set([], `Antinuke: ${actionLabel} flood`);
                action = 'stripped roles from';
            }
        }
    }
    catch (e) {
        action = `failed to punish (${e.message})`;
    }
    db.logAction(guild.id, executor.id, 'antinuke', `${actionLabel} flood → ${action}`);
    const log = await getLogChannel(guild, 'antinuke');
    if (log) {
        const embed = ui.errorEmbed('🛡️ Antinuke Triggered', `**User:** ${executor.tag} (${executor.id})\n**Trigger:** ${actionLabel} flood (${count}/${limit})\n**Action taken:** ${action}`);
        log.send({ embeds: [embed] }).catch(() => { });
    }
    return true;
}
async function handleAntiraidJoin(member) {
    const cfg = db.getConfig(member.guild.id).antiraid;
    if (!cfg.enabled)
        return;
    db.trackJoin(member.guild.id, member.id);
    const accountAgeDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
    if (accountAgeDays < cfg.minAccountAgeDays) {
        await member.kick('Antiraid: account too new').catch(() => { });
        db.logAction(member.guild.id, member.id, 'antiraid', `kicked (account age ${accountAgeDays.toFixed(1)}d)`);
        return;
    }
    const joins = db.recentJoinCount(member.guild.id, cfg.windowSeconds);
    if (joins >= cfg.joinThreshold) {
        db.logAction(member.guild.id, member.id, 'antiraid', `raid detected: ${joins} joins/${cfg.windowSeconds}s`);
        const log = await getLogChannel(member.guild, 'antinuke');
        if (log)
            log.send({ embeds: [ui.errorEmbed('🚨 Raid Detected', `${joins} joins in ${cfg.windowSeconds}s. Action: **${cfg.action}**`)] }).catch(() => { });
        if (cfg.action === 'lockdown') {
            const everyone = member.guild.roles.everyone;
            const textChannels = member.guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
            for (const [, ch] of textChannels) {
                await ch.permissionOverwrites.edit(everyone, { SendMessages: false }).catch(() => { });
            }
        }
        else if (cfg.action === 'kick_new') {
            await member.kick('Antiraid lockdown').catch(() => { });
        }
    }
}
const LINK_REGEX = /(https?:\/\/[^\s]+|discord\.gg\/[^\s]+)/gi;
async function handleAntilink(message) {
    const cfg = db.getConfig(message.guild.id).antilink;
    if (!cfg.enabled)
        return;
    if (cfg.whitelistedChannels.includes(message.channel.id))
        return;
    if (cfg.bypassRoleId && message.member.roles.cache.has(cfg.bypassRoleId))
        return;
    if (message.member.permissions.has(PermissionFlagsBits.Administrator))
        return;
    const links = message.content.match(LINK_REGEX);
    if (!links)
        return;
    const allowed = links.every(l => cfg.whitelistedDomains.some(d => l.includes(d)));
    if (allowed)
        return;
    await message.delete().catch(() => { });
    db.logAction(message.guild.id, message.author.id, 'antilink', `posted: ${links[0]}`);
    if (cfg.mode === 'warn' || cfg.mode === 'mute') {
        const warnMsg = await message.channel.send({ embeds: [ui.warnEmbed('🔗 Link Blocked', `${message.author}, links aren't allowed here.`)] });
        setTimeout(() => warnMsg.delete().catch(() => { }), 6000);
    }
    if (cfg.mode === 'mute') {
        const member = message.member;
        await member.timeout(5 * 60_000, 'Antilink violation').catch(() => { });
    }
    const log = await getLogChannel(message.guild, 'message');
    if (log)
        log.send({ embeds: [ui.errorEmbed('🔗 Antilink', `${message.author} posted a link in ${message.channel} — removed.`)] }).catch(() => { });
}
async function handleAntispam(message) {
    const cfg = db.getConfig(message.guild.id).antispam;
    if (!cfg.enabled)
        return;
    if (message.member.permissions.has(PermissionFlagsBits.Administrator))
        return;
    let punish = false;
    const msgCount = db.bumpSpam(message.guild.id, message.author.id, cfg.windowSeconds);
    if (msgCount > cfg.maxMessages)
        punish = true;
    const mentionCount = message.mentions.users.size + message.mentions.roles.size;
    if (mentionCount > cfg.maxMentions)
        punish = true;
    const emojiCount = (message.content.match(/<a?:\w+:\d+>|\p{Emoji_Presentation}/gu) || []).length;
    if (emojiCount > cfg.maxEmojis)
        punish = true;
    if (!punish)
        return;
    db.logAction(message.guild.id, message.author.id, 'antispam', `flood (msgs:${msgCount} mentions:${mentionCount} emojis:${emojiCount})`);
    const member = message.member;
    if (cfg.punishment === 'mute') {
        await member.timeout(cfg.muteMinutes * 60_000, 'Antispam violation').catch(() => { });
    }
    else if (cfg.punishment === 'kick') {
        await member.kick('Antispam violation').catch(() => { });
    }
    else if (cfg.punishment === 'ban') {
        await member.ban({ reason: 'Antispam violation' }).catch(() => { });
    }
    const notice = await message.channel.send({ embeds: [ui.errorEmbed('🚫 Spam Detected', `${message.author} was ${cfg.punishment}d for spamming.`)] });
    setTimeout(() => notice.delete().catch(() => { }), 8000);
    const log = await getLogChannel(message.guild, 'message');
    if (log)
        log.send({ embeds: [ui.errorEmbed('🚫 Antispam', `${message.author} triggered antispam in ${message.channel}.`)] }).catch(() => { });
}
async function lockRoleToSingleChannel(guild, role, allowedChannelId) {
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me?.permissions.has(PermissionFlagsBits.ManageRoles) && !me?.permissions.has(PermissionFlagsBits.Administrator)) {
        throw new Error('I need **Manage Roles** to configure the Greet Voice gate role.');
    }
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels) && !me.permissions.has(PermissionFlagsBits.Administrator)) {
        throw new Error('I need **Manage Channels** to change the gate role\'s channel permissions.');
    }
    if (role.id === guild.id)
        throw new Error('@everyone cannot be the Greet Voice role.');
    if (role.position >= me.roles.highest.position) {
        throw new Error(`I cannot manage **${role.name}** because it is equal to or higher than my highest role.`);
    }
    await guild.channels.fetch().catch(() => { });
    const report = { hidden: 0, alreadyHidden: 0, allowed: false, failed: [], adminBypass: role.permissions.has(PermissionFlagsBits.Administrator) };
    const reason = 'Greet Voice: gate role may only see the greeting VC';
    for (const [, channel] of guild.channels.cache) {
        if (!channel.permissionOverwrites || channel.isThread?.())
            continue;
        const own = channel.permissionOverwrites.cache.get(role.id);
        try {
            if (channel.id === allowedChannelId) {
                const ok = own?.allow.has(PermissionFlagsBits.ViewChannel) && own?.allow.has(PermissionFlagsBits.Connect);
                if (!ok)
                    await channel.permissionOverwrites.edit(role, { ViewChannel: true, Connect: true }, { reason });
                report.allowed = true;
                continue;
            }
            const canSee = channel.permissionsFor(role)?.has(PermissionFlagsBits.ViewChannel);
            const explicitAllow = own?.allow.has(PermissionFlagsBits.ViewChannel);
            const explicitDeny = own?.deny.has(PermissionFlagsBits.ViewChannel);
            if (explicitDeny && !explicitAllow) {
                report.alreadyHidden++;
                continue;
            }
            if (!canSee && !explicitAllow) {
                report.alreadyHidden++;
                continue;
            }
            await channel.permissionOverwrites.edit(role, { ViewChannel: false }, { reason });
            report.hidden++;
        }
        catch (e) {
            report.failed.push(`${channel.name}: ${e.message}`);
        }
    }
    return report;
}
async function onChannelCreateGreetvoiceSync(channel) {
    const cfg = db.getConfig(channel.guild.id).greetvoice;
    if (!cfg.enabled || !cfg.roleId)
        return;
    const role = channel.guild.roles.cache.get(cfg.roleId);
    if (!role)
        return;
    if (channel.id === cfg.vcId) {
        await channel.permissionOverwrites.edit(role, { ViewChannel: true, Connect: true }).catch(() => { });
    }
    else {
        await channel.permissionOverwrites.edit(role, { ViewChannel: false }).catch(() => { });
    }
}
async function onMemberJoinGreetvoice(member) {
    const cfg = db.getConfig(member.guild.id).greetvoice;
    if (!cfg.enabled || !cfg.roleId || !cfg.vcId)
        return;
    const role = member.guild.roles.cache.get(cfg.roleId);
    if (!role)
        return;
    const bot = member.guild.members.me;
    if (!bot?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= bot.roles.highest.position) {
        const log = await getLogChannel(member.guild, 'voice');
        if (log)
            log.send({ embeds: [ui.errorEmbed('🔊 Greet Voice Role Failed', `I cannot assign <@&${role.id}>. Give me **Manage Roles** and move my bot role above the gate role.`)] }).catch(() => { });
        return;
    }
    const added = await member.roles.add(role, 'greetvoice gate').then(() => true).catch(() => false);
    if (!added) {
        const log = await getLogChannel(member.guild, 'voice');
        if (log)
            log.send({ embeds: [ui.errorEmbed('🔊 Greet Voice Role Failed', `Discord rejected the role assignment for ${member}. Check my **Manage Roles** permission and role hierarchy.`)] }).catch(() => { });
    }
}
const greetCooldowns = new Map();
function logVoiceDependencies() { console.log('[GreetVoice] dependency report:\n' + generateDependencyReport()); }
async function onVoiceJoinGreetvoice(oldState, newState) {
    const guild = newState.guild;
    const cfg = db.getConfig(guild.id).greetvoice;
    if (newState.channelId === oldState.channelId)
        return;
    if (!cfg.vcId || newState.channelId !== cfg.vcId)
        return;
    const member = newState.member;
    if (!member || member.user.bot)
        return;
    console.log(`[GreetVoice] join event: ${member.user.tag} -> ${newState.channelId}`);
    if (!cfg.enabled) {
        console.log('[GreetVoice] skipped: feature is disabled');
        return;
    }
    const role = cfg.roleId ? guild.roles.cache.get(cfg.roleId) : null;
    if (cfg.roleId && (!role || !member.roles.cache.has(role.id))) {
        console.log('[GreetVoice] skipped: member does not hold the gate role');
        return;
    }
    const cdKey = `${guild.id}:${member.id}`;
    const cdMs = Math.max(0, Number(cfg.cooldownSeconds ?? 30)) * 1000;
    if (Date.now() - (greetCooldowns.get(cdKey) || 0) < cdMs) {
        console.log('[GreetVoice] skipped: per-user cooldown');
        return;
    }
    greetCooldowns.set(cdKey, Date.now());
    const live = await guild.members.fetch(member.id).catch(() => null);
    if (!live || live.voice.channelId !== cfg.vcId) {
        console.log('[GreetVoice] skipped: member left before the greeting');
        return;
    }
    let played = false;
    try {
        console.log('[GreetVoice] playing greeting');
        await playGreetvoiceGreeting(guild, cfg);
        played = true;
        console.log('[GreetVoice] playback finished');
    }
    catch (e) {
        console.error('[GreetVoice] playback failed:', e);
        const log = await getLogChannel(guild, 'voice');
        if (log) {
            log.send({ embeds: [ui.errorEmbed('🔇 Greetvoice TTS Failed', `Could not play the greeting for ${member}: \`${String(e.message || e).slice(0, 700)}\`.\n` +
                        'Check that the bot can **Connect** and **Speak** in the greeting VC and that FFmpeg + an Opus encoder are installed.')] }).catch(() => { });
        }
    }
    if (!played || !role)
        return;
    const freshMember = await guild.members.fetch(member.id).catch(() => null);
    if (freshMember && freshMember.voice.channelId === cfg.vcId) {
        await freshMember.voice.disconnect('greetvoice complete').catch(() => { });
    }
    await freshMember?.roles.remove(role, 'greetvoice complete').catch(() => { });
}
async function handleVoiceStateUpdate(oldState, newState) {
    await handleVoicemasterJoin(oldState, newState);
    await onVoiceJoinGreetvoice(oldState, newState);
}
function xpForLevel(level) { return 5 * (level ** 2) + 50 * level + 100; }
async function handleLevelingMessage(message) {
    const cfg = db.getConfig(message.guild.id).leveling;
    if (!cfg.enabled)
        return;
    const rec = db.getLevel(message.guild.id, message.author.id);
    const now = Date.now();
    if (now - rec.lastMessage < cfg.cooldownSeconds * 1000)
        return;
    let xp = rec.xp + cfg.xpPerMessage;
    let level = rec.level;
    let leveledUp = false;
    while (xp >= xpForLevel(level)) {
        xp -= xpForLevel(level);
        level += 1;
        leveledUp = true;
    }
    db.setLevel(message.guild.id, message.author.id, xp, level, now);
    if (leveledUp) {
        const text = cfg.levelUpMessage.replace('{user}', `${message.author}`).replace('{level}', level);
        const target = cfg.channel ? message.guild.channels.cache.get(cfg.channel) : message.channel;
        if (target?.isTextBased())
            target.send({ embeds: [ui.levelUpEmbed(text)] }).catch(() => { });
        const roleId = cfg.roleRewards[String(level)];
        if (roleId) {
            const role = message.guild.roles.cache.get(roleId);
            if (role)
                await message.member.roles.add(role, `Level ${level} reward`).catch(() => { });
        }
    }
}
// ───────────────────────── VoiceMaster ─────────────────────────
const vmCreating = new Set();
const VM_OWNER_ALLOW = ['ManageChannels', 'MoveMembers', 'Connect', 'ViewChannel'];
const vmOk = (title, text) => ({ ok: true, title, text });
const vmFail = (text, title = 'Cannot do that') => ({ ok: false, title, text });
function vmClean(text, fallback = '') {
    const t = String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 100);
    return t || fallback;
}
function vmApplyTemplate(template, member) {
    const display = member.displayName || member.user.username;
    return vmClean(String(template || "{user}'s room").replace(/\{user\}/gi, display).replace(/\{username\}/gi, member.user.username), `${display}'s room`);
}
function vmClampBitrate(guild, bps) { return Math.max(8000, Math.min(guild.maximumBitrate || 96000, Math.round(bps))); }
function vmEveryoneOverwrite(vc) { return vc.permissionOverwrites.cache.get(vc.guild.roles.everyone.id); }
function vmIsLocked(vc) { return !!vmEveryoneOverwrite(vc)?.deny.has(PermissionFlagsBits.Connect); }
function vmIsHidden(vc) { return !!vmEveryoneOverwrite(vc)?.deny.has(PermissionFlagsBits.ViewChannel); }
async function vmResolveInterface(guild, cfg) {
    if (!cfg.interfaceChannelId)
        return null;
    const ch = guild.channels.cache.get(cfg.interfaceChannelId) || await guild.channels.fetch(cfg.interfaceChannelId).catch(() => null);
    if (!ch || !ch.isTextBased() || ch.isVoiceBased())
        return null;
    return ch;
}
function vmMissingPerms(ch, guild) {
    const perms = ch.permissionsFor(guild.members.me);
    return [['ViewChannel', 'View Channel'], ['SendMessages', 'Send Messages'], ['EmbedLinks', 'Embed Links']]
        .filter(([flag]) => !perms?.has(PermissionFlagsBits[flag])).map(([, label]) => label);
}
async function vmRemoveInterfaceMessage(guild, vmCfg) {
    if (!vmCfg.interfaceChannelId || !vmCfg.interfaceMessageId)
        return;
    const ch = await vmResolveInterface(guild, vmCfg);
    const msg = ch ? await ch.messages.fetch(vmCfg.interfaceMessageId).catch(() => null) : null;
    if (msg?.deletable)
        await msg.delete().catch(() => { });
}
async function postVoiceInterface(guild) {
    const cfg = db.getConfig(guild.id).voicemaster;
    const ch = await vmResolveInterface(guild, cfg);
    if (!ch)
        return { ok: false, error: 'The interface channel is not set or no longer exists.' };
    const missing = vmMissingPerms(ch, guild);
    if (missing.length)
        return { ok: false, error: `I'm missing **${missing.join(', ')}** in ${ch}.` };
    await vmRemoveInterfaceMessage(guild, cfg);
    try {
        const msg = await ch.send({ embeds: [ui.vmControlEmbed(null)], components: ui.vmControlRows() });
        db.saveConfig(guild.id, { voicemaster: { interfaceMessageId: msg.id } });
        return { ok: true, channel: ch, message: msg };
    }
    catch (e) {
        return { ok: false, error: `Discord rejected the panel: ${String(e.message || e).slice(0, 200)}` };
    }
}
async function vmCleanupEmpty(guild, channelId) {
    if (!channelId || !db.getVMChannel(channelId))
        return;
    const ch = guild.channels.cache.get(channelId);
    if (!ch) {
        db.removeVMChannel(channelId);
        return;
    }
    if (ch.members.size > 0)
        return;
    try {
        await ch.delete('VoiceMaster: channel is empty');
        db.removeVMChannel(channelId);
    }
    catch (e) {
        if (e.code === 10003)
            db.removeVMChannel(channelId);
        else
            console.warn('[VoiceMaster] could not delete empty channel:', e.message);
    }
}
async function vmReportError(guild, text) {
    console.error('[VoiceMaster]', text);
    const log = await getLogChannel(guild, 'voice').catch(() => null);
    if (log)
        log.send({ embeds: [ui.errorEmbed('🎙️ VoiceMaster Problem', text.slice(0, 1500))] }).catch(() => { });
}
async function vmCreateRoom(guild, member, cfg) {
    const key = `${guild.id}:${member.id}`;
    if (vmCreating.has(key))
        return;
    vmCreating.add(key);
    try {
        for (const rec of db.getVMChannelsByOwner(guild.id, member.id)) {
            const existing = guild.channels.cache.get(rec.channelId);
            if (existing) {
                await member.voice.setChannel(existing, 'VoiceMaster: returning to your room').catch(() => { });
                return;
            }
            db.removeVMChannel(rec.channelId);
        }
        const hub = guild.channels.cache.get(cfg.hubChannelId);
        const parent = (cfg.categoryId && guild.channels.cache.get(cfg.categoryId)) ? cfg.categoryId : (hub?.parentId || null);
        const profile = cfg.profilesEnabled === false ? null : db.getVMProfile(guild.id, member.id);
        const name = vmClean(profile?.name, '') || vmApplyTemplate(cfg.nameTemplate, member);
        const limit = Math.max(0, Math.min(99, Number(profile?.userLimit ?? cfg.defaultLimit ?? 0) || 0));
        const bitrate = Number(profile?.bitrate || cfg.defaultBitrate || 0);
        const everyoneAllow = [], everyoneDeny = [];
        (profile?.hidden ? everyoneDeny : everyoneAllow).push(PermissionFlagsBits.ViewChannel);
        (profile?.locked ? everyoneDeny : everyoneAllow).push(PermissionFlagsBits.Connect);
        const options = {
            name, type: ChannelType.GuildVoice, parent, userLimit: limit,
            permissionOverwrites: [
                { id: guild.roles.everyone.id, allow: everyoneAllow, deny: everyoneDeny },
                { id: member.id, allow: VM_OWNER_ALLOW.map(f => PermissionFlagsBits[f]) }
            ],
            reason: `VoiceMaster room for ${member.user.tag}`
        };
        if (bitrate)
            options.bitrate = vmClampBitrate(guild, bitrate);
        if (profile?.region)
            options.rtcRegion = profile.region;
        const channel = await guild.channels.create(options);
        db.addVMChannel(channel.id, guild.id, member.id);
        const moved = await member.voice.setChannel(channel, 'VoiceMaster: new room').then(() => true).catch(() => false);
        if (!moved) {
            await vmCleanupEmpty(guild, channel.id);
            return;
        }
        const iface = await vmResolveInterface(guild, cfg);
        const sharedPanel = iface && vmMissingPerms(iface, guild).length === 0;
        if (!sharedPanel) {
            await channel.send({ embeds: [ui.vmControlEmbed(member)], components: ui.vmControlRows() })
                .catch(e => console.warn('[VoiceMaster] could not post the panel inside the room:', e.message));
        }
    }
    catch (e) {
        await vmReportError(guild, `Could not create a room for ${member.user.tag}: ${String(e.message || e)}\nThe bot needs **Manage Channels**, **Move Members** and **Connect** (in the hub + category).`);
    }
    finally {
        vmCreating.delete(key);
    }
}
async function handleVoicemasterJoin(oldState, newState) {
    const guild = newState.guild || oldState.guild;
    if (!guild)
        return;
    if (oldState.channelId && oldState.channelId !== newState.channelId)
        await vmCleanupEmpty(guild, oldState.channelId);
    const cfg = db.getConfig(guild.id).voicemaster;
    if (!cfg.enabled || !cfg.hubChannelId)
        return;
    if (newState.channelId !== cfg.hubChannelId || oldState.channelId === newState.channelId)
        return;
    const member = newState.member;
    if (!member || member.user.bot)
        return;
    await vmCreateRoom(guild, member, cfg);
}
function onVoicemasterChannelDelete(channel) {
    if (channel?.type === ChannelType.GuildVoice && db.getVMChannel(channel.id))
        db.removeVMChannel(channel.id);
}
async function vmSweep(client) {
    for (const rec of db.listVMChannels()) {
        const guild = client.guilds.cache.get(rec.guildId);
        if (guild)
            await vmCleanupEmpty(guild, rec.channelId).catch(() => { });
    }
    for (const guild of client.guilds.cache.values()) {
        const cfg = db.getConfig(guild.id).voicemaster;
        if (!cfg.enabled || !cfg.interfaceChannelId)
            continue;
        const ch = await vmResolveInterface(guild, cfg);
        if (!ch)
            continue;
        const msg = cfg.interfaceMessageId ? await ch.messages.fetch(cfg.interfaceMessageId).catch(() => null) : null;
        if (!msg)
            await postVoiceInterface(guild).catch(() => { });
    }
}
// ── operations (shared by the panel buttons and the /voice command) ──
function vmFind(member, needOwner = true) {
    const vc = member.voice?.channel;
    if (!vc)
        return { err: 'Join your temporary voice channel first.' };
    const record = db.getVMChannel(vc.id);
    if (!record)
        return { err: 'You are not inside a VoiceMaster channel.' };
    if (needOwner && record.ownerId !== member.id)
        return { err: `Only the channel owner (<@${record.ownerId}>) can do that.` };
    return { vc, record };
}
async function vmGuard(fn) {
    try {
        return await fn();
    }
    catch (e) {
        return vmFail(`Discord refused that: \`${String(e.message || e).slice(0, 160)}\`\nMake sure the bot has **Manage Channels** and **Move Members**.`, 'Action failed');
    }
}
async function vmSetOwner(vc, record, newMember) {
    db.addVMChannel(vc.id, vc.guild.id, newMember.id);
    await vc.permissionOverwrites.edit(newMember, Object.fromEntries(VM_OWNER_ALLOW.map(f => [f, true])));
    const old = vc.permissionOverwrites.cache.get(record.ownerId);
    if (old && record.ownerId !== newMember.id)
        await old.edit({ ManageChannels: null, MoveMembers: null }).catch(() => { });
}
async function vmMember(guild, userId) { return guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null); }
const vmOps = {
    lock: (member, want) => vmGuard(async () => {
        const f = vmFind(member);
        if (f.err)
            return vmFail(f.err);
        const locked = vmIsLocked(f.vc), next = want === undefined ? !locked : !!want;
        if (next === locked)
            return vmOk(next ? 'Already locked' : 'Already unlocked', next ? 'This channel is already locked.' : 'This channel is already open.');
        await f.vc.permissionOverwrites.edit(f.vc.guild.roles.everyone, { Connect: next ? false : null });
        return next ? vmOk('🔒 Locked', 'Only you and permitted members can join now.') : vmOk('🔓 Unlocked', 'Anyone who can see the channel can join again.');
    }),
    hide: (member, want) => vmGuard(async () => {
        const f = vmFind(member);
        if (f.err)
            return vmFail(f.err);
        const hidden = vmIsHidden(f.vc), next = want === undefined ? !hidden : !!want;
        if (next === hidden)
            return vmOk(next ? 'Already hidden' : 'Already visible', next ? 'This channel is already hidden.' : 'This channel is already visible.');
        await f.vc.permissionOverwrites.edit(f.vc.guild.roles.everyone, { ViewChannel: next ? false : null });
        return next ? vmOk('🙈 Hidden', 'Only you and permitted members can see the channel.') : vmOk('👁️ Visible', 'The channel is visible again.');
    }),
    rename: (member, rawName) => vmGuard(async () => {
        const f = vmFind(member);
        if (f.err)
            return vmFail(f.err);
        const name = vmClean(rawName);
        if (!name)
            return vmFail('Please give the channel a name.');
        const result = await Promise.race([f.vc.setName(name, 'VoiceMaster rename').then(() => 'done'), new Promise(r => setTimeout(() => r('slow'), 8000))]);
        return result === 'done' ? vmOk('✏️ Renamed', `Your channel is now **${name}**.`)
            : vmOk('✏️ Rename queued', `Discord only allows 2 renames per 10 minutes. **${name}** will apply as soon as the limit resets.`);
    }),
    limit: (member, raw) => vmGuard(async () => {
        const f = vmFind(member);
        if (f.err)
            return vmFail(f.err);
        const text = String(raw ?? '').trim();
        const n = Number(text);
        if (text === '' || !Number.isInteger(n) || n < 0 || n > 99)
            return vmFail('Enter a whole number from **0** (unlimited) to **99**.');
        await f.vc.setUserLimit(n, 'VoiceMaster limit');
        return vmOk('🔢 Limit Set', n ? `Up to **${n}** members can be in the channel.` : 'The channel has **no** user limit.');
    }),
    bitrate: (member, raw) => vmGuard(async () => {
        const f = vmFind(member);
        if (f.err)
            return vmFail(f.err);
        const kbpsText = String(raw ?? '').trim();
        const kbps = Number(kbpsText);
        const max = Math.floor((f.vc.guild.maximumBitrate || 96000) / 1000);
        if (kbpsText === '' || !Number.isFinite(kbps) || kbps < 8 || kbps > max)
            return vmFail(`Enter a bitrate from **8** to **${max}** kbps (your server's maximum).`);
        await f.vc.setBitrate(vmClampBitrate(f.vc.guild, kbps * 1000), 'VoiceMaster bitrate');
        return vmOk('📶 Bitrate Set', `Audio quality is now **${Math.round(kbps)} kbps**.`);
    }),
    permit: (member, userId) => vmGuard(async () => {
        const f = vmFind(member);
        if (f.err)
            return vmFail(f.err);
        const target = await vmMember(f.vc.guild, userId);
        if (!target)
            return vmFail("That user isn't in this server.");
        if (target.user.bot)
            return vmFail('Bots cannot be permitted.');
        await f.vc.permissionOverwrites.edit(target, { Connect: true, ViewChannel: true });
        return vmOk('✅ Permitted', `${target} can always see and join your channel, even while it is locked or hidden.`);
    }),
    reject: (member, userId) => vmGuard(async () => {
        const f = vmFind(member);
        if (f.err)
            return vmFail(f.err);
        if (userId === member.id)
            return vmFail("You can't reject yourself.");
        const target = await vmMember(f.vc.guild, userId);
        if (!target)
            return vmFail("That user isn't in this server.");
        if (target.id === f.vc.client.user.id)
            return vmFail("You can't reject the bot.");
        await f.vc.permissionOverwrites.edit(target, { Connect: false });
        if (target.voice?.channelId === f.vc.id)
            await target.voice.disconnect('Rejected by channel owner').catch(() => { });
        return vmOk('🚫 Rejected', `${target} can no longer join your channel. Use **Permit** to let them back in.`);
    }),
    kick: (member, userId) => vmGuard(async () => {
        const f = vmFind(member);
        if (f.err)
            return vmFail(f.err);
        if (userId === member.id)
            return vmFail("You can't kick yourself.");
        const target = f.vc.members.get(userId);
        if (!target)
            return vmFail("That member isn't in your channel anymore.", 'Already gone');
        await target.voice.disconnect('Removed by channel owner');
        return vmOk('👢 Member Removed', `**${target.user.tag}** was disconnected from the channel.`);
    }),
    claim: (member) => vmGuard(async () => {
        const f = vmFind(member, false);
        if (f.err)
            return vmFail(f.err);
        if (f.record.ownerId === member.id)
            return vmFail('You already own this channel.');
        if (f.vc.members.has(f.record.ownerId))
            return vmFail(`<@${f.record.ownerId}> is still in the channel — ask them to transfer ownership.`);
        await vmSetOwner(f.vc, f.record, member);
        return vmOk('🙋 Channel Claimed', 'You are now the owner of this channel.');
    }),
    transfer: (member, userId) => vmGuard(async () => {
        const f = vmFind(member);
        if (f.err)
            return vmFail(f.err);
        if (userId === member.id)
            return vmFail('You already own this channel.');
        const target = f.vc.members.get(userId);
        if (!target)
            return vmFail('The new owner must be inside your channel.');
        if (target.user.bot)
            return vmFail('Bots cannot own a channel.');
        await vmSetOwner(f.vc, f.record, target);
        return vmOk('🔁 Ownership Transferred', `${target} now owns this channel.`);
    }),
    region: (member, value) => vmGuard(async () => {
        const f = vmFind(member);
        if (f.err)
            return vmFail(f.err);
        const entry = ui.VM_REGIONS.find(([v]) => v === value);
        if (!entry)
            return vmFail('Unknown voice region.');
        await f.vc.setRTCRegion(value === 'auto' ? null : value, 'VoiceMaster region');
        return vmOk('🌍 Region Set', `Voice region is now **${entry[1]}**.`);
    }),
    reset: (member) => vmGuard(async () => {
        const f = vmFind(member);
        if (f.err)
            return vmFail(f.err);
        const cfg = db.getConfig(f.vc.guild.id).voicemaster;
        for (const ow of [...f.vc.permissionOverwrites.cache.values()]) {
            if (ow.type === 1 && ow.id !== member.id)
                await ow.delete('VoiceMaster reset').catch(() => { });
        }
        await f.vc.permissionOverwrites.edit(f.vc.guild.roles.everyone, { Connect: null, ViewChannel: null });
        await f.vc.setUserLimit(Math.max(0, Math.min(99, Number(cfg.defaultLimit) || 0)));
        await f.vc.setRTCRegion(null).catch(() => { });
        if (cfg.defaultBitrate)
            await f.vc.setBitrate(vmClampBitrate(f.vc.guild, cfg.defaultBitrate)).catch(() => { });
        return vmOk('↩️ Reset', 'Unlocked, unhidden, permit/reject lists cleared, limit and region back to the server defaults. The name was kept.');
    }),
    save: (member) => vmGuard(async () => {
        const f = vmFind(member);
        if (f.err)
            return vmFail(f.err);
        if (db.getConfig(f.vc.guild.id).voicemaster.profilesEnabled === false)
            return vmFail('Saved profiles are turned off on this server.');
        db.saveVMProfile(f.vc.guild.id, member.id, { name: f.vc.name, userLimit: f.vc.userLimit, bitrate: f.vc.bitrate, region: f.vc.rtcRegion, locked: vmIsLocked(f.vc), hidden: vmIsHidden(f.vc) });
        return vmOk('💾 Profile Saved', 'Your next room will start with this name, limit, bitrate, region and lock/hide state.');
    }),
    forget: (member) => vmGuard(async () => {
        const removed = db.deleteVMProfile(member.guild.id, member.id);
        return removed ? vmOk('🗑️ Profile Cleared', 'Your next room will use the server defaults.') : vmFail("You don't have a saved profile.");
    }),
    info: (member) => vmGuard(async () => {
        const f = vmFind(member, false);
        if (f.err)
            return vmFail(f.err);
        const ids = (allow) => [...f.vc.permissionOverwrites.cache.values()].filter(o => o.type === 1 && o.id !== f.record.ownerId && (allow ? o.allow.has(PermissionFlagsBits.Connect) : o.deny.has(PermissionFlagsBits.Connect))).map(o => o.id);
        return { ok: true, embed: ui.vmInfoEmbed({
                name: f.vc.name, ownerId: f.record.ownerId, ownerPresent: f.vc.members.has(f.record.ownerId), members: f.vc.members.size, limit: f.vc.userLimit,
                bitrateKbps: Math.round(f.vc.bitrate / 1000), region: ui.VM_REGIONS.find(([v]) => v === (f.vc.rtcRegion || 'auto'))?.[1] || f.vc.rtcRegion || 'Automatic',
                locked: vmIsLocked(f.vc), hidden: vmIsHidden(f.vc), permitted: ids(true), rejected: ids(false)
            }) };
    }),
    delete: (member) => vmGuard(async () => {
        const f = vmFind(member);
        if (f.err)
            return vmFail(f.err);
        await f.vc.delete('Deleted by channel owner');
        db.removeVMChannel(f.vc.id);
        return vmOk('🗑️ Channel Deleted', 'Your temporary channel was removed.');
    })
};
async function vmRespond(i, r) {
    const payload = r.embed ? { embeds: [r.embed], components: [] } : { embeds: [r.ok ? ui.okEmbed(r.title, r.text) : ui.errorEmbed(r.title, r.text)], components: [] };
    if (i.deferred || i.replied)
        return i.editReply(payload).catch(() => { });
    return i.reply({ ...payload, ephemeral: true }).catch(() => { });
}
function vmIsAdmin(i) { return !!i.memberPermissions?.has(PermissionFlagsBits.Administrator); }
const VM_MODALS = {
    vm_rename: { title: 'Rename Channel', label: 'New name', placeholder: 'e.g. Chill Lounge', max: 100 },
    vm_limit: { title: 'Set User Limit', label: 'Limit (0 = unlimited, max 99)', placeholder: '0', max: 2 },
    vm_bitrate: { title: 'Set Bitrate', label: 'Bitrate in kbps (8 – server max)', placeholder: '64', max: 3 }
};
async function handleVoicemasterInteraction(i) {
    const id = i.customId;
    if (!id || !id.startsWith('vm_') || !i.guild)
        return false;
    const { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
    const member = i.member;
    // ---- admin setup ----
    if (id === 'vm_setup_interface' || id === 'vm_setup_sendpanel' || id === 'vm_setup_clearinterface' || id === 'vm_setup_defaults' || id === 'vm_setup_interface_select' || id === 'vm_setup_defaults_modal') {
        if (!vmIsAdmin(i)) {
            await i.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to use this.')], ephemeral: true }).catch(() => { });
            return true;
        }
        const cfgNow = db.getConfig(i.guildId).voicemaster;
        if (id === 'vm_setup_interface') {
            await i.reply({ embeds: [ui.vmInterfacePromptEmbed()], components: [ui.vmInterfaceSelectRow()], ephemeral: true });
            return true;
        }
        if (id === 'vm_setup_interface_select') {
            await i.deferUpdate();
            const newId = i.values[0];
            if (cfgNow.interfaceChannelId && cfgNow.interfaceChannelId !== newId)
                await vmRemoveInterfaceMessage(i.guild, cfgNow);
            db.saveConfig(i.guildId, { voicemaster: { interfaceChannelId: newId, interfaceMessageId: null } });
            const res = await postVoiceInterface(i.guild);
            const cfg = db.getConfig(i.guildId);
            await i.editReply({ embeds: [ui.vmSetupEmbed(cfg)], components: ui.vmSetupRows(cfg) });
            await i.followUp({ embeds: [res.ok ? ui.okEmbed('Interface Posted', `The control panel is now in ${res.channel}. New temp VCs will **not** get their own panel.`) : ui.errorEmbed('Interface Saved, Panel Not Posted', `${res.error}\nUntil that is fixed, new temp VCs keep their own in-channel panel.`)], ephemeral: true });
            return true;
        }
        if (id === 'vm_setup_sendpanel') {
            await i.deferReply({ ephemeral: true });
            const res = await postVoiceInterface(i.guild);
            await i.editReply({ embeds: [res.ok ? ui.okEmbed('Interface Re-posted', `Fresh control panel sent to ${res.channel}.`) : ui.errorEmbed('Could Not Post', res.error)] });
            return true;
        }
        if (id === 'vm_setup_clearinterface') {
            await vmRemoveInterfaceMessage(i.guild, cfgNow);
            const cfg = db.saveConfig(i.guildId, { voicemaster: { interfaceChannelId: null, interfaceMessageId: null } });
            await i.update({ embeds: [ui.vmSetupEmbed(cfg)], components: ui.vmSetupRows(cfg) });
            return true;
        }
        if (id === 'vm_setup_defaults') {
            const input = (cid, label, value, ph, req = false, max = 100) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(cid).setLabel(label).setStyle(TextInputStyle.Short).setRequired(req).setMaxLength(max).setPlaceholder(ph).setValue(String(value ?? '')));
            const modal = new ModalBuilder().setCustomId('vm_setup_defaults_modal').setTitle('VoiceMaster Defaults').addComponents(
                input('template', 'Channel name ({user}, {username})', cfgNow.nameTemplate || "{user}'s room", "{user}'s room", true),
                input('limit', 'Default user limit (0 = none, max 99)', cfgNow.defaultLimit || 0, '0', false, 2),
                input('bitrate', 'Default bitrate in kbps (blank = server default)', cfgNow.defaultBitrate ? Math.round(cfgNow.defaultBitrate / 1000) : '', '64', false, 3),
                input('profiles', 'Saved member profiles (on / off)', cfgNow.profilesEnabled === false ? 'off' : 'on', 'on', false, 3));
            await i.showModal(modal);
            return true;
        }
        if (id === 'vm_setup_defaults_modal') {
            const get = (k) => i.fields.getTextInputValue(k).trim();
            const limit = get('limit') === '' ? 0 : Number(get('limit'));
            const kbps = get('bitrate') === '' ? null : Number(get('bitrate'));
            const max = Math.floor((i.guild.maximumBitrate || 96000) / 1000);
            const profiles = get('profiles').toLowerCase();
            if (!Number.isInteger(limit) || limit < 0 || limit > 99)
                return i.reply({ embeds: [ui.errorEmbed('Invalid Limit', 'The limit must be a whole number from 0 to 99.')], ephemeral: true }).then(() => true);
            if (kbps !== null && (!Number.isFinite(kbps) || kbps < 8 || kbps > max))
                return i.reply({ embeds: [ui.errorEmbed('Invalid Bitrate', `Bitrate must be 8–${max} kbps, or blank for the server default.`)], ephemeral: true }).then(() => true);
            if (profiles && !['on', 'off'].includes(profiles))
                return i.reply({ embeds: [ui.errorEmbed('Invalid Value', 'Saved member profiles must be **on** or **off**.')], ephemeral: true }).then(() => true);
            const cfg = db.saveConfig(i.guildId, { voicemaster: { nameTemplate: vmClean(get('template'), "{user}'s room"), defaultLimit: limit, defaultBitrate: kbps === null ? null : Math.round(kbps * 1000), profilesEnabled: profiles !== 'off' } });
            await i.reply({ embeds: [ui.vmSetupEmbed(cfg)], components: ui.vmSetupRows(cfg), ephemeral: true });
            return true;
        }
    }
    // ---- member controls ----
    const run = async (op, ...args) => { await i.deferReply({ ephemeral: true }).catch(() => { }); return vmRespond(i, await vmOps[op](member, ...args)); };
    if (i.isButton()) {
        switch (id) {
            case 'vm_togglelock': await run('lock'); return true;
            case 'vm_togglehide': await run('hide'); return true;
            case 'vm_claim': await run('claim'); return true;
            case 'vm_info': await run('info'); return true;
            case 'vm_save': await run('save'); return true;
            case 'vm_reset': await run('reset'); return true;
            case 'vm_rename':
            case 'vm_limit':
            case 'vm_bitrate': {
                const f = vmFind(member);
                if (f.err) {
                    await vmRespond(i, vmFail(f.err));
                    return true;
                }
                const m = VM_MODALS[id];
                const input = new TextInputBuilder().setCustomId('value').setLabel(m.label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(m.max).setPlaceholder(m.placeholder);
                if (id === 'vm_rename')
                    input.setValue(f.vc.name.slice(0, 100));
                await i.showModal(new ModalBuilder().setCustomId(id).setTitle(m.title).addComponents(new ActionRowBuilder().addComponents(input)));
                return true;
            }
            case 'vm_permit':
            case 'vm_reject':
            case 'vm_transfer': {
                const f = vmFind(member);
                if (f.err) {
                    await vmRespond(i, vmFail(f.err));
                    return true;
                }
                await i.reply(ui.vmUserPickPrompt(id.slice(3)));
                return true;
            }
            case 'vm_kick': {
                const f = vmFind(member);
                if (f.err) {
                    await vmRespond(i, vmFail(f.err));
                    return true;
                }
                const others = f.vc.members.filter(m => m.id !== member.id);
                if (!others.size) {
                    await i.reply({ embeds: [ui.vmKickNobodyEmbed()], ephemeral: true });
                    return true;
                }
                await i.reply({ embeds: [ui.vmKickPromptEmbed()], components: [ui.vmKickSelectRow([...others.values()])], ephemeral: true });
                return true;
            }
            case 'vm_delete': {
                const f = vmFind(member);
                if (f.err) {
                    await vmRespond(i, vmFail(f.err));
                    return true;
                }
                await i.reply({ embeds: [ui.warnEmbed('🗑️ Delete this channel?', `**${f.vc.name}** will be removed and everyone inside is disconnected.`)], components: [ui.vmDeleteConfirmRow()], ephemeral: true });
                return true;
            }
            case 'vm_delete_no':
                await i.update({ embeds: [ui.okEmbed('Cancelled', 'Your channel was kept.')], components: [] });
                return true;
            case 'vm_delete_yes':
                await i.deferUpdate().catch(() => { });
                await vmRespond(i, await vmOps.delete(member));
                return true;
        }
        return false;
    }
    if (i.isModalSubmit() && VM_MODALS[id]) {
        await run(id.slice(3), i.fields.getTextInputValue('value'));
        return true;
    }
    if (i.isStringSelectMenu() && (id === 'vm_region_pick' || id === 'vm_kick_pick')) {
        if (id === 'vm_region_pick') {
            await i.deferReply({ ephemeral: true }).catch(() => { });
            await vmRespond(i, await vmOps.region(member, i.values[0]));
            return true;
        }
        await i.deferUpdate().catch(() => { });
        await vmRespond(i, await vmOps.kick(member, i.values[0]));
        return true;
    }
    if (i.isUserSelectMenu() && ['vm_permit_pick', 'vm_reject_pick', 'vm_transfer_pick'].includes(id)) {
        await i.deferUpdate().catch(() => { });
        await vmRespond(i, await vmOps[id.slice(3, -5)](member, i.values[0]));
        return true;
    }
    return false;
}
async function securityLog(guild, cfg, title, description) {
    const channel = cfg.logChannelId ? guild.channels.cache.get(cfg.logChannelId) : await getLogChannel(guild, 'antinuke');
    if (channel?.isTextBased())
        await channel.send({ embeds: [ui.errorEmbed(title, description)] }).catch(() => { });
}
async function handleAntiBotJoin(member) {
    const cfg = db.getConfig(member.guild.id).antibot;
    if (!cfg.enabled || !member.user.bot)
        return;
    if (cfg.bypassRoleId) {
        const logs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 5 }).catch(() => null);
        const entry = logs?.entries.find(e => e.target?.id === member.id && Date.now() - e.createdTimestamp < 15000);
        const inviter = entry?.executor ? await member.guild.members.fetch(entry.executor.id).catch(() => null) : null;
        if (inviter?.roles.cache.has(cfg.bypassRoleId))
            return;
    }
    if (cfg.action === 'ban')
        await member.ban({ reason: 'Anti-Bot protection' }).catch(() => { });
    else if (cfg.action === 'strip_roles')
        await member.roles.set([], 'Anti-Bot protection').catch(() => { });
    else
        await member.kick('Anti-Bot protection').catch(() => { });
    await securityLog(member.guild, cfg, '🤖 Anti-Bot Triggered', `**Bot:** ${member.user.tag} (<@${member.id}>)\n**Action:** ${cfg.action}`);
}
async function handleAntiAltJoin(member) {
    const cfg = db.getConfig(member.guild.id).antialt;
    if (!cfg.enabled || member.user.bot)
        return;
    const ageDays = (Date.now() - member.user.createdTimestamp) / 86400000;
    if (ageDays >= Number(cfg.minAccountAgeDays || 0))
        return;
    if (cfg.action === 'ban')
        await member.ban({ reason: 'Anti-Alt: account too new' }).catch(() => { });
    else
        await member.kick('Anti-Alt: account too new').catch(() => { });
    await securityLog(member.guild, cfg, '🛡️ Anti-Alt Triggered', `**User:** ${member.user.tag} (<@${member.id}>)\n**Account age:** ${ageDays.toFixed(1)} days\n**Minimum:** ${cfg.minAccountAgeDays} days\n**Action:** ${cfg.action}`);
}
async function handleAntiWebhookUpdate(channel) {
    const cfg = db.getConfig(channel.guild.id).antiwebhook;
    if (!cfg.enabled)
        return;
    const executor = await findAuditExecutor(channel.guild, AuditLogEvent.WebhookCreate, null).catch(() => null);
    if (!executor || executor.id === channel.client.user?.id)
        return;
    const member = await channel.guild.members.fetch(executor.id).catch(() => null);
    if (!member)
        return;
    if (cfg.bypassRoleId && member.roles.cache.has(cfg.bypassRoleId))
        return;
    try {
        const hooks = await channel.fetchWebhooks().catch(() => null);
        if (hooks)
            for (const [, hook] of hooks)
                if (hook.owner?.id === executor.id)
                    await hook.delete('Anti-Webhook protection').catch(() => { });
        if (cfg.action === 'ban')
            await member.ban({ reason: 'Anti-Webhook protection' }).catch(() => { });
        else if (cfg.action === 'kick')
            await member.kick('Anti-Webhook protection').catch(() => { });
        else if (cfg.action === 'strip_roles')
            await member.roles.set([], 'Anti-Webhook protection').catch(() => { });
    }
    finally {
        await securityLog(channel.guild, cfg, '🪝 Anti-Webhook Triggered', `**Executor:** ${executor.tag || executor.username} (<@${executor.id}>)\n**Channel:** ${channel}\n**Action:** ${cfg.action}`);
    }
}
function triggerMatches(content, trigger, ignoreCase) {
    const text = ignoreCase ? content.toLowerCase() : content;
    const match = ignoreCase ? String(trigger.match || '').toLowerCase() : String(trigger.match || '');
    if (!match)
        return false;
    if (trigger.mode === 'exact')
        return text.trim() === match.trim();
    return text.includes(match);
}
async function handleAutoresponder(message) {
    const cfg = db.getConfig(message.guild.id).autoresponder;
    if (!cfg.enabled || !cfg.triggers.length)
        return;
    const trigger = cfg.triggers.find(t => triggerMatches(message.content, t, cfg.ignoreCase));
    if (!trigger)
        return;
    const response = String(trigger.response || '')
        .replace(/\{user\}/g, `${message.author}`)
        .replace(/\{server\}/g, message.guild.name);
    if (!response)
        return;
    await message.channel.send({ content: response.slice(0, 2000), allowedMentions: { repliedUser: false } }).catch(() => { });
}
async function handleAutoreactor(message) {
    const cfg = db.getConfig(message.guild.id).autoreactor;
    if (!cfg.enabled || !cfg.triggers.length)
        return;
    for (const trigger of cfg.triggers) {
        if (!triggerMatches(message.content, trigger, cfg.ignoreCase))
            continue;
        for (const em of (trigger.emojis || []).slice(0, 5)) {
            await message.react(em).catch(() => { });
        }
    }
}
const embedBuilderSessions = new Map();
module.exports = {
    joinAndStayInVC, ensureBotInVC, TTS_VOICES, buildTTSBuffer, playTTSInChannel, playAudioInput, playGreetvoiceGreeting, saveGreetvoiceAudio, removeGreetvoiceAudio,
    antinukeStrike, findAuditExecutor, getLogChannel,
    handleAntiraidJoin,
    handleAntiBotJoin, handleAntiAltJoin, handleAntiWebhookUpdate,
    handleAntilink,
    handleAntispam,
    lockRoleToSingleChannel, onChannelCreateGreetvoiceSync, onMemberJoinGreetvoice, onVoiceJoinGreetvoice,
    xpForLevel, handleLevelingMessage,
    handleVoicemasterJoin, handleVoiceStateUpdate, logVoiceDependencies,
    postVoiceInterface, vmRemoveInterfaceMessage, handleVoicemasterInteraction, onVoicemasterChannelDelete, vmSweep, vmOps, vmRespond, vmIsAdmin,
    handleAutoresponder, handleAutoreactor,
    embedBuilderSessions
};

};
__modules["template.js"] = function(module, exports, require, __filename, __dirname) {
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
const wait = ms => new Promise(r => setTimeout(r, ms));
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
async function createSnapshot(guild, onStage = async () => { }) {
    await onStage('Reading roles & channels…');
    await guild.channels.fetch().catch(() => { });
    await guild.roles.fetch().catch(() => { });
    const roles = [...guild.roles.cache.values()]
        .filter(r => r.id !== guild.id && !r.managed)
        .sort((a, b) => b.position - a.position)
        .slice(0, MAX_ROLES);
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
            const key = ow.id === guild.id ? 'e' : roleIndex.get(ow.id);
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
    try {
        for (const e of db.listEmbeds(guild.id))
            embeds.push({ name: e.name, data: encodeIds(e.data, chIndex, roleIndex) });
    }
    catch { }
    let wl = [];
    try {
        wl = db.db.prepare('SELECT userId FROM antinuke_whitelist WHERE guildId=?').all(guild.id).map(r => r.userId);
    }
    catch { }
    return {
        v: 2, id: guild.id, name: guild.name, at: Date.now(), g,
        roles: roles.map(r => ({ n: r.name, c: r.color, h: r.hoist ? 1 : 0, m: r.mentionable ? 1 : 0, p: r.permissions.bitfield.toString(), ue: r.unicodeEmoji || undefined })),
        channels: channels.map(c => ({
            n: c.name, t: c.type,
            p: c.parentId && chIndex.has(c.parentId) ? chIndex.get(c.parentId) : -1,
            tp: c.topic || undefined, nsfw: c.nsfw ? 1 : undefined, rl: c.rateLimitPerUser || undefined,
            b: c.bitrate || undefined, ul: c.userLimit || undefined, rg: c.rtcRegion || undefined,
            vq: c.videoQualityMode || undefined, aa: c.defaultAutoArchiveDuration || undefined,
            tags: c.availableTags?.length ? c.availableTags.map(t => ({ name: t.name, moderated: !!t.moderated, emoji: t.emoji?.name && !t.emoji?.id ? t.emoji.name : undefined })) : undefined,
            so: c.defaultSortOrder ?? undefined, fl: c.defaultForumLayout || undefined,
            tr: c.defaultThreadRateLimitPerUser || undefined,
            o: overwritesOf(c)
        })),
        emojis, stickers, panels, config, sticky, embeds, wl
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
    if (!data || ![1, 2].includes(data.v) || !Array.isArray(data.roles) || !Array.isArray(data.channels))
        throw new Error('Unsupported template version.');
    return data;
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
const running = new Set();
const DELETE_ID = 'tplprog:del';
function renderProgress(prog, title = '🔄 Loading Server Template') {
    const lines = [];
    const row = (emoji, key, label) => { const c = prog.c[key]; if (c.total > 0)
        lines.push(`${emoji} **${c.done}/${c.total}** ${label}`); };
    row('📁', 'channels', 'channels created');
    row('🏷️', 'roles', 'roles created');
    row('⚙️', 'server', 'server settings loaded');
    row('🤖', 'bot', 'bot settings loaded');
    row('😀', 'emojis', 'emojis created');
    row('🏷️', 'stickers', 'stickers created');
    row('🎟️', 'panels', 'panels posted');
    const secs = Math.round((Date.now() - prog.started) / 1000);
    return ui.base(title).setDescription(`**${prog.stage}**\n\n${lines.join('\n')}\n\n-# Elapsed ${Math.floor(secs / 60)}m ${secs % 60}s`);
}
async function createProgressChannel(guild, user, me) {
    return guild.channels.create({
        name: 'template-progress', type: ChannelType.GuildText,
        topic: 'Live progress of the template load. Delete this channel when it finishes.',
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
    const failed = [];
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
            panels: { done: 0, total: (snapshot.panels || []).length + rolePanelCount }
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
    const roleIds = new Array(snapshot.roles.length).fill(null);
    for (let i = snapshot.roles.length - 1; i >= 0; i--) {
        const r = snapshot.roles[i];
        try {
            const opts = { name: r.n, color: r.c || 0, hoist: !!r.h, mentionable: !!r.m, permissions: new PermissionsBitField(isAdmin ? BigInt(r.p) : (BigInt(r.p) & meBits)), reason };
            if (r.ue && (guild.premiumTier || 0) >= 2)
                opts.unicodeEmoji = r.ue;
            const role = await guild.roles.create(opts).catch(async (e) => { if (opts.unicodeEmoji) {
                delete opts.unicodeEmoji;
                return guild.roles.create(opts);
            } throw e; });
            roleIds[i] = role.id;
            prog.c.roles.done++;
        }
        catch (e) {
            failed.push(`role @${r.n}: ${short(e)}`);
        }
        await flush();
        await wait(200);
    }
    try {
        await stage('Arranging roles…');
        await guild.roles.fetch();
        const made = roleIds.map((id, i) => ({ id, i })).filter(x => x.id && guild.roles.cache.has(x.id));
        const slots = made.map(x => guild.roles.cache.get(x.id).position).sort((a, b) => a - b);
        const ordered = [...made].sort((a, b) => a.i - b.i);
        const updates = ordered.map((x, k) => ({ role: x.id, position: slots[slots.length - 1 - k] }));
        if (updates.length)
            await guild.roles.setPositions(updates);
    }
    catch (e) {
        failed.push(`role order: ${short(e)}`);
    }
    await stage('Creating channels…');
    const chIds = new Array(snapshot.channels.length).fill(null);
    const overwrites = list => (list || []).map(([key, allow, deny]) => {
        const id = key === 'e' ? guild.id : roleIds[key];
        if (!id)
            return null;
        const a = isAdmin ? BigInt(allow) : (BigInt(allow) & meBits);
        return { id, type: 0, allow: a, deny: BigInt(deny) };
    }).filter(Boolean);
    const order = [
        ...snapshot.channels.map((c, i) => [c, i]).filter(([c]) => c.t === ChannelType.GuildCategory),
        ...snapshot.channels.map((c, i) => [c, i]).filter(([c]) => c.t !== ChannelType.GuildCategory)
    ];
    for (const [c, i] of order) {
        const build = type => {
            const opts = { name: c.n, type, permissionOverwrites: overwrites(c.o), reason };
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
            prog.c.channels.done++;
        }
        catch (e) {
            failed.push(`channel ${c.n}: ${short(e)}`);
        }
        await flush();
        await wait(200);
    }
    try {
        await stage('Arranging channels…');
        const groups = new Map();
        snapshot.channels.forEach((c, i) => {
            if (!chIds[i])
                return;
            const key = c.t === ChannelType.GuildCategory ? 'top' : (c.p >= 0 && chIds[c.p] ? `p${c.p}` : 'top');
            if (!groups.has(key))
                groups.set(key, []);
            groups.get(key).push(chIds[i]);
        });
        const updates = [];
        for (const ids of groups.values())
            ids.forEach((id, k) => updates.push({ channel: id, position: k }));
        if (updates.length)
            await guild.channels.setPositions(updates);
    }
    catch (e) {
        failed.push(`channel order: ${short(e)}`);
    }
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
                for (const e of snapshot.embeds)
                    db.saveEmbed(guild.id, e.name, decodeIds(e.data, chIds, roleIds));
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
    await stage('Finished ✅');
    await flush(true);
    const result = {
        channelsCreated: prog.c.channels.done, rolesCreated: prog.c.roles.done, serverSettings: prog.c.server.done,
        botSettings: prog.c.bot.done, emojis: prog.c.emojis.done, stickers: prog.c.stickers.done, panels: prog.c.panels.done,
        failed, progressChannel: pch, totals: Object.fromEntries(Object.entries(prog.c).map(([k, v]) => [k, v.total]))
    };
    if (pch) {
        try {
            const t = result.totals;
            const summary = [
                `📁 **${result.channelsCreated}/${t.channels}** channels created`,
                `🏷️ **${result.rolesCreated}/${t.roles}** roles created`,
                t.server ? `⚙️ **${result.serverSettings}/${t.server}** server settings loaded` : null,
                t.bot ? `🤖 **${result.botSettings}/${t.bot}** bot settings loaded` : null,
                t.emojis ? `😀 **${result.emojis}/${t.emojis}** emojis created` : null,
                t.stickers ? `🏷️ **${result.stickers}/${t.stickers}** stickers created` : null,
                t.panels ? `🎟️ **${result.panels}/${t.panels}** panels posted` : null
            ].filter(Boolean).join('\n');
            const problems = failed.length ? `\n\n**${failed.length} item(s) had problems:**\n${failed.slice(0, 12).map(x => '• ' + x).join('\n')}${failed.length > 12 ? `\n• …and ${failed.length - 12} more` : ''}` : '';
            const note = '\n\n-# Members\' role assignments are not part of a template — give your roles back to members as needed.';
            const embed = (failed.length ? ui.warnEmbed : ui.okEmbed)('✅ Template Loaded', `The server was rebuilt from **${snapshot.name || 'the template'}**.\n\n${summary}${problems}${note}`);
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${DELETE_ID}:${user.id}`).setLabel('Delete Progress Channel').setStyle(ButtonStyle.Danger));
            await pch.send({ embeds: [embed], components: [row] });
        }
        catch (e) {
            console.error('[Template] completion message failed:', e);
        }
    }
    return result;
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
        await i.reply({ embeds: [ui.errorEmbed('Not Allowed', 'Only the person who loaded the template or an Administrator can delete this channel.')], ephemeral: true }).catch(() => { });
        return true;
    }
    await i.deferUpdate().catch(() => { });
    try {
        await i.channel.delete('AunXz /template load finished — progress channel removed');
    }
    catch (e) {
        await i.followUp({ embeds: [ui.errorEmbed('Could Not Delete', short(e))], ephemeral: true }).catch(() => { });
    }
    return true;
}
module.exports = {
    MAX_CODE_LENGTH, createSnapshot, encodeSnapshot, decodeSnapshot, resolveSnapshot, runLoad, handleInteraction,
    _internal: { encodeIds, decodeIds, collectCustomIds }
};

};
__modules["ui.js"] = function(module, exports, require, __filename, __dirname) {
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder, ChannelType, PermissionFlagsBits, ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, SeparatorBuilder, MessageFlags } = require('discord.js');
const db = require('./database');
const embedStyles = require('./embeds');
const THEME = embedStyles.COLORS.info;
const OK = embedStyles.COLORS.success;
const WARN = embedStyles.COLORS.warning;
const DANGER = embedStyles.COLORS.error;
const BRAND_FOOTER = embedStyles.BRAND_FOOTER;
const DEFAULT_EMOJIS = {
    success: '✅', lock: '🔒', voice: '🔊', level: '📈', ticket: '🎫', wave: '👋', settings: '⚙️',
    kick: '👢', delete: '🗑️', enabled: '🟢', disabled: '🔴', shield: '🛡️', unlock: '🔓',
    moderation: '🔨', warning: '⚠️', claim: '🙋', undo: '↩️', add: '➕', remove: '➖',
    hidden: '🙈', visible: '👁️', rename: '✏️', limit: '🔢', transfer: '🔁', category: '📁',
    voice_mic: '🎙️', link: '🔗', spam: '🚫', tools: '🛠️', error: '❌', logs: '📜', owner: '👑',
    raid: '🚨', mute: '🔇', boost: '🚀', clear: '🧹', slow: '🐌', unknown: '❔', help: '📖',
    cancel: '✖️', emoji: '😀', nobody: '🙅', already_gone: '😅', balloon: '🎈',
    member_join: '📥', member_leave: '📤', info: 'ℹ️',
    bitrate: '📶', region: '🌍', save: '💾', permit: '✅', reject: '🚫', panel: '🎛️'
};
const EMOJI_ALIASES = {
    ok: 'success', warn: 'warning', error: 'error',
    ticket_open: 'ticket', ticket_close: 'lock', staff_controls: 'tools',
    unclaim: 'undo', add_member: 'add', remove_member: 'remove',
    enable: 'enabled', disable: 'disabled', edit: 'settings',
    unhide: 'visible', hide: 'hidden', rename: 'rename', limit: 'limit',
    kick: 'kick', transfer: 'transfer', lock: 'lock', unlock: 'unlock',
    shield: 'shield'
};
const EMOJI_KEYS = Object.keys(DEFAULT_EMOJIS);
const DEFAULT_TO_KEY = new Map(Object.entries(DEFAULT_EMOJIS).map(([k, v]) => [v, k]));
function resolveEmojiKey(name) { return EMOJI_ALIASES[name] || name; }
function isCustomEmoji(value) { return /^<a?:[A-Za-z0-9_~.-]+:\d+>$/.test(String(value || '').trim()); }
function customEmojiKey(value) {
    const m = String(value || '').trim().match(/^<a?:([^:>]+):(\d+)>$/);
    return m ? `custom_${m[1]}` : null;
}
function unicodeEmojiKey(value) {
    const cps = [...String(value || '')].map(ch => ch.codePointAt(0).toString(16)).join('-');
    return cps ? `unicode_${cps}` : null;
}
function emojiTokenKey(value) {
    return customEmojiKey(value) || unicodeEmojiKey(value);
}
function emojiDisplayValue(value) {
    const key = emojiTokenKey(value);
    return key ? (db.getEmojiOverride(key) || value) : value;
}
function extractEmojiTokens(text) {
    if (typeof text !== 'string' || !text)
        return [];
    const custom = text.match(/<a?:[A-Za-z0-9_~.-]+:\d+>/g) || [];
    const unicode = text.match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu) || [];
    return [...new Set([...custom, ...unicode])];
}
function dynamicEmojiEntries() {
    const usedRows = db.listEmbedTexts(500);
    const found = new Set();
    for (const row of usedRows) {
        for (const value of extractEmojiTokens(`${row.title || ''} ${row.description || ''} ${row.footer || ''}`))
            found.add(value);
    }
    for (const value of Object.values(DEFAULT_EMOJIS))
        found.delete(value);
    return [...found].map(value => {
        const key = emojiTokenKey(value) || `auto_${Buffer.from(value).toString('hex').slice(0, 20)}`;
        const current = db.getEmojiOverride(key) || value;
        const custom = /^<a?:([^:>]+):(\d+)>$/.exec(value);
        return {
            key,
            value: current,
            originalValue: value,
            custom: true,
            usedIn: usedRows.filter(r => `${r.title || ''} ${r.description || ''} ${r.footer || ''}`.includes(value)).slice(0, 8).map(r => r.name)
        };
    });
}
function emoji(name) {
    const key = resolveEmojiKey(name);
    return db.getEmojiOverride(key) || DEFAULT_EMOJIS[key] || DEFAULT_EMOJIS.unknown;
}
function emojify(value) {
    if (typeof value !== 'string' || !value)
        return value;
    let out = value;
    const defaults = Object.entries(DEFAULT_EMOJIS).sort((a, b) => b[1].length - a[1].length);
    for (const [key, def] of defaults) {
        const replacement = db.getEmojiOverride(key) || def;
        if (replacement !== def)
            out = out.split(def).join(replacement);
    }
    for (const entry of dynamicEmojiEntries()) {
        if (entry.originalValue && entry.value !== entry.originalValue)
            out = out.split(entry.originalValue).join(entry.value);
    }
    return out;
}
function decorateEmbed(embed) {
    const setTitle = embed.setTitle.bind(embed);
    const setDescription = embed.setDescription.bind(embed);
    const setFooter = embed.setFooter.bind(embed);
    const setAuthor = embed.setAuthor.bind(embed);
    const addFields = embed.addFields.bind(embed);
    embed.setTitle = value => {
        const source = String(value ?? '');
        embed.__aunxzSourceTitle = source;
        const override = db.getEmbedText(source);
        const actual = override?.title || emojify(source);
        db.registerEmbedText(source, override?.description || '', override?.footer || '');
        return setTitle(actual);
    };
    embed.setDescription = value => {
        const source = String(value ?? '');
        const sourceTitle = embed.__aunxzSourceTitle || '';
        const override = sourceTitle ? db.getEmbedText(sourceTitle) : null;
        const actual = override && override.description ? override.description : emojify(source);
        if (sourceTitle)
            db.registerEmbedText(sourceTitle, source, override?.footer || '');
        return setDescription(actual);
    };
    embed.setFooter = value => {
        if (value && typeof value === 'object') {
            const text = emojify(value.text);
            if (embed.__aunxzSourceTitle)
                db.registerEmbedText(embed.__aunxzSourceTitle, '', text);
            return setFooter({ ...value, text });
        }
        if (embed.__aunxzSourceTitle)
            db.registerEmbedText(embed.__aunxzSourceTitle, '', String(value || ''));
        return setFooter(emojify(value));
    };
    embed.setAuthor = value => {
        if (value && typeof value === 'object')
            return setAuthor({ ...value, name: emojify(value.name) });
        return setAuthor(value);
    };
    embed.addFields = (...fields) => addFields(...fields.map(field => {
        if (Array.isArray(field))
            return field.map(f => ({ ...f, name: emojify(f.name), value: emojify(f.value) }));
        if (field && typeof field === 'object')
            return { ...field, name: emojify(field.name), value: emojify(field.value) };
        return field;
    }));
    return embed;
}
function base(title) {
    const embed = new EmbedBuilder().setColor(THEME).setTimestamp();
    decorateEmbed(embed);
    embed.setTitle(title);
    return embedStyles.applySharedStyle(embed, 'info');
}
function okEmbed(title, desc) { return base(title).setColor(OK).setDescription(desc); }
function warnEmbed(title, desc) { return base(title).setColor(WARN).setDescription(desc); }
function errorEmbed(title, desc) { return base(title).setColor(DANGER).setDescription(desc); }
function infoEmbed(title, desc) { return base(title).setColor(THEME).setDescription(desc); }
const HELP_CATEGORIES = {
    protection: {
        name: 'Protection', emojiKey: 'shield',
        desc: '**/antinuke setup** — punishment, thresholds, protected owner\n' +
            '**/antilink setup** — delete/warn/mute, domain whitelist, bypass role\n' +
            '**/antispam setup** — message/mention/emoji flood limits\n' +
            '**/antiraid setup** — join-rate lockdown, min account age\n' +
            '**/antiwebhook setup** — webhook action, bypass role, security log\n' +
            '**/antibot setup** — bot action, bypass role, security log\n' +
            '**/antialt setup** — minimum account age, action, security log\n' +
            '**/whitelist add|remove** — exempt trusted staff from antinuke'
    },
    voice: {
        name: 'Voice', emojiKey: 'voice',
        desc: '**/greetvoice** `view|toggle|channel|role|message|audio|test|reset` — VC greeting\n' +
            '**/voicemaster setup** — hub channel, category, **interface channel**, defaults\n' +
            '**/voice** `lock|unlock|hide|unhide|rename|limit|bitrate|permit|reject|kick|claim|transfer|region|info|reset|save|forget|delete|panel` — customize your temp VC (or use the control panel buttons)'
    },
    moderation: {
        name: 'Moderation', emojiKey: 'moderation',
        desc: '**/ban /kick /timeout /untimeout** — with mod-log embeds\n' +
            '**/warn /warnings /clearwarns** — warning system\n' +
            '**/purge** — bulk delete with filters\n' +
            '**/lock /unlock /slowmode** — channel controls\n' +
            '**/nickname /role add|remove**'
    },
    leveling: {
        name: 'Leveling', emojiKey: 'level',
        desc: '**/leveling setup** — xp rate, cooldown, level-up message, role rewards\n' +
            '**/rank** — view a level card\n' +
            '**/leaderboard** — top XP in the server'
    },
    tickets: {
        name: 'Tickets', emojiKey: 'ticket',
        desc: '**/tickets setup** — ticket category, support role, log channel\n' +
            '**/ticketpanel** — post the open-a-ticket panel\n' +
            '**/ticketconfig** — customize panel/welcome images and text'
    },
    logging: {
        name: 'Logging', emojiKey: 'logs',
        desc: '**/logs setup** — route mod/message/member/voice/antinuke/server logs to channels'
    },
    automation: {
        name: 'Automation & Content', emojiKey: 'tools',
        desc: '**/autorespondersetup** — auto-reply when a message matches a phrase\n' +
            '**/autoreactorsetup** — auto-react with emoji when a message matches a phrase\n' +
            '**/embedbuilder** — build a custom embed with link buttons and post it\n' +
            '**/honeypotsetup** — trap channel that punishes anyone who posts in it\n' +
            '**/stickymessage** — keep an embed as the last message of a channel\n' +
            '**/antibadwordsetup** — multilingual profanity filter\n' +
            '**/greetvoicesetup** — easy panel for the role-gated VC greeting\n' +
            '**/birthdaysetup** — birthday panel + automatic wishes'
    },
    settings: {
        name: 'Settings', emojiKey: 'settings',
        desc: 'Every command has `set`, `view` and `reset`:\n' +
            '**/welcomechannel /welcomemessage /welcometoggle**\n**/leavechannel /leavemessage /leavetoggle**\n**/setautorole**\n' +
            '**/ticketcategory /ticketsupportrole /ticketlogchannel /ticketsetwelcomemsg**\n**/levelchannel /levelupmessage**\n' +
            '**/suggestionchannel /greetmessagechannel /greetmessagetext /birthdaymessage /honeypotchannel**\n**/antispamlimit /antiraidthreshold**'
    },
    extra: {
        name: '40+ more setups', emojiKey: 'settings',
        desc: 'Use **/setup list** to see every configurable module. Smaller modules use their own **/<feature> setup** command.'
    },
    owner: {
        name: 'Owner-only', emojiKey: 'owner',
        desc: '**/maintenance** — toggle maintenance mode\n' +
            '**/blacklist add|remove** — block a user from all commands\n' +
            '**/broadcast** — DM every server owner'
    }
};
function helpHomeEmbed(client, includeOwner = false) {
    const categories = Object.entries(HELP_CATEGORIES).filter(([key]) => includeOwner || key !== 'owner');
    return base(`${emoji('help')} Help Menu`)
        .setDescription(`Pick a category from the menu below.\n\n` + categories.map(([, c]) => `${emoji(c.emojiKey)} **${c.name}**`).join('\n'))
        .setThumbnail(client.user.displayAvatarURL());
}
function helpCategoryEmbed(key) {
    const cat = HELP_CATEGORIES[key];
    if (!cat)
        return errorEmbed('Unknown Category', 'That help category no longer exists.');
    return base(`${emoji(cat.emojiKey)} ${cat.name}`).setDescription(cat.desc);
}
function helpSelectRow(includeOwner = false) {
    const entries = Object.entries(HELP_CATEGORIES).filter(([key]) => includeOwner || key !== 'owner');
    const menu = new StringSelectMenuBuilder()
        .setCustomId('help_select')
        .setPlaceholder('Choose a category…')
        .addOptions(entries.map(([value, c]) => ({ label: c.name, value, emoji: emoji(c.emojiKey) })));
    return new ActionRowBuilder().addComponents(menu);
}
function confirmRow(idBase) {
    return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${idBase}_confirm`).setLabel('Confirm').setStyle(ButtonStyle.Success).setEmoji(emoji('success')), new ButtonBuilder().setCustomId(`${idBase}_cancel`).setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji(emoji('cancel')));
}
function ticketPanelEmbed(guildName, cfg = {}) {
    const e = base(cfg.panelTitle || `${emoji('ticket_open')} ${guildName} Support`)
        .setDescription(cfg.panelDescription || 'Need help? Click **Open Ticket** below and our team will assist you shortly.');
    if (cfg.panelThumbnail)
        e.setThumbnail(cfg.panelThumbnail);
    if (cfg.panelImage)
        e.setImage(cfg.panelImage);
    return e;
}
function ticketPanelRow() {
    return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket_open').setLabel('Open Ticket').setStyle(ButtonStyle.Primary).setEmoji(emoji('ticket_open')));
}
function ticketWelcomeEmbed(user, cfg) {
    const text = (cfg.welcomeMessage || 'Welcome {user}! Our support team will assist you shortly.').replace('{user}', `${user}`);
    const e = base(`${cfg.categoryLabel || 'General Support'} Ticket`)
        .setDescription(`**Welcome** ${user}\n**Category:** ${cfg.categoryLabel || 'General Support'}\n${text}`);
    if (cfg.welcomeThumbnail)
        e.setThumbnail(cfg.welcomeThumbnail);
    if (cfg.welcomeImage)
        e.setImage(cfg.welcomeImage);
    return e;
}
function ticketControlRow() {
    return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji(emoji('ticket_close')), new ButtonBuilder().setCustomId('staff_controls').setLabel('Staff Controls').setStyle(ButtonStyle.Primary).setEmoji(emoji('staff_controls')));
}
function staffControlsEmbed(ticket) {
    const claimLine = ticket?.claimedBy ? `**Claimed by:** <@${ticket.claimedBy}>` : '**Claimed by:** nobody yet';
    return base(`${emoji('staff_controls')} Staff Controls`)
        .setDescription(`Manage this ticket. ${claimLine}`);
}
function staffControlsRow(claimed) {
    return [
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('staff_claim').setLabel(claimed ? 'Unclaim' : 'Claim')
            .setStyle(claimed ? ButtonStyle.Secondary : ButtonStyle.Success).setEmoji(claimed ? emoji('unclaim') : emoji('claim')), new ButtonBuilder().setCustomId('staff_addmember').setLabel('Add Member').setStyle(ButtonStyle.Primary).setEmoji(emoji('add_member')), new ButtonBuilder().setCustomId('staff_removemember').setLabel('Remove Member').setStyle(ButtonStyle.Primary).setEmoji(emoji('remove_member'))),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('staff_delete').setLabel('Delete Ticket').setStyle(ButtonStyle.Danger).setEmoji(emoji('delete')))
    ];
}
const VM_REGIONS = [
    ['auto', 'Automatic'], ['brazil', 'Brazil'], ['hongkong', 'Hong Kong'], ['india', 'India'], ['japan', 'Japan'], ['rotterdam', 'Rotterdam'],
    ['russia', 'Russia'], ['singapore', 'Singapore'], ['southafrica', 'South Africa'], ['sydney', 'Sydney'],
    ['us-central', 'US Central'], ['us-east', 'US East'], ['us-south', 'US South'], ['us-west', 'US West']
];
function vmControlEmbed(owner) {
    const shared = !owner;
    return base(`${emoji('voice')} Voice Channel Controls`)
        .setDescription((shared
        ? 'Join your temporary voice channel, then use the buttons below to customize it. Only the channel owner can use them.\n\n'
        : `Owned by ${owner}. Use the buttons below to manage this room.\n\n`) +
        `**Access** — Lock, Hide, Permit or Reject members\n` +
        `**Style** — Rename, user limit, bitrate and voice region\n` +
        `**Ownership** — Claim an abandoned room or Transfer it\n` +
        `**Profile** — Save your layout so every new room starts the way you like`);
}
function vmControlRows() {
    const b = (id, label, style, key) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setEmoji(emoji(key));
    const S = ButtonStyle;
    const region = new StringSelectMenuBuilder().setCustomId('vm_region_pick').setPlaceholder('Voice region…')
        .addOptions(VM_REGIONS.map(([value, label]) => ({ label, value, emoji: emoji('region') })));
    return [
        new ActionRowBuilder().addComponents(b('vm_togglelock', 'Lock', S.Secondary, 'lock'), b('vm_togglehide', 'Hide', S.Secondary, 'hidden'), b('vm_rename', 'Rename', S.Primary, 'rename'), b('vm_limit', 'Limit', S.Primary, 'limit'), b('vm_bitrate', 'Bitrate', S.Primary, 'bitrate')),
        new ActionRowBuilder().addComponents(b('vm_permit', 'Permit', S.Success, 'permit'), b('vm_reject', 'Reject', S.Danger, 'reject'), b('vm_kick', 'Kick', S.Danger, 'kick'), b('vm_claim', 'Claim', S.Success, 'claim'), b('vm_transfer', 'Transfer', S.Secondary, 'transfer')),
        new ActionRowBuilder().addComponents(b('vm_info', 'Info', S.Secondary, 'info'), b('vm_save', 'Save Profile', S.Secondary, 'save'), b('vm_reset', 'Reset', S.Secondary, 'undo'), b('vm_delete', 'Delete', S.Danger, 'delete')),
        new ActionRowBuilder().addComponents(region)
    ];
}
function vmUserPickPrompt(action) {
    const copy = {
        permit: ['permit', 'Permit a Member', 'Choose who may always join and see your channel, even while it is locked or hidden.'],
        reject: ['reject', 'Reject a Member', 'Choose who is blocked from joining your channel. They are disconnected if they are inside.'],
        transfer: ['transfer', 'Transfer Ownership', 'Choose a member **inside your channel** to become the new owner.']
    }[action];
    const embed = base(`${emoji(copy[0])} ${copy[1]}`).setDescription(copy[2]);
    const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`vm_${action}_pick`).setPlaceholder('Choose a member…'));
    return { embeds: [embed], components: [row], ephemeral: true };
}
function vmInfoEmbed(info) {
    const e = base(`${emoji('info')} ${info.name}`)
        .setDescription(`Owner: <@${info.ownerId}>${info.ownerPresent ? '' : ' *(not in the channel — anyone inside can Claim it)*'}`)
        .addFields({ name: 'Members', value: `${info.members}${info.limit ? ` / ${info.limit}` : ''}`, inline: true }, { name: 'Bitrate', value: `${info.bitrateKbps} kbps`, inline: true }, { name: 'Region', value: info.region, inline: true }, { name: 'Access', value: `${info.locked ? `${emoji('lock')} Locked` : `${emoji('unlock')} Open`} · ${info.hidden ? `${emoji('hidden')} Hidden` : `${emoji('visible')} Visible`}`, inline: false });
    if (info.permitted.length)
        e.addFields({ name: 'Permitted', value: info.permitted.map(id => `<@${id}>`).join(' ').slice(0, 1000) });
    if (info.rejected.length)
        e.addFields({ name: 'Rejected', value: info.rejected.map(id => `<@${id}>`).join(' ').slice(0, 1000) });
    return e;
}
function vmDeleteConfirmRow() {
    return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('vm_delete_yes').setLabel('Delete channel').setStyle(ButtonStyle.Danger).setEmoji(emoji('delete')), new ButtonBuilder().setCustomId('vm_delete_no').setLabel('Cancel').setStyle(ButtonStyle.Secondary));
}
function vmSetupEmbed(cfg) {
    const vm = cfg.voicemaster;
    const status = vm.enabled ? `${emoji('enabled')} Enabled` : `${emoji('disabled')} Disabled`;
    return base(`${emoji('voice')} Voicemaster — Join to Create`)
        .setDescription(`Give members their own temporary voice channel the moment they join a hub VC.\n\n` +
        `**Status:** ${status}\n` +
        `**${emoji('category')} Category:** ${vm.categoryId ? `<#${vm.categoryId}>` : '*not set*'} — new temp channels are created here.\n` +
        `**${emoji('voice_mic')} Join-to-Create Channel:** ${vm.hubChannelId ? `<#${vm.hubChannelId}>` : '*not set*'} — joining this VC spins up a fresh temp channel.\n` +
        `**${emoji('panel')} Interface Channel:** ${vm.interfaceChannelId ? `<#${vm.interfaceChannelId}> — the control panel lives here, so it is **not** posted inside each temp VC.` : '*not set* — the control panel is posted inside each new temp VC.'}\n` +
        `**${emoji('settings')} Defaults:** name \`${vm.nameTemplate || "{user}'s room"}\` · limit ${vm.defaultLimit ? vm.defaultLimit : 'none'} · bitrate ${vm.defaultBitrate ? `${Math.round(vm.defaultBitrate / 1000)} kbps` : 'server default'}\n\n` +
        `Use the buttons below to configure each piece, or flip the whole module on/off.`);
}
function vmSetupRows(cfg) {
    const vm = cfg.voicemaster;
    const enabled = vm.enabled;
    return [
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('vm_setup_category').setLabel('Category').setStyle(ButtonStyle.Secondary).setEmoji(emoji('category')), new ButtonBuilder().setCustomId('vm_setup_channel').setLabel('Voice Channel').setStyle(ButtonStyle.Secondary).setEmoji(emoji('voice_mic')), new ButtonBuilder().setCustomId('vm_setup_toggle').setLabel(enabled ? 'Disable' : 'Enable')
            .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(enabled ? emoji('disabled') : emoji('enabled'))),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('vm_setup_interface').setLabel('Interface Channel').setStyle(ButtonStyle.Primary).setEmoji(emoji('panel')), new ButtonBuilder().setCustomId('vm_setup_sendpanel').setLabel('Resend Interface').setStyle(ButtonStyle.Secondary).setEmoji(emoji('undo')).setDisabled(!vm.interfaceChannelId), new ButtonBuilder().setCustomId('vm_setup_clearinterface').setLabel('Clear Interface').setStyle(ButtonStyle.Secondary).setEmoji(emoji('delete')).setDisabled(!vm.interfaceChannelId), new ButtonBuilder().setCustomId('vm_setup_defaults').setLabel('Defaults').setStyle(ButtonStyle.Secondary).setEmoji(emoji('settings')))
    ];
}
function vmSetupRow(cfg) { return vmSetupRows(cfg)[0]; }
function vmInterfacePromptEmbed() {
    return base(`${emoji('panel')} Pick the Interface Channel`).setDescription('Choose the text channel where the VoiceMaster control panel will be posted. Once set, the panel is **not** sent inside each temp voice channel.');
}
function vmInterfaceSelectRow() {
    return new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('vm_setup_interface_select').setPlaceholder('Choose a text channel…').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement));
}
function vmCategoryPromptEmbed() {
    return base(`${emoji('category')} Pick a Category`).setDescription('Choose the category temp voice channels should be created under.');
}
function vmCategorySelectRow() {
    const menu = new ChannelSelectMenuBuilder().setCustomId('vm_setup_category_select')
        .setPlaceholder('Choose a category…').addChannelTypes(ChannelType.GuildCategory);
    return new ActionRowBuilder().addComponents(menu);
}
function vmChannelPromptEmbed() {
    return base(`${emoji('voice_mic')} Pick a Voice Channel`).setDescription('Choose the voice channel members join to get their own temp channel.');
}
function vmChannelSelectRow() {
    const menu = new ChannelSelectMenuBuilder().setCustomId('vm_setup_channel_select')
        .setPlaceholder('Choose a voice channel…').addChannelTypes(ChannelType.GuildVoice);
    return new ActionRowBuilder().addComponents(menu);
}
function ticketMemberPromptEmbed(action) {
    return base(`${action === 'add' ? emoji('add_member') : emoji('remove_member')} ${action === 'add' ? 'Add' : 'Remove'} Member`)
        .setDescription(`Pick the member to ${action === 'add' ? 'add to' : 'remove from'} this ticket.`);
}
function ticketMemberSelectRow(action) {
    const menu = new UserSelectMenuBuilder().setCustomId(`ticket_${action}member_select`).setPlaceholder('Choose a member…');
    return new ActionRowBuilder().addComponents(menu);
}
function automodSetupEmbed(cfg = {}) {
    const a = cfg.automod || cfg;
    return base(`${emoji('shield')} AutoMod`)
        .setDescription(`**Status:** ${a.enabled !== false ? `${emoji('enabled')} Enabled` : `${emoji('disabled')} Disabled`}\n**Bad Words:** ${a.badWordFilter ? 'On' : 'Off'}\n**Caps:** ${a.capsFilter ? `${a.capsThreshold || 70}%` : 'Off'}\n**Invites:** ${a.inviteFilter ? 'On' : 'Off'}\n\nUse the controls below to configure AutoMod.`);
}
function automodSetupRows(cfg = {}) {
    const a = cfg.automod || cfg;
    return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('automod_cfg:toggle').setLabel(a.enabled === false ? 'Enable' : 'Disable').setStyle(a.enabled === false ? ButtonStyle.Success : ButtonStyle.Danger).setEmoji(a.enabled === false ? emoji('enabled') : emoji('disabled')), new ButtonBuilder().setCustomId('automod_cfg:words').setLabel('Bad Words').setStyle(ButtonStyle.Secondary).setEmoji(emoji('warning')), new ButtonBuilder().setCustomId('automod_cfg:caps').setLabel('Caps').setStyle(ButtonStyle.Secondary).setEmoji('🔠'), new ButtonBuilder().setCustomId('automod_cfg:invite').setLabel('Invites').setStyle(ButtonStyle.Secondary).setEmoji(emoji('link')))];
}
function emojiRegistryEntries() {
    return [
        ...EMOJI_KEYS.map(key => ({ key, value: emoji(key), originalValue: DEFAULT_EMOJIS[key], custom: !!db.getEmojiOverride(key), dynamic: false, usedIn: [] })),
        ...dynamicEmojiEntries()
    ];
}
function emojiSnapshotObject() {
    const values = {};
    for (const entry of emojiRegistryEntries())
        values[entry.key] = entry.value;
    return values;
}
function formatEmojiSnapshot(values = {}) {
    return Object.entries(values).map(([key, value]) => {
        const custom = String(value).match(/^<a?:([^:>]+):(\d+)>$/);
        return `${key}: ${custom ? `${custom[1]}/${custom[2]} ${value}` : value}`;
    }).join('\n');
}
function emojisListEmbed(overrides = {}, page = 1, pageSize = 8) {
    const all = emojiRegistryEntries();
    const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
    const safePage = Math.min(totalPages, Math.max(1, Number(page) || 1));
    const slice = all.slice((safePage - 1) * pageSize, safePage * pageSize);
    const lines = slice.map((entry, i) => {
        const mark = entry.custom ? ' *(custom)*' : '';
        const used = entry.usedIn?.length ? `\n   Used in: ${entry.usedIn.map(x => `\`${x}\``).join(', ')}` : '';
        const custom = String(entry.value).match(/^<a?:([^:>]+):(\d+)>$/);
        const copy = custom ? `\`${custom[1]}/${custom[2]}\` • ${entry.value}` : entry.value;
        return `**${(safePage - 1) * pageSize + i + 1}. ${entry.key}:** ${copy}${mark}${used}`;
    });
    return base(`${emoji('emoji')} AunXz Emojis`)
        .setDescription(`**STATUS**\n${emoji('enabled')} **Registry:** \`${all.length} entries\`\n\n${lines.join('\n\n') || 'No emojis registered yet.'}\n\nUse **/emoji set** for named defaults. Use **/em add** for a custom emoji. Use **/em edit** to edit embed text. Emojis used in registered embeds appear here automatically and disappear when no longer used.\n\n**Page ${safePage}/${totalPages}**`);
}
function emojisListRows(page = 1, pageSize = 8) {
    const total = emojiRegistryEntries().length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safe = Math.min(totalPages, Math.max(1, Number(page) || 1));
    return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`emoji:list:prev:${Math.max(1, safe - 1)}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(safe <= 1).setEmoji('◀️'), new ButtonBuilder().setCustomId(`emoji:page:${safe}`).setLabel(`${safe}/${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true), new ButtonBuilder().setCustomId(`emoji:list:next:${Math.min(totalPages, safe + 1)}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(safe >= totalPages).setEmoji('▶️'))];
}
function embedTextsListEmbed(page = 1, pageSize = 6) {
    const rows = db.listEmbedTexts(500);
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    const safePage = Math.min(totalPages, Math.max(1, Number(page) || 1));
    const slice = rows.slice((safePage - 1) * pageSize, safePage * pageSize);
    const lines = slice.map((r, i) => `**${(safePage - 1) * pageSize + i + 1}. \`${r.name}\`**\n**Title:** ${r.title || r.sourceTitle}\n**Description:** ${(r.description || '*none*').slice(0, 650)}`);
    return base(`${emoji('emoji')} Embed Text Registry`)
        .setDescription(`${lines.join('\n\n') || 'No embed texts have been registered yet. Use the bot normally, then run this again.'}\n\n**Page ${safePage}/${totalPages} • ${rows.length} registered embeds**`);
}
function embedTextsListRows(page = 1, pageSize = 6) {
    const total = Math.max(1, Math.ceil(db.listEmbedTexts(500).length / pageSize));
    return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`em:list:prev:${Math.max(1, page - 1)}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1).setEmoji('◀️'), new ButtonBuilder().setCustomId(`em:page:${page}`).setLabel(`${page}/${total}`).setStyle(ButtonStyle.Secondary).setDisabled(true), new ButtonBuilder().setCustomId(`em:list:next:${Math.min(total, page + 1)}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= total).setEmoji('▶️'))];
}
function levelUpEmbed(text) {
    return base(`${emoji('level')} Level Up!`).setColor(OK).setDescription(text);
}
function leaderboardEmbed(guildName, rows, startRank = 1) {
    const desc = rows.length
        ? rows.map((r, i) => `**#${startRank + i}** <@${r.userId}> — Level ${r.level} (${r.xp} XP)`).join('\n')
        : 'No XP recorded yet.';
    return base(`${emoji('level')} ${guildName} Leaderboard`).setDescription(desc);
}
function configSummaryEmbed(moduleName, cfgObject) {
    const lines = Object.entries(cfgObject).map(([k, v]) => {
        let val = v;
        if (val === null || val === undefined)
            val = '—';
        if (Array.isArray(val))
            val = val.length ? val.join(', ') : '—';
        if (typeof val === 'object')
            val = '`' + JSON.stringify(val) + '`';
        return `**${k}:** ${val}`;
    });
    return base(`${emoji('settings')} ${moduleName} Settings`).setDescription(lines.join('\n') || 'No settings.');
}
function moduleListEmbed(modules) {
    return base(`${emoji('settings')} All Setup Modules`)
        .setDescription(modules.map(m => `• \`${m}\``).join('\n'))
        .setFooter({ text: `${BRAND_FOOTER} • Use /<module> setup to configure` });
}
const SETUP_MODULE_META = {
    antinuke: { emojiKey: 'shield', title: 'Antinuke', cfgKey: 'antinuke' },
    antilink: { emojiKey: 'link', title: 'Antilink', cfgKey: 'antilink' },
    antispam: { emojiKey: 'spam', title: 'Antispam', cfgKey: 'antispam' },
    antiraid: { emojiKey: 'raid', title: 'Antiraid', cfgKey: 'antiraid' },
    antiwebhook: { emojiKey: 'shield', title: 'Anti-Webhook', cfgKey: 'antiwebhook' },
    antibot: { emojiKey: 'shield', title: 'Anti-Bot', cfgKey: 'antibot' },
    antialt: { emojiKey: 'shield', title: 'Anti-Alt', cfgKey: 'antialt' },
    voicemaster: { emojiKey: 'voice', title: 'Voicemaster', cfgKey: 'voicemaster' },
    greetmessage: { emojiKey: 'wave', title: 'Greet Message', cfgKey: 'greetmessage' },
    leveling: { emojiKey: 'level', title: 'Leveling', cfgKey: 'leveling' },
    tickets: { emojiKey: 'ticket', title: 'Tickets', cfgKey: 'ticket' }
};
function setupPanelEmbed(sub, cfg) {
    const meta = SETUP_MODULE_META[sub];
    const modcfg = cfg[meta.cfgKey];
    const status = modcfg.enabled ? `${emoji('enabled')} Enabled` : `${emoji('disabled')} Disabled`;
    const lines = Object.entries(modcfg).filter(([k]) => k !== 'enabled').map(([k, v]) => {
        let val = v;
        if (val === null || val === undefined)
            val = '—';
        if (Array.isArray(val))
            val = val.length ? val.join(', ') : '—';
        if (typeof val === 'object')
            val = '`' + JSON.stringify(val) + '`';
        return `**${k}:** ${val}`;
    });
    return base(`${emoji(meta.emojiKey)} ${meta.title} — Setup`)
        .setDescription(`**Status:** ${status}\n\n${lines.join('\n')}\n\n` +
        'Every option below is fully unlocked for you to customize — use the buttons to toggle it or edit its settings.');
}
function setupPanelRow(sub, cfg) {
    const meta = SETUP_MODULE_META[sub];
    const enabled = cfg[meta.cfgKey].enabled;
    if (['antiwebhook', 'antibot', 'antialt'].includes(sub)) {
        const rows = [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`setup_toggle:${sub}`).setLabel(enabled ? 'Disable' : 'Enable').setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(enabled ? emoji('disabled') : emoji('enabled')), new ButtonBuilder().setCustomId(`setup_edit:${sub}`).setLabel('Edit Settings').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')))];
        if (sub === 'antiwebhook') {
            rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('security_cfg:antiwebhook:action').setPlaceholder('Choose webhook action…').addOptions({ label: 'Delete webhook', value: 'delete', emoji: '🗑️' }, { label: 'Kick creator', value: 'kick', emoji: '👢' }, { label: 'Ban creator', value: 'ban', emoji: '🔨' }, { label: 'Strip roles', value: 'strip_roles', emoji: '🔒' })));
            rows.push(new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('security_cfg:antiwebhook:bypass').setPlaceholder('Select trusted inviter role…')));
        }
        else if (sub === 'antibot') {
            rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('security_cfg:antibot:action').setPlaceholder('Choose unapproved bot action…').addOptions({ label: 'Kick', value: 'kick', emoji: '👢' }, { label: 'Ban', value: 'ban', emoji: '🔨' }, { label: 'Strip roles', value: 'strip_roles', emoji: '🔒' })));
            rows.push(new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('security_cfg:antibot:bypass').setPlaceholder('Select bypass role…')));
        }
        else {
            rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('security_cfg:antialt:action').setPlaceholder('Choose new-account action…').addOptions({ label: 'Kick', value: 'kick', emoji: '👢' }, { label: 'Ban', value: 'ban', emoji: '🔨' })));
            rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('security_cfg:antialt:age').setPlaceholder('Minimum account age…').addOptions([1, 3, 7, 14, 30, 60, 90].map(v => ({ label: `${v} day${v === 1 ? '' : 's'}`, value: String(v) })))));
        }
        rows.push(new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`security_cfg:${sub}:log`).setPlaceholder('Select security log channel…').addChannelTypes(ChannelType.GuildText)));
        return rows;
    }
    return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`setup_toggle:${sub}`).setLabel(enabled ? 'Disable' : 'Enable').setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(enabled ? emoji('disabled') : emoji('enabled')), new ButtonBuilder().setCustomId(`setup_edit:${sub}`).setLabel('Edit Settings').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')))];
}
function vmKickPromptEmbed() {
    return base(`${emoji('kick')} Kick From Voice Channel`)
        .setDescription(`Pick the member you'd like to disconnect from your channel below. ${emoji('lock')} Only you can see and use this menu.`);
}
function vmKickSelectRow(members) {
    const menu = new StringSelectMenuBuilder()
        .setCustomId('vm_kick_pick')
        .setPlaceholder('Choose a member to disconnect…')
        .addOptions(members.slice(0, 25).map(m => ({ label: m.displayName.slice(0, 100), value: m.id, emoji: emoji('mute') })));
    return new ActionRowBuilder().addComponents(menu);
}
function vmKickNobodyEmbed() {
    return warnEmbed(`${emoji('nobody')} Nobody To Kick`, 'There\'s no one else in your voice channel right now.');
}
function vmKickGoneEmbed(userId) {
    return warnEmbed(`${emoji('already_gone')} Already Gone`, `Looks like <@${userId}> isn't in the voice channel anymore — nothing to do here! ${emoji('balloon')}`);
}
function vmKickedEmbed(tag) {
    return okEmbed(`${emoji('kick')} Member Removed`, `**${tag}** has been disconnected from the voice channel. ${emoji('wave')}`);
}
function featureSetupEmbed(title, description, fields = []) {
    const e = base(`${emoji('settings')} ${title}`).setDescription(description);
    if (fields.length)
        e.addFields(fields.slice(0, 25));
    return e;
}
function featureSetupRow(prefix, buttons = ['edit', 'post']) {
    const map = { edit: ['Edit Settings', ButtonStyle.Primary, 'settings'], post: ['Post Panel', ButtonStyle.Success, 'success'], test: ['Test', 'test', 'success'] };
    return new ActionRowBuilder().addComponents(buttons.map(k => {
        const [label, style, key] = map[k] || [k, ButtonStyle.Secondary, 'settings'];
        return new ButtonBuilder().setCustomId(`${prefix}:${k}`).setLabel(label).setStyle(style === 'test' ? ButtonStyle.Secondary : style).setEmoji(emoji(key));
    }));
}
function selectedPanel(cfg, kind, selectedId) {
    const key = kind === 'button' ? 'buttonRolePanels' : 'reactionRolePanels';
    const list = Array.isArray(cfg[key]) ? cfg[key] : [];
    return list.find(p => p.id === selectedId) || list[0] || null;
}
function panelStatus(panel) { return panel?.enabled === false ? `${emoji('disabled')} Disabled` : `${emoji('enabled')} Enabled`; }
function buttonRoleEmbed(cfg, selectedId) {
    const panels = Array.isArray(cfg.buttonRolePanels) ? cfg.buttonRolePanels : [];
    const panel = selectedPanel(cfg, 'button', selectedId);
    const list = panels.slice(0, 12).map((p, i) => `${i + 1}. **${p.title || `Panel ${i + 1}`}** — ${p.enabled === false ? 'Disabled' : 'Enabled'} — ${p.buttons?.length || 0} role(s)${p.messageId ? ' • posted' : ''}`).join('\n') || 'No panels yet. Press **Create Panel**.';
    return featureSetupEmbed('Button Roles', 'Create multiple independent role panels. Roles are selected with Discord’s native role picker — no role IDs to copy.', [
        { name: 'Panels', value: list, inline: false },
        { name: 'Selected', value: panel ? `${panel.title || 'Untitled'}
${panel.channelId ? `<#${panel.channelId}>` : 'Channel not set'}
${panelStatus(panel)}` : 'None', inline: false },
        { name: 'Role buttons', value: panel ? String((panel.buttons || []).length) : '0', inline: true },
        { name: 'Style', value: panel?.embedType || 'embed', inline: true }
    ]);
}
function buttonRoleSetupRows(cfg, selectedId) {
    const panels = Array.isArray(cfg.buttonRolePanels) ? cfg.buttonRolePanels : [];
    const panel = selectedPanel(cfg, 'button', selectedId);
    const rows = [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('buttonroles_cfg:create').setLabel('Create Panel').setStyle(ButtonStyle.Success).setEmoji(emoji('add')), new ButtonBuilder().setCustomId('buttonroles_cfg:toggle').setLabel(panel?.enabled === false ? 'Enable' : 'Disable').setStyle(panel?.enabled === false ? ButtonStyle.Success : ButtonStyle.Danger).setDisabled(!panel), new ButtonBuilder().setCustomId('buttonroles_cfg:delete').setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji(emoji('delete')).setDisabled(!panel))];
    if (panels.length)
        rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('buttonroles_cfg:select').setPlaceholder('Select a button-role panel…')
            .addOptions(panels.slice(0, 25).map((p, i) => ({ label: (p.title || `Panel ${i + 1}`).slice(0, 100), value: p.id, description: `${p.buttons?.length || 0} role(s) • ${p.enabled === false ? 'disabled' : 'enabled'}` })))));
    if (panel) {
        rows.push(new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`buttonroles_cfg:channel:${panel.id}`).setPlaceholder('Select where this panel should be posted…').setChannelTypes(ChannelType.GuildText)));
        rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`buttonroles_cfg:settings:${panel.id}`).setLabel('Panel Text').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')), new ButtonBuilder().setCustomId(`buttonroles_cfg:addrole:${panel.id}`).setLabel('Add Role').setStyle(ButtonStyle.Primary).setEmoji(emoji('add'))));
        rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`buttonroles_cfg:upload:${panel.id}`).setLabel('Send Image/GIF').setStyle(ButtonStyle.Secondary).setEmoji('🖼️'), new ButtonBuilder().setCustomId(`buttonroles_cfg:remove_image:${panel.id}`).setLabel('Remove Image').setStyle(ButtonStyle.Secondary).setDisabled(!panel.image), new ButtonBuilder().setCustomId(`buttonroles_cfg:post:${panel.id}`).setLabel(panel.messageId ? 'Post Again' : 'Post Panel').setStyle(ButtonStyle.Success)));
        const roles = panel.buttons || [];
        if (roles.length)
            rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`buttonroles_cfg:remove_role:${panel.id}`).setPlaceholder('Remove a role button…')
                .addOptions(roles.slice(0, 25).map((r, i) => ({ label: (r.label || `Role ${i + 1}`).slice(0, 100), value: r.roleId })))));
    }
    return rows.slice(0, 5);
}
function reactionRoleSetupEmbed(cfg, selectedId) {
    const panels = Array.isArray(cfg.reactionRolePanels) ? cfg.reactionRolePanels : [];
    const panel = selectedPanel(cfg, 'reaction', selectedId);
    const list = panels.slice(0, 12).map((p, i) => `${i + 1}. **${p.title || `Panel ${i + 1}`}** — ${p.enabled === false ? 'Disabled' : 'Enabled'} — ${p.mappings?.length || 0} role(s)${p.messageId ? ' • posted' : ''}`).join('\n') || 'No panels yet. Press **Create Panel**.';
    return featureSetupEmbed('Reaction Roles', 'Create multiple independent reaction-role panels. Roles are selected with Discord’s native role picker — no role IDs to copy.', [
        { name: 'Panels', value: list, inline: false },
        { name: 'Selected', value: panel ? `${panel.title || 'Untitled'}
${panel.channelId ? `<#${panel.channelId}>` : 'Channel not set'}
${panelStatus(panel)}` : 'None', inline: false },
        { name: 'Mappings', value: panel ? String((panel.mappings || []).length) : '0', inline: true },
        { name: 'Message', value: panel?.messageId ? `#${panel.messageId}` : 'Not posted', inline: true }
    ]);
}
function reactionRoleSetupRows(cfg, selectedId) {
    const panels = Array.isArray(cfg.reactionRolePanels) ? cfg.reactionRolePanels : [];
    const panel = selectedPanel(cfg, 'reaction', selectedId);
    const rows = [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('reactionroles_cfg:create').setLabel('Create Panel').setStyle(ButtonStyle.Success).setEmoji(emoji('add')), new ButtonBuilder().setCustomId('reactionroles_cfg:toggle').setLabel(panel?.enabled === false ? 'Enable' : 'Disable').setStyle(panel?.enabled === false ? ButtonStyle.Success : ButtonStyle.Danger).setDisabled(!panel), new ButtonBuilder().setCustomId('reactionroles_cfg:delete').setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji(emoji('delete')).setDisabled(!panel))];
    if (panels.length)
        rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('reactionroles_cfg:select').setPlaceholder('Select a reaction-role panel…')
            .addOptions(panels.slice(0, 25).map((p, i) => ({ label: (p.title || `Panel ${i + 1}`).slice(0, 100), value: p.id, description: `${p.mappings?.length || 0} role(s) • ${p.enabled === false ? 'disabled' : 'enabled'}` })))));
    if (panel) {
        rows.push(new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`reactionroles_cfg:channel:${panel.id}`).setPlaceholder('Select where this panel should be posted…').setChannelTypes(ChannelType.GuildText)));
        rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`reactionroles_cfg:settings:${panel.id}`).setLabel('Panel Text').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')), new ButtonBuilder().setCustomId(`reactionroles_cfg:addrole:${panel.id}`).setLabel('Add Role').setStyle(ButtonStyle.Primary).setEmoji(emoji('add'))));
        rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`reactionroles_cfg:post:${panel.id}`).setLabel(panel.messageId ? 'Post Again' : 'Post Panel').setStyle(ButtonStyle.Success)));
        const roles = panel.mappings || [];
        if (roles.length)
            rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`reactionroles_cfg:remove_role:${panel.id}`).setPlaceholder('Remove a reaction-role mapping…')
                .addOptions(roles.slice(0, 25).map((r, i) => ({ label: (r.label || r.emoji || `Role ${i + 1}`).slice(0, 100), value: r.roleId })))));
    }
    return rows.slice(0, 5);
}
function staffApplicationEmbed(cfg) {
    return featureSetupEmbed('Staff Applications', 'Members press Apply, receive a DM, choose Ready, then answer your questions one by one.', [
        { name: 'Questions', value: String((cfg.questions || []).length), inline: true }, { name: 'Application log', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Not set', inline: true }
    ]);
}
function birthdaySetupEmbed(cfg) {
    return featureSetupEmbed('Birthday System', 'Members press the birthday button and enter a date such as 8-8. The bot posts wishes in the configured wish channel.', [
        { name: 'Panel', value: cfg.panelChannelId ? `<#${cfg.panelChannelId}>` : 'Not set', inline: true }, { name: 'Wish channel', value: cfg.wishChannelId ? `<#${cfg.wishChannelId}>` : 'Not set', inline: true }
    ]);
}
function honeypotSetupEmbed(cfg) {
    cfg = cfg || {};
    return featureSetupEmbed('Honeypot', 'This channel is a no-message zone. A message or image sent there triggers your selected action.', [
        { name: 'Status', value: cfg.enabled === false ? `${emoji('disabled')} Disabled` : `${emoji('enabled')} Enabled`, inline: true },
        { name: 'Channel', value: cfg.channelId ? `<#${cfg.channelId}>` : 'Not set', inline: true }, { name: 'Action', value: cfg.action || 'kick', inline: true }, { name: 'Cleanup', value: cfg.cleanupWindow || 'none', inline: true },
        { name: 'Log channel', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Not set', inline: true },
        { name: 'Whitelisted roles', value: (cfg.whitelistRoleIds || []).length ? cfg.whitelistRoleIds.map(r => `<@&${r}>`).join(' ') : 'None', inline: true }
    ]);
}
function birthdaySetupRow(cfg) {
    return [
        new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('birthday_cfg:panel').setPlaceholder('Select birthday panel channel').setChannelTypes(ChannelType.GuildText)),
        new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('birthday_cfg:wish').setPlaceholder('Select birthday wish channel').setChannelTypes(ChannelType.GuildText)),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('birthday_cfg:message').setLabel('Set Wish Message').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')), new ButtonBuilder().setCustomId('birthday_cfg:post').setLabel('Post / Refresh Panel').setStyle(ButtonStyle.Success).setEmoji(emoji('success')))
    ];
}
function antiBadwordSetupEmbed(cfg) {
    return featureSetupEmbed('Anti Bad Word', 'Multilingual profanity protection with Unicode normalization and Hinglish/romanized profanity patterns. Choose the log channel and action below.', [
        { name: 'Status', value: cfg.enabled ? 'Enabled' : 'Disabled', inline: true }, { name: 'Log', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Not set', inline: true }, { name: 'Action', value: cfg.action || 'delete', inline: true }, { name: 'Custom words', value: String((cfg.customWords || []).length), inline: true }
    ]);
}
function antiBadwordSetupRow(cfg) {
    return [
        new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('antibadword_cfg:log').setPlaceholder('Select logging channel').setChannelTypes(ChannelType.GuildText)),
        new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('antibadword_cfg:action').setPlaceholder(`Action: ${cfg.action || 'delete'}`).addOptions({ label: 'Delete only', value: 'delete', emoji: emoji('delete') }, { label: 'Delete + timeout', value: 'timeout', emoji: emoji('mute') })),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('antibadword_cfg:words').setLabel('Add Custom Words').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')), new ButtonBuilder().setCustomId('antibadword_cfg:toggle').setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(cfg.enabled ? emoji('disabled') : emoji('enabled')))
    ];
}
function honeypotSetupRow(cfg) {
    cfg = cfg || {};
    return [
        new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('honeypot_cfg:channel').setPlaceholder('Select honeypot channel').setChannelTypes(ChannelType.GuildText)),
        new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('honeypot_cfg:action').setPlaceholder(`Action: ${cfg.action || 'kick'}`).addOptions({ label: 'Kick', value: 'kick', emoji: emoji('kick') }, { label: 'Ban', value: 'ban', emoji: emoji('shield') }, { label: 'Timeout', value: 'timeout', emoji: emoji('mute') }, { label: 'Delete only', value: 'delete', emoji: emoji('delete') })),
        new ActionRowBuilder().addComponents((() => { const m = new RoleSelectMenuBuilder().setCustomId('honeypot_cfg:roles').setPlaceholder('Whitelisted roles (immune to the trap)').setMinValues(0).setMaxValues(5); if ((cfg.whitelistRoleIds || []).length)
            m.setDefaultRoles(...cfg.whitelistRoleIds.slice(0, 5)); return m; })()),
        new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('honeypot_cfg:log').setPlaceholder('Select log channel').setChannelTypes(ChannelType.GuildText)),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('honeypot_cfg:toggle').setLabel(cfg.enabled === false ? 'Disabled' : 'Enabled').setStyle(cfg.enabled === false ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(cfg.enabled === false ? emoji('disabled') : emoji('enabled')), new ButtonBuilder().setCustomId('honeypot_cfg:invite').setLabel(cfg.createInvite ? 'Invite DM: ON' : 'Invite DM: OFF').setStyle(cfg.createInvite ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji(emoji('link')), new ButtonBuilder().setCustomId('honeypot_cfg:dm').setLabel('Set Kick DM').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')), new ButtonBuilder().setCustomId('honeypot_cfg:cleanupcycle').setLabel(`Cleanup: ${cfg.cleanupWindow || 'none'}`).setStyle(ButtonStyle.Secondary).setEmoji(emoji('clear')))
    ];
}
function ttsVoiceMeta(key) {
    try {
        const v = require('./systems').TTS_VOICES;
        return v[key] || v.us;
    }
    catch {
        return { label: 'US English', description: '' };
    }
}
function greetVoiceSetupEmbed(cfg, notes = []) {
    const mode = cfg.mode === 'audio' ? '🎵 Uploaded audio' : '🗣️ Text-to-speech';
    const audio = cfg.audioPath ? 'Uploaded and saved' : 'Not uploaded';
    const fields = [
        { name: 'Status', value: cfg.enabled ? `${emoji('enabled')} Enabled` : `${emoji('disabled')} Disabled`, inline: true },
        { name: 'Mode', value: mode, inline: true },
        { name: 'TTS Voice', value: ttsVoiceMeta(cfg.ttsVoice).label, inline: true },
        { name: 'Gate Role', value: cfg.roleId ? `<@&${cfg.roleId}>` : 'Not set', inline: true },
        { name: 'Greeting Voice Channel', value: cfg.vcId ? `<#${cfg.vcId}>` : 'Not set', inline: true },
        { name: 'Audio File', value: audio, inline: true },
        { name: 'TTS Prompt', value: cfg.ttsPrompt ? String(cfg.ttsPrompt).slice(0, 600) : 'Not set — press **Set Prompt** then send your text as a message below.', inline: false }
    ];
    if (notes.length)
        fields.push({ name: 'Setup Report', value: notes.join('\n').slice(0, 900), inline: false });
    return featureSetupEmbed('Greet Voice', 'New members get the gate role → join the greeting voice channel → hear your TTS/audio greeting → are disconnected and the role is removed. The gate role can only see the greeting channel.', fields);
}
function greetVoiceSetupRow(cfg) {
    const voices = (() => { try {
        return require('./systems').TTS_VOICES;
    }
    catch {
        return { us: { label: 'US English', description: '' } };
    } })();
    const voiceMenu = new StringSelectMenuBuilder().setCustomId('greetvoice_cfg:ttsvoice').setPlaceholder('TTS voice / accent')
        .addOptions(Object.entries(voices).map(([value, v]) => ({ label: v.label.slice(0, 100), description: String(v.description || '').slice(0, 100), value, default: (cfg.ttsVoice || 'us') === value })));
    const channelMenu = new ChannelSelectMenuBuilder().setCustomId('greetvoice_cfg:voice').setPlaceholder('Choose the greeting voice channel').setChannelTypes(ChannelType.GuildVoice);
    if (cfg.vcId)
        channelMenu.setDefaultChannels(cfg.vcId);
    const roleMenu = new RoleSelectMenuBuilder().setCustomId('greetvoice_cfg:role_select').setPlaceholder('Choose the Greet Voice (gate) role');
    if (cfg.roleId)
        roleMenu.setDefaultRoles(cfg.roleId);
    return [
        new ActionRowBuilder().addComponents(channelMenu),
        new ActionRowBuilder().addComponents(roleMenu),
        new ActionRowBuilder().addComponents(voiceMenu),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('greetvoice_cfg:prompt').setLabel('Set Prompt').setStyle(ButtonStyle.Primary).setEmoji('✏️'), new ButtonBuilder().setCustomId('greetvoice_cfg:audio').setLabel(cfg.audioPath ? 'Replace Audio' : 'Upload Audio').setStyle(ButtonStyle.Secondary).setEmoji('🎵'), new ButtonBuilder().setCustomId('greetvoice_cfg:mode').setLabel(cfg.mode === 'audio' ? 'Use TTS' : 'Use Audio').setStyle(ButtonStyle.Secondary).setEmoji('🔁'), new ButtonBuilder().setCustomId('greetvoice_cfg:test').setLabel('Test').setStyle(ButtonStyle.Secondary).setEmoji('▶️'), new ButtonBuilder().setCustomId('greetvoice_cfg:toggle').setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(cfg.enabled ? emoji('disabled') : emoji('enabled')))
    ];
}
function greetMessageSetupEmbed(cfg, notes = []) {
    const fields = [
        { name: 'Status', value: cfg.enabled ? `${emoji('enabled')} Enabled` : `${emoji('disabled')} Disabled`, inline: true },
        { name: 'Channel', value: cfg.channelId ? `<#${cfg.channelId}>` : 'Not set', inline: true },
        { name: 'Ping Member', value: cfg.ping === false ? 'Off' : 'On', inline: true },
        { name: 'Member Avatar', value: cfg.showAvatar === false ? 'Hidden' : 'Shown', inline: true },
        { name: 'Accent Color', value: cfg.color ? `#${Number(cfg.color).toString(16).padStart(6, '0')}` : 'Default', inline: true },
        { name: 'Image / GIF', value: cfg.image ? 'Set' : 'None', inline: true },
        { name: 'Title', value: String(cfg.title || '👋 Welcome!').slice(0, 200), inline: false },
        { name: 'Message', value: String(cfg.message || 'Welcome {user}!').slice(0, 700), inline: false }
    ];
    if (notes.length)
        fields.push({ name: 'Note', value: notes.join('\n').slice(0, 500), inline: false });
    return featureSetupEmbed('Greet Message', 'Posts a welcome card when someone joins. Placeholders: `{user}` `{server}` `{count}`.', fields);
}
function greetMessageSetupRow(cfg) {
    const channelMenu = new ChannelSelectMenuBuilder().setCustomId('greetmessage_cfg:channel').setPlaceholder('Choose the welcome channel').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
    if (cfg.channelId)
        channelMenu.setDefaultChannels(cfg.channelId);
    const optionMenu = new StringSelectMenuBuilder().setCustomId('greetmessage_cfg:option').setPlaceholder('Edit an option…').addOptions({ label: 'Message text', description: 'Send the text as a message below', value: 'message', emoji: '💬' }, { label: 'Title', description: 'Pop-up form', value: 'title', emoji: '🏷️' }, { label: 'Accent color', description: 'Pop-up form (hex)', value: 'color', emoji: '🎨' }, { label: 'Image / GIF', description: 'Send an image or link below', value: 'image', emoji: '🖼️' }, { label: 'Remove image', description: 'Clear the banner', value: 'clear_image', emoji: '🗑️' });
    return [
        new ActionRowBuilder().addComponents(channelMenu),
        new ActionRowBuilder().addComponents(optionMenu),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('greetmessage_cfg:toggle').setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(cfg.enabled ? emoji('disabled') : emoji('enabled')), new ButtonBuilder().setCustomId('greetmessage_cfg:ping').setLabel(cfg.ping === false ? 'Ping: Off' : 'Ping: On').setStyle(cfg.ping === false ? ButtonStyle.Secondary : ButtonStyle.Success), new ButtonBuilder().setCustomId('greetmessage_cfg:avatar').setLabel(cfg.showAvatar === false ? 'Avatar: Off' : 'Avatar: On').setStyle(cfg.showAvatar === false ? ButtonStyle.Secondary : ButtonStyle.Success), new ButtonBuilder().setCustomId('greetmessage_cfg:test').setLabel('Preview').setStyle(ButtonStyle.Primary).setEmoji('👁️'), new ButtonBuilder().setCustomId('greetmessage_cfg:reset').setLabel('Reset').setStyle(ButtonStyle.Danger).setEmoji('♻️'))
    ];
}
function autoresponderSetupEmbed(cfg) {
    const triggers = cfg.triggers || [];
    const list = triggers.slice(0, 10).map((t, i) => `**${i + 1}.** \`${t.match}\` (${t.mode}) → ${String(t.response || '').slice(0, 60)}`).join('\n') || 'No triggers yet — press Add Trigger to create one.';
    return featureSetupEmbed('Auto Responder', 'Automatically replies when a message matches a phrase. Use `{user}` and `{server}` in the response text.', [
        { name: 'Status', value: cfg.enabled ? 'Enabled' : 'Disabled', inline: true },
        { name: 'Triggers', value: String(triggers.length), inline: true },
        { name: 'Matching', value: cfg.ignoreCase ? 'Case-insensitive' : 'Case-sensitive', inline: true },
        { name: 'Current triggers', value: list, inline: false }
    ]);
}
function autoresponderSetupRow(cfg) {
    const triggers = cfg.triggers || [];
    const rows = [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('autoresponder_cfg:toggle').setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(cfg.enabled ? emoji('disabled') : emoji('enabled')), new ButtonBuilder().setCustomId('autoresponder_cfg:add').setLabel('Add Trigger').setStyle(ButtonStyle.Primary).setEmoji(emoji('add')), new ButtonBuilder().setCustomId('autoresponder_cfg:case').setLabel(cfg.ignoreCase ? 'Case: Insensitive' : 'Case: Sensitive').setStyle(ButtonStyle.Secondary).setEmoji(emoji('settings')))];
    if (triggers.length) {
        rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('autoresponder_cfg:remove').setPlaceholder('Remove a trigger…')
            .addOptions(triggers.slice(0, 25).map(t => ({ label: (t.match || '(empty)').slice(0, 90), value: t.id, emoji: emoji('remove') })))));
    }
    return rows;
}
function autoreactorSetupEmbed(cfg) {
    const triggers = cfg.triggers || [];
    const list = triggers.slice(0, 10).map((t, i) => `**${i + 1}.** \`${t.match}\` (${t.mode}) → ${(t.emojis || []).join(' ')}`).join('\n') || 'No triggers yet — press Add Trigger to create one.';
    return featureSetupEmbed('Auto Reactor', 'Automatically reacts with emoji when a message matches a phrase.', [
        { name: 'Status', value: cfg.enabled ? 'Enabled' : 'Disabled', inline: true },
        { name: 'Triggers', value: String(triggers.length), inline: true },
        { name: 'Matching', value: cfg.ignoreCase ? 'Case-insensitive' : 'Case-sensitive', inline: true },
        { name: 'Current triggers', value: list, inline: false }
    ]);
}
function autoreactorSetupRow(cfg) {
    const triggers = cfg.triggers || [];
    const rows = [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('autoreactor_cfg:toggle').setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(cfg.enabled ? emoji('disabled') : emoji('enabled')), new ButtonBuilder().setCustomId('autoreactor_cfg:add').setLabel('Add Trigger').setStyle(ButtonStyle.Primary).setEmoji(emoji('add')), new ButtonBuilder().setCustomId('autoreactor_cfg:case').setLabel(cfg.ignoreCase ? 'Case: Insensitive' : 'Case: Sensitive').setStyle(ButtonStyle.Secondary).setEmoji(emoji('settings')))];
    if (triggers.length) {
        rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('autoreactor_cfg:remove').setPlaceholder('Remove a trigger…')
            .addOptions(triggers.slice(0, 25).map(t => ({ label: (t.match || '(empty)').slice(0, 90), value: t.id, emoji: emoji('remove') })))));
    }
    return rows;
}
function logSetupEmbed(cfg = {}) {
    const labels = [
        ['mod', 'Moderation'], ['message', 'Messages'], ['member', 'Members'], ['voice', 'Voice'],
        ['antinuke', 'Anti-Nuke'], ['server', 'Roles / Channels / Server'], ['ticket', 'Tickets'], ['join', 'Join / Leave']
    ];
    const events = cfg.events || {};
    const eventLabels = [
        ['messageCreate','Message creation'],['messageDelete','Message deletion'],['messageUpdate','Message edits'],['bulkDelete','Bulk deletion'],
        ['memberJoin','Member joins'],['memberLeave','Member leaves'],['memberUpdate','Member profile changes'],['memberRoles','Member role changes'],
        ['roleCreate','Role creation'],['roleDelete','Role deletion'],['roleUpdate','Role/permission changes'],
        ['channelCreate','Channel creation'],['channelDelete','Channel deletion'],['channelUpdate','Channel/settings changes'],['guildUpdate','Server settings'],
        ['banAdd','Bans'],['banRemove','Unbans'],['voiceStateUpdate','Voice changes'],['inviteCreate','Invite creation'],['inviteDelete','Invite deletion']
    ];
    const enabledCount = eventLabels.filter(([key]) => events[key] !== false && !(key === 'messageCreate' && events[key] === undefined)).length;
    const text = labels.map(([key, label]) => `**${label}:** ${cfg[key] ? `<#${cfg[key]}>` : 'Not set'}`).join('\n');
    const eventText = eventLabels.map(([key, label]) => `${events[key] === false || (key === 'messageCreate' && events[key] === undefined) ? '▫️' : '✅'} ${label}`).join('\n');
    return featureSetupEmbed('Logging Control Center', `Configure real server-activity logs. Settings persist per server.

**System:** ${cfg.enabled === false ? '🔴 Disabled' : '🟢 Enabled'}
**Event types on:** ${enabledCount}/${eventLabels.length}
**Detail:** ${cfg.detailMode || 'detailed'} • **Content retention:** ${Number.isInteger(cfg.evidenceRetentionDays) ? cfg.evidenceRetentionDays : 7} days

Choose a stream and destination, or select an event below to toggle it. Message creation is off by default to prevent log spam.`, [
        { name: 'Log destinations', value: text, inline: false },
        { name: 'Event toggles', value: eventText.slice(0, 1024), inline: false }
    ]);
}
function logSetupRows(cfg = {}) {
    const labels = [
        ['mod', 'Moderation'], ['message', 'Messages'], ['member', 'Members'], ['voice', 'Voice'],
        ['antinuke', 'Anti-Nuke'], ['server', 'Roles / Channels / Server'], ['ticket', 'Tickets'], ['join', 'Join / Leave']
    ];
    const typeMenu = new StringSelectMenuBuilder()
        .setCustomId('logsetup:type')
        .setPlaceholder('1. Select a log stream…')
        .addOptions(labels.map(([value, label]) => ({ label, value, description: cfg[value] ? `Currently: ${cfg[value]}` : 'Not configured yet' })));
    const channelMenu = new ChannelSelectMenuBuilder()
        .setCustomId('logsetup:channel')
        .setPlaceholder('2. Select the destination channel…')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
    const eventLabels = [
        ['messageCreate','Message creation'],['messageDelete','Message deletion'],['messageUpdate','Message edits'],['bulkDelete','Bulk deletion'],
        ['memberJoin','Member joins'],['memberLeave','Member leaves'],['memberUpdate','Member profile changes'],['memberRoles','Member role changes'],
        ['roleCreate','Role creation'],['roleDelete','Role deletion'],['roleUpdate','Role/permission changes'],
        ['channelCreate','Channel creation'],['channelDelete','Channel deletion'],['channelUpdate','Channel/settings changes'],['guildUpdate','Server settings'],
        ['banAdd','Bans'],['banRemove','Unbans'],['voiceStateUpdate','Voice changes'],['inviteCreate','Invite creation'],['inviteDelete','Invite deletion']
    ];
    const events = cfg.events || {};
    const eventMenu = new StringSelectMenuBuilder().setCustomId('logsetup:event')
        .setPlaceholder('Toggle an individual event…')
        .addOptions(eventLabels.map(([value,label]) => ({ label: `${events[value] === false || (value === 'messageCreate' && events[value] === undefined) ? 'OFF · ' : 'ON · '}${label}`.slice(0,100), value, description: `Click to ${events[value] === false || (value === 'messageCreate' && events[value] === undefined) ? 'enable' : 'disable'} this event` })));
    const controlRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('logsetup:toggle-system').setLabel(cfg.enabled === false ? 'Enable logging' : 'Disable logging').setStyle(cfg.enabled === false ? ButtonStyle.Success : ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('logsetup:all-on').setLabel('Enable all events').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('logsetup:all-off').setLabel('Disable all events').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('logsetup:test').setLabel('Test selected stream').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('logsetup:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary)
    );
    return [new ActionRowBuilder().addComponents(typeMenu), new ActionRowBuilder().addComponents(channelMenu), new ActionRowBuilder().addComponents(eventMenu), controlRow];
}

function ownerLogSetupEmbed(cfg = {}) {
    const e = base(`${emoji('owner')} Owner Log Control Center`);
    e.setDescription(`Configure where AunXz sends its global owner logs.\n\n` +
        `**Error logs:** ${cfg.errorChannelId ? `<#${cfg.errorChannelId}>` : '*not set*'}\n` +
        `**Online/offline logs:** ${cfg.onlineChannelId ? `<#${cfg.onlineChannelId}>` : '*not set*'}\n` +
        `**Join logs:** ${cfg.joinChannelId ? `<#${cfg.joinChannelId}>` : '*not set*'}\n\n` +
        `The selected channels are global to the bot and are only configurable by bot owners.`);
    return e;
}
function ownerLogSetupRows(cfg = {}) {
    return [
        new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('ownerlogsetup:error').setPlaceholder(cfg.errorChannelId ? 'Change error log channel…' : 'Select error log channel…').setChannelTypes(ChannelType.GuildText)),
        new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('ownerlogsetup:online').setPlaceholder(cfg.onlineChannelId ? 'Change online/offline channel…' : 'Select online/offline channel…').setChannelTypes(ChannelType.GuildText)),
        new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('ownerlogsetup:join').setPlaceholder(cfg.joinChannelId ? 'Change join log channel…' : 'Select join log channel…').setChannelTypes(ChannelType.GuildText))
    ];
}
function ownerJoinLogEmbed(guild) {
    return base(`${emoji('owner')} AunXz Joined a Server`)
        .setDescription(`**Server:** ${guild.name}\n` +
        `**ID:** \`${guild.id}\`\n` +
        `**Owner:** <@${guild.ownerId}>\n` +
        `**Members:** ${guild.memberCount || 0}\n` +
        `**Created:** <t:${Math.floor(guild.createdTimestamp / 1000)}:F>\n\n` +
        `Use **AunXz** for owner-only controls.`);
}
function ownerJoinLogRows(guildId) {
    return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`owner:guild:${guildId}`).setLabel('AunXz').setStyle(ButtonStyle.Primary).setEmoji(emoji('owner')))];
}
function ownerGuildControlEmbed(guild) {
    return base(`${emoji('owner')} Server Controls`)
        .setDescription(`**${guild.name}**\n\`${guild.id}\`\n\nChoose an owner action below.`);
}
function ownerGuildControlRows(guildId) {
    return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`owner:infoask:${guildId}`).setLabel('Server Info').setStyle(ButtonStyle.Primary).setEmoji(emoji('info') || 'ℹ️'), new ButtonBuilder().setCustomId(`owner:leave:${guildId}`).setLabel('Leave').setStyle(ButtonStyle.Danger).setEmoji(emoji('delete')), new ButtonBuilder().setCustomId(`owner:invite:${guildId}`).setLabel('Generate Invite').setStyle(ButtonStyle.Success).setEmoji(emoji('add')))];
}
function ownerInfoChoiceEmbed(guild) {
    return base(`${emoji('owner')} Server Info Access`)
        .setDescription(`Choose which member group should be included with the server report for **${guild.name}**.`);
}
function ownerInfoChoiceRows(guildId) {
    return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`owner:info:admins:${guildId}`).setLabel('Admins').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`owner:info:higher:${guildId}`).setLabel('Higher Roles').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`owner:info:none:${guildId}`).setLabel('Server Only').setStyle(ButtonStyle.Secondary))];
}
function membershipListEmbed(rows, page = 1, pageSize = 5) {
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    const safe = Math.min(totalPages, Math.max(1, Number(page) || 1));
    const slice = rows.slice((safe - 1) * pageSize, safe * pageSize);
    const now = Date.now();
    const lines = slice.map((r, i) => {
        const active = now < r.expiresAt;
        return `${(safe - 1) * pageSize + i + 1}. **${r.plan || 'Membership'}**\n` +
            `\`${r.guildId}\`\n` +
            `• Plan: **${r.plan}** | Status: ${active ? `${emoji('enabled')} Active` : `${emoji('disabled')} Expired`}\n` +
            `• Expires: <t:${Math.floor(r.expiresAt / 1000)}:F> (<t:${Math.floor(r.expiresAt / 1000)}:R>)`;
    });
    return base(`${emoji('owner')} AunXz Memberships`)
        .setDescription(`${lines.join('\n\n') || 'No memberships configured yet.'}\n\n**Page ${safe} of ${totalPages} • Total Subscriptions: ${rows.length}**`);
}
function membershipListRows(rows, page = 1, pageSize = 5) {
    const total = Math.max(1, Math.ceil(rows.length / pageSize));
    const safe = Math.min(total, Math.max(1, Number(page) || 1));
    return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ms:list:prev:${Math.max(1, safe - 1)}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(safe <= 1).setEmoji('◀️'), new ButtonBuilder().setCustomId(`ms:page:${safe}`).setLabel(`${safe}/${total}`).setStyle(ButtonStyle.Secondary).setDisabled(true), new ButtonBuilder().setCustomId(`ms:list:next:${Math.min(total, safe + 1)}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(safe >= total).setEmoji('▶️'))];
}
function embedBuilderPreviewEmbed(draft) {
    const e = base(draft.title || 'Untitled Embed');
    e.setDescription(draft.description || '*No description set — press Edit Text.*');
    if (draft.color) {
        const n = parseInt(String(draft.color).replace('#', ''), 16);
        if (!Number.isNaN(n))
            e.setColor(n);
    }
    if (draft.imageUrl)
        e.setImage(draft.imageUrl);
    if (draft.thumbnailUrl)
        e.setThumbnail(draft.thumbnailUrl);
    if (draft.footer)
        e.setFooter({ text: draft.footer.slice(0, 200) });
    if (draft.buttons?.length)
        e.addFields({ name: 'Buttons', value: draft.buttons.map((b, i) => `${i + 1}. **${b.label}** → ${b.response?.title || 'Private response'}`).join('\n').slice(0, 1024), inline: false });
    return e;
}
function embedBuilderRow(draft) {
    const buttons = draft.buttons || [];
    const rows = [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('embedbuilder:text').setLabel('Edit Text').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')), new ButtonBuilder().setCustomId('embedbuilder:image').setLabel('Edit Images').setStyle(ButtonStyle.Primary).setEmoji(emoji('settings')), new ButtonBuilder().setCustomId('embedbuilder:addbutton').setLabel('Add Response Button').setStyle(ButtonStyle.Secondary).setEmoji(emoji('add')), new ButtonBuilder().setCustomId('embedbuilder:save').setLabel('Save').setStyle(ButtonStyle.Success).setEmoji(emoji('success')))];
    if (buttons.length)
        rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('embedbuilder:removebutton').setPlaceholder(`Remove a button… (${buttons.length} added)`)
            .addOptions(buttons.slice(0, 25).map((b, i) => ({ label: (b.label || 'Button').slice(0, 100), value: String(i), emoji: emoji('remove') })))));
    return rows;
}
function flattenComponentRows(value, out = []) {
    if (!value)
        return out;
    if (Array.isArray(value)) {
        for (const item of value)
            flattenComponentRows(item, out);
        return out;
    }
    if (value instanceof ActionRowBuilder || value?.type === 1 || value?.data?.type === 1)
        out.push(value);
    else if (value?.toJSON && value.toJSON()?.type === 1)
        out.push(value);
    return out;
}
function sanitizeUniqueCustomIds(rows) {
    const seen = new Set();
    const out = [];
    for (const row of rows || []) {
        const data = typeof row?.toJSON === 'function' ? row.toJSON() : row;
        const children = Array.isArray(data?.components) ? data.components : [];
        if (!children.length)
            continue;
        const kept = [];
        for (const child of children) {
            const id = child?.custom_id;
            if (id && seen.has(id)) {
                console.warn(`[AunXz] Removed duplicate component custom_id: ${id}`);
                continue;
            }
            if (id)
                seen.add(id);
            kept.push(child);
        }
        if (kept.length)
            out.push(new ActionRowBuilder({ type: 1, components: kept }));
    }
    return out;
}
function embedToContainer(embedLike, rows = []) {
    const d = typeof embedLike?.toJSON === 'function' ? embedLike.toJSON() : (embedLike || {});
    const brand = embedStyles.getContainerBranding(d);
    const container = new ContainerBuilder();
    container.setAccentColor(brand.color);
    const intro = [];
    if (d.author?.name)
        intro.push(`**${emojify(d.author.name)}**`);
    if (d.title)
        intro.push(d.url ? `## [${emojify(d.title)}](${d.url})` : `## ${emojify(d.title)}`);
    if (d.description)
        intro.push(emojify(d.description));
    const introText = intro.join('\n').slice(0, 4000) || '\u200b';
    if (brand.thumbnail) {
        container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(introText)).setThumbnailAccessory(new ThumbnailBuilder().setURL(brand.thumbnail)));
    }
    else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(introText));
    }
    if (d.fields?.length) {
        for (const field of d.fields.slice(0, 25)) {
            const text = `**${emojify(field.name || 'Field')}**\n${emojify(field.value || '')}`.slice(0, 4000);
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
        }
    }
    if (d.image?.url)
        container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(d.image.url)));
    const foot = [emojify(brand.footer)];
    foot.push(new Date(brand.timestamp).toUTCString());
    if (foot.length) {
        container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${foot.join(' • ')}`.slice(0, 4000)));
    }
    const validRows = sanitizeUniqueCustomIds(flattenComponentRows(rows));
    if (validRows.length) {
        container.addSeparatorComponents(new SeparatorBuilder().setDivider(false));
        container.addActionRowComponents(...validRows);
    }
    return container;
}
function toComponentsV2(payload, force = false) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return payload;
    const embeds = Array.isArray(payload.embeds) ? payload.embeds : [];
    if (!embeds.length)
        return payload;
    const { embeds: _e, components: rawRows, content, ephemeral, flags, stickers, poll, ...rest } = payload;
    const rows = flattenComponentRows(rawRows);
    const out = [];
    if (content)
        out.push(new TextDisplayBuilder().setContent(String(content).slice(0, 4000)));
    embeds.forEach((embed, index) => out.push(embedToContainer(embed, index === embeds.length - 1 ? rows : [])));
    let bits = (typeof flags === 'number' ? flags : 0) | MessageFlags.IsComponentsV2;
    if (ephemeral)
        bits |= MessageFlags.Ephemeral;
    return { ...rest, components: out, flags: bits };
}
module.exports.featureSetupEmbed = featureSetupEmbed;
module.exports.featureSetupRow = featureSetupRow;
module.exports.buttonRoleEmbed = buttonRoleEmbed;
module.exports.staffApplicationEmbed = staffApplicationEmbed;
module.exports.birthdaySetupEmbed = birthdaySetupEmbed;
module.exports.honeypotSetupEmbed = honeypotSetupEmbed;
module.exports = {
    THEME, OK, WARN, DANGER, emoji, emojify, EMOJI_KEYS, DEFAULT_EMOJIS, emojiRegistryEntries, emojiSnapshotObject, formatEmojiSnapshot,
    base, okEmbed, warnEmbed, errorEmbed, infoEmbed, automodSetupEmbed, automodSetupRows,
    HELP_CATEGORIES, helpHomeEmbed, helpCategoryEmbed, helpSelectRow,
    confirmRow,
    ticketPanelEmbed, ticketPanelRow, ticketControlRow, ticketWelcomeEmbed,
    staffControlsEmbed, staffControlsRow,
    ticketMemberPromptEmbed, ticketMemberSelectRow,
    vmControlEmbed, vmControlRows, vmUserPickPrompt, vmInfoEmbed, vmDeleteConfirmRow, VM_REGIONS, vmSetupRows, vmInterfacePromptEmbed, vmInterfaceSelectRow,
    vmSetupEmbed, vmSetupRow, vmCategoryPromptEmbed, vmCategorySelectRow, vmChannelPromptEmbed, vmChannelSelectRow,
    vmKickPromptEmbed, vmKickSelectRow, vmKickNobodyEmbed, vmKickGoneEmbed, vmKickedEmbed,
    levelUpEmbed, leaderboardEmbed,
    configSummaryEmbed, moduleListEmbed, emojisListEmbed, emojisListRows, embedTextsListEmbed, embedTextsListRows,
    featureSetupEmbed, featureSetupRow, buttonRoleEmbed, buttonRoleSetupRows, reactionRoleSetupEmbed, reactionRoleSetupRows, staffApplicationEmbed, birthdaySetupEmbed, honeypotSetupEmbed, birthdaySetupRow, antiBadwordSetupEmbed, antiBadwordSetupRow, honeypotSetupRow, greetVoiceSetupEmbed, greetVoiceSetupRow, greetMessageSetupEmbed, greetMessageSetupRow,
    autoresponderSetupEmbed, autoresponderSetupRow, autoreactorSetupEmbed, autoreactorSetupRow,
    logSetupEmbed, logSetupRows, ownerLogSetupEmbed, ownerLogSetupRows, ownerJoinLogEmbed, ownerJoinLogRows, ownerGuildControlEmbed, ownerGuildControlRows, ownerInfoChoiceEmbed, ownerInfoChoiceRows, membershipListEmbed, membershipListRows,
    embedBuilderPreviewEmbed, embedBuilderRow, toComponentsV2, embedToContainer,
    SETUP_MODULE_META, setupPanelEmbed, setupPanelRow
};

};
__modules["v2patch.js"] = function(module, exports, require, __filename, __dirname) {
const D = require('discord.js');
const { ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, SeparatorBuilder, SeparatorSpacingSize, FileBuilder, MessageFlags, MessagePayload, Message, ActionRowBuilder } = D;
const V2 = MessageFlags.IsComponentsV2;
const EPH = MessageFlags.Ephemeral;
const MAX_TEXT = 3900;
const MAX_COMPONENTS = 40;
const IMG = /\.(png|jpe?g|gif|webp)(\?|$)/i;
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s; };
const asJSON = x => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);
const flagBits = f => { try {
    return Number(new D.MessageFlagsBitField(f ?? 0).bitfield);
}
catch {
    return Number(f || 0);
} };
const isHttpOrAttachment = u => /^(https?:\/\/|attachment:\/\/)/i.test(String(u || ''));
function embedText(e) {
    const parts = [];
    if (e.title)
        parts.push(`## ${e.title}`);
    if (e.author?.name)
        parts.push(`**${e.author.name}**`);
    if (e.description)
        parts.push(e.description);
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
    if (typeof e.color === 'number')
        c.setAccentColor(e.color);
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
    }
    else {
        c.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
    }
    if (e.image?.url && isHttpOrAttachment(e.image.url)) {
        c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(e.image.url)));
    }
    if (footer) {
        const f = clip(footer, Math.max(0, budget.left));
        if (f) {
            c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${f}`));
            budget.left -= f.length + 3;
        }
    }
    if (rows.length) {
        c.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
        for (const r of rows)
            c.addActionRowComponents(r);
    }
    return c;
}
function countRow(r) { const j = asJSON(r); return 1 + (j?.components?.length || 0); }
function rowsOf(components) {
    const flat = [];
    const walk = v => { if (Array.isArray(v))
        v.forEach(walk);
    else if (v)
        flat.push(v); };
    walk(components);
    return flat.map(r => (r instanceof ActionRowBuilder ? r : ActionRowBuilder.from(asJSON(r))))
        .filter(r => (asJSON(r)?.components?.length || 0) > 0);
}
function toV2(options, { edit = false, force = false } = {}) {
    if (!options || typeof options !== 'object' || options instanceof MessagePayload)
        return options;
    if (flagBits(options.flags) & V2)
        return options;
    const embeds = (options.embeds || []).filter(Boolean);
    const rows = rowsOf(options.components);
    const hasContent = typeof options.content === 'string' && options.content.length > 0;
    const needs = embeds.length > 0 || (rows.length > 0 && hasContent) || (force && (hasContent || rows.length > 0));
    if (!needs)
        return options;
    const budget = { left: MAX_TEXT };
    const top = [];
    if (hasContent) {
        const t = clip(options.content, 1500);
        budget.left -= t.length;
        top.push(new TextDisplayBuilder().setContent(t));
    }
    const files = options.files || [];
    const fileNames = files.map(f => f?.name || f?.attachment?.name || (typeof f === 'string' ? f.split('/').pop() : null)).filter(Boolean);
    let used = top.length + fileNames.length;
    const out = [...top];
    const pieces = embeds.length ? embeds : [{}];
    let rowsLeft = rows.slice();
    pieces.forEach((emb, idx) => {
        const last = idx === pieces.length - 1;
        let mine = [];
        if (last) {
            let cost = used + 6 + (pieces.length - idx - 1) * 3;
            for (const r of rowsLeft) {
                const n = countRow(r);
                if (cost + n + 2 > MAX_COMPONENTS)
                    break;
                mine.push(r);
                cost += n;
            }
        }
        const c = embedToContainer(emb, mine, { left: Math.max(300, Math.floor(budget.left / (pieces.length - idx))) });
        used += 5 + mine.reduce((a, r) => a + countRow(r), 0);
        out.push(c);
    });
    for (const n of fileNames) {
        if (IMG.test(n))
            out.push(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${n}`)));
        else
            out.push(new FileBuilder().setURL(`attachment://${n}`));
    }
    const next = { ...options, components: out };
    delete next.embeds;
    delete next.content;
    let flags = flagBits(options.flags) | V2;
    if (options.ephemeral) {
        flags |= EPH;
        delete next.ephemeral;
    }
    next.flags = flags;
    if (edit) {
        next.content = null;
        next.embeds = [];
        delete next.flags;
        next.flags = flags & ~EPH;
    }
    return next;
}
const DEAD = new Set([10008, 10062, 10015, 40060]);
const codeOf = e => e?.code ?? e?.rawError?.code;
async function withFallback(primary, fallback) {
    try {
        return await primary();
    }
    catch (e) {
        if (!DEAD.has(codeOf(e)) || !fallback)
            throw e;
        try {
            return await fallback(e);
        }
        catch (e2) {
            if (DEAD.has(codeOf(e2))) {
                console.warn('[v2patch] response target is gone:', e2.message);
                return null;
            }
            throw e2;
        }
    }
}
function patchInteractionClass(Cls) {
    if (!Cls || Cls.prototype.__v2patched)
        return;
    const p = Cls.prototype;
    p.__v2patched = true;
    const { reply, editReply, followUp, update } = p;
    const stripEdit = o => { const { ephemeral, ...rest } = o || {}; return rest; };
    if (reply)
        p.reply = function (options) {
            if (this.deferred || this.replied) {
                return (this.deferred && !this.replied ? this.editReply(stripEdit(options)) : this.followUp(options));
            }
            return reply.call(this, toV2(options));
        };
    if (followUp)
        p.followUp = function (options) {
            const o = toV2(options);
            return withFallback(() => followUp.call(this, o), () => this.channel?.send?.(stripEdit(toV2(options))));
        };
    if (editReply)
        p.editReply = function (options) {
            const force = !!(this.message?.flags && flagBits(this.message.flags) & V2) || !!this.__v2;
            const o = typeof options === 'string' ? { content: options } : options;
            const v = toV2(o, { edit: true, force });
            if (v !== o)
                this.__v2 = true;
            return withFallback(() => editReply.call(this, v), () => followUp.call(this, { ...toV2(stripEdit(o)), ephemeral: this.ephemeral ?? true }));
        };
    if (update)
        p.update = function (options) {
            if (this.deferred || this.replied)
                return this.editReply(options);
            const force = !!(this.message?.flags && flagBits(this.message.flags) & V2);
            const o = typeof options === 'string' ? { content: options } : options;
            return withFallback(() => update.call(this, toV2(o, { edit: true, force })), () => this.followUp({ ...stripEdit(o), ephemeral: true }));
        };
}
let applied = false;
function apply() {
    if (applied)
        return;
    applied = true;
    for (const n of ['CommandInteraction', 'MessageComponentInteraction', 'ModalSubmitInteraction'])
        patchInteractionClass(D[n]);
    const origResolve = MessagePayload.prototype.resolveBody;
    MessagePayload.prototype.resolveBody = function () {
        if (this.body)
            return this;
        try {
            if (this.options && typeof this.options === 'object')
                this.options = toV2(this.options);
        }
        catch (e) {
            console.warn('[v2patch] conversion skipped:', e.message);
        }
        return origResolve.call(this);
    };
    const origEdit = Message.prototype.edit;
    Message.prototype.edit = function (options) {
        const force = !!(flagBits(this.flags) & V2);
        const o = typeof options === 'string' ? { content: options } : options;
        return origEdit.call(this, toV2(o, { edit: true, force }));
    };
}
function wrapInteraction(interaction, ms = 2200) {
    if (!interaction || interaction.__v2watch || interaction.isAutocomplete?.())
        return interaction;
    interaction.__v2watch = true;
    const t = setTimeout(async () => {
        if (interaction.replied || interaction.deferred)
            return;
        try {
            if (interaction.isMessageComponent?.() || (interaction.isModalSubmit?.() && interaction.message))
                await interaction.deferUpdate();
            else
                await interaction.deferReply({ ephemeral: true });
        }
        catch (e) { }
    }, ms);
    t.unref?.();
    return interaction;
}
module.exports = { apply, wrapInteraction, withFallback, toV2, embedToContainer, V2 };

};

const __cache = Object.create(null);
function __resolveModule(from, request) {
  const resolved = __path.posix.normalize(__path.posix.join(__path.posix.dirname(from), request));
  const candidates = [resolved, resolved + '.js', resolved + '/index.js', resolved + '.json'];
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(__modules, candidate)) return candidate;
  }
  throw new Error(`Bundled module not found: ${request} from ${from}`);
}
function __loadModule(id) {
  if (__cache[id]) return __cache[id].exports;
  const module = { exports: {}, loaded: false, filename: __path.join(__baseDir, id) };
  __cache[id] = module;
  const localRequire = (request) => {
    if (typeof request === 'string' && (request.startsWith('./') || request.startsWith('../'))) {
      return __loadModule(__resolveModule(id, request));
    }
    return __nativeRequire(request);
  };
  __modules[id](module, module.exports, localRequire, module.filename, __path.dirname(module.filename));
  module.loaded = true;
  return module.exports;
}
__loadModule('index.js');
