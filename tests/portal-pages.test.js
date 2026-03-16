'use strict';

/**
 * Tests for every page/form setup function in setup-tenant-portal.js.
 *
 * Verifies:
 *  – The exact document NAME passed to upsert() (critical: Frappe derives the
 *    Web Page primary key from the title slug, not from whatever name we pass,
 *    so mismatches cause DuplicateEntryError on subsequent runs).
 *  – customFieldExists() query behaviour.
 *  – ensureLeadApplicationFields() creates missing fields and silently
 *    skips standard-field conflicts.
 *  – configureApplyWebForm() creates fields BEFORE creating the Web Form.
 */

jest.mock('axios');
const axios = require('axios');

const mockGet  = jest.fn();
const mockPost = jest.fn();
const mockPut  = jest.fn();

const mockHttp = {
  get:  mockGet,
  post: mockPost,
  put:  mockPut,
  interceptors: { response: { use: jest.fn() } },
};

beforeEach(() => {
  jest.resetAllMocks();
  axios.create.mockReturnValue(mockHttp);
});

let h; // module handle (loaded once per describe so axios.create is already mocked)
beforeAll(() => {
  axios.create.mockReturnValue(mockHttp);
  h = require('../scripts/setup-tenant-portal');
});

// ─── customFieldExists ────────────────────────────────────────────────────────

describe('customFieldExists()', () => {
  test('returns true when the API finds at least one matching Custom Field', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ name: 'Lead-custom_date_of_birth' }] } });
    const result = await h.customFieldExists('Lead', 'custom_date_of_birth');
    expect(result).toBe(true);
  });

  test('returns false when the API returns an empty data array', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    const result = await h.customFieldExists('Lead', 'custom_date_of_birth');
    expect(result).toBe(false);
  });

  test('returns false when the API returns no data key at all', async () => {
    mockGet.mockResolvedValue({ data: {} });
    const result = await h.customFieldExists('Lead', 'custom_date_of_birth');
    expect(result).toBe(false);
  });

  test('returns false when the GET throws (treats as not found)', async () => {
    mockGet.mockRejectedValue(new Error('Network error'));
    const result = await h.customFieldExists('Lead', 'custom_date_of_birth');
    expect(result).toBe(false);
  });

  test('sends the correct filters to the API', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    await h.customFieldExists('Lead', 'custom_has_pets');
    const [, opts] = mockGet.mock.calls[0];
    const filters = JSON.parse(opts.params.filters);
    expect(filters).toContainEqual(['dt', '=', 'Lead']);
    expect(filters).toContainEqual(['fieldname', '=', 'custom_has_pets']);
  });
});

// ─── ensureLeadApplicationFields ─────────────────────────────────────────────

describe('ensureLeadApplicationFields()', () => {
  test('creates a field when it does not yet exist', async () => {
    // customFieldExists → false, then POST succeeds
    mockGet.mockResolvedValue({ data: { data: [] } });
    mockPost.mockResolvedValue({ data: { data: { name: 'Lead-custom_date_of_birth' } } });

    await h.ensureLeadApplicationFields();

    const posts = mockPost.mock.calls.filter(([path]) => path === '/api/resource/Custom Field');
    expect(posts.length).toBeGreaterThan(0);
    const fieldnames = posts.map(([, payload]) => payload.fieldname);
    expect(fieldnames).toContain('custom_date_of_birth');
    expect(fieldnames).toContain('custom_consent_accuracy');
  });

  test('skips a field that is already a custom field (GET returns a record)', async () => {
    // All custom fields "already exist" — customFieldExists returns true
    mockGet.mockResolvedValue({ data: { data: [{ name: 'x' }] } });

    await h.ensureLeadApplicationFields();

    // No POST should be issued
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('silently skips a field that conflicts with a standard Lead field', async () => {
    // customFieldExists → false, POST returns "already appears in the standard form"
    mockGet.mockResolvedValue({ data: { data: [] } });
    const stdErr = Object.assign(new Error('Validation failed'), {
      response: { data: { exception: 'Fieldname already appears in the standard form of Lead' } },
    });
    mockPost.mockRejectedValue(stdErr);

    // Should NOT throw
    await expect(h.ensureLeadApplicationFields()).resolves.toBeUndefined();
  });

  test('creates all 16 expected fields (14 custom + designation + lead_source)', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    mockPost.mockResolvedValue({ data: { data: { name: 'ok' } } });

    await h.ensureLeadApplicationFields();

    const created = mockPost.mock.calls
      .filter(([path]) => path === '/api/resource/Custom Field')
      .map(([, p]) => p.fieldname);

    const expectedFields = [
      'designation', 'lead_source',
      'custom_date_of_birth', 'custom_current_address', 'custom_monthly_rent_paid',
      'custom_current_landlord_name', 'custom_current_landlord_phone',
      'custom_monthly_gross_income', 'custom_employment_start_date',
      'custom_eviction_history', 'custom_broken_lease_history',
      'custom_number_of_occupants', 'custom_has_pets', 'custom_pet_description',
      'custom_consent_background_check', 'custom_consent_accuracy',
    ];
    for (const f of expectedFields) {
      expect(created).toContain(f);
    }
  });

  test('sets dt=Lead on every field posted', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    mockPost.mockResolvedValue({ data: { data: { name: 'ok' } } });

    await h.ensureLeadApplicationFields();

    for (const [, payload] of mockPost.mock.calls.filter(([p]) => p === '/api/resource/Custom Field')) {
      expect(payload.dt).toBe('Lead');
    }
  });
});

