// Zvučni ulaz/izlaz. AudioIO ide preko zvučne kartice (radio na VOX-u, ili zvučnik/mikrofon),
// VirtualChannel preko BroadcastChannel-a između tabova istog preglednika, za probu bez radija.
// Oba imaju isto sučelje: start(), stop(), play(samples) → Promise, sampleRate.

const WORKLET = `
class PskTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(1024);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('psk-tap', PskTap);
`;

export class AudioIO {
  constructor(onSamples) {
    this.onSamples = onSamples;
    this.ctx = null;
  }

  get sampleRate() {
    return this.ctx.sampleRate;
  }

  async start({ inputId = '', outputId = '' } = {}) {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    // Obrada glasa (AEC, NS, AGC) uništava PSK, zato je sve isključeno.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: inputId ? { exact: inputId } : undefined,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.tap = new AudioWorkletNode(this.ctx, 'psk-tap', { numberOfOutputs: 1 });
    this.tap.port.onmessage = (e) => this.onSamples(e.data);
    // Tihi spoj na izlaz drži čvor aktivnim u svim preglednicima.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.source.connect(this.tap).connect(mute).connect(this.ctx.destination);
    if (outputId) await this.setOutput(outputId);
    await this.ctx.resume();
  }

  async setOutput(id) {
    if (this.ctx?.setSinkId) await this.ctx.setSinkId(id || '');
  }

  play(samples) {
    const buf = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
    buf.copyToChannel(samples, 0);
    const node = this.ctx.createBufferSource();
    node.buffer = buf;
    node.connect(this.ctx.destination);
    return new Promise((resolve) => {
      node.onended = resolve;
      node.start();
    });
  }

  async stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.ctx = null;
  }
}

export class VirtualChannel {
  constructor(onSamples, sampleRate = 48000) {
    this.onSamples = onSamples;
    this.sampleRate = sampleRate;
    this.noise = 0.02;
    this.queue = [];
  }

  async start() {
    this.bc = new BroadcastChannel('potapanje-psk');
    this.bc.onmessage = (e) => this.queue.push({ samples: e.data.samples, pos: 0 });
    this.last = performance.now();
    this.carry = 0;
    // Prijem teče u stvarnom vremenu: šum plus ono što su drugi tabovi odaslali.
    this.timer = setInterval(() => this.tick(), 40);
  }

  tick() {
    const now = performance.now();
    const exact = ((now - this.last) / 1000) * this.sampleRate + this.carry;
    const n = Math.floor(exact);
    this.carry = exact - n;
    this.last = now;
    if (n <= 0) return;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = Math.random() || 1e-12;
      out[i] = this.noise * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
    }
    let i = 0;
    while (i < n && this.queue.length) {
      const q = this.queue[0];
      while (i < n && q.pos < q.samples.length) out[i++] += q.samples[q.pos++];
      if (q.pos >= q.samples.length) this.queue.shift();
    }
    this.onSamples(out);
  }

  play(samples) {
    this.bc.postMessage({ samples });
    return new Promise((resolve) => setTimeout(resolve, (samples.length / this.sampleRate) * 1000));
  }

  async stop() {
    clearInterval(this.timer);
    this.bc?.close();
  }
}

export async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: devices.filter((d) => d.kind === 'audioinput'),
    outputs: devices.filter((d) => d.kind === 'audiooutput'),
  };
}
