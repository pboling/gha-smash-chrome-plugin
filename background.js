/**
 * GH Advisory Smash - Background Service Worker
 * Handles GitHub API calls (cross-origin) and CSRF token storage
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log('[GH Advisory Smash] Extension installed');
});

// Store CSRF tokens per tab
const csrfTokens = new Map();

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (DEBUG) console.log('[BG] Received message:', message.type, sender.tab?.id);
  
  switch (message.type) {
    case 'GET_CSRF_TOKEN': {
      const tabId = sender.tab?.id;
      const token = tabId ? csrfTokens.get(tabId) : null;
      if (DEBUG) console.log('[BG] GET_CSRF_TOKEN:', tabId, token ? 'found' : 'none');
      sendResponse({ token });
      break;
    }

    case 'SET_CSRF_TOKEN': {
      const tabId = sender.tab?.id;
      if (tabId && message.token) {
        csrfTokens.set(tabId, message.token);
        if (DEBUG) console.log('[BG] SET_CSRF_TOKEN for tab', tabId);
      }
      sendResponse({ ok: true });
      break;
    }

    case 'SET_DEBUG': {
      DEBUG = message.enabled === true;
      if (DEBUG) console.log('[BG] Debug mode enabled');
      else console.log('[BG] Debug mode disabled');
      sendResponse({ ok: true });
      break;
    }

    case 'API_REQUEST': {
      // Forward API request to GitHub API from background (avoids CORS)
      handleApiRequest(message, sender).then(sendResponse).catch(err => {
        if (DEBUG) console.log('[BG] API_REQUEST error:', err.message);
        sendResponse({ error: err.message });
      });
      return true; // async response
    }

    default:
      if (DEBUG) console.log('[BG] Unknown message type:', message.type);
      sendResponse({ error: 'Unknown message type' });
  }
});

// Handle API requests from content script
async function handleApiRequest(message, sender) {
  if (DEBUG) console.log('[BG] Handling API request:', message.payload);
  const { method, url, body, headers = {} } = message.payload;

  // Get CSRF token for this tab if available
  const tabId = sender?.tab?.id;
  const csrfToken = tabId ? csrfTokens.get(tabId) : null;
  if (DEBUG) console.log('[BG] CSRF token for tab', tabId, csrfToken ? 'found' : 'none');

  const requestHeaders = {
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...headers
  };

  if (csrfToken) {
    // GitHub uses GitHub-Nonce header for fetch-nonce
    requestHeaders['GitHub-Nonce'] = csrfToken;
  }

  const options = {
    method: method || 'GET',
    credentials: 'include',
    headers: requestHeaders
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  if (DEBUG) console.log('[BG] Fetching:', method, url, { headers: requestHeaders, credentials: 'include', hasBody: !!body });
  const response = await fetch(url, options);

  if (DEBUG) console.log('[BG] Fetch response:', response.status, response.ok, response.headers.get('content-type'));

  // Also send response info back to content script for unified debugging
  if (sender && sender.tab) {
    chrome.runtime.sendMessage({
      type: 'DEBUG_LOG',
      message: `[BG] ${method} ${url} → ${response.status} ${response.ok ? 'OK' : 'FAIL'}`,
      headers: requestHeaders
    }).catch(() => {}); // Ignore if no listener
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const errorMsg = `${err.message || response.statusText} (${response.status})`;
    if (DEBUG) console.log('[BG] API error:', errorMsg);
    throw new Error(errorMsg);
  }

  const result = await response.json();
  if (DEBUG) console.log('[BG] API success:', result);
  return result;
}

// Listen for tab updates to clear stale tokens
chrome.tabs.onRemoved.addListener((tabId) => {
  if (DEBUG) console.log('[BG] Tab removed:', tabId);
  csrfTokens.delete(tabId);
});

// Debug flag from extension
let DEBUG = false;