'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  activityTypeLabel,
  clone,
  createConfigStore,
  deepMerge,
  getPlatform,
  normaliseConfig,
  resolveActivityType,
  unknownTemplateKeys,
  validateConfig,
} = require('../src/main/config');
const { DEFAULT_CONFIG, RPC_ACTIVITY_TYPES } = require('../src/main/constants');

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'taro-rpc-test-'));
}

test('normaliseConfig заполняет значения по умолчанию', () => {
  const config = normaliseConfig({});
  assert.equal(config.version, 1);
  assert.ok(config.platforms.length >= 5);
  assert.ok(config.presets.length >= 5);
  assert.equal(config.voice.serverName, DEFAULT_CONFIG.voice.serverName);
  assert.equal(config.app.displayName, DEFAULT_CONFIG.app.displayName);
  assert.equal(config.activity.presetId, DEFAULT_CONFIG.activity.presetId);
  assert.equal(config.activity.title, DEFAULT_CONFIG.activity.title);
});

test('normaliseConfig сохраняет валидные значения и нормализует ID', () => {
  const config = normaliseConfig({
    discord: {
      applicationId: '123456789012345678',
      guildId: '223456789012345678',
      userId: 'not-an-id',
      autoVoice: false,
    },
    stream: {
      platformId: 'youtube',
      startedAt: '2025-01-01T10:00:00.000Z',
    },
    activity: {
      presetId: 'custom',
      title: '  Frieren  ',
      category: 'anime',
      gifUrl: 'https://files.catbox.moe/example.gif',
    },
  });
  assert.equal(config.discord.applicationId, '123456789012345678');
  assert.equal(config.discord.guildId, '223456789012345678');
  assert.equal(config.discord.userId, '');
  assert.equal(config.discord.autoVoice, false);
  assert.equal(config.stream.platformId, 'youtube');
  assert.equal(config.stream.startedAt, '2025-01-01T10:00:00.000Z');
  assert.equal(config.activity.title, 'Frieren');
});

test('normaliseConfig сохраняет пустые названия пресетов и площадок', () => {
  const config = normaliseConfig({
    presets: [{ id: 'one', title: '', category: 'anime', gifUrl: '' }],
    platforms: [{ id: 'custom', name: '', url: '', smallImageKey: '' }],
  });
  assert.equal(config.presets[0].title, 'Без названия');
  assert.equal(config.platforms[0].name, 'custom');
});

test('normaliseConfig разбирает ссылку на войс и выводит channelId', () => {
  const config = normaliseConfig({
    discord: { guildId: '123456789012345678' },
    voice: { channelUrl: 'https://discord.com/channels/123456789012345678/223456789012345678' },
  });
  assert.equal(config.voice.channelUrl, 'https://discord.com/channels/123456789012345678/223456789012345678');
  assert.equal(config.voice.inferredChannelId, '223456789012345678');
});

test('normaliseConfig не мутирует исходный объект', () => {
  const source = { discord: { applicationId: '123456789012345678' } };
  const copy = clone(source);
  normaliseConfig(source);
  assert.deepEqual(source, copy);
});

test('deepMerge рекурсивно объединяет объекты и заменяет массивы', () => {
  const base = { a: { b: 1, c: 2 }, list: [1, 2], keep: true };
  const merged = deepMerge(base, { a: { b: 5 }, list: [9] });
  assert.deepEqual(merged, { a: { b: 5, c: 2 }, list: [9], keep: true });
  assert.equal(base.a.b, 1);
});

test('resolveActivityType выбирает тип по категории', () => {
  const anime = normaliseConfig({ activity: { category: 'anime' } });
  const game = normaliseConfig({ activity: { category: 'game' } });
  assert.equal(resolveActivityType(anime), RPC_ACTIVITY_TYPES.watching);
  assert.equal(resolveActivityType(game), RPC_ACTIVITY_TYPES.playing);
  assert.equal(activityTypeLabel(anime), 'Смотрит');
  assert.equal(activityTypeLabel(game), 'Играет');

  const explicit = normaliseConfig({
    activity: { category: 'anime' },
    presence: { activityType: 'listening' },
  });
  assert.equal(resolveActivityType(explicit), RPC_ACTIVITY_TYPES.listening);
  assert.equal(activityTypeLabel(explicit), 'Слушает');
});

test('getPlatform возвращает выбранную площадку и запасную', () => {
  const config = normaliseConfig({});
  assert.equal(getPlatform(config, 'youtube').name, 'YouTube');
  const fallback = getPlatform({ ...config, platforms: [] }, 'missing');
  assert.equal(fallback.id, 'custom');
});

test('unknownTemplateKeys находит неизвестные плейсхолдеры', () => {
  assert.deepEqual(unknownTemplateKeys('{P} {activity} {time} {place} {unknown} {ещё}'), ['unknown', 'ещё']);
  assert.deepEqual(unknownTemplateKeys('{server}/{voice}/{elapsed}/{platform}'), []);
});

test('validateConfig предупреждает о незаполненных полях', () => {
  const config = normaliseConfig({ discord: { autoVoice: true } });
  const { errors, warnings } = validateConfig(config);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((warning) => warning.includes('Application ID')));
  assert.ok(warnings.some((warning) => warning.includes('токен бота')));
  assert.ok(warnings.some((warning) => warning.includes('ID сервера')));
  assert.ok(warnings.some((warning) => warning.includes('ID пользователя')));
});

test('validateConfig считает ошибкой неверный Application ID и старт в будущем', () => {
  const config = normaliseConfig({
    discord: { applicationId: '123' },
    stream: { startedAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  const { errors } = validateConfig(config);
  assert.ok(errors.some((error) => error.includes('17–20 цифр')));
  assert.ok(errors.some((error) => error.includes('будущем')));
});

test('validateConfig предупреждает о нестандартных ссылках и шаблонах', () => {
  const config = normaliseConfig({
    discord: { applicationId: '123456789012345678' },
    activity: { gifUrl: 'http://example.com/a.gif' },
    presence: { details: '{unknown}' },
  });
  const { warnings } = validateConfig(config);
  assert.ok(warnings.some((warning) => warning.includes('GIF-ссылка')));
  assert.ok(warnings.some((warning) => warning.includes('{unknown}')));
});

test('createConfigStore шифрует токен и расшифровывает при загрузке', () => {
  const directory = tempDirectory();
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (buffer) => buffer.toString('utf8').replace(/^encrypted:/, ''),
  };
  const logger = { warn: () => {}, info: () => {}, error: () => {} };
  const store = createConfigStore({ userDataDir: directory, safeStorage: fakeSafeStorage, logger });

  const config = normaliseConfig({
    discord: { applicationId: '123456789012345678', botToken: 'first.second.third' },
  });
  store.save(config);

  const raw = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  assert.equal(raw.discord.botToken, '');
  assert.ok(typeof raw.discord.botTokenEnc === 'string' && raw.discord.botTokenEnc.length > 0);

  const loaded = store.load();
  assert.equal(loaded.discord.botToken, 'first.second.third');

  fs.rmSync(directory, { recursive: true, force: true });
});

test('createConfigStore хранит токен без шифрования, если оно недоступно', () => {
  const directory = tempDirectory();
  const fakeSafeStorage = {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('should not be called');
    },
    decryptString: () => '',
  };
  const store = createConfigStore({ userDataDir: directory, safeStorage: fakeSafeStorage, logger: { warn: () => {} } });
  store.save(normaliseConfig({ discord: { botToken: 'plain.token.value' } }));
  const raw = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  assert.equal(raw.discord.botToken, 'plain.token.value');
  fs.rmSync(directory, { recursive: true, force: true });
});
