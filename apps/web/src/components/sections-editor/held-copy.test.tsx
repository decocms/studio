import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { bumpCopyEpoch, copyScope, useCopyEpochs } from "./held-copy";

const scope = copyScope({ orgSlug: "acme", virtualMcpId: "vm", branch: "b" });

describe("useCopyEpochs", () => {
  it("answers a new reader after a bump: an editor memoized by the React Compiler remounts", () => {
    const { result } = renderHook(() => useCopyEpochs(scope));
    const before = result.current;
    expect(before("Footer")).toBe(0);
    act(() => bumpCopyEpoch(scope, "Footer"));
    // The compiler keeps a value computed from an unchanged reader: the
    // reader itself must change for `epochOf(key)` to be read again.
    expect(result.current).not.toBe(before);
    expect(result.current("Footer")).toBe(1);
    // A reader already handed out keeps answering what it answered.
    expect(before("Footer")).toBe(0);
  });
});
