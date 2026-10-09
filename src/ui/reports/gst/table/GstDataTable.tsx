import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import './gstTable.css';

type GstDataTableProps = {
  title: string;
  description?: string;
  headers?: string[];
  columns?: GstTableColumn[];
  rows: ReactNode[][];
  rowId?: (row: ReactNode[]) => string;
  pageSize?: number;
};

export type GstTableColumn = { id: string; header: string; alignment: 'left' | 'right'; minWidth: number; formatter: (value: ReactNode) => ReactNode; accessor: (row: ReactNode[]) => ReactNode };

const DISPLAY_LABELS: Record<string, string> = {
  BLOCKING_ERROR: 'Blocking error',
  WARNING: 'Warning',
  INFORMATION: 'Information',
  INCOMPLETE: 'Incomplete',
  READY_FOR_CA_REVIEW: 'Ready for CA review',
  FINALIZED_WORKING: 'Finalized working',
  UNREVIEWED: 'Unreviewed',
  ELIGIBLE_IN_BOOKS: 'Eligible in books',
  INELIGIBLE: 'Ineligible',
  TEMPORARILY_REVERSED: 'Temporarily reversed',
  PERMANENTLY_REVERSED: 'Permanently reversed',
  RECLAIMABLE: 'Reclaimable',
  RECLAIMED: 'Reclaimed',
  INDICATIVE_BALANCE: 'Indicative balance',
  TOTAL_BOOKS_TAX: 'Total books tax',
  PURCHASE_GROSS: 'Gross purchases',
  PURCHASE_NOTES: 'Purchase notes',
  PURCHASE_NET: 'Net purchases',
  OUTPUT_LIABILITY: 'Output liability',
  RCM_LIABILITY: 'Reverse charge liability',
  UNCLASSIFIED: 'Unclassified',
  UNCLASSIFIED_INVALID_GSTIN: 'Unclassified: invalid GSTIN',
  EXPORT_WITHOUT_PAYMENT: 'Export without payment',
  EXPORT_WITH_PAYMENT: 'Export with payment',
  SALES_BOOKS: 'Sales books',
  PURCHASE_BOOKS: 'Purchase books',
};

function displayCell(value: ReactNode, header: string): ReactNode {
  if (typeof value !== 'string' || !DISPLAY_LABELS[value]) return value;
  const label = DISPLAY_LABELS[value];
  const isBadge = /status|severity|classification|inclusion|source status/i.test(header);
  return isBadge ? <span className="gst-table-badge">{label}</span> : label;
}

function stableValue(value: ReactNode): string {
  if (value == null || typeof value === 'boolean') return String(value);
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(stableValue).join('|');
  if (typeof value === 'object' && 'props' in value) {
    const element = value as { key: unknown; props: { children?: ReactNode; href?: string; 'aria-label'?: string } };
    return `${element.key ?? ''}:${element.props.href ?? ''}:${element.props['aria-label'] ?? ''}:${stableValue(element.props.children ?? '')}`;
  }
  return String(value);
}

export default function GstDataTable({ title, description, headers = [], columns, rows, rowId = row => row.map(stableValue).join('\u001f'), pageSize = 25 }: GstDataTableProps) {
  const [page, setPage] = useState(0);
  const tableId = useId();
  const tableColumns = columns ?? headers.map((header, index): GstTableColumn => ({ id: header, header,
    alignment: /amount|taxable|igst|cgst|sgst|cess|rate|quantity|count|documents|recipients|rows|issued|cancelled|net/i.test(header) ? 'right' : 'left', minWidth: Math.max(110, header.length * 9), formatter: value => displayCell(value, header), accessor: row => row[index] }));
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * pageSize;
  const visibleRows = rows.slice(start, start + pageSize);
  const dense = tableColumns.length > 9;
  const minimumWidth = tableColumns.reduce((total, column) => total + column.minWidth, 0);

  useEffect(() => { setPage(0); }, [rows.length, title]);

  return <section className="gst-table-card">
    <header className="gst-table-card-header">
      <div><h3>{title}</h3>{description && <p>{description}</p>}</div>
      <span aria-label={`${rows.length} rows`}>{rows.length} {rows.length === 1 ? 'row' : 'rows'}</span>
    </header>
    <div className="gst-table-scroll" tabIndex={0} role="region" aria-label={`${title}, horizontally scrollable`}>
      <table id={tableId} className={`gst-data-table ${dense ? 'gst-data-table-dense' : ''}`} style={{ minWidth: minimumWidth }}>
        <caption>{title}</caption>
        <thead><tr>{tableColumns.map(column => <th scope="col" key={column.id} className={`gst-table-${column.alignment}`} style={{ minWidth: column.minWidth }}>{column.header}</th>)}</tr></thead>
        <tbody>{visibleRows.map(row => <tr key={rowId(row)}>{tableColumns.map(column => <td key={column.id} className={`gst-table-${column.alignment}`}>{column.formatter(column.accessor(row))}</td>)}</tr>)}
          {!rows.length && <tr><td colSpan={tableColumns.length} className="gst-table-empty">No rows are available for the selected report period.</td></tr>}
        </tbody>
      </table>
    </div>
    {rows.length > pageSize && <footer className="gst-table-pagination" aria-label={`${title} pagination`}>
      <span>{start + 1}–{Math.min(start + pageSize, rows.length)} of {rows.length}</span>
      <div><button type="button" aria-label="Previous page" disabled={currentPage === 0} onClick={() => setPage(value => Math.max(0, value - 1))}><ChevronLeft size={16} /> Previous</button><span>Page {currentPage + 1} of {pageCount}</span><button type="button" aria-label="Next page" disabled={currentPage === pageCount - 1} onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))}>Next <ChevronRight size={16} /></button></div>
    </footer>}
  </section>;
}
