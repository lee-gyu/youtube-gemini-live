# youtube-gemini-live

이 프로젝트는 youtube url을 받아, 해당 유튜브 영상을 gemini 3.5 live 모델로 한국어로 처리하여 그 음성을 저장하는 프로젝트입니다.

## 기술 스택

- 런타임 패키지 매니저: mise (관련한 명령어는 모두 mise run 으로 처리)

## 작업 순서

1. `mise run translate "youtube URL"`로 실행
2. youtube 영상의 음성을 다운로드 받는다. (해당 content id 폴더를 생성 "work/{content-id}")
3. 해당 음성을 google live translate 모델로 처리하기 위한 context를 분석하여 생성한다. "work/{content-id}/context.md"
4. context.md를 참고하여 live translate를 통해 한국어로 처리된 음성을 생성한다.

## 명령어

- `mise install` → `mise run install`: yt-dlp·ffmpeg와 node 의존성 설치
- `mise run translate "<youtube URL>"`: 전체 파이프라인 실행 (`.env`에 `GEMINI_API_KEY` 필요, `.env.example` 참고)
- `mise run test` / `mise run typecheck`: 단위 테스트(node:test) / 타입 검사

## 구조

Node 24가 TypeScript를 직접 실행한다(빌드 없음). 따라서 enum 등 비소거 문법은 쓰지 않고 import에는 `.ts` 확장자를 붙인다.

`src/cli.ts`가 아래 단계를 순서대로 호출하며, 병합을 제외한 각 단계는 산출물이 이미 있으면 건너뛴다(병합은 매번 다시 수행). 중단 후 같은 명령을 다시 실행하면 이어서 진행되고, 특정 단계를 다시 만들려면 그 산출물을 지우고 재실행한다.

전체 작업이 끝나면 `work/{content-id}` 폴더를 `work/YYMMDD_{title}`(실행 날짜, 제목은 폴더명에 쓸 수 없는 문자를 제거)로 변경한다. 같은 URL을 다시 실행하면 `meta.json`의 id로 변경된 폴더를 찾아 그 안에서 이어서 진행하며, 이미 변경된 폴더 이름은 유지한다.

| 단계 | 모듈 | 산출물 (`work/{content-id}/`) |
|---|---|---|
| 다운로드 | `src/download.ts` | `meta.json`, `source.wav` (16kHz mono PCM) |
| context 생성 | `src/context.ts` | `context.md` (Live 세션의 systemInstruction으로 전문 전달) |
| 구간 분할 | `src/segment.ts` | `segments.json`, `segments/NNN.pcm` |
| 번역 | `src/translate.ts`, `src/live.ts` | `translated/NNN.pcm` (24kHz mono PCM), `translated/NNN.txt` (한국어 전사) |
| 병합 | `src/merge.ts` | `ko.m4a` (최종 산출물) |

## Live 번역 관련 제약

- 모델은 `gemini-3.5-live-translate-preview`, context 분석 모델은 `gemini-4-hydrogen`(`GEMINI_CONTEXT_MODEL`로 교체 가능).
- Live 연결 수명이 약 10분이라 무음 지점 기준 최대 8분 구간으로 나눠 구간당 세션 하나를 순차 처리한다.
- 구간 실패 시 그 구간만 최대 3회 재시도하며, 세션 생성 간격은 12초 이상 둔다.
- `src/live.ts`의 `DEFAULT_OPTIONS`(전송 속도, 꼬리 무음, 완료 판정 시간)와 `src/segment.ts`의 `MAX_SEGMENT_SEC`는 실제 API로 실측하기 전의 초기값이다.
