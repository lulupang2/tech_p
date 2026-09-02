import { expect, test, type Page } from '@playwright/test';

const fixedTimestamp = '2026-09-02T00:00:00.000Z';

const answeredResponse = {
  requestId: 'req_e2e_answered',
  answerId: 'ans_e2e_answered',
  status: 'answered',
  intent: 'compare_interest',
  resolvedTimeRange: {
    from: '2026-08-03T00:00:00.000Z',
    to: '2026-09-02T00:00:00.000Z',
    timezone: 'Asia/Seoul',
  },
  answer: 'Bun의 릴리스 언급량이 비교 기간에 증가했습니다 [C1].',
  observations: [
    {
      subject: 'Bun',
      metric: 'community_mentions',
      value: 42,
      unit: 'deduplicated_documents',
      change: 15,
    },
    {
      subject: 'Node.js',
      metric: 'community_mentions',
      value: 37,
      unit: 'deduplicated_documents',
      change: 4,
    },
  ],
  citations: [
    {
      id: 'C1',
      documentRevisionId: 'rev_e2e_1',
      title: 'Bun v1.1 Release Notes',
      source: 'github_releases',
      url: 'https://github.com/oven-sh/bun/releases/tag/bun-v1.1.0',
      publishedAt: '2026-08-15T12:00:00.000Z',
      excerpt: 'Bun 1.1 includes major compatibility and startup improvements.',
      excerptIsVerbatim: true,
      license: {
        id: 'mit',
        name: 'MIT License',
        url: 'https://opensource.org/licenses/MIT',
        attribution: 'Oven Authors',
      },
    },
  ],
  coverage: {
    dataFreshThrough: fixedTimestamp,
    sourcesUsed: 1,
    documentsConsidered: 2,
    limitations: [],
  },
};

const insufficientResponse = {
  ...answeredResponse,
  requestId: 'req_e2e_insufficient',
  answerId: 'ans_e2e_insufficient',
  status: 'insufficient_evidence',
  intent: 'trend_summary',
  answer: null,
  observations: [],
  citations: [],
  coverage: {
    dataFreshThrough: fixedTimestamp,
    sourcesUsed: 0,
    documentsConsidered: 0,
    limitations: ['요청 기간에 검증 가능한 근거가 없습니다.'],
  },
};

async function installApiFixtures(page: Page): Promise<void> {
  await page.route('**/health/live', async (route) => {
    await route.fulfill({ json: { status: 'ok', timestamp: fixedTimestamp } });
  });
  await page.route('**/health/ready', async (route) => {
    await route.fulfill({
      json: { status: 'ok', timestamp: fixedTimestamp, dependencies: { database: 'ok' } },
    });
  });
  await page.route('**/api/v1/sources**', async (route) => {
    await route.fulfill({
      json: {
        requestId: 'req_e2e_sources',
        items: [
          {
            key: 'github_releases',
            displayName: 'GitHub Releases',
            kind: 'releases',
            status: 'healthy',
            freshThrough: fixedTimestamp,
            lastSuccessfulCollectionAt: fixedTimestamp,
            coverageNotes: ['Approved repository releases and changelogs'],
          },
        ],
        page: { nextCursor: null, limit: 20 },
      },
    });
  });
  await page.route('**/api/v1/topics**', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q')?.toLowerCase() ?? '';
    const items =
      query === 'missing'
        ? []
        : [
            {
              slug: 'typescript',
              displayName: 'TypeScript',
              parent: 'language',
              aliases: ['ts'],
              taxonomyVersion: '2026-09-01.1',
            },
          ];
    await route.fulfill({
      json: { requestId: 'req_e2e_topics', items, page: { nextCursor: null, limit: 20 } },
    });
  });
  await page.route('**/api/v1/answers', async (route) => {
    const request = route.request().postDataJSON() as { question?: string };
    await route.fulfill({
      json: request.question?.includes('근거 없음') ? insufficientResponse : answeredResponse,
    });
  });
}

test.beforeEach(async ({ page }) => {
  await installApiFixtures(page);
  await page.addInitScript(() => {
    if (!localStorage.getItem('signal-archive-locale')) {
      localStorage.setItem('signal-archive-locale', 'ko');
    }
  });
  await page.goto('/');
});

test('한국어 기본 화면과 언어 설정을 유지한다', async ({ page }) => {
  await expect(page).toHaveTitle('Signal Archive — 개발 기술 트렌드 인텔리전스');
  await expect(page.getByText('소스 현황', { exact: true })).toBeVisible();
  await expect(page.getByText('릴리스', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByText('Technology signals at a glance')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Technology signals at a glance')).toBeVisible();
});

test('토픽 검색의 결과와 빈 상태를 표시한다', async ({ page }) => {
  await page.getByRole('tab', { name: '토픽 카탈로그' }).click();
  await expect(page.getByRole('heading', { name: 'TypeScript' })).toBeVisible();

  await page.getByRole('searchbox', { name: '표준 기술 토픽 검색' }).fill('missing');
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect(page.getByText('다음 검색어와 일치하는 표준 토픽이 없습니다:')).toBeVisible();
});

test('비교 답변, 단위별 지표와 클릭 가능한 인용을 표시한다', async ({ page }) => {
  await page.getByRole('tab', { name: '질문과 답변' }).click();
  await page.getByLabel('질문 *').fill('Bun과 Node.js의 관심 변화를 비교해줘.');
  await page.getByRole('button', { name: '근거와 함께 답변받기' }).click();

  await expect(page.getByText('근거 확인됨')).toBeVisible();
  await expect(
    page.getByText('Bun의 릴리스 언급량이 비교 기간에 증가했습니다 [C1].'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Bun v1.1 Release Notes' })).toBeVisible();
  await expect(page.getByText('42')).toBeVisible();
  await expect(page.getByText('37')).toBeVisible();

  const citation = page.getByRole('link', { name: /Bun v1\.1 Release Notes/ });
  await expect(citation).toHaveAttribute('href', answeredResponse.citations[0].url);
});

test('근거가 없는 질문은 답변을 생성하지 않는다', async ({ page }) => {
  await page.getByRole('tab', { name: '질문과 답변' }).click();
  await page.getByLabel('질문 *').fill('근거 없음: 존재하지 않는 기술을 알려줘.');
  await page.getByRole('button', { name: '근거와 함께 답변받기' }).click();

  await expect(page.getByText('질문에 답하기 위한 근거가 부족합니다')).toBeVisible();
  await expect(page.getByText('요청 기간에 검증 가능한 근거가 없습니다.').first()).toBeVisible();
  await expect(page.getByText('종합 답변')).toHaveCount(0);
});
