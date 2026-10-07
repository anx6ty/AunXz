// v2patch.js — safely converts legacy embed payloads into Discord Components V2.
// It also normalizes nested component arrays and fixes invalid action-row layouts.

const D = require('discord.js');
const ui = require('./ui');

const v2Interactions = new WeakSet();

function isV2Message(msg) {
  try {
    return !!(
      msg &&
      msg.flags &&
      msg.flags.has &&
      D.MessageFlags?.IsComponentsV2 &&
      msg.flags.has(D.MessageFlags.IsComponentsV2)
    );
  } catch {
    return false;
  }
}

function wrapMethod(proto, name, { edit = false } = {}) {
  if (!proto || typeof proto[name] !== 'function' || proto[name].__v2wrapped) {
    return;
  }

  const original = proto[name];

  const wrapped = function (payload, ...args) {
    let out = payload;

    try {
      const force =
        edit &&
        (
          v2Interactions.has(this) ||
          isV2Message(this) ||
          isV2Message(this.message)
        );

      out = ui.toComponentsV2(payload, force);

      if (
        out !== payload &&
        (name === 'reply' || name === 'update') &&
        this &&
        typeof this === 'object'
      ) {
        v2Interactions.add(this);
      }
    } catch (error) {
      console.error(
        '[v2patch] conversion failed, using original payload:',
        error
      );

      out = payload;
    }

    return original.call(this, out, ...args);
  };

  wrapped.__v2wrapped = true;
  proto[name] = wrapped;
}

function apply() {
  for (const cls of [
    D.CommandInteraction,
    D.MessageComponentInteraction,
    D.ModalSubmitInteraction
  ]) {
    if (!cls) continue;

    wrapMethod(cls.prototype, 'reply');
    wrapMethod(cls.prototype, 'update', { edit: true });
    wrapMethod(cls.prototype, 'editReply', { edit: true });
    wrapMethod(cls.prototype, 'followUp');
  }

  if (D.Message) {
    wrapMethod(D.Message.prototype, 'reply');
    wrapMethod(D.Message.prototype, 'edit', { edit: true });
  }

  for (const cls of [
    D.BaseGuildTextChannel,
    D.TextChannel,
    D.NewsChannel,
    D.ThreadChannel,
    D.DMChannel,
    D.VoiceChannel
  ]) {
    if (cls) {
      wrapMethod(cls.prototype, 'send');
    }
  }
}

module.exports = {
  apply
};