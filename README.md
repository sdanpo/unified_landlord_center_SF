# Unified Landlord Center SF
## AI-Augmented Omnichannel Property Management System

A composable, low-code-ready backend that glues together an open-source property
management database (ERPNext + PropMS), a Telegram NLP agent for the landlord, and
automated SMS alerts for tenants via Twilio — all for roughly **$30–$80/month** in
operational costs.

---

## Architecture at a Glance

```
┌──────────────────────────────────────────────────────────────┐
│                    LANDLORD                                  │
│                      │                                       │
│          Telegram Bot (Telegram Bot API – free)              │
│                      │                                       │
│          ┌───────────▼──────────────┐                        │
│          │  OpenAI GPT-4o           │   (function-calling)   │
│          │  NLP / Agentic Loop      │                        │
│          └───────────┬──────────────┘                        │
│                      │                                       │
│          ┌───────────▼──────────────┐                        │
│          │  ERPNext REST Client     │   token auth           │
│          │  (PropMS app installed)  │   /api/resource/*      │
│          └───────────┬──────────────┘                        │
│                      │                                       │
│          ┌───────────▼──────────────────────────────┐        │
│          │           Make.com Middleware             │        │
│          │  Webhooks → SMS → Telegram Alerts        │        │
│          └───────────┬──────────────────────────────┘        │
│                      │                                       │
│          ┌───────────▼──────────────┐                        │
│          │       TENANTS            │   SMS via Twilio       │
│          └──────────────────────────┘                        │
└──────────────────────────────────────────────────────────────┘
```

### Communication channels
| Direction | Channel | Technology |
|---|---|---|
| Landlord → System | Natural language queries | Telegram Bot |
| System → Landlord | Proactive alerts + query replies | Telegram Bot |
| System → Tenant | Automated rent / maintenance notices | SMS (Twilio) |
| ERPNext → System | Real-time event delivery | Webhooks (HTTP POST) |

---

## Monthly Cost Model

| Category | Technology | Est. Monthly Cost |
|---|---|---|
| Core PMS | ERPNext + PropMS (self-hosted VPS) | ~$10–15 |
| *(alternative)* | Frappe Cloud managed ERPNext | ~$50 |
| Middleware | Make.com Pro | ~$16 |
| LLM Inference | OpenAI API (GPT-4o) | ~$5–10 |
| Automation / Conversational AI | This codebase (same VPS) | ~$0 |
| Telecom | Telegram (free) + Twilio SMS | ~$1–5 |
| **Total (self-hosted)** | | **~$30–50** |
| **Total (Frappe Cloud)** | | **~$75–85** |

---

## Repository Structure

```
src/
├── index.js                  Entry point – starts all services
├── config.js                 Centralised env-var configuration
├── logger.js                 Winston logger
├── api/
│   ├── index.js              ERPNext client singleton
│   └── erpnext.js            ERPNext REST API client (PropMS DocTypes)
├── webhook/
│   ├── server.js             Express webhook receiver (HMAC verified, 6 ERPNext routes)
│   └── handlers.js           Event dispatcher → SMS (Twilio) + Telegram
├── telegram/
│   ├── bot.js                Bot lifecycle + notifyLandlord()
│   ├── handlers.js           /start, /help, /clear, NLP handler
│   └── security.js           Telegram User ID whitelist guard
├── ai/
│   ├── openai.js             Agentic loop (function-calling)
│   └── functions.js          OpenAI tool schema definitions
├── sms/
│   └── dispatcher.js         Twilio SMS dispatch
└── automation/
    ├── scheduler.js           node-cron jobs
    └── reports.js             Weekly financial report generator

make-flows/
├── rent-overdue-flow.json     Make.com scenario – rent delinquency
├── maintenance-alert-flow.json Make.com scenario – stale work orders
└── weekly-report-flow.json    Make.com scenario – Friday report

tests/
├── setup.js                  Jest env-var bootstrap
├── api.test.js               ERPNext API client tests
├── webhook.test.js           Webhook server + handler tests
├── telegram.test.js          Security guard + message handler tests
├── scheduler.test.js         Cron job logic tests
└── sms.test.js               SMS dispatcher tests
```

