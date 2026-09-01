import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALGORITHM_VERSION, buildDataset, runExperiment } from './experiment.mjs';

test('builds a deterministic 200+ pair dataset with fixed train/holdout split', () => {
  const first = buildDataset();
  const second = buildDataset();
  assert.equal(first.length, 240);
  assert.deepEqual(first, second);
  assert.equal(first.filter((pair) => pair.split === 'train').length, 160);
  assert.equal(first.filter((pair) => pair.split === 'holdout').length, 80);
  assert.deepEqual(new Set(first.map((pair) => pair.label)), new Set(['same_revision', 'updated_revision', 'syndicated_copy', 'related_independent', 'unrelated']));
});

test('metadata-only fixtures preserve provenance and verbatim-only safeguards', () => {
  const pairs = buildDataset();
  for (const pair of pairs) {
    for (const fixture of [pair.fixtureA, pair.fixtureB]) {
      assert.equal(fixture.rights.rawPayloadStored, false);
      assert.equal(fixture.rights.storageMode, 'synthetic_metadata_only');
      assert.equal(fixture.provenance.sourceUrl, fixture.canonicalUrl);
      assert.ok(fixture.provenance.rawItemId);
    }
  }
  assert.ok(pairs.some((pair) => pair.fixtureA.rights.verbatimOnly || pair.fixtureB.rights.verbatimOnly));
});

test('records one fixed holdout evaluation, confusion matrices, and a safe recommendation', () => {
  const { result } = runExperiment();
  assert.equal(result.algorithmVersion, ALGORITHM_VERSION);
  assert.equal(result.dataset.holdoutCount, 80);
  for (const variant of Object.values(result.variants)) {
    assert.equal(variant.holdoutEvaluation.split, 'fixed_holdout_once');
    assert.deepEqual(Object.keys(variant.holdoutEvaluation.confusionMatrix).sort(), ['fn', 'fp', 'tn', 'tp']);
    assert.ok(variant.sourceTypeErrorAnalysis.length > 0);
  }
  assert.equal(result.recommendation.autoMerge, false);
  assert.equal(result.recommendation.gate.passes, true);
  assert.ok(result.recommendation.threshold >= 0.5 && result.recommendation.threshold <= 0.9);
});
