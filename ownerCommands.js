// Owner-only operations backed by the bot's existing SQLite database.
// Dangerous actions use short-lived, author-bound confirmation sessions.
const {
  SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, StringSelectMenuBuilder, AttachmentBuilder
} = require('discord.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const store = require('./database');
const ui = require('./ui');
const sql = store.db;

const commands = [];
const pendingActions = new Map();
const listSessions = new Map();
const backupCooldowns = new Map();
let commandRegistry = [];
const TIMEOUT_MS = 30_000;
const BACKUP_MAX_BYTES = Math.max(1, Number(process.env.DISCORD_UPLOAD_LIMIT_BYTES) || 24 * 1024 * 1024);
const MAIN_OWNER = String(process.env.OWNER_ID || (process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean)[0] || '').trim();
const LEGACY_OWNER_IDS = new Set((process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
const TEXT_ALIASES = new Map([
  ['i','invites'],['invite','invites'],['si','serverinfo'],['server','serverinfo'],['av','avatar'],['pfp','avatar'],
  ['ui','userinfo'],['user','userinfo'],['ss','serverstats'],['stats','serverstats'],['lb','leaderboard'],['lbs','leaderboards'],
  ['rank','rank'],['help','help'],['h','help'],['ga','giveaway']
]);
const PROTECTED_COMMANDS = new Set(['help','ownerhelp','commandtoggle','owneradd','ownerremove','restore','resetguild']);

function isMainOwner(userId) { return Boolean(userId && MAIN_OWNER && String(userId) === MAIN_OWNER); }
function isOwner(userId) {
  if (!userId) return false;
  if (isMainOwner(userId) || LEGACY_OWNER_IDS.has(String(userId))) return true;
  try { return Boolean(store.getCoOwner(String(userId))); } catch { return false; }
}
function setCommandRegistry(commandsList) { commandRegistry = Array.isArray(commandsList) ? commandsList : []; }
function canonicalName(input) {
  const name = String(input || '').trim().toLowerCase().replace(/^\//, '');
  return TEXT_ALIASES.get(name) || name;
}
function commandKnown(name) { return commandRegistry.some(c => String(c?.data?.name || '').toLowerCase() === canonicalName(name)); }
function isCommandProtected(name) {
  const canonical = canonicalName(name);
  const item = commandRegistry.find(c => String(c?.data?.name || '').toLowerCase() === canonical);
  return PROTECTED_COMMANDS.has(canonical) || Boolean(item?.ownerOnly);
}
function safeJson(value, max = 20000) { try { return JSON.stringify(value, null, 2).slice(0, max); } catch { return '{}'; } }
function quoteIdentifier(name) { return `"${String(name).replace(/"/g, '""')}"`; }
function allUserTables(db = sql) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
}
function tableColumns(table, schema = 'main', db = sql) {
  const safe = quoteIdentifier(table);
  const rows = db.prepare(`PRAGMA ${schema}.table_info(${safe})`).all();
  return rows.map(r => r.name);
}
function tablesWithGuildId(db = sql) {
  return allUserTables(db).map(name => ({ name, columns: tableColumns(name, 'main', db) })).filter(t => t.columns.includes('guildId'));
}
function guildTableCounts(guildId, db = sql) {
  const id = String(guildId);
  const counts = {};
  for (const table of tablesWithGuildId(db)) {
    try { counts[table.name] = Number(db.prepare(`SELECT COUNT(*) AS n FROM main.${quoteIdentifier(table.name)} WHERE guildId=?`).get(id)?.n || 0); }
    catch (error) { console.warn(`[OwnerTools] Could not count ${table.name} for guild ${id}:`, error.message); }
  }
  return counts;
}
function serializeGuildData(guildId) {
  const excluded = new Set(['stat_api_keys', 'owner_command_logs', 'bot_errors']);
  const data = { exportedAt: new Date().toISOString(), guildId: String(guildId), tables: {} };
  for (const table of tablesWithGuildId()) {
    if (excluded.has(table.name)) continue; // API credentials and private operational logs are never exported.
    try { data.tables[table.name] = sql.prepare(`SELECT * FROM main.${quoteIdentifier(table.name)} WHERE guildId=?`).all(String(guildId)); }
    catch (error) { console.warn(`[OwnerTools] Could not export ${table.name}:`, error.message); }
  }
  return data;
}
function deleteGuildData(guildId) {
  const id = String(guildId), counts = guildTableCounts(id);
  const tx = sql.transaction(() => {
    for (const table of tablesWithGuildId()) sql.prepare(`DELETE FROM main.${quoteIdentifier(table.name)} WHERE guildId=?`).run(id);
  });
  tx();
  return counts;
}
function guildIdsWithData() {
  const ids = new Set();
  for (const table of tablesWithGuildId()) {
    try { for (const row of sql.prepare(`SELECT DISTINCT guildId FROM main.${quoteIdentifier(table.name)} WHERE guildId IS NOT NULL AND guildId<>''`).all()) ids.add(String(row.guildId)); }
    catch (error) { console.warn(`[OwnerTools] Could not scan ${table.name}:`, error.message); }
  }
  return [...ids];
}
function countTable(table) {
  try { return Number(sql.prepare(`SELECT COUNT(*) AS n FROM main.${quoteIdentifier(table)}`).get()?.n || 0); }
  catch { return 0; }
}
function databaseSize() {
  let size = 0;
  for (const file of [store.DB_PATH, `${store.DB_PATH}-wal`, `${store.DB_PATH}-shm`]) {
    try { size += fs.statSync(file).size; } catch {}
  }
  return size;
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB','MB','GB','TB']; let n = bytes / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}
function shorten(value, length = 180) { return String(value ?? '—').replace(/\s+/g, ' ').slice(0, length) || '—'; }
function argsForLog(interaction) {
  try {
    const data = interaction.options?.data || [];
    const flatten = list => list.map(opt => ({ name: opt.name, value: opt.value, options: opt.options ? flatten(opt.options) : undefined }));
    return { options: flatten(data) };
  } catch { return {}; }
}
async function logOwnerUse(interaction, commandName) {
  const args = argsForLog(interaction);
  try { store.logOwnerCommand(interaction.user.id, commandName, args, interaction.guildId || ''); }
  catch (error) { console.error('[OwnerTools] Could not store owner command log:', error); }
  const channelId = process.env.OWNER_COMMAND_LOG_CHANNEL_ID || process.env.OWNER_LOG_CHANNEL_ID || null;
  if (!channelId) return;
  const channel = interaction.client?.channels?.cache?.get(channelId) || await interaction.client?.channels?.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  const embed = ui.infoEmbed('🔐 Owner Command Used', `**Command:** /${commandName}\n**User:** ${interaction.user.tag || interaction.user.id} (\`${interaction.user.id}\`)\n**Guild:** ${interaction.guild?.name || 'DM'} (\`${interaction.guildId || 'none'}\`)\n**Arguments:** \`${shorten(safeJson(args, 1000), 700)}\`\n**Time:** <t:${Math.floor(Date.now()/1000)}:F>`);
  await channel.send({ embeds: [embed] }).catch(error => console.warn('[OwnerTools] Could not send private command log:', error.message));
}
function saveError(error, context = '', interaction = null) {
  const err = error instanceof Error ? error : new Error(String(error));
  try {
    store.addBotError({
      commandName: interaction?.commandName || (String(context).startsWith('Command /') ? String(context).slice(9) : null),
      eventName: context && !String(context).startsWith('Command /') ? context : null,
      guildId: interaction?.guildId || null, userId: interaction?.user?.id || null,
      message: err.message || String(err), stack: err.stack || String(err)
    });
  } catch (dbError) { console.error('[OwnerTools] Could not save error to SQLite:', dbError); }
}
function makeActionRow(token, options) {
  return new ActionRowBuilder().addComponents(options.map(option => new ButtonBuilder()
    .setCustomId(`ownerx:confirm:${token}:${option.value}`).setLabel(option.label).setStyle(option.style || ButtonStyle.Secondary).setEmoji(option.emoji)));
}
function disableComponents(rows) {
  for (const row of rows || []) for (const component of row.components || []) {
    try { if (typeof component.setDisabled === 'function') component.setDisabled(true); } catch {}
  }
  return rows || [];
}
async function sendConfirmation(interaction, { title, description, options, actionMap, timeoutMs = TIMEOUT_MS }) {
  if (!isOwner(interaction.user?.id)) return interaction.reply({ embeds: [ui.errorEmbed('Owner Only', 'This command is owner-only.')], ephemeral: true });
  const token = require('crypto').randomBytes(8).toString('hex');
  const components = [makeActionRow(token, options)];
  const record = { userId: interaction.user.id, guildId: interaction.guildId || '', actionMap, components, message: null, timer: null, title };
  pendingActions.set(token, record);
  const payload = { embeds: [ui.warnEmbed(title, `${description}\n\nThis confirmation expires in ${Math.ceil(timeoutMs/1000)} seconds.`)], components, ephemeral: true };
  if (typeof interaction.fetchReply === 'function') payload.fetchReply = true;
  const result = await interaction.reply(payload);
  if (result?.edit) record.message = result;
  else if (typeof interaction.fetchReply === 'function') record.message = await interaction.fetchReply().catch(() => null);
  record.timer = setTimeout(async () => {
    if (!pendingActions.has(token)) return;
    pendingActions.delete(token);
    disableComponents(record.components);
    if (record.message?.edit) await record.message.edit({ embeds: [ui.warnEmbed('Confirmation Expired', 'Run the command again to start a new confirmation.')], components: record.components }).catch(() => {});
  }, timeoutMs);
  record.timer.unref?.();
  return result;
}
function openListSession(interaction, type, payload) {
  return { userId: interaction.user.id, guildId: interaction.guildId || '', type, payload, page: 1, message: null, timer: null, components: [] };
}
async function sendListPanel(interaction, session, build) {
  const token = require('crypto').randomBytes(7).toString('hex');
  session.token = token;
  const payload = build(session, token);
  session.components = payload.components || [];
  listSessions.set(token, session);
  const data = { ...payload, ephemeral: true };
  if (typeof interaction.fetchReply === 'function') data.fetchReply = true;
  const result = await interaction.reply(data);
  if (result?.edit) session.message = result;
  else if (typeof interaction.fetchReply === 'function') session.message = await interaction.fetchReply().catch(() => null);
  session.timer = setTimeout(async () => {
    if (!listSessions.has(token)) return;
    listSessions.delete(token);
    disableComponents(session.components);
    if (session.message?.edit) await session.message.edit({ embeds: [ui.warnEmbed('Panel Expired', 'Run the command again to view current results.')], components: session.components }).catch(() => {});
  }, 120_000);
  session.timer.unref?.();
  return result;
}
function pageRows(token, page, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ownerx:page:${token}:first`).setLabel('First').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`ownerx:page:${token}:prev`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`ownerx:page:${token}:indicator`).setLabel(`${page}/${total}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`ownerx:page:${token}:next`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= total),
    new ButtonBuilder().setCustomId(`ownerx:page:${token}:last`).setLabel('Last').setStyle(ButtonStyle.Secondary).setDisabled(page >= total)
  );
}
function coOwnersPayload(session, token) {
  const all = store.listCoOwners(), perPage = 8, total = Math.max(1, Math.ceil(all.length/perPage));
  session.page = Math.min(total, Math.max(1, session.page));
  const rows = all.slice((session.page-1)*perPage, session.page*perPage);
  const description = rows.map((row,i)=>`**${(session.page-1)*perPage+i+1}.** <@${row.userId}> (\`${row.userId}\`)\n• Added: <t:${Math.floor(row.addedAt/1000)}:D>\n• Added by: <@${row.addedBy}>`).join('\n\n') || 'No co-owners have been added.';
  return { embeds: [ui.infoEmbed('👑 Co-Owners', description).setFooter({ text: `Page ${session.page}/${total} • ${all.length} co-owner(s)` })], components: [pageRows(token,session.page,total)] };
}
function errorListPayload(session, token) {
  const filter = session.payload.commandName || null, allCount = store.countBotErrors(filter), perPage = 5, total = Math.max(1, Math.ceil(allCount/perPage));
  session.page = Math.min(total, Math.max(1,session.page));
  const rows = store.getBotErrors(perPage,(session.page-1)*perPage,filter);
  const embed = ui.base(filter ? `🧯 Recent Errors — ${filter}` : '🧯 Recent Bot Errors')
    .setDescription(rows.map(row=>`**#${row.id}** • <t:${Math.floor(row.timestamp/1000)}:R>\n**Source:** \`${shorten(row.commandName || row.eventName || 'unknown',80)}\` • **Guild:** \`${row.guildId || '—'}\`\n**User:** ${row.userId ? `<@${row.userId}>` : '—'}\n${shorten(row.message,240)}`).join('\n\n') || 'No errors have been recorded.')
    .setFooter({ text:`Page ${session.page}/${total} • ${allCount} error(s)` });
  const actions = rows.slice(0,4).map(row=>new ButtonBuilder().setCustomId(`ownerx:errorfull:${token}:${row.id}`).setLabel(`View #${row.id}`).setStyle(ButtonStyle.Secondary));
  const components = [];
  if(actions.length) components.push(new ActionRowBuilder().addComponents(actions));
  components.push(pageRows(token,session.page,total));
  return { embeds: [embed], components };
}
function commandStatsPayload(session, token) {
  const period = session.payload.period || 'all';
  const guildId = session.payload.guildId || '';
  const now = Date.now();
  const fromDay = period === 'today' ? new Date(now).toISOString().slice(0,10) : period === 'week' ? new Date(now-7*86400000).toISOString().slice(0,10) : '0000-01-01';
  const where = ['day>=?']; const params = [fromDay];
  if (guildId) { where.push('guildId=?'); params.push(guildId); }
  const rows = sql.prepare(`SELECT commandName, SUM(count) AS count, SUM(successCount) AS successCount, SUM(failCount) AS failCount, MAX(lastUsed) AS lastUsed FROM command_usage_daily WHERE ${where.join(' AND ')} GROUP BY commandName ORDER BY count DESC, commandName ASC`).all(...params);
  const perPage = 10, total = Math.max(1,Math.ceil(rows.length/perPage));
  session.page = Math.min(total,Math.max(1,session.page));
  const slice=rows.slice((session.page-1)*perPage,session.page*perPage);
  const desc=slice.map((r,i)=>{
    const uses=Number(r.count)||0, fails=Number(r.failCount)||0, success=Number(r.successCount)||0;
    const failRate=uses ? `${(fails/uses*100).toFixed(1)}%` : '0%';
    return `**${(session.page-1)*perPage+i+1}. /${r.commandName}** — **${uses.toLocaleString()}** uses\n• Success: ${success.toLocaleString()} • Failed: ${fails.toLocaleString()} (${failRate})\n• Last used: ${r.lastUsed ? `<t:${Math.floor(r.lastUsed/1000)}:R>` : 'never'}`;
  }).join('\n\n') || 'No command uses have been recorded for this filter yet.';
  return { embeds:[ui.infoEmbed('📈 Command Usage',desc).setFooter({text:`${period} • ${guildId ? `Guild ${guildId} • ` : ''}Page ${session.page}/${total}`})],components:[pageRows(token,session.page,total)] };
}
function disabledCommandsPayload(session, token) {
  const all=store.listDisabledCommands(), perPage=8, total=Math.max(1,Math.ceil(all.length/perPage));
  session.page=Math.min(total,Math.max(1,session.page));
  const rows=all.slice((session.page-1)*perPage,session.page*perPage);
  const desc=rows.map((r,i)=>`**${(session.page-1)*perPage+i+1}. /${r.commandName}**\n• Reason: ${shorten(r.reason||'No reason provided',160)}\n• Disabled by: <@${r.disabledBy}> • <t:${Math.floor(r.disabledAt/1000)}:R>`).join('\n\n') || 'No commands are disabled.';
  return {embeds:[ui.infoEmbed('🚦 Disabled Commands',desc).setFooter({text:`Page ${session.page}/${total} • ${all.length} disabled command(s)`})],components:[pageRows(token,session.page,total)]};
}
function ownerHelpPayload(userId, category='overview') {
  const categories = {
    overview: ['Owner-only command index. Only the main owner can manage co-owners, restore the database, or reset a guild.'],
    owners: ['owneradd','ownerremove','owners'], database: ['backup','restore','resetguild','dbstats','cleanup','export'],
    monitoring: ['stats','errors'], commands: ['commandstats','commandtoggle'], existing: ['bl','maintenance','blacklist','emoji','em','ms','ownerlogsetup']
  };
  const names = categories[category] || categories.overview;
  const list = category === 'overview' ? ['owners','database','monitoring','commands','existing']
    .flatMap(k => categories[k]).filter(n=>commandRegistry.some(c=>c.data.name===n && c.ownerOnly)) : names;
  const commandsText = list.map(name=>{
    const cmd=commandRegistry.find(c=>c.data.name===name && c.ownerOnly);
    return cmd ? `**/${name}** — ${cmd.data.description || 'Owner command'}` : null;
  }).filter(Boolean);
  const embed=ui.infoEmbed('🔐 Owner Control Center',commandsText.join('\n').slice(0,3900) || 'No commands in this category.');
  const select=new StringSelectMenuBuilder().setCustomId(`ownerx:help:${userId}`).setPlaceholder('Choose an owner-tool category').addOptions(
    {label:'Overview',value:'overview',emoji:'🏠'}, {label:'Owners',value:'owners',emoji:'👑'},
    {label:'Database',value:'database',emoji:'💾'}, {label:'Monitoring',value:'monitoring',emoji:'🧯'},
    {label:'Command controls',value:'commands',emoji:'🚦'}, {label:'Existing owner tools',value:'existing',emoji:'🛠️'}
  );
  return {embeds:[embed],components:[new ActionRowBuilder().addComponents(select)]};
}
async function sendJsonDm(user, object, filename, explanation='Here is your private data export.') {
  const buffer=Buffer.from(JSON.stringify(object,null,2),'utf8');
  if(buffer.length>BACKUP_MAX_BYTES) throw new Error(`The export is ${formatBytes(buffer.length)}, above the configured upload limit (${formatBytes(BACKUP_MAX_BYTES)}). Use the database backup command or raise DISCORD_UPLOAD_LIMIT_BYTES.`);
  try { await user.send({content:explanation,files:[new AttachmentBuilder(buffer,{name:filename})]}); }
  catch(error) { throw new Error(`Could not deliver the private file in your DMs (${String(error?.message||error).slice(0,220)}). Enable DMs from this bot and retry; no data was deleted.`); }
}
async function createDatabaseSnapshot() {
  const target=path.join(os.tmpdir(),`aunxz-backup-${Date.now()}-${process.pid}.sqlite`);
  await sql.backup(target);
  let buffer=await fs.promises.readFile(target);
  let filename=path.basename(target);
  await fs.promises.unlink(target).catch(()=>{});
  if(buffer.length>8*1024*1024) { buffer=zlib.gzipSync(buffer,{level:9}); filename=filename+'.gz'; }
  if(buffer.length>BACKUP_MAX_BYTES) throw new Error(`Backup size ${formatBytes(buffer.length)} exceeds the configured Discord upload limit (${formatBytes(BACKUP_MAX_BYTES)}). Raise DISCORD_UPLOAD_LIMIT_BYTES or copy the SQLite database from the host volume.`);
  return {buffer,filename,size:buffer.length};
}
async function createDbBackupFile(targetPath) { await sql.backup(targetPath); return targetPath; }
async function downloadAttachment(attachment, targetPath) {
  if(!attachment?.url) throw new Error('Attach a SQLite backup file to `/restore` (or to the `!restore` prefix message).');
  if(Number(attachment.size||0)>BACKUP_MAX_BYTES) throw new Error(`The attached file exceeds the configured upload limit of ${formatBytes(BACKUP_MAX_BYTES)}.`);
  const response=await fetch(attachment.url,{signal:AbortSignal.timeout(30000)}).catch(e=>{throw new Error(`Could not download the backup attachment: ${e.message}`);});
  if(!response.ok) throw new Error(`Discord file download failed with HTTP ${response.status}.`);
  let buffer=Buffer.from(await response.arrayBuffer());
  if(buffer.length>BACKUP_MAX_BYTES) throw new Error(`The downloaded file exceeds the configured upload limit of ${formatBytes(BACKUP_MAX_BYTES)}.`);
  if(/\.gz$/i.test(String(attachment.name||''))) {
    try { buffer=zlib.gunzipSync(buffer); } catch { throw new Error('The `.gz` backup is not a valid gzip file.'); }
  }
  if(buffer.length>BACKUP_MAX_BYTES*4) throw new Error('The decompressed backup is too large to validate safely.');
  await fs.promises.writeFile(targetPath,buffer,{flag:'wx'});
  return targetPath;
}
function validateSqliteBackup(filePath) {
  const Database=require('better-sqlite3');
  let probe;
  try {
    probe=new Database(filePath,{readonly:true,fileMustExist:true});
    const integrity=probe.pragma('integrity_check',{simple:true});
    if(integrity!=='ok') throw new Error(`SQLite integrity check failed: ${integrity}`);
    const tables=probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name);
    if(!tables.includes('guild_config') || !tables.includes('levels')) throw new Error('This is a SQLite file, but it is not a compatible AunXz backup (required tables are missing).');
    return {tables};
  } catch(error) {
    if(error?.message?.includes('compatible AunXz backup') || error?.message?.includes('integrity check')) throw error;
    throw new Error(`The attachment is not a valid AunXz SQLite backup: ${String(error?.message||error).slice(0,250)}`);
  } finally { try { probe?.close(); } catch {} }
}
async function replaceDatabaseContents(sourcePath) {
  const validation=validateSqliteBackup(sourcePath);
  const sourceSet=new Set(validation.tables);
  const currentTables=allUserTables();
  const backupTables=validation.tables;
  const probeDb=require('better-sqlite3');
  const probe=new probeDb(sourcePath,{readonly:true,fileMustExist:true});
  try {
    for(const table of currentTables) {
      if(!sourceSet.has(table)) continue;
      const currentColumns=tableColumns(table,'main',sql).sort();
      const sourceColumns=tableColumns(table,'main',probe).sort();
      if(currentColumns.join('\0')!==sourceColumns.join('\0')) {
        throw new Error(`Backup schema for table ${table} does not match this bot version. The current database was not changed.`);
      }
    }
  } finally { probe.close(); }
  const safetyPath=`${store.DB_PATH}.safety-${Date.now()}.sqlite`;
  await createDbBackupFile(safetyPath);
  let attached=false;
  try {
    sql.pragma('foreign_keys = OFF');
    sql.prepare('ATTACH DATABASE ? AS restore_source').run(sourcePath);
    attached=true;
    const sourceNow=new Set(sql.prepare("SELECT name FROM restore_source.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name));
    const tx=sql.transaction(()=>{
      for(const table of currentTables) {
        sql.exec(`DELETE FROM main.${quoteIdentifier(table)}`);
        if(!sourceNow.has(table)) continue;
        const columns=tableColumns(table,'main',sql);
        const list=columns.map(quoteIdentifier).join(',');
        sql.exec(`INSERT INTO main.${quoteIdentifier(table)} (${list}) SELECT ${list} FROM restore_source.${quoteIdentifier(table)}`);
      }
    });
    tx();
    return safetyPath;
  } catch(error) {
    console.error('[OwnerTools] Database restore failed; SQLite transaction rolled back:',error);
    throw new Error(`Restore failed and the existing database was rolled back. A safety backup is available at \`${safetyPath}\`. Reason: ${String(error?.message||error).slice(0,350)}`);
  } finally {
    if(attached) try { sql.exec('DETACH DATABASE restore_source'); } catch {}
    sql.pragma('foreign_keys = ON');
  }
}
function countsDescription(counts) {
  const rows=Object.entries(counts).filter(([,n])=>n>0).sort((a,b)=>b[1]-a[1]);
  if(!rows.length) return 'No stored rows were found for this server.';
  return rows.slice(0,28).map(([name,n])=>`• **${name}**: ${Number(n).toLocaleString()}`).join('\n').slice(0,3800);
}
function cleanupPreview(client) {
  const live=new Set(client.guilds.cache.keys());
  return guildIdsWithData().filter(id=>!live.has(id)).map(guildId=>({guildId,counts:guildTableCounts(guildId)})).filter(x=>Object.values(x.counts).some(n=>n>0));
}
function ownerGuard(interaction, mainOnly=false) {
  if(mainOnly ? isMainOwner(interaction.user?.id) : isOwner(interaction.user?.id)) return true;
  interaction.reply({embeds:[ui.errorEmbed('Owner Only','This command is owner-only.')],ephemeral:true}).catch(()=>{});
  return false;
}
function ownerCommand(builder, execute) {
  builder.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
  commands.push({ownerOnly:true,data:builder,async execute(interaction){
    if(!ownerGuard(interaction, ['owneradd','ownerremove','restore','resetguild'].includes(builder.name))) return;
    await logOwnerUse(interaction, builder.name);
    return execute(interaction);
  }});
}

// /owneradd and /ownerremove — main owner only; mutations require a second confirmation.
ownerCommand(new SlashCommandBuilder().setName('owneradd').setDescription('[Owner] Add a co-owner after confirmation.')
  .addUserOption(o=>o.setName('user').setDescription('Person to add as co-owner').setRequired(true)), async interaction=>{
  const user=interaction.options.getUser('user',true);
  if(user.bot) return interaction.reply({embeds:[ui.errorEmbed('Invalid Co-Owner','Bots cannot be co-owners.')],ephemeral:true});
  if(isMainOwner(user.id)) return interaction.reply({embeds:[ui.errorEmbed('Invalid Co-Owner','The main owner cannot be added as a co-owner.')],ephemeral:true});
  if(store.getCoOwner(user.id)) return interaction.reply({embeds:[ui.errorEmbed('Already Added',`${user} is already a co-owner.`)],ephemeral:true});
  return sendConfirmation(interaction,{title:'Add Co-Owner',description:`Add ${user} (\`${user.id}\`) as a co-owner? They will gain access to owner tools except main-owner-only operations.`,options:[{label:'Confirm Add',value:'yes',style:ButtonStyle.Danger},{label:'Cancel',value:'no'}],actionMap:{yes:async()=>{store.addCoOwner(user.id,interaction.user.id);return ui.okEmbed('Co-Owner Added',`${user} was added as a co-owner.`);},no:async()=>ui.infoEmbed('Cancelled','No changes were made.')}});
});
ownerCommand(new SlashCommandBuilder().setName('ownerremove').setDescription('[Owner] Remove a co-owner after confirmation.')
  .addUserOption(o=>o.setName('user').setDescription('Person to remove as co-owner').setRequired(true)),async interaction=>{
  const user=interaction.options.getUser('user',true);
  if(isMainOwner(user.id)) return interaction.reply({embeds:[ui.errorEmbed('Protected Owner','The main owner cannot be removed.')],ephemeral:true});
  if(!store.getCoOwner(user.id)) return interaction.reply({embeds:[ui.errorEmbed('Not a Co-Owner',`${user} is not in the co-owner list.`)],ephemeral:true});
  return sendConfirmation(interaction,{title:'Remove Co-Owner',description:`Remove ${user} from the co-owner list?`,options:[{label:'Confirm Remove',value:'yes',style:ButtonStyle.Danger},{label:'Cancel',value:'no'}],actionMap:{yes:async()=>{store.removeCoOwner(user.id);return ui.okEmbed('Co-Owner Removed',`${user} was removed from the co-owner list.`);},no:async()=>ui.infoEmbed('Cancelled','No changes were made.')}});
});
ownerCommand(new SlashCommandBuilder().setName('owners').setDescription('[Owner] List co-owners with added dates.' )
  .addSubcommand(s=>s.setName('list').setDescription('View co-owners and who added them.')),async interaction=>{
  const session=openListSession(interaction,'owners',{});return sendListPanel(interaction,session,coOwnersPayload);
});

// Private database backup sent directly to the executor's DMs.
ownerCommand(new SlashCommandBuilder().setName('backup').setDescription('[Owner] Create a private backup of the SQLite database.'),async interaction=>{
  const until=backupCooldowns.get(interaction.user.id)||0;
  if(until>Date.now()) return interaction.reply({embeds:[ui.warnEmbed('Backup Cooldown',`Try again <t:${Math.ceil(until/1000)}:R>.`)],ephemeral:true});
  backupCooldowns.set(interaction.user.id,Date.now()+60_000);
  await interaction.deferReply({ephemeral:true});
  try {
    const backup=await createDatabaseSnapshot();
    await interaction.user.send({content:`Private AunXz database backup • ${new Date().toISOString()}`,files:[new AttachmentBuilder(backup.buffer,{name:backup.filename})]});
    return interaction.editReply({embeds:[ui.okEmbed('Backup Delivered',`The database backup was sent to your DMs.\n**File size:** ${formatBytes(backup.size)}\n**Database:** ${path.basename(store.DB_PATH)}`)]});
  } catch(error) {
    return interaction.editReply({embeds:[ui.errorEmbed('Backup Failed',`${String(error?.message||error).slice(0,900)}\nThe backup was never posted in a public channel.`)]});
  }
});

// /restore is main-owner-only; validate first, take a safety backup, then ask for explicit confirmation.
ownerCommand(new SlashCommandBuilder().setName('restore').setDescription('[Main owner] Restore the database from a validated backup file.')
  .addAttachmentOption(o=>o.setName('backup_file').setDescription('AunXz SQLite backup (.sqlite/.db or .gz)').setRequired(true)),async interaction=>{
  const attachment=interaction.options.getAttachment('backup_file');
  const target=path.join(os.tmpdir(),`aunxz-restore-input-${Date.now()}-${process.pid}.sqlite`);
  await interaction.deferReply({ephemeral:true});
  try {
    await downloadAttachment(attachment,target);
    const info=validateSqliteBackup(target);
    const token=require('crypto').randomBytes(8).toString('hex');
    const components=[makeActionRow(token,[{label:'Confirm Restore',value:'yes',style:ButtonStyle.Danger},{label:'Cancel',value:'no'}])];
    const record={userId:interaction.user.id,guildId:interaction.guildId||'',actionMap:{yes:async()=>{
      const safety=await replaceDatabaseContents(target);
      return ui.okEmbed('Database Restored',`The validated backup was restored successfully. A safety backup was created at \`${safety}\`.\n**Tables in uploaded backup:** ${info.tables.length}.`);
    },no:async()=>ui.infoEmbed('Restore Cancelled','The current database was not changed.')},components,message:null,timer:null,title:'Restore Database',cleanup:[target]};
    pendingActions.set(token,record);
    const payload={embeds:[ui.warnEmbed('⚠️ Restore Database',`This will replace current data in the live SQLite database. It passed SQLite integrity validation and contains ${info.tables.length} tables. A safety backup will be created before changes.\n\n**Uploaded file:** ${shorten(attachment?.name||'backup',120)}\nConfirm only if this is the intended backup.\n\nThis confirmation expires in 30 seconds.`)],components,ephemeral:true};
    const msg=await interaction.editReply(payload); if(msg?.edit)record.message=msg; else record.message=interaction.message||null;
    record.timer=setTimeout(async()=>{if(!pendingActions.has(token))return;pendingActions.delete(token);disableComponents(components);if(record.message?.edit)await record.message.edit({embeds:[ui.warnEmbed('Confirmation Expired','Run `/restore` again to validate another backup.')],components}).catch(()=>{});for(const f of record.cleanup||[])await fs.promises.unlink(f).catch(()=>{});},TIMEOUT_MS);record.timer.unref?.();
    return;
  } catch(error) {
    await fs.promises.unlink(target).catch(()=>{});
    return interaction.editReply({embeds:[ui.errorEmbed('Restore Rejected',`${String(error?.message||error).slice(0,1100)}\nThe live database has not been changed.`)]});
  }
});

// Guild reset includes every current table with a guildId, with an optional private JSON snapshot.
ownerCommand(new SlashCommandBuilder().setName('resetguild').setDescription('[Main owner] Reset every stored row for a guild after confirmation.')
  .addStringOption(o=>o.setName('guild_id').setDescription('Discord guild ID').setRequired(true).setMinLength(15).setMaxLength(25)),async interaction=>{
  const guildId=interaction.options.getString('guild_id',true).trim();
  if(!/^\d{15,25}$/.test(guildId))return interaction.reply({embeds:[ui.errorEmbed('Invalid Guild ID','Enter a valid 15–25 digit guild ID.')],ephemeral:true});
  const counts=guildTableCounts(guildId);
  return sendConfirmation(interaction,{title:'Reset Guild Data',description:`This will delete all rows matching guild \`${guildId}\` from every SQLite table that stores a guild ID.\n\n${countsDescription(counts)}\n\nChoose **Backup & Delete** to first DM a one-time JSON snapshot. If the DM cannot be delivered, deletion will not occur.`,options:[{label:'Backup & Delete',value:'backup',style:ButtonStyle.Danger},{label:'Delete Now',value:'yes',style:ButtonStyle.Danger},{label:'Cancel',value:'no'}],actionMap:{backup:async()=>{const data=serializeGuildData(guildId);await sendJsonDm(interaction.user,data,`aunxz-guild-${guildId}-${Date.now()}.json`,'One-time pre-reset guild data backup (API tokens intentionally excluded).');const deleted=deleteGuildData(guildId);return ui.okEmbed('Guild Data Reset',`A private JSON backup was delivered, then guild data was removed.\n\n${countsDescription(deleted)}`);},yes:async()=>{const deleted=deleteGuildData(guildId);return ui.okEmbed('Guild Data Reset',`Stored rows for guild \`${guildId}\` were removed.\n\n${countsDescription(deleted)}`);},no:async()=>ui.infoEmbed('Reset Cancelled','No guild data was changed.')}});
});

ownerCommand(new SlashCommandBuilder().setName('dbstats').setDescription('[Owner] Show SQLite size and table statistics.'),async interaction=>{
  const tables=allUserTables().map(name=>({name,count:countTable(name)})).sort((a,b)=>b.count-a.count);
  const guildTotals=new Map();
  for(const table of tablesWithGuildId()) {
    try { for(const row of sql.prepare(`SELECT guildId,COUNT(*) AS n FROM main.${quoteIdentifier(table.name)} WHERE guildId IS NOT NULL AND guildId<>'' GROUP BY guildId`).all())guildTotals.set(String(row.guildId),(guildTotals.get(String(row.guildId))||0)+Number(row.n)); } catch {}
  }
  const largest=[...guildTotals.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([id,n])=>`• \`${id}\` — ${n.toLocaleString()} rows`).join('\n')||'No guild-scoped rows.';
  const totalRecords=tables.reduce((n,t)=>n+t.count,0);
  const embed=ui.infoEmbed('💾 Database Statistics',`**Database:** \`${path.basename(store.DB_PATH)}\`\n**File + WAL size:** ${formatBytes(databaseSize())}\n**Tables:** ${tables.length}\n**Total records:** ${totalRecords.toLocaleString()}\n**Guilds with stored data:** ${guildTotals.size}\n**Last safety backup:** ${store.DB_PATH}.safety-* (see host volume if restore was used)\n\n**Largest guilds by stored rows**\n${largest}\n\n**Rows per table**\n${tables.slice(0,18).map(t=>`• ${t.name}: ${t.count.toLocaleString()}`).join('\n')}`);
  return interaction.reply({embeds:[embed],ephemeral:true});
});

ownerCommand(new SlashCommandBuilder().setName('cleanup').setDescription('[Owner] Preview or remove data for guilds the bot has left.')
  .addBooleanOption(o=>o.setName('dry_run').setDescription('Only show what would be removed (default: false)')),async interaction=>{
  const dry=interaction.options.getBoolean('dry_run')??false;
  const targets=cleanupPreview(interaction.client);
  const summary=targets.map(x=>`**Guild \`${x.guildId}\`** — ${Object.values(x.counts).reduce((a,b)=>a+b,0)} row(s)\n${countsDescription(x.counts)}`).join('\n\n').slice(0,3400)||'No orphaned guild data found.';
  if(dry||!targets.length)return interaction.reply({embeds:[ui.infoEmbed('🧹 Orphaned Data Scan',`${summary}\n\n**Dry run:** ${dry?'Yes — nothing changed':'No orphaned data to remove'}`)],ephemeral:true});
  return sendConfirmation(interaction,{title:'Delete Orphaned Data',description:`This removes stored rows for guilds that are no longer in the bot's cache. This cannot be undone without a database backup.\n\n${summary}`,options:[{label:'Confirm Cleanup',value:'yes',style:ButtonStyle.Danger},{label:'Cancel',value:'no'}],actionMap:{yes:async()=>{const again=cleanupPreview(interaction.client);let removed=0;for(const item of again)removed+=Object.values(deleteGuildData(item.guildId)).reduce((a,b)=>a+b,0);return ui.okEmbed('Cleanup Complete',`Removed ${removed.toLocaleString()} row(s) from ${again.length} orphaned guild(s).`);},no:async()=>ui.infoEmbed('Cleanup Cancelled','No stored data was changed.')}});
});

ownerCommand(new SlashCommandBuilder().setName('export').setDescription('[Owner] Export guild settings/data as a JSON attachment.')
  .addStringOption(o=>o.setName('guild_id').setDescription('Guild ID (defaults to current server)').setMinLength(15).setMaxLength(25)),async interaction=>{
  const guildId=String(interaction.options.getString('guild_id')||interaction.guildId||'').trim();
  if(!/^\d{15,25}$/.test(guildId))return interaction.reply({embeds:[ui.errorEmbed('Guild Required','Use this command in a server or provide a valid guild ID.')],ephemeral:true});
  await interaction.deferReply({ephemeral:true});
  try {
    const data=serializeGuildData(guildId);
    await sendJsonDm(interaction.user,data,`aunxz-export-${guildId}-${Date.now()}.json`,'Private guild data export. API tokens and private operational logs are excluded.');
    return interaction.editReply({embeds:[ui.okEmbed('Export Delivered',`A JSON export for guild \`${guildId}\` was sent to your DMs. Sensitive API credentials are excluded.`)]});
  } catch(error) { return interaction.editReply({embeds:[ui.errorEmbed('Export Failed',String(error?.message||error).slice(0,1000))]}); }
});

function statsEmbed(client) {
  const mem=process.memoryUsage(), cpu=process.cpuUsage();
  const guilds=client.guilds.cache, users=client.users.cache, channels=client.channels.cache;
  let members=0,messages=0;
  for(const guild of guilds.values()) {
    members+=guild.members.cache.size;
    for(const channel of guild.channels.cache.values()) if(channel.messages?.cache)messages+=channel.messages.cache.size;
  }
  const shard=client.shard;
  const shardLine=shard ? `**Shard:** ${shard.ids?.join(', ')||'unknown'} / ${shard.count||1}\n**Guilds per shard:** ${[...guilds.values()].reduce((acc,g)=>{const id=g.shardId??0;acc[id]=(acc[id]||0)+1;return acc;},{}).toString()}` : '**Shard:** Not sharded';
  return ui.infoEmbed('📊 Bot Runtime Statistics',`**Uptime:** ${Math.floor(process.uptime()/86400)}d ${Math.floor(process.uptime()%86400/3600)}h ${Math.floor(process.uptime()%3600/60)}m\n**API latency:** ${client.ws.ping} ms\n**Node.js:** ${process.version}\n**discord.js:** ${require('discord.js').version}\n**RAM:** ${formatBytes(mem.rss)} resident • Heap ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}\n**CPU used since start:** ${(cpu.user/1e6).toFixed(1)}s user / ${(cpu.system/1e6).toFixed(1)}s system • Load ${os.loadavg()[0]?.toFixed(2)??'n/a'}\n**Guilds:** ${guilds.size.toLocaleString()} • **Users cached:** ${users.size.toLocaleString()}\n**Channels cached:** ${channels.size.toLocaleString()} • **Members cached:** ${members.toLocaleString()}\n**Messages cached:** ${messages.toLocaleString()}\n**Commands loaded:** ${commandRegistry.length}\n**Database:** ${formatBytes(databaseSize())}\n${shardLine}`);
}
ownerCommand(new SlashCommandBuilder().setName('stats').setDescription('[Owner] Show bot runtime, cache, version, and database stats.'),async interaction=>{
  const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ownerx:stats:${interaction.user.id}`).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Primary));
  return interaction.reply({embeds:[statsEmbed(interaction.client)],components:[row],ephemeral:true});
});

ownerCommand(new SlashCommandBuilder().setName('errors').setDescription('[Owner] Browse recent errors or clear the error log.')
  .addSubcommand(s=>s.setName('list').setDescription('Browse recent errors').addStringOption(o=>o.setName('command').setDescription('Optional command/event filter').setMaxLength(100)))
  .addSubcommand(s=>s.setName('clear').setDescription('Clear all errors or one command filter').addStringOption(o=>o.setName('command').setDescription('Optional command/event filter').setMaxLength(100))),async interaction=>{
  const sub=interaction.options.getSubcommand();
  if(sub==='clear') {
    const filter=interaction.options.getString('command')||null, count=store.countBotErrors(filter);
    return sendConfirmation(interaction,{title:'Clear Error History',description:`Delete ${count} saved error record(s)${filter?` for \`${filter}\``:''}?`,options:[{label:'Confirm Clear',value:'yes',style:ButtonStyle.Danger},{label:'Cancel',value:'no'}],actionMap:{yes:async()=>ui.okEmbed('Errors Cleared',`Removed ${store.clearBotErrors(filter)} error record(s).`),no:async()=>ui.infoEmbed('Clear Cancelled','Error history was preserved.')}});
  }
  const session=openListSession(interaction,'errors',{commandName:interaction.options.getString('command')||null});
  return sendListPanel(interaction,session,errorListPayload);
});

ownerCommand(new SlashCommandBuilder().setName('commandstats').setDescription('[Owner] View command usage and failure rates.')
  .addStringOption(o=>o.setName('period').setDescription('Time range').addChoices({name:'Today',value:'today'},{name:'Last 7 days',value:'week'},{name:'All time',value:'all'}))
  .addStringOption(o=>o.setName('guild_id').setDescription('Optional guild ID filter').setMinLength(15).setMaxLength(25)),async interaction=>{
  const guildId=interaction.options.getString('guild_id')||'';
  if(guildId&&!/^\d{15,25}$/.test(guildId))return interaction.reply({embeds:[ui.errorEmbed('Invalid Guild ID','Enter a 15–25 digit guild ID.')],ephemeral:true});
  const session=openListSession(interaction,'commandstats',{period:interaction.options.getString('period')||'all',guildId});
  return sendListPanel(interaction,session,commandStatsPayload);
});

ownerCommand(new SlashCommandBuilder().setName('commandtoggle').setDescription('[Owner] Enable or disable a command globally.')
  .addSubcommand(s=>s.setName('set').setDescription('Enable or disable one command')
    .addStringOption(o=>o.setName('command_name').setDescription('Command name or alias').setRequired(true).setMaxLength(50))
    .addStringOption(o=>o.setName('state').setDescription('Enable or disable').setRequired(true).addChoices({name:'Enable',value:'enable'},{name:'Disable',value:'disable'}))
    .addStringOption(o=>o.setName('reason').setDescription('Optional reason shown to users').setMaxLength(500)))
  .addSubcommand(s=>s.setName('list').setDescription('List disabled commands')),async interaction=>{
  const sub=interaction.options.getSubcommand();
  if(sub==='list')return sendListPanel(interaction,openListSession(interaction,'disabled',{}),disabledCommandsPayload);
  const raw=interaction.options.getString('command_name',true).trim(),name=canonicalName(raw),state=interaction.options.getString('state',true),reason=interaction.options.getString('reason')||'';
  if(!commandKnown(name))return interaction.reply({embeds:[ui.errorEmbed('Unknown Command',`No command named \`${raw}\` or matching alias is registered.`)],ephemeral:true});
  if(isCommandProtected(name))return interaction.reply({embeds:[ui.errorEmbed('Protected Command',`**/${name}** is a core/owner command and cannot be disabled.`)],ephemeral:true});
  if(state==='disable') { store.disableCommand(name,reason,interaction.user.id); return interaction.reply({embeds:[ui.okEmbed('Command Disabled',`**/${name}** is now disabled globally.${reason?`\n**Reason:** ${reason}`:''}`)],ephemeral:true}); }
  const existed=store.enableCommand(name);
  return interaction.reply({embeds:[ui.okEmbed(existed?'Command Enabled':'Already Enabled',existed?`**/${name}** is enabled again.`:`**/${name}** was not disabled.`)],ephemeral:true});
});

