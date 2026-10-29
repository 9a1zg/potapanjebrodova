import { modulate, Demodulator, frameDuration } from './modem.js';
import { Session, CALL_RE } from './session.js';
import { AudioIO, VirtualChannel, listDevices } from './audio.js';
import { spectrumDb } from './fft.js';
import { SIZE, ROWS, parseCoord, shipCells } from './game.js';

const $ = (sel) => document.querySelector(sel);
const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- postavke ----------

const DEFAULTS = {
  me: '',
  opponent: '',
  channel: 'audio',
  inputId: '',
  outputId: '',
  baud: 62.5,
  freq: 1500,
  level: 0.5,
  voxLeadMs: 400,
  turnDelayMs: 800,
  afc: true,
  noise: 0.02,
};
const NUMERIC = new Set(['baud', 'freq', 'level', 'voxLeadMs', 'turnDelayMs', 'noise']);

const settings = (() => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('potapanje-psk') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
})();

function saveSettings() {
  try {
    localStorage.setItem('potapanje-psk', JSON.stringify(settings));
  } catch {
    /* privatni prozor: postavke vrijede samo do zatvaranja */
  }
}

// ---------- dnevnik ----------

const TAGS = { tx: 'TX', rx: 'RX', err: '!!', info: '··', chat: '>>' };

function log(cls, text, action) {
  const el = $('#log');
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  const line = document.createElement('div');
  line.className = cls;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = `${new Date().toLocaleTimeString('hr-HR')} ${TAGS[cls]} `;
  line.append(t, text);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.style.marginLeft = '8px';
    b.onclick = action.run;
    line.append(b);
  }
  el.append(line);
  while (el.childElementCount > 400) el.firstElementChild.remove();
  if (stick) el.scrollTop = el.scrollHeight;
}

// ---------- modem i odašiljanje ----------

let io = null;
let demod = null;
let starting = null;
let txActive = false;
let muteUntil = 0;
let lastRxActivity = 0;
let txQueue = Promise.resolve();

async function startModem() {
  if (io) return;
  if (!starting) {
    starting = (async () => {
      const next = settings.channel === 'virtual' ? new VirtualChannel(handleSamples) : new AudioIO(handleSamples);
      next.noise = settings.noise;
      await next.start({ inputId: settings.inputId, outputId: settings.outputId });
      demod = new Demodulator({
        sampleRate: next.sampleRate,
        baud: settings.baud,
        freq: settings.freq,
        afc: settings.afc,
        onFrame,
        onBadFrame: (_, info) => log('err', `oštećen okvir (CRC) na ${info.freq.toFixed(0)} Hz`),
      });
      io = next;
      $('#btn-start').textContent = 'Ponovno pokreni';
      $('#modem-info').textContent = `${next.sampleRate} Hz · ${settings.channel === 'virtual' ? 'virtualni kanal' : 'zvučna kartica'}`;
      log('info', 'Modem radi.');
      if (next instanceof AudioIO) fillDevices();
    })().finally(() => (starting = null));
  }
  try {
    await starting;
  } catch (e) {
    log('err', `Modem se nije pokrenuo: ${e.message}`);
    throw e;
  }
}

async function stopModem() {
  const old = io;
  io = null;
  demod = null;
  await old?.stop();
}

async function restartModem() {
  if (!io) return;
  await stopModem();
  await startModem();
}

function handleSamples(samples) {
  feedWaterfall(samples);
  if (!demod) return;
  // Za vrijeme vlastitog odašiljanja (i malo poslije, dok radio prebacuje) prijemnik dobiva tišinu.
  const muted = txActive || performance.now() < muteUntil;
  demod.process(muted ? new Float32Array(samples.length) : samples);
  if (!muted && demod.busy) lastRxActivity = performance.now();
}

function onFrame(payload, info) {
  lastRxActivity = performance.now();
  const text = dec.decode(payload);
  log('rx', `${text}   (${info.freq.toFixed(1)} Hz)`);
  session.receive(text);
}

