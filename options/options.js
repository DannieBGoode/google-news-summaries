/* Options page logic for Google News Summaries */

const DEFAULTS = {
  provider: 'openai',
  model: 'gpt-5-nano',
  apiKey: '',
  deepFetch: false,
  systemPrompt: `You are a news summarizer.\n- Return exactly one concise sentence (max 25 words).\n- No emojis, no quotes, no markdown.\n- Be factual and neutral.`
};

const els = {};
document.addEventListener('DOMContentLoaded', init);

async function init() {
  cacheEls();
  await loadSettings();
  bindEvents();
}

function cacheEls() {
  els.form = document.getElementById('options-form');
  els.provider = document.getElementById('provider');
  els.model = document.getElementById('model');
  els.apiKey = document.getElementById('apiKey');
  els.deepFetch = document.getElementById('deepFetch');
  els.systemPrompt = document.getElementById('systemPrompt');
  els.status = document.getElementById('status');
  els.testBtn = document.getElementById('testBtn');
  els.testResult = document.getElementById('testResult');
}


async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const settings = { ...DEFAULTS, ...stored };
  console.log('[GNS][Options] Loaded settings:', { ...settings, apiKey: settings.apiKey ? '[set]' : '' });
  els.provider.value = settings.provider;
  els.model.value = settings.model;
  els.apiKey.value = settings.apiKey;
  els.deepFetch.checked = !!settings.deepFetch;
  els.systemPrompt.value = settings.systemPrompt;
}

function bindEvents() {
  els.form.addEventListener('submit', onSave);
  els.testBtn.addEventListener('click', onTest);
}

async function onSave(e) {
  e.preventDefault();
  const settings = {
    provider: els.provider.value,
    model: els.model.value.trim(),
    apiKey: els.apiKey.value.trim(),
    deepFetch: els.deepFetch.checked,
    systemPrompt: els.systemPrompt.value.trim() || DEFAULTS.systemPrompt
  };
  console.log('[GNS][Options] Saving settings:', { ...settings, apiKey: settings.apiKey ? '[set]' : '' });
  await chrome.storage.local.set(settings);
  setStatus('Settings saved.', 'ok');
}

function sendRuntimeMessage(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message || String(err)));
        } else {
          resolve(response);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function onTest() {
  setStatus('Testing settings…', 'loading');
  els.testResult.hidden = true;
  const sample = 'This is a sample news paragraph: World leaders met to discuss economic cooperation and pledged new measures to stabilize markets.';
  try {
    // Build settings from current form values and persist them before testing
    const settings = {
      provider: els.provider.value,
      model: els.model.value.trim(),
      apiKey: els.apiKey.value.trim(),
      deepFetch: els.deepFetch.checked,
      systemPrompt: (els.systemPrompt.value.trim() || DEFAULTS.systemPrompt)
    };
    console.log('[GNS][Options] Testing settings:', { ...settings, apiKey: settings.apiKey ? '[set]' : '' });
    await chrome.storage.local.set(settings);

    const resp = await sendRuntimeMessage({ type: 'summarize', text: sample, settings });
    console.log('[GNS][Options] Test response:', resp);

    if (!resp) throw new Error('No response from background (port closed).');
    if (!resp.ok) throw new Error(resp.error || 'Background returned an error');
    if (!resp.summary || typeof resp.summary !== 'string') throw new Error('No summary returned by background.');

    setStatus('Test successful.', 'ok');
    els.testResult.hidden = false;
    els.testResult.textContent = resp.summary;
  } catch (err) {
    setStatus('Test failed: ' + (err && err.message ? err.message : String(err)), 'error');
    els.testResult.hidden = false;
    els.testResult.textContent = (err && err.message ? err.message : String(err));
  }
}

function setStatus(msg, kind) {
  els.status.textContent = msg;
  els.status.className = '';
  if (kind) els.status.classList.add(kind);
}
