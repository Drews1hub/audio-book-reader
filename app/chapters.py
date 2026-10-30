"""Chapter detection for audiobooks.

Strategy, in order:
1. Chapters already embedded in the file (ffprobe) are used as-is.
2. ffmpeg `silencedetect` finds long pauses; each is a candidate chapter break.
3. If faster-whisper is installed, a short clip after each pause (and at the
   very start) is transcribed. Clips that open with "Chapter 7 ..." / "Prologue"
   etc. become chapters, named from what the narrator says.
4. Without whisper (or if it finds nothing) the long pauses become
   "Chapter N" markers.
"""
import json
import os
import re
import subprocess
from typing import Callable, Optional

Progress = Callable[[float, str], None]

_model = None


def probe(path: str) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json",
         "-show_format", "-show_chapters", path],
        capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    duration = float(data.get("format", {}).get("duration") or 0)
    chapters = []
    for c in data.get("chapters", []):
        title = (c.get("tags") or {}).get("title") or f"Chapter {len(chapters) + 1}"
        chapters.append({"start": float(c["start_time"]), "title": title})
    tags = data.get("format", {}).get("tags") or {}
    tags = {k.lower(): v for k, v in tags.items()}
    return {"duration": duration, "chapters": chapters,
            "title": tags.get("title"), "author": tags.get("artist") or tags.get("author")}


def detect_silences(path: str, noise_db: int = -35, min_silence: float = 1.5):
    """Return [(silence_start, silence_end)] using ffmpeg silencedetect."""
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-i", path, "-vn", "-af",
         f"silencedetect=noise={noise_db}dB:d={min_silence}", "-f", "null", "-"],
        capture_output=True, text=True)
    silences, start = [], None
    for line in proc.stderr.splitlines():
        m = re.search(r"silence_start: (-?[\d.]+)", line)
        if m:
            start = max(0.0, float(m.group(1)))
            continue
        m = re.search(r"silence_end: ([\d.]+)", line)
        if m and start is not None:
            silences.append((start, float(m.group(1))))
            start = None
    return silences


_KEYWORDS = (r"chapter|prologue|epilogue|introduction|preface|foreword|afterword|"
             r"prelude|interlude|part|book|section|appendix|acknowledg(?:e)?ments|dedication")
_NUM = (r"(?:twenty|thirty|forty|fifty)[- ](?:one|two|three|four|five|six|seven|eight|nine)|"
        r"\d+|[ivxlc]+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|"
        r"thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|"
        r"fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|fifth")
_HEAD = re.compile(
    rf"^\W*(?P<kw>{_KEYWORDS})\b(?:\s+(?P<num>{_NUM})\b)?[\s.,:;\-–—]*(?P<rest>.*)$",
    re.I | re.S)
_NUMBERED = {"chapter", "part", "book", "section", "appendix"}


def parse_announcement(text: str) -> Optional[str]:
    """'Chapter twelve. The long road home. It was...' -> 'Chapter 12: The long road home'."""
    text = " ".join(text.split())
    m = _HEAD.match(text)
    if not m:
        return None
    kw, num = m.group("kw").lower(), m.group("num")
    if kw in _NUMBERED and not num:
        return None
    label = kw.capitalize() if not num else f"{kw.capitalize()} {_fmt_num(num)}"
    rest = re.split(r"(?<=[.!?])\s", m.group("rest").strip(), maxsplit=1)[0]
    words = rest.rstrip(".!?,;: ").split()
    title = " ".join(words[:8]) if len(words) <= 8 else ""  # long text = body, not a title
    return f"{label}: {title}" if title else label


_WORD_NUMS = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
    "fifteen sixteen seventeen eighteen nineteen twenty".split())}
_WORD_NUMS.update({"thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
                   "eighty": 80, "ninety": 90})


def _fmt_num(s: str) -> str:
    s = s.lower()
    if s.isdigit():
        return s
    if s in _WORD_NUMS:
        return str(_WORD_NUMS[s])
    parts = re.split(r"[- ]", s)
    if len(parts) == 2 and parts[0] in _WORD_NUMS and parts[1] in _WORD_NUMS:
        return str(_WORD_NUMS[parts[0]] + _WORD_NUMS[parts[1]])
    return s.upper() if re.fullmatch(r"[ivxlc]+", s) else s


def whisper_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def _get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel(os.environ.get("WHISPER_MODEL", "base.en"),
                              device="cpu", compute_type="int8")
    return _model


def transcribe_clip(path: str, start: float, length: float = 20.0) -> str:
    import numpy as np  # installed with faster-whisper
    # Decode with ffmpeg ourselves so we don't depend on PyAV's API (it changes between releases).
    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-ss", str(start), "-t", str(length),
         "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
        capture_output=True, check=True).stdout
    audio = np.frombuffer(raw, dtype=np.float32)
    segments, _ = _get_model().transcribe(audio, language="en", beam_size=1)
    return " ".join(s.text.strip() for s in segments)


def detect_chapters(path: str, mode: str = "auto", progress: Progress = lambda p, m: None,
                    min_gap: float = 2.0, min_chapter: float = 60.0) -> dict:
    """mode: auto | silence. Returns {duration, title, author, source, chapters}."""
    info = probe(path)
    duration = info["duration"]
    meta = {"duration": duration, "title": info["title"], "author": info["author"]}

    if info["chapters"]:
        progress(1.0, "Using chapters embedded in the file")
        return {**meta, "source": "embedded", "chapters": info["chapters"]}

    progress(0.05, "Scanning for pauses")
    gaps = [e for s, e in detect_silences(path) if e - s >= min_gap and e < duration - 5]

    use_whisper = mode == "auto" and whisper_available()
    found = []
    if use_whisper:
        candidates = [0.0] + gaps
        for i, t in enumerate(candidates):
            progress(0.15 + 0.8 * i / len(candidates),
                     f"Listening for chapter announcements ({i + 1}/{len(candidates)})")
            try:
                title = parse_announcement(transcribe_clip(path, max(0.0, t - 0.2)))
            except Exception as exc:  # model download blocked, bad clip, ...
                progress(0.15, f"Transcription unavailable ({exc}); falling back to pauses")
                found = []
                break
            if title:
                found.append({"start": round(t, 2), "title": title})
    if found:
        source = "speech"
    else:
        source = "silence"
        starts, last = [0.0], 0.0
        for t in gaps:
            if t - last >= min_chapter:
                starts.append(t)
                last = t
        found = [{"start": round(t, 2), "title": f"Chapter {i + 1}"} for i, t in enumerate(starts)]

    if found[0]["start"] > 1.0:  # keep whatever precedes the first chapter playable
        found.insert(0, {"start": 0.0, "title": "Opening"})
    progress(1.0, "Done")
    return {**meta, "source": source, "chapters": found}


def to_ffmetadata(chapters: list, duration: float, title: str = "") -> str:
    lines = [";FFMETADATA1"]
    if title:
        lines.append(f"title={_esc(title)}")
    for i, c in enumerate(chapters):
        end = chapters[i + 1]["start"] if i + 1 < len(chapters) else duration
        lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={int(c['start'] * 1000)}",
                  f"END={int(end * 1000)}", f"title={_esc(c['title'])}"]
    return "\n".join(lines) + "\n"


def _esc(s: str) -> str:
    return re.sub(r"([=;#\\\n])", r"\\\1", s)
