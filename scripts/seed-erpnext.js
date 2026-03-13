#!/usr/bin/env node
'use strict';

/**
 * seed-erpnext.js
 * ───────────────
 * Populates the live ERPNext / PropMS instance with realistic dummy data for
 * end-to-end testing.  Safe to run multiple times – each run checks for
 * existing records before creating new ones (idempotent by name).
 *
 * Data created
 * ────────────
 *  • 2 additional Property records   (3 total incl. existing one)
 *  • 4 Customer records              (customer_group = "Tenant")
 *  • 3 Lease records                 (2 Active, 1 Closed)
 *  • 3 Sales Invoice records         (2 overdue, 1 current – all submitted)
 *  • 1 Payment Entry                 (submitted)
 *  • 3 HD Ticket records             (2 Open, 1 Resolved)
 *
 * Usage:  node scripts/seed-erpnext.js
 */

require('dotenv').config();
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const BASE   = (process.env.ERPNEXT_BASE_URL || '').replace(/\/$/, '');
const KEY    = process.env.ERPNEXT_API_KEY;
const SECRET = process.env.ERPNEXT_API_SECRET;
const COMPANY = 'Lutra (Demo)';
const ABBR    = 'LD';

if (!BASE || !KEY || !SECRET) {
  console.error('Missing ERPNEXT_BASE_URL / ERPNEXT_API_KEY / ERPNEXT_API_SECRET in .env');
  process.exit(1);
}

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

