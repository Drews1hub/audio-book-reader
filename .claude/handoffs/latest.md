# Handoff: Audiobook Chapter Reader (GitHub Pages site)

## Goal
A browser-only audiobook reader for the owner. Drop a book (often a folder of ~117 numbered tracks, ~10 h), it listens
for spoken "Chapter N" headings, lists and names the chapters, lets them be edited, and saves one audiobook file with
chapters and title/author written in (for iTunes / Apple Books). Live site:
https://drews1hub.github.io/audio-book-reader/ (footer shows the publish time, in the owner's time zone: Pacific).

## Done (all on branch claude/inspiring-heisenberg-ejsn8q, all pushed and live)
- Website in `docs/` (static, GitHub Pages, branch + /docs). Server version in `app/` (older, tests kept).
- Listening: Quick (default) / Thorough / Pauses; parallel speech workers (WhisperPool, 2 at automatic); resumable.
- Speech models hosted in `docs/models/` (Hugging Face was blocked for the owner).
- Multi-file books: folder drop, one timeline, playback across tracks, save joins them.
- Saving: copies audio + cover only (never `-map 0`), writes chapters + title/author/album/artist/genre/media_type.
- Moved source file: clear message; saved results keyed by name+size (`abr:v2:`), older `abr:v1:` still read.
- Engine work takes turns (`inTurn` in audio.js); engine restarts every 50 jobs (ffmpeg.wasm crashes after ~100–150).
- Chapter headings: only "Chapter N" (also Part/Book/Section) by default; the bare-number option is opt-in.
  `insertChapter` removes duplicates from overlapping clips.
- Chapter marker = first sound after the pause before the chapter (`startOf` in chapters.js). Checked to 0.01–0.06 s
  against synthetic music. Owner's leftover-syllable complaint addressed; owner still to confirm on the real book.
- Per-chapter row buttons: ▶ listen (plays from the marker), ± nudge start by typed seconds (negative earlier), ✕ remove.
- Enter in a title box: next chapter's title box + plays its start.

## Decisions (don't reopen)
- Leave the "skip short pauses" and "go back for missing chapter numbers" idea OFF the live site. A combined test was
  ~2x slower than the live version (1063 s vs 541 s) for no fewer speech calls. Kept on `backup/skip-and-turns`
  (commits c4fee4a, 8583ffc, 408bb9e). Turn-taking alone (292b7ac) was measured no slower (548 s vs 552 s) and is live.
- Bare-number headings are off by default (they turned story lines into false chapters).
- Pushes go live immediately, so test before pushing. Owner asked for no changes unless told to.
- Owner prefers plain-language replies, and times in their own time zone (Pacific).

## Open
- Owner to confirm the chapter markers and the ▶/± controls on the real book (narrator and music not yet tested for real).
- Possible later: a faster GPU path (untestable here); a "listen for more chapters" for single M4B files that already
  have chapter markers (not built, only offered).
- Speed: Quick mode on a 10 h book is roughly 10–20 min; Thorough is ~1.5 h with 2 workers.
- The 117-track sample book in the test scratchpad is not in the repo; regenerate from espeak-ng if needed.

## Where things live
- Branch: claude/inspiring-heisenberg-ejsn8q (no PR open; work is pushed straight to the branch).
- Backup branch (unshipped skip/turns experiments): backup/skip-and-turns.
- Key files: docs/app.js (UI), docs/js/listen.js (listening + pool), docs/js/chapters.js (heading rules, markers,
  export formats), docs/js/audio.js (ffmpeg.wasm wrapper, save), docs/js/whisper-worker.js, NOTES.md (working notes).
- Tests: `node --test tests/*.test.mjs` (36 pass). `python -m pytest` (server version).
- Test scratch files are in /tmp/abr-meta.IKNn (not in repo).
- Notes for collaborators: NOTES.md at the repo root (Codex also works on this project, on codex/audio-intake-errors).
