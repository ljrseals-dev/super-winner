/* Robot Choir: stereo vocoder with a choir of drifting saw voices and a plate reverb. Offline render, shared by playback, display and export. */
(function (g) {
  "use strict";
  const C = g.VocoderCore, SR = 44100;
  let WORKLETS = []; // module sources: analog-osc (drift) and plate-reverb

  const CHORDS = {
    major: [0, 4, 7, 12], minor: [0, 3, 7, 12], sus2: [0, 2, 7, 12], min7: [0, 3, 7, 10], maj9: [0, 4, 7, 14], fifths: [0, 7, 12, 19], unison: [0]
  };
  const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  /** Semitone offset of each voice. The first chord-length voices take the chord; more voices double it an octave down. */
  function intervals(chord, n) {
    const c = CHORDS[chord] || CHORDS.major, out = [];
    for (let i = 0; i < n; i++) out.push(i < c.length ? c[i] : c[i % c.length] - 12 * (1 + Math.floor((i - c.length) / c.length)));
    return out;
  }

  /** Stereo position -1..1 per voice, shuffled so neighbouring chord tones do not sit on the same side. */
  function pans(n, spread) {
    if (n === 1) return [0];
    let step = 3; const gcd = (a, b) => (b ? gcd(b, a % b) : a); while (gcd(step, n) !== 1) step++;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = spread * (((i * step) % n) / (n - 1) * 2 - 1);
    return out;
  }

  /** Nearest note of a scale (given as pitch classes from a root pitch class) to a fractional MIDI note. */
  function snapToScale(midi, rootPc, scale) {
    const sc = SCALES[scale] || SCALES.major; let best = null, bd = 1e9;
    const base = Math.floor(midi / 12) * 12;
    for (let o = -12; o <= 12; o += 12) for (const s of sc) { const m = base + o + ((rootPc + s) % 12); const d = Math.abs(m - midi); if (d < bd) { bd = d; best = m; } }
    return best;
  }

  function plateTail(decay) {
    const pts = [[0.1, 0.6], [0.4, 1.4], [0.62, 2.4], [0.85, 6.6], [0.95, 14]]; let t = pts[pts.length - 1][1];
    for (let i = 1; i < pts.length; i++) if (decay <= pts[i][0]) { const a = pts[i - 1], b = pts[i]; t = a[1] + ((b[1] - a[1]) * (decay - a[0])) / (b[0] - a[0]); break; }
    return t;
  }
  function plateScale(decay) {
    const pts = [[0.1, 1.2], [0.4, 1.93], [0.62, 2.45], [0.85, 4.06], [0.97, 9]]; let e = pts[pts.length - 1][1];
    for (let i = 1; i < pts.length; i++) if (decay <= pts[i][0]) { const a = pts[i - 1], b = pts[i]; e = a[1] + ((b[1] - a[1]) * (decay - a[0])) / (b[0] - a[0]); break; }
    return 0.3 * Math.sqrt(2.45 / e);
  }

  async function loadModules(ctx) {
    for (const src of WORKLETS) {
      const url = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
      try { await ctx.audioWorklet.addModule(url); }
      catch (e) { await ctx.audioWorklet.addModule("data:application/javascript;base64," + btoa(unescape(encodeURIComponent(src)))); }
      URL.revokeObjectURL(url);
    }
  }

  function bandFilter(ctx, band, qScale) {
    const a = ctx.createBiquadFilter(), b = ctx.createBiquadFilter();
    if (band.lo <= 0) { a.type = b.type = "lowpass"; a.frequency.value = b.frequency.value = band.hi; a.Q.value = b.Q.value = 0.707; }
    else { const fc = Math.sqrt(band.lo * band.hi); a.type = b.type = "bandpass"; a.frequency.value = b.frequency.value = fc; a.Q.value = b.Q.value = (fc / (band.hi - band.lo)) * (qScale || 1); }
    a.connect(b); return { in: a, out: b };
  }
  function envelope(ctx, from, cutoff) {
    const ws = ctx.createWaveShaper(); ws.curve = new Float32Array([1, 0, 1]);
    const l1 = ctx.createBiquadFilter(), l2 = ctx.createBiquadFilter(), mk = ctx.createGain();
    l1.type = l2.type = "lowpass"; l1.frequency.value = l2.frequency.value = cutoff; l1.Q.value = l2.Q.value = 0.707; mk.gain.value = Math.PI / 2;
    from.connect(ws); ws.connect(l1); l1.connect(l2); l2.connect(mk); return mk;
  }
  function noiseBuf(ctx, secs, seed) {
    const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * secs), ctx.sampleRate), d = b.getChannelData(0); let s = seed >>> 0;
    for (let i = 0; i < d.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = (s / 2147483648 - 1) * 0.9; }
    return b;
  }
  function noise(ctx, buf) { const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true; n.start(0); return n; }

  /**
   * cfg: voices(4-8), chord, rootPc(0-11), follow(bool), scale, spread(0-1), detune(cents), drift(0-3),
   *      vibrato, breath, consonants (bool), mix(0-1), decay, bands(array), qScale, envCut, sib(0-1)
   * Returns { buffer: AudioBuffer(2ch), corr: L/R zero-lag correlation, tail }.
   */
  async function render(buf, pitch, cfg) {
    const dur = buf.duration, reverb = cfg.mix > 0, tail = 0.3 + (reverb ? plateTail(cfg.decay) : 0);
    const len = Math.ceil((dur + tail) * SR), ctx = new OfflineAudioContext(2, len, SR);
    await loadModules(ctx);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const input = ctx.createGain(); input.channelCount = 1; input.channelCountMode = "explicit"; src.connect(input); src.start(0);

    const n = Math.max(1, Math.min(8, cfg.voices | 0)), iv = intervals(cfg.chord, n), pn = pans(n, cfg.spread);
    const carL = ctx.createGain(), carR = ctx.createGain(); const nF = pitch.f0.length, T = nF * pitch.hop;
    const rootMidi = 48 + (cfg.rootPc || 0);
    // follow mode: speech pitch snapped to the scale, folded into one octave above C3, then the chord is planed on top
    let snapped = null;
    if (cfg.follow) {
      snapped = new Float32Array(nF);
      for (let i = 0; i < nF; i++) {
        let m = 69 + 12 * Math.log2(Math.max(40, pitch.f0[i]) / 440); m = snapToScale(m, cfg.rootPc || 0, cfg.scale);
        while (m >= 60) m -= 12; while (m < 48) m += 12; snapped[i] = m;
      }
    }
    for (let i = 0; i < n; i++) {
      const o = new AudioWorkletNode(ctx, "analog-osc", { numberOfInputs: 0, outputChannelCount: [1], processorOptions: { type: "saw", drift: { seed: i + 3 } } });
      const P = o.parameters;
      if (snapped) { const c = new Float32Array(nF); for (let k = 0; k < nF; k++) c[k] = midiHz(snapped[k] + iv[i]); P.get("frequency").setValueCurveAtTime(c, 0, T); }
      else P.get("frequency").value = midiHz(rootMidi + iv[i]);
      P.get("detune").value = n > 1 ? cfg.detune * ((i / (n - 1)) * 2 - 1) : 0;
      P.get("depth").value = cfg.drift;
      if (cfg.vibrato) {
        const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 5.1 + 0.17 * i; lfo.start(i * 0.047);
        lg.gain.setValueAtTime(0, 0); lg.gain.linearRampToValueAtTime(0, 0.35); lg.gain.linearRampToValueAtTime(16, 0.9);
        lfo.connect(lg); lg.connect(P.get("detune"));
      }
      const gl = ctx.createGain(), gr = ctx.createGain(), a = ((pn[i] + 1) * Math.PI) / 4, lv = 1 / Math.sqrt(n);
      gl.gain.value = Math.cos(a) * lv; gr.gain.value = Math.sin(a) * lv;
      o.connect(gl); o.connect(gr); gl.connect(carL); gr.connect(carR);
    }
    // noise: separate buffers left and right so breath and consonants are decorrelated
    const top = cfg.bands[cfg.bands.length - 1].hi, hissK = Math.sqrt(ctx.sampleRate / 2 / top);
    const nzL = noiseBuf(ctx, 2, 12345), nzR = noiseBuf(ctx, 2, 987654321);
    const vc = Float32Array.from(C.smoothTrack(pitch.voiced, 2)), uc = Float32Array.from(vc, (v) => 1 - v);
    if (cfg.consonants) {
      [nzL, nzR].forEach((nb, k) => { const s = noise(ctx, nb), gu = ctx.createGain(), kk = ctx.createGain(); gu.gain.setValueCurveAtTime(uc, 0, T); kk.gain.value = 0.6 * hissK; s.connect(gu); gu.connect(kk); kk.connect(k ? carR : carL); });
    }
    if (cfg.breath) {
      [nzL, nzR].forEach((nb, k) => { const s = noise(ctx, nb), kk = ctx.createGain(); kk.gain.value = 0.12 * hissK; s.connect(kk); kk.connect(k ? carR : carL); });
    }

    const outL = ctx.createGain(), outR = ctx.createGain();
    cfg.bands.forEach((band) => {
      const a = bandFilter(ctx, band, cfg.qScale); input.connect(a.in);
      const env = envelope(ctx, a.out, cfg.envCut);
      [[carL, outL], [carR, outR]].forEach(([car, out]) => {
        const s = bandFilter(ctx, band, cfg.qScale), sg = ctx.createGain(); sg.gain.value = 0; env.connect(sg.gain); car.connect(s.in); s.out.connect(sg); sg.connect(out);
      });
    });
    if (cfg.consonants && cfg.sib > 0) {
      const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 5000; input.connect(hp);
      const env = envelope(ctx, hp, 80);
      [[nzL, outL], [nzR, outR]].forEach(([nb, out], k) => {
        const s = noise(ctx, k ? noiseBuf(ctx, 2, 5551212) : noiseBuf(ctx, 2, 777)), h = ctx.createBiquadFilter(); h.type = "highpass"; h.frequency.value = 5000;
        const sg = ctx.createGain(); sg.gain.value = 0; env.connect(sg.gain); const lv = ctx.createGain(); lv.gain.value = cfg.sib * 3; s.connect(h); h.connect(sg); sg.connect(lv); lv.connect(out);
      });
    }
    const merger = ctx.createChannelMerger(2); outL.connect(merger, 0, 0); outR.connect(merger, 0, 1); merger.connect(ctx.destination);
    if (reverb) {
      const rin = ctx.createGain(); rin.gain.value = 0.5; outL.connect(rin); outR.connect(rin);
      const plate = new AudioWorkletNode(ctx, "plate-reverb", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 1, channelCountMode: "explicit", processorOptions: { decay: cfg.decay, damp: 0.3, predelay: 18 } });
      const wet = ctx.createGain(); wet.gain.value = cfg.mix * plateScale(cfg.decay) * 2; rin.connect(plate); plate.connect(wet); wet.connect(ctx.destination);
    }
    const r = await ctx.startRendering();
    const L = new Float32Array(r.getChannelData(0)), R = new Float32Array(r.getChannelData(1));
    let m = 0; for (let i = 0; i < L.length; i++) m = Math.max(m, Math.abs(L[i]), Math.abs(R[i]));
    const k = m > 1e-9 ? 0.89 / m : 1; for (let i = 0; i < L.length; i++) { L[i] *= k; R[i] *= k; }
    let sl = 0, sr = 0, sx = 0; const end = Math.min(L.length, Math.floor(dur * SR)); for (let i = 0; i < end; i++) { sl += L[i] * L[i]; sr += R[i] * R[i]; sx += L[i] * R[i]; }
    const out = new AudioBuffer({ length: L.length, numberOfChannels: 2, sampleRate: SR }); out.copyToChannel(L, 0); out.copyToChannel(R, 1);
    return { buffer: out, corr: sx / Math.sqrt(sl * sr + 1e-12), tail, pans: pn, intervals: iv };
  }

  function wav2(L, R, sr) {
    const n = L.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf), w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + n * 4, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 4, true);
    const q = (x) => { x = Math.max(-1, Math.min(1, x)); return x < 0 ? x * 0x8000 : x * 0x7fff; };
    for (let i = 0; i < n; i++) { v.setInt16(44 + i * 4, q(L[i]), true); v.setInt16(46 + i * 4, q(R[i]), true); }
    return buf;
  }

  g.VocoderChoir = { SR, CHORDS, SCALES, intervals, pans, snapToScale, plateTail, render, wav2, setWorklets(a) { WORKLETS = a; } };
  if (typeof module !== "undefined") module.exports = g.VocoderChoir;
})(typeof globalThis !== "undefined" ? globalThis : this);
