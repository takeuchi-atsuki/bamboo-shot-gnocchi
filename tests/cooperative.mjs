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

const host = await post("/api/rooms", { name: "ホスト", cards: ["歌う"] });
const guest = await post(`/api/rooms/${host.code}/join`, { name: "ゲスト" });
const hostSocket = await openSocket(host.code, host.token);
const hostRoom = watch(hostSocket);
const guestSocket = await openSocket(host.code, guest.token);
const guestRoom = watch(guestSocket);

try {
  await hostRoom(room=>room.players.length===2);
  hostSocket.send(JSON.stringify({type:"setTimedMode",enabled:true}));
  hostSocket.send(JSON.stringify({type:"setTimeLimit",timeLimitMs:15000}));
  await guestRoom(room=>room.timedMode && room.timeLimitMs===15000);
  hostSocket.send(JSON.stringify({type:"start"}));
  const a=await hostRoom(room=>room.phase==="countdown");
  const b=await guestRoom(room=>room.phase==="countdown");
  assert.equal(a.deadline,b.deadline);assert.equal(a.deadline-a.goAt,15000);
  const result=await hostRoom(room=>room.phase==="result",25000);
  const other=await guestRoom(room=>room.phase==="result",25000);
  assert.equal(result.reason,"timeout");assert.equal(other.reason,result.reason);
  assert.deepEqual(result.scores,[0,0,0,0,0,0]);assert.deepEqual(other.scores,result.scores);
  assert.deepEqual(result.dobons,[]);assert.deepEqual(result.losers,[]);
  console.log("Cooperative integration passed: shared deadline, timeout result, no penalties.");
} finally {hostSocket.close();guestSocket.close();}
