import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
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

export const WORK_ROOT = 'work';
const MAX_TITLE_CHARS = 80;

/** Artifact locations for one video under `work/{id}/`. */
export function workPaths(id: string, root = WORK_ROOT): WorkPaths {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`잘못된 content id: ${id}`);
  return pathsIn(path.join(root, id));
}

/** Artifact locations inside an existing work directory, whatever it is named. */
export function pathsIn(dir: string): WorkPaths {
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

/**
 * Finds the work directory of a video that was already (partly) processed:
 * `work/{id}` while in progress, or a renamed directory whose `meta.json` has that id.
 */
export async function findWorkDir(id: string, root = WORK_ROOT): Promise<string | undefined> {
  const inProgress = workPaths(id, root).dir;
  if (existsSync(inProgress)) return inProgress;
  if (!existsSync(root)) return undefined;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const meta = JSON.parse(await readFile(pathsIn(dir).meta, 'utf8')) as { id?: unknown };
      if (meta.id === id) return dir;
    } catch {
      // Not a work directory, or its meta.json is unreadable: keep looking.
    }
  }
  return undefined;
}

/** Makes a video title safe to use as a directory name. */
export function sanitizeTitle(title: string): string {
  const cleaned = title
    .normalize('NFC')
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  // Cut by code point so a multi-byte character is never split.
  return Array.from(cleaned).slice(0, MAX_TITLE_CHARS).join('').replace(/[. ]+$/, '').trim();
}

/** `YYMMDD_{title}` for the given (local) date; falls back to the id for an empty title. */
export function finalDirName(title: string, id: string, date: Date): string {
  const two = (n: number) => String(n % 100).padStart(2, '0');
  const stamp = `${two(date.getFullYear())}${two(date.getMonth() + 1)}${two(date.getDate())}`;
  return `${stamp}_${sanitizeTitle(title) || id}`;
}

/**
 * Renames a finished `work/{id}` directory to `work/YYMMDD_{title}` and returns the new path.
 * A directory that was already renamed by an earlier run keeps its name.
 */
export async function finalizeWorkDir(
  dir: string,
  meta: { id: string; title: string },
  date = new Date(),
): Promise<string> {
  if (path.basename(dir) !== meta.id) return dir;
  const root = path.dirname(dir);
  const name = finalDirName(meta.title, meta.id, date);
  // Another video with the same title on the same day: keep both apart by id.
  const target = path.join(root, existsSync(path.join(root, name)) ? `${name}_${meta.id}` : name);
  await rename(dir, target);
  return target;
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
