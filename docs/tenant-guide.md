# Tenant Guide
## Unified Landlord Center SF — Tenant Portal Manual

This guide explains how to use your online tenant portal to pay rent, view
your lease, download documents, submit maintenance requests, and understand
the automated messages you receive.

---

## 1. Logging In

Your portal is at your landlord's ERPNext address — you will receive the exact
URL from your landlord when your account is set up.

**Login steps:**
1. Go to `{portal-url}/login`
2. Enter the email address associated with your tenancy
3. If it is your first login, click **"Forgot Password"** to set your
   password via the email link sent to you
4. After logging in you land on your invoices page

If you cannot log in, contact your landlord — your portal account may need to
be created or your email address may need to be updated.

---

## 2. Paying Rent

### Finding your invoice

1. After logging in, click **My Invoices** in the left sidebar or navigate
   to `/my-invoices`
2. The page shows all outstanding rent invoices with their due dates and
   amounts owed
3. Overdue invoices are marked with a red **Overdue** badge

### Making a payment

Click the **Pay Now** button on any invoice. You will be redirected to a
secure Stripe payment page where you can pay by:

- **Bank transfer (ACH)** — free, takes 1–3 business days to process
- **Credit or debit card** — processes immediately, a small surcharge applies

After payment:
- Your invoice will be marked as paid within 1–2 business days (ACH) or
  immediately (card)
- Your landlord receives an automatic confirmation
- The paid invoice moves to your **Paid Invoices** history page

### Viewing payment history

Click **Paid Invoices** in the sidebar or navigate to `/paid-invoices` to see
all previously paid invoices with dates and amounts.

---

## 3. Your Lease

Navigate to **My Lease** (`/my-lease`) to see:

| Field | Description |
|---|---|
| Unit | Your property address / unit number |
| Start date | When your current lease began |
| End date | When your current lease expires |
| Days remaining | Color-coded countdown: green (>90 days), orange (30–90), red (<30) |

### Requesting a renewal

If you would like to renew your lease, click the **Request Renewal** button.
This creates a maintenance ticket that notifies your landlord. They will
follow up with you about renewal terms.

You will also receive automated SMS reminders as your lease end date
approaches (at 90, 60, 30, and 14 days remaining).

---

## 4. Your Documents

Navigate to **My Documents** (`/my-docs`) to download:

- Your signed lease agreement (PDF)
- Move-in inspection reports
- Lease addenda
- Any other documents your landlord has attached to your lease record

Click the **Download** button next to any file to open or save it.

If a document is missing that you expect to see, contact your landlord —
they may need to attach it to your lease record.

---

## 5. Maintenance Requests

Navigate to **Maintenance Tickets** (`/helpdesk`) to:

- **Submit a new maintenance request** — click "New Ticket", describe the
  issue, and attach photos if helpful
- **Track existing requests** — see the status and any updates from your
  landlord or assigned vendor

When your landlord assigns a vendor to your ticket, the vendor may contact
you directly via phone to schedule access.

---

## 6. SMS Notifications

You will receive automated text messages from your landlord's system. You do
not need to reply to these — they are informational. You can reply STOP to any
message to opt out of SMS notifications.

| Message | When you receive it |
|---|---|
| Overdue rent reminder | When a rent invoice is past its due date |
| Lease renewal reminder | 90, 60, 30, and 14 days before your lease expires |
| Late fee notice | On the first day a late fee is applied to your account |
| Lease signed confirmation | After both you and your landlord have signed the lease |

### Late fee notice example
```
Late fee of $142.50 added to your balance at Unit 3A (day 6 overdue).
Total now due: $2,992.50. Pay at your tenant portal to stop daily charges.
```

---

## 7. Signing Your Lease (BoldSign)

When your landlord sends you a new lease to sign, you will receive an email
from BoldSign (noreply@boldsign.com) with a **"Sign Now"** link.

**How to sign:**
1. Open the email and click the **Sign Now** button
2. Review the lease document
3. Click each signature and initial field and complete them
4. Click **Finish** to submit your signature

Your landlord will then countersign. Once both parties have signed:
- You receive a confirmation SMS
- The fully executed PDF is stored securely in your document portal
- A copy is emailed to you by BoldSign

> **Tip:** Check your spam folder if you do not receive the BoldSign email
> within a few minutes of your landlord sending it.

---

## 8. Common Questions

**My invoice shows the wrong amount.**
Contact your landlord directly. They can correct the invoice in ERPNext.

**I paid but my invoice still shows as outstanding.**
ACH payments take 1–3 business days to clear. Card payments update
immediately. If more than 3 business days have passed, contact your landlord.

**I'm not receiving SMS messages.**
Confirm your phone number is correct with your landlord. You may also have
previously replied STOP — your landlord can re-enroll you.

**I can't see my lease on the My Lease page.**
Your lease may not have been set to "Active" in ERPNext yet. Contact your
landlord to confirm your lease record has been created and activated.

**I want to change my email address.**
Contact your landlord — they will update your account in ERPNext.
