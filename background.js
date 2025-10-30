// background.js (MV3 service worker) — drop this into your extension root and reload the extension
console.log('[bg] background service worker starting', new Date().toISOString());

self.addEventListener('install', (evt) => {
  console.log('[bg] install event');
  self.skipWaiting();
});

self.addEventListener('activate', (evt) => {
  console.log('[bg] activate event');
  // claim clients so immediate popup messaging works when debugging
  evt.waitUntil(self.clients.claim());
});

// helper: safe fetch with credentials included and text/arrayBuffer return
async function doFetchText(url) {
  try {
    const resp = await fetch(url, { method: 'GET', credentials: 'include' });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, statusText: resp.statusText, text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function doFetchArrayBuffer(url) {
  try {
    const resp = await fetch(url, { method: 'GET', credentials: 'include' });
    if (!resp.ok) return { ok: false, status: resp.status, statusText: resp.statusText };
    const buffer = await resp.arrayBuffer();
    return { ok: true, status: resp.status, buffer };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Message listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[bg] onMessage received:', msg && msg.action, 'from', sender && sender.id);
  if (!msg || !msg.action) {
    sendResponse({ ok: false, error: 'no action' });
    return true;
  }

  if (msg.action === 'fetchUrlText') {
    (async () => {
      const out = await doFetchText(msg.url);
      console.log('[bg] fetchUrlText ->', out && (out.status || out.error));
      sendResponse(out);
    })();
    return true; // indicate we'll call sendResponse asynchronously
  }

  if (msg.action === 'fetchPdfArrayBuffer') {
    (async () => {
      const out = await doFetchArrayBuffer(msg.url);
      console.log('[bg] fetchPdfArrayBuffer ->', out && (out.status || out.error));
      // Beware: arrayBuffer can't be structured-cloned in all cases cross-context; it usually is
      sendResponse(out);
    })();
    return true;
  }

  // default
  sendResponse({ ok: false, error: 'unknown action' });
  return false;
});
