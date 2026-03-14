'use strict';

/**
 * setup-tenant-portal.js
 *
 * Configures the ERPNext tenant self-service portal:
 *   1. Enables portal pages (invoices, payment history, profile, helpdesk)
 *   2. Configures Stripe as the online payment gateway so tenants can pay
 *      rent directly from their portal invoice view
 *   3. Creates / updates Website User accounts for every Customer in the
 *      "Tenant" customer group and links them to their Customer record
 *
 * Tenants can then log in at <ERPNEXT_BASE_URL>/login and see:
 *   - Their rent invoices (/invoices) – with a "Pay Now via Stripe" button
 *   - Their payment history (/payments)
 *   - Maintenance tickets (/helpdesk)
 *   - Their profile / contact details (/me)
 *
 * Usage (idempotent – safe to run multiple times):
 *   node scripts/setup-tenant-portal.js
 *
 * Required env vars:  ERPNEXT_BASE_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET
 * Optional env vars:  STRIPE_PUBLISHABLE_KEY, STRIPE_SECRET_KEY,
 *                     STRIPE_PAYMENT_ACCOUNT (GL account name, default below)
 */

require('dotenv').config();
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const BASE = (process.env.ERPNEXT_BASE_URL || '').replace(/\/$/, '');
const KEY  = process.env.ERPNEXT_API_KEY;
const SEC  = process.env.ERPNEXT_API_SECRET;

if (!BASE || !KEY || !SEC) {
  console.error(
    'ERROR: ERPNEXT_BASE_URL, ERPNEXT_API_KEY, and ERPNEXT_API_SECRET must be set.\n' +
    'Copy .env.example → .env and fill in your credentials.'
  );
  process.exit(1);
}

// When running inside a sandboxed/proxied environment (e.g. CI, cloud shells),
// respect the https_proxy env var so requests reach the target host correctly.
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || '';
const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

const http = axios.create({
  baseURL: BASE,
  headers: {
    Authorization: `token ${KEY}:${SEC}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  timeout: 30_000,
  ...(httpsAgent ? { httpsAgent, proxy: false } : {}),
});

// ── Shared helpers ────────────────────────────────────────────────────────────

/** GET a single document; returns null on 404. */
async function getDoc(doctype, name) {
  try {
    const { data } = await http.get(
      `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`
    );
    return data.data;
  } catch (e) {
    if (e.response?.status === 404) return null;
    throw e;
  }
}

/** Create or update a document (idempotent). */
async function upsert(doctype, name, payload) {
  const existing = await getDoc(doctype, name);
  if (existing) {
    await http.put(
      `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
      payload
    );
    console.log(`  ↺ Updated  ${doctype}: ${name}`);
  } else {
    await http.post(`/api/resource/${encodeURIComponent(doctype)}`, { name, ...payload });
    console.log(`  + Created  ${doctype}: ${name}`);
  }
}

/** List documents with optional server-side filters. */
async function listDocs(doctype, filters = [], fields = ['name']) {
  const { data } = await http.get(`/api/resource/${encodeURIComponent(doctype)}`, {
    params: {
      filters: JSON.stringify(filters),
      fields: JSON.stringify(fields),
      limit_page_length: 500,
    },
  });
  return data.data || [];
}

// ── 1. Portal Settings ────────────────────────────────────────────────────────
// ERPNext's built-in web portal.  Tenants log in with their email address and
// see only their own data (invoices, payments, profile).  The Helpdesk app
// exposes tickets through its own portal UI at /helpdesk.

const PORTAL_MENU_ITEMS = [
  {
    title: 'My Invoices',
    enabled: 1,
    route: '/invoices',
    reference_doctype: 'Sales Invoice',
    role: 'Customer',
  },
  // /payments is not a valid ERPNext portal page — disabled to avoid 404.
  // Tenants view payment history through the invoice detail page (/invoices/<name>).
  {
    title: 'Payment History',
    enabled: 0,
    route: '/payments',
    reference_doctype: 'Payment Entry',
    role: 'Customer',
  },
  // Standard ERPNext Issues portal page is /issues (not /helpdesk).
  // /helpdesk resolves to the Frappe Helpdesk app if installed; /issues always works.
  {
    title: 'Maintenance Tickets',
    enabled: 1,
    route: '/issues',
    reference_doctype: 'Issue',
    role: 'Customer',
  },
  {
    title: 'My Addresses',
    enabled: 1,
    route: '/addresses',
    reference_doctype: 'Address',
    role: 'Customer',
  },
  {
    title: 'My Profile',
    enabled: 1,
    route: '/me',
    reference_doctype: '',
    role: '',
  },
];

