import {need,AppError,manualNDC} from './parser.js';
import {LOT_INVENTORY,SERIAL_INVENTORY} from './queries.js';
async function digest(s){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(v=>v.toString(16).padStart(2,'0')).join('');}
// Interim actor label. A shared credential cannot identify a person; replace with the Cloudflare Access identity later.
export const ACTOR='shared-admin-credential';
export async function adminActor(request,env){
 if(!env.ADMIN_USER||!env.ADMIN_PASSWORD||env.ADMIN_PASSWORD===env.APP_PASSWORD)throw new AppError('Administration is not configured.','ADMIN_NOT_CONFIGURED',503);
 const supplied=request.headers.get('X-Admin-Authorization')||'';
 if(await digest(supplied)!==await digest('Basic '+btoa(env.ADMIN_USER+':'+env.ADMIN_PASSWORD)))throw new AppError('Administrator sign-in required.','ADMIN_REQUIRED',403);
 return ACTOR;
}
const reasonOf=b=>{const r=String(b.reason??'').trim();need(r.length>=8&&r.length<=500,'Enter a reason (8-500 characters).');return r;};
const versionOf=b=>{need(Number.isInteger(b.version)&&b.version>=1,'Record version missing. Refresh and retry.');return b.version;};
const stale=()=>new AppError('This record changed since you loaded it. Nothing was saved. Refresh and retry.','STALE_VERSION',409);
const printable=s=>/^[\x21-\x7e]{1,20}$/.test(s);
function validDate(s){if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const[y,m,d]=s.split('-').map(Number),t=new Date(Date.UTC(y,m-1,d));return t.getUTCFullYear()===y&&t.getUTCMonth()===m-1&&t.getUTCDate()===d;}
// Inserted only when the preceding statement in the same batch changed exactly one row.
const audit=(db,actor,action,type,id,before,after,reason)=>db.prepare('INSERT INTO admin_audit(actor,action,entity_type,entity_id,before_json,after_json,reason) SELECT ?,?,?,?,?,?,? WHERE changes()=1')
 .bind(actor,action,type,String(id),JSON.stringify(before),JSON.stringify(after),reason);
export async function adminData(db){
 const r=await db.batch([
  db.prepare('SELECT p.abc AS id,p.supplier_abc,p.description,p.ndc11,p.created_at,p.archived_at,p.version,(SELECT COUNT(*) FROM events e WHERE e.product_abc=p.abc)+(SELECT COUNT(*) FROM lot_events l WHERE l.product_abc=p.abc) AS activity_count FROM products p ORDER BY p.description,p.abc'),
  db.prepare('SELECT a.gtin,a.product_abc AS product_id,p.description,a.scanned_ndc11,p.ndc11 AS supplier_ndc11,a.unit_label,a.units_per_scan,a.source,a.created_at,a.enabled,a.disabled_at,a.version FROM package_aliases a JOIN products p ON p.abc=a.product_abc ORDER BY p.description,a.gtin'),
  db.prepare('SELECT id,at,actor,action,entity_type,entity_id,before_json,after_json,reason FROM admin_audit ORDER BY id DESC LIMIT 200'),
  db.prepare('SELECT * FROM ('+LOT_INVENTORY+') ORDER BY description,expiration,lot')]);
 return{products:r[0].results,aliases:r[1].results,audit:r[2].results,lots:r[3].results};
}
async function product(db,b){
 const old=await db.prepare('SELECT * FROM products WHERE abc=?').bind(String(b.id??'')).first();need(old,'Library record not found.','NOT_FOUND',404);
 need(Number(old.version)===versionOf(b),'','STALE_VERSION',409);return old;
}
async function guarded(fn){try{return await fn();}catch(e){if(e.code==='STALE_VERSION')throw stale();throw e;}}
export async function updateProduct(db,actor,b){return guarded(async()=>{
 const reason=reasonOf(b),old=await product(db,b),description=String(b.description??'').trim(),sa=String(b.supplierAbc??'').trim();
 need(description.length>0&&description.length<=300,'Description required (maximum 300 characters).');
 need(!sa||/^\d{1,30}$/.test(sa),'Supplier ABC must be digits or blank.');
 const next=sa||null,ndc=b.ndc11===undefined?old.ndc11:manualNDC(b.ndc11);
 need(b.archived===undefined||typeof b.archived==='boolean','Invalid archive status.');
 const archived=b.archived===undefined?!!old.archived_at:b.archived;
 const at=archived?(old.archived_at||new Date().toISOString()):null;
 need(description!==old.description||next!==(old.supplier_abc??null)||ndc!==old.ndc11||archived!==!!old.archived_at,'No changes to save.');
 if(next)need(!await db.prepare('SELECT 1 AS x FROM products WHERE supplier_abc=? AND abc<>?').bind(next,old.abc).first(),'Another entry uses that supplier ABC.','DUPLICATE_ABC',409);
 const before={description:old.description,supplier_abc:old.supplier_abc??null,ndc11:old.ndc11,archived_at:old.archived_at??null};
 const after={description,supplier_abc:next,ndc11:ndc,archived_at:at};
 // The existing products_identity_guard trigger checks NDC references AT WRITE TIME.
 const res=await db.batch([db.prepare('UPDATE products SET description=?,supplier_abc=?,ndc11=?,ndc_original=?,archived_at=?,version=version+1 WHERE abc=? AND version=?').bind(description,next,ndc,ndc===old.ndc11?old.ndc_original:ndc,at,old.abc,old.version),audit(db,actor,'PRODUCT_UPDATE','product',old.abc,before,after,reason)]);
 need(res[0].meta.changes===1,'','STALE_VERSION',409);
 return{saved:true,id:old.abc,version:old.version+1};});}
