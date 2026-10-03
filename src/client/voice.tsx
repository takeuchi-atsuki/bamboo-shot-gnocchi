import React, { useEffect, useRef, useState } from 'react';
import type { PublicRoom } from '../shared/game';
type Send = (command: object) => void;
type Peer = { pc: RTCPeerConnection; sender: RTCRtpSender; audio: HTMLAudioElement; candidates: RTCIceCandidateInit[]; queue: Promise<void> };
export class VoiceSession {
  peers = new Map<string, Peer>();
  stream: MediaStream | null = null;
  disposed = false;
  needsOffer = new Set<string>();
  muted = false;
  volume = 1;
  constructor(public id: string, private send: Send, private report: (message: string) => void) {}
  async enable(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (this.disposed) { stream.getTracks().forEach(track => track.stop()); return; }
    stream.getTracks().forEach(track => { track.enabled = false; });
    this.stream = stream;
    await Promise.all([...this.peers.values()].map(peer => peer.sender.replaceTrack(stream.getAudioTracks()[0])));
    for (const id of this.peers.keys()) { if (this.id < id) this.offer(id); else this.send({ type: "voiceSignal", target: id, signal: { renegotiate: true } }); }
    void this.unlock();
  }
  async unlock() { await Promise.all([...this.peers.values()].filter(peer => peer.audio.srcObject).map(peer => peer.audio.play().catch(() => this.report('音声受信を開始するには「受信開始」を押してください。')))); }
  talking(enabled: boolean) {
    this.stream?.getTracks().forEach(track => { track.enabled = enabled; });
    this.send({ type: 'voiceState', enabled: enabled && Boolean(this.stream) });
  }
  peer(id: string): Peer {
    const existing = this.peers.get(id); if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const audio = document.createElement('audio'); audio.autoplay = true; audio.setAttribute('playsinline', ''); audio.muted = this.muted; audio.volume = this.volume;
    document.body.appendChild(audio);
    const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const peer: Peer = { pc, sender: transceiver.sender, audio, candidates: [], queue: Promise.resolve() };
    this.peers.set(id, peer);
    if (this.stream) void peer.sender.replaceTrack(this.stream.getAudioTracks()[0]);
    pc.onicecandidate = event => { if (event.candidate) this.send({ type: 'voiceSignal', target: id, signal: { candidate: event.candidate.toJSON() } }); };
    pc.ontrack = event => { audio.srcObject = new MediaStream([event.track]); void audio.play().catch(() => this.report('「受信開始」を押すと音声を聞けます。')); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') this.report('音声が接続できません。ネットワークを変えるか、再接続してください。'); };
    return peer;
  }
  sync(ids: string[]) {
    for (const [id, peer] of this.peers) if (!ids.includes(id)) { peer.pc.close(); peer.audio.remove(); this.peers.delete(id); }
    for (const id of ids) if (id !== this.id && !this.peers.has(id)) { this.peer(id); if (this.id < id) this.offer(id); }
  }
  offer(id: string) {
    const peer = this.peer(id);
    peer.queue = peer.queue.then(async () => {
      if (this.disposed || peer.pc.signalingState === "closed") return;
      if (peer.pc.signalingState !== "stable") { this.needsOffer.add(id); return; }
      const offer = await peer.pc.createOffer(); await peer.pc.setLocalDescription(offer);
      this.send({ type: 'voiceSignal', target: id, signal: { description: peer.pc.localDescription } });
    }).catch(() => this.report('音声接続に失敗しました。'));
  }
  reset(id: string) {
    const peer = this.peers.get(id); if (peer) { peer.pc.close(); peer.audio.remove(); this.peers.delete(id); }
    this.peer(id); if (this.id < id) this.offer(id);
  }
  signal(id: string, signal: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; renegotiate?: boolean }) {
    if (signal.renegotiate) { if (this.id < id) this.offer(id); return; }
    const peer = this.peer(id);
    peer.queue = peer.queue.then(async () => {
      if (this.disposed) return;
      if (signal.description) {
        await peer.pc.setRemoteDescription(signal.description);
        for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
        if (signal.description.type === 'offer') {
          await peer.pc.setLocalDescription(await peer.pc.createAnswer());
          this.send({ type: 'voiceSignal', target: id, signal: { description: peer.pc.localDescription } });
        }
        if (this.needsOffer.delete(id)) queueMicrotask(() => this.offer(id));
      } else if (signal.candidate) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(signal.candidate); else peer.candidates.push(signal.candidate);
      }
    }).catch(() => this.report('音声接続に失敗しました。'));
  }
  playback(muted: boolean, volume: number) { this.muted = muted; this.volume = volume; for (const peer of this.peers.values()) { peer.audio.muted = muted; peer.audio.volume = volume; } }
  dispose() { this.talking(false); this.disposed = true; this.stream?.getTracks().forEach(track => track.stop()); for (const peer of this.peers.values()) { peer.pc.close(); peer.audio.remove(); } this.peers.clear(); }
}
export function Voice({ members, memberId, connected, send }: { members: PublicRoom['players']; memberId: string; connected: boolean; send: Send }) {
  const [enabled, setEnabled] = useState(false), [talking, setTalking] = useState(false), [notice, setNotice] = useState(''), [speakers, setSpeakers] = useState<string[]>([]), [muted, setMuted] = useState(false), [volume, setVolume] = useState(1);
  const session = useRef<VoiceSession | null>(null);
  const memberIds = useRef<string[]>([]); memberIds.current = members.filter(member => !member.disconnectedAt).map(member => member.id);
  const stop = () => { session.current?.talking(false); setTalking(false); };
  useEffect(() => {
    if (!connected || !('RTCPeerConnection' in window)) return;
    const current = new VoiceSession(memberId, send, setNotice); session.current = current;
    const receive = (event: Event) => {
      const data = (event as CustomEvent).detail;
      if (data.from === memberId || !memberIds.current.includes(data.from)) return;
      if (data.type === 'voiceSignal') current.signal(data.from, data.signal);
      if (data.type === 'voiceReset') current.reset(data.from);
      if (data.type === 'voiceState') setSpeakers(previous => data.talking ? [...new Set([...previous, data.from])] : previous.filter(id => id !== data.from));
    };
    window.addEventListener('nyokki-voice', receive);
    current.sync(memberIds.current); send({ type: 'voiceReady' });
    return () => { window.removeEventListener('nyokki-voice', receive); current.dispose(); session.current = null; setEnabled(false); setTalking(false); setSpeakers([]); };
  }, [connected, memberId]);
  useEffect(() => { session.current?.sync(memberIds.current); setSpeakers(previous => previous.filter(id => memberIds.current.includes(id))); }, [members.map(member => `${member.id}:${member.disconnectedAt ?? ''}`).join(',')]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) stop(); };
    window.addEventListener('blur', stop); document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('blur', stop); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  useEffect(() => { session.current?.playback(muted, volume); }, [muted, volume, connected]);
  async function enable() {
    if (!navigator.mediaDevices?.getUserMedia || !session.current) { setNotice('マイクはHTTPSの対応ブラウザーで利用できます。'); return; }
    const current = session.current;
    try { await current.enable(); if (!current.disposed) { setEnabled(true); setNotice('押している間だけ送信します。'); } }
    catch { setNotice('マイクを利用できません。音声なしでゲームを続けられます。'); }
  }
  function start() { if (enabled && connected && session.current) { session.current.talking(true); setTalking(true); } }
  return <section className="panel" aria-label="ボイスチャット"><h3>ボイスチャット</h3>
    {!enabled ? <button className="secondary" disabled={!connected} onClick={() => void enable()}>マイクを有効にする</button> : <button className="secondary" disabled={!connected} aria-pressed={talking} onPointerDown={event => { if(event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); start(); }} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); start(); } }} onKeyUp={event => { if(event.key === ' ' || event.key === 'Enter') { event.preventDefault(); stop(); } }} onBlur={stop}>{talking ? '🎙️ 送信中' : '押して話す'}</button>}
    <button onClick={() => void session.current?.unlock()}>受信開始</button><label><input type="checkbox" checked={muted} onChange={event => setMuted(event.target.checked)} />受信ミュート</label><label>音量<input aria-label="ボイス音量" type="range" min="0" max="1" step="0.1" value={volume} onChange={event => setVolume(Number(event.target.value))} /></label>
    <p role="status">{notice}</p><p aria-live="polite">{speakers.filter(id => members.some(member => member.id === id && !member.disconnectedAt)).map(id => members.find(member => member.id === id)?.name).join('・')}{speakers.length ? ' が発言中' : ''}</p>
  </section>;
}
