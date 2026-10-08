'use strict';

const {
  ChannelType, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  StringSelectMenuBuilder, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, AuditLogEvent
} = require('discord.js');

const {
  client, db, ui, sys, stats, commands, isOwner, buildModulePatch, PANEL_MODULES,
  applicationSessions, birthdayWishesSent, logSetupSessions, rolePanelSessions, setupMediaSessions,
  executeCommand, startSetupMediaUpload, consumeSetupMedia, handlePrefixCommand, stripEphemeral
} = require('./indexaa');


function statPanelPayload(guildId, category = 'server', selected = 'members') {
  const cfg = stats.readStats(guildId);
  let actual = selected;
  if (category === 'server' && !cfg.server[actual]) actual = 'members';
  if (category === 'social' && !cfg.social[actual]) actual = 'youtube';
  if (category === 'custom' && !cfg.custom.find(x => x.id === actual)) actual = cfg.custom[0]?.id || 'none';
  return {
    embeds: [ui.statSetupEmbed(cfg, category, actual)],
    components: [
      ui.statSetupCategoryRow(category),
      ui.statSetupMetricRow(cfg, category, actual),
      ui.statSetupCategoryChannelRow(cfg),
      ...ui.statSetupActionRows(category, actual, cfg)
    ],
    ephemeral: true
  };
}

function statSelectedEntry(guildId, category, key) {
  const cfg = stats.readStats(guildId);
  if (category === 'server') return cfg.server[key] || null;
  if (category === 'social') return cfg.social[key] || null;
  return cfg.custom.find(x => x.id === key) || null;
}

function statAdmin(interaction) {
  return Boolean(interaction.guild && interaction.member?.permissions?.has(PermissionFlagsBits.Administrator));
}


// ---------------------------------------------------------------------------------
// interactionCreate — slash commands, buttons, select menus, modals
// ---------------------------------------------------------------------------------
function startInteractionWatchdog(interaction) {
  if (!interaction?.isRepliable?.() || interaction.isAutocomplete?.()) return () => {};
  const originalReply = interaction.reply?.bind(interaction);
  const originalUpdate = interaction.update?.bind(interaction);
  if (originalReply) interaction.reply = payload => interaction.deferred ? interaction.editReply(payload) : originalReply(payload);
  if (originalUpdate) interaction.update = payload => interaction.deferred ? interaction.editReply(payload) : originalUpdate(payload);
  const timer = setTimeout(() => {
    if (interaction.replied || interaction.deferred) return;
    interaction.deferReply({ephemeral:true}).catch(() => {});
  }, 2200);
  return () => clearTimeout(timer);
}

