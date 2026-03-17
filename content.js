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
  BACKGROUND_TASK_POLL_MS: 250,
};

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
const sendRuntimeMessage = (message) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    resolve(response);
  });
});

let activeBackgroundTaskType = null;
let activeBackgroundRunId = null;

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
async function downloadMediaFilesAndWait(mediaFiles, { pollMs = TIMING.DOWNLOAD_POLL_MS } = {}) {
  if (!Array.isArray(mediaFiles) || mediaFiles.length === 0) return;

  const startedAt = Date.now();
  const reloadGraceMs = TIMING.DOWNLOAD_RELOAD_GRACE_MS;
  const hardTimeoutMs = TIMING.DOWNLOAD_HARD_TIMEOUT_MS;
  let cancelSent = false;
  let runId = null;

  const response = await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'startDownloads', media: mediaFiles }, (resp) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      if (!resp?.success) return reject(new Error(resp?.error || 'startDownloads failed'));
      resolve(resp);
    });
  });

  runId = response?.runId || null;
  activeBackgroundTaskType = 'download';
  activeBackgroundRunId = runId;

  try {
    while (true) {
      if (ProgressModal.isCancelled() && !cancelSent) {
        cancelSent = true;
        try {
          await sendRuntimeMessage({ action: 'cancelTaskRun', taskType: 'download', runId });
        } catch (err) {
          console.warn('Failed to cancel download:', err);
        }
      }

      const {
        totalDownloads = 0,
        downloadQueue = [],
        fileProgress = {},
        downloadRunId = null,
      } = await storageGet(['totalDownloads', 'downloadQueue', 'fileProgress', 'downloadRunId']);

      if (downloadRunId && runId && downloadRunId !== runId) {
        throw new Error('download run was replaced by another task');
      }

      const total = totalDownloads || downloadQueue.length || mediaFiles.length;

      let completed = 0;
      let failed = 0;
      let started = 0;
      let queued = 0;
      let cancelled = 0;
      for (const f of downloadQueue) {
        const st = fileProgress?.[f.filename];
        if (st === 'complete') completed++;
        else if (st === 'failed') failed++;
        else if (st === 'started') started++;
        else if (st === 'cancelled') cancelled++;
        else queued++;
      }

      const done = completed + failed + cancelled;
      const pct = total ? Math.round((done / total) * 100) : 0;

      ProgressModal.update(
        pct,
        `Downloads: ${done}/${total} (complete: ${completed}${failed ? `, failed: ${failed}` : ''}${cancelled ? `, cancelled: ${cancelled}` : ''})`
      );

      if (cancelSent && started === 0) {
        throw new Error('Operation cancelled by user');
      }

      if (total && done >= total) break;

      const now = Date.now();
      if (now - startedAt >= reloadGraceMs && started === 0 && done < total) {
        ProgressModal.update(
          pct,
          `Downloads: ${done}/${total} (complete: ${completed}${failed ? `, failed: ${failed}` : ''}${cancelled ? `, cancelled: ${cancelled}` : ''}) - reloading remaining...`
        );
        break;
      }

      if (now - startedAt >= hardTimeoutMs) {
        ProgressModal.update(
          pct,
          `Downloads: ${done}/${total} (complete: ${completed}${failed ? `, failed: ${failed}` : ''}${cancelled ? `, cancelled: ${cancelled}` : ''}) - attempt timeout, retrying remaining...`
        );
        break;
      }

      await sleepRandom(Math.max(50, pollMs));
    }
  } finally {
    if (activeBackgroundTaskType === 'download') activeBackgroundTaskType = null;
    if (activeBackgroundRunId === runId) activeBackgroundRunId = null;
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
    const runId = await downloadMediaFilesAndWait(pending, { pollMs });

    const { downloadQueue = [], fileProgress = {}, downloadRunId = null } =
      await storageGet(['downloadQueue', 'fileProgress', 'downloadRunId']);

    if (downloadRunId && runId && downloadRunId !== runId) {
      throw new Error('download run was replaced by another task');
    }

    const missing = downloadQueue.filter((f) => fileProgress?.[f.filename] !== 'complete');
    if (missing.length === 0) return [];
    pending = missing;

    ProgressModal.update(10, `Reloading ${missing.length} remaining items...`);
  }

  const { downloadQueue = [], fileProgress = {}, downloadRunId = null } =
    await storageGet(['downloadQueue', 'fileProgress', 'downloadRunId']);

  if (downloadRunId === null && downloadQueue.length) {
    throw new Error('download run metadata is missing while checking final results');
  }

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

function countTaskQueueStatuses(queue) {
  let queued = 0;
  let started = 0;
  let complete = 0;
  let failed = 0;

  for (const item of Array.isArray(queue) ? queue : []) {
    if (item?.status === 'queued') queued++;
    else if (item?.status === 'started') started++;
    else if (item?.status === 'complete') complete++;
    else if (item?.status === 'failed') failed++;
  }

  return { queued, started, complete, failed };
}

