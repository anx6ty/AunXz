// Stat channel setup and updater. Uses the existing SQLite database and Discord.js v14.
// Social metrics require official platform API credentials; failures never overwrite old channel names.
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, PermissionFlagsBits, EmbedBuilder
} = require('discord.js');
const db = require('./database');
const ui = require('./ui');

const ACCENT = 0x5865F2;
const META_GRAPH_VERSION = 'v26.0';
const SESSION_TIMEOUT = 120000;
const ALL_PLACEHOLDERS = {
  'ig.followers':'Instagram followers', 'ig.following':'Instagram following', 'ig.posts':'Instagram posts', 'ig.likes':'Likes on recent Instagram media',
  'yt.subs':'YouTube subscribers', 'yt.views':'YouTube views', 'yt.videos':'YouTube videos', 'yt.likes':'Likes on recent YouTube videos',
  'tw.followers':'X/Twitter followers', 'tw.following':'X/Twitter following', 'tw.tweets':'X/Twitter posts', 'tw.likes':'Likes on recent X/Twitter posts',
  'tt.followers':'TikTok followers', 'tt.following':'TikTok following', 'tt.likes':'TikTok likes', 'tt.videos':'TikTok videos',
  'server.members':'Server members', 'server.humans':'Non-bot members', 'server.bots':'Bots', 'server.staff':'Non-bot administrators', 'server.boosts':'Server boosts'
};
const PLATFORM_PREFIX = { instagram:'ig', youtube:'yt', twitter:'tw', tiktok:'tt' };
const PLATFORM_LABEL = { instagram:'📸 Instagram', youtube:'▶️ YouTube', twitter:'𝕏 Twitter/X', tiktok:'🎵 TikTok' };
const SOCIAL_INTERVAL_DEFAULT = Math.max(10, Number(process.env.STAT_SOCIAL_INTERVAL_MINUTES) || 12) * 60000;
const SERVER_INTERVAL_DEFAULT = Math.max(5, Number(process.env.STAT_SERVER_INTERVAL_MINUTES) || 7) * 60000;
const MAX_CHANNELS = Math.max(1, Number(process.env.MAX_STAT_CHANNELS_PER_GUILD) || 10);
const sessions = new Map();
const renameTimes = new Map();
const renameTimers = new Map();
const activeRefreshes = new Set();
let started = false;
let botClient = null;

