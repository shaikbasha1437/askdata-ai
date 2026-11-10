const fs = require('node:fs');
const path = require('node:path');
const DATA = require('../js/data.js');
const ROOT = path.join(__dirname, '..');
const DEMO = ['orders', 'customers', 'products', 'saas_metrics'];
function demoTables() { return DEMO.map((n) => { const t = DATA.fromDelimited(n, fs.readFileSync(path.join(ROOT, 'samples', n + '.csv'), 'utf8')); t.profile = DATA.profile(t); return t; }); }
let SQLp = null;
function sqljs() { if (!SQLp) SQLp = require('../vendor/sqljs/sql-wasm.js')({ locateFile: (f) => path.join(ROOT, 'vendor', 'sqljs', f) }); return SQLp; }
async function sqliteWith(tables) { const E = require('../js/engine.js'); const eng = E.createSqlite(await sqljs()); for (const t of tables) await eng.load(t); return eng; }
module.exports = { ROOT, DEMO, demoTables, sqljs, sqliteWith };
