import assert from 'node:assert/strict';
import { createRoom, startMatch, advance, press, nextDue, drawCard } from '../src/shared/game.ts';
const make = () => {
 const room=createRoom('ABCDEFGH',{id:'host',token:'token',name:'host',seat:0,joinedAt:0},[],0);
 room.timedMode=true;room.penaltyEnabled=true;assert.equal(startMatch(room,0),true);
 assert.equal(room.deadline,37000);assert.equal(press(room,0,6999),false);assert.equal(room.phase,'countdown');
 advance(room,7000,()=>.5);room.cpuTimes=[];return room;
};
const clear=make();
for(let seat=0;seat<6;seat++) {const at=7100+seat*1000;advance(clear,at);assert.equal(press(clear,seat,at),true);advance(clear,at+501);}
assert.equal(clear.phase,'result');assert.equal(clear.reason,'clear');assert.equal(clear.safeCalls.length,6);
assert.deepEqual(clear.scores,[0,0,0,0,0,0]);assert.deepEqual(clear.dobons,[]);assert.deepEqual(clear.losers,[]);assert.equal(drawCard(clear,'host'),null);
const timeout=make();assert.equal(nextDue(timeout),37000);advance(timeout,36999);assert.equal(timeout.phase,'active');advance(timeout,37000);assert.equal(timeout.reason,'timeout');assert.deepEqual(timeout.scores,[0,0,0,0,0,0]);
const retry=make();press(retry,0,7100);press(retry,1,7100);advance(retry,7601,()=>.5);assert.equal(retry.phase,'active');assert.equal(retry.pending.length,0);assert.equal(retry.safeCalls.length,0);assert.ok(retry.cpuTimes.some(event=>event.seat===1));assert.deepEqual(retry.scores,[0,0,0,0,0,0]);retry.cpuTimes=[];press(retry,0,8000);advance(retry,8501);assert.equal(retry.safeCalls.length,1);
const cutoff=make();press(cutoff,0,36900);advance(cutoff,37000);assert.equal(cutoff.reason,'timeout');assert.equal(cutoff.safeCalls.length,0);
