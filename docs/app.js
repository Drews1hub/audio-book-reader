import { openAudio } from './js/audio.js';
import { formatFileSize } from './js/file-info.js';
import { Whisper, listen } from './js/listen.js';
import { fmtTime, toCue, toFfmetadata } from './js/chapters.js';

const $ = (id) => document.getElementById(id);
const SOURCES = {
  none: '',
  failed: '',
  speech: 'Found by listening: each one was announced by the narrator. Rename any you like.',
  pauses: 'Guessed from long pauses. Rename them as you listen.',
  embedded: 'These chapters were already in the file.',
  manual: 'Edited by you.',
};

let source = null, sourceName = '';   // a File, or an array of Files for a book made of many tracks
let objectUrl = null, audioHandle = null, whisper = null;
let timeline = [], curPart = 0;       // the files in order: [{ file, start, duration }]; curPart is the one in the player
let book = null;            // { title, duration, chapters, source, key }
let stopRequested = false, busy = false, saveTimer = null;
let playable = true;        // false when this browser's own player can't open the format (chapters still work)

// Chrome gives some files (.m4b especially) an empty type, which can stop the player opening them.
const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav' };
const mimeFor = (f) => f.type || MIME[(f.name.split('.').pop() || '').toLowerCase()] || '';

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const storeKey = (src, name) => (Array.isArray(src)
  ? `abr:v1:folder:${name}:${src.length}:${src.reduce((n, f) => n + f.size, 0)}:${src[0].lastModified}`
  : `abr:v1:${src.name}:${src.size}:${src.lastModified}`);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode / full */ } },
};

if ('gpu' in navigator) $('gpuRow').hidden = false;
// When GitHub last published this page, so anyone looking at a screenshot can tell which version it is.
$('ver').textContent = new Date(document.lastModified).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

// ---------- file intake ----------
$('file').onchange = (e) => {
  const files = [...e.target.files].filter((f) => f.size > 0);
  if (files.length > 1) load(files.sort((a, b) => natural(a.name, b.name)), `Audiobook (${files.length} files)`);
  else if (files[0] || e.target.files[0]) load(files[0] || e.target.files[0]);
};
const drop = $('drop');
drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } };
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); handleDrop(e.dataTransfer); };
// A file dropped anywhere else would make the browser leave the page and open it; load it here instead.
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); handleDrop(e.dataTransfer); });

// ---------- dropped folders ----------
// A folder dragged onto a page arrives as an empty, extension-less "file", so look inside it instead.
const AUDIO_EXT = /\.(mp3|m4b|m4a|mp4|aac|flac|ogg|oga|opus|wav|wma)$/i;
const readAll = (dir) => new Promise((resolve) => {
  const reader = dir.createReader(), all = [];
  const next = () => reader.readEntries((es) => { if (!es.length) resolve(all); else { all.push(...es); next(); } }, () => resolve(all));
  next();
});
async function filesIn(entry) {
  if (entry.isFile) {
    const file = await new Promise((r) => entry.file(r, () => r(null)));
    return file ? [{ file, path: entry.fullPath || entry.name || file.name }] : [];
  }
  return (await Promise.all((await readAll(entry)).map(filesIn))).flat();
}
async function handleDrop(dt) {
  if (!dt) return;
  // Entries must be taken before the first await; the browser clears the drop data afterwards.
  const entries = [...(dt.items || [])].map((i) => (i.kind === 'file' && i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  const plain = [...(dt.files || [])];
  const dirs = entries.filter((en) => en?.isDirectory);
  if (!dirs.length) {
    const tracks = plain.filter((f) => f.size > 0 && AUDIO_EXT.test(f.name));
    if (tracks.length > 1) load(tracks.sort((a, b) => natural(a.name, b.name)), `Audiobook (${tracks.length} files)`);
    else plain[0] && load(plain[0]);
    return;
  }
  showProgress('Looking inside the folder…');
  const audio = (await Promise.all(entries.filter(Boolean).map(filesIn))).flat()
    .filter(({ file }) => file.size > 0 && AUDIO_EXT.test(file.name))
    .sort((a, b) => natural(a.path, b.path));
  const m4b = audio.filter(({ file }) => /\.m4b$/i.test(file.name));
  if (audio.length === 1) load(audio[0].file);
  else if (m4b.length === 1) load(m4b[0].file);
  else if (!audio.length) showError('No audio files in that folder.', 'Drop the audiobook file itself (for example an .m4b or .mp3).');
  else load(audio.map((a) => a.file), dirs[0].name);   // many tracks: one book, in file-name order
}

function showProgress(phase, detail = '', value = null) {
  $('progress').hidden = false;
  $('phase').textContent = phase;
  $('detail').textContent = detail;
  if (value === null) $('bar').removeAttribute('value'); else $('bar').value = value;
}
const mins = (ms) => (ms < 90e3 ? 'under a minute' : `about ${Math.round(ms / 60e3)} min`);

const showError = (phase, detail) => { showProgress(phase, detail, 0); $('stop').hidden = true; };

// Wait for the browser's own player to report a length; 0 if it can't open the file.
function playerDuration(el) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(0), 10000);
    el.onloadedmetadata = () => { clearTimeout(t); resolve(el.duration); };
    el.onerror = () => { clearTimeout(t); resolve(0); };
  });
}

