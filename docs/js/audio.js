// ffmpeg.wasm wrapper: reads chapters/tags, decodes any slice of the book to 16 kHz mono, embeds chapters.
// The file is mounted read-only (WORKERFS), so even a multi-gigabyte audiobook is never copied into memory.
import { FFmpeg } from '../vendor/ffmpeg/index.js';
import { parseFfmetadata } from './chapters.js';

const CORE = new URL('../vendor/ffmpeg-core/', import.meta.url).href;
export const RATE = 16000;

let ff = null;
let loading = null;
let mountCount = 0;

async function engine() {
  if (ff) return ff;
  loading ??= (async () => {
    const f = new FFmpeg();
    await f.load({ coreURL: CORE + 'ffmpeg-core.js', wasmURL: CORE + 'ffmpeg-core.wasm' });
    ff = f;
    return f;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

/** Open an audio file. Returns a handle with probe(), decode(), embed(), close(). */
export async function openAudio(file) {
  const f = await engine();
  const dir = `/in${++mountCount}`;
  const ext = (/\.[a-z0-9]{1,5}$/i.exec(file.name) || ['.bin'])[0].toLowerCase();
  const safe = new File([file], 'book' + ext); // plain name; wraps the same bytes, no copy
  await f.createDir(dir);
  await f.mount('WORKERFS', { files: [safe] }, dir);
  const input = `${dir}/${safe.name}`;

  return {
    ext,
    /** Chapters and tags already inside the file. */
    async probe() {
      try {
        await f.exec(['-i', input, '-f', 'ffmetadata', '/probe.txt']);
        const text = await f.readFile('/probe.txt', 'utf8');
        await f.deleteFile('/probe.txt');
        return parseFfmetadata(text);
      } catch { return { tags: {}, chapters: [] }; }
    },
    /** Float32Array of [start, start+length) at 16 kHz mono; empty past the end. */
    async decode(start, length) {
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
    },
    /** Same audio, no re-encode, with the chapter list written in. Needs the whole output in memory. */
    async embed(ffmetadata) {
      await f.writeFile('/chapters.ffmeta', ffmetadata);
      const out = '/export' + ext;
      const code = await f.exec(['-i', input, '-i', '/chapters.ffmeta', '-map', '0', '-map_metadata', '1',
        '-map_chapters', '1', '-c', 'copy', out]);
      if (code !== 0) throw new Error('ffmpeg could not write the chapters into this file type.');
      const bytes = await f.readFile(out);
      await f.deleteFile(out);
      await f.deleteFile('/chapters.ffmeta');
      return new Blob([bytes], { type: file.type || 'application/octet-stream' });
    },
    async close() {
      try { await f.unmount(dir); await f.deleteDir(dir); } catch { /* already gone */ }
    },
  };
}
