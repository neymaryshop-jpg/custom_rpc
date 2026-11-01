'use strict';

const { EventEmitter } = require('node:events');
const { buildPresence } = require('./presenceBuilder');
const { safeError } = require('./util');

const MIN_UPDATE_INTERVAL_MS = 12_000;
const RECONNECT_DELAY_MS = 20_000;

function loadRpcClient() {
  const module = require('@xhayper/discord-rpc');
  return module.Client || module.default || module;
}

class PresenceManager extends EventEmitter {
  constructor({ getConfig, getVoice, logger }) {
    super();
    this.getConfig = getConfig;
    this.getVoice = getVoice;
    this.logger = logger || console;

    this.client = null;
    this.status = {
      state: 'idle',
      message: 'Не подключено',
      user: null,
      lastUpdateAt: null,
      lastError: null,
    };
    this.reconnectTimer = null;
    this.trailingTimer = null;
    this.lastSentAt = 0;
    this.lastSignature = '';
    this.pendingUpdate = false;
    this.disposed = false;
    this.lastNonce = 0;
  }

  getConfigSafe() {
    return this.getConfig();
  }

  setStatus(state, message, extra = {}) {
    this.status = {
      ...this.status,
      state,
      message,
      ...extra,
    };
    this.emit('status', this.getStatus());
  }

  getStatus() {
    const config = this.getConfigSafe();
    return {
      ...this.status,
      applicationId: config?.discord?.applicationId || '',
      user: this.status.user ? { ...this.status.user } : null,
      connected: Boolean(this.client?.isConnected && this.status.state === 'connected'),
    };
  }

