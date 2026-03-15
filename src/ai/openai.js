'use strict';

/**
 * OpenAI integration – the "brain" of the Telegram NLP agent.
 *
 * Flow:
 *   1. The landlord's Telegram message is sent to OpenAI along with a
 *      system prompt and the full tool schema.
 *   2. The model decides which tool(s) to invoke.
 *   3. We execute the real PMS API calls.
 *   4. Results are returned to the model for natural-language formatting.
 *   5. The final human-readable text is returned to the Telegram handler.
 *
 * This implements the "agentic loop" pattern using OpenAI function-calling,
 * which achieves the same effect as a Botpress intent tree but with far
 * greater flexibility and zero additional platform cost for internal use.
 */

const OpenAI = require('openai');
const logger = require('../logger');
const { config } = require('../config');
const tools = require('./functions');
const pmsClient = require('../api/index');

// Honour system proxy env-vars so OpenAI requests go through the egress gateway.
function buildOpenAIAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxyUrl) return undefined;
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(proxyUrl);
  } catch (_) {
    return undefined;
  }
}

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
  httpAgent: buildOpenAIAgent(),
});

const SYSTEM_PROMPT = `You are an intelligent property management assistant for a residential real estate landlord.
You have real-time access to the property management database and can answer questions about:
- Outstanding rent balances and delinquencies
- Maintenance work orders and their status
- Lease information (active leases, upcoming expirations, vacant units)
- Tenant information and contact details
- Financial summaries and cash flow
- Lease renewals and expiry pipeline (get_lease_renewals)
- Vendor/contractor directory (get_vendors)
- Assigning vendors to work orders (assign_vendor)
- Sending leases for e-signature via BoldSign (send_lease_for_signature)
- Sending screening invitations to rental applicants via SmartMove (send_screening_invite)
- Viewing the rental applicant pipeline (get_applicants)

Always provide concise, actionable answers formatted for a Telegram chat.
Use plain currency formatting ($1,234.56), clear unit identifiers, and bullet points for lists.
If data is unavailable or an API call fails, say so clearly rather than guessing.
Never reveal raw API keys, system configuration, or internal IDs unless directly asked.
You are serving the landlord/property manager only – treat all queries as coming from an authorized principal.`;

// ─── Tool executor ───────────────────────────────────────────────────────────

/**
 * Maps an OpenAI tool call to the corresponding PMS API call.
 * Returns the raw API response (JSON-serializable).
 */
