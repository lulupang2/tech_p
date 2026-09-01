import { TypeCompiler } from '@sinclair/typebox/compiler';
import {
  GoldenSetCollectionSchema,
  GoldenSetItemSchema,
  type GoldenSetCollection,
  type GoldenSetItem,
} from './types.js';

export interface GoldenSetValidationIssue {
  readonly path: string;
  readonly reason: string;
}

export class GoldenSetValidationError extends Error {
  readonly issues: readonly GoldenSetValidationIssue[];

  constructor(issues: readonly GoldenSetValidationIssue[]) {
    super(
      `Golden set validation failed: ${issues.map((i) => `${i.path}: ${i.reason}`).join(', ')}`,
    );
    this.name = 'GoldenSetValidationError';
    this.issues = issues;
  }
}

export type SafeParseResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: GoldenSetValidationError };

const itemValidator = TypeCompiler.Compile(GoldenSetItemSchema);
const collectionValidator = TypeCompiler.Compile(GoldenSetCollectionSchema);

function formatPath(path: string | undefined): string {
  if (!path) return '';
  return path
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .join('.');
}

export function validateGoldenSetItem(item: unknown): asserts item is GoldenSetItem {
  if (itemValidator.Check(item)) {
    return;
  }

  const issues: GoldenSetValidationIssue[] = [];
  for (const error of itemValidator.Errors(item)) {
    issues.push({
      path: formatPath(error.path),
      reason: error.message || 'invalid_value',
    });
  }

  throw new GoldenSetValidationError(issues);
}

export function validateGoldenSetCollection(
  collection: unknown,
): asserts collection is GoldenSetCollection {
  if (collectionValidator.Check(collection)) {
    return;
  }

  const issues: GoldenSetValidationIssue[] = [];
  for (const error of collectionValidator.Errors(collection)) {
    issues.push({
      path: formatPath(error.path),
      reason: error.message || 'invalid_value',
    });
  }

  throw new GoldenSetValidationError(issues);
}

export function safeParseGoldenSetCollection(input: unknown): SafeParseResult<GoldenSetCollection> {
  try {
    validateGoldenSetCollection(input);
    return { success: true, data: input };
  } catch (error) {
    if (error instanceof GoldenSetValidationError) {
      return { success: false, error };
    }
    return {
      success: false,
      error: new GoldenSetValidationError([
        {
          path: '',
          reason: error instanceof Error ? error.message : 'unknown_error',
        },
      ]),
    };
  }
}

export function parseGoldenSetCollection(input: unknown): GoldenSetCollection {
  validateGoldenSetCollection(input);
  return input;
}
