import { useEffect, useState } from "react";
import { Icon } from "../ui/Icon";

/**
 * The one-time "Install this app" nudge. Installing to the home screen is what unlocks Web Push + the
 * home-screen app badge (iOS ONLY delivers those to an installed PWA), so surfacing it after the user's
 * first session — when they've seen the app is useful — measurably raises the opt-in.
 *
 * Two shapes, because the platforms differ:
 *   • Android/Chromium fires `beforeinstallprompt` — we capture it and offer a real "Install" button that
 *     invokes the native install sheet.
 *   • iOS Safari fires NO such event and has no programmatic install, so we show a dismissible tip that
 *     points at the manual Share → "Add to Home Screen" gesture.
 *
 * Dismissal is remembered in localStorage (shown once, ever), and the whole thing self-suppresses when the
 * app is already running installed (standalone) — so it never nags someone who already added it.
 */

// `beforeinstallprompt` isn't in lib.dom's typings — the minimal shape we actually use.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "rc-install-dismissed";

// Capture the install event at MODULE load (once), not inside the component: the browser fires
// `beforeinstallprompt` early — often before the user has had their first session, i.e. before this
// component mounts — so a component-scoped listener would miss it. We stash the latest event here and
// notify any mounted InstallPrompt so it can offer the button whenever it appears.
let deferredPrompt: BeforeInstallPromptEvent | undefined;
const subscribers = new Set<() => void>();
function notify(): void {
  for (const fn of subscribers) fn();
}
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Stop Chrome's default mini-infobar; we present our own affordance instead.
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = undefined;
    notify();
  });
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(display-mode: standalone)")?.matches) return true;
  } catch {
    /* matchMedia unsupported */
  }
  // iOS Safari's legacy standalone flag.
  return (window.navigator as unknown as { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iPadOS 13+ reports as a Mac with touch — cover it via maxTouchPoints.
  const iPadOs = /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod/i.test(ua) || iPadOs;
}

function loadDismissed(): boolean {
  try {
    return window.localStorage?.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}
function saveDismissed(): void {
  try {
    window.localStorage?.setItem(DISMISS_KEY, "1");
  } catch {
    /* storage blocked (private mode) — just hide it for this run */
  }
}

/**
 * @param show gate from the app — pass true only AFTER the first session so the nudge lands once the
 *  user is invested (never on the cold login/landing screen).
 */
export function InstallPrompt({ show }: { show: boolean }) {
  const [canInstall, setCanInstall] = useState(() => Boolean(deferredPrompt));
  const [dismissed, setDismissed] = useState(() => loadDismissed());

  // Re-render when the captured install event arrives/leaves after mount.
  useEffect(() => {
    const onChange = () => setCanInstall(Boolean(deferredPrompt));
    subscribers.add(onChange);
    return () => {
      subscribers.delete(onChange);
    };
  }, []);

  const dismiss = () => {
    saveDismissed();
    setDismissed(true);
  };

  const install = () => {
    const evt = deferredPrompt;
    if (!evt) return;
    void evt.prompt();
    void evt.userChoice.finally(() => {
      // One shot: Chrome can't reuse a consumed prompt. Whatever the choice, retire the nudge.
      deferredPrompt = undefined;
      notify();
      dismiss();
    });
  };

  // Suppress entirely when: the app told us not to yet, already dismissed, already installed, or there's
  // nothing actionable (no captured Android event AND not an iOS device). Renders nothing in tests/jsdom.
  if (!show || dismissed || isStandalone()) return null;
  const ios = !canInstall && isIos();
  if (!canInstall && !ios) return null;

  return (
    <div role="status" className="rc-install">
      <span className="rc-install__icon" aria-hidden="true">
        <Icon name="download" size={16} />
      </span>
      {canInstall ? (
        <>
          <span className="rc-install__text">Install Remote Coder for notifications and a home-screen icon.</span>
          <button type="button" className="rc-install__cta" onClick={install}>
            Install
          </button>
        </>
      ) : (
        <span className="rc-install__text">
          Add to your Home Screen for notifications: tap <strong>Share</strong>{" "}
          <span aria-hidden="true" className="rc-install__share">
            <Icon name="arrow-up" size={12} />
          </span>{" "}
          then <strong>Add to Home Screen</strong>.
        </span>
      )}
      <button type="button" className="rc-install__x" onClick={dismiss} aria-label="Dismiss">
        <Icon name="x" size={15} />
      </button>
      <style>{installCss}</style>
    </div>
  );
}

const installCss = `
.rc-install {
  position: fixed; left: 50%; transform: translateX(-50%);
  bottom: calc(env(safe-area-inset-bottom, 0px) + var(--sp-4));
  z-index: 55; max-width: min(94vw, 460px);
  display: inline-flex; align-items: center; gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-3);
  background: var(--surface-2); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: var(--radius);
  box-shadow: var(--shadow); font-size: var(--fs-sm); line-height: 1.4;
  animation: rc-install-in 220ms ease both;
}
@keyframes rc-install-in { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
.rc-install__icon { flex: none; display: grid; place-items: center; color: var(--coral); }
.rc-install__text { flex: 1 1 auto; min-width: 0; }
.rc-install__share { display: inline-grid; place-items: center; vertical-align: -1px; color: var(--text-muted); }
.rc-install__cta {
  flex: none; min-height: var(--tap-min); padding: 0 var(--sp-4);
  background: var(--coral); color: var(--on-accent); border: 1px solid transparent;
  border-radius: var(--radius-pill); font: inherit; font-weight: 600; cursor: pointer;
}
.rc-install__cta:hover { filter: brightness(1.08); }
.rc-install__x {
  flex: none; display: grid; place-items: center;
  width: var(--tap-min); height: var(--tap-min);
  background: transparent; border: none; color: var(--text-muted); cursor: pointer; border-radius: var(--radius-sm);
}
.rc-install__x:hover { color: var(--text); background: var(--surface); }
`;
