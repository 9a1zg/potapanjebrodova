// PSK modem: diferencijalni BPSK u stilu PSK31 (0 = obrat faze, 1 = bez promjene),
// kosinusno oblikovana anvelopa, okviri sa sinkro riječi, duljinom i CRC-16.
// Čisti JS bez DOM-a, pa ga koriste i preglednik i Node testovi.

export const SYNC_WORD = 0x1acffc1d; // CCSDS ASM, dobra autokorelacija
export const MAX_PAYLOAD = 96;
export const BAUD_RATES = [31.25, 62.5, 125];

const PREAMBLE_SYMBOLS = 32;
const TAIL_SYMBOLS = 8;
const SPS = 16; // uzoraka po simbolu nakon decimacije

export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function pushBits(bits, value, n) {
  for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function preambleSymbols(baud, leadMs) {
  return PREAMBLE_SYMBOLS + Math.ceil((leadMs / 1000) * baud);
}

export function frameBits(payload, preamble = PREAMBLE_SYMBOLS) {
  if (payload.length < 1 || payload.length > MAX_PAYLOAD) throw new Error(`Poruka mora imati 1–${MAX_PAYLOAD} bajtova`);
  const bits = new Array(preamble).fill(0);
  pushBits(bits, SYNC_WORD, 32);
  const body = [payload.length, ...payload];
  for (const b of body) pushBits(bits, b, 8);
  pushBits(bits, crc16(body), 16);
  for (let i = 0; i < TAIL_SYMBOLS; i++) bits.push(0);
  return bits;
}

// Trajanje odašiljanja u sekundama (uspon + predtakt + okvir + spuštanje).
export function frameDuration(payloadLength, { baud, leadMs = 0 }) {
  const symbols = preambleSymbols(baud, leadMs) + 32 + 8 * (payloadLength + 3) + TAIL_SYMBOLS + 2;
  return symbols / baud;
}

// leadMs produžuje preambulu da VOX stigne uključiti predajnik prije sinkro riječi.
export function modulate(payload, { sampleRate, baud, freq, amplitude = 0.5, leadMs = 0 }) {
  const bits = frameBits(payload, preambleSymbols(baud, leadMs));
  // Razine na granicama simbola: 0 → +1 (uspon), bitovi, → 0 (spuštanje).
  const levels = new Float64Array(bits.length + 3);
  levels[1] = 1;
  for (let k = 0; k < bits.length; k++) levels[k + 2] = bits[k] ? levels[k + 1] : -levels[k + 1];
  const nsym = levels.length - 1;
  const total = Math.ceil((nsym * sampleRate) / baud);
  const out = new Float32Array(total);
  const w = (2 * Math.PI * freq) / sampleRate;
  for (let n = 0; n < total; n++) {
    const t = (n * baud) / sampleRate;
    const k = Math.min(Math.floor(t), nsym - 1);
    const a = levels[k];
    const b = levels[k + 1];
    const env = a + ((b - a) * (1 - Math.cos(Math.PI * (t - k)))) / 2;
    out[n] = amplitude * env * Math.cos(w * n);
  }
  return out;
}

// RBJ niskopropusni biquad.
class Biquad {
  constructor(fc, fs, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * fc) / fs;
    const alpha = Math.sin(w) / (2 * q);
    const cw = Math.cos(w);
    const a0 = 1 + alpha;
    this.b0 = (1 - cw) / 2 / a0;
    this.b1 = (1 - cw) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
    this.z1 = 0;
    this.z2 = 0;
  }
  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

function popcount(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

const wrapBins = (x) => ((((x + SPS / 2) % SPS) + SPS) % SPS) - SPS / 2;
const BIN_COS = Array.from({ length: SPS }, (_, k) => Math.cos((2 * Math.PI * k) / SPS));
const BIN_SIN = Array.from({ length: SPS }, (_, k) => Math.sin((2 * Math.PI * k) / SPS));
const HANN = (() => {
  const w = Array.from({ length: SPS }, (_, k) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (k + 0.5)) / SPS));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / sum);
})();

const HUNT = 0;
const LEN = 1;
const BODY = 2;

// Prijemnik: miješanje na osnovni pojas, NP filtar, decimacija na 16 uzoraka/simbolu,
// sinkronizacija takta po energiji, diferencijalna detekcija, AFC i traženje okvira.
export class Demodulator {
  constructor({ sampleRate, baud, freq, afc = true, onFrame = () => {}, onBadFrame = () => {} }) {
    this.sampleRate = sampleRate;
    this.afc = afc;
    this.onFrame = onFrame;
    this.onBadFrame = onBadFrame;
    this.configure(baud, freq);
  }

  configure(baud, freq) {
    this.baud = baud;
    this.freq = freq;
    this.afcOffset = 0;
    this.ph = 0;
    const fc = 2 * baud;
    this.filters = [0, 1, 2, 3].map(() => new Biquad(fc, this.sampleRate));
    this.decStep = (SPS * baud) / this.sampleRate;
    this.decAcc = 0;
    this.ringI = new Float64Array(SPS);
    this.ringQ = new Float64Array(SPS);
    this.ringPos = 0;
    this.bins = new Float64Array(SPS);
    this.n = 0;
    this.countdown = SPS;
    this.tAcc = 0;
    this.prevI = 0;
    this.prevQ = 0;
    this.quality = 0;
    this.resetFrame();
  }

