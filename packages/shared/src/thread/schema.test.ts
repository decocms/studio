import { describe, expect, test } from "bun:test";
import { ThreadEntitySchema, ThreadUpdateDataSchema } from "./schema.ts";

const THREAD_ENTITY = {
  id: "thread-1",
  organization_id: "org-1",
  title: "Thread",
  description: null,
  created_at: "2026-08-04T12:00:00.000Z",
  updated_at: "2026-08-04T12:00:00.000Z",
  status: "in_progress",
  created_by: "user-1",
};

describe("ThreadEntitySchema", () => {
  test("preserves a routing lock timestamp", () => {
    const result = ThreadEntitySchema.parse({
      ...THREAD_ENTITY,
      routing_locked_at: "2026-08-04T12:01:00.000Z",
    });

    expect(result.routing_locked_at).toBe("2026-08-04T12:01:00.000Z");
  });

  test("accepts a null or omitted routing lock timestamp", () => {
    expect(
      ThreadEntitySchema.parse({
        ...THREAD_ENTITY,
        routing_locked_at: null,
      }).routing_locked_at,
    ).toBeNull();
    expect(ThreadEntitySchema.parse(THREAD_ENTITY).routing_locked_at).toBe(
      undefined,
    );
  });

  test("rejects an invalid routing lock timestamp", () => {
    const result = ThreadEntitySchema.safeParse({
      ...THREAD_ENTITY,
      routing_locked_at: "not-a-timestamp",
    });

    expect(result.success).toBe(false);
  });

  test("preserves a hosted execution tombstone timestamp", () => {
    const result = ThreadEntitySchema.parse({
      ...THREAD_ENTITY,
      hosted_execution_disabled_at: "2026-08-04T12:02:00.000Z",
    });

    expect(result.hosted_execution_disabled_at).toBe(
      "2026-08-04T12:02:00.000Z",
    );
  });

  test("accepts a null or omitted hosted execution tombstone", () => {
    expect(
      ThreadEntitySchema.parse({
        ...THREAD_ENTITY,
        hosted_execution_disabled_at: null,
      }).hosted_execution_disabled_at,
    ).toBeNull();
    expect(
      ThreadEntitySchema.parse(THREAD_ENTITY).hosted_execution_disabled_at,
    ).toBe(undefined);
  });

  test("rejects an invalid hosted execution tombstone timestamp", () => {
    const result = ThreadEntitySchema.safeParse({
      ...THREAD_ENTITY,
      hosted_execution_disabled_at: "not-a-timestamp",
    });

    expect(result.success).toBe(false);
  });
});

describe("ThreadUpdateDataSchema", () => {
  test("rejects an empty-string branch", () => {
    const result = ThreadUpdateDataSchema.safeParse({ branch: "" });
    expect(result.success).toBe(false);
  });

  test("accepts null branch (clears the pin)", () => {
    const result = ThreadUpdateDataSchema.safeParse({ branch: null });
    expect(result.success).toBe(true);
  });

  test("accepts a non-empty branch name", () => {
    const result = ThreadUpdateDataSchema.safeParse({ branch: "feat/foo" });
    expect(result.success).toBe(true);
  });

  test("accepts omitted branch (no change)", () => {
    const result = ThreadUpdateDataSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
