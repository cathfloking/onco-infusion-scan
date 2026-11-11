import {need,parseScan,ndcCandidates,productRow,manualNDC,publicProduct} from './parser.js';
import {contextFor,resolveProduct,requestRecord,aliasDisabled} from './matching.js';
import {SERIAL_INVENTORY,LOT_INVENTORY,SERIAL_ACTIVITY,LOT_ACTIVITY} from './queries.js';
import {adminActor,adminData,updateProduct,setArchived,setAliasEnabled} from './admin.js';
const VERSION='prototype-0.4.0';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'}});
async function hash(s){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(v=>v.toString(16).padStart(2,'0')).join('');}
async function authorized(r,e){return await hash(r.headers.get('Authorization')||'')===await hash('Basic '+btoa(e.APP_USER+':'+e.APP_PASSWORD));}
function decorate(r){
 const info=ndcCandidates(r.gtin);
 return{...r,serial:r.serial??null,scanned_ndc11:r.scanned_ndc11??(info.candidates.includes(r.ndc11)?r.ndc11:null),
  ndc10:info.ndc10,status:r.in_stock>0?(r.out_quantity>0?'Mixed':'In stock'):'Out'};
}
async function addProduct(db,b,p){
 need(b.action==='RECEIVE','Add library products during Receive only.');
 const ndc=manualNDC(b.ndc),description=String(b.description??'').trim(),abcInput=String(b.abc??'').trim(),info=ndcCandidates(p.gtin);
 need(description.length>0&&description.length<=300,'Enter medication, strength and package description.');
 need(!abcInput||/^\d{1,30}$/.test(abcInput),'ABC must be digits or blank.');
 need(!info.candidates.length||info.candidates.includes(ndc),'Entered NDC does not correspond to this GTIN. Use the package-alias form for a supplier pack difference.');
 const resolved=await resolveProduct(db,p);
 need(resolved.reason!=='ALIAS_DISABLED','This GTIN has a package alias that an administrator disabled. It cannot be re-associated here.','ALIAS_DISABLED',409);
 if(resolved.product){need((resolved.scanned_ndc11||resolved.product.ndc11)===ndc,'This GTIN is already associated with a different NDC.');return{product:publicProduct(resolved.product),alreadyMapped:true};}
 let product=abcInput?await db.prepare('SELECT * FROM products WHERE abc=? OR supplier_abc=? ORDER BY abc=? DESC LIMIT 1').bind(abcInput,abcInput,abcInput).first():null;
 if(product)need(product.ndc11===ndc&&product.description===description,'ABC already exists with different details.');
 if(!product&&!abcInput)product=await db.prepare('SELECT * FROM products WHERE ndc11=? ORDER BY archived_at IS NOT NULL,abc LIMIT 1').bind(ndc).first();
 need(!product||!product.archived_at,'That library entry is archived. An administrator must unarchive it, or add a different entry.','PRODUCT_ARCHIVED',409);
 const abc=product?product.abc:abcInput||'MANUAL-'+crypto.randomUUID(),statements=[];
 if(!product)statements.push(db.prepare('INSERT INTO products(abc,description,ndc_original,ndc11,supplier_abc) VALUES(?,?,?,?,?)').bind(abc,description,ndc,ndc,abcInput||null));
 statements.push(db.prepare('INSERT INTO gtin_mappings(gtin,product_abc) VALUES(?,?)').bind(p.gtin,abc));
 await db.batch(statements);return{product:publicProduct(product||{abc,description,ndc11:ndc}),added:!product};
}
async function addAlias(db,b,p){
 need(b.action==='RECEIVE','Establish aliases during Receive only.');
 const ndc=manualNDC(b.scannedNDC),source=String(b.reason??'').trim(),info=ndcCandidates(p.gtin);
 need(info.candidates.includes(ndc),'Choose a scanned NDC supported by this GTIN.');
 const product=await db.prepare('SELECT * FROM products WHERE abc=?').bind(String(b.productId??'')).first();need(product,'Choose the existing supplier library record.');
 need(!product.archived_at,'That library entry is archived.','PRODUCT_ARCHIVED',409);
 need(ndc.slice(0,9)===product.ndc11.slice(0,9),'Labeler/product segments differ; this is not a package-only alias.');
 need(source.length>=8&&source.length<=500,'Describe how you verified this individual-vial/package relationship (8-500 characters).');
 const old=await db.prepare('SELECT * FROM package_aliases WHERE gtin=?').bind(p.gtin).first();
 if(old){need(Number(old.enabled)===1,'This GTIN has a package alias that an administrator disabled.','ALIAS_DISABLED',409);need(old.product_abc===product.abc&&old.scanned_ndc11===ndc,'An alias already exists with different details.');return{product:publicProduct(product),alreadyMapped:true};}
 await db.prepare('INSERT INTO package_aliases(gtin,product_abc,scanned_ndc11,unit_label,units_per_scan,source) VALUES(?,?,?,?,?,?)')
  .bind(p.gtin,product.abc,ndc,'vial',1,'User-verified: '+source).run();
 return{product:publicProduct(product),scanned_ndc11:ndc};
}
async function adminRoute(db,actor,path,b){
 if(path==='/api/admin/product/update')return updateProduct(db,actor,b);
 if(path==='/api/admin/product/archive')return setArchived(db,actor,b);
 if(path==='/api/admin/alias/enabled')return setAliasEnabled(db,actor,b);
 return null;
}
export default{
 async fetch(request,env){
 const security={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};
 try{
  const url=new URL(request.url);
  if(request.method==='GET'&&url.pathname==='/health')return json({ok:true,application:'onco-infusion-scan',version:VERSION});
  if(!env.APP_USER||!env.APP_PASSWORD)return new Response('Configure APP_USER and APP_PASSWORD.',{status:503,headers:security});
  if(!await authorized(request,env))return new Response('Sign in required',{status:401,headers:{...security,'WWW-Authenticate':'Basic realm="Infusion scanner", charset="UTF-8"'}});
  if(!(url.pathname==='/api'||url.pathname.startsWith('/api/'))){
   if(!['GET','HEAD'].includes(request.method))return json({error:'Not found'},404);need(env.ASSETS,'Missing ASSETS binding.');
   const a=await env.ASSETS.fetch(request),r=new Response(a.body,a);for(const[k,v]of Object.entries(security))r.headers.set(k,v);
   r.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self' https://cdn.sheetjs.com; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");return r;
  }
  need(env.DB,'Missing DB binding.');
  if(request.method==='GET'&&url.pathname==='/api/admin/data'){await adminActor(request,env);return json(await adminData(env.DB));}
  if(request.method==='GET'&&url.pathname==='/api/data'){
   const r=await env.DB.batch([env.DB.prepare('SELECT * FROM products ORDER BY description,abc'),env.DB.prepare(SERIAL_INVENTORY),env.DB.prepare(LOT_INVENTORY),env.DB.prepare(SERIAL_ACTIVITY),env.DB.prepare(LOT_ACTIVITY)]);
   const inventory=[...r[1].results,...r[2].results].map(decorate).sort((a,b)=>a.description.localeCompare(b.description)||a.expiration.localeCompare(b.expiration));
   const activity=[...r[3].results,...r[4].results].map(row=>{const info=ndcCandidates(row.gtin);return{...row,ndc10:info.ndc10,scanned_ndc11:row.scanned_ndc11??(info.candidates.includes(row.ndc11)?row.ndc11:null)};}).sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.seq-a.seq);
   return json({products:r[0].results,inventory,activity,version:VERSION});
  }
  if(request.method!=='POST')return json({error:'Not found'},404);
  need(request.headers.get('Origin')===url.origin,'Cross-origin or missing-origin write rejected.');
  need((request.headers.get('Content-Type')||'').startsWith('application/json'),'JSON required.');
  const adminPath=url.pathname.startsWith('/api/admin/'),actor=adminPath?await adminActor(request,env):null;
  const text=await request.text();need(text.length<=1000000,'Request too large.');const b=JSON.parse(text);
  if(adminPath){const result=await adminRoute(env.DB,actor,url.pathname,b);return result?json(result):json({error:'Not found'},404);}
  if(url.pathname==='/api/import'){
   need(Array.isArray(b.rows)&&b.rows.length>0&&b.rows.length<=2000,'Import 1-2000 rows.');const unique=new Map();
   for(const source of b.rows){const row=productRow(source),old=unique.get(row.abc);need(!old||(old.ndc11===row.ndc11&&old.description===row.description),'Conflicting duplicate ABC '+row.abc);unique.set(row.abc,row);}
   const rows=[...unique.values()],old=new Map((await env.DB.prepare('SELECT * FROM products').all()).results.map(r=>[r.abc,r]));
   // Entries an administrator has edited or archived (version>1) are never overwritten or flagged by a re-import.
   for(const r of rows){const p=old.get(r.abc);need(!p||Number(p.version)>1||(p.ndc11===r.ndc11&&p.description===r.description),'Existing ABC conflicts: '+r.abc+'. No rows imported by this request yet.');}
   let inserted=0;for(let i=0;i<rows.length;i+=50){const results=await env.DB.batch(rows.slice(i,i+50).map(r=>env.DB.prepare('INSERT INTO products(abc,description,ndc_original,ndc11,supplier_abc) VALUES(?,?,?,?,?) ON CONFLICT(abc) DO NOTHING').bind(r.abc,r.description,r.ndc_original,r.ndc11,r.abc)));inserted+=results.reduce((n,r)=>n+(r.meta.changes||0),0);}
   // Seed the one manufacturer-verified alias if the library was imported after migration.
   await env.DB.prepare("INSERT INTO package_aliases(gtin,product_abc,scanned_ndc11,unit_label,units_per_scan,source) SELECT '00363323884017',abc,'63323088401','vial',1,'Fresenius Kabi DailyMed labeling: 63323-884-01 each; 63323-884-06 tray' FROM products WHERE ndc11='63323088406' ORDER BY abc LIMIT 1 ON CONFLICT(gtin) DO NOTHING").run();
   return json({inserted,skipped:rows.length-inserted,duplicates:b.rows.length-rows.length});
  }
  const p=parseScan(b.raw,env.SCAN_SEPARATOR||'');
  if(url.pathname==='/api/products/add')return json(await addProduct(env.DB,b,p));
  if(url.pathname==='/api/packages/add')return json(await addAlias(env.DB,b,p));
  if(url.pathname==='/api/inspect'){
   const c=await contextFor(env.DB,p);
   need(c.reason!=='ALIAS_DISABLED','This GTIN\'s package alias is disabled by an administrator. It will not be matched or received.','ALIAS_DISABLED',409);
   return json({...p,ndc10:c.ndc10,candidates:c.candidates,scanned_ndc11:c.scanned_ndc11,
    match:c.product?{...publicProduct(c.product),method:c.method,archived:!!c.product.archived_at}:null,reason:c.reason,matches:c.matches,suggestions:c.suggestions});
  }
  if(url.pathname==='/api/scan'){
   need(['RECEIVE','PULL','RETURN'].includes(b.action),'Invalid action.');need(typeof b.requestId==='string'&&/^[0-9a-f-]{36}$/i.test(b.requestId),'Invalid request ID.');
   const requestHash=await hash(JSON.stringify([b.raw,b.action]));
   async function replay(prior){need(prior.request_hash===requestHash,'Request ID reused with different content.');const product=await env.DB.prepare('SELECT * FROM products WHERE abc=?').bind(prior.product_abc).first();return json({saved:true,replayed:true,...p,product:publicProduct(product)});}
   const prior=await requestRecord(env.DB,b.requestId);if(prior)return await replay(prior);
   const c=await contextFor(env.DB,p);
   if(p.serial!==null&&!c.existing)need(b.action==='RECEIVE','This serialized vial has not been received.','UNKNOWN_VIAL');
   // Disabled alias blocks every NEW receipt of this GTIN, including into an existing lot group. Pull/Return of recorded stock continue.
   need(!(c.reason==='ALIAS_DISABLED'||(b.action==='RECEIVE'&&await aliasDisabled(env.DB,p.gtin))),'This GTIN\'s package alias is disabled by an administrator. No inventory saved.','ALIAS_DISABLED',409);
   need(!(b.action==='RECEIVE'&&c.product&&c.product.archived_at),'This library entry is archived; new receipts are blocked. Pull and Return of existing stock still work. No inventory saved.','PRODUCT_ARCHIVED',409);
   need(c.product,c.reason==='AMBIGUOUS_MATCH'?'More than one NDC matches; resolve the package.':'Product not found; add a product or verified package alias.',c.reason||'UNKNOWN_PRODUCT',409,{parsed:p,candidates:c.candidates,ndc10:c.ndc10,matches:c.matches||[],suggestions:c.suggestions||[]});
   const product=c.product,supplierNDC=c.supplier_ndc11||product.ndc11;
   try{
    if(p.serial!==null){
     await env.DB.batch([
      env.DB.prepare('INSERT INTO events(request_id,request_hash,action,gtin,serial,lot,expiration,product_abc,raw_scan) VALUES(?,?,?,?,?,?,?,?,?)').bind(b.requestId,requestHash,b.action,p.gtin,p.serial,p.lot,p.expiration,product.abc,b.raw),
      env.DB.prepare('INSERT INTO event_packages(event_seq,scanned_ndc11,supplier_ndc11,parse_mode) SELECT seq,?,?,? FROM events WHERE request_id=?').bind(c.scanned_ndc11??null,supplierNDC,p.parseMode,b.requestId)
     ]);
    }else{
     await env.DB.prepare('INSERT INTO lot_events(request_id,request_hash,action,gtin,lot,expiration,product_abc,scanned_ndc11,supplier_ndc11,quantity,raw_scan,parse_mode) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)')
      .bind(b.requestId,requestHash,b.action,p.gtin,p.lot,p.expiration,product.abc,c.scanned_ndc11??null,supplierNDC,b.raw,p.parseMode).run();
    }
   }catch(error){const saved=await requestRecord(env.DB,b.requestId);if(saved)return await replay(saved);throw error;}
   return json({saved:true,...p,product:publicProduct(product),scanned_ndc11:c.scanned_ndc11,supplier_ndc11:supplierNDC,quantity:1});
  }
  return json({error:'Not found'},404);
 }catch(e){return json({error:String(e.message||e).replace(/^D1_ERROR:\s*/,''),code:e.code||'REQUEST_ERROR',...(e.details||{})},e.status||400);}
 }
};
