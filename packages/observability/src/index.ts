/** Deterministic structured logging and correlation primitives for TechPulse services. */

export const STRUCTURED_EVENT_SCHEMA_VERSION = 1 as const;
export const REDACTED_VALUE = '[REDACTED]' as const;

const CORRELATION_KEYS = ['requestId', 'runId', 'jobId', 'sourceId', 'queryId'] as const;
type CorrelationKey = (typeof CORRELATION_KEYS)[number];

const SENSITIVE_KEY_PATTERN = /(token|cookie|authorization|secret|payload)/iu;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface CorrelationContext {
  readonly requestId?: string;
  readonly runId?: string;
  readonly jobId?: string;
  readonly sourceId?: string;
  readonly queryId?: string;
}

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };
export type EventFields = Readonly<Record<string, unknown>>;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface StructuredEvent {
  readonly schemaVersion: typeof STRUCTURED_EVENT_SCHEMA_VERSION;
  readonly event: string;
  readonly level: LogLevel;
  readonly service: string;
  readonly timestamp?: string;
  readonly requestId?: string;
  readonly runId?: string;
  readonly jobId?: string;
  readonly sourceId?: string;
  readonly queryId?: string;
  readonly data?: JsonObject;
}

export interface StructuredEventInput {
  readonly event: string;
  readonly service: string;
  readonly level?: LogLevel;
  readonly context?: CorrelationContext;
  readonly fields?: EventFields;
  readonly timestamp?: string;
}

export interface StructuredLoggerOptions {
  readonly service: string;
  readonly context?: CorrelationContext;
  readonly sink?: LogSink;
  /** Optional injected timestamp source; no clock is read by default. */
  readonly clock?: () => string;
}

export type LogSink = (line: string, event: StructuredEvent) => void;
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** IDs are opaque, bounded strings; generation belongs to the caller. */
export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_ID_PATTERN.test(value);
}

/** Invalid, absent, or non-object values are ignored instead of propagated. */
export function normalizeCorrelationContext(input: unknown): CorrelationContext {
  if (!isRecord(input)) return {};

  const context: Partial<Record<CorrelationKey, string>> = {};
  for (const key of CORRELATION_KEYS) {
    const value = input[key];
    if (isValidCorrelationId(value)) context[key] = value;
  }
  return context;
}

/** Merge is deterministic: later valid values win; invalid values never erase valid context. */
export function mergeCorrelationContext(...contexts: readonly unknown[]): CorrelationContext {
  const merged: Partial<Record<CorrelationKey, string>> = {};
  for (const context of contexts) Object.assign(merged, normalizeCorrelationContext(context));
  return merged;
}

interface HeaderSource {
  get(name: string): string | null;
}

function headerValue(
  headers: HeaderSource | Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): string | undefined {
  if ('get' in headers && typeof headers.get === 'function') {
    for (const name of names) {
      const value = headers.get(name);
      if (isValidCorrelationId(value)) return value;
    }
    return undefined;
  }

  const entries = Object.entries(headers);
  for (const name of names) {
    const lowerName = name.toLowerCase();
    const entry = entries.find(([key]) => key.toLowerCase() === lowerName);
    if (entry && isValidCorrelationId(entry[1])) return entry[1];
  }
  return undefined;
}

/** Read standard inbound headers without trusting malformed values. */
export function correlationContextFromHeaders(
  headers: HeaderSource | Readonly<Record<string, string | undefined>>,
): CorrelationContext {
  return normalizeCorrelationContext({
    requestId: headerValue(headers, ['x-request-id', 'request-id']),
    runId: headerValue(headers, ['x-run-id', 'x-query-run-id', 'x-collection-run-id']),
    jobId: headerValue(headers, ['x-job-id']),
    sourceId: headerValue(headers, ['x-source-id']),
    queryId: headerValue(headers, ['x-query-id']),
  });
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function jsonSafe(value: unknown, seen: Set<object>): JsonValue | undefined {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol')
    return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();

  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const output: JsonValue[] = [];
    for (const item of value) output.push(jsonSafe(item, seen) ?? null);
    seen.delete(value);
    return output;
  }

  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      output[key] = REDACTED_VALUE;
      continue;
    }
    const safeItem = jsonSafe(item, seen);
    if (safeItem !== undefined) output[key] = safeItem;
  }
  seen.delete(value);
  return output;
}

/** Deeply redact sensitive fields and make arbitrary input JSON-safe without mutation. */
export function redact(value: unknown): JsonValue | undefined {
  return jsonSafe(value, new Set<object>());
}

function eventData(fields: EventFields): JsonObject | undefined {
  const safe = redact(fields);
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) return undefined;
  const object = safe as JsonObject;
  return Object.keys(object).length > 0 ? object : undefined;
}

export function createStructuredEvent(input: StructuredEventInput): StructuredEvent {
  const event = input.event.trim();
  const service = input.service.trim();
  if (event.length === 0) throw new Error('Structured event name is required');
  if (service.length === 0) throw new Error('Structured event service is required');

  const context = normalizeCorrelationContext(input.context);
  const data = input.fields === undefined ? undefined : eventData(input.fields);
  return {
    schemaVersion: STRUCTURED_EVENT_SCHEMA_VERSION,
    event,
    level: input.level ?? 'info',
    service,
    ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
    ...context,
    ...(data === undefined ? {} : { data }),
  };
}

/** Serialize only the schema-shaped event; this is safe for BigInt, cycles, and undefined fields. */
export function serializeStructuredEvent(event: StructuredEvent): string {
  const safe = redact(event);
  const serialized = JSON.stringify(safe ?? {});
  return serialized ?? '{}';
}

export class StructuredLogger {
  readonly service: string;
  readonly context: CorrelationContext;
  private readonly sink: LogSink;
  private readonly clock: () => string;

  constructor(options: StructuredLoggerOptions) {
    const service = options.service.trim();
    if (service.length === 0) throw new Error('Structured logger service is required');
    this.service = service;
    this.context = normalizeCorrelationContext(options.context);
    this.sink = options.sink ?? ((line) => console.log(line));
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  withContext(context: unknown): StructuredLogger {
    return new StructuredLogger({
      service: this.service,
      context: mergeCorrelationContext(this.context, context),
      sink: this.sink,
      clock: this.clock,
    });
  }

  emit(level: LogLevel, event: string, fields: EventFields = {}): StructuredEvent {
    const structuredEvent = createStructuredEvent({
      event,
      service: this.service,
      level,
      context: this.context,
      fields,
      timestamp: this.clock(),
    });
    this.sink(serializeStructuredEvent(structuredEvent), structuredEvent);
    return structuredEvent;
  }

  debug(event: string, fields?: EventFields): StructuredEvent {
    return this.emit('debug', event, fields);
  }

  info(event: string, fields?: EventFields): StructuredEvent {
    return this.emit('info', event, fields);
  }

  warn(event: string, fields?: EventFields): StructuredEvent {
    return this.emit('warn', event, fields);
  }

  error(event: string, fields?: EventFields): StructuredEvent {
    return this.emit('error', event, fields);
  }
}

export function createStructuredLogger(options: StructuredLoggerOptions): StructuredLogger {
  return new StructuredLogger(options);
}

export * from './metrics.js';
export * from './alerts.js';
export * from './dashboard.js';
