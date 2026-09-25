// Top-level error boundary for the routed tree.
//
// Without this, a throw during render (or a rejected lazy import that
// lazyWithReload couldn't recover from) unmounts the whole subtree under
// <Suspense> and the user sees a black page until they refresh. See PR #52
// context — a stale-chunk-after-deploy error was hitting exactly this hole.
//
// Any error caught here is written to the debug log via log.error so a
// support export ("Export debug logs") contains the stack, then a friendly
// panel is rendered with a Reload button and a Copy-error-to-clipboard
// affordance. If the error looks like a stale-chunk error, we show a
// briefer "The app was updated — reload to continue" message (the
// lazyWithReload wrapper normally handles this itself, but if its
// sessionStorage guard has been tripped, this is what the user sees).

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { log } from '../lib/log';
import { _isChunkLoadError } from '../lib/lazyWithReload';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info });
    log.error('errorboundary', error.message || 'render error', {
      name: error.name,
      stack: error.stack,
      componentStack: info.componentStack,
      isChunkLoad: _isChunkLoadError(error),
      href: typeof window !== 'undefined' ? window.location.href : null,
    });
  }

  handleReload = (): void => {
    // Clear session-scoped reload guards before reloading so the next tab
    // instance starts clean. This is safe because the user asked for it —
    // no risk of an infinite loop from an automatic path.
    try {
      sessionStorage.removeItem('bv:chunk-reload-attempted');
    } catch {
      /* private-mode or cookies disabled — non-fatal */
    }
    window.location.reload();
  };

  handleCopy = (): void => {
    const { error, info } = this.state;
    if (!error) return;
    const payload = [
      `Error: ${error.name}: ${error.message}`,
      `URL: ${window.location.href}`,
      `User-Agent: ${navigator.userAgent}`,
      '',
      'Stack:',
      error.stack ?? '(no stack)',
      '',
      'Component stack:',
      info?.componentStack ?? '(no component stack)',
    ].join('\n');
    void navigator.clipboard.writeText(payload);
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const isChunkLoad = _isChunkLoadError(error);

    return (
      <div className="p-6 flex flex-col gap-4 max-w-2xl">
        <h1 className="text-xl font-semibold text-slate-900">
          {isChunkLoad ? 'The app was updated' : 'Something went wrong'}
        </h1>
        <p className="text-sm text-slate-600">
          {isChunkLoad
            ? 'A new version of BusinessVault is available and the page needs to reload to continue.'
            : 'A page-level error stopped BusinessVault from rendering this screen. Your data is unaffected — nothing has been saved or lost. Reloading will usually recover.'}
        </p>
        {!isChunkLoad && (
          <details className="text-xs text-slate-500 bg-slate-50 rounded border border-slate-200 p-3">
            <summary className="cursor-pointer text-slate-700">
              Error details
            </summary>
            <pre className="mt-2 whitespace-pre-wrap break-words">
              {error.name}: {error.message}
            </pre>
          </details>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={this.handleReload}
            className="text-sm bg-slate-900 text-white rounded px-3 py-1.5 hover:bg-slate-800"
          >
            Reload
          </button>
          {!isChunkLoad && (
            <button
              type="button"
              onClick={this.handleCopy}
              className="text-sm border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-100"
            >
              Copy error details
            </button>
          )}
        </div>
        {!isChunkLoad && (
          <p className="text-xs text-slate-500">
            If this keeps happening, export the debug logs from{' '}
            <span className="font-mono">Settings → Data &amp; Backup</span> and
            share the file — the error was captured there.
          </p>
        )}
      </div>
    );
  }
}
