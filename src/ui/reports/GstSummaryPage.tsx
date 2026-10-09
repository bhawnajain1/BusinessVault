import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { gstMonthlyReportService } from '../../domain/gstReporting';
import type { GstMonthlyReportService, SaveGstDocumentMetadataInput, ReviewGstItcInput, SaveGstProfileInput } from '../../domain/gstReporting/GstMonthlyReportService';
import { downloadMonthlyGstExcel, downloadMonthlyGstCsv, downloadMonthlyGstPdf, downloadMonthlyGstJson } from '../../domain/gstReporting/exports';
import { financialYearForDate, precedingFinancialYear, quarterPeriod } from '../../domain/gstReporting/periods';
import type { GstAmounts, GstAmountKey, GstMonthlySources, MonthlyGstCalculation, NormalizedGstDocument, BooksItcStatus, BooksItcRow } from '../../domain/gstReporting/types';
import { setCurrentBusinessId } from '../../lib/business';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import { money, toDateString } from './reportUtils';

type Workspace = Awaited<ReturnType<GstMonthlyReportService['loadWorkspace']>> & {
  itcSourcePurchases?: GstMonthlySources['purchases'];
  itcEntries?: GstMonthlySources['itcEntries'];
  auditLog?: Array<{ id: string; action: string; entity_type: string; entity_id: string; at: string; actor: string; before: unknown; after: unknown }>;
};
type SavedCalculation = MonthlyGstCalculation & { savedReportRunId?: string; savedStatus?: 'REVIEWED' | 'FINALIZED_WORKING' };
type ItcSource = Pick<NormalizedGstDocument, 'source_entity_type' | 'source_entity_id' | 'document_number' | 'document_date' | 'igst_paise' | 'cgst_paise' | 'sgst_paise' | 'cess_paise'>;
const tabs = ['Monthly Overview', 'GSTR-1 Working', 'Purchase / Books ITC', 'Draft GSTR-3B', 'Validation Issues', 'Source Transactions', 'Saved Reviews / Audit'] as const;
type Tab = typeof tabs[number];
const amounts: Array<[GstAmountKey, string]> = [['taxable_paise', 'Taxable'], ['igst_paise', 'IGST'], ['cgst_paise', 'CGST'], ['sgst_paise', 'SGST / UTGST'], ['cess_paise', 'Cess'], ['round_off_paise', 'Round-off'], ['total_paise', 'Document value']];
const itcStatuses: BooksItcStatus[] = ['UNREVIEWED', 'ELIGIBLE_IN_BOOKS', 'INELIGIBLE', 'TEMPORARILY_REVERSED', 'PERMANENTLY_REVERSED', 'RECLAIMABLE', 'RECLAIMED'];
const control = 'block w-full border border-slate-300 rounded px-2 py-1.5 bg-white text-slate-900';
const button = 'border border-slate-300 rounded px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50';
const linkButton = 'text-blue-700 underline rounded px-1 py-1 focus-visible:outline focus-visible:outline-2';

function Table({ title, headers, rows }: { title: string; headers: string[]; rows: ReactNode[][] }) {
  return <div className="overflow-x-auto border rounded" tabIndex={0} role="region" aria-label={`${title}, horizontally scrollable`}>
    <table className="min-w-full text-sm whitespace-nowrap"><caption className="text-left font-semibold p-3">{title}</caption>
      <thead className="bg-slate-50"><tr>{headers.map(h => <th scope="col" key={h} className="text-left px-3 py-2">{h}</th>)}</tr></thead>
      <tbody>{rows.map((row, i) => <tr key={i} className="border-t">{row.map((cell, j) => <td key={j} className="px-3 py-2 align-top">{cell}</td>)}</tr>)}
        {!rows.length && <tr><td colSpan={headers.length} className="p-4">No rows. This does not confirm a nil return.</td></tr>}</tbody>
    </table>
  </div>;
}

function integer(value: FormDataEntryValue | null, label: string, signed = false): number {
  if (typeof value !== 'string' || !(signed ? /^-?\d+$/ : /^\d+$/).test(value)) throw new Error(`${label} must be integer paise${signed ? ' (negative allowed)' : ' (nonnegative)'}.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds the safe integer range.`);
  return result;
}

function editable<T extends { id: string; created_at: string; updated_at: string; entity_version: number }>(row: T) {
  const { created_at: _created, updated_at: _updated, entity_version, ...values } = row;
  return { ...values, expectedVersion: entity_version };
}

function outputSources(result: MonthlyGstCalculation, key: GstAmountKey): string[] {
  return result.outwardDocuments.filter(d => d.included && !['UNCLASSIFIED', 'UNCLASSIFIED_INVALID_GSTIN', 'ECO_9_5_SUPPLIER', 'NIL_RATED', 'EXEMPT', 'NON_GST'].includes(d.classification) && d[key] !== 0).map(d => d.source_entity_id);
}

function itcContribution(row: BooksItcRow, component: string): number {
  switch (component) {
    case 'TOTAL_BOOKS_TAX': return row.books_tax_paise;
    case 'UNREVIEWED': case 'INELIGIBLE': return row.status === component ? row.books_tax_paise : 0;
    case 'ELIGIBLE_IN_BOOKS': return row.eligible_paise - row.reclaimed_paise;
    case 'TEMPORARILY_REVERSED': return row.temporarily_reversed_paise;
    case 'PERMANENTLY_REVERSED': return row.permanently_reversed_paise;
    case 'RECLAIMABLE': return row.reclaimable_paise;
    case 'RECLAIMED': return row.reclaimed_paise;
    case 'NET_APPROVED': return row.approved_paise;
    default: return 0;
  }
}

function itcSources(result: MonthlyGstCalculation, component: string, key: GstAmountKey): string[] {
  const head = key.slice(0, -6).toUpperCase();
  return result.booksItcRows.filter(row => row.tax_head === head && itcContribution(row, component) !== 0).map(row => row.source_entity_id);
}

function balanceSources(result: MonthlyGstCalculation, key: GstAmountKey): string[] {
  return [...outputSources(result, key), ...result.inwardDocuments.filter(d => d.included && d.classification === 'RCM' && d[key] !== 0).map(d => d.source_entity_id), ...itcSources(result, 'NET_APPROVED', key)];
}

