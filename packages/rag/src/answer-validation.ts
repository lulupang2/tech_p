import type { ResolvedTimeRange } from '@techpulse/contracts';
import type { ResolvedContextChunk } from './answer-service.js';

export interface AnswerValidationResult {
  readonly valid: boolean;
  readonly citedKeys: readonly string[];
  readonly reasons: readonly string[];
}

export interface ParsedAnswerContent {
  readonly answer: string;
  readonly structured: boolean;
}

/**
 * Approved chat adapters may enforce JSON-object output. Normalize that transport
 * representation to the user-facing answer while keeping plain-text test/provider
 * ports compatible.
 */
export function parseAnswerContent(content: string): ParsedAnswerContent {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return { answer: content, structured: false };

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'answer' in parsed &&
      typeof (parsed as { answer?: unknown }).answer === 'string'
    ) {
      return { answer: (parsed as { answer: string }).answer, structured: true };
    }
  } catch {
    // The deterministic validator below will reject malformed/no-citation content.
  }

  return { answer: content, structured: false };
}

export function extractCitationIds(text: string): string[] {
  const matches = text.matchAll(/\[(C\d+)\]/gu);
  const ids = new Set<string>();
  for (const match of matches) {
    const id = match[1];
    if (id) ids.add(id);
  }
  return [...ids];
}

function isInsideRange(date: Date | null, range: ResolvedTimeRange): boolean {
  if (!date) return true;
  const timestamp = date.getTime();
  return timestamp >= new Date(range.from).getTime() && timestamp < new Date(range.to).getTime();
}

export function validateAnswerDraft(input: {
  readonly content: string;
  readonly chunksByCitation: ReadonlyMap<string, ResolvedContextChunk>;
  readonly resolvedTimeRange: ResolvedTimeRange;
  readonly enforceTimeRange: boolean;
}): AnswerValidationResult {
  const citedKeys = extractCitationIds(input.content);
  const reasons: string[] = [];

  if (citedKeys.length === 0) reasons.push('missing_citation');

  for (const key of citedKeys) {
    const chunk = input.chunksByCitation.get(key);
    if (!chunk) {
      reasons.push(`unknown_citation:${key}`);
      continue;
    }
    if (input.enforceTimeRange && !isInsideRange(chunk.publishedAt, input.resolvedTimeRange)) {
      reasons.push(`out_of_range_citation:${key}`);
    }
    if (chunk.isVerbatimOnly) {
      const excerpt = chunk.content.slice(0, 300).trim();
      if (excerpt && !input.content.includes(excerpt)) {
        reasons.push(`verbatim_excerpt_missing:${key}`);
      }
    }
  }

  return { valid: reasons.length === 0, citedKeys, reasons };
}
