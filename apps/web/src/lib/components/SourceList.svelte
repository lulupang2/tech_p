<script lang="ts">
  import { onMount } from 'svelte';
  import { locale, type Locale } from '$lib/i18n.js';
  import { ApiClient, ApiClientError } from '../api-client.js';
  import type { SourceListQuery, SourceSummary } from '@techpulse/contracts';

  interface Props {
    client: ApiClient;
  }

  let { client }: Props = $props();
  let currentLocale = $state<Locale>('ko');
  locale.subscribe((value) => (currentLocale = value));

  let loading = $state(true);
  let loadingMore = $state(false);
  let sources = $state<SourceSummary[]>([]);
  let nextCursor = $state<string | null>(null);
  let errorMessage = $state<string | null>(null);
  let filterTerm = $state('');
  let selectedSourceKey = $state<string | null>(null);
  type StatusFilter = 'all' | 'healthy' | 'stale' | 'degraded' | 'disabled';
  let selectedStatusFilter = $state<StatusFilter>('all');

  function formatUtcDateTime(isoString: string | null | undefined): string {
    if (!isoString) return '수집 기록 없음';
    try {
      const d = new Date(isoString);
      if (Number.isNaN(d.getTime())) return isoString;
      return d.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
    } catch {
      return String(isoString);
    }
  }

  let statusCounts = $derived.by(() => {
    let healthy = 0;
    let stale = 0;
    let degraded = 0;
    let disabled = 0;
    for (const s of sources) {
      if (s.status === 'healthy') healthy++;
      else if (s.status === 'stale') stale++;
      else if (s.status === 'degraded') degraded++;
      else if (s.status === 'disabled') disabled++;
    }
    return { total: sources.length, healthy, stale, degraded, disabled };
  });

  let filteredSources = $derived.by(() => {
    return sources.filter((s) => {
      const matchesStatus = selectedStatusFilter === 'all' || s.status === selectedStatusFilter;
      const term = filterTerm.trim().toLowerCase();
      const matchesTerm =
        term.length === 0 ||
        s.displayName.toLowerCase().includes(term) ||
        s.key.toLowerCase().includes(term) ||
        s.kind.toLowerCase().includes(term);
      return matchesStatus && matchesTerm;
    });
  });
  async function loadSources() {
    loading = true;
    errorMessage = null;
    try {
      const response = await client.listSources({ limit: 20 });
      sources = response.items;
      nextCursor = response.page.nextCursor;
    } catch (err) {
      if (err instanceof ApiClientError) {
        errorMessage = `${currentLocale === 'ko' ? '데이터 소스를 불러오지 못했습니다' : 'Failed to load data sources'} (${err.code}): ${err.message}`;
      } else if (err instanceof Error) {
        errorMessage = err.message;
      } else {
        errorMessage =
          currentLocale === 'ko'
            ? '소스를 불러오는 중 예기치 않은 오류가 발생했습니다'
            : 'An unexpected error occurred while loading sources';
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
        errorMessage = `${currentLocale === 'ko' ? '소스를 더 불러오지 못했습니다' : 'Failed to load more sources'} (${err.code}): ${err.message}`;
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
      <h2 id="sources-heading" class="panel-title">검증된 데이터 소스</h2>
      <p class="panel-description">수집 중인 기술 데이터의 권리 정책과 최신 상태를 확인합니다.</p>
    </div>
    <div class="filter-box" role="search">
      <label for="source-filter" class="visually-hidden">데이터 소스 필터</label>
      <input
        id="source-filter"
        type="search"
        placeholder="소스 검색 — GitHub, npm, arXiv"
        bind:value={filterTerm}
        class="filter-input"
        aria-label="데이터 소스 필터"
      />
    </div>
  </div>

  <!-- Freshness and Health Summary Bar -->
  <div class="freshness-overview-bar" aria-label="소스 수집 최신성 및 상태 요약">
    <button
      type="button"
      class="overview-filter-btn total"
      class:active={selectedStatusFilter === 'all'}
      onclick={() => (selectedStatusFilter = 'all')}
      aria-pressed={selectedStatusFilter === 'all'}
    >
      <span class="overview-num">{statusCounts.total}</span><span class="overview-label"
        >전체 소스</span
      >
    </button>
    <button
      type="button"
      class="overview-filter-btn healthy"
      class:active={selectedStatusFilter === 'healthy'}
      onclick={() =>
        (selectedStatusFilter = selectedStatusFilter === 'healthy' ? 'all' : 'healthy')}
      aria-pressed={selectedStatusFilter === 'healthy'}
    >
      <span class="overview-num">{statusCounts.healthy}</span><span class="overview-label"
        >정상</span
      >
    </button>
    <button
      type="button"
      class="overview-filter-btn stale"
      class:active={selectedStatusFilter === 'stale'}
      onclick={() => (selectedStatusFilter = selectedStatusFilter === 'stale' ? 'all' : 'stale')}
      aria-pressed={selectedStatusFilter === 'stale'}
    >
      <span class="overview-num">{statusCounts.stale}</span><span class="overview-label"
        >갱신 지연</span
      >
    </button>
    <button
      type="button"
      class="overview-filter-btn degraded"
      class:active={selectedStatusFilter === 'degraded'}
      onclick={() =>
        (selectedStatusFilter = selectedStatusFilter === 'degraded' ? 'all' : 'degraded')}
      aria-pressed={selectedStatusFilter === 'degraded'}
    >
      <span class="overview-num">{statusCounts.degraded}</span><span class="overview-label"
        >성능 저하</span
      >
    </button>
    <button
      type="button"
      class="overview-filter-btn disabled"
      class:active={selectedStatusFilter === 'disabled'}
      onclick={() =>
        (selectedStatusFilter = selectedStatusFilter === 'disabled' ? 'all' : 'disabled')}
      aria-pressed={selectedStatusFilter === 'disabled'}
    >
      <span class="overview-num">{statusCounts.disabled}</span><span class="overview-label"
        >비활성</span
      >
    </button>
  </div>
  {#if loading}
    <div class="state-container loading-state" role="status" aria-busy="true" aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      <span>데이터 소스를 불러오는 중입니다.</span>
    </div>
  {:else if errorMessage}
    <div class="state-container error-state" role="alert" aria-live="assertive">
      <div class="error-badge" aria-hidden="true">!</div>
      <div class="error-content">
        <strong>소스를 불러오지 못했습니다</strong>
        <p>{errorMessage}</p>
        <button type="button" class="retry-btn" onclick={loadSources}>다시 시도</button>
      </div>
    </div>
  {:else if filteredSources.length === 0}
    <div class="state-container empty-state" role="region" aria-label="데이터 소스 없음">
      <p><strong>"{filterTerm}"</strong>와 일치하는 데이터 소스가 없습니다.</p>
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
              aria-label={`${currentLocale === 'ko' ? '소스 상태' : 'Source status'}: ${source.status}`}
            >
              {source.status}
            </span>
          </div>

          <div class="card-body">
            {#if source.status === 'stale' || source.status === 'degraded'}
              <div
                class="source-warning-banner"
                class:stale-banner={source.status === 'stale'}
                class:degraded-banner={source.status === 'degraded'}
                role="region"
                aria-label={`Source ${source.status} warning for ${source.displayName}`}
              >
                <span class="warning-icon" aria-hidden="true">⚠️</span>
                <div class="warning-text-wrap">
                  <strong class="warning-title"
                    >{currentLocale === 'ko' ? '최신성 경고' : 'Freshness Alert'} ({source.status}):</strong
                  >
                  <span class="warning-text">
                    {#if source.status === 'stale'}
                      데이터 수집 주기가 지연(Stale)되었습니다. 최근 게시된 원문 변경사항이 아직
                      색인되지 않았을 수 있습니다.
                    {:else}
                      데이터 수집 또는 정규화 파이프라인에서 오류가 발생(Degraded)하여 일부 지표가
                      누락되었을 수 있습니다.
                    {/if}
                  </span>
                </div>
              </div>
            {/if}

            <div class="info-row">
              <span class="info-label">유형</span>
              <span class="info-value">{source.kind}</span>
            </div>
            <div class="info-row">
              <span class="info-label">최신 데이터</span>
              <span class="info-value">
                {#if source.freshThrough}
                  <time datetime={source.freshThrough}
                    >{formatUtcDateTime(source.freshThrough)}</time
                  >
                {:else}
                  <span class="muted">아직 수집되지 않음</span>
                {/if}
              </span>
            </div>
            <div class="info-row">
              <span class="info-label">최근 성공</span>
              <span class="info-value">
                {#if source.lastSuccessfulCollectionAt}
                  <time datetime={source.lastSuccessfulCollectionAt}
                    >{formatUtcDateTime(source.lastSuccessfulCollectionAt)}</time
                  >
                {:else}
                  <span class="muted">기록 없음</span>
                {/if}
              </span>
            </div>
            {#if source.coverageNotes.length > 0}
              <div class="notes-section">
                <span class="info-label"
                  >{currentLocale === 'ko'
                    ? '수집 범위 및 권리 안내:'
                    : 'Coverage & Rights Notes:'}</span
                >
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
              {selectedSourceKey === source.key ? '상세 닫기' : '상세 보기'}
            </button>
          </div>

          {#if selectedSourceKey === source.key}
            <div id={`details-${source.key}`} class="source-details-expanded" role="region">
              <h4>{currentLocale === 'ko' ? '소스 상세 정보' : 'Source Specifications'}</h4>
              <p class="detail-line">
                <strong>{currentLocale === 'ko' ? '식별자:' : 'Identifier:'}</strong>
                {source.key}
              </p>
              <p class="detail-line">
                <strong>{currentLocale === 'ko' ? '데이터 유형:' : 'Data Category:'}</strong>
                {source.kind}
              </p>
              <p class="detail-line">
                <strong
                  >{currentLocale === 'ko'
                    ? '현재 수집 상태:'
                    : 'Current Ingestion Status:'}</strong
                >
                {source.status}
              </p>
              <p class="detail-guidance">
                {currentLocale === 'ko'
                  ? '모든 원본 payload는 영구 저장 전에 엄격한 개인정보 제거 절차를 거칩니다. 권리와 라이선스 제한은 변경 불가능한 문서 revision에 보존됩니다.'
                  : 'All raw payloads undergo strict personal data redaction prior to persistent storage. Rights and license restrictions are preserved in immutable document revisions.'}
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
          aria-label={currentLocale === 'ko' ? '데이터 소스 더 불러오기' : 'Load more data sources'}
        >
          {#if loadingMore}
            <span class="spinner" aria-hidden="true"></span>
            {currentLocale === 'ko' ? '더 불러오는 중...' : 'Loading more...'}
          {:else}
            {currentLocale === 'ko' ? '소스 더 보기' : 'Load More Sources'}
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

  /* Freshness and Health Summary Bar */
  .freshness-overview-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 20px;
    padding: 12px;
    background: #1e293b50;
    border: 1px solid #334155;
    border-radius: 8px;
  }

  .overview-filter-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid #334155;
    background: #1e293b;
    color: #cbd5e1;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .overview-filter-btn:hover {
    border-color: #64748b;
    background: #334155;
  }

  .overview-filter-btn.active {
    border-color: #38bdf8;
    background: rgba(56, 189, 248, 0.15);
    color: #38bdf8;
  }

  .overview-num {
    font-weight: 800;
    font-size: 13px;
  }

  .overview-filter-btn.healthy .overview-num {
    color: #34d399;
  }

  .overview-filter-btn.stale .overview-num {
    color: #facc15;
  }

  .overview-filter-btn.degraded .overview-num {
    color: #fb923c;
  }

  .overview-filter-btn.disabled .overview-num {
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

  .source-warning-banner {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 12px;
    margin-bottom: 4px;
  }

  .source-warning-banner.stale-banner {
    background: rgba(234, 179, 8, 0.1);
    border: 1px solid rgba(234, 179, 8, 0.35);
    color: #fef08a;
  }

  .source-warning-banner.degraded-banner {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.35);
    color: #fca5a5;
  }

  .warning-icon {
    flex-shrink: 0;
    font-size: 14px;
  }

  .warning-text-wrap {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .warning-title {
    font-weight: 700;
  }

  .warning-text {
    font-size: 11px;
    line-height: 1.4;
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
