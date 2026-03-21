'use strict';

/**
 * BoldSign direct document send — pre-filled PDF approach.
 *
 * WHY THIS EXISTS:
 *   BoldSign templates assign textbox fields to signer roles (e.g. Tenant).
 *   Those role-specific fields are HIDDEN from other signers (Property Manager)
 *   during signing — even when pre-filled via existingFormFields in the API.
 *
 * HOW WE FIX IT:
 *   1. Download the blank lease PDF from BoldSign's template.
 *   2. Use pdf-lib to overlay ALL data values as plain text directly on the PDF
 *      at the exact positions the template fields would appear.
 *   3. Upload the filled PDF to BoldSign via POST /v1/document/send.
 *   4. Add only Signature, Initial, and Date fields — things the signers
 *      actually need to provide. No pre-filled textboxes needed.
 *   5. Because the data is baked into the PDF, EVERY signer sees it.
 *
 * COORDINATE SYSTEM:
 *   BoldSign uses 96 DPI pixel coordinates (top-left origin, y increases down).
 *   PDF uses 72 DPI point coordinates (bottom-left origin, y increases up).
 *   Conversion: scale = 72/96 = 0.75
 *     pdf_x = bs_x * 0.75
 *     pdf_y = page_height_pts - (bs_y + bs_h) * 0.75
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const FormData = require('form-data');
const axios    = require('axios');
const logger   = require('../logger');

// ─── Constants ────────────────────────────────────────────────────────────────

const BOLDSIGN_SCALE   = 0.75;   // 72 / 96 DPI
const PDF_PAGE_HEIGHT  = 792;    // Letter page in pts (72 DPI)
const DEFAULT_FONT_PTS = 9.5;    // Fits all template textbox heights when scaled
const TEXT_COLOR       = rgb(0, 0, 0);

// ─── OH_LEASE field layout (all textbox fields from template properties) ──────
//
// Each entry: { page, x, y, w, h } — all in BoldSign 96-DPI coordinates.
// getValue(vars) returns the string to overlay.
// Fields marked editable=true should remain blank (tenant fills during signing).

const OH_LEASE_TEXT_OVERLAYS = [
  // ── Page 1: Parties ──────────────────────────────────────────────────────
  // Row 1: Owner/Landlord Name
  { page: 1,  x: 334.7, y: 165.3, w: 365.3, h: 21.3, getValue: v => v.landlord_name },
  // Row 2: Landlord full address (field placeholder says "Street, city, state, ZIP")
  { page: 1,  x: 334.7, y: 197.3, w: 365.3, h: 40.0, getValue: v => v.landlord_address },
  // Row 3: Managing agent name — blank (self-managed), t_cf14dc5a
  // Row 4: Agent address — blank (self-managed), t_1cf28b18
  // Row 5: Phone/Email contact
  { page: 1,  x: 334.7, y: 305.3, w: 365.3, h: 24.0, getValue: v => v.landlord_phone },
  // Row 6: Tenant full legal name
  { page: 1,  x: 334.7, y: 338.7, w: 365.3, h: 24.0, getValue: v => v.tenant_name },
  // Row 7: Additional Occupants — blank (no additional occupants), t_526887b1
  // Row 8: Rental property street address
  { page: 1,  x: 334.7, y: 404.0, w: 365.3, h: 24.0, getValue: v => v.unit_address },
  // Row 9: City, State, ZIP of rental property
  { page: 1,  x: 334.7, y: 436.0, w: 365.3, h: 24.0, getValue: v => v.city_state_zip },
  { page: 1,  x: 334.7, y: 469.3, w: 172.0, h: 24.0, getValue: v => v.start_date },
  { page: 1,  x: 573.3, y: 469.3, w: 133.3, h: 24.0, getValue: v => v.end_date },
  // NOTE: field at y=503 is positioned inside the Monthly Rent row (verified via PDF rendering)
  //       field at y=553 is positioned inside the Security Deposit row
  { page: 1,  x: 353.3, y: 502.7, w: 220.0, h: 22.7, getValue: v => v.monthly_rent },
  { page: 1,  x: 334.7, y: 553.3, w: 172.0, h: 24.0, getValue: v => v.security_deposit },
  // ── Page 2: Rent details ─────────────────────────────────────────────────
  { page: 2,  x: 173.3, y: 152.7, w: 146.7, h: 22.7, getValue: v => v.monthly_rent },
  { page: 2,  x: 202.7, y: 392.7, w: 150.7, h: 22.7, getValue: v => v.security_deposit },
  // tenant forwarding address (p2 y=785) — leave blank for tenant to fill
  // ── Page 3: Lease term repeat ────────────────────────────────────────────
  { page: 3,  x: 240.0, y:  74.7, w: 133.3, h: 22.7, getValue: v => v.start_date },
  { page: 3,  x: 450.7, y:  74.7, w: 133.3, h: 22.7, getValue: v => v.end_date },
  // ── Page 13: Signature block — tenant ────────────────────────────────────
  { page: 13, x: 104.0, y: 673.3, w: 216.0, h: 24.0, getValue: v => v.tenant_name },
  // ── Page 13: Signature block — landlord ─────────────────────────────────
  { page: 13, x: 104.0, y: 329.3, w: 216.0, h: 24.0, getValue: v => v.landlord_name },
  { page: 13, x: 411.3, y: 329.3, w: 320.0, h: 24.0, getValue: v => 'Property Manager' },
  { page: 13, x: 104.0, y: 397.3, w: 360.0, h: 24.0, getValue: v => v.landlord_address },
];

// ─── OH_LEASE signer form fields (Signature / Initial / Date) ─────────────────
// These are passed to BoldSign's document/send API in BoldSign coordinates.

const OH_LEASE_TENANT_FIELDS = [
  // Initials — one per content page
  { fieldType: 'Initial', page:  2, x: 368, y: 824, w: 159, h: 20 },
  { fieldType: 'Initial', page:  3, x: 368, y: 852, w: 159, h: 20 },
  { fieldType: 'Initial', page:  4, x: 368, y: 680, w: 159, h: 20 },
  { fieldType: 'Initial', page:  5, x: 368, y: 384, w: 159, h: 20 },
  { fieldType: 'Initial', page:  6, x: 368, y: 388, w: 159, h: 20 },
  { fieldType: 'Initial', page:  6, x: 368, y: 944, w: 159, h: 20 },
  { fieldType: 'Initial', page:  7, x: 368, y: 340, w: 159, h: 20 },
  { fieldType: 'Initial', page:  8, x: 368, y: 603, w: 159, h: 20 },
  { fieldType: 'Initial', page:  9, x: 368, y: 556, w: 159, h: 20 },
  { fieldType: 'Initial', page: 11, x: 368, y:  89, w: 159, h: 20 },
  { fieldType: 'Initial', page: 11, x: 368, y: 479, w: 159, h: 20 },
  { fieldType: 'Initial', page: 12, x: 368, y: 932, w: 159, h: 20 },
  // Signature + Date on page 13
  { fieldType: 'Signature',   page: 13, x: 104, y: 707, w: 269, h: 36 },
  { fieldType: 'DateSigned',  page: 13, x: 104, y: 741, w: 176, h: 24 },
];

const OH_LEASE_PM_FIELDS = [
  { fieldType: 'Signature',  page: 13, x: 104, y: 363, w: 269, h: 36 },
  { fieldType: 'DateSigned', page: 13, x: 411, y: 363, w: 183, h: 24 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildHttpsAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxyUrl) return undefined;
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(proxyUrl);
  } catch (_) { return undefined; }
}

const httpsAgent = buildHttpsAgent();

const http = axios.create({
  baseURL: 'https://api.boldsign.com/v1',
  headers: {
    'X-API-KEY': process.env.BOLDSIGN_API_KEY || '',
    Accept: 'application/json',
  },
  timeout: 60_000,
  maxContentLength: Infinity,
  maxBodyLength:    Infinity,
  ...(httpsAgent ? { httpsAgent, proxy: false } : {}),
});

/**
 * Download the blank template PDF from BoldSign.
 * Returns a Buffer with the PDF bytes.
 */
