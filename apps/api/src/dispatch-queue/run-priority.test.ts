import { describe, expect, test } from "bun:test";
import {
  RUN_CLASS_METADATA_KEY,
  RUN_PRIORITY,
  runPriority,
} from "./run-priority";

describe("runPriority", () => {
  // The ordering this whole change exists for: a card one verdict from Done, or
  // a retry with a budget, must not queue behind a task nothing is waiting on.
  test("finish before you start", () => {
    expect(RUN_PRIORITY.interactive).toBeLessThan(RUN_PRIORITY.reviewer);
    expect(RUN_PRIORITY.reviewer).toBeLessThan(RUN_PRIORITY.retry);
    expect(RUN_PRIORITY.retry).toBeLessThan(RUN_PRIORITY.new_task);
  });

  test("reads the class off runMetadata", () => {
    expect(runPriority({ [RUN_CLASS_METADATA_KEY]: "reviewer" })).toBe(
      RUN_PRIORITY.reviewer,
    );
    expect(runPriority({ [RUN_CLASS_METADATA_KEY]: "retry" })).toBe(
      RUN_PRIORITY.retry,
    );
    expect(runPriority({ [RUN_CLASS_METADATA_KEY]: "new_task" })).toBe(
      RUN_PRIORITY.new_task,
    );
  });

  // An unmarked run is a person waiting on a stream (a chat turn). Sending those
  // to the back of the queue would be the regression this change must not cause.
  test("an unmarked or unknown run is treated as interactive", () => {
    expect(runPriority(undefined)).toBe(RUN_PRIORITY.interactive);
    expect(runPriority({})).toBe(RUN_PRIORITY.interactive);
    expect(runPriority({ [RUN_CLASS_METADATA_KEY]: "nonsense" })).toBe(
      RUN_PRIORITY.interactive,
    );
  });

  // DBOS's scale: 1..2^31-1, lower dequeues first. Same numbers are handed to
  // `enqueueOptions.priority`, so they have to be legal there.
  test("values are legal DBOS priorities", () => {
    for (const p of Object.values(RUN_PRIORITY)) {
      expect(p).toBeGreaterThanOrEqual(1);
      expect(p).toBeLessThan(2 ** 31 - 1);
    }
  });
});
