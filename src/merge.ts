import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { exec } from './exec.ts';
import type { Segment } from './segment.ts';
import { commit, partPath, segmentName } from './workdir.ts';
import type { WorkPaths } from './workdir.ts';

/**
 * Joins the translated segments in order and encodes them as `ko.m4a`.
 * Always re-encodes: it takes seconds, and skipping would leave a stale file
 * after segments are re-translated.
 */
export async function merge(segments: Segment[], paths: WorkPaths): Promise<void> {
  const files = segments.map((s) => path.join(paths.translatedDir, `${segmentName(s.index)}.pcm`));

  let total = 0;
  for (const file of files) total += (await stat(file)).size;
  if (total === 0) throw new Error('번역된 음성이 없습니다. 영상에 발화가 없는지 확인하세요.');

  async function* pcm() {
    for (const file of files) yield* createReadStream(file);
  }
  await exec(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
      '-c:a', 'aac', '-b:a', '96k',
      '-f', 'ipod', partPath(paths.output),
    ],
    { stdin: Readable.from(pcm()) },
  );
  await commit(paths.output);
}
