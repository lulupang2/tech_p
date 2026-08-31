// EXP-005 queue gate: at-least-once delivery vs business-row idempotency.
// Verifies the EXP-005 gate "동일 job 2회 전달 시 business row 중복 0".
// Requires: redis on 63790, postgres+pgvector on 55432. Disposable spike code.
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import pg from 'pg';

const REDIS = { host: '127.0.0.1', port: 63790, maxRetriesPerRequest: null };
const PG = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'exp005', database: 'exp005' };

const out = { steps: {}, counts: {}, errors: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pool = new pg.Pool(PG);

async function setup() {
  await pool.query('drop table if exists collection_runs');
  await pool.query(`
    create table collection_runs (
      id bigserial primary key,
      source_key text not null,
      window_start timestamptz not null,
      attempts int not null default 1,
      created_at timestamptz not null default now(),
      unique (source_key, window_start)
    )`);
  await pool.query('create extension if not exists vector');
  const v = await pool.query('select extversion from pg_extension where extname = $1', ['vector']);
  out.steps.pgvectorVersion = v.rows[0]?.extversion ?? null;
  const sv = await pool.query('show server_version');
  out.steps.postgresVersion = sv.rows[0].server_version;
}

// business write is idempotent on the natural key, regardless of delivery count
async function recordRun(sourceKey, windowStart) {
  const r = await pool.query(
    `insert into collection_runs (source_key, window_start)
     values ($1, $2)
     on conflict (source_key, window_start)
     do update set attempts = collection_runs.attempts + 1
     returning id, attempts`,
    [sourceKey, windowStart],
  );
  return r.rows[0];
}

async function main() {
  await setup();

  const connection = new IORedis(REDIS);
  await connection.flushdb();

  const queueName = `exp005-${Date.now()}`;
  const queue = new Queue(queueName, { connection });

  let processed = 0;
  let crashedOnce = false;

  const worker = new Worker(
    queueName,
    async (job) => {
      processed += 1;
      // business effect first, then simulate a crash after commit.
      const row = await recordRun(job.data.sourceKey, job.data.windowStart);
      if (job.data.crashAfterCommit && !crashedOnce) {
        crashedOnce = true;
        throw new Error('simulated crash after commit');
      }
      return row;
    },
    { connection: new IORedis(REDIS), concurrency: 2 },
  );

  const w0 = '2026-09-01T00:00:00Z';

  // 1) same explicit jobId twice -> BullMQ should keep one job
  await queue.add('collect', { sourceKey: 'github_releases', windowStart: w0 }, { jobId: 'fixed-1' });
  await queue.add('collect', { sourceKey: 'github_releases', windowStart: w0 }, { jobId: 'fixed-1' });

  // 2) different jobIds, identical payload -> handler must be idempotent
  await queue.add('collect', { sourceKey: 'stack_exchange', windowStart: w0 });
  await queue.add('collect', { sourceKey: 'stack_exchange', windowStart: w0 });

  // 3) crash after commit, then retry -> must not duplicate the business row
  await queue.add(
    'collect',
    { sourceKey: 'arxiv', windowStart: w0, crashAfterCommit: true },
    { attempts: 3, backoff: { type: 'fixed', delay: 200 } },
  );

  // wait for drain
  for (let i = 0; i < 60; i += 1) {
    await sleep(300);
    const counts = await queue.getJobCounts('active', 'waiting', 'delayed', 'completed', 'failed');
    if (counts.active === 0 && counts.waiting === 0 && counts.delayed === 0) {
      out.counts.jobCounts = counts;
      break;
    }
  }

  out.counts.handlerInvocations = processed;
  out.counts.crashSimulated = crashedOnce;

  const total = await pool.query('select count(*)::int as n from collection_runs');
  out.counts.businessRows = total.rows[0].n;

  const rows = await pool.query(
    'select source_key, attempts from collection_runs order by source_key',
  );
  out.counts.perSource = rows.rows;

  const dup = await pool.query(`
    select source_key, window_start, count(*)::int as n
    from collection_runs group by 1,2 having count(*) > 1`);
  out.counts.duplicateNaturalKeys = dup.rowCount;

  // pgvector smoke: store and query a vector
  await pool.query('drop table if exists exp_vec');
  await pool.query('create table exp_vec (id serial primary key, embedding vector(3))');
  await pool.query("insert into exp_vec (embedding) values ('[1,0,0]'), ('[0,1,0]'), ('[0.9,0.1,0]')");
  const near = await pool.query("select id from exp_vec order by embedding <=> '[1,0,0]' limit 2");
  out.steps.pgvectorNearestIds = near.rows.map((r) => r.id);

  await worker.close();
  await queue.close();
  await connection.quit();
  await pool.end();
}

main()
  .then(() => {
    out.verdict = {
      businessRowsIs3: out.counts.businessRows === 3,
      noDuplicateNaturalKeys: out.counts.duplicateNaturalKeys === 0,
      atLeastOnceObserved: out.counts.handlerInvocations > 3,
      pgvectorWorks: Array.isArray(out.steps.pgvectorNearestIds) && out.steps.pgvectorNearestIds.length === 2,
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  })
  .catch((e) => {
    out.errors.push(e.message);
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  });
