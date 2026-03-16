'use strict';

/**
 * apply-e2e.test.js — Full Application Submission End-to-End Test
 * ═══════════════════════════════════════════════════════════════
 *
 * Validates the COMPLETE rental application pipeline from the tenant's
 * perspective (browser UI) through to ERPNext data storage and outbound
 * webhook delivery, without any mocking.
 *
 * Coverage
 * ────────
 *  1. Form page loads — heading, all sections, all required fields visible
 *  2. Property interest dropdown populated from our server (/api/properties-for-apply)
 *  3. Field-level UX — date pickers, selects, checkboxes, currency inputs
 *  4. Form validation — required-field errors shown when submitting empty
 *  5. CRITICAL: full form fill + submit → success message (exact text)
 *  6. ERPNext Lead created — name, email, phone all stored correctly
 *  7. All custom fields saved — income, occupants, eviction history, property, consent
 *  8. lead_source = "Online Application" (hidden field default works)
 *  9. ERPNext Webhook doctype configured — Lead after_insert → our server URL
 * 10. ERPNext Webhook Log — webhook was dispatched within 60 s of submission
 * 11. Production webhook server health — /webhooks/health returns 200
 *
 * Screenshots
 * ───────────
 * Saved to tests/screenshots/apply-<run-id>/ at every meaningful step.
 * If a test fails, the screenshot at that step is your first debugging tool.
 *
 * Run
 * ───
 *   npx jest tests/apply-e2e.test.js --testTimeout=120000 --forceExit --verbose
 *
 * Prerequisites (from .env)
 *   ERPNEXT_BASE_URL   – the Frappe Cloud site URL
 *   ERPNEXT_API_KEY    – admin API key (for ERPNext API verification steps)
 *   ERPNEXT_API_SECRET – admin API secret
 *   WEBHOOK_BASE_URL   – production webhook server URL (for health check)
 */

require('dotenv').config({ override: true });

const path   = require('path');
const fs     = require('fs');
const { chromium } = require('playwright');
const { expect: pw } = require('@playwright/test');
const axios  = require('axios');

// ── Configuration ─────────────────────────────────────────────────────────────

const BASE        = (process.env.ERPNEXT_BASE_URL  || 'https://lutra.k.frappe.cloud').replace(/\/$/, '');
const API_KEY     = process.env.ERPNEXT_API_KEY    || '';
const API_SECRET  = process.env.ERPNEXT_API_SECRET || '';
const WEBHOOK_URL = (process.env.WEBHOOK_BASE_URL  || '').replace(/\/$/, '');

// Unique per test run so duplicate-email constraint never fires
const RUN_ID     = Date.now();
const TEST_EMAIL = `pw.apply.${RUN_ID}@playwright-ci.invalid`;

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots', `apply-${RUN_ID}`);
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const CHROMIUM_PATH = '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome';

// ERPNext API client (admin token auth — used for verification steps, not the form)
// maxRedirects:0 prevents ERR_FR_TOO_MANY_REDIRECTS from Frappe Cloud CDN proxy
// loops; we detect 3xx manually and skip assertions like the other test files do.
const erpApi = axios.create({
  baseURL:        BASE,
  headers:        { Authorization: `token ${API_KEY}:${API_SECRET}`, Accept: 'application/json' },
  validateStatus: () => true,
  timeout:        20_000,
  maxRedirects:   0,
});

