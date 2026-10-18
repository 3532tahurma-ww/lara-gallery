const IS_LOCAL = /^(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(location.hostname);
const API = IS_LOCAL ? `${location.origin}/api` : 'https://api.github.com';
const PHOTO_DIR = 'photos';
const META_PATH = `${PHOTO_DIR}/albums.json`;
const MAX_SIDE = 2560;
const QUALITY = 0.86;
const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif)$/i;
const IMG_CACHE = 'lg-images';
const SHARE_CACHE = 'lg-share';
const HOME_PICKS = 4;
const FEED_BATCH = 6;
const GREETINGS = [
  'Bugün hangi anılara dönmek istersin?',
  'Bir fincan çay al, anılara dalalım.',
  'Küçük anılar, büyük gülümsemeler.',
  'Her fotoğrafın küçük bir hikâyesi var.',
];

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => s.toLocaleLowerCase('tr').trim();
const byTr = (a, b) => a.localeCompare(b, 'tr');
const isMobile = () => matchMedia('(max-width: 860px)').matches;
const dateFmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
const fullDateFmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const todayFmt = new Intl.DateTimeFormat('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });

const state = {
  photos: readCache('lg-photos', []),
  meta: readCache('lg-meta', {}),
  route: 'home', // home | albums | explore | album
  album: null, // album name on the album route, '' = photos without an album
  albumMap: new Map(),
  filter: { q: '', category: null, tags: new Set() },
  groupBy: readCache('lg-group', 'none'), // none | theme
  picks: null,
  heroPaths: null,
  feed: [],
  feedKey: null,
  feedShown: 0,
  view: [],
  index: -1,
  showInfo: false,
  uploading: false,
};
let config = loadConfig();
let uploadChain = Promise.resolve();

/* ---------- Config & storage ---------- */

function guessRepo() {
  if (IS_LOCAL) return { owner: 'local', repo: 'lara-gallery', token: 'dev' };
  const host = location.hostname;
  if (!host.endsWith('.github.io')) return { owner: '', repo: '' };
  const segment = location.pathname.split('/').filter(Boolean)[0];
  return { owner: host.split('.')[0], repo: segment || host };
}

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('lg-config')) || {}; } catch {}
  return { branch: 'main', token: '', ...guessRepo(), ...saved };
}

function readCache(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
}

function saveCache() {
  try {
    localStorage.setItem('lg-photos', JSON.stringify(state.photos));
    localStorage.setItem('lg-meta', JSON.stringify(state.meta));
  } catch {}
}

/* ---------- GitHub API ---------- */

async function gh(path, opts = {}) {
  const headers = { Accept: 'application/vnd.github+json', ...opts.headers };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  const res = await fetch(`${API}/repos/${config.owner}/${config.repo}${path}`, { ...opts, headers, cache: 'no-store' });
  if (!res.ok) {
    const err = new Error((await res.json().catch(() => ({}))).message || res.statusText);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

const utf8ToB64 = (text) => {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64ToUtf8 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

function photoUrl(path) {
  return IS_LOCAL
    ? `${location.origin}/${encodePath(path)}`
    : `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${encodeURIComponent(config.branch)}/${encodePath(path)}`;
}

// photos/<name> has no album, photos/<album>/<name> belongs to <album>.
function toPhoto({ path, sha, size }) {
  const parts = path.split('/');
  return { path, sha, size, name: parts.at(-1), album: parts.length > 2 ? parts[1] : '', url: photoUrl(path) };
}

const stamp = (p) => {
  const ts = Number(p.name.split('-')[0]);
  return ts > 1e12 ? ts : 0;
};
const byNewest = (a, b) => stamp(b) - stamp(a) || a.path.localeCompare(b.path);

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const formatSize = (bytes) => {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(bytes ? 1 : 0, Math.round(bytes / 1024))} KB`;
};
const PAGES_LIMIT = 1073741824; // GitHub Pages: published site max 1 GB
const sizeOf = (photos) => photos.reduce((sum, p) => sum + (p.size || 0), 0);

async function fetchMeta() {
  try {
    const res = await gh(`/contents/${META_PATH}?ref=${encodeURIComponent(config.branch)}`);
    return { data: JSON.parse(b64ToUtf8(res.content)), sha: res.sha };
  } catch (e) {
    if (e.status === 404) return { data: {}, sha: null };
    throw e;
  }
}

// Re-reads albums.json right before writing so edits from another device are kept.
async function saveAlbumMeta(name, info) {
  for (let attempt = 0; ; attempt++) {
    const { data, sha } = await fetchMeta();
    data.albums = { ...data.albums, [name]: info };
    try {
      await gh(`/contents/${META_PATH}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: `Update album ${name}`,
          content: utf8ToB64(`${JSON.stringify(data, null, 2)}\n`),
          branch: config.branch,
          ...(sha && { sha }),
        }),
      });
      state.meta = data.albums;
      saveCache();
      return;
    } catch (e) {
      if (![409, 422].includes(e.status) || attempt >= 2) throw e;
      await sleep(600);
    }
  }
}

