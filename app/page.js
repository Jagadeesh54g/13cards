'use client';
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const FACE = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
const face = (r) => FACE[r] || r;

const store = {
  get: () => { try { return JSON.parse(localStorage.getItem('r13') || '{}'); } catch { return {}; } },
  set: (v) => localStorage.setItem('r13', JSON.stringify({ ...store.get(), ...v })),
};
const pid = () => {
  let p = store.get().pid;
  if (!p) { p = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set({ pid: p }); }
  return p;
};

function Card({ c, wild, sel, back, tiny, glow, onClick }) {
  const cls = `${tiny ? ' tiny' : ''}${glow ? ' glow' : ''}`;
  if (back) return <div className={`card back${cls}`} onClick={onClick} />;
  return (
    <div className={`card${'HD'.includes(c.suit) ? ' red' : ''}${sel ? ' sel' : ''}${cls}`} onClick={onClick}>
      <b>{face(c.rank)}</b><i>{SYM[c.suit]}</i><u>{SYM[c.suit]}</u>
      {wild && <em>W</em>}
    </div>
  );
}

// group cards of the same number together
const autoGroups = (hand) => {
  const m = {};
  [...hand].sort((a, b) => a.rank - b.rank).forEach((c) => (m[c.rank] = m[c.rank] || []).push(c.id));
  return Object.values(m);
};

// place opponents on an arc across the top of the table
const seatPos = (i, m) => {
  const t = (Math.PI * (i + 1)) / (m + 1);
  return { left: `${50 - 42 * Math.cos(t)}%`, top: `${4 + 34 * (1 - Math.sin(t))}%` };
};

