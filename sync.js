/* GitHub sync engine v3 — MANUAL SAVE. GitHub is the single source of truth.
   · Page load  = always fetch the data file from GitHub (no version checks, no cache).
   · Edits      = memory only. Nothing is persisted anywhere automatically.
   · 💾 button  = the ONLY way data is written (PUT to the repo).
   · localStorage holds the connection config (repo/token/branch) and nothing else. */
function initGitSync(cfg){
  "use strict";
  var META = cfg.appName + "_sync_cfg";
  var API  = "https://api.github.com";

  var DICT = {
    en:{ off:"Not connected", loading:"Loading from GitHub…", loaded:"Loaded",
         pending:"● Unsaved changes", saving:"Saving…", saved:"Saved",
         loadErr:"Load failed — data NOT loaded", badToken:"Invalid token (401)",
         notFound:"Repo or file not found", newFile:"New file — press Save to create it",
         save:"💾 Save", reloadTitle:"Reload from GitHub (discards unsaved changes)",
         confirmReload:"You have UNSAVED changes. Reload from GitHub and lose them?",
         confirmOverwrite:"The repo was modified after this page loaded (another device saved).\nOK = overwrite the repo with THIS page's data.\nCancel = do nothing (open the site in another tab to inspect).",
         legacy:"Imported old local data — press Save to upload it",
         settings:"GitHub connection", repo:"Repository (owner/repo)", token:"Token (fine-grained PAT)",
         connect:"Connect", disconnect:"Disconnect",
         hint:"Create a PRIVATE repo for data. Token: GitHub → Settings → Developer settings → Fine-grained tokens → only that repo, Contents: Read & Write. Never commit the token to any repo." },
    es:{ off:"Sin conectar", loading:"Cargando de GitHub…", loaded:"Cargado",
         pending:"● Cambios sin guardar", saving:"Guardando…", saved:"Guardado",
         loadErr:"Error al cargar — datos NO cargados", badToken:"Token no válido (401)",
         notFound:"Repo o archivo no encontrado", newFile:"Archivo nuevo — pulsa Guardar para crearlo",
         save:"💾 Guardar", reloadTitle:"Recargar desde GitHub (descarta cambios sin guardar)",
         confirmReload:"Tienes cambios SIN GUARDAR. ¿Recargar desde GitHub y perderlos?",
         confirmOverwrite:"El repo fue modificado después de cargar esta página (otro dispositivo guardó).\nAceptar = sobrescribir el repo con los datos de ESTA página.\nCancelar = no hacer nada.",
         legacy:"Datos locales antiguos importados — pulsa Guardar para subirlos",
         settings:"Conexión GitHub", repo:"Repositorio (owner/repo)", token:"Token (PAT fine-grained)",
         connect:"Conectar", disconnect:"Desconectar",
         hint:"Crea un repo PRIVADO para los datos. Token: GitHub → Settings → Developer settings → Fine-grained tokens → solo ese repo, Contents: Read & Write. Nunca subas el token a ningún repo." },
    zh:{ off:"未连接", loading:"正在从 GitHub 读取…", loaded:"已加载",
         pending:"● 有未保存的修改", saving:"保存中…", saved:"已保存",
         loadErr:"读取失败——数据未加载", badToken:"Token 无效 (401)",
         notFound:"找不到仓库或文件", newFile:"新文件——按保存创建",
         save:"💾 保存", reloadTitle:"从 GitHub 重新加载（放弃未保存的修改）",
         confirmReload:"有未保存的修改。确定重新加载并丢弃吗？",
         confirmOverwrite:"仓库在本页加载之后被修改过（其他设备保存了）。\n确定 = 用本页数据覆盖仓库。\n取消 = 什么都不做。",
         legacy:"已导入本机旧数据——按保存上传",
         settings:"GitHub 连接", repo:"仓库 (owner/repo)", token:"Token（fine-grained PAT）",
         connect:"连接", disconnect:"断开",
         hint:"请为数据建一个私有仓库。Token 获取：GitHub → Settings → Developer settings → Fine-grained tokens → 只授权该仓库，Contents 读写。永远不要把 Token 提交进任何仓库的代码里。" }
  };
  function t(k){ var l="en"; try{ l=cfg.getLang()||"en"; }catch(e){}
    return (DICT[l]&&DICT[l][k])||DICT.en[k]||k; }

  /* ── debug log (⚙ panel) ── */
  var LOG=[];
  function log(s){
    var ts=new Date().toTimeString().slice(0,8);
    LOG.push(ts+" "+s); if(LOG.length>30) LOG.shift();
    var box=document.getElementById("gsLog");
    if(box && box.offsetParent!==null) box.textContent=LOG.join("\n");
  }

  /* ── connection config (the ONLY thing in localStorage) ── */
  function meta(){ try{ return JSON.parse(localStorage.getItem(META)||"{}"); }catch(e){ return {}; } }
  function saveMeta(m){ try{ localStorage.setItem(META, JSON.stringify(m)); }catch(e){} }
  function branch(){ return meta().branch || "main"; }

  /* ── in-memory data store (string values, same shape the app always used) ── */
  var sha=null;          // sha of the file version this page loaded
  var dirty=false;
  window.GS = {
    ready:false,
    data:{},                                  // key -> JSON string
    get:function(k){ return (k in this.data)? this.data[k] : null; },
    set:function(k,v){
      v=String(v);
      if(this.data[k]===v) return;            // identical recompute → not a change
      this.data[k]=v;
      if(!dirty){ dirty=true; setStatus("pending"); }
      else setStatus("pending");
    }
  };
  function markSaved(){ dirty=false; }

  /* ── GitHub Contents API ── */
  function tfetch(url, opts){
    var ctrl=("AbortController" in window)? new AbortController():null;
    if(ctrl){ opts=opts||{}; opts.signal=ctrl.signal; setTimeout(function(){ ctrl.abort(); },15000); }
    return fetch(url,opts);
  }
  function b64enc(s){ return btoa(unescape(encodeURIComponent(s))); }
  function b64dec(s){ return decodeURIComponent(escape(atob(s.replace(/\n/g,"")))); }
  function getRemote(){
    var m=meta();
    return tfetch(API+"/repos/"+m.repo+"/contents/"+cfg.filePath+"?ref="+branch(),{
      headers:{ "Authorization":"Bearer "+m.token, "Accept":"application/vnd.github+json" }
    }).then(function(res){
      if(res.status===404) return {missing:true};
      if(res.status===401) throw {code:401};
      if(!res.ok) throw {code:res.status};
      return res.json().then(function(j){
        var payload; try{ payload=JSON.parse(b64dec(j.content)); }catch(e){ payload={}; }
        return { sha:j.sha, rev:payload.rev||0, data:payload.data||{} };
      });
    });
  }
  function putRemote(useSha){
    var dataObj={};
    for(var k in GS.data){
      try{ dataObj[k]=JSON.parse(GS.data[k]); }catch(e){ dataObj[k]=GS.data[k]; }
    }
    var m=meta();
    var payload={ app:cfg.appName, version:3, rev:(curRev||0)+1,
                  updated:new Date().toISOString(), data:dataObj };
    var body={ message:cfg.appName+" manual save rev "+payload.rev,
               content:b64enc(JSON.stringify(payload,null,2)), branch:branch() };
    if(useSha) body.sha=useSha;
    return tfetch(API+"/repos/"+m.repo+"/contents/"+cfg.filePath,{
      method:"PUT",
      headers:{ "Authorization":"Bearer "+m.token, "Accept":"application/vnd.github+json" },
      body:JSON.stringify(body)
    }).then(function(res){
      if(res.status===401) throw {code:401};
      if(res.status===409||res.status===422) throw {code:409};
      if(!res.ok) throw {code:res.status};
      return res.json().then(function(j){
        sha=j.content.sha; curRev=payload.rev; markSaved();
        log("saved rev "+payload.rev);
      });
    });
  }

  /* ── load on page open: GitHub is always the truth ── */
  var curRev=0;
  function applyRemote(r){
    GS.data={};
    for(var k in r.data){
      if(cfg.watchKeys.indexOf(k)>=0)
        GS.data[k] = (typeof r.data[k]==="string")? r.data[k] : JSON.stringify(r.data[k]);
    }
    sha=r.sha; curRev=r.rev||0; dirty=false;
  }
  function importLegacy(){
    var found=false;
    cfg.watchKeys.forEach(function(k){
      try{ var v=localStorage.getItem(k); if(v!==null){ GS.data[k]=v; found=true; } }catch(e){}
    });
    return found;
  }
  function startApp(){
    GS.ready=true;
    if(window.__appBoot){ try{ window.__appBoot(); }catch(e){ log("app error: "+(e&&e.message)); } }
  }
  function boot(){
    var m=meta();
    if(!m.token){
      startApp(); setStatus("off");
      if(ui.panel) ui.panel.style.display="block";
      return;
    }
    setStatus("loading");
    getRemote().then(function(r){
      if(r.missing || Object.keys(r.data||{}).length===0){
        sha = r.missing? null : r.sha; curRev=r.rev||0;
        if(importLegacy()){ dirty=true; startApp(); setStatus("pending"); log("legacy local data imported"); alert(t("legacy")); }
        else { startApp(); setStatus("newFile"); }
        return;
      }
      applyRemote(r);
      log("loaded rev "+curRev+" from GitHub");
      startApp(); setStatus("loaded");
    }).catch(function(e){
      log("load error: "+(e&&e.code||e&&e.name||"network"));
      setStatus(e&&e.code===401? "badToken" : e&&e.code===404? "notFound" : "loadErr");
      /* intentionally NOT booting the app with stale/empty data on load failure */
    });
  }

  /* ── manual save ── */
  var savingNow=false;
  function doSave(){
    var m=meta();
    if(!m.token){ if(ui.panel) ui.panel.style.display="block"; return; }
    if(savingNow) return;
    savingNow=true; setStatus("saving");
    putRemote(sha).then(function(){ setStatus("saved"); })
    .catch(function(e){
      if(e&&e.code===409){
        // repo moved since we loaded → ask before overwriting
        if(confirm(t("confirmOverwrite"))){
          return getRemote().then(function(r){
            return putRemote(r.missing? null : r.sha).then(function(){ setStatus("saved"); });
          }).catch(function(e2){ log("overwrite failed: "+(e2&&e2.code||"network")); setStatus("err"); });
        }
        setStatus("pending"); return;
      }
      log("save error: "+(e&&e.code||e&&e.name||"network"));
      setStatus(e&&e.code===401? "badToken":"err");
    }).finally(function(){ savingNow=false; });
  }

  /* ── connect / disconnect ── */
  function connect(repo, token){
    var m=meta(); m.repo=repo.trim(); m.token=token.trim(); saveMeta(m);
    setStatus("loading");
    tfetch(API+"/repos/"+m.repo,{headers:{ "Authorization":"Bearer "+m.token, "Accept":"application/vnd.github+json" }})
    .then(function(res){
      if(res.status===401) throw {code:401};
      if(res.status===404) throw {code:404};
      if(!res.ok) throw {code:res.status};
      return res.json();
    }).then(function(j){
      var mb=meta(); mb.branch=j.default_branch||"main"; saveMeta(mb);
      log("connected, branch="+mb.branch);
      location.reload();                       // fresh boot = read the repo
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
    + ".gs-bar button{border:1px solid var(--line,#28303d);background:var(--panel-2,#1c2330);"
    + "color:var(--text,#e8edf4);border-radius:8px;padding:5px 10px;cursor:pointer;font-family:inherit;font-size:.8rem}"
    + ".gs-save{margin-left:auto;font-weight:700}"
    + ".gs-save.pending{background:#8a5a1e;border-color:#e0a23c;color:#ffe2b0;animation:gsPulse 1.6s infinite}"
    + "@keyframes gsPulse{50%{opacity:.75}}"
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
      + '<button id="gsSave" class="gs-save" type="button"></button>'
      + '<button id="gsReload" type="button">⟳</button><button id="gsGear" type="button">⚙</button>';
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
         panel:panel, repo:document.getElementById("gsRepo"), tok:document.getElementById("gsTok"),
         save:document.getElementById("gsSave") };
    document.getElementById("gsGear").onclick=function(){
      panel.style.display = panel.style.display==="none"||!panel.style.display ? "block":"none";
      ui.repo.value = meta().repo||"";
      applyPanelText();
      var box=document.getElementById("gsLog"); if(box) box.textContent=LOG.join("\n");
    };
    document.getElementById("gsReload").onclick=function(){
      if(dirty && !confirm(t("confirmReload"))) return;
      dirty=false; location.reload();
    };
    ui.save.onclick=doSave;
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
    document.getElementById("gsReload").title=t("reloadTitle");
    ui.save.textContent=t("save");
  }
  function setStatus(s){
    if(!ui.dot) return;
    ui.dot.className="gs-dot "+(s==="loaded"||s==="saved"?"ok":s==="loading"||s==="saving"||s==="pending"||s==="newFile"?"work":s==="off"?"":"bad");
    var txt=t(s);
    if(s==="saved"||s==="loaded") txt+=" · "+new Date().toTimeString().slice(0,5);
    ui.text.textContent=txt;
    ui.save.className="gs-save"+(s==="pending"?" pending":"");
    ui.save.textContent=t("save");
  }

  /* ── guard against closing with unsaved edits ── */
  window.addEventListener("beforeunload", function(e){
    if(dirty){ e.preventDefault(); e.returnValue=""; return ""; }
  });

  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded", function(){ buildUI(); boot(); });
  }else{ buildUI(); boot(); }
}

/* ── fitness site config ── */
initGitSync({
  appName:"ft",
  filePath:"fitness-data.json",
  watchKeys:["ftdash_state_v2","ft_targets_v1","ft_foods_v1","ft_diary_v1","ftdash_history_v1"],
  getLang:function(){ try{ var s=JSON.parse((window.GS&&GS.get("ftdash_state_v2"))||"{}"); return s.lang||"en"; }catch(e){ return "en"; } }
});
