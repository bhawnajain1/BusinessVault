/**
 * Column layout for each CSV table in the snapshot.
 *
 * Restore reads CSVs by filename and rebuilds Dexie rows. Numeric columns are
 * parsed to Number; date/string columns are left as strings. Missing columns
 * default to '' → parsed as 0 for numerics and null for foreign keys.
 *
 * Column order is stable — it defines the on-disk snapshot format. Do not
 * reorder or rename columns without a schema migration.
 */

export type ColumnType =
  | 'string'
  | 'string_or_null'
  | 'number'
  | 'number_or_null'
  | 'paise'
  | 'boolean_int'
  | 'boolean_int_or_null'
  | 'json';

export interface ColumnSpec {
  name: string;
  type: ColumnType;
}

export interface TableSpec {
  /** CSV filename inside current/, e.g. 'invoices.csv'. */
  file: string;
  /** Dexie store name. */
  store: string;
  /** Primary key column — must be present in every row. */
  pk: string;
  columns: ColumnSpec[];
  required?: string[];
}

const COMMON_AUDIT: ColumnSpec[] = [
  { name: 'created_at', type: 'string' },
  { name: 'updated_at', type: 'string' },
  { name: 'entity_version', type: 'number' },
];

export const TABLE_SPECS: TableSpec[] = [
  {
    file: 'businesses.csv',
    store: 'businesses',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'legal_name', type: 'string' },
      { name: 'gstin', type: 'string_or_null' },
      { name: 'pan', type: 'string_or_null' },
      { name: 'address_line1', type: 'string' },
      { name: 'address_line2', type: 'string' },
      { name: 'city', type: 'string' },
      { name: 'state', type: 'string' },
      { name: 'state_code', type: 'string' },
      { name: 'pincode', type: 'string' },
      { name: 'country', type: 'string' },
      { name: 'phone', type: 'string' },
      { name: 'email', type: 'string' },
      { name: 'financial_year_start_month', type: 'number' },
      { name: 'current_financial_year', type: 'string' },
      { name: 'currency', type: 'string' },
      { name: 'logo_ref', type: 'string_or_null' },
      { name: 'udyamRegistrationNumber', type: 'string_or_null' },
      { name: 'invoice_prefix', type: 'string' },
      { name: 'invoice_next_seq', type: 'number' },
      { name: 'default_invoice_terms', type: 'string' },
      { name: 'drive_folder_id', type: 'string_or_null' },
      { name: 'drive_connected_email', type: 'string_or_null' },
      { name: 'schema_version', type: 'number' },
      { name: 'signature_ref', type: 'string_or_null' },
      { name: 'show_signature_on_invoice', type: 'boolean_int' },
      ...COMMON_AUDIT,
    ],
    required: ['id', 'name'],
  },
  {
    file: 'customer_item_prices.csv',
    store: 'customer_item_prices',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'customer_id', type: 'string' },
      { name: 'item_id', type: 'string' },
      { name: 'unit_price_paise', type: 'number' },
      ...COMMON_AUDIT,
    ],
    required: ['id', 'business_id', 'customer_id', 'item_id'],
  },
  {
    file: 'customers.csv',
    store: 'customers',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'phone', type: 'string' },
      { name: 'email', type: 'string' },
      { name: 'gstin', type: 'string_or_null' },
      { name: 'billing_address', type: 'string' },
      { name: 'shipping_address', type: 'string' },
      { name: 'state', type: 'string' },
      { name: 'state_code', type: 'string' },
      { name: 'opening_balance_paise', type: 'number' },
      { name: 'credit_limit_paise', type: 'number' },
      { name: 'notes', type: 'string' },
      { name: 'active', type: 'boolean_int' },
      ...COMMON_AUDIT,
    ],
  },
  {
    file: 'suppliers.csv',
    store: 'suppliers',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'phone', type: 'string' },
      { name: 'email', type: 'string' },
      { name: 'gstin', type: 'string_or_null' },
      { name: 'address', type: 'string' },
      { name: 'state', type: 'string' },
      { name: 'state_code', type: 'string' },
      { name: 'opening_balance_paise', type: 'number' },
      { name: 'notes', type: 'string' },
      { name: 'active', type: 'boolean_int' },
      ...COMMON_AUDIT,
    ],
  },
  {
    file: 'categories.csv',
    store: 'categories',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'parent_id', type: 'string_or_null' },
      ...COMMON_AUDIT,
    ],
  },
  {
    file: 'units.csv',
    store: 'units',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'code', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'decimal_places', type: 'number' },
      ...COMMON_AUDIT,
    ],
  },
  {
    file: 'warehouses.csv',
    store: 'warehouses',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'address', type: 'string' },
      { name: 'is_default', type: 'boolean_int' },
      { name: 'active', type: 'boolean_int' },
      ...COMMON_AUDIT,
    ],
  },
  {
    file: 'items.csv',
    store: 'items',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'sku', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'hsn', type: 'string' },
      { name: 'category_id', type: 'string_or_null' },
      { name: 'unit_id', type: 'string' },
      { name: 'sale_price_paise', type: 'number' },
      { name: 'purchase_price_paise', type: 'number' },
      { name: 'tax_rate_bps', type: 'number' },
      { name: 'cess_rate_bps', type: 'number' },
      { name: 'is_service', type: 'boolean_int' },
      { name: 'track_inventory', type: 'boolean_int' },
      { name: 'opening_qty_micros', type: 'number' },
      { name: 'opening_value_paise', type: 'number' },
      { name: 'reorder_level_micros', type: 'number' },
      { name: 'barcode', type: 'string_or_null' },
      { name: 'image_ref', type: 'string_or_null' },
      { name: 'active', type: 'boolean_int' },
      ...COMMON_AUDIT,
    ],
  },
  {
    file: 'item_stock.csv',
    store: 'item_stock',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'item_id', type: 'string' },
      { name: 'warehouse_id', type: 'string' },
      { name: 'qty_micros', type: 'number' },
      { name: 'avg_cost_paise', type: 'number' },
      { name: 'updated_at', type: 'string' },
    ],
  },
  {
    file: 'invoices.csv',
    store: 'invoices',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'invoice_number', type: 'string' },
      { name: 'invoice_date', type: 'string' },
      { name: 'due_date', type: 'string_or_null' },
      { name: 'customer_id', type: 'string' },
      { name: 'customer_state_code', type: 'string' },
      { name: 'place_of_supply', type: 'string' },
      { name: 'is_interstate', type: 'boolean_int' },
      { name: 'financial_year', type: 'string' },
      { name: 'subtotal_paise', type: 'number' },
      { name: 'discount_paise', type: 'number' },
      { name: 'taxable_paise', type: 'number' },
      { name: 'cgst_paise', type: 'number' },
      { name: 'sgst_paise', type: 'number' },
      { name: 'igst_paise', type: 'number' },
      { name: 'cess_paise', type: 'number' },
      { name: 'round_off_paise', type: 'number' },
      { name: 'round_off_mode', type: 'string' },
      { name: 'pre_round_total_paise', type: 'number' },
      { name: 'total_paise', type: 'number' },
      { name: 'paid_paise', type: 'number' },
      { name: 'balance_paise', type: 'number' },
      { name: 'status', type: 'string' },
      { name: 'reversed_by_invoice_id', type: 'string_or_null' },
      { name: 'reverses_invoice_id', type: 'string_or_null' },
      { name: 'notes', type: 'string' },
      { name: 'terms', type: 'string' },
      { name: 'pdf_attachment_id', type: 'string_or_null' },
      { name: 'journal_entry_id', type: 'string' },
      { name: 'deleted_at', type: 'string_or_null' },
      { name: 'deleted_reason', type: 'string_or_null' },
      { name: 'deletion_reversal_journal_id', type: 'string_or_null' },
      { name: 'signature_attachment_id', type: 'string_or_null' },
      { name: 'e_invoice_status', type: 'string' },
      { name: 'e_invoice_irn', type: 'string_or_null' },
      { name: 'e_invoice_ack_number', type: 'string_or_null' },
      { name: 'e_invoice_ack_date', type: 'string_or_null' },
      { name: 'e_invoice_qr_reference', type: 'string_or_null' },
      { name: 'e_invoice_note', type: 'string_or_null' },
      ...COMMON_AUDIT,
    ],
  },
  {
    file: 'invoice_items.csv',
    store: 'invoice_lines',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'invoice_id', type: 'string' },
      { name: 'line_no', type: 'number' },
      { name: 'item_id', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'hsn', type: 'string' },
      { name: 'warehouse_id', type: 'string' },
      { name: 'qty_micros', type: 'number' },
      { name: 'unit_price_paise', type: 'number' },
      { name: 'discount_pct_bps', type: 'number' },
      { name: 'discount_paise', type: 'number' },
      { name: 'taxable_paise', type: 'number' },
      { name: 'tax_rate_bps', type: 'number' },
      { name: 'cgst_paise', type: 'number' },
      { name: 'sgst_paise', type: 'number' },
      { name: 'igst_paise', type: 'number' },
      { name: 'cess_paise', type: 'number' },
      { name: 'line_total_paise', type: 'number' },
    ],
  },
  {
    file: 'purchases.csv',
    store: 'purchases',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'bill_number', type: 'string' },
      { name: 'supplier_bill_number', type: 'string' },
      { name: 'bill_date', type: 'string' },
      { name: 'due_date', type: 'string_or_null' },
      { name: 'supplier_id', type: 'string' },
      { name: 'supplier_state_code', type: 'string' },
      { name: 'is_interstate', type: 'boolean_int' },
      { name: 'financial_year', type: 'string' },
      { name: 'subtotal_paise', type: 'number' },
      { name: 'discount_paise', type: 'number' },
      { name: 'taxable_paise', type: 'number' },
      { name: 'cgst_paise', type: 'number' },
      { name: 'sgst_paise', type: 'number' },
      { name: 'igst_paise', type: 'number' },
      { name: 'cess_paise', type: 'number' },
      { name: 'round_off_paise', type: 'number' },
      { name: 'round_off_mode', type: 'string' },
      { name: 'pre_round_total_paise', type: 'number' },
      { name: 'total_paise', type: 'number' },
      { name: 'paid_paise', type: 'number' },
      { name: 'balance_paise', type: 'number' },
      { name: 'status', type: 'string' },
      { name: 'reversed_by_purchase_id', type: 'string_or_null' },
      { name: 'reverses_purchase_id', type: 'string_or_null' },
      { name: 'replaces_purchase_id', type: 'string_or_null' },
      { name: 'replaced_by_purchase_id', type: 'string_or_null' },
      { name: 'reversal_journal_entry_id', type: 'string_or_null' },
      { name: 'cancelled_at', type: 'string_or_null' },
      { name: 'cancel_reason', type: 'string_or_null' },
      { name: 'notes', type: 'string' },
      { name: 'attachment_id', type: 'string_or_null' },
      { name: 'journal_entry_id', type: 'string' },
      ...COMMON_AUDIT,
    ],
  },
  {
    file: 'purchase_items.csv',
    store: 'purchase_lines',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'purchase_id', type: 'string' },
      { name: 'line_no', type: 'number' },
      { name: 'item_id', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'hsn', type: 'string' },
      { name: 'warehouse_id', type: 'string' },
      { name: 'qty_micros', type: 'number' },
      { name: 'unit_cost_paise', type: 'number' },
      { name: 'discount_paise', type: 'number' },
      { name: 'taxable_paise', type: 'number' },
      { name: 'tax_rate_bps', type: 'number' },
      { name: 'cgst_paise', type: 'number' },
      { name: 'sgst_paise', type: 'number' },
      { name: 'igst_paise', type: 'number' },
      { name: 'cess_paise', type: 'number' },
      { name: 'line_total_paise', type: 'number' },
    ],
  },
  {
    file: 'payments.csv',
    store: 'payments',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'payment_number', type: 'string' },
      { name: 'payment_date', type: 'string' },
      { name: 'direction', type: 'string' },
      { name: 'party_type', type: 'string' },
      { name: 'party_id', type: 'string' },
      { name: 'method', type: 'string' },
      { name: 'bank_name', type: 'string_or_null' },
      { name: 'account_id', type: 'string' },
      { name: 'amount_paise', type: 'number' },
      { name: 'reference', type: 'string' },
      { name: 'notes', type: 'string' },
      { name: 'allocations_json', type: 'json' },
      { name: 'journal_entry_id', type: 'string' },
      { name: 'deleted_at', type: 'string_or_null' },
      { name: 'deleted_reason', type: 'string_or_null' },
      ...COMMON_AUDIT,
    ],
  },
  {
    file: 'expenses.csv',
    store: 'expenses',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'expense_number', type: 'string' },
      { name: 'expense_date', type: 'string' },
      { name: 'category_account_id', type: 'string' },
      { name: 'payment_account_id', type: 'string' },
      { name: 'supplier_id', type: 'string_or_null' },
      { name: 'description', type: 'string' },
      { name: 'amount_paise', type: 'number' },
      { name: 'tax_paise', type: 'number' },
      { name: 'total_paise', type: 'number' },
      { name: 'attachment_id', type: 'string_or_null' },
      { name: 'journal_entry_id', type: 'string' },
      ...COMMON_AUDIT,
    ],
  },
  {
    file: 'stock_movements.csv',
    store: 'stock_movements',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'item_id', type: 'string' },
      { name: 'warehouse_id', type: 'string' },
      { name: 'movement_type', type: 'string' },
      { name: 'qty_micros', type: 'number' },
      { name: 'unit_cost_paise', type: 'number' },
      { name: 'ref_type', type: 'string' },
      { name: 'ref_id', type: 'string' },
      { name: 'occurred_at', type: 'string' },
      { name: 'notes', type: 'string' },
    ],
  },
  {
    file: 'accounts.csv',
    store: 'accounts',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'code', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'type', type: 'string' },
      { name: 'subtype', type: 'string' },
      { name: 'parent_id', type: 'string_or_null' },
      { name: 'opening_balance_paise', type: 'number' },
      { name: 'is_system', type: 'boolean_int' },
      { name: 'active', type: 'boolean_int' },
      ...COMMON_AUDIT,
    ],
  },
  {
    file: 'journal_entries.csv',
    store: 'journal_entries',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'entry_number', type: 'string' },
      { name: 'entry_date', type: 'string' },
      { name: 'narration', type: 'string' },
      { name: 'ref_type', type: 'string' },
      { name: 'ref_id', type: 'string_or_null' },
      { name: 'reversed_by_id', type: 'string_or_null' },
      { name: 'reverses_id', type: 'string_or_null' },
      { name: 'total_debit_paise', type: 'number' },
      { name: 'total_credit_paise', type: 'number' },
      { name: 'posted', type: 'boolean_int' },
      ...COMMON_AUDIT,
    ],
  },
  {
    file: 'journal_lines.csv',
    store: 'journal_lines',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'entry_id', type: 'string' },
      { name: 'line_no', type: 'number' },
      { name: 'account_id', type: 'string' },
      { name: 'debit_paise', type: 'number' },
      { name: 'credit_paise', type: 'number' },
      { name: 'party_type', type: 'string_or_null' },
      { name: 'party_id', type: 'string_or_null' },
      { name: 'description', type: 'string' },
    ],
  },
  {
    file: 'advances.csv',
    store: 'advances',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'advance_number', type: 'string' },
      { name: 'advance_date', type: 'string' },
      { name: 'party_type', type: 'string' },
      { name: 'party_id', type: 'string' },
      { name: 'method', type: 'string' },
      { name: 'account_id', type: 'string' },
      { name: 'amount_paise', type: 'number' },
      { name: 'remaining_paise', type: 'number' },
      { name: 'reference', type: 'string' },
      { name: 'notes', type: 'string' },
      { name: 'applications_json', type: 'json' },
      { name: 'journal_entry_id', type: 'string' },
      { name: 'deleted_at', type: 'string_or_null' },
      { name: 'deleted_reason', type: 'string_or_null' },
      ...COMMON_AUDIT,
    ],
  },
  // §20 Sales Returns — first-class documents (schema v5+).
  {
    file: 'sales_returns.csv',
    store: 'sales_returns',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'return_number', type: 'string' },
      { name: 'return_date', type: 'string' },
      { name: 'original_invoice_id', type: 'string' },
      { name: 'customer_id', type: 'string' },
      { name: 'subtotal_paise', type: 'number' },
      { name: 'discount_paise', type: 'number' },
      { name: 'taxable_paise', type: 'number' },
      { name: 'cgst_paise', type: 'number' },
      { name: 'sgst_paise', type: 'number' },
      { name: 'igst_paise', type: 'number' },
      { name: 'cess_paise', type: 'number' },
      { name: 'round_off_paise', type: 'number' },
      { name: 'round_off_mode', type: 'string' },
      { name: 'pre_round_total_paise', type: 'number' },
      { name: 'total_paise', type: 'number' },
      { name: 'apply_to_balance_paise', type: 'number' },
      { name: 'customer_credit_paise', type: 'number' },
      { name: 'status', type: 'string' },
      { name: 'reason', type: 'string' },
      { name: 'notes', type: 'string' },
      { name: 'journal_entry_id', type: 'string' },
      { name: 'reversed_credit_note_invoice_id', type: 'string_or_null' },
      { name: 'legacy_migration_classification', type: 'string_or_null' },
      { name: 'device_id', type: 'string' },
      { name: 'deleted_at', type: 'string_or_null' },
      { name: 'deleted_reason', type: 'string_or_null' },
      ...COMMON_AUDIT,
    ],
  },
  {
    file: 'sales_return_items.csv',
    store: 'sales_return_items',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'sales_return_id', type: 'string' },
      { name: 'original_invoice_id', type: 'string' },
      { name: 'original_invoice_line_id', type: 'string' },
      { name: 'item_id', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'hsn', type: 'string' },
      { name: 'warehouse_id', type: 'string' },
      { name: 'line_no', type: 'number' },
      { name: 'qty_micros', type: 'number' },
      { name: 'unit_price_paise', type: 'number' },
      { name: 'discount_pct_bps', type: 'number' },
      { name: 'discount_paise', type: 'number' },
      { name: 'taxable_paise', type: 'number' },
      { name: 'tax_rate_bps', type: 'number' },
      { name: 'cgst_paise', type: 'number' },
      { name: 'sgst_paise', type: 'number' },
      { name: 'igst_paise', type: 'number' },
      { name: 'cess_paise', type: 'number' },
      { name: 'line_total_paise', type: 'number' },
      { name: 'cogs_paise', type: 'number' },
    ],
  },
  // §20 Attachments — metadata only; the blob content is shipped separately
  // via `attachment_upload` sync jobs and referenced here by `drive_file_id`.
  // Restore replays the row, then the blob is fetched on demand by
  // consumers (invoice print signature, etc.) via the provider.
  {
    file: 'attachments.csv',
    store: 'attachments',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'ref_type', type: 'string' },
      { name: 'ref_id', type: 'string' },
      { name: 'filename', type: 'string' },
      { name: 'mime_type', type: 'string' },
      { name: 'size_bytes', type: 'number' },
      { name: 'checksum', type: 'string' },
      { name: 'drive_file_id', type: 'string_or_null' },
      { name: 'logical_path', type: 'string' },
      { name: 'created_at', type: 'string' },
      { name: 'updated_at', type: 'string' },
    ],
  },
  // §20 Audit log — durable record of user-visible operations. Rebuildable
  // from event stream in theory, but restoring it directly preserves the
  // human-readable timeline without a replay pass.
  {
    file: 'audit_log.csv',
    store: 'audit_log',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'business_id', type: 'string' },
      { name: 'device_id', type: 'string' },
      { name: 'actor', type: 'string' },
      { name: 'action', type: 'string' },
      { name: 'entity_type', type: 'string' },
      { name: 'entity_id', type: 'string' },
      { name: 'before', type: 'json' },
      { name: 'after', type: 'json' },
      { name: 'at', type: 'string' },
    ],
  },
  {
    file: 'gst_profiles.csv',
    store: 'gst_profiles',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' }, { name: 'business_id', type: 'string' },
      { name: 'gstin', type: 'string' }, { name: 'legal_name', type: 'string' },
      { name: 'state_code', type: 'string' }, { name: 'registration_type', type: 'string' },
      { name: 'registration_start_date', type: 'string_or_null' },
      { name: 'registration_end_date', type: 'string_or_null' },
      { name: 'filing_frequency', type: 'string' },
      { name: 'gst_reporting_enabled', type: 'boolean_int' },
      { name: 'effective_from', type: 'string' },
      { name: 'effective_to', type: 'string_or_null' }, { name: 'active', type: 'boolean_int' },
      ...COMMON_AUDIT,
    ],
  },
  {
    file: 'gst_aato.csv',
    store: 'gst_aato',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' }, { name: 'business_id', type: 'string' },
      { name: 'financial_year', type: 'string' }, { name: 'aato_paise', type: 'paise' },
      { name: 'source', type: 'string' }, { name: 'confirmed_at', type: 'string_or_null' },
      { name: 'notes', type: 'string_or_null' }, ...COMMON_AUDIT,
    ],
  },
  {
    file: 'gst_document_metadata.csv',
    store: 'gst_document_metadata',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' }, { name: 'business_id', type: 'string' },
      { name: 'source_entity_type', type: 'string' }, { name: 'source_entity_id', type: 'string' },
      { name: 'document_type', type: 'string' }, { name: 'supply_category', type: 'string_or_null' },
      { name: 'recipient_category', type: 'string_or_null' },
      { name: 'place_of_supply_state_code', type: 'string_or_null' },
      { name: 'reverse_charge', type: 'boolean_int_or_null' },
      { name: 'ecommerce_operator_gstin', type: 'string_or_null' },
      { name: 'ecommerce_reporting_type', type: 'string_or_null' },
      { name: 'section_9_5_role', type: 'string_or_null' },
      { name: 'section_52_tcs', type: 'boolean_int_or_null' },
      { name: 'shipping_bill_number', type: 'string_or_null' },
      { name: 'shipping_bill_date', type: 'string_or_null' },
      { name: 'port_code', type: 'string_or_null' },
      { name: 'original_document_number', type: 'string_or_null' },
      { name: 'original_document_date', type: 'string_or_null' },
      { name: 'original_return_period', type: 'string_or_null' },
      { name: 'amendment_kind', type: 'string_or_null' },
      { name: 'tax_on_advance_applicable', type: 'boolean_int_or_null' },
      { name: 'classification_source', type: 'string_or_null' }, ...COMMON_AUDIT,
    ],
  },
  {
    file: 'gst_report_runs.csv',
    store: 'gst_report_runs',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' }, { name: 'business_id', type: 'string' },
      { name: 'gstin_snapshot', type: 'string' }, { name: 'report_type', type: 'string' },
      { name: 'financial_year', type: 'string' }, { name: 'tax_period_key', type: 'string' },
      { name: 'period_start', type: 'string' }, { name: 'period_end', type: 'string' },
      { name: 'filing_frequency', type: 'string' }, { name: 'rule_set_version', type: 'string' },
      { name: 'status', type: 'string' }, { name: 'generated_at', type: 'string' },
      { name: 'generated_by_device_id', type: 'string' },
      { name: 'source_data_hash', type: 'string_or_null' },
      { name: 'source_artifact_attachment_id', type: 'string_or_null' },
      { name: 'imported_file_hash', type: 'string_or_null' },
      { name: 'totals_json', type: 'string_or_null' },
      { name: 'finalized_at', type: 'string_or_null' },
      { name: 'filed_at', type: 'string_or_null' }, { name: 'arn', type: 'string_or_null' },
      { name: 'filing_acknowledgment_attachment_id', type: 'string_or_null' },
      { name: 'supersedes_report_run_id', type: 'string_or_null' },
      ...COMMON_AUDIT,
    ],
  },
  {
    file: 'gst_report_rows.csv',
    store: 'gst_report_rows',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' }, { name: 'business_id', type: 'string' },
      { name: 'report_run_id', type: 'string' }, { name: 'section_code', type: 'string' },
      { name: 'row_key', type: 'string' }, { name: 'source_entity_type', type: 'string_or_null' },
      { name: 'source_entity_id', type: 'string_or_null' },
      { name: 'source_entity_version', type: 'number_or_null' },
      { name: 'classification_reason', type: 'string_or_null' },
      { name: 'taxable_paise', type: 'paise' }, { name: 'igst_paise', type: 'paise' },
      { name: 'cgst_paise', type: 'paise' }, { name: 'sgst_paise', type: 'paise' },
      { name: 'cess_paise', type: 'paise' }, { name: 'invoice_value_paise', type: 'paise' },
      { name: 'quantity_micros', type: 'number_or_null' },
      { name: 'payload_json', type: 'string_or_null' }, ...COMMON_AUDIT,
    ],
  },
  {
    file: 'gst_adjustments.csv',
    store: 'gst_adjustments',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' }, { name: 'business_id', type: 'string' },
      { name: 'report_run_id', type: 'string' }, { name: 'table_code', type: 'string' },
      { name: 'tax_head', type: 'string' }, { name: 'original_paise', type: 'paise' },
      { name: 'adjusted_paise', type: 'paise' }, { name: 'reason', type: 'string' },
      { name: 'supporting_attachment_id', type: 'string_or_null' },
      { name: 'source', type: 'string' }, { name: 'actor_id', type: 'string_or_null' },
      { name: 'device_id', type: 'string' },
      { name: 'created_at', type: 'string' }, { name: 'updated_at', type: 'string' },
      { name: 'entity_version', type: 'number' },
    ],
  },
  {
    file: 'gstr2b_imports.csv',
    store: 'gstr2b_imports',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' }, { name: 'business_id', type: 'string' },
      { name: 'gstin_snapshot', type: 'string' }, { name: 'tax_period_key', type: 'string' },
      { name: 'source_type', type: 'string' },
      { name: 'original_attachment_id', type: 'string_or_null' },
      { name: 'sha256', type: 'string' }, { name: 'imported_at', type: 'string' },
      { name: 'portal_generated_at', type: 'string_or_null' },
      { name: 'recomputed_at', type: 'string_or_null' },
      { name: 'schema_adapter_version', type: 'string' }, { name: 'parse_status', type: 'string' },
      { name: 'parse_errors_json', type: 'string_or_null' },
      { name: 'supersedes_import_id', type: 'string_or_null' },
      { name: 'is_latest', type: 'boolean_int' },
      ...COMMON_AUDIT,
    ],
  },
  {
    file: 'gstr2b_documents.csv',
    store: 'gstr2b_documents',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' }, { name: 'business_id', type: 'string' },
      { name: 'gstr2b_import_id', type: 'string' }, { name: 'source_section', type: 'string_or_null' },
      { name: 'supplier_gstin', type: 'string_or_null' },
      { name: 'supplier_name', type: 'string_or_null' }, { name: 'document_type', type: 'string_or_null' },
      { name: 'canonical_document_number', type: 'string_or_null' },
      { name: 'search_normalized_document_number', type: 'string_or_null' },
      { name: 'document_date', type: 'string_or_null' },
      { name: 'original_document_number', type: 'string_or_null' },
      { name: 'original_document_date', type: 'string_or_null' },
      { name: 'filing_period', type: 'string_or_null' },
      { name: 'place_of_supply_state_code', type: 'string_or_null' },
      { name: 'reverse_charge', type: 'boolean_int_or_null' },
      { name: 'taxable_paise', type: 'paise' }, { name: 'igst_paise', type: 'paise' },
      { name: 'cgst_paise', type: 'paise' }, { name: 'sgst_paise', type: 'paise' },
      { name: 'cess_paise', type: 'paise' }, { name: 'invoice_value_paise', type: 'paise' },
      { name: 'itc_availability', type: 'string_or_null' },
      { name: 'itc_unavailable_reason', type: 'string_or_null' },
      { name: 'ims_status', type: 'string_or_null' },
      { name: 'declared_itc_reduction_paise', type: 'paise' },
      { name: 'ims_remark', type: 'string_or_null' },
      { name: 'bill_of_entry_number', type: 'string_or_null' },
      { name: 'bill_of_entry_date', type: 'string_or_null' },
      { name: 'port_code', type: 'string_or_null' },
      { name: 'raw_payload_json', type: 'string_or_null' }, ...COMMON_AUDIT,
    ],
  },
  {
    file: 'gst_matches.csv',
    store: 'gst_matches',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' }, { name: 'business_id', type: 'string' },
      { name: 'gstr2b_import_id', type: 'string' }, { name: 'gstr2b_document_id', type: 'string_or_null' },
      { name: 'book_source_type', type: 'string_or_null' },
      { name: 'book_source_id', type: 'string_or_null' }, { name: 'status', type: 'string' },
      { name: 'confidence_bps', type: 'number' },
      { name: 'taxable_difference_paise', type: 'paise' },
      { name: 'igst_difference_paise', type: 'paise' },
      { name: 'cgst_difference_paise', type: 'paise' },
      { name: 'sgst_difference_paise', type: 'paise' },
      { name: 'cess_difference_paise', type: 'paise' },
      { name: 'confirmed_at', type: 'string_or_null' },
      { name: 'confirmed_by_device_id', type: 'string_or_null' },
      { name: 'confirmation_note', type: 'string_or_null' }, ...COMMON_AUDIT,
    ],
  },
  {
    file: 'gst_itc_ledger.csv',
    store: 'gst_itc_ledger',
    pk: 'id',
    columns: [
      { name: 'id', type: 'string' }, { name: 'business_id', type: 'string' },
      { name: 'source_entity_type', type: 'string' }, { name: 'source_entity_id', type: 'string' },
      { name: 'tax_period_key', type: 'string' }, { name: 'category', type: 'string' },
      { name: 'tax_head', type: 'string' },
      { name: 'original_eligible_paise', type: 'paise' },
      { name: 'temporarily_reversed_paise', type: 'paise' },
      { name: 'permanently_reversed_paise', type: 'paise' },
      { name: 'reclaimable_paise', type: 'paise' }, { name: 'reclaimed_paise', type: 'paise' },
      { name: 'status', type: 'string' }, { name: 'reason_code', type: 'string_or_null' },
      { name: 'related_prior_entry_id', type: 'string_or_null' },
      { name: 'user_confirmation', type: 'boolean_int_or_null' },
      ...COMMON_AUDIT,
    ],
  },
];

