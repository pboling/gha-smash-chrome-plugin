/**
 * GH Advisory Smash - Content Script
 * Adds checkboxes and a "Smash" button to merge duplicate advisories
 */

(function() {
  'use strict';

  // --- Configuration ---
  const SELECTORS = {
    advisoryList: 'ul[data-pjax="#repo-content-pjax-container"][data-turbo-frame="repo-content-turbo-frame"]',
    advisoryRow: 'li.Box-row.Box-row--focus-gray.p-0',
    advisoryTitleLink: 'a.Link--primary.v-align-middle.no-underline.h4[href*="/security/advisories/GHSA-"]',
    advisoryGhsaId: 'div.mt-1.text-small.color-fg-muted',
    advisoryStateBadge: 'span.Label.Label--secondary, span.Label.Label--orange, span.Label.Label--warning',
    segmentedControl: 'segmented-control ul.SegmentedControl',
    newAdvisoryButton: 'a[href$="/security/advisories/new"]',
    boxHeader: '.Box-header.p-2.d-flex.flex-items-center.flex-justify-between',
  };

  const STORAGE_KEY = 'gha-smash-selected';
  const PRIMARY_KEY = 'gha-smash-primary';

    // --- State ---
    let selectedAdvisories = new Set();
    let primaryAdvisoryId = null; // Explicitly stored primary GHSA ID
    let smashButton = null;
    let checkboxColumnAdded = false;

    // --- Utility Functions ---

    function extractCsrfToken() {
      const meta = document.querySelector('meta[name="csrf-token"]');
      return meta ? meta.content : null;
    }

    function sendCsrfTokenToBackground() {
      const token = extractCsrfToken();
      if (token) {
        chrome.runtime.sendMessage({ type: 'SET_CSRF_TOKEN', token });
      }
    }

    function saveSelection() {
      const ids = Array.from(selectedAdvisories);
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
      if (primaryAdvisoryId) {
        sessionStorage.setItem(PRIMARY_KEY, primaryAdvisoryId);
      } else {
        sessionStorage.removeItem(PRIMARY_KEY);
      }
    }

    function loadSelection() {
      try {
        const stored = sessionStorage.getItem(STORAGE_KEY);
        if (stored) {
          selectedAdvisories = new Set(JSON.parse(stored));
        }
        const storedPrimary = sessionStorage.getItem(PRIMARY_KEY);
        if (storedPrimary && selectedAdvisories.has(storedPrimary)) {
          primaryAdvisoryId = storedPrimary;
        } else {
          primaryAdvisoryId = null;
        }
      } catch (e) {
        console.warn('[GH Advisory Smash] Failed to load selection:', e);
      }
    }

  function updateSmashButton() {
    if (!smashButton) return;
    const count = selectedAdvisories.size;
    smashButton.textContent = count >= 2 ? `Smash (${count})` : 'Smash';
    smashButton.disabled = count < 2;
    smashButton.style.opacity = count >= 2 ? '1' : '0.5';
    smashButton.title = count >= 2
      ? `Merge ${count} selected advisories into the first one`
      : 'Select at least 2 advisories to merge';
    
    // Notify popup of selection change
    chrome.runtime.sendMessage({ type: 'SELECTION_CHANGED', count });
  }

  function createCheckbox(ghsaId) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.ghsaId = ghsaId;
    checkbox.className = 'gha-smash-checkbox';
    checkbox.checked = selectedAdvisories.has(ghsaId);
    checkbox.style.cssText = `
      width: 18px;
      height: 18px;
      cursor: pointer;
      accent-color: #238636;
      transform: scale(1.2);
    `;
    const isPrimary = ghsaId === primaryAdvisoryId;
    if (isPrimary) {
      checkbox.style.accentColor = '#d29922';
      checkbox.title = 'Primary advisory (will receive merged credits)';
    }

    checkbox.addEventListener('change', (e) => {
      const id = e.target.dataset.ghsaId;
      if (e.target.checked) {
        selectedAdvisories.add(id);
        // Set as primary if this is the first selection
        if (!primaryAdvisoryId) {
          primaryAdvisoryId = id;
        }
      } else {
        selectedAdvisories.delete(id);
        // Clear primary if it was unchecked
        if (primaryAdvisoryId === id) {
          primaryAdvisoryId = null;
        }
      }
      saveSelection();
      updateSmashButton();
      updateRowHighlighting();
      updatePrimaryBadge();
    });

    return checkbox;
  }

  function updateRowHighlighting() {
    document.querySelectorAll(SELECTORS.advisoryRow).forEach(row => {
      const ghsaId = getGhsaIdFromRow(row);
      if (selectedAdvisories.has(ghsaId)) {
        row.style.backgroundColor = 'rgba(35, 134, 54, 0.1)';
        row.style.borderLeft = '3px solid #238636';
      } else {
        row.style.backgroundColor = '';
        row.style.borderLeft = '';
      }
    });
  }

  function updatePrimaryBadge() {
    // Update the primary advisory's checkbox to show it's primary
    document.querySelectorAll('.gha-smash-checkbox').forEach(cb => {
      const isPrimary = cb.dataset.ghsaId === primaryAdvisoryId;
      cb.style.accentColor = isPrimary ? '#d29922' : '#238636';
      cb.title = isPrimary ? 'Primary advisory (will receive merged credits)' : '';
    });
  }

  // --- API Functions ---

  // Fetch with timeout wrapper
  async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      return response;
    } finally {
      clearTimeout(id);
    }
  }

  function extractUsernameFromLink(link) {
    // Try textContent first
    const text = link.textContent.trim();
    if (text) return text.replace('@', '');

    // Fallback: parse from href="/username"
    const href = link.getAttribute('href');
    if (href?.startsWith('/')) {
      const match = href.match(/^\/([^/]+)/);
      if (match) return match[1];
    }
    return '';
  }

  async function fetchAdvisoryDetails(ghsaId) {
    const repoPath = window.location.pathname.split('/').slice(0, 3).join('/');
    const url = `https://github.com/${repoPath}/security/advisories/${ghsaId}`;

    try {
      const response = await fetchWithTimeout(url, {
        credentials: 'include',
        headers: { 'Accept': 'text/html' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const credits = [];
      // Primary credit items
      doc.querySelectorAll('[data-testid="credit-item"], .credit-item, [data-credit]').forEach(el => {
        const userLink = el.querySelector('a[href^="/"][data-hovercard-type="user"]');
        const typeEl = el.querySelector('[data-credit-type], .credit-type');
        if (userLink) {
          credits.push({
            user: extractUsernameFromLink(userLink),
            type: typeEl ? typeEl.textContent.trim().toLowerCase() : 'reporter'
          });
        }
      });

      // Fallback: Credits section - find heading by text content
      const headings = doc.querySelectorAll('h2, h3');
      headings.forEach(heading => {
        if (heading.textContent.trim().toLowerCase().includes('credits')) {
          const list = heading.parentElement?.querySelector('ul, ol');
          if (list) {
            list.querySelectorAll('li').forEach(li => {
              const userLink = li.querySelector('a[href^="/"][data-hovercard-type="user"]');
              if (userLink) {
                const text = li.textContent.toLowerCase();
                let type = 'reporter';
                if (text.includes('analyzer')) type = 'analyzer';
                else if (text.includes('remediation')) type = 'remediation';
                credits.push({ user: extractUsernameFromLink(userLink), type });
              }
            });
          }
        }
      });

      console.log(`[GH Advisory Smash] Fetched ${ghsaId}:`, credits);
      return { ghsaId, credits };
    } catch (e) {
      console.warn(`[GH Advisory Smash] Failed to fetch ${ghsaId}:`, e);
      return { ghsaId, credits: [] };
    }
  }

  async function mergeAdvisories(primaryId, duplicateIds) {
    const repoPath = window.location.pathname.split('/').slice(0, 3).join('/');

    // Fetch credits from all duplicates
    const allCredits = new Map(); // user -> { types: Set, ghsaIds: [] }
    const duplicateDetails = [];

    for (const id of [primaryId, ...duplicateIds]) {
      const { credits } = await fetchAdvisoryDetails(id);
      duplicateDetails.push({ id, credits });
      credits.forEach(c => {
        if (!allCredits.has(c.user)) {
          allCredits.set(c.user, { types: new Set(), ghsaIds: [] });
        }
        allCredits.get(c.user).types.add(c.type);
        allCredits.get(c.user).ghsaIds.push(id);
      });
    }

    // Prepare merged credits for primary
    const mergedCredits = Array.from(allCredits.entries()).map(([user, data]) => ({
      user,
      type: data.types.has('remediation') ? 'remediation' :
            data.types.has('analyzer') ? 'analyzer' :
            data.types.has('reporter') ? 'reporter' : 'other'
    }));

    // Show confirmation modal
    const confirmed = await showConfirmModal({
      primaryId,
      duplicateIds,
      mergedCredits,
      duplicateDetails
    });

    if (!confirmed) return false;

    // Execute the merge
    try {
      // 1. Update primary advisory with merged credits
      await updateAdvisoryCredits(primaryId, mergedCredits, repoPath);

      // 2. Close duplicate advisories
      for (const dupId of duplicateIds) {
        await closeAdvisory(dupId, repoPath);
      }

      return true;
    } catch (e) {
      console.error('[GH Advisory Smash] Merge failed:', e);
      alert(`Merge failed: ${e.message}`);
      return false;
    }
  }

  async function updateAdvisoryCredits(ghsaId, credits, repoPath) {
    const url = `https://api.github.com/repos/${repoPath}/security-advisories/${ghsaId}`;
    const response = await fetchWithTimeout(url, {
      method: 'PATCH',
      credentials: 'include',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({ credits })
    }, 30000);

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Failed to update credits: ${err.message || response.statusText}`);
    }
    return response.json();
  }

  async function closeAdvisory(ghsaId, repoPath) {
    const url = `https://api.github.com/repos/${repoPath}/security-advisories/${ghsaId}`;
    const response = await fetchWithTimeout(url, {
      method: 'PATCH',
      credentials: 'include',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({ state: 'closed' })
    }, 30000);

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Failed to close ${ghsaId}: ${err.message || response.statusText}`);
    }
    return response.json();
  }

  function showConfirmModal({ primaryId, duplicateIds, mergedCredits, duplicateDetails }) {
    return new Promise(resolve => {
      // Remove any existing modal
      const existing = document.getElementById('gha-smash-modal');
      if (existing) existing.remove();

      const modal = document.createElement('div');
      modal.id = 'gha-smash-modal';
      modal.style.cssText = `
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      `;

      const creditsHtml = mergedCredits.map(c =>
        `<li><strong>@${c.user}</strong> — <code>${c.type}</code> (from ${duplicateDetails.find(d => d.credits.some(cr => cr.user === c.user))?.id || 'multiple'})</li>`
      ).join('');

      modal.innerHTML = `
        <div style="
          background: var(--color-canvas-default, #1e2327);
          border: 1px solid var(--color-border-default, #30363d);
          border-radius: 12px;
          padding: 24px;
          max-width: 600px;
          width: 90%;
          max-height: 80vh;
          overflow: auto;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        ">
          <h2 style="margin: 0 0 16px; color: var(--color-fg-default, #e6edf3);">🔨 Smash Advisories</h2>

          <div style="margin-bottom: 16px; padding: 12px; background: var(--color-neutral-muted, #21262d); border-radius: 6px;">
            <strong>Primary (keeps open):</strong>
            <div style="font-family: monospace; margin-top: 4px;">${primaryId}</div>
            <div style="font-size: 12px; color: var(--color-fg-muted, #8b949e); margin-top: 2px;">
              ${duplicateDetails.find(d => d.id === primaryId)?.credits.map(c => `@${c.user} (${c.type})`).join(', ') || 'No credits'}
            </div>
          </div>

          <div style="margin-bottom: 16px;">
            <strong>Will be closed & merged:</strong>
            <ul style="margin: 8px 0; padding-left: 20px;">
              ${duplicateIds.map(id => {
                const detail = duplicateDetails.find(d => d.id === id);
                return `<li><code>${id}</code> — ${detail?.credits.map(c => `@${c.user} (${c.type})`).join(', ') || 'No credits'}</li>`;
              }).join('')}
            </ul>
          </div>

          <div style="margin-bottom: 16px;">
            <strong>Merged credits on primary:</strong>
            <ul style="margin: 8px 0; padding-left: 20px; font-size: 13px;">
              ${creditsHtml || '<li><em>No credits to merge</em></li>'}
            </ul>
          </div>

          <div style="display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px;">
            <button id="gha-smash-cancel" style="
              padding: 8px 16px;
              border: 1px solid var(--color-border-default, #30363d);
              background: transparent;
              color: var(--color-fg-default, #e6edf3);
              border-radius: 6px;
              cursor: pointer;
              font-size: 13px;
            ">Cancel</button>
            <button id="gha-smash-confirm" style="
              padding: 8px 16px;
              border: none;
              background: var(--color-btn-primary-bg, #238636);
              color: white;
              border-radius: 6px;
              cursor: pointer;
              font-size: 13px;
              font-weight: 600;
            ">Smash ${duplicateIds.length} into ${primaryId}</button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      modal.querySelector('#gha-smash-cancel').onclick = () => {
        modal.remove();
        resolve(false);
      };

      modal.querySelector('#gha-smash-confirm').onclick = () => {
        modal.remove();
        resolve(true);
      };

      modal.onclick = (e) => {
        if (e.target === modal) {
          modal.remove();
          resolve(false);
        }
      };
    });
  }

  // --- UI Injection ---

  function injectCheckboxColumn() {
    const list = document.querySelector(SELECTORS.advisoryList);
    if (!list) return;

    // Add checkbox column header by inserting into the first row's structure
    const rows = list.querySelectorAll(SELECTORS.advisoryRow);
    if (rows.length === 0) return;

    let addedCount = 0;
    rows.forEach((row, index) => {
      const ghsaId = getGhsaIdFromRow(row);
      if (!ghsaId) return;

      // Skip if already has checkbox
      if (row.querySelector('.gha-smash-checkbox')) return;

      const dragHandle = row.querySelector('.flex-shrink-0.pt-2.tmp-pl-3');
      if (!dragHandle) return;

      // Create checkbox container
      const checkboxContainer = document.createElement('div');
      checkboxContainer.style.cssText = `
        width: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-right: 8px;
      `;

      const checkbox = createCheckbox(ghsaId);
      checkboxContainer.appendChild(checkbox);

      // Insert before the drag handle
      dragHandle.parentNode.insertBefore(checkboxContainer, dragHandle);

      // Adjust the drag handle margin
      dragHandle.style.marginLeft = '0';
      addedCount++;
    });

    if (addedCount > 0) {
      checkboxColumnAdded = true;
      updateRowHighlighting();
    }
  }

  function injectSmashButton() {
    if (smashButton) return;

    // Find the Box-header where the segmented control lives
    const header = document.querySelector(SELECTORS.boxHeader);
    if (!header) return;

    // Create the smash button
    smashButton = document.createElement('button');
    smashButton.id = 'gha-smash-button';
    smashButton.type = 'button';
    smashButton.className = 'Button--primary Button--medium Button';
    smashButton.style.cssText = `
      margin-left: 12px;
      white-space: nowrap;
    `;
    smashButton.disabled = true;
    smashButton.style.opacity = '0.5';
    smashButton.title = 'Select at least 2 advisories to merge';

    const count = selectedAdvisories.size;
    smashButton.textContent = count >= 2 ? `Smash (${count})` : 'Smash';

    smashButton.addEventListener('click', async () => {
      if (selectedAdvisories.size < 2) return;
      if (!primaryAdvisoryId) return;

      const ids = Array.from(selectedAdvisories);
      const primaryId = primaryAdvisoryId;
      const duplicateIds = ids.filter(id => id !== primaryId);

      smashButton.disabled = true;
      smashButton.textContent = 'Smashing...';

      const success = await mergeAdvisories(primaryId, duplicateIds);

      if (success) {
        smashButton.textContent = 'Smashed! ✓';
        setTimeout(() => {
          // Reload the page to show updated state
          window.location.reload();
        }, 1500);
      } else {
        smashButton.disabled = false;
        updateSmashButton();
      }
    });

    // Insert after the segmented control
    const segmentedControl = header.querySelector(SELECTORS.segmentedControl);
    if (segmentedControl) {
      segmentedControl.parentNode.insertBefore(smashButton, segmentedControl.nextSibling);
    } else {
      header.appendChild(smashButton);
    }
  }

  function setupObserver() {
    // Watch for new advisories being added (pagination, filtering)
    const list = document.querySelector(SELECTORS.advisoryList);
    if (!list) return;

    const observer = new MutationObserver((mutations) => {
      let hasNewRows = false;
      mutations.forEach(mutation => {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.matches(SELECTORS.advisoryRow) || node.querySelector(SELECTORS.advisoryRow)) {
                hasNewRows = true;
              }
            }
          });
        }
      });
      if (hasNewRows) {
        // Only inject for new rows (injectCheckboxColumn now skips existing)
        injectCheckboxColumn();
        injectSmashButton();
      }
    });

    observer.observe(list, { childList: true, subtree: true });
    return observer;
  }

  // --- Initialization ---

  function init() {
    loadSelection();
    sendCsrfTokenToBackground();

    // Handle messages from popup
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'GET_STATUS') {
        sendResponse({ selectedCount: selectedAdvisories.size });
        return true;
      }
    });

    // Wait for the advisory list to be present
    const waitForList = setInterval(() => {
      const list = document.querySelector(SELECTORS.advisoryList);
      if (list && list.querySelectorAll(SELECTORS.advisoryRow).length > 0) {
        clearInterval(waitForList);
        injectCheckboxColumn();
        injectSmashButton();
        setupObserver();
        console.log('[GH Advisory Smash] Initialized');
      }
    }, 500);

    // Cleanup on unload
    window.addEventListener('beforeunload', () => {
      saveSelection();
    });
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();