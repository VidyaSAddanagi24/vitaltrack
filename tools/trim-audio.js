/*
 * Trim an MP3 to an exact duration without re-encoding.
 * Cuts on MPEG frame boundaries, so the result stays a valid stream.
 *
 *   node tools/trim-audio.js <src.mp3> <dst.mp3> <seconds>
 */
const fs = require('fs');

const BITRATES = {
  mpeg1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  mpeg2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
const RATES = {
  mpeg1: [44100, 48000, 32000],
  mpeg2: [22050, 24000, 16000],
  mpeg25: [11025, 12000, 8000],
};

function frameAt(buf, off) {
  if (off + 4 > buf.length) return null;
  if (buf[off] !== 0xff || (buf[off + 1] & 0xe0) !== 0xe0) return null;

  const verBits = (buf[off + 1] >> 3) & 0x3;   // 0=2.5, 1=reserved, 2=MPEG2, 3=MPEG1
  const layer   = (buf[off + 1] >> 1) & 0x3;   // 1 = Layer III
  if (verBits === 1 || layer !== 1) return null;

  const brIdx = (buf[off + 2] >> 4) & 0xf;
  const srIdx = (buf[off + 2] >> 2) & 0x3;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;

  const pad = (buf[off + 2] >> 1) & 0x1;
  const mpeg1 = verBits === 3;
  const table = mpeg1 ? BITRATES.mpeg1 : BITRATES.mpeg2;
  const rates = mpeg1 ? RATES.mpeg1 : verBits === 2 ? RATES.mpeg2 : RATES.mpeg25;

  const bitrate = table[brIdx] * 1000;
  const rate = rates[srIdx];
  const samples = mpeg1 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * bitrate) / rate) + pad;

  return { length, seconds: samples / rate };
}

function trim(src, dst, seconds) {
  const buf = fs.readFileSync(src);
  let off = 0;

  // Skip ID3v2 so the output starts on an audio frame.
  if (buf.slice(0, 3).toString() === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) |
                 ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    off = 10 + size;
  }

  const start = off;
  let elapsed = 0;
  let frames = 0;

  while (off < buf.length) {
    const f = frameAt(buf, off);
    if (!f) break;
    if (elapsed + f.seconds > seconds + 1e-6) break;
    elapsed += f.seconds;
    off += f.length;
    frames++;
  }

  if (!frames) throw new Error('no MPEG audio frames found in ' + src);
  fs.writeFileSync(dst, buf.slice(start, off));
  return { frames, seconds: elapsed, bytes: off - start };
}

const [src, dst, secs] = process.argv.slice(2);
if (!src || !dst || !secs) {
  console.error('usage: node tools/trim-audio.js <src.mp3> <dst.mp3> <seconds>');
  process.exit(1);
}
const r = trim(src, dst, Number(secs));
console.log(`${dst}: ${r.seconds.toFixed(3)}s, ${r.frames} frames, ${r.bytes} bytes`);
