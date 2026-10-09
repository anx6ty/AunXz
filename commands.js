// commands.js — every slash command: its SlashCommandBuilder definition + execute(interaction).
// Exported as a flat array so index.js can both register them with Discord and route
// interactionCreate to the right handler by command name.

const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const db = require('./database');
const ui = require('./ui');
const sys = require('./systems');
const templates = require('./template');
const statsetup = require('./statsetup');
const stickyMessages = require('./stickymessage');
const { randomBytes } = require('crypto');

const OWNER_IDS = (process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const MAIN_OWNER_ID = String(process.env.OWNER_ID || OWNER_IDS[0] || '').trim();
const isOwner = (id) => {
  if (!id) return false;
  if (String(id) === MAIN_OWNER_ID || OWNER_IDS.includes(String(id))) return true;
  try { return Boolean(db.getCoOwner(String(id))); } catch { return false; }
};

const pendingDangerousActions = new Map();

function askForConfirmation(interaction, { title, description, actionLabel, run }) {
  const token = randomBytes(8).toString('hex');
  const record = { userId: interaction.user.id, guildId: interaction.guildId, actionLabel, run, expiresAt: Date.now() + 90000 };
  pendingDangerousActions.set(token, record);
  setTimeout(() => pendingDangerousActions.delete(token), 90000).unref?.();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`danger-confirm:${token}:yes`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`danger-confirm:${token}:no`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );
  return interaction.reply({ embeds: [ui.warnEmbed(`⚠️ ${title}`, `${description}\n\nThis confirmation expires in 90 seconds.`)], components: [row], ephemeral: true });
}

async function handleDangerousConfirmation(interaction) {
  const parts = String(interaction.customId || '').split(':');
  const token = parts[1];
  const choice = parts[2];
  const pending = pendingDangerousActions.get(token);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingDangerousActions.delete(token);
    return interaction.update({ embeds: [ui.errorEmbed('Confirmation Expired', 'Run the command again to start a new confirmation.')], components: [] });
  }
  if (interaction.user.id !== pending.userId || interaction.guildId !== pending.guildId) {
    return interaction.reply({ embeds: [ui.errorEmbed('Not Your Confirmation', 'Only the person who started this action can confirm or cancel it.')], ephemeral: true });
  }
  pendingDangerousActions.delete(token);
  if (choice !== 'yes') return interaction.update({ embeds: [ui.infoEmbed('Action Cancelled', `Cancelled: **${pending.actionLabel}**. Nothing was changed.`)], components: [] });
  await interaction.deferUpdate();
  try {
    const result = await pending.run(interaction);
    const embed = result && typeof result.toJSON === 'function' ? result : ui.okEmbed('Action Complete', `**${pending.actionLabel}** completed.`);
    return interaction.editReply({ embeds: [embed], components: [] });
  } catch (error) {
    console.error(`Confirmed action failed (${pending.actionLabel}):`, error);
    return interaction.editReply({ embeds: [ui.errorEmbed('Action Failed', String(error?.message || error).slice(0, 1500))], components: [] });
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
  if (!attachment) return null;
  if (attachment.contentType && !attachment.contentType.startsWith('image/')) return null;
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
  if (!bot || !target) return null;
  if (target.id === interaction.guild.ownerId) return ui.errorEmbed('Action Blocked', `I cannot ${actionLabel} the server owner.`);
  if (target.id === interaction.client.user.id) return ui.errorEmbed('Action Blocked', `I cannot ${actionLabel} myself.`);
  if (target.roles?.highest?.position >= bot.roles.highest.position) return ui.errorEmbed('Role Hierarchy', `I cannot ${actionLabel} **${target.user.tag}** because their highest role is equal to or higher than my highest role.`);
  if (interaction.member.id !== interaction.guild.ownerId && target.roles?.highest?.position >= interaction.member.roles.highest.position) {
    return ui.errorEmbed('Role Hierarchy', `You cannot ${actionLabel} **${target.user.tag}** because their highest role is equal to or higher than your highest role.`);
  }
  return null;
}

function actionPreflight(interaction, target, permission, permissionLabel, actionLabel) {
  return actionPermissionError(interaction, permission, permissionLabel) || hierarchyError(interaction, target, actionLabel);
}

const commands = [];

// ---------------------------------------------------------------------------------
// /template — portable server templates.
// The command is explicitly enabled for Guild Install + User Install when the
// installed discord.js builder supports Discord's integration metadata. Runtime
// checks still enforce what each context can actually access.
// ---------------------------------------------------------------------------------
{
  const builder = new SlashCommandBuilder()
    .setName('template')
    .setDescription('Save or load a portable AunXz server template.')
    .addSubcommand(s => s
      .setName('save')
      .setDescription('Save this server as a portable template code.'))
    .addSubcommand(s => s
      .setName('load')
      .setDescription('Rebuild this server from a template code.')
      .addStringOption(o => o
        .setName('code')
        .setDescription('VX-TPL template code.')
        .setRequired(true)
        .setMaxLength(templates.MAX_CODE_LENGTH))
      .addBooleanOption(o => o
        .setName('confirm')
        .setDescription('Confirm that the current server layout may be replaced.')
        .setRequired(true)));

  // discord.js 14.25+ exposes these builders. The guards keep startup compatible
  // with older patched installs instead of crashing while commands.js loads.
  if (typeof builder.setIntegrationTypes === 'function') {
    // 0 = Guild Install, 1 = User Install
    builder.setIntegrationTypes(0, 1);
  }
  if (typeof builder.setContexts === 'function') {
    // 0 = Guild context
    builder.setContexts(0);
  }

  commands.push({
    data: builder,
    async execute(interaction) {
      const sub = interaction.options.getSubcommand();

      if (sub === 'save') {
        const guild = interaction.guild;
        if (!guild) {
          return interaction.reply({
            embeds: [ui.errorEmbed(
              'Server Only',
              '**/template save** must be used from a Discord server.'
            )],
            ephemeral: true
          });
        }

        // A user-installed app does not have a bot member in the guild and cannot
        // receive the complete guild structure needed for a faithful export.
        const bot = guild.members?.me || await guild.members.fetchMe().catch(() => null);
        if (!bot) {
          return interaction.reply({
            embeds: [ui.errorEmbed(
              'AunXz Bot Required',
              'The AunXz app can appear as a user-installed app, but **/template save** needs AunXz installed in this server as a bot so Discord provides the complete server structure. No Administrator permission is required for saving.'
            )],
            ephemeral: true
          });
        }

        try {
          const code = templates.encodeSnapshot(templates.createSnapshot(guild));
          return interaction.reply({
            embeds: [ui.okEmbed(
              '📦 Template Saved',
              'Your portable signed template is ready. Copy the code below and use **/template load** in another server where AunXz is installed as a bot.\n\n```\n' + code + '\n```'
            )],
            ephemeral: true
          });
        } catch (e) {
          return interaction.reply({
            embeds: [ui.errorEmbed('Template Save Failed', String(e.message || e))],
            ephemeral: true
          });
        }
      }

      if (!interaction.guild) {
        return interaction.reply({
          embeds: [ui.errorEmbed('Server Only', 'Use **/template load** inside a server where AunXz is installed as a bot.')],
          ephemeral: true
        });
      }

      if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
          embeds: [ui.errorEmbed('Administrator Required', 'Only an Administrator can load a complete server template.')],
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
          embeds: [ui.errorEmbed(
            'Confirmation Required',
            'Loading a template replaces current user-created channels and roles. Re-run **/template load** with **confirm: True** when ready.'
          )],
          ephemeral: true
        });
      }

      let snapshot;
      try {
        snapshot = templates.decodeSnapshot(interaction.options.getString('code', true));
      } catch (e) {
        return interaction.reply({
          embeds: [ui.errorEmbed('Invalid Template', String(e.message || e))],
          ephemeral: true
        });
      }

      await interaction.deferReply({ ephemeral: true });

      try {
        const result = await templates.loadSnapshot(interaction.guild, snapshot, async stage => {
          await interaction.editReply({
            embeds: [ui.base('🔄 Loading Server Template').setDescription('**' + stage + '**')]
          }).catch(() => {});
        });

        const warning = result.failed.length
          ? '\n\n**' + result.failed.length + ' item(s) failed:**\n' + result.failed.slice(0, 8).map(x => '• ' + x).join('\n')
          : '';

        return interaction.editReply({
          embeds: [ui.okEmbed(
            '✅ Template Loaded',
            'Created **' + result.channelsCreated + ' channels** and **' + result.rolesCreated + ' roles**.' + warning
          )]
        });
      } catch (e) {
        return interaction.editReply({
          embeds: [ui.errorEmbed('Template Load Failed', String(e.message || e))]
        });
      }
    }
  });
}


