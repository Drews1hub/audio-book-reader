// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { listen } from '../docs/js/listen.js';

const RATE = 16000;
// Fake 50-minute book: steady tone with a 3 s pause every 7 minutes.
const DURATION = 3000;
const PAUSES = [420, 840, 1260, 1680, 2100, 2520, 2940];
const audio = {
  async decode(start, length) {
    const n = Math.max(0, Math.min(length, DURATION - start)) * RATE;
    const out = new Float32Array(Math.round(n)).fill(0.3);
    for (const p of PAUSES) {
      const a = Math.round((p - start) * RATE), b = Math.round((p + 3 - start) * RATE);
      if (b > 0 && a < out.length) out.fill(0, Math.max(0, a), Math.min(out.length, b));
    }
    return out;
  },
};
const run = (opts) => listen({ audio, duration: DURATION, mode: 'pauses', onProgress() {}, onChapters() {}, ...opts });

test('pause mode finds the long pauses', async () => {
  const chs = await run({ shouldStop: () => false });
  assert.deepEqual(chs.map((c) => Math.round(c.start)), [0, ...PAUSES.map((p) => p + 3)]);
});

test('a stopped run resumes to the same result', async () => {
  const full = await run({ shouldStop: () => false });
  let scanned = 0, partial = [], windows = 0;
  await run({ shouldStop: () => windows >= 2, onScanned: (t, list) => { scanned = t; partial = list; windows++; } });
  assert.equal(scanned, 1200);                       // two 10-minute windows done
  const resumed = await run({ shouldStop: () => false, from: scanned, initial: partial });
  assert.deepEqual(resumed, full);
});
