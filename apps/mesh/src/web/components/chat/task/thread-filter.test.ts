import { describe, expect, test } from "bun:test";
import { filterThreads } from "./thread-filter";
import type { Task } from "./types";

const t = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: `Thread ${id}`,
  created_at: "2026-05-14T00:00:00Z",
  updated_at: "2026-05-14T00:00:00Z",
  ...overrides,
});

describe("filterThreads", () => {
  test("returns all threads when filter is empty", () => {
    const threads = [t("a"), t("b")];
    expect(filterThreads(threads, {})).toEqual(threads);
  });

  test("filters by ownerUserId (keeps only threads created by the user)", () => {
    const threads = [
      t("a", { created_by: "user-1" }),
      t("b", { created_by: "user-2" }),
      t("c"), // no created_by
    ];
    expect(filterThreads(threads, { ownerUserId: "user-1" })).toEqual([
      threads[0]!,
    ]);
  });

  test("excludes threads with undefined created_by when ownerUserId is set", () => {
    const threads = [
      t("a", { created_by: "user-1" }),
      t("b"), // no created_by
    ];
    expect(filterThreads(threads, { ownerUserId: "user-1" })).toEqual([
      threads[0]!,
    ]);
  });

  test("filters by hasTrigger=true (automation only)", () => {
    const threads = [
      t("a", { trigger_id: "trig-1" }),
      t("b", { trigger_id: null }),
      t("c"),
    ];
    expect(filterThreads(threads, { hasTrigger: true })).toEqual([threads[0]!]);
  });

  test("filters by hasTrigger=false (excludes automations)", () => {
    const threads = [
      t("a", { trigger_id: "trig-1" }),
      t("b", { trigger_id: null }),
      t("c"),
    ];
    expect(filterThreads(threads, { hasTrigger: false })).toEqual([
      threads[1]!,
      threads[2]!,
    ]);
  });

  test("filters by virtualMcpId", () => {
    const threads = [
      t("a", { virtual_mcp_id: "agent-1" }),
      t("b", { virtual_mcp_id: "agent-2" }),
    ];
    expect(filterThreads(threads, { virtualMcpId: "agent-1" })).toEqual([
      threads[0]!,
    ]);
  });

  test("filters by hidden=false (excludes hidden threads, treats undefined as visible)", () => {
    const threads = [
      t("a", { hidden: true }),
      t("b", { hidden: false }),
      t("c"), // no hidden field — treated as visible
    ];
    expect(filterThreads(threads, { hidden: false })).toEqual([
      threads[1]!,
      threads[2]!,
    ]);
  });

  test("filters by hidden=true (only hidden threads)", () => {
    const threads = [
      t("a", { hidden: true }),
      t("b", { hidden: false }),
      t("c"),
    ];
    expect(filterThreads(threads, { hidden: true })).toEqual([threads[0]!]);
  });

  test("composes multiple filters (AND semantics)", () => {
    const threads = [
      t("a", { created_by: "u1", trigger_id: null }),
      t("b", { created_by: "u1", trigger_id: "trig-1" }),
      t("c", { created_by: "u2", trigger_id: null }),
    ];
    expect(
      filterThreads(threads, { ownerUserId: "u1", hasTrigger: false }),
    ).toEqual([threads[0]!]);
  });
});
