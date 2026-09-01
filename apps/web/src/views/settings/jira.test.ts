import { describe, expect, it } from "bun:test";
import { boardStatusOptions } from "./jira.tsx";

describe("boardStatusOptions", () => {
  it("offers every lane once delivery lanes are on", () => {
    expect(boardStatusOptions(true, undefined).map((o) => o.value)).toContain(
      "merged",
    );
  });

  it("drops the delivery lanes once the flag is off", () => {
    const values = boardStatusOptions(false, undefined).map((o) => o.value);
    expect(values).not.toContain("merged");
    expect(values).not.toContain("approved");
    expect(values).not.toContain("post_deploy_validation");
  });

  // A row already mapped to a delivery lane must keep showing it once the flag is off.
  it("keeps the row's current delivery lane even with the flag off", () => {
    const values = boardStatusOptions(false, "merged").map((o) => o.value);
    expect(values).toContain("merged");
    expect(values).not.toContain("approved");
  });
});
