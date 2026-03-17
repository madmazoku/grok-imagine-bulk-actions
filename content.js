/**
 * Grok Imagine Bulk Actions - Content Script
 * - API-only: no DOM scrolling collection
 * - Three actions:
 *    1) downloadAll: download all liked posts' media (images + videos) into timestamp folder
 *    2) unfavoriteAll: unlike + delete all liked POSTS (top-level posts only)
 *    3) deleteAllFiles: delete all files from grok.com/files
 *
 * API used:
 *   POST https://grok.com/rest/media/post/list
 *     payload: {limit:40, cursor?, filter:{source:"MEDIA_POST_SOURCE_LIKED"}}
 *
 * Notes:
 * - "liked" source is MEDIA_POST_SOURCE_LIKED. If you want "saved" instead, change FILTER_SOURCE below.
 * - Downloads are performed by background.js via chrome.runtime.sendMessage({action:"startDownloads", media:[{url,filename}]})
 *   and progress is tracked through chrome.storage.local keys: downloadQueue, fileProgress, fileErrors.
 */

const API = {
  LIST: 'https://grok.com/rest/media/post/list',
  UNLIKE: 'https://grok.com/rest/media/post/unlike',
  DELETE: 'https://grok.com/rest/media/post/delete',
  ASSETS: 'https://grok.com/rest/assets',
  ASSET_METADATA: 'https://grok.com/rest/assets-metadata',
};

const FILTER_SOURCE = 'MEDIA_POST_SOURCE_LIKED'; // <-- change if needed

const TIMING = {
  RANDOM_VARIATION_PCT: 0.1,
  LIST_PAGE_DELAY_MS: 1500,
  DOWNLOAD_POLL_MS: 500,
  DOWNLOAD_RELOAD_GRACE_MS: 3000,
  DOWNLOAD_HARD_TIMEOUT_MS: 10 * 60 * 1000,
  DOWNLOAD_RETRY_MAX_ATTEMPTS: 3,
  UNLIKE_DELETE_DELAY_MS: 180,
  FILE_DELETE_DELAY_MS: 180,
};

const COLLECTION_LIMIT = 1000;

