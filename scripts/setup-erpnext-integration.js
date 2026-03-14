'use strict';

/**
 * setup-erpnext-integration.js
 *
 * Migrates the notification and scheduling logic that previously lived in
 * the Node.js server into ERPNext itself, so the server is only responsible
 * for the Telegram AI bot and OpenAI agentic loop.
 *
 * What this script creates in ERPNext:
 *
 *  1. "Property Management Settings" – a Custom Single DocType that stores
 *     Telegram and Twilio credentials, readable by all Server Scripts.
 *
 *  2. DocType Event Server Scripts (fire when documents are created/updated):
 *     • HD Ticket  after_insert   → Telegram: new maintenance request
 *     • HD Ticket  on_update      → Telegram: ticket resolved/closed
 *     • Sales Invoice  on_submit  → Telegram + SMS: overdue rent alert
 *     • Payment Entry  on_submit  → Telegram: payment received
 *     • Lease  after_insert       → Telegram: new lease created
 *     • Lease  on_update          → Telegram: lease status changed (terminal)
 *     • Maintenance Visit  after_insert  → Telegram: visit scheduled
 *
 *  3. Scheduled Job Server Scripts:
 *     • Daily   – overdue rent check: SMS tenants + Telegram summary
 *     • Daily   – stale work-order check: Telegram alert > 48 h open
 *     • Weekly  – property report: delinquencies + open WOs + expiring leases
 *
 * Usage:
 *   node scripts/setup-erpnext-integration.js
 *
 * Prerequisites:
 *   .env must contain: ERPNEXT_BASE_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET,
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS (first ID used as chat_id),
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *
 * Idempotent: existing scripts are updated rather than duplicated.
 */

require('dotenv').config();
const axios = require('axios');

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL    = (process.env.ERPNEXT_BASE_URL || '').replace(/\/$/, '');
const API_KEY     = process.env.ERPNEXT_API_KEY    || '';
const API_SECRET  = process.env.ERPNEXT_API_SECRET || '';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
// Use the first allowed user ID as the landlord chat ID for direct messages
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_ALLOWED_USER_IDS || '').split(',')[0]?.trim() || '';

const TWILIO_SID    = process.env.TWILIO_ACCOUNT_SID  || '';
const TWILIO_TOKEN  = process.env.TWILIO_AUTH_TOKEN    || '';
const TWILIO_FROM   = process.env.TWILIO_FROM_NUMBER   || '';

if (!BASE_URL || !API_KEY || !API_SECRET) {
  console.error('ERROR: ERPNEXT_BASE_URL, ERPNEXT_API_KEY, and ERPNEXT_API_SECRET are required.');
  process.exit(1);
}

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_IDS are required.');
  process.exit(1);
}

if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
  console.error('ERROR: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER are required.');
  process.exit(1);
}

