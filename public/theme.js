(function(){
var KEY='onco-theme';
function get(){try{return localStorage.getItem(KEY)||'light';}catch(e){return 'light';}}
function apply(t){
 var dark=t==='dark'||(t==='auto'&&window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches);
 document.documentElement.setAttribute('data-theme',dark?'dark':'light');
 var m=document.querySelector('meta[name=theme-color]');if(m)m.setAttribute('content',dark?'#0b1a2e':'#0f8f86');
}
window.OncoTheme={get:get,set:function(t){try{localStorage.setItem(KEY,t);}catch(e){}apply(t);},apply:apply};
apply(get());
if(window.matchMedia)matchMedia('(prefers-color-scheme: dark)').addEventListener('change',function(){if(get()==='auto')apply('auto');});
})();
