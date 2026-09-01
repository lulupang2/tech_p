/** The taxonomy seed is deliberately code/data only: no provider or model is involved. */
export const TOPIC_TAXONOMY_VERSION = '2026-09-01.1' as const;
export const TOPIC_CLASSIFIER_VERSION = `deterministic-alias-${TOPIC_TAXONOMY_VERSION}` as const;

export interface TopicTaxonomyEntry {
  readonly slug: string;
  readonly parent: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly ambiguousAliases: readonly string[];
  readonly contextPatterns?: readonly RegExp[];
  readonly sourceKeys?: readonly string[];
}

export interface TopicClassificationInput {
  readonly title?: string;
  readonly bodyText?: string;
  readonly text?: string;
  readonly sourceKey?: string | null;
}

export interface TopicClassification {
  readonly slug: string;
  readonly parent: string;
  readonly displayName: string;
  readonly taxonomyVersion: typeof TOPIC_TAXONOMY_VERSION;
  readonly classifierVersion: typeof TOPIC_CLASSIFIER_VERSION;
  readonly method: 'deterministic';
  readonly confidence: number;
  readonly matchedAliases: readonly string[];
  readonly contextConstrained: boolean;
  readonly sourceConstrained: boolean;
}

const context = (...patterns: string[]): readonly RegExp[] =>
  patterns.map((pattern) => new RegExp(pattern, 'iu'));

/**
 * This is the executable form of docs/TOPIC_TAXONOMY.md. Keep entries in taxonomy order so
 * classification output is stable even when aliases occur in a different order in a document.
 */
