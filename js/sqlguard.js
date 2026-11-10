/* AskData SQL guard: tokenizer, read-only validator with a table allow-list, LIMIT enforcement,
   clause-by-clause plain-English explanation. Pure functions (UMD), shared by browser and tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.AskData = root.AskData || {}).guard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MAX_LIMIT = 1000;
  /* Tokens: {t:'word'|'qident'|'str'|'num'|'op'|'punct'|'param', v, raw, pos}. Comments are dropped (and reported). */
  function tokenize(sql) {
    const s = String(sql || ''); const out = []; let i = 0; let comments = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '-' && s[i + 1] === '-') { const j = s.indexOf('\n', i); i = j < 0 ? s.length : j + 1; comments++; continue; }
      if (c === '/' && s[i + 1] === '*') { const j = s.indexOf('*/', i + 2); if (j < 0) throw new Error('Unclosed /* comment.'); i = j + 2; comments++; continue; }
      if (c === "'") { let j = i + 1; let v = ''; for (;;) { if (j >= s.length) throw new Error('Unclosed string literal.'); if (s[j] === "'") { if (s[j + 1] === "'") { v += "'"; j += 2; continue; } break; } v += s[j++]; } out.push({ t: 'str', v, raw: s.slice(i, j + 1), pos: i }); i = j + 1; continue; }
      if (c === '"' || c === '`' || c === '[') { const close = c === '[' ? ']' : c; let j = i + 1; let v = ''; for (;;) { if (j >= s.length) throw new Error('Unclosed quoted identifier.'); if (s[j] === close) { if (s[j + 1] === close && close !== ']') { v += close; j += 2; continue; } break; } v += s[j++]; } out.push({ t: 'qident', v, raw: s.slice(i, j + 1), pos: i }); i = j + 1; continue; }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) { const m = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(s.slice(i)); out.push({ t: 'num', v: m[0], raw: m[0], pos: i }); i += m[0].length; continue; }
      if (/[A-Za-z_\u00c0-\uffff]/.test(c)) { const m = /^[A-Za-z_\u00c0-\uffff][A-Za-z0-9_$\u00c0-\uffff]*/.exec(s.slice(i)); out.push({ t: 'word', v: m[0], u: m[0].toUpperCase(), raw: m[0], pos: i }); i += m[0].length; continue; }
      if (c === '$' || c === '?' || c === ':' && /[A-Za-z]/.test(s[i + 1] || '')) { const m = /^[$?:][A-Za-z0-9_]*/.exec(s.slice(i)); if (c === ':' && s[i + 1] === ':') { out.push({ t: 'op', v: '::', raw: '::', pos: i }); i += 2; continue; } out.push({ t: 'param', v: m[0], raw: m[0], pos: i }); i += m[0].length; continue; }
      const two = s.slice(i, i + 2);
      if (['<=', '>=', '<>', '!=', '||', '::', '->', '=='].includes(two)) { out.push({ t: 'op', v: two, raw: two, pos: i }); i += 2; continue; }
      if ('(),;.'.includes(c)) { out.push({ t: 'punct', v: c, raw: c, pos: i }); i++; continue; }
      out.push({ t: 'op', v: c, raw: c, pos: i }); i++;
    }
    return { tokens: out, comments };
  }
  const WRITE = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'ATTACH', 'DETACH', 'COPY', 'PRAGMA', 'EXPORT', 'IMPORT', 'INSTALL', 'LOAD', 'SET', 'RESET', 'CALL', 'VACUUM', 'TRUNCATE', 'GRANT', 'REVOKE', 'CHECKPOINT', 'MERGE', 'UPSERT', 'REINDEX', 'ANALYZE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'INTO', 'RETURNING', 'USE', 'DESCRIBE', 'SUMMARIZE', 'SHOW', 'EXECUTE', 'PREPARE', 'DEALLOCATE', 'FORCE'];
  const WRITE_SET = new Set(WRITE);
  // Words that are writes as statements but also legitimate function names when followed by "(".
  const FN_OK = new Set(['REPLACE', 'LOAD']);
  const FILE_FUNCS = new Set(['read_csv', 'read_csv_auto', 'read_parquet', 'parquet_scan', 'read_json', 'read_json_auto', 'read_json_objects', 'read_ndjson', 'read_ndjson_auto', 'read_text', 'read_blob', 'glob', 'sniff_csv', 'parquet_metadata', 'parquet_schema', 'parquet_file_metadata', 'parquet_kv_metadata', 'iceberg_scan', 'delta_scan', 'read_xlsx', 'st_read', 'sqlite_scan', 'postgres_scan', 'mysql_scan', 'load_extension', 'readfile', 'writefile', 'edit', 'fts5', 'getenv', 'duckdb_secrets', 'duckdb_settings', 'duckdb_extensions', 'duckdb_databases', 'current_setting', 'query', 'query_table', 'http_get', 'http_post', 'pragma_table_info', 'sqlite_master', 'shell', 'system', 'which_secret']);
  const CLAUSE = new Set(['WHERE', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'UNION', 'INTERSECT', 'EXCEPT', 'WINDOW', 'QUALIFY', 'OFFSET', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'ON', 'USING', 'SELECT', 'FROM', 'POSITIONAL', 'ASOF', 'ANTI', 'SEMI', 'LATERAL']);

  function fail(msg) { return { ok: false, error: msg }; }
  /* Validate a single read-only SELECT. allowed: array of table names. Returns { ok, sql, tokens, ctes, tables, notes } or { ok:false, error }. */
  function validate(sql, allowed, opts) {
    const o = opts || {};
    let tk;
    try { tk = tokenize(sql); } catch (e) { return fail(e.message); }
    let toks = tk.tokens;
    if (!toks.length) return fail('The query is empty.');
    // One statement only: a single trailing semicolon is fine.
    const semis = toks.map((t, i) => (t.t === 'punct' && t.v === ';' ? i : -1)).filter((i) => i >= 0);
    if (semis.length && !(semis.length === 1 && semis[0] === toks.length - 1)) return fail('Only one statement is allowed. Remove the extra ";" and anything after it.');
    if (semis.length) toks = toks.slice(0, -1);
    const first = toks[0];
    if (!(first.t === 'word' && (first.u === 'SELECT' || first.u === 'WITH'))) return fail('Only read-only SELECT queries can run here (the query starts with "' + (first.raw || '').slice(0, 20) + '").');
    // Parenthesis balance + depth per token.
    let depth = 0; const depthAt = [];
    for (const t of toks) { if (t.t === 'punct' && t.v === '(') depth++; depthAt.push(depth); if (t.t === 'punct' && t.v === ')') { depth--; if (depth < 0) return fail('Unbalanced parentheses.'); } }
    if (depth !== 0) return fail('Unbalanced parentheses.');
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]; const next = toks[i + 1];
      if (t.t === 'param') return fail('Query parameters (' + t.v + ') are not supported.');
      if (t.t !== 'word') continue;
      const callsFn = next && next.t === 'punct' && next.v === '(';
      const prev = toks[i - 1];
      const isMember = prev && prev.t === 'punct' && prev.v === '.';
      if (WRITE_SET.has(t.u) && !(callsFn && FN_OK.has(t.u)) && !isMember) return fail(t.u + ' is not allowed: this tool only runs read-only SELECT queries.');
      if (callsFn && FILE_FUNCS.has(t.v.toLowerCase())) return fail(t.v + '() is not allowed: queries may only read the loaded tables, not files, settings or the network.');
      if (FILE_FUNCS.has(t.v.toLowerCase()) && /^(sqlite_master|duckdb_secrets|duckdb_settings)$/i.test(t.v)) return fail(t.v + ' is not allowed.');
    }
    // CTE names: identifiers at depth 0 directly before AS ( or (cols) AS ( inside the WITH preamble.
    const ctes = new Set();
    if (first.u === 'WITH') {
      for (let i = 1; i < toks.length; i++) {
        const t = toks[i];
        if (depthAt[i] === 0 && t.t === 'word' && t.u === 'SELECT') break;
        if (depthAt[i] !== 0 || !(t.t === 'word' || t.t === 'qident') || t.u === 'RECURSIVE' || t.u === 'AS' || t.u === 'MATERIALIZED') continue;
        let j = i + 1;
        if (toks[j] && toks[j].v === '(') { let d = 0; for (; j < toks.length; j++) { if (toks[j].v === '(') d++; if (toks[j].v === ')') { d--; if (d === 0) { j++; break; } } } }
        if (toks[j] && toks[j].t === 'word' && toks[j].u === 'AS') ctes.add(t.v.toLowerCase());
      }
    }
    const allow = new Set((allowed || []).map((n) => String(n).toLowerCase()));
    const used = new Set();
    // FROM / JOIN targets must be loaded tables, CTEs or sub-queries.
    function checkTarget(i) {
      const t = toks[i];
      if (!t) return 'FROM needs a table.';
      if (t.t === 'punct' && t.v === '(') return null;
      if (t.t === 'str') return 'Reading files or URLs is not allowed (FROM ' + t.raw.slice(0, 40) + ').';
      if (t.t !== 'word' && t.t !== 'qident') return 'Unexpected "' + t.raw + '" after FROM/JOIN.';
      if (t.t === 'word' && (t.u === 'LATERAL' || t.u === 'UNNEST')) return null;
      const n = toks[i + 1];
      if (n && n.t === 'punct' && n.v === '.') return 'Schema-qualified names (' + t.v + '.' + ((toks[i + 2] || {}).v || '') + ') are not allowed. Use the table name only.';
      if (n && n.t === 'punct' && n.v === '(') return 'Table functions (' + t.v + '(...)) are not allowed in FROM. Query the loaded tables.';
      const name = t.v.toLowerCase();
      if (!allow.has(name) && !ctes.has(name)) return 'Unknown table "' + t.v + '". Loaded tables: ' + (allowed || []).join(', ') + '.';
      if (!ctes.has(name)) used.add(allowed.find((a) => a.toLowerCase() === name));
      return null;
    }
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.t !== 'word' || (t.u !== 'FROM' && t.u !== 'JOIN')) continue;
      // Skip "FROM" inside function syntax like EXTRACT(year FROM x), TRIM(... FROM x), SUBSTRING(x FROM 1).
      if (t.u === 'FROM') { let k = i - 1; let d = 0; let fn = null; for (; k >= 0; k--) { const x = toks[k]; if (x.v === ')') d++; else if (x.v === '(') { if (d === 0) { fn = toks[k - 1]; break; } d--; } } if (fn && fn.t === 'word' && /^(EXTRACT|TRIM|SUBSTRING|SUBSTR|POSITION|OVERLAY|DATE_PART|DATEPART)$/.test(fn.u)) continue; }
      const err = checkTarget(i + 1); if (err) return fail(err);
      if (t.u === 'FROM') {
        // comma-separated list at the same depth
        const d0 = depthAt[i];
        for (let j = i + 2; j < toks.length; j++) {
          const x = toks[j];
          if (depthAt[j] < d0 || (x.v === ')' && depthAt[j] === d0)) break;
          if (depthAt[j] !== d0) continue;
          if (x.t === 'word' && CLAUSE.has(x.u)) break;
          if (x.t === 'punct' && x.v === ',') { const e2 = checkTarget(j + 1); if (e2) return fail(e2); }
        }
      }
    }
    // Top-level LIMIT enforcement.
    const max = o.maxRows || MAX_LIMIT;
    let body = rebuild(sql, toks);
    const notes = [];
    let li = -1; let oi = -1;
    for (let i = 0; i < toks.length; i++) if (depthAt[i] === 0 && toks[i].t === 'word') { if (toks[i].u === 'LIMIT') li = i; if (toks[i].u === 'OFFSET') oi = i; }
    if (li >= 0) {
      const n = toks[li + 1]; const after = toks[li + 2];
      const plain = n && n.t === 'num' && /^\d+$/.test(n.v) && (!after || (after.t === 'word' && after.u === 'OFFSET'));
      if (plain && +n.v <= max) { /* fine */ } else if (plain) { body = body.slice(0, n.pos - toks[0].pos) + String(max) + body.slice(n.pos - toks[0].pos + n.v.length); notes.push('LIMIT lowered to ' + max + ' rows.'); } else { body = 'SELECT * FROM (\n' + body + '\n) AS limited_result LIMIT ' + max; notes.push('Wrapped to return at most ' + max + ' rows.'); }
    } else if (oi >= 0) {
      const at = toks[oi].pos - toks[0].pos; body = body.slice(0, at) + 'LIMIT ' + max + ' ' + body.slice(at); notes.push('Added LIMIT ' + max + '.');
    } else { body = body + '\nLIMIT ' + max; notes.push('Added LIMIT ' + max + '.'); }
    if (tk.comments) notes.push('Comments were removed before running.');
    return { ok: true, sql: body, tables: Array.from(used), ctes: Array.from(ctes), notes, limitAdded: notes.some((n) => /LIMIT|Wrapped/.test(n)) };
  }
  /* Rebuild SQL text without comments, keeping original spacing between tokens where possible. */
  function rebuild(sql, toks) {
    const s = String(sql);
    let out = ''; let prevEnd = null;
    for (const t of toks) {
      const gap = prevEnd == null ? '' : s.slice(prevEnd, t.pos);
      out += prevEnd == null ? '' : (/--|\/\*/.test(gap) ? (/\n/.test(gap) ? '\n' : ' ') : gap.replace(/[^\s]/g, ''));
      out += t.raw; prevEnd = t.pos + t.raw.length;
    }
    // positions in the rebuilt text are needed for LIMIT replacement; re-tokenise lazily if comments were present
    return out;
  }
  // Recompute token positions against the rebuilt (comment-free) SQL so LIMIT edits land correctly.
  const _validate = validate;
  function validateSafe(sql, allowed, opts) {
    const tk = (() => { try { return tokenize(sql); } catch (e) { return null; } })();
    if (tk && tk.comments) { const clean = rebuild(sql, tk.tokens); const r = _validate(clean, allowed, opts); if (r.ok && !r.notes.includes('Comments were removed before running.')) r.notes.push('Comments were removed before running.'); return r; }
    return _validate(sql, allowed, opts);
  }

  /* ---------- explanation ---------- */
  function splitClauses(sql) {
    const { tokens } = tokenize(sql);
    const s = String(sql); const out = []; let depth = 0; let cur = null;
    const starts = ['WITH', 'SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'QUALIFY', 'WINDOW'];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.v === '(') depth++;
      if (t.v === ')') depth--;
      if (depth === 0 && t.t === 'word' && starts.includes(t.u)) {
        const prev = tokens[i - 1];
        const joinMod = ['LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'OUTER', 'NATURAL'];
        if (t.u === 'JOIN' && prev && prev.t === 'word' && joinMod.includes(prev.u)) continue;
        if (t.u === 'OUTER') continue;
        if (cur && cur.kind === 'UNION' && t.u === 'SELECT' && prev && (prev.u === 'UNION' || prev.u === 'ALL')) continue;
        if (cur) cur.end = t.pos;
        cur = { kind: (['LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS'].includes(t.u) ? 'JOIN' : t.u), start: t.pos, joinType: ['LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS'].includes(t.u) ? t.u : null };
        out.push(cur);
      }
    }
    if (cur) cur.end = s.length;
    return out.map((c) => ({ kind: c.kind, joinType: c.joinType, text: s.slice(c.start, c.end).trim().replace(/;$/, '').trim() }));
  }
  function splitTop(text, sep) {
    const parts = []; let d = 0; let cur = ''; let q = null;
    for (let i = 0; i < text.length; i++) { const c = text[i]; if (q) { cur += c; if (c === q) q = null; continue; } if (c === "'" || c === '"') { q = c; cur += c; continue; } if (c === '(') d++; if (c === ')') d--; if (d === 0 && text.slice(i, i + sep.length).toUpperCase() === sep && (sep !== ' AND ' || true)) { parts.push(cur); cur = ''; i += sep.length - 1; continue; } cur += c; }
    if (cur.trim()) parts.push(cur);
    return parts.map((p) => p.trim()).filter(Boolean);
  }
  const unq = (x) => String(x).replace(/"([^"]+)"/g, '$1');
  function describeExpr(e) {
    let x = unq(e.trim());
    let alias = null;
    const am = /^(.*?)\s+AS\s+([A-Za-z_][\w]*|"[^"]+")$/i.exec(x);
    if (am) { x = am[1].trim(); alias = am[2].replace(/"/g, ''); }
    let d = x;
    const fn = (re, f) => { const m = re.exec(d); if (m) d = f(m); };
    fn(/^ROUND\((.*),\s*(\d+)\)$/i, (m) => describeExpr(m[1]).replace(/^(.)/, (c) => c) + ', rounded to ' + m[2] + ' decimals');
    fn(/^COUNT\(\s*\*\s*\)$/i, () => 'the number of rows');
    fn(/^COUNT\(\s*DISTINCT\s+(.+)\)$/i, (m) => 'the number of different ' + m[1]);
    fn(/^COUNT\((.+)\)$/i, (m) => 'the number of non-empty ' + m[1] + ' values');
    fn(/^SUM\((.+)\)$/i, (m) => 'the sum of ' + m[1]);
    fn(/^AVG\((.+)\)$/i, (m) => 'the average ' + m[1]);
    fn(/^MIN\((.+)\)$/i, (m) => 'the smallest ' + m[1]);
    fn(/^MAX\((.+)\)$/i, (m) => 'the largest ' + m[1]);
    fn(/^strftime\(\s*'%Y-%m',\s*(.+)\)$/i, (m) => 'the month (YYYY-MM) of ' + m[1]);
    fn(/^strftime\(\s*(.+),\s*'%Y-%m'\s*\)$/i, (m) => 'the month (YYYY-MM) of ' + m[1]);
    fn(/^strftime\(\s*'%Y',\s*(.+)\)$/i, (m) => 'the year of ' + m[1]);
    fn(/^strftime\(\s*(.+),\s*'%Y'\s*\)$/i, (m) => 'the year of ' + m[1]);
    if (x === '*') d = 'every column';
    return d + (alias && alias !== x ? ' (named ' + alias + ')' : '');
  }
  function describeCond(c) {
    let x = unq(c.trim()).replace(/^\((.*)\)$/s, '$1');
    return x
      .replace(/\s+IS\s+NOT\s+NULL/gi, ' is present').replace(/\s+IS\s+NULL/gi, ' is missing')
      .replace(/\s+NOT\s+IN\s*\(/gi, ' is not one of (').replace(/\s+IN\s*\(/gi, ' is one of (')
      .replace(/\s+NOT\s+LIKE\s+/gi, ' does not match ').replace(/\s+I?LIKE\s+/gi, ' matches the pattern ')
      .replace(/\s+BETWEEN\s+(.+?)\s+AND\s+/gi, ' is between $1 and ')
      .replace(/\s*(>=|<=|<>|!=|>|<|=)\s*('[^']*'|[^\s]+)/g, (m, op, rhs) => { const date = /^'\d{4}-\d{2}/.test(rhs); const w = { '>=': date ? ' is on or after ' : ' is at least ', '<=': date ? ' is on or before ' : ' is at most ', '<>': ' is not ', '!=': ' is not ', '>': date ? ' is after ' : ' is greater than ', '<': date ? ' is before ' : ' is less than ', '=': ' is ' }[op]; return w + rhs; });
  }
  function explain(sql) {
    let clauses;
    try { clauses = splitClauses(sql); } catch (e) { return [{ clause: 'SQL', text: String(sql), plain: 'Could not read this SQL: ' + e.message }]; }
    return clauses.map((c) => {
      const body = c.text.replace(/^\S+(\s+(BY|ALL|JOIN|OUTER\s+JOIN))?\s*/i, '');
      let plain = '';
      switch (c.kind) {
        case 'WITH': plain = 'First builds a named temporary result (a CTE) that the main query can read like a table.'; break;
        case 'SELECT': { const distinct = /^DISTINCT\s/i.test(body); const cols = splitTop(body.replace(/^DISTINCT\s+/i, ''), ','); plain = 'Returns ' + (distinct ? 'unique combinations of ' : '') + cols.map(describeExpr).join('; ') + '.'; break; }
        case 'FROM': plain = 'Reads rows from ' + unq(body) + '.'; break;
        case 'JOIN': { const m = /^(.*?)\s+ON\s+(.*)$/is.exec(body.replace(/^(OUTER\s+)?JOIN\s+/i, '')); const kind = c.joinType === 'LEFT' ? 'Keeps every row so far and adds matching rows from ' : c.joinType === 'CROSS' ? 'Pairs every row with every row of ' : 'Combines each row with the matching row of '; plain = m ? kind + unq(m[1]) + ' where ' + describeCond(m[2]) + '.' : kind + unq(body) + '.'; break; }
        case 'WHERE': plain = 'Keeps only rows where ' + splitTop(body, ' AND ').map(describeCond).join(', and ') + '.'; break;
        case 'GROUP': plain = 'Groups the rows by ' + unq(body) + ', so each group becomes one output row.'; break;
        case 'HAVING': plain = 'Keeps only groups where ' + describeCond(body) + '.'; break;
        case 'ORDER': plain = 'Sorts by ' + splitTop(body, ',').map((p) => { const d = /\sDESC$/i.test(p); return unq(p.replace(/\s+(ASC|DESC)(\s+NULLS\s+(FIRST|LAST))?$/i, '')) + (d ? ' (largest / latest first)' : ' (smallest / earliest first)'); }).join(', then ') + '.'; break;
        case 'LIMIT': plain = 'Returns at most ' + body + ' rows.'; break;
        case 'OFFSET': plain = 'Skips the first ' + body + ' rows.'; break;
        case 'UNION': case 'INTERSECT': case 'EXCEPT': plain = 'Combines the result with another query (' + c.kind + ').'; break;
        default: plain = c.text;
      }
      return { clause: c.kind === 'GROUP' ? 'GROUP BY' : c.kind === 'ORDER' ? 'ORDER BY' : c.kind === 'JOIN' ? (c.joinType && c.joinType !== 'INNER' ? c.joinType + ' JOIN' : 'JOIN') : c.kind, text: c.text, plain };
    });
  }
  function isWriteIntent(sql) { const r = validateSafe(sql, null); return !r.ok && /not allowed|Only read-only/.test(r.error); }
  return { MAX_LIMIT, tokenize, validate: validateSafe, explain, splitClauses, isWriteIntent, WRITE };
});
