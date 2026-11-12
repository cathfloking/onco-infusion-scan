/* OncoScan packing-slip import and shipment check-off. Prototype.
   Reads a supplier PDF packing slip in the browser (pdf.js), shows a REVIEW screen, and saves an "expected shipment".
   Expected shipments never create inventory. Vials are still received by scanning; this screen only compares
   those receipts with the slip. Requires: slip-parse.js, slip-import.css, /vendor/pdfjs.js, /vendor/pdfjs.worker.js. */
(function (root) {
'use strict';

// ---------- Pure logic (also unit-tested in Node) ----------
const toMs = s => { if (!s) return NaN; let t = String(s); if (!/[zZ]|[+-]\d\d:?\d\d$/.test(t)) t = t.replace(' ', 'T') + 'Z'; return Date.parse(t); };
const norm = s => String(s == null ? '' : s).trim().toUpperCase();

// Compare RECEIVE events (data.activity) since the shipment's count-from time with its expected lines.
function reconcile(ship, activity) {
  const from = toMs(ship.counted_from), lines = ship.lines.map(l => ({ ...l, need: l.expected_qty * l.vials_per_unit, received: 0, over: 0 }));
  const shipNdc = new Set(lines.map(l => l.ndc11));
  const pools = new Map();                                    // ndc -> Map(lot|exp -> entry)
  for (const a of activity || []) {
    if (a.action !== 'RECEIVE' || !(toMs(a.created_at) >= from)) continue;
    const cands = [a.supplier_ndc11, a.ndc11, a.scanned_ndc11].filter(Boolean).map(String);
    const ndc = cands.find(n => shipNdc.has(n)) || cands[0] || '';
    const qty = Number(a.quantity == null ? 1 : a.quantity) || 1;
    const key = norm(a.lot) + '|' + String(a.expiration || '');
    if (!pools.has(ndc)) pools.set(ndc, new Map());
    const m = pools.get(ndc), e = m.get(key) || { lot: String(a.lot ?? ''), exp: String(a.expiration || ''), desc: a.description || '', left: 0 };
    e.left += qty; m.set(key, e);
  }
  const take = (l, e) => { const t = Math.min(l.need - l.received, e.left); l.received += t; e.left -= t; };
  for (const pass of ['lot', 'nolot']) {
    for (const l of lines) {
      const hasLot = !!l.lot; if ((pass === 'lot') !== hasLot) continue;
      const m = pools.get(l.ndc11); if (!m) continue;
      for (const e of m.values()) {
        if (l.received >= l.need) break;
        if (hasLot && !(norm(e.lot) === norm(l.lot) && (!l.expiration || l.expiration === e.exp))) continue;
        take(l, e);
      }
    }
  }
  const unexpected = [];
  for (const [ndc, m] of pools) for (const e of m.values()) {
    if (e.left <= 0) continue;
    const target = lines.find(l => l.ndc11 === ndc && (!l.lot || (norm(l.lot) === norm(e.lot) && (!l.expiration || l.expiration === e.exp))));
    if (target) target.over += e.left;
    else unexpected.push({ ndc11: ndc, lot: e.lot, expiration: e.exp, description: e.desc, count: e.left, reason: shipNdc.has(ndc) ? 'Lot not on slip' : 'Not on slip' });
  }
  for (const l of lines) l.status = l.over > 0 ? 'OVER' : l.received === 0 ? 'PENDING' : l.received < l.need ? 'PARTIAL' : 'COMPLETE';
  const totals = { need: lines.reduce((n, l) => n + l.need, 0), received: lines.reduce((n, l) => n + l.received, 0) };
  return { lines, unexpected, totals };
}
const api = { reconcile, toMs };
if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
root.SlipReconcile = api;
if (!root.document) return;

// ---------- Browser UI ----------
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const link = el('link'); link.rel = 'stylesheet'; link.href = '/slip-import.css'; document.head.append(link);

async function call(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, opt), t = await r.text();
  let j; try { j = JSON.parse(t); } catch { throw new Error('Non-JSON server response. Check sign-in/deployment.'); }
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const toLocalInput = d => { const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); };

// pdf.js is self-hosted (public/vendor) so the CSP needs no change.
let pdfjs = null;
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import('/vendor/pdfjs.js');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs.worker.js';
  return pdfjs;
}
async function readPdf(file) {
  const lib = await loadPdfjs(), task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
  const pdf = await task.promise, pages = [];
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n), vp = page.getViewport({ scale: 1 }), t = vp.transform, tc = await page.getTextContent();
      pages.push(tc.items.filter(i => 'str' in i && i.str.trim()).map(i => {
        const x = i.transform[4], y = i.transform[5];
        return { s: i.str, x: t[0] * x + t[2] * y + t[4], y: t[1] * x + t[3] * y + t[5], w: i.width * vp.scale };
      }));
      page.cleanup();
    }
  } finally { await task.destroy(); }
  return pages;
}

