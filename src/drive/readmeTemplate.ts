export interface BusinessMeta {
  name: string;
  legal_name?: string | null;
  gstin?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

interface CsvDescription {
  file: string;
  represents: string;
}

const CSV_TABLE: readonly CsvDescription[] = [
  { file: 'customers.csv', represents: 'Customer master (name, GSTIN, contact, address)' },
  { file: 'suppliers.csv', represents: 'Supplier master (name, GSTIN, contact, address)' },
  { file: 'items.csv', represents: 'Product / service catalogue (name, HSN, tax rate, unit)' },
  { file: 'categories.csv', represents: 'Item categories' },
  { file: 'units.csv', represents: 'Units of measure (PCS, KG, MTR, etc.)' },
  { file: 'warehouses.csv', represents: 'Storage locations for stock' },
  { file: 'invoices.csv', represents: 'Sales invoice headers (customer, date, totals, status)' },
  { file: 'invoice_items.csv', represents: 'Line items on each sales invoice' },
  { file: 'purchases.csv', represents: 'Purchase bill headers (supplier, date, totals)' },
  { file: 'purchase_items.csv', represents: 'Line items on each purchase bill' },
  { file: 'payments.csv', represents: 'Money received from customers or paid to suppliers' },
  { file: 'expenses.csv', represents: 'Business expenses (rent, utilities, etc.)' },
  { file: 'stock_movements.csv', represents: 'Every inventory in/out movement (source of truth for stock)' },
  { file: 'accounts.csv', represents: 'Chart of accounts (ledger heads)' },
  { file: 'journal_entries.csv', represents: 'Double-entry journal headers' },
  { file: 'journal_lines.csv', represents: 'Debit / credit lines belonging to each journal entry' },
  { file: 'orders.csv', represents: 'Sales orders and quotations (pre-invoice stage)' },
  { file: 'returns.csv', represents: 'Sales returns and purchase returns' },
  { file: 'audit_log.csv', represents: 'Chronological log of significant changes' },
];

const NO_EDIT_FILES: readonly string[] = [
  'metadata/manifest.json',
  'metadata/schema.json',
  'metadata/sync-state.json',
  'metadata/checksums.json',
  'journal/**/*.events.jsonl',
  'current/invoices.csv',
  'current/invoice_items.csv',
  'current/payments.csv',
  'current/journal_entries.csv',
  'current/journal_lines.csv',
];

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function renderCsvTable(): string {
  const fileWidth = Math.max(
    'File'.length,
    ...CSV_TABLE.map((row) => row.file.length),
  );
  const repWidth = Math.max(
    'Represents'.length,
    ...CSV_TABLE.map((row) => row.represents.length),
  );
  const border = '+' + '-'.repeat(fileWidth + 2) + '+' + '-'.repeat(repWidth + 2) + '+';
  const header = '| ' + pad('File', fileWidth) + ' | ' + pad('Represents', repWidth) + ' |';
  const rows = CSV_TABLE.map(
    (row) => '| ' + pad(row.file, fileWidth) + ' | ' + pad(row.represents, repWidth) + ' |',
  );
  return [border, header, border, ...rows, border].join('\n');
}

export function renderReadme(business: BusinessMeta): string {
  const displayName = business.name.trim() || 'My Business';
  const legalLine = business.legal_name && business.legal_name !== business.name
    ? `Legal name: ${business.legal_name}`
    : null;
  const gstinLine = business.gstin ? `GSTIN: ${business.gstin}` : null;
  const locationLine = [business.city, business.state, business.country]
    .filter((part): part is string => !!part && part.trim().length > 0)
    .join(', ');

  const identityLines = [
    `Business: ${displayName}`,
    legalLine,
    gstinLine,
    locationLine ? `Location: ${locationLine}` : null,
  ].filter((line): line is string => line !== null);

  const noEditBlock = NO_EDIT_FILES.map((f) => `    - ${f}`).join('\n');

  return `BusinessVault
=============

${identityLines.join('\n')}

This folder is the customer-controlled Google Drive backup for the
business named above. It is written and maintained by the BusinessVault
application on your device(s). Everything needed to reconstruct your
business on a brand-new device is inside this folder.

You do not need our servers to recover your data. If our service ever
disappears, you still have your business here.

--------------------------------------------------------------------
1. WHAT THIS FOLDER CONTAINS
--------------------------------------------------------------------

    README.txt              This file.

    metadata/               Structural files that describe the backup
                            (versioning, schema, sync state, integrity
                            checksums). Managed by the application.

    current/                Latest full CSV snapshot of your business
                            data. Portable, human-readable, opens in
                            Excel / LibreOffice / Google Sheets.

    journal/YYYY/           Append-only event journal in JSONL format,
                            organised by year and month. Records every
                            change since the last snapshot. This is
                            what makes recovery lossless between
                            snapshots.

    invoices/               PDF copies of issued invoices, grouped by
                            financial year (e.g. 2026-27/).

    attachments/            Files you attached to purchases, expenses,
                            or products (bills, receipts, images).

    reports/                Generated reports (GSTR, P&L, Balance
                            Sheet, etc.) placed here on request.

    snapshots/daily/        Rolling daily backups.
    snapshots/monthly/      End-of-month snapshots.
    snapshots/annual/       Financial-year archives.

--------------------------------------------------------------------
2. THE CSV FILES IN current/
--------------------------------------------------------------------

Every CSV is a portable snapshot of one table in your business.
CSV files are NOT what the application uses day-to-day; the
application runs from a local database on your device. The CSVs
are regenerated periodically so you always have a readable copy.

${renderCsvTable()}

--------------------------------------------------------------------
3. HOW THE TABLES RELATE TO EACH OTHER
--------------------------------------------------------------------

Each CSV has an "id" column that uniquely identifies a row. Other
tables refer to that row by putting the same id value in a column
whose name ends in "_id" (or a similarly named reference column).

    - id                    Primary key of this table (a UUID / ULID).
    - <something>_id        Foreign key pointing to the "id" column
                            of another table.

Concrete examples:

    invoice_items.invoice_id     -> invoices.id
    invoice_items.item_id        -> items.id
    invoices.customer_id         -> customers.id
    purchases.supplier_id        -> suppliers.id
    purchase_items.purchase_id   -> purchases.id
    payments.party_id            -> customers.id  OR  suppliers.id
                                    (see payments.party_type)
    stock_movements.item_id      -> items.id
    stock_movements.ref_id       -> invoices.id / purchases.id / etc.
                                    (see stock_movements.ref_type)
    journal_lines.entry_id       -> journal_entries.id
    journal_lines.account_id     -> accounts.id

For a machine-readable description of every column in every file,
see metadata/schema.json in this folder.

--------------------------------------------------------------------
4. WHAT UUID / ID COLUMNS MEAN
--------------------------------------------------------------------

Columns named "id", or ending in "_id", contain UUID-style values
that look like:

    01JAZK9F7QK8Y0V1H0J8T4W2X3

These are STABLE INTERNAL IDENTIFIERS. They exist so the tables
can reference each other reliably even when a row is renamed or
edited. They are NOT:

    - Not invoice numbers (invoice numbers live in
      invoices.invoice_number, e.g. "INV-000123").
    - Not customer codes.
    - Not GSTINs.
    - Not meant to be shown to your customers.

Never change an id value manually. If you rename a customer, keep
the id and change customers.name.

--------------------------------------------------------------------
5. FILES YOU SHOULD NOT EDIT BY HAND
--------------------------------------------------------------------

WARNING: The files below are managed by the application and are
part of the integrity chain used to detect corruption. Editing
them by hand can silently corrupt your books, break recovery,
or cause the application to refuse to restore.

${noEditBlock}

If you need to correct a wrong invoice, DO NOT edit invoices.csv
or invoice_items.csv. In accounting terms an issued invoice is
immutable. Instead, from the application:

    - Issue a credit note against the wrong invoice, then
    - Create a corrected invoice.

The same principle applies to payments and journal entries: they
are append-only. Corrections happen by posting a reversing entry,
never by editing history.

You may safely open any of these files in Excel to READ them.
Just do not save changes back to the folder.

--------------------------------------------------------------------
6. HOW TO RESTORE THIS BUSINESS ON A NEW DEVICE
--------------------------------------------------------------------

If you lose your phone / laptop, or move to a new device, you can
rebuild the business from this folder alone:

    1. Install the BusinessVault application on the new device.
    2. Open it and choose "Sign in with Google".
       Use the same Google account that owns this folder.
    3. On the welcome screen choose "Restore from Google Drive".
    4. Pick the folder:
            BusinessVault - ${displayName}/
    5. Wait for the restore to finish. The app will:
           - read metadata/manifest.json,
           - verify checksums in metadata/checksums.json,
           - replay journal/ events on top of current/ snapshots,
           - re-derive stock, receivables, payables and accounting.

You do not need any password or export file from us. The Drive
folder is enough.

--------------------------------------------------------------------
7. HOW TO EXPORT ALL YOUR DATA
--------------------------------------------------------------------

At any time, from inside the application:

    Settings  ->  Data & Backup  ->  Export My Business

This produces a single ZIP archive:

    ${displayName}-Full-Export.zip

containing this README, manifest.json, schema.json, every CSV,
optionally the invoice PDFs and attachments, and audit history.
The archive is designed to be understandable without our service.

--------------------------------------------------------------------
8. PRIVACY AND OWNERSHIP
--------------------------------------------------------------------

This data belongs to you.

The BusinessVault application accesses this folder using the
Google Drive "drive.file" scope, which means it can only see
files it created inside this folder. It cannot read the rest
of your Google Drive.

We do NOT use the contents of this folder for:

    - Advertising
    - Training machine-learning or AI models
    - Cross-customer analytics

unless you have separately and explicitly authorised it in
writing. Your business data is never exposed to another
BusinessVault customer.

You may revoke the application's access to your Google Drive
at any time from https://myaccount.google.com/permissions.
Doing so stops future backups; it does not delete the files
already in this folder.

--------------------------------------------------------------------

If any file in this folder looks damaged, do not attempt to edit
it. Open the application and go to Settings -> Data & Backup ->
Verify Backup. The application will report exactly which file
failed and offer the safest recovery option.

End of README.
`;
}
