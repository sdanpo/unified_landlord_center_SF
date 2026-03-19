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
  // ── Hemlane-replacement tools ──────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_lease_renewals',
      description:
        'List active leases expiring within the specified number of days.  ' +
        'Use when the landlord asks which leases are expiring soon, ' +
        'or wants a renewal pipeline overview.',
      parameters: {
        type: 'object',
        properties: {
          daysAhead: {
            type: 'number',
            description: 'How many days ahead to look.  Defaults to 90.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_vendors',
      description:
        'List vendors / contractors in the portfolio directory.  ' +
        'Use when the landlord asks who the plumbers are, wants a vendor list, ' +
        'or needs to find a contractor for a trade.',
      parameters: {
        type: 'object',
        properties: {
          trade: {
            type: 'string',
            enum: ['Plumbing', 'Electrical', 'HVAC', 'Painting', 'Carpentry', 'Landscaping', 'Pest Control', 'General'],
            description: 'Optional: filter by vendor trade / specialty.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'assign_vendor',
      description:
        'Assign a vendor / contractor to an open maintenance work order (HD Ticket) ' +
        'and send them an SMS notification.  ' +
        'Use when the landlord says "assign [vendor] to ticket [ID]".',
      parameters: {
        type: 'object',
        properties: {
          ticketName: {
            type: 'string',
            description: 'HD Ticket document name (e.g. "HD-TICKET-0042").',
          },
          vendorName: {
            type: 'string',
            description: 'ERPNext Supplier name (e.g. "MA Inc.").',
          },
        },
        required: ['ticketName', 'vendorName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_lease_for_signature',
      description:
        'Send a lease or renewal agreement to a tenant for e-signature via BoldSign. ' +
        'Pre-fills the PDF template with all lease data (parties, address, dates, rent, deposit) ' +
        'and requests signatures from both the tenant and the landlord. ' +
        'The correct state template (OH/NC) is chosen automatically from the property record. ' +
        'Use when the landlord says "send lease to [name]" or "send renewal to [name]".',
      parameters: {
        type: 'object',
        properties: {
          tenantName: {
            type: 'string',
            description: 'Full or partial ERPNext Customer name of the tenant.',
          },
          doc_type: {
            type: 'string',
            enum: ['Lease', 'Renewal'],
            description: 'Document type to send. "Lease" for a new lease agreement, "Renewal" for a renewal. Defaults to "Lease".',
          },
        },
        required: ['tenantName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_screening_invite',
      description:
        'Send a TransUnion SmartMove tenant screening invitation to a rental applicant.  ' +
        'The applicant pays the screening fee directly; the landlord receives the report.  ' +
        'Use when the landlord says "screen [applicant]".',
      parameters: {
        type: 'object',
        properties: {
          leadName: {
            type: 'string',
            description: 'ERPNext Lead document name of the applicant.',
          },
          reportType: {
            type: 'string',
            enum: ['basic', 'standard', 'premium'],
            description: 'SmartMove report tier.  Defaults to "standard".',
          },
        },
        required: ['leadName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_applicants',
      description:
        'List rental applicants from the application pipeline.  ' +
        'Use when the landlord asks about pending applications, ' +
        'who has applied, or the status of screening.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Optional: filter by Lead status (e.g. "New Application", "Screened", "Approved").',
          },
        },
        required: [],
      },
    },
  },
];

module.exports = tools;
