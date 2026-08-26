import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ulid } from 'ulid';
import { db } from '../../db';
import type { Business, Customer, Item } from '../../db/types';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import { InvoiceService, type CreateInvoiceLineInput } from '../../domain/InvoiceService';
import { allocateInvoiceNumber } from '../../domain/invoiceNumbering';
import { PaymentService } from '../../domain/PaymentService';
import { AdvanceService } from '../../domain/AdvanceService';
import { bankersRound, isInterstate, roundOffToNearestRupee, splitTax } from '../../domain/gst';
import type { Advance } from '../../db/types';

interface LineDraft {
  key: string;
  item_id: string;
  description: string;
  hsn: string;
  qtyStr: string;
  unitPriceStr: string;
  taxRatePctStr: string;
  warehouse_id: string;
}

function emptyLine(): LineDraft {
  return {
    key: ulid(),
    item_id: '',
    description: '',
    hsn: '',
    qtyStr: '1',
    unitPriceStr: '',
    taxRatePctStr: '18',
    warehouse_id: '',
  };
}

function toMicros(qtyStr: string): number {
  const n = Number(qtyStr);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1_000_000);
}

function toPaise(rupeeStr: string): number {
  const n = Number(rupeeStr);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export default function InvoiceForm() {
  const navigate = useNavigate();
  const { id: editingId } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const initialCustomerId = searchParams.get('customer') ?? '';
  const { businessId, deviceId, loading } = useActiveBusiness();
  const [business, setBusiness] = useState<Business | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [warehouseOptions, setWarehouseOptions] = useState<
    { id: string; name: string }[]
  >([]);
  const [defaultWarehouseId, setDefaultWarehouseId] = useState<string>('');

  // Form state
  const [customerId, setCustomerId] = useState<string>(initialCustomerId);
  const [invoiceDate, setInvoiceDate] = useState<string>(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [invoiceTime, setInvoiceTime] = useState<string>(() => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });
  const [dueDate, setDueDate] = useState<string>('');
  const [invoiceNumberOverride, setInvoiceNumberOverride] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [payments, setPayments] = useState<{
    cashStr: string;
    cardStr: string;
    upiStr: string;
    creditStr: string;
  }>({ cashStr: '0', cardStr: '0', upiStr: '0', creditStr: '0' });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [hydratedFromId, setHydratedFromId] = useState<string | null>(null);
  const [originalInvoiceNumber, setOriginalInvoiceNumber] = useState<string | null>(
    null,
  );
  // Round-off treatment. 'auto' snaps total to nearest ₹1 via banker's rounding;
  // 'none' keeps the exact pre-round total; 'manual' lets the shopkeeper key in
  // a specific ± amount (in rupees) — handy when you're rounding to a customer-
  // pleasing ₹5 or ₹10 rather than ₹1. Default 'auto' matches long-standing POS
  // behaviour so cash tenders stay whole-rupee.
  const [roundOffMode, setRoundOffMode] = useState<'auto' | 'none' | 'manual'>('auto');
  const [manualRoundOffStr, setManualRoundOffStr] = useState<string>('0');

  const svc = useMemo(() => new InvoiceService(), []);
  const paymentSvc = useMemo(() => new PaymentService(), []);
  const advanceSvc = useMemo(() => new AdvanceService(db), []);
  const [openAdvances, setOpenAdvances] = useState<Advance[]>([]);
  const [advanceAllocations, setAdvanceAllocations] = useState<Record<string, string>>({});

  // Load reference data
  useEffect(() => {
    if (!businessId) return;
    (async () => {
      const [biz, cs, its, whs] = await Promise.all([
        db.businesses.get(businessId),
        db.customers
          .where('business_id')
          .equals(businessId)
          .filter((c) => c.active === 1)
          .sortBy('name'),
        db.items
          .where('business_id')
          .equals(businessId)
          .filter((i) => i.active === 1)
          .sortBy('name'),
        db.warehouses
          .where('business_id')
          .equals(businessId)
          .filter((w) => w.active === 1)
          .sortBy('name'),
      ]);
      setBusiness(biz ?? null);
      setCustomers(cs);
      setItems(its);
      setWarehouseOptions(whs.map((w) => ({ id: w.id, name: w.name })));
      const def = whs.find((w) => w.is_default === 1) ?? whs[0];
      setDefaultWarehouseId(def?.id ?? '');
    })();
  }, [businessId]);

  // Hydrate from an existing invoice when editing
  useEffect(() => {
    if (!editingId || hydratedFromId === editingId) return;
    (async () => {
      const inv = await db.invoices.get(editingId);
      if (!inv) return;
      const invLines = await db.invoice_lines
        .where('invoice_id')
        .equals(editingId)
        .sortBy('line_no');
      setCustomerId(inv.customer_id);
      setInvoiceDate(inv.invoice_date);
      const t = new Date(inv.created_at);
      if (!Number.isNaN(t.getTime())) {
        setInvoiceTime(
          `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`,
        );
      }
      setDueDate(inv.due_date ?? '');
      setNotes(inv.notes);
      setTerms(inv.terms);
      setOriginalInvoiceNumber(inv.invoice_number);
      setRoundOffMode(inv.round_off_mode ?? 'auto');
      setManualRoundOffStr(((inv.round_off_paise ?? 0) / 100).toString());
      setLines(
        invLines.map((l) => ({
          key: l.id,
          item_id: l.item_id,
          description: l.description,
          hsn: l.hsn,
          qtyStr: (l.qty_micros / 1_000_000).toString(),
          unitPriceStr: (l.unit_price_paise / 100).toString(),
          taxRatePctStr: (l.tax_rate_bps / 100).toString(),
          warehouse_id: l.warehouse_id,
        })),
      );
      setHydratedFromId(editingId);
    })();
  }, [editingId, hydratedFromId]);

  const customer = useMemo(
    () => customers.find((c) => c.id === customerId) ?? null,
    [customers, customerId],
  );

  // On customer change, load their unapplied advances (customer-only, editing skipped).
  useEffect(() => {
    setAdvanceAllocations({});
    if (!businessId || !customerId || editingId) {
      setOpenAdvances([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const list = await advanceSvc.listByParty(businessId, 'customer', customerId);
      if (cancelled) return;
      setOpenAdvances(list.filter((a) => a.remaining_paise > 0));
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId, customerId, editingId, advanceSvc]);

  const interstate = useMemo(() => {
    if (!business || !customer) return false;
    return isInterstate(business.state_code, customer.state_code);
  }, [business, customer]);

  // Line arithmetic
  const computedLines = useMemo(() => {
    return lines.map((l) => {
      const qtyMicros = toMicros(l.qtyStr);
      const unitPaise = toPaise(l.unitPriceStr);
      const taxable = bankersRound((unitPaise * qtyMicros) / 1_000_000);
      const rateBps = Math.round(Number(l.taxRatePctStr || '0') * 100);
      const split = splitTax(taxable, rateBps, interstate);
      const lineTotal =
        taxable + split.cgst_paise + split.sgst_paise + split.igst_paise;
      return { l, qtyMicros, unitPaise, taxable, rateBps, split, lineTotal };
    });
  }, [lines, interstate]);

  const totals = useMemo(() => {
    const base = computedLines.reduce(
      (acc, c) => ({
        taxable: acc.taxable + c.taxable,
        cgst: acc.cgst + c.split.cgst_paise,
        sgst: acc.sgst + c.split.sgst_paise,
        igst: acc.igst + c.split.igst_paise,
        preRoundTotal: acc.preRoundTotal + c.lineTotal,
      }),
      { taxable: 0, cgst: 0, sgst: 0, igst: 0, preRoundTotal: 0 },
    );
    let roundOff = 0;
    if (roundOffMode === 'auto') {
      roundOff = roundOffToNearestRupee(base.preRoundTotal).round_off_paise;
    } else if (roundOffMode === 'manual') {
      roundOff = toPaise(manualRoundOffStr);
    }
    return { ...base, roundOff, total: base.preRoundTotal + roundOff };
  }, [computedLines, roundOffMode, manualRoundOffStr]);

  function addLine() {
    setLines((rows) => [...rows, { ...emptyLine(), warehouse_id: defaultWarehouseId }]);
  }

  function removeLine(key: string) {
    setLines((rows) => (rows.length === 1 ? rows : rows.filter((r) => r.key !== key)));
  }

  function setLineField<K extends keyof LineDraft>(
    key: string,
    field: K,
    value: LineDraft[K],
  ) {
    setLines((rows) =>
      rows.map((r) => (r.key === key ? { ...r, [field]: value } : r)),
    );
  }

  function pickItem(key: string, itemId: string) {
    const it = items.find((i) => i.id === itemId);
    if (!it) {
      setLineField(key, 'item_id', itemId);
      return;
    }
    setLines((rows) =>
      rows.map((r) =>
        r.key === key
          ? {
              ...r,
              item_id: itemId,
              description: it.description,
              hsn: it.hsn,
              unitPriceStr: (it.sale_price_paise / 100).toString(),
              taxRatePctStr: (it.tax_rate_bps / 100).toString(),
              warehouse_id: r.warehouse_id || defaultWarehouseId,
            }
          : r,
      ),
    );
  }

  const save = useCallback(async (opts?: { thenPrint?: boolean }) => {
    setSaveError(null);
    if (!businessId || !deviceId || !business) return;
    if (!customerId) {
      setSaveError('Pick a customer.');
      return;
    }
    if (!customer) {
      setSaveError('Customer not found.');
      return;
    }
    if (defaultWarehouseId === '' && warehouseOptions.length === 0) {
      setSaveError('No warehouse configured. Add one under Inventory → Warehouses.');
      return;
    }
    const goodLines = computedLines.filter(
      (c) => c.qtyMicros > 0 && c.unitPaise > 0 && c.l.item_id,
    );
    if (goodLines.length === 0) {
      setSaveError('Add at least one line with item, qty, and price.');
      return;
    }

    setSaving(true);
    try {
      const invLines: CreateInvoiceLineInput[] = goodLines.map((c) => ({
        item_id: c.l.item_id,
        description: c.l.description,
        hsn: c.l.hsn,
        warehouse_id: c.l.warehouse_id || defaultWarehouseId,
        qty_micros: c.qtyMicros,
        unit_price_paise: c.unitPaise,
        taxable_paise: c.taxable,
        tax_rate_bps: c.rateBps,
        cgst_paise: c.split.cgst_paise,
        sgst_paise: c.split.sgst_paise,
        igst_paise: c.split.igst_paise,
        line_total_paise: c.lineTotal,
      }));

      const commonInput = {
        business_id: businessId,
        device_id: deviceId,
        invoice_date: invoiceDate,
        due_date: dueDate || undefined,
        customer_id: customerId,
        customer_state_code: customer.state_code,
        place_of_supply: customer.state_code,
        is_interstate: interstate,
        financial_year: business.current_financial_year,
        lines: invLines,
        round_off_mode: roundOffMode,
        round_off_paise: roundOffMode === 'manual' ? toPaise(manualRoundOffStr) : 0,
        notes,
        terms,
      };

      let saved;
      if (editingId) {
        // §3: pass the (possibly edited) invoice number through. If it matches
        // the original, updateInvoice keeps the existing number; otherwise it
        // validates uniqueness and writes an audit row.
        saved = await svc.updateInvoice(editingId, {
          ...commonInput,
          invoice_number: originalInvoiceNumber ?? undefined,
        });
      } else {
        const invoiceNumber =
          invoiceNumberOverride.trim() || (await allocateInvoiceNumber(db, businessId));
        saved = await svc.createInvoice({
          ...commonInput,
          invoice_number: invoiceNumber,
        });

        const cashPaise = toPaise(payments.cashStr);
        const cardPaise = toPaise(payments.cardStr);
        const upiPaise = toPaise(payments.upiStr);
        if (cashPaise > 0 || cardPaise > 0 || upiPaise > 0) {
          await paymentSvc.postInvoicePayments({
            business_id: businessId,
            device_id: deviceId,
            invoice_id: saved.id,
            payment_date: invoiceDate,
            split: {
              cash_paise: cashPaise,
              card_paise: cardPaise,
              upi_paise: upiPaise,
              credit_paise: toPaise(payments.creditStr),
            },
          });
        }

        // Apply any selected advances (customer only, new invoice only).
        for (const [advId, str] of Object.entries(advanceAllocations)) {
          const paise = Math.round(Number(str) * 100);
          if (!Number.isFinite(paise) || paise <= 0) continue;
          await advanceSvc.applyAdvance({
            business_id: businessId,
            device_id: deviceId,
            advance_id: advId,
            invoice_id: saved.id,
            amount_paise: paise,
            applied_on: invoiceDate,
          });
        }
      }
      if (opts?.thenPrint) {
        navigate(`/invoices/${saved.id}/print`);
      } else {
        navigate(`/invoices/${saved.id}`);
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [
    businessId,
    deviceId,
    business,
    customer,
    customerId,
    computedLines,
    defaultWarehouseId,
    warehouseOptions.length,
    invoiceDate,
    dueDate,
    interstate,
    notes,
    terms,
    editingId,
    invoiceNumberOverride,
    originalInvoiceNumber,
    navigate,
    svc,
    paymentSvc,
    payments,
    advanceSvc,
    advanceAllocations,
    roundOffMode,
    manualRoundOffStr,
  ]);

  if (loading) return <div className="p-6 text-fg-muted">Loading...</div>;
  if (!businessId || !business)
    return (
      <div className="p-6 text-fg-muted">
        No active business — complete onboarding first.
      </div>
    );

  return (
    <div className="p-6 flex flex-col gap-4 max-w-6xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/invoices" className="text-sm text-blue-700 hover:underline">
            ← Invoices
          </Link>
          <h1 className="text-xl font-semibold text-fg">
            {editingId ? `Edit Invoice ${originalInvoiceNumber ?? ''}` : 'New Invoice'}
          </h1>
        </div>
        <div className="text-xs text-fg-muted">
          Prefer a fast till? Use{' '}
          <Link to="/invoices/quick" className="text-blue-700 hover:underline">
            POS mode
          </Link>
        </div>
      </div>

      {editingId && (
        <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          Saving will void the original invoice and issue a new one. Change the
          Invoice # above to rename it — the change is recorded in the audit
          log. The original stays in the audit trail (marked as reversed).
        </div>
      )}

      <section className="grid grid-cols-3 gap-3 text-sm">
        <label className="flex flex-col">
          <span className="block text-[12px] text-fg-muted mb-1">Customer</span>
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className="h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">— select customer —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.phone ? ` · ${c.phone}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="block text-[12px] text-fg-muted mb-1">Invoice date & time</span>
          <div className="flex gap-2">
            <input
              type="date"
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
              className="flex-1 h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <input
              type="time"
              value={invoiceTime}
              onChange={(e) => setInvoiceTime(e.target.value)}
              className="w-28 h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
              aria-label="Invoice time"
            />
          </div>
        </label>
        <label className="flex flex-col">
          <span className="block text-[12px] text-fg-muted mb-1">Due date (optional)</span>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </label>
        <label className="flex flex-col">
          <span className="block text-[12px] text-fg-muted mb-1">
            {editingId
              ? 'Invoice # (change to rename)'
              : 'Invoice # (leave blank to auto-assign)'}
          </span>
          <input
            value={editingId ? (originalInvoiceNumber ?? '') : invoiceNumberOverride}
            onChange={(e) => {
              if (editingId) {
                setOriginalInvoiceNumber(e.target.value);
              } else {
                setInvoiceNumberOverride(e.target.value);
              }
            }}
            placeholder={`${business.invoice_prefix || 'INV'}-000123`}
            className="h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </label>
        <div className="flex flex-col justify-end text-xs text-fg-muted">
          {customer && (
            <>
              <span>Buyer state: {customer.state || '—'} ({customer.state_code || '—'})</span>
              <span>Business state: {business.state} ({business.state_code})</span>
              <span>
                Supply:{' '}
                <strong>{interstate ? 'Interstate (IGST)' : 'Intrastate (CGST + SGST)'}</strong>
              </span>
            </>
          )}
        </div>
      </section>

      {!editingId && openAdvances.length > 0 && (
        <section className="border border-emerald-200 bg-emerald-50/40 rounded p-3 text-sm">
          <div className="font-medium mb-2 flex items-center justify-between">
            <span>Apply existing advance from this customer</span>
            <span className="text-xs text-fg-muted">
              {openAdvances.length} open · total remaining ₹
              {(
                openAdvances.reduce((s, a) => s + a.remaining_paise, 0) / 100
              ).toFixed(2)}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-1.5">
            {openAdvances.map((adv) => {
              const remaining = adv.remaining_paise / 100;
              return (
                <div
                  key={adv.id}
                  className="flex items-center gap-3 border border-emerald-200 bg-white rounded px-2 py-1.5"
                >
                  <div className="flex-1 flex flex-col">
                    <span className="text-xs">
                      <span className="font-mono">{adv.advance_number}</span>
                      <span className="text-fg-muted"> · {adv.advance_date}</span>
                      <span className="text-fg-muted"> · {adv.method}</span>
                    </span>
                    <span className="text-xs text-fg-muted">
                      Remaining ₹{remaining.toFixed(2)} of ₹
                      {(adv.amount_paise / 100).toFixed(2)}
                    </span>
                  </div>
                  <label className="flex items-center gap-1 text-xs">
                    <span className="text-fg-muted">Apply ₹</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max={remaining}
                      value={advanceAllocations[adv.id] ?? ''}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setAdvanceAllocations((prev) => {
                          const next = { ...prev };
                          if (raw === '' || Number(raw) === 0) delete next[adv.id];
                          else next[adv.id] = raw;
                          return next;
                        });
                      }}
                      placeholder="0.00"
                      className="w-28 h-7 rounded-md border border-border bg-surface px-2 text-[12px] text-fg text-right focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setAdvanceAllocations((prev) => ({
                          ...prev,
                          [adv.id]: remaining.toFixed(2),
                        }))
                      }
                      className="text-blue-700 hover:underline"
                    >
                      max
                    </button>
                  </label>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="border border-border rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-app text-xs uppercase text-fg-muted">
            <tr>
              <th className="text-left px-2 py-2 w-8">#</th>
              <th className="text-left px-2 py-2">Item</th>
              <th className="text-left px-2 py-2 w-24">HSN</th>
              <th className="text-left px-2 py-2 w-40">Warehouse</th>
              <th className="text-right px-2 py-2 w-20">Qty</th>
              <th className="text-right px-2 py-2 w-28">Unit ₹</th>
              <th className="text-right px-2 py-2 w-20">GST %</th>
              <th className="text-right px-2 py-2 w-28">Taxable</th>
              <th className="text-right px-2 py-2 w-28">Tax</th>
              <th className="text-right px-2 py-2 w-28">Total</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, idx) => {
              const c = computedLines[idx];
              return (
                <tr key={l.key} className="border-t border-border align-top">
                  <td className="px-2 py-2 text-fg-muted">{idx + 1}</td>
                  <td className="px-2 py-2">
                    <select
                      value={l.item_id}
                      onChange={(e) => pickItem(l.key, e.target.value)}
                      className="w-full h-7 rounded-md border border-border bg-surface px-2 text-[12px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      <option value="">— pick item —</option>
                      {items.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name} ({it.sku})
                        </option>
                      ))}
                    </select>
                    <input
                      value={l.description}
                      onChange={(e) => setLineField(l.key, 'description', e.target.value)}
                      placeholder="Line description (optional)"
                      className="mt-1 w-full h-7 rounded-md border border-border bg-surface px-2 text-[12px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input
                      value={l.hsn}
                      onChange={(e) => setLineField(l.key, 'hsn', e.target.value)}
                      className="w-full h-7 rounded-md border border-border bg-surface px-2 text-[12px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <select
                      value={l.warehouse_id}
                      onChange={(e) => setLineField(l.key, 'warehouse_id', e.target.value)}
                      className="w-full h-7 rounded-md border border-border bg-surface px-2 text-[12px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      {warehouseOptions.length === 0 && <option value="">—</option>}
                      {warehouseOptions.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <input
                      type="number"
                      step="0.001"
                      min="0"
                      value={l.qtyStr}
                      onChange={(e) => setLineField(l.key, 'qtyStr', e.target.value)}
                      className="w-full h-7 rounded-md border border-border bg-surface px-2 text-[12px] text-fg text-right focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={l.unitPriceStr}
                      onChange={(e) => setLineField(l.key, 'unitPriceStr', e.target.value)}
                      className="w-full h-7 rounded-md border border-border bg-surface px-2 text-[12px] text-fg text-right focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={l.taxRatePctStr}
                      onChange={(e) => setLineField(l.key, 'taxRatePctStr', e.target.value)}
                      className="w-full h-7 rounded-md border border-border bg-surface px-2 text-[12px] text-fg text-right focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </td>
                  <td className="px-2 py-2 text-right">₹{(c.taxable / 100).toFixed(2)}</td>
                  <td className="px-2 py-2 text-right">
                    ₹
                    {(
                      (c.split.cgst_paise + c.split.sgst_paise + c.split.igst_paise) /
                      100
                    ).toFixed(2)}
                  </td>
                  <td className="px-2 py-2 text-right font-medium">
                    ₹{(c.lineTotal / 100).toFixed(2)}
                  </td>
                  <td className="px-1 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => removeLine(l.key)}
                      disabled={lines.length === 1}
                      className="text-danger hover:opacity-80 disabled:opacity-30"
                      title="Remove line"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="border-t border-border px-3 py-2 bg-app">
          <button
            type="button"
            onClick={addLine}
            className="text-sm text-blue-700 hover:underline"
          >
            + Add line
          </button>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col">
            <span className="block text-[12px] text-fg-muted mb-1">Notes</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <label className="flex flex-col">
            <span className="block text-[12px] text-fg-muted mb-1">Terms</span>
            <textarea
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              rows={2}
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
        </div>
        <div className="text-sm">
          <div className="border border-border rounded-md p-3 space-y-1 bg-surface">
            <Row label="Taxable" paise={totals.taxable} />
            {totals.cgst > 0 && <Row label="CGST" paise={totals.cgst} />}
            {totals.sgst > 0 && <Row label="SGST" paise={totals.sgst} />}
            {totals.igst > 0 && <Row label="IGST" paise={totals.igst} />}
            {roundOffMode !== 'none' && (
              <Row label="Subtotal" paise={totals.preRoundTotal} />
            )}
            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="flex items-center gap-2">
                <span className="text-fg-muted text-[12px]">Round off</span>
                <select
                  value={roundOffMode}
                  onChange={(e) =>
                    setRoundOffMode(e.target.value as 'auto' | 'none' | 'manual')
                  }
                  className="h-7 rounded-md border border-border bg-surface px-1.5 text-[12px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                  aria-label="Round off mode"
                >
                  <option value="auto">Auto</option>
                  <option value="none">None</option>
                  <option value="manual">Manual</option>
                </select>
                {roundOffMode === 'manual' && (
                  <input
                    type="text"
                    inputMode="decimal"
                    value={manualRoundOffStr}
                    onChange={(e) => setManualRoundOffStr(e.target.value)}
                    className="w-20 h-7 rounded-md border border-border bg-surface px-2 text-[12px] text-fg text-right focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                    aria-label="Manual round off (rupees)"
                    placeholder="0.00"
                  />
                )}
              </div>
              <span className="text-[13px] text-fg tabular-nums">
                {roundOffMode === 'none' ? '—' : `₹${(totals.roundOff / 100).toFixed(2)}`}
              </span>
            </div>
            <div className="border-t border-border mt-2 pt-2">
              <Row label="Total" paise={totals.total} strong />
            </div>
          </div>
        </div>
      </div>

      <section className="border border-border rounded-md p-3 text-sm bg-surface">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-medium text-fg">Payment</h2>
          <span className="text-xs text-fg-muted">
            FULL sets the total to one method
          </span>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <PaymentInput
            label="Cash"
            value={payments.cashStr}
            onChange={(v) => setPayments((p) => ({ ...p, cashStr: v }))}
            onFull={() =>
              setPayments({
                cashStr: (totals.total / 100).toFixed(2),
                cardStr: '0',
                upiStr: '0',
                creditStr: '0',
              })
            }
          />
          <PaymentInput
            label="Card"
            value={payments.cardStr}
            onChange={(v) => setPayments((p) => ({ ...p, cardStr: v }))}
            onFull={() =>
              setPayments({
                cashStr: '0',
                cardStr: (totals.total / 100).toFixed(2),
                upiStr: '0',
                creditStr: '0',
              })
            }
          />
          <PaymentInput
            label="UPI"
            value={payments.upiStr}
            onChange={(v) => setPayments((p) => ({ ...p, upiStr: v }))}
            onFull={() =>
              setPayments({
                cashStr: '0',
                cardStr: '0',
                upiStr: (totals.total / 100).toFixed(2),
                creditStr: '0',
              })
            }
          />
          <PaymentInput
            label="Credit"
            value={payments.creditStr}
            onChange={(v) => setPayments((p) => ({ ...p, creditStr: v }))}
            onFull={() =>
              setPayments({
                cashStr: '0',
                cardStr: '0',
                upiStr: '0',
                creditStr: (totals.total / 100).toFixed(2),
              })
            }
          />
        </div>
        {(() => {
          const paidPaise =
            toPaise(payments.cashStr) +
            toPaise(payments.cardStr) +
            toPaise(payments.upiStr) +
            toPaise(payments.creditStr);
          const diff = totals.total - paidPaise;
          return (
            <div className="mt-2 flex justify-end gap-4 text-xs">
              <span className="text-fg-muted">
                Tendered: ₹{(paidPaise / 100).toFixed(2)}
              </span>
              <span
                className={
                  diff === 0
                    ? 'text-emerald-700'
                    : diff > 0
                      ? 'text-danger'
                      : 'text-amber-700'
                }
              >
                {diff === 0
                  ? 'Fully paid'
                  : diff > 0
                    ? `Balance due: ₹${(diff / 100).toFixed(2)}`
                    : `Change: ₹${(-diff / 100).toFixed(2)}`}
              </span>
            </div>
          );
        })()}
      </section>

      {saveError && (
        <div className="text-sm text-danger border border-danger/40 bg-danger-bg rounded-md px-3 py-2">
          {saveError}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="h-9 rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
        >
          {saving
            ? 'Saving…'
            : editingId
              ? 'Save changes (void & reissue)'
              : 'Create invoice'}
        </button>
        <button
          type="button"
          onClick={() => void save({ thenPrint: true })}
          disabled={saving}
          className="h-9 rounded-md bg-emerald-600 px-4 text-[13px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save & print detailed invoice'}
        </button>
        <Link
          to="/invoices"
          className="h-9 inline-flex items-center rounded-md border border-border bg-surface px-3 text-[13px] text-fg-muted hover:text-fg hover:bg-surface-hover"
        >
          Cancel
        </Link>
      </div>
    </div>
  );
}

function PaymentInput({
  label,
  value,
  onChange,
  onFull,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onFull?: () => void;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs uppercase tracking-wide text-fg-muted">
          {label}
        </span>
        {onFull && (
          <button
            type="button"
            onClick={onFull}
            className="text-[10px] font-semibold uppercase tracking-wide text-blue-700 hover:text-blue-900"
            title={`Set ${label} to full total`}
          >
            FULL
          </button>
        )}
      </div>
      <input
        type="number"
        min="0"
        step="0.01"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg text-right font-mono focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
      />
    </div>
  );
}

function Row({ label, paise, strong }: { label: string; paise: number; strong?: boolean }) {
  return (
    <div
      className={`flex justify-between ${strong ? 'font-semibold text-fg' : 'text-fg-muted'}`}
    >
      <span>{label}</span>
      <span>₹{(paise / 100).toFixed(2)}</span>
    </div>
  );
}

