/**
 * Provider-neutral deterministic test primitives for Node/Vitest suites.
 *
 * The harness deliberately has no network, clock mocking, or LLM SDK dependency.
 * Production code receives the Clock, IdGenerator, and provider interfaces through
 * its own ports; tests use the in-memory implementations exported here.
 */

export interface Clock {
  now(): Date;
  nowMs(): number;
}

export interface FakeClock extends Clock {
  set(value: Date | string | number): void;
  advance(milliseconds: number): void;
  reset(): void;
}

function toEpochMilliseconds(value: Date | string | number): number {
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError(`Invalid clock value: ${String(value)}`);
  }
  return milliseconds;
}

export function createFakeClock(initial: Date | string | number): FakeClock {
  const initialMilliseconds = toEpochMilliseconds(initial);
  let currentMilliseconds = initialMilliseconds;

  return {
    now: () => new Date(currentMilliseconds),
    nowMs: () => currentMilliseconds,
    set: (value) => {
      currentMilliseconds = toEpochMilliseconds(value);
    },
    advance: (milliseconds) => {
      if (!Number.isFinite(milliseconds)) {
        throw new RangeError(`Invalid clock advance: ${String(milliseconds)}`);
      }
      currentMilliseconds += milliseconds;
    },
    reset: () => {
      currentMilliseconds = initialMilliseconds;
    },
  };
}

export interface IdGenerator {
  next(namespace?: string): string;
  reset(): void;
  readonly count: number;
}

export interface IdGeneratorOptions {
  prefix?: string;
  seed?: string;
  startAt?: number;
}

function cleanLabel(value: string, name: string): string {
  const cleaned = value.trim();
  if (cleaned.length === 0 || !/^[A-Za-z0-9_-]+$/.test(cleaned)) {
    throw new TypeError(`${name} must contain only letters, numbers, '_' or '-'`);
  }
  return cleaned;
}

