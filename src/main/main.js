'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell,
} = require('electron');

const catbox = require('./catbox');
const {
  clone,
  createConfigStore,
  deepMerge,
  getPlatform,
  normaliseConfig,
  validateConfig,
} = require('./config');
const { DEFAULT_CONFIG } = require('./constants');
const { Logger } = require('./logger');
const { PresenceManager } = require('./presenceManager');
const { buildPresence } = require('./presenceBuilder');
const { TrayController } = require('./tray');
const { VoiceTracker } = require('./voiceTracker');
const {
  extractBotApplicationId,
  formatDuration,
  formatHms,
  isHttpUrl,
  isSnowflake,
  redactSecrets,
  safeError,
} = require('./util');

const APP_ROOT = path.join(__dirname, '..', '..');
const ASSETS_DIR = path.join(APP_ROOT, 'assets');
const RENDERER_PATH = path.join(__dirname, '..', 'renderer', 'index.html');
const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'preload.js');
const SAMPLE_GIF_PATH = path.join(ASSETS_DIR, 'sample', 'aruku-live.gif');
const ICON_PATH = path.join(ASSETS_DIR, 'icon.png');
const TRAY_FRAME_DIR = path.join(ASSETS_DIR, 'tray');

let mainWindow = null;
let trayController = null;
let configStore = null;
let logger = null;
let config = null;
let voice = null;
let previousVoice = null;
let rpcUser = null;
let botGuilds = [];
let lastSnapshot = null;
let presenceManager = null;
let voiceTracker = null;
let timerInterval = null;
let broadcastTimer = null;
let isQuitting = false;
let shuttingDown = false;
let autoStartArmed = true;
let hasShownTrayBalloon = false;
let pendingTab = '';
let pendingFocusField = '';

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  app.whenReady().then(init).catch((error) => {
    console.error(error);
    app.exit(1);
  });
}

function getTrayFrames() {
  try {
    return fs
      .readdirSync(TRAY_FRAME_DIR)
      .filter((file) => /^frame-\d+\.png$/i.test(file))
      .sort()
      .map((file) => path.join(TRAY_FRAME_DIR, file));
  } catch {
    return [];
  }
}

function showTrayBalloonOnce() {
  if (hasShownTrayBalloon || process.platform !== 'win32') return;
  hasShownTrayBalloon = true;
  try {
    trayController?.tray?.displayBalloon?.({
      title: 'Taro RPC',
      content: 'Приложение свёрнуто в трей. Правый клик по иконке — меню.',
      iconType: 'info',
    });
  } catch {
    // Balloons are not critical.
  }
}

