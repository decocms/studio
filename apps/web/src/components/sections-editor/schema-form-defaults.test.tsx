import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "bun:test";
import type { SchemaProperty } from "./resolve-schema";
import { useSeededFormValue } from "./schema-form";

/** A settings-like block: one switch whose `@default` is on. */
const schema = {
  type: "object",
  properties: {
    enabled: { type: "boolean", title: "Enabled", default: true },
  },
} as unknown as SchemaProperty;

describe("useSeededFormValue (the outermost form's @default seeding)", () => {
  it("writes missing defaults back when the form opens (the default)", () => {
    const changes: unknown[] = [];
    const value = {};
    const { result } = renderHook(() =>
      useSeededFormValue(
        schema,
        value,
        (next) => changes.push(next),
        undefined,
      ),
    );
    expect(result.current).toEqual({ enabled: true });
    expect(changes).toEqual([{ enabled: true }]);
  });

  it("without persist, shows the defaults and saves nothing for opening", () => {
    const changes: unknown[] = [];
    const value = {};
    const { result, rerender } = renderHook(() =>
      useSeededFormValue(
        schema,
        value,
        (next) => changes.push(next),
        undefined,
        false,
      ),
    );
    rerender();
    expect(result.current).toEqual({ enabled: true });
    expect(changes).toEqual([]);
  });

  it("writes nothing when no default is missing", () => {
    const changes: unknown[] = [];
    const value = { enabled: false };
    const { result } = renderHook(() =>
      useSeededFormValue(
        schema,
        value,
        (next) => changes.push(next),
        undefined,
      ),
    );
    expect(result.current).toBe(value);
    expect(changes).toEqual([]);
  });
});