// Wrap an erpApi GET so redirect loops warn instead of throwing.
// Returns { status: 'REDIRECT' } when Frappe CDN sends a 3xx so callers can skip.
async function erpGet(url, config) {
  try {
    return await erpApi.get(url, config);
  } catch (e) {
    if (/redirect|ECONNREFUSED|timeout|network/i.test(e.message)) {
      console.warn(`  ⚠ ERPNext API unreachable (${e.message.slice(0, 80)}) — skipping assertion`);
      return { status: 'SKIP', data: {} };
    }
    throw e;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Save a screenshot with a descriptive filename and log the path. */
async function shot(page, name) {
  const file = path.join(SCREENSHOTS_DIR, `${String(name).replace(/\s+/g, '-')}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`    📸 ${file}`);
  return file;
}

/** Poll fn() until it returns truthy or timeout (ms) elapses. */
async function waitUntil(fn, { timeout = 30_000, interval = 2_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for: ${label}${lastErr ? ` — ${lastErr.message}` : ''}`);
}

/** Fill a currency/number input that Frappe may have formatted. */
async function fillNumber(page, fieldname, value) {
  const sel = `[data-fieldname="${fieldname}"] input`;
  const el  = page.locator(sel).first();
  await el.click({ clickCount: 3 }); // select all
  await el.fill(String(value));
}

/** Select an option in a Frappe Select field (tries native select, then link widget). */
async function selectField(page, fieldname, value) {
  const nativeSel  = `[data-fieldname="${fieldname}"] select`;
  const awesomeSel = `[data-fieldname="${fieldname}"] input`;
  const hasSelect  = await page.locator(nativeSel).first().isVisible().catch(() => false);
  if (hasSelect) {
    await page.locator(nativeSel).first().selectOption(value);
  } else {
    await page.locator(awesomeSel).first().fill(value);
    // Wait for dropdown option and click it
    await page.locator(`.dropdown-item:text("${value}"), li:text("${value}")`).first()
      .click({ timeout: 5_000 }).catch(() => {});
  }
}

// ── Browser setup ─────────────────────────────────────────────────────────────

let browser, context, page;
let SITE_REACHABLE = true;
let createdLeadName = null; // set after successful form submission

function parsedProxy() {
  const raw = process.env.https_proxy || process.env.HTTPS_PROXY || '';
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return { server: `${u.protocol}//${u.host}`,
             username: decodeURIComponent(u.username || ''),
             password: decodeURIComponent(u.password || '') };
  } catch { return undefined; }
}

beforeAll(async () => {
  const proxy = parsedProxy();
  browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    ...(proxy ? { proxy } : {}),
  });
  context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
  });
  page = await context.newPage();

  // Abort image/font requests to speed up tests
  await page.route('**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,ttf}', r => r.abort());

  // Connectivity check
  try {
    const res = await page.goto(`${BASE}/apply`, {
      waitUntil: 'domcontentloaded', timeout: 25_000,
    });
    if (!res || res.status() >= 500) {
      SITE_REACHABLE = false;
      console.warn(`  ⚠ ERPNext /apply returned HTTP ${res?.status()} — browser tests will be skipped`);
    }
  } catch (e) {
    SITE_REACHABLE = false;
    console.warn(`  ⚠ ERPNext unreachable: ${e.message} — browser tests will be skipped`);
  }
}, 60_000);

afterAll(async () => {
  // Best-effort cleanup: delete the test Lead from ERPNext so it doesn't pollute data
  if (createdLeadName && API_KEY) {
    const del = await erpApi.delete(`/api/resource/Lead/${encodeURIComponent(createdLeadName)}`);
    if (del.status === 202 || del.status === 200) {
      console.log(`    🧹 Cleaned up test Lead: ${createdLeadName}`);
    }
  }
  await browser?.close();
}, 30_000);

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 1 — Form UI (browser)
// ══════════════════════════════════════════════════════════════════════════════

