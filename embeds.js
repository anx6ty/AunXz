// embeds.js — shared embed/container styling used by ui.js.
// Exports: COLORS, BRAND_FOOTER, applySharedStyle(embed, kind), getContainerBranding(embedJSON)

const COLORS = {
  info: 0x5865F2,
  success: 0x57F287,
  warning: 0xFEE75C,
  error: 0xED4245
};

const BRAND_FOOTER = process.env.BRAND_FOOTER || 'AIO • all-in-one';

// Thumbnail shown on every card unless an embed sets its own (index.js fills EMBED_THUMBNAIL_URL
// with the bot's avatar on startup; set BOT_AVATAR_URL / EMBED_THUMBNAIL_URL to override).
const defaultThumbnail = () => process.env.EMBED_THUMBNAIL_URL || process.env.BOT_AVATAR_URL || null;

// Applies the shared look to a freshly created EmbedBuilder and returns it.
function applySharedStyle(embed, kind = 'info') {
  embed.setColor(COLORS[kind] ?? COLORS.info);
  embed.setFooter({ text: BRAND_FOOTER });
  const thumb = defaultThumbnail();
  if (thumb && /^https?:\/\//i.test(thumb)) embed.setThumbnail(thumb);
  return embed;
}

// Used when an embed is turned into a Components V2 container.
function getContainerBranding(d = {}) {
  const thumb = d.thumbnail?.url || defaultThumbnail();
  return {
    color: typeof d.color === 'number' ? d.color : COLORS.info,
    thumbnail: thumb && /^(https?:\/\/|attachment:\/\/)/i.test(thumb) ? thumb : null,
    footer: d.footer?.text || BRAND_FOOTER,
    timestamp: d.timestamp || Date.now()
  };
}

module.exports = { COLORS, BRAND_FOOTER, applySharedStyle, getContainerBranding };
