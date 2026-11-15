import { rm } from 'node:fs/promises';
import path from 'node:path';
import { createPartFromUri, createUserContent } from '@google/genai';
import type { GoogleGenAI } from '@google/genai';
import type { Meta } from './download.ts';
import { exec } from './exec.ts';
import { realClock } from './live.ts';
import { exists, writeAtomic } from './workdir.ts';
import type { WorkPaths } from './workdir.ts';

export const DEFAULT_CONTEXT_MODEL = 'gemini-4-hydrogen';
const MAX_DESCRIPTION_CHARS = 2000;

/** Prompt asking the analysis model for translation guidance in the context.md layout. */
export function buildContextPrompt(meta: Meta): string {
  const description = meta.description.slice(0, MAX_DESCRIPTION_CHARS).trim() || '(없음)';
  return `당신은 실시간 통역 모델에 전달할 번역 지침을 작성하는 분석가입니다.
첨부된 음성과 아래 영상 정보를 분석해, 이 음성을 한국어로 통역할 때 참고할 지침 문서를 한국어 Markdown으로 작성하세요.

[영상 정보]
- 제목: ${meta.title || '(없음)'}
- 채널: ${meta.channel || '(없음)'}
- 길이: ${Math.round(meta.duration)}초
- 설명:
${description}

[작성 규칙]
- 아래 형식을 그대로 따르고, 형식 밖의 인사말·해설·코드 블록 표시는 쓰지 않습니다.
- 전체 3,000자 이내로 쓰고, 용어집은 실제 음성에 등장하는 용어만 50개 이내로 적습니다.
- 통역 방법에 대한 지침만 적습니다. 내용 요약, 대본, 출력 형식 지시는 넣지 않습니다.
- 해당 사항이 없는 항목은 "없음"이라고 적습니다.

[형식]
# 통역 지침

이 음성을 한국어로 통역할 때 아래 내용을 따른다.

## 영상 개요
(주제, 원어, 분야를 2~3문장으로)

## 화자와 말투
(화자별 역할과 한국어 말투: 존댓말/반말, 격식 수준)

## 용어집
- 원어 → 한국어 표기

## 번역하지 않을 고유명사
- 원어 그대로 말할 인명·제품명·서비스명
`;
}

/** Removes a Markdown code fence the model may wrap its whole answer in. */
export function stripFence(text: string): string {
  const match = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text.trim());
  return (match?.[1] ?? text).trim();
}

/** Analyses the source audio and metadata and writes `context.md`; keeps an existing one. */
export async function generateContext(ai: GoogleGenAI, meta: Meta, paths: WorkPaths): Promise<void> {
  if (exists(paths.context)) return;
  const model = process.env.GEMINI_CONTEXT_MODEL || DEFAULT_CONTEXT_MODEL;

  // A compact copy is enough for analysis and keeps the upload small.
  const analysis = path.join(paths.dir, 'analysis.aac');
  await exec('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', paths.source,
    '-c:a', 'aac', '-b:a', '32k',
    '-f', 'adts', analysis,
  ]);

  let uploadedName: string | undefined;
  try {
    let file = await ai.files.upload({ file: analysis, config: { mimeType: 'audio/aac' } });
    uploadedName = file.name;
    while (file.state === 'PROCESSING') {
      await realClock.sleep(2000);
      file = await ai.files.get({ name: file.name! });
    }
    if (file.state === 'FAILED' || !file.uri) {
      throw new Error('업로드한 음성을 Gemini가 처리하지 못했습니다.');
    }

    const response = await ai.models.generateContent({
      model,
      contents: createUserContent([
        createPartFromUri(file.uri, file.mimeType ?? 'audio/aac'),
        buildContextPrompt(meta),
      ]),
    });
    const text = stripFence(response.text ?? '');
    if (!text) throw new Error(`${model}이 context 내용을 반환하지 않았습니다.`);
    await writeAtomic(paths.context, `${text}\n`);
  } finally {
    await rm(analysis, { force: true });
    if (uploadedName) await ai.files.delete({ name: uploadedName }).catch(() => {});
  }
}
