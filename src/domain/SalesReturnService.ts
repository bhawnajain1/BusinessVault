import Dexie from 'dexie';
import { ulid } from 'ulid';
import { db as defaultDb, type BusinessVaultDB } from '../db';
import type {
  Invoice,
  InvoiceLine,
  ItemStock,
  JournalEntry,
  JournalLine,
  SalesReturn,
  SalesReturnItem,
  StockMovement,
  SyncEvent,
} from '../db/types';
import { GENESIS_HASH, canonicalJson, sha256Hex } from '../journal/event';
import { SYSTEM_ACCOUNT_CODES, findAccountByCode } from './coa';
import { allocateSalesReturnNumber } from './salesReturnNumbering';
import { rebuildInvoiceLineReturnSummary } from './invoiceLineReturnSummary';
import { log } from '../lib/log';

// SalesReturnService — the ONLY code path that creates a native Sales Return
// (schema v5). Distinct from InvoiceService.updateInvoice's internal
// reverseInvoicePosting, which still writes a legacy reversal Invoice for
// journal integrity but is NEVER surfaced as a Sales Return.
//
// Design invariants (per SellReturnRequirement.md and 2026-08-26 user directive):
//
//   - Per-line quantity picker. Caller specifies which lines and how much
//     of each. `available_to_return = current_invoice_line_qty
//     - SUM(active sales_return_items.qty_micros)`. Exceeding it is a hard
//     error.
//
//   - Line financials (unit_price, discount, GST, taxable, line_total) are
//     copied from the ORIGINAL invoice line at return time. Pro-rated by
//     `returned_qty / original_qty` so a partial return produces
//     proportionally sized amounts. Item master's current values are NEVER
//     used — an item that's been re-priced or had its tax rate changed does
//     not affect an old return's economics.
//
//   - Original invoice's total_paise / subtotal_paise / tax fields are NEVER
//     mutated. Preserving "invoice X was for ₹10,000" as an immutable fact
//     is the entire point of separating returns from edits.
//
//   - invoice.balance_paise IS reduced by the return amount that offsets
//     outstanding balance. Any excess (return > outstanding) becomes an
//     `Advance` (customer credit) instead of going negative. Ledgers and
//     aging reports read `balance_paise` directly, so this keeps them
//     correct without a special-case query layer.
//
//   - Positive stock movements bring goods back into inventory (movement_type
//     = 'sale_return', ref_type = 'sales_return', ref_id = salesReturnId).
//     ref_type is 'sales_return' (not 'invoice') so `getReturnedQtyMicros`
//     and legacy migration can distinguish v5 native return movements from
//     the pre-v5 CN-invoice ones.
//
//   - Reversing journal entry mirrors ReturnService's shape but scaled to
//     the returned lines only. Balanced. Posted in the same tx.
//
//   - invoice_line_return_summary cache updated in-tx via
//     rebuildInvoiceLineReturnSummary — cheaper than the full function only
//     matters at scale; correctness matters more, so we call the
//     invoice-scoped rebuild.
//
//   - Sync events written for the header + each item + each movement + the
//     JE + JE lines + (if any) the customer-credit advance. The audit event
//     `SALES_RETURN_CREATED` is emitted as the 'created' operation on
//     entity_type='sales_return' — no separate audit_log wiring needed here;
//     PR3 splits audit_log entries per §5, but the sync_event on
//     'sales_return' already gives us the traceable event.

export class SalesReturnValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SalesReturnValidationError';
  }
}

export interface SalesReturnLineInput {
  original_invoice_line_id: string;
  qty_micros: number;
}

export interface CreateSalesReturnInput {
  business_id: string;
  device_id: string;
  original_invoice_id: string;
  return_date: string; // YYYY-MM-DD
  reason: string;
  notes?: string;
  lines: SalesReturnLineInput[];
  // Numbering is delegated — caller does NOT supply return_number. Business-
  // wide sequential SR-###### assigned inside the tx. See spec §16.
  idempotency_key?: string;
}

export class SalesReturnService {
  constructor(private readonly db: BusinessVaultDB = defaultDb) {}

