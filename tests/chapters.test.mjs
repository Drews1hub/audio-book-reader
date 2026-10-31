// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookTags, insertChapter, toCue, findAnnouncements, findSilences, squeezeSilences, unsqueeze, toFfmetadata, parseFfmetadata, fmtNum } from '../docs/js/chapters.js';

function words(text, pauses = []) {
  const out = [];
  let t = 0;
  text.split(' ').forEach((w, i) => { out.push({ word: w, start: t, end: t + 0.3 }); t += 0.3 + (pauses.includes(i) ? 1 : 0); });
  return out;
}
const first = (text) => findAnnouncements(words(text))[0]?.title;

test('headings are numbered and titled', () => {
  assert.equal(first('Chapter twelve. The Long Road Home. It was a dark night'), 'Chapter 12: The Long Road Home');
  assert.equal(first('Chapter 3'), 'Chapter 3');
  assert.equal(first('Chapter twenty-one: Fire'), 'Chapter 21: Fire');
  assert.equal(first('Chapter twenty one Fire'), 'Chapter 21: Fire');
  assert.equal(first('Prologue'), 'Prologue');
  assert.equal(first('Chapter IV. Rain'), 'Chapter IV: Rain');
});

test('non-headings are ignored', () => {
  assert.equal(first('He walked into the chapter house'), undefined);
  assert.equal(first('Part of the problem was money.'), undefined);
  assert.equal(first('Chapter civil war was long'), undefined);
  assert.deepEqual(findAnnouncements(words('she read the next chapter seven times')), []);
  assert.deepEqual(findAnnouncements(words('He said chapter two was boring')), []);
});

test('heading in the middle of continuous narration, title ends at a pause', () => {
  const w = words('and then she left the house for good. Chapter seven The Long Road Home It was cold', [13]);
  assert.deepEqual(findAnnouncements(w), [{ start: Math.round((w[8].start - 0.3) * 100) / 100, title: 'Chapter 7: The Long Road Home' }]);
});

test('a bare standalone heading takes no title from the story', () => {
  assert.equal(first('Epilogue. Years passed and the village forgot'), 'Epilogue');
});

test('silences', () => {
  const rate = 16000;
  const a = new Float32Array(rate * 10).fill(0.3);
  a.fill(0, rate * 4, rate * 6.5);
  const s = findSilences(a, rate, { minSilence: 1 });
  assert.equal(s.length, 1);
  assert.ok(Math.abs(s[0].start - 4) < 0.1 && Math.abs(s[0].end - 6.5) < 0.1);
});

test('ffmetadata round trip', () => {
  const chs = [{ start: 0, title: 'One; a=b' }, { start: 6.5, title: 'Two' }];
  const back = parseFfmetadata(toFfmetadata(chs, 20, 'My=Book'));
  assert.deepEqual(back.chapters, chs);
  assert.equal(back.tags.title, 'My=Book');
  assert.equal(fmtNum('ninety'), '90');
});

test('long silences are shortened and times map back', () => {
  const rate = 16000;
  const a = new Float32Array(rate * 20).fill(0.3);
  a.fill(0, rate * 5, rate * 9);            // 4 s of silence
  const { samples, pieces } = squeezeSilences(a, rate);
  assert.ok(Math.abs(samples.length / rate - 16.8) < 0.1);   // 20 s - (4 s - 0.8 s)
  assert.ok(Math.abs(unsqueeze(2, pieces) - 2) < 1e-6);       // before the cut: unchanged
  assert.ok(Math.abs(unsqueeze(5.4, pieces) - 8.6) < 0.1);    // just inside the kept tail of the silence
  assert.ok(Math.abs(unsqueeze(10, pieces) - 13.2) < 0.1);    // after the cut: shifted by 3.2 s
  assert.equal(squeezeSilences(new Float32Array(rate).fill(0.3), rate).samples.length, rate);
});

test('pauses measured from the audio end a title even when word times are contiguous', () => {
  // Whisper-style contiguous times: "Door" ends exactly where "Morning" starts, but the audio has a 3.4 s silence there.
  const w = [['Chapter', 0, .5], ['2', .5, .9], ['A', .9, 1.2], ['Stranger', 1.2, 1.7], ['Door', 1.7, 2.1], ['Morning', 2.1, 5.5], ['came', 5.5, 5.9]]
    .map(([word, start, end]) => ({ word, start, end }));
  // without audio pauses the title runs on into the next sentence (ten words max)
  assert.equal(findAnnouncements(w, { silences: [{ start: 2.2, end: 5.4 }] })[0].title, 'Chapter 2: A Stranger Door');
});

