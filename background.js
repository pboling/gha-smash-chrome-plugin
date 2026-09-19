/**
 * GH Advisory Smash - Background Service Worker
 * Minimal: only stores CSRF tokens per tab for authenticated requests
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

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

// Listen for tab updates to clear stale tokens
chrome.tabs.onRemoved.addListener((tabId) => {
  csrfTokens.delete(tabId);
});