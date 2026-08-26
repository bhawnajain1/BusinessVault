import Dexie, { type Table } from 'dexie';
import {
  DB_NAME,
  STORES_V1,
  STORES_V2,
  STORES_V3,
  STORES_V4,
  STORES_V5,
  STORES_V6,
  STORES_V7,
  STORES_V8,
} from './schema';
import { ulid } from 'ulid';
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
    // v6: backfill round_off_mode + pre_round_total_paise on existing invoices,
    // purchases, and sales_returns. The invariant is pre_round + round_off ==
    // total, which is definitionally true for pre-v6 rows because their totals
    // were computed with roundOff already folded in. `auto` is chosen because
    // any pre-v6 row that had a non-zero round_off was written by the POS
    // (which always uses nearest-rupee) — reads as "auto" cleanly.
    this.version(6)
      .stores(STORES_V6)
      .upgrade(async (tx) => {
        await tx
          .table('invoices')
          .toCollection()
          .modify((row: { round_off_paise?: number; total_paise?: number; round_off_mode?: string; pre_round_total_paise?: number }) => {
            if (row.round_off_mode === undefined) {
              row.round_off_mode = 'auto';
            }
            if (row.pre_round_total_paise === undefined) {
              row.pre_round_total_paise = (row.total_paise ?? 0) - (row.round_off_paise ?? 0);
            }
          });
        await tx
          .table('purchases')
          .toCollection()
          .modify((row: { round_off_paise?: number; total_paise?: number; round_off_mode?: string; pre_round_total_paise?: number }) => {
            if (row.round_off_mode === undefined) {
              row.round_off_mode = 'auto';
            }
            if (row.pre_round_total_paise === undefined) {
              row.pre_round_total_paise = (row.total_paise ?? 0) - (row.round_off_paise ?? 0);
            }
          });
        await tx
          .table('sales_returns')
          .toCollection()
          .modify((row: { round_off_paise?: number; total_paise?: number; round_off_mode?: string; pre_round_total_paise?: number }) => {
            if (row.round_off_mode === undefined) {
              row.round_off_mode = 'auto';
            }
            if (row.pre_round_total_paise === undefined) {
              row.pre_round_total_paise = (row.total_paise ?? 0) - (row.round_off_paise ?? 0);
            }
          });
      });

    // v7: feedback §9 Recycle Bin accounting fix. For every invoice that is
    // ALREADY soft-deleted at upgrade time (deleted_at != null) but never had
    // its journal reversed, post a mirror-of-original journal so it stops
    // contributing to Trial Balance / P&L / Balance Sheet / GST summary /
    // party ledger. New soft-deletes performed post-upgrade take the same
    // path centrally inside InvoiceService.deleteInvoice.
    //
    // The upgrade posts journals via the same shape edit-reversal already
    // uses (ref_type='reversal', reverses_id=<original journal>). Idempotent:
    // if `deletion_reversal_journal_id` is already set on the row, skip it.
    this.version(7)
      .stores(STORES_V7)
      .upgrade(async (tx) => {
        const invoicesTable = tx.table('invoices');
        const journalEntriesTable = tx.table('journal_entries');
        const journalLinesTable = tx.table('journal_lines');

        const staleDeleted = await invoicesTable
          .toCollection()
          .filter((r: { deleted_at?: string | null; deletion_reversal_journal_id?: string | null }) =>
            r.deleted_at != null && r.deletion_reversal_journal_id == null,
          )
          .toArray();

        for (const inv of staleDeleted as Array<{
          id: string;
          business_id: string;
          invoice_number: string;
          invoice_date: string;
          journal_entry_id: string;
          deleted_reason?: string | null;
          entity_version: number;
        }>) {
          if (!inv.journal_entry_id) continue;
          const originalJournal = await journalEntriesTable.get(inv.journal_entry_id);
          if (!originalJournal) continue;
          const originalLines = await journalLinesTable
            .where('entry_id')
            .equals(inv.journal_entry_id)
            .toArray();
          if (originalLines.length === 0) continue;

          const now = new Date().toISOString();
          const reversalId = ulid();
          await journalEntriesTable.add({
            id: reversalId,
            business_id: inv.business_id,
            entry_number: `JE-DEL-${inv.id}`,
            entry_date: inv.invoice_date,
            narration: `Recycle bin reversal (backfill v7) of ${inv.invoice_number}: ${inv.deleted_reason ?? 'deleted'}`,
            ref_type: 'reversal',
            ref_id: inv.id,
            reversed_by_id: null,
            reverses_id: inv.journal_entry_id,
            total_debit_paise: (originalJournal as { total_credit_paise: number }).total_credit_paise,
            total_credit_paise: (originalJournal as { total_debit_paise: number }).total_debit_paise,
            posted: 1,
            created_at: now,
            updated_at: now,
            entity_version: 1,
          });
          const mirrored = (originalLines as Array<{
            business_id: string;
            account_id: string;
            debit_paise: number;
            credit_paise: number;
            party_type: string | null;
            party_id: string | null;
            description: string;
          }>).map((l, idx) => ({
            id: ulid(),
            business_id: l.business_id,
            entry_id: reversalId,
            line_no: idx + 1,
            account_id: l.account_id,
            debit_paise: l.credit_paise,
            credit_paise: l.debit_paise,
            party_type: l.party_type,
            party_id: l.party_id,
            description: `Recycle bin reversal: ${l.description}`,
          }));
          await journalLinesTable.bulkAdd(mirrored);
          await invoicesTable.update(inv.id, {
            deletion_reversal_journal_id: reversalId,
            updated_at: now,
            entity_version: inv.entity_version + 1,
          });
        }
      });

    // v8: feedback §2 Authorised Signature — sidecar fields on businesses and
    // invoices. Backfill defaults so pre-v8 rows read as "no signature". The
    // signature toggle defaults OFF so existing installs don't start
    // silently altering invoice PDFs the next time they print one.
    this.version(8)
      .stores(STORES_V8)
      .upgrade(async (tx) => {
        const businessesTable = tx.table('businesses');
        const invoicesTable = tx.table('invoices');
        const now = new Date().toISOString();
        await businessesTable.toCollection().modify((row: {
          signature_ref?: string | null;
          show_signature_on_invoice?: 0 | 1;
          updated_at?: string;
          entity_version?: number;
        }) => {
          if (row.signature_ref === undefined) row.signature_ref = null;
          if (row.show_signature_on_invoice === undefined)
            row.show_signature_on_invoice = 0;
          row.updated_at = now;
          row.entity_version = (row.entity_version ?? 0) + 1;
        });
        await invoicesTable.toCollection().modify((row: {
          signature_attachment_id?: string | null;
        }) => {
          if (row.signature_attachment_id === undefined)
            row.signature_attachment_id = null;
        });
      });

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