async function load(src, name) {
  if (busy) return;
  busy = true;
  try {
    await release();
    const multi = Array.isArray(src);
    const first = multi ? src[0] : src;
    source = src;
    sourceName = name || first.name;
    const size = formatFileSize(multi ? src.reduce((n, f) => n + f.size, 0) : src.size);
    const about = `${sourceName}${multi ? ` · ${src.length} files` : ''} · ${size}`;
    const locked = (multi ? src : [src]).find((f) => /\.aaxc?$/i.test(f.name));
    if (locked) {
      return showError("Audible files can't be opened here.",
        `${locked.name}. Audible .aax/.aaxc files are copy-protected, so only Audible's own apps can play them. Use an MP3, M4B, M4A, FLAC, OGG or WAV file.`);
    }
    if (first.size === 0) {
      return showError('That file is empty (0 bytes).',
        `${first.name}. If it is a folder, open it and drop the audio file inside. If it is stored in iCloud or another cloud folder, download it to this computer first.`);
    }
    // Try the first file in the browser's own player; a book of many files plays one file at a time.
    timeline = [{ file: first, start: 0, duration: 0 }];
    curPart = 0;
    const el = $('audio');
    objectUrl = URL.createObjectURL(new Blob([first], { type: mimeFor(first) }));
    const metadata = playerDuration(el);
    el.src = objectUrl;
    $('stop').hidden = true;
    showProgress('Opening your audiobook…');
    let duration = await metadata;
    playable = isFinite(duration) && duration > 0;
    if (!playable || multi) {
      // The audio engine reads the length (the browser can't play every format; many files need adding up).
      showProgress('Starting the audio engine…', 'One-time 32 MB download, then it is cached.');
      audioHandle = await openAudio(src);
      duration = await audioHandle.duration({
        onProgress: (i, n) => n > 1 && showProgress('Reading your files…', `${i} of ${n}`, i / n),
        onFallback: () => showProgress('Checking the audio itself…',
          'The file has no readable duration. Measuring it may take a while for a long book.'),
      });
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      return showError("Couldn't read that file.",
        `${about}${audioHandle?.lastError ? ` · ${audioHandle.lastError}` : ''}. The audio engine loaded, but could not read this file. Make sure it is the audio file itself and is fully downloaded to your computer. Try an MP3, M4A/M4B, FLAC, OGG or WAV file.`);
    }
    timeline = audioHandle ? audioHandle.parts.map((p) => ({ file: p.file, start: p.start, duration: p.duration }))
      : [{ file: first, start: 0, duration }];
    const key = storeKey(src, sourceName);
    const stem = multi ? sourceName : first.name.replace(/\.[^.]+$/, '');
    let saved = store.get(key);
    // Older versions silently fell back to marking pauses when no headings were heard. Those results (pause guesses
    // from a run that was meant to listen) are wrong, so never bring them back.
    if (saved?.source === 'pauses' && saved.mode && saved.mode !== 'pauses') saved = null;
    if (saved && (saved.chapters?.length || saved.scanned > 0)) {
      book = { ...saved, duration, key, restoredAt: saved.savedAt || true };
      $('progress').hidden = true;
      return showPlayer();
    }
    book = { title: stem, duration, chapters: [], source: null, key };
    if (!audioHandle) {
      showProgress('Starting the audio engine…', 'One-time 32 MB download, then it is cached.');
      audioHandle = await openAudio(src);
    }
    const info = await audioHandle.probe();
    if (info.tags.title && !multi) book.title = info.tags.title;
    if (info.chapters.length) {
      book.chapters = info.chapters;
      book.source = 'embedded';
    } else {
      await run($('mode').value);
    }
    $('progress').hidden = true; persist(); showPlayer();
  } catch (e) {
    showError('Something went wrong.', String(e.message || e));
  } finally {
    busy = false;
  }
}

