import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  SOURCE_POLICIES,
  validateUrl,
  stripPii,
  encodeOpaqueCursor,
  decodeOpaqueCursor,
  BaseCollector,
  createHardenedFetch,
  SsrfViolationError,
  ResponseSizeExceededError,
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
    test('rejects hex, octal, and decimal IP formats, IPv6, and metadata hostnames (SEC-002)', () => {
      const maliciousSsrfs = [
        'https://2130706433/admin', // 127.0.0.1 as decimal integer
        'https://2852039166/latest/meta-data/', // 169.254.169.254 as decimal integer
        'https://0x7f000001/status', // 127.0.0.1 as hex
        'https://0177.0.0.1/config', // 127.0.0.1 with octal prefix
        'https://[::1]/debug', // IPv6 loopback
        'https://[fe80::1]/secrets', // IPv6 link-local
        'https://[fc00::1]/internal', // IPv6 unique local
        'https://[::ffff:127.0.0.1]/admin', // IPv4-mapped IPv6
        'https://[::ffff:169.254.169.254]/meta-data', // IPv4-mapped AWS metadata
        'https://100.64.0.1/router', // Carrier-grade NAT
        'https://100.100.100.200/latest', // Alibaba Cloud metadata
        'https://metadata.google.internal/computeMetadata/v1/', // GCP metadata
        'https://instance-data/latest/meta-data/', // AWS instance-data
        'https://0.0.0.0/sensitive', // Zero network
        'https://240.0.0.1/reserved', // Reserved IP
      ];

      for (const url of maliciousSsrfs) {
        const res = validateUrl(url, ghPolicy);
        assert.equal(res.valid, false, `Expected SSRF target ${url} to be blocked`);
        assert(res.reason !== undefined);
      }
    });

    test('rejects malicious URI schemes (file, gopher, data, javascript) (SEC-002)', () => {
      const maliciousSchemes = [
        'file:///etc/passwd',
        'gopher://127.0.0.1:6379/_flushall',
        'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
        'javascript:alert(document.cookie)',
        'ftp://api.github.com/dump',
        'ldap://localhost:389/o=root',
      ];

      for (const url of maliciousSchemes) {
        const res = validateUrl(url, ghPolicy);
        assert.equal(res.valid, false, `Expected scheme in ${url} to be rejected`);
        assert(res.reason?.includes('not permitted'));
      }
    });

    test('rejects domain suffix confusion and subdomain spoofing (SEC-002)', () => {
      const spoofedUrls = [
        'https://api.github.com.attacker.com/releases',
        'https://fakeapi.github.com/releases',
        'https://evil-api.github.com/releases',
        'https://api.github.com-spoof.org/releases',
      ];

      for (const url of spoofedUrls) {
        const res = validateUrl(url, ghPolicy);
        assert.equal(res.valid, false, `Expected spoofed host ${url} to be rejected`);
        assert(res.reason?.includes('not in the allowed hosts list'));
      }
    });

    test('rejects unlisted external host', () => {
      const res = validateUrl('https://malicious-site.com/exploit', ghPolicy);
      assert.equal(res.valid, false);
      assert(res.reason?.includes('not in the allowed hosts list'));
    });
  });

  describe('Hardened Fetch Client & Redirect Re-Validation (THR-001 & SEC-002)', () => {
    const ghPolicy = SOURCE_POLICIES['github_releases'];

    test('blocks initial request if target URL violates SSRF policy', async () => {
      const hardenedFetch = createHardenedFetch({ policy: ghPolicy });
      await assert.rejects(
        async () => {
          await hardenedFetch('https://127.0.0.1/admin');
        },
        (err: Error) => {
          return err instanceof SsrfViolationError && err.message.includes('SSRF policy violation');
        },
      );
    });

    test('re-validates every redirect hop and blocks redirect to private IP', async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = input.toString();
        if (url === 'https://api.github.com/initial-endpoint') {
          return new Response(null, {
            status: 302,
            headers: {
              location: 'https://169.254.169.254/latest/meta-data/',
            },
          });
        }
        return new Response('ok', { status: 200 });
      };

      const hardenedFetch = createHardenedFetch({ policy: ghPolicy, baseFetch: mockFetch });

      await assert.rejects(
        async () => {
          await hardenedFetch('https://api.github.com/initial-endpoint');
        },
        (err: Error) => {
          return (
            err instanceof SsrfViolationError &&
            err.message.includes('Redirect target violates SSRF policy')
          );
        },
      );
    });

    test('re-validates redirect to unallowed external host', async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = input.toString();
        if (url === 'https://api.github.com/redirect') {
          return new Response(null, {
            status: 301,
            headers: {
              location: 'https://attacker.com/evil',
            },
          });
        }
        return new Response('ok', { status: 200 });
      };

      const hardenedFetch = createHardenedFetch({ policy: ghPolicy, baseFetch: mockFetch });

      await assert.rejects(
        async () => {
          await hardenedFetch('https://api.github.com/redirect');
        },
        (err: Error) => {
          return (
            err instanceof SsrfViolationError &&
            err.message.includes('Redirect target violates SSRF policy')
          );
        },
      );
    });

    test('allows safe redirects within allowed host and enforces max redirects', async () => {
      let hopCount = 0;
      const mockFetch: typeof fetch = async () => {
        hopCount++;
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://api.github.com/hop-${hopCount}`,
          },
        });
      };

      const hardenedFetch = createHardenedFetch({
        policy: ghPolicy,
        maxRedirects: 2,
        baseFetch: mockFetch,
      });

      await assert.rejects(
        async () => {
          await hardenedFetch('https://api.github.com/hop-0');
        },
        (err: Error) => {
          return (
            err instanceof SsrfViolationError &&
            err.message.includes('Maximum redirect limit (2) exceeded')
          );
        },
      );
    });

    test('rejects response declaring oversized Content-Length', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response('big payload', {
          status: 200,
          headers: {
            'content-length': '20971520', // 20MB
          },
        });
      };

      const hardenedFetch = createHardenedFetch({
        policy: ghPolicy,
        maxSizeBytes: 5 * 1024 * 1024, // 5MB limit
        baseFetch: mockFetch,
      });

      await assert.rejects(
        async () => {
          await hardenedFetch('https://api.github.com/large-release');
        },
        (err: Error) => {
          return (
            err instanceof ResponseSizeExceededError &&
            err.message.includes('exceeded maximum allowed size')
          );
        },
      );
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
