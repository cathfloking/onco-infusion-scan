const $=id=>document.getElementById(id);
let cred=null,state={products:[],aliases:[],audit:[]},editing=null,aliasEditing=null,busy=false;
function status(text,error=false){$('status').textContent=text;$('status').className=error?'error':'ok';}
async function call(path,body){
 const headers={'X-Admin-Authorization':cred};
 const r=await fetch(path,body===undefined?{headers}:{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const text=await r.text();let j;try{j=JSON.parse(text);}catch{throw Error('Non-JSON server response. Check sign-in and deployment.');}
 if(!r.ok){const e=new Error(j.error||'Request failed');e.code=j.code;throw e;}return j;
}
function table(target,rows,columns,rowClass){
 const t=document.createElement('table'),h=t.createTHead().insertRow();
 for(const c of columns){const th=document.createElement('th');th.textContent=c.label;h.append(th);}
 const b=t.createTBody();
 for(const r of rows){const tr=b.insertRow();if(rowClass&&rowClass(r))tr.className=rowClass(r);
  for(const c of columns){const td=tr.insertCell();if(c.mono)td.className='mono';if(c.button){const btn=document.createElement('button');btn.type='button';btn.textContent=c.button(r);btn.addEventListener('click',()=>c.onClick(r));td.append(btn);}else td.textContent=c.value(r)??'';}}
 $(target).replaceChildren(t);
}
function renderLibrary(){
 const q=$('libSearch').value.toLowerCase().trim(),all=$('showArchived').checked;
 const rows=state.products.filter(p=>(all||!p.archived_at)&&(!q||[p.description,p.ndc11,p.supplier_abc,p.id].join(' ').toLowerCase().includes(q)));
 table('libraryTable',rows,[
  {label:'Supplier ABC',value:p=>p.supplier_abc??''},{label:'Description',value:p=>p.description},{label:'NDC11',value:p=>p.ndc11,mono:true},
  {label:'Status',value:p=>p.archived_at?'Archived '+p.archived_at+' UTC':'Active'},{label:'Activity records',value:p=>p.activity_count},{label:'Version',value:p=>p.version},
  {label:'',button:()=>'Edit',onClick:startEdit}],p=>p.archived_at?'archived':'');
}
function renderAliases(){
 table('aliasTable',state.aliases,[
  {label:'GTIN',value:a=>a.gtin,mono:true},{label:'Library entry',value:a=>a.description},{label:'Scanned vial NDC11',value:a=>a.scanned_ndc11,mono:true},{label:'Supplier NDC11',value:a=>a.supplier_ndc11,mono:true},
  {label:'Unit',value:a=>a.units_per_scan+' '+a.unit_label+' per scan'},{label:'Verification source',value:a=>a.source},{label:'Created (UTC)',value:a=>a.created_at},
  {label:'Status',value:a=>Number(a.enabled)===1?'Enabled':'Disabled '+(a.disabled_at||'')+' UTC'},{label:'Version',value:a=>a.version},
  {label:'',button:a=>Number(a.enabled)===1?'Disable':'Enable',onClick:startAlias}],a=>Number(a.enabled)===1?'':'disabled');
}
function renderAudit(){
 table('auditTable',state.audit,[
  {label:'Time (UTC)',value:a=>a.at},{label:'Actor',value:a=>a.actor},{label:'Action',value:a=>a.action},{label:'Record',value:a=>a.entity_type+' '+a.entity_id,mono:true},
  {label:'Reason',value:a=>a.reason},{label:'Before',value:a=>a.before_json,mono:true},{label:'After',value:a=>a.after_json,mono:true}]);
}
function renderAll(){renderLibrary();renderAliases();renderAudit();}
async function load(){state=await call('/api/admin/data');renderAll();}
function show(view){for(const v of ['library','alias','audit'])$(v+'View').hidden=v!==view;}
function startEdit(p){
 editing=p;$('editForm').hidden=false;$('editInfo').textContent='NDC '+p.ndc11+' | internal key '+p.id+' | version '+p.version+(p.archived_at?' | ARCHIVED':'');
 $('editDescription').value=p.description;$('editAbc').value=p.supplier_abc??'';$('editReason').value='';$('toggleArchive').textContent=p.archived_at?'Unarchive':'Archive';$('editDescription').focus();
}
function startAlias(a){
 aliasEditing=a;const enabling=Number(a.enabled)!==1;$('aliasForm').hidden=false;$('aliasTitle').textContent=(enabling?'Enable':'Disable')+' package alias';
 $('aliasInfo').textContent='GTIN '+a.gtin+' | '+a.description+' | scanned NDC '+a.scanned_ndc11+' | version '+a.version;$('aliasReason').value='';$('saveAlias').textContent=enabling?'Enable alias':'Disable alias';$('aliasReason').focus();
}
async function act(fn){
 if(busy)return;busy=true;
 try{await fn();}
 catch(e){status(e.message,true);if(e.code==='STALE_VERSION'){try{await load();}catch{}}else if(e.code==='ADMIN_REQUIRED'){lockPanel();}}
 finally{busy=false;}
}
function lockPanel(){cred=null;$('panel').hidden=true;$('login').hidden=false;$('adminPass').value='';editing=null;aliasEditing=null;}
$('loginForm').addEventListener('submit',event=>{event.preventDefault();act(async()=>{
 cred='Basic '+btoa($('adminUser').value+':'+$('adminPass').value);$('adminPass').value='';
 try{await load();}catch(e){cred=null;throw e;}
 $('login').hidden=true;$('panel').hidden=false;show('library');status('Administration unlocked.');});});
$('lock').addEventListener('click',()=>{lockPanel();status('Locked.');});
$('reload').addEventListener('click',()=>act(async()=>{await load();status('Refreshed.');}));
$('tabLibrary').addEventListener('click',()=>show('library'));$('tabAliases').addEventListener('click',()=>show('alias'));$('tabAudit').addEventListener('click',()=>show('audit'));
$('libSearch').addEventListener('input',renderLibrary);$('showArchived').addEventListener('change',renderLibrary);
$('cancelEdit').addEventListener('click',()=>{editing=null;$('editForm').hidden=true;});$('cancelAlias').addEventListener('click',()=>{aliasEditing=null;$('aliasForm').hidden=true;});
$('editForm').addEventListener('submit',event=>{event.preventDefault();if(!editing)return;act(async()=>{
 const r=await call('/api/admin/product/update',{id:editing.id,version:editing.version,description:$('editDescription').value,supplierAbc:$('editAbc').value,reason:$('editReason').value});
 editing=null;$('editForm').hidden=true;await load();status('Saved. Library entry '+r.id+' is now version '+r.version+'.');});});
$('toggleArchive').addEventListener('click',()=>{if(!editing)return;act(async()=>{
 const r=await call('/api/admin/product/archive',{id:editing.id,version:editing.version,archived:!editing.archived_at,reason:$('editReason').value});
 editing=null;$('editForm').hidden=true;await load();status('Saved. Library entry '+r.id+' is now version '+r.version+'.');});});
$('aliasForm').addEventListener('submit',event=>{event.preventDefault();if(!aliasEditing)return;act(async()=>{
 const r=await call('/api/admin/alias/enabled',{gtin:aliasEditing.gtin,version:aliasEditing.version,enabled:Number(aliasEditing.enabled)!==1,reason:$('aliasReason').value});
 aliasEditing=null;$('aliasForm').hidden=true;await load();status('Saved. Alias is now version '+r.version+'.');});});
