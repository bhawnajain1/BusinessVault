import { ulid } from 'ulid';
import { db as defaultDb } from '../db';
import type { BusinessVaultDB } from '../db/database';
import type {
  Account,
  AccountType,
  JournalEntry,
  JournalLine,
  PartyType,
  RefType,
} from '../db/types';
import { emit } from './eventEmitter';
import { normalSideForType } from './coa';

export interface JournalLineInput {
  account_id: string;
  debit_paise: number;
  credit_paise: number;
  party_type?: PartyType | null;
  party_id?: string | null;
  description?: string;
}

export interface PostJournalInput {
  business_id: string;
  date: string;
  narration: string;
  ref_type?: RefType;
  ref_id?: string | null;
  lines: JournalLineInput[];
  entry_number?: string;
  idempotency_key?: string;
}

export interface PostJournalOptions {
  db?: BusinessVaultDB;
  skipEmit?: boolean;
}

export class UnbalancedJournalError extends Error {
  constructor(
    public readonly total_debit_paise: number,
    public readonly total_credit_paise: number,
  ) {
    super(
      `journal not balanced: debits=${total_debit_paise} credits=${total_credit_paise}`,
    );
    this.name = 'UnbalancedJournalError';
  }
}

export async function postJournal(
  input: PostJournalInput,
  opts: PostJournalOptions = {},
): Promise<JournalEntry> {
  if (!input.lines || input.lines.length < 2) {
    throw new Error('journal requires at least 2 lines');
  }
  let totalDr = 0;
  let totalCr = 0;
  for (const l of input.lines) {
    validateAmount(l.debit_paise, 'debit_paise');
    validateAmount(l.credit_paise, 'credit_paise');
    if (l.debit_paise > 0 && l.credit_paise > 0) {
      throw new Error('a single journal line cannot have both debit and credit');
    }
    if (l.debit_paise === 0 && l.credit_paise === 0) {
      throw new Error('a journal line must have a non-zero debit or credit');
    }
    totalDr += l.debit_paise;
    totalCr += l.credit_paise;
  }
  if (totalDr !== totalCr) {
    throw new UnbalancedJournalError(totalDr, totalCr);
  }

  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const now = new Date().toISOString();
  const entryId = ulid();

  const entry: JournalEntry = {
    id: entryId,
    business_id: input.business_id,
    entry_number: input.entry_number ?? entryId,
    entry_date: input.date,
    narration: input.narration,
    ref_type: input.ref_type ?? 'manual',
    ref_id: input.ref_id ?? null,
    reversed_by_id: null,
    reverses_id: null,
    total_debit_paise: totalDr,
    total_credit_paise: totalCr,
    posted: 1,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  };

  const lines: JournalLine[] = input.lines.map((l, idx) => ({
    id: ulid(),
    business_id: input.business_id,
    entry_id: entryId,
    line_no: idx + 1,
    account_id: l.account_id,
    debit_paise: l.debit_paise,
    credit_paise: l.credit_paise,
    party_type: l.party_type ?? null,
    party_id: l.party_id ?? null,
    description: l.description ?? '',
  }));

  await db.transaction('rw', db.journal_entries, db.journal_lines, async () => {
    await db.journal_entries.add(entry);
    await db.journal_lines.bulkAdd(lines);
  });

  if (!opts.skipEmit) {
    await emit('journal_entry', 'posted', entry.id, entry, {
      businessId: input.business_id,
      idempotencyKey: input.idempotency_key,
    });
    for (const l of lines) {
      await emit('journal_line', 'created', l.id, l, {
        businessId: input.business_id,
      });
    }
  }

  return entry;
}

export async function reverseJournal(
  originalEntryId: string,
  reason: string,
  opts: PostJournalOptions & { date?: string } = {},
): Promise<JournalEntry> {
  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const original = await db.journal_entries.get(originalEntryId);
  if (!original) throw new Error(`journal entry ${originalEntryId} not found`);
  if (original.reversed_by_id) {
    throw new Error(`journal entry ${originalEntryId} already reversed`);
  }

  const originalLines = await db.journal_lines
    .where('[business_id+entry_id]')
    .equals([original.business_id, original.id])
    .toArray();

  const now = new Date().toISOString();
  const reversalDate = opts.date ?? toDateString(new Date());

  const mirrored: JournalLineInput[] = originalLines
    .sort((a, b) => a.line_no - b.line_no)
    .map((l) => ({
      account_id: l.account_id,
      debit_paise: l.credit_paise,
      credit_paise: l.debit_paise,
      party_type: l.party_type,
      party_id: l.party_id,
      description: l.description,
    }));

  const reversal = await postJournal(
    {
      business_id: original.business_id,
      date: reversalDate,
      narration: `Reversal of ${original.entry_number}: ${reason}`,
      ref_type: 'reversal',
      ref_id: original.id,
      lines: mirrored,
    },
    { db, skipEmit: opts.skipEmit },
  );

  reversal.reverses_id = original.id;
  original.reversed_by_id = reversal.id;
  original.updated_at = now;
  await db.transaction('rw', db.journal_entries, async () => {
    await db.journal_entries.put(reversal);
    await db.journal_entries.put(original);
  });

  return reversal;
}

