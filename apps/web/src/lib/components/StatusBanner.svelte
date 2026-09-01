<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiClient, ApiClientError } from '../api-client.js';
  import type { HealthLiveResponse, HealthReadyResponse } from '@techpulse/contracts';

  interface Props {
    client: ApiClient;
  }

  let { client }: Props = $props();

  let loading = $state(true);
  let refreshing = $state(false);
  let liveStatus = $state<HealthLiveResponse | null>(null);
  let readyStatus = $state<HealthReadyResponse | null>(null);
  let errorMessage = $state<string | null>(null);
  let lastCheckedAt = $state<string | null>(null);

  async function checkHealth() {
    refreshing = true;
    errorMessage = null;
    try {
      const [live, ready] = await Promise.all([
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
      ]);
      liveStatus = live;
      readyStatus = ready;
      lastCheckedAt = new Date().toISOString();
    } catch (err) {
      if (err instanceof ApiClientError) {
        errorMessage = `Health check failed (${err.code}): ${err.message}`;
      } else if (err instanceof Error) {
        errorMessage = err.message;
      } else {
        errorMessage = 'Failed to connect to backend API';
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
      <h2 id="status-heading" class="panel-title">System Health &amp; Readiness</h2>
      <p class="panel-description">
        Real-time API live loop and Neon PostgreSQL dependency readiness check.
      </p>
    </div>
    <button
      type="button"
      class="refresh-btn"
      onclick={checkHealth}
      disabled={refreshing}
      aria-label="Refresh system health status"
    >
      {#if refreshing}
        <span class="spinner" aria-hidden="true"></span> Refreshing...
      {:else}
        Refresh
      {/if}
    </button>
  </div>

  {#if loading}
    <div class="state-container loading-state" role="status" aria-busy="true" aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      <span>Checking API and database readiness...</span>
    </div>
  {:else if errorMessage}
    <div class="state-container error-state" role="alert" aria-live="assertive">
      <div class="error-badge" aria-hidden="true">!</div>
      <div class="error-content">
        <strong>Service Unavailable</strong>
        <p>{errorMessage}</p>
        <button type="button" class="retry-btn" onclick={checkHealth}>Retry Connection</button>
      </div>
    </div>
  {:else}
    <div class="health-grid" role="region" aria-label="Health indicators">
      <div class="health-card">
        <div class="card-top">
          <span class="card-label">API Process Event Loop</span>
          <span
            class="status-indicator"
            class:ok={liveStatus?.status === 'ok'}
            aria-label={`API status: ${liveStatus?.status ?? 'unknown'}`}
          >
            {liveStatus?.status ?? 'unknown'}
          </span>
        </div>
        <p class="card-meta">Endpoint: <code>/health/live</code></p>
        <p class="card-time">Reported: {liveStatus?.timestamp ?? 'N/A'}</p>
      </div>

      <div class="health-card">
        <div class="card-top">
          <span class="card-label">Database Dependency (PostgreSQL)</span>
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
        <p class="card-meta">Endpoint: <code>/health/ready</code></p>
        <p class="card-time">Overall Readiness: {readyStatus?.status ?? 'unknown'}</p>
      </div>
    </div>

    {#if lastCheckedAt}
      <p class="last-checked" aria-live="polite">
        Last checked at: <time datetime={lastCheckedAt}>{lastCheckedAt}</time>
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
</style>
