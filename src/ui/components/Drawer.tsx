import { type ReactNode, useEffect } from 'react';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
  footer?: ReactNode;
  fullPage?: boolean;
  showFullPageBack?: boolean;
}

export default function Drawer({
  open,
  onClose,
  title,
  children,
  width = 'w-[560px]',
  footer,
  fullPage = false,
  showFullPageBack = true,
}: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  if (fullPage) {
    return (
      <div className="fixed inset-0 z-40 overflow-y-auto bg-slate-50/95">
        <div className="mx-auto flex min-h-full max-w-5xl flex-col gap-6 p-5 sm:p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">{title}</h1>
          {showFullPageBack && (
            <button type="button" onClick={onClose} className="text-sm font-semibold text-blue-700 hover:text-blue-800">Back</button>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
          <div className="flex-1 overflow-y-auto p-5 sm:p-7">{children}</div>
          {footer && <div className="border-t border-slate-100 bg-slate-50/80 px-5 py-4 sm:px-7">{footer}</div>}
        </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={`absolute right-0 top-0 h-full ${width} max-w-full bg-surface text-fg shadow-2xl border-l border-border flex flex-col`}
      >
        <div className="flex items-center justify-between px-5 h-12 border-b border-border">
          <h2 className="text-[14px] font-medium text-fg">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-hover hover:text-fg transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer && (
          <div className="border-t border-border px-5 py-3 bg-app">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
