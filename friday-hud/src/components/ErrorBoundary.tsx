import React from 'react';

interface Props {
  children: React.ReactNode;
  /** Small inline fallback (one chat message) instead of the full-window recovery screen. */
  compact?: boolean;
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * A rendering error in one component must never blank the whole window. The full-window version
 * offers a one-click recovery; the compact one replaces just the broken message.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[FRIDAY UI] render error:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.compact) {
      return (
        <div role="alert" className="text-[11px] font-mono text-amber-300/80 px-3 py-1.5 rounded-lg border border-amber-400/30 bg-amber-500/10">
          {this.props.label ?? 'This message could not be shown'}.
        </div>
      );
    }
    return (
      <div role="alert" className="w-screen h-screen flex flex-col items-center justify-center gap-4 bg-slate-950 text-slate-200 font-mono">
        <div className="text-cyan-300 text-sm tracking-widest">FRIDAY HAD A DISPLAY HICCUP</div>
        <div className="text-xs text-slate-400 max-w-md text-center">
          Nothing was lost. Your chat and her work are safe in the gateway. Reload the view to continue.
        </div>
        <button
          onClick={() => this.setState({ error: null })}
          className="px-4 py-2 rounded-xl border border-cyan-400/60 bg-cyan-500/20 text-cyan-200 text-xs hover:bg-cyan-500/30"
        >
          RELOAD VIEW
        </button>
      </div>
    );
  }
}
