// Frontend extraction only. Scan parsing and inventory behavior are unchanged.
// Required bindings: DB (D1), ASSETS (static assets).
// Required secrets: APP_USER, APP_PASSWORD (ASCII-only for this prototype).
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});
function need(ok, message) { if (!ok) throw new Error(message); }
async function digest(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
    .map(x => x.toString(16).padStart(2, '0')).join('');
}
async function authorized(request, env) {
  if (!env.APP_USER || !env.APP_PASSWORD) return false;
  const expected = 'Basic ' + btoa(env.APP_USER + ':' + env.APP_PASSWORD);
  return (await digest(request.headers.get('Authorization') || '')) === await digest(expected);
}
function parseScan(input) {
  need(typeof input === 'string' && input.length <= 512, 'Scan must be text, at most 512 characters');
  let remaining = input.replace(/[\r\n]+$/g, '');
  if (remaining.startsWith(']d2')) remaining = remaining.slice(3);
  const fields = {};
  while (remaining.length) {
    if (remaining[0] === '\x1d') { remaining = remaining.slice(1); continue; }
    const ai = remaining.slice(0, 2); remaining = remaining.slice(2);
    need(['01', '17', '10', '21'].includes(ai), 'Unsupported field or missing GS separator near AI ' + ai);
    need(fields[ai] === undefined, 'Duplicate barcode field ' + ai);
    if (ai === '01' || ai === '17') {
      const length = ai === '01' ? 14 : 6;
      need(new RegExp('^\\d{' + length + '}').test(remaining), 'Invalid fixed-length field ' + ai);
      fields[ai] = remaining.slice(0, length); remaining = remaining.slice(length);
    } else {
      const end = remaining.indexOf('\x1d');
      fields[ai] = end < 0 ? remaining : remaining.slice(0, end);
      remaining = end < 0 ? '' : remaining.slice(end + 1);
      need(/^[\x21-\x7e]{1,20}$/.test(fields[ai]), 'Invalid lot/serial or missing GS separator');
    }
  }
  need(['01', '17', '10', '21'].every(k => fields[k]),
    'Need GTIN, expiration, lot and serial. A GS separator may be missing after a variable-length field.');
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(fields['01'][i]) * (i % 2 === 0 ? 3 : 1);
  need((10 - sum % 10) % 10 === Number(fields['01'][13]), 'GTIN check digit failed');
  const year = 2000 + Number(fields['17'].slice(0, 2));
  const month = Number(fields['17'].slice(2, 4));
  let day = Number(fields['17'].slice(4, 6));
  need(month >= 1 && month <= 12, 'Invalid expiration month');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day === 0) day = last;
  need(day >= 1 && day <= last, 'Invalid expiration day');
  return { gtin: fields['01'], serial: fields['21'], lot: fields['10'],
    expiration: [year, String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-') };
}
function productRow(row, approved) {
  need(row && typeof row === 'object', 'Invalid library row');
  const abc = String(row.abc || '').trim(), description = String(row.description || '').trim();
  const original = String(row.ndc || '').trim();
  need(/^\d{1,30}$/.test(abc), 'Invalid ABC number');
  need(description.length > 0 && description.length <= 300, 'Missing/overlong description');
  let ndc = original;
  if (/^\d{1,5}-\d{1,4}-\d{1,2}$/.test(ndc)) {
    const parts = ndc.split('-');
    need(['5-4-2', '4-4-2', '5-3-2', '5-4-1'].includes(parts.map(p => p.length).join('-')), 'Unsupported hyphenated NDC');
    ndc = parts.map((p, i) => p.padStart([5, 4, 2][i], '0')).join('');
  } else {
    if (/^[0-9]+(?:\.[0-9]+)?[eE][+]?[0-9]+$/.test(ndc)) {
      const n = Number(ndc);
      need(Number.isSafeInteger(n), 'NDC scientific notation is not an exact integer');
      ndc = String(n);
    }
    need(/^\d{1,11}$/.test(ndc), 'NDC must contain at most 11 digits');
    if (ndc.length < 11) {
      need(approved === true, 'Short NDC: approve 11-digit source/leading-zero restoration first');
      ndc = ndc.padStart(11, '0');
    }
  }
  return { abc, description, ndc_original: original, ndc11: ndc };
}
export default {
  async fetch(request, env) {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health')
        return json({ ok: true, application: 'onco-infusion-scan', version: 'prototype-0.1.2', frontend: 'github-static-assets' });
      if (!env.APP_USER || !env.APP_PASSWORD)
        return new Response('Configure APP_USER and APP_PASSWORD secrets before using this prototype.', { status: 503, headers });
      if (!(await authorized(request, env)))
        return new Response('Sign in required', { status: 401, headers: { ...headers,
          'WWW-Authenticate': 'Basic realm="Infusion scanner", charset="UTF-8"' } });

      // New routing: authenticate first, then serve frontend files via ASSETS.
      // Keep run_worker_first: true in wrangler.jsonc.
      const isAPI = url.pathname === '/api' || url.pathname.startsWith('/api/');
      if (!isAPI) {
        if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Not found' }, 404);
        need(env.ASSETS, 'Static assets binding ASSETS is missing');
        const assetResponse = await env.ASSETS.fetch(request);
        const response = new Response(assetResponse.body, assetResponse);
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
        response.headers.set('Content-Security-Policy',
          "default-src 'self'; script-src 'self' https://cdn.sheetjs.com; style-src 'self'; " +
          "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        return response;
      }
      need(env.DB, 'Bind the D1 database as DB');
      if (request.method === 'GET' && url.pathname === '/api/data') {
        const result = await env.DB.batch([
          env.DB.prepare('SELECT * FROM products ORDER BY description, abc'),
          env.DB.prepare('SELECT * FROM inventory ORDER BY description, expiration, serial'),
          env.DB.prepare('SELECT * FROM events ORDER BY seq DESC')
        ]);
        return json({ products: result[0].results, inventory: result[1].results, activity: result[2].results });
      }
      if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
      need(request.headers.get('Origin') === url.origin, 'Cross-origin or missing-origin write rejected');
      need((request.headers.get('Content-Type') || '').startsWith('application/json'), 'JSON required');
      const text = await request.text(); need(text.length <= 1000000, 'Request exceeds prototype size limit');
      const body = JSON.parse(text);
      if (url.pathname === '/api/parse') return json(parseScan(body.raw));
      if (url.pathname === '/api/import') {
        need(Array.isArray(body.rows) && body.rows.length > 0 && body.rows.length <= 2000, 'Import 1-2000 rows');
        const rows = body.rows.map(r => productRow(r, body.approvePadding));
        const seen = new Map();
        for (const row of rows) {
          const p = seen.get(row.abc);
          need(!p || (p.description === row.description && p.ndc11 === row.ndc11), 'Conflicting duplicate ABC: ' + row.abc);
          seen.set(row.abc, row);
        }
        const existingRows = (await env.DB.prepare('SELECT * FROM products').all()).results;
        const map = new Map(existingRows.map(r => [r.abc, r]));
        for (const row of rows) {
          const p = map.get(row.abc);
          need(!p || (p.description === row.description && p.ndc11 === row.ndc11), 'Existing ABC conflicts; no changes imported: ' + row.abc);
        }
        let inserted = 0;
        for (let i = 0; i < rows.length; i += 50) {
          const results = await env.DB.batch(rows.slice(i, i + 50).map(r => env.DB.prepare(
            'INSERT INTO products (abc, description, ndc_original, ndc11) VALUES (?, ?, ?, ?) ON CONFLICT(abc) DO NOTHING'
          ).bind(r.abc, r.description, r.ndc_original, r.ndc11)));
          inserted += results.reduce((n, r) => n + (r.meta.changes || 0), 0);
        }
        return json({ inserted, skipped: rows.length - inserted });
      }
      if (url.pathname === '/api/scan') {
        need(['RECEIVE', 'PULL', 'RETURN'].includes(body.action), 'Invalid action');
        need(typeof body.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(body.requestId), 'Invalid request ID');
        const parsed = parseScan(body.raw);
        const hash = await digest(JSON.stringify([body.raw, body.action, body.abc || '']));
        const prior = await env.DB.prepare('SELECT * FROM events WHERE request_id = ?').bind(body.requestId).first();
        if (prior) { need(prior.request_hash === hash, 'Request ID reused with different content'); return json({ saved: true, replayed: true, ...parsed }); }
        const existing = await env.DB.prepare('SELECT * FROM events WHERE gtin = ? AND serial = ? ORDER BY seq DESC LIMIT 1')
          .bind(parsed.gtin, parsed.serial).first();
        const abc = existing ? existing.product_abc : String(body.abc || '');
        if (!existing) {
          need(body.action === 'RECEIVE', 'Unknown vial; receive it first');
          need(body.confirmProduct === true, 'Confirm selected library product matches the physical vial');
          need(await env.DB.prepare('SELECT abc FROM products WHERE abc = ?').bind(abc).first(), 'Choose a library product');
        }
        await env.DB.prepare('INSERT INTO events (request_id, request_hash, action, gtin, serial, lot, expiration, product_abc, raw_scan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(body.requestId, hash, body.action, parsed.gtin, parsed.serial, parsed.lot, parsed.expiration, abc, body.raw).run();
        return json({ saved: true, ...parsed });
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: String(error.message || error).replace(/^D1_ERROR:\s*/, '') }, 400);
    }
  }
};