let shipments = [], overlay = null;
function closeOverlay() { if (overlay) { overlay.remove(); overlay = null; } document.body.classList.remove('si-open'); }
function openOverlay(title) {
  closeOverlay();
  overlay = el('div', 'si-overlay'); overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', title);
  const head = el('div', 'si-head'), h = el('h2', '', title), x = el('button', 'si-x', 'Close'); x.type = 'button'; x.onclick = closeOverlay;
  head.append(h, x); const body = el('div', 'si-body'); overlay.append(head, body); document.body.append(overlay); document.body.classList.add('si-open');
  return body;
}
const chip = (text, cls) => el('span', 'si-chip si-' + cls, text);
const libraryNdc = () => { const s = new Map(); try { for (const p of data.products) s.set(String(p.ndc11), p); } catch { /* data not loaded */ } return s; };

// ----- Review screen -----
function review(groups, warnings, slipDate, fileName) {
  const body = openOverlay('Review packing slip'), lib = libraryNdc(), rows = [];
  const meta = el('div', 'si-meta');
  const lab = el('label', 'si-field', 'Label'), labIn = el('input'); labIn.type = 'text'; labIn.maxLength = 120; labIn.value = 'Packing slip ' + (slipDate || new Date().toISOString().slice(0, 10)); lab.append(labIn);
  const cf = el('label', 'si-field', 'Count receipts since'), cfIn = el('input'); cfIn.type = 'datetime-local'; cfIn.value = toLocalInput(startOfToday()); cf.append(cfIn);
  meta.append(lab, cf);
  const sum = el('p', 'si-sum'), warn = el('div', 'si-warn'); for (const w of warnings) warn.append(el('p', '', w));
  const note = el('p', 'si-note', 'Nothing is added to inventory. Saving creates a checklist that your scans are compared with. Fix anything misread, set vials per unit for multi-vial packs, and remove lines you do not want.');
  const list = el('div', 'si-list');
  const status = el('p', 'si-status'), save = el('button', 'si-btn si-primary', 'Save shipment'); save.type = 'button';

  for (const g of groups) {
    const row = el('div', 'si-row'), inc = el('input'); inc.type = 'checkbox'; inc.checked = true; inc.setAttribute('aria-label', 'Include line');
    const main = el('div', 'si-main'), title = el('div', 'si-title', g.description), sub = el('div', 'si-sub'), chips = el('div', 'si-chips');
    sub.append(el('span', 'si-mono', g.ndc11)); if (g.storage) sub.append(el('span', '', g.storage.replace(/^(.)(.*)$/, (m, a, b) => a + b.toLowerCase())));
    const lot = el('input'); lot.type = 'text'; lot.maxLength = 40; lot.placeholder = 'Lot (blank = any)'; lot.value = g.lot; lot.setAttribute('aria-label', 'Lot');
    const exp = el('input'); exp.type = 'date'; exp.value = g.expiration; exp.setAttribute('aria-label', 'Expiration');
    const qty = el('input'); qty.type = 'number'; qty.min = 1; qty.max = 10000; qty.step = 1; qty.value = g.qty; qty.setAttribute('aria-label', 'Quantity');
    const vpu = el('input'); vpu.type = 'number'; vpu.min = 1; vpu.max = 1000; vpu.step = 1; vpu.value = 1; vpu.setAttribute('aria-label', 'Vials per unit');
    const p = lib.get(g.ndc11);
    if (!g.lot) chips.append(chip('No lot on slip', 'warn'));
    if (!p) chips.append(chip('NDC not in library', 'warn')); else if (p.archived_at) chips.append(chip('Library entry archived', 'warn'));
    if (g.packHint) chips.append(chip('Name suggests pack of ' + g.packHint + ' - check vials per unit', 'info'));
    const f = el('div', 'si-fields');
    const mk = (t, inp) => { const l = el('label', 'si-mini', t); l.append(inp); return l; };
    f.append(mk('Lot', lot), mk('Expiration', exp), mk('Qty', qty), mk('Vials / unit', vpu));
    main.append(title, sub, chips, f); row.append(inc, main); list.append(row);
    rows.push({ g, inc, lot, exp, qty, vpu });
  }
  const update = () => {
    const use = rows.filter(r => r.inc.checked); const units = use.reduce((n, r) => n + (Number(r.qty.value) || 0) * (Number(r.vpu.value) || 1), 0);
    sum.textContent = use.length + ' lines selected - ' + units + ' vials expected';
  };
  list.addEventListener('input', update); list.addEventListener('change', update); update();

  save.onclick = async () => {
    const use = rows.filter(r => r.inc.checked);
    if (!use.length) { status.textContent = 'Select at least one line.'; return; }
    const cfDate = new Date(cfIn.value); if (isNaN(cfDate)) { status.textContent = 'Choose when to start counting receipts.'; return; }
    save.disabled = true; status.textContent = 'Saving...';
    try {
      const r = await call('/api/shipments/save', {
        requestId: save._rid || (save._rid = crypto.randomUUID()), label: labIn.value, slipDate, countedFrom: cfDate.toISOString(),
        lines: use.map(({ g, lot, exp, qty, vpu }) => ({ orderNo: (g.orders || []).join(','), boxId: (g.boxes || []).join(','), po: '', storage: g.storage || '', itemNo: '', ndc11: g.ndc11, description: g.description, lot: lot.value.trim(), expiration: lot.value.trim() ? exp.value : '', expectedQty: Number(qty.value), vialsPerUnit: Number(vpu.value), flags: (g.flags || []).join(' ') }))
      });
      await loadShipments(); closeOverlay(); checkoff(r.id);
    } catch (e) { status.textContent = e.message; save.disabled = false; }
  };
  const foot = el('div', 'si-foot'); foot.append(status, save);
  body.append(meta, sum, warn, note, list, foot);
}

