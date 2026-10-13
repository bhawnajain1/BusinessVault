// Business dates (invoice_date, payment_date, …) are calendar days — they
// drive GST periods, FY and ledgers, so they stay YYYY-MM-DD. The exact
// moment a record was entered lives in created_at / updated_at (ISO
// timestamps). These helpers show that time next to the date, in the
// device's local timezone, without touching the stored data.

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// "4:35 pm" — empty string when the timestamp is missing or invalid.
export function formatTime(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return '';
  const h = d.getHours() % 12 || 12;
  return `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'am' : 'pm'}`;
}

// "2026-10-05 11:14 am" in local time. Used on screen and in CSV exports.
export function formatDateTime(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatTime(iso)}`;
}

// Table cell for the "Created" / "Last modified" columns: full local date
// and time, or a dash when the timestamp is missing.
export function DateTimeCell({ iso }: { iso?: string | null }) {
  const text = formatDateTime(iso);
  return <span className="whitespace-nowrap">{text || '—'}</span>;
}

// Detail pages: "Created 2026-10-12 4:35 pm" / "Last modified 2026-10-13 9:10 am"
export function SavedTimes({ createdAt, updatedAt }: { createdAt?: string | null; updatedAt?: string | null }) {
  const created = formatDateTime(createdAt);
  const modified = formatDateTime(updatedAt);
  if (!created && !modified) return null;
  return (
    <div className="space-y-0.5 text-xs text-slate-500">
      {created && <div>Created {created}</div>}
      {modified && <div>Last modified {modified}</div>}
    </div>
  );
}
