// Protokol igre preko poludupleksnog kanala. Svaka poruka je jedan PSK okvir s tekstom
// "OD>ZA NAREDBA argumenti":
//   CQ                 tražim igru (ZA = *)
//   R <nonce> <0|1>    spreman; 1 = već znam tvoj nonce. Veći nonce puca prvi.
//   F <seq> <polje>    pucanj, npr. "F 3 B7"
//   X <seq> <polje> <M|H|S> [brod] [W]   rezultat; S nosi potopljeni brod ("B5H3"), W = kraj igre
//   N                  nova igra
//   C <tekst>          poruka (chat)
// Pogodak znači da strijelac puca ponovno. Pucanj bez odgovora ponavlja se s istim seq-om,
// a branitelj na ponovljeni seq šalje spremljeni odgovor umjesto da ga ponovno obradi.

import { Fleet, Target, coordName, parseCoord, parseShipSpec, shipSpec } from './game.js';

export const CALL_RE = /^[A-Z0-9/]{1,10}$/;

export function encodeMessage(from, to, cmd, args = []) {
  return [`${from}>${to}`, cmd, ...args].join(' ');
}

export function parseMessage(text) {
  const m = /^([A-Z0-9/]{1,10})>([A-Z0-9/]{1,10}|\*) ([A-Z]{1,2})(?: ([\s\S]*))?$/.exec(text);
  if (!m) return null;
  const [, from, to, cmd, rest = ''] = m;
  return { from, to, cmd, rest, args: rest ? rest.split(' ') : [] };
}

export class Session {
  constructor({
    me = '',
    opponent = '',
    transport,
    onUpdate = () => {},
    onEvent = () => {},
    replyTimeoutMs = () => 10000,
    maxTries = 5,
    readyRetryMs = [15000, 30000, 60000],
  }) {
    Object.assign(this, { me, opponent, transport, onUpdate, onEvent, replyTimeoutMs, maxTries, readyRetryMs });
    this.fleet = new Fleet();
    this.reset();
  }

  reset() {
    clearTimeout(this.readyTimer);
    clearTimeout(this.replyTimer);
    this.state = 'placing'; // placing | waiting | myTurn | aiming | theirTurn | won | lost
    this.target = new Target();
    this.fleet.resetHits();
    this.nonce = 0;
    this.oppNonce = null;
    this.seq = 0;
    this.lastInSeq = null;
    this.lastReply = null;
    this.pending = null;
    this.readyTries = 0;
    this.onUpdate();
  }

  // isCurrent: transport ga provjerava neposredno prije odašiljanja, pa ponavljanje
  // koje je u redu čekalo dok je odgovor stizao ne ode u eter.
  send(cmd, args = [], to = this.opponent, isCurrent = null) {
    const text = encodeMessage(this.me, to, cmd, args);
    return Promise.resolve()
      .then(() => this.transport(text, isCurrent))
      .catch((err) => this.onEvent('error', String(err?.message || err)));
  }

  announce() {
    if (!this.me) return this.onEvent('error', 'Upiši svoj pozivni znak');
    return this.send('CQ', [], '*');
  }

  chat(text) {
    if (!this.me || !this.opponent) return this.onEvent('error', 'Upiši svoj i protivnikov pozivni znak');
    return this.send('C', [text]);
  }

  newGame() {
    this.reset();
    if (this.me && this.opponent) this.send('N');
  }

  ready() {
    if (this.state !== 'placing') return;
    if (!this.fleet.complete) return this.onEvent('error', 'Postavi sve brodove');
    if (!this.me || !this.opponent) return this.onEvent('error', 'Upiši svoj i protivnikov pozivni znak');
    this.nonce = 1 + Math.floor(Math.random() * 9998);
    this.state = 'waiting';
    this.readyTries = 0;
    this.onUpdate();
    this.sendReady();
    this.maybeStart();
  }

  async sendReady(isCurrent = null) {
    await this.send('R', [String(this.nonce), this.oppNonce == null ? '0' : '1'], this.opponent, isCurrent);
    this.scheduleReadyRetry();
  }

  // Dok ne čujemo protivnika ponavljamo R sve rjeđe; ako je izgubljen, protivnik ne bi znao da smo spremni.
  scheduleReadyRetry() {
    clearTimeout(this.readyTimer);
    if (this.state !== 'waiting' || this.oppNonce != null) return;
    const ms = this.readyRetryMs[Math.min(this.readyTries, this.readyRetryMs.length - 1)];
    this.readyTimer = setTimeout(() => {
      if (this.state !== 'waiting' || this.oppNonce != null) return;
      this.readyTries++;
      this.sendReady(() => this.state === 'waiting' && this.oppNonce == null);
    }, ms);
  }

  maybeStart() {
    if (this.state !== 'waiting' || this.oppNonce == null) return;
    clearTimeout(this.readyTimer);
    const meFirst = this.nonce !== this.oppNonce ? this.nonce > this.oppNonce : this.me < this.opponent;
    this.state = meFirst ? 'myTurn' : 'theirTurn';
    this.onEvent('start', { meFirst });
    this.onUpdate();
  }

