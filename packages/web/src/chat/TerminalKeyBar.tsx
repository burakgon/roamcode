import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Icon, type IconName } from "../ui/Icon";

/** A light, feature-detected haptic tick for a key tap (no-op where the device / browser lacks the API). */
function haptic() {
  if (typeof navigator !== "undefined") {
    try {
      navigator.vibrate?.(8);
    } catch {
      /* unsupported */
    }
  }
}

/** setPointerCapture / releasePointerCapture wrapped so they can NEVER throw into a key handler. On iOS
 *  setPointerCapture throws for some touch pointerIds (NotFoundError); the bare `?.` only guards a MISSING
 *  method, not a throw — an uncaught throw here would swallow the whole keypress (this is why holding "←"
 *  could register nothing). Capture is a best-effort nicety (keeps a held repeat key firing through a slight
 *  finger drift); losing it must degrade to "still fires," never to a dead key. */
function tryCapture(el: Element, id: number) {
  try {
    (el as HTMLElement).setPointerCapture?.(id);
  } catch {
    /* capture not available for this pointer — the key still fired */
  }
}
function tryRelease(el: Element, id: number) {
  try {
    if ((el as HTMLElement).hasPointerCapture?.(id)) (el as HTMLElement).releasePointerCapture?.(id);
  } catch {
    /* wasn't captured */
  }
}

/** Press-and-hold auto-repeat: wait for an intentional hold, then repeat until release. A short tap is emitted
 *  once on pointerup by the button handler, so merely touching the toolbar never performs an action. */
type RepeatProfile = { delay: number; interval: number };
const ARROW_REPEAT: RepeatProfile = { delay: 380, interval: 70 };

