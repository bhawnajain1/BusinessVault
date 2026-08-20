import { useState } from 'react';
import { Link } from 'react-router-dom';
import CloudIndicator from './CloudIndicator';
import ThemeToggle from './theme/ThemeToggle';
import FeedbackModal, { isFeedbackConfigured } from './FeedbackModal';

export default function Header() {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const feedbackReady = isFeedbackConfigured();

  return (
    <header className="flex items-center justify-between border-b border-border bg-surface px-4 h-12">
      <Link
        to="/"
        className="flex items-center gap-2 text-sm font-medium text-fg hover:text-fg"
        aria-label="BusinessVault home"
      >
        <img
          src={`${import.meta.env.BASE_URL}logo.png`}
          alt=""
          aria-hidden="true"
          className="h-9 w-9 object-contain"
        />
        <span>BusinessVault</span>
      </Link>
      <div className="flex items-center gap-2">
        {feedbackReady && (
          <button
            type="button"
            onClick={() => setFeedbackOpen(true)}
            className="text-xs border border-border rounded px-2.5 py-1 text-fg-muted hover:bg-surface-hover hover:text-fg"
            aria-label="Send feedback"
          >
            Feedback
          </button>
        )}
        <CloudIndicator />
        <ThemeToggle />
      </div>
      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </header>
  );
}