---

## Quick Start

### 1. Prerequisites

- Node.js ≥ 18
- A running **ERPNext** instance (self-hosted or [Frappe Cloud](https://frappecloud.com))
  with the **[navariltd/utility-billing](https://github.com/navariltd/utility-billing)**
  Frappe app installed — this provides the `Rental Contract`, `Property`, and
  `Property Unit` DocTypes that the system depends on
- An ERPNext API key + secret generated under ERPNext → User → API Access
- [Telegram Bot](https://core.telegram.org/bots/tutorial) created via BotFather
- [OpenAI API key](https://platform.openai.com)
- [Twilio account](https://www.twilio.com) with a purchased phone number
- A publicly reachable HTTPS URL for webhook delivery (e.g. [ngrok](https://ngrok.com) for local dev)

### 2. Install

```bash
npm install
```

### 3. Configure

```bash
cp .env.example .env
# Edit .env with your real credentials
```

Key variables:

| Variable | Description |
|---|---|
| `ERPNEXT_BASE_URL` | Base URL of your ERPNext instance, e.g. `https://erpnext.example.com` |
| `ERPNEXT_API_KEY` | ERPNext API key (from User → API Access) |
| `ERPNEXT_API_SECRET` | ERPNext API secret |
| `TWILIO_ACCOUNT_SID` | Twilio account SID (`ACxxx...`) |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_FROM_NUMBER` | Twilio phone number in E.164 format (e.g. `+15550001234`) |
| `OPENAI_API_KEY` | OpenAI secret key |
| `TELEGRAM_BOT_TOKEN` | Token from BotFather |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated Telegram user IDs of landlord/managers |
| `WEBHOOK_SECRET` | Shared secret for HMAC webhook verification |
| `WEBHOOK_BASE_URL` | Public HTTPS URL of this server |

### 4. Add custom fields in ERPNext

These fields link standard DocTypes back to your property units and leases.

> **Important:** The `custom_lease` fields use field type **Link → Rental Contract**.
> ERPNext validates that the linked DocType exists when saving the field, and will
> reject it with *"Options must be a valid DocType for field lease"* if the
> `navariltd/utility-billing` app is not yet installed.  Complete step 1
> (install the app) before creating these fields.

**Option A — automated (recommended):** run the provided setup script:

```bash
node scripts/setup-erpnext-fields.js
```

The script checks the prerequisite, creates all fields in one pass, and skips
any that already exist.

**Option B — manual** via ERPNext → Customize Form:

| DocType | Field name | Field type | Notes |
|---|---|---|---|
| Sales Invoice | `custom_unit` | Data | |
| Sales Invoice | `custom_property` | Data | |
| Sales Invoice | `custom_lease` | Link → `Rental Contract` | Requires utility-billing app |
| Payment Entry | `custom_unit` | Data | |
| Payment Entry | `custom_lease` | Link → `Rental Contract` | Requires utility-billing app |
| HD Ticket | `custom_unit` | Data | |
| HD Ticket | `custom_property` | Data | |

### 5. Configure webhooks in ERPNext

In ERPNext → Integrations → Webhooks, create **6 webhooks** all using
`WEBHOOK_SECRET` as the shared secret:

| DocType | Trigger | URL |
|---|---|---|
| Sales Invoice | `on_submit` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/invoice-overdue` |
| Payment Entry | `on_submit` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/payment-received` |
| Maintenance Request | `after_insert` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/ticket-created` |
| Maintenance Request | `on_update` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/ticket-updated` |
| Rental Contract | `on_submit` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/contract-submitted` |
| Rental Contract | `on_cancel` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/contract-cancelled` |

> **Sales Invoice condition:** Set the ERPNext webhook Condition to
> `doc.outstanding_amount > 0 and doc.due_date < frappe.utils.today()`
> so it only fires for genuinely overdue invoices.

### 6. Run

```bash
# Development (auto-restart on change)
npm run dev

# Production
npm start
```

### 7. Test

```bash
npm test
```

---

## Make.com Integration

The `make-flows/` directory contains three importable Make.com scenario
configurations that implement the middleware automation layer described in the
PRD. These complement (or replace) the built-in Node.js scheduler when a
no-code visual editor is preferred.

| Flow file | Trigger | Actions |
|---|---|---|
| `rent-overdue-flow.json` | ERPNext `invoice-overdue` webhook | SMS to tenant (Twilio) + Telegram to landlord |
| `maintenance-alert-flow.json` | Daily 9:00 AM schedule | Query stale HD Tickets → Telegram alert |
| `weekly-report-flow.json` | Every Friday 17:00 | Aggregate ledger + balances + WOs + leases → Telegram report |

To import: Make.com → Scenarios → Import Blueprint → paste the JSON.

You will need to configure two Make.com environment variables:
- `ERPNEXT_BASE_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
- `TELEGRAM_LANDLORD_CHAT_ID`

---

## Automated Scheduler Jobs (Node.js)

The built-in scheduler (`src/automation/scheduler.js`) runs three cron jobs
independently of Make.com:

| Job | Schedule | Action |
|---|---|---|
| Overdue rent sweep | Daily 08:00 PST | Query overdue Sales Invoices → bulk SMS (Twilio) + Telegram summary |
| Stale work-order alert | Daily 09:00 PST | HD Tickets open > 48 h → Telegram alert |
| Weekly portfolio report | Friday 17:00 PST | Cash flow + delinquencies + WOs + expiring leases → Telegram |

---

## Telegram Bot Commands

Once running, message the bot from any whitelisted Telegram account:

| Command | Description |
|---|---|
| `/start` | Welcome message |
| `/help` | List example natural-language queries |
| `/clear` | Reset conversation history |
| Any text | NLP query routed through OpenAI → ERPNext API → formatted response |

**Example queries:**
- "Which tenants are late on rent this month?"
- "What is the status of the HVAC repair in Unit 4B?"
- "List all vacant units."
- "Give me a financial summary for this week."
- "When does the lease for 123 Maple Street expire?"

> **Security:** The bot silently drops all messages from Telegram user IDs not
> present in `TELEGRAM_ALLOWED_USER_IDS`. Unauthorized callers receive no
> response and no error, preventing bot discovery.

---

## Supported PMS Events (Webhooks)

| ERPNext route | Internal event | Tenant SMS | Landlord Telegram |
|---|---|---|---|
| `/erpnext/invoice-overdue` | `rent.overdue` | ✅ Overdue reminder (Twilio) | ✅ Real-time alert |
| `/erpnext/payment-received` | `payment.received` | — | ✅ Payment confirmation |
| `/erpnext/ticket-created` | `workorder.created` | — | ✅ New ticket alert |
| `/erpnext/ticket-updated` | `workorder.updated` | — | ✅ Vendor update alert |
| `/erpnext/contract-submitted` | `lease.created` | — | ✅ New lease notification |
| `/erpnext/contract-cancelled` | `lease.expired` | — | ✅ Renewal prompt |

---

## Security Notes

- All webhook endpoints verify an **HMAC-SHA256 signature** via the
  `X-Frappe-Webhook-Signature` header (hex digest, shared secret set in both
  ERPNext webhook config and `WEBHOOK_SECRET` env var). Requests with invalid
  or missing signatures are rejected with HTTP 401.
- The Telegram bot enforces a **static allowlist** of Telegram user IDs.
  Messages from any other account are silently discarded.
- API credentials are loaded exclusively from environment variables — never
  hard-coded.
- ERPNext communication uses **token-based auth over TLS** (`Authorization: token key:secret`).
- Twilio SMS uses **HTTP Basic auth over TLS** with your Account SID and Auth Token.