const http = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `token ${API_KEY}:${API_SECRET}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  timeout: 20_000,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg, detail = '') {
  console.log(`  ${msg}${detail ? ': ' + detail : ''}`);
}

function ok(msg)   { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); }

async function apiGet(path) {
  const { data } = await http.get(path);
  return data;
}

async function apiPost(path, payload) {
  const { data } = await http.post(path, payload);
  return data;
}

async function apiPut(path, payload) {
  const { data } = await http.put(path, payload);
  return data;
}

/** Check whether a named resource exists (GET returns 200 with data). */
async function exists(path) {
  try {
    await apiGet(path);
    return true;
  } catch (err) {
    if (err.response?.status === 404) return false;
    throw err;
  }
}

// ─── Step 1: Property Management Settings DocType ─────────────────────────────

async function ensureSettingsDocType() {
  console.log('\n[1/3] Property Management Settings DocType');

  const doctypePath = '/api/resource/DocType/Property Management Settings';

  if (await exists(doctypePath)) {
    ok('DocType already exists – skipping creation');
  } else {
    log('Creating Custom Single DocType...');
    await apiPost('/api/resource/DocType', {
      doctype: 'DocType',
      name: 'Property Management Settings',
      module: 'Custom',
      custom: 1,
      is_single: 1,
      fields: [
        { fieldname: 'telegram_section', fieldtype: 'Section Break', label: 'Telegram' },
        { fieldname: 'telegram_bot_token', fieldtype: 'Password', label: 'Bot Token' },
        { fieldname: 'telegram_chat_id',   fieldtype: 'Data',     label: 'Landlord Chat ID' },
        { fieldname: 'twilio_section', fieldtype: 'Section Break', label: 'Twilio / SMS' },
        { fieldname: 'twilio_account_sid',  fieldtype: 'Data',     label: 'Account SID' },
        { fieldname: 'twilio_auth_token',   fieldtype: 'Password', label: 'Auth Token' },
        { fieldname: 'twilio_from_number',  fieldtype: 'Data',     label: 'From Number' },
      ],
    });
    ok('DocType created');
  }

  // Populate / update the values
  log('Writing credentials...');
  try {
    await apiPut(
      '/api/resource/Property Management Settings/Property Management Settings',
      {
        telegram_bot_token: TELEGRAM_BOT_TOKEN,
        telegram_chat_id:   TELEGRAM_CHAT_ID,
        twilio_account_sid: TWILIO_SID,
        twilio_auth_token:  TWILIO_TOKEN,
        twilio_from_number: TWILIO_FROM,
      }
    );
    ok('Credentials saved to Property Management Settings');
  } catch (err) {
    // The PUT may fail the first time because the table row doesn't exist yet.
    // Try a POST insert instead.
    await apiPost('/api/resource/Property Management Settings', {
      telegram_bot_token: TELEGRAM_BOT_TOKEN,
      telegram_chat_id:   TELEGRAM_CHAT_ID,
      twilio_account_sid: TWILIO_SID,
      twilio_auth_token:  TWILIO_TOKEN,
      twilio_from_number: TWILIO_FROM,
    });
    ok('Credentials created in Property Management Settings');
  }
}

// ─── Step 2: DocType Event Server Scripts ─────────────────────────────────────

/**
 * Upsert a Server Script by name.
 * If it already exists it is overwritten with the new payload.
 */
async function upsertScript(name, payload) {
  const path = `/api/resource/Server Script/${encodeURIComponent(name)}`;
  if (await exists(path)) {
    await apiPut(path, payload);
    ok(`Updated  – ${name}`);
  } else {
    await apiPost('/api/resource/Server Script', { name, ...payload });
    ok(`Created  – ${name}`);
  }
}

// Shared Python helper injected at the top of every script that needs to
// call Telegram.  Kept short to stay within ERPNext's script size limits.
const TELEGRAM_HELPER = `\
import requests as _req

def _tg(msg):
    s = frappe.get_single("Property Management Settings")
    if not s.telegram_bot_token or not s.telegram_chat_id:
        return
    try:
        _req.post(
            f"https://api.telegram.org/bot{s.telegram_bot_token}/sendMessage",
            json={"chat_id": s.telegram_chat_id, "text": msg, "parse_mode": "Markdown"},
            timeout=10
        )
    except Exception as _e:
        frappe.log_error(f"Telegram send failed: {_e}", "Property Management")
`;

const TWILIO_HELPER = `\
def _sms(to, body):
    s = frappe.get_single("Property Management Settings")
    if not s.twilio_account_sid or not to:
        return
    try:
        _req.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{s.twilio_account_sid}/Messages.json",
            data={"To": to, "From": s.twilio_from_number, "Body": body},
            auth=(s.twilio_account_sid, s.twilio_auth_token),
            timeout=10
        )
    except Exception as _e:
        frappe.log_error(f"Twilio SMS failed to {to}: {_e}", "Property Management")
