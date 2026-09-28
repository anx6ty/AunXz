// v2patch.js — makes every outgoing message that has embeds + interactive components render
// with Discord Components V2 (Container layout) instead of legacy embeds.
// Applied once at startup by index.js. Everything is guarded, so a missing class/method in the
// installed discord.js version is skipped instead of crashing the bot.
const D = require('discord.js');
const ui = require('./ui');

const v2Interactions = new WeakSet();   // interactions whose reply is already a V2 message
const v2Messages = new WeakSet();       // Message objects we know are V2

function isV2Message(msg) {
  try { return !!(msg && msg.flags && msg.flags.has && msg.flags.has(D.MessageFlags.IsComponentsV2)); } catch { return false; }
}

function wrapMethod(proto, name, { edit = false } = {}) {
  if (!proto || typeof proto[name] !== 'function' || proto[name].__v2wrapped) return;
  const original = proto[name];
  const wrapped = function (payload, ...args) {
    let out = payload;
    try {
      const force = edit && (v2Interactions.has(this) || isV2Message(this) || isV2Message(this.message));
      out = ui.toComponentsV2(payload, force);
      if (out !== payload && (name === 'reply' || name === 'update') && this && typeof this === 'object') v2Interactions.add(this);
    } catch (e) {
      console.error('[v2patch] conversion failed, sending original payload:', e);
      out = payload;
    }
    return original.call(this, out, ...args);
  };
  wrapped.__v2wrapped = true;
  proto[name] = wrapped;
}

function apply() {
  // Interaction responses
  for (const cls of [D.CommandInteraction, D.MessageComponentInteraction, D.ModalSubmitInteraction]) {
    if (!cls) continue;
    wrapMethod(cls.prototype, 'reply');
    wrapMethod(cls.prototype, 'update', { edit: true });
    wrapMethod(cls.prototype, 'editReply', { edit: true });
    wrapMethod(cls.prototype, 'followUp');
  }
  // Messages
  if (D.Message) {
    wrapMethod(D.Message.prototype, 'reply');
    wrapMethod(D.Message.prototype, 'edit', { edit: true });
  }
  // Channel sends
  for (const cls of [D.BaseGuildTextChannel, D.TextChannel, D.NewsChannel, D.ThreadChannel, D.DMChannel, D.VoiceChannel]) {
    if (cls) wrapMethod(cls.prototype, 'send');
  }
}

module.exports = { apply };
