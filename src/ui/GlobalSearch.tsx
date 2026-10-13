import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Package, Search, Truck, Users, type LucideIcon } from 'lucide-react';
import { db } from '../db';
import { useActiveBusiness } from './hooks/useActiveBusiness';
import { formatMoney } from './components/Money';
import { log } from '../lib/log';

// Header search across invoices, customers, suppliers and items of the active
// business. Read-only Dexie scans (small per-business tables), capped at five
// hits per group. Implements the ARIA 1.2 combobox pattern: arrow keys move,
// Enter opens, Escape closes. "/" or Ctrl/Cmd+K focuses the box from anywhere.

interface Hit {
  id: string;
  group: 'Invoices' | 'Customers' | 'Suppliers' | 'Items';
  label: string;
  detail: string;
  to: string;
}

const GROUP_ICON: Record<Hit['group'], LucideIcon> = {
  Invoices: FileText,
  Customers: Users,
  Suppliers: Truck,
  Items: Package,
};

const PER_GROUP = 5;

async function searchBusiness(businessId: string, query: string): Promise<Hit[]> {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const has = (v: string | null | undefined) => !!v && v.toLowerCase().includes(q);

  const [invoices, customers, suppliers, items] = await Promise.all([
    db.invoices.where('business_id').equals(businessId).toArray(),
    db.customers.where('business_id').equals(businessId).toArray(),
    db.suppliers.where('business_id').equals(businessId).toArray(),
    db.items.where('business_id').equals(businessId).toArray(),
  ]);
  const customerName = new Map(customers.map((c) => [c.id, c.name]));

  const invoiceHits: Hit[] = invoices
    .filter((i) => !i.deleted_at && (has(i.invoice_number) || has(customerName.get(i.customer_id))))
    .sort((a, b) => (a.invoice_date < b.invoice_date ? 1 : -1))
    .slice(0, PER_GROUP)
    .map((i) => ({
      id: `inv-${i.id}`,
      group: 'Invoices',
      label: `#${i.invoice_number}`,
      detail: `${customerName.get(i.customer_id) ?? '—'} · ${i.invoice_date} · ${formatMoney(i.total_paise)}`,
      to: `/invoices/${i.id}`,
    }));
  const customerHits: Hit[] = customers
    .filter((c) => has(c.name) || has(c.phone))
    .slice(0, PER_GROUP)
    .map((c) => ({ id: `cus-${c.id}`, group: 'Customers', label: c.name, detail: c.phone || 'Customer', to: `/customers/${c.id}` }));
  const supplierHits: Hit[] = suppliers
    .filter((s) => has(s.name) || has(s.phone))
    .slice(0, PER_GROUP)
    .map((s) => ({ id: `sup-${s.id}`, group: 'Suppliers', label: s.name, detail: s.phone || 'Supplier ledger', to: `/parties/supplier/${s.id}/ledger` }));
  const itemHits: Hit[] = items
    .filter((i) => has(i.name) || has(i.sku))
    .slice(0, PER_GROUP)
    .map((i) => ({ id: `itm-${i.id}`, group: 'Items', label: i.name, detail: i.sku ? `SKU ${i.sku}` : 'Item', to: '/items' }));

  return [...invoiceHits, ...customerHits, ...supplierHits, ...itemHits];
}

export default function GlobalSearch() {
  const { businessId } = useActiveBusiness();
  const navigate = useNavigate();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [error, setError] = useState(false);

  // Debounced search; the `cancelled` flag drops stale responses.
  useEffect(() => {
    if (!businessId || query.trim().length === 0) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      searchBusiness(businessId, query)
        .then((result) => {
          if (cancelled) return;
          setHits(result);
          setActive(result.length > 0 ? 0 : -1);
          setError(false);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          log.warn('globalSearch', 'search failed', { error: String(e) });
          setError(true);
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [businessId, query]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, []);

  const go = (hit: Hit) => {
    log.info('globalSearch', 'open result', { group: hit.group, to: hit.to });
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
    navigate(hit.to);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (hits.length === 0 ? -1 : (i + 1) % hits.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (hits.length === 0 ? -1 : (i - 1 + hits.length) % hits.length));
    } else if (e.key === 'Enter' && active >= 0 && hits[active]) {
      e.preventDefault();
      go(hits[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const showPanel = open && query.trim().length > 0;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <div ref={rootRef} className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-label="Search invoices, customers, suppliers and items"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showPanel && active >= 0 ? optionId(active) : undefined}
        placeholder="Search invoices, customers, items…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        disabled={!businessId}
        className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-12 text-sm text-slate-800 placeholder:text-slate-400 transition-colors hover:border-slate-300 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-60"
      />
      <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-slate-200 bg-white px-1.5 text-[11px] font-medium text-slate-500 md:block" aria-hidden="true">
        /
      </kbd>
      {showPanel && (
        <div className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
          <ul id={listId} role="listbox" aria-label="Search results" className="max-h-96 overflow-y-auto py-1">
            {error && <li className="px-4 py-3 text-sm text-red-600">Search failed. Please try again.</li>}
            {!error && hits.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-slate-500">No matches for “{query.trim()}”.</li>
            )}
            {hits.map((hit, i) => {
              const Icon = GROUP_ICON[hit.group];
              const firstOfGroup = i === 0 || hits[i - 1].group !== hit.group;
              return (
                <li key={hit.id} role="presentation">
                  {firstOfGroup && (
                    <div className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500" role="presentation">
                      {hit.group}
                    </div>
                  )}
                  <div
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => go(hit)}
                    className={`mx-1 flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 ${i === active ? 'bg-indigo-50' : ''}`}
                  >
                    <Icon className={`h-4 w-4 shrink-0 ${i === active ? 'text-indigo-600' : 'text-slate-400'}`} aria-hidden="true" />
                    <div className="min-w-0">
                      <div className={`truncate text-sm font-medium ${i === active ? 'text-indigo-700' : 'text-slate-800'}`}>{hit.label}</div>
                      <div className="truncate text-xs text-slate-500">{hit.detail}</div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
