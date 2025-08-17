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
  
  console.log('[GNS][CS] Found title anchors:', titleAnchors.length);
  
  titleAnchors.forEach((anchor, index) => {
    const href = anchor.getAttribute('href');
    console.log(`[GNS][CS] Anchor ${index}:`, { 
      href, 
      text: anchor.textContent.trim().substring(0, 50),
      resolvedHref: resolveAbsoluteHref(anchor)
    });
    
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
    
    console.log('[GNS][CS] Content extraction result:', { text, url, hasGoogleNewsUrl: url && url.includes('news.google.com/read/') });

    if (!text && !url) {
      throw new Error('Could not extract article content.');
    }

    let resp;
    
    // Always try to use the Google News read URL first to get the full article
    // The background script will resolve this to the final article URL and fetch the content
    if (url && url.includes('news.google.com/read/')) {
      try { 
        console.log('[GNS][CS] Sending summarizeFromUrl (Google News URL):', url); 
      } catch {}
      resp = await chrome.runtime.sendMessage({ type: 'summarizeFromUrl', url: url });
    } else {
      // Fallback to summarizing visible text if no Google News URL found
      const fallbackText = text || (url || '');
      console.log('[GNS][CS] No Google News URL found, falling back to text summarization. URL was:', url);
      try { console.debug('[GNS][CS] Sending summarize (no Google News URL, using text)'); } catch {}
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
  // Title text - try multiple selectors for Google News cards
  let title = getTitleTextFromCard(card) || titleAnchor.textContent.trim();
  
  // If title is just "Google News" or very short, try to find the actual article title
  if (!title || title === 'Google News' || title.length < 5) {
    // Look for the main article title link text
    const titleLink = card.querySelector('a[href^="./read/"], a[href^="https://news.google.com/read/"]');
    if (titleLink && titleLink.textContent.trim()) {
      title = titleLink.textContent.trim();
    }
  }

  // Snippet: look for nearby paragraph/span text with better selectors
  const snippetEl = findSnippetElement(card);
  const snippet = snippetEl ? snippetEl.textContent.trim() : '';

  // ALWAYS prioritize the Google News read URL - this is what we need to send to the background script
  // The background script will follow this redirect to get the final article content
  const googleNewsUrl = resolveAbsoluteHref(titleAnchor);
  
  // Only fall back to external links if we somehow don't have a Google News URL
  const fallbackUrl = googleNewsUrl || findExternalLink(card);

  const textCombined = [title, snippet].filter(Boolean).join('. ');
  console.log('[GNS][CS] Extracted content:', { 
    title, 
    snippet, 
    textCombined, 
    googleNewsUrl,
    fallbackUrl,
    finalUrl: fallbackUrl 
  });
  
  return { text: textCombined, url: fallbackUrl };
}

function getTitleTextFromCard(card) {
  // Try multiple selectors for Google News article titles
  const selectors = [
    'a[href^="./read/"]', // Google News read links
    'a[href^="https://news.google.com/read/"]', // Full URLs
    'h1, h2, h3, h4, h5, h6', // Headings
    '.gPFEn', // Google News article title class
    '[data-n-tid="29"]', // Google News title data attribute
    'a[tabindex="0"]' // Tabbed links (often article titles)
  ];
  
  for (const selector of selectors) {
    const el = card.querySelector(selector);
    if (el && el.textContent && el.textContent.trim().length > 5) {
      const text = el.textContent.trim();
      // Skip if it's just "Google News" or similar
      if (text !== 'Google News' && !text.includes('Google News')) {
        return text;
      }
    }
  }
  
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
    
    // Look for common article patterns
    const articlePatterns = [
      /\/\d{4}\/\d{2}\/\d{2}\//, // Date patterns like /2025/08/14/
      /\/article\//, // /article/ in path
      /\/story\//, // /story/ in path
      /\/news\//, // /news/ in path
      /\/post\//, // /post/ in path
      /\/blog\//, // /blog/ in path
      /\/[a-z]{2,}\/\d{4}\//, // Short word followed by year
      /\/[a-z]{2,}\/[a-z]{2,}\//, // Two or more word segments
    ];
    
    // If any article pattern matches, it's likely an article
    for (const pattern of articlePatterns) {
      if (pattern.test(path)) {
        return true;
      }
    }
    
    // Require some path depth and letters, but be less restrictive
    return path.length > 5 && /[a-zA-Z]/.test(path);
  } catch {
    return false;
  }
}

function findExternalLink(card) {
  console.log('[GNS][CS] Searching for external links in card:', card);
  
  // Look for ALL links in the card, not just anchors
  const allLinks = [
    ...card.querySelectorAll('a[href]'),
    ...card.querySelectorAll('[data-url]'),
    ...card.querySelectorAll('[data-href]'),
    ...card.querySelectorAll('[data-link]'),
    ...card.querySelectorAll('[href]')
  ];
  
  console.log('[GNS][CS] Found potential links:', allLinks.length);
  
  // First pass: look for obvious external article URLs
  for (const link of allLinks) {
    const href = link.getAttribute('href') || link.getAttribute('data-url') || link.getAttribute('data-href') || link.getAttribute('data-link');
    if (!href || !href.startsWith('http')) continue;
    
    try {
      const url = new URL(href, location.href);
      const host = url.hostname || '';
      
      // Skip Google domains completely
      if (host.includes('google.com') || host.includes('gstatic.com') || 
          host.includes('googleusercontent.com') || host.includes('cdn.ampproject.org')) {
        continue;
      }
      
      // If we find any external domain, log it and check if it looks like an article
      if (host && host !== location.hostname) {
        console.log('[GNS][CS] Found external link:', url.href, 'from host:', host);
        
        // Check if this looks like an article URL
        const path = url.pathname || '';
        if (path.length > 5 && /[a-zA-Z]/.test(path)) {
          console.log('[GNS][CS] This looks like an article URL, returning:', url.href);
          return url.href;
        }
      }
    } catch (e) {
      console.log('[GNS][CS] Error parsing URL:', href, e);
    }
  }
  
  // Second pass: look for any non-Google URLs, even if they don't look like articles
  for (const link of allLinks) {
    const href = link.getAttribute('href') || link.getAttribute('data-url') || link.getAttribute('data-href') || link.getAttribute('data-link');
    if (!href || !href.startsWith('http')) continue;
    
    try {
      const url = new URL(href, location.href);
      const host = url.hostname || '';
      
      // Skip Google domains
      if (host.includes('google.com') || host.includes('gstatic.com') || 
          host.includes('googleusercontent.com') || host.includes('cdn.ampproject.org')) {
        continue;
      }
      
      // If we find any external domain, use it as a fallback
      if (host && host !== location.hostname) {
        console.log('[GNS][CS] Found fallback external link:', url.href);
        return url.href;
      }
    } catch (e) {
      // ignore malformed URLs
    }
  }
  
  // Third pass: look for any URLs that might be in text content or other attributes
  const cardText = card.textContent || '';
  const urlMatches = cardText.match(/https?:\/\/[^\s"']+/g);
  if (urlMatches) {
    for (const urlText of urlMatches) {
      try {
        const url = new URL(urlText);
        const host = url.hostname || '';
        
        // Skip Google domains
        if (host.includes('google.com') || host.includes('gstatic.com') || 
            host.includes('googleusercontent.com') || host.includes('cdn.ampproject.org')) {
          continue;
        }
        
        // If we find any external domain, use it
        if (host && host !== location.hostname) {
          console.log('[GNS][CS] Found URL in text content:', url.href);
          return url.href;
        }
      } catch (e) {
        // ignore malformed URLs
      }
    }
  }
  
  console.log('[GNS][CS] No external links found');
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

// Function to follow Google News redirects by simulating a click
async function followGoogleNewsRedirect(googleNewsUrl) {
  try {
    console.log('[GNS] Following Google News redirect by simulating click');
    
    // Find the main article link on the page
    const articleLink = document.querySelector('a[href*="news.google.com/read"]') || 
                       document.querySelector('a[data-n-tid]') ||
                       document.querySelector('a[data-url]') ||
                       document.querySelector('a[href^="http"]:not([href*="google.com"])');
    
    if (!articleLink) {
      console.log('[GNS] No article link found on page');
      return null;
    }
    
    console.log('[GNS] Found article link:', articleLink.href);
    
    // Create a new tab to follow the redirect
    const newTab = await chrome.tabs.create({
      url: articleLink.href,
      active: false // Open in background
    });
    
    // Wait for the page to load and redirect
    return new Promise((resolve) => {
      const checkTab = async () => {
        try {
          const tab = await chrome.tabs.get(newTab.id);
          
          // Check if the URL has changed (redirect happened)
          if (tab.url && tab.url !== articleLink.href && !tab.url.includes('news.google.com')) {
            console.log('[GNS] Redirect detected to:', tab.url);
            
            // Close the tab and return the final URL
            await chrome.tabs.remove(newTab.id);
            resolve(tab.url);
            return;
          }
          
          // If still loading, wait a bit more
          if (tab.status === 'loading') {
            setTimeout(checkTab, 500);
            return;
          }
          
          // If loaded but still on Google News, wait a bit more for potential redirect
          if (tab.status === 'complete') {
            setTimeout(() => {
              chrome.tabs.get(newTab.id).then(finalTab => {
                if (finalTab.url && finalTab.url !== articleLink.href && !finalTab.url.includes('news.google.com')) {
                  console.log('[GNS] Final redirect detected to:', finalTab.url);
                  chrome.tabs.remove(newTab.id);
                  resolve(finalTab.url);
                } else {
                  console.log('[GNS] No redirect detected, staying on Google News');
                  chrome.tabs.remove(newTab.id);
                  resolve(null);
                }
              });
            }, 2000); // Wait 2 seconds for potential redirect
            return;
          }
          
        } catch (error) {
          console.error('[GNS] Error checking tab:', error);
          chrome.tabs.remove(newTab.id);
          resolve(null);
        }
      };
      
      // Start checking
      setTimeout(checkTab, 1000);
    });
    
  } catch (error) {
    console.error('[GNS] Error following Google News redirect:', error);
    return null;
  }
}

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'followGoogleNewsRedirect') {
    console.log('[GNS] Received request to follow Google News redirect');
    followGoogleNewsRedirect(request.url).then(finalUrl => {
      sendResponse({ success: true, finalUrl: finalUrl });
    });
    return true; // Keep the message channel open for async response
  }
});
