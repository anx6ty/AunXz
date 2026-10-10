// applications.js — staff applications, rebuilt.
//
// ROOT CAUSES FIXED (old code in index.js):
//  1. `staffapp_apply` read `cfg.staffApplications.title` where `cfg` was ALREADY the staffApplications
//     object -> TypeError -> the button handler threw before replying -> "This interaction failed".
//  2. The session was stored BEFORE the DM was sent and `createDM()/send()` had no try/catch, so a
//     closed-DM user was stuck forever on "Application In Progress" and never saw an error.
//  3. Nothing was acknowledged before the slow DM call; now we deferReply first (well inside 3s).
//
// Flow: Apply -> deferReply(ephemeral) -> validate (enabled, review channel, duplicate, cooldown)
//   -> DM, question by question ("Question 3/10") with Cancel/Submit
//   -> if DMs are closed: ephemeral explanation + "Answer here instead" (modal pages of 5 questions).
// On submit the application is posted to the review channel with Accept / Deny / Ask Question buttons
// and the applicant is DM'd the result.

const {
  PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder, ChannelType, EmbedBuilder
} = require('discord.js');
const db = require('./database');
const ui = require('./ui');
const h = require('./helpers');

const sessions = new Map();            // userId -> session
const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;
const SESSION_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_QUESTIONS = 25;
const REVIEW_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

const cfgOf = guildId => db.getConfig(guildId).staffApplications || {};
const bar = (i, n) => '▰'.repeat(i) + '▱'.repeat(Math.max(0, n - i));
const btn = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

function clearSession(userId) {
  const s = sessions.get(userId);
  if (s?.timer) clearTimeout(s.timer);
  sessions.delete(userId);
}
function armTimeout(session) {
  clearTimeout(session.timer);
  session.timer = setTimeout(async () => {
    if (sessions.get(session.userId) !== session) return;
    sessions.delete(session.userId);
    console.log(`[Applications] session for ${session.userId} timed out`);
    await session.user?.send({ embeds: [h.warnEmbed('Application timed out', 'You took too long to answer. Press **Apply** in the server to start again.')] }).catch(() => {});
  }, QUESTION_TIMEOUT_MS);
  session.timer.unref?.();
}
function liveSession(userId) {
  const s = sessions.get(userId);
  if (s && Date.now() - s.startedAt > SESSION_MAX_AGE_MS) { clearSession(userId); return null; }
  return s || null;
}

// ---------------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------------
async function checkEligibility(interaction) {
  const guild = interaction.guild;
  const cfg = cfgOf(guild.id);
  if (!cfg.enabled || !(cfg.questions || []).length) return 'Applications are not open right now (disabled or no questions configured).';
  const review = cfg.logChannelId ? (guild.channels.cache.get(cfg.logChannelId) || await guild.channels.fetch(cfg.logChannelId).catch(() => null)) : null;
  if (!review) return 'Staff have not set a review channel yet (or it was deleted). Please tell an admin.';
  const missing = h.missingChannelPerms(review, guild.members.me, REVIEW_PERMS);
  if (missing.length) return `The review channel ${review} is not usable: I am missing **${missing.join(', ')}** there. Please tell an admin.`;
  if (db.pendingApplicationForUser(guild.id, interaction.user.id)) return 'You already have an application waiting for review. You will be notified when staff decide.';
  const last = db.lastApplicationForUser(guild.id, interaction.user.id);
  const cooldownMs = Math.max(0, Number(cfg.cooldownHours ?? 24)) * 3600000;
  if (last && cooldownMs && Date.now() - last.createdAt < cooldownMs) {
    return `You can apply again <t:${Math.floor((last.createdAt + cooldownMs) / 1000)}:R> (cooldown: ${cfg.cooldownHours}h).`;
  }
  return null;
}

// ---------------------------------------------------------------------------------
// Apply button
// ---------------------------------------------------------------------------------
async function handleApply(interaction) {
  await interaction.deferReply({ ephemeral: true });            // acknowledge immediately (<3s)
  console.log(`[Applications] apply pressed by ${interaction.user.id} in ${interaction.guildId}`);
  const problem = await checkEligibility(interaction);
  if (problem) return interaction.editReply({ embeds: [h.errorEmbed('Cannot apply', problem)] });

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
  } catch (e) {
    console.warn(`[Applications] DM to ${interaction.user.id} failed: ${e?.code || ''} ${e?.message || e}`);
    return interaction.editReply({
      embeds: [h.warnEmbed('I could not DM you', `Your DMs look closed (${e?.code === 50007 ? 'Discord error 50007: cannot send messages to this user' : e?.message || 'DM failed'}).\n\n**Option 1:** enable *Direct Messages* for this server in Privacy Settings and press Apply again.\n**Option 2:** answer right here in pop-up forms — no DMs needed.`)],
      components: [new ActionRowBuilder().addComponents(btn('staffapp_modalstart', 'Answer here instead', ButtonStyle.Primary))]
    });
  }
  sessions.set(interaction.user.id, { userId: interaction.user.id, user: interaction.user, guildId: interaction.guildId, mode: 'dm', step: 'intro', answers: [], index: 0, startedAt: Date.now() });
  return interaction.editReply({ embeds: [h.successEmbed('Check your DMs', 'I sent you the application. Press **Ready** there to begin.')] });
}

