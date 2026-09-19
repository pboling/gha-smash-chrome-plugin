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

  // --- State ---
  let selectedAdvisories = new Set();
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

  function getGhsaIdFromRow(row) {
    const link = row.querySelector(SELECTORS.advisoryTitleLink);
    if (!link) return null;
    const match = link.href.match(/\/GHSA-[a-z0-9-]+/);
    return match ? match[0].substring(1) : null; // Remove leading slash
  }

  function getAdvisoryData(row) {
    const ghsaId = getGhsaIdFromRow(row);
    if (!ghsaId) return null;

    const titleLink = row.querySelector(SELECTORS.advisoryTitleLink);
    const title = titleLink ? titleLink.textContent.trim() : '';

    const metaDiv = row.querySelector(SELECTORS.advisoryGhsaId);
    const metaText = metaDiv ? metaDiv.textContent.trim() : '';

    const stateBadge = row.querySelector(SELECTORS.advisoryStateBadge);
    const state = stateBadge ? stateBadge.textContent.trim() : '';

    // Extract severity from the second badge
    const badges = row.querySelectorAll('span.Label');
    let severity = '';
    badges.forEach(badge => {
      const text = badge.textContent.trim();
      if (['Critical', 'High', 'Moderate', 'Low'].includes(text)) {
        severity = text;
      }
    });

    return { ghsaId, title, metaText, state, severity, row };
  }

  function saveSelection() {
    const ids = Array.from(selectedAdvisories);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  }

  function loadSelection() {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        selectedAdvisories = new Set(JSON.parse(stored));
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

  function createCheckbox(ghsaId, isPrimary = false) {
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
    if (isPrimary) {
      checkbox.style.accentColor = '#d29922';
      checkbox.title = 'Primary advisory (will receive merged credits)';
    }

    checkbox.addEventListener('change', (e) => {
      const id = e.target.dataset.ghsaId;
      if (e.target.checked) {
        selectedAdvisories.add(id);
      } else {
        selectedAdvisories.delete(id);
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
    // Update the first selected advisory's checkbox to show it's primary
    const firstId = selectedAdvisories.values().next().value;
    document.querySelectorAll('.gha-smash-checkbox').forEach(cb => {
      const isPrimary = cb.dataset.ghsaId === firstId;
      cb.style.accentColor = isPrimary ? '#d29922' : '#238636';
      cb.title = isPrimary ? 'Primary advisory (will receive merged credits)' : '';
    });
  }

  // --- API Functions ---

  async function fetchAdvisoryDetails(ghsaId) {
    const repoPath = window.location.pathname.split('/').slice(0,3).join('/');
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'FETCH_ADVISORY', ghsaId, repoPath },
        response => {
          if (response.error) reject(new Error(response.error));
          else resolve(response);
        }
      );
    });
  }

  async function mergeAdvisories(primaryId, duplicateIds) {
    const repoPath = window.location.pathname.split('/').slice(0,3).join('/');

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
      await updateAdvisoryCredits(primaryId, mergedCredits);

      // 2. Close duplicate advisories
      for (const dupId of duplicateIds) {
        await closeAdvisory(dupId);
      }

      return true;
    } catch (e) {
      console.error('[GH Advisory Smash] Merge failed:', e);
      alert(`Merge failed: ${e.message}`);
      return false;
    }
  }

  async function updateAdvisoryCredits(ghsaId, credits) {
    const repoPath = window.location.pathname.split('/').slice(0,3).join('/');
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'UPDATE_ADVISORY_CREDITS', ghsaId, credits, repoPath },
        response => {
          if (response.error) reject(new Error(response.error));
          else resolve(response);
        }
      );
    });
  }

  async function closeAdvisory(ghsaId) {
    const repoPath = window.location.pathname.split('/').slice(0,3).join('/');
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'CLOSE_ADVISORY', ghsaId, repoPath },
        response => {
          if (response.error) reject(new Error(response.error));
          else resolve(response);
        }
      );
    });
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
    if (checkboxColumnAdded) return;

    const list = document.querySelector(SELECTORS.advisoryList);
    if (!list) return;

    // Add checkbox column header by inserting into the first row's structure
    const rows = list.querySelectorAll(SELECTORS.advisoryRow);
    if (rows.length === 0) return;

    rows.forEach((row, index) => {
      const ghsaId = getGhsaIdFromRow(row);
      if (!ghsaId) return;

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

      const isPrimary = index === 0; // First row is primary by default
      const checkbox = createCheckbox(ghsaId, isPrimary && selectedAdvisories.size === 0);
      checkboxContainer.appendChild(checkbox);

      // Insert before the drag handle
      dragHandle.parentNode.insertBefore(checkboxContainer, dragHandle);

      // Adjust the drag handle margin
      dragHandle.style.marginLeft = '0';
    });

    checkboxColumnAdded = true;
    updateRowHighlighting();
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

      const ids = Array.from(selectedAdvisories);
      const primaryId = ids[0];
      const duplicateIds = ids.slice(1);

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
      let shouldUpdate = false;
      mutations.forEach(mutation => {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.matches(SELECTORS.advisoryRow) || node.querySelector(SELECTORS.advisoryRow)) {
                shouldUpdate = true;
              }
            }
          });
        }
      });
      if (shouldUpdate) {
        checkboxColumnAdded = false;
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