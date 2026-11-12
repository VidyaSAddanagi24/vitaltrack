/* Generates the watch notification chime (16-bit PCM mono WAV).
   Review and urgent alerts use trimmed MP3s — see tools/trim-audio.js. */
const fs = require('fs');
const path = require('path');

const RATE = 16000;

function wav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    let v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

function normalize(samples, peak) {
  let m = 0;
  for (const s of samples) m = Math.max(m, Math.abs(s));
  if (!m) return samples;
  const k = peak / m;
  return samples.map(s => s * k);
}

function toneInto(out, start, dur, freq, amp, opts = {}) {
  const { harmonics = [1, 0.45, 0.22], attack = 0.012, release = 0.05 } = opts;
  const s0 = Math.floor(start * RATE);
  const n = Math.floor(dur * RATE);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    let env = 1;
    if (t < attack) env = t / attack;
    const left = dur - t;
    if (left < release) env *= left / release;
    let v = 0;
    harmonics.forEach((h, k) => { v += h * Math.sin(2 * Math.PI * freq * (k + 1) * t); });
    const idx = s0 + i;
    if (idx < out.length) out[idx] += v * amp * env;
  }
}

/* Watch — soft two-note chime, ~1.4 s */
function watchChime() {
  const out = new Float32Array(Math.floor(1.4 * RATE));
  toneInto(out, 0.00, 0.55, 880, 0.55, { harmonics: [1, 0.25, 0.08], release: 0.4 });
  toneInto(out, 0.34, 0.75, 1174.7, 0.5, { harmonics: [1, 0.22, 0.06], release: 0.6 });
  return out;
}

const dir = process.argv[2] || 'res/android/raw';
fs.mkdirSync(dir, { recursive: true });

const p = path.join(dir, 'vt_watch.wav');
fs.writeFileSync(p, wav(normalize(watchChime(), 0.72)));
console.log('vt_watch.wav', (1400 / 1000).toFixed(2) + 's', fs.statSync(p).size + ' bytes');