// ---------------------------------------------------------------------------------
// DM flow
// ---------------------------------------------------------------------------------
function questionPayload(session) {
  const qs = cfgOf(session.guildId).questions || [];
  const n = qs.length; const i = session.index;
  return {
    embeds: [ui.base(`Question ${i + 1}/${n}`).setDescription(`${h.clip(qs[i], 1500)}\n\n\`${bar(i, n)}\` ${Math.round((i / n) * 100)}%\n*Reply to this message with your answer.*`)],
    components: [new ActionRowBuilder().addComponents(btn('staffapp_cancel', 'Cancel application', ButtonStyle.Danger))]
  };
}
function reviewPayload(session) {
  const qs = cfgOf(session.guildId).questions || [];
  const embed = ui.base('Review your application').setDescription('Check your answers, then **Submit** or **Cancel**.');
  qs.slice(0, 10).forEach((q, i) => embed.addFields({ name: h.clip(`${i + 1}. ${q}`, 250), value: h.clip(session.answers[i] || '—', 300) }));
  if (qs.length > 10) embed.setFooter({ text: `Showing 10 of ${qs.length} answers` });
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(btn('staffapp_submit', 'Submit', ButtonStyle.Success), btn('staffapp_cancel', 'Cancel', ButtonStyle.Danger))] };
}
async function handleDM(message) {
  const session = liveSession(message.author.id);
  if (!session || session.mode !== 'dm' || session.step !== 'asking') return false;
  const text = [message.content?.trim(), ...[...message.attachments.values()].map(a => a.url)].filter(Boolean).join('\n');
  if (!text) return true;
  const qs = cfgOf(session.guildId).questions || [];
  session.answers[session.index] = text.slice(0, 1500);
  session.index += 1;
  if (session.index < qs.length) {
    armTimeout(session);
    await message.author.send(questionPayload(session)).catch(e => console.warn('[Applications] could not send next question:', e?.message));
  } else {
    session.step = 'review'; clearTimeout(session.timer);
    await message.author.send(reviewPayload(session)).catch(e => console.warn('[Applications] could not send review:', e?.message));
  }
  return true;
}

// ---------------------------------------------------------------------------------
// Modal flow (no DMs needed): 5 questions per pop-up page
// ---------------------------------------------------------------------------------
function modalFor(session) {
  const qs = cfgOf(session.guildId).questions || [];
  const pages = Math.ceil(qs.length / 5); const start = session.page * 5;
  const modal = new ModalBuilder().setCustomId(`staffapp_modal:${session.page}`).setTitle(`Application ${session.page + 1}/${pages}`.slice(0, 45));
  qs.slice(start, start + 5).forEach((q, k) => {
    const input = new TextInputBuilder().setCustomId(`q${start + k}`).setLabel(h.clip(`${start + k + 1}. ${q}`, 45)).setPlaceholder(h.clip(q, 100))
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
    if (session.answers[start + k]) input.setValue(session.answers[start + k].slice(0, 1000));   // prefill when re-opening a page
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  });
  return modal;
}
function pageIntro(session) {
  const qs = cfgOf(session.guildId).questions || [];
  const start = session.page * 5; const pages = Math.ceil(qs.length / 5);
  const lines = qs.slice(start, start + 5).map((q, k) => `**${start + k + 1}.** ${h.clip(q, 300)}`);
  return {
    embeds: [ui.base(`Page ${session.page + 1}/${pages}`).setDescription(`${lines.join('\n')}\n\n\`${bar(session.page, pages)}\``)],
    components: [new ActionRowBuilder().addComponents(btn('staffapp_next', 'Open form', ButtonStyle.Primary), btn('staffapp_cancel', 'Cancel', ButtonStyle.Danger))]
  };
}
async function startModalFlow(interaction) {
  const problem = await checkEligibility(interaction);
  if (problem) return interaction.reply({ embeds: [h.errorEmbed('Cannot apply', problem)], ephemeral: true });
  clearSession(interaction.user.id);
  const session = { userId: interaction.user.id, user: interaction.user, guildId: interaction.guildId, mode: 'modal', step: 'asking', answers: [], page: 0, index: 0, startedAt: Date.now() };
  sessions.set(interaction.user.id, session);
  return interaction.showModal(modalFor(session));
}