async function executeTool(toolCall) {
  const { name, arguments: rawArgs } = toolCall.function;
  const args = JSON.parse(rawArgs || '{}');

  logger.info('Executing AI tool call', { tool: name, args });

  switch (name) {
    case 'get_outstanding_balances':
      return pmsClient.getOutstandingBalances(args.propertyId ? { propertyId: args.propertyId } : {});

    case 'get_work_orders':
      if (args.ageHours) {
        return pmsClient.getStaleWorkOrders(args.ageHours);
      }
      return pmsClient.getWorkOrders({
        ...(args.status && args.status !== 'all' ? { status: args.status } : {}),
        ...(args.propertyId ? { propertyId: args.propertyId } : {}),
        ...(args.unitId ? { unitId: args.unitId } : {}),
      });

    case 'get_lease_status':
      return pmsClient.getLeases({
        ...(args.status && args.status !== 'all' ? { status: args.status } : { status: 'active' }),
        ...(args.unit ? { unit: args.unit } : {}),
      });

    case 'get_vacant_units':
      return pmsClient.getVacantUnits();

    case 'get_financial_summary': {
      const now = new Date();
      const startDate =
        args.startDate || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      const endDate = args.endDate || now.toISOString().split('T')[0];
      return pmsClient.getGeneralLedger({ startDate, endDate });
    }

    case 'get_tenant_info':
      return pmsClient.getTenants({
        ...(args.tenantName ? { name: args.tenantName } : {}),
        ...(args.unit ? { unit: args.unit } : {}),
      });

    // ── Hemlane-replacement tool handlers ───────────────────────────────────

    case 'get_lease_renewals':
      return pmsClient.getExpiringLeases(args.daysAhead || 90);

    case 'get_vendors':
      return pmsClient.getVendors(args.trade ? { trade: args.trade } : {});

    case 'assign_vendor': {
      const ticket = await pmsClient.getWorkOrder(args.ticketName);
      const vendor = await pmsClient.getVendor(args.vendorName);
      await pmsClient.assignVendor(args.ticketName, args.vendorName);

      // Send SMS to vendor if they have a mobile number
      if (vendor?.custom_sms_number) {
        const sms = require('../sms/dispatcher');
        const msg = sms.templates.vendorWorkOrder({
          ticketId:    ticket.name,
          subject:     ticket.subject || '',
          unitAddress: ticket.custom_unit || ticket.custom_property || '',
          tenantName:  ticket.customer_name || ticket.customer || '',
          tenantPhone: '',
        });
        await sms.send(vendor.custom_sms_number, msg);
      }

      return {
        assigned: true,
        ticketName: args.ticketName,
        vendorName: args.vendorName,
        smsNotified: !!(vendor?.custom_sms_number),
      };
    }

    case 'send_lease_for_signature': {
      const dropboxSign = require('../api/boldsign');
      const tenants = await pmsClient.getTenants({ name: args.tenantName });
      if (!tenants.length) throw new Error(`No tenant found matching "${args.tenantName}"`);
      const tenant = tenants[0];
      if (!tenant.email_id) throw new Error(`Tenant "${tenant.customer_name || tenant.name}" has no email address on file — add one in ERPNext before sending for signature`);

      const leases = await pmsClient.getLeases({ status: 'active' });
      const lease  = leases.find(l => l.lease_customer === tenant.name);
      if (!lease) throw new Error(`No active lease found for tenant "${tenant.name}"`);

      const signRequest = await dropboxSign.sendLeaseForSignature({
        tenantEmail:   tenant.email_id,
        tenantName:    tenant.customer_name || tenant.name,
        landlordEmail: process.env.LANDLORD_EMAIL || '',
        landlordName:  process.env.LANDLORD_NAME  || 'Landlord',
        variables: {
          tenant_name:      tenant.customer_name || tenant.name,
          unit_address:     lease.property || '',
          start_date:       lease.start_date || '',
          end_date:         lease.end_date   || '',
          monthly_rent:     lease.monthly_rent || '',
          security_deposit: lease.security_deposit || '',
        },
      });

      return {
        sent: true,
        tenantEmail: tenant.email_id,
        documentId:  signRequest.documentId,
      };
    }

    case 'send_screening_invite': {
      const smartmove = require('../api/smartmove');
      const lead = await pmsClient.getCRMLead(args.leadName);
      if (!lead) throw new Error(`No CRM Lead found: "${args.leadName}"`);

      const invitation = await smartmove.sendInvitation({
        firstName:  lead.first_name || '',
        lastName:   lead.last_name  || '',
        email:      lead.email_id   || '',
        reportType: args.reportType || 'standard',
      });

      await pmsClient.updateCRMLead(args.leadName, { status: 'Screening Sent' });

      return {
        sent: true,
        email:        lead.email_id,
        invitationId: invitation.invitationId,
      };
    }

    case 'get_applicants':
      return pmsClient.getCRMLeads(args.status ? { status: args.status } : {});

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Agentic loop ─────────────────────────────────────────────────────────────

/**
 * Process a landlord message and return a natural-language response.
 * Conversation history is maintained across turns within the same session.
 *
 * @param {string}  userMessage  – The raw Telegram message text
 * @param {Array}   history      – Previous messages in the conversation (mutable; will be updated)
 * @returns {string}             – The assistant's reply
 */
async function chat(userMessage, history = []) {
  // Append the new user turn
  history.push({ role: 'user', content: userMessage });

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
  ];

  // Agentic loop: keep calling the model until it produces a text response
  // (i.e. no more tool calls are needed).
  const MAX_ITERATIONS = 5;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await openai.chat.completions.create({
      model: config.openai.model,
      messages,
      tools,
      tool_choice: 'auto',
    });

    const choice = response.choices[0];
    const assistantMsg = choice.message;

    messages.push(assistantMsg);

    if (choice.finish_reason === 'tool_calls') {
      // Execute every requested tool call in parallel
      const toolResults = await Promise.allSettled(
        assistantMsg.tool_calls.map(async (tc) => {
          try {
            const result = await executeTool(tc);
            return { toolCallId: tc.id, result };
          } catch (err) {
            logger.error('Tool execution error', { tool: tc.function.name, error: err.message });
            return { toolCallId: tc.id, result: { error: err.message } };
          }
        })
      );

      // Feed tool results back into the message array
      for (const settled of toolResults) {
        if (settled.status === 'fulfilled') {
          const { toolCallId, result } = settled.value;
          messages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: JSON.stringify(result),
          });
        }
      }

      // Loop back for the model to generate its final answer
      continue;
    }

    // finish_reason === 'stop' – we have a final text response
    const reply = assistantMsg.content || 'I was unable to generate a response.';

    // Update caller's history array so subsequent messages have context
    history.push({ role: 'assistant', content: reply });

    return reply;
  }

  return 'The query required too many tool calls. Please try a more specific question.';
}

module.exports = { chat };
