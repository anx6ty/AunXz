'use strict';

const { EmbedBuilder } = require('discord.js');

const COLORS = Object.freeze({
  success: 0x43B581,
  error: 0xED4245,
  warning: 0xFEE75C,
  info: 0x5865F2,
  fantasy: 0x7C4DFF
});

const BRAND_FOOTER = process.env.EMBED_FOOTER_TEXT || 'AIO • all-in-one';

function getBrandThumbnail() {
  const value = process.env.EMBED_THUMBNAIL_URL || process.env.BOT_AVATAR_URL || '';
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function footerText(value) {
  const custom = String(value || '').trim();
  if (!custom || custom === BRAND_FOOTER) return BRAND_FOOTER;
  if (custom.includes(BRAND_FOOTER)) return custom;
  return `${custom} • ${BRAND_FOOTER}`.slice(0, 2048);
}

function applySharedStyle(embed, variant = 'info') {
  if (!embed || typeof embed.setFooter !== 'function') return embed;
  const color = COLORS[variant] || COLORS.info;
  if (!embed.data?.color) embed.setColor(color);
  if (!embed.data?.timestamp) embed.setTimestamp();
  embed.setFooter({ text: footerText(embed.data?.footer?.text) });
  const thumbnail = getBrandThumbnail();
  if (thumbnail && !embed.data?.thumbnail?.url) embed.setThumbnail(thumbnail);
  return embed;
}

function createEmbed(variant, title, description, options = {}) {
  const embed = new EmbedBuilder()
    .setColor(COLORS[variant] || COLORS.info)
    .setTimestamp()
    .setFooter({ text: BRAND_FOOTER });
  if (title) embed.setTitle(String(title).slice(0, 256));
  if (description != null) embed.setDescription(String(description).slice(0, 4096));
  if (Array.isArray(options.fields) && options.fields.length) {
    embed.addFields(options.fields.slice(0, 25).map(field => ({
      name: String(field.name || 'Details').slice(0, 256),
      value: String(field.value || '—').slice(0, 1024),
      inline: Boolean(field.inline)
    })));
  }
  const thumbnail = options.thumbnail || getBrandThumbnail();
  if (thumbnail) {
    try { embed.setThumbnail(new URL(thumbnail).toString()); } catch {}
  }
  if (options.image) {
    try { embed.setImage(new URL(options.image).toString()); } catch {}
  }
  return embed;
}

const success = (title, description, options) => createEmbed('success', title, description, options);
const error = (title, description, options) => createEmbed('error', title, description, options);
const warning = (title, description, options) => createEmbed('warning', title, description, options);
const info = (title, description, options) => createEmbed('info', title, description, options);

function getContainerBranding(embedData = {}) {
  const data = embedData || {};
  const existingColor = Number.isInteger(data.color) ? data.color : COLORS.info;
  const timestamp = data.timestamp || new Date().toISOString();
  return {
    color: existingColor,
    timestamp,
    footer: footerText(data.footer?.text),
    thumbnail: data.thumbnail?.url || getBrandThumbnail()
  };
}

module.exports = {
  COLORS,
  BRAND_FOOTER,
  getBrandThumbnail,
  footerText,
  applySharedStyle,
  createEmbed,
  success,
  error,
  warning,
  info,
  getContainerBranding
};