client.on('interactionCreate', async (interaction) => {
  const stopInteractionWatchdog = startInteractionWatchdog(interaction);
  try {
    if (interaction.isChatInputCommand()) {
      if (db.getConfig(interaction.guildId).blacklist.includes(interaction.user.id) && !isOwner(interaction.user.id)) {
        return interaction.reply({ embeds: [ui.errorEmbed('Blacklisted', 'You are blocked from using this bot.')], ephemeral: true });
      }
      const cmd = commands.find(c => c.data.name === interaction.commandName);
      if (cmd) await executeCommand(cmd, interaction);
      return;
    }

    // Statsetup selectors ---------------------------------------------------------------
    if (interaction.isStringSelectMenu() && interaction.customId === 'statsetup:category') {
      if (!statAdmin(interaction)) return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
      const category = interaction.values[0];
      const cfg = stats.readStats(interaction.guildId);
      const selected = category === 'server' ? 'members' : category === 'social' ? 'youtube' : (cfg.custom[0]?.id || 'none');
      return interaction.update(statPanelPayload(interaction.guildId, category, selected));
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('statsetup:metric:')) {
      if (!statAdmin(interaction)) return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
      const category = interaction.customId.split(':')[2];
      const selected = interaction.values[0];
      return interaction.update(statPanelPayload(interaction.guildId, category, selected));
    }
    if (interaction.isChannelSelectMenu() && interaction.customId === 'statsetup:category_channel') {
      if (!statAdmin(interaction)) return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
      const channel = interaction.guild.channels.cache.get(interaction.values[0]);
      if (!channel || channel.type !== ChannelType.GuildCategory) return interaction.reply({ embeds: [ui.errorEmbed('Invalid Category', 'Choose a category channel.')], ephemeral: true });
      stats.setCategory(interaction.guildId, channel);
      return interaction.update(statPanelPayload(interaction.guildId, 'server', 'members'));
    }

    // Multi-panel role manager selects ------------------------------------------------
    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('buttonroles_role_select:')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      const panelId=interaction.customId.split(':')[1], panel=getPanel(interaction.guildId,'button',panelId), role=interaction.guild.roles.cache.get(interaction.values[0]);
      if(!panel)return interaction.reply({embeds:[ui.errorEmbed('Panel Not Found','That button-role panel no longer exists.')],ephemeral:true});
      if(!role)return interaction.reply({embeds:[ui.errorEmbed('Role Not Found','That role is no longer available.')],ephemeral:true});
      if(role.id===interaction.guild.id)return interaction.reply({embeds:[ui.errorEmbed('Invalid Role','@everyone cannot be used.')],ephemeral:true});
      const bot=interaction.guild.members.me;
      if(role.position>=bot.roles.highest.position)return interaction.reply({embeds:[ui.errorEmbed('Role Hierarchy',`I cannot manage **${role.name}** because it is equal to or higher than my highest role.`)],ephemeral:true});
      db.upsertPanel(interaction.guildId,'button',{...panel,buttons:[...(panel.buttons||[]).filter(b=>b.roleId!==role.id),{roleId:role.id,label:role.name.slice(0,80),mode:'toggle'}]});
      rememberSelectedPanel(interaction.guildId,interaction.user.id,'button',panelId);
      return interaction.update(panelManagerPayload(interaction.guildId,interaction.user.id,'button'));
    }
    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('reactionroles_role_select:')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      const panelId=interaction.customId.split(':')[1], panel=getPanel(interaction.guildId,'reaction',panelId), role=interaction.guild.roles.cache.get(interaction.values[0]);
      if(!panel)return interaction.reply({embeds:[ui.errorEmbed('Panel Not Found','That reaction-role panel no longer exists.')],ephemeral:true});
      if(!role)return interaction.reply({embeds:[ui.errorEmbed('Role Not Found','That role is no longer available.')],ephemeral:true});
      const bot=interaction.guild.members.me;
      if(role.position>=bot.roles.highest.position)return interaction.reply({embeds:[ui.errorEmbed('Role Hierarchy',`I cannot manage **${role.name}** because it is equal to or higher than my highest role.`)],ephemeral:true});
      const modal=new ModalBuilder().setCustomId(`reactionroles_add_modal:${panelId}:${role.id}`).setTitle('Add Reaction Role');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emoji').setLabel('Emoji').setPlaceholder('🎮 or <:name:id>').setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('label').setLabel('Label (optional)').setPlaceholder(role.name).setStyle(TextInputStyle.Short).setRequired(false)));
      return interaction.showModal(modal);
    }
    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('buttonroles_cfg:channel:')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      const panelId=interaction.customId.split(':')[2], panel=getPanel(interaction.guildId,'button',panelId); if(!panel)return interaction.reply({embeds:[ui.errorEmbed('Panel Not Found','That panel no longer exists.')],ephemeral:true});
      db.upsertPanel(interaction.guildId,'button',{...panel,channelId:interaction.values[0]}); rememberSelectedPanel(interaction.guildId,interaction.user.id,'button',panelId); return interaction.update(panelManagerPayload(interaction.guildId,interaction.user.id,'button'));
    }
    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('reactionroles_cfg:channel:')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      const panelId=interaction.customId.split(':')[2], panel=getPanel(interaction.guildId,'reaction',panelId); if(!panel)return interaction.reply({embeds:[ui.errorEmbed('Panel Not Found','That panel no longer exists.')],ephemeral:true});
      db.upsertPanel(interaction.guildId,'reaction',{...panel,channelId:interaction.values[0]}); rememberSelectedPanel(interaction.guildId,interaction.user.id,'reaction',panelId); return interaction.update(panelManagerPayload(interaction.guildId,interaction.user.id,'reaction'));
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'buttonroles_cfg:select') {
      rememberSelectedPanel(interaction.guildId,interaction.user.id,'button',interaction.values[0]); return interaction.update(panelManagerPayload(interaction.guildId,interaction.user.id,'button'));
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'reactionroles_cfg:select') {
      rememberSelectedPanel(interaction.guildId,interaction.user.id,'reaction',interaction.values[0]); return interaction.update(panelManagerPayload(interaction.guildId,interaction.user.id,'reaction'));
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('buttonroles_cfg:remove_role:')) {
      const panelId=interaction.customId.split(':')[2],panel=getPanel(interaction.guildId,'button',panelId);if(!panel)return interaction.reply({embeds:[ui.errorEmbed('Panel Not Found','That panel no longer exists.')],ephemeral:true});
      db.upsertPanel(interaction.guildId,'button',{...panel,buttons:(panel.buttons||[]).filter(b=>b.roleId!==interaction.values[0])});rememberSelectedPanel(interaction.guildId,interaction.user.id,'button',panelId);return interaction.update(panelManagerPayload(interaction.guildId,interaction.user.id,'button'));
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('reactionroles_cfg:remove_role:')) {
      const panelId=interaction.customId.split(':')[2],panel=getPanel(interaction.guildId,'reaction',panelId);if(!panel)return interaction.reply({embeds:[ui.errorEmbed('Panel Not Found','That panel no longer exists.')],ephemeral:true});
      db.upsertPanel(interaction.guildId,'reaction',{...panel,mappings:(panel.mappings||[]).filter(m=>m.roleId!==interaction.values[0])});rememberSelectedPanel(interaction.guildId,interaction.user.id,'reaction',panelId);return interaction.update(panelManagerPayload(interaction.guildId,interaction.user.id,'reaction'));
    }

    // Giveaway controls -------------------------------------------------------------
    if (interaction.isButton() && interaction.customId.startsWith('giveaway_publish:')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))
        return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Manage Server is required.')], ephemeral: true });
      const id = Number(interaction.customId.split(':')[1]);
      const g = db.getGiveaway(interaction.guildId, id);
      if (!g || g.status !== 'configuring')
        return interaction.reply({ embeds: [ui.errorEmbed('Giveaway Unavailable', 'That giveaway no longer exists or was already published.')], ephemeral: true });
      const ch = interaction.guild.channels.cache.get(g.channelId) || interaction.channel;
      const row = new (require('discord.js').ActionRowBuilder)().addComponents(
        new (require('discord.js').ButtonBuilder)().setCustomId(`giveaway_join:${g.id}`).setLabel('🎉 Enter Giveaway').setStyle(require('discord.js').ButtonStyle.Success)
      );
      const msg = await ch.send({ embeds: [ui.base('🎉 Giveaway')
        .setDescription(`**Prize:** ${g.prize}\n**Winners:** **${g.winners}**\n**Ends:** <t:${Math.floor(g.endsAt/1000)}:R>\n\nClick the button below to enter.`)
        .setFooter({ text: `Hosted by ${interaction.user.tag} • Giveaway #${g.id}` })], components: [row] });
      db.updateGiveaway(interaction.guildId, id, { messageId: msg.id, channelId: ch.id, status: 'active' });
      return interaction.update({ embeds: [ui.okEmbed('🎉 Giveaway Published', `Published in ${ch}.\n\n**Prize:** ${g.prize}\n**Ends:** <t:${Math.floor(g.endsAt/1000)}:R>`)], components: [] });
    }
    if (interaction.isButton() && interaction.customId.startsWith('giveaway_cancel:')) {
      const id = Number(interaction.customId.split(':')[1]);
      const g = db.getGiveaway(interaction.guildId, id);
      if (!g) return interaction.reply({ embeds: [ui.errorEmbed('Not Found', 'Giveaway not found.')], ephemeral: true });
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
      try { participants = JSON.parse(g.participants || '[]'); } catch {}
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
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      const part=interaction.customId.split(':')[1], value=interaction.values[0];
      const patch = part === 'status' ? {enabled:value==='enable'} :
        part === 'filter' ? ({badWordFilter:value==='badwords' ? !db.getConfig(interaction.guildId).automod.badWordFilter :
          db.getConfig(interaction.guildId).automod.badWordFilter,
          capsFilter:value==='caps' ? !db.getConfig(interaction.guildId).automod.capsFilter : db.getConfig(interaction.guildId).automod.capsFilter,
          inviteFilter:value==='invites' ? !db.getConfig(interaction.guildId).automod.inviteFilter : db.getConfig(interaction.guildId).automod.inviteFilter}) : {};
      const cfg=db.saveConfig(interaction.guildId,{automod:patch}).automod;
      return interaction.update({embeds:[ui.automodSetupEmbed(cfg)],components:ui.automodSetupRows(cfg)});
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'logsetup:type') {
      logSetupSessions.set(`${interaction.guildId}:${interaction.user.id}`, interaction.values[0]);
      return interaction.update({embeds:[ui.logSetupEmbed(db.getConfig(interaction.guildId).logs)],components:ui.logSetupRows(db.getConfig(interaction.guildId).logs)});
    }
    if (interaction.isChannelSelectMenu() && (interaction.customId === 'logsetup:channel' || interaction.customId.startsWith('logs_cfg:'))) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      let type = interaction.customId.startsWith('logs_cfg:') ? interaction.customId.split(':')[1] : logSetupSessions.get(`${interaction.guildId}:${interaction.user.id}`);
      if (!type) return interaction.reply({embeds:[ui.errorEmbed('Select Log Type First','Choose a log type first, then choose its channel.')],ephemeral:true});
      const cfg=db.saveConfig(interaction.guildId,{logs:{[type]:interaction.values[0]}}).logs;
      logSetupSessions.delete(`${interaction.guildId}:${interaction.user.id}`);
      return interaction.update({embeds:[ui.logSetupEmbed(cfg)],components:ui.logSetupRows(cfg)});
    }
    if (interaction.isChannelSelectMenu() && interaction.customId === 'buttonroles_cfg:channel') {
      const cfg=db.saveConfig(interaction.guildId,{buttonRoles:{channelId:interaction.values[0]}}).buttonRoles;
      return interaction.update({embeds:[ui.buttonRoleEmbed(cfg)],components:ui.buttonRoleSetupRows(cfg)});
    }
    if (interaction.isChannelSelectMenu() && interaction.customId === 'reactionroles_cfg:channel') {
      const cfg=db.saveConfig(interaction.guildId,{reactionRoles:{channelId:interaction.values[0]}}).reactionRoles;
      return interaction.update({embeds:[ui.reactionRoleSetupEmbed(cfg)],components:ui.reactionRoleSetupRows(cfg)});
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'role_select') return handleButton(interaction);
    if (interaction.isStringSelectMenu() && interaction.customId === 'vm_kick_pick') return handleVMKickPick(interaction);
    if (interaction.isStringSelectMenu() && interaction.customId === 'role_select') return handleButton(interaction);

    if (interaction.isChannelSelectMenu() && interaction.customId === 'vm_setup_category_select') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to use this.')], ephemeral: true });
      }
      const cfg = db.saveConfig(interaction.guildId, { voicemaster: { categoryId: interaction.values[0] } });
      return interaction.update({ embeds: [ui.vmSetupEmbed(cfg)], components: [ui.vmSetupRow(cfg)] });
    }
    // Security setup panels -------------------------------------------------------
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('security_cfg:')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      const [, module, field] = interaction.customId.split(':'); const value=interaction.values[0];
      const keyMap={action:{antiwebhook:'action',antibot:'action',antialt:'action'},age:{antialt:'minAccountAgeDays'}}; const key=keyMap[field]?.[module];
      if(!key)return interaction.reply({embeds:[ui.errorEmbed('Invalid Setting','That security setting is unavailable.')],ephemeral:true});
      const cfg=db.saveConfig(interaction.guildId,{[module]:{[key]:field==='age'?Number(value):value}});
      return interaction.update({embeds:[ui.setupPanelEmbed(module,cfg)],components:ui.setupPanelRow(module,cfg)});
    }
    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('security_cfg:')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      const [, module, field]=interaction.customId.split(':'); if(field!=='bypass') return;
      const cfg=db.saveConfig(interaction.guildId,{[module]:{bypassRoleId:interaction.values[0]}});
      return interaction.update({embeds:[ui.setupPanelEmbed(module,cfg)],components:ui.setupPanelRow(module,cfg)});
    }
    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('security_cfg:')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      const [, module, field]=interaction.customId.split(':'); if(field!=='log') return;
      const cfg=db.saveConfig(interaction.guildId,{[module]:{logChannelId:interaction.values[0]}});
      return interaction.update({embeds:[ui.setupPanelEmbed(module,cfg)],components:ui.setupPanelRow(module,cfg)});
    }
    // Easy setup panels ------------------------------------------------------------
    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('birthday_cfg:')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      const part=interaction.customId.split(':')[1];
      const patch=part==='panel'?{birthdays:{panelChannelId:interaction.values[0]}}:{birthdays:{wishChannelId:interaction.values[0]}};
      const cfg=db.saveConfig(interaction.guildId,patch).birthdays;
      return interaction.update({embeds:[ui.birthdaySetupEmbed(cfg)],components:ui.birthdaySetupRow(cfg)});
    }
    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('honeypot_cfg:')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      const part=interaction.customId.split(':')[1];
      if(part==='channel') db.saveConfig(interaction.guildId,{honeypot:{channelId:interaction.values[0]}});
      const cfg=db.getConfig(interaction.guildId).honeypot;
      return interaction.update({embeds:[ui.honeypotSetupEmbed(cfg)],components:ui.honeypotSetupRow(cfg)});
    }
    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('antibadword_cfg:')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      db.saveConfig(interaction.guildId,{antibadword:{logChannelId:interaction.values[0]}});
      const cfg=db.getConfig(interaction.guildId).antibadword;
      return interaction.update({embeds:[ui.antiBadwordSetupEmbed(cfg)],components:ui.antiBadwordSetupRow(cfg)});
    }
    if (interaction.isChannelSelectMenu() && interaction.customId === 'greetvoice_cfg:voice') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      const cfg=db.saveConfig(interaction.guildId,{greetvoice:{vcId:interaction.values[0]}}).greetvoice;
      await interaction.update({embeds:[ui.greetVoiceSetupEmbed(cfg)],components:ui.greetVoiceSetupRow(cfg)}).catch(()=>{});
      const ch=interaction.guild.channels.cache.get(cfg.vcId);
      const role=cfg.roleId?interaction.guild.roles.cache.get(cfg.roleId):null;
      if(role&&ch) sys.lockRoleToSingleChannel(interaction.guild,role,ch.id).catch(err=>console.error('greetvoice role sync:',err));
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('honeypot_cfg:')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      const part=interaction.customId.split(':')[1]; const value=interaction.values[0];
      db.saveConfig(interaction.guildId,{honeypot:part==='action'?{action:value}:{cleanupWindow:value}});
      const cfg=db.getConfig(interaction.guildId).honeypot;
      return interaction.update({embeds:[ui.honeypotSetupEmbed(cfg)],components:ui.honeypotSetupRow(cfg)});
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('antibadword_cfg:')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      db.saveConfig(interaction.guildId,{antibadword:{action:interaction.values[0]}});
      const cfg=db.getConfig(interaction.guildId).antibadword;
      return interaction.update({embeds:[ui.antiBadwordSetupEmbed(cfg)],components:ui.antiBadwordSetupRow(cfg)});
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'autoresponder_cfg:remove') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      const cfg=db.getConfig(interaction.guildId).autoresponder;
      const triggers=(cfg.triggers||[]).filter(t=>t.id!==interaction.values[0]);
      const next=db.saveConfig(interaction.guildId,{autoresponder:{triggers}}).autoresponder;
      return interaction.update({embeds:[ui.autoresponderSetupEmbed(next)],components:ui.autoresponderSetupRow(next)});
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'autoreactor_cfg:remove') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      const cfg=db.getConfig(interaction.guildId).autoreactor;
      const triggers=(cfg.triggers||[]).filter(t=>t.id!==interaction.values[0]);
      const next=db.saveConfig(interaction.guildId,{autoreactor:{triggers}}).autoreactor;
      return interaction.update({embeds:[ui.autoreactorSetupEmbed(next)],components:ui.autoreactorSetupRow(next)});
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'embedbuilder:removebutton') {
      const draft=sys.embedBuilderSessions.get(interaction.user.id);
      if(!draft) return interaction.reply({embeds:[ui.errorEmbed('Session Expired','Run `/embedbuilder` again to start a fresh draft.')],ephemeral:true});
      draft.buttons.splice(Number(interaction.values[0]),1);
      return interaction.update({embeds:[ui.embedBuilderPreviewEmbed(draft)],components:ui.embedBuilderRow(draft)});
    }
    if (interaction.isChannelSelectMenu() && interaction.customId === 'embedbuilder:post_channel') {
      const draft=sys.embedBuilderSessions.get(interaction.user.id);
      if(!draft) return interaction.update({content:'Session expired — run `/embedbuilder` again.',components:[]});
      const channel=interaction.guild.channels.cache.get(interaction.values[0]);
      if(!channel?.isTextBased()) return interaction.update({content:'That channel is not usable — pick a text channel.',components:[]});
      const embed=ui.embedBuilderPreviewEmbed(draft);
      const buttonComponents=(draft.buttons||[]).map((b,i)=>{
        const btn=new ButtonBuilder().setCustomId(`savedembed:temp:${interaction.user.id}:${i}`).setLabel(String(b.label||'Button').slice(0,80)).setStyle(ButtonStyle.Primary);
        if(b.emoji) btn.setEmoji(b.emoji);
        return btn;
      });
      const rows=[];
      for(let i=0;i<buttonComponents.length;i+=5) rows.push(new ActionRowBuilder().addComponents(buttonComponents.slice(i,i+5)));
      const sent=await channel.send({embeds:[embed],components:rows}).catch(()=>null);
      if(!sent) return interaction.update({content:`I could not post in ${channel}. Check my **Send Messages** and **Embed Links** permissions.`,components:[]});
      // Persist the posted message's button configuration so its buttons keep working.
      db.saveEmbed(interaction.guildId, `__message_${sent.id}`, {embed:embed.toJSON(), buttons:draft.buttons||[], messageId:sent.id, channelId:channel.id});
      sys.embedBuilderSessions.delete(interaction.user.id);
      return interaction.update({content:`Posted in ${channel}. Use **/embed save** from a fresh builder to store a reusable named copy.`,components:[]});
    }
    if (interaction.isButton() && interaction.customId === 'greetvoice_cfg:toggle') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      const current=db.getConfig(interaction.guildId).greetvoice;
      const nextEnabled=!current.enabled;
      if (nextEnabled && (!current.vcId || !current.roleId || (!current.ttsPrompt && !current.audioPath))) {
        return interaction.reply({embeds:[ui.errorEmbed('Not Ready','Select a voice channel, gate role, and either set a TTS prompt or upload an audio greeting before enabling Greet Voice.')],ephemeral:true});
      }
      const cfg=db.saveConfig(interaction.guildId,{greetvoice:{enabled:nextEnabled}}).greetvoice;
      await interaction.update({embeds:[ui.greetVoiceSetupEmbed(cfg)],components:ui.greetVoiceSetupRow(cfg)}).catch(()=>{});
      if (cfg.enabled) {
        const role=interaction.guild.roles.cache.get(cfg.roleId);
        if (role) sys.lockRoleToSingleChannel(interaction.guild,role,cfg.vcId).catch(err=>console.error('greetvoice role sync:',err));
      }
      return;
    }
    if (interaction.isButton() && interaction.customId === 'greetvoice_cfg:role') {
      return interaction.reply({content:'Select the role to use as the Greet Voice gate.',components:[new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('greetvoice_cfg:role_select').setPlaceholder('Select gate role'))],ephemeral:true});
    }
    if (interaction.isRoleSelectMenu() && interaction.customId === 'greetvoice_cfg:role_select') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
      const role=interaction.guild.roles.cache.get(interaction.values[0]);
      const bot=interaction.guild.members.me;
      if(!role) return interaction.reply({embeds:[ui.errorEmbed('Role Not Found','That role no longer exists.')],ephemeral:true});
      if(role.id===interaction.guild.id) return interaction.reply({embeds:[ui.errorEmbed('Invalid Role','@everyone cannot be used as the Greet Voice gate role.')],ephemeral:true});
      if(!bot?.permissions.has(PermissionFlagsBits.ManageRoles) && !bot?.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Bot Permission','I need **Manage Roles** before I can assign the Greet Voice gate role.')],ephemeral:true});
      if(role.position >= bot.roles.highest.position) return interaction.reply({embeds:[ui.errorEmbed('Role Hierarchy',`I cannot assign **${role.name}** because it is equal to or higher than my highest role. Move my bot role above it.`)],ephemeral:true});
      const cfg=db.saveConfig(interaction.guildId,{greetvoice:{roleId:role.id}}).greetvoice;
      await interaction.update({content:null,embeds:[ui.greetVoiceSetupEmbed(cfg)],components:ui.greetVoiceSetupRow(cfg)}).catch(()=>{});
      if(cfg.vcId) sys.lockRoleToSingleChannel(interaction.guild,role,cfg.vcId).catch(err=>console.error('greetvoice role sync:',err));
      return;
    }

    if (interaction.isChannelSelectMenu() && interaction.customId === 'vm_setup_channel_select') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to use this.')], ephemeral: true });
      }
      const cfg = db.saveConfig(interaction.guildId, { voicemaster: { hubChannelId: interaction.values[0] } });
      return interaction.update({ embeds: [ui.vmSetupEmbed(cfg)], components: [ui.vmSetupRow(cfg)] });
    }
    if (interaction.isUserSelectMenu() && interaction.customId === 'ticket_addmember_select') return handleTicketMemberSelect(interaction, 'add');
    if (interaction.isUserSelectMenu() && interaction.customId === 'ticket_removemember_select') return handleTicketMemberSelect(interaction, 'remove');

    if (interaction.isButton()) return handleButton(interaction);
    if (interaction.isModalSubmit()) return handleModal(interaction);
  } catch (err) {
    console.error(err);
    const payload = { embeds: [ui.errorEmbed('Error', 'Something went wrong running that.')], ephemeral: true };
    if (interaction.deferred || interaction.replied) interaction.followUp(payload).catch(() => {});
    else interaction.reply(payload).catch(() => {});
  } finally {
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
function newPanelId(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`; }
function getPanel(guildId, kind, panelId) { return db.findPanel(guildId, kind, panelId); }
function rememberSelectedPanel(guildId, userId, kind, panelId) {
  const state=rolePanelState(guildId,userId);
  if(kind==='button') state.buttonId=panelId; else state.reactionId=panelId;
  rolePanelSessions.set(rolePanelKey(guildId,userId),state);
}
function panelManagerPayload(guildId,userId,kind) {
  const cfg=db.getConfig(guildId), state=rolePanelState(guildId,userId);
  const selectedId=kind==='button'?state.buttonId:state.reactionId;
  return kind==='button'
    ? {embeds:[ui.buttonRoleEmbed(cfg,selectedId)],components:ui.buttonRoleSetupRows(cfg,selectedId)}
    : {embeds:[ui.reactionRoleSetupEmbed(cfg,selectedId)],components:ui.reactionRoleSetupRows(cfg,selectedId)};
}
function createButtonPanel() {
  return {id:newPanelId('btn'),enabled:true,channelId:null,title:'Choose your roles',description:'Press a button to get or remove a role.',image:null,embedType:'embed',buttons:[]};
}
function createReactionPanel() {
  return {id:newPanelId('react'),enabled:true,channelId:null,messageId:null,title:'Choose your roles',description:'React below to receive or remove a role.',image:null,mappings:[]};
}
async function postButtonRolePanel(guild, cfg) {
  if (!cfg.channelId) throw new Error('Select a panel channel first.');
  if (cfg.enabled===false) throw new Error('This panel is disabled. Enable it before posting.');
  if (!(cfg.buttons||[]).length) throw new Error('Add at least one role button first.');
  const channel=guild.channels.cache.get(cfg.channelId);
  if (!channel?.isTextBased()) throw new Error('The configured panel channel is unavailable.');
  const bot=guild.members.me;
  if(!bot?.permissions.has(PermissionFlagsBits.ManageRoles) && !bot?.permissions.has(PermissionFlagsBits.Administrator)) throw new Error('I need Manage Roles to create a role panel.');
  for(const b of cfg.buttons){const role=guild.roles.cache.get(b.roleId);if(!role)throw new Error(`The role for **${b.label||b.roleId}** no longer exists.`);if(role.position>=bot.roles.highest.position)throw new Error(`I cannot manage **${role.name}** because it is equal to or higher than my highest role.`);}
  const e=ui.base(cfg.title||'Choose your roles').setDescription(cfg.description||'Press a button to get or remove a role.'); if(cfg.image)e.setImage(cfg.image);
  const components=[];
  for(let i=0;i<cfg.buttons.length;i+=5){const row=new ActionRowBuilder();for(const b of cfg.buttons.slice(i,i+5))row.addComponents(new ButtonBuilder().setCustomId(`rolebtn:${cfg.id}:${b.roleId}`).setLabel(b.label||'Role').setStyle(ButtonStyle.Primary));components.push(row);}
  if(cfg.embedType==='selection'){const menu=new StringSelectMenuBuilder().setCustomId(`role_select:${cfg.id}`).setPlaceholder('Choose a role…').addOptions(cfg.buttons.slice(0,25).map(b=>({label:(b.label||'Role').slice(0,100),value:b.roleId})));components.splice(0,components.length,new ActionRowBuilder().addComponents(menu));}
  return channel.send({embeds:[e],components});
}
async function postReactionRolePanel(guild,cfg){
  if(!cfg.channelId)throw new Error('Select a panel channel first.');
  if(cfg.enabled===false)throw new Error('This panel is disabled. Enable it before posting.');
  if(!(cfg.mappings||[]).length)throw new Error('Add at least one role mapping first.');
  const channel=guild.channels.cache.get(cfg.channelId);if(!channel?.isTextBased())throw new Error('The configured panel channel is unavailable.');
  const bot=guild.members.me;if(!bot?.permissions.has(PermissionFlagsBits.ManageRoles)&&!bot?.permissions.has(PermissionFlagsBits.Administrator))throw new Error('I need Manage Roles to create a role panel.');
  for(const m of cfg.mappings){const role=guild.roles.cache.get(m.roleId);if(!role)throw new Error(`The role for **${m.label||m.roleId}** no longer exists.`);if(role.position>=bot.roles.highest.position)throw new Error(`I cannot manage **${role.name}** because it is equal to or higher than my highest role.`);}
  if(cfg.messageId){const old=await channel.messages.fetch(cfg.messageId).catch(()=>null);if(old)await old.delete().catch(()=>{});}
  const e=ui.base(cfg.title||'Choose your roles').setDescription(cfg.description||'React below to receive or remove a role.');if(cfg.image)e.setImage(cfg.image);
  const msg=await channel.send({embeds:[e]});for(const m of cfg.mappings)await msg.react(m.emoji).catch(()=>{});return msg;
}

async function handleButton(interaction) {
  if (interaction.customId.startsWith('savedembed:')) {
    const parts=interaction.customId.split(':');
    const recordName=parts[1] === 'temp' ? `__message_${interaction.message.id}` : decodeURIComponent(parts[1]);
    const saved=db.getEmbed(interaction.guildId, recordName);
    const buttonId=parts[1] === 'temp' ? Number(parts[3]) : null;
    if(!saved) return interaction.reply({embeds:[ui.errorEmbed('Embed Not Found','This saved embed is no longer available.')],ephemeral:true});
    const b = buttonId === null ? (saved.data.buttons||[]).find(x=>x.id===parts[2]) : (saved.data.buttons||[])[buttonId];
    if(!b) return interaction.reply({embeds:[ui.errorEmbed('Button Not Found','That button configuration no longer exists.')],ephemeral:true});
    const r=b.response||{};
    const e=new EmbedBuilder().setTitle(String(r.title||b.label||'Response').slice(0,256)).setDescription(String(r.description||'').slice(0,4096));
    if(r.color){const n=parseInt(String(r.color).replace('#',''),16);if(!Number.isNaN(n))e.setColor(n);}
    return interaction.reply({embeds:[e],ephemeral:true});
  }
  const id = interaction.customId;

  // Statsetup actions -----------------------------------------------------------------
  if (id.startsWith('statsetup:')) {
    if (!statAdmin(interaction)) return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to configure statistics.')], ephemeral: true });
    const parts = id.split(':');
    const action = parts[1];
    const category = parts[2] || 'server';
    const selected = parts.slice(3).join(':') || 'members';
    if (action === 'configure') {
      const entry = statSelectedEntry(interaction.guildId, category, selected);
      if (!entry) return interaction.reply({ embeds: [ui.errorEmbed('Stat Not Found', 'Choose a valid stat first.')], ephemeral: true });
      const custom = category === 'custom';
      const modal = new ModalBuilder().setCustomId(`statsetup:configure:${category}:${selected}`).setTitle(`Configure ${entry.name || selected}`);
      if (custom) {
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Stat name').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(entry.name || 'Custom Stat').slice(0, 100))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('value').setLabel('Current value / count').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(entry.value ?? '0').slice(0, 100))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('template').setLabel('Voice name ({value}, {name})').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(entry.template || '{value}').slice(0, 100))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('refresh').setLabel('Refresh seconds (60–86400)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(entry.refreshSeconds || 300)))
        );
      } else if (category === 'social') {
        const placeholder = stats.SOCIAL_DEFS[selected]?.sourceHint || 'Username / ID';
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('source').setLabel('Account / source').setPlaceholder(placeholder.slice(0, 100)).setStyle(TextInputStyle.Short).setRequired(true).setValue(String(entry.source || '').slice(0, 200))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('template').setLabel('Voice name ({followers}, {likes}, …)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(entry.template || stats.getDefaultTemplate(category, selected)).slice(0, 100))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('refresh').setLabel('Refresh seconds (60–86400)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(entry.refreshSeconds || 300)))
        );
      } else {
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('template').setLabel('Voice name ({value}, {members}, …)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(entry.template || stats.getDefaultTemplate(category, selected)).slice(0, 100))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('refresh').setLabel('Refresh seconds (60–86400)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(entry.refreshSeconds || 300)))
        );
      }
      return interaction.showModal(modal);
    }
    if (action === 'toggle') {
      const entry = stats.toggle(interaction.guildId, category, selected);
      if (entry.enabled) await stats.refreshGuild(interaction.guild);
      return interaction.update(statPanelPayload(interaction.guildId, category, selected));
    }
    if (action === 'refresh') {
      await stats.refreshGuild(interaction.guild);
      return interaction.update(statPanelPayload(interaction.guildId, category, selected));
    }
    if (action === 'delete') {
      const removed = stats.remove(interaction.guildId, category, selected);
      if (!removed) return interaction.reply({ embeds: [ui.errorEmbed('Stat Not Found', 'That stat does not exist.')], ephemeral: true });
      return interaction.update(statPanelPayload(interaction.guildId, category, category === 'custom' ? (stats.readStats(interaction.guildId).custom[0]?.id || 'none') : selected));
    }
    if (action === 'defaults') {
      stats.createDefaultServerStats(interaction.guildId);
      await stats.refreshGuild(interaction.guild);
      return interaction.update(statPanelPayload(interaction.guildId, 'server', 'members'));
    }
    if (action === 'addcustom') {
      const modal = new ModalBuilder().setCustomId('statsetup:addcustom_modal').setTitle('Add Custom Stat');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Stat name').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. Partner Count')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('value').setLabel('Current value / count').setStyle(TextInputStyle.Short).setRequired(true).setValue('0')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('template').setLabel('Voice name ({value}, {name})').setStyle(TextInputStyle.Short).setRequired(true).setValue('{value}')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('refresh').setLabel('Refresh seconds (60–86400)').setStyle(TextInputStyle.Short).setRequired(true).setValue('300'))
      );
      return interaction.showModal(modal);
    }
    if (action === 'reset') {
      stats.resetGuild(interaction.guildId);
      return interaction.update(statPanelPayload(interaction.guildId, 'server', 'members'));
    }
  }

  // Button-role / reaction-role panel manager
  if (id === 'buttonroles_cfg:create' || id === 'reactionroles_cfg:create') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
    const kind=id.startsWith('button')?'button':'reaction'; const panel=kind==='button'?createButtonPanel():createReactionPanel(); db.upsertPanel(interaction.guildId,kind,panel); rememberSelectedPanel(interaction.guildId,interaction.user.id,kind,panel.id);
    return interaction.update(panelManagerPayload(interaction.guildId,interaction.user.id,kind));
  }
  if (id === 'buttonroles_cfg:toggle' || id === 'buttonroles_cfg:delete') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
    const state=rolePanelState(interaction.guildId,interaction.user.id),panel=getPanel(interaction.guildId,'button',state.buttonId); if(!panel)return interaction.reply({embeds:[ui.errorEmbed('No Panel Selected','Create or select a button-role panel first.')],ephemeral:true});
    if(id.endsWith(':delete')){db.removePanel(interaction.guildId,'button',panel.id);state.buttonId=null;}else db.upsertPanel(interaction.guildId,'button',{...panel,enabled:panel.enabled===false});
    return interaction.update(panelManagerPayload(interaction.guildId,interaction.user.id,'button'));
  }
  if (id === 'reactionroles_cfg:toggle' || id === 'reactionroles_cfg:delete') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
    const state=rolePanelState(interaction.guildId,interaction.user.id),panel=getPanel(interaction.guildId,'reaction',state.reactionId); if(!panel)return interaction.reply({embeds:[ui.errorEmbed('No Panel Selected','Create or select a reaction-role panel first.')],ephemeral:true});
    if(id.endsWith(':delete')){db.removePanel(interaction.guildId,'reaction',panel.id);state.reactionId=null;}else db.upsertPanel(interaction.guildId,'reaction',{...panel,enabled:panel.enabled===false});
    return interaction.update(panelManagerPayload(interaction.guildId,interaction.user.id,'reaction'));
  }
  if (id.startsWith('buttonroles_cfg:settings:')) {
    const panelId=id.split(':')[2],panel=getPanel(interaction.guildId,'button',panelId);if(!panel)return interaction.reply({embeds:[ui.errorEmbed('Panel Not Found','That panel no longer exists.')],ephemeral:true});
    const modal=new ModalBuilder().setCustomId(`buttonroles_panel_modal:${panelId}`).setTitle('Button Role Panel Text');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Panel title').setStyle(TextInputStyle.Short).setRequired(true).setValue((panel.title||'Choose your roles').slice(0,100))),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Panel message').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue((panel.description||'Press a button to get or remove a role.').slice(0,1000))),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('style').setLabel('Style: embed or selection').setStyle(TextInputStyle.Short).setRequired(true).setValue(panel.embedType||'embed')));
    return interaction.showModal(modal);
  }
  if (id.startsWith('reactionroles_cfg:settings:')) {
    const panelId=id.split(':')[2],panel=getPanel(interaction.guildId,'reaction',panelId);if(!panel)return interaction.reply({embeds:[ui.errorEmbed('Panel Not Found','That panel no longer exists.')],ephemeral:true});
    const modal=new ModalBuilder().setCustomId(`reactionroles_panel_modal:${panelId}`).setTitle('Reaction Role Panel Text');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Panel title').setStyle(TextInputStyle.Short).setRequired(true).setValue((panel.title||'Choose your roles').slice(0,100))),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Panel message').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue((panel.description||'React below to receive or remove a role.').slice(0,1000))));
    return interaction.showModal(modal);
  }
  if (id.startsWith('buttonroles_cfg:addrole:')) {
    const panelId=id.split(':')[2]; return interaction.reply({embeds:[ui.base('🎭 Select Role').setDescription('Choose the role to add. No role ID is needed.')],components:[new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`buttonroles_role_select:${panelId}`).setPlaceholder('Select a role…'))],ephemeral:true});
  }
  if (id.startsWith('reactionroles_cfg:addrole:')) {
    const panelId=id.split(':')[2]; return interaction.reply({embeds:[ui.base('🎭 Select Role').setDescription('Choose the role to add. I will ask for the emoji next.')],components:[new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`reactionroles_role_select:${panelId}`).setPlaceholder('Select a role…'))],ephemeral:true});
  }
  if (id.startsWith('buttonroles_cfg:upload:')) {
    const panelId=id.split(':')[2],panel=getPanel(interaction.guildId,'button',panelId);if(!panel)return interaction.reply({embeds:[ui.errorEmbed('Panel Not Found','That panel no longer exists.')],ephemeral:true});
    return startSetupMediaUpload(interaction,{label:'the button-role panel',apply:async url=>db.upsertPanel(interaction.guildId,'button',{...panel,image:url}),render:()=>panelManagerPayload(interaction.guildId,interaction.user.id,'button')});
  }
  if (id.startsWith('buttonroles_cfg:remove_image:')) {
    const panelId=id.split(':')[2],panel=getPanel(interaction.guildId,'button',panelId);if(!panel)return interaction.reply({embeds:[ui.errorEmbed('Panel Not Found','That panel no longer exists.')],ephemeral:true}); db.upsertPanel(interaction.guildId,'button',{...panel,image:null}); return interaction.update(panelManagerPayload(interaction.guildId,interaction.user.id,'button'));
  }
  if (id.startsWith('buttonroles_cfg:post:')) {
    const panelId=id.split(':')[2],panel=getPanel(interaction.guildId,'button',panelId);if(!panel)return interaction.reply({embeds:[ui.errorEmbed('Panel Not Found','That panel no longer exists.')],ephemeral:true});
    try{const msg=await postButtonRolePanel(interaction.guild,panel);db.upsertPanel(interaction.guildId,'button',{...panel,messageId:msg.id});return interaction.reply({embeds:[ui.okEmbed('✅ Panel Posted',`Button-role panel posted in <#${msg.channel.id}>.`)],ephemeral:true});}catch(e){return interaction.reply({embeds:[ui.errorEmbed('Cannot Post Panel',e.message)],ephemeral:true});}
  }
  if (id.startsWith('reactionroles_cfg:upload:')) {
    const panelId=id.split(':')[2],panel=getPanel(interaction.guildId,'reaction',panelId);if(!panel)return interaction.reply({embeds:[ui.errorEmbed('Panel Not Found','That panel no longer exists.')],ephemeral:true});
    return startSetupMediaUpload(interaction,{label:'the reaction-role panel',apply:async url=>db.upsertPanel(interaction.guildId,'reaction',{...panel,image:url}),render:()=>panelManagerPayload(interaction.guildId,interaction.user.id,'reaction')});
  }
  if (id.startsWith('reactionroles_cfg:remove_image:')) {
    const panelId=id.split(':')[2],panel=getPanel(interaction.guildId,'reaction',panelId);if(!panel)return interaction.reply({embeds:[ui.errorEmbed('Panel Not Found','That panel no longer exists.')],ephemeral:true}); db.upsertPanel(interaction.guildId,'reaction',{...panel,image:null}); return interaction.update(panelManagerPayload(interaction.guildId,interaction.user.id,'reaction'));
  }
  if (id.startsWith('reactionroles_cfg:post:')) {
    const panelId=id.split(':')[2],panel=getPanel(interaction.guildId,'reaction',panelId);if(!panel)return interaction.reply({embeds:[ui.errorEmbed('Panel Not Found','That panel no longer exists.')],ephemeral:true});
    try{const msg=await postReactionRolePanel(interaction.guild,panel);db.upsertPanel(interaction.guildId,'reaction',{...panel,messageId:msg.id});return interaction.reply({embeds:[ui.okEmbed('✅ Panel Posted',`Reaction-role panel posted in <#${msg.channel.id}>.`)],ephemeral:true});}catch(e){return interaction.reply({embeds:[ui.errorEmbed('Cannot Post Panel',e.message)],ephemeral:true});}
  }

  if (id === 'buttonroles_cfg:panel') {
    const cfg=db.getConfig(interaction.guildId).buttonRoles;
    const modal=new ModalBuilder().setCustomId('buttonroles_panel_modal').setTitle('Edit Button Role Panel').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Panel title').setStyle(TextInputStyle.Short).setRequired(true).setValue((cfg.title||'Choose your roles').slice(0,100))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Panel description').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue((cfg.description||'Press a button to get or remove a role.').slice(0,1000))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image').setLabel('Image/GIF URL (optional)').setStyle(TextInputStyle.Short).setRequired(false).setValue((cfg.image||'').slice(0,400))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('style').setLabel('Style: embed or selection').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.embedType||'embed'))
    );
    return interaction.showModal(modal);
  }
  if (id === 'buttonroles_cfg:buttons') {
    const cfg=db.getConfig(interaction.guildId).buttonRoles;
    const value=(cfg.buttons||[]).map(b=>`${b.roleId}=${b.label}`).join(', ');
    const modal=new ModalBuilder().setCustomId('buttonroles_buttons_modal').setTitle('Edit Role Buttons').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('buttons').setLabel('role ID=label, separated by commas').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(value.slice(0,4000)))
    );
    return interaction.showModal(modal);
  }
  if (id === 'buttonroles_cfg:post') {
    try { await postButtonRolePanel(interaction.guild, db.getConfig(interaction.guildId).buttonRoles); return interaction.reply({embeds:[ui.okEmbed('Button Role Panel Posted','The current panel configuration was posted/refreshed.')],ephemeral:true}); }
    catch(e) { return interaction.reply({embeds:[ui.errorEmbed('Cannot Post Panel',e.message)],ephemeral:true}); }
  }
  if (id === 'automod_cfg:words') {
    const cfg=db.getConfig(interaction.guildId).automod;
    return interaction.showModal(new ModalBuilder().setCustomId('automod_words_modal').setTitle('AutoMod Bad Words').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('words').setLabel('Comma-separated custom words').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue((cfg.badWords||[]).join(', ').slice(0,4000)))));
  }
  if (id === 'automod_cfg:caps') {
    const cfg=db.getConfig(interaction.guildId).automod;
    return interaction.showModal(new ModalBuilder().setCustomId('automod_caps_modal').setTitle('Caps Threshold').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('threshold').setLabel('Percentage, 1-100').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.capsThreshold||70)))));
  }
  if (id === 'reactionroles_cfg:message') {
    return interaction.showModal(new ModalBuilder().setCustomId('reactionroles_message_modal').setTitle('Reaction Role Message').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel('Message ID').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('123456789012345678'))));
  }
  if (id === 'reactionroles_cfg:mappings') {
    const cfg=db.getConfig(interaction.guildId).reactionRoles;
    const value=(cfg.mappings||[]).map(x=>`${x.emoji}=${x.roleId}`).join(', ');
    return interaction.showModal(new ModalBuilder().setCustomId('reactionroles_mappings_modal').setTitle('Edit Reaction Roles').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mappings').setLabel('emoji=role ID, comma separated').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(value.slice(0,4000)))));
  }
  if (id === 'reactionroles_cfg:toggle') {
    const cfg=db.saveConfig(interaction.guildId,{reactionRoles:{enabled:!db.getConfig(interaction.guildId).reactionRoles.enabled}}).reactionRoles;
    return interaction.update({embeds:[ui.reactionRoleSetupEmbed(cfg)],components:ui.reactionRoleSetupRows(cfg)});
  }

  if (id === 'birthday_cfg:message') {
    return interaction.showModal(new ModalBuilder().setCustomId('birthday_cfg_modal').setTitle('Birthday Wish Message').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel('Wish message ({user}, {date})').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(db.getConfig(interaction.guildId).birthdays.wishMessage.slice(0,400)))));
  }
  if (id === 'birthday_cfg:post') {
    const cfg=db.getConfig(interaction.guildId).birthdays; const ch=cfg.panelChannelId?interaction.guild.channels.cache.get(cfg.panelChannelId):null;
    if(!ch?.isTextBased()) return interaction.reply({embeds:[ui.errorEmbed('Panel Channel Missing','Select a panel channel first.')],ephemeral:true});
    const row=new ActionRowBuilder().addComponents(new (require('discord.js').ButtonBuilder)().setCustomId('birthday_set').setLabel('Set Birthday').setStyle(require('discord.js').ButtonStyle.Primary));
    await ch.send({embeds:[ui.birthdaySetupEmbed(cfg)],components:[row]});
    return interaction.reply({embeds:[ui.okEmbed('Birthday Panel Posted',`Posted in ${ch}.`)],ephemeral:true});
  }
  if (id === 'antibadword_cfg:words') return interaction.showModal(new ModalBuilder().setCustomId('antibadword_cfg_modal').setTitle('Custom Bad Words').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('words').setLabel('Words/phrases separated by commas').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue((db.getConfig(interaction.guildId).antibadword.customWords||[]).join(', ').slice(0,400)))));
  if (id === 'antibadword_cfg:toggle') { const cfg=db.getConfig(interaction.guildId).antibadword; const next=db.saveConfig(interaction.guildId,{antibadword:{enabled:!cfg.enabled}}).antibadword; return interaction.update({embeds:[ui.antiBadwordSetupEmbed(next)],components:ui.antiBadwordSetupRow(next)}); }
  if (id === 'honeypot_cfg:invite') { const cfg=db.getConfig(interaction.guildId).honeypot; const next=db.saveConfig(interaction.guildId,{honeypot:{createInvite:!cfg.createInvite}}).honeypot; return interaction.update({embeds:[ui.honeypotSetupEmbed(next)],components:ui.honeypotSetupRow(next)}); }
  if (id === 'honeypot_cfg:dm') return interaction.showModal(new ModalBuilder().setCustomId('honeypot_cfg_dm_modal').setTitle('Honeypot Kick DM').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel('DM text; use {invite}').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(db.getConfig(interaction.guildId).honeypot.dmMessage.slice(0,400)))));
  if (id === 'greetvoice_cfg:prompt') return interaction.showModal(new ModalBuilder().setCustomId('greetvoice_cfg_prompt_modal').setTitle('Greet Voice TTS').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('prompt').setLabel('Text spoken in the voice channel').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue((db.getConfig(interaction.guildId).greetvoice.ttsPrompt||'Welcome!').slice(0,400)))));
  if (id === 'greetvoice_cfg:audio') {
    if(!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
    return startSetupMediaUpload(interaction,{mediaType:'audio',label:'the Greet Voice audio greeting',apply:async attachment=>{
      const cfg=db.getConfig(interaction.guildId).greetvoice;
      const old=cfg.audioPath;
      const saved=await sys.saveGreetvoiceAudio(interaction.guildId,attachment);
      db.saveConfig(interaction.guildId,{greetvoice:{audioPath:saved,mode:'audio'}});
      if(old && old!==saved) await sys.removeGreetvoiceAudio(old);
    },render:()=>{const cfg=db.getConfig(interaction.guildId).greetvoice;return {embeds:[ui.greetVoiceSetupEmbed(cfg)],components:ui.greetVoiceSetupRow(cfg)};}});
  }
  if (id === 'greetvoice_cfg:remove_audio') {
    const cfg=db.getConfig(interaction.guildId).greetvoice;
    if(cfg.audioPath) await sys.removeGreetvoiceAudio(cfg.audioPath);
    const next=db.saveConfig(interaction.guildId,{greetvoice:{audioPath:null,mode:'tts'}}).greetvoice;
    return interaction.update({embeds:[ui.greetVoiceSetupEmbed(next)],components:ui.greetVoiceSetupRow(next)});
  }
  if (id === 'greetvoice_cfg:mode') {
    const cfg=db.getConfig(interaction.guildId).greetvoice;
    if(!cfg.audioPath && !cfg.ttsPrompt) return interaction.reply({embeds:[ui.errorEmbed('Nothing To Play','Set a TTS prompt or upload an audio file first.')],ephemeral:true});
    const nextMode=cfg.mode==='audio' ? 'tts' : 'audio';
    if(nextMode==='audio' && !cfg.audioPath) return interaction.reply({embeds:[ui.errorEmbed('No Audio','Upload an audio greeting first, then switch the mode to Audio.')],ephemeral:true});
    if(nextMode==='tts' && !cfg.ttsPrompt) return interaction.reply({embeds:[ui.errorEmbed('No TTS Prompt','Set a TTS prompt first, then switch the mode to TTS.')],ephemeral:true});
    const next=db.saveConfig(interaction.guildId,{greetvoice:{mode:nextMode}}).greetvoice;
    return interaction.update({embeds:[ui.greetVoiceSetupEmbed(next)],components:ui.greetVoiceSetupRow(next)});
  }
  if (id === 'greetvoice_cfg:test') {
    const cfg=db.getConfig(interaction.guildId).greetvoice;
    if(!cfg.vcId||(!cfg.ttsPrompt&&!cfg.audioPath)) return interaction.reply({embeds:[ui.errorEmbed('Not Configured','Select a voice channel and set a TTS prompt or upload an audio greeting first.')],ephemeral:true});
    await interaction.deferReply({ephemeral:true});
    try { await sys.playGreetvoiceGreeting(interaction.guild,cfg); return interaction.editReply({embeds:[ui.okEmbed('Greet Voice Test Complete','The configured greeting finished playing.')]}); }
    catch(e) { return interaction.editReply({embeds:[ui.errorEmbed('Greet Voice Failed',String(e.message||e))]}); }
  }

  // ---- Auto Responder setup panel ----
  if (id === 'autoresponder_cfg:toggle') { if(!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true}); const cfg=db.getConfig(interaction.guildId).autoresponder; const next=db.saveConfig(interaction.guildId,{autoresponder:{enabled:!cfg.enabled}}).autoresponder; return interaction.update({embeds:[ui.autoresponderSetupEmbed(next)],components:ui.autoresponderSetupRow(next)}); }
  if (id === 'autoresponder_cfg:case') { if(!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true}); const cfg=db.getConfig(interaction.guildId).autoresponder; const next=db.saveConfig(interaction.guildId,{autoresponder:{ignoreCase:!cfg.ignoreCase}}).autoresponder; return interaction.update({embeds:[ui.autoresponderSetupEmbed(next)],components:ui.autoresponderSetupRow(next)}); }
  if (id === 'autoresponder_cfg:add') {
    if(!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
    const modal=new ModalBuilder().setCustomId('autoresponder_add_modal').setTitle('Add Auto Responder Trigger');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('match').setLabel('Trigger phrase').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mode').setLabel('Mode: exact or contains').setStyle(TextInputStyle.Short).setValue('contains').setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('response').setLabel('Response ({user}, {server})').setStyle(TextInputStyle.Paragraph).setRequired(true))
    );
    return interaction.showModal(modal);
  }

  // ---- Auto Reactor setup panel ----
  if (id === 'autoreactor_cfg:toggle') { if(!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true}); const cfg=db.getConfig(interaction.guildId).autoreactor; const next=db.saveConfig(interaction.guildId,{autoreactor:{enabled:!cfg.enabled}}).autoreactor; return interaction.update({embeds:[ui.autoreactorSetupEmbed(next)],components:ui.autoreactorSetupRow(next)}); }
  if (id === 'autoreactor_cfg:case') { if(!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true}); const cfg=db.getConfig(interaction.guildId).autoreactor; const next=db.saveConfig(interaction.guildId,{autoreactor:{ignoreCase:!cfg.ignoreCase}}).autoreactor; return interaction.update({embeds:[ui.autoreactorSetupEmbed(next)],components:ui.autoreactorSetupRow(next)}); }
  if (id === 'autoreactor_cfg:add') {
    if(!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','Administrator required.')],ephemeral:true});
    const modal=new ModalBuilder().setCustomId('autoreactor_add_modal').setTitle('Add Auto Reactor Trigger');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('match').setLabel('Trigger phrase').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mode').setLabel('Mode: exact or contains').setStyle(TextInputStyle.Short).setValue('contains').setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emojis').setLabel('Emojis, space separated (max 5)').setStyle(TextInputStyle.Short).setRequired(true))
    );
    return interaction.showModal(modal);
  }

  // ---- Embed builder ----
  if (id === 'embedbuilder:text') {
    const draft = sys.embedBuilderSessions.get(interaction.user.id) || { title:'', description:'', color:'', footer:'' };
    const modal=new ModalBuilder().setCustomId('embedbuilder_text_modal').setTitle('Edit Embed Text');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(false).setValue((draft.title||'').slice(0,200))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue((draft.description||'').slice(0,3000))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Color hex, e.g. #5865F2').setStyle(TextInputStyle.Short).setRequired(false).setValue((draft.color||'').slice(0,10))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('footer').setLabel('Footer text').setStyle(TextInputStyle.Short).setRequired(false).setValue((draft.footer||'').slice(0,200)))
    );
    return interaction.showModal(modal);
  }
  if (id === 'embedbuilder:image') {
    const draft = sys.embedBuilderSessions.get(interaction.user.id) || { imageUrl:'', thumbnailUrl:'' };
    const modal=new ModalBuilder().setCustomId('embedbuilder_image_modal').setTitle('Edit Embed Images');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('imageUrl').setLabel('Large image URL').setStyle(TextInputStyle.Short).setRequired(false).setValue((draft.imageUrl||'').slice(0,500))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('thumbnailUrl').setLabel('Thumbnail URL').setStyle(TextInputStyle.Short).setRequired(false).setValue((draft.thumbnailUrl||'').slice(0,500)))
    );
    return interaction.showModal(modal);
  }
  if (id === 'embedbuilder:save') {
    const draft=sys.embedBuilderSessions.get(interaction.user.id);
    if(!draft) return interaction.reply({embeds:[ui.errorEmbed('Session Expired','Run `/embedbuilder` again to start a fresh draft.')],ephemeral:true});
    const modal=new ModalBuilder().setCustomId('embedbuilder_save_modal').setTitle('Save Embed');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Embed name').setStyle(TextInputStyle.Short).setPlaceholder('e.g. rules, welcome, ticket-info').setRequired(true).setMaxLength(40)));
    return interaction.showModal(modal);
  }

  if (id === 'embedbuilder:addbutton') {
    const draft = sys.embedBuilderSessions.get(interaction.user.id);
    if (!draft) return interaction.reply({embeds:[ui.errorEmbed('Session Expired','Run `/embedbuilder` again to start a fresh draft.')],ephemeral:true});
    if ((draft.buttons||[]).length >= 5) return interaction.reply({embeds:[ui.errorEmbed('Button Limit','A single row supports at most 5 buttons.')],ephemeral:true});
    const modal=new ModalBuilder().setCustomId('embedbuilder_button_modal').setTitle('Add Response Button');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('label').setLabel('Button label').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('responseTitle').setLabel('Private response title').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('responseText').setLabel('Private response text').setStyle(TextInputStyle.Paragraph).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('responseColor').setLabel('Response color (optional, e.g. #5865F2)').setStyle(TextInputStyle.Short).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emoji').setLabel('Emoji (optional)').setStyle(TextInputStyle.Short).setRequired(false))
    );
    return interaction.showModal(modal);
  }
  if (id === 'embedbuilder:post') {
    const draft = sys.embedBuilderSessions.get(interaction.user.id);
    if (!draft) return interaction.reply({embeds:[ui.errorEmbed('Session Expired','Run `/embedbuilder` again to start a fresh draft.')],ephemeral:true});
    return interaction.reply({content:'Select the channel to post this embed in.',components:[new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('embedbuilder:post_channel').setPlaceholder('Select a channel').setChannelTypes(ChannelType.GuildText))],ephemeral:true});
  }

  if (id.startsWith('rolebtn:')) {
    const parts=id.split(':');
    const panelId=parts.length>=3?parts[1]:null;
    const roleId=parts.length>=3?parts[2]:parts[1];
    const cfg=db.getConfig(interaction.guildId);
    const panel=panelId ? getPanel(interaction.guildId,'button',panelId) : null;
    if(panel && panel.enabled===false) return interaction.reply({embeds:[ui.errorEmbed('Panel Disabled','This role panel is currently disabled.')],ephemeral:true});
    const role=interaction.guild.roles.cache.get(roleId);
    if(!role) return interaction.reply({embeds:[ui.errorEmbed('Role Missing','That role no longer exists.')],ephemeral:true});
    if(role.id===interaction.guild.id) return interaction.reply({embeds:[ui.errorEmbed('Invalid Role','@everyone cannot be assigned.')],ephemeral:true});
    const bot=interaction.guild.members.me;
    if(!bot || role.position>=bot.roles.highest.position) return interaction.reply({embeds:[ui.errorEmbed('Role Hierarchy',`I cannot manage **${role.name}** because it is equal to or higher than my highest role.`)],ephemeral:true});
    const member=interaction.member;
    try {
      if(member.roles.cache.has(role.id)){ await member.roles.remove(role); return interaction.reply({embeds:[ui.okEmbed('Role Removed',`${role} removed from you.`)],ephemeral:true}); }
      await member.roles.add(role); return interaction.reply({embeds:[ui.okEmbed('Role Added',`${role} added to you.`)],ephemeral:true});
    } catch(e) {
      return interaction.reply({embeds:[ui.errorEmbed('Role Update Failed',`${e?.message || 'Discord rejected the role change.'}${e?.code?`\n**Discord code:** \`${e.code}\``:''}`)],ephemeral:true});
    }
  }
  if (id.startsWith('role_select:') || id==='role_select') {
    const panelId=id.includes(':')?id.split(':')[1]:null;
    const roleId=interaction.values[0]; const role=interaction.guild.roles.cache.get(roleId);
    if(!role) return interaction.reply({embeds:[ui.errorEmbed('Role Missing','That role no longer exists.')],ephemeral:true});
    const panel=panelId?getPanel(interaction.guildId,'button',panelId):null;
    if(panel && panel.enabled===false) return interaction.reply({embeds:[ui.errorEmbed('Panel Disabled','This role panel is currently disabled.')],ephemeral:true});
    const bot=interaction.guild.members.me;
    if(!bot || role.position>=bot.roles.highest.position) return interaction.reply({embeds:[ui.errorEmbed('Role Hierarchy',`I cannot manage **${role.name}** because it is equal to or higher than my highest role.`)],ephemeral:true});
    try {
      if(interaction.member.roles.cache.has(role.id)) await interaction.member.roles.remove(role); else await interaction.member.roles.add(role);
      return interaction.reply({embeds:[ui.okEmbed('Role Updated',`${role} has been toggled.`)],ephemeral:true});
    } catch(e) {
      return interaction.reply({embeds:[ui.errorEmbed('Role Update Failed',`${e?.message || 'Discord rejected the role change.'}${e?.code?`\n**Discord code:** \`${e.code}\``:''}`)],ephemeral:true});
    }
  }
  if (id==='staffapp_apply') {
    const cfg=db.getConfig(interaction.guildId).staffApplications;
    if(!cfg.enabled || !cfg.questions?.length) return interaction.reply({embeds:[ui.errorEmbed('Unavailable','Applications are not configured yet.')],ephemeral:true});
    if(applicationSessions.has(interaction.user.id)) return interaction.reply({embeds:[ui.warnEmbed('Application In Progress','You already have an application in progress in your DMs.')],ephemeral:true});
    applicationSessions.set(interaction.user.id,{guildId:interaction.guildId,index:0,answers:[],waiting:false});
    const dm=await interaction.user.createDM();
    await dm.send({embeds:[ui.base(cfg.staffApplications.title).setDescription(cfg.staffApplications.dmIntro)],components:[new ActionRowBuilder().addComponents(
      new (require('discord.js').ButtonBuilder)().setCustomId('staffapp_ready').setLabel('Ready').setStyle(require('discord.js').ButtonStyle.Success),
      new (require('discord.js').ButtonBuilder)().setCustomId('staffapp_notready').setLabel('Not Ready').setStyle(require('discord.js').ButtonStyle.Secondary)
    )]});
    return interaction.reply({embeds:[ui.okEmbed('Check your DMs','I sent you the application start message.')],ephemeral:true});
  }
  if(id==='staffapp_ready') {
    const session=applicationSessions.get(interaction.user.id); if(!session) return interaction.reply({embeds:[ui.errorEmbed('No Application','Press Apply in the server first.')],ephemeral:true});
    const cfg=db.getConfig(session.guildId).staffApplications; session.waiting=true; session.index=0;
    await interaction.update({embeds:[ui.okEmbed('Application Started','Answer each question in this DM. I will send the next one after every answer.')],components:[]});
    return interaction.followUp({content:`**Question 1/${cfg.questions.length}:**\n${cfg.questions[0]}`});
  }
  if(id==='staffapp_notready') { applicationSessions.delete(interaction.user.id); return interaction.update({embeds:[ui.warnEmbed('Not Started','No application was started. You can press Apply again when ready.')],components:[]}); }
  if(id.startsWith('staffapp_decide:')) {
    if(!interaction.guild || !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','You need Manage Server to review applications.')],ephemeral:true});
    const [,decision,userId]=id.split(':');
    const modal=new ModalBuilder().setCustomId(`staffapp_reason:${decision}:${userId}`).setTitle(decision==='accept'?'Accept Application':'Reject Application');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false)));
    return interaction.showModal(modal);
  }
  if(id==='birthday_set') {
    const modal=new ModalBuilder().setCustomId('birthday_modal').setTitle('Set Birthday');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel('Birthday (DD-MM or D-M)').setPlaceholder('8-8').setStyle(TextInputStyle.Short).setRequired(true)));
    return interaction.showModal(modal);
  }

  // ---- Tickets ----
  if (id === 'ticket_open') {
    const cfg = db.getConfig(interaction.guildId).ticket;
    if (!cfg.enabled) return interaction.reply({ embeds: [ui.errorEmbed('Tickets Disabled', 'Ask an admin to run `/tickets setup`.')], ephemeral: true });
    const openTickets = db.openTicketsForUser(interaction.guildId, interaction.user.id);
    for (const existing of openTickets) {
      const existingChannel = interaction.guild.channels.cache.get(existing.channelId);
      if (existingChannel) {
        return interaction.reply({ embeds: [ui.warnEmbed('Ticket Exists', `You already have an open ticket: <#${existing.channelId}>`)], ephemeral: true });
      }
      // The channel was deleted, but the old DB row remained open. Repair every stale row.
      db.closeTicket(existing.channelId);
    }

    const overwrites = [
      { id: interaction.guild.roles.everyone, deny: ['ViewChannel'] },
      { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] },
      { id: client.user.id, allow: ['ViewChannel', 'SendMessages', 'ManageChannels'] }
    ];
    if (cfg.supportRoleId) overwrites.push({ id: cfg.supportRoleId, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] });

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
    if (!ticket) return interaction.reply({ embeds: [ui.errorEmbed('Not a Ticket', 'This only works inside a ticket channel.')], ephemeral: true });
    const ticketCfg = db.getConfig(interaction.guildId).ticket;
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    const hasRole = ticketCfg.supportRoleId && interaction.member.roles.cache.has(ticketCfg.supportRoleId);
    if (!isAdmin && !hasRole) return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need the support role or Administrator.')], ephemeral: true });
    return interaction.reply({ embeds: [ui.staffControlsEmbed(ticket)], components: ui.staffControlsRow(!!ticket.claimedBy), ephemeral: true });
  }
  if (id === 'staff_claim' || id === 'staff_unclaim') {
    const ticket = db.getTicket(interaction.channel.id);
    if (!ticket) return interaction.reply({ embeds: [ui.errorEmbed('Not a Ticket', 'This only works inside a ticket channel.')], ephemeral: true });
    const claiming = !ticket.claimedBy;
    db.setTicketStatus(interaction.channel.id, ticket.status, claiming ? interaction.user.id : null);
    // "unclaim" clears claimedBy explicitly since setTicketStatus's COALESCE won't null it out.
    if (!claiming) db.db.prepare('UPDATE tickets SET claimedBy = NULL WHERE channelId = ?').run(interaction.channel.id);
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
      if (log) log.send({ embeds: [ui.base('🗑️ Ticket Deleted').setDescription(`Ticket by <@${ticket?.userId}> deleted by ${interaction.user}.`)] }).catch(() => {});
    }
    setTimeout(() => interaction.channel.delete().catch(() => {}), 1500);
    return;
  }
  if (id === 'ticket_close') {
    const ticket = db.getTicket(interaction.channel.id);
    db.setTicketStatus(interaction.channel.id, 'closed');
    await interaction.reply({ embeds: [ui.warnEmbed('🔒 Closing Ticket', 'This channel will be deleted in 5 seconds.')] });
    const cfg = db.getConfig(interaction.guildId).ticket;
    if (cfg.logChannelId) {
      const log = interaction.guild.channels.cache.get(cfg.logChannelId);
      if (log) log.send({ embeds: [ui.base('🎫 Ticket Closed').setDescription(`Ticket by <@${ticket?.userId}> closed by ${interaction.user}.`)] }).catch(() => {});
    }
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    return;
  }

  // ---- Voicemaster: dedicated setup panel (admin-only, from /voicemaster setup) ----
  if (id === 'vm_setup_category' || id === 'vm_setup_channel' || id === 'vm_setup_toggle') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to use this.')], ephemeral: true });
    }
    if (id === 'vm_setup_category') return interaction.reply({ embeds: [ui.vmCategoryPromptEmbed()], components: [ui.vmCategorySelectRow()], ephemeral: true });
    if (id === 'vm_setup_channel') return interaction.reply({ embeds: [ui.vmChannelPromptEmbed()], components: [ui.vmChannelSelectRow()], ephemeral: true });
    // toggle
    const current = db.getConfig(interaction.guildId).voicemaster.enabled;
    const cfg = db.saveConfig(interaction.guildId, { voicemaster: { enabled: !current } });
    return interaction.update({ embeds: [ui.vmSetupEmbed(cfg)], components: [ui.vmSetupRow(cfg)] });
  }

  // ---- Voicemaster: per-channel owner controls (Lock/Hide/Rename/Limit/Kick/Transfer) ----
  if (id.startsWith('vm_')) {
    const vc = interaction.member.voice.channel;
    if (!vc || !db.getVMChannel(vc.id)) return interaction.reply({ embeds: [ui.errorEmbed('No Channel', 'Join a voicemaster channel first.')], ephemeral: true });
    const record = db.getVMChannel(vc.id);
    if (record.ownerId !== interaction.user.id) return interaction.reply({ embeds: [ui.errorEmbed('Not Owner', 'Only the channel owner can do that.')], ephemeral: true });

    const everyone = interaction.guild.roles.everyone;
    const overwrite = vc.permissionOverwrites.cache.get(everyone.id);

    if (id === 'vm_togglelock') {
      const locked = !!(overwrite && overwrite.deny.has(PermissionFlagsBits.Connect));
      await vc.permissionOverwrites.edit(everyone, { Connect: locked ? null : false });
      await interaction.update({ embeds: [ui.vmControlEmbed(interaction.user)], components: ui.vmControlRows(vc, { locked: !locked }) });
      return interaction.followUp({
        embeds: [ui.okEmbed(locked ? '🔓 Unlocked' : '🔒 Locked', locked ? 'Anyone can join the channel again.' : 'Only allowed members can join now.')],
        ephemeral: true
      });
    }
    if (id === 'vm_togglehide') {
      const hidden = !!(overwrite && overwrite.deny.has(PermissionFlagsBits.ViewChannel));
      await vc.permissionOverwrites.edit(everyone, { ViewChannel: hidden ? null : false });
      await interaction.update({ embeds: [ui.vmControlEmbed(interaction.user)], components: ui.vmControlRows(vc, { hidden: !hidden }) });
      return interaction.followUp({
        embeds: [ui.okEmbed(hidden ? '👁️ Visible' : '🙈 Hidden', hidden ? 'Channel is visible again.' : 'Channel is now hidden from everyone else.')],
        ephemeral: true
      });
    }
    if (id === 'vm_kick') {
      const others = vc.members.filter(m => m.id !== interaction.user.id);
      if (!others.size) return interaction.reply({ embeds: [ui.vmKickNobodyEmbed()], ephemeral: true });
      return interaction.reply({ embeds: [ui.vmKickPromptEmbed()], components: [ui.vmKickSelectRow([...others.values()])], ephemeral: true });
    }
    if (id === 'vm_rename' || id === 'vm_limit' || id === 'vm_transfer') return openVMModal(interaction, id);
  }

  // ---- Setup panel (toggle / edit) ----
  if (id.startsWith('setup_toggle:') || id.startsWith('setup_edit:')) {
    const [action, sub] = id.split(':');
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to use this.')], ephemeral: true });
    }
    if (action === 'setup_edit') return openSetupModal(interaction, sub);

    const moduleKey = ui.SETUP_MODULE_META[sub].cfgKey;
    const enabled = !db.getConfig(interaction.guildId)[moduleKey].enabled;
    const cfg = db.saveConfig(interaction.guildId, { [moduleKey]: { enabled } });
    return interaction.update({ embeds: [ui.setupPanelEmbed(sub, cfg)], components: [ui.setupPanelRow(sub, cfg)] });
  }
}