function shouldShowOnStart() {
  if (!config?.discord?.applicationId) return true;
  if (process.argv.includes('--hidden')) return false;
  if (!config.app.showSettingsOnStart) return false;
  try {
    const login = app.getLoginItemSettings();
    if (login.wasOpenedAtLogin) return false;
  } catch {
    // ignore
  }
  return true;
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  const bounds = config?.ui?.windowBounds || { width: 1180, height: 820 };
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#141519',
    title: 'Taro RPC',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(RENDERER_PATH);

  mainWindow.once('ready-to-show', () => {
    if (shouldShowOnStart()) showWindow();
  });

  mainWindow.webContents.once('did-finish-load', () => {
    sendStateNow();
    if (pendingTab) {
      mainWindow.webContents.send('focus-tab', pendingTab);
      pendingTab = '';
    }
    if (pendingFocusField) {
      mainWindow.webContents.send('focus-field', pendingFocusField);
      pendingFocusField = '';
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) return;
    event.preventDefault();
    openExternalSafe(url);
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toLowerCase();
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.on('close', (event) => {
    saveWindowBounds();
    if (!isQuitting && config?.app?.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
      showTrayBalloonOnce();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !config) return;
  try {
    config.ui.windowBounds = mainWindow.getBounds();
    config = configStore.save(config);
  } catch (error) {
    logger?.warn?.(`Не удалось сохранить размер окна: ${error.message}`);
  }
}

function showWindow(tab = '') {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!mainWindow) return;
  if (tab) pendingTab = tab;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  sendStateNow();
  if (pendingTab && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('focus-tab', pendingTab);
    pendingTab = '';
  }
  if (pendingFocusField && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('focus-field', pendingFocusField);
    pendingFocusField = '';
  }
}

function focusField(field) {
  pendingFocusField = field;
  showWindow('activity');
  if (pendingFocusField && mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('focus-field', pendingFocusField);
    pendingFocusField = '';
  }
}

function hideWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    saveWindowBounds();
    mainWindow.hide();
  }
}

function openExternalSafe(url) {
  if (!isHttpUrl(url)) {
    logger?.warn?.(`Заблокирована внешняя ссылка: ${String(url).slice(0, 120)}`);
    return false;
  }
  try {
    shell.openExternal(url);
    return true;
  } catch (error) {
    logger?.warn?.(`Не удалось открыть ссылку: ${error.message}`);
    return false;
  }
}

function buildInviteUrl() {
  const botApplicationId =
    extractBotApplicationId(config?.discord?.botToken || '') || config?.discord?.applicationId || '';
  if (!botApplicationId || !isSnowflake(botApplicationId)) return '';
  const params = new URLSearchParams({
    client_id: botApplicationId,
    permissions: '1024',
    scope: 'bot',
  });
  if (config?.discord?.guildId) params.set('guild_id', config.discord.guildId);
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

function getIdentityWarning() {
  const warnings = [];
  const botApplicationId = extractBotApplicationId(config?.discord?.botToken || '');
  if (
    botApplicationId &&
    config?.discord?.applicationId &&
    botApplicationId !== config.discord.applicationId
  ) {
    warnings.push(
      'Бот и RPC используют разные Discord-приложения. Это работает, но название активности берётся из RPC-приложения.',
    );
  }
  if (rpcUser?.id && config?.discord?.userId && rpcUser.id !== config.discord.userId) {
    warnings.push(
      `RPC подключён как ${rpcUser.username || rpcUser.id}, а для авто-войса указан другой user ID.`,
    );
  }
  return warnings;
}

function buildSnapshot() {
  if (!config) {
    return { ready: false };
  }

  const now = Date.now();
  let presence = null;
  try {
    presence = buildPresence(config, { voice, now });
  } catch (error) {
    logger?.error?.(`Не удалось собрать presence: ${error.message}`);
    presence = {
      activity: {},
      preview: {
        appName: config.app.displayName,
        details: '',
        state: '',
        imageUrl: '',
        imageKey: '',
        imageKind: 'none',
        buttons: [],
        typeLabel: '',
        title: config.activity.title,
        platformName: getPlatform(config).name,
        platformUrl: '',
        voiceUrl: '',
        voiceSource: 'manual',
        serverName: config.voice.serverName,
        channelName: config.voice.channelName,
        elapsed: '',
        elapsedHms: '',
        startedAt: null,
        nativeTimer: false,
        category: config.activity.category,
        activityType: config.presence.activityType,
      },
      meta: {},
    };
  }

  const startedAt = config.stream.startedAt ? new Date(config.stream.startedAt).getTime() : null;
  const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const running = Boolean(startedAt);
  const rpcStatus = presenceManager?.getStatus() || {
    state: 'idle',
    message: 'Не подключено',
    connected: false,
    user: null,
  };
  const botStatus = voiceTracker?.getStatus() || {
    state: 'off',
    message: 'Авто-войс выключен',
    online: false,
    guilds: [],
    username: '',
    error: null,
  };
  const validation = validateConfig(config);
  const botApplicationId = extractBotApplicationId(config.discord.botToken || '');

  return {
    ready: true,
    now,
    config: clone(config),
    preview: presence.preview,
    timer: {
      running,
      startedAt: config.stream.startedAt,
      elapsed: running ? formatDuration(elapsedMs) : '',
      elapsedHms: running ? formatHms(elapsedMs) : '00:00:00',
      elapsedMs,
      lastSessionMs: config.stream.lastSessionMs,
      lastSessionElapsed: formatDuration(config.stream.lastSessionMs),
    },
    status: {
      rpc: rpcStatus,
      bot: {
        ...botStatus,
        guilds: botGuilds.length > 0 ? botGuilds : botStatus.guilds || [],
      },
      voice: {
        source: presence.preview.voiceSource,
        serverName: presence.preview.serverName,
        channelName: presence.preview.channelName,
        url: presence.preview.voiceUrl,
        inVoice: Boolean(voice?.inVoice),
        auto: Boolean(config.discord.autoVoice),
      },
    },
    botGuilds: botGuilds.length > 0 ? botGuilds : botStatus.guilds || [],
    rpcUser,
    botApplicationId,
    inviteUrl: buildInviteUrl(),
    identityWarnings: getIdentityWarning(),
    validation,
    logs: logger?.list?.().slice(-80) || [],
    paths: {
      config: configStore?.filePath || '',
      logs: logger?.filePath || '',
      userData: app.getPath('userData'),
      appRoot: APP_ROOT,
    },
    app: {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
    },
  };
}

function sendStateNow() {
  lastSnapshot = buildSnapshot();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('state:update', lastSnapshot);
  }
  trayController?.update(lastSnapshot);
  return lastSnapshot;
}

function broadcast() {
  if (broadcastTimer || shuttingDown) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    sendStateNow();
  }, 80);
  broadcastTimer.unref?.();
}

