// Frontend extraction only; product selection and scan logic remain unchanged.
const $ = id => document.getElementById(id);
let data = { products: [], inventory: [], activity: [] };
let preview = [], previewPadding = false, pending = null, busy = false;
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Request failed');
  return result;
}
function status(text, error = false) {
  $('status').textContent = text; $('status').className = error ? 'error' : 'ok';
}
function table(target, rows, columns) {
  const element = document.createElement('table'), heading = element.createTHead().insertRow();
  for (const key of columns) { const c = document.createElement('th'); c.textContent = key; heading.append(c); }
  const body = element.createTBody();
  for (const row of rows) { const tr = body.insertRow(); for (const key of columns) tr.insertCell().textContent = row[key] ?? ''; }
  $(target).replaceChildren(element);
}
function render() {
  const query = $('search').value.toLowerCase(), filter = $('filter').value;
  const rows = data.inventory.filter(r => (!filter || r.status === filter) && JSON.stringify(r).toLowerCase().includes(query));
  table('inventory', rows, ['description', 'ndc11', 'lot', 'serial', 'expiration', 'status']);
  $('count').textContent = rows.length + ' vials displayed; ' + data.inventory.filter(r => r.status === 'In stock').length + ' total In stock.';
  table('activity', data.activity.slice(0, 100), ['created_at', 'action', 'gtin', 'serial', 'lot']);
}
async function refresh() {
  data = await api('/api/data');
  const selected = $('product').value;
  $('product').replaceChildren(new Option('Choose product', ''));
  for (const p of data.products) $('product').add(new Option(p.description + ' | ' + p.ndc11 + ' | ABC ' + p.abc, p.abc));
  $('product').value = selected; render();
}
function identifier(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw Error('Invalid numeric identifier');
    return String(value);
  }
  return String(value ?? '').trim();
}
function normalizeNDC(value, approved) {
  let ndc = identifier(value);
  if (/^\d+(?:\.\d+)?[eE][+]?\d+$/.test(ndc)) {
    const n = Number(ndc); if (!Number.isSafeInteger(n)) throw Error('Invalid scientific NDC'); ndc = String(n);
  }
  if (ndc.includes('-')) {
    const parts = ndc.split('-'), pattern = parts.map(p => p.length).join('-');
    if (!parts.every(p => /^\d+$/.test(p)) || !['5-4-2', '4-4-2', '5-3-2', '5-4-1'].includes(pattern))
      throw Error('Unsupported NDC pattern');
    return parts.map((p, i) => p.padStart([5, 4, 2][i], '0')).join('');
  }
  if (!/^\d{1,11}$/.test(ndc)) throw Error('Invalid NDC');
  if (ndc.length < 11 && !approved) throw Error('Short NDC: review and approve leading-zero restoration');
  return ndc.padStart(11, '0');
}
function clearPreview() { preview = []; $('import').disabled = true; }
$('file').onchange = clearPreview; $('pad').onchange = clearPreview;
$('preview').onclick = async () => {
  try {
    clearPreview();
    if (!window.XLSX) throw Error('Excel library did not load');
    const file = $('file').files[0]; if (!file) throw Error('Choose an Excel file');
    if (file.size > 5000000) throw Error('Use a file below 5 MB');
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sourceRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true, defval: '' });
    if (!sourceRows.length) throw Error('The first worksheet is empty');
    const headers = sourceRows[0].map(v => String(v).replace(/\s/g, '').toLowerCase());
    if (headers[0] !== 'abc#' || headers[1] !== 'productdescription' || headers[2] !== 'ndc')
      throw Error('Expected columns A: ABC #, B: Product Description, C: NDC');
    previewPadding = $('pad').checked;
    const seen = new Map(), errors = [], good = []; let duplicateRows = 0;
    for (let i = 1; i < sourceRows.length; i++) {
      const source = sourceRows[i]; if (source.every(v => v === '')) continue;
      try {
        const row = { abc: identifier(source[0]), description: String(source[1]).trim(), ndc: identifier(source[2]) };
        if (!/^\d{1,30}$/.test(row.abc) || !row.description) throw Error('Missing/invalid ABC or description');
        const normalized = normalizeNDC(row.ndc, previewPadding);
        if (seen.has(row.abc)) {
          const p = seen.get(row.abc);
          if (p.description !== row.description || p.normalized !== normalized) throw Error('Conflicting duplicate ABC ' + row.abc);
          duplicateRows++; continue;
        }
        seen.set(row.abc, { description: row.description, normalized });
        const existing = data.products.find(p => p.abc === row.abc);
        if (existing && (existing.description !== row.description || existing.ndc11 !== normalized))
          throw Error('Conflicting existing ABC ' + row.abc);
        good.push({ ...row, normalized });
      } catch (e) { errors.push('Row ' + (i + 1) + ': ' + e.message); }
    }
    $('previewText').textContent = good.length + ' unique valid rows; ' + duplicateRows + ' identical duplicates skipped; ' +
      errors.length + ' errors.\n' + errors.slice(0, 30).join('\n') + '\nPreview:\n' + JSON.stringify(good.slice(0, 8), null, 2);
    if (!errors.length && good.length) { preview = good; $('import').disabled = false; }
  } catch (e) { $('previewText').textContent = e.message; }
};
$('import').onclick = async () => {
  if (!preview.length) return; $('import').disabled = true;
  try {
    const r = await api('/api/import', { rows: preview, approvePadding: previewPadding });
    $('previewText').textContent = 'Imported ' + r.inserted + '; skipped ' + r.skipped;
    preview = []; await refresh();
  } catch (e) { $('previewText').textContent = e.message + ' — refresh and preview again before retrying.'; }
};
function diagnostics(raw) {
  $('diagnostic').textContent = 'Raw: ' + raw.replace(/\x1d/g, '<GS>').replace(/\r/g, '<CR>').replace(/\n/g, '<LF>') +
    '\nCharacter codes: ' + Array.from(raw).map(c => c.charCodeAt(0)).join(',');
}
$('diagnose').onclick = async () => {
  const raw = $('raw').value; diagnostics(raw);
  try {
    const parsed = await api('/api/parse', { raw });
    $('diagnostic').textContent += '\nParsed: ' + JSON.stringify(parsed, null, 2);
    status('Parsed only; inventory unchanged.');
  } catch (e) { status(e.message, true); }
};
$('scanForm').onsubmit = async event => {
  event.preventDefault(); if (busy) return;
  const raw = $('raw').value; diagnostics(raw);
  const base = { raw, action: $('action').value, abc: $('product').value, confirmProduct: $('confirm').checked };
  const signature = JSON.stringify(base);
  if (!pending || pending.signature !== signature) pending = { signature, id: crypto.randomUUID() };
  busy = true;
  try {
    const parsed = await api('/api/scan', { ...base, requestId: pending.id });
    $('diagnostic').textContent += '\nSaved: ' + JSON.stringify(parsed, null, 2);
    $('raw').value = ''; pending = null;
    status(base.action + ' saved. ' + (parsed.expiration < new Date().toISOString().slice(0, 10) ? 'WARNING: manufacturer expiration is in the past.' : ''));
    try { await refresh(); }
    catch (e) { status('Scan saved, but refresh failed. Do not scan again; use Refresh.', true); }
  } catch (e) { status(e.message + ' — not confirmed saved. Keep this scan unchanged to retry safely.', true); }
  finally { busy = false; $('raw').focus(); }
};
$('action').onchange = () => { $('raw').focus(); };
$('product').onchange = () => { $('confirm').checked = false; };
$('search').oninput = render; $('filter').onchange = render;
$('refresh').onclick = () => refresh().catch(e => status(e.message, true));
$('export').onclick = async () => {
  try {
    if (!window.XLSX) throw Error('Excel library did not load');
    await refresh(); const workbook = XLSX.utils.book_new();
    for (const [name, rows] of [['Inventory', data.inventory], ['Activity', data.activity], ['Drug Library', data.products]])
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), name);
    XLSX.writeFile(workbook, 'Oncology-Inventory-' + new Date().toISOString().slice(0, 10) + '.xlsx');
  } catch (e) { status(e.message, true); }
};
refresh().catch(e => status(e.message, true));
