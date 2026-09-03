import { describe, expect, it, vi } from 'vitest';

const { launch } = vi.hoisted(() => ({ launch: vi.fn(async () => ({ close: vi.fn() })) }));
vi.mock('playwright', () => ({ chromium: { launch } }));

import { createWorkerChromiumFactory } from '../src/index.js';

describe('worker Reddit browser runtime', () => {
  it('creates a headless Chromium browser through the injected factory', async () => {
    const browser = await createWorkerChromiumFactory()();

    expect(launch).toHaveBeenCalledWith({ headless: true });
    expect(browser).toBeDefined();
  });
});
