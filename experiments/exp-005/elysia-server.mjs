// EXP-005: Elysia on Node runtime. One schema -> runtime validation + OpenAPI.
// Disposable spike code.
import { Elysia, t } from 'elysia';
import { node } from '@elysiajs/node';
import { openapi } from '@elysiajs/openapi';

// --- single schema source -------------------------------------------------
const TimeRange = t.Object({
  from: t.String({ format: 'date-time' }),
  to: t.String({ format: 'date-time' }),
});

const AnswerRequest = t.Object({
  question: t.String({ minLength: 1, maxLength: 2000 }),
  timeRange: t.Optional(TimeRange),
  timezone: t.Optional(t.String()),
  language: t.Optional(t.Union([t.Literal('ko'), t.Literal('en')])),
});

const Citation = t.Object({
  id: t.String(),
  title: t.String(),
  source: t.String(),
  url: t.String(),
  publishedAt: t.Union([t.String(), t.Null()]),
  excerptIsVerbatim: t.Boolean(),
});

const AnswerResponse = t.Object({
  requestId: t.String(),
  status: t.Union([
    t.Literal('answered'),
    t.Literal('insufficient_evidence'),
    t.Literal('unsupported_intent'),
  ]),
  intent: t.String(),
  answer: t.Union([t.String(), t.Null()]),
  observations: t.Array(t.Object({ metric: t.String(), unit: t.String(), value: t.Number() })),
  citations: t.Array(Citation),
});
// -------------------------------------------------------------------------

const port = Number(process.env.PORT || 0);
// STRICT=1 disables Elysia's normalize so unknown fields error instead of being stripped.
const STRICT = process.env.STRICT === '1';

const app = new Elysia(STRICT ? { adapter: node(), normalize: false } : { adapter: node() })
  .use(openapi())
  .get('/health/live', () => ({ status: 'ok' }))
  .post(
    '/api/v1/answers',
    ({ body }) => ({
      requestId: 'req_stub',
      status: 'answered',
      intent: 'trend_summary',
      answer: `stub for: ${body.question}`,
      observations: [{ metric: 'release_activity', unit: 'releases', value: 3 }],
      citations: [
        {
          id: 'C1',
          title: 'Chrome 152',
          source: 'chrome_release_notes',
          url: 'https://developer.chrome.com/release-notes/152',
          publishedAt: '2026-08-25T00:00:00Z',
          excerptIsVerbatim: true,
        },
      ],
    }),
    { body: AnswerRequest, response: AnswerResponse },
  )
  // leak probe: handler returns an internal field that is NOT in the schema
  .post(
    '/api/v1/answers-leak',
    () => ({
      requestId: 'req_leak',
      status: 'answered',
      intent: 'trend_summary',
      answer: 'x',
      observations: [],
      citations: [],
      _internalScore: 0.9137,
      _chunkText: 'raw chunk text that must not leak',
    }),
    { response: AnswerResponse },
  )
  // strict variant: does additionalProperties:false reject unknown request fields?
  .post(
    '/api/v1/answers-strict',
    () => ({
      requestId: 'req_strict',
      status: 'answered',
      intent: 'trend_summary',
      answer: 'x',
      observations: [],
      citations: [],
    }),
    {
      body: t.Object(
        { question: t.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      response: AnswerResponse,
    },
  )
  .listen(port, (server) => {
    console.log(`READY ${server?.port ?? port}`);
  });

export default app;
