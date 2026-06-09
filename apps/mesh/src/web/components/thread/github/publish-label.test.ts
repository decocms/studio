import { describe, expect, test } from "bun:test";
import { publishToBaseLabel } from "./publish-label.ts";

describe("publishToBaseLabel", () => {
  test("main → Publish to production", () => {
    expect(publishToBaseLabel("main")).toBe("Publish to production");
    expect(publishToBaseLabel("Main")).toBe("Publish to production");
  });

  test("master → Publish to production", () => {
    expect(publishToBaseLabel("master")).toBe("Publish to production");
  });

  test("other bases → Publish", () => {
    expect(publishToBaseLabel("develop")).toBe("Publish");
    expect(publishToBaseLabel("staging")).toBe("Publish");
  });
});
