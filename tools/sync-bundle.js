'use strict';
// Keeps the standalone source files in sync with their copies inside the single-file bundle (index.js).
//   node tools/sync-bundle.js            -> copy standalone files INTO index.js
//   node tools/sync-bundle.js --extract  -> copy bundled modules OUT to the standalone files
//   node tools/sync-bundle.js --check    -> exit 1 if they differ
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'index.js');
const MODULES = ['embedsystem.js', 'template.js'];
function span(src, name) {
  const head = `__modules["${name}"] = function(module, exports, require, __filename, __dirname) {\n`;
  const start = src.indexOf(head);
  if (start < 0) throw new Error(`module ${name} not found in bundle`);
  const bodyStart = start + head.length;
  const end = src.indexOf('\n};\n__modules["', bodyStart);
  const endAlt = src.indexOf('\n};\n\nconst __cache', bodyStart);
  const bodyEnd = [end, endAlt].filter(x => x >= 0).sort((a, b) => a - b)[0];
  return { bodyStart, bodyEnd };
}
// Bundled bodies end with a blank line before "};"; standalone files keep the exact body (plus trailing newline).
const mode = process.argv[2] || '';
let src = fs.readFileSync(BUNDLE, 'utf8');
let bad = 0;
for (const name of MODULES) {
  const { bodyStart, bodyEnd } = span(src, name);
  const bundled = src.slice(bodyStart, bodyEnd);
  const file = path.join(ROOT, name);
  if (mode === '--extract') { fs.writeFileSync(file, bundled + '\n'); continue; }
  const standalone = fs.readFileSync(file, 'utf8').replace(/\n$/, '');
  if (mode === '--check') { if (standalone !== bundled) { console.error(`${name}: standalone differs from bundle`); bad++; } continue; }
  src = src.slice(0, bodyStart) + standalone + src.slice(bodyEnd);
}
if (mode === '--check') process.exit(bad ? 1 : 0);
if (mode !== '--extract') fs.writeFileSync(BUNDLE, src);
console.log(mode === '--extract' ? 'extracted' : 'synced');
