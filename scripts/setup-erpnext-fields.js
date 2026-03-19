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
  { dt: 'HD Ticket', fieldname: 'custom_unit',            label: 'Unit',            fieldtype: 'Data',   insert_after: 'customer' },
  { dt: 'HD Ticket', fieldname: 'custom_property',        label: 'Property',        fieldtype: 'Data',   insert_after: 'custom_unit' },
  { dt: 'HD Ticket', fieldname: 'custom_ticket_type',     label: 'Ticket Type',     fieldtype: 'Select', insert_after: 'custom_property',
    options: 'Maintenance\nLease Renewal\nMove-Out Notice\nOther' },
  {
    dt: 'HD Ticket', fieldname: 'custom_assigned_vendor', label: 'Assigned Vendor',
    fieldtype: 'Link', options: 'Supplier',
    insert_after: 'custom_ticket_type',
  },
  { dt: 'HD Ticket', fieldname: 'custom_vendor_quote',    label: 'Vendor Quote ($)', fieldtype: 'Currency', insert_after: 'custom_assigned_vendor' },
  { dt: 'HD Ticket', fieldname: 'custom_quote_approved',  label: 'Quote Approved',  fieldtype: 'Check',    insert_after: 'custom_vendor_quote', default: '0' },

  // ── Supplier (vendor directory) ────────────────────────────────────────────
  { dt: 'Supplier', fieldname: 'custom_trade',          label: 'Trade / Specialty', fieldtype: 'Select', insert_after: 'supplier_type',
    options: 'Plumbing\nElectrical\nHVAC\nPainting\nCarpentry\nLandscaping\nPest Control\nGeneral' },
  { dt: 'Supplier', fieldname: 'custom_license_number', label: 'CA License #',      fieldtype: 'Data',   insert_after: 'custom_trade' },
  { dt: 'Supplier', fieldname: 'custom_rating',         label: 'Rating',            fieldtype: 'Select', insert_after: 'custom_license_number',
    options: '5 - Excellent\n4 - Good\n3 - Average\n2 - Below Average\n1 - Poor' },
  { dt: 'Supplier', fieldname: 'custom_sms_number',     label: 'SMS / Mobile #',    fieldtype: 'Data',   insert_after: 'custom_rating' },

  // ── Property (address + state for template routing) ───────────────────────
  { dt: 'Property', fieldname: 'custom_state',          label: 'State',          fieldtype: 'Select',
    options: 'OH\nNC', insert_after: 'name1' },
  { dt: 'Property', fieldname: 'custom_street_address', label: 'Street Address', fieldtype: 'Data',
    insert_after: 'custom_state' },
  { dt: 'Property', fieldname: 'custom_city',           label: 'City',           fieldtype: 'Data',
    insert_after: 'custom_street_address' },
  { dt: 'Property', fieldname: 'custom_zip_code',       label: 'ZIP Code',       fieldtype: 'Data',
    insert_after: 'custom_city' },

  // ── Lease (renewal tracking) ───────────────────────────────────────────────
  { dt: 'Lease', fieldname: 'custom_renewal_notice_sent', label: 'Renewal Notice Sent', fieldtype: 'Date',   insert_after: 'end_date' },
  { dt: 'Lease', fieldname: 'custom_renewal_action',      label: 'Renewal Action',      fieldtype: 'Select', insert_after: 'custom_renewal_notice_sent',
    options: '\nRenew\nVacating\nRent Increase' },
  { dt: 'Lease', fieldname: 'custom_document_type',       label: 'Document Type',       fieldtype: 'Select', insert_after: 'custom_renewal_action',
    options: 'Lease\nRenewal', default: 'Lease' },

  // ── Lease (late fee configuration) ────────────────────────────────────────
  { dt: 'Lease', fieldname: 'custom_late_fee_grace_days',  label: 'Late Fee Grace Period (days)', fieldtype: 'Int',      insert_after: 'late_payment_interest_percentage', default: '5' },
  { dt: 'Lease', fieldname: 'custom_late_fee_type',        label: 'Late Fee Type',                fieldtype: 'Select',   insert_after: 'custom_late_fee_grace_days',
    options: 'Percentage\nFlat Amount', default: 'Percentage' },
  { dt: 'Lease', fieldname: 'custom_late_fee_flat_amount', label: 'Daily Flat Late Fee ($)',      fieldtype: 'Currency', insert_after: 'custom_late_fee_type', default: '0' },

  // ── Sales Invoice (late fee tracking / dedup) ──────────────────────────────
  { dt: 'Sales Invoice', fieldname: 'custom_is_late_fee',       label: 'Is Late Fee',      fieldtype: 'Check',  insert_after: 'custom_lease', default: '0' },
  {
    dt: 'Sales Invoice', fieldname: 'custom_original_invoice', label: 'Original Invoice',
    fieldtype: 'Link', options: 'Sales Invoice',
    insert_after: 'custom_is_late_fee',
  },
  { dt: 'Sales Invoice', fieldname: 'custom_late_fee_date', label: 'Late Fee Date', fieldtype: 'Date', insert_after: 'custom_original_invoice' },

  // ── Lead (rental application fields) ──────────────────────────────────────
  { dt: 'Lead', fieldname: 'custom_date_of_birth',           label: 'Date of Birth',               fieldtype: 'Date',       insert_after: 'mobile_no' },
  { dt: 'Lead', fieldname: 'custom_current_address',         label: 'Current Address',              fieldtype: 'Small Text', insert_after: 'custom_date_of_birth' },
  { dt: 'Lead', fieldname: 'custom_monthly_rent_paid',        label: 'Monthly Rent Paid Currently', fieldtype: 'Currency',   insert_after: 'custom_current_address' },
  { dt: 'Lead', fieldname: 'custom_current_landlord_name',   label: 'Current Landlord Name',       fieldtype: 'Data',       insert_after: 'custom_monthly_rent_paid' },
  { dt: 'Lead', fieldname: 'custom_current_landlord_phone',  label: 'Current Landlord Phone',      fieldtype: 'Data',       insert_after: 'custom_current_landlord_name' },
  { dt: 'Lead', fieldname: 'custom_monthly_gross_income',    label: 'Monthly Gross Income',        fieldtype: 'Currency',   insert_after: 'custom_current_landlord_phone' },
  { dt: 'Lead', fieldname: 'custom_employment_start_date',   label: 'Employment Start Date',       fieldtype: 'Date',       insert_after: 'custom_monthly_gross_income' },
  { dt: 'Lead', fieldname: 'custom_eviction_history',        label: 'Ever Evicted?',               fieldtype: 'Select',     insert_after: 'custom_employment_start_date',
    options: '\nYes\nNo' },
  { dt: 'Lead', fieldname: 'custom_broken_lease_history',    label: 'Ever Broken a Lease?',        fieldtype: 'Select',     insert_after: 'custom_eviction_history',
    options: '\nYes\nNo' },
  { dt: 'Lead', fieldname: 'custom_number_of_occupants',     label: 'Number of Occupants',         fieldtype: 'Int',        insert_after: 'custom_broken_lease_history' },
  { dt: 'Lead', fieldname: 'custom_has_pets',                label: 'Any Pets?',                   fieldtype: 'Select',     insert_after: 'custom_number_of_occupants',
    options: '\nYes\nNo' },
  { dt: 'Lead', fieldname: 'custom_pet_description',         label: 'Pet Description',             fieldtype: 'Small Text', insert_after: 'custom_has_pets' },
  { dt: 'Lead', fieldname: 'custom_consent_background_check', label: 'Consent: Background Check', fieldtype: 'Check',      insert_after: 'custom_pet_description', default: '0' },
  { dt: 'Lead', fieldname: 'custom_consent_accuracy',        label: 'Consent: Info Is Accurate',   fieldtype: 'Check',      insert_after: 'custom_consent_background_check', default: '0' },
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