export async function setArchived(db,actor,b){return guarded(async()=>{
 const reason=reasonOf(b),old=await product(db,b);need(typeof b.archived==='boolean','Specify archive or unarchive.');
 need(!!old.archived_at!==b.archived,b.archived?'Entry is already archived.':'Entry is not archived.');
 const at=b.archived?new Date().toISOString():null;
 const res=await db.batch([db.prepare('UPDATE products SET archived_at=?,version=version+1 WHERE abc=? AND version=?').bind(at,old.abc,old.version),
  audit(db,actor,b.archived?'PRODUCT_ARCHIVE':'PRODUCT_UNARCHIVE','product',old.abc,{archived_at:old.archived_at??null},{archived_at:at},reason)]);
 need(res[0].meta.changes===1,'','STALE_VERSION',409);return{saved:true,id:old.abc,version:old.version+1};});}
export async function setAliasEnabled(db,actor,b){return guarded(async()=>{
 const reason=reasonOf(b),gtin=String(b.gtin??'');need(/^\d{14}$/.test(gtin),'Invalid GTIN.');need(typeof b.enabled==='boolean','Specify enable or disable.');
 const old=await db.prepare('SELECT * FROM package_aliases WHERE gtin=?').bind(gtin).first();need(old,'Alias not found.','NOT_FOUND',404);
 need(Number(old.version)===versionOf(b),'','STALE_VERSION',409);need((Number(old.enabled)===1)!==b.enabled,b.enabled?'Alias is already enabled.':'Alias is already disabled.');
 const at=b.enabled?null:new Date().toISOString();
 const res=await db.batch([db.prepare('UPDATE package_aliases SET enabled=?,disabled_at=?,version=version+1 WHERE gtin=? AND version=?').bind(b.enabled?1:0,at,gtin,old.version),
  audit(db,actor,b.enabled?'ALIAS_ENABLE':'ALIAS_DISABLE','package_alias',gtin,{enabled:Number(old.enabled),disabled_at:old.disabled_at??null},{enabled:b.enabled?1:0,disabled_at:at},reason)]);
 need(res[0].meta.changes===1,'','STALE_VERSION',409);return{saved:true,gtin,version:old.version+1};});}
