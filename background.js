/**
 * Grok Imagine Bulk Actions - Background (Service Worker)
 * Phase-1 background task runner:
 * - Generic in structure so additional background task types can be added later
 * - Currently only the 'download' task type is registered and executed
 * - Uses serialized task-state mutations plus bounded queue pumping
 * - Keeps download compatibility with the existing content-script contract:
 *    - downloadQueue: [{url, filename}]  // filename is RELATIVE inside grok-saved/
 *    - fileProgress: { [relativeFilename]: 'queued'|'started'|'complete'|'failed' }
 *    - fileErrors:   { [relativeFilename]: '...' }
 *    - downloadIdToFile: { [downloadId]: relativeFilename }
 *    - downloadProgress (legacy): { [downloadId]: 'complete'|'failed' }
 * - Download completion still relies on chrome.downloads events:
 *    - onCreated binds downloadId -> filename as early as possible
 *    - onChanged updates completion/failure state and pumps the queue again
 */

const DEFAULT_RANDOM_VARIATION_PCT = 0.1;

// Phase 1: the task runner is generic in shape, but only the download task is registered.
const TASK_TYPES = {
  download: {
    config: {
      maxConcurrent: 4,
      startGapMs: 200,
      randomVariationPct: DEFAULT_RANDOM_VARIATION_PCT,
      folder: 'grok-saved',
    },
    stateKeys: [
      'downloadQueue',
      'fileProgress',
      'fileErrors',
      'downloadIdToFile',
      'downloadProgress',
    ],
    readState(snapshot) {
      return {
        downloadQueue: Array.isArray(snapshot.downloadQueue) ? snapshot.downloadQueue : [],
        fileProgress: { ...(snapshot.fileProgress || {}) },
        fileErrors: { ...(snapshot.fileErrors || {}) },
        downloadIdToFile: { ...(snapshot.downloadIdToFile || {}) },
        downloadProgress: { ...(snapshot.downloadProgress || {}) },
      };
    },
    buildInitialStorage(items) {
      const fileProgress = {};
      for (const item of items) {
        if (item?.filename) fileProgress[item.filename] = 'queued';
      }

      return {
        totalDownloads: items.length,
        downloadQueue: items,
        fileProgress,
        fileErrors: {},
        downloadIdToFile: {},
        downloadProgress: {},
      };
    },
    pickItemsToStart(state) {
      const queue = state.downloadQueue;
      const byFile = state.fileProgress;

      const inFlight = queue.filter((f) => byFile?.[f.filename] === 'started').length;
      const availableSlots = Math.max(0, this.config.maxConcurrent - inFlight);
      if (availableSlots <= 0) return [];

      const picked = queue.filter((f) => byFile?.[f.filename] === 'queued').slice(0, availableSlots);
      for (const item of picked) byFile[item.filename] = 'started';
      return picked;
    },
    extractTrackedKey(fullPath) {
      if (!fullPath) return null;
      const normalized = String(fullPath).replace(/\\/g, '/');
      const marker = `${this.config.folder}/`;
      const idx = normalized.lastIndexOf(marker);
      if (idx < 0) return null;
      return normalized.slice(idx + marker.length);
    },
    isTrackedItem(relativeFilename, state) {
      if (!relativeFilename || !Array.isArray(state.downloadQueue)) return false;
      return state.downloadQueue.some((f) => f && f.filename === relativeFilename);
    },
    applyCreated(state, downloadItem) {
      const relative = this.extractTrackedKey(downloadItem?.filename);
      if (!relative || !this.isTrackedItem(relative, state)) return;

      state.downloadIdToFile[String(downloadItem.id)] = relative;
      if (state.fileProgress[relative] === 'queued') state.fileProgress[relative] = 'started';
    },
    applyChanged(state, delta) {
      const eventState = delta?.state?.current;
      if (eventState !== 'complete' && eventState !== 'interrupted') return false;

      state.downloadProgress[delta.id] = eventState === 'complete' ? 'complete' : 'failed';

      let filename = state.downloadIdToFile[String(delta.id)];
      if (!filename) {
        const inferred = this.extractTrackedKey(delta.filename?.current || delta.filename?.previous);
        if (inferred && this.isTrackedItem(inferred, state)) {
          filename = inferred;
          state.downloadIdToFile[String(delta.id)] = inferred;
        }
      }

      if (filename) {
        state.fileProgress[filename] = eventState === 'complete' ? 'complete' : 'failed';
        if (eventState === 'interrupted' && !state.fileErrors[filename]) {
          state.fileErrors[filename] = delta.error?.current || 'interrupted';
        }
      }

      return true;
    },
  },
};

