<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiClient, ApiClientError } from '../api-client.js';
  import type { TopicSearchQuery, TopicSummary } from '@techpulse/contracts';

  interface Props {
    client: ApiClient;
  }

  let { client }: Props = $props();

  let searchQuery = $state('');
  let loading = $state(true);
  let searching = $state(false);
  let loadingMore = $state(false);
  let topics = $state<TopicSummary[]>([]);
  let nextCursor = $state<string | null>(null);
  let errorMessage = $state<string | null>(null);
  let executedQuery = $state('');

  async function fetchTopics(q: string = '', cursor?: string) {
    errorMessage = null;
    try {
      const queryParams: TopicSearchQuery = { limit: 20 };
      if (q.trim().length > 0) {
        queryParams.q = q.trim();
      }
      if (cursor) {
        queryParams.cursor = cursor;
      }

      const response = await client.listTopics(queryParams);
      if (cursor) {
        topics = [...topics, ...response.items];
      } else {
        topics = response.items;
      }
      nextCursor = response.page.nextCursor;
      executedQuery = q.trim();
    } catch (err) {
      if (err instanceof ApiClientError) {
        errorMessage = `Failed to fetch topics (${err.code}): ${err.message}`;
      } else if (err instanceof Error) {
        errorMessage = err.message;
      } else {
        errorMessage = 'An error occurred while fetching topics';
      }
    } finally {
      loading = false;
      searching = false;
      loadingMore = false;
    }
  }

  async function handleSearch(e?: { preventDefault: () => void }) {
    e?.preventDefault();
    searching = true;
    await fetchTopics(searchQuery);
  }

  async function handleClear() {
    searchQuery = '';
    searching = true;
    await fetchTopics('');
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    loadingMore = true;
    await fetchTopics(executedQuery, nextCursor);
  }

  onMount(() => {
    fetchTopics();
  });
</script>

<section class="topics-panel" aria-labelledby="topics-heading" id="panel-topics">
  <div class="panel-header">
    <div>
      <h2 id="topics-heading" class="panel-title">기술 토픽 카탈로그</h2>
      <p class="panel-description">결정적 별칭과 계층 구조로 정리된 표준 기술 토픽을 탐색합니다.</p>
    </div>

    <form class="search-form" role="search" onsubmit={handleSearch}>
      <label for="topic-search-input" class="visually-hidden">Search Canonical Topics</label>
      <div class="search-input-wrap">
        <input
          id="topic-search-input"
          type="search"
          placeholder="Search by topic name, alias, or slug..."
          bind:value={searchQuery}
          class="search-input"
          aria-label="Search canonical topics"
        />
        {#if searchQuery}
          <button
            type="button"
            class="clear-btn"
            onclick={handleClear}
            aria-label="Clear topic search query"
          >
            &times;
          </button>
        {/if}
      </div>
      <button type="submit" class="search-submit-btn" disabled={searching}>
        {#if searching}
          <span class="spinner" aria-hidden="true"></span>
        {:else}
          Search
        {/if}
      </button>
    </form>
  </div>

  {#if loading}
    <div class="state-container loading-state" role="status" aria-busy="true" aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      <span>Loading topic taxonomy...</span>
    </div>
  {:else if errorMessage}
    <div class="state-container error-state" role="alert" aria-live="assertive">
      <div class="error-badge" aria-hidden="true">!</div>
      <div class="error-content">
        <strong>Error Loading Topics</strong>
        <p>{errorMessage}</p>
        <button type="button" class="retry-btn" onclick={() => fetchTopics(searchQuery)}
          >Retry</button
        >
      </div>
    </div>
  {:else if topics.length === 0}
    <div class="state-container empty-state" role="region" aria-label="No topics found">
      <p>
        No canonical topics found matching <strong>"{executedQuery}"</strong>.
      </p>
      <button type="button" class="reset-search-btn" onclick={handleClear}>View All Topics</button>
    </div>
  {:else}
    <div class="topic-grid" role="list">
      {#each topics as topic (topic.slug)}
        <article class="topic-card" role="listitem" aria-labelledby={`topic-${topic.slug}`}>
          <div class="topic-top">
            <h3 id={`topic-${topic.slug}`} class="topic-title">{topic.displayName}</h3>
            <span class="topic-slug"><code>{topic.slug}</code></span>
          </div>

          <div class="topic-details">
            {#if topic.parent}
              <div class="meta-row">
                <span class="meta-label">Parent Domain:</span>
                <span class="meta-val parent-tag">{topic.parent}</span>
              </div>
            {/if}
            <div class="meta-row">
              <span class="meta-label">Taxonomy Version:</span>
              <span class="meta-val">{topic.taxonomyVersion}</span>
            </div>

            {#if topic.aliases.length > 0}
              <div class="aliases-wrap">
                <span class="meta-label">Recognized Aliases:</span>
                <div class="alias-chips">
                  {#each topic.aliases as alias (alias)}
                    <span class="alias-chip">{alias}</span>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
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
          aria-label="Load more topics"
        >
          {#if loadingMore}
            <span class="spinner" aria-hidden="true"></span> Loading more...
          {:else}
            Load More Topics
          {/if}
        </button>
      </div>
    {/if}
  {/if}
</section>

<style>
  .topics-panel {
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

  .search-form {
    display: flex;
    gap: 8px;
    align-items: center;
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

  .search-input-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  .search-input {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 6px;
    color: #f8fafc;
    padding: 8px 32px 8px 14px;
    font-size: 13px;
    width: 260px;
  }

  .search-input:focus-visible {
    outline: 2px solid #38bdf8;
    border-color: #38bdf8;
  }

  .clear-btn {
    position: absolute;
    right: 8px;
    background: transparent;
    border: none;
    color: #94a3b8;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 2px 4px;
  }
  .clear-btn:hover {
    color: #f8fafc;
  }

  .search-submit-btn {
    background: #0284c7;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 70px;
  }
  .search-submit-btn:hover:not(:disabled) {
    background: #0369a1;
  }
  .search-submit-btn:focus-visible {
    outline: 2px solid #38bdf8;
  }
  .search-submit-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
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
    flex-direction: column;
    justify-content: center;
    border: 1px dashed #334155;
    gap: 8px;
  }

  .reset-search-btn {
    background: #1e293b;
    border: 1px solid #334155;
    color: #38bdf8;
    border-radius: 4px;
    padding: 6px 12px;
    font-size: 12px;
    cursor: pointer;
  }
  .reset-search-btn:hover {
    background: #334155;
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

  .topic-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
  }

  .topic-card {
    background: #1e293b80;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }

  .topic-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 12px;
  }

  .topic-title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: #f8fafc;
  }

  .topic-slug code {
    background: #0f172a;
    color: #38bdf8;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
  }

  .topic-details {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .meta-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
  }

  .meta-label {
    color: #94a3b8;
  }

  .meta-val {
    color: #e2e8f0;
  }

  .parent-tag {
    background: #334155;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
  }

  .aliases-wrap {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid #33415560;
  }

  .alias-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }

  .alias-chip {
    background: #0f172a;
    color: #94a3b8;
    border: 1px solid #334155;
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 11px;
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
