/**
 * GH Advisory Smash - Content Script
 * Adds checkboxes and a "Smash" button to merge duplicate advisories
 */

(function() {
  'use strict';

  // --- Debug ---
  const DEBUG = new URLSearchParams(window.location.search).has('ghsa-smash-debug');
  function debugLog(...args) {
    if (DEBUG) console.log('[GH Advisory Smash DEBUG]', ...args);
  }

  // Enable debug in background worker if URL flag is set
  if (DEBUG) {
    chrome.runtime.sendMessage({ type: 'SET_DEBUG', enabled: true }, (response) => {
      if (response?.ok) {
        console.log('[GH Advisory Smash] Debug mode enabled in background worker');
      }
    });
  }

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
    // Try multiple possible meta tag names GitHub uses
    // fetch-nonce is the modern GitHub auth token for fetch requests
    const selectors = [
      'meta[name="fetch-nonce"]',
      'meta[name="html-safe-nonce"]',
      'meta[name="csrf-token"]',
      'meta[name="github-token"]',
      'meta[name="octolytics-dimension-current_user_login"]',
    ];
    
    for (const selector of selectors) {
      const meta = document.querySelector(selector);
      if (meta && meta.content) {
        debugLog('Auth token found via:', selector, meta.content.substring(0, 20) + '...');
        return meta.content;
      }
    }
    
    // Debug: list all meta tags with their names/properties
    if (DEBUG) {
      const allMeta = document.querySelectorAll('meta');
      const metaInfo = Array.from(allMeta).map(m => ({
        name: m.getAttribute('name'),
        property: m.getAttribute('property'),
        content: m.content ? m.content.substring(0, 50) + '...' : ''
      }));
      
      // Also look for any meta with "token", "auth", "csrf", "github", "nonce" in name/property
      const authMeta = metaInfo.filter(m => 
        (m.name && /token|auth|csrf|github|nonce/i.test(m.name)) ||
        (m.property && /token|auth|csrf|github|nonce/i.test(m.property))
      );
      
      console.log('[GH Advisory Smash] Auth-related meta tags:', authMeta);
      console.log('[GH Advisory Smash] All meta tags:', metaInfo);
    }
    
    return null;
  }

  function sendCsrfTokenToBackground() {
    const token = extractCsrfToken();
    debugLog('CSRF token extracted:', token ? 'found' : 'none');
    if (token) {
      chrome.runtime.sendMessage({ type: 'SET_CSRF_TOKEN', token }, (response) => {
        if (DEBUG) console.log('[CSRF] SET_CSRF_TOKEN response:', response);
      });
    } else {
      if (DEBUG) console.log('[CSRF] No token found');
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
    const pathParts = window.location.pathname.split('/');
    // Remove leading empty string from split
    if (pathParts[0] === '') pathParts.shift();
    const repoPath = pathParts.slice(0, 2).join('/');
    const url = `https://github.com/${repoPath}/security/advisories/${ghsaId}`;

    debugLog('Fetching advisory details:', { ghsaId, url });

    try {
      const response = await fetchWithTimeout(url, {
        credentials: 'include',
        headers: { 'Accept': 'text/html' }
      });
      debugLog('Fetch response:', { ghsaId, status: response.status, ok: response.ok });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const html = await response.text();
      debugLog('HTML length:', html.length);
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

      debugLog('Parsed credits:', { ghsaId, credits });
      return { ghsaId, credits };
    } catch (e) {
      debugLog('Fetch failed:', { ghsaId, error: e.message });
      console.warn(`[GH Advisory Smash] Failed to fetch ${ghsaId}:`, e);
      return { ghsaId, credits: [] };
    }
  }

  async function mergeAdvisories(primaryId, duplicateIds) {
    const pathParts = window.location.pathname.split('/');
    // Remove leading empty string from split
    if (pathParts[0] === '') pathParts.shift();
    const repoPath = pathParts.slice(0, 2).join('/');
    debugLog('repoPath extracted:', { repoPath, pathname: window.location.pathname });

    // Early abort: check if we have an auth token before proceeding
    const authToken = extractCsrfToken();
    if (!authToken) {
      const errorMsg = 'No authentication token found on page (fetch-nonce, html-safe-nonce, or csrf-token meta tags missing). Cannot proceed with API calls.';
      debugLog('Early abort:', errorMsg);
      alert(errorMsg);
      return false;
    }

    const ids = [primaryId, ...duplicateIds];

    // Create and show live modal immediately
    const modal = createLiveModal(primaryId, duplicateIds);
    document.body.appendChild(modal);

    const logEl = modal.querySelector('#gha-smash-log');
    const confirmSection = modal.querySelector('#gha-smash-confirm-section');
    const footerEl = modal.querySelector('#gha-smash-footer');
    const confirmBtn = modal.querySelector('#gha-smash-confirm');
    const cancelBtn = modal.querySelector('#gha-smash-cancel');

    function log(msg, type = 'info') {
      const line = document.createElement('div');
      line.style.cssText = `
        font-family: monospace;
        font-size: 12px;
        padding: 2px 0;
        color: ${type === 'error' ? '#f85149' : type === 'warn' ? '#d29922' : type === 'success' ? '#3fb950' : '#8b949e'};
        border-left: 3px solid ${type === 'error' ? '#f85149' : type === 'warn' ? '#d29922' : type === 'success' ? '#3fb950' : 'transparent'};
        padding-left: 8px;
        margin: 2px 0;
      `;
      line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
      debugLog(msg);
    }

    function showConfirm(duplicateDetails, mergedCredits) {
      // Hide log and footer, show confirmation summary
      logEl.style.display = 'none';
      footerEl.style.display = 'none';
      confirmSection.style.display = 'block';

      const creditsHtml = mergedCredits.map(c =>
        `<li><strong>@${c.user}</strong> — <code>${c.type}</code> (from ${duplicateDetails.find(d => d.credits.some(cr => cr.user === c.user))?.id || 'multiple'})</li>`
      ).join('');

      confirmSection.innerHTML = `
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
          <button id="gha-smash-cancel-final" style="
            padding: 8px 16px;
            border: 1px solid var(--color-border-default, #30363d);
            background: transparent;
            color: var(--color-fg-default, #e6edf3);
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
          ">Cancel</button>
          <button id="gha-smash-confirm-final" style="
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
      `;

      confirmSection.querySelector('#gha-smash-cancel-final').onclick = () => {
        modal.remove();
        resolve(false);
      };

      confirmSection.querySelector('#gha-smash-confirm-final').onclick = () => {
        executeMerge(duplicateDetails, mergedCredits);
      };
    }

    // Execute the actual merge
    async function executeMerge(duplicateDetails, mergedCredits) {
      confirmSection.innerHTML = '<div style="text-align:center; padding: 20px;">Executing merge...</div>';
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;

      try {
        // 1. Update primary advisory with merged credits
        log(`Updating primary ${primaryId} with merged credits...`, 'info');
        await updateAdvisoryCredits(primaryId, mergedCredits, repoPath);
        log(`✓ Primary ${primaryId} credits updated`, 'success');

        // 2. Close duplicate advisories
        for (const dupId of duplicateIds) {
          log(`Closing ${dupId}...`, 'info');
          await closeAdvisory(dupId, repoPath);
          log(`✓ Closed ${dupId}`, 'success');
        }

        log('All done! Reloading page...', 'success');
        setTimeout(() => window.location.reload(), 1500);
        return true;
      } catch (e) {
        log(`✗ Merge failed: ${e.message}`, 'error');
        const errDetail = e.message.includes('404') ? '\n  → Check: repo path correct? GHSA IDs exist? You have write access?' :
                         e.message.includes('403') ? '\n  → Check: write access to repo? Token expired?' : '';
        log(errDetail, 'error');
        confirmSection.innerHTML = `
          <div style="color: #f85149; padding: 16px; background: rgba(248,81,73,0.1); border-radius: 6px;">
            <strong>Merge failed:</strong><br>
            ${e.message}${errDetail}
          </div>
          <div style="display: flex; gap: 12px; justify-content: flex-end; margin-top: 16px;">
            <button id="gha-smash-close-error" style="
              padding: 8px 16px;
              border: none;
              background: var(--color-btn-primary-bg, #238636);
              color: white;
              border-radius: 6px;
              cursor: pointer;
              font-size: 13px;
              font-weight: 600;
            ">Close</button>
          </div>
        `;
        confirmSection.querySelector('#gha-smash-close-error').onclick = () => modal.remove();
        cancelBtn.disabled = false;
        return false;
      }
    }

    // Start fetching credits
    try {
      log('Fetching advisory details...', 'info');

      const allCredits = new Map();
      const duplicateDetails = [];

      for (const id of ids) {
        log(`Fetching ${id}...`, 'info');
        const { credits } = await fetchAdvisoryDetails(id);
        duplicateDetails.push({ id, credits });
        log(`  Found ${credits.length} credit(s): ${credits.map(c => `@${c.user} (${c.type})`).join(', ') || 'none'}`, credits.length ? 'success' : 'warn');
        credits.forEach(c => {
          if (!allCredits.has(c.user)) {
            allCredits.set(c.user, { types: new Set(), ghsaIds: [] });
          }
          allCredits.get(c.user).types.add(c.type);
          allCredits.get(c.user).ghsaIds.push(id);
        });
      }

      const mergedCredits = Array.from(allCredits.entries()).map(([user, data]) => ({
        user,
        type: data.types.has('remediation') ? 'remediation' :
              data.types.has('analyzer') ? 'analyzer' :
              data.types.has('reporter') ? 'reporter' : 'other'
      }));

      log(`Merged credits: ${mergedCredits.map(c => `@${c.user} (${c.type})`).join(', ')}`, 'success');
      showConfirm(duplicateDetails, mergedCredits);

    } catch (e) {
      log(`✗ Fetch failed: ${e.message}`, 'error');
      logEl.style.display = 'block';
      confirmSection.style.display = 'none';
      throw e;
    }

    return new Promise((resolve) => {
      cancelBtn.onclick = () => {
        modal.remove();
        resolve(false);
      };
    });
  }

  function createLiveModal(primaryId, duplicateIds) {
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

    modal.innerHTML = `
      <div style="
        background: var(--color-canvas-default, #1e2327);
        border: 1px solid var(--color-border-default, #30363d);
        border-radius: 12px;
        padding: 24px;
        max-width: 700px;
        width: 90%;
        max-height: 80vh;
        overflow: auto;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        display: flex;
        flex-direction: column;
      ">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h2 style="margin: 0; color: var(--color-fg-default, #e6edf3);">🔨 Smash Advisories</h2>
          <span style="font-size: 11px; color: var(--color-fg-muted, #8b949e);">${DEBUG ? 'DEBUG MODE' : ''}</span>
        </div>

        <div style="margin-bottom: 12px; font-size: 13px; color: var(--color-fg-muted, #8b949e);">
          Primary: <code>${primaryId}</code> &nbsp;|&nbsp; Duplicates: ${duplicateIds.map(id => `<code>${id}</code>`).join(', ')}
        </div>

        <div id="gha-smash-log" style="
          flex: 1;
          min-height: 150px;
          max-height: 400px;
          overflow: auto;
          background: #0d1117;
          border: 1px solid var(--color-border-default, #30363d);
          border-radius: 6px;
          padding: 12px;
          margin-bottom: 16px;
          font-family: monospace;
          font-size: 12px;
          color: #8b949e;
        ">
          <div>Initializing...</div>
        </div>

        <div id="gha-smash-confirm-section" style="display: none;"></div>

        <div id="gha-smash-footer" style="display: flex; gap: 12px; justify-content: flex-end;">
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
          " disabled>Confirm</button>
        </div>
      </div>
    `;

    return modal;
  }

  async function apiRequest(method, url, body) {
    debugLog(`API Request: ${method} ${url}`, body ? { body } : '');
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'API_REQUEST',
        payload: { method, url, body }
      }, (response) => {
        if (response?.error) {
          debugLog(`API Error: ${response.error}`);
          reject(new Error(response.error));
        } else {
          debugLog(`API Success: ${method} ${url}`, response);
          resolve(response);
        }
      });
    });
  }

  async function updateAdvisoryCredits(ghsaId, credits, repoPath) {
    const url = `https://api.github.com/repos/${repoPath}/security-advisories/${ghsaId}`;
    return apiRequest('PATCH', url, { credits });
  }

  async function closeAdvisory(ghsaId, repoPath) {
    const url = `https://api.github.com/repos/${repoPath}/security-advisories/${ghsaId}`;
    return apiRequest('PATCH', url, { state: 'closed' });
  }

  // --- UI Injection ---

  function injectCheckboxColumn() {
    const list = document.querySelector(SELECTORS.advisoryList);
    if (!list) return;

    // Add checkbox column header by inserting into the first row's structure
    const rows = list.querySelectorAll(SELECTORS.advisoryRow);
    if (rows.length === 0) return;

    let addedCount = 0;
    rows.forEach((row) => {
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

    // Initialize button state from loaded selection
    updateSmashButton();

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
      if (message.type === 'DEBUG_LOG' && DEBUG) {
        console.log('[GH Advisory Smash DEBUG]', message.message);
        if (message.headers) {
          console.log('[GH Advisory Smash DEBUG] Request headers:', message.headers);
        }
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