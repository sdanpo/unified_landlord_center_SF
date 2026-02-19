'use strict';

/**
 * OpenAI tool definitions (function-calling schema).
 *
 * Each tool maps directly to a PMS API call.  When the landlord sends a
 * natural-language query, the OpenAI model decides which tool(s) to invoke,
 * we execute the real API call, and then pass the raw data back to the model
 * for natural-language formatting.
 */

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_outstanding_balances',
      description:
        'Retrieve all outstanding (unpaid) rent balances across the entire portfolio. ' +
        'Use this for questions about delinquent tenants, total money owed, or rent roll status.',
      parameters: {
        type: 'object',
        properties: {
          propertyId: {
            type: 'string',
            description: 'Optional: filter by a specific property ID.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_work_orders',
      description:
        'List maintenance work orders / tickets.  Use this when the landlord asks about ' +
        'repairs, maintenance requests, vendor status, or specific unit issues.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['open', 'in_progress', 'completed', 'all'],
            description: 'Filter by work order status.  Defaults to "all".',
          },
          propertyId: {
            type: 'string',
            description: 'Optional: filter by property ID.',
          },
          unitId: {
            type: 'string',
            description: 'Optional: filter by unit ID or address fragment.',
          },
          ageHours: {
            type: 'number',
            description:
              'If provided, return only work orders older than this many hours (stale tickets).',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_lease_status',
      description:
        'Retrieve lease information for the portfolio or a specific unit/tenant.  ' +
        'Useful for questions about lease expiration, rent amounts, or tenant details.',
      parameters: {
        type: 'object',
        properties: {
          unit: {
            type: 'string',
            description: 'Unit name or address fragment (e.g. "Unit 4B", "123 Maple").',
          },
          status: {
            type: 'string',
            enum: ['active', 'expired', 'future', 'all'],
            description: 'Filter by lease status.  Defaults to "active".',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_vacant_units',
      description:
        'List all units that currently have no active lease (vacant / available). ' +
        'Use when the landlord asks about vacancies.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_financial_summary',
      description:
        'Retrieve a cash-flow and rent-roll summary for a given date range.  ' +
        'Useful for questions about weekly income, expenses, or overall financial health.',
      parameters: {
        type: 'object',
        properties: {
          startDate: {
            type: 'string',
            description: 'ISO date string (YYYY-MM-DD).  Defaults to start of current month.',
          },
          endDate: {
            type: 'string',
            description: 'ISO date string (YYYY-MM-DD).  Defaults to today.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tenant_info',
      description:
        'Retrieve contact details, lease, and payment history for a specific tenant.  ' +
        'Use when the landlord asks about an individual tenant by name or unit.',
      parameters: {
        type: 'object',
        properties: {
          tenantName: {
            type: 'string',
            description: 'Full or partial tenant name.',
          },
          unit: {
            type: 'string',
            description: 'Unit identifier (e.g. "3A", "Unit 7").',
          },
        },
        required: [],
      },
    },
  },
];

module.exports = tools;
