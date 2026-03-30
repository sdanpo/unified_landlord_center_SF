# Landlord Guide
## Unified Landlord Center SF — Landlord Usage Manual

This guide covers everything you do day-to-day as the landlord: managing your
portfolio through the Telegram bot, handling leases and late fees, assigning
vendors, screening applicants, and reviewing automated alerts.

You don't need to be technical to use this system. Most things happen through
plain English messages to the Telegram bot, and the step-by-step instructions
below will walk you through anything that requires logging into ERPNext.

---

## Table of Contents

1. [Getting Started with the Telegram Bot](#1-getting-started-with-the-telegram-bot)
2. [Adding a Property](#2-adding-a-property)
3. [Adding a Multifamily Property with Multiple Units](#3-adding-a-multifamily-property-with-multiple-units)
4. [Adding a Tenant](#4-adding-a-tenant)
5. [Creating a Lease](#5-creating-a-lease)
6. [Adding a Maintenance Task (Work Order)](#6-adding-a-maintenance-task-work-order)
7. [Adding a Vendor](#7-adding-a-vendor)
8. [Rent & Financials](#8-rent--financials)
9. [Lease Renewals](#9-lease-renewals)
10. [Late Fee Configuration](#10-late-fee-configuration)
11. [Rental Applications & Tenant Screening](#11-rental-applications--tenant-screening)
12. [Documents](#12-documents)
13. [Automated Alerts Reference](#13-automated-alerts-reference)
14. [Tenant Portal Administration](#14-tenant-portal-administration)
15. [Weekly Portfolio Report](#15-weekly-portfolio-report)

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

## 2. Adding a Property

A "property" is a building or address you own. If it has multiple rentable
units (like a duplex or apartment building), see Section 3. If it is a
single-family home you rent out as one unit, follow these steps.

### Step-by-step: Add a single-family rental property

1. **Log in to ERPNext**
   - Open your browser and go to your ERPNext URL (e.g. `https://erp.yoursite.com`)
   - Sign in with your ERPNext username and password

2. **Open the Property module**
   - From the main menu, click **PropMS** (or search "Property" in the search bar at the top)
   - Click **Property**

3. **Create a new Property record**
   - Click the blue **New** button (top right)
   - Fill in the following fields:

   | Field | What to enter |
   |---|---|
   | **Property Name** | A short nickname, e.g. "123 Oak Street" |
   | **Street Address** | Street address |
   | **City** | City |
   | **State** | State (e.g. OH or NC) |
   | **ZIP Code** | ZIP code |
   | **Bedrooms** | Number of bedrooms |
   | **Rent** | Monthly rent amount |
   | **Status** | Available |

4. **Save**
   - Click **Save** (top left or Ctrl+S)
   - Your property is now in the system

5. **Create a Unit record linked to this property**
   - In PropMS, even a single-family home needs its own "unit" Property record
   - Go to **PropMS → Property → New**
   - Fill in the unit details and set **Parent Property** to the property you just saved
   - Enter a property name (e.g. "123 Oak Street – Main Unit")
   - Save

> **Tip:** You can also ask the Telegram bot: *"Show me all my properties"* to
> confirm it appears.

---

## 3. Adding a Multifamily Property with Multiple Units

A multifamily property is a building with two or more rentable units — a
duplex, triplex, apartment building, etc. You create **one** Property record
and then add each unit inside it.

### Step-by-step: Add a multifamily property

1. **Log in to ERPNext** (see Section 2, Step 1)

2. **Open PropMS → Property** and click **New**

3. **Fill in the building details**

   | Field | What to enter |
   |---|---|
   | **Property Name** | e.g. "456 Maple Ave" |
   | **Street Address** | Street address of the building |
   | **City** | City |
   | **State** | State (e.g. OH or NC) |
   | **ZIP Code** | ZIP code |
   | **Status** | Available |

4. **Save the property** (click Save) — this is the parent building record

5. **Add each unit as a separate Property record**

   In PropMS, units are individual Property records linked to the parent building
   via the **Parent Property** field. For each unit:

   - Go to **PropMS → Property → New**
   - Fill in:

   | Field | What to enter |
   |---|---|
   | **Property Name** | e.g. "456 Maple Ave – Unit 1A" |
   | **Parent Property** | Select the building you just saved |
   | **Bedrooms** | Number of bedrooms |
   | **Rent** | Monthly rent for this unit |
   | **Status** | Available |

   Click **Save**. Repeat for every unit in the building.

### Example: Setting up a 4-plex

For a building at "789 Pine St" with units 1A, 1B, 2A, 2B:

1. Create the building: Property Name = `789 Pine St`, save it
2. Create four Property records, each with **Parent Property** = `789 Pine St`:
   - `789 Pine St – Unit 1A`
   - `789 Pine St – Unit 1B`
   - `789 Pine St – Unit 2A`
   - `789 Pine St – Unit 2B`
3. Set the **Rent** on each unit (they can be different amounts), save each one

> **Tip:** Once set up, ask the Telegram bot: *"Show me the units at 789 Pine St"*
> to confirm everything looks right.

---

## 4. Adding a Tenant

A tenant is someone currently renting one of your units. You add them as a
**Customer** in ERPNext before you can create a lease.

### Step-by-step: Add a new tenant

1. **Log in to ERPNext**

2. **Go to Selling → Customer** (or search "Customer" in the top search bar)

3. **Click New**

4. **Fill in the tenant's details**

   | Field | What to enter |
   |---|---|
   | **Customer Name** | Full legal name (e.g. "Jane Smith") |
   | **Customer Type** | Select "Individual" |
   | **Customer Group** | Select "Tenant" |
   | **Email Address** | Their email (used for portal login and e-signature) |
   | **Mobile Number** | Their cell phone (used for SMS reminders) |

5. **Save**

6. **Set up their portal login**

   After saving, run the following from your server terminal:
   ```
   npm run setup:portal
   ```
   This creates their online portal account so they can log in to pay rent,
   view their lease, and submit maintenance requests.

> **Note:** If you skip the portal setup step, the tenant won't be able to log
> in. You only need to run the command once — it's safe to run multiple times.

---

## 5. Creating a Lease

A lease connects a tenant to a specific unit for a period of time and sets
the rent amount and payment terms.

### Step-by-step: Create a lease

1. **Log in to ERPNext**

2. **Go to PropMS → Lease** (or search "Lease" in the search bar)

3. **Click New**

4. **Fill in the lease details**

   | Field | What to enter |
   |---|---|
   | **Lease Customer** | Select the tenant's name (Customer record) |
   | **Property** | Select the specific unit (the Property record) |
   | **Lease Start Date** | The day the lease begins (e.g. 2025-08-01) |
   | **Lease End Date** | The day the lease ends (e.g. 2026-07-31) |
   | **Security Deposit** | Security deposit amount |
   | **Notice Period** | Days of notice required to vacate (e.g. 30) |
   | **Grace Period (days)** | Days after due date before late fees start (e.g. 5) |
   | **Late Fee Type** | Percentage or Flat Amount |
   | **Late Fee Amount** | Daily late fee (e.g. $50 flat or 0.1% per day) |

   **Monthly rent** is set in the **Lease Items** child table at the bottom of
   the form — click **Add Row**, set Frequency = `Monthly` and Amount = the
   monthly rent amount.

5. **Save and Submit**

   - Click **Save** first, then click **Submit** to activate the lease
   - Submitted leases trigger the automated rent invoice schedule and renewal
     reminders

6. **Send the lease for e-signature (optional)**

   Once the lease is submitted, send it to the tenant for signing:
   ```
   Tell Telegram bot: "Send lease to Jane Smith"
   ```
   Both you and the tenant receive a signing link by email. The signed PDF is
   automatically saved to the lease record when both parties sign.

> **Important:** Always click **Submit** (not just Save). A saved-but-not-submitted
> lease is a draft and won't generate invoices or trigger reminders.

---

## 6. Adding a Maintenance Task (Work Order)

Maintenance tasks (called "HD Tickets" in ERPNext) track repairs, inspections,
and any work that needs doing at a property.

### Option A — Tenant submits it themselves (easiest)

Tenants can submit maintenance requests directly from their portal at
`{your-erpnext-url}/helpdesk`. You receive an instant Telegram notification
when they do.

### Option B — You add it yourself

1. **Log in to ERPNext**

2. **Go to Helpdesk → New Ticket** (or search "HD Ticket")

3. **Fill in the details**

   | Field | What to enter |
   |---|---|
   | **Subject** | Short description, e.g. "Leaking faucet in kitchen" |
   | **Customer** | Select the tenant's name (or leave blank if unit is vacant) |
   | **Property / Unit** | Select which property and unit |
   | **Priority** | Low / Medium / High / Urgent |
   | **Description** | Full details of the issue |
   | **Status** | Leave as "Open" |

4. **Save**

### Option C — Ask the Telegram bot

```
"Create a maintenance ticket for Unit 2B — the kitchen faucet is leaking"
"Log a work order: broken window at 789 Pine St Unit 1A, high priority"
```

### Assigning a vendor to a maintenance task

Once a ticket exists, assign a vendor from Telegram:

```
"Assign Mike's Plumbing to HD-0023"
"Who are our plumbers?" (to find a vendor first)
"Assign ABC Plumbing to the leaking faucet ticket in Unit 2B"
```

The vendor automatically receives an SMS with the job details.

### Checking open maintenance tasks

```
"What maintenance requests are open?"
"Show me all work orders"
"What's the status of the HVAC repair in Unit 4B?"
```

> **Reminder:** Tickets open longer than 48 hours will trigger an automatic
> Telegram alert at 9:00 AM daily so nothing falls through the cracks.

---

## 7. Adding a Vendor

Vendors are contractors, plumbers, electricians, and other service providers
you work with. Add them once and you can assign them to maintenance tasks
instantly.

### Step-by-step: Add a vendor

1. **Log in to ERPNext**

2. **Go to Buying → Supplier** (or search "Supplier" in the search bar)

3. **Click New**

4. **Fill in the vendor's details**

   | Field | What to enter |
   |---|---|
   | **Supplier Name** | Company or person name (e.g. "Mike's Plumbing") |
   | **Supplier Group** | Select "Services" |
   | **Contact Name** | Primary contact's name |
   | **Mobile Number** | Phone number for SMS work order notifications |
   | **Email Address** | Email address |
   | **Trade / Specialty** | Select the trade: Plumbing, Electrical, HVAC, Painting, Carpentry, Landscaping, Pest Control, or General |
   | **CA License #** | Their contractor license number (optional but recommended) |
   | **Rating** | Your 1–5 star rating of their work |

5. **Save**

The vendor is now in your directory and can be assigned to maintenance tickets
via the Telegram bot.

### Viewing your vendor list

```
"Show me all vendors"
"Who are our plumbers?"
"List all electricians"
```

---

## 8. Rent & Financials

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
Section 10), the system charges late fees automatically every day after the
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

## 9. Lease Renewals

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

## 10. Late Fee Configuration

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

## 11. Rental Applications & Tenant Screening

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

## 12. Documents

All signed leases and documents attached to a lease record in ERPNext are
automatically available to tenants at their portal `/my-docs` page. You can
also attach documents manually in ERPNext:

1. Open the Lease record
2. Scroll to the **Attachments** section
3. Upload the file

It will appear in the tenant's document portal immediately.

---

## 13. Automated Alerts Reference

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

## 14. Tenant Portal Administration

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

## 15. Weekly Portfolio Report

Every **Friday at 5:00 PM PST** you receive a comprehensive Telegram report:
- Outstanding rent balances
- Payments received this week
- Open work orders by status
- Leases expiring in the next 90 days
- Late fee totals for the week

---

## Quick Reference: Common Tasks

| What you want to do | How to do it |
|---|---|
| Add a new property | ERPNext → PropMS → Property → New |
| Add units to a property | PropMS → Property → New → set Parent Property |
| Add a new tenant | ERPNext → Selling → Customer → New (Group = "Tenant") |
| Create a lease | ERPNext → PropMS → Lease → New → Submit |
| Add a maintenance task | Tell the bot, or ERPNext → Helpdesk → New Ticket |
| Add a vendor | ERPNext → Buying → Supplier → New |
| Assign vendor to a task | Tell bot: "Assign [vendor] to [ticket number]" |
| Check who owes rent | Tell bot: "Who owes rent?" |
| Send lease for signing | Tell bot: "Send lease to [tenant name]" |
| Screen an applicant | Tell bot: "Screen [applicant name]" |
| Check open maintenance | Tell bot: "What maintenance is open?" |
| See all my properties | Tell bot: "Show me all my properties" |
| Get rent summary | Tell bot: "Give me a financial summary" |
