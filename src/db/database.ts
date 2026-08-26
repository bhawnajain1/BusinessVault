import Dexie, { type Table } from 'dexie';
import {
  DB_NAME,
  STORES_V1,
  STORES_V2,
  STORES_V3,
  STORES_V4,
  STORES_V5,
} from './schema';
import { pokeSyncWorker } from '../sync/pokeChannel';
import type {
  Account,
  Advance,
  Attachment,
  AuditLogEntry,
  AuthToken,
  Business,
  Category,
  Customer,
  DebugLogEntry,
  Device,
  DriveFileMap,
  Expense,
  Invoice,
  InvoiceLine,
  InvoiceLineReturnSummary,
  Item,
  ItemStock,
  JournalEntry,
  JournalLine,
  KVEntry,
  LegacyReversalAudit,
  Payment,
  Purchase,
  PurchaseLine,
  SalesReturn,
  SalesReturnItem,
  StockMovement,
  Supplier,
  SyncEvent,
  SyncQueueJob,
  Unit,
  Warehouse,
} from './types';

export class BusinessVaultDB extends Dexie {
  businesses!: Table<Business, string>;
  devices!: Table<Device, string>;
  customers!: Table<Customer, string>;
  suppliers!: Table<Supplier, string>;
  categories!: Table<Category, string>;
  units!: Table<Unit, string>;
  warehouses!: Table<Warehouse, string>;
  items!: Table<Item, string>;
  item_stock!: Table<ItemStock, string>;
  invoices!: Table<Invoice, string>;
  invoice_lines!: Table<InvoiceLine, string>;
  purchases!: Table<Purchase, string>;
  purchase_lines!: Table<PurchaseLine, string>;
  payments!: Table<Payment, string>;
  expenses!: Table<Expense, string>;
  stock_movements!: Table<StockMovement, string>;
  accounts!: Table<Account, string>;
  journal_entries!: Table<JournalEntry, string>;
  journal_lines!: Table<JournalLine, string>;
  sync_events!: Table<SyncEvent, string>;
  drive_file_map!: Table<DriveFileMap, string>;
  sync_queue!: Table<SyncQueueJob, string>;
  attachments!: Table<Attachment, string>;
  audit_log!: Table<AuditLogEntry, string>;
  auth_tokens!: Table<AuthToken, string>;
  kv!: Table<KVEntry, string>;
  advances!: Table<Advance, string>;
  debug_logs!: Table<DebugLogEntry, number>;
  sales_returns!: Table<SalesReturn, string>;
  sales_return_items!: Table<SalesReturnItem, string>;
  invoice_line_return_summary!: Table<InvoiceLineReturnSummary, string>;
  legacy_reversal_audit!: Table<LegacyReversalAudit, string>;

  constructor(name: string = DB_NAME) {
    super(name);
    this.version(1).stores(STORES_V1);
    this.version(2).stores(STORES_V2);
    this.version(3).stores(STORES_V3);
    this.version(4).stores(STORES_V4);
    this.version(5).stores(STORES_V5);

    // After any sync_event insert commits, kick the sync worker so the write
    // lands in the local backup folder within a few hundred ms instead of
    // waiting for the next 5s tick. Fires on ALL writers uniformly, so no
    // service needs its own poke call. pokeChannel is its own tiny module
    // (no db import) so we can static-import without a cycle — a dynamic
    // import here would defer the poke past startSyncWorker registration in
    // tests and cause an extra tick / extra journal write.
    //
    // The `creating` hook fires per-row; without a tx-scoped guard, a
    // bulkAdd(N) would register N identical `on('complete')` callbacks and
    // poke N times on commit. Store a flag on the tx object so only the
    // first row in each tx registers the listener.
    this.sync_events.hook('creating', () => {
      const tx = Dexie.currentTransaction as (typeof Dexie.currentTransaction & {
        __bvPokeRegistered?: boolean;
      }) | null;
      if (!tx || tx.__bvPokeRegistered) return;
      tx.__bvPokeRegistered = true;
      tx.on('complete', () => {
        pokeSyncWorker();
      });
    });
  }
}
