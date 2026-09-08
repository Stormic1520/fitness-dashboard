/* Shared helpers for the fitness site — storage is localStorage with JSON values */
window.FT = (function(){
  "use strict";
  var KEYS = {
    state:  "ftdash_state_v2",     // calculator inputs (incl. lang)
    targets:"ft_targets_v1",       // published daily macro targets
    foods:  "ft_foods_v1",         // food bank
    diary:  "ft_diary_v1",         // daily food log
    hist:   "ftdash_history_v1"    // body snapshots
  };
  function getJSON(k, def){
    try{ var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; }
    catch(e){ return def; }
  }
  function setJSON(k, obj){
    try{ localStorage.setItem(k, JSON.stringify(obj)); return true; }
    catch(e){ return false; }
  }
  function getLang(){ var s = getJSON(KEYS.state, {}); return s.lang || "en"; }
  function setLang(l){ var s = getJSON(KEYS.state, {}); s.lang = l; setJSON(KEYS.state, s); }
  function today(){
    var d = new Date();
    return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
  }
  function uid(){ return Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,7); }
  function r0(n){ return Math.round(n); }
  function r1(n){ return Math.round(n*10)/10; }
  return { KEYS:KEYS, getJSON:getJSON, setJSON:setJSON, getLang:getLang, setLang:setLang,
           today:today, uid:uid, r0:r0, r1:r1 };
})();
