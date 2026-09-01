import assert from 'node:assert/strict';
import { test } from 'vitest';
import { existsSync } from 'node:fs';

test('collectors package has a source entrypoint', () => {
  assert.equal(existsSync(new URL('../src/index.ts', import.meta.url)), true);
});
