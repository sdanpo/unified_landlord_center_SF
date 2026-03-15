# Landlord Guide
## Unified Landlord Center SF — Landlord Usage Manual

This guide covers everything you do day-to-day as the landlord: managing your
portfolio through the Telegram bot, handling leases and late fees, assigning
vendors, screening applicants, and reviewing automated alerts.

---

## 1. Getting Started with the Telegram Bot

The Telegram bot is your primary interface. It understands plain English — you
never need to log in to ERPNext for routine tasks.

### First-time setup

1. Open Telegram and search for your bot by its username (the name you gave it
   when you created it in BotFather).
2. Send `/start` — the bot will confirm your identity and show a welcome
   message. If the bot does not respond, your Telegram user ID is not in the
   allowlist. Ask the system administrator to add it to `TELEGRAM_ALLOWED_USER_IDS`.

### Essential commands

| Command | What it does |
|---|---|
| `/start` | Wake the bot, see a welcome message |
| `/help` | Show example queries for every capability |
| `/clear` | Wipe conversation memory (start fresh if the bot seems confused) |
| Any plain text | Natural-language query — the bot figures out what you want |

---

## 2. Rent & Financials

### Checking who owes rent

```
"Which tenants are overdue on rent?"
"Who hasn't paid this month?"
"Show me all unpaid invoices"
```

The bot queries ERPNext and returns a list showing tenant name, unit, amount
owed, and how many days overdue.

### What happens automatically (no action needed)

**Daily at 8:00 AM PST** — the system runs an overdue rent sweep:
- Tenants with overdue invoices receive an SMS reminder automatically
- You receive a Telegram summary of all outstanding balances

**Late fees** — if a lease has a grace period and late fee configured (see
section 5), the system charges late fees automatically every day after the
grace period expires. You get a daily Telegram summary of all fees applied.

### Viewing a payment when it comes in

When a payment is recorded in ERPNext, you receive an automatic Telegram
notification:

```
💰 Payment received:
  Tenant: Rotem Porat — Unit 3A
  Amount: $2,850.00
  Reference: pi_3Pxxx (Stripe)
  Invoice: ACC-SINV-2025-001 now paid in full
```

---

## 3. Lease Renewals

### Automated renewal notices

The system automatically notifies you at **90, 60, 30, and 14 days** before
a lease expires. You receive a Telegram message like:

```
📋 Lease expiring in 30 days:
  Tenant: Rotem Porat — Unit 3A
  End date: 2025-08-01
  Monthly rent: $2,850.00
  Action needed: Reply "renew LEASE-0001", "vacate LEASE-0001",
                 or "raise LEASE-0001 to $3,000"
```

The tenant also receives an SMS reminder at each milestone.

### Querying lease status

```
"Which leases expire in the next 60 days?"
"When does the lease for Unit 3A expire?"
"Show me all active leases"
```

### Sending a lease for signature (BoldSign)

Once the new lease is agreed on, send it for e-signature directly from Telegram:

```
"Send lease to Rotem Porat"
"Send the lease agreement to Jane Smith for signing"
```

The bot will:
1. Find the tenant's active lease in ERPNext
2. Send a BoldSign signing request to both tenant and you (landlord)
3. Both parties receive an email from BoldSign with a "Sign Now" link
4. When both have signed, the signed PDF is automatically attached to the
   Lease record in ERPNext and you receive a Telegram confirmation

> **One-time setup required:** You must first upload your lease PDF template
> to BoldSign at app.boldsign.com, set up the two signer roles (Tenant,
> Landlord), and place the signature fields. Save the template ID to
> `BOLDSIGN_TEMPLATE_ID` in your `.env`. See the Operations Guide for details.

---

## 4. Maintenance & Work Orders

### Viewing open tickets

```
"What maintenance requests are open?"
"Show me all work orders"
"What's the status of the HVAC repair in Unit 4B?"
```

Tickets older than 48 hours trigger an automatic Telegram alert at 9:00 AM
daily.

### Finding a vendor

```
"Who are our plumbers?"
"Show me all vendors"
"List electricians"
```

Returns a list of vendors from your directory with their trade, rating, and
contact number.

Supported trade categories: Plumbing, Electrical, HVAC, Painting, Carpentry,
Landscaping, Pest Control, General.

### Assigning a vendor to a ticket

```
"Assign Mike's Plumbing to HD-0023"
"Assign ABC Electrical to the ticket in Unit 2B"
```

The bot will:
1. Update the work order (HD Ticket) with the assigned vendor
2. Send an SMS to the vendor's mobile number with the job details:
   ```
   New work order: Leaking faucet at 123 Main St, Unit 2B.
   Tenant: Jane Smith (415-555-0101). Ticket: HD-0023.
   Reply to confirm.
   ```

