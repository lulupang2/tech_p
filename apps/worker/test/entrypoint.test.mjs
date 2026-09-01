import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('worker has a Node TypeScript entrypoint', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /workerEntrypoint/);
});
