/* Runs every sample question end-to-end (NL rules -> guard -> sql.js) and checks the numbers against
   an independent plain-JS computation over the raw CSV text (own tiny parser, no app code). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers.cjs');
const DATA = require('../js/data.js');
const AGENT = require('../js/agent.js');
const NL = require('../js/nl.js');

// ---- independent reference data ----
function raw(name) { const lines = fs.readFileSync(path.join(H.ROOT, 'samples', name + '.csv'), 'utf8').trim().split('\n'); const head = lines[0].split(','); return lines.slice(1).map((l) => { const v = l.split(','); const o = {}; head.forEach((h, i) => { o[h] = v[i] === '' || v[i] === undefined ? null : v[i]; }); return o; }); }
const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
function iso(s) { let m; if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return s; if ((m = /^(\d+)\/(\d+)\/(\d{4})$/.exec(s))) return m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0'); if ((m = /^(\d+) (\w{3}) (\d{4})$/.exec(s))) return m[3] + '-' + String(MON[m[2]]).padStart(2, '0') + '-' + m[1].padStart(2, '0'); throw new Error('bad date ' + s); }
const O = raw('orders').map((o) => Object.assign(o, { order_date: iso(o.order_date), total: o.total == null ? null : +o.total, quantity: +o.quantity }));
const C = raw('customers'); const P = raw('products'); const S = raw('saas_metrics');
const cById = new Map(C.map((c) => [c.customer_id, c])); const pById = new Map(P.map((p) => [p.product_id, p]));
const r2 = (x) => Math.round(x * 100) / 100;
const sum = (a) => a.reduce((s, x) => s + x, 0);
function groupSum(rows, key, val) { const m = new Map(); for (const r of rows) { const v = val(r); if (v == null) continue; const k = key(r); m.set(k, (m.get(k) || 0) + v); } return m; }

let eng; let schema;
async function ask(q) { if (!eng) { const ts = H.demoTables(); eng = await H.sqliteWith(ts); schema = DATA.schemaOf(ts); } return AGENT.ask({ question: q, schema, dialect: 'sqlite', exec: (s) => eng.exec(s) }); }
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 0.011, (m || '') + ' ' + a + ' vs ' + b);

test('total revenue = sum of non-null totals', async () => {
  const r = await ask('What is the total revenue?');
  near(r.result.rows[0][0], r2(sum(O.filter((o) => o.total != null).map((o) => o.total))));
  assert.equal(r.chart.type, 'kpi'); assert.ok(r.assumptions.some((a) => /9 row\(s\) have no total/.test(a)));
});
test('revenue by month matches month-by-month sums (18 months, ordered)', async () => {
  const r = await ask('Revenue by month');
  const m = groupSum(O, (o) => o.order_date.slice(0, 7), (o) => o.total);
  assert.equal(r.result.rows.length, m.size);
  for (const [k, v] of r.result.rows) near(v, r2(m.get(k)), k);
  assert.deepEqual(r.result.rows.map((x) => x[0]), Array.from(m.keys()).sort());
  assert.equal(r.chart.type, 'line');
});
test('top 5 products by revenue (join on product_id)', async () => {
  const r = await ask('Top 5 products by revenue');
  const m = Array.from(groupSum(O, (o) => o.product_id, (o) => o.total)).sort((a, b) => b[1] - a[1]).slice(0, 5);
  assert.deepEqual(r.result.rows.map((x) => x[0]), m.map(([id]) => pById.get(id).product_name));
  r.result.rows.forEach((x, i) => near(x[1], r2(m[i][1])));
  assert.equal(r.chart.type, 'bar');
});
test('revenue by region in 2026 (join on customer_id + year filter)', async () => {
  const r = await ask('Revenue by region in 2026');
  const m = groupSum(O.filter((o) => o.order_date.startsWith('2026')), (o) => cById.get(o.customer_id).region, (o) => o.total);
  assert.equal(r.result.rows.length, m.size);
  for (const [k, v] of r.result.rows) near(v, r2(m.get(k)), k);
});
test('cancelled orders count', async () => {
  const r = await ask('How many orders were cancelled?');
  assert.equal(r.result.rows[0][0], O.filter((o) => o.status === 'Cancelled').length);
});
test('average order value by channel ignores NULL totals', async () => {
  const r = await ask('Average order value by channel');
  for (const [ch, v] of r.result.rows) { const xs = O.filter((o) => o.channel === ch && o.total != null).map((o) => o.total); near(v, r2(sum(xs) / xs.length), ch); }
});
test('share of orders by status adds up to 100%', async () => {
  const r = await ask('Share of orders by status');
  assert.equal(r.chart.type, 'pie');
  for (const [st, n, pct] of r.result.rows) { const c = O.filter((o) => o.status === st).length; assert.equal(n, c); near(pct, Math.round((1000 * c) / O.length) / 10); }
  assert.equal(sum(r.result.rows.map((x) => x[1])), O.length);
});
test('Web vs Mobile comparison', async () => {
  const r = await ask('Compare Web vs Mobile revenue');
  assert.deepEqual(r.result.rows.map((x) => x[0]).sort(), ['Mobile', 'Web']);
  for (const [ch, v] of r.result.rows) near(v, r2(sum(O.filter((o) => o.channel === ch && o.total != null).map((o) => o.total))));
});
test('customers missing an email', async () => {
  const r = await ask('How many customers are missing an email?');
  assert.equal(r.result.rows[0][0], C.filter((c) => c.email == null).length);
  assert.equal(r.result.rows[0][0], 4);
});
test('MRR by plan over time: one series per plan, 24 months each', async () => {
  const r = await ask('MRR by plan over time');
  assert.equal(r.result.rows.length, 72); assert.equal(r.chart.type, 'line'); assert.equal(r.chart.series, 'plan');
  for (const [month, plan, v] of r.result.rows) assert.equal(v, +S.find((s) => s.month.slice(0, 7) === month && s.plan === plan).mrr);
});
test('which plan had the most churned accounts in 2025', async () => {
  const r = await ask('Which plan had the most churned accounts in 2025?');
  const m = Array.from(groupSum(S.filter((s) => s.month.startsWith('2025')), (s) => s.plan, (s) => +s.churned_accounts)).sort((a, b) => b[1] - a[1]);
  assert.deepEqual(r.result.rows, [[m[0][0], m[0][1]]]);
});
test('duplicate order ids are the 3 injected duplicates', async () => {
  const r = await ask('Find duplicate order ids');
  const cnt = new Map(); O.forEach((o) => cnt.set(o.order_id, (cnt.get(o.order_id) || 0) + 1));
  assert.deepEqual(r.result.rows.map((x) => x[0]).sort(), Array.from(cnt).filter(([, n]) => n > 1).map(([k]) => k).sort());
});
test('orders over $700 lists every matching row', async () => {
  const r = await ask('Show orders over $700');
  assert.equal(r.result.rows.length, O.filter((o) => o.total != null && o.total > 700).length);
});
test('write requests are refused and forecasts abstain, with no SQL run', async () => {
  const a = await ask('Delete all cancelled orders'); assert.ok(a.refused); assert.ok(!a.result);
  const b = await ask('Will revenue grow next quarter?'); assert.match(b.abstain, /future/); assert.ok(!b.result);
  const c = await ask('What is the average profit margin by supplier?'); assert.ok(c.abstain); assert.ok(!c.result);
});
test('more shapes: last 3 months, March 2026, distinct buyers, units by category, cheapest products, excluding cancelled', async () => {
  let r = await ask('revenue in the last 3 months');
  near(r.result.rows[0][0], r2(sum(O.filter((o) => o.order_date >= '2026-04-01' && o.total != null).map((o) => o.total))));
  assert.ok(r.assumptions.some((a) => /latest date in the data \(2026-06-/.test(a)));
  r = await ask('revenue in March 2026');
  near(r.result.rows[0][0], r2(sum(O.filter((o) => o.order_date.startsWith('2026-03') && o.total != null).map((o) => o.total))));
  r = await ask('how many customers placed orders in 2026');
  assert.equal(r.result.rows[0][0], new Set(O.filter((o) => o.order_date.startsWith('2026')).map((o) => o.customer_id)).size);
  r = await ask('how many units sold by category');
  const u = groupSum(O, (o) => pById.get(o.product_id).category, (o) => o.quantity);
  for (const [k, v] of r.result.rows) assert.equal(v, u.get(k));
  r = await ask('3 cheapest products');
  assert.deepEqual(r.result.rows.map((x) => x[1]), P.map((p) => +p.list_price).sort((a, b) => a - b).slice(0, 3));
  r = await ask('orders by month excluding cancelled');
  assert.equal(sum(r.result.rows.map((x) => x[1])), O.filter((o) => o.status !== 'Cancelled').length);
  r = await ask('which region has the most customers');
  const reg = Array.from(groupSum(C, (c) => c.region, () => 1)).sort((a, b) => b[1] - a[1])[0];
  assert.deepEqual(r.result.rows[0], [reg[0], reg[1]]);
  r = await ask('Revenue by region for Business customers');
  const b = groupSum(O.filter((o) => cById.get(o.customer_id).segment === 'Business'), (o) => cById.get(o.customer_id).region, (o) => o.total);
  for (const [k, v] of r.result.rows) near(v, r2(b.get(k)), k);
});
test('the rules engine also works on an arbitrary uploaded table', async () => {
  const t = DATA.fromDelimited('expenses', 'date,team,vendor,amount\n2026-01-03,Design,Inkwell Co,120.50\n2026-01-15,Design,Pixel Supply,80\n2026-02-02,Sales,Roadside Diner,45.25\n2026-02-20,Sales,Inkwell Co,300\n2026-03-01,Ops,Pixel Supply,99.99\n');
  t.profile = DATA.profile(t);
  const e = await H.sqliteWith([t]); const sc = DATA.schemaOf([t]);
  const q = (s) => AGENT.ask({ question: s, schema: sc, dialect: 'sqlite', exec: (x) => e.exec(x) });
  assert.equal((await q('total amount')).result.rows[0][0], 645.74);
  assert.deepEqual((await q('amount by team')).result.rows, [['Sales', 345.25], ['Design', 200.5], ['Ops', 99.99]]);
  assert.deepEqual((await q('amount by month')).result.rows, [['2026-01', 200.5], ['2026-02', 345.25], ['2026-03', 99.99]]);
  assert.equal((await q('how many expenses for Inkwell Co')).result.rows[0][0], 2);
  assert.ok((await q('what is the weather tomorrow')).abstain);
});
test('DuckDB dialect output differs only in date functions', () => {
  const ts = H.demoTables(); const sc = DATA.schemaOf(ts);
  const a = NL.translate('Revenue by month', sc, { dialect: 'duckdb' }); const b = NL.translate('Revenue by month', sc, { dialect: 'sqlite' });
  assert.match(a.sql, /strftime\(order_date, '%Y-%m'\)/); assert.match(b.sql, /strftime\('%Y-%m', order_date\)/);
  assert.match(NL.translate('total new accounts by quarter', sc, { dialect: 'duckdb' }).sql, /quarter\("month"\)/);
});
test('an extra undated table with an "amount" column does not hijack dated revenue questions', async () => {
  const ts = H.demoTables(); const extra = DATA.fromDelimited('pasted_sales', 'rep,deals,amount\nAvery,3,1200\nJordan,5,800\n'); extra.profile = DATA.profile(extra); ts.push(extra);
  const e = await H.sqliteWith(ts); const sc = DATA.schemaOf(ts);
  const q = (s) => AGENT.ask({ question: s, schema: sc, dialect: 'sqlite', exec: (x) => e.exec(x) });
  const r = await q('Revenue by month');
  assert.equal(r.result.rows.length, 18); assert.match(r.sql, /FROM orders/);
  const y = await q('Revenue by region in 2026');
  assert.equal(y.result.rows.length, 4);
  assert.deepEqual((await q('Total amount by rep')).result.rows, [['Avery', 1200], ['Jordan', 800]]);
});
test('extra uploaded tables: "Top 5 products by revenue" stays on orders, "Total qty" uses the qty column', async () => {
  const ts = H.demoTables();
  const extra = DATA.fromDelimited('pasted_sales', 'rep,deals,amount\nAvery,3,1200\nJordan,5,800\n'); extra.profile = DATA.profile(extra); ts.push(extra);
  const inv = DATA.fromDelimited('inventory', 'sku,qty,price\nA1,3,9.5\nB2,5,20\nC3,2,7.25\nD4,10,1\n'); inv.profile = DATA.profile(inv); ts.push(inv);
  const e = await H.sqliteWith(ts); const sc = DATA.schemaOf(ts);
  const q = (s) => AGENT.ask({ question: s, schema: sc, dialect: 'sqlite', exec: (x) => e.exec(x) });
  const t5 = await q('Top 5 products by revenue');
  assert.equal(t5.result.rows[0][t5.result.rows[0].length - 1], 9442.01);
  assert.equal((await q('Total qty')).result.rows[0][0], 20);
  assert.equal((await q('Total amount by rep')).result.rows.length, 2);
});