const taskMutationQueues = Object.create(null);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sleepRandom(meanMs, variationPct = DEFAULT_RANDOM_VARIATION_PCT) {
  const variation = Math.max(0, meanMs * variationPct);
  const minMs = Math.max(0, meanMs - variation);
  const maxMs = meanMs + variation;
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

function getTaskType(taskType) {
  const task = TASK_TYPES[taskType];
  if (!task) throw new Error(`Unknown task type: ${taskType}`);
  return task;
}

function queueTaskStateMutation(taskType, mutator) {
  const task = getTaskType(taskType);
  const currentQueue = taskMutationQueues[taskType] || Promise.resolve();

  const run = async () => {
    const snapshot = await storageGet(task.stateKeys);
    const state = task.readState(snapshot);

    const result = await mutator(state);

    await storageSet({
      fileProgress: state.fileProgress,
      fileErrors: state.fileErrors,
      downloadIdToFile: state.downloadIdToFile,
      downloadProgress: state.downloadProgress,
    });

    return result;
  };

  const next = currentQueue.then(run, run);
  taskMutationQueues[taskType] = next.catch((err) => {
    console.error(`queueTaskStateMutation(${taskType}) error:`, err);
  });
  return next;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action === 'startDownloads') {
    startTaskRun('download', request.media)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.error('startTaskRun(download) error:', err);
        sendResponse({ success: false, error: err?.message || String(err) });
      });
    return true;
  }
});

/**
 * Initialize and start a task run.
 * Phase 1 still uses the download-only message contract:
 *   media: Array<{ url: string, filename: string }>
 *   filename MUST be relative inside grok-saved/, e.g. "2026-03-05_18-42/abc.jpg"
 */
async function startTaskRun(taskType, items) {
  const task = getTaskType(taskType);
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`No items provided for ${taskType}`);
  }

  await storageSet(task.buildInitialStorage(items));
  await pumpTaskQueue(taskType);
}

async function pumpTaskQueue(taskType) {
  const task = getTaskType(taskType);
  const toStart = await queueTaskStateMutation(taskType, (state) => task.pickItemsToStart(state));

  if (!Array.isArray(toStart) || toStart.length === 0) return;
  for (const item of toStart) {
    startDownloadItem(item);
    await sleepRandom(task.config.startGapMs, task.config.randomVariationPct);
  }
}

/**
 * Download task implementation: starts one queued download item.
 * Records start failure in task state if Chrome refuses the download.
 * Note: mapping downloadId -> filename is set BOTH here (callback) and in onCreated (early).
 */
function startDownloadItem(item) {
  const task = getTaskType('download');
  if (!item?.url || !item?.filename) {
    console.error('Invalid download item:', item);
    return;
  }

  const fullPath = `${task.config.folder}/${item.filename}`;
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
        await queueTaskStateMutation('download', (state) => {
          state.fileProgress[item.filename] = 'failed';
          state.fileErrors[item.filename] = errMsg;
        });
        void pumpTaskQueue('download');
        return;
      }

      // Best-effort mapping (onCreated should do this earlier, but keep this too)
      await queueTaskStateMutation('download', (state) => {
        state.downloadIdToFile[String(downloadId)] = item.filename;
        if (state.fileProgress[item.filename] === 'queued') state.fileProgress[item.filename] = 'started';
      });
    }
  );
}

/**
 * Download task event hook:
 * bind downloadId -> relative filename as early as possible to avoid completion races.
 */
chrome.downloads.onCreated.addListener((downloadItem) => {
  try {
    const task = getTaskType('download');
    void queueTaskStateMutation('download', (state) => {
      task.applyCreated(state, downloadItem);
    });
  } catch (e) {
    console.error('onCreated handler error:', e);
  }
});

/**
 * Download task completion hook:
 * update both legacy by-id progress and fileProgress by filename,
 * then try to pump more queued work for the download task.
 */
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta?.state) {
    return;
  }

  const eventState = delta.state.current;
  if (eventState !== 'complete' && eventState !== 'interrupted') return;

  const task = getTaskType('download');
  void queueTaskStateMutation('download', (stateObj) => {
    task.applyChanged(stateObj, delta);
  }).finally(() => {
    void pumpTaskQueue('download');
  });
});
