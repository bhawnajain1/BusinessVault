import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ulid } from 'ulid';
import { BusinessVaultDB } from '../src/db/database';
import type {
  Invoice,
  InvoiceLine,
  Business,
} from '../src/db/types';
import {
  seedChartOfAccounts,
  findAccountByCode,
  SYSTEM_ACCOUNT_CODES,
} from '../src/domain/coa';
import {
  postJournal,
  reverseJournal,
  trialBalance,
  profitAndLoss,
  balanceSheet,
  accountingSelfCheck,
  UnbalancedJournalError,
} from '../src/domain/AccountingService';
import {
  splitTax,
  isInterstate,
  hsnRateBps,
  setHsnRateOverride,
  clearHsnOverrides,
  bankersRound,
  roundOffToNearestRupee,
  gstSummary,
} from '../src/domain/gst';

let db: BusinessVaultDB;
const businessId = 'biz_test_1';

async function acctId(code: string): Promise<string> {
  const a = await findAccountByCode(businessId, code, { db });
  if (!a) throw new Error(`account ${code} not found`);
  return a.id;
}

beforeEach(async () => {
  db = new BusinessVaultDB(`bv_test_${ulid()}`);
  await db.open();
  await seedChartOfAccounts(businessId, { db });
});

afterEach(async () => {
  db.close();
  clearHsnOverrides();
});

describe('AccountingService.postJournal', () => {
  it('refuses to post if debits != credits', async () => {
    const cash = await acctId(SYSTEM_ACCOUNT_CODES.CASH);
    const rev = await acctId(SYSTEM_ACCOUNT_CODES.SALES_REVENUE);
    await expect(
      postJournal(
        {
          business_id: businessId,
          date: '2026-01-15',
          narration: 'bad',
          lines: [
            { account_id: cash, debit_paise: 100000, credit_paise: 0 },
            { account_id: rev, debit_paise: 0, credit_paise: 99999 },
          ],
        },
        { db, skipEmit: true },
      ),
    ).rejects.toBeInstanceOf(UnbalancedJournalError);
  });

  it('posts a balanced journal and trial balance sums to zero', async () => {
    const cash = await acctId(SYSTEM_ACCOUNT_CODES.CASH);
    const rev = await acctId(SYSTEM_ACCOUNT_CODES.SALES_REVENUE);
    await postJournal(
      {
        business_id: businessId,
        date: '2026-01-15',
        narration: 'cash sale',
        lines: [
          { account_id: cash, debit_paise: 118000, credit_paise: 0 },
          { account_id: rev, debit_paise: 0, credit_paise: 100000 },
          {
            account_id: await acctId(SYSTEM_ACCOUNT_CODES.OUTPUT_CGST),
            debit_paise: 0,
            credit_paise: 9000,
          },
          {
            account_id: await acctId(SYSTEM_ACCOUNT_CODES.OUTPUT_SGST),
            debit_paise: 0,
            credit_paise: 9000,
          },
        ],
      },
      { db, skipEmit: true },
    );

    const tb = await trialBalance(businessId, new Date('2026-01-31'), { db });
    const sumDr = tb.reduce((s, r) => s + r.debits_paise, 0);
    const sumCr = tb.reduce((s, r) => s + r.credits_paise, 0);
    expect(sumDr).toBe(sumCr);
  });
});

describe('AccountingService.reverseJournal', () => {
  it('creates mirror-sign reversal linked via reverses_id', async () => {
    const cash = await acctId(SYSTEM_ACCOUNT_CODES.CASH);
    const rev = await acctId(SYSTEM_ACCOUNT_CODES.SALES_REVENUE);
    const entry = await postJournal(
      {
        business_id: businessId,
        date: '2026-01-15',
        narration: 'original',
        lines: [
          { account_id: cash, debit_paise: 50000, credit_paise: 0 },
          { account_id: rev, debit_paise: 0, credit_paise: 50000 },
        ],
      },
      { db, skipEmit: true },
    );

    const reversal = await reverseJournal(entry.id, 'wrong amount', {
      db,
      skipEmit: true,
      date: '2026-01-16',
    });

    expect(reversal.reverses_id).toBe(entry.id);
    expect(reversal.total_debit_paise).toBe(50000);
    expect(reversal.total_credit_paise).toBe(50000);

    const original = await db.journal_entries.get(entry.id);
    expect(original?.reversed_by_id).toBe(reversal.id);

    const tb = await trialBalance(businessId, new Date('2026-01-31'), { db });
    for (const r of tb) {
      expect(r.balance_paise).toBe(0);
    }
  });
});

