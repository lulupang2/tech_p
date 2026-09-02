<script lang="ts">
  import { ApiClient } from '../api-client.js';

  interface Props {
    client: ApiClient;
  }

  let { client }: Props = $props();

  let answerStatus = $derived(client.getAnswerEndpointStatus());
</script>

<section class="qa-notice-panel" aria-labelledby="qa-heading" id="panel-qa">
  <div class="panel-header">
    <div>
      <h2 id="qa-heading" class="panel-title">Natural-Language Q&amp;A Engine</h2>
      <p class="panel-description">
        Evidence-backed comparative trend analysis and citation synthesis.
      </p>
    </div>
    <span class="status-badge pending" aria-label="Feature Status: Pending Approval">
      Pending Provider Approval
    </span>
  </div>

  <div class="notice-card" role="region" aria-label="Q&A Feature Availability Notice">
    <div class="icon-wrap" aria-hidden="true">
      <svg
        width="24"
        height="24"
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
    <div class="notice-body">
      <h3 class="notice-title">Q&amp;A Service Endpoint Unavailable (Gate: API-003)</h3>
      <p class="notice-text">
        {answerStatus.reason}
      </p>
      <div class="governance-box">
        <h4 class="gov-title">Signal Archive Governance &amp; Grounding Rules:</h4>
        <ul class="gov-list">
          <li>
            <strong>No Hallucinations:</strong> Responses are never generated without verifiable citations
            from approved, deduplicated sources.
          </li>
          <li>
            <strong>Deterministic Pipeline:</strong> Source collection, entity normalization, deduplication,
            and topic categorization run deterministically in the pipeline before any model interaction.
          </li>
          <li>
            <strong>Scope Gate:</strong> Interactive UI answering (WEB-002) will be unlocked only after
            synchronous answer contract and evaluation gates are completed.
          </li>
        </ul>
      </div>
    </div>
  </div>
</section>

<style>
  .qa-notice-panel {
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
  }

  .panel-description {
    margin: 0;
    font-size: 13px;
    color: #94a3b8;
  }

  .status-badge {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    padding: 4px 10px;
    border-radius: 9999px;
  }

  .status-badge.pending {
    background: #854d0e33;
    border: 1px solid #a16207;
    color: #fef08a;
  }

  .notice-card {
    background: #1e293b60;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 20px;
    display: flex;
    gap: 16px;
  }

  .icon-wrap {
    color: #eab308;
    flex-shrink: 0;
    margin-top: 2px;
  }

  .notice-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .notice-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: #f8fafc;
  }

  .notice-text {
    margin: 0;
    font-size: 14px;
    color: #cbd5e1;
    line-height: 1.5;
  }

  .governance-box {
    background: #090d16;
    border: 1px solid #1e293b;
    border-radius: 6px;
    padding: 16px;
    margin-top: 4px;
  }

  .gov-title {
    margin: 0 0 8px 0;
    font-size: 13px;
    color: #38bdf8;
    font-weight: 600;
  }

  .gov-list {
    margin: 0;
    padding-left: 20px;
    font-size: 13px;
    color: #94a3b8;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .gov-list strong {
    color: #e2e8f0;
  }
</style>
