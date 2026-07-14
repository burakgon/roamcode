import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  onCancel: () => void;
  onSendOriginal: () => void;
}

interface State {
  error?: Error;
}

/** Keeps an optional editor failure inside the attachment flow instead of replacing the whole conversation. */
export class ImageEditorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[roamcode] image editor render crash:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="rc-ie-fallback" role="alert">
        <div className="rc-ie-fallback__card">
          <strong>Image editor couldn't open</strong>
          <p>Your conversation is safe. You can send the original image or cancel this attachment.</p>
          <details>
            <summary>Technical details</summary>
            <pre>{error.message || String(error)}</pre>
          </details>
          <div className="rc-ie-fallback__actions">
            <button type="button" onClick={this.props.onCancel}>
              Cancel
            </button>
            <button type="button" className="is-primary" onClick={this.props.onSendOriginal}>
              Send original
            </button>
          </div>
        </div>
        <style>{fallbackCss}</style>
      </div>
    );
  }
}

const fallbackCss = `
.rc-ie-fallback { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 20px; background: #09090b; color: var(--text); }
.rc-ie-fallback__card { width: min(100%,420px); display: grid; gap: 14px; padding: 20px; border: 1px solid var(--border-strong); border-radius: 14px; background: var(--surface); box-shadow: var(--shadow); }
.rc-ie-fallback__card strong { font: 650 18px/1.2 var(--font-display); }
.rc-ie-fallback__card p { margin: 0; color: var(--text-muted); font-size: 13px; line-height: 1.5; }
.rc-ie-fallback__card details { color: var(--text-faint); font: 11px/1.4 var(--font-mono); }
.rc-ie-fallback__card pre { max-height: 120px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
.rc-ie-fallback__actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.rc-ie-fallback__actions button { min-height: 44px; border: 1px solid var(--border); border-radius: 9px; background: transparent; color: var(--text); font: 650 12px/1 var(--font-mono); }
.rc-ie-fallback__actions button.is-primary { border-color: transparent; background: var(--coral); color: var(--on-accent); }
`;
