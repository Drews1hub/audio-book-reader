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
