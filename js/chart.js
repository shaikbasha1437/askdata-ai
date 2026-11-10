/* AskData charts: picks a chart for a result set and renders it as a self-contained SVG string
   (inline colours, no CSS), so the same markup works on screen, in PNG/SVG exports and in HTML reports. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.AskData = root.AskData || {}).chart = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const PALETTE = ['#2f6fdf', '#e8853b', '#22a37a', '#c2417a', '#8a63d2', '#d4a514', '#3aa6c4', '#7a8a99', '#b55a2a', '#4f9a3a', '#9b3b54', '#5b6fb5'];
  const LIGHT = { bg: '#ffffff', ink: '#1b2430', muted: '#5f6c7b', grid: '#e3e8ee' };
  const DARK = { bg: '#141c27', ink: '#e6edf5', muted: '#9aa9ba', grid: '#2a3747' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MONEY = /(total|amount|revenue|sales|price|cost|mrr|arr|spend|income|fee|gmv|profit|order_value|payment|balance)/i;
  function isNumber(v) { return typeof v === 'number' && Number.isFinite(v); }
  function kindOf(rows, i) {
    let num = 0; let date = 0; let txt = 0;
    for (const r of rows.slice(0, 200)) { const v = r[i]; if (v == null) continue; if (isNumber(v)) num++; else if (/^\d{4}(-\d{2}(-\d{2})?)?$|^\d{4}-Q[1-4]$/.test(String(v))) date++; else txt++; }
    if (num && !date && !txt) return 'number';
    if (date && !txt && !num) return 'date';
    if (date && num && !txt && rows.every((r) => r[i] == null || isNumber(r[i]) && r[i] >= 1900 && r[i] <= 2100)) return 'date';
    return 'text';
  }
  function fmt(v, col, opts) {
    if (v == null) return '—';
    if (!isNumber(v)) return String(v);
    const money = col && MONEY.test(col) && !/(count|qty|quantity|units|pct|percent|rate|accounts|tickets|orders|customers)/i.test(col);
    if (col && /pct|percent|share/i.test(col)) return v.toLocaleString('en-US', { maximumFractionDigits: 1 }) + '%';
    const compact = opts && opts.compact && Math.abs(v) >= 10000;
    const s = compact ? Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v) : v.toLocaleString('en-US', { maximumFractionDigits: Number.isInteger(v) ? 0 : 2, minimumFractionDigits: money && !Number.isInteger(v) && !compact ? 2 : 0 });
    return (money ? '$' : '') + s;
  }
  /* Choose a chart. columns: names, rows: arrays. hint: {type,x,y,series} from the NL engine or the model. */
  function pick(columns, rows, hint) {
    const kinds = columns.map((_, i) => kindOf(rows, i));
    const nums = kinds.map((k, i) => (k === 'number' ? i : -1)).filter((i) => i >= 0);
    const dates = kinds.map((k, i) => (k === 'date' ? i : -1)).filter((i) => i >= 0);
    const texts = kinds.map((k, i) => (k === 'text' ? i : -1)).filter((i) => i >= 0);
    const byName = (n) => (n == null ? -1 : columns.findIndex((c) => String(c).toLowerCase() === String(n).toLowerCase()));
    const out = { type: 'table', x: null, y: null, series: null, kinds };
    if (!rows.length) return out;
    if (rows.length === 1 && nums.length >= 1 && columns.length <= 3 && !(hint && hint.type && hint.type !== 'kpi' && hint.type !== 'table')) return Object.assign(out, { type: 'kpi', y: columns[nums[nums.length - 1]] });
    let x = byName(hint && hint.x); let y = byName(hint && hint.y); let s = byName(hint && hint.series);
    if (y < 0 || kinds[y] !== 'number') y = nums.filter((i) => i !== x && !/pct|percent/i.test(columns[i]))[0] ?? nums[0] ?? -1;
    if (x < 0) x = dates[0] ?? texts[0] ?? -1;
    if (y < 0) return out;
    if (x < 0 && nums.length >= 2) return Object.assign(out, { type: 'scatter', x: columns[nums[0]], y: columns[nums[1]] });
    if (x < 0) return out;
    if (s < 0 && dates.length && texts.length && kinds[x] === 'date') s = texts[0];
    let type = hint && hint.type && ['bar', 'line', 'pie', 'scatter', 'table', 'kpi'].includes(hint.type) ? hint.type : null;
    if (!type || type === 'kpi') type = kinds[x] === 'date' ? 'line' : 'bar';
    if (type === 'pie' && (rows.length > 12 || rows.some((r) => isNumber(r[y]) && r[y] < 0))) type = 'bar';
    if (type === 'line' && kinds[x] !== 'date' && rows.length < 3) type = 'bar';
    if (type === 'scatter' && (kinds[x] !== 'number')) type = 'bar';
    return Object.assign(out, { type, x: columns[x], y: columns[y], series: s >= 0 && s !== x && s !== y ? columns[s] : null });
  }
  function niceTicks(min, max, n) {
    if (min === max) { max = min === 0 ? 1 : min * 1.1; if (min > 0) min = 0; }
    const span = max - min; const step0 = Math.pow(10, Math.floor(Math.log10(span / n))); const err = (n * step0) / span;
    const step = step0 * (err <= 0.15 ? 10 : err <= 0.35 ? 5 : err <= 0.75 ? 2 : 1);
    const lo = Math.floor(min / step) * step; const hi = Math.ceil(max / step) * step; const t = [];
    for (let v = lo; v <= hi + step / 2; v += step) t.push(Math.round(v / step) * step);
    return t;
  }
  function trunc(s, n) { s = String(s == null ? '(empty)' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  /* Render. spec = {type,x,y,series}; returns SVG markup ('' for table/kpi). */
  function render(spec, columns, rows, o) {
    const opt = o || {}; const W = opt.width || 720; const H = opt.height || 360; const C = opt.dark ? DARK : LIGHT; const title = opt.title || '';
    const xi = columns.indexOf(spec.x); const yi = columns.indexOf(spec.y); const si = spec.series ? columns.indexOf(spec.series) : -1;
    if (spec.type === 'table' || spec.type === 'kpi' || xi < 0 || yi < 0) return '';
    const head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(title || spec.type + ' chart of ' + spec.y + ' by ' + spec.x) + '" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif">' + '<rect width="100%" height="100%" fill="' + C.bg + '"/>' + (title ? '<text x="16" y="24" font-size="15" font-weight="700" fill="' + C.ink + '">' + esc(trunc(title, 90)) + '</text>' : '');
    const top = title ? 40 : 16;
    const data = rows.filter((r) => r[yi] != null && (spec.type === 'scatter' ? isNumber(r[xi]) : true));
    if (!data.length) return head + '<text x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle" fill="' + C.muted + '" font-size="14">No numeric values to chart</text></svg>';
    if (spec.type === 'pie') {
      const vals = data.map((r) => Math.max(0, Number(r[yi]) || 0)); const sum = vals.reduce((a, b) => a + b, 0) || 1;
      const cx = Math.min(W * 0.33, 200); const cy = top + (H - top) / 2; const R = Math.min(cx - 20, (H - top) / 2 - 12);
      let a0 = -Math.PI / 2; let out = head;
      data.forEach((r, i) => {
        const frac = vals[i] / sum; const a1 = a0 + frac * Math.PI * 2; const col = PALETTE[i % PALETTE.length];
        if (frac >= 0.9999) out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="' + col + '"/>';
        else if (frac > 0) { const large = a1 - a0 > Math.PI ? 1 : 0; out += '<path d="M' + cx + ',' + cy + 'L' + (cx + R * Math.cos(a0)).toFixed(2) + ',' + (cy + R * Math.sin(a0)).toFixed(2) + 'A' + R + ',' + R + ' 0 ' + large + ' 1 ' + (cx + R * Math.cos(a1)).toFixed(2) + ',' + (cy + R * Math.sin(a1)).toFixed(2) + 'Z" fill="' + col + '" stroke="' + C.bg + '" stroke-width="1.5"><title>' + esc(trunc(r[xi], 60) + ': ' + fmt(r[yi], spec.y) + ' (' + (frac * 100).toFixed(1) + '%)') + '</title></path>'; }
        a0 = a1;
      });
      const lx = cx * 2 + 10; const lh = Math.min(24, (H - top - 10) / data.length);
      data.forEach((r, i) => { const y = top + 10 + i * lh; out += '<rect x="' + lx + '" y="' + (y - 9) + '" width="12" height="12" rx="2" fill="' + PALETTE[i % PALETTE.length] + '"/><text x="' + (lx + 18) + '" y="' + (y + 1) + '" font-size="12.5" fill="' + C.ink + '">' + esc(trunc(r[xi], 26)) + ' <tspan fill="' + C.muted + '">' + esc(fmt(r[yi], spec.y, { compact: true }) + ' · ' + ((vals[i] / sum) * 100).toFixed(1) + '%') + '</tspan></text>'; });
      return out + '</svg>';
    }
    // Series pivot for line/bar.
    const xs = []; const seriesNames = []; const map = new Map();
    for (const r of data) { const xv = r[xi]; const sv = si >= 0 ? (r[si] == null ? '(empty)' : String(r[si])) : spec.y; if (!xs.some((v) => v === xv)) xs.push(xv); if (!seriesNames.includes(sv)) seriesNames.push(sv); map.set(JSON.stringify([xv, sv]), Number(r[yi])); }
    if (spec.type === 'line' || si >= 0) xs.sort((a, b) => (a == null ? -1 : b == null ? 1 : a < b ? -1 : a > b ? 1 : 0));
    const allY = Array.from(map.values()).filter(isNumber);
    if (spec.type === 'scatter') { allY.length = 0; data.forEach((r) => allY.push(Number(r[yi]))); }
    let ymin = Math.min(0, ...allY); let ymax = Math.max(0, ...allY);
    if (spec.type === 'scatter' || spec.type === 'line') { ymin = Math.min(...allY); ymax = Math.max(...allY); if (spec.type === 'line' && ymin > 0 && ymin < ymax * 0.6) ymin = 0; }
    const ticks = niceTicks(ymin, ymax, 5); const t0 = ticks[0]; const t1 = ticks[ticks.length - 1];
    const legendH = seriesNames.length > 1 ? 22 : 0;
    const left = 64; const right = 16; const bottom = 58; const ph = H - top - bottom - legendH; const pw = W - left - right;
    const Y = (v) => top + legendH + ph - ((v - t0) / (t1 - t0 || 1)) * ph;
    let out = head;
    if (legendH) { let lx = left; seriesNames.slice(0, 10).forEach((n, i) => { out += '<rect x="' + lx + '" y="' + (top + 2) + '" width="11" height="11" rx="2" fill="' + PALETTE[i % PALETTE.length] + '"/><text x="' + (lx + 15) + '" y="' + (top + 12) + '" font-size="12" fill="' + C.ink + '">' + esc(trunc(n, 18)) + '</text>'; lx += 30 + Math.min(18, String(n).length) * 6.6; }); }
    ticks.forEach((t) => { const y = Y(t).toFixed(1); out += '<line x1="' + left + '" x2="' + (W - right) + '" y1="' + y + '" y2="' + y + '" stroke="' + C.grid + '" stroke-width="1"/><text x="' + (left - 8) + '" y="' + (+y + 4) + '" text-anchor="end" font-size="11" fill="' + C.muted + '">' + esc(fmt(t, spec.y, { compact: true })) + '</text>'; });
    out += '<text x="14" y="' + (top + legendH + ph / 2) + '" font-size="11" fill="' + C.muted + '" transform="rotate(-90 14 ' + (top + legendH + ph / 2) + ')" text-anchor="middle">' + esc(trunc(spec.y, 30)) + '</text>';
    const labelEvery = Math.max(1, Math.ceil(xs.length / Math.floor(pw / 46)));
    const rotate = xs.length > 6 || xs.some((v) => String(v).length > 10);
    if (spec.type === 'scatter') {
      const xv = data.map((r) => Number(r[xi])); const xt = niceTicks(Math.min(...xv), Math.max(...xv), 6); const X = (v) => left + ((v - xt[0]) / (xt[xt.length - 1] - xt[0] || 1)) * pw;
      xt.forEach((t) => { out += '<text x="' + X(t).toFixed(1) + '" y="' + (top + legendH + ph + 18) + '" text-anchor="middle" font-size="11" fill="' + C.muted + '">' + esc(fmt(t, spec.x, { compact: true })) + '</text>'; });
      data.forEach((r) => { out += '<circle cx="' + X(Number(r[xi])).toFixed(1) + '" cy="' + Y(Number(r[yi])).toFixed(1) + '" r="4" fill="' + PALETTE[0] + '" fill-opacity=".75"><title>' + esc(fmt(r[xi], spec.x) + ', ' + fmt(r[yi], spec.y)) + '</title></circle>'; });
    } else if (spec.type === 'line') {
      const X = (i) => left + (xs.length === 1 ? pw / 2 : (i / (xs.length - 1)) * pw);
      seriesNames.slice(0, 12).forEach((sn, k) => { const pts = xs.map((xv, i) => { const v = map.get(JSON.stringify([xv, sn])); return isNumber(v) ? [X(i), Y(v), xv, v] : null; }).filter(Boolean); const col = PALETTE[k % PALETTE.length]; out += '<polyline fill="none" stroke="' + col + '" stroke-width="2.4" stroke-linejoin="round" points="' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + '"/>'; if (pts.length <= 60) pts.forEach((p) => { out += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3" fill="' + col + '"><title>' + esc((seriesNames.length > 1 ? sn + ' · ' : '') + p[2] + ': ' + fmt(p[3], spec.y)) + '</title></circle>'; }); });
      xs.forEach((xv, i) => { if (i % labelEvery) return; const x = X(i).toFixed(1); const y = top + legendH + ph + 16; out += rotate ? '<text x="' + x + '" y="' + y + '" font-size="11" fill="' + C.muted + '" text-anchor="end" transform="rotate(-35 ' + x + ' ' + y + ')">' + esc(trunc(xv, 14)) + '</text>' : '<text x="' + x + '" y="' + y + '" font-size="11" fill="' + C.muted + '" text-anchor="middle">' + esc(trunc(xv, 14)) + '</text>'; });
    } else {
      const n = xs.length; const band = pw / n; const ns = Math.min(seriesNames.length, 12); const bw = Math.max(2, Math.min(56, (band * 0.72) / ns));
      xs.forEach((xv, i) => { seriesNames.slice(0, 12).forEach((sn, k) => { const v = map.get(JSON.stringify([xv, sn])); if (!isNumber(v)) return; const x = left + i * band + (band - bw * ns) / 2 + k * bw; const y0 = Y(Math.max(0, t0)); const y1 = Y(v); out += '<rect x="' + x.toFixed(1) + '" y="' + Math.min(y0, y1).toFixed(1) + '" width="' + (bw - 1).toFixed(1) + '" height="' + Math.max(1, Math.abs(y0 - y1)).toFixed(1) + '" rx="2" fill="' + PALETTE[(ns > 1 ? k : 0) % PALETTE.length] + '"><title>' + esc((ns > 1 ? sn + ' · ' : '') + trunc(xv, 60) + ': ' + fmt(v, spec.y)) + '</title></rect>'; }); if (i % labelEvery) return; const cx = (left + i * band + band / 2).toFixed(1); const ly = top + legendH + ph + 16; out += rotate ? '<text x="' + cx + '" y="' + ly + '" font-size="11" fill="' + C.muted + '" text-anchor="end" transform="rotate(-35 ' + cx + ' ' + ly + ')">' + esc(trunc(xv, 16)) + '</text>' : '<text x="' + cx + '" y="' + ly + '" font-size="11" fill="' + C.muted + '" text-anchor="middle">' + esc(trunc(xv, 16)) + '</text>'; });
    }
    out += '<line x1="' + left + '" x2="' + (W - right) + '" y1="' + Y(Math.max(0, t0)).toFixed(1) + '" y2="' + Y(Math.max(0, t0)).toFixed(1) + '" stroke="' + C.muted + '" stroke-width="1"/>';
    return out + '</svg>';
  }
  return { pick, render, fmt, kindOf, niceTicks, PALETTE, MONEY };
});