async function loadPhotos() {
  if (!config.owner || !config.repo) return openSettings();
  const btn = $('#refreshBtn');
  btn.classList.add('spinning');
  try {
    const [{ tree }, meta] = await Promise.all([
      gh(`/git/trees/${encodeURIComponent(config.branch)}?recursive=1`),
      fetchMeta(),
    ]);
    state.photos = tree
      .filter((i) => i.type === 'blob' && i.path.startsWith(`${PHOTO_DIR}/`)
        && IMAGE_RE.test(i.path) && i.path.split('/').length <= 3)
      .map(toPhoto)
      .sort(byNewest);
    state.meta = meta.data.albums || {};
    saveCache();
  } catch (e) {
    // 404: branch missing, 409: repository has no commits yet.
    if (e.status === 404 || e.status === 409) state.photos = [];
    else toast(navigator.onLine ? errorText(e) : 'Çevrimdışısın — kayıtlı fotoğraflar gösteriliyor');
  } finally {
    btn.classList.remove('spinning');
  }
  render();
}

async function putPhoto(path, content) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await gh(`/contents/${encodePath(path)}`, {
        method: 'PUT',
        body: JSON.stringify({ message: `Add ${path}`, content, branch: config.branch }),
      });
    } catch (e) {
      if (e.status !== 409 || attempt >= 3) throw e;
      await sleep(800 * (attempt + 1));
    }
  }
}

function errorText(e) {
  switch (e.status) {
    case 401: return 'Token geçersiz ya da süresi dolmuş';
    case 403: return 'Yetki yok veya istek limiti doldu';
    case 404: return 'Repo bulunamadı';
    case 409: return 'Çakışma oldu, tekrar dene';
    case 422: return 'GitHub isteği reddetti';
    default: return navigator.onLine ? (e.message || 'Bir şeyler ters gitti') : 'İnternet bağlantısı yok';
  }
}

/* ---------- Albums, filters & routes ---------- */

function albumList() {
  const map = new Map(Object.keys(state.meta).map((n) => [n, []]));
  for (const p of state.photos) {
    if (!p.album) continue;
    if (!map.has(p.album)) map.set(p.album, []);
    map.get(p.album).push(p);
  }
  return [...map].sort(([a], [b]) => byTr(a, b)).map(([name, photos]) => ({
    name,
    photos,
    category: state.meta[name]?.category || '',
    tags: state.meta[name]?.tags || [],
  }));
}

const filterActive = () => !!state.filter.q || state.filter.category !== null || state.filter.tags.size > 0;

