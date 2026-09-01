# TechPulse test harness

`@techpulse/test-harness` contains provider-neutral deterministic test seams for Node unit and component tests. It does not import a provider SDK, access the network, patch global time, or use random values.

## Node/Vitest usage

Run the focused harness suite from the repository root:

```sh
pnpm --dir tooling/test-harness test
```

Typecheck and lint the harness with:

```sh
pnpm --dir tooling/test-harness typecheck
pnpm --dir tooling/test-harness lint
pnpm --dir tooling/test-harness format
```

Inject the seams into the code under test instead of using real time or a provider:

```ts
import { buildFixture, createTestHarness } from '@techpulse/test-harness';

const harness = createTestHarness({
  now: '2026-09-01T03:00:00.000Z',
  id: { prefix: 'request', seed: 'unit' },
  chat: { response: 'deterministic answer' },
  embedding: { dimensions: 4 },
});

const createdAt = harness.clock.now().toISOString();
const requestId = harness.ids.next();
const answer = await harness.chat.complete({ prompt: 'offline prompt' });
const vector = await harness.embedding.embed('offline input');

// beforeEach/afterEach may call reset() to reuse one harness safely.
harness.reset();
```

## Fixture metadata

Fixtures are built only with provenance and redaction metadata. Provenance requires an ISO UTC acquisition timestamp, an HTTP(S) source URL, and a rights-review status. Redaction metadata requires a review timestamp and reason; `redacted` fixtures list one or more removed fields, while `not_required` fixtures list none.

```ts
const fixture = buildFixture({
  id: 'github-release-1',
  payload: { tag_name: 'v1.2.3' },
  provenance: {
    acquiredAt: '2026-09-01T00:00:00.000Z',
    sourceUrl: 'https://api.github.com/repos/example/project/releases/1',
    rightsReview: 'approved',
  },
  redaction: {
    status: 'not_required',
    fields: [],
    reason: 'No personal or secret data in this fixture.',
    reviewedAt: '2026-09-01T00:00:00.000Z',
  },
});
```

`parseFixtureMetadata` and `validateFixtureMetadata` reject malformed metadata before a fixture reaches a collector or component test. Keep fixture payloads minimal and redacted; never commit secrets, cookies, tokens, or unreviewed raw pages.
