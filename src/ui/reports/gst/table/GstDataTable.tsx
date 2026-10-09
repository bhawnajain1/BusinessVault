import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import './gstTable.css';

type GstDataTableProps = {
  title: string;
  description?: string;
  headers: string[];
  rows: ReactNode[][];
  pageSize?: number;
};

const DISPLAY_LABELS: Record<string, string> = {
  BLOCKING_ERROR: 'Blocking error',
  WARNING: 'Warning',
  INFO: 'Information',
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

export default function GstDataTable({ title, description, headers, rows, pageSize = 25 }: GstDataTableProps) {
  const [page, setPage] = useState(0);
  const tableId = useId();
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * pageSize;
  const visibleRows = rows.slice(start, start + pageSize);
  const dense = headers.length > 9;
  const minimumWidth = headers.length > 12 ? 1480 : headers.length > 8 ? 1180 : 860;

  useEffect(() => { setPage(0); }, [rows.length, title]);

  return <section className="gst-table-card">
    <header className="gst-table-card-header">
      <div><h3>{title}</h3>{description && <p>{description}</p>}</div>
      <span aria-label={`${rows.length} rows`}>{rows.length} {rows.length === 1 ? 'row' : 'rows'}</span>
    </header>
    <div className="gst-table-scroll" tabIndex={0} role="region" aria-label={`${title}, horizontally scrollable`}>
      <table id={tableId} className={`gst-data-table ${dense ? 'gst-data-table-dense' : ''}`} style={{ minWidth: minimumWidth }}>
        <caption>{title}</caption>
        <thead><tr>{headers.map(header => <th scope="col" key={header}>{header}</th>)}</tr></thead>
        <tbody>{visibleRows.map((row, rowIndex) => <tr key={start + rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{displayCell(cell, headers[cellIndex])}</td>)}</tr>)}
          {!rows.length && <tr><td colSpan={headers.length} className="gst-table-empty">No rows are available for the selected report period.</td></tr>}
        </tbody>
      </table>
    </div>
    {rows.length > pageSize && <footer className="gst-table-pagination" aria-label={`${title} pagination`}>
      <span>{start + 1}–{Math.min(start + pageSize, rows.length)} of {rows.length}</span>
      <div><button type="button" aria-label="Previous page" disabled={currentPage === 0} onClick={() => setPage(value => Math.max(0, value - 1))}><ChevronLeft size={16} /> Previous</button><span>Page {currentPage + 1} of {pageCount}</span><button type="button" aria-label="Next page" disabled={currentPage === pageCount - 1} onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))}>Next <ChevronRight size={16} /></button></div>
    </footer>}
  </section>;
}
