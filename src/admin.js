import {need,AppError} from './parser.js';
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
// Inserted only when the preceding UPDATE in the same batch changed exactly one row.
const audit=(db,actor,action,type,id,before,after,reason)=>db.prepare('INSERT INTO admin_audit(actor,action,entity_type,entity_id,before_json,after_json,reason) SELECT ?,?,?,?,?,?,? WHERE changes()=1')
 .bind(actor,action,type,String(id),JSON.stringify(before),JSON.stringify(after),reason);
export async function adminData(db){
 const r=await db.batch([
  db.prepare('SELECT p.abc AS id,p.supplier_abc,p.description,p.ndc11,p.created_at,p.archived_at,p.version,(SELECT COUNT(*) FROM events e WHERE e.product_abc=p.abc)+(SELECT COUNT(*) FROM lot_events l WHERE l.product_abc=p.abc) AS activity_count FROM products p ORDER BY p.description,p.abc'),
  db.prepare('SELECT a.gtin,a.product_abc AS product_id,p.description,a.scanned_ndc11,p.ndc11 AS supplier_ndc11,a.unit_label,a.units_per_scan,a.source,a.created_at,a.enabled,a.disabled_at,a.version FROM package_aliases a JOIN products p ON p.abc=a.product_abc ORDER BY p.description,a.gtin'),
  db.prepare('SELECT id,at,actor,action,entity_type,entity_id,before_json,after_json,reason FROM admin_audit ORDER BY id DESC LIMIT 200')]);
 return{products:r[0].results,aliases:r[1].results,audit:r[2].results};
}
async function product(db,b){
 const old=await db.prepare('SELECT * FROM products WHERE abc=?').bind(String(b.id??'')).first();need(old,'Library record not found.','NOT_FOUND',404);
 need(Number(old.version)===versionOf(b),'','STALE_VERSION',409);return old;
}
async function guarded(fn){try{return await fn();}catch(e){if(e.code==='STALE_VERSION')throw stale();throw e;}}
export async function updateProduct(db,actor,b){return guarded(async()=>{
 const reason=reasonOf(b),old=await product(db,b),description=String(b.description??'').trim(),sa=String(b.supplierAbc??'').trim();
 need(description.length>0&&description.length<=300,'Description required (maximum 300 characters).');
 need(!sa||/^\d{1,30}$/.test(sa),'Supplier ABC must be digits or blank.');const next=sa||null;
 need(description!==old.description||next!==(old.supplier_abc??null),'No changes to save.');
 if(next)need(!await db.prepare('SELECT 1 AS x FROM products WHERE supplier_abc=? AND abc<>?').bind(next,old.abc).first(),'Another library entry already uses that supplier ABC.','DUPLICATE_ABC',409);
 const before={description:old.description,supplier_abc:old.supplier_abc??null},after={description,supplier_abc:next};
 const res=await db.batch([db.prepare('UPDATE products SET description=?,supplier_abc=?,version=version+1 WHERE abc=? AND version=?').bind(description,next,old.abc,old.version),audit(db,actor,'PRODUCT_UPDATE','product',old.abc,before,after,reason)]);
 need(res[0].meta.changes===1,'','STALE_VERSION',409);return{saved:true,id:old.abc,version:old.version+1};});}
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