/* =========================
   Helpers
========================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepRandom = (meanMs) => {
  const variation = Math.max(0, meanMs * TIMING.RANDOM_VARIATION_PCT);
  const minMs = Math.max(0, meanMs - variation);
  const maxMs = meanMs + variation;
  return sleep(minMs + Math.random() * (maxMs - minMs));
};
const pad2 = (n) => String(n).padStart(2, '0');
const storageGet = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));

function generateDownloadFolderName(date = new Date()) {
  // Local time folder: YYYY-MM-DD_HH-MM
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}_${pad2(date.getHours())}-${pad2(date.getMinutes())}`;
}

function extFromUrl(url, fallback = 'bin') {
  try {
    const clean = String(url).split('?')[0];
    const last = clean.split('/').pop() || '';
    if (last.includes('.')) return last.split('.').pop() || fallback;
    return fallback;
  } catch {
    return fallback;
  }
}

/* =========================
   Progress Modal
========================= */
const ProgressModal = {
  modal: null,
  cancelled: false,

  create() {
    if (this.modal) return;

    this.modal = document.createElement('div');
    this.modal.id = 'grok-favorites-progress-modal';
    this.modal.innerHTML = `
      <div style="
        position: fixed; top:0; left:0; width:100%; height:100%;
        background: rgba(0,0,0,0.80); backdrop-filter: blur(4px);
        z-index: 999999; display:flex; align-items:center; justify-content:center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;">
        <div style="
          background:#121212; border:1px solid #2a2a2a; border-radius:16px;
          padding:26px; min-width:420px; max-width:540px;
          box-shadow:0 20px 60px rgba(0,0,0,0.55);">
          <div id="grok-progress-title" style="font-size:18px; font-weight:650; color:#e5e5e5; margin-bottom:8px;">
            Processing...
          </div>
          <div id="grok-progress-subtitle" style="font-size:13px; color:#8a8a8a; margin-bottom:16px;">
            Please wait
          </div>
          <div style="background:#0a0a0a; border-radius:10px; height:10px; overflow:hidden; margin-bottom:14px;">
            <div id="grok-progress-bar" style="
              background: linear-gradient(90deg,#3b82f6,#8b5cf6);
              height:100%; width:0%; transition: width 0.25s ease; border-radius:10px;">
            </div>
          </div>
          <div id="grok-progress-details" style="font-size:13px; color:#b0b0b0; line-height:1.6; margin-bottom:12px;">
            Starting...
          </div>
          <button id="grok-cancel-button" style="
            width:100%; padding:10px 14px; background:#211313;
            border:1px solid #4a2a2a; border-radius:10px; color:#ff6b6b;
            font-size:14px; font-weight:600; cursor:pointer; font-family: inherit;">
            Cancel
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(this.modal);
    document.getElementById('grok-cancel-button').addEventListener('click', () => this.cancel());
  },

  show(title, subtitle = '') {
    this.cancelled = false;
    this.create();
    this.modal.style.display = 'flex';
    document.getElementById('grok-progress-title').textContent = title;
    document.getElementById('grok-progress-subtitle').textContent = subtitle;
    document.getElementById('grok-progress-bar').style.width = '0%';
    document.getElementById('grok-progress-details').textContent = 'Starting...';

    const btn = document.getElementById('grok-cancel-button');
    btn.textContent = 'Cancel';
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
  },

  update(progress, details) {
    if (!this.modal) return;
    const pct = Math.min(100, Math.max(0, progress));
    document.getElementById('grok-progress-bar').style.width = `${pct}%`;
    document.getElementById('grok-progress-details').textContent = details;
  },

  cancel() {
    this.cancelled = true;
    this.update(0, 'Cancelling...');
    const btn = document.getElementById('grok-cancel-button');
    btn.textContent = 'Cancelling...';
    btn.disabled = true;
    btn.style.opacity = '0.6';
    btn.style.cursor = 'not-allowed';
  },

  isCancelled() {
    return this.cancelled;
  },

  hide() {
    if (this.modal) this.modal.style.display = 'none';
    this.cancelled = false;
  },
};

/* =========================
   API collection (Map)
========================= */
/**
 * Map<id, { id, kind:'post'|'image'|'video', urls:Set<string> }>
 * Rules:
 *  - top-level posts -> kind 'post'
 *  - post.images[] -> kind 'image'
 *  - post.videos[] -> kind 'video'
 *  - if same id is seen again as 'post', it upgrades to 'post'
 */
function upsertMedia(entity, kind, mediaById) {
  if (!entity || !entity.id) return;
  const id = entity.id;

  if (!mediaById.has(id)) {
    mediaById.set(id, { id, kind, urls: new Set() });
  }
  const entry = mediaById.get(id);

  if (kind === 'post') entry.kind = 'post';
  if (entity.mediaUrl) entry.urls.add(entity.mediaUrl);
}

async function collectLikedMediaViaAPI(limit = null) {
  const mediaById = new Map();
  const collectedPostIds = new Set();
  let cursor = null;
  let page = 0;

  while (true) {
    if (ProgressModal.isCancelled()) throw new Error('Operation cancelled by user');

    ProgressModal.update(
      Math.min(12, 2 + page),
      `Loading liked posts from API... page ${page + 1}${collectedPostIds.size ? ` (loaded: ${collectedPostIds.size})` : ''}`
    );

    const payload = {
      limit: 40,
      filter: { source: FILTER_SOURCE },
      ...(cursor ? { cursor } : {}),
    };

    const resp = await fetch(API.LIST, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: '*/*' },
      body: JSON.stringify(payload),
    });

    let json;
    try {
      json = await resp.json();
    } catch {
      throw new Error(`Failed to parse JSON from /rest/media/post/list (status ${resp.status})`);
    }

    if (!resp.ok) {
      throw new Error(`API error ${resp.status} from /rest/media/post/list`);
    }

    const posts = Array.isArray(json.posts) ? json.posts : [];
    if (posts.length === 0) break;

    ProgressModal.update(
      Math.min(14, 3 + page),
      `Loaded ${collectedPostIds.size} liked posts across ${page + 1} page${page + 1 > 1 ? 's' : ''}...`
    );

    for (const post of posts) {
      if (limit !== null && collectedPostIds.size >= limit) break;
      collectedPostIds.add(post.id);
      upsertMedia(post, 'post', mediaById);

      if (Array.isArray(post.images)) {
        for (const img of post.images) upsertMedia(img, 'image', mediaById);
      }

      if (Array.isArray(post.videos)) {
        for (const vid of post.videos) upsertMedia(vid, 'video', mediaById);
      }
    }

    ProgressModal.update(
      Math.min(14, 3 + page),
      `Loaded ${collectedPostIds.size} liked posts across ${page + 1} page${page + 1 > 1 ? 's' : ''}${limit !== null ? ` (limit ${limit})` : ''}...`
    );

    if (limit !== null && collectedPostIds.size >= limit) break;

    cursor = json.nextCursor || null;
    if (!cursor) break;

    page++;
    await sleepRandom(TIMING.LIST_PAGE_DELAY_MS);
  }

  return mediaById;
}

function buildAssetsListUrl(pageToken = null) {
  const url = new URL(API.ASSETS);
  url.searchParams.set('pageSize', '50');
  url.searchParams.set('orderBy', 'ORDER_BY_LAST_USE_TIME');
  url.searchParams.set('source', 'SOURCE_ANY');
  url.searchParams.set('isLatest', 'true');

  if (pageToken) {
    url.searchParams.set('query', '');
    url.searchParams.set('pageToken', pageToken);
  }

  return url.toString();
}

async function collectAssetsViaAPI(limit = null) {
  const assetIds = new Set();
  let pageToken = null;
  let page = 0;

  while (true) {
    if (ProgressModal.isCancelled()) throw new Error('Operation cancelled by user');

    ProgressModal.update(
      Math.min(12, 2 + page),
      `Loading files from API... page ${page + 1}${assetIds.size ? ` (loaded: ${assetIds.size})` : ''}`
    );

    const resp = await fetch(buildAssetsListUrl(pageToken), {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*' },
    });

    let json;
    try {
      json = await resp.json();
    } catch {
      throw new Error(`Failed to parse JSON from /rest/assets (status ${resp.status})`);
    }

    if (!resp.ok) {
      throw new Error(`API error ${resp.status} from /rest/assets`);
    }

    const assets = Array.isArray(json.assets) ? json.assets : [];
    const nextPageToken = json.nextPageToken || null;

    for (const asset of assets) {
      if (limit !== null && assetIds.size >= limit) break;
      if (asset?.assetId) assetIds.add(asset.assetId);
    }

    ProgressModal.update(
      Math.min(14, 3 + page),
      `Loaded ${assetIds.size} file${assetIds.size === 1 ? '' : 's'} across ${page + 1} page${page + 1 > 1 ? 's' : ''}${limit !== null ? ` (limit ${limit})` : ''}...`
    );

    if (limit !== null && assetIds.size >= limit) break;

    pageToken = nextPageToken;
    if (!pageToken) break;

    page++;
    await sleepRandom(TIMING.LIST_PAGE_DELAY_MS);
  }

  return Array.from(assetIds);
}

/* =========================
   Download via background.js + progress + retries
========================= */
async function downloadMediaFilesAndWait(mediaFiles, { pollMs = TIMING.DOWNLOAD_POLL_MS, showModal = false } = {}) {
  if (!Array.isArray(mediaFiles) || mediaFiles.length === 0) return;

  const startedAt = Date.now();
  const reloadGraceMs = TIMING.DOWNLOAD_RELOAD_GRACE_MS;
  const hardTimeoutMs = TIMING.DOWNLOAD_HARD_TIMEOUT_MS;

  await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'startDownloads', media: mediaFiles }, (resp) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      if (!resp?.success) return reject(new Error(resp?.error || 'startDownloads failed'));
      resolve();
    });
  });

  while (true) {
    if (ProgressModal.isCancelled()) throw new Error('Operation cancelled by user');

    const { totalDownloads = 0, downloadQueue = [], fileProgress = {} } =
      await storageGet(['totalDownloads', 'downloadQueue', 'fileProgress']);

    const total = totalDownloads || downloadQueue.length || mediaFiles.length;

    let completed = 0;
    let failed = 0;
    let started = 0;
    let queued = 0;
    for (const f of downloadQueue) {
      const st = fileProgress?.[f.filename];
      if (st === 'complete') completed++;
      else if (st === 'failed') failed++;
      else if (st === 'started') started++;
      else queued++;
    }

    const done = completed + failed;
    const pct = total ? Math.round((done / total) * 100) : 0;

    // We don't own the title/subtitle here; caller does. Just update details.
    ProgressModal.update(pct, `Downloads: ${done}/${total} (complete: ${completed}${failed ? `, failed: ${failed}` : ''})`);

    if (total && done >= total) break;

    const now = Date.now();
    if (now - startedAt >= reloadGraceMs && started === 0 && done < total) {
      ProgressModal.update(
        pct,
        `Downloads: ${done}/${total} (complete: ${completed}${failed ? `, failed: ${failed}` : ''}) - reloading remaining...`
      );
      break;
    }

    if (now - startedAt >= hardTimeoutMs) {
      const pending = downloadQueue
        .filter((f) => fileProgress?.[f.filename] !== 'complete')
        .map((f) => ({ filename: f.filename, status: fileProgress?.[f.filename] || 'queued' }));
      ProgressModal.update(
        pct,
        `Downloads: ${done}/${total} (complete: ${completed}${failed ? `, failed: ${failed}` : ''}) - attempt timeout, retrying remaining...`
      );
      break;
    }

    await sleepRandom(Math.max(50, pollMs));
  }
}

async function downloadWithRetries(
  mediaFilesBase,
  folder,
  { maxAttempts = TIMING.DOWNLOAD_RETRY_MAX_ATTEMPTS, pollMs = TIMING.DOWNLOAD_POLL_MS } = {}
) {
  if (!Array.isArray(mediaFilesBase) || mediaFilesBase.length === 0) return [];

  // Filename used as fileProgress key must match what we send to background.
  let pending = mediaFilesBase.map((m) => ({
    url: m.url,
    filename: `${folder}/${m.filename}`,
  }));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (ProgressModal.isCancelled()) throw new Error('Operation cancelled by user');

    ProgressModal.update(5, `Downloading... attempt ${attempt}/${maxAttempts} (${pending.length} files)`);
    await downloadMediaFilesAndWait(pending, { pollMs });

    const { downloadQueue = [], fileProgress = {} } =
      await storageGet(['downloadQueue', 'fileProgress']);

    const missing = downloadQueue.filter((f) => fileProgress?.[f.filename] !== 'complete');
    if (missing.length === 0) return [];
    pending = missing;

    ProgressModal.update(10, `Reloading ${missing.length} remaining items...`);
  }

  const { downloadQueue = [], fileProgress = {} } =
    await storageGet(['downloadQueue', 'fileProgress']);

  return downloadQueue.filter((f) => fileProgress?.[f.filename] !== 'complete');
}

/* =========================
   Actions
========================= */

function buildPostIdsAndMediaFiles(mediaById) {
  const postIds = [];
  const mediaFilesBase = [];

  for (const [id, entry] of mediaById) {
    if (entry.kind === 'post') postIds.push(id);

    // If multiple URLs per same id, avoid overwriting by adding __N suffix
    let i = 1;
    for (const url of entry.urls) {
      const ext = extFromUrl(url, entry.kind === 'video' ? 'mp4' : 'jpg');
      const suffix = (entry.urls.size > 1) ? `__${i++}` : '';
      mediaFilesBase.push({ url, filename: `${id}${suffix}.${ext}` });
    }
  }

  return { postIds, mediaFilesBase };
}

async function runPostActionPass(postIds, { label, startProgress, endProgress, action }) {
  let ok = 0;
  let fail = 0;
  const failedIds = [];

  for (let i = 0; i < postIds.length; i++) {
    if (ProgressModal.isCancelled()) throw new Error('Operation cancelled by user');

    const id = postIds[i];
    const pct = startProgress + Math.round(((i + 1) / postIds.length) * Math.max(0, endProgress - startProgress));
    ProgressModal.update(pct, `${label} ${i + 1}/${postIds.length}...`);

    const resp = await fetch(action === 'unlike' ? API.UNLIKE : API.DELETE, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: '*/*' },
      body: JSON.stringify({ id }),
    });

    if (resp.ok) ok++;
    else {
      fail++;
      failedIds.push(id);
    }

    await sleepRandom(TIMING.UNLIKE_DELETE_DELAY_MS);
  }

  return { ok, fail, failedIds };
}

async function runAssetDeletePass(assetIds, { label, startProgress, endProgress }) {
  let ok = 0;
  let fail = 0;
  const failedIds = [];

  for (let i = 0; i < assetIds.length; i++) {
    if (ProgressModal.isCancelled()) throw new Error('Operation cancelled by user');

    const assetId = assetIds[i];
    const pct = startProgress + Math.round(((i + 1) / assetIds.length) * Math.max(0, endProgress - startProgress));
    ProgressModal.update(pct, `${label} ${i + 1}/${assetIds.length}...`);

    const resp = await fetch(`${API.ASSET_METADATA}/${encodeURIComponent(assetId)}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { Accept: '*/*' },
    });

    if (resp.ok) ok++;
    else {
      fail++;
      failedIds.push(assetId);
    }

    await sleepRandom(TIMING.FILE_DELETE_DELAY_MS);
  }

  return { ok, fail, failedIds };
}