async function handleVMKickPick(interaction) {
  const vc = interaction.member.voice.channel;
  if (!vc || !db.getVMChannel(vc.id)) return interaction.update({ embeds: [ui.errorEmbed('No Channel', 'You left the voice channel.')], components: [] });
  const record = db.getVMChannel(vc.id);
  if (record.ownerId !== interaction.user.id) return interaction.update({ embeds: [ui.errorEmbed('Not Owner', 'Only the channel owner can do that.')], components: [] });

  const targetId = interaction.values[0];
  const member = vc.members.get(targetId);
  if (!member) return interaction.update({ embeds: [ui.vmKickGoneEmbed(targetId)], components: [] });

  await member.voice.disconnect('Removed by channel owner').catch(() => {});
  return interaction.update({ embeds: [ui.vmKickedEmbed(member.user.tag)], components: [] });
}

// Handles the UserSelectMenu opened by the Staff Controls "Add Member" / "Remove Member"
// buttons — grants or revokes that member's view/send access on the ticket channel.
async function handleTicketMemberSelect(interaction, action) {
  const ticket = db.getTicket(interaction.channel.id);
  if (!ticket) return interaction.update({ embeds: [ui.errorEmbed('Not a Ticket', 'This only works inside a ticket channel.')], components: [] });
  const userId = interaction.values[0];
  if (action === 'add') {
    await interaction.channel.permissionOverwrites.edit(userId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
    return interaction.update({ embeds: [ui.okEmbed('➕ Member Added', `<@${userId}> can now see this ticket.`)], components: [] });
  }
  await interaction.channel.permissionOverwrites.delete(userId).catch(() => {});
  return interaction.update({ embeds: [ui.okEmbed('➖ Member Removed', `<@${userId}> can no longer see this ticket.`)], components: [] });
}

// Field spec for each panel module's "Edit Settings" modal. `oKey` matches the flat key
// buildModulePatch() (in commands.js) expects; `parse` turns the raw text field into that
// shape (IDs are stored as plain strings, buildModulePatch only ever needs `.id`).
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
    if (current) input.setValue(String(current).slice(0, 100));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return interaction.showModal(modal);
}

