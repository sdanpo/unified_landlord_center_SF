'use strict';

/**
 * Dropbox Sign (formerly HelloSign) API client.
 *
 * Used for:
 *   1. Sending a pre-filled lease agreement to tenant + landlord for e-signature.
 *   2. Downloading the fully-signed PDF once all parties have signed.
 *
 * Environment variables:
 *   DROPBOX_SIGN_API_KEY      – Dropbox Sign API key (from app dashboard)
 *   DROPBOX_SIGN_TEMPLATE_ID  – Template ID of the uploaded lease PDF template
 *
 * The lease template must be uploaded once in the Dropbox Sign UI with these
 * signer roles and merge fields:
 *   Signer roles:  "Tenant", "Landlord"
 *   Merge fields:  tenant_name, unit_address, start_date, end_date,
 *                  monthly_rent, security_deposit
 */

const axios  = require('axios');
const logger = require('../logger');

const API_KEY     = process.env.DROPBOX_SIGN_API_KEY     || '';
const TEMPLATE_ID = process.env.DROPBOX_SIGN_TEMPLATE_ID || '';

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

const http = axios.create({
  baseURL: 'https://api.hellosign.com/v3',
  auth: { username: API_KEY, password: '' },
  timeout: 30_000,
  ...(buildHttpsAgent() ? { httpsAgent: buildHttpsAgent(), proxy: false } : {}),
});

/**
 * Send the lease template for signature to both the tenant and the landlord.
 *
 * @param {Object} params
 * @param {string} params.tenantEmail    – Tenant's email address
 * @param {string} params.tenantName     – Tenant's display name
 * @param {string} params.landlordEmail  – Landlord's email address
 * @param {string} params.landlordName   – Landlord's display name
 * @param {Object} params.variables      – Merge field values:
 *   { tenant_name, unit_address, start_date, end_date, monthly_rent, security_deposit }
 * @returns {Promise<{ signatureRequestId: string }>}
 */
async function sendLeaseForSignature({ tenantEmail, tenantName, landlordEmail, landlordName, variables = {} }) {
  if (!API_KEY) {
    logger.warn('Dropbox Sign: DROPBOX_SIGN_API_KEY not configured — skipping send');
    return { signatureRequestId: 'SKIPPED' };
  }
  if (!TEMPLATE_ID) {
    throw new Error('DROPBOX_SIGN_TEMPLATE_ID is not configured. Upload the lease template in the Dropbox Sign UI first.');
  }

  // Build custom_fields (merge field values) as a JSON array
  const customFields = Object.entries(variables).map(([name, value]) => ({
    name,
    value: String(value ?? ''),
  }));

  const payload = {
    template_id: TEMPLATE_ID,
    subject:     'Lease Agreement — Signature Required',
    message:     'Please review and sign the attached lease agreement.',
    signers: [
      { role: 'Tenant',   email_address: tenantEmail,   name: tenantName   },
      { role: 'Landlord', email_address: landlordEmail, name: landlordName },
    ],
    custom_fields: customFields,
  };

  const { data } = await http.post('/signature_request/send_with_template', payload);

  logger.info('Dropbox Sign: lease sent for signature', {
    signatureRequestId: data.signature_request?.signature_request_id,
    tenant: tenantEmail,
  });

  return { signatureRequestId: data.signature_request?.signature_request_id };
}

/**
 * Download the fully-signed lease PDF.
 *
 * @param {string} signatureRequestId
 * @returns {Promise<Buffer>} – Raw PDF binary
 */
async function downloadSignedDocument(signatureRequestId) {
  if (!API_KEY) {
    logger.warn('Dropbox Sign: DROPBOX_SIGN_API_KEY not configured — cannot download');
    return Buffer.alloc(0);
  }

  const response = await http.get(
    `/signature_request/files/${encodeURIComponent(signatureRequestId)}`,
    { params: { file_type: 'pdf' }, responseType: 'arraybuffer' }
  );

  logger.info('Dropbox Sign: signed PDF downloaded', { signatureRequestId });
  return Buffer.from(response.data);
}

module.exports = { sendLeaseForSignature, downloadSignedDocument };
