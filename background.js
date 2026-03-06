/**
 * Grok Imagine Bulk Actions - Background (Service Worker)
 * NEW VARIANT:
 * - No chrome.downloads.search() (no querying global downloads list)
 * - Fixes "stuck progress" race by using chrome.downloads.onCreated to bind
 *   downloadId -> relative filename early, then onChanged can always update fileProgress.
 * - Filters events by membership in current downloadQueue (so it ignores unrelated downloads)
 * - Keeps:
 *    - downloadQueue: [{url, filename}]  // filename is RELATIVE inside grok-saved/
 *    - fileProgress: { [relativeFilename]: 'queued'|'started'|'complete'|'failed' }
 *    - fileErrors:   { [relativeFilename]: '...' }
 *    - downloadIdToFile: { [downloadId]: relativeFilename }
 *    - downloadProgress (legacy): { [downloadId]: 'complete'|'failed' }
 */

const DOWNLOAD_CONFIG = {
  MAX_CONCURRENT: 4,
  START_GAP_MS: 200,
  RANDOM_VARIATION_PCT: 0.1,
  FOLDER: 'grok-saved',
};

const DOWNLOAD_STATE_KEYS = [
  'downloadQueue',
  'fileProgress',
  'fileErrors',
  'downloadIdToFile',
  'downloadProgress',
];

let stateMutationQueue = Promise.resolve();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepRandom = (meanMs) => {
  const variation = Math.max(0, meanMs * DOWNLOAD_CONFIG.RANDOM_VARIATION_PCT);
  const minMs = Math.max(0, meanMs - variation);
  const maxMs = meanMs + variation;
  return sleep(minMs + Math.random() * (maxMs - minMs));
};

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

function queueDownloadStateMutation(mutator) {
  const run = async () => {
    const s = await storageGet(DOWNLOAD_STATE_KEYS);
    const state = {
      downloadQueue: Array.isArray(s.downloadQueue) ? s.downloadQueue : [],
      fileProgress: { ...(s.fileProgress || {}) },
      fileErrors: { ...(s.fileErrors || {}) },
      downloadIdToFile: { ...(s.downloadIdToFile || {}) },
      downloadProgress: { ...(s.downloadProgress || {}) },
    };

    const result = await mutator(state);

    await storageSet({
      fileProgress: state.fileProgress,
      fileErrors: state.fileErrors,
      downloadIdToFile: state.downloadIdToFile,
      downloadProgress: state.downloadProgress,
    });

    return result;
  };

  const next = stateMutationQueue.then(run, run);
  stateMutationQueue = next.catch((err) => {
    console.error('queueDownloadStateMutation error:', err);
  });
  return next;
}

/**
 * Extract relative path inside DOWNLOAD_CONFIG.FOLDER from a full download path.
 * Example:
 *   ".../Downloads/grok-saved/2026-03-05_18_42/abc.jpg" -> "2026-03-05_18_42/abc.jpg"
 * If marker not found, returns null.
 */
function extractRelativeFilename(fullPath) {
  if (!fullPath) return null;
  const normalized = String(fullPath).replace(/\\/g, '/');
  const marker = `${DOWNLOAD_CONFIG.FOLDER}/`;
  const idx = normalized.lastIndexOf(marker);
  if (idx < 0) return null;
  return normalized.slice(idx + marker.length);
}

/**
 * Returns true if relativeFilename is part of current downloadQueue.
 * Uses downloadQueue stored in chrome.storage.local.
 */
function isInCurrentQueue(relativeFilename, downloadQueue) {
  if (!relativeFilename || !Array.isArray(downloadQueue)) return false;
  // downloadQueue items are { url, filename } where filename is relative within FOLDER
  return downloadQueue.some((f) => f && f.filename === relativeFilename);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action === 'startDownloads') {
    handleDownloads(request.media)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.error('handleDownloads error:', err);
        sendResponse({ success: false, error: err?.message || String(err) });
      });
    return true;
  }
});

/**
 * Initialize and start a download session.
 * media: Array<{ url: string, filename: string }>
 *   filename MUST be relative inside grok-saved/, e.g. "2026-03-05_18_42/abc.jpg"
 */
async function handleDownloads(media) {
  if (!Array.isArray(media) || media.length === 0) {
    throw new Error('No media provided for download');
  }

  // Initialize progress state by filename
  const fileProgress = {};
  for (const item of media) {
    if (item?.filename) fileProgress[item.filename] = 'queued';
  }

  await storageSet({
    totalDownloads: media.length,
    downloadQueue: media,
    fileProgress,
    fileErrors: {},
    downloadIdToFile: {},
    downloadProgress: {},
  });

  // Start with bounded concurrency (no long delayed timers).
  // This avoids overloading while also avoiding MV3 timer-suspension issues.
  await pumpDownloadQueue();
}

