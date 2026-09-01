import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import { DEFAULT_MIGRATIONS_FOLDER } from '../src/index.js';

describe('DB-002 schema migration', () => {
  test('defines raw revision identity and provenance constraints', () => {
    const migration = readFileSync(
      resolve(DEFAULT_MIGRATIONS_FOLDER, '0001_complete_puck.sql'),
      'utf8',
    );
    assert.match(migration, /UNIQUE\("source_id","external_id","payload_hash"\)/u);
    assert.match(migration, /"canonical_url" text NOT NULL/u);
    assert.match(migration, /"payload" jsonb NOT NULL/u);
    assert.match(migration, /timestamp with time zone DEFAULT now\(\)/u);
    assert.match(migration, /raw_items_run_id_collection_runs_id_fk/u);
    assert.match(migration, /pipeline_events_raw_item_id_raw_items_id_fk/u);
    const followUp = readFileSync(
      resolve(DEFAULT_MIGRATIONS_FOLDER, '0002_mature_post.sql'),
      'utf8',
    );
    assert.match(followUp, /raw_items_source_run_consistency_fk/u);
    assert.match(followUp, /CREATE TRIGGER raw_items_immutable_mutation/u);
    assert.match(followUp, /CREATE TRIGGER pipeline_events_append_only/u);
    assert.ok(
      followUp.indexOf('collection_runs_source_id_unique') <
        followUp.indexOf('raw_items_source_run_consistency_fk'),
    );
  });

  test('migration creates parent tables before foreign-key constraints', () => {
    const migration = readFileSync(
      resolve(DEFAULT_MIGRATIONS_FOLDER, '0001_complete_puck.sql'),
      'utf8',
    );
    assert.ok(
      migration.indexOf('CREATE TABLE "sources"') <
        migration.indexOf('ALTER TABLE "raw_items" ADD CONSTRAINT'),
    );
    assert.ok(
      migration.indexOf('CREATE TABLE "raw_items"') <
        migration.indexOf('ALTER TABLE "pipeline_events" ADD CONSTRAINT'),
    );
  });
});
