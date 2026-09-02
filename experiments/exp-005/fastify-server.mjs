// EXP-005: Fastify + TypeBox type provider. Same contract as elysia-server.mjs.
// Disposable spike code.
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { Type } from '@sinclair/typebox';

// --- single schema source -------------------------------------------------
const TimeRange = Type.Object({
  from: Type.String({ format: 'date-time' }),
  to: Type.String({ format: 'date-time' }),
});

const AnswerRequest = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 2000 }),
  timeRange: Type.Optional(TimeRange),
  timezone: Type.Optional(Type.String()),
  language: Type.Optional(Type.Union([Type.Literal('ko'), Type.Literal('en')])),
});

const Citation = Type.Object({
  id: Type.String(),
  title: Type.String(),
  source: Type.String(),
  url: Type.String(),
  publishedAt: Type.Union([Type.String(), Type.Null()]),
  excerptIsVerbatim: Type.Boolean(),
});

const AnswerResponse = Type.Object({
  requestId: Type.String(),
  status: Type.Union([
    Type.Literal('answered'),
    Type.Literal('insufficient_evidence'),
    Type.Literal('unsupported_intent'),
  ]),
  intent: Type.String(),
  answer: Type.Union([Type.String(), Type.Null()]),
  observations: Type.Array(Type.Object({ metric: Type.String(), unit: Type.String(), value: Type.Number() })),
  citations: Type.Array(Citation),
});
// -------------------------------------------------------------------------

// STRICT=1 turns off ajv's removeAdditional so unknown fields error instead of being stripped.
const STRICT = process.env.STRICT === '1';
const app = Fastify(
  STRICT
    ? { logger: false, ajv: { customOptions: { removeAdditional: false } } }
    : { logger: false },
);
await app.register(swagger, {
  openapi: { info: { title: 'Signal Archive spike', version: '0.0.0' } },
});

app.get('/health/live', async () => ({ status: 'ok' }));

app.post('/api/v1/answers', {
  schema: { body: AnswerRequest, response: { 200: AnswerResponse } },
}, async (req) => ({
  requestId: 'req_stub',
  status: 'answered',
  intent: 'trend_summary',
  answer: `stub for: ${req.body.question}`,
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
}));

// leak probe: handler returns internal fields NOT in the response schema
app.post('/api/v1/answers-leak', {
  schema: { response: { 200: AnswerResponse } },
}, async () => ({
  requestId: 'req_leak',
  status: 'answered',
  intent: 'trend_summary',
  answer: 'x',
  observations: [],
  citations: [],
  _internalScore: 0.9137,
  _chunkText: 'raw chunk text that must not leak',
}));

// strict variant: does additionalProperties:false reject unknown request fields?
app.post('/api/v1/answers-strict', {
  schema: {
    body: Type.Object({ question: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    response: { 200: AnswerResponse },
  },
}, async () => ({
  requestId: 'req_strict',
  status: 'answered',
  intent: 'trend_summary',
  answer: 'x',
  observations: [],
  citations: [],
}));

// serving the OpenAPI document requires an explicit route (or @fastify/swagger-ui)
app.get('/openapi.json', async () => app.swagger());

const address = await app.listen({ port: Number(process.env.PORT || 0), host: '127.0.0.1' });
const port = new URL(address).port;
console.log(`READY ${port}`);
