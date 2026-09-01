<script lang="ts">
  import { CONTRACT_VERSION } from '@techpulse/contracts';
</script>

<footer class="app-footer">
  <div class="footer-container">
    <div class="footer-col">
      <h3 class="footer-heading">TechPulse Intelligence</h3>
      <p class="footer-text">
        Developer Technology Trend Intelligence portfolio project. Synthesizing insights strictly
        backed by verifiable public technical sources.
      </p>
    </div>

    <div class="footer-col">
      <h3 class="footer-heading">Contract &amp; Boundaries</h3>
      <p class="footer-text">
        Schema Contract Version: <code>v{CONTRACT_VERSION}</code>
      </p>
      <p class="footer-text">
        Web frontend strictly consumes <code>@techpulse/contracts</code> without direct DB/provider coupling.
      </p>
    </div>

    <div class="footer-col">
      <h3 class="footer-heading">Source Rights &amp; Attribution</h3>
      <p class="footer-text">
        All ingested data respects upstream licenses (CC BY-SA, MIT, Apache-2.0, Open Access) with
        mandatory attribution. Personal data is strictly stripped prior to persistence.
      </p>
    </div>
  </div>

  <div class="footer-bottom">
    <p>&copy; 2026 TechPulse. Built with SvelteKit &amp; Elysia on Node.</p>
  </div>
</footer>

<style>
  .app-footer {
    background: #090d16;
    border-top: 1px solid #1e293b;
    color: #94a3b8;
    padding: 32px 24px 20px;
    margin-top: auto;
  }

  .footer-container {
    max-width: 1200px;
    margin: 0 auto;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 24px;
  }

  .footer-heading {
    margin: 0 0 8px 0;
    font-size: 14px;
    font-weight: 600;
    color: #f8fafc;
  }

  .footer-text {
    margin: 0 0 6px 0;
    font-size: 12px;
    line-height: 1.5;
    color: #94a3b8;
  }

  .footer-text code {
    background: #1e293b;
    color: #38bdf8;
    padding: 2px 6px;
    border-radius: 4px;
  }

  .footer-bottom {
    max-width: 1200px;
    margin: 24px auto 0;
    padding-top: 16px;
    border-top: 1px solid #1e293b;
    font-size: 11px;
    color: #64748b;
    text-align: center;
  }
</style>
