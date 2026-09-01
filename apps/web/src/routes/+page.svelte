<script lang="ts">
  import { createApiClient } from '$lib/api-client.js';
  import Header from '$lib/components/Header.svelte';
  import StatusBanner from '$lib/components/StatusBanner.svelte';
  import SourceList from '$lib/components/SourceList.svelte';
  import TopicSearch from '$lib/components/TopicSearch.svelte';
  import AnswerNotice from '$lib/components/AnswerNotice.svelte';
  import Footer from '$lib/components/Footer.svelte';

  type TabId = 'sources' | 'topics' | 'status' | 'qa';

  const client = createApiClient();
  let activeTab = $state<TabId>('sources');

  function handleTabChange(tab: TabId) {
    activeTab = tab;
  }
</script>

<svelte:head>
  <title>TechPulse — Developer Technology Trend Intelligence</title>
</svelte:head>

<Header {activeTab} onTabChange={handleTabChange} />

<main id="main-content" class="main-content">
  <div class="container">
    {#if activeTab === 'sources'}
      <div id="panel-sources" role="tabpanel" aria-labelledby="tab-sources" tabindex="0">
        <SourceList {client} />
      </div>
    {:else if activeTab === 'topics'}
      <div id="panel-topics" role="tabpanel" aria-labelledby="tab-topics" tabindex="0">
        <TopicSearch {client} />
      </div>
    {:else if activeTab === 'status'}
      <div id="panel-status" role="tabpanel" aria-labelledby="tab-status" tabindex="0">
        <StatusBanner {client} />
      </div>
    {:else if activeTab === 'qa'}
      <div id="panel-qa" role="tabpanel" aria-labelledby="tab-qa" tabindex="0">
        <AnswerNotice {client} />
      </div>
    {/if}
  </div>
</main>

<Footer />

<style>
  .main-content {
    flex: 1;
    padding: 32px 24px;
  }

  .container {
    max-width: 1200px;
    margin: 0 auto;
  }

  [role='tabpanel'] {
    outline: none;
  }
</style>
