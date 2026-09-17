/* GitHub sync engine — stores app data as one JSON file in a (private) GitHub repo.
   Login = fine-grained Personal Access Token + "owner/repo". Token never leaves this device. */
function initGitSync(cfg){
  "use strict";
  // cfg: { appName, filePath, watchKeys:[], getLang:fn }
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

  /* raw storage (bypasses our own patch) */
  var _set = Storage.prototype.setItem;
  function rawSet(k,v){ try{ _set.call(window.localStorage,k,v); }catch(e){} }
  function rawGet(k){ try{ return window.localStorage.getItem(k); }catch(e){ return null; } }
  function meta(){ try{ return JSON.parse(rawGet(META)||"{}"); }catch(e){ return {}; } }
  function saveMeta(m){ rawSet(META, JSON.stringify(m)); }

  /* intercept writes to watched keys → mark dirty + debounce push */
  var applying=false, pushTimer=null;
  Storage.prototype.setItem = function(k,v){
    var changed=true;
    if(this===window.localStorage && cfg.watchKeys.indexOf(k)>=0){
      try{ changed = window.localStorage.getItem(k)!==String(v); }catch(e){}
    }
    _set.apply(this,arguments);
    if(this===window.localStorage && !applying && changed && cfg.watchKeys.indexOf(k)>=0) markChanged();
  };
  function markChanged(){
    var m=meta(); m.updated=Date.now(); saveMeta(m);
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
  function applyRemote(data, updated){
    applying=true;
    for(var k in data){
      if(cfg.watchKeys.indexOf(k)>=0) rawSet(k, typeof data[k]==="string"? data[k] : JSON.stringify(data[k]));
    }
    applying=false;
    var m=meta(); m.updated=updated; m.pushed=updated; saveMeta(m);
  }

  /* GitHub Contents API */
  function api(method, path, body){
    var m=meta();
    return fetch(API+path,{
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
    return fetch(API+"/repos/"+m.repo+"/contents/"+cfg.filePath+"?ref="+BRANCH,{headers:headers}).then(function(res){
      if(res.status===304) return {unchanged:true};
      if(res.status===404) return {missing:true};
      if(res.status===401) throw {code:401};
      if(!res.ok) throw {code:res.status};
      etag=res.headers.get("ETag");
      return res.json().then(function(j){
        var payload; try{ payload=JSON.parse(b64dec(j.content)); }catch(e){ payload={updated:0,data:{}}; }
        return { sha:j.sha, updated:payload.updated||0, data:payload.data||{} };
      });
    });
  }
  function putRemote(sha){
    var m=meta();
    var payload={ app:cfg.appName, version:1, updated:m.updated||Date.now(), data:collect() };
    var body={ message:cfg.appName+" sync "+new Date().toISOString(),
               content:b64enc(JSON.stringify(payload,null,2)), branch:BRANCH };
    if(sha) body.sha=sha;
    return api("PUT","/repos/"+m.repo+"/contents/"+cfg.filePath, body).then(function(res){
      if(res.status===401) throw {code:401};
      if(res.status===409 || res.status===422) throw {code:409};
      if(!res.ok) throw {code:res.status};
      var mm=meta(); mm.pushed=payload.updated; saveMeta(mm);
      return res.json();
    });
  }

  function doPush(silent){
    if(!meta().token) return;
    if(!silent) setStatus("syncing");
    getRemote().then(function(r){
      if(!r.missing && r.updated > (meta().updated||0)){
        // remote is newer than us — take it instead of clobbering
        if(JSON.stringify(r.data)!==JSON.stringify(collect())){ applyRemote(r.data,r.updated); location.reload(); return; }
        var m0=meta(); m0.updated=r.updated; m0.pushed=r.updated; saveMeta(m0); setStatus("synced"); return;
      }
      // ensure our stamp is strictly newer than remote even if device clocks disagree
      var m=meta(); m.updated=Math.max(m.updated||0,(r.missing?0:r.updated)+1); saveMeta(m);
      return putRemote(r.missing? null : r.sha).then(function(){ setStatus("synced"); });
    }).catch(function(e){
      if(e && e.code===409){ setTimeout(function(){ doPush(silent); },800); return; } // sha race → retry
      if(silent) return; // background flush killed by the OS: stay quiet, next check reconciles
      setStatus(e&&e.code===401? "badToken" : "err");
    });
  }

  function doPullOnLoad(){
    if(!meta().token) { setStatus("off"); return; }
    setStatus("syncing");
    getRemote().then(function(r){
      var m=meta();
      if(r.missing){ doPush(); return; }
      var dirty=(m.updated||0) > (m.pushed||0);
      if(r.updated > (m.updated||0)){
        if(JSON.stringify(r.data)!==JSON.stringify(collect())){ applyRemote(r.data,r.updated); location.reload(); return; }
        m.updated=r.updated; m.pushed=r.updated; saveMeta(m); setStatus("synced");
      }else if((m.updated||0) > r.updated || dirty){
        doPush();
      }else setStatus("synced");
    }).catch(function(e){ setStatus(e&&e.code===401? "badToken":"err"); });
  }

  /* first-time connect */
  function connect(repo, token){
    var m=meta(); m.repo=repo.trim(); m.token=token.trim(); saveMeta(m);
    setStatus("syncing");
    api("GET","/repos/"+m.repo).then(function(res){
      if(res.status===401) throw {code:401};
      if(res.status===404) throw {code:404};
      if(!res.ok) throw {code:res.status};
      return getRemote();
    }).then(function(r){
      var localHasData = Object.keys(collect()).length>0;
      if(r.missing || Object.keys(r.data).length===0){
        // repo empty → upload this device's existing localStorage data
        var m2=meta(); m2.updated=Date.now(); saveMeta(m2);
        return putRemote(r.missing? null : r.sha).then(function(){ setStatus("synced"); ui.panel.style.display="none"; });
      }
      if(!localHasData){
        applyRemote(r.data, r.updated); location.reload(); return;
      }
      // both sides have data → explicit user choice
      if(confirm(t("confirmRemote"))){ applyRemote(r.data, r.updated); location.reload(); }
      else{ var m3=meta(); m3.updated=Date.now(); saveMeta(m3); return putRemote(r.sha).then(function(){ setStatus("synced"); ui.panel.style.display="none"; }); }
    }).catch(function(e){
      setStatus(e&&e.code===401? "badToken" : e&&e.code===404? "notFound" : "err");
    });
  }
  function disconnect(){
    var m=meta(); delete m.token; delete m.repo; saveMeta(m);
    setStatus("off");
  }

  /* ── UI bar (injected) ── */
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
    + ".gs-disc{background:transparent;color:#e06060;border:1px solid #e06060!important}";
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
      + '<div class="gs-hint" id="gsHint"></div>';
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
    };
    document.getElementById("gsSync").onclick=function(){ if(meta().token) doPullOnLoad(); };
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

  /* periodic pull: every 45 s while visible, plus immediately when the tab/app regains focus */
  var POLL_MS=45000;
  function checkRemote(){
    var m=meta();
    if(!m.token || document.visibilityState==="hidden" || pushTimer) return;
    getRemote(true).then(function(r){
      if(r.missing) return;
      var mm=meta();
      var dirty=(mm.updated||0) > (mm.pushed||0);
      if(r.unchanged){
        // remote hasn't moved: push if we owe changes, otherwise clear any stale error
        if(dirty) doPush(); else if(lastStatus!=="synced") setStatus("synced");
        return;
      }
      if(r.updated > (mm.updated||0)){
        if(JSON.stringify(r.data)!==JSON.stringify(collect())){ applyRemote(r.data,r.updated); location.reload(); return; }
        mm.updated=r.updated; mm.pushed=r.updated; saveMeta(mm); setStatus("synced");
      }else if((mm.updated||0) > r.updated || dirty){
        doPush();
      }else if(lastStatus!=="synced") setStatus("synced");
    }).catch(function(){ /* transient network errors: try again next tick */ });
  }
  setInterval(checkRemote, POLL_MS);

  /* boot */
  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded", function(){ buildUI(); doPullOnLoad(); });
  }else{ buildUI(); doPullOnLoad(); }

  // hidden → flush pending push; visible again → check the repo right away
  document.addEventListener("visibilitychange", function(){
    if(document.visibilityState==="hidden"){
      if(pushTimer){ clearTimeout(pushTimer); pushTimer=null; doPush(true); }
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
