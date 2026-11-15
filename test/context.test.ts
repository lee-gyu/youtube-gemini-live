import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContextPrompt, stripFence } from '../src/context.ts';
import type { Meta } from '../src/download.ts';

const meta: Meta = {
  id: 'abc',
  url: 'https://youtu.be/abc',
  title: 'Deploying with Cloud Run',
  channel: 'Example Channel',
  description: 'A talk about deployment pipelines.',
  duration: 754.6,
};

test('buildContextPrompt includes the video metadata and the context.md layout', () => {
  const prompt = buildContextPrompt(meta);
  for (const expected of [
    'Deploying with Cloud Run',
    'Example Channel',
    '755초',
    'A talk about deployment pipelines.',
    '## 용어집',
    '## 번역하지 않을 고유명사',
  ]) {
    assert.ok(prompt.includes(expected), `missing: ${expected}`);
  }
});

test('buildContextPrompt truncates a long description and marks missing fields', () => {
  const prompt = buildContextPrompt({ ...meta, title: '', description: `${'x'.repeat(2000)}TAIL` });
  assert.ok(!prompt.includes('TAIL'));
  assert.ok(prompt.includes('- 제목: (없음)'));
  assert.ok(buildContextPrompt({ ...meta, description: '  ' }).includes('- 설명:\n(없음)'));
});

test('stripFence unwraps a fenced answer and leaves plain text alone', () => {
  assert.equal(stripFence('```markdown\n# 통역 지침\n내용\n```\n'), '# 통역 지침\n내용');
  assert.equal(stripFence('  # 통역 지침\n내용\n'), '# 통역 지침\n내용');
  assert.equal(stripFence('# 제목\n```\ncode\n```\n끝'), '# 제목\n```\ncode\n```\n끝');
});
