'use strict';

/**
 * Static consistency checks for the project. Runs without Electron and
 * without a display server:
 *
 *   - syntax-checks every JavaScript file
 *   - verifies that every DOM id used by the renderer exists in index.html
 *   - verifies that every `taro.*` call is exposed by preload
 *   - verifies that every IPC channel has a handler / sender
 *   - verifies that data-field bindings exist in the default config
 *   - verifies generated assets and their signatures
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const failures = [];
const warnings = [];
let passed = 0;

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function pass() {
  passed += 1;
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function walk(directory) {
  const result = [];
  for (const entry of fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      result.push(...walk(relative));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      result.push(relative);
    }
  }
  return result;
}

function unique(values) {
  return [...new Set(values)];
}

/* ------------------------------------------------------------------ syntax */

function checkSyntax() {
  const files = unique([
    ...walk('src'),
    ...walk('scripts'),
    ...walk('test'),
    'scripts/check.js',
  ]).filter((file) => exists(file));

  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, file)], {
        stdio: 'pipe',
      });
    } catch (error) {
      const details = String(error.stderr || error.message).trim().split('\n').slice(0, 4).join(' ');
      fail(`Синтаксис ${file}: ${details}`);
    }
  }
  pass();
}

/* --------------------------------------------------------------------- DOM */

