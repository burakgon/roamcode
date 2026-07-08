import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageBars, usageFillColor, shortenReset } from "./UsageBars";
import type { UsageInfo } from "../types/server";

const usage: UsageInfo = {
  session: { percent: 12, resets: "Jun 25 at 11:30pm (Europe/Istanbul)" },
  week: { percent: 72, resets: "Jun 25 at 10pm (Europe/Istanbul)" },
  weekSonnet: { percent: 2, resets: "Jun 25 at 9:59pm (Europe/Istanbul)" },
  fetchedAt: 1000,
};

describe("UsageBars", () => {
  // A fixed local "now" on Jun 25 so the fixture's same-day resets shorten to just the time.
  const NOW = new Date(2026, 5, 25, 12, 0, 0).getTime();
  it("renders the Session + Weekly bars with their percent and reset captions", () => {
    // clientTz matches the fixture's zone → the caption shows the host time as-is (the common case).
    render(<UsageBars usage={usage} now={NOW} clientTz="Europe/Istanbul" />);
    expect(screen.getByText("Session")).toBeInTheDocument();
    expect(screen.getByText("Weekly")).toBeInTheDocument();
    expect(screen.getByText("12%")).toBeInTheDocument();
    expect(screen.getByText("72%")).toBeInTheDocument();
    // The reset caption is shortened to just the time.
    expect(screen.getByText("resets 11:30pm")).toBeInTheDocument();
    expect(screen.getByText("resets 10pm")).toBeInTheDocument();
  });

  it("re-expresses the reset in the VIEWER's timezone when the phone differs from the host", () => {
    // Host reports Istanbul (UTC+3); the phone is in New York (EDT, UTC-4 in June) → NY is 7h behind:
    // 11:30pm IST → 4:30pm EDT, 10pm IST → 3pm EDT (both still Jun 25 in NY, so time-only). A UTC-anchored
    // `now` keeps "today" (in NY) deterministic regardless of the CI runner's own timezone.
    render(<UsageBars usage={usage} now={Date.UTC(2026, 5, 25, 12, 0, 0)} clientTz="America/New_York" />);
    expect(screen.getByText("resets 4:30pm")).toBeInTheDocument(); // session
    expect(screen.getByText("resets 3pm")).toBeInTheDocument(); // weekly
  });

  it("shows the weekly reset's DATE and TIME when it's days away (the real-world case)", () => {
    // The weekly limit resets ~a week out — the caption must carry the time, not just the date, so you
    // can see exactly when ("kaçta"). The 5-hour session stays time-only (same day).
    const daysAway = {
      session: { percent: 12, resets: "Jun 25 at 11:30pm (Europe/Istanbul)" },
      week: { percent: 72, resets: "Jul 1 at 10pm (Europe/Istanbul)" },
      fetchedAt: 1000,
    };
    render(<UsageBars usage={daysAway} now={NOW} clientTz="Europe/Istanbul" />);
    expect(screen.getByText("resets 11:30pm")).toBeInTheDocument();
    expect(screen.getByText("resets Jul 1 at 10pm")).toBeInTheDocument();
  });

  it("exposes each bar as an accessible progressbar with the right value + label", () => {
    render(<UsageBars usage={usage} />);
    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(2);
    const session = screen.getByRole("progressbar", { name: "Session limit 12% used" });
    expect(session).toHaveAttribute("aria-valuenow", "12");
    expect(session).toHaveAttribute("aria-valuemin", "0");
    expect(session).toHaveAttribute("aria-valuemax", "100");
    expect(screen.getByRole("progressbar", { name: "Weekly limit 72% used" })).toBeInTheDocument();
  });

  it("sets each fill width to its percent", () => {
    const { container } = render(<UsageBars usage={usage} />);
    const fills = container.querySelectorAll<HTMLElement>(".rc-usage__fill");
    expect(fills).toHaveLength(2);
    expect(fills[0]!.style.width).toBe("12%");
    expect(fills[1]!.style.width).toBe("72%");
  });

  it("renders only the bars that are present (Session only)", () => {
    render(<UsageBars usage={{ session: { percent: 5, resets: "in 2h" }, fetchedAt: 0 }} />);
    expect(screen.getByText("Session")).toBeInTheDocument();
    expect(screen.queryByText("Weekly")).not.toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.getByText("resets in 2h")).toBeInTheDocument();
  });

  it("renders nothing when usage is null/undefined or has no bars", () => {
    const { container: a } = render(<UsageBars usage={null} />);
    expect(a.querySelector(".rc-usage")).toBeNull();
    const { container: b } = render(<UsageBars usage={undefined} />);
    expect(b.querySelector(".rc-usage")).toBeNull();
    const { container: c } = render(<UsageBars usage={{ fetchedAt: 0 }} />);
    expect(c.querySelector(".rc-usage")).toBeNull();
  });
});

