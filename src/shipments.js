import {need} from './parser.js';
// Expected shipments (packing slips).
// Saving a shipment creates planning data only. The inventory writes here are receiveShipment() (clearly labeled manual
// lot-level receipts for lines whose slip shows a lot AND expiration) and, if the drug is not in the library yet, one
// library entry created from the slip description.
export const MAX_LINES=99; // one D1 batch = library inserts + up to 99 receipt inserts
const txt=(v,max,label)=>{const s=String(v??'').trim();need(s.length<=max,label+' is too long.');return s;};
async function sha(s){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(v=>v.toString(16).padStart(2,'0')).join('');}
function cleanLine(l,n){
 need(l&&typeof l==='object',n+' is invalid.');
 const ndc11=String(l.ndc11??'').trim();need(/^\d{11}$/.test(ndc11),n+': NDC must be 11 digits.');
 const description=txt(l.description,300,n+' description');need(description.length>=1,n+': description required.');
 const lot=txt(l.lot,40,n+' lot'),expiration=String(l.expiration??'').trim();
 need(!expiration||/^\d{4}-\d\d-\d\d$/.test(expiration),n+': expiration must be YYYY-MM-DD.');
 need(!expiration||lot,n+': an expiration needs a lot number.');
 const q=Number(l.expectedQty),v=Number(l.vialsPerUnit??1);
 need(Number.isInteger(q)&&q>=1&&q<=10000,n+': quantity must be 1-10000.');
 need(Number.isInteger(v)&&v>=1&&v<=1000,n+': vials per unit must be 1-1000.');
 return{order_no:txt(l.orderNo,60,n),box_id:txt(l.boxId,60,n),po:txt(l.po,60,n),storage:txt(l.storage,60,n),item_no:txt(l.itemNo,30,n),ndc11,description,lot,expiration,expected_qty:q,vials_per_unit:v,flags:txt(l.flags,100,n)};
}
export function cleanShipment(b){
 need(b&&typeof b==='object','Invalid request.');
 need(typeof b.requestId==='string'&&/^[0-9a-f-]{36}$/i.test(b.requestId),'Invalid request ID.');
 const label=txt(b.label,120,'Label');need(label.length>=1,'Enter a label.');
 const slipDate=b.slipDate?String(b.slipDate):'';need(!slipDate||/^\d{4}-\d\d-\d\d$/.test(slipDate),'Invalid slip date.');
 const countedFrom=String(b.countedFrom||'');need(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(countedFrom),'Invalid count-receipts-since time.');
 need(Array.isArray(b.lines)&&b.lines.length>=1,'Add at least one line.');
 need(b.lines.length<=MAX_LINES,'A shipment can hold up to '+MAX_LINES+' lines. Split the slip.');
 const lines=b.lines.map((l,i)=>cleanLine(l,'Line '+(i+1)));
 return{requestId:b.requestId.toLowerCase(),label,slipDate,countedFrom,lines};
}
export const SQL_SHIPMENT='INSERT INTO expected_shipments(request_id,label,slip_date,counted_from) VALUES(?,?,?,?) ON CONFLICT(request_id) DO NOTHING';
// changes()=1 chains the line inserts to the shipment insert: a retried request inserts nothing twice.
export const SQL_LINE='INSERT INTO expected_lines(shipment_id,order_no,box_id,po,storage,item_no,ndc11,description,lot,expiration,expected_qty,vials_per_unit,flags) SELECT (SELECT id FROM expected_shipments WHERE request_id=?),?,?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1';
export async function saveShipment(db,b){
 const c=cleanShipment(b);
 const statements=[db.prepare(SQL_SHIPMENT).bind(c.requestId,c.label,c.slipDate||null,c.countedFrom)];
 for(const l of c.lines)statements.push(db.prepare(SQL_LINE).bind(c.requestId,l.order_no,l.box_id,l.po,l.storage,l.item_no,l.ndc11,l.description,l.lot,l.expiration,l.expected_qty,l.vials_per_unit,l.flags));
 const results=await db.batch(statements);
 const replayed=!(results[0].meta&&results[0].meta.changes>0);
 const row=await db.prepare('SELECT id FROM expected_shipments WHERE request_id=?').bind(c.requestId).first();
 need(row,'Shipment was not saved.');
 return{saved:true,replayed,id:row.id,lines:c.lines.length};
}
export async function listShipments(db){
 const r=await db.batch([
  db.prepare("SELECT * FROM expected_shipments WHERE status!='CANCELLED' ORDER BY id DESC LIMIT 20"),
  db.prepare("SELECT * FROM expected_lines WHERE shipment_id IN (SELECT id FROM (SELECT id FROM expected_shipments WHERE status!='CANCELLED' ORDER BY id DESC LIMIT 20)) ORDER BY id")]);
 const by=new Map();for(const l of r[1].results){(by.get(l.shipment_id)||by.set(l.shipment_id,[]).get(l.shipment_id)).push(l);}
 return{shipments:r[0].results.map(s=>({...s,lines:by.get(s.id)||[]}))};
}
// OPEN <-> CLOSED are both allowed, so a closed shipment can be reopened.
export async function setShipmentStatus(db,b){
 const id=Number(b&&b.id),status=String(b&&b.status||'');
 need(Number.isInteger(id)&&id>0,'Invalid shipment.');need(['OPEN','CLOSED','CANCELLED'].includes(status),'Invalid status.');
 const r=await db.prepare("UPDATE expected_shipments SET status=?,closed_at=CASE WHEN ?='OPEN' THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END WHERE id=?").bind(status,status,id).run();
 need(r.meta&&r.meta.changes===1,'Shipment not found.','NOT_FOUND',404);
 return{ok:true,id,status};
}
// Edit one expected line of an OPEN shipment (fix a misread lot, expiration, quantity or vials per unit).
export async function updateLine(db,b){
 const id=Number(b&&b.lineId);need(Number.isInteger(id)&&id>0,'Invalid line.');
 const c=cleanLine({ndc11:'00000000000',description:'x',lot:b.lot,expiration:b.expiration,expectedQty:b.expectedQty,vialsPerUnit:b.vialsPerUnit},'Line');
 const r=await db.prepare("UPDATE expected_lines SET lot=?,expiration=?,expected_qty=?,vials_per_unit=? WHERE id=? AND shipment_id IN (SELECT id FROM expected_shipments WHERE status='OPEN')").bind(c.lot,c.expiration,c.expected_qty,c.vials_per_unit,id).run();
 need(r.meta&&r.meta.changes===1,'Line not found, or its shipment is not open.','NOT_FOUND',404);
 return{ok:true,id};
}