async function configurePortalSettings() {
  console.log('\n── 1. Portal Settings ───────────────────────────────────────');
  // Fetch current settings so we preserve existing menu item name-keys (DB row IDs)
  // while updating routes/enabled flags.  We merge by title to avoid duplicates.
  const { data: current } = await http.get('/api/resource/Portal%20Settings/Portal%20Settings');
  const existingByTitle = Object.fromEntries(
    (current.data.menu || []).map(m => [m.title, m])
  );

  const mergedMenu = PORTAL_MENU_ITEMS.map(desired => ({
    ...(existingByTitle[desired.title] || {}),
    ...desired,
  }));

  await http.put('/api/resource/Portal%20Settings/Portal%20Settings', {
    hide_standard_pages: 0,
    logout_on_session_expiry: 0,
    menu: mergedMenu,
    custom_menu: [], // clear any stale custom entries (e.g. /leases, /payments)
  });
  console.log('  ✓ Portal pages configured: invoices (on), issues (on), addresses (on), profile (on)');
  console.log('  ✓ Payment History disabled (no /payments page in standard ERPNext)');
  console.log('  ✓ Custom menu cleared (removed /leases and duplicate /payments entries)');
}

// ── 2. Stripe Payment Gateway ─────────────────────────────────────────────────
// Stripe Settings is an ERPNext core doctype.  Saving it auto-creates a
// matching "Payment Gateway" record named after gateway_name.
// We then create a "Payment Gateway Account" to link the gateway to the correct
// GL receivables account so that Stripe payments are journaled automatically.

async function configureStripe() {
  console.log('\n── 2. Stripe Payment Gateway ────────────────────────────────');

  const pubKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
  const secKey = process.env.STRIPE_SECRET_KEY || '';

  if (!pubKey || !secKey) {
    console.log(
      '  ⚠  STRIPE_PUBLISHABLE_KEY / STRIPE_SECRET_KEY not set.\n' +
      '     Stripe Settings record will be created but payment collection\n' +
      '     will remain inactive until real keys are supplied.'
    );
  }

  // Stripe Settings — ERPNext core doctype (erpnext.accounts.doctype.stripe_settings)
  await upsert('Stripe Settings', 'Stripe', {
    gateway_name: 'Stripe',
    publishable_key: pubKey,
    secret_key: secKey,
  });

  // Payment Gateway Account — links the Stripe gateway to the AR GL account.
  // ERPNext names the auto-created Payment Gateway "Stripe-Stripe" (type-name).
  // The GL account name is instance-specific; override via STRIPE_PAYMENT_ACCOUNT.
  // Default "Debtors - LD" matches the Lutra (Demo) company used for tenant invoices.
  const paymentAccount =
    process.env.STRIPE_PAYMENT_ACCOUNT || 'Debtors - LD';

  try {
    await upsert('Payment Gateway Account', 'Stripe-Stripe - USD - LD', {
      payment_gateway: 'Stripe-Stripe',
      currency: 'USD',
      payment_account: paymentAccount,
      message: 'Pay your rent securely online with Stripe.',
    });
  } catch (e) {
    // GL account name differs per ERPNext instance.  Log the warning and
    // continue — the landlord can set the correct account via the UI.
    const detail = e.response?.data?.exception || e.message;
    console.warn(
      `  ⚠  Could not create Payment Gateway Account (GL account "${paymentAccount}" may not exist).\n` +
      `     Fix via ERPNext → Accounts → Payment Gateway Account, or set STRIPE_PAYMENT_ACCOUNT.\n` +
      `     Detail: ${detail}`
    );
  }

  console.log('  ✓ Stripe gateway configured');
}

// ── 3. Payment Request Permissions ───────────────────────────────────────────
// By default Payment Request is only accessible to Accounts User / Manager.
// Portal tenants (Customer role) need read access so the "Pay Now" page works.
// We use Custom DocPerm (Frappe's non-destructive permission override layer) so
// we don't touch core DocType definitions.  Standard admin roles are included
// to avoid accidentally locking them out when Custom DocPerm takes precedence.

const PAYMENT_REQUEST_CUSTOM_PERMS = [
  // Portal tenants: read only, scoped via User Permission (party = Customer)
  { role: 'Customer',         read: 1, write: 0, create: 0, submit: 0, cancel: 0, delete: 0, if_owner: 0 },
  // Standard back-office roles — must be re-declared once Custom DocPerm exists
  { role: 'Accounts User',    read: 1, write: 1, create: 1, submit: 0, cancel: 0, delete: 0, if_owner: 0 },
  { role: 'Accounts Manager', read: 1, write: 1, create: 1, submit: 1, cancel: 1, delete: 0, if_owner: 0 },
  { role: 'System Manager',   read: 1, write: 1, create: 1, submit: 1, cancel: 1, delete: 1, if_owner: 0 },
];

