// Exercise the actual vendored WASM core and wrapper without a browser. The
// adapter supplies Worker/FileReaderSync; it does not test browser integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { formatFileSize } from '../docs/js/file-info.js';

const base = new URL('../docs/vendor/ffmpeg-core/', import.meta.url);
let hideDuration = false, failLoad = false, failedWorkers = 0;
const commands = [];
class CoreWorker {
  postMessage({ id, type, data }) {
    queueMicrotask(async () => {
      const send = (type, data) => this.onmessage({ data: { id, type, data } });
      try {
        let result = true;
        if (type === 'LOAD') {
          if (failLoad) throw new Error('Network unavailable');
          const context = vm.createContext({ console, WebAssembly, Uint8Array, Int8Array,
            Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array,
            ArrayBuffer, TextDecoder, TextEncoder, setTimeout, clearTimeout, atob, btoa, performance,
            self: { location: { href: 'http://localhost/core.js' } },
            FileReaderSync: class { readAsArrayBuffer(blob) { return blob.bytes.buffer; } },
          });
          const source = fs.readFileSync(new URL('ffmpeg-core.js', base), 'utf8')
            .replaceAll('import.meta.url', JSON.stringify(base.href + 'ffmpeg-core.js'))
            .replace('export default createFFmpegCore;', '');
          vm.runInContext(source, context);
          this.core = await context.createFFmpegCore({
            wasmBinary: fs.readFileSync(new URL('ffmpeg-core.wasm', base)),
            mainScriptUrlOrBlob: 'http://localhost/core.js#' + btoa(JSON.stringify({ wasmURL: 'core.wasm' })),
          });
          this.core.setLogger((log) => {
            if (!(hideDuration && /Duration:/.test(log.message))) send('LOG', log);
          });
          this.core.setProgress((p) => send('PROGRESS', p));
        } else if (type === 'CREATE_DIR') this.core.FS.mkdir(data.path);
        else if (type === 'DELETE_DIR') this.core.FS.rmdir(data.path);
        else if (type === 'MOUNT') {
          const files = await Promise.all(data.options.files.map(async (file) => {
            const bytes = new Uint8Array(await file.arrayBuffer());
            return { name: file.name, size: file.size, slice(a, b) {
              const chunk = bytes.slice(a, b); return { bytes: chunk, size: chunk.length };
            } };
          }));
          this.core.FS.mount(this.core.FS.filesystems.WORKERFS, { files }, data.mountPoint);
        } else if (type === 'UNMOUNT') this.core.FS.unmount(data.mountPoint);
        // File calls, as in docs/vendor/ffmpeg/worker.js (decode() reads its output back).
        else if (type === 'READ_FILE') result = this.core.FS.readFile(data.path, { encoding: data.encoding });
        else if (type === 'WRITE_FILE') this.core.FS.writeFile(data.path, data.data);
        else if (type === 'DELETE_FILE') this.core.FS.unlink(data.path);
        else if (type === 'EXEC') {
          commands.push(data.args);
          this.core.exec(...data.args); result = this.core.ret; this.core.reset();
        } else throw new Error(`Unexpected call ${type}`);
        send(type, result);
      } catch (e) { send('ERROR', String(e?.message || e)); }
    });
  }
  terminate() { failedWorkers++; }
}
globalThis.Worker = CoreWorker;
const { openAudio } = await import('../docs/js/audio.js');

function wav() {
  const b = Buffer.alloc(32044);
  b.write('RIFF'); b.writeUInt32LE(32036, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(32000, 40);
  return new File([b], 'sample.wav');
}

test('engine load failure is explained and a subsequent open can retry', async () => {
  failLoad = true;
  await assert.rejects(openAudio(wav()), /audio engine could not download or start.*Network unavailable/);
  assert.equal(failedWorkers, 1);
  failLoad = false;
  const audio = await openAudio(wav());
  try {
    const before = commands.length;
    assert.equal(await audio.duration(), 1);
    assert.equal(commands.length - before, 1, 'known durations do not decode the whole file');
    hideDuration = true; // Simulate absent metadata while exercising real decoding/progress.
    let fallback = false;
    assert.equal(await audio.duration(() => { fallback = true; }), 1);
    assert.equal(fallback, true);
    assert.ok(commands.at(-1).includes('null'));
  } finally { hideDuration = false; await audio.close(); }
});

test('invalid audio remains rejected after the decode fallback', async () => {
  const audio = await openAudio(new File(['not audio'], 'broken.wav'));
  try {
    assert.equal(await audio.duration(), 0);
    assert.match(audio.lastError, /Invalid data/);
  } finally { await audio.close(); }
});

test('small nonempty files never round down to zero MB', () => {
  assert.equal(formatFileSize(0), '0 bytes');
  assert.equal(formatFileSize(400), '400 bytes');
  assert.equal(formatFileSize(25000), '25.0 KB');
  assert.equal(formatFileSize(1500000), '1.5 MB');
  assert.equal(formatFileSize(1500000000), '1.50 GB');
});

// Added by Claude: books made of many files, and the engine restart that keeps long runs from crashing the tab.
function tone(name, seconds, value) {
  const n = 16000 * seconds, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(value, 44 + i * 2);
  return new File([b], name);
}

test('several files play as one timeline', async () => {
  const audio = await openAudio([tone('01.wav', 1, 1000), tone('02.wav', 2, 2000), tone('03.wav', 1, 3000)]);
  try {
    assert.equal(await audio.duration(), 4);
    assert.deepEqual(audio.parts.map((p) => [p.start, p.duration]), [[0, 1], [1, 2], [3, 1]]);
    const s = await audio.decode(0.5, 3);           // 0.5 s of part 1, all of part 2, 0.5 s of part 3
    assert.equal(s.length, 3 * 16000);
    const at = (sec) => Math.round(s[Math.round(sec * 16000)] * 32768);
    assert.equal(at(0.2), 1000);
    assert.equal(at(1.5), 2000);
    assert.equal(at(2.8), 3000);
  } finally { await audio.close(); }
});

test('the engine is restarted before ffmpeg.wasm wears out, and files stay readable', async () => {
  const audio = await openAudio([tone('a.wav', 1, 500), tone('b.wav', 1, 700)]);
  try {
    await audio.duration();
    const before = failedWorkers;
    for (let i = 0; i < 120; i++) assert.equal((await audio.decode(0.5, 1)).length, 16000);
    assert.ok(failedWorkers - before >= 2, 'restarted at least twice in 120+ runs');
    assert.equal(Math.round((await audio.decode(1.2, 0.5))[100] * 32768), 700);   // still mounted after restarts
  } finally { await audio.close(); }
});
