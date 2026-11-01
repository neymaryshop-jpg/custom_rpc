'use strict';

const { Menu, Tray, nativeImage } = require('electron');
const { CATEGORIES } = require('./constants');
const { truncate } = require('./util');

function safeLabel(value, maxLength = 60) {
  return truncate(String(value ?? '').replace(/\s+/g, ' ').trim(), maxLength);
}

class TrayController {
  constructor({ iconPath, frames = [], actions, getSnapshot, logger }) {
    this.iconPath = iconPath;
    this.framePaths = frames;
    this.actions = actions;
    this.getSnapshot = getSnapshot;
    this.logger = logger || console;
    this.tray = null;
    this.snapshot = null;
    this.frames = [];
    this.animTimer = null;
    this.animIndex = 0;
    this.animationEnabled = null;
    this.destroyed = false;
  }

  loadFrames() {
    const loaded = [];
    for (const framePath of this.framePaths) {
      try {
        const image = nativeImage.createFromPath(framePath);
        if (!image.isEmpty()) loaded.push(image);
      } catch {
        // ignore a broken frame
      }
    }
    if (loaded.length > 0) return loaded;
    const fallback = nativeImage.createFromPath(this.iconPath);
    return fallback.isEmpty() ? [] : [fallback];
  }

  create() {
    this.frames = this.loadFrames();
    const initial = this.frames[0] || nativeImage.createFromPath(this.iconPath);
    this.tray = new Tray(initial);
    this.tray.setToolTip('Taro RPC');
    this.tray.on('click', () => this.call(this.actions.showWindow));
    this.tray.on('double-click', () => this.call(this.actions.showWindow));
    this.tray.on('right-click', () => {
      if (this.destroyed) return;
      try {
        this.tray.popUpContextMenu(this.buildMenu());
      } catch (error) {
        this.logger.error?.(`Не удалось открыть меню трея: ${error.message}`);
      }
    });
    this.update(this.getSnapshot());
    return this.tray;
  }

  call(action, ...args) {
    try {
      Promise.resolve(action?.(...args)).catch((error) => {
        this.logger.error?.(`Действие из трея: ${error.message}`);
      });
    } catch (error) {
      this.logger.error?.(`Действие из трея: ${error.message}`);
    }
  }

  update(snapshot) {
    if (!this.tray || this.destroyed) return;
    if (snapshot) this.snapshot = snapshot;
    if (!this.snapshot) return;

    const { preview, config, timer } = this.snapshot;
    const lines = [
      `${config?.app?.displayName || 'Taro RPC'} • ${preview?.typeLabel || ''}`.trim(),
      `${preview?.title || '—'}`,
      `${preview?.serverName || ''} / ${preview?.channelName || ''}`.replace(/^ \/ /, ''),
      timer?.running ? `⏱ ${timer?.elapsed || '—'}` : 'Таймер не запущен',
    ].filter(Boolean);
    this.tray.setToolTip(safeLabel(lines.join('\n'), 120));

    const animate = Boolean(config?.app?.animateTray);
    if (animate !== this.animationEnabled) {
      this.animationEnabled = animate;
      this.startAnimation(animate);
    }
  }

  startAnimation(enabled) {
    if (this.animTimer) {
      clearInterval(this.animTimer);
      this.animTimer = null;
    }
    if (!this.tray || this.destroyed) return;
    if (!enabled || this.frames.length < 2) {
      if (this.frames[0]) this.tray.setImage(this.frames[0]);
      return;
    }
    this.animIndex = 0;
    this.tray.setImage(this.frames[0]);
    this.animTimer = setInterval(() => {
      if (!this.tray || this.destroyed) return;
      this.animIndex = (this.animIndex + 1) % this.frames.length;
      this.tray.setImage(this.frames[this.animIndex]);
    }, 190);
    this.animTimer.unref?.();
  }

  submenu(label, items) {
    const enabledItems = items.filter(Boolean);
    return {
      label,
      submenu: enabledItems.length > 0 ? enabledItems : [{ label: 'Пусто', enabled: false }],
    };
  }

  checkbox(label, checked, action) {
    return {
      label,
      type: 'checkbox',
      checked: Boolean(checked),
      click: (item) => this.call(action, Boolean(item.checked)),
    };
  }