function useAutoRepeat() {
  const timers = useRef<{ delay?: ReturnType<typeof setTimeout>; interval?: ReturnType<typeof setInterval> }>({});
  const fired = useRef(false);
  const stopTimers = () => {
    if (timers.current.delay) clearTimeout(timers.current.delay);
    if (timers.current.interval) clearInterval(timers.current.interval);
    timers.current = {};
  };
  const cancel = () => {
    stopTimers();
    fired.current = false;
  };
  const start = (fn: () => void, profile: RepeatProfile) => {
    cancel();
    timers.current.delay = setTimeout(() => {
      fired.current = true;
      haptic();
      fn();
      timers.current.interval = setInterval(fn, profile.interval);
    }, profile.delay);
  };
  const finish = () => {
    const didRepeat = fired.current;
    cancel();
    return didRepeat;
  };
  useEffect(() => {
    const onVisibility = () => document.hidden && cancel();
    // React's per-button pointer handlers are the normal path. Window-level listeners are the safety net for
    // a lost pointer capture, an app switch, or a browser gesture that steals the release from the button.
    window.addEventListener("pointerup", stopTimers, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancel();
      window.removeEventListener("pointerup", stopTimers, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return { start, finish, cancel };
}

function pointerIsInside(element: HTMLElement, event: ReactPointerEvent<HTMLButtonElement>): boolean {
  const bounds = element.getBoundingClientRect();
  return (
    event.clientX >= bounds.left &&
    event.clientX <= bounds.right &&
    event.clientY >= bounds.top &&
    event.clientY <= bounds.bottom
  );
}

/** Compact single-row mobile terminal bar: the few keys the phone keyboard still needs plus launchers for
 *  files, a physical D-pad, chat, and the sole software-keyboard control. The D-pad opens immediately above
 *  the bar so the primary row stays calm and every direction keeps a full-size touch target.
 *
 *  Every button preventDefaults on MOUSEDOWN so a tap never moves focus off Ghostty's hidden textarea — that's
 *  what preserves the current focus while using a toolbar control. No ordinary key focuses the terminal;
 *  only the dedicated keyboard action is allowed to request software-keyboard focus.
 *
 *  Pointer input follows normal button semantics: touching a key only arms it; the action fires after a
 *  completed pointerup inside the same key. Sliding away or receiving pointercancel aborts it. We handle
 *  pointerup ourselves because iOS Safari can drop synthesized clicks under `touch-action: none`; `click`
 *  remains a deduped fallback for VoiceOver and hardware-keyboard activation. Repeat keys wait for an
 *  intentional hold before emitting, while a short tap emits once on release. */
export function TerminalKeyBar({
  ctrlLocked,
  onToggleCtrl,
  onKey,
  onOpenFiles,
  filesCount = 0,
  chatOpen,
  onToggleChat,
  onOpenKeyboard,
}: {
  ctrlLocked: boolean;
  onToggleCtrl: () => void;
  onKey: (label: string) => void;
  onOpenFiles: () => void;
  filesCount?: number;
  chatOpen: boolean;
  /** Toggle the compact prompt composer. Clipboard-menu Paste remains a separate, direct action. */
  onToggleChat: () => void;
  /** The only terminal-toolbar action allowed to request software-keyboard focus. */
  onOpenKeyboard: () => void;
}) {
  const [dpadOpen, setDpadOpen] = useState(false);
  const dpadId = useId();
  const repeat = useAutoRepeat();
  const toolbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    // React delegates touchmove through a passive root listener. Bind directly so preventDefault remains
    // effective on iOS when a gesture starts in the toolbar's button-free safe-area padding.
    const preventToolbarPan = (event: TouchEvent) => {
      if (event.cancelable) event.preventDefault();
    };
    toolbar.addEventListener("touchmove", preventToolbarPan, { passive: false });
    return () => toolbar.removeEventListener("touchmove", preventToolbarPan);
  }, []);
  useEffect(() => {
    if (chatOpen) setDpadOpen(false);
  }, [chatOpen]);
  useEffect(() => {
    if (!dpadOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!toolbarRef.current?.contains(event.target as Node)) setDpadOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [dpadOpen]);
  // Pointer capture keeps release delivery reliable; bounds + the canceled flag still preserve slide-away
  // cancellation. Only one primary pointer owns this compact toolbar at a time.
  const activePointer = useRef<{ id: number; element: HTMLButtonElement; canceled: boolean } | undefined>(undefined);
  // Timestamp of the last completed pointer sequence so its synthesized click can be deduped. This is also
  // updated for canceled presses: some Android WebViews still synthesize a click after capture cancellation.
  const lastPointerCompletion = useRef(0);
  const activate = (fn: () => void) => {
    haptic();
    fn();
  };
  // `repeat` marks cursor keys that press-and-hold so holding them auto-repeats.
  type Cell = {
    label: string;
    aria: string;
    on: () => void;
    active?: boolean;
    icon?: IconName;
    repeat?: RepeatProfile;
    expanded?: boolean;
    controls?: string;
  };
  const escape: Cell = { label: "ESC", aria: "Escape", on: () => onKey("Esc") };
  const tab: Cell = { label: "TAB", aria: "Tab", on: () => onKey("Tab") };
  const control: Cell = { label: "CTRL", aria: "Control (sticky)", on: onToggleCtrl, active: ctrlLocked };
  const arrows = {
    left: { label: "←", aria: "Arrow left", on: () => onKey("ArrowLeft"), repeat: ARROW_REPEAT },
    up: { label: "↑", aria: "Arrow up", on: () => onKey("ArrowUp"), repeat: ARROW_REPEAT },
    down: { label: "↓", aria: "Arrow down", on: () => onKey("ArrowDown"), repeat: ARROW_REPEAT },
    right: { label: "→", aria: "Arrow right", on: () => onKey("ArrowRight"), repeat: ARROW_REPEAT },
  } satisfies Record<string, Cell>;
  const files: Cell = {
    label: "Files",
    aria: filesCount > 0 ? `Files, ${filesCount} new` : "Files",
    on: () => {
      setDpadOpen(false);
      onOpenFiles();
    },
    icon: "paperclip",
  };
  const dpad: Cell = {
    label: "D-pad",
    aria: "Arrow keys",
    on: () => {
      if (chatOpen) onToggleChat();
      setDpadOpen((open) => !open);
    },
    icon: "dpad",
    active: dpadOpen,
    expanded: dpadOpen,
    controls: dpadId,
  };
  const chat: Cell = {
    label: "Chat",
    aria: "Chat input",
    on: () => {
      setDpadOpen(false);
      onToggleChat();
    },
    icon: "chat",
    active: chatOpen,
  };
  const keyboard: Cell = {
    label: "Keyboard",
    aria: "Show keyboard",
    on: () => {
      setDpadOpen(false);
      onOpenKeyboard();
    },
    icon: "keyboard",
  };
  const renderCell = (c: Cell, extraClass = "") => (
    <button
      key={c.label}
      type="button"
      aria-label={c.aria}
      {...(c.active !== undefined ? { "aria-pressed": c.active } : {})}
      {...(c.expanded !== undefined ? { "aria-expanded": c.expanded } : {})}
      {...(c.controls ? { "aria-controls": c.controls } : {})}
      className={["rc-tk__key", c.active ? "is-on" : "", extraClass].filter(Boolean).join(" ")}
      // preventDefault on mousedown keeps focus on the terminal (→ keyboard stays up).
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e: ReactPointerEvent<HTMLButtonElement>) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const previous = activePointer.current;
        if (previous) tryRelease(previous.element, previous.id);
        repeat.cancel();
        activePointer.current = { id: e.pointerId, element: e.currentTarget, canceled: false };
        if (c.repeat) repeat.start(c.on, c.repeat);
        tryCapture(e.currentTarget, e.pointerId);
      }}
      onPointerMove={(e: ReactPointerEvent<HTMLButtonElement>) => {
        const active = activePointer.current;
        if (!active || active.id !== e.pointerId || active.canceled) return;
        if (!pointerIsInside(e.currentTarget, e)) {
          active.canceled = true;
          repeat.cancel();
        }
      }}
      onPointerLeave={(e: ReactPointerEvent<HTMLButtonElement>) => {
        const active = activePointer.current;
        if (!active || active.id !== e.pointerId) return;
        active.canceled = true;
        repeat.cancel();
      }}
      onPointerUp={(e: ReactPointerEvent<HTMLButtonElement>) => {
        const active = activePointer.current;
        if (!active || active.id !== e.pointerId) return;
        lastPointerCompletion.current = Date.now();
        const shouldActivate = !active.canceled && pointerIsInside(e.currentTarget, e);
        const didRepeat = c.repeat ? repeat.finish() : false;
        tryRelease(e.currentTarget, e.pointerId);
        activePointer.current = undefined;
        if (shouldActivate && !didRepeat) activate(c.on);
      }}
      onPointerCancel={(e: ReactPointerEvent<HTMLButtonElement>) => {
        const active = activePointer.current;
        if (!active || active.id !== e.pointerId) return;
        lastPointerCompletion.current = Date.now();
        repeat.cancel();
        tryRelease(e.currentTarget, e.pointerId);
        activePointer.current = undefined;
      }}
      // VoiceOver / a hardware keyboard emit a click without a pointer sequence. A touch-generated click is
      // ignored because pointerup already completed (or canceled) that press.
      onClick={() => {
        if (Date.now() - lastPointerCompletion.current < 700) return;
        repeat.cancel();
        activate(c.on);
      }}
    >
      {c.icon ? <Icon name={c.icon} size={18} /> : c.label}
    </button>
  );
  return (
    <div ref={toolbarRef} className="rc-termkeys" role="toolbar" aria-label="Terminal keys">
      <div className="rc-termkeys__grid">
        {dpadOpen && (
          <div id={dpadId} className="rc-termkeys__dpad" role="group" aria-label="Arrow keys">
            {renderCell(arrows.up, "rc-tk__key--arrow rc-tk__key--arrow-up")}
            {renderCell(arrows.left, "rc-tk__key--arrow rc-tk__key--arrow-left")}
            {renderCell(arrows.down, "rc-tk__key--arrow rc-tk__key--arrow-down")}
            {renderCell(arrows.right, "rc-tk__key--arrow rc-tk__key--arrow-right")}
          </div>
        )}
        {renderCell(control, "rc-tk__key--standard")}
        {renderCell(escape, "rc-tk__key--standard")}
        {renderCell(tab, "rc-tk__key--standard")}
        <span className="rc-termkeys__utility-wrap">
          {renderCell(files, "rc-tk__key--utility")}
          {filesCount > 0 && (
            <i className="rc-tk__badge" aria-hidden>
              {filesCount > 99 ? "99+" : filesCount}
            </i>
          )}
        </span>
        {renderCell(dpad, "rc-tk__key--utility rc-tk__key--dpad")}
        {renderCell(chat, "rc-tk__key--utility")}
        {renderCell(keyboard, "rc-tk__key--utility rc-tk__key--keyboard")}
      </div>
    </div>
  );
}
