# Operations Guide
## Unified Landlord Center SF — System Administration Manual

This guide covers system architecture, initial setup, deployment, ongoing
operations, and troubleshooting.

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  LANDLORD (Telegram)                                            │
│       │                                                         │
│  ┌────▼──────────────────────────┐                              │
│  │  Telegram Bot (polling mode)  │   node-telegram-bot-api     │
│  └────┬──────────────────────────┘                              │
│       │ natural language message                                 │
│  ┌────▼──────────────────────────┐                              │
│  │  OpenAI GPT-4o Agentic Loop   │   function-calling          │
│  │  (src/ai/openai.js)           │   12 tools                  │
│  └────┬──────────────────────────┘                              │
│       │ tool calls                                               │
│  ┌────▼──────────────────────────┐                              │
│  │  ERPNext REST Client          │   token auth                 │
│  │  (src/api/erpnext.js)         │   /api/resource/*           │
│  └───────────────────────────────┘                              │
│                                                                 │
│  AUTOMATION (node-cron scheduler)                               │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  src/automation/scheduler.js                           │     │
│  │  • Daily 08:00 — overdue rent sweep + SMS              │     │
│  │  • Daily 09:00 — stale work-order alerts               │     │
│  │  • Daily 10:00 — lease renewal checks (90/60/30/14d)   │     │
│  │  • Daily 10:30 — late fee auto-charging                │     │
│  │  • Friday 17:00 — weekly portfolio report              │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                 │
│  WEBHOOK SERVER (Express)                                        │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  src/webhook/server.js   (port 3000)                   │     │
│  │  POST /webhooks/erpnext/*    ← ERPNext events          │     │
│  │  POST /webhooks/boldsign/completed  ← BoldSign signed  │     │
│  │  POST /webhooks/smartmove/completed ← SmartMove done   │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                 │
│  EXTERNAL SERVICES                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  BoldSign    │  │  SmartMove   │  │  Twilio SMS          │  │
│  │  e-signature │  │  screening   │  │  tenant messages     │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│                                                                 │
│  TENANT PORTAL (ERPNext built-in web portal)                    │
│  /my-invoices  /paid-invoices  /my-lease  /my-docs              │
│  /helpdesk     /apply (public Web Form)                         │
└─────────────────────────────────────────────────────────────────┘
```

### Key files

| File | Purpose |
|---|---|
| `src/index.js` | Entry point — starts webhook server, Telegram bot, scheduler |
| `src/config.js` | Loads and validates all environment variables |
| `src/api/erpnext.js` | ERPNext REST API client (all DocType queries and mutations) |
| `src/api/boldsign.js` | BoldSign e-signature API client |
| `src/api/smartmove.js` | TransUnion SmartMove screening API client |
| `src/ai/openai.js` | OpenAI agentic loop with function-calling |
| `src/ai/functions.js` | Tool schema definitions (12 tools) |
| `src/automation/scheduler.js` | node-cron job scheduler (5 jobs) |
| `src/sms/dispatcher.js` | Twilio SMS templates and dispatch |
| `src/telegram/bot.js` | Telegram bot lifecycle and landlord notifications |
| `src/webhook/server.js` | Express HTTP server for all incoming webhooks |
| `src/webhook/handlers.js` | Webhook event routing to SMS/Telegram |

---

## 2. Initial Setup

### Prerequisites

- **Node.js ≥ 18**
- **ERPNext** instance (self-hosted or Frappe Cloud) with the
  **[PropMS](https://github.com/aakvatech/PropMS)** app installed —
  provides the `Lease`, `Property`, and `Property Unit` DocTypes
- A publicly reachable **HTTPS URL** for webhook delivery
  (use [ngrok](https://ngrok.com) for local development)
- Accounts set up for: Telegram BotFather, OpenAI, Twilio, Stripe,
  BoldSign, TransUnion SmartMove (see section 3)

### Install

```bash
git clone <repo>
cd unified_landlord_center_SF
npm install
```

### Configure environment variables

```bash
cp .env.example .env
# Edit .env — see section 3 for all variables
```

### Step 1 — Add custom fields to ERPNext

```bash
npm run setup:erpnext
# or: node scripts/setup-erpnext-fields.js
```

This creates all custom fields on Sales Invoice, Payment Entry, HD Ticket,
Supplier, Lease, and CRM Lead. The script is idempotent — safe to run
multiple times.

> **Requires PropMS to be installed first.** The `custom_lease` Link fields
> will be rejected by ERPNext if the Lease DocType does not exist.

Custom fields created:

| DocType | Fields added |
|---|---|
| Sales Invoice | `custom_unit`, `custom_property`, `custom_lease`, `custom_is_late_fee`, `custom_original_invoice`, `custom_late_fee_date` |
| Payment Entry | `custom_unit`, `custom_lease` |
| HD Ticket | `custom_unit`, `custom_property`, `custom_ticket_type`, `custom_assigned_vendor`, `custom_vendor_quote`, `custom_quote_approved` |
| Supplier | `custom_trade`, `custom_license_number`, `custom_rating`, `custom_sms_number` |
| Lease | `custom_renewal_notice_sent`, `custom_renewal_action`, `custom_late_fee_grace_days`, `custom_late_fee_type`, `custom_late_fee_flat_amount` |
| CRM Lead | `custom_date_of_birth`, `custom_current_address`, `custom_monthly_rent_paid`, `custom_current_landlord_name`, `custom_current_landlord_phone`, `custom_monthly_gross_income`, `custom_employment_start_date`, `custom_eviction_history`, `custom_broken_lease_history`, `custom_number_of_occupants`, `custom_has_pets`, `custom_pet_description`, `custom_consent_background_check`, `custom_consent_accuracy` |

### Step 2 — Run ERPNext setup scripts

```bash
npm run setup:scripts
# or: node scripts/run-erpnext-setup.js
```

This creates the "Late Fee" service item in ERPNext Items (needed by the
late fee scheduler).

### Step 3 — Configure the tenant portal

```bash
npm run setup:portal
# or: node scripts/setup-tenant-portal.js
```

This creates/updates:
- Portal menu items (My Invoices, Paid Invoices, My Lease, My Documents,
  Maintenance Tickets)
- Custom Web Pages at `/my-invoices`, `/paid-invoices`, `/my-lease`, `/my-docs`
- Public Web Form at `/apply` (creates CRM Lead on submit)
- Stripe payment gateway settings (if Stripe keys are set)
- ACH/card pay button override script in ERPNext Website Settings
- Website User accounts for all existing tenants (Customer group = "Tenant")

### Step 4 — Configure ERPNext webhooks

In ERPNext → Integrations → Webhooks, create these webhooks using your
`WEBHOOK_SECRET` value as the shared secret:

| DocType | Trigger | URL |
|---|---|---|
| Sales Invoice | `on_submit` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/invoice-overdue` |
| Payment Entry | `on_submit` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/payment-received` |
| HD Ticket | `after_insert` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/ticket-created` |
| HD Ticket | `on_update` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/ticket-updated` |
| Lease | `after_insert` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/contract-submitted` |
| Lease | `on_update` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/contract-cancelled` |

Conditions to set:
- **invoice-overdue:** `(doc.outstanding_amount or 0) > 0 and doc.due_date < frappe.utils.today()`
- **contract-cancelled:** `doc.lease_status in ("Closed", "Not Materialized", "Vacating")`

Also configure ERPNext to call the application webhook when a CRM Lead is
created via the Web Form:
| DocType | Trigger | URL |
|---|---|---|
| CRM Lead | `after_insert` | `{WEBHOOK_BASE_URL}/webhooks/erpnext/application-submitted` |
Condition: `doc.lead_source == "Online Application"`

### Step 5 — Configure BoldSign webhooks

In your BoldSign dashboard (app.boldsign.com → API Management → Webhooks):
1. Add webhook URL: `{WEBHOOK_BASE_URL}/webhooks/boldsign/completed`
2. Select event: **Document Completed**
3. Copy the signing secret into `BOLDSIGN_WEBHOOK_SECRET`

### Step 6 — Run

```bash
# Development (auto-restarts on code change)
npm run dev

# Production
npm start
```

### Step 7 — Test

```bash
npm test
```

All 109 tests should pass.

---

## 3. Environment Variables Reference

Copy `.env.example` to `.env` and fill in each section.

### ERPNext / PropMS

| Variable | Required | Description |
|---|---|---|
| `ERPNEXT_BASE_URL` | ✅ | Full URL of your ERPNext instance, e.g. `https://erp.example.com` |
| `ERPNEXT_API_KEY` | ✅ | ERPNext API key (ERPNext → User → API Access → Generate Keys) |
| `ERPNEXT_API_SECRET` | ✅ | ERPNext API secret (same location) |

### OpenAI

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | OpenAI secret key from platform.openai.com |
| `OPENAI_MODEL` | | Model to use, default `gpt-4o` |

### Telegram Bot

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | Token from BotFather (`/newbot`) |
| `TELEGRAM_ALLOWED_USER_IDS` | ✅ | Comma-separated Telegram user IDs of landlord(s). Find yours: message `@userinfobot` |

### Webhook Server

| Variable | Required | Description |
|---|---|---|
| `WEBHOOK_PORT` | | HTTP port, default `3000` |
| `WEBHOOK_SECRET` | ✅ | Shared secret for ERPNext webhook HMAC verification. Set the same value in ERPNext webhook config |
| `WEBHOOK_BASE_URL` | ✅ | Public HTTPS URL of this server. Used in portal pay button and webhook registration |

### Stripe Payments

| Variable | Required | Description |
|---|---|---|
| `STRIPE_PUBLISHABLE_KEY` | | Stripe publishable key (`pk_live_...` or `pk_test_...`) |
| `STRIPE_SECRET_KEY` | | Stripe secret key (`sk_live_...`) |
| `STRIPE_PAYMENT_ACCOUNT` | | ERPNext GL account for Stripe payments, default `Debtors - LC` |
| `CARD_SURCHARGE_PCT` | | Card surcharge percentage shown to tenants, default `3` |

### Twilio SMS

| Variable | Required | Description |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | ✅ | Twilio account SID (`ACxxx...`) from console.twilio.com |
| `TWILIO_AUTH_TOKEN` | ✅ | Twilio auth token |
| `TWILIO_FROM_NUMBER` | ✅ | Your Twilio phone number in E.164 format, e.g. `+14155550001` |

### BoldSign (Lease e-signatures)

| Variable | Required | Description |
|---|---|---|
| `BOLDSIGN_API_KEY` | | BoldSign API key from app.boldsign.com → API Management |
| `BOLDSIGN_TEMPLATE_ID` | | ID of your uploaded lease template in BoldSign |
| `BOLDSIGN_WEBHOOK_SECRET` | | Webhook signing secret from BoldSign → API Management → Webhooks |
| `LANDLORD_EMAIL` | | Landlord's email address (BoldSign counter-signer) |
| `LANDLORD_NAME` | | Landlord's full name (BoldSign counter-signer) |

**BoldSign template setup (one-time manual step):**
1. Log in to app.boldsign.com
2. Go to Templates → Create Template
3. Upload your lease PDF
4. Add two signer roles: `Tenant` (Role Index 1) and `Landlord` (Role Index 2)
5. Place signature fields and any merge fields for tenant name, unit, dates, rent
6. Save the template and copy the Template ID to `BOLDSIGN_TEMPLATE_ID`

### TransUnion SmartMove (Tenant screening)

| Variable | Required | Description |
|---|---|---|
| `SMARTMOVE_API_KEY` | | SmartMove API key from your SmartMove account settings |

### Late Fee Auto-Charging

| Variable | Required | Description |
|---|---|---|
| `LATE_FEE_AUTO_SUBMIT` | | `1` = submit late fee invoices automatically (immediate ledger impact); `0` (default) = save as draft for review |

### Reports

| Variable | Required | Description |
|---|---|---|
| `REPORT_DELIVERY` | | `telegram` (default) or `email` |
| `REPORT_EMAIL_TO` | | Email address for weekly report delivery |
| `LOG_LEVEL` | | Winston log level: `error`, `warn`, `info` (default), `debug` |

---

## 4. Scheduler Jobs

All jobs run in `src/automation/scheduler.js`:

| Job | Schedule (PST) | Function | Description |
|---|---|---|---|
| Overdue rent sweep | Daily 08:00 | `runOverdueRentCheck()` | Queries overdue Sales Invoices → bulk SMS to tenants → Telegram summary |
| Stale work-order alert | Daily 09:00 | `runStaleWorkOrderCheck()` | HD Tickets open > 48h → Telegram alert per ticket |
| Lease renewal check | Daily 10:00 | `runLeaseRenewalCheck()` | Leases expiring in 14/30/60/90 days → SMS to tenant + Telegram; deduplicates via `custom_renewal_notice_sent` |
| Late fee charging | Daily 10:30 | `runLateFeeCheck()` | Overdue invoices past grace period → creates late fee Sales Invoice → SMS (first day only) + Telegram summary |
| Weekly portfolio report | Friday 17:00 | `runWeeklyReport()` | Cash flow + delinquencies + open work orders + expiring leases → Telegram |

---

## 5. Webhook Routes Reference

The Express server listens on `WEBHOOK_PORT` (default 3000).

### ERPNext webhooks (HMAC verified via `X-Frappe-Webhook-Signature`)

| Route | Trigger | Action |
|---|---|---|
| `POST /webhooks/erpnext/invoice-overdue` | Sales Invoice on_submit (overdue) | SMS to tenant + Telegram to landlord |
| `POST /webhooks/erpnext/payment-received` | Payment Entry on_submit | Telegram to landlord |
| `POST /webhooks/erpnext/ticket-created` | HD Ticket after_insert | Telegram to landlord |
| `POST /webhooks/erpnext/ticket-updated` | HD Ticket on_update | Telegram to landlord |
| `POST /webhooks/erpnext/contract-submitted` | Lease after_insert | Telegram to landlord |
| `POST /webhooks/erpnext/contract-cancelled` | Lease on_update (closed/vacating) | Telegram to landlord |
| `POST /webhooks/erpnext/application-submitted` | CRM Lead after_insert (Online Application) | Telegram to landlord with applicant details |

### BoldSign webhook (HMAC via `X-BoldSign-Signature`)

| Route | Event | Action |
|---|---|---|
| `POST /webhooks/boldsign/completed` | `eventType === "Completed"` | Download signed PDF → attach to ERPNext Lease → set `signed_agreement_received=1` → SMS to tenant + Telegram to landlord |

Signature format: `t=<timestamp>, s0=<hex>` — signed payload is `timestamp.rawBody`

### SmartMove webhook

| Route | Event | Action |
|---|---|---|
| `POST /webhooks/smartmove/completed` | Screening complete | Update CRM Lead status → Telegram to landlord with screening summary |

### Stripe webhooks

| Route | Event | Action |
|---|---|---|
| `POST /webhooks/stripe/*` | Stripe events | Payment processing (handled by Stripe integration) |

---

## 6. AI Tools Reference

The OpenAI agentic loop has 12 tools available to the Telegram bot:

| Tool | Description |
|---|---|
| `get_overdue_invoices` | Query overdue Sales Invoices with tenant/amount details |
| `get_open_tickets` | Query open HD Tickets (work orders) |
| `get_leases` | Query active leases with tenant/unit/dates |
| `get_financial_summary` | Aggregate cash flow, delinquencies, balances |
| `get_lease_renewals` | Leases expiring within N days |
| `get_vendors` | List Suppliers with optional trade filter |
| `assign_vendor` | Assign a Supplier to an HD Ticket + SMS the vendor |
| `send_lease_for_signature` | Send BoldSign signing request to tenant and landlord |
| `send_screening_invite` | Send TransUnion SmartMove invitation to applicant |
| `get_applicants` | List CRM Leads (rental applicants) with status |
| `get_payments` | Query recent Payment Entries |
| `get_vacant_units` | List vacant Property Units |

---

## 7. Deployment (Railway)

The repository includes `railway.json` for one-click Railway deployment.

1. Push the repository to GitHub
2. Create a new Railway project, connect the GitHub repo
3. Add all environment variables in Railway → Variables
4. Railway auto-deploys on every push to `main`
5. Set `WEBHOOK_BASE_URL` to your Railway service URL
   (e.g. `https://unified-landlord-center.up.railway.app`)
6. Re-run `npm run setup:portal` with the Railway URL set so the ACH pay
   button is correctly configured

---

## 8. Adding a New Tenant

1. **Create a Customer** in ERPNext → Selling → Customer
   - Set `Customer Group` = "Tenant"
   - Add their email address in the Contact tab
2. **Create a Lease** in ERPNext → PropMS → Lease
   - Link to the Customer, Property, and Unit
   - Set start/end dates, rent amount, and `lease_status = "Active"`
   - Configure late fee fields if desired
3. **Run portal setup** to create their website user account:
   ```bash
   npm run setup:portal
   ```
4. The tenant can now log in at `{portal-url}/login` with the email they
   provided. They set their password on first login via "Forgot Password".

---

## 9. Adding a Vendor

1. In ERPNext → Buying → Supplier, create a new Supplier
2. Fill in the custom fields in the "Additional Info" section:
   - **Trade / Specialty** — select their trade
   - **CA License #** — contractor license number
   - **Rating** — your star rating (1–5)
   - **SMS / Mobile #** — mobile number for work order SMS messages
3. The vendor now appears in Telegram bot queries (`"Who are our plumbers?"`)
   and can be assigned to work orders

---

## 10. Troubleshooting

### Bot not responding to messages

- Verify `TELEGRAM_BOT_TOKEN` is correct
- Verify your Telegram user ID is in `TELEGRAM_ALLOWED_USER_IDS`
  (message `@userinfobot` to find your ID)
- Check logs: `tail -f logs/combined.log`
- Confirm the process is running: `ps aux | grep node`

### Webhooks not firing

- Verify `WEBHOOK_BASE_URL` is publicly reachable via HTTPS
- Verify `WEBHOOK_SECRET` matches the secret set in ERPNext webhook config
- Test manually: `curl -X POST {WEBHOOK_BASE_URL}/webhooks/erpnext/invoice-overdue`
  (expect a 401 — means the server is up but the signature is wrong, which is correct)
- Check ERPNext → Integrations → Webhook Logs for delivery failures

### ERPNext API errors

- Verify `ERPNEXT_BASE_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`
- Confirm the API user has `System Manager` or appropriate role permissions
- Test: `curl -H "Authorization: token KEY:SECRET" {ERPNEXT_BASE_URL}/api/resource/Lease`

### Late fees not being charged

- Verify a "Late Fee" item exists in ERPNext Items
  (`npm run setup:scripts` creates it if missing)
- Check that the Lease has `custom_late_fee_grace_days` > 0 and
  `late_payment_interest_percentage` > 0 (or `custom_late_fee_flat_amount` > 0)
- If `LATE_FEE_AUTO_SUBMIT=0`, late fee invoices are created as drafts —
  check ERPNext → Accounts → Sales Invoice for draft invoices

### BoldSign signing not working

- Verify `BOLDSIGN_API_KEY`, `BOLDSIGN_TEMPLATE_ID`, `LANDLORD_EMAIL`, `LANDLORD_NAME`
- Confirm the template has two roles: `Tenant` (index 1) and `Landlord` (index 2)
- Check BoldSign dashboard for failed sends

### SMS not delivering

- Verify `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
- Confirm the Twilio number is active and SMS-capable
- Check Twilio console logs for delivery errors
- Tenant phone numbers must be in E.164 format in ERPNext
  (`+14155550101`, not `415-555-0101`)

### Tenant portal not showing data

- Confirm the tenant has a Website User account linked to their Customer record
- Confirm a User Permission exists: `allow Customer = [their customer name]`
- Re-run `npm run setup:portal` to recreate permissions if needed
- Check the tenant is logging in with the correct email address

---

## 11. Log Files

Logs are written to `logs/` by Winston:

| File | Content |
|---|---|
| `logs/combined.log` | All log levels |
| `logs/error.log` | Error and above only |

Set `LOG_LEVEL=debug` in `.env` for verbose output during troubleshooting.

---

## 12. Running Tests

```bash
npm test              # Run all tests with coverage report
npm run test:watch    # Watch mode for development
```

Current test suite: **109 tests** across 4 suites covering API client,
webhook server, Telegram security, scheduler logic, and SMS dispatcher.
