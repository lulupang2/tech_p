<script lang="ts">
  import type { Snippet } from 'svelte';
  let { children }: { children?: Snippet } = $props();
</script>

<svelte:head>
  <meta name="color-scheme" content="light" />
  <meta name="description" content="Signal Archive: 출처가 명확한 개발 기술 트렌드 인텔리전스" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
  <link
    href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Noto+Sans+KR:wght@400;500;600;700&display=swap"
    rel="stylesheet"
  />
</svelte:head>

<div class="app-layout">{@render children?.()}</div>

<style>
  :global(:root) {
    --bg-primary: #f7f8f3;
    --bg-secondary: #f7f8f6;
    --bg-card: #fff;
    --border-color: #e3e8e1;
    --text-primary: #10251e;
    --text-secondary: #4f6059;
    --text-muted: #687871;
    --accent-blue: #496b3b;
    --accent-cyan: #496b3b;
    --accent-deep: #0d3a2c;
    --status-ok: #2f9b66;
    --status-warn: #d6922e;
    --status-danger: #d95050;
    font-family: 'Noto Sans KR', 'DM Sans', sans-serif;
    color: var(--text-primary);
    background: var(--bg-primary);
    line-height: 1.5;
  }
  :global(*),
  :global(*::before),
  :global(*::after) {
    box-sizing: border-box;
  }
  :global(body) {
    margin: 0;
    background: var(--bg-primary);
    color: var(--text-primary);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }
  :global(button),
  :global(input),
  :global(select),
  :global(textarea) {
    font: inherit;
  }
  :global(:focus-visible) {
    outline: 3px solid rgba(112, 219, 54, 0.45);
    outline-offset: 2px;
  }
  .app-layout {
    min-height: 100vh;
  }
  :global(.panel-title),
  :global(.source-name),
  :global(.topic-name) {
    color: var(--text-primary) !important;
    letter-spacing: -0.035em;
  }
  :global(.panel-description),
  :global(.footer-text),
  :global(.meta-label),
  :global(.meta-value) {
    color: var(--text-secondary) !important;
  }
  :global(.sources-panel),
  :global(.topics-panel),
  :global(.status-panel),
  :global(.qa-panel) {
    background: transparent !important;
    border: 0 !important;
  }
  :global(.source-card),
  :global(.topic-card),
  :global(.health-card),
  :global(.question-form),
  :global(.answer-card),
  :global(.state-container) {
    background: #fff !important;
    border: 1px solid var(--border-color) !important;
    border-radius: 18px !important;
    box-shadow:
      0 1px 2px rgba(16, 37, 30, 0.02),
      0 14px 30px rgba(16, 37, 30, 0.035) !important;
  }
  :global(input),
  :global(select),
  :global(textarea) {
    background: #f8faf7 !important;
    color: var(--text-primary) !important;
    border-color: #dfe6dc !important;
    border-radius: 12px !important;
  }
  :global(.filter-input:focus),
  :global(input:focus),
  :global(textarea:focus) {
    border-color: #77d946 !important;
    box-shadow: 0 0 0 4px rgba(156, 235, 101, 0.18) !important;
  }
  :global(.primary-btn),
  :global(.submit-btn),
  :global(.ask-btn),
  :global(.load-more-btn),
  :global(.retry-btn) {
    background: var(--accent-deep) !important;
    color: #fff !important;
    border-radius: 12px !important;
    border: 0 !important;
  }
  :global(.status-badge.healthy),
  :global(.badge.healthy) {
    background: #e8f8df !important;
    color: #256d43 !important;
    border-color: #c7efb2 !important;
  }
  :global(.freshness-overview-bar) {
    background: #eef2eb !important;
    border: 1px solid #dfe6dc !important;
    border-radius: 14px !important;
    padding: 6px !important;
  }
  :global(.overview-filter-btn) {
    background: transparent !important;
    color: #6e7b75 !important;
    border: 0 !important;
    border-radius: 10px !important;
  }
  :global(.overview-filter-btn.active) {
    background: #123c2e !important;
    color: #fff !important;
    box-shadow: none !important;
  }
  :global(.overview-filter-btn.healthy.active) {
    background: #9ceb65 !important;
    color: #123c2e !important;
  }
  :global(.view-details-btn) {
    color: #236443 !important;
    border-color: #d7e4d3 !important;
    background: #f8fbf7 !important;
    border-radius: 9px !important;
  }
  :global(.info-label),
  :global(.form-help),
  :global(.char-counter),
  :global(.example-label),
  :global(.control-label),
  :global(.last-checked),
  :global(.detail-guidance),
  :global(.card-meta),
  :global(.coverage-text),
  :global(.observation-meta) {
    color: #5c6d66 !important;
  }
  :global(.info-value),
  :global(.meta-val),
  :global(.health-name),
  :global(.details-list),
  :global(.notes-list),
  :global(.answer-text),
  :global(.citation-title) {
    color: #263d35 !important;
  }
  :global(.muted),
  :global(.source-key),
  :global(.topic-key) {
    color: #687871 !important;
  }
  :global(.footer-meta) {
    color: #5c6d66 !important;
  }
  :global(.source-card footer),
  :global(.topic-card footer) {
    border-color: #d9e0d7 !important;
  }
  @media (max-width: 820px) {
    .app-layout {
      display: block;
    }
  }
</style>