  fire(r, c) {
    if (this.state !== 'myTurn' || this.target.get(r, c)) return false;
    this.seq++;
    this.pending = { seq: this.seq, coord: coordName(r, c), tries: 0 };
    this.state = 'aiming';
    this.onUpdate();
    this.sendFire();
    return true;
  }

  async sendFire() {
    const p = this.pending;
    if (!p) return;
    clearTimeout(this.replyTimer);
    p.tries++;
    await this.send('F', [String(p.seq), p.coord], this.opponent, () => this.pending === p);
    if (this.pending !== p) return;
    // Odbrojavanje kreće tek kad smo završili s odašiljanjem.
    this.replyTimer = setTimeout(() => {
      if (this.pending !== p) return;
      if (p.tries < this.maxTries) {
        this.onEvent('retry', { coord: p.coord, tries: p.tries });
        this.sendFire();
      } else {
        this.onEvent('timeout', { coord: p.coord });
        this.onUpdate();
      }
    }, this.replyTimeoutMs());
  }

  // Ručno ponavljanje zadnje poruke koja čeka odgovor.
  retry() {
    if (this.state === 'aiming' && this.pending) {
      this.pending.tries = 0;
      this.sendFire();
    } else if (this.state === 'waiting') {
      this.sendReady();
    }
  }

  receive(text) {
    const msg = parseMessage(text);
    if (!msg) return this.onEvent('garbage', text);
    if (msg.from === this.me) return;
    if (msg.cmd === 'CQ') return this.onEvent('cq', msg.from);
    if (msg.to !== this.me) return this.onEvent('overheard', msg);
    if (!this.opponent) {
      this.opponent = msg.from;
      this.onEvent('opponent', msg.from);
    }
    if (msg.from !== this.opponent) return this.onEvent('stranger', msg);
    switch (msg.cmd) {
      case 'R':
        return this.onReady(msg.args);
      case 'F':
        return this.onFire(msg);
      case 'X':
        return this.onResult(msg);
      case 'N':
        this.reset();
        return this.onEvent('newGame', msg.from);
      case 'C':
        return this.onEvent('chat', { from: msg.from, text: msg.rest });
      default:
        return this.onEvent('unexpected', msg);
    }
  }

  onReady(args) {
    const nonce = parseInt(args[0], 10);
    if (!(nonce > 0)) return;
    this.oppNonce = nonce;
    this.onEvent('oppReady', this.opponent);
    // Protivnik još ne zna naš nonce: odgovori, i usred igre ako mu se prvi R izgubio.
    if (this.state !== 'placing' && args[1] !== '1') this.send('R', [String(this.nonce), '1']);
    this.maybeStart();
    this.onUpdate();
  }

  onFire(msg) {
    const seq = parseInt(msg.args[0], 10);
    const pos = parseCoord(msg.args[1]);
    if (!pos || !(seq > 0)) return this.onEvent('unexpected', msg);
    if (seq === this.lastInSeq && this.lastReply) {
      this.send('X', this.lastReply);
      return;
    }
    // Pucanj dok čekamo znači da je protivnik dobio naš R, a njegov odgovor se izgubio.
    if (this.state === 'waiting') {
      clearTimeout(this.readyTimer);
      this.state = 'theirTurn';
      this.onEvent('start', { meFirst: false });
    }
    if (this.state !== 'theirTurn') return this.onEvent('unexpected', msg);
    const res = this.fleet.receiveShot(pos.r, pos.c);
    const reply = [String(seq), msg.args[1], res.result];
    if (res.result === 'S') reply.push(shipSpec(res.ship));
    if (res.allSunk) reply.push('W');
    this.lastInSeq = seq;
    this.lastReply = reply;
    this.state = res.allSunk ? 'lost' : res.result === 'M' ? 'myTurn' : 'theirTurn';
    this.onEvent('incoming', { coord: msg.args[1], ...res });
    this.onUpdate();
    this.send('X', reply);
  }

  onResult(msg) {
    const [seqText, coord, result, ...rest] = msg.args;
    const p = this.pending;
    // Zakašnjeli duplikat ili odgovor na nešto što više ne čekamo.
    if (this.state !== 'aiming' || !p || p.seq !== parseInt(seqText, 10) || p.coord !== coord) return;
    if (!['M', 'H', 'S'].includes(result)) return this.onEvent('unexpected', msg);
    clearTimeout(this.replyTimer);
    this.pending = null;
    const { r, c } = parseCoord(coord);
    const ship = result === 'S' ? parseShipSpec(rest[0]) : null;
    if (ship) this.target.markSunk(ship);
    else this.target.set(r, c, result === 'M' ? 'M' : 'H');
    const won = rest.includes('W');
    this.state = won ? 'won' : result === 'M' ? 'theirTurn' : 'myTurn';
    this.onEvent('result', { coord, result, won });
    this.onUpdate();
  }
}