// ---------------------------------------------------------------------------------
// Submit -> review channel
// ---------------------------------------------------------------------------------
function reviewEmbeds(app, user, cfg, { status = 'Pending review', color = ui.THEME, reviewer = null, reason = null } = {}) {
  const head = ui.base(`Staff Application #${app.id}`).setColor(color).setDescription(
    `**Applicant:** <@${app.userId}> (\`${user?.tag || app.userId}\`)\n**Submitted:** <t:${Math.floor(app.createdAt / 1000)}:R>\n**Status:** ${status}` +
    (reviewer ? `\n**Reviewed by:** <@${reviewer}>` : '') + (reason ? `\n**Reason:** ${h.clip(reason, 500)}` : ''));
  if (user?.displayAvatarURL) head.setThumbnail(user.displayAvatarURL());
  const embeds = [head]; let cur = head; let used = 0; let fields = 0;
  (cfg.questions || []).slice(0, MAX_QUESTIONS).forEach((q, i) => {
    const name = h.clip(`${i + 1}. ${q}`, 250); const value = h.clip(app.answers[i] || 'No answer', 1000);
    if (fields >= 12 || used + name.length + value.length > 3500) { cur = ui.base(`Application #${app.id} (cont.)`).setColor(color); embeds.push(cur); used = 0; fields = 0; }
    cur.addFields({ name, value }); used += name.length + value.length; fields += 1;
  });
  return embeds.slice(0, 10);
}
function reviewRow(id, disabled = false) {
  return new ActionRowBuilder().addComponents(
    btn(`staffapp_review:accept:${id}`, 'Accept', ButtonStyle.Success).setDisabled(disabled),
    btn(`staffapp_review:deny:${id}`, 'Deny', ButtonStyle.Danger).setDisabled(disabled),
    btn(`staffapp_review:ask:${id}`, 'Ask Question', ButtonStyle.Primary).setDisabled(disabled)
  );
}
async function submitApplication(interaction, session) {
  const guild = interaction.client.guilds.cache.get(session.guildId);
  if (!guild) throw new Error('I am no longer in that server.');
  const cfg = cfgOf(guild.id);
  const fakeCtx = { guild, user: interaction.user };
  const problem = await checkEligibility(fakeCtx);                // re-check: someone may have applied meanwhile
  if (problem) throw new Error(problem);
  const review = guild.channels.cache.get(cfg.logChannelId) || await guild.channels.fetch(cfg.logChannelId).catch(() => null);

  const app = db.createApplication(guild.id, session.userId, session.answers);
  try {
    const msg = await review.send({ embeds: reviewEmbeds(app, interaction.user, cfg), components: [reviewRow(app.id)] });
    db.updateApplication(app.id, { channelId: review.id, messageId: msg.id });
  } catch (e) {
    db.updateApplication(app.id, { status: 'failed' });          // never leave a phantom "pending" application
    throw new Error(`I could not post your application to the review channel: ${e?.message || e}`);
  }
  // Applicant role (best effort, reported in console only — the application itself succeeded)
  if (cfg.applicantRoleId) {
    const member = await guild.members.fetch(session.userId).catch(() => null);
    const role = guild.roles.cache.get(cfg.applicantRoleId);
    if (member && role && role.position < guild.members.me.roles.highest.position) await member.roles.add(role, 'Staff application submitted').catch(e => console.warn('[Applications] applicant role failed:', e?.message));
  }
  clearSession(session.userId);
  return app;
}

