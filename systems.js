// systems.js — the "brains" behind every automated feature. Pure functions/handlers that
// events.js and handlers.js call into. Keeping this separate from event wiring keeps each
// system testable/readable on its own.

const { PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState, getVoiceConnection
} = require('@discordjs/voice');
const googleTTS = require('google-tts-api');
const db = require('./database');
const ui = require('./ui');

// Keep one persistent connection per guild so the bot "won't leave" the greetvoice VC.
const persistentConnections = new Map(); // guildId -> connection

async function joinAndStayInVC(voiceChannel) {
  let connection = getVoiceConnection(voiceChannel.guild.id);
  if (!connection) {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false
    });
    persistentConnections.set(voiceChannel.guild.id, connection);
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000)
        ]);
      } catch {
        // real disconnect (e.g. kicked / VC deleted) — rejoin if the channel still exists
        const freshChannel = voiceChannel.guild.channels.cache.get(voiceChannel.id);
        if (freshChannel) joinAndStayInVC(freshChannel).catch(() => {});
      }
    });
  }
  return connection;
}

// Plays a TTS prompt in the given VC and resolves once playback finishes.
async function playTTSInChannel(guild, vcId, prompt) {
  const channel = guild.channels.cache.get(vcId);
  if (!channel) return;
  const connection = await joinAndStayInVC(channel);
  const player = createAudioPlayer();
  connection.subscribe(player);

  const text = (prompt || 'Welcome!').slice(0, 200);
  const url = googleTTS.getAudioUrl(text, { lang: 'en', slow: false, host: 'https://translate.google.com' });
  const resource = createAudioResource(url);
  player.play(resource);

  await new Promise((resolve) => {
    player.once(AudioPlayerStatus.Idle, resolve);
    player.once('error', resolve);
    setTimeout(resolve, 15000); // safety timeout so a bad TTS response can't hang the flow forever
  });
}

// ===================================================================================
// ANTINUKE
// ===================================================================================
// In-memory sliding-window counters: key = `${guildId}:${executorId}:${actionType}`
const nukeWindows = new Map();

async function getLogChannel(guild, key) {
  const cfg = db.getConfig(guild.id);
  const id = cfg.logs[key] || cfg.logs.antinuke;
  if (!id) return null;
  const ch = guild.channels.cache.get(id);
  return ch && ch.isTextBased() ? ch : null;
}

async function findAuditExecutor(guild, actionType, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type: actionType, limit: 5 });
    const entry = logs.entries.find(e => Date.now() - e.createdTimestamp < 10_000 &&
      (!targetId || e.target?.id === targetId));
    return entry ? entry.executor : null;
  } catch {
    return null;
  }
}

async function antinukeStrike(guild, executor, actionLabel) {
  const cfg = db.getConfig(guild.id).antinuke;
  if (!cfg.enabled || !executor) return false;
  if (executor.id === guild.client.user.id) return false; // never punish the bot itself
  if (executor.id === guild.ownerId && cfg.protectOwner) return false;
  if (db.isWhitelisted(guild.id, executor.id)) return false;

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
  } else {
    count = w.count + 1;
    w.count = count;
  }
  if (count < limit) return false;
  nukeWindows.delete(key);

  // punish
  const member = await guild.members.fetch(executor.id).catch(() => null);
  let action = 'none';
  try {
    if (member) {
      if (cfg.punishment === 'ban') { await member.ban({ reason: `Antinuke: ${actionLabel} flood` }); action = 'banned'; }
      else if (cfg.punishment === 'kick') { await member.kick(`Antinuke: ${actionLabel} flood`); action = 'kicked'; }
      else { await member.roles.set([], `Antinuke: ${actionLabel} flood`); action = 'stripped roles from'; }
    }
  } catch (e) { action = `failed to punish (${e.message})`; }

  db.logAction(guild.id, executor.id, 'antinuke', `${actionLabel} flood → ${action}`);
  const log = await getLogChannel(guild, 'antinuke');
  if (log) {
    const embed = ui.errorEmbed('🛡️ Antinuke Triggered',
      `**User:** ${executor.tag} (${executor.id})\n**Trigger:** ${actionLabel} flood (${count}/${limit})\n**Action taken:** ${action}`);
    log.send({ embeds: [embed] }).catch(() => {});
  }
  return true;
}

