# Google News Summaries (Chrome + Firefox MV3 Extension)

Adds a small summarize button next to each article on https://news.google.com/* that generates a single-line summary using an AI model (initially OpenAI, model configurable e.g., `gpt-5-nano`). Includes an Options page to configure provider, model, API key, and deep-fetch behavior.

## Features

- Works on any Google News page (https://news.google.com/*)
- Injects a small 🧠 button next to each article title
- On click, generates a concise one-line summary
- Options page lets you set:
  - Provider (OpenAI for initial release)
  - Model (e.g., gpt-5-nano)
  - API Key
  - Deep fetch (fetch original article for better summaries)
- Handles dynamically loaded cards as you scroll

## Install (Chrome)

1. Open `chrome://extensions`
2. Enable Developer Mode (top right)
3. Click “Load unpacked”
4. Select this project folder
5. Click “Details” → “Extension options” (or open the Options page from the extension’s action)
6. Set:
   - Provider: OpenAI
   - Model: gpt-5-nano (or your preferred model name)
   - API Key: your OpenAI key
   - Deep fetch: enable or disable as desired
7. Visit https://news.google.com/ and click the 🧠 next to an article title.

## Install (Firefox)

1. Open `about:debugging#/runtime/this-firefox`
2. Click “Load Temporary Add-on…”
3. Select `manifest.json` in this project folder
4. Open the extension’s Options page (via Add-ons Manager)
5. Configure Provider/Model/API Key/Deep fetch
6. Visit https://news.google.com/ and click the 🧠 button

Note: Firefox support uses MV3 and the `browser_specific_settings` in `manifest.json`. Temporary add-ons reset when Firefox restarts.

## How it works

- Content script (`src/contentScript.js`) finds title links that look like Google News articles (e.g., `./read/...`) and injects a small button and bubble UI.
- On click:
  - If Deep Fetch is enabled and an article URL is available, the background service worker fetches the article HTML, converts it to text, and summarizes it.
  - Otherwise it summarizes the visible card text (title + snippet).
- Background service worker (`src/background.js`) manages settings and calls the AI provider (OpenAI).
- Options page (`options/`) stores settings in `chrome.storage.sync`.

## Files

- `manifest.json` — MV3 manifest, content script on news.google.com, background service worker, options page
- `src/contentScript.js` — inject UI, extract card content, talk to background
- `src/styles.css` — bubble/button styling
- `src/background.js` — settings, cross-origin fetch for article HTML, OpenAI call
- `options/options.html` — options UI
- `options/options.css` — options styles
- `options/options.js` — options logic
- `README.md` — this file

## Permissions

- `storage` — store provider, model, API key, deepFetch flag
- `scripting` — standard MV3 permission required in some cases for script operations
- `host_permissions`:
  - `https://news.google.com/*` — run on Google News
  - `https://api.openai.com/*` — call OpenAI API
  - `http://*/*` and `https://*/*` — allow deep fetching article content across the web (can be toggled off by disabling Deep Fetch in Options)

You can narrow host permissions later if you prefer; deep fetching requires cross-origin access from the background.

## Privacy

- The extension never summarizes automatically; it only sends content when you click the 🧠 button.
- When Deep Fetch is off, it summarizes only the visible card text (title + snippet).
- When Deep Fetch is on, it fetches the original article HTML from the background to improve summary quality.
- Your API key is stored in browser sync storage.

## Troubleshooting

- “OpenAI API key not set”: Open the Options page and set your key.
- “Summarization failed”: Check model name and key validity, and ensure network access to OpenAI is not blocked by a firewall/VPN.
- No 🧠 button appears:
  - Ensure the extension is loaded and enabled.
  - Confirm the page is under `https://news.google.com/`.
  - Reload the page; Google News is highly dynamic and may change DOM structure. The content script uses heuristics on `./read/` links and common containers.
- Firefox: If the extension disappears after restart, reload as a Temporary Add-on.

## Notes and Future Enhancements

- Current deep fetch uses a lightweight HTML-to-text conversion. For best quality, integrate Mozilla Readability to extract main article content robustly.
- Provider abstraction supports adding more providers (OpenRouter, Azure OpenAI, Claude) in the background worker.
- Potential additions: caching summaries, toolbar action to summarize all visible cards, keyboard shortcut support.

## Development

- Changes to service worker require reloading the extension.
- Use DevTools on the extension’s background page to inspect logs if needed.
- DOM selectors target Google News `./read/` anchors and nearby card containers; minor tweaks may be needed if Google updates their markup.
