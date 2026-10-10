import type { BusinessVaultDB } from '../database';
import Dexie from 'dexie';
import { TABLE_SPECS, coerceRow } from '../../restore/tableSchema';
import type { GstMonthlySources, GstTaxPeriod } from '../../domain/gstReporting/types';
import type { GstNote, GstNoteLine, Purchase, PurchaseLine } from '../types';

// Reuse purchase evidence checks without changing note identity or persisted money.
export function inwardNoteEvidence(note: GstNote): { header: Purchase; lines: PurchaseLine[] } {
  if (note.direction !== 'INWARD') throw new Error('ITC requires an inward GST note');
  const lines = JSON.parse(note.lines_json) as GstNoteLine[];
  if (!Array.isArray(lines)) throw new Error('Invalid historical note lines');
  return {
    header: { ...note, bill_date: note.note_date, supplier_id: note.party_id, supplier_state_code: note.supplier_state_code ?? '',
      status: 'received', reverses_purchase_id: note.note_type === 'CREDIT_NOTE' ? note.original_source_entity_id ?? null : null } as unknown as Purchase,
    lines: lines.map(line => ({ ...line, business_id: note.business_id, purchase_id: note.id })) as PurchaseLine[],
  };
}

export const GST_SOURCE_TABLES = [
  'businesses', 'invoices', 'invoice_lines', 'purchases', 'purchase_lines',
  'sales_returns', 'sales_return_items', 'customers', 'suppliers', 'gst_profiles',
  'gst_aato', 'gst_document_metadata', 'gst_itc_ledger', 'gst_adjustments',
  'expenses', 'advances', 'legacy_reversal_audit',
  'gst_notes', 'gst_nil_confirmations', 'items', 'units',
] as const;

export const waitForGstTransaction = <T>(promise: Promise<T>): Promise<T> => Dexie.waitFor(promise);

async function queryInBatches<T, K>(keys: K[], load: (batch: K[]) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  const batches: K[][] = [];
  for (let offset = 0; offset < keys.length; offset += 10) batches.push(keys.slice(offset, offset + 10));
  for (let offset = 0; offset < batches.length; offset += 5) rows.push(...(await Promise.all(batches.slice(offset, offset + 5).map(load))).flat());
  return rows;
}

export function normalizeGstSourceRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const spec = TABLE_SPECS.find((value) => value.store === table);
  const normalized = spec ? coerceRow({}, spec) : {};
  for (const [key, value] of Object.entries(row)) if (value !== undefined) normalized[key] = value;
  for (const column of spec?.columns ?? []) {
    if (normalized[column.name] === '' && ['string_or_null', 'number_or_null', 'paise', 'boolean_int_or_null'].includes(column.type)) normalized[column.name] = null;
  }
  if (table === 'gst_document_metadata') {
    // This index is derived, not independent evidence. Older rows and CSV nulls
    // must canonicalize identically to migrated rows with an empty key array.
    let offsets: Array<{ advance_id?: unknown }> = [];
    try { const value = JSON.parse(String(normalized.advance_adjustments_json ?? '[]')); if (Array.isArray(value)) offsets = value; } catch { /* Preserve malformed source JSON. */ }
    normalized.advance_offset_keys = [...new Set(offsets.filter(value => value && typeof value.advance_id === 'string')
      .map(value => `${normalized.business_id}:${value.advance_id}`))].sort();
  }
  return normalized;
}

export class GstReportingRepository {
  constructor(private readonly db: BusinessVaultDB) {}

