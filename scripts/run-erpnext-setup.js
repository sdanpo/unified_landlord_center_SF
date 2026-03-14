'use strict';
/**
 * run-erpnext-setup.js
 *
 * Creates / updates the ERPNext Server Scripts used for:
 *   - Tenant SMS on overdue invoice submit
 *   - Daily overdue rent batch check (SMS tenants + Telegram summary)
 *   - Daily stale work-order alert (Telegram)
 *   - Weekly property report (Telegram)
 *
 * All other notifications (new ticket, payment received, lease events, etc.)
 * are handled by native Telegram Notification rules which were configured
 * once via the API and are stored in ERPNext.
 *
 * Usage (idempotent – safe to run multiple times):
 *   node scripts/run-erpnext-setup.js
 */
require('dotenv').config();
const axios = require('axios');

const BASE = (process.env.ERPNEXT_BASE_URL || '').replace(/\/$/, '');
const KEY  = process.env.ERPNEXT_API_KEY;
const SEC  = process.env.ERPNEXT_API_SECRET;

const http = axios.create({
  baseURL: BASE,
  headers: { Authorization: `token ${KEY}:${SEC}`, 'Content-Type': 'application/json' },
  timeout: 30_000,
  maxRedirects: 0,  // Frappe cloud uses redirects; handle manually
});

async function upsert(type, name, payload) {
  const enc = encodeURIComponent(name);
  // Use axios with full redirect following for GETs via a separate instance
  const fullHttp = axios.create({
    baseURL: BASE,
    headers: { Authorization: `token ${KEY}:${SEC}`, 'Content-Type': 'application/json' },
    timeout: 30_000,
  });
  try {
    await fullHttp.get(`/api/resource/${type}/${enc}`);
    // Exists — update it
    await fullHttp.put(`/api/resource/${type}/${enc}`, payload);
    console.log(`  ↺ Updated  ${type}: ${name}`);
  } catch (e) {
    if (e.response?.status === 404) {
      await fullHttp.post(`/api/resource/${type}`, { name, ...payload });
      console.log(`  + Created  ${type}: ${name}`);
    } else throw e;
  }
}

// ── Shared Python helpers embedded in scheduled scripts ─────────────────────

const TELEGRAM_HELPER = `
def _send_telegram(msg):
    import requests as _r
    try:
        tg = frappe.get_doc("Telegram Settings", "Property Management")
        tu = frappe.get_doc("Telegram User Settings", "dan.porat@gmail.com-Property Management")
        if tg.telegram_token and tu.telegram_chat_id:
            _r.post(
                "https://api.telegram.org/bot" + tg.telegram_token + "/sendMessage",
                json={"chat_id": tu.telegram_chat_id, "text": msg, "parse_mode": "Markdown"},
                timeout=10,
            )
    except Exception as _e:
        frappe.log_error("Telegram send failed: " + str(_e), "Property Management")
`;

const SMS_HELPER = `
def _send_sms(phone, msg):
    try:
        from frappe.core.doctype.sms_settings.sms_settings import send_sms
        send_sms(receiver_list=[phone], msg=msg)
    except Exception as _e:
        frappe.log_error("SMS failed: " + str(_e), "Property Management")
`;

// ── Server Scripts ───────────────────────────────────────────────────────────

