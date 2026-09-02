import { readFileSync, writeFileSync } from 'node:fs';
import {
  evaluateGoldenSet,
  type EvaluationRunMetadata,
  type GoldenSetObservation,
} from './evaluation.js';

const [inputPath, outputPath, commit, model, configuration] = process.argv.slice(2);
if (!inputPath || !outputPath || !commit || !model || !configuration) {
  throw new Error(
    'Usage: evaluate <observations.json> <report.json> <commit> <model> <configuration>',
  );
}

const observations = JSON.parse(readFileSync(inputPath, 'utf8')) as GoldenSetObservation[];
const metadata: EvaluationRunMetadata = {
  commit,
  model,
  configuration,
  datasetVersion: 'EVAL_GOLDEN_SET-2026-09-02',
  executedAt: new Date().toISOString(),
};
const report = evaluateGoldenSet(observations, metadata);
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(
  `${JSON.stringify({ outputPath, gatePassed: report.gatePassed, metrics: report.metrics, failedChecks: report.failedChecks })}\n`,
);
process.exitCode = report.gatePassed ? 0 : 1;
