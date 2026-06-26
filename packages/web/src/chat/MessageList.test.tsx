import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageList } from "./MessageList";
import { emptyView } from "../store/frame-reducer";
import type { SessionView } from "../store/frame-reducer";

function viewWith(partial: Partial<SessionView>): SessionView {
  return { ...emptyView(), ...partial };
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

  it("renders an interrupted turn as a calm 'stopped' marker, not a red error", () => {
    render(
      <MessageList
        view={viewWith({
          turns: [
            { kind: "assistant-text", text: "Working on it…" },
            // An aborted turn carries isError:true at the protocol level but is calm — `stopped` wins.
            { kind: "result", result: "Interrupted by user", isError: true, stopped: true, totalCostUsd: 0 },
          ],
        })}
      />,
    );
    // Reads "stopped" — not "error", and not the raw "Interrupted by user" CLI text.
    expect(screen.getByText("stopped")).toBeInTheDocument();
    expect(screen.queryByText("error")).not.toBeInTheDocument();
    expect(screen.queryByText(/interrupted by user/i)).not.toBeInTheDocument();
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

    it("expands a step to show the full input AND a readable Result panel (extracted text, no JSON scaffolding)", async () => {
      render(<MessageList view={cluster} />);
      await userEvent.click(screen.getByRole("button", { name: /expand worked steps/i }));
      await userEvent.click(screen.getByRole("button", { name: /expand bash step/i }));
      // The verbose detail is reachable: an Input panel + a Result panel.
      expect(screen.getByText("Input")).toBeInTheDocument();
      expect(screen.getByText("Result")).toBeInTheDocument();
      // The result shows the human TEXT (real content), not the escaped JSON scaffolding it used to dump.
      expect(screen.getByText(/Sent untitled\.wav \(4\.8 MB\)\./)).toBeInTheDocument();
      expect(screen.queryByText(/"type": "text"/)).not.toBeInTheDocument();
    });

    it("renders a multi-line Bash command as a real shell block, not an escaped-JSON dump", async () => {
      render(
        <MessageList
          view={viewWith({
            turns: [
              {
                kind: "tool-use",
                id: "b1",
                name: "Bash",
                input: { command: 'cd /tmp\ngit add .\ngit commit -m "msg"', description: "deploy" },
              },
              { kind: "tool-result", toolUseId: "b1", content: "ok" },
            ],
          })}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: /expand worked steps/i }));
      await userEvent.click(screen.getByRole("button", { name: /expand bash step/i }));
      // The command renders as real shell text (its later lines are present in the highlighted block)...
      expect(screen.getAllByText(/git commit -m/).length).toBeGreaterThan(0);
      // ...not the old escaped single-line JSON object (no "command": key dumped as text).
      expect(screen.queryByText(/"command":/)).not.toBeInTheDocument();
    });

    it("syntax-highlights a Read result as code in the file's language (not a plain panel)", async () => {
      const { container } = render(
        <MessageList
          view={viewWith({
            turns: [
              {
                kind: "tool-use",
                id: "r1",
                name: "Read",
                input: { file_path: "/x/app/page.tsx", offset: 658, limit: 2 },
              },
              { kind: "tool-result", toolUseId: "r1", content: "     658\tflushRealtime();\n     659\treturn;" },
            ],
          })}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: /expand worked steps/i }));
      await userEvent.click(screen.getByRole("button", { name: /expand read step/i }));
      // The result renders through CodeBlock for the file's language (a tsx code card), not a plain pre.
      expect(container.querySelector('[data-language="tsx"]')).not.toBeNull();
    });

    it("renders an answered AskUserQuestion as a clean Q&A card, not raw MCP plumbing", () => {
      render(
        <MessageList
          view={viewWith({
            turns: [
              {
                kind: "asked-question",
                id: "q1",
                questions: [{ header: "Resim", question: "Ne yapmak istersin?" }],
                answer: "Başka bir şey yok",
              },
            ],
          })}
        />,
      );
      expect(screen.getByText("Asked you")).toBeInTheDocument();
      expect(screen.getByText("Ne yapmak istersin?")).toBeInTheDocument();
      expect(screen.getByText("Başka bir şey yok")).toBeInTheDocument();
    });

    it("does not render a still-unanswered AskUserQuestion (the live iris prompt covers a pending one)", () => {
      render(
        <MessageList
          view={viewWith({ turns: [{ kind: "asked-question", id: "q1", questions: [{ question: "Pending?" }] }] })}
        />,
      );
      expect(screen.queryByText("Pending?")).not.toBeInTheDocument();
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

  describe("rewind affordance (REWIND / CHECKPOINT)", () => {
    it("shows a rewind affordance on a user turn that carries a checkpointId", () => {
      const onRewind = vi.fn();
      render(
        <MessageList
          view={viewWith({
            turns: [{ kind: "user", blocks: [{ type: "text", text: "do the thing" }], checkpointId: "cp-9" }],
          })}
          onRewind={onRewind}
        />,
      );
      expect(screen.getByRole("button", { name: /rewind to here/i })).toBeInTheDocument();
    });

    it("does NOT show a rewind affordance on a user turn without a checkpointId (not yet rewindable)", () => {
      render(
        <MessageList
          view={viewWith({ turns: [{ kind: "user", blocks: [{ type: "text", text: "optimistic" }] }] })}
          onRewind={vi.fn()}
        />,
      );
      expect(screen.queryByRole("button", { name: /rewind to here/i })).not.toBeInTheDocument();
    });

    it("does NOT show a rewind affordance when no onRewind handler is provided", () => {
      render(
        <MessageList
          view={viewWith({
            turns: [{ kind: "user", blocks: [{ type: "text", text: "x" }], checkpointId: "cp-1" }],
          })}
        />,
      );
      expect(screen.queryByRole("button", { name: /rewind to here/i })).not.toBeInTheDocument();
    });

    it("calls onRewind with the turn's checkpointId when the affordance is tapped", async () => {
      const onRewind = vi.fn();
      render(
        <MessageList
          view={viewWith({
            turns: [{ kind: "user", blocks: [{ type: "text", text: "do the thing" }], checkpointId: "cp-9" }],
          })}
          onRewind={onRewind}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: /rewind to here/i }));
      expect(onRewind).toHaveBeenCalledWith("cp-9");
    });

    it("renders a successful 'Rewound to here' marker for a code rewind", () => {
      render(
        <MessageList view={viewWith({ turns: [{ kind: "rewound", checkpointId: "cp-9", mode: "code", ok: true }] })} />,
      );
      expect(screen.getByText(/rewound to here/i)).toBeInTheDocument();
    });

    it("renders a failed rewind marker with its error", () => {
      render(
        <MessageList
          view={viewWith({
            turns: [
              {
                kind: "rewound",
                checkpointId: "cp-9",
                mode: "both",
                ok: false,
                error: "File rewinding is not enabled.",
              },
            ],
          })}
        />,
      );
      expect(screen.getByText(/file rewinding is not enabled/i)).toBeInTheDocument();
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
              {
                kind: "attachment",
                id: "a3",
                path: "/Users/me/x.png",
                name: "x.png",
                caption: "your chart",
                isImage: true,
              },
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
              {
                kind: "tool-result",
                toolUseId: "t1",
                content: [{ type: "text", text: "Sent untitled.wav (4.8 MB)." }],
              },
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
              {
                kind: "attachment",
                id: "a5",
                path: "/Users/me/y.pdf",
                name: "y.pdf",
                caption: "a doc",
                isImage: false,
              },
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