function progressInRange(startProgress, endProgress, done, total) {
  if (!total) return startProgress;
  const ratio = Math.min(1, Math.max(0, done / total));
  return startProgress + Math.round(ratio * Math.max(0, endProgress - startProgress));
}

function summarizePostCleanupState(rawState) {
  const state = rawState || {};
  const phase = state.phase || 'unlike1';
  const queue = Array.isArray(state.queue) ? state.queue : [];
  const counts = countTaskQueueStatuses(queue);
  const stageTotal = queue.length;
  const stageDone = counts.complete + counts.failed;

  let progress = 10;
  let details = 'Preparing post cleanup...';

  if (phase === 'unlike1') {
    progress = progressInRange(15, 50, stageDone, stageTotal);
    details = `Unfavoriting pass 1 ${stageDone}/${stageTotal}${counts.started ? ` (${counts.started} in flight)` : ''}...`;
  } else if (phase === 'delete1') {
    progress = progressInRange(50, 85, stageDone, stageTotal);
    details = `Deleting posts pass 1 ${stageDone}/${stageTotal}${counts.started ? ` (${counts.started} in flight)` : ''}...`;
  } else if (phase === 'unlike2') {
    progress = progressInRange(85, 93, stageDone, stageTotal);
    details = `Unfavoriting pass 2 ${stageDone}/${stageTotal}${counts.started ? ` (${counts.started} in flight)` : ''}...`;
  } else if (phase === 'delete2') {
    progress = progressInRange(93, 100, stageDone, stageTotal);
    details = `Deleting posts pass 2 ${stageDone}/${stageTotal}${counts.started ? ` (${counts.started} in flight)` : ''}...`;
  }

  if (state.done) {
    progress = 100;
    details = `Done. Unfavorited ${state.unlikeOk || 0}/${(state.allIds || []).length}. Deleted ${state.deleteOk || 0}/${(state.allIds || []).length}.`;
  } else if (state.cancelled) {
    details = `Cancelling post cleanup${counts.started ? ` (${counts.started} in flight)` : ''}...`;
  }

  return {
    progress,
    details,
    done: !!state.done,
    cancelled: !!state.cancelled,
    queued: counts.queued,
    started: counts.started,
    unlikeOk: state.unlikeOk || 0,
    unlikeFail: Array.isArray(state.failedUnlikeIds) ? state.failedUnlikeIds.length : 0,
    deleteOk: state.deleteOk || 0,
    deleteFail: Array.isArray(state.failedDeleteIds) ? state.failedDeleteIds.length : 0,
    runId: state.runId || null,
  };
}

function summarizeAssetDeleteState(rawState) {
  const state = rawState || {};
  const phase = state.phase || 'delete1';
  const queue = Array.isArray(state.queue) ? state.queue : [];
  const counts = countTaskQueueStatuses(queue);
  const stageTotal = queue.length;
  const stageDone = counts.complete + counts.failed;

  let progress = 10;
  let details = 'Preparing file deletion...';

  if (phase === 'delete1') {
    progress = progressInRange(15, 90, stageDone, stageTotal);
    details = `Deleting files pass 1 ${stageDone}/${stageTotal}${counts.started ? ` (${counts.started} in flight)` : ''}...`;
  } else if (phase === 'delete2') {
    progress = progressInRange(90, 100, stageDone, stageTotal);
    details = `Deleting files pass 2 ${stageDone}/${stageTotal}${counts.started ? ` (${counts.started} in flight)` : ''}...`;
  }

  if (state.done) {
    progress = 100;
    details = `Done. Deleted ${state.ok || 0}/${(state.allIds || []).length}.`;
  } else if (state.cancelled) {
    details = `Cancelling file deletion${counts.started ? ` (${counts.started} in flight)` : ''}...`;
  }

  return {
    progress,
    details,
    done: !!state.done,
    cancelled: !!state.cancelled,
    queued: counts.queued,
    started: counts.started,
    ok: state.ok || 0,
    fail: Array.isArray(state.failedIds) ? state.failedIds.length : 0,
    runId: state.runId || null,
  };
}

