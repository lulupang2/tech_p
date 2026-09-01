<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children }: { children?: Snippet } = $props();
</script>

<svelte:head>
  <meta name="color-scheme" content="dark" />
  <meta
    name="description"
    content="TechPulse: Developer Technology Trend Intelligence and Citation-Backed Analytics"
  />
</svelte:head>

<div class="app-layout">
  {@render children?.()}
</div>

<style>
  :global(:root) {
    --bg-primary: #090d16;
    --bg-secondary: #0f172a;
    --bg-card: #1e293b;
    --border-color: #334155;
    --text-primary: #f8fafc;
    --text-secondary: #94a3b8;
    --text-muted: #64748b;
    --accent-blue: #0284c7;
    --accent-cyan: #38bdf8;
    --status-ok: #10b981;
    --status-warn: #eab308;
    --status-danger: #ef4444;
    font-family:
      -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Fira Sans',
      'Droid Sans', 'Helvetica Neue', sans-serif;
    color: var(--text-primary);
    background-color: var(--bg-primary);
    line-height: 1.5;
  }

  :global(*),
  :global(*::before),
  :global(*::after) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    padding: 0;
    background-color: #090d16;
    color: #f8fafc;
    min-height: 100vh;
  }

  :global(:focus-visible) {
    outline: 2px solid #38bdf8;
    outline-offset: 2px;
  }

  .app-layout {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }
</style>
