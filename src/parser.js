// Shared GS1 parser. Optional serial; supported separatorless profile 01/21/17/10.
export class AppError extends Error {
 constructor(message,code='VALIDATION',status=400,details={}){super(message);Object.assign(this,{code,status,details});}
}
export function need(ok,message,code,status,details){if(!ok)throw new AppError(message,code,status,details);}
export function parseScan(raw,substitute=''){
 const fail=(message,code='PARSE_ERROR')=>{throw new AppError(message,code);};
 function validate(f){
  const gtin=f['01'];if(!/^\d{14}$/.test(gtin||''))fail('GTIN must contain 14 digits.');
  let sum=0;for(let i=0;i<13;i++)sum+=Number(gtin[i])*(i%2===0?3:1);
  if((10-sum%10)%10!==Number(gtin[13]))fail('GTIN check digit failed.');
  const serial=f['21']===undefined?null:f['21'];
  if(serial!==null&&!/^[\x21-\x7e]{1,20}$/.test(serial))fail('Serial must contain 1-20 printable characters when present.');
  if(!/^[\x21-\x7e]{1,20}$/.test(f['10']||''))fail('Lot must contain 1-20 printable characters.');
  const date=f['17']||'';if(!/^\d{6}$/.test(date))fail('Expiration must contain 6 digits.');
  const year=2000+Number(date.slice(0,2)),month=Number(date.slice(2,4));if(month<1||month>12)fail('Invalid expiration month.');
  const last=new Date(Date.UTC(year,month,0)).getUTCDate();let day=Number(date.slice(4,6));if(day===0)day=last;
  if(day<1||day>last)fail('Invalid expiration day.');
  return{gtin,serial,lot:f['10'],expiration:[year,String(month).padStart(2,'0'),String(day).padStart(2,'0')].join('-'),tracking_mode:serial===null?'nonserialized':'serialized'};
 }
 need(typeof raw==='string'&&raw.length>0&&raw.length<=512,'Scan must contain 1-512 characters.');
 let s=raw.replace(/[\r\n]+$/g,'');if(s.startsWith(']d2'))s=s.slice(3);s=s.replace(/<GS>/g,'\x1d');
 if(substitute){need(substitute.length===1&&/^[\x21-\x7e]$/.test(substitute),'Invalid SCAN_SEPARATOR.');s=s.split(substitute).join('\x1d');}
 if(!s.includes('\x1d')&&/^01\d{14}21/.test(s)){
  const gtin=s.slice(2,16),tail=s.slice(18),candidates=[];
  for(let n=1;n<=20;n++){
   if(tail.slice(n,n+2)!=='17'||tail.slice(n+8,n+10)!=='10')continue;
   try{candidates.push(validate({'01':gtin,'21':tail.slice(0,n),'17':tail.slice(n+2,n+8),'10':tail.slice(n+10)}));}
   catch(e){if(!(e instanceof AppError))throw e;}
  }
  need(candidates.length>0,'Invalid or unsupported separatorless scan layout.','UNSUPPORTED_RAW_LAYOUT');
  need(candidates.length===1,'Multiple serial/date/lot interpretations fit this scan. No inventory saved.','AMBIGUOUS_RAW_SCAN');
  return{...candidates[0],parseMode:'separatorless-01-21-17-10',parseWarning:'Field boundaries reconstructed within the supported layout.'};
 }
 const f={};
 while(s.length){
  if(s[0]==='\x1d'){s=s.slice(1);continue;}
  const ai=s.slice(0,2);s=s.slice(2);need(['01','17','10','21'].includes(ai),'Unsupported AI or missing separator near '+ai,'UNSUPPORTED_RAW_LAYOUT');
  need(f[ai]===undefined,'Duplicate AI '+ai);
  if(ai==='01'||ai==='17'){const n=ai==='01'?14:6;need(new RegExp('^\\d{'+n+'}').test(s),'Invalid AI '+ai);f[ai]=s.slice(0,n);s=s.slice(n);}
  else{const end=s.indexOf('\x1d');f[ai]=end<0?s:s.slice(0,end);s=end<0?'':s.slice(end+1);need(/^[\x21-\x7e]{1,20}$/.test(f[ai]),'Invalid field or unsupported separatorless order.','UNSUPPORTED_RAW_LAYOUT');}
 }
 need(['01','17','10'].every(k=>f[k]),'GTIN, expiration and lot are required.');
 return{...validate(f),parseMode:'gs1-fields'};
}
export function ndcCandidates(gtin){
 if(!/^003\d{11}$/.test(gtin))return{ndc10:null,candidates:[]};const n=gtin.slice(3,13);
 return{ndc10:n,candidates:[...new Set(['0'+n,n.slice(0,5)+'0'+n.slice(5),n.slice(0,9)+'0'+n.slice(9)])]};
}
export function supplierNDC(v){
 let s=String(v??'').trim();if(/^\d{5}-\d{4}-\d{2}$/.test(s))return s.replace(/-/g,'');
 if(/^\d+(?:\.\d+)?[eE][+]?\d+$/.test(s)){const n=Number(s);need(Number.isSafeInteger(n),'Invalid scientific NDC.');s=String(n);}
 need(/^\d{1,11}$/.test(s),'Supplier NDC must represent an 11-digit value.');return s.padStart(11,'0');
}
export function manualNDC(v){const s=String(v??'').trim();need(/^\d{11}$/.test(s)||/^\d{5}-\d{4}-\d{2}$/.test(s),'Enter 11 digits or a 5-4-2 NDC.');return s.replace(/-/g,'');}
export function productRow(r){const abc=String(r.abc??'').trim(),description=String(r.description??'').trim(),original=String(r.ndc??'').trim();need(/^\d{1,30}$/.test(abc),'Invalid ABC number.');need(description.length>0&&description.length<=300,'Description required (maximum 300 characters).');return{abc,description,ndc_original:original,ndc11:supplierNDC(original)};}
export function publicProduct(p){return{abc:p.abc.startsWith('MANUAL-')?'':p.abc,libraryId:p.abc,description:p.description,ndc11:p.ndc11};}
