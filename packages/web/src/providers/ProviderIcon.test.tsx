import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ProviderIcon } from "./ProviderIcon";

test("an installed provider icon exposes its formatted identity", () => {
  render(<ProviderIcon provider="review-agent" />);
  expect(screen.getByRole("img", { name: "Review Agent" })).toHaveAttribute("title", "Review Agent");
  expect(screen.getByText("re")).toHaveAttribute("aria-hidden", "true");
});
