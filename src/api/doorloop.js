'use strict';

/**
 * DoorLoop REST API client (Premium tier)
 *
 * Auth: Bearer token via Authorization header (AES-256, TLS/SSL).
 * All endpoints are relative to DOORLOOP_BASE_URL (default: https://api.doorloop.com/v1).
 *
 * Relevant DoorLoop object types:
 *   - Property  – a building/complex
 *   - Unit       – an individual rentable space inside a property
 *   - Lease      – an active rental agreement linking a unit to tenants
 *   - Tenant     – a contact associated with one or more leases
 *   - WorkOrder  – a maintenance request / task
 *   - Payment    – a financial transaction on a lease ledger
 */

const axios = require('axios');
const logger = require('../logger');
const { config } = require('../config');

class DoorLoopClient {
  constructor({ apiKey, baseUrl } = {}) {
    this.baseUrl = baseUrl || config.pms.doorloop.baseUrl;
    this.http = axios.create({
      baseURL: this.baseUrl,
      headers: {
        Authorization: `Bearer ${apiKey || config.pms.doorloop.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 15_000,
    });

    // Attach a response interceptor for unified error logging
    this.http.interceptors.response.use(
      (res) => res,
      (err) => {
        const status = err.response?.status;
        const detail = err.response?.data?.message || err.message;
        logger.error('DoorLoop API error', { status, detail, url: err.config?.url });
        return Promise.reject(err);
      }
    );
  }

  // ────────────────────────────────────────────────
  //  PROPERTIES & UNITS
  // ────────────────────────────────────────────────

  /** List all properties in the portfolio. */
  async getProperties(params = {}) {
    const { data } = await this.http.get('/properties', { params });
    return data;
  }

  /** Get a single property by ID. */
  async getProperty(propertyId) {
    const { data } = await this.http.get(`/properties/${propertyId}`);
    return data;
  }

  /** List all units, optionally filtered by property. */
  async getUnits(params = {}) {
    const { data } = await this.http.get('/units', { params });
    return data;
  }

  /** Get a single unit by ID. */
  async getUnit(unitId) {
    const { data } = await this.http.get(`/units/${unitId}`);
    return data;
  }

  /** Return all vacant units (no active lease). */
  async getVacantUnits() {
    const { data } = await this.http.get('/units', { params: { vacant: true } });
    return data;
  }

  // ────────────────────────────────────────────────
  //  LEASES & TENANTS
  // ────────────────────────────────────────────────

  /** List leases with optional status filter (active | expired | future). */
  async getLeases(params = {}) {
    const { data } = await this.http.get('/leases', { params });
    return data;
  }

  /** Get a single lease by ID. */
  async getLease(leaseId) {
    const { data } = await this.http.get(`/leases/${leaseId}`);
    return data;
  }

  /** List all tenant contacts. */
  async getTenants(params = {}) {
    const { data } = await this.http.get('/tenants', { params });
    return data;
  }

  /** Get a single tenant by ID. */
  async getTenant(tenantId) {
    const { data } = await this.http.get(`/tenants/${tenantId}`);
    return data;
  }

  // ────────────────────────────────────────────────
  //  FINANCIALS
  // ────────────────────────────────────────────────

  /**
   * Retrieve outstanding (unpaid) balances across the entire portfolio.
   * Returns an array of { leaseId, tenantName, unitName, amountDue, daysOverdue }.
   */
  async getOutstandingBalances(params = {}) {
    const { data } = await this.http.get('/rentals/outstandingbalances', { params });
    return data;
  }

  /** Get the full ledger (all transactions) for a specific lease. */
  async getLeaseLedger(leaseId, params = {}) {
    const { data } = await this.http.get(`/leases/${leaseId}/ledger`, { params });
    return data;
  }

  /**
   * Aggregate general-ledger transactions for a date range.
   * Used for weekly financial summary reports.
   */
  async getGeneralLedger(params = {}) {
    const { data } = await this.http.get('/accounting/generalledger', { params });
    return data;
  }

  /** Retrieve all payments recorded in a given period. */
  async getPayments(params = {}) {
    const { data } = await this.http.get('/payments', { params });
    return data;
  }

  // ────────────────────────────────────────────────
  //  MAINTENANCE / WORK ORDERS
  // ────────────────────────────────────────────────

  /**
   * List work orders.
   * @param {Object} params – e.g. { status: 'open', propertyId: '123' }
   */
  async getWorkOrders(params = {}) {
    const { data } = await this.http.get('/workorders', { params });
    return data;
  }

  /** Get a single work order by ID. */
  async getWorkOrder(workOrderId) {
    const { data } = await this.http.get(`/workorders/${workOrderId}`);
    return data;
  }

  /**
   * Return open work orders older than `ageHours` hours.
   * Used by the proactive maintenance-alert scheduler.
   */
  async getStaleWorkOrders(ageHours = 48) {
    const cutoff = new Date(Date.now() - ageHours * 60 * 60 * 1000).toISOString();
    const { data } = await this.http.get('/workorders', {
      params: { status: 'open', createdBefore: cutoff },
    });
    return data;
  }

  /** Update the status or notes on a work order. */
  async updateWorkOrder(workOrderId, payload) {
    const { data } = await this.http.patch(`/workorders/${workOrderId}`, payload);
    return data;
  }

  // ────────────────────────────────────────────────
  //  COMMUNICATIONS / SMS (native DoorLoop SMS)
  // ────────────────────────────────────────────────

  /**
   * Send an SMS to a tenant via DoorLoop's Communications Center.
   * @param {string} tenantId – DoorLoop tenant ID
   * @param {string} message  – Plain-text message body (< 160 chars recommended)
   */
  async sendSMS(tenantId, message) {
    const { data } = await this.http.post('/communications/sms', {
      tenantId,
      message,
    });
    logger.info('DoorLoop SMS sent', { tenantId, messageSnippet: message.slice(0, 60) });
    return data;
  }

  /**
   * Send an SMS to a tenant identified by their phone number directly.
   * Falls back to this when no tenantId is available.
   */
  async sendSMSToPhone(phoneNumber, message) {
    const { data } = await this.http.post('/communications/sms', {
      to: phoneNumber,
      message,
    });
    logger.info('DoorLoop SMS sent to phone', { phoneNumber, messageSnippet: message.slice(0, 60) });
    return data;
  }
}

module.exports = DoorLoopClient;
