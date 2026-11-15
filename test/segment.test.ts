import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findWavData, parseSilences, planCuts } from '../src/segment.ts';

const opts = { min: 300, max: 480 };

test('planCuts keeps a short video as one segment', () => {
  assert.deepEqual(planCuts([], 120, opts), [{ index: 0, start: 0, end: 120 }]);
  assert.deepEqual(planCuts([], 480, opts), [{ index: 0, start: 0, end: 480 }]);
});

test('planCuts returns nothing for empty audio', () => {
  assert.deepEqual(planCuts([], 0, opts), []);
});

test('planCuts hard-cuts at max when there is no silence', () => {
  assert.deepEqual(planCuts([], 1000, opts), [
    { index: 0, start: 0, end: 480 },
    { index: 1, start: 480, end: 960 },
    { index: 2, start: 960, end: 1000 },
  ]);
});

test('planCuts cuts at the latest silence midpoint inside the window', () => {
  const silences = [
    { start: 100, end: 102 }, // before min: ignored
    { start: 309, end: 311 }, // midpoint 310
    { start: 449, end: 451 }, // midpoint 450: latest inside [300, 480]
    { start: 499, end: 501 }, // beyond max
  ];
  assert.deepEqual(planCuts(silences, 700, opts), [
    { index: 0, start: 0, end: 450 },
    { index: 1, start: 450, end: 700 },
  ]);
});

test('planCuts measures each window from the previous cut', () => {
  const silences = [
    { start: 399, end: 401 }, // cut 1 at 400
    { start: 799, end: 801 }, // 400 into segment 2: inside its window
  ];
  assert.deepEqual(planCuts(silences, 1300, opts), [
    { index: 0, start: 0, end: 400 },
    { index: 1, start: 400, end: 800 },
    { index: 2, start: 800, end: 1280 },
    { index: 3, start: 1280, end: 1300 },
  ]);
});

test('planCuts never produces a segment longer than max', () => {
  const silences = Array.from({ length: 40 }, (_, i) => ({ start: i * 97, end: i * 97 + 1 }));
  for (const seg of planCuts(silences, 3600, opts)) {
    assert.ok(seg.end - seg.start <= opts.max);
    assert.ok(seg.end > seg.start);
  }
});

test('parseSilences reads silencedetect output and drops an unterminated silence', () => {
  const log = [
    '[silencedetect @ 0x600000] silence_start: 12.5',
    '[silencedetect @ 0x600000] silence_end: 14.25 | silence_duration: 1.75',
    'size=N/A time=00:01:00.00 bitrate=N/A',
    '[silencedetect @ 0x600000] silence_start: -0.01',
    '[silencedetect @ 0x600000] silence_end: 0.9 | silence_duration: 0.91',
    '[silencedetect @ 0x600000] silence_start: 58.0',
  ].join('\n');
  assert.deepEqual(parseSilences(log), [
    { start: 12.5, end: 14.25 },
    { start: 0, end: 0.9 },
  ]);
});

test('findWavData skips chunks before the data chunk', () => {
  const chunk = (id: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'ascii');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body, Buffer.alloc(body.length % 2)]);
  };
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.write('WAVE', 8, 'ascii');
  const wav = Buffer.concat([
    riff,
    chunk('fmt ', Buffer.alloc(16)),
    chunk('LIST', Buffer.alloc(25)), // odd size: followed by a pad byte
    chunk('data', Buffer.alloc(64)),
  ]);
  assert.deepEqual(findWavData(wav), { offset: 12 + 24 + 34 + 8, size: 64 });
  assert.throws(() => findWavData(Buffer.from('not a wav file at all')), /WAV/);
});