// ---------------------------------------------------------------------------------
// Review decisions
// ---------------------------------------------------------------------------------
async function reviewButton(interaction) {                         // staffapp_review:<action>:<id>
  const [, action, idRaw] = interaction.customId.split(':');
  if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ embeds: [h.errorEmbed('Missing permissions', 'You need **Manage Server** to review applications.')], ephemeral: true });
  }
  const app = db.getApplication(idRaw);
  if (!app || app.status !== 'pending') return interaction.reply({ embeds: [h.warnEmbed('Already handled', 'That application is no longer pending.')], ephemeral: true });
  if (action === 'ask') {
    return interaction.showModal(new ModalBuilder().setCustomId(`staffapp_ask:${app.id}`).setTitle('Ask the applicant').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('question').setLabel('Your question').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000))));
  }
  return interaction.showModal(new ModalBuilder().setCustomId(`staffapp_reason:${action}:${app.id}`).setTitle(action === 'accept' ? 'Accept application' : 'Deny application').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(800))));
}
async function legacyDecide(interaction) {                         // old buttons: staffapp_decide:<accept|reject>:<userId>
  const [, decision, userId] = interaction.customId.split(':');
  const app = db.pendingApplicationForUser(interaction.guildId, userId);
  if (app) { interaction.customId = `staffapp_review:${decision === 'accept' ? 'accept' : 'deny'}:${app.id}`; return reviewButton(interaction); }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ embeds: [h.errorEmbed('Missing permissions', 'You need **Manage Server** to review applications.')], ephemeral: true });
  return interaction.showModal(new ModalBuilder().setCustomId(`staffapp_reason:${decision === 'accept' ? 'accept' : 'deny'}:u${userId}`).setTitle(decision === 'accept' ? 'Accept application' : 'Deny application').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false))));
}
async function reasonModal(interaction) {                          // staffapp_reason:<accept|deny|reject>:<id | u<userId> | userId>
  await interaction.deferReply({ ephemeral: true });
  if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.editReply({ embeds: [h.errorEmbed('Missing permissions', 'You need **Manage Server**.')] });
  }
  let [, decision, ref] = interaction.customId.split(':');
  decision = decision === 'accept' ? 'accept' : 'deny';
  const reason = interaction.fields.getTextInputValue('reason').trim() || null;
  const cfg = cfgOf(interaction.guildId);
  let app = null; let userId;
  if (/^u?\d{15,25}$/.test(ref)) userId = ref.replace(/^u/, '');
  else { app = db.getApplication(ref); if (!app || app.status !== 'pending') return interaction.editReply({ embeds: [h.warnEmbed('Already handled', 'That application is no longer pending.')] }); userId = app.userId; }

  const results = [];
  const user = await interaction.client.users.fetch(userId).catch(() => null);
  const guild = interaction.guild;
  if (decision === 'accept' && cfg.acceptedRoleId) {
    const member = await guild.members.fetch(userId).catch(() => null);
    const role = guild.roles.cache.get(cfg.acceptedRoleId);
    const me = guild.members.me;
    if (!member) results.push(`${h.THEME.emoji.err()} Accepted role not given: the applicant is no longer in the server.`);
    else if (!role) results.push(`${h.THEME.emoji.err()} Accepted role not given: the configured role no longer exists.`);
    else if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) results.push(`${h.THEME.emoji.err()} Accepted role not given: I need **Manage Roles**.`);
    else if (role.position >= me.roles.highest.position) results.push(`${h.THEME.emoji.err()} Accepted role not given: ${role} is equal to or above my highest role (move my role higher).`);
    else {
      try {
        await member.roles.add(role, `Staff application #${app?.id ?? '?'} accepted by ${interaction.user.tag}`);
        if (cfg.applicantRoleId && cfg.applicantRoleId !== role.id) await member.roles.remove(cfg.applicantRoleId).catch(() => {});
        results.push(`${h.THEME.emoji.ok()} Gave ${role} to <@${userId}>.`);
      } catch (e) { results.push(`${h.THEME.emoji.err()} Role change failed: ${e?.message || e}`); }
    }
  }
  const dmText = decision === 'accept' ? (cfg.acceptMessage || 'Your application was accepted.') : (cfg.denyMessage || 'Your application was not accepted.');
  if (!user) results.push(`${h.THEME.emoji.err()} Could not DM the applicant (user not found).`);
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
    } catch (e) { results.push(`${h.THEME.emoji.warn()} Decision saved, but I could not update the review message: ${e?.message || e}`); }
  }
  return interaction.editReply({ embeds: [h.successEmbed(`Application ${decision === 'accept' ? 'accepted' : 'denied'}`, `<@${userId}>${reason ? `\n**Reason:** ${reason}` : ''}\n\n${results.join('\n')}`)] });
}
async function askModal(interaction) {                             // staffapp_ask:<id>
  await interaction.deferReply({ ephemeral: true });
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.editReply({ embeds: [h.errorEmbed('Missing permissions', 'You need **Manage Server**.')] });
  const app = db.getApplication(interaction.customId.split(':')[1]);
  if (!app || app.status !== 'pending') return interaction.editReply({ embeds: [h.warnEmbed('Already handled', 'That application is no longer pending.')] });
  const question = interaction.fields.getTextInputValue('question').trim();
  const user = await interaction.client.users.fetch(app.userId).catch(() => null);
  if (!user) return interaction.editReply({ embeds: [h.errorEmbed('Applicant not found', 'I could not find that user.')] });
  try {
    await user.send({ embeds: [ui.base('Question about your application').setDescription(`**${interaction.guild.name}** staff asks:\n\n${h.clip(question, 1500)}`)], components: [new ActionRowBuilder().addComponents(btn(`staffapp_answer:${app.id}`, 'Answer', ButtonStyle.Primary))] });
  } catch (e) {
    return interaction.editReply({ embeds: [h.errorEmbed('Could not DM the applicant', `Their DMs are closed (${e?.message || 'DM failed'}). Contact them another way.`)] });
  }
  return interaction.editReply({ embeds: [h.successEmbed('Question sent', `Asked <@${app.userId}>. Their reply will appear in the review channel.`)] });
}
async function answerModal(interaction) {                          // staffapp_answer_modal:<id>
  await interaction.deferReply({ ephemeral: true });
  const app = db.getApplication(interaction.customId.split(':')[1]);
  if (!app || app.userId !== interaction.user.id) return interaction.editReply({ embeds: [h.errorEmbed('Not available', 'This question is no longer valid.')] });
  const answer = interaction.fields.getTextInputValue('answer').trim();
  try {
    const ch = await interaction.client.channels.fetch(app.channelId);
    await ch.send({ embeds: [ui.base(`Answer from applicant — #${app.id}`).setDescription(`<@${app.userId}> replied:\n\n${h.clip(answer, 3500)}`)], reply: { messageReference: app.messageId, failIfNotExists: false } });
  } catch (e) {
    return interaction.editReply({ embeds: [h.errorEmbed('Could not deliver your answer', String(e?.message || e))] });
  }
  return interaction.editReply({ embeds: [h.successEmbed('Answer sent', 'Staff received your reply.')] });
}