  async createSalesReturn(input: CreateSalesReturnInput): Promise<SalesReturn> {
    log.info('salesReturn', 'createSalesReturn called', {
      businessId: input.business_id,
      deviceId: input.device_id,
      originalInvoiceId: input.original_invoice_id,
      returnDate: input.return_date,
      lineCount: input.lines?.length ?? 0,
      lineSummaries: (input.lines ?? []).map((l) => ({
        lineId: l.original_invoice_line_id,
        qty: l.qty_micros,
      })),
      hasIdempotencyKey: !!input.idempotency_key,
    });
    if (!input.reason || input.reason.trim().length === 0) {
      log.warn('salesReturn', 'createSalesReturn rejected: missing reason', {
        originalInvoiceId: input.original_invoice_id,
      });
      throw new SalesReturnValidationError('reason is required');
    }
    if (!input.lines || input.lines.length === 0) {
      log.warn('salesReturn', 'createSalesReturn rejected: no lines', {
        originalInvoiceId: input.original_invoice_id,
      });
      throw new SalesReturnValidationError('at least one line is required');
    }
    for (const l of input.lines) {
      if (!Number.isInteger(l.qty_micros) || l.qty_micros <= 0) {
        log.warn(
          'salesReturn',
          'createSalesReturn rejected: non-positive qty',
          { line: l },
        );
        throw new SalesReturnValidationError(
          `line ${l.original_invoice_line_id}: qty_micros must be a positive integer`,
        );
      }
    }

    // -------- pre-tx reads (informational; re-checked inside tx) ------------
    const original = await this.db.invoices.get(input.original_invoice_id);
    if (!original) {
      throw new SalesReturnValidationError(
        `invoice ${input.original_invoice_id} not found`,
      );
    }
    if (original.business_id !== input.business_id) {
      throw new SalesReturnValidationError('business_id mismatch');
    }
    if (original.deleted_at) {
      throw new SalesReturnValidationError('cannot return a deleted invoice');
    }
    // A "reversed_by_invoice_id" set on the original means an old-style CN
    // was posted against it (pre-v5 flow or an edit reversal). We DO allow
    // returns against edited invoices — the edit path replaces both the
    // original and the reversal with a fresh reissue, and updateInvoice()
    // does not carry reversed_by_invoice_id forward to the reissue.

    const [receivableAcct, salesAcct] = await Promise.all([
      findAccountByCode(input.business_id, SYSTEM_ACCOUNT_CODES.RECEIVABLE, {
        db: this.db,
      }),
      findAccountByCode(input.business_id, SYSTEM_ACCOUNT_CODES.SALES_REVENUE, {
        db: this.db,
      }),
    ]);
    if (!receivableAcct || !salesAcct) {
      throw new SalesReturnValidationError(
        'Chart of accounts missing required system accounts (1200/4000) — run "Repair chart of accounts".',
      );
    }
    const [cgstAcct, sgstAcct, igstAcct, cessAcct, roundOffAcct, customerAdvAcct] =
      await Promise.all([
        findAccountByCode(input.business_id, SYSTEM_ACCOUNT_CODES.OUTPUT_CGST, {
          db: this.db,
        }),
        findAccountByCode(input.business_id, SYSTEM_ACCOUNT_CODES.OUTPUT_SGST, {
          db: this.db,
        }),
        findAccountByCode(input.business_id, SYSTEM_ACCOUNT_CODES.OUTPUT_IGST, {
          db: this.db,
        }),
        findAccountByCode(input.business_id, SYSTEM_ACCOUNT_CODES.OUTPUT_CESS, {
          db: this.db,
        }),
        findAccountByCode(input.business_id, SYSTEM_ACCOUNT_CODES.ROUND_OFF, {
          db: this.db,
        }),
        findAccountByCode(
          input.business_id,
          SYSTEM_ACCOUNT_CODES.CUSTOMER_ADVANCE,
          { db: this.db },
        ),
      ]);

    const salesReturnId = ulid();
    const journalEntryId = ulid();
    const now = new Date().toISOString();

    // -------- the atomic tx ------------------------------------------------
    return await this.db.transaction(
      'rw',
      [
        this.db.businesses,
        this.db.invoices,
        this.db.invoice_lines,
        this.db.sales_returns,
        this.db.sales_return_items,
        this.db.invoice_line_return_summary,
        this.db.advances,
        this.db.stock_movements,
        this.db.item_stock,
        this.db.items,
        this.db.journal_entries,
        this.db.journal_lines,
        this.db.sync_events,
      ],
      async () => {
        // Idempotency: if this key already produced a sales_return, return it.
        if (input.idempotency_key) {
          const priorEvt = await this.db.sync_events
            .where('[business_id+entity_type+entity_id]')
            .between(
              [input.business_id, 'sales_return', ''],
              [input.business_id, 'sales_return', '￿'],
            )
            .filter((e) => {
              const p = e.payload as { idempotency_key?: string } | null;
              return p?.idempotency_key === input.idempotency_key;
            })
            .first();
          if (priorEvt) {
            const existing = await this.db.sales_returns.get(
              (priorEvt.payload as { id: string }).id,
            );
            if (existing) {
              log.info(
                'salesReturn',
                'createSalesReturn short-circuited by idempotency key',
                {
                  idempotencyKey: input.idempotency_key,
                  existingReturnId: existing.id,
                  existingNumber: existing.return_number,
                },
              );
              return existing;
            }
          }
        }

        const inv = await this.db.invoices.get(input.original_invoice_id);
        if (!inv) {
          throw new SalesReturnValidationError('invoice disappeared mid-tx');
        }

        // Fetch ORIGINAL lines (current invoice_lines rows). The available-
        // to-return check is against these, because an edited invoice's
        // current lines are the surviving source of truth. Legacy CN rows
        // are excluded because they belong to a different invoice_id.
        const originalLines = await this.db.invoice_lines
          .where('invoice_id')
          .equals(input.original_invoice_id)
          .toArray();
        const lineById = new Map<string, InvoiceLine>();
        for (const l of originalLines) lineById.set(l.id, l);

        // Sum ALREADY-returned qty per line from active sales_return_items
        // (posted, non-deleted parent). Authoritative — do NOT trust the
        // cache here; a mismatched cache from an interrupted rebuild would
        // silently over-return.
        const activeReturnIds = new Set<string>();
        const existingReturns = await this.db.sales_returns
          .where('[business_id+original_invoice_id]')
          .equals([input.business_id, input.original_invoice_id])
          .toArray();
        for (const r of existingReturns) {
          if (r.status === 'posted' && !r.deleted_at) activeReturnIds.add(r.id);
        }
        const priorItems = await this.db.sales_return_items
          .where('original_invoice_id')
          .equals(input.original_invoice_id)
          .toArray();
        const priorReturnedByLine = new Map<string, number>();
        for (const it of priorItems) {
          if (!activeReturnIds.has(it.sales_return_id)) continue;
          priorReturnedByLine.set(
            it.original_invoice_line_id,
            (priorReturnedByLine.get(it.original_invoice_line_id) ?? 0) +
              it.qty_micros,
          );
        }

        // Validate every requested line + build the frozen SalesReturnItem
        // rows from the original invoice line's economics, pro-rated.
        const items: SalesReturnItem[] = [];
        let subtotalPaise = 0;
        let discountPaise = 0;
        let taxablePaise = 0;
        let cgstPaise = 0;
        let sgstPaise = 0;
        let igstPaise = 0;
        let cessPaise = 0;
        let lineNo = 1;
        for (const req of input.lines) {
          const orig = lineById.get(req.original_invoice_line_id);
          if (!orig) {
            throw new SalesReturnValidationError(
              `invoice line ${req.original_invoice_line_id} does not belong to invoice ${input.original_invoice_id}`,
            );
          }
          if (orig.qty_micros <= 0) {
            throw new SalesReturnValidationError(
              `invoice line ${orig.id} has non-positive quantity — cannot return`,
            );
          }
          const alreadyReturned =
            priorReturnedByLine.get(orig.id) ?? 0;
          const available = orig.qty_micros - alreadyReturned;
          if (req.qty_micros > available) {
            log.warn(
              'salesReturn',
              'createSalesReturn rejected: line exceeds available',
              {
                originalInvoiceId: input.original_invoice_id,
                lineId: orig.id,
                requested: req.qty_micros,
                available,
                originalQty: orig.qty_micros,
                alreadyReturned,
              },
            );
            throw new SalesReturnValidationError(
              `line ${orig.id}: requested ${req.qty_micros} exceeds available ${available} (original ${orig.qty_micros} − already returned ${alreadyReturned})`,
            );
          }
          log.debug('salesReturn', 'line accepted', {
            lineId: orig.id,
            requested: req.qty_micros,
            available,
            fractionOfOriginal:
              req.qty_micros / orig.qty_micros,
          });

          // Pro-rate the ORIGINAL line's paise fields by the fraction of
          // qty being returned. Use round-half-even at each step so the
          // pieces sum stably; imprecision goes to round_off.
          const frac = req.qty_micros / orig.qty_micros;
          const proDiscount = bankersRound(orig.discount_paise * frac);
          const proTaxable = bankersRound(orig.taxable_paise * frac);
          const proCgst = bankersRound(orig.cgst_paise * frac);
          const proSgst = bankersRound(orig.sgst_paise * frac);
          const proIgst = bankersRound(orig.igst_paise * frac);
          const proCess = bankersRound(orig.cess_paise * frac);
          const proLineTotal = proTaxable + proCgst + proSgst + proIgst + proCess;
          const proSubtotal = bankersRound(
            (orig.unit_price_paise * req.qty_micros) / 1_000_000,
          );

          items.push({
            id: ulid(),
            business_id: input.business_id,
            sales_return_id: salesReturnId,
            original_invoice_id: input.original_invoice_id,
            original_invoice_line_id: orig.id,
            item_id: orig.item_id,
            description: orig.description,
            hsn: orig.hsn,
            warehouse_id: orig.warehouse_id,
            line_no: lineNo++,
            qty_micros: req.qty_micros,
            unit_price_paise: orig.unit_price_paise,
            discount_pct_bps: orig.discount_pct_bps,
            discount_paise: proDiscount,
            taxable_paise: proTaxable,
            tax_rate_bps: orig.tax_rate_bps,
            cgst_paise: proCgst,
            sgst_paise: proSgst,
            igst_paise: proIgst,
            cess_paise: proCess,
            line_total_paise: proLineTotal,
          });

          subtotalPaise += proSubtotal;
          discountPaise += proDiscount;
          taxablePaise += proTaxable;
          cgstPaise += proCgst;
          sgstPaise += proSgst;
          igstPaise += proIgst;
          cessPaise += proCess;
        }
        const grossLines = taxablePaise + cgstPaise + sgstPaise + igstPaise + cessPaise;
        const totalPaise = grossLines;
        const roundOffPaise = 0;

        if (totalPaise <= 0) {
          throw new SalesReturnValidationError(
            'computed return total is non-positive — cannot post',
          );
        }

        // Allocate the SR number (bumps businesses.sales_return_next_seq).
        const returnNumber = await allocateSalesReturnNumber(
          this.db,
          input.business_id,
        );
        log.info('salesReturn', 'allocated SR number', {
          returnNumber,
          businessId: input.business_id,
          originalInvoiceId: input.original_invoice_id,
        });

        // Decide the settlement side: how much reduces outstanding balance
        // vs. becomes a customer credit (advance).
        const currentBalance = Math.max(0, inv.balance_paise);
        const applyToBalance = Math.min(totalPaise, currentBalance);
        const customerCreditAmount = totalPaise - applyToBalance;
        log.info('salesReturn', 'computed settlement split', {
          returnNumber,
          returnTotalPaise: totalPaise,
          invoiceBalancePaise: inv.balance_paise,
          invoicePaidPaise: inv.paid_paise,
          applyToBalance,
          customerCreditAmount,
          totals: {
            subtotalPaise,
            discountPaise,
            taxablePaise,
            cgstPaise,
            sgstPaise,
            igstPaise,
            cessPaise,
          },
        });

        // Sales Return header.
        const sr: SalesReturn = {
          id: salesReturnId,
          business_id: input.business_id,
          return_number: returnNumber,
          return_date: input.return_date,
          original_invoice_id: input.original_invoice_id,
          customer_id: inv.customer_id,
          subtotal_paise: subtotalPaise,
          discount_paise: discountPaise,
          taxable_paise: taxablePaise,
          cgst_paise: cgstPaise,
          sgst_paise: sgstPaise,
          igst_paise: igstPaise,
          cess_paise: cessPaise,
          round_off_paise: roundOffPaise,
          total_paise: totalPaise,
          status: 'posted',
          reason: input.reason.trim(),
          notes: input.notes ?? '',
          journal_entry_id: journalEntryId,
          reversed_credit_note_invoice_id: null,
          legacy_migration_classification: null,
          device_id: input.device_id,
          created_at: now,
          updated_at: now,
          entity_version: 1,
        };

        await this.db.sales_returns.add(sr);
        if (items.length > 0) await this.db.sales_return_items.bulkAdd(items);
        log.info('salesReturn', 'header + items written', {
          salesReturnId,
          returnNumber,
          itemCount: items.length,
        });

        // Stock movements: goods back into inventory. Written per unique
        // (item_id, warehouse_id) — but we keep one movement per return line
        // for full audit fidelity (line-level movements match line-level
        // history in reports).
        const movements: StockMovement[] = items.map((it) => ({
          id: ulid(),
          business_id: input.business_id,
          item_id: it.item_id,
          warehouse_id: it.warehouse_id,
          movement_type: 'sale_return',
          qty_micros: it.qty_micros,
          unit_cost_paise: it.unit_price_paise,
          ref_type: 'reversal',
          ref_id: salesReturnId,
          occurred_at: now,
          notes: `Sales return ${returnNumber} line ${it.line_no}`,
        }));
        for (const mv of movements) {
          await this.db.stock_movements.add(mv);
          const item = await this.db.items.get(mv.item_id);
          if (!item || item.track_inventory !== 1) continue;
          const stockKey = `${input.business_id}:${mv.item_id}:${mv.warehouse_id}`;
          const existing = await this.db.item_stock.get(stockKey);
          if (existing) {
            await this.db.item_stock.put({
              ...existing,
              qty_micros: existing.qty_micros + mv.qty_micros,
              updated_at: now,
            });
          } else {
            // Fall back to the index lookup — legacy stocks might use ulid()
            // ids rather than composite-string ids.
            const legacy = await this.db.item_stock
              .where('[business_id+item_id+warehouse_id]')
              .equals([input.business_id, mv.item_id, mv.warehouse_id])
              .first();
            if (legacy) {
              await this.db.item_stock.update(legacy.id, {
                qty_micros: legacy.qty_micros + mv.qty_micros,
                updated_at: now,
              });
            } else {
              const row: ItemStock = {
                id: stockKey,
                business_id: input.business_id,
                item_id: mv.item_id,
                warehouse_id: mv.warehouse_id,
                qty_micros: mv.qty_micros,
                avg_cost_paise: mv.unit_cost_paise,
                updated_at: now,
              };
              await this.db.item_stock.add(row);
            }
          }
        }

        // Reduce invoice balance for the portion that offsets outstanding.
        // Do NOT touch total_paise / paid_paise; only balance_paise moves.
        // Status flips back to 'issued' if a fully-paid invoice now has
        // balance > 0 (partial return of a paid invoice → customer owes back).
        // In our accounting we express that as a customer credit (advance)
        // rather than a negative-balance invoice, so this case is handled by
        // customerCreditAmount below; here we only handle the direct-offset
        // path.
        if (applyToBalance > 0) {
          const newBalance = inv.balance_paise - applyToBalance;
          const nextStatus = computeStatusAfterReturn(inv, newBalance);
          log.info('salesReturn', 'reducing invoice balance', {
            invoiceId: inv.id,
            invoiceNumber: inv.invoice_number,
            fromBalance: inv.balance_paise,
            toBalance: newBalance,
            fromStatus: inv.status,
            toStatus: nextStatus,
          });
          await this.db.invoices.update(inv.id, {
            balance_paise: newBalance,
            status: nextStatus,
            updated_at: now,
            entity_version: inv.entity_version + 1,
          });
          // Sync event for the balance change so restore rebuilds correctly.
          await writeEventInTx(this.db, {
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'invoice',
            entity_id: inv.id,
            operation: 'updated',
            entity_version: inv.entity_version + 1,
            timestamp: now,
            payload: {
              id: inv.id,
              balance_paise: newBalance,
              status: nextStatus,
              sales_return_id: salesReturnId,
            },
          });
        }

        // Materialize the customer credit if there's excess. This is a real
        // Advance row so it shows up in party ledgers and can be applied to
        // a future invoice via AdvanceService.applyAdvance.
        let creditAdvanceId: string | null = null;
        if (customerCreditAmount > 0) {
          if (!customerAdvAcct) {
            throw new SalesReturnValidationError(
              'Customer Advances account (2050) missing — cannot post excess return as credit.',
            );
          }
          creditAdvanceId = ulid();
          const advance = {
            id: creditAdvanceId,
            business_id: input.business_id,
            advance_number: `ADV-${returnNumber}`,
            advance_date: input.return_date,
            party_type: 'customer' as const,
            party_id: inv.customer_id,
            method: 'cash' as const,
            account_id: customerAdvAcct.id,
            amount_paise: customerCreditAmount,
            remaining_paise: customerCreditAmount,
            reference: `sales_return:${returnNumber}`,
            notes: `Customer credit from Sales Return ${returnNumber} against invoice ${inv.invoice_number}`,
            applications: [],
            journal_entry_id: journalEntryId,
            created_at: now,
            updated_at: now,
            entity_version: 1,
          };
          await this.db.advances.add(advance);
          await writeEventInTx(this.db, {
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'advance',
            entity_id: creditAdvanceId,
            operation: 'created',
            entity_version: 1,
            timestamp: now,
            payload: advance,
          });
          log.info(
            'salesReturn',
            'created customer credit advance for excess return',
            {
              advanceId: creditAdvanceId,
              advanceNumber: advance.advance_number,
              customerId: inv.customer_id,
              amountPaise: customerCreditAmount,
              againstReturn: returnNumber,
            },
          );
        }

        // Reversing journal entry. Debit Sales Revenue + GST outputs (undo
        // the income and tax liability), Credit AR (for the applied-to-
        // balance portion) and Customer Advances (for the excess-credit
        // portion). This mirrors the original sale JE's shape scaled to the
        // returned portion, so total_debit === total_credit === totalPaise.
        const jeLines: JournalLine[] = [];
        let jlNo = 1;
        jeLines.push({
          id: ulid(),
          business_id: input.business_id,
          entry_id: journalEntryId,
          line_no: jlNo++,
          account_id: salesAcct.id,
          debit_paise: taxablePaise,
          credit_paise: 0,
          party_type: null,
          party_id: null,
          description: 'Sales revenue reversed (return)',
        });
        if (cgstPaise > 0 && cgstAcct) {
          jeLines.push({
            id: ulid(),
            business_id: input.business_id,
            entry_id: journalEntryId,
            line_no: jlNo++,
            account_id: cgstAcct.id,
            debit_paise: cgstPaise,
            credit_paise: 0,
            party_type: null,
            party_id: null,
            description: 'Output CGST reversed',
          });
        }
        if (sgstPaise > 0 && sgstAcct) {
          jeLines.push({
            id: ulid(),
            business_id: input.business_id,
            entry_id: journalEntryId,
            line_no: jlNo++,
            account_id: sgstAcct.id,
            debit_paise: sgstPaise,
            credit_paise: 0,
            party_type: null,
            party_id: null,
            description: 'Output SGST reversed',
          });
        }
        if (igstPaise > 0 && igstAcct) {
          jeLines.push({
            id: ulid(),
            business_id: input.business_id,
            entry_id: journalEntryId,
            line_no: jlNo++,
            account_id: igstAcct.id,
            debit_paise: igstPaise,
            credit_paise: 0,
            party_type: null,
            party_id: null,
            description: 'Output IGST reversed',
          });
        }
        if (cessPaise > 0 && cessAcct) {
          jeLines.push({
            id: ulid(),
            business_id: input.business_id,
            entry_id: journalEntryId,
            line_no: jlNo++,
            account_id: cessAcct.id,
            debit_paise: cessPaise,
            credit_paise: 0,
            party_type: null,
            party_id: null,
            description: 'Output Cess reversed',
          });
        }
        if (applyToBalance > 0) {
          jeLines.push({
            id: ulid(),
            business_id: input.business_id,
            entry_id: journalEntryId,
            line_no: jlNo++,
            account_id: receivableAcct.id,
            debit_paise: 0,
            credit_paise: applyToBalance,
            party_type: 'customer',
            party_id: inv.customer_id,
            description: 'Accounts Receivable reduced (return)',
          });
        }
        if (customerCreditAmount > 0 && customerAdvAcct) {
          jeLines.push({
            id: ulid(),
            business_id: input.business_id,
            entry_id: journalEntryId,
            line_no: jlNo++,
            account_id: customerAdvAcct.id,
            debit_paise: 0,
            credit_paise: customerCreditAmount,
            party_type: 'customer',
            party_id: inv.customer_id,
            description: 'Customer credit issued (return)',
          });
        }
        // Balance the entry with a round-off line if pro-rating fractions
        // introduced a paise-level difference.
        const debits = jeLines.reduce((s, l) => s + l.debit_paise, 0);
        const credits = jeLines.reduce((s, l) => s + l.credit_paise, 0);
        const diff = debits - credits;
        if (diff !== 0) {
          if (!roundOffAcct) {
            throw new SalesReturnValidationError(
              'Round Off account (4900) missing — cannot balance return JE',
            );
          }
          jeLines.push({
            id: ulid(),
            business_id: input.business_id,
            entry_id: journalEntryId,
            line_no: jlNo++,
            account_id: roundOffAcct.id,
            debit_paise: diff < 0 ? -diff : 0,
            credit_paise: diff > 0 ? diff : 0,
            party_type: null,
            party_id: null,
            description: 'Round off (return pro-ration)',
          });
        }

        const finalDebits = jeLines.reduce((s, l) => s + l.debit_paise, 0);
        const finalCredits = jeLines.reduce((s, l) => s + l.credit_paise, 0);
        if (finalDebits !== finalCredits) {
          throw new SalesReturnValidationError(
            `sales-return journal not balanced: debits=${finalDebits} credits=${finalCredits}`,
          );
        }

        const je: JournalEntry = {
          id: journalEntryId,
          business_id: input.business_id,
          entry_number: `JE-SR-${returnNumber}`,
          entry_date: input.return_date,
          narration: `Sales return ${returnNumber} against invoice ${inv.invoice_number}: ${input.reason.trim()}`,
          ref_type: 'reversal',
          ref_id: salesReturnId,
          reversed_by_id: null,
          reverses_id: inv.journal_entry_id,
          total_debit_paise: finalDebits,
          total_credit_paise: finalCredits,
          posted: 1,
          created_at: now,
          updated_at: now,
          entity_version: 1,
        };
        await this.db.journal_entries.add(je);
        await this.db.journal_lines.bulkAdd(jeLines);
        log.info('salesReturn', 'posted reversing journal', {
          salesReturnId,
          journalEntryId: je.id,
          entryNumber: je.entry_number,
          lineCount: jeLines.length,
          totalDebitPaise: finalDebits,
          totalCreditPaise: finalCredits,
        });

        // Refresh the summary cache for this invoice (idempotent).
        await rebuildInvoiceLineReturnSummary(
          this.db,
          input.business_id,
          input.original_invoice_id,
        );

        // Sync events. Header first (carries idempotency_key so retries
        // short-circuit), then items / movements / JE / lines.
        const headerPayload = { ...sr, idempotency_key: input.idempotency_key ?? null };
        await writeEventInTx(this.db, {
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'sales_return',
          entity_id: salesReturnId,
          operation: 'created',
          entity_version: 1,
          timestamp: now,
          payload: headerPayload,
        });
        for (const it of items) {
          await writeEventInTx(this.db, {
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'sales_return_item',
            entity_id: it.id,
            operation: 'created',
            entity_version: 1,
            timestamp: now,
            payload: it,
          });
        }
        for (const mv of movements) {
          await writeEventInTx(this.db, {
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'stock_movement',
            entity_id: mv.id,
            operation: 'created',
            entity_version: 1,
            timestamp: now,
            payload: mv,
          });
        }
        await writeEventInTx(this.db, {
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'journal_entry',
          entity_id: je.id,
          operation: 'posted',
          entity_version: 1,
          timestamp: now,
          payload: je,
        });
        for (const jl of jeLines) {
          await writeEventInTx(this.db, {
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'journal_line',
            entity_id: jl.id,
            operation: 'created',
            entity_version: 1,
            timestamp: now,
            payload: jl,
          });
        }

        log.info('salesReturn', 'createSalesReturn completed', {
          salesReturnId,
          returnNumber,
          originalInvoiceId: input.original_invoice_id,
          originalInvoiceNumber: inv.invoice_number,
          itemCount: items.length,
          totalPaise,
          applyToBalance,
          customerCreditAmount,
          creditAdvanceId,
          journalEntryId,
          jeLineCount: jeLines.length,
          movementCount: movements.length,
        });
        return sr;
      },
    );
  }

