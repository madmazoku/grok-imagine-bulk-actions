/**
 * Grok Imagine Bulk Actions - Background (Service Worker)
 * Background task runner:
 * - Bounded queue pumping with randomized start gaps
 * - Serialized task-state mutations in chrome.storage.local
 * - Download, post cleanup, and asset deletion task types
 * - Only one background task run is allowed at a time across all task types
 * - Download compatibility is preserved for the existing content-script contract
 */

const DEFAULT_RANDOM_VARIATION_PCT = 0.1;
const BACKGROUND_TASK_LOCK_KEY = 'backgroundTaskLock';
const API = {
  UNLIKE: 'https://grok.com/rest/media/post/unlike',
  DELETE: 'https://grok.com/rest/media/post/delete',
  ASSETS: 'https://grok.com/rest/assets',
};

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

function uniqueIds(items) {
  return Array.from(new Set((Array.isArray(items) ? items : []).filter(Boolean).map((item) => String(item))));
}

function buildQueuedItems(ids, extra = {}) {
  return ids.map((id) => ({ id, status: 'queued', ...extra }));
}

function findQueueItem(queue, item) {
  return queue.find((entry) => entry.id === item.id && entry.operation === item.operation && entry.pass === item.pass);
}

function countQueued(queue, status) {
  return (Array.isArray(queue) ? queue : []).filter((item) => item?.status === status).length;
}

function isStageFinished(queue) {
  return countQueued(queue, 'queued') === 0 && countQueued(queue, 'started') === 0;
}

function pushUnique(list, value) {
  if (!Array.isArray(list) || !value || list.includes(value)) return;
  list.push(value);
}

function removeValue(list, value) {
  if (!Array.isArray(list)) return;
  const index = list.indexOf(value);
  if (index >= 0) list.splice(index, 1);
}

