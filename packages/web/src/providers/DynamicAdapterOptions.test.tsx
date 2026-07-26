import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { adapterDraftErrors, adapterOptionDefaults, DynamicAdapterOptions } from "./DynamicAdapterOptions";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["mode"],
  properties: {
    mode: {
      type: "string",
      title: "Execution mode",
      description: "Controls the adapter's native execution strategy.",
      enum: ["safe", "fast"],
      default: "safe",
    },
    retries: { type: "integer", title: "Retries", minimum: 0, maximum: 3, default: 1 },
    trace: { type: "boolean", title: "Trace adapter", default: false },
    labels: { type: "array", title: "Labels", items: { type: "string" }, maxItems: 4 },
  },
} satisfies Record<string, unknown>;

describe("manifest-driven adapter options", () => {
  test("hydrates defaults, renders bounded field types, and preserves native JSON values", async () => {
    const user = userEvent.setup();
    const defaults = adapterOptionDefaults(schema);
    expect(defaults).toEqual({ mode: "safe", retries: 1, trace: false });

    function Harness() {
      const [value, setValue] = useState(defaults);
      return (
        <>
          <DynamicAdapterOptions displayName="Fixture Agent" schema={schema} value={value} onChange={setValue} />
          <output data-testid="value">{JSON.stringify(value)}</output>
        </>
      );
    }

    render(<Harness />);
    await user.selectOptions(screen.getByRole("combobox", { name: /Execution mode/ }), "fast");
    await user.clear(screen.getByRole("spinbutton", { name: "Retries" }));
    await user.type(screen.getByRole("spinbutton", { name: "Retries" }), "3");
    await user.click(screen.getByLabelText("Trace adapter"));
    fireEvent.change(screen.getByRole("textbox", { name: /Labels/ }), { target: { value: "backend\nrelease" } });
    expect(JSON.parse(screen.getByTestId("value").textContent ?? "{}") as unknown).toEqual({
      mode: "fast",
      retries: 3,
      trace: true,
      labels: ["backend", "release"],
    });
    expect(adapterDraftErrors(schema, { mode: "", retries: 4 })).toEqual(
      expect.arrayContaining(["Execution mode is required", "Options.retries is above its maximum"]),
    );
  });
});
