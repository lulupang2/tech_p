import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  createDatabaseClient,
  createDocumentRepository,
  createDuplicateClusterRepository,
} from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL_DIRECT'] || process.env['DATABASE_URL'];
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration('DB Deduplication Clusters & Document Linking Integration', () => {
  test('creates duplicate clusters and links documents with preserved provenance', async () => {
    const client = createDatabaseClient({ databaseUrl: databaseUrl as string });
    const db = client.db;
    const docRepo = createDocumentRepository(db);
    const clusterRepo = createDuplicateClusterRepository(db);

    await client.migrate();

    // 1. Create two documents
    const doc1 = await docRepo.saveNormalizedDocument({
      artifactType: 'release_note',
      canonicalUrl: `https://github.com/example/repo-${Date.now()}/releases/tag/v1.0`,
      title: 'Release v1.0',
      bodyText: 'First release body text.',
      normalizedHash: '1'.repeat(64),
      normalizerVersion: 'v1.0.0',
    });

    const doc2 = await docRepo.saveNormalizedDocument({
      artifactType: 'article',
      canonicalUrl: `https://example.com/blog/release-${Date.now()}`,
      title: 'Blog Release v1.0',
      bodyText: 'First release body text.',
      normalizedHash: '2'.repeat(64),
      normalizerVersion: 'v1.0.0',
    });

    // 2. Create duplicate cluster
    const cluster = await clusterRepo.create({
      representativeDocumentId: doc1.document.id,
      algorithmVersion: 'v1.0.0',
      confidence: 100,
    });

    assert(cluster.id);
    assert.equal(cluster.representativeDocumentId, doc1.document.id);
    assert.equal(cluster.confidence, 100);

    // 3. Assign duplicateClusterId to both documents
    await docRepo.assignDuplicateCluster(doc1.document.id, cluster.id);
    await docRepo.assignDuplicateCluster(doc2.document.id, cluster.id);

    // 4. Verify documents are linked to the cluster
    const updated1 = await docRepo.findById(doc1.document.id);
    const updated2 = await docRepo.findById(doc2.document.id);

    assert.equal(updated1?.duplicateClusterId, cluster.id);
    assert.equal(updated2?.duplicateClusterId, cluster.id);

    // 5. Verify listDocumentsByClusterId
    const clusterMembers = await docRepo.listDocumentsByClusterId(cluster.id);
    assert.equal(clusterMembers.length, 2);
    const memberIds = clusterMembers.map((m) => m.id);
    assert.ok(memberIds.includes(doc1.document.id));
    assert.ok(memberIds.includes(doc2.document.id));
  });
});
