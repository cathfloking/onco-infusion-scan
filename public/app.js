const $=id=>document.getElementById(id);
const VIEWS=['home','scan','inventory','activity','more'];
let data={products:[],inventory:[],activity:[],version:''},previewRows=[],busy=false,pending=null,unknownContext=null,lastRefresh=0,view='home',libTimer;
let adminCred=null,admin={products:[],aliases:[],audit:[],lots:[]},aliasEditing=null,adjusting=null,adminBusy=false;
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
// ---- Sortable tables: click a heading (or use the Sort by control on small screens). Order is kept across refreshes.
const sorts={},redraws={},NUMERIC=/Quantity|Count|Version|^In stock$|^Out$|Activity records/;
const cmp=(a,b,num)=>num?(Number(a)||0)-(Number(b)||0):String(a??'').localeCompare(String(b??''),undefined,{numeric:true,sensitivity:'base'});
function setSort(target,key,dir){if(key)sorts[target]={key,dir:dir||'asc'};else delete sorts[target];redraws[target]();}
function cycleSort(target,key){const s=sorts[target];if(!s||s.key!==key)setSort(target,key,'asc');else if(s.dir==='asc')setSort(target,key,'desc');else setSort(target,null);}
function sortbar(target,columns){
 let bar=document.getElementById(target+'Sort');
 if(!bar){bar=document.createElement('div');bar.id=target+'Sort';bar.className='sortbar';
  const lab=document.createElement('label');lab.append('Sort by ');const sel=document.createElement('select');lab.append(sel);
  const dir=document.createElement('button');dir.type='button';dir.className='btn small';
  sel.addEventListener('change',()=>setSort(target,sel.value,sorts[target]?.dir));
  dir.addEventListener('click',()=>{const s=sorts[target];if(s)setSort(target,s.key,s.dir==='asc'?'desc':'asc');});
  bar.append(lab,dir);$(target).before(bar);}
 const sel=bar.querySelector('select'),dir=bar.querySelector('button'),keys=columns.filter(c=>!c.button).map(c=>c.label);
 if(sel.dataset.sig!==keys.join('|')){sel.replaceChildren(new Option('Default order',''),...keys.map(k=>new Option(k,k)));sel.dataset.sig=keys.join('|');}
 const s=sorts[target];sel.value=s?s.key:'';dir.textContent=s?(s.dir==='asc'?'\u25B2 Ascending':'\u25BC Descending'):'\u2014';dir.disabled=!s;
}
function table(target,rows,columns,rowClass){
 redraws[target]=()=>table(target,rows,columns,rowClass);sortbar(target,columns);
 const s=sorts[target];let list=rows;
 const sc=s&&columns.find(c=>c.label===s.key&&!c.button);
 if(sc){const val=r=>sc.sort?sc.sort(r):sc.value(r),num=sc.numeric??NUMERIC.test(sc.label);list=[...rows].sort((a,b)=>cmp(val(a),val(b),num)*(s.dir==='desc'?-1:1));}
 const t=document.createElement('table'),h=t.createTHead().insertRow();
 for(const c of columns){const th=document.createElement('th');th.textContent=c.label;
  if(c.button)th.className='action';
  else{th.classList.add('sortable');th.tabIndex=0;th.setAttribute('aria-sort',s&&s.key===c.label?(s.dir==='asc'?'ascending':'descending'):'none');
   th.addEventListener('click',()=>cycleSort(target,c.label));th.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();cycleSort(target,c.label);}});}
  h.append(th);}
 const b=t.createTBody();
 if(!list.length){const td=b.insertRow().insertCell();td.colSpan=columns.length;td.className='empty';td.textContent='Nothing to show.';}
 for(const r of list){const tr=b.insertRow(),rc=rowClass&&rowClass(r);if(rc)tr.className=rc;
  for(const c of columns){const td=tr.insertCell();td.dataset.label=c.label;if(c.mono)td.classList.add('mono');
   if(c.button){td.classList.add('action');const btn=document.createElement('button');btn.type='button';btn.className='btn small';btn.textContent=c.button(r);btn.addEventListener('click',()=>c.onClick(r));td.append(btn);}
   else if(c.badge){const v=String(c.value(r)??''),sp=document.createElement('span');sp.className='badge badge-'+v.toLowerCase().replace(/[^a-z]+/g,'-');sp.textContent=v;td.append(sp);}
   else td.textContent=c.value(r)??'';}}
 $(target).replaceChildren(t);
}
const cols=(keys,badge,extra={})=>keys.map(k=>({label:k,value:r=>r[k],mono:/NDC|Lot|Serial|GTIN/.test(k),badge:k===badge,...(extra[k]||{})}));
const withSrc=(row,src)=>{Object.defineProperty(row,'_src',{value:src,enumerable:false});return row;};
const INV=['ABC #','Product Description','Supplier NDC11','Scanned Package NDC11','Scanned NDC10','GTIN','Tracking Mode','Lot Number','Serial Number','Expiration Date','Received Quantity','In Stock Quantity','Out Quantity','Net Adjustment In Stock','Net Adjustment Out','Record Corrected','Status','First Received At (UTC)','Last Pulled At (UTC)','Last Returned At (UTC)','Last Action','Last Action At (UTC)','Pull Count','Return Count'];
const ACT=['ABC #','Product Description','Supplier NDC11','Scanned Package NDC11','Scanned NDC10','GTIN','Tracking Mode','Lot Number','Serial Number','Expiration Date','Action','Quantity','Scanned At (UTC)','Request ID','Parse Mode','Raw Scan'];
const LIB=['ABC #','Product Description','NDC','Status','Library Created At (UTC)','Library Record ID'];
function supplierAbc(key,map){const p=map.get(key);if(p)return p.supplier_abc??'';return String(key||'').startsWith('MANUAL-')?'':String(key||'');}
const productMap=()=>new Map(data.products.map(p=>[p.abc,p]));
function inventoryRows(){const m=productMap();return data.inventory.map(r=>withSrc({
 'ABC #':supplierAbc(r.product_abc,m),'Product Description':r.description,'Supplier NDC11':r.supplier_ndc11||r.ndc11,'Scanned Package NDC11':r.scanned_ndc11||'',
 'Scanned NDC10':r.ndc10||'','GTIN':String(r.gtin),'Tracking Mode':r.tracking_mode,'Lot Number':String(r.lot),'Serial Number':r.serial===null?'':String(r.serial),
 'Expiration Date':r.expiration,'Received Quantity':Number(r.received_quantity),'In Stock Quantity':Number(r.in_stock),'Out Quantity':Number(r.out_quantity),
 'Net Adjustment In Stock':Number(r.adjusted_in||0),'Net Adjustment Out':Number(r.adjusted_out||0),'Record Corrected':Number(r.corrected)?'Yes':'',
 'Status':r.status,'First Received At (UTC)':r.scanned_in_at||'','Last Pulled At (UTC)':r.last_scanned_out_at||'','Last Returned At (UTC)':r.last_returned_at||'',
 'Last Action':r.last_action,'Last Action At (UTC)':r.last_action_at,'Pull Count':Number(r.pull_count),'Return Count':Number(r.return_count)},r));}
