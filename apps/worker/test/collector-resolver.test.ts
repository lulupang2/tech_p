import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createCollectorForSource } from '../src/index.js';
import type { PlaywrightBrowser } from '@techpulse/collectors';
import type { SourceKey } from '@techpulse/domain';
describe('Worker createCollectorForSource multi-target resolution', () => {
  test('resolves github_releases with multi-repo configuration for Bun, Node, Playwright, TS, React', () => {
    const collector = createCollectorForSource('github_releases', {
      repositories: [
        { owner: 'microsoft', repo: 'playwright' },
        { owner: 'microsoft', repo: 'TypeScript' },
        { owner: 'nodejs', repo: 'node' },
        { owner: 'oven-sh', repo: 'bun' },
        { owner: 'facebook', repo: 'react' },
      ],
    });

    assert.ok(collector);
    assert.equal(collector.sourceKey, 'github_releases');
  });

  test('resolves github_search with multi-query configuration', () => {
    const collector = createCollectorForSource('github_search', {
      queries: [
        'topic:typescript stars:>500',
        'topic:nodejs stars:>500',
        'topic:bun stars:>100',
        'topic:playwright stars:>100',
        'topic:react stars:>500',
      ],
    });

    assert.ok(collector);
    assert.equal(collector.sourceKey, 'github_search');
  });

  test('resolves stack_exchange with multi-tag configuration', () => {
    const collector = createCollectorForSource('stack_exchange', {
      site: 'stackoverflow',
      tags: ['typescript', 'node.js', 'bun', 'playwright', 'react'],
    });

    assert.ok(collector);
    assert.equal(collector.sourceKey, 'stack_exchange');
  });

  test('resolves npm_registry and npm_downloads with target packages', () => {
    const packages = ['typescript', 'react', 'playwright', '@playwright/test', 'bun-types'];
    const regCollector = createCollectorForSource('npm_registry', { packages });
    const dlCollector = createCollectorForSource('npm_downloads', { packages });

    assert.ok(regCollector);
    assert.equal(regCollector.sourceKey, 'npm_registry');

    assert.ok(dlCollector);
    assert.equal(dlCollector.sourceKey, 'npm_downloads');
  });

  test('resolves article collectors for react_blog and chrome_release_notes', () => {
    const reactBlog = createCollectorForSource('react_blog');
    const chromeNotes = createCollectorForSource('chrome_release_notes');

    assert.ok(reactBlog);
    assert.equal(reactBlog.sourceKey, 'react_blog');

    assert.ok(chromeNotes);
    assert.equal(chromeNotes.sourceKey, 'chrome_release_notes');
  });

  test('resolves arxiv, users_rust_lang, huggingface_hub, and chrome_origin_trials', () => {
    const fakeBrowserFactory = async () => ({}) as PlaywrightBrowser;

    const arxiv = createCollectorForSource('arxiv', { categories: ['cs.AI', 'cs.SE'] });
    const rust = createCollectorForSource('users_rust_lang');
    const hf = createCollectorForSource('huggingface_hub');
    const trials = createCollectorForSource(
      'chrome_origin_trials',
      {},
      { browserFactory: fakeBrowserFactory },
    );

    assert.ok(arxiv);
    assert.equal(arxiv.sourceKey, 'arxiv');

    assert.ok(rust);
    assert.equal(rust.sourceKey, 'users_rust_lang');

    assert.ok(hf);
    assert.equal(hf.sourceKey, 'huggingface_hub');

    assert.ok(trials);
    assert.equal(trials.sourceKey, 'chrome_origin_trials');
  });

  test('resolves reddit with configured subreddit', () => {
    const fakeBrowserFactory = async () => ({}) as PlaywrightBrowser;
    const reddit = createCollectorForSource(
      'reddit',
      { subreddit: 'typescript' },
      { browserFactory: fakeBrowserFactory },
    );

    assert.ok(reddit);
    assert.equal(reddit.sourceKey, 'reddit');
  });

  test('returns undefined for unknown sourceKey', () => {
    const unknown = createCollectorForSource('unknown_key' as unknown as SourceKey);
    assert.equal(unknown, undefined);
  });
});
