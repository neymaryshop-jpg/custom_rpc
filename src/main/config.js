'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  ACTIVITY_TYPES,
  CATEGORIES,
  DEFAULT_CONFIG,
  LIMITS,
  RPC_ACTIVITY_TYPES,
} = require('./constants');
const {
  isHttpsUrl,
  isSnowflake,
  makeChannelUrl,
  normaliseActivityType,
  normaliseCategory,
  normaliseSnowflake,
  parseDiscordChannelUrl,
  renderTemplate,
  truncate,
  uniqueId,
} = require('./util');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (Array.isArray(base)) return Array.isArray(override) ? clone(override) : clone(base);
  if (!isPlainObject(base)) return override === undefined ? base : override;
  const result = { ...clone(base) };
  if (!isPlainObject(override)) return result;
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    result[key] = isPlainObject(value) && isPlainObject(result[key]) ? deepMerge(result[key], value) : value;
  }
  return result;
}

function asBool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function asString(value, maxLength, fallback = '') {
  return truncate(String(value ?? fallback).trim(), maxLength);
}

function normalisePlatforms(rawPlatforms, fallback) {
  const source = Array.isArray(rawPlatforms) && rawPlatforms.length > 0 ? rawPlatforms : fallback;
  const ids = new Set();
  const platforms = [];
  for (const item of source) {
    if (!isPlainObject(item)) continue;
    const name = asString(item.name, LIMITS.displayName) || asString(item.id, LIMITS.displayName) || 'Площадка';
    let id = asString(item.id, LIMITS.id) || uniqueId(name, ids, 'platform');
    if (ids.has(id)) id = uniqueId(id, ids, 'platform');
    ids.add(id);
    platforms.push({
      id,
      name,
      url: asString(item.url, LIMITS.platformUrl),
      smallImageKey: asString(item.smallImageKey, 64),
    });
  }
  if (platforms.length === 0) return clone(fallback);
  return platforms;
}

function normalisePresets(rawPresets, fallback) {
  const source = Array.isArray(rawPresets) && rawPresets.length > 0 ? rawPresets : fallback;
  const ids = new Set();
  const presets = [];
  for (const item of source) {
    if (!isPlainObject(item)) continue;
    const title = asString(item.title, LIMITS.title) || 'Без названия';
    let id = asString(item.id, LIMITS.id) || uniqueId(title, ids, 'preset');
    if (ids.has(id)) id = uniqueId(id, ids, 'preset');
    ids.add(id);
    presets.push({
      id,
      title,
      category: normaliseCategory(item.category),
      gifUrl: asString(item.gifUrl, LIMITS.gifUrl),
    });
  }
  if (presets.length === 0) return clone(fallback);
  return presets;
}

