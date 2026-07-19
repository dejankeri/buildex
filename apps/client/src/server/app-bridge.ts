// The script injected at the top of every LOCAL app's HTML before its own scripts run. It gives the
// opaque-origin sandbox exactly two powers, both over postMessage to `parent` only (Conductor
// bright-lines: no credential store, no token - the daemon attaches nothing sensitive to a read):
//   1. window.buildex - a read-only data client (read/list); write is defined but rejected in v1.
//   2. agent DOM-driving - executes {click,fill,read} from the trusted parent against its own DOM.
export const APP_BRIDGE = `<script>
(function(){
  var seq=0, waiting={};
  window.addEventListener("message", function(e){
    if(e.source!==window.parent) return;              // only the trusted host frame
    var d=e.data||{};
    if(d.__buildexres && waiting[d.id]){ var w=waiting[d.id]; delete waiting[d.id]; d.ok?w.resolve(d.result):w.reject(d.error||"error"); return; }
    if(d.__appcmd){                                   // agent DOM-driving from the host
      var r={__appbridge:true, cmdId:d.cmdId, ok:true};
      try{
        var el=d.selector?document.querySelector(d.selector):null;
        if(d.op==="click"){ if(!el) throw "selector not found"; el.click(); }
        else if(d.op==="fill"){ if(!el) throw "selector not found"; el.value=d.value; el.dispatchEvent(new Event("input",{bubbles:true})); }
        else if(d.op==="read"){ r.result = el?(el.value!=null&&el.value!==""?el.value:el.textContent):document.body.innerText.slice(0,4000); }
        else throw "unknown op: "+d.op;
      }catch(err){ r.ok=false; r.error=String(err); }
      window.parent.postMessage(r,"*");
    }
  });
  function req(op, payload){ var id="x"+(++seq); return new Promise(function(res,rej){ waiting[id]={resolve:res,reject:rej}; window.parent.postMessage(Object.assign({__buildexreq:true,id:id,op:op},payload),"*"); }); }
  window.buildex={
    read:function(path){ return req("read",{path:path}); },
    list:function(glob){ return req("list",{glob:glob}); },
    write:function(){ return Promise.reject("buildex.write is not yet enabled"); }
  };
})();
</script>`;

/** Insert the bridge immediately after <head> (or <body>, or at the very top) so it runs first. */
export function injectBridge(html: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + APP_BRIDGE);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (m) => m + APP_BRIDGE);
  return APP_BRIDGE + html;
}