async function downloadTemplatePdf(templateId) {
  const response = await http.get('/template/download', {
    params:       { templateId },
    responseType: 'arraybuffer',
  });
  return Buffer.from(response.data);
}

/**
 * Overlay all lease variable data as plain text on the blank PDF.
 * Returns a Buffer with the filled PDF bytes.
 *
 * @param {Buffer} pdfBuffer  — Blank template PDF
 * @param {Object} vars       — Pre-processed variables (see buildVars below)
 * @param {Array}  textFields — Array of {page, x, y, w, h, getValue} descriptors
 */
async function overlayTextOnPdf(pdfBuffer, vars, textFields) {
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages  = pdfDoc.getPages();

  for (const field of textFields) {
    const value = field.getValue(vars);
    if (!value) continue;

    const pageIndex = field.page - 1;
    if (pageIndex < 0 || pageIndex >= pages.length) continue;

    const page   = pages[pageIndex];
    const x_pdf  = field.x * BOLDSIGN_SCALE;
    // Y: BoldSign top-down → pdf-lib bottom-up
    const y_pdf  = PDF_PAGE_HEIGHT - (field.y + field.h) * BOLDSIGN_SCALE + 2; // +2 baseline offset

    // Clip text to field width
    const maxWidth    = field.w * BOLDSIGN_SCALE;
    const fontSize    = DEFAULT_FONT_PTS;
    const textWidth   = font.widthOfTextAtSize(value, fontSize);
    const displayText = textWidth <= maxWidth
      ? value
      : value.slice(0, Math.floor(value.length * (maxWidth / textWidth)));

    page.drawText(displayText, { x: x_pdf, y: y_pdf, size: fontSize, font, color: TEXT_COLOR });
  }

  return Buffer.from(await pdfDoc.save());
}

