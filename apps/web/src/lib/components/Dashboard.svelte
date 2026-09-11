<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { env } from '$env/dynamic/public';
  import { createApiClient } from '$lib/api-client.js';
  import { locale, type Locale } from '$lib/i18n.js';
  import Header from '$lib/components/Header.svelte';
  import StatusBanner from '$lib/components/StatusBanner.svelte';
  import SourceList from '$lib/components/SourceList.svelte';
  import TopicSearch from '$lib/components/TopicSearch.svelte';
  import QuestionAnswer from '$lib/components/QuestionAnswer.svelte';
  import ArchiveContext from '$lib/components/ArchiveContext.svelte';
  import Footer from '$lib/components/Footer.svelte';
  type TabId = 'sources' | 'topics' | 'status' | 'qa';
  const client = createApiClient(
    env['PUBLIC_API_BASE_URL'] ? { baseUrl: env['PUBLIC_API_BASE_URL'] } : {},
  );
  let activeTab = $derived<TabId>(
    page.url.pathname === resolve('/explore')
      ? page.url.searchParams.get('tab') === 'topics'
        ? 'topics'
        : page.url.searchParams.get('tab') === 'status'
          ? 'status'
          : 'sources'
      : 'qa',
  );
  function navigate(tab: TabId) {
    void goto(resolve(tab === 'qa' ? '/' : tab === 'sources' ? '/explore' : `/explore?tab=${tab}`));
  }
  let currentLocale = $state<Locale>('ko');
  locale.subscribe((value) => (currentLocale = value));
  const koLabels: Record<TabId, { eyebrow: string; title: string; description: string }> = {
    sources: {
      eyebrow: '소스 현황',
      title: '기술 신호를 한눈에',
      description: '공개 기술 생태계에서 검증된 출처를 수집하고 최신성을 추적합니다.',
    },
    topics: {
      eyebrow: '토픽 카탈로그',
      title: '관심 기술 탐색',
      description: '표준화된 기술 토픽과 연결된 근거를 빠르게 찾아보세요.',
    },
    status: {
      eyebrow: '시스템 상태',
      title: '파이프라인 상태',
      description: 'API와 데이터 처리 계층의 현재 상태를 확인합니다.',
    },
    qa: {
      eyebrow: '근거 기반 AI',
      title: '어떤 기술 변화가 궁금한가요?',
      description: '궁금한 기술을 질문하세요. 수집된 출처에서 근거를 찾아 답합니다.',
    },
  };
  const enLabels: typeof koLabels = {
    sources: {
      eyebrow: 'SOURCE OVERVIEW',
      title: 'Technology signals at a glance',
      description: 'Track freshness across verified sources in the public technology ecosystem.',
    },
    topics: {
      eyebrow: 'TOPIC CATALOG',
      title: 'Explore technologies',
      description: 'Find canonical technology topics and their linked evidence.',
    },
    status: {
      eyebrow: 'SYSTEM HEALTH',
      title: 'Pipeline health',
      description: 'Check the current state of the API and data-processing layers.',
    },
    qa: {
      eyebrow: 'EVIDENCE AI',
      title: 'What’s changing in your tech stack?',
      description: 'Ask a question. Find answers grounded in collected sources.',
    },
  };
  let labels = $derived(currentLocale === 'ko' ? koLabels : enLabels);
</script>

<svelte:head
  ><title
    >Signal Archive — {currentLocale === 'ko'
      ? '개발 기술 트렌드 인텔리전스'
      : 'Developer technology trend intelligence'}</title
  ></svelte:head
>
<Header {activeTab} onTabChange={navigate} />
<main id="main-content" class="dashboard-shell" class:question-home={activeTab === 'qa'}>
  <section class="hero">
    <div>
      <p class="eyebrow">{labels[activeTab].eyebrow}</p>
      <h1>{labels[activeTab].title}</h1>
      <p>{labels[activeTab].description}</p>
    </div>
  </section>
  {#if activeTab !== 'qa'}
    <nav
      class="explore-nav"
      aria-label={currentLocale === 'ko' ? '탐색 메뉴' : 'Explore navigation'}
    >
      <button
        id="tab-sources"
        class:active={activeTab === 'sources'}
        onclick={() => navigate('sources')}
        >{currentLocale === 'ko' ? '데이터 소스' : 'Data sources'}</button
      >
      <button
        id="tab-topics"
        class:active={activeTab === 'topics'}
        onclick={() => navigate('topics')}
        >{currentLocale === 'ko' ? '토픽 카탈로그' : 'Topic catalog'}</button
      >
      {#if activeTab === 'status'}<span id="tab-status"
          >{currentLocale === 'ko' ? '시스템 상태' : 'System health'}</span
        >{/if}
    </nav>
  {/if}
  <div class="content-wrap">
    {#if activeTab === 'sources'}<div
        id="panel-sources"
        role="tabpanel"
        aria-labelledby="tab-sources"
      >
        <SourceList {client} />
      </div>
    {:else if activeTab === 'topics'}<div
        id="panel-topics"
        role="tabpanel"
        aria-labelledby="tab-topics"
      >
        <TopicSearch {client} />
      </div>
    {:else if activeTab === 'status'}<div
        id="panel-status"
        role="tabpanel"
        aria-labelledby="tab-status"
      >
        <StatusBanner {client} />
      </div>
    {:else}<div id="panel-qa" role="tabpanel" aria-label={currentLocale === 'ko' ? '질문' : 'Ask'}>
        <QuestionAnswer {client} landing />
      </div>{/if}
  </div>
  {#if activeTab === 'qa'}<ArchiveContext {client} />{/if}
  <Footer />
</main>

<style>
  .dashboard-shell {
    max-width: 1080px;
    margin: 0 auto;
    padding: 0 28px;
    min-height: calc(100vh - 88px);
  }
  .hero {
    padding: 54px 0 30px;
  }
  .question-home .hero {
    text-align: center;
    padding: 66px 0 30px;
  }
  .eyebrow {
    font:
      600 11px 'DM Sans',
      sans-serif;
    letter-spacing: 0.18em;
    color: #6c7966;
    margin: 0 0 16px;
  }
  h1 {
    font-size: 40px;
    font-weight: 600;
    letter-spacing: -0.055em;
    line-height: 1.3;
    margin: 0 0 16px;
    color: #203429;
  }
  .hero p:not(.eyebrow) {
    color: #71796e;
    font-size: 14px;
    margin: 0;
    line-height: 1.8;
  }
  .question-home .content-wrap {
    max-width: 820px;
    margin: auto;
  }
  .explore-nav {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 0 24px;
  }
  .explore-nav button {
    border: 1px solid #dce2d5;
    border-radius: 22px;
    padding: 9px 18px;
    background: transparent;
    cursor: pointer;
    color: #53644e;
  }
  .explore-nav button.active {
    background: #233c2e;
    color: white;
    border-color: #233c2e;
  }
  @media (max-width: 600px) {
    .dashboard-shell {
      padding: 0 20px;
    }
    .question-home .hero {
      padding: 40px 0 24px;
    }
    h1 {
      font-size: 29px;
    }
    .hero p:not(.eyebrow) {
      font-size: 13px;
    }
  }
</style>
