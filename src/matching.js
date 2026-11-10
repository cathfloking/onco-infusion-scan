import {ndcCandidates,publicProduct} from './parser.js';
export async function resolveProduct(db,p){
 const info=ndcCandidates(p.gtin);
 const alias=await db.prepare('SELECT p.*,a.scanned_ndc11,a.source FROM package_aliases a JOIN products p ON p.abc=a.product_abc WHERE a.gtin=?').bind(p.gtin).first();
 if(alias)return{product:alias,scanned_ndc11:alias.scanned_ndc11,method:'verified package alias',...info};
 const mapped=await db.prepare('SELECT p.* FROM gtin_mappings m JOIN products p ON p.abc=m.product_abc WHERE m.gtin=?').bind(p.gtin).first();
 if(mapped)return{product:mapped,scanned_ndc11:info.candidates.includes(mapped.ndc11)?mapped.ndc11:null,method:'exact GTIN mapping',...info};
 const rows=info.candidates.length?(await db.prepare('SELECT * FROM products WHERE ndc11 IN ('+info.candidates.map(()=>'?').join(',')+') ORDER BY abc').bind(...info.candidates).all()).results:[];
 const ndcs=[...new Set(rows.map(r=>r.ndc11))];
 if(ndcs.length===1){rows.sort((a,b)=>Number(a.abc.startsWith('MANUAL-'))-Number(b.abc.startsWith('MANUAL-'))||a.abc.localeCompare(b.abc));return{product:rows[0],scanned_ndc11:ndcs[0],method:'unique exact NDC match',supplierEntries:rows.length,...info};}
 // Same-product/package variants are suggestions only, never automatic identity changes.
 let suggestions=[];
 if(!ndcs.length&&info.candidates.length){const all=(await db.prepare('SELECT * FROM products ORDER BY description,abc').all()).results;suggestions=all.filter(r=>info.candidates.some(n=>n.slice(0,9)===r.ndc11.slice(0,9))).map(publicProduct);}
 return{product:null,reason:ndcs.length?'AMBIGUOUS_MATCH':'UNKNOWN_PRODUCT',matches:rows.map(publicProduct),suggestions,...info};
}
export async function contextFor(db,p){
 let existing;
 if(p.serial!==null){existing=await db.prepare('SELECT e.*,x.scanned_ndc11,x.supplier_ndc11 FROM events e LEFT JOIN event_packages x ON x.event_seq=e.seq WHERE e.gtin=? AND e.serial=? ORDER BY e.seq DESC LIMIT 1').bind(p.gtin,p.serial).first();}
 else{existing=await db.prepare('SELECT * FROM lot_events WHERE gtin=? AND lot=? AND expiration=? ORDER BY seq DESC LIMIT 1').bind(p.gtin,p.lot,p.expiration).first();}
 if(existing){const product=await db.prepare('SELECT * FROM products WHERE abc=?').bind(existing.product_abc).first();const info=ndcCandidates(p.gtin);return{existing,product,scanned_ndc11:existing.scanned_ndc11??(info.candidates.includes(product.ndc11)?product.ndc11:null),supplier_ndc11:existing.supplier_ndc11||product.ndc11,method:'existing inventory association',...info};}
 const m=await resolveProduct(db,p);return{...m,supplier_ndc11:m.product?.ndc11};
}
export async function requestRecord(db,id){
 const old=await db.prepare('SELECT e.*,x.scanned_ndc11,x.supplier_ndc11 FROM events e LEFT JOIN event_packages x ON x.event_seq=e.seq WHERE e.request_id=?').bind(id).first();
 if(old)return{...old,tracking_mode:'serialized'};
 const lot=await db.prepare('SELECT * FROM lot_events WHERE request_id=?').bind(id).first();return lot?{...lot,tracking_mode:'nonserialized'}:null;
}
