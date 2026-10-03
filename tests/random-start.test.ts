import assert from 'node:assert/strict';
import { createRoom, startRound, advance, press, publicRoom, nextDue } from '../src/shared/game.ts';
const make = () => createRoom('ABCDEFGH', {id:'host',token:'token',name:'host',seat:0,joinedAt:0},[],0);
for(const [random,delay] of [[0,2000],[.5,5000],[.99999,8000]]) {
 const room=make();room.randomStart=true;startRound(room,1000,true,false,()=>random);
 assert.equal(room.goAt,1000+delay);assert.equal(nextDue(room),room.goAt);assert.equal(publicRoom(room).goAt,null);
 advance(room,room.goAt!-1);assert.equal(room.phase,'countdown');
 advance(room,room.goAt!);assert.equal(room.phase,'active');assert.equal(publicRoom(room).goAt,1000+delay);
}
const flying=make();flying.randomStart=true;startRound(flying,0,true,false,()=>0);press(flying,0,1999);assert.equal(flying.reason,'flying');
const normal=make();startRound(normal,0,true);assert.equal(normal.goAt,7000);startRound(normal,0,false);assert.equal(normal.goAt,4000);
