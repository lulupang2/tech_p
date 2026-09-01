import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { TOPIC_CLASSIFIER_VERSION, TOPIC_TAXONOMY_VERSION, classifyTopics } from '../src/index.js';

describe('PIPE-005 deterministic topic classification', () => {
  test('matches case-insensitively with English boundaries and Korean postpositions', () => {
    const topics = classifyTopics({
      title: 'TypeScript와 Rust programming',
      bodyText: '타입스크립트를 사용하고 러스트로 서비스를 작성한다. Google is unrelated.',
    });
    assert.deepEqual(
      topics.map((topic) => topic.slug),
      ['typescript', 'rust'],
    );
    assert.equal(topics[0]?.method, 'deterministic');
    assert.equal(topics[0]?.taxonomyVersion, TOPIC_TAXONOMY_VERSION);
    assert.equal(topics[0]?.classifierVersion, TOPIC_CLASSIFIER_VERSION);
    assert.equal(topics[0]?.confidence, 100);
  });

  test('rejects substring collisions and ambiguous aliases without constraints', () => {
    const topics = classifyTopics({
      title: 'Google next steps',
      bodyText: 'rag, node, go, and agent are ordinary isolated words here.',
    });
    assert.deepEqual(topics, []);
  });

  test('accepts ambiguous aliases with context or an explicit source constraint', () => {
    const contextual = classifyTopics({
      title: 'RAG pipeline with Node runtime',
      bodyText: 'An AI agent workflow uses the Go language.',
    });
    assert.deepEqual(
      contextual.map((topic) => topic.slug),
      ['nodejs', 'go', 'rag', 'agent'],
    );
    assert(contextual.every((topic) => topic.contextConstrained));
    assert.equal(contextual.find((topic) => topic.slug === 'nodejs')?.confidence, 90);
    assert.equal(contextual.find((topic) => topic.slug === 'go')?.confidence, 90);
    assert.equal(contextual.find((topic) => topic.slug === 'rag')?.confidence, 90);
    assert.equal(contextual.find((topic) => topic.slug === 'agent')?.confidence, 100);

    const sourceConstrained = classifyTopics({ text: 'node', sourceKey: 'github_releases' });
    assert.equal(sourceConstrained[0]?.slug, 'nodejs');
    assert.equal(sourceConstrained[0]?.sourceConstrained, true);
    assert.equal(sourceConstrained[0]?.confidence, 80);
  });
});
