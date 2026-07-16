import { expect, test } from "bun:test";
import { threadBranch, threadIdFromBranch } from "./thread-repo";

test("threadBranch round-trips through threadIdFromBranch", () => {
  const id = "f3ef4465-b187-4e8d-b71a-a36cf4035046";
  expect(threadIdFromBranch(threadBranch(id))).toBe(id);
  expect(
    threadIdFromBranch(threadBranch(id, "conn_6-MnS2eSZ3z-2BBVwFQrR")),
  ).toBe(id);
});

test("threadBranch encodes the connection id so repos get distinct branches", () => {
  const id = "t1";
  expect(threadBranch(id, "conn_a")).not.toBe(threadBranch(id, "conn_b"));
  expect(threadBranch(id, "conn_a")).toBe("thread:t1/conn_a");
});

test("threadIdFromBranch ignores non-thread branches", () => {
  expect(threadIdFromBranch("ephemeral")).toBeNull();
  expect(threadIdFromBranch("main")).toBeNull();
  expect(threadIdFromBranch(null)).toBeNull();
});