export default function GstSummaryPage() {
  const active = useActiveBusiness();
  const navigate = useNavigate();
  const today = toDateString(new Date());
  const [businessId, setBusinessId] = useState('');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [financialYear, setFinancialYear] = useState(financialYearForDate(today));
  const [frequency, setFrequency] = useState<'MONTHLY' | 'QRMP'>('MONTHLY');
  const [months, setMonths] = useState<string[]>([today.slice(0, 7)]);
  const [quarter, setQuarter] = useState(1);
  const [results, setResults] = useState<MonthlyGstCalculation[]>([]);
  const [savedResult, setSavedResult] = useState<SavedCalculation | null>(null);
  const [currentKey, setCurrentKey] = useState('');
  const [tab, setTab] = useState<Tab>('Monthly Overview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [stale, setStale] = useState(false);
  const [filter, setFilter] = useState<{ ids: string[]; label: string; allMonths?: boolean } | null>(null);
  const [metadata, setMetadata] = useState<SaveGstDocumentMetadataInput | null>(null);
  const [profile, setProfile] = useState<SaveGstProfileInput | null>(null);
  const [adjustmentTable, setAdjustmentTable] = useState('');
  const request = useRef(0);
  const sourceHeading = useRef<HTMLHeadingElement>(null);
  const business = workspace?.businesses.find(b => b.id === businessId);
  const current = savedResult ?? results.find(r => r.period.periodKey === currentKey) ?? results[0];
  const visibleResults = savedResult ? [savedResult] : results;
  const immutable = savedResult !== null;
  const writeBlocked = busy || stale || immutable;
  const startYear = Number(financialYear.slice(0, 4));
  const monthOptions = Array.from({ length: 12 }, (_, i) => `${i < 9 ? startYear : startYear + 1}-${String((i + 3) % 12 + 1).padStart(2, '0')}`);
  const previousYear = precedingFinancialYear(financialYear);
  const aato = workspace?.aato.find(a => a.financial_year === previousYear);
  const allDocuments = visibleResults.flatMap(r => [...r.outwardDocuments, ...r.inwardDocuments]);
  const documents = current ? [...current.outwardDocuments, ...current.inwardDocuments] : [];
  const normalWorking = immutable || !profile || profile.registration_type === 'REGULAR';
  const adjustmentFields = current?.gstr3bSections.fields.filter(f => ['igst_paise', 'cgst_paise', 'sgst_paise', 'cess_paise'].includes(f.measure)) ?? [];
  const adjustmentTables = [...new Set(adjustmentFields.map(f => f.table_code))];
  const selectedAdjustmentTable = adjustmentTables.includes(adjustmentTable) ? adjustmentTable : adjustmentTables[0] ?? '';
  const adjustmentHeads = [...new Set(adjustmentFields.filter(f => f.table_code === selectedAdjustmentTable).map(f => f.measure.slice(0, -6).toUpperCase()))];

  useEffect(() => { if (active.businessId) setBusinessId(active.businessId); }, [active.businessId]);
  useEffect(() => {
    if (!businessId) return;
    let alive = true;
    setWorkspace(null); setProfile(null); setError(''); setBusy(true);
    gstMonthlyReportService.loadWorkspace(businessId).then((w: Workspace) => {
      if (!alive) return;
      setWorkspace(w);
      const b = w.businesses.find(row => row.id === businessId);
      const p = w.profiles.filter(row => row.active).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
      setFrequency(p?.filing_frequency ?? 'MONTHLY');
      setProfile(p ? editable(p) : {
        business_id: businessId, gstin: b?.gstin ?? '', legal_name: b?.name ?? '', state_code: b?.state_code ?? '',
        registration_type: 'REGULAR', registration_start_date: null, registration_end_date: null,
        filing_frequency: 'MONTHLY', gst_reporting_enabled: 1, effective_from: `${financialYear.slice(0, 4)}-04-01`, effective_to: null, active: 1,
      });
    }).catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; request.current++; };
    // FY selection does not reload or replace an unsaved profile editor.
  }, [businessId]);

  function invalidate(clear = false) {
    request.current++;
    setStale(true); setMetadata(null); setFilter(null);
    if (clear) { setResults([]); setSavedResult(null); setCurrentKey(''); }
  }

  async function run(action: () => Promise<unknown>, saved = false) {
    setBusy(true); setError(''); setMessage('');
    try {
      await action();
      if (saved) {
        invalidate();
        setWorkspace(await gstMonthlyReportService.loadWorkspace(businessId));
        setMessage('Saved. Recalculate to use the updated source data.');
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function calculate() {
    const token = ++request.current;
    await run(async () => {
      if (!months.length) throw new Error('Select at least one tax month.');
      const calculated = await gstMonthlyReportService.calculateMonths(businessId, [...months].sort(), frequency);
      if (token !== request.current) return;
      setResults(calculated); setCurrentKey(calculated[0]?.period.periodKey ?? '');
      setFilter(null); setMetadata(null); setStale(false);
      setMessage('Calculated independent monthly workings. No return has been filed.');
    });
  }

  function drill(ids: string[], label: string, result = current) {
    if (result) setCurrentKey(result.period.periodKey);
    setFilter({ ids: [...new Set(ids)], label }); setTab('Source Transactions');
    setTimeout(() => sourceHeading.current?.focus(), 0);
  }
  function metric(value: number | null, ids: string[], label: string, result = current, monetary = true) {
    const display = value === null ? 'Not available' : !Number.isFinite(value) || monetary && !Number.isSafeInteger(value) ? 'Invalid source amount' : monetary ? money(value) : value;
    return <button type="button" className={linkButton} aria-label={`${label}: ${display}. Show contributing sources`} onClick={() => drill(ids, label, result)}>{display}</button>;
  }
  function amountCells(row: GstAmounts, ids: string[], label: string, result = current) {
    return amounts.map(([key, name]) => metric(row[key], ids, `${label} ${name}`, result));
  }
  function manifestRows<T>(type: string): T[] {
    return [...new Map(visibleResults.flatMap(r => r.sourceManifest.filter(m => m.entity_type === type).map(m => [m.entity_id, m.content as T] as const))).values()];
  }
  function editMetadata(doc: NormalizedGstDocument) {
    const old = manifestRows<SaveGstDocumentMetadataInput & { id: string; created_at: string; updated_at: string; entity_version: number }>('GST_DOCUMENT_METADATA').find(m => m.source_entity_type === doc.source_entity_type && m.source_entity_id === doc.source_entity_id);
    setMetadata(old ? editable(old) : {
      business_id: businessId, source_entity_type: doc.source_entity_type, source_entity_id: doc.source_entity_id,
      document_type: doc.effect_sign === -1 ? 'CREDIT_NOTE' : 'TAX_INVOICE', supply_category: null, recipient_category: null,
      place_of_supply_state_code: null, reverse_charge: null, ecommerce_operator_gstin: null, ecommerce_reporting_type: null,
      section_9_5_role: null, section_52_tcs: null, shipping_bill_number: null, shipping_bill_date: null, port_code: null,
      original_document_number: null, original_document_date: null, original_return_period: null,
      reporting_period_override: null, original_source_entity_type: null, original_source_entity_id: null,
      previously_reported_values_json: null, amendment_kind: null, tax_on_advance_applicable: null, classification_source: 'USER_CAPTURED',
    });
  }
  function sourceLink(type: string, id: string, label: string): ReactNode {
    const route = type === 'INVOICE' ? '/invoices/' : type === 'SALES_RETURN' ? '/returns/' : ['PURCHASE', 'PURCHASE_RETURN', 'ITC_SOURCE_PURCHASE'].includes(type) ? '/purchases/' : null;
    return route ? <Link className={linkButton} to={`${route}${encodeURIComponent(id)}`} onClick={event => {
      event.preventDefault();
      void run(async () => { await setCurrentBusinessId(businessId); navigate(`${route}${encodeURIComponent(id)}`); });
    }}>{label}</Link> : <span>{label}</span>;
  }
  function submit(event: FormEvent<HTMLFormElement>, action: (data: FormData) => Promise<unknown>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    if (immutable) { setError('Saved snapshots are read-only. Return to the live working before making changes.'); return; }
    void run(() => action(data), true);
  }
  const ledger = [...new Map([
    ...(immutable ? [] : workspace?.itcEntries ?? []).filter(l => l.business_id === businessId),
    ...manifestRows<GstMonthlySources['itcEntries'][number]>('GST_ITC_LEDGER'),
  ].map(l => [l.id, l])).values()];
  const historicalPurchases = [...new Map([
    ...(immutable ? [] : workspace?.itcSourcePurchases ?? []),
    ...(immutable ? [] : workspace?.reviewPurchases ?? []).filter((p): p is GstMonthlySources['purchases'][number] => !!p),
    ...manifestRows<{ header: GstMonthlySources['purchases'][number] }>('ITC_SOURCE_PURCHASE').map(p => p.header),
  ].filter(p => p.business_id === businessId).map(p => [p.id, p])).values()];
  const purchaseSources = new Map<string, ItcSource>();
  for (const p of historicalPurchases) purchaseSources.set(p.id, {
    source_entity_type: p.reverses_purchase_id ? 'PURCHASE_RETURN' : 'PURCHASE',
    source_entity_id: p.id, document_number: p.bill_number, document_date: p.bill_date,
    igst_paise: p.igst_paise, cgst_paise: p.cgst_paise, sgst_paise: p.sgst_paise, cess_paise: p.cess_paise,
  });
  for (const d of allDocuments.filter(d => d.source_entity_type.startsWith('PURCHASE'))) purchaseSources.set(d.source_entity_id, d);
  const historicalReferences = historicalPurchases.filter(p => !allDocuments.some(d => d.source_entity_id === p.id));
  const field = (label: string, name: string, value = '', type = 'text', required = false) => <label className="text-sm">{label}<input className={control} name={name} defaultValue={value} type={type} required={required} /></label>;

  return <div className="p-4 sm:p-6 space-y-4 text-slate-900" aria-busy={busy}>
    <h1 className="text-2xl font-semibold">GST Reports</h1>
    <p className="text-sm text-slate-600">Books-based working for taxpayer and CA review, not proof of filing, an official GST Portal statement, or a GSTN upload file. One business represents one GST registration.</p>
    <div role="alert">{error || active.error?.message}</div>
    <div role="status" aria-live="polite">{busy ? 'Working...' : message}</div>
    {!active.loading && !active.businessId && <p>Select or create a business before preparing GST reports.</p>}
    {savedResult && <section role="status" className="border border-blue-700 rounded p-3"><h2 className="font-semibold">Read-only saved snapshot: {savedResult.savedStatus ?? 'Saved working'} / {savedResult.period.periodKey}</h2><p>Run {savedResult.savedReportRunId}. Original source hash: {savedResult.sourceDataHash}. Viewing and exporting this snapshot does not replace the live working.</p><button type="button" className={button} onClick={() => { setSavedResult(null); setMetadata(null); setFilter(null); }}>Return to live working</button></section>}
    <fieldset disabled={busy || active.loading || immutable} className="space-y-3">
      <legend className="font-semibold">Report selection</legend>
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <label>Business<select className={control} value={businessId} onChange={e => { invalidate(true); setBusinessId(e.target.value); }}>{workspace?.businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label>GSTIN<input className={control} readOnly value={business?.gstin ?? ''} /></label>
        <label>Financial year<input className={control} type="number" min="1900" max="9998" value={startYear} onChange={e => { const y = Number(e.target.value); if (Number.isInteger(y) && y >= 1900 && y <= 9998) { invalidate(true); setFinancialYear(`${y}-${String(y + 1).slice(-2)}`); setMonths([]); } }} /><span className="text-sm">{financialYear}</span></label>
        <label>Filing frequency<select className={control} value={frequency} onChange={e => { invalidate(true); setFrequency(e.target.value as typeof frequency); }}><option>MONTHLY</option><option>QRMP</option></select></label>
      </div>
      <fieldset className="border rounded p-3"><legend>Tax months (each calculated independently)</legend>
        <label className="block mb-2"><input type="checkbox" checked={months.length === 12} onChange={e => { invalidate(true); setMonths(e.target.checked ? monthOptions : []); }} /> Select all months</label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">{monthOptions.map(key => <label key={key}><input type="checkbox" checked={months.includes(key)} onChange={e => { invalidate(true); setMonths(e.target.checked ? [...months, key].sort() : months.filter(m => m !== key)); }} /> {key}</label>)}</div>
      </fieldset>
      {frequency === 'QRMP' && <div className="flex flex-wrap gap-3 items-end"><label>Quarter<select className={control} value={quarter} onChange={e => setQuarter(Number(e.target.value))}>{[1, 2, 3, 4].map(q => <option key={q} value={q}>Q{q}</option>)}</select></label><button type="button" className={button} onClick={() => { invalidate(true); setMonths(monthOptions.slice((quarter - 1) * 3, quarter * 3)); }}>Select quarter months</button><p className="text-sm">Monthly internal workings and quarter analysis are distinct; no IFF or filing is performed.</p></div>}
      <button type="button" className={button} disabled={!business || !months.length} onClick={() => void calculate()}>{results.length ? 'Recalculate' : 'Calculate selected months'}</button>
    </fieldset>

    {profile && <details className="border rounded p-3"><summary className="font-semibold cursor-pointer">GST profile and preceding FY AATO</summary>
      <form className="mt-3" onSubmit={e => submit(e, async () => {
        const saved: Awaited<ReturnType<GstMonthlyReportService['saveProfile']>> = await gstMonthlyReportService.saveProfile({ ...profile, filing_frequency: frequency });
        setProfile(editable(saved));
      })}><fieldset disabled={busy || immutable} className="grid sm:grid-cols-3 gap-3"><legend>Registration profile</legend>
        <label>Registration type<select className={control} value={profile.registration_type} onChange={e => setProfile({ ...profile, registration_type: e.target.value as typeof profile.registration_type })}>{['REGULAR', 'COMPOSITION', 'UNREGISTERED', 'OTHER'].map(s => <option key={s}>{s}</option>)}</select></label>
        <label>Effective from<input className={control} type="date" required value={profile.effective_from} onChange={e => setProfile({ ...profile, effective_from: e.target.value })} /></label>
        <label>Effective to (exclusive)<input className={control} type="date" value={profile.effective_to ?? ''} onChange={e => setProfile({ ...profile, effective_to: e.target.value || null })} /></label>
        <label>Registration start<input className={control} type="date" value={profile.registration_start_date ?? ''} onChange={e => setProfile({ ...profile, registration_start_date: e.target.value || null })} /></label>
        <label>Registration end<input className={control} type="date" value={profile.registration_end_date ?? ''} onChange={e => setProfile({ ...profile, registration_end_date: e.target.value || null })} /></label>
        <label><input type="checkbox" checked={profile.gst_reporting_enabled === 1} onChange={e => setProfile({ ...profile, gst_reporting_enabled: e.target.checked ? 1 : 0 })} /> Enable GST reporting</label>
        <label><input type="checkbox" checked={profile.active === 1} onChange={e => setProfile({ ...profile, active: e.target.checked ? 1 : 0 })} /> Active profile</label>
        <button className={button}>Save profile</button>
      </fieldset></form>
      <p className="text-sm my-3">Composition and unregistered registrations do not support normal GSTR-1 / Draft GSTR-3B workings. Enter complete taxpayer AATO, not merely turnover recorded in BusinessVault.</p>
      <form key={`${businessId}-${previousYear}-${aato?.entity_version}`} onSubmit={e => submit(e, data => gstMonthlyReportService.setAato({
        ...(aato ? editable(aato) : {}), business_id: businessId, financial_year: previousYear,
        aato_paise: integer(data.get('aato'), 'AATO'), source: 'USER_CONFIRMED', confirmed_at: new Date().toISOString(),
        notes: String(data.get('notes') ?? ''), ...(aato ? { id: aato.id, expectedVersion: aato.entity_version } : {}),
      }))}><fieldset disabled={busy || immutable} className="grid sm:grid-cols-3 gap-3"><legend>AATO for preceding financial year {previousYear}</legend>
        {field('Confirmed AATO (integer paise)', 'aato', String(aato?.aato_paise ?? ''), 'number', true)}
        {field('AATO notes', 'notes', aato?.notes ?? '')}<button className={button}>Save AATO</button>
      </fieldset></form>
    </details>}

    {stale && !immutable && results.length > 0 && <p role="status" className="border border-amber-600 p-3">Source data changed. Recalculate before exporting or saving this working.</p>}
    <label className="block max-w-sm">Report view<select className={control} value={tab} onChange={e => setTab(e.target.value as Tab)}>{tabs.map(t => <option key={t}>{t}</option>)}</select></label>
    <nav aria-label="GST report views" className="flex flex-wrap gap-2">{tabs.map(t => <button type="button" key={t} className={`${button} ${tab === t ? 'bg-slate-900 text-white' : ''}`} aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>)}</nav>
    {visibleResults.length > 0 && <>
      <label className="block max-w-xs">Current tax month<select className={control} disabled={immutable} value={current?.period.periodKey ?? ''} onChange={e => { setCurrentKey(e.target.value); setMetadata(null); setFilter(null); }}>{visibleResults.map(r => <option key={r.period.periodKey}>{r.period.periodKey}</option>)}</select></label>
      <fieldset disabled={busy || stale && !immutable} className="flex flex-wrap gap-2"><legend>Exports (do not change review status)</legend>
        {(['Excel', 'Csv', 'Pdf', 'Json'] as const).map(format => <span key={format} className="flex flex-wrap gap-2">
          {(immutable ? ['saved'] as const : ['current', 'all'] as const).map(scope => <button type="button" className={button} key={scope} onClick={() => void run(async () => {
            const chosen = scope === 'all' ? results : current ? [current] : [];
            const download = { Excel: downloadMonthlyGstExcel, Csv: downloadMonthlyGstCsv, Pdf: downloadMonthlyGstPdf, Json: downloadMonthlyGstJson }[format];
            await download(chosen); setMessage('Exported books-based working; review status unchanged.');
          })}>Download {format === 'Json' ? 'BusinessVault working JSON' : format === 'Csv' ? 'CSV registers' : format === 'Pdf' ? 'PDF summary' : 'Excel'} ({scope === 'saved' ? 'saved snapshot' : scope === 'all' ? 'selected months' : 'current month'})</button>)}
        </span>)}
      </fieldset>
    </>}

    {tab === 'Monthly Overview' && <>
      <Table title="Independent monthly comparison (not a combined return period)" headers={['Month', 'Status', 'Sales documents', 'Net taxable outward', 'Output IGST', 'Output CGST', 'Output SGST', 'Output cess', 'Sales round-off', 'Note effect', 'Purchase documents', 'Purchase taxable', 'Purchase IGST', 'Purchase CGST', 'Purchase SGST', 'Purchase cess', 'Blocking errors', 'Warnings']} rows={visibleResults.map(r => {
        const o = r.totals.outwardNet, p = r.totals.inwardNet;
        return [r.period.periodKey, savedResult?.savedStatus ?? r.status, metric(o.document_count, o.source_entity_ids, 'Sales documents', r, false), metric(o.taxable_paise, o.source_entity_ids, 'Outward Taxable', r), ...amounts.slice(1, 5).map(([key, label]) => metric(r.totals.outputLiability[key], outputSources(r, key), `Output ${label}`, r)), metric(o.round_off_paise, o.source_entity_ids, 'Outward round-off', r), metric(r.totals.outwardNotes.total_paise, r.totals.outwardNotes.source_entity_ids, 'Note effect', r), metric(p.document_count, p.source_entity_ids, 'Purchase documents', r, false), ...amountCells(p, p.source_entity_ids, 'Purchase', r).slice(0, 5), ...(['BLOCKING_ERROR', 'WARNING'] as const).map(severity => <button type="button" className={linkButton} onClick={() => { setCurrentKey(r.period.periodKey); setTab('Validation Issues'); }}>{r.issues.filter(i => i.severity === severity).length}</button>)];
      })} />
      <Table title="Monthly ITC and indicative balance by tax head" headers={['Month', 'Measure', 'IGST', 'CGST', 'SGST / UTGST', 'Cess']} rows={visibleResults.flatMap(r => [...itcStatuses, 'TOTAL_BOOKS_TAX', 'NET_APPROVED', 'INDICATIVE_BALANCE'].map(status => {
        const total = status === 'INDICATIVE_BALANCE' ? r.totals.indicativeWorkingBalance : r.totals.booksItc[status as keyof typeof r.totals.booksItc];
        return [r.period.periodKey, status, ...amounts.slice(1, 5).map(([key, label]) => metric(total[key], status === 'INDICATIVE_BALANCE' ? balanceSources(r, key) : itcSources(r, status, key), `${status} ${label}`, r))];
      }))} />
      {!immutable && frequency === 'QRMP' && (() => {
        const period = quarterPeriod(businessId, business?.gstin ?? '', financialYear, quarter);
        const selected = results.filter(r => r.period.periodStart >= period.periodStart && r.period.periodStart < period.nextPeriodStart);
        return <section className="border rounded p-3"><h2 className="font-semibold">{period.periodKey} quarter analysis, not a statutory return</h2>
          <p>{selected.length === 3 ? 'All three months calculated independently.' : 'Partial analysis: calculate all three quarter months for a complete comparison.'}</p>
          <Table title="Quarter analysis by measure" headers={['Measure', 'Analysis amount']} rows={amounts.map(([key, label]) => {
            const total = selected.reduce((sum, r) => sum + r.totals.outwardNet[key], 0);
            return [label, Number.isSafeInteger(total) ? <button type="button" className={linkButton} onClick={() => { setFilter({ ids: selected.flatMap(r => r.totals.outwardNet.source_entity_ids), label: 'Quarter analysis (selected months)', allMonths: true }); setTab('Source Transactions'); setTimeout(() => sourceHeading.current?.focus(), 0); }}> {money(total)}</button> : 'Unsafe total: analysis unavailable'];
          })} />
          <Table title="Quarter purchase, liability and ITC analysis (sum of monthly workings)" headers={['Measure', 'IGST', 'CGST', 'SGST / UTGST', 'Cess']} rows={['PURCHASE_GROSS', 'PURCHASE_NOTES', 'PURCHASE_NET', 'OUTPUT_LIABILITY', 'RCM_LIABILITY', ...itcStatuses, 'TOTAL_BOOKS_TAX', 'NET_APPROVED', 'INDICATIVE_BALANCE'].map(component => [component, ...amounts.slice(1, 5).map(([key, label]) => {
            let total = 0; const ids: string[] = [];
            for (const r of selected) {
              const purchase = component === 'PURCHASE_GROSS' ? r.totals.inwardGross : component === 'PURCHASE_NOTES' ? r.totals.inwardNotes : component === 'PURCHASE_NET' ? r.totals.inwardNet : null;
              const source = purchase ?? (component === 'OUTPUT_LIABILITY' ? r.totals.outputLiability : component === 'RCM_LIABILITY' ? r.totals.rcmLiability : component === 'INDICATIVE_BALANCE' ? r.totals.indicativeWorkingBalance : r.totals.booksItc[component as keyof typeof r.totals.booksItc]);
              total += source[key];
              ids.push(...(purchase ? purchase.source_entity_ids : component === 'OUTPUT_LIABILITY' ? outputSources(r, key) : component === 'RCM_LIABILITY' ? r.inwardDocuments.filter(d => d.included && d.classification === 'RCM' && d[key] !== 0).map(d => d.source_entity_id) : component === 'INDICATIVE_BALANCE' ? balanceSources(r, key) : itcSources(r, component, key)));
            }
            return Number.isSafeInteger(total) ? <button type="button" className={linkButton} aria-label={`Quarter ${component} ${label}: ${money(total)}. Show contributing sources`} onClick={() => { setFilter({ ids: [...new Set(ids)], label: `Quarter ${component} ${label}`, allMonths: true }); setTab('Source Transactions'); }}>{money(total)}</button> : 'Unsafe total: analysis unavailable';
          })])} />
        </section>;
      })()}
    </>}

    {!normalWorking && ['GSTR-1 Working', 'Draft GSTR-3B'].includes(tab) && <p role="status">Normal GSTR-1 / Draft GSTR-3B workings are not available for this registration type. Review the registration profile.</p>}
    {current && normalWorking && tab === 'GSTR-1 Working' && <>
      <Table title={`GSTR-1 Working ${current.period.periodKey}`} headers={['Section', 'Documents', 'Recipients', 'Detail rows', ...amounts.map(a => a[1])]} rows={Object.entries(current.gstr1Sections.summaries).map(([name, s]) => [name, ...[s.document_count, s.party_count, s.detail_row_count].map((n, i) => metric(n, s.source_entity_ids, `${name} ${['documents', 'recipients', 'detail rows'][i]}`, current, false)), ...amountCells(s, s.source_entity_ids, name)])} />
      <Table title="Outward rate-wise working" headers={['Source', 'Classification', 'GST rate', 'Taxability', 'POS', ...amounts.map(a => a[1])]} rows={current.outwardRateRows.map(r => [sourceLink(r.source_entity_type, r.source_entity_id, r.source_entity_id), r.classification, `${r.tax_rate_bps / 100}%`, r.taxability, r.place_of_supply, ...amountCells(r, [r.source_entity_id], 'Outward rate row')])} />
      <Table title="HSN / SAC working" headers={['Recipient group', 'HSN / SAC', 'Historical description', 'UQC', 'Taxability', 'Quantity', ...amounts.map(a => a[1])]} rows={current.outwardHsnRows.map(r => [r.recipient_group, r.hsn, r.description, r.uqc_code ?? 'Unknown', r.taxability, metric(r.quantity_micros / 1_000_000, r.source_entity_ids, 'Quantity', current, false), ...amountCells(r, r.source_entity_ids, `HSN ${r.hsn}`)])} />
      <Table title="Documents issued" headers={['Nature', 'Series', 'From', 'To', 'Issued', 'Cancelled', 'Net issued', 'Gaps', 'Duplicates', 'Status']} rows={current.documentSeries.map(s => [s.document_nature, s.series, s.serial_from, s.serial_to, ...[s.total_issued, s.cancelled, s.net_issued].map(n => metric(n, s.source_entity_ids, 'Document series count', current, false)), s.gaps.map(g => `${g.from} to ${g.to}`).join(', '), s.duplicates.join(', '), s.status])} />
    </>}

    {current && tab === 'Purchase / Books ITC' && <>
      <p>Books ITC: subject to CA review and reconciliation with GST Portal data. Purchase tax is unreviewed until explicitly reviewed.</p>
      <form onSubmit={e => {
        e.preventDefault(); const id = String(new FormData(e.currentTarget).get('historicalSource') ?? '').trim();
        if (immutable) { setError('Saved snapshots are read-only. Return to the live working before loading sources.'); return; }
        void run(async () => {
          const loaded = await gstMonthlyReportService.loadWorkspace(businessId, [...new Set([...purchaseSources.keys(), id])]);
          if (!loaded.reviewPurchases?.some(p => p?.id === id)) throw new Error('Historical purchase was not found in this business. Check its source ID.');
          setWorkspace(loaded); setMessage('Historical purchase reference loaded. Current-month purchase totals are unchanged.');
        });
      }}><fieldset disabled={writeBlocked} className="flex flex-wrap items-end gap-3"><legend>Load an earlier purchase for reversal / reclaim</legend>
        {field('Historical purchase source ID', 'historicalSource', '', 'text', true)}<button className={button}>Load historical purchase</button>
      </fieldset></form>
      <Table title="Gross purchases, notes, and net movement" headers={['Measure', 'Documents', 'Suppliers', ...amounts.map(a => a[1])]} rows={(['inwardGross', 'inwardNotes', 'inwardNet'] as const).map(key => { const r = current.totals[key]; return [key, metric(r.document_count, r.source_entity_ids, 'Purchase documents', current, false), metric(r.party_count, r.source_entity_ids, 'Suppliers', current, false), ...amountCells(r, r.source_entity_ids, key)]; })} />
      <Table title="Purchase HSN / SAC working" headers={['HSN / SAC', 'Historical description', 'UQC', 'Taxability', ...amounts.map(a => a[1])]} rows={current.inwardHsnRows.map(r => [r.hsn, r.description, r.uqc_code ?? 'Unknown', r.taxability, ...amountCells(r, r.source_entity_ids, `Purchase HSN ${r.hsn}`)])} />
      <Table title="Books ITC review by source and head" headers={['Source', 'Head', 'Status', 'Category', 'Books tax', 'Eligible', 'Temporary reversal', 'Permanent reversal', 'Reclaimable', 'Reclaimed', 'Approved', 'Reason', 'Prior entry']} rows={current.booksItcRows.map(r => [sourceLink(r.source_entity_type, r.source_entity_id, r.source_entity_id), r.tax_head, r.status, r.category ?? 'Unknown', ...[r.books_tax_paise, r.eligible_paise, r.temporarily_reversed_paise, r.permanently_reversed_paise, r.reclaimable_paise, r.reclaimed_paise, r.approved_paise].map(n => metric(n, [r.source_entity_id], `${r.tax_head} ITC`)), r.reason, r.related_prior_entry_id])} />
      <form key={`${current.period.periodKey}-${current.sourceDataHash}`} onSubmit={e => submit(e, async data => {
        const status = String(data.get('status')) as BooksItcStatus;
        if (status === 'UNREVIEWED') throw new Error('Purchase tax is already unreviewed. Select an explicit reviewed status before saving; no entry was created.');
        const id = String(data.get('source')); const source = purchaseSources.get(id);
        if (!source) throw new Error('Select a purchase source.');
        const head = String(data.get('head')) as ReviewGstItcInput['tax_head'];
        const period = String(data.get('period'));
        const sameSource = ledger.filter(l => l.source_entity_id === id && l.source_entity_type === source.source_entity_type && l.tax_head === head);
        const effective = sameSource.filter(l => !sameSource.some(next => next.related_prior_entry_id === l.id && next.tax_period_key === l.tax_period_key && ['UNREVIEWED', 'PENDING_REVIEW'].includes(l.status)));
        const samePeriod = effective.filter(l => l.tax_period_key === period);
        const priorId = String(data.get('prior')) || null;
        const unreviewed = samePeriod.filter(l => ['UNREVIEWED', 'PENDING_REVIEW'].includes(l.status));
        if (samePeriod.some(l => !['UNREVIEWED', 'PENDING_REVIEW'].includes(l.status))) throw new Error('An effective reviewed ITC entry already exists for this source, head and period. Use a later period for a reversal/reclaim movement.');
        if (unreviewed.length > 1) throw new Error('Multiple unreviewed entries require correction before a superseding review.');
        const supersedes = unreviewed[0];
        if (supersedes && status === 'RECLAIMED') throw new Error('A reclaim must link an earlier temporary reversal, not an unreviewed entry.');
        if (supersedes && priorId && priorId !== supersedes.id) throw new Error('This review must supersede the existing unreviewed entry; clear the unrelated prior entry ID.');
        const amount = integer(data.get('amount'), 'Reviewed amount');
        const original = integer(data.get('eligible'), 'Original eligible amount');
        return gstMonthlyReportService.reviewItc({ business_id: businessId, source_entity_type: source.source_entity_type, source_entity_id: id,
          tax_period_key: period, source_period_key: source.document_date.slice(0, 7), tax_head: head,
          books_tax_paise: status === 'RECLAIMED' ? 0 : Math.abs(source[`${head.toLowerCase()}_paise` as 'igst_paise' | 'cgst_paise' | 'sgst_paise' | 'cess_paise']), category: String(data.get('category')) as ReviewGstItcInput['category'] || null,
          status, original_eligible_paise: original, temporarily_reversed_paise: status === 'TEMPORARILY_REVERSED' ? amount : 0,
          permanently_reversed_paise: status === 'PERMANENTLY_REVERSED' ? amount : 0, reclaimable_paise: ['TEMPORARILY_REVERSED', 'RECLAIMABLE'].includes(status) ? amount : 0,
          reclaimed_paise: status === 'RECLAIMED' ? amount : 0, reversal_period_key: status.includes('REVERSED') ? period : null,
          reclaim_period_key: status === 'RECLAIMED' ? period : null, reason_code: String(data.get('code')) || null,
          reason: String(data.get('reason')), related_prior_entry_id: supersedes?.id ?? priorId, user_confirmation: 1,
          reviewed_at: null, reviewed_by_device_id: active.deviceId,
        });
      })}><fieldset disabled={writeBlocked} className="grid sm:grid-cols-3 gap-3 border rounded p-3"><legend>Explicit ITC review (immutable ledger entry)</legend>
        <label>Purchase source<select className={control} name="source" required><option value="">Select source</option>{[...purchaseSources.values()].map(d => <option key={d.source_entity_id} value={d.source_entity_id}>{d.document_number} ({d.document_date})</option>)}</select></label>
        <label>Tax head<select className={control} name="head">{['IGST', 'CGST', 'SGST', 'CESS'].map(h => <option key={h}>{h}</option>)}</select></label>
        <label>Review status<select className={control} name="status">{itcStatuses.map(s => <option key={s}>{s}</option>)}</select></label>
        <label>Explicit ITC category<select className={control} name="category"><option value="">Unknown / unreviewed</option>{['IMPORT_GOODS', 'IMPORT_SERVICES', 'RCM', 'ISD', 'OTHER_ITC'].map(s => <option key={s}>{s}</option>)}</select></label>
        {field('Review / movement period (YYYY-MM)', 'period', current.period.periodKey, 'month', true)}
        {field('Original eligible amount (integer paise)', 'eligible', '', 'number', true)}
        {field('Reversal / reclaim amount (integer paise)', 'amount', '', 'number', true)}
        {field('Reason code', 'code')}{field('Review reason', 'reason', '', 'text', true)}
        {field('Prior temporary reversal entry ID (required for reclaim)', 'prior')}
        <button className={button}>Save ITC review</button>
      </fieldset></form>
      <Table title="ITC ledger reference IDs (loaded report evidence)" headers={['Entry ID', 'Source', 'Period', 'Head', 'Status', 'Prior entry']} rows={ledger.map(l => [l.id, sourceLink(l.source_entity_type, l.source_entity_id, l.source_entity_id), l.tax_period_key, l.tax_head, l.status, l.related_prior_entry_id ? <button type="button" className={linkButton} onClick={() => drill([l.related_prior_entry_id!], 'Prior temporary reversal')}>{l.related_prior_entry_id}</button> : 'None'])} />
    </>}

    {current && normalWorking && tab === 'Draft GSTR-3B' && <>
      <p>{current.gstr3bSections.disclaimer}</p>
      <Table title="Draft GSTR-3B Working" headers={['Table', 'Measure', 'Books-derived', 'GSTR-1 working', 'Approved Books ITC', 'Calculated', 'CA adjustment', 'Final working', 'Source status', 'Documents', 'Notes']} rows={current.gstr3bSections.fields.map(f => [f.table_code, f.measure, ...[f.books_derived_paise, f.gstr1_working_paise, f.approved_books_itc_paise, f.calculated_paise, f.ca_adjustment_paise, f.final_working_paise].map(n => metric(n, [...f.source_entity_ids, ...f.adjustment_ids], `${f.table_code} ${f.measure}`)), f.source_status, metric(f.source_document_count, f.source_entity_ids, 'Source documents', current, false), f.notes])} />
      <Table title="Table 3.2 interstate supplies" headers={['Place of supply', 'Recipient category', ...amounts.map(a => a[1])]} rows={current.gstr3bSections.interstateSupplies.map(s => [s.place_of_supply, s.recipient_category, ...amountCells(s, s.source_entity_ids, 'Interstate supply')])} />
      <form key={current.period.periodKey} onSubmit={e => submit(e, data => {
        const head = String(data.get('head')) as ReviewGstItcInput['tax_head']; const table = String(data.get('table'));
        const target = adjustmentFields.find(f => f.table_code === table && f.measure === `${head.toLowerCase()}_paise`);
        if (!target) throw new Error('Select a supported table and tax head from this working. No adjustment was created.');
        const calculated = target.calculated_paise;
        const delta = integer(data.get('delta'), 'CA adjustment', true);
        if (calculated !== null && !Number.isSafeInteger(calculated + delta)) throw new Error('Final adjusted amount exceeds safe integer range.');
        return gstMonthlyReportService.addAdjustment({ business_id: businessId, report_run_id: null, tax_period_key: current.period.periodKey,
          report_type: 'GSTR3B_DRAFT', table_code: table, tax_head: head, original_paise: calculated, adjustment_paise: delta,
          adjusted_paise: calculated === null ? null : calculated + delta, reason: String(data.get('reason')), note: String(data.get('note')),
          supporting_attachment_id: String(data.get('attachmentId') ?? '').trim() || null, source: 'USER', actor_id: null, device_id: active.deviceId ?? '',
        });
      })}><fieldset disabled={writeBlocked || !active.deviceId} className="grid sm:grid-cols-3 gap-3 border rounded p-3"><legend>Add immutable CA adjustment for {current.period.periodKey}</legend>
        <label>Table code<select className={control} name="table" value={selectedAdjustmentTable} onChange={e => setAdjustmentTable(e.target.value)}>{adjustmentTables.map(t => <option key={t}>{t}</option>)}</select></label>
        <label>Adjustment tax head<select key={selectedAdjustmentTable} className={control} name="head">{adjustmentHeads.map(h => <option key={h}>{h}</option>)}</select></label>
        {!adjustmentTables.length && <p>No supported tax-head adjustment fields are available in this working.</p>}
        {field('Signed adjustment (integer paise)', 'delta', '', 'number', true)}{field('Adjustment reason', 'reason', '', 'text', true)}{field('CA note', 'note')}
        {field('Supporting attachment ID (optional, existing business attachment)', 'attachmentId')}
        <button className={button} disabled={!adjustmentTables.length}>Add CA adjustment</button>
      </fieldset></form>
    </>}

    {current && tab === 'Validation Issues' && <>
      <Table title="Validation and exceptions" headers={['Severity', 'Code', 'Source', 'Field', 'Message', 'Recommended correction']} rows={current.issues.map(i => [i.severity, i.code, <button type="button" className={linkButton} onClick={() => drill([i.source_entity_id], i.code)}>{i.document_number ?? i.source_entity_id}</button>, i.field, i.message, i.recommended_correction])} />
      <Table title="Source reconciliation (integer paise variance)" headers={['Code', 'Status', 'Source documents', 'Section documents', 'Detail rows', 'Parties', ...amounts.map(a => `${a[1]} variance`), 'Message']} rows={current.reconciliations.map(r => [r.code, r.status, ...[r.source_document_count, r.section_document_count, r.detail_row_count, r.party_count].map(n => metric(n, r.source_entity_ids, r.code, current, false)), ...amountCells(r.variance, r.source_entity_ids, 'Variance'), r.message])} />
    </>}

    {tab === 'Source Transactions' && <>
      <h2 ref={sourceHeading} tabIndex={-1} className="font-semibold">Source transactions{filter ? `: ${filter.label}` : ''}</h2>
      {filter && <button type="button" className={button} onClick={() => setFilter(null)}>Clear source filter</button>}
      <Table title="Contributing documents" headers={['Source', 'Type', 'Date', 'Party', 'GSTIN', 'Classification', 'POS', 'Inclusion', ...amounts.map(a => a[1]), 'Edit']} rows={(filter?.allMonths ? allDocuments : documents).filter(d => !filter || filter.ids.includes(d.source_entity_id)).map(d => [sourceLink(d.source_entity_type, d.source_entity_id, d.document_number), d.source_entity_type, d.document_date, d.party_name, d.party_gstin, d.classification, d.place_of_supply, d.included ? 'Included' : d.exclusion_reason, ...amountCells(d, [d.source_entity_id], d.document_number, visibleResults.find(r => r.period.periodKey === d.tax_period_key)), <button type="button" className={button} disabled={writeBlocked} onClick={() => editMetadata(d)}>Edit classification</button>])} />
      <Table title="Historical ITC source references (not current purchase-book totals)" headers={['Source', 'Date', 'IGST', 'CGST', 'SGST / UTGST', 'Cess']} rows={historicalReferences.filter(p => !filter || filter.ids.includes(p.id)).map(p => [sourceLink('ITC_SOURCE_PURCHASE', p.id, p.bill_number), p.bill_date, ...[p.igst_paise, p.cgst_paise, p.sgst_paise, p.cess_paise].map(n => metric(n, [p.id], 'Historical source tax'))])} />
      <Table title="ITC review history" headers={['Entry ID', 'Source', 'Period', 'Head', 'Status', 'Reason', 'Related prior entry']} rows={ledger.filter(l => !filter || filter.ids.includes(l.id) || filter.ids.includes(l.source_entity_id)).map(l => [l.id, sourceLink(l.source_entity_type, l.source_entity_id, l.source_entity_id), l.tax_period_key, l.tax_head, l.status, l.reason, l.related_prior_entry_id])} />
      <Table title="Contributing source manifest / audit evidence" headers={['Type', 'ID', 'Version', 'Effect', 'Evidence']} rows={(filter?.allMonths ? visibleResults.flatMap(r => r.sourceManifest) : current?.sourceManifest ?? []).filter(m => !filter || filter.ids.includes(m.entity_id)).map(m => [m.entity_type, sourceLink(m.entity_type, m.entity_id, m.entity_id), m.entity_version, m.report_effect, <details><summary>View source evidence</summary><pre className="whitespace-pre-wrap max-w-lg">{JSON.stringify(m.content, null, 2)}</pre></details>])} />
      {metadata && <form onSubmit={e => submit(e, () => gstMonthlyReportService.saveDocumentMetadata({ ...metadata, classification_source: 'USER_CAPTURED' }))}><fieldset disabled={writeBlocked} className="grid sm:grid-cols-3 gap-3 border rounded p-3"><legend>Explicit classification for {metadata.source_entity_id}</legend>
        <p className="sm:col-span-3">Unknown fields remain unset. A zero tax rate does not imply nil-rated, exempt or non-GST. Saved changes require recalculation.</p>
        <label>Document type<select className={control} value={metadata.document_type} onChange={e => setMetadata({ ...metadata, document_type: e.target.value as typeof metadata.document_type })}>{['TAX_INVOICE', 'BILL_OF_SUPPLY', 'CREDIT_NOTE', 'DEBIT_NOTE', 'RECEIPT_VOUCHER', 'REFUND_VOUCHER', 'ADVANCE_ADJUSTMENT', 'IMPORT_BILL_OF_ENTRY'].map(s => <option key={s}>{s}</option>)}</select></label>
        <label>Supply / explicit zero-tax category<select className={control} value={metadata.supply_category ?? ''} onChange={e => setMetadata({ ...metadata, supply_category: e.target.value as typeof metadata.supply_category || null })}><option value="">Unknown</option>{['DOMESTIC', 'EXPORT_WITH_PAYMENT', 'EXPORT_WITHOUT_PAYMENT', 'SEZ_WITH_PAYMENT', 'SEZ_WITHOUT_PAYMENT', 'DEEMED_EXPORT', 'NIL_RATED', 'EXEMPT', 'NON_GST'].map(s => <option key={s}>{s}</option>)}</select></label>
        <label>Recipient category<select className={control} value={metadata.recipient_category ?? ''} onChange={e => setMetadata({ ...metadata, recipient_category: e.target.value as typeof metadata.recipient_category || null })}><option value="">Unknown</option>{['REGISTERED', 'UNREGISTERED', 'COMPOSITION', 'UIN', 'SEZ', 'OVERSEAS', 'UNKNOWN'].map(s => <option key={s}>{s}</option>)}</select></label>
        {([
          ['place_of_supply_state_code', 'POS state code', 'text'], ['shipping_bill_number', 'Shipping bill number', 'text'], ['shipping_bill_date', 'Shipping bill date', 'date'], ['port_code', 'Port code', 'text'],
          ['ecommerce_operator_gstin', 'E-commerce operator GSTIN', 'text'], ['ecommerce_reporting_type', 'E-commerce reporting type', 'text'],
          ['original_document_number', 'Original document number', 'text'], ['original_document_date', 'Original document date', 'date'], ['original_return_period', 'Original reporting month', 'month'],
          ['reporting_period_override', 'Reporting month override', 'month'], ['original_source_entity_id', 'Original source ID', 'text'],
        ] as const).map(([key, label, type]) => <label key={key}>{label}<input className={control} type={type} value={metadata[key] ?? ''} onChange={e => setMetadata({ ...metadata, [key]: e.target.value || null })} /></label>)}
        <label>Amendment kind<select className={control} value={metadata.amendment_kind ?? ''} onChange={e => setMetadata({ ...metadata, amendment_kind: e.target.value || null })}><option value="">None / unknown</option>{['INTERNAL_UNFILED_EDIT', 'SAME_PERIOD_GSTR1A', 'OLDER_PERIOD_AMENDMENT'].map(s => <option key={s}>{s}</option>)}</select></label>
        <label>Original source type<select className={control} value={metadata.original_source_entity_type ?? ''} onChange={e => setMetadata({ ...metadata, original_source_entity_type: e.target.value as typeof metadata.original_source_entity_type || null })}><option value="">Unknown</option>{['INVOICE', 'SALES_RETURN', 'PURCHASE', 'PURCHASE_RETURN', 'EXPENSE', 'ADVANCE', 'GST_NOTE'].map(s => <option key={s}>{s}</option>)}</select></label>
        <label>Previously reported integer-paise values (JSON)<textarea className={control} value={metadata.previously_reported_values_json ?? ''} onChange={e => setMetadata({ ...metadata, previously_reported_values_json: e.target.value || null })} /></label>
        {([['reverse_charge', 'Reverse charge'], ['section_52_tcs', 'Section 52 TCS'], ['tax_on_advance_applicable', 'Tax on advance applicable']] as const).map(([key, label]) => <label key={key}>{label}<select className={control} value={metadata[key] ?? ''} onChange={e => setMetadata({ ...metadata, [key]: e.target.value === '' ? null : Number(e.target.value) as 0 | 1 })}><option value="">Unknown</option><option value="0">No</option><option value="1">Yes</option></select></label>)}
        <label>Section 9(5) role<select className={control} value={metadata.section_9_5_role ?? ''} onChange={e => setMetadata({ ...metadata, section_9_5_role: e.target.value as typeof metadata.section_9_5_role || null })}><option value="">Unknown</option>{['NONE', 'SUPPLIER', 'ECO'].map(s => <option key={s}>{s}</option>)}</select></label>
        <button className={button}>Save source classification</button><button type="button" className={button} onClick={() => setMetadata(null)}>Cancel classification edit</button>
      </fieldset></form>}
    </>}

    {current && <fieldset disabled={writeBlocked || current.status !== 'READY_FOR_CA_REVIEW'} className="flex flex-wrap gap-2"><legend>Save current month working snapshot</legend>
      {(['REVIEWED', 'FINALIZED_WORKING'] as const).map(status => <button type="button" className={button} key={status} onClick={() => {
        if (immutable) return;
        if (!window.confirm(`Save ${current.period.periodKey} as ${status}? This snapshot is immutable and cannot be edited or undone. Later recalculation creates a new run. This is not filing.`)) return;
        void run(async () => { await gstMonthlyReportService.saveReport(current, status); setWorkspace(await gstMonthlyReportService.loadWorkspace(businessId)); setMessage(`Saved ${status} snapshot. No return has been filed.`); });
      }}>{status === 'REVIEWED' ? 'Save reviewed snapshot' : 'Finalize working snapshot'}</button>)}
    </fieldset>}

    {tab === 'Saved Reviews / Audit' && <Table title="Saved immutable workings" headers={['Period', 'Status', 'GSTIN', 'Rules', 'Generated', 'Reviewed', 'Finalized', 'Source comparison', 'Details']} rows={(workspace?.savedRuns ?? []).map(saved => {
      const live = results.find(r => r.period.periodKey === saved.tax_period_key);
      return [saved.tax_period_key, saved.status, saved.gstin_snapshot, saved.rule_set_version, saved.generated_at, saved.reviewed_at, saved.finalized_at,
        live && !stale ? live.sourceDataHash === saved.source_data_hash ? 'Unchanged source hash' : 'STALE: sources changed; recalculate and create a new snapshot' : 'Not checked: calculate this month',
        <div className="space-y-2"><button type="button" className={button} disabled={busy} onClick={() => void run(async () => { const loaded = await gstMonthlyReportService.loadSavedReport(businessId, saved.id); setSavedResult(loaded); setMetadata(null); setFilter(null); setTab('Monthly Overview'); setMessage('Opened the original immutable snapshot, not a recalculation.'); })}>Open saved snapshot {saved.id}</button><details><summary>Snapshot details</summary><dl className="whitespace-normal max-w-lg"><dt>Run ID</dt><dd>{saved.id}</dd><dt>Source hash</dt><dd className="break-all">{saved.source_data_hash}</dd><dt>Supersedes</dt><dd>{saved.supersedes_report_run_id ?? 'None'}</dd><dt>Canonical attachment ID</dt><dd>{saved.source_artifact_attachment_id}</dd><dt>Totals (integer paise)</dt><dd><pre className="whitespace-pre-wrap">{saved.totals_json}</pre></dd></dl></details></div>];
    })} />}
    {tab === 'Saved Reviews / Audit' && workspace?.auditLog && <Table title="GST audit log" headers={['Time', 'Action', 'Entity', 'Actor', 'Evidence']} rows={workspace.auditLog.map(a => [a.at, a.action, `${a.entity_type}:${a.entity_id}`, a.actor, <details><summary>Before / after</summary><pre className="whitespace-pre-wrap max-w-lg">{JSON.stringify({ before: a.before, after: a.after }, null, 2)}</pre></details>])} />}
    {!visibleResults.length && tab !== 'Saved Reviews / Audit' && <p>Select months and calculate to view their independent workings.</p>}
  </div>;
}