function createRunId(taskType) {
  return `${taskType}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function hasLiveTaskRun(state) {
  return !!state?.runId && !state?.done;
}

function cancelQueuedItems(queue) {
  if (!Array.isArray(queue)) return;
  for (const item of queue) {
    if (item?.status === 'queued') item.status = 'cancelled';
  }
}

function buildPostCleanupInitialState(items, runId) {
  const postIds = uniqueIds(items);
  return {
    runId,
    allIds: postIds,
    phase: 'unlike1',
    queue: buildQueuedItems(postIds, { operation: 'unlike', pass: 1 }),
    failedUnlikeIds: [],
    failedDeleteIds: [],
    unlikeOk: 0,
    deleteOk: 0,
    errors: {},
    done: false,
    cancelled: false,
  };
}

function advancePostCleanupPhase(state) {
  if (state.phase === 'unlike1') {
    state.phase = 'delete1';
    state.queue = buildQueuedItems(state.allIds, { operation: 'delete', pass: 1 });
    return;
  }

  if (state.phase === 'delete1') {
    if (state.failedUnlikeIds.length) {
      state.phase = 'unlike2';
      state.queue = buildQueuedItems(state.failedUnlikeIds, { operation: 'unlike', pass: 2 });
      return;
    }
    if (state.failedDeleteIds.length) {
      state.phase = 'delete2';
      state.queue = buildQueuedItems(state.failedDeleteIds, { operation: 'delete', pass: 2 });
      return;
    }
    state.done = true;
    return;
  }

  if (state.phase === 'unlike2') {
    if (state.failedDeleteIds.length) {
      state.phase = 'delete2';
      state.queue = buildQueuedItems(state.failedDeleteIds, { operation: 'delete', pass: 2 });
      return;
    }
    state.done = true;
    return;
  }

  state.done = true;
}

function applyPostCleanupResult(state, item, result) {
  const queueItem = findQueueItem(state.queue, item);
  if (!queueItem || queueItem.status === 'complete' || queueItem.status === 'failed' || queueItem.status === 'cancelled') return;

  const resultOk = !!result?.ok;
  queueItem.status = resultOk ? 'complete' : 'failed';

  const errorKey = `${item.operation}:${item.id}:pass${item.pass}`;
  if (!resultOk) state.errors[errorKey] = result?.error || 'Request failed';

  if (item.operation === 'unlike') {
    if (resultOk) {
      state.unlikeOk++;
      if (item.pass > 1) removeValue(state.failedUnlikeIds, item.id);
    } else if (item.pass === 1) {
      pushUnique(state.failedUnlikeIds, item.id);
    }
  } else {
    if (resultOk) {
      state.deleteOk++;
      if (item.pass > 1) removeValue(state.failedDeleteIds, item.id);
    } else if (item.pass === 1) {
      pushUnique(state.failedDeleteIds, item.id);
    }
  }

  if (state.cancelled) {
    if (isStageFinished(state.queue)) state.done = true;
    return;
  }

  if (!state.done && isStageFinished(state.queue)) {
    advancePostCleanupPhase(state);
  }
}

function buildAssetDeleteInitialState(items, runId) {
  const assetIds = uniqueIds(items);
  return {
    runId,
    allIds: assetIds,
    phase: 'delete1',
    queue: buildQueuedItems(assetIds, { operation: 'delete', pass: 1 }),
    failedIds: [],
    ok: 0,
    errors: {},
    done: false,
    cancelled: false,
  };
}

function advanceAssetDeletePhase(state) {
  if (state.phase === 'delete1' && state.failedIds.length) {
    state.phase = 'delete2';
    state.queue = buildQueuedItems(state.failedIds, { operation: 'delete', pass: 2 });
    return;
  }
  state.done = true;
}

function applyAssetDeleteResult(state, item, result) {
  const queueItem = findQueueItem(state.queue, item);
  if (!queueItem || queueItem.status === 'complete' || queueItem.status === 'failed' || queueItem.status === 'cancelled') return;

  const resultOk = !!result?.ok;
  queueItem.status = resultOk ? 'complete' : 'failed';

  const errorKey = `delete:${item.id}:pass${item.pass}`;
  if (!resultOk) state.errors[errorKey] = result?.error || 'Request failed';

  if (resultOk) {
    state.ok++;
    if (item.pass > 1) removeValue(state.failedIds, item.id);
  } else if (item.pass === 1) {
    pushUnique(state.failedIds, item.id);
  }

  if (state.cancelled) {
    if (isStageFinished(state.queue)) state.done = true;
    return;
  }

  if (!state.done && isStageFinished(state.queue)) {
    advanceAssetDeletePhase(state);
  }
}

function isDownloadRunComplete(state) {
  const fileProgress = state?.fileProgress || {};
  const values = Object.values(fileProgress);
  if (values.length === 0) return true;
  return values.every((status) => status === 'complete' || status === 'failed' || status === 'cancelled');
}

const TASK_TYPES = {
  download: {
    config: {
      maxConcurrent: 4,
      startGapMs: 200,
      randomVariationPct: DEFAULT_RANDOM_VARIATION_PCT,
      folder: 'grok-saved',
    },
    stateKeys: ['downloadQueue', 'fileProgress', 'fileErrors', 'downloadIdToFile', 'downloadProgress', 'downloadRunId', 'downloadCancelled'],
    readState(snapshot) {
      return {
        downloadQueue: Array.isArray(snapshot.downloadQueue) ? snapshot.downloadQueue : [],
        fileProgress: { ...(snapshot.fileProgress || {}) },
        fileErrors: { ...(snapshot.fileErrors || {}) },
        downloadIdToFile: { ...(snapshot.downloadIdToFile || {}) },
        downloadProgress: { ...(snapshot.downloadProgress || {}) },
        downloadRunId: snapshot.downloadRunId || null,
        downloadCancelled: !!snapshot.downloadCancelled,
      };
    },
    writeState(state) {
      return {
        fileProgress: state.fileProgress,
        fileErrors: state.fileErrors,
        downloadIdToFile: state.downloadIdToFile,
        downloadProgress: state.downloadProgress,
        downloadRunId: state.downloadRunId,
        downloadCancelled: state.downloadCancelled,
      };
    },
    buildInitialStorage(items, runId) {
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
        downloadRunId: runId,
        downloadCancelled: false,
      };
    },
    pickItemsToStart(state) {
      if (state.downloadCancelled) return [];
      const queue = state.downloadQueue;
      const byFile = state.fileProgress;
      const inFlight = queue.filter((item) => byFile?.[item.filename] === 'started').length;
      const availableSlots = Math.max(0, this.config.maxConcurrent - inFlight);
      if (availableSlots <= 0) return [];

      const picked = queue.filter((item) => byFile?.[item.filename] === 'queued').slice(0, availableSlots);
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
      return state.downloadQueue.some((item) => item?.filename === relativeFilename);
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
  postCleanup: {
    config: {
      maxConcurrent: 4,
      startGapMs: 180,
      randomVariationPct: DEFAULT_RANDOM_VARIATION_PCT,
      storageKey: 'postCleanupTaskState',
    },
    stateKeys: ['postCleanupTaskState'],
    readState(snapshot) {
      const raw = snapshot.postCleanupTaskState || {};
      return {
        runId: raw.runId || null,
        allIds: Array.isArray(raw.allIds) ? raw.allIds.slice() : [],
        phase: raw.phase || 'unlike1',
        queue: Array.isArray(raw.queue) ? raw.queue.map((item) => ({ ...item })) : [],
        failedUnlikeIds: Array.isArray(raw.failedUnlikeIds) ? raw.failedUnlikeIds.slice() : [],
        failedDeleteIds: Array.isArray(raw.failedDeleteIds) ? raw.failedDeleteIds.slice() : [],
        unlikeOk: Number.isFinite(raw.unlikeOk) ? raw.unlikeOk : 0,
        deleteOk: Number.isFinite(raw.deleteOk) ? raw.deleteOk : 0,
        errors: { ...(raw.errors || {}) },
        done: !!raw.done,
        cancelled: !!raw.cancelled,
      };
    },
    writeState(state) {
      return { postCleanupTaskState: state };
    },
    buildInitialStorage(items, runId) {
      return { postCleanupTaskState: buildPostCleanupInitialState(items, runId) };
    },
    pickItemsToStart(state) {
      if (state.done || state.cancelled) return [];
      const inFlight = countQueued(state.queue, 'started');
      const availableSlots = Math.max(0, this.config.maxConcurrent - inFlight);
      if (availableSlots <= 0) return [];

      const picked = state.queue.filter((item) => item.status === 'queued').slice(0, availableSlots);
      for (const item of picked) item.status = 'started';
      return picked.map((item) => ({ id: item.id, operation: item.operation, pass: item.pass }));
    },
    async executeItem(item) {
      const url = item.operation === 'unlike' ? API.UNLIKE : API.DELETE;
      const resp = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: '*/*' },
        body: JSON.stringify({ id: item.id }),
      });
      return { ok: resp.ok, error: resp.ok ? '' : `HTTP ${resp.status}` };
    },
    applyItemResult(state, item, result) {
      applyPostCleanupResult(state, item, result);
    },
  },
  assetDelete: {
    config: {
      maxConcurrent: 4,
      startGapMs: 180,
      randomVariationPct: DEFAULT_RANDOM_VARIATION_PCT,
      storageKey: 'assetDeleteTaskState',
    },
    stateKeys: ['assetDeleteTaskState'],
    readState(snapshot) {
      const raw = snapshot.assetDeleteTaskState || {};
      return {
        runId: raw.runId || null,
        allIds: Array.isArray(raw.allIds) ? raw.allIds.slice() : [],
        phase: raw.phase || 'delete1',
        queue: Array.isArray(raw.queue) ? raw.queue.map((item) => ({ ...item })) : [],
        failedIds: Array.isArray(raw.failedIds) ? raw.failedIds.slice() : [],
        ok: Number.isFinite(raw.ok) ? raw.ok : 0,
        errors: { ...(raw.errors || {}) },
        done: !!raw.done,
        cancelled: !!raw.cancelled,
      };
    },
    writeState(state) {
      return { assetDeleteTaskState: state };
    },
    buildInitialStorage(items, runId) {
      return { assetDeleteTaskState: buildAssetDeleteInitialState(items, runId) };
    },
    pickItemsToStart(state) {
      if (state.done || state.cancelled) return [];
      const inFlight = countQueued(state.queue, 'started');
      const availableSlots = Math.max(0, this.config.maxConcurrent - inFlight);
      if (availableSlots <= 0) return [];

      const picked = state.queue.filter((item) => item.status === 'queued').slice(0, availableSlots);
      for (const item of picked) item.status = 'started';
      return picked.map((item) => ({ id: item.id, operation: item.operation, pass: item.pass }));
    },
    async executeItem(item) {
      const resp = await fetch(`${API.ASSETS}/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { Accept: '*/*' },
      });
      return { ok: resp.ok, error: resp.ok ? '' : `HTTP ${resp.status}` };
    },
    applyItemResult(state, item, result) {
      applyAssetDeleteResult(state, item, result);
    },
  },
};

