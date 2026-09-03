<script module lang="ts">
  import type { AnswerRequest } from '@techpulse/contracts';

  export function isUnboundedStart(isoString: string | null | undefined): boolean {
    if (!isoString) return false;
    try {
      const d = new Date(isoString);
      return !Number.isNaN(d.getTime()) && (d.getUTCFullYear() <= 1970 || d.getTime() <= 0);
    } catch {
      return isoString.startsWith('1970-01-01');
    }
  }

  export interface BuildAnswerRequestOptions {
    question: string;
    timePreset: 'auto' | '7d' | '30d' | '90d' | 'custom';
    customFrom?: string;
    customTo?: string;
    timezone?: string;
    language?: 'auto' | 'ko' | 'en';
    now?: () => Date;
  }

  export function buildAnswerRequestPayload(options: BuildAnswerRequestOptions): AnswerRequest {
    const payload: AnswerRequest = {
      question: options.question.trim(),
    };

    if (options.timezone && options.timezone.trim().length > 0) {
      payload.timezone = options.timezone.trim();
    }

    if (options.language && options.language !== 'auto') {
      payload.language = options.language;
    }

    if (options.timePreset === 'custom') {
      if (!options.customFrom || !options.customTo) {
        throw new Error('Please specify both start (from) and end (to) dates for custom range.');
      }
      const fromDate = new Date(options.customFrom);
      const toDate = new Date(options.customTo);
      if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
        throw new Error('Invalid custom date format.');
      }
      if (toDate <= fromDate) {
        throw new Error('End date (to) must be after start date (from).');
      }
      payload.timeRange = {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
      };
    } else if (
      options.timePreset === '7d' ||
      options.timePreset === '30d' ||
      options.timePreset === '90d'
    ) {
      const days = options.timePreset === '7d' ? 7 : options.timePreset === '30d' ? 30 : 90;
      const now = options.now ? options.now() : new Date();
      const past = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      payload.timeRange = {
        from: past.toISOString(),
        to: now.toISOString(),
      };
    }
    // Note: When options.timePreset === 'auto', payload.timeRange is intentionally omitted (undefined) -> unbounded latest retrieval

    return payload;
  }
</script>