`;

async function createDocTypeEventScripts() {
  console.log('\n[2/3] DocType Event Server Scripts');

  // ── 1. HD Ticket created ──────────────────────────────────────────────────
  await upsertScript('PM – HD Ticket Created', {
    script_type: 'DocType Event',
    dt: 'HD Ticket',
    doctype_event: 'After Insert',
    disabled: 0,
    script: `${TELEGRAM_HELPER}
msg = (
    f"🔧 *New Maintenance Request*\\n\\n"
    f"Ticket #: {doc.name}\\n"
    f"Tenant: {doc.customer or 'Unknown'}\\n"
    f"Priority: {doc.priority or 'Normal'}\\n"
    f"Issue: {doc.subject}"
)
_tg(msg)
`,
  });

  // ── 2. HD Ticket resolved / closed ────────────────────────────────────────
  await upsertScript('PM – HD Ticket Resolved', {
    script_type: 'DocType Event',
    dt: 'HD Ticket',
    doctype_event: 'On Update',
    condition: 'doc.status in ("Resolved", "Closed")',
    disabled: 0,
    script: `${TELEGRAM_HELPER}
msg = (
    f"✅ *Maintenance Ticket {doc.status}*\\n\\n"
    f"Ticket #: {doc.name}\\n"
    f"Tenant: {doc.customer or 'Unknown'}\\n"
    f"Issue: {doc.subject}"
)
_tg(msg)
`,
  });

  // ── 3. Sales Invoice submitted (overdue) ──────────────────────────────────
  await upsertScript('PM – Invoice Overdue Alert', {
    script_type: 'DocType Event',
    dt: 'Sales Invoice',
    doctype_event: 'On Submit',
    condition: 'doc.outstanding_amount > 0 and doc.due_date < frappe.utils.today()',
    disabled: 0,
    script: `${TELEGRAM_HELPER}
${TWILIO_HELPER}

# Look up tenant phone
tenant_phone = None
if doc.customer:
    try:
        customer = frappe.get_doc("Customer", doc.customer)
        tenant_phone = customer.mobile_no
    except Exception:
        pass

# SMS to tenant
if tenant_phone:
    sms_body = (
        f"Alert from Management: Your rent balance of ${doc.outstanding_amount} "
        f"for {doc.custom_unit or 'your unit'} is past due. "
        "Please remit payment or contact the office."
    )
    _sms(tenant_phone, sms_body)

# Telegram to landlord
msg = (
    f"🚨 *Rent Overdue Alert*\\n\\n"
    f"Tenant: {doc.customer_name} ({doc.custom_unit or 'N/A'})\\n"
    f"Amount Due: ${doc.outstanding_amount}\\n"
    f"Invoice: {doc.name}"
)
_tg(msg)
`,
  });

  // ── 4. Payment Entry submitted ────────────────────────────────────────────
  await upsertScript('PM – Payment Received', {
    script_type: 'DocType Event',
    dt: 'Payment Entry',
    doctype_event: 'On Submit',
    disabled: 0,
    script: `${TELEGRAM_HELPER}
msg = (
    f"✅ *Payment Received*\\n\\n"
    f"Tenant: {doc.party_name}\\n"
    f"Amount: ${doc.paid_amount}\\n"
    f"Method: {doc.mode_of_payment or 'Portal'}\\n"
    f"Unit: {doc.custom_unit or 'N/A'}"
)
_tg(msg)
`,
  });

  // ── 5. Lease created ──────────────────────────────────────────────────────
  await upsertScript('PM – Lease Created', {
    script_type: 'DocType Event',
    dt: 'Lease',
    doctype_event: 'After Insert',
    disabled: 0,
    script: `${TELEGRAM_HELPER}
tenant = doc.lease_customer or doc.tenant_name or "Unknown"
unit   = doc.property or "N/A"
msg = (
    f"📝 *New Lease Created*\\n\\n"
    f"Tenant: {tenant}\\n"
    f"Unit: {unit}\\n"
    f"Term: {doc.start_date} → {doc.end_date}\\n"
    f"Rent: ${doc.monthly_rent or ''}"
)
_tg(msg)
`,
  });

  // ── 6. Lease status changed to terminal ───────────────────────────────────
  await upsertScript('PM – Lease Status Changed', {
    script_type: 'DocType Event',
    dt: 'Lease',
    doctype_event: 'On Update',
    condition: 'doc.lease_status in ("Closed", "Not Materialized", "Vacating")',
    disabled: 0,
    script: `${TELEGRAM_HELPER}
