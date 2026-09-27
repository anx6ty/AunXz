# All-in-One Discord Bot

5 code files, discord.js v14, SQLite storage (file-based, no external DB needed).

## Files
- `index.js` — bootstraps the client, registers slash commands, wires every Discord event
  (member join/leave, voice state, message create, channel/role/ban events for antinuke).
- `database.js` — SQLite (`better-sqlite3`) storage: per-guild config (JSON blob covering 40+
  toggleable modules), leveling, warns, tickets, voicemaster channels, antinuke whitelist/log.
- `systems.js` — the automated logic: antinuke, antilink, antispam, antiraid, greetvoice
  (role lock + persistent VC join + TTS), leveling, voicemaster (join-to-create).
- `ui.js` — every embed/button/select-menu builder, so the whole bot shares one visual style.
- `commands.js` — every slash command definition + handler (`/help`, `/setup`, `/greetvoice`,
  moderation, leveling, tickets, owner-only).

## Important — a Discord API limitation
You asked for buttons **inside** embeds rather than below them. Discord's API doesn't allow
that for any bot: message components (buttons/menus) always render in a separate row **below**
an embed, never inside its body. There's no workaround (official client, mobile, or otherwise).
What this bot does instead, everywhere: exactly one themed embed + exactly one compact button/
select row directly under it, so it reads as a single unified panel rather than "text, then a
pile of unrelated buttons."

## Setup
1. Create a Discord application + bot at https://discord.com/developers/applications, enable
   **Server Members Intent** and **Message Content Intent** under Bot settings, copy the token.
2. `cp .env.example .env` and fill in `DISCORD_TOKEN`, `CLIENT_ID`, and `OWNER_IDS`. `GUILD_ID`
   is optional — set it while testing so slash commands register instantly to one server.
3. `npm install`
4. `npm start`

## Deploying on Railway
1. Push this folder to a GitHub repo, then in Railway: **New Project → Deploy from GitHub repo**.
2. In the Railway service's **Variables** tab, add `DISCORD_TOKEN`, `CLIENT_ID`, `OWNER_IDS`
   (and `GUILD_ID` only if you want guild-scoped commands). Do not commit `.env` — Railway
   variables replace it.
3. Railway auto-detects Node from `package.json` and runs `npm start`. No extra config needed.
4. `bot.sqlite` is created on first run in the project directory. Railway's filesystem is
   ephemeral on redeploys — if you need config to survive redeploys long-term, mount a
   [Railway Volume](https://docs.railway.com/reference/volumes) at the bot's working directory.
5. Greetvoice's TTS uses a free Google Translate TTS endpoint via `google-tts-api` +
   `@discordjs/voice`/`@discordjs/opus`. Railway's containers have everything needed
   (no ffmpeg binary is required since it streams the mp3 URL directly).

## Core commands to try first
- `/help` — category select menu.
- `/setup antinuke state:enable punishment:ban` (then repeat per module: antilink, antispam,
  antiraid, voicemaster, leveling, tickets, greetmessage; `/setup logs` to route log channels;
  `/setup module` for the other 12+ smaller toggles; `/setup list` to see all module names).
- `/greetvoice role:<@role> vc:<#channel> prompt:<text>` — locks the role to that VC everywhere
  (updates automatically on new channels), joins the VC immediately and stays connected, and on
  every future join by a gated member plays the TTS prompt, then disconnects them and removes
  the role.
- `/ticketpanel` — after `/setup tickets`, posts the Open Ticket button.
