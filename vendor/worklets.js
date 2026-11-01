/* Room Theremin reverb processors: Dattorro plate and geometry-driven FDN hall. */

class Line {
  constructor(maxLen) {
    this.n = maxLen + 8;
    this.b = new Float32Array(this.n);
    this.w = 0;
  }
  /** Value written d writes ago (d >= 1), before the current sample is written. */
  read(d) {
    let i = this.w - d;
    while (i < 0) i += this.n;
    return this.b[i];
  }
  readF(d) {
    const i0 = Math.floor(d);
    const f = d - i0;
    const a = this.read(i0);
    const b = this.read(i0 + 1);
    return a + (b - a) * f;
  }
  write(x) {
    this.b[this.w] = x;
    this.w = this.w + 1 === this.n ? 0 : this.w + 1;
  }
}

/** Schroeder allpass: (z^-N - g) / (1 - g z^-N). Optional modulation of the delay. */
class Allpass {
  constructor(len, g, exc = 0) {
    this.len = len;
    this.g = g;
    this.exc = exc;
    this.line = new Line(len + Math.ceil(exc) + 4);
  }
  process(x, mod = 0) {
    const d = this.exc ? this.line.readF(this.len + this.exc * mod) : this.line.read(this.len);
    const v = x + this.g * d;
    this.line.write(v);
    return d - this.g * v;
  }
}

class PlateReverb extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    const s = sampleRate / 29761;
    const L = (n) => Math.max(2, Math.round(n * s));
    this.pre = new Line(Math.ceil(sampleRate * 0.25));
    this.preSamples = Math.round(sampleRate * 0.012);
    this.bw = 0;
    this.bwCoef = 0.9995;
    this.diff = [
      new Allpass(L(142), 0.75),
      new Allpass(L(107), 0.75),
      new Allpass(L(379), 0.625),
      new Allpass(L(277), 0.625),
    ];
    this.decay = 0.62;
    this.damp = 0.3;
    const exc = 16 * s;
    this.t = [0, 1].map((k) => ({
      mod: new Allpass(L(k ? 908 : 672), -0.7, exc),
      d1: new Line(L(k ? 4217 : 4453) + 8),
      d1len: L(k ? 4217 : 4453),
      lp: 0,
      ap2: new Allpass(L(k ? 2656 : 1800), 0.5),
      d2: new Line(L(k ? 3163 : 3720) + 8),
      d2len: L(k ? 3163 : 3720),
      fb: 0,
    }));
    this.s = s;
    this.L = L;
    this.phase = 0;
    this.lfoInc = (2 * Math.PI * 0.8) / sampleRate;
    this.handle = (m) => {
      if (m.decay !== undefined) this.decay = Math.min(0.97, Math.max(0.1, m.decay));
      if (m.damp !== undefined) this.damp = Math.min(0.98, Math.max(0, m.damp));
      if (m.predelay !== undefined) {
        this.preSamples = Math.min(this.pre.n - 16, Math.max(1, Math.round((m.predelay / 1000) * sampleRate)));
      }
    };
    this.port.onmessage = (e) => this.handle(e.data);
    if (options && options.processorOptions) this.handle(options.processorOptions);
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const inp = inputs[0];
    const outL = out[0];
    const outR = out[1] || out[0];
    const n = outL.length;
    const a = inp && inp[0];
    const b = inp && inp[1];
    const [tl, tr] = this.t;
    const L = this.L;
    const decay = this.decay;
    const dd2 = Math.min(0.5, Math.max(0.25, decay + 0.15));
    tl.ap2.g = dd2;
    tr.ap2.g = dd2;
    const damp = this.damp;
    for (let i = 0; i < n; i++) {
      let x = a ? (b ? 0.5 * (a[i] + b[i]) : a[i]) : 0;
      this.pre.write(x);
      x = this.pre.read(this.preSamples);
      this.bw = this.bwCoef * x + (1 - this.bwCoef) * this.bw;
      let y = this.bw;
      for (const ap of this.diff) y = ap.process(y);
      this.phase += this.lfoInc;
      const sl = Math.sin(this.phase);
      const sr_ = Math.cos(this.phase);
      for (let k = 0; k < 2; k++) {
        const t = k ? tr : tl;
        const other = k ? tl : tr;
        let v = y + other.fb * decay;
        v = t.mod.process(v, k ? sr_ : sl);
        const o1 = t.d1.read(t.d1len);
        t.d1.write(v);
        t.lp = (1 - damp) * o1 + damp * t.lp;
        v = t.lp * decay;
        v = t.ap2.process(v);
        const o2 = t.d2.read(t.d2len);
        t.d2.write(v);
        t.fbNext = o2;
      }
      tl.fb = tl.fbNext;
      tr.fb = tr.fbNext;
      const oL =
        tr.d1.read(L(266)) + tr.d1.read(L(2974)) - tr.ap2.line.read(L(1913)) + tr.d2.read(L(1996)) -
        tl.d1.read(L(1990)) - tl.ap2.line.read(L(187)) - tl.d2.read(L(1066));
      const oR =
        tl.d1.read(L(353)) + tl.d1.read(L(3627)) - tl.ap2.line.read(L(1228)) + tl.d2.read(L(2673)) -
        tr.d1.read(L(2111)) - tr.ap2.line.read(L(335)) - tr.d2.read(L(121));
      outL[i] = 0.6 * oL;
      outR[i] = 0.6 * oR;
    }
    return true;
  }
}

