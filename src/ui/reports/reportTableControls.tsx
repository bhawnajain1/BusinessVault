import { useMemo, useState } from 'react';

export interface ReportSortOption {
  key: string;
  label: string;
}

export function useReportTableControls<T>(
  rows: T[],
  searchText: (row: T) => string,
  sortValue: (row: T, key: string) => string | number,
  defaultSort: { key: string; direction: 'asc' | 'desc' },
) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(defaultSort);
  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? rows.filter((row) => searchText(row).toLowerCase().includes(needle))
      : rows;
    return [...filtered].sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      const result = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return sort.direction === 'asc' ? result : -result;
    });
  }, [query, rows, searchText, sort, sortValue]);

  return { query, setQuery, sort, setSort, filteredRows };
}

export function ReportTableToolbar({
  query,
  onQueryChange,
  sort,
  onSortChange,
  options,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  sort: { key: string; direction: 'asc' | 'desc' };
  onSortChange: (value: { key: string; direction: 'asc' | 'desc' }) => void;
  options: ReportSortOption[];
}) {
  return (
    <div className="flex flex-wrap items-end gap-2 mb-2">
      <label className="text-sm">
        <span className="block text-slate-500 mb-1">Filter</span>
        <input value={query} onChange={(e) => onQueryChange(e.target.value)} placeholder="Search rows" className="border border-slate-300 rounded px-2 py-1 text-sm" />
      </label>
      <label className="text-sm">
        <span className="block text-slate-500 mb-1">Sort by</span>
        <select value={sort.key} onChange={(e) => onSortChange({ ...sort, key: e.target.value })} className="border border-slate-300 rounded px-2 py-1 text-sm">
          {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => onSortChange({ ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' })} className="border border-slate-300 rounded px-3 py-1 text-sm hover:bg-slate-50">
        {sort.direction === 'asc' ? 'Ascending ↑' : 'Descending ↓'}
      </button>
    </div>
  );
}