  // Cancel a posted Sales Return. Sets status='cancelled' (soft) — the
  // return + its items remain in the DB for audit, but rebuildSummary will
  // ignore them so available_to_return snaps back up. Journal reversal for
  // the cancellation itself is out of scope for PR2 (spec §11 mentions it
  // as a future enhancement); this operation is intended for correcting
  // typos before the customer has been refunded.
  async cancelSalesReturn(
    salesReturnId: string,
    businessId: string,
    reason: string,
  ): Promise<SalesReturn> {
    log.info('salesReturn', 'cancelSalesReturn called', {
      salesReturnId,
      businessId,
      hasReason: !!reason,
    });
    const now = new Date().toISOString();
    return await this.db.transaction(
      'rw',
      [
        this.db.sales_returns,
        this.db.sales_return_items,
        this.db.invoice_line_return_summary,
        this.db.sync_events,
      ],
      async () => {
        const sr = await this.db.sales_returns.get(salesReturnId);
        if (!sr) {
          log.warn('salesReturn', 'cancelSalesReturn rejected: not found', {
            salesReturnId,
          });
          throw new SalesReturnValidationError(
            `sales_return ${salesReturnId} not found`,
          );
        }
        if (sr.business_id !== businessId) {
          log.warn('salesReturn', 'cancelSalesReturn rejected: business mismatch', {
            salesReturnId,
            expected: businessId,
            actual: sr.business_id,
          });
          throw new SalesReturnValidationError('business_id mismatch');
        }
        if (sr.status === 'cancelled') {
          log.info('salesReturn', 'cancelSalesReturn no-op (already cancelled)', {
            salesReturnId,
            returnNumber: sr.return_number,
          });
          return sr;
        }

        const updated: SalesReturn = {
          ...sr,
          status: 'cancelled',
          notes: reason
            ? `${sr.notes}\n[cancelled: ${reason.trim()}]`.trim()
            : sr.notes,
          updated_at: now,
          entity_version: sr.entity_version + 1,
        };
        await this.db.sales_returns.put(updated);
        await rebuildInvoiceLineReturnSummary(
          this.db,
          businessId,
          sr.original_invoice_id,
        );
        await writeEventInTx(this.db, {
          business_id: businessId,
          device_id: sr.device_id || 'system',
          entity_type: 'sales_return',
          entity_id: salesReturnId,
          operation: 'updated',
          entity_version: updated.entity_version,
          timestamp: now,
          payload: {
            id: salesReturnId,
            status: 'cancelled',
            reason,
          },
        });
        log.info('salesReturn', 'cancelSalesReturn completed', {
          salesReturnId,
          returnNumber: sr.return_number,
          originalInvoiceId: sr.original_invoice_id,
          entityVersion: updated.entity_version,
        });
        return updated;
      },
    );
  }
}