export interface TrialBalanceRow {
  account_id: string;
  code: string;
  name: string;
  type: AccountType;
  debits_paise: number;
  credits_paise: number;
  balance_paise: number;
}

export async function trialBalance(
  businessId: string,
  asOf: Date,
  opts: { db?: BusinessVaultDB } = {},
): Promise<TrialBalanceRow[]> {
  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const asOfStr = toDateString(asOf);

  const accounts = await db.accounts
    .where('business_id')
    .equals(businessId)
    .toArray();
  const accountsById = new Map<string, Account>(accounts.map((a) => [a.id, a]));

  const entries = await db.journal_entries
    .where('[business_id+entry_date]')
    .between([businessId, ''], [businessId, asOfStr], true, true)
    .toArray();
  const postedIds = new Set(
    entries.filter((e) => e.posted === 1).map((e) => e.id),
  );

  const totals = new Map<string, { dr: number; cr: number }>();
  for (const acct of accounts) {
    const opening = acct.opening_balance_paise;
    const side = normalSideForType(acct.type);
    if (side === 'debit') {
      totals.set(acct.id, { dr: Math.max(opening, 0), cr: Math.max(-opening, 0) });
    } else {
      totals.set(acct.id, { dr: Math.max(-opening, 0), cr: Math.max(opening, 0) });
    }
  }

  const lines = await db.journal_lines
    .where('business_id')
    .equals(businessId)
    .toArray();
  for (const l of lines) {
    if (!postedIds.has(l.entry_id)) continue;
    const t = totals.get(l.account_id);
    if (!t) continue;
    t.dr += l.debit_paise;
    t.cr += l.credit_paise;
  }

  const rows: TrialBalanceRow[] = [];
  for (const [id, t] of totals.entries()) {
    const acct = accountsById.get(id);
    if (!acct) continue;
    const side = normalSideForType(acct.type);
    const balance = side === 'debit' ? t.dr - t.cr : t.cr - t.dr;
    rows.push({
      account_id: id,
      code: acct.code,
      name: acct.name,
      type: acct.type,
      debits_paise: t.dr,
      credits_paise: t.cr,
      balance_paise: balance,
    });
  }
  rows.sort((a, b) => a.code.localeCompare(b.code));
  return rows;
}

export interface ProfitAndLoss {
  from: string;
  to: string;
  revenue_paise: number;
  cogs_paise: number;
  gross_profit_paise: number;
  operating_expenses_paise: number;
  other_income_paise: number;
  net_income_paise: number;
  by_account: Array<{
    account_id: string;
    code: string;
    name: string;
    type: AccountType;
    amount_paise: number;
  }>;
}

export async function profitAndLoss(
  businessId: string,
  from: Date,
  to: Date,
  opts: { db?: BusinessVaultDB } = {},
): Promise<ProfitAndLoss> {
  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const fromStr = toDateString(from);
  const toStr = toDateString(to);

  const accounts = await db.accounts.where('business_id').equals(businessId).toArray();
  const accountsById = new Map<string, Account>(accounts.map((a) => [a.id, a]));

  const entries = await db.journal_entries
    .where('[business_id+entry_date]')
    .between([businessId, fromStr], [businessId, toStr], true, true)
    .toArray();
  const postedIds = new Set(entries.filter((e) => e.posted === 1).map((e) => e.id));

  const totals = new Map<string, { dr: number; cr: number }>();
  for (const acct of accounts) totals.set(acct.id, { dr: 0, cr: 0 });

  const lines = await db.journal_lines
    .where('business_id')
    .equals(businessId)
    .toArray();
  for (const l of lines) {
    if (!postedIds.has(l.entry_id)) continue;
    const t = totals.get(l.account_id);
    if (!t) continue;
    t.dr += l.debit_paise;
    t.cr += l.credit_paise;
  }

  let revenue = 0;
  let cogs = 0;
  let opex = 0;
  let otherIncome = 0;
  const byAccount: ProfitAndLoss['by_account'] = [];

  for (const [id, t] of totals.entries()) {
    const acct = accountsById.get(id);
    if (!acct) continue;
    if (acct.type !== 'income' && acct.type !== 'expense') continue;
    const amt = acct.type === 'income' ? t.cr - t.dr : t.dr - t.cr;
    if (amt === 0) continue;
    byAccount.push({
      account_id: id,
      code: acct.code,
      name: acct.name,
      type: acct.type,
      amount_paise: amt,
    });
    if (acct.type === 'income') {
      if (acct.subtype === 'operating_income') revenue += amt;
      else otherIncome += amt;
    } else {
      if (acct.subtype === 'cogs') cogs += amt;
      else opex += amt;
    }
  }

  byAccount.sort((a, b) => a.code.localeCompare(b.code));
  const grossProfit = revenue - cogs;
  const netIncome = grossProfit + otherIncome - opex;

  return {
    from: fromStr,
    to: toStr,
    revenue_paise: revenue,
    cogs_paise: cogs,
    gross_profit_paise: grossProfit,
    operating_expenses_paise: opex,
    other_income_paise: otherIncome,
    net_income_paise: netIncome,
    by_account: byAccount,
  };
}

