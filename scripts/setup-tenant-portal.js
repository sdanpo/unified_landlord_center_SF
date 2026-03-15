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
    route: '/my-invoices',
    reference_doctype: 'Sales Invoice',
    role: 'Customer',
  },
  {
    title: 'Paid Invoices',
    enabled: 1,
    route: '/paid-invoices',
    reference_doctype: 'Sales Invoice',
    role: 'Customer',
  },
  // /payments does NOT exist as a portal page in ERPNext v15 — omitted to avoid 404.
  // Frappe Helpdesk app is installed; /helpdesk is the correct route for tickets.
  {
    title: 'Maintenance Tickets',
    enabled: 1,
    route: '/helpdesk',
    reference_doctype: 'HD Ticket',
    role: 'Customer',
  },
  {
    title: 'My Addresses',
    enabled: 1,
    route: '/addresses',
    reference_doctype: 'Address',
    role: 'Customer',
  },
  // "My Profile" omitted — Frappe's built-in "My Account" (/me) is already shown
  // in the standard portal header; a second entry would be a duplicate.
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
    custom_menu: [], // clear any stale custom entries (e.g. /leases, old /payments)
  });
  console.log('  ✓ Portal pages: invoices, paid-invoices, helpdesk, addresses');

  // Set the Customer role home page so tenants land on /invoices after login,
  // not on /helpdesk (which the Helpdesk app sets as the Customer role default).
  try {
    await http.put('/api/resource/Role/Customer', { home_page: '/invoices' });
    console.log('  ✓ Customer role home page → /invoices (fixes Helpdesk default landing)');
  } catch (e) {
    console.warn('  ⚠  Could not set Customer role home page:', e.response?.data?.exception || e.message);
  }
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
  // Portal tenants: read + submit so make_payment_request can call pr.submit().
  // User Permission (party = Customer) scopes access to only their own records.
  { role: 'Customer',         read: 1, write: 0, create: 0, submit: 1, cancel: 0, delete: 0, if_owner: 0 },
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
  let alreadyLinked = false;
  try {
    const current = await getDoc('Customer', tenant.name);
    const existingUsers = (current?.portal_users || []).map(u => u.user);
    alreadyLinked = existingUsers.includes(email);

    if (!alreadyLinked) {
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

  return { skipped: false, alreadyLinked, linked: true };
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

// ── 6a. My Invoices Web Page at /my-invoices ──────────────────────────────────
// Shows only unpaid (outstanding_amount > 0) invoices for the logged-in tenant.
// Uses fetch() directly to /api/resource/Sales Invoice — no frappe.call dependency.

async function configureMyInvoicesPage() {
  console.log('\n── 6a. My Invoices Web Page (/my-invoices) ───────────────────');

  const pageBody = [
    '<div id="inv-due-wrap"><p class="text-muted">Loading invoices&hellip;</p></div>',
    '<script>',
    '(function () {',
    '  var wrap = document.getElementById("inv-due-wrap");',
    '  var params = new URLSearchParams({',
    '    filters: JSON.stringify([["docstatus","=",1],["outstanding_amount",">",0]]),',
    '    fields:  JSON.stringify(["name","posting_date","grand_total","due_date","outstanding_amount"]),',
    '    limit_page_length: "100",',
    '    order_by: "due_date asc"',
    '  });',
    '  fetch("/api/resource/Sales%20Invoice?" + params.toString(), {',
    '    credentials: "include",',
    '    headers: { "Accept": "application/json" }',
    '  })',
    '  .then(function (res) { return res.json(); })',
    '  .then(function (data) {',
    '    var invoices = data.data || [];',
    '    if (!invoices.length) {',
    '      wrap.innerHTML = \'<p class="text-muted mt-3">No outstanding invoices \u2014 you\\\'re all caught up!</p>\';',
    '      return;',
    '    }',
    '    var today = new Date(); today.setHours(0,0,0,0);',
    '    var rows = invoices.map(function (inv) {',
    '      var due = new Date(inv.due_date);',
    '      var overdue = due < today;',
    '      var dueLabel = due.toLocaleDateString("en-US", { year:"numeric", month:"short", day:"numeric" });',
    '      var statusHtml = overdue',
    '        ? \'<span class="indicator-pill red">Overdue</span>\'',
    '        : \'<span class="indicator-pill orange">Due \' + dueLabel + \'</span>\';',
    '      return \'<div class="list-group-item">\'',
    '        + \'<div class="row align-items-center">\'',
    '        + \'<div class="col-sm-3"><a href="/invoices/\' + encodeURIComponent(inv.name) + \'">\' + inv.name + \'</a></div>\'',
    '        + \'<div class="col-sm-2 text-muted">\' + dueLabel + \'</div>\'',
    '        + \'<div class="col-sm-2">\' + statusHtml + \'</div>\'',
    '        + \'<div class="col-sm-2 text-muted">Monthly Rent</div>\'',
    '        + \'<div class="col-sm-3 text-right"><strong>$\' + parseFloat(inv.outstanding_amount).toFixed(2) + \'</strong></div>\'',
    '        + \'</div></div>\';',
    '    }).join("");',
    '    wrap.innerHTML = \'<div class="list-group">\' + rows + \'</div>\';',
    '  })',
    '  .catch(function () {',
    '    wrap.innerHTML = \'<p class="text-danger mt-3">Could not load invoices. Please log in and try again.</p>\';',
    '  });',
    '})();',
    '<\/script>',
  ].join('\n');

  await upsert('Web Page', 'invoices-due', {
    title: 'Invoices Due',
    route: 'my-invoices',
    published: 1,
    content_type: 'HTML',
    main_section_html: pageBody,
    show_sidebar: 1,
    full_width: 1,
  });

  console.log(`  ✓ Web Page ready: /my-invoices`);
}

// ── 6b. Paid Invoices Web Page at /paid-invoices ──────────────────────────────
// Creates (or updates) a custom ERPNext Web Page that lists only paid invoices
// (outstanding_amount = 0, docstatus = 1) for the logged-in tenant.
// The page uses client-side frappe.call so ERPNext's User Permission system
// automatically scopes results to the authenticated customer — no extra filtering
// needed on our side.
//
// Also cleans up the old head_html patch from the previous implementation that
// showed all invoices on /invoices (now reverted in favour of separate pages).

const ALL_INV_MARKER = '<!-- PM-ALL-INVOICES -->';

async function configurePaidInvoicesPage() {
  console.log('\n── 6a. Paid Invoices Web Page (/paid-invoices) ───────────────');

  // ── Remove the old "show-all-invoices" head_html patch if present ──────────
  const { data: wsData } = await http.get('/api/resource/Website%20Settings/Website%20Settings');
  const existingHead = wsData.data.head_html || '';
  const cleanedHead = existingHead
    .replace(new RegExp(`\\s*${ALL_INV_MARKER}[\\s\\S]*?${ALL_INV_MARKER}`, 'g'), '')
    .trim();
  if (cleanedHead !== existingHead) {
    await http.put('/api/resource/Website%20Settings/Website%20Settings', {
      head_html: cleanedHead,
    });
    console.log('  ↺ Removed old show-all-invoices head_html patch');
  }

  // ── Create / update the Web Page ──────────────────────────────────────────
  // The page body: a Bootstrap list rendered by frappe.call on the client side.
  // ERPNext User Permission (allow Customer = <tenant>) ensures each tenant only
  // sees their own invoices — no server-side changes required.
  // The page body renders paid invoices with a Stripe receipt link when available.
  //
  // Flow (3 lightweight frappe.call requests):
  //  1. Sales Invoice  – all paid invoices for this tenant (outstanding_amount=0)
  //  2. Payment Entry Reference (child table) – maps each invoice → Payment Entry name
  //  3. Payment Entry  – fetches reference_no (Stripe PaymentIntent ID, "pi_xxx…")
  //
  // ERPNext User Permission (allow Customer = <tenant>) automatically scopes
  // every call to the logged-in tenant — no server-side changes required.
  const pageBody = [
    '<div id="paid-inv-wrap"><p class="text-muted">Loading paid invoices&hellip;</p></div>',
    '<script>',
    '(function () {',
    '  var wrap = document.getElementById("paid-inv-wrap");',
    '  var params = new URLSearchParams({',
    '    filters: JSON.stringify([["docstatus","=",1],["outstanding_amount","=",0]]),',
    '    fields:  JSON.stringify(["name","posting_date","grand_total"]),',
    '    limit_page_length: "100",',
    '    order_by: "posting_date desc"',
    '  });',
    '  fetch("/api/resource/Sales%20Invoice?" + params.toString(), {',
    '    credentials: "include",',
    '    headers: { "Accept": "application/json" }',
    '  })',
    '  .then(function (res) { return res.json(); })',
    '  .then(function (data) {',
    '    var invoices = data.data || [];',
    '    if (!invoices.length) {',
    '      wrap.innerHTML = \'<p class="text-muted mt-3">No paid invoices yet.</p>\';',
    '      return;',
    '    }',
    '    var rows = invoices.map(function (inv) {',
    '      var d = new Date(inv.posting_date);',
    '      var label = d.toLocaleDateString("en-US", { year:"numeric", month:"short", day:"numeric" });',
    '      return \'<div class="list-group-item">\'',
    '        + \'<div class="row align-items-center">\'',
    '        + \'<div class="col-sm-3"><a href="/invoices/\' + encodeURIComponent(inv.name) + \'">\' + inv.name + \'</a></div>\'',
    '        + \'<div class="col-sm-2 text-muted">\' + label + \'</div>\'',
    '        + \'<div class="col-sm-2"><span class="indicator-pill green">Paid</span></div>\'',
    '        + \'<div class="col-sm-2 text-muted">Monthly Rent</div>\'',
    '        + \'<div class="col-sm-3 text-right"><strong>$\' + parseFloat(inv.grand_total).toFixed(2) + \'</strong></div>\'',
    '        + \'</div></div>\';',
    '    }).join("");',
    '    wrap.innerHTML = \'<div class="list-group">\' + rows + \'</div>\';',
    '  })',
    '  .catch(function () {',
    '    wrap.innerHTML = \'<p class="text-danger mt-3">Could not load invoices. Please log in and try again.</p>\';',
    '  });',
    '})();',
    '<\/script>',
  ].join('\n');

  await upsert('Web Page', 'paid-invoices', {
    title: 'Paid Invoices',
    route: 'paid-invoices',
    published: 1,
    content_type: 'HTML',
    main_section_html: pageBody,
    show_sidebar: 1,
  });

  console.log(`  ✓ Web Page ready: ${BASE}/paid-invoices`);
}

// ── 6. Portal Pay Button — ACH override via Website Settings.head_html ───────
// The standard ERPNext portal Pay button calls make_payment_request which
// redirects to /stripe_checkout — an embedded Stripe card-only form.
// We inject a <script> tag into Website Settings.head_html to intercept the
// button and route through our Node.js /checkout endpoint instead, which
// creates a Stripe-hosted Checkout Session offering both card AND ACH.
//
// Website Settings.head_html is supported in all Frappe/ERPNext versions and
// does not require the Website Script doctype (which is absent in some installs).
//
// The injection is skipped (head_html cleared of our block) when WEBHOOK_BASE_URL
// is not set.  Re-run after deploying to Railway to activate ACH.

const ACH_SCRIPT_MARKER = '<!-- PM-ACH-PAY-OVERRIDE -->';

async function configurePayButtonScript() {
  console.log('\n── 6. Portal Pay Button ACH Override (head_html) ────────────');

  const webhookBase = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '');
  const isConfigured = webhookBase && webhookBase !== 'https://your-server.example.com';

  // Fetch current Website Settings to preserve other head_html content
  const { data: wsData } = await http.get('/api/resource/Website%20Settings/Website%20Settings');
  const ws = wsData.data;
  const existingHead = ws.head_html || '';

  // Strip any previous version of our block
  const stripped = existingHead
    .replace(new RegExp(`\\s*${ACH_SCRIPT_MARKER}[\\s\\S]*?${ACH_SCRIPT_MARKER}`, 'g'), '')
    .trim();

  if (!isConfigured) {
    // Remove our script block if webhook URL is not configured
    await http.put('/api/resource/Website%20Settings/Website%20Settings', {
      head_html: stripped || '',
    });
    console.log('  ↺ Removed ACH pay button script (WEBHOOK_BASE_URL not configured)');
    console.log('  ⚠  Set WEBHOOK_BASE_URL to your Railway app URL and re-run to enable ACH.');
    return;
  }

  const scriptBlock = `
${ACH_SCRIPT_MARKER}
<script>
/* Replace the portal Pay button with two options: ACH (free) and Card (+3%) */
(function () {
  var BASE = '${webhookBase}';
  var SURCHARGE_PCT = parseInt('${process.env.CARD_SURCHARGE_PCT || '3'}', 10);

  function init() {
    var path = window.location.pathname;
    var match = path.match(/\\/invoices\\/(ACC-SINV-[\\w-]+)/);
    if (!match) return;
    var inv = match[1];

    function patch() {
      var targets = [];
      document.querySelectorAll('a').forEach(function (a) {
        if (a.href && a.href.indexOf('make_payment_request') !== -1) targets.push(a);
      });
      document.querySelectorAll('[onclick*="make_payment_request"]').forEach(function (el) {
        targets.push(el);
      });

      targets.forEach(function (el) {
        if (el.dataset.pmReplaced) return;
        el.dataset.pmReplaced = '1';

        var achUrl  = BASE + '/checkout?invoice_name=' + encodeURIComponent(inv) + '&method=ach';
        var cardUrl = BASE + '/checkout?invoice_name=' + encodeURIComponent(inv) + '&method=card';

        var wrap = document.createElement('span');
        wrap.style.cssText = 'display:inline-flex;gap:8px;';

        var btnAch = document.createElement('a');
        btnAch.href = achUrl;
        btnAch.className = el.className || 'btn btn-primary btn-sm';
        btnAch.style.cssText = 'white-space:nowrap;';
        btnAch.textContent = 'Pay by Bank (ACH)';

        var btnCard = document.createElement('a');
        btnCard.href = cardUrl;
        btnCard.className = (el.className || 'btn btn-default btn-sm').replace('btn-primary','btn-default');
        btnCard.style.cssText = 'white-space:nowrap;';
        btnCard.textContent = 'Pay by Card (+' + SURCHARGE_PCT + '%)';

        wrap.appendChild(btnAch);
        wrap.appendChild(btnCard);
        el.replaceWith(wrap);
      });
    }

    patch();
    setTimeout(patch, 500);
    setTimeout(patch, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

/* Add Payment History link to portal sidebar */
(function () {
  var BASE = '${webhookBase}';
  function addHistoryLink() {
    if (document.querySelector('[data-pm-hist]')) return;
    var email = (typeof frappe !== 'undefined' && frappe.session && frappe.session.user !== 'Guest')
      ? frappe.session.user : null;
    if (!email) return;
    var sidebar = document.querySelector('.portal-sidebar .list-group');
    if (!sidebar) return;
    var a = document.createElement('a');
    a.href = BASE + '/payment-history?email=' + encodeURIComponent(email);
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'list-group-item list-group-item-action';
    a.setAttribute('data-pm-hist', '1');
    a.textContent = 'Payment History';
    sidebar.appendChild(a);
  }
  var t = setInterval(function () {
    addHistoryLink();
    if (document.querySelector('[data-pm-hist]')) clearInterval(t);
  }, 400);
  setTimeout(function () { clearInterval(t); }, 8000);
})();
</script>
${ACH_SCRIPT_MARKER}`.trimStart();

  const newHead = stripped ? stripped + '\n' + scriptBlock : scriptBlock;
  await http.put('/api/resource/Website%20Settings/Website%20Settings', {
    head_html: newHead,
  });
  console.log('  ✓ ACH pay button script injected into Website Settings.head_html');
  console.log(`  ✓ Pay button routes to:        ${webhookBase}/checkout`);
  console.log(`  ✓ Payment history sidebar link: ${webhookBase}/payment-history`);
}

// ── 0. Cancel blocking Payment Requests ───────────────────────────────────────
// When a "Requested" Payment Request exists for an invoice, make_payment_request
// throws a 417 error ("Cannot cancel a submitted Payment Request") and the portal
// renders it as a 403/404.  This step cancels any stale Requested PRQs so tenants
// can pay their invoices.

async function cancelBlockingPaymentRequests() {
  console.log('\n── 0. Cancel Stale "Requested" Payment Requests ─────────────');

  const prqs = await listDocs(
    'Payment Request',
    [['status', '=', 'Requested']],
    ['name', 'status', 'party', 'grand_total']
  );

  if (prqs.length === 0) {
    console.log('  ✓ No stale Payment Requests found — all clear.');
    return;
  }

  console.log(`  Found ${prqs.length} stale "Requested" Payment Request(s).`);
  for (const prq of prqs) {
    try {
      await http.put(
        `/api/resource/Payment%20Request/${encodeURIComponent(prq.name)}`,
        { docstatus: 2 }
      );
      console.log(`  ✓ Cancelled ${prq.name} (${prq.party} — $${prq.grand_total})`);
    } catch (e) {
      const detail = e.response?.data?.exception || e.message;
      console.warn(`  ⚠  Could not cancel ${prq.name}: ${detail}`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nSetting up tenant portal on ${BASE}`);

  try {
    await cancelBlockingPaymentRequests();
  } catch (e) {
    const detail = e.response?.data?.exception || e.message;
    console.error(`  ✗ Cancel blocking PRQs failed: ${detail}`);
  }

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
    await configureMyInvoicesPage();
  } catch (e) {
    const detail = e.response?.data?.exception || e.message;
    console.warn('  ⚠  configureMyInvoicesPage error (non-fatal):', detail);
  }

  try {
    await configurePaidInvoicesPage();
  } catch (e) {
    const detail = e.response?.data?.exception || e.message;
    console.error(`  ✗ Paid Invoices page failed: ${detail}`);
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
  console.log(`  2. Outstanding invoices:          ${BASE}/invoices`);
  console.log(`  3. Paid invoices:                 ${BASE}/paid-invoices`);
  console.log(`  4. Maintenance tickets:           ${BASE}/helpdesk`);
  if (!achReady) {
    console.log('  5. Set WEBHOOK_BASE_URL to your Railway app URL and re-run to enable ACH');
    console.log('     bank transfer on the portal Pay button.\n');
  } else {
    console.log(`  5. ACH bank transfer enabled via ${webhookBase}/checkout\n`);
  }
}

// Export helpers for unit testing
module.exports = { getDoc, upsert, listDocs, ensurePortalUser, PORTAL_MENU_ITEMS, PAYMENT_REQUEST_CUSTOM_PERMS, SALES_INVOICE_CUSTOM_PERMS, ACH_SCRIPT_MARKER, ALL_INV_MARKER, configureMyInvoicesPage, configurePaidInvoicesPage };

// Only run when invoked directly (not when required by tests)
if (require.main === module) {
  main().catch(console.error);
}