// Keep the computer awake while listening (only works while this tab is visible).
let wakeLock = null;
async function stayAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { if (busy && document.visibilityState === 'visible') stayAwake(true); });

async function run(mode, from = 0, initial = []) {
  stopRequested = false;
  $('stop').hidden = false;
  $('resumeBox').hidden = true;
  book.mode = mode;
  book.scanned = from;
  delete book.restoredAt;
  stayAwake(true);
  try { await listenRun(mode, from, initial); } finally { stayAwake(false); }
}

async function listenRun(mode, from, initial) {
  if (mode !== 'pauses') {
    whisper = new Whisper();
    const model = book.model = (from > 0 && book.model) || $('model').value;
    const sizes = new Map();
    whisper.onDownload = ({ file: name, loaded, total }) => {
      sizes.set(name, [loaded, total]);
      let l = 0, t = 0;
      sizes.forEach(([a, b]) => { l += a; t += b; });
      showProgress('Downloading the speech model…', `${(l / 1e6).toFixed(0)} of ${(t / 1e6).toFixed(0)} MB. One time only; your browser keeps it.`, t ? l / t : null);
    };
    whisper.onNote = (m) => { $('detail').textContent = m; };
    showProgress('Loading the speech model…');
    try {
      await whisper.load(model, $('gpu').checked);
    } catch (e) {
      whisper.stop(); whisper = null;
      // Say so plainly instead of quietly guessing from pauses.
      book.note = `The speech model could not be loaded (${e.message}), so nothing was listened to. Check your connection and press “Listen again”.`;
      book.source = 'failed';
      book.chapters = [];
      book.scanned = book.duration;
      $('stop').hidden = true;
      return;
    }
  }
  book.note = '';
  if (from === 0) { book.heard = []; $('heardList').innerHTML = ''; }
  book.heard ??= [];
  let live = true;
  const chapters = await listen({
    audio: audioHandle, duration: book.duration, mode, whisper, from, initial,
    shouldStop: () => stopRequested,
    onScanned: (t, list) => { book.scanned = t; if (mode !== 'pauses') book.chapters = list; persist(); },
    onHeard: (h) => {
      if (book.heard.length >= 2000) return;   // plenty to see what the narrator says; keeps saved data small
      book.heard.push(h);
      addHeard(h);
    },
    onProgress: ({ done, eta, text }) =>
      showProgress(text, eta ? `Roughly ${mins(eta)} left. Chapters appear below as they are heard.` : 'Chapters appear below as they are heard.', done),
    onChapters: (list, added) => {
      book.chapters = list; book.source = 'speech';
      if (live) { showPlayer(true, list.indexOf(added)); }
      persist();
    },
  });
  whisper?.stop(); whisper = null;
  book.chapters = chapters;
  if (stopRequested) { $('stop').hidden = true; return; }   // partial: offered as "Continue listening"
  book.scanned = book.duration;
  if (mode === 'pauses') book.source = 'pauses';
  else if (!chapters.length) book.source = 'none';   // explained on the page, with a choice of what to do next
  else book.source = 'speech';
  if (book.chapters.length && book.chapters[0].start > 1) book.chapters.unshift({ start: 0, title: 'Opening' });
  book.scanned = book.duration;
  $('stop').hidden = true;
}