// ---------------------------------------------------------------------------------
// Setup panel (/staffapplicationssetup)
// ---------------------------------------------------------------------------------
const qState = new Map();   // `${guildId}:${userId}` -> selected question index
const sk = (g, u) => `${g}:${u}`;

function homePayload(guild, userId) {
  const cfg = cfgOf(guild.id);
  const ch = id => (id ? `<#${id}>` : 'Not set'); const role = id => (id ? `<@&${id}>` : 'Not set');
  const embed = ui.base(`${h.THEME.emoji.settings()} Staff Applications`).setDescription('Members press **Apply** and answer your questions by DM (or pop-up forms if their DMs are closed). Answers land in the review channel with Accept / Deny / Ask buttons.')
    .addFields(
      { name: 'Status', value: cfg.enabled ? `${h.THEME.emoji.on()} Enabled` : `${h.THEME.emoji.off()} Disabled`, inline: true },
      { name: 'Questions', value: String((cfg.questions || []).length), inline: true },
      { name: 'Cooldown', value: `${cfg.cooldownHours ?? 24}h`, inline: true },
      { name: 'Review channel', value: ch(cfg.logChannelId), inline: true },
      { name: 'Apply panel channel', value: ch(cfg.panelChannelId), inline: true },
      { name: 'Applicant role', value: role(cfg.applicantRoleId), inline: true },
      { name: 'Accepted role', value: role(cfg.acceptedRoleId), inline: true },
      { name: 'Panel text', value: h.clip(`**${cfg.title || '—'}** — ${cfg.description || '—'}`, 300) }
    );
  const roleSelect = (id, ph, cur) => { const m = new RoleSelectMenuBuilder().setCustomId(`staffcfg:${id}:${userId}`).setPlaceholder(ph).setMinValues(0).setMaxValues(1); if (cur) m.setDefaultRoles(cur); return new ActionRowBuilder().addComponents(m); };
  const chSelect = (id, ph, cur) => { const m = new ChannelSelectMenuBuilder().setCustomId(`staffcfg:${id}:${userId}`).setPlaceholder(ph).setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement); if (cur) m.setDefaultChannels(cur); return new ActionRowBuilder().addComponents(m); };
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        h.toggleButton(`staffcfg:toggle:${userId}`, !!cfg.enabled),
        btn(`staffcfg:questions:${userId}`, 'Questions', ButtonStyle.Primary), btn(`staffcfg:msgs:${userId}`, 'Messages', ButtonStyle.Primary),
        btn(`staffcfg:cooldown:${userId}`, 'Cooldown'), btn(`staffcfg:post:${userId}`, 'Post Apply Panel', ButtonStyle.Success)),
      chSelect('review', 'Review channel…', cfg.logChannelId), chSelect('panelch', 'Apply panel channel…', cfg.panelChannelId),
      roleSelect('applicant', 'Applicant role (clear to remove)…', cfg.applicantRoleId), roleSelect('accepted', 'Accepted role (clear to remove)…', cfg.acceptedRoleId)
    ]
  };
}
function questionsPayload(guild, userId) {
  const cfg = cfgOf(guild.id); const qs = cfg.questions || []; const sel = qState.get(sk(guild.id, userId));
  const lines = qs.map((q, i) => `${i === sel ? '▶️' : '▫️'} **${i + 1}.** ${h.clip(q, 110)}`);
  const embed = ui.base(`${h.THEME.emoji.list} Application questions`).setDescription(lines.join('\n') || 'No questions yet — press **Add**.').addFields({ name: 'Selected', value: sel !== undefined && qs[sel] ? h.clip(qs[sel], 500) : 'None — pick one in the menu', inline: false }, { name: 'Limit', value: `${qs.length}/${MAX_QUESTIONS}`, inline: true });
  const rows = [];
  if (qs.length) rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`staffcfg:qsel:${userId}`).setPlaceholder('Select a question to edit/move/remove…').addOptions(qs.map((q, i) => ({ label: h.clip(`${i + 1}. ${q}`, 100), value: String(i), default: i === sel })))));
  const has = sel !== undefined && qs[sel] !== undefined;
  rows.push(new ActionRowBuilder().addComponents(
    btn(`staffcfg:qadd:${userId}`, 'Add', ButtonStyle.Success).setDisabled(qs.length >= MAX_QUESTIONS),
    btn(`staffcfg:qedit:${userId}`, 'Edit', ButtonStyle.Primary).setDisabled(!has),
    btn(`staffcfg:qrm:${userId}`, 'Remove', ButtonStyle.Danger).setDisabled(!has),
    btn(`staffcfg:qup:${userId}`, '▲').setDisabled(!has || sel === 0),
    btn(`staffcfg:qdown:${userId}`, '▼').setDisabled(!has || sel === qs.length - 1)));
  rows.push(new ActionRowBuilder().addComponents(btn(`staffcfg:home:${userId}`, 'Back', ButtonStyle.Secondary).setEmoji(h.THEME.emoji.back), btn(`staffcfg:qclear:${userId}`, 'Clear all', ButtonStyle.Danger).setDisabled(!qs.length)));
  return { embeds: [embed], components: rows };
}
async function openSetup(interaction) {
  if (!interaction.guild) return h.safeReply(interaction, { embeds: [h.errorEmbed('Server only', 'Use this inside a server.')], ephemeral: true });
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return h.safeReply(interaction, { embeds: [h.errorEmbed('Missing permissions', 'You need **Administrator**.')], ephemeral: true });
  const render = () => homePayload(interaction.guild, interaction.user.id);
  const sent = await h.safeReply(interaction, { ...render(), ephemeral: true });
  h.watchPanel(interaction, sent, render);
}
const textModal = (id, title, fields) => new ModalBuilder().setCustomId(id).setTitle(title).addComponents(
  fields.map(f => { const t = new TextInputBuilder().setCustomId(f.id).setLabel(f.label).setStyle(f.long ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(f.required !== false).setMaxLength(f.max || 200); if (f.value) t.setValue(String(f.value).slice(0, f.max || 200)); return new ActionRowBuilder().addComponents(t); }));

async function setupInteraction(interaction) {                     // staffcfg:<action>:<userId>[:yes|no]
  const parts = interaction.customId.split(':'); const action = parts[1]; const userId = parts[2];
  if (!await h.authorOnly(interaction, userId)) return;
  if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ embeds: [h.errorEmbed('Missing permissions', 'You need **Administrator**.')], ephemeral: true });
  }
  const g = interaction.guild; const gid = g.id; const cfg = cfgOf(gid); const key = sk(gid, userId);
  const save = patch => db.saveConfig(gid, { staffApplications: patch });
  const home = () => interaction.update(homePayload(g, userId));
  const qs = [...(cfg.questions || [])];

  if (interaction.isChannelSelectMenu()) { save(action === 'review' ? { logChannelId: interaction.values[0] } : { panelChannelId: interaction.values[0] }); return home(); }
  if (interaction.isRoleSelectMenu()) { save({ [action === 'applicant' ? 'applicantRoleId' : 'acceptedRoleId']: interaction.values[0] || null }); return home(); }
  if (interaction.isStringSelectMenu() && action === 'qsel') { qState.set(key, Number(interaction.values[0])); return interaction.update(questionsPayload(g, userId)); }

  if (interaction.isModalSubmit()) {
    const f = id => interaction.fields.getTextInputValue(id).trim();
    const back = payload => (interaction.isFromMessage?.() ? interaction.update(payload) : interaction.reply({ ...payload, ephemeral: true }));
    if (action === 'msg') {
      const next = { title: f('title') || 'Staff Applications', description: f('description') || 'Click Apply to start your application.', dmIntro: f('dmIntro') || 'Are you ready to start your staff application?', acceptMessage: f('accept') || 'Your application was accepted.', denyMessage: f('deny') || 'Your application was not accepted.' };
      save(next); return back(homePayload(g, userId));
    }
    if (action === 'cd') {
      const hours = Number(f('hours'));
      if (!Number.isFinite(hours) || hours < 0 || hours > 720) return interaction.reply({ embeds: [h.errorEmbed('Invalid cooldown', 'Enter a number of hours between 0 and 720.')], ephemeral: true });
      save({ cooldownHours: Math.floor(hours) }); return back(homePayload(g, userId));
    }
    if (action === 'qadd_m' || action === 'qedit_m') {
      const text = f('q');
      if (!text) return interaction.reply({ embeds: [h.errorEmbed('Invalid question', 'The question cannot be empty.')], ephemeral: true });
      if (action === 'qadd_m') { if (qs.length >= MAX_QUESTIONS) return interaction.reply({ embeds: [h.errorEmbed('Limit reached', `Max ${MAX_QUESTIONS} questions.`)], ephemeral: true }); qs.push(text); qState.set(key, qs.length - 1); }
      else { const i = qState.get(key); if (i === undefined || qs[i] === undefined) return interaction.reply({ embeds: [h.errorEmbed('No question selected', 'Pick a question first.')], ephemeral: true }); qs[i] = text; }
      save({ questions: qs }); return back(questionsPayload(g, userId));
    }
    return;
  }

  // buttons
  const sel = qState.get(key);
  switch (action) {
    case 'toggle': {
      if (!cfg.enabled && (!qs.length || !cfg.logChannelId)) return interaction.reply({ embeds: [h.errorEmbed('Not ready', 'Add at least one question and choose a review channel before enabling applications.')], ephemeral: true });
      save({ enabled: !cfg.enabled }); return home();
    }
    case 'home': return home();
    case 'questions': return interaction.update(questionsPayload(g, userId));
    case 'msgs': return interaction.showModal(textModal(`staffcfg:msg:${userId}`, 'Customize messages', [
      { id: 'title', label: 'Panel title', max: 100, value: cfg.title }, { id: 'description', label: 'Panel description', long: true, max: 500, value: cfg.description },
      { id: 'dmIntro', label: 'DM intro text', long: true, max: 500, value: cfg.dmIntro }, { id: 'accept', label: 'Accepted message', long: true, max: 500, value: cfg.acceptMessage }, { id: 'deny', label: 'Denied message', long: true, max: 500, value: cfg.denyMessage }]));
    case 'cooldown': return interaction.showModal(textModal(`staffcfg:cd:${userId}`, 'Application cooldown', [{ id: 'hours', label: 'Cooldown in hours (0 = none)', max: 3, value: cfg.cooldownHours ?? 24 }]));
    case 'qadd': return interaction.showModal(textModal(`staffcfg:qadd_m:${userId}`, 'Add question', [{ id: 'q', label: 'Question', long: true, max: 500 }]));
    case 'qedit': return sel !== undefined && qs[sel] !== undefined ? interaction.showModal(textModal(`staffcfg:qedit_m:${userId}`, 'Edit question', [{ id: 'q', label: 'Question', long: true, max: 500, value: qs[sel] }])) : interaction.reply({ embeds: [h.errorEmbed('No question selected', 'Pick one in the menu.')], ephemeral: true });
    case 'qrm': if (sel !== undefined && qs[sel] !== undefined) { qs.splice(sel, 1); qState.delete(key); save({ questions: qs }); } return interaction.update(questionsPayload(g, userId));
    case 'qup': case 'qdown': {
      const j = action === 'qup' ? sel - 1 : sel + 1;
      if (sel !== undefined && qs[sel] !== undefined && qs[j] !== undefined) { [qs[sel], qs[j]] = [qs[j], qs[sel]]; qState.set(key, j); save({ questions: qs }); }
      return interaction.update(questionsPayload(g, userId));
    }
    case 'qclear': return interaction.update({ embeds: [h.warnEmbed('Clear all questions?', 'This removes every application question. This cannot be undone.')], components: [h.confirmRow(`staffcfg:qclearc:${userId}`, { yes: 'Clear all' })] });
    case 'qclearc': {
      if (parts[3] === 'yes') { save({ questions: [] }); qState.delete(key); }
      return interaction.update(questionsPayload(g, userId));
    }
    case 'post': {
      if (!cfg.panelChannelId) return interaction.reply({ embeds: [h.errorEmbed('No panel channel', 'Choose the **Apply panel channel** first.')], ephemeral: true });
      if (!qs.length) return interaction.reply({ embeds: [h.errorEmbed('No questions', 'Add at least one question first.')], ephemeral: true });
      const ch = g.channels.cache.get(cfg.panelChannelId) || await g.channels.fetch(cfg.panelChannelId).catch(() => null);
      if (!ch) return interaction.reply({ embeds: [h.errorEmbed('Channel missing', 'The panel channel no longer exists.')], ephemeral: true });
      const missing = h.missingChannelPerms(ch, g.members.me, REVIEW_PERMS);
      if (missing.length) return interaction.reply({ embeds: [h.errorEmbed('Missing permissions', `I need **${missing.join(', ')}** in ${ch}.`)], ephemeral: true });
      try {
        const msg = await ch.send({ embeds: [ui.base(cfg.title || 'Staff Applications').setDescription(cfg.description || 'Click Apply to start your application.')], components: [new ActionRowBuilder().addComponents(btn('staffapp_apply', 'Apply', ButtonStyle.Success))] });
        return interaction.reply({ embeds: [h.successEmbed('Apply panel posted', `Posted in ${ch}: ${msg.url}`)], ephemeral: true });
      } catch (e) { return interaction.reply({ embeds: [h.errorEmbed('Could not post the panel', String(e?.message || e))], ephemeral: true }); }
    }
  }
}

