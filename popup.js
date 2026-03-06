/**
 * Popup script
 * Only two actions: Download All, Unfavorite + Delete All
 * Single approach: sendMessage only (no script injection fallback)
 */

function isSupportedUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || '');
    if (url.hostname !== 'grok.com') return false;

    const p = url.pathname || '/';
    return p === '/imagine' || p === '/imagine/' || p === '/imagine/saved' || p.startsWith('/imagine/saved/');
  } catch {
    return false;
  }
}

function setEnabled(enabled) {
  for (const id of ['downloadAll', 'unfavoriteAll']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.disabled = !enabled;
    el.title = enabled ? '' : 'Open grok.com/imagine or grok.com/imagine/saved first';
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

  if (!isSupportedUrl(tab.url || '')) {
    setStatus('Open a grok.com/imagine or /imagine/saved page first.');
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
  if (!isSupportedUrl(tab.url || '')) return;

  try {
    const resp = await sendMessageToTab(tab.id, { action: 'ping' });
    if (!resp?.loaded) {
      setStatus('Content script did not respond. Reload this page after reloading the extension.');
      setEnabled(false);
    }
  } catch {
    setStatus('Content script is not loaded in this tab. Reload this page after reloading the extension.');
    setEnabled(false);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const tab = await queryActiveTab();
  setEnabled(isSupportedUrl(tab?.url || ''));
  await checkReceiver(tab);

  document.getElementById('downloadAll')?.addEventListener('click', () => {
    void sendAction('downloadAll');
  });
  document.getElementById('unfavoriteAll')?.addEventListener('click', () => {
    void sendAction('unfavoriteAll');
  });
});