// Explicit, audited quantity adjustment for a NONSERIALIZED lot group. lot/expiration are the ORIGINAL scanned values.
// Quantity-only editing. Barcode identity corrections are deliberately disabled until scan resolution supports them.
async function saveQuantities(db,actor,g,ti,to,reason){
 const before={in_stock:Number(g.in_stock),out_quantity:Number(g.out_quantity)};
 need(Number.isInteger(ti)&&Number.isInteger(to)&&ti>=0&&to>=0,'Quantities must be whole numbers of zero or more.');
 const changes=[['IN_STOCK',ti-before.in_stock],['OUT',to-before.out_quantity]].filter(x=>x[1]!==0);
 need(changes.length>0,'No changes to save.');
 need(changes.every(x=>Math.abs(x[1])<=1000),'Change each quantity by at most 1000 per edit.');
 need(!Number(g.corrected),'This record has a legacy identity correction. Do not edit it until the correction has been reviewed.','CORRECTION_REVIEW',409);
 const statements=[];
 for(let i=0;i<changes.length;i++){
  const [bucket,delta]=changes[i];
  const condition=i===0?'EXISTS(SELECT 1 FROM ('+LOT_INVENTORY+') WHERE gtin=? AND raw_lot=? AND raw_expiration=? AND in_stock=? AND out_quantity=? AND corrected=0)':'changes()=1';
  const args=[g.gtin,g.raw_lot,g.raw_expiration,g.product_abc,bucket,delta,reason,actor];
  if(i===0)args.push(g.gtin,g.raw_lot,g.raw_expiration,before.in_stock,before.out_quantity);
  statements.push(db.prepare('INSERT INTO lot_adjustments(gtin,lot,expiration,product_abc,bucket,delta,reason,actor) SELECT ?,?,?,?,?,?,?,? WHERE '+condition).bind(...args));
 }
 statements.push(audit(db,actor,'INVENTORY_ADJUST','lot_group',JSON.stringify([g.gtin,g.raw_lot,g.raw_expiration]),before,{in_stock:ti,out_quantity:to},reason));
 const res=await db.batch(statements);
 need(res[0].meta.changes===1,'','STALE_VERSION',409);
 return{saved:true,in_stock:ti,out_quantity:to};
}
export async function adjustInventory(db,actor,b){return guarded(async()=>{
 const reason=reasonOf(b);
 need(['IN_STOCK','OUT'].includes(b.bucket),'Choose In stock or Out.');
 need(Number.isInteger(b.delta)&&b.delta!==0&&Math.abs(b.delta)<=1000,'Change must be a nonzero integer of at most 1000.');
 need(Number.isInteger(b.expectedIn)&&Number.isInteger(b.expectedOut),'Reload quantities and retry.');
 const g=await db.prepare('SELECT * FROM ('+LOT_INVENTORY+') WHERE gtin=? AND raw_lot=? AND raw_expiration=?').bind(String(b.gtin??''),String(b.lot??''),String(b.expiration??'')).first();
 need(g,'Nonserialized lot group not found.','NOT_FOUND',404);
 need(Number(g.in_stock)===b.expectedIn&&Number(g.out_quantity)===b.expectedOut,'','STALE_VERSION',409);
 return saveQuantities(db,actor,g,Number(g.in_stock)+(b.bucket==='IN_STOCK'?b.delta:0),Number(g.out_quantity)+(b.bucket==='OUT'?b.delta:0),reason);
});}
export async function editInventory(db,actor,b){return guarded(async()=>{
 const reason=reasonOf(b),ch=b.changes;
 need(ch&&typeof ch==='object'&&!Array.isArray(ch),'Invalid changes.');
 need(Object.keys(ch).every(k=>['inStock','out'].includes(k)),'Barcode identity fields are locked: lot, serial, expiration and scanned NDC cannot be changed here.','IDENTITY_LOCKED',409);
 need(b.rawSerial===null,'Serialized vial state changes only through Pull/Return scans.','IDENTITY_LOCKED',409);
 const ex=b.expected||{};
 need(Number.isInteger(ex.in_stock)&&Number.isInteger(ex.out_quantity),'Reload quantities and retry.');
 const g=await db.prepare('SELECT * FROM ('+LOT_INVENTORY+') WHERE gtin=? AND raw_lot=? AND raw_expiration=?').bind(String(b.gtin??''),String(b.rawLot??''),String(b.rawExpiration??'')).first();
 need(g,'Nonserialized lot group not found.','NOT_FOUND',404);
 need(Number(g.in_stock)===ex.in_stock&&Number(g.out_quantity)===ex.out_quantity,'','STALE_VERSION',409);
 return saveQuantities(db,actor,g,ch.inStock===undefined?Number(g.in_stock):ch.inStock,ch.out===undefined?Number(g.out_quantity):ch.out,reason);
});}