const http = axios.create({
  baseURL: BASE,
  headers: {
    Authorization: `token ${KEY}:${SECRET}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  timeout: 20_000,
  httpsAgent,
  proxy: false,
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function enc(s) { return encodeURIComponent(s); }

async function exists(doctype, name) {
  try {
    await http.get(`/api/resource/${enc(doctype)}/${enc(name)}`);
    return true;
  } catch (e) {
    if (e.response?.status === 404) return false;
    throw e;
  }
}

async function listNames(doctype, filters = []) {
  const r = await http.get(`/api/resource/${enc(doctype)}`, {
    params: {
      fields: JSON.stringify(['name']),
      filters: JSON.stringify(filters),
      limit_page_length: 200,
    },
  });
  return (r.data.data || []).map(x => x.name);
}

async function create(doctype, payload, label) {
  try {
    const r = await http.post(`/api/resource/${enc(doctype)}`, payload);
    console.log(`  ✓ Created ${label || doctype}: ${r.data.data.name}`);
    return r.data.data;
  } catch (e) {
    const msg = e.response?.data?.exception || e.message;
    console.error(`  ✗ Failed to create ${label || doctype}: ${msg}`);
    return null;
  }
}

async function submit(doctype, name) {
  try {
    const r = await http.put(`/api/resource/${enc(doctype)}/${enc(name)}`, { docstatus: 1 });
    console.log(`  ✓ Submitted ${doctype}: ${name}`);
    return r.data.data;
  } catch (e) {
    const msg = e.response?.data?.exception || e.message;
    console.error(`  ✗ Failed to submit ${doctype} ${name}: ${msg}`);
    return null;
  }
}

async function upsert(doctype, nameField, value, payload, label) {
  const names = await listNames(doctype, [[nameField, '=', value]]);
  if (names.length > 0) {
    console.log(`  – Already exists ${label || doctype}: ${names[0]}`);
    return { name: names[0], _existed: true };
  }
  return create(doctype, payload, label);
}

// ─── seed data ────────────────────────────────────────────────────────────────

const PROPERTIES = [
  {
    name1: '512 Maple Street, Unit 1A – SF',
    status: 'On Lease',
    rent: 2800,
    bedroom: 2,
    company: COMPANY,
    cost_center: `Main - ${ABBR}`,
    facing: 'South',
    no_of_parking: 1,
  },
  {
    name1: '512 Maple Street, Unit 2B – SF',
    status: 'Available',
    rent: 3200,
    bedroom: 3,
    company: COMPANY,
    cost_center: `Main - ${ABBR}`,
    facing: 'East',
    no_of_parking: 2,
  },
  {
    name1: '88 Ocean Avenue, Unit 5C – SF',
    status: 'On Lease',
    rent: 4500,
    bedroom: 4,
    company: COMPANY,
    cost_center: `Main - ${ABBR}`,
    facing: 'West',
    no_of_parking: 2,
  },
];

const TENANTS = [
  {
    key: 'Maria Garcia – Tenant',
    customer_name: 'Maria Garcia',
    customer_group: 'Tenant',
    customer_type: 'Individual',
    mobile_no: '+14155551001',
    email_id: 'maria.garcia.tenant@example.com',
  },
  {
    key: 'James Wilson – Tenant',
    customer_name: 'James Wilson',
    customer_group: 'Tenant',
    customer_type: 'Individual',
    mobile_no: '+14155551002',
    email_id: 'james.wilson.tenant@example.com',
  },
  {
    key: 'Priya Patel – Tenant',
    customer_name: 'Priya Patel',
    customer_group: 'Tenant',
    customer_type: 'Individual',
    mobile_no: '+14155551003',
    email_id: 'priya.patel.tenant@example.com',
  },
  {
    key: 'Chen Wei – Tenant',
    customer_name: 'Chen Wei',
    customer_group: 'Tenant',
    customer_type: 'Individual',
    mobile_no: '+14155551004',
    email_id: 'chen.wei.tenant@example.com',
  },
];

// ─── main ─────────────────────────────────────────────────────────────────────

async function seed() {
  console.log(`\n🌱 Seeding ERPNext at ${BASE}\n`);

  // ── 1. Properties ──────────────────────────────────────────────────────────
  console.log('── Properties ──');
  const propNames = [];
  for (const p of PROPERTIES) {
    const rec = await upsert('Property', 'name1', p.name1, p, `Property "${p.name1}"`);
    if (rec) propNames.push(rec.name);
  }
  // Include the existing property
  const existingProps = await listNames('Property');
  const allPropNames = [...new Set([...existingProps, ...propNames])];
  console.log(`  Total properties: ${allPropNames.length}`);

  // ── 2. Tenants ─────────────────────────────────────────────────────────────
  console.log('\n── Tenants ──');
  const tenantMap = {}; // customer_name → ERPNext name
  for (const t of TENANTS) {
    const rec = await upsert('Customer', 'customer_name', t.customer_name, {
      customer_name: t.customer_name,
      customer_group: t.customer_group,
      customer_type: t.customer_type,
      mobile_no: t.mobile_no,
      email_id: t.email_id,
    }, `Tenant "${t.customer_name}"`);
    if (rec) tenantMap[t.customer_name] = rec.name;
  }

  // ── 3. Leases ──────────────────────────────────────────────────────────────
  console.log('\n── Leases ──');
  const prop1 = allPropNames.find(n => n.includes('512 Maple') && n.includes('1A'))
    || allPropNames[0];
  const prop2 = allPropNames.find(n => n.includes('88 Ocean'))
    || allPropNames[1] || allPropNames[0];
  const prop3 = allPropNames.find(n => n.includes('229 Watson'))
    || allPropNames[2] || allPropNames[0];

  const tenant1 = tenantMap['Maria Garcia'] || Object.values(tenantMap)[0];
  const tenant2 = tenantMap['James Wilson'] || Object.values(tenantMap)[1];
  const tenant3 = tenantMap['Priya Patel'] || Object.values(tenantMap)[2];

  const leaseDefs = [
    {
      label: 'Active lease – Maria Garcia @ Maple 1A',
      property: prop1,
      customer: tenant1,
      lease_customer: tenant1,
      lease_status: 'Active',
      start_date: '2025-07-01',
      end_date: '2026-06-30',
      frequency: 'Monthly',
      notice_period: 30,
      security_deposit: 2800,
      lease_item: [{
        frequency: 'Monthly',
        amount: 2800,
        document_type: 'Sales Invoice',
        is_active: 1,
        invoice_item_group: '1',
      }],
    },
    {
      label: 'Active lease – James Wilson @ Ocean 5C',
      property: prop2,
      customer: tenant2,
      lease_customer: tenant2,
      lease_status: 'Active',
      start_date: '2025-10-01',
      end_date: '2026-09-30',
      frequency: 'Monthly',
      notice_period: 30,
      security_deposit: 4500,
      lease_item: [{
        frequency: 'Monthly',
        amount: 4500,
        document_type: 'Sales Invoice',
        is_active: 1,
        invoice_item_group: '1',
      }],
    },
    {
      label: 'Closed lease – Priya Patel @ Watson (expired)',
      property: prop3,
      customer: tenant3,
      lease_customer: tenant3,
      lease_status: 'Closed',
      start_date: '2024-01-01',
      end_date: '2024-12-31',
      frequency: 'Monthly',
      notice_period: 30,
      security_deposit: 1450,
      lease_item: [{
        frequency: 'Monthly',
        amount: 1450,
        document_type: 'Sales Invoice',
        is_active: 0,
        invoice_item_group: '1',
      }],
    },
  ];

  const leaseNames = [];
  for (const ld of leaseDefs) {
    const { label, ...payload } = ld;
    // Check by property+customer combo
    const existing = await listNames('Lease', [
      ['property', '=', payload.property],
      ['lease_customer', '=', payload.lease_customer],
    ]);
    if (existing.length > 0) {
      console.log(`  – Already exists Lease: ${existing[0]} (${label})`);
      leaseNames.push(existing[0]);
    } else {
      const rec = await create('Lease', payload, `Lease "${label}"`);
      if (rec) leaseNames.push(rec.name);
    }
  }

  // ── 4. Sales Invoices ──────────────────────────────────────────────────────
  console.log('\n── Sales Invoices ──');

  // Check if rent item exists, create if not
  let rentItemName = 'RENT-001';
  const rentItemNames = await listNames('Item', [['item_name', '=', 'Monthly Rent']]);
  if (rentItemNames.length > 0) {
    rentItemName = rentItemNames[0];
    console.log(`  – Rent item already exists: ${rentItemName}`);
  } else {
    const rentItem = await create('Item', {
      item_code: 'RENT-001',
      item_name: 'Monthly Rent',
      item_group: 'Services',
      is_sales_item: 1,
      is_stock_item: 0,
      include_item_in_manufacturing: 0,
      description: 'Monthly rental charge',
    }, 'Item "Monthly Rent"');
    if (rentItem) rentItemName = rentItem.name;
  }

  const invoiceDefs = [
    {
      label: 'Overdue invoice – Maria Garcia (45 days overdue)',
      customer: tenant1,
      posting_date: '2026-01-15',
      due_date: '2026-01-31',
      custom_property: prop1,
      custom_lease: leaseNames[0] || null,
      amount: 2800,
    },
    {
      label: 'Overdue invoice – James Wilson (15 days overdue)',
      customer: tenant2,
      posting_date: '2026-02-15',
      due_date: '2026-02-26',
      custom_property: prop2,
      custom_lease: leaseNames[1] || null,
      amount: 4500,
    },
    {
      label: 'Current invoice – Maria Garcia (due in 10 days)',
      customer: tenant1,
      posting_date: '2026-03-01',
      due_date: '2026-03-23',
      custom_property: prop1,
      custom_lease: leaseNames[0] || null,
      amount: 2800,
    },
  ];

  const invoiceNames = [];
  for (const inv of invoiceDefs) {
    // Check by customer + posting_date combo to avoid dupes
    const existing = await listNames('Sales Invoice', [
      ['customer', '=', inv.customer],
      ['posting_date', '=', inv.posting_date],
      ['docstatus', 'in', [0, 1]],
    ]);
    if (existing.length > 0) {
      console.log(`  – Already exists Sales Invoice: ${existing[0]} (${inv.label})`);
      invoiceNames.push(existing[0]);
      continue;
    }

    const rec = await create('Sales Invoice', {
      customer: inv.customer,
      company: COMPANY,
      posting_date: inv.posting_date,
      due_date: inv.due_date,
      set_posting_time: 1,
      update_stock: 0,
      debit_to: `Debtors - ${ABBR}`,
      custom_property: inv.custom_property,
      custom_lease: inv.custom_lease,
      items: [{
        item_code: rentItemName,
        qty: 1,
        rate: inv.amount,
        income_account: `Sales - ${ABBR}`,
      }],
    }, `Sales Invoice "${inv.label}"`);

    if (rec) {
      invoiceNames.push(rec.name);
      // Submit the invoice so outstanding_amount is tracked
      await submit('Sales Invoice', rec.name);
    }
  }

  // ── 5. Payment Entry ──────────────────────────────────────────────────────
  console.log('\n── Payment Entry ──');

  // Pay the current (March) invoice for Maria
  if (invoiceNames[2]) {
    const existingPE = await listNames('Payment Entry', [
      ['party', '=', tenant1],
      ['posting_date', '=', '2026-03-10'],
    ]);
    if (existingPE.length > 0) {
      console.log(`  – Already exists Payment Entry: ${existingPE[0]}`);
    } else {
      // Get the submitted invoice to get grand_total for the payment
      let invoiceDoc = null;
      try {
        const r = await http.get(`/api/resource/Sales%20Invoice/${enc(invoiceNames[2])}`);
        invoiceDoc = r.data.data;
      } catch (_) {}

      if (invoiceDoc && invoiceDoc.docstatus === 1) {
        // Get bank account
        const bankAccounts = await listNames('Account', [
          ['company', '=', COMPANY],
          ['account_type', '=', 'Bank'],
          ['is_group', '=', 0],
        ]);
        const bankAccount = bankAccounts[0] || `Cash - ${ABBR}`;

        const peRec = await create('Payment Entry', {
          payment_type: 'Receive',
          party_type: 'Customer',
          party: tenant1,
          posting_date: '2026-03-10',
          company: COMPANY,
          paid_from: `Debtors - ${ABBR}`,
          paid_to: bankAccount,
          paid_amount: 2800,
          received_amount: 2800,
          mode_of_payment: 'Wire Transfer',
          reference_no: 'WIRE-MG-MAR-2026',
          reference_date: '2026-03-10',
          custom_lease: leaseNames[0] || null,
          custom_unit: prop1,
          references: [{
            reference_doctype: 'Sales Invoice',
            reference_name: invoiceNames[2],
            allocated_amount: 2800,
          }],
        }, 'Payment Entry (Maria – March rent)');

        if (peRec) await submit('Payment Entry', peRec.name);
      } else {
        console.log('  – Skipping Payment Entry: invoice not submitted or not found');
      }
    }
  }

  // ── 6. HD Tickets ─────────────────────────────────────────────────────────
  console.log('\n── HD Tickets ──');

  const ticketDefs = [
    {
      label: 'Open – Broken heater @ Maple 1A',
      subject: `[${prop1}] Broken heater – Unit 1A`,
      raised_by: 'maria.garcia.tenant@example.com',
      status: 'Open',
      priority: 'High',
      description: 'The central heating unit stopped working. Tenant reports no heat since yesterday. Temperature dropping.',
    },
    {
      label: 'Open (Replied) – Plumbing leak @ Ocean 5C',
      subject: `[${prop2}] Plumbing leak under kitchen sink`,
      raised_by: 'james.wilson.tenant@example.com',
      status: 'Replied',
      priority: 'Medium',
      description: 'Water dripping from pipe under kitchen sink. Tenant placed a bucket but needs urgent repair.',
    },
    {
      label: 'Resolved – Door lock replaced @ Watson',
      subject: `[${prop3}] Front door lock – replacement needed`,
      raised_by: 'priya.patel.tenant@example.com',
      status: 'Resolved',
      priority: 'Low',
      description: 'Front door lock was stiff and difficult to operate. Lock replaced by maintenance team.',
      resolution_details: 'Replaced deadbolt lock on 2026-02-20. Tenant confirmed resolution.',
    },
  ];

  for (const td of ticketDefs) {
    const { label, ...payload } = td;
    const wantedStatus = payload.status;
    const existing = await listNames('HD Ticket', [
      ['subject', '=', payload.subject],
    ]);
    let ticketName;
    if (existing.length > 0) {
      ticketName = existing[0];
      console.log(`  – Already exists HD Ticket: ${ticketName} (${label})`);
    } else {
      const created = await create('HD Ticket', payload, `HD Ticket "${label}"`);
      ticketName = created?.name;
    }
    // Helpdesk ignores status on creation – explicitly PUT the desired status.
    if (ticketName && wantedStatus !== 'Open') {
      try {
        await http.put(`/api/resource/HD%20Ticket/${encodeURIComponent(ticketName)}`, { status: wantedStatus });
        console.log(`  – Updated HD Ticket ${ticketName} status → ${wantedStatus}`);
      } catch (e) {
        console.warn(`  – Could not set status ${wantedStatus} on ticket ${ticketName}: ${e.response?.data?.exception || e.message}`);
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────');
  console.log('✅ Seed complete!\n');
  console.log('Created / verified:');
  console.log(`  Properties : ${allPropNames.length}`);
  console.log(`  Tenants    : ${Object.keys(tenantMap).length}`);
  console.log(`  Leases     : ${leaseNames.length}`);
  console.log(`  Invoices   : ${invoiceNames.length}`);
  console.log(`  HD Tickets : ${ticketDefs.length}`);
  console.log('');
  console.log('Tenant customer group: "Tenant"');
  console.log('Company used        :', COMPANY);
}

seed().catch(err => {
  console.error('\n💥 Seed failed:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