  buildMenu() {
    let snapshot = this.snapshot;
    try {
      snapshot = this.getSnapshot() || snapshot;
    } catch {
      // use the last known snapshot
    }
    const { preview, config, status, timer } = snapshot || {};
    const rpc = status?.rpc || {};
    const bot = status?.bot || {};
    const voice = status?.voice || {};
    const isRunning = Boolean(timer?.running);
    const voiceUrl = preview?.voiceUrl || '';
    const appIdMissing = !config?.discord?.applicationId;

    const activityItems = [];
    for (const [categoryId, categoryLabel] of Object.entries(CATEGORIES)) {
      const presets = (config?.presets || []).filter((preset) => preset.category === categoryId);
      if (presets.length === 0) continue;
      activityItems.push({
        label: categoryLabel,
        submenu: presets.map((preset) => ({
          label: safeLabel(preset.title, 50),
          type: 'radio',
          checked: config.activity.presetId === preset.id,
          click: () => this.call(this.actions.selectPreset, preset.id),
        })),
      });
    }
    activityItems.push({ type: 'separator' });
    activityItems.push({
      label: '✏️ Своё…',
      type: 'radio',
      checked: config?.activity?.presetId === 'custom',
      click: () => this.call(this.actions.openCustomActivity),
    });

    const platformItems = (config?.platforms || []).map((platform) => ({
      label: safeLabel(platform.name, 40),
      type: 'radio',
      checked: config.stream.platformId === platform.id,
      click: () => this.call(this.actions.selectPlatform, platform.id),
    }));
    platformItems.push({ type: 'separator' });
    platformItems.push({
      label: 'Настроить ссылку…',
      click: () => this.call(this.actions.openSettings, 'platform'),
    });

    const guildItems = [];
    if ((bot.guilds || []).length > 0) {
      guildItems.push({
        label: 'Не отслеживать',
        type: 'radio',
        checked: !config?.discord?.guildId,
        click: () => this.call(this.actions.setGuild, ''),
      });
      guildItems.push({ type: 'separator' });
      for (const guild of bot.guilds) {
        guildItems.push({
          label: safeLabel(guild.name, 45),
          type: 'radio',
          checked: config?.discord?.guildId === guild.id,
          click: () => this.call(this.actions.setGuild, guild.id),
        });
      }
    }

    const voiceItems = [
      this.checkbox('Авто-детект войса', config?.discord?.autoVoice, this.actions.setAutoVoice),
      {
        label: `Бот: ${safeLabel(bot.message || 'выключен', 45)}`,
        enabled: false,
      },
      {
        label: 'Обновить сейчас',
        enabled: Boolean(bot.online),
        click: () => this.call(this.actions.refreshVoice),
      },
      { type: 'separator' },
      {
        label: '🎧 Открыть войс',
        enabled: Boolean(voiceUrl),
        click: () => this.call(this.actions.openVoice),
      },
      {
        label: 'Скопировать ссылку на войс',
        enabled: Boolean(voiceUrl),
        click: () => this.call(this.actions.copyVoice),
      },
    ];
    if (guildItems.length > 0) voiceItems.push({ type: 'separator' }, this.submenu('Сервер для отслеживания', guildItems));
    voiceItems.push({ type: 'separator' }, {
      label: 'Настроить войс…',
      click: () => this.call(this.actions.openSettings, 'voice'),
    });

    const timerItems = [
      {
        label: '▶️ Начать стрим',
        enabled: !isRunning,
        click: () => this.call(this.actions.startTimer),
      },
      {
        label: '⏹ Остановить',
        enabled: isRunning,
        click: () => this.call(this.actions.stopTimer),
      },
      {
        label: 'Сбросить',
        enabled: isRunning || Boolean(config?.stream?.lastSessionMs),
        click: () => this.call(this.actions.resetTimer),
      },
      { type: 'separator' },
      this.checkbox('Авто-старт при входе в войс', config?.stream?.autoStart, this.actions.setAutoStart),
      this.checkbox('Авто-стоп при выходе', config?.stream?.autoStop, this.actions.setAutoStop),
      this.checkbox('Таймер Discord (HH:MM:SS)', config?.stream?.showNativeTimer, this.actions.setNativeTimer),
    ];

    const rpcItems = [
      {
        label: rpc.connected ? `Подключён${rpc.user?.username ? `: ${rpc.user.username}` : ''}` : safeLabel(rpc.message || 'Не подключён', 50),
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Переподключить RPC',
        click: () => this.call(this.actions.reconnectRpc),
      },
      {
        label: 'Очистить активность',
        enabled: Boolean(rpc.connected),
        click: () => this.call(this.actions.clearActivity),
      },
      {
        label: 'Discord Developer Portal',
        click: () => this.call(this.actions.openDevPortal),
      },
    ];

    const appItems = [
      {
        label: 'Настройки…',
        accelerator: 'CmdOrCtrl+,',
        click: () => this.call(this.actions.showWindow),
      },
      this.checkbox('Открывать при запуске', config?.app?.launchAtLogin, this.actions.setLaunchAtLogin),
      this.checkbox('Анимировать иконку в трее', config?.app?.animateTray, this.actions.setAnimateTray),
      {
        label: 'Открыть папку настроек',
        click: () => this.call(this.actions.openConfigFolder),
      },
      { type: 'separator' },
      {
        label: 'Выход',
        click: () => this.call(this.actions.quit),
      },
    ];

    const template = [];

    if (appIdMissing) {
      template.push({
        label: '⚠️ Настроить Discord…',
        click: () => this.call(this.actions.showWindow, 'discord'),
      });
      template.push({ type: 'separator' });
    }

    template.push(
      {
        label: `${config?.app?.displayName || 'Taro RPC'} — ${preview?.typeLabel || ''}`.trim(),
        enabled: false,
      },
      {
        label: `Сейчас: ${safeLabel(preview?.title || '—', 55)}`,
        click: () => this.call(this.actions.openSettings, 'activity'),
      },
      {
        label: `Войс: ${safeLabel([preview?.serverName, preview?.channelName].filter(Boolean).join(' / ') || '—', 50)}${preview?.voiceSource === 'auto' ? ' (авто)' : ''}`,
        enabled: Boolean(voiceUrl),
        click: () => this.call(this.actions.openVoice),
      },
      {
        label: isRunning ? `⏱ ${timer?.elapsed || '—'}` : 'Таймер не запущен',
        enabled: false,
      },
      { type: 'separator' },
      this.submenu('🎬 Что показываю', activityItems),
      this.submenu('📺 Площадка (P)', platformItems),
      this.submenu('🎧 Войс', voiceItems),
      this.submenu('⏱ Таймер', timerItems),
      this.submenu('🔌 Discord RPC', rpcItems),
      { type: 'separator' },
      this.submenu('⚙️ Приложение', appItems),
      {
        label: 'Выход',
        click: () => this.call(this.actions.quit),
      },
    );

    return Menu.buildFromTemplate(template);
  }

  destroy() {
    this.destroyed = true;
    if (this.animTimer) {
      clearInterval(this.animTimer);
      this.animTimer = null;
    }
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = {
  TrayController,
};
