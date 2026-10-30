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
    return this._call(id, { type: 'transcribe', id, audio, offset }, [audio.buffer]);
  }
  stop() { this.worker.terminate(); }
}

/**
 * mode: 'thorough' (transcribe everything) | 'quick' (transcribe ~15 s after each pause) | 'pauses' (no speech model).
 * A window "owns" headings that start inside its step; the overlap lets a heading at the edge finish being spoken.
 */
export async function listen({ audio, duration, mode, whisper, onProgress, onChapters, shouldStop,
  step = 600, overlap = 20 }) {
  const chapters = [];
  const started = Date.now();
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
  const headings = async (clip, offset) => {
    const { words, silences } = await hear(clip, offset);
    return findAnnouncements(words, { silences });
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
  let lastPause = 0;

  for (let t = 0; t < duration && !shouldStop(); t += step) {
    const last = t + step >= duration;
    const done = t / duration;
    const eta = done > 0.02 ? ((Date.now() - started) / done) * (1 - done) : null;
    onProgress({ done, eta, text: `Listening… ${Math.floor(t / 60)} of ${Math.ceil(duration / 60)} min` });

    const samples = await audio.decode(t, step + overlap);
    if (!samples.length) continue;

    if (mode === 'thorough') {
      (await headings(samples, t)).forEach((a) => add(a, t, last));
    } else if (mode === 'quick') {
      const starts = findSilences(samples, RATE, { minSilence: 1.0 }).map((s) => s.end);
      if (t === 0) starts.unshift(0);
      for (const rel of starts) {
        if (shouldStop() || (t + rel >= t + step && !last)) break;
        const from = Math.max(0, rel - 0.3);
        const clip = samples.slice(Math.floor(from * RATE), Math.floor((from + 15) * RATE));
        if (clip.length < RATE) continue;
        (await headings(clip, t + from)).forEach((a) => add(a, t, last));
      }
    } else {
      for (const s of findSilences(samples, RATE, { minSilence: 2.0 })) {
        const at = t + s.end;
        if (at < t + step && at < duration - 5 && at - lastPause >= 60) {
          lastPause = at;
          chapters.push({ start: Math.round(at * 100) / 100, title: '' });
        }
      }
    }
  }
  if (mode === 'pauses') {
    chapters.unshift({ start: 0, title: '' });
    chapters.forEach((c, i) => { c.title = `Chapter ${i + 1}`; });
  }
  return chapters;
}
