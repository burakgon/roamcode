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

function multi(): QuestionPayload {
  const q = single();
  q.questions[0]!.multiSelect = true;
  (q.toolInput as { questions: { multiSelect: boolean }[] }).questions[0]!.multiSelect = true;
  return q;
}

describe("QuestionPrompt", () => {
  test("renders the question, header, and every option with its description", () => {
    render(<QuestionPrompt question={single()} onAnswer={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("Which language?")).toBeInTheDocument();
    expect(screen.getByText("Language")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(screen.getByText("Py")).toBeInTheDocument();
  });

  // Single-select options are RADIOS (mutually exclusive); multi-select options stay aria-pressed toggles.
  test("single-select: choosing a radio option and submitting answers { question: label }", async () => {
    const onAnswer = vi.fn();
    render(<QuestionPrompt question={single()} onAnswer={onAnswer} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("radio", { name: /Python/ }));
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
    await userEvent.click(screen.getByRole("radio", { name: /TypeScript/ }));
    await userEvent.click(screen.getByRole("radio", { name: /Python/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Submit/ }));
    expect(onAnswer).toHaveBeenCalledWith({ "Which language?": "Python" });
  });

  test("multi-select: toggling options submits a label array", async () => {
    const onAnswer = vi.fn();
    render(<QuestionPrompt question={multi()} onAnswer={onAnswer} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /TypeScript/ }));
    await userEvent.click(screen.getByRole("button", { name: /Python/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Submit/ }));
    expect(onAnswer).toHaveBeenCalledWith({ "Which language?": ["TypeScript", "Python"] });
  });

  test("announces an awaiting region, moves focus to it, and single-select options are radios", async () => {
    render(<QuestionPrompt question={single()} onAnswer={() => {}} onCancel={() => {}} />);
    const region = screen.getByRole("region", { name: /question/i });
    expect(region).toHaveFocus();
    // The iris color is paired with the "Awaiting you" TEXT (color is never the sole signal).
    expect(screen.getByText(/awaiting you/i)).toBeInTheDocument();
    const option = screen.getByRole("radio", { name: /TypeScript/ });
    expect(option).toHaveAttribute("aria-checked", "false");
    await userEvent.click(option);
    expect(option).toHaveAttribute("aria-checked", "true");
  });

  test("Submit is disabled until every question is answered", async () => {
    render(<QuestionPrompt question={single()} onAnswer={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole("button", { name: /^Submit/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: /Python/ }));
    expect(screen.getByRole("button", { name: /^Submit/ })).toBeEnabled();
  });

  test("single-select uses RADIOGROUP + radio (mutually-exclusive semantics)", () => {
    render(<QuestionPrompt question={single()} onAnswer={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
    expect(screen.getAllByRole("radio").length).toBeGreaterThan(0);
  });

  test("multi-select uses role=group + aria-pressed toggle buttons (not radios)", () => {
    render(<QuestionPrompt question={multi()} onAnswer={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("group")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /TypeScript/ })).toHaveAttribute("aria-pressed", "false");
  });

  test("single-select Other: choosing it deselects presets, gates Submit on text, and sends the custom string", async () => {
    const onAnswer = vi.fn();
    render(<QuestionPrompt question={single()} onAnswer={onAnswer} onCancel={() => {}} />);

    // Pick a preset first, then switch to Other — the preset must be deselected.
    await userEvent.click(screen.getByRole("radio", { name: /TypeScript/ }));
    await userEvent.click(screen.getByRole("radio", { name: /Other/ }));
    expect(screen.getByRole("radio", { name: /TypeScript/ })).toHaveAttribute("aria-checked", "false");

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
    const onAnswer = vi.fn();
    render(<QuestionPrompt question={multi()} onAnswer={onAnswer} onCancel={() => {}} />);

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
    await userEvent.click(screen.getByRole("radio", { name: /Other/ }));
    // The input is revealed and labelled, but empty → not answered.
    expect(screen.getByLabelText(/your answer/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Submit/ })).toBeDisabled();
  });

  test("resets selections when a NEW question (different requestId) reuses the instance", async () => {
    // The reducer replaces pendingQuestion in place, so a new question can reuse this component instance.
    // Stale selections must NOT carry over (else the wrong answer is submitted for the new question).
    const onAnswer = vi.fn();
    const qA = single();
    const { rerender } = render(<QuestionPrompt question={qA} onAnswer={onAnswer} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("radio", { name: /Python/ }));
    expect(screen.getByRole("button", { name: /^Submit/ })).toBeEnabled();

    const qB: QuestionPayload = {
      requestId: "rqB",
      toolInput: {
        questions: [{ question: "Deploy now?", multiSelect: false, options: [{ label: "Yes" }, { label: "No" }] }],
      },
      questions: [{ question: "Deploy now?", multiSelect: false, options: [{ label: "Yes" }, { label: "No" }] }],
    };
    rerender(<QuestionPrompt question={qB} onAnswer={onAnswer} onCancel={() => {}} />);
    // The new question is UNanswered (no leaked selection) → Submit disabled until the user picks.
    expect(screen.getByText("Deploy now?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Submit/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Submit/ }));
    expect(onAnswer).toHaveBeenCalledWith({ "Deploy now?": "Yes" });
    expect(onAnswer).toHaveBeenCalledTimes(1);
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
    const options = screen.getAllByRole("radio", { name: /^Yes$/ });
    expect(options).toHaveLength(2);
    await userEvent.click(options[0]!);
    expect(options[0]!).toHaveAttribute("aria-checked", "true");
  });
});
