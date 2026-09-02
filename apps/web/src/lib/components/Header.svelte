<script lang="ts">
  import { locale, setLocale, t, type Locale } from '$lib/i18n.js';
  type TabId = 'sources' | 'topics' | 'status' | 'qa';
  interface Props {
    activeTab: TabId;
    onTabChange?: (tab: TabId) => void;
  }
  let { activeTab = 'sources', onTabChange }: Props = $props();
  let currentLocale = $state<Locale>('ko');
  locale.subscribe((value) => (currentLocale = value));
  const toggleLocale = () => setLocale(currentLocale === 'ko' ? 'en' : 'ko');
</script>

<a href="#main-content" class="skip-link">{t('skip', currentLocale)}</a>
<header class="app-header">
  <div class="header-container">
    <div class="brand">
      <div class="brand-logo" aria-hidden="true">TP</div>
      <div>
        <h1 class="brand-title">TechPulse</h1>
        <p class="brand-tagline">{t('tagline', currentLocale)}</p>
      </div>
    </div>
    <nav aria-label={t('navigation', currentLocale)}>
      <ul class="nav-list" role="tablist">
        <li role="presentation">
          <button
            class:active={activeTab === 'sources'}
            class="nav-btn"
            role="tab"
            aria-selected={activeTab === 'sources'}
            onclick={() => onTabChange?.('sources')}>{t('sources', currentLocale)}</button
          >
        </li>
        <li role="presentation">
          <button
            class:active={activeTab === 'topics'}
            class="nav-btn"
            role="tab"
            aria-selected={activeTab === 'topics'}
            onclick={() => onTabChange?.('topics')}>{t('topics', currentLocale)}</button
          >
        </li>
        <li role="presentation">
          <button
            class:active={activeTab === 'status'}
            class="nav-btn"
            role="tab"
            aria-selected={activeTab === 'status'}
            onclick={() => onTabChange?.('status')}>{t('status', currentLocale)}</button
          >
        </li>
        <li role="presentation">
          <button
            class:active={activeTab === 'qa'}
            class="nav-btn"
            role="tab"
            aria-selected={activeTab === 'qa'}
            onclick={() => onTabChange?.('qa')}>{t('qa', currentLocale)}</button
          >
        </li>
        <li role="presentation">
          <button class="locale-btn" type="button" onclick={toggleLocale}
            >{t('language', currentLocale)}</button
          >
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
    color: #fff;
    font-weight: 800;
    font-size: 18px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .brand-title {
    margin: 0;
    font-size: 20px;
  }
  .brand-tagline {
    margin: 0;
    font-size: 12px;
    color: #94a3b8;
  }
  .nav-list {
    display: flex;
    list-style: none;
    margin: 0;
    padding: 0;
    gap: 8px;
    flex-wrap: wrap;
  }
  .nav-btn,
  .locale-btn {
    background: transparent;
    color: #94a3b8;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 8px 14px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
  }
  .nav-btn:hover,
  .locale-btn:hover {
    color: #f8fafc;
    background: #1e293b;
  }
  .nav-btn:focus-visible,
  .locale-btn:focus-visible {
    outline: 2px solid #38bdf8;
    outline-offset: 2px;
  }
  .nav-btn.active {
    color: #38bdf8;
    background: #0c4a6e26;
    border-color: #0284c7;
    font-weight: 600;
  }
  .locale-btn {
    color: #fbbf24;
    border-color: #854d0e;
  }
</style>