function transmit(text, isCurrent) {
  const job = txQueue.then(async () => {
    await startModem();
    // Slušaj prije odašiljanja: ne upadaj u tuđi okvir i pričekaj da protivnikov VOX otpusti.
    const t0 = performance.now();
    while (performance.now() - t0 < 20000) {
      if (demod && !demod.busy && performance.now() - lastRxActivity >= settings.turnDelayMs) break;
      await sleep(50);
    }
    if (isCurrent && !isCurrent()) return;
    const samples = modulate(enc.encode(text), {
      sampleRate: io.sampleRate,
      baud: settings.baud,
      freq: settings.freq,
      amplitude: settings.level,
      leadMs: settings.channel === 'virtual' ? 0 : settings.voxLeadMs,
    });
    log('tx', text);
    txActive = true;
    try {
      await io.play(samples);
    } finally {
      txActive = false;
      muteUntil = performance.now() + 250;
    }
  });
  txQueue = job.catch(() => {});
  return job;
}

// Odgovor stiže nakon protivnikove pauze i njegovog najdužeg okvira; uz rezervu za VOX i obradu.
function replyTimeoutMs() {
  const frame = frameDuration(40, { baud: settings.baud, leadMs: settings.voxLeadMs });
  return Math.round((frame + settings.turnDelayMs / 1000) * 1300 + 4000);
}

// ---------- igra ----------

let selected = 0;
let vertical = false;
let hover = null;
let lastIncoming = null;
let renderQueued = false;

const RESULT_TEXT = { M: 'promašaj', H: 'pogodak', S: 'potopljen!' };

const session = new Session({
  me: settings.me,
  opponent: settings.opponent,
  transport: transmit,
  replyTimeoutMs,
  onUpdate: () => scheduleRender(),
  onEvent(type, data) {
    switch (type) {
      case 'error':
        return log('err', data);
      case 'start':
        return log('info', data.meFirst ? 'Igra počinje — ti pucaš prvi!' : 'Igra počinje — protivnik puca prvi.');
      case 'oppReady':
        return log('info', `${data} je spreman.`);
      case 'cq':
        return log('info', `${data} traži igru.`, session.opponent === data ? null : { label: `Igraj s ${data}`, run: () => setOpponent(data) });
      case 'opponent':
        setOpponent(data);
        return log('info', `Protivnik je ${data}.`);
      case 'stranger':
      case 'overheard':
        return log('info', `(čujem ${data.from} → ${data.to}, nije za nas)`);
      case 'garbage':
        return log('err', `nepoznata poruka: ${data}`);
      case 'incoming':
        lastIncoming = parseCoord(data.coord);
        return log('info', `Protivnik gađa ${data.coord}: ${RESULT_TEXT[data.result]}${data.allSunk ? ' Sva flota je potopljena.' : ''}`);
      case 'result':
        return log('info', `${data.coord}: ${RESULT_TEXT[data.result]}${data.won ? ' POBJEDA!' : ''}`);
      case 'retry':
        return log('info', `Nema odgovora na ${data.coord}, ponavljam (${data.tries + 1}.)`);
      case 'timeout':
        return log('err', `Nema odgovora na ${data.coord}. Klikni „Ponovi” kad je veza bolja.`);
      case 'newGame':
        lastIncoming = null;
        return log('info', `${data} je započeo novu igru. Brodovi su ostali; klikni „Spreman”.`);
      case 'chat':
        return log('chat', `${data.from}: ${data.text}`);
      case 'unexpected':
        return log('err', `neočekivana poruka: ${data.cmd} ${data.rest}`);
    }
  },
});

function setOpponent(call) {
  settings.opponent = call;
  session.opponent = call;
  $('[data-setting="opponent"]').value = call;
  saveSettings();
  scheduleRender();
}

// ---------- ploče ----------

function buildBoard(el, onCell) {
  const cells = [];
  el.append(document.createElement('span'));
  for (let c = 0; c < SIZE; c++) {
    const l = document.createElement('span');
    l.className = 'label';
    l.textContent = c + 1;
    el.append(l);
  }
  for (let r = 0; r < SIZE; r++) {
    const l = document.createElement('span');
    l.className = 'label';
    l.textContent = ROWS[r];
    el.append(l);
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      el.append(cell);
      cells.push(cell);
    }
  }
  const at = (e) => {
    const cell = e.target.closest('.cell');
    return cell ? { r: Number(cell.dataset.r), c: Number(cell.dataset.c) } : null;
  };
  for (const [ev, fn] of Object.entries(onCell)) el.addEventListener(ev, (e) => fn(at(e), e));
  return cells;
}

