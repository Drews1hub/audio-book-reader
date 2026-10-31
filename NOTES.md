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
Libraries are vendored in `docs/vendor/` (no CDN) and the Whisper models are hosted in `docs/models/` (tiny.en + base.en,
118 MB, unchanged copies of the Xenova ONNX repos). Hugging Face is only a fallback.

## Things learned the hard way (don't undo these)
- Never rely on the browser's `<audio>` to open the file: Chrome can't play every format ffmpeg can read.
- Whisper's word times collapse on long silences and put a word-after-pause at the end of the previous word, so long
  silences are shortened before recognition and pauses are measured from the audio (`squeezeSilences`, `silences`).
- A dropped *folder* arrives as an empty extension-less "file"; `handleDrop` looks inside it.
- Real test books are ~10 hours: keep Quick mode the default; keep progress saved so it can resume.
- ffmpeg.wasm crashes the whole tab after ~100–150 `exec` runs (measured, any file). `audio.js` restarts the engine
  every 50 runs (`MAX_JOBS`) and re-mounts the files. Don't remove this: a 117-track book needs hundreds of runs.
- The owner's books come as a **folder of many tracks** (e.g. 117 × `001 - 001 - Track 1.m4b`). These are one book:
  `audio.js` treats the parts as one timeline, `app.js` plays them back to back (`timeline`, `seekTo`, `loadPart`),
  and the export joins them into one file with the chapters written in.
- A web page can't change the user's original file; "Save" writes a new copy to Downloads. Say so in the UI.
- **The owner's browser/network gets "Forbidden access to file: https://huggingface.co/…"** — HF is blocked for them, so
  the model never loaded and the old silent fallback made it look like it "worked". That is why the models are now
  hosted in `docs/models/`. Don't point the page back at Hugging Face only. (To test like the owner: make the browser
  answer 403 to huggingface.co — see how it was done with `page.route` — and check the hosted files are used.)
- Never fill the chapter list with pause guesses on its own: on the owner's real book it heard no headings and the
  silent fallback produced "Chapter 1, 2, …" in the wrong places. Now it says so (`noneBox`) and shows
  "What it heard after each pause" (`onHeard` in listen.js) so we can see what the narrator actually says.
- Saved files carry **Title/Author** (fields on the page) as title, album, artist, album_artist, genre=Audiobook and,
  for .m4b, iTunes' audiobook flag (`bookTags`). Tags are set with `-metadata`; don't go back to `-map_metadata 1`,
  which replaced every existing tag and is why iTunes showed "Unknown Artist / Unknown Album".
- Listening is parallel: `WhisperPool` (several speech workers, `pickWorkers` decides how many) and `inOrder` in
  listen.js read windows one at a time but recognise several at once, and commit results strictly in book order so
  the chapter list, "What it heard" and the resume point never run ahead of each other. Don't commit out of order.
- Saving copies only the audio (+ cover picture for single files), never `-map 0`: iTunes/Apple Books audiobooks carry a
  QuickTime chapter track that shows up as a data stream, and copying it fails with "Tag text incompatible with output
  codec ... Could not write header" (the owner hit this). Chapters are written from our own list. The test that covers
  it (tests/audio.test.mjs, needs ffmpeg on the PATH) fails on the old code.
- The page reads the book from where it is on disk until it is saved. If the file is moved/renamed/deleted meanwhile
  (the owner hit this, likely iTunes/Books moving it), Chrome throws NotFoundError from FileReaderSync. `missingFile()`
  checks before saving and `lostMessage` explains it. Saved results are keyed by name + size (`abr:v2:`), not modified
  time, so dropping a moved/copied file again restores its chapters (older `abr:v1:` keys are still read).
- Each chapter row has a ▶ that plays its first 15 s (`previewChapter`) so a missed title can be typed by ear; Enter in a
  title box moves to the next chapter and plays it. Anything else that takes over playback calls `cancelPreview()` so
  the clip's timer can't pause it later.
- Only "Chapter N" (also Part/Book/Section/Appendix + number) counts by default. Counting a number said on its own after
  a pause ("Twelve.") is the opt-in `bareNumbers` option: on by default it turned ordinary story lines into chapters
  for the owner. Headings go in through `insertChapter`, which keeps one heading per spot (overlapping clips hear the
  same one twice) and the list in time order.
- A chapter marker goes at the **first sound after the pause before the chapter** (the entry music), measured from the
  audio's silences, not from Whisper's word time: Whisper stamps the first word after a pause at the end of the previous
  word, which put markers on the last syllable before a chapter (or, after music, seconds late). See `startOf` in
  `findAnnouncements`; the marker sits 0.3 s inside the quiet pause so a music fade-in keeps its start, and the ▶ preview
  plays from the marker exactly. Checked with spoken audio + synthetic music: within 0.06 s of the true start.
- Each chapter row has a ± button: type seconds (negative = earlier) and the start moves by that much, then plays from
  the new start (`openNudge` in app.js). The start is clamped to the book and the list is re-sorted.
- Headings can be a bare number ("Twelve.") after a long pause, not only "Chapter Twelve" (`bareNumberAt`).

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