// ---------------------------------------------------------------------------------
// Restored utility / server intelligence commands
// ---------------------------------------------------------------------------------
commands.push({
  data: new SlashCommandBuilder().setName('serverinfo').setDescription('Show advanced information and statistics about this server.'),
  async execute(interaction) {
    const g = interaction.guild;
    const owner = await g.fetchOwner().catch(() => null);
    const channels = g.channels.cache;
    const roles = g.roles.cache.filter(r => r.id !== g.id);
    const bots = g.members.cache.filter(m => m.user.bot).size;
    const humans = Math.max(0, g.memberCount - bots);
    const text = channels.filter(c => c.type === ChannelType.GuildText).size;
    const voice = channels.filter(c => c.type === ChannelType.GuildVoice).size;
    const cats = channels.filter(c => c.type === ChannelType.GuildCategory).size;
    const boosts = g.premiumSubscriptionCount || 0;
    const e = ui.base(`🏠 ${g.name}`)
      .setThumbnail(g.iconURL({ dynamic: true }))
      .addFields(
        { name: '📊 Members', value: `**${g.memberCount.toLocaleString()}** total\n${humans.toLocaleString()} humans • ${bots.toLocaleString()} bots`, inline: true },
        { name: '💬 Channels', value: `**${channels.size}** total\n${text} text • ${voice} voice • ${cats} categories`, inline: true },
        { name: '🎭 Roles', value: `**${roles.size}** custom roles`, inline: true },
        { name: '🚀 Boosts', value: `**${boosts}** boosts\nLevel ${g.premiumTier}`, inline: true },
        { name: '👑 Owner', value: owner ? `${owner.user.tag}\n\`${owner.id}\`` : 'Unknown', inline: true },
        { name: '🆔 Server ID', value: `\`${g.id}\``, inline: true },
        { name: '📅 Created', value: `<t:${Math.floor(g.createdTimestamp/1000)}:F>`, inline: false }
      );
    await interaction.reply({ embeds: [e] });
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
    if (!invites) return interaction.reply({ embeds: [ui.errorEmbed('Invite Stats Unavailable', 'I could not read this server’s invites.')], ephemeral: true });
    const rows = invites.filter(i => !target || i.inviter?.id === target.id).sort((a,b) => (b.uses||0)-(a.uses||0)).first(10);
    const total = rows.reduce((n,i)=>n+(i.uses||0),0);
    const lines = rows.length ? rows.map((i,n)=>`${n+1}. ${i.inviter || 'Unknown'} — **${i.uses||0}** uses — \`${i.code}\``) : ['No invite data found.'];
    await interaction.reply({ embeds: [ui.base(`📨 ${target ? `${target.username}'s` : 'Server'} Invites`).setDescription(`**Tracked uses:** ${total}\n\n${lines.join('\n')}`)] });
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
    const roles = m ? m.roles.cache.filter(r=>r.id!==interaction.guild.id).map(r=>r.toString()).slice(-20).join(', ') || 'None' : 'Not cached';
    await interaction.reply({ embeds: [ui.base(`👤 ${user.tag}`)
      .setThumbnail(user.displayAvatarURL({dynamic:true}))
      .setDescription(`**ID:** \`${user.id}\`\n**Bot:** ${user.bot ? 'Yes' : 'No'}\n**Account:** <t:${Math.floor(user.createdTimestamp/1000)}:F>\n**Joined:** ${m?.joinedTimestamp ? `<t:${Math.floor(m.joinedTimestamp/1000)}:F>` : 'Unknown'}\n**Roles:** ${roles}`)] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('serverstats').setDescription('Show advanced live server statistics.'),
  async execute(interaction) {
    const g = interaction.guild;
    await g.members.fetch().catch(() => {});
    const members = g.members.cache;
    const online = members.filter(m => m.presence?.status && m.presence.status !== 'offline').size;
    const bots = members.filter(m => m.user.bot).size;
    const humans = members.size - bots;
    const voice = members.filter(m => m.voice?.channelId).size;
    const roleCounts = new Map();
    for (const m of members.values()) for (const r of m.roles.cache.values()) if (r.id !== g.id) roleCounts.set(r.id,(roleCounts.get(r.id)||0)+1);
    const topRoles = [...roleCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([id,n],i)=>`${i+1}. <@&${id}> — **${n}**`).join('\n') || 'No custom roles.';
    await interaction.reply({ embeds: [ui.base(`📊 ${g.name} — Advanced Stats`)
      .addFields(
        {name:'Members',value:`Total **${members.size}**\nHumans **${humans}**\nBots **${bots}**`,inline:true},
        {name:'Activity',value:`Online/active **${online}**\nIn voice **${voice}**`,inline:true},
        {name:'Server',value:`Channels **${g.channels.cache.size}**\nRoles **${g.roles.cache.size-1}**\nBoosts **${g.premiumSubscriptionCount||0}` ,inline:true},
        {name:'Most-used roles',value:topRoles,inline:false}
      )] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('leaderboards').setDescription('Show advanced server leaderboards.')
    .addStringOption(o=>o.setName('type').setDescription('Leaderboard type').setRequired(true)
      .addChoices({name:'XP',value:'xp'},{name:'Messages/XP',value:'messages'},{name:'Invites',value:'invites'})),
  async execute(interaction) {
    const type=interaction.options.getString('type');
    if(type==='xp'||type==='messages'){
      const rows=db.topLevels(interaction.guildId,15);
      const lines=rows.map((r,i)=>`${i+1}. <@${r.userId}> — **${r.xp.toLocaleString()} XP** • Level **${r.level}**`);
      return interaction.reply({embeds:[ui.base(`🏆 ${interaction.guild.name} — ${type==='xp'?'XP':'Activity'} Leaderboard`).setDescription(lines.join('\n')||'No leaderboard data yet.')]});
    }
    if(!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ManageGuild))
      return interaction.reply({embeds:[ui.errorEmbed('Missing Permission','I need Manage Server to read invite usage.')],ephemeral:true});
    const invites=await interaction.guild.invites.fetch().catch(()=>null);
    const byUser=new Map();
    for(const i of invites?.values()||[]) if(i.inviter) byUser.set(i.inviter.id,(byUser.get(i.inviter.id)||0)+(i.uses||0));
    const lines=[...byUser.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([id,n],i)=>`${i+1}. <@${id}> — **${n} invites**`);
    await interaction.reply({embeds:[ui.base(`🏆 ${interaction.guild.name} — Invite Leaderboard`).setDescription(lines.join('\n')||'No invite data yet.')]});
  }
});

// Giveaway creation opens a configuration embed immediately; the buttons finish publishing it.
commands.push({
  data: new SlashCommandBuilder().setName('giveaway').setDescription('Create and configure a giveaway.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s=>s.setName('create').setDescription('Create a giveaway configuration panel.')
      .addStringOption(o=>o.setName('prize').setDescription('Prize').setRequired(true))
      .addIntegerOption(o=>o.setName('winners').setDescription('Number of winners').setMinValue(1).setMaxValue(20))
      .addIntegerOption(o=>o.setName('duration_minutes').setDescription('Duration in minutes').setMinValue(1).setMaxValue(43200))
      .addChannelOption(o=>o.setName('channel').setDescription('Giveaway channel').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s=>s.setName('reroll').setDescription('Choose a new winner for an ended giveaway.')
      .addIntegerOption(o=>o.setName('giveaway_id').setDescription('The ID shown in the giveaway footer').setRequired(true).setMinValue(1))),
  async execute(interaction) {
    if(!interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild) && !interaction.member?.permissions?.has(PermissionFlagsBits.Administrator))
      return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Manage Server is required to manage giveaways.')],ephemeral:true});
    const sub = interaction.options.getSubcommand();
    if (sub === 'reroll') {
      const id = interaction.options.getInteger('giveaway_id');
      const giveaway = db.getGiveaway(interaction.guildId, id);
      if (!giveaway) return interaction.reply({embeds:[ui.errorEmbed('Giveaway Not Found', `No giveaway with ID **${id}** exists in this server.`)], ephemeral:true});
      if (giveaway.status !== 'ended') return interaction.reply({embeds:[ui.errorEmbed('Giveaway Not Ended', 'You can reroll only a giveaway that has already ended.')], ephemeral:true});
      let entrants = [];
      try { entrants = JSON.parse(giveaway.participants || '[]'); } catch (e) { console.error('[Giveaway] Invalid participant JSON:', e); }
      if (!Array.isArray(entrants) || entrants.length === 0) return interaction.reply({embeds:[ui.errorEmbed('No Entrants', 'This giveaway has no saved entrants, so a new winner cannot be selected.')], ephemeral:true});
      let previousWinners = [];
      try { previousWinners = JSON.parse(giveaway.winnerIds || '[]'); } catch {}
      if (!Array.isArray(previousWinners)) previousWinners = [];
      // Fetch entrants not already in cache, then exclude bots and all previous winners.
      await Promise.all(entrants.map(uid => interaction.guild.members.cache.has(uid) ? Promise.resolve() : interaction.guild.members.fetch(uid).catch(() => null)));
      const eligible = [...new Set(entrants)].filter(uid => !previousWinners.includes(uid)).filter(uid => {
        const m = interaction.guild.members.cache.get(uid);
        return Boolean(m && !m.user.bot);
      });
      if (!eligible.length) return interaction.reply({embeds:[ui.errorEmbed('No Eligible Entrants', 'Every saved entrant has already won, left the server, or is a bot. No changes were made.')],ephemeral:true});
      for (let i = eligible.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [eligible[i], eligible[j]] = [eligible[j], eligible[i]]; }
      const winners = eligible.slice(0, Math.min(Number(giveaway.winners) || 1, eligible.length));
      const channel = interaction.guild.channels.cache.get(giveaway.channelId) || await interaction.guild.channels.fetch(giveaway.channelId).catch(() => null);
      if (!channel?.isTextBased?.()) return interaction.reply({embeds:[ui.errorEmbed('Channel Unavailable', 'The giveaway channel was deleted or is no longer accessible. The database record was kept; check the channel ID and bot permissions.')],ephemeral:true});
      const me = interaction.guild.members.me;
      const perms = channel.permissionsFor(me);
      if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages) || !perms?.has(PermissionFlagsBits.EmbedLinks))
        return interaction.reply({embeds:[ui.errorEmbed('Missing Bot Permissions', `I need **View Channel**, **Send Messages**, and **Embed Links** in ${channel} to announce the reroll.`)],ephemeral:true});
      const nextWinners = [...new Set([...previousWinners, ...winners])];
      const saved = db.updateGiveaway(interaction.guildId, id, { winnerIds: JSON.stringify(nextWinners) });
      if (!saved) return interaction.reply({embeds:[ui.errorEmbed('Save Failed', 'A new winner was selected, but the database record could not be updated. No announcement was sent.')],ephemeral:true});
      try {
        await channel.send({embeds:[ui.base('🎉 Giveaway Rerolled').setDescription(`**Prize:** ${giveaway.prize}\n**New winner(s):** ${winners.map(uid => `<@${uid}>`).join(', ')}\n**Giveaway ID:** \`${id}\``).setFooter({text:`Rerolled by ${interaction.user.tag}`})]});
      } catch (err) {
        // Roll back winner history if Discord rejected the announcement, avoiding false success.
        db.updateGiveaway(interaction.guildId, id, { winnerIds: JSON.stringify(previousWinners) });
        console.error('[Giveaway] Reroll announcement failed:', err);
        return interaction.reply({embeds:[ui.errorEmbed('Announcement Failed', `Discord did not accept the winner announcement (${String(err?.message || err).slice(0,300)}). The saved winner history was rolled back.`)],ephemeral:true});
      }
      return interaction.reply({embeds:[ui.okEmbed('Giveaway Rerolled', `New winner(s): ${winners.map(uid => `<@${uid}>`).join(', ')}\nAnnounced in ${channel}.`)],ephemeral:true});
    }
    const prize=interaction.options.getString('prize');
    const winners=interaction.options.getInteger('winners')||1;
    const duration=(interaction.options.getInteger('duration_minutes')||1440)*60000;
    const channel=interaction.options.getChannel('channel')||interaction.channel;
    const g=db.createGiveaway(interaction.guildId,interaction.user.id,{prize,winners,durationMs:duration,endsAt:Date.now()+duration,channelId:channel.id});
    const row=new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`giveaway_publish:${g.id}`).setLabel('Publish Giveaway').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`giveaway_cancel:${g.id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger)
    );
    await interaction.reply({embeds:[ui.base('🎉 Giveaway Configuration')
      .setDescription(`Configure and publish this giveaway.\n\n**Prize:** ${prize}\n**Winners:** ${winners}\n**Duration:** <t:${Math.floor(g.endsAt/1000)}:R>\n**Channel:** ${channel}`)
      .setFooter({text:`Giveaway #${g.id} • Hosted by ${interaction.user.tag}`})],components:[row],ephemeral:true});
  }
});

// /stickymessage — author-bound panel for one sticky embed per text channel.
commands.push({
  data: new SlashCommandBuilder().setName('stickymessage').setDescription('Create and manage persistent sticky embed messages.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageChannels),
  async execute(interaction) { return stickyMessages.command(interaction); }
});

// /statsetup — live social/server counter channels (prefix-compatible through the shared command adapter).
commands.push({
  data: new SlashCommandBuilder().setName('statsetup').setDescription('Create and manage live statistic voice channels.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageGuild)
    .addStringOption(o=>o.setName('action').setDescription('Open setup or manage existing stat channels')
      .addChoices({name:'setup',value:'setup'},{name:'list / manage',value:'list'})),
  async execute(interaction) { return statsetup.command(interaction); }
});

// ---------------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------------
commands.push({
  data: new SlashCommandBuilder().setName('help').setDescription('Browse everything the bot can do.'),
  async execute(interaction) {
    await interaction.reply({ embeds: [ui.helpHomeEmbed(interaction.client)], components: [ui.helpSelectRow()] });
  }
});

// ---------------------------------------------------------------------------------
// Setup commands — every configurable feature follows /<feature> setup.
// ---------------------------------------------------------------------------------
const GENERIC_MODULES = [
  'welcome', 'leave', 'boost', 'starboard', 'inviteTracker',
  'suggestions', 'polls', 'snipeEnabled', 'nsfwFilter', 'birthdays'
];
const ALL_MODULE_NAMES = [
  'antinuke', 'antilink', 'antispam', 'antiraid', 'antiwebhook', 'antibot', 'antialt', 'voicemaster', 'greetvoice', 'greetmessage',
  'leveling', 'tickets', 'logs', 'statsetup', 'stickymessage', ...GENERIC_MODULES
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
  } else if (sub === 'antilink') {
    o.mode = interaction.options.getString('mode');
    const r = interaction.options.getRole('bypass_role'); o.bypass_role_id = r ? r.id : null;
  } else if (sub === 'antispam') {
    o.max_messages = interaction.options.getInteger('max_messages');
    o.window_seconds = interaction.options.getInteger('window_seconds');
    o.punishment = interaction.options.getString('punishment');
  } else if (sub === 'antiraid') {
    o.join_threshold = interaction.options.getInteger('join_threshold');
    o.window_seconds = interaction.options.getInteger('window_seconds');
    o.min_account_age_days = interaction.options.getInteger('min_account_age_days');
    o.action = interaction.options.getString('action');
  } else if (sub === 'antiwebhook') {
    o.action = interaction.options.getString('action'); const r = interaction.options.getRole('bypass_role'); o.bypass_role_id = r ? r.id : null; const c = interaction.options.getChannel('log_channel'); o.log_channel_id = c ? c.id : null;
  } else if (sub === 'antibot') {
    o.action = interaction.options.getString('action'); const r = interaction.options.getRole('bypass_role'); o.bypass_role_id = r ? r.id : null; const c = interaction.options.getChannel('log_channel'); o.log_channel_id = c ? c.id : null;
  } else if (sub === 'antialt') {
    o.action = interaction.options.getString('action'); o.min_account_age_days = interaction.options.getInteger('min_account_age_days'); const c = interaction.options.getChannel('log_channel'); o.log_channel_id = c ? c.id : null;
  } else if (sub === 'voicemaster') {
    const h = interaction.options.getChannel('hub_channel'); o.hub_channel_id = h ? h.id : null;
    const c = interaction.options.getChannel('category'); o.category_id = c ? c.id : null;
  } else if (sub === 'greetmessage') {
    const c = interaction.options.getChannel('channel'); o.channel_id = c ? c.id : null;
    o.message = interaction.options.getString('message');
    o.image = interaction.options.getString('image');
    const imageFile = getImageAttachment(interaction, 'image_file');
    o.image_file = imageFile ? imageFile.url : null;
  } else if (sub === 'leveling') {
    const c = interaction.options.getChannel('channel'); o.channel_id = c ? c.id : null;
    o.xp_per_message = interaction.options.getInteger('xp_per_message');
    o.cooldown_seconds = interaction.options.getInteger('cooldown_seconds');
    o.reward_level = interaction.options.getInteger('reward_level');
    const r = interaction.options.getRole('reward_role'); o.reward_role_id = r ? r.id : null;
  } else if (sub === 'tickets') {
    const c = interaction.options.getChannel('category'); o.category_id = c ? c.id : null;
    const r = interaction.options.getRole('support_role'); o.support_role_id = r ? r.id : null;
    const l = interaction.options.getChannel('log_channel'); o.log_channel_id = l ? l.id : null;
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
    if (state) patch.antinuke.enabled = state === 'enable';
    if (o.punishment) patch.antinuke.punishment = o.punishment;
    if (o.threshold) Object.assign(patch.antinuke, {
      maxChannelDeletes: o.threshold, maxChannelCreates: o.threshold, maxRoleDeletes: o.threshold,
      maxRoleCreates: o.threshold, maxBans: o.threshold, maxKicks: o.threshold,
      maxWebhookCreates: o.threshold, maxRoleUpdates: o.threshold
    });
    if (o.window_seconds) patch.antinuke.windowSeconds = o.window_seconds;
  } else if (sub === 'antilink') {
    patch.antilink = {};
    if (state) patch.antilink.enabled = state === 'enable';
    if (o.mode) patch.antilink.mode = o.mode;
    if (o.bypass_role_id) patch.antilink.bypassRoleId = o.bypass_role_id;
  } else if (sub === 'antispam') {
    patch.antispam = {};
    if (state) patch.antispam.enabled = state === 'enable';
    if (o.max_messages) patch.antispam.maxMessages = o.max_messages;
    if (o.window_seconds) patch.antispam.windowSeconds = o.window_seconds;
    if (o.punishment) patch.antispam.punishment = o.punishment;
  } else if (sub === 'antiraid') {
    patch.antiraid = {};
    if (state) patch.antiraid.enabled = state === 'enable';
    if (o.join_threshold) patch.antiraid.joinThreshold = o.join_threshold;
    if (o.window_seconds) patch.antiraid.windowSeconds = o.window_seconds;
    if (o.min_account_age_days !== null && o.min_account_age_days !== undefined) patch.antiraid.minAccountAgeDays = o.min_account_age_days;
    if (o.action) patch.antiraid.action = o.action;
  } else if (sub === 'antiwebhook') {
    patch.antiwebhook = {}; if (state) patch.antiwebhook.enabled = state === 'enable'; if (o.action) patch.antiwebhook.action = o.action; if (o.bypass_role_id) patch.antiwebhook.bypassRoleId = o.bypass_role_id; if (o.log_channel_id) patch.antiwebhook.logChannelId = o.log_channel_id;
  } else if (sub === 'antibot') {
    patch.antibot = {}; if (state) patch.antibot.enabled = state === 'enable'; if (o.action) patch.antibot.action = o.action; if (o.bypass_role_id) patch.antibot.bypassRoleId = o.bypass_role_id; if (o.log_channel_id) patch.antibot.logChannelId = o.log_channel_id;
  } else if (sub === 'antialt') {
    patch.antialt = {}; if (state) patch.antialt.enabled = state === 'enable'; if (o.action) patch.antialt.action = o.action; if (o.min_account_age_days !== null && o.min_account_age_days !== undefined) patch.antialt.minAccountAgeDays = o.min_account_age_days; if (o.log_channel_id) patch.antialt.logChannelId = o.log_channel_id;
  } else if (sub === 'voicemaster') {
    patch.voicemaster = {};
    if (state) patch.voicemaster.enabled = state === 'enable';
    if (o.hub_channel_id) patch.voicemaster.hubChannelId = o.hub_channel_id;
    if (o.category_id) patch.voicemaster.categoryId = o.category_id;
  } else if (sub === 'greetmessage') {
    patch.greetmessage = {};
    if (state) patch.greetmessage.enabled = state === 'enable';
    if (o.channel_id) patch.greetmessage.channelId = o.channel_id;
    if (o.message) patch.greetmessage.message = o.message;
    if (o.image_file) patch.greetmessage.image = o.image_file;
    else if (o.image) patch.greetmessage.image = o.image;
  } else if (sub === 'leveling') {
    patch.leveling = {};
    if (state) patch.leveling.enabled = state === 'enable';
    if (o.channel_id) patch.leveling.channel = o.channel_id;
    if (o.xp_per_message) patch.leveling.xpPerMessage = o.xp_per_message;
    if (o.cooldown_seconds) patch.leveling.cooldownSeconds = o.cooldown_seconds;
    if (o.reward_level && o.reward_role_id) {
      const current = db.getConfig(guildId).leveling.roleRewards;
      patch.leveling.roleRewards = { ...current, [String(o.reward_level)]: o.reward_role_id };
    }
  } else if (sub === 'tickets') {
    patch.ticket = {};
    if (state) patch.ticket.enabled = state === 'enable';
    if (o.category_id) patch.ticket.categoryId = o.category_id;
    if (o.support_role_id) patch.ticket.supportRoleId = o.support_role_id;
    if (o.log_channel_id) patch.ticket.logChannelId = o.log_channel_id;
    if (o.panel_title) patch.ticket.panelTitle = o.panel_title;
    if (o.panel_description) patch.ticket.panelDescription = o.panel_description;
    if (o.panel_thumbnail_file) patch.ticket.panelThumbnail = o.panel_thumbnail_file;
    else if (o.panel_thumbnail) patch.ticket.panelThumbnail = o.panel_thumbnail;
    if (o.panel_image_file) patch.ticket.panelImage = o.panel_image_file;
    else if (o.panel_image) patch.ticket.panelImage = o.panel_image;
    if (o.category_label) patch.ticket.categoryLabel = o.category_label;
    if (o.welcome_message) patch.ticket.welcomeMessage = o.welcome_message;
    if (o.welcome_thumbnail_file) patch.ticket.welcomeThumbnail = o.welcome_thumbnail_file;
    else if (o.welcome_thumbnail) patch.ticket.welcomeThumbnail = o.welcome_thumbnail;
    if (o.welcome_image_file) patch.ticket.welcomeImage = o.welcome_image_file;
    else if (o.welcome_image) patch.ticket.welcomeImage = o.welcome_image;
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
      if (!requireAdmin(interaction)) return;
      const guildId = interaction.guildId;
      const sub = interaction.options.getSubcommand();
      if (sub !== 'setup') return;
      const o = extractModuleOptions(name, interaction);
      const patch = buildModulePatch(name, guildId, o);
      const cfg = db.saveConfig(guildId, patch);
      if (name === 'voicemaster') {
        return interaction.reply({ embeds: [ui.vmSetupEmbed(cfg)], components: [ui.vmSetupRow(cfg)] });
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
    if (!requireAdmin(interaction)) return;
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
  .addChannelOption(o => o.setName('category').setDescription('category for new temporary channels').addChannelTypes(ChannelType.GuildCategory))));

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
    if (!requireAdmin(interaction)) return;
    const cfg = db.getConfig(interaction.guildId).logs;
    await interaction.reply({ embeds: [ui.logSetupEmbed(cfg)], components: ui.logSetupRows(cfg), ephemeral: true });
  }
});


// /autorole — direct command, not a setup command.
commands.push({
  data: new SlashCommandBuilder().setName('autorole').setDescription('Set the automatic role for bots or humans.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('target').setDescription('Who should receive the role?').setRequired(true)
      .addChoices({name:'Humans',value:'humans'},{name:'Bots',value:'bots'},{name:'Everyone',value:'everyone'}))
    .addRoleOption(o => o.setName('role').setDescription('Role to assign automatically').setRequired(true)),
  async execute(interaction) {
    if (!requireAdmin(interaction)) return;
    const target = interaction.options.getString('target');
    const role = interaction.options.getRole('role');
    const next = db.saveConfig(interaction.guildId, { autorole: { enabled: true, target, roleId: role.id } }).autorole;
    await interaction.reply({ embeds: [ui.okEmbed('Autorole Updated', `**Target:** ${target}\n**Role:** ${role}`)] });
  }
});

// /automod setup — one setup command that opens the full customization panel.
commands.push({
  data: new SlashCommandBuilder().setName('automod').setDescription('Open the fully customizable AutoMod setup panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Open AutoMod configuration.')),
  async execute(interaction) {
    if (!requireAdmin(interaction)) return;
    const cfg = db.getConfig(interaction.guildId).automod;
    await interaction.reply({ embeds: [ui.automodSetupEmbed(cfg)], components: ui.automodSetupRows(cfg), ephemeral: true });
  }
});

// /reactionrolesetup — one panel for channel, message and fully editable reaction-role mappings.
commands.push({
  data: new SlashCommandBuilder().setName('reactionrolesetup').setDescription('Open the multi-panel reaction-role manager.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction) {
    if (!requireAdmin(interaction)) return;
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
      if (!requireAdmin(interaction)) return;
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

// ---------------------------------------------------------------------------------
// Fully configurable newer systems
// ---------------------------------------------------------------------------------
function parseButtonRoles(text) {
  return String(text || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 20).map((entry, i) => {
    const [rawRole, ...labelParts] = entry.split('=');
    const roleId = rawRole.replace(/[<@&>]/g, '').trim();
    const label = (labelParts.join('=') || `Role ${i+1}`).trim().slice(0, 80);
    return { roleId, label, mode: 'toggle' };
  }).filter(x => /^\d{15,25}$/.test(x.roleId));
}

commands.push({
  data: new SlashCommandBuilder().setName('buttonrolesetup').setDescription('Open the multi-panel button-role manager.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction) {
    if (!requireAdmin(interaction)) return;
    const cfg = db.getConfig(interaction.guildId);
    await interaction.reply({ embeds: [ui.buttonRoleEmbed(cfg)], components: ui.buttonRoleSetupRows(cfg), ephemeral: true });
  }
});

commands.push({
  data:new SlashCommandBuilder().setName('staffapplicationssetup').setDescription('Configure DM staff applications and publish an Apply panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o=>o.setName('panel_channel').setDescription('Apply panel channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o=>o.setName('log_channel').setDescription('Application results/log channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
    .addStringOption(o=>o.setName('questions').setDescription('Questions separated by |').setRequired(true))
    .addStringOption(o=>o.setName('title').setDescription('Panel title'))
    .addStringOption(o=>o.setName('description').setDescription('Panel description'))
    .addStringOption(o=>o.setName('dm_intro').setDescription('Ready message sent in DM')),
  async execute(interaction){
    if(!requireAdmin(interaction))return;
    const questions=interaction.options.getString('questions').split('|').map(x=>x.trim()).filter(Boolean).slice(0,25);
    if(!questions.length)return interaction.reply({embeds:[ui.errorEmbed('No questions','Separate questions with `|`.')],ephemeral:true});
    const cfg=db.saveConfig(interaction.guildId,{staffApplications:{enabled:true,panelChannelId:interaction.options.getChannel('panel_channel').id,logChannelId:interaction.options.getChannel('log_channel').id,questions,title:interaction.options.getString('title')||'Staff Applications',description:interaction.options.getString('description')||'Click Apply to start your application.',dmIntro:interaction.options.getString('dm_intro')||'Are you ready to start your staff application?'}});
    const ch=interaction.options.getChannel('panel_channel');
    await ch.send({embeds:[ui.base(cfg.staffApplications.title).setDescription(cfg.staffApplications.description)],components:[new (require('discord.js').ActionRowBuilder)().addComponents(new (require('discord.js').ButtonBuilder)().setCustomId('staffapp_apply').setLabel('Apply').setStyle(require('discord.js').ButtonStyle.Success))]});
    await interaction.reply({embeds:[ui.staffApplicationEmbed(cfg.staffApplications),ui.okEmbed('Panel Published',`Application panel posted in ${ch}.`)],ephemeral:true});
  }
});

commands.push({
  data:new SlashCommandBuilder().setName('birthdaysetup').setDescription('Open the easy Birthday setup panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction){
    if(!requireAdmin(interaction))return;
    const cfg=db.getConfig(interaction.guildId).birthdays;
    await interaction.reply({embeds:[ui.birthdaySetupEmbed(cfg)],components:ui.birthdaySetupRow(cfg),ephemeral:true});
  }
});

commands.push({
  data:new SlashCommandBuilder().setName('antibadwordsetup').setDescription('Open the multilingual Anti Bad Word setup panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction){
    if(!requireAdmin(interaction))return;
    const cfg=db.getConfig(interaction.guildId).antibadword;
    await interaction.reply({embeds:[ui.antiBadwordSetupEmbed(cfg)],components:ui.antiBadwordSetupRow(cfg),ephemeral:true});
  }
});

commands.push({
  data:new SlashCommandBuilder().setName('honeypotsetup').setDescription('Open the easy Honeypot setup panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction){
    if(!requireAdmin(interaction))return;
    const cfg=db.getConfig(interaction.guildId).honeypot;
    await interaction.reply({embeds:[ui.honeypotSetupEmbed(cfg)],components:ui.honeypotSetupRow(cfg),ephemeral:true});
  }
});


commands.push({
  data:new SlashCommandBuilder().setName('greetvoicesetup').setDescription('Open the easy Greet Voice setup panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction){
    if(!requireAdmin(interaction))return;
    const cfg=db.getConfig(interaction.guildId).greetvoice;
    await interaction.reply({embeds:[ui.greetVoiceSetupEmbed(cfg)],components:ui.greetVoiceSetupRow(cfg),ephemeral:true});
  }
});

commands.push({
  data:new SlashCommandBuilder().setName('autorespondersetup').setDescription('Open the easy Auto Responder setup panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction){
    if(!requireAdmin(interaction))return;
    const cfg=db.getConfig(interaction.guildId).autoresponder;
    await interaction.reply({embeds:[ui.autoresponderSetupEmbed(cfg)],components:ui.autoresponderSetupRow(cfg),ephemeral:true});
  }
});

commands.push({
  data:new SlashCommandBuilder().setName('autoreactorsetup').setDescription('Open the easy Auto Reactor setup panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction){
    if(!requireAdmin(interaction))return;
    const cfg=db.getConfig(interaction.guildId).autoreactor;
    await interaction.reply({embeds:[ui.autoreactorSetupEmbed(cfg)],components:ui.autoreactorSetupRow(cfg),ephemeral:true});
  }
});

commands.push({
  data:new SlashCommandBuilder().setName('embedbuilder').setDescription('Build a custom embed with buttons and post it to a channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction){
    if(!requireAdmin(interaction))return;
    sys.embedBuilderSessions.set(interaction.user.id, { title:'', description:'', color:'', imageUrl:'', thumbnailUrl:'', footer:'', buttons: [] });
    const draft = sys.embedBuilderSessions.get(interaction.user.id);
    await interaction.reply({embeds:[ui.embedBuilderPreviewEmbed(draft)],components:ui.embedBuilderRow(draft),ephemeral:true});
  }
});

// ---------------------------------------------------------------------------------
// /whitelist — antinuke exemptions
// ---------------------------------------------------------------------------------
commands.push({
  data: new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('Manage antinuke-exempt users.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('add').setDescription('exempt a user').addUserOption(o => o.setName('user').setDescription('user').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('remove exemption').addUserOption(o => o.setName('user').setDescription('user').setRequired(true))),
  async execute(interaction) {
    if (!requireAdmin(interaction)) return;
    const sub = interaction.options.getSubcommand();
    const user = interaction.options.getUser('user');
    if (sub === 'add') { db.addToWhitelist(interaction.guildId, user.id); return interaction.reply({ embeds: [ui.okEmbed('✅ Whitelisted', `${user} is now exempt from antinuke.`)] }); }
    db.removeFromWhitelist(interaction.guildId, user.id);
    return interaction.reply({ embeds: [ui.okEmbed('✅ Removed', `${user} is no longer exempt.`)] });
  }
});

// ---------------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------------
function modLog(interaction, embed) {
  sys.getLogChannel(interaction.guild, 'mod').then(ch => ch?.send({ embeds: [embed] }).catch(() => {}));
}

commands.push({
  data: new SlashCommandBuilder().setName('ban').setDescription('Ban a member after confirmation.')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason')),
  async execute(interaction) {
    const user = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    if (user.id === interaction.guild.ownerId) return interaction.reply({ embeds: [ui.errorEmbed('Action Blocked', 'The server owner cannot be banned.')], ephemeral: true });
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    const preflight = actionPreflight(interaction, member, PermissionFlagsBits.BanMembers, 'Ban Members', 'ban');
    if (preflight) return interaction.reply({ embeds: [preflight], ephemeral: true });
    const bot = botMember(interaction);
    if (!bot?.permissions?.has(PermissionFlagsBits.BanMembers) && !bot?.permissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ embeds: [ui.errorEmbed('Bot Missing Permissions', 'I need **Ban Members** permission to ban members.')], ephemeral: true });
    }
    if (member && !member.bannable) return interaction.reply({ embeds: [ui.errorEmbed('Cannot Ban Member', `Discord does not allow me to ban **${user.tag}**. Check my highest role and the target's role.`)], ephemeral: true });

    return askForConfirmation(interaction, {
      title: 'Confirm Ban',
      description: `Ban **${user.tag}** (\`${user.id}\`)?\n**Reason:** ${reason}`,
      actionLabel: `ban ${user.tag}`,
      run: async confirmed => {
        if (user.id === confirmed.guild.ownerId) return ui.errorEmbed('Action Blocked', 'The server owner cannot be banned.');
        const freshMember = await confirmed.guild.members.fetch(user.id).catch(() => null);
        const check = actionPreflight(confirmed, freshMember, PermissionFlagsBits.BanMembers, 'Ban Members', 'ban');
        if (check) return check;
        const freshBot = botMember(confirmed);
        if (!freshBot?.permissions?.has(PermissionFlagsBits.BanMembers) && !freshBot?.permissions?.has(PermissionFlagsBits.Administrator)) return ui.errorEmbed('Bot Missing Permissions', 'I need **Ban Members** permission to ban members.');
        if (freshMember && !freshMember.bannable) return ui.errorEmbed('Cannot Ban Member', `Discord does not allow me to ban **${user.tag}**. Check my highest role and the target's role.`);
        try { await confirmed.guild.bans.create(user.id, { reason: `${reason} | Requested by ${confirmed.user.tag}`.slice(0, 512) }); }
        catch (e) { const detail = e.code === 50013 ? 'I do not have permission, or my role is not high enough.' : (e.message || 'Unknown error'); return ui.errorEmbed('Ban Failed', `Discord rejected the ban. **${e.code || 'Unknown error'}** — ${detail}`); }
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
    if (!member) return interaction.reply({ embeds: [ui.errorEmbed('Member Not Found', 'That user is not currently a member of this server.')], ephemeral: true });
    const preflight = actionPreflight(interaction, member, PermissionFlagsBits.KickMembers, 'Kick Members', 'kick');
    if (preflight) return interaction.reply({ embeds: [preflight], ephemeral: true });
    if (!member.kickable) return interaction.reply({ embeds: [ui.errorEmbed('Cannot Kick Member', `Discord does not allow me to kick **${user.tag}**. Check my highest role and the target's role.`)], ephemeral: true });

    return askForConfirmation(interaction, {
      title: 'Confirm Kick',
      description: `Kick **${user.tag}** (\`${user.id}\`)?\n**Reason:** ${reason}`,
      actionLabel: `kick ${user.tag}`,
      run: async confirmed => {
        const freshMember = await confirmed.guild.members.fetch(user.id).catch(() => null);
        if (!freshMember) return ui.errorEmbed('Member Not Found', 'That user is no longer in this server.');
        const check = actionPreflight(confirmed, freshMember, PermissionFlagsBits.KickMembers, 'Kick Members', 'kick');
        if (check) return check;
        if (!freshMember.kickable) return ui.errorEmbed('Cannot Kick Member', `Discord does not allow me to kick **${user.tag}**. Check my highest role and the target's role.`);
        try { await freshMember.kick(reason); }
        catch (e) { return ui.errorEmbed('Kick Failed', `Discord rejected the kick. **${e.code || 'Unknown error'}** — ${e.message || 'Unknown error'}`); }
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
    if (preflight) return interaction.reply({ embeds: [preflight], ephemeral: true });
    try {
      await member.timeout(minutes * 60_000, reason);
    } catch (e) {
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
    if (preflight) return interaction.reply({ embeds: [preflight], ephemeral: true });
    try { await member.timeout(null); }
    catch (e) { return interaction.reply({ embeds: [ui.errorEmbed('Timeout Removal Failed', `Discord rejected the action. **${e.code || 'Unknown error'}** — ${e.message || 'unknown error'}`)], ephemeral: true }); }
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
    const desc = warns.length ? warns.map((w, i) => `**${i + 1}.** ${w.reason} — <@${w.moderatorId}> <t:${Math.floor(w.timestamp / 1000)}:R>`).join('\n') : 'No warnings.';
    await interaction.reply({ embeds: [ui.base(`⚠️ Warnings — ${user.tag}`).setDescription(desc)] });
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
    if (permissionError) return interaction.reply({ embeds: [permissionError], ephemeral: true });
    if (!interaction.channel?.isTextBased?.() || !interaction.channel.messages?.fetch || !interaction.channel.bulkDelete) {
      return interaction.reply({ embeds: [ui.errorEmbed('Unsupported Channel', 'Purge works in regular text channels and threads that support bulk deletion.')], ephemeral: true });
    }
    return askForConfirmation(interaction, {
      title: 'Confirm Purge',
      description: `Delete up to **${amount}** recent messages${user ? ` from ${user}` : ''} in ${interaction.channel}? Messages older than 14 days cannot be bulk-deleted.`,
      actionLabel: `purge ${amount} messages`,
      run: async confirmed => {
        const check = actionPermissionError(confirmed, PermissionFlagsBits.ManageMessages, 'Manage Messages');
        if (check) return check;
        const channel = confirmed.channel;
        const messages = await channel.messages.fetch({ limit: amount });
        const filtered = user ? messages.filter(m => m.author.id === user.id) : messages;
        if (!filtered.size) return ui.warnEmbed('Nothing To Purge', 'No matching recent messages were found.');
        let deleted;
        try { deleted = await channel.bulkDelete(filtered, true); }
        catch (e) { return ui.errorEmbed('Purge Failed', `Discord rejected the deletion. **${e.code || 'Unknown error'}** — ${e.message || 'Unknown error'}`); }
        return ui.okEmbed('🧹 Messages Purged', `Successfully deleted **${deleted.size}** message(s)${user ? ` from ${user}` : ''}.`);
      }
    });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('lock').setDescription('Lock the current channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  async execute(interaction) {
    try { await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false }); } catch (e) { return interaction.reply({ embeds:[ui.errorEmbed('Lock Failed', `Discord rejected the action. **${e.code || 'Unknown error'}** — ${e.message || 'unknown error'}`)], ephemeral:true }); }
    await interaction.reply({ embeds: [ui.warnEmbed('🔒 Channel Locked', `${interaction.channel} has been locked.`)] });
  }
});
commands.push({
  data: new SlashCommandBuilder().setName('unlock').setDescription('Unlock the current channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  async execute(interaction) {
    try { await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: null }); } catch (e) { return interaction.reply({ embeds:[ui.errorEmbed('Unlock Failed', `Discord rejected the action. **${e.code || 'Unknown error'}** — ${e.message || 'unknown error'}`)], ephemeral:true }); }
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
    if (perm) return interaction.reply({ embeds: [perm], ephemeral: true });
    const bot = botMember(interaction);
    if (role.position >= bot.roles.highest.position) return interaction.reply({ embeds: [ui.errorEmbed('Role Hierarchy', `I cannot ${sub} **${role.name}** because that role is equal to or higher than my highest role.`)], ephemeral: true });
    if (interaction.member.id !== interaction.guild.ownerId && role.position >= interaction.member.roles.highest.position) return interaction.reply({ embeds: [ui.errorEmbed('Role Hierarchy', `You cannot ${sub} **${role.name}** because it is equal to or higher than your highest role.`)], ephemeral: true });
    const targetCheck = hierarchyError(interaction, member, sub === 'add' ? 'add roles to' : 'remove roles from');
    if (targetCheck) return interaction.reply({ embeds: [targetCheck], ephemeral: true });
    try { if (sub === 'add') await member.roles.add(role); else await member.roles.remove(role); }
    catch (e) { return interaction.reply({ embeds: [ui.errorEmbed('Role Action Failed', `Discord rejected the action. **${e.code || 'Unknown error'}** — ${e.message || 'unknown error'}`)], ephemeral: true }); }
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
    if (targetCheck) return interaction.reply({ embeds:[targetCheck], ephemeral:true });
    try { await member.setNickname(nickname); } catch (e) { return interaction.reply({ embeds:[ui.errorEmbed('Nickname Update Failed', `Discord rejected the action. **${e.code || 'Unknown error'}** — ${e.message || 'unknown error'}`)], ephemeral:true }); }
    await interaction.reply({ embeds: [ui.okEmbed('✅ Nickname Updated', `${user}'s nickname is now **${nickname || user.username}**.`)] });
  }
});

// ---------------------------------------------------------------------------------
// Leveling
// ---------------------------------------------------------------------------------
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
    const rows = db.topLevels(interaction.guildId, 10);
    await interaction.reply({ embeds: [ui.leaderboardEmbed(interaction.guild.name, rows)] });
  }
});

// ---------------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------------
commands.push({
  data: new SlashCommandBuilder().setName('ticketpanel').setDescription('Post the ticket-opening panel here.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction) {
    const cfg = db.getConfig(interaction.guildId).ticket;
    if (!cfg.enabled) return interaction.reply({ embeds: [ui.errorEmbed('Tickets Disabled', 'Run `/tickets setup state:enable` first.')], ephemeral: true });
    await interaction.channel.send({ embeds: [ui.ticketPanelEmbed(interaction.guild.name, cfg)], components: [ui.ticketPanelRow()] });
    await interaction.reply({ embeds: [ui.okEmbed('✅ Panel Posted', 'The ticket panel is live.')], ephemeral: true });
  }
});

// ---------------------------------------------------------------------------------
// /ticketconfig — the picture + message shown on the panel and inside every new ticket
// ---------------------------------------------------------------------------------
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
    if (!requireAdmin(interaction)) return;
    const map = {
      panel_title: 'panelTitle', panel_description: 'panelDescription', panel_thumbnail: 'panelThumbnail', panel_image: 'panelImage',
      category_label: 'categoryLabel', welcome_message: 'welcomeMessage', welcome_thumbnail: 'welcomeThumbnail', welcome_image: 'welcomeImage'
    };
    const patch = { ticket: {} };
    let changed = false;
    for (const [opt, key] of Object.entries(map)) {
      const val = interaction.options.getString(opt);
      if (val !== null) { patch.ticket[key] = val; changed = true; }
    }
    const fileMap = {
      panel_thumbnail_file: 'panelThumbnail', panel_image_file: 'panelImage',
      welcome_thumbnail_file: 'welcomeThumbnail', welcome_image_file: 'welcomeImage'
    };
    for (const [opt, key] of Object.entries(fileMap)) {
      const attachment = getImageAttachment(interaction, opt);
      if (attachment) { patch.ticket[key] = attachment.url; changed = true; }
    }
    const cfg = changed ? db.saveConfig(interaction.guildId, patch).ticket : db.getConfig(interaction.guildId).ticket;
    await interaction.reply({
      content: changed ? `${ui.emoji('success')} Ticket appearance updated. Previews below:` : 'Current ticket appearance — previews below:',
      embeds: [ui.ticketPanelEmbed(interaction.guild.name, cfg), ui.ticketWelcomeEmbed(interaction.user, cfg)],
      ephemeral: true
    });
  }
});

// ---------------------------------------------------------------------------------
// Dedicated ticket-action commands — usable inside a ticket channel by staff/admins,
// as an alternative to the Staff Controls buttons.
// ---------------------------------------------------------------------------------
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
    const ticket = requireInTicket(interaction); if (!ticket) return;
    const ticketCfg = db.getConfig(interaction.guildId).ticket;
    if (!requireTicketStaff(interaction, ticketCfg)) return;
    if (ticket.claimedBy) return interaction.reply({ embeds: [ui.warnEmbed('Already Claimed', `Already claimed by <@${ticket.claimedBy}>.`)], ephemeral: true });
    db.setTicketStatus(interaction.channel.id, 'claimed', interaction.user.id);
    await interaction.reply({ embeds: [ui.okEmbed('🙋 Ticket Claimed', `${interaction.user} claimed this ticket.`)] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('close').setDescription('Close this ticket (deletes it shortly after).'),
  async execute(interaction) {
    const ticket = requireInTicket(interaction); if (!ticket) return;
    const ticketCfg = db.getConfig(interaction.guildId).ticket;
    if (!requireTicketStaff(interaction, ticketCfg) && interaction.user.id !== ticket.userId) return;
    db.setTicketStatus(interaction.channel.id, 'closed');
    await interaction.reply({ embeds: [ui.warnEmbed('🔒 Closing Ticket', `Closed by ${interaction.user}. This channel will be deleted in 5 seconds.`)] });
    if (ticketCfg.logChannelId) {
      const log = interaction.guild.channels.cache.get(ticketCfg.logChannelId);
      if (log) log.send({ embeds: [ui.base('🎫 Ticket Closed').setDescription(`Ticket by <@${ticket.userId}> closed by ${interaction.user}.`)] }).catch(() => {});
    }
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('delete').setDescription('Immediately delete this ticket, no grace period.'),
  async execute(interaction) {
    const ticket = requireInTicket(interaction); if (!ticket) return;
    const ticketCfg = db.getConfig(interaction.guildId).ticket;
    if (!requireTicketStaff(interaction, ticketCfg)) return;
    await interaction.reply({ embeds: [ui.warnEmbed('🗑️ Deleting Ticket', 'This channel is being deleted now.')] });
    if (ticketCfg.logChannelId) {
      const log = interaction.guild.channels.cache.get(ticketCfg.logChannelId);
      if (log) log.send({ embeds: [ui.base('🗑️ Ticket Deleted').setDescription(`Ticket by <@${ticket.userId}> deleted by ${interaction.user}.`)] }).catch(() => {});
    }
    setTimeout(() => interaction.channel.delete().catch(() => {}), 1500);
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('addmembertoticket').setDescription('Add a member to this ticket.')
    .addUserOption(o => o.setName('user').setDescription('member to add').setRequired(true)),
  async execute(interaction) {
    const ticket = requireInTicket(interaction); if (!ticket) return;
    const ticketCfg = db.getConfig(interaction.guildId).ticket;
    if (!requireTicketStaff(interaction, ticketCfg)) return;
    const user = interaction.options.getUser('user');
    await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
    await interaction.reply({ embeds: [ui.okEmbed('➕ Member Added', `${user} can now see this ticket.`)] });
  }
});

commands.push({
  data: new SlashCommandBuilder().setName('removemembertoticket').setDescription('Remove a member from this ticket.')
    .addUserOption(o => o.setName('user').setDescription('member to remove').setRequired(true)),
  async execute(interaction) {
    const ticket = requireInTicket(interaction); if (!ticket) return;
    const ticketCfg = db.getConfig(interaction.guildId).ticket;
    if (!requireTicketStaff(interaction, ticketCfg)) return;
    const user = interaction.options.getUser('user');
    await interaction.channel.permissionOverwrites.delete(user.id).catch(() => {});
    await interaction.reply({ embeds: [ui.okEmbed('➖ Member Removed', `${user} can no longer see this ticket.`)] });
  }
});

// ---------------------------------------------------------------------------------
// /prefix — configure the text-command prefix ("<prefix> <cmd> ...")
// ---------------------------------------------------------------------------------
commands.push({
  data: new SlashCommandBuilder()
    .setName('prefix')
    .setDescription('Set this server\'s prefix for text commands (e.g. !ban @user spamming).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('prefix').setDescription('new prefix, e.g. ! or ? or >').setRequired(true)),
  async execute(interaction) {
    if (!requireAdmin(interaction)) return;
    const prefix = interaction.options.getString('prefix').trim().slice(0, 5);
    if (!prefix) return interaction.reply({ embeds: [ui.errorEmbed('Invalid Prefix', 'Prefix can\'t be empty.')], ephemeral: true });
    db.saveConfig(interaction.guildId, { prefix });
    await interaction.reply({ embeds: [ui.okEmbed('✅ Prefix Updated', `Text commands now use \`${prefix}\`. Example: \`${prefix}help\``)] });
  }
});

// ---------------------------------------------------------------------------------
// /testgreet — preview the greet message (supports a picture/GIF) without a real member join
// ---------------------------------------------------------------------------------
commands.push({
  data: new SlashCommandBuilder().setName('testgreet').setDescription('Preview the greet message, optionally with a custom image or GIF.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('message').setDescription('override text, use {user} and {server} (defaults to the configured message)'))
    .addStringOption(o => o.setName('image').setDescription('image/GIF URL to attach (defaults to the configured one, if any)'))
    .addAttachmentOption(o => o.setName('attachment').setDescription('upload an image/GIF directly instead of a URL'))
    .addChannelOption(o => o.setName('channel').setDescription('post the preview here instead of this channel').addChannelTypes(ChannelType.GuildText)),
  async execute(interaction) {
    if (!requireAdmin(interaction)) return;
    const cfg = db.getConfig(interaction.guildId).greetmessage;
    const attachment = interaction.options.getAttachment('attachment');
    const imageUrl = attachment ? attachment.url : (interaction.options.getString('image') || cfg.image || null);
    const text = (interaction.options.getString('message') || cfg.message || 'Welcome {user}!')
      .replace('{user}', `${interaction.user}`).replace('{server}', interaction.guild.name);
    const embed = ui.okEmbed('👋 Welcome! (Test)', text);
    if (imageUrl) embed.setImage(imageUrl);
    const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
    await targetChannel.send({ embeds: [embed] });
    if (targetChannel.id !== interaction.channel.id) {
      await interaction.reply({ embeds: [ui.okEmbed('✅ Preview Sent', `Posted in ${targetChannel}.`)], ephemeral: true });
    } else {
      await interaction.reply({ content: ui.emojify(`${ui.emoji('success')} Preview posted above (this test does not save the image as your permanent config — use /greetmessage setup for that).`), ephemeral: true });
    }
  }
});

// ---------------------------------------------------------------------------------
// /xp — admin XP management
// ---------------------------------------------------------------------------------
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
    if (sub === 'add') xp = Math.max(0, xp + interaction.options.getInteger('amount'));
    else if (sub === 'remove') xp = Math.max(0, xp - interaction.options.getInteger('amount'));
    else if (sub === 'set') xp = Math.max(0, interaction.options.getInteger('amount'));
    else if (sub === 'setlevel') level = Math.max(0, interaction.options.getInteger('level'));
    else if (sub === 'reset') { xp = 0; level = 0; }
    db.setLevel(interaction.guildId, user.id, xp, level, rec.lastMessage);
    await interaction.reply({ embeds: [ui.okEmbed('📈 XP Updated', `${user} — **Level:** ${level} **XP:** ${xp}`)] });
  }
});

// ---------------------------------------------------------------------------------
// Owner-only global blacklist: block commands inside servers owned by a user.
// ---------------------------------------------------------------------------------
commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('bl').setDescription('[Owner] Block command use in servers owned by a user.')
    .addSubcommand(s => s.setName('add').setDescription('Blacklist all servers owned by a user.')
      .addStringOption(o => o.setName('user_id').setDescription('Discord user ID of the server owner').setRequired(true).setMinLength(15).setMaxLength(25)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a user from the global server blacklist.')
      .addStringOption(o => o.setName('user_id').setDescription('Discord user ID').setRequired(true).setMinLength(15).setMaxLength(25)))
    .addSubcommand(s => s.setName('list').setDescription('List globally blacklisted server owners.')),
  async execute(interaction) {
    if (!isOwner(interaction.user?.id)) return interaction.reply({ embeds: [ui.errorEmbed('⛔ Owner Only', 'This command is restricted to IDs listed in `OWNER_IDS`.')], ephemeral: true });
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const ids = db.getGlobalBlacklist();
      const lines = ids.map((id, index) => `**${index + 1}.** <@${id}> — \`${id}\``);
      return interaction.reply({ embeds: [ui.infoEmbed('🛡️ Global Server Blacklist', lines.join('\n').slice(0, 3900) || 'The global blacklist is empty.')], ephemeral: true });
    }
    const userId = String(interaction.options.getString('user_id', true)).trim();
    if (!/^\d{15,25}$/.test(userId)) return interaction.reply({ embeds: [ui.errorEmbed('Invalid User ID', 'Enter a valid Discord user ID containing 15–25 digits.')], ephemeral: true });
    if (sub === 'add') {
      const ids = db.addGlobalBlacklist(userId);
      const ownedGuilds = interaction.client.guilds.cache.filter(g => g.ownerId === userId).map(g => g.name);
      return interaction.reply({ embeds: [ui.okEmbed('🚫 Owner Blacklisted', `AunXz will silently ignore commands in servers owned by <@${userId}>.\n**Currently joined matching servers:** ${ownedGuilds.length}${ownedGuilds.length ? `\n${ownedGuilds.slice(0, 8).map(name => `• ${name}`).join('\n')}` : ''}\n**Total blacklisted owners:** ${ids.length}`)], ephemeral: true });
    }
    const ids = db.removeGlobalBlacklist(userId);
    return interaction.reply({ embeds: [ui.okEmbed('✅ Owner Removed From Blacklist', `Commands are no longer blocked based on server ownership for <@${userId}>.\n**Total blacklisted owners:** ${ids.length}`)], ephemeral: true });
  }
});

// ---------------------------------------------------------------------------------
// Owner-only
// ---------------------------------------------------------------------------------
commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('maintenance').setDescription('[Owner] Toggle maintenance mode.')
    .addStringOption(o => o.setName('state').setDescription('on/off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
  async execute(interaction) {
    if (!isOwner(interaction.user.id)) return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
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
    if (!isOwner(interaction.user.id)) return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
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
    if (!isOwner(interaction.user.id)) return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      return interaction.reply({ embeds: [ui.emojisListEmbed(db.getAllEmojiOverrides(), 1)], components: ui.emojisListRows(1), ephemeral: true });
    }
    if (sub === 'save') {
      const values = {};
      for (const key of ui.EMOJI_KEYS) values[key] = ui.emoji(key);
      const code = db.saveEmojiSnapshot(values);
      return interaction.reply({ embeds: [ui.okEmbed('💾 Emoji Snapshot Saved', `Snapshot saved.

**Code:** \`${code}\`\n
Use **/emoji load** with this code to restore these emojis later.`)], ephemeral: true });
    }
    if (sub === 'load') {
      const code = interaction.options.getString('code').trim();
      const snapshot = db.getEmojiSnapshot(code);
      if (!snapshot) return interaction.reply({ embeds: [ui.errorEmbed('Snapshot Not Found', `No emoji snapshot exists for \`${code}\`.`)], ephemeral: true });
      for (const key of ui.EMOJI_KEYS) {
        const value = snapshot[key];
        if (value) db.setEmojiOverride(key, value);
      }
      return interaction.reply({ embeds: [ui.okEmbed('📥 Emoji Snapshot Loaded', `Restored **${Object.keys(snapshot).length}** emoji values from snapshot \`${code}\`.`)] });
    }
    const name = interaction.options.getString('name').trim().toLowerCase();
    if (!ui.EMOJI_KEYS.includes(name)) {
      return interaction.reply({ embeds: [ui.errorEmbed('Unknown Emoji', `**${name}** is not a valid emoji name. Use **/emoji list** first.`)], ephemeral: true });
    }
    if (sub === 'set') {
      const value = interaction.options.getString('value').trim();
      if (!value) return interaction.reply({ embeds: [ui.errorEmbed('Invalid Emoji', 'The emoji value cannot be empty.')], ephemeral: true });
      db.setEmojiOverride(name, value);
      return interaction.reply({ embeds: [ui.okEmbed(`${ui.emoji('success')} Emoji Updated`, `**${name}** is now ${value}. All matching button icons and embed text use it immediately.`)] });
    }
    db.resetEmojiOverride(name);
    return interaction.reply({ embeds: [ui.okEmbed(`${ui.emoji('success')} Emoji Reset`, `**${name}** is back to its default: ${ui.DEFAULT_EMOJIS[name]}`)] });
  }
});

// ---------------- Owner: /em — dynamic embed/emoji registry ----------------
commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('em').setDescription('[Owner] Browse and edit AunXz embed text and emojis.')
    .addSubcommand(s => s.setName('list').setDescription('List registered embed texts and discovered emojis.'))
    .addSubcommand(s => s.setName('edit').setDescription('Edit one registered embed text.')
      .addStringOption(o => o.setName('name').setDescription('Name shown by /em list').setRequired(true).setAutocomplete(true))),
  async execute(interaction) {
    if (!isOwner(interaction.user.id)) return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') return interaction.reply({ embeds: [ui.embedTextsListEmbed(1)], components: ui.embedTextsListRows(1), ephemeral: true });
    const name = interaction.options.getString('name', true).trim();
    const row = db.getEmbedText(name);
    if (!row) return interaction.reply({ embeds: [ui.errorEmbed('Embed Not Found', `No registered embed named **${name}** exists. Run **/em list** first.`)], ephemeral: true });
    const { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
    const modal = new ModalBuilder().setCustomId(`em_edit_modal:${row.name}`).setTitle(`Edit ${row.name}`.slice(0,45));
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(row.title || row.sourceTitle).slice(0,256))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue(String(row.description || '').slice(0,4000))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('footer').setLabel('Footer').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(row.footer || '').slice(0,200)))
    );
    return interaction.showModal(modal);
  }
});

// ---------------- Owner: /ms — server membership/subscription manager ------------
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
    if (!isOwner(interaction.user.id)) return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
    const sub = interaction.options.getSubcommand();
    if (sub === 'add') {
      const serverId = interaction.options.getString('server_id', true).trim();
      if (!/^\d{15,25}$/.test(serverId)) return interaction.reply({ embeds: [ui.errorEmbed('Invalid Server ID', 'Enter a valid Discord server ID.')], ephemeral: true });
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

// ---------------- Owner: /ownerlogsetup ------------------------------------------
commands.push({
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('ownerlogsetup').setDescription('[Owner] Configure global bot logs in the owner server.'),
  async execute(interaction) {
    if (!isOwner(interaction.user.id)) return interaction.reply({ embeds: [ui.errorEmbed('Denied', 'Owner only.')], ephemeral: true });
    const cfg = db.getOwnerConfig();
    return interaction.reply({ embeds: [ui.ownerLogSetupEmbed(cfg)], components: ui.ownerLogSetupRows(cfg), ephemeral: true });
  }
});

module.exports = { commands, isOwner, buildModulePatch, PANEL_MODULES, handleDangerousConfirmation };
