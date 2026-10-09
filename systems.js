// systems.js — the "brains" behind every automated feature. Pure functions/handlers that
// events.js and handlers.js call into. Keeping this separate from event wiring keeps each
// system testable/readable on its own.

const { PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, StreamType, entersState, getVoiceConnection,
  generateDependencyReport
} = require('@discordjs/voice');
const googleTTS = require('google-tts-api');
const db = require('./database');
const ui = require('./ui');
const { Readable } = require('stream');

// Make the bundled ffmpeg-static binary discoverable to prism-media/@discordjs/voice.
try {
  const ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath) {
    process.env.FFMPEG_BIN = ffmpegPath;
    process.env.FFMPEG_PATH = ffmpegPath;
    const ffmpegDir = path.dirname(ffmpegPath);
    process.env.PATH = `${ffmpegDir}${path.delimiter}${process.env.PATH || ''}`;
  }
} catch (e) {
  console.warn('[AunXz] ffmpeg-static could not be loaded:', e.message);
}

// Track the active voice connection while audio plays; playback cleanup destroys it afterward.
const persistentConnections = new Map(); // guildId -> connection

async function joinAndStayInVC(voiceChannel) {
  let connection = getVoiceConnection(voiceChannel.guild.id);
  if (connection && connection.joinConfig?.channelId !== voiceChannel.id) {
    try { connection.destroy(); } catch {}
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
      } catch {
        const freshChannel = voiceChannel.guild.channels.cache.get(voiceChannel.id);
        if (freshChannel) {
          try { connection.destroy(); } catch {}
          persistentConnections.delete(voiceChannel.guild.id);
          setTimeout(() => joinAndStayInVC(freshChannel).catch(() => {}), 1000);
        }
      }
    });
  }
  // Discord voice connections can take a moment to become usable. Waiting for Ready
  // avoids the common "operation was aborted" / aborted playback race on Railway.
  await entersState(connection, VoiceConnectionStatus.Ready, 15000);
  return connection;
}

