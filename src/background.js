/**
 * Google News Summaries - Background Service Worker (MV3)
 * - Stores and retrieves settings from chrome.storage.local
 * - Performs cross-origin fetch for article HTML (bypasses page CORS)
 * - Calls AI provider (OpenAI) to summarize text to a single line
 */

const DEFAULT_SETTINGS = {
  provider: 'openai',
  model: 'gpt-5-nano',
  apiKey: '',
  deepFetch: true,
  systemPrompt: `You are a news summarizer.\n- Return exactly one concise sentence (max 25 words).\n- No emojis, no quotes, no markdown.\n- Be factual and neutral.\n-- If the article speaks about a list, for example a list of books or games, mention it in a bullet point list format. Use identations or format as needed.`
};
 

async function getSettings() {
  console.log('[GNS] Getting settings from storage...');
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  console.log('[GNS] Raw stored settings:', stored);
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  console.log('[GNS] Merged settings:', { ...settings, apiKey: settings.apiKey ? '[set]' : '[empty]' });
  return settings;
}

chrome.runtime.onInstalled.addListener(async () => {
  // Ensure defaults exist without clobbering existing values
  const current = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const toSet = {};
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (typeof current[k] === 'undefined') toSet[k] = v;
  }
  if (Object.keys(toSet).length) {
    await chrome.storage.local.set(toSet);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Use async handler via sendResponse and return true
  (async () => {
    try {
      const safeMsg = (message && message.settings)
        ? { ...message, settings: { ...message.settings, apiKey: message.settings.apiKey ? '[set]' : '' } }
        : message;
      console.log('[GNS] Received message:', safeMsg);
      switch (message?.type) {
        case 'getSettings': {
          const settings = await getSettings();
          sendResponse({ ok: true, settings });
          break;
        }
        case 'fetchHtml': {
          const { url } = message;
          if (!url) {
            sendResponse({ ok: false, error: 'Missing URL' });
            break;
          }
          const html = await fetchHtml(url);
          sendResponse({ ok: true, html });
          break;
        }
        case 'summarizeFromUrl': {
          const { url } = message;
          if (!url) {
            sendResponse({ ok: false, error: 'Missing URL' });
            break;
          }
          const settings = await getSettings();
          const text = await extractTextFromUrl(url);
          const summary = await summarizeWithProvider(text, settings);
          sendResponse({ ok: true, summary });
          break;
        }
        case 'summarize': {
          const { text, settings: incoming } = message;
          if (!text || !text.trim()) {
            sendResponse({ ok: false, error: 'No text to summarize' });
            break;
          }
          // Prefer settings passed from the Options page test button; fallback to stored settings.
          const settings = incoming ? { ...DEFAULT_SETTINGS, ...incoming } : await getSettings();
          console.log('[GNS] Settings loaded for summarize:', { ...settings, apiKey: settings.apiKey ? '[set]' : '' });
          const summary = await summarizeWithProvider(text, settings);
          sendResponse({ ok: true, summary });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (err) {
      console.error('[GNS] Error in background handler:', err);
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
  return true;
});

/**
 * Fetch raw HTML for a given URL using extension context (bypasses page CORS)
 */
async function fetchHtml(url) {
  // Try default fetch first
  try {
  const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
    return await res.text();
  } catch (e1) {
    // Some publishers require a referrer; retry with a Google News referrer
    try {
      const res2 = await fetch(url, {
    redirect: 'follow',
        referrer: 'https://news.google.com/',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });
      if (!res2.ok) throw new Error(`Fetch failed (${res2.status})`);
      return await res2.text();
    } catch (e2) {
      throw e1;
    }
  }
}

// Try to detect an immediate redirect target (Location header) without following it
async function probeExternalRedirect(url) {
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('Location') || res.headers.get('location');
      if (loc) {
        const abs = new URL(loc, url).href;
        if (isLikelyArticleUrl(abs)) return abs;
      }
    }
  } catch {/* ignore */}
  try {
    // Retry with a Google News referrer
    const res2 = await fetch(url, {
      redirect: 'manual',
      referrer: 'https://news.google.com/',
      headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    });
    if (res2.status >= 300 && res2.status < 400) {
      const loc2 = res2.headers.get('Location') || res2.headers.get('location');
      if (loc2) {
        const abs2 = new URL(loc2, url).href;
        if (isLikelyArticleUrl(abs2)) return abs2;
      }
    }
  } catch {/* ignore */}
  return '';
}

/**
 * Extract main text content from a URL by fetching HTML and parsing to article text.
 * Tries a DOM-based main-content extraction first; falls back to htmlToText.
 */
async function extractTextFromUrl(url) {
  try {
    console.log('[GNS] Processing URL:', url);
    
    if (url.includes('news.google.com')) {
      console.log('[GNS] Processing Google News URL, following redirects to get final article URL');
      
      // Use content script to follow the redirect by opening a tab
      const finalUrl = await followGoogleNewsRedirectWithTab(url);
      
      if (finalUrl && finalUrl !== url) {
        console.log('[GNS] Successfully followed redirect to:', finalUrl);
        return await extractTextFromUrl(finalUrl);
      } else {
        console.log('[GNS] No redirect found, extracting from Google News page');
        return await extractTextFromGoogleNewsPage(url);
      }
    }
    
    return await extractTextFromRegularUrl(url);
  } catch (error) {
    console.error('[GNS] Error extracting text from URL:', error);
    return null;
  }
}

async function followGoogleNewsRedirectWithTab(googleNewsUrl) {
  try {
    console.log('[GNS] Following Google News redirect using tab approach');
    
    // Create a new tab with the Google News URL
    const newTab = await chrome.tabs.create({
      url: googleNewsUrl,
      active: false // Open in background
    });
    
    // Wait for the page to load and potentially redirect
    return new Promise((resolve) => {
      const checkTab = async () => {
        try {
          const tab = await chrome.tabs.get(newTab.id);
          
          // Check if the URL has changed (redirect happened)
          if (tab.url && tab.url !== googleNewsUrl && !tab.url.includes('news.google.com')) {
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
                if (finalTab.url && finalTab.url !== googleNewsUrl && !finalTab.url.includes('news.google.com')) {
                  console.log('[GNS] Final redirect detected to:', finalTab.url);
                  chrome.tabs.remove(newTab.id);
                  resolve(finalTab.url);
                } else {
                  console.log('[GNS] No redirect detected, staying on Google News');
                  chrome.tabs.remove(newTab.id);
                  resolve(null);
                }
              });
            }, 3000); // Wait 3 seconds for potential redirect
            return;
          }
          
        } catch (error) {
          console.error('[GNS] Error checking tab:', error);
          chrome.tabs.remove(newTab.id);
          resolve(null);
        }
      };
      
      // Start checking after 1 second
      setTimeout(checkTab, 1000);
    });
    
  } catch (error) {
    console.error('[GNS] Error following Google News redirect with tab:', error);
    return null;
  }
}