async function apiUnlikeAndDeleteAll(postIds) {
  const unlikePass1 = await runPostActionPass(postIds, {
    label: 'Unfavoriting pass 1',
    startProgress: 15,
    endProgress: 50,
    action: 'unlike',
  });
  const deletePass1 = await runPostActionPass(postIds, {
    label: 'Deleting posts pass 1',
    startProgress: 50,
    endProgress: 85,
    action: 'delete',
  });

  let unlikePass2 = { ok: 0, fail: 0, failedIds: [] };
  if (unlikePass1.failedIds.length) {
    unlikePass2 = await runPostActionPass(unlikePass1.failedIds, {
      label: 'Unfavoriting pass 2',
      startProgress: 85,
      endProgress: 93,
      action: 'unlike',
    });
  }

  let deletePass2 = { ok: 0, fail: 0, failedIds: [] };
  if (deletePass1.failedIds.length) {
    deletePass2 = await runPostActionPass(deletePass1.failedIds, {
      label: 'Deleting posts pass 2',
      startProgress: 93,
      endProgress: 100,
      action: 'delete',
    });
  }

  return {
    unlikeOk: unlikePass1.ok + unlikePass2.ok,
    unlikeFail: unlikePass2.fail,
    deleteOk: deletePass1.ok + deletePass2.ok,
    deleteFail: deletePass2.fail,
  };
}

