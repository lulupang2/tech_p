<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import { locale } from '$lib/i18n.js';
  import type { ApiClient } from '$lib/api-client.js';
  import type { CoverageReportResponse } from '@techpulse/contracts';
  let { client }: { client: ApiClient } = $props();
  let report = $state<CoverageReportResponse | null>(null);
  let loading = $state(true);
  onMount(() => {
    const controller = new AbortController();
    const to = new Date();
    void client
      .getCoverage(
        { from: new Date(to.getTime() - 90 * 86400000).toISOString(), to: to.toISOString() },
        { signal: controller.signal },
      )
      .then((value) => {
        report = value;
      })
      .catch(() => {})
      .finally(() => {
        loading = false;
      });
    return () => controller.abort();
  });
</script>

<section class="archive-context" aria-labelledby="archive-heading">
  <div class="archive-heading">
    <div>
      <p>THE ARCHIVE</p>
      <h2 id="archive-heading">
        {$locale === 'ko' ? '답변의 바탕이 되는 데이터' : 'The data behind your answers'}
      </h2>
    </div>
    <a href={resolve('/explore')}>{$locale === 'ko' ? '수집 범위 확인' : 'View coverage'} ↗</a>
  </div>
  {#if loading}<p class="note" role="status">
      {$locale === 'ko' ? '수집 현황을 확인하고 있습니다…' : 'Checking collection coverage…'}
    </p>
  {:else if report}
    <div class="counts">
      <div>
        <strong>{report.rawDocuments.toLocaleString()}</strong><span
          >{$locale === 'ko' ? '수집 문서' : 'Collected documents'}</span
        >
      </div>
      <div>
        <strong>{report.lexicalDocuments.toLocaleString()}</strong><span
          >{$locale === 'ko' ? '텍스트 검색 가능' : 'Text-searchable documents'}</span
        >
      </div>
      <div>
        <strong
          >{report.partitionsCompleted.toLocaleString()}<small>
            / {report.partitionsChecked.toLocaleString()}</small
          ></strong
        ><span>{$locale === 'ko' ? '완료된 수집 구간' : 'Completed collection partitions'}</span>
      </div>
    </div>
    <p class="note">
      {$locale === 'ko' ? '조회 기간' : 'Window'}: {report.from.slice(0, 10)} – {report.to.slice(
        0,
        10,
      )} UTC · {$locale === 'ko'
        ? '실시간 수집을 의미하지 않습니다.'
        : 'This does not imply real-time collection.'}
    </p>
  {:else}<p class="note" role="status">
      {$locale === 'ko'
        ? '지금은 수집 현황을 확인할 수 없습니다. 질문 입력은 계속할 수 있습니다.'
        : 'Collection coverage is unavailable. You can still enter a question.'}
    </p>{/if}
</section>

<style>
  .archive-context {
    margin: 42px auto 0;
    max-width: 820px;
  }
  .archive-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
  }
  .archive-heading p {
    font:
      600 10px 'DM Sans',
      sans-serif;
    letter-spacing: 0.17em;
    color: #7e887a;
    margin: 0 0 8px;
  }
  h2 {
    font-size: 17px;
    font-weight: 500;
    letter-spacing: -0.04em;
    margin: 0;
  }
  a {
    color: #53694f;
    text-decoration: none;
    font-size: 12px;
    white-space: nowrap;
  }
  .counts {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    margin: 24px 0 14px;
    padding: 20px 0;
    border-block: 1px solid #dfe5d8;
  }
  .counts div {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0 20px;
    border-left: 1px solid #dfe5d8;
  }
  .counts div:first-child {
    padding-left: 0;
    border: 0;
  }
  strong {
    font:
      500 28px 'DM Sans',
      sans-serif;
    color: #2c4431;
  }
  small {
    font-size: 15px;
    color: #81897b;
  }
  span,
  .note {
    font-size: 11px;
    color: #727e6d;
    line-height: 1.7;
  }
  @media (max-width: 600px) {
    .archive-heading {
      align-items: flex-end;
    }
    h2 {
      font-size: 15px;
    }
    .counts div {
      padding: 0 10px;
    }
    strong {
      font-size: 24px;
    }
  }
</style>
