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
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
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
  // Helper to parse HTML into main article text if possible
  const tryParse = (html) => {
    const main = extractMainText(html);
    if (main && main.length >= 400) return main;
    return htmlToText(html);
  };

  // If the read URL issues an immediate redirect to the publisher, use that target
  const probe = await probeExternalRedirect(url).catch(() => '');
  if (probe && isLikelyArticleUrl(probe)) {
    try {
      const htmlProbe = await fetchHtml(probe);
      return tryParse(htmlProbe);
    } catch { /* fall through */ }
  }

  let html = await fetchHtml(url);
  try {
    const u = new URL(url);
    const isGNews = /(^|\.)news\.google\.com$/i.test(u.hostname);
    if (isGNews) {
      // Try common redirect hints from the Google News "read" page
      const candidates = [];
      const metaUrl = extractMetaRefreshUrl(html);
      if (metaUrl) candidates.push(metaUrl);
      const canonicalUrl = extractCanonicalUrl(html);
      if (canonicalUrl) candidates.push(canonicalUrl);
      const ogUrl = extractOgUrl(html);
      if (ogUrl) candidates.push(ogUrl);
      const ampUrl = extractAmpUrl(html);
      if (ampUrl) candidates.push(ampUrl);
      const externalHref = extractExternalUrlFromGoogleNews(html);
      if (externalHref) candidates.push(externalHref);

      // Pick the first candidate that isn't a Google domain
      const disallow = /(news\.google\.com|google\.[^\/]+|gstatic\.com|googleusercontent\.com|googleapis\.com)/i;
      const target = candidates.find(h => h && !disallow.test(h));

      if (target) {
        try {
          html = await fetchHtml(target);
        } catch (e) {
          console.warn('[GNS] Failed to fetch external article, using Google News page text instead:', e && e.message ? e.message : e);
        }
      }
    }
  } catch {
    // ignore URL parse errors; just proceed with htmlToText
  }
  return tryParse(html);
}

/**
 * Convert HTML to plain text: remove scripts/styles, strip tags, collapse whitespace.
 */
function extractExternalUrlFromGoogleNews(html) {
  if (!html || typeof html !== 'string') return '';
  // Collect all absolute hrefs
  const hrefs = [];
  const reHref = /href="(https?:\/\/[^"]+)"/gi;
  let m;
  while ((m = reHref.exec(html)) !== null) {
    const href = decodeHtml(m[1]);
    if (href) hrefs.push(href);
  }
  // Also consider data-url attributes as fallbacks
  const reData = /data-url="(https?:\/\/[^"]+)"/gi;
  while ((m = reData.exec(html)) !== null) {
    const href = decodeHtml(m[1]);
    if (href) hrefs.push(href);
  }
  // Return the first href that looks like an article URL
  for (const h of hrefs) {
    if (isLikelyArticleUrl(h)) return h;
  }
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
    if (/\.(js|css|png|jpe?g|gif|webp|svg|ico|json|xml)(\?|$)/i.test(path)) return false;
    // Require some path depth and alphanumeric content
    return path.length > 10 && /[a-zA-Z]/.test(path);
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
      throw new Error(`Header "${name}" contains a non-ASCII character (e.g., “smart quotes” or an ellipsis). Re-copy your API key exactly from OpenAI (no …) and paste plain text.`);
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