// ─── configureMyDocsPage ──────────────────────────────────────────────────────

describe('configureMyDocsPage()', () => {
  /**
   * THE CRITICAL FIX TEST:
   * Frappe derives the Web Page document name from the title slug
   * ('My Documents' → 'my-documents'), not from the name we pass.
   * The code must use 'my-documents' as the lookup/upsert key so that
   * getDoc() finds the existing record and PUTs instead of failing with
   * DuplicateEntryError on the second run.
   */
  test('upserts with name "my-documents" (title-slug), NOT "my-docs"', async () => {
    // Simulate: document already exists under 'my-documents'
    mockGet.mockResolvedValue({ data: { data: { name: 'my-documents' } } });
    mockPut.mockResolvedValue({ data: { data: { name: 'my-documents' } } });

    await h.configureMyDocsPage();

    // getDoc should have looked up 'my-documents'
    expect(mockGet).toHaveBeenCalledWith('/api/resource/Web%20Page/my-documents');
    // Should PUT (update), never POST (create)
    expect(mockPut).toHaveBeenCalledWith(
      '/api/resource/Web%20Page/my-documents',
      expect.objectContaining({ title: 'My Documents' })
    );
    expect(mockPost).not.toHaveBeenCalledWith(
      '/api/resource/Web%20Page',
      expect.objectContaining({ name: 'my-docs' })
    );
  });

  test('sets route "my-docs" so the page is accessible at /my-docs', async () => {
    mockGet.mockResolvedValue({ data: { data: { name: 'my-documents' } } });
    mockPut.mockResolvedValue({ data: { data: {} } });

    await h.configureMyDocsPage();

    expect(mockPut).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ route: 'my-docs' })
    );
  });

  test('publishes the page (published: 1)', async () => {
    mockGet.mockResolvedValue({ data: { data: { name: 'my-documents' } } });
    mockPut.mockResolvedValue({ data: { data: {} } });

    await h.configureMyDocsPage();

    const [, payload] = mockPut.mock.calls[0];
    expect(payload.published).toBe(1);
  });

  test('creates the page via POST when it does not yet exist', async () => {
    const notFound = Object.assign(new Error('404'), { response: { status: 404 } });
    mockGet.mockRejectedValue(notFound);
    mockPost.mockResolvedValue({ data: { data: { name: 'my-documents' } } });

    await h.configureMyDocsPage();

    expect(mockPost).toHaveBeenCalledWith(
      '/api/resource/Web%20Page',
      expect.objectContaining({ name: 'my-documents', route: 'my-docs', title: 'My Documents' })
    );
  });

  test('page body contains the /api/resource/Lease fetch call', async () => {
    mockGet.mockResolvedValue({ data: { data: { name: 'my-documents' } } });
    mockPut.mockResolvedValue({ data: { data: {} } });

    await h.configureMyDocsPage();

    const [, payload] = mockPut.mock.calls[0];
    expect(payload.main_section_html).toContain('/api/resource/Lease');
    expect(payload.main_section_html).toContain('/api/resource/File');
  });
});

// ─── configureMyInvoicesPage ──────────────────────────────────────────────────

describe('configureMyInvoicesPage()', () => {
  test('upserts Web Page with name "invoices-due" and route "my-invoices"', async () => {
    const notFound = Object.assign(new Error('404'), { response: { status: 404 } });
    mockGet.mockRejectedValue(notFound);
    mockPost.mockResolvedValue({ data: { data: { name: 'invoices-due' } } });

    await h.configureMyInvoicesPage();

    expect(mockPost).toHaveBeenCalledWith(
      '/api/resource/Web%20Page',
      expect.objectContaining({ name: 'invoices-due', route: 'my-invoices' })
    );
  });
});

// ─── configurePaidInvoicesPage ───────────────────────────────────────────────

describe('configurePaidInvoicesPage()', () => {
  test('upserts Web Page with name "paid-invoices" and route "paid-invoices"', async () => {
    // configurePaidInvoicesPage first GETs Website Settings (direct http.get, no getDoc),
    // then calls upsert which calls getDoc for the Web Page (404 → POST).
    const notFound = Object.assign(new Error('404'), { response: { status: 404 } });
    mockGet
      .mockResolvedValueOnce({ data: { data: { head_html: '' } } })   // Website Settings
      .mockRejectedValueOnce(notFound);                                // getDoc Web Page → 404
    mockPost.mockResolvedValue({ data: { data: { name: 'paid-invoices' } } });

    await h.configurePaidInvoicesPage();

    expect(mockPost).toHaveBeenCalledWith(
      '/api/resource/Web%20Page',
      expect.objectContaining({ name: 'paid-invoices', route: 'paid-invoices' })
    );
  });
});

