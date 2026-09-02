import { browser } from '$app/environment';
import { writable } from 'svelte/store';

export type Locale = 'ko' | 'en';
const messages = {
  ko: {
    skip: '본문으로 건너뛰기',
    tagline: '개발 기술 트렌드 인텔리전스',
    navigation: '주요 메뉴',
    sources: '데이터 소스',
    topics: '토픽 카탈로그',
    status: '시스템 상태',
    qa: '질문과 답변',
    language: 'English',
  },
  en: {
    skip: 'Skip to main content',
    tagline: 'Developer Technology Trend Intelligence',
    navigation: 'Main navigation',
    sources: 'Data sources',
    topics: 'Topic catalog',
    status: 'System health',
    qa: 'Q&A engine',
    language: '한국어',
  },
} as const;
export type MessageKey = keyof typeof messages.ko;
function initialLocale(): Locale {
  if (!browser) return 'ko';
  return window.localStorage.getItem('techpulse-locale') === 'en' ? 'en' : 'ko';
}
export const locale = writable<Locale>(initialLocale());
export function setLocale(next: Locale): void {
  locale.set(next);
  if (browser) window.localStorage.setItem('techpulse-locale', next);
}
export function t(key: MessageKey, current: Locale): string {
  return messages[current][key];
}