function normaliseWindowBounds(raw) {
  if (!isPlainObject(raw)) return null;
  const width = Number(raw.width);
  const height = Number(raw.height);
  const x = Number(raw.x);
  const y = Number(raw.y);
  if (![width, height, x, y].every(Number.isFinite)) return null;
  if (width < 700 || height < 500 || width > 4000 || height > 3000) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function normaliseConfig(raw, fallback = DEFAULT_CONFIG) {
  const merged = deepMerge(fallback, isPlainObject(raw) ? raw : {});
  const config = clone(merged);

  config.version = 1;
  config.discord = {
    applicationId: asString(merged.discord?.applicationId, 32),
    botToken: asString(merged.discord?.botToken, LIMITS.token),
    guildId: normaliseSnowflake(merged.discord?.guildId),
    userId: normaliseSnowflake(merged.discord?.userId),
    autoVoice: asBool(merged.discord?.autoVoice, true),
    botInvisible: asBool(merged.discord?.botInvisible, true),
  };

  const rawChannel = asString(merged.voice?.channelUrl, 512);
  let channelUrl = rawChannel;
  let inferredChannelId = '';
  if (rawChannel) {
    const parsed = parseDiscordChannelUrl(rawChannel);
    if (parsed) {
      inferredChannelId = parsed.channelId;
      channelUrl = makeChannelUrl(parsed.guildId || config.discord.guildId, parsed.channelId);
    }
  }
  config.voice = {
    serverName: asString(merged.voice?.serverName, LIMITS.serverName, 'aruku') || 'aruku',
    channelName: asString(merged.voice?.channelName, LIMITS.channelName, 'Voice') || 'Voice',
    channelUrl,
    inferredChannelId,
    showJoinButton: asBool(merged.voice?.showJoinButton, true),
    showNotInVoice: asBool(merged.voice?.showNotInVoice, true),
    notInVoiceText: asString(merged.voice?.notInVoiceText, 64, 'не в войсе') || 'не в войсе',
  };

  let startedAt = null;
  if (merged.stream?.startedAt) {
    const date = new Date(merged.stream.startedAt);
    if (Number.isFinite(date.getTime())) startedAt = date.toISOString();
  }
  config.stream = {
    platformId: asString(merged.stream?.platformId, LIMITS.id, 'twitch') || 'twitch',
    startedAt,
    lastSessionMs: Math.max(0, Number(merged.stream?.lastSessionMs) || 0),
    autoStart: asBool(merged.stream?.autoStart, false),
    autoStop: asBool(merged.stream?.autoStop, false),
    showNativeTimer: asBool(merged.stream?.showNativeTimer, false),
  };

  config.platforms = normalisePlatforms(merged.platforms, DEFAULT_CONFIG.platforms);
  if (!config.platforms.some((platform) => platform.id === config.stream.platformId)) {
    config.stream.platformId = config.platforms[0].id;
  }

  config.presets = normalisePresets(merged.presets, DEFAULT_CONFIG.presets);
  const selectedPreset = config.presets.find((preset) => preset.id === merged.activity?.presetId);
  config.activity = {
    presetId: selectedPreset ? selectedPreset.id : 'custom',
    title: asString(merged.activity?.title, LIMITS.title, 'Chill') || 'Chill',
    category: normaliseCategory(merged.activity?.category),
    gifUrl: asString(merged.activity?.gifUrl, LIMITS.gifUrl),
  };
  if (selectedPreset && !config.activity.title) config.activity.title = selectedPreset.title;

  config.presence = {
    details: asString(merged.presence?.details, LIMITS.template, '{P} • {activity}') || '{P} • {activity}',
    state: asString(merged.presence?.state, LIMITS.template, '{place} • {time}') || '{place} • {time}',
    largeText: asString(merged.presence?.largeText, LIMITS.template, '{activity}'),
    smallText: asString(merged.presence?.smallText, LIMITS.template, '{P} • {time}'),
    largeImageKey: asString(merged.presence?.largeImageKey, 256),
    smallImageKey: asString(merged.presence?.smallImageKey, 256),
    showButtons: asBool(merged.presence?.showButtons, true),
    activityType: normaliseActivityType(merged.presence?.activityType),
    fallbackActivity: asString(merged.presence?.fallbackActivity, LIMITS.title, 'Chill') || 'Chill',
  };

  config.app = {
    displayName: asString(merged.app?.displayName, LIMITS.displayName, 'aruku') || 'aruku',
    launchAtLogin: asBool(merged.app?.launchAtLogin, false),
    minimizeToTray: asBool(merged.app?.minimizeToTray, true),
    animateTray: asBool(merged.app?.animateTray, true),
    showSettingsOnStart: asBool(merged.app?.showSettingsOnStart, true),
  };

  config.ui = {
    windowBounds: normaliseWindowBounds(merged.ui?.windowBounds),
  };

  return config;
}

function unknownTemplateKeys(template) {
  const known = new Set(['P', 'platform', 'activity', 'server', 'voice', 'place', 'time', 'elapsed']);
  const unknown = new Set();
  String(template ?? '').replace(/\{([^{}\s]{1,64})\}/gu, (match, key) => {
    if (!known.has(key)) unknown.add(key);
    return match;
  });
  return [...unknown];
}

function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (!config.discord.applicationId) {
    warnings.push('Не указан Discord Application ID — RPC не подключится.');
  } else if (!isSnowflake(config.discord.applicationId)) {
    errors.push('Application ID должен состоять из 17–20 цифр.');
  }

  if (config.discord.botToken) {
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(config.discord.botToken) && config.discord.botToken.length < 40) {
      warnings.push('Токен бота выглядит непривычно. Проверь, что скопирован весь токен.');
    }
  }

  if (config.discord.autoVoice) {
    if (!config.discord.botToken) warnings.push('Авто-войс включён, но токен бота не указан. Будет использован ручной войс.');
    if (!config.discord.guildId) warnings.push('Авто-войс включён, но ID сервера не указан.');
    if (!config.discord.userId) warnings.push('Авто-войс включён, но ID пользователя не указан.');
  } else if (!config.voice.serverName || !config.voice.channelName) {
    warnings.push('Заполни сервер и войс для ручного режима.');
  }

  const platform = config.platforms.find((item) => item.id === config.stream.platformId);
  if (!platform) errors.push('Выбранная площадка не найдена.');
  if (platform?.url && !isHttpsUrl(platform.url)) warnings.push('Ссылка на стрим должна начинаться с https://');
  if (config.activity.gifUrl && !isHttpsUrl(config.activity.gifUrl)) {
    warnings.push('GIF-ссылка должна начинаться с https:// — иначе Discord её не загрузит.');
  }
  if (config.voice.channelUrl && !isHttpsUrl(config.voice.channelUrl)) {
    warnings.push('Ссылка на войс должна быть https-ссылкой Discord.');
  }

  for (const [name, template] of Object.entries({
    details: config.presence.details,
    state: config.presence.state,
    largeText: config.presence.largeText,
    smallText: config.presence.smallText,
  })) {
    const unknown = unknownTemplateKeys(template);
    if (unknown.length > 0) {
      warnings.push(`В шаблоне «${name}» неизвестные плейсхолдеры: ${unknown.map((key) => `{${key}}`).join(', ')}`);
    }
    if (template.length > LIMITS.template) {
      warnings.push(`Шаблон «${name}» длиннее ${LIMITS.template} символов и будет обрезан.`);
    }
  }

  if (config.stream.startedAt) {
    const started = new Date(config.stream.startedAt).getTime();
    if (started > Date.now() + 60_000) errors.push('Время старта стрима находится в будущем.');
  }

  return { errors, warnings };
}

