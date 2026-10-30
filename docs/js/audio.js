// ffmpeg.wasm wrapper: reads chapters/tags, decodes any slice of the book to 16 kHz mono, embeds chapters.
// Files are mounted read-only (WORKERFS), so even a multi-gigabyte audiobook is never copied into memory.
// A book can be one file or many (e.g. 117 numbered tracks): the parts are treated as one continuous timeline.
import { FFmpeg } from '../vendor/ffmpeg/index.js';
import { bookTags, parseFfmetadata } from './chapters.js';

const CORE = new URL('../vendor/ffmpeg-core/', import.meta.url).href;
export const RATE = 16000;

let ff = null;
let loading = null;
let mountCount = 0;
// ffmpeg.wasm crashes the whole tab after roughly 100-150 runs (measured), whatever the file. A 117-track book needs
// hundreds, so the engine is replaced every MAX_JOBS runs and the open files are mounted again.
const MAX_JOBS = 50;
let jobs = 0;
const mounts = new Map();   // dir -> files, to mount again after a restart

async function engine() {
  if (ff) return ff;
  loading ??= (async () => {
    const f = new FFmpeg();
    try {
      await f.load({ coreURL: CORE + 'ffmpeg-core.js', wasmURL: CORE + 'ffmpeg-core.wasm' });
    } catch (e) {
      f.terminate();
      throw new Error(`The audio engine could not download or start. Check your connection and reload the page. Details: ${e?.message || e}`);
    }
    ff = f;
    return f;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

// The engine for the next job, restarted first if it has done MAX_JOBS already.
async function nextEngine() {
  if (ff && jobs >= MAX_JOBS) {
    try { ff.terminate(); } catch { /* already gone */ }
    ff = null; loading = null; jobs = 0;
    const fresh = await engine();
    for (const [dir, files] of mounts) {
      await fresh.createDir(dir);
      await fresh.mount('WORKERFS', { files }, dir);
    }
  }
  jobs++;
  return engine();
}

/**
 * Open an audio file, or an array of files that make up one book (already in listening order).
 * Returns a handle with duration(), probe(), decode(), embed(), close(); `parts` has each file's start/duration.
 */
export async function openAudio(source) {
  const list = Array.isArray(source) ? source : [source];
  const first = await engine();
  const dir = `/in${++mountCount}`;
  const parts = list.map((file, i) => {
    const ext = (/\.[a-z0-9]{1,5}$/i.exec(file.name) || ['.bin'])[0].toLowerCase();
    // Plain names; File([file]) wraps the same bytes, no copy.
    const name = list.length === 1 ? 'book' + ext : `p${String(i).padStart(4, '0')}${ext}`;
    return { file, ext, safe: new File([file], name), input: `${dir}/${name}`, start: 0, duration: 0 };
  });
  await first.createDir(dir);
  if (!await first.mount('WORKERFS', { files: parts.map((p) => p.safe) }, dir)) {
    await first.deleteDir(dir);
    throw new Error('The audio engine could not access this file. Try selecting it again from a local folder.');
  }
  mounts.set(dir, parts.map((p) => p.safe));
  const multi = parts.length > 1;
  const ext = parts[0].ext;
  let layout = null;

  // Length of one file, read by ffmpeg (works for formats the browser's own player can't open).
  async function lengthOf(input, onFallback) {
    const f = await nextEngine();
    let text = '';
    const onLog = ({ message }) => { text += message + '\n'; };
    f.on('log', onLog);
    try {
      try { await f.exec(['-i', input]); } catch { /* probing has no output */ }
      const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
      if (m) return { seconds: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) };
      // A readable stream can lack duration metadata. Decode to a null output to
      // measure it, without retaining the decoded book in memory.
      onFallback?.();
      let seconds = 0;
      const onProgress = ({ time }) => {
        if (Number.isFinite(time) && time > 0) seconds = Math.max(seconds, time / 1e6);
      };
      f.on('progress', onProgress);
      try {
        const code = await f.exec(['-i', input, '-map', '0:a:0', '-vn', '-f', 'null', '-']);
        if (code === 0 && seconds > 0) return { seconds };
      } catch (e) { text += `\n${e?.message || e}`; }
      finally { f.off('progress', onProgress); }
      return { seconds: 0 };
    } finally {
      f.off('log', onLog);
      // Keep ffmpeg's own complaint so the page can say why a file couldn't be read.
      handle.lastError = text.split('\n').map((l) => l.trim())
        .filter((l) => l && !/^(ffmpeg version|built with|configuration:|lib\w+ |Aborted|At least one output|Use -h)/.test(l))
        .slice(-4).join(' · ');
    }
  }

  // Each part's duration and where it starts in the whole book.
  function measure({ onProgress, onFallback } = {}) {
    layout = (async () => {
      let t = 0;
      for (let i = 0; i < parts.length; i++) {
        onProgress?.(i, parts.length);
        const { seconds } = await lengthOf(parts[i].input, onFallback);
        if (!seconds && multi) {
          throw new Error(`Couldn't read "${parts[i].file.name}"${handle.lastError ? `: ${handle.lastError}` : ''}`);
        }
        parts[i].start = t;
        parts[i].duration = seconds;
        t += seconds;
      }
      return t;
    })();
    layout.catch(() => { layout = null; });
    return layout;
  }
  const ensureLayout = () => layout ?? measure();

  async function decodeFrom(input, start, length) {
    const f = await nextEngine();
    try {
      const code = await f.exec(['-ss', String(start), '-t', String(length), '-i', input,
        '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '/win.raw']);
      if (code !== 0) return new Float32Array(0);
      const bytes = await f.readFile('/win.raw');
      await f.deleteFile('/win.raw');
      const i16 = new Int16Array(bytes.slice().buffer);
      const out = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
      return out;
    } catch { return new Float32Array(0); }
  }

  const handle = {
    ext,
    parts,
    lastError: '',
    /**
     * Total length in seconds (0 if a single file can't be read). Measured afresh on every call.
     * Takes `onFallback` (called if the length has to be measured by decoding), or `{ onProgress, onFallback }`.
     */
    async duration(opts) { return measure(typeof opts === 'function' ? { onFallback: opts } : opts); },
    /** Tags already inside the file, and its chapters (single files only; separate tracks carry none). */
    async probe() {
      const f = await nextEngine();
      try {
        await f.exec(['-i', parts[0].input, '-f', 'ffmetadata', '/probe.txt']);
        const text = await f.readFile('/probe.txt', 'utf8');
        await f.deleteFile('/probe.txt');
        const info = parseFfmetadata(text);
        // Separate tracks carry no chapters of their own, but the first one's tags (artist, album) are worth reading.
        return multi ? { ...info, chapters: [] } : info;
      } catch { return { tags: {}, chapters: [] }; }
    },
    /** Float32Array of [start, start+length) at 16 kHz mono; empty past the end. */
    async decode(start, length) {
      if (!multi) return decodeFrom(parts[0].input, start, length);
      const total = await ensureLayout();
      const end = Math.min(total, start + length);
      if (end <= start) return new Float32Array(0);
      const out = new Float32Array(Math.round((end - start) * RATE));
      for (const p of parts) {
        const from = Math.max(start, p.start), to = Math.min(end, p.start + p.duration);
        if (to <= from) continue;
        const chunk = await decodeFrom(p.input, from - p.start, to - from);
        // Placed by time, so one unreadable part leaves a gap instead of shifting everything after it.
        out.set(chunk.subarray(0, Math.max(0, out.length - Math.round((from - start) * RATE))), Math.round((from - start) * RATE));
      }
      return out;
    },
    /**
     * The audio with the chapter list written in, without re-encoding. Many files are joined into one.
     * Needs the whole output in memory.
     */
    async embed(ffmetadata, meta = {}) {
      const f = await nextEngine();
      await f.writeFile('/chapters.ffmeta', ffmetadata);
      const out = '/export' + ext;
      // Chapters come from the ffmetadata file; title/author are set with -metadata. Not `-map_metadata 1`, which
      // would replace every tag the file already has (artist, album, …) with the few in that list.
      const tags = bookTags(meta, ext).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
      const args = multi
        ? ['-f', 'concat', '-safe', '0', '-i', '/list.txt', '-i', '/chapters.ffmeta', '-map', '0:a',
          '-map_chapters', '1', ...tags, '-c', 'copy', out]
        : ['-i', parts[0].input, '-i', '/chapters.ffmeta', '-map', '0',
          '-map_chapters', '1', ...tags, '-c', 'copy', out];
      if (multi) await f.writeFile('/list.txt', parts.map((p) => `file '${p.input}'`).join('\n') + '\n');
      const code = await f.exec(args);
      if (multi) await f.deleteFile('/list.txt').catch(() => {});
      if (code !== 0) throw new Error(multi
        ? 'ffmpeg could not join these files (they may use different audio settings).'
        : 'ffmpeg could not write the chapters into this file type.');
      const bytes = await f.readFile(out);
      await f.deleteFile(out);
      await f.deleteFile('/chapters.ffmeta');
      return new Blob([bytes], { type: parts[0].file.type || 'application/octet-stream' });
    },
    async close() {
      mounts.delete(dir);
      try { const f = await engine(); await f.unmount(dir); await f.deleteDir(dir); } catch { /* already gone */ }
    },
  };
  return handle;
}
