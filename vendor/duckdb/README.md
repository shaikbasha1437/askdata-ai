# DuckDB-WASM workers (vendored)

`duckdb-browser-eh.worker.js` and `duckdb-browser-mvp.worker.js` are copied unchanged (source-map comment removed) from
`@duckdb/duckdb-wasm@1.33.1-dev57.0` (MIT license, https://github.com/duckdb/duckdb-wasm).

The matching main module (`/+esm` build, which bundles Apache Arrow) and the `.wasm` files are loaded from
`https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/` on first use and then cached by the service worker,
so DuckDB also works offline after one online load. The workers are vendored so they are same-origin and controlled
by the service worker. If DuckDB cannot load, the app falls back to the vendored sql.js (SQLite) engine.