async function waitForBackgroundTask(taskType, storageKey, summarizeState, runId) {
  let cancelSent = false;
  activeBackgroundTaskType = taskType;
  activeBackgroundRunId = runId;

  try {
    while (true) {
      const snapshot = await storageGet([storageKey]);
      const rawState = snapshot?.[storageKey] || null;
      const summary = summarizeState(rawState);

      if (summary.runId && runId && summary.runId !== runId) {
        throw new Error(`${taskType} run was replaced by another task`);
      }

      ProgressModal.update(summary.progress, summary.details);

      if (ProgressModal.isCancelled() && !cancelSent) {
        cancelSent = true;
        try {
          await sendRuntimeMessage({ action: 'cancelTaskRun', taskType, runId });
        } catch (err) {
          console.warn(`Failed to cancel ${taskType}:`, err);
        }
      }

      const drained = summary.queued === 0 && summary.started === 0;
      if (summary.done || (summary.cancelled && drained)) {
        return { ...summary, cancelled: summary.cancelled || cancelSent };
      }

      await sleepRandom(Math.max(50, TIMING.BACKGROUND_TASK_POLL_MS));
    }
  } finally {
    if (activeBackgroundTaskType === taskType) activeBackgroundTaskType = null;
    if (activeBackgroundRunId === runId) activeBackgroundRunId = null;
  }
}
async function apiUnlikeAndDeleteAll(postIds) {
  const response = await sendRuntimeMessage({ action: 'startPostCleanup', postIds });
  if (!response?.success) throw new Error(response?.error || 'startPostCleanup failed');
  return waitForBackgroundTask('postCleanup', 'postCleanupTaskState', summarizePostCleanupState, response.runId || null);
}

async function apiDeleteAllAssets(assetIds) {
  const response = await sendRuntimeMessage({ action: 'startAssetDelete', assetIds });
  if (!response?.success) throw new Error(response?.error || 'startAssetDelete failed');
  return waitForBackgroundTask('assetDelete', 'assetDeleteTaskState', summarizeAssetDeleteState, response.runId || null);
}

async function handleDownloadAll(collectionLimit = null) {
  ProgressModal.show('Download All', 'Fetching liked posts via API...');

  const mediaById = await collectLikedMediaViaAPI(collectionLimit);

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

async function handleUnfavoriteAll(collectionLimit = null) {
  ProgressModal.show('Unfavorite All', 'Fetching liked posts via API...');

  const mediaById = await collectLikedMediaViaAPI(collectionLimit);

  if (!mediaById.size) {
    ProgressModal.hide();
    alert('No liked posts found.');
    return;
  }

  const { postIds } = buildPostIdsAndMediaFiles(mediaById);

  ProgressModal.update(10, `Found ${postIds.length} liked posts. Unfavoriting + deleting...`);

  const { unlikeOk, unlikeFail, deleteOk, deleteFail, cancelled } = await apiUnlikeAndDeleteAll(postIds);
  if (cancelled) throw new Error('Operation cancelled by user');

  ProgressModal.hide();
  alert(
    `Done. Unfavorited ${unlikeOk}/${postIds.length}${unlikeFail ? `, unlike failed ${unlikeFail}` : ''}. ` +
    `Deleted ${deleteOk}/${postIds.length}${deleteFail ? `, delete failed ${deleteFail}` : ''}.`
  );
  window.location.reload();
}

async function handleDeleteAllFiles(collectionLimit = null) {
  ProgressModal.show('Delete All Files', 'Fetching files via API...');

  const assetIds = await collectAssetsViaAPI(collectionLimit);

  if (!assetIds.length) {
    ProgressModal.hide();
    alert('No files found.');
    return;
  }

  ProgressModal.update(10, `Found ${assetIds.length} file${assetIds.length === 1 ? '' : 's'}. Deleting...`);

  const { ok, fail, cancelled } = await apiDeleteAllAssets(assetIds);
  if (cancelled) throw new Error('Operation cancelled by user');

  ProgressModal.hide();
  alert(`Done. Deleted ${ok}/${assetIds.length}${fail ? `, failed ${fail}` : ''}.`);
  window.location.reload();
}

/* =========================
   Message listener
========================= */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const action = request?.action;
  const collectionLimit = Number.isFinite(request?.collectionLimit) ? request.collectionLimit : null;

  if (action === 'ping') {
    sendResponse({ loaded: true });
    return true;
  }

  if (action === 'cancelOperation') {
    ProgressModal.cancel();
    const activeTaskType = activeBackgroundTaskType;
    const activeRunId = activeBackgroundRunId;
    if (activeTaskType) {
      sendRuntimeMessage({ action: 'cancelTaskRun', taskType: activeTaskType, runId: activeRunId })
        .catch((err) => console.warn('Failed to cancel background task:', err))
        .finally(() => chrome.storage.local.set({ activeOperation: false }));
    } else {
      chrome.storage.local.set({ activeOperation: false });
    }
    sendResponse({ success: true });
    return true;
  }

  (async () => {
    try {
      chrome.storage.local.set({ activeOperation: true });

      if (action === 'downloadAll') {
        await handleDownloadAll(collectionLimit);
      } else if (action === 'unfavoriteAll') {
        await handleUnfavoriteAll(collectionLimit);
      } else if (action === 'deleteAllFiles') {
        await handleDeleteAllFiles(collectionLimit);
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









