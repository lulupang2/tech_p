import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  }));
  return nested.flat();
}

test('web may depend on @techpulse/contracts only', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => name.startsWith('@techpulse/'));
  assert.deepEqual(dependencies, ['@techpulse/contracts']);

  const imports = [];
  for (const file of await sourceFiles(sourceRoot)) {
    const contents = await readFile(file, 'utf8');
    for (const match of contents.matchAll(/(?:from\s*|import\()['"](@techpulse\/[^'"]+)/g)) {
      imports.push(match[1]);
    }
  }
  assert.deepEqual(imports, ['@techpulse/contracts']);
});
