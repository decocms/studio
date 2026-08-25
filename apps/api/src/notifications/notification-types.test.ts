/**
 * Three bindings, all cheap: the migration's frozen list, the pass-through from
 * activity actions, and the coalescing carve-out.
 *
 * Import from the NEWEST migration touching the CHECK constraint — the pattern
 * `tools/task-board/activity-actions.test.ts` establishes.
 */

import { expect, test } from "bun:test";
import { NOTIFICATION_TYPES } from "@decocms/shared/notification-types";
import { TYPES as MIGRATION_TYPES } from "../../migrations/176-notifications";
import { TASK_BOARD_ACTIVITY_ACTIONS } from "../tools/task-board/schema";
import { COALESCED_ACTIONS } from "../storage/task-board";

test("the DB CHECK constraint allows exactly the types TypeScript declares", () => {
  expect([...MIGRATION_TYPES].sort()).toEqual([...NOTIFICATION_TYPES].sort());
});

test("every type but `commented` is an activity action, so fan-out passes it through", () => {
  const actions = new Set<string>(TASK_BOARD_ACTIVITY_ACTIONS);
  for (const type of NOTIFICATION_TYPES) {
    if (type === "commented") continue;
    expect(actions.has(type)).toBe(true);
  }
});

test("no notified action is coalesced, so fan-out can ignore coalescing", () => {
  for (const action of COALESCED_ACTIONS) {
    expect(NOTIFICATION_TYPES).not.toContain(action);
  }
});
