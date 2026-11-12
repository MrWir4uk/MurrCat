/*
 * МурКотик — маленький сервер на Node.js без зовнішніх залежностей.
 * /api/cat               — випадковий котик із TheCatAPI
 * /api/dog               — випадковий песик із TheDogAPI
 * /api/chicken           — випадкова курка або півень із Wikimedia Commons
 * /api/photo/:id         — фото котика, ?download=1 — завантаження
 * /api/dog-photo/:id     — фото песика, ?download=1 — завантаження
 * /api/chicken-photo/:id — фото курки/півня, ?download=1 — завантаження
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
const WIKIMEDIA_API = 'https://commons.wikimedia.org/w/api.php';
const WIKIMEDIA_FILE_HOST = 'upload.wikimedia.org';
const CHICKEN_CATEGORIES = ['Category:Hens', 'Category:Roosters'];
const photoUrls = new Map();
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,160}$/;

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
  if (type === 'chicken') {
    if (url.protocol !== 'https:' || !(url.hostname === WIKIMEDIA_FILE_HOST || url.hostname.endsWith('.' + WIKIMEDIA_FILE_HOST))) {
      throw new Error('Непідтримуване джерело зображення');
    }
    return url.toString();
  }
  const domain = type === 'dog' ? 'thedogapi.com' : 'thecatapi.com';
  if (url.protocol !== 'https:' || !(url.hostname === domain || url.hostname.endsWith('.' + domain))) {
    throw new Error('Непідтримуване джерело зображення');
  }
  return url.toString();
}

function rememberPhoto(type, id, url) {
  photoUrls.set(`${type}:${id}`, safePhotoUrl(url, type));
  if (photoUrls.size > 300) photoUrls.delete(photoUrls.keys().next().value);
}

function encodeMediaId(title) {
  return Buffer.from(title, 'utf8').toString('base64url');
}

function decodeMediaId(id) {
  return Buffer.from(id, 'base64url').toString('utf8');
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

async function readWikimediaJson(params) {
  const query = new URLSearchParams({ format: 'json', origin: '*', ...params });
  return readRemoteJson(`${WIKIMEDIA_API}?${query.toString()}`);
}

function randomPick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

async function loadChickenOrRooster() {
  const category = randomPick(CHICKEN_CATEGORIES);
  const membersData = await readWikimediaJson({
    action: 'query',
    list: 'categorymembers',
    cmtitle: category,
    cmtype: 'file',
    cmlimit: '50',
  });
  const members = membersData?.query?.categorymembers;
  if (!Array.isArray(members) || !members.length) throw new Error('Wikimedia не повернула файлів');

  const member = randomPick(members.filter((item) => typeof item?.title === 'string' && item.title.startsWith('File:')));
  if (!member) throw new Error('Немає доступних фото');

  const imageData = await readWikimediaJson({
    action: 'query',
    titles: member.title,
    prop: 'imageinfo',
    iiprop: 'url|size',
  });

  const pages = imageData?.query?.pages || {};
  const page = Object.values(pages)[0];
  const info = page?.imageinfo?.[0];
  if (!info?.url) throw new Error('Фото з Wikimedia недоступне');

  const id = encodeMediaId(member.title);
  rememberPhoto('chicken', id, info.url);
  return { id, width: info.width ?? null, height: info.height ?? null };
}

async function chickenHandler(res) {
  const data = await loadChickenOrRooster();
  sendJson(res, 200, data);
}

async function recoverWikimediaPhoto(id) {
  const title = decodeMediaId(id);
  if (!title.startsWith('File:')) throw new Error('Неправильний код фотографії');
  const imageData = await readWikimediaJson({
    action: 'query',
    titles: title,
    prop: 'imageinfo',
    iiprop: 'url|size',
  });
  const pages = imageData?.query?.pages || {};
  const page = Object.values(pages)[0];
  const info = page?.imageinfo?.[0];
  if (!info?.url) return null;
  rememberPhoto('chicken', id, info.url);
  return photoUrls.get(`chicken:${id}`);
}

async function photoHandler(res, id, download, kind) {
  if (!ID_PATTERN.test(id)) {
    sendJson(res, 400, { error: 'Неправильний код фотографії' });
    return;
  }

  const key = `${kind}:${id}`;
  let url = photoUrls.get(key);
  if (!url) {
    if (kind === 'chicken') {
      url = await recoverWikimediaPhoto(id);
      if (!url) {
        sendJson(res, 404, { error: 'Фото не знайдено' });
        return;
      }
    } else {
      const animal = await readRemoteJson(`${API_BASE[kind]}/${encodeURIComponent(id)}`);
      if (!animal || !animal.url) {
        sendJson(res, 404, { error: 'Фото не знайдено' });
        return;
      }
      rememberPhoto(kind, id, animal.url);
      url = photoUrls.get(key);
    }
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
    const match = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif)$/i);
    const ext = match && match[1].toLowerCase();
    type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext ? `image/${ext}` : '';
  }
  if (!(type in supported)) {
    await response.body.cancel();
    throw new Error('Сервер фотографій надіслав непідтримуваний формат');
  }

  const names = { cat: 'kotyk', dog: 'pesyk', chicken: 'kurochka' };
  const headers = {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': download ? 'no-store' : 'public, max-age=86400',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${names[kind] || 'animal'}-${id}.${supported[type]}"`,
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
    if (url.pathname === '/api/cat' || url.pathname === '/api/dog' || url.pathname === '/api/chicken') {
      if (url.pathname === '/api/chicken') {
        await chickenHandler(res);
      } else {
        await animalHandler(res, url.pathname === '/api/dog' ? 'dog' : 'cat');
      }
      return;
    }
    if (url.pathname.startsWith('/api/photo/') || url.pathname.startsWith('/api/dog-photo/') || url.pathname.startsWith('/api/chicken-photo/')) {
      const dog = url.pathname.startsWith('/api/dog-photo/');
      const chicken = url.pathname.startsWith('/api/chicken-photo/');
      const id = url.pathname.slice(chicken ? '/api/chicken-photo/'.length : dog ? '/api/dog-photo/'.length : '/api/photo/'.length);
      await photoHandler(res, id, url.searchParams.get('download') === '1', chicken ? 'chicken' : dog ? 'dog' : 'cat');
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
