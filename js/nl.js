/* AskData demo engine: a deterministic, rule-based plain-English -> SQL translator that works over
   ANY loaded tables (no AI, no network). It understands a fixed set of question shapes: totals,
   averages, counts, min/max, top/bottom N, "which X has the most Y", by month/quarter/year trends,
   breakdowns and shares, comparisons (A vs B), filters on category values, numbers and dates,
   missing values, duplicates, and one-hop joins on shared *_id columns. It states its assumptions
   and abstains when a question falls outside those shapes. Pure functions (UMD). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.AskData = root.AskData || {}).nl = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const MON_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 };
  const STOP = new Set('a an the of in on at for to by per with and or is are was were be been do does did what which who whom whose how many much show list give me tell find get display all each every our my we i you it its this that these those there their from into than then as across over under above below more less most least top bottom best worst total sum average avg mean count number numbers highest lowest largest smallest biggest max min maximum minimum overall group grouped broken down split vs versus compare compared between trend over time monthly yearly quarterly weekly daily month year quarter week day since after before during last past this current recent latest have has had see please can could would like want data table tables rows row value values about any some get got made make placed generated sold bought brought did unique distinct different share percent percentage proportion breakdown distribution where when while order orders ordered missing excluding exclude except without not other non only just named called including include placed spent january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec q1 q2 q3 q4 vs versus versus. compare comparing'.split(' '));
  const pad = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function singular(w) { w = String(w || '').toLowerCase(); return /ies$/.test(w) ? w.slice(0, -3) + 'y' : /(ses|xes|ches|shes)$/.test(w) ? w.slice(0, -2) : /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w; }
  function plural(w) { w = String(w || '').toLowerCase(); return /y$/.test(w) && !/[aeiou]y$/.test(w) ? w.slice(0, -1) + 'ies' : /(s|x|ch|sh)$/.test(w) ? w + 'es' : w + 's'; }
  function wordRe(phrase) { return new RegExp('(^|[^a-z0-9_])(' + esc(phrase).replace(/\\? /g, '[\\s_-]+') + ')(?=$|[^a-z0-9_])', 'i'); }
  function findPhrase(q, phrase) { const m = wordRe(phrase).exec(q); return m ? { index: m.index + m[1].length, length: m[2].length } : null; }
  const isNum = (c) => c.type === 'INTEGER' || c.type === 'DOUBLE';
  const isDate = (c) => c.type === 'DATE' || c.type === 'TIMESTAMP';
  const MONEY_RE = /(total|amount|revenue|sales|price|cost|mrr|arr|spend|income|fee|value|gmv|profit|salary|payment|balance)/;
  function isMoney(name) { return MONEY_RE.test(String(name).toLowerCase()); }

  /* Synonyms for column names (looked up by regex on the column name). weight < 1 = weaker. */
  const SYN = [
    [/^(total|amount|order_total|order_amount|sales|revenue|gross|gmv|net_sales|total_amount|total_price|line_total|subtotal)$/, [['revenue', 1], ['sales', 1], ['income', 0.8], ['order value', 1.2], ['spend', 0.8], ['spent', 0.8], ['money', 0.6], ['amount', 1], ['total', 1], ['value', 0.5]]],
    [/(^|_)mrr$|recurring/, [['mrr', 2], ['monthly recurring revenue', 2], ['recurring revenue', 2], ['revenue', 0.6]]],
    [/(^|_)arr$/, [['arr', 2], ['annual recurring revenue', 2]]],
    [/price/, [['price', 1], ['expensive', 1], ['cheap', 1], ['cheapest', 1], ['priced', 1]]],
    [/cost/, [['cost', 1], ['costs', 1]]],
    [/(^|_)(qty|quantity|units?)$/, [['quantity', 1], ['units', 1], ['items', 0.8], ['qty', 1], ['units sold', 1.2], ['items sold', 1.2], ['pieces', 0.6]]],
    [/discount/, [['discount', 1], ['discounts', 1]]],
    [/churn/, [['churn', 1], ['churned', 1], ['cancellations', 0.6], ['lost', 0.5]]],
    [/^new_/, [['new', 0.6], ['signups', 0.9], ['sign ups', 0.9], ['acquired', 0.6], ['new accounts', 1.2], ['new customers', 0.8]]],
    [/^active_/, [['active', 0.8], ['active accounts', 1.2], ['accounts', 0.6], ['customers', 0.3]]],
    [/ticket/, [['tickets', 1], ['support tickets', 1.2], ['support', 0.6]]],
    [/(^|_)(status|state_code)$/, [['status', 1]]],
    [/channel|source/, [['channel', 1]]],
    [/region/, [['region', 1], ['regions', 1], ['area', 0.6]]],
    [/(^|_)state$/, [['state', 1], ['states', 1]]],
    [/category|type|segment/, [['category', 0.7], ['type', 0.6], ['kind', 0.5]]],
    [/(^|_)(name|product_name|customer_name|full_name|title)$/, [['name', 0.6]]],
    [/(^|_)email$/, [['email', 1], ['emails', 1], ['e-mail', 1]]]
  ];
  function columnPhrases(t, c) {
    const out = [];
    const base = c.name.replace(/_/g, ' ');
    out.push([base, 3]); if (plural(base) !== base) out.push([plural(base), 3]);
    if (/_id$/.test(c.name)) { const ent = c.name.replace(/_id$/, '').replace(/_/g, ' '); out.push([ent + ' id', 3]); out.push([ent + ' ids', 3]); }
    const parts = c.name.split('_').filter((p) => p.length > 2 && !['the', 'and', 'num', 'count'].includes(p));
    if (parts.length > 1) for (const p of parts) if (!/^(id|at|on|of|date|name)$/.test(p) && !STOP.has(p) && !/^(list|show|new|active|full|unit|net|gross)$/.test(p)) out.push([p, 0.5]);
    for (const [re, list] of SYN) if (re.test(c.name)) for (const [p, w] of list) out.push([p, w]);
    if (isDate(c)) { out.push(['date', 0.6]); out.push(['when', 0.3]); if (/order/.test(c.name)) out.push(['order date', 2]); }
    return out;
  }

  function buildIndex(schema) {
    const tables = schema.map((t) => {
      const tphr = new Set([t.name.replace(/_/g, ' '), singular(t.name.replace(/_/g, ' ')), plural(singular(t.name.replace(/_/g, ' ')))]);
      const parts = t.name.split('_'); if (parts.length > 1) parts.forEach((p) => { if (p.length > 3) tphr.add(p); });
      const label = t.columns.find((c) => c.type === 'TEXT' && /(^|_)(name|title|label)$/.test(c.name)) || t.columns.find((c) => c.type === 'TEXT' && !c.idLike && !/_id$/.test(c.name) && c.distinct > 1);
      const key = t.columns.find((c) => c.name === singular(t.name) + '_id') || t.columns.find((c) => c.name === 'id') || t.columns.find((c) => c.idLike);
      return Object.assign({}, t, { phrases: Array.from(tphr), label, key, dates: t.columns.filter(isDate) });
    });
    return { tables };
  }

  function sqlId(name) { return /^[a-z_][a-z0-9_]*$/.test(name) && !/^(select|from|where|group|order|by|limit|table|join|on|as|and|or|not|null|case|when|then|else|end|having|union|all|in|is|like|desc|asc|with|user|date|month|year|day|time|timestamp|key|default|values|offset|status|name|type|value|count|sum|min|max|avg|position|row|rows|range|first|last|level|left|right)$/.test(name) ? name : '"' + String(name).replace(/"/g, '""') + '"'; }
  function lit(v) { return typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'"; }
  const DIAL = {
    duckdb: { month: (c) => "strftime(" + c + ", '%Y-%m')", year: (c) => "strftime(" + c + ", '%Y')", day: (c) => "strftime(" + c + ", '%Y-%m-%d')", quarter: (c) => "strftime(" + c + ", '%Y') || '-Q' || CAST(quarter(" + c + ") AS VARCHAR)", week: (c) => "strftime(date_trunc('week', " + c + "), '%Y-%m-%d')" },
    sqlite: { month: (c) => "strftime('%Y-%m', " + c + ")", year: (c) => "strftime('%Y', " + c + ")", day: (c) => "date(" + c + ")", quarter: (c) => "strftime('%Y', " + c + ") || '-Q' || ((CAST(strftime('%m', " + c + ") AS INTEGER) + 2) / 3)", week: (c) => "date(" + c + ", '-6 days', 'weekday 1')" }
  };

  function addMonths(y, m, k) { const t = y * 12 + (m - 1) + k; return [Math.floor(t / 12), (t % 12) + 1]; }
  function lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

  /* ---------------- main ---------------- */
  function translate(question, schema, opts) {
    const o = opts || {};
    const dialect = DIAL[o.dialect] ? o.dialect : 'duckdb';
    const D = DIAL[dialect];
    const raw = String(question || '').trim();
    const q = ' ' + raw.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[?!]+$/, '').replace(/\s+/g, ' ') + ' ';
    const res = { question: raw, ok: false, sql: '', assumptions: [], ambiguities: [], chart: null, engine: 'demo rules' };
    if (!raw) return Object.assign(res, { abstain: 'Type a question first.' });
    if (!schema || !schema.length) return Object.assign(res, { abstain: 'Load a dataset first.' });
    // 1. Refuse writes, abstain on forecasts / causal questions.
    if (/\b(delete|drop|truncate|insert|update|alter|remove|erase|wipe|overwrite|modify|rename)\b/.test(q) && /\b(table|tables|rows?|records?|data|column|database|db|entries|values?)\b|\b(delete|drop|truncate|insert|update|alter)\b\s+\w/.test(q)) return Object.assign(res, { refused: true, abstain: 'This assistant is read-only. It never changes, deletes or adds data, so it will not write a query for that.' });
    if (/\b(predict|forecast|projection|project(ed)?|extrapolate|will\b.*\b(be|grow|increase|decrease|drop)|next (week|month|quarter|year)|going to)\b/.test(q)) return Object.assign(res, { abstain: 'That asks about the future. The data only describes what already happened, so I will not guess. Try a trend question such as "revenue by month".' });
    if (/^\s*(why|should|explain why)\b/.test(q)) return Object.assign(res, { abstain: 'A "why" question needs judgment beyond the data. I can show the numbers that might explain it, for example a breakdown by month or category.' });
    if (/\b(median|percentile|standard deviation|stddev|variance|correlat|regression)\b/.test(q)) return Object.assign(res, { abstain: 'The demo rules do not cover medians, percentiles, correlation or other statistics. Write the SQL yourself in the editor, or switch to your own AI model in Settings.' });

    const idx = buildIndex(schema);
    const used = []; // character ranges consumed by matches
    const claim = (index, length) => used.push([index, index + length]);
    const claimed = (i) => used.some(([a, b]) => i >= a && i < b);

    // 2. Mentions: tables, columns, values.
    const tableHits = [];
    for (const t of idx.tables) for (const p of t.phrases) { const m = findPhrase(q, p); if (m) tableHits.push({ t, m, score: p === t.name.replace(/_/g, ' ') ? 3 : 2 }); }
    const colHits = [];
    for (const t of idx.tables) for (const c of t.columns) for (const [p, w] of columnPhrases(t, c)) { const m = findPhrase(q, p); if (m) colHits.push({ t, c, m, w, phrase: p }); }
    const valHits = [];
    for (const t of idx.tables) for (const c of t.columns) {
      if (c.type !== 'TEXT' || !c.values) continue;
      for (const v of c.values) {
        const s = String(v).trim(); if (s.length < 2 || s.length > 40 || /^\d+$/.test(s)) continue;
        const m = findPhrase(q, s.toLowerCase()); if (m) valHits.push({ t, c, v, m });
        else if (s.length > 3) { const m2 = findPhrase(q, plural(s.toLowerCase())); if (m2) valHits.push({ t, c, v, m: m2 }); }
      }
    }
    // Longest value matches win; a value that is also exactly a column phrase is ignored ("status").
    valHits.sort((a, b) => b.m.length - a.m.length);
    const vals = [];
    for (const h of valHits) { if (vals.some((x) => h.m.index < x.m.index + x.m.length && x.m.index < h.m.index + h.m.length && x.c !== h.c)) continue; if (colHits.some((x) => x.m.index === h.m.index && x.m.length >= h.m.length && x.w >= 2)) continue; vals.push(h); }

    // 3. Intent words.
    const has = (re) => re.test(q);
    let agg = null;
    if (has(/\b(how many|number of|count of|count the|count|# of|how often)\b/)) agg = 'COUNT';
    if (has(/\b(average|avg|mean|typical|per order|aov)\b/)) agg = 'AVG';
    if (!agg && has(/\b(total|sum|overall|combined|altogether|in total)\b/)) agg = 'SUM';
    const superlativeHi = has(/\b(highest|largest|biggest|most|max|maximum|peak|top|best|greatest|most expensive)\b/);
    const superlativeLo = has(/\b(lowest|smallest|least|min|minimum|fewest|bottom|worst|cheapest|least expensive)\b/);
    const distinct = has(/\b(unique|distinct|different)\b/);
    // "which region has the most customers" -> count customers
    const mostT = /\b(?:the\s+)?(?:most|fewest|least|highest number of|lowest number of|more|fewer)\s+([a-z_]+)/.exec(q);
    let mostCountTable = null;
    if (mostT && !agg) { const w = singular(mostT[1]); const tt = schema.find((t) => singular(t.name) === w || singular(t.name.split('_').pop()) === w); if (tt) { agg = 'COUNT'; mostCountTable = tt.name; } }
    const share = has(/\b(share|percent|percentage|proportion|breakdown|distribution|split|mix)\b/);
    const compare = has(/\b(vs\.?|versus|compared? (to|with)|compare)\b/);
    const listy = has(/^\s*(show|list|display|give me|get|find|which|what are|print)\b/);
    let topN = null; let dir = 'DESC';
    let mt = /\b(top|best|highest|largest|biggest|bottom|worst|lowest|smallest)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\b/.exec(q);
    if (!mt) { const m2 = /\b(cheapest|priciest|most expensive|least expensive)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\b/.exec(q) || /\b(\d+|three|five|ten)\s+(cheapest|priciest|most expensive|least expensive|largest|biggest|smallest|best|worst)\b/.exec(q); if (m2) mt = /^\d|^[a-z]+$/.test(m2[1]) && NUMW[m2[1]] || /^\d+$/.test(m2[1]) ? [m2[0], m2[2], m2[1]] : [m2[0], m2[1], m2[2]]; }
    if (mt) { topN = NUMW[mt[2]] || parseInt(mt[2], 10); if (/bottom|worst|lowest|smallest|cheapest|least/.test(mt[1])) dir = 'ASC'; }
    if (!mt && superlativeLo && !superlativeHi) dir = 'ASC';
    const singularWhich = /\b(which|what)\s+(\w+)\s+(has|had|have|did|does|was|is|with|got|made|brought|generated|sold|placed|spent|drove)\b/.exec(q) || /\b(which|what)\s+(\w+)\b.*\b(the most|the highest|the largest|the biggest|the best|the least|the lowest|the fewest|most|least)\b/.exec(q);

    // time grain
    let grain = null;
    const gm = /\b(by|per|each|every|for each|over)\s+(day|week|month|quarter|year)\b/.exec(q) || /\b(daily|weekly|monthly|quarterly|yearly|annual|annually)\b/.exec(q);
    if (gm) { const w = gm[2] || gm[1]; grain = /day|daily/.test(w) ? 'day' : /week/.test(w) ? 'week' : /month/.test(w) ? 'month' : /quarter/.test(w) ? 'quarter' : 'year'; claim(gm.index, gm[0].length); }
    else if (has(/\b(trend|over time|month over month|mom|time series|timeline|each month|growth)\b/)) grain = 'month';

    // missing / duplicates
    const missing = /\b(missing|null|blank|empty|no|without(?: an?| any)?)\s+([a-z_ -]+?)(?=\s*$|\s+(?:in|for|by|and|from|on|at|with)\b|[,.])/.exec(q) && has(/\b(missing|null|blank|empty|without)\b/);
    const dupes = has(/\bduplicat/);

    // 4. Pick the measure column (numeric) and the base table.
    const numericHits = colHits.filter((h) => isNum(h.c) && !h.c.idLike && !/_id$/.test(h.c.name) && h.w >= 0.5);
    const scoreTable = (t) => tableHits.filter((h) => h.t === t).reduce((s, h) => s + h.score, 0) + colHits.filter((h) => h.t === t).reduce((s, h) => s + h.w * 0.5, 0) + vals.filter((h) => h.t === t).length;
    // When the question needs dates (a time grain or a date filter), prefer tables that have one (directly or via a shared *_id key).
    const needsDate = !!grain || has(/\b(19|20)\d{2}\b|\b(last|past|since|before|after|this|previous)\s+(\d+\s+)?(days?|weeks?|months?|quarters?|years?|[0-9]{4})\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
    const isDated = (t) => t.columns.some((c) => c.type === 'DATE' || c.type === 'TIMESTAMP');
    const dateFit = (t) => (!needsDate ? 0 : isDated(t) ? 2 : idx.tables.some((o) => o !== t && isDated(o) && o.columns.some((oc) => /_id$/.test(oc.name) && t.columns.some((tc) => tc.name === oc.name))) ? 1 : 0);
    // Prefer measure tables that are named in the question or join to a named table / matched value ("top products by revenue").
    const shareKey = (a, b) => a.columns.some((ac) => /_id$/.test(ac.name) && b.columns.some((bc) => bc.name === ac.name));
    const named = new Set(tableHits.map((h) => h.t).concat(vals.map((h) => h.t)));
    const linkFit = (t) => (named.has(t) ? 2 : Array.from(named).some((o) => shareKey(t, o)) ? 1 : 0);
    // "total qty": a leading "total"/"sum" is the aggregate, not the column called total, when another numeric column is named after it.
    const ew = (h) => (/^(total|sum)$/.test(h.phrase) && numericHits.some((o) => o.c !== h.c && o.m.index > h.m.index) ? Math.min(h.w, 0.4) : h.w);
    let measure = null;
    if (numericHits.length) {
      const best = numericHits.slice().sort((a, b) => ew(b) - ew(a) || dateFit(b.t) - dateFit(a.t) || linkFit(b.t) - linkFit(a.t) || b.m.length - a.m.length || scoreTable(b.t) - scoreTable(a.t))[0];
      const rivals = numericHits.filter((h) => h.phrase === best.phrase && h.c !== best.c);
      measure = best;
      if (rivals.length) {
        const pref = rivals.concat([best]).sort((a, b) => ew(b) - ew(a) || dateFit(b.t) - dateFit(a.t) || linkFit(b.t) - linkFit(a.t) || scoreTable(b.t) - scoreTable(a.t))[0];
        measure = pref;
        const others = rivals.concat([best]).filter((h) => h !== pref);
        res.ambiguities.push('"' + best.phrase + '" could mean ' + [pref].concat(others).map((h) => h.t.name + '.' + h.c.name).join(' or ') + '. I used ' + pref.t.name + '.' + pref.c.name + '; name the column to pick another.');
      }
      claim(measure.m.index, measure.m.length);
    }

    // Count target: "how many <thing>" -> table, or a numeric column that already counts things.
    let countTable = null; let countSumCol = null;
    if (agg === 'COUNT') {
      const cm = /\b(?:how many|number of|count of|count the|count|# of)\s+(?:the\s+|unique\s+|distinct\s+|different\s+)?([a-z_]+(?:\s+[a-z_]+)?)/.exec(q);
      const word = cm ? cm[1] : '';
      const w1 = word.split(' ')[0];
      const numericCountCol = numericHits.find((h) => (findPhrase(word, h.phrase) && h.w >= 0.8) || (w1.length > 3 && h.c.name.split('_').includes(plural(singular(w1)))));
      if (numericCountCol) { countSumCol = numericCountCol; measure = numericCountCol; agg = 'SUM'; res.assumptions.push('"' + (cm ? cm[0].trim() : 'how many') + '" is read as the sum of ' + numericCountCol.t.name + '.' + numericCountCol.c.name + ', because that column already holds counts.'); }
      else {
        const th = mostCountTable ? { t: idx.tables.find((t) => t.name === mostCountTable) } : tableHits.find((h) => findPhrase(word, singular(h.t.name.replace(/_/g, ' '))) || findPhrase(word, h.t.name.replace(/_/g, ' ')) || findPhrase(singular(w1), singular(h.t.name.split('_').pop())));
        if (th) countTable = th.t;
        measure = null;
      }
    }

    // Base table
    let base = null;
    if (measure) base = measure.t;
    else if (countTable) {
      base = countTable;
      // "how many customers placed orders in 2026": count distinct keys in the table that records the activity.
      const other = tableHits.map((h) => h.t).find((t) => t !== countTable && countTable.key && t.columns.some((c) => c.name === countTable.key.name) && t.key !== countTable.key);
      if (other && /\b(placed|made|bought|ordered|purchased|with|who|that|had|have|did)\b/.test(q)) { base = other; res.assumptions.push('Counted distinct ' + countTable.key.name + ' values in ' + other.name + ', i.e. ' + countTable.name + ' that appear in ' + other.name + '.'); }
    }
    else {
      const cands = idx.tables.map((t) => ({ t, s: scoreTable(t) })).sort((a, b) => b.s - a.s);
      if (cands[0] && cands[0].s > 0) base = cands[0].t;
    }
    // Entities other than base that the question groups by, e.g. "top customers".
    const tablesById = new Map(idx.tables.map((t) => [t.name, t]));

    // Default measure for "top products", "best region", "revenue" style questions with no numeric mention.
    const wantsMeasure = (agg && agg !== 'COUNT') || topN || singularWhich || superlativeHi || superlativeLo;
    if (!measure && agg !== 'COUNT' && wantsMeasure && !dupes && !missing) {
      // Look for a money column in any table that links to the grouped entity.
      const moneyCols = [];
      for (const t of idx.tables) for (const c of t.columns) if (isNum(c) && /^(total|amount|revenue|sales|order_total|total_amount|gmv|net_sales)$/.test(c.name)) moneyCols.push({ t, c });
      const prefer = moneyCols.find((h) => base && (h.t === base || linkBetween(h.t, base))) || moneyCols[0];
      if (prefer && (topN || singularWhich || has(/\b(best|top|most|biggest|worst)\b/))) {
        measure = { t: prefer.t, c: prefer.c, phrase: 'revenue', defaulted: true };
        if (agg !== 'AVG') agg = 'SUM';
        res.assumptions.push('Ranked by revenue (sum of ' + prefer.t.name + '.' + prefer.c.name + ') because the question did not name a number to rank by.');
        if (!base || !linkBetween(prefer.t, base) && prefer.t !== base) base = prefer.t; else base = prefer.t;
      } else if (prefer && !agg && has(/\b(revenue|sales)\b/)) { measure = { t: prefer.t, c: prefer.c, phrase: 'revenue' }; base = prefer.t; }
    }
    if (!base) {
      const unknown = contentWords(q, colHits, tableHits, vals);
      return Object.assign(res, { abstain: 'I could not match this question to the loaded tables' + (unknown.length ? ' (no column or value for: ' + unknown.slice(0, 5).join(', ') + ')' : '') + '. Loaded: ' + idx.tables.map((t) => t.name + ' (' + t.columns.slice(0, 8).map((c) => c.name).join(', ') + (t.columns.length > 8 ? ', …' : '') + ')').join('; ') + '.' });
    }
    if (measure && measure.t !== base) base = measure.t;
    if (!agg && measure && !listy) agg = 'SUM';
    if (!agg && measure && (grain || singularWhich || topN || /\b(by|per|for each|across)\b/.test(q))) agg = 'SUM';
    if (!agg && measure && listy && !(superlativeHi || superlativeLo) && !topN && !grain) agg = null;
    if ((agg === 'SUM' || agg === 'AVG' || agg === 'MIN' || agg === 'MAX') && !measure) {
      const unknown = contentWords(q, colHits, tableHits, vals);
      return Object.assign(res, { abstain: 'I could not find the number to ' + (agg === 'AVG' ? 'average' : 'total') + (unknown.length ? ': nothing in the data matches "' + unknown.slice(0, 3).join(' ') + '"' : '') + '. Numeric columns in ' + base.name + ': ' + (base.columns.filter((c) => isNum(c) && !c.idLike).map((c) => c.name).join(', ') || 'none') + '.' });
    }

    // "most expensive product": rank rows of the measure's own table.
    let selfRank = null;
    if (measure && !measure.defaulted && (superlativeHi || superlativeLo) && !has(/\b(total|sum|average|avg|mean|by|per|each)\b/) && tableHits.some((h) => h.t === measure.t) && measure.t.label) { selfRank = { t: measure.t, c: measure.t.label, entity: true, self: true, noGroup: true }; agg = null; }

    // 5. Aliases and joins.
    const aliasOf = new Map();
    const usedAliases = new Set();
    function alias(t) { if (aliasOf.has(t.name)) return aliasOf.get(t.name); let a = t.name.split('_').map((p) => p[0]).join('').slice(0, 3) || 't'; if (/^(as|on|or|in|is|by|to|do|if|of|at)$/.test(a)) a = a + 't'; let k = 2; let b = a; while (usedAliases.has(b)) b = a + k++; usedAliases.add(b); aliasOf.set(t.name, b); return b; }
    const joins = [];
    function linkBetween(a, b) {
      if (!a || !b || a === b) return null;
      if (b.key && a.columns.some((c) => c.name === b.key.name)) return { from: a, to: b, col: b.key.name };
      if (a.key && b.columns.some((c) => c.name === a.key.name)) return { from: a, to: b, col: a.key.name, reverse: true };
      return null;
    }
    function ensureJoin(t) {
      if (t === base || joins.some((j) => j.to === t)) return true;
      const l = linkBetween(base, t);
      if (!l) return false;
      joins.push(l); return true;
    }
    const multi = () => joins.length > 0;
    // Column references are resolved at the end, once every join is known.
    const col = (t, c) => '\u0001' + t.name + '\u0002' + (c.name || c) + '\u0003';
    const resolve = (sql) => sql.replace(/\u0001([^\u0002]+)\u0002([^\u0003]+)\u0003/g, (x, tn, cn) => (multi() ? alias(tablesById.get(tn)) + '.' : '') + sqlId(cn));

    // 6. Dimension (group by).
    let dim = null; // { t, c, label, entity }
    const dimMatch = /\b(?:by|per|for each|for every|each|across|grouped by|broken down by|split by|within)\s+([a-z_ ]+?)(?=\s*$|\s+(?:in|for|during|since|after|before|between|from|where|with|and|over|last|this|excluding|except|without|vs|versus|that|who|which|on)\b|[,.])/.exec(q);
    const topEntity = /\b(?:top|best|bottom|worst|highest|lowest)\s+(?:\d+\s+|one\s+|two\s+|three\s+|four\s+|five\s+|six\s+|seven\s+|eight\s+|nine\s+|ten\s+|twelve\s+|fifteen\s+|twenty\s+)?([a-z_]+(?:\s+[a-z_]+)?)/.exec(q);
    const candidates = [];
    if (dimMatch) candidates.push(dimMatch[1].trim());
    if (topEntity) candidates.push(topEntity[1].trim());
    if (singularWhich) candidates.push(singularWhich[2]);
    const compareVals = compare ? groupValues(vals) : null;
    for (const cand of candidates) {
      if (!cand || /^(month|year|quarter|week|day|date|time)s?$/.test(cand)) continue;
      const d = resolveDim(cand);
      if (d) { dim = d; break; }
    }
    function resolveDim(phrase) {
      const words = phrase.split(' ');
      for (let n = words.length; n >= 1; n--) {
        const p = words.slice(0, n).join(' ');
        // a column in base or a linked table
        const hits = colHits.filter((h) => (findPhrase(p, h.phrase) || findPhrase(h.phrase, p)) && !isNum(h.c) && (h.c.type === 'TEXT' || isDate(h.c))).sort((a, b) => (b.t === base) - (a.t === base) || b.w - a.w);
        for (const h of hits) { if (isDate(h.c)) continue; if (h.t === base || linkBetween(base, h.t)) { if (/_id$/.test(h.c.name) && !h.c.lowCard) { const ent = idx.tables.find((t) => t.key && t.key.name === h.c.name && t !== base); if (ent && ent.label) return { t: ent, c: ent.label, entity: true, keyCol: h.c }; } return { t: h.t, c: h.c }; } }
        // an entity table: group by its label
        const et = idx.tables.find((t) => t.phrases.some((tp) => singular(tp) === singular(p)));
        if (et && et.label) {
          if (et === base) return { t: et, c: et.label, entity: true, self: true };
          if (linkBetween(base, et)) return { t: et, c: et.label, entity: true };
          // entity can be grouped through its key in base table
          if (et.key && base.columns.some((c) => c.name === et.key.name)) return { t: et, c: et.label, entity: true };
        }
      }
      return null;
    }
    if (selfRank) { dim = selfRank; if (!topN) topN = /\b(products|items|customers|rows|ones)\b/.test(q) ? 5 : 1; }
    if (!dim && compareVals) dim = { t: compareVals.t, c: compareVals.c, compare: true };
    if (!dim && share && !grain) {
      // "share of orders by status" handled above; "status breakdown" -> column before the word
      const sm = /([a-z_]+)\s+(breakdown|distribution|split|mix|share)/.exec(q);
      if (sm) dim = resolveDim(sm[1]);
      if (!dim && vals.length) dim = { t: vals[0].t, c: vals[0].c };
    }
    if (dim && dim.t !== base && !ensureJoin(dim.t)) {
      return Object.assign(res, { abstain: 'I could not find a way to link ' + base.name + ' to ' + dim.t.name + ' (no shared *_id column). Try asking about one table at a time.' });
    }
    if (dim && dim.self && (agg === 'SUM' || agg === 'AVG' || !agg) && measure && measure.t === base) dim.noGroup = true;

    // 7. Filters.
    const where = [];
    // category values (skip ones used as comparison groups -> IN list)
    const valueGroups = groupValuesAll(vals);
    for (const g of valueGroups) {
      if (dim && dim.compare && g.c === dim.c && g.t === dim.t) continue;
      if (dim && g.c === dim.c && dim.t === g.t && !compare) {
        // "revenue by channel for Web and Mobile" - still filter
        if (g.values.length >= 1 && !share && !singularWhich && !topN) { /* keep as filter */ } else continue;
      }
      if (g.t !== base && !ensureJoin(g.t)) { res.ambiguities.push('Ignored "' + g.values.join(', ') + '" (in ' + g.t.name + ', which does not link to ' + base.name + ').'); continue; }
      const neg = g.hits.some((h) => new RegExp('\\b(not|excluding|exclude|except|without|other than|non)[\\s-]+(\\w+\\s+){0,2}' + esc(String(h.m && q.substr(h.m.index, h.m.length))) ).test(q));
      if (g.values.length === 1) where.push(col(g.t, g.c) + (neg ? ' <> ' : ' = ') + lit(g.values[0]));
      else where.push(col(g.t, g.c) + (neg ? ' NOT IN (' : ' IN (') + g.values.map(lit).join(', ') + ')');
      g.hits.forEach((h) => claim(h.m.index, h.m.length));
    }
    if (dim && dim.compare) where.push(col(dim.t, dim.c) + ' IN (' + compareVals.values.map(lit).join(', ') + ')');

    // numeric filters
    const numRe = /\b(over|above|more than|greater than|at least|exceeding|under|below|less than|fewer than|at most|>=|<=|>|<)\s*(\$|usd\s*)?(\d[\d,]*(?:\.\d+)?)(k)?\b/g;
    let nm;
    while ((nm = numRe.exec(q))) {
      const n = parseFloat(nm[3].replace(/,/g, '')) * (nm[4] ? 1000 : 1);
      const op = /over|above|more|greater|exceed|^>$/.test(nm[1]) ? '>' : /at least|>=/.test(nm[1]) ? '>=' : /at most|<=/.test(nm[1]) ? '<=' : '<';
      // column: nearest numeric mention before the number, else measure, else a money column if "$"
      const before = numericHits.filter((h) => h.m.index < nm.index && h.t === base).sort((a, b) => b.m.index - a.m.index)[0] || numericHits.filter((h) => h.m.index > nm.index && h.t === base)[0];
      let target = before ? before : null;
      if (!target && (nm[2] || /\b(orders?|purchases?|sales?)\b/.test(q))) { const mc = base.columns.find((c) => isNum(c) && /^(total|amount|revenue|sales|order_total|total_amount)$/.test(c.name)) || base.columns.find((c) => isNum(c) && isMoney(c.name)); if (mc) target = { t: base, c: mc }; }
      if (!target && measure) target = measure;
      if (!target) continue;
      const isAggFilter = dim && !dim.noGroup && measure && target.c === measure.c && /\b(with|having)\b.{0,30}(more|over|above|less|under|at least)/.test(q) && agg;
      if (isAggFilter) res.having = (res.having || []).concat([{ op, n }]);
      else where.push(col(target.t, target.c) + ' ' + op + ' ' + n);
      claim(nm.index, nm[0].length);
      if (target !== measure && before) claim(before.m.index, before.m.length);
    }

    // date filters
    let dateCol = null; let dateT = base;
    function pickDate() {
      if (dateCol) return dateCol;
      let cands = base.dates;
      let t = base;
      if (!cands.length) {
        for (const j of joins) if (j.to.dates.length) { cands = j.to.dates; t = j.to; break; }
        if (!cands.length) { const lt = idx.tables.find((x) => x.dates.length && linkBetween(base, x)); if (lt) { ensureJoin(lt); cands = lt.dates; t = lt; } }
      }
      if (!cands.length) return null;
      const mentioned = colHits.find((h) => isDate(h.c) && cands.includes(h.c) && h.w >= 2);
      dateCol = mentioned ? mentioned.c : (cands.find((c) => /order|created|date|month|day|time|_at$/.test(c.name) && !/signup|birth|launch|updated/.test(c.name)) || cands[0]);
      dateT = t;
      if (cands.length > 1 && !mentioned) res.assumptions.push('Used ' + t.name + '.' + dateCol.name + ' as the date (other date columns: ' + cands.filter((c) => c !== dateCol).map((c) => c.name).join(', ') + ').');
      return dateCol;
    }
    const dateConds = [];
    const isoRange = (a, b) => { const c = pickDate(); if (!c) return false; const e = () => col(dateT, c); if (a) dateConds.push(e() + " >= '" + a + "'"); if (b) dateConds.push(e() + " < '" + b + "'"); return true; };
    const monIdx = (s) => MONTHS.findIndex((m) => m.startsWith(s.slice(0, 3))) + 1;
    let dm;
    const maxDate = () => { const c = pickDate(); return c && c.max ? String(c.max).slice(0, 10) : null; };
    if ((dm = /\bbetween\s+(\d{4}-\d{2}-\d{2})\s+and\s+(\d{4}-\d{2}-\d{2})\b/.exec(q))) { const [y, m, d] = dm[2].split('-').map(Number); const nx = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10); if (isoRange(dm[1], nx)) { claim(dm.index, dm[0].length); res.assumptions.push('Both dates are included.'); } }
    else if ((dm = new RegExp('\\b(?:in\\s+|during\\s+|for\\s+)?' + MON_RE + '\\s+(\\d{4})\\b').exec(q))) { const mo = monIdx(dm[1]); const y = +dm[2]; const [ny, nmo] = addMonths(y, mo, 1); if (isoRange(y + '-' + pad(mo) + '-01', ny + '-' + pad(nmo) + '-01')) claim(dm.index, dm[0].length); }
    else if ((dm = /\bq([1-4])\s*(?:of\s+)?(\d{4})\b/.exec(q))) { const y = +dm[2]; const mo = (+dm[1] - 1) * 3 + 1; const [ny, nmo] = addMonths(y, mo, 3); if (isoRange(y + '-' + pad(mo) + '-01', ny + '-' + pad(nmo) + '-01')) claim(dm.index, dm[0].length); }
    else if ((dm = /\b(since|after|from|before|until|through)\s+(\d{4}-\d{2}-\d{2}|\d{4})\b/.exec(q))) { const v = dm[2].length === 4 ? (/before|until/.test(dm[1]) ? dm[2] + '-01-01' : dm[1] === 'through' ? (+dm[2] + 1) + '-01-01' : dm[2] + '-01-01') : dm[2]; const after = /since|after|from/.test(dm[1]); let a = after ? v : null; if (dm[1] === 'after' && dm[2].length === 4) a = (+dm[2] + 1) + '-01-01'; if (isoRange(a, after ? null : v)) claim(dm.index, dm[0].length); }
    else if ((dm = /\b(?:in|during|for|of)?\s*(19\d{2}|20\d{2})\b/.exec(q)) && !/\b(19|20)\d{2}-\d/.test(q)) { const y = +dm[1]; if (isoRange(y + '-01-01', (y + 1) + '-01-01')) claim(dm.index, dm[0].length); }
    if ((dm = /\b(?:in the |over the |during the )?(last|past|previous|recent)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)?\s*(day|week|month|quarter|year)s?\b/.exec(q))) {
      const n = dm[2] ? (NUMW[dm[2]] || parseInt(dm[2], 10)) : 1; const unit = dm[3]; const mx = maxDate();
      if (mx) {
        const [y, m, d] = mx.split('-').map(Number); let from;
        if (unit === 'day' || unit === 'week') { const days = unit === 'day' ? n : n * 7; from = new Date(Date.UTC(y, m - 1, d - days + 1)).toISOString().slice(0, 10); }
        else { const months = unit === 'month' ? n : unit === 'quarter' ? n * 3 : n * 12; const [fy, fm] = addMonths(y, m, -(months - 1)); from = fy + '-' + pad(fm) + '-01'; }
        const nx = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
        isoRange(from, nx); claim(dm.index, dm[0].length);
        res.assumptions.push('"' + dm[0].trim() + '" is counted back from the latest date in the data (' + mx + '), not from today' + (unit === 'month' || unit === 'quarter' || unit === 'year' ? ', in whole calendar months including the latest one' : '') + ': ' + from + ' to ' + mx + '.');
      }
    } else if ((dm = /\b(this|current)\s+(year|month)\b/.exec(q))) { const mx = maxDate(); if (mx) { const [y, m] = mx.split('-').map(Number); if (dm[2] === 'year') isoRange(y + '-01-01', (y + 1) + '-01-01'); else { const [ny, nmo] = addMonths(y, m, 1); isoRange(y + '-' + pad(m) + '-01', ny + '-' + pad(nmo) + '-01'); } res.assumptions.push('"' + dm[0] + '" means the latest ' + dm[2] + ' in the data (' + mx.slice(0, dm[2] === 'year' ? 4 : 7) + '), not the calendar today.'); } }
    where.push(...dateConds);

    // missing values
    if (missing) {
      const mm = /\b(?:missing|null|blank|empty|without|no)\s+(?:an?\s+|any\s+|the\s+)?([a-z_ -]+?)(?=\s*$|\s+(?:in|for|by|and|from|on|at|with)\b|[,.])/.exec(q);
      const target = mm && colHits.filter((h) => findPhrase(mm[1], h.phrase) && (h.t === base || linkBetween(base, h.t))).sort((a, b) => b.w - a.w)[0];
      if (target) { if (target.t !== base) ensureJoin(target.t); where.push(col(target.t, target.c) + ' IS NULL'); res.assumptions.push('Empty cells and placeholders such as "N/A" were stored as NULL when the file was loaded, so "missing" means NULL.'); if (!agg) agg = 'COUNT'; }
      else return Object.assign(res, { abstain: 'I could not tell which column should be missing. Name the column, for example "how many customers are missing an email".' });
    }

    // 8. Assemble.
    const from = sqlId(base.name) + (multi() ? ' ' + alias(base) : '');
    const joinSql = joins.map((j) => 'JOIN ' + sqlId(j.to.name) + ' ' + alias(j.to) + ' ON ' + alias(base) + '.' + sqlId(j.col) + ' = ' + alias(j.to) + '.' + sqlId(j.col));
    // Re-derive expressions now that join state is final.
    const m = measure ? col(measure.t, measure.c) : null;
    const measureAlias = measure ? aliasFor(agg, measure, q) : null;
    let select = []; let group = []; let order = ''; let limit = topN || null; let chart = null;
    const aggExpr = () => {
      if (agg === 'COUNT') {
        if (distinct) { const dc = (colHits.find((h) => (h.t === base || joins.some((j) => j.to === h.t)) && !isNum(h.c) && h.w >= 1 && /_id$|name|email/.test(h.c.name)) || {}).c || (countTable && countTable !== base && countTable.key) || base.key; if (dc) return 'COUNT(DISTINCT ' + col(base, dc) + ')'; }
        if (countTable && countTable !== base && countTable.key && base.columns.some((c) => c.name === countTable.key.name)) return 'COUNT(DISTINCT ' + col(base, countTable.key) + ')';
        return 'COUNT(*)';
      }
      if (!m) return 'COUNT(*)';
      const inner = agg + '(' + m + ')';
      return (agg === 'AVG' || (measure.c.type === 'DOUBLE' && agg === 'SUM')) ? 'ROUND(' + inner + ', 2)' : inner;
    };
    const countAlias = () => { const t = countTable || base; return (distinct || (countTable && countTable !== base) ? 'unique_' : '') + plural(singular(t.name.split('_').pop())); };
    const valAlias = agg === 'COUNT' || !measure ? (missing ? 'missing_count' : countAlias()) : measureAlias;

    if (dupes) {
      const dc = (colHits.find((h) => h.t === base && (/_id$|^id$|email|name/.test(h.c.name))) || {}).c || base.key || base.columns[0];
      res.sql = 'SELECT ' + sqlId(dc.name) + ', COUNT(*) AS copies\nFROM ' + sqlId(base.name) + (where.length ? '\nWHERE ' + where.join('\n  AND ') : '') + '\nGROUP BY ' + sqlId(dc.name) + '\nHAVING COUNT(*) > 1\nORDER BY copies DESC, ' + sqlId(dc.name);
      res.ok = true; res.chart = { type: 'table' }; res.title = 'Duplicate ' + dc.name + ' values in ' + base.name;
      if (base.dupRows) res.assumptions.push(base.name + ' has ' + base.dupRows + ' exact duplicate row(s) in total.');
      return finish(res, base, measure, joins, idx);
    }

    if (grain) {
      const dc = pickDate();
      if (!dc) return Object.assign(res, { abstain: 'There is no date column in ' + base.name + ' (or a table linked to it), so I cannot group by ' + grain + '.' });
      // date conditions may have added a join after `from` was computed; rebuild below
      const bucket = D[grain](col(dateT, dc));
      select.push(bucket + ' AS ' + grain); group.push(bucket);
      if (dim && !dim.noGroup) { select.push(col(dim.t, dim.c) + (dimAlias(dim) === dim.c.name ? '' : ' AS ' + sqlId(dimAlias(dim)))); group.push(col(dim.t, dim.c)); }
      select.push(aggExpr() + ' AS ' + sqlId(valAlias));
      order = grain + (dim ? ', ' + sqlId(dimAlias(dim)) : '');
      chart = { type: 'line', x: grain, y: valAlias, series: dim ? dimAlias(dim) : null };
      if (topN && !dim) { order = sqlId(valAlias) + ' ' + dir; chart = { type: 'bar', x: grain, y: valAlias }; }
    } else if (dim && dim.noGroup) {
      // Ranking rows of the entity table itself, e.g. "top 5 products by list price".
      select.push(col(dim.t, dim.c)); if (m) select.push(m);
      order = (m || col(dim.t, dim.c)) + ' ' + dir; where.push((m || col(dim.t, dim.c)) + ' IS NOT NULL'); limit = limit || (singularWhich ? 1 : 10);
      chart = { type: 'bar', x: dim.c.name, y: measure ? measure.c.name : null };
    } else if (dim) {
      const label = col(dim.t, dim.c);
      select.push(label + (dimAlias(dim) === dim.c.name ? '' : ' AS ' + sqlId(dimAlias(dim))));
      group.push(dim.entity && dim.t !== base ? col(dim.t, dim.t.key) + ', ' + label : label);
      select.push(aggExpr() + ' AS ' + sqlId(valAlias));
      if (share) select.push('ROUND(100.0 * ' + aggExpr() + ' / SUM(' + aggExpr() + ') OVER (), 1) AS pct');
      order = sqlId(valAlias) + ' ' + dir;
      if (!limit && singularWhich && !/\b(which|what)\s+\w+s\b/.test(q)) limit = 1;
      chart = { type: share ? 'pie' : 'bar', x: dimAlias(dim), y: valAlias };
      if (singularWhich && limit === 1) chart = { type: 'table' };
    } else if (agg) {
      select.push(aggExpr() + ' AS ' + sqlId(valAlias));
      chart = { type: 'kpi', y: valAlias };
      if (superlativeHi && !/\b(total|sum|average|avg|count|how many)\b/.test(q) && measure && !agg) select[0] = 'MAX(' + m + ') AS ' + sqlId('max_' + measure.c.name);
    } else if (measure && (superlativeHi || superlativeLo)) {
      const which = superlativeLo && !superlativeHi ? 'MIN' : 'MAX';
      select.push(which + '(' + m + ') AS ' + sqlId(which.toLowerCase() + '_' + measure.c.name)); chart = { type: 'kpi', y: which.toLowerCase() + '_' + measure.c.name };
    } else {
      // plain listing
      select.push(multi() ? alias(base) + '.*' : '*');
      if (measure) { order = m + ' ' + dir; }
      limit = topN || 50;
      chart = { type: 'table' };
      res.assumptions.push('Showing matching rows (up to ' + limit + ').');
    }
    if (res.having && group.length) res.havingSql = res.having.map((h) => aggExpr() + ' ' + h.op + ' ' + h.n).join(' AND ');
    const fromNow = sqlId(base.name) + (multi() ? ' ' + alias(base) : '');
    const joinNow = joins.map((j) => 'JOIN ' + sqlId(j.to.name) + ' ' + alias(j.to) + ' ON ' + alias(base) + '.' + sqlId(j.col) + ' = ' + alias(j.to) + '.' + sqlId(j.col));
    void from; void joinSql;
    let sql = 'SELECT ' + select.join(',\n       ') + '\nFROM ' + fromNow + (joinNow.length ? '\n' + joinNow.join('\n') : '') + (where.length ? '\nWHERE ' + where.join('\n  AND ') : '') + (group.length ? '\nGROUP BY ' + group.join(', ') : '') + (res.havingSql ? '\nHAVING ' + res.havingSql : '') + (order ? '\nORDER BY ' + order : '') + (limit ? '\nLIMIT ' + limit : '');
    res.sql = resolve(sql); res.ok = true; res.chart = chart;
    res.title = raw.replace(/\?+$/, '');
    if (share && dim) res.assumptions.push('pct is each group\u2019s share of the total across the groups shown.');
    if (dim && dim.entity && !dim.self) res.assumptions.push('Grouped by ' + dim.t.name + '.' + dim.t.key.name + ' and shown by ' + dim.c.name + ' (names can repeat, ids cannot).');
    if (topN == null && limit === 1) res.assumptions.push('Shows only the top result; ask for "top 5" to see more.');
    delete res.having; delete res.havingSql;
    return finish(res, base, measure, joins, idx, agg, q, vals, colHits, tableHits);

    function dimAlias(d) { if (d.entity && !d.self) return singular(d.t.name.split('_').pop()); return d.c.name; }
  }

  function aliasFor(agg, measure, q) {
    const c = measure.c.name;
    const word = measure.phrase && /revenue|sales|spend|income|order value/.test(measure.phrase) && !/^(revenue|sales)$/.test(c) ? measure.phrase.replace(/\s+/g, '_') : null;
    if (agg === 'AVG') return 'avg_' + (word || c);
    if (agg === 'MAX') return 'max_' + c;
    if (agg === 'MIN') return 'min_' + c;
    if (word) return word === 'order_value' ? 'order_value' : word;
    if (/^(total|amount)$/.test(c)) return 'total_' + (/revenue/.test(q) ? 'revenue' : c === 'total' ? 'amount' : c);
    return 'total_' + c;
  }
  function groupValues(vals) { const g = groupValuesAll(vals).filter((x) => x.values.length >= 2).sort((a, b) => b.values.length - a.values.length); return g[0] || null; }
  function groupValuesAll(vals) {
    const map = new Map();
    for (const h of vals) { const k = h.t.name + '.' + h.c.name; if (!map.has(k)) map.set(k, { t: h.t, c: h.c, values: [], hits: [] }); const g = map.get(k); if (!g.values.includes(h.v)) { g.values.push(h.v); g.hits.push(h); } }
    return Array.from(map.values());
  }
  function contentWords(q, colHits, tableHits, vals) {
    const words = q.replace(/[^a-z0-9_$ -]/g, ' ').split(/\s+/).filter(Boolean);
    const covered = (w) => colHits.some((h) => h.phrase.split(' ').includes(w)) || tableHits.some((h) => h.t.phrases.some((p) => p.split(' ').includes(w))) || vals.some((h) => String(h.v).toLowerCase().split(' ').includes(w));
    return words.filter((w) => w.length > 2 && !STOP.has(w) && !/^[\d$]/.test(w) && !covered(w) && !covered(singular(w)));
  }
  function finish(res, base, measure, joins, idx, agg, q, vals, colHits, tableHits) {
    if (measure && measure.c && measure.c.nulls && /SUM|AVG|MAX|MIN/.test(res.sql)) res.assumptions.push(measure.c.nulls + ' row(s) have no ' + measure.c.name + '; SQL ' + (/AVG/.test(res.sql) ? 'AVG' : 'SUM') + ' skips them.');
    if (base.dupRows && !/HAVING COUNT\(\*\) > 1/.test(res.sql)) res.assumptions.push(base.name + ' contains ' + base.dupRows + ' exact duplicate row(s); they are counted as they are. Ask "find duplicate ' + (base.key ? base.key.name.replace(/_/g, ' ') + 's' : 'rows') + '" to see them.');
    const st = base.columns.find((c) => c.name === 'status' && c.values && c.values.some((v) => /cancel|refund|return|void/i.test(v)));
    if (st && measure && /revenue|sales|total|amount/i.test(measure.c.name + ' ' + (measure.phrase || '')) && !/status/.test(res.sql)) res.assumptions.push('Includes every status (also ' + st.values.filter((v) => /cancel|refund|return|void/i.test(v)).join(', ') + '). Add "excluding cancelled" to leave those out.');
    if (q && colHits) { const unknown = contentWords(q, colHits, tableHits, vals).filter((w) => !/^(revenue|sales|customers?|products?|orders?)$/.test(w)); if (unknown.length) res.ambiguities.push('Words I could not map to the data and ignored: ' + unknown.slice(0, 6).join(', ') + '.'); }
    return res;
  }
  /* Sample questions the demo engine handles, for the default demo tables. */
  const SAMPLES = [
    'What is the total revenue?',
    'Revenue by month',
    'Top 5 products by revenue',
    'Revenue by region in 2026',
    'How many orders were cancelled?',
    'Average order value by channel',
    'Share of orders by status',
    'Compare Web vs Mobile revenue',
    'How many customers are missing an email?',
    'MRR by plan over time',
    'Which plan had the most churned accounts in 2025?',
    'Find duplicate order ids',
    'Show orders over $700',
    'Delete all cancelled orders',
    'Will revenue grow next quarter?'
  ];
  return { translate, SAMPLES, singular, plural, sqlId, isMoney, DIAL, buildIndex };
});
