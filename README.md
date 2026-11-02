Copyright © 2026 Lewis James Seals Jr. All rights reserved. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
# Robot Choir

One speech input drives the band envelopes of a channel vocoder; the carrier is a choir of 4-8 drifting sawtooth voices (chord stacks, per-voice detune and vibrato, stereo spread) set in a plate reverb. Speech comes out sung. No dependencies: open `index.html` (serve over http for AudioWorklet support, e.g. `python3 -m http.server`).

Controls: voices, chord and root, follow-the-speech-melody (pitch snapped to a scale, chord planed on top), stereo spread, unison detune, analog drift, band count, uncanny cues (vibrato, breath, consonant hiss and sibilance), reverb mix and plate decay. Load your own audio or record. `index.html` saves a stereo WAV.

## Layout
`src/core.js` (band layouts, pitch tracker; from the Dudley Vocoder), `src/engine.js` (envelope display data and demo phrase), `src/choir.js` (stereo choir render), `vendor/` (the Analog Drift oscillator worklet and the plate/hall reverb worklets), `demo/template.html`, `build.py` -> `index.html`, `artifact.html`. Test: `NODE_PATH=$(npm root -g) node tests/browser.test.cjs` (Playwright, Chromium).

## Measured (headless Chromium, offline render)
- Chord tones appear: with 4 voices the energy at the major third and fifth above the root is hundreds of times higher than with 1 voice.
- Stereo spread 0 gives L/R correlation 1.00; spread 1 gives 0.57. All-features render with 8 voices: 0.00.
- Reverb adds a tail: the dry render is silent after the speech ends (energy about 1e-30), the reverb render keeps ringing (energy 2.3 in the same units), and it is 2.4 s longer.
- Identical settings render the same to within 1e-5 of full scale. Drift changes the signal.
- With consonants on, the 20 ms envelope of the output tracks the speech at 0.95 correlation.
- No horizontal overflow at 400 px; no console errors.

## Not checked
How it sounds. Whether the words stay intelligible. Whether the cues read as human. The plate coefficients were written from memory and not checked against Dattorro's paper. Voice allocation and choir seating are my design choices.

See CREDITS.md.
