import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface WorkPaths {
  dir: string;
  meta: string;
  source: string;
  context: string;
  segmentsJson: string;
  segmentsDir: string;
  translatedDir: string;
  output: string;
}

/** Artifact locations for one video under `work/{id}/`. */
export function workPaths(id: string, root = 'work'): WorkPaths {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`잘못된 content id: ${id}`);
  const dir = path.join(root, id);
  return {
    dir,
    meta: path.join(dir, 'meta.json'),
    source: path.join(dir, 'source.wav'),
    context: path.join(dir, 'context.md'),
    segmentsJson: path.join(dir, 'segments.json'),
    segmentsDir: path.join(dir, 'segments'),
    translatedDir: path.join(dir, 'translated'),
    output: path.join(dir, 'ko.m4a'),
  };
}

/** `0` → `"000"`: file stem shared by `segments/` and `translated/`. */
export function segmentName(index: number): string {
  return String(index).padStart(3, '0');
}

export function exists(file: string): boolean {
  return existsSync(file);
}

/** Temp name a step writes to before `commit` makes the artifact visible. */
export function partPath(file: string): string {
  return `${file}.part`;
}

/** Renames the `.part` file into place, so an interrupted step never leaves a "finished" artifact. */
export async function commit(file: string): Promise<void> {
  await rename(partPath(file), file);
}

export async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(partPath(file), data);
  await commit(file);
}
