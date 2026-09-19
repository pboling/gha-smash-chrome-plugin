/**
 * GH Advisory Smash - Popup Script
 * Communicates with content script to show status and selected count
 */

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const pageUrlEl = document.getElementById('pageUrl');
const selectedCountEl = document.getElementById('selectedCount');

function updateStatus(active, message) {
  statusDot.style.background = active ? '#238636' : '#f85149';
  statusText.textContent = message;
}

async function getTabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  return tab;
}

async function checkContentScript() {
  const tab = await getTabInfo();
  if (!tab) {
    updateStatus(false, 'No active tab');
    return;
  }

  const isAdvisoryPage = tab.url?.includes('/security/advisories');
  pageUrlEl.textContent = tab.url ? new URL(tab.url).pathname : '—';

  if (!isAdvisoryPage) {
    updateStatus(false, 'Not on an advisories page');
    selectedCountEl.textContent = 'N/A';
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
    if (response && response.selectedCount !== undefined) {
      updateStatus(true, 'Active on this page');
      selectedCountEl.textContent = response.selectedCount;
    } else {
      updateStatus(true, 'Active (no selection)');
      selectedCountEl.textContent = '0';
    }
  } catch (e) {
    updateStatus(false, 'Content script not loaded');
    selectedCountEl.textContent = '—';
  }
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SELECTION_CHANGED') {
    selectedCountEl.textContent = message.count;
    if (message.count >= 2) {
      updateStatus(true, `${message.count} advisories selected`);
    } else if (message.count > 0) {
      updateStatus(true, `${message.count} selected (need 2+)`);
    } else {
      updateStatus(true, 'Active on this page');
    }
  }
});

// Initial check
checkContentScript();

// Refresh periodically
setInterval(checkContentScript, 2000);