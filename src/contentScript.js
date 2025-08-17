/**
 * Google News Summaries - Content Script
 * - Injects a summarize button next to each article title on https://news.google.com/*
 * - On click, summarizes either:
 *   a) visible card text (title + snippet), or
 *   b) deep fetched article HTML (if enabled in Options and a URL is available)
 */

const INJECTED_ATTR = 'data-gns-injected';

const throttle = (fn, delay = 500) => {
  let busy = false;
  return (...args) => {
    if (busy) return;
    busy = true;
    try { fn(...args); } finally {
      setTimeout(() => (busy = false), delay);
    }
  };
};

const state = {
  settings: null
};

// Shield helper: block article navigation by capturing and stopping events on our UI
function shieldClicks(el) {
  const events = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend'];
  for (const ev of events) {
    el.addEventListener(ev, (e) => {
      // Allow our own summarize button to handle its events
      const t = e.target;
      if (t && typeof t.closest === 'function' && t.closest('.gns-btn')) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    }, { capture: true });
  }
}

init();

async function init() {
  // Load settings initially
  await refreshSettings();

  // Observe for dynamic content
  const throttledScan = throttle(scanAndInject, 300);
  const observer = new MutationObserver(() => throttledScan());
  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true
  });

  // Initial pass
  scanAndInject();
}

async function refreshSettings() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'getSettings' });
    if (resp?.ok) {
      state.settings = resp.settings || {};
    }
  } catch {
    // ignore; will retry later
  }
}

function scanAndInject() {
  // Find anchors that look like article title links in Google News
  const titleAnchors = document.querySelectorAll('a[href^="./read/"], a[href^="https://news.google.com/read/"]');

  titleAnchors.forEach(anchor => {
    const card = findCardContainer(anchor);
    if (!card) return;

    // Avoid duplicate injection
    if (card.hasAttribute(INJECTED_ATTR)) return;

    // Some cards may be nested; ensure there's visible text
    const title = getTitleTextFromCard(card) || anchor.textContent.trim();
    if (!title) return;

    injectUI(card, anchor);
  });
}

function findCardContainer(el) {
  // Walk up to a reasonable card container (article, section, or c-wiz blocks Google uses)
  let cur = el;
  const limit = 8;
  let steps = 0;
  while (cur && steps++ < limit) {
    if (cur.matches && (cur.matches('article') || cur.matches('div[role="article"]') || cur.matches('c-wiz'))) {
      return cur;
    }
    cur = cur.parentElement;
  }
  // Fallback to nearest block container
  return el.closest('article, div[role="article"]') || el.parentElement;
}

function injectUI(card, titleAnchor) {
  // Mark injected early to avoid duplicate work if we re-process
  card.setAttribute(INJECTED_ATTR, '1');

  // Ensure the card is a positioning context
  try { card.classList.add('gns-card'); } catch {}

  // Container absolutely positioned within the card (outside the clickable anchors)
  const wrap = document.createElement('span');
  wrap.className = 'gns-wrap gns-abs';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'gns-btn';
  btn.title = 'Summarize this article';
  btn.textContent = '🧠';

  const bubble = document.createElement('div');
  bubble.className = 'gns-bubble';
  bubble.hidden = true;

  // Insert UI: append to card (not inside link)
  card.appendChild(wrap);
  wrap.appendChild(btn);
  wrap.appendChild(bubble);

  // Make the summarize button reliably clickable
  wrap.style.pointerEvents = 'auto';
  btn.style.pointerEvents = 'auto';
  // Raise above any overlays Google may place on the card
  const TOP_Z = '2147483647';
  btn.style.zIndex = TOP_Z;
  wrap.style.zIndex = TOP_Z;
  btn.setAttribute('aria-label', 'Summarize this article');
  try { console.debug('[GNS][CS] Injected summarize button'); } catch {}

  // Capture-phase shields to prevent link/article navigation
  shieldClicks(wrap);
  shieldClicks(btn);

  // Some sites prevent "click" from firing; ensure we handle pointer/mouse/touch directly
  const trigger = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    try {
      await onSummarizeClick({ card, titleAnchor, button: btn, bubble });
    } catch (err) {
      // Surface any unexpected error in the bubble
      bubble.textContent = (String(err && err.message ? err.message : err) || 'Error').replace(/\s+/g, ' ').trim();
      bubble.classList.add('gns-error');
      bubble.hidden = false;
    }
  };

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }, { capture: true });

  btn.addEventListener('pointerup', trigger, { capture: true });
  btn.addEventListener('mousedown', trigger, { capture: true });
  btn.addEventListener('touchend', trigger, { capture: true });

  // Fallback: click handler as well
  btn.addEventListener('click', trigger, { capture: true });
}

