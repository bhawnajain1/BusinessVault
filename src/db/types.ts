export type SyncStatus =
  | 'LOCAL_ONLY'
  | 'QUEUED'
  | 'SYNCING'
  | 'SYNCED'
  | 'CONFLICT'
  | 'FAILED';

export type EntityType =
  | 'business'
  | 'device'
  | 'customer'
  | 'supplier'
  | 'category'
  | 'unit'
  | 'warehouse'
  | 'item'
  | 'item_stock'
  | 'invoice'
  | 'invoice_line'
  | 'purchase'
  | 'purchase_line'
  | 'payment'
  | 'expense'
  | 'stock_movement'
  | 'account'
  | 'journal_entry'
  | 'journal_line'
  | 'attachment'
  | 'advance';

export type EventOperation =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'posted'
  | 'reversed';

export type InvoiceStatus =
  | 'draft'
  | 'issued'
  | 'partial'
  | 'paid'
  | 'cancelled';

export type PurchaseStatus =
  | 'draft'
  | 'received'
  | 'partial'
  | 'paid'
  | 'cancelled';

export type PaymentDirection = 'in' | 'out';
export type PartyType = 'customer' | 'supplier';
export type PaymentMethod = 'cash' | 'bank' | 'upi' | 'card' | 'cheque';

export type AccountType =
  | 'asset'
  | 'liability'
  | 'equity'
  | 'income'
  | 'expense';

export type MovementType =
  | 'opening'
  | 'purchase'
  | 'sale'
  | 'sale_return'
  | 'purchase_return'
  | 'adjustment'
  | 'transfer';

export type RefType =
  | 'invoice'
  | 'purchase'
  | 'payment'
  | 'expense'
  | 'manual'
  | 'opening'
  | 'reversal'
  | 'adjustment'
  | 'item'
  | 'product'
  | 'advance'
  | 'advance_application';

export type SyncJobKind =
  | 'journal_flush'
  | 'snapshot'
  | 'attachment_upload'
  | 'manifest_update'
  | 'restore';

export type SyncJobStatus = 'pending' | 'running' | 'failed' | 'done';

export interface Business {
  id: string;
  name: string;
  legal_name: string;
  gstin: string | null;
  pan: string | null;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  state_code: string;
  pincode: string;
  country: string;
  phone: string;
  email: string;
  financial_year_start_month: number;
  current_financial_year: string;
  currency: string;
  logo_ref: string | null;
  invoice_prefix: string;
  invoice_next_seq: number;
  drive_folder_id: string | null;
  drive_connected_email: string | null;
  schema_version: number;
  created_at: string;
  updated_at: string;
  entity_version: number;
}

export interface Device {
  id: string;
  business_id: string;
  device_name: string;
  user_agent: string;
  first_seen_at: string;
  last_seen_at: string;
  active: number;
}

export interface Customer {
  id: string;
  business_id: string;
  name: string;
  phone: string;
  email: string;
  gstin: string | null;
  billing_address: string;
  shipping_address: string;
  state: string;
  state_code: string;
  opening_balance_paise: number; // money: integer paise (INR minor units)
  credit_limit_paise: number; // money: integer paise
  notes: string;
  active: number;
  created_at: string;
  updated_at: string;
  entity_version: number;
}

export interface Supplier {
  id: string;
  business_id: string;
  name: string;
  phone: string;
  email: string;
  gstin: string | null;
  address: string;
  state: string;
  state_code: string;
  opening_balance_paise: number; // money: integer paise
  notes: string;
  active: number;
  created_at: string;
  updated_at: string;
  entity_version: number;
}

export interface Category {
  id: string;
  business_id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
  entity_version: number;
}

export interface Unit {
  id: string;
  business_id: string;
  code: string;
  name: string;
  decimal_places: number;
  created_at: string;
  updated_at: string;
  entity_version: number;
}

export interface Warehouse {
  id: string;
  business_id: string;
  name: string;
  address: string;
  is_default: number;
  active: number;
  created_at: string;
  updated_at: string;
  entity_version: number;
}

export interface Item {
  id: string;
  business_id: string;
  sku: string;
  name: string;
  description: string;
  hsn: string;
  category_id: string | null;
  unit_id: string;
  sale_price_paise: number; // money: integer paise
  purchase_price_paise: number; // money: integer paise
  tax_rate_bps: number; // basis points; 1800 = 18%
  cess_rate_bps: number;
  is_service: number;
  track_inventory: number;
  opening_qty_micros: number; // 6-decimal fixed point
  opening_value_paise: number; // money: integer paise
  reorder_level_micros: number;
  barcode: string | null;
  image_ref: string | null;
  active: number;
  created_at: string;
  updated_at: string;
  entity_version: number;
}

export interface ItemStock {
  id: string;
  business_id: string;
  item_id: string;
  warehouse_id: string;
  qty_micros: number;
  avg_cost_paise: number; // money: integer paise per unit
  updated_at: string;
}

