/*
 * МурКотик — маленький сервер на Node.js без зовнішніх залежностей.
 * /api/cat             — випадковий котик із TheCatAPI
 * /api/dog             — випадковий песик із TheDogAPI
 * /api/chicken-photo   — пряме завантаження курки або півня з Wikimedia CDN
 * /api/photo/:id       — фото котика, ?download=1 — завантаження
 * /api/dog-photo/:id   — фото песика, ?download=1 — завантаження
 */
'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ROOT = __dirname;
const API_BASE = { cat: 'https://api.thecatapi.com/v1/images', dog: 'https://api.thedogapi.com/v1/images' };
const photoUrls = new Map();
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

const staticPages = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/dog.html', ['dog.html', 'text/html; charset=utf-8']],
  ['/chicken.html', ['chicken.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/script.js', ['script.js', 'application/javascript; charset=utf-8']],
  ['/dog.js', ['dog.js', 'application/javascript; charset=utf-8']],
  ['/chicken.js', ['chicken.js', 'application/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

async function readRemoteJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: { Accept: 'application/json', 'User-Agent': 'MurrCat/1.0' },
  });
  if (!response.ok) throw new Error(`Animal API: HTTP ${response.status}`);
  return response.json();
}

function safePhotoUrl(input, type) {
  const url = new URL(input);
  // Не дозволяємо передати довільну адресу на наш сервер (захист проксі).
  const domain = type === 'dog' ? 'thedogapi.com' : 'thecatapi.com';
  if (url.protocol !== 'https:' || !(url.hostname === domain || url.hostname.endsWith('.' + domain))) {
    throw new Error('Непідтримуване джерело зображення');
  }
  return url.toString();
}

function rememberPhoto(type, id, url) {
  photoUrls.set(`${type}:${id}`, safePhotoUrl(url, type));
  if (photoUrls.size > 200) photoUrls.delete(photoUrls.keys().next().value);
}

async function animalHandler(res, type) {
  const data = await readRemoteJson(`${API_BASE[type]}/search?limit=1&mime_types=jpg,png`);
  const animal = Array.isArray(data) && data[0];
  if (!animal || !ID_PATTERN.test(animal.id) || typeof animal.url !== 'string') {
    throw new Error(`${type} API повернув некоректні дані`);
  }
  rememberPhoto(type, animal.id, animal.url);
  sendJson(res, 200, { id: animal.id, width: animal.width ?? null, height: animal.height ?? null });
}

async function photoHandler(res, id, download, kind) {
  if (!ID_PATTERN.test(id)) {
    sendJson(res, 400, { error: 'Неправильний код фотографії' });
    return;
  }

  const key = `${kind}:${id}`;
  let url = photoUrls.get(key);
  if (!url) {
    // Відновлює улюблені фото з API після перезапуску Render.
    const animal = await readRemoteJson(`${API_BASE[kind]}/${encodeURIComponent(id)}`);
    if (!animal || !animal.url) {
      sendJson(res, 404, { error: 'Фото не знайдено' });
      return;
    }
    rememberPhoto(kind, id, animal.url);
    url = photoUrls.get(key);
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(22000),
    headers: { Accept: 'image/*', 'User-Agent': 'MurrCat/1.0' },
  });
  if (!response.ok || !response.body) throw new Error(`Зображення недоступне: ${response.status}`);

  const receivedType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  const supported = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  let type = receivedType;
  if (!(type in supported)) {
    // Деякі CDN віддають картинку як application/octet-stream.
    const match = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif)$/i);
    const ext = match && match[1].toLowerCase();
    type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext ? `image/${ext}` : '';
  }
  if (!(type in supported)) {
    await response.body.cancel();
    throw new Error('Сервер фотографій надіслав непідтримуваний формат');
  }

  const headers = {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': download ? 'no-store' : 'public, max-age=86400',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${kind === 'dog' ? 'pesyk' : 'kotyk'}-${id}.${supported[type]}"`,
  };
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength)) headers['Content-Length'] = contentLength;

  res.writeHead(200, headers);
  await pipeline(Readable.fromWeb(response.body), res);
}

