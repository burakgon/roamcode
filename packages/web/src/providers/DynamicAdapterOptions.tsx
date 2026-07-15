import type { ReactNode } from "react";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function labelFor(key: string, schema: JsonObject): string {
  if (typeof schema.title === "string" && schema.title.trim()) return schema.title.trim();
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultFor(schema: JsonObject): unknown {
  if (schema.const !== undefined) return clone(schema.const);
  if (schema.default !== undefined) return clone(schema.default);
  if (schema.type !== "object") return undefined;
  const properties = object(schema.properties) ?? {};
  const result: JsonObject = {};
  for (const [key, raw] of Object.entries(properties)) {
    const child = object(raw);
    if (!child) continue;
    const value = defaultFor(child);
    if (value !== undefined) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function adapterOptionDefaults(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const value = schema ? defaultFor(schema) : undefined;
  return object(value) ?? {};
}

function enumIncludes(schema: JsonObject, value: unknown): boolean {
  return !Array.isArray(schema.enum) || schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value));
}

function validateValue(schema: JsonObject, value: unknown, path: string, errors: string[]): void {
  if (!enumIncludes(schema, value)) {
    errors.push(`${path} must use an allowed value`);
    return;
  }
  if (schema.type === "object") {
    const input = object(value);
    if (!input) {
      errors.push(`${path} must be an object`);
      return;
    }
    const properties = object(schema.properties) ?? {};
    const required = new Set(
      Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [],
    );
    for (const key of required) {
      if (input[key] === undefined || input[key] === "")
        errors.push(`${labelFor(key, object(properties[key]) ?? {})} is required`);
    }
    for (const [key, childValue] of Object.entries(input)) {
      const child = object(properties[key]);
      if (child) validateValue(child, childValue, `${path}.${key}`, errors);
    }
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") errors.push(`${path} must be text`);
    else {
      if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path} is too short`);
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${path} is too long`);
      if (typeof schema.pattern === "string") {
        try {
          if (!new RegExp(schema.pattern, "u").test(value)) errors.push(`${path} has an invalid format`);
        } catch {
          errors.push(`${path} has an unsupported format rule`);
        }
      }
    }
    return;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") errors.push(`${path} must be on or off`);
    return;
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (schema.type === "integer" && !Number.isSafeInteger(value))
    ) {
      errors.push(`${path} must be a valid ${schema.type}`);
      return;
    }
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path} is below its minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path} is above its maximum`);
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be a list`);
      return;
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      errors.push(`${path} has too few values`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      errors.push(`${path} has too many values`);
    const items = object(schema.items);
    if (items) value.forEach((item, index) => validateValue(items, item, `${path}[${index}]`, errors));
  }
}

export function adapterDraftErrors(
  schema: Record<string, unknown> | undefined,
  value: Record<string, unknown>,
): string[] {
  if (!schema || schema.type !== "object") return ["This adapter has no supported option schema"];
  const errors: string[] = [];
  validateValue(schema, value, "Options", errors);
  return [...new Set(errors)];
}

function scalarFromText(value: string, itemSchema: JsonObject): unknown {
  if (itemSchema.type === "integer" || itemSchema.type === "number") return Number(value);
  if (itemSchema.type === "boolean") return value === "true";
  return value;
}