describe("usageFillColor", () => {
  it("is coral ≤70%, amber 71–90%, red >90%", () => {
    expect(usageFillColor(0)).toBe("var(--coral)");
    expect(usageFillColor(70)).toBe("var(--coral)");
    expect(usageFillColor(71)).toBe("var(--warn)");
    expect(usageFillColor(90)).toBe("var(--warn)");
    expect(usageFillColor(91)).toBe("var(--err)");
    expect(usageFillColor(100)).toBe("var(--err)");
  });
});

describe("shortenReset", () => {
  // A fixed local "now" on Jun 25 so "today" is deterministic regardless of the runner's clock/timezone.
  const NOW = new Date(2026, 5, 25, 12, 0, 0).getTime();
  // A UTC-anchored now for the timezone-conversion cases, so the expected wall-clock is runner-tz-independent.
  const NOW_UTC = Date.UTC(2026, 5, 25, 12, 0, 0);
  const IST = "Europe/Istanbul"; // fixed UTC+3 (no DST) → deterministic fixtures

  it("drops the timezone and shows just the time when the reset is later TODAY", () => {
    // clientTz == the reset's zone → the proven passthrough (the common case: phone + host in the same zone).
    expect(shortenReset("Jun 25 at 11:30pm (Europe/Istanbul)", NOW, IST)).toBe("11:30pm");
    expect(shortenReset("Jun 25 at 10pm", NOW, IST)).toBe("10pm");
  });
  it("keeps the DATE and the TIME when the reset is a different day (the weekly's 'kaçta')", () => {
    expect(shortenReset("Jul 2 at 10pm (Europe/Istanbul)", NOW, IST)).toBe("Jul 2 at 10pm");
    expect(shortenReset("Jul 8 at 9:59pm", NOW, IST)).toBe("Jul 8 at 9:59pm");
  });
  it("keeps strings without an 'at' clause (e.g. relative)", () => {
    expect(shortenReset("in 2h", NOW, IST)).toBe("in 2h");
  });

  it("converts the reset into the VIEWER's timezone when it differs from the host's", () => {
    // Istanbul (UTC+3) → New York (EDT, UTC-4) is 7h behind.
    // 10pm IST on Jul 2 = 3pm EDT on Jul 2 (a different day from Jun 25 → date + time).
    expect(shortenReset("Jul 2 at 10pm (Europe/Istanbul)", NOW_UTC, "America/New_York")).toBe("Jul 2 at 3pm");
    // 11:30pm IST on Jun 25 = 4:30pm EDT on Jun 25 (same day in NY → time only).
    expect(shortenReset("Jun 25 at 11:30pm (Europe/Istanbul)", NOW_UTC, "America/New_York")).toBe("4:30pm");
  });
  it("converts across a midnight boundary (a next-day host time can land TODAY for the viewer)", () => {
    // 1am IST on Jun 26 = 6pm EDT on Jun 25 — the calendar day rolls BACK, landing on the viewer's today.
    expect(shortenReset("Jun 26 at 1am (Europe/Istanbul)", NOW_UTC, "America/New_York")).toBe("6pm");
  });
  it("passes a reset through unchanged when it carries no '(tz)' to convert from", () => {
    // No "(tz)" in the string → nothing to convert against → the host-time string is shown as-is.
    expect(shortenReset("Jul 2 at 10pm", NOW, "America/New_York")).toBe("Jul 2 at 10pm");
    expect(shortenReset("Jun 25 at 10pm", NOW, "America/New_York")).toBe("10pm"); // same-day → time only
  });
});