/**
 * Append BoldSign form fields (Signature, Initial, DateSigned) to a multipart form.
 * Uses BoldSign's native coordinate system (96-DPI, top-left origin).
 */
function appendSignerFields(form, signerIndex, fields) {
  fields.forEach((f, fi) => {
    const base = `Signers[${signerIndex}][FormFields][${fi}]`;
    form.append(`${base}[FieldType]`,       f.fieldType);
    form.append(`${base}[PageNumber]`,      String(f.page));
    form.append(`${base}[Bounds][X]`,       String(f.x));
    form.append(`${base}[Bounds][Y]`,       String(f.y));
    form.append(`${base}[Bounds][Width]`,   String(f.w));
    form.append(`${base}[Bounds][Height]`,  String(f.h));
    if (f.fieldType === 'DateSigned') {
      form.append(`${base}[DateFormat]`, 'MM/dd/yyyy');
    }
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Format ISO date (YYYY-MM-DD) → MM/DD/YYYY.
 */
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-');
  return `${m}/${d}/${y}`;
}

/**
 * Split landlord address into { street, city, stateZip }.
 */
function parseLandlordAddress(addr) {
  if (!addr) return { street: '', city: '', stateZip: '' };
  const m3 = addr.match(/^(.+?),\s*([^,]+?),\s*([A-Z]{2}\s+\d{5}(?:-\d{4})?)$/);
  if (m3) return { street: m3[1].trim(), city: m3[2].trim(), stateZip: m3[3].trim() };
  const m2 = addr.match(/^(.+?),\s*(.+\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)$/);
  if (m2) return { street: m2[1].trim(), city: '', stateZip: m2[2].trim() };
  return { street: addr.trim(), city: '', stateZip: '' };
}

/**
 * Build the flat variable map expected by OH_LEASE_TEXT_OVERLAYS.
 */
function buildVars(params) {
  const la = parseLandlordAddress(params.variables.landlord_address);
  const v  = params.variables;
  const cityStateZip = [v.unit_city, v.unit_state].filter(Boolean).join(', ') +
                       (v.unit_zip ? ` ${v.unit_zip}` : '');
  return {
    landlord_name:     v.landlord_name     || '',
    landlord_street:   la.street           || '',
    landlord_city:     la.city             || '',
    landlord_state_zip: la.stateZip        || '',
    landlord_phone:    v.landlord_phone    || v.landlord_email || '',
    landlord_address:  v.landlord_address  || '',
    tenant_name:       v.tenant_name       || '',
    unit_address:      v.unit_address      || '',
    city_state_zip:    cityStateZip,
    start_date:        fmtDate(v.start_date),
    end_date:          fmtDate(v.end_date),
    monthly_rent:      String(v.monthly_rent      || ''),
    security_deposit:  String(v.security_deposit  || ''),
  };
}

/**
 * Send an Ohio Lease Agreement directly (not from template).
 * Pre-fills all data as PDF text overlays, adds only Signature/Initial/Date fields.
 *
 * @param {Object} params
 *   Same shape as boldsign.sendDocumentForSignature.
 * @returns {{ documentId: string }}
 */
async function sendOhLeaseDirectly(params) {
  const {
    tenantEmail, tenantName,
    landlordEmail, landlordName,
    variables = {},
  } = params;

  const templateId = process.env.BOLDSIGN_TEMPLATE_OH_LEASE;
  if (!templateId) throw new Error('BOLDSIGN_TEMPLATE_OH_LEASE env var not set');

  const vars = buildVars(params);

  logger.info('BoldSign-direct: building pre-filled lease PDF', {
    landlord: vars.landlord_name,
    tenant:   vars.tenant_name,
    unit:     vars.unit_address,
    rent:     vars.monthly_rent,
    dates:    `${vars.start_date} – ${vars.end_date}`,
  });

  // 1. Download blank template PDF
  const blankPdf  = await downloadTemplatePdf(templateId);
  logger.info('BoldSign-direct: blank template downloaded', { bytes: blankPdf.length });

  // 2. Overlay data as text
  const filledPdf = await overlayTextOnPdf(blankPdf, vars, OH_LEASE_TEXT_OVERLAYS);
  logger.info('BoldSign-direct: PDF text overlay complete', { bytes: filledPdf.length });

  // 3. Build multipart form for BoldSign document/send
  const form = new FormData();
  form.append('Title',   'Lease Agreement — Signature Required');
  form.append('Message', 'Please review and sign the attached lease agreement at your earliest convenience.');

  // Signer 1: Tenant (signs first)
  form.append('Signers[0][Name]',         tenantName);
  form.append('Signers[0][EmailAddress]', tenantEmail);
  form.append('Signers[0][SignerOrder]',  '1');
  form.append('Signers[0][SignerType]',   'Signer');
  appendSignerFields(form, 0, OH_LEASE_TENANT_FIELDS);

  // Signer 2: Property Manager (signs second — sees tenant fields signed)
  form.append('Signers[1][Name]',         landlordName);
  form.append('Signers[1][EmailAddress]', landlordEmail);
  form.append('Signers[1][SignerOrder]',  '2');
  form.append('Signers[1][SignerType]',   'Signer');
  appendSignerFields(form, 1, OH_LEASE_PM_FIELDS);

  // Reminder settings
  form.append('ReminderSettings[EnableAutoReminder]', 'true');
  form.append('ReminderSettings[ReminderDays]',       '3');
  form.append('ReminderSettings[ReminderCount]',      '3');

  // Attach the pre-filled PDF
  form.append('Files', filledPdf, { filename: 'ohio-lease-agreement.pdf', contentType: 'application/pdf' });

  // 4. Send to BoldSign
  let data;
  try {
    ({ data } = await http.post('/document/send', form, {
      headers: { ...form.getHeaders() },
    }));
  } catch (err) {
    const detail = err.response?.data;
    logger.error('BoldSign-direct: API error', {
      status:   err.response?.status,
      response: typeof detail === 'object' ? detail : String(detail).slice(0, 500),
    });
    throw err;
  }

  const documentId = data.documentId || data.DocumentId || '';
  logger.info('BoldSign-direct: document sent', { documentId, tenantEmail });
  return { documentId };
}

module.exports = { sendOhLeaseDirectly, buildVars, OH_LEASE_TEXT_OVERLAYS };
