import type {
  Invoice,
  InvoiceLine,
  Payment,
  PaymentAllocation,
  Purchase,
  PurchaseLine,
  Expense,
  JournalEntry,
  JournalLine,
  Customer,
  Supplier,
  Item,
  StockMovement,
} from '../db/types';

export interface InvoiceCreatedEvent {
  entityType: 'invoice';
  operation: 'created';
  payload: Invoice;
}

export interface InvoiceUpdatedEvent {
  entityType: 'invoice';
  operation: 'updated';
  payload: Partial<Invoice> & { id: string };
}

export interface InvoiceVoidedEvent {
  entityType: 'invoice';
  operation: 'voided';
  payload: {
    invoice_id: string;
    voided_at: string;
    reason: string;
    credit_note_invoice_id: string | null;
  };
}

export interface InvoiceLineCreatedEvent {
  entityType: 'invoice_line';
  operation: 'created';
  payload: InvoiceLine;
}

export interface PaymentCreatedEvent {
  entityType: 'payment';
  operation: 'created';
  payload: Payment;
}

export interface PaymentAllocatedEvent {
  entityType: 'payment';
  operation: 'allocated';
  payload: {
    payment_id: string;
    allocations: PaymentAllocation[];
  };
}

export interface PurchaseCreatedEvent {
  entityType: 'purchase';
  operation: 'created';
  payload: Purchase;
}

export interface PurchaseLineCreatedEvent {
  entityType: 'purchase_line';
  operation: 'created';
  payload: PurchaseLine;
}

export interface StockAdjustedEvent {
  entityType: 'item_stock';
  operation: 'adjusted';
  payload: {
    item_id: string;
    warehouse_id: string;
    delta_qty_micros: number;
    reason: string;
    ref_type: StockMovement['ref_type'];
    ref_id: string;
    occurred_at: string;
  };
}

export interface StockMovementEvent {
  entityType: 'stock_movement';
  operation: 'movement';
  payload: StockMovement;
}

export interface ExpenseCreatedEvent {
  entityType: 'expense';
  operation: 'created';
  payload: Expense;
}

export interface JournalPostedEvent {
  entityType: 'journal_entry';
  operation: 'posted';
  payload: JournalEntry;
}

export interface JournalLineCreatedEvent {
  entityType: 'journal_line';
  operation: 'created';
  payload: JournalLine;
}

export interface CustomerCreatedEvent {
  entityType: 'customer';
  operation: 'created';
  payload: Customer;
}

export interface CustomerUpdatedEvent {
  entityType: 'customer';
  operation: 'updated';
  payload: Partial<Customer> & { id: string };
}

export interface SupplierCreatedEvent {
  entityType: 'supplier';
  operation: 'created';
  payload: Supplier;
}

export interface ItemCreatedEvent {
  entityType: 'item';
  operation: 'created';
  payload: Item;
}

export interface ItemUpdatedEvent {
  entityType: 'item';
  operation: 'updated';
  payload: Partial<Item> & { id: string };
}

export interface ReturnCreatedEvent {
  entityType: 'invoice';
  operation: 'created';
  payload: Invoice & { reverses_invoice_id: string };
}

export type BusinessEvent =
  | InvoiceCreatedEvent
  | InvoiceUpdatedEvent
  | InvoiceVoidedEvent
  | InvoiceLineCreatedEvent
  | PaymentCreatedEvent
  | PaymentAllocatedEvent
  | PurchaseCreatedEvent
  | PurchaseLineCreatedEvent
  | StockAdjustedEvent
  | StockMovementEvent
  | ExpenseCreatedEvent
  | JournalPostedEvent
  | JournalLineCreatedEvent
  | CustomerCreatedEvent
  | CustomerUpdatedEvent
  | SupplierCreatedEvent
  | ItemCreatedEvent
  | ItemUpdatedEvent
  | ReturnCreatedEvent;

export type BusinessEventEntityType = BusinessEvent['entityType'];
export type BusinessEventOperation = BusinessEvent['operation'];

export type PayloadFor<
  T extends BusinessEventEntityType,
  O extends BusinessEventOperation,
> = Extract<BusinessEvent, { entityType: T; operation: O }>['payload'];