async function pumpDownloadQueue() {
  const toStart = await queueDownloadStateMutation((state) => {
    const queue = state.downloadQueue;
    const byFile = state.fileProgress;

    const inFlight = queue.filter((f) => byFile?.[f.filename] === 'started').length;
    const availableSlots = Math.max(0, DOWNLOAD_CONFIG.MAX_CONCURRENT - inFlight);
    if (availableSlots <= 0) return [];

    const picked = queue.filter((f) => byFile?.[f.filename] === 'queued').slice(0, availableSlots);
    for (const item of picked) byFile[item.filename] = 'started';

    return picked;
  });

  if (!Array.isArray(toStart) || toStart.length === 0) return;
  for (const item of toStart) {
    downloadFile(item);
    await sleepRandom(DOWNLOAD_CONFIG.START_GAP_MS);
  }
}

/**
 * Start a single download (records failure if Chrome refuses to start it).
 * Note: mapping downloadId -> filename is set BOTH here (callback) and in onCreated (early).
 */
function downloadFile(item) {
  if (!item?.url || !item?.filename) {
    console.error('Invalid download item:', item);
    return;
  }

  const fullPath = `${DOWNLOAD_CONFIG.FOLDER}/${item.filename}`;
  chrome.downloads.download(
    {
      url: item.url,
      filename: fullPath,
      saveAs: false,
      conflictAction: 'overwrite',
    },
    async (downloadId) => {
      // If Chrome refused to start download, mark it failed so UI can retry.
      if (chrome.runtime.lastError || !downloadId) {
        const errMsg = chrome.runtime.lastError?.message || 'Download did not start';
        console.error('Download start failed:', errMsg, item);
        await queueDownloadStateMutation((state) => {
          state.fileProgress[item.filename] = 'failed';
          state.fileErrors[item.filename] = errMsg;
        });
        void pumpDownloadQueue();
        return;
      }

      // Best-effort mapping (onCreated should do this earlier, but keep this too)
      await queueDownloadStateMutation((state) => {
        state.downloadIdToFile[String(downloadId)] = item.filename;
        if (state.fileProgress[item.filename] === 'queued') state.fileProgress[item.filename] = 'started';
      });
    }
  );
}

/**
 * EARLY binding: when a download is created, bind downloadId -> relative filename.
 * This avoids the race where "complete" arrives before we know filename for that id.
 *
 * We DO NOT query global history; we just react to this event and filter by current queue.
 */
chrome.downloads.onCreated.addListener((downloadItem) => {
  try {
    const relative = extractRelativeFilename(downloadItem?.filename);
    if (!relative) {
      return;
    }

    void queueDownloadStateMutation((state) => {
      const queue = state.downloadQueue || [];
      if (!isInCurrentQueue(relative, queue)) {
        return;
      }

      state.downloadIdToFile[String(downloadItem.id)] = relative;
      if (state.fileProgress[relative] === 'queued') state.fileProgress[relative] = 'started';
    });
  } catch (e) {
    console.error('onCreated handler error:', e);
  }
});

/**
 * Completion tracking: update both legacy by-id progress and fileProgress by filename.
 * Only touches fileProgress if the downloadId belongs to our current queue (mapping exists).
 */
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta?.state) {
    return;
  }

  const state = delta.state.current;
  if (state !== 'complete' && state !== 'interrupted') return;

  void queueDownloadStateMutation((stateObj) => {
    stateObj.downloadProgress[delta.id] = state === 'complete' ? 'complete' : 'failed';

    let filename = stateObj.downloadIdToFile[String(delta.id)];
    if (!filename) {
      const inferred = extractRelativeFilename(delta.filename?.current || delta.filename?.previous);
      if (inferred && isInCurrentQueue(inferred, stateObj.downloadQueue)) {
        filename = inferred;
        stateObj.downloadIdToFile[String(delta.id)] = inferred;
      }
    }

    if (filename) {
      stateObj.fileProgress[filename] = state === 'complete' ? 'complete' : 'failed';
      if (state === 'interrupted' && !stateObj.fileErrors[filename]) {
        stateObj.fileErrors[filename] = delta.error?.current || 'interrupted';
      }
    }
  }).finally(() => {
    void pumpDownloadQueue();
  });
});
