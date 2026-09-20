/**
 * GH Advisory Smash - Background Service Worker
 * Handles GitHub API calls (cross-origin) using PAT authentication
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log('[GH Advisory Smash] Extension installed');
});

// Cache for PAT (refreshed periodically)
let patCache = null;
let patCacheTime = 0;

async function getPat() {
  // Cache for 30 seconds
  const now = Date.now();
  if (patCache && now - patCacheTime < 30000) {
    return patCache;
  }
  try {
    const result = await chrome.storage.sync.get(['github_pat']);
    patCache = result.github_pat || null;
    patCacheTime = now;
    return patCache;
  } catch (e) {
    if (DEBUG) console.log('[BG] Error loading PAT:', e.message);
    return null;
  }
}

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (DEBUG) console.log('[BG] Received message:', message.type, sender.tab?.id);
  
  switch (message.type) {
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

  // Get PAT (Personal Access Token) - REQUIRED for GitHub REST API
  const pat = await getPat();
  if (DEBUG) console.log('[BG] PAT for API:', pat ? 'found' : 'none');

  const requestHeaders = {
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...headers
  };

  if (!pat) {
    const error = new Error('NO_PAT: GitHub Personal Access Token required. Save a PAT with "repo" scope in the extension popup.');
    if (DEBUG) console.log('[BG] No PAT configured');
    throw error;
  }

  requestHeaders['Authorization'] = `Bearer ${pat}`;
  if (DEBUG) console.log('[BG] Using PAT for authentication');

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