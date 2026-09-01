import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  licenses,
  duplicateClusters,
  duplicateClusterMemberships,
  documents,
  documentRevisions,
  topics,
  documentTopics,
  chunks,
  embeddings,
} from '../src/schema/index.js';

describe('Database Schema DB-003 definition', () => {
  test('exports all DB-003 tables', () => {
    assert(licenses);
    assert(duplicateClusters);
    assert(duplicateClusterMemberships);
    assert(documents);
    assert(documentRevisions);
    assert(topics);
    assert(documentTopics);
    assert(chunks);
    assert(embeddings);
  });

  test('documents table has correct schema structure', () => {
    assert.equal(documents.artifactType.name, 'artifact_type');
    assert.equal(documents.canonicalUrl.name, 'canonical_url');
    assert.equal(documents.duplicateClusterId.name, 'duplicate_cluster_id');
  });

  test('versioned cluster memberships retain immutable revision and algorithm metadata', () => {
    assert.equal(duplicateClusterMemberships.clusterId.name, 'cluster_id');
    assert.equal(duplicateClusterMemberships.documentId.name, 'document_id');
    assert.equal(duplicateClusterMemberships.revisionId.name, 'revision_id');
    assert.equal(duplicateClusterMemberships.algorithmVersion.name, 'algorithm_version');
    assert.equal(duplicateClusterMemberships.confidence.name, 'confidence');
    assert.equal(duplicateClusterMemberships.status.name, 'status');
  });

  test('document_revisions table has correct structure and constraints', () => {
    assert.equal(documentRevisions.documentId.name, 'document_id');
    assert.equal(documentRevisions.title.name, 'title');
    assert.equal(documentRevisions.bodyText.name, 'body_text');
    assert.equal(documentRevisions.normalizedHash.name, 'normalized_hash');
    assert.equal(documentRevisions.status.name, 'status');
  });

  test('chunks and embeddings tables have vector and hash definitions', () => {
    assert.equal(chunks.documentRevisionId.name, 'document_revision_id');
    assert.equal(chunks.ordinal.name, 'ordinal');
    assert.equal(chunks.contentHash.name, 'content_hash');
    assert.equal(embeddings.chunkId.name, 'chunk_id');
    assert.equal(embeddings.embedding.name, 'embedding');
    assert.equal(embeddings.inputHash.name, 'input_hash');
  });
});
