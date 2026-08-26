export const SCHEMA_VERSION = 8;

export const DB_NAME = 'businessvault';

// v2: added `advances` table (customer/supplier prepayments held as a
// liability/asset until applied to invoices/bills). See Phase 2 of
// payablesRec.md. Dexie treats a superset of stores as a compatible upgrade,
// so existing installs get the new store on first open without data loss.
export const STORES_V1: Record<string, string> = {
  businesses: 'id, name, gstin, created_at',

  devices: 'id, business_id, [business_id+active]',

  customers:
    'id, business_id, [business_id+name], [business_id+phone], [business_id+gstin], updated_at',

  suppliers:
    'id, business_id, [business_id+name], [business_id+phone], [business_id+gstin], updated_at',

  categories: 'id, business_id, [business_id+name]',

  units: 'id, business_id, [business_id+code]',

  warehouses: 'id, business_id, [business_id+name]',

  items:
    'id, business_id, [business_id+sku], [business_id+name], [business_id+hsn], [business_id+category_id], [business_id+active], updated_at',

  item_stock:
    'id, business_id, [business_id+item_id+warehouse_id], [business_id+warehouse_id]',

  invoices:
    'id, business_id, [business_id+invoice_number], [business_id+customer_id], [business_id+invoice_date], [business_id+status], [business_id+financial_year], updated_at',

  invoice_lines:
    'id, business_id, invoice_id, [business_id+item_id], [business_id+invoice_id]',

  purchases:
    'id, business_id, [business_id+bill_number], [business_id+supplier_id], [business_id+bill_date], [business_id+status], updated_at',

  purchase_lines: 'id, business_id, purchase_id, [business_id+item_id]',

  payments:
    'id, business_id, [business_id+payment_number], [business_id+party_type+party_id], [business_id+payment_date], [business_id+direction], updated_at',

  expenses:
    'id, business_id, [business_id+expense_date], [business_id+category_account_id], updated_at',

  stock_movements:
    'id, business_id, [business_id+item_id], [business_id+warehouse_id], [business_id+ref_type+ref_id], [business_id+occurred_at]',

  accounts:
    'id, business_id, [business_id+code], [business_id+type], [business_id+parent_id]',

  journal_entries:
    'id, business_id, [business_id+entry_date], [business_id+ref_type+ref_id], [business_id+entry_number]',

  journal_lines:
    'id, business_id, entry_id, [business_id+account_id], [business_id+entry_id]',

  sync_events:
    '&event_id, sequence, business_id, sync_status, [business_id+sync_status], [business_id+entity_type+entity_id], [business_id+entity_type+entity_id+entity_version], [business_id+timestamp]',

  drive_file_map:
    'id, business_id, [business_id+logical_path], drive_file_id',

  sync_queue:
    'id, business_id, [business_id+status], [business_id+next_attempt_at], [status+next_attempt_at], kind',

  attachments:
    'id, business_id, [business_id+ref_type+ref_id], drive_file_id',

  audit_log:
    'id, business_id, [business_id+entity_type+entity_id], [business_id+at]',

  auth_tokens: 'id, business_id, provider',

  kv: '&key',
};

// v2 stores. Advances are queried by (business_id, party_type, party_id) to
// find remaining balance for a customer/supplier, and by (business_id, remaining_paise)
// implicitly through client-side filtering — small volumes; no dedicated index.
export const STORES_V2: Record<string, string> = {
  ...STORES_V1,
  advances:
    'id, business_id, [business_id+party_type+party_id], [business_id+advance_date], updated_at',
};

// v3: adds `debug_logs` — durable ring-buffer of structured log entries so a
// user can export a diagnostic bundle from Settings when reporting a bug.
// Indexed by ts so the UI can pull "last N minutes" cheaply. `++id` because
// we don't care about entry identity, only insertion order.
export const STORES_V3: Record<string, string> = {
  ...STORES_V2,
  debug_logs: '++id, ts, level, [level+ts]',
};