$('stop').onclick = () => { stopRequested = true; $('stop').hidden = true; $('phase').textContent = 'Stopping…'; };

$('resume').onclick = async () => {
  if (busy || !source) return;
  busy = true;
  try {
    audioHandle ??= await openAudio(source);
    await run(book.mode || $('mode').value, book.scanned || 0, book.chapters);
  } catch (e) { showError('Something went wrong.', String(e.message || e)); }
  busy = false;
  $('progress').hidden = true; persist(); showPlayer();
};

async function release() {
  stopRequested = true;
  whisper?.stop(); whisper = null;
  if (audioHandle) { await audioHandle.close(); audioHandle = null; }
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  timeline = []; curPart = 0;
  $('player').hidden = true;
}

// ---------- player + chapter list ----------
function persist() {
  if (book?.key) {
    store.set(book.key, { title: book.title, chapters: book.chapters, source: book.source,
      scanned: book.scanned ?? book.duration, mode: book.mode, model: book.model, heard: book.heard, note: book.note,
      savedAt: Date.now() });
  }
}
function queueSave() { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 400); }

function showPlayer(live = false, flash = -1) {
  $('player').hidden = false;
  $('title').textContent = book.title;
  const many = timeline.length > 1;
  $('audio').hidden = !playable || many;      // many files: our own bar, which spans the whole book
  $('tport').hidden = !playable || !many;
  $('controls').hidden = !playable;
  $('exAudio').textContent = many ? 'One audiobook file with chapters' : 'Audio with chapters';
  $('exNote').textContent = many
    ? `“One audiobook file with chapters” joins your ${timeline.length} files into a single audiobook (no re-encoding) with the chapter titles written in, so players show them as track titles. It builds the whole book in memory, so very large books may fail; use the other formats then.`
    : '“Audio with chapters” keeps the same audio and writes the chapter titles into the file, so players show them as track titles. It builds the file in memory, so very large books (over ~1 GB) may fail; use the other formats then.';
  const restored = book.restoredAt && !live
    ? `Loaded the result saved ${book.restoredAt === true ? 'last time' : new Date(book.restoredAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. Press “Listen again” to start over. ` : '';
  $('source').textContent = restored + (!playable ? "Your browser can't play this file type, so there is no player here, but the chapters are found and can be saved below."
    : live ? 'Listening to the book. Chapters appear as they are heard…' : SOURCES[book.source] || '');
  $('relisten').hidden = live;
  const unfinished = !live && book.scanned !== undefined && book.scanned < book.duration - 1;
  $('resumeBox').hidden = !unfinished;
  if (unfinished) {
    $('resumeText').textContent = `Listened to ${fmtTime(book.scanned)} of ${fmtTime(book.duration)} so far. The chapters found up to there are below.`;
    $('resume').textContent = `Continue listening from ${fmtTime(book.scanned)}`;
  }
  // Listened, but no "Chapter …" was heard: explain and let them choose, rather than inventing chapters.
  const none = !live && !unfinished && (book.source === 'none' || book.source === 'failed');
  $('noneBox').hidden = !none;
  if (none) {
    $('noneText').textContent = book.source === 'failed' ? book.note
      : `It listened ${book.mode === 'thorough' ? 'to the whole book' : `after ${book.heard?.length || 0} pauses`} but never heard a chapter `
        + 'announcement like “Chapter One” or “Twelve”. Open “What it heard” below to see what the narrator says at those points. '
        + (book.mode === 'thorough' ? 'You can mark chapters by long pauses instead, or add them yourself with “Mark chapter here”.'
          : 'Listening to everything catches headings that come without a pause (slower: a few hours for a long book).');
    $('noneThorough').hidden = book.source === 'failed' || book.mode === 'thorough';
  }
  if (!live) renderHeard();
  // Done: say plainly that the original file is untouched and how to get the chapter titles into a file.
  const done = !live && !unfinished && book.chapters.length > 0;
  $('saveBox').hidden = !done;
  if (done && !book.savedAs) {
    $('saveText').textContent = `${book.chapters.length} chapters found. Your original ${timeline.length > 1 ? 'files are' : 'file is'} not changed: `
      + 'save a copy with the chapter titles written in. It goes to your Downloads folder.';
  }
  renderChapters(flash);
  syncTransport();   // the bar needs the book's length before anything plays
}