async function extractExternalUrlFromGoogleNewsPage(html) {
  try {
    console.log('[GNS] Extracting external URLs from Google News page content');
    
    // Look for any URLs that don't contain google.com
    const urlPatterns = [
      // Any URL pattern that doesn't contain google.com
      /(https?:\/\/[^\s"']+)/gi
    ];
    
    const foundUrls = new Set();
    
    for (const pattern of urlPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const url = match[1] || match[0];
        if (url && isValidExternalUrl(url)) {
          foundUrls.add(url);
        }
      }
    }
    
    console.log('[GNS] Found', foundUrls.size, 'potential external URLs');
    
    // Filter to find article-like URLs from any domain
    const validUrls = Array.from(foundUrls).filter(url => {
      try {
        const urlObj = new URL(url);
        const host = urlObj.hostname.toLowerCase();
        
        // Skip Google domains
        if (host.includes('google.com') || host.includes('gstatic.com') || 
            host.includes('googleusercontent.com') || host.includes('cdn.ampproject.org')) {
          return false;
        }
        
        // Skip common non-article domains
        const skipDomains = ['w3.org', 'schema.org', 'ogp.me', 'fonts.googleapis.com', 
                           'google-analytics.com', 'googletagmanager.com', 'angular.dev'];
        if (skipDomains.some(domain => host.includes(domain))) {
          return false;
        }
        
        // Accept any URL with substantial path (likely an article)
        const path = urlObj.pathname;
        if (path.length > 15) {
          console.log('[GNS] Found URL with substantial path:', url);
          return true;
        }
        
        return false;
      } catch (e) {
        return false;
      }
    });
    
    if (validUrls.length > 0) {
      console.log('[GNS] Returning best external URL:', validUrls[0]);
      return validUrls[0];
    }
    
    console.log('[GNS] No valid external URLs found');
    return null;
  } catch (error) {
    console.error('[GNS] Error extracting external URL from Google News page:', error);
    return null;
  }
}

function isValidExternalUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

async function extractTextFromGoogleNewsPage(url) {
  try {
    console.log('[GNS] Extracting content from Google News page');
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    const html = await response.text();
    console.log('[GNS] Successfully extracted content from Google News page, length:', html.length);
    
    // Try to extract meaningful content from the Google News page
    return await tryParse(html);
  } catch (error) {
    console.error('[GNS] Error extracting from Google News page:', error);
    throw error;
  }
}

/**
 * Convert HTML to plain text: remove scripts/styles, strip tags, collapse whitespace.
 */
function extractExternalUrlFromGoogleNews(html) {
  if (!html || typeof html !== 'string') return '';
  
  console.log('[GNS] Extracting external URLs from Google News HTML');
  
  // Define blacklists once to ensure consistency
  const blacklistedHosts = [
    // Technical specifications and standards
    'w3.org', 'schema.org', 'ogp.me', 'opengraphprotocol.org', 'xml.org', 'ietf.org', 'rfc-editor.org',
    'whatwg.org', 'ecma-international.org', 'iso.org', 'ansi.org', 'ieee.org',
    
    // Documentation and developer resources
    'developer.mozilla.org', 'docs.microsoft.com', 'developers.google.com', 'github.com', 'gitlab.com',
    'stackoverflow.com', 'stackexchange.com', 'reddit.com', 'hackernews.com',
    
    // Framework and technology documentation
    'angular.dev', 'angular.io', 'react.dev', 'reactjs.org', 'vuejs.org', 'svelte.dev', 'nextjs.org',
    'nuxtjs.org', 'gatsbyjs.com', 'webpack.js.org', 'babeljs.io', 'eslint.org', 'prettier.io',
    'typescript.org', 'nodejs.org', 'npmjs.com', 'yarnpkg.com', 'deno.land', 'bun.sh',
    
    // Social media and platforms
    'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'linkedin.com', 'youtube.com',
    'tiktok.com', 'snapchat.com', 'pinterest.com', 'tumblr.com',
    
    // CDNs and infrastructure
    'cdn.jsdelivr.net', 'unpkg.com', 'jsdelivr.net', 'cdnjs.cloudflare.com', 'bootcdn.net',
    'cdn.staticfile.org', 'lib.baomitu.com', 'cdn.bootcss.com',
    
    // Analytics and tracking
    'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'facebook.net',
    'scorecardresearch.com', 'adservice.google.com', 'googlesyndication.com',
    
    // Browser and system
    'chrome.google.com', 'addons.mozilla.org', 'extensions.chrome.com', 'microsoftedge.microsoft.com',
    'support.apple.com', 'support.microsoft.com', 'help.ubuntu.com'
  ];
  
  const blacklistedPathPatterns = [
    // Technical and documentation patterns
    /(namespace|schema|specification|reference|documentation|xml|html|css|javascript|api|rfc|ietf|draft|proposal|working-group)/i,
    
    // System and browser patterns
    /(chrome|firefox|safari|edge|browser|extension|addon|plugin|update|download|install)/i,
    
    // Development and technical patterns
    /(github|gitlab|stackoverflow|reddit|hackernews|forum|community|support|help|faq|docs|manual|guide|tutorial)/i,
    
    // Social and platform patterns
    /(facebook|twitter|instagram|linkedin|youtube|tiktok|snapchat|pinterest|tumblr|social|share|like|comment)/i,
    
    // Infrastructure and CDN patterns
    /(cdn|static|assets|images|js|css|fonts|icons|logos|banners|ads|tracking|analytics)/i,
    
    // Legal and policy pages
    /(license|licenses|terms|privacy|policy|policies|legal|disclaimer|copyright|trademark|patent)/i,
    
    // Administrative and utility pages
    /(about|contact|help|support|faq|feedback|report|bug|issue|status|maintenance|sitemap|robots)/i,
    
    // User account and authentication
    /(login|logout|signin|signout|register|signup|account|profile|settings|preferences|dashboard|admin)/i
  ];
  
  // Helper function to check if a URL is blacklisted
  const isUrlBlacklisted = (host, path) => {
    // Check if host is blacklisted
    const isHostBlacklisted = blacklistedHosts.some(blacklisted => 
      host.includes(blacklisted) || host.endsWith('.' + blacklisted)
    );
    
    if (isHostBlacklisted) {
      console.log('[GNS] URL blacklisted by host:', host);
      return true;
    }
    
    // Check if path contains blacklisted patterns
    const hasBlacklistedPath = blacklistedPathPatterns.some(pattern => pattern.test(path));
    if (hasBlacklistedPath) {
      console.log('[GNS] URL blacklisted by path pattern:', path);
      return true;
    }
    
    return false;
  };
  
  // Collect all absolute hrefs with more comprehensive patterns
  const hrefs = [];
  
  // Standard href attributes
  const reHref = /href="(https?:\/\/[^"]+)"/gi;
  let m;
  while ((m = reHref.exec(html)) !== null) {
    const href = decodeHtml(m[1]);
    if (href) hrefs.push(href);
  }
  
  // Data attributes that might contain URLs
  const reDataUrl = /data-url="(https?:\/\/[^"]+)"/gi;
  while ((m = reDataUrl.exec(html)) !== null) {
    const href = decodeHtml(m[1]);
    if (href) hrefs.push(href);
  }
  
  const reDataHref = /data-href="(https?:\/\/[^"]+)"/gi;
  while ((m = reDataHref.exec(html)) !== null) {
    const href = decodeHtml(m[1]);
    if (href) hrefs.push(href);
  }
  
  const reDataLink = /data-link="(https?:\/\/[^"]+)"/gi;
  while ((m = reDataLink.exec(html)) !== null) {
    const href = decodeHtml(m[1]);
    if (href) hrefs.push(href);
  }
  
  // JavaScript variables that might contain URLs
  const reJsUrl = /['"`](https?:\/\/[^'"`]+)['"`]/gi;
  while ((m = reJsUrl.exec(html)) !== null) {
    const href = decodeHtml(m[0].slice(1, -1)); // Remove quotes
    if (href && href.startsWith('http')) hrefs.push(href);
  }
  
  // Look for any URLs in the HTML content (more aggressive)
  const reAnyUrl = /https?:\/\/[^\s"'<>]+/gi;
  while ((m = reAnyUrl.exec(html)) !== null) {
    const href = decodeHtml(m[0]);
    if (href && !hrefs.includes(href)) hrefs.push(href);
  }
  
  // Google News specific patterns - look for URLs in JavaScript data structures
  const reJsData = /"url":\s*"(https?:\/\/[^"]+)"/gi;
  while ((m = reJsData.exec(html)) !== null) {
    const href = decodeHtml(m[1]);
    if (href && !hrefs.includes(href)) hrefs.push(href);
  }
  
  const reJsHref = /"href":\s*"(https?:\/\/[^"]+)"/gi;
  while ((m = reJsHref.exec(html)) !== null) {
    const href = decodeHtml(m[1]);
    if (href && !hrefs.includes(href)) hrefs.push(href);
  }
  
  const reJsLink = /"link":\s*"(https?:\/\/[^"]+)"/gi;
  while ((m = reJsLink.exec(html)) !== null) {
    const href = decodeHtml(m[1]);
    if (href && !hrefs.includes(href)) hrefs.push(href);
  }
  
  // Look for URLs in Google News specific data attributes
  const reGNewsData = /data-url="([^"]*)"[^>]*data-source="([^"]*)"/gi;
  while ((m = reGNewsData.exec(html)) !== null) {
    const url = m[1];
    const source = m[2];
    if (url && !url.startsWith('http') && source && source !== 'news.google.com') {
      // This might be a relative URL that needs to be resolved
      const fullUrl = `https://${source}${url.startsWith('/') ? url : '/' + url}`;
      if (!hrefs.includes(fullUrl)) hrefs.push(fullUrl);
    }
  }
  
  // Look for URLs in Google News article metadata
  const reGNewsMeta = /data-n-tid="[^"]*"[^>]*data-url="(https?:\/\/[^"]+)"/gi;
  while ((m = reGNewsMeta.exec(html)) !== null) {
    const href = decodeHtml(m[1]);
    if (href && !hrefs.includes(href)) hrefs.push(href);
  }
  
  // Look for URLs in Google News JavaScript data structures
  const reGNewsJsData = /window\.WIZ_global_data\s*=\s*({[^}]+})/gi;
  while ((m = reGNewsJsData.exec(html)) !== null) {
    try {
      const jsonStr = m[1];
      // Look for URLs in the JSON-like structure
      const urlMatches = jsonStr.match(/"([^"]*\/[^"]*\.com[^"]*)"/g);
      if (urlMatches) {
        for (const match of urlMatches) {
          const url = match.replace(/"/g, '');
          if (url && url.includes('http') && !hrefs.includes(url)) {
            hrefs.push(url);
          }
        }
      }
    } catch (e) {
      // ignore JSON parsing errors
    }
  }
  
  // Look for URLs in Google News specific meta tags
  const reGNewsMetaUrl = /<meta[^>]*name="[^"]*url[^"]*"[^>]*content="([^"]+)"/gi;
  while ((m = reGNewsMetaUrl.exec(html)) !== null) {
    const href = decodeHtml(m[1]);
    if (href && href.startsWith('http') && !hrefs.includes(href)) hrefs.push(href);
  }
  
  // Look for URLs in Google News specific link tags
  const reGNewsLinkUrl = /<link[^>]*rel="[^"]*canonical[^"]*"[^>]*href="([^"]+)"/gi;
  while ((m = reGNewsLinkUrl.exec(html)) !== null) {
    const href = decodeHtml(m[1]);
    if (href && href.startsWith('http') && !hrefs.includes(href)) hrefs.push(href);
  }
  
  // Look for URLs in Google News specific script tags with data
  const reGNewsScriptData = /<script[^>]*type="[^"]*application\/ld\+json[^"]*"[^>]*>([^<]+)<\/script>/gi;
  while ((m = reGNewsScriptData.exec(html)) !== null) {
    try {
      const jsonStr = m[1];
      // Look for URLs in JSON-LD structured data
      const urlMatches = jsonStr.match(/"url":\s*"([^"]+)"/gi);
      if (urlMatches) {
        for (const match of urlMatches) {
          const url = match.replace(/"url":\s*"/i, '').replace(/"/g, '');
          if (url && url.startsWith('http') && !hrefs.includes(url)) {
            hrefs.push(url);
          }
        }
      }
    } catch (e) {
      // ignore JSON parsing errors
    }
  }
  
  // Look for URLs in Google News specific data attributes that might contain external links
  const reGNewsExternalLink = /data-external-url="([^"]+)"/gi;
  while ((m = reGNewsExternalLink.exec(html)) !== null) {
    const href = decodeHtml(m[1]);
    if (href && href.startsWith('http') && !hrefs.includes(href)) hrefs.push(href);
  }
  
  // Look for URLs in Google News specific onclick handlers
  const reGNewsOnclick = /onclick="[^"]*window\.open\(['"`]([^'"`]+)['"`]/gi;
  while ((m = reGNewsOnclick.exec(html)) !== null) {
    const href = decodeHtml(m[1]);
    if (href && href.startsWith('http') && !hrefs.includes(href)) hrefs.push(href);
  }
  
  // Look for URLs in Google News specific href attributes with external patterns
  const reGNewsExternalHref = /href="([^"]*)"[^>]*target="_blank"/gi;
  while ((m = reGNewsExternalHref.exec(html)) !== null) {
    const href = decodeHtml(m[1]);
    if (href && href.startsWith('http') && !hrefs.includes(href)) hrefs.push(href);
  }
  
  // Look for URLs embedded in JavaScript variables and data structures
  const reJsVars = /(?:var|let|const)\s+\w+\s*=\s*["'`](https?:\/\/[^"'`]+)["'`]/gi;
  while ((m = reJsVars.exec(html)) !== null) {
    const href = decodeHtml(m[1]);
    if (href && !hrefs.includes(href)) hrefs.push(href);
  }
  
  // Look for URLs in JavaScript object properties
  const reJsProps = /"url":\s*["'`](https?:\/\/[^"'`]+)["'`]/gi;
  while ((m = reJsProps.exec(html)) !== null) {
    const href = decodeHtml(m[1]);
    if (href && !hrefs.includes(href)) hrefs.push(href);
  }
  
  // Look for URLs in JavaScript function calls
  const reJsFuncCalls = /(?:window\.open|location\.href|fetch|XMLHttpRequest)\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/gi;
  while ((m = reJsFuncCalls.exec(html)) !== null) {
    const href = decodeHtml(m[1]);
    if (href && !hrefs.includes(href)) hrefs.push(href);
  }
  
  // Look for URLs in the specific JavaScript data we saw in logs
  const reWizData = /window\.WIZ_global_data\s*=\s*({[\s\S]*?});/gi;
  while ((m = reWizData.exec(html)) !== null) {
    try {
      const jsonStr = m[1];
      // Look for any URLs in the WIZ data
      const urlMatches = jsonStr.match(/(https?:\/\/[^\s"',}]+)/g);
      if (urlMatches) {
        for (const match of urlMatches) {
          const url = match.trim();
          if (url && url.includes('http') && !hrefs.includes(url)) {
            hrefs.push(url);
          }
        }
      }
    } catch (e) {
      // ignore JSON parsing errors
    }
  }
  
  // Look for URLs that might be base64 encoded or in different formats
  const reEncodedUrls = /(?:url|href|link|source)\s*[:=]\s*["'`]?([a-zA-Z0-9+/=]{20,})["'`]?/gi;
  while ((m = reEncodedUrls.exec(html)) !== null) {
    try {
      const encoded = m[1];
      // Try to decode base64
      const decoded = atob(encoded);
      if (decoded && decoded.includes('http')) {
        const urlMatches = decoded.match(/(https?:\/\/[^\s"',}]+)/g);
        if (urlMatches) {
          for (const url of urlMatches) {
            if (!hrefs.includes(url)) hrefs.push(url);
          }
        }
      }
    } catch (e) {
      // ignore base64 decoding errors
    }
  }
  
  // Look for URLs in data attributes that might contain encoded data
  const reDataUrls = /data-(?:url|href|link|source)="([^"]+)"/gi;
  while ((m = reDataUrls.exec(html)) !== null) {
    const value = m[1];
    if (value && value.includes('http')) {
      if (!hrefs.includes(value)) hrefs.push(value);
    } else if (value && value.length > 20) {
      // Try to decode if it looks like encoded data
      try {
        const decoded = decodeURIComponent(value);
        if (decoded && decoded.includes('http')) {
          const urlMatches = decoded.match(/(https?:\/\/[^\s"',}]+)/g);
          if (urlMatches) {
            for (const url of urlMatches) {
              if (!hrefs.includes(url)) hrefs.push(url);
            }
          }
        }
      } catch (e) {
        // ignore decoding errors
      }
    }
  }
  
  // Look for URLs in JavaScript variables that might be concatenated or constructed
  const reJsConstructedUrls = /(?:url|href|link)\s*[:=]\s*["'`]([^"'`]*)\s*\+\s*["'`]([^"'`]+)["'`]/gi;
  while ((m = reJsConstructedUrls.exec(html)) !== null) {
    const part1 = m[1];
    const part2 = m[2];
    if (part1 && part2) {
      const constructedUrl = part1 + part2;
      if (constructedUrl.includes('http') && !hrefs.includes(constructedUrl)) {
        hrefs.push(constructedUrl);
      }
    }
  }
  
  // Look for URLs in Google News specific data structures that might contain external links
  const reGNewsExternalData = /(?:external|source|publisher|original)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi;
  while ((m = reGNewsExternalData.exec(html)) !== null) {
    const value = m[1];
    if (value && value.includes('http') && !hrefs.includes(value)) {
      hrefs.push(value);
    }
  }
  
  // Look for URLs in Google News specific JavaScript patterns
  const reGNewsJsPatterns = [
    /window\.(?:GNS|News|Article)\.(?:url|link|source)\s*=\s*["'`]([^"'`]+)["'`]/gi,
    /(?:GNS|News|Article)\.(?:url|link|source)\s*=\s*["'`]([^"'`]+)["'`]/gi,
    /(?:url|link|source)\s*[:=]\s*["'`]([^"'`]*\.(?:com|org|net|co|io)[^"'`]*)["'`]/gi
  ];
  
  for (const pattern of reGNewsJsPatterns) {
    while ((m = pattern.exec(html)) !== null) {
      const value = m[1];
      if (value && value.includes('http') && !hrefs.includes(value)) {
        hrefs.push(value);
      }
    }
  }
  
  // Look for any text that contains domain patterns that might be URLs
  const reDomainPatterns = /(?:https?:\/\/)?([a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]\.(?:com|org|net|co|io|dev|news|media|press|journal|times|post|tribune|herald|gazette|chronicle|observer|review|weekly|daily|magazine|blog|site|web|online|digital))/gi;
  while ((m = reDomainPatterns.exec(html)) !== null) {
    const domain = m[1];
    if (domain && !domain.includes('google.com') && !domain.includes('gstatic.com') && 
        !domain.includes('googleusercontent.com') && !domain.includes('cdn.ampproject.org')) {
      // Try to construct a full URL
      const potentialUrl = `https://${domain}`;
      if (!hrefs.includes(potentialUrl)) {
        hrefs.push(potentialUrl);
      }
    }
  }
  
  // Look for any text that looks like it might be a URL fragment
  const reUrlFragments = /(?:url|href|link|source|redirect|target)\s*[:=]\s*["'`]?([^"'`\s,}]+(?:\.com|\.org|\.net|\.co|\.io)[^"'`\s,}]*)/gi;
  while ((m = reUrlFragments.exec(html)) !== null) {
    const fragment = m[1];
    if (fragment && fragment.includes('.') && !hrefs.includes(fragment)) {
      // If it doesn't start with http, try to add it
      const fullUrl = fragment.startsWith('http') ? fragment : `https://${fragment}`;
      if (!hrefs.includes(fullUrl)) {
        hrefs.push(fullUrl);
      }
    }
  }
  
  // Look for any text that contains common news/publisher domains
  const commonNewsDomains = [
    'screenrant.com', 'yahoo.com', 'cnn.com', 'bbc.com', 'reuters.com', 'ap.org',
    'npr.org', 'nytimes.com', 'washingtonpost.com', 'wsj.com', 'bloomberg.com',
    'forbes.com', 'techcrunch.com', 'theverge.com', 'engadget.com', 'ars-technica.com',
    'polygon.com', 'ign.com', 'gamespot.com', 'kotaku.com', 'destructoid.com'
  ];
  
  for (const domain of commonNewsDomains) {
    const reDomain = new RegExp(`(https?://[^"'\s,}]*${domain.replace(/\./g, '\\.')}[^"'\s,}]*?)`, 'gi');
    while ((m = reDomain.exec(html)) !== null) {
      const url = m[1];
      if (url && !hrefs.includes(url)) {
        hrefs.push(url);
      }
    }
  }
  
  console.log('[GNS] Found potential URLs:', hrefs.length);
  
  // Debug: Log some of the URLs we found
  if (hrefs.length > 0) {
    console.log('[GNS] Sample URLs found:', hrefs.slice(0, 10));
    
    // Also log any non-Google domains we found
    const nonGoogleDomains = new Set();
    for (const url of hrefs) {
      try {
        const urlObj = new URL(url);
        const host = urlObj.hostname;
        if (host && !host.includes('google.com') && !host.includes('gstatic.com') && 
            !host.includes('googleusercontent.com') && !host.includes('cdn.ampproject.org')) {
          nonGoogleDomains.add(host);
        }
      } catch (e) {
        // ignore malformed URLs
      }
    }
    if (nonGoogleDomains.size > 0) {
      console.log('[GNS] Non-Google domains found:', Array.from(nonGoogleDomains));
    }
    
    // Debug: Show URLs found in Google News specific patterns
    console.log('[GNS] All URLs found for debugging:');
    hrefs.forEach((url, index) => {
      try {
        const urlObj = new URL(url);
        const host = urlObj.hostname;
        const path = urlObj.pathname;
        console.log(`[GNS] URL ${index + 1}: ${url} (host: ${host}, path: ${path})`);
      } catch (e) {
        console.log(`[GNS] URL ${index + 1}: ${url} (malformed)`);
      }
    });
  }
  
  // First pass: look for URLs that are clearly external articles
  for (const h of hrefs) {
    try {
      const url = new URL(h);
      const host = url.hostname || '';
      const path = url.pathname || '';
      
      // Skip Google domains
      if (host.includes('google.com') || host.includes('gstatic.com') || 
          host.includes('googleusercontent.com') || host.includes('cdn.ampproject.org')) {
        continue;
      }
      
      // Check if URL is blacklisted
      if (isUrlBlacklisted(host, path)) {
        continue;
      }
      
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
        /\/articles\//, // /articles/ in path
        /\/entertainment\//, // /entertainment/ in path
        /\/tech\//, // /tech/ in path
        /\/sports\//, // /sports/ in path
        /\/politics\//, // /politics/ in path
        /\/business\//, // /business/ in path
        /\/world\//, // /world/ in path
        /\/local\//, // /local/ in path
        /\/opinion\//, // /opinion/ in path
        /\/lifestyle\//, // /lifestyle/ in path
        /\/health\//, // /health/ in path
        /\/science\//, // /science/ in path
      ];
      
      // If any article pattern matches, it's likely an article
      for (const pattern of articlePatterns) {
        if (pattern.test(path)) {
          console.log('[GNS] Found likely article URL with pattern:', h, 'pattern:', pattern);
          return h;
        }
      }
      
      // Also check for URLs with substantial path content, but be more selective
      if (path.length > 15 && /[a-zA-Z]/.test(path)) {
        console.log('[GNS] Found potential article URL with substantial path:', h, 'path length:', path.length);
        return h;
      }
      
    } catch (e) {
      // ignore malformed URLs
    }
  }
  
  // Second pass: look for any non-Google URLs, even if they don't look like articles
  // but be more selective about what we consider an article
  console.log('[GNS] Starting fallback URL search...');
  for (const h of hrefs) {
    try {
      const url = new URL(h);
      const host = url.hostname || '';
      const path = url.pathname || '';
      
      console.log('[GNS] Checking fallback URL:', h, 'host:', host, 'path:', path);
      
      // Skip Google domains
      if (host.includes('google.com') || host.includes('gstatic.com') || 
          host.includes('googleusercontent.com') || host.includes('cdn.ampproject.org')) {
        console.log('[GNS] Skipping Google domain in fallback:', h);
        continue;
      }
      
      // Check if URL is blacklisted using the same helper function
      if (isUrlBlacklisted(host, path)) {
        console.log('[GNS] Skipping blacklisted URL in fallback:', h);
        continue;
      }
      
      // Look for any external domain that could potentially contain articles
      if (host && host !== 'news.google.com') {
        // Additional checks to ensure this looks like a news/publisher site
        const isLikelyNewsSite = 
          // Common news/publisher domain patterns
          /(news|media|press|journal|times|post|tribune|herald|gazette|chronicle|observer|review|weekly|daily|magazine|blog|site|web|online|digital|com|org|net|co|io|dev)/i.test(host) ||
          // Has substantial path content
          (path.length > 10 && /[a-zA-Z]/.test(path)) ||
          // Contains common news-related path segments
          /(article|story|post|blog|news|content|page|view|read)/i.test(path);
        
        if (isLikelyNewsSite) {
          console.log('[GNS] Found likely external article URL:', h, 'host:', host, 'path:', path);
          return h;
        } else {
          console.log('[GNS] URL doesn\'t look like a news site:', h);
        }
      }
    } catch (e) {
      console.log('[GNS] Error processing fallback URL:', h, e);
      // ignore malformed URLs
    }
  }
  
  // Third pass: if we still haven't found anything, look for ANY external domain
  // that's not Google and not blacklisted
  console.log('[GNS] Starting final fallback search for any external domain...');
  for (const h of hrefs) {
    try {
      const url = new URL(h);
      const host = url.hostname || '';
      const path = url.pathname || '';
      
      // Skip Google domains
      if (host.includes('google.com') || host.includes('gstatic.com') || 
          host.includes('googleusercontent.com') || host.includes('cdn.ampproject.org')) {
        continue;
      }
      
      // Check if URL is blacklisted
      if (isUrlBlacklisted(host, path)) {
        continue;
      }
      
      // If we find any external domain that passes our filters, use it
      if (host && host !== 'news.google.com') {
        console.log('[GNS] Found final fallback external URL:', h, 'host:', host);
        return h;
      }
    } catch (e) {
      // ignore malformed URLs
    }
  }
  
  console.log('[GNS] No external URLs found');
  return '';
}

function extractMetaRefreshUrl(html) {
  if (!html || typeof html !== 'string') return '';
  // <meta http-equiv="refresh" content="0;url=https://example.com/...">
  const m = html.match(/<meta[^>]*http-equiv=["']?refresh["']?[^>]*content=["'][^;]*;\s*url=([^"']+)["']/i);
  return m ? decodeHtml(m[1]) : '';
}

function extractCanonicalUrl(html) {
  if (!html || typeof html !== 'string') return '';
  const m = html.match(/<link[^>]*rel=["']?canonical["']?[^>]*href=["']([^"']+)["']/i);
  return m ? decodeHtml(m[1]) : '';
}

function extractOgUrl(html) {
  if (!html || typeof html !== 'string') return '';
  const m = html.match(/<meta[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i);
  return m ? decodeHtml(m[1]) : '';
}

function extractAmpUrl(html) {
  if (!html || typeof html !== 'string') return '';
  const m = html.match(/<link[^>]*rel=["']amphtml["'][^>]*href=["']([^"']+)["']/i);
  return m ? decodeHtml(m[1]) : '';
}

function extractAnyExternalUrl(html) {
  if (!html || typeof html !== 'string') return '';
  const re = /https?:\/\/[^\s"'<>]+/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = decodeHtml(m[0]);
    if (isLikelyArticleUrl(href)) return href;
  }
  return '';
}

function decodeHtml(s) {
  if (!s) return s;
  return s
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/'/g, "'");
}

// Heuristics to decide if a URL is likely the external article (not an asset/tracker)
function isDisallowedHost(hostname) {
  return /(news\.google\.com|google\.[^\/]+|gstatic\.com|googleusercontent\.com|googleapis\.com|doubleclick\.net|googletagmanager\.com|google-analytics\.com|scorecardresearch\.com|adservice\.google\.com|youtube\.com|twitter\.com|facebook\.com|t\.co|cdn\.ampproject\.org|w3\.org|schema\.org|ogp\.me|opengraphprotocol\.org)/i.test(
    hostname
  );
}

function isLikelyArticleUrl(href) {
  try {
    const u = new URL(href);
    if (isDisallowedHost(u.hostname)) return false;
    const path = u.pathname || '';
    
    // Exclude common asset extensions
    if (/\.(js|css|png|jpe?g|gif|webp|svg|ico|json|xml|woff2?|ttf|eot)(\?|$)/i.test(path)) return false;
    
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
    
    // Require some path depth and alphanumeric content, but be less restrictive
    return path.length > 5 && /[a-zA-Z]/.test(path);
  } catch {
    return false;
  }
}

function htmlToText(html) {
  if (!html) return '';
  // Remove script/style blocks
  html = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  html = html.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  // Replace common block closers with newlines to retain structure
  html = html.replace(/<\/(p|div|h[1-6]|li|ul|ol|section|article|header|footer|br)\s*>/gi, '\n');
  // Strip all remaining tags
  html = html.replace(/<[^>]+>/g, ' ');
  // Decode a few common HTML entities
  const entities = {
    '&nbsp;': ' ',
    '&': '&',
    '<': '<',
    '>': '>',
    '"': '"',
    '&#39;': "'",
    "'": "'"
  };
  html = html.replace(/(&nbsp;|&|<|>|"|&#39;|')/g, m => entities[m] || m);
  // Collapse whitespace
  html = html.replace(/\s+/g, ' ').trim();
  // Limit length
  const MAX_CHARS = 20000;
  if (html.length > MAX_CHARS) html = html.slice(0, MAX_CHARS);
  return html;
}

/**
 * Attempt to extract the main article text using a DOM-based heuristic.
 * If DOMParser is unavailable (e.g., some service worker contexts), returns ''.
 */
function extractMainText(html) {
  try {
    if (typeof DOMParser === 'undefined') return '';
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    if (!doc) return '';

    // Remove obvious non-content
    doc.querySelectorAll('script,noscript,style,svg,canvas,iframe,form,header,footer,nav').forEach(n => n.remove());

    // Collect candidates with preference
    const candidates = [];
    const push = (el) => { if (el && !candidates.includes(el)) candidates.push(el); };

    push(doc.querySelector('article'));
    push(doc.querySelector('main'));
    doc.querySelectorAll('[role="main"]').forEach(push);

    const hints = [
      '.article-body', '.articleBody', '.post-content', '.entry-content',
      '.story-body', '.content__article-body', '.c-article-content',
      '#content', '#main', '.content', '.story', '.StoryBodyCompanionColumn'
    ];
    hints.forEach(sel => doc.querySelectorAll(sel).forEach(push));

    // Scoring function: prioritize non-link text and paragraph count
    const score = (el) => {
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const len = text.length;
      if (len < 200) return 0; // too small
      const linkLen = Array.from(el.querySelectorAll('a')).reduce((s, a) => s + ((a.innerText || '').length), 0);
      const pCount = el.querySelectorAll('p').length;
      return (len - linkLen) + pCount * 50;
    };

    let best = null;
    let bestScore = 0;

    // Score preferred candidates first
    candidates.forEach(el => {
      const s = score(el);
      if (s > bestScore) { best = el; bestScore = s; }
    });

    // If nothing strong found, scan broader set
    if (!best) {
      const blocks = Array.from(doc.querySelectorAll('article,main,section,div'));
      for (const el of blocks) {
        const s = score(el);
        if (s > bestScore) { best = el; bestScore = s; }
      }
    }

    if (!best) return '';

    // Clean secondary clutter within best
    best.querySelectorAll('aside,button,figure,figcaption,ul.share,div.share,div.ad,div.ads,div[class*="ad-"],div[id*="ad-"]').forEach(n => n.remove());

    const output = (best.innerText || best.textContent || '').replace(/\s+/g, ' ').trim();
    const MAX = 30000;
    return output.slice(0, MAX);
  } catch (e) {
    console.warn('[GNS] extractMainText failed, falling back to htmlToText:', e && e.message ? e.message : e);
    return '';
  }
}

/**
 * Provider abstraction - initial implementation for OpenAI Chat Completions
 */
async function summarizeWithProvider(text, settings) {
  const provider = (settings.provider || 'openai').toLowerCase();
  switch (provider) {
    case 'openai':
      return summarizeWithOpenAI(text, settings);
    default:
      throw new Error(`Unsupported provider: ${settings.provider}`);
  }
}

function buildPrompt(text, settings) {
  // Trim and cap length (to keep latency/cost low)
  const MAX_CHARS = 8000;
  const t = (text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);

  const system = settings && settings.systemPrompt
    ? settings.systemPrompt
    : `You are a news summarizer.\n- Return exactly one concise sentence (max 25 words).\n- No emojis, no quotes, no markdown.\n- Be factual and neutral.`;

  const user = `Summarize the following content into ONE single-line sentence (max 25 words):\n---\n${t}\n---`;

  return { system, user };
}

async function summarizeWithOpenAI(text, settings) {
  const { apiKey, model } = settings;
  if (!apiKey) {
    console.error('[GNS] No API key set in settings:', { ...settings, apiKey: settings.apiKey ? '[set]' : '' });
    throw new Error('OpenAI API key not set. Configure it in the extension Options.');
  }

  const { system, user } = buildPrompt(text, settings);
  // If using a GPT-5 family model, use the Responses API directly (chat max_tokens is unsupported)
  const modelName = (settings.model || '').toLowerCase();
  if (modelName.startsWith('gpt-5')) {
    return await summarizeWithOpenAIResponses(system, user, settings);
  }

  // Chat Completions API for non-GPT-5 models (omit temperature and token caps)
  const chatBody = {
    model: model || 'gpt-5-nano',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  };
  console.log('[GNS] Sending request to OpenAI (chat.completions):', { ...chatBody });
  const key = (apiKey || '').trim();
  validateHeaderByteString('Authorization', `Bearer ${key}`);
  validateHeaderByteString('Content-Type', 'application/json');
  const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(chatBody)
  });
  console.log('[GNS] OpenAI response status (chat):', chatRes.status);

  if (chatRes.ok) {
    const chatData = await chatRes.json();
    const content = chatData?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
      console.error('[GNS] No summary returned by OpenAI (chat):', chatData);
      throw new Error('No summary returned by OpenAI');
    }
    return sanitizeOneLine(content);
  } else {
    const errText = await safeText(chatRes);
    console.error('[GNS] OpenAI error response (chat):', errText);

    // Some newer models (e.g., gpt-5-* / nano) require the Responses API and use max_completion_tokens.
    if (chatRes.status === 400 && /max_tokens/i.test(errText) && /max_?completion_?tokens/i.test(errText)) {
      return await summarizeWithOpenAIResponses(system, user, settings);
    }

    throw new Error(`OpenAI error (${chatRes.status}): ${errText}`);
  }
}

/**
 * Fallback path for models that require the Responses API.
 * Uses max_completion_tokens per error guidance.
 */
async function summarizeWithOpenAIResponses(system, user, settings) {
  const { apiKey, model } = settings;
  const base = {
    model: model || 'gpt-5-nano',
    // Provide system behavior via top-level instructions.
    instructions: system,
    // Responses API expects input parts with specific types; use input_text for user input.
    input: [
      { role: 'user', content: [{ type: 'input_text', text: user }] }
    ],
    // Avoid tool calls to reduce token use
    tool_choice: 'none'
  };

  const key = (apiKey || '').trim();
  validateHeaderByteString('Authorization', `Bearer ${key}`);
  validateHeaderByteString('Content-Type', 'application/json');

  // Try without explicit cap first to avoid premature truncation; then fallback with a cap
  const caps = [null, 512];

  let lastErrText = null;
  for (const cap of caps) {
    for (const useTextFormat of [true, false]) {
      const body = { ...base };
      if (useTextFormat) body.text = { format: { type: 'text' }, verbosity: 'low' };
      if (cap != null) body.max_output_tokens = cap;

      console.log('[GNS] Sending request to OpenAI (responses):', { ...body, input: '[messages elided]' });
      const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
          'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
      console.log('[GNS] OpenAI response status (responses):', res.status);

      if (res.ok) {
        const data = await res.json();

        // Try a few shapes returned by Responses API
        let content = null;
        if (typeof data.output_text === 'string') {
          content = data.output_text;
        } else if (Array.isArray(data.output)) {
          for (const item of data.output) {
            if (item?.type === 'message' && Array.isArray(item.content)) {
              const textPart = item.content.find(p => typeof p?.text === 'string' || p?.type === 'output_text' || p?.type === 'summary_text');
              if (textPart && (typeof textPart.text === 'string' || typeof textPart.value === 'string')) {
                content = (textPart.text || textPart.value);
                break;
              }
            }
          }
        } else if (Array.isArray(data.content)) {
          const textPart = data.content.find(p => typeof p?.text === 'string' || p?.type === 'output_text' || p?.type === 'summary_text');
          if (textPart) content = textPart.text || textPart?.content || textPart?.value || '';
        }

        // Additional aggregation attempt if structure differs
        if ((!content || typeof content !== 'string') && Array.isArray(data.output)) {
          try {
            const parts = [];
            for (const item of data.output) {
              if (item && Array.isArray(item.content)) {
                for (const p of item.content) {
                  if (p && (typeof p.text === 'string' || typeof p.value === 'string')) {
                    parts.push(p.text || p.value);
                  }
                }
              }
            }
            if (parts.length) content = parts.join(' ').replace(/\s+/g, ' ').trim();
          } catch {}
        }

        // If still nothing and the response is incomplete (likely capped), try a higher cap
        if (!content || typeof content !== 'string' || !content.trim()) {
          if (String(data?.status).toLowerCase() === 'incomplete' && cap !== caps[caps.length - 1]) {
            // Try next cap
            break; // break inner loop; go to next cap
          }
          console.error('[GNS] No summary returned by OpenAI (responses):', data);
    throw new Error('No summary returned by OpenAI');
  }
  return sanitizeOneLine(content);
      } else {
        const errText = await safeText(res);
        console.error('[GNS] OpenAI error response (responses):', errText);
        lastErrText = errText;

        // If 'text.format' is unsupported, try again without the text.format field
        if (/unsupported_parameter/i.test(errText) && /text\.format/i.test(errText)) {
          continue;
        }
        // If 'tool_choice' is unsupported, try again without it
        if (/unsupported_parameter/i.test(errText) && /tool_choice/i.test(errText)) {
          continue;
        }
        // Otherwise move to next cap
        break;
      }
    }
  }
  throw new Error(`OpenAI error (responses): ${lastErrText || 'unknown error'}`);
}

function validateHeaderByteString(name, value) {
  // Conservative: enforce ASCII only. Firefox requires ByteString (<=255), but API keys should be ASCII.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 127) {
      // Do not echo the value; provide a clear, actionable error.
      throw new Error(`Header "${name}" contains a non-ASCII character (e.g., "smart quotes" or an ellipsis). Re-copy your API key exactly from OpenAI (no …) and paste plain text.`);
    }
  }
  // Heuristic guard: extremely long keys usually indicate copying a truncated UI string with an ellipsis.
  if (name.toLowerCase() === 'authorization') {
    const keyPart = value.replace(/^Bearer\s+/i, '');
    if (keyPart.length > 200) {
      throw new Error('API key appears unusually long. Ensure you copied the exact key (no hidden/truncated characters).');
    }
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}

function sanitizeOneLine(s) {
  // Ensure single line and reasonable length
  const one = s.replace(/\s+/g, ' ').trim();
  // Soft cap ~200 chars
  return one.length > 200 ? one.slice(0, 200).trim() + '…' : one;
}

/**
 * Try to extract article content directly from the Google News page
 * This is a fallback when redirect detection fails or leads to non-article pages
 */
function extractArticleContentFromGoogleNews(html) {
  if (!html || typeof html !== 'string') return '';
  
  console.log('[GNS] Attempting to extract article content from Google News page');
  
  try {
    // Use DOMParser if available to extract content more intelligently
    if (typeof DOMParser !== 'undefined') {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      if (!doc) return '';
      
      // Look for common Google News content selectors
      const contentSelectors = [
        '[data-n-tid="29"]', // Google News article title
        '.gPFEn', // Google News article title class
        '.UOVeFe', // Google News article metadata
        '.JfXTR', // Google News article content area
        'article', // Article elements
        '[role="article"]', // Article role elements
        '.hLNLFf', // Google News article container
        '.MCAGUe', // Google News article wrapper
        '.vr1PYe', // Google News source name
        '.bInasb', // Google News byline
        '.hvbAAd', // Google News timestamp
        '.CUjhod' // Google News category
      ];
      
      let extractedText = '';
      for (const selector of contentSelectors) {
        const elements = doc.querySelectorAll(selector);
        console.log(`[GNS] Found ${elements.length} elements with selector: ${selector}`);
        for (const el of elements) {
          const text = el.textContent || '';
          if (text && text.length > 20 && !text.includes('Google News') && !text.includes('Skip to main')) {
            console.log(`[GNS] Extracted text from ${selector}:`, text.substring(0, 100));
            extractedText += text + ' ';
          }
        }
      }
      
      if (extractedText.trim().length > 200) {
        console.log('[GNS] Successfully extracted article content, length:', extractedText.trim().length);
        return extractedText.trim();
      } else {
        console.log('[GNS] Extracted content too short:', extractedText.trim().length);
      }
    }
    
    // Fallback: use regex to find content blocks with more patterns
    console.log('[GNS] Trying regex fallback extraction');
    const contentPatterns = [
      /<[^>]*class="[^"]*(?:gPFEn|UOVeFe|JfXTR|hLNLFf|MCAGUe|vr1PYe|bInasb|hvbAAd|CUjhod)[^"]*"[^>]*>([^<]+)<\/[^>]*>/gi,
      /<[^>]*data-n-tid="[^"]*"[^>]*>([^<]+)<\/[^>]*>/gi,
      /<[^>]*jslog="[^"]*"[^>]*>([^<]+)<\/[^>]*>/gi
    ];
    
    for (const pattern of contentPatterns) {
      const contentBlocks = html.match(pattern);
      if (contentBlocks) {
        console.log(`[GNS] Found ${contentBlocks.length} content blocks with pattern`);
        let extracted = '';
        for (const block of contentBlocks) {
          const textMatch = block.match(/>([^<]+)</);
          if (textMatch && textMatch[1]) {
            const text = textMatch[1].trim();
            if (text.length > 20 && !text.includes('Google News') && !text.includes('Skip to main')) {
              console.log(`[GNS] Extracted text from regex:`, text.substring(0, 100));
              extracted += text + ' ';
            }
          }
        }
        if (extracted.trim().length > 200) {
          console.log('[GNS] Successfully extracted content with regex, length:', extracted.trim().length);
          return extracted.trim();
        }
      }
    }
    
    // Last resort: try to find any meaningful text content
    console.log('[GNS] Trying last resort text extraction');
    const textMatches = html.match(/>([^<]{50,})</g);
    if (textMatches) {
      let extracted = '';
      for (const match of textMatches) {
        const text = match.replace(/^>|<$/g, '').trim();
        if (text.length > 50 && !text.includes('Google News') && !text.includes('Skip to main') && !text.includes('Advertisement')) {
          console.log(`[GNS] Last resort text:`, text.substring(0, 100));
          extracted += text + ' ';
        }
      }
      if (extracted.trim().length > 200) {
        console.log('[GNS] Successfully extracted content with last resort, length:', extracted.trim().length);
        return extracted.trim();
      }
    }
    
    console.log('[GNS] Failed to extract meaningful content from Google News page');
    return '';
  } catch (e) {
    console.log('[GNS] Error extracting content from Google News page:', e);
    return '';
  }
}

async function extractTextFromRegularUrl(url) {
  try {
    const html = await fetchHtml(url);
    return await tryParse(html);
  } catch (error) {
    console.error('[GNS] Error extracting from regular URL:', error);
    throw error;
  }
}

async function tryParse(html) {
  try {
    // Use regex-based parsing since DOMParser is not available in background scripts
    
    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';
    
    // Extract meta description
    const metaDescMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i);
    const metaDesc = metaDescMatch ? metaDescMatch[1].trim() : '';
    
    // Extract Open Graph description
    const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i);
    const ogDesc = ogDescMatch ? ogDescMatch[1].trim() : '';
    
    // Try to extract main content using regex patterns
    let mainContent = '';
    
    // Look for common content selectors
    const contentSelectors = [
      /<main[^>]*>([\s\S]*?)<\/main>/i,
      /<article[^>]*>([\s\S]*?)<\/article>/i,
      /<div[^>]*class=["'][^"']*content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      /<div[^>]*class=["'][^"']*post-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      /<div[^>]*class=["'][^"']*entry-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      /<div[^>]*class=["'][^"']*article-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      /<div[^>]*class=["'][^"']*story-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    ];
    
    for (const selector of contentSelectors) {
      const match = html.match(selector);
      if (match && match[1]) {
        // Strip HTML tags and clean up
        const text = match[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (text.length > 200) {
          mainContent = text;
          break;
        }
      }
    }
    
    // Extract body content as fallback
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyContent = bodyMatch ? bodyMatch[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    
    // Combine all available content, prioritizing main content
    let combinedContent = '';
    if (mainContent && mainContent.length > 200) {
      combinedContent = mainContent;
    } else if (metaDesc && metaDesc.length > 100) {
      combinedContent = metaDesc;
    } else if (ogDesc && ogDesc.length > 100) {
      combinedContent = ogDesc;
    } else if (bodyContent && bodyContent.length > 200) {
      combinedContent = bodyContent;
    }
    
    // Clean up the content
    if (combinedContent) {
      combinedContent = combinedContent
        .replace(/\s+/g, ' ')
        .replace(/\n+/g, ' ')
        .trim();
      
      // If we have a title, prepend it
      if (title && !combinedContent.includes(title)) {
        combinedContent = title + '. ' + combinedContent;
      }
      
      return combinedContent;
    }
    
    // Fallback to title + description
    if (title || metaDesc || ogDesc) {
      return [title, metaDesc, ogDesc].filter(Boolean).join('. ');
    }
    
    // Last resort: extract any meaningful text from the HTML
    const textContent = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (textContent.length > 100) {
      return textContent.substring(0, 2000); // Limit length
    }
    
    return '';
  } catch (e) {
    console.log('[GNS] Error parsing HTML:', e);
    return '';
  }
}

// Open options page when extension icon is clicked (MV3 and MV2 support)
if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(() => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open('options/options.html');
    }
  });
} else if (chrome.browserAction && chrome.browserAction.onClicked) {
  chrome.browserAction.onClicked.addListener(() => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open('options/options.html');
    }
  });
}
