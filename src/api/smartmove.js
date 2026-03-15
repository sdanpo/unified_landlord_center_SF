'use strict';

/**
 * TransUnion SmartMove API client.
 *
 * SmartMove lets landlords request a tenant screening report (credit, criminal,
 * eviction) where the applicant — not the landlord — pays the fee.
 *
 * Flow:
 *   1. Landlord calls sendInvitation() → SmartMove emails the applicant a
 *      unique screening link.
 *   2. Applicant verifies identity and pays on the SmartMove platform.
 *   3. SmartMove fires a webhook to /webhooks/smartmove/completed when done.
 *   4. The landlord views the full report in their SmartMove dashboard.
 *
 * Environment variables:
 *   SMARTMOVE_API_KEY  – Landlord's SmartMove API key
 *
 * SmartMove API reference: https://developers.mysmartmove.com/
 */

const axios  = require('axios');
const logger = require('../logger');

const API_KEY = process.env.SMARTMOVE_API_KEY || '';

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
  baseURL: 'https://api.mysmartmove.com/v1',
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    Accept:         'application/json',
  },
  timeout: 20_000,
  ...(buildHttpsAgent() ? { httpsAgent: buildHttpsAgent(), proxy: false } : {}),
});

/**
 * Send a SmartMove screening invitation to a rental applicant.
 *
 * The applicant receives an email with a link to complete the screening.
 * The landlord is charged $0; the applicant pays the screening fee directly.
 *
 * @param {Object} params
 * @param {string} params.firstName   – Applicant first name
 * @param {string} params.lastName    – Applicant last name
 * @param {string} params.email       – Applicant email address
 * @param {string} [params.reportType] – "basic" | "standard" | "premium"  (default: "standard")
 * @returns {Promise<{ invitationId: string, invitationUrl: string }>}
 */
async function sendInvitation({ firstName, lastName, email, reportType = 'standard' }) {
  if (!API_KEY) {
    logger.warn('SmartMove: SMARTMOVE_API_KEY not configured — skipping invitation');
    return { invitationId: 'SKIPPED', invitationUrl: '' };
  }

  const reportMap = { basic: 'BASIC', standard: 'STANDARD', premium: 'PREMIUM' };
  const product   = reportMap[reportType] || 'STANDARD';

  const { data } = await http.post('/invitations', {
    first_name:  firstName,
    last_name:   lastName,
    email:       email,
    product:     product,
  });

  logger.info('SmartMove: screening invitation sent', {
    invitationId: data.invitation_id,
    email,
  });

  return {
    invitationId:  data.invitation_id,
    invitationUrl: data.invitation_url || '',
  };
}

module.exports = { sendInvitation };