test('a number said on its own after a long pause is a chapter heading', () => {
  // "...end of the last chapter. [2 s pause] Twelve. [0.8 s] The Long Road Home. [1 s] It was cold"
  const w = words('end of the chapter. Twelve. The Long Road Home. It was cold', [3, 4, 8]);
  w.forEach((x, i) => { if (i >= 4) { x.start += 1; x.end += 1; } });   // the pause before "Twelve." is 2 s
  assert.deepEqual(findAnnouncements(w).map((a) => a.title), [], 'off by default');
  assert.deepEqual(findAnnouncements(w, { bareNumbers: true }).map((a) => a.title), ['Chapter 12: The Long Road Home']);
  // at the very start of a clip that begins right after a pause (Quick mode)
  assert.equal(findAnnouncements(words('Twenty one. Fire and Ice. Snow fell', [1, 4]), { startsAfterPause: true, bareNumbers: true })[0].title, 'Chapter 21: Fire and Ice');
});

test('ordinary numbers in the story are not headings', () => {
  const on = { bareNumbers: true };
  assert.deepEqual(findAnnouncements(words('One day she left. Two men followed her', [3]), on), []);       // no long pause
  assert.deepEqual(findAnnouncements(words('He counted. Three. Four. Five.', [1]), on), []);                 // 1 s pause < 1.2 s
  assert.deepEqual(findAnnouncements(words('One day she left', []), { startsAfterPause: true, ...on }), []); // "One day…" is not alone
  assert.deepEqual(findAnnouncements(words('I walked home', []), { startsAfterPause: true, ...on }), []);    // Roman "I" never bare
});

test('title and author become the tags that stop "Unknown Artist / Unknown Album"', () => {
  assert.deepEqual(bookTags({ title: 'Cloak of The Light', author: 'Chuck Black' }, '.m4b'), [
    ['title', 'Cloak of The Light'], ['album', 'Cloak of The Light'],
    ['artist', 'Chuck Black'], ['album_artist', 'Chuck Black'], ['genre', 'Audiobook'], ['media_type', '2']]);
  assert.ok(!bookTags({ title: 'T', author: 'A' }, '.mp3').some(([k]) => k === 'media_type'), 'iTunes flag only for MP4 files');
  assert.deepEqual(bookTags({ title: '', author: '  ' }, '.m4b').map(([k]) => k), ['media_type']);   // nothing typed: nothing overwritten
  const back = parseFfmetadata(toFfmetadata([{ start: 0, title: 'One' }], 10, { title: 'My Book', author: 'A. Writer' }));
  assert.equal(back.tags.title, 'My Book');
  assert.equal(back.tags.artist, 'A. Writer');
  assert.equal(back.tags.album, 'My Book');
  assert.equal(parseFfmetadata(toFfmetadata([], 10, 'Plain title')).tags.title, 'Plain title');   // old call style still works
  assert.match(toCue([{ start: 0, title: 'One' }], 'My Book', 'x.m4b', 'A. Writer'), /PERFORMER "A\. Writer"/);
});

test('by default only "Chapter N" counts: a number alone after a pause in the story is not a chapter', () => {
  // "...the door. [2 s] Three. [0.5 s] Three men stood outside."  /  "Twelve. It was twelve o'clock."
  const story = words('he knocked. Three. Three men stood outside. Twelve. It was twelve o clock', [2, 3, 6, 7, 8]);
  story.forEach((w, i) => { if (i === 3 || i === 7) { w.start += 1.2; w.end += 1.2; } });
  assert.deepEqual(findAnnouncements(story), []);
  assert.deepEqual(findAnnouncements(story, { startsAfterPause: true }), []);
  // while real headings are still found
  assert.equal(findAnnouncements(words('Chapter three. The Door. He knocked'), { startsAfterPause: true })[0].title, 'Chapter 3: The Door');
  assert.equal(findAnnouncements(words('and then it ended. Part two. The Return. Years passed'))[0].title, 'Part 2: The Return');
});