const C_SOUND = 343;

function isPrime(n) {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
  return true;
}
function nearPrime(n) {
  n = Math.max(7, Math.round(n));
  for (let k = 0; k < 200; k++) {
    if (isPrime(n + k)) return n + k;
    if (n - k > 2 && isPrime(n - k)) return n - k;
  }
  return n;
}

/** Image-source early reflections for a shoebox room, up to the given order. */
function earlyTaps(g, maxTaps) {
  const { W, D, H, alpha } = g;
  const beta = Math.sqrt(Math.max(0, 1 - alpha));
  const s = [g.sx, g.sy, g.sz];
  const l = [g.lx, g.ly, g.lz];
  const dims = [W, D, H];
  const taps = [];
  const rng = [-2, -1, 0, 1, 2];
  for (let q0 = 0; q0 < 2; q0++)
    for (let q1 = 0; q1 < 2; q1++)
      for (let q2 = 0; q2 < 2; q2++)
        for (const n0 of rng)
          for (const n1 of rng)
            for (const n2 of rng) {
              const q = [q0, q1, q2];
              const n = [n0, n1, n2];
              let refl = 0;
              for (let a = 0; a < 3; a++) refl += Math.abs(n[a] - q[a]) + Math.abs(n[a]);
              if (refl === 0 || refl > 3) continue;
              const img = [0, 1, 2].map((a) => (1 - 2 * q[a]) * s[a] + 2 * n[a] * dims[a]);
              const dx = img[0] - l[0];
              const dy = img[1] - l[1];
              const dz = img[2] - l[2];
              const dist = Math.hypot(dx, dy, dz);
              const amp = Math.pow(beta, refl) / Math.max(dist, 0.3);
              taps.push({ dist, amp, lat: dx / Math.max(dist, 1e-3) });
            }
  taps.sort((p, q) => q.amp - p.amp);
  return taps.slice(0, maxTaps).map((t) => {
    const ang = ((Math.max(-1, Math.min(1, t.lat)) + 1) * Math.PI) / 4;
    return { delay: (t.dist / C_SOUND) * sampleRate, gl: t.amp * Math.cos(ang), gr: t.amp * Math.sin(ang) };
  });
}