function createConfigStore({ userDataDir, safeStorage, logger = console }) {
  const directory = userDataDir;
  const filePath = path.join(directory, 'config.json');
  let current = normaliseConfig(DEFAULT_CONFIG);

  function ensureDirectory() {
    fs.mkdirSync(directory, { recursive: true });
  }

  function decryptToken(rawConfig) {
    const encrypted = rawConfig?.discord?.botTokenEnc;
    if (typeof encrypted === 'string' && encrypted.trim() !== '') {
      if (!safeStorage?.isEncryptionAvailable?.()) {
        logger.warn?.('Зашифрованный токен бота найден, но системное шифрование недоступно. Токен нужно ввести заново.');
        return '';
      }
      try {
        return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch (error) {
        logger.warn?.(`Не удалось расшифровать токен бота: ${error.message}`);
        return '';
      }
    }
    return typeof rawConfig?.discord?.botToken === 'string' ? rawConfig.discord.botToken : '';
  }

  function load() {
    ensureDirectory();
    let raw = null;
    if (fs.existsSync(filePath)) {
      try {
        raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (error) {
        logger.warn?.(`Не удалось прочитать config.json: ${error.message}. Создан бэкап.`);
        try {
          fs.copyFileSync(filePath, `${filePath}.broken-${Date.now()}`);
        } catch {
          // ignore
        }
      }
    }

    const merged = deepMerge(DEFAULT_CONFIG, isPlainObject(raw) ? raw : {});
    merged.discord = merged.discord || {};
    merged.discord.botToken = decryptToken(raw);
    current = normaliseConfig(merged);
    return current;
  }

  function save(nextConfig) {
    ensureDirectory();
    const normalised = normaliseConfig(nextConfig);
    const onDisk = clone(normalised);
    const token = String(onDisk.discord.botToken ?? '').trim();
    onDisk.discord.botToken = '';

    if (token) {
      if (safeStorage?.isEncryptionAvailable?.()) {
        try {
          onDisk.discord.botTokenEnc = safeStorage.encryptString(token).toString('base64');
        } catch (error) {
          logger.warn?.(`Не удалось зашифровать токен бота: ${error.message}`);
          onDisk.discord.botToken = token;
        }
      } else {
        onDisk.discord.botToken = token;
      }
    } else {
      onDisk.discord.botTokenEnc = '';
    }

    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(onDisk, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    current = normalised;
    return current;
  }

  function get() {
    return current;
  }

  function set(nextConfig) {
    current = normaliseConfig(nextConfig);
    return current;
  }

  return {
    filePath,
    directory,
    load,
    save,
    get,
    set,
  };
}

function getPlatform(config, platformId = config.stream.platformId) {
  return config.platforms.find((platform) => platform.id === platformId) || config.platforms[0] || {
    id: 'custom',
    name: 'Своё',
    url: '',
    smallImageKey: '',
  };
}

function resolveActivityType(config) {
  if (config.presence.activityType !== 'auto') return RPC_ACTIVITY_TYPES[config.presence.activityType] ?? 0;
  if (config.activity.category === 'anime') return RPC_ACTIVITY_TYPES.watching;
  return RPC_ACTIVITY_TYPES.playing;
}

function activityTypeLabel(config) {
  if (config.presence.activityType !== 'auto') return ACTIVITY_TYPES[config.presence.activityType];
  return config.activity.category === 'anime' ? ACTIVITY_TYPES.watching : ACTIVITY_TYPES.playing;
}

module.exports = {
  activityTypeLabel,
  clone,
  createConfigStore,
  deepMerge,
  getPlatform,
  normaliseConfig,
  resolveActivityType,
  unknownTemplateKeys,
  validateConfig,
};