  async loadWorkspace(businessId?: string, reviewSourceIds: string[] = []) {
    const businesses = await this.db.businesses.toArray();
    const selected = businessId ?? businesses[0]?.id;
    const itcEntries = selected && reviewSourceIds.length ? await this.db.gst_itc_ledger
      .where('[business_id+source_entity_type+source_entity_id]')
      .anyOf(reviewSourceIds.flatMap((id) => [[selected, 'PURCHASE', id], [selected, 'PURCHASE_RETURN', id], [selected, 'GST_NOTE', id]])).toArray() : [];
    for (const entry of itcEntries) if (entry.related_prior_entry_id && !itcEntries.some((row) => row.id === entry.related_prior_entry_id)) {
      const prior = await this.db.gst_itc_ledger.get(entry.related_prior_entry_id);
      if (prior?.business_id === selected) itcEntries.push(prior);
    }
    return {
      businesses,
      itcEntries,
      auditLog: selected ? await this.db.audit_log.where('business_id').equals(selected)
        .filter((row) => row.entity_type.startsWith('gst_') || row.action.startsWith('gst_')).toArray() : [],
      profiles: selected ? await this.db.gst_profiles.where('business_id').equals(selected).toArray() : [],
      aato: selected ? await this.db.gst_aato.where('business_id').equals(selected).toArray() : [],
      savedRuns: selected ? await this.db.gst_report_runs.where('business_id').equals(selected).toArray() : [],
      reviewPurchases: selected ? (await this.db.purchases.bulkGet(reviewSourceIds)).filter((row) => row?.business_id === selected) : [],
      reviewNotes: selected ? (await this.db.gst_notes.bulkGet(reviewSourceIds)).filter(row => row?.business_id === selected && row.direction === 'INWARD') : [],
    };
  }

