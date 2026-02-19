'use strict';

/**
 * Buildium REST API client (Premium tier)
 *
 * Auth: Client ID + Secret passed in HTTP Basic Authorization header.
 * Base URL: https://api.buildium.com/v1
 *
 * Full API docs: https://developer.buildium.com/
 */

const axios = require('axios');
const logger = require('../logger');
const { config } = require('../config');

class BuildiumClient {
  constructor({ clientId, clientSecret, baseUrl } = {}) {
    const id = clientId || config.pms.buildium.clientId;
    const secret = clientSecret || config.pms.buildium.clientSecret;
    this.baseUrl = baseUrl || config.pms.buildium.baseUrl;

    this.http = axios.create({
      baseURL: this.baseUrl,
      // Buildium uses HTTP Basic auth with clientId:secret
      auth: { username: id, password: secret },
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 15_000,
    });

    this.http.interceptors.response.use(
      (res) => res,
      (err) => {
        const status = err.response?.status;
        const detail = err.response?.data?.Message || err.message;
        logger.error('Buildium API error', { status, detail, url: err.config?.url });
        return Promise.reject(err);
      }
    );
  }

  // ────────────────────────────────────────────────
  //  PROPERTIES & UNITS
  // ────────────────────────────────────────────────

  async getProperties(params = {}) {
    const { data } = await this.http.get('/rentals', { params });
    return data;
  }

  async getProperty(propertyId) {
    const { data } = await this.http.get(`/rentals/${propertyId}`);
    return data;
  }

  async getUnits(propertyId, params = {}) {
    const { data } = await this.http.get(`/rentals/${propertyId}/units`, { params });
    return data;
  }

  async getVacantUnits(params = {}) {
    const { data } = await this.http.get('/rentals/units', {
      params: { ...params, leaseStatuses: 'Active', vacant: true },
    });
    return data;
  }

  // ────────────────────────────────────────────────
  //  LEASES & TENANTS
  // ────────────────────────────────────────────────

  async getLeases(params = {}) {
    const { data } = await this.http.get('/leases', { params });
    return data;
  }

  async getLease(leaseId) {
    const { data } = await this.http.get(`/leases/${leaseId}`);
    return data;
  }

  async getTenants(params = {}) {
    const { data } = await this.http.get('/leases/outstandingbalances', { params });
    return data;
  }

  async getTenant(tenantId) {
    const { data } = await this.http.get(`/contacts/rentaltenants/${tenantId}`);
    return data;
  }

  // ────────────────────────────────────────────────
  //  FINANCIALS
  // ────────────────────────────────────────────────

  /**
   * Retrieve outstanding balances.
   * Buildium endpoint: GET /leases/outstandingbalances
   */
  async getOutstandingBalances(params = {}) {
    const { data } = await this.http.get('/leases/outstandingbalances', { params });
    return data;
  }

  /** Retrieve the ledger for a single lease. */
  async getLeaseLedger(leaseId, params = {}) {
    const { data } = await this.http.get(`/leases/${leaseId}/ledgerentries`, { params });
    return data;
  }

  /** General-ledger query for a date range. */
  async getGeneralLedger(params = {}) {
    const { data } = await this.http.get('/accounting/generalledger/entries', { params });
    return data;
  }

  async getPayments(params = {}) {
    const { data } = await this.http.get('/payments', { params });
    return data;
  }

  // ────────────────────────────────────────────────
  //  MAINTENANCE (Tasks)
  // ────────────────────────────────────────────────

  async getWorkOrders(params = {}) {
    const { data } = await this.http.get('/tasks/maintenancerequests', { params });
    return data;
  }

  async getWorkOrder(taskId) {
    const { data } = await this.http.get(`/tasks/maintenancerequests/${taskId}`);
    return data;
  }

  async getStaleWorkOrders(ageHours = 48) {
    const cutoff = new Date(Date.now() - ageHours * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]; // Buildium uses date-only filters
    const { data } = await this.http.get('/tasks/maintenancerequests', {
      params: { statuses: 'New,InProgress', createdDateTimeTo: cutoff },
    });
    return data;
  }

  async updateWorkOrder(taskId, payload) {
    const { data } = await this.http.put(`/tasks/maintenancerequests/${taskId}`, payload);
    return data;
  }

  // ────────────────────────────────────────────────
  //  COMMUNICATIONS / SMS (Buildium native or via Twilio add-on)
  // ────────────────────────────────────────────────

  async sendSMS(tenantId, message) {
    // Buildium does not expose a first-class SMS endpoint in all tiers;
    // the call below targets the built-in communication endpoint.
    const { data } = await this.http.post('/communications/phonelogs', {
      contactId: tenantId,
      type: 'Sms',
      description: message,
    });
    logger.info('Buildium SMS sent', { tenantId, messageSnippet: message.slice(0, 60) });
    return data;
  }
}

module.exports = BuildiumClient;
