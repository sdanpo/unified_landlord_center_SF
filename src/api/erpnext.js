'use strict';

/**
 * ERPNext REST API client (with navariltd/utility-billing app installed).
 *
 * Auth: token {apiKey}:{apiSecret} via Authorization header.
 *
 * All resource endpoints follow the pattern:
 *   GET  /api/resource/{DocType}             – list records
 *   GET  /api/resource/{DocType}/{name}      – get single record
 *   PUT  /api/resource/{DocType}/{name}      – update record
 *
 * Filters are JSON arrays of ["field", "operator", "value"] triplets.
 * Fields are JSON arrays of field names; ["*"] returns all fields.
 *
 * DocTypes used:
 *   Property          – a building / complex              (utility-billing)
 *   Property Unit     – an individual rentable space      (utility-billing)
 *   Lease             – a lease agreement                 (PropMS)
 *   Customer          – tenant contacts (customer_group = "Tenant")
 *   Sales Invoice     – rent charges and outstanding balances
 *   Payment Entry     – recorded payments
 *   GL Entry          – double-entry general ledger rows
 *   HD Ticket         – maintenance / work orders         (Helpdesk module)
 *
 * Custom fields added to standard DocTypes via utility-billing / site config:
 *   Sales Invoice     → custom_unit, custom_property, custom_lease (Link → Lease)
 *   Payment Entry     → custom_unit, custom_lease (Link → Lease)
 *   Customer          → custom_unit, custom_property
 *   HD Ticket         → custom_unit, custom_property
 */

const axios = require('axios');
const logger = require('../logger');
const { config } = require('../config');

