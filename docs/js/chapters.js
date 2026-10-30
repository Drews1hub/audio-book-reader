// Spoken-heading detection and chapter export helpers. Pure functions, no DOM, so they run in tests too.
// Mirrors app/chapters.py (the server version).

const NUMBERED = new Set(['chapter', 'part', 'book', 'section', 'appendix']);
const STANDALONE = new Set(['prologue', 'epilogue', 'introduction', 'preface', 'foreword', 'afterword',
  'prelude', 'interlude', 'dedication', 'acknowledgments', 'acknowledgements']);
const ROMAN = '(?=[ivxlc])(?:c|xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})';
const NUM_RE = new RegExp(
  '^(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ](?:one|two|three|four|five|six|seven|eight|nine)' +
  '|\\d+|' + ROMAN + '|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|' +
  'fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|' +
  'first|second|third|fourth|fifth)$', 'i');
const WORD_NUMS = {};
'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'
  .split(' ').forEach((w, i) => { WORD_NUMS[w] = i; });
Object.assign(WORD_NUMS, { thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 });
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
const TENS = new Set(['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']);
const ONES = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']);
const SENTENCE_END = /[.!?:\u2014]$/;

export function fmtNum(s) {
  s = s.toLowerCase();
  if (/^\d+$/.test(s)) return s;
  if (s in WORD_NUMS) return String(WORD_NUMS[s]);
  if (s in ORDINALS) return String(ORDINALS[s]);
  const parts = s.split(/[- ]/);
  if (parts.length === 2 && parts[0] in WORD_NUMS && parts[1] in WORD_NUMS) {
    return String(WORD_NUMS[parts[0]] + WORD_NUMS[parts[1]]);
  }
  return /^[ivxlc]+$/.test(s) ? s.toUpperCase() : s;
}

const norm = (w) => w.toLowerCase().replace(/[^\w-]/g, '');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Scan timestamped words [{word, start, end}] for spoken chapter headings.
 * A heading must begin a sentence (the previous word ends with . ! ? : or a pause of >= `gap` s precedes it).
 * The title is the words that follow, up to a sentence end, a pause >= `titleGap`, or `maxTitleWords`.
 * Returns [{start, title}].
 */
