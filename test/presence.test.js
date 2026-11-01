'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { deepMerge, normaliseConfig } = require('../src/main/config');
const { buildPresence, resolveVoice } = require('../src/main/presenceBuilder');

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const STARTED_AT = new Date(NOW - (3 * 60 + 12) * 60_000).toISOString();
const GUILD_ID = '223456789012345678';
const CHANNEL_ID = '423456789012345678';
const GENERAL_ID = '523456789012345678';

function makeConfig(overrides = {}) {
  return normaliseConfig(
    deepMerge(
      {
        discord: {
          applicationId: '123456789012345678',
          guildId: GUILD_ID,
          userId: '323456789012345678',
          autoVoice: true,
        },
        voice: {
          serverName: 'aruku',
          channelName: 'Voice',
          channelUrl: `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}`,
          showJoinButton: true,
          showNotInVoice: true,
          notInVoiceText: 'не в войсе',
        },
        stream: {
          platformId: 'twitch',
          startedAt: STARTED_AT,
          showNativeTimer: false,
        },
        activity: {
          presetId: 'custom',
          title: 'Frieren',
          category: 'anime',
          gifUrl: 'https://files.catbox.moe/abc.gif',
        },
        presence: {
          details: '{P} • {activity}',
          state: '{place} • {time}',
          largeText: '{activity}',
          smallText: '{P} • {time}',
          largeImageKey: '',
          smallImageKey: '',
          showButtons: true,
          activityType: 'auto',
          fallbackActivity: 'Chill',
        },
        platforms: [{ id: 'twitch', name: 'Twitch', url: 'https://twitch.tv/taro', smallImageKey: '' }],
        presets: [{ id: 'custom', title: 'Frieren', category: 'anime', gifUrl: '' }],
      },
      overrides,
    ),
  );
}

const autoVoice = {
  online: true,
  inVoice: true,
  guildId: GUILD_ID,
  guildName: 'aruku',
  channelId: GENERAL_ID,
  channelName: 'General',
  url: `https://discord.com/channels/${GUILD_ID}/${GENERAL_ID}`,
};

test('buildPresence собирает ручной статус с GIF и кнопками', () => {
  const config = makeConfig();
  const { activity, preview } = buildPresence(config, { voice: null, now: NOW });

  assert.equal(preview.details, 'Twitch • Frieren');
  assert.equal(preview.state, 'aruku / Voice • ⏱ 3h 12m');
  assert.equal(preview.title, 'Frieren');
  assert.equal(preview.platformName, 'Twitch');
  assert.equal(preview.elapsed, '3h 12m');
  assert.equal(preview.voiceSource, 'manual');
  assert.equal(preview.imageKind, 'gif-url');
  assert.equal(activity.largeImageKey, 'https://files.catbox.moe/abc.gif');
  assert.equal(activity.type, 3);
  assert.equal(activity.startTimestamp, undefined);
  assert.equal(activity.stateUrl, `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}`);
  assert.deepEqual(activity.buttons.map((button) => button.label), ['🎧 Войти в войс', '📺 Twitch']);
  assert.deepEqual(activity.buttons.map((button) => button.url), [
    `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}`,
    'https://twitch.tv/taro',
  ]);
});

test('buildPresence использует авто-войс и ссылку на канал', () => {
  const config = makeConfig();
  const { activity, preview } = buildPresence(config, { voice: autoVoice, now: NOW });

  assert.equal(preview.voiceSource, 'auto');
  assert.equal(preview.serverName, 'aruku');
  assert.equal(preview.channelName, 'General');
  assert.equal(preview.state, 'aruku / General • ⏱ 3h 12m');
  assert.equal(activity.stateUrl, autoVoice.url);
  assert.equal(activity.buttons[0].url, autoVoice.url);
  assert.equal(preview.voiceUrl, autoVoice.url);
});

test('buildPresence показывает «не в войсе» и не добавляет кнопку войса', () => {
  const config = makeConfig();
  const { activity, preview } = buildPresence(config, {
    voice: { online: true, inVoice: false, guildId: GUILD_ID, guildName: 'aruku' },
    now: NOW,
  });

  assert.equal(preview.voiceSource, 'not_in_voice');
  assert.equal(preview.channelName, 'не в войсе');
  assert.equal(preview.state, 'aruku / не в войсе • ⏱ 3h 12m');
  assert.equal(activity.stateUrl, undefined);
  assert.deepEqual(activity.buttons.map((button) => button.label), ['📺 Twitch']);
});

test('buildPresence откатывается к ручному войсу, если «не в войсе» отключено', () => {
  const config = makeConfig({ voice: { showNotInVoice: false } });
  const { preview } = buildPresence(config, {
    voice: { online: true, inVoice: false, guildId: GUILD_ID, guildName: 'aruku' },
    now: NOW,
  });
  assert.equal(preview.voiceSource, 'manual');
  assert.equal(preview.channelName, 'Voice');
});

