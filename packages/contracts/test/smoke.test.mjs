import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';

test('contracts package exposes its TypeScript entrypoint', () => {
  assert.equal(existsSync(new URL('../src/index.ts', import.meta.url)), true);
});
