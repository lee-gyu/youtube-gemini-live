import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHUNK_BYTES, chunkPcm, speechEnd, translateSegment } from '../src/live.ts';
import type { Clock, Connect, LiveHandlers, LiveMessage } from '../src/live.ts';

/** Clock whose sleeps return immediately but advance time, with a hook to simulate the server. */
class FakeClock implements Clock {
  t = 0;
  onSleep: ((ms: number) => void) | undefined;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
    this.onSleep?.(ms);
  }
}

/** Translated audio is 24kHz mono 16-bit: 48 bytes per millisecond. */
const BYTES_PER_MS = 48;
const silence = (ms: number) => Buffer.alloc(ms * BYTES_PER_MS);
const speech = (ms: number) => Buffer.alloc(ms * BYTES_PER_MS, 0x40);

const audioMessage = (pcm: Buffer): LiveMessage => ({
  serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm.toString('base64') } }] } },
});

type Sent = { audio?: { data: string; mimeType: string }; audioStreamEnd?: boolean };

interface FakeLiveOptions {
  /** Whether the model is speaking at time `t` (ms); it sends digital silence otherwise. */
  speaking?: (t: number) => boolean;
  /** `false` simulates a stalled session that sends no audio at all. */
  streaming?: boolean;
  onSend?: (sent: Sent, handlers: LiveHandlers, count: number) => void;
}

/**
 * Fake Live session that, like the real model, streams audio in real time:
 * whenever time passes it sends that much audio, speech or silence.
 */
function fakeLive(clock: FakeClock, options: FakeLiveOptions = {}) {
  const { speaking = () => false, streaming = true, onSend } = options;
  const sent: Sent[] = [];
  const state = { closed: false, handlers: undefined as LiveHandlers | undefined };
  const connect: Connect = async (handlers) => {
    state.handlers = handlers;
    clock.onSleep = (ms) => {
      if (!streaming || state.closed) return;
      handlers.onMessage(audioMessage(speaking(clock.now()) ? speech(ms) : silence(ms)));
    };
    return {
      sendRealtimeInput(params) {
        sent.push(params);
        onSend?.(params, handlers, sent.length);
      },
      close() {
        state.closed = true;
      },
    };
  };
  return { connect, sent, state };
}

/** 1s of input; with the 2s tail the last chunk is sent at t=2900. */
const oneSecond = Buffer.alloc(CHUNK_BYTES * 10, 1);
const INPUT_END = 2900;

test('chunkPcm splits into fixed chunks with a shorter remainder', () => {
  const chunks = chunkPcm(Buffer.alloc(CHUNK_BYTES * 2 + 10));
  assert.deepEqual(chunks.map((c) => c.length), [CHUNK_BYTES, CHUNK_BYTES, 10]);
  assert.deepEqual(chunkPcm(Buffer.alloc(0)), []);
});

test('speechEnd finds the end of the last non-silent sample', () => {
  const pcm = Buffer.alloc(10);
  assert.equal(speechEnd(pcm), 0);
  pcm.writeInt16LE(-3000, 4);
  assert.equal(speechEnd(pcm), 6);
  pcm.writeInt16LE(100, 8); // at the threshold: still silence
  assert.equal(speechEnd(pcm), 6);
  pcm.writeInt16LE(101, 8);
  assert.equal(speechEnd(pcm), 10);
  assert.equal(speechEnd(Buffer.alloc(0)), 0);
});

test('speechEnd honours the sample alignment given by `from`', () => {
  // Byte 0 belongs to a sample that started in the previous chunk.
  const pcm = Buffer.alloc(7);
  pcm.writeInt16LE(5000, 3);
  assert.equal(speechEnd(pcm, 1), 5);
  assert.equal(speechEnd(Buffer.from([0x7f, 0, 0, 0, 0]), 1), 0);
});

test('sends the segment, tail silence, then audioStreamEnd, and closes the session', async () => {
  const clock = new FakeClock();
  const { connect, sent, state } = fakeLive(clock);
  await translateSegment(oneSecond, connect, clock);

  const audio = sent.filter((s) => s.audio);
  assert.equal(audio.length, 10 + 20); // 1s of audio + 2s of tail silence
  assert.equal(audio[0]!.audio!.mimeType, 'audio/pcm;rate=16000');
  assert.deepEqual(Buffer.from(audio[0]!.audio!.data, 'base64'), oneSecond.subarray(0, CHUNK_BYTES));
  assert.ok(Buffer.from(audio[29]!.audio!.data, 'base64').every((b) => b === 0));
  assert.deepEqual(sent.at(-1), { audioStreamEnd: true });
  assert.equal(state.closed, true);
});

