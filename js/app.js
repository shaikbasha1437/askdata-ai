/* AskData AI web app. Everything runs in the browser; the AI key (if any) stays in this browser only. */
(function () {
  'use strict';
  const A = window.AskData; const LLM = window.AgentKit.llm;
  const DATA = A.data; const GUARD = A.guard; const NL = A.nl; const CHART = A.chart; const AGENT = A.agent; const REPORT = A.report; const ENGINE = A.engine; const STORE = A.store; const WEBLLM = A.webllm;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ls = STORE.ls;
  const LS = { settings: 'askdata.settings', keys: 'askdata.keys', theme: 'askdata.theme', workspace: 'askdata.workspace', history: 'askdata.history', visited: 'askdata.visited' };
  const DEMO = [{ name: 'orders', file: 'orders.csv' }, { name: 'customers', file: 'customers.csv' }, { name: 'products', file: 'products.csv' }, { name: 'saas_metrics', file: 'saas_metrics.csv' }];
  const PROVIDERS = Object.keys(LLM.PROVIDERS).concat(['webllm']);
  const provLabel = (p) => (p === 'webllm' ? 'In-browser (WebLLM, experimental)' : LLM.PROVIDERS[p].label);

  let settings = Object.assign({ provider: 'openai', model: '', baseUrl: '', remember: true, answerWithAI: true, maxRepairs: 2, engine: 'auto', mode: 'demo', webllmModel: WEBLLM.MODELS[0].id }, ls.get(LS.settings, {}));
  let keys = Object.assign({ llm: '' }, settings.remember ? ls.get(LS.keys, {}) : {});
  let tables = []; // { name, columns, rows, notes, source, profile }
  let history = ls.get(LS.history, []);
  let current = null; // last asked item (with result)
  let engine = null; let engineReady = null; let busy = false;
  const dashCache = new Map();
  const ui = { tab: 'chart', lower: 'notebook' };

  /* ---------------- toast / status ---------------- */
  let toastTimer = null;
  function toast(msg, undo) {
    const t = $('#toast');
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (undo ? '<button type="button" id="toast-undo">Undo</button>' : '');
    t.classList.add('show');
    if (undo) $('#toast-undo').onclick = () => { t.classList.remove('show'); undo(); };
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), undo ? 8000 : 3800);
  }
  function status(msg, isError, spin) { const s = $('#status'); if (!msg) { s.hidden = true; return; } s.hidden = false; s.innerHTML = (spin ? '<span class="spinner"></span>' : '') + esc(msg); s.classList.toggle('error', !!isError); }

  /* ---------------- modals: X, Cancel, Esc, backdrop, Back; discard prompt for unsaved edits ---------------- */
  let modal = null; let lastFocus = null;
  function openModal(title, html, o) {
    const op = o || {};
    if (modal) removeModal();
    lastFocus = document.activeElement;
    history_push();
    $('#modal-host').innerHTML = '<div class="backdrop"><section class="modal ' + (op.wide ? 'wide' : '') + '" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><h2 id="modal-title">' + esc(title) + '</h2><button type="button" data-close="x" aria-label="Close">×</button></div><div class="modal-body">' + html + '</div><div class="modal-footer">' + (op.extraFooter || '') + '<button type="button" data-close="cancel">' + esc(op.cancelLabel || (op.save ? 'Cancel' : 'Close')) + '</button>' + (op.save ? '<button type="button" id="modal-save" class="primary">' + esc(op.saveLabel || 'Save') + '</button>' : '') + '</div></section></div>';
    modal = { dirty: false, watch: !!op.dirty };
    document.body.style.overflow = 'hidden';
    $('.backdrop').addEventListener('mousedown', (e) => { if (e.target.classList.contains('backdrop')) closeModal(); });
    $$('[data-close]').forEach((b) => (b.onclick = () => closeModal()));
    $('.modal-body').addEventListener('input', () => { if (modal && modal.watch) modal.dirty = true; });
    $('.modal-body').addEventListener('change', () => { if (modal && modal.watch) modal.dirty = true; });
    if (op.save) $('#modal-save').onclick = () => op.save();
    if (op.onmount) op.onmount();
    setTimeout(() => { if (!modal) return; const first = $('.modal-body input:not([type=checkbox]):not([type=hidden]):not([readonly]),.modal-body textarea,.modal-body select'); const el = op.focusFirst && first ? first : $('.modal [data-close=x]'); if (el) el.focus(); }, 0);
  }
  function history_push() { window.history.pushState({ askdataModal: true }, ''); }
  function removeModal() { modal = null; $('#modal-host').innerHTML = ''; document.body.style.overflow = ''; if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus(); }
  function closeModal(force) { if (!modal) return; if (!force && modal.dirty && !confirm('Discard unsaved changes?')) return; modal.dirty = false; window.history.back(); }
  addEventListener('popstate', () => { if (!modal) return; if (modal.dirty && !confirm('Discard unsaved changes?')) { window.history.pushState({ askdataModal: true }, ''); return; } removeModal(); });
  addEventListener('keydown', (e) => {
    if (!modal) return;
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
    if (e.key === 'Tab') { const els = $$('.modal button,.modal input,.modal select,.modal textarea,.modal a[href]').filter((x) => !x.disabled && x.offsetParent !== null); if (!els.length) return; const first = els[0]; const last = els[els.length - 1]; if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); } else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); } }
  });

  /* ---------------- engine ---------------- */
  function setEnginePill(text, cls) { const p = $('#engine-pill'); p.textContent = text; p.className = 'pill ' + (cls || ''); }
  async function startEngine() {
    setEnginePill('SQL engine: starting…');
    let eng = null; let fellBack = null;
    if (settings.engine !== 'sqlite') {
      try { setEnginePill('Loading DuckDB-WASM…'); eng = await ENGINE.startDuckdb({ timeoutMs: 60000 }); } catch (e) { fellBack = String((e && e.message) || e); console.warn('DuckDB failed, using SQLite', e); }
    }
    if (!eng) eng = await ENGINE.startSqlite('./vendor/sqljs/');
    engine = eng;
    for (const t of tables) { try { await engine.load(t); } catch (e) { toast('Could not load ' + t.name + ' into ' + engine.label + ': ' + e.message); } }
    setEnginePill('SQL engine: ' + engine.label, engine.name === 'duckdb' ? 'ok' : (fellBack ? 'warn' : ''));
    if (fellBack) toast('DuckDB could not start (' + fellBack.slice(0, 80) + '). Using SQLite instead.');
    renderSamples();
    return engine;
  }
  function ready() { return engineReady; }

  /* ---------------- tables ---------------- */
  function saveWorkspace() { ls.set(LS.workspace, tables.map((t) => ({ name: t.name, source: t.source }))); }
  function uniqueName(n) { let out = n; let k = 2; while (tables.some((t) => t.name === out)) out = n + '_' + k++; return out; }
  async function addTable(t, opt) {
    const o = opt || {};
    if (!o.keepName) t.name = uniqueName(t.name);
    t.profile = DATA.profile(t);
    tables.push(t);
    if (engine) await engine.load(t);
    if (t.source === 'upload' && o.persist !== false) { try { await STORE.tables.put(t); } catch (e) { toast('Loaded, but this browser would not save it for next time (' + e.message + ').'); } }
    saveWorkspace(); renderTables(); renderSamples();
    return t;
  }
  async function fetchDemo(d) { const r = await fetch('./samples/' + d.file); if (!r.ok) throw new Error('Could not load ' + d.file + ' (' + r.status + ')'); const t = DATA.fromDelimited(d.name, await r.text()); t.source = 'demo'; return t; }
  async function loadDemo(silent) {
    let added = 0;
    for (const d of DEMO) { if (tables.some((t) => t.name === d.name)) continue; try { await addTable(await fetchDemo(d), { keepName: true }); added++; } catch (e) { toast(e.message); } }
    if (!silent) toast(added ? 'Demo tables loaded (' + added + ').' : 'Demo tables are already loaded.');
  }
  async function restoreWorkspace() {
    const ws = ls.get(LS.workspace, null);
    if (!ws) { await loadDemo(true); return; }
    let saved = [];
    try { saved = await STORE.tables.all(); } catch (e) { saved = []; }
    for (const w of ws) {
      try {
        if (w.source === 'demo') { const d = DEMO.find((x) => x.name === w.name); if (d) await addTable(await fetchDemo(d), { keepName: true }); }
        else { const s = saved.find((x) => x.name === w.name); if (s) await addTable({ name: s.name, columns: s.columns, rows: s.rows, notes: s.notes || [], source: 'upload', file: s.file }, { keepName: true, persist: false }); }
      } catch (e) { toast('Could not restore ' + w.name + ': ' + e.message); }
    }
  }
  async function removeTable(name) {
    const i = tables.findIndex((t) => t.name === name); if (i < 0) return;
    const t = tables[i];
    tables.splice(i, 1);
    if (engine) await engine.drop(name);
    if (t.source === 'upload') { try { await STORE.tables.del(name); } catch (e) { /* ignore */ } }
    saveWorkspace(); renderTables(); renderSamples();
    toast('Removed table ' + name + '.', async () => { tables.splice(Math.min(i, tables.length), 0, t); if (engine) await engine.load(t); if (t.source === 'upload') { try { await STORE.tables.put(t); } catch (e) { /* ignore */ } } saveWorkspace(); renderTables(); renderSamples(); toast('Table ' + name + ' restored.'); });
  }
  async function renameTable(oldName, newName) {
    const t = tables.find((x) => x.name === oldName); if (!t) return;
    if (engine) await engine.drop(oldName);
    if (t.source === 'upload') { try { await STORE.tables.del(oldName); } catch (e) { /* ignore */ } }
    t.name = newName; t.profile = DATA.profile(t);
    if (engine) await engine.load(t);
    if (t.source === 'upload') { try { await STORE.tables.put(t); } catch (e) { /* ignore */ } }
    else t.source = 'upload';
    saveWorkspace(); renderTables(); renderSamples();
  }

  async function handleFiles(files) {
    const list = Array.from(files || []);
    for (const f of list) {
      if (f.size > 100 * 1024 * 1024) { toast(f.name + ' is larger than 100 MB; that is too big for an in-browser demo.'); continue; }
      const used = new Set(tables.map((t) => t.name));
      const name = DATA.tableNameFromFile(f.name, used);
      const ext = (/\.([a-z0-9]+)$/i.exec(f.name) || [])[1] || '';
      status('Reading ' + f.name + '…', false, true);
      try {
        let t;
        if (/^parquet$/i.test(ext)) {
          await ready();
          if (!engine.readParquet) throw new Error('Parquet needs the DuckDB engine, which is not running (switch the engine to Auto in Settings and reload while online).');
          const res = await engine.readParquet(new Uint8Array(await f.arrayBuffer()));
          t = DATA.fromObjects(name, res.rows.map((r) => Object.fromEntries(res.columns.map((c, i) => [c, r[i]]))), 'upload');
        } else {
          const text = await f.text();
          if (/^(json|ndjson|jsonl)$/i.test(ext) || /^\s*[[{]/.test(text.slice(0, 200))) t = DATA.fromJson(name, text);
          else t = DATA.fromDelimited(name, text, /^tsv$/i.test(ext) ? '\t' : undefined);
        }
        t.source = 'upload'; t.file = f.name;
        await ready();
        await addTable(t);
        status('');
        toast('Loaded ' + f.name + ' as table ' + t.name + ' (' + t.rows.length.toLocaleString('en-US') + ' rows, ' + t.columns.length + ' columns).');
        if (t.profile.injections.length) toast(t.profile.injections.length + ' cell(s) in ' + t.name + ' look like instructions to an AI. They are treated as data only.');
      } catch (e) { status('Could not load ' + f.name + ': ' + e.message, true); }
    }
  }

  /* ---------------- render: tables ---------------- */
  function renderTables() {
    const box = $('#tables');
    $('#data-count').textContent = tables.length ? tables.length + ' table' + (tables.length === 1 ? '' : 's') : '';
    if (!tables.length) { box.innerHTML = '<div class="empty">No tables yet. Add a file, paste data, or load the demo.</div>'; return; }
    const open = new Set($$('.tcard[open]').map((d) => d.dataset.table));
    box.innerHTML = tables.map((t) => {
      const p = t.profile; const warn = p.warnings.length;
      return '<details class="tcard" data-table="' + esc(t.name) + '"' + (open.has(t.name) ? ' open' : '') + '><summary><span class="tname">' + esc(t.name) + '</span>' + (t.source === 'demo' ? '<span class="pill">demo</span>' : '') + (p.injections.length ? '<span class="twarn" title="Instruction-like text found in cells">⚠ injection text</span>' : warn ? '<span class="twarn" title="' + esc(p.warnings.join(' ')) + '">' + warn + ' note' + (warn === 1 ? '' : 's') + '</span>' : '') + '<span class="tmeta">' + t.rows.length.toLocaleString('en-US') + ' rows · ' + t.columns.length + ' cols</span></summary>' +
        '<ul class="cols">' + t.columns.map((c, i) => { const pc = p.columns[i]; const sample = pc.top.slice(0, 3).map((x) => String(x.value).slice(0, 24)).join(', '); return '<li><span class="cn">' + esc(c.name) + '</span><span class="ty ' + c.type + '">' + c.type + '</span>' + (pc.nulls ? '<span class="muted small">' + pc.nulls + ' null</span>' : '') + '<span class="cs" title="' + esc(sample) + '">' + (pc.min != null && c.type !== 'TEXT' ? esc(CHART.fmt(pc.min) + ' … ' + CHART.fmt(pc.max)) : esc(pc.distinct + ' distinct' + (sample ? ': ' + sample : ''))) + '</span></li>'; }).join('') + '</ul>' +
        '<div class="tactions"><button type="button" class="small-btn" data-profile="' + esc(t.name) + '">Profile</button><button type="button" class="small-btn" data-rename="' + esc(t.name) + '">Rename</button><button type="button" class="small-btn" data-preview="' + esc(t.name) + '">Preview</button><button type="button" class="small-btn danger" data-remove="' + esc(t.name) + '">Remove</button></div></details>';
    }).join('');
    $$('[data-remove]', box).forEach((b) => (b.onclick = () => removeTable(b.dataset.remove)));
    $$('[data-profile]', box).forEach((b) => (b.onclick = () => openProfile(b.dataset.profile)));
    $$('[data-rename]', box).forEach((b) => (b.onclick = () => openRename(b.dataset.rename)));
    $$('[data-preview]', box).forEach((b) => (b.onclick = () => { $('#ask-q').value = 'Show ' + b.dataset.preview; runSql('SELECT * FROM ' + NL.sqlId(b.dataset.preview) + ' LIMIT 50', 'Preview of ' + b.dataset.preview); }));
  }
  function schema() { return DATA.schemaOf(tables); }
  function renderSamples() {
    const names = new Set(tables.map((t) => t.name));
    let qs = [];
    if (['orders', 'customers', 'products'].every((n) => names.has(n))) qs = NL.SAMPLES.filter((q) => !/MRR|plan/.test(q) || names.has('saas_metrics'));
    else if (tables.length) {
      const t = tables[tables.length - 1]; const num = t.columns.find((c) => (c.type === 'INTEGER' || c.type === 'DOUBLE') && !/_id$|^id$/.test(c.name)); const txt = t.profile.columns.find((c) => c.type === 'TEXT' && c.lowCard); const dt = t.columns.find((c) => c.type === 'DATE' || c.type === 'TIMESTAMP');
      qs.push('How many ' + t.name.replace(/_/g, ' ') + ' are there?');
      if (num) qs.push('Total ' + num.name.replace(/_/g, ' '));
      if (num && txt) qs.push('Average ' + num.name.replace(/_/g, ' ') + ' by ' + txt.name.replace(/_/g, ' '));
      if (num && dt) qs.push(num.name.replace(/_/g, ' ') + ' by month');
      if (txt) qs.push('Share of ' + t.name.replace(/_/g, ' ') + ' by ' + txt.name.replace(/_/g, ' '));
      qs.push('Show ' + t.name.replace(/_/g, ' '));
    }
    $('#samples').innerHTML = qs.map((q) => '<button type="button" class="chip" data-q="' + esc(q) + '">' + esc(q) + '</button>').join('');
    $$('#samples [data-q]').forEach((b) => (b.onclick = () => { $('#ask-q').value = b.dataset.q; ask(b.dataset.q); }));
  }

  /* ---------------- asking ---------------- */
  function setMode(m) { settings.mode = m; ls.set(LS.settings, settings); $('#mode-demo').setAttribute('aria-pressed', String(m === 'demo')); $('#mode-llm').setAttribute('aria-pressed', String(m === 'llm')); renderModePill(); }
  function renderModePill() {
    const p = $('#mode-pill');
    if (settings.mode === 'demo') { p.textContent = 'Demo rules · no key'; p.className = 'pill'; return; }
    const ok = settings.provider === 'webllm' || !LLM.PROVIDERS[settings.provider].needsKey || keys.llm;
    p.textContent = 'Your AI: ' + provLabel(settings.provider) + ' · ' + (settings.provider === 'webllm' ? settings.webllmModel.split('-Instruct')[0] : (settings.model || LLM.PROVIDERS[settings.provider].defaultModel)) + (ok ? '' : ' · no key yet');
    p.className = 'pill ' + (ok ? 'ok' : 'warn');
  }
  function llmCfg() { return { provider: settings.provider, model: settings.model || (LLM.PROVIDERS[settings.provider] || {}).defaultModel, baseUrl: settings.provider === 'compatible' ? settings.baseUrl : '', key: keys.llm }; }
  function llmFn() {
    if (settings.provider === 'webllm') return (msg) => WEBLLM.call(settings.webllmModel, msg, (r) => status('Loading in-browser model: ' + Math.round((r.progress || 0) * 100) + '% ' + (r.text || '').slice(0, 80), false, true));
    const cfg = llmCfg();
    return (msg) => LLM.call(cfg, msg, { timeoutMs: 90000 });
  }
  async function ask(question) {
    const q = String(question || '').trim();
    if (!q) { status('Type a question first.', true); $('#ask-q').focus(); return; }
    if (busy) return;
    if (!tables.length) { status('Load a dataset first: add a file or click “Demo data”.', true); return; }
    if (settings.mode === 'llm') {
      if (settings.provider === 'webllm' && !WEBLLM.isLoaded(settings.webllmModel)) {
        if (!WEBLLM.available()) { status('WebGPU is not available in this browser, so the in-browser model cannot run. Pick another provider in Settings or use Demo rules.', true); return; }
        if (!confirm('Download and run ' + settings.webllmModel + ' in your browser? This is a large one-time download (see Settings) and needs a WebGPU-capable GPU.')) return;
      } else if (settings.provider !== 'webllm' && LLM.PROVIDERS[settings.provider].needsKey && !keys.llm) { status('“Your AI” mode needs a key. Add your ' + provLabel(settings.provider) + ' key in Settings, or switch to Demo rules.', true); return; }
    }
    return run({ question: q });
  }
  function runSql(sql, label) { return run({ question: label || 'Custom SQL', sql, custom: true }); }
  async function run(req) {
    busy = true; $('#ask-btn').disabled = true;
    status(req.sql ? 'Checking and running SQL…' : settings.mode === 'llm' ? 'Asking ' + provLabel(settings.provider) + ' to write SQL…' : 'Translating with the demo rules…', false, true);
    try {
      await ready();
      const mode = req.sql ? 'sql' : settings.mode;
      const item = await AGENT.ask({ question: req.question, sql: req.sql, chartHint: req.chartHint, mode: mode === 'sql' ? 'demo' : mode, schema: schema(), dialect: engine.dialect, exec: (s) => engine.exec(s), llm: mode === 'llm' ? llmFn() : null, maxRepairs: Math.max(0, Math.min(3, +settings.maxRepairs || 0)), answerWithAI: settings.answerWithAI });
      item.id = 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      item.at = Date.now(); item.mode = mode; item.engine = engine.label; item.tables = item.result || item.sql ? tablesIn(item.sql) : [];
      if (mode === 'llm') item.model = settings.provider === 'webllm' ? settings.webllmModel : provLabel(settings.provider) + ' ' + llmCfg().model;
      current = item; ui.tab = item.result && item.chart && item.chart.type !== 'table' ? 'chart' : item.result ? 'table' : 'sql';
      if (!req.noHistory) addHistory(item);
      status('');
      renderResult();
      if (!req.quiet) $('#result').focus({ preventScroll: false });
      return item;
    } catch (e) {
      status((settings.mode === 'llm' && !req.sql ? 'The AI call failed: ' : 'Error: ') + e.message, true);
      return null;
    } finally { busy = false; $('#ask-btn').disabled = false; }
  }
  function tablesIn(sql) { if (!sql) return []; let toks; try { toks = GUARD.tokenize(sql).tokens; } catch (e) { return []; } const names = new Set(toks.filter((t) => t.t === 'word' || t.t === 'qident').map((t) => t.v.toLowerCase())); return tables.map((t) => t.name).filter((n) => names.has(n.toLowerCase())); }
  function addHistory(item) {
    history.unshift({ id: item.id, question: item.question, sql: item.sql || '', mode: item.mode, model: item.model || null, at: item.at, tables: item.tables, abstain: item.abstain || item.blocked || item.error || null, refused: !!item.refused, answer: item.answer || '', chart: item.chart ? { type: item.chart.type, x: item.chart.x, y: item.chart.y, series: item.chart.series } : null, rows: item.result ? item.result.rows.length : 0, pinned: false });
    if (history.length > 200) history.length = 200;
    saveHistory(); renderLower();
  }
  function saveHistory() { if (!ls.set(LS.history, history)) toast('Notebook is too large to save in this browser.'); }

  /* ---------------- render: result ---------------- */
  function isDark() { return document.documentElement.classList.contains('dark'); }
  function chartSvg(item, o) { if (!item.result || !item.chart) return ''; return CHART.render(item.chart, item.result.columns, item.result.rows, Object.assign({ dark: isDark(), title: item.question }, o || {})); }
  function kpiHtml(item) { const r = item.result.rows[0] || []; return '<div class="kpi">' + item.result.columns.map((c, i) => '<div><span>' + esc(c.replace(/_/g, ' ')) + '</span><b>' + esc(CHART.fmt(r[i], c)) + '</b></div>').join('') + '</div>'; }
  function gridHtml(item, max) {
    const { columns, rows } = item.result; const lim = Math.min(rows.length, max || 1000);
    const flags = new Set((item.flags || []).map((f) => f.row + ':' + f.column));
    return '<div class="grid-wrap"><table class="grid"><thead><tr>' + columns.map((c) => '<th scope="col">' + esc(c) + '</th>').join('') + '</tr></thead><tbody>' + rows.slice(0, lim).map((r, ri) => '<tr>' + r.map((v, ci) => '<td class="' + (v == null ? 'null' : typeof v === 'number' ? 'n' : '') + (flags.has(ri + 1 + ':' + columns[ci]) ? ' inj' : '') + '" title="' + esc(v == null ? 'NULL' : String(v).slice(0, 300)) + '">' + (v == null ? 'NULL' : esc(typeof v === 'number' ? CHART.fmt(v, columns[ci]) : String(v).slice(0, 120))) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>' + (rows.length > lim ? '<p class="muted small">Showing ' + lim + ' of ' + rows.length + ' rows. Export CSV for all.</p>' : '');
  }
  function renderResult() {
    const box = $('#result'); const it = current;
    if (!it) return;
    const modeTxt = it.mode === 'llm' ? 'AI: ' + (it.model || '') : it.mode === 'sql' ? 'your SQL' : 'demo rules';
    let h = '<div class="rhead"><h3>' + esc(it.question) + '</h3></div><div class="rmeta"><span>' + esc(modeTxt) + '</span><span>' + esc(it.engine || '') + '</span>' + (it.result ? '<span>' + it.result.rows.length.toLocaleString('en-US') + ' row' + (it.result.rows.length === 1 ? '' : 's') + '</span>' : '') + '<span>' + (it.ms != null ? it.ms + ' ms' : '') + '</span>' + (it.usage && it.usage.calls ? '<span>' + it.usage.calls + ' AI call' + (it.usage.calls === 1 ? '' : 's') + ' · ' + (it.usage.input + it.usage.output) + ' tokens' + (it.usage.cost ? ' · ~$' + it.usage.cost.toFixed(4) : '') + '</span>' : '') + '</div>';
    if (it.abstain || it.blocked || it.error) {
      const cls = it.refused ? 'refused' : 'abstain';
      h += '<div class="answer ' + cls + '" id="answer"><b>' + (it.refused ? 'Refused (read-only): ' : it.error ? 'Could not run: ' : 'Not answered: ') + '</b>' + esc(it.abstain || it.blocked || it.error) + '</div>';
    } else h += '<div class="answer" id="answer">' + esc(it.answer) + (it.answerSource === 'ai' ? ' <span class="pill" title="Written by the AI; every number in it was found in the result">AI-written · numbers checked</span>' : '') + '</div>';
    const notes = [];
    (it.assumptions || []).forEach((a) => notes.push('<li>' + esc(a) + '</li>'));
    (it.ambiguities || []).forEach((a) => notes.push('<li class="amb">' + esc(a) + '</li>'));
    (it.notes || []).forEach((a) => notes.push('<li class="' + (/instructions/.test(a) ? 'flag' : '') + '">' + esc(a) + '</li>'));
    (it.guardNotes || []).forEach((a) => notes.push('<li>Safety check: ' + esc(a) + '</li>'));
    if (notes.length) h += '<ul class="notes" id="notes">' + notes.join('') + '</ul>';
    const tabs = it.result ? ['chart', 'table', 'sql', 'explain'] : it.sql ? ['sql'] : [];
    if (tabs.length) {
      if (!tabs.includes(ui.tab)) ui.tab = tabs[0];
      h += '<div class="tabs" role="tablist">' + tabs.map((t) => '<button type="button" role="tab" data-tab="' + t + '" aria-selected="' + (ui.tab === t) + '">' + { chart: 'Chart', table: 'Table', sql: 'SQL', explain: 'Explain' }[t] + '</button>').join('') + '</div><div id="tabbody"></div>';
    }
    if (it.attempts && it.attempts.length > 1) h += '<details class="attempts"><summary>' + it.attempts.length + ' attempts (self-repair log)</summary>' + it.attempts.map((a, i) => '<p><b>Attempt ' + (i + 1) + ':</b> ' + (a.ok ? 'ran fine' : esc(a.error)) + '</p>' + (a.sql ? '<pre>' + esc(a.sql) + '</pre>' : '')).join('') + '</details>';
    if (it.result) h += '<div class="actions"><button type="button" id="act-pin">' + (isPinned(it.id) ? '★ Pinned' : '☆ Pin to dashboard') + '</button><button type="button" id="act-share">🔗 Share link</button><button type="button" id="act-png">PNG</button><button type="button" id="act-svg">SVG</button><button type="button" id="act-csv">CSV</button><button type="button" id="act-sql">.sql</button><button type="button" id="act-md">Markdown</button><button type="button" id="act-html">HTML report</button></div>';
    else if (!it.sql) h += '<div class="actions"><button type="button" id="act-try-sql">Write SQL yourself</button></div>';
    box.innerHTML = h;
    $$('[data-tab]', box).forEach((b) => (b.onclick = () => { ui.tab = b.dataset.tab; $$('[data-tab]', box).forEach((x) => x.setAttribute('aria-selected', String(x === b))); renderTab(); }));
    if (tabs.length) renderTab();
    const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
    on('act-pin', () => togglePin(it.id));
    on('act-share', () => openShare(it));
    on('act-png', () => exportPng(it));
    on('act-svg', () => exportSvg(it));
    on('act-csv', () => { download(REPORT.fileSafe(it.question) + '.csv', REPORT.csv(it), 'text/csv'); toast('CSV downloaded (' + it.result.rows.length + ' rows).'); });
    on('act-sql', () => { download(REPORT.fileSafe(it.question) + '.sql', REPORT.sqlFile(it), 'application/sql'); toast('SQL file downloaded.'); });
    on('act-md', () => { download(REPORT.fileSafe(it.question) + '.md', REPORT.markdown([it], reportMeta(it.question)), 'text/markdown'); toast('Markdown report downloaded.'); });
    on('act-html', () => { download(REPORT.fileSafe(it.question) + '.html', REPORT.html([it], reportMeta(it.question), (x) => chartSvg(x, { dark: false })), 'text/html'); toast('HTML report downloaded.'); });
    on('act-try-sql', () => { current = Object.assign({}, it, { sql: '-- Write a read-only SELECT over: ' + tables.map((t) => t.name).join(', ') + '\nSELECT * FROM ' + NL.sqlId(tables[0] ? tables[0].name : 'orders') + ' LIMIT 20' }); ui.tab = 'sql'; renderResult(); });
  }
  function renderTab() {
    const it = current; const body = $('#tabbody'); if (!body) return;
    if (ui.tab === 'chart') {
      const cols = it.result.columns; const c = it.chart;
      const opt = (v, sel) => '<option value="' + esc(v) + '"' + (v === sel ? ' selected' : '') + '>' + esc(v || '—') + '</option>';
      body.innerHTML = '<div class="chart-tools"><label>Chart <select id="ch-type">' + ['bar', 'line', 'pie', 'scatter', 'kpi', 'table'].map((t) => opt(t, c.type)).join('') + '</select></label><label>X <select id="ch-x">' + cols.map((x) => opt(x, c.x)).join('') + '</select></label><label>Y <select id="ch-y">' + cols.map((x) => opt(x, c.y)).join('') + '</select></label><label>Series <select id="ch-s">' + opt('', c.series || '') + cols.map((x) => opt(x, c.series)).join('') + '</select></label></div><div class="chart-box" id="chart-box"></div>';
      drawChart();
      ['ch-type', 'ch-x', 'ch-y', 'ch-s'].forEach((id) => ($('#' + id).onchange = () => { it.chart = Object.assign({}, it.chart, { type: $('#ch-type').value, x: $('#ch-x').value, y: $('#ch-y').value, series: $('#ch-s').value || null }); const h = history.find((x) => x.id === it.id); if (h) { h.chart = { type: it.chart.type, x: it.chart.x, y: it.chart.y, series: it.chart.series }; saveHistory(); dashCache.delete(it.id); renderLower(); } drawChart(); }));
    } else if (ui.tab === 'table') body.innerHTML = gridHtml(it);
    else if (ui.tab === 'sql') {
      body.innerHTML = '<label class="sr-only" for="sql-edit">SQL</label><textarea id="sql-edit" class="sql-edit" spellcheck="false" rows="' + Math.min(18, Math.max(6, String(it.sql || '').split('\n').length + 2)) + '">' + esc(it.sql || '') + '</textarea><div class="row"><button type="button" id="sql-run" class="primary">▶ Run SQL</button><button type="button" id="sql-check">Check only</button><button type="button" id="sql-copy">Copy</button><span id="sql-msg" class="small muted" role="status"></span></div><p class="muted small">Edits run through the same read-only check: one SELECT, loaded tables only, LIMIT ' + GUARD.MAX_LIMIT + ' max. Dialect: ' + (engine ? engine.dialect : '') + '.</p>';
      $('#sql-run').onclick = () => runSql($('#sql-edit').value, it.question);
      $('#sql-check').onclick = () => { const v = GUARD.validate($('#sql-edit').value, tables.map((t) => t.name)); $('#sql-msg').textContent = v.ok ? '✓ Read-only and allowed. ' + v.notes.join(' ') : '✗ ' + v.error; $('#sql-msg').style.color = v.ok ? 'var(--ok)' : 'var(--bad)'; };
      $('#sql-copy').onclick = () => copy($('#sql-edit').value, 'SQL');
      $('#sql-edit').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#sql-run').click(); } });
    } else if (ui.tab === 'explain') {
      body.innerHTML = '<ol class="explain">' + (it.explanation || []).map((x) => '<li><b>' + esc(x.clause) + '</b><code>' + esc(x.text) + '</code>' + esc(x.plain) + '</li>').join('') + '</ol>' + (it.ranSql && it.ranSql.trim() !== String(it.sql).trim() ? '<p class="muted small">What actually ran after the safety check:</p><pre class="out">' + esc(it.ranSql) + '</pre>' : '');
    }
  }
  function drawChart() {
    const it = current; const box = $('#chart-box'); if (!box) return;
    if (it.chart.type === 'kpi') box.innerHTML = kpiHtml(it);
    else if (it.chart.type === 'table') box.innerHTML = gridHtml(it, 200);
    else { const w = Math.max(320, Math.min(960, Math.round(box.clientWidth || 720))); const svg = chartSvg(it, { width: w, height: Math.max(260, Math.min(420, Math.round(w * 0.5))) }); box.innerHTML = svg || '<div class="empty">Pick an X and a numeric Y column to draw this chart.</div>'; }
  }

  /* ---------------- pin / notebook / dashboard ---------------- */
  function isPinned(id) { const h = history.find((x) => x.id === id); return !!(h && h.pinned); }
  function togglePin(id) {
    const h = history.find((x) => x.id === id); if (!h) return;
    h.pinned = !h.pinned; saveHistory();
    if (current && current.id === id) { const b = $('#act-pin'); if (b) b.textContent = h.pinned ? '★ Pinned' : '☆ Pin to dashboard'; }
    if (h.pinned && current && current.id === id && current.result) dashCache.set(id, current);
    renderLower();
    if (!h.pinned) toast('Removed from the dashboard.', () => { h.pinned = true; saveHistory(); renderLower(); if (current && current.id === id) renderResult(); });
    else toast('Pinned to the dashboard.');
  }
  function renderLower() {
    $('#nb-count').textContent = history.length; $('#db-count').textContent = history.filter((h) => h.pinned).length;
    $('#tab-notebook').setAttribute('aria-pressed', String(ui.lower === 'notebook')); $('#tab-notebook').setAttribute('aria-selected', String(ui.lower === 'notebook'));
    $('#tab-dashboard').setAttribute('aria-pressed', String(ui.lower === 'dashboard')); $('#tab-dashboard').setAttribute('aria-selected', String(ui.lower === 'dashboard'));
    const body = $('#lower-body'); const tools = $('#lower-tools');
    if (ui.lower === 'notebook') {
      tools.innerHTML = history.length ? '<button type="button" id="nb-export" class="small-btn">Export notebook (.md)</button><button type="button" id="nb-clear" class="small-btn danger">Clear notebook</button>' : '';
      body.innerHTML = history.length ? '<div class="nb">' + history.map((h) => '<div class="nb-item" data-id="' + h.id + '"><span class="q">' + esc(h.question) + '</span><span class="m">' + esc((h.mode === 'llm' ? 'AI' : h.mode === 'sql' ? 'SQL' : 'demo') + ' · ' + new Date(h.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + (h.abstain ? ' · not answered' : ' · ' + h.rows + ' rows')) + '</span><button type="button" class="small-btn" data-open="' + h.id + '">' + (h.sql ? 'Re-run' : 'Ask again') + '</button>' + (h.sql && !h.abstain ? '<button type="button" class="small-btn" data-pin="' + h.id + '">' + (h.pinned ? '★' : '☆') + '<span class="sr-only">' + (h.pinned ? 'Unpin' : 'Pin') + '</span></button>' : '') + '<button type="button" class="small-btn danger" data-del="' + h.id + '" aria-label="Delete from notebook">✕</button></div>').join('') + '</div>' : '<div class="empty">Questions you ask appear here. Re-run them later, pin them to the dashboard, or export the whole notebook.</div>';
      $$('[data-open]', body).forEach((b) => (b.onclick = () => openHistory(b.dataset.open)));
      $$('[data-pin]', body).forEach((b) => (b.onclick = () => togglePin(b.dataset.pin)));
      $$('[data-del]', body).forEach((b) => (b.onclick = () => { const i = history.findIndex((x) => x.id === b.dataset.del); if (i < 0) return; const [old] = history.splice(i, 1); saveHistory(); renderLower(); toast('Deleted from the notebook.', () => { history.splice(i, 0, old); saveHistory(); renderLower(); }); }));
      const ex = $('#nb-export'); if (ex) ex.onclick = exportNotebook;
      const cl = $('#nb-clear'); if (cl) cl.onclick = () => { const old = history.slice(); history = []; saveHistory(); renderLower(); toast('Notebook cleared (' + old.length + ' questions).', () => { history = old; saveHistory(); renderLower(); }); };
    } else {
      const pins = history.filter((h) => h.pinned);
      tools.innerHTML = pins.length ? '<button type="button" id="db-refresh" class="small-btn">↻ Refresh</button><button type="button" id="db-html" class="small-btn">Export HTML</button><button type="button" id="db-md" class="small-btn">Export .md</button>' : '';
      body.innerHTML = pins.length ? '<div class="dash">' + pins.map((h) => '<article class="dcard" data-id="' + h.id + '"><h4>' + esc(h.question) + '</h4><div class="dbody"><p class="muted small"><span class="spinner"></span>Running…</p></div><div class="dtools"><button type="button" class="small-btn" data-open="' + h.id + '">Open</button><button type="button" class="small-btn danger" data-unpin="' + h.id + '">Unpin</button></div></article>').join('') + '</div>' : '<div class="empty">Pin answers here with “☆ Pin to dashboard”. Pinned queries re-run on the current data each time.</div>';
      $$('[data-open]', body).forEach((b) => (b.onclick = () => openHistory(b.dataset.open)));
      $$('[data-unpin]', body).forEach((b) => (b.onclick = () => togglePin(b.dataset.unpin)));
      const rf = $('#db-refresh'); if (rf) rf.onclick = () => { dashCache.clear(); renderLower(); };
      const dh = $('#db-html'); if (dh) dh.onclick = async () => { const items = await dashItems(); download('askdata-dashboard.html', REPORT.html(items, reportMeta('AskData dashboard'), (x) => chartSvg(x, { dark: false })), 'text/html'); toast('Dashboard report downloaded.'); };
      const dm = $('#db-md'); if (dm) dm.onclick = async () => { const items = await dashItems(); download('askdata-dashboard.md', REPORT.markdown(items, reportMeta('AskData dashboard')), 'text/markdown'); toast('Dashboard Markdown downloaded.'); };
      fillDashboard(pins);
    }
  }
  async function runHistoryItem(h) {
    if (dashCache.has(h.id)) return dashCache.get(h.id);
    await ready();
    const it = await AGENT.ask({ question: h.question, sql: h.sql, chartHint: h.chart, mode: 'demo', schema: schema(), dialect: engine.dialect, exec: (s) => engine.exec(s) });
    it.id = h.id; it.mode = h.mode; it.model = h.model; it.engine = engine.label; it.at = h.at;
    if (h.chart && it.chart && it.result) it.chart = Object.assign({}, it.chart, h.chart);
    dashCache.set(h.id, it); return it;
  }
  async function fillDashboard(pins) {
    for (const h of pins) {
      const card = $('.dcard[data-id="' + h.id + '"] .dbody'); if (!card) continue;
      try {
        const it = await runHistoryItem(h);
        const el = $('.dcard[data-id="' + h.id + '"] .dbody'); if (!el) continue;
        if (!it.result) { el.innerHTML = '<p class="small" style="color:var(--bad)">' + esc(it.error || it.blocked || it.abstain || 'Could not run') + '</p>'; continue; }
        el.innerHTML = '<p class="small">' + esc(it.answer) + '</p>' + (it.chart.type === 'kpi' ? '<div class="chart-box">' + kpiHtml(it) + '</div>' : it.chart.type === 'table' ? gridHtml(it, 20) : '<div class="chart-box">' + chartSvg(it, { title: '', height: 300 }) + '</div>');
      } catch (e) { const el = $('.dcard[data-id="' + h.id + '"] .dbody'); if (el) el.innerHTML = '<p class="small" style="color:var(--bad)">' + esc(e.message) + '</p>'; }
    }
  }
  async function dashItems() { const out = []; for (const h of history.filter((x) => x.pinned)) out.push(await runHistoryItem(h)); return out; }
  async function exportNotebook() {
    const items = [];
    for (const h of history.slice().reverse()) { if (!h.sql || h.abstain) { items.push({ question: h.question, abstain: h.abstain || 'Not answered.' }); continue; } items.push(await runHistoryItem(h)); }
    download('askdata-notebook.md', REPORT.markdown(items, reportMeta('AskData notebook')), 'text/markdown'); toast('Notebook exported (' + items.length + ' questions).');
  }
  async function openHistory(id) {
    const h = history.find((x) => x.id === id); if (!h) return;
    $('#ask-q').value = h.question;
    if (!h.sql || h.abstain) { await ask(h.question); return; }
    busy = true; status('Re-running…', false, true);
    try { dashCache.delete(id); const it = await runHistoryItem(h); current = it; ui.tab = it.result && it.chart.type !== 'table' ? 'chart' : 'table'; status(''); renderResult(); $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { status(e.message, true); } finally { busy = false; }
  }
  function reportMeta(title) { return { title, at: Date.now(), engine: engine ? engine.label : '', tables: tables.map((t) => t.name) }; }

  /* ---------------- exports ---------------- */
  function download(name, content, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: (type || 'text/plain') + ';charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function exportSvg(it) { if (!it.chart || ['kpi', 'table'].includes(it.chart.type)) { toast('Switch to a bar, line, pie or scatter chart to export an image.'); return; } download(REPORT.fileSafe(it.question) + '.svg', chartSvg(it), 'image/svg+xml'); toast('SVG downloaded.'); }
  function exportPng(it) {
    if (!it.chart || ['kpi', 'table'].includes(it.chart.type)) { toast('Switch to a bar, line, pie or scatter chart to export an image.'); return; }
    const svg = chartSvg(it); const img = new Image(); const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    img.onload = () => { const c = document.createElement('canvas'); c.width = 1440; c.height = 720; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 1440, 720); URL.revokeObjectURL(url); c.toBlob((b) => { if (!b) { toast('PNG export failed in this browser; use SVG.'); return; } download(REPORT.fileSafe(it.question) + '.png', b); toast('PNG downloaded.'); }, 'image/png'); };
    img.onerror = () => { URL.revokeObjectURL(url); toast('PNG export failed in this browser; use SVG.'); };
    img.src = url;
  }
  async function copy(text, label) { try { await navigator.clipboard.writeText(text); toast((label || 'Text') + ' copied.'); } catch (e) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (er) { ok = false; } ta.remove(); toast(ok ? (label || 'Text') + ' copied.' : 'Copy was blocked. Select the text and copy it manually.'); } }

  /* ---------------- share links ---------------- */
  function openShare(it) {
    const link = REPORT.shareLink(location.href, { question: it.question, sql: it.sql, tables: it.tables, chartType: it.chart && it.chart.type });
    openModal('Share this question', '<p class="small">The link holds only the question, the SQL and the table names. It has <b>no data rows and no key</b>. The person opening it needs the same tables loaded (the demo tables work for everyone).</p><div class="field"><label for="share-link">Link</label><input id="share-link" readonly value="' + esc(link) + '"></div><p class="muted small">' + link.length + ' characters.</p>', { extraFooter: '<button type="button" id="share-copy" class="primary">Copy link</button>', onmount: () => { $('#share-copy').onclick = () => copy(link, 'Link'); $('#share-link').onfocus = (e) => e.target.select(); } });
  }
  function handleShareHash() {
    const s = REPORT.parseShare(location.hash);
    if (!s) return;
    window.history.replaceState(null, '', location.pathname + location.search);
    const missing = s.tables.filter((n) => !tables.some((t) => t.name === n));
    const b = $('#share-banner'); b.hidden = false;
    b.innerHTML = '<span class="grow"><b>Shared query:</b> “' + esc(s.question || 'Untitled') + '”' + (missing.length ? ' <span class="pill warn">needs: ' + esc(missing.join(', ')) + '</span>' : '') + '<br><span class="small muted">The SQL will pass the same read-only check before it runs.</span></span><button type="button" id="share-run" class="primary">Review &amp; run</button><button type="button" id="share-dismiss">Dismiss</button>';
    $('#share-run').onclick = async () => { b.hidden = true; $('#ask-q').value = s.question; const it = await run({ question: s.question || 'Shared query', sql: s.sql, chartHint: s.chartType ? { type: s.chartType } : null }); if (it) { ui.tab = 'sql'; renderResult(); ui.tab = 'chart'; } };
    $('#share-dismiss').onclick = () => { b.hidden = true; };
  }

  /* ---------------- modals: paste, rename, profile, settings, about ---------------- */
  function openPaste() {
    openModal('Paste data', '<div class="field"><label for="paste-name">Table name</label><input id="paste-name" value="' + esc(DATA.cleanName('pasted', new Set(tables.map((t) => t.name)))) + '" autocomplete="off"></div><div class="field"><label for="paste-text">CSV, TSV (e.g. copied from a spreadsheet) or JSON</label><textarea id="paste-text" rows="10" spellcheck="false" placeholder="name,amount&#10;Avery,12.5&#10;Jordan,8"></textarea><div class="err" id="paste-err" role="alert"></div></div>', {
      dirty: true, focusFirst: false, saveLabel: 'Load table', save: async () => {
        const txt = $('#paste-text').value; const nm = $('#paste-name').value.trim();
        if (!nm) { $('#paste-err').textContent = 'Give the table a name, or press Cancel.'; return; }
        if (!txt.trim()) { $('#paste-err').textContent = 'Paste some data first, or press Cancel.'; return; }
        let t;
        try { const name = DATA.cleanName(nm, new Set(tables.map((x) => x.name))); t = /^\s*[[{]/.test(txt) ? DATA.fromJson(name, txt) : DATA.fromDelimited(name, txt); } catch (e) { $('#paste-err').textContent = e.message; return; }
        t.source = 'upload'; t.file = 'pasted';
        modal.dirty = false; closeModal(true);
        await ready(); await addTable(t); toast('Loaded table ' + t.name + ' (' + t.rows.length + ' rows).');
      }, onmount: () => setTimeout(() => $('#paste-text') && $('#paste-text').focus(), 0)
    });
  }
  function openRename(name) {
    openModal('Rename table ' + name, '<div class="field"><label for="rn-name">New name</label><input id="rn-name" value="' + esc(name) + '" autocomplete="off" spellcheck="false"><div class="help">Letters, digits and underscores. Saved questions that use the old name will need editing.</div><div class="err" id="rn-err" role="alert"></div></div>', {
      dirty: true, focusFirst: true, saveLabel: 'Rename', save: async () => {
        const raw = $('#rn-name').value.trim();
        if (!raw) { $('#rn-err').textContent = 'A name is required, or press Cancel.'; return; }
        const nn = DATA.cleanName(raw, null, 'table');
        if (nn !== name && tables.some((t) => t.name === nn)) { $('#rn-err').textContent = 'A table called ' + nn + ' already exists.'; return; }
        modal.dirty = false; closeModal(true);
        if (nn === name) return;
        await renameTable(name, nn);
        toast('Renamed ' + name + ' to ' + nn + '.', () => renameTable(nn, name));
      }
    });
  }
  function openProfile(name) {
    const t = tables.find((x) => x.name === name); if (!t) return; const p = t.profile;
    const inj = p.injections.length ? '<div class="inj-list"><b>⚠ ' + p.injections.length + ' cell(s) look like instructions to an AI.</b> They stay in the data, are never followed, and are withheld from AI prompts.<ul>' + p.injections.slice(0, 8).map((h) => '<li>Row ' + h.row + ', ' + esc(h.column) + ': “' + esc(h.value.slice(0, 140)) + '”</li>').join('') + '</ul></div>' : '';
    openModal('Profile: ' + name, '<p class="small muted">' + t.rows.length.toLocaleString('en-US') + ' rows · ' + t.columns.length + ' columns · ' + (t.source === 'demo' ? 'fictional demo data' : 'loaded from ' + esc(t.file || 'your file')) + '</p>' + inj + (p.warnings.length || (t.notes || []).length ? '<h3 style="font-size:14px;margin:8px 0 4px">Data quality</h3><ul class="warnlist">' + (t.notes || []).concat(p.warnings).map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul>' : '<p class="small">No data-quality warnings.</p>') +
      '<div class="grid-wrap" style="max-height:none"><table class="prof-table"><thead><tr><th>Column</th><th>Type</th><th>Nulls</th><th>Distinct</th><th>Range / mean</th><th>Most common</th></tr></thead><tbody>' + p.columns.map((c) => '<tr><td class="mono">' + esc(c.name) + '</td><td><span class="ty ' + c.type + '">' + c.type + '</span></td><td>' + c.nulls + (c.nulls ? ' (' + Math.round(c.nullPct * 100) + '%)' : '') + '</td><td>' + c.distinct + '</td><td>' + (c.min != null ? esc(CHART.fmt(c.min) + ' … ' + CHART.fmt(c.max)) + (c.mean != null ? '<br><span class="muted">mean ' + esc(CHART.fmt(Math.round(c.mean * 100) / 100)) + '</span>' : '') : '') + '</td><td class="small">' + c.top.slice(0, 3).map((x) => esc(String(x.value).slice(0, 30)) + ' <span class="muted">×' + x.count + '</span>').join('<br>') + '</td></tr>').join('') + '</tbody></table></div>', { wide: true });
  }
  function openSettings() {
    const opts = PROVIDERS.map((p) => '<option value="' + p + '"' + (p === settings.provider ? ' selected' : '') + '>' + esc(provLabel(p)) + '</option>').join('');
    openModal('Settings', '<div class="note-box">Your key is stored only in this browser (localStorage, or memory only if you untick “Remember”). It is sent only to the provider you pick and never goes into exports, reports or share links. In “Your AI” mode the provider receives the table schema, a few sample values and, if allowed below, up to 30 result rows. Cells that look like prompt injection are withheld.</div>' +
      '<div class="row2"><div class="field"><label for="s-provider">AI provider</label><select id="s-provider">' + opts + '</select></div><div class="field" id="s-model-wrap"><label for="s-model">Model</label><input id="s-model" list="s-models" value="' + esc(settings.model) + '" autocomplete="off"><datalist id="s-models"></datalist></div></div>' +
      '<div class="presets" id="s-presets"></div>' +
      '<div class="field" id="s-base-wrap"><label for="s-base">Base URL</label><input id="s-base" type="url" value="' + esc(settings.baseUrl) + '" placeholder="http://localhost:11434/v1"><div class="help">For Ollama, start it with <code>OLLAMA_ORIGINS=https://shaikbasha1437.github.io</code>. Your browser may ask to allow local network access.</div></div>' +
      '<div class="field" id="s-key-wrap"><label for="s-key">API key</label><input id="s-key" type="password" autocomplete="off" spellcheck="false" value="' + esc(keys.llm) + '"><div class="help" id="s-key-help"></div></div>' +
      '<div class="field" id="s-webllm-wrap"><label for="s-webllm">In-browser model</label><select id="s-webllm">' + WEBLLM.MODELS.map((m) => '<option value="' + m.id + '"' + (m.id === settings.webllmModel ? ' selected' : '') + '>' + esc(m.label) + '</option>').join('') + '</select><div class="help">Runs on your GPU with WebGPU. Nothing leaves the browser. The download is large and happens once, after you confirm. Small models write weaker SQL. Experimental.</div></div>' +
      '<div class="field"><span class="lbl">Answers</span><label class="check"><input id="s-answer" type="checkbox"' + (settings.answerWithAI ? ' checked' : '') + '> Let the AI write the answer from the result (sends up to 30 result rows). Numbers it writes are checked against the result.</label></div>' +
      '<div class="row2"><div class="field"><label for="s-repairs">Self-repair attempts after a SQL error</label><select id="s-repairs">' + [0, 1, 2, 3].map((n) => '<option' + (n === +settings.maxRepairs ? ' selected' : '') + '>' + n + '</option>').join('') + '</select></div><div class="field"><label for="s-engine">SQL engine</label><select id="s-engine"><option value="auto"' + (settings.engine !== 'sqlite' ? ' selected' : '') + '>DuckDB-WASM (falls back to SQLite)</option><option value="sqlite"' + (settings.engine === 'sqlite' ? ' selected' : '') + '>SQLite (sql.js) only</option></select><div class="help">Engine changes apply after a reload.</div></div></div>' +
      '<div class="field"><label class="check"><input id="s-remember" type="checkbox"' + (settings.remember ? ' checked' : '') + '> Remember the key on this device</label></div>' +
      '<div class="row"><button type="button" id="s-test">Test connection</button><button type="button" id="s-forget" class="danger">Forget key</button></div><p id="s-test-out" class="small" role="status"></p>', {
      dirty: true, save: () => {
        const prevEngine = settings.engine;
        settings.provider = $('#s-provider').value; settings.model = $('#s-model').value.trim(); settings.baseUrl = $('#s-base').value.trim(); settings.answerWithAI = $('#s-answer').checked; settings.maxRepairs = +$('#s-repairs').value; settings.engine = $('#s-engine').value; settings.remember = $('#s-remember').checked; settings.webllmModel = $('#s-webllm').value;
        keys.llm = $('#s-key').value.trim();
        saveSettings(); modal.dirty = false; closeModal(true);
        renderModePill();
        toast(prevEngine !== settings.engine ? 'Settings saved. Reload the page to switch the SQL engine.' : 'Settings saved.');
      }, onmount: () => {
        const sync = () => {
          const p = $('#s-provider').value; const isWeb = p === 'webllm'; const P = LLM.PROVIDERS[p];
          $('#s-model-wrap').hidden = isWeb; $('#s-key-wrap').hidden = isWeb; $('#s-webllm-wrap').hidden = !isWeb; $('#s-base-wrap').hidden = p !== 'compatible';
          if (!isWeb) { $('#s-model').placeholder = P.defaultModel; $('#s-models').innerHTML = P.models.map((m) => '<option value="' + esc(m) + '">').join(''); $('#s-key').placeholder = P.keyHint; $('#s-key-help').innerHTML = P.keyUrl ? 'Get a key: <a href="' + P.keyUrl + '" target="_blank" rel="noopener">' + esc(new URL(P.keyUrl).host) + '</a>' + (P.pricingUrl ? ' · <a href="' + P.pricingUrl + '" target="_blank" rel="noopener">pricing</a>' : '') + (p === 'openai' ? '. Note: OpenAI may answer a bad key without CORS headers, so it can show up as a network error.' : '') : 'Optional for local servers; needed for hosted ones such as OpenRouter.'; }
          $('#s-presets').innerHTML = p === 'compatible' ? LLM.PRESETS.map((x) => '<button type="button" data-preset="' + x.id + '">' + esc(x.label) + '</button>').join('') : '';
          $$('[data-preset]').forEach((b) => (b.onclick = () => { const x = LLM.PRESETS.find((y) => y.id === b.dataset.preset); $('#s-base').value = x.baseUrl; $('#s-model').value = x.model; modal.dirty = true; }));
        };
        $('#s-provider').addEventListener('change', sync); sync();
        $('#s-test').onclick = async () => {
          const out = $('#s-test-out'); const p = $('#s-provider').value;
          out.style.color = ''; out.textContent = 'Testing…';
          try {
            let r;
            if (p === 'webllm') { if (!WEBLLM.available()) throw new Error('WebGPU is not available in this browser.'); if (!confirm('This downloads the in-browser model (large, one time). Continue?')) { out.textContent = ''; return; } r = await WEBLLM.call($('#s-webllm').value, { system: 'Reply with JSON only.', messages: [{ role: 'user', content: 'Return {"ok": true}' }], maxTokens: 20, json: true }, (x) => { out.textContent = 'Loading model: ' + Math.round((x.progress || 0) * 100) + '%'; }); }
            else r = await LLM.call({ provider: p, model: $('#s-model').value.trim() || LLM.PROVIDERS[p].defaultModel, baseUrl: p === 'compatible' ? $('#s-base').value.trim() : '', key: $('#s-key').value.trim() }, { system: 'Reply with JSON only.', messages: [{ role: 'user', content: 'Return {"ok": true}' }], maxTokens: 30, json: true }, { timeoutMs: 30000 });
            out.style.color = 'var(--ok)'; out.textContent = '✓ Connected (' + (r.latencyMs || 0) + ' ms, model ' + (r.model || '') + '). Reply: ' + String(r.text).slice(0, 80);
          } catch (e) { out.style.color = 'var(--bad)'; out.textContent = '✗ ' + e.message; }
        };
        $('#s-forget').onclick = () => { const old = keys.llm; keys.llm = ''; ls.del(LS.keys); $('#s-key').value = ''; renderModePill(); toast('Key forgotten on this device.', () => { keys.llm = old; saveSettings(); renderModePill(); }); };
      }
    });
  }
  function saveSettings() { ls.set(LS.settings, settings); if (settings.remember && keys.llm) ls.set(LS.keys, keys); else ls.del(LS.keys); }
  function openAbout() {
    openModal('How it works and what it cannot do', '<div class="about">' +
      '<h3>The loop</h3><ol><li>You ask a question in plain English.</li><li><b>Demo rules</b> (no key) or <b>your AI model</b> writes one SQL query, using the table schema and a few sample values.</li><li>A read-only check runs before anything executes. It allows a single SELECT on loaded tables only. It blocks INSERT/UPDATE/DELETE/DROP/ATTACH/COPY/PRAGMA/SET, file and URL readers, table functions, schema-qualified names and extra statements, and it adds or lowers LIMIT to ' + GUARD.MAX_LIMIT + '.</li><li>The query runs in your browser (DuckDB-WASM, or SQLite via sql.js as the fallback).</li><li>You get the table, an automatically chosen chart (switchable) and a plain-English answer. Every clause of the SQL is explained.</li><li>In AI mode, if the SQL fails, the error goes back to the model for a bounded number of repairs (Settings).</li></ol>' +
      '<h3>Demo rules: honest limits</h3><ul><li>A deterministic pattern matcher, not AI. It handles totals, averages, counts, min/max, top/bottom N, “which X has the most Y”, trends by day/week/month/quarter/year, shares, A-vs-B comparisons, filters on category values, numbers and dates (“in 2026”, “March 2026”, “last 3 months”), missing values, duplicates, and one join over a shared <code>*_id</code> column.</li><li>It does not handle nested logic, ratios between two measures, medians or percentiles, multi-hop joins, or synonyms it has not been taught. When it cannot map a question it abstains instead of guessing, and it lists the assumptions it made.</li><li>Relative dates (“last 3 months”) count back from the latest date <i>in the data</i>, not from today.</li></ul>' +
      '<h3>Your AI mode</h3><ul><li>Works with OpenAI, Anthropic (direct browser access header), Google Gemini, OpenAI-compatible APIs (OpenRouter, Ollama, LM Studio) or an experimental in-browser WebLLM model. You pay your provider. Costs shown are estimates.</li><li>The model sees the schema, value lists for low-cardinality columns, a few samples and, optionally, up to 30 result rows. It never sees your key or the full data.</li><li>AI-written answers are accepted only if every number in them appears in the result. Otherwise the computed summary is shown.</li></ul>' +
      '<h3>Prompt injection in data</h3><ul><li>Cells that read like instructions to an AI (for example “ignore previous instructions…”) are flagged on load and highlighted in results. They are withheld from AI prompts and are never followed. Detection uses patterns, so it can miss cleverly worded text. The read-only SQL check is the hard safety net.</li></ul>' +
      '<h3>What is simulated or untested</h3><ul><li>The demo shop and SaaS tables are fictional and generated with a fixed seed. They include deliberate mess: mixed date formats, NULLs, duplicate rows, stray spaces and two injection strings.</li><li>Live-AI output quality was not tested with real keys; only request formats and error handling were tested (with mocks and bogus keys). WebLLM was not run in testing (it needs a WebGPU GPU).</li><li>Data stays in your browser. Uploaded tables are kept in IndexedDB on this device until you remove them.</li><li>DuckDB runs single-threaded, and very large files (above about 200,000 rows) are truncated.</li></ul></div>', { wide: true });
  }

  /* ---------------- boot ---------------- */
  function bind() {
    $('#ask-form').addEventListener('submit', (e) => { e.preventDefault(); ask($('#ask-q').value); });
    $('#ask-q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask($('#ask-q').value); } });
    $('#mode-demo').onclick = () => setMode('demo');
    $('#mode-llm').onclick = () => { setMode('llm'); if (settings.provider !== 'webllm' && LLM.PROVIDERS[settings.provider].needsKey && !keys.llm) toast('Add your key in Settings to use your own AI model.'); };
    $('#btn-settings').onclick = openSettings; $('#btn-about').onclick = openAbout; $('#btn-paste').onclick = openPaste;
    $('#btn-demo').onclick = async () => { await ready(); loadDemo(false); };
    $('#btn-theme').onclick = () => { const d = !isDark(); document.documentElement.classList.toggle('dark', d); ls.set(LS.theme, d ? 'dark' : 'light'); if (current && current.result) renderResult(); dashCache.size && renderLower(); };
    $('#file-input').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
    $('#tab-notebook').onclick = () => { ui.lower = 'notebook'; renderLower(); };
    $('#tab-dashboard').onclick = () => { ui.lower = 'dashboard'; renderLower(); };
    let dragDepth = 0;
    addEventListener('dragenter', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
    addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
    addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); });
    addEventListener('drop', (e) => { if (!e.dataTransfer || !e.dataTransfer.files.length) return; e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); handleFiles(e.dataTransfer.files); });
    const net = () => { $('#offline-pill').hidden = navigator.onLine; };
    addEventListener('online', net); addEventListener('offline', net); net();
  }
  async function boot() {
    bind(); setMode(settings.mode); renderLower();
    engineReady = startEngine();
    await engineReady.catch((e) => { setEnginePill('SQL engine failed: ' + e.message, 'bad'); });
    await restoreWorkspace();
    renderTables(); renderSamples();
    ls.set(LS.visited, (ls.get(LS.visited, 0) || 0) + 1);
    handleShareHash();
    document.body.dataset.ready = '1';
  }
  window.AskDataApp = { ask, runSql, ready: () => engineReady, get tables() { return tables; }, get current() { return current; }, get engine() { return engine; }, get history() { return history; }, settings: () => settings, loadDemo };
  boot();
})();
