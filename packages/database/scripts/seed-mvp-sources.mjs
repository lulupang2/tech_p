import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sources = [
  [
    'github_releases',
    'GitHub Releases',
    'release_note',
    'https://api.github.com',
    {
      cadence: 'hourly',
      owner: 'microsoft',
      repo: 'playwright',
      repositories: [
        { owner: 'microsoft', repo: 'playwright' },
        { owner: 'microsoft', repo: 'TypeScript' },
        { owner: 'nodejs', repo: 'node' },
        { owner: 'oven-sh', repo: 'bun' },
        { owner: 'facebook', repo: 'react' },
      ],
    },
  ],
  [
    'github_search',
    'GitHub Search Signals',
    'metric',
    'https://api.github.com',
    {
      cadence: 'daily',
      query: 'topic:typescript stars:>500',
      queries: [
        'topic:typescript stars:>500',
        'topic:nodejs stars:>500',
        'topic:bun stars:>100',
        'topic:playwright stars:>100',
        'topic:react stars:>500',
      ],
    },
  ],
  [
    'stack_exchange',
    'Stack Exchange',
    'qa_post',
    'https://api.stackexchange.com',
    {
      cadence: 'hourly',
      site: 'stackoverflow',
      tag: 'typescript',
      tags: ['typescript', 'node.js', 'bun', 'playwright', 'react'],
    },
  ],
  [
    'npm_registry',
    'npm Registry Packages',
    'package_release',
    'https://registry.npmjs.org',
    {
      cadence: 'daily',
      packages: [
        'typescript',
        'react',
        'playwright',
        '@playwright/test',
        'bun-types',
        'elysia',
        'fastify',
        '@nestjs/core',
        'next',
        'vite',
      ],
    },
  ],
  [
    'npm_downloads',
    'npm Download Metrics',
    'metric',
    'https://api.npmjs.org',
    {
      cadence: 'daily',
      packages: [
        'typescript',
        'react',
        'playwright',
        '@playwright/test',
        'bun-types',
        'elysia',
        'fastify',
        '@nestjs/core',
        'next',
        'vite',
      ],
    },
  ],
  [
    'react_blog',
    'React Official Blog',
    'article',
    'https://react.dev',
    {
      cadence: '6h',
      feed_url: 'https://react.dev/rss.xml',
    },
  ],
  [
    'chrome_release_notes',
    'Chrome Release Notes',
    'release_note',
    'https://developer.chrome.com',
    {
      cadence: 'daily',
      base_url: 'https://developer.chrome.com/release-notes',
    },
  ],
  [
    'arxiv',
    'arXiv Papers',
    'paper',
    'https://export.arxiv.org',
    {
      cadence: 'daily',
      categories: ['cs.AI', 'cs.CL', 'cs.IR', 'cs.LG', 'cs.SE'],
    },
  ],
  [
    'users_rust_lang',
    'Rust Users Forum',
    'forum_post',
    'https://users.rust-lang.org',
    {
      cadence: 'hourly',
    },
  ],
  [
    'huggingface_hub',
    'Hugging Face Hub Metrics',
    'metric',
    'https://huggingface.co',
    {
      cadence: 'daily',
    },
  ],
  [
    'chrome_origin_trials',
    'Chrome Origin Trials',
    'status_record',
    'https://developer.chrome.com',
    {
      cadence: 'daily',
      url: 'https://developer.chrome.com/origintrials/',
    },
  ],
  [
    'reddit',
    'Reddit r/typescript',
    'forum_post',
    'https://www.reddit.com/r/typescript/',
    {
      cadence: '6h',
      subreddit: 'typescript',
      collection_mode: 'metadata_only_until_gates',
    },
  ],
];

const pool = new Pool({ connectionString: databaseUrl });
try {
  for (const [key, name, kind, baseUrl, scheduleConfig] of sources) {
    await pool.query(
      `INSERT INTO sources (key, name, kind, base_url, enabled, schedule_config, policy_reviewed_at)
       VALUES ($1, $2, $3, $4, ($1 <> 'reddit'), $5::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind,
         base_url = EXCLUDED.base_url, schedule_config = EXCLUDED.schedule_config,
         enabled = ($1 <> 'reddit'), updated_at = now()`,
      [key, name, kind, baseUrl, JSON.stringify(scheduleConfig)],
    );
  }
  console.log(`seeded ${sources.length} MVP source metadata records`);
} finally {
  await pool.end();
}