// ---------------------------------------------------------------------------------
// Router. Returns true when the interaction belonged to this module.
// ---------------------------------------------------------------------------------
async function handleInteraction(interaction) {
  const id = interaction.customId;
  if (!id || !(id.startsWith('staffapp_') || id.startsWith('staffcfg:'))) return false;
  try {
    if (id.startsWith('staffcfg:')) { await setupInteraction(interaction); return true; }
    const base = id.split(':')[0];
    if (interaction.isButton()) {
      switch (base) {
        case 'staffapp_apply': await handleApply(interaction); return true;
        case 'staffapp_ready': {
          const s = liveSession(interaction.user.id);
          if (!s || s.mode !== 'dm') { await interaction.reply({ embeds: [h.errorEmbed('No application', 'Press **Apply** in the server first.')], ephemeral: true }); return true; }
          s.step = 'asking'; s.index = 0; s.answers = []; armTimeout(s);
          await interaction.update({ embeds: [h.successEmbed('Application started', 'Answer each question by replying in this chat.')], components: [] });
          await interaction.followUp(questionPayload(s));
          return true;
        }
        case 'staffapp_notready': clearSession(interaction.user.id); await interaction.update({ embeds: [h.warnEmbed('Not started', 'No application was started. Press Apply again when ready.')], components: [] }); return true;
        case 'staffapp_cancel': clearSession(interaction.user.id); await interaction.update({ embeds: [h.infoEmbed('Application cancelled', 'Nothing was submitted. Press Apply again any time.')], components: [] }); return true;
        case 'staffapp_reset': clearSession(interaction.user.id); await interaction.update({ embeds: [h.infoEmbed('Cleared', 'Your previous application was cancelled. Press **Apply** again.')], components: [] }); return true;
        case 'staffapp_modalstart': await startModalFlow(interaction); return true;
        case 'staffapp_next': {
          const s = liveSession(interaction.user.id);
          if (!s || s.mode !== 'modal') { await interaction.reply({ embeds: [h.warnEmbed('Session expired', 'Press **Apply** again.')], ephemeral: true }); return true; }
          await interaction.showModal(modalFor(s)); return true;
        }
        case 'staffapp_submit': {
          const s = liveSession(interaction.user.id);
          if (!s || s.step !== 'review') { await interaction.reply({ embeds: [h.warnEmbed('Nothing to submit', 'Your session expired. Press **Apply** again.')], ephemeral: true }); return true; }
          await interaction.deferUpdate();
          try {
            const app = await submitApplication(interaction, s);
            await interaction.editReply({ embeds: [h.successEmbed('Application submitted', `Application **#${app.id}** was sent to staff. You will be notified here when they decide.`)], components: [] });
          } catch (e) {
            console.error('[Applications] submit failed:', e);
            await interaction.editReply({ embeds: [h.errorEmbed('Could not submit', String(e?.message || e).slice(0, 1500))], components: s.mode === 'modal' || s.mode === 'dm' ? [new ActionRowBuilder().addComponents(btn('staffapp_submit', 'Try again', ButtonStyle.Primary), btn('staffapp_cancel', 'Cancel', ButtonStyle.Danger))] : [] });
          }
          return true;
        }
        case 'staffapp_review': await reviewButton(interaction); return true;
        case 'staffapp_decide': await legacyDecide(interaction); return true;
        case 'staffapp_answer': {
          const app = db.getApplication(id.split(':')[1]);
          if (!app || app.userId !== interaction.user.id) { await interaction.reply({ embeds: [h.errorEmbed('Not available', 'This question is no longer valid.')], ephemeral: true }); return true; }
          await interaction.showModal(textModal(`staffapp_answer_modal:${app.id}`, 'Answer staff question', [{ id: 'answer', label: 'Your answer', long: true, max: 1500 }])); return true;
        }
      }
      return false;
    }
    if (interaction.isModalSubmit()) {
      if (base === 'staffapp_modal') {
        const s = liveSession(interaction.user.id);
        if (!s || s.mode !== 'modal') { await interaction.reply({ embeds: [h.warnEmbed('Session expired', 'Press **Apply** again.')], ephemeral: true }); return true; }
        const qs = cfgOf(s.guildId).questions || []; const start = s.page * 5;
        for (let i = start; i < Math.min(qs.length, start + 5); i++) s.answers[i] = interaction.fields.getTextInputValue(`q${i}`).trim();
        s.page += 1;
        if (s.page * 5 < qs.length) await interaction.reply({ ...pageIntro(s), ephemeral: true });
        else { s.step = 'review'; await interaction.reply({ ...reviewPayload(s), ephemeral: true }); }
        return true;
      }
      if (base === 'staffapp_reason') { await reasonModal(interaction); return true; }
      if (base === 'staffapp_ask') { await askModal(interaction); return true; }
      if (base === 'staffapp_answer_modal') { await answerModal(interaction); return true; }
    }
  } catch (e) {
    console.error(`[Applications] handler failed for ${id}:`, e);
    await h.safeReply(interaction, { embeds: [h.errorEmbed('Application error', String(e?.message || e).slice(0, 1500))], ephemeral: true });
  }
  return true;
}

module.exports = { handleInteraction, handleDM, openSetup, _sessions: sessions };