### Adding vendors

Add vendors directly in ERPNext under **Buying → Supplier**. Fill in the
custom fields:
- **Trade / Specialty** — select the trade category
- **CA License #** — contractor license number
- **Rating** — your 1–5 star rating
- **SMS / Mobile #** — the number that receives work order SMS messages

---

## 5. Late Fee Configuration

Late fees are configured per lease in ERPNext under the lease record. Set:

| Field | Description |
|---|---|
| **Late Fee Grace Period (days)** | Days after due date before fees start (default: 5) |
| **Late Fee Type** | Percentage or Flat Amount |
| **Late Payment Interest %** | Daily percentage of outstanding balance (if type = Percentage) |
| **Daily Flat Late Fee ($)** | Fixed amount per day (if type = Flat Amount) |

Once configured, the system charges fees automatically every day after the
grace period. The tenant receives an SMS only on the **first day** a late fee
is applied (to avoid SMS fatigue), then fees accumulate silently.

You receive a daily Telegram summary:
```
💸 Late fees applied today: 2 invoices
  • Rotem Porat — Unit 3A: $142.50 (day 8 overdue)
  • Jane Smith  — Unit 1B: $50.00  (day 6 overdue)
```

To review late fee invoices in draft before they post, set
`LATE_FEE_AUTO_SUBMIT=0` in `.env`. Set it to `1` to have them post
automatically to the ledger.

---

## 6. Rental Applications & Tenant Screening

### When someone applies

Prospective tenants fill out the public rental application at
`{your-erpnext-url}/apply`. When they submit, you receive an immediate
Telegram notification:

```
📋 New rental application:
  Name: David Chen
  Email: david@example.com   Phone: 415-555-0202
  Income: $9,500/mo          Occupants: 2
  Eviction history: No
Reply "screen David Chen" to send a SmartMove screening request.
```

### Screening an applicant

```
"Screen David Chen"
"Send a screening invite to David Chen — standard report"
```

Available report types: `basic`, `standard` (default), `premium`

The applicant receives an email from TransUnion SmartMove and pays for their
own report ($40–75 depending on type). You pay nothing. When the report is
ready, you receive a Telegram notification with a summary and a link to the
full report in your SmartMove dashboard.

### Viewing all applicants

```
"Show me all applicants"
"Who has applied recently?"
"What's the status of David Chen's application?"
```

Returns the Lead pipeline showing where each applicant is:
`New Application → Screening Sent → Screened → Approved → Lease Sent → Tenant`

---

## 7. Documents

All signed leases and documents attached to a lease record in ERPNext are
automatically available to tenants at their portal `/my-docs` page. You can
also attach documents manually in ERPNext:

1. Open the Lease record
2. Scroll to the **Attachments** section
3. Upload the file

It will appear in the tenant's document portal immediately.

---

## 8. Automated Alerts Reference

You receive the following Telegram messages automatically without any action:

| Alert | When it fires |
|---|---|
| Overdue rent summary | Daily 8:00 AM if any invoices are past due |
| Stale work order alert | Daily 9:00 AM for tickets open > 48 hours |
| Lease renewal reminder | 90, 60, 30, and 14 days before lease end date |
| Late fee daily summary | Daily when any late fees are charged |
| New rental application | Immediately when /apply form is submitted |
| Screening report ready | When SmartMove report is complete |
| Lease signed | When both parties sign via BoldSign |
| Payment received | When a payment is recorded in ERPNext |
| New maintenance ticket | When a tenant submits a helpdesk ticket |

---

## 9. Tenant Portal Administration

Tenants log in at `{your-erpnext-url}/login`. Their portal shows:

| Page | URL | What tenants see |
|---|---|---|
| My Invoices | `/my-invoices` | Outstanding rent invoices with Pay button |
| Paid Invoices | `/paid-invoices` | Payment history |
| My Lease | `/my-lease` | Lease dates, rent, days remaining |
| My Documents | `/my-docs` | Signed lease PDF and attachments |
| Maintenance Tickets | `/helpdesk` | Submit and track work orders |

To add a new tenant to the portal:
1. Create a Customer record in ERPNext with their email address and set
   Customer Group = "Tenant"
2. Run `npm run setup:portal` — this creates their Website User account,
   links it to the Customer, and sets the User Permission so they only see
   their own data

---

## 10. Weekly Portfolio Report

Every **Friday at 5:00 PM PST** you receive a comprehensive Telegram report:
- Outstanding rent balances
- Payments received this week
- Open work orders by status
- Leases expiring in the next 90 days
- Late fee totals for the week