const myCells = buildBoard($('#my-board'), {
  mousemove: (p) => {
    if (session.state !== 'placing') return;
    if (p?.r !== hover?.r || p?.c !== hover?.c) {
      hover = p;
      scheduleRender();
    }
  },
  mouseleave: () => {
    hover = null;
    scheduleRender();
  },
  click: (p) => {
    if (!p || session.state !== 'placing') return;
    const fleet = session.fleet;
    const i = fleet.shipIndexAt(p.r, p.c);
    if (i >= 0) {
      // Klik na postavljeni brod podiže ga za premještanje.
      selected = i;
      vertical = fleet.ships[i].vertical;
      fleet.remove(i);
    } else if (selected != null && fleet.place(selected, p.r, p.c, vertical)) {
      const next = fleet.ships.findIndex((s) => !s.placed);
      selected = next >= 0 ? next : null;
    }
    scheduleRender();
  },
  contextmenu: (p, e) => {
    if (session.state !== 'placing') return;
    e.preventDefault();
    rotate();
  },
});

const oppCells = buildBoard($('#opp-board'), {
  click: (p) => {
    if (p && session.state === 'myTurn') session.fire(p.r, p.c);
  },
});

function rotate() {
  vertical = !vertical;
  scheduleRender();
}

function renderShipList() {
  const list = $('#ship-list');
  list.replaceChildren(
    ...session.fleet.ships.map((s, i) => {
      const b = document.createElement('span');
      b.className = `ship-item${s.placed ? ' placed' : ''}${i === selected ? ' selected' : ''}`;
      b.textContent = `${s.name} (${s.len})`;
      b.onclick = () => {
        if (session.state !== 'placing') return;
        if (s.placed) session.fleet.remove(i);
        selected = i;
        scheduleRender();
      };
      return b;
    }),
  );
}

const STATUS = {
  placing: () => (session.fleet.complete ? 'Flota je postavljena — klikni „Spreman”.' : 'Postavi brodove (desni klik ili R okreće).'),
  waiting: () => `Spreman si. Čekam ${session.opponent || 'protivnika'}…`,
  myTurn: () => 'Tvoj potez — gađaj protivničku ploču.',
  aiming: () => `Pucano na ${session.pending?.coord ?? '?'}, čekam odgovor…`,
  theirTurn: () => `${session.opponent} gađa…`,
  won: () => 'POBJEDA! Sva protivnička flota je potopljena.',
  lost: () => 'Poraz — tvoja flota je potopljena.',
};

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const { fleet, target, state } = session;
  const placing = state === 'placing';

  const preview = new Map();
  if (placing && hover && selected != null) {
    const ok = fleet.canPlace(selected, hover.r, hover.c, vertical);
    for (const p of shipCells({ ...hover, vertical, len: fleet.ships[selected].len })) {
      if (p.r < SIZE && p.c < SIZE) preview.set(p.r * SIZE + p.c, ok);
    }
  }
  myCells.forEach((cell, k) => {
    const r = Math.floor(k / SIZE);
    const c = k % SIZE;
    const ship = fleet.shipIndexAt(r, c) >= 0;
    const shot = fleet.wasShot(r, c);
    cell.className = 'cell';
    if (ship) cell.classList.add('ship');
    if (shot) cell.classList.add(ship ? 'hit' : 'miss');
    if (preview.has(k)) cell.classList.add('preview', ...(preview.get(k) ? [] : ['bad']));
    if (lastIncoming && lastIncoming.r === r && lastIncoming.c === c) cell.classList.add('last');
  });

  const pending = session.pending ? parseCoord(session.pending.coord) : null;
  const CLASS = { M: 'miss', H: 'hit', S: 'sunk', m: 'water' };
  oppCells.forEach((cell, k) => {
    const v = target.cells[k];
    cell.className = 'cell';
    if (v) cell.classList.add(CLASS[v]);
    if (pending && pending.r * SIZE + pending.c === k) cell.classList.add('pending');
  });
  $('#opp-board').classList.toggle('armed', state === 'myTurn');

  $('#status').textContent = STATUS[state]();
  $('#placement').style.display = placing ? '' : 'none';
  $('#btn-ready').disabled = !placing || !fleet.complete;
  $('#btn-retry').disabled = !(state === 'aiming' || state === 'waiting');
  $('#opp-label').textContent = session.opponent || '(nepoznat)';
  $('#my-afloat').textContent = placing ? '' : `${fleet.afloat}/5 na površini`;
  const hits = target.count('H') + target.count('S');
  const shots = hits + target.count('M');
  $('#score').textContent = shots ? `Pucnjeva ${shots} · pogodaka ${hits} · potopljeno ${target.sunk}/5` : '';
  renderShipList();
}

