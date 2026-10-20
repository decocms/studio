import { describe, expect, it } from "bun:test";
import {
  APP_BUDGET_OWNER,
  budgetOwnerFor,
  rememberBudgetOwner,
} from "./budget-owner";

describe("budgetOwnerFor", () => {
  const now = 1_000_000;

  it("returns the owner registered for a token", () => {
    rememberBudgetOwner("tok-a", "12345", now + 3600_000, now);
    expect(budgetOwnerFor("tok-a", now)).toBe("12345");
  });

  it("keeps two installations apart", () => {
    rememberBudgetOwner("tok-b", "111", now + 3600_000, now);
    rememberBudgetOwner("tok-c", "222", now + 3600_000, now);
    expect(budgetOwnerFor("tok-b", now)).toBe("111");
    expect(budgetOwnerFor("tok-c", now)).toBe("222");
  });

  it("is unknown for a token nobody registered", () => {
    expect(budgetOwnerFor("never-seen", now)).toBe("unknown");
  });

  it("is unknown once the token has expired", () => {
    rememberBudgetOwner("tok-d", "333", now + 1000, now);
    expect(budgetOwnerFor("tok-d", now + 1001)).toBe("unknown");
  });

  it("tags the App's own JWT window", () => {
    rememberBudgetOwner("jwt", APP_BUDGET_OWNER, now + 600_000, now);
    expect(budgetOwnerFor("jwt", now)).toBe(APP_BUDGET_OWNER);
  });

  it("does not grow without bound as tokens rotate", () => {
    for (let i = 0; i < 2000; i++) {
      rememberBudgetOwner(`rot-${i}`, String(i), now + 1000, now + 2000);
    }
    expect(budgetOwnerFor("rot-0", now + 2000)).toBe("unknown");
  });
});
