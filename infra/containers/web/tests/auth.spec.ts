import { test, expect } from '@playwright/test';

test('login flow redirects to Cognito Hosted UI', async ({ page }) => {
  page.goto('http://localhost:3000/login?callbackUrl=%2F').catch(() => {});
  await page.waitForURL(/amazoncognito\.com/, { timeout: 15000 });
  // Cognito Hosted UI に到達できれば OK
  expect(page.url()).toContain('amazoncognito.com');
  console.log('✓ Redirected to:', page.url());
});

test('full login flow with Cognito', async ({ page }) => {
  const email = process.env.TEST_USER_EMAIL ?? 'admin@example.com';
  const password = process.env.TEST_USER_PASSWORD ?? '';

  if (!password) {
    test.skip(true, 'TEST_USER_PASSWORD not set');
    return;
  }

  page.goto('http://localhost:3000/login?callbackUrl=%2F').catch(() => {});
  await page.waitForURL(/amazoncognito\.com/, { timeout: 15000 });

  // Cognito Hosted UI でログイン
  await page.locator('#signInFormUsername').first().fill(email);
  await page.locator('#signInFormPassword').first().fill(password);
  await page.locator('input[name="signInSubmitButton"]').first().click();

  // コールバック後にアプリに戻ることを確認
  await page.waitForURL(/localhost:3000/, { timeout: 15000 });
  expect(page.url()).not.toContain('/login');
  console.log('✓ Login successful, redirected to:', page.url());
});
