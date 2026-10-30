"""Audiobook chapter server. Run: uvicorn app.main:app"""
import json
import os
import shutil
import subprocess
import threading
import uuid
from pathlib import Path
from typing import List

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import chapters as ch

DATA = Path(os.environ.get("DATA_DIR", "data"))
DATA.mkdir(parents=True, exist_ok=True)
STATIC = Path(__file__).parent / "static"

app = FastAPI(title="Audiobook Chapter Reader")
_lock = threading.Lock()


def _dir(book_id: str) -> Path:
    if not book_id.isalnum():
        raise HTTPException(404, "Not found")
    d = DATA / book_id
    if not (d / "book.json").exists():
        raise HTTPException(404, "Not found")
    return d


def _load(book_id: str) -> dict:
    return json.loads((_dir(book_id) / "book.json").read_text())


def _save(book_id: str, book: dict):
    with _lock:
        tmp = DATA / book_id / "book.json.tmp"
        tmp.write_text(json.dumps(book, indent=2))
        tmp.replace(DATA / book_id / "book.json")


def _audio_path(book: dict, book_id: str) -> str:
    return str(DATA / book_id / book["file"])


def _analyze(book_id: str, mode: str):
    book = _load(book_id)

    def progress(p, msg):
        book.update(progress=round(p, 3), message=msg)
        _save(book_id, book)

    def on_chapter(found):  # show chapters in the UI the moment they're heard
        book["chapters"] = found
        _save(book_id, book)

    try:
        result = ch.detect_chapters(_audio_path(book, book_id), mode, progress, on_chapter)
        book.update(result, status="ready", progress=1.0, message="Done")
        book["title"] = book.get("title") or Path(book["filename"]).stem
    except Exception as exc:
        book.update(status="error", message=f"Analysis failed: {exc}")
    _save(book_id, book)


@app.post("/api/books")
async def upload(background: BackgroundTasks, file: UploadFile = File(...),
                 mode: str = Form("auto")):
    if mode not in ("auto", "silence"):
        raise HTTPException(400, "mode must be 'auto' or 'silence'")
    book_id = uuid.uuid4().hex[:12]
    d = DATA / book_id
    d.mkdir(parents=True)
    ext = Path(file.filename or "").suffix.lower()[:8] or ".bin"
    stored = f"audio{ext}"
    with open(d / stored, "wb") as out:
        shutil.copyfileobj(file.file, out, 1024 * 1024)
    try:
        info = ch.probe(str(d / stored))
        if info["duration"] <= 0:
            raise ValueError("no audio duration")
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(400, "That doesn't look like an audio file ffmpeg can read.")
    _save(book_id, {"id": book_id, "filename": file.filename, "file": stored,
                    "title": info["title"] or Path(file.filename or "Untitled").stem,
                    "author": info["author"], "duration": info["duration"],
                    "status": "processing", "progress": 0.0, "message": "Queued",
                    "chapters": [], "source": None})
    background.add_task(_analyze, book_id, mode)
    return {"id": book_id}


@app.get("/api/books")
def list_books():
    books = []
    for p in sorted(DATA.glob("*/book.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        b = json.loads(p.read_text())
        books.append({k: b.get(k) for k in
                      ("id", "title", "author", "duration", "status", "source")}
                     | {"chapter_count": len(b.get("chapters", []))})
    return books


@app.get("/api/books/{book_id}")
def get_book(book_id: str):
    return _load(book_id)


class Chapter(BaseModel):
    start: float
    title: str


class BookEdit(BaseModel):
    title: str | None = None
    chapters: List[Chapter]


@app.put("/api/books/{book_id}/chapters")
def edit_chapters(book_id: str, edit: BookEdit):
    book = _load(book_id)
    chs = sorted((c.model_dump() for c in edit.chapters), key=lambda c: c["start"])
    if any(c["start"] < 0 or c["start"] > book["duration"] for c in chs):
        raise HTTPException(400, "Chapter start outside the audio")
    book["chapters"] = chs
    if edit.title:
        book["title"] = edit.title
    _save(book_id, book)
    return book


@app.post("/api/books/{book_id}/reanalyze")
def reanalyze(book_id: str, background: BackgroundTasks, mode: str = "auto"):
    book = _load(book_id)
    book.update(status="processing", progress=0.0, message="Queued", chapters=[])
    _save(book_id, book)
    background.add_task(_analyze, book_id, mode)
    return {"id": book_id}


@app.delete("/api/books/{book_id}")
def delete_book(book_id: str):
    shutil.rmtree(_dir(book_id))
    return {"ok": True}


@app.get("/api/books/{book_id}/audio")
def audio(book_id: str):
    book = _load(book_id)
    return FileResponse(_audio_path(book, book_id), filename=book["filename"],
                        content_disposition_type="inline")


@app.get("/api/books/{book_id}/export")
def export(book_id: str, format: str = "json"):
    book = _load(book_id)
    if format == "json":
        return JSONResponse(book["chapters"])
    if format == "ffmetadata":
        return PlainTextResponse(ch.to_ffmetadata(book["chapters"], book["duration"], book["title"]))
    if format == "cue":
        lines = [f'TITLE "{book["title"]}"', f'FILE "{book["filename"]}" WAVE']
        for i, c in enumerate(book["chapters"], 1):
            m, s = divmod(c["start"], 60)
            lines += [f"  TRACK {i:02d} AUDIO", f'    TITLE "{c["title"]}"',
                      f"    INDEX 01 {int(m):02d}:{int(s):02d}:{int(s % 1 * 75):02d}"]
        return PlainTextResponse("\n".join(lines) + "\n")
    if format == "audio":  # same audio, chapters embedded, no re-encode
        d = _dir(book_id)
        src = _audio_path(book, book_id)
        meta = d / "chapters.ffmeta"
        meta.write_text(ch.to_ffmetadata(book["chapters"], book["duration"], book["title"]))
        ext = Path(src).suffix
        out = d / f"export{ext}"
        proc = subprocess.run(
            ["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", src, "-i", str(meta),
             "-map", "0", "-map_metadata", "1", "-map_chapters", "1", "-c", "copy", str(out)],
            capture_output=True, text=True)
        if proc.returncode:
            raise HTTPException(500, f"ffmpeg failed: {proc.stderr[-300:]}")
        return FileResponse(out, filename=f"{book['title']}{ext}")
    raise HTTPException(400, "format must be json, ffmetadata, cue or audio")


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
