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
        { owner: 'rust-lang', repo: 'rust' },
        { owner: 'postgres', repo: 'postgres' },
        { owner: 'vercel', repo: 'next.js' },
        { owner: 'vuejs', repo: 'core' },
        { owner: 'sveltejs', repo: 'svelte' },
        { owner: 'tailwindlabs', repo: 'tailwindcss' },
        { owner: 'expressjs', repo: 'express' },
        { owner: 'nestjs', repo: 'nest' },
        { owner: 'prisma', repo: 'prisma' },
        { owner: 'drizzle-team', repo: 'drizzle-orm' },
        { owner: 'vitejs', repo: 'vite' },
        { owner: 'withastro', repo: 'astro' },
        { owner: 'honojs', repo: 'hono' },
        { owner: 'docker', repo: 'cli' },
        { owner: 'golang', repo: 'go' },
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
        'topic:rust stars:>500',
        'topic:postgresql stars:>500',
        'topic:nextjs stars:>500',
        'topic:vue stars:>500',
        'topic:svelte stars:>500',
        'topic:tailwind stars:>500',
        'topic:docker stars:>1000',
        'topic:kubernetes stars:>1000',
        'topic:python stars:>1000',
        'topic:golang stars:>1000',
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
      tags: [
        'typescript',
        'javascript',
        'node.js',
        'bun',
        'playwright',
        'react',
        'reactjs',
        'next.js',
        'vue.js',
        'svelte',
        'angular',
        'express',
        'nestjs',
        'tailwind-css',
        'docker',
        'kubernetes',
        'rust',
        'postgresql',
        'python',
        'go',
        'prisma',
        'vite',
      ],
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
        'react-dom',
        'next',
        'vue',
        'svelte',
        '@angular/core',
        'tailwindcss',
        'express',
        '@nestjs/core',
        'vite',
        'prisma',
        'drizzle-orm',
        'zod',
        'axios',
        'electron',
        'hono',
        'astro',
        'solid-js',
        'nuxt',
        'turborepo',
        'vitest',
        'jest',
        'playwright',
        '@playwright/test',
        'bun-types',
        'elysia',
        'fastify',
        'rxjs',
        'redux',
        'zustand',
        '@tanstack/react-query',
        'graphql',
        'socket.io',
        'mongoose',
        'pg',
        'redis',
        'bullmq',
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
       VALUES ($1, $2, $3, $4, true, $5::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind,
         base_url = EXCLUDED.base_url, schedule_config = EXCLUDED.schedule_config,
         enabled = true, updated_at = now()`,
      [key, name, kind, baseUrl, JSON.stringify(scheduleConfig)],
    );
  }

  console.log('Seeding standard licenses...');
  const licenses = [
    ['mit', 'MIT', 'MIT License'],
    ['apache-2.0', 'Apache-2.0', 'Apache License 2.0'],
    ['cc-by-4.0', 'CC-BY-4.0', 'Creative Commons Attribution 4.0'],
    ['cc-by-sa-4.0', 'CC-BY-SA-4.0', 'Creative Commons Attribution-ShareAlike 4.0'],
    ['cc-by-sa-3.0', 'CC-BY-SA-3.0', 'Creative Commons Attribution-ShareAlike 3.0'],
    ['cc-by-sa-2.5', 'CC-BY-SA-2.5', 'Creative Commons Attribution-ShareAlike 2.5'],
    ['cc0-1.0', 'CC0-1.0', 'Creative Commons Zero 1.0'],
    ['bsd-2-clause', 'BSD-2-Clause', 'BSD 2-Clause'],
    ['bsd-3-clause', 'BSD-3-Clause', 'BSD 3-Clause'],
    ['isc', 'ISC', 'ISC License'],
    ['unlicense', 'Unlicense', 'The Unlicense'],
    ['mpl-2.0', 'MPL-2.0', 'Mozilla Public License 2.0'],
    ['mit-or-apache-2.0', null, 'MIT or Apache-2.0 dual license'],
  ];
  for (const [id, spdx, name] of licenses) {
    await pool.query(
      `INSERT INTO licenses (id, spdx_id, name, allows_commercial)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (id) DO NOTHING`,
      [id, spdx, name],
    );
  }
  console.log(`seeded ${sources.length} MVP source metadata records`);
} finally {
  await pool.end();
}
