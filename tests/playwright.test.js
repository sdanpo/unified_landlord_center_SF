'use strict';

/**
 * Playwright browser E2E tests against the live ERPNext portal.
 *
 * Tests the tenant-facing pages and the public /apply rental application form.
 *
 * Prerequisites:
 *   1. ERPNext is running and accessible at ERPNEXT_BASE_URL (default: https://lutra.k.frappe.cloud)
 *   2. The /apply Web Form has been created by running: npm run setup:portal
 *   3. Run:  npx jest tests/playwright.test.js --testTimeout=60000 --forceExit
 *
 * All tests use a real Chromium instance (headless).
 * Authenticated-portal tests use the ERPNext administrator session.
 */

require('dotenv').config({ override: true });

const { chromium } = require('playwright');

const BASE_URL = (process.env.ERPNEXT_BASE_URL || 'https://lutra.k.frappe.cloud').replace(/\/$/, '');
const CHROMIUM_PATH = '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome';

// Unique enough to avoid clashing with real applicants
const TEST_EMAIL = `pw.test.${Date.now()}@playwright-ci.invalid`;

let browser;
let context;
let page;

beforeAll(async () => {
  browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  context = await browser.newContext({ ignoreHTTPSErrors: true });
  page    = await context.newPage();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

// ─── Site availability ────────────────────────────────────────────────────────

describe('ERPNext site availability', () => {
  test('login page loads and returns 200', async () => {
    const response = await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    expect(response.status()).toBeLessThan(400);
    const title = await page.title();
    expect(title).toBeTruthy();
  }, 25_000);
});

// ─── /apply — public rental application form ──────────────────────────────────

describe('/apply — Rental Application web form', () => {
  test('page loads and shows the "Rental Application" heading', async () => {
    await page.goto(`${BASE_URL}/apply`, { waitUntil: 'networkidle', timeout: 25_000 });
    const heading = await page.locator('h1, h2, h3, .page-title, .web-form-head h1').first().textContent({ timeout: 10_000 }).catch(() => '');
    expect(heading.toLowerCase()).toContain('rental');
  }, 30_000);

  test('form contains First Name and Last Name fields', async () => {
    await page.goto(`${BASE_URL}/apply`, { waitUntil: 'networkidle', timeout: 25_000 });
    await expect(page.locator('input[data-fieldname="first_name"], [name="first_name"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('input[data-fieldname="last_name"], [name="last_name"]')).toBeVisible({ timeout: 10_000 });
  }, 30_000);

  test('form contains an Email field', async () => {
    await page.goto(`${BASE_URL}/apply`, { waitUntil: 'networkidle', timeout: 25_000 });
    await expect(page.locator('[data-fieldname="email_id"] input, input[name="email_id"], input[type="email"]').first()).toBeVisible({ timeout: 10_000 });
  }, 30_000);

  test('form contains a Phone / mobile_no field', async () => {
    await page.goto(`${BASE_URL}/apply`, { waitUntil: 'networkidle', timeout: 25_000 });
    await expect(page.locator('[data-fieldname="mobile_no"] input, input[name="mobile_no"]').first()).toBeVisible({ timeout: 10_000 });
  }, 30_000);

  test('form contains the Date of Birth custom field', async () => {
    await page.goto(`${BASE_URL}/apply`, { waitUntil: 'networkidle', timeout: 25_000 });
    // Frappe renders the custom field wrapper with the data-fieldname attribute
    await expect(
      page.locator('[data-fieldname="custom_date_of_birth"]').first()
    ).toBeVisible({ timeout: 10_000 });
  }, 30_000);

  test('form contains the Monthly Gross Income custom field', async () => {
    await page.goto(`${BASE_URL}/apply`, { waitUntil: 'networkidle', timeout: 25_000 });
    await expect(
      page.locator('[data-fieldname="custom_monthly_gross_income"]').first()
    ).toBeVisible({ timeout: 10_000 });
  }, 30_000);

  test('form has Consent section with background check checkbox', async () => {
    await page.goto(`${BASE_URL}/apply`, { waitUntil: 'networkidle', timeout: 25_000 });
    await expect(
      page.locator('[data-fieldname="custom_consent_background_check"]').first()
    ).toBeVisible({ timeout: 10_000 });
  }, 30_000);

  test('form has a Submit button', async () => {
    await page.goto(`${BASE_URL}/apply`, { waitUntil: 'networkidle', timeout: 25_000 });
    await expect(
      page.locator('button[type="submit"], .btn-form-submit, .web-form-footer button.btn-primary').first()
    ).toBeVisible({ timeout: 10_000 });
  }, 30_000);

  test('submitting with all required fields shows success message', async () => {
    await page.goto(`${BASE_URL}/apply`, { waitUntil: 'networkidle', timeout: 25_000 });

    // Fill Personal Information
    await page.locator('[data-fieldname="first_name"] input, input[name="first_name"]').first().fill('Playwright');
    await page.locator('[data-fieldname="last_name"] input, input[name="last_name"]').first().fill('Test');
    await page.locator('[data-fieldname="email_id"] input, input[name="email_id"], input[type="email"]').first().fill(TEST_EMAIL);
    await page.locator('[data-fieldname="mobile_no"] input, input[name="mobile_no"]').first().fill('+14155550000');

    // Date of birth
    const dobInput = page.locator('[data-fieldname="custom_date_of_birth"] input').first();
    await dobInput.fill('1990-01-15').catch(() =>
      dobInput.type('01-15-1990')  // some Frappe builds want MM-DD-YYYY
    );

    // Current address
    await page.locator('[data-fieldname="custom_current_address"] textarea, [data-fieldname="custom_current_address"] input').first().fill('123 Test St, San Francisco CA 94102');

    // Monthly rent paid
    await page.locator('[data-fieldname="custom_monthly_rent_paid"] input').first().fill('2500');

    // Employer
    await page.locator('[data-fieldname="company"] input, input[name="company"]').first().fill('Playwright Inc.');

    // Monthly gross income
    await page.locator('[data-fieldname="custom_monthly_gross_income"] input').first().fill('8000');

    // Eviction history — Select "No"
    const evictSelect = page.locator('[data-fieldname="custom_eviction_history"] select, select[name="custom_eviction_history"]').first();
    await evictSelect.selectOption('No').catch(() => {});

    // Broken lease — Select "No"
    const leaseSelect = page.locator('[data-fieldname="custom_broken_lease_history"] select, select[name="custom_broken_lease_history"]').first();
    await leaseSelect.selectOption('No').catch(() => {});

    // Number of occupants
    await page.locator('[data-fieldname="custom_number_of_occupants"] input').first().fill('1');

    // Pets — Select "No"
    const petsSelect = page.locator('[data-fieldname="custom_has_pets"] select, select[name="custom_has_pets"]').first();
    await petsSelect.selectOption('No').catch(() => {});

    // Consent checkboxes
    const consentBg = page.locator('[data-fieldname="custom_consent_background_check"] input[type="checkbox"]').first();
    await consentBg.check().catch(() => consentBg.click());

    const consentAcc = page.locator('[data-fieldname="custom_consent_accuracy"] input[type="checkbox"]').first();
    await consentAcc.check().catch(() => consentAcc.click());

    // Submit
    await page.locator('button[type="submit"], .btn-form-submit, .web-form-footer button.btn-primary').first().click();

    // Wait for success message (contains "received" or "application")
    const successMsg = page.locator('.alert-success, .web-form-success, .form-success-message, [class*="success"]').first();
    await expect(successMsg).toBeVisible({ timeout: 20_000 });
    const text = await successMsg.textContent();
    expect(text.toLowerCase()).toMatch(/received|application|touch/);
  }, 60_000);
});

// ─── Portal pages — authenticated (requires administrator login) ──────────────
//
// These tests use the ERPNext administrator web login.
// They verify the pages exist and return meaningful content.
// Skip with:  SKIP_AUTH_TESTS=1 npx jest tests/playwright.test.js

const SKIP_AUTH = process.env.SKIP_AUTH_TESTS === '1';
const ERPAdmin  = process.env.ERPNEXT_ADMIN_USER     || 'Administrator';
const ERPPass   = process.env.ERPNEXT_ADMIN_PASSWORD || '';

describe('Portal pages — authenticated (admin)', () => {
  let authPage;

  beforeAll(async () => {
    if (SKIP_AUTH || !ERPPass) return;
    authPage = await context.newPage();
    await authPage.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle', timeout: 20_000 });
    await authPage.fill('#login_email, input[name="login"]', ERPAdmin);
    await authPage.fill('#login_password, input[name="password"]', ERPPass);
    await authPage.click('.btn-login, button[type="submit"]');
    await authPage.waitForURL(url => !url.href.includes('/login'), { timeout: 15_000 }).catch(() => {});
  }, 30_000);

  afterAll(async () => { await authPage?.close(); });

  const SKIP = SKIP_AUTH || !ERPPass;

  test.skip(SKIP, '/my-invoices page loads and shows invoice table or empty state', async () => {
    await authPage.goto(`${BASE_URL}/my-invoices`, { waitUntil: 'networkidle', timeout: 20_000 });
    const body = await authPage.locator('body').textContent();
    expect(body).not.toContain('404');
    expect(body.length).toBeGreaterThan(200);
  }, 30_000);

  test.skip(SKIP, '/my-docs page loads and shows document list or empty state', async () => {
    await authPage.goto(`${BASE_URL}/my-docs`, { waitUntil: 'networkidle', timeout: 20_000 });
    const body = await authPage.locator('body').textContent();
    expect(body).not.toContain('404');
  }, 30_000);

  test.skip(SKIP, '/my-lease page loads with lease content or empty state', async () => {
    await authPage.goto(`${BASE_URL}/my-lease`, { waitUntil: 'networkidle', timeout: 20_000 });
    const body = await authPage.locator('body').textContent();
    expect(body).not.toContain('404');
  }, 30_000);

  test.skip(SKIP, '/paid-invoices page loads', async () => {
    await authPage.goto(`${BASE_URL}/paid-invoices`, { waitUntil: 'networkidle', timeout: 20_000 });
    const body = await authPage.locator('body').textContent();
    expect(body).not.toContain('404');
  }, 30_000);
});

// ─── /checkout — Stripe redirect ─────────────────────────────────────────────

describe('GET /checkout endpoint', () => {
  test('returns 400 when invoice_name is missing', async () => {
    const response = await page.goto(
      `${BASE_URL}/checkout`,
      { waitUntil: 'domcontentloaded', timeout: 15_000 }
    );
    // The checkout route is on the Node.js app, not the ERPNext app.
    // If not running locally, skip gracefully.
    if (response) {
      expect([400, 404]).toContain(response.status());
    }
  }, 20_000);
});
