import { GOLDEN_SET_ITEMS } from './data.js';
import type { GoldenSetCategory, GoldenSetItem, GoldenSetStatus } from './types.js';

export * from './types.js';
export * from './validation.js';
export * from './data.js';

export function getGoldenSetItemById(id: string): GoldenSetItem | undefined {
  return GOLDEN_SET_ITEMS.find((item) => item.id === id);
}

export function getGoldenSetQuestions(): readonly GoldenSetItem[] {
  return GOLDEN_SET_ITEMS.filter((item) => !item.isSecurityInjection);
}

export function getGoldenSetInjections(): readonly GoldenSetItem[] {
  return GOLDEN_SET_ITEMS.filter((item) => item.isSecurityInjection);
}

export function getGoldenSetItemsByStatus(status: GoldenSetStatus): readonly GoldenSetItem[] {
  return GOLDEN_SET_ITEMS.filter((item) => item.expectedStatus === status);
}

export function getGoldenSetItemsByCategory(category: GoldenSetCategory): readonly GoldenSetItem[] {
  return GOLDEN_SET_ITEMS.filter((item) => item.category === category);
}
