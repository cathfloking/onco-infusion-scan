const $=id=>document.getElementById(id);
let data={products:[],inventory:[],activity:[]},preview=[],pending=null,busy=false,unknownContext=null;
async function api(path,body){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
 try{
  const r=await fetch(path,body===undefined?{signal:controller.signal}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
  const text=await r.text();let x;try{x=JSON.parse(text);}catch{throw Error('Server did not return JSON. Check sign-in and deployment.');}
  if(!r.ok){const e=new Error(x.error||'Request failed');Object.assign(e,x);throw e;}return x;
 }finally{clearTimeout(timer);}
}
function status(text,error=false){$('status').textContent=text;$('status').className=error?'error':'ok';}
function lock(locked){busy=locked;for(const id of ['raw','action','save','diagnose','sample','addProduct','cancelProduct'])$(id).disabled=locked;}
function table(target,rows,columns){
 const t=document.createElement('table'),h=t.createTHead().insertRow();for(const k of columns){const c=document.createElement('th');c.textContent=k;h.append(c);}
 const b=t.createTBody();for(const r of rows){const tr=b.insertRow();for(const k of columns)tr.insertCell().textContent=r[k]??'';}$(target).replaceChildren(t);
}
const INVENTORY_HEADERS=['ABC #','Product Description','NDC','GTIN','Scanned NDC10','Lot Number','Serial Number','Expiration Date','Quantity','Available Quantity','Status','Scanned In At (UTC)','Last Scanned Out At (UTC)','Last Returned At (UTC)','Last Action','Last Action At (UTC)','Pull Count','Return Count'];
const ACTIVITY_HEADERS=['ABC #','Product Description','NDC','GTIN','Scanned NDC10','Lot Number','Serial Number','Expiration Date','Action','Scanned At (UTC)','Request ID','Raw Scan'];
const LIBRARY_HEADERS=['ABC #','Product Description','NDC','Library Created At (UTC)','Library Record ID'];
function abc(value){return String(value||'').startsWith('MANUAL-')?'':String(value||'');}
function ndc10(gtin){return /^003\d{11}$/.test(gtin)?gtin.slice(3,13):'';}
function inventoryRows(){return data.inventory.map(r=>({
 'ABC #':abc(r.product_abc),'Product Description':r.description,'NDC':String(r.ndc11),
 'GTIN':String(r.gtin),'Scanned NDC10':ndc10(r.gtin),'Lot Number':String(r.lot),'Serial Number':String(r.serial),
 'Expiration Date':r.expiration,'Quantity':1,'Available Quantity':r.status==='In stock'?1:0,'Status':r.status,'Scanned In At (UTC)':r.scanned_in_at||'',
 'Last Scanned Out At (UTC)':r.last_scanned_out_at||'','Last Returned At (UTC)':r.last_returned_at||'',
 'Last Action':r.last_action,'Last Action At (UTC)':r.last_action_at,'Pull Count':Number(r.pull_count||0),'Return Count':Number(r.return_count||0)
}));}
function activityRows(){return data.activity.map(r=>({
 'ABC #':abc(r.product_abc),'Product Description':r.description,'NDC':String(r.ndc11),'GTIN':String(r.gtin),'Scanned NDC10':ndc10(r.gtin),
 'Lot Number':String(r.lot),'Serial Number':String(r.serial),'Expiration Date':r.expiration,'Action':r.action,'Scanned At (UTC)':r.created_at,
 'Request ID':r.request_id,'Raw Scan':r.raw_scan
}));}
function libraryRows(){return data.products.map(r=>({'ABC #':abc(r.abc),'Product Description':r.description,'NDC':String(r.ndc11),'Library Created At (UTC)':r.created_at,'Library Record ID':r.abc}));}
function render(){
 const q=$('search').value.toLowerCase(),f=$('filter').value;
 const rows=inventoryRows().filter(r=>(!f||r.Status===f)&&JSON.stringify(r).toLowerCase().includes(q));
 table('inventory',rows,['Product Description','NDC','Lot Number','Serial Number','Expiration Date','Status','Scanned In At (UTC)','Last Scanned Out At (UTC)','Last Returned At (UTC)']);
 $('count').textContent=rows.length+' vials displayed; '+data.inventory.filter(r=>r.status==='In stock').length+' total In stock. '+data.products.length+' library entries.';
 table('activity',activityRows().slice(0,100),['Scanned At (UTC)','Action','Product Description','Lot Number','Serial Number']);
}
async function refresh(){data=await api('/api/data');render();}
function identifier(value){if(typeof value==='number'){if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid numeric identifier');return String(value);}return String(value??'').trim();}
function supplierNDC(value){
 let s=identifier(value);if(/^\d{5}-\d{4}-\d{2}$/.test(s))return s.replace(/-/g,'');
 if(/^\d+(?:\.\d+)?[eE][+]?\d+$/.test(s)){const n=Number(s);if(!Number.isSafeInteger(n))throw Error('Invalid scientific NDC');s=String(n);}
 if(!/^\d{1,11}$/.test(s))throw Error('Supplier NDC must represent an 11-digit value');return s.padStart(11,'0');
}
function clearPreview(){preview=[];$('import').disabled=true;}
$('file').onchange=clearPreview;
$('preview').onclick=async()=>{
 try{
  clearPreview();if(!window.XLSX)throw Error('Excel library did not load');const f=$('file').files[0];if(!f)throw Error('Choose a file');if(f.size>5000000)throw Error('Use a file below 5 MB');
  const w=XLSX.read(await f.arrayBuffer(),{type:'array'}),rows=XLSX.utils.sheet_to_json(w.Sheets[w.SheetNames[0]],{header:1,raw:true,defval:''});
  if(!rows.length)throw Error('Empty worksheet');const h=rows[0].map(v=>String(v).replace(/\s/g,'').toLowerCase());
  if(h[0]!=='abc#'||h[1]!=='productdescription'||h[2]!=='ndc')throw Error('Expected ABC #, Product Description, NDC in columns A-C');
  const seen=new Map(),good=[],errors=[];let duplicates=0,restored=0;
  for(let i=1;i<rows.length;i++){
   if(rows[i].every(v=>v===''))continue;
   try{
    const r={abc:identifier(rows[i][0]),description:String(rows[i][1]).trim(),ndc:identifier(rows[i][2])};
    if(!/^\d{1,30}$/.test(r.abc)||!r.description||r.description.length>300)throw Error('Invalid ABC or description');
    const n=supplierNDC(r.ndc);const p=seen.get(r.abc);
    if(p){if(p.normalized!==n||p.description!==r.description)throw Error('Conflicting duplicate ABC '+r.abc);duplicates++;continue;}
    const old=data.products.find(p=>p.abc===r.abc);if(old&&(old.description!==r.description||old.ndc11!==n))throw Error('Existing ABC conflicts: '+r.abc);
    const expanded=/[eE]/.test(r.ndc)?String(Number(r.ndc)):r.ndc;if(/^\d+$/.test(expanded)&&expanded.length<11)restored++;
    seen.set(r.abc,{description:r.description,normalized:n});good.push({...r,normalized:n});
   }catch(e){errors.push('Row '+(i+1)+': '+e.message);}
  }
  $('previewText').textContent=good.length+' unique rows; '+duplicates+' identical duplicates skipped; '+restored+' leading-zero restorations; '+errors.length+' errors.\n'+errors.slice(0,30).join('\n')+'\nPreview:\n'+JSON.stringify(good.slice(0,8),null,2);
  if(!errors.length&&good.length){preview=good;$('import').disabled=false;}
 }catch(e){$('previewText').textContent=e.message;}
};
$('import').onclick=async()=>{if(!preview.length)return;$('import').disabled=true;try{const r=await api('/api/import',{rows:preview});preview=[];$('previewText').textContent='Imported '+r.inserted+'; skipped '+r.skipped;await refresh();}catch(e){$('previewText').textContent=e.message+' — refresh and preview before retrying. Earlier batches may have imported.';}};
function diagnostic(raw){$('diagnostic').textContent='Raw: '+raw.replace(/\x1d/g,'<GS>').replace(/\r/g,'<CR>').replace(/\n/g,'<LF>')+'\nCharacter codes: '+Array.from(raw).map(c=>c.charCodeAt(0)).join(',');}
function closeUnknown(){unknownContext=null;$('unknown').hidden=true;}
function showUnknown(info,raw,action){
 if(action!=='RECEIVE')return;
 unknownContext={raw,action};$('unknown').hidden=false;$('productForm').reset();
 $('unknownTitle').textContent=info.code==='AMBIGUOUS_MATCH'||info.reason==='AMBIGUOUS_MATCH'?'Resolve product identity':'Add product to library';
 const p=info.parsed||info;
 $('unknownDetails').textContent='GTIN '+p.gtin+' | Lot '+p.lot+' | Serial '+p.serial+' | Exp '+p.expiration+'. Enter the verified 11-digit package NDC and medication description.';
 $('ndcOptions').replaceChildren();for(const n of info.candidates||[])$('ndcOptions').append(new Option(n,n));
 if((info.candidates||[]).length===1)$('newNDC').value=info.candidates[0];
 if(info.matches?.length)$('unknownDetails').textContent+=' Existing candidate entries: '+info.matches.map(p=>p.description+' ['+p.ndc11+']').join('; ');
}
function showProduct(product,p){$('lastProduct').textContent=product.description+' | NDC '+product.ndc11+' | Lot '+p.lot+' | Serial '+p.serial+' | Exp '+p.expiration;}
$('diagnose').onclick=async()=>{
 if(busy)return;const raw=$('raw').value,action=$('action').value;diagnostic(raw);lock(true);
 try{
  const p=await api('/api/inspect',{raw});$('diagnostic').textContent+='\n'+JSON.stringify(p,null,2);
  if(p.match){closeUnknown();showProduct(p.match,p);status('Matched: '+p.match.description+'. Diagnosis only; nothing saved.');}
  else{showUnknown(p,raw,action);status('No unambiguous library match. Inventory unchanged.',true);}
 }catch(e){status(e.message,true);}finally{lock(false);}
};
$('scanForm').onsubmit=async event=>{
 event.preventDefault();if(busy)return;
 const raw=$('raw').value,action=$('action').value;diagnostic(raw);
 const signature=JSON.stringify([raw,action]);if(!pending||pending.signature!==signature)pending={signature,id:crypto.randomUUID()};lock(true);
 try{
  const p=await api('/api/scan',{raw,action,requestId:pending.id});
  closeUnknown();showProduct(p.product,p);$('diagnostic').textContent+='\n'+JSON.stringify(p,null,2);
  $('raw').value='';pending=null;
  status(action+' saved — '+p.product.description+'. '+(p.expiration<new Date().toISOString().slice(0,10)?'WARNING: manufacturer expiration is in the past.':''));
  try{await refresh();}catch{status('Scan saved; refresh failed. Do not scan again. Use Refresh.',true);}
 }catch(e){
  if(['UNKNOWN_PRODUCT','AMBIGUOUS_MATCH'].includes(e.code))showUnknown(e,raw,action);
  status(e.message+' Inventory save not confirmed. If the network failed, keep the scan unchanged to retry safely.',true);
 }finally{lock(false);$('raw').focus();}
};
$('productForm').onsubmit=async event=>{
 event.preventDefault();if(busy||!unknownContext)return;
 const context=unknownContext;
 if($('raw').value!==context.raw||$('action').value!==context.action){closeUnknown();status('Scan changed. Diagnose the new scan first.',true);return;}
 const body={...context,description:$('newDescription').value,ndc:$('newNDC').value,abc:$('newABC').value};lock(true);
 try{
  const r=await api('/api/products/add',body);closeUnknown();
  status('Library product ready: '+r.product.description+'. The vial is not received yet. Press Save scan to receive it.');
  try{await refresh();}catch{status('Library product saved; refresh failed. Press Refresh before receiving.',true);}
 }catch(e){status(e.message,true);}finally{lock(false);$('raw').focus();}
};
$('cancelProduct').onclick=closeUnknown;
$('raw').oninput=()=>{closeUnknown();$('lastProduct').textContent='';};
$('action').onchange=()=>{closeUnknown();$('raw').focus();};
// Some USB HID configurations emit the separator as Ctrl+]. Preserve it explicitly.
$('raw').addEventListener('keydown',event=>{
 if((event.ctrlKey&&!event.altKey&&(event.key===']'||event.code==='BracketRight'))||event.key==='\x1d'){
  event.preventDefault();const input=$('raw'),start=input.selectionStart??input.value.length,end=input.selectionEnd??start;
  input.setRangeText('\x1d',start,end,'end');input.dispatchEvent(new Event('input',{bubbles:true}));
 }
});
$('sample').onclick=()=>{closeUnknown();$('raw').value='010031672927730321V1SHKSWXF81P8X<GS>1726113010P2501497';diagnostic($('raw').value);status('Test input loaded only. Use Diagnose; nothing has been saved.');$('raw').focus();};
$('search').oninput=render;$('filter').onchange=render;
$('refresh').onclick=()=>refresh().catch(e=>status(e.message,true));
$('export').onclick=async()=>{
 try{
  if(!window.XLSX)throw Error('Excel library did not load');await refresh();const w=XLSX.utils.book_new();
  for(const [name,rows,headers]of[['Inventory',inventoryRows(),INVENTORY_HEADERS],['Activity',activityRows(),ACTIVITY_HEADERS],['Drug Library',libraryRows(),LIBRARY_HEADERS]]){
   const sheet=XLSX.utils.json_to_sheet(rows,{header:headers});sheet['!cols']=headers.map(h=>({wch:Math.max(16,Math.min(40,h.length+4))}));XLSX.utils.book_append_sheet(w,sheet,name);
  }
  XLSX.writeFile(w,'Oncology-Inventory-'+new Date().toISOString().slice(0,10)+'.xlsx');
 }catch(e){status(e.message,true);}
};
refresh().catch(e=>status(e.message,true));
