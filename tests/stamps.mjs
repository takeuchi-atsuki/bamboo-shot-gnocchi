import assert from 'node:assert/strict';
const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:8787';
async function create(name) { const r = await fetch(base + '/api/rooms', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})}); assert.equal(r.status,200); return r.json(); }
async function connect(identity) {
  const socket = new WebSocket(base.replace(/^http/, 'ws') + `/api/rooms/${identity.code}/socket?token=${identity.token}`);
  const snapshots = [];
  socket.addEventListener('message', e => { const data=JSON.parse(e.data); if (data.type==='snapshot') snapshots.push(data.room); });
  await new Promise((resolve,reject) => { socket.addEventListener('open',resolve,{once:true}); socket.addEventListener('error',reject,{once:true}); });
  return {socket,snapshots};
}
async function until(predicate) { const end=Date.now()+5000; while(!predicate()) { if(Date.now()>end) throw new Error('snapshot timeout'); await new Promise(r=>setTimeout(r,30)); } }
const a=await create('a'), b=await create('b');
const response=await fetch(`${base}/api/rooms/${a.code}/join`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'guest'})});
const guest=await response.json();
const x=await connect(a), y=await connect(guest), z=await connect(b);
try {
 x.socket.send(JSON.stringify({type:'stamp',text:'お先に！'}));
 await until(()=>y.snapshots.at(-1)?.stamps?.length===1);
 assert.equal(y.snapshots.at(-1).stamps[0].name,'a');
 assert.equal(y.snapshots.at(-1).stamps[0].text,'お先に！');
 x.socket.send(JSON.stringify({type:'stamp',text:'spam'}));
 x.socket.send(JSON.stringify({type:'stamp',text:'   '}));
 await new Promise(r=>setTimeout(r,2100));
 assert.equal(y.snapshots.at(-1).stamps.length,1);
 assert.equal(z.snapshots.at(-1).stamps.length,0);
 y.socket.send(JSON.stringify({type:'stamp',text:'ナイス！'}));
 await until(()=>x.snapshots.at(-1)?.stamps?.length===2);
 assert.equal(x.snapshots.at(-1).stamps[1].text,'ナイス！');
 console.log('Stamp integration passed: sharing, room isolation, allowlist, rate limit.');
} finally {x.socket.close();y.socket.close();z.socket.close();}
