const $=id=>document.getElementById(id);
let data={products:[],inventory:[],activity:[]},preview=[],busy=false,pending=null,unknownContext=null;
async function api(path,body){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
 try{const r=await fetch(path,body===undefined?{signal:controller.signal}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
 const text=await r.text();let result;try{result=JSON.parse(text);}catch{throw Error('Non-JSON server response. Check sign-in/deployment.');}if(!r.ok){const e=new Error(result.error||'Request failed');Object.assign(e,result);throw e;}return result;}finally{clearTimeout(timer);}
}
function status(text,error=false){$('status').textContent=text;$('status').className=error?'error':'ok';}
function lock(value){busy=value;for(const id of ['raw','action','save','diagnose','sampleSerialized','sampleLot','addAlias','addProduct','cancelUnknown'])$(id).disabled=value;}
function table(target,rows,columns){const t=document.createElement('table'),h=t.createTHead().insertRow();for(const k of columns){const c=document.createElement('th');c.textContent=k;h.append(c);}const b=t.createTBody();for(const r of rows){const tr=b.insertRow();for(const k of columns)tr.insertCell().textContent=r[k]??'';}$(target).replaceChildren(t);}
const INV=['ABC #','Product Description','Supplier NDC11','Scanned Package NDC11','Scanned NDC10','GTIN','Tracking Mode','Lot Number','Serial Number','Expiration Date','Received Quantity','In Stock Quantity','Out Quantity','Status','First Received At (UTC)','Last Pulled At (UTC)','Last Returned At (UTC)','Last Action','Last Action At (UTC)','Pull Count','Return Count'];
const ACT=['ABC #','Product Description','Supplier NDC11','Scanned Package NDC11','Scanned NDC10','GTIN','Tracking Mode','Lot Number','Serial Number','Expiration Date','Action','Quantity','Scanned At (UTC)','Request ID','Parse Mode','Raw Scan'];
const LIB=['ABC #','Product Description','NDC','Library Created At (UTC)','Library Record ID'];
function abc(s){return String(s||'').startsWith('MANUAL-')?'':String(s||'');}
function inventoryRows(){return data.inventory.map(r=>({
 'ABC #':abc(r.product_abc),'Product Description':r.description,'Supplier NDC11':r.supplier_ndc11||r.ndc11,'Scanned Package NDC11':r.scanned_ndc11||'',
 'Scanned NDC10':r.ndc10||'','GTIN':String(r.gtin),'Tracking Mode':r.tracking_mode,'Lot Number':String(r.lot),'Serial Number':r.serial===null?'':String(r.serial),
 'Expiration Date':r.expiration,'Received Quantity':Number(r.received_quantity),'In Stock Quantity':Number(r.in_stock),'Out Quantity':Number(r.out_quantity),
 'Status':r.status,'First Received At (UTC)':r.scanned_in_at||'','Last Pulled At (UTC)':r.last_scanned_out_at||'','Last Returned At (UTC)':r.last_returned_at||'',
 'Last Action':r.last_action,'Last Action At (UTC)':r.last_action_at,'Pull Count':Number(r.pull_count),'Return Count':Number(r.return_count)
}));}
function activityRows(){return data.activity.map(r=>({
 'ABC #':abc(r.product_abc),'Product Description':r.description,'Supplier NDC11':r.supplier_ndc11||r.ndc11,'Scanned Package NDC11':r.scanned_ndc11||'',
 'Scanned NDC10':r.ndc10||'','GTIN':String(r.gtin),'Tracking Mode':r.tracking_mode,'Lot Number':String(r.lot),'Serial Number':r.serial===null?'':String(r.serial),
 'Expiration Date':r.expiration,'Action':r.action,'Quantity':1,'Scanned At (UTC)':r.created_at,'Request ID':r.request_id,'Parse Mode':r.parse_mode||'legacy record','Raw Scan':r.raw_scan
}));}
function libraryRows(){return data.products.map(r=>({'ABC #':abc(r.abc),'Product Description':r.description,'NDC':String(r.ndc11),'Library Created At (UTC)':r.created_at,'Library Record ID':r.abc}));}
function render(){
 const q=$('search').value.toLowerCase(),f=$('filter').value;
 const rows=inventoryRows().filter(r=>(!f||(f==='in'?r['In Stock Quantity']>0:r['Out Quantity']>0))&&JSON.stringify(r).toLowerCase().includes(q));
 table('inventory',rows,['Product Description','Scanned Package NDC11','Tracking Mode','Lot Number','Serial Number','Expiration Date','In Stock Quantity','Out Quantity','Status']);
 $('count').textContent=data.inventory.reduce((n,r)=>n+Number(r.in_stock),0)+' total vials In stock; '+data.inventory.reduce((n,r)=>n+Number(r.out_quantity),0)+' Out; '+rows.length+' inventory rows shown.';
 table('activity',activityRows().slice(0,100),['Scanned At (UTC)','Action','Product Description','Tracking Mode','Lot Number','Serial Number']);
}
async function refresh(){data=await api('/api/data');render();}
function identifier(v){if(typeof v==='number'){if(!Number.isSafeInteger(v)||v<0)throw Error('Invalid numeric identifier');return String(v);}return String(v??'').trim();}
function normalizeNDC(v){let s=identifier(v);if(/^\d{5}-\d{4}-\d{2}$/.test(s))return s.replace(/-/g,'');if(/^\d+(?:\.\d+)?[eE][+]?\d+$/.test(s)){const n=Number(s);if(!Number.isSafeInteger(n))throw Error('Invalid NDC');s=String(n);}if(!/^\d{1,11}$/.test(s))throw Error('Invalid supplier NDC');return s.padStart(11,'0');}
$('file').onchange=()=>{preview=[];$('import').disabled=true;};
$('preview').onclick=async()=>{
 try{preview=[];$('import').disabled=true;if(!window.XLSX)throw Error('Excel library did not load');const file=$('file').files[0];if(!file)throw Error('Choose a file');if(file.size>5000000)throw Error('Use a file below 5 MB');
 const wb=XLSX.read(await file.arrayBuffer(),{type:'array'}),rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:true,defval:''});if(!rows.length)throw Error('Empty worksheet');
 const h=rows[0].map(v=>String(v).replace(/\s/g,'').toLowerCase());if(h[0]!=='abc#'||h[1]!=='productdescription'||h[2]!=='ndc')throw Error('Expected ABC #, Product Description, NDC in A-C');
 const seen=new Map(),good=[],errors=[];let duplicates=0;
 for(let i=1;i<rows.length;i++){if(rows[i].every(v=>v===''))continue;try{
  const r={abc:identifier(rows[i][0]),description:String(rows[i][1]).trim(),ndc:identifier(rows[i][2])},normalized=normalizeNDC(r.ndc);
  if(!/^\d{1,30}$/.test(r.abc)||!r.description||r.description.length>300)throw Error('Invalid ABC/description');
  const p=seen.get(r.abc);if(p){if(p.normalized!==normalized||p.description!==r.description)throw Error('Conflicting duplicate ABC '+r.abc);duplicates++;continue;}
  const old=data.products.find(p=>p.abc===r.abc);if(old&&(old.ndc11!==normalized||old.description!==r.description))throw Error('Existing ABC conflicts '+r.abc);
  seen.set(r.abc,{normalized,description:r.description});good.push({...r,normalized});
 }catch(e){errors.push('Row '+(i+1)+': '+e.message);}}
 $('previewText').textContent=good.length+' unique rows; '+duplicates+' duplicates; '+errors.length+' errors.\n'+errors.slice(0,30).join('\n')+'\nPreview:\n'+JSON.stringify(good.slice(0,8),null,2);
 if(!errors.length&&good.length){preview=good;$('import').disabled=false;}
 }catch(e){$('previewText').textContent=e.message;}
};
$('import').onclick=async()=>{if(!preview.length)return;$('import').disabled=true;try{const r=await api('/api/import',{rows:preview});preview=[];$('previewText').textContent='Imported '+r.inserted+'; skipped '+r.skipped;await refresh();}catch(e){$('previewText').textContent=e.message+' Earlier batches may have imported. Refresh and preview before retrying.';}};
function diagnostic(raw){$('diagnostic').textContent='Raw: '+raw.replace(/\x1d/g,'<GS>')+'\nCharacter codes: '+Array.from(raw).map(c=>c.charCodeAt(0)).join(',');}
function closeUnknown(){unknownContext=null;$('unknown').hidden=true;}
function showUnknown(info,raw,action){
 if(action!=='RECEIVE')return;unknownContext={raw,action};$('unknown').hidden=false;$('productForm').reset();$('aliasForm').reset();
 const p=info.parsed||info;
 $('unknownDetails').textContent='GTIN '+p.gtin+' | Lot '+p.lot+' | Exp '+p.expiration+' | '+p.tracking_mode+'. No inventory has been saved.';
 $('ndcOptions').replaceChildren();$('aliasNDC').replaceChildren();for(const n of info.candidates||[]){$('ndcOptions').append(new Option(n,n));$('aliasNDC').add(new Option(n,n));}
 $('aliasProduct').replaceChildren(new Option('Choose verified supplier entry',''));
 for(const candidate of info.suggestions||[])$('aliasProduct').add(new Option(candidate.description+' | '+candidate.ndc11,candidate.libraryId));
 $('aliasPanel').hidden=!(info.suggestions||[]).length;$('aliasPanel').open=!!(info.suggestions||[]).length;
 if((info.matches||[]).length)$('unknownDetails').textContent+=' Candidate NDC entries: '+info.matches.map(m=>m.description+' ['+m.ndc11+']').join('; ');
}
function showProduct(p,product){$('lastProduct').textContent=product.description+' | Supplier NDC '+product.ndc11+' | Scanned NDC '+(p.scanned_ndc11||'not established')+' | '+p.tracking_mode+' | Lot '+p.lot+' | Serial '+(p.serial??'not encoded')+' | Exp '+p.expiration;}
$('diagnose').onclick=async()=>{
 if(busy)return;const raw=$('raw').value,action=$('action').value;diagnostic(raw);lock(true);
 try{const p=await api('/api/inspect',{raw});$('diagnostic').textContent+='\n'+JSON.stringify(p,null,2);if(p.match){closeUnknown();showProduct(p,p.match);status('Matched. Diagnosis only; nothing saved.');}else{showUnknown(p,raw,action);status('Resolve the product/package before receiving.',true);}}
 catch(e){status(e.message,true);}finally{lock(false);}
};
$('scanForm').onsubmit=async event=>{
 event.preventDefault();if(busy)return;const raw=$('raw').value,action=$('action').value;diagnostic(raw);const signature=JSON.stringify([raw,action]);if(!pending||pending.signature!==signature)pending={signature,id:crypto.randomUUID()};lock(true);
 try{const p=await api('/api/scan',{raw,action,requestId:pending.id});closeUnknown();showProduct(p,p.product);$('diagnostic').textContent+='\n'+JSON.stringify(p,null,2);$('raw').value='';pending=null;
 status(action+' saved — ONE vial. '+(p.replayed?'Original result recovered; not counted again. ':'')+(p.expiration<new Date().toISOString().slice(0,10)?'WARNING: manufacturer expiration is in the past.':''));
 try{await refresh();}catch{status('Scan saved; refresh failed. Do not scan again. Use Refresh.',true);}
 }catch(e){if(['UNKNOWN_PRODUCT','AMBIGUOUS_MATCH'].includes(e.code))showUnknown(e,raw,action);status(e.message+' Save not confirmed. After a network failure, keep this scan unchanged to retry safely.',true);}
 finally{lock(false);$('raw').focus();}
};
async function resolveUnknown(event,type){
 event.preventDefault();if(busy||!unknownContext)return;const context=unknownContext;
 if($('raw').value!==context.raw||$('action').value!==context.action){closeUnknown();status('Scan changed. Diagnose again.',true);return;}
 const body=type==='alias'?{...context,productId:$('aliasProduct').value,scannedNDC:$('aliasNDC').value,reason:$('aliasReason').value}:{...context,description:$('newDescription').value,ndc:$('newNDC').value,abc:$('newABC').value};lock(true);
 try{const r=await api(type==='alias'?'/api/packages/add':'/api/products/add',body);closeUnknown();status('Library association ready: '+r.product.description+'. No vial received yet. Press Save scan.');try{await refresh();}catch{status('Library association saved; refresh failed. Use Refresh.',true);}}
 catch(e){status(e.message,true);}finally{lock(false);$('raw').focus();}
}
$('aliasProduct').onchange=()=>{const product=data.products.find(p=>p.abc===$('aliasProduct').value);if(product){const option=Array.from($('aliasNDC').options).find(o=>o.value.slice(0,9)===product.ndc11.slice(0,9));if(option)$('aliasNDC').value=option.value;}};
$('productForm').onsubmit=e=>resolveUnknown(e,'product');$('aliasForm').onsubmit=e=>resolveUnknown(e,'alias');$('cancelUnknown').onclick=closeUnknown;
$('raw').oninput=()=>{closeUnknown();$('lastProduct').textContent='';};$('action').onchange=()=>{closeUnknown();$('raw').focus();};
$('raw').addEventListener('keydown',event=>{if((event.ctrlKey&&!event.altKey&&(event.key===']'||event.code==='BracketRight'))||event.key==='\x1d'){event.preventDefault();const i=$('raw'),start=i.selectionStart??i.value.length,end=i.selectionEnd??start;i.setRangeText('\x1d',start,end,'end');i.dispatchEvent(new Event('input',{bubbles:true}));}});
function loadSample(raw){closeUnknown();$('raw').value=raw;diagnostic(raw);status('Sample loaded only. Use Diagnose; nothing saved.');$('raw').focus();}
$('sampleSerialized').onclick=()=>loadSample('010031672927730321V1SHKSWXF81P8X1726113010P2501497');
$('sampleLot').onclick=()=>loadSample('010036332388401717271031106038205');
$('search').oninput=render;$('filter').onchange=render;$('refresh').onclick=()=>refresh().catch(e=>status(e.message,true));
$('export').onclick=async()=>{try{if(!window.XLSX)throw Error('Excel library did not load');await refresh();const wb=XLSX.utils.book_new();for(const[name,rows,headers]of[['Inventory',inventoryRows(),INV],['Activity',activityRows(),ACT],['Drug Library',libraryRows(),LIB]]){const sheet=XLSX.utils.json_to_sheet(rows,{header:headers});sheet['!cols']=headers.map(h=>({wch:Math.max(16,Math.min(40,h.length+4))}));XLSX.utils.book_append_sheet(wb,sheet,name);}XLSX.writeFile(wb,'Oncology-Inventory-'+new Date().toISOString().slice(0,10)+'.xlsx');}catch(e){status(e.message,true);}};
refresh().catch(e=>status(e.message,true));