<script lang="ts">
  import { locale, type Locale } from '$lib/i18n.js';
  import { ApiClient, ApiClientError } from '../api-client.js';
  import type { AnswerResponse, ValidationIssue } from '@techpulse/contracts';

  interface Props {
    client: ApiClient;
    initialResponse?: AnswerResponse | null;
    initialTimePreset?: 'auto' | '7d' | '30d' | '90d' | 'custom';
    initialQuestion?: string;
  }

  let {
    client,
    initialResponse = null,
    initialTimePreset = 'auto',
    initialQuestion = '',
  }: Props = $props();
  let currentLocale = $state<Locale>('ko');
  locale.subscribe((value) => (currentLocale = value));

  // Form states
  // svelte-ignore state_referenced_locally
  let question = $state(initialQuestion);
  // svelte-ignore state_referenced_locally
  let timePreset = $state<'auto' | '7d' | '30d' | '90d' | 'custom'>(initialTimePreset);
  let customFrom = $state('');
  let customTo = $state('');
  let selectedTimezone = $state('Asia/Seoul');
  let selectedLanguage = $state<'auto' | 'ko' | 'en'>('auto');

  // Execution states
  let submitting = $state(false);
  // svelte-ignore state_referenced_locally
  let response = $state<AnswerResponse | null>(initialResponse);
  let errorMessage = $state<string | null>(null);
  let errorCode = $state<string | null>(null);
  let errorDetails = $state<readonly ValidationIssue[]>([]);
  let requestId = $state<string | null>(null);
  let highlightedCitationId = $state<string | null>(null);

  // Character limit validation
  const MAX_QUESTION_LENGTH = 2000;
  let questionLength = $derived(question.length);
  let isQuestionValid = $derived(
    question.trim().length > 0 && question.length <= MAX_QUESTION_LENGTH,
  );

  const sampleQuestions = [
    '최근 Bun과 Node.js의 릴리스 동향과 생태계 변화를 요약해줘.',
    'Rust 언어 커뮤니티와 생태계의 최근 릴리스 동향을 요약해줘.',
    'React 프레임워크와 생태계의 최근 릴리스 및 업데이트 동향을 요약해줘.',
    'TypeScript 및 Playwright 생태계의 최신 버전 업데이트와 주요 변경점을 알려줘.',
  ];

  function selectSampleQuestion(sample: string) {
    question = sample;
    errorMessage = null;
  }

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

  interface MetricGroup {
    metric: string;
    metricLabel: string;
    unit: string;
    unitLabel: string;
    items: {
      subject: string;
      value: number;
      change: number | null;
      unit: string;
    }[];
  }

  function formatUnitName(unit: string): string {
    const map: Record<string, string> = {
      deduplicated_documents: 'deduplicated documents',
      new_repositories: 'new repositories',
      interactions: 'interactions',
      comments: 'comments',
      reactions: 'reactions',
      stars: 'stars',
      sources: 'sources',
      releases: 'releases',
      submissions: 'submissions',
      models: 'models',
      datasets: 'datasets',
      downloads: 'downloads',
      count: 'count',
    };
    return map[unit] || unit.replace(/_/g, ' ');
  }

  function formatMetricName(metric: string): string {
    const map: Record<string, string> =
      currentLocale === 'ko'
        ? {
            community_mentions: '커뮤니티 언급',
            issue_discussion: '이슈 및 토론 활동',
            repo_attention: '저장소 관심도',
            source_diversity: '출처 다양성',
            release_activity: '릴리스 활동',
            paper_activity: '연구 논문 제출',
            model_activity: '모델 및 데이터셋 활동',
            package_downloads: '패키지 다운로드',
          }
        : {
            community_mentions: 'Community Mentions',
            issue_discussion: 'Issue & Discussion Activity',
            repo_attention: 'Repository Attention (Stars/New)',
            source_diversity: 'Source Diversity',
            release_activity: 'Release Cadence & Activity',
            paper_activity: 'Research Paper Submissions',
            model_activity: 'Model & Dataset Activity',
            package_downloads: 'Package Downloads',
          };
    return map[metric] || metric.replace(/_/g, ' ');
  }

  let groupedObservations = $derived.by<MetricGroup[]>(() => {
    if (!response || !response.observations || response.observations.length === 0) return [];
    const groups: MetricGroup[] = [];
    const indexMap: Record<string, number> = {};

    for (const obs of response.observations) {
      const existingIdx = indexMap[obs.metric];
      if (existingIdx === undefined) {
        indexMap[obs.metric] = groups.length;
        groups.push({
          metric: obs.metric,
          metricLabel: formatMetricName(obs.metric),
          unit: obs.unit,
          unitLabel: formatUnitName(obs.unit),
          items: [
            {
              subject: obs.subject,
              value: obs.value,
              change: obs.change,
              unit: obs.unit,
            },
          ],
        });
      } else {
        groups[existingIdx]?.items.push({
          subject: obs.subject,
          value: obs.value,
          change: obs.change,
          unit: obs.unit,
        });
      }
    }
    return groups;
  });

  let hasMultipleSubjects = $derived.by(() => {
    if (!response || !response.observations || response.observations.length <= 1) return false;
    const first = response.observations[0]?.subject;
    return response.observations.some((o) => o.subject !== first);
  });

  function formatIntentName(intent: string): string {
    const map: Record<string, string> =
      currentLocale === 'ko'
        ? {
            compare_interest: '관심도 비교 분석',
            trend_summary: '트렌드 요약',
            recent_updates: '최근 업데이트 및 릴리스',
            emerging_topics: '신흥 토픽 분석',
            unsupported_intent: '지원하지 않는 질문',
          }
        : {
            compare_interest: 'Comparative Interest Analysis',
            trend_summary: 'Trend Summary',
            recent_updates: 'Recent Updates & Releases',
            emerging_topics: 'Emerging Topics Analysis',
            unsupported_intent: 'Unsupported Intent',
          };
    return map[intent] || intent.replace(/_/g, ' ');
  }

  function formatSourceBadge(source: string): string {
    const map: Record<string, string> = {
      github_releases: 'GitHub Releases',
      github_search: 'GitHub Repos',
      npm_registry: 'npm Registry',
      stack_exchange: 'Stack Exchange',
      users_rust_lang: 'Rust Users Forum',
      arxiv: 'arXiv Papers',
      huggingface_hub: 'Hugging Face Hub',
    };
    return map[source] || source;
  }
  function handleCitationFocus(citationId: string) {
    highlightedCitationId = citationId;
    if (typeof globalThis.document !== 'undefined') {
      const targetEl = globalThis.document.getElementById(`citation-${citationId}`);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }

  async function handleSubmit(e?: { preventDefault: () => void }) {
    e?.preventDefault();
    if (!isQuestionValid || submitting) return;
    submitting = true;
    errorMessage = null;
    errorCode = null;
    errorDetails = [];
    requestId = null;
    response = null;

    try {
      const payload = buildAnswerRequestPayload({
        question,
        timePreset,
        customFrom,
        customTo,
        timezone: selectedTimezone,
        language: selectedLanguage,
      });
      const res = await client.createAnswer(payload);
      response = res;
      requestId = res.requestId;
    } catch (err) {
      if (err instanceof ApiClientError) {
        errorCode = err.code;
        errorMessage = err.message;
        errorDetails = err.details;
        requestId = err.requestId ?? null;
      } else if (err instanceof Error) {
        errorMessage = err.message;
      } else {
        errorMessage = 'An unexpected error occurred while processing your request.';
      }
    } finally {
      submitting = false;
    }
  }

  function handleReset() {
    question = '';
    timePreset = 'auto';
    customFrom = '';
    customTo = '';
    selectedTimezone = 'Asia/Seoul';
    selectedLanguage = 'auto';
    response = null;
    errorMessage = null;
    errorCode = null;
    errorDetails = [];
    requestId = null;
    highlightedCitationId = null;
  }
</script>

<section class="qa-panel" aria-labelledby="qa-heading">
  <div class="panel-header">
    <div>
      <h2 id="qa-heading" class="panel-title">근거 기반 AI 질문</h2>
      <p class="panel-description">
        개발 기술의 변화와 비교 흐름을 질문하고, 색인된 출처와 인용 근거를 함께 확인하세요.
      </p>
    </div>
    <span
      class="status-badge live"
      aria-label={currentLocale === 'ko' ? '기능 상태: 운영 중' : 'Feature Status: Operational'}
    >
      <span class="live-dot" aria-hidden="true"></span>
      {currentLocale === 'ko' ? '운영 중' : 'Operational'} (API-003)
    </span>
  </div>

  <!-- Question Input Form -->
  <form class="qa-form" onsubmit={handleSubmit} novalidate>
    <div class="form-group">
      <div class="label-row">
        <label for="qa-question-input" class="form-label">
          질문 <span class="required" aria-hidden="true">*</span>
        </label>
        <span
          class="char-counter"
          class:char-limit-near={questionLength > 1800}
          class:char-limit-exceeded={questionLength > MAX_QUESTION_LENGTH}
          aria-live="polite"
        >
          {questionLength} / {MAX_QUESTION_LENGTH}{currentLocale === 'ko' ? '자' : ' chars'}
        </span>
      </div>
      <textarea
        id="qa-question-input"
        class="form-textarea"
        placeholder="예: 최근 한 달간 Bun과 Node.js의 관심 변화를 비교해줘."
        bind:value={question}
        rows={3}
        maxlength={MAX_QUESTION_LENGTH}
        disabled={submitting}
        aria-describedby="qa-question-help"
        required
      ></textarea>
      <p id="qa-question-help" class="form-help">
        한국어 또는 영어로 2,000자 이내의 질문을 입력하세요.
      </p>
    </div>

    <!-- Sample questions chips -->
    <div
      class="sample-queries"
      aria-label={currentLocale === 'ko' ? '예시 질문' : 'Sample questions'}
    >
      <span class="sample-label">{currentLocale === 'ko' ? '예시:' : 'Examples:'}</span>
      <div class="chips-row">
        {#each sampleQuestions as sample (sample)}
          <button
            type="button"
            class="chip-btn"
            disabled={submitting}
            onclick={() => selectSampleQuestion(sample)}
          >
            {sample}
          </button>
        {/each}
      </div>
    </div>

    <!-- Controls: Time range, Timezone, Language -->
    <fieldset class="controls-fieldset">
      <legend class="controls-legend"
        >{currentLocale === 'ko' ? '질의 범위와 설정' : 'Query Scope & Parameters'}</legend
      >

      <div class="controls-grid">
        <!-- Time Range Selector -->
        <div class="control-item">
          <label for="qa-timerange-select" class="control-label"
            >{currentLocale === 'ko' ? '조회 기간' : 'Time Range'}</label
          >
          <select
            id="qa-timerange-select"
            class="form-select"
            bind:value={timePreset}
            disabled={submitting}
          >
            <option value="auto"
              >{currentLocale === 'ko'
                ? '기본값 (기간 필터 없음 / 최신 데이터)'
                : 'Default (No Date Filter / Latest Data)'}</option
            >
            <option value="7d">{currentLocale === 'ko' ? '최근 7일' : 'Past 7 Days'}</option>
            <option value="30d">{currentLocale === 'ko' ? '최근 30일' : 'Past 30 Days'}</option>
            <option value="90d">{currentLocale === 'ko' ? '최근 90일' : 'Past 90 Days'}</option>
            <option value="custom"
              >{currentLocale === 'ko' ? '직접 기간 설정' : 'Custom Date Range'}</option
            >
          </select>
        </div>

        <!-- Timezone Selector -->
        <div class="control-item">
          <label for="qa-timezone-select" class="control-label"
            >{currentLocale === 'ko' ? '시간대' : 'Timezone'}</label
          >
          <select
            id="qa-timezone-select"
            class="form-select"
            bind:value={selectedTimezone}
            disabled={submitting}
          >
            <option value="Asia/Seoul">Asia/Seoul (KST, UTC+9)</option>
            <option value="UTC">UTC (Coordinated Universal Time)</option>
            <option value="America/New_York">America/New_York (EST/EDT)</option>
            <option value="America/Los_Angeles">America/Los_Angeles (PST/PDT)</option>
            <option value="Europe/London">Europe/London (GMT/BST)</option>
          </select>
        </div>

        <!-- Language Selector -->
        <div class="control-item">
          <label for="qa-lang-select" class="control-label"
            >{currentLocale === 'ko' ? '답변 언어' : 'Output Language'}</label
          >
          <select
            id="qa-lang-select"
            class="form-select"
            bind:value={selectedLanguage}
            disabled={submitting}
          >
            <option value="auto"
              >{currentLocale === 'ko' ? '질문에서 자동 감지' : 'Auto-detect from question'}</option
            >
            <option value="ko">Korean (한국어)</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>

      <!-- Custom Date Range Inputs -->
      {#if timePreset === 'custom'}
        <div class="custom-range-row" aria-label="Custom date range input">
          <div class="control-item">
            <label for="qa-custom-from" class="control-label">
              {currentLocale === 'ko' ? '시작 일시' : 'Start Date (From)'}
              <span class="required" aria-hidden="true">*</span>
            </label>
            <input
              type="datetime-local"
              id="qa-custom-from"
              class="form-input"
              bind:value={customFrom}
              disabled={submitting}
              required
            />
          </div>
          <div class="control-item">
            <label for="qa-custom-to" class="control-label">
              {currentLocale === 'ko' ? '종료 일시' : 'End Date (To)'}
              <span class="required" aria-hidden="true">*</span>
            </label>
            <input
              type="datetime-local"
              id="qa-custom-to"
              class="form-input"
              bind:value={customTo}
              disabled={submitting}
              required
            />
          </div>
        </div>
      {/if}
    </fieldset>

    <!-- Action Buttons -->
    <div class="form-actions">
      <button
        type="submit"
        class="submit-btn"
        disabled={!isQuestionValid || submitting}
        aria-busy={submitting}
      >
        {#if submitting}
          <span class="spinner" aria-hidden="true"></span>
          <span>{currentLocale === 'ko' ? '답변을 생성하는 중...' : 'Synthesizing Answer...'}</span>
        {:else}
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <span>근거와 함께 답변받기</span>
        {/if}
      </button>

      <button
        type="button"
        class="reset-btn"
        disabled={submitting || (!question && !response && !errorMessage)}
        onclick={handleReset}
      >
        Clear
      </button>
    </div>
  </form>

  <!-- Loading State Indicator -->
  {#if submitting}
    <div
      class="loading-container"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={currentLocale === 'ko'
        ? '근거 기반 답변 생성 중'
        : 'Generating evidence-backed answer'}
    >
      <div class="loading-spinner-large" aria-hidden="true"></div>
      <div class="loading-text">
        <h3 class="loading-title">
          {currentLocale === 'ko'
            ? '색인된 근거를 검색하고 답변을 생성하는 중입니다...'
            : 'Retrieving indexed evidence & generating answer...'}
        </h3>
        <p class="loading-subtext">
          {currentLocale === 'ko'
            ? 'PostgreSQL 벡터·키워드 색인과 지표 관측값을 조회하고 출처 인용을 검증하고 있습니다.'
            : 'Scanning PostgreSQL vector and lexical indexes, aggregating metric observations, and verifying source citations.'}
        </p>
      </div>
    </div>
  {/if}

  <!-- Error Alert Container -->
  {#if errorMessage}
    <div class="error-card" role="alert" aria-labelledby="error-card-title">
      <div class="error-header">
        <div class="error-icon" aria-hidden="true">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
        </div>
        <div>
          <h3 id="error-card-title" class="error-title">
            {currentLocale === 'ko' ? '요청 실패' : 'Request Failed'}
            {#if errorCode}({errorCode}){/if}
          </h3>
          <p class="error-desc">{errorMessage}</p>
        </div>
      </div>

      {#if errorDetails && errorDetails.length > 0}
        <div class="error-details">
          <p class="details-heading">
            {currentLocale === 'ko' ? '검증 상세:' : 'Validation details:'}
          </p>
          <ul class="details-list">
            {#each errorDetails as issue, i (issue.path + String(i))}
              <li>
                <code>{issue.path || 'root'}</code>: {issue.reason}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if requestId}
        <div class="error-meta">
          <span>{currentLocale === 'ko' ? '요청 ID:' : 'Request ID:'} <code>{requestId}</code></span
          >
        </div>
      {/if}
    </div>
  {/if}

  <!-- Results Region -->
  {#if response && !submitting}
    <div class="results-container" role="region" aria-label="Q&A Answer Results" aria-live="polite">
      <!-- Meta Information Banner -->
      <div class="results-meta-card">
        <div class="meta-row">
          <div class="meta-status">
            {#if response.status === 'answered'}
              <span class="badge badge-success" aria-label="Status: Answered with Evidence">
                ✓ {currentLocale === 'ko' ? '근거 확인됨' : 'Answered with Evidence'}
              </span>
            {:else if response.status === 'insufficient_evidence'}
              <span class="badge badge-warning" aria-label="Status: Insufficient Evidence">
                ⚠ {currentLocale === 'ko' ? '근거 부족' : 'Insufficient Evidence'}
              </span>
            {:else}
              <span class="badge badge-secondary" aria-label="Status: Unsupported Intent">
                ℹ {currentLocale === 'ko' ? '지원하지 않는 질문' : 'Unsupported Intent'}
              </span>
            {/if}

            <span class="badge badge-intent" title="Classified Query Intent">
              {currentLocale === 'ko' ? '질의 유형:' : 'Intent:'}
              {formatIntentName(response.intent)}
            </span>
          </div>

          <div class="meta-ids">
            <span class="meta-id-tag">Answer ID: <code>{response.answerId}</code></span>
            <span class="meta-id-tag"
              >{currentLocale === 'ko' ? '요청 ID:' : 'Request ID:'}
              <code>{response.requestId}</code></span
            >
          </div>
        </div>

        <!-- Resolved Time Range -->
        <div class="resolved-range-box" aria-label="Resolved Time Range">
          <div class="range-icon" aria-hidden="true">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="16" y1="2" x2="16" y2="6"></line>
              <line x1="8" y1="2" x2="8" y2="6"></line>
              <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
          </div>
          <div class="range-content">
            <span class="range-label"
              >{currentLocale === 'ko' ? '근거 조회 기간:' : 'Resolved Evidence Range:'}</span
            >
            <span class="range-value">
              {#if isUnboundedStart(response.resolvedTimeRange.from)}
                <span class="unbounded-tag"
                  >{currentLocale === 'ko'
                    ? '전체 기간 (최신 데이터)'
                    : 'All Time (Latest Data)'}</span
                >
                &nbsp;·&nbsp;
                <strong>~ {formatUtcDateTime(response.resolvedTimeRange.to)}</strong>
                &nbsp;({response.resolvedTimeRange.timezone})
              {:else}
                <strong>{formatUtcDateTime(response.resolvedTimeRange.from)}</strong>
                &nbsp;→&nbsp;
                <strong>{formatUtcDateTime(response.resolvedTimeRange.to)}</strong>
                &nbsp;({response.resolvedTimeRange.timezone})
              {/if}
            </span>
          </div>
        </div>
      </div>

      <!-- State 1: Answered Successfully -->
      {#if response.status === 'answered'}
        <div class="answer-card">
          <h3 class="answer-heading">
            {currentLocale === 'ko' ? '종합 답변' : 'Synthesized Answer'}
          </h3>
          <div class="answer-text">
            {#if response.answer}
              <p class="answer-paragraph">{response.answer}</p>
            {/if}
          </div>

          {#if response.citations.length > 0}
            <div class="citation-jump-bar">
              <span class="jump-label"
                >{currentLocale === 'ko' ? '참조한 인용:' : 'Citations referenced:'}</span
              >
              <div class="jump-tags">
                {#each response.citations as cit (cit.id)}
                  <button
                    type="button"
                    class="citation-jump-btn"
                    class:active={highlightedCitationId === cit.id}
                    onclick={() => handleCitationFocus(cit.id)}
                    aria-label={`Jump to citation ${cit.id}: ${cit.title}`}
                  >
                    [{cit.id}] {cit.title}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>

        <!-- State 2: Insufficient Evidence -->
      {:else if response.status === 'insufficient_evidence'}
        <div
          class="notice-card warning-state"
          role="region"
          aria-label="Insufficient Evidence Notice"
        >
          <div class="notice-icon" aria-hidden="true">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path
                d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
              ></path>
              <line x1="12" y1="9" x2="12" y2="13"></line>
              <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>
          </div>
          <div class="notice-content">
            <h3 class="notice-title">
              {currentLocale === 'ko'
                ? '질문에 답하기 위한 근거가 부족합니다'
                : 'Insufficient Evidence for Requested Query'}
            </h3>
            <p class="notice-description">
              수집된 공개 기술 데이터 및 지정된 기간 내에 질의를 뒷받침할 수 있는 충분하고 검증된
              근거(Evidence)가 발견되지 않았습니다. Signal Archive는 환각(Hallucination) 및 미검증된
              허위 답변 생성을 방지하기 위해 답변 생성을 보류했습니다.
            </p>

            {#if response.coverage.limitations.length > 0}
              <div class="limitations-box">
                <span class="limitations-title"
                  >{currentLocale === 'ko'
                    ? '수집 범위의 한계:'
                    : 'Reported Coverage Limitations:'}</span
                >
                <ul class="limitations-list">
                  {#each response.coverage.limitations as lim, i (lim + String(i))}
                    <li>{lim}</li>
                  {/each}
                </ul>
              </div>
            {/if}

            <div class="guidance-box">
              <span class="guidance-title">{currentLocale === 'ko' ? '제안:' : 'Suggestions:'}</span
              >
              <ul class="guidance-list">
                <li>조회 기간을 90일 이상으로 확장하여 검색 범위를 넓혀보세요.</li>
                <li>
                  'Sources' 탭에서 현재 수집·색인 중인 소스 목록 및 상태(Freshness)를 확인하세요.
                </li>
                <li>'Topics' 탭에서 지원되는 공식 표준 토픽 키워드로 다시 질의해보세요.</li>
              </ul>
            </div>
          </div>
        </div>

        <!-- State 3: Unsupported Intent -->
      {:else}
        <div class="notice-card info-state" role="region" aria-label="Unsupported Intent Notice">
          <div class="notice-icon" aria-hidden="true">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
          </div>
          <div class="notice-content">
            <h3 class="notice-title">Unsupported Query Intent</h3>
            <p class="notice-description">
              요청하신 질문의 의도가 지원되는 기술 동향 분석 유형(비교 분석, 동향 요약, 릴리스 현황
              등)으로 분류되지 않았습니다.
            </p>
          </div>
        </div>
      {/if}

      <!-- Metric Observations & Comparison Section -->
      {#if response.observations && response.observations.length > 0}
        <div class="section-container" aria-labelledby="obs-heading">
          <div class="section-header">
            <div>
              <div class="section-title-row">
                <h3 id="obs-heading" class="section-title">
                  {hasMultipleSubjects ? 'Comparative Metric Observations' : 'Metric Observations'}
                </h3>
                <span class="no-composite-badge" title="No composite score rule">
                  No Composite Score (Unit-Separated)
                </span>
              </div>
              <p class="section-desc">
                지표 단위 왜곡을 방지하기 위해 서로 다른 단위를 합산하거나 종합 점수로 만들지 않고,
                각 지표 및 단위별 독립적인 관측치와 기준 구간 대비 추세(Trend)를 분리하여
                비교합니다.
              </p>
            </div>
            <span class="obs-count-badge">
              {response.observations.length}
              {response.observations.length === 1 ? 'Observation' : 'Observations'}
            </span>
          </div>

          <!-- Grouped Metric Presentation -->
          <div class="metric-groups-container">
            {#each groupedObservations as group (group.metric)}
              <div class="metric-group-card">
                <div class="group-header">
                  <div class="group-title-box">
                    <h4 class="group-metric-title">{group.metricLabel}</h4>
                    <span class="unit-badge">Unit: {group.unitLabel}</span>
                  </div>
                  <div class="group-period-badge">
                    <span class="period-label">Period:</span>
                    <time class="period-dates">
                      {#if isUnboundedStart(response.resolvedTimeRange.from)}
                        {currentLocale === 'ko'
                          ? '전체 기간 (최신 데이터)'
                          : 'All Time (Latest Data)'} → {formatUtcDateTime(
                          response.resolvedTimeRange.to,
                        )}
                      {:else}
                        {formatUtcDateTime(response.resolvedTimeRange.from)} → {formatUtcDateTime(
                          response.resolvedTimeRange.to,
                        )}
                      {/if}
                    </time>
                  </div>
                </div>

                <div class="group-items-grid" class:comparison-layout={group.items.length > 1}>
                  {#each group.items as item (item.subject + group.metric)}
                    <div class="obs-card" class:highlight-comparison={group.items.length > 1}>
                      <div class="obs-subject-row">
                        <span class="obs-subject">{item.subject}</span>
                        <span class="obs-metric-unit-tag">{group.unitLabel}</span>
                      </div>
                      <div class="obs-value-row">
                        <span class="obs-value">{item.value.toLocaleString()}</span>
                        <span class="obs-unit">{group.unitLabel}</span>
                      </div>
                      {#if item.change !== null && item.change !== undefined}
                        <div class="obs-change-row">
                          <span class="change-label">Trend vs Baseline:</span>
                          <span
                            class="change-value"
                            class:positive={item.change > 0}
                            class:negative={item.change < 0}
                            class:neutral={item.change === 0}
                            title={`Change vs previous baseline period: ${item.change > 0 ? '+' : ''}${item.change}%`}
                          >
                            {#if item.change > 0}
                              <span class="trend-icon" aria-hidden="true">↑</span> +{item.change}%
                            {:else if item.change < 0}
                              <span class="trend-icon" aria-hidden="true">↓</span> {item.change}%
                            {:else}
                              <span class="trend-icon" aria-hidden="true">→</span> 0%
                            {/if}
                          </span>
                        </div>
                      {:else}
                        <div class="obs-change-row">
                          <span
                            class="change-muted"
                            title="No prior baseline observation window available"
                          >
                            Baseline comparison N/A
                          </span>
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Validated Citations Section -->
      {#if response.citations && response.citations.length > 0}
        <div class="section-container" aria-labelledby="citations-heading">
          <div class="section-header">
            <div>
              <h3 id="citations-heading" class="section-title">
                Validated Citations &amp; Evidence
              </h3>
              <p class="section-desc">
                PostgreSQL에 저장된 불변 문서 리비전(Revision)에서 검증된 원문 링크 및 라이선스
                정보입니다.
              </p>
            </div>
            <span class="citation-count-badge">
              {response.citations.length}
              {response.citations.length === 1 ? 'Source Citation' : 'Source Citations'}
            </span>
          </div>

          <div class="citations-list">
            {#each response.citations as cit (cit.id)}
              <article
                id={`citation-${cit.id}`}
                class="citation-card"
                class:highlighted={highlightedCitationId === cit.id}
                aria-labelledby={`citation-title-${cit.id}`}
              >
                <div class="citation-header">
                  <div class="citation-anchor-row">
                    <span class="citation-id-badge" aria-label={`Citation ID ${cit.id}`}>
                      [{cit.id}]
                    </span>
                    <span class="source-badge" title={`Source: ${cit.source}`}>
                      {formatSourceBadge(cit.source)}
                    </span>
                    {#if cit.excerptIsVerbatim}
                      <span
                        class="verbatim-badge"
                        title="Exact verbatim excerpt from original source"
                      >
                        Verbatim Quote
                      </span>
                    {/if}
                  </div>

                  <span class="citation-date">
                    Published: {formatUtcDateTime(cit.publishedAt)}
                  </span>
                </div>

                <h4 id={`citation-title-${cit.id}`} class="citation-title">
                  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
                  <a
                    href={cit.url}
                    target="_blank"
                    rel="external noopener noreferrer"
                    class="citation-link"
                    title={`Open original source link (external): ${cit.title}`}
                  >
                    <span>{cit.title}</span>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      aria-hidden="true"
                    >
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                      <polyline points="15 3 21 3 21 9"></polyline>
                      <line x1="10" y1="14" x2="21" y2="3"></line>
                    </svg>
                  </a>
                </h4>

                {#if cit.excerpt}
                  <blockquote class="citation-excerpt">
                    <p>{cit.excerpt}</p>
                  </blockquote>
                {/if}

                <div class="citation-footer">
                  <div class="doc-rev-id">
                    <span>Revision: <code>{cit.documentRevisionId}</code></span>
                  </div>

                  {#if cit.license}
                    <div class="license-info" aria-label="License & Attribution Details">
                      <span class="license-name">
                        License:
                        {#if cit.license.url}
                          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
                          <a
                            href={cit.license.url}
                            target="_blank"
                            rel="external noopener noreferrer"
                            class="license-link"
                          >
                            {cit.license.name}
                          </a>
                        {:else}
                          <strong>{cit.license.name}</strong>
                        {/if}
                      </span>
                      {#if cit.license.attribution}
                        <span class="attribution-text" title="Required Attribution">
                          • {cit.license.attribution}
                        </span>
                      {/if}
                    </div>
                  {/if}
                </div>
              </article>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Coverage & Governance Footer -->
      <!-- Coverage & Governance Footer with Stale / Partial Source Warnings -->
      <div class="coverage-card" aria-labelledby="coverage-heading">
        <div class="coverage-header">
          <h4 id="coverage-heading" class="coverage-title">
            Data Coverage &amp; Freshness Metadata
          </h4>
          <span class="freshness-status-badge" aria-label="Freshness Status">
            Fresh through: {formatUtcDateTime(response.coverage.dataFreshThrough)}
          </span>
        </div>

        <div class="coverage-stats-row">
          <div class="coverage-stat">
            <span class="stat-label">Data Fresh Through</span>
            <span class="stat-value">{formatUtcDateTime(response.coverage.dataFreshThrough)}</span>
          </div>
          <div class="coverage-stat">
            <span class="stat-label">Sources Used in Answer</span>
            <span class="stat-value">{response.coverage.sourcesUsed} active sources</span>
          </div>
          <div class="coverage-stat">
            <span class="stat-label">Documents Considered</span>
            <span class="stat-value">{response.coverage.documentsConsidered} items</span>
          </div>
        </div>

        {#if response.coverage.limitations.length > 0}
          <div
            class="coverage-limitations"
            role="region"
            aria-label="Coverage and Freshness Warnings"
          >
            <div class="lim-header-row">
              <span class="lim-heading">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  aria-hidden="true"
                  class="warning-svg"
                >
                  <path
                    d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
                  ></path>
                  <line x1="12" y1="9" x2="12" y2="13"></line>
                  <line x1="12" y1="17" x2="12.01" y2="17"></line>
                </svg>
                Coverage Limitations &amp; Freshness Warnings:
              </span>
              <span class="lim-badge">
                {response.coverage.limitations.length}
                {response.coverage.limitations.length === 1 ? 'Advisory' : 'Advisories'}
              </span>
            </div>
            <ul class="lim-list">
              {#each response.coverage.limitations as limitation, i (limitation + String(i))}
                <li class="lim-item">
                  <span class="lim-text">{limitation}</span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .qa-panel {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border-color);
  }

  .panel-title {
    margin: 0 0 6px;
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--text-primary);
  }

  .panel-description {
    margin: 0;
    font-size: 0.95rem;
    color: var(--text-secondary);
    max-width: 800px;
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 9999px;
    font-size: 0.8rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .status-badge.live {
    background-color: rgba(16, 185, 129, 0.15);
    color: var(--status-ok);
    border: 1px solid rgba(16, 185, 129, 0.3);
  }

  .live-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background-color: var(--status-ok);
    display: inline-block;
  }

  /* Form styling */
  .qa-form {
    display: flex;
    flex-direction: column;
    gap: 18px;
    background-color: var(--bg-card);
    padding: 24px;
    border-radius: 12px;
    border: 1px solid var(--border-color);
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .label-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .form-label {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .required {
    color: var(--status-danger);
  }

  .char-counter {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .char-limit-near {
    color: var(--status-warn);
  }

  .char-limit-exceeded {
    color: var(--status-danger);
    font-weight: 700;
  }

  .form-textarea {
    width: 100%;
    padding: 12px 14px;
    background-color: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 0.95rem;
    font-family: inherit;
    resize: vertical;
    transition: border-color 0.15s ease;
  }

  .form-textarea:focus {
    border-color: var(--accent-cyan);
    outline: none;
  }

  .form-help {
    margin: 2px 0 0;
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  /* Sample queries */
  .sample-queries {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .sample-label {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .chips-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .chip-btn {
    background-color: rgba(56, 189, 248, 0.08);
    color: var(--accent-cyan);
    border: 1px solid rgba(56, 189, 248, 0.25);
    padding: 6px 12px;
    border-radius: 9999px;
    font-size: 0.8rem;
    cursor: pointer;
    text-align: left;
    transition: all 0.15s ease;
  }

  .chip-btn:hover:not(:disabled) {
    background-color: rgba(56, 189, 248, 0.18);
    border-color: var(--accent-cyan);
  }

  .chip-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Fieldset controls */
  .controls-fieldset {
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 16px;
    margin: 0;
    background-color: var(--bg-secondary);
  }

  .controls-legend {
    padding: 0 8px;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .controls-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
  }

  .control-item {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .control-label {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .form-select,
  .form-input {
    padding: 8px 12px;
    background-color: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 0.9rem;
  }

  .form-select:focus,
  .form-input:focus {
    border-color: var(--accent-cyan);
    outline: none;
  }

  .custom-range-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px dashed var(--border-color);
  }

  /* Form actions */
  .form-actions {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-top: 4px;
  }

  .submit-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 20px;
    background-color: var(--accent-blue);
    color: #ffffff;
    border: none;
    border-radius: 8px;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .submit-btn:hover:not(:disabled) {
    background-color: #0270a6;
  }

  .submit-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .reset-btn {
    padding: 10px 16px;
    background-color: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    font-size: 0.9rem;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .reset-btn:hover:not(:disabled) {
    background-color: rgba(255, 255, 255, 0.05);
    color: var(--text-primary);
  }

  .reset-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: #ffffff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Loading State */
  .loading-container {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 28px;
    background-color: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 12px;
  }

  .loading-spinner-large {
    width: 36px;
    height: 36px;
    border: 3px solid rgba(56, 189, 248, 0.2);
    border-top-color: var(--accent-cyan);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }

  .loading-title {
    margin: 0 0 4px;
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .loading-subtext {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }

  /* Error Alert */
  .error-card {
    padding: 20px;
    background-color: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--status-danger);
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .error-header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .error-icon {
    color: var(--status-danger);
    flex-shrink: 0;
    margin-top: 2px;
  }

  .error-title {
    margin: 0 0 4px;
    font-size: 1rem;
    font-weight: 700;
    color: var(--status-danger);
  }

  .error-desc {
    margin: 0;
    font-size: 0.9rem;
    color: var(--text-primary);
  }

  .error-details {
    padding: 10px 14px;
    background-color: rgba(0, 0, 0, 0.2);
    border-radius: 6px;
    font-size: 0.85rem;
  }

  .details-heading {
    margin: 0 0 6px;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .details-list {
    margin: 0;
    padding-left: 20px;
    color: var(--text-primary);
  }

  .error-meta {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  /* Results Region */
  .results-container {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .results-meta-card {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px 20px;
    background-color: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 10px;
  }

  .meta-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
  }

  .meta-status {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .badge {
    display: inline-block;
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 0.8rem;
    font-weight: 600;
  }

  .badge-success {
    background-color: rgba(16, 185, 129, 0.2);
    color: var(--status-ok);
    border: 1px solid rgba(16, 185, 129, 0.4);
  }

  .badge-warning {
    background-color: rgba(234, 179, 8, 0.2);
    color: var(--status-warn);
    border: 1px solid rgba(234, 179, 8, 0.4);
  }

  .badge-secondary {
    background-color: rgba(148, 163, 184, 0.15);
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
  }

  .badge-intent {
    background-color: rgba(56, 189, 248, 0.15);
    color: var(--accent-cyan);
    border: 1px solid rgba(56, 189, 248, 0.3);
  }

  .meta-ids {
    display: flex;
    gap: 12px;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .meta-id-tag code {
    background-color: var(--bg-secondary);
    padding: 2px 6px;
    border-radius: 4px;
    color: var(--text-secondary);
  }

  .resolved-range-box {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background-color: var(--bg-secondary);
    border-radius: 6px;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }

  .range-icon {
    color: var(--accent-cyan);
    display: flex;
    align-items: center;
  }

  .range-value strong {
    color: var(--text-primary);
  }

  .unbounded-tag {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 4px;
    background-color: rgba(56, 189, 248, 0.15);
    color: var(--accent-cyan);
    font-weight: 600;
    font-size: 0.8rem;
    border: 1px solid rgba(56, 189, 248, 0.3);
  }

  /* Answer Card */
  .answer-card {
    padding: 24px;
    background-color: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .answer-heading {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--text-primary);
  }

  .answer-paragraph {
    margin: 0;
    font-size: 1.05rem;
    line-height: 1.7;
    color: var(--text-primary);
    white-space: pre-line;
  }

  .citation-jump-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding-top: 14px;
    border-top: 1px solid var(--border-color);
  }

  .jump-label {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .jump-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .citation-jump-btn {
    background-color: rgba(56, 189, 248, 0.1);
    color: var(--accent-cyan);
    border: 1px solid rgba(56, 189, 248, 0.3);
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .citation-jump-btn:hover,
  .citation-jump-btn.active {
    background-color: var(--accent-cyan);
    color: #090d16;
    font-weight: 700;
  }

  /* Notice Cards (Warning/Info) */
  .notice-card {
    display: flex;
    gap: 18px;
    padding: 24px;
    border-radius: 12px;
    border: 1px solid var(--border-color);
  }

  .notice-card.warning-state {
    background-color: rgba(234, 179, 8, 0.08);
    border-color: rgba(234, 179, 8, 0.35);
  }

  .notice-card.info-state {
    background-color: rgba(56, 189, 248, 0.08);
    border-color: rgba(56, 189, 248, 0.35);
  }

  .notice-icon {
    flex-shrink: 0;
    color: var(--status-warn);
    margin-top: 2px;
  }

  .notice-card.info-state .notice-icon {
    color: var(--accent-cyan);
  }

  .notice-content {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .notice-title {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 700;
    color: var(--text-primary);
  }

  .notice-description {
    margin: 0;
    font-size: 0.95rem;
    color: var(--text-secondary);
    line-height: 1.6;
  }

  .limitations-box,
  .guidance-box {
    padding: 12px 16px;
    background-color: rgba(0, 0, 0, 0.25);
    border-radius: 8px;
    font-size: 0.85rem;
  }

  .limitations-title,
  .guidance-title {
    font-weight: 600;
    color: var(--text-primary);
    display: block;
    margin-bottom: 6px;
  }

  .limitations-list,
  .guidance-list {
    margin: 0;
    padding-left: 20px;
    color: var(--text-secondary);
  }

  /* Observations Section & Metric Groups */
  .section-container {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
  }

  .section-title-row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 4px;
  }

  .section-title {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--text-primary);
  }

  .no-composite-badge {
    background-color: rgba(56, 189, 248, 0.12);
    color: var(--accent-cyan);
    border: 1px solid rgba(56, 189, 248, 0.3);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 9999px;
  }

  .section-desc {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .obs-count-badge,
  .citation-count-badge {
    padding: 4px 10px;
    background-color: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 9999px;
    font-size: 0.8rem;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .metric-groups-container {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .metric-group-card {
    background-color: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .group-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    padding-bottom: 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .group-title-box {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .group-metric-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
    color: var(--text-primary);
  }

  .unit-badge {
    background-color: rgba(99, 102, 241, 0.15);
    color: #a5b4fc;
    border: 1px solid rgba(99, 102, 241, 0.3);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
  }

  .group-period-badge {
    font-size: 0.8rem;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .period-label {
    font-weight: 600;
    color: var(--text-secondary);
  }

  .period-dates {
    color: var(--text-secondary);
  }

  .group-items-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 14px;
  }

  .group-items-grid.comparison-layout {
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  }

  .obs-card {
    padding: 16px;
    background-color: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: border-color 0.15s ease;
  }

  .obs-card.highlight-comparison {
    border-color: rgba(56, 189, 248, 0.25);
    background: linear-gradient(180deg, rgba(56, 189, 248, 0.04) 0%, rgba(15, 23, 42, 0.6) 100%);
  }

  .obs-subject-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
  }

  .obs-subject {
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--text-primary);
  }

  .obs-metric-unit-tag {
    font-size: 0.75rem;
    color: var(--accent-cyan);
    background-color: rgba(56, 189, 248, 0.1);
    padding: 2px 6px;
    border-radius: 4px;
  }

  .obs-value-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .obs-value {
    font-size: 1.5rem;
    font-weight: 800;
    color: var(--text-primary);
  }

  .obs-unit {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .obs-change-row {
    font-size: 0.8rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }

  .change-label {
    color: var(--text-muted);
  }

  .change-value {
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .trend-icon {
    font-weight: 800;
  }

  .change-value.positive {
    color: var(--status-ok);
  }

  .change-value.negative {
    color: var(--status-danger);
  }

  .change-value.neutral {
    color: var(--text-secondary);
  }

  .change-muted {
    color: var(--text-muted);
  }
  /* Citations List */
  .citations-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .citation-card {
    padding: 20px;
    background-color: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    transition:
      border-color 0.2s ease,
      box-shadow 0.2s ease;
  }

  .citation-card.highlighted {
    border-color: var(--accent-cyan);
    box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.3);
  }

  .citation-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }

  .citation-anchor-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .citation-id-badge {
    background-color: var(--accent-blue);
    color: #ffffff;
    font-size: 0.75rem;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 4px;
  }

  .source-badge {
    background-color: var(--bg-secondary);
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 4px;
  }

  .verbatim-badge {
    background-color: rgba(16, 185, 129, 0.15);
    color: var(--status-ok);
    border: 1px solid rgba(16, 185, 129, 0.3);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 4px;
  }

  .citation-date {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .citation-title {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 600;
  }

  .citation-link {
    color: var(--accent-cyan);
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .citation-link:hover {
    text-decoration: underline;
  }

  .citation-excerpt {
    margin: 0;
    padding: 12px 16px;
    background-color: var(--bg-secondary);
    border-left: 3px solid var(--accent-cyan);
    border-radius: 0 6px 6px 0;
    font-size: 0.9rem;
    color: var(--text-secondary);
    font-style: italic;
  }

  .citation-excerpt p {
    margin: 0;
  }

  .citation-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    padding-top: 10px;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    font-size: 0.8rem;
  }

  .doc-rev-id {
    color: var(--text-muted);
  }

  .doc-rev-id code {
    background-color: var(--bg-secondary);
    padding: 2px 6px;
    border-radius: 4px;
    color: var(--text-secondary);
  }

  .license-info {
    color: var(--text-secondary);
  }

  .license-link {
    color: var(--accent-cyan);
    text-decoration: underline;
  }

  .attribution-text {
    color: var(--text-muted);
  }

  /* Coverage card */
  /* Coverage card & Freshness Warning Styling */
  .coverage-card {
    padding: 20px;
    background-color: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .coverage-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  .coverage-title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--text-primary);
  }

  .freshness-status-badge {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--status-ok);
    background-color: rgba(16, 185, 129, 0.12);
    border: 1px solid rgba(16, 185, 129, 0.25);
    padding: 3px 8px;
    border-radius: 9999px;
  }

  .coverage-stats-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
  }

  .coverage-stat {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .stat-label {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .stat-value {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--text-primary);
  }

  .coverage-limitations {
    padding: 14px 16px;
    background-color: rgba(234, 179, 8, 0.08);
    border: 1px solid rgba(234, 179, 8, 0.25);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .lim-header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }

  .lim-heading {
    font-weight: 700;
    color: var(--status-warn);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85rem;
  }

  .warning-svg {
    color: var(--status-warn);
    flex-shrink: 0;
  }

  .lim-badge {
    font-size: 0.75rem;
    font-weight: 700;
    background-color: rgba(234, 179, 8, 0.2);
    color: var(--status-warn);
    padding: 2px 6px;
    border-radius: 4px;
  }

  .lim-list {
    margin: 0;
    padding-left: 20px;
    color: var(--text-secondary);
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.85rem;
  }

  .lim-item {
    line-height: 1.5;
  }

  .lim-text {
    color: var(--text-primary);
  }

  @media (max-width: 640px) {
    .panel-header {
      flex-direction: column;
      align-items: flex-start;
    }

    .custom-range-row {
      grid-template-columns: 1fr;
    }

    .meta-row {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>