export default function Page() {
  const sock = useRef(null);
  const round = useRef(-1);
  const [st, setSt] = useState(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [layout, setLayout] = useState([]);
  const [sel, setSel] = useState([]);

  useEffect(() => {
    setName(store.get().name || '');
    const s = io();
    sock.current = s;
    s.on('connect', () => {
      const saved = store.get();
      if (saved.code) {
        s.emit('join', { code: saved.code, name: saved.name, playerId: pid() }, (r) => {
          if (!r.ok) { store.set({ code: '' }); setSt(null); }
        });
      }
    });
    s.on('state', setSt);
    return () => s.disconnect();
  }, []);

  // keep my local grouping in sync with the hand the server sends
  useEffect(() => {
    if (!st) return;
    const ids = new Set(st.hand.map((c) => c.id));
    setSel((x) => x.filter((i) => ids.has(i)));
    setLayout((prev) => {
      if (round.current !== st.round || !prev.length) { round.current = st.round; return autoGroups(st.hand); }
      const kept = prev.map((g) => g.filter((i) => ids.has(i))).filter((g) => g.length);
      const have = new Set(kept.flat());
      const fresh = st.hand.filter((c) => !have.has(c.id)).map((c) => c.id);
      return fresh.length ? [...kept, fresh] : kept;
    });
  }, [st]);

  const emit = (ev, data) => sock.current.emit(ev, data, (r) => r && !r.ok && setErr(r.error));
  const join = (create) => {
    const n = name.trim() || 'Player';
    sock.current.emit('join', { create, code, name: n, playerId: pid() }, (r) => {
      if (!r.ok) return setErr(r.error);
      setErr('');
      store.set({ name: n, code: r.code });
    });
  };
  const leave = () => { store.set({ code: '' }); location.reload(); };
  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const group = (to) => {
    if (!sel.length) return;
    setLayout((l) => {
      const n = l.map((g) => g.filter((i) => !sel.includes(i)));
      if (to == null) n.push(sel); else n[to] = [...n[to], ...sel];
      return n.filter((g) => g.length);
    });
    setSel([]);
  };

  if (!st) {
    return (
      <main className="home">
        <h1>13 <span>Cards</span></h1>
        <p>Make a room and send the code to your friends.</p>
        <input placeholder="Your name" value={name} maxLength={14} onChange={(e) => setName(e.target.value)} />
        <button className="gold" onClick={() => join(true)}>Create room</button>
        <div className="row">
          <input placeholder="CODE" value={code} maxLength={4} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          <button onClick={() => join(false)}>Join</button>
        </div>
        {err && <p className="err">{err}</p>}
      </main>
    );
  }

  const host = st.host === st.you;

  if (st.phase === 'lobby') {
    return (
      <main className="home">
        <h1>Room <span>{st.code}</span></h1>
        <p>Share this code with your friends.</p>
        <ul>{st.players.map((p) => <li key={p.id} className={p.on ? '' : 'off'}>{p.name}{p.id === st.host ? ' (host)' : ''}</li>)}</ul>
        {host
          ? <button className="gold" disabled={st.players.filter((p) => p.on).length < 2} onClick={() => emit('start')}>Start game</button>
          : <p>Waiting for the host to start…</p>}
        <button className="ghost" onClick={leave}>Leave</button>
      </main>
    );
  }

  const w = st.wild ? st.wild.rank : null;
  const isW = (c) => w !== null && c.rank === w;
  const by = Object.fromEntries(st.hand.map((c) => [c.id, c]));
  const mine = st.turn === st.you && st.phase === 'playing';
  const one = mine && st.drawn && sel.length === 1;
  const turnName = st.players.find((p) => p.id === st.turn)?.name;
  const canDraw = mine && !st.drawn;
  const me = st.players.findIndex((p) => p.id === st.you);
  const others = [...st.players.slice(me + 1), ...st.players.slice(0, me)];
  const board = [...st.players].sort((a, b) => b.wins - a.wins);
  const hint = st.phase === 'finished' ? '' : mine
    ? (st.drawn ? 'Select one card, then tap Discard or the discard pile to pass your turn' : 'Your turn: draw from the stock or the discard pile')
    : `Waiting for ${turnName}…`;

  return (
    <main className="table">
      <header>
        <span className="room">Room {st.code} · Round {st.round}</span>
        <div className="board">
          {board.map((p) => <span key={p.id} className="chip">{p.name} <b>{p.wins}</b></span>)}
        </div>
        <button className="ghost" onClick={leave}>Leave</button>
      </header>

      <section className="arena">
        {others.map((p, i) => (
          <div key={p.id} className={`seat${p.id === st.turn ? ' turn' : ''}${p.on ? '' : ' off'}`} style={seatPos(i, others.length)}>
            <div className="fan">{Array.from({ length: Math.min(p.n, 14) }).map((_, k) => <Card key={k} back tiny />)}</div>
            <span className="tag">{p.name} · {p.n}</span>
          </div>
        ))}

        <div className="mid">
          <div className="pile">
            {w ? <Card c={st.wild} wild /> : <Card back />}
            <small>{w ? `All ${face(w)}s are wild` : 'Joker (hidden)'}</small>
          </div>
          <div className="pile">
            <Card back glow={canDraw} onClick={() => canDraw && emit('draw', 'stock')} />
            <small>Draw ({st.stock})</small>
          </div>
          <div className="pile">
            {st.top && (
              <Card
                c={st.top}
                wild={isW(st.top)}
                glow={canDraw || one}
                onClick={() => {
                  if (canDraw) emit('draw', 'discard');
                  else if (one) { emit('discard', sel[0]); setSel([]); }
                }}
              />
            )}
            <small>{st.dBy ? `${st.dBy} discarded` : 'Discard'}</small>
          </div>
        </div>
      </section>

      <p className={`hint${mine ? ' mine' : ''}`}>{hint}</p>
      {err && <p className="err" onClick={() => setErr('')}>{err}</p>}

      <section className={`hand${mine ? ' turn' : ''}`}>
        {layout.map((g, gi) => (
          <div key={gi} className="group">
            <div className="cards">
              {g.map((id) => by[id] && <Card key={id} c={by[id]} wild={isW(by[id])} sel={sel.includes(id)} onClick={() => toggle(id)} />)}
            </div>
            {sel.length > 0 && <button className="mini" onClick={() => group(gi)}>Add here</button>}
          </div>
        ))}
      </section>

      <footer className="bar">
        <button disabled={!sel.length} onClick={() => group(null)}>Group selected</button>
        <button onClick={() => setLayout(autoGroups(st.hand))}>Sort</button>
        <button disabled={!one} onClick={() => { emit('discard', sel[0]); setSel([]); }}>Discard</button>
        <button
          className="gold"
          disabled={!one}
          onClick={() => emit('declare', { fin: sel[0], groups: layout.map((g) => g.filter((i) => i !== sel[0])).filter((g) => g.length) })}
        >
          Declare
        </button>
      </footer>

      {st.phase === 'finished' && st.result && (
        <div className="modal">
          <div className="box">
            <h2>{st.result.winner} won this round</h2>
            {host ? <button className="gold" onClick={() => emit('start')}>Next round</button> : <p>Waiting for the host…</p>}
          </div>
        </div>
      )}
    </main>
  );
}