async function apiDeleteAllAssets(assetIds) {
  const pass1 = await runAssetDeletePass(assetIds, {
    label: 'Deleting files pass 1',
    startProgress: 15,
    endProgress: 90,
  });

  let pass2 = { ok: 0, fail: 0, failedIds: [] };
  if (pass1.failedIds.length) {
    pass2 = await runAssetDeletePass(pass1.failedIds, {
      label: 'Deleting files pass 2',
      startProgress: 90,
      endProgress: 100,
    });
  }

  return {
    ok: pass1.ok + pass2.ok,
    fail: pass2.fail,
  };
}

async function handleDownloadAll() {
  ProgressModal.show('Download All', 'Fetching liked posts via API...');

  const mediaById = await collectLikedMediaViaAPI(COLLECTION_LIMIT);

  if (!mediaById.size) {
    ProgressModal.hide();
    alert('No liked posts found.');
    return;
  }

  const { postIds, mediaFilesBase } = buildPostIdsAndMediaFiles(mediaById);
  const folder = generateDownloadFolderName();

  ProgressModal.update(5, `Collected ${postIds.length} posts, ${mediaFilesBase.length} files. Downloading...`);

  const missing = await downloadWithRetries(mediaFilesBase, folder, { maxAttempts: TIMING.DOWNLOAD_RETRY_MAX_ATTEMPTS });

  ProgressModal.hide();

  if (missing.length) {
    alert(`Download finished with ${missing.length} missing files. Check console for details.`);
    console.warn('Missing after retries:', missing);
  } else {
    alert(`Download complete: ${mediaFilesBase.length} files.`);
  }
}