describe('AccountingService P&L and Balance Sheet consistency', () => {
  it('net income flows to retained earnings and BS balances', async () => {
    const cash = await acctId(SYSTEM_ACCOUNT_CODES.CASH);
    const rev = await acctId(SYSTEM_ACCOUNT_CODES.SALES_REVENUE);
    const rent = await acctId('6010');

    await postJournal(
      {
        business_id: businessId,
        date: '2026-02-01',
        narration: 'sale',
        lines: [
          { account_id: cash, debit_paise: 200000, credit_paise: 0 },
          { account_id: rev, debit_paise: 0, credit_paise: 200000 },
        ],
      },
      { db, skipEmit: true },
    );

    await postJournal(
      {
        business_id: businessId,
        date: '2026-02-05',
        narration: 'rent',
        lines: [
          { account_id: rent, debit_paise: 50000, credit_paise: 0 },
          { account_id: cash, debit_paise: 0, credit_paise: 50000 },
        ],
      },
      { db, skipEmit: true },
    );

    const pl = await profitAndLoss(
      businessId,
      new Date('2026-01-01'),
      new Date('2026-12-31'),
      { db },
    );
    expect(pl.revenue_paise).toBe(200000);
    expect(pl.operating_expenses_paise).toBe(50000);
    expect(pl.net_income_paise).toBe(150000);

    const bs = await balanceSheet(businessId, new Date('2026-12-31'), {
      db,
      financialYearStart: new Date('2026-01-01'),
    });
    expect(bs.assets.total_paise).toBe(150000);
    expect(bs.retained_earnings_paise).toBe(150000);
    expect(bs.balanced).toBe(true);
    expect(bs.difference_paise).toBe(0);
  });
});

describe('accountingSelfCheck', () => {
  it('catches an unbalanced entry inserted directly (bypassing postJournal)', async () => {
    const cash = await acctId(SYSTEM_ACCOUNT_CODES.CASH);
    const rev = await acctId(SYSTEM_ACCOUNT_CODES.SALES_REVENUE);

    await postJournal(
      {
        business_id: businessId,
        date: '2026-03-01',
        narration: 'good',
        lines: [
          { account_id: cash, debit_paise: 100000, credit_paise: 0 },
          { account_id: rev, debit_paise: 0, credit_paise: 100000 },
        ],
      },
      { db, skipEmit: true },
    );

    const badEntryId = ulid();
    await db.journal_entries.add({
      id: badEntryId,
      business_id: businessId,
      entry_number: 'BAD-1',
      entry_date: '2026-03-02',
      narration: 'corrupted post-restore',
      ref_type: 'manual',
      ref_id: null,
      reversed_by_id: null,
      reverses_id: null,
      total_debit_paise: 5000,
      total_credit_paise: 5000,
      posted: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      entity_version: 1,
    });
    await db.journal_lines.bulkAdd([
      {
        id: ulid(),
        business_id: businessId,
        entry_id: badEntryId,
        line_no: 1,
        account_id: cash,
        debit_paise: 5000,
        credit_paise: 0,
        party_type: null,
        party_id: null,
        description: '',
      },
      {
        id: ulid(),
        business_id: businessId,
        entry_id: badEntryId,
        line_no: 2,
        account_id: rev,
        debit_paise: 0,
        credit_paise: 4000,
        party_type: null,
        party_id: null,
        description: '',
      },
    ]);

    const check = await accountingSelfCheck(businessId, { db });
    expect(check.debitsEqCredits).toBe(false);
    expect(check.unbalancedEntries).toContain(badEntryId);
  });

  it('returns clean when all entries balance', async () => {
    const cash = await acctId(SYSTEM_ACCOUNT_CODES.CASH);
    const rev = await acctId(SYSTEM_ACCOUNT_CODES.SALES_REVENUE);
    await postJournal(
      {
        business_id: businessId,
        date: '2026-03-01',
        narration: 'good',
        lines: [
          { account_id: cash, debit_paise: 100000, credit_paise: 0 },
          { account_id: rev, debit_paise: 0, credit_paise: 100000 },
        ],
      },
      { db, skipEmit: true },
    );
    const check = await accountingSelfCheck(businessId, { db });
    expect(check.debitsEqCredits).toBe(true);
    expect(check.unbalancedEntries).toHaveLength(0);
  });
});

