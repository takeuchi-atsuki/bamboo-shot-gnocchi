// Run with a locally installed Playwright: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/voice-browser.mjs
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:8787';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', args: ['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'] });
async function client() {
 const context=await browser.newContext(); const page=await context.newPage();
 await page.addInitScript(()=>{
  window.testStreams=[];window.testPeers=[];window.testSockets=[];
  const ws=window.WebSocket;window.WebSocket=class extends ws {constructor(...args){super(...args);window.testSockets.push(this);}};
  const rtc=window.RTCPeerConnection;window.RTCPeerConnection=class extends rtc { constructor(...args){super(...args);window.testPeers.push(this);} };
  const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async(...args)=>{const stream=await original(...args);window.testStreams.push(stream);return stream;};
 });
 page.on("pageerror",error=>console.log("PAGE ERROR",error.message));
 await page.goto(base); return page;
}
try {
 const host=await client(); await host.getByLabel('あなたの名前').fill('host'); await host.getByRole('button',{name:/新しい部屋/}).click();
 const code=await host.locator('.room-info h2').innerText();
 const guest=await client();await guest.getByLabel('あなたの名前').fill('guest');await guest.getByLabel('部屋コード').fill(code);await guest.getByRole('button',{name:'部屋に参加する',exact:true}).click();
 await host.getByRole('button',{name:'マイクを有効にする'}).click(); await guest.getByRole('button',{name:'マイクを有効にする'}).click();
 await host.getByRole('button',{name:'押して話す'}).waitFor();
 await guest.getByRole('button',{name:'押して話す'}).waitFor();
 if (!process.env.SKIP_AUDIO_TRANSPORT) for(const page of [host,guest]) await page.waitForFunction(()=>window.testPeers.some(pc=>pc.connectionState==='connected'));
 assert.equal(await host.evaluate(()=>window.testStreams.at(-1).getAudioTracks()[0].enabled),false);
 const button=host.getByRole('button',{name:'押して話す'});await button.focus();await host.keyboard.down('Space');
 assert.equal(await host.evaluate(()=>window.testStreams.at(-1).getAudioTracks()[0].enabled),true);
 await guest.getByText('host が発言中',{exact:true}).waitFor();
 await host.keyboard.up('Space');assert.equal(await host.evaluate(()=>window.testStreams.at(-1).getAudioTracks()[0].enabled),false);
 await button.focus();await host.keyboard.down('Space');await host.evaluate(()=>window.dispatchEvent(new Event('blur')));
 assert.equal(await host.evaluate(()=>window.testStreams.at(-1).getAudioTracks()[0].enabled),false);await host.keyboard.up('Space');
 const packets=await guest.evaluate(async()=>{let count=0;for(const pc of window.testPeers) for(const stat of (await pc.getStats()).values()) if(stat.type==='inbound-rtp'&&stat.kind==='audio') count+=stat.packetsReceived;return count;});
 if (!process.env.SKIP_AUDIO_TRANSPORT) assert.ok(packets>0,'peer received real audio RTP packets');
 await host.getByRole('button',{name:'退出',exact:true}).click();await host.waitForFunction(()=>window.testStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));
 await guest.evaluate(()=>window.testSockets.at(-1).close());
 await guest.waitForFunction(()=>window.testStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));
 const denied=await client(); await denied.evaluate(()=>{ navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied','NotAllowedError');}; });
 await denied.getByLabel('あなたの名前').fill('denied'); await denied.getByRole('button',{name:/新しい部屋/}).click(); await denied.getByRole('button',{name:'マイクを有効にする'}).click(); await denied.getByText('マイクを利用できません。音声なしでゲームを続けられます。',{exact:true}).waitFor(); assert.equal(await denied.getByRole('button',{name:/ゲームスタート/}).isEnabled(),true);
 console.log('Voice browser passed: PTT release, blur, microphone cleanup. Audio transport: ' + (process.env.SKIP_AUDIO_TRANSPORT ? 'not tested (environment WebRTC UDP policy)' : 'real RTP packets received'));
} finally {await browser.close();}
