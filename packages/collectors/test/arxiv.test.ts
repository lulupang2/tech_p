import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { ArxivCollector, extractArxivId, formatArxivDate, parseArxivFeed } from '../src/index.js';
import type { CollectionContext } from '@techpulse/domain';

// Realistic sample Atom feed fixture representing multi-version papers with metadata and PDF links
const SAMPLE_ARXIV_XML_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <link href="http://export.arxiv.org/api/query?search_query=cat:cs.IR&amp;start=0&amp;max_results=2" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query: search_query=cat:cs.IR&amp;start=0&amp;max_results=2</title>
  <id>http://arxiv.org/api/abc123xyz</id>
  <updated>2026-09-01T00:00:00Z</updated>
  <opensearch:totalResults>100</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>2</opensearch:itemsPerPage>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v2</id>
    <updated>2024-01-20T14:32:00Z</updated>
    <published>2024-01-15T09:15:00Z</published>
    <title>High-Performance Vector Search with Hybrid Graph Indexing &amp; Filtering</title>
    <summary>
      We present a novel graph-based indexing algorithm for nearest neighbor search.
      This abstract spans multiple lines and contains &lt;b&gt;no fulltext&lt;/b&gt; markup.
    </summary>
    <author>
      <name>Alice Smith</name>
      <arxiv:affiliation>MIT CSAIL</arxiv:affiliation>
    </author>
    <author>
      <name>Bob Jones</name>
    </author>
    <arxiv:doi>10.1145/1234567.890</arxiv:doi>
    <arxiv:comment>12 pages, 6 figures, accepted at SIGIR 2024</arxiv:comment>
    <arxiv:journal_ref>ACM SIGIR 2024</arxiv:journal_ref>
    <link href="http://arxiv.org/abs/2401.12345v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2401.12345v2" rel="related" type="application/pdf"/>
    <arxiv:primary_category term="cs.IR" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.IR" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.99999v1</id>
    <updated>2024-01-18T10:00:00Z</updated>
    <published>2024-01-18T10:00:00Z</published>
    <title>Scalable RAG Architecture with Minimal Memory Footprint</title>
    <summary>An evaluation of retrieval-augmented generation under bounded memory constraints.</summary>
    <author>
      <name>Carol White</name>
    </author>
    <link href="http://arxiv.org/abs/2401.99999v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2401.99999v1" rel="related" type="application/pdf"/>
    <arxiv:primary_category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

