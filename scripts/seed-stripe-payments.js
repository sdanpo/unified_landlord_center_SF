'use strict';

/**
 * scripts/seed-stripe-payments.js
 *
 * Creates fictitious past payments for Rotem Porat in both Stripe and ERPNext:
 *   • Stripe  – one confirmed PaymentIntent per month (test mode only)
 *   • ERPNext – one submitted Sales Invoice + one submitted Payment Entry per month
 *
 * Safe to run in TEST mode only (enforced below).  Each run checks for
 * existing ERPNext records before creating new ones (idempotent).
 *
 * Usage:
 *   node scripts/seed-stripe-payments.js
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY       (must start with sk_test_...)
 *   ERPNEXT_BASE_URL
 *   ERPNEXT_API_KEY
 *   ERPNEXT_API_SECRET
 *
 * Optional env vars:
 *   STRIPE_BANK_ACCOUNT     ERPNext bank/cash account for paid_to
 *                           (e.g. "Stripe Payout - LD").  If omitted, falls
 *                           back to the first Bank account found in ERPNext.
 */

require('dotenv').config();
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ── Validate required env vars ─────────────────────────────────────────────────

const SECRET_KEY   = process.env.STRIPE_SECRET_KEY   || '';
const ERPNEXT_BASE = (process.env.ERPNEXT_BASE_URL   || '').replace(/\/$/, '');
const ERP_KEY      = process.env.ERPNEXT_API_KEY     || '';
const ERP_SECRET   = process.env.ERPNEXT_API_SECRET  || '';

if (!SECRET_KEY) { console.error('ERROR: STRIPE_SECRET_KEY is required.'); process.exit(1); }
if (!SECRET_KEY.startsWith('sk_test_')) {
  console.error('ERROR: This script must only be run with a Stripe TEST key (sk_test_...).');
  process.exit(1);
}
if (!ERPNEXT_BASE || !ERP_KEY || !ERP_SECRET) {
  console.error('ERROR: ERPNEXT_BASE_URL, ERPNEXT_API_KEY, and ERPNEXT_API_SECRET are required.');
  process.exit(1);
}

// ── HTTP clients ───────────────────────────────────────────────────────────────

const proxyUrl   = process.env.https_proxy || process.env.HTTPS_PROXY || '';
const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
const proxyOpts  = httpsAgent ? { httpsAgent, proxy: false } : {};

const stripeHttp = axios.create({
  baseURL: 'https://api.stripe.com',
  auth:    { username: SECRET_KEY, password: '' },
  timeout: 30_000,
  ...proxyOpts,
});

const erpHttp = axios.create({
  baseURL: ERPNEXT_BASE,
  headers: {
    Authorization:  `token ${ERP_KEY}:${ERP_SECRET}`,
    'Content-Type': 'application/json',
    Accept:         'application/json',
  },
  timeout: 20_000,
  ...proxyOpts,
});

// ── Configuration ──────────────────────────────────────────────────────────────

const TENANT_EMAIL       = 'chamiporat@gmail.com';
const TENANT_NAME        = 'Rotem Porat';
const MONTHLY_RENT_CENTS = 320_000; // $3,200.00
const MONTHLY_RENT       = 3200;
const COMPANY            = 'Lutra (Demo)';
const ABBR               = 'LD';

// 9 months of past rent payments – Jun 2024 through Feb 2025.
// posting_date = 1st of the month, payment_date = 3rd (a couple days later).
const PAST_PAYMENTS = [
  { month: 'June 2024',      posting_date: '2024-06-01', payment_date: '2024-06-03', invoice: 'ACC-SINV-2024-00001', pm: 'pm_card_visa'       },
  { month: 'July 2024',      posting_date: '2024-07-01', payment_date: '2024-07-03', invoice: 'ACC-SINV-2024-00002', pm: 'pm_card_mastercard' },
  { month: 'August 2024',    posting_date: '2024-08-01', payment_date: '2024-08-03', invoice: 'ACC-SINV-2024-00003', pm: 'pm_card_visa'       },
  { month: 'September 2024', posting_date: '2024-09-01', payment_date: '2024-09-03', invoice: 'ACC-SINV-2024-00004', pm: 'pm_card_mastercard' },
  { month: 'October 2024',   posting_date: '2024-10-01', payment_date: '2024-10-03', invoice: 'ACC-SINV-2024-00005', pm: 'pm_card_visa'       },
  { month: 'November 2024',  posting_date: '2024-11-01', payment_date: '2024-11-03', invoice: 'ACC-SINV-2024-00006', pm: 'pm_card_mastercard' },
  { month: 'December 2024',  posting_date: '2024-12-01', payment_date: '2024-12-03', invoice: 'ACC-SINV-2024-00007', pm: 'pm_card_visa'       },
  { month: 'January 2025',   posting_date: '2025-01-01', payment_date: '2025-01-03', invoice: 'ACC-SINV-2025-00001', pm: 'pm_card_mastercard' },
  { month: 'February 2025',  posting_date: '2025-02-01', payment_date: '2025-02-03', invoice: 'ACC-SINV-2025-00002', pm: 'pm_card_visa'       },
];