export interface Invoice {
  id: string;
  business_id: string;
  invoice_number: string;
  invoice_date: string; // YYYY-MM-DD
  due_date: string | null;
  customer_id: string;
  customer_state_code: string;
  place_of_supply: string;
  is_interstate: number;
  financial_year: string;
  subtotal_paise: number; // money: integer paise
  discount_paise: number; // money: integer paise
  taxable_paise: number; // money: integer paise
  cgst_paise: number; // money: integer paise
  sgst_paise: number; // money: integer paise
  igst_paise: number; // money: integer paise
  cess_paise: number; // money: integer paise
  round_off_paise: number; // money: integer paise (signed)
  total_paise: number; // money: integer paise
  paid_paise: number; // money: integer paise
  balance_paise: number; // money: integer paise (signed)
  status: InvoiceStatus;
  reversed_by_invoice_id: string | null;
  reverses_invoice_id: string | null;
  notes: string;
  terms: string;
  pdf_attachment_id: string | null;
  journal_entry_id: string;
  // Soft-delete "recycle bin" fields. When set, the invoice is hidden from the
  // main list and its linked payments/advance applications are cascade-hidden
  // (via `deleted_at` on those rows). Restore is a straight nullification of
  // these fields on all cascaded rows. The invoice itself, its lines, and its
  // journal entry are NEVER removed from IndexedDB — audit chain intact.
  deleted_at?: string | null;
  deleted_reason?: string | null;
  created_at: string;
  updated_at: string;
  entity_version: number;
}

export interface InvoiceLine {
  id: string;
  business_id: string;
  invoice_id: string;
  line_no: number;
  item_id: string;
  description: string;
  hsn: string;
  warehouse_id: string;
  qty_micros: number;
  unit_price_paise: number; // money: integer paise
  discount_pct_bps: number;
  discount_paise: number; // money: integer paise
  taxable_paise: number; // money: integer paise
  tax_rate_bps: number;
  cgst_paise: number; // money: integer paise
  sgst_paise: number; // money: integer paise
  igst_paise: number; // money: integer paise
  cess_paise: number; // money: integer paise
  line_total_paise: number; // money: integer paise
}

export interface Purchase {
  id: string;
  business_id: string;
  bill_number: string;
  supplier_bill_number: string;
  bill_date: string;
  due_date: string | null;
  supplier_id: string;
  supplier_state_code: string;
  is_interstate: number;
  financial_year: string;
  subtotal_paise: number; // money: integer paise
  discount_paise: number; // money: integer paise
  taxable_paise: number; // money: integer paise
  cgst_paise: number; // money: integer paise
  sgst_paise: number; // money: integer paise
  igst_paise: number; // money: integer paise
  cess_paise: number; // money: integer paise
  round_off_paise: number; // money: integer paise
  total_paise: number; // money: integer paise
  paid_paise: number; // money: integer paise
  balance_paise: number; // money: integer paise
  status: PurchaseStatus;
  notes: string;
  attachment_id: string | null;
  journal_entry_id: string;
  created_at: string;
  updated_at: string;
  entity_version: number;
}

export interface PurchaseLine {
  id: string;
  business_id: string;
  purchase_id: string;
  line_no: number;
  item_id: string;
  description: string;
  hsn: string;
  warehouse_id: string;
  qty_micros: number;
  unit_cost_paise: number; // money: integer paise
  discount_paise: number; // money: integer paise
  taxable_paise: number; // money: integer paise
  tax_rate_bps: number;
  cgst_paise: number; // money: integer paise
  sgst_paise: number; // money: integer paise
  igst_paise: number; // money: integer paise
  cess_paise: number; // money: integer paise
  line_total_paise: number; // money: integer paise
}

export interface PaymentAllocation {
  invoice_id?: string;
  bill_id?: string;
  // Set when this slice captured excess and became an on-account advance for
  // the party. The advance JE credits Customer/Supplier Advances instead of
  // AR/AP. Exactly one of {invoice_id, bill_id, advance_id} is set.
  advance_id?: string;
  amount_paise: number; // money: integer paise
}

export interface Payment {
  id: string;
  business_id: string;
  payment_number: string;
  payment_date: string;
  direction: PaymentDirection;
  party_type: PartyType;
  party_id: string;
  method: PaymentMethod;
  account_id: string;
  amount_paise: number; // money: integer paise
  reference: string;
  notes: string;
  allocations: PaymentAllocation[];
  journal_entry_id: string;
  // Cascade soft-delete: set when the sole invoice this payment is allocated
  // against is deleted via InvoiceService.deleteInvoice. Restore clears it.
  deleted_at?: string | null;
  deleted_reason?: string | null;
  created_at: string;
  updated_at: string;
  entity_version: number;
}

