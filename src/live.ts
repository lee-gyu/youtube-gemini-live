import { Modality } from '@google/genai';
import type { GoogleGenAI } from '@google/genai';

export const LIVE_MODEL = 'gemini-3.5-live-translate-preview';
export const TARGET_LANGUAGE = 'ko';

/** 100ms of 16kHz mono 16-bit PCM, the chunk size the Live API recommends. */
export const CHUNK_BYTES = 3200;
export const CHUNK_MS = 100;
/** Bytes per second of the translated audio: 24kHz, mono, 16-bit. */
export const OUTPUT_BYTES_PER_SEC = 24000 * 2;

/** Subset of the SDK's `LiveServerMessage` this module reads. */
export interface LiveMessage {
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
  };
  goAway?: { timeLeft?: string };
}

export interface LiveSession {
  sendRealtimeInput(params: {
    audio?: { data: string; mimeType: string };
    audioStreamEnd?: boolean;
  }): void;
  close(): void;
}

export interface LiveHandlers {
  onMessage(message: LiveMessage): void;
  onError(reason: string): void;
  onClose(reason: string): void;
}

/** Opens one Live session; injected so tests can substitute a fake. */
export type Connect = (handlers: LiveHandlers) => Promise<LiveSession>;

export interface Clock {
  /** Milliseconds on a monotonic clock. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * The model streams audio continuously in real time, sending digital silence
 * (all-zero samples) whenever it is not speaking. Samples at or below this
 * amplitude count as silence.
 */
export const SILENCE_PEAK = 100;

export interface TranslateOptions {
  /** Send speed relative to real time. */
  pace: number;
  /** Silence appended after the segment so the model finishes its last utterance. */
  tailSilenceMs: number;
  /**
   * The segment is complete once this much continuous silent audio has been
   * received after input ended. (Measured: the last utterance ends about 3s
   * after the input does.)
   */
  idleMs: number;
  /** Silence kept after the last translated speech; the rest of the tail is dropped. */
  trailingPadMs: number;
  /** Allowed time beyond the segment's own send duration before giving up. */
  graceMs: number;
  pollMs: number;
}

export const DEFAULT_OPTIONS: TranslateOptions = {
  pace: 1,
  tailSilenceMs: 2000,
  idleMs: 5000,
  trailingPadMs: 500,
  graceMs: 90_000,
  pollMs: 250,
};

export interface SegmentResult {
  /** Translated speech: 24kHz mono 16-bit PCM. */
  audio: Buffer;
  /** Korean transcript of the translated speech. */
  transcript: string;
  /** Transcript of the source speech; used to tell silence from a failed translation. */
  inputTranscript: string;
}

/** Splits PCM into fixed-size chunks; the last one may be shorter. */
export function chunkPcm(pcm: Buffer, size = CHUNK_BYTES): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < pcm.length; i += size) chunks.push(pcm.subarray(i, i + size));
  return chunks;
}

/**
 * Byte offset just past the last non-silent 16-bit sample, or 0 when the PCM
 * is silent throughout. `from` is where the first whole sample starts.
 */
export function speechEnd(pcm: Buffer, from = 0, peak = SILENCE_PEAK): number {
  const last = from + Math.floor((pcm.length - from) / 2) * 2 - 2;
  for (let i = last; i >= from; i -= 2) {
    if (Math.abs(pcm.readInt16LE(i)) > peak) return i + 2;
  }
  return 0;
}

/**
 * Translates one segment in one Live session: streams the PCM at a paced rate,
 * collects the translated audio, and resolves once the translated speech has
 * ended, i.e. `idleMs` of silent audio has arrived after the input ended.
 * The returned audio is cut shortly after the last speech.
 * Throws when the session errors, closes early, times out, or produces no
 * speech although speech was heard.
 */
export async function translateSegment(
  pcm: Buffer,
  connect: Connect,
  clock: Clock = realClock,
  options: Partial<TranslateOptions> = {},
): Promise<SegmentResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const audio: Buffer[] = [];
  let transcript = '';
  let inputTranscript = '';
  /** Bytes of translated audio received so far. */
  let received = 0;
  /** Offset in the received audio just past the last speech; 0 while there is none. */
  let speechEndAt = 0;
  let done = false;
  let failure: Error | undefined;
  const assertAlive = () => {
    if (failure) throw failure;
  };

  const session = await connect({
    onMessage(message) {
      const content = message.serverContent;
      for (const part of content?.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          const chunk = Buffer.from(part.inlineData.data, 'base64');
          // `received % 2` skips a byte that completes a sample split across chunks.
          const end = speechEnd(chunk, received % 2);
          if (end > 0) speechEndAt = received + end;
          received += chunk.length;
          audio.push(chunk);
        }
      }
      transcript += content?.outputTranscription?.text ?? '';
      inputTranscript += content?.inputTranscription?.text ?? '';
    },
    onError(reason) {
      failure ??= new Error(`Live 세션 오류: ${reason}`);
    },
    onClose(reason) {
      if (!done) failure ??= new Error(`Live 세션이 완료 전에 종료됨: ${reason || '사유 없음'}`);
    },
  });

  try {
    const tail = Buffer.alloc(Math.round((opts.tailSilenceMs / CHUNK_MS) * CHUNK_BYTES));
    const chunks = [...chunkPcm(pcm), ...chunkPcm(tail)];
    const stepMs = CHUNK_MS / opts.pace;
    const startedAt = clock.now();
    const deadline = startedAt + chunks.length * stepMs + opts.graceMs;

    for (const [i, chunk] of chunks.entries()) {
      const wait = startedAt + i * stepMs - clock.now();
      if (wait > 0) await clock.sleep(wait);
      assertAlive();
      session.sendRealtimeInput({
        audio: { data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
      });
    }
    session.sendRealtimeInput({ audioStreamEnd: true });

    // Only silence received after this point counts: silence that arrived earlier
    // says nothing about whether the last utterance has been translated yet.
    const receivedAtInputEnd = received;
    const idleBytes = (opts.idleMs / 1000) * OUTPUT_BYTES_PER_SEC;
    while (received - Math.max(speechEndAt, receivedAtInputEnd) < idleBytes) {
      assertAlive();
      if (clock.now() > deadline) throw new Error('Live 응답 대기 시간 초과');
      await clock.sleep(opts.pollMs);
    }
    assertAlive();
    done = true;
  } finally {
    session.close();
  }

  if (speechEndAt === 0) {
    if (inputTranscript.trim() !== '') {
      throw new Error('발화가 인식되었지만 번역 음성이 생성되지 않음');
    }
    return { audio: Buffer.alloc(0), transcript, inputTranscript };
  }
  const padBytes = Math.round((opts.trailingPadMs / 1000) * OUTPUT_BYTES_PER_SEC);
  const keep = Math.min(received, speechEndAt + padBytes);
  return { audio: Buffer.concat(audio).subarray(0, keep), transcript, inputTranscript };
}

/** Real `Connect` backed by the Gemini Live API, with `systemInstruction` as translation guidance. */
export function createLiveConnect(ai: GoogleGenAI, systemInstruction: string): Connect {
  return (handlers) =>
    ai.live.connect({
      model: LIVE_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        translationConfig: { targetLanguageCode: TARGET_LANGUAGE },
      },
      callbacks: {
        onmessage: (message) => handlers.onMessage(message),
        onerror: (event) => handlers.onError(event.message ?? String(event)),
        onclose: (event) => handlers.onClose(`${event.code ?? ''} ${event.reason ?? ''}`.trim()),
      },
    });
}
