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
 * One-time setup in the BoldSign UI (per template):
 *   1. Upload the lease/renewal PDF as a template.
 *   2. Set signer roles: "Tenant" (index 1) and "Landlord" (index 2).
 *   3. Tag every form field with a merge variable ID from the list below so the system
 *      can pre-fill all data before sending.
 *
 * Supported merge variable IDs:
 *   Landlord:  landlord_name, landlord_email, landlord_phone, landlord_address
 *   Tenant:    tenant_name, tenant_email, tenant_phone
 *   Property:  unit_address, unit_city, unit_state, unit_zip
 *   Lease:     start_date, end_date, monthly_rent, security_deposit,
 *              notice_period, late_fee_grace_days, late_fee_amount
 *
 * BoldSign API reference: https://developers.boldsign.com/
 */

const axios  = require('axios');
const logger = require('../logger');

// Template lookup: state_doctype → env var name
const TEMPLATE_MAP = {
  OH_LEASE:   'BOLDSIGN_TEMPLATE_OH_LEASE',
  OH_RENEWAL: 'BOLDSIGN_TEMPLATE_OH_RENEWAL',
  NC_LEASE:   'BOLDSIGN_TEMPLATE_NC_LEASE',
  NC_RENEWAL: 'BOLDSIGN_TEMPLATE_NC_RENEWAL',
};

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

/**
 * Resolve the BoldSign template ID for a given state + document type combination.
 *
 * @param {string} state    – Property state code, e.g. "OH" or "NC"
 * @param {string} docType  – "Lease" or "Renewal"
 * @returns {string} Template ID
 * @throws  {Error}  If no template is configured for the combination
 */
function resolveTemplateId(state, docType) {
  const key = `${(state || '').toUpperCase()}_${(docType || 'Lease').toUpperCase()}`;
  const envVar = TEMPLATE_MAP[key];
  const templateId = (envVar && process.env[envVar]) || process.env.BOLDSIGN_TEMPLATE_ID || '';
  if (!templateId) {
    throw new Error(
      `No BoldSign template configured for ${key}. ` +
      `Set ${envVar || 'BOLDSIGN_TEMPLATE_ID'} in your environment variables.`
    );
  }
  return templateId;
}

/**
 * Build BoldSign pre-fill tag array from a variables object.
 * Only entries with a non-empty value are included.
 */
function buildPreFillTags(vars) {
  return Object.entries(vars)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([id, value]) => ({ id, value: String(value) }));
}

/**
 * Send a lease or renewal document for signature to both the tenant and the landlord.
 *
 * The correct BoldSign template is chosen automatically based on the property state and
 * document type.  All available fields from ERPNext are pre-filled so that both parties
 * only need to sign — no manual data entry required.
 *
 * Signer role indices must match the template configuration:
 *   RoleIndex 1 → Tenant
 *   RoleIndex 2 → Landlord
 *
 * @param {Object} params
 * @param {string} params.docType        – "Lease" or "Renewal"
 * @param {string} params.state          – Property state code ("OH" or "NC")
 * @param {string} params.tenantEmail    – Tenant's email address
 * @param {string} params.tenantName     – Tenant's display name
 * @param {string} params.landlordEmail  – Landlord's email address
 * @param {string} params.landlordName   – Landlord's display name
 * @param {Object} params.variables      – Merge field values (see supported IDs above)
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

  const templateId = resolveTemplateId(state, docType);

  const preFillTags = buildPreFillTags(variables);
  const isRenewal = docType === 'Renewal';

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
        signerRole:  'Tenant',
        signerName:  tenantName,
        signerEmail: tenantEmail,
        signerType:  'Signer',
      },
      {
        roleIndex:   2,
        signerRole:  'Landlord',
        signerName:  landlordName,
        signerEmail: landlordEmail,
        signerType:  'Signer',
      },
    ],
    ...(preFillTags.length ? { prefillForms: preFillTags } : {}),
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
 * Preserves the original function signature used by the BoldSign webhook handler.
 *
 * @param {Object} params  – Same as sendDocumentForSignature (without docType/state)
 * @returns {Promise<{ documentId: string }>}
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
