/**
 * The activity log's action set exists twice: as `TASK_BOARD_ACTIVITY_ACTIONS`
 * (which the TS union and the zod enum derive from) and as a frozen list inside
 * whichever migration last replaced the CHECK constraint. They can't be shared
 * — a migration must keep meaning what it meant when it ran — so this binds
 * them: add an action without the migration and this fails, instead of an
 * insert blowing up at runtime.
 *
 * Import from the NEWEST migration that touches the constraint.
 */

import { expect, test } from "bun:test";
import { ACTIONS as MIGRATION_ACTIONS } from "../../../migrations/150-task-board-activity";
import { TASK_BOARD_ACTIVITY_ACTIONS } from "./schema";

test("the DB CHECK constraint allows exactly the actions TypeScript declares", () => {
  expect([...MIGRATION_ACTIONS].sort()).toEqual(
    [...TASK_BOARD_ACTIVITY_ACTIONS].sort(),
  );
});