async function configurePaymentRequestPerms() {
  console.log('\n── 3. Payment Request Permissions ───────────────────────────');

  // Get existing Custom DocPerms for Payment Request
  const existing = await listDocs(
    'Custom DocPerm',
    [['parent', '=', 'Payment Request']],
    ['name', 'role']
  );
  const existingByRole = Object.fromEntries(existing.map(r => [r.role, r.name]));

  for (const perm of PAYMENT_REQUEST_CUSTOM_PERMS) {
    const payload = { parent: 'Payment Request', permlevel: 0, ...perm };
    if (existingByRole[perm.role]) {
      await http.put(
        `/api/resource/Custom%20DocPerm/${encodeURIComponent(existingByRole[perm.role])}`,
        payload
      );
      console.log(`  ↺ Updated  Custom DocPerm: Payment Request / ${perm.role}`);
    } else {
      await http.post('/api/resource/Custom%20DocPerm', payload);
      console.log(`  + Created  Custom DocPerm: Payment Request / ${perm.role}`);
    }
  }

  console.log('  ✓ Customer role can read Payment Request (Pay Now button no longer 403s)');
}

// ── 4. Sales Invoice Permissions ─────────────────────────────────────────────
// `make_payment_request` (the ERPNext API called by the portal "Pay" button)
// internally calls frappe.get_doc("Sales Invoice", dn) which requires
// permlevel=0 read permission.  By default, the Customer role has no permlevel=0
// entry — only the portal template uses ignore_permissions=True.
// We add Customer (pl=0, read-only) and re-declare all existing standard roles
// because Frappe replaces standard DocPerm entirely once any Custom DocPerm exists.

const SALES_INVOICE_CUSTOM_PERMS = [
  // permlevel 0 — document-level access
  { role: 'Customer',         permlevel: 0, read: 1, write: 0, create: 0, submit: 0, cancel: 0, delete: 0, if_owner: 0 },
  { role: 'Accounts User',    permlevel: 0, read: 1, write: 1, create: 1, submit: 0, cancel: 0, delete: 0, if_owner: 0 },
  { role: 'Accounts Manager', permlevel: 0, read: 1, write: 1, create: 1, submit: 1, cancel: 1, delete: 0, if_owner: 0 },
  // permlevel 1 — higher-level field access (keeps existing standard behaviour)
  { role: 'Accounts Manager', permlevel: 1, read: 1, write: 1, create: 0, submit: 0, cancel: 0, delete: 0, if_owner: 0 },
  { role: 'All',              permlevel: 1, read: 1, write: 0, create: 0, submit: 0, cancel: 0, delete: 0, if_owner: 0 },
];

async function configureSalesInvoicePerms() {
  console.log('\n── 4. Sales Invoice Permissions ─────────────────────────────');

  const existing = await listDocs(
    'Custom DocPerm',
    [['parent', '=', 'Sales Invoice']],
    ['name', 'role', 'permlevel']
  );
  // Key by "role|permlevel" so we handle the two Accounts Manager entries correctly
  const existingByKey = Object.fromEntries(
    existing.map(r => [`${r.role}|${r.permlevel}`, r.name])
  );

  for (const perm of SALES_INVOICE_CUSTOM_PERMS) {
    const key = `${perm.role}|${perm.permlevel}`;
    const payload = { parent: 'Sales Invoice', ...perm };
    if (existingByKey[key]) {
      await http.put(
        `/api/resource/Custom%20DocPerm/${encodeURIComponent(existingByKey[key])}`,
        payload
      );
      console.log(`  ↺ Updated  Custom DocPerm: Sales Invoice / ${perm.role} (pl=${perm.permlevel})`);
    } else {
      await http.post('/api/resource/Custom%20DocPerm', payload);
      console.log(`  + Created  Custom DocPerm: Sales Invoice / ${perm.role} (pl=${perm.permlevel})`);
    }
  }

  console.log('  ✓ Customer role can read Sales Invoice (make_payment_request no longer 403s)');
}

// ── 5. Tenant Portal Users ────────────────────────────────────────────────────
// Each tenant needs an ERPNext Website User account so they can log in to the
// portal.  We create / update a User record (user_type = "Website User") and
// link it back to the matching Customer via the portal_users child table.
// A User Permission (allow Customer = <their customer>) is also created so that
// ERPNext's record-level security automatically restricts the tenant's view of
// invoices, payment requests, and all other customer-linked doctypes to only
// their own records.

