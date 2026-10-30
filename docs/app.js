import { openAudio } from './js/audio.js';
import { Whisper, listen } from './js/listen.js';
import { fmtTime, toCue, toFfmetadata } from './js/chapters.js';

const $ = (id) => document.getElementById(id);
const SOURCES = {
  speech: 'Found by listening: each one was announced by the narrator. Rename any you like.',
  pauses: 'Guessed from long pauses. Rename them as you listen.',
  embedded: 'These chapters were already in the file.',
  manual: 'Edited by you.',
};

let file = null, objectUrl = null, audioHandle = null, whisper = null;
let book = null;            // { title, duration, chapters, source }
let stopRequested = false, busy = false, saveTimer = null;
let playable = true;        // false when this browser's own player can't open the format (chapters still work)

// Chrome gives some files (.m4b especially) an empty type, which can stop the player opening them.
const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav' };
const mimeFor = (f) => f.type || MIME[(f.name.split('.').pop() || '').toLowerCase()] || '';

const storeKey = (f) => `abr:v1:${f.name}:${f.size}:${f.lastModified}`;
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode / full */ } },
};

if ('gpu' in navigator) $('gpuRow').hidden = false;

// ---------- file intake ----------
$('file').onchange = (e) => e.target.files[0] && load(e.target.files[0]);
const drop = $('drop');
drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } };
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); e.dataTransfer.files[0] && load(e.dataTransfer.files[0]); };
// A file dropped anywhere else would make the browser leave the page and open it; load it here instead.
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); e.dataTransfer?.files[0] && load(e.dataTransfer.files[0]); });

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

async function load(f) {
  if (busy) return;
  busy = true;
  try {
    await release();
    file = f;
    const el = $('audio');
    objectUrl = URL.createObjectURL(new Blob([f], { type: mimeFor(f) }));
    el.src = objectUrl;
    $('stop').hidden = true;
    showProgress('Opening your audiobook…');
    let duration = await playerDuration(el);
    playable = isFinite(duration) && duration > 0;
    if (!playable) {
      // The browser can't play this format, but the audio engine usually can still read it.
      showProgress('Starting the audio engine…', 'One-time 32 MB download, then it is cached.');
      audioHandle = await openAudio(f);
      duration = await audioHandle.duration();
    }
    if (!duration) {
      return showError("Couldn't read that file.", 'It may not be an audiobook, or it may be damaged. Try an MP3, M4A/M4B, FLAC, OGG or WAV file.');
    }
    const stem = f.name.replace(/\.[^.]+$/, '');
    const saved = store.get(storeKey(f));
    if (saved && (saved.chapters?.length || saved.scanned > 0)) {
      book = { ...saved, duration };
      $('progress').hidden = true;
      return showPlayer();
    }
    book = { title: stem, duration, chapters: [], source: null };
    if (!audioHandle) {
      showProgress('Starting the audio engine…', 'One-time 32 MB download, then it is cached.');
      audioHandle = await openAudio(f);
    }
    const info = await audioHandle.probe();
    if (info.tags.title) book.title = info.tags.title;
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
      showProgress('Speech model unavailable.', `${e.message}. Falling back to pauses.`);
      mode = 'pauses';
    }
  }
  let live = true;
  const chapters = await listen({
    audio: audioHandle, duration: book.duration, mode, whisper, from, initial,
    shouldStop: () => stopRequested,
    onScanned: (t, list) => { book.scanned = t; if (mode !== 'pauses') book.chapters = list; persist(); },
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
  else if (!chapters.length) {
    showProgress('No chapter announcements heard.', 'Marking long pauses instead.');
    book.chapters = await listen({ audio: audioHandle, duration: book.duration, mode: 'pauses', shouldStop: () => stopRequested,
      onProgress: ({ done, text }) => showProgress(text, 'Marking pauses…', done), onChapters: () => {} });
    book.source = 'pauses';
  } else book.source = 'speech';
  if (book.chapters.length && book.chapters[0].start > 1) book.chapters.unshift({ start: 0, title: 'Opening' });
  book.scanned = book.duration;
  $('stop').hidden = true;
}

$('stop').onclick = () => { stopRequested = true; $('stop').hidden = true; $('phase').textContent = 'Stopping…'; };

$('resume').onclick = async () => {
  if (busy || !file) return;
  busy = true;
  try {
    audioHandle ??= await openAudio(file);
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
  $('player').hidden = true;
}

// ---------- player + chapter list ----------
function persist() {
  if (file && book) {
    store.set(storeKey(file), { title: book.title, chapters: book.chapters, source: book.source,
      scanned: book.scanned ?? book.duration, mode: book.mode, model: book.model });
  }
}
function queueSave() { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 400); }

function showPlayer(live = false, flash = -1) {
  $('player').hidden = false;
  $('title').textContent = book.title;
  $('audio').hidden = !playable;
  $('controls').hidden = !playable;
  $('source').textContent = !playable ? "Your browser can't play this file type, so there is no player here, but the chapters are found and can be saved below."
    : live ? 'Listening to the book. Chapters appear as they are heard…' : SOURCES[book.source] || '';
  $('relisten').hidden = live;
  const unfinished = !live && book.scanned !== undefined && book.scanned < book.duration - 1;
  $('resumeBox').hidden = !unfinished;
  if (unfinished) {
    $('resumeText').textContent = `Listened to ${fmtTime(book.scanned)} of ${fmtTime(book.duration)} so far. The chapters found up to there are below.`;
    $('resume').textContent = `Continue listening from ${fmtTime(book.scanned)}`;
  }
  renderChapters(flash);
}

function currentIndex() {
  const t = $('audio').currentTime;
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
    time.onclick = () => { $('audio').currentTime = c.start; $('audio').play(); };
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

$('audio').ontimeupdate = highlight;
$('speed').onchange = (e) => { $('audio').playbackRate = +e.target.value; };
$('prev').onclick = () => {
  const i = currentIndex(), a = $('audio');
  const target = i >= 0 && a.currentTime - book.chapters[i].start > 3 ? i : Math.max(0, i - 1);
  a.currentTime = book.chapters[target]?.start ?? 0;
};
$('next').onclick = () => { const n = book.chapters[currentIndex() + 1]; if (n) $('audio').currentTime = n.start; };
$('mark').onclick = () => {
  book.chapters.push({ start: Math.round($('audio').currentTime * 100) / 100, title: 'New chapter' });
  book.chapters.sort((a, b) => a.start - b.start);
  persist(); renderChapters();
};
$('relisten').onclick = async () => {
  if (busy || !file) return;
  busy = true;
  try {
    audioHandle ??= await openAudio(file);
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
$('exCue').onclick = () => download(new Blob([toCue(book.chapters, book.title, file.name)], { type: 'text/plain' }), `${safeName()}.cue`);
$('exJson').onclick = () => download(new Blob([JSON.stringify(book.chapters, null, 2)], { type: 'application/json' }), `${safeName()}.chapters.json`);
$('exAudio').onclick = async () => {
  if (busy) return;
  busy = true;
  const btn = $('exAudio'), label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Writing…';
  try {
    audioHandle ??= await openAudio(file);
    const blob = await audioHandle.embed(toFfmetadata(book.chapters, book.duration, book.title));
    download(blob, safeName() + (/\.[a-z0-9]{1,5}$/i.exec(file.name)?.[0] || ''));
  } catch (e) { alert(`Couldn't write the file: ${e.message || e}\nTry the ffmetadata or CUE export instead.`); }
  btn.disabled = false; btn.textContent = label; busy = false;
};