class ERPNextClient {
  constructor({ baseUrl, apiKey, apiSecret } = {}) {
    const base = (baseUrl || config.pms.erpnext.baseUrl).replace(/\/$/, '');
    const key = apiKey || config.pms.erpnext.apiKey;
    const secret = apiSecret || config.pms.erpnext.apiSecret;

    this.http = axios.create({
      baseURL: base,
      headers: {
        // ERPNext token-based auth: "token api_key:api_secret"
        Authorization: `token ${key}:${secret}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 15_000,
    });

    this.http.interceptors.response.use(
      (res) => res,
      (err) => {
        const status = err.response?.status;
        const detail =
          err.response?.data?.exception ||
          err.response?.data?.message ||
          err.message;
        logger.error('ERPNext API error', { status, detail, url: err.config?.url });
        return Promise.reject(err);
      }
    );
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  /** Build the resource URL for a DocType, URL-encoding spaces in the name. */
  _resourcePath(doctype, name) {
    const dt = encodeURIComponent(doctype);
    return name
      ? `/api/resource/${dt}/${encodeURIComponent(name)}`
      : `/api/resource/${dt}`;
  }

  /**
   * Fetch a list of records.
   * @param {string}   doctype        – ERPNext DocType name
   * @param {string[]} fields         – Fields to return
   * @param {Array[]}  filters        – [field, op, value] filter triplets
   * @param {number}   limit          – Max records to return (default 500)
   * @param {string}   [orderBy]      – e.g. "creation desc"
   * @returns {Array}
   */
  async _list(doctype, { fields = ['*'], filters = [], limit = 500, orderBy } = {}) {
    const params = {
      fields: JSON.stringify(fields),
      filters: JSON.stringify(filters),
      limit_page_length: limit,
    };
    if (orderBy) params.order_by = orderBy;

    const { data } = await this.http.get(this._resourcePath(doctype), { params });
    return data.data || [];
  }

  /** Fetch a single document by its name (primary key). */
  async _get(doctype, name) {
    const { data } = await this.http.get(this._resourcePath(doctype, name));
    return data.data;
  }

  /** Update a document. ERPNext uses PUT for document updates. */
  async _put(doctype, name, payload) {
    const { data } = await this.http.put(this._resourcePath(doctype, name), payload);
    return data.data;
  }

  // ─── Properties & Units ───────────────────────────────────────────────────

  /** List all properties in the portfolio. */
  async getProperties() {
    return this._list('Property', {
      fields: ['name', 'property_name', 'address', 'total_units'],
      orderBy: 'property_name asc',
    });
  }

  /** Get a single property by its ERPNext name (e.g. "PROP-0001"). */
  async getProperty(name) {
    return this._get('Property', name);
  }

  /** List all units, optionally filtered by property. */
  async getUnits({ propertyId } = {}) {
    const filters = [];
    if (propertyId) filters.push(['property', '=', propertyId]);
    return this._list('Property Unit', {
      fields: ['name', 'unit_name', 'property', 'status', 'floor', 'rent_amount'],
      filters,
      orderBy: 'unit_name asc',
    });
  }

  /** Get a single unit by ERPNext name. */
  async getUnit(name) {
    return this._get('Property Unit', name);
  }

  /** Return all units with status "Vacant". */
  async getVacantUnits() {
    return this._list('Property Unit', {
      fields: ['name', 'unit_name', 'property', 'floor', 'rent_amount'],
      filters: [['status', '=', 'Vacant']],
      orderBy: 'unit_name asc',
    });
  }

  // ─── Leases & Tenants ─────────────────────────────────────────────────────

  /**
   * List Leases (leases).
   * @param {Object} params
   * @param {string} [params.status]  – "active" | "expired" | "future" | "all"
   * @param {string} [params.unit]    – Partial unit name to filter by
   */
  async getLeases({ status, unit } = {}) {
    const filters = [];
    if (status && status !== 'all') {
      const statusMap = { active: 'Active', expired: 'Expired', future: 'Draft' };
      filters.push(['status', '=', statusMap[status] || status]);
    }
    if (unit) filters.push(['property_unit', 'like', `%${unit}%`]);

    return this._list('Lease', {
      fields: [
        'name', 'tenant', 'tenant_name', 'property_unit', 'property',
        'start_date', 'end_date', 'monthly_rent', 'status',
      ],
      filters,
      orderBy: 'start_date desc',
    });
  }

  /** Get a single Lease by name. */
  async getLease(name) {
    return this._get('Lease', name);
  }

  /**
   * List tenants (Customers with customer_group = "Tenant").
   * @param {Object} params
   * @param {string} [params.name]  – Partial name search
   * @param {string} [params.unit]  – Filter by custom_unit field
   */
  async getTenants({ name, unit } = {}) {
    const filters = [['customer_group', '=', 'Tenant']];
    if (name) filters.push(['customer_name', 'like', `%${name}%`]);
    if (unit) filters.push(['custom_unit', 'like', `%${unit}%`]);

    return this._list('Customer', {
      fields: [
        'name', 'customer_name', 'mobile_no', 'email_id',
        'custom_unit', 'custom_property',
      ],
      filters,
      orderBy: 'customer_name asc',
    });
  }

  /** Get a single Customer (tenant) by ERPNext name. */
  async getTenant(name) {
    return this._get('Customer', name);
  }

  // ─── Financials ───────────────────────────────────────────────────────────

  /**
   * Return all submitted Sales Invoices with an outstanding balance past due.
   * The caller receives the raw invoice list; the AI formats it for display.
   * @param {Object} [params]
   * @param {string} [params.propertyId]  – Filter by custom_property
   */
  async getOutstandingBalances({ propertyId } = {}) {
    const today = new Date().toISOString().split('T')[0];
    const filters = [
      ['docstatus', '=', 1],             // submitted invoices only
      ['outstanding_amount', '>', 0],
      ['due_date', '<', today],
    ];
    if (propertyId) filters.push(['custom_property', '=', propertyId]);

    return this._list('Sales Invoice', {
      fields: [
        'name', 'customer', 'customer_name',
        'grand_total', 'outstanding_amount', 'due_date',
        'custom_unit', 'custom_property', 'custom_lease',
      ],
      filters,
      orderBy: 'due_date asc',
    });
  }

  /**
   * Get all submitted Sales Invoices tied to a specific Lease.
   * Used for per-lease ledger queries.
   */
  async getLeaseLedger(leaseId) {
    return this._list('Sales Invoice', {
      fields: ['name', 'posting_date', 'grand_total', 'outstanding_amount', 'status'],
      filters: [
        ['custom_lease', '=', leaseId],
        ['docstatus', '=', 1],
      ],
      orderBy: 'posting_date desc',
    });
  }

  /**
   * Retrieve GL Entry rows for a date range.
   * Used for weekly financial summary reports.
   * @param {Object} params
   * @param {string} [params.startDate]  – YYYY-MM-DD
   * @param {string} [params.endDate]    – YYYY-MM-DD
   */
  async getGeneralLedger({ startDate, endDate } = {}) {
    const filters = [];
    if (startDate) filters.push(['posting_date', '>=', startDate]);
    if (endDate) filters.push(['posting_date', '<=', endDate]);

    return this._list('GL Entry', {
      fields: [
        'name', 'posting_date', 'account',
        'debit', 'credit', 'voucher_type', 'voucher_no', 'remarks',
      ],
      filters,
      orderBy: 'posting_date desc',
    });
  }

  /**
   * Retrieve submitted Payment Entries for a date range.
   * @param {Object} params
   * @param {string} [params.startDate]  – YYYY-MM-DD
   * @param {string} [params.endDate]    – YYYY-MM-DD
   */
  async getPayments({ startDate, endDate } = {}) {
    const filters = [['docstatus', '=', 1]];
    if (startDate) filters.push(['posting_date', '>=', startDate]);
    if (endDate) filters.push(['posting_date', '<=', endDate]);

    return this._list('Payment Entry', {
      fields: [
        'name', 'posting_date', 'party', 'party_name',
        'paid_amount', 'payment_type', 'mode_of_payment',
        'custom_unit', 'custom_lease',
      ],
      filters,
      orderBy: 'posting_date desc',
    });
  }

  // ─── Maintenance / Work Orders (HD Ticket via Helpdesk module) ────────────

  /**
   * List maintenance tickets (HD Tickets).
   * @param {Object} params
   * @param {string} [params.status]     – "open" | "in_progress" | "completed" | "all"
   * @param {string} [params.propertyId] – Filter by custom_property
   * @param {string} [params.unitId]     – Partial unit name filter
   */
  async getWorkOrders({ status, propertyId, unitId } = {}) {
    const filters = [];
    if (status && status !== 'all') {
      // HD Ticket statuses: Open, Replied, Resolved, Closed
      const statusMap = { open: 'Open', in_progress: 'Replied', completed: 'Resolved' };
      filters.push(['status', '=', statusMap[status] || status]);
    }
    if (propertyId) filters.push(['custom_property', '=', propertyId]);
    if (unitId) filters.push(['custom_unit', 'like', `%${unitId}%`]);

    return this._list('HD Ticket', {
      fields: [
        'name', 'subject', 'status', 'priority',
        'customer', 'customer_name',
        'custom_unit', 'custom_property',
        'description', 'creation', 'modified',
      ],
      filters,
      orderBy: 'creation desc',
    });
  }

  /** Get a single HD Ticket by name (e.g. "HDT-0001"). */
  async getWorkOrder(name) {
    return this._get('HD Ticket', name);
  }

  /**
   * Return open/in-progress tickets older than `ageHours` hours.
   * Used by the proactive maintenance-alert scheduler.
   * @param {number} ageHours  – Tickets created more than this many hours ago
   */
  async getStaleWorkOrders(ageHours = 48) {
    const cutoff = new Date(Date.now() - ageHours * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .split('.')[0]; // "YYYY-MM-DD HH:MM:SS" – ERPNext datetime format

    return this._list('HD Ticket', {
      fields: [
        'name', 'subject', 'status', 'priority',
        'customer', 'customer_name',
        'custom_unit', 'custom_property',
        'description', 'creation',
      ],
      filters: [
        ['status', 'in', ['Open', 'Replied']],
        ['creation', '<', cutoff],
      ],
      orderBy: 'creation asc',
    });
  }

  /**
   * Update an HD Ticket (e.g. change status, add resolution notes).
   * @param {string} name     – ERPNext ticket name (e.g. "HDT-0001")
   * @param {Object} payload  – Fields to update (e.g. { status: "Resolved" })
   */
  async updateWorkOrder(name, payload) {
    return this._put('HD Ticket', name, payload);
  }
}

module.exports = ERPNextClient;
