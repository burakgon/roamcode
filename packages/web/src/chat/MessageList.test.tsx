import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageList } from "./MessageList";
import type { SessionView } from "../store/frame-reducer";

function viewWith(partial: Partial<SessionView>): SessionView {
  return { liveText: "", thinkingText: "", turns: [], diagnostics: [], wireState: "idle", lastSeq: 0, ...partial };
}

describe("MessageList", () => {
  it("renders assistant text, a tool-use row, and a result summary", () => {
    render(
      <MessageList
        view={viewWith({
          turns: [
            { kind: "assistant-text", text: "Creating the file." },
            { kind: "tool-use", id: "tu1", name: "Write", input: { file_path: "/a.txt" } },
            { kind: "result", result: "Done", isError: false, totalCostUsd: 0.0123 },
          ],
        })}
      />,
    );
    expect(screen.getByText(/creating the file/i)).toBeInTheDocument();
    expect(screen.getByText("Write")).toBeInTheDocument();
    expect(screen.getByText(/done/i)).toBeInTheDocument();
    expect(screen.getByText(/0\.0123/)).toBeInTheDocument();
  });

  it("renders in-flight streaming liveText", () => {
    render(<MessageList view={viewWith({ liveText: "streaming tokens…", wireState: "streaming" })} />);
    expect(screen.getByText(/streaming tokens/i)).toBeInTheDocument();
  });

  it("renders a tool-result", () => {
    render(
      <MessageList view={viewWith({ turns: [{ kind: "tool-result", toolUseId: "tu1", content: "file written" }] })} />,
    );
    expect(screen.getByText(/file written/i)).toBeInTheDocument();
  });

  it("renders the tool-use input path in mono", () => {
    render(
      <MessageList
        view={viewWith({
          turns: [{ kind: "tool-use", id: "tu1", name: "Write", input: { file_path: "/some/path.ts" } }],
        })}
      />,
    );
    expect(screen.getByText("/some/path.ts")).toBeInTheDocument();
  });

  it("accumulates streaming deltas into a single growing message (no duplication)", () => {
    // First render with a partial stream.
    const { rerender } = render(<MessageList view={viewWith({ liveText: "Hello", wireState: "streaming" })} />);
    expect(screen.getByText("Hello")).toBeInTheDocument();
    // A later frame extends the same liveText — there must be exactly one live message, not two.
    rerender(<MessageList view={viewWith({ liveText: "Hello, world", wireState: "streaming" })} />);
    expect(screen.getByText("Hello, world")).toBeInTheDocument();
    expect(screen.queryByText("Hello")).not.toBeInTheDocument();
    // No duplicate "Hello, world" nodes.
    expect(screen.getAllByText("Hello, world")).toHaveLength(1);
  });

  describe("markdown is XSS-safe", () => {
    it("does NOT render raw HTML from a <script> payload in model output", () => {
      const payload = "Here is text\n\n<script>window.__XSS__ = true</script>\n\nand more";
      render(<MessageList view={viewWith({ turns: [{ kind: "assistant-text", text: payload }] })} />);
      // The script must NOT have executed, and no <script> element should be injected.
      expect((window as unknown as { __XSS__?: boolean }).__XSS__).toBeUndefined();
      expect(document.querySelector("script")).toBeNull();
      // Surrounding markdown text still renders.
      expect(screen.getByText(/here is text/i)).toBeInTheDocument();
    });

    it("does NOT render a raw <img onerror> payload as an HTML element", () => {
      const payload = `<img src=x onerror="window.__XSS_IMG__ = true">`;
      render(<MessageList view={viewWith({ turns: [{ kind: "assistant-text", text: payload }] })} />);
      // No <img> element injected from untrusted text → no onerror handler can fire.
      expect(document.querySelector("img")).toBeNull();
      expect((window as unknown as { __XSS_IMG__?: boolean }).__XSS_IMG__).toBeUndefined();
    });
  });

  it("renders fenced code as a highlightable code block (text, not HTML)", () => {
    const md = "```ts\nconst x: number = 1;\n```";
    render(<MessageList view={viewWith({ turns: [{ kind: "assistant-text", text: md }] })} />);
    // The code is present as text inside a <pre><code> block.
    const code = screen.getByText(/const x: number = 1;/);
    expect(code).toBeInTheDocument();
    expect(code.closest("pre")).not.toBeNull();
  });

  describe("inline images from user content blocks", () => {
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
      // The src is a data: URI built from media_type + base64 — no raw HTML injection.
      expect(img).toHaveAttribute("src", "data:image/png;base64,QUJD");
      // Accessible alt text is present.
      expect(img).toHaveAttribute("alt", "attachment");
    });
  });

  describe("download chips from tool-result file paths", () => {
    it("renders a download chip linking to the download URL when a downloadUrl builder is provided", () => {
      const downloadUrl = (p: string) => `https://host/fs/download?path=${encodeURIComponent(p)}&token=tok`;
      render(
        <MessageList
          view={viewWith({
            turns: [
              { kind: "tool-result", toolUseId: "tu1", content: "File created at: /private/tmp/rc-spike/spike.txt" },
            ],
          })}
          downloadUrl={downloadUrl}
        />,
      );
      // The chip is a labeled, keyboard-operable link with a download attribute.
      const link = screen.getByRole("link", { name: /spike\.txt/i });
      expect(link).toHaveAttribute(
        "href",
        "https://host/fs/download?path=%2Fprivate%2Ftmp%2Frc-spike%2Fspike.txt&token=tok",
      );
      expect(link).toHaveAttribute("download");
    });

    it("renders no chips when no downloadUrl builder is provided (download disabled)", () => {
      render(
        <MessageList
          view={viewWith({
            turns: [
              { kind: "tool-result", toolUseId: "tu1", content: "File created at: /private/tmp/rc-spike/spike.txt" },
            ],
          })}
        />,
      );
      expect(screen.queryByRole("link")).toBeNull();
      // The raw text still renders.
      expect(screen.getByText(/spike\.txt/i)).toBeInTheDocument();
    });
  });

  describe("claude 'sends' a file/image by naming a path in its OWN response text", () => {
    const downloadUrl = (p: string) => `https://host/fs/download?path=${encodeURIComponent(p)}&token=tok`;

    it("makes a file path in assistant text downloadable (the reported 'send me file X' flow)", () => {
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
          view={viewWith({
            turns: [{ kind: "assistant-text", text: "Here is the chart: /Users/me/chart.png" }],
          })}
          downloadUrl={downloadUrl}
        />,
      );
      const img = screen.getByRole("img");
      expect(img).toHaveAttribute("src", "https://host/fs/download?path=%2FUsers%2Fme%2Fchart.png&token=tok");
      // ...and it is wrapped in a download link so the user can also save the full file.
      expect(screen.getByRole("link")).toHaveAttribute("download");
    });
  });
});
