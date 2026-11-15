import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  finalDirName,
  finalizeWorkDir,
  findWorkDir,
  pathsIn,
  sanitizeTitle,
  segmentName,
  workPaths,
  writeAtomic,
} from '../src/workdir.ts';

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

test('sanitizeTitle removes path-unsafe characters and tidies whitespace', () => {
  assert.equal(sanitizeTitle('All Code Is Slop (Except Mine) — Lauren Tan'), 'All Code Is Slop (Except Mine) — Lauren Tan');
  assert.equal(sanitizeTitle('  A/B: "what?" <x>|y\\z*\n\tend  '), 'A B what x y z end');
  assert.equal(sanitizeTitle('...hidden.. '), 'hidden');
  assert.equal(sanitizeTitle('한글 제목 / 2부'), '한글 제목 2부');
  assert.equal(sanitizeTitle('/:*?'), '');
});

test('sanitizeTitle limits length without splitting characters', () => {
  const long = sanitizeTitle(`${'가'.repeat(79)}😀😀`);
  assert.equal(Array.from(long).length, 80);
  assert.ok(long.endsWith('😀'));
});

test('finalDirName is YYMMDD_title in local time, with the id as fallback', () => {
  const date = new Date(2026, 10, 5); // 2026-11-05 local
  assert.equal(finalDirName('Me at the zoo', 'abc', date), '261105_Me at the zoo');
  assert.equal(finalDirName('???', 'abc', date), '261105_abc');
});

test('finalizeWorkDir renames work/{id} and findWorkDir still locates it by id', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ygl-'));
  t.after(() => rm(root, { recursive: true }));
  const meta = { id: 'abc123', title: 'Talk: Part 1' };
  const paths = workPaths(meta.id, root);
  await writeAtomic(paths.meta, JSON.stringify(meta));
  await writeAtomic(paths.output, 'audio');
  assert.equal(await findWorkDir(meta.id, root), paths.dir);

  const date = new Date(2026, 10, 15);
  const finalDir = await finalizeWorkDir(paths.dir, meta, date);

  assert.equal(finalDir, path.join(root, '261115_Talk Part 1'));
  assert.deepEqual(await readdir(root), ['261115_Talk Part 1']);
  assert.equal(await readFile(pathsIn(finalDir).output, 'utf8'), 'audio');
  assert.equal(await findWorkDir(meta.id, root), finalDir);
  assert.equal(await findWorkDir('other', root), undefined);

  // A re-run inside the renamed directory keeps its name, even on a later day.
  assert.equal(await finalizeWorkDir(finalDir, meta, new Date(2026, 11, 1)), finalDir);
});

test('finalizeWorkDir appends the id when another video already has that name', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ygl-'));
  t.after(() => rm(root, { recursive: true }));
  const date = new Date(2026, 10, 15);
  const first = { id: 'aaa', title: 'Same title' };
  const second = { id: 'bbb', title: 'Same title' };
  for (const meta of [first, second]) await writeAtomic(workPaths(meta.id, root).meta, JSON.stringify(meta));

  await finalizeWorkDir(workPaths(first.id, root).dir, first, date);
  const finalDir = await finalizeWorkDir(workPaths(second.id, root).dir, second, date);

  assert.equal(finalDir, path.join(root, '261115_Same title_bbb'));
  assert.equal(await findWorkDir('aaa', root), path.join(root, '261115_Same title'));
  assert.equal(await findWorkDir('bbb', root), finalDir);
});

test('findWorkDir ignores a missing root and unrelated directories', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ygl-'));
  t.after(() => rm(root, { recursive: true }));
  assert.equal(await findWorkDir('abc', path.join(root, 'nope')), undefined);
  await writeAtomic(path.join(root, 'notes', 'meta.json'), 'not json');
  await writeAtomic(path.join(root, 'stray.txt'), 'x');
  assert.equal(await findWorkDir('abc', root), undefined);
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
