// Pravila i ploče potapanja brodova (10×10, brodovi se ne smiju dodirivati ni dijagonalno).

export const SIZE = 10;
export const ROWS = 'ABCDEFGHIJ';
export const FLEET = [
  { len: 5, name: 'Nosač aviona' },
  { len: 4, name: 'Bojni brod' },
  { len: 3, name: 'Krstarica' },
  { len: 3, name: 'Podmornica' },
  { len: 2, name: 'Razarač' },
];

export const coordName = (r, c) => ROWS[r] + (c + 1);

export function parseCoord(s) {
  const m = /^([A-J])(10|[1-9])$/.exec(s || '');
  return m ? { r: ROWS.indexOf(m[1]), c: Number(m[2]) - 1 } : null;
}

export function shipCells({ r, c, vertical, len }) {
  return Array.from({ length: len }, (_, k) => (vertical ? { r: r + k, c } : { r, c: c + k }));
}

// Potopljeni brod u poruci: početno polje, smjer, duljina — npr. "B5H3".
export const shipSpec = (s) => coordName(s.r, s.c) + (s.vertical ? 'V' : 'H') + s.len;

export function parseShipSpec(s) {
  const m = /^([A-J](?:10|[1-9]))([HV])([1-5])$/.exec(s || '');
  if (!m) return null;
  const ship = { ...parseCoord(m[1]), vertical: m[2] === 'V', len: Number(m[3]) };
  return shipCells(ship).every(({ r, c }) => r < SIZE && c < SIZE) ? ship : null;
}

const key = (r, c) => r * SIZE + c;

export class Fleet {
  constructor() {
    this.ships = FLEET.map((s) => ({ ...s, r: -1, c: -1, vertical: false, placed: false, hits: new Set() }));
    this.shots = new Set();
  }

  get complete() {
    return this.ships.every((s) => s.placed);
  }

  get allSunk() {
    return this.ships.every((s) => s.hits.size === s.len);
  }

  get afloat() {
    return this.ships.filter((s) => s.hits.size < s.len).length;
  }

  shipIndexAt(r, c) {
    return this.ships.findIndex((s) => s.placed && shipCells(s).some((p) => p.r === r && p.c === c));
  }

  canPlace(i, r, c, vertical) {
    const cells = shipCells({ r, c, vertical, len: this.ships[i].len });
    if (cells.some((p) => p.r < 0 || p.c < 0 || p.r >= SIZE || p.c >= SIZE)) return false;
    return this.ships.every(
      (s, j) =>
        j === i ||
        !s.placed ||
        shipCells(s).every((q) => cells.every((p) => Math.abs(p.r - q.r) > 1 || Math.abs(p.c - q.c) > 1)),
    );
  }

  place(i, r, c, vertical) {
    if (!this.canPlace(i, r, c, vertical)) return false;
    Object.assign(this.ships[i], { r, c, vertical, placed: true });
    return true;
  }

  remove(i) {
    this.ships[i].placed = false;
  }

  clear() {
    for (const s of this.ships) s.placed = false;
  }

  randomize(rng = Math.random) {
    for (let attempt = 0; attempt < 100; attempt++) {
      this.clear();
      const ok = this.ships.every((_, i) => {
        for (let t = 0; t < 500; t++) {
          if (this.place(i, Math.floor(rng() * SIZE), Math.floor(rng() * SIZE), rng() < 0.5)) return true;
        }
        return false;
      });
      if (ok) return;
    }
    throw new Error('Nasumično postavljanje nije uspjelo');
  }

  resetHits() {
    for (const s of this.ships) s.hits.clear();
    this.shots.clear();
  }

  receiveShot(r, c) {
    this.shots.add(key(r, c));
    const i = this.shipIndexAt(r, c);
    if (i < 0) return { result: 'M' };
    const ship = this.ships[i];
    ship.hits.add(key(r, c));
    const sunk = ship.hits.size === ship.len;
    return { result: sunk ? 'S' : 'H', ship, allSunk: this.allSunk };
  }

  wasShot(r, c) {
    return this.shots.has(key(r, c));
  }
}

// Što znamo o protivničkoj ploči: '' nepoznato, M promašaj, H pogodak, S potopljeno,
// m more zaključeno oko potopljenog broda (brodovi se ne dodiruju).
export class Target {
  constructor() {
    this.cells = new Array(SIZE * SIZE).fill('');
    this.sunk = 0;
  }

  get(r, c) {
    return this.cells[key(r, c)];
  }

  set(r, c, v) {
    this.cells[key(r, c)] = v;
  }

  markSunk(ship) {
    const cells = shipCells(ship);
    for (const { r, c } of cells) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && cc >= 0 && rr < SIZE && cc < SIZE && !this.get(rr, cc)) this.set(rr, cc, 'm');
        }
      }
    }
    for (const { r, c } of cells) this.set(r, c, 'S');
    this.sunk++;
  }

  count(v) {
    return this.cells.filter((x) => x === v).length;
  }
}