function downloadAudio(url) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.get(url, { headers: { 'User-Agent': 'AunXz/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadAudio(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`TTS HTTP ${res.statusCode}`)); }
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

async function playAudioInput(guild, vcId, input, label = 'audio', shouldPlay = null) {
  if (!guild || !vcId) throw new Error('Choose a Greet Voice channel before testing playback.');
  const channel = guild.channels.cache.get(vcId) || await guild.channels.fetch(vcId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error('The configured Greet Voice channel was not found or is not a voice channel.');
  if (typeof input === 'string' && !fs.existsSync(input)) throw new Error(`${label} file is missing on disk. Upload it again from Greet Voice setup.`);

  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me) throw new Error('I could not resolve my bot member in this server. Re-invite the bot and try again.');
  const permissions = me.permissionsIn(channel);
  if (!permissions.has(PermissionFlagsBits.ViewChannel)) throw new Error(`I cannot view ${channel}.`);
  if (!permissions.has(PermissionFlagsBits.Connect)) throw new Error(`I cannot connect to ${channel}.`);
  if (!permissions.has(PermissionFlagsBits.Speak)) throw new Error(`I cannot speak in ${channel}.`);
  if (shouldPlay && !shouldPlay()) throw new Error('The member left the greeting voice channel before playback could start.');

  const connection = await joinAndStayInVC(channel);
  console.log(`[GreetVoice] Voice connection ready in guild ${guild.id}, channel ${vcId}.`);
  let player = null;
  try {
    if (shouldPlay && !shouldPlay()) throw new Error('The member left the greeting voice channel before playback could start.');
    player = createAudioPlayer({ behaviors: { noSubscriber: 'stop' } });
    const subscription = connection.subscribe(player);
    if (!subscription) throw new Error('The bot could not subscribe its audio player to the voice connection.');
    const resource = createAudioResource(input, { inputType: StreamType.Arbitrary, silencePaddingFrames: 5 });
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { player.stop(true); } catch {}
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(() => finish(new Error(`${label} playback timed out after 45 seconds.`)), 45000);
      player.once(AudioPlayerStatus.Idle, () => { console.log(`[GreetVoice] Playback finished in guild ${guild.id}.`); finish(); });
      player.once('error', err => finish(new Error(`Voice audio playback failed: ${err.message || err}`)));
      try { player.play(resource); console.log(`[GreetVoice] Playback started (${label}) in guild ${guild.id}.`); }
      catch (e) { finish(e); }
    }).catch(err => {
      let dependency = '';
      try { dependency = generateDependencyReport(); } catch {}
      if (dependency) console.error('[AunXz] Voice dependency report:\n' + dependency);
      throw err;
    });
  } finally {
    try { player?.stop(true); } catch {}
    try { if (getVoiceConnection(guild.id) === connection) connection.destroy(); } catch {}
    persistentConnections.delete(guild.id);
    console.log(`[GreetVoice] Voice connection cleaned up for guild ${guild.id}.`);
  }
}

async function playTTSInChannel(guild, vcId, prompt, shouldPlay = null) {
  const text = String(prompt || 'Welcome!').trim().slice(0, 200) || 'Welcome!';
  const url = googleTTS.getAudioUrl(text, { lang: 'en', slow: false, host: 'https://translate.google.com' });
  const buffer = await binaryDownload(url, 'TTS audio');
  if (!buffer.length) throw new Error('TTS returned an empty audio file.');
  if (shouldPlay && !shouldPlay()) throw new Error('The member left the greeting voice channel before playback could start.');
  return playAudioInput(guild, vcId, Readable.from(buffer), 'TTS', shouldPlay);
}

async function saveGreetvoiceAudio(guildId, attachment) {
  if (!/^\d{15,25}$/.test(String(guildId || ''))) throw new Error('A valid server ID is required to save this audio file.');
  if (!attachment?.url) throw new Error('No audio attachment was provided. Try uploading the file again.');
  const name = String(attachment.name || attachment.filename || '').toLowerCase();
  const type = String(attachment.contentType || '').toLowerCase();
  const audioByType = type.startsWith('audio/');
  const audioByExt = /\.(mp3|wav|ogg|oga|opus|webm|m4a|aac|flac)$/i.test(name);
  if (!audioByType && !audioByExt) throw new Error('Please upload an audio file such as MP3, WAV, OGG, M4A, AAC, or FLAC.');

  const dataDir = typeof db.DATA_DIR === 'string' && db.DATA_DIR.trim() ? db.DATA_DIR : path.dirname(db.DB_PATH);
  if (!dataDir) throw new Error('Audio storage is not configured. Check DATABASE_PATH or RAILWAY_VOLUME_MOUNT_PATH.');
  const dir = path.join(path.resolve(dataDir), 'greetvoice');
  await fs.promises.mkdir(dir, { recursive: true });
  const extMatch = name.match(/\.[a-z0-9]+$/i);
  const ext = extMatch ? extMatch[0].toLowerCase() : '.audio';
  const target = path.join(dir, `${guildId}${ext}`);
  const buffer = await binaryDownload(attachment.url, 'Greet Voice audio');
  if (!buffer?.length) throw new Error('Discord returned an empty audio file. Upload it again.');
  await fs.promises.writeFile(target, buffer);
  return target;
}

async function removeGreetvoiceAudio(audioPath) {
  if (!audioPath) return;
  const resolved = path.resolve(audioPath);
  const dataDir = typeof db.DATA_DIR === 'string' && db.DATA_DIR.trim() ? db.DATA_DIR : path.dirname(db.DB_PATH || __dirname);
  const root = path.resolve(path.join(dataDir, 'greetvoice'));
  if (!resolved.startsWith(root + path.sep)) return;
  await fs.promises.unlink(resolved).catch(() => {});
}

async function playGreetvoiceGreeting(guild, cfg, memberId = null) {
  const shouldPlay = memberId ? () => guild.members.cache.get(memberId)?.voice?.channelId === cfg?.vcId : null;
  if (!cfg?.vcId) throw new Error('Select a greeting voice channel in Greet Voice setup first.');
  if (cfg.mode === 'audio') {
    if (!cfg.audioPath) throw new Error('Audio mode is selected but no audio file is saved. Upload an audio greeting or set a TTS message.');
    return playAudioInput(guild, cfg.vcId, cfg.audioPath, 'Greet Voice audio', shouldPlay);
  }
  if (cfg.ttsPrompt && String(cfg.ttsPrompt).trim()) return playTTSInChannel(guild, cfg.vcId, cfg.ttsPrompt, shouldPlay);
  if (cfg.audioPath) return playAudioInput(guild, cfg.vcId, cfg.audioPath, 'Greet Voice audio', shouldPlay);
  throw new Error('Set a TTS message or upload an audio file in Greet Voice setup.');
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
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles) && !me?.permissions.has(PermissionFlagsBits.Administrator)) {
    throw new Error('I need **Manage Roles** to configure the Greet Voice gate role.');
  }
  if (role.position >= me.roles.highest.position) {
    throw new Error(`I cannot manage **${role.name}** because it is equal to or higher than my highest role.`);
  }
  const jobs = [];
  for (const [, channel] of guild.channels.cache) {
    if (!channel.permissionOverwrites) continue;
    const patch = channel.id === allowedChannelId
      ? { ViewChannel: true, Connect: true }
      : { ViewChannel: false };
    jobs.push(channel.permissionOverwrites.edit(role, patch));
  }
  await Promise.allSettled(jobs);
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
  const bot = member.guild.members.me;
  if (!bot?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= bot.roles.highest.position) {
    const log = await getLogChannel(member.guild, 'voice');
    if (log) log.send({ embeds: [ui.errorEmbed('🔊 Greet Voice Role Failed', `I cannot assign <@&${role.id}>. Give me **Manage Roles** and move my bot role above the gate role.`)] }).catch(() => {});
    return;
  }
  const added = await member.roles.add(role, 'greetvoice gate').then(() => true).catch(() => false);
  if (!added) {
    const log = await getLogChannel(member.guild, 'voice');
    if (log) log.send({ embeds: [ui.errorEmbed('🔊 Greet Voice Role Failed', `Discord rejected the role assignment for ${member}. Check my **Manage Roles** permission and role hierarchy.`)] }).catch(() => {});
  }
}

