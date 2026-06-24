import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MessageList } from "./MessageList";
import type { SessionView } from "../store/frame-reducer";

function viewWith(partial: Partial<SessionView>): SessionView {
  return { liveText: "", thinkingText: "", turns: [], diagnostics: [], wireState: "idle", lastSeq: 0, ...partial };
}

describe("MessageList", () => {
  it("renders assistant prose and a quiet result marker", () => {
    render(
      <MessageList
        view={viewWith({
          turns: [
            { kind: "assistant-text", text: "Creating the file." },
            { kind: "result", result: "Done", isError: false, totalCostUsd: 0.0123 },
          ],
        })}
      />,
    );
    expect(screen.getByText(/creating the file/i)).toBeInTheDocument();
    // The result marker shows a quiet "done" state and the cost.
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.getByText(/0\.0123/)).toBeInTheDocument();
  });

  it("renders in-flight streaming liveText", () => {
    render(<MessageList view={viewWith({ liveText: "streaming tokens…", wireState: "streaming" })} />);
    expect(screen.getByText(/streaming tokens/i)).toBeInTheDocument();
  });

  it("accumulates streaming deltas into a single growing message (no duplication)", () => {
    const { rerender } = render(<MessageList view={viewWith({ liveText: "Hello", wireState: "streaming" })} />);
    expect(screen.getByText("Hello")).toBeInTheDocument();
    rerender(<MessageList view={viewWith({ liveText: "Hello, world", wireState: "streaming" })} />);
    expect(screen.getByText("Hello, world")).toBeInTheDocument();
    expect(screen.queryByText("Hello")).not.toBeInTheDocument();
    expect(screen.getAllByText("Hello, world")).toHaveLength(1);
  });

  describe("tool clusters (collapsed by default, verbose-on-expand)", () => {
    const cluster = viewWith({
      turns: [
        { kind: "tool-use", id: "t1", name: "Bash", input: { command: "ls -la" } },
        { kind: "tool-result", toolUseId: "t1", content: [{ type: "text", text: "Sent untitled.wav (4.8 MB)." }] },
      ],
    });

    it("renders the cluster collapsed: the 'Worked' header shows, but neither the input nor the raw JSON is in the default view", () => {
      render(<MessageList view={cluster} />);
      // The collapsed cluster header is present.
      expect(screen.getByRole("button", { name: /expand worked steps/i })).toBeInTheDocument();
      expect(screen.getByText(/worked/i)).toBeInTheDocument();
      // Collapsed: the step row, the tool input, and the RAW result JSON are NOT yet rendered.
      expect(screen.queryByText("Bash")).not.toBeInTheDocument();
      expect(screen.queryByText(/ls -la/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Sent untitled\.wav/)).not.toBeInTheDocument();
    });

    it("expands the cluster to reveal a quiet step row with the tool label", async () => {
      render(<MessageList view={cluster} />);
      await userEvent.click(screen.getByRole("button", { name: /expand worked steps/i }));
      expect(screen.getByText("Bash")).toBeInTheDocument();
      // The compact arg summary shows on the row.
      expect(screen.getByText(/ls -la/)).toBeInTheDocument();
      // ...but the RAW result JSON is still behind the step's own expand.
      expect(screen.queryByText(/Sent untitled\.wav/)).not.toBeInTheDocument();
    });

    it("expands a step to show the full input AND the Raw result panel (where the raw JSON now lives)", async () => {
      render(<MessageList view={cluster} />);
      await userEvent.click(screen.getByRole("button", { name: /expand worked steps/i }));
      await userEvent.click(screen.getByRole("button", { name: /expand bash step/i }));
      // The verbose detail is now reachable: an Input panel + a Raw result panel.
      expect(screen.getByText("Input")).toBeInTheDocument();
      expect(screen.getByText("Raw result")).toBeInTheDocument();
      // The raw tool_result JSON (the previously-leaking payload) is present on expand.
      expect(screen.getByText(/Sent untitled\.wav \(4\.8 MB\)\./)).toBeInTheDocument();
      expect(screen.getByText(/"type": "text"/)).toBeInTheDocument();
    });

    it("renders a ToolSearch step de-emphasized (meta) but still present + expandable", async () => {
      render(
        <MessageList
          view={viewWith({
            turns: [
              { kind: "tool-use", id: "m1", name: "ToolSearch", input: { query: "select:send_file" } },
              { kind: "tool-result", toolUseId: "m1", content: "loaded send_file" },
            ],
          })}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: /expand worked steps/i }));
      // The meta line is present (faint summary), and expandable to its payload.
      const metaRow = screen.getByRole("button", { name: /expand toolsearch step/i });
      expect(metaRow).toBeInTheDocument();
      await userEvent.click(metaRow);
      expect(screen.getByText(/select:send_file/)).toBeInTheDocument();
    });
  });

  describe("markdown is XSS-safe", () => {
    it("does NOT render raw HTML from a <script> payload in model output", () => {
      const payload = "Here is text\n\n<script>window.__XSS__ = true</script>\n\nand more";
      render(<MessageList view={viewWith({ turns: [{ kind: "assistant-text", text: payload }] })} />);
      expect((window as unknown as { __XSS__?: boolean }).__XSS__).toBeUndefined();
      expect(document.querySelector("script")).toBeNull();
      expect(screen.getByText(/here is text/i)).toBeInTheDocument();
    });

    it("does NOT render a raw <img onerror> payload as an HTML element", () => {
      const payload = `<img src=x onerror="window.__XSS_IMG__ = true">`;
      render(<MessageList view={viewWith({ turns: [{ kind: "assistant-text", text: payload }] })} />);
      expect(document.querySelector("img")).toBeNull();
      expect((window as unknown as { __XSS_IMG__?: boolean }).__XSS_IMG__).toBeUndefined();
    });
  });

  it("renders fenced code as a highlightable code block (text, not HTML)", () => {
    const md = "```ts\nconst x: number = 1;\n```";
    render(<MessageList view={viewWith({ turns: [{ kind: "assistant-text", text: md }] })} />);
    const code = screen.getByText(/const x: number = 1;/);
    expect(code).toBeInTheDocument();
    expect(code.closest("pre")).not.toBeNull();
  });

  describe("user bubble", () => {
    it("renders the user message with a 'You' label", () => {
      render(
        <MessageList
          view={viewWith({ turns: [{ kind: "user", blocks: [{ type: "text", text: "send me the file" }] }] })}
        />,
      );
      expect(screen.getByText("You")).toBeInTheDocument();
      expect(screen.getByText("send me the file")).toBeInTheDocument();
    });

    it("renders an image content block as an <img> with a data URI (not raw HTML) and alt text", () => {
      render(
        <MessageList
          view={viewWith({
            turns: [
              {
                kind: "user",
                blocks: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }],
              },
            ],
          })}
        />,
      );
      const img = screen.getByRole("img");
      expect(img).toHaveAttribute("src", "data:image/png;base64,QUJD");
      expect(img).toHaveAttribute("alt", "attachment");
    });
  });

  describe("file paths in assistant text become downloadable", () => {
    const downloadUrl = (p: string) => `https://host/fs/download?path=${encodeURIComponent(p)}&token=tok`;

    it("makes a file path in assistant text downloadable (the 'send me file X' flow)", () => {
      render(
        <MessageList
          view={viewWith({
            turns: [{ kind: "assistant-text", text: "Done — I saved it to /Users/me/report.pdf for you." }],
          })}
          downloadUrl={downloadUrl}
        />,
      );
      const link = screen.getByRole("link", { name: /report\.pdf/i });
      expect(link).toHaveAttribute("href", "https://host/fs/download?path=%2FUsers%2Fme%2Freport.pdf&token=tok");
      expect(link).toHaveAttribute("download");
    });

    it("previews an image path from assistant text inline (img src = the download URL)", () => {
      render(
        <MessageList
          view={viewWith({ turns: [{ kind: "assistant-text", text: "Here is the chart: /Users/me/chart.png" }] })}
          downloadUrl={downloadUrl}
        />,
      );
      const img = screen.getByRole("img");
      expect(img).toHaveAttribute("src", "https://host/fs/download?path=%2FUsers%2Fme%2Fchart.png&token=tok");
      expect(screen.getByRole("link")).toHaveAttribute("download");
    });
  });

  describe("attachment card (claude proactively SENDS a file/image)", () => {
    const downloadUrl = (p: string) => `https://host/fs/download?path=${encodeURIComponent(p)}&token=tok`;

    it("renders an image attachment inline as ONE card: an <img> wrapped in a download link + a download affordance", () => {
      render(
        <MessageList
          view={viewWith({
            turns: [{ kind: "attachment", id: "a1", path: "/Users/me/shot.png", name: "shot.png", isImage: true }],
          })}
          downloadUrl={downloadUrl}
        />,
      );
      const img = screen.getByRole("img");
      expect(img).toHaveAttribute("src", "https://host/fs/download?path=%2FUsers%2Fme%2Fshot.png&token=tok");
      // A download affordance is present and points at the same confined URL.
      const dl = screen.getByRole("link", { name: /download shot\.png/i });
      expect(dl).toHaveAttribute("href", "https://host/fs/download?path=%2FUsers%2Fme%2Fshot.png&token=tok");
      expect(dl).toHaveAttribute("download");
    });

    it("renders a non-image attachment as a file card with a download affordance", () => {
      render(
        <MessageList
          view={viewWith({
            turns: [{ kind: "attachment", id: "a2", path: "/Users/me/report.pdf", name: "report.pdf", isImage: false }],
          })}
          downloadUrl={downloadUrl}
        />,
      );
      expect(screen.queryByRole("img")).toBeNull();
      const dl = screen.getByRole("link", { name: /download report\.pdf/i });
      expect(dl).toHaveAttribute("href", "https://host/fs/download?path=%2FUsers%2Fme%2Freport.pdf&token=tok");
      expect(dl).toHaveAttribute("download");
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
    });

    it("renders the caption when present", () => {
      render(
        <MessageList
          view={viewWith({
            turns: [
              { kind: "attachment", id: "a3", path: "/Users/me/x.png", name: "x.png", caption: "your chart", isImage: true },
            ],
          })}
          downloadUrl={downloadUrl}
        />,
      );
      expect(screen.getByText(/your chart/i)).toBeInTheDocument();
    });

    it("does NOT duplicate tool noise: the attachment card stands alone (no leaked Raw result)", () => {
      // A realistic sequence: assistant text + send_file plumbing + the attachment turn. The plumbing
      // is folded into a COLLAPSED cluster; only the clean card + prose are in the default view.
      render(
        <MessageList
          view={viewWith({
            turns: [
              { kind: "assistant-text", text: "On it — attaching it here." },
              { kind: "tool-use", id: "t1", name: "send_file", input: { path: "/Users/me/untitled.wav" } },
              { kind: "tool-result", toolUseId: "t1", content: [{ type: "text", text: "Sent untitled.wav (4.8 MB)." }] },
              { kind: "attachment", id: "a4", path: "/Users/me/untitled.wav", name: "untitled.wav", isImage: false },
            ],
          })}
          downloadUrl={downloadUrl}
        />,
      );
      // The clean card is present...
      expect(screen.getByText("untitled.wav")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /download untitled\.wav/i })).toBeInTheDocument();
      // ...and the raw tool_result is NOT leaking into the default view (it's in the collapsed cluster).
      expect(screen.queryByText(/Sent untitled\.wav \(4\.8 MB\)\./)).not.toBeInTheDocument();
      // The cluster header exists for verbose access.
      expect(screen.getByRole("button", { name: /expand worked steps/i })).toBeInTheDocument();
    });

    it("degrades gracefully without a downloadUrl — shows the name/caption, no broken link", () => {
      render(
        <MessageList
          view={viewWith({
            turns: [
              { kind: "attachment", id: "a5", path: "/Users/me/y.pdf", name: "y.pdf", caption: "a doc", isImage: false },
            ],
          })}
        />,
      );
      expect(screen.queryByRole("link")).toBeNull();
      expect(screen.queryByRole("img")).toBeNull();
      expect(screen.getByText("y.pdf")).toBeInTheDocument();
      expect(screen.getByText(/a doc/i)).toBeInTheDocument();
    });
  });

  describe("NO EMOJI regression", () => {
    it("renders no emoji glyphs anywhere in the conversation", async () => {
      const downloadUrl = (p: string) => `https://host/fs/download?path=${encodeURIComponent(p)}&token=tok`;
      const { container } = render(
        <MessageList
          view={viewWith({
            turns: [
              { kind: "user", blocks: [{ type: "text", text: "send me untitled.wav" }] },
              { kind: "assistant-text", text: "On it." },
              { kind: "tool-use", id: "t1", name: "send_file", input: { path: "/Users/me/untitled.wav" } },
              { kind: "tool-result", toolUseId: "t1", content: [{ type: "text", text: "Sent untitled.wav." }] },
              { kind: "attachment", id: "a1", path: "/Users/me/untitled.wav", name: "untitled.wav", isImage: false },
              { kind: "result", result: "ok", isError: false, totalCostUsd: 0.02 },
            ],
          })}
          downloadUrl={downloadUrl}
        />,
      );
      // Expand everything so even the deepest UI text is in the DOM.
      await userEvent.click(screen.getByRole("button", { name: /expand worked steps/i }));
      const text = container.textContent ?? "";
      // The specific glyphs the redesign replaced with SVG icons must be absent.
      for (const emoji of ["📎", "🎵", "⚡", "⤓", "✕", "×", "♪", "↓", "↑", "⚙", "★", "☰"]) {
        expect(text).not.toContain(emoji);
      }
      // And no characters in the emoji / dingbat / arrow blocks at all.
      expect(text).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u);
    });
  });
});
