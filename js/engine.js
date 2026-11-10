/* AskData SQL engines. DuckDB-WASM (preferred, loaded from jsDelivr + vendored workers, cached by the
   service worker) and sql.js / SQLite (vendored, offline fallback, also used by the Node tests).
   Both expose the same interface: { name, label, dialect, load(table), drop(name), exec(sql) }. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.AskData = root.AskData || {}).engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DUCKDB_VERSION = '1.33.1-dev57.0';
  const DUCKDB_CDN = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@' + DUCKDB_VERSION;
  const qi = (n) => '"' + String(n).replace(/"/g, '""') + '"';
  const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : "'" + String(v).replace(/'/g, "''") + "'");
  function sqlType(dialect, t) {
    if (dialect === 'sqlite') return t === 'INTEGER' ? 'INTEGER' : t === 'DOUBLE' ? 'REAL' : 'TEXT';
    return { INTEGER: 'BIGINT', DOUBLE: 'DOUBLE', DATE: 'DATE', TIMESTAMP: 'TIMESTAMP', TEXT: 'VARCHAR' }[t] || 'VARCHAR';
  }
  function createSql(dialect, table) { return 'CREATE TABLE ' + qi(table.name) + ' (' + table.columns.map((c) => qi(c.name) + ' ' + sqlType(dialect, c.type)).join(', ') + ')'; }
  function withTimeout(p, ms, label) { if (!ms) return p; let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error((label || 'Query') + ' took longer than ' + Math.round(ms / 1000) + ' s and was stopped waiting.')), ms); })]).finally(() => clearTimeout(t)); }

  /* ---------- SQLite via sql.js ---------- */
  function createSqlite(SQL) {
    const db = new SQL.Database();
    try { db.run('PRAGMA trusted_schema = OFF'); } catch (e) { /* older builds */ }
    return {
      name: 'sqlite', label: 'SQLite (sql.js)', dialect: 'sqlite',
      async load(table) {
        db.run('DROP TABLE IF EXISTS ' + qi(table.name));
        db.run(createSql('sqlite', table));
        const st = db.prepare('INSERT INTO ' + qi(table.name) + ' VALUES (' + table.columns.map(() => '?').join(',') + ')');
        db.run('BEGIN');
        try { for (const r of table.rows) st.run(r.map((v) => (v === undefined ? null : v))); db.run('COMMIT'); } catch (e) { db.run('ROLLBACK'); throw e; } finally { st.free(); }
      },
      async drop(name) { db.run('DROP TABLE IF EXISTS ' + qi(name)); },
      async exec(sql) {
        const st = db.prepare(sql);
        try { const columns = st.getColumnNames(); const rows = []; while (st.step()) rows.push(st.get().map((v) => (v instanceof Uint8Array ? '[blob ' + v.length + ' bytes]' : v))); return { columns, rows }; } finally { st.free(); }
      },
      close() { db.close(); }
    };
  }
  async function startSqlite(base) {
    if (typeof initSqlJs === 'undefined') throw new Error('sql.js did not load.');
    const SQL = await initSqlJs({ locateFile: (f) => (base || './vendor/sqljs/') + f }); // eslint-disable-line no-undef
    return createSqlite(SQL);
  }

  /* ---------- DuckDB-WASM ---------- */
  function convertArrow(table) {
    const fields = table.schema.fields;
    const columns = fields.map((f) => f.name);
    const vecs = fields.map((f, i) => table.getChildAt(i));
    const kinds = fields.map((f) => { const s = String(f.type); return /^Date/.test(s) ? 'date' : /^Timestamp/.test(s) ? 'ts' : /^(Int|Uint|Float|Decimal)/.test(s) ? 'num' : /^Bool/.test(s) ? 'bool' : 'other'; });
    const rows = [];
    for (let r = 0; r < table.numRows; r++) {
      rows.push(vecs.map((v, i) => {
        let x = v ? v.get(r) : null;
        if (x == null) return null;
        if (typeof x === 'bigint') x = Number(x);
        if (kinds[i] === 'date') { const d = x instanceof Date ? x : new Date(Number(x)); return isNaN(d) ? String(x) : d.toISOString().slice(0, 10); }
        if (kinds[i] === 'ts') { const d = x instanceof Date ? x : new Date(Number(x)); return isNaN(d) ? String(x) : d.toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, ''); }
        if (kinds[i] === 'num') { if (typeof x === 'number') return x; if (x && typeof x.valueOf === 'function') { const n = Number(x.valueOf()); if (Number.isFinite(n)) return n; } if (ArrayBuffer.isView(x)) { let n = 0; for (let k = x.length - 1; k >= 0; k--) n = n * 4294967296 + x[k]; return n; } return Number(x); }
        if (kinds[i] === 'bool') return x ? 'true' : 'false';
        if (typeof x === 'object') { try { return JSON.stringify(x.toJSON ? x.toJSON() : x, (k, val) => (typeof val === 'bigint' ? Number(val) : val)); } catch (e) { return String(x); } }
        return x;
      }));
    }
    return { columns, rows };
  }
  async function startDuckdb(opts) {
    const o = opts || {};
    const duckdb = o.module || (await import(DUCKDB_CDN + '/+esm'));
    const workerBase = o.workerBase || './vendor/duckdb/';
    const bundles = { mvp: { mainModule: DUCKDB_CDN + '/dist/duckdb-mvp.wasm', mainWorker: workerBase + 'duckdb-browser-mvp.worker.js' }, eh: { mainModule: DUCKDB_CDN + '/dist/duckdb-eh.wasm', mainWorker: workerBase + 'duckdb-browser-eh.worker.js' } };
    const bundle = await duckdb.selectBundle(bundles);
    const worker = new Worker(bundle.mainWorker);
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await withTimeout(db.instantiate(bundle.mainModule, bundle.pthreadWorker, o.onProgress), o.timeoutMs || 90000, 'Loading DuckDB');
    await db.open({ query: { castBigIntToDouble: true, castDecimalToDouble: true } });
    const conn = await db.connect();
    const version = await db.getVersion().catch(() => '');
    async function q(sql) { return conn.query(sql); }
    return {
      name: 'duckdb', label: 'DuckDB-WASM ' + (version || DUCKDB_VERSION), dialect: 'duckdb', version,
      async load(table) {
        await q('DROP TABLE IF EXISTS ' + qi(table.name));
        await q(createSql('duckdb', table));
        const B = 500;
        for (let i = 0; i < table.rows.length; i += B) {
          const chunk = table.rows.slice(i, i + B);
          await q('INSERT INTO ' + qi(table.name) + ' VALUES ' + chunk.map((r) => '(' + r.map(lit).join(',') + ')').join(','));
        }
      },
      async drop(name) { await q('DROP TABLE IF EXISTS ' + qi(name)); },
      async exec(sql) { return convertArrow(await withTimeout(q(sql), o.queryTimeoutMs || 30000)); },
      async readParquet(bytes) {
        const f = 'upload_' + Date.now() + '.parquet';
        await db.registerFileBuffer(f, bytes);
        try { const t = await q("SELECT * FROM read_parquet('" + f + "') LIMIT 200000"); return convertArrow(t); } finally { try { await db.dropFile(f); } catch (e) { /* ignore */ } }
      },
      close() { try { conn.close(); db.terminate(); } catch (e) { /* ignore */ } }
    };
  }
  return { DUCKDB_VERSION, DUCKDB_CDN, sqlType, createSql, createSqlite, startSqlite, startDuckdb, convertArrow, lit, qi };
});
