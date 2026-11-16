/* OncoScan Reconcile tab: order history vs. invoices vs. packing slips.
   Everything runs in this browser. PDFs are read with the self-hosted pdf.js and are never uploaded or stored.
   Requires: recon-core.js, slip-parse.js, /vendor/pdfjs.js, app.js (for table() and toast()). The Excel library loads only when Export is pressed. */
(function () {
'use strict';
const $ = id => document.getElementById(id);
if (!$('view-reconcile') || !window.ReconCore) return;
const RC = window.ReconCore, KINDS = ['order', 'invoice', 'slip'];
const LABEL = { order: 'an order history report', invoice: 'an invoice', slip: 'a packing slip' };
const files = { order: [], invoice: [], slip: [] };
let result = null, busy = false;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const say = (t, bad) => { const s = $('rcStatus'); s.textContent = t; s.className = bad ? 'status error' : 'status ok'; };
const note = (t, bad) => { if (typeof toast === 'function') toast(t, !!bad); };
const money = c => RC.fmt$(c);

// ---------- PDF reading (same approach as the packing-slip importer) ----------
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

// ---------- File boxes ----------
const drop = kind => document.querySelector('.rc-drop[data-kind="' + kind + '"]');
const fileKey = f => f.name + '|' + f.size + '|' + f.lastModified;
const kb = n => n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
function renderFiles(kind) {
  const ul = drop(kind).querySelector('.rc-files'); ul.replaceChildren();
  for (const f of files[kind]) {
    const li = el('li'), name = el('span', 'rc-name', f.name), size = el('span', 'muted', kb(f.size)), x = el('button', 'btn small', 'Remove');
    name.title = f.name; x.type = 'button'; x.setAttribute('aria-label', 'Remove ' + f.name);
    x.onclick = () => { files[kind] = files[kind].filter(g => g !== f); renderFiles(kind); sync(); };
    li.append(name, size, x); ul.append(li);
  }
  drop(kind).classList.toggle('has', files[kind].length > 0);
}
function addFiles(kind, list) {
  const have = new Set(files[kind].map(fileKey)); let skipped = 0;
  for (const f of list) {
    if (!/\.pdf$/i.test(f.name) && !/pdf$/i.test(f.type)) { skipped++; continue; }
    if (!have.has(fileKey(f))) { files[kind].push(f); have.add(fileKey(f)); }
  }
  renderFiles(kind); sync();
  if (skipped) say(skipped + ' file(s) skipped: only PDF files are supported.', true);
}
function sync() {
  $('rcRun').disabled = busy || !(files.order.length && files.invoice.length);
  $('rcClear').disabled = busy;
  $('rcExport').disabled = busy || !result;
  const need = [];
  if (!files.order.length) need.push('an order history report');
  if (!files.invoice.length) need.push('at least one invoice');
  $('rcNeed').textContent = need.length ? 'Add ' + need.join(' and ') + ' to run. Packing slips are optional.' : 'Ready. Packing slips are optional but give the received-quantity check.';
}
for (const kind of KINDS) {
  const box = drop(kind), input = box.querySelector('.rc-input'), pick = box.querySelector('.rc-pick');
  pick.onclick = () => { input.value = ''; input.click(); };
  input.onchange = () => addFiles(kind, [...input.files]);
  box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('over'); });
  box.addEventListener('dragleave', () => box.classList.remove('over'));
  box.addEventListener('drop', e => { e.preventDefault(); box.classList.remove('over'); addFiles(kind, [...e.dataTransfer.files]); });
}
$('rcClear').onclick = () => { for (const k of KINDS) { files[k] = []; renderFiles(k); } result = null; $('rcResults').hidden = true; say(''); sync(); };

