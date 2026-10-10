// greetvoice.js — /greetvoice (slash + prefix): toggle | channel | role | message | audio | view | reset | test
// Uses the SAME config key (`greetvoice`) as the setup panel, so both stay in sync.

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const db = require('./database');
const ui = require('./ui');
const sys = require('./systems');
const h = require('./helpers');

const cfgOf = gid => db.getConfig(gid).greetvoice;
const save = (gid, patch) => db.saveConfig(gid, { greetvoice: patch }).greetvoice;
const VOICE_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];
const sync = (guild, cfg) => {                                // keep the gate role locked to the greeting VC (same as setup)
  const role = cfg.roleId && guild.roles.cache.get(cfg.roleId);
  if (cfg.enabled && role && cfg.vcId) sys.lockRoleToSingleChannel(guild, role, cfg.vcId).catch(e => console.error('[GreetVoice] role sync failed:', e?.message || e));
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
    if (!i.guild) return h.safeReply(i, { embeds: [h.errorEmbed('Server only', 'Use this inside a server.')], ephemeral: true });
    if (!i.member.permissions.has(PermissionFlagsBits.ManageGuild)) return h.safeReply(i, { embeds: [h.errorEmbed('Missing permissions', 'You need **Manage Server**.')], ephemeral: true });
    const g = i.guild; const gid = g.id; const me = g.members.me; const sub = i.options.getSubcommand();
    const cfg = cfgOf(gid);
    const reply = (embed, extra = {}) => h.safeReply(i, { embeds: [embed], ephemeral: true, ...extra });

    if (sub === 'view') return reply(panel(cfg));

    if (sub === 'toggle') {
      if (!cfg.enabled) {
        if (!cfg.vcId) return reply(h.errorEmbed('Cannot enable', 'Set a greeting voice channel first with `/greetvoice channel`.'));
        if (!cfg.ttsPrompt && !cfg.audioPath) return reply(h.errorEmbed('Cannot enable', 'Set a greeting first: `/greetvoice message` or `/greetvoice audio`.'));
        const vc = g.channels.cache.get(cfg.vcId);
        if (!vc) return reply(h.errorEmbed('Cannot enable', 'The saved voice channel was deleted. Pick a new one with `/greetvoice channel`.'));
        const missing = h.missingChannelPerms(vc, me, VOICE_PERMS);
        if (missing.length) return reply(h.errorEmbed('Cannot enable', `I'm missing **${missing.join(', ')}** in ${vc}.`));
      }
      const next = save(gid, { enabled: !cfg.enabled }); sync(g, next);
      return reply(panel(next).setColor(next.enabled ? ui.OK : ui.DANGER).setTitle(`${next.enabled ? 'Greet Voice enabled' : 'Greet Voice disabled'}`));
    }

    if (sub === 'channel') {
      const ch = i.options.getChannel('channel');
      if (!ch || ch.type !== ChannelType.GuildVoice) return reply(h.errorEmbed('Invalid channel', 'Choose a normal voice channel (not a stage or text channel).'));
      const missing = h.missingChannelPerms(ch, me, VOICE_PERMS);
      if (missing.length) return reply(h.errorEmbed('Missing permissions', `I need **${missing.join(', ')}** in ${ch}.`));
      const next = save(gid, { vcId: ch.id }); sync(g, next);
      return reply(panel(next).setColor(ui.OK));
    }

    if (sub === 'role') {
      const role = i.options.getRole('role');
      if (!role || role.id === gid) return reply(h.errorEmbed('Invalid role', '`@everyone` cannot be the gate role.'));
      if (role.managed) return reply(h.errorEmbed('Invalid role', `${role} is managed by an integration.`));
      if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return reply(h.errorEmbed('Missing permissions', 'I need **Manage Roles** to assign the gate role.'));
      if (role.position >= me.roles.highest.position) return reply(h.errorEmbed('Role hierarchy', `${role} is equal to or above my highest role. Move my role higher.`));
      const next = save(gid, { roleId: role.id }); sync(g, next);
      return reply(panel(next).setColor(ui.OK));
    }

    if (sub === 'message') {
      const text = String(i.options.getString('text') || '').trim();
      if (!text) return reply(h.errorEmbed('Invalid text', 'The message cannot be empty.'));
      if (text.length > 1000) return reply(h.errorEmbed('Too long', `TTS text is limited to 1000 characters (you sent ${text.length}).`));
      if (cfg.audioPath) await sys.removeGreetvoiceAudio(cfg.audioPath);
      return reply(panel(save(gid, { ttsPrompt: text, audioPath: null, mode: 'tts' })).setColor(ui.OK));
    }

    if (sub === 'voice') {
      const key = i.options.getString('voice');
      if (!sys.TTS_VOICES[key]) return reply(h.errorEmbed('Unknown voice', 'Pick one from the list.'));
      return reply(panel(save(gid, { ttsVoice: key })).setColor(ui.OK));
    }

    if (sub === 'audio') {
      const att = i.options.getAttachment?.('file');
      if (!att) return reply(h.errorEmbed('No file', 'Attach an audio file (mp3, wav, ogg, m4a…) to the command.'));
      if (isSlashLike(i)) await i.deferReply({ ephemeral: true });
      try {
        const saved = await sys.saveGreetvoiceAudio(gid, att);
        return h.safeReply(i, { embeds: [panel(save(gid, { audioPath: saved, mode: 'audio' })).setColor(ui.OK)], ephemeral: true });
      } catch (e) { return h.safeReply(i, { embeds: [h.errorEmbed('Could not save audio', String(e?.message || e))], ephemeral: true }); }
    }

    if (sub === 'test') {
      if (isSlashLike(i)) await i.deferReply({ ephemeral: true });
      try {
        console.log(`[GreetVoice] test requested by ${i.user.id}`);
        await sys.playGreetvoiceGreeting(g, cfg);
        return h.safeReply(i, { embeds: [h.successEmbed('Greeting played', 'Playback finished without errors.')], ephemeral: true });
      } catch (e) {
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

// ---------------------------------------------------------------------------------
// /greetvoicesetup — interactive panel
// ---------------------------------------------------------------------------------
const isAdmin = i => i.memberPermissions?.has(PermissionFlagsBits.Administrator) || i.member?.permissions?.has?.(PermissionFlagsBits.Administrator);
const renderPanel = (gid, notes = []) => { const cfg = cfgOf(gid); return { embeds: [ui.greetVoiceSetupEmbed(cfg, notes)], components: ui.greetVoiceSetupRow(cfg) }; };

// Join the VC if needed + sweep the role's channel permissions. Returns human-readable report lines.
async function applyVoiceSetup(guild, cfg) {
  const notes = [];
  if (cfg.vcId) {
    try {
      const r = await sys.ensureBotInVC(guild, cfg.vcId);
      notes.push(r.joined ? `🔊 Joined ${r.channel}.` : `🔊 Already connected to ${r.channel}.`);
    } catch (e) { notes.push(`⚠️ Could not join the voice channel: ${e.message}`); }
  }
  const role = cfg.roleId && guild.roles.cache.get(cfg.roleId);
  if (role && cfg.vcId) {
    try {
      const r = await sys.lockRoleToSingleChannel(guild, role, cfg.vcId);
      notes.push(`🔒 ${role}: hid **${r.hidden}** channel(s), **${r.alreadyHidden}** already hidden, greeting VC visible.`);
      if (r.adminBypass) notes.push('⚠️ That role has **Administrator**, which ignores channel permissions. Remove it from the role.');
      if (r.failed.length) notes.push(`⚠️ ${r.failed.length} channel(s) could not be changed (check my Manage Channels/role position).`);
    } catch (e) { notes.push(`⚠️ Permission sweep failed: ${e.message}`); }
  } else if (!role) notes.push('ℹ️ Choose a gate role to lock it to the greeting channel.');
  return notes;
}

const setupCommand = {
  data: new SlashCommandBuilder().setName('greetvoicesetup').setDescription('Open the easy Greet Voice setup panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(i) {
    if (!i.guild) return h.safeReply(i, { embeds: [h.errorEmbed('Server only', 'Use this inside a server.')], ephemeral: true });
    if (!isAdmin(i)) return h.safeReply(i, { embeds: [h.errorEmbed('Missing Permissions', 'You need **Administrator**.')], ephemeral: true });
    if (isSlashLike(i)) await i.deferReply({ ephemeral: true });
    const cfg = cfgOf(i.guildId);
    const notes = cfg.vcId || cfg.roleId ? await applyVoiceSetup(i.guild, cfg) : [];
    return h.safeReply(i, { ...renderPanel(i.guildId, notes), ephemeral: true });
  }
};

async function handleSetupInteraction(i) {
  const id = i.customId; const gid = i.guildId; const g = i.guild;
  if (!isAdmin(i)) { await i.reply({ embeds: [h.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true }); return true; }
  const redraw = (notes = []) => i.editReply(renderPanel(gid, notes));

  if (id === 'greetvoice_cfg:voice' && i.isChannelSelectMenu()) {
    await i.deferUpdate();
    const cfg = save(gid, { vcId: i.values[0] });
    return void await redraw(await applyVoiceSetup(g, cfg));
  }
  if (id === 'greetvoice_cfg:role_select' && i.isRoleSelectMenu()) {
    const role = g.roles.cache.get(i.values[0]); const me = g.members.me;
    const bad = !role ? 'That role no longer exists.' : role.id === gid ? '@everyone cannot be the Greet Voice role.' : role.managed ? 'That role is managed by an integration.'
      : !me?.permissions.has(PermissionFlagsBits.ManageRoles) ? 'I need **Manage Roles**.' : role.position >= me.roles.highest.position ? `${role} is equal to or above my highest role — move my role higher.` : null;
    await i.deferUpdate();
    if (bad) return void await redraw([`⚠️ ${bad}`]);
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
      onSave: async text => { const c = cfgOf(gid); if (c.audioPath) await sys.removeGreetvoiceAudio(c.audioPath); save(gid, { ttsPrompt: text, audioPath: null, mode: 'tts' }); },
      render: () => renderPanel(gid, ['✅ Prompt saved.'])
    });
  }
  if (id === 'greetvoice_cfg:audio') {
    return void await h.startTextCapture(i, {
      title: '🎵 Send your audio file', hint: 'Upload an **mp3 / wav / ogg / m4a** file as a message below. I will save it and delete the upload.', accept: 'audio',
      onSave: async att => { const old = cfgOf(gid).audioPath; const saved = await sys.saveGreetvoiceAudio(gid, att); save(gid, { audioPath: saved, mode: 'audio' }); if (old && old !== saved) await sys.removeGreetvoiceAudio(old); },
      render: () => renderPanel(gid, ['✅ Audio saved.'])
    });
  }
  if (id === 'greetvoice_cfg:remove_audio') {
    await i.deferUpdate();
    const c = cfgOf(gid); if (c.audioPath) await sys.removeGreetvoiceAudio(c.audioPath);
    save(gid, { audioPath: null, mode: 'tts' });
    return void await redraw();
  }
  if (id === 'greetvoice_cfg:mode') {
    await i.deferUpdate();
    const c = cfgOf(gid); const next = c.mode === 'audio' ? 'tts' : 'audio';
    if (next === 'audio' && !c.audioPath) return void await redraw(['⚠️ Upload an audio file first.']);
    if (next === 'tts' && !c.ttsPrompt) return void await redraw(['⚠️ Set a TTS prompt first.']);
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
    if (!c.vcId || (!c.ttsPrompt && !c.audioPath)) return void await redraw(['⚠️ Choose a voice channel and set a prompt/audio first.']);
    await redraw(['▶️ Playing the greeting…']);
    try { await sys.playGreetvoiceGreeting(g, c); return void await redraw(['✅ Test finished playing.']); }
    catch (e) { return void await redraw([`⚠️ Test failed: ${String(e?.message || e).slice(0, 300)}`]); }
  }
  return false;
}

async function handleInteraction(i) {
  const id = i.customId;
  if (id && id.startsWith('greetvoice_cfg:')) {
    try { const r = await handleSetupInteraction(i); return r !== false; }
    catch (e) {
      console.error('[GreetVoice] setup interaction failed:', e);
      await h.safeReply(i, { embeds: [h.errorEmbed('Greet Voice error', String(e?.message || e).slice(0, 1200))], ephemeral: true });
      return true;
    }
  }
  if (!id || !id.startsWith('gvreset:')) return false;
  const [, uid, choice] = id.split(':');
  try {
    if (!await h.authorOnly(i, uid)) return true;
    if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) { await i.reply({ embeds: [h.errorEmbed('Missing permissions', 'You need **Manage Server**.')], ephemeral: true }); return true; }
    if (choice !== 'yes') { await i.update({ embeds: [h.infoEmbed('Cancelled', 'Nothing changed.')], components: [] }); return true; }
    const cfg = cfgOf(i.guildId);
    if (cfg.audioPath) await sys.removeGreetvoiceAudio(cfg.audioPath);
    const next = save(i.guildId, { ...db.DEFAULT_CONFIG.greetvoice });
    await i.update({ embeds: [panel(next).setColor(ui.OK).setTitle('Greet Voice reset')], components: [] });
  } catch (e) { console.error('[GreetVoice] reset failed:', e); await h.safeReply(i, { embeds: [h.errorEmbed('Reset failed', String(e?.message || e))], ephemeral: true }); }
  return true;
}

module.exports = { commands: [command, setupCommand], handleInteraction, applyVoiceSetup };