// ---------- vodopad ----------

const WF_N = 4096;
const WF_MAX_HZ = 3000;
const wfBuf = new Float32Array(WF_N);
let wfFill = 0;
let lastSpectrum = null;
const wf = $('#wf');
const wfCtx = wf.getContext('2d');
const overlay = $('#wf-overlay');
const ovCtx = overlay.getContext('2d');
const PALETTE = Array.from({ length: 256 }, (_, i) => {
  const t = i / 255;
  const stops = [
    [0, [4, 10, 30]],
    [0.35, [20, 60, 160]],
    [0.6, [30, 190, 200]],
    [0.8, [250, 220, 60]],
    [1, [255, 70, 40]],
  ];
  let j = 0;
  while (j < stops.length - 2 && t > stops[j + 1][0]) j++;
  const [t0, a] = stops[j];
  const [t1, b] = stops[j + 1];
  const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
  return a.map((v, k) => Math.round(v + (b[k] - v) * u));
});

function feedWaterfall(samples) {
  let i = 0;
  while (i < samples.length) {
    const n = Math.min(samples.length - i, WF_N - wfFill);
    wfBuf.set(samples.subarray(i, i + n), wfFill);
    wfFill += n;
    i += n;
    if (wfFill === WF_N) {
      drawWaterfallRow(spectrumDb(wfBuf));
      wfBuf.copyWithin(0, WF_N / 2);
      wfFill = WF_N / 2;
    }
  }
}

function sampleRate() {
  return io?.sampleRate ?? 48000;
}

function drawWaterfallRow(spec) {
  lastSpectrum = spec;
  const w = wf.width;
  const binHz = sampleRate() / WF_N;
  const row = new Float32Array(w);
  for (let x = 0; x < w; x++) row[x] = spec[Math.round(((x / w) * WF_MAX_HZ) / binHz)];
  const sorted = Float32Array.from(row).sort();
  const floor = sorted[Math.floor(w * 0.3)];
  const img = wfCtx.createImageData(w, 1);
  for (let x = 0; x < w; x++) {
    const v = Math.max(0, Math.min(255, Math.round(((row[x] - floor + 3) / 35) * 255)));
    const [r, g, b] = PALETTE[v];
    img.data.set([r, g, b, 255], x * 4);
  }
  wfCtx.drawImage(wf, 0, 1);
  wfCtx.putImageData(img, 0, 0);
}

function drawOverlay() {
  const w = overlay.width;
  const h = overlay.height;
  ovCtx.clearRect(0, 0, w, h);
  const x = (f) => (f / WF_MAX_HZ) * w;
  ovCtx.fillStyle = 'rgba(255,255,255,0.7)';
  ovCtx.font = '10px sans-serif';
  for (let f = 500; f < WF_MAX_HZ; f += 500) {
    ovCtx.fillRect(x(f), 0, 1, 5);
    ovCtx.fillText(String(f), x(f) + 2, 10);
  }
  const f = settings.freq;
  ovCtx.fillStyle = 'rgba(242,179,61,0.18)';
  ovCtx.fillRect(x(f - settings.baud), 0, x(2 * settings.baud), h);
  ovCtx.fillStyle = '#f2b33d';
  ovCtx.fillRect(x(f) - 0.5, 0, 1, h);
  if (demod && Math.abs(demod.afcOffset) > 0.05) {
    ovCtx.fillStyle = '#46c27a';
    ovCtx.fillRect(x(demod.rxFreq) - 0.5, h - 20, 1, 20);
  }
}

overlay.addEventListener('click', (e) => {
  const rect = overlay.getBoundingClientRect();
  let f = ((e.clientX - rect.left) / rect.width) * WF_MAX_HZ;
  // Privuci na najjači vrh u blizini klika.
  if (lastSpectrum) {
    const binHz = sampleRate() / WF_N;
    let best = Math.round(f / binHz);
    const span = Math.ceil(settings.baud / binHz);
    for (let b = best - span; b <= best + span; b++) if (lastSpectrum[b] > lastSpectrum[best]) best = b;
    f = best * binHz;
  }
  setSetting('freq', Math.round(f));
});

// ---------- indikatori ----------

