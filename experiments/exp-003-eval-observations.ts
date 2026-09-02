import { readFileSync, writeFileSync } from 'node:fs';
import { GOLDEN_SET_ITEMS } from '../packages/rag/src/golden-set/data.js';
import type { GoldenSetObservation } from '../packages/rag/src/evaluation.js';

interface ChatRow {
  readonly id: string;
  readonly statusCorrect?: boolean;
  readonly citationCorrect?: boolean;
  readonly injectionSafe?: boolean;
  readonly latencyMs?: number;
}

interface Measurement {
  readonly chat: ReadonlyArray<{ readonly model: string; readonly rows: readonly ChatRow[] }>;
  readonly embedding: ReadonlyArray<{
    readonly model: string;
    readonly ndcgAt10: number;
    readonly failedItems: ReadonlyArray<{ readonly id: string }>;
  }>;
}

const [measurementPath, outputPath] = process.argv.slice(2);
if (!measurementPath || !outputPath) throw new Error('Usage: exp-003-eval-observations <measurement.json> <observations.json>');
const measurement = JSON.parse(readFileSync(measurementPath, 'utf8')) as Measurement;
const chat = measurement.chat.find((candidate) => candidate.model === 'deepseek-v4-flash');
const embedding = measurement.embedding.find((candidate) => candidate.model === 'perplexity/pplx-embed-v1-0.6b');
if (!chat || !embedding) throw new Error('Selected EXP-003 candidates are missing');
const rows = new Map(chat.rows.map((row) => [row.id, row]));
const retrievalFailures = new Set(embedding.failedItems.map((item) => item.id));
const observations: GoldenSetObservation[] = GOLDEN_SET_ITEMS.map((item) => {
  const row = rows.get(item.id);
  if (!row) throw new Error(`Missing chat row ${item.id}`);
  const wrongStatus = item.expectedStatus === 'answered' ? 'insufficient_evidence' : 'answered';
  return {
    id: item.id,
    status: row.statusCorrect === true ? item.expectedStatus : wrongStatus,
    citationPrecision: row.citationCorrect === true ? 1 : 0,
    recallAt10: retrievalFailures.has(item.id) ? 0 : 1,
    ndcgAt10: embedding.ndcgAt10,
    unsupportedClaim: row.statusCorrect !== true || row.citationCorrect !== true,
    injectionSafe: row.injectionSafe === true,
    latencyMs: row.latencyMs ?? 30_000,
  };
});
writeFileSync(outputPath, `${JSON.stringify(observations, null, 2)}\n`, 'utf8');
