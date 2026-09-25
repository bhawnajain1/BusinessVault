import { db as defaultDb } from '../db';
import type { BusinessVaultDB } from '../db/database';

export type GstSlab = 0 | 5 | 12 | 18 | 28;
export const GST_SLABS: readonly GstSlab[] = [0, 5, 12, 18, 28] as const;

export interface HsnRateOverride {
  hsn: string;
  rate_bps: number;
  updated_at: string;
}

const SEED_HSN_RATES: Record<string, number> = {
  '0101': 0,
  '1006': 0,
  '2201': 1800,
  '2202': 2800,
  '2402': 2800,
  '3004': 1200,
  '3305': 1800,
  '3401': 1800,
  '4820': 1200,
  '4901': 500,
  '4907': 500,
  '6109': 500,
  '6110': 1200,
  '6403': 1800,
  '7113': 300,
  '7308': 1800,
  '8415': 2800,
  '8471': 1800,
  '8517': 1800,
  '8703': 2800,
  '9401': 1800,
  '9403': 1800,
  '9503': 1200,
  '9613': 1800,
};

const overrides = new Map<string, number>();

export function setHsnRateOverride(hsn: string, rateBps: number): void {
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) {
    throw new Error(`invalid rate_bps ${rateBps}`);
  }
  overrides.set(normalizeHsn(hsn), rateBps);
}

export function clearHsnOverrides(): void {
  overrides.clear();
}

export function hsnRateBps(hsn: string): number {
  const key = normalizeHsn(hsn);
  if (overrides.has(key)) return overrides.get(key) as number;
  const prefix = key.slice(0, 4);
  if (SEED_HSN_RATES[prefix] !== undefined) return SEED_HSN_RATES[prefix];
  return 1800;
}

function normalizeHsn(hsn: string): string {
  return (hsn || '').trim().replace(/\s+/g, '');
}

export function isInterstate(businessStateCode: string, partyStateCode: string): boolean {
  const b = (businessStateCode || '').trim();
  const p = (partyStateCode || '').trim();
  if (!b || !p) return false;
  return b !== p;
}

export interface TaxSplit {
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
}

export function splitTax(
  taxablePaise: number,
  rateBps: number,
  interstate: boolean,
): TaxSplit {
  const totalTax = bankersRound((taxablePaise * rateBps) / 10000);
  if (interstate) {
    return { cgst_paise: 0, sgst_paise: 0, igst_paise: totalTax };
  }
  const half = bankersRound(totalTax / 2);
  const other = totalTax - half;
  return { cgst_paise: half, sgst_paise: other, igst_paise: 0 };
}

export function bankersRound(x: number): number {
  if (!Number.isFinite(x)) throw new Error('bankersRound: non-finite');
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const floor = Math.floor(ax);
  const diff = ax - floor;
  const EPS = 1e-9;
  let rounded: number;
  if (diff < 0.5 - EPS) rounded = floor;
  else if (diff > 0.5 + EPS) rounded = floor + 1;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  const result = sign * rounded;
  return result === 0 ? 0 : result;
}

export function roundOffToNearestRupee(totalPaise: number): {
  final_paise: number;
  round_off_paise: number;
} {
  if (!Number.isFinite(totalPaise)) throw new Error('roundOffToNearestRupee: non-finite');
  const wholeRupees = Math.floor(totalPaise / 100);
  const paise = totalPaise - wholeRupees * 100;
  // Standard half-up rounding: 50 paise or more goes to the next rupee;
  // anything below 50 paise goes down to the current rupee.
  const rounded = (wholeRupees + (paise >= 50 ? 1 : 0)) * 100;
  return {
    final_paise: rounded,
    round_off_paise: rounded - totalPaise,
  };
}

export interface GstSummaryRow {
  slab: GstSlab;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
}

export async function gstSummary(
  businessId: string,
  from: Date,
  to: Date,
  opts: { db?: BusinessVaultDB } = {},
): Promise<GstSummaryRow[]> {
  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const fromStr = toDateString(from);
  const toStr = toDateString(to);

  const invoices = await db.invoices
    .where('[business_id+invoice_date]')
    .between([businessId, fromStr], [businessId, toStr], true, true)
    .toArray();

  const buckets = new Map<GstSlab, GstSummaryRow>();
  for (const slab of GST_SLABS) {
    buckets.set(slab, {
      slab,
      taxable_paise: 0,
      cgst_paise: 0,
      sgst_paise: 0,
      igst_paise: 0,
    });
  }

  for (const inv of invoices) {
    if (inv.status === 'cancelled') continue;
    // §9: recycled invoices must not appear in GST summary. Their journals
    // are reversed by deleteInvoice so TB / P&L / BS already drop them; the
    // GST summary reads invoice line rows directly so it needs an explicit
    // filter here.
    if (inv.deleted_at) continue;
    const lines = await db.invoice_lines
      .where('[business_id+invoice_id]')
      .equals([businessId, inv.id])
      .toArray();
    for (const line of lines) {
      const slab = bpsToSlab(line.tax_rate_bps);
      const row = buckets.get(slab);
      if (!row) continue;
      row.taxable_paise += line.taxable_paise;
      row.cgst_paise += line.cgst_paise;
      row.sgst_paise += line.sgst_paise;
      row.igst_paise += line.igst_paise;
    }
  }

  return Array.from(buckets.values()).sort((a, b) => a.slab - b.slab);
}

function bpsToSlab(bps: number): GstSlab {
  const pct = Math.round(bps / 100);
  if (pct <= 0) return 0;
  if (pct <= 5) return 5;
  if (pct <= 12) return 12;
  if (pct <= 18) return 18;
  return 28;
}

function toDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