// ---------- playback across files ----------
// The browser plays one file at a time; these keep a single timeline for the whole book.
const partAt = (t) => { let i = timeline.length - 1; while (i > 0 && timeline[i].start > t) i--; return Math.max(0, i); };
const getTime = () => (timeline[curPart]?.start || 0) + ($('audio').currentTime || 0);

async function loadPart(i) {
  if (i === curPart && objectUrl) return;
  const el = $('audio');
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(new Blob([timeline[i].file], { type: mimeFor(timeline[i].file) }));
  curPart = i;
  const metadata = playerDuration(el);
  el.src = objectUrl;
  await metadata;
}
async function seekTo(t, play = false) {
  if (!timeline.length) return;
  t = Math.min(Math.max(0, t), book?.duration ?? t);
  const i = partAt(t), el = $('audio');
  await loadPart(i);
  el.currentTime = Math.max(0, t - timeline[i].start);
  if (play) el.play().catch(() => {});
}
$('audio').onended = async () => {   // on to the next file
  if (curPart < timeline.length - 1) {
    await loadPart(curPart + 1);
    $('audio').play().catch(() => {});
  }
};

// The bar shown when a book is made of many files.
let scrubbing = false;
function syncTransport() {
  if (!book) return;
  const t = getTime();
  $('tPlay').textContent = $('audio').paused ? '▶' : '⏸';
  $('tPlay').setAttribute('aria-label', $('audio').paused ? 'Play' : 'Pause');
  $('tSeek').max = Math.floor(book.duration);
  if (!scrubbing) $('tSeek').value = Math.floor(t);
  $('tTime').textContent = `${fmtTime(scrubbing ? +$('tSeek').value : t)} / ${fmtTime(book.duration)}`;
}
$('tPlay').onclick = () => { const el = $('audio'); if (el.paused) el.play().catch(() => {}); else el.pause(); };
$('tSeek').oninput = () => { scrubbing = true; syncTransport(); };
$('tSeek').onchange = async () => { await seekTo(+$('tSeek').value); scrubbing = false; syncTransport(); };
$('audio').onplay = $('audio').onpause = syncTransport;

// ---------- what it heard after each pause ----------
function heardItem(h) {
  const li = document.createElement('li');
  li.innerHTML = '<button class="time"></button><span></span>';
  li.children[0].textContent = fmtTime(h.start);
  li.children[0].onclick = () => seekTo(h.start, true);
  li.children[1].textContent = h.text;
  return li;
}
function addHeard(h) {
  $('heardBox').hidden = false;
  $('heardList').appendChild(heardItem(h));
  $('heardSum').textContent = `What it heard after each pause (${book.heard.length})`;
}
function renderHeard() {
  const list = book.heard || [];
  $('heardBox').hidden = !list.length;
  $('heardSum').textContent = `What it heard after each pause (${list.length})`;
  $('heardList').replaceChildren(...list.map(heardItem));
}
$('noneThorough').onclick = () => { $('mode').value = 'thorough'; $('relisten').click(); };
$('nonePauses').onclick = () => { $('mode').value = 'pauses'; $('relisten').click(); };

function currentIndex() {
  const t = getTime();
  let idx = -1;
  book.chapters.forEach((c, i) => { if (c.start <= t + 0.25) idx = i; });
  return idx;
}

