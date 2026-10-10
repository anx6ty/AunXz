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

// Keep one persistent connection per guild so the bot "won't leave" the greetvoice VC.
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

// Joins the VC only when the bot is not already in it. Returns { joined, channel }.
async function ensureBotInVC(guild, vcId) {
  const channel = guild.channels.cache.get(vcId) || await guild.channels.fetch(vcId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error('That is not a voice channel.');
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  const perms = me?.permissionsIn(channel);
  if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.Connect)) throw new Error(`I need **View Channel** and **Connect** in ${channel}.`);
  const existing = getVoiceConnection(guild.id);
  const already = me?.voice?.channelId === channel.id && existing && existing.state.status !== VoiceConnectionStatus.Destroyed;
  if (already) return { joined: false, channel };
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

async function playAudioInput(guild, vcId, input, label = 'audio') {
  if (!guild || !vcId) throw new Error('Choose a Greet Voice channel before testing playback.');
  const channel = guild.channels.cache.get(vcId) || await guild.channels.fetch(vcId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error('The configured Greet Voice channel was not found or is not a voice channel.');
  if (typeof input === 'string' && !fs.existsSync(input)) throw new Error(`${label} file is missing on disk. Upload it again from Greet Voice setup.`);

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
  if (!subscription) throw new Error('The bot could not subscribe its audio player to the voice connection.');

  const resource = createAudioResource(input, {
    inputType: StreamType.Arbitrary,
    silencePaddingFrames: 5
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { player.stop(true); } catch {}
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error(`${label} playback timed out after 3 minutes.`)), 180000);
    player.once(AudioPlayerStatus.Idle, () => setTimeout(() => finish(), 600)); // let the last frames drain
    player.once('error', err => finish(new Error(`Voice audio playback failed: ${err.message || err}`)));
    try { player.play(resource); } catch (e) { finish(e); }
  }).catch(err => {
    let dependency = '';
    try { dependency = generateDependencyReport(); } catch {}
    if (dependency) console.error('[AunXz] Voice dependency report:\n' + dependency);
    throw err;
  });
}

// ---- TTS voices -------------------------------------------------------------------
// Each preset = Google Translate accent/language (+ optional ffmpeg filter for a different timbre).
const TTS_VOICES = {
  us:    { label: 'US English',        description: 'Standard American voice',     lang: 'en',    host: 'https://translate.google.com' },
  uk:    { label: 'British English',   description: 'UK accent',                   lang: 'en-GB', host: 'https://translate.google.co.uk' },
  au:    { label: 'Australian English',description: 'Australian accent',           lang: 'en-AU', host: 'https://translate.google.com.au' },
  in:    { label: 'Indian English',    description: 'Indian accent',               lang: 'en-IN', host: 'https://translate.google.co.in' },
  slow:  { label: 'US English (slow)', description: 'Slower, clearer reading',     lang: 'en',    host: 'https://translate.google.com', slow: true },
  deep:  { label: 'Deep voice',        description: 'Lower pitch',                 lang: 'en',    host: 'https://translate.google.com', filter: 'asetrate=24000*0.78,aresample=48000,atempo=1.28' },
  high:  { label: 'High voice',        description: 'Higher pitch',                lang: 'en',    host: 'https://translate.google.com', filter: 'asetrate=24000*1.3,aresample=48000,atempo=0.77' },
  robot: { label: 'Robot',             description: 'Metallic robot effect',       lang: 'en',    host: 'https://translate.google.com', filter: 'asetrate=24000*0.92,aresample=48000,atempo=1.087,tremolo=f=45:d=0.7,aecho=0.8:0.88:12:0.5' },
  es:    { label: 'Spanish',           description: 'Español',                     lang: 'es',    host: 'https://translate.google.com' },
  fr:    { label: 'French',            description: 'Français',                    lang: 'fr',    host: 'https://translate.google.com' },
  de:    { label: 'German',            description: 'Deutsch',                     lang: 'de',    host: 'https://translate.google.com' },
  hi:    { label: 'Hindi',             description: 'हिन्दी',                        lang: 'hi',    host: 'https://translate.google.com' },
  ar:    { label: 'Arabic',            description: 'العربية',                       lang: 'ar',    host: 'https://translate.google.com' }
};
const TTS_MAX_CHARS = 1000;

