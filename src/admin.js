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
 need(!sa||/^\d{1,30}$/.test(sa),'Supplier ABC must be digits or blank.');const next=sa||null;
 let ndc=old.ndc11;if(b.ndc11!==undefined&&b.ndc11!==null&&String(b.ndc11).trim()!=='')ndc=manualNDC(b.ndc11);
 const ndcChanged=ndc!==old.ndc11;
 need(description!==old.description||next!==(old.supplier_abc??null)||ndcChanged,'No changes to save.');
 if(ndcChanged){
  const refs=await db.prepare('SELECT (SELECT COUNT(*) FROM events WHERE product_abc=?)+(SELECT COUNT(*) FROM lot_events WHERE product_abc=?)+(SELECT COUNT(*) FROM package_aliases WHERE product_abc=?)+(SELECT COUNT(*) FROM gtin_mappings WHERE product_abc=?)+(SELECT COUNT(*) FROM lot_adjustments WHERE product_abc=?) AS n').bind(old.abc,old.abc,old.abc,old.abc,old.abc).first();
  need(Number(refs.n)===0,'NDC cannot be changed: '+refs.n+' inventory record(s), alias(es) or mapping(s) use this entry. Archive it and add a corrected entry instead.','NDC_IN_USE',409);
 }
 if(next)need(!await db.prepare('SELECT 1 AS x FROM products WHERE supplier_abc=? AND abc<>?').bind(next,old.abc).first(),'Another library entry already uses that supplier ABC.','DUPLICATE_ABC',409);
 const before={description:old.description,supplier_abc:old.supplier_abc??null,ndc11:old.ndc11},after={description,supplier_abc:next,ndc11:ndc};
 const res=await db.batch([db.prepare('UPDATE products SET description=?,supplier_abc=?,ndc11=?,ndc_original=?,version=version+1 WHERE abc=? AND version=?').bind(description,next,ndc,ndcChanged?ndc:old.ndc_original,old.abc,old.version),audit(db,actor,'PRODUCT_UPDATE','product',old.abc,before,after,reason)]);
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
// Explicit, audited quantity adjustment for a NONSERIALIZED lot group. lot/expiration are the ORIGINAL scanned values.
export async function adjustInventory(db,actor,b){return guarded(async()=>{
 const reason=reasonOf(b),gtin=String(b.gtin??''),lot=String(b.lot??''),expiration=String(b.expiration??'');
 need(/^\d{14}$/.test(gtin)&&lot.length>=1&&lot.length<=20&&/^\d{4}-\d{2}-\d{2}$/.test(expiration),'Invalid lot group.');
 need(['IN_STOCK','OUT'].includes(b.bucket),'Choose In stock or Out.');
 need(Number.isInteger(b.delta)&&b.delta!==0&&Math.abs(b.delta)<=1000,'Quantity change must be a whole number from 1 to 1000.');
 need(Number.isInteger(b.expectedIn)&&Number.isInteger(b.expectedOut),'Reload the quantities and retry.');
 const g=await db.prepare('SELECT * FROM ('+LOT_INVENTORY+') WHERE gtin=? AND raw_lot=? AND raw_expiration=?').bind(gtin,lot,expiration).first();
 need(g,'Nonserialized lot group not found. Serialized vials cannot be adjusted here.','NOT_FOUND',404);
 need(Number(g.in_stock)===b.expectedIn&&Number(g.out_quantity)===b.expectedOut,'','STALE_VERSION',409);
 const current=b.bucket==='IN_STOCK'?Number(g.in_stock):Number(g.out_quantity);
 need(current+b.delta>=0,'That would make the '+(b.bucket==='IN_STOCK'?'In stock':'Out')+' quantity negative (currently '+current+').');
 const before={in_stock:Number(g.in_stock),out_quantity:Number(g.out_quantity)},after={...before};
 if(b.bucket==='IN_STOCK')after.in_stock+=b.delta;else after.out_quantity+=b.delta;
 await db.batch([db.prepare('INSERT INTO lot_adjustments(gtin,lot,expiration,product_abc,bucket,delta,reason,actor) VALUES(?,?,?,?,?,?,?,?)').bind(gtin,lot,expiration,g.product_abc,b.bucket,b.delta,reason,actor),
  audit(db,actor,'INVENTORY_ADJUST','lot_group',gtin+'|'+lot+'|'+expiration,before,{...after,bucket:b.bucket,delta:b.delta},reason)]);
 return{saved:true,...after};});}