function renderChapters(flash = -1) {
  const ol = $('chapters');
  ol.innerHTML = '';
  book.chapters.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = 'ch' + (i === flash ? ' new' : '');
    li.innerHTML = '<span class="num"></span><button class="time"></button><input type="text" aria-label="Chapter title"><button class="del" title="Remove chapter" aria-label="Remove chapter">✕</button>';
    const [num, time, input, del] = li.children;
    num.textContent = i + 1;
    time.textContent = fmtTime(c.start);
    time.onclick = () => seekTo(c.start, true);
    input.value = c.title;
    input.oninput = () => { c.title = input.value; book.source = book.source === 'speech' ? 'speech' : 'manual'; queueSave(); };
    del.onclick = () => { book.chapters.splice(i, 1); persist(); renderChapters(); };
    ol.appendChild(li);
  });
  highlight();
}
function highlight() {
  if (!book) return;
  const idx = currentIndex();
  document.querySelectorAll('li.ch').forEach((li, i) => li.classList.toggle('current', i === idx));
}

$('audio').ontimeupdate = () => { highlight(); syncTransport(); };
$('speed').onchange = (e) => { $('audio').defaultPlaybackRate = $('audio').playbackRate = +e.target.value; };
$('prev').onclick = () => {
  const i = currentIndex();
  const target = i >= 0 && getTime() - book.chapters[i].start > 3 ? i : Math.max(0, i - 1);
  seekTo(book.chapters[target]?.start ?? 0);
};
$('next').onclick = () => { const n = book.chapters[currentIndex() + 1]; if (n) seekTo(n.start); };
$('mark').onclick = () => {
  book.chapters.push({ start: Math.round(getTime() * 100) / 100, title: 'New chapter' });
  book.chapters.sort((a, b) => a.start - b.start);
  persist(); renderChapters();
};
$('relisten').onclick = async () => {
  if (busy || !source) return;
  busy = true;
  try {
    audioHandle ??= await openAudio(source);
    book.chapters = [];
    $('player').hidden = false;
    await run($('mode').value, 0, []);
  } catch (e) { showProgress('Something went wrong.', String(e.message || e), 0); }
  busy = false;
  $('progress').hidden = true; persist(); showPlayer();
};

// ---------- export ----------
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const safeName = () => book.title.replace(/[\\/:*?"<>|]+/g, '_');
$('exMeta').onclick = () => download(new Blob([toFfmetadata(book.chapters, book.duration, book.title)], { type: 'text/plain' }), `${safeName()}.ffmetadata.txt`);
$('exCue').onclick = () => download(new Blob([toCue(book.chapters, book.title, Array.isArray(source) ? `${sourceName}.${audioHandle?.ext?.slice(1) || 'm4b'}` : source.name)], { type: 'text/plain' }), `${safeName()}.cue`);
$('exJson').onclick = () => download(new Blob([JSON.stringify(book.chapters, null, 2)], { type: 'application/json' }), `${safeName()}.chapters.json`);
$('saveNow').onclick = () => $('exAudio').click();
$('exAudio').onclick = async () => {
  if (busy) return;
  busy = true;
  const btn = $('exAudio'), label = btn.textContent, label2 = $('saveNow').textContent;
  btn.disabled = $('saveNow').disabled = true; btn.textContent = $('saveNow').textContent = 'Writing…';
  try {
    audioHandle ??= await openAudio(source);
    const blob = await audioHandle.embed(toFfmetadata(book.chapters, book.duration, book.title));
    book.savedAs = safeName() + audioHandle.ext;
    download(blob, book.savedAs);
    $('saveText').textContent = `Saved “${book.savedAs}” to your Downloads folder. Open that copy in Apple Books, VLC or another `
      + 'audiobook player to see the chapter titles (your original is unchanged).';
    $('saveBox').hidden = false;
  } catch (e) { alert(`Couldn't write the file: ${e.message || e}\nTry the ffmetadata or CUE export instead.`); }
  btn.disabled = $('saveNow').disabled = false; btn.textContent = label; $('saveNow').textContent = label2; busy = false;
};
