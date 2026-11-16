/* OncoScan reconcile engine (pure functions; no DOM, no network).
   Input: pages = [ [ {s:'text', x:leftX, y:topY, w:width}, ... ], ... ]  (the same pdf.js item shape used by slip-parse.js)
   Reads two supplier report layouts:
     - Order history report ("Order Qty / Conf Qty / Ship Qty ... Ext. Cost")
     - Invoice ("Qty UOM Description ... Unit Price Extended Amount")
   Packing slips are read by slip-parse.js (SlipParse.parseSlipPages) and passed to reconcile() as slipLines.
   All money is handled as integer cents. Results are an audit aid for a person to review; nothing here touches inventory. */
(function (root) {
'use strict';

const ROW_TOL = 3;
const NDC_DASH = /^\d{5}-\d{4}-\d{2}$/;
const isMoney = t => /^\$?\d[\d,]*\.\d{2}$/.test(t);
const toCents = s => { const n = Math.round(parseFloat(String(s).replace(/[$,]/g, '')) * 100); return Number.isFinite(n) ? n : 0; };
const ndc11 = s => String(s).replace(/-/g, '').trim();
const dollars = c => c / 100;
const fmt$ = c => (c < 0 ? '-$' : '$') + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- Text layout helpers ----------
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
const rowText = r => r.w.map(i => i.s).join(' ');
const firstTok = (r, re) => r.w.find(i => re.test(i.s));

// Classify a PDF so the screen can warn when a file is in the wrong box.
function detectType(pages) {
  const t = pages.map(p => p.map(i => i.s).join(' ')).join(' ');
  if (/Packing\s+Slip|PICK\s+LIST/i.test(t)) return 'slip';
  if (/Acq\.?\s*Cost/i.test(t) && /Ship\s+Qty/i.test(t)) return 'order';
  if (/Extended\s+Amount|Total\s+Amount:/i.test(t) && /Invoice\s+Number/i.test(t)) return 'invoice';
  return 'unknown';
}

// ---------- Order history ----------
function parseOrderPages(pages) {
  const doc = { kind: 'order', po: '', orderNo: '', invoiceNo: '', statedTotalCents: null, lines: [], warnings: [] };
  pages.forEach((items, pi) => {
    const rows = toRows(items);
    const hdr = rows.find(r => r.w.some(i => i.s === 'ABC#') && r.w.some(i => i.s === 'Line'));
    if (pi === 0 || !doc.po) {
      for (const r of rows) {
        if (hdr && r.y >= hdr.y) break;
        const t = rowText(r); let m;
        if ((m = /^PO Number:\s*(.+)$/i.exec(t))) doc.po = m[1].trim();
        else if ((m = /^Invoice Number:\s*(\d+)/i.exec(t))) doc.invoiceNo = m[1];
        else if ((m = /^Order Number:\s*(\d+)/i.exec(t))) doc.orderNo = m[1];
        if (doc.statedTotalCents === null) {
          const d = r.w.find(i => /^\$[\d,]+\.\d{2}$/.test(i.s));
          if (d && /Total/i.test(rows.map(x => Math.abs(x.y - r.y) <= 8 ? rowText(x) : '').join(' '))) doc.statedTotalCents = toCents(d.s);
        }
      }
    }
    if (!hdr) return;
    const prodX = (firstTok(hdr, /^Product$/) || { x: 120 }).x - 6;
    const ordX = (firstTok(hdr, /^Order$/) || { x: 300 }).x - 6;
    const anchors = rows.filter(r => r.y > hdr.y && r.w.some(i => NDC_DASH.test(i.s)));
    const skip = new Set(rows.filter(r => /^Continued/i.test(rowText(r))).map(r => r.y));
    const bandTokens = [];
    for (const r of rows) if (r.y > hdr.y && !skip.has(r.y)) for (const i of r.w) if (i.x >= prodX && i.x < ordX && !/^Page$/i.test(i.s)) bandTokens.push(i);
    for (const a of anchors) {
      const ndcTok = a.w.find(i => NDC_DASH.test(i.s));
      const abc = a.w.find(i => /^\d{8}$/.test(i.s) && i.x < prodX + 10);
      const nameToks = bandTokens.filter(i => {
        const near = anchors.reduce((b, x) => Math.abs(x.y - i.y) < Math.abs(b.y - i.y) ? x : b, anchors[0]);
        return near === a && Math.abs(a.y - i.y) <= 16;
      }).sort((p, q) => p.y - q.y || p.x - q.x);
      const qtyZone = a.w.filter(i => i.x >= ordX && i.x < ndcTok.x - 6);
      const nums = qtyZone.filter(i => /^\d+$/.test(i.s)).map(i => Number(i.s));
      const uom = (qtyZone.find(i => /^[A-Za-z]{2,}$/.test(i.s)) || {}).s || '';
      const money = a.w.filter(i => /^\$[\d,]+\.\d{2}$/.test(i.s)).map(i => toCents(i.s));
      if (!nums.length || money.length < 2) { doc.warnings.push('Order line for NDC ' + ndc11(ndcTok.s) + ' could not be read completely.'); continue; }
      doc.lines.push({
        ndc11: ndc11(ndcTok.s), abc: abc ? abc.s : '', name: nameToks.map(i => i.s).join(' '),
        orderQty: nums[0], confQty: nums.length > 1 ? nums[1] : nums[0], shipQty: nums.length > 2 ? nums[2] : nums[0], uom,
        unitCents: money[money.length - 2], extCents: money[money.length - 1], orderNo: doc.orderNo, po: doc.po
      });
    }
  });
  if (!doc.lines.length) doc.warnings.push('No order lines were found. This does not look like an order history report.');
  doc.computedTotalCents = doc.lines.reduce((n, l) => n + l.extCents, 0);
  return doc;
}

// ---------- Invoice ----------
function parseInvoicePages(pages) {
  const doc = { kind: 'invoice', po: '', invoiceNo: '', statedTotalCents: null, lines: [], warnings: [] };
  pages.forEach(items => {
    const rows = toRows(items);
    for (const r of rows) {
      const t = rowText(r); let m;
      if (!doc.invoiceNo && (m = /Invoice Number:\s*(\d+)/i.exec(t))) doc.invoiceNo = m[1];
      if (!doc.po && (m = /P\.?O\.? Number:\s*(.+)$/i.exec(t))) doc.po = m[1].trim();
      if ((m = /Total Amount:?\s*([\d,]+\.\d{2})/i.exec(t))) doc.statedTotalCents = toCents(m[1]);
    }
    if (doc.statedTotalCents === null) {
      const h = rows.findIndex(r => /DOCUMENT/.test(rowText(r)) && /TOTAL/.test(rowText(r)));
      if (h >= 0) for (let k = h + 1; k < Math.min(rows.length, h + 3); k++) { const d = rows[k].w.find(i => /^[\d,]+\.\d{2}$/.test(i.s)); if (d) { doc.statedTotalCents = toCents(d.s); break; } }
    }
    const hdr = rows.find(r => r.w.some(i => i.s === 'Qty') && r.w.some(i => i.s === 'UOM') && r.w.some(i => i.s === 'Description'));
    if (!hdr) return;
    const descX = firstTok(hdr, /^Description$/).x - 6, vndTok = firstTok(hdr, /^VND$/), vndX = (vndTok ? vndTok.x : 270) - 6;
    for (const a of rows.filter(r => r.y > hdr.y && r.w.some(i => NDC_DASH.test(i.s)))) {
      const ndcTok = a.w.find(i => NDC_DASH.test(i.s));
      const left = a.w.filter(i => i.x < ndcTok.x);
      const qtyTok = left.find(i => /^\d+$/.test(i.s) && i.x < descX + 6);
      const uomTok = left.find(i => /^[A-Za-z]{1,4}$/.test(i.s) && qtyTok && i.x > qtyTok.x);
      const item = left.find(i => /^\d{8}$/.test(i.s));
      const right = a.w.filter(i => i.x > ndcTok.x);
      const ord = right.find(i => /^\d{10}$/.test(i.s));
      const money = right.filter(i => isMoney(i.s)).map(i => toCents(i.s));
      if (!qtyTok || money.length < 2) { doc.warnings.push('Invoice line for NDC ' + ndc11(ndcTok.s) + ' could not be read completely.'); continue; }
      doc.lines.push({
        ndc11: ndc11(ndcTok.s), qty: Number(qtyTok.s), uom: uomTok ? uomTok.s : '', item: item ? item.s : '',
        name: a.w.filter(i => i.x >= descX && i.x < vndX).map(i => i.s).join(' '),
        orderNo: ord ? ord.s : '', unitCents: money[money.length - 2], extCents: money[money.length - 1], invoiceNo: doc.invoiceNo, po: doc.po
      });
    }
  });
  if (!doc.lines.length) doc.warnings.push('No invoice lines were found. This does not look like an invoice.');
  doc.computedTotalCents = doc.lines.reduce((n, l) => n + l.extCents, 0);
  return doc;
}

// ---------- Triple match ----------
// slipLines: lines from SlipParse.parseSlipPages ({ndc11, qty, order, po, description, lot, expiration}).
// Packing slips from the supplier are not order specific, so each slip line is tied to an uploaded order by its
// order number. Lines for other orders are shown beside the matching line (REVIEW), never silently counted.
function reconcile(input) {
  const orders = input.orders || [], invoices = input.invoices || [], slipLines = input.slipLines || [], hasSlips = !!input.hasSlips;
  const recs = new Map(), order = [];
  const get = (ndc, name) => {
    let r = recs.get(ndc);
    if (!r) { r = { ndc11: ndc, name: name || '', ordQty: 0, shipQty: 0, ordC: 0, ordUnits: new Set(), invQty: 0, invC: 0, invUnits: new Set(), rcv: 0, other: 0, otherBy: new Map(), pos: new Set(), orderNos: new Set(), invoices: new Set(), lots: [], fromOrder: false }; recs.set(ndc, r); order.push(r); }
    if (!r.name && name) r.name = name;
    return r;
  };
  const orderNos = new Set(orders.map(o => o.orderNo).filter(Boolean));
  for (const o of orders) for (const l of o.lines) {
    const r = get(l.ndc11, l.name); r.fromOrder = true;
    r.name = r.name || l.name; r.ordQty += l.orderQty; r.shipQty += l.shipQty; r.ordC += l.extCents; r.ordUnits.add(l.unitCents);
    if (o.po) r.pos.add(o.po); if (o.orderNo) r.orderNos.add(o.orderNo);
  }
  for (const inv of invoices) for (const l of inv.lines) {
    const r = get(l.ndc11, l.name); r.invQty += l.qty; r.invC += l.extCents; r.invUnits.add(l.unitCents);
    if (inv.invoiceNo) r.invoices.add(inv.invoiceNo); if (inv.po && !r.fromOrder) r.pos.add(inv.po);
  }
  const otherSlips = new Map();
  for (const s of slipLines) {
    const qty = Number(s.qty) || 0, ord = String(s.order || ''), mine = !ord || orderNos.has(ord) || !orderNos.size;
    const existing = recs.get(s.ndc11);
    if (mine) { const r = get(s.ndc11, s.description); r.rcv += qty; r.lots.push({ lot: s.lot || '', exp: s.expiration || '', qty }); }
    else if (existing && existing.ordQty > 0) { existing.other += qty; existing.otherBy.set(ord, (existing.otherBy.get(ord) || 0) + qty); }
    else {
      const k = s.ndc11 + '|' + ord + '|' + (s.po || ''); const o = otherSlips.get(k) || { ndc11: s.ndc11, description: s.description || '', order: ord, po: s.po || '', qty: 0 };
      o.qty += qty; otherSlips.set(k, o);
    }
  }

  const lines = order.map(r => {
    const issues = [], add = (sev, code, text) => issues.push({ sev, code, text });
    const hasInv = invoices.length > 0;
    if (!r.fromOrder) {
      if (r.invQty > 0) add('error', 'NOT_ORDERED', 'Invoiced but not on the order history.');
      else add('error', 'NOT_ORDERED', 'On the slip under an uploaded order number, but not on the order history.');
    } else {
      if (hasInv) {
        if (r.invQty < r.ordQty) add('error', r.invQty === 0 ? 'NOT_INVOICED' : 'QTY_INV_SHORT', r.invQty === 0 ? 'Ordered ' + r.ordQty + ' but not invoiced.' : 'Invoiced ' + r.invQty + ' of ' + r.ordQty + ' ordered.');
        else if (r.invQty > r.ordQty) add('error', 'QTY_INV_OVER', 'Invoiced ' + r.invQty + ' but ordered ' + r.ordQty + '.');
        if (r.invC !== r.ordC && r.invQty > 0) add('error', 'AMT_DIFF', 'Invoiced ' + fmt$(r.invC) + ' vs ordered ' + fmt$(r.ordC) + ' (' + fmt$(r.invC - r.ordC) + ').');
        const badUnit = [...r.invUnits].filter(u => !r.ordUnits.has(u));
        if (badUnit.length) add('error', 'PRICE_DIFF', 'Invoice unit price ' + badUnit.map(fmt$).join(', ') + ' vs order ' + [...r.ordUnits].map(fmt$).join(', ') + '.');
      }
      if (r.shipQty < r.ordQty) add('review', 'SUPPLIER_SHORT_SHIP', 'Order history shows the supplier shipping ' + r.shipQty + ' of ' + r.ordQty + ' ordered.');
    }
    if (hasSlips && r.fromOrder) {
      const others = [...r.otherBy].map(([o, q]) => q + ' on order ' + (o || 'unknown')).join(', ');
      if (r.rcv > r.ordQty) add('error', 'OVER_RECEIVED', 'Slip shows ' + r.rcv + ' for this order but only ' + r.ordQty + ' ordered.');
      else if (r.rcv < r.ordQty) {
        const miss = r.ordQty - r.rcv;
        if (r.other > 0 && r.rcv + r.other >= r.ordQty) add('review', 'SHORT_COVERED_OTHER', 'Short ' + miss + ' on this order, but the slip lists ' + others + '. Likely lumped under another order; verify.');
        else add('error', 'SHORT_ON_SLIP', (r.rcv === 0 ? 'Not on the slip' : 'Short ' + miss + ' on the slip') + (r.other ? ' (slip lists ' + others + ' under other orders)' : '') + '. May ship separately from another distribution center.');
      } else if (r.other > 0) add('review', 'EXTRA_OTHER_ORDER', 'Slip also lists ' + others + ' for this drug. Confirm it belongs to those orders.');
    }
    const status = issues.some(i => i.sev === 'error') ? 'MISMATCH' : issues.length ? 'REVIEW' : 'MATCH';
    return {
      ndc11: r.ndc11, name: r.name, status, ordQty: r.ordQty, invQty: r.invQty, rcvQty: hasSlips ? r.rcv : null, otherQty: hasSlips ? r.other : null,
      ordC: r.ordC, invC: r.invC, pos: [...r.pos], orderNos: [...r.orderNos], issues,
      codes: issues.map(i => i.code).join(', '), detail: issues.map(i => i.text).join(' ')
    };
  });

  const docs = [];
  for (const o of orders) docs.push({ type: 'Order history', no: o.orderNo || '', ref: o.invoiceNo ? 'Invoice ' + o.invoiceNo : '', po: o.po, statedC: o.statedTotalCents, computedC: o.computedTotalCents });
  for (const v of invoices) docs.push({ type: 'Invoice', no: v.invoiceNo, ref: '', po: v.po, statedC: v.statedTotalCents, computedC: v.computedTotalCents });
  for (const d of docs) { d.linesOk = d.statedC === null ? null : d.statedC === d.computedC; d.diffC = d.statedC === null ? null : d.computedC - d.statedC; }
  const poKey = p => String(p || '').trim().toLowerCase();
  const pos = new Map();
  const bucket = p => { const k = poKey(p) || '(none)'; if (!pos.has(k)) pos.set(k, { po: p || '(none)', ordC: 0, invC: 0, orders: 0, invoices: 0 }); return pos.get(k); };
  for (const o of orders) { const b = bucket(o.po); b.ordC += o.statedTotalCents ?? o.computedTotalCents; b.orders++; }
  for (const v of invoices) { const b = bucket(v.po); b.invC += v.statedTotalCents ?? v.computedTotalCents; b.invoices++; }
  const poChecks = [...pos.values()].map(b => ({ ...b, diffC: b.invC - b.ordC, ok: b.orders > 0 && b.invoices > 0 && b.invC === b.ordC }));
  const ordTotal = poChecks.reduce((n, b) => n + b.ordC, 0), invTotal = poChecks.reduce((n, b) => n + b.invC, 0);
  const warnings = [];
  for (const o of orders) for (const w of o.warnings) warnings.push(w);
  for (const v of invoices) for (const w of v.warnings) warnings.push(w);
  for (const b of poChecks) { if (!b.orders) warnings.push('Invoice(s) for PO "' + b.po + '" have no matching order history report.'); else if (!b.invoices && invoices.length) warnings.push('No invoice uploaded for PO "' + b.po + '".'); }
  for (const d of docs) if (d.linesOk === false) warnings.push(d.type + ' ' + (d.no || d.po) + ': line items add up to ' + fmt$(d.computedC) + ' but the stated total is ' + fmt$(d.statedC) + '.');

  const count = s => lines.filter(l => l.status === s).length;
  const grandMatch = ordTotal === invTotal;
  return {
    hasSlips, hasInvoices: invoices.length > 0, lines, docs, poChecks, otherSlips: [...otherSlips.values()], warnings,
    totals: { ordC: ordTotal, invC: invTotal, diffC: invTotal - ordTotal, grandMatch },
    counts: { lines: lines.length, match: count('MATCH'), review: count('REVIEW'), mismatch: count('MISMATCH') },
    ok: grandMatch && count('MISMATCH') === 0 && count('REVIEW') === 0
  };
}

const api = { parseOrderPages, parseInvoicePages, reconcile, detectType, toRows, toCents, fmt$, dollars };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ReconCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
