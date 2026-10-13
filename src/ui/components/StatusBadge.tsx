interface StatusBadgeProps {
  status: string;
  className?: string;
}

const TONE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700 border-slate-200',
  issued: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  received: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  partial: 'bg-amber-50 text-amber-800 border-amber-200',
  paid: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  cancelled: 'bg-red-50 text-red-700 border-red-200',
  LOCAL_ONLY: 'bg-slate-100 text-slate-700 border-slate-200',
  QUEUED: 'bg-slate-100 text-slate-700 border-slate-200',
  SYNCING: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  SYNCED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  CONFLICT: 'bg-amber-50 text-amber-800 border-amber-200',
  FAILED: 'bg-red-50 text-red-700 border-red-200',
};

// Pastel pill with a leading dot. Text stays the raw status value (tests and
// screen readers read it); `capitalize` only changes how it looks.
export default function StatusBadge({ status, className }: StatusBadgeProps) {
  const tone = TONE[status] ?? 'bg-slate-100 text-slate-700 border-slate-200';
  return (
    <span
      className={`bv-ui inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold capitalize ${tone} ${className ?? ''}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />
      {status.includes('_') || status === status.toUpperCase() ? status.toLowerCase().replace(/_/g, ' ') : status}
    </span>
  );
}