tenant = doc.lease_customer or doc.tenant_name or "Unknown"
unit   = doc.property or "N/A"
msg = (
    f"⚠️ *Lease Status: {doc.lease_status}*\\n\\n"
    f"Tenant: {tenant}\\n"
    f"Unit: {unit}\\n"
    "Consider renewing or re-listing this unit."
)
_tg(msg)
`,
  });

  // ── 7. Maintenance Visit scheduled ────────────────────────────────────────
  await upsertScript('PM – Maintenance Visit Scheduled', {
    script_type: 'DocType Event',
    dt: 'Maintenance Visit',
    doctype_event: 'After Insert',
    disabled: 0,
    script: `${TELEGRAM_HELPER}
msg = (
    f"🔨 *Maintenance Visit Scheduled*\\n\\n"
    f"Visit #: {doc.name}\\n"
    f"Tenant: {doc.customer_name or 'N/A'}\\n"
    f"Unit: {doc.custom_unit or 'N/A'}\\n"
    f"Purpose: {doc.purpose or 'Maintenance'}\\n"
    f"Date: {doc.maintenance_date}"
)
_tg(msg)
`,
  });
}

// ─── Step 3: Scheduled Job Server Scripts ─────────────────────────────────────

async function createScheduledScripts() {
  console.log('\n[3/3] Scheduled Job Server Scripts');

  // ── A. Daily overdue rent check ───────────────────────────────────────────
  await upsertScript('PM – Daily Overdue Rent Check', {
    script_type: 'Scheduler Event',
    event_frequency: 'Daily',
    disabled: 0,
    script: `\
${TELEGRAM_HELPER}
${TWILIO_HELPER}
from frappe.utils import today as _today

overdue = frappe.db.get_list(
    "Sales Invoice",
    filters=[
        ["docstatus", "=", 1],
        ["outstanding_amount", ">", 0],
        ["due_date", "<", _today()],
    ],
    fields=["name", "customer", "customer_name", "outstanding_amount", "custom_unit"],
)

if not overdue:
    return

# SMS each delinquent tenant
for inv in overdue:
    cust_id = inv.get("customer")
    if not cust_id:
        continue
    try:
        cust = frappe.get_doc("Customer", cust_id)
        if cust.mobile_no:
            body = (
                "Alert from Management: Your rent balance of "
                f"${inv.get('outstanding_amount')} for "
                f"{inv.get('custom_unit') or 'your unit'} is past due. "
                "Please remit payment or contact the office."
            )
            _sms(cust.mobile_no, body)
    except Exception as _e:
        frappe.log_error(f"Overdue SMS failed – {cust_id}: {_e}", "Property Management")

# Telegram summary to landlord
lines = "\\n".join(
    f"• {i.get('customer_name')} ({i.get('custom_unit') or 'N/A'}): ${i.get('outstanding_amount')}"
    for i in overdue
)
_tg(f"🚨 *Daily Rent Delinquency*\\n\\n{len(overdue)} tenant(s) past due:\\n{lines}")
`,
  });

  // ── B. Daily stale work-order check ───────────────────────────────────────
  await upsertScript('PM – Daily Stale Work Order Check', {
    script_type: 'Scheduler Event',
    event_frequency: 'Daily',
    disabled: 0,
    script: `\
${TELEGRAM_HELPER}
from frappe.utils import now_datetime as _now, add_to_date as _add

cutoff = _add(_now(), hours=-48)

tickets = frappe.db.get_list(
    "HD Ticket",
    filters=[["status", "in", ["Open", "Replied"]]],
    fields=["name", "subject", "priority", "status", "creation"],
)

