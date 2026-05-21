/**
 * Per-property form for an MCP tool's `inputSchema`. Renders the right
 * widget per JSON-schema type — Input for strings/numbers, Textarea for
 * object/array (JSON), Select for booleans — and falls back to a single
 * raw-JSON textarea when the schema has no properties.
 *
 * Extracted from the connection inspector
 * (apps/mesh/src/web/components/details/tool.tsx) so other surfaces (e.g.
 * the tool_call automation detail page) get the same look without
 * pulling in the workflow editor's RJSF stack, which transitively
 * requires WorkflowStoreProvider context.
 *
 * Value model: caller passes a parsed `Record<string, unknown>` and gets
 * the same shape back via `onChange`. Object/array fields are typed by
 * the user as JSON text; we parse on each keystroke and emit the parsed
 * value when it's valid (falling back to the raw string when it isn't,
 * so the textarea stays editable mid-edit).
 */

import { Input } from "@deco/ui/components/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { useState } from "react";

type Property = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
};

export function ToolParametersForm({
  inputSchema,
  value,
  onChange,
}: {
  inputSchema: Tool["inputSchema"] | undefined;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const properties = inputSchema?.properties as
    | Record<string, Property>
    | undefined;
  const required = (inputSchema?.required ?? []) as string[];
  const hasProperties = !!properties && Object.keys(properties).length > 0;

  if (
    !inputSchema ||
    (!hasProperties && Object.keys(inputSchema).length === 0)
  ) {
    return (
      <div className="text-sm text-muted-foreground italic">
        No arguments defined in schema.
      </div>
    );
  }

  // No declared properties — surface a single raw-JSON editor. The
  // inspector does the same; some MCP tools advertise free-form input.
  if (!hasProperties) {
    return <RawJsonField value={value} onChange={onChange} />;
  }

  const setField = (key: string, next: unknown) => {
    if (next === undefined) {
      const { [key]: _drop, ...rest } = value;
      onChange(rest);
      return;
    }
    onChange({ ...value, [key]: next });
  };

  return (
    <div className="space-y-4">
      {required.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <span className="text-red-500">*</span> Required
        </div>
      )}
      {Object.entries(properties!).map(([key, prop]) => {
        const isRequired = required.includes(key);
        const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
        return (
          <div key={key} className="space-y-2">
            <div className="flex items-center justify-between">
              <label
                htmlFor={`tool-param-${key}`}
                className="text-sm font-medium leading-none flex items-center gap-1.5"
              >
                {key}
                {isRequired && <span className="text-red-500 text-xs">*</span>}
              </label>
              {type && (
                <span className="text-xs text-muted-foreground font-mono">
                  {type}
                </span>
              )}
            </div>
            {prop.description && (
              <p className="text-xs text-muted-foreground leading-relaxed">
                {prop.description}
              </p>
            )}
            <PropertyField
              id={`tool-param-${key}`}
              propKey={key}
              prop={prop}
              type={type}
              value={value[key]}
              onChange={(next) => setField(key, next)}
            />
          </div>
        );
      })}
    </div>
  );
}

function PropertyField({
  id,
  propKey,
  prop,
  type,
  value,
  onChange,
}: {
  id: string;
  propKey: string;
  prop: Property;
  type: string | undefined;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  if (prop.enum && prop.enum.length > 0) {
    // Map the stringified form back to the original option so a
    // numeric / boolean enum (e.g. `enum: [1, 2, 3]` or `[true, false]`)
    // is persisted as its original type — not as `"1"` / `"true"`.
    const byString = new Map(prop.enum.map((opt) => [String(opt), opt]));
    return (
      <Select
        value={value !== undefined ? String(value) : ""}
        onValueChange={(v) => onChange(byString.get(v) ?? v)}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder={`Select ${propKey}…`} />
        </SelectTrigger>
        <SelectContent>
          {prop.enum.map((opt) => {
            const s = String(opt);
            return (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    );
  }

  if (type === "boolean") {
    return (
      <Select
        value={value === undefined ? "" : String(value)}
        onValueChange={(v) => onChange(v === "true")}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder="Select true or false…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">true</SelectItem>
          <SelectItem value="false">false</SelectItem>
        </SelectContent>
      </Select>
    );
  }

  if (type === "number" || type === "integer") {
    return (
      <Input
        id={id}
        type="number"
        value={value === undefined ? "" : (value as number | string)}
        onChange={(e) => {
          const raw = e.currentTarget.value;
          if (raw === "") return onChange(undefined);
          const n = Number(raw);
          onChange(Number.isFinite(n) ? n : raw);
        }}
        placeholder={`Enter ${propKey}…`}
      />
    );
  }

  if (type === "object" || type === "array") {
    // The textarea holds JSON text; we keep the parsed value in `value`
    // (the source of truth) but render JSON.stringify(value) so external
    // resets are reflected. While invalid JSON is being typed, we pass
    // the raw string through so the user can keep editing — the parent's
    // save path validates again on submit.
    const text =
      typeof value === "string"
        ? value
        : value === undefined
          ? ""
          : JSON.stringify(value, null, 2);
    return (
      <Textarea
        id={id}
        className="font-mono text-xs"
        value={text}
        rows={4}
        spellCheck={false}
        onChange={(e) => {
          const raw = e.currentTarget.value;
          if (raw.trim() === "") return onChange(undefined);
          try {
            onChange(JSON.parse(raw));
          } catch {
            onChange(raw);
          }
        }}
        placeholder={`Enter ${propKey} as JSON…`}
      />
    );
  }

  return (
    <Input
      id={id}
      value={value === undefined ? "" : (value as string)}
      onChange={(e) => {
        const raw = e.currentTarget.value;
        onChange(raw === "" ? undefined : raw);
      }}
      placeholder={`Enter ${propKey}…`}
    />
  );
}

function RawJsonField({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  // Keep raw text locally so the user can type intermediate-invalid JSON
  // (a single `{` or a partially-edited string) without the textarea
  // snapping back to the last valid stringified value. The component is
  // mounted fresh whenever the tool changes (parent resets input to {}),
  // so we don't need to sync from `value` after mount.
  const [text, setText] = useState(() =>
    Object.keys(value).length === 0 ? "{}" : JSON.stringify(value, null, 2),
  );
  return (
    <div className="space-y-2">
      <label
        htmlFor="tool-raw-json"
        className="text-sm font-medium leading-none"
      >
        Raw JSON Input
      </label>
      <Textarea
        id="tool-raw-json"
        className="font-mono text-xs min-h-[120px]"
        value={text}
        spellCheck={false}
        onChange={(e) => {
          const raw = e.currentTarget.value;
          setText(raw);
          const trimmed = raw.trim();
          if (trimmed === "") {
            onChange({});
            return;
          }
          try {
            const parsed = JSON.parse(trimmed);
            if (
              parsed &&
              typeof parsed === "object" &&
              !Array.isArray(parsed)
            ) {
              onChange(parsed as Record<string, unknown>);
            }
          } catch {
            // Keep typing; the parent's last-known-good value stays as-is
            // until the JSON parses again.
          }
        }}
        placeholder='e.g. { "foo": "bar" }'
      />
    </div>
  );
}
