'use strict';

const { LIMITS } = require('./constants');
const { activityTypeLabel, getPlatform, resolveActivityType } = require('./config');
const {
  buildTemplateVariables,
  cleanPresenceText,
  formatDuration,
  formatHms,
  isHttpsUrl,
  makeChannelUrl,
  renderPresenceField,
  truncate,
} = require('./util');

function safeHttps(value) {
  return isHttpsUrl(value) ? String(value).trim() : '';
}

function resolveVoice(config, context) {
  const manual = {
    serverName: config.voice.serverName || 'aruku',
    channelName: config.voice.channelName || 'Voice',
    url: safeHttps(config.voice.channelUrl),
  };

  const detected = context?.voice;
  if (detected?.inVoice && (detected.channelId || detected.channelName)) {
    return {
      source: 'auto',
      serverName: detected.guildName || manual.serverName,
      channelName: detected.channelName || manual.channelName,
      url: safeHttps(detected.url) || makeChannelUrl(detected.guildId || config.discord.guildId, detected.channelId),
      guildId: detected.guildId || config.discord.guildId,
      channelId: detected.channelId || '',
    };
  }

  if (detected?.online && !detected.inVoice && config.voice.showNotInVoice) {
    return {
      source: 'not_in_voice',
      serverName: detected.guildName || manual.serverName,
      channelName: config.voice.notInVoiceText || 'не в войсе',
      url: '',
      guildId: detected.guildId || config.discord.guildId,
      channelId: '',
    };
  }

  return {
    source: 'manual',
    serverName: manual.serverName,
    channelName: manual.channelName,
    url: manual.url,
    guildId: config.discord.guildId,
    channelId: config.voice.inferredChannelId || '',
  };
}

function buildButton(label, url) {
  if (!isHttpsUrl(url)) return null;
  return {
    label: truncate(String(label || '').trim(), LIMITS.buttonLabel) || 'Открыть',
    url: truncate(String(url).trim(), LIMITS.buttonUrl),
  };
}

function dedupeButtons(buttons) {
  const seen = new Set();
  const result = [];
  for (const button of buttons) {
    if (!button || seen.has(button.url)) continue;
    seen.add(button.url);
    result.push(button);
    if (result.length >= 2) break;
  }
  return result;
}

function buildPresence(config, context = {}) {
  const now = Number(context.now) || Date.now();
  const platform = getPlatform(config);
  const platformName = platform.name || 'Своё';
  const platformUrl = safeHttps(platform.url || '');
  const title = String(config.activity.title || '').trim() || config.presence.fallbackActivity || 'Chill';
  const voice = resolveVoice(config, context);

  let startedAt = null;
  let elapsedMs = 0;
  if (config.stream.startedAt) {
    const parsed = new Date(config.stream.startedAt);
    if (Number.isFinite(parsed.getTime())) {
      startedAt = parsed;
      elapsedMs = Math.max(0, now - parsed.getTime());
    }
  }

  const elapsed = startedAt ? formatDuration(elapsedMs) : '';
  const variables = buildTemplateVariables({
    platform: platformName,
    activity: title,
    server: voice.serverName,
    voice: voice.channelName,
    elapsed,
  });

  const details = renderPresenceField(config.presence.details, variables, LIMITS.details) || title;
  const state =
    renderPresenceField(config.presence.state, variables, LIMITS.state) ||
    cleanPresenceText(variables.place) ||
    voice.serverName;
  const largeText = renderPresenceField(config.presence.largeText, variables, LIMITS.imageText) || title;
  const smallText =
    renderPresenceField(config.presence.smallText, variables, LIMITS.imageText) ||
    [platformName, elapsed ? `⏱ ${elapsed}` : ''].filter(Boolean).join(' • ');

  const gifUrl = safeHttps(config.activity.gifUrl);
  const largeImageKey = truncate(gifUrl || config.presence.largeImageKey || '', 512);
  const smallImageKey = truncate(platform.smallImageKey || config.presence.smallImageKey || '', 256);
  const largeImageIsUrl = isHttpsUrl(largeImageKey);
  const smallImageIsUrl = isHttpsUrl(smallImageKey);

  const buttons = config.presence.showButtons
    ? dedupeButtons([
        config.voice.showJoinButton ? buildButton('🎧 Войти в войс', voice.url) : null,
        buildButton(`📺 ${platformName}`, platformUrl),
      ])
    : [];

  const activity = {
    type: resolveActivityType(config),
    details,
    state,
    detailsUrl: platformUrl || undefined,
    stateUrl: safeHttps(voice.url) || undefined,
    largeImageKey: largeImageKey || undefined,
    largeImageText: largeImageKey ? largeText : undefined,
    largeImageUrl: largeImageKey && platformUrl ? platformUrl : undefined,
    smallImageKey: smallImageKey || undefined,
    smallImageText: smallImageKey ? smallText : undefined,
    smallImageUrl: smallImageKey && platformUrl ? platformUrl : undefined,
    buttons: buttons.length > 0 ? buttons : undefined,
    startTimestamp: startedAt && config.stream.showNativeTimer ? startedAt.getTime() : undefined,
  };

  const imageKind = !largeImageKey
    ? 'none'
    : largeImageIsUrl
      ? /\.gif(?:$|\?)/i.test(largeImageKey)
        ? 'gif-url'
        : 'image-url'
      : 'asset';

  return {
    activity,
    preview: {
      appName: config.app.displayName || 'aruku',
      details,
      state,
      largeText,
      smallText,
      imageUrl: largeImageIsUrl ? largeImageKey : '',
      imageKey: largeImageIsUrl ? '' : largeImageKey,
      imageKind,
      smallImageKey,
      smallImageIsUrl,
      buttons,
      type: activity.type,
      typeLabel: activityTypeLabel(config),
      title,
      platformName,
      platformUrl,
      voiceUrl: safeHttps(voice.url),
      voiceSource: voice.source,
      serverName: voice.serverName,
      channelName: voice.channelName,
      elapsed,
      elapsedHms: startedAt ? formatHms(elapsedMs) : '',
      startedAt: startedAt ? startedAt.toISOString() : null,
      nativeTimer: Boolean(activity.startTimestamp),
      activityType: config.presence.activityType,
      category: config.activity.category,
    },
    meta: {
      now,
      elapsedMs,
      voiceSource: voice.source,
      platformName,
      platformUrl,
      voiceUrl: safeHttps(voice.url),
    },
  };
}

module.exports = {
  buildPresence,
  resolveVoice,
};