const EMPTY_ARXIV_XML_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>0</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>25</opensearch:itemsPerPage>
</feed>`;

describe('COL-006 arXiv Collector Adapter & Contract Tests', () => {
  describe('Helper & Parser Tests', () => {
    test('extractArxivId preserves version suffix v1/v2 across URL formats', () => {
      assert.equal(extractArxivId('http://arxiv.org/abs/2401.12345v2'), '2401.12345v2');
      assert.equal(extractArxivId('https://arxiv.org/abs/2401.12345v1'), '2401.12345v1');
      assert.equal(extractArxivId('http://arxiv.org/abs/cs/0101001v3'), 'cs/0101001v3');
      assert.equal(extractArxivId('2401.12345v2'), '2401.12345v2');
    });

    test('formatArxivDate formats UTC timestamp to YYYYMMDDHHMMSS', () => {
      const date = new Date('2026-09-02T03:04:05.000Z');
      assert.equal(formatArxivDate(date), '20260902030405');
    });

    test('parseArxivFeed extracts entries and metadata while omitting PDF/fulltext links and sanitizing HTML', () => {
      const feed = parseArxivFeed(SAMPLE_ARXIV_XML_FEED);
      assert.equal(feed.totalResults, 100);
      assert.equal(feed.startIndex, 0);
      assert.equal(feed.itemsPerPage, 2);
      assert.equal(feed.entries.length, 2);

      const [entry1, entry2] = feed.entries;
      assert(entry1);
      assert(entry2);

      // Entry 1 validations
      assert.equal(entry1.arxivId, '2401.12345v2');
      assert.equal(
        entry1.title,
        'High-Performance Vector Search with Hybrid Graph Indexing & Filtering',
      );
      assert(entry1.summary.startsWith('We present a novel graph-based indexing algorithm'));
      assert(!entry1.summary.includes('<b>'));
      assert(!entry1.summary.includes('</b>'));
      assert(!entry1.summary.includes('&lt;'));
      assert.equal(
        entry1.summary,
        'We present a novel graph-based indexing algorithm for nearest neighbor search. This abstract spans multiple lines and contains no fulltext markup.',
      );
      assert.equal(entry1.published, '2024-01-15T09:15:00Z');
      assert.equal(entry1.updated, '2024-01-20T14:32:00Z');
      assert.deepEqual(entry1.authors, [{ name: 'Alice Smith' }, { name: 'Bob Jones' }]);
      assert.equal(entry1.primaryCategory, 'cs.IR');
      assert.deepEqual(entry1.categories, ['cs.IR', 'cs.AI']);
      assert.equal(entry1.doi, '10.1145/1234567.890');
      assert.equal(entry1.journalRef, 'ACM SIGIR 2024');
      assert.equal(entry1.comment, '12 pages, 6 figures, accepted at SIGIR 2024');
      assert.equal(entry1.canonicalUrl, 'http://arxiv.org/abs/2401.12345v2');

      // Entry 2 validations
      assert.equal(entry2.arxivId, '2401.99999v1');
      assert.equal(entry2.published, '2024-01-18T10:00:00Z');
      assert.equal(entry2.updated, '2024-01-18T10:00:00Z');
    });
  });

  describe('Contract Integrity & Data Invariants (SOURCE_CATALOG.md §5, SECURITY.md §8)', () => {
    test('collector transforms feed into CollectedRawItems with v1/v2 preservation, published/updated separation, and no PDF links', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(SAMPLE_ARXIV_XML_FEED, {
          status: 200,
          headers: { 'Content-Type': 'application/atom+xml' },
        });
      };

      const collector = new ArxivCollector({ fetch: mockFetch });
      const context: CollectionContext = {
        sourceKey: 'arxiv',
        cursor: null,
      };

      const result = await collector.collect(context);

      assert.equal(result.sourceKey, 'arxiv');
      assert.equal(result.items.length, 2);
      assert.equal(result.hasMore, true);
      assert(result.nextCursor);
      assert.equal(result.metrics?.itemsFetched, 2);
      assert(result.metrics && result.metrics.bytesFetched > 0);

      // Item 1 verification
      const item1 = result.items[0]!;
      // 1. External ID preserves version suffix (v2)
      assert.equal(item1.externalId, '2401.12345v2');

      // 2. Published is mapped to publishedAt Date (v1 publication date)
      assert.deepEqual(item1.publishedAt, new Date('2024-01-15T09:15:00Z'));

      // 3. Updated date is preserved separately in metadata
      assert.equal(item1.metadata?.['updated'], '2024-01-20T14:32:00Z');
      assert.notEqual(
        item1.publishedAt?.toISOString(),
        item1.metadata?.['updated'],
        'publishedAt must reflect original publication date, while metadata holds updated timestamp',
      );

      // 4. Abstract/summary only is stored; PDF and fulltext links are NOT stored anywhere
      assert.equal(typeof item1.payload['summary'], 'string');
      assert((item1.payload['summary'] as string).includes('nearest neighbor search'));
      assert(!(item1.payload['summary'] as string).includes('<b>'));

      const payloadStr = JSON.stringify(item1.payload);
      const metadataStr = JSON.stringify(item1.metadata);
      assert(!payloadStr.includes('.pdf'), 'Payload must not contain PDF URLs or references');
      assert(!payloadStr.includes('application/pdf'), 'Payload must not contain PDF mime-types');
      assert(!metadataStr.includes('.pdf'), 'Metadata must not contain PDF URLs');

      // 5. PII stripped: authors only contain name (no affiliation or email)
      const authors = item1.payload['authors'] as Array<Record<string, unknown>>;
      assert.deepEqual(authors, [{ name: 'Alice Smith' }, { name: 'Bob Jones' }]);
      for (const author of authors) {
        assert.equal(author['affiliation'], undefined);
        assert.equal(author['email'], undefined);
      }

      // 6. SHA-256 raw hash integrity
      assert.equal(typeof item1.rawHash, 'string');
      assert.equal(item1.rawHash.length, 64);

      // Item 2 verification (v1 paper)
      const item2 = result.items[1]!;
      assert.equal(item2.externalId, '2401.99999v1');
      assert.deepEqual(item2.publishedAt, new Date('2024-01-18T10:00:00Z'));
    });
  });

  describe('Rate Limiting: 3-Second Request Spacing (SOURCE_CATALOG.md §5)', () => {
    test('enforces at least 3000ms delay between consecutive outbound fetch calls', async () => {
      let currentTime = 10000;
      const sleepDelays: number[] = [];
      let fetchCount = 0;

      const mockClock = () => currentTime;
      const mockSleep = async (ms: number) => {
        sleepDelays.push(ms);
        currentTime += ms;
      };

      const mockFetch: typeof fetch = async () => {
        fetchCount += 1;
        return new Response(SAMPLE_ARXIV_XML_FEED, { status: 200 });
      };

      const collector = new ArxivCollector({
        fetch: mockFetch,
        clock: mockClock,
        sleep: mockSleep,
        requestSpacingMs: 3000,
        cacheTtlMs: 0, // Disable cache to test raw request spacing
      });

      // First request: no prior request, executes immediately without sleep
      await collector.collect({
        sourceKey: 'arxiv',
        cursor: null,
      });

      assert.equal(fetchCount, 1);
      assert.equal(sleepDelays.length, 0);

      // Advance clock by only 1000ms (2000ms short of 3000ms requirement)
      currentTime += 1000;

      // Second request: should wait 2000ms
      await collector.collect({
        sourceKey: 'arxiv',
        cursor: null,
      });

      assert.equal(fetchCount, 2);
      assert.equal(sleepDelays.length, 1);
      assert.equal(sleepDelays[0], 2000);

      // Advance clock by 3500ms (exceeds 3000ms requirement)
      currentTime += 3500;

      // Third request: no sleep needed
      await collector.collect({
        sourceKey: 'arxiv',
        cursor: null,
      });

      assert.equal(fetchCount, 3);
      assert.equal(sleepDelays.length, 1);
    });
  });

  describe('Identical Query 1-Day Cache (SOURCE_CATALOG.md §5)', () => {
    test('serves repeated query from in-memory cache within 24 hours without network calls', async () => {
      let currentTime = 1000000;
      let fetchCount = 0;

      const mockFetch: typeof fetch = async () => {
        fetchCount += 1;
        return new Response(SAMPLE_ARXIV_XML_FEED, { status: 200 });
      };

      const collector = new ArxivCollector({
        fetch: mockFetch,
        clock: () => currentTime,
        cacheTtlMs: 24 * 60 * 60 * 1000,
      });

      const context: CollectionContext = {
        sourceKey: 'arxiv',
        cursor: null,
      };

      // 1. Initial collection: cache miss -> fetches from network
      const result1 = await collector.collect(context);
      assert.equal(fetchCount, 1);
      assert.equal(result1.items.length, 2);
      assert(result1.metrics && result1.metrics.bytesFetched > 0);

      // 2. Immediate identical request (1 hour later): cache hit -> 0 network fetches, 0 bytes fetched
      currentTime += 60 * 60 * 1000;
      const result2 = await collector.collect(context);
      assert.equal(fetchCount, 1, 'Should NOT trigger fetch on cache hit');
      assert.equal(result2.items.length, 2);
      assert.equal(result2.metrics?.bytesFetched, 0);

      // 3. Request 23.5 hours later: still in 1-day cache
      currentTime += 22.5 * 60 * 60 * 1000;
      const result3 = await collector.collect(context);
      assert.equal(fetchCount, 1);
      assert.equal(result3.items.length, 2);

      // 4. Request 24 hours and 1 millisecond after initial: cache expired -> network fetch
      currentTime += 3600 * 1000;
      const result4 = await collector.collect(context);
      assert.equal(fetchCount, 2, 'Should trigger network fetch after 24 hours');
      assert.equal(result4.items.length, 2);
    });
  });

  describe('Single Connection & Concurrency Serialization', () => {
    test('serializes concurrent requests ensuring no simultaneous network calls and respecting spacing', async () => {
      let currentTime = 1000;
      let activeConnections = 0;
      let maxSimultaneousConnections = 0;
      const sleepEvents: number[] = [];
      const startTimes: number[] = [];

      const mockClock = () => currentTime;
      const mockSleep = async (ms: number) => {
        sleepEvents.push(ms);
        currentTime += ms;
      };

      const mockFetch: typeof fetch = async () => {
        startTimes.push(currentTime);
        activeConnections += 1;
        maxSimultaneousConnections = Math.max(maxSimultaneousConnections, activeConnections);
        // Simulate small network latency
        currentTime += 10;
        activeConnections -= 1;
        return new Response(SAMPLE_ARXIV_XML_FEED, { status: 200 });
      };

      const collector = new ArxivCollector({
        fetch: mockFetch,
        clock: mockClock,
        sleep: mockSleep,
        requestSpacingMs: 3000,
        cacheTtlMs: 0, // Bypass cache to test connection locking
      });

      // Launch 3 concurrent requests simultaneously
      const results = await Promise.all([
        collector.collect({ sourceKey: 'arxiv', cursor: null, limit: 10 }),
        collector.collect({ sourceKey: 'arxiv', cursor: null, limit: 20 }),
        collector.collect({ sourceKey: 'arxiv', cursor: null, limit: 30 }),
      ]);

      assert.equal(results.length, 3);
      assert.equal(
        maxSimultaneousConnections,
        1,
        'Max simultaneous connection must be 1 (serialized)',
      );
      // Invariant: consecutive outbound request starts must be separated by >= 3000ms
      assert.equal(startTimes.length, 3);
      assert(
        startTimes[1]! - startTimes[0]! >= 3000,
        'Request 2 start must be >=3000ms after Request 1 start',
      );
      assert(
        startTimes[2]! - startTimes[1]! >= 3000,
        'Request 3 start must be >=3000ms after Request 2 start',
      );
      // Requests 2 and 3 should have waited 2990ms (3000ms spacing minus 10ms fetch latency)
      assert.equal(sleepEvents.length, 2);
      assert.equal(sleepEvents[0], 2990);
      assert.equal(sleepEvents[1], 2990);
    });

    test('deduplicates concurrent requests with identical query through lock + cache check', async () => {
      let fetchCount = 0;

      const mockFetch: typeof fetch = async () => {
        fetchCount += 1;
        return new Response(SAMPLE_ARXIV_XML_FEED, { status: 200 });
      };

      const collector = new ArxivCollector({
        fetch: mockFetch,
        requestSpacingMs: 3000,
        cacheTtlMs: 24 * 60 * 60 * 1000,
      });

      // Dispatch two simultaneous calls for the exact same query
      const [res1, res2] = await Promise.all([
        collector.collect({ sourceKey: 'arxiv', cursor: null }),
        collector.collect({ sourceKey: 'arxiv', cursor: null }),
      ]);

      assert.equal(fetchCount, 1, 'Concurrent identical calls must only execute one HTTP request');
      assert.equal(res1.items.length, 2);
      assert.equal(res2.items.length, 2);
    });
  });

  describe('Cursor Pagination & Time Window Support', () => {
    test('paginates using opaque cursor with correct next offset', async () => {
      let fetchedUrl = '';
      const mockFetch: typeof fetch = async (url) => {
        fetchedUrl = String(url);
        return new Response(SAMPLE_ARXIV_XML_FEED, { status: 200 });
      };

      const collector = new ArxivCollector({ fetch: mockFetch });

      // First step: start=0
      const res1 = await collector.collect({
        sourceKey: 'arxiv',
        cursor: null,
      });

      assert(fetchedUrl.includes('start=0'));
      assert.equal(res1.hasMore, true);
      assert(res1.nextCursor);

      // Second step: pass cursor -> start=2
      const res2 = await collector.collect({
        sourceKey: 'arxiv',
        cursor: res1.nextCursor,
      });

      assert(fetchedUrl.includes('start=2'));
      assert.equal(res2.items.length, 2);
    });

    test('handles empty feed with hasMore=false and nextCursor=null', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(EMPTY_ARXIV_XML_FEED, { status: 200 });
      };

      const collector = new ArxivCollector({ fetch: mockFetch });
      const res = await collector.collect({
        sourceKey: 'arxiv',
        cursor: null,
      });

      assert.equal(res.items.length, 0);
      assert.equal(res.hasMore, false);
      assert.equal(res.nextCursor, null);
    });

    test('constructs submittedDate filter when timeWindow is provided', async () => {
      let fetchedUrl = '';
      const mockFetch: typeof fetch = async (url) => {
        fetchedUrl = String(url);
        return new Response(SAMPLE_ARXIV_XML_FEED, { status: 200 });
      };

      const collector = new ArxivCollector({ fetch: mockFetch });
      await collector.collect({
        sourceKey: 'arxiv',
        cursor: null,
        timeWindow: {
          from: new Date('2026-09-01T00:00:00Z'),
          to: new Date('2026-09-02T00:00:00Z'),
        },
      });

      assert(
        fetchedUrl.includes('submittedDate%3A%5B20260901000000+TO+20260902000000%5D') ||
          fetchedUrl.includes('submittedDate:[20260901000000 TO 20260902000000]'),
      );
    });
  });

  describe('SSRF Guard & Policy Restrictions', () => {
    test('rejects baseUrl pointing to forbidden host or IP address', async () => {
      const collector = new ArxivCollector({
        baseUrl: 'http://169.254.169.254/latest/meta-data',
      });

      await assert.rejects(
        async () => {
          await collector.collect({ sourceKey: 'arxiv', cursor: null });
        },
        (err: Error) => {
          return err.message.includes('forbidden internal or private network address');
        },
      );
    });
  });
});