function applyLoginItem() {
  if (!config) return;
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(config.app.launchAtLogin),
      args: ['--hidden'],
    });
  } catch (error) {
    logger?.warn?.(`Не удалось настроить автозапуск: ${error.message}`);
  }
}

function persistAndApply(nextConfig, { log = true } = {}) {
  const previous = config;
  config = configStore.save(nextConfig);

  if (previous?.app?.launchAtLogin !== config.app.launchAtLogin) applyLoginItem();

  if (presenceManager) presenceManager.handleConfigChanged(previous);

  if (voiceTracker) {
    const botRestartKeys = ['botToken', 'autoVoice', 'botInvisible'];
    const restart =
      botRestartKeys.some((key) => previous?.discord?.[key] !== config.discord[key]) ||
      previous?.discord?.guildId !== config.discord.guildId;
    const userChanged = previous?.discord?.userId !== config.discord.userId;

    if (restart) {
      voiceTracker.restart().catch((error) => {
        logger?.error?.(`Не удалось перезапустить бота: ${safeError(error, [config.discord.botToken])}`);
      });
    } else if (userChanged) {
      voiceTracker
        .setIdentity({ userId: config.discord.userId })
        .catch((error) => logger?.warn?.(`Не удалось обновить ID пользователя: ${error.message}`));
    }
  }

  if (log) logger?.info?.('Настройки сохранены');
  broadcast();
  return config;
}

function saveConfigPatch(patch) {
  const merged = deepMerge(config, patch && typeof patch === 'object' ? patch : {});
  const candidate = normaliseConfig(merged);
  const validation = validateConfig(candidate);
  if (validation.errors.length > 0) {
    return {
      ok: false,
      errors: validation.errors,
      warnings: validation.warnings,
      snapshot: buildSnapshot(),
    };
  }

  try {
    persistAndApply(merged);
    const snapshot = sendStateNow();
    return {
      ok: true,
      errors: [],
      warnings: validation.warnings,
      snapshot,
    };
  } catch (error) {
    logger?.error?.(`Не удалось сохранить настройки: ${error.message}`);
    return {
      ok: false,
      errors: [`Не удалось сохранить: ${error.message}`],
      warnings: validation.warnings,
      snapshot: buildSnapshot(),
    };
  }
}

function findPreset(presetId) {
  return (config?.presets || []).find((preset) => preset.id === presetId) || null;
}

function selectPreset(presetId) {
  const preset = findPreset(presetId);
  if (!preset) return { ok: false, error: 'Пресет не найден' };
  const next = {
    ...config,
    activity: {
      presetId: preset.id,
      title: preset.title,
      category: preset.category,
      gifUrl: preset.gifUrl || '',
    },
  };
  persistAndApply(next);
  logger?.info?.(`Активность: ${preset.title}`);
  return { ok: true, snapshot: sendStateNow() };
}

function selectPlatform(platformId) {
  const platform = config.platforms.find((item) => item.id === platformId);
  if (!platform) return { ok: false, error: 'Площадка не найдена' };
  persistAndApply({ ...config, stream: { ...config.stream, platformId: platform.id } });
  logger?.info?.(`Площадка: ${platform.name}`);
  return { ok: true, snapshot: sendStateNow() };
}

