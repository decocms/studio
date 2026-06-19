import { describe, expect, it } from "bun:test";
import { resumeFloorForRelay } from "./link-ingest-routes";

describe("resumeFloorForRelay", () => {
  it("returns the next seq after lastSeq when the fence matches", () => {
    expect(resumeFloorForRelay({ lastSeq: 4, fenceToken: "f" }, "f")).toBe(5);
  });
  it("returns 1 (full prefix) when the presented fence differs (new epoch)", () => {
    expect(resumeFloorForRelay({ lastSeq: 4, fenceToken: "old" }, "new")).toBe(
      1,
    );
  });
  it("returns 1 when there is no current fence", () => {
    expect(resumeFloorForRelay({ lastSeq: 0, fenceToken: null }, "f")).toBe(1);
  });
});
