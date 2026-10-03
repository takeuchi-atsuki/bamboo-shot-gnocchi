import assert from "node:assert/strict";

const base = process.env.TEST_BASE_URL ?? "http://127.0.0.1:8787";
const wsBase = base.replace(/^http/, "ws");

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}

function openSocket(code, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}/api/rooms/${code}/socket?token=${token}`);
    const timer = setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(socket); }, { once: true });
    socket.addEventListener("error", (event) => { clearTimeout(timer); reject(event.error ?? new Error("WebSocket error")); }, { once: true });
  });
}

function watch(socket) {
  let latest;
  const listeners = new Set();
  socket.addEventListener("message", (event) => {
    latest = JSON.parse(event.data).room;
    for (const listener of listeners) listener(latest);
  });
  return (predicate, timeoutMs = 5000) => new Promise((resolve, reject) => {
    if (latest && predicate(latest)) return resolve(latest);
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error("Snapshot timeout")); }, timeoutMs);
    function check(room) {
      if (predicate(room)) { clearTimeout(timer); listeners.delete(check); resolve(room); }
    }
    listeners.add(check);
  });
}

const host=await post("/api/rooms",{name:"host"});
const identities=[host];
for(let i=1;i<6;i++) identities.push(await post(`/api/rooms/${host.code}/join`,{name:`player${i}`}));
const sockets=[];const watches=[];
for(const identity of identities) {const socket=await openSocket(identity.code,identity.token);sockets.push(socket);watches.push(watch(socket));}
try {
 const send=command=>sockets[0].send(JSON.stringify(command));
 send({type:"setRandomStart",enabled:true});send({type:"setTimedMode",enabled:true});send({type:"setCollision",collisionMs:200});send({type:"setTimeLimit",timeLimitMs:15000});
 await watches[5](room=>room.randomStart && room.timedMode && room.collisionMs===200 && room.timeLimitMs===15000);
 send({type:"start"});
 const waiting=await Promise.all(watches.map(watch=>watch(room=>room.phase==="countdown")));
 for(const room of waiting) {assert.equal(room.goAt,null);assert.equal(room.deadline,null);}
 const active=await Promise.all(watches.map(watch=>watch(room=>room.phase==="active",10000)));
 for(const room of active) {assert.equal(room.goAt,active[0].goAt);assert.equal(room.deadline,active[0].deadline);}
 for(let seat=0;seat<6;seat++) {sockets[seat].send(JSON.stringify({type:"call"}));await watches[0](room=>room.safeCalls.length===seat+1);}
 const results=await Promise.all(watches.map(watch=>watch(room=>room.phase==="result")));
 for(const room of results) {assert.equal(room.reason,"clear");assert.equal(room.safeCalls.length,6);assert.deepEqual(room.scores,[0,0,0,0,0,0]);assert.deepEqual(room.dobons,[]);}
 console.log("Combined modes passed: six clients, random start hidden, 200ms calls, timed clear and shared results.");
} finally {sockets.forEach(socket=>socket.close());}