function checkDom() {
  const html = read('src/renderer/index.html');
  const renderer = read('src/renderer/renderer.js');

  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const used = new Set([
    ...renderer.matchAll(/\$\(\s*'([^']+)'\s*\)/g),
    ...renderer.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g),
    ...renderer.matchAll(/querySelector(?:All)?\(\s*'#([A-Za-z0-9_-]+)/g),
  ].map((match) => match[1]));

  const missing = [...used].filter((id) => !ids.has(id)).sort();
  if (missing.length > 0) {
    fail(`renderer обращается к несуществующим id: ${missing.join(', ')}`);
  }
  pass();

  const tabs = new Set([...html.matchAll(/class="tab[^"]*"[^>]*data-tab="([^"]+)"/g)].map((m) => m[1]));
  const tabButtons = new Set([...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]));
  const panels = new Set([...html.matchAll(/data-panel="([^"]+)"/g)].map((m) => m[1]));
  const allTabs = new Set([...tabs, ...tabButtons]);

  for (const tab of allTabs) {
    if (!panels.has(tab)) fail(`Для вкладки «${tab}» нет .tab-panel[data-panel="${tab}"]`);
  }
  for (const panel of panels) {
    if (!allTabs.has(panel)) fail(`Для панели «${panel}» нет кнопки .tab[data-tab="${panel}"]`);
  }
  pass();

  const fields = unique([...html.matchAll(/data-field="([^"]+)"/g)].map((match) => match[1]));
  const { DEFAULT_CONFIG } = require('../src/main/constants');
  const getPath = (object, dotted) =>
    String(dotted)
      .split('.')
      .reduce((current, key) => (current === undefined || current === null ? undefined : current[key]), object);

  for (const field of fields) {
    if (field === 'platforms' || field === 'presets') continue;
    if (getPath(DEFAULT_CONFIG, field) === undefined) {
      fail(`data-field="${field}" отсутствует в DEFAULT_CONFIG`);
    }
  }
  pass();
}

/* ------------------------------------------------------------ bridge / IPC */

function checkBridge() {
  const preload = read('src/preload/preload.js');
  const renderer = read('src/renderer/renderer.js');
  const main = read('src/main/main.js');

  const exposed = new Set(
    [...preload.matchAll(/^\s{2}([A-Za-z0-9_]+):/gm)].map((match) => match[1]),
  );
  const called = unique([...renderer.matchAll(/\btaro\.([A-Za-z0-9_]+)/g)].map((match) => match[1]));
  const missing = called.filter((name) => !exposed.has(name));
  if (missing.length > 0) {
    fail(`renderer вызывает taro.* без preload: ${missing.join(', ')}`);
  }
  pass();

  const invokeChannels = unique(
    [...preload.matchAll(/invoke\('([^']+)'/g)].map((match) => match[1]),
  );
  const subscribeChannels = unique(
    [...preload.matchAll(/subscribe\('([^']+)'/g)].map((match) => match[1]),
  );
  const handlers = new Set(
    [...main.matchAll(/(?:handle|ipcMain\.handle)\(\s*'([^']+)'/g)].map((match) => match[1]),
  );
  const senders = new Set(
    [...main.matchAll(/webContents\.send\(\s*'([^']+)'/g)].map((match) => match[1]),
  );

  for (const channel of invokeChannels) {
    if (!handlers.has(channel)) fail(`Нет ipcMain-обработчика для «${channel}»`);
  }
  for (const channel of subscribeChannels) {
    if (!senders.has(channel)) fail(`Нет webContents.send для события «${channel}»`);
  }
  pass();

  const unused = [...handlers].filter((channel) => !invokeChannels.includes(channel));
  if (unused.length > 0) {
    warn(`Обработчики без вызова из preload: ${unused.join(', ')}`);
  }
  pass();
}

/* ------------------------------------------------------------------ assets */

function checkAssets() {
  const required = [
    'assets/icon.png',
    'assets/icon.ico',
    'assets/rpc-location.png',
    'assets/sample/aruku-live.gif',
    ...Array.from({ length: 8 }, (_, index) => `assets/tray/frame-${String(index).padStart(2, '0')}.png`),
  ];

  for (const file of required) {
    if (!exists(file)) {
      fail(`Нет файла ${file}. Запусти npm run assets.`);
      continue;
    }
    const buffer = fs.readFileSync(path.join(ROOT, file));
    if (buffer.length === 0) {
      fail(`Пустой файл ${file}`);
      continue;
    }
    if (file.endsWith('.png')) {
      const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (!buffer.subarray(0, 8).equals(signature)) fail(`${file}: не PNG`);
      if (buffer.length < 24 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
        fail(`${file}: повреждён IHDR`);
      }
    }
    if (file.endsWith('.gif')) {
      const header = buffer.toString('ascii', 0, 6);
      if (header !== 'GIF89a' && header !== 'GIF87a') fail(`${file}: не GIF`);
      if (buffer[buffer.length - 1] !== 0x3b) fail(`${file}: нет завершающего блока GIF`);
      if (buffer.toString('ascii').includes('NETSCAPE2.0') === false) {
        warn(`${file}: нет NETSCAPE-блока — анимация может не зацикливаться`);
      }
    }
    if (file.endsWith('.ico')) {
      if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) fail(`${file}: не ICO`);
      const count = buffer.readUInt16LE(4);
      if (count < 6) fail(`${file}: ожидалось минимум 6 размеров, найдено ${count}`);
    }
  }
  pass();

  const frames = required.filter((file) => file.includes('/tray/'));
  const digests = new Set(
    frames.map((file) =>
      crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, file))).digest('hex'),
    ),
  );
  if (frames.length > 0 && digests.size < 4) {
    fail(`Кадры трея почти одинаковые: уникальных ${digests.size} из ${frames.length}`);
  }
  pass();
}

/* ----------------------------------------------------------------- package */

function checkPackage() {
  let manifest;
  try {
    manifest = JSON.parse(read('package.json'));
  } catch (error) {
    fail(`package.json не читается: ${error.message}`);
    return;
  }

  if (!manifest.main || !exists(manifest.main)) fail(`package.json main не найден: ${manifest.main}`);
  if (!manifest.scripts?.start) fail('В package.json нет scripts.start');
  if (!manifest.scripts?.test) fail('В package.json нет scripts.test');
  if (!manifest.scripts?.check) fail('В package.json нет scripts.check');
  if (!exists('src/renderer/index.html')) fail('Нет src/renderer/index.html');
  if (!exists('src/renderer/styles.css')) fail('Нет src/renderer/styles.css');
  pass();

  const icon = 'assets/icon.ico';
  if (manifest.scripts?.['pack:win'] && !exists(icon)) {
    fail(`Сборка Windows ссылается на ${icon}, но файла нет`);
  }
  pass();
}

/* -------------------------------------------------------------------- main */

function run() {
  console.log('Taro RPC — проверка проекта\n');

  checkSyntax();
  checkDom();
  checkBridge();
  checkAssets();
  checkPackage();

  for (const message of warnings) console.log(`  [!] ${message}`);
  for (const message of failures) console.log(`  [FAIL] ${message}`);

  if (failures.length > 0) {
    console.log(`\nИтог: ${passed} проверок пройдено, ${failures.length} ошибок, ${warnings.length} предупреждений.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nИтог: ${passed} проверок пройдено, 0 ошибок, ${warnings.length} предупреждений.`);
}

run();
