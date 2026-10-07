const { createServer } = require('http');
const next = require('next');
const { Server } = require('socket.io');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

// ---------- rules ----------
// 13 cards. Make a four of a kind -> the hidden joker is revealed to you and
// every card of its rank becomes wild. Close with one group of 4 + three groups of 3.
const deck = (k) => {
  const d = [];
  for (let j = 0; j < k; j++) for (const s of 'SHDC') for (let r = 1; r <= 13; r++) d.push({ id: `${j}${s}${r}`, suit: s, rank: r });
  return d;
};
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
// a group is valid if every non-joker card has the same rank (suits don't matter)
const okSet = (g, w) => {
  const n = g.filter((c) => c.rank !== w);
  return n.every((c) => c.rank === n[0].rank);
};
// unlock the joker once the hand holds four cards of the same rank
const unlock = (p) => {
  if (p.u) return;
  const cnt = {};
  for (const c of p.hand) cnt[c.rank] = (cnt[c.rank] || 0) + 1;
  if (Object.values(cnt).some((n) => n >= 4)) p.u = true;
};

// ---------- server ----------
const rooms = new Map();

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res));
  const io = new Server(server);

  const view = (r, p) => ({
    code: r.code, phase: r.phase, round: r.round, host: r.host, you: p.id,
    players: r.players.map((q) => ({ id: q.id, name: q.name, on: q.on, n: q.hand.length, wins: q.wins })),
    turn: r.phase === 'playing' ? r.players[r.turn].id : null,
    drawn: r.drawn, wild: p.u ? r.joker : null, stock: r.stock.length,
    top: r.disc[r.disc.length - 1] || null, dBy: r.dBy, hand: p.hand, result: r.result,
  });
  const push = (r) => r.players.forEach((p) => p.sid && io.to(p.sid).emit('state', view(r, p)));
  const adv = (r) => {
    r.turn = (r.turn + 1) % r.players.length;
    for (let k = 0; k < r.players.length && !r.players[r.turn].on; k++) r.turn = (r.turn + 1) % r.players.length;
  };
  const deal = (r) => {
    r.players = r.players.filter((p) => p.on);
    const n = r.players.length;
    const d = shuffle(deck(Math.ceil((n * 13 + 20) / 52))); // add decks as needed
    r.players.forEach((p) => { p.hand = d.splice(0, 13); p.u = false; unlock(p); });
    r.joker = d.pop(); // hidden joker card
    r.disc = [d.pop()];
    r.stock = d;
    r.dBy = '';
    r.round++;
    r.turn = (r.round - 1) % n;
    r.drawn = false; r.phase = 'playing'; r.result = null;
  };

  io.on('connection', (s) => {
    const get = () => {
      const r = rooms.get(s.data.code);
      const p = r && r.players.find((q) => q.id === s.data.pid);
      return p ? [r, p] : [];
    };
    const myTurn = (r, p) => r.phase === 'playing' && r.players[r.turn] === p;

    s.on('join', ({ create, code, name, playerId } = {}, ack) => {
      name = String(name || '').trim().slice(0, 14) || 'Player';
      playerId = String(playerId || '').slice(0, 40);
      if (!playerId) return ack({ ok: false, error: 'Missing player id' });
      let r;
      if (create) {
        do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join(''); } while (rooms.has(code));
        r = { code, host: playerId, phase: 'lobby', round: 0, players: [], stock: [], disc: [], drawn: false, turn: 0, dBy: '' };
        rooms.set(code, r);
      } else r = rooms.get(String(code || '').toUpperCase());
      if (!r) return ack({ ok: false, error: 'Room not found' });
      let p = r.players.find((q) => q.id === playerId);
      if (!p) {
        if (r.phase !== 'lobby') return ack({ ok: false, error: 'That game already started' });
        if (r.players.length >= 8) return ack({ ok: false, error: 'Room is full (max 8)' });
        p = { id: playerId, name, hand: [], u: false, wins: 0 };
        r.players.push(p);
      }
      Object.assign(p, { sid: s.id, on: true });
      s.data = { code: r.code, pid: playerId };
      ack({ ok: true, code: r.code });
      push(r);
    });

    s.on('start', () => {
      const [r, p] = get();
      if (!r || r.host !== p.id || r.phase === 'playing' || r.players.filter((q) => q.on).length < 2) return;
      deal(r);
      push(r);
    });

    s.on('draw', (from) => {
      const [r, p] = get();
      if (!r || !myTurn(r, p) || r.drawn) return;
      if (from === 'discard') p.hand.push(r.disc.pop());
      else {
        // stock empty: reshuffle the ground pile, keep its top card visible
        if (!r.stock.length) { const top = r.disc.pop(); r.stock = shuffle(r.disc); r.disc = [top]; }
        if (!r.stock.length) return;
        p.hand.push(r.stock.pop());
      }
      unlock(p);
      r.drawn = true;
      push(r);
    });

    s.on('discard', (id) => {
      const [r, p] = get();
      if (!r || !myTurn(r, p) || !r.drawn) return;
      const i = p.hand.findIndex((c) => c.id === id);
      if (i < 0) return;
      r.disc.push(...p.hand.splice(i, 1));
      r.dBy = p.name;
      r.drawn = false;
      adv(r);
      push(r);
    });

    s.on('declare', ({ fin, groups } = {}, ack) => {
      const [r, p] = get();
      if (!r || !myTurn(r, p) || !r.drawn) return ack({ ok: false, error: 'Draw a card first' });
      if (!p.u) return ack({ ok: false, error: 'Make a four of a kind first to reveal the joker' });
      const by = new Map(p.hand.map((c) => [c.id, c]));
      const shape = Array.isArray(groups) && groups.every(Array.isArray);
      const ids = shape ? groups.flat() : [];
      if (!shape || !by.has(fin) || ids.length !== 13 || new Set(ids).size !== 13 || ids.includes(fin) || !ids.every((i) => by.has(i)))
        return ack({ ok: false, error: 'Put all 13 cards in groups and pick one card to finish with' });
      if (groups.map((g) => g.length).sort().join('') !== '3334')
        return ack({ ok: false, error: 'You need one group of 4 and three groups of 3' });
      const w = r.joker.rank;
      if (!groups.every((g) => okSet(g.map((i) => by.get(i)), w)))
        return ack({ ok: false, error: 'Every group must be the same number (jokers can fill in)' });
      p.hand = p.hand.filter((c) => c.id !== fin);
      p.wins++;
      r.phase = 'finished';
      r.result = { winner: p.name };
      push(r);
    });

    s.on('disconnect', () => {
      const [r, p] = get();
      if (!r || p.sid !== s.id) return;
      p.on = false; p.sid = null;
      if (myTurn(r, p)) {
        if (r.drawn) { r.disc.push(p.hand.pop()); r.drawn = false; }
        adv(r);
      }
      push(r);
    });
  });

  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`Ready on http://localhost:${port}`));
});
