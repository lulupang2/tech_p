import type {
  SourceSearchPort,
  SourceSearchRequest,
  SourceCandidate,
  DiscoveredTarget,
  PolicyGuardPort,
} from '@techpulse/domain';
import { DefaultPolicyGuard, createHardenedFetch } from './guard.js';
import { SOURCE_POLICIES } from './policies.js';
import { parseArxivFeed } from './arxiv.js';

export interface SourceSearchAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly guard?: PolicyGuardPort;
  readonly pat?: string;
  readonly apiKey?: string;
}

/**
 * Adapter implementing SourceSearchPort for candidate search and target discovery
 * across approved sources (GitHub, Stack Exchange, arXiv) using hardened HTTP transports.
 */
export class SourceSearchAdapter implements SourceSearchPort {
  private readonly guard: PolicyGuardPort;
  private readonly customFetch: typeof fetch | undefined;
  private readonly pat: string | undefined;
  private readonly apiKey: string | undefined;

  constructor(options: SourceSearchAdapterOptions = {}) {
    this.guard = options.guard ?? new DefaultPolicyGuard();
    this.customFetch = options.fetch;
    this.pat = options.pat;
    this.apiKey = options.apiKey;
  }

  async searchCandidates(request: SourceSearchRequest): Promise<readonly SourceCandidate[]> {
    if (
      !request.target.policy.approved ||
      !request.target.policy.fetch ||
      !request.target.capability.canSearch
    ) {
      return [];
    }

    const limit = Math.max(1, Math.min(request.limit, 10));
    const baseFetch = this.customFetch ?? globalThis.fetch;
    const policy = SOURCE_POLICIES[request.target.sourceKey];
    const fetchFn = createHardenedFetch({ guard: this.guard, policy, baseFetch });

    switch (request.target.sourceKey) {
      case 'github_releases': {
        const owner =
          request.target.selector.kind === 'repository'
            ? request.target.selector.owner
            : 'microsoft';
        const repo =
          request.target.selector.kind === 'repository'
            ? request.target.selector.repository
            : 'playwright';
        const url = new URL(`https://api.github.com/repos/${owner}/${repo}/releases`);
        url.searchParams.set('per_page', String(Math.min(limit * 2, 30)));

        const urlValidation = this.guard.validateUrl(url.toString(), policy);
        if (!urlValidation.valid) {
          throw new Error(`SSRF guard rejected URL: ${urlValidation.reason}`);
        }

        const headers: Record<string, string> = {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Signal Archive-Collector/1.0',
        };
        const pat = this.pat ?? process.env['GITHUB_PAT'];
        if (pat) {
          headers['Authorization'] = `Bearer ${pat}`;
        }

        const response = await fetchFn(url.toString(), {
          headers,
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        });
        if (!response.ok) {
          return [];
        }

        const releases = (await response.json()) as Array<{
          id: number;
          tag_name: string;
          name: string | null;
          body: string | null;
          published_at: string | null;
          html_url: string;
        }>;

        const qLower = request.query.toLowerCase();
        const candidates: SourceCandidate[] = [];

        for (const release of releases) {
          if (candidates.length >= limit) break;
          const title = release.name || release.tag_name || `Release ${release.id}`;
          const body = release.body || '';
          const match =
            request.query === '*' ||
            title.toLowerCase().includes(qLower) ||
            body.toLowerCase().includes(qLower);
          if (!match) continue;

          const publishedAt = release.published_at ? new Date(release.published_at) : null;
          if (publishedAt) {
            if (
              publishedAt.getTime() < request.window.from.getTime() ||
              publishedAt.getTime() >= request.window.to.getTime()
            ) {
              continue;
            }
          }

          candidates.push({
            externalId: `github_releases:${owner}/${repo}:${release.id}`,
            canonicalUrl: release.html_url,
            targetRevisionId: request.target.id,
            title,
            publishedAt,
          });
        }

        return candidates;
      }

      case 'stack_exchange': {
        const site =
          request.target.selector.kind === 'tag' ? request.target.selector.site : 'stackoverflow';
        const tag =
          request.target.selector.kind === 'tag' ? request.target.selector.tag : undefined;

        const fromSec = Math.floor(request.window.from.getTime() / 1000);
        const toSec = Math.floor(request.window.to.getTime() / 1000);

        const url = new URL('https://api.stackexchange.com/2.3/search/advanced');
        url.searchParams.set('site', site);
        if (tag) {
          url.searchParams.set('tagged', tag);
        }
        url.searchParams.set('q', request.query);
        url.searchParams.set('pagesize', String(limit));
        url.searchParams.set('order', 'desc');
        url.searchParams.set('sort', 'relevance');
        url.searchParams.set('fromdate', String(fromSec));
        url.searchParams.set('todate', String(toSec));
        if (this.apiKey) {
          url.searchParams.set('key', this.apiKey);
        }

        const urlValidation = this.guard.validateUrl(url.toString(), policy);
        if (!urlValidation.valid) {
          throw new Error(`SSRF guard rejected URL: ${urlValidation.reason}`);
        }

        const response = await fetchFn(url.toString(), {
          headers: { Accept: 'application/json' },
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        });
        if (!response.ok) {
          return [];
        }

        const data = (await response.json()) as {
          items?: Array<{
            question_id: number;
            title: string;
            link: string;
            creation_date: number;
          }>;
        };

        const candidates: SourceCandidate[] = [];
        for (const q of data.items ?? []) {
          candidates.push({
            externalId: `stack_exchange:${site}:${q.question_id}`,
            canonicalUrl: q.link,
            targetRevisionId: request.target.id,
            title: q.title,
            publishedAt: new Date(q.creation_date * 1000),
          });
        }
        return candidates;
      }

      case 'arxiv': {
        const category =
          request.target.selector.kind === 'category' ? request.target.selector.category : 'cs.AI';
        const searchQuery = `cat:${category} AND all:${encodeURIComponent(request.query)}`;
        const url = new URL('http://export.arxiv.org/api/query');
        url.searchParams.set('search_query', searchQuery);
        url.searchParams.set('start', '0');
        url.searchParams.set('max_results', String(limit));
        url.searchParams.set('sortBy', 'relevance');

        const urlValidation = this.guard.validateUrl(url.toString(), policy);
        if (!urlValidation.valid) {
          throw new Error(`SSRF guard rejected URL: ${urlValidation.reason}`);
        }

        const response = await fetchFn(url.toString(), {
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        });
        if (!response.ok) {
          return [];
        }

        const xml = await response.text();
        const parsed = parseArxivFeed(xml);
        const candidates: SourceCandidate[] = [];

        for (const entry of parsed.entries) {
          const publishedAt = entry.published ? new Date(entry.published) : null;
          candidates.push({
            externalId: `arxiv:${entry.arxivId}`,
            canonicalUrl: entry.canonicalUrl,
            targetRevisionId: request.target.id,
            title: entry.title,
            publishedAt,
          });
        }
        return candidates;
      }

      default:
        return [];
    }
  }

