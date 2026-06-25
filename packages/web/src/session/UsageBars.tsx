import type { UsageBar, UsageInfo } from "../types/server";

export interface UsageBarsProps {
  /** The latest GET /usage snapshot. Null/undefined or with no bars → renders nothing. */
  usage?: UsageInfo | null;
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
 * Shorten a reset string for the tight caption: drop a trailing "(timezone)" and collapse a
 * "<date> at <time>" to just the time. "Jun 25 at 11:30pm (Europe/Istanbul)" → "11:30pm";
 * "in 2h" stays "in 2h". Pure.
 */
export function shortenReset(resets: string): string {
  let s = resets.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const atIdx = s.toLowerCase().lastIndexOf(" at ");
  if (atIdx !== -1) s = s.slice(atIdx + 4).trim();
  return s || resets.trim();
}

function UsageBarRow({ label, bar }: { label: string; bar: UsageBar }) {
  // Clamp the rendered width to 0–100 even if the server ever reports out-of-range; the displayed
  // percent text stays the raw value so it's honest.
  const width = Math.max(0, Math.min(100, bar.percent));
  return (
    <div className="rc-usage__row">
      <div className="rc-usage__line">
        <span className="rc-usage__label">{label}</span>
        <span className="rc-usage__pct">{bar.percent}%</span>
      </div>
      <div
        className="rc-usage__track"
        role="progressbar"
        aria-valuenow={bar.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} limit ${bar.percent}% used`}
      >
        <span className="rc-usage__fill" style={{ width: `${width}%`, background: usageFillColor(bar.percent) }} />
      </div>
      <span className="rc-usage__reset">resets {shortenReset(bar.resets)}</span>
    </div>
  );
}

/**
 * Two slim, quiet progress bars at the very top of the session rail: the 5-hour SESSION limit and the
 * WEEKLY (all-models) limit. A passive indicator, not a hero — tight spacing, hairline track, the one
 * coral accent until a bar crosses the warning thresholds. Renders NOTHING when there's no usage data
 * (the feature is unavailable) or neither bar is present.
 */
export function UsageBars({ usage }: UsageBarsProps) {
  if (!usage || (!usage.session && !usage.week)) return null;
  return (
    <div className="rc-usage" aria-label="Claude usage limits">
      {usage.session && <UsageBarRow label="Session" bar={usage.session} />}
      {usage.week && <UsageBarRow label="Weekly" bar={usage.week} />}
      <style>{usageBarsCss}</style>
    </div>
  );
}

const usageBarsCss = `
.rc-usage {
  flex: none;
  display: flex; flex-direction: column; gap: var(--sp-3);
  padding: calc(11px + env(safe-area-inset-top, 0px)) 13px 12px;
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