function sessionKey(guildId, userId) { return `${guildId}:${userId}`; }
function sessionCustomId(userId, action, extra = '') { return `statsetup:${userId}:${action}${extra ? `:${extra}` : ''}`; }
function asArray(value) { try { const v = JSON.parse(value || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
function placeholderKeys(template) { return [...new Set([...String(template || '').matchAll(/<([^<>]+)>/g)].map(m => m[1].trim()))]; }
function formatNumber(value, fullNumbers = false) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '—');
  if (fullNumbers || Math.abs(n) < 1000) return Math.trunc(n).toLocaleString('en-US');
  const units = [[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'K']];
  for (const [size, suffix] of units) if (Math.abs(n) >= size) return `${(n / size).toFixed(Math.abs(n / size) >= 100 ? 0 : 1).replace(/\.0$/, '')}${suffix}`;
  return String(n);
}
function renderTemplate(template, metrics, fullNumbers) {
  return String(template).replace(/<([^<>]+)>/g, (_all, key) => formatNumber(metrics[key.trim()], fullNumbers)).replace(/\s+/g, ' ').trim().slice(0, 100);
}
function placeholdersForType(type) {
  if (type === 'server') return Object.keys(ALL_PLACEHOLDERS).filter(k => k.startsWith('server.'));
  const prefix = PLATFORM_PREFIX[type];
  return prefix ? Object.keys(ALL_PLACEHOLDERS).filter(k => k.startsWith(`${prefix}.`)) : [];
}
function validateTemplate(template, type, selectedStats = []) {
  const text = String(template || '').trim();
  if (!text) return { error: 'Enter a channel-name template.' };
  if (text.length > 500) return { error: 'Templates must be 500 characters or fewer.' };
  const used = placeholderKeys(text);
  if (!used.length) return { error: 'Add at least one valid placeholder, such as `Members: <server.members>`.' };
  const unknown = used.filter(key => !Object.prototype.hasOwnProperty.call(ALL_PLACEHOLDERS, key));
  if (unknown.length) return { error: `Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map(x => `\`<${x}>\``).join(', ')}. Use only the placeholders listed in the panel.` };
  const allowed = placeholdersForType(type);
  if (type === 'server' && selectedStats.length) {
    const selectedAllowed = selectedStats.map(x => `server.${x}`);
    if (selectedStats.includes('members')) selectedAllowed.push('server.humans', 'server.boosts');
    const invalid = used.filter(key => !selectedAllowed.includes(key));
    if (invalid.length) return { error: `Those placeholders were not selected: ${invalid.map(x => `\`<${x}>\``).join(', ')}. Select the matching stat type or remove the placeholder.` };
  } else {
    const invalid = used.filter(key => !allowed.includes(key));
    if (invalid.length) return { error: `This stat type supports: ${allowed.map(x => `\`<${x}>\``).join(', ')}. Invalid for this selection: ${invalid.map(x => `\`<${x}>\``).join(', ')}.` };
  }
  return { used };
}
function placeholderLines(keys) { return keys.map(key => `\`${`<${key}>`}\` — ${ALL_PLACEHOLDERS[key]}`).join('\n'); }
function allPlaceholderFields(embed) {
  embed.addFields(
    { name:'Instagram', value:placeholderLines(Object.keys(ALL_PLACEHOLDERS).filter(k => k.startsWith('ig.'))), inline:true },
    { name:'YouTube', value:placeholderLines(Object.keys(ALL_PLACEHOLDERS).filter(k => k.startsWith('yt.'))), inline:true },
    { name:'Twitter/X', value:placeholderLines(Object.keys(ALL_PLACEHOLDERS).filter(k => k.startsWith('tw.'))), inline:true },
    { name:'TikTok', value:placeholderLines(Object.keys(ALL_PLACEHOLDERS).filter(k => k.startsWith('tt.'))), inline:true },
    { name:'Server', value:placeholderLines(Object.keys(ALL_PLACEHOLDERS).filter(k => k.startsWith('server.'))), inline:true }
  );
  return embed;
}
function initialPayload(session) {
  const embed = allPlaceholderFields(ui.base('📊 Stat Channel Setup')
    .setColor(ACCENT)
    .setDescription('Create live voice-channel counters. Choose a stat type below; the channel name updates automatically.\n\n**Template example:** `Members: <server.members>`\n**Category:** choose an existing category, or leave it empty to use/create `📊 Stats`.'));
  const typeRow = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(sessionCustomId(session.userId,'mode')).setPlaceholder('Choose Social Stats or Server Stats')
    .addOptions({label:'Social Stats',value:'social',description:'Track Instagram, YouTube, X/Twitter, or TikTok',emoji:'🌐'},
      {label:'Server Stats',value:'server',description:'Track members, bots, staff, boosts',emoji:'🏠'}));
  const categoryRow = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
    .setCustomId(sessionCustomId(session.userId,'category')).setPlaceholder(session.categoryId ? 'Category selected — choose another to change' : 'Optional: choose stats category')
    .setChannelTypes(ChannelType.GuildCategory).setMinValues(1).setMaxValues(1));
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'manage')).setLabel('Manage').setEmoji('🗂️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'cancel')).setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Secondary)
  );
  return { embeds:[embed], components:[typeRow,categoryRow,buttons] };
}
function socialSelectPayload(session) {
  const embed = ui.base('🌐 Choose a Platform').setColor(ACCENT)
    .setDescription('Select the account platform. The next form asks for the account, template, and platform API credential. Credentials are stored in this guild’s SQLite database.');
  const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(sessionCustomId(session.userId,'platform')).setPlaceholder('Select social platform')
    .addOptions(
      {label:'Instagram',value:'instagram',emoji:'📸',description:'Followers, following, posts, likes'},
      {label:'YouTube',value:'youtube',emoji:'▶️',description:'Subscribers, views, videos, recent likes'},
      {label:'Twitter / X',value:'twitter',emoji:'𝕏',description:'Followers, following, posts, recent likes'},
      {label:'TikTok',value:'tiktok',emoji:'🎵',description:'Followers, following, likes, videos'}));
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'back')).setLabel('Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'cancel')).setLabel('Cancel').setStyle(ButtonStyle.Danger)
  );
  return { embeds:[embed], components:[row,buttons] };
}
function serverTypesPayload(session) {
  const embed = ui.base('🏠 Choose Server Stats').setColor(ACCENT)
    .setDescription(`Select one or more stat types, then press **Continue**.\n\n**Available server placeholders**\n${placeholderLines(Object.keys(ALL_PLACEHOLDERS).filter(k => k.startsWith('server.')))}\n\nSelected: ${session.selectedStats.length ? session.selectedStats.map(x => `\`${x}\``).join(', ') : 'none yet'}`);
  const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(sessionCustomId(session.userId,'server-types')).setPlaceholder('Select stat types')
    .setMinValues(1).setMaxValues(3)
    .addOptions({label:'Members',value:'members',emoji:'👥'},{label:'Bots',value:'bots',emoji:'🤖'},{label:'Staff (Administrators)',value:'staff',emoji:'🛡️'}));
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'continue')).setLabel('Continue').setEmoji('➡️').setStyle(ButtonStyle.Success).setDisabled(!session.selectedStats.length),
    new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'back')).setLabel('Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'cancel')).setLabel('Cancel').setStyle(ButtonStyle.Danger)
  );
  return { embeds:[embed], components:[row,buttons] };
}
function socialModal(session, platform) {
  const currentKey = db.getStatApiKey(session.guildId,platform) || '';
  const account = new TextInputBuilder().setCustomId('account').setLabel('Account handle or channel ID').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setPlaceholder(platform === 'youtube' ? '@handle or UC… channel ID' : '@handle / account ID');
  const template = new TextInputBuilder().setCustomId('template').setLabel('Channel name template').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500).setPlaceholder('Followers: <ig.followers>');
  const keyLabel = platform === 'youtube' ? 'YouTube Data API key' : platform === 'instagram' ? 'Meta Graph API access token' : platform === 'twitter' ? 'X API bearer token' : 'TikTok API access token';
  const key = new TextInputBuilder().setCustomId('api_key').setLabel(keyLabel).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2000).setPlaceholder('Required by the official platform API');
  if (currentKey) key.setValue(currentKey.slice(0,2000));
  return new ModalBuilder().setCustomId(sessionCustomId(session.userId,'social-modal')).setTitle(`${PLATFORM_LABEL[platform]} Stats`.slice(0,45))
    .addComponents(new ActionRowBuilder().addComponents(account),new ActionRowBuilder().addComponents(template),new ActionRowBuilder().addComponents(key));
}
function serverModal(session) {
  return new ModalBuilder().setCustomId(sessionCustomId(session.userId,'server-modal')).setTitle('Server Stat Template')
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('template').setLabel('Channel name template').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500).setPlaceholder('Members: <server.members>')));
}
function managePayload(session, page = 1) {
  const rows = db.listStatChannels(session.guildId);
  const pageSize = 5;
  const pageCount = Math.max(1,Math.ceil(rows.length/pageSize));
  page = Math.max(1,Math.min(Number(page)||1,pageCount));
  session.page = page;
  let selected = rows.find(r => Number(r.id) === Number(session.selectedStatId));
  if (!selected && rows.length) { selected = rows[(page-1)*pageSize]; session.selectedStatId = selected.id; }
  if (selected && (Number(selected.id) < Number(rows[(page-1)*pageSize]?.id) || Number(selected.id) > Number(rows[Math.min(rows.length-1,page*pageSize-1)]?.id))) {
    selected = rows[(page-1)*pageSize]; session.selectedStatId = selected?.id || null;
  }
  const list = rows.slice((page-1)*pageSize,page*pageSize);
  const embed = ui.base('🗂️ Manage Stat Channels').setColor(ACCENT)
    .setDescription(rows.length ? list.map(r => {
      const platform = r.statType === 'server' ? '🏠 Server' : (PLATFORM_LABEL[r.statType] || r.statType);
      return `**#${r.id}** • ${platform}\n<#${r.channelId}> • ${r.account ? `\`${r.account}\`` : 'server'}\nTemplate: \`${String(r.template).slice(0,120)}\``;
    }).join('\n\n') : 'No stat channels yet. Press **Back** and create your first one.')
    .setFooter({text:`Page ${page}/${pageCount} • ${rows.length}/${MAX_CHANNELS} tracked channels`});
  const components = [];
  if (rows.length) {
    components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(sessionCustomId(session.userId,'manage-select')).setPlaceholder('Choose a stat channel')
      .addOptions(rows.slice((page-1)*pageSize,page*pageSize).map(r => ({label:`#${r.id} • ${r.statType==='server'?'Server':PLATFORM_LABEL[r.statType]||r.statType}`.slice(0,100),value:String(r.id),description:`${r.account || r.template}`.slice(0,100),default:Number(r.id)===Number(session.selectedStatId)})))));
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'page-first')).setLabel('First').setStyle(ButtonStyle.Secondary).setDisabled(page===1),
      new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'page-prev')).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page===1),
      new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'page-indicator')).setLabel(`${page}/${pageCount}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'page-next')).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page===pageCount),
      new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'page-last')).setLabel('Last').setStyle(ButtonStyle.Secondary).setDisabled(page===pageCount)
    ));
  }
  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'edit')).setLabel('Edit Template').setEmoji('✏️').setStyle(ButtonStyle.Primary).setDisabled(!selected),
    new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'interval')).setLabel('Interval').setEmoji('⏱️').setStyle(ButtonStyle.Secondary).setDisabled(!selected),
    new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'refresh')).setLabel('Refresh Now').setEmoji('🔄').setStyle(ButtonStyle.Success).setDisabled(!selected),
    new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'full')).setLabel(selected?.fullNumbers ? 'Full Numbers: ON' : 'Full Numbers: OFF').setStyle(selected?.fullNumbers ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!selected),
    new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'delete')).setLabel('Delete').setEmoji('🗑️').setStyle(ButtonStyle.Danger).setDisabled(!selected)
  );
  components.push(actions);
  components.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'back')).setLabel('Back to Setup').setStyle(ButtonStyle.Secondary)));
  return { embeds:[embed], components };
}
function beginSessionTimeout(session) {
  if (session.timer) clearTimeout(session.timer);
  session.expiresAt = Date.now()+SESSION_TIMEOUT;
  session.timer = setTimeout(async () => {
    sessions.delete(sessionKey(session.guildId,session.userId));
    try {
      if (session.panelMessage?.edit) {
        const embeds = (session.embeds || []).map(e => { const copy=EmbedBuilder.from(e); copy.setFooter({text:'Panel expired — run /statsetup again'}); return copy; });
        const components = (session.components || []).map(row => ({type:1,components:(row.components||[]).map(c=>({...c.toJSON(),disabled:true}))}));
        await session.panelMessage.edit({embeds,components});
      }
    } catch (e) { console.warn('[StatSetup] Could not disable expired panel:',e.message); }
  },SESSION_TIMEOUT);
  session.timer.unref?.();
}
function rememberPayload(session,payload) { session.embeds=payload.embeds||[];session.components=payload.components||[];return payload; }
async function updatePanel(interaction,session,payload) {
  rememberPayload(session,payload);beginSessionTimeout(session);
  return interaction.update(payload);
}
async function showPayload(interaction,session,payload) {
  rememberPayload(session,payload);
  const response=await interaction.reply({...payload,ephemeral:true});
  try {
    if (response?.edit && response?.id) session.panelMessage=response;
    else if (interaction.fetchReply) session.panelMessage=await interaction.fetchReply().catch(()=>null);
  } catch {}
  beginSessionTimeout(session);
  return response;
}
function userCanManage(interaction) {
  const p=interaction.member?.permissions;
  return Boolean(p?.has(PermissionFlagsBits.ManageChannels) && p?.has(PermissionFlagsBits.ManageGuild));
}
function botCanManage(guild) {
  return Boolean(guild?.members?.me?.permissions?.has(PermissionFlagsBits.ManageChannels));
}
function permissionError(interaction) {
  if (!userCanManage(interaction)) return ui.errorEmbed('Missing Permissions','You need both **Manage Channels** and **Manage Server** to configure stat channels.');
  if (!botCanManage(interaction.guild)) return ui.errorEmbed('Bot Missing Permissions','I need **Manage Channels** to create and update stat voice channels.');
  return null;
}
async function command(interaction) {
  if (!interaction.guild || !interaction.guildId) return interaction.reply({embeds:[ui.errorEmbed('Server Only','Use `/statsetup` inside a server.')],ephemeral:true});
  const error = permissionError(interaction);
  if (error) return interaction.reply({embeds:[error],ephemeral:true});
  const action=String(interaction.options?.getString?.('action')||'setup').toLowerCase();
  const session={guildId:interaction.guildId,userId:interaction.user.id,categoryId:null,mode:null,platform:null,selectedStats:[],step:'initial',selectedStatId:null,page:1};
  sessions.set(sessionKey(session.guildId,session.userId),session);
  if (action==='list'||action==='manage') {
    session.step='manage';
    session.selectedStatId=db.listStatChannels(session.guildId)[0]?.id||null;
    return showPayload(interaction,session,managePayload(session,1));
  }
  return showPayload(interaction,session,initialPayload(session));
}
function activeSession(interaction, actionId) {
  const parts=String(actionId).split(':');
  const ownerId=parts[1];
  if (ownerId!==interaction.user?.id) return {error:'This is not your stat setup panel.'};
  const session=sessions.get(sessionKey(interaction.guildId,ownerId));
  if (!session || session.expiresAt<Date.now()) return {error:'This stat setup panel expired. Run `/statsetup` again.'};
  if (interaction.guildId!==session.guildId) return {error:'This panel belongs to another server.'};
  beginSessionTimeout(session);
  return {session,parts};
}
async function responseError(interaction,message) {
  const payload={embeds:[ui.errorEmbed('Stat Setup',message)],ephemeral:true};
  if (interaction.isModalSubmit?.()) return interaction.reply(payload);
  return interaction.reply(payload);
}
function getBotPermissionOverwrites(guild) {
  const deny=[...new Set(Object.values(PermissionFlagsBits).filter(bit=>typeof bit==='bigint' && bit!==PermissionFlagsBits.ViewChannel))];
  return [{id:guild.id,allow:[PermissionFlagsBits.ViewChannel],deny},{id:guild.members.me.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ManageChannels]}];
}
async function chooseCategory(guild,session) {
  if (session.categoryId) {
    const selected=guild.channels.cache.get(session.categoryId) || await guild.channels.fetch(session.categoryId).catch(()=>null);
    if (!selected) throw new Error('The selected category was deleted. Reopen `/statsetup` and choose another category.');
    if (selected.type!==ChannelType.GuildCategory) throw new Error('The selected parent is no longer a category. Choose a valid category.');
    return selected;
  }
  let category=guild.channels.cache.find(ch=>ch.type===ChannelType.GuildCategory && ['📊 Stats','Stats'].includes(ch.name));
  if (category) return category;
  category=await guild.channels.create({name:'📊 Stats',type:ChannelType.GuildCategory,reason:'Create category for stat channels'}).catch(err=>{throw new Error(`I could not create the **📊 Stats** category: ${err.message||'Discord rejected the request'}. Check Manage Channels and category limits.`);});
  return category;
}
async function createTrackedChannel(interaction,session,{type,template,account,placeholders,apiKey}) {
  const error=permissionError(interaction);
  if(error) {
    const permissions=interaction.member?.permissions;
    if(!permissions?.has(PermissionFlagsBits.ManageChannels)||!permissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('You need both Manage Channels and Manage Server.');
    throw new Error('I need Manage Channels to create and update stat voice channels.');
  }
  const guild=interaction.guild;
  let tracked=db.listStatChannels(guild.id);
  // Prune records whose channels were deleted while the bot was offline.
  for(const row of tracked) if(!guild.channels.cache.has(row.channelId)) { db.deleteStatChannel(guild.id,row.id); }
  tracked=db.listStatChannels(guild.id);
  if(tracked.length>=MAX_CHANNELS) throw new Error(`This server already tracks ${tracked.length}/${MAX_CHANNELS} stat channels. Delete one first or increase \`MAX_STAT_CHANNELS_PER_GUILD\`.`);
  if(!botCanManage(guild)) throw new Error('I need **Manage Channels** to create this voice channel and update its name.');
  const category=await chooseCategory(guild,session);
  const intervalMs=type==='server'?SERVER_INTERVAL_DEFAULT:SOCIAL_INTERVAL_DEFAULT;
  const metrics=type==='server'?await collectServerStats(guild,placeholders):await collectSocialStats(type,account,apiKey,placeholders);
  const name=renderTemplate(template,metrics,false)||'📊 Stat';
  let channel=null;
  try {
    channel=await guild.channels.create({name,type:ChannelType.GuildVoice,parent:category.id,permissionOverwrites:getBotPermissionOverwrites(guild),reason:`Create ${type} statistic channel for ${interaction.user.tag}`});
    if(type!=='server') db.saveStatApiKey(guild.id,type,apiKey);
    const row=db.createStatChannel(guild.id,channel.id,type,placeholders,template,account,intervalMs,interaction.user.id);
    db.updateStatChannel(guild.id,row.id,{lastValue:name,lastCheckedAt:Date.now()});
    return {channel,row,name};
  } catch(err) {
    if(channel) await channel.delete('Rollback failed stat channel setup').catch(()=>{});
    throw err;
  }
}
async function fetchJson(url,options={},label='platform API') {
  let response;
  try { response=await fetch(url,{...options,signal:AbortSignal.timeout(12000)}); }
  catch(err) { throw new Error(`${label} request failed or timed out. Check the API credential and try again.`); }
  const data=await response.json().catch(()=>null);
  if(!response.ok || !data) {
    const detail=data?.error?.message || data?.error?.errors?.[0]?.message || data?.message || `HTTP ${response.status}`;
    throw new Error(`${label} rejected the request (${String(detail).slice(0,180)}). Check the credential, account access, and API quota.`);
  }
  if(data.error && !data.data) throw new Error(`${label} error: ${String(data.error.message||data.error_description||data.error).slice(0,180)}.`);
  return data;
}
async function collectSocialStats(type, account, apiKey, placeholders) {
  if(!apiKey) throw new Error(`An API key/access token is required for ${PLATFORM_LABEL[type]}. Reopen setup and enter a valid credential.`);
  if(!account) throw new Error('The social account handle or channel ID is missing.');
  const p=PLATFORM_PREFIX[type], metrics={};
  if(type==='youtube') {
    const params=new URLSearchParams({part:'statistics,contentDetails',key:apiKey});
    if(/^UC[\w-]{10,}$/.test(account)) params.set('id',account); else params.set('forHandle',account.replace(/^@/,''));
    const result=await fetchJson(`https://www.googleapis.com/youtube/v3/channels?${params}` ,{},'YouTube Data API');
    const item=result.items?.[0]; if(!item) throw new Error('YouTube returned no channel for that handle or channel ID.');
    const stats=item.statistics||{};metrics['yt.subs']=Number(stats.subscriberCount||0);metrics['yt.views']=Number(stats.viewCount||0);metrics['yt.videos']=Number(stats.videoCount||0);
    if(placeholders.includes('yt.likes')) {
      const playlist=item.contentDetails?.relatedPlaylists?.uploads;
      let total=0;
      if(playlist) {
        const plParams=new URLSearchParams({part:'contentDetails',maxResults:'50',playlistId:playlist,key:apiKey});
        const videos=await fetchJson(`https://www.googleapis.com/youtube/v3/playlistItems?${plParams}`,{},'YouTube Data API');
        const ids=(videos.items||[]).map(v=>v.contentDetails?.videoId).filter(Boolean);
        for(let i=0;i<ids.length;i+=50) {
          const vp=new URLSearchParams({part:'statistics',id:ids.slice(i,i+50).join(','),key:apiKey});
          const vs=await fetchJson(`https://www.googleapis.com/youtube/v3/videos?${vp}`,{},'YouTube Data API');
          total+=(vs.items||[]).reduce((sum,v)=>sum+Number(v.statistics?.likeCount||0),0);
        }
      }
      metrics['yt.likes']=total;
    }
  } else if(type==='instagram') {
    const token=apiKey;
    let id=account;
    if(!/^\d+$/.test(account)) {
      const me=await fetchJson(`https://graph.facebook.com/${META_GRAPH_VERSION}/me?fields=id&access_token=${encodeURIComponent(token)}`,{},'Instagram Graph API');
      id=me.id;
      const username=account.replace(/^@/,'');
      const query=`business_discovery.username(${username}){followers_count,follows_count,media_count,media.limit(50){like_count}}`;
      const data=await fetchJson(`https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(id)}?fields=${encodeURIComponent(query)}&access_token=${encodeURIComponent(token)}`,{},'Instagram Graph API');
      const obj=data.business_discovery;if(!obj)throw new Error('Instagram could not access that username via Business Discovery. Use an eligible public business/creator account and a token with the required permissions.');
      metrics['ig.followers']=Number(obj.followers_count||0);metrics['ig.following']=Number(obj.follows_count||0);metrics['ig.posts']=Number(obj.media_count||0);
      if(placeholders.includes('ig.likes')) metrics['ig.likes']=(obj.media?.data||[]).reduce((sum,m)=>sum+Number(m.like_count||0),0);
    } else {
      const query='followers_count,follows_count,media_count,media.limit(50){like_count}';
      const data=await fetchJson(`https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(id)}?fields=${encodeURIComponent(query)}&access_token=${encodeURIComponent(token)}`,{},'Instagram Graph API');
      metrics['ig.followers']=Number(data.followers_count||0);metrics['ig.following']=Number(data.follows_count||0);metrics['ig.posts']=Number(data.media_count||0);
      if(placeholders.includes('ig.likes')) metrics['ig.likes']=(data.media?.data||[]).reduce((sum,m)=>sum+Number(m.like_count||0),0);
    }
  } else if(type==='twitter') {
    const handle=account.replace(/^@/,'');const token=apiKey.replace(/^Bearer\s+/i,'');
    const headers={Authorization:`Bearer ${token}`};
    const result=await fetchJson(`https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}?user.fields=public_metrics`,{headers},'X API');
    const user=result.data;if(!user)throw new Error('X did not return a user for that handle.');
    const pm=user.public_metrics||{};metrics['tw.followers']=Number(pm.followers_count||0);metrics['tw.following']=Number(pm.following_count||0);metrics['tw.tweets']=Number(pm.tweet_count||0);
    if(placeholders.includes('tw.likes')) {
      const tweets=await fetchJson(`https://api.x.com/2/users/${encodeURIComponent(user.id)}/tweets?max_results=100&tweet.fields=public_metrics`,{headers},'X API');
      metrics['tw.likes']=(tweets.data||[]).reduce((sum,t)=>sum+Number(t.public_metrics?.like_count||0),0);
    }
  } else if(type==='tiktok') {
    const token=apiKey.replace(/^Bearer\s+/i,'');
    const fields='display_name,bio_description,avatar_url,is_verified,follower_count,following_count,likes_count,video_count';
    const result=await fetchJson(`https://open.tiktokapis.com/v2/research/user/info/?fields=${fields}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'text/plain'},body:JSON.stringify({username:account.replace(/^@/,'')})},'TikTok Research API');
    const user=result.data?.username?result.data:result.data?.user;if(!user)throw new Error('TikTok did not return that account. The token must have approved Research API access for public user information.');
    metrics['tt.followers']=Number(user.follower_count||0);metrics['tt.following']=Number(user.following_count||0);metrics['tt.likes']=Number(user.likes_count||0);metrics['tt.videos']=Number(user.video_count||0);
  }
  for(const key of placeholders) if(!Number.isFinite(Number(metrics[key]))) throw new Error(`The ${PLATFORM_LABEL[type]} API did not provide \`<${key}>\`. Remove that placeholder or check API access.`);
  return metrics;
}
async function collectServerStats(guild, placeholders) {
  const metrics={};
  if(placeholders.includes('server.members')) metrics['server.members']=Number(guild.memberCount||0);
  if(placeholders.includes('server.boosts')) metrics['server.boosts']=Number(guild.premiumSubscriptionCount||0);
  const needMembers=placeholders.some(k=>['server.humans','server.bots','server.staff'].includes(k));
  let members=[...guild.members.cache.values()];
  if(needMembers) {
    try { const fetched=await guild.members.fetch({withPresences:false});members=[...fetched.values()]; }
    catch(err) { throw new Error(`I could not fetch members to calculate bots/staff. Ensure the Server Members Intent is enabled in the Discord Developer Portal and the bot has access. (${String(err?.message||err).slice(0,120)})`); }
  }
  if(placeholders.includes('server.humans')) metrics['server.humans']=members.filter(m=>!m.user.bot).length;
  if(placeholders.includes('server.bots')) metrics['server.bots']=members.filter(m=>m.user.bot).length;
  if(placeholders.includes('server.staff')) metrics['server.staff']=members.filter(m=>!m.user.bot&&m.permissions.has(PermissionFlagsBits.Administrator)).length;
  return metrics;
}
async function safeRename(channel, row, wanted) {
  if(channel.name===wanted) { db.updateStatChannel(row.guildId,row.id,{lastValue:wanted,lastCheckedAt:Date.now()}); return {changed:false}; }
  const now=Date.now();
  const persisted=asArray(row.renameHistory).map(Number).filter(t=>Number.isFinite(t)&&now-t<600000);
  const recent=[...new Set([...(renameTimes.get(channel.id)||[]),...persisted])].sort((a,b)=>a-b);
  renameTimes.set(channel.id,recent);
  if(recent.length>=2) {
    if(!renameTimers.has(channel.id)) {
      const delay=Math.max(1000,recent[0]+600000-now+1000);
      const timer=setTimeout(async()=>{renameTimers.delete(channel.id);const latest=db.getStatChannelByChannel(channel.id);if(latest&&botClient)await refreshOne(botClient,latest,true).catch(e=>console.error('[StatSetup] queued rename failed:',e.message));},delay);
      timer.unref?.();renameTimers.set(channel.id,timer);
    }
    db.updateStatChannel(row.guildId,row.id,{lastCheckedAt:Date.now(),renameHistory:JSON.stringify(recent)});
    return {changed:false,queued:true};
  }
  await channel.setName(wanted,'Update tracked statistic channel');
  recent.push(Date.now());renameTimes.set(channel.id,recent);
  db.updateStatChannel(row.guildId,row.id,{lastValue:wanted,lastCheckedAt:Date.now(),renameHistory:JSON.stringify(recent)});
  return {changed:true};
}
async function refreshOne(client,row,force=false) {
  if(!row)return {ok:false,error:'Stat channel record not found.'};
  if(!force&&Date.now()-Number(row.lastCheckedAt||0)<Number(row.intervalMs||SERVER_INTERVAL_DEFAULT)) return {ok:true,skipped:true};
  if(activeRefreshes.has(row.channelId)) return {ok:true,skipped:true};
  activeRefreshes.add(row.channelId);
  try {
    const guild=client.guilds.cache.get(row.guildId)||await client.guilds.fetch(row.guildId).catch(()=>null);
    if(!guild){db.deleteStatChannelByChannel(row.channelId);return {ok:false,deleted:true,error:'The server is no longer available.'};}
    const channel=client.channels.cache.get(row.channelId)||await client.channels.fetch(row.channelId).catch(()=>null);
    if(!channel){db.deleteStatChannelByChannel(row.channelId);console.log(`[StatSetup] Removed deleted channel ${row.channelId} from SQLite.`);return {ok:false,deleted:true,error:'The tracked channel was deleted and its database record was removed.'};}
    if(channel.type!==ChannelType.GuildVoice){db.deleteStatChannelByChannel(row.channelId);return {ok:false,deleted:true,error:'The tracked channel is no longer a voice channel; its database record was removed.'};}
    if(!guild.members.me?.permissions?.has(PermissionFlagsBits.ManageChannels)) throw new Error('Bot is missing Manage Channels to rename the stat channel.');
    const placeholders=asArray(row.placeholder);
    const metrics=row.statType==='server'?await collectServerStats(guild,placeholders):await collectSocialStats(row.statType,row.account,db.getStatApiKey(row.guildId,row.statType),placeholders);
    const wanted=renderTemplate(row.template,metrics,Boolean(row.fullNumbers));
    if(!wanted)throw new Error('The template rendered to an empty channel name. Edit the template in /statsetup.');
    const result=await safeRename(channel,row,wanted);
    if(result.queued) console.log(`[StatSetup] Rename for channel ${channel.id} queued to respect Discord rename limits.`);
    return {ok:true,changed:result.changed,queued:result.queued,name:wanted};
  } catch(err) {
    db.updateStatChannel(row.guildId,row.id,{lastCheckedAt:Date.now()});
    console.error(`[StatSetup] Refresh failed for guild ${row.guildId}, channel ${row.channelId}:`,err.message||err);
    return {ok:false,error:String(err?.message||err)};
  } finally { activeRefreshes.delete(row.channelId); }
}
async function refreshAll(client,force=false) {
  for(const guild of client.guilds.cache.values()) {
    for(const row of db.listStatChannels(guild.id)) await refreshOne(client,row,force).catch(e=>console.error('[StatSetup] Background refresh error:',e.message));
  }
}
function start(client) {
  botClient=client;
  if(started)return;
  started=true;
  refreshAll(client,true).catch(e=>console.error('[StatSetup] Startup reload failed:',e));
  const timer=setInterval(()=>refreshAll(client,false).catch(e=>console.error('[StatSetup] Background pass failed:',e)),60000);
  timer.unref?.();
}
async function handleInteraction(interaction,client) {
  const id=String(interaction.customId||'');
  if(!id.startsWith('statsetup:'))return false;
  try {
    const {error,session,parts}=activeSession(interaction,id);
    if(error)return await responseError(interaction,error).then(()=>true);
    const action=parts[2];
    if(interaction.isChannelSelectMenu?.()&&action==='category') {
      const category=interaction.guild.channels.cache.get(interaction.values[0]);
      if(!category||category.type!==ChannelType.GuildCategory)return await responseError(interaction,'The selected category no longer exists. Choose a valid category.').then(()=>true);
      session.categoryId=category.id;
      const payload=session.step==='social'?socialSelectPayload(session):session.step==='server'?serverTypesPayload(session):session.step==='manage'?managePayload(session,session.page):initialPayload(session);
      await updatePanel(interaction,session,payload);return true;
    }
    if(interaction.isStringSelectMenu?.()&&action==='mode') {
      session.mode=interaction.values[0];session.step=session.mode;
      await updatePanel(interaction,session,session.mode==='social'?socialSelectPayload(session):serverTypesPayload(session));return true;
    }
    if(interaction.isStringSelectMenu?.()&&action==='platform') {
      const platform=interaction.values[0];if(!PLATFORM_PREFIX[platform])return await responseError(interaction,'Unsupported social platform.').then(()=>true);
      session.platform=platform;
      return await interaction.showModal(socialModal(session,platform)).then(()=>true);
    }
    if(interaction.isStringSelectMenu?.()&&action==='server-types') {
      session.selectedStats=[...interaction.values];
      await updatePanel(interaction,session,serverTypesPayload(session));return true;
    }
    if(interaction.isStringSelectMenu?.()&&action==='manage-select') {
      session.selectedStatId=Number(interaction.values[0]);
      await updatePanel(interaction,session,managePayload(session,session.page));return true;
    }
    if(interaction.isButton?.()) {
      if(action==='cancel') {
        if(session.timer)clearTimeout(session.timer);sessions.delete(sessionKey(session.guildId,session.userId));
        return await interaction.update({embeds:[ui.base('Stat Setup Cancelled').setDescription('No changes were made.')],components:[]}).then(()=>true);
      }
      if(action==='manage') {session.step='manage';session.selectedStatId=db.listStatChannels(session.guildId)[0]?.id||null;return await updatePanel(interaction,session,managePayload(session,1)).then(()=>true);}
      if(action==='back') {session.step='initial';session.mode=null;return await updatePanel(interaction,session,initialPayload(session)).then(()=>true);}
      if(action==='continue') {if(!session.selectedStats.length)return await responseError(interaction,'Select at least one server stat type first.').then(()=>true);return await interaction.showModal(serverModal(session)).then(()=>true);}
      if(action==='page-first') return await updatePanel(interaction,session,managePayload(session,1)).then(()=>true);
      if(action==='page-prev') return await updatePanel(interaction,session,managePayload(session,Math.max(1,session.page-1))).then(()=>true);
      if(action==='page-next') return await updatePanel(interaction,session,managePayload(session,session.page+1)).then(()=>true);
      if(action==='page-last') return await updatePanel(interaction,session,managePayload(session,Math.ceil(db.listStatChannels(session.guildId).length/5)||1)).then(()=>true);
      if(action==='page-indicator') return await responseError(interaction,'Use First, Previous, Next, or Last to change the page.').then(()=>true);
      const row=db.getStatChannel(session.guildId,session.selectedStatId);
      if(['edit','interval','refresh','full','delete','delete-confirm','delete-cancel'].includes(action)&&!row)return await responseError(interaction,'That stat channel record no longer exists. Refresh the Manage panel.').then(()=>true);
      if(action==='edit') {
        return await interaction.showModal(new ModalBuilder().setCustomId(sessionCustomId(session.userId,'edit-modal',String(row.id))).setTitle('Edit Stat Template').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('template').setLabel('Channel name template').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500).setValue(String(row.template).slice(0,500))))).then(()=>true);
      }
      if(action==='interval') {
        const mins=Math.round(Number(row.intervalMs)/60000);
        return await interaction.showModal(new ModalBuilder().setCustomId(sessionCustomId(session.userId,'interval-modal',String(row.id))).setTitle('Change Update Interval').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('minutes').setLabel(row.statType==='server'?'Minutes (5–1440)':'Minutes (10–1440)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(4).setValue(String(mins))))).then(()=>true);
      }
      if(action==='refresh') {
        await interaction.deferUpdate();
        const outcome=await refreshOne(client,row,true);
        if(!outcome.ok)return await interaction.followUp({embeds:[ui.errorEmbed('Refresh Failed',outcome.error||'The stat could not be refreshed.')],ephemeral:true}).then(()=>true);
        session.step='manage';const payload=managePayload(session,session.page);rememberPayload(session,payload);await interaction.editReply(payload).catch(()=>{});
        return true;
      }
      if(action==='full') {
        db.updateStatChannel(session.guildId,row.id,{fullNumbers:row.fullNumbers?0:1});
        const outcome=await refreshOne(client,db.getStatChannel(session.guildId,row.id),true);
        if(!outcome.ok) console.error('[StatSetup] Toggle number format refresh failed:',outcome.error);
        return await updatePanel(interaction,session,managePayload(session,session.page)).then(()=>true);
      }
      if(action==='delete') {
        const confirm=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'delete-confirm')).setLabel('Delete Channel').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId(sessionCustomId(session.userId,'delete-cancel')).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
        return await updatePanel(interaction,session,{embeds:[ui.warnEmbed('Delete Stat Channel',`Delete <#${row.channelId}> and remove its tracking record? This cannot be undone.`)],components:[confirm]}).then(()=>true);
      }
      if(action==='delete-cancel')return await updatePanel(interaction,session,managePayload(session,session.page)).then(()=>true);
      if(action==='delete-confirm') {
        const channel=client.channels.cache.get(row.channelId)||await client.channels.fetch(row.channelId).catch(()=>null);
        if(channel) {
          if(!userCanManage(interaction))return await responseError(interaction,'You need both **Manage Channels** and **Manage Server** to delete a tracked stat channel.').then(()=>true);
          if(!guildCanManageChannels(interaction.guild))return await responseError(interaction,'I no longer have **Manage Channels** to delete this voice channel. The database record was not removed.').then(()=>true);
          try{await channel.delete(`Stat channel removed by ${interaction.user.tag}`);}catch(e){return await responseError(interaction,`Discord rejected the channel deletion: ${e.message||'missing permissions or hierarchy restriction'}. The database record was kept.`).then(()=>true);}
        }
        db.deleteStatChannel(session.guildId,row.id);session.selectedStatId=null;
        return await updatePanel(interaction,session,managePayload(session,session.page)).then(()=>true);
      }
    }
    if(interaction.isModalSubmit?.()) {
      if(action==='social-modal'||action==='server-modal') {
        const type=action==='social-modal'?session.platform:'server';
        const template=interaction.fields.getTextInputValue('template').trim();
        const account=type==='server'?null:interaction.fields.getTextInputValue('account').trim();
        const apiKey=type==='server'?null:interaction.fields.getTextInputValue('api_key').trim();
        const selected=type==='server'?session.selectedStats:[];
        const validation=validateTemplate(template,type,selected);
        if(validation.error)return await responseError(interaction,validation.error).then(()=>true);
        if(type!=='server'&&!apiKey)return await responseError(interaction,`A valid API credential is required for ${PLATFORM_LABEL[type]}.`).then(()=>true);
        await interaction.deferReply({ephemeral:true});
        try {
          const result=await createTrackedChannel(interaction,session,{type,template,account,placeholders:validation.used,apiKey});
          session.step='manage';session.selectedStatId=result.row.id;
          // Replace the original panel in place, and use the private modal response for the success/error detail.
          const current=managePayload(session,Math.max(1,Math.ceil(Number(result.row.id)/5)));
          session.embeds=current.embeds;session.components=current.components;
          if(session.panelMessage?.edit)await session.panelMessage.edit(current).catch(()=>{});
          await interaction.editReply({embeds:[ui.okEmbed('Stat Channel Created',`${result.channel} now displays:\n\`${result.name}\`\n\nUpdates every ${Math.round(result.row.intervalMs/60000)} minutes. Use the Manage button to edit, refresh, or delete it.`)]});
        } catch(err) {
          console.error('[StatSetup] Create failed:',err);
          await interaction.editReply({embeds:[ui.errorEmbed('Stat Channel Not Created',String(err?.message||err).slice(0,1800))]});
        }
        beginSessionTimeout(session);
        return true;
      }
      if(action==='edit-modal'||action==='interval-modal') {
        const statId=Number(parts[3]);const row=db.getStatChannel(session.guildId,statId);
        if(!row)return await responseError(interaction,'That stat channel was deleted while the form was open.').then(()=>true);
        if(action==='edit-modal') {
          const template=interaction.fields.getTextInputValue('template').trim();
          const validation=validateTemplate(template,row.statType,[]);
          if(validation.error)return await responseError(interaction,validation.error).then(()=>true);
          db.updateStatChannel(session.guildId,row.id,{template,placeholder:JSON.stringify(validation.used)});
        } else {
          const raw=interaction.fields.getTextInputValue('minutes').trim();const minutes=Number(raw);const min=row.statType==='server'?5:10;
          if(!Number.isInteger(minutes)||minutes<min||minutes>1440)return await responseError(interaction,`Enter a whole number from **${min} to 1440** minutes.`).then(()=>true);
          db.updateStatChannel(session.guildId,row.id,{intervalMs:minutes*60000,lastCheckedAt:0});
        }
        const latest=db.getStatChannel(session.guildId,row.id);
        const result=await refreshOne(client,latest,true);
        const payload=managePayload(session,session.page);session.embeds=payload.embeds;session.components=payload.components;
        await interaction.reply({embeds:[result.ok?ui.okEmbed('Stat Channel Updated','The setting was saved and the stat channel was refreshed.'):ui.errorEmbed('Setting Saved, Refresh Failed',`The setting was saved, but the live refresh failed: ${result.error}`)],ephemeral:true});
        if(session.panelMessage?.edit)await session.panelMessage.edit(payload).catch(()=>{});
        return true;
      }
    }
    return false;
  } catch(err) {
    console.error('[StatSetup] Interaction failed:',err);
    const payload={embeds:[ui.errorEmbed('Stat Setup Error',String(err?.message||err).slice(0,1500))],ephemeral:true};
    if(interaction.deferred||interaction.replied)await interaction.followUp(payload).catch(()=>{});else await interaction.reply(payload).catch(()=>{});
    return true;
  }
}
function guildCanManageChannels(guild) { return Boolean(guild?.members?.me?.permissions?.has(PermissionFlagsBits.ManageChannels)); }
module.exports={command,handleInteraction,start,refreshAll,refreshOne,validateTemplate,ALL_PLACEHOLDERS};
