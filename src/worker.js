// Oncology scanner prototype 0.2.0. Bindings: DB, ASSETS.
// Secrets: APP_USER / APP_PASSWORD (ASCII). No patient data.
// Optional SCAN_SEPARATOR: one deliberately configured printable FN1 substitute (e.g. |).
const VERSION = 'prototype-0.2.0';
class AppError extends Error {
  constructor(message, code = 'VALIDATION', status = 400, details = {}) {
    super(message); Object.assign(this, { code, status, details });
  }
}
function requireValue(ok, message, code, status, details) {
  if (!ok) throw new AppError(message, code, status, details);
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' } });
}
async function hash(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
    .map(v => v.toString(16).padStart(2, '0')).join('');
}
async function authorized(request, env) {
  return (await hash(request.headers.get('Authorization') || '')) ===
    await hash('Basic ' + btoa(env.APP_USER + ':' + env.APP_PASSWORD));
}
function parseScan(raw, substitute = '') {
  // Supported separatorless profile: (01) GTIN (21) serial (17) expiry (10) lot.
  // A unique result is unique within this profile, not proof of the original encoding.
  function fail(message, code = 'PARSE_ERROR') {
    throw new AppError(message, code, 400);
  }
  function validate(fields) {
    const gtin = fields['01'];
    if (!/^\d{14}$/.test(gtin || '')) fail('GTIN must contain 14 digits.');
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += Number(gtin[i]) * (i % 2 === 0 ? 3 : 1);
    if ((10 - sum % 10) % 10 !== Number(gtin[13])) fail('GTIN check digit failed.');
    if (!/^[\x21-\x7e]{1,20}$/.test(fields['21'] || '')) fail('Serial must contain 1-20 printable characters.');
    if (!/^[\x21-\x7e]{1,20}$/.test(fields['10'] || '')) fail('Lot must contain 1-20 printable characters.');
    const encoded = fields['17'] || '';
    if (!/^\d{6}$/.test(encoded)) fail('Expiration must contain 6 digits.');
    const year = 2000 + Number(encoded.slice(0, 2));
    const month = Number(encoded.slice(2, 4));
    if (month < 1 || month > 12) fail('Invalid expiration month.');
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    let day = Number(encoded.slice(4, 6));
    if (day === 0) day = last;
    if (day < 1 || day > last) fail('Invalid expiration day.');
    return {
      gtin,
      serial: fields['21'],
      lot: fields['10'],
      expiration: [year, String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-')
    };
  }

  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) {
    fail('Scan must contain 1-512 characters.');
  }
  let s = raw.replace(/[\r\n]+$/g, '');
  if (s.startsWith(']d2')) s = s.slice(3);
  s = s.replace(/<GS>/g, '\x1d');
  if (substitute) {
    if (substitute.length !== 1 || !/^[\x21-\x7e]$/.test(substitute)) {
      fail('Invalid configured SCAN_SEPARATOR.');
    }
    s = s.split(substitute).join('\x1d');
  }

  // No separator: apply ONLY the explicitly supported manufacturer layout.
  if (!s.includes('\x1d') && /^01\d{14}21/.test(s)) {
    const gtin = s.slice(2, 16);
    const tail = s.slice(18);
    const candidates = [];

    for (let boundary = 1; boundary <= 20; boundary++) {
      // After serial: 17 + YYMMDD + 10 + lot.
      if (tail.slice(boundary, boundary + 2) !== '17') continue;
      if (tail.slice(boundary + 8, boundary + 10) !== '10') continue;
      const serial = tail.slice(0, boundary);
      const encoded = tail.slice(boundary + 2, boundary + 8);
      const lot = tail.slice(boundary + 10);
      if (!/^\d{6}$/.test(encoded) || !lot.length || lot.length > 20) continue;
      try {
        candidates.push(validate({ '01': gtin, '21': serial, '17': encoded, '10': lot }));
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    }

    if (candidates.length === 0) {
      fail('Scan does not fit the supported separatorless layout (01 GTIN, 21 serial, 17 expiration, 10 lot), or an identifier/date is invalid. No inventory saved.', 'UNSUPPORTED_RAW_LAYOUT');
    }
    if (candidates.length > 1) {
      fail('More than one serial/expiration/lot interpretation fits this raw scan. Check the printed label or scanner configuration; no inventory saved.', 'AMBIGUOUS_RAW_SCAN');
    }
    return {
      ...candidates[0],
      parseMode: 'separatorless-01-21-17-10',
      parseWarning: 'Field boundaries reconstructed using the supported 01/21/17/10 layout.'
    };
  }

  // Normal GS1 parsing when separators are supplied, or when no reconstruction is needed.
  const fields = {};
  while (s.length) {
    if (s[0] === '\x1d') { s = s.slice(1); continue; }
    const ai = s.slice(0, 2);
    s = s.slice(2);
    if (!['01', '17', '10', '21'].includes(ai)) fail('Unsupported AI or missing separator near ' + ai);
    if (fields[ai] !== undefined) fail('Duplicate AI ' + ai);
    if (ai === '01' || ai === '17') {
      const n = ai === '01' ? 14 : 6;
      if (!new RegExp('^\\d{' + n + '}').test(s)) fail('Invalid fixed-length AI ' + ai);
      fields[ai] = s.slice(0, n);
      s = s.slice(n);
    } else {
      const end = s.indexOf('\x1d');
      fields[ai] = end < 0 ? s : s.slice(0, end);
      s = end < 0 ? '' : s.slice(end + 1);
      if (!/^[\x21-\x7e]{1,20}$/.test(fields[ai])) {
        fail('Missing separator or invalid lot/serial. This field order is not supported for separatorless reconstruction.', 'UNSUPPORTED_RAW_LAYOUT');
      }
    }
  }
  if (!['01', '17', '10', '21'].every(key => fields[key])) {
    fail('Need GTIN, serial, expiration and lot. Unsupported layout or missing field separator.', 'UNSUPPORTED_RAW_LAYOUT');
  }
  return { ...validate(fields), parseMode: 'gs1-fields' };
}
function ndcCandidates(gtin) {
  // Only recognized, zero-indicator legacy US pharmaceutical GTINs.
  // Other GTIN structures require an exact, reviewed mapping.
  if (!/^003\d{11}$/.test(gtin)) return { ndc10: null, candidates: [] };
  const n=gtin.slice(3,13);
  return {ndc10:n,candidates:[...new Set([
    '0'+n, // 4-4-2 -> 5-4-2
    n.slice(0,5)+'0'+n.slice(5), // 5-3-2 -> 5-4-2
    n.slice(0,9)+'0'+n.slice(9) // 5-4-1 -> 5-4-2
  ])]};
}
function supplierNDC(value) {
  // This import is explicitly a supplier 11-digit-format report.
  // Restore leading zeros lost by spreadsheet numeric formatting; never apply this to scanned NDC10.
  let s=String(value??'').trim();
  if (/^\d{5}-\d{4}-\d{2}$/.test(s)) return s.replace(/-/g,'');
  if (/^\d+(?:\.\d+)?[eE][+]?\d+$/.test(s)) {
    const n=Number(s); requireValue(Number.isSafeInteger(n),'Invalid scientific-notation NDC.');s=String(n);
  }
  requireValue(/^\d{1,11}$/.test(s),'Supplier NDC must represent an 11-digit value.');
  return s.padStart(11,'0');
}
function manualNDC(value) {
  const s=String(value??'').trim();
  requireValue(/^\d{11}$/.test(s)||/^\d{5}-\d{4}-\d{2}$/.test(s),'Enter an 11-digit NDC (or 5-4-2 hyphenated NDC).');
  return s.replace(/-/g,'');
}
function productRow(r) {
  const abc=String(r.abc??'').trim(),description=String(r.description??'').trim(),original=String(r.ndc??'').trim();
  requireValue(/^\d{1,30}$/.test(abc),'Invalid supplier ABC number.');
  requireValue(description.length>0&&description.length<=300,'Description is required (maximum 300 characters).');
  return {abc,description,ndc_original:original,ndc11:supplierNDC(original)};
}
function displayABC(abc) { return abc.startsWith('MANUAL-') ? '' : abc; }
function publicProduct(p) {return {abc:displayABC(p.abc),description:p.description,ndc11:p.ndc11,libraryId:p.abc};}
async function resolveProduct(db, parsed) {
  const mapped=await db.prepare('SELECT p.* FROM gtin_mappings m JOIN products p ON p.abc=m.product_abc WHERE m.gtin=?').bind(parsed.gtin).first();
  const candidateInfo=ndcCandidates(parsed.gtin);
  if(mapped)return {product:mapped,method:'exact GTIN mapping',supplierEntries:1,...candidateInfo};
  if(!candidateInfo.candidates.length)return {product:null,reason:'UNKNOWN_PRODUCT',...candidateInfo};
  const marks=candidateInfo.candidates.map(()=>'?').join(',');
  const rows=(await db.prepare('SELECT * FROM products WHERE ndc11 IN ('+marks+') ORDER BY abc').bind(...candidateInfo.candidates).all()).results;
  const ndcs=[...new Set(rows.map(r=>r.ndc11))];
  if(ndcs.length===1) {
    // Same NDC, multiple supplier catalog records: retain all library rows and use a stable representative.
    rows.sort((a,b)=>Number(a.abc.startsWith('MANUAL-'))-Number(b.abc.startsWith('MANUAL-'))||a.abc.localeCompare(b.abc));
    return {product:rows[0],method:'unique library NDC match',supplierEntries:rows.length,...candidateInfo};
  }
  return {product:null,reason:ndcs.length?'AMBIGUOUS_MATCH':'UNKNOWN_PRODUCT',matches:rows.map(publicProduct),...candidateInfo};
}
async function existingVial(db,p) {
  return db.prepare('SELECT * FROM events WHERE gtin=? AND serial=? ORDER BY seq DESC LIMIT 1').bind(p.gtin,p.serial).first();
}
const INVENTORY_SQL=`SELECT e.gtin,e.serial,e.lot,e.expiration,e.product_abc,p.description,p.ndc11,
 CASE WHEN e.action='PULL' THEN 'Out' ELSE 'In stock' END AS status,
 e.action AS last_action,e.created_at AS last_action_at,
 s.scanned_in_at,s.last_scanned_out_at,s.last_returned_at,s.pull_count,s.return_count
 FROM events e JOIN products p ON p.abc=e.product_abc
 JOIN (SELECT gtin,serial,
 MIN(CASE WHEN action='RECEIVE' THEN created_at END) AS scanned_in_at,
 MAX(CASE WHEN action='PULL' THEN created_at END) AS last_scanned_out_at,
 MAX(CASE WHEN action='RETURN' THEN created_at END) AS last_returned_at,
 SUM(CASE WHEN action='PULL' THEN 1 ELSE 0 END) AS pull_count,
 SUM(CASE WHEN action='RETURN' THEN 1 ELSE 0 END) AS return_count
 FROM events GROUP BY gtin,serial) s ON s.gtin=e.gtin AND s.serial=e.serial
 WHERE e.seq=(SELECT MAX(r.seq) FROM events r WHERE r.gtin=e.gtin AND r.serial=e.serial)
 ORDER BY p.description,e.expiration,e.serial`;
export default {
 async fetch(request,env) {
  const security={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};
  try {
   const url=new URL(request.url);
   if(request.method==='GET'&&url.pathname==='/health')return json({ok:true,application:'onco-infusion-scan',version:VERSION});
   if(!env.APP_USER||!env.APP_PASSWORD)return new Response('Configure APP_USER and APP_PASSWORD secrets.',{status:503,headers:security});
   if(!await authorized(request,env))return new Response('Sign in required',{status:401,headers:{...security,'WWW-Authenticate':'Basic realm="Infusion scanner", charset="UTF-8"'}});
   if(!(url.pathname==='/api'||url.pathname.startsWith('/api/'))) {
    if(!['GET','HEAD'].includes(request.method))return json({error:'Not found'},404);
    requireValue(env.ASSETS,'Missing ASSETS binding.');
    const a=await env.ASSETS.fetch(request),r=new Response(a.body,a);
    for(const [k,v]of Object.entries(security))r.headers.set(k,v);
    r.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self' https://cdn.sheetjs.com; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");return r;
   }
   requireValue(env.DB,'Missing DB binding.');
   if(request.method==='GET'&&url.pathname==='/api/data') {
    const r=await env.DB.batch([
     env.DB.prepare('SELECT * FROM products ORDER BY description,abc'),env.DB.prepare(INVENTORY_SQL),
     env.DB.prepare('SELECT e.*,p.description,p.ndc11 FROM events e JOIN products p ON p.abc=e.product_abc ORDER BY e.seq DESC')]);
    return json({products:r[0].results,inventory:r[1].results,activity:r[2].results,version:VERSION});
   }
   if(request.method!=='POST')return json({error:'Not found'},404);
   requireValue(request.headers.get('Origin')===url.origin,'Cross-origin or missing-origin write rejected.');
   requireValue((request.headers.get('Content-Type')||'').startsWith('application/json'),'JSON required.');
   const text=await request.text();requireValue(text.length<=1000000,'Request too large.');const b=JSON.parse(text);
   if(url.pathname==='/api/import') {
    requireValue(Array.isArray(b.rows)&&b.rows.length>0&&b.rows.length<=2000,'Import 1-2000 rows.');
    const unique=new Map();
    for(const row of b.rows){const r=productRow(row),p=unique.get(r.abc);requireValue(!p||(p.ndc11===r.ndc11&&p.description===r.description),'Conflicting duplicate ABC '+r.abc);unique.set(r.abc,r);}
    const rows=[...unique.values()],old=new Map((await env.DB.prepare('SELECT * FROM products').all()).results.map(p=>[p.abc,p]));
    for(const r of rows){const p=old.get(r.abc);requireValue(!p||(p.ndc11===r.ndc11&&p.description===r.description),'Existing ABC conflicts: '+r.abc+'. Nothing imported by this request yet.');}
    let inserted=0;
    for(let i=0;i<rows.length;i+=50){const results=await env.DB.batch(rows.slice(i,i+50).map(r=>env.DB.prepare('INSERT INTO products(abc,description,ndc_original,ndc11) VALUES(?,?,?,?) ON CONFLICT(abc) DO NOTHING').bind(r.abc,r.description,r.ndc_original,r.ndc11)));inserted+=results.reduce((n,r)=>n+(r.meta.changes||0),0);}
    return json({inserted,skipped:rows.length-inserted,duplicates:b.rows.length-rows.length});
   }
   if(url.pathname==='/api/inspect') {
    const p=parseScan(b.raw,env.SCAN_SEPARATOR||''),existing=await existingVial(env.DB,p);
    if(existing){const product=await env.DB.prepare('SELECT * FROM products WHERE abc=?').bind(existing.product_abc).first();return json({...p,match:{...publicProduct(product),method:'existing vial'},currentStatus:existing.action==='PULL'?'Out':'In stock'});}
    const m=await resolveProduct(env.DB,p);
    return json({...p,ndc10:m.ndc10,candidates:m.candidates,match:m.product?{...publicProduct(m.product),method:m.method,supplierEntries:m.supplierEntries}:null,reason:m.reason,matches:m.matches});
   }
   if(url.pathname==='/api/products/add') {
    requireValue(b.action==='RECEIVE','Add an unknown product during Receive only.');
    const p=parseScan(b.raw,env.SCAN_SEPARATOR||''),ndc=manualNDC(b.ndc),description=String(b.description??'').trim();
    requireValue(description.length>0&&description.length<=300,'Enter medication name, strength and package description (maximum 300 characters).');
    const c=ndcCandidates(p.gtin);
    requireValue(!c.candidates.length||c.candidates.includes(ndc),'Entered NDC does not correspond to any valid conversion of this scanned GTIN. Check the physical label.');
    const abcInput=String(b.abc??'').trim();requireValue(!abcInput||/^\d{1,30}$/.test(abcInput),'ABC number must be digits or blank.');
    const mapped=await env.DB.prepare('SELECT p.* FROM gtin_mappings m JOIN products p ON p.abc=m.product_abc WHERE m.gtin=?').bind(p.gtin).first();
    if(mapped){requireValue(mapped.ndc11===ndc,'This GTIN is already mapped to another NDC.');return json({product:publicProduct(mapped),alreadyMapped:true});}
    // Reuse an existing entry with the chosen NDC when possible.
    let product=abcInput?await env.DB.prepare('SELECT * FROM products WHERE abc=?').bind(abcInput).first():null;
    if(product)requireValue(product.ndc11===ndc&&product.description===description,'ABC already exists with different details; no changes made.');
    if(!product&&!abcInput)product=await env.DB.prepare('SELECT * FROM products WHERE ndc11=? ORDER BY abc LIMIT 1').bind(ndc).first();
    const abc=product?product.abc:abcInput||'MANUAL-'+crypto.randomUUID();
    const statements=[];
    if(!product)statements.push(env.DB.prepare('INSERT INTO products(abc,description,ndc_original,ndc11) VALUES(?,?,?,?)').bind(abc,description,ndc,ndc));
    statements.push(env.DB.prepare('INSERT INTO gtin_mappings(gtin,product_abc) VALUES(?,?)').bind(p.gtin,abc));
    await env.DB.batch(statements);
    return json({product:publicProduct(product||{abc,description,ndc11:ndc}),added:!product});
   }
   if(url.pathname==='/api/scan') {
    requireValue(['RECEIVE','PULL','RETURN'].includes(b.action),'Invalid action.');
    requireValue(typeof b.requestId==='string'&&/^[0-9a-f-]{36}$/i.test(b.requestId),'Invalid request ID.');
    const p=parseScan(b.raw,env.SCAN_SEPARATOR||''),requestHash=await hash(JSON.stringify([b.raw,b.action]));
    const prior=await env.DB.prepare('SELECT * FROM events WHERE request_id=?').bind(b.requestId).first();
    if(prior){requireValue(prior.request_hash===requestHash,'Request ID reused with different content.');const product=await env.DB.prepare('SELECT * FROM products WHERE abc=?').bind(prior.product_abc).first();return json({saved:true,replayed:true,...p,product:publicProduct(product)});}
    const existing=await existingVial(env.DB,p);let product;
    if(existing)product=await env.DB.prepare('SELECT * FROM products WHERE abc=?').bind(existing.product_abc).first();
    else {
     requireValue(b.action==='RECEIVE','This vial has not been received. Pull/Return cannot create new inventory.','UNKNOWN_VIAL');
     const m=await resolveProduct(env.DB,p);
     requireValue(m.product,m.reason==='AMBIGUOUS_MATCH'?'More than one NDC matches. Resolve the package NDC before receiving.':'Product not found. Add it to the library before receiving.',m.reason,409,{parsed:p,ndc10:m.ndc10,candidates:m.candidates,matches:m.matches||[]});product=m.product;
    }
    await env.DB.prepare('INSERT INTO events(request_id,request_hash,action,gtin,serial,lot,expiration,product_abc,raw_scan) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(b.requestId,requestHash,b.action,p.gtin,p.serial,p.lot,p.expiration,product.abc,b.raw).run();
    return json({saved:true,...p,product:publicProduct(product),status:b.action==='PULL'?'Out':'In stock'});
   }
   return json({error:'Not found'},404);
  }catch(e){return json({error:String(e.message||e).replace(/^D1_ERROR:\s*/,''),code:e.code||'REQUEST_ERROR',...(e.details||{})},e.status||400);}
 }
};
