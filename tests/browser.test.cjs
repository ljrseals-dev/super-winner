const { chromium } = require("playwright"), http = require("http"), fs = require("fs"), path = require("path"), assert = require("assert");
const file = process.argv[2] || path.join(__dirname, "../index.html"), shots = path.join(__dirname, "..");
const server = http.createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end(fs.readFileSync(file)); });
(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 1000 }, colorScheme: "dark" })).newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_|fonts\./.test(m.text())) errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__rc && window.__rc.ready() >= 1, null, { timeout: 90000 });
  await page.screenshot({ path: path.join(shots, "shot-dark.png"), fullPage: true });

  const R = await page.evaluate(async () => {
    const { S, C, K, cfgNow } = window.__rc, SR = 44100;
    const base = Object.assign(cfgNow(), { vibrato: false, breath: false, consonants: false, sib: 0, drift: 0, detune: 0, mix: 0, follow: false, rootPc: 0, chord: "major", spread: 0.8 });
    const run = async (o) => { const r = await K.render(S.buf, S.pitch, Object.assign({}, base, o)); return { L: r.buffer.getChannelData(0), R: r.buffer.getChannelData(1), corr: r.corr, dur: r.buffer.duration, pans: r.pans }; };
    const spec = (sig, from, to) => { const N = 16384, re = new Float64Array(N), im = new Float64Array(N), P = new Float64Array(N / 2);
      for (let s0 = Math.floor(from * SR); s0 + N <= Math.floor(to * SR); s0 += N / 2) { for (let i = 0; i < N; i++) { re[i] = sig[s0 + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); im[i] = 0; }
        for (let i = 1, j = 0; i < N; i++) { let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; } }
        for (let len = 2; len <= N; len <<= 1) { const ang = -2 * Math.PI / len; for (let i = 0; i < N; i += len) for (let k = 0; k < len / 2; k++) { const wr = Math.cos(ang * k), wi = Math.sin(ang * k), a = i + k, b = i + k + len / 2, tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; } }
        for (let k = 0; k < N / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k]; } return P; };
    const at = (P, hz) => { const N = 16384, k = Math.round(hz * N / SR); let m = 0; for (let j = k - 3; j <= k + 3; j++) m = Math.max(m, P[j]); return m; };
    const rms = (a, f, hop) => { let s = 0; for (let i = 0; i < hop; i++) { const v = a[f * hop + i] || 0; s += v * v; } return Math.sqrt(s / hop); };
    const out = {};
    // pitches: root C3 = 130.81, E3 = 164.81 (major third), G3 = 196.0
    const v1 = await run({ voices: 1 }), v4 = await run({ voices: 4 });
    const P1 = spec(v1.L, 0.3, 2.6), P4 = spec(v4.L, 0.3, 2.6);
    out.third = { v1: at(P1, 164.81) / at(P1, 130.81), v4: at(P4, 164.81) / at(P4, 130.81) };
    out.fifth = { v1: at(P1, 196.0) / at(P1, 130.81), v4: at(P4, 196.0) / at(P4, 130.81) };
    // stereo
    const s0 = await run({ voices: 6, spread: 0 }), s1 = await run({ voices: 6, spread: 1 });
    out.corr = { spread0: s0.corr, spread1: s1.corr };
    // reverb tail: energy after the dry end
    const dry = await run({ voices: 6, mix: 0 }), wet = await run({ voices: 6, mix: 0.5, decay: 0.62 });
    const tailE = (r, from) => { let e = 0; for (let i = Math.floor(from * SR); i < r.L.length; i++) e += r.L[i] * r.L[i] + r.R[i] * r.R[i]; return e; };
    const dd = S.buf.duration;
    out.tail = { dry: tailE(dry, dd + 0.05), wet: tailE(wet, dd + 0.05), wetDur: wet.dur, dryDur: dry.dur };
    // determinism and drift
    const a = await run({ voices: 4, drift: 1.5 }), b = await run({ voices: 4, drift: 1.5 }), d0 = await run({ voices: 4, drift: 0 });
    let md = 0, dd0 = 0; for (let i = 0; i < a.L.length; i++) { md = Math.max(md, Math.abs(a.L[i] - b.L[i])); dd0 = Math.max(dd0, Math.abs(a.L[i] - d0.L[i])); }
    out.det = { same: md, driftVsNone: dd0 };
    // envelope follows speech: 20 ms rms correlation of dry choir vs input
    const cons = await run({ voices: 6, mix: 0, consonants: true, sib: 0.4 });
    const hop = Math.round(0.02 * SR), x = S.buf.getChannelData(0), y = cons.L, nf = Math.floor(x.length / hop - 1), A = [], B = [];
    for (let f = 0; f < nf; f++) { A.push(rms(x, f, hop)); B.push(rms(y, f, hop)); }
    const mean = (q) => q.reduce((s, v) => s + v, 0) / q.length, ma = mean(A), mb = mean(B); let c = 0, va = 0, vb = 0;
    for (let i = 0; i < nf; i++) { c += (A[i] - ma) * (B[i] - mb); va += (A[i] - ma) ** 2; vb += (B[i] - mb) ** 2; }
    out.envCorr = c / Math.sqrt(va * vb);
    // follow mode renders finite, not silent; all options on
    const f = await run({ voices: 8, follow: true, scale: "minor", vibrato: true, breath: true, consonants: true, sib: 0.4, drift: 1, detune: 12, mix: 0.35 });
    let pk = 0, nan = 0; for (let i = 0; i < f.L.length; i++) { pk = Math.max(pk, Math.abs(f.L[i]), Math.abs(f.R[i])); if (!isFinite(f.L[i]) || !isFinite(f.R[i])) nan++; }
    out.all = { pk, nan, corr: f.corr };
    out.pans = { n6: s1.pans };
    return out;
  });
  console.log(JSON.stringify(R, (k, v) => typeof v === "number" ? +v.toPrecision(4) : v));
  assert(R.third.v4 > R.third.v1 * 8, "chord third appears with 4 voices: " + JSON.stringify(R.third));
  assert(R.fifth.v4 > R.fifth.v1 * 8, "chord fifth appears with 4 voices: " + JSON.stringify(R.fifth));
  assert(R.corr.spread1 < R.corr.spread0 - 0.15, "spread decorrelates L/R: " + JSON.stringify(R.corr));
  assert(R.tail.wet > R.tail.dry * 20 + 1e-9, "reverb adds a tail: " + JSON.stringify(R.tail));
  assert(R.tail.wetDur > R.tail.dryDur, "reverb lengthens the render");
  assert(R.det.same < 1e-4, "same settings render identically: " + R.det.same);
  assert(R.det.driftVsNone > 0.01, "drift changes the signal: " + R.det.driftVsNone);
  assert(R.envCorr > 0.8, "choir (with consonants) follows speech envelope: " + R.envCorr);
  assert(R.all.pk > 0.8 && R.all.pk <= 0.9 && R.all.nan === 0, "all-features render sane: " + JSON.stringify(R.all));
  assert(new Set(R.pans.n6.map((v) => v.toFixed(3))).size === 6, "six distinct pans");
  // UI
  const r0 = await page.evaluate(() => window.__rc.ready());
  await page.selectOption("#chord", "minor"); await page.waitForFunction((b) => window.__rc.ready() > b, r0, { timeout: 90000 });
  assert.equal(await page.evaluate(() => window.__rc.S.cfg.chord), "minor");
  await page.click("#playV"); await page.waitForTimeout(500); assert.equal(await page.getAttribute("#playV", "aria-pressed"), "true"); await page.click("#stop");
  const ph = await (await browser.newContext({ viewport: { width: 400, height: 900 }, colorScheme: "light" })).newPage();
  await ph.goto(`http://127.0.0.1:${server.address().port}/`); await ph.waitForFunction(() => window.__rc && window.__rc.ready() >= 1, null, { timeout: 90000 });
  await ph.screenshot({ path: path.join(shots, "shot-phone.png"), fullPage: true });
  assert((await ph.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0, "no horizontal overflow");
  assert.equal(errs.length, 0, errs.join("\n"));
  console.log("robot choir browser tests ok; save button:", !!(await page.$("#dl")));
  await browser.close(); server.close();
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
