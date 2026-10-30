# Audiobook Chapter Reader

Upload an audiobook; the server finds the chapters, names them, and gives you a
player where you can jump between, rename, add and export chapters.

## Run

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