// ---------- module-private helpers ----------

function bankersRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // Exactly .5 — round to even.
  return floor % 2 === 0 ? floor : floor + 1;
}

function computeStatusAfterReturn(
  inv: Invoice,
  newBalance: number,
): Invoice['status'] {
  if (inv.status === 'cancelled') return 'cancelled';
  if (newBalance <= 0 && inv.paid_paise >= inv.total_paise) return 'paid';
  if (inv.paid_paise > 0 && newBalance > 0) return 'partial';
  if (newBalance <= 0) return 'paid';
  return inv.status === 'draft' ? 'draft' : 'issued';
}

interface WriteEventInput {
  business_id: string;
  device_id: string;
  entity_type: SyncEvent['entity_type'];
  entity_id: string;
  operation: SyncEvent['operation'];
  entity_version: number;
  timestamp: string;
  payload: unknown;
}

async function writeEventInTx(
  db: BusinessVaultDB,
  input: WriteEventInput,
): Promise<void> {
  const tail = await db.sync_events
    .where('[business_id+timestamp]')
    .between([input.business_id, ''], [input.business_id, '￿'])
    .reverse()
    .first();
  const previousHash = tail ? tail.payload_hash : GENESIS_HASH;
  const payloadHash = await Dexie.waitFor(
    sha256Hex(canonicalJson(input.payload)),
  );
  const evt: SyncEvent = {
    event_id: ulid(),
    business_id: input.business_id,
    device_id: input.device_id,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    operation: input.operation,
    entity_version: input.entity_version,
    timestamp: input.timestamp,
    payload: input.payload,
    payload_hash: payloadHash,
    previous_hash: previousHash,
    sync_status: 'LOCAL_ONLY',
    sync_attempts: 0,
    last_error: null,
    synced_at: null,
    journal_file: null,
  };
  await db.sync_events.add(evt);
}
