/**
 * Unit tests for thread normalization helpers.
 */

import { describe, expect, test } from "bun:test";
import type { Thread } from "../../storage/types";
import { normalizeThreadForResponse, THREAD_EXPIRY_MS } from "./helpers";

const BASE_THREAD: Thread = {
  id: "thrd_test",
  organization_id: "org_test",
  title: "Test thread",
  description: null,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
  created_by: "user_test",
  updated_by: null,
  hidden: null,
  status: "completed",
  trigger_id: null,
  context_start_message_id: null,
};

const NOW = new Date("2025-01-01T01:00:00.000Z").getTime(); // 1hr after base

describe("normalizeThreadForResponse", () => {
  test("completed status stays completed", () => {
    const result = normalizeThreadForResponse(
      { ...BASE_THREAD, status: "completed" },
      NOW,
    );
    expect(result.status).toBe("completed");
  });

  test("failed status stays failed", () => {
    const result = normalizeThreadForResponse(
      { ...BASE_THREAD, status: "failed" },
      NOW,
    );
    expect(result.status).toBe("failed");
  });

  test("requires_action status stays requires_action", () => {
    const result = normalizeThreadForResponse(
      { ...BASE_THREAD, status: "requires_action" },
      NOW,
    );
    expect(result.status).toBe("requires_action");
  });

  test("in_progress within 30 min stays in_progress", () => {
    const recentUpdate = new Date(NOW - 10 * 60 * 1000).toISOString(); // 10 min ago
    const result = normalizeThreadForResponse(
      { ...BASE_THREAD, status: "in_progress", updated_at: recentUpdate },
      NOW,
    );
    expect(result.status).toBe("in_progress");
  });

  test("in_progress older than 30 min becomes expired", () => {
    const staleUpdate = new Date(NOW - 31 * 60 * 1000).toISOString(); // 31 min ago
    const result = normalizeThreadForResponse(
      { ...BASE_THREAD, status: "in_progress", updated_at: staleUpdate },
      NOW,
    );
    expect(result.status).toBe("expired");
  });

  test("in_progress at exactly 30 min stays in_progress", () => {
    const exactUpdate = new Date(NOW - THREAD_EXPIRY_MS).toISOString();
    const result = normalizeThreadForResponse(
      { ...BASE_THREAD, status: "in_progress", updated_at: exactUpdate },
      NOW,
    );
    expect(result.status).toBe("in_progress");
  });

  test("hidden null defaults to false", () => {
    const result = normalizeThreadForResponse(
      { ...BASE_THREAD, hidden: null },
      NOW,
    );
    expect(result.hidden).toBe(false);
  });

  test("hidden true stays true", () => {
    const result = normalizeThreadForResponse(
      { ...BASE_THREAD, hidden: true },
      NOW,
    );
    expect(result.hidden).toBe(true);
  });
});