export interface BalanceSheetSection {
  total_paise: number;
  by_account: Array<{
    account_id: string;
    code: string;
    name: string;
    balance_paise: number;
  }>;
}

export interface BalanceSheet {
  as_of: string;
  assets: BalanceSheetSection;
  liabilities: BalanceSheetSection;
  equity: BalanceSheetSection;
  retained_earnings_paise: number;
  balanced: boolean;
  difference_paise: number;
}

export async function balanceSheet(
  businessId: string,
  asOf: Date,
  opts: { db?: BusinessVaultDB; financialYearStart?: Date } = {},
): Promise<BalanceSheet> {
  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const tb = await trialBalance(businessId, asOf, { db });

  const fyStart =
    opts.financialYearStart ??
    new Date(Date.UTC(asOf.getUTCFullYear(), 0, 1));
  const pl = await profitAndLoss(businessId, fyStart, asOf, { db });

  const assets: BalanceSheetSection = { total_paise: 0, by_account: [] };
  const liabilities: BalanceSheetSection = { total_paise: 0, by_account: [] };
  const equity: BalanceSheetSection = { total_paise: 0, by_account: [] };

  for (const row of tb) {
    if (row.type === 'asset') {
      assets.total_paise += row.balance_paise;
      assets.by_account.push({
        account_id: row.account_id,
        code: row.code,
        name: row.name,
        balance_paise: row.balance_paise,
      });
    } else if (row.type === 'liability') {
      liabilities.total_paise += row.balance_paise;
      liabilities.by_account.push({
        account_id: row.account_id,
        code: row.code,
        name: row.name,
        balance_paise: row.balance_paise,
      });
    } else if (row.type === 'equity') {
      equity.total_paise += row.balance_paise;
      equity.by_account.push({
        account_id: row.account_id,
        code: row.code,
        name: row.name,
        balance_paise: row.balance_paise,
      });
    }
  }

  const retained = pl.net_income_paise;
  equity.total_paise += retained;
  equity.by_account.push({
    account_id: '__current_period__',
    code: '3020.CY',
    name: 'Current Period Net Income',
    balance_paise: retained,
  });

  const diff = assets.total_paise - (liabilities.total_paise + equity.total_paise);

  return {
    as_of: toDateString(asOf),
    assets,
    liabilities,
    equity,
    retained_earnings_paise: retained,
    balanced: diff === 0,
    difference_paise: diff,
  };
}

export interface AccountingSelfCheck {
  debitsEqCredits: boolean;
  totalDebits: number;
  totalCredits: number;
  unbalancedEntries: string[];
}

export async function accountingSelfCheck(
  businessId: string,
  opts: { db?: BusinessVaultDB } = {},
): Promise<AccountingSelfCheck> {
  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const entries = await db.journal_entries
    .where('business_id')
    .equals(businessId)
    .toArray();
  const lines = await db.journal_lines
    .where('business_id')
    .equals(businessId)
    .toArray();

  const perEntry = new Map<string, { dr: number; cr: number }>();
  for (const l of lines) {
    const t = perEntry.get(l.entry_id) ?? { dr: 0, cr: 0 };
    t.dr += l.debit_paise;
    t.cr += l.credit_paise;
    perEntry.set(l.entry_id, t);
  }

  const unbalanced: string[] = [];
  let totalDr = 0;
  let totalCr = 0;
  for (const entry of entries) {
    if (entry.posted !== 1) continue;
    const t = perEntry.get(entry.id) ?? { dr: 0, cr: 0 };
    totalDr += t.dr;
    totalCr += t.cr;
    if (t.dr !== t.cr) unbalanced.push(entry.id);
    if (t.dr !== entry.total_debit_paise || t.cr !== entry.total_credit_paise) {
      if (!unbalanced.includes(entry.id)) unbalanced.push(entry.id);
    }
  }

  return {
    debitsEqCredits: totalDr === totalCr,
    totalDebits: totalDr,
    totalCredits: totalCr,
    unbalancedEntries: unbalanced,
  };
}

function validateAmount(n: number, field: string): void {
  if (!Number.isInteger(n)) throw new Error(`${field} must be integer paise`);
  if (n < 0) throw new Error(`${field} must be non-negative`);
}

function toDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