async function openVMModal(interaction, id) {
  const fieldMap = {
    vm_rename: { title: 'Rename Channel', label: 'New name', id: 'value' },
    vm_limit: { title: 'Set User Limit', label: 'Limit (0 = unlimited)', id: 'value' },
    vm_transfer: { title: 'Transfer Ownership', label: 'User ID to transfer to', id: 'value' }
  };
  const f = fieldMap[id];
  const modal = new ModalBuilder().setCustomId(id).setTitle(f.title).addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(f.id).setLabel(f.label).setStyle(TextInputStyle.Short).setRequired(true))
  );
  return interaction.showModal(modal);
}

async function handleModal(interaction) {
  if (interaction.customId.startsWith('statsetup:configure:')) {
    if (!statAdmin(interaction)) return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
    const parts = interaction.customId.split(':');
    const category = parts[2] || 'server';
    const selected = parts.slice(3).join(':');
    const patch = { enabled: true, refreshSeconds: Math.max(60, Math.min(86400, parseInt(interaction.fields.getTextInputValue('refresh'), 10) || 300)) };
    if (category === 'custom') {
      patch.name = interaction.fields.getTextInputValue('name').trim().slice(0, 60) || 'Custom Stat';
      patch.value = interaction.fields.getTextInputValue('value').trim().slice(0, 100) || '0';
      patch.template = interaction.fields.getTextInputValue('template').trim().slice(0, 100) || '{value}';
    } else {
      patch.template = interaction.fields.getTextInputValue('template').trim().slice(0, 100) || stats.getDefaultTemplate(category, selected);
      if (category === 'social') patch.source = interaction.fields.getTextInputValue('source').trim().slice(0, 200);
    }
    if (category === 'social' && !patch.source) return interaction.reply({ embeds: [ui.errorEmbed('Source Required', 'Enter the account/source to track.')], ephemeral: true });
    try {
      await stats.configure(interaction.guildId, category, selected, patch);
      await stats.refreshGuild(interaction.guild);
      return interaction.reply(statPanelPayload(interaction.guildId, category, selected));
    } catch (error) {
      return interaction.reply({ embeds: [ui.errorEmbed('Stat Save Failed', String(error.message || error))], ephemeral: true });
    }
  }
  if (interaction.customId === 'statsetup:addcustom_modal') {
    if (!statAdmin(interaction)) return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'Administrator required.')], ephemeral: true });
    const custom = stats.createCustom(interaction.guildId, {
      name: interaction.fields.getTextInputValue('name').trim(),
      value: interaction.fields.getTextInputValue('value').trim(),
      template: interaction.fields.getTextInputValue('template').trim(),
      refreshSeconds: parseInt(interaction.fields.getTextInputValue('refresh'), 10) || 300
    });
    await stats.refreshGuild(interaction.guild);
    return interaction.reply(statPanelPayload(interaction.guildId, 'custom', custom.id));
  }
  if (interaction.customId.startsWith('buttonroles_panel_modal:')) {
    const panelId=interaction.customId.split(':')[1], panel=getPanel(interaction.guildId,'button',panelId);
    if(!panel) return interaction.reply({embeds:[ui.errorEmbed('Panel Not Found','That panel no longer exists.')],ephemeral:true});
    const title=interaction.fields.getTextInputValue('title').trim() || 'Choose your roles';
    const description=interaction.fields.getTextInputValue('description').trim() || 'Press a button to get or remove a role.';
    const style=/^selection$/i.test(interaction.fields.getTextInputValue('style').trim())?'selection':'embed';
    const cfg=db.upsertPanel(interaction.guildId,'button',{...panel,title,description,embedType:style});
    return interaction.reply({embeds:[ui.buttonRoleEmbed(db.getConfig(interaction.guildId),panelId)],components:ui.buttonRoleSetupRows(db.getConfig(interaction.guildId),panelId),ephemeral:true});
  }
  if (interaction.customId.startsWith('reactionroles_panel_modal:')) {
    const panelId=interaction.customId.split(':')[1], panel=getPanel(interaction.guildId,'reaction',panelId);
    if(!panel) return interaction.reply({embeds:[ui.errorEmbed('Panel Not Found','That panel no longer exists.')],ephemeral:true});
    const title=interaction.fields.getTextInputValue('title').trim() || 'Choose your roles';
    const description=interaction.fields.getTextInputValue('description').trim() || 'React below to receive or remove a role.';
    db.upsertPanel(interaction.guildId,'reaction',{...panel,title,description});
    const cfg=db.getConfig(interaction.guildId);
    return interaction.reply({embeds:[ui.reactionRoleSetupEmbed(cfg,panelId)],components:ui.reactionRoleSetupRows(cfg,panelId),ephemeral:true});
  }
  if (interaction.customId.startsWith('reactionroles_add_modal:')) {
    const [,panelId,roleId]=interaction.customId.split(':');
    const panel=getPanel(interaction.guildId,'reaction',panelId);
    if(!panel) return interaction.reply({embeds:[ui.errorEmbed('Panel Not Found','That reaction-role panel no longer exists.')],ephemeral:true});
    const emoji=interaction.fields.getTextInputValue('emoji').trim();
    const role=interaction.guild.roles.cache.get(roleId);
    if(!role) return interaction.reply({embeds:[ui.errorEmbed('Role Not Found','That role no longer exists.')],ephemeral:true});
    db.upsertPanel(interaction.guildId,'reaction',{...panel,mappings:[...(panel.mappings||[]).filter(x=>x.roleId!==roleId),{emoji,roleId,label:(interaction.fields.getTextInputValue('label').trim()||role.name).slice(0,80)}]});
    const cfg=db.getConfig(interaction.guildId);
    return interaction.reply({embeds:[ui.reactionRoleSetupEmbed(cfg,panelId)],components:ui.reactionRoleSetupRows(cfg,panelId),ephemeral:true});
  }
  if (interaction.customId === 'buttonroles_panel_modal') {
    const title=interaction.fields.getTextInputValue('title').trim();
    const description=interaction.fields.getTextInputValue('description').trim();
    const image=interaction.fields.getTextInputValue('image').trim()||null;
    const style=/^selection$/i.test(interaction.fields.getTextInputValue('style').trim())?'selection':'embed';
    const cfg=db.saveConfig(interaction.guildId,{buttonRoles:{title,description,image,embedType:style}}).buttonRoles;
    return interaction.reply({embeds:[ui.buttonRoleEmbed(cfg)],components:ui.buttonRoleSetupRows(cfg),ephemeral:true});
  }
  if (interaction.customId === 'buttonroles_buttons_modal') {
    const raw=interaction.fields.getTextInputValue('buttons');
    const buttons=raw.split(',').map(x=>x.trim()).filter(Boolean).slice(0,25).map((entry,i)=>{
      const [roleId,...parts]=entry.split('=');
      return {roleId:roleId.replace(/[<@&>]/g,'').trim(),label:(parts.join('=')||`Role ${i+1}`).trim().slice(0,80),mode:'toggle'};
    }).filter(x=>/^\d{15,25}$/.test(x.roleId));
    if(!buttons.length)return interaction.reply({embeds:[ui.errorEmbed('No valid buttons','Use `ROLE_ID=Button Label` entries separated by commas.')],ephemeral:true});
    const cfg=db.saveConfig(interaction.guildId,{buttonRoles:{buttons}}).buttonRoles;
    return interaction.reply({embeds:[ui.buttonRoleEmbed(cfg)],components:ui.buttonRoleSetupRows(cfg),ephemeral:true});
  }
  if (interaction.customId === 'automod_words_modal') {
    const words=interaction.fields.getTextInputValue('words').split(',').map(x=>x.trim()).filter(Boolean).slice(0,300);
    const cfg=db.saveConfig(interaction.guildId,{automod:{badWords:words,badWordFilter:true}}).automod;
    return interaction.reply({embeds:[ui.automodSetupEmbed(cfg)],components:ui.automodSetupRows(cfg),ephemeral:true});
  }
  if (interaction.customId === 'automod_caps_modal') {
    const n=Math.max(1,Math.min(100,parseInt(interaction.fields.getTextInputValue('threshold'),10)||70));
    const cfg=db.saveConfig(interaction.guildId,{automod:{capsThreshold:n,capsFilter:true}}).automod;
    return interaction.reply({embeds:[ui.automodSetupEmbed(cfg)],components:ui.automodSetupRows(cfg),ephemeral:true});
  }
  if (interaction.customId === 'reactionroles_message_modal') {
    const messageId=interaction.fields.getTextInputValue('message').trim();
    if(!/^\d{15,25}$/.test(messageId)) return interaction.reply({embeds:[ui.errorEmbed('Invalid Message ID','Paste a valid Discord message ID.')],ephemeral:true});
    const cfg=db.saveConfig(interaction.guildId,{reactionRoles:{messageId}}).reactionRoles;
    return interaction.reply({embeds:[ui.reactionRoleSetupEmbed(cfg)],components:ui.reactionRoleSetupRows(cfg),ephemeral:true});
  }
  if (interaction.customId === 'reactionroles_mappings_modal') {
    const raw=interaction.fields.getTextInputValue('mappings');
    const mappings=raw.split(',').map(x=>x.trim()).filter(Boolean).map(entry=>{
      const [emoji,...parts]=entry.split('=');
      return {emoji:emoji.trim(),roleId:(parts.join('=')||'').replace(/[<@&>]/g,'').trim()};
    }).filter(x=>x.emoji && /^\d{15,25}$/.test(x.roleId)).slice(0,20);
    if(!mappings.length)return interaction.reply({embeds:[ui.errorEmbed('No valid mappings','Use `😀=ROLE_ID, 🎮=ROLE_ID` or custom emoji IDs.')],ephemeral:true});
    const cfg=db.saveConfig(interaction.guildId,{reactionRoles:{mappings}}).reactionRoles;
    if(cfg.messageId){
      const channel=interaction.guild.channels.cache.get(cfg.channelId);
      const msg=channel ? await channel.messages.fetch(cfg.messageId).catch(()=>null) : null;
      if(msg) for(const m of mappings) await msg.react(m.emoji).catch(()=>{});
    }
    return interaction.reply({embeds:[ui.reactionRoleSetupEmbed(cfg)],components:ui.reactionRoleSetupRows(cfg),ephemeral:true});
  }
  if (interaction.customId === 'birthday_cfg_modal') { const msg=interaction.fields.getTextInputValue('message').trim(); const cfg=db.saveConfig(interaction.guildId,{birthdays:{wishMessage:msg||'Happy Birthday {user}! 🎂'}}).birthdays; return interaction.reply({embeds:[ui.birthdaySetupEmbed(cfg)],components:ui.birthdaySetupRow(cfg),ephemeral:true}); }
  if (interaction.customId === 'antibadword_cfg_modal') { const words=interaction.fields.getTextInputValue('words').split(',').map(x=>x.trim()).filter(Boolean).slice(0,300); const cfg=db.saveConfig(interaction.guildId,{antibadword:{customWords:words}}).antibadword; return interaction.reply({embeds:[ui.antiBadwordSetupEmbed(cfg)],components:ui.antiBadwordSetupRow(cfg),ephemeral:true}); }
  if (interaction.customId === 'honeypot_cfg_dm_modal') { const msg=interaction.fields.getTextInputValue('message').trim(); const cfg=db.saveConfig(interaction.guildId,{honeypot:{dmMessage:msg||'You were removed. {invite}'}}).honeypot; return interaction.reply({embeds:[ui.honeypotSetupEmbed(cfg)],components:ui.honeypotSetupRow(cfg),ephemeral:true}); }
  if (interaction.customId === 'greetvoice_cfg_prompt_modal') { const prompt=interaction.fields.getTextInputValue('prompt').trim(); const cfg=db.saveConfig(interaction.guildId,{greetvoice:{ttsPrompt:prompt,mode:'tts'}}).greetvoice; return interaction.reply({embeds:[ui.greetVoiceSetupEmbed(cfg)],components:ui.greetVoiceSetupRow(cfg),ephemeral:true}); }
  if (interaction.customId === 'autoresponder_add_modal') {
    const match=interaction.fields.getTextInputValue('match').trim();
    const mode=/^exact$/i.test(interaction.fields.getTextInputValue('mode').trim())?'exact':'contains';
    const response=interaction.fields.getTextInputValue('response').trim();
    if(!match || !response) return interaction.reply({embeds:[ui.errorEmbed('Missing Info','Both a trigger phrase and a response are required.')],ephemeral:true});
    const cfg=db.getConfig(interaction.guildId).autoresponder;
    const triggers=[...(cfg.triggers||[]), { id:`${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`, match, mode, response }];
    const next=db.saveConfig(interaction.guildId,{autoresponder:{triggers}}).autoresponder;
    return interaction.reply({embeds:[ui.autoresponderSetupEmbed(next)],components:ui.autoresponderSetupRow(next),ephemeral:true});
  }
  if (interaction.customId === 'autoreactor_add_modal') {
    const match=interaction.fields.getTextInputValue('match').trim();
    const mode=/^exact$/i.test(interaction.fields.getTextInputValue('mode').trim())?'exact':'contains';
    const emojis=interaction.fields.getTextInputValue('emojis').trim().split(/\s+/).filter(Boolean).slice(0,5);
    if(!match || !emojis.length) return interaction.reply({embeds:[ui.errorEmbed('Missing Info','A trigger phrase and at least one emoji are required.')],ephemeral:true});
    const cfg=db.getConfig(interaction.guildId).autoreactor;
    const triggers=[...(cfg.triggers||[]), { id:`${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`, match, mode, emojis }];
    const next=db.saveConfig(interaction.guildId,{autoreactor:{triggers}}).autoreactor;
    return interaction.reply({embeds:[ui.autoreactorSetupEmbed(next)],components:ui.autoreactorSetupRow(next),ephemeral:true});
  }
  if (interaction.customId === 'embedbuilder_text_modal') {
    const draft=sys.embedBuilderSessions.get(interaction.user.id) || { buttons: [] };
    draft.title=interaction.fields.getTextInputValue('title').trim();
    draft.description=interaction.fields.getTextInputValue('description').trim();
    draft.color=interaction.fields.getTextInputValue('color').trim();
    draft.footer=interaction.fields.getTextInputValue('footer').trim();
    sys.embedBuilderSessions.set(interaction.user.id, draft);
    return interaction.reply({embeds:[ui.embedBuilderPreviewEmbed(draft)],components:ui.embedBuilderRow(draft),ephemeral:true});
  }
  if (interaction.customId === 'embedbuilder_image_modal') {
    const draft=sys.embedBuilderSessions.get(interaction.user.id) || { buttons: [] };
    draft.imageUrl=interaction.fields.getTextInputValue('imageUrl').trim();
    draft.thumbnailUrl=interaction.fields.getTextInputValue('thumbnailUrl').trim();
    sys.embedBuilderSessions.set(interaction.user.id, draft);
    return interaction.reply({embeds:[ui.embedBuilderPreviewEmbed(draft)],components:ui.embedBuilderRow(draft),ephemeral:true});
  }
  if (interaction.customId === 'embedbuilder_button_modal') {
    const draft=sys.embedBuilderSessions.get(interaction.user.id);
    if(!draft) return interaction.reply({embeds:[ui.errorEmbed('Session Expired','Run `/embedbuilder` again to start a fresh draft.')],ephemeral:true});
    const label=interaction.fields.getTextInputValue('label').trim();
    const responseTitle=interaction.fields.getTextInputValue('responseTitle').trim();
    const responseText=interaction.fields.getTextInputValue('responseText').trim();
    const responseColor=interaction.fields.getTextInputValue('responseColor').trim();
    const btnEmoji=interaction.fields.getTextInputValue('emoji').trim();
    if(!label || !responseTitle || !responseText) return interaction.reply({embeds:[ui.errorEmbed('Missing Button Info','Label, response title and response text are required.')],ephemeral:true});
    draft.buttons=[...(draft.buttons||[]), { id:`b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`, label, emoji: btnEmoji || null, response:{title:responseTitle,description:responseText,color:responseColor||null} }];
    return interaction.reply({embeds:[ui.embedBuilderPreviewEmbed(draft)],components:ui.embedBuilderRow(draft),ephemeral:true});
  }
  if (interaction.customId === 'embedbuilder_save_modal') {
    const draft=sys.embedBuilderSessions.get(interaction.user.id);
    if(!draft) return interaction.reply({embeds:[ui.errorEmbed('Session Expired','Run `/embedbuilder` again to start a fresh draft.')],ephemeral:true});
    const name=interaction.fields.getTextInputValue('name').trim();
    if(!/^[a-zA-Z0-9 _-]{1,40}$/.test(name)) return interaction.reply({embeds:[ui.errorEmbed('Invalid Name','Use 1-40 letters, numbers, spaces, `_` or `-`.')],ephemeral:true});
    db.saveEmbed(interaction.guildId,name,{embed:ui.embedBuilderPreviewEmbed(draft).toJSON(),buttons:draft.buttons||[]});
    return interaction.reply({embeds:[ui.okEmbed('💾 Embed Saved',`Saved **${name}**. Use **/embed load ${name}** to send it later.`)],ephemeral:true});
  }

  if (interaction.customId === 'birthday_modal') {
    const raw=interaction.fields.getTextInputValue('date').trim().replace(/\s+/g,'');
    const m=raw.match(/^(\d{1,2})[-\/.](\d{1,2})$/); if(!m) return interaction.reply({embeds:[ui.errorEmbed('Invalid Date','Use a format like `8-8` or `1-9`.')],ephemeral:true});
    const day=Number(m[1]), month=Number(m[2]);
    const d=new Date(Date.UTC(2000,month-1,day)); if(d.getUTCMonth()+1!==month || d.getUTCDate()!==day) return interaction.reply({embeds:[ui.errorEmbed('Invalid Date','That date is not valid.')],ephemeral:true});
    const cfg=db.getConfig(interaction.guildId); db.saveConfig(interaction.guildId,{birthdays:{entries:{...(cfg.birthdays.entries||{}),[interaction.user.id]:`${month}-${day}`}}});
    return interaction.reply({embeds:[ui.okEmbed('🎂 Birthday Saved',`Your birthday is set to **${day}-${month}**.`)],ephemeral:true});
  }
  if (interaction.customId.startsWith('staffapp_reason:')) {
    if(!interaction.guild || !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({embeds:[ui.errorEmbed('Missing Permissions','You need Manage Server.')],ephemeral:true});
    const [,decision,userId]=interaction.customId.split(':'); const reason=interaction.fields.getTextInputValue('reason').trim()||'No reason provided.';
    const user=await client.users.fetch(userId).catch(()=>null); if(!user) return interaction.reply({embeds:[ui.errorEmbed('User Not Found','Could not DM the applicant.')],ephemeral:true});
    await user.send({embeds:[decision==='accept'?ui.okEmbed('Application Accepted',reason):ui.errorEmbed('Application Rejected',reason)]}).catch(()=>{});
    return interaction.reply({embeds:[ui.okEmbed('Decision Recorded',`${decision==='accept'?'Accepted':'Rejected'} <@${userId}>. Reason: ${reason}`)]});
  }
  if (interaction.customId.startsWith('setup_modal:')) {
    const sub = interaction.customId.split(':')[1];
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ embeds: [ui.errorEmbed('Missing Permissions', 'You need **Administrator** to use this.')], ephemeral: true });
    }
    const o = {};
    for (const f of SETUP_EDIT_FIELDS[sub]) {
      const raw = interaction.fields.getTextInputValue(f.key).trim();
      if (raw) o[f.oKey] = f.parse(raw);
    }
    const patch = buildModulePatch(sub, interaction.guildId, o);
    const cfg = db.saveConfig(interaction.guildId, patch);
    return interaction.update({ embeds: [ui.setupPanelEmbed(sub, cfg)], components: [ui.setupPanelRow(sub, cfg)] });
  }

  const vc = interaction.member.voice.channel;
  if (!vc) return interaction.reply({ embeds: [ui.errorEmbed('No Channel', 'You left the voice channel.')], ephemeral: true });
  const value = interaction.fields.getTextInputValue('value');

  if (interaction.customId === 'vm_rename') { await vc.setName(value.slice(0, 100)); return interaction.reply({ embeds: [ui.okEmbed('✏️ Renamed', `Now called **${value}**.`)], ephemeral: true }); }
  if (interaction.customId === 'vm_limit') { await vc.setUserLimit(Math.max(0, Math.min(99, parseInt(value) || 0))); return interaction.reply({ embeds: [ui.okEmbed('🔢 Limit Set', `User limit is now ${value}.`)], ephemeral: true }); }
  if (interaction.customId === 'vm_transfer') {
    db.removeVMChannel(vc.id);
    db.addVMChannel(vc.id, interaction.guildId, value.trim());
    return interaction.reply({ embeds: [ui.okEmbed('🔁 Ownership Transferred', `New owner: <@${value.trim()}>`)], ephemeral: true });
  }
}

