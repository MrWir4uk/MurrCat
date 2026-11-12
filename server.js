/*
 * МурКотик — маленький сервер на Node.js без зовнішніх залежностей.
 * /api/cat          — випадковий котик із TheCatAPI
 * /api/photo/:id    — показ фото (той самий домен, працює на телефоні)
 * /api/photo/:id?download=1 — завантаження оригінального файлу
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
const API_BASE = 'https://api.thecatapi.com/v1/images';
const photoUrls = new Map();
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

const staticPages = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/script.js', ['script.js', 'application/javascript; charset=utf-8']],
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
  if (!response.ok) throw new Error(`TheCatAPI: HTTP ${response.status}`);
  return response.json();
}

function safePhotoUrl(input) {
  const url = new URL(input);
  // Адресу отримуємо від TheCatAPI, але обмежуємо домен, щоб сервер не
  // перетворився на відкритий проксі для довільних сайтів.
  if (url.protocol !== 'https:' || !(url.hostname === 'thecatapi.com' || url.hostname.endsWith('.thecatapi.com'))) {
    throw new Error('Непідтримуване джерело зображення');
  }
  return url.toString();
}

function rememberPhoto(id, url) {
  photoUrls.set(id, safePhotoUrl(url));
  if (photoUrls.size > 200) photoUrls.delete(photoUrls.keys().next().value);
}

async function catHandler(res) {
  const data = await readRemoteJson(`${API_BASE}/search?limit=1&mime_types=jpg,png`);
  const cat = Array.isArray(data) && data[0];
  if (!cat || !ID_PATTERN.test(cat.id) || typeof cat.url !== 'string') {
    throw new Error('TheCatAPI повернув некоректні дані');
  }
  rememberPhoto(cat.id, cat.url);
  sendJson(res, 200, { id: cat.id, width: cat.width ?? null, height: cat.height ?? null });
}

async function photoHandler(res, id, download) {
  if (!ID_PATTERN.test(id)) {
    sendJson(res, 400, { error: 'Неправильний код фотографії' });
    return;
  }

  let url = photoUrls.get(id);
  if (!url) {
    // Завдяки цьому збережені улюблені фото працюють навіть після перезапуску Render.
    const cat = await readRemoteJson(`${API_BASE}/${encodeURIComponent(id)}`);
    if (!cat || !cat.url) {
      sendJson(res, 404, { error: 'Котика не знайдено' });
      return;
    }
    rememberPhoto(id, cat.url);
    url = photoUrls.get(id);
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
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="kotyk-${id}.${supported[type]}"`,
  };
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength)) headers['Content-Length'] = contentLength;

  res.writeHead(200, headers);
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
    if (url.pathname === '/api/cat') {
      await catHandler(res);
      return;
    }
    if (url.pathname.startsWith('/api/photo/')) {
      const id = url.pathname.slice('/api/photo/'.length);
      await photoHandler(res, id, url.searchParams.get('download') === '1');
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
