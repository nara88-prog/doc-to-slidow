/**
 * src/export/html.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Export slide deck as a fully self-contained, offline HTML file.
 * No external dependencies — all CSS and JS is inlined.
 * Arrow-key navigation included.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Slide } from '../types';

export function exportHtml(slides: Slide[]): string {
  const slidesJson = JSON.stringify(
    slides.map((s) => ({
      title: s.title,
      bullets: s.bullets,
      notes: s.notes,
      icon: s.icon,
    }))
  )
    // The deck is embedded in a <script> block, so a document that happens to
    // contain "</script>" would end the block early and leave a broken file.
    // Escaping "<" is harmless to JSON and makes that impossible.
    .replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Presentation</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0f1117;color:#e8eaf0;font-family:-apple-system,"Segoe UI",system-ui,sans-serif;height:100vh;overflow:hidden;display:flex;flex-direction:column}
#slide{flex:1;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;padding:60px 80px;gap:20px}
#icon{font-size:48px}
#title{font-size:46px;font-weight:900;color:#4f8ef7;line-height:1.15;letter-spacing:-1px}
#bullets{list-style:none;display:flex;flex-direction:column;gap:14px;margin-top:4px}
#bullets li{font-size:22px;display:flex;gap:12px;line-height:1.4}
#bullets li::before{content:"→";color:#4f8ef7;flex-shrink:0}
#controls{display:flex;align-items:center;gap:16px;padding:16px 24px;background:rgba(0,0,0,0.4);border-top:1px solid #2e3350}
button{cursor:pointer;border:none;background:rgba(255,255,255,0.1);color:#fff;padding:8px 20px;border-radius:20px;font-size:14px;transition:background 0.15s}
button:hover{background:rgba(255,255,255,0.2)}
button:disabled{opacity:0.3;cursor:default}
#counter{flex:1;text-align:center;color:rgba(255,255,255,0.5);font-size:14px}
#notes{padding:8px 24px;font-size:12px;color:rgba(255,255,255,0.45);background:rgba(0,0,0,0.3);border-top:1px solid #2e3350;min-height:28px}
</style>
</head>
<body>
<div id="slide">
  <div id="icon"></div>
  <h1 id="title"></h1>
  <ul id="bullets"></ul>
</div>
<div id="notes"></div>
<div id="controls">
  <button id="prev" aria-label="Previous slide">◀ Prev</button>
  <span id="counter"></span>
  <button id="next" aria-label="Next slide">Next ▶</button>
</div>
<script>
(function(){
  var slides=${slidesJson};
  var idx=0;
  function render(){
    var s=slides[idx];
    document.getElementById('icon').textContent=s.icon;
    document.getElementById('title').textContent=s.title;
    var ul=document.getElementById('bullets');
    ul.innerHTML='';
    s.bullets.forEach(function(b){var li=document.createElement('li');li.textContent=b;ul.appendChild(li);});
    document.getElementById('notes').textContent=s.notes||'';
    document.getElementById('counter').textContent=(idx+1)+' / '+slides.length;
    document.getElementById('prev').disabled=idx===0;
    document.getElementById('next').disabled=idx===slides.length-1;
  }
  document.getElementById('prev').onclick=function(){if(idx>0){idx--;render();}};
  document.getElementById('next').onclick=function(){if(idx<slides.length-1){idx++;render();}};
  document.addEventListener('keydown',function(e){
    if(e.key==='ArrowRight'||e.key==='ArrowDown'||e.key===' '){if(idx<slides.length-1){idx++;render();}}
    if(e.key==='ArrowLeft'||e.key==='ArrowUp'){if(idx>0){idx--;render();}}
  });
  render();
})();
</script>
</body>
</html>`;
}