function startTimer({ auto = false } = {}) {
  if (config.stream.startedAt) return { ok: true, alreadyRunning: true, snapshot: buildSnapshot() };
  config.stream.startedAt = new Date().toISOString();
  autoStartArmed = false;
  config = configStore.save(config);
  presenceManager?.update({ force: true }).catch(() => undefined);
  logger?.info?.(auto ? 'Таймер запущен автоматически (вход в войс)' : 'Таймер стрима запущен');
  return { ok: true, snapshot: sendStateNow() };
}

function stopTimer({ auto = false } = {}) {
  if (!config.stream.startedAt) return { ok: true, alreadyStopped: true, snapshot: buildSnapshot() };
  const startedAt = new Date(config.stream.startedAt).getTime();
  config.stream.lastSessionMs = Math.max(0, Date.now() - startedAt);
  config.stream.startedAt = null;
  autoStartArmed = false;
  config = configStore.save(config);
  presenceManager?.update({ force: true }).catch(() => undefined);
  logger?.info?.(
    `${auto ? 'Таймер остановлен автоматически (выход из войса)' : 'Таймер стрима остановлен'}: ${formatDuration(config.stream.lastSessionMs)}`,
  );
  return { ok: true, snapshot: sendStateNow() };
}

function resetTimer() {
  config.stream.startedAt = null;
  config.stream.lastSessionMs = 0;
  autoStartArmed = true;
  config = configStore.save(config);
  presenceManager?.update({ force: true }).catch(() => undefined);
  logger?.info?.('Таймер сброшен');
  return { ok: true, snapshot: sendStateNow() };
}

function handleVoice(next) {
  previousVoice = voice;
  voice = next;

  if (next?.inVoice) {
    const event = next.event || 'poll';
    if (event === 'join' || event === 'initial') {
      logger?.info?.(`Войс: ${next.guildName || ''} / ${next.channelName || ''}`);
      if (config.stream.autoStart && autoStartArmed && !config.stream.startedAt) {
        startTimer({ auto: true });
      }
    }
    if (event === 'move') {
      logger?.info?.(`Войс: перемещение в ${next.channelName || 'канал'}`);
    }
  } else if (next && next.event === 'leave') {
    logger?.info?.('Войс: вышел из канала');
    if (config.stream.autoStop && config.stream.startedAt) {
      stopTimer({ auto: true });
    }
    autoStartArmed = true;
  } else if (!next) {
    // Bot disconnected or auto-detect disabled. Do not stop a manual timer.
    autoStartArmed = true;
  }

  presenceManager?.update({ force: true }).catch(() => undefined);
  broadcast();
}

function handleRpcUser(user) {
  rpcUser = user;
  if (!user?.id) {
    broadcast();
    return;
  }

  if (!config.discord.userId) {
    config.discord.userId = user.id;
    config = configStore.save(config);
    logger?.info?.('ID пользователя определён через Discord RPC');
    voiceTracker
      ?.setIdentity({ userId: user.id })
      .catch((error) => logger?.warn?.(`Не удалось передать user ID боту: ${error.message}`));
  } else if (config.discord.userId !== user.id) {
    logger?.warn?.('Текущий Discord-аккаунт не совпадает с user ID в настройках');
  }
  broadcast();
}

function handleGuildSuggestion(guild) {
  if (!guild?.id || config.discord.guildId) return;
  config.discord.guildId = guild.id;
  config = configStore.save(config);
  logger?.info?.(`Сервер для авто-войса выбран: ${guild.name}`);
  voiceTracker
    ?.setIdentity({ guildId: guild.id })
    .catch((error) => logger?.warn?.(`Не удалось передать guild ID боту: ${error.message}`));
  broadcast();
}

function wireServices() {
  presenceManager.on('status', () => broadcast());
  presenceManager.on('update', () => broadcast());
  presenceManager.on('user', handleRpcUser);

  voiceTracker.on('status', () => broadcast());
  voiceTracker.on('voice', handleVoice);
  voiceTracker.on('guilds', (guilds) => {
    botGuilds = Array.isArray(guilds) ? guilds : [];
    broadcast();
  });
  voiceTracker.on('suggestGuild', handleGuildSuggestion);
}

