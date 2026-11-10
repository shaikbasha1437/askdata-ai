/* AgentKit LLM client: bring-your-own-key calls straight from the browser to OpenAI, Anthropic,
   Google Gemini or any OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter, vLLM ...).
   Pure request builders and response parsers (unit-tested with a mocked fetch), usage + cost maths. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.AgentKit = root.AgentKit || {}).llm = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // US list prices per 1M tokens, checked 2026-11-03 on each vendor's pricing page. Used only for cost estimates.
  const PRICES = {
    'gpt-5-mini': { in: 0.25, out: 2.0 }, 'gpt-5-nano': { in: 0.05, out: 0.4 }, 'gpt-5': { in: 1.25, out: 10 }, 'gpt-5.4-mini': { in: 0.75, out: 4.5 }, 'gpt-5.4-nano': { in: 0.2, out: 1.25 }, 'gpt-4.1-mini': { in: 0.4, out: 1.6 }, 'gpt-4o-mini': { in: 0.15, out: 0.6 },
    'claude-haiku-4-5': { in: 1, out: 5 }, 'claude-haiku-5-5': { in: 0.1, out: 0.5 }, 'claude-sonnet-4-5': { in: 3, out: 15 }, 'claude-sonnet-4-6': { in: 3, out: 15 }, 'claude-sonnet-5': { in: 2, out: 10 }, 'claude-sonnet-5-5': { in: 2, out: 10 },
    'gemini-2.5-flash': { in: 0.3, out: 2.5 }, 'gemini-2.5-flash-lite': { in: 0.1, out: 0.4 }, 'gemini-3.1-flash-lite': { in: 0.25, out: 1.5 }, 'gemini-3.5-flash-lite': { in: 0.3, out: 2.5 }, 'gemini-2.5-pro': { in: 1.25, out: 10 }
  };
  const PROVIDERS = {
    openai: { label: 'OpenAI', defaultModel: 'gpt-5-mini', models: ['gpt-5-mini', 'gpt-5-nano', 'gpt-5', 'gpt-5.4-mini', 'gpt-4.1-mini', 'gpt-4o-mini'], baseUrl: 'https://api.openai.com/v1', needsKey: true, keyHint: 'sk-...', pricingUrl: 'https://openai.com/api/pricing/', keyUrl: 'https://platform.openai.com/api-keys' },
    anthropic: { label: 'Anthropic', defaultModel: 'claude-haiku-4-5', models: ['claude-haiku-4-5', 'claude-haiku-5-5', 'claude-sonnet-4-5', 'claude-sonnet-5', 'claude-sonnet-5-5'], baseUrl: 'https://api.anthropic.com/v1', needsKey: true, keyHint: 'sk-ant-...', pricingUrl: 'https://platform.claude.com/docs/en/about-claude/pricing', keyUrl: 'https://console.anthropic.com/settings/keys' },
    gemini: { label: 'Google Gemini', defaultModel: 'gemini-2.5-flash', models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-pro'], baseUrl: 'https://generativelanguage.googleapis.com/v1beta', needsKey: true, keyHint: 'AIza...', pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing', keyUrl: 'https://aistudio.google.com/apikey' },
    compatible: { label: 'OpenAI-compatible', defaultModel: 'llama3.2', models: ['llama3.2', 'qwen2.5:7b', 'openai/gpt-5-mini', 'anthropic/claude-haiku-4.5'], baseUrl: 'http://localhost:11434/v1', needsKey: false, keyHint: 'optional', pricingUrl: '', keyUrl: '' }
  };
  const PRESETS = [
    { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
    { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', model: 'local-model' },
    { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini' }
  ];
  function trimSlash(u) { return String(u || '').replace(/\/+$/, ''); }
  /* Vision: msg.images = [{ mime, data(base64, no prefix) }] are attached to the LAST user message
     in each provider's own format. Text-only providers/models simply reject the request. */
  function withImages(p, messages, images) {
    if (!images || !images.length) return messages;
    const out = messages.slice();
    const i = out.map((m) => m.role).lastIndexOf('user');
    if (i < 0) return out;
    const text = String(out[i].content || '');
    let content;
    if (p === 'anthropic') content = images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } })).concat([{ type: 'text', text }]);
    else content = [{ type: 'text', text }].concat(images.map((im) => ({ type: 'image_url', image_url: { url: 'data:' + im.mime + ';base64,' + im.data } })));
    out[i] = { role: 'user', content };
    return out;
  }
  /* Build a fetch request. msg = { system, messages:[{role:'user'|'assistant', content}], maxTokens, temperature, json } */
  function buildRequest(cfg, msg) {
    const p = cfg.provider; const model = cfg.model || PROVIDERS[p].defaultModel; const key = cfg.key || '';
    const maxTokens = msg.maxTokens || 700;
    if (p === 'anthropic') {
      const body = { model, max_tokens: maxTokens, system: msg.system, messages: withImages('anthropic', msg.messages, msg.images) };
      if (msg.temperature != null) body.temperature = msg.temperature;
      return { url: trimSlash(cfg.baseUrl || PROVIDERS.anthropic.baseUrl) + '/messages', init: { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify(body) } };
    }
    if (p === 'gemini') {
      const body = { systemInstruction: { parts: [{ text: msg.system }] }, contents: msg.messages.map((m, i, all) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }].concat(msg.images && msg.images.length && i === all.map((x) => x.role).lastIndexOf('user') ? msg.images.map((im) => ({ inlineData: { mimeType: im.mime, data: im.data } })) : []) })), generationConfig: { maxOutputTokens: maxTokens } };
      if (msg.temperature != null) body.generationConfig.temperature = msg.temperature;
      if (msg.json) body.generationConfig.responseMimeType = 'application/json';
      return { url: trimSlash(cfg.baseUrl || PROVIDERS.gemini.baseUrl) + '/models/' + encodeURIComponent(model) + ':generateContent', init: { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) } };
    }
    // OpenAI and OpenAI-compatible chat completions.
    const messages = [{ role: p === 'openai' ? 'developer' : 'system', content: msg.system }].concat(withImages(p, msg.messages, msg.images));
    const body = { model, messages };
    if (p === 'openai') { body.max_completion_tokens = /^(gpt-5|gpt-6|o\d)/.test(model) ? maxTokens + 1500 : maxTokens; if (/^gpt-5(-mini|-nano)?$/.test(model)) body.reasoning_effort = 'minimal'; else if (!/^(gpt-5|gpt-6|o\d)/.test(model) && msg.temperature != null) body.temperature = msg.temperature; } else { body.max_tokens = maxTokens; if (msg.temperature != null) body.temperature = msg.temperature; }
    if (msg.json && p === 'openai') body.response_format = { type: 'json_object' };
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = 'Bearer ' + key;
    if (p === 'compatible' && /openrouter\.ai/.test(cfg.baseUrl || '')) { headers['HTTP-Referer'] = cfg.referer || 'https://shaikbasha1437.github.io/askdata-ai/'; headers['X-Title'] = cfg.title || 'AskData AI'; }
    return { url: trimSlash(cfg.baseUrl || PROVIDERS[p].baseUrl) + '/chat/completions', init: { method: 'POST', headers, body: JSON.stringify(body) } };
  }
  function parseResponse(provider, j) {
    if (provider === 'anthropic') {
      const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      return { text, usage: { input: (j.usage && j.usage.input_tokens) || 0, output: (j.usage && j.usage.output_tokens) || 0 }, stop: j.stop_reason, model: j.model };
    }
    if (provider === 'gemini') {
      const c = (j.candidates || [])[0] || {};
      const text = ((c.content && c.content.parts) || []).map((x) => x.text || '').join('');
      const u = j.usageMetadata || {};
      return { text, usage: { input: u.promptTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) }, stop: c.finishReason, model: j.modelVersion };
    }
    const ch = (j.choices || [])[0] || {};
    const u = j.usage || {};
    return { text: (ch.message && ch.message.content) || '', usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0 }, stop: ch.finish_reason, model: j.model };
  }
  function priceFor(model, table) { const t = table || PRICES; if (t[model]) return t[model]; const k = Object.keys(t).find((m) => String(model).endsWith('/' + m) || String(model).replace(/\./g, '-').endsWith(m)); return k ? t[k] : null; }
  function cost(usage, model, table) {
    const p = priceFor(model, table);
    if (!p) return null;
    return (usage.input * p.in + usage.output * p.out) / 1e6;
  }
  function errorMessage(provider, status, j, text) {
    const raw = (j && ((j.error && (j.error.message || j.error.type)) || j.message)) || text || '';
    const badKey = status === 401 || status === 403 || (status === 400 && /api key|api_key/i.test(String(raw)));
    const hint = badKey ? 'The key was rejected. Check it and try again.' : status === 404 ? 'Model or endpoint not found. Check the model name and base URL.' : status === 429 ? 'Rate limit or quota reached on your account. Wait a moment or check billing.' : status >= 500 ? 'The provider had a server error. Try again.' : '';
    return (hint ? hint + ' ' : '') + '(' + (PROVIDERS[provider] ? PROVIDERS[provider].label : provider) + ' ' + status + (raw ? ': ' + String(raw).slice(0, 200) : '') + ')';
  }
  /* Call the model. deps: { fetch, now, timeoutMs, signal }. Returns { text, usage, latencyMs, cost, model }. */
  async function call(cfg, msg, deps) {
    const d = deps || {};
    const f = d.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    const now = d.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    if (PROVIDERS[cfg.provider].needsKey && !cfg.key) throw new Error('Add your ' + PROVIDERS[cfg.provider].label + ' key in Settings first.');
    const req = buildRequest(cfg, msg);
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), d.timeoutMs || 60000);
    const t0 = now();
    let res;
    try {
      res = await f(req.url, Object.assign({}, req.init, ctl ? { signal: ctl.signal } : {}));
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('The request timed out.');
      const local = /localhost|127\.0\.0\.1|\[::1\]/.test(req.url);
      if (!local && /api\.openai\.com/.test(req.url)) throw new Error('Could not read a reply from api.openai.com. If you are online, check the key: OpenAI\u2019s \u201cinvalid key\u201d reply has no CORS header, so the browser reports it as a network error.');
      throw new Error(local ? 'Could not reach ' + req.url + '. Is the server running, and does it allow this site (CORS)? For Ollama set OLLAMA_ORIGINS to include this site; in LM Studio turn on CORS. Your browser may also ask to allow local network access.' : 'Network error reaching ' + new URL(req.url).host + ' (offline, blocked, or CORS).' + (cfg.provider === 'openai' ? ' OpenAI sends key errors without CORS headers, so a wrong or revoked key also looks like this. Check the key.' : ''));
    }
    if (timer) clearTimeout(timer);
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) { /* not JSON */ }
    if (!res.ok) throw Object.assign(new Error(errorMessage(cfg.provider, res.status, j, txt.slice(0, 200))), { status: res.status });
    if (!j) throw new Error('The provider sent a reply that was not JSON.');
    const out = parseResponse(cfg.provider, j);
    out.latencyMs = Math.round(now() - t0);
    out.model = out.model || req.model || cfg.model;
    out.cost = cost(out.usage, cfg.model || PROVIDERS[cfg.provider].defaultModel, d.prices);
    return out;
  }
  return { PROVIDERS, PRESETS, PRICES, withImages, buildRequest, parseResponse, call, cost, priceFor, errorMessage };
});