function applyVoiceFilter(buffer, filter) {
  return new Promise(resolve => {
    try {
      const { spawn } = require('child_process');
      const bin = process.env.FFMPEG_PATH || 'ffmpeg';
      const ff = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-af', filter, '-f', 'mp3', 'pipe:1']);
      const out = []; let failed = false;
      ff.stdout.on('data', c => out.push(c));
      ff.on('error', () => { failed = true; resolve(buffer); });
      ff.on('close', code => { if (failed) return; const b = Buffer.concat(out); resolve(code === 0 && b.length ? b : buffer); });
      ff.stdin.on('error', () => {});
      ff.stdin.end(buffer);
    } catch { resolve(buffer); }
  });
}

// Builds the complete spoken audio. Google caps one request at ~200 chars, so long prompts are split
// on punctuation/spaces into several requests and joined — nothing is cut off any more.
async function buildTTSBuffer(prompt, voiceKey = 'us') {
  const text = String(prompt || 'Welcome!').replace(/\s+/g, ' ').trim().slice(0, TTS_MAX_CHARS) || 'Welcome!';
  const voice = TTS_VOICES[voiceKey] || TTS_VOICES.us;
  const parts = googleTTS.getAllAudioUrls(text, { lang: voice.lang, slow: !!voice.slow, host: voice.host, splitPunct: ',.?!;:\n' });
  const buffers = [];
  for (const part of parts) {
    const b = await binaryDownload(part.url, 'TTS audio');
    if (b.length) buffers.push(b);
  }
  if (!buffers.length) throw new Error('TTS returned an empty audio file.');
  let out = Buffer.concat(buffers);
  if (voice.filter) out = await applyVoiceFilter(out, voice.filter);
  return out;
}

