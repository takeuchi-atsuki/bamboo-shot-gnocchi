import React, { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../shared/game';
export function Chat({ messages, connected, send }: { messages: ChatMessage[]; connected: boolean; send: (command: object) => void }) {
  const [text, setText] = useState('');
  const [readyAt, setReadyAt] = useState(0);
  const [, tick] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { const timer = setInterval(() => tick(value => value + 1), 500); return () => clearInterval(timer); }, []);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [messages.length, messages.at(-1)?.id]);
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!connected || !text.trim() || Date.now() < readyAt) return;
    send({ type: 'chat', text }); setText(''); setReadyAt(Date.now() + 1000);
  }
  return <section className="panel chat-panel" aria-label="部屋のチャット">
    <h3>チャット</h3>
    <div className="chat-history" role="log" aria-live="polite">{messages.map(message => <p key={message.id}><strong>{message.name}</strong> <time>{new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><br />{message.text}</p>)}<div ref={end} /></div>
    <form className="card-form" onSubmit={submit} onKeyDown={event => event.stopPropagation()}><input aria-label="メッセージ" maxLength={200} value={text} onChange={event => setText(event.target.value)} placeholder="200文字まで・1秒に1回" /><button disabled={!connected || !text.trim() || Date.now() < readyAt}>送信</button></form>
  </section>;
}
