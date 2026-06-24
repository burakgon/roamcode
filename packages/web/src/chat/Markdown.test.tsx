import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders a GFM table as a real <table> (not raw pipe text)", () => {
    const md = ["| Name | Age |", "| --- | --- |", "| Alice | 30 |", "| Bob | 25 |"].join("\n");
    const { container } = render(<Markdown>{md}</Markdown>);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll("th").length).toBe(2);
    expect(container.querySelectorAll("td").length).toBe(4);
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();
    // The raw pipe row must NOT appear as literal text (proof it was parsed, not shown verbatim).
    expect(screen.queryByText(/\| Name \| Age \|/)).toBeNull();
  });

  it("still renders ordinary inline markdown", () => {
    render(<Markdown>{"hello **world**"}</Markdown>);
    expect(screen.getByText("world").tagName.toLowerCase()).toBe("strong");
  });
});
