import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { tone, speak, stopSpeech, unlockAudio } from "./audio";
import type { PublicRoom } from "../shared/game";
import "./style.css";
import { Chat } from "./chat";
import { Voice } from "./voice";
import { Stamps } from "./stamps";

type Identity = { code: string; memberId: string; token: string };
type ServerMessage = { type: "snapshot"; room: PublicRoom; serverNow: number };
const SAVED_CARDS = "nyokki:cards";
const identityKey = (code: string) => `nyokki:room:${code}`;

function savedCards(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SAVED_CARDS) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

function seatLabel(seat: number, room: PublicRoom): string {
  return room.players.find((player) => player.seat === seat)?.name ?? `CPU ${seat + 1}`;
}

function reasonLabel(reason: PublicRoom["reason"]): string {
  return ({ collision: "同時コール", last: "最後まで残った", flying: "フライング", timeout: "時間切れ" } as const)[reason ?? "timeout"];
}

function App() {
  const [inheritCards, setInheritCards] = useState(false);
  const [name, setName] = useState("");
  const [codeInput, setCodeInput] = useState(new URLSearchParams(location.search).get("room") ?? "");
  const [identity, setIdentity] = useState<Identity | null>(() => {
    const code = new URLSearchParams(location.search).get("room")?.toUpperCase();
    if (!code) return null;
    try { return JSON.parse(localStorage.getItem(identityKey(code)) ?? "null") as Identity | null; }
    catch { return null; }
  });
  const [room, setRoom] = useState<PublicRoom | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cardInput, setCardInput] = useState("");
  const [sound, setSound] = useState(true);
  const [clock, setClock] = useState(Date.now());
  const [offset, setOffset] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const lastAudioRef = useRef("");

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!identity) return;
    let disposed = false;
    let reconnectTimer: number | undefined;
    let attempts = 0;
    const connect = () => {
      if (disposed) return;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/api/rooms/${identity.code}/socket?token=${encodeURIComponent(identity.token)}`);
      socketRef.current = socket;
      socket.onopen = () => { attempts = 0; setConnected(true); setError(""); };
      socket.onmessage = (event) => {
        let data: ServerMessage;
        try { data = JSON.parse(event.data) as ServerMessage; } catch { return; }
        if ((data as { type: string }).type.startsWith("voice")) {
          window.dispatchEvent(new CustomEvent("nyokki-voice", { detail: data })); return;
        }
        if (data.type !== "snapshot") return;
        setOffset(data.serverNow - Date.now());
        setRoom(data.room);
        if (data.room.hostId === identity.memberId) {
          localStorage.setItem(SAVED_CARDS, JSON.stringify(data.room.cards.map((card) => card.text)));
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (disposed) return;
        attempts += 1;
        if (attempts >= 5) {
          setError("再接続できません。部屋が終了した可能性があります。参加画面に戻ってください。");
          return;
        }
        reconnectTimer = window.setTimeout(connect, Math.min(1000 * attempts, 5000));
      };
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [identity]);

  const me = room?.players.find((player) => player.id === identity?.memberId);
  const isHost = Boolean(me && room?.hostId === me.id);
  const shareUrl = room ? `${location.origin}/?room=${room.code}` : "";
  const remain = room?.goAt ? Math.max(0, Math.ceil((room.goAt - (clock + offset)) / 1000)) : 0;
  const pauseRemain = room?.pauseUntil ? Math.max(0, Math.ceil((room.pauseUntil - (clock + offset)) / 1000)) : 0;
  const alreadyCalled = Boolean(me && room && (room.safeCalls.some((call) => call.seat === me.seat) || room.pendingSeats.includes(me.seat)));
  const canCall = Boolean(connected && me && room && (room.phase === "countdown" || room.phase === "active") && !alreadyCalled);

  useEffect(() => {
    if (!room || !sound) return;
    const key = `${room.phase}:${room.round}:${room.safeCalls.length}:${room.reason ?? ""}`;
    if (key === lastAudioRef.current) return;
    lastAudioRef.current = key;
    if (room.phase === "countdown") {
      unlockAudio();
      speak(room.round === 1 ? "さあ、それではまいりましょう。たけのこ、たけのこ、ニョッキッキ！" : "たけのこ、たけのこ、ニョッキッキ！");
      tone(196, 0.22);
    } else if (room.phase === "active") {
      stopSpeech();
      const call = room.safeCalls.at(-1);
      if (call) {
        tone(392 + call.number * 45);
        speak(`${call.number}ニョッキ`);
      } else {
        tone(523, 0.2);
        speak("スタート！");
      }
    } else if (room.phase === "result" || room.phase === "finished") {
      tone(196, 0.28);
      speak(room.phase === "finished" ? "ドボン決定！" : "ドボン！");
    } else if (room.phase === "paused") {
      stopSpeech();
    }
  }, [room, sound]);

  useEffect(() => {
    if (import.meta.env.PROD && "serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  function send(command: object): void {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(command));
  }

  async function enter(mode: "create" | "join") {
    const clean = name.trim();
    if (!clean) { setError("名前を入力してください。"); return; }
    if (mode === "join" && !/^[A-Z2-9]{8}$/.test(codeInput.trim().toUpperCase())) {
      setError("8文字の部屋コードを入力してください。"); return;
    }
    setBusy(true); setError(""); unlockAudio();
    // Start speech while the user's tap is still active. Mobile browsers may
    // reject the first utterance if it comes later from a WebSocket event.
    if (sound) speak("音声の準備ができました");
    try {
      const url = mode === "create" ? "/api/rooms" : `/api/rooms/${codeInput.trim().toUpperCase()}/join`;
      const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "create" ? { name: clean, cards: inheritCards ? savedCards() : [] } : { name: clean }),
      });
      const data = await response.json() as Identity & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "参加できませんでした。");
      localStorage.setItem(identityKey(data.code), JSON.stringify(data));
      history.replaceState(null, "", `/?room=${data.code}`);
      setIdentity(data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "通信に失敗しました。"); }
    finally { setBusy(false); }
  }

  async function leaveView() {
    if (identity) {
      setBusy(true);
      try {
        const response = await fetch(`/api/rooms/${identity.code}/leave`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: identity.token }) });
        if (!response.ok && response.status !== 404 && response.status !== 403) throw new Error("退出できませんでした。もう一度お試しください。");
      } catch { setError("通信に失敗しました。再接続してから退出してください。"); setBusy(false); return; }
      localStorage.removeItem(identityKey(identity.code));
    }
    setBusy(false);
    history.replaceState(null, "", "/");
    setIdentity(null); setRoom(null); setConnected(false); setError("");
  }

  function addCard(event: React.FormEvent) {
    event.preventDefault();
    const text = cardInput.trim();
    if (text) { send({ type: "addCard", text }); setCardInput(""); }
  }

  if (!identity) return (
    <main className="landing">
      <div className="hero-art" aria-hidden="true"><span>🎍</span></div>
      <p className="eyebrow">みんなで、ドン！</p>
      <h1>たけのこ<br /><em>ニョッキ</em></h1>
      <p className="lead">離れていても、声をそろえて。<br />自分のタイミングで押して、ドボンを回避！</p>
      <section className="entry-card">
        <label>あなたの名前<input maxLength={20} value={name} onChange={(event) => setName(event.target.value)} placeholder="例：たけちゃん" /></label>
        <label><input type="checkbox" checked={inheritCards} onChange={(event) => setInheritCards(event.target.checked)} />保存したカードを引き継ぐ</label>
        <button className="text-button" onClick={() => { localStorage.removeItem(SAVED_CARDS); setInheritCards(false); setError("保存したカードを削除しました。"); }}>保存カードをリセット</button>
        <button className="primary" disabled={busy} onClick={() => void enter("create")}>新しい部屋をつくる <span>→</span></button>
        <div className="divider"><span>または</span></div>
        <label>部屋コード<input maxLength={8} value={codeInput} onChange={(event) => setCodeInput(event.target.value.toUpperCase())} placeholder="8文字のコード" /></label>
        <button className="secondary" disabled={busy} onClick={() => void enter("join")}>部屋に参加する</button>
        {error && <p className="error" role="alert">{error}</p>}
      </section>
      <p className="small-note">1〜6人で参加できます。空いた席にはCPUが入ります。</p>
    </main>
  );

  if (!room) return <main className="loading"><div className="spinner" /><p>部屋に接続しています…</p><button disabled={busy} onClick={() => void leaveView()}>参加画面に戻る</button></main>;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-icon">🎍</span><span>たけのこニョッキ</span></div>
        <div className="top-actions"><span className={`connection ${connected ? "online" : "offline"}`}>{connected ? "接続中" : "再接続中"}</span><button className="text-button" disabled={busy} onClick={() => void leaveView()}>退出</button></div>
      </header>

      <div className="content">
        <section className="room-info">
          <div><p className="eyebrow">ROOM CODE</p><h2>{room.code}</h2></div>
          <button className="share" onClick={() => void navigator.clipboard.writeText(shareUrl).then(() => setError("招待リンクをコピーしました。"), () => setError("リンクをコピーできませんでした。"))}>招待リンクをコピー ↗</button>
        </section>
        {error && <p className="notice" role="status">{error}</p>}

        <section className="stage">
          <div className="stage-label">ROUND {String(room.round).padStart(2, "0")}</div>
          {room.phase === "lobby" && <><h2>参加者を待っています</h2><p>友だちにリンクを送って、全員そろったらスタート！</p></>}
          {room.phase === "countdown" && <><h2>たけのこ たけのこ<br /><strong>ニョッキッキ！</strong></h2><div className="countdown">{remain}</div><p>合図より前に押すとフライング！</p></>}
          {room.phase === "active" && <><h2>いまだ！<strong>ニョッキ！</strong></h2><div className="call-number">{room.safeCalls.length + 1}<small>ニョッキ</small></div><p>同時に押したらドボン</p></>}
          {room.phase === "result" && <><h2>ドボン！</h2><p>{reasonLabel(room.reason)}</p><div className="result-names">{room.dobons.map((seat) => seatLabel(seat, room)).join("・")}</div></>}
          {room.phase === "finished" && <><h2>ドボン決定！</h2><p>今回の負けは…</p><div className="result-names">{room.losers.map((seat) => seatLabel(seat, room)).join("・")}</div></>}
          {room.phase === "paused" && <><h2>ちょっと待ってね</h2><p>誰かの接続が切れました。{room.pauseUntil ? `あと${pauseRemain}秒待機します。` : "作成者が再開方法を選びます。"}</p></>}
        </section>

        <section className="board-section">
          <div className="section-heading"><h3>プレイヤー</h3><span>{room.players.length}人参加 / 6席</span></div>
          <div className="board">
            {Array.from({ length: 6 }, (_, seat) => {
              const player = room.players.find((item) => item.seat === seat);
              const safe = room.safeCalls.find((call) => call.seat === seat);
              const isMe = seat === me?.seat;
              const dobong = room.dobons.includes(seat);
              return <div className={`seat ${isMe ? "mine" : ""} ${safe ? "safe" : ""} ${dobong ? "dobong" : ""}`} key={seat}>
                <div className="seat-top"><span className="seat-index">{seat + 1}</span><span>{player ? (player.disconnectedAt ? "離席中" : isMe ? "あなた" : "参加中") : "CPU"}</span></div>
                <div className="avatar" aria-hidden="true">{player ? "🌱" : "🤖"}</div>
                <strong>{seatLabel(seat, room)}</strong>
                <div className="lamps"><span className={safe ? "green-lamp lit" : "green-lamp"}>{safe ? `${safe.number} ニョッキ` : room.pendingSeats.includes(seat) ? "判定中" : "待機"}</span><span className="red-lamps">{Array.from({ length: Math.min(room.scores[seat], 3) }, () => "●").join("")}</span></div>
              </div>;
            })}
          </div>
        </section>

        {(room.phase === "countdown" || room.phase === "active") && <section className="action-zone">
          <button className="call-button" disabled={!canCall} onPointerDown={(event) => { event.preventDefault(); if (canCall) send({ type: "call" }); }} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && canCall) { event.preventDefault(); send({ type: "call" }); } }}>
            <span>{room.phase === "countdown" ? "まだ待って！" : alreadyCalled ? "コール済み" : "ニョッキ！"}</span><small>{room.phase === "countdown" ? "フライングに注意" : "押してコール"}</small>
          </button>
        </section>}

        {room.phase === "lobby" && <section className="panel">
          <label>同時コール判定<select disabled={!isHost} value={room.collisionMs ?? 500} onChange={(event) => send({ type: "setCollision", collisionMs: Number(event.target.value) })}><option value={200}>200ms</option><option value={300}>300ms</option><option value={500}>500ms（従来）</option></select></label>
          <div className="section-heading"><h3>ドボンカード</h3><span>全員で編集できます</span></div>
          <div className="mode-row"><span>罰ゲームありモード</span><button className={`toggle ${room.penaltyEnabled ? "on" : ""}`} disabled={!isHost} onClick={() => send({ type: "setMode", enabled: !room.penaltyEnabled })} aria-label="罰ゲームモード切替" aria-pressed={room.penaltyEnabled}><span /></button></div>
          <form className="card-form" onSubmit={addCard}><input maxLength={120} value={cardInput} onChange={(event) => setCardInput(event.target.value)} placeholder="カードの内容を入力" /><button type="submit">追加</button></form>
          {room.cards.length === 0 ? <p className="muted">カードはまだありません。</p> : <ul className="card-list">{room.cards.map((card) => <li key={card.id}><span>{card.text}</span><button onClick={() => send({ type: "deleteCard", id: card.id })} aria-label={`${card.text}を削除`}>×</button></li>)}</ul>}
          {isHost && <button className="primary start" disabled={!connected || room.players.some((player) => player.disconnectedAt) || (room.penaltyEnabled && room.cards.length === 0)} onClick={() => { unlockAudio(); send({ type: "start" }); }}>ゲームスタート <span>→</span></button>}
          {isHost && room.penaltyEnabled && room.cards.length === 0 && <p className="error">罰ゲームありの場合、カードを1枚以上追加してください。</p>}
          {isHost && room.players.some((player) => player.disconnectedAt) && <p className="error">接続が切れた参加者が戻るまでお待ちください。</p>}
          {!isHost && <p className="muted">作成者がスタートするのを待っています。</p>}
        </section>}

        {room.phase === "result" && <div className="bottom-panel">{isHost ? <button className="primary" onClick={() => send({ type: "next" })}>次のラウンドへ →</button> : <p>作成者が次のラウンドを始めます。</p>}</div>}
        {room.phase === "paused" && room.pauseUntil === null && isHost && <div className="bottom-panel"><button className="primary" onClick={() => send({ type: "resumeCpu" })}>離席した人をCPUにして再開</button><button className="secondary" onClick={() => send({ type: "abort" })}>対戦を終了する</button></div>}
        {room.phase === "finished" && <div className="bottom-panel">
          {room.penaltyEnabled && me && room.losers.includes(me.seat) && <div className="draw-panel">
            <h3>ドボンカードを引こう</h3>
            {room.draws[me.id] ? <><p className="drawn-card">{room.cards.find((card) => card.id === room.draws[me.id])?.text}</p><button className="secondary" disabled={room.cards.length < 2} onClick={() => send({ type: "redraw" })}>できないので引き直す</button>{room.cards.length < 2 && <p className="muted">別のカードがありません。</p>}</> : <button className="primary" onClick={() => send({ type: "draw" })}>カードを1枚引く</button>}
          </div>}
          {isHost && <button className="secondary" onClick={() => send({ type: "newGame" })}>同じメンバーでもう一度</button>}
        </div>}
        <Stamps stamps={room.stamps ?? []} connected={connected} serverNow={clock + offset} send={send} />
        <Voice members={room.players} memberId={identity.memberId} connected={connected} send={send} />
        <Chat messages={room.messages ?? []} connected={connected} send={send} />
        <div className="footer-row"><button className="sound-toggle" onClick={() => { unlockAudio(); lastAudioRef.current = ""; if (sound) stopSpeech(); else { tone(523, 0.15); speak("音声オン。スタート！"); } setSound(!sound); }}>{sound ? "🔊 音声オン" : "🔇 音声オフ"}</button><button className="sound-toggle" onClick={() => { unlockAudio(); tone(523, 0.15); speak("スタート！"); }} aria-label="音声をテスト">音声テスト</button><span>同時押し判定 {(room.collisionMs ?? 500) / 1000}秒</span></div>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
