'use strict';

const { LIMITS } = require('./constants');

function truncate(value, maxLength) {
  const text = String(value ?? '');
  if (!maxLength || text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(Number(ms || 0) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatHms(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isHttpsUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    return new URL(value.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

function isSnowflake(value) {
  return typeof value === 'string' && /^\d{17,20}$/.test(value.trim());
}

function normaliseSnowflake(value) {
  const text = String(value ?? '').trim();
  return isSnowflake(text) ? text : '';
}

function parseDiscordChannelUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (isSnowflake(text)) {
    return { guildId: '', channelId: text, url: '' };
  }

  const normalised = text
    .replace(/^discord:\/\/-?\//, 'https://discord.com/')
    .replace(/^discord:\/\//, 'https://discord.com/');

  try {
    const url = new URL(normalised);
    if (!/(^|\.)discord\.com$/i.test(url.hostname) && !/(^|\.)discordapp\.com$/i.test(url.hostname)) {
      return null;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    const channelIndex = parts.indexOf('channels');
    if (channelIndex === -1) return null;
    const guildId = parts[channelIndex + 1] || '';
    const channelId = parts[channelIndex + 2] || '';
    if (!isSnowflake(channelId)) return null;
    return {
      guildId: isSnowflake(guildId) ? guildId : '',
      channelId,
      url: `https://discord.com/channels/${encodeURIComponent(guildId || '@me')}/${channelId}`,
    };
  } catch {
    return null;
  }
}

function makeChannelUrl(guildId, channelId) {
  if (!isSnowflake(channelId)) return '';
  const guildPart = isSnowflake(guildId) ? guildId : '@me';
  return `https://discord.com/channels/${guildPart}/${channelId}`;
}

function cleanPresenceText(value) {
  let text = String(value ?? '').replace(/\s+/g, ' ').trim();
  text = text.replace(/(?:\s*[•|·]\s*){2,}/g, ' • ');
  text = text.replace(/(?:\s*[•|·]\s*(?:⏱|🎧|📺|🎮|📺)?\s*)+$/u, '');
  text = text.replace(/^(?:\s*(?:⏱|🎧|📺|🎮)?\s*[•|·]\s*)+/u, '');
  text = text.replace(/\s+([,.;:!?])/g, '$1');
  text = text.replace(/\s{2,}/g, ' ').trim();
  return text;
}

function renderTemplate(template, variables) {
  const source = String(template ?? '');
  return source.replace(/\{([^{}\s]{1,64})\}/gu, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      return String(variables[key] ?? '');
    }
    return match;
  });
}

function renderPresenceField(template, variables, maxLength) {
  return truncate(cleanPresenceText(renderTemplate(template, variables)), maxLength);
}

function redactSecrets(value, secrets = []) {
  let text = String(value ?? '');
  const list = (Array.isArray(secrets) ? secrets : [secrets])
    .filter((secret) => typeof secret === 'string' && secret.length >= 8)
    .sort((a, b) => b.length - a.length);
  for (const secret of list) {
    text = text.split(secret).join('[скрыто]');
  }
  // Also redact token-shaped strings that might come from a library error.
  text = text.replace(/\b[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}\b/g, '[скрыто]');
  return text;
}

function extractBotApplicationId(token) {
  if (typeof token !== 'string' || !token.includes('.')) return '';
  try {
    const decoded = Buffer.from(token.split('.')[0], 'base64').toString('utf8').trim();
    return isSnowflake(decoded) ? decoded : '';
  } catch {
    return '';
  }
}

function normaliseCategory(value) {
  return value === 'game' || value === 'other' ? value : 'anime';
}

function normaliseActivityType(value) {
  return ['auto', 'playing', 'watching', 'listening', 'competing'].includes(value) ? value : 'auto';
}

function slugify(value, fallback = 'item') {
  const slug = String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || fallback;
}

function uniqueId(base, existingIds, fallback = 'item') {
  const existing = new Set(existingIds);
  const stem = slugify(base, fallback);
  if (!existing.has(stem)) return stem;
  let index = 2;
  while (existing.has(`${stem}-${index}`)) index += 1;
  return `${stem}-${index}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeError(error, secrets = []) {
  if (!error) return 'Неизвестная ошибка';
  const message = typeof error === 'string' ? error : error.message || String(error);
  return redactSecrets(message, secrets);
}

function buildTemplateVariables({ platform, activity, server, voice, elapsed, includesTimeIcon = true }) {
  const place = [server, voice].filter(Boolean).join(' / ');
  const time = elapsed ? (includesTimeIcon ? `⏱ ${elapsed}` : elapsed) : '';
  return {
    P: platform || '',
    platform: platform || '',
    activity: activity || '',
    server: server || '',
    voice: voice || '',
    place,
    time,
    elapsed: elapsed || '',
  };
}

module.exports = {
  buildTemplateVariables,
  clampNumber,
  cleanPresenceText,
  extractBotApplicationId,
  formatDuration,
  formatHms,
  isHttpUrl,
  isHttpsUrl,
  isSnowflake,
  makeChannelUrl,
  normaliseActivityType,
  normaliseCategory,
  normaliseSnowflake,
  parseDiscordChannelUrl,
  redactSecrets,
  renderPresenceField,
  renderTemplate,
  safeError,
  slugify,
  sleep,
  truncate,
  uniqueId,
};
