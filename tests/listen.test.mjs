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

// ---- parallel listening ----
import { WhisperPool, inOrder, pickWorkers } from '../docs/js/listen.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('pickWorkers: a sensible number for the computer, or the person\'s own choice', () => {
  assert.equal(pickWorkers({ cores: 8 }), 2);                   // at most 2 on automatic: each worker holds ~1.1 GB
  assert.equal(pickWorkers({ cores: 16, memoryGB: 8 }), 2);
  assert.equal(pickWorkers({ cores: 4 }), 2);
  assert.equal(pickWorkers({ cores: 2 }), 1);
  assert.equal(pickWorkers({ cores: 16, memoryGB: 4 }), 1);     // low memory: one copy of the model
  assert.equal(pickWorkers({ cores: 16, memoryGB: 2 }), 1);
  assert.equal(pickWorkers({ cores: 16, gpu: true }), 1);        // the GPU does the work
  assert.equal(pickWorkers({ cores: 2, chosen: 4 }), 4);         // their choice wins
  assert.equal(pickWorkers({ cores: 8, chosen: 9 }), 4);
});

test('inOrder: runs several at once, commits strictly in order, never more than the limit', async () => {
  let running = 0, peak = 0;
  const delays = [50, 5, 30, 1, 40, 2, 20, 10];
  const committed = [];
  await inOrder({
    items: delays.map((_, i) => i), limit: 3,
    prepare: async (i) => async () => { running++; peak = Math.max(peak, running); await sleep(delays[i]); running--; return i * 10; },
    commit: (item, result) => committed.push([item, result]),
  });
  assert.deepEqual(committed, delays.map((_, i) => [i, i * 10]));
  assert.equal(peak, 3);
});

test('inOrder: preparing is one at a time; stopping abandons unfinished work but keeps the finished prefix', async () => {
  let preparing = 0, overlapped = false, stop = false;
  const committed = [];
  await inOrder({
    items: [0, 1, 2, 3, 4, 5], limit: 2,
    shouldStop: () => stop,
    prepare: async (i) => { if (preparing++) overlapped = true; await sleep(2); preparing--; return async () => { await sleep(i === 3 ? 500 : 5); return i; }; },
    commit: (item) => { committed.push(item); if (item === 2) stop = true; },
  });
  assert.equal(overlapped, false);
  assert.deepEqual(committed, [0, 1, 2]);      // 3 was still running when stop came, so it is not committed
});

test('inOrder: a failing job is reported, not swallowed', async () => {
  await assert.rejects(inOrder({
    items: [0, 1, 2], limit: 2,
    prepare: async (i) => async () => { await sleep(3); if (i === 1) throw new Error('worker crashed'); return i; },
    commit: () => {},
  }), /worker crashed/);
});

function fakeWorker({ delay = 5, failLoad = false } = {}) {
  const w = {
    busy: 0, peak: 0, calls: 0, loaded: false, stopped: false,
    async load() { if (failLoad) throw new Error('out of memory'); w.loaded = true; return 'wasm'; },
    async transcribe(_, offset) { w.calls++; w.busy++; w.peak = Math.max(w.peak, w.busy); await sleep(delay); w.busy--; return [{ word: 'x', start: offset, end: offset }]; },
    stop() { w.stopped = true; },
  };
  return w;
}

test('WhisperPool: each worker takes one request at a time and the work is shared out', async () => {
  const made = [];
  const pool = new WhisperPool(3, () => { const w = fakeWorker(); made.push(w); return w; });
  await pool.load('m', false);
  assert.ok(made.every((w) => w.loaded));
  await Promise.all(Array.from({ length: 12 }, (_, i) => pool.transcribe(new Float32Array(1), i)));
  assert.ok(made.every((w) => w.peak === 1), 'a worker is never given two at once');
  assert.ok(made.every((w) => w.calls >= 2), 'the work was shared');
});