// v4: add [business_id+deleted_at] index on invoices so the default list can
// exclude soft-deleted rows and the Recycle Bin can enumerate them cheaply.
// Dexie treats added indexes as a compatible upgrade; existing rows keep
// deleted_at = undefined (indexed as "missing", filtered out of both views).
export const STORES_V4: Record<string, string> = {
  ...STORES_V3,
  invoices:
    'id, business_id, [business_id+invoice_number], [business_id+customer_id], [business_id+invoice_date], [business_id+status], [business_id+financial_year], [business_id+deleted_at], updated_at',
};

// v5: Sales Return domain, per SellReturnRequirement.md. Native sales returns
// live in their own tables — NOT as a reversal Invoice row — so invoice edits
// (which still write a reversal Invoice for journal integrity) can never leak
// into the Sales Return UI or reports.
//
//   sales_returns              — one row per user-initiated Sales Return.
//   sales_return_items         — one row per returned line (qty > 0).
//   invoice_line_return_summary — cache: sum(active return qty) per invoice
//                                 line. Authoritative source is still
//                                 sales_return_items; rebuildable via
//                                 rebuildInvoiceLineReturnSummary().
//   legacy_reversal_audit      — one row per pre-v5 Invoice row whose
//                                 reverses_invoice_id != null, recording the
//                                 conservative migration classification
//                                 (SALES_RETURN | SALES_RETURN_UNRECONSTRUCTABLE
//                                 | EDIT_REVERSAL | UNKNOWN). Never guesses;
//                                 preserves originals; idempotent.
export const STORES_V5: Record<string, string> = {
  ...STORES_V4,
  sales_returns:
    'id, business_id, [business_id+return_number], [business_id+original_invoice_id], [business_id+return_date], [business_id+customer_id], [business_id+status], [business_id+legacy_migration_classification], [business_id+deleted_at], updated_at',
  sales_return_items:
    'id, business_id, sales_return_id, original_invoice_id, original_invoice_line_id, [business_id+sales_return_id], [business_id+original_invoice_line_id], [business_id+original_invoice_id]',
  invoice_line_return_summary:
    '&invoice_line_id, business_id, invoice_id, [business_id+invoice_id]',
  legacy_reversal_audit:
    '&credit_note_invoice_id, business_id, [business_id+classification], [business_id+original_invoice_id], examined_at',
};

// v6: adds Round Off treatment fields (round_off_mode, pre_round_total_paise)
// to invoices, purchases, and sales_returns. No new indexes required; the
// fields are read-only sidecars for reporting + UI. Backfill happens in
// database.ts .version(6).upgrade(): existing rows get round_off_mode='auto'
// and pre_round_total_paise = total_paise - round_off_paise, which is
// definitionally consistent with the existing header math.
export const STORES_V6: Record<string, string> = {
  ...STORES_V5,
};

// v7: feedback §9 Recycle Bin accounting fix. Adds
// `deletion_reversal_journal_id` on invoices — the id of the mirror journal
// entry posted when the invoice is soft-deleted (so the recycled invoice no
// longer contributes to TB/P&L/BS/GST/party ledgers). No new index needed;
// the field is only consulted from restoreInvoice for the specific row. Any
// pre-v7 soft-deleted invoices are backfilled at upgrade time by posting a
// deletion reversal for each one.
export const STORES_V7: Record<string, string> = {
  ...STORES_V6,
};

// v8: feedback §2 Authorised Signature. Adds two sidecar fields on
// businesses (`signature_ref`, `show_signature_on_invoice`) and one on
// invoices (`signature_attachment_id`). No new indexes needed — the fields
// are read as sidecars off the row already in hand. Existing rows are
// backfilled with null / 0 defaults on upgrade.
export const STORES_V8: Record<string, string> = {
  ...STORES_V7,
};