export function findAnnouncements(words, { gap = 0.5, titleGap = 0.7, maxTitleWords = 10, silences = [],
  bareNumbers = true, strongPause = 1.2, startsAfterPause = false } = {}) {
  const found = [];
  const n = words.length;
  // Whisper stamps a word after a pause right at the end of the word before it, so pauses are also read from the
  // audio itself (`silences`, [{start, end}] in the same timeline): length of the pause before word j.
  const pauseBefore = (j) => {
    let p = Math.max(0, words[j].start - words[j - 1].end);
    for (const s of silences) {
      if (s.start >= words[j - 1].end - 0.3 && s.start <= words[j].start + 0.3) p = Math.max(p, s.end - s.start);
    }
    return p;
  };
  let i = 0;
  // Some books say just "Twelve." (no "Chapter") after a long pause. Only a number said on its own counts:
  // a long pause before it, and a sentence end or pause right after it.
  const bareNumberAt = (i) => {
    if (!bareNumbers) return 0;
    const w = norm(words[i].word);
    if (!/^(\d+|[a-z]+(-[a-z]+)?)$/.test(w) || !NUM_RE.test(w) || /^[ivxlc]+$/.test(w)) return 0;
    const before = i === 0 ? (startsAfterPause ? Infinity : 0) : pauseBefore(i);
    if (before < strongPause) return 0;
    let j = i + 1;
    if (TENS.has(w) && j < n && ONES.has(norm(words[j].word)) && !/[.!?]$/.test(words[i].word.trimEnd())) j++;
    const last = words[j - 1];
    const alone = /[.!?:]$/.test(last.word.trimEnd()) || j >= n || pauseBefore(j) >= 0.6;
    return alone ? j - i : 0;
  };
  while (i < n) {
    const kw = norm(words[i].word);
    const bare = !NUMBERED.has(kw) && !STANDALONE.has(kw) ? bareNumberAt(i) : 0;
    if (bare) {
      const num = words.slice(i, i + bare).map((w) => norm(w.word)).join(' ');
      let j = i + bare;
      const title = [];
      while (j < n && title.length < maxTitleWords) {
        const w = words[j];
        if (title.length && pauseBefore(j) >= titleGap) break;
        if (!title.length && pauseBefore(j) >= 3.0) break;
        title.push(w.word.trim());
        j++;
        if (/[.!?]$/.test(w.word.trimEnd())) break;
      }
      const text = title.join(' ').replace(/^[\s.,:;!?\u2014-]+|[\s.,:;!?\u2014-]+$/g, '');
      found.push({
        start: Math.max(0, Math.round((words[i].start - 0.3) * 100) / 100),
        title: text && title.length < maxTitleWords ? `Chapter ${fmtNum(num)}: ${text}` : `Chapter ${fmtNum(num)}`,
      });
      i = j;
      continue;
    }
    if (!NUMBERED.has(kw) && !STANDALONE.has(kw)) { i++; continue; }
    if (i > 0) {
      const prev = words[i - 1];
      const startsSentence = SENTENCE_END.test(prev.word.trimEnd()) || pauseBefore(i) >= gap;
      if (!startsSentence) { i++; continue; }
    }
    let j = i + 1;
    let label = cap(kw);
    if (NUMBERED.has(kw)) {
      if (j >= n || !NUM_RE.test(norm(words[j].word))) { i++; continue; }
      let num = norm(words[j].word);
      j++;
      if (TENS.has(num) && j < n && ONES.has(norm(words[j].word))) { // "twenty one" as two words
        num += ' ' + norm(words[j].word);
        j++;
      }
      label += ' ' + fmtNum(num);
    }
    const title = [];
    // "Epilogue." on its own: what follows is the story, not a title
    let stop = STANDALONE.has(kw) && /[.!?]$/.test(words[i].word.trimEnd());
    while (!stop && j < n && title.length < maxTitleWords) {
      const w = words[j];
      const pause = pauseBefore(j);
      if (title.length && pause >= titleGap) break;
      if (!title.length && pause >= 3.0) break; // long silence after "Chapter 3": no spoken title
      title.push(w.word.trim());
      j++;
      if (/[.!?]$/.test(w.word.trimEnd())) break;
    }
    const text = title.join(' ').replace(/^[\s.,:;!?\u2014-]+|[\s.,:;!?\u2014-]+$/g, '');
    found.push({
      start: Math.max(0, Math.round((words[i].start - 0.3) * 100) / 100),
      title: text && title.length < maxTitleWords ? `${label}: ${text}` : label,
    });
    i = j;
  }
  return found;
}

/** Runs of quiet audio. samples: Float32Array at `rate` Hz. Returns [{start, end}] in seconds from the start of `samples`. */
export function findSilences(samples, rate, { minSilence = 1.0, thresholdDb = -35 } = {}) {
  const frame = Math.round(rate * 0.05);
  const limit = Math.pow(10, thresholdDb / 20);
  const out = [];
  let quietSince = null;
  const nFrames = Math.floor(samples.length / frame);
  for (let f = 0; f <= nFrames; f++) {
    let quiet = false;
    if (f < nFrames) {
      let sum = 0;
      for (let k = f * frame, e = k + frame; k < e; k++) sum += samples[k] * samples[k];
      quiet = Math.sqrt(sum / frame) < limit;
    }
    if (quiet && quietSince === null) quietSince = f;
    if (!quiet && quietSince !== null) {
      const start = quietSince * 0.05, end = f * 0.05;
      if (end - start >= minSilence) out.push({ start, end });
      quietSince = null;
    }
  }
  return out;
}

