import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('API entrypoint selects Elysia Node adapter', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /from '@elysiajs\/node'/);
  assert.match(source, /new Elysia\(\{ adapter: node\(\) \}\)/);
});