export const TOPIC_TAXONOMY: readonly TopicTaxonomyEntry[] = [
  {
    slug: 'typescript',
    parent: 'language-runtime',
    displayName: 'TypeScript',
    aliases: ['typescript', 'ts', '타입스크립트'],
    ambiguousAliases: [],
  },
  {
    slug: 'javascript',
    parent: 'language-runtime',
    displayName: 'JavaScript',
    aliases: ['javascript', 'js', '자바스크립트', 'ecmascript'],
    ambiguousAliases: [],
  },
  {
    slug: 'nodejs',
    parent: 'language-runtime',
    displayName: 'Node.js',
    aliases: ['nodejs', 'node.js', 'node', '노드'],
    ambiguousAliases: ['node'],
    contextPatterns: context(
      String.raw`\bnode\s+(?:runtime|version|package|server|module|modules|api|environment)\b`,
    ),
    sourceKeys: ['github_releases', 'stack_exchange', 'npm_registry'],
  },
  {
    slug: 'bun',
    parent: 'language-runtime',
    displayName: 'Bun',
    aliases: ['bun', 'bunjs', 'bun.sh'],
    ambiguousAliases: ['bun'],
    contextPatterns: context(
      String.raw`\bbun\s+(?:runtime|javascript|package|install|lockfile|toolchain)\b`,
    ),
    sourceKeys: ['github_releases', 'stack_exchange', 'npm_registry'],
  },
  {
    slug: 'deno',
    parent: 'language-runtime',
    displayName: 'Deno',
    aliases: ['deno', 'denoland'],
    ambiguousAliases: [],
  },
  {
    slug: 'python',
    parent: 'language-runtime',
    displayName: 'Python',
    aliases: ['python', '파이썬', 'py'],
    ambiguousAliases: ['py'],
    contextPatterns: context(String.raw`\bpy\s+(?:package|module|test|script|project)\b`),
    sourceKeys: ['github_releases', 'stack_exchange', 'arxiv'],
  },
  {
    slug: 'rust',
    parent: 'language-runtime',
    displayName: 'Rust',
    aliases: ['rust', 'rustlang', '러스트'],
    ambiguousAliases: ['rust'],
    contextPatterns: context(
      String.raw`\b(?:rust\s+(?:language|compiler|crate|toolchain|programming)|rustc|cargo)\b`,
    ),
    sourceKeys: ['github_releases', 'stack_exchange', 'users_rust_lang', 'arxiv'],
  },
  {
    slug: 'go',
    parent: 'language-runtime',
    displayName: 'Go',
    aliases: ['go', 'golang', '고랭'],
    ambiguousAliases: ['go'],
    contextPatterns: context(
      String.raw`\b(?:go\s+(?:language|module|runtime|programming|compiler)|golang|go\.mod)\b`,
    ),
    sourceKeys: ['github_releases', 'stack_exchange', 'arxiv'],
  },
  {
    slug: 'react',
    parent: 'web-framework',
    displayName: 'React',
    aliases: ['react', 'reactjs', 'react.js', '리액트'],
    ambiguousAliases: [],
  },
  {
    slug: 'nextjs',
    parent: 'web-framework',
    displayName: 'Next.js',
    aliases: ['next.js', 'nextjs', 'next'],
    ambiguousAliases: ['next'],
    contextPatterns: context(String.raw`\bnext\s+(?:\.js|app|router|js|framework|version)\b`),
    sourceKeys: ['github_releases', 'stack_exchange', 'npm_registry'],
  },
  {
    slug: 'vue',
    parent: 'web-framework',
    displayName: 'Vue',
    aliases: ['vue', 'vuejs', 'vue.js', '뷰'],
    ambiguousAliases: ['뷰'],
    contextPatterns: context(
      String.raw`(?:\bvue\s+(?:js|framework|component|app|router)|뷰\s*(?:프레임워크|컴포넌트))`,
    ),
    sourceKeys: ['github_releases', 'stack_exchange', 'npm_registry'],
  },
  {
    slug: 'vite',
    parent: 'web-framework',
    displayName: 'Vite',
    aliases: ['vite', 'vitejs'],
    ambiguousAliases: [],
  },
  {
    slug: 'svelte',
    parent: 'web-framework',
    displayName: 'Svelte',
    aliases: ['svelte', 'sveltekit'],
    ambiguousAliases: [],
  },
  {
    slug: 'astro',
    parent: 'web-framework',
    displayName: 'Astro',
    aliases: ['astro', 'astrojs', 'astro.build'],
    ambiguousAliases: ['astro'],
    contextPatterns: context(String.raw`\bastro\s+(?:build|framework|component|island|project)\b`),
    sourceKeys: ['github_releases', 'stack_exchange', 'npm_registry'],
  },
  {
    slug: 'elysia',
    parent: 'backend-framework',
    displayName: 'Elysia',
    aliases: ['elysia', 'elysiajs'],
    ambiguousAliases: [],
  },
  {
    slug: 'fastify',
    parent: 'backend-framework',
    displayName: 'Fastify',
    aliases: ['fastify'],
    ambiguousAliases: [],
  },
  {
    slug: 'nestjs',
    parent: 'backend-framework',
    displayName: 'NestJS',
    aliases: ['nestjs', 'nest.js', 'nest'],
    ambiguousAliases: ['nest'],
    contextPatterns: context(
      String.raw`\b(?:nest\s*\.js|nest\s+(?:framework|js|application|app|server))\b`,
    ),
    sourceKeys: ['github_releases', 'stack_exchange', 'npm_registry'],
  },
  {
    slug: 'express',
    parent: 'backend-framework',
    displayName: 'Express',
    aliases: ['express', 'expressjs'],
    ambiguousAliases: ['express'],
    contextPatterns: context(
      String.raw`\bexpress(?:js)?\s+(?:framework|server|middleware|router|app|api)\b`,
    ),
    sourceKeys: ['github_releases', 'stack_exchange', 'npm_registry'],
  },
  {
    slug: 'hono',
    parent: 'backend-framework',
    displayName: 'Hono',
    aliases: ['hono', 'honojs'],
    ambiguousAliases: [],
  },
  {
    slug: 'postgresql',
    parent: 'database',
    displayName: 'PostgreSQL',
    aliases: ['postgresql', 'postgres', 'psql', '포스트그레스'],
    ambiguousAliases: [],
  },
  {
    slug: 'pgvector',
    parent: 'database',
    displayName: 'pgvector',
    aliases: ['pgvector'],
    ambiguousAliases: [],
  },
  {
    slug: 'redis',
    parent: 'database',
    displayName: 'Redis',
    aliases: ['redis'],
    ambiguousAliases: [],
  },
  {
    slug: 'sqlite',
    parent: 'database',
    displayName: 'SQLite',
    aliases: ['sqlite'],
    ambiguousAliases: [],
  },
  {
    slug: 'llm',
    parent: 'ai-ml',
    displayName: 'Large Language Model',
    aliases: ['llm', 'large language model', '대규모 언어 모델'],
    ambiguousAliases: [],
  },
  {
    slug: 'rag',
    parent: 'ai-ml',
    displayName: 'Retrieval-Augmented Generation',
    aliases: ['rag', 'retrieval augmented generation', 'retrieval-augmented generation'],
    ambiguousAliases: ['rag'],
    contextPatterns: context(
      String.raw`\b(?:rag\s+(?:pipeline|system|retrieval|generation|application)|retrieval[- ]augmented|retrieval\s+and\s+generation)\b`,
    ),
    sourceKeys: ['github_releases', 'stack_exchange', 'arxiv'],
  },
  {
    slug: 'embedding',
    parent: 'ai-ml',
    displayName: 'Embedding',
    aliases: ['embedding', 'embeddings', '임베딩'],
    ambiguousAliases: [],
  },
  {
    slug: 'vector-search',
    parent: 'ai-ml',
    displayName: 'Vector search',
    aliases: ['vector search', 'vector database', 'vector db', '벡터 검색'],
    ambiguousAliases: [],
  },
  {
    slug: 'langchain',
    parent: 'ai-ml',
    displayName: 'LangChain',
    aliases: ['langchain', 'langchain.js', 'langchainjs'],
    ambiguousAliases: [],
  },
  {
    slug: 'langgraph',
    parent: 'ai-ml',
    displayName: 'LangGraph',
    aliases: ['langgraph', 'langgraph.js', 'langgraphjs'],
    ambiguousAliases: [],
  },
  {
    slug: 'mcp',
    parent: 'ai-ml',
    displayName: 'Model Context Protocol',
    aliases: ['mcp', 'model context protocol'],
    ambiguousAliases: ['mcp'],
    contextPatterns: context(
      String.raw`\b(?:mcp\s+(?:server|client|tool|protocol)|model\s+context\s+protocol)\b`,
    ),
    sourceKeys: ['github_releases', 'stack_exchange', 'arxiv'],
  },
  {
    slug: 'agent',
    parent: 'ai-ml',
    displayName: 'AI agent',
    aliases: ['agent', 'ai agent', 'agentic', '에이전트'],
    ambiguousAliases: ['agent'],
    contextPatterns: context(
      String.raw`(?:\b(?:ai\s+)?agent(?:s)?\s+(?:workflow|system|runtime|loop|framework)|에이전트\s*(?:워크플로|시스템|루프))`,
    ),
    sourceKeys: ['github_releases', 'stack_exchange', 'arxiv'],
  },
  {
    slug: 'playwright',
    parent: 'testing-tooling',
    displayName: 'Playwright',
    aliases: ['playwright', 'playwright test', '@playwright/test'],
    ambiguousAliases: [],
  },
  {
    slug: 'vitest',
    parent: 'testing-tooling',
    displayName: 'Vitest',
    aliases: ['vitest'],
    ambiguousAliases: [],
  },
  {
    slug: 'jest',
    parent: 'testing-tooling',
    displayName: 'Jest',
    aliases: ['jest'],
    ambiguousAliases: [],
  },
  {
    slug: 'testcontainers',
    parent: 'testing-tooling',
    displayName: 'Testcontainers',
    aliases: ['testcontainers', 'testcontainer'],
    ambiguousAliases: [],
  },
  {
    slug: 'docker',
    parent: 'infra-devops',
    displayName: 'Docker',
    aliases: ['docker', 'dockerfile', '도커'],
    ambiguousAliases: [],
  },
  {
    slug: 'kubernetes',
    parent: 'infra-devops',
    displayName: 'Kubernetes',
    aliases: ['kubernetes', 'k8s', '쿠버네티스'],
    ambiguousAliases: [],
  },
  {
    slug: 'ci-cd',
    parent: 'infra-devops',
    displayName: 'CI/CD',
    aliases: ['ci-cd', 'continuous integration', 'github actions'],
    ambiguousAliases: [],
  },
  {
    slug: 'queue',
    parent: 'infra-devops',
    displayName: 'Job queue',
    aliases: ['queue', 'bullmq', 'message queue', '큐'],
    ambiguousAliases: ['queue', '큐'],
    contextPatterns: context(
      String.raw`(?:\b(?:job|message|task)\s+queue\b|큐\s*(?:시스템|작업|메시지))`,
    ),
    sourceKeys: ['stack_exchange', 'arxiv'],
  },
] as const;

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const HANGUL = /[\uAC00-\uD7A3]/u;
const KOREAN_POSTPOSITIONS = [
  '으로써',
  '으로서',
  '에서',
  '에게',
  '한테',
  '부터',
  '까지',
  '으로',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '에',
  '의',
  '와',
  '과',
  '로',
  '도',
  '만',
  '랑',
] as const;

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
}

