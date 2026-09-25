interface StatusBadgeProps {
  status: string;
  className?: string;
}

const TONE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700 border-slate-200',
  issued: 'bg-blue-50 text-blue-700 border-blue-200',
  received: 'bg-blue-50 text-blue-700 border-blue-200',
  partial: 'bg-amber-50 text-amber-800 border-amber-200',
  paid: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  cancelled: 'bg-rose-50 text-rose-700 border-rose-200',
  LOCAL_ONLY: 'bg-slate-100 text-slate-700 border-slate-200',
  QUEUED: 'bg-slate-100 text-slate-700 border-slate-200',
  SYNCING: 'bg-blue-50 text-blue-700 border-blue-200',
  SYNCED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  CONFLICT: 'bg-amber-50 text-amber-800 border-amber-200',
  FAILED: 'bg-rose-50 text-rose-700 border-rose-200',
};

export default function StatusBadge({ status, className }: StatusBadgeProps) {
  const tone = TONE[status] ?? 'bg-slate-100 text-slate-700 border-slate-200';
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${tone} ${className ?? ''}`}
    >
      {status}
    </span>
  );
}