async function onSummarizeClick({ card, titleAnchor, button, bubble }) {
  if (button.dataset.loading === '1') return;
  button.dataset.loading = '1';
  const prevText = button.textContent;
  button.textContent = '…'; // loading indicator
  // Show spinner only (hide bubble while loading)
  bubble.hidden = true;
  bubble.textContent = '';
  try { console.debug('[GNS][CS] Summarize clicked'); } catch {}

  // Basic sanity check for messaging API
  if (!chrome?.runtime?.sendMessage) {
    bubble.textContent = 'Extension messaging unavailable.';
    bubble.classList.add('gns-error');
    button.dataset.loading = '0';
    button.textContent = prevText;
    return;
  }

  // Always refresh settings to reflect latest Options (e.g., deepFetch toggled)
  await refreshSettings();
  const settings = state.settings || {};

  try {
    const { text, url } = getCardContent(card, titleAnchor);

    if (!text && !url) {
      throw new Error('Could not extract article content.');
    }

    // Prefer resolving and sending the external article URL when deepFetch is enabled
    let resp;
    if (settings.deepFetch) {
      // Try to use the card's external link; fall back to the Google News read URL
      const external = findExternalLink(card);
      const newsRead = resolveAbsoluteHref(titleAnchor);
      const targetUrl = external || newsRead || url || '';
      if (targetUrl) {
        try { console.debug('[GNS][CS] Sending summarizeFromUrl:', targetUrl); } catch {}
        resp = await chrome.runtime.sendMessage({ type: 'summarizeFromUrl', url: targetUrl });
      } else {
        // No URL available; fall back to summarizing visible text
        const fallbackText = text || (url || '');
        try { console.debug('[GNS][CS] Sending summarize (no URL available)'); } catch {}
        resp = await chrome.runtime.sendMessage({ type: 'summarize', text: fallbackText });
      }
    } else {
      const fallbackText = text || (url || '');
      try { console.debug('[GNS][CS] Sending summarize'); } catch {}
      resp = await chrome.runtime.sendMessage({ type: 'summarize', text: fallbackText });
    }

    if (!resp?.ok) {
      throw new Error(resp?.error || 'Summarization failed.');
    }

    bubble.textContent = resp.summary;
    bubble.hidden = false;
    try { console.debug('[GNS][CS] Summary received'); } catch {}
  } catch (err) {
    bubble.textContent = (String(err && err.message ? err.message : err) || 'Error').replace(/\s+/g, ' ').trim();
    bubble.classList.add('gns-error');
    bubble.hidden = false;
  } finally {
    button.dataset.loading = '0';
    button.textContent = prevText;
  }
}

function getCardContent(card, titleAnchor) {
  // Title text
  const title = getTitleTextFromCard(card) || titleAnchor.textContent.trim();

  // Snippet: look for nearby paragraph/span text
  const snippetEl = findSnippetElement(card);
  const snippet = snippetEl ? snippetEl.textContent.trim() : '';

  // Prefer the Google News read link first; background resolves external target
  const link = resolveAbsoluteHref(titleAnchor) || findExternalLink(card);

  const textCombined = [title, snippet].filter(Boolean).join('. ');
  return { text: textCombined, url: link };
}

function getTitleTextFromCard(card) {
  // Try headings within the card
  const h = card.querySelector('h1, h2, h3, h4, h5, h6');
  if (h && h.textContent) return h.textContent.trim();

  // Try main anchor text as fallback
  const a = card.querySelector('a[href^="./read/"], a[href^="https://news.google.com/read/"]');
  if (a && a.textContent) return a.textContent.trim();

  return '';
}

function findSnippetElement(card) {
  // Heuristic: small/paragraph/span blocks that look like description/snippet
  // Avoid bylines (often contain 'By' or time)
  const candidates = card.querySelectorAll('p, span');
  for (const el of candidates) {
    const txt = (el.textContent || '').trim();
    if (!txt) continue;
    if (txt.length < 40) continue; // very short lines likely not a snippet
    if (/^\d+\s*(h|m|d)\s*ago$/i.test(txt)) continue;
    if (/^By\s+/i.test(txt)) continue;
    // Likely a snippet
    return el;
  }
  return null;
}

function isLikelyArticleHref(href) {
  try {
    const u = new URL(href, location.href);
    const host = u.hostname || '';
    // Filter out Google and common tracker/CDN/amp hosts
    if (/(^|\.)news\.google\.com$/i.test(host)) return false;
    if (/google\.[^/]+/i.test(host)) return false;
    if (/(gstatic\.com|googleusercontent\.com|googleapis\.com|doubleclick\.net|googletagmanager\.com|google-analytics\.com|scorecardresearch\.com|adservice\.google\.com|youtube\.com|twitter\.com|facebook\.com|t\.co|cdn\.ampproject\.org)/i.test(host)) {
      return false;
    }
    const path = u.pathname || '';
    // Exclude common asset extensions
    if (/\.(js|css|png|jpe?g|gif|webp|svg|ico|json|xml|woff2?)(\?|$)/i.test(path)) return false;
    // Require some path depth and letters
    return path.length > 10 && /[a-zA-Z]/.test(path);
  } catch {
    return false;
  }
}

function findExternalLink(card) {
  // Look for an absolute URL that appears to be the publisher article URL
  const anchors = card.querySelectorAll('a[href^="http"]');
  for (const a of anchors) {
    const href = a.getAttribute('href');
    if (!href) continue;
    if (isLikelyArticleHref(href)) {
      try {
        return new URL(href, location.href).href;
      } catch {
        // ignore malformed
      }
    }
  }
  return '';
}

function resolveAbsoluteHref(anchor) {
  const href = anchor.getAttribute('href') || '';
  if (!href) return '';
  try {
    return new URL(href, location.href).href;
  } catch {
    return href;
  }
}
