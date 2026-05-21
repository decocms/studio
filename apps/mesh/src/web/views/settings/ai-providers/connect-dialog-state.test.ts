import { describe, expect, test } from "bun:test";
import {
  initialState,
  reducer,
  type DialogState,
} from "./connect-dialog-state";

describe("connect-dialog reducer", () => {
  test("starts closed", () => {
    expect(initialState).toEqual({ kind: "closed" });
  });

  test("open transitions closed → grid", () => {
    expect(reducer({ kind: "closed" }, { type: "open" })).toEqual({
      kind: "grid",
    });
  });

  test("open is a no-op from non-closed states", () => {
    const states: DialogState[] = [
      { kind: "grid" },
      { kind: "form", providerId: "openai", presetId: null },
      { kind: "oauth-pending", providerId: "anthropic", stateToken: "x" },
      { kind: "provision-pending", providerId: "deco" },
      { kind: "provision-error", providerId: "deco", error: "x" },
    ];
    for (const s of states) {
      expect(reducer(s, { type: "open" })).toEqual(s);
    }
  });

  test("close from any state returns to closed", () => {
    const states: DialogState[] = [
      { kind: "grid" },
      { kind: "form", providerId: "openai", presetId: null },
      { kind: "oauth-pending", providerId: "anthropic", stateToken: "abc" },
      { kind: "provision-pending", providerId: "deco" },
      { kind: "provision-error", providerId: "deco", error: "boom" },
    ];
    for (const s of states) {
      expect(reducer(s, { type: "close" })).toEqual({ kind: "closed" });
    }
  });

  test("select-form transitions grid → form", () => {
    expect(
      reducer(
        { kind: "grid" },
        { type: "select-form", providerId: "openai", presetId: null },
      ),
    ).toEqual({ kind: "form", providerId: "openai", presetId: null });
  });

  test("select-form carries presetId for openai-compatible", () => {
    expect(
      reducer(
        { kind: "grid" },
        {
          type: "select-form",
          providerId: "openai-compatible",
          presetId: "litellm",
        },
      ),
    ).toEqual({
      kind: "form",
      providerId: "openai-compatible",
      presetId: "litellm",
    });
  });

  test("select-oauth transitions grid → oauth-pending", () => {
    expect(
      reducer(
        { kind: "grid" },
        {
          type: "select-oauth",
          providerId: "anthropic",
          stateToken: "tok-1",
        },
      ),
    ).toEqual({
      kind: "oauth-pending",
      providerId: "anthropic",
      stateToken: "tok-1",
    });
  });

  test("select-provision transitions grid → provision-pending", () => {
    expect(
      reducer(
        { kind: "grid" },
        { type: "select-provision", providerId: "deco" },
      ),
    ).toEqual({ kind: "provision-pending", providerId: "deco" });
  });

  test("provision-error transitions provision-pending → provision-error", () => {
    expect(
      reducer(
        { kind: "provision-pending", providerId: "deco" },
        { type: "provision-error", error: "Quota exhausted" },
      ),
    ).toEqual({
      kind: "provision-error",
      providerId: "deco",
      error: "Quota exhausted",
    });
  });

  test("retry-provision transitions provision-error → provision-pending", () => {
    expect(
      reducer(
        { kind: "provision-error", providerId: "deco", error: "x" },
        { type: "retry-provision" },
      ),
    ).toEqual({ kind: "provision-pending", providerId: "deco" });
  });

  test("back returns to grid from any intermediate state", () => {
    const intermediate: DialogState[] = [
      { kind: "form", providerId: "openai", presetId: null },
      { kind: "oauth-pending", providerId: "anthropic", stateToken: "x" },
      { kind: "provision-pending", providerId: "deco" },
      { kind: "provision-error", providerId: "deco", error: "x" },
    ];
    for (const s of intermediate) {
      expect(reducer(s, { type: "back" })).toEqual({ kind: "grid" });
    }
  });

  test("back is a no-op from closed and grid", () => {
    expect(reducer({ kind: "closed" }, { type: "back" })).toEqual({
      kind: "closed",
    });
    expect(reducer({ kind: "grid" }, { type: "back" })).toEqual({
      kind: "grid",
    });
  });

  test("oauth-failed returns to grid", () => {
    expect(
      reducer(
        { kind: "oauth-pending", providerId: "anthropic", stateToken: "x" },
        { type: "oauth-failed" },
      ),
    ).toEqual({ kind: "grid" });
  });

  test("ignores select-* actions when not on grid", () => {
    const s: DialogState = {
      kind: "form",
      providerId: "openai",
      presetId: null,
    };
    expect(
      reducer(s, { type: "select-provision", providerId: "deco" }),
    ).toEqual(s);
  });
});
