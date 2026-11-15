import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { realClock } from './live.ts';
import type { Clock, SegmentResult } from './live.ts';
import type { Segment } from './segment.ts';
import { exists, segmentName, writeAtomic } from './workdir.ts';
import type { WorkPaths } from './workdir.ts';

export const MAX_ATTEMPTS = 3;
/** Sessions created right after another one start slowly, so space them out. */
export const MIN_SESSION_GAP_MS = 12_000;

export interface TranslateDeps {
  /** Translates one segment's PCM in a fresh Live session. */
  translate(pcm: Buffer): Promise<SegmentResult>;
  clock?: Clock;
  log?(message: string): void;
}

/**
 * Translates segments in order into `translated/NNN.pcm` (+ `NNN.txt`).
 * Finished segments are skipped, so a re-run resumes where the last one stopped.
 */
export async function translateSegments(
  segments: Segment[],
  paths: WorkPaths,
  deps: TranslateDeps,
): Promise<void> {
  const clock = deps.clock ?? realClock;
  const log = deps.log ?? (() => {});
  let lastSessionAt: number | undefined;

  for (const seg of segments) {
    const name = segmentName(seg.index);
    const label = `구간 ${seg.index + 1}/${segments.length}`;
    const outPcm = path.join(paths.translatedDir, `${name}.pcm`);
    if (exists(outPcm)) {
      log(`${label}: 이미 완료됨, 건너뜀`);
      continue;
    }
    const pcm = await readFile(path.join(paths.segmentsDir, `${name}.pcm`));

    for (let attempt = 1; ; attempt++) {
      if (lastSessionAt !== undefined) {
        const wait = lastSessionAt + MIN_SESSION_GAP_MS - clock.now();
        if (wait > 0) await clock.sleep(wait);
      }
      lastSessionAt = clock.now();
      log(`${label}: 번역 중 (${Math.round(seg.end - seg.start)}초, 시도 ${attempt}/${MAX_ATTEMPTS})`);
      try {
        const result = await deps.translate(pcm);
        await writeAtomic(path.join(paths.translatedDir, `${name}.txt`), `${result.transcript.trim()}\n`);
        // Written last: the .pcm file marks the segment as complete.
        await writeAtomic(outPcm, result.audio);
        break;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log(`${label}: 실패 - ${reason}`);
        if (attempt >= MAX_ATTEMPTS) {
          throw new Error(
            `${label} 번역이 ${MAX_ATTEMPTS}회 실패했습니다: ${reason}\n같은 명령을 다시 실행하면 이 구간부터 이어집니다.`,
          );
        }
      }
    }
  }
}
