import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import { createDatabaseClient, DEFAULT_MIGRATIONS_FOLDER } from '../src/index.js';

describe('migration files and metadata structure', () => {
  test('DEFAULT_MIGRATIONS_FOLDER resolves and contains migration files', () => {
    assert.equal(existsSync(DEFAULT_MIGRATIONS_FOLDER), true);

    const sqlMigrationPath = resolve(DEFAULT_MIGRATIONS_FOLDER, '0000_bootstrap_pgvector.sql');
    assert.equal(existsSync(sqlMigrationPath), true);

    const sqlContent = readFileSync(sqlMigrationPath, 'utf8');
    assert.match(sqlContent, /CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+vector;/iu);
  });

  test('meta/_journal.json exists and defines required Drizzle migration entries', () => {
    const journalPath = resolve(DEFAULT_MIGRATIONS_FOLDER, 'meta/_journal.json');
    assert.equal(existsSync(journalPath), true);

    const rawJournal = readFileSync(journalPath, 'utf8');
    const journal = JSON.parse(rawJournal) as {
      entries?: Array<{ tag?: string; version?: string }>;
    };

    assert.ok(Array.isArray(journal.entries));
    assert.equal(journal.entries.length, 6);
    assert.equal(journal.entries[0]?.tag, '0000_bootstrap_pgvector');
    assert.equal(journal.entries[1]?.tag, '0001_complete_puck');
    assert.equal(journal.entries[2]?.tag, '0002_mature_post');
    assert.equal(journal.entries[3]?.tag, '0003_amusing_stone_men');
    assert.equal(journal.entries[4]?.tag, '0004_pale_ironclad');
    assert.equal(journal.entries[5]?.tag, '0005_gray_domino');
  });

  test('meta/0000_snapshot.json exists and defines schema snapshot', () => {
    const snapshotPath = resolve(DEFAULT_MIGRATIONS_FOLDER, 'meta/0000_snapshot.json');
    assert.equal(existsSync(snapshotPath), true);

    const rawSnapshot = readFileSync(snapshotPath, 'utf8');
    const snapshot = JSON.parse(rawSnapshot) as { dialect?: string };
    assert.equal(snapshot.dialect, 'postgresql');
  });

  test('PIPE-004 migration defines append-only versioned membership constraints', () => {
    const migration = readFileSync(
      resolve(DEFAULT_MIGRATIONS_FOLDER, '0005_gray_domino.sql'),
      'utf8',
    );
    assert.match(migration, /CREATE TABLE "duplicate_cluster_memberships"/u);
    assert.match(
      migration,
      /UNIQUE\("cluster_id","document_id","revision_id","algorithm_version"\)/u,
    );
    assert.match(migration, /ON DELETE restrict/u);
    assert.match(migration, /'suggested', 'accepted', 'superseded'/u);
  });
});

const databaseUrl = process.env['DATABASE_URL'];
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration('PostgreSQL Compose real migration integration', () => {
  test('applies first migration twice idempotently, verifying pgvector and metadata', async () => {
    const client = createDatabaseClient({
      databaseUrl: databaseUrl as string,
    });

    try {
      // 1. Verify explicit connection
      await client.connect();
      assert.equal(client.isConnected, true);

      // 2. Verify health check
      const healthy = await client.checkHealth();
      assert.equal(healthy, true);

      // 3. First migration run
      const firstResult = await client.migrate();
      assert.equal(firstResult.applied, true);

      // 4. Verify vector extension was bootstrapped
      const vectorInfoFirst = await client.checkVector();
      assert.equal(vectorInfoFirst.installed, true);
      assert.ok(vectorInfoFirst.version);

      // 5. Verify Drizzle migration metadata was recorded
      const firstMigrations = await client.pool.query<{
        id: number;
        hash: string;
        created_at: string;
      }>('SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id ASC;');

      assert.equal(firstMigrations.rows.length, 5);
      const recordedHash = firstMigrations.rows[0]?.hash;
      assert.ok(recordedHash);

      // 6. Second migration run (idempotency check)
      const secondResult = await client.migrate();
      assert.equal(secondResult.applied, true);

      // 7. Verify vector extension remains active and valid
      const vectorInfoSecond = await client.checkVector();
      assert.equal(vectorInfoSecond.installed, true);

      // 8. Verify migration metadata was NOT duplicated
      const secondMigrations = await client.pool.query<{
        id: number;
        hash: string;
        created_at: string;
      }>('SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id ASC;');
      assert.equal(secondMigrations.rows.length, 5);

      // 9. Execute smoke pgvector query to verify vector calculations
      const queryResult = await client.pool.query<{
        dist: number;
      }>("SELECT ('[1,0,0]'::vector <=> '[1,0,0]'::vector) AS dist;");

      assert.equal(queryResult.rows.length, 1);
      assert.equal(Number(queryResult.rows[0]?.dist), 0);
    } finally {
      await client.close();
    }
  });
});
