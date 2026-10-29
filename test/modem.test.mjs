// Modem kroz simulirani kanal: šum, pomak frekvencije, razlika takta zvučnih kartica, nasumična faza.
import assert from 'node:assert/strict';
import { modulate, Demodulator, BAUD_RATES, frameDuration } from '../js/modem.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function gauss(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run({ baud, freqOffset = 0, clockPpm = 0, noise = 0.05, seed = 1, leadMs = 0 }) {
  const rng = mulberry32(seed);
  const sr = 48000;
  const messages = ['RJ7>AB12 F 1 B7', 'AB12>RJ7 X 1 B7 S B5H3 W', 'RJ7>AB12 C bok, čuješ li me?'];
  const got = [];
  const demod = new Demodulator({ sampleRate: sr, baud, freq: 1500, onFrame: (p) => got.push(dec.decode(p)) });
  const chunks = [];
  const silence = (s) => chunks.push(new Float32Array(Math.floor(s * sr)));
  silence(0.3 + rng());
  for (const m of messages) {
    // Odašiljač radi na malo drugačijem taktu i frekvenciji od prijemnika.
    const txRate = sr * (1 + clockPpm * 1e-6);
    chunks.push(modulate(enc.encode(m), { sampleRate: txRate, baud, freq: 1500 + freqOffset, amplitude: 0.3, leadMs }));
    silence(0.2 + rng());
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const signal = new Float32Array(total);
  let pos = 0;
  for (const c of chunks) {
    signal.set(c, pos);
    pos += c.length;
  }
  for (let i = 0; i < total; i++) signal[i] += noise * gauss(rng);
  for (let i = 0; i < total; i += 128) demod.process(signal.subarray(i, i + 128));
  return { got, messages };
}

let failures = 0;
function check(name, opts) {
  const { got, messages } = run(opts);
  const ok = messages.every((m, i) => got[i] === m) && got.length === messages.length;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got.length}/${messages.length}`);
  if (!ok) {
    failures++;
    console.log('     got:', got);
  }
}

for (const baud of BAUD_RATES) {
  check(`${baud} Bd čisto`, { baud, noise: 0.001 });
  check(`${baud} Bd šum`, { baud, noise: 0.08, seed: 2 });
  check(`${baud} Bd +${(baud / 8).toFixed(1)} Hz pomak, 100 ppm takt`, { baud, freqOffset: baud / 8, clockPpm: 100, noise: 0.05, seed: 3 });
  check(`${baud} Bd -3 Hz, -200 ppm, VOX predtakt`, { baud, freqOffset: -3, clockPpm: -200, noise: 0.05, seed: 4, leadMs: 400 });
}

// Šum bez signala ne smije dati lažne okvire.
{
  const rng = mulberry32(9);
  let frames = 0;
  const demod = new Demodulator({ sampleRate: 48000, baud: 125, freq: 1500, onFrame: () => frames++ });
  const buf = new Float32Array(48000);
  for (let s = 0; s < 30; s++) {
    for (let i = 0; i < buf.length; i++) buf[i] = 0.2 * gauss(rng);
    demod.process(buf);
  }
  console.log(`${frames === 0 ? 'ok  ' : 'FAIL'} 30 s čistog šuma: ${frames} lažnih okvira`);
  if (frames) failures++;
}

assert.ok(Math.abs(frameDuration(20, { baud: 62.5 }) - (32 + 32 + 8 * 23 + 8 + 2) / 62.5) < 1e-9);
assert.equal(failures, 0, `${failures} modem testova palo`);
console.log('modem: sve u redu');
