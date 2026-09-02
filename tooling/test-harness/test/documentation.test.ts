import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('DOC-001 clean-reader documentation contract', () => {
  it('README gives a new developer an executable setup and verification path', () => {
    const readme = read('README.md');

    for (const required of [
      'pnpm install --frozen-lockfile',
      'docker compose --profile stack up -d --wait',
      'pnpm --filter @techpulse/database run db:migrate',
      'pnpm run static',
      'pnpm run test',
      'pnpm --filter @techpulse/web test:e2e',
      'docs/RUNBOOK.md',
    ]) {
      expect(readme).toContain(required);
    }
  });

  it('runbook covers every developer and operator acceptance topic', () => {
    const runbook = read('docs/RUNBOOK.md');

    for (const required of [
      'Quickstart: One-Command Local Stack',
      'Collection and Replay',
      'ops collect',
      'ops replay',
      'Public query smoke',
      'RAG evaluation',
      'Secret Rotation Procedure',
      'Backup, Restore, Retention, and Tombstone',
      'pg_dump',
      'pg_restore',
      'Known Limits',
      'insufficient_evidence',
    ]) {
      expect(runbook).toContain(required);
    }
  });

  it('documented package scripts exist', () => {
    const apiManifest = JSON.parse(read('apps/api/package.json')) as {
      scripts?: Record<string, string>;
    };
    const webManifest = JSON.parse(read('apps/web/package.json')) as {
      scripts?: Record<string, string>;
    };

    expect(apiManifest.scripts?.['ops']).toBeTruthy();
    expect(webManifest.scripts?.['test:e2e']).toBeTruthy();
    expect(webManifest.scripts?.['test:e2e:install']).toBeTruthy();
  });
});
