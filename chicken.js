/* МурКотик — Кури / Півні: генерація фото, історія, зум та завантаження. */
(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const elements = {
    stage: $('#photo-stage'),
    placeholder: $('#photo-placeholder'),
    picture: $('#cat-image'),
    loading: $('#loading-overlay'),
    openViewer: $('#open-viewer'),
    newCat: $('#new-cat'),
    download: $('#download-cat'),
    favorite: $('#favorite-cat'),
    number: $('#cat-number'),
    status: $('#status-text'),
    gallery: $('#gallery'),
    galleryCount: $('#collection-count'),
    recentTab: $('#tab-recent'),
    favoritesTab: $('#tab-favorites'),
    viewer: $('#viewer'),
    viewerArea: $('#viewer-area'),
    viewerImage: $('#viewer-image'),
    viewerClose: $('#viewer-close'),
    viewerZoomOut: $('#zoom-out'),
    viewerZoomIn: $('#zoom-in'),
    viewerZoomReset: $('#zoom-reset'),
    viewerDownload: $('#viewer-download'),
    viewerClean: $('#viewer-clean'),
    viewerRestore: $('#viewer-restore'),
    viewerTip: $('#viewer-tip'),
  };

  // The Commons API is called from the visitor's browser, not from a shared Render IP.
  // We fetch batches once per day, then pick locally without a new API call per click.
  const STORAGE_RECENT = 'murrcat-chickens-recent-v1';
  const STORAGE_FAVORITES = 'murrcat-chickens-favorites-v1';
  const STORAGE_POOL = 'murrcat-poultry-photo-pool-v2';
  const MAX_RECENT = 18;
  const MAX_FAVORITES = 40;
  const POOL_TTL = 24 * 60 * 60 * 1000;
  const RETRY_DELAY = 2 * 60 * 1000;

  function validId(src) {
    if (typeof src !== 'string' || src.length > 2000) return false;
    try {
      const url = new URL(src);
      return url.protocol === 'https:' &&
        url.hostname === 'upload.wikimedia.org' &&
        url.pathname.startsWith('/wikipedia/commons/');
    } catch {
      return false;
    }
  }

  function readSaved(key, max) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      if (!Array.isArray(value)) return [];
      return [...new Set(value.filter(validId))].slice(0, max);
    } catch {
      return [];
    }
  }

  function save(key, values) {
    try { localStorage.setItem(key, JSON.stringify(values)); } catch { /* Приватний режим браузера */ }
  }

  function readPool() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_POOL) || 'null');
      if (!saved || !Array.isArray(saved.photos)) return { photos: [], savedAt: 0 };
      return {
        photos: [...new Set(saved.photos.filter(validId))].slice(0, 120),
        savedAt: Number(saved.savedAt) || 0,
      };
    } catch {
      return { photos: [], savedAt: 0 };
    }
  }

  const stored = readPool();
  let photoPool = stored.photos;
  let poolSavedAt = stored.savedAt;
  let poolPromise = null;
  let retryAt = 0;

  async function fetchCategory(title) {
    // generator=categorymembers + imageinfo returns up to 50 actual image URLs
    // in one request, with official MediaWiki API CORS (origin=*).
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      origin: '*',
      generator: 'categorymembers',
      gcmtitle: title,
      gcmtype: 'file',
      gcmlimit: '50',
      prop: 'imageinfo',
      iiprop: 'url|mime|size',
    });
    const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
      cache: 'default',
      signal: AbortSignal.timeout(13000),
    });
    if (!response.ok) throw new Error(`Wikimedia: HTTP ${response.status}`);
    const data = await response.json();
    const pages = Object.values(data?.query?.pages || {});
    return pages.map((page) => page?.imageinfo?.[0]).filter((item) =>
      item && ['image/jpeg', 'image/png', 'image/webp'].includes(item.mime) &&
      validId(item.url) && (item.width || 0) >= 400 && (item.height || 0) >= 300
    ).map((item) => item.url);
  }

  async function refreshPool() {
    // Only 2 API requests to build an entire gallery, not 2 per photo.
    const results = await Promise.allSettled([
      fetchCategory('Category:Hens'),
      fetchCategory('Category:Roosters'),
    ]);
    let fetched = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);

    // Fallback category if both narrow categories have no usable photos.
    if (!fetched.length) {
      try { fetched = await fetchCategory('Category:Chickens'); } catch { /* Keep cached photos */ }
    }
    if (fetched.length) {
      photoPool = [...new Set([...fetched, ...photoPool])].slice(0, 120);
      poolSavedAt = Date.now();
      try { localStorage.setItem(STORAGE_POOL, JSON.stringify({ photos: photoPool, savedAt: poolSavedAt })); } catch { /* no storage */ }
    } else {
      retryAt = Date.now() + RETRY_DELAY;
      if (!photoPool.length) throw new Error('Wikimedia зараз обмежує запити (429) або не має доступних фото');
    }
    return photoPool;
  }

  async function ensurePool() {
    const fresh = photoPool.length && Date.now() - poolSavedAt < POOL_TTL;
    if (fresh) return photoPool;
    if (retryAt && Date.now() < retryAt) {
      if (photoPool.length) return photoPool;
      throw new Error('Спробуй трохи пізніше — тимчасовий ліміт Wikimedia');
    }
    if (!poolPromise) poolPromise = refreshPool().finally(() => { poolPromise = null; });
    try {
      await poolPromise;
    } catch (error) {
      if (!photoPool.length) throw error;
    }
    return photoPool;
  }

  let recent = readSaved(STORAGE_RECENT, MAX_RECENT);
  let favorites = readSaved(STORAGE_FAVORITES, MAX_FAVORITES);
  let currentId = null;
  let selectedTab = 'recent';
  let requestInProgress = false;
  let generatedCount = 0;

  // Images are displayed directly from Wikimedia's CDN. Render is used only
  // for the attachment/download response, so its Wikimedia API 429 goes away.
  function photoUrl(src) { return src; }
  function downloadUrl(src) { return `/api/chicken-photo?src=${encodeURIComponent(src)}&download=1`; }

  function setMessage(message, error = false) {
    elements.status.textContent = message;
    elements.status.classList.toggle('is-error', error);
  }

  function setBusy(busy) {
    requestInProgress = busy;
    elements.newCat.disabled = busy;
    elements.loading.hidden = !busy;
    elements.stage.setAttribute('aria-busy', String(busy));
  }

  function updateFavoriteButton() {
    const isFavorite = Boolean(currentId && favorites.includes(currentId));
    elements.favorite.disabled = !currentId;
    elements.favorite.classList.toggle('is-favorite', isFavorite);
    elements.favorite.setAttribute('aria-pressed', String(isFavorite));
    elements.favorite.setAttribute('aria-label', isFavorite ? 'Прибрати фото з улюблених' : 'Додати фото в улюблені');
  }

  function showCat(id) {
    if (!validId(id)) return;
    currentId = id;
    elements.picture.src = photoUrl(id);
    elements.picture.alt = 'Фото випадкової курки або півня';
    elements.picture.hidden = false;
    elements.placeholder.hidden = true;
    elements.openViewer.hidden = false;
    elements.download.disabled = false;
    elements.number.textContent = `#${String(Math.max(1, generatedCount)).padStart(3, '0')}`;
    updateFavoriteButton();
    renderGallery();
    setMessage('Торкнися фото, щоб розгорнути. Можна збільшувати двома пальцями 🔍');
  }

  function showPhotoError() {
    if (!currentId) return;
    setMessage('Не вдалося показати це фото. Спробуй згенерувати наступне.', true);
  }

  elements.picture.addEventListener('error', showPhotoError);

  function preloadPhoto(id) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = resolve;
      img.onerror = () => reject(new Error('Фото не завантажилося'));
      img.src = photoUrl(id);
    });
  }

  async function getNewCat() {
    if (requestInProgress) return;
    setBusy(true);
    setMessage('Шукаємо курочку або півня...');

    try {
      const photos = await ensurePool();
      if (!photos.length) throw new Error('Добірка фотографій поки порожня');
      // Pick another photo if possible; retry if a Wikimedia file was removed.
      const candidates = photos.filter((src) => src !== currentId);
      const list = [...(candidates.length ? candidates : photos)];
      let chosen = null;
      for (let attempt = 0; attempt < Math.min(4, list.length); attempt += 1) {
        const index = Math.floor(Math.random() * list.length);
        const src = list.splice(index, 1)[0];
        try {
          await preloadPhoto(src);
          chosen = src;
          break;
        } catch { /* Try another photo */ }
      }
      if (!chosen) throw new Error('Зображення із Wikimedia зараз не завантажуються');
      generatedCount += 1;
      recent = [chosen, ...recent.filter((id) => id !== chosen)].slice(0, MAX_RECENT);
      save(STORAGE_RECENT, recent);
      showCat(chosen);
    } catch (error) {
      console.error('Не вдалося завантажити курку або півня:', error);
      setMessage('Фото тимчасово недоступні. Якщо Wikimedia обмежує запити, спробуй ще раз пізніше 🐔', true);
      if (!currentId) elements.placeholder.querySelector('span:last-child').textContent = 'Спробуй ще раз трохи пізніше.';
    } finally {
      setBusy(false);
    }
  }

  function downloadCurrent() {
    if (!currentId) return;
    // Render лише передає файл із Wikimedia CDN для завантаження,
    // API Wikimedia із Render більше не використовується.
    const link = document.createElement('a');
    link.href = downloadUrl(currentId);
    link.download = 'kurochka.jpg';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function toggleFavorite() {
    if (!currentId) return;
    if (favorites.includes(currentId)) {
      favorites = favorites.filter((id) => id !== currentId);
    } else {
      favorites = [currentId, ...favorites].slice(0, MAX_FAVORITES);
    }
    save(STORAGE_FAVORITES, favorites);
    updateFavoriteButton();
    renderGallery();
  }

  function changeTab(tab) {
    selectedTab = tab;
    const isRecent = tab === 'recent';
    elements.recentTab.classList.toggle('is-active', isRecent);
    elements.favoritesTab.classList.toggle('is-active', !isRecent);
    elements.recentTab.setAttribute('aria-selected', String(isRecent));
    elements.favoritesTab.setAttribute('aria-selected', String(!isRecent));
    elements.gallery.setAttribute('aria-labelledby', isRecent ? 'tab-recent' : 'tab-favorites');
    renderGallery();
  }

  function renderGallery() {
    const ids = selectedTab === 'recent' ? recent : favorites;
    elements.galleryCount.textContent = String(ids.length);
    const fragment = document.createDocumentFragment();

    if (ids.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'gallery-empty';
      const emoji = document.createElement('span');
      emoji.className = 'empty-emoji';
      emoji.textContent = selectedTab === 'recent' ? '🐾' : '💌';
      const title = document.createElement('strong');
      title.textContent = selectedTab === 'recent' ? 'Поки що порожньо' : 'Немає улюблених';
      const hint = document.createElement('span');
      hint.textContent = selectedTab === 'recent' ? 'Згенеруй пташку — і вона з’явиться тут.' : 'Натисни на серденько під фото пташки ♡';
      empty.append(emoji, title, hint);
      fragment.append(empty);
    } else {
      for (const id of ids) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `gallery-item${id === currentId ? ' is-current' : ''}`;
        button.setAttribute('aria-label', 'Показати збережене фото');
        const image = document.createElement('img');
        image.src = photoUrl(id);
        image.loading = 'lazy';
        image.alt = 'Мініатюра пташки';
        button.append(image);
        if (favorites.includes(id)) {
          const heart = document.createElement('span');
          heart.className = 'gallery-badge';
          heart.textContent = '♥';
          heart.setAttribute('aria-hidden', 'true');
          button.append(heart);
        }
        button.addEventListener('click', () => {
          showCat(id);
          // На телефоні повертаємо до великого фото.
          if (window.matchMedia('(max-width: 760px)').matches) {
            elements.stage.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        });
        fragment.append(button);
      }
    }
    elements.gallery.replaceChildren(fragment);
  }

  // ===== Перегляд на весь екран, масштаб +/- та жести на телефоні =====
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  const pointers = new Map();
  let oneFingerStart = null;
  let pinchStart = null;
  let gestureMoved = false;

  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

  function restrictPan() {
    const maxX = Math.max(0, (elements.viewerImage.clientWidth * zoom - elements.viewerArea.clientWidth) / 2);
    const maxY = Math.max(0, (elements.viewerImage.clientHeight * zoom - elements.viewerArea.clientHeight) / 2);
    panX = clamp(panX, -maxX, maxX);
    panY = clamp(panY, -maxY, maxY);
  }

  function drawZoom() {
    restrictPan();
    elements.viewerImage.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`;
    elements.viewerZoomReset.textContent = `${Math.round(zoom * 100)}%`;
  }

  function setZoom(nextZoom) {
    zoom = clamp(nextZoom, 1, 5);
    if (zoom === 1) { panX = 0; panY = 0; }
    drawZoom();
  }

  function setCleanMode(value) {
    elements.viewer.classList.toggle('is-clean', value);
    elements.viewerRestore.hidden = !value;
    elements.viewerTip.hidden = value;
    setZoom(1);
  }

  function openViewer() {
    if (!currentId || !elements.viewer.showModal) return;
    elements.viewerImage.src = photoUrl(currentId);
    elements.viewer.showModal();
    document.body.style.overflow = 'hidden';
    setCleanMode(false);
    elements.viewerClose.focus();
  }

  function closeViewer() { elements.viewer.close(); }

  function pointerDistance(items) {
    return Math.hypot(items[0].x - items[1].x, items[0].y - items[1].y);
  }

  function pointerCenter(items) {
    return { x: (items[0].x + items[1].x) / 2, y: (items[0].y + items[1].y) / 2 };
  }

  function beginGesture() {
    const points = [...pointers.values()];
    if (points.length >= 2) {
      const pair = points.slice(0, 2);
      pinchStart = {
        distance: Math.max(1, pointerDistance(pair)),
        center: pointerCenter(pair),
        zoom,
        x: panX,
        y: panY,
      };
      oneFingerStart = null;
    } else if (points.length === 1) {
      oneFingerStart = { x: points[0].x, y: points[0].y, panX, panY };
      pinchStart = null;
    } else {
      oneFingerStart = null;
      pinchStart = null;
    }
  }

  elements.viewerArea.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    elements.viewerArea.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    gestureMoved = false;
    beginGesture();
  });

  elements.viewerArea.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    const prev = pointers.get(event.pointerId);
    if (Math.abs(prev.x - event.clientX) + Math.abs(prev.y - event.clientY) > 4) gestureMoved = true;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.values()];

    if (points.length >= 2 && pinchStart) {
      const pair = points.slice(0, 2);
      const center = pointerCenter(pair);
      zoom = clamp(pinchStart.zoom * pointerDistance(pair) / pinchStart.distance, 1, 5);
      panX = pinchStart.x + center.x - pinchStart.center.x;
      panY = pinchStart.y + center.y - pinchStart.center.y;
      if (zoom === 1) { panX = 0; panY = 0; }
      drawZoom();
    } else if (points.length === 1 && oneFingerStart && zoom > 1) {
      panX = oneFingerStart.panX + event.clientX - oneFingerStart.x;
      panY = oneFingerStart.panY + event.clientY - oneFingerStart.y;
      drawZoom();
    }
  });

  function endPointer(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (pointers.size === 0 && !gestureMoved && elements.viewer.classList.contains('is-clean')) {
      setCleanMode(false);
    }
    beginGesture();
  }

  elements.viewerArea.addEventListener('pointerup', endPointer);
  elements.viewerArea.addEventListener('pointercancel', endPointer);
  elements.viewerArea.addEventListener('lostpointercapture', endPointer);
  elements.viewerArea.addEventListener('dblclick', (event) => {
    event.preventDefault();
    setZoom(zoom > 1 ? 1 : 2.5);
  });
  elements.viewerArea.addEventListener('wheel', (event) => {
    event.preventDefault();
    setZoom(zoom + (event.deltaY < 0 ? .2 : -.2));
  }, { passive: false });

  elements.viewer.addEventListener('close', () => {
    document.body.style.overflow = '';
    pointers.clear();
    setCleanMode(false);
    elements.viewerImage.src = '';
  });
  elements.viewer.addEventListener('cancel', () => { document.body.style.overflow = ''; });

  document.addEventListener('keydown', (event) => {
    if (!elements.viewer.open) return;
    if (event.key === '+' || event.key === '=') { event.preventDefault(); setZoom(zoom + .25); }
    if (event.key === '-' || event.key === '_') { event.preventDefault(); setZoom(zoom - .25); }
    if (event.key === '0') { event.preventDefault(); setZoom(1); }
    if (event.key.toLowerCase() === 'h') { event.preventDefault(); setCleanMode(!elements.viewer.classList.contains('is-clean')); }
  });

  elements.newCat.addEventListener('click', getNewCat);
  elements.download.addEventListener('click', downloadCurrent);
  elements.favorite.addEventListener('click', toggleFavorite);
  elements.recentTab.addEventListener('click', () => changeTab('recent'));
  elements.favoritesTab.addEventListener('click', () => changeTab('favorites'));
  elements.openViewer.addEventListener('click', openViewer);
  elements.picture.addEventListener('click', openViewer);
  elements.viewerClose.addEventListener('click', closeViewer);
  elements.viewerZoomIn.addEventListener('click', () => setZoom(zoom + .25));
  elements.viewerZoomOut.addEventListener('click', () => setZoom(zoom - .25));
  elements.viewerZoomReset.addEventListener('click', () => setZoom(1));
  elements.viewerDownload.addEventListener('click', downloadCurrent);
  elements.viewerClean.addEventListener('click', () => setCleanMode(true));
  elements.viewerRestore.addEventListener('click', () => setCleanMode(false));
  window.addEventListener('resize', () => { if (elements.viewer.open) drawZoom(); });

  renderGallery();
  // Автоматично генеруємо першу пташку одразу після відкриття сайту.
  getNewCat();
})();
