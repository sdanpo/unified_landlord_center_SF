'use strict';

/**
 * scripts/seed-stripe-payments.js
 *
 * Creates fictitious past Stripe payments for Rotem Porat so her portal
 * payment history page shows real records with working receipt links.
 *
 * Safe to run in TEST mode only (enforced below).  Each run creates new
 * payment records; run once unless you want duplicate entries.
 *
 * Usage:
 *   node scripts/seed-stripe-payments.js
 *
 * Required env var: STRIPE_SECRET_KEY (must start with sk_test_...)
 */

require('dotenv').config();
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';

if (!SECRET_KEY) {
  console.error('ERROR: STRIPE_SECRET_KEY is required.');
  process.exit(1);
}
if (!SECRET_KEY.startsWith('sk_test_')) {
  console.error('ERROR: This script must only be run with a Stripe TEST key (sk_test_...).');
  process.exit(1);
}

const proxyUrl   = process.env.https_proxy || process.env.HTTPS_PROXY || '';
const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

const stripeHttp = axios.create({
  baseURL: 'https://api.stripe.com',
  auth:    { username: SECRET_KEY, password: '' },
  timeout: 30_000,
  ...(httpsAgent ? { httpsAgent, proxy: false } : {}),
});

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

// ── Configuration ──────────────────────────────────────────────────────────────

const TENANT_EMAIL        = 'chamiporat@gmail.com';
const TENANT_NAME         = 'Rotem Porat';
const MONTHLY_RENT_CENTS  = 320_000; // $3,200.00

// 9 months of past rent payments – Jun 2024 through Feb 2025.
// Alternates between Visa and Mastercard test cards for variety.
const PAST_PAYMENTS = [
  { month: 'June 2024',      invoice: 'ACC-SINV-2024-00001', pm: 'pm_card_visa'       },
  { month: 'July 2024',      invoice: 'ACC-SINV-2024-00002', pm: 'pm_card_mastercard' },
  { month: 'August 2024',    invoice: 'ACC-SINV-2024-00003', pm: 'pm_card_visa'       },
  { month: 'September 2024', invoice: 'ACC-SINV-2024-00004', pm: 'pm_card_mastercard' },
  { month: 'October 2024',   invoice: 'ACC-SINV-2024-00005', pm: 'pm_card_visa'       },
  { month: 'November 2024',  invoice: 'ACC-SINV-2024-00006', pm: 'pm_card_mastercard' },
  { month: 'December 2024',  invoice: 'ACC-SINV-2024-00007', pm: 'pm_card_visa'       },
  { month: 'January 2025',   invoice: 'ACC-SINV-2025-00001', pm: 'pm_card_mastercard' },
  { month: 'February 2025',  invoice: 'ACC-SINV-2025-00002', pm: 'pm_card_visa'       },
];

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nSeeding Stripe payment history for ${TENANT_NAME}`);
  console.log(`Email : ${TENANT_EMAIL}`);
  console.log(`Amount: $${(MONTHLY_RENT_CENTS / 100).toFixed(2)} / month\n`);

  // ── 1. Find or create Stripe Customer ───────────────────────────────────────
  console.log('── 1. Stripe Customer ─────────────────────────────────────────');
  const custList = await stripeGet('/v1/customers', { email: TENANT_EMAIL, limit: 1 });

  let customerId;
  if (custList.data && custList.data.length > 0) {
    customerId = custList.data[0].id;
    console.log(`  Found existing customer : ${customerId}`);
    // Ensure name is set
    await stripePost(`/v1/customers/${customerId}`, { name: TENANT_NAME });
  } else {
    const cust = await stripePost('/v1/customers', {
      email:       TENANT_EMAIL,
      name:        TENANT_NAME,
      description: 'Tenant – Rotem Porat (seeded by seed-stripe-payments.js)',
    });
    customerId = cust.id;
    console.log(`  Created new customer    : ${customerId}`);
  }

  // ── 2. Create PaymentIntents (confirmed immediately in test mode) ────────────
  console.log('\n── 2. Payment Records ─────────────────────────────────────────');
  let created = 0;

  for (const p of PAST_PAYMENTS) {
    try {
      const pi = await stripePost('/v1/payment_intents', {
        amount:                 MONTHLY_RENT_CENTS,
        currency:               'usd',
        customer:               customerId,
        payment_method:         p.pm,
        'payment_method_types[]': 'card',
        confirm:                'true',
        description:            `Rent \u2013 ${p.invoice} (${p.month})`,
        'metadata[invoice]':    p.invoice,
        'metadata[tenant]':     TENANT_NAME,
        'metadata[month]':      p.month,
      });

      const brand  = p.pm.includes('mastercard') ? 'Mastercard' : 'Visa';
      const status = pi.status;
      const amount = `$${(pi.amount / 100).toFixed(2)}`;
      console.log(`  ✓ ${p.month.padEnd(18)} ${amount}  ${brand.padEnd(12)} ${status}  (${pi.id})`);
      created++;
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.error(`  ✗ ${p.month}: ${msg}`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n✓ Done. Created ${created}/${PAST_PAYMENTS.length} payment records.\n`);
  console.log('Stripe Dashboard (test):');
  console.log(`  https://dashboard.stripe.com/test/customers/${customerId}\n`);
  console.log('Payment history page (replace with your Railway URL):');
  console.log(`  {WEBHOOK_BASE_URL}/payment-history?email=${encodeURIComponent(TENANT_EMAIL)}\n`);
}

main().catch(err => {
  console.error('\nFatal:', err.response?.data?.error?.message || err.message);
  process.exit(1);
});