// ---- Manual (lot-level) receipt ----
// A line can be received without scanning when the slip shows its lot AND expiration. Serial numbers are not required, and a
// drug does not need to have been scanned before. Ledger rows need a GTIN, so one is taken from earlier scans of the same NDC or,
// failing that, built from the NDC with the standard GS1 pattern (003 + NDC10 + check digit). If the real vial carries a different
// GTIN it does not matter: Pull/Return of a vial with no record of its own falls back to this lot group (see manualLotGroup).
export function ndc10Forms(ndc11){
 const f=[];
 if(ndc11[0]==='0')f.push(ndc11.slice(1));                          // 4-4-2
 if(ndc11[5]==='0')f.push(ndc11.slice(0,5)+ndc11.slice(6));         // 5-3-2
 if(ndc11[9]==='0')f.push(ndc11.slice(0,9)+ndc11[10]);              // 5-4-1
 return f;
}
export function gtinFromNdc10(n){
 const b='003'+n;let sum=0;for(let i=0;i<13;i++)sum+=Number(b[i])*(i%2===0?3:1);
 return b+((10-sum%10)%10);
}
export function eligibility(lines,L){
 const byAbc=new Map(L.products.map(p=>[p.abc,p])),out=new Map();
 const rank=p=>[p.archived_at?1:0,String(p.abc).startsWith('MANUAL-')?1:0,p.abc];
 for(const l of lines){
  const no=reason=>out.set(l.id,{ok:false,reason});
  if(!l.lot){no('No lot on the slip. Scan a vial.');continue;}
  if(!l.expiration){no('No expiration on the slip. Scan a vial.');continue;}
  if(l.lot.length>20){no('Lot is longer than 20 characters.');continue;}
  const hist=L.groups.filter(r=>r.supplier_ndc11===l.ndc11||r.scanned_ndc11===l.ndc11).sort((a,b)=>String(a.gtin).localeCompare(String(b.gtin)));
  let t,product=null,newProduct=false;
  if(hist.length){
   const h=hist[0];product=byAbc.get(h.product_abc)||null;
   t={gtin:h.gtin,product_abc:h.product_abc,supplier_ndc11:h.supplier_ndc11,scanned_ndc11:h.scanned_ndc11??null};
  }else{
   const forms=ndc10Forms(l.ndc11);
   if(!forms.length){no('This NDC is not in a format OncoScan can convert. Scan a vial.');continue;}
   const libs=L.products.filter(p=>p.ndc11===l.ndc11).sort((a,b)=>{const x=rank(a),y=rank(b);return x[0]-y[0]||x[1]-y[1]||String(x[2]).localeCompare(String(y[2]));});
   if(libs.length){product=libs[0];}else newProduct=true;
   t={gtin:gtinFromNdc10(forms[0]),product_abc:product?product.abc:null,supplier_ndc11:l.ndc11,scanned_ndc11:l.ndc11};
  }
  if(product&&product.archived_at){no('Library entry is archived. An administrator must unarchive it.');continue;}
  if(!newProduct&&!product){no('Library entry is missing.');continue;}
  if(L.disabled.has(t.gtin)||(t.product_abc&&L.disabledProducts.has(t.product_abc))){no('A package alias for this product is disabled by an administrator.');continue;}
  const clash=L.groups.some(r=>r.gtin===t.gtin&&r.lot===l.lot&&r.expiration===l.expiration&&(r.product_abc!==t.product_abc||r.supplier_ndc11!==t.supplier_ndc11||(r.scanned_ndc11??null)!==(t.scanned_ndc11??null)));
  if(clash){no('This lot already exists with a different package identity. Scan a vial.');continue;}
  out.set(l.id,{ok:true,newProduct,note:newProduct?'Adds this drug to the library from the slip description.':'',template:t});
 }
 return out;
}
export async function loadLedger(db){
 const r=await db.batch([
  db.prepare('SELECT DISTINCT gtin,lot,expiration,product_abc,supplier_ndc11,scanned_ndc11 FROM lot_events'),
  db.prepare('SELECT abc,ndc11,archived_at FROM products'),
  db.prepare('SELECT gtin,product_abc FROM package_aliases WHERE enabled<>1')]);
 return{groups:r[0].results,products:r[1].results,disabled:new Set(r[2].results.map(x=>x.gtin)),disabledProducts:new Set(r[2].results.map(x=>x.product_abc))};
}
// Used by /api/scan: the lot group created by a manual receipt for this product + lot + expiration (any GTIN on the real vial).
export async function manualLotGroup(db,productAbc,lot,expiration){
 return await db.prepare("SELECT gtin,product_abc,supplier_ndc11,scanned_ndc11 FROM lot_events WHERE product_abc=? AND lot=? AND expiration=? AND parse_mode='packing-slip-manual' ORDER BY seq LIMIT 1").bind(productAbc,lot,expiration).first();
}
async function openShipment(db,id){
 id=Number(id);need(Number.isInteger(id)&&id>0,'Invalid shipment.');
 const ship=await db.prepare('SELECT * FROM expected_shipments WHERE id=?').bind(id).first();
 need(ship,'Shipment not found.','NOT_FOUND',404);
 const lines=(await db.prepare('SELECT * FROM expected_lines WHERE shipment_id=? ORDER BY id').bind(id).all()).results;
 return{ship,lines};
}
export async function shipmentEligibility(db,id){
 const{lines}=await openShipment(db,id),e=eligibility(lines,await loadLedger(db));
 return{lines:lines.map(l=>({id:l.id,ok:e.get(l.id).ok,reason:e.get(l.id).reason||'',note:e.get(l.id).note||''}))};
}
export const SQL_PRODUCT="INSERT INTO products(abc,description,ndc_original,ndc11,supplier_abc) VALUES(?,?,?,?,NULL) ON CONFLICT(abc) DO NOTHING";
export const SQL_RECEIVE=`WITH RECURSIVE n(k) AS (SELECT 1 UNION ALL SELECT k+1 FROM n WHERE k<?)
INSERT INTO lot_events(request_id,request_hash,action,gtin,lot,expiration,product_abc,scanned_ndc11,supplier_ndc11,quantity,raw_scan,parse_mode)
SELECT ?||'-'||k,?,'RECEIVE',?,?,?,?,?,?,1,?,'packing-slip-manual' FROM n WHERE true
ON CONFLICT(request_id) DO NOTHING`;
export async function receiveShipment(db,b){
 need(b&&typeof b==='object','Invalid request.');
 need(typeof b.requestId==='string'&&/^[0-9a-f-]{36}$/i.test(b.requestId),'Invalid request ID.');
 need(Array.isArray(b.items)&&b.items.length>=1&&b.items.length<=MAX_LINES,'Choose 1-'+MAX_LINES+' lines.');
 const{ship,lines}=await openShipment(db,b.shipmentId);
 need(ship.status==='OPEN','This shipment is closed. Reopen it first.','SHIPMENT_CLOSED',409);
 const byId=new Map(lines.map(l=>[l.id,l])),seen=new Set(),items=[];
 for(const it of b.items){
  const id=Number(it&&it.lineId),q=Number(it&&it.quantity),line=byId.get(id);
  need(line,'A chosen line is not part of this shipment.');need(!seen.has(id),'A line was chosen twice.');seen.add(id);
  need(Number.isInteger(q)&&q>=1&&q<=1000,'Quantity must be 1-1000 per line.');items.push({line,q});
 }
 const elig=eligibility(items.map(i=>i.line),await loadLedger(db)),skipped=[],plan=[];
 for(const{line,q}of items){const e=elig.get(line.id);if(!e.ok){skipped.push({lineId:line.id,reason:e.reason});continue;}plan.push({line,q,t:e.template,newProduct:e.newProduct});}
 if(!plan.length)return{saved:false,added:0,results:[],skipped};
 const rid=b.requestId.toLowerCase(),statements=[],made=new Map();
 for(const p of plan){ // one library entry per new NDC, created before any receipt that points to it
  if(!p.newProduct)continue;
  if(!made.has(p.line.ndc11)){const abc='MANUAL-'+rid+'-'+p.line.ndc11;made.set(p.line.ndc11,abc);statements.push(db.prepare(SQL_PRODUCT).bind(abc,p.line.description,p.line.ndc11,p.line.ndc11));}
  p.t={...p.t,product_abc:made.get(p.line.ndc11)};
 }
 const nProducts=statements.length;
 for(const{line,q,t}of plan){
  const raw='Packing slip receipt (NOT scanned): '+ship.label+' / line '+line.id+' / '+q+' vial(s) entered by a technician';
  const hash=await sha(JSON.stringify([rid,line.id,q,t.gtin,line.lot,line.expiration]));
  statements.push(db.prepare(SQL_RECEIVE).bind(q,'slip-'+rid+'-'+line.id,hash,t.gtin,line.lot,line.expiration,t.product_abc,t.scanned_ndc11,t.supplier_ndc11,raw));
 }
 let results;
 try{results=await db.batch(statements);}
 catch(e){throw Object.assign(new Error('Nothing was added: '+String(e.message||e).replace(/^D1_ERROR:\s*/,'')),{code:'RECEIVE_FAILED',status:409});}
 const done=plan.map((p,i)=>({lineId:p.line.id,added:(results[nProducts+i].meta&&results[nProducts+i].meta.changes)||0}));
 return{saved:true,replayed:done.every(d=>d.added===0),added:done.reduce((n,d)=>n+d.added,0),libraryEntriesAdded:nProducts,results:done,skipped};
}