// ---------- Run ----------
async function run() {
  if (busy) return;
  busy = true; sync(); $('rcResults').hidden = true; result = null;
  const orders = [], invoices = [], slipLines = [], warnings = [];
  try {
    for (const kind of KINDS) for (const f of files[kind]) {
      say('Reading ' + f.name + '...');
      let pages;
      try { pages = await readPdf(f); } catch (e) { throw new Error(f.name + ' could not be opened as a PDF.'); }
      const type = RC.detectType(pages);
      if (type !== 'unknown' && type !== kind) warnings.push(f.name + ' looks like ' + LABEL[type] + ' but was added as ' + LABEL[kind] + '. Check that each file is in the right box.');
      if (kind === 'order') { const d = RC.parseOrderPages(pages); d.warnings = d.warnings.map(w => f.name + ': ' + w); orders.push(d); }
      else if (kind === 'invoice') { const d = RC.parseInvoicePages(pages); d.warnings = d.warnings.map(w => f.name + ': ' + w); invoices.push(d); }
      else {
        if (!window.SlipParse) throw new Error('Packing slip reader did not load.');
        const p = window.SlipParse.parseSlipPages(pages);
        for (const w of p.warnings) warnings.push(f.name + ': ' + w);
        if (!p.lines.length) warnings.push(f.name + ': no packing slip lines were found.');
        slipLines.push(...p.lines);
      }
    }
    result = RC.reconcile({ orders, invoices, slipLines, hasSlips: files.slip.length > 0 });
    result.warnings = [...warnings, ...result.warnings];
    result.generatedAt = new Date().toISOString();
    result.fileCounts = { order: files.order.length, invoice: files.invoice.length, slip: files.slip.length };
    render();
    const c = result.counts;
    say(c.lines + ' lines checked: ' + c.match + ' match, ' + c.review + ' to review, ' + c.mismatch + ' mismatch.');
  } catch (e) { result = null; say(e.message, true); }
  finally { busy = false; sync(); }
}
$('rcRun').onclick = run;