export function findTableSpecByFile(file: string): TableSpec | undefined {
  return TABLE_SPECS.find((s) => s.file === file);
}

/**
 * Convert a raw CSV row (all string values, per parseCsv) to the typed shape
 * described by ColumnSpec. Missing columns are treated as empty.
 * Reversal of the sanitizeCsvCell single-quote prefix is caller's responsibility;
 * here we accept that the parser returned strings verbatim.
 */
/** Strip the formula-injection guard prefix (leading `'`) added by sanitizeCsvCell. */
function unescape(v: string): string {
  if (v.length >= 2 && v.charAt(0) === "'") {
    const second = v.charAt(1);
    if (
      second === '=' ||
      second === '+' ||
      second === '-' ||
      second === '@' ||
      second === '\t' ||
      second === '\r'
    ) {
      return v.slice(1);
    }
  }
  return v;
}

export function coerceRow(
  raw: Record<string, string>,
  spec: TableSpec,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of spec.columns) {
    const v = unescape(raw[col.name] ?? '');
    switch (col.type) {
      case 'string':
        out[col.name] = v;
        break;
      case 'string_or_null':
        out[col.name] = v === '' ? null : v;
        break;
      case 'number': {
        if (v === '') {
          out[col.name] = 0;
        } else {
          const n = Number(v);
          if (!Number.isFinite(n)) {
            throw new Error(
              `coerceRow: '${col.name}' is not a finite number: ${JSON.stringify(v)}`,
            );
          }
          out[col.name] = n;
        }
        break;
      }
      case 'number_or_null': {
        if (v === '') {
          out[col.name] = null;
        } else {
          const n = Number(v);
          if (!Number.isFinite(n)) {
            throw new Error(
              `coerceRow: '${col.name}' is not a finite number: ${JSON.stringify(v)}`,
            );
          }
          out[col.name] = n;
        }
        break;
      }
      case 'paise': {
        if (v === '') {
          out[col.name] = null;
        } else {
          const n = Number(v);
          if (!Number.isInteger(n)) {
            throw new Error(
              `coerceRow: '${col.name}' must be integer paise: ${JSON.stringify(v)}`,
            );
          }
          if (!Number.isSafeInteger(n)) {
            throw new Error(
              `coerceRow: '${col.name}' must be a safe integer paise value: ${JSON.stringify(v)}`,
            );
          }
          out[col.name] = n;
        }
        break;
      }
      case 'boolean_int': {
        if (v === '' || v === '0' || v === 'false') out[col.name] = 0;
        else out[col.name] = 1;
        break;
      }
      case 'boolean_int_or_null': {
        if (v === '') out[col.name] = null;
        else if (v === '0' || v === 'false') out[col.name] = 0;
        else out[col.name] = 1;
        break;
      }
      case 'json': {
        // Handle the payment allocations mapping onto the `allocations` field
        // and the advance applications mapping onto the `applications` field.
        // Both are serialized to CSV as JSON columns with a `_json` suffix so
        // the on-disk shape stays flat.
        const target =
          col.name === 'allocations_json'
            ? 'allocations'
            : col.name === 'applications_json'
              ? 'applications'
              : col.name;
        if (v === '') {
          out[target] = target === 'allocations' || target === 'applications' ? [] : null;
        } else {
          try {
            out[target] = JSON.parse(v);
          } catch (err) {
            throw new Error(
              `coerceRow: invalid JSON in column '${col.name}': ${(err as Error).message}`,
            );
          }
        }
        if (target !== col.name) delete out[col.name];
        break;
      }
    }
  }
  return out;
}
