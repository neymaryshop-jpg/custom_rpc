'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isHttpsUrl } = require('./util');

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const CATBOX_ENDPOINT = 'https://catbox.moe/user/api.php';

const MIME_BY_EXTENSION = {
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
};

function mimeForFile(filePath) {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function validateImageUrl(url, { timeoutMs = 15_000 } = {}) {
  if (!isHttpsUrl(url)) {
    return { ok: false, message: 'Нужна публичная https:// ссылка.' };
  }

  const headers = { 'User-Agent': 'Mozilla/5.0 (TaroRPC/1.0)' };
  let response = null;
  let method = 'HEAD';

  try {
    response = await fetch(url, {
      method,
      redirect: 'follow',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok || response.status === 405) {
      method = 'GET';
      response = await fetch(url, {
        method,
        redirect: 'follow',
        headers: { ...headers, Range: 'bytes=0-1024' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
  } catch (error) {
    return { ok: false, message: `Не удалось открыть ссылку: ${error.message}` };
  }

  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const contentLength = Number(response.headers.get('content-length') || 0);
  try {
    await response.body?.cancel?.();
  } catch {
    // The body is not needed; we only validate headers.
  }
  if (!contentType.startsWith('image/')) {
    return {
      ok: false,
      status: response.status,
      contentType,
      message: `Сервер вернул «${contentType || 'неизвестный тип'}», а не картинку.`,
    };
  }
  if (contentLength > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      status: response.status,
      contentType,
      size: contentLength,
      message: 'Файл больше 25 МБ — Discord может не загрузить его.',
    };
  }

  return {
    ok: true,
    status: response.status,
    contentType,
    size: contentLength,
    animated: contentType === 'image/gif' || contentType === 'image/webp' || contentType === 'image/avif',
    message: 'Ссылка доступна, Discord сможет её загрузить.',
  };
}

async function uploadFileToCatbox(filePath) {
  const stats = await fs.promises.stat(filePath);
  if (!stats.isFile()) throw new Error('Это не файл.');
  if (stats.size > MAX_UPLOAD_BYTES) throw new Error('Файл больше 25 МБ.');
  if (!MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()]) {
    throw new Error('Поддерживаются GIF, WebP, PNG, JPG и AVIF.');
  }

  const buffer = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', new Blob([buffer], { type: mimeForFile(filePath) }), path.basename(filePath));

  const response = await fetch(CATBOX_ENDPOINT, {
    method: 'POST',
    body: form,
    headers: { 'User-Agent': 'TaroRPC/1.0' },
    signal: AbortSignal.timeout(90_000),
  });

  const text = (await response.text()).trim();
  if (!response.ok || !isHttpsUrl(text)) {
    throw new Error(text || `catbox.moe вернул HTTP ${response.status}`);
  }
  return { url: text, size: stats.size };
}

module.exports = {
  MAX_UPLOAD_BYTES,
  uploadFileToCatbox,
  validateImageUrl,
};
