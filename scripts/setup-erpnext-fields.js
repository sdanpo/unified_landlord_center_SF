'use strict';

/**
 * setup-erpnext-fields.js
 *
 * Creates the custom fields required by Unified Landlord Center SF on your
 * ERPNext instance via the REST API.
 *
 * Prerequisites:
 *   - ERPNext instance running with the PropMS app installed.
 *     That app provides the "Lease", "Property", and "Property Unit"
 *     DocTypes.  The custom_lease Link fields CANNOT be created until
 *     "Lease" exists — ERPNext will reject them with:
 *       "Options must be a valid DocType for field lease"
 *   - .env file populated (or env vars exported) with at least:
 *       ERPNEXT_BASE_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET
 *
 * Usage:
 *   node scripts/setup-erpnext-fields.js
 *
 * The script is idempotent: if a field already exists it is skipped.
 */

require('dotenv').config();
const axios = require('axios');

const BASE_URL = (process.env.ERPNEXT_BASE_URL || '').replace(/\/$/, '');
const API_KEY  = process.env.ERPNEXT_API_KEY  || '';
const API_SECRET = process.env.ERPNEXT_API_SECRET || '';

if (!BASE_URL || !API_KEY || !API_SECRET) {
  console.error(
    'ERROR: ERPNEXT_BASE_URL, ERPNEXT_API_KEY, and ERPNEXT_API_SECRET must be set.\n' +
    'Copy .env.example → .env and fill in your credentials.'
  );
  process.exit(1);
}

const http = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `token ${API_KEY}:${API_SECRET}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  timeout: 15_000,
});

/**
 * Custom field definitions.
 *
 * Fields whose fieldtype is "Link" require that `options` resolves to an
 * existing DocType on the target ERPNext instance.  "Lease" is
 * provided by PropMS.  The script checks for that DocType first and
 * aborts with a clear message if it is missing.
 */
const CUSTOM_FIELDS = [
  // ── Sales Invoice ──────────────────────────────────────────────────────────
  { dt: 'Sales Invoice', fieldname: 'custom_unit',     label: 'Unit',     fieldtype: 'Data', insert_after: 'customer' },
  { dt: 'Sales Invoice', fieldname: 'custom_property', label: 'Property', fieldtype: 'Data', insert_after: 'custom_unit' },
  {
    dt: 'Sales Invoice', fieldname: 'custom_lease', label: 'Lease',
    fieldtype: 'Link', options: 'Lease',   // requires PropMS app
    insert_after: 'custom_property',
  },

  // ── Payment Entry ──────────────────────────────────────────────────────────
  { dt: 'Payment Entry', fieldname: 'custom_unit',  label: 'Unit',  fieldtype: 'Data', insert_after: 'party' },
  {
    dt: 'Payment Entry', fieldname: 'custom_lease', label: 'Lease',
    fieldtype: 'Link', options: 'Lease',   // requires PropMS app
    insert_after: 'custom_unit',
  },

  // ── HD Ticket (Helpdesk module) ────────────────────────────────────────────
  { dt: 'HD Ticket', fieldname: 'custom_unit',     label: 'Unit',     fieldtype: 'Data', insert_after: 'customer' },
  { dt: 'HD Ticket', fieldname: 'custom_property', label: 'Property', fieldtype: 'Data', insert_after: 'custom_unit' },
];

/** Check whether a DocType exists on the ERPNext instance. */
async function doctypeExists(name) {
  try {
    const { data } = await http.get(
      `/api/resource/DocType/${encodeURIComponent(name)}`,
      { params: { fields: JSON.stringify(['name']) } }
    );
    return !!data?.data?.name;
  } catch (err) {
    if (err.response?.status === 404) return false;
    throw err;
  }
}

/** Check whether a Custom Field already exists (to make the script idempotent). */
async function customFieldExists(dt, fieldname) {
  try {
    const { data } = await http.get('/api/resource/Custom Field', {
      params: {
        filters: JSON.stringify([
          ['dt', '=', dt],
          ['fieldname', '=', fieldname],
        ]),
        fields: JSON.stringify(['name']),
        limit_page_length: 1,
      },
    });
    return (data?.data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Create a single Custom Field via the ERPNext API. */
async function createCustomField({ dt, fieldname, label, fieldtype, options, insert_after }) {
  const payload = { dt, fieldname, label, fieldtype, insert_after };
  if (options) payload.options = options;

  const { data } = await http.post('/api/resource/Custom Field', payload);
  return data?.data?.name;
}

async function main() {
  console.log(`\nConnecting to ERPNext at ${BASE_URL} …\n`);

  // ── Prerequisite check ────────────────────────────────────────────────────
  // The custom_lease Link fields point to "Lease".  ERPNext will
  // refuse to save a Custom Field whose options value is not a valid DocType.
  // Catch this before making any API calls to give the user a clear message.
  console.log('Checking prerequisite: "Lease" DocType …');
  const hasRentalContract = await doctypeExists('Lease');

  if (!hasRentalContract) {
    console.error(
      '\nERROR: "Lease" DocType not found on this ERPNext instance.\n\n' +
      'This DocType is provided by the PropMS Frappe app.\n' +
      'Install it first:\n\n' +
      '  bench get-app https://github.com/aakvatech/PropMS\n' +
      '  bench --site <your-site> install-app propms\n\n' +
      'Then re-run this script.\n\n' +
      'Without "Lease", ERPNext will reject the custom_lease Link\n' +
      'field with: "Options must be a valid DocType for field lease"\n'
    );
    process.exit(1);
  }
  console.log('  ✓ "Lease" DocType found.\n');

  // ── Create custom fields ───────────────────────────────────────────────────
  let created = 0;
  let skipped = 0;

  for (const field of CUSTOM_FIELDS) {
    const { dt, fieldname } = field;
    const display = `${dt}.${fieldname}`;

    if (await customFieldExists(dt, fieldname)) {
      console.log(`  skip  ${display}  (already exists)`);
      skipped++;
      continue;
    }

    try {
      await createCustomField(field);
      console.log(`  create ${display}`);
      created++;
    } catch (err) {
      const detail =
        err.response?.data?.exception ||
        err.response?.data?.message ||
        err.message;
      console.error(`  ERROR  ${display}: ${detail}`);
      process.exitCode = 1;
    }
  }

  console.log(`\nDone. Created: ${created}  Skipped (already existed): ${skipped}\n`);
}

main().catch((err) => {
  console.error('\nUnexpected error:', err.message);
  process.exit(1);
});
