'use strict';

/**
 * BoldSign e-signature API client.
 *
 * Used for:
 *   1. Sending a pre-filled lease or renewal agreement to tenant + landlord for e-signature.
 *   2. Downloading the fully-signed PDF once all parties have completed signing.
 *
 * Environment variables:
 *   BOLDSIGN_API_KEY              – BoldSign API key (app.boldsign.com → API Management)
 *   BOLDSIGN_TEMPLATE_OH_LEASE    – Template ID for Ohio new-lease document
 *   BOLDSIGN_TEMPLATE_OH_RENEWAL  – Template ID for Ohio lease-renewal document
 *   BOLDSIGN_TEMPLATE_NC_LEASE    – Template ID for North Carolina new-lease document
 *   BOLDSIGN_TEMPLATE_NC_RENEWAL  – Template ID for North Carolina lease-renewal document
 *   BOLDSIGN_TEMPLATE_ID          – Legacy fallback template (used if no state match found)
 *
 * Template structure (all 4 templates):
 *   Role index 1 → "Tenant"          (primary signer)
 *   Role index 2 → "Property Manager" or "Landlord"  (second signer)
 *
 * BoldSign API reference: https://developers.boldsign.com/
 */

const axios  = require('axios');
const logger = require('../logger');

// ─── Template registry ───────────────────────────────────────────────────────

// Maps template key → env var holding the BoldSign template ID
const TEMPLATE_MAP = {
  OH_LEASE:   'BOLDSIGN_TEMPLATE_OH_LEASE',
  OH_RENEWAL: 'BOLDSIGN_TEMPLATE_OH_RENEWAL',
  NC_LEASE:   'BOLDSIGN_TEMPLATE_NC_LEASE',
  NC_RENEWAL: 'BOLDSIGN_TEMPLATE_NC_RENEWAL',
};

// Maps template key → [tenantSignerRole, landlordSignerRole] as set in BoldSign
const TEMPLATE_ROLES = {
  OH_LEASE:   ['Tenant', 'Property Manager'],
  OH_RENEWAL: ['Tenant', 'Landlord'],
  NC_LEASE:   ['Tenant', 'Property Manager'],
  NC_RENEWAL: ['Tenant', 'Landlord'],
};

