# Unified Landlord Center SF
## AI-Augmented Omnichannel Property Management System

A composable, low-code-ready backend that glues together a property management
database (DoorLoop or Buildium), a Telegram NLP agent for the landlord, and
automated SMS alerts for tenants — all for roughly **$225–$250/month** in
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
│          │  PMS API Client          │   DoorLoop / Buildium  │
│          │  (REST, OAuth/Token)     │                        │
│          └───────────┬──────────────┘                        │
│                      │                                       │
│          ┌───────────▼──────────────────────────────┐        │
│          │           Make.com Middleware             │        │
│          │  Webhooks → SMS → Telegram Alerts        │        │
│          └───────────┬──────────────────────────────┘        │
│                      │                                       │
│          ┌───────────▼──────────────┐                        │
│          │       TENANTS            │   Standard SMS only    │
│          └──────────────────────────┘                        │
└──────────────────────────────────────────────────────────────┘
```

### Communication channels
| Direction | Channel | Technology |
|---|---|---|
| Landlord → System | Natural language queries | Telegram Bot |
| System → Landlord | Proactive alerts + query replies | Telegram Bot |
| System → Tenant | Automated rent / maintenance notices | SMS (PMS native or Twilio) |
| PMS → System | Real-time event delivery | Webhooks (HTTP POST) |

---

## Monthly Cost Model

| Category | Technology | Est. Monthly Cost |
|---|---|---|
| Core PMS | DoorLoop Premium | ~$199 |
| Middleware | Make.com Pro | ~$16 |
| LLM Inference | OpenAI API (GPT-4o) | ~$5–$10 |
| Automation / Conversational AI | This codebase (self-hosted) | ~$0 (VPS/free tier) |
| Telecom | Telegram (free) + PMS SMS credits | ~$0–$10 |
| **Total** | | **~$220–$235** |

---

## Repository Structure

```
src/
├── index.js                  Entry point – starts all services
├── config.js                 Centralised env-var configuration
├── logger.js                 Winston logger
├── api/
│   ├── index.js              PMS client factory (doorloop | buildium)
│   ├── doorloop.js           DoorLoop REST API client
│   └── buildium.js           Buildium REST API client
├── webhook/
│   ├── server.js             Express webhook receiver (HMAC verified)
│   └── handlers.js           Event dispatcher → SMS + Telegram
├── telegram/
│   ├── bot.js                Bot lifecycle + notifyLandlord()
│   ├── handlers.js           /start, /help, /clear, NLP handler
│   └── security.js           Telegram User ID whitelist guard
├── ai/
│   ├── openai.js             Agentic loop (function-calling)
│   └── functions.js          OpenAI tool schema definitions
├── sms/
│   └── dispatcher.js         Twilio / PMS-native SMS dispatch
└── automation/
    ├── scheduler.js           node-cron jobs
    └── reports.js             Weekly financial report generator

make-flows/
├── rent-overdue-flow.json     Make.com scenario – rent delinquency
├── maintenance-alert-flow.json Make.com scenario – stale work orders
└── weekly-report-flow.json    Make.com scenario – Friday report

tests/
├── setup.js                  Jest env-var bootstrap
├── api.test.js               PMS API client tests
├── webhook.test.js           Webhook server + handler tests
├── telegram.test.js          Security guard + message handler tests
├── scheduler.test.js         Cron job logic tests
└── sms.test.js               SMS dispatcher tests
```

---

## Quick Start

### 1. Prerequisites

- Node.js ≥ 18
- A [DoorLoop Premium](https://www.doorloop.com) account with API access enabled
  (or a Buildium Premium account)
- [Telegram Bot](https://core.telegram.org/bots/tutorial) created via BotFather
- [OpenAI API key](https://platform.openai.com)
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
| `PMS_PROVIDER` | `doorloop` (default) or `buildium` |
| `DOORLOOP_API_KEY` | DoorLoop API token |
| `OPENAI_API_KEY` | OpenAI secret key |
| `TELEGRAM_BOT_TOKEN` | Token from BotFather |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated Telegram user IDs of landlord/managers |
| `WEBHOOK_SECRET` | Shared secret for HMAC webhook verification |
| `WEBHOOK_BASE_URL` | Public HTTPS URL of this server |

### 4. Configure webhooks in DoorLoop

In DoorLoop → Settings → Integrations → Webhooks, add:

```
https://your-server.example.com/webhooks/doorloop
```

Select events: `rent.overdue`, `payment.received`, `workorder.created`, `workorder.updated`

### 5. Run

```bash
# Development (auto-restart on change)
npm run dev

# Production
npm start
```

### 6. Test

```bash
npm test
```

---

## Make.com Integration

The `make-flows/` directory contains three importable Make.com scenario
configurations that implement the middleware automation layer described in the
PRD.  These complement (or replace) the built-in Node.js scheduler when a
no-code visual editor is preferred.

| Flow file | Trigger | Actions |
|---|---|---|
| `rent-overdue-flow.json` | DoorLoop `rent.overdue` webhook | SMS to tenant + Telegram to landlord |
| `maintenance-alert-flow.json` | Daily 9:00 AM schedule | Query stale work orders → Telegram alert |
| `weekly-report-flow.json` | Every Friday 17:00 | Aggregate ledger + balances + WOs → Telegram report |

To import: Make.com → Scenarios → Import Blueprint → paste the JSON.

---

## Automated Scheduler Jobs (Node.js)

The built-in scheduler (`src/automation/scheduler.js`) runs three cron jobs
independently of Make.com:

| Job | Schedule | Action |
|---|---|---|
| Overdue rent sweep | Daily 08:00 PST | Query overdue balances → bulk SMS + Telegram summary |
| Stale work-order alert | Daily 09:00 PST | Tickets open > 48 h → Telegram alert |
| Weekly portfolio report | Friday 17:00 PST | Cash flow + delinquencies + WOs + expiring leases → Telegram |

---

## Telegram Bot Commands

Once running, message the bot from any whitelisted Telegram account:

| Command | Description |
|---|---|
| `/start` | Welcome message |
| `/help` | List example natural-language queries |
| `/clear` | Reset conversation history |
| Any text | NLP query routed through OpenAI → PMS API → formatted response |

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

| Event type | Tenant SMS | Landlord Telegram |
|---|---|---|
| `rent.overdue` | ✅ Overdue reminder | ✅ Real-time alert |
| `payment.received` | — | ✅ Payment confirmation |
| `workorder.created` | — | ✅ New ticket alert |
| `workorder.updated` | — | ✅ Vendor update alert |
| `lease.created` | — | ✅ New lease notification |
| `lease.expired` | — | ✅ Renewal prompt |

---

## Security Notes

- All webhook endpoints verify an **HMAC-SHA256 signature** (shared secret between
  the PMS and this server).  Requests with invalid or missing signatures are
  rejected with HTTP 401.
- The Telegram bot enforces a **static allowlist** of Telegram user IDs.
  Messages from any other account are silently discarded.
- API credentials are loaded exclusively from environment variables — never
  hard-coded.
- DoorLoop communication uses **AES-256 / TLS** per DoorLoop's API spec.
- Buildium uses **HTTP Basic auth** over TLS with your Client ID and Secret.