async function playTTSInChannel(guild, vcId, prompt, voiceKey = 'us') {
  const buffer = await buildTTSBuffer(prompt, voiceKey);
  return playAudioInput(guild, vcId, Readable.from(buffer), 'TTS');
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

async function playGreetvoiceGreeting(guild, cfg) {
  if (!cfg?.vcId) throw new Error('Select a greeting voice channel in Greet Voice setup first.');
  if (cfg.mode === 'audio') {
    if (!cfg.audioPath) throw new Error('Audio mode is selected but no audio file is saved. Upload an audio greeting or set a TTS message.');
    return playAudioInput(guild, cfg.vcId, cfg.audioPath, 'Greet Voice audio');
  }
  if (cfg.ttsPrompt && String(cfg.ttsPrompt).trim()) return playTTSInChannel(guild, cfg.vcId, cfg.ttsPrompt, cfg.ttsVoice || 'us');
  if (cfg.audioPath) return playAudioInput(guild, cfg.vcId, cfg.audioPath, 'Greet Voice audio');
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
// Hides EVERY channel from the Greet Voice role except the chosen VC.
// Only that role's own overwrite is touched — @everyone and all other roles/members are never edited.
async function lockRoleToSingleChannel(guild, role, allowedChannelId) {
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles) && !me?.permissions.has(PermissionFlagsBits.Administrator)) {
    throw new Error('I need **Manage Roles** to configure the Greet Voice gate role.');
  }
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels) && !me.permissions.has(PermissionFlagsBits.Administrator)) {
    throw new Error('I need **Manage Channels** to change the gate role\'s channel permissions.');
  }
  if (role.id === guild.id) throw new Error('@everyone cannot be the Greet Voice role.');
  if (role.position >= me.roles.highest.position) {
    throw new Error(`I cannot manage **${role.name}** because it is equal to or higher than my highest role.`);
  }
  await guild.channels.fetch().catch(() => {});
  const report = { hidden: 0, alreadyHidden: 0, allowed: false, failed: [], adminBypass: role.permissions.has(PermissionFlagsBits.Administrator) };
  const reason = 'Greet Voice: gate role may only see the greeting VC';
  for (const [, channel] of guild.channels.cache) {
    if (!channel.permissionOverwrites || channel.isThread?.()) continue;
    const own = channel.permissionOverwrites.cache.get(role.id);
    try {
      if (channel.id === allowedChannelId) {
        const ok = own?.allow.has(PermissionFlagsBits.ViewChannel) && own?.allow.has(PermissionFlagsBits.Connect);
        if (!ok) await channel.permissionOverwrites.edit(role, { ViewChannel: true, Connect: true }, { reason });
        report.allowed = true;
        continue;
      }
      const canSee = channel.permissionsFor(role)?.has(PermissionFlagsBits.ViewChannel);
      const explicitAllow = own?.allow.has(PermissionFlagsBits.ViewChannel);
      const explicitDeny = own?.deny.has(PermissionFlagsBits.ViewChannel);
      if (explicitDeny && !explicitAllow) { report.alreadyHidden++; continue; }
      if (!canSee && !explicitAllow) { report.alreadyHidden++; continue; }
      await channel.permissionOverwrites.edit(role, { ViewChannel: false }, { reason });   // only ViewChannel, only this role
      report.hidden++;
    } catch (e) {
      report.failed.push(`${channel.name}: ${e.message}`);
    }
  }
  return report;
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
const greetCooldowns = new Map(); // `${guildId}:${userId}` -> timestamp
function logVoiceDependencies() { console.log('[GreetVoice] dependency report:\n' + generateDependencyReport()); }
async function onVoiceJoinGreetvoice(oldState, newState) {
  const guild = newState.guild;
  const cfg = db.getConfig(guild.id).greetvoice;
  if (newState.channelId === oldState.channelId) return;                 // mute/deafen/stream changes
  if (!cfg.vcId || newState.channelId !== cfg.vcId) return;              // not the greeting channel
  const member = newState.member;
  if (!member || member.user.bot) return;
  console.log(`[GreetVoice] join event: ${member.user.tag} -> ${newState.channelId}`);
  if (!cfg.enabled) { console.log('[GreetVoice] skipped: feature is disabled'); return; }
  const role = cfg.roleId ? guild.roles.cache.get(cfg.roleId) : null;
  if (cfg.roleId && (!role || !member.roles.cache.has(role.id))) { console.log('[GreetVoice] skipped: member does not hold the gate role'); return; }
  const cdKey = `${guild.id}:${member.id}`; const cdMs = Math.max(0, Number(cfg.cooldownSeconds ?? 30)) * 1000;
  if (Date.now() - (greetCooldowns.get(cdKey) || 0) < cdMs) { console.log('[GreetVoice] skipped: per-user cooldown'); return; }
  greetCooldowns.set(cdKey, Date.now());
  const live = await guild.members.fetch(member.id).catch(() => null);
  if (!live || live.voice.channelId !== cfg.vcId) { console.log('[GreetVoice] skipped: member left before the greeting'); return; }
  let played = false;
  try {
    console.log('[GreetVoice] playing greeting');
    await playGreetvoiceGreeting(guild, cfg);
    played = true;
    console.log('[GreetVoice] playback finished');
  } catch (e) {
    console.error('[GreetVoice] playback failed:', e);
    const log = await getLogChannel(guild, 'voice');
    if (log) {
      log.send({ embeds: [ui.errorEmbed('🔇 Greetvoice TTS Failed',
        `Could not play the greeting for ${member}: \`${String(e.message || e).slice(0, 700)}\`.\n` +
        'Check that the bot can **Connect** and **Speak** in the greeting VC and that FFmpeg + an Opus encoder are installed.')] }).catch(() => {});
    }
  }

  // Only release the gate after successful playback. If audio failed, keep the role so
  // the member can retry by leaving/rejoining the greeting VC instead of silently losing it.
  if (!played || !role) return;
  const freshMember = await guild.members.fetch(member.id).catch(() => null);
  if (freshMember && freshMember.voice.channelId === cfg.vcId) {
    await freshMember.voice.disconnect('greetvoice complete').catch(() => {});
  }
  await freshMember?.roles.remove(role, 'greetvoice complete').catch(() => {});
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
  joinAndStayInVC, ensureBotInVC, TTS_VOICES, buildTTSBuffer, playTTSInChannel, playAudioInput, playGreetvoiceGreeting, saveGreetvoiceAudio, removeGreetvoiceAudio,
  antinukeStrike, findAuditExecutor, getLogChannel,
  handleAntiraidJoin,
  handleAntiBotJoin, handleAntiAltJoin, handleAntiWebhookUpdate,
  handleAntilink,
  handleAntispam,
  lockRoleToSingleChannel, onChannelCreateGreetvoiceSync, onMemberJoinGreetvoice, onVoiceJoinGreetvoice,
  xpForLevel, handleLevelingMessage,
  handleVoicemasterJoin, handleVoiceStateUpdate, logVoiceDependencies,
  handleAutoresponder, handleAutoreactor,
  embedBuilderSessions
};