// ---------------------------------------------------------------------------------
// guildMemberAdd — antiraid, greetvoice, welcome, autorole, sticky roles
// ---------------------------------------------------------------------------------
client.on('guildMemberAdd', async (member) => {
  await sys.handleAntiBotJoin(member).catch(() => {});
  await sys.handleAntiAltJoin(member).catch(() => {});
  await sys.handleAntiraidJoin(member).catch(() => {});
  await sys.onMemberJoinGreetvoice(member).catch(() => {});

  const cfg = db.getConfig(member.guild.id);
  if (cfg.welcome.enabled && cfg.welcome.channel) {
    const ch = member.guild.channels.cache.get(cfg.welcome.channel);
    const text = cfg.welcome.message.replace('{user}', `${member}`).replace('{server}', member.guild.name).replace('{count}', member.guild.memberCount);
    if (ch?.isTextBased()) ch.send({ embeds: [ui.okEmbed('👋 Welcome!', text)] }).catch(() => {});
    if (cfg.welcome.autoroleId) member.roles.add(cfg.welcome.autoroleId).catch(() => {});
  }
  if (cfg.greetmessage.enabled && cfg.greetmessage.channelId) {
    const ch = member.guild.channels.cache.get(cfg.greetmessage.channelId);
    const text = cfg.greetmessage.message.replace('{user}', `${member}`).replace('{server}', member.guild.name);
    if (cfg.greetmessage.image) {
      const embed = ui.okEmbed('👋 Welcome!', text).setImage(cfg.greetmessage.image);
      if (ch?.isTextBased()) ch.send({ embeds: [embed] }).catch(() => {});
    } else
    if (ch?.isTextBased()) ch.send({ embeds: [ui.okEmbed('👋 Welcome', text)] }).catch(() => {});
  }
  if (cfg.autorole.enabled && cfg.autorole.roleId) {
    const target = cfg.autorole.target || 'everyone';
    if (target === 'everyone' || (target === 'bots' && member.user.bot) || (target === 'humans' && !member.user.bot)) {
      member.roles.add(cfg.autorole.roleId).catch(() => {});
    }
  }

  const sticky = db.getStickyRoles(member.guild.id, member.id);
  if (sticky.length) member.roles.add(sticky).catch(() => {});

  const log = await sys.getLogChannel(member.guild, 'join');
  if (log) log.send({ embeds: [ui.okEmbed('📥 Member Joined', `${member} (${member.user.tag})`)] }).catch(() => {});
});

