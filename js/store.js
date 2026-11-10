/* AskData storage: localStorage for settings / notebook / dashboard, IndexedDB for uploaded tables. */
(function (root) {
  'use strict';
  const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }, del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } } };
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => { if (typeof indexedDB === 'undefined') { rej(new Error('IndexedDB unavailable')); return; } const r = indexedDB.open('askdata', 1); r.onupgradeneeded = () => { r.result.createObjectStore('tables', { keyPath: 'name' }); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return dbp;
  }
  async function tx(mode, fn) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('tables', mode); const st = t.objectStore('tables'); const out = fn(st); t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted')); }); }
  const tables = {
    put: (t) => tx('readwrite', (st) => st.put({ name: t.name, columns: t.columns, rows: t.rows, notes: t.notes, source: t.source, file: t.file || null, savedAt: Date.now() })),
    del: (name) => tx('readwrite', (st) => st.delete(name)),
    all: () => tx('readonly', (st) => st.getAll()),
    clear: () => tx('readwrite', (st) => st.clear())
  };
  (root.AskData = root.AskData || {}).store = { ls, tables };
})(typeof self !== 'undefined' ? self : this);
