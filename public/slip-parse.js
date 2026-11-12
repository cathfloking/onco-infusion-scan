/* OncoScan packing-slip parser (pure functions; no DOM, no network).
   Input: pages = [ [ {s: 'text', x: leftX, y: topY}, ... ], ... ]  (y grows downward)
   Works on text extracted from a PDF's text layer (pdf.js) or on OCR word boxes, as long as x/y are supplied.
   Understands two layouts seen from the current supplier: "Packing Slip" and "PICK LIST".
   Output lines are PROPOSALS for a human review screen. They never touch inventory by themselves. */
(function (root) {
'use strict';


// pdf.js can return several words in one text item. Split them and estimate each word's left edge from the item width (w).
function splitItems(items) {
  const out = [];
  for (const i of items) {
    const str = i.s || '';
    if (!/\s/.test(str.trim()) || !i.w) { out.push(i); continue; }
    const re = /\S+/g; let m;
    while ((m = re.exec(str))) out.push({ s: m[0], x: i.x + i.w * (m.index / str.length), y: i.y });
  }
  return out;
}

const ROW_TOL = 3;
const isNdc = t => /^\d{11}-?$/.test(t);
const isItem = t => /^\d{8}$/.test(t);

function toRows(items) {
  const w = splitItems(items).filter(i => i.s && i.s.trim()).map(i => ({ s: i.s.trim(), x: i.x, y: i.y })).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const i of w) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - i.y) <= ROW_TOL) last.w.push(i); else rows.push({ y: i.y, w: [i] });
  }
  for (const r of rows) r.w.sort((a, b) => a.x - b.x);
  return rows;
}
const text = r => r.w.map(i => i.s).join(' ');
const inCol = (r, a, b) => r.w.filter(i => i.x >= a && i.x < b).map(i => i.s);
const find = (r, re) => r.w.find(i => re.test(i.s));

function isoFromMDY(s) {                       // 07-03-29 -> 2029-07-03
  const m = /^(\d\d)-(\d\d)-(\d\d)$/.exec(s); if (!m) return '';
  return '20' + m[3] + '-' + m[1] + '-' + m[2];
}
function isoFromISO(s) { return /^\d{4}-\d\d-\d\d$/.test(s) ? s : ''; }
const packHint = d => { const m = /\b(\d+)\s*X\s*\d/i.exec(d); return m ? Number(m[1]) : null; };