function initServices() {
  presenceManager = new PresenceManager({
    getConfig: () => config,
    getVoice: () => voice,
    logger,
  });
  voiceTracker = new VoiceTracker({
    getConfig: () => config,
    logger,
  });
  wireServices();

  presenceManager.connect().catch((error) => {
    logger?.error?.(`Discord RPC: ${safeError(error, [config.discord.botToken])}`);
  });
  voiceTracker.start().catch((error) => {
    logger?.error?.(`Бот: ${safeError(error, [config.discord.botToken])}`);
  });

  timerInterval = setInterval(() => {
    if (config?.stream?.startedAt) {
      presenceManager?.update({ force: false }).catch(() => undefined);
    }
    broadcast();
  }, 30_000);
  timerInterval.unref?.();
}

function showMessageBox(options) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return dialog.showMessageBox(mainWindow, options);
  }
  return dialog.showMessageBox(options);
}

async function uploadGif(filePath) {
  const target = filePath || SAMPLE_GIF_PATH;
  if (!fs.existsSync(target)) {
    return { ok: false, error: 'Файл не найден.' };
  }
  const name = path.basename(target);
  const isSample = target === SAMPLE_GIF_PATH;
  const { response } = await showMessageBox({
    type: 'question',
    buttons: ['Загрузить', 'Отмена'],
    defaultId: 0,
    cancelId: 1,
    title: 'Публичная загрузка GIF',
    message: isSample ? 'Загрузить пример анимации на catbox.moe?' : `Загрузить «${name}» на catbox.moe?`,
    detail:
      'Файл станет публично доступен по прямой ссылке. Discord не умеет брать GIF из локального файла, поэтому нужен https-URL. Не загружай личные файлы.',
  });
  if (response !== 0) return { ok: false, cancelled: true };

  try {
    const result = await catbox.uploadFileToCatbox(target);
    logger?.info?.(`GIF загружен: ${result.url}`);
    return { ok: true, url: result.url, name };
  } catch (error) {
    const message = safeError(error, [config?.discord?.botToken]);
    logger?.warn?.(`Не удалось загрузить GIF: ${message}`);
    return { ok: false, error: message };
  }
}

