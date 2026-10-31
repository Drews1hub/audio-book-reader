// Walks through the book window by window and builds the chapter list.
import { findAnnouncements, findSilences, squeezeSilences, unsqueeze } from './chapters.js';
import { RATE } from './audio.js';

export class Whisper {
  constructor() {
    this.worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.onDownload = () => {};
    this.onNote = () => {};
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'download') this.onDownload(data);
      else if (data.type === 'note') this.onNote(data.message);
      else if (data.type === 'loaded') this.pending.get('load')?.resolve(data.device);
      else if (data.type === 'result') this.pending.get(data.id)?.resolve(data.words);
      else if (data.type === 'error') (this.pending.get(data.id ?? 'load') || this.pending.get('load'))?.reject(new Error(data.message));
    };
    this.worker.onerror = (e) => [...this.pending.values()].forEach((p) => p.reject(new Error(e.message || 'Speech worker crashed')));
  }
  _call(key, msg, transfer = []) {
    return new Promise((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
      this.worker.postMessage(msg, transfer);
    }).finally(() => this.pending.delete(key));
  }
  load(model, gpu) { return this._call('load', { type: 'load', model, gpu }); }
  transcribe(audio, offset) {
    const id = this.nextId++;
    // Copied, not transferred: the caller still needs the samples (e.g. to measure pauses) afterwards.
    return this._call(id, { type: 'transcribe', id, audio, offset });
  }
  stop() { this.worker.terminate(); }
}

/**
 * How many speech workers to run at once: one per two processor cores (up to 3), fewer on low-memory computers,
 * one for the GPU. `chosen` is the person's own pick (1-4); 0 or undefined means automatic.
 */
export function pickWorkers({ cores = 2, memoryGB, gpu = false, chosen = 0 } = {}) {
  if (gpu) return 1;
  if (chosen >= 1) return Math.min(4, Math.floor(chosen));
  let n = Math.max(1, Math.min(3, Math.floor(cores / 2)));
  if (memoryGB && memoryGB <= 2) n = 1;
  else if (memoryGB && memoryGB <= 4) n = Math.min(n, 2);
  return n;
}

/**
 * Several speech workers behind one `transcribe()`. Each worker holds its own copy of the model and handles one
 * request at a time; extra requests wait for a free worker. Same interface as `Whisper`.
 */
export class WhisperPool {
  constructor(size = 1, make = () => new Whisper()) {
    this.workers = Array.from({ length: Math.max(1, size) }, make);
    this.idle = [...this.workers];
    this.waiting = [];
    this.onDownload = () => {};
    this.onNote = () => {};
    this.workers[0].onDownload = (d) => this.onDownload(d);
    this.workers[0].onNote = (m) => this.onNote(m);
  }
  get size() { return this.workers.length; }
  async load(model, gpu) {
    // The first worker fetches the files (so the browser caches them); the rest then load from the cache.
    const device = await this.workers[0].load(model, gpu);
    const rest = this.workers.slice(1);
    const results = await Promise.allSettled(rest.map((w) => w.load(model, gpu)));
    const dropped = rest.filter((_, i) => results[i].status === 'rejected');
    if (dropped.length) {   // e.g. not enough memory for another copy: carry on with fewer
      dropped.forEach((w) => { w.stop(); this.workers.splice(this.workers.indexOf(w), 1); this.idle.splice(this.idle.indexOf(w), 1); });
      this.onNote(`Only ${this.workers.length} speech worker${this.workers.length === 1 ? '' : 's'} could start.`);
    }
    return device;
  }
  async transcribe(audio, offset) {
    const w = this.idle.pop() ?? await new Promise((resolve) => this.waiting.push(resolve));
    try {
      return await w.transcribe(audio, offset);
    } finally {
      const next = this.waiting.shift();
      if (next) next(w); else this.idle.push(w);
    }
  }
  stop() { this.workers.forEach((w) => w.stop()); }
}

/**
 * Runs jobs at the same time (up to `limit`) but hands every result to `commit` strictly in order.
 * `prepare(item, index)` runs one at a time, in order, and returns the job to start (e.g. reads the audio first).
 * After `shouldStop()` goes true nothing new starts and unfinished jobs are abandoned; finished ones still commit
 * as long as everything before them did.
 */
export async function inOrder({ items, limit = 1, prepare, commit, shouldStop = () => false }) {
  const done = new Map();
  const running = new Set();
  let next = 0, failure = null;
  const flush = async () => {
    while (done.has(next)) { const r = done.get(next); done.delete(next); await commit(items[next], r, next); next++; }
  };
  const settle = async () => { await Promise.race(running); if (failure) throw failure; await flush(); };
  for (let i = 0; i < items.length && !shouldStop(); i++) {
    while (running.size >= Math.max(1, limit) && !shouldStop()) await settle();
    if (shouldStop()) break;
    const job = await prepare(items[i], i);
    if (shouldStop()) break;
    const p = Promise.resolve().then(job).then((r) => { done.set(i, r); }, (e) => { failure ??= e; }).finally(() => running.delete(p));
    running.add(p);
    await flush();
  }
  while (running.size && !shouldStop()) await settle();
  if (failure) throw failure;
  await flush();
}


/**
 * mode: 'thorough' (transcribe everything) | 'quick' (transcribe ~15 s after each pause) | 'pauses' (no speech model).
 * A window "owns" headings that start inside its step; the overlap lets a heading at the edge finish being spoken.
 * Windows are read one at a time but recognised in parallel (`whisper.size` at once); results are committed in order.
 */