client.on('guildMemberRemove', async (member) => {
  const cfg = db.getConfig(member.guild.id);
  if (cfg.leave.enabled && cfg.leave.channel) {
    const ch = member.guild.channels.cache.get(cfg.leave.channel);
    const text = cfg.leave.message.replace('{user}', member.user.tag);
    if (ch?.isTextBased()) ch.send({ embeds: [ui.warnEmbed('👋 Member Left', text)] }).catch(() => {});
  }
  if (member.roles?.cache?.size) {
    db.setStickyRoles(member.guild.id, member.id, member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.id));
  }
  const log = await sys.getLogChannel(member.guild, 'join');
  if (log) log.send({ embeds: [ui.warnEmbed('📤 Member Left', `${member.user.tag}`)] }).catch(() => {});

  const executor = await sys.findAuditExecutor(member.guild, AuditLogEvent.MemberKick, member.id);
  if (executor) await sys.antinukeStrike(member.guild, executor, 'kick').catch(() => {});
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const cfg = db.getConfig(newMember.guild.id);
  if (!oldMember.premiumSince && newMember.premiumSince && cfg.boost.enabled && cfg.boost.channel) {
    const ch = newMember.guild.channels.cache.get(cfg.boost.channel);
    const text = cfg.boost.message.replace('{user}', `${newMember}`);
    if (ch?.isTextBased()) ch.send({ embeds: [ui.okEmbed('🚀 Server Boost!', text)] }).catch(() => {});
  }
});


