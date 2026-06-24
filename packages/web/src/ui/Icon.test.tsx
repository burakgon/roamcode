import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon, iconForFile } from "./Icon";

describe("Icon", () => {
  it("renders an inline SVG that inherits currentColor", () => {
    const { container } = render(<Icon name="download" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("stroke", "currentColor");
    expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
  });

  it("is decorative (aria-hidden) by default — no accessible name", () => {
    const { container } = render(<Icon name="check" />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).not.toHaveAttribute("aria-label");
  });

  it("exposes an accessible name when given a label", () => {
    render(<Icon name="download" label="Download file" />);
    const img = screen.getByRole("img", { name: "Download file" });
    expect(img.tagName.toLowerCase()).toBe("svg");
  });

  it("respects an explicit size", () => {
    const { container } = render(<Icon name="send" size={24} />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("width", "24");
    expect(svg).toHaveAttribute("height", "24");
  });

  it("renders without throwing for every name in the set", () => {
    const names = [
      "download",
      "paperclip",
      "file",
      "image",
      "audio",
      "bolt",
      "chevron-right",
      "chevron-down",
      "settings",
      "send",
      "terminal",
      "search",
      "check",
      "x",
      "alert",
      "menu",
      "star",
      "arrow-up",
    ] as const;
    for (const name of names) {
      const { container } = render(<Icon name={name} />);
      expect(container.querySelector("svg")).not.toBeNull();
    }
  });
});

describe("iconForFile", () => {
  it("picks image for image extensions", () => {
    expect(iconForFile("/a/b/shot.PNG")).toBe("image");
    expect(iconForFile("photo.jpeg")).toBe("image");
  });
  it("picks audio for audio extensions", () => {
    expect(iconForFile("untitled.wav")).toBe("audio");
    expect(iconForFile("/x/song.mp3")).toBe("audio");
  });
  it("falls back to file for everything else", () => {
    expect(iconForFile("report.pdf")).toBe("file");
    expect(iconForFile("noext")).toBe("file");
  });
});
