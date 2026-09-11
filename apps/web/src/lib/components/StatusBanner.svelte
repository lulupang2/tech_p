<script lang="ts">
  import { onMount } from 'svelte';
  import { locale, type Locale } from '$lib/i18n.js';
  import { ApiClient, ApiClientError } from '../api-client.js';
  import type {
    CoverageReportResponse,
    HealthLiveResponse,
    HealthReadyResponse,
  } from '@techpulse/contracts';

  interface Props {
    client: ApiClient;
  }

  let { client }: Props = $props();
  let currentLocale = $state<Locale>('ko');
  locale.subscribe((value) => (currentLocale = value));

  let loading = $state(true);
  let refreshing = $state(false);
  let liveStatus = $state<HealthLiveResponse | null>(null);
  let readyStatus = $state<HealthReadyResponse | null>(null);
  let coverageReport = $state<CoverageReportResponse | null>(null);
  let errorMessage = $state<string | null>(null);
  let lastCheckedAt = $state<string | null>(null);

  function formatUtcDateTime(isoString: string | null | undefined): string {
    if (!isoString) return currentLocale === 'ko' ? '날짜 미지정' : 'Date not specified';
    try {
      const d = new Date(isoString);
      if (Number.isNaN(d.getTime())) return isoString;
      return d.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
    } catch {
      return String(isoString);
    }
  }

  function formatReasonLabel(reason: string): string {
    const koMap: Record<string, string> = {
      raw_shortage: '원본 데이터 부족 (Raw Shortage)',
      processing_pending: '처리 대기 중 (Processing Pending)',
      period_gap: '기간 공백 (Period Gap)',
      retrieval_miss: '검색 누락 (Retrieval Miss)',
      unknown: '알 수 없음 (Unknown)',
    };
    const enMap: Record<string, string> = {
      raw_shortage: 'Raw Shortage',
      processing_pending: 'Processing Pending',
      period_gap: 'Period Gap',
      retrieval_miss: 'Retrieval Miss',
      unknown: 'Unknown Limitation',
    };
    return (currentLocale === 'ko' ? koMap[reason] : enMap[reason]) || reason;
  }

  let isCorpusReady = $derived.by(() => {
    if (!coverageReport) return false;
    return (
      coverageReport.partitionsChecked > 0 &&
      coverageReport.partitionsCompleted === coverageReport.partitionsChecked &&
      coverageReport.partitionsPartial === 0 &&
      coverageReport.vectorDocuments > 0 &&
      coverageReport.reasons.length === 0
    );
  });

  async function checkHealth() {
    refreshing = true;
    errorMessage = null;
    try {
      const now = new Date();
      const past30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const [live, ready, coverage] = await Promise.all([
        client.getHealthLive(),
        client.getHealthReady().catch((err) => {
          if (err instanceof ApiClientError && err.status === 503) {
            return {
              status: 'unavailable' as const,
              timestamp: new Date().toISOString(),
              dependencies: { database: 'unavailable' as const },
            };
          }
          throw err;
        }),
        client
          .getCoverage({
            from: past30d.toISOString(),
            to: now.toISOString(),
          })
          .catch(() => null),
      ]);
      liveStatus = live;
      readyStatus = ready;
      coverageReport = coverage;
      lastCheckedAt = new Date().toISOString();
    } catch (err) {
      if (err instanceof ApiClientError) {
        errorMessage = `${currentLocale === 'ko' ? '상태 확인에 실패했습니다' : 'Health check failed'} (${err.code}): ${err.message}`;
      } else if (err instanceof Error) {
        errorMessage = err.message;
      } else {
        errorMessage =
          currentLocale === 'ko'
            ? '백엔드 API에 연결하지 못했습니다'
            : 'Failed to connect to backend API';
      }
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  onMount(() => {
    checkHealth();
  });
</script>

<section class="status-panel" aria-labelledby="status-heading" id="panel-status">
  <div class="panel-header">
    <div>
      <h2 id="status-heading" class="panel-title">시스템 상태와 준비 여부</h2>
      <p class="panel-description">API 응답과 PostgreSQL 의존성의 실시간 준비 상태를 확인합니다.</p>
    </div>
    <button
      type="button"
      class="refresh-btn"
      onclick={checkHealth}
      disabled={refreshing}
      aria-label={currentLocale === 'ko' ? '시스템 상태 새로고침' : 'Refresh system health status'}
    >
      {#if refreshing}
        <span class="spinner" aria-hidden="true"></span>
        {currentLocale === 'ko' ? '새로고침 중...' : 'Refreshing...'}
      {:else}
        {currentLocale === 'ko' ? '새로고침' : 'Refresh'}
      {/if}
    </button>
  </div>

  {#if loading}
    <div class="state-container loading-state" role="status" aria-busy="true" aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      <span
        >{currentLocale === 'ko'
          ? 'API와 데이터베이스 준비 상태를 확인하는 중입니다.'
          : 'Checking API and database readiness...'}</span
      >
    </div>
  {:else if errorMessage}
    <div class="state-container error-state" role="alert" aria-live="assertive">
      <div class="error-badge" aria-hidden="true">!</div>
      <div class="error-content">
        <strong
          >{currentLocale === 'ko' ? '서비스에 연결할 수 없습니다' : 'Service Unavailable'}</strong
        >
        <p>{errorMessage}</p>
        <button type="button" class="retry-btn" onclick={checkHealth}
          >{currentLocale === 'ko' ? '다시 연결' : 'Retry Connection'}</button
        >
      </div>
    </div>
  {:else}
    <div
      class="health-grid"
      role="region"
      aria-label={currentLocale === 'ko' ? '서비스 상태 지표' : 'Health indicators'}
    >
      <div class="health-card">
        <div class="card-top">
          <span class="card-label"
            >{currentLocale === 'ko' ? 'API 프로세스 이벤트 루프' : 'API Process Event Loop'}</span
          >
          <span
            class="status-indicator"
            class:ok={liveStatus?.status === 'ok'}
            aria-label={`API status: ${liveStatus?.status ?? 'unknown'}`}
          >
            {liveStatus?.status ?? 'unknown'}
          </span>
        </div>
        <p class="card-meta">
          {currentLocale === 'ko' ? '엔드포인트' : 'Endpoint'}: <code>/health/live</code>
        </p>
        <p class="card-time">
          {currentLocale === 'ko' ? '보고 시각' : 'Reported'}: {liveStatus?.timestamp ?? 'N/A'}
        </p>
      </div>

      <div class="health-card">
        <div class="card-top">
          <span class="card-label"
            >{currentLocale === 'ko'
              ? '데이터베이스 의존성 (PostgreSQL)'
              : 'Database Dependency (PostgreSQL)'}</span
          >
          <span
            class="status-indicator"
            class:ok={readyStatus?.dependencies.database === 'ok'}
            class:warn={readyStatus?.dependencies.database === 'degraded'}
            class:danger={readyStatus?.dependencies.database === 'unavailable'}
            aria-label={`Database status: ${readyStatus?.dependencies.database ?? 'unknown'}`}
          >
            {readyStatus?.dependencies.database ?? 'unknown'}
          </span>
        </div>
        <p class="card-meta">
          {currentLocale === 'ko' ? '엔드포인트' : 'Endpoint'}: <code>/health/ready</code>
        </p>
        <p class="card-time">
          {currentLocale === 'ko' ? '전체 준비 상태' : 'Overall Readiness'}: {readyStatus?.status ??
            'unknown'}
        </p>
      </div>
    </div>

    {#if coverageReport}
      <div class="coverage-overview-card" role="region" aria-label="Corpus Coverage & Readiness">
        <div class="coverage-overview-header">
          <div>
            <h3 class="coverage-overview-title">
              {currentLocale === 'ko'
                ? '말뭉치 수집 및 색인 준비도'
                : 'Corpus Coverage & Index Readiness'}
            </h3>
            <p class="coverage-overview-desc">
              {currentLocale === 'ko'
                ? 'PostgreSQL 원본/어휘/벡터 파티션의 완료 상태와 데이터 한계를 모니터링합니다.'
                : 'Monitors PostgreSQL raw/lexical/vector partition completion and data limitations.'}
            </p>
          </div>
          <span
            class="status-indicator"
            class:ok={isCorpusReady}
            class:warn={!isCorpusReady && coverageReport.partitionsPartial > 0}
            class:danger={!isCorpusReady && coverageReport.vectorDocuments === 0}
            aria-label={`Corpus readiness: ${isCorpusReady ? 'ready' : 'partial_or_pending'}`}
          >
            {#if isCorpusReady}
              {currentLocale === 'ko' ? '준비 완료' : 'Corpus Ready'}
            {:else if coverageReport.reasons.includes('processing_pending')}
              {currentLocale === 'ko' ? '처리 대기 중' : 'Processing Pending'}
            {:else if coverageReport.partitionsPartial > 0}
              {currentLocale === 'ko' ? '부분 준비됨' : 'Partial Readiness'}
            {:else}
              {currentLocale === 'ko' ? '준비 중' : 'Pending'}
            {/if}
          </span>
        </div>

        <!-- Resolved UTC Window -->
        <div class="coverage-period-row">
          <span class="period-label"
            >{currentLocale === 'ko' ? '확인된 UTC 구간:' : 'Resolved UTC Window:'}</span
          >
          <span class="period-value">
            <strong>{formatUtcDateTime(coverageReport.from)}</strong>
            &nbsp;→&nbsp;
            <strong>{formatUtcDateTime(coverageReport.to)}</strong>
          </span>
        </div>

        <!-- Document Readiness Counts -->
        <div class="metrics-grid">
          <div class="metric-item">
            <span class="metric-num">{coverageReport.rawDocuments.toLocaleString()}</span>
            <span class="metric-name"
              >{currentLocale === 'ko' ? '수집된 원본 문서' : 'Raw Documents'}</span
            >
          </div>
          <div class="metric-item">
            <span class="metric-num">{coverageReport.lexicalDocuments.toLocaleString()}</span>
            <span class="metric-name"
              >{currentLocale === 'ko' ? '어휘 색인 문서' : 'Lexical Documents'}</span
            >
          </div>
          <div class="metric-item">
            <span class="metric-num">{coverageReport.vectorDocuments.toLocaleString()}</span>
            <span class="metric-name"
              >{currentLocale === 'ko' ? '벡터 임베딩 문서' : 'Vector Documents'}</span
            >
          </div>
        </div>

        <!-- Partition Progress -->
        <div class="partition-stats-row">
          <div class="partition-stat">
            <span class="p-label"
              >{currentLocale === 'ko' ? '확인된 파티션:' : 'Partitions Checked:'}</span
            >
            <span class="p-val">{coverageReport.partitionsChecked}</span>
          </div>
          <div class="partition-stat">
            <span class="p-label">{currentLocale === 'ko' ? '완료된 파티션:' : 'Completed:'}</span>
            <span class="p-val completed">{coverageReport.partitionsCompleted}</span>
          </div>
          <div class="partition-stat">
            <span class="p-label">{currentLocale === 'ko' ? '부분/진행 중:' : 'Partial:'}</span>
            <span class="p-val" class:warn-text={coverageReport.partitionsPartial > 0}
              >{coverageReport.partitionsPartial}</span
            >
          </div>
        </div>

        <!-- Limitation reasons -->
        {#if coverageReport.reasons.length > 0}
          <div class="reasons-box" role="region" aria-label="Coverage limitation reasons">
            <span class="reasons-heading"
              >{currentLocale === 'ko'
                ? '데이터 범위 한계 및 사유:'
                : 'Coverage Limitations & Advisories:'}</span
            >
            <div class="reasons-tags">
              {#each coverageReport.reasons as reason (reason)}
                <span
                  class="reason-tag"
                  class:tag-pending={reason === 'processing_pending'}
                  class:tag-shortage={reason === 'raw_shortage'}
                  class:tag-gap={reason === 'period_gap'}
                >
                  {formatReasonLabel(reason)}
                </span>
              {/each}
            </div>
            {#if !isCorpusReady}
              <p class="unready-warning">
                ⚠ {currentLocale === 'ko'
                  ? '수집 말뭉치가 부분 완료 상태입니다. 미완료 파티션 또는 처리 대기 문서가 존재하여 일부 질문에 대한 답변 근거가 제한될 수 있습니다.'
                  : 'Corpus is only partially ready. Pending processing or partial partitions may limit evidence sufficiency.'}
              </p>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    {#if lastCheckedAt}
      <p class="last-checked" aria-live="polite">
        {currentLocale === 'ko' ? '마지막 확인 시각:' : 'Last checked at:'}
        <time datetime={lastCheckedAt}>{lastCheckedAt}</time>
      </p>
    {/if}
  {/if}
</section>

<style>
  .status-panel {
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
    color: #f8fafc;
  }

  .panel-description {
    margin: 0;
    font-size: 13px;
    color: #94a3b8;
  }

  .refresh-btn {
    background: #1e293b;
    color: #f8fafc;
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    transition: background 0.15s ease-in-out;
  }

  .refresh-btn:hover:not(:disabled) {
    background: #334155;
  }

  .refresh-btn:focus-visible {
    outline: 2px solid #38bdf8;
    outline-offset: 2px;
  }

  .refresh-btn:disabled {
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

  .health-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
  }

  .health-card {
    background: #1e293b80;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 16px;
  }

  .card-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .card-label {
    font-size: 14px;
    font-weight: 600;
    color: #e2e8f0;
  }

  .status-indicator {
    font-size: 11px;
    text-transform: uppercase;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 9999px;
    background: #475569;
    color: #cbd5e1;
  }

  .status-indicator.ok {
    background: #065f46;
    color: #a7f3d0;
  }

  .status-indicator.warn {
    background: #854d0e;
    color: #fef08a;
  }

  .status-indicator.danger {
    background: #991b1b;
    color: #fecaca;
  }

  .card-meta {
    margin: 4px 0;
    font-size: 12px;
    color: #94a3b8;
  }

  .card-meta code {
    background: #0f172a;
    padding: 2px 6px;
    border-radius: 4px;
    color: #38bdf8;
  }

  .card-time {
    margin: 4px 0 0 0;
    font-size: 11px;
    color: #64748b;
  }

  .last-checked {
    margin: 16px 0 0 0;
    font-size: 12px;
    color: #64748b;
    text-align: right;
  }

  .spinner {
    width: 16px;
    height: 16px;
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

  .coverage-overview-card {
    margin-top: 20px;
    background: #1e293b60;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 20px;
  }

  .coverage-overview-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }

  .coverage-overview-title {
    margin: 0 0 4px 0;
    font-size: 15px;
    font-weight: 700;
    color: #f8fafc;
  }

  .coverage-overview-desc {
    margin: 0;
    font-size: 12px;
    color: #94a3b8;
  }

  .coverage-period-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #cbd5e1;
    margin-bottom: 16px;
    background: #0f172a80;
    padding: 8px 12px;
    border-radius: 6px;
    border: 1px solid #33415560;
  }

  .period-label {
    color: #94a3b8;
  }

  .period-value strong {
    color: #38bdf8;
  }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }

  .metric-item {
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 6px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .metric-num {
    font-size: 18px;
    font-weight: 700;
    color: #f8fafc;
  }

  .metric-name {
    font-size: 11px;
    color: #94a3b8;
  }

  .partition-stats-row {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    background: #0f172a60;
    padding: 10px 14px;
    border-radius: 6px;
    border: 1px solid #1e293b;
    margin-bottom: 16px;
  }

  .partition-stat {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }

  .p-label {
    color: #94a3b8;
  }

  .p-val {
    font-weight: 700;
    color: #e2e8f0;
  }

  .p-val.completed {
    color: #34d399;
  }

  .warn-text {
    color: #fbbf24;
  }

  .reasons-box {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid #33415580;
  }

  .reasons-heading {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: #cbd5e1;
    margin-bottom: 8px;
  }

  .reasons-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 8px;
  }

  .reason-tag {
    font-size: 11px;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 4px;
    background: #334155;
    color: #e2e8f0;
  }

  .reason-tag.tag-pending {
    background: #854d0e40;
    border: 1px solid #a16207;
    color: #fef08a;
  }

  .reason-tag.tag-shortage {
    background: #7c2d1240;
    border: 1px solid #c2410c;
    color: #fdba74;
  }

  .reason-tag.tag-gap {
    background: #701a7540;
    border: 1px solid #a21caf;
    color: #f5d0fe;
  }

  .unready-warning {
    margin: 8px 0 0 0;
    font-size: 12px;
    color: #fbbf24;
    line-height: 1.5;
  }
</style>
