<script lang="ts">
  import { CONTRACT_VERSION } from '@techpulse/contracts';
</script>

<footer class="app-footer">
  <div>
    <strong>Signal Archive</strong>
    <p>검증 가능한 공개 기술 출처를 바탕으로 변화를 읽습니다.</p>
  </div>
  <div class="footer-meta">
    <span>계약 버전 v{CONTRACT_VERSION}</span><span>출처 추적 가능</span><span>UTC 기준</span>
  </div>
</footer>

<style>
  .app-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 24px;
    padding: 28px 6px 0;
    color: #7a8781;
  }
  .app-footer strong {
    font-family: 'DM Sans', sans-serif;
    color: #163b30;
  }
  .app-footer p {
    font-size: 11px;
    margin: 3px 0 0;
  }
  .footer-meta {
    display: flex;
    gap: 18px;
    font-size: 10px;
  }
  .footer-meta span {
    position: relative;
  }
  .footer-meta span + span:before {
    content: '·';
    position: absolute;
    left: -11px;
  }
  @media (max-width: 650px) {
    .app-footer {
      align-items: flex-start;
      flex-direction: column;
    }
    .footer-meta {
      flex-wrap: wrap;
    }
  }
</style>