// ===================================================================================
// ANTIRAID
// ===================================================================================
async function handleAntiraidJoin(member) {
  const cfg = db.getConfig(member.guild.id).antiraid;
  if (!cfg.enabled) return;
  db.trackJoin(member.guild.id, member.id);

  const accountAgeDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
  if (accountAgeDays < cfg.minAccountAgeDays) {
    await member.kick('Antiraid: account too new').catch(() => {});
    db.logAction(member.guild.id, member.id, 'antiraid', `kicked (account age ${accountAgeDays.toFixed(1)}d)`);
    return;
  }

  const joins = db.recentJoinCount(member.guild.id, cfg.windowSeconds);
  if (joins >= cfg.joinThreshold) {
    db.logAction(member.guild.id, member.id, 'antiraid', `raid detected: ${joins} joins/${cfg.windowSeconds}s`);
    const log = await getLogChannel(member.guild, 'antinuke');
    if (log) log.send({ embeds: [ui.errorEmbed('🚨 Raid Detected', `${joins} joins in ${cfg.windowSeconds}s. Action: **${cfg.action}**`)] }).catch(() => {});

    if (cfg.action === 'lockdown') {
      const everyone = member.guild.roles.everyone;
      const textChannels = member.guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
      for (const [, ch] of textChannels) {
        await ch.permissionOverwrites.edit(everyone, { SendMessages: false }).catch(() => {});
      }
    } else if (cfg.action === 'kick_new') {
      await member.kick('Antiraid lockdown').catch(() => {});
    }
  }
}

// ===================================================================================
// ANTILINK
// ===================================================================================
const LINK_REGEX = /(https?:\/\/[^\s]+|discord\.gg\/[^\s]+)/gi;

async function handleAntilink(message) {
  const cfg = db.getConfig(message.guild.id).antilink;
  if (!cfg.enabled) return;
  if (cfg.whitelistedChannels.includes(message.channel.id)) return;
  if (cfg.bypassRoleId && message.member.roles.cache.has(cfg.bypassRoleId)) return;
  if (message.member.permissions.has(PermissionFlagsBits.Administrator)) return;

  const links = message.content.match(LINK_REGEX);
  if (!links) return;
  const allowed = links.every(l => cfg.whitelistedDomains.some(d => l.includes(d)));
  if (allowed) return;

  await message.delete().catch(() => {});
  db.logAction(message.guild.id, message.author.id, 'antilink', `posted: ${links[0]}`);

  if (cfg.mode === 'warn' || cfg.mode === 'mute') {
    const warnMsg = await message.channel.send({ embeds: [ui.warnEmbed('🔗 Link Blocked', `${message.author}, links aren't allowed here.`)] });
    setTimeout(() => warnMsg.delete().catch(() => {}), 6000);
  }
  if (cfg.mode === 'mute') {
    const member = message.member;
    await member.timeout(5 * 60_000, 'Antilink violation').catch(() => {});
  }
  const log = await getLogChannel(message.guild, 'message');
  if (log) log.send({ embeds: [ui.errorEmbed('🔗 Antilink', `${message.author} posted a link in ${message.channel} — removed.`)] }).catch(() => {});
}

// ===================================================================================
// ANTISPAM
// ===================================================================================
async function handleAntispam(message) {
  const cfg = db.getConfig(message.guild.id).antispam;
  if (!cfg.enabled) return;
  if (message.member.permissions.has(PermissionFlagsBits.Administrator)) return;

  let punish = false;
  const msgCount = db.bumpSpam(message.guild.id, message.author.id, cfg.windowSeconds);
  if (msgCount > cfg.maxMessages) punish = true;

  const mentionCount = message.mentions.users.size + message.mentions.roles.size;
  if (mentionCount > cfg.maxMentions) punish = true;

  const emojiCount = (message.content.match(/<a?:\w+:\d+>|\p{Emoji_Presentation}/gu) || []).length;
  if (emojiCount > cfg.maxEmojis) punish = true;

  if (!punish) return;

  db.logAction(message.guild.id, message.author.id, 'antispam', `flood (msgs:${msgCount} mentions:${mentionCount} emojis:${emojiCount})`);
  const member = message.member;
  if (cfg.punishment === 'mute') {
    await member.timeout(cfg.muteMinutes * 60_000, 'Antispam violation').catch(() => {});
  } else if (cfg.punishment === 'kick') {
    await member.kick('Antispam violation').catch(() => {});
  } else if (cfg.punishment === 'ban') {
    await member.ban({ reason: 'Antispam violation' }).catch(() => {});
  }
  const notice = await message.channel.send({ embeds: [ui.errorEmbed('🚫 Spam Detected', `${message.author} was ${cfg.punishment}d for spamming.`)] });
  setTimeout(() => notice.delete().catch(() => {}), 8000);
  const log = await getLogChannel(message.guild, 'message');
  if (log) log.send({ embeds: [ui.errorEmbed('🚫 Antispam', `${message.author} triggered antispam in ${message.channel}.`)] }).catch(() => {});
}

// ===================================================================================
// GREETVOICE — role lockdown + TTS join/leave gate
// ===================================================================================
async function lockRoleToSingleChannel(guild, role, allowedChannelId) {
  for (const [, channel] of guild.channels.cache) {
    if (!channel.permissionOverwrites) continue;
    if (channel.id === allowedChannelId) {
      await channel.permissionOverwrites.edit(role, { ViewChannel: true, Connect: true }).catch(() => {});
    } else {
      await channel.permissionOverwrites.edit(role, { ViewChannel: false }).catch(() => {});
    }
  }
}

