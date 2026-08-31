// EXP-005: can Testcontainers provide the integration environment on this runtime?
// Boots a real pgvector container, applies a migration, and runs a vector query.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

let container;
let pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
}, 180000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
}, 60000);

describe('testcontainers pgvector', () => {
  it('applies migration on an empty database', async () => {
    await pool.query('create extension if not exists vector');
    await pool.query(`
      create table document_revisions (
        id bigserial primary key,
        document_id bigint not null,
        normalized_hash text not null,
        published_at timestamptz,
        license_id text,
        status text not null default 'draft',
        unique (document_id, normalized_hash)
      )`);
    await pool.query('create table chunks (id bigserial primary key, revision_id bigint not null, ordinal int not null, embedding vector(3), unique (revision_id, ordinal))');
    const t = await pool.query(
      "select table_name from information_schema.tables where table_schema='public' order by 1",
    );
    expect(t.rows.map((r) => r.table_name)).toEqual(['chunks', 'document_revisions']);
  });

  it('enforces revision uniqueness', async () => {
    await pool.query(
      "insert into document_revisions (document_id, normalized_hash) values (1, 'h1')",
    );
    await expect(
      pool.query("insert into document_revisions (document_id, normalized_hash) values (1, 'h1')"),
    ).rejects.toThrow();
    const n = await pool.query('select count(*)::int as n from document_revisions');
    expect(n.rows[0].n).toBe(1);
  });

  it('runs a time-filtered vector query', async () => {
    await pool.query(
      "insert into document_revisions (document_id, normalized_hash, published_at, status) values (2,'h2','2026-08-26T00:00:00Z','published'), (3,'h3','2026-07-01T00:00:00Z','published')",
    );
    await pool.query("insert into chunks (revision_id, ordinal, embedding) values (2,0,'[1,0,0]'), (3,0,'[0.95,0.05,0]')");
    const r = await pool.query(
      `select c.revision_id
         from chunks c
         join document_revisions d on d.document_id = c.revision_id
        where d.status = 'published'
          and d.published_at >= $1 and d.published_at < $2
        order by c.embedding <=> $3
        limit 5`,
      ['2026-08-25T00:00:00Z', '2026-09-01T00:00:00Z', '[1,0,0]'],
    );
    // only revision 2 falls inside the window; revision 3 is filtered out by time
    expect(r.rows.map((x) => Number(x.revision_id))).toEqual([2]);
  });
});
