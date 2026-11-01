'use strict';

const CATEGORIES = Object.freeze({
  anime: 'Аниме',
  game: 'Игры',
  other: 'Другое',
});

const ACTIVITY_TYPES = Object.freeze({
  auto: 'Авто',
  playing: 'Играет',
  watching: 'Смотрит',
  listening: 'Слушает',
  competing: 'Соревнуется',
});

// Discord RPC SET_ACTIVITY supports Playing (0), Listening (2), Watching (3), Competing (5).
const RPC_ACTIVITY_TYPES = Object.freeze({
  playing: 0,
  listening: 2,
  watching: 3,
  competing: 5,
});

const LIMITS = Object.freeze({
  details: 128,
  state: 128,
  imageText: 128,
  buttonLabel: 32,
  buttonUrl: 512,
  title: 128,
  template: 128,
  displayName: 64,
  serverName: 64,
  channelName: 64,
  gifUrl: 1024,
  platformUrl: 1024,
  token: 200,
  id: 32,
});

const DEFAULT_PLATFORMS = Object.freeze([
  { id: 'twitch', name: 'Twitch', url: '', smallImageKey: '' },
  { id: 'youtube', name: 'YouTube', url: '', smallImageKey: '' },
  { id: 'kick', name: 'Kick', url: '', smallImageKey: '' },
  { id: 'vkplay', name: 'VK Play', url: '', smallImageKey: '' },
  { id: 'trovo', name: 'Trovo', url: '', smallImageKey: '' },
  { id: 'custom', name: 'Своё', url: '', smallImageKey: '' },
]);

const DEFAULT_PRESETS = Object.freeze([
  { id: 'anime-chill', title: 'Chill', category: 'anime', gifUrl: '' },
  { id: 'anime-frieren', title: 'Frieren', category: 'anime', gifUrl: '' },
  { id: 'anime-jjk', title: 'Jujutsu Kaisen', category: 'anime', gifUrl: '' },
  { id: 'anime-one-piece', title: 'One Piece', category: 'anime', gifUrl: '' },
  { id: 'game-minecraft', title: 'Minecraft', category: 'game', gifUrl: '' },
  { id: 'game-valorant', title: 'Valorant', category: 'game', gifUrl: '' },
  { id: 'game-genshin', title: 'Genshin Impact', category: 'game', gifUrl: '' },
]);

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  discord: {
    applicationId: '',
    botToken: '',
    guildId: '',
    userId: '',
    autoVoice: true,
    botInvisible: true,
  },
  voice: {
    serverName: 'aruku',
    channelName: 'Voice',
    channelUrl: '',
    showJoinButton: true,
    showNotInVoice: true,
    notInVoiceText: 'не в войсе',
  },
  stream: {
    platformId: 'twitch',
    startedAt: null,
    lastSessionMs: 0,
    autoStart: false,
    autoStop: false,
    showNativeTimer: false,
  },
  activity: {
    presetId: 'anime-chill',
    title: 'Chill',
    category: 'anime',
    gifUrl: '',
  },
  presence: {
    details: '{P} • {activity}',
    state: '{place} • {time}',
    largeText: '{activity}',
    smallText: '{P} • {time}',
    largeImageKey: 'rpc-location',
    smallImageKey: '',
    showButtons: true,
    activityType: 'auto',
    fallbackActivity: 'Chill',
  },
  platforms: DEFAULT_PLATFORMS.map((platform) => ({ ...platform })),
  presets: DEFAULT_PRESETS.map((preset) => ({ ...preset })),
  app: {
    displayName: 'aruku',
    launchAtLogin: false,
    minimizeToTray: true,
    animateTray: true,
    showSettingsOnStart: true,
  },
  ui: {
    windowBounds: null,
  },
});

module.exports = {
  ACTIVITY_TYPES,
  CATEGORIES,
  DEFAULT_CONFIG,
  DEFAULT_PLATFORMS,
  DEFAULT_PRESETS,
  LIMITS,
  RPC_ACTIVITY_TYPES,
};
