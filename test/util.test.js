'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTemplateVariables,
  cleanPresenceText,
  extractBotApplicationId,
  formatDuration,
  formatHms,
  isHttpUrl,
  isHttpsUrl,
  isSnowflake,
  makeChannelUrl,
  parseDiscordChannelUrl,
  redactSecrets,
  renderPresenceField,
  renderTemplate,
  slugify,
  truncate,
  uniqueId,
} = require('../src/main/util');

test('formatDuration показывает Xh Ym', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(59_999), '0m');
  assert.equal(formatDuration(60_000), '1m');
  assert.equal(formatDuration(3 * 3_600_000 + 12 * 60_000), '3h 12m');
  assert.equal(formatDuration(26 * 3_600_000), '26h 0m');
  assert.equal(formatDuration(-5000), '0m');
});

test('formatHms показывает часы, минуты и секунды', () => {
  assert.equal(formatHms(0), '00:00:00');
  assert.equal(formatHms(3_723_000), '01:02:03');
  assert.equal(formatHms(100 * 3_600_000), '100:00:00');
});

test('renderTemplate подставляет известные переменные и оставляет неизвестные', () => {
  assert.equal(
    renderTemplate('{P} • {activity} • {unknown}', { P: 'Twitch', activity: 'Frieren' }),
    'Twitch • Frieren • {unknown}',
  );
  assert.equal(renderTemplate('{P}', { P: undefined }), '');
});

test('cleanPresenceText убирает висящие разделители', () => {
  assert.equal(cleanPresenceText('  aruku   /  Voice • ⏱ '), 'aruku / Voice');
  assert.equal(cleanPresenceText('Twitch •  Chill'), 'Twitch • Chill');
  assert.equal(cleanPresenceText('• • Twitch • • Chill • •'), 'Twitch • Chill');
  assert.equal(cleanPresenceText(''), '');
});

test('renderPresenceField обрезает длинный текст', () => {
  const result = renderPresenceField('{activity}', { activity: 'x'.repeat(200) }, 128);
  assert.equal(result.length, 128);
  assert.ok(result.endsWith('…'));
});

test('truncate не ломает короткие строки', () => {
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate(null, 10), '');
});

test('parseDiscordChannelUrl понимает ссылки и discord://', () => {
  assert.deepEqual(parseDiscordChannelUrl('https://discord.com/channels/123456789012345678/223456789012345678'), {
    guildId: '123456789012345678',
    channelId: '223456789012345678',
    url: 'https://discord.com/channels/123456789012345678/223456789012345678',
  });
  assert.equal(
    parseDiscordChannelUrl('discord://-/channels/123456789012345678/223456789012345678').url,
    'https://discord.com/channels/123456789012345678/223456789012345678',
  );
  assert.equal(makeChannelUrl('123456789012345678', '223456789012345678'), 'https://discord.com/channels/123456789012345678/223456789012345678');
  assert.equal(parseDiscordChannelUrl('https://example.com/channels/1/2'), null);
  assert.equal(parseDiscordChannelUrl('https://discord.com/channels/@me/223456789012345678').guildId, '');
});

test('isSnowflake и URL-проверки', () => {
  assert.equal(isSnowflake('123456789012345678'), true);
  assert.equal(isSnowflake('123'), false);
  assert.equal(isHttpUrl('http://example.com'), true);
  assert.equal(isHttpsUrl('https://example.com/a.gif'), true);
  assert.equal(isHttpsUrl('http://example.com/a.gif'), false);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
});

test('extractBotApplicationId декодирует первый сегмент токена', () => {
  const id = '123456789012345678';
  const token = `${Buffer.from(id).toString('base64')}.abc.def`;
  assert.equal(extractBotApplicationId(token), id);
  assert.equal(extractBotApplicationId('not-a-token'), '');
});

test('redactSecrets вырезает токены и секреты', () => {
  const token = 'MTAxMDEwMTAxMDEwMTAxMDEw.abcdef.ghijklmnopqrstuvwxyz';
  const text = `Ошибка с токеном ${token} и секретом super-secret-value`;
  const redacted = redactSecrets(text, [token, 'super-secret-value']);
  assert.ok(!redacted.includes(token));
  assert.ok(!redacted.includes('super-secret-value'));
  assert.ok(redacted.includes('[скрыто]'));
});

test('slugify и uniqueId создают стабильные идентификаторы', () => {
  assert.equal(slugify('Frieren: Beyond Journey’s End'), 'frieren-beyond-journey-s-end');
  assert.equal(slugify('Аниме вечер'), 'аниме-вечер');
  assert.equal(slugify(''), 'item');
  assert.equal(uniqueId('Frieren', ['frieren']), 'frieren-2');
  assert.equal(uniqueId('Frieren', ['frieren', 'frieren-2']), 'frieren-3');
});

test('buildTemplateVariables собирает place и time', () => {
  const variables = buildTemplateVariables({
    platform: 'Twitch',
    activity: 'Frieren',
    server: 'aruku',
    voice: 'Voice',
    elapsed: '2h 3m',
  });
  assert.equal(variables.place, 'aruku / Voice');
  assert.equal(variables.time, '⏱ 2h 3m');
  assert.equal(
    buildTemplateVariables({ server: 'aruku', voice: 'Voice', elapsed: '2h 3m', includesTimeIcon: false }).time,
    '2h 3m',
  );
});
