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
<aside class="sidebar">
  <div class="brand">
    <div class="brand-logo" aria-hidden="true"><span></span><span></span></div>
    <div>
      <strong>Signal Archive</strong><small
        >{currentLocale === 'ko' ? '인텔리전스' : 'INTELLIGENCE'}</small
      >
    </div>
  </div>
  <p class="nav-eyebrow">{currentLocale === 'ko' ? '메인 메뉴' : 'MAIN MENU'}</p>
  <nav aria-label={t('navigation', currentLocale)}>
    <ul class="nav-list" role="tablist">
      <li>
        <button
          id="tab-sources"
          aria-controls="panel-sources"
          class:active={activeTab === 'sources'}
          role="tab"
          aria-selected={activeTab === 'sources'}
          onclick={() => onTabChange?.('sources')}
          ><span class="icon">⌁</span>{t('sources', currentLocale)}</button
        >
      </li>
      <li>
        <button
          id="tab-topics"
          aria-controls="panel-topics"
          class:active={activeTab === 'topics'}
          role="tab"
          aria-selected={activeTab === 'topics'}
          onclick={() => onTabChange?.('topics')}
          ><span class="icon">◫</span>{t('topics', currentLocale)}</button
        >
      </li>
      <li>
        <button
          id="tab-status"
          aria-controls="panel-status"
          class:active={activeTab === 'status'}
          role="tab"
          aria-selected={activeTab === 'status'}
          onclick={() => onTabChange?.('status')}
          ><span class="icon">⌁</span>{t('status', currentLocale)}</button
        >
      </li>
      <li>
        <button
          id="tab-qa"
          aria-controls="panel-qa"
          class:active={activeTab === 'qa'}
          role="tab"
          aria-selected={activeTab === 'qa'}
          onclick={() => onTabChange?.('qa')}
          ><span class="icon">✦</span>{t('qa', currentLocale)}</button
        >
      </li>
    </ul>
  </nav>
  <div class="sidebar-spacer"></div>
  <div class="insight-card">
    <span class="spark">✦</span><strong
      >{currentLocale === 'ko' ? '기술 변화가 궁금한가요?' : 'Need a fresh insight?'}</strong
    >
    <p>
      {currentLocale === 'ko'
        ? '검증된 출처를 바탕으로 AI에게 바로 질문해 보세요.'
        : 'Ask AI with evidence from verified sources.'}
    </p>
    <button onclick={() => onTabChange?.('qa')}
      >{currentLocale === 'ko' ? '질문 시작하기' : 'Start asking'}</button
    >
  </div>
  <button class="locale-btn" type="button" onclick={toggleLocale}
    ><span>◎</span>{t('language', currentLocale)}</button
  >
</aside>

<style>
  .skip-link {
    position: fixed;
    top: -50px;
    left: 16px;
    z-index: 99;
    background: #10251e;
    color: #fff;
    padding: 10px 16px;
    border-radius: 8px;
  }
  .skip-link:focus {
    top: 16px;
  }
  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    width: 244px;
    background: #f8f9f7;
    border-right: 1px solid #e1e6df;
    padding: 28px 18px 20px;
    display: flex;
    flex-direction: column;
    z-index: 20;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 0 8px 30px;
  }
  .brand-logo {
    width: 34px;
    height: 34px;
    border-radius: 11px;
    background: #a3f16c;
    display: grid;
    place-content: center;
    grid-template-columns: 8px 8px;
    gap: 3px;
    transform: rotate(-8deg);
  }
  .brand-logo span {
    height: 17px;
    background: #123c2e;
    border-radius: 8px 2px;
  }
  .brand strong {
    display: block;
    font-family: 'DM Sans', sans-serif;
    font-size: 17px;
    letter-spacing: -0.04em;
  }
  .brand small {
    display: block;
    font:
      600 8px/1.3 'DM Sans',
      sans-serif;
    letter-spacing: 0.16em;
    color: #8b9892;
  }
  .nav-eyebrow {
    padding: 0 12px;
    margin: 0 0 10px;
    color: #9ba59f;
    font:
      600 9px 'DM Sans',
      sans-serif;
    letter-spacing: 0.12em;
  }
  .nav-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 5px;
  }
  .nav-list button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    border: 0;
    background: transparent;
    padding: 11px 12px;
    border-radius: 10px;
    color: #65736d;
    font-size: 13px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    transition: 0.18s ease;
  }
  .nav-list button:hover {
    background: #eef2ec;
    color: #153d30;
  }
  .nav-list button.active {
    background: #fff;
    color: #123c2e;
    box-shadow: 0 1px 3px rgba(19, 60, 46, 0.08);
    font-weight: 700;
  }
  .icon {
    width: 20px;
    height: 20px;
    border-radius: 6px;
    display: grid;
    place-content: center;
    color: #84918b;
  }
  .active .icon {
    background: #a3f16c;
    color: #123c2e;
  }
  .sidebar-spacer {
    flex: 1;
  }
  .insight-card {
    background: #eef2eb;
    border: 1px solid #e1e7de;
    border-radius: 16px;
    padding: 16px;
    margin: 16px 0;
    text-align: center;
  }
  .spark {
    display: grid;
    place-content: center;
    width: 30px;
    height: 30px;
    margin: -2px auto 8px;
    background: #a3f16c;
    border-radius: 50%;
    color: #123c2e;
  }
  .insight-card strong {
    font-size: 12px;
    display: block;
    color: #153d30;
  }
  .insight-card p {
    font-size: 10px;
    color: #7a8781;
    line-height: 1.5;
    margin: 6px 0 12px;
  }
  .insight-card button {
    width: 100%;
    border: 0;
    border-radius: 9px;
    background: #123c2e;
    color: #fff;
    padding: 9px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }
  .locale-btn {
    border: 0;
    background: transparent;
    color: #74817b;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px;
    font-size: 12px;
    cursor: pointer;
  }
  @media (max-width: 820px) {
    .sidebar {
      position: sticky;
      top: 0;
      width: 100%;
      height: auto;
      padding: 12px 10px;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) 32px;
      align-items: center;
      overflow: hidden;
    }
    .brand {
      padding: 0;
    }
    .brand small,
    .nav-eyebrow,
    .insight-card,
    .sidebar-spacer {
      display: none;
    }
    .nav-list {
      display: flex;
      justify-content: center;
    }
    .nav-list button {
      font-size: 0;
      padding: 9px;
    }
    .nav-list button .icon {
      font-size: 14px;
    }
    .locale-btn {
      width: 32px;
      padding: 7px;
      font-size: 0;
    }
    .locale-btn span {
      font-size: 15px;
    }
  }
</style>
