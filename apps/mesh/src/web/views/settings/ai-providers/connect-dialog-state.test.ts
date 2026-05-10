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

  test("close from any state returns to closed", () => {
    const states: DialogState[] = [
      { kind: "grid" },
      { kind: "form", providerId: "openai", presetId: null },
      { kind: "oauth-pending", providerId: "anthropic", stateToken: "abc" },
      { kind: "cli-pending", providerId: "claude-code" },
      { kind: "cli-error", providerId: "claude-code", error: "no cli" },
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

  test("select-cli transitions grid → cli-pending", () => {
    expect(
      reducer(
        { kind: "grid" },
        { type: "select-cli", providerId: "claude-code" },
      ),
    ).toEqual({ kind: "cli-pending", providerId: "claude-code" });
  });

  test("cli-error transitions cli-pending → cli-error", () => {
    expect(
      reducer(
        { kind: "cli-pending", providerId: "claude-code" },
        { type: "cli-error", error: "CLI not signed in" },
      ),
    ).toEqual({
      kind: "cli-error",
      providerId: "claude-code",
      error: "CLI not signed in",
    });
  });

  test("retry-cli transitions cli-error → cli-pending", () => {
    expect(
      reducer(
        { kind: "cli-error", providerId: "claude-code", error: "x" },
        { type: "retry-cli" },
      ),
    ).toEqual({ kind: "cli-pending", providerId: "claude-code" });
  });

  test("back returns to grid from form/oauth-pending/cli-pending/cli-error", () => {
    const intermediate: DialogState[] = [
      { kind: "form", providerId: "openai", presetId: null },
      { kind: "oauth-pending", providerId: "anthropic", stateToken: "x" },
      { kind: "cli-pending", providerId: "claude-code" },
      { kind: "cli-error", providerId: "claude-code", error: "x" },
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
      reducer(s, { type: "select-cli", providerId: "claude-code" }),
    ).toEqual(s);
  });
});