// Advance: money received from a customer (or paid to a supplier) BEFORE any
// invoice / bill exists. Held as a liability (customer advance = 2050) or
// asset (supplier advance = 1250) until applied. Applied amounts are appended
// to `applications` and decrement `remaining_paise` (never below zero).
// See spec §5, §6, §14 in payablesRec.md.
export interface AdvanceApplication {
  invoice_id?: string;
  bill_id?: string;
  amount_paise: number;
  applied_at: string;
  journal_entry_id: string;
}

export interface Advance {
  id: string;
  business_id: string;
  advance_number: string;
  advance_date: string;
  party_type: PartyType;
  party_id: string;
  method: PaymentMethod;
  account_id: string; // cash/bank account debited (customer) or credited (supplier)
  amount_paise: number; // original receipt/payment
  remaining_paise: number; // amount NOT yet applied to any invoice/bill
  reference: string;
  notes: string;
  applications: AdvanceApplication[];
  journal_entry_id: string; // the receipt/payment JE
  // Cascade soft-delete: set when the sole invoice this advance was applied to
  // is deleted via InvoiceService.deleteInvoice. Restore clears it.
  deleted_at?: string | null;
  deleted_reason?: string | null;
  created_at: string;
  updated_at: string;
  entity_version: number;
}

export interface Expense {
  id: string;
  business_id: string;
  expense_number: string;
  expense_date: string;
  category_account_id: string;
  payment_account_id: string;
  supplier_id: string | null;
  description: string;
  amount_paise: number; // money: integer paise
  tax_paise: number; // money: integer paise
  total_paise: number; // money: integer paise
  attachment_id: string | null;
  journal_entry_id: string;
  created_at: string;
  updated_at: string;
  entity_version: number;
}

export interface StockMovement {
  id: string;
  business_id: string;
  item_id: string;
  warehouse_id: string;
  movement_type: MovementType;
  qty_micros: number; // signed
  unit_cost_paise: number; // money: integer paise per unit
  ref_type: RefType;
  ref_id: string;
  occurred_at: string;
  notes: string;
}

export interface Account {
  id: string;
  business_id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  parent_id: string | null;
  opening_balance_paise: number; // money: integer paise, signed by normal side
  is_system: number;
  active: number;
  created_at: string;
  updated_at: string;
  entity_version: number;
}

export interface JournalEntry {
  id: string;
  business_id: string;
  entry_number: string;
  entry_date: string;
  narration: string;
  ref_type: RefType;
  ref_id: string | null;
  reversed_by_id: string | null;
  reverses_id: string | null;
  total_debit_paise: number; // money: integer paise
  total_credit_paise: number; // money: integer paise
  posted: number;
  created_at: string;
  updated_at: string;
  entity_version: number;
}

export interface JournalLine {
  id: string;
  business_id: string;
  entry_id: string;
  line_no: number;
  account_id: string;
  debit_paise: number; // money: integer paise
  credit_paise: number; // money: integer paise
  party_type: PartyType | null;
  party_id: string | null;
  description: string;
}

export interface SyncEvent {
  event_id: string;
  sequence?: number;
  business_id: string;
  device_id: string;
  entity_type: EntityType;
  entity_id: string;
  operation: EventOperation;
  entity_version: number;
  timestamp: string;
  payload: unknown;
  payload_hash: string;
  previous_hash: string;
  sync_status: SyncStatus;
  sync_attempts: number;
  last_error: string | null;
  synced_at: string | null;
  journal_file: string | null;
}

export interface DriveFileMap {
  id: string;
  business_id: string;
  logical_path: string;
  drive_file_id: string;
  drive_version: string;
  modified_time: string;
  checksum: string;
  size_bytes: number;
  updated_at: string;
}

export interface SyncQueueJob {
  id: string;
  business_id: string;
  kind: SyncJobKind;
  payload: unknown;
  status: SyncJobStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Attachment {
  id: string;
  business_id: string;
  ref_type: RefType;
  ref_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  checksum: string;
  blob: Blob | null;
  drive_file_id: string | null;
  logical_path: string;
  created_at: string;
  updated_at: string;
}

export interface AuditLogEntry {
  id: string;
  business_id: string;
  device_id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before: unknown;
  after: unknown;
  at: string;
}

export interface AuthToken {
  id: string;
  business_id: string;
  provider: 'google';
  access_token_ct: ArrayBuffer;
  refresh_token_ct: ArrayBuffer;
  expires_at: string;
  scope: string;
  account_email: string;
  iv: ArrayBuffer;
  updated_at: string;
}

export interface KVEntry {
  key: string;
  value: unknown;
  updated_at: string;
}

// A structured log entry. Written by src/lib/log.ts and shown / exported from
// Settings so users can attach diagnostic bundles to a bug report. Kept
// deliberately flat — one JSON line per row when exported.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DebugLogEntry {
  id?: number;
  ts: string; // ISO
  level: LogLevel;
  source: string; // module tag, e.g. 'sync', 'invoice', 'provider'
  msg: string;
  ctx?: Record<string, unknown> | null;
}