const taskMutationQueues = Object.create(null);
let globalTaskLockQueue = Promise.resolve();

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
    await storageSet(task.writeState(state));
    return result;
  };

  const next = currentQueue.then(run, run);
  taskMutationQueues[taskType] = next.catch((err) => {
    console.error(`queueTaskStateMutation(${taskType}) error:`, err);
  });
  return next;
}

function queueGlobalTaskLockMutation(mutator) {
  const run = async () => {
    const snapshot = await storageGet([BACKGROUND_TASK_LOCK_KEY]);
    const currentLock = snapshot[BACKGROUND_TASK_LOCK_KEY] || null;
    const nextLock = await mutator(currentLock);
    await storageSet({ [BACKGROUND_TASK_LOCK_KEY]: nextLock || null });
    return nextLock;
  };

  const next = globalTaskLockQueue.then(run, run);
  globalTaskLockQueue = next.catch((err) => {
    console.error('queueGlobalTaskLockMutation error:', err);
  });
  return next;
}

function releaseGlobalTaskLock(taskType, runId) {
  return queueGlobalTaskLockMutation((currentLock) => {
    if (!currentLock?.taskType || !currentLock?.runId) return null;
    if (currentLock.taskType !== taskType || currentLock.runId !== runId) return currentLock;
    return null;
  });
}
async function isTaskRunStillLive(taskType, runId) {
  if (!taskType || !runId) return false;
  const task = getTaskType(taskType);
  const snapshot = await storageGet(task.stateKeys);
  const state = task.readState(snapshot);
  if (taskType === 'download') {
    return state.downloadRunId === runId && !isDownloadRunComplete(state);
  }
  return state.runId === runId && !state.done;
}
async function acquireGlobalTaskLock(taskType, runId) {
  const acquired = await queueGlobalTaskLockMutation(async (currentLock) => {
    if (currentLock?.taskType && currentLock?.runId) {
      const isLive = await isTaskRunStillLive(currentLock.taskType, currentLock.runId);
      if (isLive) {
        throw new Error(`Background task already running: ${currentLock.taskType}`);
      }
    }
    return { taskType, runId, startedAt: Date.now() };
  });
  return acquired;
}
async function maybeReleaseTaskLock(taskType, runId, done) {
  if (!done || !runId) return;
  await releaseGlobalTaskLock(taskType, runId);
}

