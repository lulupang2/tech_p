import type {
  CollectionPageRequest,
  CollectionPageResult,
  CollectorPagePort,
  CollectionTargetRevision,
  TargetCapability,
  TargetPolicy,
  TargetSelector,
  SourceKey,
  PolicyGuardPort,
} from '@techpulse/domain';
import { assertCollectableTarget, collectionHash } from '@techpulse/domain';
import { SOURCE_POLICIES } from './policies.js';
import { DefaultPolicyGuard } from './guard.js';
import { GitHubReleasesCollector } from './github-releases.js';
import { StackExchangeCollector } from './stack-exchange.js';
import { ArxivCollector } from './arxiv.js';
import { GitHubSearchCollector } from './github-search.js';
import { NpmRegistryCollector, NpmDownloadsCollector } from './npm.js';
import { RedditCollector } from './reddit.js';
import { DiscourseCollector } from './discourse.js';
import { ArticleCollector } from './article.js';
import { ChromeOriginTrialsCollector } from './chrome-origin-trials.js';
import { HuggingFaceCollector } from './huggingface.js';

/**
 * Builds a deterministic canonical identity for a target selector.
 */
export function buildCanonicalIdentity(sourceKey: SourceKey, selector: TargetSelector): string {
  switch (selector.kind) {
    case 'repository':
      return `${sourceKey}:${selector.owner.toLowerCase()}/${selector.repository.toLowerCase()}`;
    case 'tag':
      return `${sourceKey}:${selector.site.toLowerCase()}:${selector.tag.toLowerCase()}`;
    case 'package':
      return `${sourceKey}:${selector.name.toLowerCase()}`;
    case 'query':
      return `${sourceKey}:query:${selector.query.trim().toLowerCase()}`;
    case 'feed':
      return `${sourceKey}:feed:${selector.url.trim()}`;
    case 'category':
      return `${sourceKey}:${selector.category.toLowerCase()}`;
    case 'source':
      return `${sourceKey}:all`;
  }
}

/**
 * Resolves standard target capability defaults for a given source key.
 */
export function resolveTargetCapability(sourceKey: SourceKey): TargetCapability {
  switch (sourceKey) {
    case 'github_releases':
      return {
        historyMode: 'paginated_history',
        timeBasis: 'published_at',
        cursorVersion: 1,
        stablePagination: true,
        canCollect: true,
        canSearch: true,
        canDiscover: true,
        reviewedAt: '2026-09-08T00:00:00.000Z',
        earliestAvailableAt: null,
      };
    case 'stack_exchange':
      return {
        historyMode: 'historical_range',
        timeBasis: 'published_at',
        cursorVersion: 1,
        stablePagination: true,
        canCollect: true,
        canSearch: true,
        canDiscover: true,
        reviewedAt: '2026-09-08T00:00:00.000Z',
        earliestAvailableAt: null,
      };
    case 'arxiv':
      return {
        historyMode: 'historical_range',
        timeBasis: 'published_at',
        cursorVersion: 1,
        stablePagination: true,
        canCollect: true,
        canSearch: true,
        canDiscover: true,
        reviewedAt: '2026-09-08T00:00:00.000Z',
        earliestAvailableAt: null,
      };
    case 'github_search':
      return {
        historyMode: 'paginated_history',
        timeBasis: 'published_at',
        cursorVersion: 1,
        stablePagination: false,
        canCollect: true,
        canSearch: true,
        canDiscover: true,
        reviewedAt: '2026-09-08T00:00:00.000Z',
        earliestAvailableAt: null,
      };
    case 'npm_registry':
      return {
        historyMode: 'snapshot_only',
        timeBasis: 'observed_at',
        cursorVersion: 1,
        stablePagination: true,
        canCollect: true,
        canSearch: false,
        canDiscover: false,
        reviewedAt: '2026-09-08T00:00:00.000Z',
        earliestAvailableAt: null,
      };
    case 'npm_downloads':
      return {
        historyMode: 'historical_range',
        timeBasis: 'published_at',
        cursorVersion: 1,
        stablePagination: true,
        canCollect: true,
        canSearch: false,
        canDiscover: false,
        reviewedAt: '2026-09-08T00:00:00.000Z',
        earliestAvailableAt: null,
      };
    case 'users_rust_lang':
      return {
        historyMode: 'feed_only',
        timeBasis: 'published_at',
        cursorVersion: 1,
        stablePagination: false,
        canCollect: true,
        canSearch: false,
        canDiscover: false,
        reviewedAt: '2026-09-08T00:00:00.000Z',
        earliestAvailableAt: null,
      };
    case 'reddit':
      return {
        historyMode: 'feed_only',
        timeBasis: 'published_at',
        cursorVersion: 1,
        stablePagination: false,
        canCollect: true,
        canSearch: false,
        canDiscover: false,
        reviewedAt: '2026-09-08T00:00:00.000Z',
        earliestAvailableAt: null,
      };
    case 'chrome_release_notes':
    case 'react_blog':
      return {
        historyMode: 'feed_only',
        timeBasis: 'published_at',
        cursorVersion: 1,
        stablePagination: false,
        canCollect: true,
        canSearch: false,
        canDiscover: false,
        reviewedAt: '2026-09-08T00:00:00.000Z',
        earliestAvailableAt: null,
      };
    case 'chrome_origin_trials':
      return {
        historyMode: 'snapshot_only',
        timeBasis: 'observed_at',
        cursorVersion: 1,
        stablePagination: true,
        canCollect: true,
        canSearch: false,
        canDiscover: false,
        reviewedAt: '2026-09-08T00:00:00.000Z',
        earliestAvailableAt: null,
      };
    case 'huggingface_hub':
      return {
        historyMode: 'paginated_history',
        timeBasis: 'published_at',
        cursorVersion: 1,
        stablePagination: true,
        canCollect: true,
        canSearch: true,
        canDiscover: true,
        reviewedAt: '2026-09-08T00:00:00.000Z',
        earliestAvailableAt: null,
      };
  }
}

