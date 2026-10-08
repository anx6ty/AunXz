// v2patch.js
// Disabled intentionally: the old global embed-to-Components-V2 monkey patch was
// converting every message, including setup panels and mixed component rows.
// That produced Discord 50035 MODEL_TYPE_CONVERT / COMPONENT_LAYOUT_WIDTH_EXCEEDED
// errors. The bot now sends normal Discord embeds + ActionRows directly, which is
// the stable format for the existing command UI.
function apply() { return true; }
module.exports = { apply };
