# Audiobook Chapter Reader

Upload an audiobook and it listens for "Chapter 12 …", then marks and names every chapter, and gives you a
player where you can jump between, rename, add and export chapters (including the audio file with the chapter
titles written in).

There are two versions:

- **Website (`docs/`)**: runs entirely in the browser, hosted free on GitHub Pages. No server; the audio never
  leaves your device. See [Website](#website-github-pages).
- **Server (`app/`)**: a Python/FastAPI server, faster on long books. See [Run](#run-server).

## Website (GitHub Pages)

Everything happens in the page: [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) decodes the book ten
minutes at a time (the file is read in place, never copied into memory), and Whisper
([transformers.js](https://github.com/huggingface/transformers.js) + ONNX Runtime WebAssembly) transcribes it.
Libraries are vendored in `docs/vendor/` and the speech models are hosted in `docs/models/` (40 MB tiny / 75 MB base,
downloaded from this site on first use and then cached by the browser), so nothing comes from Hugging Face, which
some networks block.

Modes: **Quick** (default) transcribes ~15 s after each pause, so a 10-hour book takes roughly 10–20 minutes;
**Thorough** transcribes the whole book (about 2–3 hours for 10 hours of audio, measured at 3–4.5× real time on one
CPU core) and also catches headings that start without a pause, e.g. right after music; **Pauses only** marks long
pauses without speech recognition. Long silences are shortened before recognition (they break Whisper's word timing)
and real pauses are measured from the audio itself, so titles stop where the narrator pauses.

A **folder of tracks** (e.g. 117 numbered `.m4b`/`.mp3` files) is treated as one book: drop the folder or select all
the files. The tracks are put in file-name order, listened to as one timeline, played back to back, and *One audiobook
file with chapters* joins them into a single file with the chapter titles written in.

The original files are never changed (a web page can't); saving writes a new copy to your Downloads folder.

Chapters and how far it has listened are saved in the browser per file: if the tab closes or you press Stop, pick the
same file again and choose *Continue listening*. Files the browser can't play itself (e.g. WMA) are still read by
ffmpeg, so chapters can be found and saved even without the player.

Publish: repository **Settings → Pages → Build and deployment → Deploy from a branch**, pick the branch and the
`/docs` folder. Try it locally with `cd docs && python3 -m http.server`.

Recognition runs on the CPU. GitHub Pages can't enable multi-threading, so instead several speech workers (one per two
cores, 2 at most by default and 1 on low-memory computers (each holds about 1.1 GB); the *Processor cores* setting overrides it) listen to
different ten-minute stretches of the book at the same time. Each worker holds its own copy of the model. The GPU option (WebGPU) is
experimental and untested.
Tests: `node --test tests/*.test.mjs`.

Licenses: ffmpeg core is GPL-2.0-or-later, transformers.js Apache-2.0, ONNX Runtime MIT (see `docs/vendor/LICENSE-*`);
Whisper models MIT (OpenAI) / Apache-2.0 (ONNX conversions), see `docs/models/LICENSE-whisper`.

## Run (server)

```bash
sudo apt install ffmpeg          # or: brew install ffmpeg
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open http://localhost:8000. Files and chapters are stored in `./data` (override with `DATA_DIR`).

## How chapters are found

1. **Embedded chapters** (m4b/mp3 with chapter tags) are used as-is.
2. **Smart mode** (default): the server listens to the *entire* book with
   [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (word-level timestamps, 10-minute windows).
   Whenever the narrator starts a sentence with "Chapter twelve" (or Prologue, Epilogue, Part N, …) a chapter
   is created at that moment and titled from the words that follow, e.g. `Chapter 12: The Long Road Home`.
   No pauses are needed, and chapters show up in the UI live while it listens. The model (`base.en` by
   default, set `WHISPER_MODEL` to change) downloads on first use and runs on CPU, so expect a book to take
   a fraction of its length to process (a faster model like `tiny.en` trades accuracy for speed).
3. **Fast mode**, or when nothing is heard: long pauses become `Chapter N` markers to rename by hand.

Limitations: English only; the heading must start a sentence (so "she read chapter seven twice" is ignored);
titles come straight from speech recognition, so check them. Everything is editable in the UI (autosaves).

## Export

Audio with chapters embedded (no re-encode), ffmetadata, CUE, or JSON — via the Export menu or
`GET /api/books/{id}/export?format=audio|ffmetadata|cue|json`.

## API

`POST /api/books` (multipart `file`, `mode=auto|silence`) · `GET /api/books` · `GET /api/books/{id}` ·
`PUT /api/books/{id}/chapters` · `POST /api/books/{id}/reanalyze` · `GET /api/books/{id}/audio` (range
requests) · `DELETE /api/books/{id}`

There is no authentication — run it on a trusted network or put it behind a reverse proxy.

## Tests

```bash
python -m pytest
```
