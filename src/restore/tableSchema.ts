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
  | 'boolean_int'
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
      { name: 'invoice_prefix', type: 'string' },
      { name: 'invoice_next_seq', type: 'number' },
      { name: 'drive_folder_id', type: 'string_or_null' },
      { name: 'drive_connected_email', type: 'string_or_null' },
      { name: 'schema_version', type: 'number' },
      ...COMMON_AUDIT,
    ],
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
      { name: 'total_paise', type: 'number' },
      { name: 'paid_paise', type: 'number' },
      { name: 'balance_paise', type: 'number' },
      { name: 'status', type: 'string' },
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
      case 'boolean_int': {
        if (v === '' || v === '0' || v === 'false') out[col.name] = 0;
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
