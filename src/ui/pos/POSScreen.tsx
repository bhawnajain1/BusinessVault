import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useParams } from 'react-router-dom';
import { ulid } from 'ulid';
import { db } from '../../db';
import { currentBusinessId } from '../../lib/business';
import type {
  Business,
  Customer,
  Invoice,
  InvoiceLine,
  Item,
  Warehouse,
} from '../../db/types';
import { InvoiceService, type CreateInvoiceLineInput } from '../../domain/InvoiceService';
import { PaymentService } from '../../domain/PaymentService';
import { allocateInvoiceNumber } from '../../domain/invoiceNumbering';
import { splitTax, isInterstate, roundOffToNearestRupee } from '../../domain/gst';
import { fromMoney } from '../../domain/money';
import type { Money } from '../../domain/money';
import InvoicePrint, { type PrintablePayment } from './InvoicePrint';
import { log } from '../../lib/log';

type PaymentMethod = 'cash' | 'card' | 'upi' | 'credit';

interface CartLine {
  key: string;
  item: Item;
  qty: number;
  unitPricePaise: number;
  discountPaise: number;
}

interface PaymentSplit {
  cash: number;
  card: number;
  upi: number;
  credit: number;
}

interface ComputedLine {
  cart: CartLine;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  lineTotal: number;
  rateBps: number;
}

interface Totals {
  net: number;
  gst: number;
  cgst: number;
  sgst: number;
  igst: number;
  subtotalBeforeRound: number;
  roundOff: number;
  total: number;
  computed: ComputedLine[];
}

interface SavedReceipt {
  invoice: Invoice;
  lines: InvoiceLine[];
  itemsById: Map<string, Item>;
  business: Business | null;
  customer: Customer | null;
  payments: PrintablePayment[];
}

const AUTOCOMPLETE_LIMIT = 20;
const EMPTY_SPLIT: PaymentSplit = { cash: 0, card: 0, upi: 0, credit: 0 };