describe('GST engine', () => {
  it('intra-state splits into CGST + SGST half each', async () => {
    const split = splitTax(100000, 1800, false);
    expect(split.cgst_paise + split.sgst_paise).toBe(18000);
    expect(split.igst_paise).toBe(0);
    expect(split.cgst_paise).toBe(9000);
    expect(split.sgst_paise).toBe(9000);
  });

  it('inter-state posts full IGST', async () => {
    const split = splitTax(100000, 1800, true);
    expect(split.igst_paise).toBe(18000);
    expect(split.cgst_paise).toBe(0);
    expect(split.sgst_paise).toBe(0);
  });

  it('isInterstate compares state codes', () => {
    expect(isInterstate('27', '27')).toBe(false);
    expect(isInterstate('27', '29')).toBe(true);
    expect(isInterstate('', '27')).toBe(false);
  });

  it('HSN lookup uses seed and honors override', () => {
    expect(hsnRateBps('8471')).toBe(1800);
    expect(hsnRateBps('4901')).toBe(500);
    setHsnRateOverride('8471', 500);
    expect(hsnRateBps('8471')).toBe(500);
    expect(hsnRateBps('unknown')).toBe(1800);
  });

  it('bankers rounding rounds half-to-even', () => {
    expect(bankersRound(0.5)).toBe(0);
    expect(bankersRound(1.5)).toBe(2);
    expect(bankersRound(2.5)).toBe(2);
    expect(bankersRound(3.5)).toBe(4);
    expect(bankersRound(-0.5)).toBe(0);
    expect(bankersRound(-1.5)).toBe(-2);
    expect(bankersRound(0.4)).toBe(0);
    expect(bankersRound(0.6)).toBe(1);
  });

  it('round-off uses standard half-up rounding', () => {
    const r = roundOffToNearestRupee(11849);
    expect(r.final_paise).toBe(11800);
    expect(r.round_off_paise).toBe(-49);
    const r2 = roundOffToNearestRupee(11851);
    expect(r2.final_paise).toBe(11900);
    expect(r2.round_off_paise).toBe(49);
  });

  it('gstSummary aggregates per slab (GSTR-1 shape)', async () => {
    const business: Business = {
      id: businessId,
      name: 'Acme',
      legal_name: 'Acme Pvt Ltd',
      gstin: '27AAAAA0000A1Z5',
      pan: null,
      address_line1: '',
      address_line2: '',
      city: '',
      state: 'Maharashtra',
      state_code: '27',
      pincode: '',
      country: 'IN',
      phone: '',
      email: '',
      financial_year_start_month: 4,
      current_financial_year: '2026-27',
      currency: 'INR',
      logo_ref: null,
      invoice_prefix: 'INV',
      invoice_next_seq: 1,
      drive_folder_id: null,
      drive_connected_email: null,
      schema_version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      entity_version: 1,
    };
    await db.businesses.add(business);

    async function addInvoice(
      id: string,
      date: string,
      interstate: boolean,
      lines: Array<{ taxable: number; rateBps: number }>,
    ): Promise<void> {
      let cgst = 0;
      let sgst = 0;
      let igst = 0;
      let taxable = 0;
      const lineRows: InvoiceLine[] = lines.map((l, idx) => {
        const s = splitTax(l.taxable, l.rateBps, interstate);
        cgst += s.cgst_paise;
        sgst += s.sgst_paise;
        igst += s.igst_paise;
        taxable += l.taxable;
        return {
          id: ulid(),
          business_id: businessId,
          invoice_id: id,
          line_no: idx + 1,
          item_id: 'item_x',
          description: '',
          hsn: '8471',
          warehouse_id: 'wh_1',
          qty_micros: 1_000_000,
          unit_price_paise: l.taxable,
          discount_pct_bps: 0,
          discount_paise: 0,
          taxable_paise: l.taxable,
          tax_rate_bps: l.rateBps,
          cgst_paise: s.cgst_paise,
          sgst_paise: s.sgst_paise,
          igst_paise: s.igst_paise,
          cess_paise: 0,
          line_total_paise: l.taxable + s.cgst_paise + s.sgst_paise + s.igst_paise,
        };
      });
      const total = taxable + cgst + sgst + igst;
      const inv: Invoice = {
        id,
        business_id: businessId,
        invoice_number: id,
        invoice_date: date,
        due_date: null,
        customer_id: 'cust_1',
        customer_state_code: interstate ? '29' : '27',
        place_of_supply: interstate ? '29' : '27',
        is_interstate: interstate ? 1 : 0,
        financial_year: '2026-27',
        subtotal_paise: taxable,
        discount_paise: 0,
        taxable_paise: taxable,
        cgst_paise: cgst,
        sgst_paise: sgst,
        igst_paise: igst,
        cess_paise: 0,
        round_off_paise: 0,
        round_off_mode: 'none',
        pre_round_total_paise: total,
        total_paise: total,
        paid_paise: 0,
        balance_paise: total,
        status: 'issued',
        reversed_by_invoice_id: null,
        reverses_invoice_id: null,
        notes: '',
        terms: '',
        pdf_attachment_id: null,
        journal_entry_id: '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        entity_version: 1,
      };
      await db.invoices.add(inv);
      await db.invoice_lines.bulkAdd(lineRows);
    }

    await addInvoice('inv_a', '2026-04-05', false, [
      { taxable: 100000, rateBps: 1800 },
    ]);
    await addInvoice('inv_b', '2026-04-10', true, [
      { taxable: 200000, rateBps: 1800 },
    ]);
    await addInvoice('inv_c', '2026-04-15', false, [
      { taxable: 50000, rateBps: 500 },
    ]);

    const rows = await gstSummary(
      businessId,
      new Date('2026-04-01'),
      new Date('2026-04-30'),
      { db },
    );
    const by = new Map(rows.map((r) => [r.slab, r]));
    expect(by.get(18)?.taxable_paise).toBe(300000);
    expect(by.get(18)?.cgst_paise).toBe(9000);
    expect(by.get(18)?.sgst_paise).toBe(9000);
    expect(by.get(18)?.igst_paise).toBe(36000);
    const slab5 = by.get(5);
    expect(slab5?.taxable_paise).toBe(50000);
    expect((slab5?.cgst_paise ?? 0) + (slab5?.sgst_paise ?? 0)).toBe(2500);
  });
});
