'use strict';

/**
 * BoldSign e-signature API client.
 *
 * BoldSign is used instead of Dropbox Sign — it is cheaper ($5–99/mo vs $25+/mo)
 * and has a free tier suitable for low-volume landlords.
 *
 * Used for:
 *   1. Sending a pre-filled lease agreement to tenant + landlord for e-signature.
 *   2. Downloading the fully-signed PDF once all parties have completed signing.
 *
 * Environment variables:
 *   BOLDSIGN_API_KEY       – BoldSign API key (from app.boldsign.com → API Management)
 *   BOLDSIGN_TEMPLATE_ID   – Template ID of the uploaded lease PDF template
 *
 * One-time setup in the BoldSign UI:
 *   1. Upload the landlord's lease PDF as a template
 *   2. Set signer roles: "Tenant" (index 1) and "Landlord" (index 2)
 *   3. Tag form fields with merge variables:
 *      tenant_name, unit_address, start_date, end_date, monthly_rent, security_deposit
 *   4. Copy the template ID into BOLDSIGN_TEMPLATE_ID in .env
 *
 * BoldSign API reference: https://developers.boldsign.com/
 */

const axios  = require('axios');
const logger = require('../logger');

const API_KEY     = process.env.BOLDSIGN_API_KEY     || '';
const TEMPLATE_ID = process.env.BOLDSIGN_TEMPLATE_ID || '';

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
    'X-API-KEY': API_KEY,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  timeout: 30_000,
  ...(httpsAgent ? { httpsAgent, proxy: false } : {}),
});

/**
 * Send the lease template for signature to both the tenant and the landlord.
 *
 * Signer role indices must match what was configured in the BoldSign template:
 *   RoleIndex 1 → Tenant
 *   RoleIndex 2 → Landlord
 *
 * @param {Object} params
 * @param {string} params.tenantEmail    – Tenant's email address
 * @param {string} params.tenantName     – Tenant's display name
 * @param {string} params.landlordEmail  – Landlord's email address
 * @param {string} params.landlordName   – Landlord's display name
 * @param {Object} params.variables      – Merge field values:
 *   { tenant_name, unit_address, start_date, end_date, monthly_rent, security_deposit }
 * @returns {Promise<{ documentId: string }>}
 */
async function sendLeaseForSignature({ tenantEmail, tenantName, landlordEmail, landlordName, variables = {} }) {
  if (!API_KEY) {
    logger.warn('BoldSign: BOLDSIGN_API_KEY not configured — skipping send');
    return { documentId: 'SKIPPED' };
  }
  if (!TEMPLATE_ID) {
    throw new Error('BOLDSIGN_TEMPLATE_ID is not configured. Upload the lease template in BoldSign first.');
  }

  // Build pre-fill tags from variables object
  // BoldSign uses FormFields on the role to pre-populate merge fields
  const buildPreFillTags = (vars) =>
    Object.entries(vars)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([id, value]) => ({ id, value: String(value) }));

  const preFillTags = buildPreFillTags(variables);

  const payload = {
    title:   'Lease Agreement — Signature Required',
    message: 'Please review and sign the attached lease agreement at your earliest convenience.',
    roles: [
      {
        roleIndex:   1,
        signerName:  tenantName,
        signerEmail: tenantEmail,
        signerType:  'Signer',
        ...(preFillTags.length ? { formFields: preFillTags.map(t => ({ ...t, fieldType: 'Textbox' })) } : {}),
      },
      {
        roleIndex:   2,
        signerName:  landlordName,
        signerEmail: landlordEmail,
        signerType:  'Signer',
      },
    ],
    reminderSettings: {
      enableAutoReminder: true,
      reminderDays:       3,
      reminderCount:      3,
    },
  };

  const { data } = await http.post(
    `/template/send?templateId=${encodeURIComponent(TEMPLATE_ID)}`,
    payload
  );

  const documentId = data.documentId || data.DocumentId || '';

  logger.info('BoldSign: lease sent for signature', { documentId, tenant: tenantEmail });

  return { documentId };
}

/**
 * Download the fully-signed lease PDF.
 *
 * @param {string} documentId – BoldSign document ID (from the Completed webhook)
 * @returns {Promise<Buffer>} – Raw PDF binary
 */
async function downloadSignedDocument(documentId) {
  if (!API_KEY) {
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

module.exports = { sendLeaseForSignature, downloadSignedDocument };
