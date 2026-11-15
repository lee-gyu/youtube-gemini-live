import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { segmentName, workPaths, writeAtomic } from '../src/workdir.ts';

test('workPaths lays out artifacts under work/{id}', () => {
  const paths = workPaths('dQw4w9WgXcQ');
  assert.equal(paths.dir, path.join('work', 'dQw4w9WgXcQ'));
  assert.equal(paths.context, path.join('work', 'dQw4w9WgXcQ', 'context.md'));
  assert.equal(paths.output, path.join('work', 'dQw4w9WgXcQ', 'ko.m4a'));
});

test('workPaths rejects ids that could escape the work directory', () => {
  assert.throws(() => workPaths('../etc'), /잘못된 content id/);
  assert.throws(() => workPaths(''), /잘못된 content id/);
});

test('segmentName zero-pads the index', () => {
  assert.equal(segmentName(0), '000');
  assert.equal(segmentName(42), '042');
});

test('writeAtomic creates parent directories and leaves no .part file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ygl-'));
  t.after(() => rm(root, { recursive: true }));
  const file = path.join(root, 'nested', 'out.txt');
  await writeAtomic(file, 'hello');
  assert.equal(await readFile(file, 'utf8'), 'hello');
  assert.deepEqual(await readdir(path.dirname(file)), ['out.txt']);
});
