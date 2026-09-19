# GH Advisory Smash

Chrome extension to merge duplicate GitHub Security Advisories with credit roll-up.

## Install

### From Source (Development)

```bash
git clone https://github.com/pboling/gha-smash-chrome-plugin
cd gha-smash-chrome-plugin
```

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the cloned folder

### From Chrome Web Store

*Not yet published*

## Usage

1. Navigate to any repository's **Security Advisories** page:
   ```
   https://github.com/<owner>/<repo>/security/advisories
   ```

2. **Checkboxes** appear next to each advisory row

3. **Select 2+ duplicate advisories** — the first selected becomes the **primary** (stays open, receives merged credits)

4. Click the **Smash (N)** button in the header (appears next to the segmented control)

5. **Confirm modal** shows:
   - Primary advisory (kept open) with its current credits
   - Duplicate advisories to be closed with their credits
   - Merged credits that will be applied to the primary

6. Click **Smash** to execute:
   - Primary advisory credits updated with combined credits from all selected
   - Duplicate advisories closed via GitHub API

## How It Works

### Architecture

| Component | Role |
|-----------|------|
| `manifest.json` | Manifest V3 config, host permissions, content script registration |
| `background.js` | Service worker — executes GitHub API calls (avoids CORS), stores CSRF tokens per tab |
| `content.js` | Injected into advisory pages — UI injection, selection management, merge orchestration |
| `content.css` | Styles for checkboxes, button, modal, row highlighting |
| `popup.html/js` | Extension popup showing active status and selection count |

### Data Flow

```
User selects advisories
       ↓
content.js tracks selection in sessionStorage
       ↓
User clicks "Smash"
       ↓
content.js sends FETCH_ADVISORY messages to background
       ↓
background.js fetches advisory pages, parses credits from DOM
       ↓
content.js shows confirm modal with merged credits preview
       ↓
User confirms
       ↓
content.js sends UPDATE_ADVISORY_CREDITS + CLOSE_ADVISORY to background
       ↓
background.js calls GitHub REST API (PATCH /security-advisories/{ghsa_id})
       ↓
Page reloads to show updated state
```

### Credit Merging Logic

- Credits fetched from each advisory's page (DOM parsing)
- Credit types: `reporter`, `analyzer`, `remediation`, `other`
- **Priority**: remediation > analyzer > reporter > other
- Duplicate users deduplicated — highest priority type wins
- Merged credits applied to primary advisory via `PATCH /security-advisories/{ghsa_id}`

## Permissions

| Permission | Purpose |
|------------|---------|
| `activeTab` | Access current tab when popup opened |
| `scripting` | Inject content script (redundant with manifest content_scripts, kept for flexibility) |
| `https://github.com/*/security/advisories*` | Content script match pattern; fetch advisory pages for credit parsing |
| `https://api.github.com/repos/*/security-advisories/*` | Background service worker calls GitHub REST API to update credits and close advisories |

## Development

### Project Structure

```
gha-smash-chrome-plugin/
├── manifest.json       # MV3 manifest
├── background.js       # Service worker (API calls)
├── content.js          # Content script (UI + logic)
├── content.css         # Styles
├── popup.html          # Popup UI
├── popup.js            # Popup logic
├── icons/              # 16/32/48/128px icons
└── README.md           # This file
```

### Key Implementation Details

- **CSRF Handling**: Content script extracts `meta[name="csrf-token"]` and sends to background for authenticated API calls
- **Session Persistence**: Selection stored in `sessionStorage` (`gha-smash-selected`) — survives page reloads
- **MutationObserver**: Watches for paginated/filtered advisory list changes, re-injects UI
- **GitHub DOM Selectors**: Targets current GitHub advisory list structure (`.Box-row`, segmented control, etc.)

### Testing Locally

1. Load unpacked extension (see Install)
2. Visit a repo with multiple security advisories (e.g., `github.com/owner/repo/security/advisories`)
3. Verify checkboxes appear, selection works, button enables at 2+
4. Open popup — should show "Active on this page" and selection count

## Limitations

- Requires **write access** to the repository (to update/close advisories via API)
- Relies on GitHub's current advisory page DOM structure — may break on UI changes
- Credit parsing uses heuristic selectors — may miss credits if GitHub changes markup
- No rate limit handling beyond browser's built-in fetch queue
- Single-repo only (no cross-repo advisory merging)

## Contributing

1. Fork the repo
2. Create a feature branch
3. Make changes
4. Test locally with Load Unpacked
5. Submit PR

## License

MIT — see [LICENSE](LICENSE) if present, otherwise standard MIT terms apply.