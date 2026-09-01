import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  createDatabaseClient,
  createDocumentRepository,
  createMetricObservationRepository,
} from '../src/index.js';
import { sources } from '../src/schema/index.js';

const databaseUrl = process.env['DATABASE_URL_DIRECT'] || process.env['DATABASE_URL'];
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration('DB Normalized Documents & Metric Observations Repository Integration', () => {
  test('saves normalized document idempotently with deterministic hash and revisions', async () => {
    const client = createDatabaseClient({ databaseUrl: databaseUrl as string });
    const db = client.db;
    const docRepo = createDocumentRepository(db);

    await client.migrate();

    const normalizedHash = 'f'.repeat(64);
    const saveInput = {
      artifactType: 'release_note' as const,
      canonicalUrl: 'https://github.com/example/lib/releases/tag/v1.0.0',
      title: 'Example Lib v1.0.0',
      bodyText: 'Release notes content for v1.0.0',
      author: null,
      language: 'en',
      publishedAt: new Date('2026-09-01T12:00:00.000Z'),
      licenseId: null,
      normalizedHash,
      normalizerVersion: 'v1.0.0',
      status: 'pending' as const,
    };

    // First save: creates document and new revision
    const res1 = await docRepo.saveNormalizedDocument(saveInput);
    assert(res1.document.id);
    assert(res1.revision.id);
    assert.equal(res1.isNewRevision, true);
    assert.equal(res1.revision.title, 'Example Lib v1.0.0');
    assert.equal(res1.revision.normalizedHash, normalizedHash);

    // Second save (replay): same document and revision returned, isNewRevision: false
    const res2 = await docRepo.saveNormalizedDocument(saveInput);
    assert.equal(res2.document.id, res1.document.id);
    assert.equal(res2.revision.id, res1.revision.id);
    assert.equal(res2.isNewRevision, false);

    // Verify findRevisionByHash
    const foundByHash = await docRepo.findRevisionByHash(res1.document.id, normalizedHash);
    assert(foundByHash);
    assert.equal(foundByHash.id, res1.revision.id);
  });

  test('upserts metric observations idempotently by natural key', async () => {
    const client = createDatabaseClient({ databaseUrl: databaseUrl as string });
    const db = client.db;
    const metricRepo = createMetricObservationRepository(db);

    await client.migrate();

    // Create a source for FK constraint
    const [source] = await db
      .insert(sources)
      .values({
        key: `source-metric-test-${Date.now()}`,
        name: 'Metric Test Source',
        kind: 'api',
        baseUrl: 'https://api.example.com',
        enabled: true,
      })
      .returning();
    assert(source);

    const windowDate = new Date('2026-09-01T00:00:00.000Z');
    const metricInput = {
      sourceId: source.id,
      subjectKey: 'typescript',
      metricType: 'release_activity',
      windowStart: windowDate,
      windowEnd: windowDate,
      value: 1,
      unit: 'releases',
    };

    // First insert
    const m1 = await metricRepo.upsert(metricInput);
    assert(m1.id);
    assert.equal(m1.subjectKey, 'typescript');
    assert.equal(m1.value, 1);

    // Second insert (conflict replay)
    const m2 = await metricRepo.upsert(metricInput);
    assert.equal(m2.id, m1.id);

    // List by subject
    const listRes = await metricRepo.listBySubject('typescript');
    assert.ok(listRes.items.length >= 1);
    const found = listRes.items.find((i) => i.id === m1.id);
    assert(found);
    assert.equal(found.metricType, 'release_activity');
  });
});
