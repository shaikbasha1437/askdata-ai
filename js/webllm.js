/* Optional in-browser model via WebLLM (WebGPU). Loaded from jsDelivr only when the user picks it and
   confirms the download. Experimental: small local models write weaker SQL than hosted models. */
(function (root) {
  'use strict';
  const VERSION = '0.2.88';
  const MODELS = [
    { id: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 Coder 1.5B (about 1 GB download)' },
    { id: 'Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 Coder 0.5B (about 0.4 GB, weaker)' },
    { id: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 Coder 3B (about 2 GB, better)' }
  ];
  let engine = null; let loadedId = null; let loading = null;
  function available() { return typeof navigator !== 'undefined' && !!navigator.gpu; }
  async function load(id, onProgress) {
    if (!available()) throw new Error('WebGPU is not available in this browser, so the in-browser model cannot run. Use Chrome or Edge on a recent desktop GPU, or pick another provider.');
    if (engine && loadedId === id) return engine;
    if (loading) return loading;
    loading = (async () => {
      const webllm = await import('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@' + VERSION + '/+esm');
      engine = await webllm.CreateMLCEngine(id, { initProgressCallback: (r) => onProgress && onProgress(r) });
      loadedId = id; return engine;
    })();
    try { return await loading; } finally { loading = null; }
  }
  async function call(id, msg, onProgress) {
    const e = await load(id, onProgress);
    const t0 = performance.now();
    const r = await e.chat.completions.create({ messages: [{ role: 'system', content: msg.system }].concat(msg.messages), temperature: 0, max_tokens: msg.maxTokens || 700, response_format: msg.json ? { type: 'json_object' } : undefined });
    const u = r.usage || {};
    return { text: (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '', usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0 }, cost: 0, latencyMs: Math.round(performance.now() - t0), model: id };
  }
  (root.AskData = root.AskData || {}).webllm = { VERSION, MODELS, available, load, call, isLoaded: (id) => !!engine && loadedId === id };
})(typeof self !== 'undefined' ? self : this);
