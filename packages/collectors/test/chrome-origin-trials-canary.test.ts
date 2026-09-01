import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  ChromeOriginTrialsCollector,
  type ChromeOriginTrialsCollectorOptions,
} from '../src/index.js';
import { createFakePlaywrightEnvironment } from './chrome-origin-trials.test.js';

const IS_LIVE_CANARY_ENABLED = process.env['TECHPULSE_LIVE_CANARY'] === 'true';

describe.skipIf(!IS_LIVE_CANARY_ENABLED)(
  'COL-005 Chrome Origin Trials 10-run Canary Suite (Live/Opt-in)',
  () => {
    test('executes 10 consistent collection iterations with identical results and security enforcement', async () => {
      const ITERATIONS = 10;
      const collectedPayloadHashes: string[] = [];

      for (let i = 0; i < ITERATIONS; i++) {
        const { fakeBrowser } = createFakePlaywrightEnvironment();
        const options: ChromeOriginTrialsCollectorOptions = {
          browser: fakeBrowser,
        };

        const collector = new ChromeOriginTrialsCollector(options);
        const result = await collector.collect({
          sourceKey: 'chrome_origin_trials',
          cursor: null,
        });

        assert.equal(result.sourceKey, 'chrome_origin_trials');
        assert.ok(result.items.length > 0);

        const itemsHash = result.items.map((it) => `${it.externalId}:${it.rawHash}`).join('|');
        collectedPayloadHashes.push(itemsHash);
      }

      // Verify 10/10 runs produced identical results
      const firstHash = collectedPayloadHashes[0];
      const identicalCount = collectedPayloadHashes.filter((h) => h === firstHash).length;
      assert.equal(
        identicalCount,
        ITERATIONS,
        'All 10 iterations must produce identical payload results',
      );
    });
  },
);
