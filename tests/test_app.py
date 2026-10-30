import os
import subprocess
import time

import pytest
from fastapi.testclient import TestClient

from app import chapters as ch


@pytest.fixture(scope="session")
def tone_book(tmp_path_factory):
    """20s mp3: tones of 4s/4s/8s separated by 2s of silence."""
    p = tmp_path_factory.mktemp("audio") / "book.mp3"
    inputs = []
    for kind, dur in [("sine=frequency=440", 4), ("anullsrc=r=44100:cl=mono", 2),
                      ("sine=frequency=550", 4), ("anullsrc=r=44100:cl=mono", 2),
                      ("sine=frequency=660", 8)]:
        inputs += ["-f", "lavfi", "-t", str(dur), "-i", kind]
    subprocess.run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex",
                    "[0][1][2][3][4]concat=n=5:v=0:a=1", str(p)], check=True)
    return p


def test_parse_announcement():
    assert ch.parse_announcement("Chapter twelve. The Long Road Home. It was a dark night") == "Chapter 12: The Long Road Home"
    assert ch.parse_announcement("Chapter 3") == "Chapter 3"
    assert ch.parse_announcement("Chapter twenty-one: Fire") == "Chapter 21: Fire"
    assert ch.parse_announcement("Prologue") == "Prologue"
    assert ch.parse_announcement("Chapter IV. Rain") == "Chapter IV: Rain"
    assert ch.parse_announcement("He walked into the chapter house") is None
    assert ch.parse_announcement("Part of the problem was money.") is None


def _words(text, pauses=()):
    """Fake timestamped words; `pauses` = indexes of words followed by a 1s pause."""
    out, t = [], 0.0
    for i, w in enumerate(text.split()):
        out.append({"word": w, "start": t, "end": t + 0.3})
        t += 0.3 + (1.0 if i in pauses else 0.0)
    return out


def test_find_announcements_mid_stream():
    # heading in the middle of continuous narration, title ends at a pause
    w = _words("and then she left the house for good. Chapter seven The Long Road Home It was cold",
               pauses={13})
    r = ch.find_announcements(w)
    assert r == [{"start": round(w[8]["start"] - 0.3, 2), "title": "Chapter 7: The Long Road Home"}]
    # mid-sentence mention is not a heading
    assert ch.find_announcements(_words("she read the next chapter seven times")) == []
    assert ch.find_announcements(_words("He said chapter two was boring")) == []


def test_silence_detection(tone_book):
    sil = ch.detect_silences(str(tone_book), min_silence=1.0)
    assert len(sil) == 2
    assert 3.8 < sil[0][0] < 4.3 and sil[0][1] > 5.5


def test_pause_based_chapters(tone_book):
    r = ch.detect_chapters(str(tone_book), mode="silence", min_gap=1.0, min_chapter=3.0)
    assert r["source"] == "silence"
    assert [c["title"] for c in r["chapters"]] == ["Chapter 1", "Chapter 2", "Chapter 3"]


def test_ffmetadata_roundtrip(tone_book, tmp_path):
    chs = [{"start": 0, "title": "One; a=b"}, {"start": 6, "title": "Two"}]
    meta = tmp_path / "m.ffmeta"
    meta.write_text(ch.to_ffmetadata(chs, 20.0, "T"))
    out = tmp_path / "out.mp3"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(tone_book), "-i", str(meta),
                    "-map", "0", "-map_metadata", "1", "-map_chapters", "1", "-c", "copy", str(out)], check=True)
    got = ch.probe(str(out))["chapters"]
    assert [c["title"] for c in got] == ["One; a=b", "Two"]
    # re-analysis of a file with embedded chapters uses them
    assert ch.detect_chapters(str(out))["source"] == "embedded"


def test_api_flow(tone_book, tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    import importlib
    from app import main
    importlib.reload(main)
    fake = {"duration": 20.0, "title": None, "author": None, "source": "silence",
            "chapters": [{"start": 0.0, "title": "Chapter 1"}, {"start": 6.0, "title": "Chapter 2"}]}
    monkeypatch.setattr(main.ch, "detect_chapters", lambda path, mode, progress, on_chapter: fake)
    c = TestClient(main.app)
    with open(tone_book, "rb") as f:
        r = c.post("/api/books", files={"file": ("My Book.mp3", f, "audio/mpeg")}, data={"mode": "auto"})
    assert r.status_code == 200
    bid = r.json()["id"]
    for _ in range(50):
        b = c.get(f"/api/books/{bid}").json()
        if b["status"] != "processing":
            break
        time.sleep(0.1)
    assert b["status"] == "ready" and len(b["chapters"]) == 2 and b["title"] == "My Book"

    r = c.put(f"/api/books/{bid}/chapters", json={"chapters": [{"start": 6, "title": "Storm"}, {"start": 0, "title": "Intro"}]})
    assert [x["title"] for x in r.json()["chapters"]] == ["Intro", "Storm"]
    assert c.put(f"/api/books/{bid}/chapters", json={"chapters": [{"start": 999, "title": "x"}]}).status_code == 400

    assert c.get(f"/api/books/{bid}/audio", headers={"Range": "bytes=0-99"}).status_code == 206
    assert "[CHAPTER]" in c.get(f"/api/books/{bid}/export?format=ffmetadata").text
    assert "TRACK 02" in c.get(f"/api/books/{bid}/export?format=cue").text
    exp = c.get(f"/api/books/{bid}/export?format=audio")
    assert exp.status_code == 200
    out = tmp_path / "dl.mp3"
    out.write_bytes(exp.content)
    assert [x["title"] for x in ch.probe(str(out))["chapters"]] == ["Intro", "Storm"]

    assert c.post("/api/books", files={"file": ("x.mp3", b"not audio")}).status_code == 400
    assert c.get("/api/books/../etc").status_code in (404, 422)
    assert c.delete(f"/api/books/{bid}").status_code == 200
    assert c.get(f"/api/books/{bid}").status_code == 404


def test_standalone_heading_with_period_has_no_title():
    r = ch.find_announcements(_words("Epilogue. Years passed and the village forgot"))
    assert r[0]["title"] == "Epilogue"


def test_roman_numerals_are_not_greedy():
    assert ch.parse_announcement("Chapter civil war was long") is None
    assert ch.parse_announcement("Chapter XII. Rain") == "Chapter XII: Rain"
