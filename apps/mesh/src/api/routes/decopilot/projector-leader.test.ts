import { describe, expect, test } from "bun:test";
import { selectLeader } from "./projector-leader";

describe("selectLeader", () => {
  test("lowest podId among alive pods is leader", () => {
    expect(selectLeader(new Set(["pod-c", "pod-a", "pod-b"]))).toBe("pod-a");
  });
  test("empty set → no leader", () => {
    expect(selectLeader(new Set())).toBeNull();
  });
  test("single pod is the leader", () => {
    expect(selectLeader(new Set(["only"]))).toBe("only");
  });
});
