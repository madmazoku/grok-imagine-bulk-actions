/**
 * Popup script
 * Page-aware actions: imagine pages for posts, files page for assets
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
  if (action === 'downloadAll' || action === 'unfavoriteAll') return pageKind === 'imagine';
  if (action === 'deleteAllFiles') return pageKind === 'files';
  return false;
}

function disabledTitle(action) {
  if (action === 'deleteAllFiles') return 'Open grok.com/files first';
  return 'Open grok.com/imagine or grok.com/imagine/saved first';
}

function setEnabled(pageKind) {
  for (const id of ['downloadAll', 'unfavoriteAll', 'deleteAllFiles']) {
    const el = document.getElementById(id);
    if (!el) continue;
    const enabled = isActionAllowed(pageKind, id);
    el.disabled = !enabled;
    el.title = enabled ? '' : disabledTitle(id);
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

async function sendAction(action) {
  setStatus('');

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
    await sendMessageToTab(tab.id, { action });
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

  document.getElementById('downloadAll')?.addEventListener('click', () => {
    void sendAction('downloadAll');
  });
  document.getElementById('unfavoriteAll')?.addEventListener('click', () => {
    void sendAction('unfavoriteAll');
  });
  document.getElementById('deleteAllFiles')?.addEventListener('click', () => {
    void sendAction('deleteAllFiles');
  });
});