test('paces chunks at real time, scaled by pace', async () => {
  const sendTimes = async (pace: number) => {
    const clock = new FakeClock();
    const times: number[] = [];
    const { connect } = fakeLive(clock, {
      onSend: (sent) => {
        if (sent.audio) times.push(clock.now());
      },
    });
    await translateSegment(oneSecond, connect, clock, { pace });
    return times;
  };
  const realTime = await sendTimes(1);
  assert.equal(realTime[0], 0);
  assert.equal(realTime[1], 100);
  assert.equal(realTime.at(-1), INPUT_END);
  assert.equal((await sendTimes(2)).at(-1), INPUT_END / 2);
});

test('collects transcripts and keeps the speech plus a short pad of silence', async () => {
  const clock = new FakeClock();
  const { connect } = fakeLive(clock, {
    speaking: (t) => t <= 1000,
    onSend: (sent, handlers, count) => {
      if (count === 1) {
        handlers.onMessage({ serverContent: { inputTranscription: { text: 'hello ' } } });
        handlers.onMessage({ serverContent: { outputTranscription: { text: '안녕' } } });
      }
      if (sent.audioStreamEnd) {
        handlers.onMessage({ serverContent: { inputTranscription: { text: 'world' } } });
        handlers.onMessage({ serverContent: { outputTranscription: { text: '하세요' } } });
      }
    },
  });
  const result = await translateSegment(oneSecond, connect, clock);

  assert.equal(result.transcript, '안녕하세요');
  assert.equal(result.inputTranscript, 'hello world');
  // 1s of speech + the 500ms pad; the seconds of silence streamed afterwards are dropped.
  assert.deepEqual(result.audio, Buffer.concat([speech(1000), silence(500)]));
});

test('silence received before the input ended does not count as completion', async () => {
  const clock = new FakeClock();
  const { connect } = fakeLive(clock);
  await translateSegment(oneSecond, connect, clock);
  // The server was silent throughout, yet 5s of silence must arrive after the input ended.
  assert.equal(clock.now(), INPUT_END + 5000);
});

test('waits until the translated speech has ended, however long after the input', async () => {
  const clock = new FakeClock();
  // Polled every 250ms from t=2900, the last speech chunk ends at t=5900.
  const { connect } = fakeLive(clock, { speaking: (t) => t <= 6000 });
  const result = await translateSegment(oneSecond, connect, clock);
  assert.equal(clock.now(), 5900 + 5000);
  assert.equal(result.audio.length, (5900 + 500) * BYTES_PER_MS);
});

test('fails when the session closes before completion', async () => {
  const clock = new FakeClock();
  const { connect, state } = fakeLive(clock, {
    onSend: (_sent, handlers, count) => {
      if (count === 5) handlers.onClose('1008 connection lifetime exceeded');
    },
  });
  await assert.rejects(translateSegment(oneSecond, connect, clock), /완료 전에 종료.*1008/);
  assert.equal(state.closed, true);
});

test('fails on a session error', async () => {
  const clock = new FakeClock();
  const { connect } = fakeLive(clock, {
    onSend: (sent, handlers) => {
      if (sent.audioStreamEnd) handlers.onError('quota exceeded');
    },
  });
  await assert.rejects(translateSegment(oneSecond, connect, clock), /세션 오류: quota exceeded/);
});

test('a close after completion is not a failure', async () => {
  const clock = new FakeClock();
  const { connect, state } = fakeLive(clock);
  await translateSegment(oneSecond, connect, clock);
  assert.doesNotThrow(() => state.handlers!.onClose('1000'));
});

test('fails when speech was heard but only silence came back', async () => {
  const clock = new FakeClock();
  const { connect } = fakeLive(clock, {
    onSend: (_sent, handlers, count) => {
      if (count === 1) handlers.onMessage({ serverContent: { inputTranscription: { text: 'hello' } } });
    },
  });
  await assert.rejects(translateSegment(oneSecond, connect, clock), /번역 음성이 생성되지 않음/);
});

test('a segment without speech yields empty audio', async () => {
  const clock = new FakeClock();
  const { connect } = fakeLive(clock);
  const result = await translateSegment(oneSecond, connect, clock);
  assert.equal(result.audio.length, 0);
  assert.equal(result.transcript, '');
});

test('times out when the session stalls and sends no audio', async () => {
  const clock = new FakeClock();
  const { connect } = fakeLive(clock, { streaming: false });
  await assert.rejects(translateSegment(oneSecond, connect, clock), /대기 시간 초과/);
  // 3s of input (segment + tail) plus the 90s grace period.
  assert.ok(clock.now() > 93_000 && clock.now() < 94_000, `gave up at ${clock.now()}`);
});

test('times out when the translated speech never ends', async () => {
  const clock = new FakeClock();
  const { connect } = fakeLive(clock, { speaking: () => true });
  await assert.rejects(translateSegment(oneSecond, connect, clock), /대기 시간 초과/);
  assert.ok(clock.now() > 93_000 && clock.now() < 94_000, `gave up at ${clock.now()}`);
});
