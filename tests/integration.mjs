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
  assert.equal((await hostRoom((room) => room.players.length === 2)).players.length, 2);
  guestSocket.send(JSON.stringify({ type: "addCard", text: "踊る" }));
  assert.equal((await hostRoom((room) => room.cards.length === 2)).cards.length, 2);
  hostSocket.send(JSON.stringify({ type: "setMode", enabled: true }));
  await guestRoom((room) => room.penaltyEnabled);
  hostSocket.send(JSON.stringify({ type: "start" }));
  await guestRoom((room) => room.phase === "countdown");
  guestSocket.send(JSON.stringify({ type: "call" }));
  const result = await hostRoom((room) => room.phase === "result" && room.reason === "flying");
  assert.deepEqual(result.dobons, [1]);
  hostSocket.send(JSON.stringify({ type: "next" }));
  await hostRoom((room) => room.phase === "countdown" && room.round === 2);
  guestSocket.close();
  await hostRoom((room) => room.phase === "paused");
  const reconnect = await openSocket(host.code, guest.token);
  const rejoinedRoom = watch(reconnect);
  await rejoinedRoom((room) => room.phase === "countdown" && room.round === 2);
  hostSocket.close();
  await rejoinedRoom((room) => room.phase === "paused");
  await rejoinedRoom((room) => room.hostId === guest.memberId && room.pauseUntil === null, 35_000);
  reconnect.send(JSON.stringify({ type: "resumeCpu" }));
  await rejoinedRoom((room) => room.phase === "countdown" && room.round === 2);
  reconnect.close();
  process.stdout.write("Integration passed: join, sync, cards, flying, reconnect and host transfer.\n");
} finally {
  hostSocket.close();
  guestSocket.close();
}
