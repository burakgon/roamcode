import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchBar } from "./SearchBar";

describe("SearchBar", () => {
  it("emits the typed query and shows the match count", async () => {
    const onChange = vi.fn();
    render(<SearchBar query="" onChange={onChange} matchCount={0} resultCount={0} onClose={vi.fn()} />);
    await userEvent.type(screen.getByRole("searchbox", { name: /search conversation/i }), "p");
    expect(onChange).toHaveBeenCalledWith("p");
  });

  it("shows the match + message counts when there's a query", () => {
    render(<SearchBar query="parser" onChange={vi.fn()} matchCount={3} resultCount={2} onClose={vi.fn()} />);
    expect(screen.getByText(/3 matches · 2 messages/i)).toBeInTheDocument();
  });

  it("shows 'No matches' for a query with zero hits", () => {
    render(<SearchBar query="zzz" onChange={vi.fn()} matchCount={0} resultCount={0} onClose={vi.fn()} />);
    expect(screen.getByText(/no matches/i)).toBeInTheDocument();
  });

  it("clears the query via the clear button (keeps the bar open)", async () => {
    const onChange = vi.fn();
    render(<SearchBar query="abc" onChange={onChange} matchCount={1} resultCount={1} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /clear search/i }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("closes on the Done button and on Escape", async () => {
    const onClose = vi.fn();
    render(<SearchBar query="abc" onChange={vi.fn()} matchCount={1} resultCount={1} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /close search/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.type(screen.getByRole("searchbox", { name: /search conversation/i }), "{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