  setFreq(freq) {
    this.freq = freq;
    this.afcOffset = 0;
  }

  get rxFreq() {
    return this.freq + this.afcOffset;
  }

  // Ima li signala (kvaliteta faze), za prikaz i za "slušaj prije odašiljanja".
  get dcd() {
    return this.quality > 0.6;
  }

  get busy() {
    return this.dcd || this.fstate !== HUNT;
  }

  resetFrame() {
    this.fstate = HUNT;
    this.reg = 0;
    this.acc = 0;
    this.nbits = 0;
    this.bytes = [];
    this.len = 0;
  }

  process(samples) {
    const [fi1, fi2, fq1, fq2] = this.filters;
    const twoPi = 2 * Math.PI;
    const dph = (twoPi * (this.freq + this.afcOffset)) / this.sampleRate;
    for (let n = 0; n < samples.length; n++) {
      const x = samples[n];
      this.ph += dph;
      if (this.ph > twoPi) this.ph -= twoPi;
      const i = fi2.run(fi1.run(x * Math.cos(this.ph)));
      const q = fq2.run(fq1.run(-x * Math.sin(this.ph)));
      this.decAcc += this.decStep;
      if (this.decAcc >= 1) {
        this.decAcc -= 1;
        this.decimated(i, q);
      }
    }
  }

  decimated(i, q) {
    this.ringI[this.ringPos] = i;
    this.ringQ[this.ringPos] = q;
    this.ringPos = (this.ringPos + 1) % SPS;
    let yi = 0;
    let yq = 0;
    for (let k = 0; k < SPS; k++) {
      const idx = (this.ringPos + k) % SPS;
      yi += HANN[k] * this.ringI[idx];
      yq += HANN[k] * this.ringQ[idx];
    }
    const bin = this.n % SPS;
    this.n++;
    this.bins[bin] += (yi * yi + yq * yq - this.bins[bin]) * 0.1;
    if (--this.countdown > 0) return;

    // Vršak energije (kružna sredina po fazama simbola) je trenutak uzorkovanja.
    let c = 0;
    let s = 0;
    for (let k = 0; k < SPS; k++) {
      c += this.bins[k] * BIN_COS[k];
      s += this.bins[k] * BIN_SIN[k];
    }
    const peak = (Math.atan2(s, c) * SPS) / (2 * Math.PI);
    this.tAcc += 0.3 * wrapBins(peak - bin);
    const corr = Math.max(-2, Math.min(2, Math.round(this.tAcc)));
    this.tAcc -= corr;
    this.countdown = SPS + corr;
    this.symbol(yi, yq);
  }

  symbol(yi, yq) {
    const dr = yi * this.prevI + yq * this.prevQ;
    const di = yq * this.prevI - yi * this.prevQ;
    this.prevI = yi;
    this.prevQ = yq;
    const r2 = dr * dr - di * di;
    const mag = dr * dr + di * di;
    this.quality += ((mag > 0 ? r2 / mag : 0) - this.quality) * 0.1;
    if (this.afc && this.quality > 0.5) {
      // Kvadriranje uklanja modulaciju; ostatak kuta je pomak faze po simbolu.
      const ang = Math.atan2(2 * dr * di, r2) / 2;
      const limit = this.baud / 4;
      this.afcOffset = Math.max(-limit, Math.min(limit, this.afcOffset + (0.05 * ang * this.baud) / (2 * Math.PI)));
    }
    this.bit(dr > 0 ? 1 : 0);
  }

  bit(b) {
    if (this.fstate === HUNT) {
      this.reg = ((this.reg << 1) | b) >>> 0;
      if (popcount((this.reg ^ SYNC_WORD) >>> 0) <= 2) {
        this.fstate = LEN;
        this.acc = 0;
        this.nbits = 0;
      }
      return;
    }
    this.acc = (this.acc << 1) | b;
    if (++this.nbits < 8) return;
    const byte = this.acc & 0xff;
    this.acc = 0;
    this.nbits = 0;
    if (this.fstate === LEN) {
      if (byte === 0 || byte > MAX_PAYLOAD) return this.resetFrame();
      this.len = byte;
      this.bytes = [byte];
      this.fstate = BODY;
      return;
    }
    this.bytes.push(byte);
    if (this.bytes.length < this.len + 3) return;
    const body = this.bytes.slice(0, this.len + 1);
    const crc = (this.bytes[this.len + 1] << 8) | this.bytes[this.len + 2];
    const payload = Uint8Array.from(body.slice(1));
    const info = { freq: this.rxFreq, quality: this.quality };
    this.resetFrame();
    if (crc16(body) === crc) this.onFrame(payload, info);
    else this.onBadFrame(payload, info);
  }
}