async function chickenPhotoHandler(res, rawSrc, download, method) {
  if (!rawSrc || rawSrc.length > 2048) {
    sendJson(res, 400, { error: 'Невірне посилання на фото' });
    return;
  }
  let src;
  try { src = new URL(rawSrc); } catch {
    sendJson(res, 400, { error: 'Невірне посилання на фото' });
    return;
  }
  // Strict allow-list prevents the server from becoming an open proxy / SSRF.
  if (src.protocol !== 'https:' || src.hostname !== 'upload.wikimedia.org' ||
      src.port || src.username || src.password ||
      !src.pathname.startsWith('/wikipedia/commons/')) {
    sendJson(res, 400, { error: 'Дозволені лише зображення Wikimedia Commons' });
    return;
  }

  const response = await fetch(src, {
    method: method === 'HEAD' ? 'HEAD' : 'GET',
    signal: AbortSignal.timeout(22000),
    headers: { Accept: 'image/*', 'User-Agent': 'MurrCat/1.1 (personal animal photo browser)' },
  });
  const redirectedTo = new URL(response.url);
  if (redirectedTo.hostname !== 'upload.wikimedia.org' || redirectedTo.protocol !== 'https:') {
    if (response.body) await response.body.cancel();
    sendJson(res, 502, { error: 'Непідтримуване перенаправлення джерела' });
    return;
  }
  if (!response.ok || (method !== 'HEAD' && !response.body)) {
    if (response.body) await response.body.cancel();
    throw new Error(`Wikimedia CDN: HTTP ${response.status}`);
  }

  const mime = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  if (!extensions[mime]) {
    if (response.body) await response.body.cancel();
    sendJson(res, 415, { error: 'Непідтримуваний тип зображення' });
    return;
  }
  const length = response.headers.get('content-length');
  if (length && Number(length) > 25 * 1024 * 1024) {
    if (response.body) await response.body.cancel();
    sendJson(res, 413, { error: 'Зображення занадто велике для завантаження' });
    return;
  }

  const headers = {
    'Content-Type': mime,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': download ? 'no-store' : 'public, max-age=3600',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="pivnyk-abo-kurochka.${extensions[mime]}"`,
  };
  if (length && /^\d+$/.test(length)) headers['Content-Length'] = length;
  res.writeHead(200, headers);
  if (method === 'HEAD') { res.end(); return; }
  await pipeline(Readable.fromWeb(response.body), res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Метод не підтримується' });
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('OK');
      return;
    }
    if (url.pathname === '/api/chicken-photo') {
      await chickenPhotoHandler(res, url.searchParams.get('src'), url.searchParams.get('download') === '1', req.method);
      return;
    }
    if (url.pathname === '/api/cat' || url.pathname === '/api/dog') {
      await animalHandler(res, url.pathname === '/api/dog' ? 'dog' : 'cat');
      return;
    }
    if (url.pathname.startsWith('/api/photo/') || url.pathname.startsWith('/api/dog-photo/')) {
      const dog = url.pathname.startsWith('/api/dog-photo/');
      const id = url.pathname.slice(dog ? '/api/dog-photo/'.length : '/api/photo/'.length);
      await photoHandler(res, id, url.searchParams.get('download') === '1', dog ? 'dog' : 'cat');
      return;
    }
    const file = staticPages.get(url.pathname);
    if (file) {
      const [filename, contentType] = file;
      const bytes = await fs.readFile(path.join(ROOT, filename));
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': bytes.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
      return;
    }
    sendJson(res, 404, { error: 'Сторінку не знайдено' });
  } catch (error) {
    console.error('Помилка запиту:', req.url, error.message);
    if (!res.headersSent) {
      sendJson(res, 502, { error: 'Не вдалося отримати фото. Спробуй ще раз.' });
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`🐈 МурКотик запущено: http://localhost:${PORT}`);
});
