import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  SOURCE_POLICIES,
  validateUrl,
  stripPii,
  encodeOpaqueCursor,
  decodeOpaqueCursor,
  BaseCollector,
} from '../src/index.js';
import type { CollectionContext, CollectionResult } from '@techpulse/domain';

describe('COL-001 Collector Port & Source Policy Guard', () => {
  describe('SSRF and URL Validation Guard (THR-001)', () => {
    const ghPolicy = SOURCE_POLICIES['github_releases'];

    test('accepts valid https URL within allowed host', () => {
      const res = validateUrl(
        'https://api.github.com/repos/microsoft/TypeScript/releases',
        ghPolicy,
      );
      assert.equal(res.valid, true);
      assert.equal(res.reason, undefined);
    });

    test('rejects unpermitted scheme (http for github_releases)', () => {
      const res = validateUrl(
        'http://api.github.com/repos/microsoft/TypeScript/releases',
        ghPolicy,
      );
      assert.equal(res.valid, false);
      assert(res.reason?.includes('not permitted'));
    });

    test('rejects loopback and private IPv4 addresses (SSRF corpus)', () => {
      const loopbackUrls = [
        'https://127.0.0.1/admin',
        'https://localhost:8080/metrics',
        'https://10.0.0.1/metadata',
        'https://192.168.1.1/router',
        'https://172.16.0.1/private',
        'https://169.254.169.254/latest/meta-data/', // AWS metadata
      ];

      for (const url of loopbackUrls) {
        const res = validateUrl(url, ghPolicy);
        assert.equal(res.valid, false, `Expected ${url} to be blocked by SSRF guard`);
        assert(
          res.reason?.includes('SSRF guard') || res.reason?.includes('not in the allowed hosts'),
        );
      }
    });

    test('rejects unlisted external host', () => {
      const res = validateUrl('https://malicious-site.com/exploit', ghPolicy);
      assert.equal(res.valid, false);
      assert(res.reason?.includes('not in the allowed hosts list'));
    });
  });

  describe('PII Redaction Guard (SECURITY.md §8)', () => {
    test('strips author and owner objects from GitHub payload', () => {
      const ghPolicy = SOURCE_POLICIES['github_releases'];
      const rawPayload = {
        id: 12345,
        tag_name: 'v1.0.0',
        body: 'Release notes body text',
        author: {
          login: 'octocat',
          id: 1,
          avatar_url: 'https://github.com/images/error/octocat_happy.gif',
        },
        assets: [
          {
            name: 'bundle.js',
            uploader: { login: 'admin' },
          },
        ],
      };

      const sanitized = stripPii(rawPayload, ghPolicy);
      assert.equal(sanitized.id, 12345);
      assert.equal(sanitized.tag_name, 'v1.0.0');
      assert.equal(sanitized.body, 'Release notes body text');
      assert.equal((sanitized as Record<string, unknown>)['author'], undefined);
      assert.equal(
        (sanitized.assets as Array<Record<string, unknown>>)[0]?.['uploader'],
        undefined,
      );
    });

    test('strips owner display_name, profile_image from StackExchange payload', () => {
      const sePolicy = SOURCE_POLICIES['stack_exchange'];
      const sePayload = {
        question_id: 9876,
        title: 'How to use TypeScript?',
        content_license: 'CC BY-SA 4.0',
        owner: {
          user_id: 42,
          display_name: 'Real Name Person',
          profile_image: 'https://www.gravatar.com/avatar/12345',
          link: 'https://stackoverflow.com/users/42',
        },
      };

      const sanitized = stripPii(sePayload, sePolicy);
      assert.equal(sanitized.question_id, 9876);
      assert.equal(sanitized.title, 'How to use TypeScript?');
      assert.equal((sanitized as Record<string, unknown>)['owner'], undefined);
    });

    test('strips email addresses from npm_registry payload', () => {
      const npmPolicy = SOURCE_POLICIES['npm_registry'];
      const npmPayload = {
        name: 'test-pkg',
        author: { name: 'Dev', email: 'dev@secret.com' },
        maintainers: [{ name: 'M1', email: 'm1@secret.com' }],
        publisher: { email: 'pub@secret.com' },
      };

      const sanitized = stripPii(npmPayload, npmPolicy);
      assert.equal(sanitized.name, 'test-pkg');
      assert.equal((sanitized.author as Record<string, unknown>)['email'], undefined);
      assert.equal(
        (sanitized.maintainers as Array<Record<string, unknown>>)[0]?.['email'],
        undefined,
      );
      assert.equal((sanitized.publisher as Record<string, unknown>)['email'], undefined);
    });
    test('strips username, name, user_id, avatar_template from users_rust_lang payload', () => {
      const discoursePolicy = SOURCE_POLICIES['users_rust_lang'];
      const discoursePayload = {
        id: 50001,
        title: 'Async Rust Channels',
        username: 'rust_ace',
        name: 'Jane Rustacean',
        user_id: 1234,
        avatar_template: '/avatar/{size}.png',
        post_stream: {
          posts: [
            {
              id: 901,
              username: 'rust_ace',
              name: 'Jane Rustacean',
              user_id: 1234,
              avatar_template: '/avatar/{size}.png',
              cooked: '<p>Content</p>',
            },
          ],
        },
        details: {
          created_by: {
            username: 'rust_ace',
            name: 'Jane Rustacean',
            user_id: 1234,
            avatar_template: '/avatar/{size}.png',
          },
        },
      };

      const sanitized = stripPii(discoursePayload, discoursePolicy);
      assert.equal(sanitized.id, 50001);
      assert.equal(sanitized.title, 'Async Rust Channels');
      assert.equal((sanitized as Record<string, unknown>)['username'], undefined);
      assert.equal((sanitized as Record<string, unknown>)['name'], undefined);
      assert.equal((sanitized as Record<string, unknown>)['user_id'], undefined);
      assert.equal((sanitized as Record<string, unknown>)['avatar_template'], undefined);

      const post0 = (sanitized.post_stream as Record<string, unknown>).posts as Array<
        Record<string, unknown>
      >;
      assert.equal(post0[0]?.['username'], undefined);
      assert.equal(post0[0]?.['name'], undefined);
      assert.equal(post0[0]?.['user_id'], undefined);
      assert.equal(post0[0]?.['avatar_template'], undefined);
      assert.equal(post0[0]?.['cooked'], '<p>Content</p>');

      const createdBy = (sanitized.details as Record<string, unknown>).created_by as Record<
        string,
        unknown
      >;
      assert.equal(createdBy?.['username'], undefined);
      assert.equal(createdBy?.['name'], undefined);
      assert.equal(createdBy?.['user_id'], undefined);
      assert.equal(createdBy?.['avatar_template'], undefined);
    });
  });

  describe('Opaque Cursor Encoding & Decoding', () => {
    test('roundtrips cursor data safely through base64url string', () => {
      const cursorData = {
        lastPublishedAt: '2026-09-01T12:00:00.000Z',
        page: 3,
        etag: 'W/"12345"',
      };

      const encoded = encodeOpaqueCursor(cursorData);
      assert(typeof encoded === 'string');
      assert(!encoded.includes('=')); // base64url has no padding

      const decoded = decodeOpaqueCursor<typeof cursorData>(encoded);
      assert.deepEqual(decoded, cursorData);
    });

    test('returns null gracefully for malformed cursor', () => {
      assert.equal(decodeOpaqueCursor('invalid!not-base64-json'), null);
    });
  });

  describe('BaseCollector Implementation & Content Integrity', () => {
    class FakeCollector extends BaseCollector {
      readonly sourceKey = 'github_releases' as const;
      readonly policy = SOURCE_POLICIES['github_releases'];

      async collect(context: CollectionContext): Promise<CollectionResult> {
        const item = this.createRawItem({
          externalId: 'rel-1',
          payload: {
            id: 1,
            body: 'Hello release notes',
            author: { login: 'admin' },
          },
          publishedAt: new Date('2026-09-01T00:00:00Z'),
          cursor: context.cursor,
        });

        return {
          sourceKey: this.sourceKey,
          items: [item],
          nextCursor: encodeOpaqueCursor({ page: 2 }),
          hasMore: false,
        };
      }
    }

    test('collector executes, strips PII, computes sha256 raw hash, and preserves opaque cursor', async () => {
      const collector = new FakeCollector();
      const result = await collector.collect({
        sourceKey: 'github_releases',
        cursor: null,
      });

      assert.equal(result.sourceKey, 'github_releases');
      assert.equal(result.items.length, 1);

      const item = result.items[0]!;
      assert.equal(item.externalId, 'rel-1');
      assert.equal((item.payload as Record<string, unknown>)['author'], undefined);
      assert.equal(item.rawHash.length, 64);
      assert.equal(result.hasMore, false);
      assert(result.nextCursor);
    });
  });
});