function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function handleApplicationDM(message) {
  const session = applicationSessions.get(message.author.id);
  if (!session || !session.waiting) return;
  if (message.content.trim().length === 0 && message.attachments.size === 0) return;
  const guild = client.guilds.cache.get(session.guildId);
  if (!guild) { applicationSessions.delete(message.author.id); return; }
  const cfg = db.getConfig(guild.id).staffApplications;
  session.answers.push(message.content.slice(0, 1500));
  session.index += 1;
  if (session.index < cfg.questions.length) {
    return message.author.send(`**Question ${session.index + 1}/${cfg.questions.length}:**\n${cfg.questions[session.index]}`).catch(()=>{});
  }
  session.waiting = false;
  const log = cfg.logChannelId ? guild.channels.cache.get(cfg.logChannelId) : null;
  if (log?.isTextBased()) {
    const embed = ui.base('📝 Staff Application').setDescription(`Application from ${message.author} (<@${message.author.id}>)`);
    cfg.questions.slice(0, 25).forEach((q,i)=>embed.addFields({name:`${i+1}. ${q}`.slice(0,256),value:(session.answers[i]||'No answer').slice(0,1024),inline:false}));
    await log.send({embeds:[embed],components:[new ActionRowBuilder().addComponents(
      new (require('discord.js').ButtonBuilder)().setCustomId(`staffapp_decide:accept:${message.author.id}`).setLabel('Accept').setStyle(require('discord.js').ButtonStyle.Success),
      new (require('discord.js').ButtonBuilder)().setCustomId(`staffapp_decide:reject:${message.author.id}`).setLabel('Reject').setStyle(require('discord.js').ButtonStyle.Danger)
    )]}).catch(()=>{});
  }
  await message.author.send('Your application has been submitted. Staff will review it and notify you.').catch(()=>{});
  applicationSessions.delete(message.author.id);
}