// ----- Check-off screen -----
async function loadShipments() { shipments = (await call('/api/shipments')).shipments; updateCard(); }
async function freshActivity() { if (typeof refresh === 'function') { try { await refresh(); } catch { /* keep old data */ } } try { return data.activity || []; } catch { return []; } }

async function checkoff(selectId) {
  const body = openOverlay('Shipment check-off');
  const open = shipments.filter(s => s.status === 'OPEN');
  if (!shipments.length) { body.append(el('p', 'si-note', 'No shipments yet. Import a packing slip first.')); return; }
  let cur = shipments.find(s => s.id === selectId) || open[0] || shipments[0], filter = 'all';
  const bar = el('div', 'si-bar'), sel = el('select'); for (const s of shipments) sel.add(new Option((s.status === 'OPEN' ? '' : '[' + s.status.toLowerCase() + '] ') + s.label, s.id)); sel.value = cur.id;
  const ref = el('button', 'si-btn', 'Refresh'); ref.type = 'button';
  const flt = el('select'); flt.add(new Option('All lines', 'all')); flt.add(new Option('Outstanding only', 'out'));
  bar.append(sel, flt, ref);
  const prog = el('div', 'si-prog'), fill = el('div', 'si-fill'); prog.append(fill); const sumTxt = el('p', 'si-sum');
  const out = el('div', 'si-list'), unx = el('div', 'si-unx'), acts = el('div', 'si-foot');
  const close = el('button', 'si-btn', 'Close shipment'), cancel = el('button', 'si-btn si-danger', 'Cancel shipment'); close.type = cancel.type = 'button';
  acts.append(cancel, close); body.append(bar, prog, sumTxt, out, unx, acts);
  let activity = [];
  const draw = () => {
    const r = reconcile(cur, activity), pct = r.totals.need ? Math.min(100, Math.round(100 * r.totals.received / r.totals.need)) : 0;
    fill.style.width = pct + '%'; sumTxt.textContent = r.totals.received + ' of ' + r.totals.need + ' vials received (' + pct + '%) - receipts counted since ' + new Date(cur.counted_from).toLocaleString();
    out.replaceChildren(); const coldFirst = (a, b) => (/COLD/i.test(b.storage) ? 1 : 0) - (/COLD/i.test(a.storage) ? 1 : 0) || a.description.localeCompare(b.description);
    for (const l of [...r.lines].sort(coldFirst)) {
      if (filter === 'out' && l.status === 'COMPLETE') continue;
      const row = el('div', 'si-row si-' + l.status.toLowerCase()), main = el('div', 'si-main'), t = el('div', 'si-title', l.description), s = el('div', 'si-sub');
      s.append(el('span', 'si-mono', l.ndc11), el('span', '', l.lot ? 'Lot ' + l.lot + (l.expiration ? ' | exp ' + l.expiration : '') : 'Lot: any'));
      if (l.storage) s.append(el('span', '', l.storage.toLowerCase()));
      main.append(t, s); const cnt = el('div', 'si-count'); cnt.append(el('b', '', l.received + ' / ' + l.need), chip(l.status === 'OVER' ? 'Over +' + l.over : l.status.charAt(0) + l.status.slice(1).toLowerCase(), l.status.toLowerCase()));
      row.append(main, cnt); out.append(row);
    }
    unx.replaceChildren();
    if (r.unexpected.length) {
      unx.append(el('h3', '', 'Received but not matching the slip'));
      for (const u of r.unexpected) { const row = el('div', 'si-row si-over'), m = el('div', 'si-main'); m.append(el('div', 'si-title', u.description || u.ndc11), el('div', 'si-sub', u.ndc11 + ' | lot ' + u.lot + ' | ' + u.reason)); const c = el('div', 'si-count'); c.append(el('b', '', String(u.count))); row.append(m, c); unx.append(row); }
    }
    close.hidden = cancel.hidden = cur.status !== 'OPEN';
  };
  const reload = async () => { ref.disabled = true; activity = await freshActivity(); draw(); ref.disabled = false; };
  sel.onchange = () => { cur = shipments.find(s => s.id === Number(sel.value)); reload(); };
  flt.onchange = () => { filter = flt.value; draw(); }; ref.onclick = reload;
  const setStatus = async status => { try { await call('/api/shipments/status', { id: cur.id, status }); await loadShipments(); closeOverlay(); } catch (e) { sumTxt.textContent = e.message; } };
  close.onclick = () => setStatus('CLOSED');
  cancel.onclick = () => { if (confirm('Cancel this shipment checklist? Inventory is not affected.')) setStatus('CANCELLED'); };
  reload();
}