// ---------- Results ----------
const stat = (label, n, cls) => { const c = el('div', 'card ' + cls); c.append(el('h2', '', label), el('p', 'big', String(n))); return c; };
const rowClass = r => 'rc-' + String(r.Status || r.Result || '').toLowerCase();
function render() {
  const r = result, t = r.totals, c = r.counts;
  $('rcResults').hidden = false;
  $('rcStats').replaceChildren(stat('Lines', c.lines, ''), stat('Match', c.match, 'rc-ok'), stat('Review', c.review, 'rc-warn'), stat('Mismatch', c.mismatch, 'rc-bad'));
  const bad = !t.grandMatch || c.mismatch > 0, rev = c.review > 0, v = $('rcVerdict');
  v.className = 'rc-verdict ' + (bad ? 'bad' : rev ? 'review' : 'ok');
  v.textContent = (t.grandMatch ? 'Ordered ' + money(t.ordC) + ' and invoiced ' + money(t.invC) + ' agree.' : 'Ordered ' + money(t.ordC) + ' but invoiced ' + money(t.invC) + ' (' + money(t.diffC) + ').')
    + (c.mismatch ? ' ' + c.mismatch + ' line(s) have a mismatch.' : '') + (c.review ? ' ' + c.review + ' line(s) need a quick review.' : '') + (!bad && !rev ? ' Every line matches.' : '')
    + (r.hasSlips ? '' : ' No packing slip was added, so received quantities were not checked.');
  const w = $('rcWarn'); w.replaceChildren(); for (const m of r.warnings) w.append(el('li', '', m)); $('rcWarnPanel').hidden = !r.warnings.length;
  drawTotals(); drawLines();
  const other = r.otherSlips.map(o => ({ NDC11: o.ndc11, Description: o.description, Order: o.order || 'not read', PO: o.po, Vials: o.qty }));
  $('rcOtherPanel').hidden = !other.length;
  if (other.length) table('rcOther', other, [{ label: 'NDC11', value: x => x.NDC11, mono: true }, { label: 'Description', value: x => x.Description }, { label: 'Order #', value: x => x.Order, mono: true }, { label: 'PO on slip', value: x => x.PO }, { label: 'Vials', value: x => x.Vials, numeric: true }]);
  $('rcResults').scrollIntoView({ block: 'start', behavior: 'smooth' });
}
function drawTotals() {
  const r = result;
  const po = r.poChecks.map(b => ({ PO: b.po, Ordered: money(b.ordC), Invoiced: money(b.invC), Difference: money(b.diffC), Result: b.ok ? 'MATCH' : (b.invoices ? 'MISMATCH' : 'REVIEW'), _o: b.ordC, _i: b.invC, _d: b.diffC }));
  table('rcPOs', po, [
    { label: 'PO', value: x => x.PO }, { label: 'Ordered', value: x => x.Ordered, sort: x => x._o, numeric: true }, { label: 'Invoiced', value: x => x.Invoiced, sort: x => x._i, numeric: true },
    { label: 'Difference', value: x => x.Difference, sort: x => x._d, numeric: true }, { label: 'Result', value: x => x.Result, badge: true }], rowClass);
  const docs = r.docs.map(d => ({ Document: d.type, Number: d.no, PO: d.po, Stated: d.statedC === null ? 'not found' : money(d.statedC), Lines: money(d.computedC), Result: d.linesOk === null ? 'REVIEW' : d.linesOk ? 'MATCH' : 'MISMATCH', _s: d.statedC ?? 0, _c: d.computedC }));
  table('rcDocs', docs, [
    { label: 'Document', value: x => x.Document }, { label: 'Number', value: x => x.Number, mono: true }, { label: 'PO', value: x => x.PO },
    { label: 'Stated total', value: x => x.Stated, sort: x => x._s, numeric: true }, { label: 'Line items add to', value: x => x.Lines, sort: x => x._c, numeric: true }, { label: 'Result', value: x => x.Result, badge: true }], rowClass);
}
function drawLines() {
  const r = result, q = $('rcSearch').value.toLowerCase().trim(), f = $('rcFilter').value;
  const rows = r.lines.filter(l => (!f || (f === 'attention' ? l.status !== 'MATCH' : l.status === f)) && (!q || (l.name + ' ' + l.ndc11 + ' ' + l.detail + ' ' + l.pos.join(' ')).toLowerCase().includes(q)))
    .map(l => ({ Status: l.status, Drug: l.name, NDC11: l.ndc11, Ordered: l.ordQty, Invoiced: l.invQty, Received: l.rcvQty === null ? 'N/A' : l.rcvQty, Other: l.otherQty === null ? 'N/A' : l.otherQty, OrdC: l.ordC, InvC: l.invC, Issues: l.detail }));
  table('rcLines', rows, [
    { label: 'Status', value: x => x.Status, badge: true }, { label: 'Drug', value: x => x.Drug }, { label: 'NDC11', value: x => x.NDC11, mono: true },
    { label: 'Ordered', numeric: true, value: x => x.Ordered }, { label: 'Invoiced', numeric: true, value: x => x.Invoiced },
    { label: 'Received', numeric: true, value: x => x.Received, sort: x => x.Received === 'N/A' ? -1 : x.Received },
    { label: 'On other orders', numeric: true, value: x => x.Other, sort: x => x.Other === 'N/A' ? -1 : x.Other },
    { label: 'Ordered $', numeric: true, value: x => money(x.OrdC), sort: x => x.OrdC }, { label: 'Invoiced $', numeric: true, value: x => money(x.InvC), sort: x => x.InvC },
    { label: 'Issues', value: x => x.Issues }], rowClass);
  $('rcCount').textContent = rows.length + ' of ' + r.lines.length + ' lines shown.';
}
$('rcSearch').oninput = () => result && drawLines();
$('rcFilter').onchange = () => result && drawLines();

