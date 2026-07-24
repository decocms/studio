import { describe, expect, test } from "bun:test";
import { publishToBaseLabel } from "./publish-label.ts";

const mockT = (key: string) => key;

describe("publishToBaseLabel", () => {
  test("main → publishToProduction key", () => {
    expect(publishToBaseLabel("main", mockT as never)).toBe(
      "thread.headerActions.publishToProduction",
    );
    expect(publishToBaseLabel("Main", mockT as never)).toBe(
      "thread.headerActions.publishToProduction",
    );
  });

  test("master → publishToProduction key", () => {
    expect(publishToBaseLabel("master", mockT as never)).toBe(
      "thread.headerActions.publishToProduction",
    );
  });

  test("other bases → publish key", () => {
    expect(publishToBaseLabel("develop", mockT as never)).toBe(
      "thread.headerActions.publish",
    );
    expect(publishToBaseLabel("staging", mockT as never)).toBe(
      "thread.headerActions.publish",
    );
  });
});
