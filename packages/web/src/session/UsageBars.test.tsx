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
  it("renders the Session + Weekly bars with their percent and reset captions", () => {
    render(<UsageBars usage={usage} />);
    expect(screen.getByText("Session")).toBeInTheDocument();
    expect(screen.getByText("Weekly")).toBeInTheDocument();
    expect(screen.getByText("12%")).toBeInTheDocument();
    expect(screen.getByText("72%")).toBeInTheDocument();
    // The reset caption is shortened to just the time.
    expect(screen.getByText("resets 11:30pm")).toBeInTheDocument();
    expect(screen.getByText("resets 10pm")).toBeInTheDocument();
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
  it("drops the timezone and collapses '<date> at <time>' to the time", () => {
    expect(shortenReset("Jun 25 at 11:30pm (Europe/Istanbul)")).toBe("11:30pm");
    expect(shortenReset("Jun 25 at 10pm")).toBe("10pm");
  });
  it("keeps strings without an 'at' clause (e.g. relative)", () => {
    expect(shortenReset("in 2h")).toBe("in 2h");
  });
});
