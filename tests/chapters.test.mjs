// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { findAnnouncements, findSilences, squeezeSilences, unsqueeze, toFfmetadata, parseFfmetadata, fmtNum } from '../docs/js/chapters.js';

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
