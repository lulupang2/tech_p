import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  DEDUPLICATION_ALGORITHM_VERSION,
  DEDUPLICATION_THRESHOLD,
  DEDUPLICATION_BOILERPLATE_RULE_VERSION,
  createDeduplicationService,
  normalizeCanonicalUrl,
  computeTitleFingerprint,
  computeBodyFingerprint,
  computeExactBodyHash,
  computeFingerprintSimilarity,
  type DeduplicationTargetDoc,
  type ExistingDedupDocument,
} from '../src/index.js';

describe('PIPE-004 Deduplication and Duplicate Cluster Service', () => {
  const dedupService = createDeduplicationService();

  test('records deduplication version correctly', () => {
    assert.equal(dedupService.deduplicationVersion, 'exp004-dedup-v1.0.0');
    assert.equal(DEDUPLICATION_ALGORITHM_VERSION, 'exp004-dedup-v1.0.0');
    assert.equal(dedupService.nearDuplicateThreshold, DEDUPLICATION_THRESHOLD);
    assert.equal(dedupService.boilerplateRuleVersion, DEDUPLICATION_BOILERPLATE_RULE_VERSION);
  });

  describe('1. Canonical URL Normalization', () => {
    test('removes tracking parameters (utm_*, fbclid, gclid, etc.) and sorts query parameters', () => {
      const input =
        'https://example.com/posts/react-19/?utm_source=twitter&b=2&utm_medium=social&a=1&fbclid=abc123xyz#heading-1';
      const normalized = normalizeCanonicalUrl(input);

      assert.equal(normalized, 'https://example.com/posts/react-19?a=1&b=2');
    });

    test('normalizes trailing slashes (preserves root / but strips non-root trailing slashes)', () => {
      assert.equal(normalizeCanonicalUrl('https://example.com/'), 'https://example.com/');
      assert.equal(normalizeCanonicalUrl('https://example.com///'), 'https://example.com/');
      assert.equal(
        normalizeCanonicalUrl('https://example.com/docs/api/'),
        'https://example.com/docs/api',
      );
      assert.equal(
        normalizeCanonicalUrl('https://example.com/docs//sub//page///'),
        'https://example.com/docs/sub/page',
      );
    });

    test('lowercases scheme and hostname, and strips standard default ports (:80, :443)', () => {
      assert.equal(
        normalizeCanonicalUrl('HTTP://EXAMPLE.COM:80/release/v1'),
        'http://example.com/release/v1',
      );
      assert.equal(
        normalizeCanonicalUrl('HTTPS://GITHUB.COM:443/facebook/react/'),
        'https://github.com/facebook/react',
      );
      // Non-standard port is preserved
      assert.equal(
        normalizeCanonicalUrl('http://example.com:8080/path/'),
        'http://example.com:8080/path',
      );
    });

    test('returns null for null, empty, non-http/https, or invalid URLs', () => {
      assert.equal(normalizeCanonicalUrl(null), null);
      assert.equal(normalizeCanonicalUrl(undefined), null);
      assert.equal(normalizeCanonicalUrl(''), null);
      assert.equal(normalizeCanonicalUrl('   '), null);
      assert.equal(normalizeCanonicalUrl('ftp://example.com/file'), null);
      assert.equal(normalizeCanonicalUrl('javascript:alert(1)'), null);
      assert.equal(normalizeCanonicalUrl('not-a-valid-url'), null);
    });
  });

  describe('2. Fingerprint and Similarity Calculation', () => {
    test('computes deterministic 64-bit SimHash for title and body text', () => {
      const title = 'React 19.0.0 Release Notes';
      const fp1 = computeTitleFingerprint(title);
      const fp2 = computeTitleFingerprint(title);

      assert.equal(fp1, fp2);
      assert.match(fp1, /^[0-9a-f]{16}$/);

      const body = 'React Server Components are now available in React 19 alongside Actions.';
      const bodyFp = computeBodyFingerprint(body);
      assert.match(bodyFp, /^[0-9a-f]{16}$/);
    });

    test('computes high similarity for slight text modifications and lower similarity for distinct texts', () => {
      const textA =
        'React Server Components and Actions provide a powerful new programming model for React applications.';
      const textB =
        'React Server Components and Actions provide a great new programming model for React apps.';
      const textC =
        'Linux kernel 6.12 brings new scheduler improvements, memory management fixes, and ARM support.';

      const fpA = computeBodyFingerprint(textA);
      const fpB = computeBodyFingerprint(textB);
      const fpC = computeBodyFingerprint(textC);

      const simAB = computeFingerprintSimilarity(fpA, fpB);
      const simAC = computeFingerprintSimilarity(fpA, fpC);

      assert.ok(simAB >= 0.7, `Expected simAB (${simAB}) to be >= 0.70`);
      assert.ok(simAB > simAC, `Expected simAB (${simAB}) > simAC (${simAC})`);
    });
  });

  describe('3. Exact Deduplication 3-Stage Priority Rules', () => {
    const baseExistingDoc: ExistingDedupDocument = {
      documentId: 'doc-existing-1',
      revisionId: 'rev-existing-1',
      rawItemId: 'raw-item-1',
      sourceKey: 'github_releases',
      externalId: 'react-v19.0.0',
      canonicalUrl: 'https://github.com/facebook/react/releases/tag/v19.0.0',
      normalizedCanonicalUrl: 'https://github.com/facebook/react/releases/tag/v19.0.0',
      title: 'React 19.0.0',
      bodyText: 'React 19 is officially released with Actions and Server Components.',
      bodyExactHash: computeExactBodyHash(
        'React 19 is officially released with Actions and Server Components.',
      ),
      normalizedHash: '1111111111111111111111111111111111111111111111111111111111111111',
      duplicateClusterId: null,
      createdAt: new Date('2026-08-31T10:00:00.000Z'),
    };

    test('Priority 1 (Natural Key): matches identical (source, external_id, revision/raw_item) even if URL or body differs', () => {
      const target: DeduplicationTargetDoc = {
        documentId: 'doc-target-1',
        revisionId: 'rev-existing-1',
        rawItemId: 'raw-item-1',
        sourceKey: 'github_releases',
        externalId: 'react-v19.0.0',
        canonicalUrl: 'https://custom-mirror.org/react/v19.0.0', // different URL
        title: 'React 19.0.0 Updated Title',
        bodyText: 'Updated release description with notes.', // different body
        normalizedHash: '1111111111111111111111111111111111111111111111111111111111111111',
      };

      const result = dedupService.deduplicate(target, [baseExistingDoc]);

      assert.equal(result.isExactDuplicate, true);
      assert.equal(result.exactMatch?.matchReason, 'natural_key');
      assert.equal(result.exactMatch?.matchedDocumentId, 'doc-existing-1');
      assert.equal(result.exactMatch?.confidence, 100);
      assert.equal(result.clusterAction, 'create_cluster');
      assert.equal(result.representativeDocumentId, 'doc-existing-1');
    });

    test('Priority 2 (Canonical URL): matches normalized canonical URL when natural keys differ', () => {
      const target: DeduplicationTargetDoc = {
        documentId: 'doc-target-2',
        revisionId: 'rev-target-2',
        rawItemId: 'raw-item-2',
        sourceKey: 'react_blog', // different source
        externalId: 'blog-post-react-19', // different externalId
        canonicalUrl:
          'https://github.com/facebook/react/releases/tag/v19.0.0/?utm_source=twitter#intro', // same normalized URL
        title: 'Announcing React 19',
        bodyText: 'We are thrilled to announce the general availability of React 19.',
        normalizedHash: '2222222222222222222222222222222222222222222222222222222222222222',
      };

      const result = dedupService.deduplicate(target, [baseExistingDoc]);

      assert.equal(result.isExactDuplicate, true);
      assert.equal(result.exactMatch?.matchReason, 'canonical_url');
      assert.equal(result.exactMatch?.matchedDocumentId, 'doc-existing-1');
      assert.equal(result.exactMatch?.confidence, 100);
      assert.equal(result.clusterAction, 'create_cluster');
      assert.equal(result.representativeDocumentId, 'doc-existing-1');
    });

    test('Priority 3 (Exact Body Hash): matches exact body hash when natural keys and canonical URLs differ', () => {
      const target: DeduplicationTargetDoc = {
        documentId: 'doc-target-3',
        revisionId: 'rev-target-3',
        rawItemId: 'raw-item-3',
        sourceKey: 'react_blog', // different source
        externalId: 'blog-syndicated-19', // different externalId
        canonicalUrl: 'https://react.dev/blog/2026/08/31/react-19', // completely different URL
        title: 'React 19 Release',
        bodyText: 'React 19 is officially released with Actions and Server Components.', // EXACT same body text
        normalizedHash: '3333333333333333333333333333333333333333333333333333333333333333',
      };

      const result = dedupService.deduplicate(target, [baseExistingDoc]);

      assert.equal(result.isExactDuplicate, true);
      assert.equal(result.exactMatch?.matchReason, 'exact_body_hash');
      assert.equal(result.exactMatch?.matchedDocumentId, 'doc-existing-1');
      assert.equal(result.exactMatch?.confidence, 100);
      assert.equal(result.clusterAction, 'create_cluster');
      assert.equal(result.representativeDocumentId, 'doc-existing-1');
    });

    test('Strict precedence: Priority 1 (Natural Key) takes precedence over Priority 2 and Priority 3', () => {
      const docMatchingUrl: ExistingDedupDocument = {
        documentId: 'doc-url-match',
        revisionId: 'rev-url-match',
        rawItemId: 'raw-url-match',
        sourceKey: 'react_blog',
        externalId: 'blog-post-1',
        canonicalUrl: 'https://shared-url.com/react-19',
        normalizedCanonicalUrl: 'https://shared-url.com/react-19',
        title: 'React 19 Announcement',
        bodyText: 'Different body text A.',
        normalizedHash: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
      };

      const docMatchingNaturalKey: ExistingDedupDocument = {
        documentId: 'doc-natural-key-match',
        revisionId: 'rev-nk-match',
        rawItemId: 'raw-nk-match',
        sourceKey: 'github_releases',
        externalId: 'react-v19.0.0',
        canonicalUrl: 'https://github-url.com/react-19',
        normalizedCanonicalUrl: 'https://github-url.com/react-19',
        title: 'React 19 GitHub Release',
        bodyText: 'Different body text B.',
        normalizedHash: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
      };

      const target: DeduplicationTargetDoc = {
        documentId: 'doc-target-eval',
        revisionId: 'rev-target-eval',
        rawItemId: 'raw-nk-match', // Matches docMatchingNaturalKey on Natural Key
        sourceKey: 'github_releases',
        externalId: 'react-v19.0.0',
        canonicalUrl: 'https://shared-url.com/react-19', // Matches docMatchingUrl on URL
        title: 'React 19 Release',
        bodyText: 'Some body text.',
        normalizedHash: 'cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333',
      };

      const result = dedupService.deduplicate(target, [docMatchingUrl, docMatchingNaturalKey]);

      // Must choose Natural Key match over URL match
      assert.equal(result.isExactDuplicate, true);
      assert.equal(result.exactMatch?.matchReason, 'natural_key');
      assert.equal(result.exactMatch?.matchedDocumentId, 'doc-natural-key-match');
    });

    test('Strict precedence: Priority 2 (Canonical URL) takes precedence over Priority 3 (Body Hash)', () => {
      const docMatchingHash: ExistingDedupDocument = {
        documentId: 'doc-hash-match',
        revisionId: 'rev-hash-match',
        rawItemId: 'raw-hash-match',
        sourceKey: 'source_a',
        externalId: 'ext-a',
        canonicalUrl: 'https://source-a.com/article',
        normalizedCanonicalUrl: 'https://source-a.com/article',
        title: 'Article A',
        bodyText: 'Shared identical body content.',
        bodyExactHash: computeExactBodyHash('Shared identical body content.'),
        normalizedHash: 'hash-shared',
      };

      const docMatchingUrl: ExistingDedupDocument = {
        documentId: 'doc-url-match',
        revisionId: 'rev-url-match',
        rawItemId: 'raw-url-match',
        sourceKey: 'source_b',
        externalId: 'ext-b',
        canonicalUrl: 'https://target-domain.com/item-1',
        normalizedCanonicalUrl: 'https://target-domain.com/item-1',
        title: 'Article B',
        bodyText: 'Different body content B.',
        bodyExactHash: computeExactBodyHash('Different body content B.'),
        normalizedHash: 'hash-b',
      };

      const target: DeduplicationTargetDoc = {
        documentId: 'doc-target-url-vs-hash',
        revisionId: 'rev-target',
        rawItemId: 'raw-target',
        sourceKey: 'source_c',
        externalId: 'ext-c',
        canonicalUrl: 'https://target-domain.com/item-1?utm_medium=email', // Matches docMatchingUrl
        title: 'Article C',
        bodyText: 'Shared identical body content.', // Matches docMatchingHash
        normalizedHash: 'hash-c',
      };

      const result = dedupService.deduplicate(target, [docMatchingHash, docMatchingUrl]);

      // Must choose URL match over Body Hash match
      assert.equal(result.isExactDuplicate, true);
      assert.equal(result.exactMatch?.matchReason, 'canonical_url');
      assert.equal(result.exactMatch?.matchedDocumentId, 'doc-url-match');
    });
  });

  describe('4. Cross-Source Origin Preservation and Duplicate Cluster Linking', () => {
    test('joins existing duplicate_cluster when matched document already belongs to a cluster', () => {
      const clusteredDoc: ExistingDedupDocument = {
        documentId: 'doc-gh-release',
        revisionId: 'rev-gh-1',
        rawItemId: 'raw-gh-1',
        sourceKey: 'github_releases',
        externalId: 'react-19',
        canonicalUrl: 'https://github.com/facebook/react/releases/tag/v19.0.0',
        normalizedCanonicalUrl: 'https://github.com/facebook/react/releases/tag/v19.0.0',
        title: 'React 19.0.0 Release',
        bodyText: 'Release notes for React 19.',
        bodyExactHash: computeExactBodyHash('Release notes for React 19.'),
        normalizedHash: '1111111111111111111111111111111111111111111111111111111111111111',
        duplicateClusterId: 'cluster-react-19', // already clustered
      };

      const crossSourceDoc: DeduplicationTargetDoc = {
        documentId: 'doc-react-blog',
        revisionId: 'rev-blog-1',
        rawItemId: 'raw-blog-1',
        sourceKey: 'react_blog', // Cross-source item
        externalId: 'react-19-blog-post',
        canonicalUrl: 'https://github.com/facebook/react/releases/tag/v19.0.0?utm_source=blog',
        title: 'React 19.0.0 in Blog',
        bodyText: 'Blog coverage of React 19 release.',
        normalizedHash: '2222222222222222222222222222222222222222222222222222222222222222',
      };

      const result = dedupService.deduplicate(crossSourceDoc, [clusteredDoc]);

      assert.equal(result.isExactDuplicate, true);
      assert.equal(result.clusterAction, 'join_cluster');
      assert.equal(result.targetClusterId, 'cluster-react-19');
      assert.equal(result.representativeDocumentId, 'doc-gh-release');
      // Provenance remains intact
      assert.equal(crossSourceDoc.rawItemId, 'raw-blog-1');
      assert.equal(crossSourceDoc.sourceKey, 'react_blog');
    });
  });

  describe('5. Near-Duplicate Candidate Suggestion Only (EXP-004 Approved)', () => {
    test('suggests candidates for similar title/body without creating cluster or auto-merging', () => {
      const existingDoc: ExistingDedupDocument = {
        documentId: 'doc-forum-1',
        revisionId: 'rev-forum-1',
        rawItemId: 'raw-forum-1',
        sourceKey: 'users_rust_lang',
        externalId: 'topic-9999',
        canonicalUrl: 'https://users.rust-lang.org/t/how-to-use-async-await-in-rust-2024/9999',
        normalizedCanonicalUrl:
          'https://users.rust-lang.org/t/how-to-use-async-await-in-rust-2024/9999',
        title: 'How to use async await syntax in Rust 2024 Edition',
        bodyText:
          'I am trying to understand the new async closures and async await features introduced in Rust 2024 edition with tokio runtime. read_more generated_by_fixture',
        normalizedHash: 'rust-forum-hash-1',
      };

      const nearDupDoc: DeduplicationTargetDoc = {
        documentId: 'doc-qa-1',
        revisionId: 'rev-qa-1',
        rawItemId: 'raw-qa-1',
        sourceKey: 'stack_exchange', // Cross-source question
        externalId: 'se-question-8888',
        canonicalUrl:
          'https://stackoverflow.com/questions/8888/how-to-use-async-await-in-rust-2024',
        title: 'How do I use async await in Rust 2024 Edition?', // Near identical title
        bodyText:
          'I want to understand the new async closures and async await features introduced in Rust 2024 edition with tokio runtime. read_more generated_by_fixture', // Near identical body
        normalizedHash: 'se-qa-hash-2',
        verbatimOnly: true,
      };

      const result = dedupService.deduplicate(nearDupDoc, [existingDoc]);

      // Must NOT be an exact duplicate
      assert.equal(result.isExactDuplicate, false);
      assert.equal(result.exactMatch, null);
      assert.equal(result.clusterAction, 'none');
      assert.equal(result.targetClusterId, null);

      // Must suggest as a candidate
      assert.equal(result.nearDuplicateCandidates.length, 1);
      const candidate = result.nearDuplicateCandidates[0]!;
      assert.equal(candidate.candidateDocumentId, 'doc-forum-1');
      assert.equal(candidate.candidateSourceKey, 'users_rust_lang');
      assert.ok(
        candidate.similarity >= 0.8,
        `Expected candidate similarity (${candidate.similarity}) to be >= 0.80`,
      );
      assert.equal(candidate.algorithmVersion, DEDUPLICATION_ALGORITHM_VERSION);
      assert.equal(candidate.threshold, DEDUPLICATION_THRESHOLD);
      assert.equal(candidate.manualReviewRequired, true);
      assert.ok(candidate.manualReviewReasons.includes('threshold_near'));
      assert.ok(candidate.manualReviewReasons.includes('verbatim_only'));
      assert.equal(result.manualReviewRequired, true);
    });

    test('does not suggest a low-confidence lexical match or create a cluster', () => {
      const target: DeduplicationTargetDoc = {
        documentId: 'doc-low-confidence',
        title: 'Rust async overview',
        bodyText: 'A short unrelated note about deployment.',
        normalizedHash: 'low-confidence-hash',
      };
      const existing: ExistingDedupDocument = {
        documentId: 'doc-existing-low-confidence',
        title: 'Rust release analysis',
        bodyText: 'Rust release compatibility and performance details.',
        normalizedHash: 'existing-low-confidence-hash',
      };

      const result = dedupService.deduplicate(target, [existing]);
      assert.equal(result.nearDuplicateCandidates.length, 0);
      assert.equal(result.clusterAction, 'none');
      assert.equal(result.manualReviewRequired, false);
    });

    test('removes fixed boilerplate before lexical scoring', () => {
      const target: DeduplicationTargetDoc = {
        documentId: 'doc-boilerplate-target',
        title: 'A deterministic title',
        bodyText: 'shared lexical content read_more generated_by_fixture',
        normalizedHash: 'boilerplate-target-hash',
      };
      const existing: ExistingDedupDocument = {
        documentId: 'doc-boilerplate-existing',
        title: 'A deterministic title',
        bodyText: 'shared lexical content',
        normalizedHash: 'boilerplate-existing-hash',
      };

      const result = dedupService.deduplicate(target, [existing]);
      assert.equal(result.nearDuplicateCandidates.length, 1);
      assert.equal(result.nearDuplicateCandidates[0]?.bodySimilarity, 1);
    });
  });

  describe('6. Deterministic Reprocessing Invariance and Idempotency', () => {
    test('repeated execution yields identical result and cluster decision', () => {
      const existingDocs: ExistingDedupDocument[] = [
        {
          documentId: 'doc-seed-1',
          revisionId: 'rev-seed-1',
          rawItemId: 'raw-seed-1',
          sourceKey: 'arxiv',
          externalId: '2608.12345v1',
          canonicalUrl: 'https://arxiv.org/abs/2608.12345',
          normalizedCanonicalUrl: 'https://arxiv.org/abs/2608.12345',
          title: 'Retrieval Augmented Generation with pgvector',
          bodyText: 'We study scalable retrieval architectures with PostgreSQL and pgvector.',
          bodyExactHash: computeExactBodyHash(
            'We study scalable retrieval architectures with PostgreSQL and pgvector.',
          ),
          normalizedHash: 'arxiv-hash-1',
        },
      ];

      const target: DeduplicationTargetDoc = {
        documentId: 'doc-target-repeat',
        revisionId: 'rev-target-repeat',
        rawItemId: 'raw-target-repeat',
        sourceKey: 'arxiv',
        externalId: '2608.12345v2', // v2 of same paper with same canonical URL
        canonicalUrl: 'https://arxiv.org/abs/2608.12345?utm_source=arxiv_feed',
        title: 'Retrieval Augmented Generation with pgvector v2',
        bodyText: 'We study scalable retrieval architectures with PostgreSQL and pgvector updated.',
        normalizedHash: 'arxiv-hash-2',
      };

      const result1 = dedupService.deduplicate(target, existingDocs);
      const result2 = dedupService.deduplicate(target, existingDocs);
      const result3 = dedupService.deduplicate(target, existingDocs);

      assert.deepEqual(result1, result2);
      assert.deepEqual(result2, result3);
      assert.equal(result1.isExactDuplicate, true);
      assert.equal(result1.exactMatch?.matchReason, 'canonical_url');
      assert.equal(result1.exactMatch?.matchedDocumentId, 'doc-seed-1');
    });
  });
});