function registerIpc() {
  const trusted = (event) =>
    mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trusted(event)) throw new Error('Forbidden');
      return fn(...args);
    });
  };

  handle('state:get', () => sendStateNow());

  handle('config:save', (patch) => saveConfigPatch(patch));

  handle('app:preview', (patch) => {
    try {
      const merged = deepMerge(config, patch && typeof patch === 'object' ? patch : {});
      const candidate = normaliseConfig(merged);
      const presence = buildPresence(candidate, { voice, now: Date.now() });
      return {
        ok: true,
        preview: presence.preview,
        validation: validateConfig(candidate),
      };
    } catch (error) {
      logger?.warn?.(`Не удалось собрать превью: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  handle('config:reset', async () => {
    const { response } = await showMessageBox({
      type: 'warning',
      buttons: ['Сбросить всё', 'Отмена'],
      defaultId: 1,
      cancelId: 1,
      title: 'Сбросить настройки?',
      message: 'Удалить все настройки, токены и пресеты?',
      detail: 'Это действие нельзя отменить. Придётся заново указать Application ID и токен бота.',
    });
    if (response !== 0) return { ok: false, cancelled: true };
    config = configStore.save(clone(DEFAULT_CONFIG));
    autoStartArmed = true;
    voice = null;
    botGuilds = [];
    rpcUser = null;
    await presenceManager?.restart();
    await voiceTracker?.restart();
    logger?.warn?.('Настройки сброшены');
    showWindow('help');
    return { ok: true, snapshot: sendStateNow() };
  });

  handle('app:apply', async () => {
    await presenceManager?.update({ force: true });
    await voiceTracker?.refresh();
    return { ok: true, snapshot: sendStateNow() };
  });

  handle('app:start-timer', () => startTimer());
  handle('app:stop-timer', () => stopTimer());
  handle('app:reset-timer', () => resetTimer());
  handle('app:select-preset', (presetId) => selectPreset(presetId));
  handle('app:select-platform', (platformId) => selectPlatform(platformId));
  handle('app:refresh-voice', async () => {
    await voiceTracker?.refresh();
    return { ok: true, snapshot: sendStateNow() };
  });
  handle('app:reconnect-rpc', async () => {
    await presenceManager?.restart();
    return { ok: true, snapshot: sendStateNow() };
  });
  handle('app:reconnect-bot', async () => {
    await voiceTracker?.restart();
    return { ok: true, snapshot: sendStateNow() };
  });
  handle('app:clear-activity', async () => {
    await presenceManager?.clearActivity();
    return { ok: true, snapshot: sendStateNow() };
  });
  handle('app:use-rpc-user', () => {
    if (!rpcUser?.id) return { ok: false, error: 'RPC ещё не подключён.' };
    const result = saveConfigPatch({ discord: { userId: rpcUser.id } });
    if (result.ok) logger?.info?.(`User ID обновлён: ${rpcUser.id}`);
    return result;
  });
  handle('app:set-guild', (guildId) => saveConfigPatch({ discord: { guildId: String(guildId || '') } }));
  handle('app:open-url', (url) => ({ ok: openExternalSafe(url) }));
  handle('app:open-dev-portal', () => ({
    ok: openExternalSafe('https://discord.com/developers/applications'),
  }));
  handle('app:open-invite', () => ({ ok: openExternalSafe(buildInviteUrl()) }));
  handle('app:copy-invite', () => {
    const url = buildInviteUrl();
    if (!url) return { ok: false, error: 'Сначала укажи Application ID или токен бота.' };
    clipboard.writeText(url);
    return { ok: true };
  });
  handle('app:copy-text', (text) => {
    clipboard.writeText(String(text ?? ''));
    return { ok: true };
  });
  handle('app:open-config-folder', async () => {
    await shell.openPath(configStore.directory);
    return { ok: true };
  });
  handle('app:show-logs', () => {
    if (logger?.filePath) shell.showItemInFolder(logger.filePath);
    return { ok: true };
  });
  handle('app:clear-logs', () => {
    logger?.clear();
    return { ok: true, snapshot: sendStateNow() };
  });
  handle('app:pick-gif', async () => {
    const options = {
      title: 'Выбери GIF или картинку',
      properties: ['openFile'],
      filters: [
        { name: 'Изображения', extensions: ['gif', 'webp', 'png', 'jpg', 'jpeg', 'avif'] },
      ],
    };
    const result =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return { ok: false, cancelled: true };
    const filePath = result.filePaths[0];
    return {
      ok: true,
      path: filePath,
      name: path.basename(filePath),
      size: fs.statSync(filePath).size,
    };
  });
  handle('app:upload-gif', (filePath) => uploadGif(typeof filePath === 'string' ? filePath : ''));
  handle('app:upload-sample-gif', () => uploadGif(SAMPLE_GIF_PATH));
  handle('app:test-image-url', (url) => catbox.validateImageUrl(url));
  handle('app:show-window', (tab) => {
    showWindow(typeof tab === 'string' ? tab : '');
    return { ok: true };
  });
  handle('app:hide-window', () => {
    hideWindow();
    return { ok: true };
  });
  handle('app:quit', () => {
    app.quit();
    return { ok: true };
  });
  handle('app:set-flag', (flagPath, value) => {
    if (!Array.isArray(flagPath) || flagPath.length === 0) return { ok: false, error: 'Некорректный путь.' };
    let patch = value;
    for (let index = flagPath.length - 1; index >= 0; index -= 1) {
      patch = { [flagPath[index]]: patch };
    }
    return saveConfigPatch(patch);
  });
  handle('app:show-tab', (tab) => {
    showWindow(typeof tab === 'string' ? tab : '');
    return { ok: true };
  });
}

async function cleanup() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (broadcastTimer) {
    clearTimeout(broadcastTimer);
    broadcastTimer = null;
  }
  trayController?.destroy();
  trayController = null;
  try {
    await presenceManager?.destroy();
  } catch {
    // ignore
  }
  try {
    await voiceTracker?.destroy();
  } catch {
    // ignore
  }
}

async function init() {
  app.setAppUserModelId('ru.aruku.taro-rpc');

  const userDataDir = app.getPath('userData');
  logger = new Logger({
    directory: userDataDir,
    getSecrets: () => [config?.discord?.botToken || ''],
  });

  configStore = createConfigStore({
    userDataDir,
    safeStorage,
    logger,
  });
  config = configStore.load();

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  logger.info(
    `Запуск Taro RPC v${app.getVersion()} (${process.platform}/${process.arch}, packaged=${app.isPackaged})`,
  );
  logger.info(`Конфиг: ${configStore.filePath}`);
  if (!config.discord.applicationId) {
    logger.warn('Application ID не указан — открой настройки и заполни Discord-раздел');
  }
  if (config.discord.botToken && !safeStorage.isEncryptionAvailable()) {
    logger.warn('Системное шифрование недоступно — токен бота хранится без шифрования');
  }

  initServices();
  applyLoginItem();
  registerIpc();

  createWindow();
  trayController = new TrayController({
    iconPath: ICON_PATH,
    frames: getTrayFrames(),
    getSnapshot: () => {
      try {
        return buildSnapshot();
      } catch (error) {
        logger?.error?.(`Не удалось получить состояние: ${error.message}`);
        return lastSnapshot;
      }
    },
    logger,
    actions: {
      showWindow: (tab) => showWindow(typeof tab === 'string' ? tab : ''),
      openSettings: (tab) => showWindow(typeof tab === 'string' ? tab : 'activity'),
      openCustomActivity: () => {
        if (config.activity.presetId !== 'custom') {
          persistAndApply({ ...config, activity: { ...config.activity, presetId: 'custom' } }, { log: false });
        }
        focusField('activityTitle');
      },
      quit: () => app.quit(),
      selectPreset: (presetId) => selectPreset(presetId),
      selectPlatform: (platformId) => selectPlatform(platformId),
      openVoice: () => openExternalSafe(lastSnapshot?.preview?.voiceUrl || ''),
      copyVoice: () => {
        const url = lastSnapshot?.preview?.voiceUrl || '';
        if (url) clipboard.writeText(url);
      },
      refreshVoice: () => voiceTracker?.refresh(),
      setGuild: (guildId) => saveConfigPatch({ discord: { guildId: String(guildId || '') } }),
      setAutoVoice: (value) => saveConfigPatch({ discord: { autoVoice: Boolean(value) } }),
      startTimer: () => startTimer(),
      stopTimer: () => stopTimer(),
      resetTimer: () => resetTimer(),
      setAutoStart: (value) => saveConfigPatch({ stream: { autoStart: Boolean(value) } }),
      setAutoStop: (value) => saveConfigPatch({ stream: { autoStop: Boolean(value) } }),
      setNativeTimer: (value) => saveConfigPatch({ stream: { showNativeTimer: Boolean(value) } }),
      setLaunchAtLogin: (value) => saveConfigPatch({ app: { launchAtLogin: Boolean(value) } }),
      setAnimateTray: (value) => saveConfigPatch({ app: { animateTray: Boolean(value) } }),
      reconnectRpc: () => presenceManager?.restart(),
      clearActivity: () => presenceManager?.clearActivity(),
      openDevPortal: () => openExternalSafe('https://discord.com/developers/applications'),
      openConfigFolder: () => shell.openPath(configStore.directory),
    },
  });
  trayController.create();

  sendStateNow();
  logger.info('Taro RPC готов');
}

app.on('activate', () => {
  showWindow();
});

app.on('window-all-closed', () => {
  // Tray application: keep running.
});

app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  isQuitting = true;
  saveWindowBounds();
  logger?.info?.('Выход…');
  const finish = () => app.exit(0);
  Promise.race([cleanup(), new Promise((resolve) => setTimeout(resolve, 2500))]).finally(finish);
});

process.on('uncaughtException', (error) => {
  logger?.error?.(`Необработанная ошибка: ${redactSecrets(error?.stack || error?.message || error)}`);
});

process.on('unhandledRejection', (reason) => {
  logger?.error?.(`Необработанный Promise: ${redactSecrets(reason?.stack || reason?.message || reason)}`);
});

app.on('render-process-gone', (_event, _webContents, details) => {
  logger?.error?.(`Renderer упал: ${details.reason}`);
});

app.on('child-process-gone', (_event, details) => {
  logger?.warn?.(`Дочерний процесс завершился: ${details.type} / ${details.reason}`);
});
