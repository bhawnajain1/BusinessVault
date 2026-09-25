import Dexie from 'dexie';
import { ulid } from 'ulid';
import { db as defaultDb, type BusinessVaultDB } from '../db';
import type {
  AuditLogEntry,
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
import { reconcileAfter } from './reconciliation';

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
//     = 'sale_return', ref_type = 'reversal', ref_id = salesReturnId). On
//     cancel we mirror them with qty_micros < 0 rows keyed the same way, so
//     signed SUM(qty_micros) is the invariant — never COUNT.
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
//     JE + JE lines + (if any) the customer-credit advance.
//
//   - PR3 also writes an `audit_log` row per operation (`sales_return.created`
//     / `sales_return.cancelled`). This is the human-readable trail per
//     spec §5 — complement, not replacement, for the sync_event chain.
//     Written in the same tx so audit + domain state commit atomically.

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
    const requestedLineIds = new Set<string>();
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
      if (requestedLineIds.has(l.original_invoice_line_id)) {
        throw new SalesReturnValidationError(
          `invoice line ${l.original_invoice_line_id} appears more than once`,
        );
      }
      requestedLineIds.add(l.original_invoice_line_id);
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

    const [receivableAcct, salesAcct, inventoryAcct, cogsAcct] = await Promise.all([
      findAccountByCode(input.business_id, SYSTEM_ACCOUNT_CODES.RECEIVABLE, {
        db: this.db,
      }),
      findAccountByCode(input.business_id, SYSTEM_ACCOUNT_CODES.SALES_REVENUE, {
        db: this.db,
      }),
      findAccountByCode(input.business_id, SYSTEM_ACCOUNT_CODES.INVENTORY, {
        db: this.db,
      }),
      findAccountByCode(input.business_id, SYSTEM_ACCOUNT_CODES.COGS, {
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
    const created = await this.db.transaction(
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
        this.db.audit_log,
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
        const originalSaleMovements = await this.db.stock_movements
          .where('[business_id+ref_type+ref_id]')
          .equals([input.business_id, 'invoice', input.original_invoice_id])
          .filter((movement) => movement.movement_type === 'sale' && movement.qty_micros < 0)
          .toArray();
        const saleCostByItemWarehouse = new Map<
          string,
          { qty_micros: number; value_micros_paise: number }
        >();
        const postedCogsPaise = cogsAcct
          ? (
              await this.db.journal_lines
                .where('entry_id')
                .equals(inv.journal_entry_id)
                .toArray()
            )
              .filter((line) => line.account_id === cogsAcct.id)
              .reduce(
                (total, line) => total + line.debit_paise - line.credit_paise,
                0,
              )
          : 0;
        for (const movement of originalSaleMovements) {
          const key = `${movement.item_id}:${movement.warehouse_id}`;
          const existing = saleCostByItemWarehouse.get(key) ?? {
            qty_micros: 0,
            value_micros_paise: 0,
          };
          const qtyMicros = Math.abs(movement.qty_micros);
          existing.qty_micros += qtyMicros;
          existing.value_micros_paise += qtyMicros * movement.unit_cost_paise;
          saleCostByItemWarehouse.set(key, existing);
        }
        if (postedCogsPaise > 0) {
          const movementCogsPaise = originalSaleMovements.reduce(
            (total, movement) =>
              total +
              bankersRound(
                (Math.abs(movement.qty_micros) * movement.unit_cost_paise) /
                  1_000_000,
              ),
            0,
          );
          if (postedCogsPaise !== movementCogsPaise) {
            throw new SalesReturnValidationError(
              'original sale cost history is incomplete; repair the invoice inventory ledger before returning goods',
            );
          }
        } else {
          saleCostByItemWarehouse.clear();
        }
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
        const priorCogsByLine = new Map<string, number>();
        for (const it of priorItems) {
          if (!activeReturnIds.has(it.sales_return_id)) continue;
          priorReturnedByLine.set(
            it.original_invoice_line_id,
            (priorReturnedByLine.get(it.original_invoice_line_id) ?? 0) +
              it.qty_micros,
          );
          priorCogsByLine.set(
            it.original_invoice_line_id,
            (priorCogsByLine.get(it.original_invoice_line_id) ?? 0) +
              (it.cogs_paise ?? 0),
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
          const costBasis = saleCostByItemWarehouse.get(
            `${orig.item_id}:${orig.warehouse_id}`,
          );
          let cogsPaise = 0;
          if (costBasis && costBasis.qty_micros > 0) {
            const unitCostPaise = bankersRound(
              costBasis.value_micros_paise / costBasis.qty_micros,
            );
            const originalCogsPaise = bankersRound(
              (orig.qty_micros * unitCostPaise) / 1_000_000,
            );
            const cumulativeReturnedQty = alreadyReturned + req.qty_micros;
            const cumulativeCogsTarget =
              cumulativeReturnedQty === orig.qty_micros
                ? originalCogsPaise
                : bankersRound(
                    (originalCogsPaise * cumulativeReturnedQty) /
                      orig.qty_micros,
                  );
            cogsPaise =
              cumulativeCogsTarget - (priorCogsByLine.get(orig.id) ?? 0);
          } else {
            if (postedCogsPaise > 0) {
              throw new SalesReturnValidationError(
                `original sale cost missing for invoice line ${orig.id}`,
              );
            }
          }

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
            cogs_paise: cogsPaise,
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
          round_off_mode: 'none',
          pre_round_total_paise: grossLines,
          total_paise: totalPaise,
          apply_to_balance_paise: applyToBalance,
          customer_credit_paise: customerCreditAmount,
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
        const movements: StockMovement[] = [];
        let totalCogsReversalPaise = 0;
        for (const it of items) {
          const costBasis = saleCostByItemWarehouse.get(
            `${it.item_id}:${it.warehouse_id}`,
          );
          // The original sale movement records whether this line affected
          // inventory. Do not use the item's current tracking flag: it may
          // have changed since the invoice was issued.
          if (!costBasis || costBasis.qty_micros <= 0) {
            continue;
          }
          const unitCostPaise = bankersRound(
            costBasis.value_micros_paise / costBasis.qty_micros,
          );
          totalCogsReversalPaise += it.cogs_paise ?? 0;
          movements.push({
            id: ulid(),
            business_id: input.business_id,
            item_id: it.item_id,
            warehouse_id: it.warehouse_id,
            movement_type: 'sale_return',
            qty_micros: it.qty_micros,
            unit_cost_paise: unitCostPaise,
            ref_type: 'reversal',
            ref_id: salesReturnId,
            occurred_at: now,
            notes: `Sales return ${returnNumber} line ${it.line_no}`,
          });
        }
        for (const mv of movements) {
          await this.db.stock_movements.add(mv);
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
        // returned portion. The inventory/COGS pair below is independently
        // balanced, so the complete entry remains balanced.
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
        if (totalCogsReversalPaise > 0) {
          if (!inventoryAcct || !cogsAcct) {
            throw new SalesReturnValidationError(
              'Chart of accounts missing required inventory accounts (1400/5020) — run "Repair chart of accounts".',
            );
          }
          jeLines.push({
            id: ulid(),
            business_id: input.business_id,
            entry_id: journalEntryId,
            line_no: jlNo++,
            account_id: inventoryAcct.id,
            debit_paise: totalCogsReversalPaise,
            credit_paise: 0,
            party_type: null,
            party_id: null,
            description: 'Inventory restored (sales return)',
          });
          jeLines.push({
            id: ulid(),
            business_id: input.business_id,
            entry_id: journalEntryId,
            line_no: jlNo++,
            account_id: cogsAcct.id,
            debit_paise: 0,
            credit_paise: totalCogsReversalPaise,
            party_type: null,
            party_id: null,
            description: 'Cost of goods sold reversed',
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

        await writeAuditInTx(this.db, {
          business_id: input.business_id,
          device_id: input.device_id,
          action: 'sales_return.created',
          entity_type: 'sales_return',
          entity_id: salesReturnId,
          before: null,
          after: {
            return_number: returnNumber,
            return_date: input.return_date,
            original_invoice_id: input.original_invoice_id,
            original_invoice_number: inv.invoice_number,
            customer_id: inv.customer_id,
            reason: input.reason.trim(),
            item_count: items.length,
            total_paise: totalPaise,
            apply_to_balance_paise: applyToBalance,
            customer_credit_paise: customerCreditAmount,
            credit_advance_id: creditAdvanceId,
            journal_entry_id: journalEntryId,
          },
          at: now,
        });

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
          cogsReversalPaise: totalCogsReversalPaise,
        });
        return sr;
      },
    );
    // §17: verify TB + receivables after the SR posted (both the journal
    // and the invoice.paid_paise decrement participate). Never throws.
    await reconcileAfter(input.business_id, 'sales_return.create', {
      db: this.db,
    });
    return created;
  }

  // Cancel a posted Sales Return.
  //
  // PR3 (spec §11): a real reversal — not just a status flip. In one tx:
  //   1. Flip status to 'cancelled'.
  //   2. Post an offsetting JE that mirrors the original SR JE with debits
  //      and credits swapped. Link with reverses_id/reversed_by_id.
  //   3. Reverse the stock movements (negative-qty rows referencing the
  //      cancelled SR; item_stock qty decremented back).
  //   4. Restore the invoice balance for whatever portion was applied.
  //   5. If a customer-credit Advance was created and NONE has been applied,
  //      soft-delete it (set remaining=0, deleted_at). If any has been
  //      applied, refuse — user must unapply the advance first.
  //   6. Rebuild invoice_line_return_summary so available_to_return snaps
  //      back up.
  //   7. audit_log row (`sales_return.cancelled`).
  //
  // Idempotent: if status is already 'cancelled', returns the row unchanged.
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

    // Reversal JE is built by copying account_ids from the ORIGINAL journal
    // lines and swapping D/C — we never resolve account codes here.

    const cancelled = await this.db.transaction(
      'rw',
      [
        this.db.sales_returns,
        this.db.sales_return_items,
        this.db.invoice_line_return_summary,
        this.db.invoices,
        this.db.stock_movements,
        this.db.item_stock,
        this.db.items,
        this.db.advances,
        this.db.journal_entries,
        this.db.journal_lines,
        this.db.sync_events,
        this.db.audit_log,
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

        // -------- customer-credit advance safety check ---------------------
        // Find the advance created by this SR (if any). If any of it has
        // been applied to another invoice, refuse — user must unapply first.
        const relatedAdvances = await this.db.advances
          .where('business_id')
          .equals(businessId)
          .filter((a) => a.reference === `sales_return:${sr.return_number}`)
          .toArray();
        let advanceToReverse: (typeof relatedAdvances)[number] | null = null;
        if (relatedAdvances.length > 0) {
          advanceToReverse = relatedAdvances[0];
          const applied =
            advanceToReverse.amount_paise - advanceToReverse.remaining_paise;
          if (applied > 0) {
            log.warn(
              'salesReturn',
              'cancelSalesReturn rejected: credit advance partially applied',
              {
                salesReturnId,
                advanceId: advanceToReverse.id,
                amountPaise: advanceToReverse.amount_paise,
                remainingPaise: advanceToReverse.remaining_paise,
                appliedPaise: applied,
              },
            );
            throw new SalesReturnValidationError(
              `Cannot cancel: customer credit ${advanceToReverse.advance_number} has ₹${(applied / 100).toFixed(2)} already applied to other invoices. Unapply first, then retry cancel.`,
            );
          }
        }

        // -------- fetch what we need to reverse ----------------------------
        const items = await this.db.sales_return_items
          .where('sales_return_id')
          .equals(salesReturnId)
          .toArray();
        const originalMovements = await this.db.stock_movements
          .where('[business_id+ref_type+ref_id]')
          .equals([businessId, 'reversal', salesReturnId])
          .filter(
            (m) => m.movement_type === 'sale_return' && m.qty_micros > 0,
          )
          .toArray();
        const originalJe = await this.db.journal_entries.get(sr.journal_entry_id);
        const originalJlines = originalJe
          ? await this.db.journal_lines.where('entry_id').equals(originalJe.id).toArray()
          : [];

        // -------- 1. flip status -------------------------------------------
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

        // -------- 2. reverse the JE ----------------------------------------
        // Build swapped lines: debit becomes credit and vice versa. Same
        // accounts, same party linkage. Post with reverses_id pointing at
        // the original SR JE.
        let revJeId: string | null = null;
        if (originalJe) {
          revJeId = ulid();
          const revLines: JournalLine[] = originalJlines
            .sort((a, b) => a.line_no - b.line_no)
            .map((l, idx) => ({
              id: ulid(),
              business_id: businessId,
              entry_id: revJeId!,
              line_no: idx + 1,
              account_id: l.account_id,
              debit_paise: l.credit_paise,
              credit_paise: l.debit_paise,
              party_type: l.party_type,
              party_id: l.party_id,
              description: `Cancel: ${l.description}`,
            }));
          const revDebits = revLines.reduce((s, l) => s + l.debit_paise, 0);
          const revCredits = revLines.reduce((s, l) => s + l.credit_paise, 0);
          if (revDebits !== revCredits) {
            throw new SalesReturnValidationError(
              `cancellation journal not balanced: debits=${revDebits} credits=${revCredits}`,
            );
          }
          const revJe: JournalEntry = {
            id: revJeId,
            business_id: businessId,
            entry_number: `JE-SR-${sr.return_number}-CX`,
            entry_date: now.slice(0, 10),
            narration: `Cancel sales return ${sr.return_number}${reason ? `: ${reason.trim()}` : ''}`,
            ref_type: 'reversal',
            ref_id: salesReturnId,
            reversed_by_id: null,
            reverses_id: originalJe.id,
            total_debit_paise: revDebits,
            total_credit_paise: revCredits,
            posted: 1,
            created_at: now,
            updated_at: now,
            entity_version: 1,
          };
          await this.db.journal_entries.add(revJe);
          await this.db.journal_lines.bulkAdd(revLines);
          // Mark the original JE as reversed_by so it's clear from either end.
          await this.db.journal_entries.update(originalJe.id, {
            reversed_by_id: revJeId,
            updated_at: now,
            entity_version: originalJe.entity_version + 1,
          });
          await writeEventInTx(this.db, {
            business_id: businessId,
            device_id: sr.device_id || 'system',
            entity_type: 'journal_entry',
            entity_id: revJe.id,
            operation: 'posted',
            entity_version: 1,
            timestamp: now,
            payload: revJe,
          });
          for (const l of revLines) {
            await writeEventInTx(this.db, {
              business_id: businessId,
              device_id: sr.device_id || 'system',
              entity_type: 'journal_line',
              entity_id: l.id,
              operation: 'created',
              entity_version: 1,
              timestamp: now,
              payload: l,
            });
          }
          log.info('salesReturn', 'posted cancellation reversal JE', {
            salesReturnId,
            reversalJeId: revJeId,
            originalJeId: originalJe.id,
            lineCount: revLines.length,
          });
        }

        // -------- 3. reverse the stock movements ---------------------------
        // Negative-qty sale_return movements referencing the same SR. Item
        // stock decremented back. movement_type stays 'sale_return' with
        // ref_type='reversal' — matches the "return-linked" search shape,
        // and the reverses-cancellation nature is carried by the sign +
        // notes text.
        for (const orig of originalMovements) {
          const revMv: StockMovement = {
            id: ulid(),
            business_id: businessId,
            item_id: orig.item_id,
            warehouse_id: orig.warehouse_id,
            movement_type: 'sale_return',
            qty_micros: -orig.qty_micros,
            unit_cost_paise: orig.unit_cost_paise,
            ref_type: 'reversal',
            ref_id: salesReturnId,
            occurred_at: now,
            notes: `Cancel: ${orig.notes}`,
          };
          await this.db.stock_movements.add(revMv);
          const stockKey = `${businessId}:${orig.item_id}:${orig.warehouse_id}`;
          const existing = await this.db.item_stock.get(stockKey);
          if (existing) {
            await this.db.item_stock.put({
              ...existing,
              qty_micros: existing.qty_micros - orig.qty_micros,
              updated_at: now,
            });
          } else {
            const legacy = await this.db.item_stock
              .where('[business_id+item_id+warehouse_id]')
              .equals([businessId, orig.item_id, orig.warehouse_id])
              .first();
            if (legacy) {
              await this.db.item_stock.update(legacy.id, {
                qty_micros: legacy.qty_micros - orig.qty_micros,
                updated_at: now,
              });
            }
            // If neither stock row exists, we don't create one — the
            // original movement wrote it, and its absence now means
            // someone deleted it externally. Log and continue rather
            // than fabricate.
          }
          await writeEventInTx(this.db, {
            business_id: businessId,
            device_id: sr.device_id || 'system',
            entity_type: 'stock_movement',
            entity_id: revMv.id,
            operation: 'created',
            entity_version: 1,
            timestamp: now,
            payload: revMv,
          });
        }

        // -------- 4. restore invoice balance -------------------------------
        // Split is persisted on the SR header at create time, so we don't
        // depend on the credit-advance record being reachable here. If the
        // header is a pre-existing row without the field (migrated data),
        // fall back to reconstructing from the advance amount.
        const balancePortion =
          sr.apply_to_balance_paise ??
          sr.total_paise - (advanceToReverse ? advanceToReverse.amount_paise : 0);
        if (balancePortion > 0) {
          const inv = await this.db.invoices.get(sr.original_invoice_id);
          if (inv) {
            const newBalance = inv.balance_paise + balancePortion;
            const nextStatus = computeStatusAfterCancel(inv, newBalance);
            log.info('salesReturn', 'restoring invoice balance on cancel', {
              invoiceId: inv.id,
              fromBalance: inv.balance_paise,
              toBalance: newBalance,
              restoredPaise: balancePortion,
              fromStatus: inv.status,
              toStatus: nextStatus,
            });
            await this.db.invoices.update(inv.id, {
              balance_paise: newBalance,
              status: nextStatus,
              updated_at: now,
              entity_version: inv.entity_version + 1,
            });
            await writeEventInTx(this.db, {
              business_id: businessId,
              device_id: sr.device_id || 'system',
              entity_type: 'invoice',
              entity_id: inv.id,
              operation: 'updated',
              entity_version: inv.entity_version + 1,
              timestamp: now,
              payload: {
                id: inv.id,
                balance_paise: newBalance,
                status: nextStatus,
                cancelled_sales_return_id: salesReturnId,
              },
            });
          }
        }

        // -------- 5. reverse the credit advance ----------------------------
        if (advanceToReverse) {
          await this.db.advances.update(advanceToReverse.id, {
            remaining_paise: 0,
            notes: `${advanceToReverse.notes}\n[reversed: sales return ${sr.return_number} cancelled]`.trim(),
            updated_at: now,
            entity_version: advanceToReverse.entity_version + 1,
          });
          await writeEventInTx(this.db, {
            business_id: businessId,
            device_id: sr.device_id || 'system',
            entity_type: 'advance',
            entity_id: advanceToReverse.id,
            operation: 'updated',
            entity_version: advanceToReverse.entity_version + 1,
            timestamp: now,
            payload: {
              id: advanceToReverse.id,
              remaining_paise: 0,
              reversed_by_sales_return_cancel: salesReturnId,
            },
          });
          log.info('salesReturn', 'zeroed credit advance on cancel', {
            salesReturnId,
            advanceId: advanceToReverse.id,
            advanceNumber: advanceToReverse.advance_number,
            amountPaise: advanceToReverse.amount_paise,
          });
        }
        // -------- 6. rebuild summary --------------------------------------
        await rebuildInvoiceLineReturnSummary(
          this.db,
          businessId,
          sr.original_invoice_id,
        );

        // -------- sync event for the SR status change --------------------
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
            reversal_journal_entry_id: revJeId,
          },
        });

        // -------- 7. audit log --------------------------------------------
        await writeAuditInTx(this.db, {
          business_id: businessId,
          device_id: sr.device_id || 'system',
          action: 'sales_return.cancelled',
          entity_type: 'sales_return',
          entity_id: salesReturnId,
          before: {
            status: 'posted',
            return_number: sr.return_number,
            total_paise: sr.total_paise,
          },
          after: {
            status: 'cancelled',
            reason: reason?.trim() ?? '',
            reversal_journal_entry_id: revJeId,
            restored_invoice_balance_paise: balancePortion,
            reversed_credit_advance_id: advanceToReverse?.id ?? null,
            item_count: items.length,
          },
          at: now,
        });

        log.info('salesReturn', 'cancelSalesReturn completed', {
          salesReturnId,
          returnNumber: sr.return_number,
          originalInvoiceId: sr.original_invoice_id,
          entityVersion: updated.entity_version,
          reversalJeId: revJeId,
          balanceRestoredPaise: balancePortion,
          creditAdvanceReversed: !!advanceToReverse,
        });
        return updated;
      },
    );
    // §17: verify TB balances after the reversal JE + invoice-balance
    // restore. Never throws.
    await reconcileAfter(businessId, 'sales_return.cancel', { db: this.db });
    return cancelled;
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

function computeStatusAfterCancel(
  inv: Invoice,
  newBalance: number,
): Invoice['status'] {
  // Balance is going UP (return was reversed). If invoice was 'paid'
  // because return zeroed it, it should now be 'partial' or 'issued'.
  if (inv.status === 'cancelled') return 'cancelled';
  if (inv.status === 'draft') return 'draft';
  if (newBalance <= 0) return 'paid';
  if (inv.paid_paise > 0) return 'partial';
  return 'issued';
}

interface WriteAuditInput {
  business_id: string;
  device_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before: unknown;
  after: unknown;
  at: string;
}

async function writeAuditInTx(
  db: BusinessVaultDB,
  input: WriteAuditInput,
): Promise<void> {
  const entry: AuditLogEntry = {
    id: ulid(),
    business_id: input.business_id,
    device_id: input.device_id,
    actor: input.device_id,
    action: input.action,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    before: input.before,
    after: input.after,
    at: input.at,
  };
  await db.audit_log.add(entry);
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
