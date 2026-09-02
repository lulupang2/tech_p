<script lang="ts">
  type TabId = 'sources' | 'topics' | 'status' | 'qa';

  interface Props {
    activeTab: TabId;
    onTabChange?: (tab: TabId) => void;
  }

  let { activeTab = 'sources', onTabChange }: Props = $props();

  function selectTab(tab: TabId) {
    onTabChange?.(tab);
  }
</script>

<a href="#main-content" class="skip-link">Skip to main content</a>

<header class="app-header">
  <div class="header-container">
    <div class="brand">
      <div class="brand-logo" aria-hidden="true">TP</div>
      <div>
        <h1 class="brand-title">TechPulse</h1>
        <p class="brand-tagline">Developer Technology Trend Intelligence</p>
      </div>
    </div>

    <nav class="main-nav" aria-label="Main Navigation">
      <ul class="nav-list" role="tablist">
        <li role="presentation">
          <button
            type="button"
            role="tab"
            id="tab-sources"
            aria-controls="panel-sources"
            aria-selected={activeTab === 'sources'}
            class="nav-btn"
            class:active={activeTab === 'sources'}
            onclick={() => selectTab('sources')}
          >
            Data Sources
          </button>
        </li>
        <li role="presentation">
          <button
            type="button"
            role="tab"
            id="tab-topics"
            aria-controls="panel-topics"
            aria-selected={activeTab === 'topics'}
            class="nav-btn"
            class:active={activeTab === 'topics'}
            onclick={() => selectTab('topics')}
          >
            Topic Catalog
          </button>
        </li>
        <li role="presentation">
          <button
            type="button"
            role="tab"
            id="tab-status"
            aria-controls="panel-status"
            aria-selected={activeTab === 'status'}
            class="nav-btn"
            class:active={activeTab === 'status'}
            onclick={() => selectTab('status')}
          >
            System Health
          </button>
        </li>
        <li role="presentation">
          <button
            type="button"
            role="tab"
            id="tab-qa"
            aria-controls="panel-qa"
            aria-selected={activeTab === 'qa'}
            class="nav-btn nav-btn-qa"
            class:active={activeTab === 'qa'}
            onclick={() => selectTab('qa')}
          >
            Q&amp;A Engine
          </button>
        </li>
      </ul>
    </nav>
  </div>
</header>

<style>
  .skip-link {
    position: absolute;
    top: -40px;
    left: 8px;
    background: #0f172a;
    color: #38bdf8;
    padding: 8px 16px;
    z-index: 1000;
    font-weight: 600;
    text-decoration: none;
    border-radius: 4px;
    border: 2px solid #38bdf8;
    transition: top 0.15s ease-in-out;
  }
  .skip-link:focus {
    top: 8px;
  }

  .app-header {
    background: #090d16;
    border-bottom: 1px solid #1e293b;
    color: #f8fafc;
    padding: 16px 24px;
  }

  .header-container {
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 16px;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .brand-logo {
    width: 40px;
    height: 40px;
    background: linear-gradient(135deg, #0284c7, #6366f1);
    color: #ffffff;
    font-weight: 800;
    font-size: 18px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    letter-spacing: -0.5px;
  }

  .brand-title {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.5px;
    color: #f8fafc;
  }

  .brand-tagline {
    margin: 0;
    font-size: 12px;
    color: #94a3b8;
  }

  .main-nav {
    display: flex;
  }

  .nav-list {
    display: flex;
    list-style: none;
    margin: 0;
    padding: 0;
    gap: 8px;
    flex-wrap: wrap;
  }

  .nav-btn {
    background: transparent;
    color: #94a3b8;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 8px 14px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: all 0.15s ease-in-out;
  }

  .nav-btn:hover {
    color: #f8fafc;
    background: #1e293b;
  }

  .nav-btn:focus-visible {
    outline: 2px solid #38bdf8;
    outline-offset: 2px;
  }

  .nav-btn.active {
    color: #38bdf8;
    background: #0c4a6e26;
    border-color: #0284c7;
    font-weight: 600;
  }
</style>
