import { describe, expect, it } from "bun:test";
import { PreviewPreparing, protocolDraftState } from "./content-protocol-api";

const base = {
  revision: "a".repeat(40),
  data: undefined,
  fallbackPointer: null,
  isPlaceholderData: false,
  isPending: false,
  error: null,
};

describe("protocolDraftState", () => {
  it("is ready with the saved commit's pointer", () => {
    expect(protocolDraftState({ ...base, data: "p2" })).toEqual({
      pointer: "p2",
      preparing: false,
      failed: null,
    });
  });

  it("keeps the last ready pointer while a newer save prepares", () => {
    for (const state of [
      { isPlaceholderData: true, data: "p1" },
      { isPending: true, fallbackPointer: "p1" },
      { error: new PreviewPreparing(), fallbackPointer: "p1" },
    ]) {
      expect(protocolDraftState({ ...base, ...state })).toEqual({
        pointer: "p1",
        preparing: true,
        failed: null,
      });
    }
  });

  it("reports a failed save instead of falling back to the published site", () => {
    const failed = protocolDraftState({
      ...base,
      error: new Error("draft changes exceed 8388608 bytes"),
      fallbackPointer: "p1",
    });
    expect(failed).toEqual({
      pointer: "p1",
      preparing: false,
      failed: "draft changes exceed 8388608 bytes",
    });
    // Nothing ready yet: no pointer, and the failure says why.
    expect(
      protocolDraftState({ ...base, error: new Error("boom") }),
    ).toMatchObject({ pointer: null, preparing: false, failed: "boom" });
  });
});