async function startTaskRun(taskType, items) {
  const task = getTaskType(taskType);
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`No items provided for ${taskType}`);
  }

  const runId = createRunId(taskType);
  await acquireGlobalTaskLock(taskType, runId);

  try {
    if (taskType === 'download') {
      await storageSet(task.buildInitialStorage(items, runId));
    } else {
      await queueTaskStateMutation(taskType, (state) => {
        if (hasLiveTaskRun(state)) {
          throw new Error(`${taskType} already running`);
        }

        const initialState = task.readState(task.buildInitialStorage(items, runId));
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, initialState);
        return { runId };
      });
    }

    await pumpTaskQueue(taskType);
    return { runId };
  } catch (err) {
    await releaseGlobalTaskLock(taskType, runId);
    throw err;
  }
}

async function cancelTaskRun(taskType, runId = null) {
  if (taskType === 'download') {
    const result = await queueTaskStateMutation('download', (state) => {
      if (!state.downloadRunId) throw new Error('download is not running');
      if (runId && state.downloadRunId !== runId) throw new Error('download run mismatch');
      state.downloadCancelled = true;
      for (const item of state.downloadQueue) {
        if (state.fileProgress[item.filename] === 'queued') {
          state.fileProgress[item.filename] = 'cancelled';
        }
      }
      return {
        runId: state.downloadRunId,
        done: isDownloadRunComplete(state),
      };
    });
    await maybeReleaseTaskLock('download', result?.runId || null, !!result?.done);
    return { runId: result?.runId || null };
  }

  const result = await queueTaskStateMutation(taskType, (state) => {
    if (!state.runId) throw new Error(`${taskType} is not running`);
    if (runId && state.runId !== runId) throw new Error(`${taskType} run mismatch`);
    state.cancelled = true;
    cancelQueuedItems(state.queue);
    if (isStageFinished(state.queue)) state.done = true;
    return {
      runId: state.runId,
      done: !!state.done,
    };
  });
  await maybeReleaseTaskLock(taskType, result?.runId || null, !!result?.done);
  return { runId: result?.runId || null };
}

