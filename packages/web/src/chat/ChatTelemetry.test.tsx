import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatTelemetry, contextFillColor, formatTokens } from "./ChatTelemetry";

describe("ChatTelemetry", () => {
  it("renders the model state as a role=status with a data-state", () => {
    render(<ChatTelemetry wireState="thinking" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("data-state", "thinking");
    expect(screen.getByText("Thinking")).toBeInTheDocument();
  });

  it("shows 'Compacting…' and an alive (working) indicator even when the wire is not in a working state", () => {
    // /compact emits no streaming/tool frames, so the wire stays idle the whole time. The indicator must
    // still read "Compacting…" AND look alive (the animated typing dots render only for working states).
    const { container } = render(<ChatTelemetry wireState="idle" compacting />);
    expect(screen.getByText("Compacting…")).toBeInTheDocument();
    expect(container.querySelector(".rc-tele__dots")).not.toBeNull();
  });

  it("shows 'Reconnecting…' (outranking the wire label + working visuals) when the link is down", () => {
    // Even mid-stream, a dropped socket must read as "Reconnecting…" — not a stuck "Streaming…" with the
    // working animation, which would falsely imply Claude is still producing tokens we can see.
    const { container } = render(<ChatTelemetry wireState="streaming" reconnecting />);
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.queryByText("Streaming")).not.toBeInTheDocument();
    expect(container.querySelector(".rc-tele__dots")).toBeNull();
  });

  it("shows the context meter (percent + token count) from contextTokens", () => {
    render(<ChatTelemetry wireState="idle" contextTokens={92000} />);
    // 92000 / 200000 = 46%.
    expect(screen.getByText("46% · 92k")).toBeInTheDocument();
    expect(screen.getByText("ctx")).toBeInTheDocument();
  });

  it("hides the context meter when there is no usage yet", () => {
    render(<ChatTelemetry wireState="idle" />);
    expect(screen.queryByText("ctx")).not.toBeInTheDocument();
  });

  describe("awaitingReply (the send→first-frame 'Thinking…' bridge)", () => {
    it("shows 'Thinking…' + the working animation the instant a message is submitted (idle wire)", () => {
      // The reported bug: after sending, nothing showed until Claude's first frame. The bridge fills it.
      const { container } = render(<ChatTelemetry wireState="idle" awaitingReply />);
      expect(screen.getByText("Thinking…")).toBeInTheDocument();
      expect(screen.queryByText("Ready")).not.toBeInTheDocument();
      expect(container.querySelector(".rc-tele__dots")).not.toBeNull(); // animated, reads as alive
    });

    it("bridges over a stale 'success' wire too (the common case: send right after the previous reply)", () => {
      render(<ChatTelemetry wireState="success" awaitingReply />);
      expect(screen.getByText("Thinking…")).toBeInTheDocument();
      expect(screen.queryByText("Done")).not.toBeInTheDocument();
    });

    it("does NOT override a real working wire — once tokens flow it reads the live state", () => {
      render(<ChatTelemetry wireState="streaming" awaitingReply />);
      expect(screen.getByText("Streaming")).toBeInTheDocument();
    });

    it("does NOT override an awaiting-you prompt (a permission mid-bridge wins)", () => {
      render(<ChatTelemetry wireState="awaiting" awaitingReply />);
      expect(screen.getByText("Awaiting you")).toBeInTheDocument();
      expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
    });

    it("reconnecting outranks the bridge", () => {
      render(<ChatTelemetry wireState="idle" awaitingReply reconnecting />);
      expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
      expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
    });
  });

  it("shows the cumulative session cost when provided, hidden at zero/absent", () => {
    const { rerender } = render(<ChatTelemetry wireState="idle" cost={0.1234} />);
    expect(screen.getByText("$0.1234")).toBeInTheDocument();
    rerender(<ChatTelemetry wireState="idle" />);
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument();
  });

  it("idle reads as 'Ready' (the composer is open for input)", () => {
    render(<ChatTelemetry wireState="idle" />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("caps the meter at 100% even past the window", () => {
    // Genuinely over a known 1M window → capped at 100%.
    render(<ChatTelemetry wireState="idle" contextTokens={1_200_000} contextWindow={1_000_000} />);
    expect(screen.getByText(/^100% ·/)).toBeInTheDocument();
  });

  it("snaps a too-small name-based window up to 1M when occupancy exceeds it (no false 100%)", () => {
    // 651k tokens can't fit a 200k window, so the name-based guess is wrong — treat it as the 1M tier.
    // (Real case: opus-4-8 running a 1M window, model string with no "1m" marker, no result in buffer.)
    render(<ChatTelemetry wireState="idle" contextTokens={651000} model="claude-opus-4-8" />);
    expect(screen.getByText(/^65% ·/)).toBeInTheDocument();
  });

  it("uses the authoritative contextWindow as the denominator (a 1M session is NOT a false 'full')", () => {
    // 300k of a real 1M window is 30%. Before the fix the meter guessed the window from the model name
    // and divided by 200k, pinning a 1M session to 100% even with plenty of headroom.
    render(<ChatTelemetry wireState="idle" contextTokens={300000} contextWindow={1_000_000} />);
    expect(screen.getByText(/^30% ·/)).toBeInTheDocument();
  });

  it("falls back to the model-name heuristic when contextWindow is absent (1M variant by name)", () => {
    render(<ChatTelemetry wireState="idle" contextTokens={300000} model="claude-opus-4-8[1m]" />);
    expect(screen.getByText(/^30% ·/)).toBeInTheDocument();
  });

  it("falls back to 200k for a standard model when neither contextWindow nor a 1M name is present", () => {
    render(<ChatTelemetry wireState="idle" contextTokens={100000} model="claude-opus-4-8" />);
    expect(screen.getByText(/^50% ·/)).toBeInTheDocument();
  });
});

describe("contextFillColor", () => {
  it("is coral with headroom, amber as it tightens, red when /compact is due", () => {
    expect(contextFillColor(0)).toBe("var(--coral)");
    expect(contextFillColor(80)).toBe("var(--coral)");
    expect(contextFillColor(81)).toBe("var(--warn)");
    expect(contextFillColor(92)).toBe("var(--warn)");
    expect(contextFillColor(93)).toBe("var(--err)");
    expect(contextFillColor(100)).toBe("var(--err)");
  });
});

describe("formatTokens", () => {
  it("renders compact token counts", () => {
    expect(formatTokens(900)).toBe("900");
    expect(formatTokens(5400)).toBe("5.4k");
    expect(formatTokens(90000)).toBe("90k");
    expect(formatTokens(128000)).toBe("128k");
  });
});
