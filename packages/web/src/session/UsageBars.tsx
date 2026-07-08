import type { UsageBar, UsageInfo } from "../types/server";

export interface UsageBarsProps {
  /** The latest GET /usage snapshot. Null/undefined or with no bars → renders nothing. */
  usage?: UsageInfo | null;
  /** Clock for the reset caption's "is it today" decision (the rail already owns a `now` tick).
   *  Defaults to Date.now() when omitted. */
  now?: number;
  /** The VIEWER's IANA timezone, so a reset expressed in the host Mac's zone is re-shown in the phone's zone.
   *  Omitted → auto-detected from the browser; tests pass it explicitly for determinism. */
  clientTz?: string;
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

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The viewer's IANA timezone (the PHONE, where they're reading it), or undefined if unavailable. */
function detectClientTz(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** The UTC offset (minutes) of an IANA zone AT a given instant — derived by formatting the instant in the
 *  zone and diffing against UTC. Positive = ahead of UTC. Throws on an invalid zone (caller guards). */
function tzOffsetMin(tz: string, epoch: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(epoch))) p[part.type] = part.value;
  const hour = p.hour === "24" ? 0 : Number(p.hour); // some engines emit "24" for midnight
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  return (asUTC - epoch) / 60000;
}

/** Turn a wall-clock time in `tz` into an absolute epoch (ms). Two passes so a DST edge resolves correctly. */
function wallClockToEpoch(y: number, mon: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, mon, d, h, min);
  const off1 = tzOffsetMin(tz, guess);
  let epoch = guess - off1 * 60000;
  const off2 = tzOffsetMin(tz, epoch);
  if (off2 !== off1) epoch = guess - off2 * 60000;
  return epoch;
}

/** Format an instant's time in `tz` the way claude does: "10pm", "11:30pm" (the ":00" minutes dropped). */
function formatTimeInZone(epoch: number, tz: string): string {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(epoch)))
    p[part.type] = part.value;
  const mins = p.minute && p.minute !== "00" ? `:${p.minute}` : "";
  return `${p.hour}${mins}${(p.dayPeriod || "").toLowerCase()}`;
}

/** Re-express a "<Mon> <day> at <time> (<fromTz>)" reset in the VIEWER's zone (`toTz`), applying the same
 *  today→time-only rule. Returns null when it can't parse/convert, so the caller keeps the raw display. */
function resetInViewerZone(resets: string, fromTz: string, toTz: string, now: number): string | null {
  const m = /^\s*([A-Za-z]{3,})\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b/i.exec(resets);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
  if (mon < 0) return null;
  const day = Number(m[2]);
  let hour = Number(m[3]) % 12;
  if (/pm/i.test(m[5]!)) hour += 12;
  const minute = m[4] ? Number(m[4]) : 0;
  try {
    // The year isn't in the string; a reset is always in the near future (≤ a week), so try this year and
    // bump to next only if that lands well in the past (the Dec→Jan rollover).
    const yNow = new Date(now).getFullYear();
    let epoch = wallClockToEpoch(yNow, mon, day, hour, minute, fromTz);
    if (epoch < now - 2 * 86400000) epoch = wallClockToEpoch(yNow + 1, mon, day, hour, minute, fromTz);
    const date = new Date(epoch).toLocaleDateString("en-US", { timeZone: toTz, month: "short", day: "numeric" });
    const today = new Date(now).toLocaleDateString("en-US", { timeZone: toTz, month: "short", day: "numeric" });
    const time = formatTimeInZone(epoch, toTz);
    return date === today ? time : `${date} at ${time}`;
  } catch {
    return null; // invalid IANA zone / Intl failure → keep the raw display
  }
}

/**
 * Shorten a reset string for the tight caption. The reset comes from `claude /usage` in the HOST Mac's
 * timezone, tagged like "… (Europe/Istanbul)". When the VIEWER (the phone) is in a DIFFERENT zone, we
 * re-express the reset in the viewer's zone so the time means what they'd expect where they are; when the
 * zones match (the common case) we keep the proven string path — zero risk to the normal display.
 *
 * Either way: LATER today → just the time ("11:30pm"); a DIFFERENT day (the weekly, days away) → the full
 * "<Mon> <day> at <time>" ("Jul 2 at 10pm") so the time can't be misread as one already passed today.
 * Anything not in "<Mon> <day> at <time>" form (e.g. "in 2h") passes through. Pure (clock + zone injected).
 */
export function shortenReset(
  resets: string,
  now: number = Date.now(),
  clientTz: string | undefined = detectClientTz(),
): string {
  const resetTz = /\(([^)]+)\)\s*$/.exec(resets)?.[1]?.trim();
  if (resetTz && clientTz && resetTz !== clientTz) {
    const converted = resetInViewerZone(resets, resetTz, clientTz, now);
    if (converted !== null) return converted;
    // conversion failed → fall through to the raw (host-tz) string display
  }
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

function UsageBarRow({ label, bar, now, clientTz }: { label: string; bar: UsageBar; now?: number; clientTz?: string }) {
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
      <span className="rc-usage__reset">resets {shortenReset(bar.resets, now, clientTz)}</span>
    </div>
  );
}

/**
 * Two slim, quiet progress bars at the very top of the session rail: the 5-hour SESSION limit and the
 * WEEKLY (all-models) limit. A passive indicator, not a hero — tight spacing, hairline track, the one
 * coral accent until a bar crosses the warning thresholds. Renders NOTHING when there's no usage data
 * (the feature is unavailable) or neither bar is present.
 */
export function UsageBars({ usage, now, clientTz }: UsageBarsProps) {
  if (!usage || (!usage.session && !usage.week)) return null;
  return (
    <div className="rc-usage" aria-label="Claude usage limits">
      {usage.session && <UsageBarRow label="Session" bar={usage.session} now={now} clientTz={clientTz} />}
      {usage.week && <UsageBarRow label="Weekly" bar={usage.week} now={now} clientTz={clientTz} />}
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