async function pumpTaskQueue(taskType) {
  const task = getTaskType(taskType);
  const toStart = await queueTaskStateMutation(taskType, (state) => task.pickItemsToStart(state));

  if (!Array.isArray(toStart) || toStart.length === 0) return;
  for (const item of toStart) {
    if (taskType === 'download') {
      startDownloadItem(item);
    } else {
      void startAsyncTaskItem(taskType, item);
    }
    await sleepRandom(task.config.startGapMs, task.config.randomVariationPct);
  }
}

async function startAsyncTaskItem(taskType, item) {
  const task = getTaskType(taskType);
  let mutationResult = null;

  try {
    const result = await task.executeItem(item);
    mutationResult = await queueTaskStateMutation(taskType, (state) => {
      task.applyItemResult(state, item, result);
      return { runId: state.runId, done: !!state.done };
    });
  } catch (err) {
    mutationResult = await queueTaskStateMutation(taskType, (state) => {
      task.applyItemResult(state, item, {
        ok: false,
        error: err?.message || String(err),
      });
      return { runId: state.runId, done: !!state.done };
    });
  } finally {
    await maybeReleaseTaskLock(taskType, mutationResult?.runId || null, !!mutationResult?.done);
    void pumpTaskQueue(taskType);
  }
}

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
      if (chrome.runtime.lastError || !downloadId) {
        const errMsg = chrome.runtime.lastError?.message || 'Download did not start';
        console.error('Download start failed:', errMsg, item);
        const result = await queueTaskStateMutation('download', (state) => {
          state.fileProgress[item.filename] = 'failed';
          state.fileErrors[item.filename] = errMsg;
          return { runId: state.downloadRunId, done: isDownloadRunComplete(state) };
        });
        await maybeReleaseTaskLock('download', result?.runId || null, !!result?.done);
        void pumpTaskQueue('download');
        return;
      }

      await queueTaskStateMutation('download', (state) => {
        state.downloadIdToFile[String(downloadId)] = item.filename;
        if (state.fileProgress[item.filename] === 'queued') state.fileProgress[item.filename] = 'started';
      });
    }
  );
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action === 'startDownloads') {
    startTaskRun('download', request.media)
      .then((result) => sendResponse({ success: true, runId: result.runId }))
      .catch((err) => {
        console.error('startTaskRun(download) error:', err);
        sendResponse({ success: false, error: err?.message || String(err) });
      });
    return true;
  }

  if (request?.action === 'startPostCleanup') {
    startTaskRun('postCleanup', request.postIds)
      .then((result) => sendResponse({ success: true, runId: result.runId }))
      .catch((err) => {
        console.error('startTaskRun(postCleanup) error:', err);
        sendResponse({ success: false, error: err?.message || String(err) });
      });
    return true;
  }

  if (request?.action === 'startAssetDelete') {
    startTaskRun('assetDelete', request.assetIds)
      .then((result) => sendResponse({ success: true, runId: result.runId }))
      .catch((err) => {
        console.error('startTaskRun(assetDelete) error:', err);
        sendResponse({ success: false, error: err?.message || String(err) });
      });
    return true;
  }

  if (request?.action === 'cancelTaskRun' && request?.taskType) {
    cancelTaskRun(request.taskType, request.runId || null)
      .then((result) => sendResponse({ success: true, runId: result?.runId || null }))
      .catch((err) => {
        console.error(`cancelTaskRun(${request.taskType}) error:`, err);
        sendResponse({ success: false, error: err?.message || String(err) });
      });
    return true;
  }
});

chrome.downloads.onCreated.addListener((downloadItem) => {
  try {
    const task = getTaskType('download');
    void queueTaskStateMutation('download', (state) => {
      task.applyCreated(state, downloadItem);
    });
  } catch (err) {
    console.error('onCreated handler error:', err);
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta?.state) return;

  const eventState = delta.state.current;
  if (eventState !== 'complete' && eventState !== 'interrupted') return;

  const task = getTaskType('download');
  void queueTaskStateMutation('download', (state) => {
    task.applyChanged(state, delta);
    return { runId: state.downloadRunId, done: isDownloadRunComplete(state) };
  }).then((result) => maybeReleaseTaskLock('download', result?.runId || null, !!result?.done))
    .catch((err) => {
      console.error('onChanged handler error:', err);
    })
    .finally(() => {
      void pumpTaskQueue('download');
    });
});