async function handleUnfavoriteAll() {
  ProgressModal.show('Unfavorite All', 'Fetching liked posts via API...');

  const mediaById = await collectLikedMediaViaAPI(COLLECTION_LIMIT);

  if (!mediaById.size) {
    ProgressModal.hide();
    alert('No liked posts found.');
    return;
  }

  const { postIds } = buildPostIdsAndMediaFiles(mediaById);

  ProgressModal.update(10, `Found ${postIds.length} liked posts. Unfavoriting + deleting...`);

  const { unlikeOk, unlikeFail, deleteOk, deleteFail } = await apiUnlikeAndDeleteAll(postIds);

  ProgressModal.hide();
  alert(
    `Done. Unfavorited ${unlikeOk}/${postIds.length}${unlikeFail ? `, unlike failed ${unlikeFail}` : ''}. ` +
    `Deleted ${deleteOk}/${postIds.length}${deleteFail ? `, delete failed ${deleteFail}` : ''}.`
  );
  window.location.reload();
}

async function handleDeleteAllFiles() {
  ProgressModal.show('Delete All Files', 'Fetching files via API...');

  const assetIds = await collectAssetsViaAPI(COLLECTION_LIMIT);

  if (!assetIds.length) {
    ProgressModal.hide();
    alert('No files found.');
    return;
  }

  ProgressModal.update(10, `Found ${assetIds.length} file${assetIds.length === 1 ? '' : 's'}. Deleting...`);

  const { ok, fail } = await apiDeleteAllAssets(assetIds);

  ProgressModal.hide();
  alert(`Done. Deleted ${ok}/${assetIds.length}${fail ? `, failed ${fail}` : ''}.`);
  window.location.reload();
}

/* =========================
   Message listener
========================= */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const action = request?.action;

  if (action === 'ping') {
    sendResponse({ loaded: true });
    return true;
  }

  if (action === 'cancelOperation') {
    ProgressModal.cancel();
    chrome.storage.local.set({ activeOperation: false });
    sendResponse({ success: true });
    return true;
  }

  (async () => {
    try {
      chrome.storage.local.set({ activeOperation: true });

      if (action === 'downloadAll') {
        await handleDownloadAll();
      } else if (action === 'unfavoriteAll') {
        await handleUnfavoriteAll();
      } else if (action === 'deleteAllFiles') {
        await handleDeleteAllFiles();
      }
    } catch (e) {
      console.error('Error handling action:', e);
      ProgressModal.hide();
      alert(`Error: ${e?.message || e}`);
    } finally {
      chrome.storage.local.set({ activeOperation: false });
    }
  })();

  // keep channel open, silence popup callback issues
  sendResponse({ accepted: true });
  return true;
});
