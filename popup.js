/**
 * Popup script
 * Page-aware download and asset deletion actions
 * Single approach: sendMessage only (no script injection fallback)
 */

function getPageKind(rawUrl) {
  try {
    const url = new URL(rawUrl || '');
    if (url.hostname !== 'grok.com') return 'other';

    const p = url.pathname || '/';
    if (p === '/imagine' || p === '/imagine/' || p === '/imagine/saved' || p.startsWith('/imagine/saved/')) {
      return 'imagine';
    }
    if (p === '/files' || p === '/files/' || p.startsWith('/files/')) {
      return 'files';
    }
    return 'other';
  } catch {
    return 'other';
  }
}

function isActionAllowed(pageKind, action) {
  if (action.startsWith('downloadAll')) return pageKind === 'imagine' || pageKind === 'files';
  if (action.startsWith('deleteAll')) return pageKind === 'imagine' || pageKind === 'files';
  return false;
}

const BUTTON_ACTIONS = {
  downloadAllGenerated: { action: 'downloadAllGenerated' },
  downloadAllMedia: { action: 'downloadAllMedia' },
  deleteAllGenerated: { action: 'deleteAllGenerated' },
  deleteAllMedia: { action: 'deleteAllMedia' },
  deleteAllAssets: { action: 'deleteAllAssets' },
};

function disabledTitle(action) {
  if (action.startsWith('deleteAll')) return 'Open grok.com/imagine, grok.com/imagine/saved, or grok.com/files first';
  return 'Open grok.com/imagine, grok.com/imagine/saved, or grok.com/files first';
}

function confirmAction(action) {
  const messages = {
    deleteAllGenerated: 'Delete all generated image and video assets?',
    deleteAllMedia: 'Delete all generated and uploaded image and video assets?',
    deleteAllAssets: 'Delete every asset, including non-media files?',
  };
  return !messages[action] || window.confirm(messages[action]);
}

function setEnabled(pageKind) {
  for (const [id, config] of Object.entries(BUTTON_ACTIONS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const enabled = isActionAllowed(pageKind, config.action);
    el.disabled = !enabled;
    el.title = enabled ? '' : disabledTitle(config.action);
  }
}

function setStatus(msg) {
  const el = document.getElementById('status');
  if (!el) return;
  el.style.display = msg ? 'block' : 'none';
  el.textContent = msg || '';
}

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs && tabs[0]));
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

async function sendAction(action, collectionLimit = null) {
  setStatus('');
  if (!confirmAction(action)) return;

  const tab = await queryActiveTab();
  if (!tab?.id) {
    setStatus('No active tab found.');
    return;
  }

  const pageKind = getPageKind(tab.url || '');
  if (!isActionAllowed(pageKind, action)) {
    setStatus(disabledTitle(action));
    return;
  }

  try {
    const message = collectionLimit === null ? { action } : { action, collectionLimit };
    await sendMessageToTab(tab.id, message);
    window.close();
  } catch (e) {
    setStatus(`Action failed: ${e?.message || e}`);
  }
}

async function checkReceiver(tab) {
  if (!tab?.id) return;
  const pageKind = getPageKind(tab.url || '');
  if (pageKind === 'other') return;

  try {
    const resp = await sendMessageToTab(tab.id, { action: 'ping' });
    if (!resp?.loaded) {
      setStatus('Content script did not respond. Reload this page after reloading the extension.');
      setEnabled('other');
    }
  } catch {
    setStatus('Content script is not loaded in this tab. Reload this page after reloading the extension.');
    setEnabled('other');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const tab = await queryActiveTab();
  setEnabled(getPageKind(tab?.url || ''));
  await checkReceiver(tab);

  for (const [id, config] of Object.entries(BUTTON_ACTIONS)) {
    document.getElementById(id)?.addEventListener('click', () => {
      void sendAction(config.action, config.collectionLimit ?? null);
    });
  }
});
