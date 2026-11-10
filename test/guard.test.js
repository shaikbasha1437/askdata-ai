const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../js/sqlguard.js');
const T = ['orders', 'customers', 'products'];
const ok = (sql) => { const r = G.validate(sql, T); assert.ok(r.ok, sql + ' -> ' + r.error); return r; };
const no = (sql, re) => { const r = G.validate(sql, T); assert.equal(r.ok, false, sql + ' should be blocked'); if (re) assert.match(r.error, re); return r; };

test('plain SELECTs, CTEs, joins, subqueries and window functions are allowed', () => {
  ok('SELECT * FROM orders');
  ok('select status, count(*) n from orders group by 1 order by 2 desc limit 5;');
  ok('WITH t AS (SELECT * FROM orders), u(x) AS (SELECT 1) SELECT count(*) FROM t, u');
  ok('SELECT o.*, c.name FROM orders o LEFT JOIN customers c ON o.customer_id = c.customer_id');
  ok('SELECT * FROM (SELECT * FROM orders) x WHERE x.total > (SELECT AVG(total) FROM orders)');
  ok('SELECT status, SUM(total) OVER (PARTITION BY status) FROM orders');
  ok("SELECT extract(year FROM order_date), trim(both ' ' FROM status), replace(status, 'a', 'b') FROM orders");
  ok('SELECT "select" FROM "orders"');
  ok("SELECT 'DROP TABLE orders; DELETE FROM x' AS harmless_text FROM orders");
});
test('writes, DDL and engine commands are refused, even mid-query or in a CTE', () => {
  for (const s of ['INSERT INTO orders VALUES (1)', 'UPDATE orders SET total = 0', 'DELETE FROM orders', 'DROP TABLE orders', 'ALTER TABLE orders ADD x INT', 'CREATE TABLE x AS SELECT 1', 'ATTACH \'x.db\' AS x', 'DETACH x', "COPY orders TO 'x.csv'", 'PRAGMA table_info(orders)', 'SET threads = 1', 'INSTALL httpfs', 'LOAD httpfs', 'VACUUM', 'CALL pragma_version()', "EXPORT DATABASE 'x'", 'BEGIN', 'DESCRIBE orders', 'SUMMARIZE orders', 'SHOW TABLES']) no(s);
  no('WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x', /DELETE/);
  no('SELECT * INTO backup FROM orders', /INTO/);
});
test('multiple statements are refused; one trailing semicolon is fine', () => {
  no('SELECT 1 FROM orders; DROP TABLE orders', /one statement/);
  no('SELECT 1 FROM orders;;', /one statement/);
  ok('SELECT 1 FROM orders;');
});
test('comments cannot hide a second statement and are stripped', () => {
  const r = ok('-- note\nSELECT total /* c */ FROM orders');
  assert.ok(!/--|\/\*/.test(r.sql)); assert.ok(r.notes.some((n) => /Comments/.test(n)));
  no('SELECT 1 FROM orders /* */; DROP TABLE orders');
  no('SELECT 1 FROM orders -- \n; DELETE FROM orders');
});
test('files, URLs, table functions, system catalogs and schema-qualified names are refused', () => {
  no("SELECT * FROM read_csv('/etc/passwd')", /read_csv/);
  no("SELECT * FROM read_parquet('https://x.example/a.parquet')", /read_parquet/);
  no("SELECT * FROM 'data.csv'", /files or URLs/);
  no("SELECT * FROM orders JOIN 'x.csv' ON 1=1", /files or URLs/);
  no('SELECT * FROM range(10)', /Table functions/);
  no('SELECT * FROM main.orders', /Schema-qualified/);
  no('SELECT * FROM information_schema.tables', /Schema-qualified/);
  no('SELECT * FROM sqlite_master', /sqlite_master/);
  no('SELECT * FROM duckdb_settings()');
  no("SELECT getenv('HOME') FROM orders", /getenv/);
  no("SELECT load_extension('x') FROM orders", /load_extension/);
  no('SELECT * FROM users', /Unknown table "users"/);
  no('SELECT * FROM orders, users', /Unknown table/);
  no('SELECT * FROM orders WHERE id = $1', /parameters/);
});
test('LIMIT is added, lowered, or wrapped so at most 1000 rows come back', () => {
  assert.match(ok('SELECT * FROM orders').sql, /\nLIMIT 1000$/);
  assert.match(ok('SELECT * FROM orders LIMIT 5000').sql, /LIMIT 1000$/);
  assert.match(ok('SELECT * FROM orders LIMIT 20').sql, /LIMIT 20$/);
  assert.match(ok('SELECT * FROM orders OFFSET 10').sql, /LIMIT 1000 OFFSET 10/);
  assert.match(ok('SELECT * FROM orders LIMIT 10 + 5').sql, /^SELECT \* FROM \(\n[\s\S]+\n\) AS limited_result LIMIT 1000$/);
  assert.match(ok('SELECT * FROM (SELECT * FROM orders LIMIT 99999) x').sql, /\nLIMIT 1000$/);
  assert.match(G.validate('SELECT * FROM orders', T, { maxRows: 50 }).sql, /LIMIT 50$/);
});
test('non-SELECT starts, empty input, unbalanced parens and unterminated strings fail clearly', () => {
  no('', /empty/); no('   ', /empty/);
  no('FROM orders SELECT *', /Only read-only SELECT/);
  no('SELECT (1 FROM orders', /Unbalanced/);
  no("SELECT 'abc FROM orders", /Unclosed string/);
});
test('explain() describes each clause in plain English', () => {
  const ex = G.explain("SELECT c.region, ROUND(SUM(o.total), 2) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id WHERE o.status <> 'Cancelled' AND o.order_date >= '2026-01-01' GROUP BY c.region HAVING SUM(o.total) > 100 ORDER BY revenue DESC LIMIT 10");
  assert.deepEqual(ex.map((x) => x.clause), ['SELECT', 'FROM', 'JOIN', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT']);
  assert.match(ex[0].plain, /sum of o\.total, rounded to 2 decimals \(named revenue\)/);
  assert.match(ex[2].plain, /matching row of customers c where o\.customer_id is c\.customer_id/);
  assert.match(ex[3].plain, /status is not 'Cancelled', and o\.order_date is on or after '2026-01-01'/);
  assert.match(ex[6].plain, /largest/); assert.match(ex[7].plain, /at most 10 rows/);
  assert.equal(G.explain('WITH t AS (SELECT 1) SELECT * FROM t')[0].clause, 'WITH');
  assert.match(G.explain('SELECT COUNT(DISTINCT customer_id) FROM orders')[0].plain, /number of different customer_id/);
  assert.match(G.explain('SELECT * FROM orders LEFT JOIN customers ON 1=1')[2].clause, /LEFT JOIN/);
});
