import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuestionPrompt } from "./QuestionPrompt";
import type { QuestionPayload } from "../types/server";

function single(): QuestionPayload {
  return {
    requestId: "rq",
    toolInput: {
      questions: [
        {
          question: "Which language?",
          header: "Language",
          multiSelect: false,
          options: [
            { label: "TypeScript", description: "TS" },
            { label: "Python", description: "Py" },
          ],
        },
      ],
    },
    questions: [
      {
        question: "Which language?",
        header: "Language",
        multiSelect: false,
        options: [
          { label: "TypeScript", description: "TS" },
          { label: "Python", description: "Py" },
        ],
      },
    ],
  };
}

describe("QuestionPrompt", () => {
  test("renders the question, header, and every option with its description", () => {
    render(<QuestionPrompt question={single()} onAnswer={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("Which language?")).toBeInTheDocument();
    expect(screen.getByText("Language")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(screen.getByText("Py")).toBeInTheDocument();
  });

  test("single-select: choosing an option and submitting answers { question: label }", async () => {
    const onAnswer = vi.fn();
    render(<QuestionPrompt question={single()} onAnswer={onAnswer} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /Python/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Submit/ }));
    expect(onAnswer).toHaveBeenCalledWith({ "Which language?": "Python" });
  });

  test("Skip/Cancel calls onCancel and never onAnswer", async () => {
    const onAnswer = vi.fn();
    const onCancel = vi.fn();
    render(<QuestionPrompt question={single()} onAnswer={onAnswer} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole("button", { name: /Skip/ }));
    expect(onCancel).toHaveBeenCalled();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  test("single-select: picking a second option replaces the first", async () => {
    const onAnswer = vi.fn();
    render(<QuestionPrompt question={single()} onAnswer={onAnswer} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /TypeScript/ }));
    await userEvent.click(screen.getByRole("button", { name: /Python/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Submit/ }));
    expect(onAnswer).toHaveBeenCalledWith({ "Which language?": "Python" });
  });

  test("multi-select: toggling options submits a label array", async () => {
    const q = single();
    q.questions[0]!.multiSelect = true;
    (q.toolInput as { questions: { multiSelect: boolean }[] }).questions[0]!.multiSelect = true;
    const onAnswer = vi.fn();
    render(<QuestionPrompt question={q} onAnswer={onAnswer} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /TypeScript/ }));
    await userEvent.click(screen.getByRole("button", { name: /Python/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Submit/ }));
    expect(onAnswer).toHaveBeenCalledWith({ "Which language?": ["TypeScript", "Python"] });
  });

  test("announces an awaiting region, moves focus to it, and option buttons are plain toggles with aria-pressed", async () => {
    render(<QuestionPrompt question={single()} onAnswer={() => {}} onCancel={() => {}} />);
    const region = screen.getByRole("region", { name: /question/i });
    expect(region).toHaveFocus();
    // The iris color is paired with the "Awaiting you" TEXT (color is never the sole signal).
    expect(screen.getByText(/awaiting you/i)).toBeInTheDocument();
    const option = screen.getByRole("button", { name: /TypeScript/ });
    expect(option).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(option);
    expect(option).toHaveAttribute("aria-pressed", "true");
  });

  test("Submit is disabled until every question is answered", async () => {
    render(<QuestionPrompt question={single()} onAnswer={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole("button", { name: /^Submit/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /Python/ }));
    expect(screen.getByRole("button", { name: /^Submit/ })).toBeEnabled();
  });

  test("single-select uses role=group (toggle-button + aria-pressed), not a radiogroup", () => {
    // The single-select branch uses aria-pressed toggle buttons, which mismatch radiogroup
    // semantics (that expects role=radio children). Both branches must be role=group.
    render(<QuestionPrompt question={single()} onAnswer={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("group")).toBeInTheDocument();
  });

  test("single-select Other: choosing it deselects presets, gates Submit on text, and sends the custom string", async () => {
    const onAnswer = vi.fn();
    render(<QuestionPrompt question={single()} onAnswer={onAnswer} onCancel={() => {}} />);

    // Pick a preset first, then switch to Other — the preset must be deselected.
    await userEvent.click(screen.getByRole("button", { name: /TypeScript/ }));
    await userEvent.click(screen.getByRole("button", { name: /Other/ }));
    expect(screen.getByRole("button", { name: /TypeScript/ })).toHaveAttribute("aria-pressed", "false");

    // Submit is gated until the custom text is non-empty.
    expect(screen.getByRole("button", { name: /^Submit/ })).toBeDisabled();
    const input = screen.getByLabelText(/your answer/i);
    expect(input).toHaveFocus();
    await userEvent.type(input, "Rust");
    expect(screen.getByRole("button", { name: /^Submit/ })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: /^Submit/ }));
    expect(onAnswer).toHaveBeenCalledWith({ "Which language?": "Rust" });
  });

  test("multi-select Other: toggles alongside presets and contributes its typed text to the array", async () => {
    const q = single();
    q.questions[0]!.multiSelect = true;
    (q.toolInput as { questions: { multiSelect: boolean }[] }).questions[0]!.multiSelect = true;
    const onAnswer = vi.fn();
    render(<QuestionPrompt question={q} onAnswer={onAnswer} onCancel={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: /TypeScript/ }));
    await userEvent.click(screen.getByRole("button", { name: /Other/ }));
    // Preset stays selected alongside Other (multi-select is additive).
    expect(screen.getByRole("button", { name: /TypeScript/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.type(screen.getByLabelText(/your answer/i), "Zig");
    await userEvent.click(screen.getByRole("button", { name: /^Submit/ }));
    expect(onAnswer).toHaveBeenCalledWith({ "Which language?": ["TypeScript", "Zig"] });
  });

  test("Other selected but text left empty does not satisfy the question (Submit stays disabled)", async () => {
    render(<QuestionPrompt question={single()} onAnswer={() => {}} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /Other/ }));
    // The input is revealed and labelled, but empty → not answered.
    expect(screen.getByLabelText(/your answer/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Submit/ })).toBeDisabled();
  });

  test("duplicate option labels do not collide (index-based keys) and toggle independently", async () => {
    // Two options share the label "Yes". With label-based keys React would warn/collide; with
    // index-based keys they are distinct. Each is independently togglable (first matches by name).
    const q: QuestionPayload = {
      requestId: "rq",
      toolInput: {
        questions: [{ question: "Pick one", multiSelect: false, options: [{ label: "Yes" }, { label: "Yes" }] }],
      },
      questions: [{ question: "Pick one", multiSelect: false, options: [{ label: "Yes" }, { label: "Yes" }] }],
    };
    render(<QuestionPrompt question={q} onAnswer={() => {}} onCancel={() => {}} />);
    const options = screen.getAllByRole("button", { name: /^Yes$/ });
    expect(options).toHaveLength(2);
    await userEvent.click(options[0]!);
    expect(options[0]!).toHaveAttribute("aria-pressed", "true");
  });
});