function matchesFilter(a) {
  const { q, category, tags } = state.filter;
  if (category !== null && a.category !== category) return false;
  for (const t of tags) if (!a.tags.includes(t)) return false;
  const hay = norm([a.name, a.category, ...a.tags].join(' '));
  return norm(q).split(/\s+/).every((w) => hay.includes(w.replace(/^#/, '')));
}

function setFilter(patch) {
  Object.assign(state.filter, patch);
  if (state.route !== 'albums') location.hash = '#/albums';
  else render();
}

function toggleTag(tag) {
  const tags = new Set(state.filter.tags);
  tags.has(tag) ? tags.delete(tag) : tags.add(tag);
  setFilter({ tags });
}

const parseTags = (text) => [...new Set(text.split(',').map((t) => t.trim().replace(/^#+/, '')).filter(Boolean))].slice(0, 20);
const cleanName = (text) => text.trim().replace(/[\\/:*?"<>|#%]+/g, '').replace(/^\.+/, '').slice(0, 40);
const albumHref = (name) => `#/album/${encodeURIComponent(name)}`;

function readRoute() {
  const hash = location.hash;
  const m = hash.match(/^#\/album\/(.*)$/);
  state.album = m ? decodeURIComponent(m[1]) : null;
  state.route = m ? 'album' : ({ '#/albums': 'albums', '#/explore': 'explore' })[hash] || 'home';
}

/* ---------- Rendering ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeImg(url, alt = '') {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.className = 'fade';
  img.alt = alt;
  img.onload = () => img.classList.add('loaded');
  img.src = url;
  return img;
}

function tagButton(tag) {
  const b = el('button', `tag${state.filter.tags.has(tag) ? ' active' : ''}`, `#${tag}`);
  b.type = 'button';
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleTag(tag);
  });
  return b;
}

const caption = (photo) => (stamp(photo) ? dateFmt.format(stamp(photo)) : '');

function render() {
  const albums = albumList();
  state.albumMap = new Map(albums.map((a) => [a.name, a]));
  document.body.dataset.view = state.route;
  for (const [id, route] of [['homeView', 'home'], ['albumsView', 'albums'], ['exploreView', 'explore'], ['albumView', 'album']]) {
    $(`#${id}`).hidden = state.route !== route;
  }
  const navKey = state.route === 'album' ? 'albums' : state.route;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === navKey));
  $('#fabLabel').textContent = state.route === 'album' ? 'Fotoğraf ekle' : 'Yeni albüm';

  renderSidebar(albums);
  ({ home: renderHome, albums: renderAlbums, explore: renderExplore, album: renderAlbum })[state.route](albums);

  $('#count').textContent = state.photos.length || albums.length
    ? `${state.photos.length} anı · ${albums.length} albüm`
    : 'Küçük anılar için sıcak bir köşe';
}

function renderSidebar(albums) {
  const cats = new Map();
  const tagCounts = new Map();
  let uncategorized = 0;
  for (const a of albums) {
    if (a.category) cats.set(a.category, (cats.get(a.category) || 0) + 1);
    else uncategorized++;
    for (const t of a.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  }

  const item = (label, value, count) => {
    const b = el('button', `side-item${state.filter.category === value ? ' active' : ''}`);
    b.type = 'button';
    b.append(el('span', '', label), el('span', 'side-count', count));
    b.addEventListener('click', () => {
      setFilter({ category: value });
      if (isMobile()) closeDrawer();
    });
    return b;
  };
  const catNames = [...cats.keys()].sort(byTr);
  $('#categoryList').replaceChildren(
    item('Tüm albümler', null, albums.length),
    ...catNames.map((c) => item(c, c, cats.get(c))),
    ...(uncategorized && cats.size ? [item('Temasız', '', uncategorized)] : []),
  );
  $('#categoryOptions').replaceChildren(...catNames.map((c) => Object.assign(el('option'), { value: c })));

  const tags = [...tagCounts].sort(([a, x], [b, y]) => y - x || byTr(a, b)).map(([t]) => t);
  $('#tagList').replaceChildren(...(tags.length
    ? tags.map(tagButton)
    : [el('p', 'hint', 'Henüz etiket yok. Bir albümü düzenleyip ekleyebilirsin.')]));
  $('#clearFilters').hidden = !filterActive();
  renderStorage();
}

function setMeter(meter, bytes) {
  const ratio = bytes / PAGES_LIMIT;
  meter.firstElementChild.style.width = `${Math.min(100, Math.max(ratio > 0 ? 1 : 0, ratio * 100))}%`;
  meter.classList.toggle('warn', ratio >= 0.8);
}

function renderStorage() {
  const used = sizeOf(state.photos);
  $('#storageUsed').textContent = formatSize(used);
  setMeter($('#storageBar').parentElement, used);
}

async function renderStorageDetail() {
  const used = sizeOf(state.photos);
  const avg = state.photos.length ? used / state.photos.length : 0;
  setMeter($('#stBar').parentElement, used);
  $('#stPhotos').textContent = `${formatSize(used)} · ${state.photos.length} fotoğraf (%${((used / PAGES_LIMIT) * 100).toFixed(1)})`;
  $('#stLeft').textContent = avg
    ? `${formatSize(Math.max(0, PAGES_LIMIT - used))} · ~${Math.floor(Math.max(0, PAGES_LIMIT - used) / avg).toLocaleString('tr-TR')} fotoğraf`
    : formatSize(PAGES_LIMIT);
  $('#stHint').textContent = used / PAGES_LIMIT >= 0.8
    ? 'Yer dolmak üzere! Fotoğrafları ayrı bir repoya taşımayı düşünebilirsin.'
    : 'GitHub Pages sitesi en fazla 1 GB olabilir. Silinen fotoğraflar repo geçmişinde yer kaplamaya devam eder.';

  try {
    const { usage } = await navigator.storage.estimate();
    $('#stDevice').textContent = formatSize(usage || 0);
  } catch {
    $('#stDevice').textContent = '—';
  }
  try {
    const info = await gh(''); // GitHub reports repo size in KB, including history
    $('#stRepo').textContent = info.size != null ? formatSize(info.size * 1024) : '—';
  } catch {
    $('#stRepo').textContent = '—';
  }
}

function albumCard(a) {
  const link = el('a', 'album-card');
  link.href = albumHref(a.name);
  const cover = el('div', 'album-cover');
  if (a.photos[0]) cover.append(makeImg(a.photos[0].url, a.label || a.name));
  else {
    const blank = el('div', 'cover-blank');
    blank.append(Object.assign(new Image(), { src: 'icons/icon.svg', alt: '' }));
    cover.append(blank);
  }
  const info = el('div', 'album-info');
  info.append(
    el('h3', '', a.label || a.name),
    el('p', 'album-sub', [`${a.photos.length} fotoğraf`, a.category].filter(Boolean).join(' · ')),
  );
  if (a.tags.length) {
    const row = el('div', 'tags');
    row.append(...a.tags.map(tagButton));
    info.append(row);
  }
  link.append(cover, info);
  return link;
}

function renderHome(albums) {
  const names = albums.map((a) => a.name);
  const wanted = Math.min(HOME_PICKS, names.length);
  if (!state.picks || state.picks.length !== wanted || state.picks.some((n) => !state.albumMap.has(n))) {
    state.picks = shuffle(names).slice(0, wanted);
  }
  const paths = new Set(state.photos.map((p) => p.path));
  const albumPhotos = state.photos.filter((p) => p.album);
  if (!state.heroPaths || state.heroPaths.length !== Math.min(3, albumPhotos.length)
    || state.heroPaths.some((p) => !paths.has(p))) {
    state.heroPaths = shuffle(albumPhotos).slice(0, 3).map((p) => p.path);
  }

  $('#heroDate').textContent = todayFmt.format(new Date());
  $('#heroText').textContent ||= GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
  $('#heroStats').textContent = albums.length
    ? `${albums.length} albüm ve ${state.photos.length} anı seni bekliyor.`
    : 'İlk albümünü oluşturarak başla.';
  $('#heroCollage').replaceChildren(...state.heroPaths.map((path) => makeImg(photoUrl(path))));
  $('#heroCollage').hidden = state.heroPaths.length === 0;
  $('#shuffleBtn').hidden = albums.length < 2;

  $('#randomGrid').replaceChildren(...state.picks.map((n) => albumCard(state.albumMap.get(n))));
  $('#randomGrid').previousElementSibling.hidden = albums.length === 0;
  $('#homeEmpty').hidden = albums.length > 0;
}

function albumGrid(list) {
  const grid = el('div', 'album-grid');
  grid.append(...list.map(albumCard));
  return grid;
}

function themeSection(title, list) {
  const section = el('section', 'theme-section');
  const head = el('div', 'theme-head');
  head.append(el('h3', '', title), el('span', '', `${list.length} albüm`));
  section.append(head, albumGrid(list));
  return section;
}

function renderAlbums(albums) {
  const list = albums.filter(matchesFilter);
  // Photos outside any album (e.g. added straight to the repo) stay visible until moved.
  const unsorted = state.photos.filter((p) => !p.album);
  const loose = unsorted.length && !filterActive()
    ? [{ name: '', label: 'Albümsüz', photos: unsorted, category: '', tags: [] }]
    : [];

  let body;
  if (state.groupBy === 'theme') {
    const groups = new Map();
    for (const a of list) {
      if (!groups.has(a.category)) groups.set(a.category, []);
      groups.get(a.category).push(a);
    }
    const keys = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || byTr(a, b));
    body = keys.map((k) => themeSection(k || 'Temasız', groups.get(k)));
    if (loose.length) body.push(themeSection('Albüme taşınmayı bekleyenler', loose));
  } else {
    body = list.length + loose.length ? [albumGrid([...list, ...loose])] : [];
  }
  $('#albumsBody').replaceChildren(...body);
  document.querySelectorAll('[data-group]').forEach((b) => b.classList.toggle('active', b.dataset.group === state.groupBy));
  $('#albumsEmpty').hidden = list.length + loose.length > 0;
  $('#albumsEmptyTitle').textContent = filterActive() ? 'Aramana uyan albüm yok' : 'Henüz albüm yok';
  $('#albumsEmptyText').textContent = filterActive()
    ? 'Başka bir kelime dene ya da filtreleri temizle.'
    : 'Sağ alttaki butonla ilk albümünü oluştur.';
  $('#filterSummary').textContent = filterActive() ? `${list.length} albüm bulundu` : `${albums.length} albüm`;
}

/* ---------- Explore feed ---------- */

const feedKeyOf = () => state.photos.map((p) => p.path).join('|');

function ensureFeed(force = false) {
  const key = feedKeyOf();
  if (!force && key === state.feedKey) return;
  state.feedKey = key;
  state.feed = shuffle(state.photos.filter((p) => p.album));
  state.feedShown = Math.min(FEED_BATCH, state.feed.length);
}

function postEl(photo, i) {
  const album = state.albumMap.get(photo.album);
  const post = el('article', 'post');

  const head = el('button', 'post-head');
  head.type = 'button';
  const avatar = makeImg(album?.photos[0]?.url || photo.url);
  avatar.classList.add('avatar');
  const who = el('span', 'post-who');
  who.append(el('b', '', photo.album), el('small', '', album?.category || `${album?.photos.length || 1} fotoğraf`));
  head.append(avatar, who);
  head.addEventListener('click', () => { location.hash = albumHref(photo.album); });

  const media = el('button', 'post-media');
  media.type = 'button';
  media.setAttribute('aria-label', `${photo.album} fotoğrafını aç`);
  media.append(makeImg(photo.url, photo.album));
  media.addEventListener('click', () => openLightbox(i, true));

  const body = el('div', 'post-body');
  if (album?.tags.length) {
    const row = el('div', 'tags');
    row.append(...album.tags.map(tagButton));
    body.append(row);
  }
  const foot = el('div', 'post-foot');
  const go = el('a', 'link-btn', 'Albüme git →');
  go.href = albumHref(photo.album);
  foot.append(el('time', '', caption(photo)), go);
  body.append(foot);

  post.append(head, media, body);
  return post;
}

function renderExplore() {
  ensureFeed();
  state.view = state.feed;
  $('#feed').replaceChildren(...state.feed.slice(0, state.feedShown).map(postEl));
  $('#exploreEmpty').hidden = state.feed.length > 0;
  $('#reshuffleBtn').hidden = state.feed.length < 2;
  updateFeedEnd();
}

function updateFeedEnd() {
  $('#feedEnd').hidden = !state.feed.length || state.feedShown < state.feed.length;
  feedObserver.unobserve($('#feedSentinel'));
  if (state.feedShown < state.feed.length) feedObserver.observe($('#feedSentinel'));
}

// Observing again after each batch re-checks the sentinel, so short feeds keep filling the screen.
const feedObserver = new IntersectionObserver((entries) => {
  if (state.route !== 'explore' || !entries.some((e) => e.isIntersecting)) return;
  const from = state.feedShown;
  state.feedShown = Math.min(state.feed.length, from + FEED_BATCH);
  $('#feed').append(...state.feed.slice(from, state.feedShown).map((p, k) => postEl(p, from + k)));
  updateFeedEnd();
}, { rootMargin: '600px 0px' });

function reshuffleFeed() {
  ensureFeed(true);
  render();
  scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- Album page ---------- */

function renderAlbum(albums) {
  const name = state.album;
  const unsorted = name === '';
  const album = albums.find((a) => a.name === name);
  state.view = unsorted ? state.photos.filter((p) => !p.album) : album?.photos || [];

  $('#albumTitle').textContent = unsorted ? 'Albümsüz' : name;
  $('#editAlbumBtn').hidden = unsorted;
  const meta = [el('span', '', `${state.view.length} fotoğraf · ${formatSize(sizeOf(state.view))}`)];
  if (album?.category) {
    const badge = el('button', 'badge', album.category);
    badge.type = 'button';
    badge.addEventListener('click', () => setFilter({ category: album.category }));
    meta.push(badge);
  }
  if (album?.tags.length) {
    const row = el('div', 'tags');
    row.append(...album.tags.map(tagButton));
    meta.push(row);
  }
  $('#albumMeta').replaceChildren(...meta);

  $('#grid').replaceChildren(...state.view.map((photo, i) => {
    const card = el('button', 'card');
    card.type = 'button';
    card.style.animationDelay = `${Math.min(i, 12) * 35}ms`;
    card.append(makeImg(photo.url, caption(photo) || name));
    if (caption(photo)) card.append(el('time', '', caption(photo)));
    card.addEventListener('click', () => openLightbox(i));
    return card;
  }));
  $('#empty').hidden = state.view.length > 0;
}

/* ---------- Album dialog ---------- */

let editing = null;
let onAlbumCreated = null;

function openAlbumDialog(name = null, onCreated = null) {
  onAlbumCreated = onCreated;
  if (!config.token) {
    toast('Albüm oluşturmak için önce ayarlardan token gir');
    return openSettings();
  }
  editing = name;
  const f = $('#albumForm').elements;
  const info = (name && state.meta[name]) || {};
  $('#albumDialogTitle').textContent = name ? 'Albümü düzenle' : 'Yeni albüm';
  f.name.value = name || '';
  f.name.readOnly = !!name;
  f.category.value = info.category || '';
  f.tags.value = (info.tags || []).join(', ');
  renderTagSuggest();
  $('#albumDialog').showModal();
  (name ? f.category : f.name).focus();
}

function renderTagSuggest() {
  const input = $('#albumForm').elements.tags;
  const current = parseTags(input.value);
  const all = [...new Set(albumList().flatMap((a) => a.tags))].filter((t) => !current.includes(t)).sort(byTr);
  $('#tagSuggest').replaceChildren(...all.map((t) => {
    const b = el('button', 'tag', `#${t}`);
    b.type = 'button';
    b.addEventListener('click', () => {
      input.value = [...parseTags(input.value), t].join(', ');
      renderTagSuggest();
    });
    return b;
  }));
  $('#tagSuggest').previousElementSibling.hidden = all.length === 0;
}

$('#albumForm').elements.tags.addEventListener('input', renderTagSuggest);
$('#albumCancel').addEventListener('click', () => $('#albumDialog').close());
$('#albumDialog').addEventListener('close', () => {
  const done = onAlbumCreated;
  onAlbumCreated = null;
  done?.(null);
});
$('#editAlbumBtn').addEventListener('click', () => openAlbumDialog(state.album));

$('#albumForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const name = editing ?? cleanName(f.name.value);
  if (!name) return toast('Geçerli bir albüm adı yaz');
  if (!editing && albumList().some((a) => norm(a.name) === norm(name))) return toast('Bu isimde bir albüm zaten var');
  const info = { category: f.category.value.trim().slice(0, 30), tags: parseTags(f.tags.value) };
  const submit = e.target.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    await saveAlbumMeta(name, info);
    const done = onAlbumCreated;
    onAlbumCreated = null;
    $('#albumDialog').close();
    toast(editing ? 'Albüm güncellendi' : `“${name}” oluşturuldu`);
    if (done) {
      render();
      done(name);
    } else if (editing) render();
    else location.hash = albumHref(name);
  } catch (err) {
    toast(errorText(err));
  } finally {
    submit.disabled = false;
  }
});

/* ---------- Upload ---------- */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Görsel okunamadı')); };
    img.src = url;
  });
}

async function prepare(file) {
  if (file.type === 'image/gif') return { blob: file, ext: 'gif' };
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', QUALITY));
  if (!blob) throw new Error('Görsel sıkıştırılamadı');
  return { blob, ext: 'jpg' };
}

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result.split(',')[1]);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

/* ---------- Album picker ---------- */

let pickResolve = null;

function finishPick(value) {
  const resolve = pickResolve;
  pickResolve = null;
  if ($('#pickDialog').open) $('#pickDialog').close();
  resolve?.(value);
}

// Resolves with the chosen album name, or null when cancelled.
function pickAlbum(title, exclude = null) {
  finishPick(null);
  return new Promise((resolve) => {
    pickResolve = resolve;
    $('#pickTitle').textContent = title;
    const items = albumList().filter((a) => a.name !== exclude).map((a) => {
      const b = el('button', 'pick-item');
      b.type = 'button';
      if (a.photos[0]) b.append(Object.assign(makeImg(a.photos[0].url), { loading: 'eager' }));
      else b.append(el('span', 'pick-blank', '·'));
      const text = el('span');
      text.append(el('b', '', a.name), el('small', '', [`${a.photos.length} fotoğraf`, a.category].filter(Boolean).join(' · ')));
      b.append(text);
      b.addEventListener('click', () => finishPick(a.name));
      return b;
    });
    const add = el('button', 'pick-item new');
    add.type = 'button';
    add.append(el('span', 'pick-blank', '+'), el('span', '', 'Yeni albüm oluştur'));
    add.addEventListener('click', () => {
      const resolveNew = pickResolve;
      pickResolve = null;
      $('#pickDialog').close();
      openAlbumDialog(null, resolveNew);
    });
    $('#pickList').replaceChildren(...items, add);
    $('#pickDialog').showModal();
  });
}

$('#pickCancel').addEventListener('click', () => finishPick(null));
$('#pickDialog').addEventListener('close', () => finishPick(null));

async function uploadFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/') || IMAGE_RE.test(f.name));
  if (!files.length) return;
  if (!config.token) {
    toast('Yüklemek için önce ayarlardan token gir');
    return openSettings();
  }
  // Every photo belongs to an album: outside an album page, ask which one.
  let album = state.route === 'album' && state.album ? state.album : null;
  if (!album) {
    album = await pickAlbum(`${files.length} fotoğraf hangi albüme eklensin?`);
    if (!album) return;
    if (location.hash !== albumHref(album)) location.hash = albumHref(album);
  }
  uploadChain = uploadChain.then(() => runUpload(files, album));
}

async function runUpload(files, album) {
  state.uploading = true;
  $('#queue').hidden = false;
  const dir = `${PHOTO_DIR}/${album}`;
  let ok = 0;
  for (const [i, file] of files.entries()) {
    $('#queueText').textContent = `${album} · Yükleniyor… ${i + 1} / ${files.length}`;
    $('#queueBar').style.width = `${(i / files.length) * 100}%`;
    try {
      const { blob, ext } = await prepare(file);
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
      const res = await putPhoto(`${dir}/${name}`, await toBase64(blob));
      state.photos.unshift(toPhoto(res.content));
      saveCache();
      render();
      ok++;
    } catch (e) {
      console.error(e);
      toast(`${file.name}: ${errorText(e)}`);
    }
  }
  $('#queueBar').style.width = '100%';
  $('#queue').hidden = true;
  state.uploading = false;
  if (ok) toast(`${ok} fotoğraf eklendi`);
}

async function consumeShared() {
  if (!new URLSearchParams(location.search).has('shared') || !('caches' in window)) return;
  history.replaceState(null, '', location.pathname + location.hash);
  const cache = await caches.open(SHARE_CACHE);
  const files = await Promise.all((await cache.keys()).map(async (req) => {
    const res = await cache.match(req);
    const blob = await res.blob();
    return new File([blob], decodeURIComponent(res.headers.get('x-name') || 'photo'), { type: blob.type });
  }));
  await caches.delete(SHARE_CACHE);
  uploadFiles(files);
}

/* ---------- Lightbox ---------- */

function openLightbox(i, showInfo = state.showInfo) {
  state.index = i;
  state.showInfo = showInfo;
  showCurrent();
  $('#lightbox').hidden = false;
  document.body.classList.add('no-scroll');
  history.pushState({ lightbox: true }, '');
}

function hideLightbox() {
  $('#lightbox').hidden = true;
  document.body.classList.remove('no-scroll');
  state.index = -1;
}

function closeLightbox(fromPop = false) {
  if ($('#lightbox').hidden) return;
  hideLightbox();
  if (!fromPop && history.state?.lightbox) history.back();
}

// Navigates from the open lightbox, replacing its history entry so Back skips it.
function leaveLightboxTo(hash) {
  hideLightbox();
  if (history.state?.lightbox) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  readRoute();
  render();
  scrollTo(0, 0);
}

function showCurrent() {
  const p = state.view[state.index];
  const img = $('#lbImg');
  const setDims = () => {
    if (img.src === p.url && img.naturalWidth) $('#lbDims').textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
  };
  $('#lbDims').textContent = '—';
  img.onload = setDims;
  img.src = p.url;
  img.alt = caption(p) || p.album;
  if (img.complete) setDims();
  $('#lbCaption').textContent = [caption(p), `${state.index + 1} / ${state.view.length}`].filter(Boolean).join(' · ');

  const album = state.albumMap.get(p.album);
  $('#lbAlbumName').textContent = p.album || 'Albümsüz';
  $('#lbAlbumCover').src = album?.photos[0]?.url || p.url;
  $('#lbCategory').textContent = album?.category || '—';
  $('#lbDate').textContent = stamp(p) ? fullDateFmt.format(stamp(p)) : 'Bilinmiyor';
  $('#lbSize').textContent = p.size ? formatSize(p.size) : '—';
  $('#lbFile').textContent = p.name;
  $('#lbTags').replaceChildren(...(album?.tags || []).map((t) => {
    const b = el('button', 'tag', `#${t}`);
    b.type = 'button';
    b.addEventListener('click', () => {
      state.filter = { q: '', category: null, tags: new Set([t]) };
      $('#search').value = '';
      leaveLightboxTo('#/albums');
    });
    return b;
  }));
  $('#lbGoAlbum').hidden = state.route === 'album';
  applyInfo();
}

function applyInfo() {
  $('#lbInfo').hidden = !state.showInfo;
  $('#lightbox').classList.toggle('info-open', state.showInfo);
  $('#lbInfoBtn').classList.toggle('active', state.showInfo);
}

function goToCurrentAlbum() {
  const p = state.view[state.index];
  leaveLightboxTo(albumHref(p.album));
}

function step(delta) {
  const n = state.view.length;
  if (n < 2 || state.index < 0) return;
  state.index = (state.index + delta + n) % n;
  showCurrent();
}

async function downloadCurrent() {
  const p = state.view[state.index];
  try {
    const blob = await (await fetch(p.url)).blob();
    const file = new File([blob], p.name, { type: blob.type });
    if (matchMedia('(hover: none)').matches && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = p.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    if (e.name !== 'AbortError') toast('İndirilemedi');
  }
}

async function deleteCurrent() {
  const p = state.view[state.index];
  if (!config.token) return toast('Silmek için ayarlardan token gir');
  if (!confirm('Bu fotoğraf silinsin mi?')) return;
  try {
    await gh(`/contents/${encodePath(p.path)}`, {
      method: 'DELETE',
      body: JSON.stringify({ message: `Delete ${p.path}`, sha: p.sha, branch: config.branch }),
    });
    if ('caches' in window) caches.open(IMG_CACHE).then((c) => c.delete(p.url)).catch(() => {});
    // Keep an up-to-date explore order stable instead of reshuffling under the open lightbox.
    const feedFresh = state.feedKey === feedKeyOf();
    state.photos = state.photos.filter((x) => x.path !== p.path);
    const fi = state.feed.findIndex((x) => x.path === p.path);
    if (fi >= 0) {
      state.feed.splice(fi, 1);
      if (fi < state.feedShown) state.feedShown--;
    }
    if (feedFresh) state.feedKey = feedKeyOf();
    saveCache();
    render();
    syncLightbox();
    toast('Silindi');
  } catch (e) {
    toast(errorText(e));
  }
}

function syncLightbox() {
  if (!state.view.length) closeLightbox();
  else {
    state.index = Math.min(state.index, state.view.length - 1);
    showCurrent();
  }
}

// GitHub has no move: copy the file into the target album, then delete the original.
async function moveCurrent() {
  const p = state.view[state.index];
  if (!config.token) return toast('Taşımak için ayarlardan token gir');
  const target = await pickAlbum('Hangi albüme taşınsın?', p.album);
  if (!target) return;
  try {
    const blob = await (await fetch(p.url)).blob();
    const res = await putPhoto(`${PHOTO_DIR}/${target}/${p.name}`, await toBase64(blob));
    await gh(`/contents/${encodePath(p.path)}`, {
      method: 'DELETE',
      body: JSON.stringify({ message: `Move ${p.path} to ${target}`, sha: p.sha, branch: config.branch }),
    });
    const moved = toPhoto(res.content);
    const feedFresh = state.feedKey === feedKeyOf();
    state.photos = state.photos.map((x) => (x.path === p.path ? moved : x));
    state.feed = state.feed.map((x) => (x.path === p.path ? moved : x));
    if (feedFresh) state.feedKey = feedKeyOf();
    saveCache();
    render();
    syncLightbox();
    toast(`“${target}” albümüne taşındı`);
  } catch (e) {
    toast(errorText(e));
  }
}

/* ---------- Settings ---------- */

function openSettings() {
  const f = $('#settingsForm').elements;
  f.owner.value = config.owner;
  f.repo.value = config.repo;
  f.branch.value = config.branch;
  f.token.value = config.token;
  $('#settings').showModal();
  renderStorageDetail();
}

$('#storageMore').addEventListener('click', openSettings);

$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  config = {
    owner: f.owner.value.trim(),
    repo: f.repo.value.trim(),
    branch: f.branch.value.trim() || 'main',
    token: f.token.value.trim(),
  };
  localStorage.setItem('lg-config', JSON.stringify(config));
  $('#settings').close();
  try {
    const info = await gh('');
    toast(config.token && !info.permissions?.push ? 'Token bu repoya yazamıyor' : 'Bağlantı tamam');
  } catch (err) {
    toast(errorText(err));
  }
  loadPhotos();
});

/* ---------- UI helpers & events ---------- */

let toastTimer;
function toast(msg) {
  const node = $('#toast');
  node.textContent = msg;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3200);
}

function openDrawer() {
  if (state.route !== 'albums' && state.route !== 'album') location.hash = '#/albums';
  $('#sidebar').classList.add('open');
  $('#scrim').hidden = false;
}

function closeDrawer() {
  $('#sidebar').classList.remove('open');
  $('#scrim').hidden = true;
}

$('#menuBtn').addEventListener('click', openDrawer);
$('#scrim').addEventListener('click', closeDrawer);
$('#search').addEventListener('input', (e) => setFilter({ q: e.target.value }));
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter' && isMobile()) closeDrawer(); });
$('#clearFilters').addEventListener('click', () => {
  $('#search').value = '';
  setFilter({ q: '', category: null, tags: new Set() });
});

$('#shuffleBtn').addEventListener('click', () => {
  state.picks = null;
  state.heroPaths = null;
  render();
});
$('#reshuffleBtn').addEventListener('click', reshuffleFeed);
$('#feedAgain').addEventListener('click', reshuffleFeed);

window.addEventListener('hashchange', () => {
  readRoute();
  closeLightbox(true);
  render();
  scrollTo(0, 0);
});

$('#addBtn').addEventListener('click', () => (state.route === 'album' ? $('#fileInput').click() : openAlbumDialog()));
$('#fileInput').addEventListener('change', (e) => {
  uploadFiles(e.target.files);
  e.target.value = '';
});
$('#refreshBtn').addEventListener('click', loadPhotos);
$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsCancel').addEventListener('click', () => $('#settings').close());

$('#lbClose').addEventListener('click', () => closeLightbox());
$('#lbPrev').addEventListener('click', () => step(-1));
$('#lbNext').addEventListener('click', () => step(1));
$('#lbDownload').addEventListener('click', downloadCurrent);
$('#lbDelete').addEventListener('click', deleteCurrent);
$('#lbMove').addEventListener('click', moveCurrent);
document.querySelectorAll('[data-group]').forEach((b) => b.addEventListener('click', () => {
  state.groupBy = b.dataset.group;
  try { localStorage.setItem('lg-group', JSON.stringify(state.groupBy)); } catch {}
  render();
}));
$('#lbInfoBtn').addEventListener('click', () => {
  state.showInfo = !state.showInfo;
  applyInfo();
});
$('#lbGoAlbum').addEventListener('click', goToCurrentAlbum);
$('#lbAlbumLink').addEventListener('click', goToCurrentAlbum);
$('#lbStage').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeLightbox(); });
window.addEventListener('popstate', () => closeLightbox(true));

let touchX = null;
$('#lbStage').addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
$('#lbStage').addEventListener('touchend', (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
  touchX = null;
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
  if ($('#lightbox').hidden) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'i') $('#lbInfoBtn').click();
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  uploadFiles(e.dataTransfer.files);
});
window.addEventListener('paste', (e) => {
  const files = e.clipboardData?.files;
  if (files?.length) uploadFiles(files);
});

/* ---------- Service worker ---------- */

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !state.uploading) location.reload();
  });
  navigator.serviceWorker.register('./sw.js');
}

/* ---------- Init ---------- */

readRoute();
render();
setTimeout(() => $('#grid').classList.remove('intro'), 1200);
if (!localStorage.getItem('lg-config') && !IS_LOCAL) openSettings();
loadPhotos();
consumeShared();