test('insertChapter: the same heading heard again is kept once (the fuller title), and the list stays in time order', () => {
  const list = [];
  insertChapter(list, { start: 2, title: 'Chapter 1: The door' });
  insertChapter(list, { start: 30, title: 'Chapter 3' });
  // an overlapping clip hears both again, one with a longer title, in an order that used to make duplicates
  assert.equal(insertChapter(list, { start: 2.4, title: 'Chapter 1' }), false);                 // shorter: ignore
  assert.equal(insertChapter(list, { start: 30.2, title: 'Chapter 3: Three men' }), true);      // fuller: replace
  assert.deepEqual(list, [{ start: 2, title: 'Chapter 1: The door' }, { start: 30.2, title: 'Chapter 3: Three men' }]);
  insertChapter(list, { start: 15, title: 'Chapter 2' });                                        // found late: slotted into place
  assert.deepEqual(list.map((c) => c.start), [2, 15, 30.2]);
  assert.ok(list.every((c) => Object.keys(c).sort().join() === 'start,title'));
});

// ---- where a chapter starts: the first sound after the pause before it ----
const W = (word, start, end) => ({ word, start, end });
test('marker: at the start of the entry music, not at the speech model\'s early guess', () => {
  // The previous chapter ends at 0.5 s. A 2.5 s pause (0.55-3.05), then music, then the narrator says the heading,
  // but the speech model stamps "Chapter" right at the end of the previous word, as it does after a pause.
  const words = [W('ending.', 0, 0.5), W('Chapter', 0.5, 0.9), W('twelve.', 0.9, 1.4), W('The', 1.4, 1.6), W('Storm.', 1.6, 2.0)];
  const heading = findAnnouncements(words, { silences: [{ start: 0.55, end: 3.05 }] })[0];
  assert.equal(heading.title, 'Chapter 12: The Storm');
  assert.equal(heading.start, 2.75);                       // 0.3 s before the music starts (3.05), inside the quiet pause
});

test('marker: a word the model stamped inside the pause still starts at the end of the pause', () => {
  const words = [W('ending.', 0, 0.5), W('Chapter', 1.2, 1.6), W('twelve.', 1.6, 2.0)];
  assert.equal(findAnnouncements(words, { silences: [{ start: 0.55, end: 3.05 }] })[0].start, 2.75);
});

test('marker: with no music, the pause ends where the words begin', () => {
  const words = [W('ending.', 0, 0.5), W('Chapter', 2.0, 2.4), W('twelve.', 2.4, 2.9)];
  assert.equal(findAnnouncements(words, { silences: [{ start: 0.55, end: 2.0 }] })[0].start, 1.7);    // 0.3 s before the words, inside the pause
});

test('marker: a pause inside the heading, or inside the earlier chapter, is not used', () => {
  // earlier chapter: "text [pause 0.5-2.0] more words." then the chapter gap (3.05-5.0) then the heading
  const words = [W('text', 0, 0.4), W('more', 2.0, 2.4), W('words.', 2.4, 3.0), W('Chapter', 3.0, 3.4), W('twelve.', 3.4, 3.8),
    W('The', 4.9, 5.1), W('Storm.', 5.1, 5.6)];
  const inside = { start: 3.9, end: 4.8 };                       // between "twelve." and the title
  const h = findAnnouncements(words, { silences: [{ start: 0.5, end: 2.0 }, { start: 3.05, end: 5.0 }, inside] })[0];
  assert.equal(h.start, 4.7);                                     // the gap before the chapter (ends 5.0), not the earlier pause (1.7) or the one inside the heading
});

test('marker: a Quick-mode clip starts inside the pause before the chapter, so the chapter starts with the clip', () => {
  // music for the first 6 s of the clip, no words; the narrator starts at 106 s
  assert.equal(findAnnouncements([W('Chapter', 106.0, 106.4), W('twelve.', 106.4, 106.9)], { startsAfterPause: true, clipStart: 100 })[0].start, 100);
  // without that guarantee (Thorough mode, mid-book) it falls back to the old rule
  assert.equal(findAnnouncements([W('Chapter', 106.0, 106.4), W('twelve.', 106.4, 106.9)], {})[0].start, 105.7);
});
