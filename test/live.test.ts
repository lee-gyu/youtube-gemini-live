import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHUNK_BYTES, chunkPcm, translateSegment } from '../src/live.ts';
import type { Clock, Connect, LiveHandlers, LiveMessage } from '../src/live.ts';

/** Clock whose sleeps return immediately but advance time, with a hook to simulate the server. */
class FakeClock implements Clock {
  t = 0;
  onSleep: (() => void) | undefined;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
    this.onSleep?.();
  }
}

type Sent = { audio?: { data: string; mimeType: string }; audioStreamEnd?: boolean };

function fakeConnect(onSend?: (sent: Sent, handlers: LiveHandlers, count: number) => void) {
  const sent: Sent[] = [];
  const state = { closed: false, handlers: undefined as LiveHandlers | undefined };
  const connect: Connect = async (handlers) => {
    state.handlers = handlers;
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

const audioMessage = (bytes: number[]): LiveMessage => ({
  serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.from(bytes).toString('base64') } }] } },
});

const oneSecond = Buffer.alloc(CHUNK_BYTES * 10, 1);

test('chunkPcm splits into fixed chunks with a shorter remainder', () => {
  const chunks = chunkPcm(Buffer.alloc(CHUNK_BYTES * 2 + 10));
  assert.deepEqual(chunks.map((c) => c.length), [CHUNK_BYTES, CHUNK_BYTES, 10]);
  assert.deepEqual(chunkPcm(Buffer.alloc(0)), []);
});

test('sends the segment, tail silence, then audioStreamEnd, and closes the session', async () => {
  const { connect, sent, state } = fakeConnect();
  await translateSegment(oneSecond, connect, new FakeClock());

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
    const { connect } = fakeConnect((sent) => {
      if (sent.audio) times.push(clock.now());
    });
    await translateSegment(oneSecond, connect, clock, { pace });
    return times;
  };
  const realTime = await sendTimes(1);
  assert.equal(realTime[0], 0);
  assert.equal(realTime[1], 100);
  assert.equal(realTime.at(-1), 2900);
  assert.equal((await sendTimes(2)).at(-1), 1450);
});

test('collects translated audio and both transcripts', async () => {
  const { connect } = fakeConnect((sent, handlers, count) => {
    if (count === 1) {
      handlers.onMessage({ serverContent: { inputTranscription: { text: 'hello ' } } });
      handlers.onMessage(audioMessage([1, 2]));
      handlers.onMessage({ serverContent: { outputTranscription: { text: '안녕' } } });
    }
    if (sent.audioStreamEnd) {
      handlers.onMessage({ serverContent: { inputTranscription: { text: 'world' } } });
      handlers.onMessage(audioMessage([3, 4]));
      handlers.onMessage({ serverContent: { outputTranscription: { text: '하세요' } } });
    }
  });
  const result = await translateSegment(oneSecond, connect, new FakeClock());
  assert.deepEqual(result, {
    audio: Buffer.from([1, 2, 3, 4]),
    transcript: '안녕하세요',
    inputTranscript: 'hello world',
  });
});

test('waits for the output to go idle before finishing', async () => {
  const clock = new FakeClock();
  let handlers: LiveHandlers | undefined;
  const { connect } = fakeConnect((_sent, h) => {
    handlers = h;
  });
  // Input ends at t=2900 and the output is polled every 250ms, so the last audio
  // inside (3000, 6000] arrives at t=5900; completion needs 5s of quiet after that.
  let lastAudioAt = 0;
  clock.onSleep = () => {
    if (clock.now() > 3000 && clock.now() <= 6000) {
      handlers!.onMessage(audioMessage([9]));
      lastAudioAt = clock.now();
    }
  };
  const result = await translateSegment(oneSecond, connect, clock);
  assert.ok(result.audio.length > 0);
  assert.equal(lastAudioAt, 5900);
  assert.equal(clock.now(), lastAudioAt + 5000);
});

test('fails when the session closes before completion', async () => {
  const { connect, state } = fakeConnect((_sent, handlers, count) => {
    if (count === 5) handlers.onClose('1008 connection lifetime exceeded');
  });
  await assert.rejects(translateSegment(oneSecond, connect, new FakeClock()), /완료 전에 종료.*1008/);
  assert.equal(state.closed, true);
});

test('fails on a session error', async () => {
  const { connect } = fakeConnect((sent, handlers) => {
    if (sent.audioStreamEnd) handlers.onError('quota exceeded');
  });
  await assert.rejects(translateSegment(oneSecond, connect, new FakeClock()), /세션 오류: quota exceeded/);
});

test('a close after completion is not a failure', async () => {
  const { connect, state } = fakeConnect();
  await translateSegment(oneSecond, connect, new FakeClock());
  assert.doesNotThrow(() => state.handlers!.onClose('1000'));
});

test('fails when speech was heard but no audio came back', async () => {
  const { connect } = fakeConnect((_sent, handlers, count) => {
    if (count === 1) handlers.onMessage({ serverContent: { inputTranscription: { text: 'hello' } } });
  });
  await assert.rejects(translateSegment(oneSecond, connect, new FakeClock()), /번역 음성이 생성되지 않음/);
});

test('a segment without speech yields empty audio', async () => {
  const { connect } = fakeConnect();
  const result = await translateSegment(oneSecond, connect, new FakeClock());
  assert.equal(result.audio.length, 0);
  assert.equal(result.transcript, '');
});

test('times out when the output never goes idle', async () => {
  const clock = new FakeClock();
  let handlers: LiveHandlers | undefined;
  const { connect } = fakeConnect((_sent, h) => {
    handlers = h;
  });
  clock.onSleep = () => handlers?.onMessage(audioMessage([9]));
  await assert.rejects(translateSegment(oneSecond, connect, clock), /대기 시간 초과/);
  // 3s of input (segment + tail) plus the 90s grace period.
  assert.ok(clock.now() > 93_000 && clock.now() < 94_000, `gave up at ${clock.now()}`);
});