async function ensurePortalUser(tenant) {
  const email = tenant.email_id || tenant.email || '';
  const fullName = tenant.customer_name || tenant.name;
  const nameParts = fullName.split(' ');
  const firstName = nameParts[0] || fullName;
  const lastName  = nameParts.slice(1).join(' ') || '';

  if (!email) {
    console.log(`  ⚠  ${fullName}: no email address — skipping portal user`);
    return { skipped: true, reason: 'no_email' };
  }

  // Create or update the Website User record
  try {
    await upsert('User', email, {
      email,
      first_name: firstName,
      last_name: lastName,
      user_type: 'Website User',
      send_welcome_email: 0,
      roles: [{ role: 'Customer' }],
    });
  } catch (e) {
    const detail = e.response?.data?.exception || e.message;
    console.warn(`  ⚠  Could not create user ${email}: ${detail}`);
    return { skipped: true, reason: 'user_create_failed', detail };
  }

  // Link the portal user to the Customer record via portal_users child table
  try {
    const current = await getDoc('Customer', tenant.name);
    const existingUsers = (current?.portal_users || []).map(u => u.user);

    if (!existingUsers.includes(email)) {
      await http.put(`/api/resource/Customer/${encodeURIComponent(tenant.name)}`, {
        portal_users: [...(current?.portal_users || []), { user: email }],
      });
      console.log(`  ✓ Linked ${email} → Customer ${tenant.name}`);
    } else {
      console.log(`  = ${email} already linked to Customer ${tenant.name}`);
    }
  } catch (e) {
    const detail = e.response?.data?.exception || e.message;
    console.warn(`  ⚠  Could not link ${email} to Customer ${tenant.name}: ${detail}`);
    return { skipped: true, reason: 'link_failed', detail };
  }

  // Create User Permission: this is what ERPNext uses to scope ALL portal data
  // (invoices, payment requests, etc.) to only this tenant's records.
  try {
    const upList = await listDocs(
      'User Permission',
      [['user', '=', email], ['allow', '=', 'Customer'], ['for_value', '=', tenant.name]],
      ['name']
    );
    if (upList.length === 0) {
      await http.post('/api/resource/User%20Permission', {
        user: email,
        allow: 'Customer',
        for_value: tenant.name,
        apply_to_all_doctypes: 1,
        is_default: 1,
      });
      console.log(`  ✓ User Permission created: ${email} → Customer ${tenant.name}`);
    } else {
      console.log(`  = User Permission already exists for ${email}`);
    }
  } catch (e) {
    const detail = e.response?.data?.exception || e.message;
    console.warn(`  ⚠  Could not create User Permission for ${email}: ${detail}`);
  }

  return { skipped: false, linked: true };
}

async function configureTenantPortalUsers() {
  console.log('\n── 5. Tenant Portal Users ───────────────────────────────────');

  // Fetch all customers; filter to Tenant group client-side (Frappe v15 limitation)
  const customers = await listDocs('Customer', [], [
    'name', 'customer_name', 'customer_group', 'email_id',
  ]);
  const tenants = customers.filter(
    c => (c.customer_group || '').toLowerCase() === 'tenant'
  );

  console.log(`  Found ${tenants.length} tenant(s).`);
  if (tenants.length === 0) {
    console.log('  ⚠  No tenants found. Run scripts/seed-erpnext.js to create test data.');
    return;
  }

  const results = { created: 0, linked: 0, skipped: 0 };
  for (const tenant of tenants) {
    const r = await ensurePortalUser(tenant);
    if (r.skipped) {
      results.skipped++;
    } else {
      if (!r.alreadyLinked) results.linked++;
      results.created++;
    }
  }

  console.log(
    `\n  Portal users: ${results.created} processed, ` +
    `${results.linked} newly linked, ${results.skipped} skipped.`
  );
}

// ── 6. Portal Pay Button — ACH override Website Script ───────────────────────
// The standard ERPNext portal Pay button calls make_payment_request which
// redirects to /stripe_checkout — an embedded Stripe card-only form.
// This Website Script intercepts the button and instead routes through our
// Node.js /checkout endpoint, which creates a Stripe-hosted Checkout Session
// that offers both credit card AND ACH bank transfer.
//
// The script is kept DISABLED until WEBHOOK_BASE_URL is set to the deployed
// Node.js app URL (Railway, etc.).  Run setup-tenant-portal.js after deploying
// to enable it automatically.

