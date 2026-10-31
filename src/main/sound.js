'use strict';

/**
 * sound.js — completion chimes.
 *
 * A small software synth: each sound is a short list of notes rendered into a
 * 16-bit mono WAV buffer at 44.1 kHz, written next to the app data and played
 * with an invisible audio window (no external files, no network, no plugins).
 *
 *   done — rising major arpeggio (C5 E5 G5 C6) with a soft bell envelope
 *   fail — falling minor third (G4 D4) with a slight buzz
 */

const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;

/** One note with a soft attack/decay "bell" envelope. */
function renderNote(buf, startSec, freq, durSec, gain, { harmonics = [1, 0.32, 0.14], decay = 3.2 } = {}) {
  const start = Math.floor(startSec * SAMPLE_RATE);
  const total = Math.floor(durSec * SAMPLE_RATE);
  for (let i = 0; i < total; i += 1) {
    const t = i / SAMPLE_RATE;
    // fast attack (6 ms) then exponential decay
    const attack = Math.min(1, t / 0.006);
    const env = attack * Math.exp(-decay * t);
    let s = 0;
    for (let h = 0; h < harmonics.length; h += 1) {
      s += harmonics[h] * Math.sin(2 * Math.PI * freq * (h + 1) * t);
    }
    const idx = start + i;
    if (idx >= buf.length) break;
    buf[idx] += s * env * gain;
  }
}

function normalize(buf, peak = 0.82) {
  let max = 0;
  for (let i = 0; i < buf.length; i += 1) max = Math.max(max, Math.abs(buf[i]));
  if (max === 0) return buf;
  const k = peak / max;
  for (let i = 0; i < buf.length; i += 1) buf[i] *= k;
  return buf;
}

function toWav(floatSamples) {
  const data = Buffer.alloc(floatSamples.length * 2);
  for (let i = 0; i < floatSamples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, floatSamples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Renders both chimes. Kept deterministic so the files never flap between runs.
 */
function renders() {
  // success: C5 -> E5 -> G5 -> C6, bright and resolving
  const okLen = Math.floor(1.05 * SAMPLE_RATE);
  const ok = new Float32Array(okLen);
  renderNote(ok, 0.0, 523.25, 0.9, 0.85);
  renderNote(ok, 0.09, 659.25, 0.9, 0.8);
  renderNote(ok, 0.18, 783.99, 0.9, 0.78);
  renderNote(ok, 0.27, 1046.5, 1.0, 0.9, { harmonics: [1, 0.4, 0.2, 0.08], decay: 2.4 });
  normalize(ok);

  // failure: G4 -> D4, falling, with a little dissonance to sound "wrong"
  const badLen = Math.floor(0.85 * SAMPLE_RATE);
  const bad = new Float32Array(badLen);
  renderNote(bad, 0.0, 392.0, 0.6, 0.9, { harmonics: [1, 0.5, 0.34, 0.2], decay: 4.5 });
  renderNote(bad, 0.16, 293.66, 0.7, 0.9, { harmonics: [1, 0.55, 0.4, 0.26], decay: 4.2 });
  renderNote(bad, 0.16, 311.13, 0.7, 0.32, { harmonics: [1, 0.3], decay: 5.5 }); // sour beat
  normalize(bad, 0.75);

  return { done: toWav(ok), fail: toWav(bad) };
}

/**
 * Writes the sounds into `dir` (once) and returns their paths.
 * Anything that fails here is non-fatal: the caller simply skips the chime.
 */
function ensureSoundFiles(dir) {
  const out = { done: path.join(dir, 'chime-done.wav'), fail: path.join(dir, 'chime-fail.wav') };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const needDone = !fs.existsSync(out.done) || fs.statSync(out.done).size < 1000;
    const needFail = !fs.existsSync(out.fail) || fs.statSync(out.fail).size < 1000;
    if (needDone || needFail) {
      const wavs = renders();
      fs.writeFileSync(out.done, wavs.done);
      fs.writeFileSync(out.fail, wavs.fail);
    }
    return out;
  } catch {
    return null;
  }
}

module.exports = { renders, ensureSoundFiles, SAMPLE_RATE };