function tick() {
  $('#ind-tx').classList.toggle('on', txActive);
  $('#ind-dcd').classList.toggle('on', !!demod?.dcd && !txActive);
  $('#quality-bar').style.width = `${Math.max(0, Math.min(1, demod?.quality ?? 0)) * 100}%`;
  $('#rx-freq').textContent = demod ? `${demod.rxFreq.toFixed(1)} Hz` : '— Hz';
  drawOverlay();
  requestAnimationFrame(tick);
}

// ---------- kontrole ----------

function setSetting(key, value) {
  settings[key] = value;
  saveSettings();
  const el = $(`[data-setting="${key}"]`);
  if (el && el.type !== 'checkbox' && el.value !== String(value)) el.value = value;
  applySetting(key);
}

function applySetting(key) {
  const v = settings[key];
  switch (key) {
    case 'me':
    case 'opponent':
      session[key] = v;
      break;
    case 'baud':
      demod?.configure(v, settings.freq);
      break;
    case 'freq':
      demod?.setFreq(v);
      break;
    case 'afc':
      if (demod) {
        demod.afc = v;
        demod.afcOffset = 0;
      }
      break;
    case 'noise':
      if (io) io.noise = v;
      break;
    case 'channel':
      document.body.classList.toggle('virtual', v === 'virtual');
      restartModem();
      break;
    case 'inputId':
      if (io instanceof AudioIO) restartModem();
      break;
    case 'outputId':
      if (io instanceof AudioIO) io.setOutput(v).catch((e) => log('err', `Izlaz: ${e.message}`));
      break;
  }
  scheduleRender();
}

for (const el of document.querySelectorAll('[data-setting]')) {
  const key = el.dataset.setting;
  if (el.type === 'checkbox') el.checked = settings[key];
  else el.value = settings[key];
  const handler = () => {
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (NUMERIC.has(key)) {
      v = Number(v);
      if (!Number.isFinite(v)) return;
    }
    if (key === 'me' || key === 'opponent') {
      v = String(v).trim().toUpperCase();
      if (v && !CALL_RE.test(v)) {
        log('err', 'Pozivni znak: do 10 znakova A–Z, 0–9 i /');
        el.value = settings[key];
        return;
      }
      el.value = v;
    }
    setSetting(key, v);
  };
  el.addEventListener('change', handler);
  if (el.type === 'range') el.addEventListener('input', handler);
}
document.body.classList.toggle('virtual', settings.channel === 'virtual');

async function fillDevices() {
  try {
    const { inputs, outputs } = await listDevices();
    const fill = (sel, devices, key) => {
      sel.replaceChildren(new Option('zadano', ''), ...devices.filter((d) => d.deviceId && d.deviceId !== 'default').map((d) => new Option(d.label || d.deviceId.slice(0, 8), d.deviceId)));
      sel.value = settings[key];
    };
    fill($('#sel-input'), inputs, 'inputId');
    fill($('#sel-output'), outputs, 'outputId');
    if (!('setSinkId' in AudioContext.prototype)) $('#sel-output').disabled = true;
  } catch (e) {
    log('err', `Popis uređaja: ${e.message}`);
  }
}

$('#btn-start').onclick = async () => {
  try {
    if (io) await restartModem();
    else await startModem();
  } catch {
    /* već zapisano u dnevnik */
  }
};
$('#btn-rotate').onclick = rotate;
$('#btn-random').onclick = () => {
  session.fleet.randomize();
  selected = null;
  scheduleRender();
};
$('#btn-clear').onclick = () => {
  session.fleet.clear();
  selected = 0;
  scheduleRender();
};
$('#btn-ready').onclick = () => session.ready();
$('#btn-retry').onclick = () => session.retry();
$('#btn-new').onclick = () => {
  if (!['placing', 'won', 'lost'].includes(session.state) && !confirm('Prekinuti igru i započeti novu?')) return;
  lastIncoming = null;
  session.newGame();
};
$('#btn-cq').onclick = () => session.announce();
$('#chat').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#chat-text').value.trim();
  if (!text) return;
  session.chat(text);
  $('#chat-text').value = '';
});
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'r' && !e.target.closest('input, select, textarea') && session.state === 'placing') rotate();
});

if (!window.isSecureContext) {
  log('err', 'Mikrofon radi samo na https:// ili http://localhost — otvori igru preko lokalnog poslužitelja.');
}

render();
tick();