// Called from channelCreate — keeps the greetvoice role locked out of any brand new channel.
async function onChannelCreateGreetvoiceSync(channel) {
  const cfg = db.getConfig(channel.guild.id).greetvoice;
  if (!cfg.enabled || !cfg.roleId) return;
  const role = channel.guild.roles.cache.get(cfg.roleId);
  if (!role) return;
  if (channel.id === cfg.vcId) {
    await channel.permissionOverwrites.edit(role, { ViewChannel: true, Connect: true }).catch(() => {});
  } else {
    await channel.permissionOverwrites.edit(role, { ViewChannel: false }).catch(() => {});
  }
}

async function onMemberJoinGreetvoice(member) {
  const cfg = db.getConfig(member.guild.id).greetvoice;
  if (!cfg.enabled || !cfg.roleId || !cfg.vcId) return;
  const role = member.guild.roles.cache.get(cfg.roleId);
  if (!role) return;
  await member.roles.add(role, 'greetvoice gate').catch(() => {});
}

// TTS playback handled here so events.js just calls this on voiceStateUpdate.
async function onVoiceJoinGreetvoice(oldState, newState) {
  const guild = newState.guild;
  const cfg = db.getConfig(guild.id).greetvoice;
  if (!cfg.enabled || !cfg.vcId || newState.channelId !== cfg.vcId) return;
  const member = newState.member;
  const role = guild.roles.cache.get(cfg.roleId);
  if (!role || !member.roles.cache.has(role.id)) return; // only gate members still holding the role

  try {
    await playTTSInChannel(guild, cfg.vcId, cfg.ttsPrompt);
  } catch (e) {
    console.error('greetvoice TTS failed:', e.message);
    const log = await getLogChannel(guild, 'voice');
    if (log) {
      log.send({ embeds: [ui.errorEmbed('🔇 Greetvoice TTS Failed',
        `Could not play the greeting for ${member}: \`${e.message}\`.\n` +
        'If this keeps happening, make sure dependencies are installed (`npm install`) — the bot needs `ffmpeg-static` ' +
        'to transcode the TTS audio.')] }).catch(() => {});
    }
  }
  // after the prompt finishes (playTTSInChannel resolves when playback ends), disconnect + strip role
  const freshMember = await guild.members.fetch(member.id).catch(() => null);
  if (freshMember && freshMember.voice.channelId === cfg.vcId) {
    await freshMember.voice.disconnect('greetvoice complete').catch(() => {});
  }
  await freshMember?.roles.remove(role, 'greetvoice complete').catch(() => {});
}

// ===================================================================================
// LEVELING
// ===================================================================================
function xpForLevel(level) { return 5 * (level ** 2) + 50 * level + 100; }

async function handleLevelingMessage(message) {
  const cfg = db.getConfig(message.guild.id).leveling;
  if (!cfg.enabled) return;
  const rec = db.getLevel(message.guild.id, message.author.id);
  const now = Date.now();
  if (now - rec.lastMessage < cfg.cooldownSeconds * 1000) return;

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
    if (target?.isTextBased()) target.send({ embeds: [ui.levelUpEmbed(text)] }).catch(() => {});

    const roleId = cfg.roleRewards[String(level)];
    if (roleId) {
      const role = message.guild.roles.cache.get(roleId);
      if (role) await message.member.roles.add(role, `Level ${level} reward`).catch(() => {});
    }
  }
}

// ===================================================================================
// VOICEMASTER (join-to-create)
// ===================================================================================
async function handleVoicemasterJoin(oldState, newState) {
  const cfg = db.getConfig(newState.guild.id).voicemaster;
  if (!cfg.enabled || !cfg.hubChannelId) return;

  // user joined the hub -> spin up a personal channel and move them
  if (newState.channelId === cfg.hubChannelId) {
    const guild = newState.guild;
    const name = cfg.nameTemplate.replace('{user}', newState.member.displayName);
    const channel = await guild.channels.create({
      name, type: ChannelType.GuildVoice,
      parent: cfg.categoryId || newState.channel.parentId,
      permissionOverwrites: [
        { id: guild.roles.everyone, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
        { id: newState.member.id, allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers] }
      ]
    });
    db.addVMChannel(channel.id, guild.id, newState.member.id);
    await newState.member.voice.setChannel(channel).catch(() => {});
    const controlMsg = await channel.send({
      embeds: [ui.vmControlEmbed(newState.member)],
      components: ui.vmControlRows(channel)
    }).catch(() => {});
    return;
  }

  // user left a voicemaster-created channel -> delete it once empty
  if (oldState.channelId) {
    const vm = db.getVMChannel(oldState.channelId);
    if (vm && oldState.channel && oldState.channel.members.size === 0) {
      await oldState.channel.delete().catch(() => {});
      db.removeVMChannel(oldState.channelId);
    }
  }
}

module.exports = {
  joinAndStayInVC, playTTSInChannel,
  antinukeStrike, findAuditExecutor, getLogChannel,
  handleAntiraidJoin,
  handleAntilink,
  handleAntispam,
  lockRoleToSingleChannel, onChannelCreateGreetvoiceSync, onMemberJoinGreetvoice, onVoiceJoinGreetvoice,
  xpForLevel, handleLevelingMessage,
  handleVoicemasterJoin
};
