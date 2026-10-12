/** The console renders only a screenshot; remote page code never runs in this document. */
// 0Siri: 대화 안 브라우저 카드가 이 화면을 끼워 넣는다. 위쪽 막대가 제어권 — 영시리가 조작 중이면 보기만,
// «직접 조작» 을 누르거나 영시리가 넘기면(browser_handoff) 클릭·입력, «영시리에게 돌려주기» 로 끝낸다 (마스터 2026-10-12).
// 제어권은 미리보기 응답 머리글(X-Browser-Holder·X-Browser-Reason)로 2초마다 함께 받는다.
export function browserConsole(previewUrl: string) {
  const preview = JSON.stringify(previewUrl).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>0Siri 브라우저</title><style>
*{box-sizing:border-box}body{margin:0;background:#fcfcfc;color:#172125;font:14px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
header{padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:10px}#status{color:#697176;font-size:12px}#status.live{color:#248258}
#control{margin:0 8px 8px;padding:10px 12px;border-radius:14px;display:flex;align-items:center;gap:10px;background:#eef1f3}#control.user{background:#e1efe9}
#holder{flex:1;font-size:13px;line-height:1.4}#holder b{display:block}
button,input{font:inherit;border:1px solid #e9edef;border-radius:24px;padding:10px 14px;background:white;color:inherit;min-height:42px}
button{cursor:pointer}button:hover{background:#edf7fd}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid #1473c8;outline-offset:2px}
#take{background:#0f6b55;color:white;border-color:#0f6b55;white-space:nowrap}
form{padding:0 12px 10px;display:flex;gap:8px}input{flex:1;min-width:0;background:#f1f3f4;border-color:transparent}#type{background:#c8e7ff}
nav{display:flex;gap:6px;padding:0 12px 12px;flex-wrap:wrap}nav button{font-size:12px;min-height:36px;padding:7px 12px}
#stage{overflow:hidden;background:#eef1f3;border-radius:18px;min-height:160px;margin:0 8px}img{display:block;width:100%;height:auto;cursor:crosshair;touch-action:pan-y}img.stale{opacity:.45;pointer-events:none}img.watch{cursor:default;pointer-events:none}
#error{margin:0 12px 12px;color:#984a41;background:#fbefed;padding:12px;border-radius:14px}#error:empty{display:none}.user-only{display:none}body.user .user-only{display:flex}
</style><header><strong>브라우저</strong><span id="status" role="status">연결 중…</span><button id="refresh" aria-label="화면 새로 고침">↻</button></header>
<div id="control"><div id="holder" role="status"><b>영시리가 조작 중</b>보기만 할 수 있어요</div><button id="take">직접 조작</button></div>
<form class="user-only"><input id="text" aria-label="브라우저에 입력할 글" placeholder="화면에서 칸을 누른 뒤 여기에 입력" autocomplete="off"><button id="type" type="submit">입력</button></form>
<nav class="user-only" aria-label="브라우저 키"><button data-key="Enter">Enter ↵</button><button data-key="Tab">Tab ⇥</button><button data-key="Backspace">지우기 ⌫</button><button id="up">위로</button><button id="down">아래로</button></nav>
<div id="error" role="alert"></div><div id="stage"><img id="screen" class="stale" alt="영시리 브라우저 화면" draggable="false"></div><script>
const image=document.querySelector('#screen'),error=document.querySelector('#error'),status=document.querySelector('#status'),field=document.querySelector('#text'),holderBox=document.querySelector('#holder'),take=document.querySelector('#take'),bar=document.querySelector('#control');
let refreshing=false,sending=false,imageUrl,live=false,previewError=false,holder='agent';
function controls(){const mine=holder==='user';document.body.classList.toggle('user',mine);bar.classList.toggle('user',mine);
document.querySelectorAll('nav button,#type').forEach(button=>button.disabled=sending||!live||!mine);take.disabled=sending;
image.classList.toggle('stale',!live||sending);image.classList.toggle('watch',!mine);}
function showHolder(next,reason){holder=next==='user'?'user':'agent';holderBox.textContent='';const b=document.createElement('b');
b.textContent=holder==='user'?'내가 조작 중':'영시리가 조작 중';holderBox.append(b,holder==='user'?(reason||'끝나면 영시리에게 돌려주세요'):'보기만 할 수 있어요');
take.textContent=holder==='user'?'영시리에게 돌려주기':'직접 조작';controls();}
async function refresh(){if(refreshing||sending||document.hidden)return;refreshing=true;try{
const r=await fetch(${preview},{cache:'no-store',signal:AbortSignal.timeout(20000)});
if(!r.ok)throw new Error(r.status===401?'접근 시간이 지났습니다. 대화에서 브라우저를 다시 여세요.':'브라우저 연결이 끊겼습니다. 대화에서 다시 여세요.');
showHolder(r.headers.get('X-Browser-Holder'),decodeURIComponent(r.headers.get('X-Browser-Reason')||''));
const blob=await r.blob();const next=URL.createObjectURL(blob);await new Promise((resolve,reject)=>{const probe=new Image();probe.onload=resolve;probe.onerror=()=>{URL.revokeObjectURL(next);reject(new Error('화면을 그리지 못했습니다.'));};probe.src=next;});
if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=next;image.src=next;live=true;status.textContent='실시간';status.className='live';if(previewError){error.textContent='';previewError=false;}
}catch(e){live=false;previewError=true;status.textContent='끊김';status.className='';error.textContent=e.message;}finally{refreshing=false;controls();}}
async function post(body){const r=await fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(typeof data.error==='string'?data.error:'브라우저 조작에 실패했습니다. 입력한 글은 그대로 있습니다.');return data;}
async function input(body){if(sending||!live||holder!=='user')return false;sending=true;controls();error.textContent='';status.textContent='반영 중…';let ok=false;try{await post(body);ok=true;}
catch(e){error.textContent=e.message;}finally{sending=false;controls();await refresh();}return ok;}
take.onclick=async()=>{if(sending)return;sending=true;controls();error.textContent='';try{const data=await post({control:holder==='user'?'agent':'user'});showHolder(data.holder,data.reason);}
catch(e){error.textContent=e.message;}finally{sending=false;controls();}};
image.onclick=e=>{if(!live||sending||holder!=='user')return;const r=image.getBoundingClientRect();input({type:'click',x:Math.min(1279,Math.max(0,Math.floor((e.clientX-r.left)*1280/r.width))),y:Math.min(799,Math.max(0,Math.floor((e.clientY-r.top)*800/r.height)))});};
document.querySelector('form').onsubmit=async e=>{e.preventDefault();const text=field.value;if(text&&await input({type:'text',text})&&field.value===text)field.value='';};
document.querySelectorAll('[data-key]').forEach(b=>b.onclick=()=>input({type:'key',key:b.dataset.key}));
document.querySelector('#up').onclick=()=>input({type:'scroll',deltaY:-600});document.querySelector('#down').onclick=()=>input({type:'scroll',deltaY:600});
document.querySelector('#refresh').onclick=()=>{error.textContent='';refresh();};document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
controls();refresh();const timer=setInterval(refresh,2000);window.addEventListener('pagehide',()=>{clearInterval(timer);if(imageUrl)URL.revokeObjectURL(imageUrl);});
</script></html>`;
}