// Audited correction of inventory fields. Field corrections are an overlay (originals stay in the ledger);
// quantities change through explicit adjustment records. Everything is saved in one atomic batch with one audit row.
export async function editInventory(db,actor,b){return guarded(async()=>{
 const reason=reasonOf(b),gtin=String(b.gtin??''),rawLot=String(b.rawLot??''),rawExp=String(b.rawExpiration??'');
 const serialized=b.rawSerial!==null&&b.rawSerial!==undefined,rawSerial=serialized?String(b.rawSerial):null;
 need(/^\d{14}$/.test(gtin),'Invalid GTIN.');
 const rec=serialized?await db.prepare('SELECT * FROM ('+SERIAL_INVENTORY+') WHERE gtin=? AND raw_serial=?').bind(gtin,rawSerial).first()
  :await db.prepare('SELECT * FROM ('+LOT_INVENTORY+') WHERE gtin=? AND raw_lot=? AND raw_expiration=?').bind(gtin,rawLot,rawExp).first();
 need(rec,'Inventory record not found.','NOT_FOUND',404);
 const ex=b.expected||{},ch=b.changes||{};
 for(const k of ['lot','expiration','serial','in_stock','out_quantity'])if(k in ex)need(String(rec[k]??'')===String(ex[k]??''),'','STALE_VERSION',409);
 const fields={};
 const consider=(name,col,value,check,msg)=>{if(value===undefined||value===null)return;const v=String(value).trim();if(v===String(rec[col]??''))return;need(v!==''&&check(v),msg);fields[col]=v;};
 consider('lot','lot',ch.lot,printable,'Lot must be 1-20 printable characters.');
 consider('expiration','expiration',ch.expiration,validDate,'Expiration must be a real date in YYYY-MM-DD form.');
 if(ch.serial!==undefined&&ch.serial!==null){need(serialized,'Nonserialized lots have no serial number.');consider('serial','serial',ch.serial,printable,'Serial must be 1-20 printable characters.');}
 if(ch.scannedNdc11!==undefined&&ch.scannedNdc11!==null&&String(ch.scannedNdc11).trim()!==String(rec.scanned_ndc11??'')){need(String(ch.scannedNdc11).trim()!=='','The scanned NDC cannot be cleared.');fields.scanned_ndc11=manualNDC(ch.scannedNdc11);}
 let dIn=0,dOut=0;
 if(ch.inStock!==undefined||ch.out!==undefined){
  need(!serialized,'Serialized vial state changes only through Pull/Return scans. Quantities cannot be edited here.');
  const ti=ch.inStock===undefined?Number(rec.in_stock):ch.inStock,to=ch.out===undefined?Number(rec.out_quantity):ch.out;
  need(Number.isInteger(ti)&&Number.isInteger(to)&&ti>=0&&to>=0&&ti<=1000000&&to<=1000000,'Quantities must be whole numbers of zero or more.');
  dIn=ti-Number(rec.in_stock);dOut=to-Number(rec.out_quantity);
  need(Math.abs(dIn)<=1000&&Math.abs(dOut)<=1000,'Change each quantity by at most 1000 per edit.');
 }
 need(Object.keys(fields).length>0||dIn!==0||dOut!==0,'No changes to save.');
 if(!serialized&&(fields.lot||fields.expiration)){
  const nl=fields.lot??rec.lot,ne=fields.expiration??rec.expiration;
  need(!await db.prepare('SELECT 1 AS x FROM ('+LOT_INVENTORY+') WHERE gtin=? AND lot=? AND expiration=? AND NOT (raw_lot=? AND raw_expiration=?)').bind(gtin,nl,ne,rec.raw_lot,rec.raw_expiration).first(),'Another lot group for this GTIN already has that lot and expiration. Merging groups is not supported.','DUPLICATE_GROUP',409);
 }
 if(serialized&&fields.serial)need(!await db.prepare('SELECT 1 AS x FROM ('+SERIAL_INVENTORY+') WHERE gtin=? AND serial=? AND raw_serial<>?').bind(gtin,fields.serial,rec.raw_serial).first(),'Another vial with this GTIN already has that serial number.','DUPLICATE_SERIAL',409);
 const kind=serialized?'VIAL':'LOT_GROUP',statements=[],before={},after={};
 for(const[col,val]of Object.entries(fields)){
  before[col]=rec[col]??null;after[col]=val;
  statements.push(db.prepare('INSERT INTO record_corrections(kind,gtin,orig_lot,orig_expiration,orig_serial,field,old_value,new_value,reason,actor) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(kind,gtin,rec.raw_lot,rec.raw_expiration,serialized?rec.raw_serial:null,col,rec[col]??null,val,reason,actor));
 }
 for(const[bucket,delta]of[['IN_STOCK',dIn],['OUT',dOut]]){
  if(!delta)continue;const key=bucket==='IN_STOCK'?'in_stock':'out_quantity';before[key]=Number(rec[key]);after[key]=Number(rec[key])+delta;
  statements.push(db.prepare('INSERT INTO lot_adjustments(gtin,lot,expiration,product_abc,bucket,delta,reason,actor) VALUES(?,?,?,?,?,?,?,?)').bind(gtin,rec.raw_lot,rec.raw_expiration,rec.product_abc,bucket,delta,reason,actor));
 }
 statements.push(audit(db,actor,'INVENTORY_EDIT',serialized?'vial':'lot_group',gtin+'|'+rec.raw_lot+'|'+rec.raw_expiration+(serialized?'|'+rec.raw_serial:''),before,after,reason));
 await db.batch(statements);return{saved:true,before,after};});}
