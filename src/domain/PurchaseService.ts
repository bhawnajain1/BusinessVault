import { ulid } from 'ulid';
import type { BusinessVaultDB } from '../db/database';
import type {
  ItemStock,
  JournalEntry,
  JournalLine,
  Purchase,
  PurchaseLine,
  StockMovement,
} from '../db/types';
import { appendSyncEvent } from './syncEventLog';
import { bankersRound } from './gst';

export interface PurchaseServiceDeps {
  db: BusinessVaultDB;
  now?: () => string;
}

export interface PurchaseLineInput {
  itemId: string;
  description?: string;
  hsn?: string;
  warehouseId: string;
  qtyMicros: number;
  unitCostPaise: number;
  discountPaise?: number;
  taxRateBps: number;
  cessRateBps?: number;
  trackInventory?: boolean;
}

export interface CreatePurchaseInput {
  businessId: string;
  deviceId: string;
  billNumber: string;
  supplierBillNumber?: string;
  billDate: string;
  dueDate?: string | null;
  supplierId: string;
  supplierStateCode: string;
  isInterstate: boolean;
  financialYear: string;
  lines: PurchaseLineInput[];
  roundOffPaise?: number;
  notes?: string;
  attachmentId?: string | null;
  accounts: {
    purchases: string;
    inputCgst: string;
    inputSgst: string;
    inputIgst: string;
    inputCess: string;
    accountsPayable: string;
  };
  idempotencyKey?: string;
}

interface ComputedLine {
  line: PurchaseLine;
  movement: StockMovement | null;
}

function bpsMul(base: number, bps: number): number {
  // paise * bps / 10_000 with banker's (round-half-to-even) rounding to match
  // the codebase-wide money convention (see domain/gst.ts). Prior versions used
  // Math.round which rounds half-away-from-zero and produces a systematic bias
  // over long-running ledgers.
  return bankersRound((base * bps) / 10_000);
}

export class PurchaseService {
  private readonly db: BusinessVaultDB;
  private readonly now: () => string;