test('resolveVoice не падает без контекста', () => {
  const config = makeConfig();
  const voice = resolveVoice(config, undefined);
  assert.equal(voice.source, 'manual');
  assert.equal(voice.url, `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}`);
});

test('buildPresence поддерживает нативный таймер Discord', () => {
  const config = makeConfig({ stream: { showNativeTimer: true } });
  const { activity } = buildPresence(config, { voice: null, now: NOW });
  assert.equal(activity.startTimestamp, NOW - (3 * 60 + 12) * 60_000);
});

test('buildPresence без таймера убирает время и висящий разделитель', () => {
  const config = makeConfig({ stream: { startedAt: null } });
  const { activity, preview } = buildPresence(config, { voice: null, now: NOW });
  assert.equal(preview.state, 'aruku / Voice');
  assert.equal(preview.elapsed, '');
  assert.equal(preview.elapsedHms, '');
  assert.equal(activity.startTimestamp, undefined);
});

test('buildPresence отключает кнопки флагами', () => {
  const noButtons = buildPresence(makeConfig({ presence: { showButtons: false } }), { now: NOW });
  assert.equal(noButtons.activity.buttons, undefined);

  const noJoin = buildPresence(makeConfig({ voice: { showJoinButton: false } }), { now: NOW });
  assert.deepEqual(noJoin.activity.buttons.map((button) => button.label), ['📺 Twitch']);
});

test('buildPresence не дублирует кнопки с одинаковым URL', () => {
  const config = makeConfig({
    platforms: [
      {
        id: 'twitch',
        name: 'Twitch',
        url: `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}`,
        smallImageKey: '',
      },
    ],
  });
  const { activity } = buildPresence(config, { now: NOW });
  assert.equal(activity.buttons.length, 1);
});

test('buildPresence добавляет маленькую иконку площадки', () => {
  const config = makeConfig({
    platforms: [{ id: 'twitch', name: 'Twitch', url: 'https://twitch.tv/taro', smallImageKey: 'twitch' }],
  });
  const { activity, preview } = buildPresence(config, { now: NOW });
  assert.equal(activity.smallImageKey, 'twitch');
  assert.equal(activity.smallImageText, 'Twitch • ⏱ 3h 12m');
  assert.equal(preview.smallImageKey, 'twitch');
});

test('buildPresence использует asset key, если GIF не задан', () => {
  const config = makeConfig({
    activity: { gifUrl: '' },
    presence: { largeImageKey: 'rpc-location' },
  });
  const { activity, preview } = buildPresence(config, { now: NOW });
  assert.equal(activity.largeImageKey, 'rpc-location');
  assert.equal(preview.imageKind, 'asset');
  assert.equal(preview.imageKey, 'rpc-location');
  assert.equal(preview.imageUrl, '');
});

test('buildPresence учитывает явный тип активности', () => {
  const config = makeConfig({ presence: { activityType: 'playing' } });
  const { activity, preview } = buildPresence(config, { now: NOW });
  assert.equal(activity.type, 0);
  assert.equal(preview.typeLabel, 'Играет');
});

test('buildPresence выбирает «Играет» для игр в авто-режиме', () => {
  const config = makeConfig({ activity: { category: 'game', title: 'Minecraft' } });
  const { activity, preview } = buildPresence(config, { now: NOW });
  assert.equal(activity.type, 0);
  assert.equal(preview.typeLabel, 'Играет');
});

test('buildPresence не добавляет http-кнопку', () => {
  const config = makeConfig({
    platforms: [{ id: 'twitch', name: 'Twitch', url: 'http://twitch.tv/taro', smallImageKey: '' }],
  });
  const { activity } = buildPresence(config, { now: NOW });
  assert.equal(activity.buttons.length, 1);
  assert.equal(activity.buttons[0].label, '🎧 Войти в войс');
});

test('buildPresence обрезает слишком длинные строки', () => {
  const config = makeConfig({
    activity: { title: 'A'.repeat(200) },
    presence: { details: '{activity}{activity}' },
  });
  const { activity } = buildPresence(config, { now: NOW });
  assert.equal(activity.details.length, 128);
  assert.ok(activity.details.endsWith('…'));
});

test('buildPresence сохраняет неизвестные плейсхолдеры', () => {
  const config = makeConfig({ presence: { details: '{P} {unknown}' } });
  const { activity } = buildPresence(config, { now: NOW });
  assert.equal(activity.details, 'Twitch {unknown}');
});

test('buildPresence не строит ссылку на войс без ID канала', () => {
  const config = makeConfig();
  const { activity, preview } = buildPresence(config, {
    voice: { online: true, inVoice: true, guildId: GUILD_ID, guildName: 'aruku', channelName: 'General' },
    now: NOW,
  });
  assert.equal(preview.voiceSource, 'auto');
  assert.equal(activity.stateUrl, undefined);
  assert.deepEqual(activity.buttons.map((button) => button.label), ['📺 Twitch']);
});
