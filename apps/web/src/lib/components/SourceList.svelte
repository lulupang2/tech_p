<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiClient, ApiClientError } from '../api-client.js';
  import type { SourceListQuery, SourceSummary } from '@techpulse/contracts';

  interface Props {
    client: ApiClient;
  }

  let { client }: Props = $props();

  let loading = $state(true);
  let loadingMore = $state(false);
  let sources = $state<SourceSummary[]>([]);
  let nextCursor = $state<string | null>(null);
  let errorMessage = $state<string | null>(null);
  let filterTerm = $state('');
  let selectedSourceKey = $state<string | null>(null);

  let filteredSources = $derived(
    filterTerm.trim().length === 0
      ? sources
      : sources.filter(
          (s) =>
            s.displayName.toLowerCase().includes(filterTerm.trim().toLowerCase()) ||
            s.key.toLowerCase().includes(filterTerm.trim().toLowerCase()) ||
            s.kind.toLowerCase().includes(filterTerm.trim().toLowerCase()),
        ),
  );

  async function loadSources() {
    loading = true;
    errorMessage = null;
    try {
      const response = await client.listSources({ limit: 20 });
      sources = response.items;
      nextCursor = response.page.nextCursor;
    } catch (err) {
      if (err instanceof ApiClientError) {
        errorMessage = `Failed to load data sources (${err.code}): ${err.message}`;
      } else if (err instanceof Error) {
        errorMessage = err.message;
      } else {
        errorMessage = 'An unexpected error occurred while loading sources';
      }
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    loadingMore = true;
    try {
      const queryParams: SourceListQuery = { cursor: nextCursor, limit: 20 };
      const response = await client.listSources(queryParams);
      sources = [...sources, ...response.items];
      nextCursor = response.page.nextCursor;
    } catch (err) {
      if (err instanceof ApiClientError) {
        errorMessage = `Failed to load more sources (${err.code}): ${err.message}`;
      }
    } finally {
      loadingMore = false;
    }
  }

  function toggleExpand(key: string) {
    selectedSourceKey = selectedSourceKey === key ? null : key;
  }

  onMount(() => {
    loadSources();
  });
</script>

<section class="sources-panel" aria-labelledby="sources-heading" id="panel-sources">
  <div class="panel-header">
    <div>
      <h2 id="sources-heading" class="panel-title">Approved Data Sources</h2>
      <p class="panel-description">
        Catalog of verified technical data sources, rights profiles, and collection freshness.
      </p>
    </div>
    <div class="filter-box" role="search">
      <label for="source-filter" class="visually-hidden">Filter data sources</label>
      <input
        id="source-filter"
        type="search"
        placeholder="Filter sources (e.g. github, npm, arxiv)..."
        bind:value={filterTerm}
        class="filter-input"
        aria-label="Filter data sources"
      />
    </div>
  </div>

  {#if loading}
    <div class="state-container loading-state" role="status" aria-busy="true" aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      <span>Loading approved data source catalog...</span>
    </div>
  {:else if errorMessage}
    <div class="state-container error-state" role="alert" aria-live="assertive">
      <div class="error-badge" aria-hidden="true">!</div>
      <div class="error-content">
        <strong>Error Loading Sources</strong>
        <p>{errorMessage}</p>
        <button type="button" class="retry-btn" onclick={loadSources}>Retry</button>
      </div>
    </div>
  {:else if filteredSources.length === 0}
    <div class="state-container empty-state" role="region" aria-label="No data sources found">
      <p>No data sources match the filter <strong>"{filterTerm}"</strong>.</p>
    </div>
  {:else}
    <div class="source-grid" role="list">
      {#each filteredSources as source (source.key)}
        <article
          class="source-card"
          role="listitem"
          aria-labelledby={`source-title-${source.key}`}
          class:expanded={selectedSourceKey === source.key}
        >
          <div class="card-header">
            <div>
              <h3 id={`source-title-${source.key}`} class="source-name">{source.displayName}</h3>
              <span class="source-key"><code>{source.key}</code></span>
            </div>
            <span
              class="status-badge"
              class:healthy={source.status === 'healthy'}
              class:stale={source.status === 'stale'}
              class:degraded={source.status === 'degraded'}
              class:disabled={source.status === 'disabled'}
              aria-label={`Source status: ${source.status}`}
            >
              {source.status}
            </span>
          </div>

          <div class="card-body">
            <div class="info-row">
              <span class="info-label">Kind:</span>
              <span class="info-value">{source.kind}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Fresh Through:</span>
              <span class="info-value">
                {#if source.freshThrough}
                  <time datetime={source.freshThrough}>{source.freshThrough}</time>
                {:else}
                  <span class="muted">Not collected yet</span>
                {/if}
              </span>
            </div>
            <div class="info-row">
              <span class="info-label">Last Successful:</span>
              <span class="info-value">
                {#if source.lastSuccessfulCollectionAt}
                  <time datetime={source.lastSuccessfulCollectionAt}
                    >{source.lastSuccessfulCollectionAt}</time
                  >
                {:else}
                  <span class="muted">None</span>
                {/if}
              </span>
            </div>

            {#if source.coverageNotes.length > 0}
              <div class="notes-section">
                <span class="info-label">Coverage &amp; Rights Notes:</span>
                <ul class="notes-list">
                  {#each source.coverageNotes as note, idx (idx)}
                    <li>{note}</li>
                  {/each}
                </ul>
              </div>
            {/if}
          </div>

          <div class="card-footer">
            <button
              type="button"
              class="details-btn"
              onclick={() => toggleExpand(source.key)}
              aria-expanded={selectedSourceKey === source.key}
              aria-controls={`details-${source.key}`}
            >
              {selectedSourceKey === source.key ? 'Hide Details' : 'View Details'}
            </button>
          </div>

          {#if selectedSourceKey === source.key}
            <div id={`details-${source.key}`} class="source-details-expanded" role="region">
              <h4>Source Specifications</h4>
              <p class="detail-line"><strong>Identifier:</strong> {source.key}</p>
              <p class="detail-line"><strong>Data Category:</strong> {source.kind}</p>
              <p class="detail-line"><strong>Current Ingestion Status:</strong> {source.status}</p>
              <p class="detail-guidance">
                All raw payloads undergo strict personal data redaction prior to persistent storage.
                Rights and license restrictions are preserved in immutable document revisions.
              </p>
            </div>
          {/if}
        </article>
      {/each}
    </div>

    {#if nextCursor}
      <div class="load-more-container">
        <button
          type="button"
          class="load-more-btn"
          onclick={loadMore}
          disabled={loadingMore}
          aria-label="Load more data sources"
        >
          {#if loadingMore}
            <span class="spinner" aria-hidden="true"></span> Loading more...
          {:else}
            Load More Sources
          {/if}
        </button>
      </div>
    {/if}
  {/if}
</section>

<style>
  .sources-panel {
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 12px;
    padding: 24px;
    margin-bottom: 24px;
    color: #f8fafc;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 16px;
    margin-bottom: 20px;
    border-bottom: 1px solid #1e293b;
    padding-bottom: 16px;
  }

  .panel-title {
    margin: 0 0 4px 0;
    font-size: 18px;
    font-weight: 700;
  }

  .panel-description {
    margin: 0;
    font-size: 13px;
    color: #94a3b8;
  }

  .filter-box {
    display: flex;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .filter-input {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 6px;
    color: #f8fafc;
    padding: 8px 14px;
    font-size: 13px;
    width: 260px;
  }

  .filter-input:focus-visible {
    outline: 2px solid #38bdf8;
    border-color: #38bdf8;
  }

  .state-container {
    padding: 24px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .loading-state {
    background: #1e293b40;
    color: #94a3b8;
    font-size: 14px;
    justify-content: center;
  }

  .empty-state {
    background: #1e293b40;
    color: #94a3b8;
    font-size: 14px;
    justify-content: center;
    border: 1px dashed #334155;
  }

  .error-state {
    background: #450a0a33;
    border: 1px solid #7f1d1d;
    color: #fca5a5;
  }

  .error-badge {
    width: 28px;
    height: 28px;
    background: #dc2626;
    color: #fff;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    flex-shrink: 0;
  }

  .error-content {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .error-content p {
    margin: 0;
    font-size: 13px;
    color: #fecaca;
  }

  .retry-btn {
    align-self: flex-start;
    margin-top: 8px;
    background: #b91c1c;
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .retry-btn:hover {
    background: #991b1b;
  }
  .retry-btn:focus-visible {
    outline: 2px solid #fca5a5;
    outline-offset: 2px;
  }

  .source-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 16px;
  }

  .source-card {
    background: #1e293b80;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    transition: border-color 0.15s ease-in-out;
  }

  .source-card:hover {
    border-color: #475569;
  }

  .source-card.expanded {
    border-color: #0284c7;
    background: #0f172a;
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 12px;
  }

  .source-name {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: #f8fafc;
  }

  .source-key {
    font-size: 12px;
    color: #38bdf8;
  }

  .source-key code {
    background: #0f172a;
    padding: 1px 4px;
    border-radius: 3px;
  }

  .status-badge {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: 9999px;
  }

  .status-badge.healthy {
    background: #065f46;
    color: #a7f3d0;
  }

  .status-badge.stale {
    background: #854d0e;
    color: #fef08a;
  }

  .status-badge.degraded {
    background: #9a3412;
    color: #fed7aa;
  }

  .status-badge.disabled {
    background: #475569;
    color: #cbd5e1;
  }

  .card-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }

  .info-label {
    color: #94a3b8;
    font-size: 12px;
  }

  .info-value {
    color: #e2e8f0;
    font-size: 12px;
    text-align: right;
  }

  .muted {
    color: #64748b;
  }

  .notes-section {
    margin-top: 4px;
    padding-top: 8px;
    border-top: 1px solid #33415580;
  }

  .notes-list {
    margin: 4px 0 0 0;
    padding-left: 16px;
    color: #cbd5e1;
    font-size: 12px;
  }

  .card-footer {
    margin-top: 12px;
    padding-top: 8px;
    display: flex;
    justify-content: flex-end;
  }

  .details-btn {
    background: transparent;
    color: #38bdf8;
    border: 1px solid #0284c740;
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    font-weight: 500;
  }

  .details-btn:hover {
    background: #0284c720;
    border-color: #0284c7;
  }

  .details-btn:focus-visible {
    outline: 2px solid #38bdf8;
  }

  .source-details-expanded {
    margin-top: 12px;
    padding: 12px;
    background: #1e293b;
    border-radius: 6px;
    border-left: 3px solid #0284c7;
  }

  .source-details-expanded h4 {
    margin: 0 0 8px 0;
    font-size: 13px;
    color: #38bdf8;
  }

  .detail-line {
    margin: 4px 0;
    font-size: 12px;
    color: #cbd5e1;
  }

  .detail-guidance {
    margin: 8px 0 0 0;
    font-size: 11px;
    color: #94a3b8;
    line-height: 1.4;
  }

  .load-more-container {
    display: flex;
    justify-content: center;
    margin-top: 20px;
  }

  .load-more-btn {
    background: #1e293b;
    color: #f8fafc;
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 8px 20px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .load-more-btn:hover:not(:disabled) {
    background: #334155;
  }

  .load-more-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid #38bdf840;
    border-top-color: #38bdf8;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    display: inline-block;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
