import assert from 'node:assert/strict';
import { createRoom, advance, press, startMatch, nextDue } from '../src/shared/game.ts';
for (const ms of [200, 300, 500] as const) {
  for (const delta of [ms - 1, ms, ms + 1]) {
    const room = createRoom('ABCDEFGH', { id: 'host', token: 'token', name: 'host', seat: 0, joinedAt: 0 }, [], 0);
    room.collisionMs = ms;
    startMatch(room, 0); advance(room, 7000); room.cpuTimes = [];
    press(room, 0, 7100); assert.equal(nextDue(room), 7100 + ms + 1);
    advance(room, 7100 + delta); press(room, 1, 7100 + delta);
    advance(room, 7100 + delta + ms + 1);
    assert.equal(room.reason, delta <= ms ? 'collision' : null);
    if (delta > ms) assert.deepEqual(room.safeCalls.map(call => call.seat), [0, 1]);
  }
}