export async function listen({ audio, duration, mode, whisper, onProgress, onChapters, shouldStop,
  onScanned = () => {}, onHeard = () => {}, from = 0, initial = [], step = 600, overlap = 20 }) {
  // `onHeard({ start, text })` reports the first words after each long pause, so people can see what the
  // narrator says where chapters ought to start (and why none were found, if so).
  // `from`/`initial` resume an earlier run; `onScanned(t)` reports that everything before t has been listened to.
  const chapters = initial.map((c) => ({ ...c }));
  const started = Date.now();
  const starts = [];
  for (let t = from; t < duration; t += step) starts.push(t);
  const workers = mode === 'pauses' ? 1 : Math.max(1, whisper?.size || 1);
  let scanned = from;

  const report = () => {
    const done = scanned / duration;
    const part = (scanned - from) / Math.max(1, duration - from);
    const eta = part > 0.02 ? ((Date.now() - started) / part) * (1 - part) : null;
    onProgress({ done, eta, text: `Listening… ${Math.floor(scanned / 60)} of ${Math.ceil(duration / 60)} min${workers > 1 ? ` (${workers} at once)` : ''}` });
  };

  const add = (a, windowStart, last) => {
    if (a.start >= windowStart + step && !last) return;
    if (a.start < windowStart && windowStart > 0) return;
    const prev = chapters[chapters.length - 1];
    if (prev && Math.abs(a.start - prev.start) < 5) {
      // Same heading heard twice (overlapping clips); keep the fuller one, since a clip can end mid-title.
      if (a.title.length <= prev.title.length) return;
      chapters[chapters.length - 1] = a;
      onChapters([...chapters], a);
      return;
    }
    chapters.push(a);
    onChapters([...chapters], a);
  };

  if (mode === 'pauses') {
    let lastPause = chapters.length ? chapters[chapters.length - 1].start : 0;
    for (const t of starts) {
      if (shouldStop()) break;
      report();
      const samples = await audio.decode(t, step + overlap);
      for (const s of findSilences(samples, RATE, { minSilence: 2.0 })) {
        const at = t + s.end;
        if (at < t + step && at < duration - 5 && at - lastPause >= 60) {
          lastPause = at;
          chapters.push({ start: Math.round(at * 100) / 100, title: '' });
        }
      }
      scanned = Math.min(duration, t + step);
      if (!shouldStop()) onScanned(scanned, [...chapters]);
    }
    if (!chapters.length || chapters[0].start > 0) chapters.unshift({ start: 0, title: '' });
    chapters.forEach((c, i) => { c.title = `Chapter ${i + 1}`; });
    return chapters;
  }

  // Long pauses are shortened before recognition (they break Whisper's timing); times are mapped back afterwards.
  const hear = async (clip, offset) => {
    const { samples, pieces } = squeezeSilences(clip, RATE);
    const heard = await whisper.transcribe(samples, 0);
    return {
      words: heard.map((w) => ({
        word: w.word, start: offset + unsqueeze(w.start, pieces), end: offset + unsqueeze(w.end, pieces),
      })),
      silences: findSilences(clip, RATE, { minSilence: 0.4 }).map((s) => ({ start: offset + s.start, end: offset + s.end })),
    };
  };
  const heardAt = (words, points, windowEnd) => {
    const out = [];
    for (const p of points) {
      if (p >= windowEnd) break;
      const text = words.filter((w) => w.start >= p - 0.3 && w.start < p + 8).slice(0, 12).map((w) => w.word).join(' ');
      if (text) out.push({ start: Math.round(p * 10) / 10, text });
    }
    return out;
  };
  // `startsAfterPause`: the clip begins right after a long pause (Quick mode, or the start of the book).
  const analyse = async (clip, offset, { startsAfterPause = false, windowEnd = Infinity } = {}) => {
    const { words, silences } = await hear(clip, offset);
    const points = silences.filter((s) => s.end - s.start >= 1.0).map((s) => s.end);
    return {
      found: findAnnouncements(words, { silences, startsAfterPause }),
      heard: heardAt(words, startsAfterPause ? [offset + 0.3] : points, windowEnd),
    };
  };
  const nothing = { found: [], heard: [] };

  report();
  await inOrder({
    items: starts,
    limit: workers,
    shouldStop,
    // One at a time: the audio engine reads a window.
    prepare: async (t) => {
      const last = t + step >= duration;
      const samples = await audio.decode(t, step + overlap);
      // The job: recognise it (this part runs alongside the other windows).
      return async () => {
        if (!samples.length) return { t, last, ...nothing };
        if (mode === 'thorough') {
          return { t, last, ...await analyse(samples, t, { startsAfterPause: t === 0, windowEnd: last ? Infinity : t + step }) };
        }
        const points = findSilences(samples, RATE, { minSilence: 1.0 }).map((s) => s.end);
        if (t === 0) points.unshift(0);
        const parts = await Promise.all(points.filter((rel) => last || rel < step).map(async (rel) => {
          if (shouldStop()) return nothing;
          const begin = Math.max(0, rel - 0.3);
          const clip = samples.slice(Math.floor(begin * RATE), Math.floor((begin + 15) * RATE));
          return clip.length < RATE ? nothing : analyse(clip, t + begin, { startsAfterPause: true });
        }));
        return { t, last, found: parts.flatMap((p) => p.found), heard: parts.flatMap((p) => p.heard) };
      };
    },
    // In book order, so the chapter list and "listened up to here" never run ahead of each other.
    commit: (_, r) => {
      r.heard.forEach(onHeard);
      r.found.forEach((a) => add(a, r.t, r.last));
      scanned = Math.min(duration, r.t + step);
      onScanned(scanned, [...chapters]);
      report();
    },
  });
  return chapters;
}
