import type { SearchHit } from '@techpulse/domain';

export interface LiveSearchResultItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly sourceKey: string;
  readonly publishedAt: Date | null;
}

export interface LiveSearchOptions {
  readonly timeoutMs?: number | undefined;
  readonly githubPat?: string | undefined;
  readonly fetchFn?: typeof fetch | undefined;
}

/**
 * Searches npm registry for package metadata and recent release updates.
 */
async function searchNpmRegistry(
  query: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<readonly LiveSearchResultItem[]> {
  const cleanQuery = query.replace(/[^\w\s@/.-]/gu, ' ').trim();
  if (!cleanQuery) return [];

  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(cleanQuery)}&size=5`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'TechPulse-SignalArchive' },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      objects?: Array<{
        package?: {
          name?: string;
          version?: string;
          description?: string;
          links?: { npm?: string; homepage?: string; repository?: string };
          date?: string;
          keywords?: string[];
        };
      }>;
    };

    const results: LiveSearchResultItem[] = [];
    for (const item of data.objects ?? []) {
      const pkg = item.package;
      if (!pkg?.name) continue;
      const title = `${pkg.name} v${pkg.version ?? 'latest'} (npm)`;
      const url = pkg.links?.npm ?? `https://www.npmjs.com/package/${pkg.name}`;
      const desc = pkg.description ?? 'Package on npm registry';
      const keywords = Array.isArray(pkg.keywords)
        ? ` Keywords: ${pkg.keywords.slice(0, 5).join(', ')}.`
        : '';
      const snippet = `${desc}. Latest version: ${pkg.version ?? 'unknown'}.${keywords}`;
      const publishedAt = pkg.date ? new Date(pkg.date) : null;
      results.push({
        title,
        url,
        snippet,
        sourceKey: 'npm_registry',
        publishedAt: isNaN(publishedAt?.getTime() ?? NaN) ? null : publishedAt,
      });
    }
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Searches GitHub repositories for matching open-source projects and stars/descriptions.
 */
async function searchGitHub(
  query: string,
  githubPat: string | undefined,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<readonly LiveSearchResultItem[]> {
  const cleanQuery = query.replace(/[^\w\s@/.-]/gu, ' ').trim();
  if (!cleanQuery) return [];

  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(cleanQuery)}+stars:>50&sort=stars&order=desc&per_page=5`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'TechPulse-SignalArchive',
  };
  if (githubPat) {
    headers['Authorization'] = `Bearer ${githubPat}`;
  }

  try {
    const res = await fetchFn(url, { signal: controller.signal, headers });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      items?: Array<{
        full_name?: string;
        html_url?: string;
        description?: string;
        stargazers_count?: number;
        pushed_at?: string;
        language?: string;
      }>;
    };

    const results: LiveSearchResultItem[] = [];
    for (const item of data.items ?? []) {
      if (!item.full_name) continue;
      const title = `${item.full_name} (${item.stargazers_count?.toLocaleString() ?? 0} stars)`;
      const url = item.html_url ?? `https://github.com/${item.full_name}`;
      const desc = item.description ?? 'GitHub repository';
      const lang = item.language ? ` Primary language: ${item.language}.` : '';
      const snippet = `${desc}.${lang} Stars: ${item.stargazers_count ?? 0}.`;
      const publishedAt = item.pushed_at ? new Date(item.pushed_at) : null;
      results.push({
        title,
        url,
        snippet,
        sourceKey: 'github_search',
        publishedAt: isNaN(publishedAt?.getTime() ?? NaN) ? null : publishedAt,
      });
    }
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Searches Wikipedia for technical definitions and historical overview.
 */
async function searchWikipedia(
  query: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<readonly LiveSearchResultItem[]> {
  const cleanQuery = query.replace(/[^\w\s가-힣]/gu, ' ').trim();
  if (!cleanQuery) return [];

  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanQuery)}&format=json&utf8=`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'TechPulse-SignalArchive' },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      query?: {
        search?: Array<{
          title?: string;
          snippet?: string;
          pageid?: number;
          timestamp?: string;
        }>;
      };
    };

    const results: LiveSearchResultItem[] = [];
    for (const item of data.query?.search ?? []) {
      if (!item.title) continue;
      const cleanSnippet = (item.snippet ?? '').replace(/<[^>]+>/gu, '').trim();
      const title = `${item.title} (Wikipedia)`;
      const url = `https://en.wikipedia.org/?curid=${item.pageid}`;
      const publishedAt = item.timestamp ? new Date(item.timestamp) : null;
      results.push({
        title,
        url,
        snippet: cleanSnippet,
        sourceKey: 'article',
        publishedAt: isNaN(publishedAt?.getTime() ?? NaN) ? null : publishedAt,
      });
    }
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Queries real-time technical sources (npm registry, GitHub, Wikipedia) in parallel
 * and converts them into SearchHit items for the RAG prompt context.
 */
export async function fetchLiveTechEvidence(
  question: string,
  options: LiveSearchOptions = {},
): Promise<readonly SearchHit[]> {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 3500;
  const githubPat = options.githubPat ?? process.env['GITHUB_PAT'];

  const genericTerms: Record<string, true> = {
    and: true,
    are: true,
    latest: true,
    release: true,
    releases: true,
    recent: true,
    trend: true,
    trends: true,
    what: true,
  };
  const keywords = [...new Set(question.match(/[A-Za-z][A-Za-z0-9@._/-]*/gu) ?? [])].filter(
    (term) => !genericTerms[term.toLowerCase()],
  );
  const searchQuery =
    keywords.length > 0
      ? keywords.slice(0, 3).join(' ')
      : question.replace(/[?.,!~^]/gu, ' ').trim();

  const [npmHits, ghHits, wikiHits] = await Promise.all([
    searchNpmRegistry(searchQuery, fetchFn, timeoutMs),
    searchGitHub(searchQuery, githubPat, fetchFn, timeoutMs),
    searchWikipedia(searchQuery, fetchFn, timeoutMs),
  ]);

  const allItems = [...npmHits.slice(0, 3), ...ghHits.slice(0, 3), ...wikiHits.slice(0, 2)];

  return allItems.map((item, index) => ({
    chunkId: `live_chunk_${index + 1}_${Date.now()}`,
    documentId: item.url,
    documentRevisionId: `live_rev_${index + 1}`,
    title: item.title,
    content: item.snippet,
    headingPath: [item.sourceKey],
    score: 0.95 - index * 0.05,
    publishedAt: item.publishedAt,
  }));
}