  // Caller may include this read in the report-save read/write transaction.
  async loadMonth(period: GstTaxPeriod): Promise<GstMonthlySources> {
    const id = period.businessId;
    const throughKey = period.nextPeriodStart.slice(0, 7);
    const business = await this.db.businesses.get(id);
    if (!business) throw new Error('Business not found');
    const notes = await this.db.gst_notes.where('[business_id+note_date]')
      .between([id, period.periodStart], [id, period.nextPeriodStart], true, false).toArray();
    const invoices = await this.db.invoices.where('[business_id+invoice_date]')
      .between([id, period.periodStart], [id, period.nextPeriodStart], true, false).toArray();
    const purchases = await this.db.purchases.where('[business_id+bill_date]')
      .between([id, period.periodStart], [id, period.nextPeriodStart], true, false).toArray();
    const monthReturns = await this.db.sales_returns.where('[business_id+return_date]')
      .between([id, period.periodStart], [id, period.nextPeriodStart], true, false).toArray();
    const metadata = await this.db.gst_document_metadata.where('[business_id+reporting_period_override]')
      .between([id, period.periodStart.slice(0, 7)], [id, period.nextPeriodStart.slice(0, 7)], true, false).toArray();
    const currentItc = [] as GstMonthlySources['itcEntries'];
    for (const field of ['tax_period_key', 'source_period_key', 'reversal_period_key', 'reclaim_period_key']) {
      currentItc.push(...await this.db.gst_itc_ledger.where(`[business_id+${field}]`)
        .between([id, period.periodStart.slice(0, 7)], [id, period.nextPeriodStart.slice(0, 7)], true, false).toArray());
    }
    const effective = (row: GstMonthlySources['itcEntries'][number]) => {
      const dates = row.status === 'RECLAIMED' ? [row.reclaim_period_key ?? row.tax_period_key] :
        ['TEMPORARILY_REVERSED', 'PERMANENTLY_REVERSED'].includes(row.status) ?
          [row.original_eligible_paise ? row.tax_period_key : null, row.reversal_period_key ?? row.tax_period_key] : [row.tax_period_key];
      return dates.filter((date): date is string => !!date).sort()[0] ?? row.tax_period_key;
    };
    const outstanding = await this.db.gst_itc_ledger.where('[business_id+status]').equals([id, 'TEMPORARILY_REVERSED'])
      .filter((row) => effective(row) < throughKey).toArray();
    for (const reversal of outstanding) {
      const reclaims = await this.db.gst_itc_ledger.where('[business_id+related_prior_entry_id]').equals([id, reversal.id])
        .filter((row) => row.status === 'RECLAIMED' && effective(row) < throughKey).toArray();
      const reclaimed = reclaims.reduce((sum, row) => sum + (row.reclaimed_paise ?? 0), 0);
      if (reclaimed < (reversal.temporarily_reversed_paise ?? 0)) currentItc.push(reversal, ...reclaims);
    }
    // Source-linked reviews and prior reversal/reclaim chains are scoped below.
    let itcEntries = [...new Map(currentItc.filter((row) => effective(row) < throughKey).map((row) => [row.id, row])).values()];
    // Current-period reversals/reclaims need only their specifically linked old
    // purchases, not the entire historical purchase register.
    for (const entry of itcEntries) {
      if (entry.source_entity_type === 'GST_NOTE' && !notes.some(row => row.id === entry.source_entity_id)) {
        const row = await this.db.gst_notes.get(entry.source_entity_id);
        if (row?.business_id === id && row.direction === 'INWARD') notes.push(row);
      }
      if (['PURCHASE', 'PURCHASE_RETURN'].includes(entry.source_entity_type) && !purchases.some((row) => row.id === entry.source_entity_id)) {
        const row = await this.db.purchases.get(entry.source_entity_id);
        if (row?.business_id === id) purchases.push(row);
      }
    }
    // Amendments may explicitly belong to this month despite an older book date.
    for (const meta of [...metadata]) {
      if (meta.source_entity_type === 'INVOICE' && !invoices.some((row) => row.id === meta.source_entity_id)) {
        const row = await this.db.invoices.get(meta.source_entity_id);
        if (row?.business_id === id) invoices.push(row);
      }
      if (['PURCHASE', 'PURCHASE_RETURN'].includes(meta.source_entity_type) && !purchases.some((row) => row.id === meta.source_entity_id)) {
        const row = await this.db.purchases.get(meta.source_entity_id);
        if (row?.business_id === id) purchases.push(row);
      }
      if (meta.source_entity_type === 'SALES_RETURN' && !monthReturns.some((row) => row.id === meta.source_entity_id)) {
        const row = await this.db.sales_returns.get(meta.source_entity_id);
        if (row?.business_id === id) monthReturns.push(row);
      }
      if (meta.source_entity_type === 'GST_NOTE' && !notes.some(row => row.id === meta.source_entity_id)) {
        const row = await this.db.gst_notes.get(meta.source_entity_id);
        if (row?.business_id === id) notes.push(row);
      }
    }
    for (const purchase of [...purchases]) if (purchase.reverses_purchase_id && !purchases.some((row) => row.id === purchase.reverses_purchase_id)) {
      const original = await this.db.purchases.get(purchase.reverses_purchase_id);
      if (original?.business_id === id) purchases.push(original);
    }
    for (const note of notes) if (note.direction === 'INWARD' && note.original_source_entity_id) {
      if (note.original_source_entity_type === 'GST_NOTE') {
        const row = await this.db.gst_notes.get(note.original_source_entity_id);
        if (row?.business_id === id && !notes.some(value => value.id === row.id)) notes.push(row);
      } else if (note.original_source_entity_type === 'PURCHASE') {
        const row = await this.db.purchases.get(note.original_source_entity_id);
        if (row?.business_id === id && !purchases.some(value => value.id === row.id)) purchases.push(row);
      }
    }
    const linkedKeys: string[][] = [...purchases.map(row => [id, 'PURCHASE', row.id]), ...notes.filter(row => row.direction === 'INWARD').map(row => [id, 'GST_NOTE', row.id])];
    if (linkedKeys.length) {
      const linked = await queryInBatches(linkedKeys, batch => this.db.gst_notes.where('[business_id+original_source_entity_type+original_source_entity_id]').anyOf(batch)
        .filter(row => row.direction === 'INWARD' && row.note_type === 'CREDIT_NOTE' && row.note_date < period.nextPeriodStart).toArray());
      for (const row of linked) if (!notes.some(value => value.id === row.id)) notes.push(row);
    }
    // Old reclaims need prior native returns as entitlement evidence, not current-month tax.
    const purchaseOriginalIds = purchases.filter((row) => !row.reverses_purchase_id).map((row) => row.id);
    if (purchaseOriginalIds.length) {
      const notes = await this.db.purchases.where('[business_id+reverses_purchase_id]')
        .anyOf(purchaseOriginalIds.map((sourceId) => [id, sourceId]))
        .filter((row) => row.bill_date < period.nextPeriodStart).toArray();
      for (const note of notes) if (!purchases.some((row) => row.id === note.id)) purchases.push(note);
    }
    const originalIds = [...new Set(monthReturns.map((row) => row.original_invoice_id))];
    const originalInvoices = (await this.db.invoices.bulkGet(originalIds)).filter((row) => row?.business_id === id);
    // All linked returns are evidence for full-return cancellation, not month tax.
    const evidenceIds = [...new Set([...originalIds, ...invoices.filter((row) => row.status === 'cancelled').map((row) => row.id)])];
    const evidence = evidenceIds.length ? await this.db.sales_returns.where('[business_id+original_invoice_id]')
      .anyOf(evidenceIds.map((invoiceId) => [id, invoiceId])).toArray() : [];
    const salesReturns = [...new Map([...monthReturns, ...evidence].map((row) => [row.id, row])).values()];
    const invoiceIds = [...new Set([...invoices, ...originalInvoices].map((row) => row!.id))];
    const [invoiceLines, purchaseLines, salesReturnItems] = await Promise.all([
      invoiceIds.length ? queryInBatches(invoiceIds, batch => this.db.invoice_lines.where('invoice_id').anyOf(batch).toArray()) : [],
      purchases.length ? queryInBatches(purchases.map((row) => row.id), batch => this.db.purchase_lines.where('purchase_id').anyOf(batch).toArray()) : [],
      salesReturns.length ? queryInBatches(salesReturns.map((row) => row.id), batch => this.db.sales_return_items.where('sales_return_id').anyOf(batch).toArray()) : [],
    ]);
    const customerIds = [...new Set([...invoices, ...originalInvoices, ...salesReturns].map((row) => row!.customer_id).concat(notes.filter(row => row.direction === 'OUTWARD').map(row => row.party_id)))];
    const supplierIds = [...new Set(purchases.map((row) => row.supplier_id).concat(notes.filter(row => row.direction === 'INWARD').map(row => row.party_id)))];
    const customers = (await this.db.customers.bulkGet(customerIds)).filter((row) => row?.business_id === id);
    const suppliers = (await this.db.suppliers.bulkGet(supplierIds)).filter((row) => row?.business_id === id);
    const relevantIds = new Set([...invoiceIds, ...purchases.map((row) => row.id), ...salesReturns.map((row) => row.id)]);
    const expenses = await this.db.expenses.where('[business_id+expense_date]')
      .between([id, period.periodStart], [id, period.nextPeriodStart], true, false).toArray();
    const advances = await this.db.advances.where('[business_id+advance_date]')
      .between([id, period.periodStart], [id, period.nextPeriodStart], true, false).toArray();
    const advanceCustomers = (await this.db.customers.bulkGet(advances.filter(row => row.party_type === 'customer').map(row => row.party_id))).filter(row => row?.business_id === id);
    for (const customer of advanceCustomers) if (!customers.some(row => row?.id === customer!.id)) customers.push(customer!);
    expenses.forEach((row) => relevantIds.add(row.id));
    advances.forEach((row) => relevantIds.add(row.id));
    notes.forEach(row => relevantIds.add(row.id));
    const sourceKeys = [
      ...invoiceIds.map((sourceId) => [id, 'INVOICE', sourceId]),
      ...purchases.flatMap((row) => [[id, 'PURCHASE', row.id], [id, 'PURCHASE_RETURN', row.id]]),
      ...salesReturns.map((row) => [id, 'SALES_RETURN', row.id]),
      ...expenses.map((row) => [id, 'EXPENSE', row.id]), ...advances.map((row) => [id, 'ADVANCE', row.id]),
      ...notes.map(row => [id, 'GST_NOTE', row.id]),
    ];
    if (sourceKeys.length) {
      metadata.push(...await this.db.gst_document_metadata.where('[business_id+source_entity_type+source_entity_id]').anyOf(sourceKeys).toArray());
      itcEntries.push(...await this.db.gst_itc_ledger.where('[business_id+source_entity_type+source_entity_id]').anyOf(sourceKeys).toArray());
    }
    const linkedAdvanceIds = new Set<string>();
    for (const meta of metadata) if (meta.advance_adjustments_json) {
      try { for (const offset of JSON.parse(meta.advance_adjustments_json)) if (typeof offset.advance_id === 'string') linkedAdvanceIds.add(offset.advance_id); } catch { /* Engine reports malformed evidence. */ }
    }
    const linkedAdvances = (await this.db.advances.bulkGet([...linkedAdvanceIds])).filter(row => row?.business_id === id);
    for (const advance of linkedAdvances) if (!advances.some(row => row.id === advance!.id)) { advances.push(advance!); relevantIds.add(advance!.id); }
    if (linkedAdvanceIds.size) metadata.push(...await this.db.gst_document_metadata.where('[business_id+source_entity_type+source_entity_id]')
      .anyOf([...linkedAdvanceIds].map(sourceId => [id, 'ADVANCE', sourceId])).toArray());
    const advanceOffsetEvidence = linkedAdvanceIds.size ? await this.db.gst_document_metadata.where('advance_offset_keys')
      .anyOf([...linkedAdvanceIds].map(sourceId => `${id}:${sourceId}`)).toArray() : [];
    const itcById = new Map(itcEntries.filter((row) => effective(row) < throughKey).map((row) => [row.id, row]));
    const pending = [...itcById.values()];
    const visited = new Set<string>();
    while (pending.length) {
      const entry = pending.pop()!;
      if (visited.has(entry.id)) continue;
      visited.add(entry.id);
      if (entry.related_prior_entry_id) {
        const prior = await this.db.gst_itc_ledger.get(entry.related_prior_entry_id);
        if (prior?.business_id === id && effective(prior) < throughKey && !itcById.has(prior.id)) { itcById.set(prior.id, prior); pending.push(prior); }
      }
      const linked = await this.db.gst_itc_ledger.where('[business_id+related_prior_entry_id]').equals([id, entry.id]).toArray();
      for (const row of linked) if (effective(row) < throughKey && !itcById.has(row.id)) { itcById.set(row.id, row); pending.push(row); }
    }
    itcEntries = [...itcById.values()];
    const auditIds = [...new Set(invoices.flatMap((row) => [row.id, row.reversed_by_invoice_id]).filter((value): value is string => !!value))];
    const legacyAudits = (await this.db.legacy_reversal_audit.bulkGet(auditIds)).filter((row) => row?.business_id === id);
    const fyInvoices = await this.db.invoices.where('[business_id+financial_year]').equals([id, period.financialYear]).toArray();
    const fyPurchases = await this.db.purchases.where('[business_id+financial_year]').equals([id, period.financialYear]).toArray();
    const fyReturns = await this.db.sales_returns.where('[business_id+return_date]')
      .between([id, `${period.financialYear.slice(0, 4)}-04-01`], [id, `${Number(period.financialYear.slice(0, 4)) + 1}-04-01`], true, false).toArray();
    const fyNotes = await this.db.gst_notes.where('[business_id+note_date]')
      .between([id, `${period.financialYear.slice(0, 4)}-04-01`], [id, `${Number(period.financialYear.slice(0, 4)) + 1}-04-01`], true, false).toArray();
    // Older edited invoices retain neither a successor pointer nor a cancelled
    // status. Their legacy audit is the authoritative supersession evidence.
    const legacyEditedOriginalIds = new Set((await this.db.legacy_reversal_audit.where('business_id').equals(id).toArray())
      .filter(row => row.classification === 'EDIT_REVERSAL').map(row => row.original_invoice_id));
    const fySuppliers = new Map((await this.db.suppliers.bulkGet([...new Set([...fyPurchases.map((row) => row.supplier_id), ...fyNotes.filter(row => row.direction === 'INWARD').map(row => row.party_id)])]))
      .filter((row) => row?.business_id === id).map((row) => [row!.id, row!]));
    const documentIdentityEvidence: NonNullable<GstMonthlySources['documentIdentityEvidence']> = [
      ...fyInvoices.map((row) => ({ source_entity_type: 'INVOICE' as const, source_entity_id: row.id, business_id: id,
        financial_year: row.financial_year, document_type: 'TAX_INVOICE', document_number: row.invoice_number, party_gstin: null,
        reportable: !row.deleted_at && !row.reverses_invoice_id && !row.reversed_by_invoice_id && !legacyEditedOriginalIds.has(row.id) })),
      ...fyPurchases.map((row) => ({ source_entity_type: row.reverses_purchase_id ? 'PURCHASE_RETURN' as const : 'PURCHASE' as const, source_entity_id: row.id, business_id: id,
        financial_year: row.financial_year, document_type: row.reverses_purchase_id ? 'CREDIT_NOTE' : 'TAX_INVOICE', document_number: row.supplier_bill_number || row.bill_number, party_gstin: fySuppliers.get(row.supplier_id)?.gstin ?? null,
        reportable: !(row as Purchase & { deleted_at?: string | null }).deleted_at && !row.replaced_by_purchase_id && !row.reversed_by_purchase_id })),
      ...fyReturns.map((row) => ({ source_entity_type: 'SALES_RETURN' as const, source_entity_id: row.id, business_id: id,
        financial_year: period.financialYear, document_type: 'CREDIT_NOTE', document_number: row.return_number, party_gstin: null,
        reportable: !row.deleted_at && row.status === 'posted' && !row.legacy_migration_classification })),
      ...fyNotes.map(row => ({ source_entity_type: 'GST_NOTE' as const, source_entity_id: row.id, business_id: id, direction: row.direction,
        financial_year: period.financialYear, document_type: row.note_type, document_number: row.note_number,
        party_gstin: row.direction === 'OUTWARD' ? null : fySuppliers.get(row.party_id)?.gstin ?? null, reportable: true })),
    ];
    const itemIds = [...new Set([...invoiceLines, ...purchaseLines, ...salesReturnItems].map(row => row.item_id))];
    const currentItems = (await this.db.items.bulkGet(itemIds)).filter(row => row?.business_id === id) as GstMonthlySources['currentItems'];
    const currentUnits = (await this.db.units.bulkGet([...new Set((currentItems ?? []).map(row => row.unit_id))])).filter(row => row?.business_id === id) as GstMonthlySources['currentUnits'];
    return {
      notes, currentItems, currentUnits, advanceOffsetEvidence,
      documentIdentityEvidence,
      business, invoices, purchases, salesReturns, originalInvoices: originalInvoices as GstMonthlySources['originalInvoices'],
      invoiceLines: invoiceLines.filter((row) => row.business_id === id),
      purchaseLines: purchaseLines.filter((row) => row.business_id === id),
      salesReturnItems: salesReturnItems.filter((row) => row.business_id === id),
      customers: customers as GstMonthlySources['customers'], suppliers: suppliers as GstMonthlySources['suppliers'],
      profiles: await this.db.gst_profiles.where('[business_id+active]').equals([id, 1])
        .filter((row) => row.effective_from < period.nextPeriodStart && (!row.effective_to || row.effective_to > period.periodStart)).toArray(),
      aato: await this.db.gst_aato.where('[business_id+financial_year]').equals([id, `${Number(period.financialYear.slice(0, 4)) - 1}-${period.financialYear.slice(2, 4)}`]).toArray(),
      metadata: [...new Map(metadata.filter((row) => relevantIds.has(row.source_entity_id)).map((row) => [row.id, row])).values()],
      itcEntries,
      adjustments: await this.db.gst_adjustments.where('[business_id+tax_period_key]')
        .between([id, period.periodStart.slice(0, 7)], [id, period.nextPeriodStart.slice(0, 7)], true, false).toArray(),
      expenses, advances, legacyAudits: legacyAudits as GstMonthlySources['legacyAudits'],
    };
  }
}