// Maps template key → function(vars) → prefillForms array for role 1 (Tenant signer).
// Field IDs were discovered from GET /v1/document/properties on sent documents.
// Role 2 (landlord) fields are in TEMPLATE_ROLE2_FIELD_MAPS below.
const TEMPLATE_FIELD_MAPS = {
  OH_LEASE: (v) => {
    const la = parseLandlordAddress(v.landlord_address);
    return [
      { id: 't_b47276be', value: v.landlord_name                    },  // p1 y=165 Landlord name
      { id: 't_2ca53bf9', value: la.street                          },  // p1 y=197 Landlord street
      { id: 't_cf14dc5a', value: la.city                            },  // p1 y=241 Landlord city
      { id: 't_1cf28b18', value: la.stateZip                        },  // p1 y=273 Landlord state/ZIP
      { id: 't_b4647a9a', value: v.landlord_phone || v.landlord_email}, // p1 y=305 Phone/email
      { id: 't_9cfaa4e0', value: v.tenant_name                      },  // p1 y=339 Tenant name
      { id: 't_526887b1', value: cityStateZip(v)                    },  // p1 y=372 Property city/state/ZIP (tenant section)
      { id: 't_61467ae8', value: v.unit_address                     },  // p1 y=404 Property street address
      { id: 't_f213d8f7', value: cityStateZip(v)                    },  // p1 y=436 City, State, ZIP
      { id: 't_91944728', value: fmtDate(v.start_date)              },  // p1 y=469 Lease start date
      { id: 't_d509523a', value: fmtDate(v.end_date)                },  // p1 y=469 Lease end date
      { id: 't_9e25018f', value: v.security_deposit                 },  // p1 y=503 Security deposit
      { id: 't_6da942d6', value: v.monthly_rent                     },  // p1 y=553 Monthly rent
      { id: 't_c68fab45', value: v.monthly_rent                     },  // p2 y=153 Monthly rent (repeat)
      { id: 't_c707f0d8', value: v.security_deposit                 },  // p2 y=393 Security deposit (repeat)
      { id: 't_af745be4', value: v.unit_address                     },  // p2 y=785 Tenant forwarding address
      { id: 't_5dff550d', value: fmtDate(v.start_date)              },  // p3 y=75  Lease start (repeat)
      { id: 't_3172ba19', value: fmtDate(v.end_date)                },  // p3 y=75  Lease end (repeat)
      { id: 't_8cfdbce1', value: v.tenant_name                      },  // p13 y=673 Tenant printed name
    ];
  },

  NC_LEASE: (v) => [
    { id: 't_25523961', value: v.landlord_name    },   // Landlord / owner full name
    { id: 't_4670396c', value: v.landlord_address },   // Landlord mailing address
    { id: 't_9d99a50b', value: v.tenant_name      },   // Tenant full legal name(s)
    { id: 't_0cd651e3', value: v.unit_address     },   // Rental property address
    { id: 't_1bfbbaae', value: cityStateZip(v)    },   // City, County, State, ZIP
    { id: 't_8df45050', value: fmtDate(v.start_date) },// MM/DD/YYYY (start)
    { id: 't_e4fb7f14', value: fmtDate(v.end_date)   },// MM/DD/YYYY (end)
    { id: 't_2f67fbdd', value: v.monthly_rent     },   // e.g. 1,500.00
    { id: 't_29a2e120', value: v.security_deposit },   // e.g. 3,000.00
    { id: 't_6bcc5166', value: v.monthly_rent     },   // Monthly rent
    { id: 't_f781a704', value: v.security_deposit },   // Deposit amount
    { id: 't_39e4faf0', value: fmtDate(v.start_date) },// Lease start date
    { id: 't_5a6b441d', value: fmtDate(v.end_date)   },// Lease end date
    { id: 't_6b414d52', value: v.tenant_name      },   // Tenant 1 printed name
  ],

  OH_RENEWAL: (v) => [
    { id: 't_f9b5c413', value: v.landlord_name    },   // Landlord / LLC name
    { id: 't_fc9b5a53', value: v.landlord_address },   // Landlord street address
    { id: 't_1cb2e8d0', value: v.tenant_name      },   // Tenant full name(s)
    { id: 't_7705b241', value: v.unit_address     },   // Tenant street address
    { id: 't_cd10ec3b', value: v.unit_address     },   // Full property address
    { id: 't_278dcce5', value: fmtDate(v.start_date) },// New lease start date
    { id: 't_9adb1dac', value: fmtDate(v.end_date)   },// New lease end date
    { id: 't_3aaddd26', value: v.monthly_rent     },   // Monthly rent
    { id: 't_fb9f90f6', value: v.tenant_name      },   // Tenant 1 printed name
  ],

  NC_RENEWAL: (v) => [
    { id: 't_fc623977', value: v.landlord_name    },   // Landlord / LLC name
    { id: 't_c362466b', value: v.landlord_address },   // Landlord address
    { id: 't_8d2b295b', value: v.tenant_name      },   // Tenant full name(s)
    { id: 't_3e74b05e', value: v.unit_address     },   // Tenant address
    { id: 't_3ce38266', value: v.unit_address     },   // Full property address
    { id: 't_4fcc20c7', value: fmtDate(v.start_date) },// New lease start date
    { id: 't_b8182848', value: fmtDate(v.end_date)   },// New lease end date
    { id: 't_9148f665', value: v.monthly_rent     },   // Monthly rent
    { id: 't_aa0057da', value: v.security_deposit },   // Deposit amount
    { id: 't_b7710ea0', value: v.tenant_name      },   // Tenant 1 printed name
  ],
};

/**
 * Pre-fill fields assigned to role 2 (landlord / Property Manager) on the signature page.
 * Field IDs from GET /v1/document/properties on sent OH_LEASE documents (page 13):
 *   t_8e851d00 (y=329) — landlord printed name
 *   t_4991b256 (y=329) — landlord title / name (side-by-side field)
 *   t_ae86f7ea (y=397) — landlord mailing address
 */
