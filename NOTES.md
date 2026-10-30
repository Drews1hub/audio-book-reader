# Working notes (for anyone helping: people, Claude, ChatGPT, …)

Please read this before changing anything, and add to it when you do. Be kind to each other's work.

## What this is
Upload an audiobook; it listens for spoken "Chapter N …" and marks/names the chapters.
- `docs/` is the **website** (static, GitHub Pages, all in the browser). This is what the owner uses.
- `app/` is an older Python/FastAPI **server** version with the same idea (kept working, has tests).
- Published at https://drews1hub.github.io/audio-book-reader/ from the branch set in Settings → Pages, folder `/docs`.
  Anything pushed to that branch goes **live within ~2 minutes**, so test first.

## How the website works
`docs/app.js` (UI, saving, export) → `docs/js/listen.js` (walks the book in 10-minute windows; modes quick / thorough /
pauses; resumable) → `docs/js/audio.js` (ffmpeg.wasm: length, embedded chapters, decode a slice to 16 kHz mono, write
chapters into the file) and `docs/js/whisper-worker.js` (Whisper in a worker via transformers.js).
`docs/js/chapters.js` is pure logic (finding "Chapter N" in words, silences, export formats) and is unit-tested.
Libraries are vendored in `docs/vendor/` (no CDN); only the Whisper model weights come from Hugging Face.

## Things learned the hard way (don't undo these)
- Never rely on the browser's `<audio>` to open the file: Chrome can't play every format ffmpeg can read.
- Whisper's word times collapse on long silences and put a word-after-pause at the end of the previous word, so long
  silences are shortened before recognition and pauses are measured from the audio (`squeezeSilences`, `silences`).
- A dropped *folder* arrives as an empty extension-less "file"; `handleDrop` looks inside it.
- Real test books are ~10 hours: keep Quick mode the default; keep progress saved so it can resume.

## Test
```bash
node --test tests/*.test.mjs      # website logic
python -m pytest                  # server version
cd docs && python3 -m http.server # then open http://localhost:8000 (Chrome)
```

## Working together
- Use your **own branch** and a pull request; don't force-push or rewrite history on someone else's branch.
- Small commits with a clear message about *why*. Note here anything the next person must know.
- Don't change `docs/vendor/` or the Pages settings without telling the owner.

## Open items
- Real narrator audiobooks haven't been tested yet (all tests used a computer voice).
- Books made of many separate audio files (one per chapter) aren't supported yet.
- WebGPU option is untested.

## Intake improvements (Codex)
- File sizes now use bytes/KB/MB/GB rather than rounding small files to 0 MB.
- Audio engine initialization failures have a separate message and can retry on the next selection.
- When neither the browser nor ffmpeg's metadata provides a duration, decode to a null output to measure it.
  This stores no decoded book, but may take time on long books; the UI explains the delay.
- Register browser metadata listeners before assigning the audio URL.
- `tests/audio.test.mjs` exercises the actual vendored WASM core through a Node worker adapter, including a
  simulated missing-duration log, invalid audio, and engine-load retry. All 13 JS tests pass.
  This is not a browser end-to-end test; the user's failing file has not been tested. Python server files unchanged.
