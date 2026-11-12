import {need} from './parser.js';
// Expected shipments (packing slips). Planning data only: nothing here creates or changes inventory.
export const MAX_LINES=99; // one D1 batch = 1 shipment insert + up to 99 line inserts
const txt=(v,max,label)=>{const s=String(v??'').trim();need(s.length<=max,label+' is too long.');return s;};
export function cleanShipment(b){
 need(b&&typeof b==='object','Invalid request.');
 need(typeof b.requestId==='string'&&/^[0-9a-f-]{36}$/i.test(b.requestId),'Invalid request ID.');
 const label=txt(b.label,120,'Label');need(label.length>=1,'Enter a label.');
 const slipDate=b.slipDate?String(b.slipDate):'';need(!slipDate||/^\d{4}-\d\d-\d\d$/.test(slipDate),'Invalid slip date.');
 const countedFrom=String(b.countedFrom||'');need(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(countedFrom),'Invalid count-receipts-since time.');
 need(Array.isArray(b.lines)&&b.lines.length>=1,'Add at least one line.');
 need(b.lines.length<=MAX_LINES,'A shipment can hold up to '+MAX_LINES+' lines. Split the slip.');
 const lines=b.lines.map((l,i)=>{
  const n='Line '+(i+1);need(l&&typeof l==='object',n+' is invalid.');
  const ndc11=String(l.ndc11??'').trim();need(/^\d{11}$/.test(ndc11),n+': NDC must be 11 digits.');
  const description=txt(l.description,300,n+' description');need(description.length>=1,n+': description required.');
  const lot=txt(l.lot,40,n+' lot'),expiration=String(l.expiration??'').trim();
  need(!expiration||/^\d{4}-\d\d-\d\d$/.test(expiration),n+': expiration must be YYYY-MM-DD.');
  need(!expiration||lot,n+': an expiration needs a lot number.');
  const q=Number(l.expectedQty),v=Number(l.vialsPerUnit??1);
  need(Number.isInteger(q)&&q>=1&&q<=10000,n+': quantity must be 1-10000.');
  need(Number.isInteger(v)&&v>=1&&v<=1000,n+': vials per unit must be 1-1000.');
  return{order_no:txt(l.orderNo,60,n),box_id:txt(l.boxId,60,n),po:txt(l.po,60,n),storage:txt(l.storage,60,n),item_no:txt(l.itemNo,30,n),ndc11,description,lot,expiration,expected_qty:q,vials_per_unit:v,flags:txt(l.flags,100,n)};
 });
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
export async function setShipmentStatus(db,b){
 const id=Number(b&&b.id),status=String(b&&b.status||'');
 need(Number.isInteger(id)&&id>0,'Invalid shipment.');need(['OPEN','CLOSED','CANCELLED'].includes(status),'Invalid status.');
 const r=await db.prepare("UPDATE expected_shipments SET status=?,closed_at=CASE WHEN ?='OPEN' THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END WHERE id=?").bind(status,status,id).run();
 need(r.meta&&r.meta.changes===1,'Shipment not found.','NOT_FOUND',404);
 return{ok:true,id,status};
}
