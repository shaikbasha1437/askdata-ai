# Verification (2026-11-10)

All checks ran against the **live site** (https://shaikbasha1437.github.io/askdata-ai/) with Playwright: Google Chrome and Playwright Firefox (Playwright 1.64). The test scripts are not part of this repo.

| Suite | Result |
|---|---|
| Unit / integration tests (`npm test`, Node 24) | 59 / 59 pass |
| Live site, Chrome | 154 / 154 checks pass |
| Live site, Firefox | 151 / 151 checks pass (offline reload is checked in Chrome only, see below) |

## Demo answers, cross-checked independently

Expected values were computed with **pandas** from the raw sample CSVs, using a separate date parser and no app code. Each one was then compared with what the live app returned (DuckDB-WASM, and again with the SQLite engine).

| Question | App = pandas |
|---|---|
| What is the total revenue? | $46,124.01 (9 orders have no total) |
| Revenue by month | 18 months, 2025-01 $1,799.36 … 2026-06 $4,877.34, all equal |
| Top 5 products by revenue | Ridge Keyboard $9,442.01, Quill Headphones $6,089.09, Canvas Laptop Sleeve $4,079.47, Nimbus Air Purifier $3,456.56, Ember Kettle $3,323.13 |
| Revenue by region in 2026 | South $9,998.17, Central $3,999.20, East $3,979.99, West $3,855.11 |
| How many orders were cancelled? | 35 |
| Average order value by channel | Mobile $164.90, Marketplace $131.28, Web $130.18 |
| Share of orders by status | Delivered 141, Shipped 78, Processing 44, Returned 38, Cancelled 35 (shares sum to 100%) |
| Compare Web vs Mobile revenue | Web $19,787.70, Mobile $16,490.45 |
| Customers missing an email | 4 |
| MRR by plan over time (June 2026) | Enterprise 53,442, Growth 32,631, Starter 12,024 |
| Plan with most churned accounts in 2025 | Starter, 112 |
| Duplicate order ids | O-1041, O-1141, O-1287 |
| Orders over $700 | 8 rows |
| Will revenue grow next quarter? | Abstains, no SQL run |

## What the browser checks cover

- **Visits:** a fresh visit (demo tables auto-load, DuckDB-WASM engine, SW registered, no overflow). A repeat visit (the SW controls the page, tables and notebook persist, versioned caches exist). **Offline reload in Chrome**: DuckDB starts from cache and answers are unchanged.
- **Modals:** Settings, Limits, Paste, Rename, Profile and Share each close via X, Cancel, Esc, a backdrop click and browser Back (30 checks per browser).
- **Discard prompt:** an edited form asks before closing on Esc, Back and backdrop. Dismissing keeps it open; accepting discards. An empty required field (Rename) never blocks Cancel.
- **Undo toasts:** remove table, rename, delete a notebook item, clear the notebook, unpin from the dashboard, forget key.
- **Safety:**
  - "Delete all cancelled orders" is refused.
  - Edited `DROP`, `UPDATE`, `read_csv('https://…')`, stacked `DELETE` and `ATTACH` are all blocked, and the orders table keeps its 336 rows.
  - LIMIT 1000 is enforced.
  - The two injection cells are flagged on the table card, in the profile and in the results.
- **Charts:** a line chart for the monthly trend, bars for the top 5, 3 series for MRR, and chart-type switching.
- **SQL editing:** the edited SQL re-runs, and the Explain tab lists the clauses.
- **Uploads:**
  - My own CSV with mixed dates, "Amount ($)" headers, thousands separators and blanks: total 1,725.74, plus a per-team split.
  - A paste from a spreadsheet (TSV).
  - Nested JSON, flattened to `meta_source`.
  - **Parquet** written by pyarrow: total qty 20.
- **Exports:**
  - PNG (1440×720), SVG, CSV (19 lines), .sql, Markdown, HTML report, dashboard HTML and notebook .md.
  - No export contains the key.
- **Share link:** the payload holds only `{v,q,s,d,c}`, with no key or data. It round-trips in a new tab to the same 18 rows.
- **Engine switch:** with SQLite (sql.js) selected, the results are identical.
- **Your AI mode (network mocked, no real key):**
  - Self-repair after a bad column, with the DB error fed back.
  - AI answer accepted only when its numbers match the result; a hallucinated "99" was rejected.
  - A model that keeps writing `DELETE` is blocked on all 3 attempts.
  - Prompts never contain the injection text or the key.
  - Anthropic requests carry `anthropic-dangerous-direct-browser-access: true`.
- **Bogus key against the real endpoints:** each gives a readable error (one Test-connection request per provider):
  - OpenAI 401 "Incorrect API key provided"
  - Anthropic 401 "invalid x-api-key"
  - Gemini 400 "API key not valid"
  - OpenRouter 401
  - Ollama not running: "Could not reach … CORS / OLLAMA_ORIGINS"
- **Mobile (375 px), light and dark themes:** no horizontal overflow with results, a wide table, Settings or the notebook. The theme persists.
- No unexpected console or page errors.

## Bugs found and fixed during verification

1. **Discard prompt asked twice.** Accepting "Discard unsaved changes?" blurred the edited input, and the blur fired a `change` event that marked the closing modal dirty again, so the Back handler asked again. A closing flag now suppresses this, with a fallback removal.
2. **Rules engine picked the wrong table once other files were loaded.** With an undated pasted table that has an `amount` column, "Revenue by month" abstained ("no date column") and "Top 5 products by revenue" ranked the pasted table. The engine now prefers tables that have dates when the question needs them, and tables that are named in the question or join to one.
3. **"Total qty" summed `orders.total`.** A leading "total" or "sum" is now read as the aggregate when another numeric column is named after it.
4. Earlier, before the first deploy: a hidden share banner and offline pill were still showing, which `[hidden]` CSS fixed. The NL-engine fixes were also made then and are covered by the unit tests.

## Not verified / simulated

- Answer quality from real hosted models: no real keys were used, by design.
- WebLLM: needs a WebGPU GPU and a large model download.
- Offline reload in Firefox: Playwright's Firefox offline mode fails requests before the service worker can answer. The SW logic is the same for both browsers.
- All demo data is fictional.
