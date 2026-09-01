import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';

test('database package has a source entrypoint', () => {
  assert.equal(existsSync(new URL('../src/index.ts', import.meta.url)), true);
});
