/* GitHub sync engine v2 — revision-counter model (no device clocks).
   Every push = remote rev + 1. A device only pushes when it has real local
   edits (dirty flag); otherwise the higher rev always wins. */
function initGitSync(cfg){
  "use strict";
  var META = cfg.appName + "_sync_cfg";
  var API  = "https://api.github.com";
  var BRANCH = "main";

  var DICT = {
    en:{ off:"Sync: not connected", syncing:"Syncing…", synced:"Synced", pending:"Unsaved changes…",
         err:"Sync error", badToken:"Invalid token (401)", notFound:"Repo not found (check owner/repo)",
         settings:"GitHub sync", repo:"Repository (owner/repo)", token:"Token (fine-grained PAT)",
         connect:"Connect", disconnect:"Disconnect", syncNow:"⟳ Sync now",
         confirmRemote:"The repo already has data AND this device has data.\nOK = use the REPO data (overwrite this device).\nCancel = use THIS DEVICE's data (overwrite the repo).",
         hint:"Create a PRIVATE repo for data. Token: GitHub → Settings → Developer settings → Fine-grained tokens → only that repo, Contents: Read & Write. Never commit the token to any repo." },
    es:{ off:"Sync: sin conectar", syncing:"Sincronizando…", synced:"Sincronizado", pending:"Cambios sin guardar…",
         err:"Error de sync", badToken:"Token no válido (401)", notFound:"Repo no encontrado (revisa owner/repo)",
         settings:"Sincronización GitHub", repo:"Repositorio (owner/repo)", token:"Token (PAT fine-grained)",
         connect:"Conectar", disconnect:"Desconectar", syncNow:"⟳ Sincronizar",
         confirmRemote:"El repo ya tiene datos Y este dispositivo también.\nAceptar = usar los datos del REPO (sobrescribe este dispositivo).\nCancelar = usar los de ESTE DISPOSITIVO (sobrescribe el repo).",
         hint:"Crea un repo PRIVADO para los datos. Token: GitHub → Settings → Developer settings → Fine-grained tokens → solo ese repo, Contents: Read & Write. Nunca subas el token a ningún repo." },
    zh:{ off:"同步：未连接", syncing:"同步中…", synced:"已同步", pending:"有未上传的修改…",
         err:"同步出错", badToken:"Token 无效 (401)", notFound:"找不到仓库（检查 owner/repo）",
         settings:"GitHub 同步", repo:"仓库 (owner/repo)", token:"Token（fine-grained PAT）",
         connect:"连接", disconnect:"断开", syncNow:"⟳ 立即同步",
         confirmRemote:"仓库里已有数据，本设备也有数据。\n确定 = 使用仓库数据（覆盖本机）。\n取消 = 使用本机数据（覆盖仓库）。",
         hint:"请为数据建一个私有仓库。Token 获取：GitHub → Settings → Developer settings → Fine-grained tokens → 只授权该仓库，Contents 读写。永远不要把 Token 提交进任何仓库的代码里。" }
  };
  function t(k){ var l=cfg.getLang(); return (DICT[l]&&DICT[l][k])||DICT.en[k]||k; }

  /* ── debug log (visible in the ⚙ panel) ── */
  var LOG=[];
  function log(s){
    var ts=new Date().toTimeString().slice(0,8);
    LOG.push(ts+" "+s); if(LOG.length>30) LOG.shift();
    var box=document.getElementById("gsLog");
    if(box && box.offsetParent!==null) box.textContent=LOG.join("\n");
  }

  /* ── raw storage (bypasses our own patch) ── */
  var _set = Storage.prototype.setItem;
  function rawSet(k,v){ try{ _set.call(window.localStorage,k,v); }catch(e){} }
  function rawGet(k){ try{ return window.localStorage.getItem(k); }catch(e){ return null; } }
  function meta(){ try{ return JSON.parse(rawGet(META)||"{}"); }catch(e){ return {}; } }
  function saveMeta(m){ rawSet(META, JSON.stringify(m)); }

  /* ── intercept real changes to watched keys ── */
  var applying=false, pushTimer=null;
  Storage.prototype.setItem = function(k,v){
    var changed=true;
    if(this===window.localStorage && cfg.watchKeys.indexOf(k)>=0){
      try{ changed = window.localStorage.getItem(k)!==String(v); }catch(e){}
    }
    _set.apply(this,arguments);
    if(this===window.localStorage && !applying && changed && cfg.watchKeys.indexOf(k)>=0) markChanged(k);
  };
  function markChanged(k){
    var m=meta(); m.dirty=true; saveMeta(m);
    log("edit: "+k);
    if(m.token){ setStatus("pending"); clearTimeout(pushTimer);
      pushTimer=setTimeout(function(){ pushTimer=null; doPush(); },1000); }
  }

  function collect(){
    var data={};
    cfg.watchKeys.forEach(function(k){
      var v=rawGet(k);
      if(v!==null){ try{ data[k]=JSON.parse(v); }catch(e){ data[k]=v; } }
    });
    return data;
  }
  function applyRemote(r){
    applying=true;
    for(var k in r.data){
      if(cfg.watchKeys.indexOf(k)>=0) rawSet(k, typeof r.data[k]==="string"? r.data[k] : JSON.stringify(r.data[k]));
    }
    applying=false;
    var m=meta(); m.rev=r.rev; m.dirty=false; saveMeta(m);
    log("applied remote rev "+r.rev);
  }
  function sameData(a){ return JSON.stringify(a)===JSON.stringify(collect()); }

  /* ── GitHub Contents API ── */
  function tfetch(url, opts){
    var ctrl = ("AbortController" in window)? new AbortController() : null;
    if(ctrl){ opts=opts||{}; opts.signal=ctrl.signal; setTimeout(function(){ ctrl.abort(); },15000); }
    return fetch(url, opts);
  }
  function branch(){ return meta().branch || BRANCH; }
  function api(method, path, body){
    var m=meta();
    return tfetch(API+path,{
      method:method,
      headers:{ "Authorization":"Bearer "+m.token, "Accept":"application/vnd.github+json" },
      body: body? JSON.stringify(body) : undefined
    });
  }
  function b64enc(s){ return btoa(unescape(encodeURIComponent(s))); }
  function b64dec(s){ return decodeURIComponent(escape(atob(s.replace(/\n/g,"")))); }

  var etag=null;
  function getRemote(useEtag){
    var m=meta();
    var headers={ "Authorization":"Bearer "+m.token, "Accept":"application/vnd.github+json" };
    if(useEtag && etag) headers["If-None-Match"]=etag;
    return tfetch(API+"/repos/"+m.repo+"/contents/"+cfg.filePath+"?ref="+branch(),{headers:headers}).then(function(res){
      if(res.status===304) return {unchanged:true};
      if(res.status===404) return {missing:true};
      if(res.status===401) throw {code:401};
      if(!res.ok) throw {code:res.status};
      etag=res.headers.get("ETag");
      return res.json().then(function(j){
        var payload; try{ payload=JSON.parse(b64dec(j.content)); }catch(e){ payload={}; }
        return { sha:j.sha, rev:payload.rev||0, data:payload.data||{} };
      });
    });
  }
  function putRemote(sha, rev){
    var payload={ app:cfg.appName, version:2, rev:rev, updated:new Date().toISOString(), data:collect() };
    var body={ message:cfg.appName+" sync rev "+rev,
               content:b64enc(JSON.stringify(payload,null,2)), branch:branch() };
    if(sha) body.sha=sha;
    var m=meta();
    return api("PUT","/repos/"+m.repo+"/contents/"+cfg.filePath, body).then(function(res){
      if(res.status===401) throw {code:401};
      if(res.status===409 || res.status===422) throw {code:409};
      if(!res.ok) throw {code:res.status};
      var mm=meta(); mm.rev=rev; mm.dirty=false; saveMeta(mm);
      log("pushed rev "+rev);
      return res.json();
    });
  }

  /* ── sync core: one reconcile routine for load, poll and push ── */
  var busy=false;
  function reconcile(opts){
    // opts: {silent, useEtag, tries}
    opts=opts||{};
    if(!meta().token){ setStatus("off"); return; }
    if(busy){ return; }
    busy=true;
    if(!opts.silent) setStatus("syncing");
    getRemote(opts.useEtag).then(function(r){
      var m=meta();
      if(r.unchanged){
        // remote hasn't moved; if we owe changes, redo without the ETag to get a sha and push
        if(m.dirty){ throw {code:409}; }
        setStatus("synced"); return;
      }
      if(r.missing){
        log("remote file missing → creating rev 1");
        return putRemote(null, 1).then(function(){ setStatus("synced"); });
      }
      if(r.rev > (m.rev||0)){
        if(m.dirty){
          // true concurrent edit: our edits win, based on the newest remote rev
          log("conflict: remote rev "+r.rev+" vs local rev "+(m.rev||0)+" dirty → push on top");
          return putRemote(r.sha, r.rev+1).then(function(){ setStatus("synced"); });
        }
        if(!sameData(r.data)){ applyRemote(r); location.reload(); return; }
        var m2=meta(); m2.rev=r.rev; m2.dirty=false; saveMeta(m2); setStatus("synced"); return;
      }
      // remote rev <= ours
      if(m.dirty){
        return putRemote(r.sha, r.rev+1).then(function(){ setStatus("synced"); });
      }
      if(!sameData(r.data)){
        // same/older rev but different content (legacy file or manual edit) → remote is truth
        log("self-heal: content differs at rev "+r.rev+" → applying remote");
        applyRemote(r); location.reload(); return;
      }
      setStatus("synced");
    }).catch(function(e){
      if(e && e.code===409 && (opts.tries||0)<3){
        busy=false;
        log("sha race → retry "+((opts.tries||0)+1));
        setTimeout(function(){ reconcile({silent:opts.silent, tries:(opts.tries||0)+1}); },800);
        return;
      }
      log("error: "+(e&&e.code? e.code : (e&&e.name)||"network"));
      if(!opts.silent) setStatus(e&&e.code===401? "badToken" : "err");
    }).finally(function(){ busy=false; });
  }
  function doPush(silent){ reconcile({silent:silent}); }

  /* ── first-time connect ── */
  function connect(repo, token){
    var m=meta(); m.repo=repo.trim(); m.token=token.trim(); saveMeta(m);
    setStatus("syncing");
    api("GET","/repos/"+m.repo).then(function(res){
      if(res.status===401) throw {code:401};
      if(res.status===404) throw {code:404};
      if(!res.ok) throw {code:res.status};
      return res.json();
    }).then(function(j){
      var mb=meta(); mb.branch=j.default_branch||"main"; saveMeta(mb);
      log("connected, branch="+mb.branch);
      return getRemote();
    }).then(function(r){
      var localHasData = Object.keys(collect()).length>0;
      if(r.missing || Object.keys(r.data||{}).length===0){
        var sha = r.missing? null : r.sha;
        return putRemote(sha, (r.rev||0)+1).then(function(){ setStatus("synced"); ui.panel.style.display="none"; });
      }
      if(!localHasData){ applyRemote(r); location.reload(); return; }
      if(sameData(r.data)){
        var m2=meta(); m2.rev=r.rev; m2.dirty=false; saveMeta(m2);
        setStatus("synced"); ui.panel.style.display="none"; return;
      }
      if(confirm(t("confirmRemote"))){ applyRemote(r); location.reload(); }
      else{ return putRemote(r.sha, r.rev+1).then(function(){ setStatus("synced"); ui.panel.style.display="none"; }); }
    }).catch(function(e){
      log("connect error: "+(e&&e.code||"network"));
      setStatus(e&&e.code===401? "badToken" : e&&e.code===404? "notFound" : "err");
    });
  }
  function disconnect(){
    var m=meta(); delete m.token; delete m.repo; saveMeta(m);
    setStatus("off"); log("disconnected");
  }

  /* ── UI ── */
  var css = ".gs-bar{display:flex;align-items:center;gap:10px;padding:9px 14px;background:var(--panel,#161b23);"
    + "border:1px solid var(--line,#28303d);border-radius:12px;font-size:.82rem;color:var(--muted,#8b96a5)}"
    + ".gs-dot{width:9px;height:9px;border-radius:50%;background:#8b96a5;flex:none}"
    + ".gs-dot.ok{background:#4ac26b}.gs-dot.bad{background:#e05555}.gs-dot.work{background:#e0c23c}"
    + ".gs-bar button{margin-left:auto;border:1px solid var(--line,#28303d);background:var(--panel-2,#1c2330);"
    + "color:var(--text,#e8edf4);border-radius:8px;padding:5px 10px;cursor:pointer;font-family:inherit;font-size:.8rem}"
    + ".gs-bar button+button{margin-left:0}"
    + ".gs-panel{padding:14px;background:var(--panel,#161b23);border:1px solid var(--line,#28303d);border-radius:12px;display:none}"
    + ".gs-panel label{display:block;font-size:.8rem;color:var(--muted,#8b96a5);margin:8px 0 4px}"
    + ".gs-panel input{width:100%;padding:9px 12px;font-size:.92rem;font-family:inherit;background:var(--panel-2,#1c2330);"
    + "color:var(--text,#e8edf4);border:1px solid var(--line,#28303d);border-radius:9px;outline:none}"
    + ".gs-panel .gs-hint{font-size:.75rem;color:var(--muted,#8b96a5);margin-top:10px;line-height:1.5}"
    + ".gs-panel .gs-actions{display:flex;gap:8px;margin-top:12px}"
    + ".gs-panel .gs-actions button{padding:9px 14px;border:none;border-radius:9px;cursor:pointer;font-family:inherit;font-weight:700}"
    + ".gs-connect{background:var(--accent,#3fa9f5);color:#0b0e12}"
    + ".gs-disc{background:transparent;color:#e06060;border:1px solid #e06060!important}"
    + "#gsLog{margin-top:12px;padding:10px;background:#0b0e12;border:1px solid var(--line,#28303d);border-radius:8px;"
    + "font-family:monospace;font-size:.68rem;color:#8b96a5;white-space:pre-wrap;max-height:160px;overflow-y:auto}";
  var style=document.createElement("style"); style.textContent=css; document.head.appendChild(style);

  var ui={};
  function buildUI(){
    var bar=document.createElement("div"); bar.className="gs-bar";
    bar.innerHTML='<span class="gs-dot" id="gsDot"></span><span id="gsText"></span>'
      + '<button id="gsSync" type="button">⟳</button><button id="gsGear" type="button">⚙</button>';
    var panel=document.createElement("div"); panel.className="gs-panel";
    panel.innerHTML='<b id="gsTitle" style="font-size:.85rem"></b>'
      + '<label id="gsRepoL"></label><input id="gsRepo" placeholder="usuario/mis-datos" autocomplete="off">'
      + '<label id="gsTokL"></label><input id="gsTok" type="password" placeholder="github_pat_…" autocomplete="off">'
      + '<div class="gs-actions"><button class="gs-connect" id="gsConnect" type="button"></button>'
      + '<button class="gs-disc" id="gsDisc" type="button"></button></div>'
      + '<div class="gs-hint" id="gsHint"></div>'
      + '<pre id="gsLog"></pre>';
    var anchor=document.querySelector(".site-nav")||document.querySelector("header");
    if(anchor && anchor.parentNode){
      anchor.parentNode.insertBefore(panel, anchor.nextSibling);
      anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    }else{ document.body.prepend(panel); document.body.prepend(bar); }
    ui={ dot:document.getElementById("gsDot"), text:document.getElementById("gsText"),
         panel:panel, repo:document.getElementById("gsRepo"), tok:document.getElementById("gsTok") };
    document.getElementById("gsGear").onclick=function(){
      panel.style.display = panel.style.display==="none"||!panel.style.display ? "block":"none";
      ui.repo.value = meta().repo||"";
      applyPanelText();
      var box=document.getElementById("gsLog"); if(box) box.textContent=LOG.join("\n");
    };
    document.getElementById("gsSync").onclick=function(){ if(meta().token) reconcile({}); };
    document.getElementById("gsConnect").onclick=function(){
      if(ui.repo.value.trim() && ui.tok.value.trim()) connect(ui.repo.value, ui.tok.value);
    };
    document.getElementById("gsDisc").onclick=function(){ disconnect(); ui.panel.style.display="none"; };
    applyPanelText();
  }
  function applyPanelText(){
    document.getElementById("gsTitle").textContent=t("settings");
    document.getElementById("gsRepoL").textContent=t("repo");
    document.getElementById("gsTokL").textContent=t("token");
    document.getElementById("gsConnect").textContent=t("connect");
    document.getElementById("gsDisc").textContent=t("disconnect");
    document.getElementById("gsHint").textContent=t("hint");
    document.getElementById("gsSync").title=t("syncNow");
  }
  var lastStatus="off";
  function setStatus(s){
    lastStatus=s;
    if(!ui.dot) return;
    ui.dot.className="gs-dot "+(s==="synced"?"ok":s==="syncing"||s==="pending"?"work":s==="off"?"":"bad");
    var txt=t(s==="synced"?"synced":s==="syncing"?"syncing":s==="pending"?"pending":s==="off"?"off":s==="badToken"?"badToken":s==="notFound"?"notFound":"err");
    if(s==="synced") txt+=" · "+new Date().toTimeString().slice(0,5);
    ui.text.textContent=txt;
  }

  /* ── scheduling ── */
  var POLL_MS=45000;
  function checkRemote(){
    if(document.visibilityState==="hidden" || pushTimer) return;
    reconcile({silent: lastStatus==="synced", useEtag:true});
  }
  setInterval(checkRemote, POLL_MS);

  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded", function(){ buildUI(); reconcile({}); });
  }else{ buildUI(); reconcile({}); }

  document.addEventListener("visibilitychange", function(){
    if(document.visibilityState==="hidden"){
      if(pushTimer){ clearTimeout(pushTimer); pushTimer=null; reconcile({silent:true}); }
    }else{
      checkRemote();
    }
  });
}

/* ── fitness site config ── */
initGitSync({
  appName:"ft",
  filePath:"fitness-data.json",
  watchKeys:["ftdash_state_v2","ft_targets_v1","ft_foods_v1","ft_diary_v1","ftdash_history_v1"],
  getLang:function(){ try{ var s=JSON.parse(localStorage.getItem("ftdash_state_v2")||"{}"); return s.lang||"en"; }catch(e){ return "en"; } }
});