// TTS playback handled here so events.js just calls this on voiceStateUpdate.
const greetvoiceCooldowns = new Map();
const greetvoiceGuildCooldowns = new Map();
async function onVoiceJoinGreetvoice(oldState, newState) {
  const guild = newState?.guild;
  const member = newState?.member;
  console.log(`[GreetVoice] voiceStateUpdate fired guild=${guild?.id || 'unknown'} user=${member?.id || 'unknown'} old=${oldState?.channelId || 'none'} new=${newState?.channelId || 'none'}`);
  if (!guild || !member || member.user?.bot) return;
  // Only a true join from disconnected state triggers this feature; channel moves do not.
  if (oldState?.channelId || !newState?.channelId) return;
  const cfg = db.getConfig(guild.id)?.greetvoice || {};
  console.log(`[GreetVoice] Config loaded enabled=${Boolean(cfg.enabled)} vcId=${cfg.vcId || 'unset'} roleId=${cfg.roleId || 'unset'} mode=${cfg.mode || 'tts'}`);
  if (!cfg.enabled || !cfg.vcId || newState.channelId !== cfg.vcId) return;
  if (!member.voice || member.voice.channelId !== cfg.vcId) { console.log('[GreetVoice] Member left before the greeting began; skipping.'); return; }
  const role = cfg.roleId ? guild.roles.cache.get(cfg.roleId) : null;
  if (!role) { console.error(`[GreetVoice] Configured gate role ${cfg.roleId || '(missing)'} does not exist in guild ${guild.id}.`); return; }
  if (!member.roles.cache.has(role.id)) return;
  const now = Date.now();
  const cooldownKey = `${guild.id}:${member.id}`;
  const userUntil = greetvoiceCooldowns.get(cooldownKey) || 0;
  if (userUntil > now) { console.log(`[GreetVoice] Per-user cooldown active for ${member.id}; skipping repeated join.`); return; }
  const guildUntil = greetvoiceGuildCooldowns.get(guild.id) || 0;
  if (guildUntil > now) { console.log(`[GreetVoice] Per-guild cooldown active for ${guild.id}; skipping overlapping greeting.`); return; }
  greetvoiceCooldowns.set(cooldownKey, now + 60_000);
  // A single voice player is used per guild. This prevents two rapid joins from
  // destroying each other's connections or overlapping TTS audio.
  greetvoiceGuildCooldowns.set(guild.id, now + 15_000);
  if (greetvoiceCooldowns.size > 10000) for (const [k, time] of greetvoiceCooldowns) if (time <= now) greetvoiceCooldowns.delete(k);
  if (greetvoiceGuildCooldowns.size > 5000) for (const [k, time] of greetvoiceGuildCooldowns) if (time <= now) greetvoiceGuildCooldowns.delete(k);
  const channel = guild.channels.cache.get(cfg.vcId) || await guild.channels.fetch(cfg.vcId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    console.error(`[GreetVoice] Configured voice channel ${cfg.vcId} was deleted or is not a voice channel.`);
    return;
  }
  const bot = guild.members.me || await guild.members.fetchMe().catch(() => null);
  const perms = bot?.permissionsIn(channel);
  const missing = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak].filter(p => !perms?.has(p));
  if (missing.length) {
    const text = `Missing bot permissions in ${channel}: ${missing.map(p => p === PermissionFlagsBits.ViewChannel ? 'View Channel' : p === PermissionFlagsBits.Connect ? 'Connect' : 'Speak').join(', ')}.`;
    console.error(`[GreetVoice] ${text}`);
    const log = await getLogChannel(guild, 'voice');
    if (log) log.send({ embeds: [ui.errorEmbed('Greet Voice Permissions', text)] }).catch(() => {});
    return;
  }
  try {
    console.log(`[GreetVoice] Permissions checked for ${channel.id}; preparing greeting.`);
    await playGreetvoiceGreeting(guild, cfg, member.id);
    console.log(`[GreetVoice] Greeting completed for ${member.id}.`);
  } catch (error) {
    console.error('[GreetVoice] Greeting failed:', error);
    const log = await getLogChannel(guild, 'voice');
    if (log) log.send({ embeds: [ui.errorEmbed('Greet Voice Failed', `The greeting could not be played for ${member}: ${String(error?.message || error).slice(0,700)}
Check View Channel, Connect and Speak, and verify the saved audio file or TTS message.`)] }).catch(() => {});
    return;
  }
  const freshMember = await guild.members.fetch(member.id).catch(() => null);
  // The audio player's connection is destroyed by playAudioInput() in its finally block.
  // Never disconnect the member: Greet Voice should greet them, not kick them from voice.
  if (freshMember?.voice?.channelId === cfg.vcId) {
    await freshMember.roles.remove(role, 'Greet Voice greeting completed').catch(error => {
      console.error(`[GreetVoice] Could not remove gate role ${role.id} from ${member.id}:`, error);
    });
  }
}

