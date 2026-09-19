/**
 * GH Advisory Smash - Background Service Worker
 * Handles API requests (avoids CORS) and cross-tab coordination
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

    case 'FETCH_ADVISORY': {
      fetchAdvisoryDetails(message.ghsaId, message.repoPath)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ error: err.message }));
      return true; // async response
    }

    case 'UPDATE_ADVISORY_CREDITS': {
      updateAdvisoryCredits(message.ghsaId, message.credits, message.repoPath)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ error: err.message }));
      return true;
    }

    case 'CLOSE_ADVISORY': {
      closeAdvisory(message.ghsaId, message.repoPath)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ error: err.message }));
      return true;
    }

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

// Listen for tab updates to clear stale tokens
chrome.tabs.onRemoved.addListener((tabId) => {
  csrfTokens.delete(tabId);
});

async function fetchAdvisoryDetails(ghsaId, repoPath) {
  const url = `https://github.com/${repoPath}/security/advisories/${ghsaId}`;
  const response = await fetch(url, {
    credentials: 'include',
    headers: { 'Accept': 'text/html' }
  });
  const html = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const credits = [];
  doc.querySelectorAll('[data-testid="credit-item"], .credit-item, [data-credit]').forEach(el => {
    const userLink = el.querySelector('a[href^="/"][data-hovercard-type="user"]');
    const typeEl = el.querySelector('[data-credit-type], .credit-type');
    if (userLink) {
      credits.push({
        user: userLink.textContent.trim().replace('@', ''),
        type: typeEl ? typeEl.textContent.trim().toLowerCase() : 'reporter'
      });
    }
  });

  // Also check for the credits section
  const creditsSection = doc.querySelector('h2:contains("Credits"), h3:contains("Credits")');
  if (creditsSection) {
    const list = creditsSection.parentElement.querySelector('ul, ol');
    if (list) {
      list.querySelectorAll('li').forEach(li => {
        const userLink = li.querySelector('a[href^="/"][data-hovercard-type="user"]');
        if (userLink) {
          const text = li.textContent.toLowerCase();
          let type = 'reporter';
          if (text.includes('analyzer')) type = 'analyzer';
          else if (text.includes('remediation')) type = 'remediation';
          credits.push({ user: userLink.textContent.trim().replace('@', ''), type });
        }
      });
    }
  }

  return { ghsaId, credits };
}

async function updateAdvisoryCredits(ghsaId, credits, repoPath) {
  const response = await fetch(`https://api.github.com/repos/${repoPath}/security-advisories/${ghsaId}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({ credits })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Failed to update credits: ${err.message || response.statusText}`);
  }
  return response.json();
}

async function closeAdvisory(ghsaId, repoPath) {
  const response = await fetch(`https://api.github.com/repos/${repoPath}/security-advisories/${ghsaId}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({ state: 'closed' })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Failed to close ${ghsaId}: ${err.message || response.statusText}`);
  }
  return response.json();
}