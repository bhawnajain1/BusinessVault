// Business dates (invoice_date, payment_date, …) are calendar days — they
// drive GST periods, FY and ledgers, so they stay YYYY-MM-DD. The exact
// moment a record was entered lives in created_at / updated_at (ISO
// timestamps). These helpers show that time next to the date, in the
// device's local timezone, without touching the stored data.

const timeFmt = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// "4:35 pm" — empty string when the timestamp is missing or invalid.
export function formatTime(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? timeFmt.format(d) : '';
}

// "12 Oct 2026, 4:35 pm"
export function formatDateTime(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? dateTimeFmt.format(d) : '';
}

// For CSV exports: "2026-10-12 16:35" in local time, sortable and
// spreadsheet-friendly.
export function formatDateTimeCsv(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Table cell: the business date, with the time it was saved underneath.
export function DateWithTime({ date, at }: { date: string; at?: string | null }) {
  const time = formatTime(at);
  return (
    <span className="inline-flex flex-col leading-tight">
      <span>{date}</span>
      {time && (
        <span className="text-xs text-slate-500" title={`Saved ${formatDateTime(at)}`}>
          {time}
        </span>
      )}
    </span>
  );
}

// Detail pages: "Created 12 Oct 2026, 4:35 pm · Last edited 13 Oct 2026, 9:10 am"
export function SavedTimes({ createdAt, updatedAt }: { createdAt?: string | null; updatedAt?: string | null }) {
  const created = formatDateTime(createdAt);
  const updated = formatDateTime(updatedAt);
  if (!created) return null;
  const edited = updated && updatedAt !== createdAt && updated !== created;
  return (
    <div className="text-xs text-slate-500">
      Created {created}
      {edited && <> · Last edited {updated}</>}
    </div>
  );
}