stale = [t for t in tickets if t.get("creation") and t["creation"] < cutoff]

if not stale:
    return

lines = "\\n\\n".join(
    f"• Ticket #{t['name']}\\n"
    f"  Issue: {t.get('subject') or 'N/A'}\\n"
    f"  Priority: {t.get('priority') or 'Normal'}"
    for t in stale
)
_tg(f"⚠️ *Stale Maintenance Tickets*\\n\\n{len(stale)} ticket(s) open > 48h:\\n\\n{lines}")
`,
  });

  // ── C. Weekly property report ─────────────────────────────────────────────
  await upsertScript('PM – Weekly Property Report', {
    script_type: 'Scheduler Event',
    event_frequency: 'Weekly',
    disabled: 0,
    script: `\
${TELEGRAM_HELPER}
from frappe.utils import today as _today, add_days as _add_days

today_str = _today()
sixty_days = _add_days(today_str, 60)

overdue = frappe.db.get_list(
    "Sales Invoice",
    filters=[["docstatus", "=", 1], ["outstanding_amount", ">", 0], ["due_date", "<", today_str]],
    fields=["customer_name", "outstanding_amount", "custom_unit"],
)

open_tickets = frappe.db.get_list(
    "HD Ticket",
    filters=[["status", "in", ["Open", "Replied"]]],
    fields=["name", "subject", "priority"],
)

# Active leases expiring in the next 60 days
all_leases = frappe.db.get_list(
    "Lease",
    filters=[["lease_status", "=", "Active"]],
    fields=["lease_customer", "property", "end_date"],
)
expiring = [
    l for l in all_leases
    if l.get("end_date") and today_str <= str(l["end_date"]) <= sixty_days
]

lines = ["📊 *Weekly Property Report*\\n"]

lines.append(f"🚨 *Delinquencies* ({len(overdue)})")
if overdue:
    for i in overdue:
        lines.append(f"• {i.get('customer_name')} ({i.get('custom_unit') or 'N/A'}): ${i.get('outstanding_amount')}")
else:
    lines.append("• All rents current ✅")
lines.append("")

lines.append(f"🔧 *Open Work Orders* ({len(open_tickets)})")
if open_tickets:
    for t in open_tickets[:10]:
        lines.append(f"• #{t['name']}: {t.get('subject') or 'N/A'} [{t.get('priority') or 'Normal'}]")
    if len(open_tickets) > 10:
        lines.append(f"  …and {len(open_tickets) - 10} more")
else:
    lines.append("• No open tickets ✅")
lines.append("")

lines.append(f"📋 *Leases Expiring (60 days)* ({len(expiring)})")
if expiring:
    for l in expiring:
        lines.append(f"• {l.get('lease_customer')} ({l.get('property') or 'N/A'}): expires {l.get('end_date')}")
else:
    lines.append("• No leases expiring soon ✅")

_tg("\\n".join(lines))
`,
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log(' ERPNext Integration Setup');
  console.log(`  Target: ${BASE_URL}`);
  console.log('='.repeat(60));

  try {
    await ensureSettingsDocType();
    await createDocTypeEventScripts();
    await createScheduledScripts();

    console.log('\n' + '='.repeat(60));
    console.log(' ✓  Setup complete');
    console.log('='.repeat(60));
    console.log(`
Next steps:
  1. Go to ${BASE_URL}/app/property-management-settings
     and verify your Telegram + Twilio credentials are saved.

  2. The ERPNext webhooks pointing to your Node.js server
     (Settings → Integrations → Webhooks) are no longer needed.
     You can disable or delete them — ERPNext will now handle
     notifications directly via the Server Scripts created above.

  3. The Node.js server now only runs the Telegram AI bot.
     You no longer need TWILIO_*, WEBHOOK_SECRET, or REPORT_DELIVERY
     environment variables on the server.
`);
  } catch (err) {
    console.error('\nSetup failed:', err.response?.data || err.message);
    process.exit(1);
  }
}

main();
