'use strict';
// bridge/index.js — entry point used by the bot (index.js) to switch the bridge on.
//
// Nothing starts unless BOT_BRIDGE_SECRET is set (HTTP bridge, for a web app running as a separate service).
// When the web app runs inside this same process it calls buildTemplateFromSpec directly and no listener is needed.

const { BridgeError } = require('./spec');

function startFromEnv() {
  const secret = process.env.BOT_BRIDGE_SECRET;
  if (!secret) return null;
  if (secret.length < 24) {
    console.warn('[bridge] BOT_BRIDGE_SECRET is shorter than 24 characters — HTTP bridge NOT started.');
    return null;
  }
  const { createBridgeServer } = require('./httpBridge');
  const { buildTemplateFromSpec } = require('./templateBridge');
  const server = createBridgeServer({ secret, build: buildTemplateFromSpec });
  const port = Number(process.env.BRIDGE_PORT) || 3001;
  server.on('error', e => {
    if (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL') server.listen(port, '0.0.0.0');
    else console.error('[bridge] server error:', e.message);
  });
  server.listen(port, '::', () => console.log(`[bridge] template bridge listening on port ${port}`));
  return server;
}

module.exports = {
  startFromEnv,
  BridgeError,
  get buildTemplateFromSpec() { return require('./templateBridge').buildTemplateFromSpec; },
  get generateTemplate() { return require('./generate').generateTemplate; }
};