const scripts = [
  // ── Tenant SMS when a Sales Invoice is overdue on submit ──────────────────
  {
    type: 'Server Script',
    name: 'PM - Invoice Overdue Tenant SMS',
    payload: {
      script_type: 'DocType Event',
      reference_doctype: 'Sales Invoice',
      doctype_event: 'After Submit',
      disabled: 0,
      script: `
${SMS_HELPER}
if not (doc.outstanding_amount and doc.outstanding_amount > 0):
    return
if not doc.customer:
    return
try:
    cust = frappe.get_doc("Customer", doc.customer)
    phone = getattr(cust, "mobile_no", None)
    if phone:
        msg = (
            "Alert from Management: Your rent balance of $"
            + str(doc.outstanding_amount)
            + " for " + (doc.custom_unit or "your unit")
            + " is past due. Please remit payment or contact the office."
        )
        _send_sms(phone, msg)
except Exception as e:
    frappe.log_error("Invoice SMS failed: " + str(e), "Property Management")
`,
    },
  },

  // ── Daily: overdue rent batch check ───────────────────────────────────────
  {
    type: 'Server Script',
    name: 'PM - Daily Overdue Rent Check',
    payload: {
      script_type: 'Scheduler Event',
      event_frequency: 'Daily',
      disabled: 0,
      script: `
${TELEGRAM_HELPER}
${SMS_HELPER}
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

for inv in overdue:
    cid = inv.get("customer")
    if not cid:
        continue
    try:
        cust = frappe.get_doc("Customer", cid)
        phone = getattr(cust, "mobile_no", None)
        if phone:
            body = (
                "Alert from Management: Your rent balance of $"
                + str(inv.get("outstanding_amount"))
                + " for " + (inv.get("custom_unit") or "your unit")
                + " is past due. Please contact the office."
            )
            _send_sms(phone, body)
    except Exception as e:
        frappe.log_error("Daily overdue SMS failed: " + str(e), "Property Management")

lines = "\\n".join(
    "\\u2022 " + (i.get("customer_name") or "") + " (" + (i.get("custom_unit") or "N/A") + "): $" + str(i.get("outstanding_amount") or 0)
    for i in overdue
)
_send_telegram("\\U0001f6a8 *Daily Overdue Rent Check*\\n\\n" + str(len(overdue)) + " tenant(s) past due:\\n" + lines)
`,
    },
  },

  // ── Daily: stale work-order alert (open > 48 h) ───────────────────────────
  {
    type: 'Server Script',
    name: 'PM - Daily Stale Work Order Check',
    payload: {
      script_type: 'Scheduler Event',
      event_frequency: 'Daily',
      disabled: 0,
      script: `
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
    "\\u2022 Ticket #" + t["name"] + "\\n"
    + "  Issue: " + (t.get("subject") or "N/A") + "\\n"
    + "  Priority: " + (t.get("priority") or "Normal")
    for t in stale
)
_send_telegram("\\u26a0\\ufe0f *Stale Maintenance Tickets*\\n\\n" + str(len(stale)) + " ticket(s) open > 48h:\\n\\n" + lines)
`,
    },
  },

  // ── Weekly: property report ────────────────────────────────────────────────
  {
    type: 'Server Script',
    name: 'PM - Weekly Property Report',
    payload: {
      script_type: 'Scheduler Event',
      event_frequency: 'Weekly',
      disabled: 0,
      script: `
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

all_leases = frappe.db.get_list(
    "Lease",
    filters=[["lease_status", "=", "Active"]],
    fields=["lease_customer", "property", "end_date"],
)
expiring = [
    l for l in all_leases
    if l.get("end_date") and today_str <= str(l["end_date"]) <= sixty_days
]

lines = ["\\U0001f4ca *Weekly Property Report*\\n"]

lines.append("\\U0001f6a8 *Delinquencies* (" + str(len(overdue)) + ")")
if overdue:
    for i in overdue:
        lines.append("\\u2022 " + (i.get("customer_name") or "") + " (" + (i.get("custom_unit") or "N/A") + "): $" + str(i.get("outstanding_amount") or 0))
else:
    lines.append("\\u2022 All rents current \\u2705")
lines.append("")

lines.append("\\U0001f527 *Open Work Orders* (" + str(len(open_tickets)) + ")")
if open_tickets:
    for t in open_tickets[:10]:
        lines.append("\\u2022 #" + t["name"] + ": " + (t.get("subject") or "N/A") + " [" + (t.get("priority") or "Normal") + "]")
    if len(open_tickets) > 10:
        lines.append("  \\u2026and " + str(len(open_tickets) - 10) + " more")
else:
    lines.append("\\u2022 No open tickets \\u2705")
lines.append("")

lines.append("\\U0001f4cb *Leases Expiring (60 days)* (" + str(len(expiring)) + ")")
if expiring:
    for l in expiring:
        lines.append("\\u2022 " + (l.get("lease_customer") or "") + " (" + (l.get("property") or "N/A") + "): expires " + str(l.get("end_date") or ""))
else:
    lines.append("\\u2022 No leases expiring soon \\u2705")

_send_telegram("\\n".join(lines))
`,
    },
  },
];

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nRunning ERPNext Server Script setup against ${BASE}\n`);

  for (const { type, name, payload } of scripts) {
    try {
      await upsert(type, name, payload);
    } catch (err) {
      const detail = err.response?.data?.exception || err.response?.data?._server_messages || err.message;
      console.error(`  ✗ FAILED  ${name}: ${String(detail).slice(0, 200)}`);
    }
  }

  console.log('\nDone.\n');
}

main().catch(console.error);