function parsePackingPage(rows, pageNo) {
  const out = [];
  let ctx = { po: '', order: '', olpn: '', storage: '', date: '' }, cols = null;
  for (const r of rows) {
    const t = text(r);
    let m;
    if ((m = /oLPN#:\s*(\d+)/.exec(t))) ctx.olpn = m[1];
    if ((m = /PO#:\s*(\S+)/.exec(t))) ctx.po = m[1];
    if ((m = /Order:\s*(\d+)/.exec(t))) ctx.order = m[1];
    if (!ctx.date && (m = /\b(\d\d)\/(\d\d)\/(\d{4})\b/.exec(t))) ctx.date = m[3] + '-' + m[1] + '-' + m[2];
    if (/^(COLD CHAIN|AMBIENT|FROZEN|CONTROLLED)\b/.test(t)) { ctx.storage = t; continue; }
    // Header row defines the column positions for the block that follows
    const q = find(r, /^Qty$/), it = find(r, /^Item$/), ds = find(r, /^Description$/), nd = find(r, /^NDC\/UPC$/);
    const lots = r.w.filter(i => i.s === 'Lot'), ni = find(r, /^NIOSH$/);
    if (q && it && ds && nd && lots.length) {
      const lot = lots[0], exp = lots[1] || null;
      cols = { item: it.x - 10, desc: ds.x - 4, ndc: nd.x - 6, lot: lot.x - 6, exp: (exp ? exp.x : lot.x + 120) - 6, niosh: (ni ? ni.x : 9999) - 6 };
      continue;
    }
    if (!cols) continue;
    const item = inCol(r, cols.item, cols.desc).filter(isItem), ndc = inCol(r, cols.ndc, cols.lot).filter(isNdc);
    if (!item.length || !ndc.length) continue;
    const qtyTxt = inCol(r, 0, cols.item)[0], exp = inCol(r, cols.exp, cols.niosh).find(x => /^\d\d-\d\d-\d\d$/.test(x)) || '';
    out.push({
      layout: 'packing', page: pageNo, po: ctx.po, order: ctx.order, box: ctx.olpn, storage: ctx.storage, slipDate: ctx.date,
      item: item[0], ndc11: ndc[0].replace('-', ''), description: inCol(r, cols.desc, cols.ndc).join(' '),
      lot: inCol(r, cols.lot, cols.exp).join(' '), expiration: isoFromMDY(exp), qty: /^\d+$/.test(qtyTxt || '') ? Number(qtyTxt) : null,
      niosh: inCol(r, cols.niosh, 99999).join(' ')
    });
  }
  return out;
}

function parsePickPage(rows, pageNo) {
  const out = [];
  let ctx = { order: '', date: '' }, cols = null;
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k], t = text(r);
    let m;
    if ((m = /Date\/Time\s*:?\s*(\d\d)-(\d\d)-(\d{4})/.exec(t.replace(/\s+/g, ' ')))) ctx.date = m[3] + '-' + m[1] + '-' + m[2];
    if ((m = /:(DO\d+)/.exec(t))) ctx.order = m[1];
    const hNdc = find(r, /^NDC$/), hLot = find(r, /^LOT$/), hExp = find(r, /^EXP$/), hPick = find(r, /^PICK$/), hDesc = find(r, /^DESCRIPTION$/), hUom = find(r, /^UOM$/), hOl = find(r, /^OLPN$/);
    if (hNdc && hLot && hExp && hDesc) {
      cols = { desc: hDesc.x - 40, qty: (hOl ? hOl.x - 6 : hDesc.x + 80), pick: hPick ? hPick.x - 8 : 0, uom: hUom ? hUom.x - 4 : 0, ndc: hNdc.x - 6, lot: hLot.x - 6, exp: hExp.x - 6, niosh: (hExp.x + 60) };
      continue;
    }
    if (!cols) continue;
    const item = r.w.filter(i => isItem(i.s) && i.x < cols.desc + 100), ndc = inCol(r, cols.ndc, cols.lot).filter(isNdc);
    if (!item.length || !ndc.length) continue;
    // description continues on following rows until the next item row or "Notes:"
    let desc = r.w.filter(i => i.x >= cols.desc && i.x < cols.qty && !isItem(i.s)).map(i => i.s);
    for (let j = k + 1; j < rows.length && !/^Notes:/.test(text(rows[j])); j++) {
      if (rows[j].w.some(i => isItem(i.s))) break;
      desc = desc.concat(rows[j].w.filter(i => i.x >= cols.desc && i.x < cols.qty).map(i => i.s));
    }
    const pick = inCol(r, cols.pick, cols.uom || 99999).find(x => /^\d+(\.\d+)?$/.test(x));
    out.push({
      layout: 'picklist', page: pageNo, po: '', order: ctx.order, box: '', storage: '', slipDate: ctx.date,
      item: item[0].s, ndc11: ndc[0].replace('-', ''), description: desc.join(' '),
      lot: inCol(r, cols.lot, cols.exp).join(' '), expiration: isoFromISO(inCol(r, cols.exp, cols.niosh).find(x => /^\d{4}-\d\d-\d\d$/.test(x)) || ''),
      qty: pick ? Math.round(Number(pick)) : null, niosh: ''
    });
  }
  return out;
}

function parseSlipPages(pages) {
  const lines = [], warnings = [];
  pages.forEach((items, idx) => {
    const rows = toRows(items), whole = rows.map(text).join(' ');
    let found;
    if (/Packing\s+Slip/i.test(whole)) found = parsePackingPage(rows, idx + 1);
    else if (/PICK\s+LIST/i.test(whole)) found = parsePickPage(rows, idx + 1);
    else { warnings.push('Page ' + (idx + 1) + ': layout not recognized; no lines read.'); return; }
    if (!found.length) warnings.push('Page ' + (idx + 1) + ': no product lines found.');
    lines.push(...found);
  });
  for (const l of lines) {
    l.packHint = packHint(l.description);
    l.flags = [];
    if (!l.lot) l.flags.push('NO_LOT');
    if (l.lot && !l.expiration) l.flags.push('NO_EXPIRATION');
    if (l.qty == null) l.flags.push('NO_QTY');
  }
  return { lines, warnings };
}

// Merge identical product/lot/expiration lines (same drug split across boxes or repeated within a box).
function groupLines(lines) {
  const map = new Map();
  for (const l of lines) {
    const key = [l.ndc11, l.lot, l.expiration].join('|');
    let g = map.get(key);
    if (!g) { g = { ndc11: l.ndc11, description: l.description, lot: l.lot, expiration: l.expiration, qty: 0, boxes: [], orders: [], flags: l.flags.slice(), packHint: l.packHint }; map.set(key, g); }
    g.qty += l.qty || 0;
    if (l.box && !g.boxes.includes(l.box)) g.boxes.push(l.box);
    if (l.order && !g.orders.includes(l.order)) g.orders.push(l.order);
  }
  return [...map.values()];
}

const api = { parseSlipPages, groupLines, toRows, splitItems };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SlipParse = api;
})(typeof window !== 'undefined' ? window : globalThis);