function OptionField({
  name,
  schema,
  value,
  required,
  disabled,
  onChange,
}: {
  name: string;
  schema: JsonObject;
  value: unknown;
  required: boolean;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const label = labelFor(name, schema);
  const description = typeof schema.description === "string" ? schema.description : undefined;
  const id = `rc-adapter-option-${name.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  let control: ReactNode;

  if (schema.const !== undefined) {
    control = (
      <label className="rc-adapter-options__field" htmlFor={id}>
        <span className="rc-wizard__field-label">{label}</span>
        <input id={id} className="rc-wizard__control" value={String(schema.const)} readOnly aria-readonly="true" />
        {description && <span className="rc-wizard__help">{description}</span>}
      </label>
    );
  } else if (schema.type === "boolean") {
    control = (
      <label className="rc-adapter-options__check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
    );
  } else if (schema.type === "object") {
    control = (
      <fieldset className="rc-adapter-options__group">
        <legend>{label}</legend>
        <ObjectFields schema={schema} value={object(value) ?? {}} disabled={disabled} onChange={onChange} />
      </fieldset>
    );
  } else if (schema.type === "array") {
    const itemSchema = object(schema.items) ?? { type: "string" };
    const list = Array.isArray(value) ? value : [];
    control = (
      <label className="rc-adapter-options__field" htmlFor={id}>
        <span className="rc-wizard__field-label">
          {label}
          {required ? " *" : ""}
        </span>
        <textarea
          id={id}
          className="rc-wizard__control rc-adapter-options__list"
          value={list.join("\n")}
          required={required}
          disabled={disabled}
          rows={Math.min(5, Math.max(2, list.length || 2))}
          onChange={(event) =>
            onChange(
              event.target.value
                .split("\n")
                .map((item) => item.trim())
                .filter(Boolean)
                .map((item) => scalarFromText(item, itemSchema)),
            )
          }
        />
        <span className="rc-wizard__help">{description ?? "One value per line."}</span>
      </label>
    );
  } else {
    const enumValues = Array.isArray(schema.enum)
      ? schema.enum.filter((item) => ["string", "number", "boolean"].includes(typeof item))
      : [];
    control = (
      <label className="rc-adapter-options__field" htmlFor={id}>
        <span className="rc-wizard__field-label">
          {label}
          {required ? " *" : ""}
        </span>
        {enumValues.length > 0 ? (
          <select
            id={id}
            className="rc-wizard__control"
            value={value === undefined ? "" : String(value)}
            required={required}
            disabled={disabled}
            onChange={(event) => {
              const selected = enumValues.find((candidate) => String(candidate) === event.target.value);
              onChange(selected);
            }}
          >
            <option value="">Select…</option>
            {enumValues.map((item) => (
              <option key={String(item)} value={String(item)}>
                {String(item)}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={id}
            className="rc-wizard__control"
            type={schema.type === "integer" || schema.type === "number" ? "number" : "text"}
            value={value === undefined ? "" : String(value)}
            required={required}
            disabled={disabled}
            min={typeof schema.minimum === "number" ? schema.minimum : undefined}
            max={typeof schema.maximum === "number" ? schema.maximum : undefined}
            minLength={typeof schema.minLength === "number" ? schema.minLength : undefined}
            maxLength={typeof schema.maxLength === "number" ? schema.maxLength : undefined}
            step={schema.type === "integer" ? 1 : schema.type === "number" ? "any" : undefined}
            onChange={(event) => {
              if (!event.target.value) onChange(undefined);
              else if (schema.type === "integer" || schema.type === "number") onChange(Number(event.target.value));
              else onChange(event.target.value);
            }}
          />
        )}
        {description && <span className="rc-wizard__help">{description}</span>}
      </label>
    );
  }
  return <div className="rc-adapter-options__item">{control}</div>;
}

function ObjectFields({
  schema,
  value,
  disabled,
  onChange,
}: {
  schema: JsonObject;
  value: JsonObject;
  disabled: boolean;
  onChange: (value: JsonObject) => void;
}) {
  const properties = object(schema.properties) ?? {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [],
  );
  return (
    <div className="rc-adapter-options__fields">
      {Object.entries(properties).map(([name, raw]) => {
        const child = object(raw);
        if (!child) return null;
        return (
          <OptionField
            key={name}
            name={name}
            schema={child}
            value={value[name]}
            required={required.has(name)}
            disabled={disabled}
            onChange={(next) => {
              const updated = { ...value };
              if (next === undefined) delete updated[name];
              else updated[name] = next;
              onChange(updated);
            }}
          />
        );
      })}
    </div>
  );
}

export function DynamicAdapterOptions({
  displayName,
  schema,
  value,
  disabled = false,
  onChange,
}: {
  displayName: string;
  schema: Record<string, unknown> | undefined;
  value: Record<string, unknown>;
  disabled?: boolean;
  onChange: (value: Record<string, unknown>) => void;
}) {
  if (!schema || schema.type !== "object") {
    return (
      <div role="alert" className="rc-adapter-options__unsupported">
        {displayName} does not expose a supported launch-options schema. Update or disable this adapter.
      </div>
    );
  }
  return (
    <section className="rc-adapter-options" aria-label={`${displayName} options`}>
      <div className="rc-adapter-options__head">
        <strong>{displayName} options</strong>
        <span>Defined and validated by the verified adapter manifest.</span>
      </div>
      <ObjectFields schema={schema} value={value} disabled={disabled} onChange={onChange} />
      <style>{adapterOptionsCss}</style>
    </section>
  );
}

const adapterOptionsCss = `
.rc-adapter-options { display: grid; gap: var(--sp-3); padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-1); }
.rc-adapter-options__head { display: grid; gap: 3px; }
.rc-adapter-options__head strong { color: var(--text); font-size: var(--fs-sm); }
.rc-adapter-options__head span { color: var(--text-faint); font-size: var(--fs-xs); }
.rc-adapter-options__fields { display: grid; gap: var(--sp-3); }
.rc-adapter-options__field { display: grid; gap: var(--sp-1); }
.rc-adapter-options__check { display: flex; align-items: center; gap: var(--sp-2); color: var(--text); font-size: var(--fs-sm); }
.rc-adapter-options__check input { width: 18px; height: 18px; accent-color: var(--accent); }
.rc-adapter-options__group { display: grid; gap: var(--sp-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--sp-3); }
.rc-adapter-options__group legend { padding: 0 5px; color: var(--text-muted); font-size: var(--fs-xs); }
.rc-adapter-options__list { resize: vertical; font-family: var(--font-mono); }
.rc-adapter-options__unsupported { padding: var(--sp-3); color: var(--err); border: 1px solid color-mix(in srgb, var(--err) 35%, transparent); border-radius: var(--radius-md); font-size: var(--fs-sm); }
`;
