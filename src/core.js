/* Dudley Vocoder: pure functions (no Web Audio). Works in Node and the browser. */
(function (g) {
  "use strict";

  // Ten analyzer bands as pictured in Dudley, BSTJ 19(4) 1940, Fig. 10 caption:
  // "ten frequency bands of 300 cycles width except that the lowest one extends from 0 to 250 cycles".
  const DUDLEY_EDGES = [0, 250, 550, 850, 1150, 1450, 1750, 2050, 2350, 2650, 2950];

  function dudleyBands() {
    const out = [];
    for (let i = 0; i < 10; i++) out.push({ lo: DUDLEY_EDGES[i], hi: DUDLEY_EDGES[i + 1] });
    return out;
  }

  // Glasberg & Moore (1990) ERB-rate scale.
  const erbRate = (f) => 21.4 * Math.log10(1 + 0.00437 * f);
  const erbInv = (e) => (Math.pow(10, e / 21.4) - 1) / 0.00437;

  function erbBands(n, lo, hi) {
    const a = erbRate(lo), b = erbRate(hi), out = [];
    for (let i = 0; i < n; i++) out.push({ lo: erbInv(a + ((b - a) * i) / n), hi: erbInv(a + ((b - a) * (i + 1)) / n) });
    return out;
  }

  function median(a) {
    const s = Array.from(a).sort((x, y) => x - y);
    return s[s.length >> 1];
  }

  /**
   * Frame-wise pitch and voicing estimate by normalized autocorrelation.
   * x: Float32Array mono, sr: sample rate. Returns frames at 10 ms hop.
   */
  function trackPitch(x, sr, opt) {
    opt = opt || {};
    const fmin = opt.fmin || 70, fmax = opt.fmax || 400, vthr = opt.vthr || 0.5;
    const d = Math.max(1, Math.round(sr / 11025)); // decimate to ~11 kHz with a box filter
    const n = Math.floor(x.length / d), y = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < d; k++) s += x[i * d + k]; y[i] = s / d; }
    const fs = sr / d, hop = Math.round(0.01 * fs), win = Math.round(0.04 * fs);
    const lmin = Math.floor(fs / fmax), lmax = Math.ceil(fs / fmin);
    const nf = Math.max(2, Math.floor(n / hop));
    const f0 = new Float32Array(nf), voiced = new Float32Array(nf), rms = new Float32Array(nf), conf = new Float32Array(nf);
    let peak = 1e-9;
    for (let f = 0; f < nf; f++) {
      const s0 = f * hop - (win >> 1);
      let e = 0;
      for (let i = 0; i < win; i++) { const v = y[s0 + i] || 0; e += v * v; }
      rms[f] = Math.sqrt(e / win); if (rms[f] > peak) peak = rms[f];
    }
    const r = new Float32Array(lmax + 2);
    for (let f = 0; f < nf; f++) {
      if (rms[f] < 0.03 * peak) continue;
      const s0 = f * hop - (win >> 1);
      let e0 = 0;
      for (let i = 0; i < win; i++) { const v = y[s0 + i] || 0; e0 += v * v; }
      let best = 0;
      for (let l = lmin; l <= lmax + 1; l++) {
        let c = 0, el = 0;
        for (let i = 0; i < win; i++) { const a = y[s0 + i] || 0, b = y[s0 + i + l] || 0; c += a * b; el += b * b; }
        r[l] = c / Math.sqrt(e0 * el + 1e-12);
        if (r[l] > best) best = r[l];
      }
      // smallest lag that is a local maximum within 10% of the best: avoids octave-down errors
      let lag = 0;
      for (let l = lmin + 1; l <= lmax; l++) {
        if (r[l] >= r[l - 1] && r[l] >= r[l + 1] && r[l] >= 0.9 * best) { lag = l; break; }
      }
      conf[f] = best;
      if (lag && best >= vthr) {
        const a = r[lag - 1], b = r[lag], c = r[lag + 1], den = a - 2 * b + c;
        const off = den ? (0.5 * (a - c)) / den : 0;
        f0[f] = fs / (lag + off);
        voiced[f] = 1;
      }
    }
    // drop isolated 1-frame voicing flips
    for (let f = 1; f < nf - 1; f++) {
      if (voiced[f] && !voiced[f - 1] && !voiced[f + 1]) { voiced[f] = 0; f0[f] = 0; }
      else if (!voiced[f] && voiced[f - 1] && voiced[f + 1] && rms[f] >= 0.03 * peak) { voiced[f] = 1; f0[f] = (f0[f - 1] + f0[f + 1]) / 2; }
    }
    // median filter voiced f0, then fill unvoiced frames by holding the nearest voiced value
    const sm = new Float32Array(nf);
    for (let f = 0; f < nf; f++) {
      if (!voiced[f]) continue;
      const w = [];
      for (let k = -2; k <= 2; k++) { const j = f + k; if (j >= 0 && j < nf && voiced[j]) w.push(f0[j]); }
      sm[f] = median(w);
    }
    let last = 0;
    for (let f = 0; f < nf; f++) { if (voiced[f]) last = sm[f]; else sm[f] = last; }
    last = 0;
    for (let f = nf - 1; f >= 0; f--) { if (voiced[f]) last = sm[f]; else if (!sm[f]) sm[f] = last; }
    let med = 0, cnt = 0; for (let f = 0; f < nf; f++) if (voiced[f]) { med += sm[f]; cnt++; }
    const fallback = cnt ? med / cnt : 110;
    for (let f = 0; f < nf; f++) if (!sm[f]) sm[f] = fallback;
    return { hop: hop / fs, f0: sm, voiced, rms, conf, medianF0: fallback, voicedShare: cnt / nf };
  }

  // 3-frame box smoothing of a 0/1 track so gates ramp over about 30 ms instead of clicking
  function smoothTrack(v, passes) {
    let a = Float32Array.from(v);
    for (let p = 0; p < (passes || 1); p++) {
      const b = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) b[i] = ((a[i - 1] ?? a[i]) + a[i] + (a[i + 1] ?? a[i])) / 3;
      a = b;
    }
    return a;
  }

  // Equalizer: ten faders sit at the centers of Dudley's ten bands. Gain at any frequency is interpolated in log-f, flat beyond the ends.
  const EQ_CENTERS = [125, 400, 700, 1000, 1300, 1600, 1900, 2200, 2500, 2800];
  function eqGainDb(db, f) {
    if (!db) return 0;
    if (f <= EQ_CENTERS[0]) return db[0];
    if (f >= EQ_CENTERS[9]) return db[9];
    let i = 0; while (f > EQ_CENTERS[i + 1]) i++;
    const t = Math.log(f / EQ_CENTERS[i]) / Math.log(EQ_CENTERS[i + 1] / EQ_CENTERS[i]);
    return db[i] + (db[i + 1] - db[i]) * t;
  }

  // Chord ratios for the modern external-carrier mode
  const CHORDS = { power: [1, 1.5, 2, 3], minor7: [1, 1.1892, 1.4983, 1.7818], major7: [1, 1.2599, 1.4983, 1.8877], octaves: [0.5, 1, 2, 4] };

  function wavEncode(samples, sr) {
    const n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return buf;
  }

  g.VocoderCore = { DUDLEY_EDGES, dudleyBands, erbRate, erbInv, erbBands, trackPitch, smoothTrack, EQ_CENTERS, eqGainDb, CHORDS, wavEncode };
  if (typeof module !== "undefined") module.exports = g.VocoderCore;
})(typeof globalThis !== "undefined" ? globalThis : this);