/**
 * Shorten long silences (Whisper's timing falls apart on them). Returns the shorter audio plus `pieces`
 * [{from, to, at}] (original seconds kept, and where that piece starts in the new audio) so times can be mapped back.
 */
export function squeezeSilences(samples, rate, { minSilence = 1.0, keep = 0.4 } = {}) {
  const cuts = [];
  for (const s of findSilences(samples, rate, { minSilence })) {
    if (s.end - s.start > 2 * keep + 0.05) cuts.push([s.start + keep, s.end - keep]);
  }
  if (!cuts.length) return { samples, pieces: [{ from: 0, to: samples.length / rate, at: 0 }] };
  const pieces = [];
  const parts = [];
  let origPos = 0, at = 0;
  const take = (from, to) => {
    const a = Math.round(from * rate), b = Math.min(samples.length, Math.round(to * rate));
    if (b <= a) return;
    parts.push(samples.subarray(a, b));
    pieces.push({ from, to, at });
    at += (b - a) / rate;
  };
  for (const [cs, ce] of cuts) { take(origPos, cs); origPos = ce; }
  take(origPos, samples.length / rate);
  const out = new Float32Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return { samples: out, pieces };
}

/** Map a time in the squeezed audio back to the original timeline. */
export function unsqueeze(t, pieces) {
  let piece = pieces[0];
  for (const p of pieces) { if (p.at <= t + 1e-6) piece = p; else break; }
  return piece.from + (t - piece.at);
}

const esc = (s) => s.replace(/([=;#\\\n])/g, '\\$1');

export function toFfmetadata(chapters, duration, title = '') {
  chapters = chapters.filter((c) => c.start < duration); // a chapter must start inside the audio
  const lines = [';FFMETADATA1'];
  if (title) lines.push(`title=${esc(title)}`);
  chapters.forEach((c, i) => {
    const end = i + 1 < chapters.length ? chapters[i + 1].start : duration;
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.floor(c.start * 1000)}`,
      `END=${Math.floor(end * 1000)}`, `title=${esc(c.title)}`);
  });
  return lines.join('\n') + '\n';
}

/** Chapters (and book title/artist) from the text `ffmpeg -f ffmetadata` writes. */
export function parseFfmetadata(text) {
  const chapters = [];
  const tags = {};
  let cur = null;
  let base = 1 / 1000;
  const unesc = (s) => s.replace(/\\(.)/g, '$1');
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line === '[CHAPTER]') { cur = {}; chapters.push(cur); base = 1 / 1000; continue; }
    if (line.startsWith('[')) { cur = null; continue; }
    const m = /^((?:\\.|[^=\\])+)=(.*)$/.exec(line);
    if (!m) continue;
    const key = unesc(m[1]).toLowerCase();
    if (cur) {
      if (key === 'timebase') { const [a, b] = m[2].split('/').map(Number); base = a / b; }
      else if (key === 'start') cur.start = Number(m[2]) * base;
      else if (key === 'title') cur.title = unesc(m[2]);
    } else tags[key] = unesc(m[2]);
  }
  return {
    tags,
    chapters: chapters.filter((c) => c.start !== undefined)
      .map((c, i) => ({ start: c.start, title: c.title || `Chapter ${i + 1}` })),
  };
}

export function toCue(chapters, title, filename) {
  const lines = [`TITLE "${title}"`, `FILE "${filename}" WAVE`];
  chapters.forEach((c, i) => {
    const m = Math.floor(c.start / 60), s = Math.floor(c.start % 60), fr = Math.floor((c.start % 1) * 75);
    const p = (x) => String(x).padStart(2, '0');
    lines.push(`  TRACK ${p(i + 1)} AUDIO`, `    TITLE "${c.title.replace(/"/g, "'")}"`, `    INDEX 01 ${p(m)}:${p(s)}:${p(fr)}`);
  });
  return lines.join('\n') + '\n';
}

export function fmtTime(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(x).padStart(2, '0')}`;
}
