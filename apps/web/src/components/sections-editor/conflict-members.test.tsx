import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { afterAll, describe, expect, it, mock } from "bun:test";
import { renderHook } from "@testing-library/react";
import * as realMembers from "@/hooks/use-members";

const asked: Array<boolean | undefined> = [];
const membersModule = { ...realMembers };
afterAll(() => {
  mock.module("@/hooks/use-members", () => membersModule);
});
mock.module("@/hooks/use-members", () => ({
  ...realMembers,
  useMembersQuery: (opts?: { enabled?: boolean }) => {
    asked.push(opts?.enabled);
    return { data: undefined };
  },
}));

const { useConflictMembers } = await import("./conflict-author");

describe("useConflictMembers", () => {
  it("reads the org's members on a hosted v8 screen only, so the reconcile window can name who changed it", () => {
    renderHook(() => useConflictMembers(true));
    renderHook(() => useConflictMembers(false));
    expect(asked).toEqual([true, false]);
  });
});