async function handleHoneypot(message) {
  const cfg = db.getConfig(message.guild.id).honeypot;
  await message.delete().catch(()=>{});
  const log = cfg.logChannelId ? message.guild.channels.cache.get(cfg.logChannelId) : null;
  if (log?.isTextBased()) log.send({embeds:[ui.errorEmbed('🍯 Honeypot Triggered', `${message.author} posted in <#${cfg.channelId}>. Action: **${cfg.action}**.`)]}).catch(()=>{});
  if (cfg.cleanupWindow !== 'none') {
    const ms = cfg.cleanupWindow === '10m' ? 10*60e3 : cfg.cleanupWindow === '1h' ? 60*60e3 : 24*60*60e3;
    const cutoff = Date.now() - ms;
    for (const ch of message.guild.channels.cache.values()) {
      if (!ch.isTextBased() || !ch.messages?.fetch) continue;
      let before;
      for (let page=0; page<5; page++) {
        const opts={limit:100}; if(before) opts.before=before;
        const msgs=await ch.messages.fetch(opts).catch(()=>null); if(!msgs?.size) break;
        const mine=[...msgs.values()].filter(m=>m.author.id===message.author.id && m.createdTimestamp>=cutoff && m.id!==message.id);
        await Promise.allSettled(mine.map(m=>m.delete().catch(()=>{})));
        const oldest=msgs.last(); if(!oldest || oldest.createdTimestamp<cutoff || msgs.size<100) break; before=oldest.id;
      }
    }
  }
  const member=await message.guild.members.fetch(message.author.id).catch(()=>null);
  if (cfg.action==='kick' || cfg.action==='ban') {
    let invite='';
    if(cfg.action==='kick' && cfg.createInvite) {
      const target=message.guild.channels.cache.get(cfg.channelId) || message.guild.systemChannel;
      if(target?.isTextBased() && target.permissionsFor(message.guild.members.me)?.has(PermissionFlagsBits.CreateInstantInvite)) {
        invite=await target.createInvite({maxAge:86400,maxUses:1,unique:true,reason:'Honeypot recovery invite'}).then(i=>i.url).catch(()=> '');
      }
    }
    if(cfg.action==='kick') {
      await member?.kick('Honeypot trigger').catch(()=>{});
      const dm=(cfg.dmMessage||'You were removed for posting in the honeypot channel. {invite}').replace('{invite}',invite||'');
      await message.author.send(dm).catch(()=>{});
    } else await member?.ban({reason:'Honeypot trigger'}).catch(()=>{});
  } else if(cfg.action==='timeout') await member?.timeout(10*60e3,'Honeypot trigger').catch(()=>{});
}

function birthdayKey(date) { return `${date.getUTCMonth()+1}-${date.getUTCDate()}`; }
async function sendBirthdayWishes() {
  const now=new Date(); const key=birthdayKey(now); const dayToken=`${now.getUTCFullYear()}-${key}`;
  for (const guild of client.guilds.cache.values()) {
    const cfg=db.getConfig(guild.id).birthdays; if(!cfg.enabled || !cfg.wishChannelId) continue;
    const channel=guild.channels.cache.get(cfg.wishChannelId); if(!channel?.isTextBased()) continue;
    const entries=cfg.entries||{};
    for(const [userId,date] of Object.entries(entries)) {
      if(date!==key || birthdayWishesSent.has(`${guild.id}:${userId}:${dayToken}`)) continue;
      birthdayWishesSent.add(`${guild.id}:${userId}:${dayToken}`);
      const text=(cfg.wishMessage||'Happy Birthday {user}! 🎂').replace('{user}',`<@${userId}>`).replace('{date}',key);
      channel.send({embeds:[ui.okEmbed('🎂 Happy Birthday!',text)]}).catch(()=>{});
    }
  }
}

// ---------------------------------------------------------------------------------
// reaction roles
// ---------------------------------------------------------------------------------
async function handleReactionRole(reaction, user, adding) {
  if (user?.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
    const guild = reaction.message.guild;
    if (!guild) return;
    const all = db.getConfig(guild.id);
    const panels = Array.isArray(all.reactionRolePanels) ? all.reactionRolePanels : [];
    let panel = panels.find(p => p.messageId === reaction.message.id);
    let mappings = panel?.mappings || [];
    if (!panel) {
      const legacy = all.reactionRoles;
      if (legacy.enabled === false || legacy.messageId !== reaction.message.id) return;
      panel = legacy;
      mappings = legacy.mappings || [];
    }
    if (panel.enabled === false) return;
    const key = reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;
    const mapping = mappings.find(x => x.emoji === key || x.emoji === reaction.emoji.name);
    if (!mapping) return;
    const member = await guild.members.fetch(user.id);
    const role = guild.roles.cache.get(mapping.roleId);
    const bot = guild.members.me;
    if (!role || !bot || role.position >= bot.roles.highest.position) {
      await reaction.users.remove(user.id).catch(() => {});
      return;
    }
    if (adding) await member.roles.add(role);
    else await member.roles.remove(role);
  } catch (e) { console.error('reaction role action failed:', e); }
}
client.on('messageReactionAdd', (reaction, user) => handleReactionRole(reaction, user, true));
client.on('messageReactionRemove', (reaction, user) => handleReactionRole(reaction, user, false));

// ---------------------------------------------------------------------------------
// messageCreate — antilink, antispam, leveling, automod, prefix-less utility
// ---------------------------------------------------------------------------------
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Staff applications happen in DMs and intentionally have no guild.
  if (!message.guild) return handleApplicationDM(message).catch(console.error);

  const cfgAll = db.getConfig(message.guild.id);

  // Setup image/GIF uploads are consumed before command parsing and removed after saving.
  if (await consumeSetupMedia(message)) return;

   // Mentioning the bot without another command gives a server-specific quick start.
  const mentionOnly = new RegExp(`^<@!?${client.user.id}>\\s*$`);

  if (mentionOnly.test(message.content.trim())) {
    const prefix = cfgAll.prefix || '!';
    return message.reply({
      embeds: [
        ui.base(`🤖 ${client.user.username}`)
          .setDescription(
            `Welcome to **${message.guild.name}**!\n\n` +
            `Start with **${prefix}help** or **/help** to see what I can do.\n\n` +
            `**Server Prefix:** \`${prefix}\`\n` +
            `**Bot Ping:** \`${client.ws.ping}ms\``
          )
      ]
    }).catch(() => {});
  }

  const handled = await handlePrefixCommand(message).catch(err => {
    console.error('Prefix command error:', err);
    return false;
  });
  if (handled) return;

  const cfg = db.getConfig(message.guild.id);

  // Anti-link
  if (
    cfg.antilink.enabled &&
    /(?:https?:\/\/|www\.|discord\.gg\/|discord(?:app)?\.com\/invite\/)/i.test(message.content) &&
    !message.member?.permissions.has(PermissionFlagsBits.ManageMessages)
  ) {
    await message.delete().catch(() => {});
    const log = await sys.getLogChannel(message.guild, 'message');
    if (log?.isTextBased()) {
      log.send({
        embeds: [
          ui.errorEmbed(
            '🔗 Anti-Link',
            `**User:** ${message.author}\n**Channel:** ${message.channel}`
          )
        ]
      }).catch(() => {});
    }
    return;
  }

  // Anti-spam
  if (cfg.antispam.enabled) {
    const result = sys.handleAntispam?.(message);
    if (result?.blocked) return;
  }

  // Leveling
  if (cfg.leveling.enabled) {
    sys.handleLevelingMessage?.(message).catch(() => {});
  }

  // Auto responders
  if (cfg.autoresponder?.enabled) {
    const triggers = cfg.autoresponder.triggers || [];
    for (const trigger of triggers) {
      const content = message.content.toLowerCase();
      const matchText = String(trigger.match || '').toLowerCase();

      const matched = trigger.mode === 'exact'
        ? content === matchText
        : content.includes(matchText);

      if (matched) {
        await message.channel.send(trigger.response).catch(() => {});
        break;
      }
    }
  }

  // Auto reactors
  if (cfg.autoreactor?.enabled) {
    const triggers = cfg.autoreactor.triggers || [];

    for (const trigger of triggers) {
      const content = message.content.toLowerCase();
      const matchText = String(trigger.match || '').toLowerCase();

      const matched = trigger.mode === 'exact'
        ? content === matchText
        : content.includes(matchText);

      if (!matched) continue;

      for (const emoji of trigger.emojis || []) {
        await message.react(emoji).catch(() => {});
      }
      break;
    }
  }

  // Anti-badword
  const bad = cfg.antibadword;
  if (bad?.enabled !== false) {
    const words = [
      ...(bad.words || []),
      ...(bad.customWords || [])
    ].map(x => String(x).toLowerCase()).filter(Boolean);

    if (
      words.length &&
      words.some(word => message.content.toLowerCase().includes(word)) &&
      !message.member?.permissions.has(PermissionFlagsBits.ManageMessages)
    ) {
      await message.delete().catch(() => {});

      const log = await sys.getLogChannel(message.guild, 'message');
      if (log?.isTextBased()) {
        log.send({
          embeds: [
            ui.errorEmbed(
              '🚫 Bad Word Filter',
              `**User:** ${message.author}\n**Channel:** ${message.channel}`
            )
          ]
        }).catch(() => {});
      }

      return;
    }
  }

  // AutoMod filters are independent switches.
  const auto = cfg.automod;

  if (auto.enabled !== false) {
    const letters = message.content.replace(/[^A-Za-z]/g, '');

    if (auto.capsFilter && letters.length >= 8) {
      const caps = letters.replace(/[^A-Z]/g, '').length;

      if ((caps / letters.length) * 100 >= (auto.capsThreshold || 70)) {
        await message.delete().catch(() => {});

        const log = await sys.getLogChannel(message.guild, 'message');
        if (log?.isTextBased()) {
          log.send({
            embeds: [
              ui.errorEmbed(
                '🔠 Caps Filter',
                `**User:** ${message.author}\n**Channel:** ${message.channel}`
              )
            ]
          }).catch(() => {});
        }

        return;
      }
    }

    if (
      auto.inviteFilter &&
      /(?:discord\.gg|discord(?:app)?\.com\/invite)\/\S+/i.test(message.content)
    ) {
      if (!message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await message.delete().catch(() => {});

        const log = await sys.getLogChannel(message.guild, 'message');
        if (log?.isTextBased()) {
          log.send({
            embeds: [
              ui.errorEmbed(
                '🔗 Invite Filter',
                `**User:** ${message.author}\n**Channel:** ${message.channel}`
              )
            ]
          }).catch(() => {});
        }

        return;
      }
    }
  }
});

// ---------------------------------------------------------------------------------
// voiceStateUpdate — Voicemaster hub → temp channel creation, auto-cleanup,
// greetvoice gate handling. All logic lives in systems.js; this just forwards.
// ---------------------------------------------------------------------------------
client.on('voiceStateUpdate', async (oldState, newState) => {
  await sys.handleVoiceStateUpdate(oldState, newState)
    .catch(err => console.error('voiceStateUpdate:', err));
});

// ---------------------------------------------------------------------------------
// Periodic tasks
// ---------------------------------------------------------------------------------
setInterval(
  () => sendBirthdayWishes().catch(console.error),
  60 * 60 * 1000
);

sendBirthdayWishes().catch(() => {});

// ---------------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------------
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('Failed to log in:', err);
  process.exit(1);
});