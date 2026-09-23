import { useMemo, useState, useEffect, type ReactNode } from 'react';

export interface ColumnDef<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  className?: string;
  filterable?: boolean;
}

export interface DataTablePage<T> {
  rows: T[];
  total: number;
}

export interface DataTableProps<T> {
  columns: ColumnDef<T>[];
  fetchPage: (args: {
    offset: number;
    limit: number;
    search: string;
    filters: Record<string, string>;
  }) => Promise<DataTablePage<T>>;
  fetchPageDeps?: unknown[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  pageSize?: number;
  searchPlaceholder?: string;
  emptyMessage?: string;
  toolbar?: ReactNode;
  onExport?: (args: { search: string; filters: Record<string, string> }) => void | Promise<void>;
  exportLabel?: string;
}

const inputCls =
  'h-10 rounded-xl border border-slate-200 bg-white px-3 text-[13px] text-slate-800 placeholder:text-slate-400 shadow-sm focus:border-blue-400 focus:outline-none focus:ring-4 focus:ring-blue-500/10';

const btnGhost =
  'inline-flex h-10 items-center rounded-xl border border-slate-200 bg-white px-3 text-[12px] font-semibold text-slate-600 shadow-sm transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-40 disabled:hover:bg-white';

export default function DataTable<T>(props: DataTableProps<T>) {
  const {
    columns,
    fetchPage,
    fetchPageDeps = [],
    rowKey,
    onRowClick,
    pageSize = 50,
    searchPlaceholder = 'Search...',
    emptyMessage = 'No records found.',
    toolbar,
    onExport,
    exportLabel = 'Export CSV',
  } = props;

  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filterKeys = useMemo(
    () => columns.filter((c) => c.filterable).map((c) => c.key),
    [columns],
  );

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPage(0);
  }, [search, JSON.stringify(filters)]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPage({
      offset: page * pageSize,
      limit: pageSize,
      search,
      filters,
    })
      .then((res) => {
        if (cancelled) return;
        setRows(res.rows);
        setTotal(res.total);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setRows([]);
        setTotal(0);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, search, JSON.stringify(filters), ...fetchPageDeps]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-slate-200/80 bg-white/80 p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={searchPlaceholder}
            className={`${inputCls} w-full pl-9 sm:w-80`}
          />
        </div>
        {filterKeys.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {columns
              .filter((c) => c.filterable)
              .map((c) => (
                <input
                  key={c.key}
                  type="text"
                  value={filters[c.key] ?? ''}
                  onChange={(e) =>
                    setFilters((f) => {
                      const next = { ...f };
                      if (e.target.value === '') delete next[c.key];
                      else next[c.key] = e.target.value;
                      return next;
                    })
                  }
                  placeholder={c.header}
                  className={`${inputCls} w-36`}
                />
              ))}
          </div>
        )}
        <div className="flex-1" />
        {onExport && (
          <button
            type="button"
            onClick={() => onExport({ search, filters })}
            className={btnGhost}
          >
            {exportLabel}
          </button>
        )}
        {toolbar}
      </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
        <table className="w-full text-[13px]">
          <thead className="bg-app border-b border-border">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={`text-left px-3 h-9 font-medium text-fg-muted text-[11px] uppercase tracking-wider ${c.className ?? ''}`}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-10 text-center text-fg-subtle"
                >
                  Loading…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && !error && (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-10 text-center text-fg-subtle"
                >
                  {emptyMessage}
                </td>
              </tr>
            )}
            {error && (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-10 text-center text-danger"
                >
                  {error}
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`border-t border-border text-fg ${
                  onRowClick ? 'cursor-pointer hover:bg-surface-hover' : ''
                } transition-colors`}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`px-3 py-2 ${c.className ?? ''}`}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-[12px] text-fg-muted">
        <div>
          {total > 0
            ? `${from}–${to} of ${total.toLocaleString('en-IN')}`
            : 'No records'}
          {loading && rows.length > 0 ? ' · refreshing…' : ''}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage(0)}
            className={btnGhost}
          >
            First
          </button>
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className={btnGhost}
          >
            Prev
          </button>
          <span className="px-2 text-fg-subtle">
            {page + 1} / {pageCount}
          </span>
          <button
            type="button"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((p) => p + 1)}
            className={btnGhost}
          >
            Next
          </button>
          <button
            type="button"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage(pageCount - 1)}
            className={btnGhost}
          >
            Last
          </button>
        </div>
      </div>
    </div>
  );
}