export function createIdGenerator(options: IdGeneratorOptions | string = {}): IdGenerator {
  const normalized = typeof options === 'string' ? { seed: options } : options;
  const prefix = cleanLabel(normalized.prefix ?? 'id', 'prefix');
  const seed = normalized.seed === undefined ? undefined : cleanLabel(normalized.seed, 'seed');
  const startAt = normalized.startAt ?? 0;
  if (!Number.isInteger(startAt) || startAt < 0) {
    throw new RangeError('startAt must be a non-negative integer');
  }
  let count = startAt;

  return {
    next: (namespace = prefix) => {
      const label = cleanLabel(namespace, 'namespace');
      count += 1;
      return [label, seed, count]
        .filter((part): part is string | number => part !== undefined)
        .join('_');
    },
    reset: () => {
      count = startAt;
    },
    get count() {
      return count - startAt;
    },
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ChatRequest {
  messages?: readonly ChatMessage[];
  prompt?: string;
  model?: string;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  usage: ChatUsage;
}

export interface ChatProvider {
  complete(request: ChatRequest): Promise<ChatResponse>;
}

export interface FakeChatProvider extends ChatProvider {
  readonly calls: readonly ChatRequest[];
  reset(): void;
}

export interface FakeChatProviderOptions {
  response?: string;
  responses?: Readonly<Record<string, string>>;
  model?: string;
  failWith?: Error;
}

function chatInput(request: ChatRequest): string {
  if (request.prompt !== undefined) return request.prompt;
  return (request.messages ?? []).map(({ role, content }) => `${role}:${content}`).join('\n');
}

function tokenCount(value: string): number {
  const trimmed = value.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
}

export function createFakeChatProvider(options: FakeChatProviderOptions = {}): FakeChatProvider {
  const response = options.response ?? 'fake response';
  const responses = options.responses ?? {};
  const model = options.model ?? 'fake-chat-v1';
  const calls: ChatRequest[] = [];

  return {
    calls,
    complete: async (request) => {
      calls.push(structuredClone(request));
      if (options.failWith !== undefined) throw options.failWith;
      const input = chatInput(request);
      const content = responses[input] ?? response;
      return {
        content,
        model,
        usage: {
          inputTokens: tokenCount(input),
          outputTokens: tokenCount(content),
          totalTokens: tokenCount(input) + tokenCount(content),
        },
      };
    },
    reset: () => {
      calls.length = 0;
    },
  };
}

export interface EmbeddingProvider {
  embed(input: string): Promise<readonly number[]>;
  embedMany(inputs: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface FakeEmbeddingProvider extends EmbeddingProvider {
  readonly calls: readonly string[];
  reset(): void;
}

export interface FakeEmbeddingProviderOptions {
  dimensions?: number;
  failWith?: Error;
}

function hash(input: string, index: number): number {
  let value = (2166136261 ^ index) >>> 0;
  for (let offset = 0; offset < input.length; offset += 1) {
    value ^= input.charCodeAt(offset);
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value;
}

function deterministicVector(input: string, dimensions: number): readonly number[] {
  return Array.from(
    { length: dimensions },
    (_, index) => (hash(input, index) / 0xffffffff) * 2 - 1,
  );
}

export function createFakeEmbeddingProvider(
  options: FakeEmbeddingProviderOptions = {},
): FakeEmbeddingProvider {
  const dimensions = options.dimensions ?? 8;
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new RangeError('dimensions must be a positive integer');
  }
  const calls: string[] = [];
  const embed = async (input: string): Promise<readonly number[]> => {
    calls.push(input);
    if (options.failWith !== undefined) throw options.failWith;
    return deterministicVector(input, dimensions);
  };

  return {
    calls,
    embed,
    embedMany: async (inputs) => {
      const result: (readonly number[])[] = [];
      for (const input of inputs) result.push(await embed(input));
      return result;
    },
    reset: () => {
      calls.length = 0;
    },
  };
}

export type FixtureRightsReview = 'approved' | 'pending' | 'restricted' | 'rejected';
export type RedactionStatus = 'not_required' | 'redacted';

export interface FixtureProvenance {
  acquiredAt: string;
  sourceUrl: string;
  rightsReview: FixtureRightsReview;
}

export interface RedactionMetadata {
  status: RedactionStatus;
  fields: readonly string[];
  reason: string;
  reviewedAt: string;
}
export type FixtureProvenanceMetadata = FixtureProvenance;

export type FixtureRedactionMetadata = RedactionMetadata;

export interface FixtureMetadata {
  provenance: FixtureProvenance;
  redaction: RedactionMetadata;
}

export interface Fixture<T> {
  id: string;
  payload: T;
  metadata: FixtureMetadata;
}

export class FixtureValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid fixture metadata: ${issues.join('; ')}`);
    this.name = 'FixtureValidationError';
    this.issues = issues;
  }
}

const rightsReviews: Record<FixtureRightsReview, true> = {
  approved: true,
  pending: true,
  restricted: true,
  rejected: true,
};
const fixtureMetadataKeys: Record<string, true> = {
  provenance: true,
  redaction: true,
};
const provenanceKeys: Record<string, true> = {
  acquiredAt: true,
  sourceUrl: true,
  rightsReview: true,
};
const redactionKeys: Record<string, true> = {
  status: true,
  fields: true,
  reason: true,
  reviewedAt: true,
};

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: Record<string, true>,
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(value)) {
    if (allowedKeys[key] !== true) issues.push(`${path}.${key} is not allowed`);
  }
}
const redactionStatuses: Record<RedactionStatus, true> = {
  not_required: true,
  redacted: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoUtc(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateFixtureMetadata(value: unknown): asserts value is FixtureMetadata {
  const issues: string[] = [];
  if (!isRecord(value)) {
    throw new FixtureValidationError(['metadata must be an object']);
  }
  rejectUnknownKeys(value, fixtureMetadataKeys, 'metadata', issues);
  const provenance = value['provenance'];
  const redaction = value['redaction'];
  if (!isRecord(provenance)) {
    issues.push('provenance is required');
  } else {
    rejectUnknownKeys(provenance, provenanceKeys, 'provenance', issues);
    if (!isIsoUtc(provenance['acquiredAt']))
      issues.push('provenance.acquiredAt must be an ISO UTC timestamp');
    if (!isHttpUrl(provenance['sourceUrl']))
      issues.push('provenance.sourceUrl must be an HTTP(S) URL');
    if (
      typeof provenance['rightsReview'] !== 'string' ||
      rightsReviews[provenance['rightsReview'] as FixtureRightsReview] !== true
    ) {
      issues.push('provenance.rightsReview is invalid');
    }
  }
  if (!isRecord(redaction)) {
    issues.push('redaction metadata is required');
  } else {
    rejectUnknownKeys(redaction, redactionKeys, 'redaction', issues);
    const status = redaction['status'];
    const fields = redaction['fields'];
    if (typeof status !== 'string' || redactionStatuses[status as RedactionStatus] !== true) {
      issues.push('redaction.status is invalid');
    }
    if (
      !Array.isArray(fields) ||
      fields.some((field) => typeof field !== 'string' || field.trim().length === 0)
    ) {
      issues.push('redaction.fields must be an array of non-empty strings');
    }
    if (typeof redaction['reason'] !== 'string' || redaction['reason'].trim().length === 0) {
      issues.push('redaction.reason is required');
    }
    if (!isIsoUtc(redaction['reviewedAt']))
      issues.push('redaction.reviewedAt must be an ISO UTC timestamp');
    if (status === 'redacted' && (!Array.isArray(fields) || fields.length === 0)) {
      issues.push('redacted fixtures must list at least one field');
    }
    if (status === 'not_required' && Array.isArray(fields) && fields.length > 0) {
      issues.push('not_required fixtures cannot list redacted fields');
    }
  }
  if (issues.length > 0) throw new FixtureValidationError(issues);
}

export function parseFixtureMetadata(value: unknown): FixtureMetadata {
  validateFixtureMetadata(value);
  return structuredClone(value);
}

export interface FixtureBuilderOptions<T> {
  id: string;
  payload: T;
  provenance: FixtureProvenance;
  redaction: RedactionMetadata;
}

export function buildFixture<T>(options: FixtureBuilderOptions<T>): Fixture<T> {
  if (options.id.trim().length === 0) throw new TypeError('fixture id is required');
  const metadata = parseFixtureMetadata({
    provenance: options.provenance,
    redaction: options.redaction,
  });
  return { id: options.id, payload: options.payload, metadata };
}

export const createFixture = buildFixture;

export interface Resettable {
  reset(): void;
}

export function resetAll(...targets: readonly Resettable[]): void {
  for (const target of targets) target.reset();
}

export interface TestHarness {
  readonly clock: FakeClock;
  readonly ids: IdGenerator;
  readonly chat: FakeChatProvider;
  readonly embedding: FakeEmbeddingProvider;
  reset(): void;
}

export interface TestHarnessOptions {
  now?: Date | string | number;
  id?: IdGeneratorOptions | string;
  chat?: FakeChatProviderOptions;
  embedding?: FakeEmbeddingProviderOptions;
}

export function createTestHarness(options: TestHarnessOptions = {}): TestHarness {
  const clock = createFakeClock(options.now ?? '2026-01-01T00:00:00.000Z');
  const ids = createIdGenerator(options.id);
  const chat = createFakeChatProvider(options.chat);
  const embedding = createFakeEmbeddingProvider(options.embedding);
  return {
    clock,
    ids,
    chat,
    embedding,
    reset: () => {
      resetAll(clock, ids, chat, embedding);
    },
  };
}
