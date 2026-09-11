<script lang="ts">
  import { resolve } from '$app/paths';
  import { locale } from '$lib/i18n.js';
</script>

<footer>
  <p>
    Signal Archive <span
      >· {$locale === 'ko'
        ? '출처로 확인하는 기술 변화'
        : 'Technology changes, with evidence'}</span
    >
  </p>
  <a href={resolve('/explore?tab=status')}>{$locale === 'ko' ? '시스템 상태' : 'System health'} ↗</a
  >
</footer>

<style>
  footer {
    display: flex;
    justify-content: space-between;
    gap: 20px;
    align-items: center;
    margin-top: 60px;
    border-top: 1px solid #e0e5dc;
    padding: 24px 0;
    font-size: 12px;
    color: #657166;
  }
  p {
    margin: 0;
  }
  a {
    color: #51624f;
    text-decoration: none;
    white-space: nowrap;
  }
  @media (max-width: 600px) {
    footer {
      align-items: flex-start;
      margin-top: 36px;
    }
    p span {
      display: block;
      margin-top: 5px;
    }
  }
</style>