// ---------- Excel export ----------
const sheetXlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const RESULT_HEAD = ['NDC', 'Drug Name', 'Match Status', 'Qty Ordered', 'Qty Invoiced', 'Qty Received', 'Amount Ordered', 'Amount Invoiced', 'Qty On Other Orders (Slip)', 'Issue Codes', 'Issue Detail', 'PO(s)', 'Order #(s)'];
const OTHER_HEAD = ['NDC', 'Description', 'Order # on Slip', 'PO on Slip', 'Vials'];
const MONEY_FMT = '_($* #,##0.00_)';
const resultRows = r => r.lines.map(l => [l.ndc11, l.name, l.status, l.ordQty, l.invQty, l.rcvQty === null ? 'N/A' : l.rcvQty, l.ordC / 100, l.invC / 100, l.otherQty === null ? 'N/A' : l.otherQty, l.codes, l.detail, l.pos.join(', '), l.orderNos.join(', ')]);
const otherRows = r => r.otherSlips.map(o => [o.ndc11, o.description, o.order || 'not read', o.po, o.qty]);
function summaryItems(r) {
  const t = r.totals, c = r.counts, it = [];
  const add = (cells, kind, moneyCols) => it.push({ cells, kind: kind || 'row', moneyCols: moneyCols || [] });
  add(['OncoScan reconciliation'], 'title');
  add(['Generated (UTC)', r.generatedAt]);
  add(['Files read', r.fileCounts.order + ' order history, ' + r.fileCounts.invoice + ' invoice(s), ' + r.fileCounts.slip + ' packing slip PDF(s)']);
  add(['Overall', r.ok ? 'All lines match and totals agree' : 'Needs attention']);
  add(['Lines checked', c.lines]); add(['MATCH', c.match]); add(['REVIEW', c.review]); add(['MISMATCH', c.mismatch]);
  add(['Total ordered', t.ordC / 100], 'row', [1]); add(['Total invoiced', t.invC / 100], 'row', [1]); add(['Difference (invoiced - ordered)', t.diffC / 100], 'row', [1]);
  add([]); add(['PO totals'], 'sub'); add(['PO', 'Ordered', 'Invoiced', 'Difference', 'Result'], 'head');
  for (const b of r.poChecks) add([b.po, b.ordC / 100, b.invC / 100, b.diffC / 100, b.ok ? 'MATCH' : (b.invoices ? 'MISMATCH' : 'REVIEW')], 'row', [1, 2, 3]);
  add([]); add(['Document totals'], 'sub'); add(['Document', 'Number', 'PO', 'Stated total', 'Line items add to', 'Result'], 'head');
  for (const d of r.docs) add([d.type, d.no, d.po, d.statedC === null ? 'not found' : d.statedC / 100, d.computedC / 100, d.linesOk === null ? 'REVIEW' : d.linesOk ? 'MATCH' : 'MISMATCH'], 'row', [3, 4]);
  if (r.warnings.length) { add([]); add(['Notes from reading the files'], 'sub'); for (const w of r.warnings) add([w]); }
  add([]); add(['How to read the status'], 'sub');
  add(['MATCH', 'Ordered, invoiced and (when a slip is added) received quantities agree, and invoiced dollars equal ordered dollars.']);
  add(['REVIEW', 'No hard error, but a person should look: the slip lists the same drug under another order number, or the order history shows a short ship.']);
  add(['MISMATCH', 'A quantity, unit price or dollar amount differs, the drug was not ordered, or fewer vials are on the slip than ordered (it may ship separately from another distribution center).']);
  return it;
}
function loadScript(src) { return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('Could not load the Excel formatting library.')); document.head.append(s); }); }
async function getExcelJS() { if (window.ExcelJS) return window.ExcelJS; await loadScript('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js'); if (!window.ExcelJS) throw new Error('Excel formatting library unavailable.'); return window.ExcelJS; }
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
const solid = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const cfRule = (text, fill, font) => ({ type: 'cellIs', operator: 'equal', formulae: ['"' + text + '"'], style: { font: { color: { argb: font } }, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: fill } } } });

