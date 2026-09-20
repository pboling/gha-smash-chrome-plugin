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
  switch (message.type) {
    case 'GET_CSRF_TOKEN': {
      const tabId = sender.tab?.id;
      const token = tabId ? csrfTokens.get(tabId) : null;
      sendResponse({ token });
      break;
    }

    case 'SET_CSRF_TOKEN': {
      const tabId = sender.tab?.id;
      if (tabId && message.token) {
        csrfTokens.set(tabId, message.token);
      }
      sendResponse({ ok: true });
      break;
    }

    case 'API_REQUEST': {
      // Forward API request to GitHub API from background (avoids CORS)
      handleApiRequest(message, sender.tab?.id).then(sendResponse).catch(err => {
        sendResponse({ error: err.message });
      });
      return true; // async response
    }

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

// Handle API requests from content script
async function handleApiRequest(message, tabId) {
  const { method, url, body, headers = {} } = message.payload;

  // Get CSRF token for this tab if available
  const csrfToken = tabId ? csrfTokens.get(tabId) : null;

  const requestHeaders = {
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...headers
  };

  if (csrfToken) {
    requestHeaders['X-CSRF-Token'] = csrfToken;
  }

  const options = {
    method: method || 'GET',
    credentials: 'include',
    headers: requestHeaders
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`${err.message || response.statusText} (${response.status})`);
  }

  return response.json();
}

// Listen for tab updates to clear stale tokens
chrome.tabs.onRemoved.addListener((tabId) => {
  csrfTokens.delete(tabId);
});