import { describe, expect, test } from "bun:test";
import {
  isReportsTask,
  SUBSCRIPTION_REQUIRED_PREFIX,
  subscriptionInGoodStanding,
  TaskQuotaError,
  taskQuotaState,
} from "./task-quota";

const LIMITS = { freeTaskExecutions: 3, monthlyTaskExecutions: 10 };

describe("isReportsTask", () => {
  test('only the import route\'s "system" creator is gated', () => {
    expect(isReportsTask({ createdBy: "system" })).toBe(true);
    expect(isReportsTask({ createdBy: "user_1" })).toBe(false);
  });
});

describe("subscriptionInGoodStanding", () => {
  test("active and past_due (dunning grace) are good; anything else is not", () => {
    expect(subscriptionInGoodStanding({ status: "active" })).toBe(true);
    expect(subscriptionInGoodStanding({ status: "past_due" })).toBe(true);
    expect(subscriptionInGoodStanding({ status: "none" })).toBe(false);
    expect(subscriptionInGoodStanding({ status: "canceled" })).toBe(false);
    expect(subscriptionInGoodStanding(null)).toBe(false);
  });
});

describe("taskQuotaState", () => {
  test("no billing row → the lifetime trial bucket", () => {
    expect(taskQuotaState(null, LIMITS)).toEqual({
      periodKey: "trial",
      limit: 3,
      exhaustedReason: "trial_exhausted",
    });
  });

  test("subscribed → a per-cycle bucket keyed by the period end", () => {
    const periodEnd = new Date("2026-09-01T00:00:00.000Z");
    expect(
      taskQuotaState({ status: "active", currentPeriodEnd: periodEnd }, LIMITS),
    ).toEqual({
      periodKey: "sub:2026-09-01T00:00:00.000Z",
      limit: 10,
      exhaustedReason: "monthly_exhausted",
    });
    // invoice.paid refreshes currentPeriodEnd → a NEW bucket, quota resets.
    expect(
      taskQuotaState(
        {
          status: "active",
          currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
        },
        LIMITS,
      ).periodKey,
    ).toBe("sub:2026-10-01T00:00:00.000Z");
  });

  test("canceled falls back to the trial bucket", () => {
    expect(
      taskQuotaState(
        { status: "canceled", currentPeriodEnd: new Date() },
        LIMITS,
      ).periodKey,
    ).toBe("trial");
  });

  test("subscribed with no period end yet gets its own bucket at the MONTHLY limit", () => {
    // checkout.session.completed flips status to active without a period end
    // (and the invoice.paid carrying one can arrive before the bind, acked as
    // "unknown subscription"). Dropping such an org into the already-spent
    // trial bucket would paywall a customer who just paid.
    expect(
      taskQuotaState({ status: "active", currentPeriodEnd: null }, LIMITS),
    ).toEqual({
      periodKey: "sub:pending",
      limit: 10,
      exhaustedReason: "monthly_exhausted",
    });
  });

  test("run-cap rejection has its own reason/message", () => {
    expect(new TaskQuotaError("runs_exhausted").message).toContain(
      "execution limit",
    );
    expect(new TaskQuotaError("runs_exhausted").reason).toBe("runs_exhausted");
  });
});

describe("TaskQuotaError", () => {
  test("carries the [SUBSCRIPTION_REQUIRED] wire prefix the paywall UI detects", () => {
    expect(
      new TaskQuotaError("trial_exhausted").message.startsWith(
        SUBSCRIPTION_REQUIRED_PREFIX,
      ),
    ).toBe(true);
    expect(
      new TaskQuotaError("monthly_exhausted").message.startsWith(
        SUBSCRIPTION_REQUIRED_PREFIX,
      ),
    ).toBe(true);
  });
});
