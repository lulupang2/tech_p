<script lang="ts">
  import { resolve } from '$app/paths';
  import { locale, setLocale, t } from '$lib/i18n.js';
  let {
    activeTab,
  }: {
    activeTab: 'sources' | 'topics' | 'status' | 'qa';
    onTabChange?: (tab: 'sources' | 'topics' | 'status' | 'qa') => void;
  } = $props();
</script>

<a href="#main-content" class="skip-link">{t('skip', $locale)}</a>
<header class="site-header">
  <a class="brand" href={resolve('/')} aria-label="Signal Archive home"
    ><span class="brand-mark" aria-hidden="true">S<span>↗</span></span><strong
      >Signal Archive</strong
    ></a
  >
  <nav aria-label={t('navigation', $locale)}>
    <a href={resolve('/')} aria-current={activeTab === 'qa' ? 'page' : undefined}
      >{$locale === 'ko' ? '질문' : 'Ask'}</a
    >
    <a href={resolve('/explore')} aria-current={activeTab !== 'qa' ? 'page' : undefined}
      >{$locale === 'ko' ? '트렌드 둘러보기' : 'Explore trends'}</a
    >
  </nav>
  <button class="locale-btn" onclick={() => setLocale($locale === 'ko' ? 'en' : 'ko')}
    >{t('language', $locale)}</button
  >
</header>

<style>
  .skip-link {
    position: fixed;
    top: -60px;
    left: 16px;
    z-index: 100;
    background: #183a2d;
    color: white;
    padding: 12px;
  }
  .skip-link:focus {
    top: 8px;
  }
  .site-header {
    max-width: 1160px;
    margin: auto;
    min-height: 88px;
    padding: 0 28px;
    display: flex;
    align-items: center;
    gap: 40px;
    border-bottom: 1px solid #e3e6df;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #1c3027;
    text-decoration: none;
    margin-right: auto;
    white-space: nowrap;
  }
  .brand strong {
    font:
      700 20px 'DM Sans',
      sans-serif;
    letter-spacing: -0.7px;
  }
  .brand-mark {
    width: 30px;
    height: 32px;
    display: grid;
    place-content: center;
    font:
      700 24px 'DM Sans',
      sans-serif;
    position: relative;
  }
  .brand-mark span {
    position: absolute;
    font-size: 13px;
    top: -2px;
    right: -3px;
    color: #497a4d;
  }
  nav {
    display: flex;
    gap: 28px;
  }
  nav a {
    color: #657067;
    text-decoration: none;
    font-size: 13px;
    padding: 12px 0;
  }
  nav a[aria-current] {
    color: #1b3729;
    font-weight: 700;
    border-bottom: 2px solid #426b48;
  }
  .locale-btn {
    background: transparent;
    border: 1px solid #dce1d8;
    border-radius: 20px;
    padding: 7px 13px;
    color: #536158;
    cursor: pointer;
    font-size: 12px;
  }
  @media (max-width: 600px) {
    .site-header {
      flex-wrap: wrap;
      gap: 14px;
      padding: 18px 20px 12px;
    }
    .brand strong {
      font-size: 18px;
    }
    nav {
      order: 3;
      width: 100%;
      gap: 24px;
    }
    .locale-btn {
      margin-left: auto;
    }
  }
</style>