const TEMPLATE_ROLE2_FIELD_MAPS = {
  OH_LEASE: (v) => [
    { id: 't_8e851d00', value: v.landlord_name    },   // p13 y=329 Landlord printed name
    { id: 't_4991b256', value: v.landlord_name    },   // p13 y=329 Landlord name (paired field)
    { id: 't_ae86f7ea', value: v.landlord_address },   // p13 y=397 Landlord address
  ],
  // NC / Renewal signature-page fields can be added here once confirmed via API
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format ISO date (YYYY-MM-DD) → MM/DD/YYYY expected by templates. */
function fmtDate(iso) {
  if (!iso) return '';
  const parts = String(iso).split('-');
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts;
  return `${m}/${d}/${y}`;
}

/** Build "City, State ZIP" string from property unit variables. */
function cityStateZip(v) {
  const parts = [v.unit_city, v.unit_state].filter(Boolean).join(', ');
  return v.unit_zip ? `${parts} ${v.unit_zip}` : parts;
}

/**
 * Split a full landlord address string into { street, city, stateZip }.
 * Handles formats such as:
 *   "123 Main St, Springfield, OH 45501"     → street="123 Main St", city="Springfield", stateZip="OH 45501"
 *   "123 Main St, OH 45501"                  → street="123 Main St", city="", stateZip="OH 45501"
 *   "123 Main St"                            → street="123 Main St", city="", stateZip=""
 */
function parseLandlordAddress(addr) {
  if (!addr) return { street: '', city: '', stateZip: '' };
  // "Street, City, ST 12345[-0000]"
  const m3 = addr.match(/^(.+?),\s*([^,]+?),\s*([A-Z]{2}\s+\d{5}(?:-\d{4})?)$/);
  if (m3) return { street: m3[1].trim(), city: m3[2].trim(), stateZip: m3[3].trim() };
  // "Street, ST 12345" or "Street, City ST 12345"
  const m2 = addr.match(/^(.+?),\s*(.+\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)$/);
  if (m2) return { street: m2[1].trim(), city: '', stateZip: m2[2].trim() };
  return { street: addr.trim(), city: '', stateZip: '' };
}

function buildHttpsAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxyUrl) return undefined;
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(proxyUrl);
  } catch (_) {
    return undefined;
  }
}

const httpsAgent = buildHttpsAgent();