// ----- Entry card on the Scan screen -----
let card, openBtn;
function updateCard() { if (openBtn) { const n = shipments.filter(s => s.status === 'OPEN').length; openBtn.textContent = '\u{1F4CB} Shipments (' + n + ' open)'; } }
async function onFile(file) {
  if (!file) return;
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { alert('Photos are not supported yet. Choose the PDF packing slip.'); return; }
  const body = openOverlay('Reading packing slip'); body.append(el('p', 'si-note', 'Reading ' + file.name + '...'));
  try {
    if (typeof refresh === 'function' && (typeof data === 'undefined' || !data.products.length)) await refresh();
    const pages = await readPdf(file), parsed = SlipParse.parseSlipPages(pages);
    if (!parsed.lines.length) throw new Error('No product lines were found. ' + parsed.warnings.join(' '));
    const storageOf = new Map(); for (const l of parsed.lines) if (l.storage && !storageOf.has(l.ndc11 + '|' + l.lot)) storageOf.set(l.ndc11 + '|' + l.lot, l.storage);
    const groups = SlipParse.groupLines(parsed.lines).map(g => ({ ...g, storage: storageOf.get(g.ndc11 + '|' + g.lot) || '' }));
    review(groups, parsed.warnings, parsed.lines[0].slipDate || '', file.name);
  } catch (e) {
    closeOverlay(); const b = openOverlay('Could not read packing slip'); b.append(el('p', 'si-warn', e.message), el('p', 'si-note', 'If the PDF is a photo or scan without selectable text, it cannot be read yet.'));
  }
}
function install() {
  const form = $('scanForm'); if (!form || $('slipCard')) return;
  card = el('div', 'si-card'); card.id = 'slipCard';
  card.append(el('h3', '', 'Packing slip'), el('p', 'si-note', 'Import the day\'s packing slip to build a checklist, then scan as usual. Nothing is added until you scan.'));
  const row = el('div', 'si-btns'), imp = el('button', 'si-btn si-primary', '\u{1F4C4} Import packing slip'); imp.type = 'button';
  openBtn = el('button', 'si-btn', '\u{1F4CB} Shipments'); openBtn.type = 'button';
  const file = el('input'); file.type = 'file'; file.accept = 'application/pdf,.pdf'; file.hidden = true;
  imp.onclick = () => { file.value = ''; file.click(); }; file.onchange = () => onFile(file.files[0]); openBtn.onclick = async () => { try { await loadShipments(); checkoff(); } catch (e) { alert(e.message); } };
  row.append(imp, openBtn, file); card.append(row); form.before(card);
  loadShipments().catch(() => { /* card still works; errors show on use */ });
}
install();
window.addEventListener('hashchange', () => { if (overlay) closeOverlay(); });
})(typeof window !== 'undefined' ? window : globalThis);