  async connect() {
    if (this.disposed) return;
    const config = this.getConfigSafe();
    const applicationId = String(config.discord.applicationId || '').trim();

    if (!applicationId) {
      this.setStatus('no_app_id', 'Укажи Discord Application ID');
      return;
    }

    if (!/^\d{17,20}$/.test(applicationId)) {
      this.setStatus('error', 'Application ID должен состоять из 17–20 цифр');
      return;
    }

    if (this.client?.isConnected) return;
    if (this.client) this.destroyClient();
    this.clearReconnectTimer();
    this.setStatus('connecting', 'Подключаюсь к Discord…');

    const Client = loadRpcClient();
    const client = new Client({ clientId: applicationId });
    this.client = client;

    const handleConnected = () => {
      if (this.client !== client) return;
      const user = client.user;
      this.status.user = user ? { id: user.id, username: user.username, globalName: user.globalName || '' } : null;
      this.lastSignature = '';
      this.setStatus('connected', 'Discord подключён', {
        lastError: null,
        user: this.status.user,
      });
      this.logger.info?.('Discord RPC подключён');
      this.emit('user', this.status.user);
      // The library emits "connected" before it flips its internal isConnected
      // flag, so defer the first SET_ACTIVITY by a tick.
      setTimeout(() => {
        if (this.client !== client) return;
        this.update({ force: true }).catch(() => undefined);
      }, 120).unref?.();
    };

    client.on('connected', handleConnected);
    client.on('ready', () => {
      if (this.client === client && this.status.state !== 'connected') handleConnected();
    });
    client.on('disconnected', () => {
      if (this.client !== client) return;
      this.setStatus('disconnected', 'Discord закрыт или соединение потеряно');
      this.logger.warn?.('Discord RPC соединение потеряно');
      this.scheduleReconnect();
    });
    client.on('ERROR', (error) => {
      if (this.client !== client) return;
      const message = safeError(error, [config.discord.botToken]);
      this.setStatus('error', `Ошибка Discord RPC: ${message}`);
      this.logger.error?.(`Discord RPC: ${message}`);
    });
    client.on('error', (error) => {
      if (this.client !== client) return;
      const message = safeError(error, [config.discord.botToken]);
      this.setStatus('error', `Ошибка Discord RPC: ${message}`);
      this.logger.error?.(`Discord RPC: ${message}`);
    });

    try {
      await client.login();
      if (this.client !== client) return;
      if (this.status.state !== 'connected') handleConnected();
      this.update({ force: true }).catch(() => undefined);
    } catch (error) {
      if (this.client !== client) return;
      const message = safeError(error, [config.discord.botToken]);
      this.setStatus('disconnected', 'Discord не запущен или RPC недоступен', { lastError: message });
      this.logger.warn?.(`Не удалось подключиться к Discord RPC: ${message}`);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      const config = this.getConfigSafe();
      if (!config?.discord?.applicationId) return;
      this.connect().catch(() => undefined);
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref?.();
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async update({ force = false } = {}) {
    if (this.disposed) return false;
    const config = this.getConfigSafe();
    const client = this.client;

    if (!client || !client.isConnected || !client.user) {
      this.pendingUpdate = true;
      return false;
    }

    const { activity, preview } = buildPresence(config, {
      voice: this.getVoice(),
      now: Date.now(),
    });

    const cleanActivity = Object.fromEntries(
      Object.entries(activity).filter(([, value]) => value !== undefined && value !== null && value !== ''),
    );
    const signature = JSON.stringify(cleanActivity);

    if (!force && signature === this.lastSignature) {
      this.pendingUpdate = false;
      return false;
    }

    const now = Date.now();
    const wait = MIN_UPDATE_INTERVAL_MS - (now - this.lastSentAt);
    if (wait > 0 && !this.trailingTimer) {
      this.trailingTimer = setTimeout(() => {
        this.trailingTimer = null;
        this.update({ force: true }).catch(() => undefined);
      }, wait);
      this.trailingTimer.unref?.();
      return false;
    }

    try {
      await client.user.setActivity(cleanActivity, process.pid);
      this.lastSentAt = Date.now();
      this.lastSignature = signature;
      this.pendingUpdate = false;
      this.status.lastUpdateAt = new Date(this.lastSentAt).toISOString();
      this.status.lastError = null;
      this.emit('update', { activity: cleanActivity, preview });
      return true;
    } catch (error) {
      const message = safeError(error, [config.discord.botToken]);
      this.status.lastError = message;
      this.logger.error?.(`Не удалось обновить presence: ${message}`);
      this.emit('status', this.getStatus());
      if (String(error?.code) === '4007') {
        this.setStatus('error', 'Discord отклонил Application ID');
      }
      return false;
    }
  }

  handleConfigChanged(previousConfig) {
    const previousId = previousConfig?.discord?.applicationId || '';
    const nextId = this.getConfigSafe()?.discord?.applicationId || '';
    if (previousId !== nextId) {
      this.restart().catch(() => undefined);
      return;
    }
    this.update({ force: true }).catch(() => undefined);
  }

  async restart() {
    this.destroyClient();
    this.clearReconnectTimer();
    this.lastSignature = '';
    this.lastSentAt = 0;
    await this.connect();
  }

  destroyClient() {
    const client = this.client;
    this.client = null;
    this.status.user = null;
    if (!client) return;
    try {
      client.removeAllListeners?.();
    } catch {
      // ignore
    }
    Promise.resolve(client.destroy?.()).catch(() => undefined);
  }

  async clearActivity() {
    const client = this.client;
    if (!client?.isConnected || !client.user) return;
    try {
      await client.user.clearActivity(process.pid);
      this.lastSignature = '';
      this.status.lastUpdateAt = new Date().toISOString();
    } catch (error) {
      this.logger.warn?.(`Не удалось очистить presence: ${safeError(error)}`);
    }
  }

  async destroy() {
    this.disposed = true;
    this.clearReconnectTimer();
    if (this.trailingTimer) {
      clearTimeout(this.trailingTimer);
      this.trailingTimer = null;
    }
    this.destroyClient();
  }
}

module.exports = {
  PresenceManager,
};
