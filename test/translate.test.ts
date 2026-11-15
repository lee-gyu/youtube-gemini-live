import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Clock, SegmentResult } from '../src/live.ts';
import type { Segment } from '../src/segment.ts';
import { MIN_SESSION_GAP_MS, translateSegments } from '../src/translate.ts';
import { workPaths } from '../src/workdir.ts';

class FakeClock implements Clock {
  t = 0;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

const result = (text: string): SegmentResult => ({
  audio: Buffer.from(text),
  transcript: ` ${text} `,
  inputTranscript: 'source',
});

async function setup(count: number) {
  const root = await mkdtemp(path.join(tmpdir(), 'ygl-'));
  const paths = workPaths('abc', root);
  await mkdir(paths.segmentsDir, { recursive: true });
  const segments: Segment[] = [];
  for (let i = 0; i < count; i++) {
    segments.push({ index: i, start: i * 10, end: (i + 1) * 10 });
    await writeFile(path.join(paths.segmentsDir, `00${i}.pcm`), `in${i}`);
  }
  return { root, paths, segments };
}

test('translates every segment in order and writes audio and transcript', async (t) => {
  const { root, paths, segments } = await setup(2);
  t.after(() => rm(root, { recursive: true }));
  const seen: string[] = [];

  await translateSegments(segments, paths, {
    clock: new FakeClock(),
    translate: async (pcm) => {
      seen.push(pcm.toString());
      return result(`out-${pcm}`);
    },
  });

  assert.deepEqual(seen, ['in0', 'in1']);
  assert.equal(await readFile(path.join(paths.translatedDir, '000.pcm'), 'utf8'), 'out-in0');
  assert.equal(await readFile(path.join(paths.translatedDir, '001.txt'), 'utf8'), 'out-in1\n');
  assert.deepEqual((await readdir(paths.translatedDir)).sort(), ['000.pcm', '000.txt', '001.pcm', '001.txt']);
});

test('skips segments that are already translated', async (t) => {
  const { root, paths, segments } = await setup(3);
  t.after(() => rm(root, { recursive: true }));
  await mkdir(paths.translatedDir, { recursive: true });
  await writeFile(path.join(paths.translatedDir, '000.pcm'), 'kept');
  await writeFile(path.join(paths.translatedDir, '001.pcm'), 'kept');
  const seen: string[] = [];

  await translateSegments(segments, paths, {
    clock: new FakeClock(),
    translate: async (pcm) => {
      seen.push(pcm.toString());
      return result('new');
    },
  });

  assert.deepEqual(seen, ['in2']);
  assert.equal(await readFile(path.join(paths.translatedDir, '000.pcm'), 'utf8'), 'kept');
});

test('retries a failed segment and spaces sessions apart', async (t) => {
  const { root, paths, segments } = await setup(2);
  t.after(() => rm(root, { recursive: true }));
  const clock = new FakeClock();
  const startedAt: number[] = [];
  let calls = 0;

  await translateSegments(segments, paths, {
    clock,
    translate: async () => {
      startedAt.push(clock.now());
      clock.t += 1000; // each session lasts 1s
      if (++calls === 1) throw new Error('closed early');
      return result('ok');
    },
  });

  assert.equal(calls, 3); // segment 0 twice, segment 1 once
  assert.deepEqual(startedAt, [0, MIN_SESSION_GAP_MS, MIN_SESSION_GAP_MS * 2]);
  assert.ok(existsSync(path.join(paths.translatedDir, '001.pcm')));
});

test('does not wait when the previous session already took longer than the gap', async (t) => {
  const { root, paths, segments } = await setup(2);
  t.after(() => rm(root, { recursive: true }));
  const clock = new FakeClock();
  const startedAt: number[] = [];

  await translateSegments(segments, paths, {
    clock,
    translate: async () => {
      startedAt.push(clock.now());
      clock.t += 60_000;
      return result('ok');
    },
  });

  assert.deepEqual(startedAt, [0, 60_000]);
});

test('gives up after three failures and leaves the segment unfinished', async (t) => {
  const { root, paths, segments } = await setup(2);
  t.after(() => rm(root, { recursive: true }));
  let calls = 0;

  await assert.rejects(
    translateSegments(segments, paths, {
      clock: new FakeClock(),
      translate: async () => {
        calls++;
        throw new Error('no audio');
      },
    }),
    /구간 1\/2 번역이 3회 실패.*no audio/s,
  );

  assert.equal(calls, 3);
  assert.equal(existsSync(path.join(paths.translatedDir, '000.pcm')), false);
});