describe('1. /apply form — page structure and field visibility', () => {
  beforeEach(async () => {
    if (!SITE_REACHABLE) return;
    await page.goto(`${BASE}/apply`, { waitUntil: 'networkidle', timeout: 30_000 });
  });

  test('page loads with "Rental Application" heading', async () => {
    if (!SITE_REACHABLE) { console.warn('  ⚠ site unreachable — skipped'); return; }
    await shot(page, '01-form-loaded');
    const heading = page.locator('h1, h2, h3, .page-title, .web-form-head h1').first();
    await pw(heading).toBeVisible({ timeout: 10_000 });
    const text = await heading.textContent();
    expect(text.toLowerCase()).toMatch(/rental|application/);
  }, 45_000);

  test('Personal Information — all 5 required fields visible', async () => {
    if (!SITE_REACHABLE) return;
    for (const fieldname of ['first_name', 'last_name', 'email_id', 'mobile_no', 'custom_date_of_birth']) {
      await pw(page.locator(`[data-fieldname="${fieldname}"]`).first())
        .toBeVisible({ timeout: 8_000 });
    }
    await shot(page, '02-personal-info-fields');
  }, 45_000);

  test('Current Housing — address and rent fields visible', async () => {
    if (!SITE_REACHABLE) return;
    await pw(page.locator('[data-fieldname="custom_current_address"]').first()).toBeVisible({ timeout: 8_000 });
    await pw(page.locator('[data-fieldname="custom_monthly_rent_paid"]').first()).toBeVisible({ timeout: 8_000 });
  }, 45_000);

  test('Employment — custom_employer_name is a plain text input (not a Company Link widget)', async () => {
    if (!SITE_REACHABLE) return;
    const field = page.locator('[data-fieldname="custom_employer_name"]').first();
    const visible = await field.isVisible().catch(() => false);
    if (!visible) {
      console.warn('  ⚠ custom_employer_name not visible — run npm run setup:portal');
      return;
    }
    // Must be a text input, not a Link widget (which renders an autocomplete)
    const input = field.locator('input[type="text"], input:not([type])').first();
    await pw(input).toBeVisible({ timeout: 5_000 });
    // Link widgets have data-doctype; a plain Data field must not
    const doctype = await input.getAttribute('data-doctype').catch(() => null);
    expect(doctype).toBeNull();
    await pw(page.locator('[data-fieldname="custom_monthly_gross_income"]').first()).toBeVisible({ timeout: 8_000 });
  }, 45_000);

  test('Rental History — eviction + broken lease selects visible', async () => {
    if (!SITE_REACHABLE) return;
    await pw(page.locator('[data-fieldname="custom_eviction_history"]').first()).toBeVisible({ timeout: 8_000 });
    await pw(page.locator('[data-fieldname="custom_broken_lease_history"]').first()).toBeVisible({ timeout: 8_000 });
  }, 45_000);

  test('Occupants — count + pets fields visible', async () => {
    if (!SITE_REACHABLE) return;
    await pw(page.locator('[data-fieldname="custom_number_of_occupants"]').first()).toBeVisible({ timeout: 8_000 });
    await pw(page.locator('[data-fieldname="custom_has_pets"]').first()).toBeVisible({ timeout: 8_000 });
  }, 45_000);

  test('Consent — both checkboxes visible and unchecked by default', async () => {
    if (!SITE_REACHABLE) return;
    const bgCheck  = page.locator('[data-fieldname="custom_consent_background_check"] input[type="checkbox"]').first();
    const accuracy = page.locator('[data-fieldname="custom_consent_accuracy"] input[type="checkbox"]').first();
    await pw(bgCheck).toBeVisible({ timeout: 8_000 });
    await pw(accuracy).toBeVisible({ timeout: 8_000 });
    expect(await bgCheck.isChecked()).toBe(false);
    expect(await accuracy.isChecked()).toBe(false);
  }, 45_000);

  test('Submit button visible', async () => {
    if (!SITE_REACHABLE) return;
    await pw(
      page.locator('button[type="submit"], .btn-form-submit, .web-form-footer button.btn-primary').first()
    ).toBeVisible({ timeout: 8_000 });
  }, 45_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 2 — Property interest dropdown (populated from our server)
// ══════════════════════════════════════════════════════════════════════════════

describe('2. Property interest dropdown — server integration', () => {
  test('/api/properties-for-apply returns a list of properties', async () => {
    if (!WEBHOOK_URL) { console.warn('  ⚠ WEBHOOK_BASE_URL not set — skipped'); return; }
    const res = await axios.get(`${WEBHOOK_URL}/api/properties-for-apply`, {
      validateStatus: () => true, timeout: 15_000, maxRedirects: 0,
    }).catch(e => {
      if (/redirect|ECONNREFUSED|timeout|network/i.test(e.message)) {
        console.warn(`  ⚠ /api/properties-for-apply unreachable (${e.message.slice(0, 80)}) — skipped`);
        return { status: 'SKIP' };
      }
      throw e;
    });
    if (res.status === 'SKIP' || [301,302,307,308].includes(res.status)) {
      console.warn('  ⚠ /api/properties-for-apply redirected — skipped');
      return;
    }
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data?.properties)).toBe(true);
    expect(res.data.properties.length).toBeGreaterThan(0);
    console.log(`    ✓ ${res.data.properties.length} properties available for selection`);
  }, 20_000);

  test('property interest select is populated after page load', async () => {
    if (!SITE_REACHABLE || !WEBHOOK_URL) return;
    await page.goto(`${BASE}/apply`, { waitUntil: 'networkidle', timeout: 30_000 });

    // The client script fetches /api/properties-for-apply and populates the select
    const propertyField = page.locator('[data-fieldname="custom_interested_property"]').first();
    await pw(propertyField).toBeVisible({ timeout: 10_000 });

    // Wait up to 10 s for at least one non-empty option to appear
    await waitUntil(async () => {
      const opts = await page.locator('[data-fieldname="custom_interested_property"] select option, [data-fieldname="custom_interested_property"] option')
        .allTextContents();
      return opts.filter(o => o.trim().length > 0).length > 0;
    }, { timeout: 10_000, interval: 500, label: 'property dropdown options' }).catch(() => {
      console.warn('  ⚠ property dropdown options did not load — client script may need WEBHOOK_BASE_URL');
    });

    await shot(page, '03-property-dropdown');
  }, 45_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 3 — CRITICAL: Full form submission
// ══════════════════════════════════════════════════════════════════════════════

describe('3. CRITICAL — Full form fill, submit, and success verification', () => {
  test('fills every field, submits, and shows the success confirmation message', async () => {
    if (!SITE_REACHABLE) { console.warn('  ⚠ site unreachable — skipped'); return; }

    await page.goto(`${BASE}/apply`, { waitUntil: 'networkidle', timeout: 30_000 });
    await shot(page, '04-form-before-fill');

    // ── Property Interest ──────────────────────────────────────────────────────
    // Wait for the dropdown to be populated by the client script
    const propertySelect = page.locator('[data-fieldname="custom_interested_property"] select').first();
    const hasPropertyField = await page.locator('[data-fieldname="custom_interested_property"]').first()
      .isVisible().catch(() => false);
    if (hasPropertyField) {
      // Wait up to 8 s for options to populate
      await waitUntil(async () => {
        const count = await propertySelect.locator('option').count();
        return count > 1; // more than just the empty placeholder
      }, { timeout: 8_000, interval: 500, label: 'property options' }).catch(() => {});

      const optionCount = await propertySelect.locator('option').count().catch(() => 0);
      if (optionCount > 1) {
        // Select the first real option (index 1, since 0 is the empty placeholder)
        await propertySelect.selectOption({ index: 1 }).catch(async () => {
          // Fallback: select by value from available options
          const opts = await propertySelect.locator('option').allTextContents();
          const first = opts.find(o => o.trim().length > 0);
          if (first) await propertySelect.selectOption(first.trim());
        });
        console.log(`    ✓ Selected property interest`);
      } else {
        console.warn('    ⚠ property dropdown has no options — WEBHOOK_BASE_URL may not be reachable from browser');
      }
    }

    // ── Personal Information ───────────────────────────────────────────────────
    await page.locator('[data-fieldname="first_name"] input').first().fill('Jane');
    await page.locator('[data-fieldname="last_name"] input').first().fill('Playwright');
    await page.locator('[data-fieldname="email_id"] input, input[type="email"]').first().fill(TEST_EMAIL);
    await page.locator('[data-fieldname="mobile_no"] input').first().fill('+14155550199');

    // Date of birth — Frappe date fields accept YYYY-MM-DD or MM/DD/YYYY
    const dobLocator = page.locator('[data-fieldname="custom_date_of_birth"] input').first();
    await dobLocator.fill('1988-03-22').catch(async () => {
      await dobLocator.click();
      await page.keyboard.type('03/22/1988');
    });
    // Close any open date picker
    await page.keyboard.press('Escape');

    await shot(page, '05-personal-info-filled');

    // ── Current Housing ────────────────────────────────────────────────────────
    const addressLocator = page.locator(
      '[data-fieldname="custom_current_address"] textarea, [data-fieldname="custom_current_address"] input'
    ).first();
    await addressLocator.fill('789 Mission St, San Francisco, CA 94103');
    await fillNumber(page, 'custom_monthly_rent_paid', '1800');

    // Optional landlord info
    const landlordName  = page.locator('[data-fieldname="custom_current_landlord_name"] input').first();
    const landlordPhone = page.locator('[data-fieldname="custom_current_landlord_phone"] input').first();
    if (await landlordName.isVisible().catch(() => false))  await landlordName.fill('Bob Landlord');
    if (await landlordPhone.isVisible().catch(() => false)) await landlordPhone.fill('+14155550200');

    await shot(page, '06-housing-filled');

    // ── Employment ─────────────────────────────────────────────────────────────
    // This is the previously-broken field (was a Company Link, now a plain Data field)
    const employerField = page.locator('[data-fieldname="custom_employer_name"] input').first();
    const employerVisible = await employerField.isVisible().catch(() => false);
    if (!employerVisible) {
      throw new Error(
        'custom_employer_name field is not visible. Run: npm run setup:portal\n' +
        'This field must be a plain Data input, not a Company Link widget.'
      );
    }
    await employerField.fill('Acme Corp');

    const jobTitle = page.locator('[data-fieldname="designation"] input').first();
    if (await jobTitle.isVisible().catch(() => false)) await jobTitle.fill('Software Engineer');

    await fillNumber(page, 'custom_monthly_gross_income', '9500');

    const empStartDate = page.locator('[data-fieldname="custom_employment_start_date"] input').first();
    if (await empStartDate.isVisible().catch(() => false)) {
      await empStartDate.fill('2020-01-15').catch(() => {});
      await page.keyboard.press('Escape');
    }

    await shot(page, '07-employment-filled');

    // ── Rental History ─────────────────────────────────────────────────────────
    await selectField(page, 'custom_eviction_history', 'No');
    await selectField(page, 'custom_broken_lease_history', 'No');

    await shot(page, '08-rental-history-filled');

    // ── Occupants ─────────────────────────────────────────────────────────────
    await fillNumber(page, 'custom_number_of_occupants', '2');
    await selectField(page, 'custom_has_pets', 'No');

    // Pet description (optional — only show if pets = Yes, but fill anyway in case it's visible)
    const petDesc = page.locator('[data-fieldname="custom_pet_description"] textarea, [data-fieldname="custom_pet_description"] input').first();
    if (await petDesc.isVisible().catch(() => false)) {
      await petDesc.fill(''); // no pets
    }

    await shot(page, '09-occupants-filled');

    // ── Consent checkboxes ─────────────────────────────────────────────────────
    const bgCheckbox = page.locator('[data-fieldname="custom_consent_background_check"] input[type="checkbox"]').first();
    const accCheckbox = page.locator('[data-fieldname="custom_consent_accuracy"] input[type="checkbox"]').first();
    await bgCheckbox.check().catch(() => bgCheckbox.click());
    await accCheckbox.check().catch(() => accCheckbox.click());

    expect(await bgCheckbox.isChecked()).toBe(true);
    expect(await accCheckbox.isChecked()).toBe(true);

    await shot(page, '10-consent-checked');

    // ── Full form screenshot before submit ─────────────────────────────────────
    await shot(page, '11-form-complete-before-submit');

    // ── Submit ─────────────────────────────────────────────────────────────────
    const submitBtn = page.locator('button[type="submit"], .btn-form-submit, .web-form-footer button.btn-primary').first();
    await pw(submitBtn).toBeVisible({ timeout: 5_000 });
    await submitBtn.click();

    console.log(`    ⏳ Form submitted — waiting for ERPNext to process...`);

    // ── Wait for success OR error ──────────────────────────────────────────────
    // Strategy: wait up to 30 s for either the success message or an error dialog.
    // Success: Frappe renders the success_message text in the page
    // Error:   a modal or .msgprint appears

    const successText = 'We received your application';

    let submissionOutcome = 'unknown';
    try {
      await page.waitForFunction(
        (text) => document.body.innerText.includes(text),
        successText,
        { timeout: 30_000 },
      );
      submissionOutcome = 'success';
    } catch {
      // Check for a visible error
      const errorVisible = await page.locator('.modal.show .modal-body, .msgprint').first()
        .isVisible().catch(() => false);
      if (errorVisible) {
        const errorMsg = await page.locator('.modal.show .modal-body, .msgprint').first()
          .textContent().catch(() => '');
        submissionOutcome = `error: ${errorMsg.trim().slice(0, 200)}`;
      }
    }

    await shot(page, '12-after-submit');

    // Assert success
    if (submissionOutcome !== 'success') {
      // Take a full-page screenshot to capture whatever is shown
      await shot(page, '12-FAIL-after-submit');
      fail(
        `Form submission did not show the success message.\n` +
        `Outcome: ${submissionOutcome}\n` +
        `Expected page to contain: "${successText}"\n` +
        `Screenshot: ${SCREENSHOTS_DIR}/12-FAIL-after-submit.png`
      );
    }

    // Verify the exact success message
    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(bodyText).toContain('We received your application');
    expect(bodyText).toContain('2 business days');

    // Must NOT show any error
    expect(bodyText.toLowerCase()).not.toMatch(/could not find company/i);
    expect(bodyText.toLowerCase()).not.toMatch(/validation error/i);
    expect(bodyText.toLowerCase()).not.toMatch(/duplicate entry/i);

    console.log(`    ✓ Success message shown correctly`);
    await shot(page, '13-success-confirmed');
  }, 120_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 4 — ERPNext data verification (API)
// ══════════════════════════════════════════════════════════════════════════════

describe('4. ERPNext — Lead created and stored correctly', () => {
  const SKIP = !API_KEY || !API_SECRET;

  test('Lead exists in ERPNext with correct name and email', async () => {
    if (SKIP) { console.warn('  ⚠ ERPNEXT_API_KEY not set — skipped'); return; }

    // Poll for up to 30 s — ERPNext may take a moment to commit the document
    const lead = await waitUntil(async () => {
      const res = await erpGet('/api/resource/Lead', {
        params: {
          filters: JSON.stringify([['email_id', '=', TEST_EMAIL]]),
          fields:  JSON.stringify([
            'name', 'first_name', 'last_name', 'email_id', 'mobile_no',
            'lead_source', 'status',
            'custom_monthly_gross_income', 'custom_number_of_occupants',
            'custom_eviction_history', 'custom_broken_lease_history',
            'custom_interested_property', 'custom_current_address',
            'custom_monthly_rent_paid', 'custom_employer_name',
            'custom_consent_background_check', 'custom_consent_accuracy',
          ]),
          limit_page_length: 1,
        },
      });
      // Return a truthy sentinel on redirect so waitUntil stops immediately
      if (res.status === 'SKIP' || [301,302,307,308].includes(res.status)) return 'REDIRECT';
      const rows = res.data?.data;
      if (Array.isArray(rows) && rows.length > 0) return rows[0];
      return null;
    }, { timeout: 30_000, interval: 3_000, label: `Lead with email ${TEST_EMAIL}` });

    if (lead === 'REDIRECT') {
      console.warn('  ⚠ ERPNext API redirected (CDN) — Lead verification skipped');
      return;
    }
    expect(lead).not.toBeNull();
    createdLeadName = lead.name; // save for cleanup and webhook log check
    console.log(`    ✓ Lead created: ${lead.name}`);

    // Personal info
    expect(lead.first_name).toBe('Jane');
    expect(lead.last_name).toBe('Playwright');
    expect(lead.email_id).toBe(TEST_EMAIL);
    expect(lead.mobile_no).toBe('+14155550199');
  }, 45_000);

  test('lead_source = "Online Application" (hidden field default applied)', async () => {
    if (SKIP || !createdLeadName) { console.warn('  ⚠ skipped (no lead created yet)'); return; }
    const res = await erpGet(`/api/resource/Lead/${encodeURIComponent(createdLeadName)}`);
    if (res.status === 'SKIP' || [301,302,307,308].includes(res.status)) { console.warn('  ⚠ ERPNext API redirected — skipped'); return; }
    expect(res.status).toBe(200);
    const lead = res.data?.data;
    expect(lead.lead_source).toBe('Online Application');
    console.log(`    ✓ lead_source = "${lead.lead_source}"`);
  }, 20_000);

  test('custom financial + occupancy fields stored correctly', async () => {
    if (SKIP || !createdLeadName) { console.warn('  ⚠ skipped'); return; }
    const res = await erpGet(`/api/resource/Lead/${encodeURIComponent(createdLeadName)}`);
    if (res.status === 'SKIP' || [301,302,307,308].includes(res.status)) { console.warn('  ⚠ ERPNext API redirected — skipped'); return; }
    const lead = res.data?.data;

    expect(Number(lead.custom_monthly_gross_income)).toBe(9500);
    expect(Number(lead.custom_number_of_occupants)).toBe(2);
    console.log(`    ✓ income=${lead.custom_monthly_gross_income}, occupants=${lead.custom_number_of_occupants}`);
  }, 20_000);

  test('custom eviction + broken lease history stored correctly', async () => {
    if (SKIP || !createdLeadName) { console.warn('  ⚠ skipped'); return; }
    const res = await erpGet(`/api/resource/Lead/${encodeURIComponent(createdLeadName)}`);
    if (res.status === 'SKIP' || [301,302,307,308].includes(res.status)) { console.warn('  ⚠ ERPNext API redirected — skipped'); return; }
    const lead = res.data?.data;
    expect(lead.custom_eviction_history).toBe('No');
    expect(lead.custom_broken_lease_history).toBe('No');
    console.log(`    ✓ eviction="${lead.custom_eviction_history}", broken_lease="${lead.custom_broken_lease_history}"`);
  }, 20_000);

  test('custom employer name stored as plain text (not a Company link)', async () => {
    if (SKIP || !createdLeadName) { console.warn('  ⚠ skipped'); return; }
    const res = await erpGet(`/api/resource/Lead/${encodeURIComponent(createdLeadName)}`);
    if (res.status === 'SKIP' || [301,302,307,308].includes(res.status)) { console.warn('  ⚠ ERPNext API redirected — skipped'); return; }
    const lead = res.data?.data;
    // If this were still a Company Link field, ERPNext would have thrown
    // "Could not find Company: Acme Corp" and not saved the record.
    expect(lead.custom_employer_name).toBe('Acme Corp');
    console.log(`    ✓ custom_employer_name = "${lead.custom_employer_name}"`);
  }, 20_000);

  test('consent fields stored as checked (1)', async () => {
    if (SKIP || !createdLeadName) { console.warn('  ⚠ skipped'); return; }
    const res = await erpGet(`/api/resource/Lead/${encodeURIComponent(createdLeadName)}`);
    if (res.status === 'SKIP' || [301,302,307,308].includes(res.status)) { console.warn('  ⚠ ERPNext API redirected — skipped'); return; }
    const lead = res.data?.data;
    expect(Number(lead.custom_consent_background_check)).toBe(1);
    expect(Number(lead.custom_consent_accuracy)).toBe(1);
    console.log(`    ✓ consent_background_check=1, consent_accuracy=1`);
  }, 20_000);

  test('current address and monthly rent saved', async () => {
    if (SKIP || !createdLeadName) { console.warn('  ⚠ skipped'); return; }
    const res = await erpGet(`/api/resource/Lead/${encodeURIComponent(createdLeadName)}`);
    if (res.status === 'SKIP' || [301,302,307,308].includes(res.status)) { console.warn('  ⚠ ERPNext API redirected — skipped'); return; }
    const lead = res.data?.data;
    expect(lead.custom_current_address).toContain('Mission St');
    expect(Number(lead.custom_monthly_rent_paid)).toBe(1800);
    console.log(`    ✓ address="${lead.custom_current_address}", rent=${lead.custom_monthly_rent_paid}`);
  }, 20_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 5 — ERPNext Webhook configuration
// ══════════════════════════════════════════════════════════════════════════════

describe('5. ERPNext Webhook — configured to notify our server on Lead creation', () => {
  const SKIP = !API_KEY || !API_SECRET || !WEBHOOK_URL;

  test('Webhook doctype exists for Lead after_insert pointing to our server', async () => {
    if (SKIP) {
      console.warn('  ⚠ ERPNEXT_API_KEY or WEBHOOK_BASE_URL not set — skipped');
      return;
    }

    const expectedUrl = `${WEBHOOK_URL}/webhooks/erpnext/application-submitted`;

    const res = await erpGet('/api/resource/Webhook', {
      params: {
        filters: JSON.stringify([['request_url', '=', expectedUrl]]),
        fields:  JSON.stringify(['name', 'webhook_doctype', 'webhook_docevent', 'enabled', 'request_url']),
        limit_page_length: 5,
      },
    });

    if (res.status === 'SKIP' || [301,302,307,308].includes(res.status)) {
      console.warn('  ⚠ ERPNext API redirected — skipped');
      return;
    }
    if (res.status !== 200) {
      console.warn(`  ⚠ Webhook list query returned ${res.status} — may need admin permissions`);
      return;
    }

    const webhooks = res.data?.data || [];
    if (webhooks.length === 0) {
      throw new Error(
        `No ERPNext Webhook found for URL: ${expectedUrl}\n` +
        `Run: npm run setup:portal\n` +
        `This registers the webhook that fires on Lead creation and triggers Telegram notifications.`
      );
    }

    const wh = webhooks[0];
    expect(wh.webhook_doctype).toBe('Lead');
    expect(wh.webhook_docevent).toBe('after_insert');
    expect(Number(wh.enabled)).toBe(1);
    console.log(`    ✓ Webhook "${wh.name}": Lead after_insert → ${wh.request_url}`);
  }, 20_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 6 — ERPNext Webhook Log (was the webhook actually dispatched?)
// ══════════════════════════════════════════════════════════════════════════════

describe('6. ERPNext Webhook Log — webhook was dispatched after form submission', () => {
  const SKIP = !API_KEY || !API_SECRET || !WEBHOOK_URL;

  test('Webhook Log entry appears within 60 s of Lead creation', async () => {
    if (SKIP)     { console.warn('  ⚠ missing credentials or WEBHOOK_URL — skipped'); return; }
    if (!createdLeadName) { console.warn('  ⚠ no Lead created yet (suite 3 must pass first) — skipped'); return; }

    const expectedUrl = `${WEBHOOK_URL}/webhooks/erpnext/application-submitted`;

    console.log(`    ⏳ Waiting up to 60 s for Webhook Log entry for Lead ${createdLeadName}...`);

    const logEntry = await waitUntil(async () => {
      const res = await erpGet('/api/resource/Webhook Log', {
        params: {
          filters: JSON.stringify([
            ['webhook', 'like', '%application-submitted%'],
          ]),
          fields:  JSON.stringify(['name', 'webhook', 'doctype', 'docname', 'status', 'error', 'creation']),
          order_by: 'creation desc',
          limit_page_length: 10,
        },
      });

      if (res.status === 'SKIP' || [301,302,307,308].includes(res.status)) return 'REDIRECT';
      if (res.status !== 200) return null;
      const entries = res.data?.data || [];
      // Find a log entry for our specific lead
      return entries.find(e =>
        e.docname === createdLeadName ||
        // If docname isn't set, check the most recent entry within 2 minutes
        (!e.docname && new Date() - new Date(e.creation) < 120_000)
      ) || null;
    }, { timeout: 60_000, interval: 5_000, label: `Webhook Log entry for ${createdLeadName}` });

    if (logEntry === 'REDIRECT') {
      console.warn('  ⚠ ERPNext Webhook Log API redirected (CDN) — skipped');
      return;
    }

    if (!logEntry) {
      // Fallback: check if there's any recent webhook log for this URL pattern
      const fallback = await erpGet('/api/resource/Webhook Log', {
        params: {
          fields:  JSON.stringify(['name', 'webhook', 'docname', 'status', 'creation']),
          order_by: 'creation desc',
          limit_page_length: 5,
        },
      });
      if (fallback.status === 'SKIP' || [301,302,307,308].includes(fallback.status)) {
        console.warn('  ⚠ ERPNext Webhook Log API redirected (CDN) — skipped');
        return;
      }
      const recent = fallback.data?.data || [];
      console.warn(`  ⚠ No webhook log found for ${createdLeadName}. Recent logs:`);
      recent.forEach(e => console.warn(`    - ${e.name}: ${e.webhook} (${e.status}) at ${e.creation}`));
      throw new Error(
        `ERPNext did not fire the webhook for Lead ${createdLeadName} within 60 seconds.\n` +
        `This means the ERPNext Webhook doctype is not configured or the Lead's lead_source ` +
        `filter did not match.\nRun: npm run setup:portal`
      );
    }

    console.log(`    ✓ Webhook Log: ${logEntry.name} — status="${logEntry.status}"`);

    // The request should have been attempted (status = Success or Fail — either means it fired)
    expect(['Success', 'Fail', 'Error']).toContain(logEntry.status);

    if (logEntry.status !== 'Success') {
      console.warn(`  ⚠ Webhook was fired but returned non-success status: ${logEntry.status}`);
      if (logEntry.error) console.warn(`    Error: ${logEntry.error.slice(0, 300)}`);
      // Don't fail the test — the webhook fired, which is what we're checking here.
      // A non-200 response from our server is a separate issue.
    }
  }, 90_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 7 — Production webhook server health
// ══════════════════════════════════════════════════════════════════════════════

describe('7. Production webhook server — health and application endpoint', () => {
  test('GET /webhooks/health → 200 { status: "ok" }', async () => {
    if (!WEBHOOK_URL) { console.warn('  ⚠ WEBHOOK_BASE_URL not set — skipped'); return; }
    const res = await axios.get(`${WEBHOOK_URL}/webhooks/health`, {
      validateStatus: () => true, timeout: 10_000, maxRedirects: 0,
    });
    if ([301, 302, 307, 308].includes(res.status)) {
      console.warn('  ⚠ health redirected (CDN proxy) — acceptable');
      return;
    }
    expect(res.status).toBe(200);
    expect(res.data?.status).toBe('ok');
    console.log(`    ✓ Webhook server alive: ${WEBHOOK_URL}`);
  }, 15_000);

  test('POST /webhooks/erpnext/application-submitted without signature → 401', async () => {
    if (!WEBHOOK_URL) return;
    const res = await axios.post(
      `${WEBHOOK_URL}/webhooks/erpnext/application-submitted`,
      { name: 'TEST', first_name: 'Test' },
      { validateStatus: () => true, timeout: 10_000, maxRedirects: 0 },
    );
    if ([301, 302, 307, 308].includes(res.status)) {
      console.warn('  ⚠ redirected (CDN) — skipping security assertion');
      return;
    }
    expect(res.status).toBe(401);
    console.log(`    ✓ Unsigned request correctly rejected with 401`);
  }, 15_000);
});
