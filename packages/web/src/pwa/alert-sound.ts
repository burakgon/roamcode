/**
 * A short "a session needs you" chime, synthesised with Web Audio so there's no asset to bundle/cache and
 * nothing to 404. iOS/Safari (and Chrome's autoplay policy) keep an AudioContext SUSPENDED until it's
 * resumed inside a real user gesture, so we lazily build it and `unlockAudio()` on the first interaction;
 * a chime requested before that unlock is a silent no-op rather than an error. All calls are best-effort and
 * feature-detected (jsdom / very old browsers have no AudioContext → everything no-ops).
 */

let ctx: AudioContext | undefined;

function getCtx(): AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  const AC =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return undefined;
  if (!ctx) {
    try {
      ctx = new AC();
    } catch {
      return undefined; // construction can throw in locked-down contexts
    }
  }
  return ctx;
}

/**
 * Resume the AudioContext from a user gesture so a LATER programmatic chime (fired from a background poll,
 * not a gesture) is allowed to sound on iOS. Safe to call repeatedly / when already running.
 */
export function unlockAudio(): void {
  const c = getCtx();
  if (c && c.state === "suspended") void c.resume().catch(() => {});
}

/**
 * Play a soft two-note rising chime (A5 → D6). Best-effort: silent where Web Audio is unavailable or the
 * context is still locked (never unlocked by a gesture). Kept short + quiet so it's a gentle nudge.
 */
export function playNeedsYouChime(): void {
  playChime([880, 1174.66], 0.16);
}

/**
 * Play a calm two-note resolving chime for a background session that finished its current turn. Kept
 * distinct from the rising attention sound so the user can tell "done" from "needs input" without looking.
 */
export function playFinishedChime(): void {
  playChime([783.99, 587.33], 0.12);
}

function playChime(frequencies: readonly number[], peakGain: number): void {
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") void c.resume().catch(() => {});
  try {
    const now = c.currentTime;
    for (const [i, freq] of frequencies.entries()) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = now + i * 0.16;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(peakGain, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
      osc.connect(gain).connect(c.destination);
      osc.start(t);
      osc.stop(t + 0.38);
    }
  } catch {
    /* best-effort: a Web Audio hiccup must never break the app */
  }
}

/** Light haptic nudge (feature-detected) to accompany the chime on phones that support it. */
export function needsYouHaptic(): void {
  try {
    navigator.vibrate?.([40, 60, 40]);
  } catch {
    /* unsupported */
  }
}
