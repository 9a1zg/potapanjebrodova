// Dvije sesije igraju cijelu igru preko kanala koji gubi poruke.
import assert from 'node:assert/strict';
import { Session, parseMessage, encodeMessage } from '../js/session.js';
import { Fleet, SIZE } from '../js/game.js';

assert.deepEqual(parseMessage('RJ7>AB12 X 3 B10 S B8H3 W').args, ['3', 'B10', 'S', 'B8H3', 'W']);
assert.equal(parseMessage('RJ7>AB12 C bok, kako si?').rest, 'bok, kako si?');
assert.equal(parseMessage('rj7>AB12 F 1 A1'), null);
assert.equal(encodeMessage('A', '*', 'CQ'), 'A>* CQ');

{
  const f = new Fleet();
  for (let i = 0; i < 200; i++) f.randomize();
  assert.ok(f.complete);
  const g = new Fleet();
  assert.ok(g.place(4, 0, 0, false));
  assert.ok(!g.place(3, 1, 2, false), 'dijagonalni dodir mora biti zabranjen');
  assert.ok(g.place(3, 2, 0, false));
  assert.ok(!g.place(0, 0, 6, false), 'brod ne smije izaći iz ploče');
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function play(loss, seed) {
  const rng = mulberry32(seed);
  const sessions = {};
  let sent = 0;
  let lost = 0;
  const transport = (from) => (text) =>
    new Promise((resolve) =>
      setTimeout(() => {
        sent++;
        const to = from === 'A' ? 'B' : 'A';
        if (rng() < loss) lost++;
        else sessions[to].receive(text);
        resolve();
      }, 1),
    );
  const done = new Promise((resolve) => {
    const make = (me, opponent) =>
      new Session({
        me,
        opponent,
        transport: transport(me),
        replyTimeoutMs: () => 20,
        maxTries: 50,
        readyRetryMs: [20],
        onUpdate: () => {
          const s = sessions[me];
          if (!s) return;
          if (s.state === 'won' || s.state === 'lost') setTimeout(resolve, 100);
          if (s.state === 'myTurn') {
            // Strijelac gađa prvo nepoznato polje nasumično.
            setTimeout(() => {
              if (s.state !== 'myTurn') return;
              const free = [];
              for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (!s.target.get(r, c)) free.push([r, c]);
              const [r, c] = free[Math.floor(rng() * free.length)];
              s.fire(r, c);
            }, 0);
          }
        },
      });
    sessions.A = make('A', 'B');
    sessions.B = make('B', 'A');
  });
  sessions.A.fleet.randomize(rng);
  sessions.B.fleet.randomize(rng);
  sessions.A.ready();
  setTimeout(() => sessions.B.ready(), 5);
  return done.then(() => ({ ...sessions, sent, lost }));
}

for (const [loss, seed] of [[0, 1], [0.2, 2], [0.35, 3], [0.35, 4]]) {
  const { A, B, sent, lost } = await play(loss, seed);
  const states = [A.state, B.state].sort().join('/');
  assert.equal(states, 'lost/won', `gubitak ${loss}: stanja ${A.state}/${B.state}`);
  const winner = A.state === 'won' ? A : B;
  const loser = winner === A ? B : A;
  assert.ok(loser.fleet.allSunk);
  assert.equal(winner.target.count('S'), 17);
  console.log(`ok   gubitak ${loss * 100}%: ${sent} poruka, izgubljeno ${lost}, pobjednik ${winner.me}`);
}
console.log('sesija: sve u redu');
process.exit(0);