async function handleVoiceStateUpdate(oldState, newState) {
  await handleVoicemasterJoin(oldState, newState);
  await onVoiceJoinGreetvoice(oldState, newState);
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

// ===================================================================================
// EXTRA SECURITY: ANTI-WEBHOOK / ANTI-BOT / ANTI-ALT
// ===================================================================================
async function securityLog(guild, cfg, title, description) {
  const channel = cfg.logChannelId ? guild.channels.cache.get(cfg.logChannelId) : await getLogChannel(guild, 'antinuke');
  if (channel?.isTextBased()) await channel.send({ embeds: [ui.errorEmbed(title, description)] }).catch(() => {});
}
async function handleAntiBotJoin(member) {
  const cfg=db.getConfig(member.guild.id).antibot; if(!cfg.enabled||!member.user.bot)return;
  if(cfg.bypassRoleId){
    const logs=await member.guild.fetchAuditLogs({type:AuditLogEvent.BotAdd,limit:5}).catch(()=>null);
    const entry=logs?.entries.find(e=>e.target?.id===member.id && Date.now()-e.createdTimestamp<15000);
    const inviter=entry?.executor ? await member.guild.members.fetch(entry.executor.id).catch(()=>null) : null;
    if(inviter?.roles.cache.has(cfg.bypassRoleId))return;
  }
  if(cfg.action==='ban') await member.ban({reason:'Anti-Bot protection'}).catch(()=>{}); else if(cfg.action==='strip_roles') await member.roles.set([],'Anti-Bot protection').catch(()=>{}); else await member.kick('Anti-Bot protection').catch(()=>{});
  await securityLog(member.guild,cfg,'🤖 Anti-Bot Triggered',`**Bot:** ${member.user.tag} (<@${member.id}>)\n**Action:** ${cfg.action}`);
}
async function handleAntiAltJoin(member) {
  const cfg=db.getConfig(member.guild.id).antialt; if(!cfg.enabled||member.user.bot)return;
  const ageDays=(Date.now()-member.user.createdTimestamp)/86400000; if(ageDays>=Number(cfg.minAccountAgeDays||0))return;
  if(cfg.action==='ban') await member.ban({reason:'Anti-Alt: account too new'}).catch(()=>{}); else await member.kick('Anti-Alt: account too new').catch(()=>{});
  await securityLog(member.guild,cfg,'🛡️ Anti-Alt Triggered',`**User:** ${member.user.tag} (<@${member.id}>)\n**Account age:** ${ageDays.toFixed(1)} days\n**Minimum:** ${cfg.minAccountAgeDays} days\n**Action:** ${cfg.action}`);
}
async function handleAntiWebhookUpdate(channel) {
  const cfg=db.getConfig(channel.guild.id).antiwebhook; if(!cfg.enabled)return;
  const executor=await findAuditExecutor(channel.guild,AuditLogEvent.WebhookCreate,null).catch(()=>null); if(!executor||executor.id===channel.client.user?.id)return;
  const member=await channel.guild.members.fetch(executor.id).catch(()=>null); if(!member)return;
  if(cfg.bypassRoleId&&member.roles.cache.has(cfg.bypassRoleId))return;
  try {
    const hooks=await channel.fetchWebhooks().catch(()=>null);
    if(hooks) for(const [,hook] of hooks) if(hook.owner?.id===executor.id) await hook.delete('Anti-Webhook protection').catch(()=>{});
    if(cfg.action==='ban') await member.ban({reason:'Anti-Webhook protection'}).catch(()=>{}); else if(cfg.action==='kick') await member.kick('Anti-Webhook protection').catch(()=>{}); else if(cfg.action==='strip_roles') await member.roles.set([],'Anti-Webhook protection').catch(()=>{});
  } finally { await securityLog(channel.guild,cfg,'🪝 Anti-Webhook Triggered',`**Executor:** ${executor.tag||executor.username} (<@${executor.id}>)\n**Channel:** ${channel}\n**Action:** ${cfg.action}`); }
}

// ---------------------------------------------------------------------------------
// autoresponder / autoreactor — simple keyword-triggered text replies and emoji reactions.
// Both share the same trigger shape: { id, match, mode: 'exact'|'contains' }.
// ---------------------------------------------------------------------------------
function triggerMatches(content, trigger, ignoreCase) {
  const text = ignoreCase ? content.toLowerCase() : content;
  const match = ignoreCase ? String(trigger.match || '').toLowerCase() : String(trigger.match || '');
  if (!match) return false;
  if (trigger.mode === 'exact') return text.trim() === match.trim();
  return text.includes(match);
}

async function handleAutoresponder(message) {
  const cfg = db.getConfig(message.guild.id).autoresponder;
  if (!cfg.enabled || !cfg.triggers.length) return;
  const trigger = cfg.triggers.find(t => triggerMatches(message.content, t, cfg.ignoreCase));
  if (!trigger) return;
  const response = String(trigger.response || '')
    .replace(/\{user\}/g, `${message.author}`)
    .replace(/\{server\}/g, message.guild.name);
  if (!response) return;
  await message.channel.send({ content: response.slice(0, 2000), allowedMentions: { repliedUser: false } }).catch(() => {});
}

async function handleAutoreactor(message) {
  const cfg = db.getConfig(message.guild.id).autoreactor;
  if (!cfg.enabled || !cfg.triggers.length) return;
  for (const trigger of cfg.triggers) {
    if (!triggerMatches(message.content, trigger, cfg.ignoreCase)) continue;
    for (const em of (trigger.emojis || []).slice(0, 5)) {
      await message.react(em).catch(() => {});
    }
  }
}

// In-memory draft state for /embedbuilder — keyed by userId, cleared once posted.
// Not persisted: an in-progress draft is meant to be finished in one sitting.
const embedBuilderSessions = new Map();

module.exports = {
  joinAndStayInVC, playTTSInChannel, playAudioInput, playGreetvoiceGreeting, saveGreetvoiceAudio, removeGreetvoiceAudio,
  antinukeStrike, findAuditExecutor, getLogChannel,
  handleAntiraidJoin,
  handleAntiBotJoin, handleAntiAltJoin, handleAntiWebhookUpdate,
  handleAntilink,
  handleAntispam,
  lockRoleToSingleChannel, onChannelCreateGreetvoiceSync, onMemberJoinGreetvoice, onVoiceJoinGreetvoice,
  xpForLevel, handleLevelingMessage,
  handleVoicemasterJoin, handleVoiceStateUpdate,
  handleAutoresponder, handleAutoreactor,
  embedBuilderSessions
};
