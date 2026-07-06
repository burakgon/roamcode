import type { UsageBar, UsageInfo } from "../types/server";

export interface UsageBarsProps {
  /** The latest GET /usage snapshot. Null/undefined or with no bars → renders nothing. */
  usage?: UsageInfo | null;
  /** Clock for the reset caption's "is it today" decision (the rail already owns a `now` tick).
   *  Defaults to Date.now() when omitted. */
  now?: number;
}

/**
 * Pick the fill color by threshold (subtle, on-brand): ≤70% → coral (the one accent); 70–90% → amber
 * (a genuine warning); >90% → red (at-the-limit). Pure so it's trivially testable.
 */
export function usageFillColor(percent: number): string {
  if (percent > 90) return "var(--err)";
  if (percent > 70) return "var(--warn)";
  return "var(--coral)";
}

/**
 * Shorten a reset string for the tight caption. Drops a trailing "(timezone)", then: if the reset is
 * LATER today, show just the time ("Jun 25 at 11:30pm …" → "11:30pm"); if it's a DIFFERENT day (the
 * common case for the WEEKLY limit, days away), keep the DATE **and** the time ("Jul 2 at 10pm …" →
 * "Jul 2 at 10pm") — the user asked to see when the weekly resets, and the date in front means the time
 * can't be misread as one that already passed today. Anything not in "<Mon> <day> at <time>" form (e.g.
 * "in 2h") passes through. Pure.
 */
export function shortenReset(resets: string, now: number = Date.now()): string {
  const s = resets.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const m = /^([A-Za-z]{3,}\s+\d{1,2})\s+at\s+(.+)$/.exec(s);
  if (!m) return s || resets.trim();
  const date = m[1]!.trim();
  const time = m[2]!.trim();
  let today = "";
  try {
    today = new Date(now).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    today = "";
  }
  // Same day → just the time; different day → the full "<date> at <time>" (tz already stripped).
  return date === today ? time : s;
}

function UsageBarRow({ label, bar, now }: { label: string; bar: UsageBar; now?: number }) {
  // Round + clamp to 0–100: the server normally sends an integer, but a stray float ("66.667%") or an
  // out-of-range value must not print verbatim or set an invalid aria-valuenow on the progressbar.
  const pct = Math.max(0, Math.min(100, Math.round(bar.percent)));
  return (
    <div className="rc-usage__row">
      <div className="rc-usage__line">
        <span className="rc-usage__label">{label}</span>
        <span className="rc-usage__pct">{pct}%</span>
      </div>
      <div
        className="rc-usage__track"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} limit ${pct}% used`}
      >
        <span className="rc-usage__fill" style={{ width: `${pct}%`, background: usageFillColor(pct) }} />
      </div>
      <span className="rc-usage__reset">resets {shortenReset(bar.resets, now)}</span>
    </div>
  );
}

/**
 * Two slim, quiet progress bars at the very top of the session rail: the 5-hour SESSION limit and the
 * WEEKLY (all-models) limit. A passive indicator, not a hero — tight spacing, hairline track, the one
 * coral accent until a bar crosses the warning thresholds. Renders NOTHING when there's no usage data
 * (the feature is unavailable) or neither bar is present.
 */
export function UsageBars({ usage, now }: UsageBarsProps) {
  if (!usage || (!usage.session && !usage.week)) return null;
  return (
    <div className="rc-usage" aria-label="Claude usage limits">
      {usage.session && <UsageBarRow label="Session" bar={usage.session} now={now} />}
      {usage.week && <UsageBarRow label="Weekly" bar={usage.week} now={now} />}
      <style>{usageBarsCss}</style>
    </div>
  );
}

const usageBarsCss = `
.rc-usage {
  flex: none;
  display: flex; flex-direction: column; gap: var(--sp-3);
  padding: 11px 13px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bar-glass);
}
.rc-usage__row { display: flex; flex-direction: column; gap: 5px; }
.rc-usage__line { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2); }
.rc-usage__label {
  font-size: var(--fs-xs); letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--text-muted);
}
.rc-usage__pct {
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text);
  font-variant-numeric: tabular-nums;
}
/* The track is a hairline neutral rail; the fill carries the (mostly coral) accent. */
.rc-usage__track {
  position: relative; height: 4px; border-radius: 999px;
  background: var(--surface-2); border: 1px solid var(--border); overflow: hidden;
}
.rc-usage__fill {
  display: block; height: 100%; border-radius: 999px;
  transition: width 360ms ease;
}
.rc-usage__reset {
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
/* Respect reduced-motion: gate the width transition (the bar still updates, just instantly). */
@media (prefers-reduced-motion: reduce) {
  .rc-usage__fill { transition: none; }
}
`;