// ── Stripe helpers ─────────────────────────────────────────────────────────────

async function stripePost(path, fields) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.append(k, String(v));
  const { data } = await stripeHttp.post(path, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return data;
}

async function stripeGet(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();
  const { data } = await stripeHttp.get(qs ? `${path}?${qs}` : path);
  return data;
}

// ── ERPNext helpers ────────────────────────────────────────────────────────────

function enc(s) { return encodeURIComponent(s); }

async function erpList(doctype, filters = [], fields = ['name']) {
  const r = await erpHttp.get(`/api/resource/${enc(doctype)}`, {
    params: {
      fields:           JSON.stringify(fields),
      filters:          JSON.stringify(filters),
      limit_page_length: 50,
    },
  });
  return r.data.data || [];
}

async function erpCreate(doctype, payload) {
  const r = await erpHttp.post(`/api/resource/${enc(doctype)}`, payload);
  return r.data.data;
}

async function erpSubmit(doctype, name) {
  const r = await erpHttp.put(`/api/resource/${enc(doctype)}/${enc(name)}`, { docstatus: 1 });
  return r.data.data;
}

/**
 * Ensure a fiscal year covering `year` (e.g. 2024) exists in ERPNext.
 * Uses Jan 1 – Dec 31 of that calendar year.
 */
