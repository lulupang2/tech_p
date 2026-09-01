import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const outputRoot = fileURLToPath(new URL('../.svelte-kit/output/client/', import.meta.url));

async function collectFiles(directory) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? collectFiles(path) : [path];
    }),
  );
  return nested.flat();
}

test('web may depend on @techpulse/contracts only', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const dependencies = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  }).filter((name) => name.startsWith('@techpulse/'));
  assert.deepEqual(dependencies, ['@techpulse/contracts']);

  const imports = [];
  for (const file of await collectFiles(sourceRoot)) {
    const contents = await readFile(file, 'utf8');
    for (const match of contents.matchAll(/(?:from\s*|import\()['"](@techpulse\/[^'"]+)/g)) {
      imports.push(match[1]);
    }
  }
  const uniqueImports = [...new Set(imports)];
  assert.deepEqual(uniqueImports, ['@techpulse/contracts']);
});

test('web does not import forbidden backend packages', async () => {
  const forbiddenPackages = [
    '@techpulse/database',
    '@techpulse/collectors',
    '@techpulse/rag',
    '@techpulse/domain',
    '@techpulse/observability',
    'drizzle-orm',
    'bullmq',
    'ioredis',
    'pg',
    '@neondatabase/serverless',
  ];

  for (const file of await collectFiles(sourceRoot)) {
    const contents = await readFile(file, 'utf8');
    for (const pkg of forbiddenPackages) {
      assert.ok(
        !contents.includes(pkg),
        `Forbidden package import/reference '${pkg}' found in web source file: ${file}`,
      );
    }
  }
});

test('built client bundle contains no database credentials or secret tokens', async () => {
  const secretPatterns = [
    /DATABASE_URL/i,
    /POSTGRES_PASSWORD/i,
    /OPENAI_API_KEY/i,
    /ANTHROPIC_API_KEY/i,
    /ghp_[A-Za-z0-9_]{30,}/,
    /hf_[A-Za-z0-9_]{30,}/,
    /sk-[A-Za-z0-9_]{30,}/,
    /unsafe-local-development-only/,
  ];

  const clientFiles = await collectFiles(outputRoot);
  // If bundle has been built, scan all JS/CSS/HTML files
  for (const file of clientFiles) {
    if (!file.endsWith('.js') && !file.endsWith('.html') && !file.endsWith('.css')) continue;
    const contents = await readFile(file, 'utf8');
    for (const pattern of secretPatterns) {
      assert.ok(
        !pattern.test(contents),
        `Sensitive secret pattern ${pattern} matched in built client bundle: ${file}`,
      );
    }
  }
});
