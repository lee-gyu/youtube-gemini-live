import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { exec } from './exec.ts';
import { exists, segmentName, writeAtomic } from './workdir.ts';
import type { WorkPaths } from './workdir.ts';

/** Bytes per second of the source audio: 16kHz, mono, 16-bit. */
export const SOURCE_BYTES_PER_SEC = 16000 * 2;

/**
 * A Live connection lasts about 10 minutes, so a segment plus the wait for its
 * last translated audio has to fit inside that.
 */
export const MAX_SEGMENT_SEC = 480;
/** Earliest point at which a silence is accepted as a cut, to avoid tiny segments. */
export const MIN_SEGMENT_SEC = 300;

export interface Silence {
  start: number;
  end: number;
}

export interface Segment {
  index: number;
  /** Seconds from the start of the source audio. */
  start: number;
  end: number;
}

export interface CutOptions {
  min: number;
  max: number;
}

/**
 * Splits `duration` seconds into segments no longer than `max`, cutting at the
 * latest silence between `min` and `max` seconds into each segment, or at `max`
 * when there is no such silence.
 */
export function planCuts(
  silences: Silence[],
  duration: number,
  opts: CutOptions = { min: MIN_SEGMENT_SEC, max: MAX_SEGMENT_SEC },
): Segment[] {
  const midpoints = silences.map((s) => (s.start + s.end) / 2).sort((a, b) => a - b);
  const segments: Segment[] = [];
  let start = 0;
  while (duration - start > opts.max) {
    const candidates = midpoints.filter((m) => m >= start + opts.min && m <= start + opts.max);
    const cut = candidates.at(-1) ?? start + opts.max;
    segments.push({ index: segments.length, start, end: cut });
    start = cut;
  }
  if (duration > start) segments.push({ index: segments.length, start, end: duration });
  return segments;
}

/** Extracts silence intervals from ffmpeg `silencedetect` log output. */
export function parseSilences(log: string): Silence[] {
  const silences: Silence[] = [];
  let start: number | undefined;
  for (const line of log.split('\n')) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (e && start !== undefined) {
      silences.push({ start, end: Number(e[1]) });
      start = undefined;
    }
  }
  return silences;
}

/** Locates the PCM payload of a WAV file by walking its RIFF chunks. */
export function findWavData(header: Buffer): { offset: number; size: number } {
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('WAV 파일이 아닙니다.');
  }
  let pos = 12;
  while (pos + 8 <= header.length) {
    const id = header.toString('ascii', pos, pos + 4);
    const size = header.readUInt32LE(pos + 4);
    if (id === 'data') return { offset: pos + 8, size };
    pos += 8 + size + (size % 2);
  }
  throw new Error('WAV data 청크를 찾지 못했습니다.');
}

/** Writes `segments/NNN.pcm` and `segments.json`; reuses them when already present. */
export async function splitSegments(paths: WorkPaths): Promise<Segment[]> {
  if (exists(paths.segmentsJson)) {
    return JSON.parse(await readFile(paths.segmentsJson, 'utf8')) as Segment[];
  }

  const { stderr } = await exec('ffmpeg', [
    '-hide_banner', '-nostats',
    '-i', paths.source,
    '-af', 'silencedetect=noise=-35dB:d=0.4',
    '-f', 'null', '-',
  ]);

  const file = await open(paths.source, 'r');
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const data = findWavData(header.subarray(0, bytesRead));
    // Trust the file size over the header: the size field is wrong for streamed or >4GB files.
    const available = (await file.stat()).size - data.offset;
    const pcmBytes = Math.min(data.size, available) || available;
    const duration = pcmBytes / SOURCE_BYTES_PER_SEC;

    const segments = planCuts(parseSilences(stderr), duration);
    await mkdir(paths.segmentsDir, { recursive: true });
    for (const seg of segments) {
      const from = Math.round(seg.start * 16000) * 2;
      const to = Math.min(Math.round(seg.end * 16000) * 2, pcmBytes);
      const buf = Buffer.alloc(to - from);
      await file.read(buf, 0, buf.length, data.offset + from);
      await writeAtomic(path.join(paths.segmentsDir, `${segmentName(seg.index)}.pcm`), buf);
    }
    // Written last: its presence marks the whole step as complete.
    await writeAtomic(paths.segmentsJson, `${JSON.stringify(segments, null, 2)}\n`);
    return segments;
  } finally {
    await file.close();
  }
}