test('WhisperPool: a worker that cannot start (e.g. out of memory) is dropped and the rest carry on', async () => {
  const made = [];
  const pool = new WhisperPool(3, () => { const w = fakeWorker({ failLoad: made.length === 2 }); made.push(w); return w; });
  let note = '';
  pool.onNote = (m) => { note = m; };
  await pool.load('m', false);
  assert.equal(pool.size, 2);
  assert.ok(made[2].stopped);
  assert.match(note, /Only 2 speech workers/);
  assert.deepEqual((await pool.transcribe(new Float32Array(1), 7)).map((w) => w.start), [7]);
});

// listen() with a fake speech pool. The fake "hears" headings from a known list, found through a time stamp placed at
// the start of each window's audio, so its output depends only on where in the book the audio is.
const HEADINGS = [100, 700, 1300, 1900, 2500];             // seconds into a 50-minute book
function bookAudio() {
  return { async decode(start, length) {
    const n = Math.round(Math.max(0, Math.min(length, 3000 - start)) * RATE);
    const a = new Float32Array(n).fill(0.3);
    a[0] = start;                                         // 0.3 is far above the silence limit, so nothing is squeezed
    return a;
  } };
}
function fakeSpeech(workers, delays) {
  const pool = new WhisperPool(workers, () => ({
    async load() { return 'wasm'; }, stop() {},
    async transcribe(samples) {
      const t0 = samples[0], len = samples.length / RATE;
      await sleep(delays(t0));
      const words = [];
      HEADINGS.filter((h) => h >= t0 && h + 5 < t0 + len).forEach((h, i) => {
        const n = HEADINGS.indexOf(h) + 1, at = h - t0;
        words.push({ word: 'story.', start: at - 1, end: at - 0.6 }, { word: 'Chapter', start: at, end: at + 0.4 },
          { word: String(n), start: at + 0.4, end: at + 0.8 }, { word: `Part ${n}.`, start: at + 0.9, end: at + 1.6 });
      });
      return words;
    },
  }));
  return pool;
}

test('listen(): same chapters, same order, whatever the number of workers or how long each window takes', async () => {
  const run = async (workers, delays) => {
    const events = [], scanned = [];
    const pool = fakeSpeech(workers, delays);
    await pool.load('m', false);
    const chs = await listen({ audio: bookAudio(), duration: 3000, mode: 'thorough', whisper: pool, shouldStop: () => false,
      onProgress() {}, onChapters: (_, a) => events.push(a.title), onScanned: (t) => scanned.push(t) });
    return { chs, events, scanned };
  };
  const one = await run(1, () => 0);
  assert.deepEqual(one.chs.map((c) => c.title), ['Chapter 1: Part 1', 'Chapter 2: Part 2', 'Chapter 3: Part 3', 'Chapter 4: Part 4', 'Chapter 5: Part 5']);
  const three = await run(3, (t) => (t === 0 ? 60 : t === 600 ? 5 : 20));         // window 1 finishes first, window 0 last
  assert.deepEqual(three.chs, one.chs);
  assert.deepEqual(three.events, one.events);
  assert.deepEqual(three.scanned, [600, 1200, 1800, 2400, 3000], 'listened-up-to only moves forward, never skips');
});

test('listen(): stopping part way, then resuming, gives the same chapters as one uninterrupted run', async () => {
  const whole = await listen({ audio: bookAudio(), duration: 3000, mode: 'thorough', shouldStop: () => false, onProgress() {},
    onChapters() {}, whisper: await (async () => { const p = fakeSpeech(3, () => 3); await p.load('m'); return p; })() });
  let scanned = 0, partial = [], stop = false;
  const pool1 = fakeSpeech(3, (t) => (t >= 1800 ? 80 : 3)); await pool1.load('m');
  await listen({ audio: bookAudio(), duration: 3000, mode: 'thorough', whisper: pool1, shouldStop: () => stop, onProgress() {},
    onChapters() {}, onScanned: (t, list) => { scanned = t; partial = list; if (t >= 1200) stop = true; } });
  assert.ok(scanned >= 1200 && scanned < 3000);
  const pool2 = fakeSpeech(2, () => 1); await pool2.load('m');
  const resumed = await listen({ audio: bookAudio(), duration: 3000, mode: 'thorough', whisper: pool2, shouldStop: () => false, onProgress() {},
    onChapters() {}, from: scanned, initial: partial });
  assert.deepEqual(resumed, whole);
});