async function configurePayButtonScript() {
  console.log('\n── 6. Portal Pay Button ACH Script ──────────────────────────');

  const webhookBase = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '');
  const isConfigured = webhookBase && webhookBase !== 'https://your-server.example.com';

  const scriptJs = `
// Intercept the portal "Pay" button to use Stripe Checkout with card + ACH support.
frappe.ready(function () {
  var path = window.location.pathname;
  var match = path.match(/\\/invoices\\/(ACC-SINV-[\\w-]+)/);
  if (!match) return;

  var invoiceName = match[1];
  var checkoutUrl = '${webhookBase || 'WEBHOOK_BASE_URL_NOT_SET'}/checkout?invoice_name=' + encodeURIComponent(invoiceName);

  function overridePayButtons() {
    document.querySelectorAll('a').forEach(function (a) {
      if (a.href && a.href.includes('make_payment_request')) {
        a.href = checkoutUrl;
        a.onclick = function (e) { e.preventDefault(); window.location.href = checkoutUrl; };
      }
    });
    document.querySelectorAll('[onclick*="make_payment_request"]').forEach(function (el) {
      el.removeAttribute('onclick');
      el.onclick = function (e) { e.preventDefault(); window.location.href = checkoutUrl; };
    });
  }

  overridePayButtons();
  setTimeout(overridePayButtons, 500);
  setTimeout(overridePayButtons, 1500);
});
`.trim();

  const scriptName = 'PM - Portal Invoice Pay ACH Override';
  const existing = await getDoc('Website Script', scriptName);

  if (existing) {
    await http.put(
      `/api/resource/Website%20Script/${encodeURIComponent(scriptName)}`,
      { script: scriptJs, enabled: isConfigured ? 1 : 0 }
    );
    console.log(`  ↺ Updated  Website Script: ${scriptName} (enabled=${isConfigured})`);
  } else {
    await http.post('/api/resource/Website%20Script', {
      name: scriptName,
      script: scriptJs,
      enabled: isConfigured ? 1 : 0,
    });
    console.log(`  + Created  Website Script: ${scriptName} (enabled=${isConfigured})`);
  }

  if (!isConfigured) {
    console.log('  ⚠  WEBHOOK_BASE_URL not set to a real URL.');
    console.log('     Set it to your deployed Railway app URL and re-run to enable ACH payments.');
  } else {
    console.log(`  ✓ ACH pay button active → ${webhookBase}/checkout`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nSetting up tenant portal on ${BASE}`);

  try {
    await configurePortalSettings();
  } catch (e) {
    const detail = e.response?.data?.exception || e.message;
    console.error(`  ✗ Portal Settings failed: ${detail}`);
  }

  try {
    await configureStripe();
  } catch (e) {
    const detail = e.response?.data?.exception || e.message;
    console.error(`  ✗ Stripe setup failed: ${detail}`);
  }

  try {
    await configurePaymentRequestPerms();
  } catch (e) {
    const detail = e.response?.data?.exception || e.message;
    console.error(`  ✗ Payment Request permissions failed: ${detail}`);
  }

  try {
    await configureSalesInvoicePerms();
  } catch (e) {
    const detail = e.response?.data?.exception || e.message;
    console.error(`  ✗ Sales Invoice permissions failed: ${detail}`);
  }

  try {
    await configureTenantPortalUsers();
  } catch (e) {
    const detail = e.response?.data?.exception || e.message;
    console.error(`  ✗ Portal user setup failed: ${detail}`);
  }

  try {
    await configurePayButtonScript();
  } catch (e) {
    const detail = e.response?.data?.exception || e.message;
    console.error(`  ✗ Pay button ACH script failed: ${detail}`);
  }

  const webhookBase = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '');
  const achReady = webhookBase && webhookBase !== 'https://your-server.example.com';

  console.log('\n✓ Tenant portal setup complete.\n');
  console.log('Next steps:');
  console.log(`  1. Tenants log in at:             ${BASE}/login`);
  console.log(`  2. Rent invoices + payment links: ${BASE}/invoices`);
  console.log(`  3. Maintenance tickets:           ${BASE}/issues`);
  if (!achReady) {
    console.log('  4. Set WEBHOOK_BASE_URL to your Railway app URL and re-run to enable ACH');
    console.log('     bank transfer on the portal Pay button.\n');
  } else {
    console.log(`  4. ACH bank transfer enabled via ${webhookBase}/checkout\n`);
  }
}

// Export helpers for unit testing
module.exports = { getDoc, upsert, listDocs, ensurePortalUser, PORTAL_MENU_ITEMS, PAYMENT_REQUEST_CUSTOM_PERMS, SALES_INVOICE_CUSTOM_PERMS };

// Only run when invoked directly (not when required by tests)
if (require.main === module) {
  main().catch(console.error);
}