/**
 * Creates a valid, canonical CollectionTargetRevision object.
 */
export function createTargetRevision(params: {
  id?: string;
  targetId: string;
  sourceId: string;
  sourceKey: SourceKey;
  selector: TargetSelector;
  policy?: Partial<TargetPolicy>;
  capability?: Partial<TargetCapability>;
  topicIds?: readonly string[];
  taxonomyVersion?: string;
  enabled?: boolean;
  cadenceMs?: number | null;
  overlapMs?: number;
  createdAt?: Date;
}): CollectionTargetRevision {
  const sourcePolicy = SOURCE_POLICIES[params.sourceKey];
  const canonicalIdentity = buildCanonicalIdentity(params.sourceKey, params.selector);
  const defaultCapability = resolveTargetCapability(params.sourceKey);
  const capability: TargetCapability = {
    ...defaultCapability,
    ...(params.capability ?? {}),
  };
  const policy: TargetPolicy = {
    version: '1.0.0',
    approved: true,
    fetch: true,
    store: true,
    embed: true,
    modelInput: true,
    displayExcerpt: true,
    licenseId: sourcePolicy.defaultLicenseId,
    verbatimOnly: sourcePolicy.verbatimOnly,
    ...(params.policy ?? {}),
  };
  const configHash = collectionHash({
    sourceKey: params.sourceKey,
    selector: params.selector,
    capability,
    policy,
  });

  return {
    id: params.id ?? `rev_${canonicalIdentity.replace(/[^a-zA-Z0-9_]/g, '_')}`,
    targetId: params.targetId,
    sourceId: params.sourceId,
    sourceKey: params.sourceKey,
    canonicalIdentity,
    configHash,
    selector: params.selector,
    capability,
    policy,
    topicIds: params.topicIds ?? [],
    taxonomyVersion: params.taxonomyVersion ?? '1.0.0',
    enabled: params.enabled ?? false,
    cadenceMs: params.cadenceMs ?? null,
    overlapMs: params.overlapMs ?? 0,
    createdAt: params.createdAt ?? new Date('2026-09-08T00:00:00.000Z'),
  };
}