ownerCommand(new SlashCommandBuilder().setName('ownerhelp').setDescription('[Owner] Browse owner-only commands by category.'),async interaction=>{
  return interaction.reply({...ownerHelpPayload(interaction.user.id),ephemeral:true});
});

// Component routing for confirmation/list panels, called once from index.js.
async function handleInteraction(interaction, client) {
  const id=String(interaction.customId||'');
  if(!id.startsWith('ownerx:'))return false;
  const parts=id.split(':');
  try {
    if(parts[1]==='confirm') {
      const token=parts[2],choice=parts[3],record=pendingActions.get(token);
      if(!record)return interaction.reply({embeds:[ui.errorEmbed('Confirmation Expired','Run the command again to start a new confirmation.')],ephemeral:true}).then(()=>true);
      if(interaction.user.id!==record.userId)return interaction.reply({embeds:[ui.errorEmbed('Not Your Confirmation','Only the owner who started this action can confirm it.')],ephemeral:true}).then(()=>true);
      if(Date.now()>(record.expiresAt||Infinity)) { pendingActions.delete(token); return interaction.reply({embeds:[ui.errorEmbed('Confirmation Expired','Run the command again.')],ephemeral:true}).then(()=>true); }
      pendingActions.delete(token);clearTimeout(record.timer);
      if(choice==='no') {
        for(const file of record.cleanup||[])await fs.promises.unlink(file).catch(()=>{});
        return interaction.update({embeds:[ui.infoEmbed('Action Cancelled','No changes were made.')],components:[]}).then(()=>true);
      }
      await interaction.deferUpdate();
      try {
        const action=record.actionMap?.[choice];
        if(!action)throw new Error('This confirmation action is not available.');
        const embed=await action();
        for(const file of record.cleanup||[])await fs.promises.unlink(file).catch(()=>{});
        await interaction.editReply({embeds:[embed],components:[]}).catch(async()=>interaction.message?.edit({embeds:[embed],components:[]}).catch(()=>{}));
      } catch(error) {
        console.error('[OwnerTools] Confirmed owner action failed:',error);
        for(const file of record.cleanup||[])await fs.promises.unlink(file).catch(()=>{});
        const embed=ui.errorEmbed('Action Failed',String(error?.message||error).slice(0,1400));
        await interaction.editReply({embeds:[embed],components:[]}).catch(async()=>interaction.message?.edit({embeds:[embed],components:[]}).catch(()=>{}));
      }
      return true;
    }
    if(parts[1]==='help') {
      const userId=parts[2];
      if(interaction.user.id!==userId)return interaction.reply({embeds:[ui.errorEmbed('Not Your Menu','This is not your owner menu.')],ephemeral:true}).then(()=>true);
      if(!isOwner(userId))return interaction.reply({embeds:[ui.errorEmbed('Owner Only','This command is owner-only.')],ephemeral:true}).then(()=>true);
      return interaction.update(ownerHelpPayload(userId,interaction.values?.[0]||'overview')).then(()=>true);
    }
    if(parts[1]==='stats') {
      if(interaction.user.id!==parts[2])return interaction.reply({embeds:[ui.errorEmbed('Not Your Menu','This is not your stats panel.')],ephemeral:true}).then(()=>true);
      if(!isOwner(interaction.user.id))return interaction.reply({embeds:[ui.errorEmbed('Owner Only','This command is owner-only.')],ephemeral:true}).then(()=>true);
      return interaction.update({embeds:[statsEmbed(client)],components:interaction.message.components}).then(()=>true);
    }
    if(parts[1]==='page') {
      const token=parts[2],action=parts[3],session=listSessions.get(token);
      if(!session)return interaction.reply({embeds:[ui.errorEmbed('Panel Expired','Run the command again to view current results.')],ephemeral:true}).then(()=>true);
      if(interaction.user.id!==session.userId)return interaction.reply({embeds:[ui.errorEmbed('Not Your Menu','This is not your owner menu.')],ephemeral:true}).then(()=>true);
      const build=session.type==='owners'?coOwnersPayload:session.type==='errors'?errorListPayload:session.type==='commandstats'?commandStatsPayload:disabledCommandsPayload;
      const {payload}=session;
      const source=session.type==='owners'?store.listCoOwners():session.type==='errors'?store.getBotErrors(200,0,payload.commandName||null):session.type==='commandstats'?sql.prepare('SELECT COUNT(DISTINCT commandName) AS n FROM command_usage_daily').get().n:store.listDisabledCommands();
      const total=session.type==='commandstats'?Math.max(1,Math.ceil(Number(source)/10)):Math.max(1,Math.ceil(source.length/(session.type==='owners'||session.type==='disabled'?8:5)));
      session.page=action==='first'?1:action==='last'?total:action==='prev'?Math.max(1,session.page-1):Math.min(total,session.page+1);
      const next=build(session,token);session.components=next.components||[];
      return interaction.update(next).then(()=>true);
    }
    if(parts[1]==='errorfull') {
      const token=parts[2],errorId=Number(parts[3]),session=listSessions.get(token);
      if(!session)return interaction.reply({embeds:[ui.errorEmbed('Panel Expired','Run `/errors list` again.')],ephemeral:true}).then(()=>true);
      if(interaction.user.id!==session.userId)return interaction.reply({embeds:[ui.errorEmbed('Not Your Menu','This is not your error panel.')],ephemeral:true}).then(()=>true);
      const row=store.getBotError(errorId);if(!row)return interaction.reply({embeds:[ui.errorEmbed('Error Not Found','That error record was removed.')],ephemeral:true}).then(()=>true);
      const body=`Error #${row.id}\nTime: ${new Date(row.timestamp).toISOString()}\nCommand: ${row.commandName||'—'}\nEvent: ${row.eventName||'—'}\nGuild: ${row.guildId||'—'}\nUser: ${row.userId||'—'}\n\n${row.message}\n\n${row.stack||'(No stack trace saved)'}`;
      return interaction.reply({files:[new AttachmentBuilder(Buffer.from(body,'utf8'),{name:`aunxz-error-${row.id}.txt`})],ephemeral:true}).then(()=>true);
    }
    return false;
  } catch(error) {
    console.error('[OwnerTools] Component handler failed:',error);
    if(interaction.deferred||interaction.replied)await interaction.followUp({embeds:[ui.errorEmbed('Owner Panel Error',String(error?.message||error).slice(0,1200))],ephemeral:true}).catch(()=>{});
    else await interaction.reply({embeds:[ui.errorEmbed('Owner Panel Error',String(error?.message||error).slice(0,1200))],ephemeral:true}).catch(()=>{});
    return true;
  }
}

function checkDisabledCommand(commandName) {
  const name=canonicalName(commandName);
  if(isCommandProtected(name))return null;
  return store.getDisabledCommand(name);
}
function trackStart(commandName,guildId) { try{return store.commandUseStart(commandName,guildId);}catch(error){console.error('[CommandStats] Start tracking failed:',error);return null;} }
function trackFinish(token,success) { try{store.commandUseFinish(token,success);}catch(error){console.error('[CommandStats] Finish tracking failed:',error);} }

module.exports={commands,isOwner,isMainOwner,setCommandRegistry,handleInteraction,checkDisabledCommand,trackStart,trackFinish,logOwnerUse,saveError};
