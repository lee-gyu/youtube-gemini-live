import { readFile } from 'node:fs/promises';
import { GoogleGenAI } from '@google/genai';
import { generateContext } from './context.ts';
import { download, fetchMeta } from './download.ts';
import { createLiveConnect, translateSegment } from './live.ts';
import { merge } from './merge.ts';
import { splitSegments } from './segment.ts';
import { translateSegments } from './translate.ts';
import { finalizeWorkDir, findWorkDir, pathsIn, workPaths } from './workdir.ts';

function parseUrl(arg: string | undefined): string {
  if (!arg) throw new Error('사용법: mise run translate "<youtube URL>"');
  let url: URL;
  try {
    url = new URL(arg);
  } catch {
    throw new Error(`올바른 URL이 아닙니다: ${arg}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`올바른 URL이 아닙니다: ${arg}`);
  }
  return url.href;
}

async function main(): Promise<void> {
  const url = parseUrl(process.argv[2]);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY가 없습니다. .env.example을 참고해 .env 파일에 설정하세요.');
  }
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1beta' } });
  const log = (message: string) => console.log(message);

  log('[1/5] 영상 정보 조회 및 음성 다운로드');
  const meta = await fetchMeta(url);
  // A finished video lives in a renamed directory; reuse it so a re-run resumes there.
  const existing = await findWorkDir(meta.id);
  const paths = existing ? pathsIn(existing) : workPaths(meta.id);
  await download(meta, paths);
  log(`      ${meta.title} (${Math.round(meta.duration)}초) → ${paths.dir}`);

  log('[2/5] context.md 생성');
  await generateContext(ai, meta, paths);

  log('[3/5] 구간 분할');
  const segments = await splitSegments(paths);
  log(`      ${segments.length}개 구간`);

  log('[4/5] 한국어 음성 생성');
  const connect = createLiveConnect(ai, await readFile(paths.context, 'utf8'));
  await translateSegments(segments, paths, {
    translate: (pcm) => translateSegment(pcm, connect),
    log: (message) => log(`      ${message}`),
  });

  log('[5/5] 음성 병합');
  await merge(segments, paths);

  const finalDir = await finalizeWorkDir(paths.dir, meta);
  log(`완료: ${pathsIn(finalDir).output}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
