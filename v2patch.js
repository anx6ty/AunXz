// v2patch.js — safe, centralized Components V2 transport layer.
// It never touches modal payloads and never auto-defers interactions.
// All embed messages are converted to valid V2 containers with action rows INSIDE the container.

const djs = require('discord.js');
const ui = require('./ui');

const WRAPPED = Symbol.for('aunxz.v2patch.wrapped');
const PATCHED = Symbol.for('aunxz.v2patch.patched');

function isPayloadObject(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload);
}

function componentError(error) {
  const code = Number(error?.code);
  const msg = String(error?.message || '');
  return code === 50035 || /MODEL_TYPE_CONVERT|COMPONENT_LAYOUT_WIDTH_EXCEEDED|Invalid Form Body/i.test(msg);
}

function normalize(payload) {
  if (!isPayloadObject(payload)) return payload;
  // Do not touch files/attachments/etc. ui.toComponentsV2 only rewrites message-layout keys.
  return ui.toComponentsV2(payload);
}

async function withFallback(original, normalized, originalPayload, thisArg, methodName = '') {
  try {
    return await original.call(thisArg, normalized);
  } catch (error) {
    const code = Number(error?.code);

    // A component can outlive its ephemeral/original message (e.g. a confirmation
    // pressed after Discord removed the source message). Do not retry editReply on the
    // same missing message: surface the result in a fresh ephemeral response instead.
    if (code === 10008 && thisArg?.isMessageComponent?.()) {
      // Never retry a failed followUp through itself: that used to recurse when the
      // interaction token was no longer valid. A missing original message can be
      // replaced with a fresh acknowledgement once, but an expired token cannot.
      if (methodName === 'followUp') {
        console.warn('[AunXz] A component follow-up failed with Unknown Message; suppressing a recursive retry.');
        return null;
      }
      const notice = {
        ...(isPayloadObject(originalPayload) ? originalPayload : {}),
        ephemeral: true
      };
      try {
        if (methodName === 'editReply' || thisArg.deferred || thisArg.replied) {
          console.warn('[AunXz] Original component response was missing; delivering result as a fresh ephemeral follow-up.');
          return await thisArg.followUp(notice);
        }
        console.warn('[AunXz] Original component message was missing; replying privately instead of retrying the expired message.');
        return await thisArg.reply(notice);
      } catch (fallbackError) {
        const fallbackCode = Number(fallbackError?.code);
        console.error('[AunXz] Could not deliver fallback for an expired component message:', fallbackError);
        // These errors mean there is no valid response destination left. Do not let a
        // best-effort recovery itself become an unhandled rejection.
        if ([10008, 10015, 10062].includes(fallbackCode)) return null;
        throw fallbackError;
      }
    }

    if (!componentError(error) || normalized === originalPayload) throw error;
    // Hard fallback keeps the bot functional if Discord rejects a V2 layout because of a
    // newly introduced component validation rule. The normal path remains Components V2.
    console.error('[AunXz] Components V2 payload rejected; using standard message fallback:', error);
    return original.call(thisArg, stripV2(originalPayload));
  }
}

function stripV2(payload) {
  if (!isPayloadObject(payload)) return payload;
  const out = { ...payload };
  if (out.ephemeral == null && typeof out.flags === 'number') {
    const v2 = djs.MessageFlags?.IsComponentsV2 || 0;
    out.flags &= ~v2;
  }
  return out;
}

function wrapInteractionMethod(interaction, name) {
  const original = interaction?.[name];
  if (typeof original !== 'function' || original[WRAPPED]) return;
  const bound = original.bind(interaction);
  const wrapped = async function(payload, ...rest) {
    const normalized = normalize(payload);
    return withFallback(bound, normalized, payload, interaction, name);
  };
  wrapped[WRAPPED] = true;
  interaction[name] = wrapped;
}

function wrapInteraction(interaction) {
  for (const name of ['reply', 'update', 'editReply', 'followUp']) wrapInteractionMethod(interaction, name);
}

function patchChannelPrototype(ChannelClass) {
  if (!ChannelClass?.prototype || typeof ChannelClass.prototype.send !== 'function') return;
  const current = ChannelClass.prototype.send;
  if (current[PATCHED]) return;
  const original = current;
  const wrapped = function(payload, ...rest) {
    const normalized = normalize(payload);
    return withFallback(original, normalized, payload, this, 'send');
  };
  wrapped[PATCHED] = true;
  ChannelClass.prototype.send = wrapped;
}

function apply() {
  if (globalThis[PATCHED]) return true;

  for (const name of ['TextChannel', 'NewsChannel', 'AnnouncementChannel', 'ThreadChannel', 'DMChannel']) {
    patchChannelPrototype(djs[name]);
  }
  if (djs.Message?.prototype?.edit && !djs.Message.prototype.edit[PATCHED]) {
    const originalEdit = djs.Message.prototype.edit;
    const wrappedEdit = function(payload, ...rest) {
      const normalized = normalize(payload);
      return withFallback(originalEdit, normalized, payload, this, 'edit');
    };
    wrappedEdit[PATCHED] = true;
    djs.Message.prototype.edit = wrappedEdit;
  }

  // Interaction instances are wrapped explicitly from interactionCreate. This avoids
  // monkey-patching Discord's global Interaction prototype and keeps modals untouched.
  globalThis[PATCHED] = true;
  module.exports.wrapInteraction = wrapInteraction;
  return true;
}

module.exports = { apply, wrapInteraction };