class HallReverb extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this.N = 8;
    this.maxLen = Math.ceil(sampleRate * 0.4);
    this.lines = Array.from({ length: this.N }, () => new Line(this.maxLen));
    this.len = new Float32Array(this.N).fill(1000);
    this.lenT = new Float32Array(this.N).fill(1000);
    this.g = new Float32Array(this.N).fill(0.8);
    this.gT = new Float32Array(this.N).fill(0.8);
    this.lp = new Float32Array(this.N);
    this.da = new Float32Array(this.N);
    this.damp = 0.25;
    this.tailGain = 1;
    this.tailAuto = 1;
    this.pre = new Line(Math.ceil(sampleRate * 0.5));
    this.preSamples = Math.round(sampleRate * 0.01);
    this.er = new Line(Math.ceil(sampleRate * 0.6));
    this.cur = [];
    this.next = null;
    this.xf = 1;
    this.erGain = 1;
    this.signL = [1, 1, -1, -1, 1, 1, -1, -1];
    this.signR = [1, -1, 1, -1, 1, -1, 1, -1];
    this.inSign = [1, -1, 1, 1, -1, 1, -1, -1];
    this.stats = { rt60: 0, taps: 0 };
    this.apply({ W: 12, D: 16, H: 6, alpha: 0.25, sx: 6, sy: 8, sz: 1.5, lx: 6, ly: 5, lz: 1.5 });
    this.len.set(this.lenT);
    this.g.set(this.gT);
    this.cur = this.next || [];
    this.next = null;
    this.handle = (m) => {
      if (m.damp !== undefined) { this.damp = Math.min(0.95, Math.max(0, m.damp)); this.setDamp(); }
      if (m.tail !== undefined) this.tailGain = m.tail;
      if (m.er !== undefined) this.erGain = m.er;
      if (m.geom) this.apply(m.geom);
    };
    this.port.onmessage = (e) => this.handle(e.data);
    if (options && options.processorOptions) this.handle(options.processorOptions);
  }
  setDamp() {
    for (let i = 0; i < this.N; i++) this.da[i] = Math.min(0.95, (this.damp * this.lenT[i]) / 1200);
  }
  apply(g) {
    const V = g.W * g.D * g.H;
    const S = 2 * (g.W * g.D + g.W * g.H + g.D * g.H);
    const alpha = Math.min(0.97, Math.max(0.02, g.alpha));
    const rt60 = Math.min(12, Math.max(0.15, (-0.161 * V) / (S * Math.log(1 - alpha))));
    const mfp = (4 * V) / S;
    const base = Math.min(this.maxLen * 0.45, (mfp / C_SOUND) * sampleRate);
    const f = [0.55, 0.68, 0.8, 0.93, 1.05, 1.19, 1.33, 1.5];
    for (let i = 0; i < this.N; i++) {
      this.lenT[i] = Math.min(this.maxLen - 4, nearPrime(base * f[i]));
      this.gT[i] = Math.pow(10, (-3 * this.lenT[i]) / (sampleRate * rt60));
    }
    this.setDamp();
    // Diffuse-field level (Sabine): late energy = 16*pi/A relative to a direct sound of unit amplitude at 1 m.
    const Aeq = S * -Math.log(1 - alpha);
    let avgLen = 0;
    for (let i = 0; i < this.N; i++) avgLen += this.lenT[i];
    avgLen /= this.N;
    const eFdn = 0.86 * 2 * 0.1225 * (8 * 0.1225) * ((rt60 * sampleRate) / (13.8 * avgLen));
    this.tailAuto = Math.sqrt((16 * Math.PI) / Aeq / eFdn);
    const dDirect = Math.hypot(g.sx - g.lx, g.sy - g.ly, g.sz - g.lz);
    this.preSamples = Math.min(this.pre.n - 16, Math.max(1, Math.round((dDirect / C_SOUND) * sampleRate * 0.6)));
    this.next = earlyTaps(g, 40);
    this.xf = 0;
    const nTaps = this.next.length;
    if (g.snap) {
      this.len.set(this.lenT);
      this.g.set(this.gT);
      this.cur = this.next;
      this.next = null;
      this.xf = 1;
    }
    this.stats = { rt60, taps: nTaps, mfp };
    if (this.port) this.port.postMessage({ rt60, taps: nTaps });
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const inp = inputs[0];
    const outL = out[0];
    const outR = out[1] || out[0];
    const n = outL.length;
    const a = inp && inp[0];
    const b = inp && inp[1];
    const N = this.N;
    const y = new Float64Array(N);
    const xfStep = 1 / (0.08 * sampleRate);
    const tg = this.tailGain;
    const ta = 0.35 * this.tailAuto;
    const eg = this.erGain;
    for (let i = 0; i < n; i++) {
      const x = a ? (b ? 0.5 * (a[i] + b[i]) : a[i]) : 0;
      this.er.write(x);
      this.pre.write(x);
      const xin = this.pre.read(this.preSamples);
      let eL = 0;
      let eR = 0;
      const cur = this.cur;
      for (let k = 0; k < cur.length; k++) {
        const t = cur[k];
        const v = this.er.readF(Math.min(t.delay, this.er.n - 8));
        eL += v * t.gl;
        eR += v * t.gr;
      }
      if (this.next) {
        let nL = 0;
        let nR = 0;
        const nx = this.next;
        for (let k = 0; k < nx.length; k++) {
          const t = nx[k];
          const v = this.er.readF(Math.min(t.delay, this.er.n - 8));
          nL += v * t.gl;
          nR += v * t.gr;
        }
        eL = eL * (1 - this.xf) + nL * this.xf;
        eR = eR * (1 - this.xf) + nR * this.xf;
        this.xf += xfStep;
        if (this.xf >= 1) {
          this.cur = this.next;
          this.next = null;
          this.xf = 1;
        }
      }
      for (let k = 0; k < N; k++) {
        this.len[k] += Math.max(-0.02, Math.min(0.02, this.lenT[k] - this.len[k]));
        this.g[k] += (this.gT[k] - this.g[k]) * 0.0005;
        const o = this.lines[k].readF(this.len[k]);
        this.lp[k] = (1 - this.da[k]) * o + this.da[k] * this.lp[k];
        y[k] = this.lp[k] * this.g[k];
      }
      // 8-point Walsh-Hadamard mix, orthonormal
      for (let h = 1; h < N; h <<= 1) {
        for (let j = 0; j < N; j += h << 1) {
          for (let k = j; k < j + h; k++) {
            const p = y[k];
            const q = y[k + h];
            y[k] = p + q;
            y[k + h] = p - q;
          }
        }
      }
      const norm = 1 / Math.sqrt(N);
      let tL = 0;
      let tR = 0;
      for (let k = 0; k < N; k++) {
        const m = y[k] * norm;
        this.lines[k].write(m + xin * this.inSign[k] * 0.35);
        tL += this.signL[k] * m;
        tR += this.signR[k] * m;
      }
      outL[i] = eL * eg + tL * tg * ta;
      outR[i] = eR * eg + tR * tg * ta;
    }
    return true;
  }
}

registerProcessor("plate-reverb", PlateReverb);
registerProcessor("hall-reverb", HallReverb);
