// Speech recognition in a worker (Whisper via transformers.js + ONNX Runtime WebAssembly). Audio never leaves the page;
// the model weights are fetched once from this site (and cached by the browser).
import { pipeline, env } from '../vendor/transformers/transformers.min.js';

// The speech models are hosted next to this page (docs/models/), so nothing is downloaded from Hugging Face:
// some networks and browsers block it ("Forbidden access to file"). Hugging Face stays on as a fallback.
env.allowLocalModels = true;
env.localModelPath = new URL('../models/', import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = new URL('../vendor/transformers/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1; // multi-threading needs cross-origin isolation, which GitHub Pages can't send

const RATE = 16000;
const OPTS = { chunk_length_s: 30, stride_length_s: 5 };
let asr = null;
let device = 'wasm';

async function load(model, wantGpu) {
  const progress_callback = (p) => {
    if (p.status === 'progress') postMessage({ type: 'download', file: p.file, loaded: p.loaded, total: p.total });
  };
  if (wantGpu && 'gpu' in navigator) {
    try {
      asr = await pipeline('automatic-speech-recognition', model, {
        device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' }, progress_callback,
      });
      device = 'webgpu';
      return;
    } catch (e) { postMessage({ type: 'note', message: `GPU unavailable (${e.message}); using the CPU.` }); }
  }
  asr = await pipeline('automatic-speech-recognition', model, {
    device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, progress_callback,
  });
  device = 'wasm';
}

// Whisper's word timing is sometimes degenerate (every word stamped with the same time). Detect that.
function wordsLookBroken(words, realSeconds) {
  if (words.length < 3) return false;
  const distinct = new Set(words.map((w) => w.start.toFixed(2))).size;
  const lastStart = words[words.length - 1].start;
  return distinct < words.length * 0.5 || lastStart > realSeconds + 1;
}

// Fallback: segment-level timestamps (more reliable), with the words spread evenly across each segment.
function wordsFromSegments(chunks) {
  const words = [];
  for (const c of chunks) {
    const parts = c.text.trim().split(/\s+/).filter(Boolean);
    const [s, e0] = c.timestamp;
    const e = e0 ?? s + parts.length * 0.4;
    parts.forEach((w, i) => {
      words.push({ word: w, start: s + ((e - s) * i) / parts.length, end: s + ((e - s) * (i + 1)) / parts.length - 0.01 });
    });
  }
  return words;
}

async function transcribe(audio, offset) {
  const real = audio.length / RATE;
  // Short clips are padded with silence to Whisper's 30 s window.
  let input = audio;
  if (audio.length < 30 * RATE) { input = new Float32Array(30 * RATE); input.set(audio); }
  let words = ((await asr(input, { ...OPTS, return_timestamps: 'word' })).chunks || [])
    .map((c) => ({ word: c.text.trim(), start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] + 0.3 }))
    .filter((w) => w.word);
  if (wordsLookBroken(words, real)) {
    words = wordsFromSegments((await asr(input, { ...OPTS, return_timestamps: true })).chunks || []);
  }
  return words.filter((w) => w.start <= real) // anything past the real audio is the model imagining things
    .map((w) => ({ word: w.word, start: offset + w.start, end: offset + w.end }));
}

onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      await load(data.model, data.gpu);
      postMessage({ type: 'loaded', device });
    } else if (data.type === 'transcribe') {
      postMessage({ type: 'result', id: data.id, words: await transcribe(data.audio, data.offset) });
    }
  } catch (e) {
    postMessage({ type: 'error', id: data.id, message: String(e?.message || e) });
  }
};
