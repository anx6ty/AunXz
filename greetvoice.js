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
    .addSubcommand(s => s.setName('message').setDescription('Set the spoken (TTS) greeting.').addStringOption(o => o.setName('text').setDescription('Text to speak (max 200 chars)').setRequired(true)))
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
      if (text.length > 200) return reply(h.errorEmbed('Too long', `TTS text is limited to 200 characters (you sent ${text.length}).`));
      if (cfg.audioPath) await sys.removeGreetvoiceAudio(cfg.audioPath);
      return reply(panel(save(gid, { ttsPrompt: text, audioPath: null, mode: 'tts' })).setColor(ui.OK));
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

async function handleInteraction(i) {
  const id = i.customId;
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

module.exports = { commands: [command], handleInteraction };
