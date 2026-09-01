import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { CHUNKER_VERSION, chunkDocument } from '../src/index.js';

describe('PIPE-005 deterministic heading-aware chunking', () => {
  const body = [
    '# Intro',
    '',
    'TypeScript makes this paragraph easy to split into stable chunks.',
    '',
    '## Example',
    '',
    '```ts',
    'const value = 1;',
    'console.log(value);',
    '```',
    '',
    '| name | value |',
    '| --- | --- |',
    '| one | 1 |',
    '',
    '## Done',
    '',
    'The final section is searchable.',
  ].join('\n');

  test('keeps heading paths and code/table units while emitting stable hashes and ordinals', () => {
    const first = chunkDocument({ bodyText: body, maxTokens: 4 });
    const second = chunkDocument({ bodyText: body, maxTokens: 4 });
    assert.equal(first.chunkerVersion, CHUNKER_VERSION);
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.chunks.map((chunk) => chunk.ordinal),
      first.chunks.map((_, i) => i),
    );
    assert(first.chunks.every((chunk) => /^[0-9a-f]{64}$/u.test(chunk.contentHash)));
    const code = first.chunks.find((chunk) => chunk.content.includes('console.log'));
    assert(code);
    assert.deepEqual(code.headingPath, ['Intro', 'Example']);
    assert.equal(code.content, '```ts\nconst value = 1;\nconsole.log(value);\n```');
    const table = first.chunks.find((chunk) => chunk.content.includes('| name |'));
    assert(table);
    assert.equal(table.content, '| name | value |\n| --- | --- |\n| one | 1 |');
  });

  test('returns no invalid empty chunks and rejects invalid size', () => {
    assert.equal(chunkDocument({ bodyText: '   \n\n' }).chunks.length, 0);
    assert.throws(() => chunkDocument({ bodyText: 'text', maxTokens: 0 }), RangeError);
  });
});