function activityRows(){const m=productMap();return data.activity.map(r=>({
 'ABC #':supplierAbc(r.product_abc,m),'Product Description':r.description,'Supplier NDC11':r.supplier_ndc11||r.ndc11,'Scanned Package NDC11':r.scanned_ndc11||'',
 'Scanned NDC10':r.ndc10||'','GTIN':String(r.gtin),'Tracking Mode':r.tracking_mode,'Lot Number':String(r.lot),'Serial Number':r.serial===null?'':String(r.serial),
 'Expiration Date':r.expiration,'Action':r.action,'Quantity':Number(r.quantity??1),'Scanned At (UTC)':r.created_at,'Request ID':r.request_id,'Parse Mode':r.parse_mode||'legacy record','Raw Scan':r.raw_scan}));}
function libraryRows(){return data.products.map(r=>withSrc({'ABC #':r.supplier_abc??(String(r.abc).startsWith('MANUAL-')?'':r.abc),'Product Description':r.description,'NDC':String(r.ndc11),'Status':r.archived_at?'Archived':'Active','Library Created At (UTC)':r.created_at,'Library Record ID':r.abc},r));}
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
 $('adminEditHint').hidden=!adminCred;
}
const editCol=(label,onClick)=>adminCred?[{label:'Action',button:()=>label,onClick}]:[];
function renderInventory(){
 const q=$('search').value.toLowerCase(),f=$('filter').value;
 const rows=inventoryRows().filter(r=>(!f||(f==='in'?r['In Stock Quantity']>0:r['Out Quantity']>0))&&JSON.stringify(r).toLowerCase().includes(q));
 table('inventory',rows,[...editCol('Edit',r=>editInventoryRow(r._src)),...cols(['Product Description','Scanned Package NDC11','Tracking Mode','Lot Number','Serial Number','Expiration Date','In Stock Quantity','Out Quantity','Status'],'Status')]);
 $('count').textContent=data.inventory.reduce((n,r)=>n+Number(r.in_stock),0)+' total vials In stock; '+data.inventory.reduce((n,r)=>n+Number(r.out_quantity),0)+' Out; '+rows.length+' inventory rows shown.';
}
function activityLabel(r){return r.action==='ADJUST'?'ADJUST '+(r.adjust_bucket==='OUT'?'Out':'In stock')+' '+(Number(r.quantity)>0?'+':'')+r.quantity:r.action;}
function renderActivity(){
 const q=$('actSearch').value.toLowerCase(),f=$('actFilter').value;
 const rows=data.activity.filter(r=>!f||r.action===f).slice(0,100).map(r=>{const row={'Scanned At (Eastern)':fmtET(r.created_at),'Action':activityLabel(r),'Product Description':r.description,'Tracking Mode':r.tracking_mode,'Lot Number':String(r.lot),'Serial Number':r.serial===null?'':String(r.serial),
  'Detail':r.action==='ADJUST'?String(r.raw_scan).replace(/^Admin adjustment \([^)]*\): /,''):''};Object.defineProperty(row,'_t',{value:r.created_at,enumerable:false});return row;}).filter(r=>!q||JSON.stringify(r).toLowerCase().includes(q));
 table('activity',rows,cols(['Scanned At (Eastern)','Action','Product Description','Tracking Mode','Lot Number','Serial Number','Detail'],null,{'Scanned At (Eastern)':{sort:r=>r._t}}));
}
// Drug library accordion (More tab). The long list is only built while expanded; height animates open and closed.
const libOpen=()=>$('libAcc').classList.contains('open');
function renderLibrary(){
 if(!libOpen())return;
 const q=$('libSearch').value.toLowerCase(),all=$('libArchived').checked;
 const rows=libraryRows().filter(r=>(all||r.Status==='Active')&&JSON.stringify(r).toLowerCase().includes(q));
 table('library',rows,[...editCol('Edit',r=>editLibrary(r._src)),{label:'Supplier ABC',value:r=>r['ABC #']},{label:'Description',value:r=>r['Product Description']},{label:'NDC11',value:r=>r.NDC,mono:true},{label:'Status',value:r=>r.Status}],r=>r.Status==='Archived'?'archived':'');
 $('libCount').textContent=rows.length+' entries shown.';
}
function setLibrary(open){
 $('libAcc').classList.toggle('open',open);for(const id of ['libToggle','libChev'])$(id).setAttribute('aria-expanded',String(open));
 clearTimeout(libTimer);if(open)renderLibrary();else libTimer=setTimeout(()=>{if(!libOpen())$('library').replaceChildren();},450);
}
for(const id of ['libToggle','libChev'])$(id).addEventListener('click',()=>setLibrary(!libOpen()));
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
// Segmented controls (Receive/Pull/Return, theme, admin sections): the highlight slides to the active choice.
function initSeg(seg){
 if(seg._ind)return;const ind=document.createElement('span');ind.className='seg-ind';seg.prepend(ind);seg._ind=ind;
 const place=()=>{
  const checked=seg.querySelector('input:checked'),on=checked?checked.closest('label'):seg.querySelector('button.on');
  if(!on||!seg.offsetWidth){ind.classList.remove('on');return;}
  ind.style.width=on.offsetWidth+'px';ind.style.height=on.offsetHeight+'px';ind.style.transform='translate('+on.offsetLeft+'px,'+on.offsetTop+'px)';ind.classList.add('on');
  if(!ind.classList.contains('anim'))requestAnimationFrame(()=>requestAnimationFrame(()=>ind.classList.add('anim')));};
 seg._place=place;new ResizeObserver(place).observe(seg);
 seg.addEventListener('change',place);seg.addEventListener('click',()=>requestAnimationFrame(place));place();
}
for(const seg of document.querySelectorAll('.seg'))initSeg(seg);
function show(name){
 const openLibrary=name==='library';if(openLibrary)name='more';
 if(!VIEWS.includes(name))name='home';view=name;
 for(const v of VIEWS)$('view-'+v).hidden=v!==name;
 for(const a of document.querySelectorAll('.dock a'))a.setAttribute('aria-current',a.dataset.tab===name?'page':'false');
 placeIndicator();
 window.scrollTo(0,0);
 if(openLibrary){setLibrary(true);setTimeout(()=>$('libAcc').scrollIntoView({block:'start',behavior:'smooth'}),60);}
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
// Inventory, activity, library, export
$('search').oninput=renderInventory;$('filter').onchange=renderInventory;$('libSearch').oninput=renderLibrary;$('libArchived').onchange=renderLibrary;$('actSearch').oninput=renderActivity;$('actFilter').onchange=renderActivity;
$('refresh').onclick=()=>refresh().then(()=>toast('Refreshed.')).catch(e=>toast(e.message,true));
function writeSheets(file,sheets){const wb=XLSX.utils.book_new();for(const[name,rows,headers]of sheets){const sheet=XLSX.utils.json_to_sheet(rows,{header:headers});sheet['!cols']=headers.map(h=>({wch:Math.max(16,Math.min(40,h.length+4))}));XLSX.utils.book_append_sheet(wb,sheet,name);}XLSX.writeFile(wb,file+'-'+new Date().toISOString().slice(0,10)+'.xlsx');}
$('export').onclick=async()=>{try{if(!window.XLSX)throw Error('Excel library did not load');await refresh();writeSheets('Oncology-Inventory',[['Inventory',inventoryRows(),INV],['Activity',activityRows(),ACT],['Drug Library',libraryRows(),LIB]]);}catch(e){toast(e.message,true);}};
$('exportLib').onclick=async()=>{try{if(!window.XLSX)throw Error('Excel library did not load');await refresh();writeSheets('Drug-Library',[['Drug Library',libraryRows(),LIB]]);}catch(e){toast(e.message,true);}};
// ---- Edit dialog (administrators). One reusable form; every save needs a reason and is audited on the server.
function openEditor(cfg){
 const dlg=$('editor'),box=$('editorFields'),inputs={};box.replaceChildren();$('editorTitle').textContent=cfg.title;$('editorInfo').textContent=cfg.info||'';$('editorError').textContent='';$('editorReason').value='';$('editorSave').textContent=cfg.submitLabel||'Save changes';
 for(const f of cfg.fields){
  const label=document.createElement('label');label.className='field';label.append(f.label);let el;
  if(f.type==='select'){el=document.createElement('select');for(const o of f.options)el.add(new Option(o.label,o.value));el.value=f.value;}
  else{el=document.createElement('input');el.type=f.type||'text';if(f.min!==undefined)el.min=f.min;if(f.max!==undefined)el.max=f.max;if(f.step)el.step=f.step;el.value=f.value??'';el.autocomplete='off';}
  if(f.readonly){el.readOnly=true;if(el.tagName==='SELECT')el.disabled=true;el.tabIndex=-1;}
  el.id='ed_'+(f.key||('ro'+Math.random().toString(36).slice(2)));label.append(el);
  if(f.note){const n=document.createElement('span');n.className='fnote';n.textContent=f.note;label.append(n);}
  box.append(label);if(f.key&&!f.readonly)inputs[f.key]=el;
 }
 const submit=async event=>{event.preventDefault();const values={};for(const[k,el]of Object.entries(inputs))values[k]=el.value;
  const reason=$('editorReason').value.trim();if(reason.length<8||reason.length>500){$('editorError').textContent='Enter a reason (8-500 characters).';return;}
  $('editorSave').disabled=true;$('editorError').textContent='';
  try{await cfg.onSubmit(values,reason);$('editorForm').removeEventListener('submit',submit);dlg.close();}
  catch(e){$('editorError').textContent=e.message;if(e.code==='ADMIN_REQUIRED'){dlg.close();lockAdmin();}else if(e.code==='STALE_VERSION'){try{await adminLoad();await refresh();}catch{}}}
  finally{$('editorSave').disabled=false;}};
 $('editorForm').onsubmit=submit;
 $('editorCancel').onclick=()=>dlg.close();
 dlg.showModal();const first=box.querySelector('input:not([readonly]),select:not([disabled])');if(first)first.focus();
}
async function afterAdminSave(message){try{await adminLoad();await refresh();}catch(e){toast(e.message,true);}toast(message);}
function editLibrary(p){
 const id=p.id??p.abc,cur={description:p.description,abc:p.supplier_abc??'',ndc:p.ndc11,archived:!!p.archived_at,version:p.version};
 openEditor({title:'Edit library entry',info:'Every column can be edited. The internal key and version are system values.',
  fields:[
   {key:'abc',label:'Supplier ABC # (digits, or blank)',value:cur.abc},
   {key:'description',label:'Product description',value:cur.description},
   {key:'ndc',label:'NDC11',value:cur.ndc,note:'Editable only while no inventory, alias or mapping uses this entry. Otherwise archive it and add a corrected entry.'},
   {key:'status',label:'Status',type:'select',value:cur.archived?'archived':'active',options:[{value:'active',label:'Active'},{value:'archived',label:'Archived (blocks new Receives)'}]},
   {label:'Internal key (permanent)',value:id,readonly:true},{label:'Created',value:fmtET(p.created_at),readonly:true},{label:'Version',value:String(cur.version),readonly:true}],
  onSubmit:async(v,reason)=>{
   let version=cur.version,did=false;
   if(v.description.trim()!==cur.description||v.abc.trim()!==cur.abc||v.ndc.trim()!==cur.ndc){const r=await api('/api/admin/product/update',{id,version,description:v.description,supplierAbc:v.abc,ndc11:v.ndc,reason},adminHeaders());version=r.version;did=true;}
   const wantArchived=v.status==='archived';
   if(wantArchived!==cur.archived){await api('/api/admin/product/archive',{id,version,archived:wantArchived,reason},adminHeaders());did=true;}
   if(!did)throw Error('No changes to save.');
   await afterAdminSave('Library entry saved.');}});
}
function editInventoryRow(r){
 const serialized=r.tracking_mode==='serialized',prod=data.products.find(p=>p.abc===r.product_abc);
 openEditor({title:serialized?'Edit vial record':'Edit lot record',info:r.description+' | GTIN '+r.gtin,
  fields:[
   {key:'description',label:'Product description',value:r.description,note:'This is the library entry: changing it renames the medication for ALL inventory that uses it.'},
   {key:'scanned',label:'Scanned package NDC11',value:r.scanned_ndc11||''},
   {key:'lot',label:'Lot number',value:r.lot},
   ...(serialized?[{key:'serial',label:'Serial number',value:r.serial??''}]:[]),
   {key:'expiration',label:'Expiration date (YYYY-MM-DD)',value:r.expiration},
   ...(serialized?[{label:'In stock / Out',value:r.in_stock+' / '+r.out_quantity,readonly:true,note:'A serialized vial changes state only through Pull and Return scans.'}]
    :[{key:'in_stock',label:'In stock quantity',type:'number',min:0,step:1,value:r.in_stock},{key:'out_quantity',label:'Out quantity',type:'number',min:0,step:1,value:r.out_quantity,note:'Quantity changes are saved as audited adjustments; scan history is never edited.'}]),
   {label:'Tracking mode',value:r.tracking_mode,readonly:true},{label:'Status',value:r.status,readonly:true,note:'Derived from the quantities.'}],
  onSubmit:async(v,reason)=>{
   const ch={},diff=(a,b)=>String(a??'')!==String(b??'');
   if(diff(v.lot.trim(),r.lot))ch.lot=v.lot.trim();
   if(diff(v.expiration.trim(),r.expiration))ch.expiration=v.expiration.trim();
   if(serialized&&diff(v.serial.trim(),r.serial))ch.serial=v.serial.trim();
   if(diff(v.scanned.trim(),r.scanned_ndc11||''))ch.scannedNdc11=v.scanned.trim();
   if(!serialized){const i=Number(v.in_stock),o=Number(v.out_quantity);if(v.in_stock===''||v.out_quantity===''||!Number.isInteger(i)||!Number.isInteger(o))throw Error('Quantities must be whole numbers.');if(i!==Number(r.in_stock))ch.inStock=i;if(o!==Number(r.out_quantity))ch.out=o;}
   const descChanged=v.description.trim()!==r.description;
   if(!Object.keys(ch).length&&!descChanged)throw Error('No changes to save.');
   if(Object.keys(ch).length)await api('/api/admin/inventory/edit',{gtin:r.gtin,rawLot:r.raw_lot,rawExpiration:r.raw_expiration,rawSerial:serialized?r.raw_serial:null,changes:ch,expected:{lot:r.lot,expiration:r.expiration,serial:r.serial??'',in_stock:r.in_stock,out_quantity:r.out_quantity},reason},adminHeaders());
   if(descChanged){if(!prod)throw Error('Library entry not found. Refresh and retry.');await api('/api/admin/product/update',{id:prod.abc,version:prod.version,description:v.description,supplierAbc:prod.supplier_abc??'',ndc11:prod.ndc11,reason},adminHeaders());}
   await afterAdminSave('Inventory record saved.');}});
}
// Administration (More tab)
function adminMsg(text,error=false){$('adminStatus').textContent=text;$('adminStatus').className=error?'status error':'status ok';}
function showAdmin(open){$('adminLocked').hidden=open;$('adminOpen').hidden=!open;renderAll();for(const seg of document.querySelectorAll('.seg'))seg._place&&requestAnimationFrame(seg._place);}
function lockAdmin(){adminCred=null;admin={products:[],aliases:[],audit:[],lots:[]};aliasEditing=null;adjusting=null;previewRows=[];$('import').disabled=true;$('previewText').textContent='No file selected.';$('file').value='';$('aliasEditForm').hidden=true;$('adjForm').hidden=true;$('adminPass').value='';showAdmin(false);}
async function adminLoad(){admin=await api('/api/admin/data',undefined,adminHeaders());renderAdmin();}
function renderAdmin(){
 const q=$('aLibSearch').value.toLowerCase().trim(),all=$('aShowArchived').checked;
 table('aLibTable',admin.products.filter(p=>(all||!p.archived_at)&&(!q||[p.description,p.ndc11,p.supplier_abc,p.id].join(' ').toLowerCase().includes(q))),[
  {label:'Action',button:()=>'Edit',onClick:editLibrary},{label:'Supplier ABC',value:p=>p.supplier_abc??''},{label:'Description',value:p=>p.description},{label:'NDC11',value:p=>p.ndc11,mono:true},
  {label:'Status',value:p=>p.archived_at?'Archived '+fmtET(p.archived_at):'Active',sort:p=>p.archived_at?1:0},{label:'Activity records',value:p=>p.activity_count},{label:'Version',value:p=>p.version}],p=>p.archived_at?'archived':'');
 table('aliasTable',admin.aliases,[
  {label:'Action',button:a=>Number(a.enabled)===1?'Disable':'Enable',onClick:startAlias},{label:'GTIN',value:a=>a.gtin,mono:true},{label:'Library entry',value:a=>a.description},{label:'Scanned vial NDC11',value:a=>a.scanned_ndc11,mono:true},{label:'Supplier NDC11',value:a=>a.supplier_ndc11,mono:true},
  {label:'Unit',value:a=>a.units_per_scan+' '+a.unit_label+' per scan'},{label:'Verification source',value:a=>a.source},{label:'Created',value:a=>fmtET(a.created_at),sort:a=>a.created_at},
  {label:'Status',value:a=>Number(a.enabled)===1?'Enabled':'Disabled '+fmtET(a.disabled_at),sort:a=>Number(a.enabled)},{label:'Version',value:a=>a.version}],a=>Number(a.enabled)===1?'':'disabled');
 const sq=$('aStockSearch').value.toLowerCase().trim();
 table('stockTable',admin.lots.filter(g=>!sq||[g.description,g.lot,g.expiration].join(' ').toLowerCase().includes(sq)),[
  {label:'Action',button:()=>'Adjust',onClick:startAdjust},{label:'Product',value:g=>g.description},{label:'Lot',value:g=>g.lot,mono:true},{label:'Expiration',value:g=>g.expiration},
  {label:'In stock',value:g=>g.in_stock},{label:'Out',value:g=>g.out_quantity},{label:'Net adjustments',value:g=>'In stock '+(g.adjusted_in>0?'+':'')+g.adjusted_in+' | Out '+(g.adjusted_out>0?'+':'')+g.adjusted_out,sort:g=>Math.abs(g.adjusted_in)+Math.abs(g.adjusted_out),numeric:true}]);
 table('auditTable',admin.audit,[
  {label:'Time (Eastern)',value:a=>fmtET(a.at),sort:a=>a.at},{label:'Actor',value:a=>a.actor},{label:'Action',value:a=>a.action},{label:'Record',value:a=>a.entity_type+' '+a.entity_id,mono:true},
  {label:'Reason',value:a=>a.reason},{label:'Before',value:a=>a.before_json,mono:true},{label:'After',value:a=>a.after_json,mono:true}]);
}
function startAlias(a){aliasEditing=a;const enabling=Number(a.enabled)!==1;$('aliasEditForm').hidden=false;$('aliasTitle').textContent=(enabling?'Enable':'Disable')+' package alias';
 $('aliasInfo').textContent='GTIN '+a.gtin+' | '+a.description+' | scanned NDC '+a.scanned_ndc11+' | version '+a.version;$('aliasEditReason').value='';$('saveAlias').textContent=enabling?'Enable alias':'Disable alias';$('aliasEditForm').scrollIntoView({block:'center',behavior:'smooth'});$('aliasEditReason').focus();}
function startAdjust(g){adjusting=g;$('adjForm').hidden=false;$('adjInfo').textContent=g.description+' | lot '+g.lot+' | exp '+g.expiration+' | currently '+g.in_stock+' In stock, '+g.out_quantity+' Out';
 $('adjMode').value='add';$('adjBucket').value='IN_STOCK';$('adjQty').value='1';$('adjReason').value='';$('adjForm').scrollIntoView({block:'center',behavior:'smooth'});$('adjReason').focus();}
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
$('cancelAlias').addEventListener('click',()=>{aliasEditing=null;$('aliasEditForm').hidden=true;});$('cancelAdj').addEventListener('click',()=>{adjusting=null;$('adjForm').hidden=true;});
$('aliasEditForm').addEventListener('submit',event=>{event.preventDefault();if(!aliasEditing)return;adminAct(async()=>{
 const r=await api('/api/admin/alias/enabled',{gtin:aliasEditing.gtin,version:aliasEditing.version,enabled:Number(aliasEditing.enabled)!==1,reason:$('aliasEditReason').value},adminHeaders());
 aliasEditing=null;$('aliasEditForm').hidden=true;await adminLoad();adminMsg('Saved. Alias is now version '+r.version+'.');});});
$('adjForm').addEventListener('submit',event=>{event.preventDefault();if(!adjusting)return;adminAct(async()=>{
 const qty=Number($('adjQty').value);if(!Number.isInteger(qty)||qty<1||qty>1000)throw Error('Enter a whole quantity from 1 to 1000.');
 const body={gtin:adjusting.gtin,lot:adjusting.raw_lot,expiration:adjusting.raw_expiration,bucket:$('adjBucket').value,delta:($('adjMode').value==='remove'?-1:1)*qty,reason:$('adjReason').value,expectedIn:Number(adjusting.in_stock),expectedOut:Number(adjusting.out_quantity)};
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
