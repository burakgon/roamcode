import { useEffect, useRef } from "react";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";

/** A single "glyph — what it does" legend row. */
function Row({ glyph, children }: { glyph: string; children: React.ReactNode }) {
  return (
    <div className="rc-help__row">
      <span className="rc-help__glyph" aria-hidden>
        {glyph}
      </span>
      <span className="rc-help__text">{children}</span>
    </div>
  );
}

/** One-screen legend of the terminal's touch gestures + key bar. Opened by the header "?" button. A bottom
 *  sheet (mobile) / right drawer (desktop), dismissed by the scrim, the X, Escape, or the Android/browser BACK
 *  gesture (a throwaway history entry is pushed on open so BACK closes the sheet instead of leaving the app). */
export function HelpSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, open);

  // Escape + the BACK gesture close it (same pattern as the Files lightbox), so it's never a one-way door.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onPop = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);
    window.history.pushState({ rcHelp: true }, "");
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPop);
      if ((window.history.state as { rcHelp?: boolean } | null)?.rcHelp) window.history.back();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="rc-help" role="dialog" aria-modal="true" aria-label="Terminal help">
      <button type="button" className="rc-help__scrim" aria-label="Close help" onClick={onClose} />
      <div className="rc-help__panel" ref={panelRef}>
        <div className="rc-help__head">
          <strong>Gestures &amp; keys</strong>
          <button type="button" className="rc-help__x" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="rc-help__body">
          <div className="rc-help__section">Gestures</div>
          <Row glyph="✌︎">
            <b>Two-finger drag</b> scrolls — claude's screen when it's full-screen, otherwise the terminal's own
            scrollback (a git diff, stack trace, logs). Tap <b>Latest</b> to snap back to the newest output.
          </Row>
          <Row glyph="A±">
            <b>A− / A+</b> (top-right) shrink or grow the text; the keyboard icon there hides the on-screen keyboard so
            you can read.
          </Row>

          <div className="rc-help__section">Key bar</div>
          <Row glyph="Sel">
            <b>Select</b> opens a plain, selectable copy of the screen — long-press to select, then Copy.
          </Row>
          <Row glyph="⌨">
            <b>Paste</b> (keyboard icon) opens a box to type or paste text, then Send it to the terminal.
          </Row>
          <Row glyph="Ctrl">
            <b>Ctrl / Alt</b> are sticky: tap once to arm, then the next key (bar or keyboard) becomes the combo
            (Ctrl-R, Alt-B, …). Tap again to cancel.
          </Row>
          <Row glyph="↑↓">
            <b>Arrows / PgUp / PgDn</b> auto-repeat when held — press and hold to keep moving.
          </Row>

          <div className="rc-help__section">Control keys</div>
          <Row glyph="^C">
            <b>^C</b> interrupts (stops a running command); <b>^D</b> sends end-of-input.
          </Row>
          <Row glyph="⇤">
            <b>⇤</b> is Shift-Tab — in claude it cycles the permission mode.
          </Row>
          <Row glyph="/@|~">
            <b>/ @ | ~</b> are the punctuation the phone keyboard buries — <b>@</b> starts a file mention.
          </Row>
        </div>
      </div>
      <style>{css}</style>
    </div>
  );
}

const css = `
.rc-help { position: absolute; inset: 0; z-index: 30; }
.rc-help__scrim { position: absolute; inset: 0; border: none; background: rgba(0,0,0,0.45); cursor: pointer; }
.rc-help__panel {
  position: absolute; left: 0; right: 0; bottom: 0; max-height: 86%;
  display: flex; flex-direction: column;
  background: var(--surface); border-top: 1px solid var(--border-strong);
  border-top-left-radius: 14px; border-top-right-radius: 14px;
  box-shadow: 0 -12px 40px rgba(0,0,0,0.5);
  animation: rc-help-in 200ms cubic-bezier(0.16,1,0.3,1);
}
@keyframes rc-help-in { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.rc-help__head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--border); color: var(--text); font: 600 14px/1 "JetBrains Mono", ui-monospace, monospace; }
.rc-help__x { width: 34px; height: 34px; display: grid; place-items: center; background: transparent; border: none; color: var(--text-faint); cursor: pointer; border-radius: 8px; }
.rc-help__x:hover { color: var(--text); background: var(--surface-2); }
.rc-help__body { flex: 1 1 auto; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 12px 14px calc(14px + env(safe-area-inset-bottom, 0px)); }
.rc-help__section { margin: 14px 0 8px; font: 700 11px/1 var(--font-mono); text-transform: uppercase; letter-spacing: 0.7px; color: var(--text-faint); }
.rc-help__section:first-child { margin-top: 2px; }
.rc-help__row { display: flex; align-items: flex-start; gap: 12px; padding: 7px 0; }
.rc-help__glyph {
  flex: none; min-width: 46px; text-align: center;
  padding: 5px 6px; border-radius: 8px;
  background: var(--surface-2); border: 1px solid var(--border-strong); color: var(--coral);
  font: 700 12px/1.15 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.rc-help__text { flex: 1 1 auto; min-width: 0; color: var(--text-muted); font: 400 13px/1.5 var(--font-body); }
.rc-help__text b { color: var(--text); font-weight: 600; }
@media (min-width: 768px) {
  .rc-help__panel { left: auto; top: 0; bottom: 0; width: 400px; max-height: none; border-radius: 0; border-top: none; border-left: 1px solid var(--border-strong); box-shadow: -12px 0 40px rgba(0,0,0,0.5); animation: none; }
}
`;
