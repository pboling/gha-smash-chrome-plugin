/**
 * GH Advisory Smash - Popup Script
 * Communicates with content script to show status and selected count
 * Manages PAT (Personal Access Token) for GitHub API authentication
 */

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const pageUrlEl = document.getElementById('pageUrl');
const selectedCountEl = document.getElementById('selectedCount');
const patInput = document.getElementById('patInput');
const patSaveBtn = document.getElementById('patSaveBtn');
const patStatus = document.getElementById('patStatus');

function updateStatus(active, message) {
  statusDot.style.background = active ? '#238636' : '#f85149';
  statusText.textContent = message;
}

function setPatStatus(message, type = 'muted') {
  patStatus.textContent = message;
  patStatus.className = 'pat-status ' + type;
}

async function loadPat() {
  try {
    const result = await chrome.storage.sync.get(['github_pat']);
    if (result.github_pat) {
      patInput.value = result.github_pat;
      setPatStatus('Token saved ✓', 'valid');
    } else {
      setPatStatus('No token saved. Create a PAT with "repo" scope at github.com/settings/tokens', 'muted');
    }
  } catch (e) {
    setPatStatus('Error loading token', 'invalid');
  }
}

async function savePat() {
  const token = patInput.value.trim();
  if (!token) {
    setPatStatus('Please enter a token', 'invalid');
    return;
  }
  if (!token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
    setPatStatus('Token should start with ghp_ or github_pat_', 'invalid');
    return;
  }
  try {
    await chrome.storage.sync.set({ github_pat: token });
    setPatStatus('Token saved ✓', 'valid');
  } catch (e) {
    setPatStatus('Error saving token', 'invalid');
  }
}

patSaveBtn.addEventListener('click', savePat);
patInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') savePat();
});

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

// Initial load
loadPat();
checkContentScript();

// Refresh periodically
setInterval(checkContentScript, 2000);