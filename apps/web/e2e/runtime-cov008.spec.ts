import { expect, test } from '@playwright/test';

test.skip(!process.env['COV008_RUNTIME_API_URL'], 'Requires the COV-008 fixture runtime');

test('renders persisted runtime citations and coverage without mocked responses', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: '질문', exact: true }).click();
  await page.getByLabel('질문 *').fill('TypeScript compiler architecture');
  await page.getByText('기간·시간대·답변 언어 설정', { exact: true }).click();
  await page.locator('#qa-timerange-select').selectOption('custom');
  await page.locator('#qa-custom-from').fill('2026-06-01T00:00');
  await page.locator('#qa-custom-to').fill('2026-09-09T00:00');
  const answerPromise = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/answers') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '근거와 함께 답변받기' }).click();
  const response = await answerPromise;
  expect(response.status()).toBe(200);
  const answer = await response.json();
  expect(answer.status).toBe('answered');
  await expect(page.getByText('Grounded response for smoke testing citing [C1].')).toBeVisible();
  await expect(page.getByRole('link', { name: answer.citations[0].title })).toHaveAttribute(
    'href',
    answer.citations[0].url,
  );
  await expect(page.getByText('Lexical Documents:', { exact: true })).toBeVisible();
  await expect(page.getByText('Vector Documents:', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/cov008-runtime.png', fullPage: true });
});