const http = axios.create({
  baseURL: 'https://api.boldsign.com/v1',
  headers: {
    'X-API-KEY': process.env.BOLDSIGN_API_KEY || '',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  timeout: 30_000,
  ...(httpsAgent ? { httpsAgent, proxy: false } : {}),
});

// ─── Core functions ───────────────────────────────────────────────────────────

function resolveTemplateKey(state, docType) {
  return `${(state || '').toUpperCase()}_${(docType || 'Lease').toUpperCase()}`;
}

function resolveTemplateId(state, docType) {
  const key    = resolveTemplateKey(state, docType);
  const envVar = TEMPLATE_MAP[key];
  const id     = (envVar && process.env[envVar]) || process.env.BOLDSIGN_TEMPLATE_ID || '';
  if (!id) {
    throw new Error(
      `No BoldSign template configured for ${key}. ` +
      `Set ${envVar || 'BOLDSIGN_TEMPLATE_ID'} in your environment variables.`
    );
  }
  return id;
}

/**
 * Build existingFormFields array from variables using the template-specific field map.
 * Falls back to empty array if no map is defined for this template.
 */
function buildFormFields(fieldMap, variables) {
  const mapper = fieldMap;
  if (!mapper) return [];
  return mapper(variables)
    .filter(({ value }) => value !== undefined && value !== null && value !== '')
    .map(({ id, value }) => ({ id, value: String(value) }));
}

/**
 * Send a lease or renewal document for signature to both the tenant and the landlord.
 *
 * @param {Object} params
 * @param {string} params.docType        – "Lease" or "Renewal"
 * @param {string} params.state          – Property state code ("OH" or "NC")
 * @param {string} params.tenantEmail    – Tenant's email address
 * @param {string} params.tenantName     – Tenant's display name
 * @param {string} params.landlordEmail  – Landlord's email address
 * @param {string} params.landlordName   – Landlord's display name
 * @param {Object} params.variables      – Lease data for pre-filling form fields
 * @returns {Promise<{ documentId: string }>}
 */
async function sendDocumentForSignature({
  docType = 'Lease',
  state = '',
  tenantEmail,
  tenantName,
  landlordEmail,
  landlordName,
  variables = {},
}) {
  if (!process.env.BOLDSIGN_API_KEY) {
    logger.warn('BoldSign: BOLDSIGN_API_KEY not configured — skipping send');
    return { documentId: 'SKIPPED' };
  }

  const key        = resolveTemplateKey(state, docType);
  const templateId = resolveTemplateId(state, docType);
  const isRenewal  = docType === 'Renewal';

  const [tenantRole, landlordRole] = TEMPLATE_ROLES[key] || ['Tenant', 'Landlord'];
  const role1Fields = buildFormFields(TEMPLATE_FIELD_MAPS[key],       variables);
  const role2Fields = buildFormFields(TEMPLATE_ROLE2_FIELD_MAPS[key], variables);

  logger.info('BoldSign: prefill fields being sent', {
    templateKey: key,
    templateId,
    role1FieldCount: role1Fields.length,
    role2FieldCount: role2Fields.length,
    role1Fields,
    role2Fields,
    variablesSnapshot: {
      landlord_name:    variables.landlord_name,
      landlord_address: variables.landlord_address,
      tenant_name:      variables.tenant_name,
      unit_address:     variables.unit_address,
      unit_city:        variables.unit_city,
      unit_state:       variables.unit_state,
      unit_zip:         variables.unit_zip,
      monthly_rent:     variables.monthly_rent,
      security_deposit: variables.security_deposit,
      start_date:       variables.start_date,
      end_date:         variables.end_date,
    },
  });

  const payload = {
    title:   isRenewal
      ? 'Lease Renewal Agreement — Signature Required'
      : 'Lease Agreement — Signature Required',
    message: isRenewal
      ? 'Please review and sign the attached lease renewal agreement at your earliest convenience.'
      : 'Please review and sign the attached lease agreement at your earliest convenience.',
    roles: [
      {
        roleIndex:   1,
        signerRole:  tenantRole,
        signerName:  tenantName,
        signerEmail: tenantEmail,
        signerType:  'Signer',
        ...(role1Fields.length ? { existingFormFields: role1Fields } : {}),
      },
      {
        roleIndex:   2,
        signerRole:  landlordRole,
        signerName:  landlordName,
        signerEmail: landlordEmail,
        signerType:  'Signer',
        ...(role2Fields.length ? { existingFormFields: role2Fields } : {}),
      },
    ],
    reminderSettings: {
      enableAutoReminder: true,
      reminderDays:       3,
      reminderCount:      3,
    },
  };

  let data;
  try {
    ({ data } = await http.post(
      `/template/send?templateId=${encodeURIComponent(templateId)}`,
      payload
    ));
  } catch (err) {
    const detail = err.response?.data;
    logger.error('BoldSign API error', {
      status:   err.response?.status,
      response: typeof detail === 'object' ? detail : String(detail).slice(0, 500),
      payload:  JSON.stringify(payload).slice(0, 1000),
    });
    throw err;
  }

  const documentId = data.documentId || data.DocumentId || '';

  logger.info('BoldSign: document sent for signature', {
    documentId,
    tenant: tenantEmail,
    docType,
    state,
    templateId,
  });

  return { documentId };
}

/**
 * Backward-compatible wrapper — sends a new Lease document.
 */
async function sendLeaseForSignature({ tenantEmail, tenantName, landlordEmail, landlordName, variables = {} }) {
  return sendDocumentForSignature({
    docType:  'Lease',
    state:    variables.unit_state || '',
    tenantEmail,
    tenantName,
    landlordEmail,
    landlordName,
    variables,
  });
}

/**
 * Download the fully-signed document PDF.
 *
 * @param {string} documentId – BoldSign document ID (from the Completed webhook)
 * @returns {Promise<Buffer>} – Raw PDF binary
 */
async function downloadSignedDocument(documentId) {
  if (!process.env.BOLDSIGN_API_KEY) {
    logger.warn('BoldSign: BOLDSIGN_API_KEY not configured — cannot download');
    return Buffer.alloc(0);
  }

  const response = await http.get('/document/download', {
    params:       { documentId },
    responseType: 'arraybuffer',
  });

  logger.info('BoldSign: signed PDF downloaded', { documentId });
  return Buffer.from(response.data);
}

module.exports = { sendDocumentForSignature, sendLeaseForSignature, downloadSignedDocument };
