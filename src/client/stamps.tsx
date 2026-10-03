import React, { useState } from 'react';
import { STAMPS, type PublicRoom } from '../shared/game';
const icons = ['😎','👀','🌱','👏','💥','🎍'];
export function Stamps({ stamps, connected, serverNow, send }: { stamps: PublicRoom['stamps']; connected: boolean; serverNow: number; send: (command: object) => void }) {
  const [readyAt, setReadyAt] = useState(0);
  return <section className="panel stamp-panel" aria-label="スタンプ"><h3>スタンプ</h3>
    <div className="stamp-buttons">{STAMPS.map((text,index) => <button key={text} disabled={!connected || Date.now()<readyAt} onClick={() => { send({type:'stamp',text}); setReadyAt(Date.now()+2000); }}>{icons[index]} {text}</button>)}</div>
    <div className="stamp-feed" role="log" aria-live="polite">{stamps.filter(stamp => stamp.at + 4000 > serverNow).slice(-3).map(stamp => <p key={stamp.id}><strong>{stamp.name}</strong>：{stamp.text}</p>)}</div>
  </section>;
}