async function buildStyled(r, fileName) {
  const X = await getExcelJS(), wb = new X.Workbook(); wb.creator = 'OncoScan'; wb.created = new Date();
  const ws = wb.addWorksheet('Reconciliation Results', { views: [{ state: 'frozen', ySplit: 1 }] }), rows = resultRows(r), last = rows.length + 1;
  if (rows.length) {
    ws.addTable({ name: 'ReconTable', ref: 'A1', headerRow: true, totalsRow: false, style: { theme: 'TableStyleMedium9', showRowStripes: true }, columns: RESULT_HEAD.map(n => ({ name: n, filterButton: true })), rows });
    for (let i = 2; i <= last; i++) for (const col of [7, 8]) ws.getCell(i, col).numFmt = MONEY_FMT;
    ws.addConditionalFormatting({ ref: 'C2:C' + last, rules: [cfRule('MATCH', 'FFC6EFCE', 'FF006100'), cfRule('MISMATCH', 'FFFFC7CE', 'FF9C0006'), cfRule('REVIEW', 'FFFFEB9C', 'FF9C5700')] });
    const tr = last + 1, lab = ws.getCell(tr, 6); lab.value = 'GRAND TOTAL:'; lab.font = { bold: true };
    const o = ws.getCell(tr, 7), v = ws.getCell(tr, 8);
    o.value = { formula: 'SUM(G2:G' + last + ')', result: r.lines.reduce((n, l) => n + l.ordC, 0) / 100 }; v.value = { formula: 'SUM(H2:H' + last + ')', result: r.lines.reduce((n, l) => n + l.invC, 0) / 100 };
    for (const c of [o, v]) { c.font = { bold: true }; c.numFmt = MONEY_FMT; }
  }
  [15, 40, 14, 12, 13, 13, 17, 17, 16, 28, 70, 28, 24].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  for (let i = 2; i <= last; i++) ws.getCell(i, 11).alignment = { wrapText: true, vertical: 'top' };
  const sm = wb.addWorksheet('Summary');
  for (const it of summaryItems(r)) {
    const row = sm.addRow(it.cells);
    if (it.kind === 'title') row.getCell(1).font = { bold: true, size: 14 };
    else if (it.kind === 'sub') row.getCell(1).font = { bold: true, size: 12 };
    else if (it.kind === 'head') row.eachCell(c => { c.font = { bold: true }; c.fill = solid('FFDCE6F1'); });
    for (const k of it.moneyCols) row.getCell(k + 1).numFmt = MONEY_FMT;
  }
  [34, 22, 24, 18, 20, 14].forEach((w, i) => { sm.getColumn(i + 1).width = w; });
  const orows = otherRows(r);
  if (orows.length) {
    const ow = wb.addWorksheet('Other Orders on Slip');
    ow.addTable({ name: 'OtherSlipTable', ref: 'A1', headerRow: true, totalsRow: false, style: { theme: 'TableStyleMedium9', showRowStripes: true }, columns: OTHER_HEAD.map(n => ({ name: n, filterButton: true })), rows: orows });
    [15, 44, 18, 24, 10].forEach((w, i) => { ow.getColumn(i + 1).width = w; });
  }
  download(new Blob([await wb.xlsx.writeBuffer()], { type: sheetXlsx }), fileName);
}
function buildPlain(r, fileName) {
  if (!window.XLSX) throw new Error('Excel library did not load');
  const wb = XLSX.utils.book_new();
  const rs = XLSX.utils.aoa_to_sheet([RESULT_HEAD, ...resultRows(r)]); rs['!cols'] = [15, 40, 14, 12, 13, 13, 17, 17, 16, 28, 70, 28, 24].map(wch => ({ wch })); XLSX.utils.book_append_sheet(wb, rs, 'Reconciliation Results');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryItems(r).map(i => i.cells)), 'Summary');
  if (r.otherSlips.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([OTHER_HEAD, ...otherRows(r)]), 'Other Orders on Slip');
  XLSX.writeFile(wb, fileName);
}
function exportName(r) {
  const pos = [...new Set(r.poChecks.map(b => b.po).filter(p => p && p !== '(none)'))].join('_');
  const safe = [...pos].filter(c => /[A-Za-z0-9_-]/.test(c)).join('');
  return 'Reconciliation_PO_' + (safe || 'Multi_PO_Export') + '.xlsx';
}
$('rcExport').onclick = async () => {
  if (!result || busy) return;
  const b = $('rcExport'); b.disabled = true; const name = exportName(result);
  try { await buildStyled(result, name); note('Excel report saved.'); }
  catch (e) {
    try { buildPlain(result, name); note('Saved without colors and table styling (' + e.message + ').', true); }
    catch (e2) { note(e2.message, true); }
  } finally { b.disabled = !result; }
};

for (const k of KINDS) renderFiles(k);
sync();
})();
