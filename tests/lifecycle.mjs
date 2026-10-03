import assert from 'node:assert/strict';
const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:8787';
const post = async (path, body) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};
const host = (await post('/api/rooms', { name: 'host', cards: ['test'] })).data;
const guest = (await post(`/api/rooms/${host.code}/join`, { name: 'guest' })).data;
assert.equal((await post(`/api/rooms/${host.code}/leave`, { token: 'invalid' })).status, 403);
assert.equal((await post(`/api/rooms/${host.code}/leave`, { token: host.token })).status, 200);
assert.equal((await post(`/api/rooms/${host.code}/join`, { name: 'still alive' })).status, 200);
// A separate one-person room must disappear immediately after explicit leave.
const solo = (await post('/api/rooms', { name: 'solo' })).data;
assert.equal((await post(`/api/rooms/${solo.code}/leave`, { token: solo.token })).status, 200);
assert.equal((await post(`/api/rooms/${solo.code}/join`, { name: 'late' })).status, 404);
assert.equal((await post(`/api/rooms/${solo.code}/leave`, { token: solo.token })).status, 404);
await post(`/api/rooms/${host.code}/leave`, { token: guest.token });
console.log('Lifecycle integration passed: authenticated leave, remaining room, closed room.');