export default function POSScreen(): JSX.Element {
  const { id: editingInvoiceId } = useParams<{ id?: string }>();
  const business = useLiveQuery<Business | null, null>(
    async () => {
      try {
        const id = await currentBusinessId();
        return (await db.businesses.get(id)) ?? null;
      } catch {
        return null;
      }
    },
    [],
    null,
  );
  const warehouse = useLiveQuery<Warehouse | null, null>(
    async () => {
      if (!business) return null;
      const def = await db.warehouses
        .where('business_id')
        .equals(business.id)
        .filter((w) => w.is_default === 1 && w.active === 1)
        .first();
      if (def) return def;
      return (
        (await db.warehouses.where('business_id').equals(business.id).first()) ?? null
      );
    },
    [business?.id],
    null,
  );

  const [query, setQuery] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [selectedRow, setSelectedRow] = useState<number>(-1);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [hydratedFromId, setHydratedFromId] = useState<string | null>(null);
  const [invoiceDate, setInvoiceDate] = useState<string>(
    new Date().toISOString().slice(0, 10),
  );
  const [invoiceTime, setInvoiceTime] = useState<string>(() => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });
  const [split, setSplit] = useState<PaymentSplit>(EMPTY_SPLIT);
  const [activeMethod, setActiveMethod] = useState<PaymentMethod>('cash');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>(
    'idle',
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlashKey, setSavedFlashKey] = useState<number>(0);
  const [receipt, setReceipt] = useState<SavedReceipt | null>(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const paymentInputRef = useRef<HTMLInputElement | null>(null);
  const savingRef = useRef<boolean>(false);

  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  const searchResults = useLiveQuery<Item[], Item[]>(
    async () => {
      if (!business) return [];
      const q = query.trim();
      if (q.length === 0) return [];
      return searchItems(business.id, q);
    },
    [business?.id, query],
    [],
  );

  const customer = useLiveQuery<Customer | null, null>(
    async () => (customerId ? ((await db.customers.get(customerId)) ?? null) : null),
    [customerId],
    null,
  );

  const customerOptions = useLiveQuery<Customer[], Customer[]>(
    async () => {
      if (!business) return [];
      const rows = await db.customers
        .where('business_id')
        .equals(business.id)
        .filter((c) => c.active === 1)
        .toArray();
      rows.sort((a, b) => a.name.localeCompare(b.name));
      return rows;
    },
    [business?.id],
    [],
  );

  // Hydrate cart from an existing invoice when the route is /invoices/:id/edit.
  useEffect(() => {
    if (!editingInvoiceId || !business) return;
    if (hydratedFromId === editingInvoiceId) return;
    (async () => {
      const inv = await db.invoices.get(editingInvoiceId);
      if (!inv || inv.business_id !== business.id) return;
      if (inv.reversed_by_invoice_id) {
        setSaveError('This invoice has already been superseded by a newer edit and cannot be edited again.');
        setSaveState('error');
        setHydratedFromId(editingInvoiceId);
        return;
      }
      const invLines = await db.invoice_lines
        .where('invoice_id')
        .equals(editingInvoiceId)
        .toArray();
      invLines.sort((a, b) => a.line_no - b.line_no);
      const itemIds = Array.from(new Set(invLines.map((l) => l.item_id)));
      const itemRows = await db.items.bulkGet(itemIds);
      const itemsById = new Map<string, Item>();
      itemRows.forEach((it) => {
        if (it) itemsById.set(it.id, it);
      });
      const nextCart: CartLine[] = invLines
        .map((l) => {
          const it = itemsById.get(l.item_id);
          if (!it) return null;
          return {
            key: ulid(),
            item: it,
            qty: l.qty_micros / 1_000_000,
            unitPricePaise: l.unit_price_paise,
            discountPaise: l.discount_paise,
          } satisfies CartLine;
        })
        .filter((x): x is CartLine => x !== null);
      setCart(nextCart);
      setCustomerId(inv.customer_id);
      setInvoiceDate(inv.invoice_date);
      const t = new Date(inv.created_at);
      if (!Number.isNaN(t.getTime())) {
        setInvoiceTime(
          `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`,
        );
      }
      setHydratedFromId(editingInvoiceId);
    })();
  }, [editingInvoiceId, business, hydratedFromId]);

  const totals = useMemo<Totals>(
    () => computeTotals(cart, business, customer, warehouse),
    [cart, business, customer, warehouse],
  );

  const paidSum = split.cash + split.card + split.upi + split.credit;
  const changeDue = paidSum - totals.total;

  const addItem = useCallback((item: Item, qty: number = 1) => {
    setCart((prev) => {
      const idx = prev.findIndex((c) => c.item.id === item.id);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = { ...next[idx], qty: next[idx].qty + qty };
        return next;
      }
      return [
        ...prev,
        {
          key: ulid(),
          item,
          qty,
          unitPricePaise: item.sale_price_paise,
          discountPaise: 0,
        },
      ];
    });
    setQuery('');
    setSelectedRow(-1);
    searchInputRef.current?.focus();
  }, []);

  const removeLine = useCallback((key: string) => {
    setCart((prev) => prev.filter((c) => c.key !== key));
  }, []);

  const updateLine = useCallback((key: string, patch: Partial<CartLine>) => {
    setCart((prev) =>
      prev.map((c) => (c.key === key ? { ...c, ...patch } : c)),
    );
  }, []);

  const clearAll = useCallback(() => {
    setCart([]);
    setSplit(EMPTY_SPLIT);
    setActiveMethod('cash');
    setCustomerId(null);
    setQuery('');
    setSelectedRow(-1);
    setSaveState('idle');
    setSaveError(null);
    setInvoiceDate(new Date().toISOString().slice(0, 10));
    setHydratedFromId(null);
    searchInputRef.current?.focus();
  }, []);

  const applyKeypad = useCallback((ch: string) => {
    setSplit((prev) => {
      const cur = prev[activeMethod];
      if (ch === 'C') return { ...prev, [activeMethod]: 0 };
      if (ch === '⌫') {
        const s = Math.floor(cur / 10);
        return { ...prev, [activeMethod]: s };
      }
      if (ch === 'FULL') {
        // fill remaining balance on active method
        const remaining = Math.max(0, totals.total - (paidSum - cur));
        return { ...prev, [activeMethod]: remaining };
      }
      if (!/^[0-9]$/.test(ch)) return prev;
      const next = cur * 10 + Number(ch);
      if (next > Number.MAX_SAFE_INTEGER / 10) return prev;
      return { ...prev, [activeMethod]: next };
    });
  }, [activeMethod, paidSum, totals.total]);

  const save = useCallback(async () => {
    if (savingRef.current) return;
    if (!business || !warehouse) {
      setSaveError('Business or warehouse not configured');
      setSaveState('error');
      return;
    }
    if (cart.length === 0) {
      setSaveError('Cart is empty');
      setSaveState('error');
      return;
    }
    // If no explicit split provided, default the total to cash.
    const effectiveSplit: PaymentSplit =
      paidSum === 0
        ? { ...EMPTY_SPLIT, [activeMethod]: totals.total }
        : split;
    const effectivePaid =
      effectiveSplit.cash + effectiveSplit.card + effectiveSplit.upi + effectiveSplit.credit;
    if (effectivePaid < totals.total) {
      setSaveError(
        `Under-tendered: ${fromMoney((totals.total - effectivePaid) as Money)} short`,
      );
      setSaveState('error');
      return;
    }

    savingRef.current = true;
    setSaveState('saving');
    setSaveError(null);

    // Snapshot inputs before firing service call.
    const invoiceInputLines: CreateInvoiceLineInput[] = totals.computed.map((c) => ({
      item_id: c.cart.item.id,
      description: c.cart.item.name,
      hsn: c.cart.item.hsn,
      warehouse_id: warehouse.id,
      qty_micros: Math.round(c.cart.qty * 1_000_000),
      unit_price_paise: c.cart.unitPricePaise,
      discount_paise: c.cart.discountPaise,
      taxable_paise: c.taxable,
      tax_rate_bps: c.rateBps,
      cgst_paise: c.cgst,
      sgst_paise: c.sgst,
      igst_paise: c.igst,
      cess_paise: 0,
      line_total_paise: c.lineTotal,
      track_inventory: c.cart.item.track_inventory === 1,
    }));

    const walkIn = customerId ?? (await getOrCreateWalkInCustomer(business));
    const interstate = customer
      ? isInterstate(business.state_code, customer.state_code)
      : false;
    const financialYear = business.current_financial_year;
    const deviceId = await getOrCreateDeviceId(business.id);

    try {
      const svc = new InvoiceService(db);
      let invoice: Invoice;
      if (editingInvoiceId) {
        invoice = await svc.updateInvoice(editingInvoiceId, {
          business_id: business.id,
          device_id: deviceId,
          invoice_date: invoiceDate,
          customer_id: walkIn,
          customer_state_code: customer?.state_code ?? business.state_code,
          place_of_supply: customer?.state_code ?? business.state_code,
          is_interstate: interstate,
          financial_year: financialYear,
          lines: invoiceInputLines,
          round_off_mode: 'auto',
        });
      } else {
        const invoiceNumber = await allocateInvoiceNumber(db, business.id);
        invoice = await svc.createInvoice({
          business_id: business.id,
          device_id: deviceId,
          invoice_number: invoiceNumber,
          invoice_date: invoiceDate,
          customer_id: walkIn,
          customer_state_code: customer?.state_code ?? business.state_code,
          place_of_supply: customer?.state_code ?? business.state_code,
          is_interstate: interstate,
          financial_year: financialYear,
          lines: invoiceInputLines,
          round_off_mode: 'auto',
          idempotencyKey: `pos-${invoiceNumber}`,
        });
      }

      const paymentSvc = new PaymentService(db);
      if (effectiveSplit.cash > 0 || effectiveSplit.card > 0 || effectiveSplit.upi > 0) {
        log.info('pos', 'posting invoice payments', {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoice_number,
          editing: Boolean(editingInvoiceId),
          cashPaise: effectiveSplit.cash,
          cardPaise: effectiveSplit.card,
          upiPaise: effectiveSplit.upi,
        });
        await paymentSvc.postInvoicePayments({
          business_id: business.id,
          device_id: deviceId,
          invoice_id: invoice.id,
          payment_date: invoiceDate,
          split: {
            cash_paise: effectiveSplit.cash,
            card_paise: effectiveSplit.card,
            upi_paise: effectiveSplit.upi,
            credit_paise: effectiveSplit.credit,
          },
        });
      }

      // Immediate visual feedback — sub-100ms perceived save. The Drive sync
      // is queued elsewhere; the cashier does NOT wait for it (spec §8, §29).
      setSaveState('saved');
      setSavedFlashKey((k) => k + 1);

      // Build receipt for print + reset UI.
      const savedLines = await db.invoice_lines
        .where('invoice_id')
        .equals(invoice.id)
        .toArray();
      const itemsById = new Map<string, Item>(
        totals.computed.map((c) => [c.cart.item.id, c.cart.item]),
      );
      const payments: PrintablePayment[] = (
        ['cash', 'card', 'upi', 'credit'] as PaymentMethod[]
      )
        .filter((m) => effectiveSplit[m] > 0)
        .map((m) => ({ method: m, amount_paise: effectiveSplit[m] }));

      setReceipt({
        invoice,
        lines: savedLines,
        itemsById,
        business,
        customer,
        payments,
      });

      // Clear cart for next sale — cashier can keep ringing while print fires.
      setCart([]);
      setSplit(EMPTY_SPLIT);
      setCustomerId(null);
      setQuery('');
      setSelectedRow(-1);
      searchInputRef.current?.focus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg);
      setSaveState('error');
    } finally {
      savingRef.current = false;
    }
  }, [
    activeMethod,
    business,
    cart.length,
    customer,
    customerId,
    editingInvoiceId,
    invoiceDate,
    paidSum,
    split,
    totals,
    warehouse,
  ]);

  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedRow((r) => Math.min(r + 1, (searchResults?.length ?? 0) - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedRow((r) => Math.max(r - 1, -1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const results = searchResults ?? [];
      if (results.length === 0) return;
      const pick = selectedRow >= 0 ? results[selectedRow] : results[0];
      if (pick) addItem(pick, 1);
      return;
    }
    if (e.key === 'Escape') {
      setQuery('');
      setSelectedRow(-1);
    }
  };

  const onGlobalKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'F9') {
        e.preventDefault();
        void save();
        return;
      }
      if (e.key === 'F2') {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (e.key === 'F4') {
        e.preventDefault();
        clearAll();
      }
    },
    [clearAll, save],
  );

  useEffect(() => {
    window.addEventListener('keydown', onGlobalKeyDown);
    return () => window.removeEventListener('keydown', onGlobalKeyDown);
  }, [onGlobalKeyDown]);

  const setMethod = (m: PaymentMethod): void => {
    setActiveMethod(m);
    paymentInputRef.current?.focus();
  };

  return (
    <div className="h-screen w-full bg-slate-100 text-slate-900 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-slate-300 bg-white px-4 py-2 min-w-0">
        <div className="font-semibold text-lg shrink-0">
          {editingInvoiceId ? 'Edit Invoice' : 'POS'}
        </div>
        <div className="text-sm text-slate-600 truncate min-w-0 flex-1">
          {business ? business.name : 'No business'} ·{' '}
          {warehouse ? warehouse.name : 'no warehouse'}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <SavedFlash key={savedFlashKey} visible={saveState === 'saved'} />
          <div className="text-xs text-slate-500 hidden md:block">F2 search · F9 save · F4 clear</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-slate-600">Customer</span>
          <select
            value={customerId ?? ''}
            onChange={(e) => setCustomerId(e.target.value || null)}
            className="border border-slate-300 rounded px-2 py-1 bg-white min-w-0 max-w-[220px]"
          >
            <option value="">Walk-in customer</option>
            {(customerOptions ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.phone ? ` · ${c.phone}` : ''}
              </option>
            ))}
          </select>
        </label>
        <a
          href="/customers"
          className="text-xs text-blue-700 hover:underline"
          onClick={(e) => {
            // Let react-router handle it; using <a> keeps this from needing another import.
            e.preventDefault();
            window.history.pushState({}, '', '/customers');
            window.dispatchEvent(new PopStateEvent('popstate'));
          }}
        >
          + Manage customers
        </a>
        <label className="flex items-center gap-2">
          <span className="text-slate-600">Invoice date & time</span>
          <input
            type="date"
            value={invoiceDate}
            onChange={(e) => setInvoiceDate(e.target.value)}
            className="border border-slate-300 rounded px-2 py-1 bg-white"
          />
          <input
            type="time"
            value={invoiceTime}
            onChange={(e) => setInvoiceTime(e.target.value)}
            className="border border-slate-300 rounded px-2 py-1 bg-white"
            aria-label="Invoice time"
          />
        </label>
        {editingInvoiceId && (
          <div className="ml-auto text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 max-w-full basis-full sm:basis-auto sm:max-w-md">
            Editing existing invoice — the original will be superseded (kept for audit) and a new copy will be issued under the same invoice number.
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="w-[55%] min-w-0 flex flex-col border-r border-slate-300 bg-white">
          <div className="p-3 border-b border-slate-200">
            <input
              ref={searchInputRef}
              type="text"
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedRow(-1);
              }}
              onKeyDown={onSearchKeyDown}
              placeholder="Scan barcode / SKU / HSN / item name (Hindi supported)..."
              className="w-full px-3 py-2 text-lg rounded border border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
            />
            {query.trim().length > 0 ? (
              <div className="mt-2 max-h-64 overflow-auto border border-slate-200 rounded bg-white shadow-sm">
                {(searchResults ?? []).length === 0 ? (
                  <div className="px-3 py-2 text-sm text-slate-500">No matches</div>
                ) : (
                  (searchResults ?? []).map((it, i) => (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => addItem(it, 1)}
                      className={`w-full flex items-center justify-between text-left px-3 py-2 text-sm border-b border-slate-100 last:border-b-0 ${
                        i === selectedRow
                          ? 'bg-indigo-50'
                          : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{it.name}</div>
                        <div className="text-xs text-slate-500 truncate">
                          SKU {it.sku}
                          {it.barcode ? ` · BC ${it.barcode}` : ''}
                          {it.hsn ? ` · HSN ${it.hsn}` : ''}
                        </div>
                      </div>
                      <div className="text-right text-sm font-mono">
                        ₹{fromMoney(it.sale_price_paise as Money)}
                      </div>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>

          <div className="p-3 grid grid-cols-4 gap-2 border-b border-slate-200 bg-slate-50">
            {KEYPAD.map((row) =>
              row.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => applyKeypad(k)}
                  className="rounded bg-white border border-slate-300 py-3 text-lg font-semibold hover:bg-slate-100 active:bg-slate-200"
                >
                  {k}
                </button>
              )),
            )}
          </div>

          <div className="p-3 grid grid-cols-4 gap-2">
            {(['cash', 'card', 'upi', 'credit'] as PaymentMethod[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMethod(m)}
                className={`rounded py-3 border font-semibold uppercase text-sm ${
                  activeMethod === m
                    ? 'bg-indigo-600 text-white border-indigo-700'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                }`}
              >
                {m}
                <div className="text-xs font-mono mt-0.5">
                  ₹{fromMoney(split[m] as Money)}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-w-0 flex flex-col bg-white">
          <div className="flex-1 min-h-0 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 z-10">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Item</th>
                  <th className="text-right px-3 py-2 font-medium w-24">Qty</th>
                  <th className="text-right px-3 py-2 font-medium w-28">Rate</th>
                  <th className="text-right px-3 py-2 font-medium w-28">Total</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {cart.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center text-slate-400 py-16">
                      Cart is empty. Scan or type to add items.
                    </td>
                  </tr>
                ) : (
                  totals.computed.map((c) => (
                    <tr key={c.cart.key} className="border-b border-slate-100">
                      <td className="px-3 py-2">
                        <div className="font-medium">{c.cart.item.name}</div>
                        <div className="text-xs text-slate-500">
                          SKU {c.cart.item.sku}
                          {c.cart.item.hsn ? ` · HSN ${c.cart.item.hsn}` : ''}
                          {` · ${rateBpsLabel(c.rateBps)} GST`}
                        </div>
                      </td>
                      <td className="text-right px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          step="1"
                          value={c.cart.qty}
                          onChange={(e) =>
                            updateLine(c.cart.key, {
                              qty: Math.max(0, Number(e.target.value) || 0),
                            })
                          }
                          className="w-16 text-right border border-slate-200 rounded px-1 py-1 font-mono"
                        />
                      </td>
                      <td className="text-right px-3 py-2 font-mono">
                        <input
                          type="number"
                          min={0}
                          value={(c.cart.unitPricePaise / 100).toFixed(2)}
                          onChange={(e) => {
                            const rupees = Number(e.target.value) || 0;
                            updateLine(c.cart.key, {
                              unitPricePaise: Math.round(rupees * 100),
                            });
                          }}
                          className="w-24 text-right border border-slate-200 rounded px-1 py-1 font-mono"
                        />
                      </td>
                      <td className="text-right px-3 py-2 font-mono">
                        ₹{fromMoney(c.lineTotal as Money)}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => removeLine(c.cart.key)}
                          className="text-slate-400 hover:text-red-600 text-lg leading-none"
                          aria-label="Remove line"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="border-t border-slate-300 bg-slate-50 p-4">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <div className="text-slate-600">Net (taxable)</div>
              <div className="text-right font-mono">
                ₹{fromMoney(totals.net as Money)}
              </div>
              <div className="text-slate-600">
                GST{' '}
                {totals.igst > 0 ? '(IGST)' : totals.cgst + totals.sgst > 0 ? '(CGST+SGST)' : ''}
              </div>
              <div className="text-right font-mono">
                ₹{fromMoney(totals.gst as Money)}
              </div>
              <div className="text-slate-600">Round off</div>
              <div className="text-right font-mono">
                ₹{fromMoney(totals.roundOff as Money)}
              </div>
              <div className="text-slate-900 text-lg font-semibold">Total</div>
              <div className="text-right font-mono text-lg font-semibold">
                ₹{fromMoney(totals.total as Money)}
              </div>
              <div className="text-slate-600">Tendered</div>
              <div className="text-right font-mono">
                ₹{fromMoney(paidSum as Money)}
              </div>
              <div className={changeDue < 0 ? 'text-red-600' : 'text-emerald-700'}>
                {changeDue < 0 ? 'Balance due' : 'Change'}
              </div>
              <div
                className={`text-right font-mono ${
                  changeDue < 0 ? 'text-red-600' : 'text-emerald-700'
                }`}
              >
                ₹{fromMoney(Math.abs(changeDue) as Money)}
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <input
                ref={paymentInputRef}
                type="text"
                inputMode="none"
                readOnly
                value={fromMoney(split[activeMethod] as Money)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void save();
                  }
                }}
                className="flex-1 border border-slate-300 rounded px-3 py-2 font-mono text-right"
                aria-label={`${activeMethod} amount`}
              />
              <button
                type="button"
                onClick={() => void save()}
                disabled={saveState === 'saving' || cart.length === 0}
                className="rounded bg-emerald-600 text-white px-6 py-2 font-semibold hover:bg-emerald-700 disabled:opacity-50"
                title="Enter"
              >
                {saveState === 'saving' ? 'Saving...' : 'Save & Print (Enter)'}
              </button>
              <button
                type="button"
                onClick={clearAll}
                className="rounded bg-white border border-slate-300 px-4 py-2 text-slate-700 hover:bg-slate-100"
              >
                Clear
              </button>
            </div>

            {saveError ? (
              <div className="mt-2 text-sm text-red-600" role="alert">
                {saveError}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {receipt ? (
        <InvoicePrint
          business={receipt.business}
          customer={receipt.customer}
          invoice={receipt.invoice}
          lines={receipt.lines}
          itemsById={receipt.itemsById}
          payments={receipt.payments}
          autoPrint
          onAfterPrint={() => setReceipt(null)}
        />
      ) : null}
    </div>
  );
}

// ---------- helpers ----------

const KEYPAD: string[][] = [
  ['7', '8', '9', '⌫'],
  ['4', '5', '6', 'C'],
  ['1', '2', '3', 'FULL'],
  ['0', '00', '.', ''],
];

function SavedFlash(props: { visible: boolean }): JSX.Element {
  const [show, setShow] = useState(props.visible);
  useEffect(() => {
    if (!props.visible) {
      setShow(false);
      return;
    }
    setShow(true);
    const t = window.setTimeout(() => setShow(false), 1800);
    return () => window.clearTimeout(t);
  }, [props.visible]);
  if (!show) return <span className="text-xs text-slate-400">ready</span>;
  return (
    <span className="text-sm text-emerald-700 font-semibold">
      ✓ Invoice saved
    </span>
  );
}

function rateBpsLabel(bps: number): string {
  return `${(bps / 100).toFixed(0)}%`;
}

async function searchItems(businessId: string, raw: string): Promise<Item[]> {
  const q = raw.trim().toLowerCase();
  if (q.length === 0) return [];

  // 1. exact SKU / barcode / HSN hit — cheapest, most likely for barcode scans.
  const exactSku = await db.items
    .where('[business_id+sku]')
    .equals([businessId, raw.trim()])
    .first();
  if (exactSku && exactSku.active === 1) return [exactSku];

  const byBarcode = await db.items
    .where('business_id')
    .equals(businessId)
    .filter((it) => it.active === 1 && it.barcode !== null && it.barcode === raw.trim())
    .limit(AUTOCOMPLETE_LIMIT)
    .toArray();
  if (byBarcode.length > 0) return byBarcode;

  // 2. HSN prefix
  const byHsn = await db.items
    .where('[business_id+hsn]')
    .between([businessId, q], [businessId, q + '￿'])
    .filter((it) => it.active === 1)
    .limit(AUTOCOMPLETE_LIMIT)
    .toArray();
  if (byHsn.length > 0) return byHsn.slice(0, AUTOCOMPLETE_LIMIT);

  // 3. Name prefix — Dexie's between over the [business_id+name] compound index
  //    handles Unicode (Hindi) correctly because IndexedDB compares by code unit.
  //    We DO NOT lowercase the range because the stored name is not lowercase;
  //    instead we use the raw prefix and filter case-insensitively in memory.
  const byNameRange = await db.items
    .where('[business_id+name]')
    .between([businessId, raw], [businessId, raw + '￿'])
    .filter((it) => it.active === 1)
    .limit(AUTOCOMPLETE_LIMIT)
    .toArray();
  if (byNameRange.length > 0) return byNameRange;

  // 4. Fallback: case-insensitive substring — bounded by limit(200) so it
  //    stays cheap even at 100k items; browsers can chew this at ~50ms typical.
  const scanned = await db.items
    .where('business_id')
    .equals(businessId)
    .filter((it) => it.active === 1 && it.name.toLowerCase().includes(q))
    .limit(AUTOCOMPLETE_LIMIT)
    .toArray();
  return scanned;
}

function computeTotals(
  cart: CartLine[],
  business: Business | null,
  customer: Customer | null,
  _warehouse: Warehouse | null,
): Totals {
  const interstate = business && customer
    ? isInterstate(business.state_code, customer.state_code)
    : false;

  let net = 0;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  const computed: ComputedLine[] = [];

  for (const c of cart) {
    const qtyMicros = Math.round(c.qty * 1_000_000);
    const grossPaise = Math.round((c.unitPricePaise * qtyMicros) / 1_000_000);
    const taxable = Math.max(0, grossPaise - c.discountPaise);
    const rateBps = c.item.tax_rate_bps ?? 0;
    const split = splitTax(taxable, rateBps, interstate);
    const lineTotal = taxable + split.cgst_paise + split.sgst_paise + split.igst_paise;
    net += taxable;
    cgst += split.cgst_paise;
    sgst += split.sgst_paise;
    igst += split.igst_paise;
    computed.push({
      cart: c,
      taxable,
      cgst: split.cgst_paise,
      sgst: split.sgst_paise,
      igst: split.igst_paise,
      lineTotal,
      rateBps,
    });
  }

  const gst = cgst + sgst + igst;
  const subtotal = net + gst;
  const { final_paise: total, round_off_paise: roundOff } = roundOffToNearestRupee(subtotal);

  return {
    net,
    gst,
    cgst,
    sgst,
    igst,
    subtotalBeforeRound: subtotal,
    roundOff,
    total,
    computed,
  };
}

// ---- walk-in customer bootstrap (POS often has no named customer) ----
async function getOrCreateWalkInCustomer(business: Business): Promise<string> {
  const existing = await db.customers
    .where('[business_id+name]')
    .equals([business.id, 'Walk-in Customer'])
    .first();
  if (existing) return existing.id;

  const now = new Date().toISOString();
  const id = ulid();
  await db.customers.add({
    id,
    business_id: business.id,
    name: 'Walk-in Customer',
    phone: '',
    email: '',
    gstin: null,
    billing_address: '',
    shipping_address: '',
    state: business.state,
    state_code: business.state_code,
    opening_balance_paise: 0,
    credit_limit_paise: 0,
    notes: '',
    active: 1,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  });
  return id;
}

// ---- device id: cached in kv table so multi-device journal is correct ----
async function getOrCreateDeviceId(businessId: string): Promise<string> {
  const key = `device_id:${businessId}`;
  const existing = await db.kv.get(key);
  if (existing && typeof existing.value === 'string') return existing.value;
  const id = ulid();
  await db.kv.put({ key, value: id, updated_at: new Date().toISOString() });
  return id;
}