export interface CollectorPageAdapterOptions {
  fetch?: typeof fetch;
  guard?: PolicyGuardPort;
  pat?: string;
  apiKey?: string;
}

/**
 * Adapter dispatching collectPage calls to target-specific collectors.
 */
export class CollectorPageAdapter implements CollectorPagePort {
  private readonly guard: PolicyGuardPort;
  private readonly customFetch: typeof fetch | undefined;
  private readonly pat: string | undefined;
  private readonly apiKey: string | undefined;

  constructor(options: CollectorPageAdapterOptions = {}) {
    this.guard = options.guard ?? new DefaultPolicyGuard();
    this.customFetch = options.fetch;
    this.pat = options.pat;
    this.apiKey = options.apiKey;
  }

  async collectPage(request: CollectionPageRequest): Promise<CollectionPageResult> {
    assertCollectableTarget(request.target);

    switch (request.target.sourceKey) {
      case 'github_releases': {
        const collector = new GitHubReleasesCollector(
          this.pat !== undefined ? { pat: this.pat } : {},
          {
            ...(this.guard !== undefined ? { guard: this.guard } : {}),
            ...(this.customFetch !== undefined ? { fetch: this.customFetch } : {}),
          },
        );
        return collector.collectPage(request);
      }
      case 'stack_exchange': {
        const collector = new StackExchangeCollector({
          guard: this.guard,
          ...(this.customFetch !== undefined ? { fetchFn: this.customFetch } : {}),
          ...(this.apiKey !== undefined ? { apiKey: this.apiKey } : {}),
        });
        return collector.collectPage(request);
      }
      case 'arxiv': {
        const collector = new ArxivCollector({
          guard: this.guard,
          ...(this.customFetch !== undefined ? { fetch: this.customFetch } : {}),
        });
        return collector.collectPage(request);
      }
      case 'github_search': {
        const collector = new GitHubSearchCollector(
          this.pat !== undefined ? { pat: this.pat } : {},
          {
            ...(this.guard !== undefined ? { guard: this.guard } : {}),
            ...(this.customFetch !== undefined ? { fetch: this.customFetch } : {}),
          },
        );
        return collector.collectPage(request);
      }
      case 'npm_registry': {
        const collector = new NpmRegistryCollector({
          guard: this.guard,
          ...(this.customFetch !== undefined ? { fetch: this.customFetch } : {}),
        });
        return collector.collectPage(request);
      }
      case 'npm_downloads': {
        const collector = new NpmDownloadsCollector({
          guard: this.guard,
          ...(this.customFetch !== undefined ? { fetch: this.customFetch } : {}),
        });
        return collector.collectPage(request);
      }
      case 'users_rust_lang': {
        const collector = new DiscourseCollector({
          guard: this.guard,
          ...(this.customFetch !== undefined ? { fetchFn: this.customFetch } : {}),
        });
        return collector.collectPage(request);
      }
      case 'reddit': {
        const collector = new RedditCollector({
          guard: this.guard,
        });
        return collector.collectPage(request);
      }
      case 'chrome_release_notes':
      case 'react_blog': {
        const collector = new ArticleCollector(request.target.sourceKey, {
          guard: this.guard,
          ...(this.customFetch !== undefined ? { fetch: this.customFetch } : {}),
        });
        return collector.collectPage(request);
      }
      case 'chrome_origin_trials': {
        const collector = new ChromeOriginTrialsCollector({
          guard: this.guard,
        });
        return collector.collectPage(request);
      }
      case 'huggingface_hub': {
        const collector = new HuggingFaceCollector({
          guard: this.guard,
          ...(this.customFetch !== undefined ? { fetchFn: this.customFetch } : {}),
        });
        return collector.collectPage(request);
      }
      default:
        throw new Error(`Unsupported source key for collectPage: ${request.target.sourceKey}`);
    }
  }
}

export function createCollectorPageAdapter(
  options?: CollectorPageAdapterOptions,
): CollectorPagePort {
  return new CollectorPageAdapter(options);
}