function isKoreanPostposition(text: string, index: number): boolean {
  return KOREAN_POSTPOSITIONS.some((postposition) => text.startsWith(postposition, index));
}

function aliasMatches(text: string, alias: string): boolean {
  const normalizedAlias = normalizeText(alias);
  if (!normalizedAlias) return false;
  let fromIndex = 0;
  while (fromIndex < text.length) {
    const index = text.indexOf(normalizedAlias, fromIndex);
    if (index < 0) return false;
    const end = index + normalizedAlias.length;
    const previous = index > 0 ? text[index - 1] : undefined;
    const next = text[end];
    const startsAtBoundary = previous === undefined || !WORD_CHARACTER.test(previous);
    const endsAtBoundary =
      next === undefined ||
      !WORD_CHARACTER.test(next) ||
      (HANGUL.test(next) && isKoreanPostposition(text, end));
    if (startsAtBoundary && endsAtBoundary) return true;
    fromIndex = index + 1;
  }
  return false;
}

export function classifyTopics(input: TopicClassificationInput): readonly TopicClassification[] {
  const text = normalizeText([input.title, input.bodyText, input.text].filter(Boolean).join('\n'));
  const sourceKey = input.sourceKey ?? null;

  return TOPIC_TAXONOMY.flatMap((entry) => {
    const matchedAliases = entry.aliases.filter((alias) => aliasMatches(text, alias));
    if (matchedAliases.length === 0) return [];

    const ambiguousMatches = matchedAliases.filter((alias) =>
      entry.ambiguousAliases.includes(alias),
    );
    const directMatches = matchedAliases.filter((alias) => !entry.ambiguousAliases.includes(alias));
    const contextConstrained =
      ambiguousMatches.length > 0 &&
      (entry.contextPatterns?.some((pattern) => pattern.test(text)) ?? false);
    const sourceConstrained =
      ambiguousMatches.length > 0 && (entry.sourceKeys?.includes(sourceKey ?? '') ?? false);

    if (
      ambiguousMatches.length > 0 &&
      directMatches.length === 0 &&
      !contextConstrained &&
      !sourceConstrained
    ) {
      return [];
    }

    return [
      {
        slug: entry.slug,
        parent: entry.parent,
        displayName: entry.displayName,
        taxonomyVersion: TOPIC_TAXONOMY_VERSION,
        classifierVersion: TOPIC_CLASSIFIER_VERSION,
        method: 'deterministic',
        confidence: directMatches.length > 0 ? 100 : contextConstrained ? 90 : 80,
        matchedAliases,
        contextConstrained,
        sourceConstrained,
      },
    ];
  });
}

export function createTopicClassifier(): {
  readonly taxonomyVersion: typeof TOPIC_TAXONOMY_VERSION;
  readonly classifierVersion: typeof TOPIC_CLASSIFIER_VERSION;
  readonly classify: (input: TopicClassificationInput) => readonly TopicClassification[];
} {
  return {
    taxonomyVersion: TOPIC_TAXONOMY_VERSION,
    classifierVersion: TOPIC_CLASSIFIER_VERSION,
    classify: classifyTopics,
  };
}