  constructor(deps: PurchaseServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async create(input: CreatePurchaseInput): Promise<Purchase> {
    if (!input.lines || input.lines.length === 0) {
      throw new Error('Purchase must have at least one line');
    }
    if (!input.billNumber || input.billNumber.trim().length === 0) {
      throw new Error('billNumber is required');
    }

    const now = this.now();
    const purchaseId = ulid();
    const journalId = ulid();

    let subtotal = 0;
    let discount = 0;
    let taxable = 0;
    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    let cess = 0;
    const computed: ComputedLine[] = [];

    input.lines.forEach((li, idx) => {
      if (!Number.isInteger(li.qtyMicros) || li.qtyMicros <= 0) {
        throw new Error(`line[${idx}].qtyMicros must be positive integer`);
      }
      if (!Number.isInteger(li.unitCostPaise) || li.unitCostPaise < 0) {
        throw new Error(`line[${idx}].unitCostPaise must be non-negative integer paise`);
      }
      const lineDiscount = li.discountPaise ?? 0;
      // gross = qty (micros) * unitCost (paise per unit) / 1_000_000
      const gross = bankersRound((li.qtyMicros * li.unitCostPaise) / 1_000_000);
      const lineTaxable = gross - lineDiscount;
      if (lineTaxable < 0) {
        throw new Error(`line[${idx}].discountPaise exceeds line gross`);
      }
      const totalTax = bpsMul(lineTaxable, li.taxRateBps);
      const lineCgst = input.isInterstate ? 0 : bankersRound(totalTax / 2);
      const lineSgst = input.isInterstate ? 0 : totalTax - lineCgst;
      const lineIgst = input.isInterstate ? totalTax : 0;
      const lineCess = li.cessRateBps ? bpsMul(lineTaxable, li.cessRateBps) : 0;
      const lineTotal = lineTaxable + lineCgst + lineSgst + lineIgst + lineCess;

      subtotal += gross;
      discount += lineDiscount;
      taxable += lineTaxable;
      cgst += lineCgst;
      sgst += lineSgst;
      igst += lineIgst;
      cess += lineCess;

      const line: PurchaseLine = {
        id: ulid(),
        business_id: input.businessId,
        purchase_id: purchaseId,
        line_no: idx + 1,
        item_id: li.itemId,
        description: li.description ?? '',
        hsn: li.hsn ?? '',
        warehouse_id: li.warehouseId,
        qty_micros: li.qtyMicros,
        unit_cost_paise: li.unitCostPaise,
        discount_paise: lineDiscount,
        taxable_paise: lineTaxable,
        tax_rate_bps: li.taxRateBps,
        cgst_paise: lineCgst,
        sgst_paise: lineSgst,
        igst_paise: lineIgst,
        cess_paise: lineCess,
        line_total_paise: lineTotal,
      };

      let movement: StockMovement | null = null;
      if (li.trackInventory !== false) {
        movement = {
          id: ulid(),
          business_id: input.businessId,
          item_id: li.itemId,
          warehouse_id: li.warehouseId,
          movement_type: 'purchase',
          qty_micros: li.qtyMicros,
          unit_cost_paise: li.unitCostPaise,
          ref_type: 'purchase',
          ref_id: purchaseId,
          occurred_at: now,
          notes: `Purchase ${input.billNumber} line ${idx + 1}`,
        };
      }
      computed.push({ line, movement });
    });

    const roundOff = input.roundOffPaise ?? 0;
    const total = taxable + cgst + sgst + igst + cess + roundOff;

    const purchase: Purchase = {
      id: purchaseId,
      business_id: input.businessId,
      bill_number: input.billNumber.trim(),
      supplier_bill_number: input.supplierBillNumber ?? '',
      bill_date: input.billDate,
      due_date: input.dueDate ?? null,
      supplier_id: input.supplierId,
      supplier_state_code: input.supplierStateCode,
      is_interstate: input.isInterstate ? 1 : 0,
      financial_year: input.financialYear,
      subtotal_paise: subtotal,
      discount_paise: discount,
      taxable_paise: taxable,
      cgst_paise: cgst,
      sgst_paise: sgst,
      igst_paise: igst,
      cess_paise: cess,
      round_off_paise: roundOff,
      total_paise: total,
      paid_paise: 0,
      balance_paise: total,
      status: 'received',
      notes: input.notes ?? '',
      attachment_id: input.attachmentId ?? null,
      journal_entry_id: journalId,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };

    // Double-entry journal: Dr Purchases + Dr Input GST(s), Cr Accounts Payable.
    const journalLines: JournalLine[] = [];
    let ln = 0;
    if (taxable > 0) {
      journalLines.push({
        id: ulid(),
        business_id: input.businessId,
        entry_id: journalId,
        line_no: ++ln,
        account_id: input.accounts.purchases,
        debit_paise: taxable,
        credit_paise: 0,
        party_type: 'supplier',
        party_id: input.supplierId,
        description: `Purchases from bill ${purchase.bill_number}`,
      });
    }
    if (cgst > 0) {
      journalLines.push({
        id: ulid(),
        business_id: input.businessId,
        entry_id: journalId,
        line_no: ++ln,
        account_id: input.accounts.inputCgst,
        debit_paise: cgst,
        credit_paise: 0,
        party_type: 'supplier',
        party_id: input.supplierId,
        description: 'Input CGST',
      });
    }
    if (sgst > 0) {
      journalLines.push({
        id: ulid(),
        business_id: input.businessId,
        entry_id: journalId,
        line_no: ++ln,
        account_id: input.accounts.inputSgst,
        debit_paise: sgst,
        credit_paise: 0,
        party_type: 'supplier',
        party_id: input.supplierId,
        description: 'Input SGST',
      });
    }
    if (igst > 0) {
      journalLines.push({
        id: ulid(),
        business_id: input.businessId,
        entry_id: journalId,
        line_no: ++ln,
        account_id: input.accounts.inputIgst,
        debit_paise: igst,
        credit_paise: 0,
        party_type: 'supplier',
        party_id: input.supplierId,
        description: 'Input IGST',
      });
    }
    if (cess > 0) {
      journalLines.push({
        id: ulid(),
        business_id: input.businessId,
        entry_id: journalId,
        line_no: ++ln,
        account_id: input.accounts.inputCess,
        debit_paise: cess,
        credit_paise: 0,
        party_type: 'supplier',
        party_id: input.supplierId,
        description: 'Input Cess',
      });
    }
    // Credit side: Accounts Payable for the total (net of round-off applied to debits? No —
    // round-off is a P&L bucket. Keep it simple: the AP credit is `total_paise` and we add
    // a matching round-off debit/credit line if roundOff != 0 to balance.
    journalLines.push({
      id: ulid(),
      business_id: input.businessId,
      entry_id: journalId,
      line_no: ++ln,
      account_id: input.accounts.accountsPayable,
      debit_paise: 0,
      credit_paise: total,
      party_type: 'supplier',
      party_id: input.supplierId,
      description: `Bill ${purchase.bill_number}`,
    });
    if (roundOff !== 0) {
      // roundOff was added to total; to keep debit = credit, add a matching debit
      // (if roundOff > 0) or credit (if roundOff < 0) to the purchases account.
      // Simpler: post the round-off on the purchases account itself.
      if (roundOff > 0) {
        journalLines.push({
          id: ulid(),
          business_id: input.businessId,
          entry_id: journalId,
          line_no: ++ln,
          account_id: input.accounts.purchases,
          debit_paise: roundOff,
          credit_paise: 0,
          party_type: 'supplier',
          party_id: input.supplierId,
          description: 'Round-off',
        });
      } else {
        journalLines.push({
          id: ulid(),
          business_id: input.businessId,
          entry_id: journalId,
          line_no: ++ln,
          account_id: input.accounts.purchases,
          debit_paise: 0,
          credit_paise: -roundOff,
          party_type: 'supplier',
          party_id: input.supplierId,
          description: 'Round-off',
        });
      }
    }

    let totalDebit = 0;
    let totalCredit = 0;
    for (const l of journalLines) {
      totalDebit += l.debit_paise;
      totalCredit += l.credit_paise;
    }
    if (totalDebit !== totalCredit) {
      throw new Error(
        `Purchase journal not balanced: debit=${totalDebit} credit=${totalCredit}`,
      );
    }

    const journal: JournalEntry = {
      id: journalId,
      business_id: input.businessId,
      entry_number: `JE-${purchase.bill_number}`,
      entry_date: purchase.bill_date,
      narration: `Purchase bill ${purchase.bill_number} from supplier ${input.supplierId}`,
      ref_type: 'purchase',
      ref_id: purchaseId,
      reversed_by_id: null,
      reverses_id: null,
      total_debit_paise: totalDebit,
      total_credit_paise: totalCredit,
      posted: 1,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };

    const db = this.db;

    return db.transaction(
      'rw',
      [
        db.purchases,
        db.purchase_lines,
        db.stock_movements,
        db.item_stock,
        db.items,
        db.journal_entries,
        db.journal_lines,
        db.sync_events,
      ],
      async () => {
        // Idempotency check FIRST: retries with the same idempotencyKey return
        // the previously-persisted purchase and skip re-mutation, so a retry
        // does not surface as a "Bill number already exists" error.
        if (input.idempotencyKey) {
          const priorEvents = (await db.sync_events.toArray()) as unknown as Array<
            Record<string, unknown>
          >;
          for (const r of priorEvents) {
            if (
              r['business_id'] === input.businessId &&
              r['entity_type'] === 'purchase' &&
              r['idempotency_key'] === input.idempotencyKey
            ) {
              const existing = await db.purchases.get(String(r['entity_id']));
              if (existing) return existing;
            }
          }
        }

        const dup = await db.purchases
          .where('[business_id+bill_number]')
          .equals([input.businessId, purchase.bill_number])
          .first();
        if (dup) {
          throw new Error(`Bill number already exists: ${purchase.bill_number}`);
        }

        await db.purchases.add(purchase);
        for (const c of computed) {
          await db.purchase_lines.add(c.line);
        }

        for (const c of computed) {
          if (!c.movement) continue;
          await db.stock_movements.add(c.movement);
          const stockKey = `${input.businessId}:${c.movement.item_id}:${c.movement.warehouse_id}`;
          const existing = await db.item_stock.get(stockKey);
          if (existing) {
            // Moving-weighted-average cost: only recompute when the new stock
            // position is positive AND the incoming layer is positive. Negative
            // positions (backorders) are edge cases — preserve the old avg then.
            const oldQty = existing.qty_micros;
            const newQty = oldQty + c.movement.qty_micros;
            let newAvg = existing.avg_cost_paise;
            if (
              c.movement.qty_micros > 0 &&
              newQty > 0 &&
              (oldQty > 0 || existing.avg_cost_paise === 0)
            ) {
              // (oldQty * oldAvg + deltaQty * deltaCost) / newQty
              const totalValue =
                oldQty * existing.avg_cost_paise +
                c.movement.qty_micros * c.movement.unit_cost_paise;
              newAvg = Math.round(totalValue / newQty);
            }
            await db.item_stock.put({
              ...existing,
              qty_micros: newQty,
              avg_cost_paise: newAvg,
              updated_at: now,
            });
          } else {
            const row: ItemStock = {
              id: stockKey,
              business_id: input.businessId,
              item_id: c.movement.item_id,
              warehouse_id: c.movement.warehouse_id,
              qty_micros: c.movement.qty_micros,
              avg_cost_paise: c.movement.unit_cost_paise,
              updated_at: now,
            };
            await db.item_stock.add(row);
          }
        }

        await db.journal_entries.add(journal);
        for (const l of journalLines) await db.journal_lines.add(l);

        await appendSyncEvent(db, {
          businessId: input.businessId,
          deviceId: input.deviceId,
          entityType: 'purchase',
          entityId: purchase.id,
          operation: 'created',
          payload: purchase,
          timestamp: now,
          idempotencyKey: input.idempotencyKey,
        });
        for (const c of computed) {
          await appendSyncEvent(db, {
            businessId: input.businessId,
            deviceId: input.deviceId,
            entityType: 'purchase_line',
            entityId: c.line.id,
            operation: 'created',
            payload: c.line,
            timestamp: now,
          });
          if (c.movement) {
            await appendSyncEvent(db, {
              businessId: input.businessId,
              deviceId: input.deviceId,
              entityType: 'stock_movement',
              entityId: c.movement.id,
              operation: 'movement',
              payload: c.movement,
              timestamp: now,
            });
          }
        }
        await appendSyncEvent(db, {
          businessId: input.businessId,
          deviceId: input.deviceId,
          entityType: 'journal_entry',
          entityId: journal.id,
          operation: 'posted',
          payload: journal,
          timestamp: now,
        });
        for (const l of journalLines) {
          await appendSyncEvent(db, {
            businessId: input.businessId,
            deviceId: input.deviceId,
            entityType: 'journal_line',
            entityId: l.id,
            operation: 'created',
            payload: l,
            timestamp: now,
          });
        }

        return purchase;
      },
    );
  }

  // Internal mechanism used by update() to preserve the append-only journal
  // invariant during an edit: post a reversing JE + reverse stock movements and
  // flip the original's status to 'cancelled' with a renamed bill_number so the
  // number is free for the re-issued row. NOT user-facing — surface is Edit +
  // Delete (see update / delete flows).
  private async reversePurchasePosting(
    purchaseId: string,
    deviceId: string,
    reason: string,
  ): Promise<Purchase> {
    if (!reason || reason.trim().length === 0) {
      throw new Error('reversal reason required');
    }
    const original = await this.db.purchases.get(purchaseId);
    if (!original) throw new Error(`Purchase not found: ${purchaseId}`);
    if (original.status === 'cancelled') {
      throw new Error('Purchase already reversed');
    }

    const now = this.now();
    const reversalJournalId = ulid();

    const originalJournal = await this.db.journal_entries.get(original.journal_entry_id);
    if (!originalJournal) throw new Error('Original purchase journal missing');
    const originalJournalLines = await this.db.journal_lines
      .where('entry_id')
      .equals(original.journal_entry_id)
      .toArray();
    const originalMovements = await this.db.stock_movements
      .where('ref_id')
      .equals(purchaseId)
      .toArray();

    const reversalLines: JournalLine[] = originalJournalLines.map((l, idx) => ({
      id: ulid(),
      business_id: l.business_id,
      entry_id: reversalJournalId,
      line_no: idx + 1,
      account_id: l.account_id,
      debit_paise: l.credit_paise,
      credit_paise: l.debit_paise,
      party_type: l.party_type,
      party_id: l.party_id,
      description: `Reversal: ${l.description}`,
    }));

    const reversalJournal: JournalEntry = {
      id: reversalJournalId,
      business_id: original.business_id,
      entry_number: `JE-REV-${original.bill_number}`,
      entry_date: original.bill_date,
      narration: `Reversal of purchase bill ${original.bill_number}: ${reason}`,
      ref_type: 'reversal',
      ref_id: purchaseId,
      reversed_by_id: null,
      reverses_id: original.journal_entry_id,
      total_debit_paise: originalJournal.total_credit_paise,
      total_credit_paise: originalJournal.total_debit_paise,
      posted: 1,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };

    const db = this.db;
    return db.transaction(
      'rw',
      [
        db.purchases,
        db.stock_movements,
        db.item_stock,
        db.journal_entries,
        db.journal_lines,
        db.sync_events,
      ],
      async () => {
        const reversalMovements: StockMovement[] = [];
        for (const m of originalMovements) {
          const reversalMovement: StockMovement = {
            id: ulid(),
            business_id: m.business_id,
            item_id: m.item_id,
            warehouse_id: m.warehouse_id,
            movement_type: 'adjustment',
            qty_micros: -m.qty_micros,
            unit_cost_paise: m.unit_cost_paise,
            ref_type: 'reversal',
            ref_id: reversalJournalId,
            occurred_at: now,
            notes: `Reversal of purchase ${original.bill_number}`,
          };
          reversalMovements.push(reversalMovement);
          await db.stock_movements.add(reversalMovement);
          const stockKey = `${m.business_id}:${m.item_id}:${m.warehouse_id}`;
          const stock = await db.item_stock.get(stockKey);
          if (stock) {
            await db.item_stock.put({
              ...stock,
              qty_micros: stock.qty_micros - m.qty_micros,
              updated_at: now,
            });
          }
        }

        await db.journal_entries.add(reversalJournal);
        for (const l of reversalLines) await db.journal_lines.add(l);

        // Rename the old bill_number so a re-create can reuse the number.
        // Append -REV-<ulid-suffix> to guarantee uniqueness. Append the reason
        // to notes so the trail is preserved.
        const reversedBillNumber = `${original.bill_number}-REV-${reversalJournalId.slice(-6)}`;
        const reversed: Purchase = {
          ...original,
          bill_number: reversedBillNumber,
          status: 'cancelled',
          notes: `${original.notes ? original.notes + '\n' : ''}[REVERSED ${now}] ${reason}`,
          updated_at: now,
          entity_version: original.entity_version + 1,
        };
        await db.purchases.put(reversed);

        await appendSyncEvent(db, {
          businessId: original.business_id,
          deviceId,
          entityType: 'purchase',
          entityId: purchaseId,
          operation: 'reversed',
          payload: {
            purchase_id: purchaseId,
            reason,
            reversal_journal_id: reversalJournalId,
            renamed_bill_number: reversedBillNumber,
          },
          timestamp: now,
        });
        await appendSyncEvent(db, {
          businessId: original.business_id,
          deviceId,
          entityType: 'journal_entry',
          entityId: reversalJournalId,
          operation: 'posted',
          payload: reversalJournal,
          timestamp: now,
        });
        for (const l of reversalLines) {
          await appendSyncEvent(db, {
            businessId: original.business_id,
            deviceId,
            entityType: 'journal_line',
            entityId: l.id,
            operation: 'created',
            payload: l,
            timestamp: now,
          });
        }
        for (const m of reversalMovements) {
          await appendSyncEvent(db, {
            businessId: original.business_id,
            deviceId,
            entityType: 'stock_movement',
            entityId: m.id,
            operation: 'movement',
            payload: m,
            timestamp: now,
          });
        }

        const updated = await db.purchases.get(purchaseId);
        return updated as Purchase;
      },
    );
  }

  /**
   * Edit an existing purchase. To preserve the append-only journal invariant,
   * the underlying implementation reverses the original's postings (journal +
   * stock) and posts a fresh purchase with the same bill_number. The reversed
   * original row stays cancelled + renamed for audit. Callers see a normal
   * "edit" — the reversal shape is not surfaced.
   */
  async update(
    purchaseId: string,
    input: Omit<CreatePurchaseInput, 'idempotencyKey'>,
  ): Promise<Purchase> {
    const original = await this.db.purchases.get(purchaseId);
    if (!original) throw new Error(`Purchase not found: ${purchaseId}`);
    if (original.status === 'cancelled') {
      throw new Error('Cannot edit a cancelled purchase');
    }
    await this.reversePurchasePosting(purchaseId, input.deviceId, 'edit');
    return this.create(input);
  }

  async get(id: string): Promise<Purchase | undefined> {
    return this.db.purchases.get(id);
  }

  async lines(purchaseId: string): Promise<PurchaseLine[]> {
    return this.db.purchase_lines
      .where('purchase_id')
      .equals(purchaseId)
      .toArray();
  }

  async list(businessId: string): Promise<Purchase[]> {
    return this.db.purchases
      .where('business_id')
      .equals(businessId)
      .toArray();
  }
}

export function createPurchaseService(
  deps: PurchaseServiceDeps,
): PurchaseService {
  return new PurchaseService(deps);
}
