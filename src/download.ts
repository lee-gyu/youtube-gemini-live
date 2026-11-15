import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { exec } from './exec.ts';
import { commit, exists, partPath, writeAtomic } from './workdir.ts';
import type { WorkPaths } from './workdir.ts';

export interface Meta {
  id: string;
  url: string;
  title: string;
  channel: string;
  description: string;
  /** Seconds. */
  duration: number;
}

/** Looks up the video's id and descriptive metadata without downloading media. */
export async function fetchMeta(url: string): Promise<Meta> {
  const { stdout } = await exec('yt-dlp', [
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--',
    url,
  ]);
  const info = JSON.parse(stdout) as Record<string, unknown>;
  if (typeof info.id !== 'string') throw new Error('yt-dlp 결과에서 content id를 찾지 못했습니다.');
  return {
    id: info.id,
    url,
    title: typeof info.title === 'string' ? info.title : '',
    channel: typeof info.channel === 'string' ? info.channel : '',
    description: typeof info.description === 'string' ? info.description : '',
    duration: typeof info.duration === 'number' ? info.duration : 0,
  };
}

/** Writes `meta.json` and `source.wav` (16kHz mono 16-bit PCM, the Live API input format). */
export async function download(meta: Meta, paths: WorkPaths): Promise<void> {
  await mkdir(paths.dir, { recursive: true });
  if (!exists(paths.meta)) await writeAtomic(paths.meta, `${JSON.stringify(meta, null, 2)}\n`);
  if (exists(paths.source)) return;

  await exec('yt-dlp', [
    '-f',
    'bestaudio/best',
    '--no-playlist',
    '--no-warnings',
    '-o',
    path.join(paths.dir, 'download.%(ext)s'),
    '--',
    meta.url,
  ]);
  const raw = (await readdir(paths.dir)).find((f) => f.startsWith('download.'));
  if (!raw) throw new Error('yt-dlp가 음성 파일을 만들지 않았습니다.');
  const rawPath = path.join(paths.dir, raw);

  await exec('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', rawPath,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    '-f', 'wav', partPath(paths.source),
  ]);
  await commit(paths.source);
  await rm(rawPath);
}
