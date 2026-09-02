<script lang="ts">
  import { env } from '$env/dynamic/public';
  import { createApiClient } from '$lib/api-client.js';
  import Header from '$lib/components/Header.svelte';
  import StatusBanner from '$lib/components/StatusBanner.svelte';
  import SourceList from '$lib/components/SourceList.svelte';
  import TopicSearch from '$lib/components/TopicSearch.svelte';
  import QuestionAnswer from '$lib/components/QuestionAnswer.svelte';
  import Footer from '$lib/components/Footer.svelte';
  type TabId = 'sources' | 'topics' | 'status' | 'qa';
  const client = createApiClient(
    env['PUBLIC_API_BASE_URL'] ? { baseUrl: env['PUBLIC_API_BASE_URL'] } : {},
  );
  let activeTab = $state<TabId>('sources');
  const labels: Record<TabId, { eyebrow: string; title: string; description: string }> = {
    sources: {
      eyebrow: 'SOURCE OVERVIEW',
      title: '기술 신호를 한눈에',
      description: '공개 기술 생태계에서 검증된 출처를 수집하고 최신성을 추적합니다.',
    },
    topics: {
      eyebrow: 'TOPIC CATALOG',
      title: '관심 기술 탐색',
      description: '표준화된 기술 토픽과 연결된 근거를 빠르게 찾아보세요.',
    },
    status: {
      eyebrow: 'SYSTEM HEALTH',
      title: '파이프라인 상태',
      description: 'API와 데이터 처리 계층의 현재 상태를 확인합니다.',
    },
    qa: {
      eyebrow: 'EVIDENCE AI',
      title: '근거로 답하는 기술 인텔리전스',
      description: '기간과 출처가 명확한 기술 트렌드 답변을 받아보세요.',
    },
  };
</script>

<svelte:head><title>Signal Archive — 개발 기술 트렌드 인텔리전스</title></svelte:head>
<Header {activeTab} onTabChange={(tab) => (activeTab = tab)} />
<main id="main-content" class="dashboard-shell">
  <header class="topbar">
    <div><span class="status-dot"></span> 데이터 파이프라인 연결됨</div>
    <button onclick={() => (activeTab = 'qa')}>✦ AI에게 질문하기</button>
  </header>
  <section class="hero">
    <div>
      <p class="eyebrow">{labels[activeTab].eyebrow}</p>
      <h1>{labels[activeTab].title}</h1>
      <p>{labels[activeTab].description}</p>
    </div>
    <div class="signal-orb" aria-hidden="true"><span></span><span></span><strong>TP</strong></div>
  </section>
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
    {:else}<div id="panel-qa" role="tabpanel" aria-labelledby="tab-qa">
        <QuestionAnswer {client} />
      </div>{/if}
  </div>
  <Footer />
</main>

<style>
  .dashboard-shell {
    margin-left: 244px;
    min-height: 100vh;
    padding: 0 38px 36px;
  }
  .topbar {
    height: 74px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid #e1e6df;
    color: #78847f;
    font-size: 12px;
  }
  .topbar > div {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #7de148;
    box-shadow: 0 0 0 4px #e1f8d5;
  }
  .topbar button {
    border: 0;
    background: #123c2e;
    color: #fff;
    border-radius: 10px;
    padding: 10px 15px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .hero {
    min-height: 250px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 42px 6px 34px;
  }
  .eyebrow {
    font:
      700 10px 'DM Sans',
      sans-serif;
    letter-spacing: 0.16em;
    color: #75a85c !important;
    margin: 0 0 11px;
  }
  .hero h1 {
    font-size: 38px;
    line-height: 1.15;
    letter-spacing: -0.055em;
    margin: 0 0 13px;
    color: #10251e;
  }
  .hero p:not(.eyebrow) {
    font-size: 14px;
    color: #74817b;
    margin: 0;
    max-width: 520px;
  }
  .signal-orb {
    width: 150px;
    height: 150px;
    border-radius: 50%;
    background: radial-gradient(
      circle at 35% 30%,
      #efffe6 0,
      #a3f16c 42%,
      #4b9b45 72%,
      #123c2e 100%
    );
    position: relative;
    box-shadow: 0 24px 45px rgba(57, 118, 67, 0.16);
    display: grid;
    place-content: center;
    overflow: hidden;
  }
  .signal-orb:before {
    content: '';
    position: absolute;
    inset: 13px;
    border: 1px solid rgba(255, 255, 255, 0.5);
    border-radius: 50%;
  }
  .signal-orb span {
    position: absolute;
    width: 180px;
    height: 1px;
    background: rgba(255, 255, 255, 0.4);
    transform: rotate(-35deg);
    left: -15px;
  }
  .signal-orb span:nth-child(2) {
    transform: rotate(35deg);
  }
  .signal-orb strong {
    color: #123c2e;
    font:
      700 20px 'DM Sans',
      sans-serif;
    z-index: 1;
  }
  .content-wrap {
    background: #f8faf7;
    border: 1px solid #e5e9e2;
    border-radius: 24px;
    padding: 26px;
    min-height: 430px;
    box-shadow: 0 16px 45px rgba(16, 37, 30, 0.04);
  }
  @media (max-width: 820px) {
    .dashboard-shell {
      margin-left: 0;
      padding: 0 16px 24px;
    }
    .topbar {
      height: 58px;
    }
    .hero {
      min-height: 190px;
      padding: 28px 2px;
    }
    .hero h1 {
      font-size: 29px;
    }
    .signal-orb {
      width: 88px;
      height: 88px;
      flex: none;
      margin-left: 18px;
    }
    .content-wrap {
      padding: 15px;
      border-radius: 18px;
    }
  }
</style>
