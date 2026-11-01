'use strict';

const taro = window.taro;

const CATEGORY_LABELS = {
  anime: 'Аниме',
  game: 'Игры',
  other: 'Другое',
};

const ACTIVITY_TYPE_LABELS = {
  auto: 'Авто',
  playing: 'Играет',
  watching: 'Смотрит',
  listening: 'Слушает',
  competing: 'Соревнуется',
};

const VOICE_SOURCE_LABELS = {
  auto: 'авто',
  manual: 'вручную',
  not_in_voice: 'не в войсе',
};

const $ = (id) => document.getElementById(id);

let latest = null;
let form = null;
let dirty = new Set();
let changeVersion = 0;
let initialized = false;
let lastConfigSignature = '';
let lastGuildSignature = '';
let currentPreview = null;
let currentValidation = null;
let previewTimer = null;
let previewSeq = 0;
let toastTimer = null;
let toastHideTimer = null;
let tickCount = 0;
let pendingGif = null;
let activeTab = 'main';

/* ------------------------------------------------------------------ utils */

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(Number(ms || 0) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatHms(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КБ`;
  return `${(value / (1024 * 1024)).toFixed(1)} МБ`;
}

function formatClock(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function getPath(object, path) {
  return String(path)
    .split('.')
    .reduce((current, key) => (current === undefined || current === null ? undefined : current[key]), object);
}

function setPath(object, path, value) {
  const keys = String(path).split('.');
  let current = object;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    if (!current[key] || typeof current[key] !== 'object') current[key] = {};
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
}

function slugify(value, fallback = 'item') {
  const slug = String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || fallback;
}

function uniqueId(base, existingIds, fallback = 'item') {
  const existing = new Set(existingIds);
  const stem = slugify(base, fallback);
  if (!existing.has(stem)) return stem;
  let index = 2;
  while (existing.has(`${stem}-${index}`)) index += 1;
  return `${stem}-${index}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncateText(value, maxLength) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

/* --------------------------------------------------------------- toast */

function toast(message, kind = '', duration = 3200) {
  const element = $('toast');
  if (!element) return;
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  element.textContent = String(message ?? '');
  element.className = `toast show${kind ? ` ${kind}` : ''}`;
  element.hidden = false;
  toastTimer = setTimeout(() => {
    element.classList.remove('show');
    toastHideTimer = setTimeout(() => {
      element.hidden = true;
    }, 220);
  }, duration);
}

/* ---------------------------------------------------------- async helpers */

async function withBusy(button, label, task) {
  if (!button) return task();
  const original = button.textContent;
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.textContent = label;
  try {
    return await task();
  } finally {
    button.disabled = wasDisabled;
    button.textContent = original;
  }
}

function safeError(error, fallback = 'Что-то пошло не так') {
  if (!error) return fallback;
  return error.message || String(error) || fallback;
}

/* ----------------------------------------------------------- dirty state */

function markDirty(path) {
  if (!path) return;
  dirty.add(path);
  changeVersion += 1;
  setSaveState('dirty');
  schedulePreview();
}

function markManyDirty(paths) {
  for (const path of paths) dirty.add(path);
  changeVersion += 1;
  setSaveState('dirty');
  schedulePreview();
}

function updateDirtyUi() {
  if (!dirty.size) setSaveState('saved');
  else setSaveState('dirty');
}

function setSaveState(mode, text = '') {
  const element = $('saveState');
  if (!element) return;
  element.className = 'save-state';
  if (mode === 'dirty') {
    element.textContent = 'Есть несохранённые изменения';
  } else if (mode === 'saving') {
    element.textContent = 'Сохраняю…';
  } else if (mode === 'error') {
    element.classList.add('error');
    element.textContent = text || 'Ошибка сохранения';
  } else {
    element.textContent = text || 'Всё сохранено';
  }
  if (mode === 'dirty') element.classList.add('dirty');
}

function buildPatch() {
  const patch = {};
  if (!form) return patch;
  for (const path of dirty) {
    const value = getPath(form, path);
    if (value === undefined) continue;
    setPath(patch, path, clone(value));
  }
  return patch;
}

function currentPlatform() {
  if (!form) return null;
  return (form.platforms || []).find((item) => item.id === form.stream.platformId) || form.platforms?.[0] || null;
}

function currentPreset() {
  if (!form) return null;
  return (form.presets || []).find((item) => item.id === form.activity.presetId) || null;
}

/* ------------------------------------------------------- form application */

function syncFieldValues() {
  if (!form) return;
  document.querySelectorAll('[data-field]').forEach((element) => {
    const path = element.dataset.field;
    if (!path || path === 'platforms') return;
    const value = getPath(form, path);
    if (element.type === 'checkbox') {
      element.checked = Boolean(value);
    } else if (value !== undefined && value !== null) {
      element.value = String(value);
    } else {
      element.value = '';
    }
    element.classList.remove('invalid');
  });
}

function applyConfigToForm(config) {
  form = clone(config);
  dirty.clear();
  changeVersion += 1;
  syncFieldValues();
  renderPresetOptions();
  renderCategory();
  renderPlatformOptions();
  renderPresets();
  lastGuildSignature = '';
  renderGuildOptions();
  updateActivityCounter();
  updateDirtyUi();
}

function renderPresetOptions() {
  if (!form) return;
  const select = $('presetSelect');
  const current = form.activity?.presetId || 'custom';
  const fragment = document.createDocumentFragment();
  for (const preset of form.presets || []) {
    const label = `${preset.title} · ${CATEGORY_LABELS[preset.category] || 'Другое'}`;
    fragment.append(new Option(truncateText(label, 80), preset.id));
  }
  fragment.append(new Option('✏️ Своё (ввести вручную)', 'custom'));
  select.textContent = '';
  select.append(fragment);
  select.value = (form.presets || []).some((preset) => preset.id === current) ? current : 'custom';
}

function renderCategory() {
  if (!form) return;
  const category = form.activity?.category || 'anime';
  document.querySelectorAll('#categorySegmented button').forEach((button) => {
    button.classList.toggle('active', button.dataset.category === category);
  });
}

function renderPlatformOptions() {
  if (!form) return;
  const select = $('platformSelect');
  const current = form.stream?.platformId || form.platforms?.[0]?.id;
  const fragment = document.createDocumentFragment();
  for (const platform of form.platforms || []) {
    fragment.append(new Option(truncateText(platform.name, 60), platform.id));
  }
  select.textContent = '';
  select.append(fragment);
  select.value = current || '';
  renderPlatformFields();
}

function renderPlatformFields() {
  if (!form) return;
  const platform = currentPlatform();
  if (!platform) return;
  $('platformUrl').value = platform.url || '';
  $('customPlatformName').value = platform.name || '';
  $('customPlatformField').hidden = platform.id !== 'custom';
}

function renderPresets() {
  if (!form) return;
  const list = $('presetList');
  list.textContent = '';
  const presets = form.presets || [];
  if (presets.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'preset-empty';
    empty.textContent = 'Пресетов нет. Добавь хотя бы один.';
    list.append(empty);
    return;
  }

  for (const preset of presets) {
    const row = document.createElement('div');
    row.className = 'preset-row';
    row.dataset.presetId = preset.id;

    const title = document.createElement('input');
    title.className = 'preset-title';
    title.type = 'text';
    title.maxLength = 128;
    title.placeholder = 'Название';
    title.value = preset.title;
    title.addEventListener('input', () => {
      preset.title = title.value;
      markDirty('presets');
    });
    title.addEventListener('change', () => {
      if (!title.value.trim()) {
        title.value = preset.title.trim() || 'Без названия';
        preset.title = title.value;
        markDirty('presets');
      }
      renderPresetOptions();
    });

    const category = document.createElement('select');
    category.className = 'preset-category';
    for (const [value, label] of Object.entries(CATEGORY_LABELS)) {
      category.append(new Option(label, value));
    }
    category.value = preset.category;
    category.addEventListener('change', () => {
      preset.category = category.value;
      markDirty('presets');
      renderPresetOptions();
    });

    const gif = document.createElement('input');
    gif.className = 'preset-gif';
    gif.type = 'url';
    gif.placeholder = 'https://…/animation.gif';
    gif.value = preset.gifUrl || '';
    gif.addEventListener('input', () => {
      preset.gifUrl = gif.value;
      markDirty('presets');
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'preset-del';
    remove.textContent = '×';
    remove.title = 'Удалить пресет';
    remove.disabled = presets.length <= 1;
    remove.addEventListener('click', () => {
      if (form.presets.length <= 1) {
        toast('Должен остаться хотя бы один пресет', 'bad');
        return;
      }
      const index = form.presets.findIndex((item) => item.id === preset.id);
      if (index === -1) return;
      form.presets.splice(index, 1);
      if (form.activity.presetId === preset.id) {
        form.activity.presetId = 'custom';
        markDirty('activity.presetId');
      }
      markDirty('presets');
      renderPresets();
      renderPresetOptions();
    });

    row.append(title, category, gif, remove);
    list.append(row);
  }
}

function updateActivityCounter() {
  if (!form) return;
  const length = String(form.activity?.title || '').length;
  $('activityCounter').textContent = `${length} / 128`;
}

function renderGuildOptions() {
  if (!form) return;
  const select = $('guildSelect');
  if (document.activeElement === select) return;

  const guilds = latest?.botGuilds || latest?.status?.bot?.guilds || [];
  const signature = `${guilds.map((guild) => guild.id).join(',')}|${form.discord.guildId || ''}`;
  if (signature === lastGuildSignature) return;
  lastGuildSignature = signature;

  const fragment = document.createDocumentFragment();
  fragment.append(new Option('Ввести ID вручную', '__manual__'));
  for (const guild of guilds) {
    const label = guild.memberCount ? `${guild.name} · ${guild.memberCount} чел.` : guild.name;
    fragment.append(new Option(truncateText(label, 70), guild.id));
  }
  select.textContent = '';
  select.append(fragment);
  const id = form.discord.guildId || '';
  select.value = guilds.some((guild) => guild.id === id) ? id : '__manual__';
}

/* -------------------------------------------------------------- rendering */

function renderPreview(preview) {
  if (!preview) return;
  currentPreview = preview;

  $('previewAppName').textContent = preview.appName || 'aruku';
  $('previewType').textContent = preview.typeLabel || 'Играет';
  $('previewDetails').textContent = preview.details || '—';
  $('previewState').textContent = preview.state || '';
  $('previewSmallText').textContent = preview.smallText || '';
  $('previewSource').textContent = preview.voiceSource
    ? `войс: ${VOICE_SOURCE_LABELS[preview.voiceSource] || preview.voiceSource}`
    : '';

  const image = $('previewImage');
  const placeholder = $('previewImagePlaceholder');
  const gifBadge = $('previewGifBadge');

  let imageUrl = preview.imageUrl || '';
  if (!imageUrl && preview.imageKey && latest?.config?.discord?.applicationId) {
    const appId = latest.config.discord.applicationId;
    imageUrl = `https://cdn.discordapp.com/app-assets/${encodeURIComponent(appId)}/${encodeURIComponent(preview.imageKey)}.png`;
  }

  if (imageUrl) {
    if (image.getAttribute('src') !== imageUrl) image.setAttribute('src', imageUrl);
    image.hidden = false;
    placeholder.hidden = true;
    const extension = (imageUrl.split('?')[0].match(/\.(gif|webp|avif|png|jpe?g)$/i) || [])[1] || '';
    const animated = /^(gif|webp|avif)$/i.test(extension);
    gifBadge.hidden = !animated;
    if (animated) gifBadge.textContent = extension.toUpperCase();
  } else {
    image.hidden = true;
    image.removeAttribute('src');
    placeholder.hidden = false;
    placeholder.textContent = preview.imageKey ? 'ASSET' : 'GIF';
    gifBadge.hidden = true;
  }

  const buttons = $('previewButtons');
  buttons.textContent = '';
  for (const button of preview.buttons || []) {
    const link = document.createElement('a');
    link.className = 'discord-button';
    link.href = button.url;
    link.textContent = button.label;
    link.title = button.url;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      taro.openUrl(button.url);
    });
    buttons.append(link);
  }

  paintPreviewClock();
  const live = Boolean(latest?.timer?.running);
  $('previewBadge').textContent = live ? 'LIVE' : 'OFF';
  $('previewBadge').classList.toggle('off', !live);
}

function paintPreviewClock() {
  const element = $('previewNativeTimer');
  if (!element) return;
  const preview = currentPreview;
  if (preview?.nativeTimer && preview?.startedAt) {
    const started = new Date(preview.startedAt).getTime();
    if (Number.isFinite(started)) {
      element.hidden = false;
      element.textContent = `${formatHms(Date.now() - started)} прошло`;
      return;
    }
  }
  element.hidden = true;
}

function renderHero(preview) {
  const data = preview || latest?.preview;
  if (!data) return;
  $('heroTitle').textContent = data.title || 'Настрой свой статус';
  const subtitle = [data.details, data.state].filter(Boolean).join(' · ');
  $('heroSubtitle').textContent = subtitle || 'Выбери, что показываешь, и запусти таймер.';
  $('voiceChip').textContent =
    data.voiceSource === 'not_in_voice'
      ? `🎧 ${data.serverName || 'aruku'} · не в войсе`
      : `🎧 ${data.serverName || 'aruku'} / ${data.channelName || 'Voice'}${data.voiceSource === 'auto' ? ' · авто' : ''}`;
  $('platformChip').textContent = `📺 ${data.platformName || 'Площадка'}`;
}

function timerStartedAt() {
  const startedAt = latest?.timer?.startedAt;
  if (!startedAt) return null;
  const time = new Date(startedAt).getTime();
  return Number.isFinite(time) ? time : null;
}

function paintTimer() {
  if (!latest?.timer) return;
  const started = timerStartedAt();
  const running = Boolean(started);
  const elapsedMs = running ? Math.max(0, Date.now() - started) : 0;
  const lastSessionMs = Number(latest.timer.lastSessionMs || 0);

  const displayMs = running ? elapsedMs : lastSessionMs;
  $('timerDisplay').textContent = formatDuration(displayMs);
  $('timerHms').textContent = formatHms(displayMs);
  $('timerMeta').textContent = running
    ? `Стрим идёт · старт в ${formatClock(started)}`
    : lastSessionMs > 0
      ? 'Таймер остановлен'
      : 'Таймер не запущен';
  $('lastSession').textContent = `Последняя сессия: ${
    latest.timer.lastSessionMs ? formatDuration(latest.timer.lastSessionMs) : '—'
  }`;
  $('quickStartBtn').disabled = running;
  $('quickStopBtn').disabled = !running;
  $('startTimerBtn').disabled = running;
  $('stopTimerBtn').disabled = !running;
  $('timerChip').textContent = running ? `⏱ ${formatDuration(elapsedMs)}` : '⏱ не запущен';

  const timerBadge = $('timerBadge');
  timerBadge.textContent = running ? 'идёт' : lastSessionMs > 0 ? 'пауза' : '—';
  timerBadge.className = 'badge soft';

  const previewBadge = $('previewBadge');
  if (previewBadge) {
    previewBadge.textContent = running ? 'LIVE' : 'OFF';
    previewBadge.classList.toggle('off', !running);
  }

  const activityBadge = $('activityBadge');
  if (activityBadge && form) {
    activityBadge.textContent = CATEGORY_LABELS[form.activity?.category] || 'Другое';
  }
  const voiceBadge = $('voiceBadge');
  if (voiceBadge) {
    const source = latest.status?.voice?.source;
    voiceBadge.textContent = VOICE_SOURCE_LABELS[source] || '—';
  }

  paintPreviewClock();
}

function setPill(element, tone, text) {
  if (!element) return;
  element.className = `pill${tone ? ` ${tone}` : ''}`;
  element.textContent = text;
  element.title = text;
}

function setDot(element, tone, extra = '') {
  if (!element) return;
  element.className = `dot${extra ? ` ${extra}` : ''}${tone ? ` ${tone}` : ''}`;
}

function rpcTone(rpc) {
  if (rpc.connected) return 'good';
  if (rpc.state === 'connecting') return 'warn';
  if (rpc.state === 'error' || rpc.state === 'no_app_id') return 'bad';
  if (rpc.state === 'disconnected') return 'warn';
  return '';
}

function botTone(bot) {
  if (bot.online) return 'good';
  if (bot.state === 'connecting') return 'warn';
  if (bot.state === 'error') return 'bad';
  if (bot.state === 'missing_token') return 'warn';
  return '';
}

function renderStatus() {
  if (!latest?.status) return;
  const rpc = latest.status.rpc || {};
  const bot = latest.status.bot || {};
  const voice = latest.status.voice || {};

  setPill(
    $('rpcPill'),
    rpcTone(rpc),
    rpc.connected
      ? `Discord: ${rpc.user?.username || 'подключён'}`
      : rpc.message || 'Discord: —',
  );
  setPill(
    $('botPill'),
    botTone(bot),
    bot.online ? `Бот: ${bot.username || 'на связи'}` : bot.message || 'Бот: —',
  );
  setDot($('rpcDot'), rpcTone(rpc));
  setDot($('botDot'), botTone(bot));
  setDot(
    $('discordDot'),
    rpcTone(rpc),
  );

  const voiceTone = voice.inVoice ? 'good' : voice.auto ? 'warn' : '';
  setDot($('voiceDot'), voiceTone, voice.auto ? '' : 'violet');

  const rpcUpdated = rpc.lastUpdateAt ? ` · ${formatClock(rpc.lastUpdateAt)}` : '';
  $('rpcStatusText').textContent = `${rpc.message || '—'}${
    rpc.user?.username ? ` · @${rpc.user.username}` : ''
  }${rpcUpdated}`;
  $('botStatusText').textContent = `${bot.message || '—'}${bot.username ? ` · @${bot.username}` : ''}`;

  const voicePlace = [voice.serverName, voice.channelName].filter(Boolean).join(' / ');
  $('voiceStatusText').textContent = `${voicePlace || '—'} · ${
    VOICE_SOURCE_LABELS[voice.source] || 'вручную'
  }`;
  $('statusUpdated').textContent = `Обновлено ${formatClock(latest.now || Date.now())}`;

  $('activityBadge').textContent = CATEGORY_LABELS[form?.activity?.category] || 'Другое';
  $('voiceBadge').textContent = VOICE_SOURCE_LABELS[voice.source] || '—';
}

function renderValidation(validation) {
  currentValidation = validation;
  const box = $('validationBox');
  if (!box) return;
  box.textContent = '';

  const errors = Array.isArray(validation?.errors) ? validation.errors : [];
  const warnings = [
    ...(Array.isArray(validation?.warnings) ? validation.warnings : []),
    ...(Array.isArray(latest?.identityWarnings) ? latest.identityWarnings : []),
  ];

  const items = [];
  for (const error of errors) items.push({ kind: 'error', text: error });
  const seen = new Set();
  for (const warning of warnings) {
    if (seen.has(warning)) continue;
    seen.add(warning);
    items.push({ kind: 'warn', text: warning });
  }

  const visible = items.slice(0, 7);
  for (const item of visible) {
    const notice = document.createElement('div');
    notice.className = `notice ${item.kind}`;
    notice.textContent = item.text;
    box.append(notice);
  }
  if (items.length > visible.length) {
    const more = document.createElement('div');
    more.className = 'notice info';
    more.textContent = `И ещё ${items.length - visible.length} предупреждений…`;
    box.append(more);
  }
}

function renderSetup() {
  const banner = $('setupBanner');
  if (!banner) return;
  banner.hidden = Boolean(latest?.config?.discord?.applicationId);
}

function renderLogs() {
  const logs = Array.isArray(latest?.logs) ? latest.logs : [];
  $('logsPreview').textContent = logs.slice(-8).join('\n') || 'Пока тихо.';
  $('logsFull').textContent = logs.join('\n') || 'Пока тихо.';
  const full = $('logsFull');
  full.scrollTop = full.scrollHeight;
}

function renderPaths() {
  const box = $('pathsInfo');
  const paths = latest?.paths;
  if (!box) return;
  box.textContent = '';
  if (!paths) return;
  const rows = [
    ['Конфиг', paths.config],
    ['Лог', paths.logs],
    ['Данные', paths.userData],
    ['Приложение', paths.appRoot],
  ];
  for (const [label, value] of rows) {
    if (!value) continue;
    const row = document.createElement('div');
    const strong = document.createElement('b');
    strong.textContent = `${label}: `;
    row.append(strong, document.createTextNode(value));
    box.append(row);
  }
}

/* ------------------------------------------------------- state ingestion */

function handleState(data) {
  if (!data || !data.ready) return;
  latest = data;

  const signature = JSON.stringify(data.config);
  const configChanged = signature !== lastConfigSignature;
  lastConfigSignature = signature;

  if (!dirty.size && (configChanged || !initialized)) {
    initialized = true;
    applyConfigToForm(data.config);
  } else {
    renderGuildOptions();
  }

  renderStatus();
  renderSetup();
  renderLogs();
  renderPaths();
  paintTimer();

  if (!dirty.size) {
    renderValidation(data.validation || { errors: [], warnings: [] });
    if (data.preview) {
      currentPreview = data.preview;
      renderPreview(data.preview);
      renderHero(data.preview);
    }
  } else if (currentPreview) {
    renderPreview(currentPreview);
    renderHero(currentPreview);
  } else {
    renderValidation(currentValidation || data.validation);
  }

  initialized = true;
}

function schedulePreview() {
  if (!form) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 160);
}

async function runPreview() {
  if (!form) return;
  const seq = ++previewSeq;
  try {
    const result = await taro.previewConfig(buildPatch());
    if (seq !== previewSeq) return;
    if (!result?.ok) return;
    currentPreview = result.preview;
    renderPreview(result.preview);
    renderHero(result.preview);
    renderValidation(result.validation);
    paintTimer();
  } catch {
    // Preview is a nice-to-have; ignore transient errors.
  }
}

function startTicker() {
  setInterval(() => {
    tickCount += 1;
    paintTimer();
    if (tickCount % 20 === 0 && dirty.size && latest?.timer?.running) schedulePreview();
  }, 1000);
}

/* ----------------------------------------------------------- field bindings */

function setFormValue(path, value) {
  if (!form) return;
  setPath(form, path, value);
  markDirty(path);
}

function bindFields() {
  document.querySelectorAll('[data-field]').forEach((element) => {
    const path = element.dataset.field;
    if (!path || path === 'platforms') return;
    const eventName = element.tagName === 'SELECT' || element.type === 'checkbox' ? 'change' : 'input';
    element.addEventListener(eventName, () => {
      const value = element.type === 'checkbox' ? Boolean(element.checked) : element.value;
      setFormValue(path, value);
      element.classList.remove('invalid');
      if (path === 'activity.title') {
        if (form.activity.presetId !== 'custom') {
          form.activity.presetId = 'custom';
          markDirty('activity.presetId');
          renderPresetOptions();
        }
        updateActivityCounter();
      }
      if (path === 'activity.gifUrl') {
        $('gifCheckResult').hidden = true;
      }
      if (path === 'discord.guildId') {
        const guilds = latest?.botGuilds || latest?.status?.bot?.guilds || [];
        const select = $('guildSelect');
        select.value = guilds.some((guild) => guild.id === value) ? value : '__manual__';
        lastGuildSignature = '';
      }
    });
  });

  $('platformUrl').addEventListener('input', () => {
    const platform = currentPlatform();
    if (!platform) return;
    platform.url = $('platformUrl').value;
    markDirty('platforms');
  });

  $('customPlatformName').addEventListener('input', () => {
    const platform = currentPlatform();
    if (!platform) return;
    platform.name = $('customPlatformName').value;
    markDirty('platforms');
    const option = $('platformSelect').selectedOptions[0];
    if (option) option.textContent = truncateText(platform.name || 'Своё', 60);
  });
  $('customPlatformName').addEventListener('change', () => {
    const platform = currentPlatform();
    if (platform && !platform.name.trim()) {
      platform.name = 'Своё';
      $('customPlatformName').value = platform.name;
      markDirty('platforms');
      renderPlatformOptions();
    }
  });

  document.querySelectorAll('#categorySegmented button').forEach((button) => {
    button.addEventListener('click', () => {
      if (!form) return;
      const category = button.dataset.category;
      if (!CATEGORY_LABELS[category]) return;
      form.activity.category = category;
      const preset = currentPreset();
      if (preset && preset.category !== category) {
        form.activity.presetId = 'custom';
        markDirty('activity.presetId');
        renderPresetOptions();
      }
      markDirty('activity.category');
      renderCategory();
      paintTimer();
      updateActivityCounter();
    });
  });

  $('presetSelect').addEventListener('change', () => {
    if (!form) return;
    const id = $('presetSelect').value;
    if (id === 'custom') {
      form.activity.presetId = 'custom';
      markDirty('activity.presetId');
      $('activityTitle').focus();
      return;
    }
    const preset = (form.presets || []).find((item) => item.id === id);
    if (!preset) return;
    form.activity.presetId = preset.id;
    form.activity.title = preset.title;
    form.activity.category = preset.category;
    form.activity.gifUrl = preset.gifUrl || '';
    markManyDirty([
      'activity.presetId',
      'activity.title',
      'activity.category',
      'activity.gifUrl',
    ]);
    syncFieldValues();
    renderCategory();
    updateActivityCounter();
    $('gifCheckResult').hidden = true;
  });

  $('platformSelect').addEventListener('change', () => {
    if (!form) return;
    form.stream.platformId = $('platformSelect').value;
    markDirty('stream.platformId');
    renderPlatformFields();
  });

  $('guildSelect').addEventListener('change', () => {
    if (!form) return;
    const value = $('guildSelect').value;
    if (value === '__manual__') {
      form.discord.guildId = '';
      $('guildId').value = '';
      $('guildId').focus();
    } else {
      form.discord.guildId = value;
      $('guildId').value = value;
    }
    markDirty('discord.guildId');
  });
}

/* --------------------------------------------------------------- actions */

async function saveForm({ quiet = false } = {}) {
  if (!form) return { ok: false, error: 'Форма ещё не загружена' };
  if (dirty.size === 0) {
    if (!quiet) toast('Изменений нет');
    return { ok: true, skipped: true };
  }

  const version = changeVersion;
  const patch = buildPatch();
  setSaveState('saving');

  let result;
  try {
    result = await taro.saveConfig(patch);
  } catch (error) {
    setSaveState('error', 'Не удалось сохранить');
    if (!quiet) toast(`Не удалось сохранить: ${safeError(error)}`, 'bad', 5000);
    return { ok: false, error: safeError(error) };
  }

  if (result?.snapshot) handleState(result.snapshot);

  if (result?.ok) {
    if (version === changeVersion) {
      dirty.clear();
      if (result.snapshot?.config) applyConfigToForm(result.snapshot.config);
      if (result.snapshot?.preview) {
        renderPreview(result.snapshot.preview);
        renderHero(result.snapshot.preview);
      }
      paintTimer();
      setSaveState('saved');
      if (!quiet) {
        const hasWarnings = Array.isArray(result.warnings) && result.warnings.length > 0;
        toast(hasWarnings ? 'Сохранено, но есть предупреждения' : 'Сохранено', hasWarnings ? '' : 'good');
      }
    } else {
      setSaveState('dirty');
    }
    if (Array.isArray(result.warnings) && result.warnings.length > 0) {
      renderValidation({ errors: [], warnings: result.warnings });
    }
  } else {
    setSaveState('error', result?.errors?.[0] || 'Ошибка сохранения');
    renderValidation({
      errors: Array.isArray(result?.errors) ? result.errors : ['Не удалось сохранить'],
      warnings: Array.isArray(result?.warnings) ? result.warnings : [],
    });
    if (!quiet) toast(result?.errors?.[0] || 'Не удалось сохранить', 'bad', 5000);
    markInvalidFields(result?.errors);
  }

  return result || { ok: false };
}

function markInvalidFields(errors) {
  document.querySelectorAll('input.invalid').forEach((element) => element.classList.remove('invalid'));
  if (!Array.isArray(errors)) return;
  for (const error of errors) {
    if (/Application ID/i.test(error)) $('appId').classList.add('invalid');
    if (/Время старта/i.test(error)) $('timerCard').classList.add('invalid');
  }
}

async function applyNow() {
  const saved = await saveForm({ quiet: true });
  if (!saved?.ok) return;
  try {
    const result = await taro.apply();
    if (result?.snapshot) handleState(result.snapshot);
    toast('Применено', 'good');
  } catch (error) {
    toast(`Не удалось применить: ${safeError(error)}`, 'bad', 5000);
  }
}

function applyPresetValues(preset) {
  if (!form || !preset) return;
  form.activity.presetId = preset.id;
  form.activity.title = preset.title;
  form.activity.category = preset.category;
  form.activity.gifUrl = preset.gifUrl || '';
  markManyDirty(['activity.presetId', 'activity.title', 'activity.category', 'activity.gifUrl']);
  syncFieldValues();
  renderCategory();
  renderPresetOptions();
  updateActivityCounter();
}

function addPreset() {
  if (!form) return;
  const base = 'Новый пресет';
  const existingTitles = new Set((form.presets || []).map((preset) => preset.title.toLowerCase()));
  let title = base;
  let index = 2;
  while (existingTitles.has(title.toLowerCase())) {
    title = `${base} ${index}`;
    index += 1;
  }
  const id = uniqueId(title, (form.presets || []).map((preset) => preset.id), 'preset');
  form.presets.push({
    id,
    title,
    category: form.activity.category || 'anime',
    gifUrl: '',
  });
  markDirty('presets');
  renderPresets();
  renderPresetOptions();
  const input = $('presetList').querySelector('.preset-row:last-child .preset-title');
  if (input) {
    input.focus();
    input.select();
  }
}

function saveAsPreset() {
  if (!form) return;
  const title = String(form.activity.title || '').trim();
  if (!title) {
    toast('Сначала введи название активности', 'bad');
    $('activityTitle').focus();
    return;
  }
  const existing = (form.presets || []).find(
    (preset) => preset.title.toLowerCase() === title.toLowerCase() && preset.category === form.activity.category,
  );
  if (existing) {
    existing.gifUrl = form.activity.gifUrl || '';
    existing.title = title;
    form.activity.presetId = existing.id;
  } else {
    const id = uniqueId(title, (form.presets || []).map((preset) => preset.id), 'preset');
    form.presets.push({
      id,
      title,
      category: form.activity.category,
      gifUrl: form.activity.gifUrl || '',
    });
    form.activity.presetId = id;
  }
  markDirty('presets');
  markDirty('activity.presetId');
  renderPresets();
  renderPresetOptions();
  saveForm({ quiet: true }).then((result) => {
    if (result?.ok) toast(`Пресет «${title}» сохранён`, 'good');
  });
}

function applyPresetFromTab() {
  if (!form) return;
  const preset = currentPreset();
  if (!preset) {
    toast('Выбери пресет в разделе «Что я показываю»', 'bad');
    switchTab('main');
    return;
  }
  applyPresetValues(preset);
  saveForm({ quiet: true }).then((result) => {
    if (result?.ok) {
      switchTab('main');
      toast(`Пресет «${preset.title}» применён`, 'good');
    }
  });
}

function setActivityGif(url) {
  if (!form) return;
  form.activity.gifUrl = url;
  markDirty('activity.gifUrl');
  $('gifUrl').value = url;
  $('gifCheckResult').hidden = true;
  schedulePreview();
}

async function pickGifFile() {
  try {
    const result = await taro.pickGif();
    if (!result?.ok) return null;
    pendingGif = { path: result.path, name: result.name, size: result.size };
    $('pickedGifName').textContent = `${result.name} · ${formatBytes(result.size)}`;
    return pendingGif;
  } catch (error) {
    toast(`Не удалось выбрать файл: ${safeError(error)}`, 'bad');
    return null;
  }
}

async function uploadPickedGif() {
  let file = pendingGif;
  if (!file) {
    file = await pickGifFile();
    if (!file) return;
  }
  await withBusy($('uploadGifBtn'), 'Загружаю…', async () => {
    try {
      const result = await taro.uploadGif(file.path);
      if (result?.ok) {
        setActivityGif(result.url);
        toast('GIF загружен и подставлен в статус', 'good', 4200);
      } else if (!result?.cancelled) {
        toast(result?.error || 'Не удалось загрузить GIF', 'bad', 5000);
      }
    } catch (error) {
      toast(`Не удалось загрузить GIF: ${safeError(error)}`, 'bad', 5000);
    }
  });
}

async function uploadSampleGif() {
  await withBusy($('sampleGifBtn'), 'Загружаю…', async () => {
    try {
      const result = await taro.uploadSampleGif();
      if (result?.ok) {
        setActivityGif(result.url);
        toast('Пример анимации загружен — проверь превью', 'good', 4200);
      } else if (!result?.cancelled) {
        toast(result?.error || 'Не удалось загрузить пример', 'bad', 5000);
      }
    } catch (error) {
      toast(`Не удалось загрузить пример: ${safeError(error)}`, 'bad', 5000);
    }
  });
}

async function testGifUrl() {
  if (!form) return;
  const url = String($('gifUrl').value || '').trim();
  const resultBox = $('gifCheckResult');
  resultBox.hidden = false;
  if (!url) {
    resultBox.className = 'check-result bad';
    resultBox.textContent = 'Вставь ссылку на GIF или картинку.';
    return;
  }
  resultBox.className = 'check-result';
  resultBox.textContent = 'Проверяю ссылку…';
  try {
    const result = await taro.testImageUrl(url);
    if (result?.ok) {
      resultBox.className = 'check-result good';
      resultBox.textContent = `${result.message}${result.animated ? ' Анимация поддерживается.' : ''}${
        result.size ? ` Размер: ${formatBytes(result.size)}.` : ''
      }`;
      toast('Ссылка доступна', 'good');
    } else {
      resultBox.className = 'check-result bad';
      resultBox.textContent = result?.message || 'Ссылка недоступна.';
      toast('Ссылка не подходит', 'bad');
    }
  } catch (error) {
    resultBox.className = 'check-result bad';
    resultBox.textContent = safeError(error);
  }
}

async function runTimer(action, kind = 'start') {
  try {
    const result = await action();
    if (result?.snapshot) handleState(result.snapshot);
    if (result?.ok === false) {
      toast(result.error || 'Не удалось изменить таймер', 'bad');
      return;
    }
    if (kind === 'start') {
      toast(result?.alreadyRunning ? 'Таймер уже идёт' : 'Стрим начался — таймер запущен', 'good');
    } else if (kind === 'stop') {
      const elapsed = result?.snapshot?.timer?.lastSessionElapsed;
      toast(elapsed ? `Таймер остановлен · ${elapsed}` : 'Таймер остановлен', 'good');
    } else if (kind === 'reset') {
      toast('Таймер сброшен', 'good');
    }
    schedulePreview();
  } catch (error) {
    toast(`Ошибка таймера: ${safeError(error)}`, 'bad');
  }
}

/* --------------------------------------------------------------- UI wiring */

const TAB_ALIASES = {
  activity: 'main',
  platform: 'main',
  voice: 'main',
  discord: 'main',
};

const TAB_SECTIONS = {
  activity: 'activityCard',
  platform: 'activityCard',
  voice: 'voiceCard',
  discord: 'discordCard',
};

function switchTab(tab) {
  if (!tab) return;
  const target = TAB_ALIASES[tab] || tab;
  const known = [...document.querySelectorAll('.tab')].some((button) => button.dataset.tab === target);
  if (!known) return;
  activeTab = target;
  document.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === target);
    button.setAttribute('aria-selected', button.dataset.tab === target ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== target;
  });
  const content = document.querySelector('.content');
  if (content) content.scrollTop = 0;
  const section = TAB_SECTIONS[tab];
  if (section) {
    requestAnimationFrame(() => {
      $(section)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }
}

function focusFieldById(id) {
  const element = $(id);
  if (!element) return;
  const panel = element.closest('.tab-panel');
  if (panel) switchTab(panel.dataset.panel);
  requestAnimationFrame(() => {
    element.focus();
    if (typeof element.select === 'function') element.select();
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

function openDevPortal() {
  taro.openDevPortal();
}

async function openInvite() {
  try {
    const result = await taro.openInvite();
    if (!result?.ok) {
      toast('Сначала укажи Application ID или токен бота', 'bad');
    }
  } catch (error) {
    toast(`Не удалось открыть приглашение: ${safeError(error)}`, 'bad');
  }
}

async function copyInvite() {
  try {
    const result = await taro.copyInvite();
    if (result?.ok) toast('Ссылка-приглашение скопирована', 'good');
    else toast(result?.error || 'Не удалось скопировать ссылку', 'bad');
  } catch (error) {
    toast(`Не удалось скопировать: ${safeError(error)}`, 'bad');
  }
}

async function useRpcUser() {
  await withBusy($('useRpcUserBtn'), '…', async () => {
    try {
      const result = await taro.useRpcUser();
      if (result?.snapshot) handleState(result.snapshot);
      if (result?.ok) toast('User ID взят из Discord RPC', 'good');
      else toast(result?.error || result?.errors?.[0] || 'RPC ещё не подключён', 'bad');
    } catch (error) {
      toast(`Не удалось получить User ID: ${safeError(error)}`, 'bad');
    }
  });
}

async function reconnectRpc() {
  await withBusy($('reconnectRpcBtn'), 'Подключаю…', async () => {
    try {
      const result = await taro.reconnectRpc();
      if (result?.snapshot) handleState(result.snapshot);
      toast('RPC переподключается', 'good');
    } catch (error) {
      toast(`Не удалось переподключить RPC: ${safeError(error)}`, 'bad');
    }
  });
}

async function reconnectBot() {
  await withBusy($('reconnectBotBtn'), 'Подключаю…', async () => {
    try {
      const result = await taro.reconnectBot();
      if (result?.snapshot) handleState(result.snapshot);
      toast(form?.discord?.autoVoice ? 'Бот перезапущен' : 'Авто-войс выключен', 'good');
    } catch (error) {
      toast(`Не удалось перезапустить бота: ${safeError(error)}`, 'bad');
    }
  });
}

async function refreshVoice() {
  await withBusy($('refreshVoiceBtn'), 'Обновляю…', async () => {
    try {
      const result = await taro.refreshVoice();
      if (result?.snapshot) handleState(result.snapshot);
      if (result?.ok === false) toast(result.error || 'Не удалось обновить войс', 'bad');
      else toast('Войс обновлён', 'good');
    } catch (error) {
      toast(`Не удалось обновить войс: ${safeError(error)}`, 'bad');
    }
  });
}

async function quickRefresh() {
  await withBusy($('quickRefreshBtn'), 'Обновляю…', async () => {
    const saved = await saveForm({ quiet: true });
    if (saved?.ok === false) return;
    try {
      const result = await taro.apply();
      if (result?.snapshot) handleState(result.snapshot);
      toast('Presence и войс обновлены', 'good');
    } catch (error) {
      toast(`Не удалось обновить: ${safeError(error)}`, 'bad');
    }
  });
}

async function resetConfig() {
  try {
    const result = await taro.resetConfig();
    if (!result?.ok) return;
    dirty.clear();
    pendingGif = null;
    $('pickedGifName').textContent = '';
    if (result.snapshot) {
      latest = result.snapshot;
      lastConfigSignature = JSON.stringify(result.snapshot.config);
      applyConfigToForm(result.snapshot.config);
      handleState(result.snapshot);
    }
    toast('Настройки сброшены', 'good');
  } catch (error) {
    toast(`Не удалось сбросить: ${safeError(error)}`, 'bad');
  }
}

async function openCurrentGif() {
  const url = String($('gifUrl').value || '').trim();
  if (!url) {
    toast('Ссылка на GIF пустая', 'bad');
    return;
  }
  await taro.openUrl(url);
}

async function clearLogs() {
  try {
    const result = await taro.clearLogs();
    if (result?.snapshot) handleState(result.snapshot);
    toast('Логи очищены', 'good');
  } catch (error) {
    toast(`Не удалось очистить логи: ${safeError(error)}`, 'bad');
  }
}

function toggleTokenVisibility() {
  const input = $('botToken');
  const button = $('tokenToggle');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  button.textContent = show ? 'Скрыть' : 'Показать';
}

function bindStaticEvents() {
  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  });

  const on = (id, handler) => {
    const element = $(id);
    if (element) element.addEventListener('click', handler);
  };

  on('hideBtn', () => taro.hideWindow());
  on('hideToTrayBtn', () => taro.hideWindow());
  on('trayBtn', () => taro.hideWindow());
  on('quitBtn', () => taro.quit());

  on('setupOpenBtn', () => switchTab('help'));
  on('setupPortalBtn', openDevPortal);
  on('openPortalBtn', openDevPortal);
  on('helpPortalBtn', openDevPortal);
  on('openAdvancedFromLogs', () => switchTab('advanced'));

  on('inviteBotBtn', openInvite);
  on('helpInviteBtn', openInvite);
  on('copyInviteBtn', copyInvite);
  on('helpCopyInviteBtn', copyInvite);

  on('useRpcUserBtn', useRpcUser);
  on('reconnectRpcBtn', reconnectRpc);
  on('reconnectBotBtn', reconnectBot);
  on('refreshVoiceBtn', refreshVoice);
  on('tokenToggle', toggleTokenVisibility);

  on('quickStartBtn', () => runTimer(taro.startTimer, 'start'));
  on('quickStopBtn', () => runTimer(taro.stopTimer, 'stop'));
  on('quickRefreshBtn', quickRefresh);
  on('startTimerBtn', () => runTimer(taro.startTimer, 'start'));
  on('stopTimerBtn', () => runTimer(taro.stopTimer, 'stop'));
  on('resetTimerBtn', () => runTimer(taro.resetTimer, 'reset'));

  on('pickGifBtn', pickGifFile);
  on('uploadGifBtn', uploadPickedGif);
  on('sampleGifBtn', uploadSampleGif);
  on('testGifBtn', testGifUrl);
  on('openCurrentGifBtn', openCurrentGif);

  on('saveAsPresetBtn', saveAsPreset);
  on('addPresetBtn', addPreset);
  on('presetTabApplyBtn', applyPresetFromTab);

  on('saveBtn', () => saveForm());
  on('applyActivityBtn', () => saveForm());
  on('applyAllBtn', () => withBusy($('applyAllBtn'), 'Применяю…', applyNow));

  on('openConfigFolderBtn', () => taro.openConfigFolder());
  on('showLogsBtn', () => taro.showLogs());
  on('clearLogsBtn', clearLogs);
  on('resetConfigBtn', resetConfig);

  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveForm();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      applyNow();
    }
  });
}

/* -------------------------------------------------------------------- init */

async function init() {
  if (!taro) {
    document.body.textContent = 'Ошибка: preload-скрипт не загрузился. Перезапусти приложение.';
    return;
  }

  bindFields();
  bindStaticEvents();
  startTicker();
  switchTab('main');

  $('previewImage').addEventListener('load', () => {
    $('previewImage').hidden = false;
    $('previewImagePlaceholder').hidden = true;
  });
  $('previewImage').addEventListener('error', () => {
    $('previewImage').hidden = true;
    $('previewImagePlaceholder').hidden = false;
    $('previewImagePlaceholder').textContent = 'GIF';
    $('previewGifBadge').hidden = true;
  });

  taro.onState((data) => {
    try {
      handleState(data);
    } catch (error) {
      console.error('state render failed', error);
    }
  });
  taro.onFocusTab((tab) => switchTab(tab));
  taro.onFocusField((id) => focusFieldById(id));

  try {
    const data = await taro.getState();
    handleState(data);
  } catch (error) {
    toast(`Не удалось загрузить состояние: ${safeError(error)}`, 'bad', 6000);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
