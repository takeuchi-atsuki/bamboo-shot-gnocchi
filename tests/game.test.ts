import test from "node:test";
import assert from "node:assert/strict";
import {
  COLLISION_MS, IDLE_MS, advance, createRoom, drawCard, press, startMatch, startRound,
  type Player,
} from "../src/shared/game.ts";

function fixture() {
  const players: Player[] = Array.from({ length: 6 }, (_, seat) => ({
    id: `player-${seat}`, token: `token-${seat}`, name: `人${seat + 1}`, seat, joinedAt: 0,
  }));
  const room = createRoom("ABCDEFGH", players[0], [{ id: "card-1", text: "歌う" }, { id: "card-2", text: "踊る" }], 0);
  room.players = players;
  assert.equal(startMatch(room, 0), true);
  advance(room, room.goAt!, () => 0.5);
  return room;
}

test("単独コールは500ms後に確定し、5番目の後に残りの席がドボン", () => {
  const room = fixture();
  for (let seat = 0; seat < 5; seat += 1) {
    const at = room.lastProgressAt! + 1000;
    assert.equal(press(room, seat, at), true);
    advance(room, at + COLLISION_MS + 1);
    assert.equal(room.safeCalls[seat]?.number, seat + 1);
  }
  assert.equal(room.phase, "result");
  assert.deepEqual(room.dobons, [5]);
  assert.equal(room.scores[5], 1);
});

test("同時押しは窓内の全員がドボン、窓外は次の番号", () => {
  const room = fixture();
  const first = room.lastProgressAt! + 1000;
  press(room, 0, first);
  press(room, 1, first + COLLISION_MS);
  advance(room, first + COLLISION_MS + 1);
  assert.equal(room.phase, "result");
  assert.deepEqual(room.dobons, [0, 1]);
  const second = fixture();
  press(second, 0, first);
  advance(second, first + COLLISION_MS + 1);
  press(second, 1, first + COLLISION_MS + 2);
  assert.equal(second.phase, "active");
  assert.deepEqual(second.safeCalls, [{ seat: 0, number: 1 }]);
});

test("開始前の押下はフライング", () => {
  const room = fixture();
  startRound(room, 20_000, false);
  press(room, 2, 20_100);
  assert.equal(room.reason, "flying");
  assert.deepEqual(room.dobons, [2]);
});

test("未コールの全員は15秒で時間切れ", () => {
  const room = fixture();
  advance(room, room.lastProgressAt! + IDLE_MS);
  assert.equal(room.reason, "timeout");
  assert.deepEqual(room.dobons, [0, 1, 2, 3, 4, 5]);
});

test("3回目の衝突は相手も道連れにする", () => {
  const room = fixture();
  room.scores[0] = 2;
  const at = room.lastProgressAt! + 1000;
  press(room, 0, at);
  press(room, 1, at + 20);
  advance(room, at + COLLISION_MS + 1);
  assert.equal(room.phase, "finished");
  assert.deepEqual(room.losers, [0, 1]);
  assert.equal(room.scores[1], 1);
});

test("CPUの予定押下も同じ判定窓へ入る", () => {
  const room = fixture();
  room.players = room.players.slice(0, 1);
  startRound(room, 30_000, false);
  advance(room, room.goAt!, () => 0);
  const cpuAt = room.cpuTimes[0].at;
  press(room, 0, cpuAt);
  advance(room, cpuAt + COLLISION_MS + 1, () => 0);
  assert.equal(room.reason, "collision");
  assert.ok(room.dobons.includes(0));
  assert.ok(room.dobons.some((seat) => seat !== 0));
});

test("敗北した人間はカードを引き直せる", () => {
  const room = fixture();
  room.penaltyEnabled = true;
  room.scores[0] = 2;
  startRound(room, 20_000, false);
  press(room, 0, 20_100);
  const first = drawCard(room, "player-0", () => 0);
  const second = drawCard(room, "player-0", () => 0);
  assert.notEqual(first, second);
  assert.equal(drawCard(room, "player-1"), null);
});

test("カードが1枚だけなら同じカードを引き直さない", () => {
  const room = fixture();
  room.penaltyEnabled = true;
  room.cards = [{ id: "only", text: "歌う" }];
  room.phase = "finished";
  room.losers = [0];
  room.deck = ["only"];
  assert.equal(drawCard(room, "player-0"), "only");
  assert.equal(drawCard(room, "player-0"), null);
});
