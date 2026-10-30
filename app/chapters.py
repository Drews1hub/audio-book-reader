"""Chapter detection for audiobooks.

Strategy, in order:
1. Chapters already embedded in the file (ffprobe) are used as-is.
2. Smart mode (needs faster-whisper): the whole book is transcribed in
   overlapping windows with word timestamps. Wherever the narrator says
   "Chapter 7 ..." / "Prologue" etc. at the start of a sentence, a chapter is
   created at that moment and titled from the words that follow
   ("Chapter 7: The Long Road Home"). Chapters are reported live as heard.
3. Fast mode (or if nothing is heard): ffmpeg `silencedetect` long pauses
   become "Chapter N" markers.
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


_NUMBERED = {"chapter", "part", "book", "section", "appendix"}
_STANDALONE = {"prologue", "epilogue", "introduction", "preface", "foreword", "afterword",
               "prelude", "interlude", "dedication", "acknowledgments", "acknowledgements"}
_NUM = (r"(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ]"
        r"(?:one|two|three|four|five|six|seven|eight|nine)|\d+|(?=[ivxlc])(?:c|xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})|zero|one|two|three|four|"
        r"five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|"
        r"eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|"
        r"second|third|fourth|fifth")
_NUM_RE = re.compile(rf"^(?:{_NUM})$", re.I)
_WORD_NUMS = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
    "fifteen sixteen seventeen eighteen nineteen twenty".split())}
_WORD_NUMS.update({"thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
                   "eighty": 80, "ninety": 90})
_ORDINALS = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5}


def _fmt_num(s: str) -> str:
    s = s.lower()
    if s.isdigit():
        return s
    if s in _WORD_NUMS:
        return str(_WORD_NUMS[s])
    if s in _ORDINALS:
        return str(_ORDINALS[s])
    parts = re.split(r"[- ]", s)
    if len(parts) == 2 and parts[0] in _WORD_NUMS and parts[1] in _WORD_NUMS:
        return str(_WORD_NUMS[parts[0]] + _WORD_NUMS[parts[1]])
    return s.upper() if re.fullmatch(r"[ivxlc]+", s) else s


def _norm(w: str) -> str:
    return re.sub(r"[^\w-]", "", w.lower())


def find_announcements(words: list, gap: float = 0.5, title_gap: float = 0.7,
                       max_title_words: int = 10) -> list:
    """Scan timestamped words [{word,start,end}] for spoken chapter headings.

    A heading must begin a sentence (previous word ends with .!?:, or a pause of
    >= `gap` seconds precedes it). The title is the words that follow until a
    sentence end, a pause >= `title_gap`, or `max_title_words`.
    Returns [{start, title}].
    """
    found, i, n = [], 0, len(words)
    while i < n:
        kw = _norm(words[i]["word"])
        if kw not in _NUMBERED and kw not in _STANDALONE:
            i += 1
            continue
        if i > 0:
            prev = words[i - 1]
            if not (prev["word"].rstrip().endswith((".", "!", "?", ":", "\u2014")) or
                    words[i]["start"] - prev["end"] >= gap):
                i += 1
                continue
        j = i + 1
        label = kw.capitalize()
        if kw in _NUMBERED:
            if j >= n or not _NUM_RE.match(_norm(words[j]["word"])):
                i += 1
                continue
            num = _norm(words[j]["word"])
            j += 1
            # "twenty one" spoken as two words
            if num in ("twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety") \
                    and j < n and _norm(words[j]["word"]) in list(_WORD_NUMS)[1:10]:
                num += " " + _norm(words[j]["word"])
                j += 1
            label = f"{label} {_fmt_num(num)}"
        title = []
        # "Epilogue." on its own: what follows is the story, not a title
        stop = kw in _STANDALONE and words[i]["word"].rstrip().endswith((".", "!", "?"))
        while not stop and j < n and len(title) < max_title_words:
            w = words[j]
            if title and w["start"] - words[j - 1]["end"] >= title_gap:
                break
            if not title and w["start"] - words[j - 1]["end"] >= 3.0:
                break  # long silence after "Chapter 3" -> the title (if any) is not spoken
            title.append(w["word"].strip())
            j += 1
            if w["word"].rstrip().endswith((".", "!", "?")):
                break
        text = " ".join(title).strip(" .,:;!?\u2014-")
        found.append({"start": max(0.0, round(words[i]["start"] - 0.3, 2)),
                      "title": f"{label}: {text}" if text and len(title) < max_title_words else label})
        i = j
    return found


def parse_announcement(text: str) -> Optional[str]:
    """Plain-text convenience wrapper around find_announcements (no timestamps)."""
    words, t = [], 0.0
    for w in text.split():
        words.append({"word": w, "start": t, "end": t + 0.3})
        t += 0.3
    res = find_announcements(words)
    return res[0]["title"] if res and res[0]["start"] == 0.0 else None


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


def transcribe_words(path: str, start: float, length: float) -> list:
    """Word-level transcript of [start, start+length) with absolute timestamps."""
    import numpy as np  # installed with faster-whisper
    # Decode with ffmpeg ourselves so we don't depend on PyAV's API (it changes between releases).
    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-ss", str(start), "-t", str(length),
         "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
        capture_output=True, check=True).stdout
    audio = np.frombuffer(raw, dtype=np.float32)
    if len(audio) < 16000:
        return []
    segments, _ = _get_model().transcribe(audio, language="en", beam_size=1,
                                          word_timestamps=True, vad_filter=True)
    return [{"word": w.word, "start": start + w.start, "end": start + w.end}
            for seg in segments for w in (seg.words or [])]


def listen_for_chapters(path: str, duration: float, progress: Progress,
                        on_chapter: Callable[[list], None],
                        step: float = 600.0, overlap: float = 20.0) -> list:
    """Transcribe the whole file; a window only 'owns' headings that start inside its step,
    the overlap just lets a heading at the edge finish being spoken."""
    chapters, t = [], 0.0
    while t < duration:
        words = transcribe_words(path, t, step + overlap)
        last = t + step >= duration
        for a in find_announcements(words):
            if a["start"] >= t + step and not last:
                continue
            if a["start"] < t and t > 0:
                continue
            if chapters and a["start"] - chapters[-1]["start"] < 5:
                continue
            chapters.append(a)
            on_chapter(list(chapters))
            progress(min(0.98, 0.05 + 0.93 * t / duration), f"Heard: {a['title']}")
        t += step
        progress(min(0.98, 0.05 + 0.93 * t / duration),
                 f"Listening… {int(min(t, duration) // 60)} of {int(duration // 60)} min")
    return chapters


def detect_chapters(path: str, mode: str = "auto", progress: Progress = lambda p, m: None,
                    on_chapter: Callable[[list], None] = lambda c: None,
                    min_gap: float = 2.0, min_chapter: float = 60.0,
                    step: float = 600.0) -> dict:
    """mode: auto | silence. Returns {duration, title, author, source, chapters}."""
    info = probe(path)
    duration = info["duration"]
    meta = {"duration": duration, "title": info["title"], "author": info["author"]}

    if info["chapters"]:
        progress(1.0, "Using chapters embedded in the file")
        return {**meta, "source": "embedded", "chapters": info["chapters"]}

    found = []
    if mode == "auto" and whisper_available():
        progress(0.02, "Loading speech model")
        try:
            found = listen_for_chapters(path, duration, progress, on_chapter, step=step)
        except Exception as exc:  # model download blocked, bad audio, ...
            progress(0.05, f"Listening failed ({exc}); falling back to pauses")
            found = []
    if found:
        source = "speech"
        if found[0]["start"] > 1.0:  # keep whatever precedes the first chapter playable
            found.insert(0, {"start": 0.0, "title": "Opening"})
    else:
        source = "silence"
        progress(0.05, "Scanning for pauses")
        gaps = [e for s, e in detect_silences(path) if e - s >= min_gap and e < duration - 5]
        starts, last = [0.0], 0.0
        for t in gaps:
            if t - last >= min_chapter:
                starts.append(t)
                last = t
        found = [{"start": round(t, 2), "title": f"Chapter {i + 1}"} for i, t in enumerate(starts)]
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
