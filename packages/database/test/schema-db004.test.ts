import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { metricObservations, queryRuns, answerCitations } from '../src/schema/index.js';

describe('Database Schema DB-004 definition', () => {
  test('exports all DB-004 tables', () => {
    assert(metricObservations);
    assert(queryRuns);
    assert(answerCitations);
  });

  test('metric_observations table has correct columns and types', () => {
    assert.equal(metricObservations.sourceId.name, 'source_id');
    assert.equal(metricObservations.topicId.name, 'topic_id');
    assert.equal(metricObservations.subjectKey.name, 'subject_key');
    assert.equal(metricObservations.metricType.name, 'metric_type');
    assert.equal(metricObservations.windowStart.name, 'window_start');
    assert.equal(metricObservations.windowEnd.name, 'window_end');
    assert.equal(metricObservations.value.name, 'value');
    assert.equal(metricObservations.unit.name, 'unit');
    assert.equal(metricObservations.querySignature.name, 'query_signature');
    assert.equal(metricObservations.isIncomplete.name, 'is_incomplete');
  });

  test('query_runs table has correct columns and types', () => {
    assert.equal(queryRuns.requestId.name, 'request_id');
    assert.equal(queryRuns.questionHash.name, 'question_hash');
    assert.equal(queryRuns.parsedQuery.name, 'parsed_query');
    assert.equal(queryRuns.workflowVersion.name, 'workflow_version');
    assert.equal(queryRuns.status.name, 'status');
  });

  test('answer_citations table has correct columns and types', () => {
    assert.equal(answerCitations.queryRunId.name, 'query_run_id');
    assert.equal(answerCitations.citationKey.name, 'citation_key');
    assert.equal(answerCitations.chunkId.name, 'chunk_id');
    assert.equal(answerCitations.documentRevisionId.name, 'document_revision_id');
    assert.equal(answerCitations.claimIndex.name, 'claim_index');
    assert.equal(answerCitations.excerpt.name, 'excerpt');
  });
});
