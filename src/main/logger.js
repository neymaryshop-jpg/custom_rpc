'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { redactSecrets } = require('./util');

const MAX_ENTRIES = 300;
const MAX_LOG_BYTES = 1_500_000;

class Logger {
  constructor({ directory, getSecrets = () => [] }) {
    this.directory = directory;
    this.getSecrets = getSecrets;
    this.entries = [];
    this.filePath = path.join(directory, 'taro-rpc.log');
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch {
      // ignore
    }
  }

  redact(value) {
    return redactSecrets(value, this.getSecrets());
  }

  write(level, message) {
    const text = this.redact(String(message ?? ''));
    const line = `[${new Date().toLocaleTimeString('ru-RU')}] [${level.toUpperCase()}] ${text}`;
    this.entries.push(line);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);

    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);

    try {
      if (fs.existsSync(this.filePath) && fs.statSync(this.filePath).size > MAX_LOG_BYTES) {
        fs.renameSync(this.filePath, `${this.filePath}.old`);
      }
      fs.appendFileSync(this.filePath, `${line}\n`, { mode: 0o600 });
    } catch {
      // Logging should never crash the app.
    }
  }

  info(message) {
    this.write('info', message);
  }

  warn(message) {
    this.write('warn', message);
  }

  error(message) {
    this.write('error', message);
  }

  debug(message) {
    if (process.env.TARO_DEBUG === '1') this.write('debug', message);
    else this.entries.push(`[${new Date().toLocaleTimeString('ru-RU')}] [DEBUG] ${this.redact(String(message ?? ''))}`);
  }

  list() {
    return [...this.entries];
  }

  clear() {
    this.entries = [];
  }
}

module.exports = {
  Logger,
};
