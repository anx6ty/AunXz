#!/usr/bin/env node
'use strict';
// bridge/cli.js — run the whole pipeline from a terminal, no website needed.
//
//   node bridge/cli.js "a chill study community with a mod team and quiet voice rooms"
//   node bridge/cli.js --spec my-spec.json        (skip the AI: build a code from a spec file, no API key needed)
//   add --no-save to skip saving a short code in the database
//
// Prints the stats, warnings, short code and full code, and writes the full code to generated-template.txt
// (upload that file in /template load -> file: when the code is too long to paste).

try { require('dotenv').config(); } catch { /* dotenv optional */ }
const fs = require('fs');
const path = require('path');

(async () => {
  const args = process.argv.slice(2);
  const noSave = args.includes('--no-save');
  const specIdx = args.indexOf('--spec');
  const prompt = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--spec').join(' ').trim();

  let out;
  if (specIdx !== -1) {
    const file = args[specIdx + 1];
    if (!file) throw new Error('Usage: --spec <file.json>');
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    out = require('./templateBridge').buildTemplateFromSpec(spec, { requestedBy: 'cli', persist: !noSave });
  } else {
    if (!prompt) {
      console.log('Usage:\n  node bridge/cli.js "describe your server"\n  node bridge/cli.js --spec spec.json');
      process.exit(1);
    }
    out = await require('./generate').generateTemplate({ prompt, requestedBy: 'cli', onStatus: s => console.log(`… ${s}`) });
  }

  console.log(`\nDone: ${out.stats.roles} roles, ${out.stats.categories} categories, ${out.stats.channels} channels (${out.stats.bytes} chars).`);
  if (out.warnings.length) console.log('Notes:\n - ' + out.warnings.join('\n - '));
  if (out.shortCode) console.log(`\nShort code (works with this bot's database): ${out.shortCode}`);
  const file = path.resolve('generated-template.txt');
  fs.writeFileSync(file, out.code);
  console.log(`Full code saved to ${file}`);
  if (out.fitsInCommand) console.log(`\n${out.code}`);
})().catch(e => {
  if (e.code === 'missing_key') { console.error(`\n${e.message}\n${e.howTo}`); process.exit(2); }
  console.error(`\nError: ${e.message}`);
  if (e.errors?.length) console.error(e.errors.map(x => ` - ${x.path}: ${x.message}`).join('\n'));
  process.exit(1);
});
