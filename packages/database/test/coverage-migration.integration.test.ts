import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabaseClient, DEFAULT_MIGRATIONS_FOLDER } from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL_DIRECT'] ?? process.env['DATABASE_URL'];
const suite = databaseUrl ? describe : describe.skip;
suite('coverage forward migration', () => {
  it('preserves an existing immutable citation while upgrading the baseline database', async () => {
    const rootUrl = new URL(databaseUrl as string);
    if (!['127.0.0.1','localhost','postgres','postgres-persistent'].includes(rootUrl.hostname)) throw new Error('Forward migration drill requires a local isolated PostgreSQL server');
    const admin = createDatabaseClient(rootUrl.toString());
    const databaseName = `coverage_forward_${randomUUID().replaceAll('-', '')}`;
    const temporaryFolder = await mkdtemp(join(tmpdir(), 'coverage-baseline-'));
    const url = new URL(rootUrl); url.pathname = `/${databaseName}`;
    const client = createDatabaseClient(url.toString());
    let created = false;
    try {
      await admin.db.execute(sql.raw(`CREATE DATABASE "${databaseName}"`));
      created = true;
      const journal = JSON.parse(await readFile(join(DEFAULT_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { version: string; dialect: string; entries: { idx: number; tag: string }[] };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 6);
      await mkdir(join(temporaryFolder, 'meta'));
      await writeFile(join(temporaryFolder, 'meta', '_journal.json'), JSON.stringify(journal));
      for (const entry of journal.entries) await copyFile(join(DEFAULT_MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(temporaryFolder, `${entry.tag}.sql`));
      await client.migrate({ migrationsFolder: temporaryFolder });
      const seeded = await client.db.execute<{ id: string; chunk_id: string; document_revision_id: string }>(sql`
        WITH d AS (INSERT INTO documents(artifact_type, canonical_url) VALUES ('article','https://example.com/authored-migration-fixture') RETURNING id),
        r AS (INSERT INTO document_revisions(document_id,title,body_text,normalized_hash,normalizer_version,status)
          SELECT id,'Authored fixture','Immutable citation body',repeat('a',64),'1','searchable' FROM d RETURNING id),
        c AS (INSERT INTO chunks(document_revision_id,ordinal,content,token_count,content_hash,chunker_version)
          SELECT id,0,'Immutable citation body',3,repeat('a',64),'1' FROM r RETURNING id,document_revision_id),
        q AS (INSERT INTO query_runs(request_id,question_hash,parsed_query,workflow_version) VALUES ('coverage-forward',repeat('b',64),'{}','1') RETURNING id)
        INSERT INTO answer_citations(query_run_id,citation_key,chunk_id,document_revision_id,excerpt)
          SELECT q.id,'C1',c.id,c.document_revision_id,'Immutable citation body' FROM q,c
          RETURNING id,chunk_id,document_revision_id`);
      const original = seeded.rows[0];
      expect(original).toBeDefined();
      await client.migrate();
      const checked = await client.db.execute<{ id: string; chunk_id: string; document_revision_id: string; excerpt: string; content: string; canonical_url: string; lexical_ready_at: Date | null }>(sql`
        SELECT a.id,a.chunk_id,a.document_revision_id,a.excerpt,c.content,d.canonical_url,r.lexical_ready_at
        FROM answer_citations a JOIN chunks c ON c.id=a.chunk_id JOIN document_revisions r ON r.id=a.document_revision_id JOIN documents d ON d.id=r.document_id
        WHERE a.id=${original?.id}`);
      expect(checked.rows[0]).toMatchObject({ ...original, excerpt: 'Immutable citation body', content: 'Immutable citation body',
        canonical_url: 'https://example.com/authored-migration-fixture', lexical_ready_at: null });
      expect((await client.checkVector()).installed).toBe(true);
    } finally {
      await client.close();
      if (created) await admin.db.execute(sql.raw(`DROP DATABASE "${databaseName}"`));
      await admin.close();
      await rm(temporaryFolder, { recursive: true, force: true });
    }
  }, 30000);
});
