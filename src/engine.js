/* Dudley Vocoder: Web Audio engine. Everything renders offline so playback, display and WAV export share one buffer. */
(function (g) {
  "use strict";
  const C = g.VocoderCore;
  const SR = 44100;

  function bandFilter(ctx, band, qScale) {
    const a = ctx.createBiquadFilter(), b = ctx.createBiquadFilter();
    if (band.lo <= 0) {
      a.type = b.type = "lowpass"; a.frequency.value = b.frequency.value = band.hi; a.Q.value = b.Q.value = 0.707;
    } else {
      const fc = Math.sqrt(band.lo * band.hi), q = (fc / (band.hi - band.lo)) * (qScale || 1);
      a.type = b.type = "bandpass"; a.frequency.value = b.frequency.value = fc; a.Q.value = b.Q.value = q;
    }
    a.connect(b);
    return { in: a, out: b };
  }

  // Full-wave rectifier, two-pole smoothing, scaled so a steady sine reads its amplitude.
  function envelope(ctx, from, cutoff) {
    const ws = ctx.createWaveShaper(); ws.curve = new Float32Array([1, 0, 1]);
    const l1 = ctx.createBiquadFilter(), l2 = ctx.createBiquadFilter(), mk = ctx.createGain();
    l1.type = l2.type = "lowpass"; l1.frequency.value = l2.frequency.value = cutoff; l1.Q.value = l2.Q.value = 0.707;
    mk.gain.value = Math.PI / 2;
    from.connect(ws); ws.connect(l1); l1.connect(l2); l2.connect(mk);
    return mk;
  }

  function noiseBuffer(ctx, secs) {
    const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * secs), ctx.sampleRate), d = b.getChannelData(0);
    let s = 12345;
    for (let i = 0; i < d.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = (s / 2147483648 - 1) * 0.9; }
    return b;
  }
  function noiseSrc(ctx, buf) { const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true; n.start(0); return n; }

  function monoIn(ctx, buf) {
    const src = ctx.createBufferSource(); src.buffer = buf;
    const m = ctx.createGain(); m.channelCount = 1; m.channelCountMode = "explicit"; m.channelInterpretation = "speakers";
    src.connect(m); src.start(0);
    return m;
  }

  function offlineFor(buf) { return new OfflineAudioContext(1, Math.ceil(buf.duration * SR), SR); }

  function normalize(d, peak) {
    let m = 0; for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > m) m = a; }
    if (m > 1e-9) { const k = peak / m; for (let i = 0; i < d.length; i++) d[i] *= k; }
    return d;
  }

  /**
   * cfg: { bands:[{lo,hi}], qScale, envCut, carrier:'buzz'|'chord'|'noise', hard:boolean,
   *        semis, monotone, monoHz, chordRoot, chordType, hissLevel, sibilance }
   * pitch: result of trackPitch for buf.
   */
  async function render(buf, pitch, cfg) {
    const ctx = offlineFor(buf), dur = buf.duration;
    const input = monoIn(ctx, buf);
    const out = ctx.createGain(); out.gain.value = 1; out.connect(ctx.destination);
    const nz = noiseBuffer(ctx, 2);
    const shift = Math.pow(2, (cfg.semis || 0) / 12);
    const nF = pitch.f0.length, T = nF * pitch.hop;
    const f0c = new Float32Array(nF);
    for (let i = 0; i < nF; i++) f0c[i] = Math.max(20, Math.min(ctx.sampleRate / 2.5, (cfg.monotone ? cfg.monoHz || 110 : pitch.f0[i]) * shift));
    const vSrc = cfg.hard ? pitch.voiced : C.smoothTrack(pitch.voiced, 2);
    const vc = Float32Array.from(vSrc), uc = Float32Array.from(vSrc, (v) => 1 - v);

    const car = ctx.createGain(); car.gain.value = 1;
    // White noise spreads its power over the whole spectrum; a buzz packs it into the passband. Scale the hiss to the passband.
    const top = cfg.bands[cfg.bands.length - 1].hi, hissK = Math.sqrt(ctx.sampleRate / 2 / top);
    if (cfg.carrier === "buzz") {
      // pulse-like spectrum (amplitude 1/sqrt(n)), closer to a relaxation oscillator than a sawtooth
      const H = 200, re = new Float32Array(H + 1), im = new Float32Array(H + 1);
      for (let n = 1; n <= H; n++) im[n] = 1 / Math.sqrt(n);
      const o = ctx.createOscillator(); o.setPeriodicWave(ctx.createPeriodicWave(re, im)); o.frequency.setValueCurveAtTime(f0c, 0, T); o.start(0);
      const gv = ctx.createGain(); gv.gain.setValueCurveAtTime(vc, 0, T);
      o.connect(gv); gv.connect(car);
      const gu = ctx.createGain(); gu.gain.setValueCurveAtTime(uc, 0, T);
      const k = ctx.createGain(); k.gain.value = (cfg.hissLevel == null ? 1 : cfg.hissLevel) * hissK;
      noiseSrc(ctx, nz).connect(gu); gu.connect(k); k.connect(car);
    } else if (cfg.carrier === "chord") {
      const ratios = C.CHORDS[cfg.chordType || "minor7"], root = cfg.chordRoot || 130.81;
      ratios.forEach((r, i) => {
        [-1, 1].forEach((sg) => {
          const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = root * r; o.detune.value = sg * (5 + i * 1.5); o.start(0);
          const gn = ctx.createGain(); gn.gain.value = 0.5 / ratios.length; o.connect(gn); gn.connect(car);
        });
      });
      const gu = ctx.createGain(); gu.gain.setValueCurveAtTime(uc, 0, T);
      const k = ctx.createGain(); k.gain.value = (cfg.hissLevel == null ? 0.6 : cfg.hissLevel) * hissK;
      noiseSrc(ctx, nz).connect(gu); gu.connect(k); k.connect(car);
    } else {
      noiseSrc(ctx, nz).connect(car);
    }

    cfg.bands.forEach((band) => {
      const a = bandFilter(ctx, band, cfg.qScale), s = bandFilter(ctx, band, cfg.qScale);
      input.connect(a.in);
      const env = envelope(ctx, a.out, cfg.envCut);
      const sg = ctx.createGain(); sg.gain.value = 0;
      env.connect(sg.gain);
      const eq = ctx.createGain(); eq.gain.value = Math.pow(10, C.eqGainDb(cfg.eqDb, Math.sqrt(Math.max(band.lo, 50) * band.hi)) / 20);
      car.connect(s.in); s.out.connect(sg); sg.connect(eq); eq.connect(out);
    });

    if (cfg.sibilance > 0) {
      const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 5000; hp.Q.value = 0.707;
      input.connect(hp);
      const env = envelope(ctx, hp, 80);
      const n = noiseSrc(ctx, nz), nh = ctx.createBiquadFilter(); nh.type = "highpass"; nh.frequency.value = 5000;
      const sg = ctx.createGain(); sg.gain.value = 0; env.connect(sg.gain);
      const lv = ctx.createGain(); lv.gain.value = cfg.sibilance * 3;
      n.connect(nh); nh.connect(sg); sg.connect(lv); lv.connect(out);
    }

    const r = await ctx.startRendering();
    const d = new Float32Array(r.getChannelData(0));
    normalize(d, 0.89);
    const ob = new AudioBuffer({ length: d.length, numberOfChannels: 1, sampleRate: SR });
    ob.copyToChannel(d, 0);
    return ob;
  }

  /** Channel envelopes at 100 Hz, for the display. Returns {n, frames, data[frame*n+band]}. */
  async function envelopes(buf, cfg) {
    const n = cfg.bands.length, len = Math.ceil(buf.duration * SR);
    const ctx = new OfflineAudioContext(n, len, SR);
    const input = monoIn(ctx, buf), merger = ctx.createChannelMerger(n);
    cfg.bands.forEach((band, i) => {
      const a = bandFilter(ctx, band, cfg.qScale); input.connect(a.in);
      envelope(ctx, a.out, cfg.envCut).connect(merger, 0, i);
    });
    merger.connect(ctx.destination);
    const r = await ctx.startRendering();
    const hop = Math.round(SR / 100), frames = Math.floor(len / hop), data = new Float32Array(frames * n);
    for (let b = 0; b < n; b++) {
      const ch = r.getChannelData(b);
      for (let f = 0; f < frames; f++) { let m = 0; for (let k = 0; k < hop; k += 4) m += Math.abs(ch[f * hop + k]); data[f * n + b] = m / (hop / 4); }
    }
    return { n, frames, data };
  }

  /** Synthetic speech-like phrase used as the default modulator ("see saw sue, ay-oh"). */
  async function demo() {
    const F = { i: [270, 2290, 3010], a: [730, 1090, 2440], u: [300, 870, 2240], e: [530, 1840, 2480], o: [570, 840, 2410] };
    const segs = [["s", 0.2], ["v", "i", 0.42], ["s", 0.16], ["v", "a", 0.46], ["s", 0.16], ["v", "u", 0.42], ["x", 0.14], ["v", "e", 0.36], ["v", "o", 0.55], ["x", 0.3]];
    const total = segs.reduce((t, s) => t + s[s.length - 1], 0);
    const ctx = new OfflineAudioContext(1, Math.ceil(total * SR), SR);
    const src = ctx.createOscillator(); src.type = "sawtooth";
    const nF = 400, curve = new Float32Array(nF);
    for (let i = 0; i < nF; i++) { const t = (i / nF) * total; curve[i] = 122 * (1 + 0.1 * Math.sin((2 * Math.PI * t) / 1.9)) - 9 * t; }
    src.frequency.setValueCurveAtTime(curve, 0, total); src.start(0);
    const vg = ctx.createGain(); vg.gain.value = 0; src.connect(vg);
    const fm = [0, 1, 2].map((k) => { const b = ctx.createBiquadFilter(); b.type = "bandpass"; b.Q.value = [8, 10, 12][k]; b.frequency.value = 500; const g2 = ctx.createGain(); g2.gain.value = [1, 0.6, 0.3][k]; vg.connect(b); b.connect(g2); g2.connect(ctx.destination); return b; });
    const nb = noiseBuffer(ctx, 1), nsrc = noiseSrc(ctx, nb), nbp = ctx.createBiquadFilter(); nbp.type = "bandpass"; nbp.frequency.value = 6200; nbp.Q.value = 1.2;
    const fg = ctx.createGain(); fg.gain.value = 0; nsrc.connect(nbp); nbp.connect(fg); fg.connect(ctx.destination);
    let t = 0;
    segs.forEach((s) => {
      const d = s[s.length - 1];
      if (s[0] === "s") { fg.gain.setTargetAtTime(0.9, t, 0.01); fg.gain.setTargetAtTime(0, t + d - 0.03, 0.01); }
      if (s[0] === "v") {
        fm.forEach((b, k) => b.frequency.setTargetAtTime(F[s[1]][k], t, 0.03));
        vg.gain.setTargetAtTime(0.5, t, 0.012); vg.gain.setTargetAtTime(0.0, t + d - 0.02, 0.012);
      }
      t += d;
    });
    const r = await ctx.startRendering();
    const d = new Float32Array(r.getChannelData(0)); normalize(d, 0.7);
    const ob = new AudioBuffer({ length: d.length, numberOfChannels: 1, sampleRate: SR }); ob.copyToChannel(d, 0);
    return ob;
  }

  /** Live, hand-played synthesizer in the manner of the 1939 Voder: ten keys, a wrist bar (buzz or hiss), a pitch pedal. */
  function voder(ctx, dest) {
    const bands = C.dudleyBands(), master = ctx.createGain(), lim = ctx.createDynamicsCompressor();
    master.gain.value = 0.5; lim.threshold.value = -12; lim.knee.value = 6; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.12;
    master.connect(lim); lim.connect(dest);
    const BUZZ = 5; // the peak-normalized pulse wave is weak per band; bring one key of buzz up to the level of one key of hiss
    const H = 200, re = new Float32Array(H + 1), im = new Float32Array(H + 1);
    for (let n = 1; n <= H; n++) im[n] = 1 / Math.sqrt(n);
    const osc = ctx.createOscillator(); osc.setPeriodicWave(ctx.createPeriodicWave(re, im)); osc.frequency.value = 110; osc.start();
    const nz = noiseSrc(ctx, noiseBuffer(ctx, 2)), hissK = Math.sqrt(ctx.sampleRate / 2 / 2950);
    const buzzG = ctx.createGain(), hissG = ctx.createGain(), car = ctx.createGain();
    buzzG.gain.value = BUZZ; hissG.gain.value = 0;
    osc.connect(buzzG); nz.connect(hissG); buzzG.connect(car); hissG.connect(car);
    const keys = bands.map((b) => {
      const f = bandFilter(ctx, b, 1), kg = ctx.createGain(), eq = ctx.createGain();
      kg.gain.value = 0; car.connect(f.in); f.out.connect(kg); kg.connect(eq); eq.connect(master);
      return { kg, eq };
    });
    const T = (t) => (t == null ? ctx.currentTime : t);
    return {
      keys: keys.length, master,
      setKey(i, on, t) { keys[i].kg.gain.setTargetAtTime(on ? 1 : 0, T(t), 0.012); },
      setSource(mode, t) { buzzG.gain.setTargetAtTime(mode === "hiss" ? 0 : BUZZ, T(t), 0.006); hissG.gain.setTargetAtTime(mode === "hiss" ? hissK : 0, T(t), 0.006); },
      setPitch(hz, t) { osc.frequency.setTargetAtTime(hz, T(t), 0.03); },
      setEq(db) { keys.forEach((k, i) => { k.eq.gain.value = Math.pow(10, db[i] / 20); }); }
    };
  }

  g.VocoderEngine = { voder, SR, render, envelopes, demo };
})(typeof globalThis !== "undefined" ? globalThis : this);
