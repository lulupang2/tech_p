import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sources = [
  ['github_releases', 'GitHub Releases', 'release_note', 'https://api.github.com', { cadence: 'daily', owner: 'microsoft', repo: 'playwright' }],
  ['github_search', 'GitHub Search Signals', 'metric', 'https://api.github.com', { cadence: 'daily', query: 'topic:typescript stars:>500' }],
  ['stack_exchange', 'Stack Exchange', 'qa_post', 'https://api.stackexchange.com', { cadence: 'daily', site: 'stackoverflow', tag: 'typescript' }],
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
  console.log(`seeded ${sources.length} MVP sources`);
} finally {
  await pool.end();
}
