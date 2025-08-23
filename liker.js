(async () => {
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  const until = async (pred, {timeout=8000, step=120}={})=>{
    const t0=Date.now(); while(Date.now()-t0<timeout){ const v=await pred(); if(v) return v; await sleep(step); }
    return null;
  };
  const isVisible = el => el && el.isConnected && el.offsetWidth>0 && el.offsetHeight>0 && getComputedStyle(el).visibility!=='hidden';
  const log = (...a)=>{ try{ console.log("[LIKER]", ...a);}catch{} };

  function safeClick(el){
    if(!isVisible(el)) return false;
    el.scrollIntoView({block:'center', inline:'center'});
    const o={bubbles:true, cancelable:true, composed:true, view:window};
    try{ el.dispatchEvent(new PointerEvent('pointerover', o)); }catch{}
    try{ el.dispatchEvent(new MouseEvent('mouseover', o)); }catch{}
    try{ el.dispatchEvent(new PointerEvent('pointerdown', o)); }catch{}
    try{ el.dispatchEvent(new MouseEvent('mousedown', o)); }catch{}
    try{ el.dispatchEvent(new PointerEvent('pointerup', o)); }catch{}
    try{ el.dispatchEvent(new MouseEvent('mouseup', o)); }catch{}
    try{ el.click(); }catch{}
    return true;
  }
  const send = (type, reason)=> chrome.runtime.sendMessage({ type, reason });

  try{
    // Fechar intersticiais básicos
    (()=>{
      const texts=['Fechar','Close','Agora não','Not now','Aceitar','Accept','Allow','Ver foto','See photo'];
      [...document.querySelectorAll('button,[role="button"]')].forEach(b=>{
        const t=(b.ariaLabel||b.innerText||'').trim();
        if(texts.some(x=>t.includes(x))) { try{ b.click(); }catch{} }
      });
    })();

    // Achar 1ª mídia no grid do perfil
    window.scrollTo(0,0); await sleep(200);
    let anchors=[...document.querySelectorAll('article a[href*="/p/"], article a[href*="/reel/"]')].filter(isVisible);
    if(!anchors.length){ window.scrollTo(0,600); await sleep(250);
      anchors=[...document.querySelectorAll('article a[href*="/p/"], article a[href*="/reel/"]')].filter(isVisible);
    }
    const first=anchors[0];
    if(!first){ log("no media"); return send("LIKE_SKIP","no_media"); }

    // Abrir mídia
    safeClick(first);
    let mode="modal";
    const modal = await until(()=>document.querySelector('[role="dialog"] article'));
    if(!modal){
      mode="route";
      const ok = await until(()=>/^(\/p\/|\/reel\/)/.test(location.pathname));
      if(!ok){ log("open_failed"); return send("LIKE_SKIP","open_failed"); }
    }
    const ctx = mode==="modal" ? document.querySelector('[role="dialog"]') : document;

    function findLikeBtn(){
      const article = ctx.querySelector('article') || ctx;
      const pressed   = article.querySelector('button[aria-pressed="true"]');
      const unpressed = article.querySelector('button[aria-pressed="false"]');
      const likeLbl   = article.querySelector('button[aria-label*="Curtir" i],button[aria-label*="Like" i]');
      const unlikeLbl = article.querySelector('button[aria-label*="Descurtir" i],button[aria-label*="Unlike" i]');
      return { article, pressed, unpressed, likeLbl, unlikeLbl };
    }
    function alreadyLiked(s){ return !!(s.pressed || s.unlikeLbl); }

    let s = findLikeBtn();
    if(!(s.pressed||s.unpressed||s.likeLbl||s.unlikeLbl)){
      log("like_button_not_found"); return send("LIKE_SKIP","like_button_not_found");
    }
    if(alreadyLiked(s)){ log("already liked"); if(mode==="modal") ctx.querySelector('[aria-label*="Fechar" i],[aria-label*="Close" i]')?.click(); return send("LIKE_DONE"); }

    async function clickAndConfirm(){
      let f = findLikeBtn(); const btn = f.pressed||f.unpressed||f.likeLbl||f.unlikeLbl;
      if(!btn) return false;
      safeClick(btn); await sleep(300);
      const ok = await until(()=> { const g=findLikeBtn(); return alreadyLiked(g); }, {timeout:8000, step:150});
      return !!ok;
    }

    let ok = await clickAndConfirm();
    if(!ok){ log("retrying..."); await sleep(500); ok = await clickAndConfirm(); }
    if(!ok){ log("state_not_changed"); return send("LIKE_SKIP","state_not_changed"); }

    if(mode==="modal") ctx.querySelector('[aria-label*="Fechar" i],[aria-label*="Close" i]')?.click();
    log("LIKE_DONE"); return send("LIKE_DONE");
  }catch(e){
    console.error("[LIKER] exception", e);
    return send("LIKE_SKIP","exception");
  }
})();

