/* AskData data layer: CSV/TSV/JSON parsing, column type inference, messy-date normalisation,
   table profiling and a scan for prompt-injection text hidden in cell values. Pure functions (UMD). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.AskData = root.AskData || {}).data = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MAX_ROWS = 200000;
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12, january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

  /* RFC 4180-ish parser: quoted fields, doubled quotes, CRLF/LF, embedded newlines, BOM. */
  function parseDelimited(text, delim) {
    const s = String(text || '').replace(/^\uFEFF/, '');
    const d = delim || sniffDelimiter(s);
    const rows = []; let row = []; let field = ''; let i = 0; let q = false;
    while (i < s.length) {
      const c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
        field += c; i++; continue;
      }
      if (c === '"' && field === '') { q = true; i++; continue; }
      if (c === d) { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    while (rows.length && rows[rows.length - 1].every((x) => x === '')) rows.pop();
    return { delimiter: d, rows };
  }
  function sniffDelimiter(s) {
    const lines = s.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
    let best = ','; let bestScore = -1;
    for (const d of [',', '\t', ';', '|']) {
      const counts = lines.map((l) => l.split(d).length - 1);
      if (!counts.length || counts[0] === 0) continue;
      const same = counts.filter((c) => c === counts[0]).length;
      const score = same * 10 + counts[0];
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  /* Identifier clean-up: lower snake_case, unique, never empty, never a SQL keyword clash. */
  const RESERVED = new Set(['select', 'from', 'where', 'group', 'order', 'by', 'limit', 'table', 'join', 'on', 'as', 'and', 'or', 'not', 'null', 'case', 'when', 'then', 'else', 'end', 'having', 'union', 'all', 'distinct', 'in', 'is', 'like', 'between', 'desc', 'asc', 'offset', 'with', 'values', 'create', 'drop', 'insert', 'update', 'delete', 'primary', 'default', 'check', 'unique', 'references', 'to', 'into', 'set']);
  function cleanName(raw, used, fallback) {
    let n = String(raw == null ? '' : raw).trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!n) n = fallback || 'col';
    if (/^[0-9]/.test(n)) n = 'c_' + n;
    if (RESERVED.has(n)) n = n + '_';
    n = n.slice(0, 48);
    let out = n; let k = 2;
    while (used && used.has(out)) out = n + '_' + k++;
    if (used) used.add(out);
    return out;
  }
  function tableNameFromFile(fileName, used) { return cleanName(String(fileName || 'table').replace(/\.[a-z0-9]+$/i, ''), used, 'table'); }

  /* ---------- value parsing ---------- */
  const NULLS = new Set(['', 'null', 'na', 'n/a', 'nan', 'none', '-', '#n/a', 'nil']);
  function isNullish(v) { return v == null || (typeof v === 'string' && NULLS.has(v.trim().toLowerCase())); }
  function parseNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    let s = String(v).trim();
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/^[$€£]\s?/, '').replace(/\s?[$€£]$/, '');
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? (neg ? -n : n) : null;
  }
  const pad = (n) => String(n).padStart(2, '0');
  function validYmd(y, m, d) { if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return false; const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d; }
  /* Returns { iso, fmt } or null. order = 'mdy' | 'dmy' decides slash dates. */
  function parseDate(v, order) {
    if (v == null) return null;
    const s = String(v).trim();
    let m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s))) {
      const y = +m[1]; const mo = +m[2]; const d = +m[3];
      if (!validYmd(y, mo, d)) return null;
      if (m[4] != null && (+m[4] !== 0 || +m[5] !== 0 || +(m[6] || 0) !== 0)) return { iso: y + '-' + pad(mo) + '-' + pad(d) + ' ' + pad(+m[4]) + ':' + m[5] + ':' + pad(+(m[6] || 0)), fmt: 'iso-datetime', time: true };
      return { iso: y + '-' + pad(mo) + '-' + pad(d), fmt: m[4] != null ? 'iso-datetime' : 'iso' };
    }
    if ((m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s))) { if (!validYmd(+m[1], +m[2], +m[3])) return null; return { iso: m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]), fmt: 'y/m/d' }; }
    if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/.exec(s))) {
      let a = +m[1]; let b = +m[2]; let y = +m[3]; if (m[3].length === 2) y += y < 70 ? 2000 : 1900;
      const [mo, d] = order === 'dmy' ? [b, a] : [a, b];
      if (!validYmd(y, mo, d)) return null;
      return { iso: y + '-' + pad(mo) + '-' + pad(d), fmt: order === 'dmy' ? 'd/m/y' : 'm/d/y' };
    }
    if ((m = /^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?[\s-],?\s*(\d{4})$/.exec(s))) { const mo = MONTHS[m[2].toLowerCase()]; if (!mo || !validYmd(+m[3], mo, +m[1])) return null; return { iso: m[3] + '-' + pad(mo) + '-' + pad(+m[1]), fmt: 'd mon y' }; }
    if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s))) { const mo = MONTHS[m[1].toLowerCase()]; if (!mo || !validYmd(+m[3], mo, +m[2])) return null; return { iso: m[3] + '-' + pad(mo) + '-' + pad(+m[2]), fmt: 'mon d, y' }; }
    return null;
  }
  /* Decide m/d/y vs d/m/y for a column: if any first part > 12 it must be d/m/y. */
  function slashOrder(values) {
    let firstBig = 0; let secondBig = 0;
    for (const v of values) { const m = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}$/.exec(String(v).trim()); if (!m) continue; if (+m[1] > 12) firstBig++; if (+m[2] > 12) secondBig++; }
    return firstBig > secondBig ? 'dmy' : 'mdy';
  }

  /* Infer a type per column and build typed rows. Input: header array + array of string arrays (or raw values). */
  function inferColumn(values) {
    const present = values.filter((v) => !isNullish(v));
    if (!present.length) return { type: 'TEXT' };
    if (present.every((v) => typeof v === 'boolean' || /^(true|false)$/i.test(String(v).trim()))) return { type: 'TEXT', boolish: true };
    let ints = true; let nums = 0;
    for (const v of present) { const n = parseNumber(v); if (n == null) { ints = false; nums = -1; break; } nums++; if (!Number.isInteger(n) || Math.abs(n) > 9007199254740991) ints = false; }
    // Leading-zero codes like 00123 or zip codes stay TEXT so they keep their zeros.
    const leadingZero = present.some((v) => /^0\d+$/.test(String(v).trim()));
    if (nums === present.length && !leadingZero) return { type: ints ? 'INTEGER' : 'DOUBLE' };
    const order = slashOrder(present);
    let ok = 0; let time = false; const fmts = {};
    for (const v of present) { const d = parseDate(v, order); if (d) { ok++; fmts[d.fmt] = (fmts[d.fmt] || 0) + 1; if (d.time) time = true; } }
    if (ok / present.length >= 0.9 && ok >= 1) return { type: time ? 'TIMESTAMP' : 'DATE', order, formats: fmts, unparsed: present.length - ok };
    return { type: 'TEXT' };
  }
  function convert(v, col) {
    if (isNullish(v)) return null;
    if (col.type === 'INTEGER' || col.type === 'DOUBLE') return parseNumber(v);
    if (col.type === 'DATE' || col.type === 'TIMESTAMP') { const d = parseDate(v, col.order); return d ? (col.type === 'TIMESTAMP' && !d.time ? d.iso + ' 00:00:00' : d.iso) : null; }
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  function buildTable(name, header, rawRows, source) {
    const used = new Set();
    const width = Math.max(header.length, ...rawRows.slice(0, 1000).map((r) => r.length));
    const names = []; for (let i = 0; i < width; i++) names.push(cleanName(header[i], used, 'col_' + (i + 1)));
    const notes = [];
    let trimmed = 0;
    const rows0 = rawRows.slice(0, MAX_ROWS).map((r) => names.map((_, i) => { const v = r[i]; if (typeof v === 'string' && v !== v.trim()) { trimmed++; return v.trim(); } return v; }));
    if (rawRows.length > MAX_ROWS) notes.push('Only the first ' + MAX_ROWS.toLocaleString('en-US') + ' of ' + rawRows.length.toLocaleString('en-US') + ' rows were loaded.');
    if (trimmed) notes.push('Trimmed stray spaces in ' + trimmed + ' cell' + (trimmed === 1 ? '' : 's') + '.');
    const columns = names.map((n, i) => { const inf = inferColumn(rows0.map((r) => r[i])); return Object.assign({ name: n, original: header[i] == null ? '' : String(header[i]) }, inf); });
    columns.forEach((c) => { if (c.formats && Object.keys(c.formats).length > 1) notes.push(c.name + ': mixed date formats (' + Object.entries(c.formats).map(([k, v]) => v + ' ' + k).join(', ') + ') normalised to YYYY-MM-DD' + (c.order === 'dmy' ? ' (day-first)' : '') + '.'); if (c.unparsed) notes.push(c.name + ': ' + c.unparsed + ' value(s) could not be read as dates and became NULL.'); });
    const renamed = columns.filter((c) => c.original && c.original !== c.name);
    if (renamed.length) notes.push('Renamed ' + renamed.length + ' column(s) to SQL-friendly names: ' + renamed.slice(0, 6).map((c) => '"' + c.original + '" → ' + c.name).join(', ') + (renamed.length > 6 ? ', …' : '') + '.');
    const rows = rows0.map((r) => columns.map((c, i) => convert(r[i], c)));
    return { name, columns: columns.map((c) => ({ name: c.name, type: c.type, original: c.original })), rows, notes, source: source || 'upload' };
  }
  function fromDelimited(name, text, delim) {
    const p = parseDelimited(text, delim);
    if (!p.rows.length) throw new Error('The file is empty.');
    const header = p.rows[0];
    if (p.rows.length < 2) throw new Error('Found a header row but no data rows.');
    return buildTable(name, header, p.rows.slice(1));
  }
  /* JSON: array of objects, {data:[...]}, or newline-delimited JSON. Nested objects are flattened with "_". */
  function flatten(obj, prefix, out, depth) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? prefix + '_' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) flatten(v, key, out, depth + 1);
      else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
    }
    return out;
  }
  function fromJson(name, text) {
    let data;
    const t = String(text || '').trim();
    try { data = JSON.parse(t); } catch (e) {
      const lines = t.split(/\r?\n/).filter((l) => l.trim());
      try { data = lines.map((l) => JSON.parse(l)); } catch (e2) { throw new Error('Not valid JSON or JSON Lines.'); }
    }
    if (data && !Array.isArray(data) && typeof data === 'object') { const arr = Object.values(data).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object'); if (arr) data = arr; }
    if (!Array.isArray(data) || !data.length) throw new Error('Expected an array of objects.');
    const flat = data.filter((x) => x && typeof x === 'object' && !Array.isArray(x)).map((x) => flatten(x, '', {}, 0));
    if (!flat.length) throw new Error('Expected an array of objects.');
    const header = []; const seen = new Set();
    for (const o of flat.slice(0, 5000)) for (const k of Object.keys(o)) if (!seen.has(k)) { seen.add(k); header.push(k); }
    return buildTable(name, header, flat.map((o) => header.map((h) => (o[h] === undefined ? null : o[h]))));
  }
  /* Rows that already have values (e.g. from Parquet via DuckDB): objects keyed by column. */
  function fromObjects(name, objs, source) {
    const header = objs.length ? Object.keys(objs[0]) : [];
    return buildTable(name, header, objs.map((o) => header.map((h) => o[h])), source);
  }

  /* ---------- prompt-injection scan over cell values ---------- */
  const INJECTION = [
    /\bignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|rules|messages)/i,
    /\bdisregard\s+(all\s+|the\s+|your\s+)?(previous|prior|above|system|earlier)/i,
    /\b(system|developer)\s*(prompt|message)\b/i,
    /^\s*(system|assistant|developer)\s*:/i,
    /\byou\s+are\s+now\b/i,
    /\b(admin|developer|god|jailbreak)\s+mode\b/i,
    /\breveal\b.{0,40}\b(prompt|key|secret|password|instructions)\b/i,
    /\b(drop|truncate|delete\s+from|alter)\s+table\b/i,
    /\b(tell|inform)\s+the\s+user\b/i,
    /\b(api[_\s-]?key|access[_\s-]?token)\b.{0,30}\b(send|post|print|show|reveal)\b/i,
    /<\s*\/?\s*(system|instructions?|prompt)\s*>/i
  ];
  function looksLikeInjection(v) { if (typeof v !== 'string' || v.length < 12) return null; for (const re of INJECTION) { const m = re.exec(v); if (m) return m[0]; } return null; }
  function scanInjection(table, max) {
    const hits = [];
    table.columns.forEach((c, ci) => { if (c.type !== 'TEXT') return; for (let r = 0; r < table.rows.length; r++) { const v = table.rows[r][ci]; const m = looksLikeInjection(v); if (m) { hits.push({ table: table.name, column: c.name, row: r + 1, match: m, value: String(v).slice(0, 200) }); if (hits.length >= (max || 50)) return; } } });
    return hits;
  }

  /* ---------- profile ---------- */
  function profile(table) {
    const n = table.rows.length;
    const cols = table.columns.map((c, ci) => {
      const vals = []; let nulls = 0;
      for (const r of table.rows) { const v = r[ci]; if (v == null) nulls++; else vals.push(v); }
      const freq = new Map(); for (const v of vals) freq.set(v, (freq.get(v) || 0) + 1);
      const distinct = freq.size;
      const top = Array.from(freq.entries()).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, 5).map(([value, count]) => ({ value, count }));
      const out = { name: c.name, type: c.type, nulls, nullPct: n ? nulls / n : 0, distinct, top, samples: vals.slice(0, 3) };
      if (c.type === 'INTEGER' || c.type === 'DOUBLE') { let mn = Infinity; let mx = -Infinity; let sum = 0; for (const v of vals) { if (v < mn) mn = v; if (v > mx) mx = v; sum += v; } if (vals.length) { out.min = mn; out.max = mx; out.mean = sum / vals.length; out.sum = sum; } }
      if (c.type === 'DATE' || c.type === 'TIMESTAMP') { const s = vals.slice().sort(); if (s.length) { out.min = s[0]; out.max = s[s.length - 1]; } }
      if (c.type === 'TEXT') { out.lowCard = distinct > 0 && distinct <= Math.max(12, Math.min(60, n * 0.2)); }
      const ownKey = ci === 0 || c.name === 'id' || c.name === singular(table.name) + '_id';
      out.dupKeys = ownKey && /(^id$|_id$)/.test(c.name) && distinct < vals.length ? vals.length - distinct : 0;
      out.idLike = /(^id$|_id$)/.test(c.name) && distinct === vals.length && nulls === 0;
      return out;
    });
    const seen = new Set(); let dupRows = 0;
    for (const r of table.rows) { const k = JSON.stringify(r); if (seen.has(k)) dupRows++; else seen.add(k); }
    const injections = scanInjection(table);
    const warnings = [];
    if (dupRows) warnings.push(dupRows + ' exact duplicate row' + (dupRows === 1 ? '' : 's') + '.');
    cols.forEach((c) => { if (c.dupKeys) warnings.push(c.name + ' repeats ' + c.dupKeys + ' value(s); it is not a unique key.'); if (c.nulls && c.nullPct >= 0.01) warnings.push(c.name + ': ' + c.nulls + ' missing (' + Math.round(c.nullPct * 100) + '%).'); });
    if (injections.length) warnings.push(injections.length + ' cell(s) contain text that looks like instructions to an AI. They are treated as data and never followed.');
    return { table: table.name, rows: n, columns: cols, dupRows, injections, warnings };
  }

  function singular(w) { w = String(w || '').toLowerCase(); return /ies$/.test(w) ? w.slice(0, -3) + 'y' : /(ses|xes)$/.test(w) ? w.slice(0, -2) : /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w; }
  /* Schema summary used by the NL engine and the LLM prompt. */
  function schemaOf(tables) {
    return tables.map((t) => { const p = t.profile || profile(t); return { name: t.name, rows: t.rows.length, columns: t.columns.map((c, i) => Object.assign({ name: c.name, type: c.type }, { distinct: p.columns[i].distinct, nulls: p.columns[i].nulls, lowCard: !!p.columns[i].lowCard, idLike: p.columns[i].idLike, dupKeys: p.columns[i].dupKeys, min: p.columns[i].min, max: p.columns[i].max, values: c.type === 'TEXT' && !p.columns[i].idLike && p.columns[i].distinct <= 200 ? distinctValues(t, i, 200) : null, samples: p.columns[i].samples })), dupRows: p.dupRows }; });
  }
  function distinctValues(t, i, max) { const s = new Set(); for (const r of t.rows) { if (r[i] != null) s.add(r[i]); if (s.size > max) break; } return Array.from(s); }

  function toCsv(columns, rows) {
    const cell = (v) => { if (v == null) return ''; let s = String(v); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [columns.map(cell).join(',')].concat(rows.map((r) => r.map(cell).join(','))).join('\r\n') + '\r\n';
  }
  return { singular, MAX_ROWS, parseDelimited, sniffDelimiter, cleanName, tableNameFromFile, isNullish, parseNumber, parseDate, slashOrder, inferColumn, buildTable, fromDelimited, fromJson, fromObjects, looksLikeInjection, scanInjection, profile, schemaOf, toCsv };
});
