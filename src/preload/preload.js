'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('taro', {
  getState: () => invoke('state:get'),
  previewConfig: (patch) => invoke('app:preview', patch),
  saveConfig: (patch) => invoke('config:save', patch),
  resetConfig: () => invoke('config:reset'),
  apply: () => invoke('app:apply'),

  startTimer: () => invoke('app:start-timer'),
  stopTimer: () => invoke('app:stop-timer'),
  resetTimer: () => invoke('app:reset-timer'),

  selectPreset: (presetId) => invoke('app:select-preset', presetId),
  selectPlatform: (platformId) => invoke('app:select-platform', platformId),
  setFlag: (path, value) => invoke('app:set-flag', path, value),

  refreshVoice: () => invoke('app:refresh-voice'),
  reconnectRpc: () => invoke('app:reconnect-rpc'),
  reconnectBot: () => invoke('app:reconnect-bot'),
  clearActivity: () => invoke('app:clear-activity'),
  useRpcUser: () => invoke('app:use-rpc-user'),
  setGuild: (guildId) => invoke('app:set-guild', guildId),

  openUrl: (url) => invoke('app:open-url', url),
  openDevPortal: () => invoke('app:open-dev-portal'),
  openInvite: () => invoke('app:open-invite'),
  copyInvite: () => invoke('app:copy-invite'),
  copyText: (text) => invoke('app:copy-text', text),

  openConfigFolder: () => invoke('app:open-config-folder'),
  showLogs: () => invoke('app:show-logs'),
  clearLogs: () => invoke('app:clear-logs'),

  pickGif: () => invoke('app:pick-gif'),
  uploadGif: (filePath) => invoke('app:upload-gif', filePath),
  uploadSampleGif: () => invoke('app:upload-sample-gif'),
  testImageUrl: (url) => invoke('app:test-image-url', url),

  showWindow: (tab) => invoke('app:show-window', tab),
  showTab: (tab) => invoke('app:show-tab', tab),
  hideWindow: () => invoke('app:hide-window'),
  quit: () => invoke('app:quit'),

  onState: (callback) => subscribe('state:update', callback),
  onFocusTab: (callback) => subscribe('focus-tab', callback),
  onFocusField: (callback) => subscribe('focus-field', callback),
});
