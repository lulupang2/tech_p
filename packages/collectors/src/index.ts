export { SOURCE_POLICIES } from './policies.js';
export { validateUrl, stripPii, DefaultPolicyGuard } from './guard.js';
export { encodeOpaqueCursor, decodeOpaqueCursor } from './cursor.js';
export { BaseCollector } from './base.js';
export {
  GitHubReleasesCollector,
  type GitHubReleaseCursor,
  type GitHubReleasePayload,
  type GitHubReleasesConfig,
} from './github-releases.js';
export {
  StackExchangeCollector,
  detectTombstoneCandidates,
  type StackExchangeCollectorOptions,
  type StackExchangeCursorPayload,
  type StackExchangeRawQuestion,
  type StackExchangeApiResponse,
} from './stack-exchange.js';
export {
  NpmRegistryCollector,
  NpmDownloadsCollector,
  NpmCollector,
  NpmCollectorError,
  NpmRateLimitError,
  NpmPackageNotFoundError,
  NpmHttpError,
  DEFAULT_NPM_PACKAGES,
  type NpmRegistryCollectorOptions,
  type NpmDownloadsCollectorOptions,
  type NpmCollectorOptions,
  type NpmRegistryCursor,
  type NpmDownloadsCursor,
} from './npm.js';
export {
  ArxivCollector,
  type ArxivCollectorOptions,
  type ArxivCursor,
  type ParsedArxivEntry,
  type ParsedArxivFeed,
  extractArxivId,
  parseArxivFeed,
  formatArxivDate,
} from './arxiv.js';
export {
  ArticleCollector,
  ArticleDiscoveryService,
  ArticleExtractionService,
  REACT_BLOG_CONFIG,
  CHROME_RELEASE_NOTES_CONFIG,
  DEFAULT_ARTICLE_CONFIGS,
  parseXmlOrHtml,
  findNodes,
  findFirst,
  getTextContent,
  decodeHtmlEntities,
  type ArticleSourceConfig,
  type ArticleDiscoveryConfig,
  type ArticleLicenseConfig,
  type DiscoveredArticleEntry,
  type ArticleDiscoveryResult,
  type ExtractedArticle,
  type ArticleCursorData,
  type ArticleCollectorOptions,
  type HtmlNode,
  type FetchLike,
} from './article.js';
export {
  GitHubSearchCollector,
  GitHubSearchError,
  GitHubSearchAuthenticationError,
  GitHubSearchRateLimitError,
  GitHubSearchHttpError,
  GITHUB_SEARCH_MAX_PER_PAGE,
  GITHUB_SEARCH_MAX_RESULTS,
  GITHUB_SEARCH_DEFAULT_RATE_INTERVAL_MS,
  type GitHubSearchEndpoint,
  type GitHubSearchRateLimit,
  type GitHubSearchCursor,
  type GitHubSearchCollectorConfig,
  type GitHubSearchCollectorOptions,
  type GitHubSearchApiResponse,
} from './github-search.js';
