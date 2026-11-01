'use strict';

const { EventEmitter } = require('node:events');
const {
  ActivityType,
  Client,
  GatewayIntentBits,
  PermissionsBitField,
} = require('discord.js');
const { makeChannelUrl, safeError, isSnowflake } = require('./util');

const POLL_INTERVAL_MS = 30_000;

class VoiceTracker extends EventEmitter {
  constructor({ getConfig, logger }) {
    super();
    this.getConfig = getConfig;
    this.logger = logger || console;

    this.client = null;
    this.pollTimer = null;
    this.disposed = false;
    this.guildId = '';
    this.userId = '';
    this.voice = null;
    this.status = {
      state: 'off',
      message: 'Авто-войс выключен',
      online: false,
      guilds: [],
      guildId: '',
      username: '',
      error: null,
      permissionWarning: '',
    };
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
  }

  getStatus() {
    return {
      ...this.status,
      guilds: this.status.guilds.map((guild) => ({ ...guild })),
      voice: this.voice ? { ...this.voice } : null,
    };
  }

  async start() {
    const config = this.getConfig();
    await this.stop({ silent: true });

    if (!config.discord.autoVoice) {
      this.voice = null;
      this.setStatus({
        state: 'off',
        message: 'Авто-войс выключен — используется ручной режим',
        online: false,
        error: null,
        permissionWarning: '',
      });
      this.emit('voice', null);
      return;
    }

    if (!config.discord.botToken) {
      this.voice = null;
      this.setStatus({
        state: 'missing_token',
        message: 'Нужен токен бота для авто-войса',
        online: false,
        error: null,
      });
      this.emit('voice', null);
      return;
    }

    this.setStatus({
      state: 'connecting',
      message: 'Подключаю бота к Discord…',
      online: false,
      error: null,
      permissionWarning: '',
    });

    this.guildId = config.discord.guildId || '';
    this.userId = config.discord.userId || '';

    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
      allowedMentions: { parse: [] },
    });
    this.client = client;

    client.once('ready', () => {
      if (this.client !== client) return;
      this.handleReady().catch((error) => {
        this.logger.error?.(`Бот: ${safeError(error, [config.discord.botToken])}`);
      });
    });

    client.on('voiceStateUpdate', (oldState, newState) => {
      if (this.client !== client) return;
      this.handleVoiceStateUpdate(oldState, newState).catch((error) => {
        this.logger.warn?.(`Бот: не удалось обновить войс: ${safeError(error, [config.discord.botToken])}`);
      });
    });

    client.on('error', (error) => {
      if (this.client !== client) return;
      const message = safeError(error, [config.discord.botToken]);
      this.setStatus({ state: 'error', message: `Ошибка бота: ${message}`, online: false, error: message });
      this.logger.error?.(`Бот: ${message}`);
    });

    client.on('shardDisconnect', () => {
      if (this.client !== client) return;
      this.setStatus({ state: 'connecting', message: 'Бот переподключается…', online: false });
    });

    client.on('shardReady', () => {
      if (this.client !== client) return;
      this.setStatus({ state: 'online', message: 'Бот на связи', online: true, error: null });
      this.refresh().catch(() => undefined);
    });

    try {
      await client.login(config.discord.botToken);
    } catch (error) {
      if (this.client !== client) return;
      const message = safeError(error, [config.discord.botToken]);
      this.setStatus({
        state: 'error',
        message: `Не удалось подключить бота: ${message}`,
        online: false,
        error: message,
      });
      this.logger.error?.(`Бот: ${message}`);
      this.voice = null;
      this.emit('voice', null);
    }
  }

  async handleReady() {
    const config = this.getConfig();
    const client = this.client;
    if (!client?.user) return;

    const guilds = client.guilds.cache.map((guild) => ({
      id: guild.id,
      name: guild.name,
      memberCount: guild.memberCount || 0,
    }));
    this.status.guilds = guilds;

    if (config.discord.botInvisible) {
      client.user.setPresence({ status: 'invisible', activities: [] });
    } else {
      client.user.setPresence({
        status: 'online',
        activities: [{ name: 'aruku / voice', type: ActivityType.Watching }],
      });
    }

    this.setStatus({
      state: 'online',
      message: 'Бот на связи',
      online: true,
      username: client.user.username || '',
      guilds,
      error: null,
    });

    this.emit('guilds', guilds);

    if (!this.guildId && guilds.length === 1) {
      this.guildId = guilds[0].id;
      this.setStatus({ guildId: this.guildId });
      this.emit('suggestGuild', guilds[0]);
    }

    if (!this.guildId) {
      this.setStatus({
        state: 'online',
        message: guilds.length > 1 ? 'Выбери сервер для отслеживания' : 'Бот не добавлен ни на один сервер',
        online: true,
        guilds,
      });
      this.voice = null;
      this.emit('voice', null);
      return;
    }

    const guild = await this.fetchGuild(this.guildId);
    if (!guild) {
      this.setStatus({
        state: 'error',
        message: 'Бот не найден на выбранном сервере — пригласи его',
        online: true,
        guildId: this.guildId,
        error: 'Бот не на сервере',
      });
      this.voice = null;
      this.emit('voice', null);
      return;
    }

    let member = guild.members.me;
    if (!member) {
      try {
        member = await guild.members.fetchMe();
      } catch {
        member = null;
      }
    }
    if (member && !member.permissions.has(PermissionsBitField.Flags.ViewChannel)) {
      this.setStatus({
        state: 'online',
        message: 'У бота нет права «Просматривать каналы»',
        online: true,
        guildId: this.guildId,
        permissionWarning: 'Нет права View Channel',
      });
    } else {
      this.setStatus({
        state: 'online',
        message: guilds.length > 1 ? 'Бот на связи — сервер выбран' : 'Бот на связи',
        online: true,
        guildId: this.guildId,
        permissionWarning: '',
      });
    }

    this.startPolling();
    await this.refresh({ initial: true });
  }

  async fetchGuild(guildId) {
    const client = this.client;
    if (!client?.isReady()) return null;
    const cached = client.guilds.cache.get(guildId);
    if (cached) return cached;
    try {
      return await client.guilds.fetch(guildId);
    } catch {
      return null;
    }
  }

  async resolveChannel(guild, channelId) {
    if (!channelId) return null;
    const cached = guild.channels.cache.get(channelId);
    if (cached) return cached;
    try {
      return await guild.channels.fetch(channelId);
    } catch {
      return null;
    }
  }

  makeVoice(guild, channel) {
    return {
      online: true,
      inVoice: true,
      guildId: guild.id,
      guildName: guild.name,
      channelId: channel.id,
      channelName: channel.name,
      url: makeChannelUrl(guild.id, channel.id),
      at: Date.now(),
    };
  }

  makeNotInVoice(guild, event = 'poll') {
    return {
      online: true,
      inVoice: false,
      guildId: guild?.id || this.guildId,
      guildName: guild?.name || '',
      channelId: '',
      channelName: '',
      url: '',
      event,
      at: Date.now(),
    };
  }

  async emitVoice(voice) {
    this.voice = voice;
    this.emit('voice', voice);
  }

  async handleVoiceStateUpdate(oldState, newState) {
    const guildId = newState.guild?.id || oldState.guild?.id || '';
    if (this.guildId && guildId !== this.guildId) return;
    if (!this.userId || newState.id !== this.userId) return;

    const guild = newState.guild || oldState.guild;
    const moved =
      Boolean(oldState.channelId) &&
      Boolean(newState.channelId) &&
      oldState.channelId !== newState.channelId;

    if (!newState.channelId) {
      await this.emitVoice(this.makeNotInVoice(guild, 'leave'));
      return;
    }

    const channel = newState.channel || (await this.resolveChannel(guild, newState.channelId));
    if (!channel) {
      await this.refresh();
      return;
    }

    const voice = this.makeVoice(guild, channel);
    voice.event = moved ? 'move' : 'join';
    await this.emitVoice(voice);
  }

  async refresh({ initial = false } = {}) {
    const client = this.client;
    if (!client?.isReady() || !this.guildId || !this.userId) return;

    const guild = await this.fetchGuild(this.guildId);
    if (!guild) return;

    let state = guild.voiceStates.cache.get(this.userId) || null;
    if (!state && typeof guild.voiceStates.fetch === 'function') {
      try {
        state = await guild.voiceStates.fetch(this.userId);
      } catch {
        state = null;
      }
    }

    if (!state?.channelId) {
      await this.emitVoice(this.makeNotInVoice(guild, initial ? 'initial' : 'poll'));
      return;
    }

    const channel = state.channel || (await this.resolveChannel(guild, state.channelId));
    if (!channel) {
      await this.emitVoice(this.makeNotInVoice(guild, 'poll'));
      return;
    }

    const voice = this.makeVoice(guild, channel);
    voice.event = initial ? 'initial' : 'poll';
    await this.emitVoice(voice);
  }

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      this.refresh().catch(() => undefined);
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async setIdentity({ guildId, userId } = {}) {
    let changed = false;
    if (guildId !== undefined && guildId !== this.guildId) {
      this.guildId = String(guildId || '');
      changed = true;
    }
    if (userId !== undefined && userId !== this.userId) {
      this.userId = String(userId || '');
      changed = true;
    }
    if (changed) {
      this.setStatus({ guildId: this.guildId });
      if (this.status.online) {
        this.startPolling();
        await this.refresh({ initial: true });
      }
    }
  }

  async stop({ silent = false } = {}) {
    this.stopPolling();
    const client = this.client;
    this.client = null;
    this.voice = null;
    if (client) {
      try {
        client.removeAllListeners?.();
        client.destroy();
      } catch {
        // ignore
      }
    }
    this.setStatus({
      state: 'off',
      message: silent ? 'Бот перезапускается…' : 'Бот отключён',
      online: false,
      guilds: [],
      guildId: this.guildId,
      username: '',
      error: null,
      permissionWarning: '',
    });
    this.emit('voice', null);
  }

  async restart() {
    await this.stop({ silent: true });
    await this.start();
  }

  async destroy() {
    this.disposed = true;
    await this.stop({ silent: true });
  }
}

module.exports = {
  VoiceTracker,
};