// ─── configureMyLeasePage ────────────────────────────────────────────────────

describe('configureMyLeasePage()', () => {
  test('upserts Web Page with name "my-lease" and route "my-lease"', async () => {
    const notFound = Object.assign(new Error('404'), { response: { status: 404 } });
    mockGet.mockRejectedValue(notFound);
    mockPost.mockResolvedValue({ data: { data: { name: 'my-lease' } } });

    await h.configureMyLeasePage();

    expect(mockPost).toHaveBeenCalledWith(
      '/api/resource/Web%20Page',
      expect.objectContaining({ name: 'my-lease', route: 'my-lease' })
    );
  });
});

// ─── configureApplyWebForm ───────────────────────────────────────────────────

describe('configureApplyWebForm()', () => {
  test('creates Lead custom fields BEFORE creating the Web Form', async () => {
    // All customFieldExists calls return false → try to create each field
    mockGet.mockResolvedValue({ data: { data: [] } });
    mockPost.mockResolvedValue({ data: { data: { name: 'ok' } } });

    await h.configureApplyWebForm();

    const calls = mockPost.mock.calls;
    const customFieldPosts = calls.filter(([p]) => p === '/api/resource/Custom Field');
    const webFormPosts     = calls.filter(([p]) => p === '/api/resource/Web%20Form');

    // Custom fields must be created first
    expect(customFieldPosts.length).toBeGreaterThan(0);
    if (webFormPosts.length > 0) {
      const firstCfIdx  = calls.indexOf(customFieldPosts[0]);
      const firstWfIdx  = calls.indexOf(webFormPosts[0]);
      expect(firstCfIdx).toBeLessThan(firstWfIdx);
    }
  });

  // Helper: mock that returns empty array for Custom Field checks (fields don't exist)
  // and 404 for the Web Form getDoc, so upsert POSTs instead of PUTs.
  function mockForWebFormCreation() {
    const notFound = Object.assign(new Error('404'), { response: { status: 404 } });
    mockGet.mockImplementation((url) => {
      if (url === '/api/resource/Custom Field') {
        return Promise.resolve({ data: { data: [] } }); // no custom field yet
      }
      // Web Form getDoc → 404 (not created yet)
      return Promise.reject(notFound);
    });
    mockPost.mockResolvedValue({ data: { data: { name: 'ok' } } });
  }

  test('Web Form uses doc_type "Lead" and is published', async () => {
    mockForWebFormCreation();
    await h.configureApplyWebForm();

    const wfPost = mockPost.mock.calls.find(([p]) => p === '/api/resource/Web%20Form');
    expect(wfPost).toBeDefined();
    const [, payload] = wfPost;
    expect(payload.doc_type).toBe('Lead');
    expect(payload.published).toBe(1);
    expect(payload.login_required).toBe(0);
  });

  test('Web Form includes all 14 custom_* fields in web_form_fields', async () => {
    mockForWebFormCreation();
    await h.configureApplyWebForm();

    const wfPost = mockPost.mock.calls.find(([p]) => p === '/api/resource/Web%20Form');
    const fields = wfPost[1].web_form_fields.map(f => f.fieldname);

    const requiredCustomFields = [
      'custom_date_of_birth', 'custom_current_address', 'custom_monthly_rent_paid',
      'custom_current_landlord_name', 'custom_current_landlord_phone',
      'custom_monthly_gross_income', 'custom_employment_start_date',
      'custom_eviction_history', 'custom_broken_lease_history',
      'custom_number_of_occupants', 'custom_has_pets', 'custom_pet_description',
      'custom_consent_background_check', 'custom_consent_accuracy',
    ];
    for (const f of requiredCustomFields) {
      expect(fields).toContain(f);
    }
  });

  test('Web Form has lead_source hidden field defaulting to "Online Application"', async () => {
    mockForWebFormCreation();
    await h.configureApplyWebForm();

    const wfPost  = mockPost.mock.calls.find(([p]) => p === '/api/resource/Web%20Form');
    const lsField = wfPost[1].web_form_fields.find(f => f.fieldname === 'lead_source');
    expect(lsField).toBeDefined();
    expect(lsField.hidden).toBe(1);
    expect(lsField.default).toBe('Online Application');
  });

  test('updates the existing Web Form via PUT when it already exists', async () => {
    // All customFieldExists → true (fields exist), Web Form already exists
    mockGet.mockResolvedValue({ data: { data: { name: 'ok' } } });
    mockPut.mockResolvedValue({ data: { data: { name: 'Rental Application' } } });

    await h.configureApplyWebForm();

    expect(mockPut).toHaveBeenCalledWith(
      '/api/resource/Web%20Form/Rental%20Application',
      expect.objectContaining({ doc_type: 'Lead' })
    );
    expect(mockPost).not.toHaveBeenCalledWith('/api/resource/Web%20Form', expect.any(Object));
  });
});