async function ensureFiscalYear(year) {
  const startDate = `${year}-01-01`;
  const endDate   = `${year}-12-31`;
  const yearName  = String(year);

  // Check if already present by year_start_date overlap
  const existing = await erpList('Fiscal Year', [
    ['year_start_date', '<=', startDate],
    ['year_end_date',   '>=', startDate],
  ], ['name', 'year_start_date', 'year_end_date']);

  if (existing.length > 0) return existing[0].name;

  try {
    const fy = await erpCreate('Fiscal Year', {
      year:            yearName,
      year_start_date: startDate,
      year_end_date:   endDate,
      companies: [{ company: COMPANY }],
    });
    console.log(`  Created fiscal year : ${fy.name} (${startDate} → ${endDate})`);
    return fy.name;
  } catch (e) {
    // May already exist under a different name – ignore duplicate errors
    const msg = e.response?.data?.exception || e.message;
    if (msg.includes('DuplicateEntryError') || msg.includes('already exists')) {
      console.log(`  Fiscal year ${yearName} already exists (skipped)`);
      return yearName;
    }
    throw e;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nSeeding payment history for ${TENANT_NAME}`);
  console.log(`Email : ${TENANT_EMAIL}`);
  console.log(`Amount: $${(MONTHLY_RENT_CENTS / 100).toFixed(2)} / month\n`);

  // ── 1. Stripe Customer ───────────────────────────────────────────────────────
  console.log('── 1. Stripe Customer ─────────────────────────────────────────');
  const custList = await stripeGet('/v1/customers', { email: TENANT_EMAIL, limit: 1 });
  let stripeCustomerId;
  if (custList.data && custList.data.length > 0) {
    stripeCustomerId = custList.data[0].id;
    console.log(`  Found existing : ${stripeCustomerId}`);
    await stripePost(`/v1/customers/${stripeCustomerId}`, { name: TENANT_NAME });
  } else {
    const cust = await stripePost('/v1/customers', {
      email:       TENANT_EMAIL,
      name:        TENANT_NAME,
      description: 'Tenant – Rotem Porat (seeded by seed-stripe-payments.js)',
    });
    stripeCustomerId = cust.id;
    console.log(`  Created new    : ${stripeCustomerId}`);
  }

  // ── 2. ERPNext Customer ──────────────────────────────────────────────────────
  console.log('\n── 2. ERPNext Customer ────────────────────────────────────────');
  let erpCustomerId;
  const byEmail = await erpList('Customer', [['email_id', '=', TENANT_EMAIL]]);
  if (byEmail.length > 0) {
    erpCustomerId = byEmail[0].name;
    console.log(`  Found by email : ${erpCustomerId}`);
  } else {
    const byName = await erpList('Customer', [['customer_name', '=', TENANT_NAME]]);
    if (byName.length > 0) {
      erpCustomerId = byName[0].name;
      console.log(`  Found by name  : ${erpCustomerId}`);
    } else {
      const cust = await erpCreate('Customer', {
        customer_name:  TENANT_NAME,
        customer_group: 'Tenant',
        customer_type:  'Individual',
        email_id:       TENANT_EMAIL,
      });
      erpCustomerId = cust.name;
      console.log(`  Created new    : ${erpCustomerId}`);
    }
  }

  // ── 3. ERPNext Rent item ─────────────────────────────────────────────────────
  console.log('\n── 3. ERPNext Rent Item ───────────────────────────────────────');
  let rentItemName = 'RENT-001';
  const itemRows = await erpList('Item', [['item_name', '=', 'Monthly Rent']]);
  if (itemRows.length > 0) {
    rentItemName = itemRows[0].name;
    console.log(`  Using existing : ${rentItemName}`);
  } else {
    try {
      const item = await erpCreate('Item', {
        item_code:  'RENT-001',
        item_name:  'Monthly Rent',
        item_group: 'Services',
        is_sales_item: 1,
        is_stock_item: 0,
        include_item_in_manufacturing: 0,
        description: 'Monthly rental charge',
      });
      rentItemName = item.name;
      console.log(`  Created        : ${rentItemName}`);
    } catch (e) {
      console.log(`  Could not create item (${e.response?.data?.exception || e.message}); using 'RENT-001'`);
    }
  }

  // ── 4. ERPNext Fiscal Years ──────────────────────────────────────────────────
  console.log('\n── 4. ERPNext Fiscal Years ────────────────────────────────────');
  const yearsNeeded = [...new Set(PAST_PAYMENTS.map(p => p.posting_date.slice(0, 4)))];
  for (const yr of yearsNeeded) {
    await ensureFiscalYear(Number(yr));
  }
  console.log(`  Fiscal years verified : ${yearsNeeded.join(', ')}`);

  // ── 5. ERPNext Bank account ──────────────────────────────────────────────────
  //
  // Strategy (in order):
  //   a) STRIPE_BANK_ACCOUNT env var – validated against ERPNext first
  //   b) Account linked to Mode of Payment "Credit Card"/"Stripe" for this company
  //   c) Cash - <ABBR> – always present and always accepted by Payment Entry
  //
  const VALID_ACCOUNT_TYPES = ['Bank', 'Cash'];

  async function validateAccount(name) {
    const rows = await erpList('Account', [
      ['name',      '=', name],
      ['is_group',  '=', 0],
    ], ['name', 'account_type']);
    if (!rows.length) return false;
    return VALID_ACCOUNT_TYPES.includes(rows[0].account_type);
  }

  let bankAccount = '';

  if (process.env.STRIPE_BANK_ACCOUNT) {
    const candidate = process.env.STRIPE_BANK_ACCOUNT;
    const valid = await validateAccount(candidate);
    if (valid) {
      bankAccount = candidate;
      console.log(`\n── 5. ERPNext Bank Account ─ ${bankAccount}  (from STRIPE_BANK_ACCOUNT)`);
    } else {
      console.log(`\n  ⚠  STRIPE_BANK_ACCOUNT="${candidate}" is not a valid Bank/Cash account in ERPNext`);
      console.log(`     (account_type must be "Bank" or "Cash" – fix it in Chart of Accounts, or unset the env var)`);
      console.log(`     Falling back to auto-detection…`);
    }
  }

  if (!bankAccount) {
    try {
      const mopRows = await erpList('Mode of Payment Account', [
        ['parent', 'in', ['Credit Card', 'Stripe', 'Bank Transfer', 'Wire Transfer']],
        ['company', '=', COMPANY],
      ], ['default_account', 'parent']);
      if (mopRows.length > 0 && mopRows[0].default_account) {
        bankAccount = mopRows[0].default_account;
        console.log(`\n── 5. ERPNext Bank Account ─ ${bankAccount}  (from Mode of Payment: ${mopRows[0].parent})`);
      }
    } catch (_) { /* ignore – fall through */ }
  }

  if (!bankAccount) {
    bankAccount = `Cash - ${ABBR}`;
    console.log(`\n── 5. ERPNext Bank Account ─ ${bankAccount}  (default Cash; set STRIPE_BANK_ACCOUNT to a Bank/Cash account to override)`);
  }

  // ── 6. Create records month by month ────────────────────────────────────────
  console.log('\n── 6. Payment Records ─────────────────────────────────────────');
  let stripeCreated = 0;
  let erpCreated    = 0;

  for (const p of PAST_PAYMENTS) {
    process.stdout.write(`  ${p.month.padEnd(18)}`);

    // ── Stripe PaymentIntent ────────────────────────────────────────────────
    let stripeStatus = '–';
    let stripePaymentIntentId = null;
    try {
      const pi = await stripePost('/v1/payment_intents', {
        amount:                   MONTHLY_RENT_CENTS,
        currency:                 'usd',
        customer:                 stripeCustomerId,
        payment_method:           p.pm,
        'payment_method_types[]': 'card',
        confirm:                  'true',
        description:              `Rent \u2013 ${p.invoice} (${p.month})`,
        'metadata[invoice]':      p.invoice,
        'metadata[tenant]':       TENANT_NAME,
        'metadata[month]':        p.month,
      });
      stripePaymentIntentId = pi.id; // e.g. "pi_3Abc123..."
      stripeStatus = pi.status;
      stripeCreated++;
    } catch (err) {
      stripeStatus = `ERR: ${err.response?.data?.error?.message || err.message}`;
    }

    // ── ERPNext Sales Invoice ───────────────────────────────────────────────
    let invName    = null;
    let invStatus  = '–';
    const existingInv = await erpList('Sales Invoice', [
      ['customer',      '=', erpCustomerId],
      ['posting_date',  '=', p.posting_date],
      ['docstatus',     'in', [0, 1]],
    ]);
    if (existingInv.length > 0) {
      invName   = existingInv[0].name;
      invStatus = 'existed';
    } else {
      try {
        const inv = await erpCreate('Sales Invoice', {
          customer:       erpCustomerId,
          company:        COMPANY,
          posting_date:   p.posting_date,
          due_date:       p.posting_date, // already paid – due same day
          set_posting_time: 1,
          update_stock:   0,
          debit_to:       `Debtors - ${ABBR}`,
          items: [{
            item_code:      rentItemName,
            qty:            1,
            rate:           MONTHLY_RENT,
            income_account: `Sales - ${ABBR}`,
          }],
          remarks: `Rent – ${p.month}`,
        });
        invName = inv.name;
        await erpSubmit('Sales Invoice', invName);
        invStatus = 'created+submitted';
        erpCreated++;
      } catch (err) {
        invStatus = `ERR: ${err.response?.data?.exception || err.message}`;
      }
    }

    // ── ERPNext Payment Entry ───────────────────────────────────────────────
    let peStatus = '–';
    if (invName) {
      const existingPE = await erpList('Payment Entry', [
        ['party',        '=', erpCustomerId],
        ['posting_date', '=', p.payment_date],
        ['paid_amount',  '=', MONTHLY_RENT],
      ]);
      if (existingPE.length > 0) {
        peStatus = `existed (${existingPE[0].name})`;
      } else {
        try {
          const brand = p.pm.includes('mastercard') ? 'Mastercard' : 'Visa';
          const pe = await erpCreate('Payment Entry', {
            payment_type:    'Receive',
            party_type:      'Customer',
            party:           erpCustomerId,
            posting_date:    p.payment_date,
            company:         COMPANY,
            paid_from:       `Debtors - ${ABBR}`,
            paid_to:         bankAccount,
            paid_amount:     MONTHLY_RENT,
            received_amount: MONTHLY_RENT,
            mode_of_payment: 'Credit Card',
            // Store the real Stripe PaymentIntent ID so the portal can link to the receipt.
            // Falls back to a placeholder if Stripe creation failed for this month.
            reference_no:    stripePaymentIntentId || `STRIPE-${p.invoice}`,
            reference_date:  p.payment_date,
            remarks:         `Stripe ${brand} – ${p.month} rent`,
            references: [{
              reference_doctype: 'Sales Invoice',
              reference_name:    invName,
              allocated_amount:  MONTHLY_RENT,
            }],
          });
          await erpSubmit('Payment Entry', pe.name);
          peStatus = `created (${pe.name})`;
        } catch (err) {
          peStatus = `ERR: ${err.response?.data?.exception || err.message}`;
        }
      }
    }

    console.log(`  stripe=${stripeStatus}  inv=${invStatus}  pe=${peStatus}`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n✓ Done.`);
  console.log(`  Stripe PaymentIntents : ${stripeCreated}/${PAST_PAYMENTS.length}`);
  console.log(`  ERPNext Invoices+PEs  : ${erpCreated}/${PAST_PAYMENTS.length} new`);
  console.log(`\nStripe Dashboard (test):`);
  console.log(`  https://dashboard.stripe.com/test/customers/${stripeCustomerId}`);
  console.log(`\nPayment history page (replace with your Railway URL):`);
  console.log(`  {WEBHOOK_BASE_URL}/payment-history?email=${encodeURIComponent(TENANT_EMAIL)}\n`);
}

main().catch(err => {
  console.error('\nFatal:', err.response?.data?.error?.message || err.response?.data?.exception || err.message);
  process.exit(1);
});
