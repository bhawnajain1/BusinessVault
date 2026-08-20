import { useEffect, useRef, useState } from 'react';

// Baked in at build time from GitHub Actions secrets. The token is a
// fine-grained PAT scoped to ONLY repository_dispatch on this repo — worst
// case if leaked, someone can trigger the feedback workflow (which just
// creates issues and emails you). Rotate if abused.
const DISPATCH_TOKEN =
  (import.meta.env.VITE_FEEDBACK_DISPATCH_TOKEN as string | undefined) ?? '';
const DISPATCH_REPO =
  (import.meta.env.VITE_FEEDBACK_DISPATCH_REPO as string | undefined) ??
  'bhawnajain1/BusinessVault';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function FeedbackModal({ open, onClose }: Props) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setText('');
      setStatus('idle');
      setErrorMsg('');
      // Small delay so the browser has the element focus-able.
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  async function submit() {
    if (!text.trim()) return;
    setStatus('sending');
    setErrorMsg('');
    try {
      const res = await fetch(
        `https://api.github.com/repos/${DISPATCH_REPO}/dispatches`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${DISPATCH_TOKEN}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            event_type: 'user_feedback',
            client_payload: {
              text: text.trim(),
              url: window.location.href,
              user_agent: navigator.userAgent,
              submitted_at: new Date().toISOString(),
            },
          }),
        },
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`GitHub API ${res.status}: ${detail || res.statusText}`);
      }
      setStatus('sent');
    } catch (e) {
      setStatus('error');
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg bg-surface border border-border p-4 shadow-lg">
        <div className="flex items-center justify-between mb-2">
          <h2 id="feedback-title" className="text-base font-semibold text-fg">
            Send feedback
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-fg-muted hover:text-fg text-lg leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {status === 'sent' ? (
          <div className="py-6 text-center text-sm text-fg">
            Thanks — feedback received. You can close this dialog.
            <div className="mt-4">
              <button
                type="button"
                onClick={onClose}
                className="text-sm bg-slate-900 text-white rounded px-3 py-1.5 hover:bg-slate-800"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-xs text-fg-muted mb-2">
              What went wrong, what worked, or what you'd like to see. Includes
              this page's URL and your browser info for triage.
            </p>
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              placeholder="Type your feedback here..."
              className="w-full border border-border rounded px-2 py-1.5 text-sm bg-app text-fg resize-y"
              disabled={status === 'sending'}
            />
            {status === 'error' && (
              <div className="mt-2 text-xs text-rose-600">
                Could not send: {errorMsg}
              </div>
            )}
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="text-sm text-fg-muted hover:text-fg px-2 py-1"
                disabled={status === 'sending'}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={status === 'sending' || !text.trim()}
                className="text-sm bg-slate-900 text-white rounded px-3 py-1.5 hover:bg-slate-800 disabled:opacity-50"
              >
                {status === 'sending' ? 'Sending...' : 'Send'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function isFeedbackConfigured(): boolean {
  return !!DISPATCH_TOKEN;
}
