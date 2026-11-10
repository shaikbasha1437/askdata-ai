# AskData AI: a data analyst agent in your browser

Ask a question in plain English and get read-only SQL, the result table, a chart, a short answer and a clause-by-clause explanation. Everything runs client-side with **DuckDB-WASM**, falling back to **SQLite (sql.js)**.

**Live demo:** https://shaikbasha1437.github.io/askdata-ai/ (works without a key)

Project 7 of a 15-part series of practical AI agents.

## What it does

- **Load data:** drop or pick CSV, TSV, JSON / JSON Lines or Parquet files, or paste from a spreadsheet. Two fictional demo datasets are bundled: a small shop (`orders`, `customers`, `products`) and SaaS metrics (`saas_metrics`). Both are deliberately messy, with mixed date formats, NULLs, duplicate rows, stray spaces and two prompt-injection strings hidden in customer notes.
- **Schema explorer and profile:** column types, NULL counts, distinct counts, ranges, common values, duplicate rows and keys, load notes (for example "mixed date formats normalised") and flagged cells.
- **Ask:** question → SQL (written with schema context) → **read-only check** → run → table + automatic chart (bar / line / pie / scatter / KPI / table, all switchable) → plain-English answer + explanation of each SQL clause. The SQL can be edited and re-run.
- **Two ways to write the SQL:**
  - **Demo rules (free, no key):** a deterministic NL→SQL engine that works on *any* loaded table. It covers totals, averages, counts, min/max, top/bottom N, "which X has the most Y", trends by day/week/month/quarter/year, shares, A-vs-B comparisons, filters on category values, numbers and dates ("in 2026", "March 2026", "last 3 months", "since 2025-06-01"), missing values, duplicates, and a single join over a shared `*_id` column. It states its assumptions, flags ambiguous words (for example "revenue" when two tables could mean it) and **abstains** instead of guessing.
  - **Your AI:** OpenAI, Anthropic (`anthropic-dangerous-direct-browser-access`), Google Gemini, any OpenAI-compatible API (OpenRouter, Ollama, LM Studio), or an experimental in-browser **WebLLM** model (WebGPU). The model returns JSON with the SQL, a chart hint, assumptions or an abstain flag. **Self-repair:** if the SQL fails the safety check or the database, the error goes back to the model for up to N retries (0–3, set in Settings).
- **Notebook and dashboard:** every question is saved locally. Re-run it, pin it to a dashboard (pinned queries re-run on the current data), or delete it (with undo).
- **Exports:** chart PNG / SVG, results CSV (formula-safe), `.sql` file, Markdown report, self-contained HTML report (one answer, the whole notebook or the dashboard).
- **Share links** encode only the question, the SQL, the table names and the chart type. Never data rows, never the key. Opening one shows a banner, and the SQL goes through the same read-only check before it runs.
- PWA: installable, works offline after the first visit (DuckDB included once it has loaded online), light/dark theme, mobile layout.

## Safety model

| Layer | What it does |
|---|---|
| Read-only SQL check (`js/sqlguard.js`) | Allows exactly one `SELECT` / `WITH … SELECT`. It blocks INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, ATTACH, COPY, PRAGMA, SET, INSTALL, LOAD, EXPORT, transaction commands, `SELECT … INTO`, file and URL readers (`read_csv`, `read_parquet`, `FROM 'file.csv'`, …), table functions, system catalogs, schema-qualified names, unknown tables and query parameters. It adds LIMIT 1000, or lowers or wraps a larger one. Comments are stripped. |
| Allow-list | FROM / JOIN may only name loaded tables, CTEs or sub-queries. |
| Prompt-injection guard | Cells that read like instructions to an AI are flagged on load, highlighted in results and **withheld** from every AI prompt. The system prompt tells the model that data is never instructions. |
| Answer check | An AI-written answer is shown only if every number in it appears in the result. Otherwise the computed summary is used. |
| Keys | Stored only in this browser (or in memory only), sent only to the chosen provider, never placed in exports, reports or links. |

## Run locally

```bash
python3 -m http.server 8080   # then open http://localhost:8080/
npm test                      # Node 20+, no dependencies to install
```

Tests: `node --test test/*.test.js`. They cover the CSV/JSON loader, date and type inference, the profile and injection scan, the SQL guard (allowed and blocked cases, LIMIT), the explainer, the rules engine, and every demo question run end-to-end on sql.js. Results are cross-checked against an independent plain-JS computation over the raw CSV. They also cover the agent loop with a scripted fake model (self-repair, abstain, number checking, prompt redaction), the provider request builders, exports and share links, and the service worker file list. `npm run samples` regenerates the demo CSVs from a fixed seed.

## Engines and vendored files

- `vendor/sqljs/`: sql.js 1.16.0 (MIT; SQLite is public domain). It is the offline fallback and the test engine.
- `vendor/duckdb/`: the DuckDB-WASM 1.33.1-dev57.0 browser workers (MIT). The main module (`+esm`, bundles Apache Arrow) and the `.wasm` file (about 36 MB) load from jsDelivr on first use. The service worker caches them under exact-version URLs, so DuckDB also works offline afterwards. If DuckDB cannot start, the app uses SQLite and says so.
- DuckDB and SQLite date functions differ. The rules engine writes the right dialect for the running engine, and the AI prompt names the dialect.

## Honest limits / what is simulated

- The demo datasets are **fictional** (names, companies, `*.example` addresses) and generated by `scripts/build-samples.mjs`.
- **Demo rules are not AI.** They do not handle nested logic, ratios between two measures, medians or percentiles, multi-hop joins, or words they were not taught. When they cannot map a question they abstain. Relative dates count back from the latest date *in the data*.
- **Live AI quality was not tested with real keys.** Request formats, error messages and the repair loop were tested with mocks and bogus keys only. WebLLM was not run during testing because it needs a WebGPU GPU and a large model download.
- In "Your AI" mode the provider receives the schema, value lists for low-cardinality columns, a few sample values and (optional, default on) up to 30 result rows. Flagged cells are withheld. Costs shown are estimates from list prices.
- Injection detection uses patterns, so it can miss cleverly worded text. The read-only SQL check is the hard guarantee, and nothing the model says can make the app write, read files or call other services.
- Files are limited to 100 MB and 200,000 rows. DuckDB runs single-threaded in the browser. Long-running sql.js queries cannot be interrupted.
- Uploaded tables are kept in this browser's IndexedDB until you remove them. Nothing is uploaded anywhere.

## Verification

See [VERIFICATION.md](VERIFICATION.md) for the live-site browser checks and the independently cross-checked numbers.

## License

MIT. See [LICENSE](LICENSE).