  async discoverTargets(request: SourceSearchRequest): Promise<readonly DiscoveredTarget[]> {
    if (!request.target.capability.canDiscover) {
      return [];
    }

    const limit = Math.max(1, Math.min(request.limit, 10));
    const baseFetch = this.customFetch ?? globalThis.fetch;
    const policy = SOURCE_POLICIES[request.target.sourceKey];
    const fetchFn = createHardenedFetch({ guard: this.guard, policy, baseFetch });

    switch (request.target.sourceKey) {
      case 'github_releases':
      case 'github_search': {
        const url = new URL('https://api.github.com/search/repositories');
        url.searchParams.set('q', request.query);
        url.searchParams.set('per_page', String(limit));

        const urlValidation = this.guard.validateUrl(url.toString(), policy);
        if (!urlValidation.valid) {
          throw new Error(`SSRF guard rejected URL: ${urlValidation.reason}`);
        }

        const headers: Record<string, string> = {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Signal Archive-Collector/1.0',
        };
        const pat = this.pat ?? process.env['GITHUB_PAT'];
        if (pat) {
          headers['Authorization'] = `Bearer ${pat}`;
        }

        const response = await fetchFn(url.toString(), {
          headers,
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        });
        if (!response.ok) {
          return [];
        }

        const data = (await response.json()) as {
          items?: Array<{
            name: string;
            owner: { login: string };
            html_url: string;
          }>;
        };

        const discovered: DiscoveredTarget[] = [];
        for (const repo of data.items ?? []) {
          discovered.push({
            canonicalIdentity: `github_releases:${repo.owner.login.toLowerCase()}/${repo.name.toLowerCase()}`,
            sourceKey: 'github_releases',
            selector: {
              kind: 'repository',
              owner: repo.owner.login,
              repository: repo.name,
            },
            evidenceUrl: repo.html_url,
          });
        }
        return discovered;
      }

      case 'stack_exchange': {
        const site =
          request.target.selector.kind === 'tag' ? request.target.selector.site : 'stackoverflow';
        const url = new URL('https://api.stackexchange.com/2.3/tags');
        url.searchParams.set('site', site);
        url.searchParams.set('inname', request.query);
        url.searchParams.set('pagesize', String(limit));
        url.searchParams.set('order', 'desc');
        url.searchParams.set('sort', 'popular');
        if (this.apiKey) {
          url.searchParams.set('key', this.apiKey);
        }

        const urlValidation = this.guard.validateUrl(url.toString(), policy);
        if (!urlValidation.valid) {
          throw new Error(`SSRF guard rejected URL: ${urlValidation.reason}`);
        }

        const response = await fetchFn(url.toString(), {
          headers: { Accept: 'application/json' },
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        });
        if (!response.ok) {
          return [];
        }

        const data = (await response.json()) as {
          items?: Array<{
            name: string;
            count: number;
          }>;
        };

        const discovered: DiscoveredTarget[] = [];
        for (const tag of data.items ?? []) {
          discovered.push({
            canonicalIdentity: `stack_exchange:${site.toLowerCase()}:${tag.name.toLowerCase()}`,
            sourceKey: 'stack_exchange',
            selector: {
              kind: 'tag',
              site,
              tag: tag.name,
            },
            evidenceUrl: `https://${site}.com/questions/tagged/${encodeURIComponent(tag.name)}`,
          });
        }
        return discovered;
      }

      case 'arxiv': {
        const knownCategories = [
          { category: 'cs.AI', name: 'Artificial Intelligence' },
          { category: 'cs.CL', name: 'Computation and Language' },
          { category: 'cs.CV', name: 'Computer Vision' },
          { category: 'cs.LG', name: 'Machine Learning' },
          { category: 'cs.SE', name: 'Software Engineering' },
          { category: 'cs.DB', name: 'Databases' },
          { category: 'cs.DC', name: 'Distributed, Parallel, and Cluster Computing' },
          { category: 'cs.CR', name: 'Cryptography and Security' },
        ];
        const qLower = request.query.toLowerCase();
        const matches = knownCategories.filter(
          (c) => c.category.toLowerCase().includes(qLower) || c.name.toLowerCase().includes(qLower),
        );

        return matches.slice(0, limit).map((c) => ({
          canonicalIdentity: `arxiv:${c.category.toLowerCase()}`,
          sourceKey: 'arxiv',
          selector: {
            kind: 'category',
            category: c.category,
          },
          evidenceUrl: `https://arxiv.org/list/${c.category}/recent`,
        }));
      }

      default:
        return [];
    }
  }
}

export function createSourceSearchAdapter(options?: SourceSearchAdapterOptions): SourceSearchPort {
  return new SourceSearchAdapter(options);
}
