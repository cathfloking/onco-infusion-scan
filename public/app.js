const $=id=>document.getElementById(id);
const VIEWS=['home','scan','inventory','activity','more'];
let data={products:[],inventory:[],activity:[],version:''},previewRows=[],busy=false,pending=null,unknownContext=null,lastRefresh=0,view='home';
let adminCred=null,admin={products:[],aliases:[],audit:[],lots:[]},editing=null,aliasEditing=null,adjusting=null,adminBusy=false;
async function api(path,body,headers){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
 try{const options=body===undefined?{headers:headers||{},signal:controller.signal}:{method:'POST',headers:{'Content-Type':'application/json',...(headers||{})},body:JSON.stringify(body),signal:controller.signal};
 const r=await fetch(path,options),text=await r.text();let result;try{result=JSON.parse(text);}catch{throw Error('Non-JSON server response. Check sign-in/deployment.');}
 if(!r.ok){const e=new Error(result.error||'Request failed');Object.assign(e,result);throw e;}return result;}finally{clearTimeout(timer);}
}
const adminHeaders=()=>({'X-Admin-Authorization':adminCred});
let toastTimer;
function toast(text,error=false){const t=$('toast');t.textContent=text;t.className='toast show'+(error?' error':'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>{t.className='toast';},4500);}
function status(text,error=false){$('status').textContent=text;$('status').className=error?'status error':'status ok';}
// Stored times are UTC; the interface shows Eastern time (EST/EDT as applicable). Excel exports stay UTC.
const ET=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
function fmtET(iso){if(!iso)return '';const d=new Date(iso);return isNaN(d)?String(iso):ET.format(d);}
function table(target,rows,columns,rowClass){
 const t=document.createElement('table'),h=t.createTHead().insertRow();
 for(const c of columns){const th=document.createElement('th');th.textContent=c.label;if(c.button)th.className='action';h.append(th);}
 const b=t.createTBody();
 if(!rows.length){const td=b.insertRow().insertCell();td.colSpan=columns.length;td.className='empty';td.textContent='Nothing to show.';}
 for(const r of rows){const tr=b.insertRow(),rc=rowClass&&rowClass(r);if(rc)tr.className=rc;
  for(const c of columns){const td=tr.insertCell();td.dataset.label=c.label;if(c.mono)td.classList.add('mono');
   if(c.button){td.classList.add('action');const btn=document.createElement('button');btn.type='button';btn.className='btn small';btn.textContent=c.button(r);btn.addEventListener('click',()=>c.onClick(r));td.append(btn);}
   else if(c.badge){const v=String(c.value(r)??''),s=document.createElement('span');s.className='badge badge-'+v.toLowerCase().replace(/[^a-z]+/g,'-');s.textContent=v;td.append(s);}
   else td.textContent=c.value(r)??'';}}
 $(target).replaceChildren(t);
}
const cols=(keys,badge)=>keys.map(k=>({label:k,value:r=>r[k],mono:/NDC|Lot|Serial|GTIN/.test(k),badge:k===badge}));
const INV=['ABC #','Product Description','Supplier NDC11','Scanned Package NDC11','Scanned NDC10','GTIN','Tracking Mode','Lot Number','Serial Number','Expiration Date','Received Quantity','In Stock Quantity','Out Quantity','Net Adjustment In Stock','Net Adjustment Out','Status','First Received At (UTC)','Last Pulled At (UTC)','Last Returned At (UTC)','Last Action','Last Action At (UTC)','Pull Count','Return Count'];
const ACT=['ABC #','Product Description','Supplier NDC11','Scanned Package NDC11','Scanned NDC10','GTIN','Tracking Mode','Lot Number','Serial Number','Expiration Date','Action','Quantity','Scanned At (UTC)','Request ID','Parse Mode','Raw Scan'];
const LIB=['ABC #','Product Description','NDC','Status','Library Created At (UTC)','Library Record ID'];
function supplierAbc(key,map){const p=map.get(key);if(p)return p.supplier_abc??'';return String(key||'').startsWith('MANUAL-')?'':String(key||'');}
const productMap=()=>new Map(data.products.map(p=>[p.abc,p]));
function inventoryRows(){const m=productMap();return data.inventory.map(r=>({
 'ABC #':supplierAbc(r.product_abc,m),'Product Description':r.description,'Supplier NDC11':r.supplier_ndc11||r.ndc11,'Scanned Package NDC11':r.scanned_ndc11||'',
 'Scanned NDC10':r.ndc10||'','GTIN':String(r.gtin),'Tracking Mode':r.tracking_mode,'Lot Number':String(r.lot),'Serial Number':r.serial===null?'':String(r.serial),
 'Expiration Date':r.expiration,'Received Quantity':Number(r.received_quantity),'In Stock Quantity':Number(r.in_stock),'Out Quantity':Number(r.out_quantity),
 'Net Adjustment In Stock':Number(r.adjusted_in||0),'Net Adjustment Out':Number(r.adjusted_out||0),
 'Status':r.status,'First Received At (UTC)':r.scanned_in_at||'','Last Pulled At (UTC)':r.last_scanned_out_at||'','Last Returned At (UTC)':r.last_returned_at||'',
 'Last Action':r.last_action,'Last Action At (UTC)':r.last_action_at,'Pull Count':Number(r.pull_count),'Return Count':Number(r.return_count)}));}
function activityRows(){const m=productMap();return data.activity.map(r=>({
 'ABC #':supplierAbc(r.product_abc,m),'Product Description':r.description,'Supplier NDC11':r.supplier_ndc11||r.ndc11,'Scanned Package NDC11':r.scanned_ndc11||'',
 'Scanned NDC10':r.ndc10||'','GTIN':String(r.gtin),'Tracking Mode':r.tracking_mode,'Lot Number':String(r.lot),'Serial Number':r.serial===null?'':String(r.serial),
 'Expiration Date':r.expiration,'Action':r.action,'Quantity':Number(r.quantity??1),'Scanned At (UTC)':r.created_at,'Request ID':r.request_id,'Parse Mode':r.parse_mode||'legacy record','Raw Scan':r.raw_scan}));}
function libraryRows(){return data.products.map(r=>({'ABC #':r.supplier_abc??(String(r.abc).startsWith('MANUAL-')?'':r.abc),'Product Description':r.description,'NDC':String(r.ndc11),'Status':r.archived_at?'Archived':'Active','Library Created At (UTC)':r.created_at,'Library Record ID':r.abc}));}
function renderHome(){
 const today=new Date().toLocaleDateString('en-CA'),cutoff=new Date(Date.now()+90*864e5).toLocaleDateString('en-CA');
 let inStock=0,out=0,expiring=0,expired=0;
 for(const r of data.inventory){const i=Number(r.in_stock);inStock+=i;out+=Number(r.out_quantity);if(i>0){if(r.expiration<today)expired+=i;else if(r.expiration<=cutoff)expiring+=i;}}
 $('hIn').textContent=inStock;$('hOut').textContent=out;$('hExp').textContent=expiring;
 $('hExpired').hidden=expired===0;$('hExpired').textContent=expired+' In-stock vial'+(expired===1?'':'s')+' past manufacturer expiration';
 const last=data.activity[0];
 $('hLast').textContent=last?new Date(last.created_at).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'No activity yet';
 const todayCount=data.activity.filter(a=>new Date(a.created_at).toLocaleDateString('en-CA')===today).length;
 $('hToday').textContent=todayCount+(todayCount===1?' entry':' entries')+' today';
 const active=data.products.filter(p=>!p.archived_at).length;
 $('hLib').textContent=active;$('hArchived').textContent=data.products.length-active>0?(data.products.length-active)+' archived':'Medication catalog';
 $('libSummary').textContent=active+' entries'+(data.products.length-active>0?' ('+(data.products.length-active)+' archived)':'');
 $('hAdmin').textContent=adminCred?'Administrator unlocked':'Admin tools locked';
 $('versionText').textContent=data.version?'Version '+data.version:'';
}
function renderInventory(){
 const q=$('search').value.toLowerCase(),f=$('filter').value;
 const rows=inventoryRows().filter(r=>(!f||(f==='in'?r['In Stock Quantity']>0:r['Out Quantity']>0))&&JSON.stringify(r).toLowerCase().includes(q));
 table('inventory',rows,cols(['Product Description','Scanned Package NDC11','Tracking Mode','Lot Number','Serial Number','Expiration Date','In Stock Quantity','Out Quantity','Status'],'Status'));
 $('count').textContent=data.inventory.reduce((n,r)=>n+Number(r.in_stock),0)+' total vials In stock; '+data.inventory.reduce((n,r)=>n+Number(r.out_quantity),0)+' Out; '+rows.length+' inventory rows shown.';
}
function activityLabel(r){return r.action==='ADJUST'?'ADJUST '+(r.adjust_bucket==='OUT'?'Out':'In stock')+' '+(Number(r.quantity)>0?'+':'')+r.quantity:r.action;}
function renderActivity(){
 const rows=data.activity.slice(0,100).map(r=>({'Scanned At (Eastern)':fmtET(r.created_at),'Action':activityLabel(r),'Product Description':r.description,'Tracking Mode':r.tracking_mode,'Lot Number':String(r.lot),'Serial Number':r.serial===null?'':String(r.serial),
  'Detail':r.action==='ADJUST'?String(r.raw_scan).replace(/^Admin adjustment \([^)]*\): /,''):''}));
 table('activity',rows,cols(['Scanned At (Eastern)','Action','Product Description','Tracking Mode','Lot Number','Serial Number','Detail']));
}
// Drug library accordion (More tab). The long list is only built while expanded.
function renderLibrary(){
 if($('libBody').hidden)return;
 const q=$('libSearch').value.toLowerCase(),all=$('libArchived').checked;
 const rows=libraryRows().filter(r=>(all||r.Status==='Active')&&JSON.stringify(r).toLowerCase().includes(q));
 table('library',rows,[{label:'Supplier ABC',value:r=>r['ABC #']},{label:'Description',value:r=>r['Product Description']},{label:'NDC11',value:r=>r.NDC,mono:true},{label:'Status',value:r=>r.Status}],r=>r.Status==='Archived'?'archived':'');
 $('libCount').textContent=rows.length+' entries shown.';
}
function setLibrary(open){$('libBody').hidden=!open;$('libToggle').setAttribute('aria-expanded',String(open));if(open)renderLibrary();else $('library').replaceChildren();}
$('libToggle').addEventListener('click',()=>setLibrary($('libBody').hidden));
function renderAll(){renderHome();renderInventory();renderActivity();renderLibrary();}
async function refresh(){data=await api('/api/data');lastRefresh=Date.now();renderAll();}
// Dock: a single highlight slides to the selected tab.
function placeIndicator(){
 const a=document.querySelector('.dock a[aria-current=page]'),ind=$('dockInd');
 if(!a){ind.classList.remove('on');return;}
 let l=a.offsetLeft,t=a.offsetTop,w=a.offsetWidth,h=a.offsetHeight;
 if(a.classList.contains('scan')){const s=a.querySelector('.lbl');l=s.offsetLeft-12;t=s.offsetTop-4;w=s.offsetWidth+24;h=s.offsetHeight+8;}
 ind.style.width=w+'px';ind.style.height=h+'px';ind.style.transform='translate('+l+'px,'+t+'px)';ind.classList.add('on');
 if(!ind.classList.contains('anim'))requestAnimationFrame(()=>requestAnimationFrame(()=>ind.classList.add('anim')));
}
window.addEventListener('resize',placeIndicator);window.addEventListener('load',placeIndicator);
function show(name){
 const openLibrary=name==='library';if(openLibrary)name='more';
 if(!VIEWS.includes(name))name='home';view=name;
 for(const v of VIEWS)$('view-'+v).hidden=v!==name;
 for(const a of document.querySelectorAll('.dock a'))a.setAttribute('aria-current',a.dataset.tab===name?'page':'false');
 placeIndicator();
 window.scrollTo(0,0);
 if(openLibrary){setLibrary(true);setTimeout(()=>$('libAcc').scrollIntoView({block:'start'}),0);}
 if(name==='scan')setTimeout(()=>$('raw').focus(),0);
 else if(['home','inventory','activity','more'].includes(name)&&Date.now()-lastRefresh>30000)refresh().catch(e=>toast(e.message,true));
}
window.addEventListener('hashchange',()=>show(location.hash.slice(1)));
// Settings and theme
function markTheme(){for(const b of document.querySelectorAll('[data-theme-choice]'))b.classList.toggle('on',b.dataset.themeChoice===OncoTheme.get());}
$('gear').addEventListener('click',event=>{event.stopPropagation();const open=$('settings').hidden;$('settings').hidden=!open;$('gear').setAttribute('aria-expanded',String(open));markTheme();});
for(const b of document.querySelectorAll('[data-theme-choice]'))b.addEventListener('click',()=>{OncoTheme.set(b.dataset.themeChoice);markTheme();});
function closeSettings(){$('settings').hidden=true;$('gear').setAttribute('aria-expanded','false');}
document.addEventListener('click',event=>{if(!$('settings').hidden&&!$('settings').contains(event.target))closeSettings();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeSettings();});
// Keep the scan box focused on the Scan tab
document.addEventListener('click',event=>{if(view!=='scan'||busy)return;if(event.target.closest('input,textarea,select,button,summary,a,label,form'))return;if(window.getSelection&&String(getSelection()))return;$('raw').focus();});
window.addEventListener('focus',()=>{if(view==='scan'&&document.activeElement===document.body)$('raw').focus();});
// Scanning
const action=()=>document.querySelector('input[name=action]:checked').value;
function lock(value){busy=value;for(const id of ['raw','save','diagnose','sampleSerialized','sampleLot','addAlias','addProduct','cancelUnknown'])$(id).disabled=value;for(const r of document.querySelectorAll('input[name=action]'))r.disabled=value;}
function diagnostic(raw){$('diagnostic').textContent='Raw: '+raw.replace(/\x1d/g,'<GS>')+'\nCharacter codes: '+Array.from(raw).map(c=>c.charCodeAt(0)).join(',');}
function closeUnknown(){unknownContext=null;$('unknown').hidden=true;}
function showUnknown(info,raw,act){
 if(act!=='RECEIVE')return;unknownContext={raw,action:act};$('unknown').hidden=false;$('productForm').reset();$('aliasForm').reset();
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
 if(busy)return;const raw=$('raw').value,act=action();diagnostic(raw);lock(true);
 try{const p=await api('/api/inspect',{raw});$('diagnostic').textContent+='\n'+JSON.stringify(p,null,2);if(p.match){closeUnknown();showProduct(p,p.match);status('Matched'+(p.match.archived?' (library entry archived: new receipts blocked)':'')+'. Diagnosis only; nothing saved.');}else{showUnknown(p,raw,act);status('Resolve the product/package before receiving.',true);}}
 catch(e){status(e.message,true);}finally{lock(false);$('raw').focus();}
};
$('scanForm').onsubmit=async event=>{
 event.preventDefault();if(busy)return;const raw=$('raw').value,act=action();diagnostic(raw);const signature=JSON.stringify([raw,act]);if(!pending||pending.signature!==signature)pending={signature,id:crypto.randomUUID()};lock(true);
 try{const p=await api('/api/scan',{raw,action:act,requestId:pending.id});closeUnknown();showProduct(p,p.product);$('diagnostic').textContent+='\n'+JSON.stringify(p,null,2);$('raw').value='';pending=null;
 status(act+' saved - ONE vial. '+(p.replayed?'Original result recovered; not counted again. ':'')+(p.expiration<new Date().toISOString().slice(0,10)?'WARNING: manufacturer expiration is in the past.':''));
 try{await refresh();}catch{status('Scan saved; refresh failed. Do not scan again. Use Refresh on the Inventory tab.',true);}
 }catch(e){if(['UNKNOWN_PRODUCT','AMBIGUOUS_MATCH'].includes(e.code))showUnknown(e,raw,act);status(e.message+' Save not confirmed. After a network failure, keep this scan unchanged to retry safely.',true);}
 finally{lock(false);$('raw').focus();}
};
async function resolveUnknown(event,type){
 event.preventDefault();if(busy||!unknownContext)return;const context=unknownContext;
 if($('raw').value!==context.raw||action()!==context.action){closeUnknown();status('Scan changed. Diagnose again.',true);return;}
 const body=type==='alias'?{...context,productId:$('aliasProduct').value,scannedNDC:$('aliasNDC').value,reason:$('aliasReason').value}:{...context,description:$('newDescription').value,ndc:$('newNDC').value,abc:$('newABC').value};lock(true);
 try{const r=await api(type==='alias'?'/api/packages/add':'/api/products/add',body);closeUnknown();status('Library association ready: '+r.product.description+'. No vial received yet. Press Save scan.');try{await refresh();}catch{status('Library association saved; refresh failed. Use Refresh on the Inventory tab.',true);}}
 catch(e){status(e.message,true);}finally{lock(false);$('raw').focus();}
}
$('aliasProduct').onchange=()=>{const product=data.products.find(p=>p.abc===$('aliasProduct').value);if(product){const option=Array.from($('aliasNDC').options).find(o=>o.value.slice(0,9)===product.ndc11.slice(0,9));if(option)$('aliasNDC').value=option.value;}};
$('productForm').onsubmit=e=>resolveUnknown(e,'product');$('aliasForm').onsubmit=e=>resolveUnknown(e,'alias');$('cancelUnknown').onclick=()=>{closeUnknown();$('raw').focus();};
$('raw').oninput=()=>{closeUnknown();$('lastProduct').textContent='';};
for(const r of document.querySelectorAll('input[name=action]'))r.onchange=()=>{closeUnknown();$('raw').focus();};
$('raw').addEventListener('keydown',event=>{if((event.ctrlKey&&!event.altKey&&(event.key===']'||event.code==='BracketRight'))||event.key==='\x1d'){event.preventDefault();const i=$('raw'),start=i.selectionStart??i.value.length,end=i.selectionEnd??start;i.setRangeText('\x1d',start,end,'end');i.dispatchEvent(new Event('input',{bubbles:true}));}});
function loadSample(raw){closeUnknown();$('raw').value=raw;diagnostic(raw);status('Sample loaded only. Use Diagnose; nothing saved.');$('raw').focus();}
$('sampleSerialized').onclick=()=>loadSample('010031672927730321V1SHKSWXF81P8X1726113010P2501497');
$('sampleLot').onclick=()=>loadSample('010036332388401717271031106038205');
// Inventory, library, export
$('search').oninput=renderInventory;$('filter').onchange=renderInventory;$('libSearch').oninput=renderLibrary;$('libArchived').onchange=renderLibrary;
$('refresh').onclick=()=>refresh().then(()=>toast('Refreshed.')).catch(e=>toast(e.message,true));
function writeSheets(file,sheets){const wb=XLSX.utils.book_new();for(const[name,rows,headers]of sheets){const sheet=XLSX.utils.json_to_sheet(rows,{header:headers});sheet['!cols']=headers.map(h=>({wch:Math.max(16,Math.min(40,h.length+4))}));XLSX.utils.book_append_sheet(wb,sheet,name);}XLSX.writeFile(wb,file+'-'+new Date().toISOString().slice(0,10)+'.xlsx');}
$('export').onclick=async()=>{try{if(!window.XLSX)throw Error('Excel library did not load');await refresh();writeSheets('Oncology-Inventory',[['Inventory',inventoryRows(),INV],['Activity',activityRows(),ACT],['Drug Library',libraryRows(),LIB]]);}catch(e){toast(e.message,true);}};
$('exportLib').onclick=async()=>{try{if(!window.XLSX)throw Error('Excel library did not load');await refresh();writeSheets('Drug-Library',[['Drug Library',libraryRows(),LIB]]);}catch(e){toast(e.message,true);}};
// Administration (More tab)
function adminMsg(text,error=false){$('adminStatus').textContent=text;$('adminStatus').className=error?'status error':'status ok';}
function showAdmin(open){$('adminLocked').hidden=open;$('adminOpen').hidden=!open;renderHome();}
function lockAdmin(){adminCred=null;admin={products:[],aliases:[],audit:[],lots:[]};editing=null;aliasEditing=null;adjusting=null;previewRows=[];$('import').disabled=true;$('previewText').textContent='No file selected.';$('file').value='';$('editForm').hidden=true;$('aliasEditForm').hidden=true;$('adjForm').hidden=true;$('adminPass').value='';showAdmin(false);}
async function adminLoad(){admin=await api('/api/admin/data',undefined,adminHeaders());renderAdmin();}
function renderAdmin(){
 const q=$('aLibSearch').value.toLowerCase().trim(),all=$('aShowArchived').checked;
 table('aLibTable',admin.products.filter(p=>(all||!p.archived_at)&&(!q||[p.description,p.ndc11,p.supplier_abc,p.id].join(' ').toLowerCase().includes(q))),[
  {label:'Action',button:()=>'Edit',onClick:startEdit},{label:'Supplier ABC',value:p=>p.supplier_abc??''},{label:'Description',value:p=>p.description},{label:'NDC11',value:p=>p.ndc11,mono:true},
  {label:'Status',value:p=>p.archived_at?'Archived '+fmtET(p.archived_at):'Active'},{label:'Activity records',value:p=>p.activity_count},{label:'Version',value:p=>p.version}],p=>p.archived_at?'archived':'');
 table('aliasTable',admin.aliases,[
  {label:'Action',button:a=>Number(a.enabled)===1?'Disable':'Enable',onClick:startAlias},{label:'GTIN',value:a=>a.gtin,mono:true},{label:'Library entry',value:a=>a.description},{label:'Scanned vial NDC11',value:a=>a.scanned_ndc11,mono:true},{label:'Supplier NDC11',value:a=>a.supplier_ndc11,mono:true},
  {label:'Unit',value:a=>a.units_per_scan+' '+a.unit_label+' per scan'},{label:'Verification source',value:a=>a.source},{label:'Created',value:a=>fmtET(a.created_at)},
  {label:'Status',value:a=>Number(a.enabled)===1?'Enabled':'Disabled '+fmtET(a.disabled_at)},{label:'Version',value:a=>a.version}],a=>Number(a.enabled)===1?'':'disabled');
 const sq=$('aStockSearch').value.toLowerCase().trim();
 table('stockTable',admin.lots.filter(g=>!sq||[g.description,g.lot,g.expiration].join(' ').toLowerCase().includes(sq)),[
  {label:'Action',button:()=>'Adjust',onClick:startAdjust},{label:'Product',value:g=>g.description},{label:'Lot',value:g=>g.lot,mono:true},{label:'Expiration',value:g=>g.expiration},
  {label:'In stock',value:g=>g.in_stock},{label:'Out',value:g=>g.out_quantity},{label:'Net adjustments',value:g=>'In stock '+(g.adjusted_in>0?'+':'')+g.adjusted_in+' | Out '+(g.adjusted_out>0?'+':'')+g.adjusted_out}]);
 table('auditTable',admin.audit,[
  {label:'Time (Eastern)',value:a=>fmtET(a.at)},{label:'Actor',value:a=>a.actor},{label:'Action',value:a=>a.action},{label:'Record',value:a=>a.entity_type+' '+a.entity_id,mono:true},
  {label:'Reason',value:a=>a.reason},{label:'Before',value:a=>a.before_json,mono:true},{label:'After',value:a=>a.after_json,mono:true}]);
}
function startEdit(p){editing=p;$('editForm').hidden=false;$('editInfo').textContent='NDC '+p.ndc11+' | internal key '+p.id+' | version '+p.version+(p.archived_at?' | ARCHIVED':'');
 $('editDescription').value=p.description;$('editAbc').value=p.supplier_abc??'';$('editReason').value='';$('toggleArchive').textContent=p.archived_at?'Unarchive':'Archive';$('editForm').scrollIntoView({block:'center'});$('editDescription').focus();}
function startAlias(a){aliasEditing=a;const enabling=Number(a.enabled)!==1;$('aliasEditForm').hidden=false;$('aliasTitle').textContent=(enabling?'Enable':'Disable')+' package alias';
 $('aliasInfo').textContent='GTIN '+a.gtin+' | '+a.description+' | scanned NDC '+a.scanned_ndc11+' | version '+a.version;$('aliasEditReason').value='';$('saveAlias').textContent=enabling?'Enable alias':'Disable alias';$('aliasEditForm').scrollIntoView({block:'center'});$('aliasEditReason').focus();}
function startAdjust(g){adjusting=g;$('adjForm').hidden=false;$('adjInfo').textContent=g.description+' | lot '+g.lot+' | exp '+g.expiration+' | currently '+g.in_stock+' In stock, '+g.out_quantity+' Out';
 $('adjMode').value='add';$('adjBucket').value='IN_STOCK';$('adjQty').value='1';$('adjReason').value='';$('adjForm').scrollIntoView({block:'center'});$('adjReason').focus();}
async function adminAct(fn){
 if(adminBusy)return;adminBusy=true;
 try{await fn();}
 catch(e){adminMsg(e.message,true);if(e.code==='STALE_VERSION'){try{await adminLoad();}catch{}}else if(e.code==='ADMIN_REQUIRED'){lockAdmin();adminMsg('Administrator sign-in required.',true);}}
 finally{adminBusy=false;}
}
$('adminForm').addEventListener('submit',event=>{event.preventDefault();adminAct(async()=>{
 try{adminCred='Basic '+btoa($('adminUser').value+':'+$('adminPass').value);$('adminPass').value='';await adminLoad();}catch(e){adminCred=null;throw e;}
 showAdmin(true);adminMsg('Signed in as administrator.');});});
$('adminLock').addEventListener('click',()=>{lockAdmin();adminMsg('Administration locked.');});
$('adminReload').addEventListener('click',()=>adminAct(async()=>{await adminLoad();await refresh();adminMsg('Refreshed.');}));
for(const b of document.querySelectorAll('[data-atab]'))b.addEventListener('click',()=>{for(const x of document.querySelectorAll('[data-atab]')){x.classList.toggle('on',x===b);$('atab-'+x.dataset.atab).hidden=x!==b;}});
$('aLibSearch').addEventListener('input',renderAdmin);$('aShowArchived').addEventListener('change',renderAdmin);$('aStockSearch').addEventListener('input',renderAdmin);
$('cancelEdit').addEventListener('click',()=>{editing=null;$('editForm').hidden=true;});$('cancelAlias').addEventListener('click',()=>{aliasEditing=null;$('aliasEditForm').hidden=true;});$('cancelAdj').addEventListener('click',()=>{adjusting=null;$('adjForm').hidden=true;});
$('editForm').addEventListener('submit',event=>{event.preventDefault();if(!editing)return;adminAct(async()=>{
 const r=await api('/api/admin/product/update',{id:editing.id,version:editing.version,description:$('editDescription').value,supplierAbc:$('editAbc').value,reason:$('editReason').value},adminHeaders());
 editing=null;$('editForm').hidden=true;await adminLoad();await refresh();adminMsg('Saved. Library entry '+r.id+' is now version '+r.version+'.');});});
$('toggleArchive').addEventListener('click',()=>{if(!editing)return;adminAct(async()=>{
 const r=await api('/api/admin/product/archive',{id:editing.id,version:editing.version,archived:!editing.archived_at,reason:$('editReason').value},adminHeaders());
 editing=null;$('editForm').hidden=true;await adminLoad();await refresh();adminMsg('Saved. Library entry '+r.id+' is now version '+r.version+'.');});});
$('aliasEditForm').addEventListener('submit',event=>{event.preventDefault();if(!aliasEditing)return;adminAct(async()=>{
 const r=await api('/api/admin/alias/enabled',{gtin:aliasEditing.gtin,version:aliasEditing.version,enabled:Number(aliasEditing.enabled)!==1,reason:$('aliasEditReason').value},adminHeaders());
 aliasEditing=null;$('aliasEditForm').hidden=true;await adminLoad();adminMsg('Saved. Alias is now version '+r.version+'.');});});
$('adjForm').addEventListener('submit',event=>{event.preventDefault();if(!adjusting)return;adminAct(async()=>{
 const qty=Number($('adjQty').value);if(!Number.isInteger(qty)||qty<1||qty>1000)throw Error('Enter a whole quantity from 1 to 1000.');
 const body={gtin:adjusting.gtin,lot:adjusting.lot,expiration:adjusting.expiration,bucket:$('adjBucket').value,delta:($('adjMode').value==='remove'?-1:1)*qty,reason:$('adjReason').value,expectedIn:Number(adjusting.in_stock),expectedOut:Number(adjusting.out_quantity)};
 const r=await api('/api/admin/inventory/adjust',body,adminHeaders());
 adjusting=null;$('adjForm').hidden=true;await adminLoad();await refresh();adminMsg('Saved. Lot now has '+r.in_stock+' In stock and '+r.out_quantity+' Out.');});});
// Admin-only library upload
function identifier(v){if(typeof v==='number'){if(!Number.isSafeInteger(v)||v<0)throw Error('Invalid numeric identifier');return String(v);}return String(v??'').trim();}
function normalizeNDC(v){let s=identifier(v);if(/^\d{5}-\d{4}-\d{2}$/.test(s))return s.replace(/-/g,'');if(/^\d+(?:\.\d+)?[eE][+]?\d+$/.test(s)){const n=Number(s);if(!Number.isSafeInteger(n))throw Error('Invalid NDC');s=String(n);}if(!/^\d{1,11}$/.test(s))throw Error('Invalid supplier NDC');return s.padStart(11,'0');}
$('file').onchange=()=>{previewRows=[];$('import').disabled=true;};
$('preview').onclick=async()=>{
 try{previewRows=[];$('import').disabled=true;if(!window.XLSX)throw Error('Excel library did not load');const file=$('file').files[0];if(!file)throw Error('Choose a file');if(file.size>5000000)throw Error('Use a file below 5 MB');
 const wb=XLSX.read(await file.arrayBuffer(),{type:'array'}),rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:true,defval:''});if(!rows.length)throw Error('Empty worksheet');
 const h=rows[0].map(v=>String(v).replace(/\s/g,'').toLowerCase());if(h[0]!=='abc#'||h[1]!=='productdescription'||h[2]!=='ndc')throw Error('Expected ABC #, Product Description, NDC in A-C');
 const seen=new Map(),good=[],errors=[];let duplicates=0,edited=0;
 for(let i=1;i<rows.length;i++){if(rows[i].every(v=>v===''))continue;try{
  const r={abc:identifier(rows[i][0]),description:String(rows[i][1]).trim(),ndc:identifier(rows[i][2])},normalized=normalizeNDC(r.ndc);
  if(!/^\d{1,30}$/.test(r.abc)||!r.description||r.description.length>300)throw Error('Invalid ABC/description');
  const p=seen.get(r.abc);if(p){if(p.normalized!==normalized||p.description!==r.description)throw Error('Conflicting duplicate ABC '+r.abc);duplicates++;continue;}
  const old=data.products.find(x=>x.abc===r.abc);if(old&&Number(old.version)>1){edited++;}else if(old&&(old.ndc11!==normalized||old.description!==r.description))throw Error('Existing ABC conflicts '+r.abc);
  seen.set(r.abc,{normalized,description:r.description});good.push({...r,normalized});
 }catch(e){errors.push('Row '+(i+1)+': '+e.message);}}
 $('previewText').textContent=good.length+' unique rows; '+duplicates+' duplicates; '+edited+' admin-edited entries will be left unchanged; '+errors.length+' errors.\n'+errors.slice(0,30).join('\n')+'\nPreview:\n'+JSON.stringify(good.slice(0,8),null,2);
 if(!errors.length&&good.length){previewRows=good;$('import').disabled=false;}
 }catch(e){$('previewText').textContent=e.message;}
};
$('import').onclick=()=>{if(!previewRows.length)return;$('import').disabled=true;adminAct(async()=>{try{const r=await api('/api/import',{rows:previewRows},adminHeaders());previewRows=[];$('previewText').textContent='Imported '+r.inserted+'; skipped '+r.skipped;await refresh();await adminLoad();}catch(e){$('previewText').textContent=e.message+' Earlier batches may have imported. Refresh and preview before retrying.';throw e;}});};
// Start
show(location.hash.slice(1)||'home');
refresh().catch(e=>{toast(e.message,true);});
