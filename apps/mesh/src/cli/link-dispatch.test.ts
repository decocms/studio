import { afterEach, describe, expect, it } from "bun:test";
import { dispatchIntent } from "./link-dispatch";
import {
  getLinkState,
  type LinkActions,
  resetLinkStateForTests,
  setLinkActions,
  setPersistedSandboxes,
  setSelectedHandle,
} from "./link-store";

afterEach(() => resetLinkStateForTests());

type LinkRecord = Parameters<typeof setPersistedSandboxes>[0][number];

function record(handle: string, over: Partial<LinkRecord> = {}): LinkRecord {
  return {
    handle,
    status: "stopped",
    sandboxPath: `/${handle}`,
    port: null,
    previewUrl: null,
    repoCloneUrl: null,
    branch: null,
    projectName: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
    lastSeenAt: null,
    missingSince: null,
    ...over,
  };
}

function rows() {
  setPersistedSandboxes([
    record("a", { status: "ready", previewUrl: "http://a", branch: "ba" }),
    record("b", { status: "stopped", branch: "bb" }),
  ]);
}

function fakeActions(over: Partial<LinkActions> = {}): LinkActions {
  return {
    stopSandbox: async () => {},
    removeSandbox: async () => ({ ok: true }),
    inspectSandbox: () => null,
    quit: async () => {},
    ...over,
  };
}

describe("dispatchIntent", () => {
  it("move seeds and advances selection", () => {
    rows();
    dispatchIntent({ type: "move", delta: 1 });
    expect(getLinkState().selectedHandle).toBe("a");
    dispatchIntent({ type: "move", delta: 1 });
    expect(getLinkState().selectedHandle).toBe("b");
  });

  it("open launches the URL only for a ready row", () => {
    rows();
    setSelectedHandle("a");
    const opened: string[] = [];
    dispatchIntent({ type: "open" }, { openUrl: (u) => opened.push(u) });
    expect(opened).toEqual(["http://a"]);

    setSelectedHandle("b"); // stopped → no URL
    dispatchIntent({ type: "open" }, { openUrl: (u) => opened.push(u) });
    expect(opened).toEqual(["http://a"]);
  });

  it("delete opens a confirm using inspect data", () => {
    rows();
    setSelectedHandle("a");
    setLinkActions(
      fakeActions({
        inspectSandbox: () => ({
          handle: "a",
          branch: "ba",
          sandboxPath: "/a",
          dirtyCount: 2,
          merged: false,
        }),
      }),
    );
    dispatchIntent({ type: "delete" });
    expect(getLinkState().pendingConfirm).toEqual({
      handle: "a",
      branch: "ba",
      dirtyCount: 2,
      merged: false,
    });
  });

  it("confirmYes removes the row on success", async () => {
    rows();
    setSelectedHandle("a");
    let removed = "";
    setLinkActions(
      fakeActions({
        removeSandbox: async (h) => {
          removed = h;
          return { ok: true };
        },
      }),
    );
    dispatchIntent({ type: "delete" });
    dispatchIntent({ type: "confirmYes" });
    await Promise.resolve();
    await Promise.resolve();
    expect(removed).toBe("a");
    expect([...getLinkState().sandboxes.keys()]).toEqual(["b"]);
  });

  it("confirmYes marks the row as removing while the action is in flight", async () => {
    rows();
    setSelectedHandle("a");
    let resolve: (r: { ok: true }) => void = () => {};
    setLinkActions(
      fakeActions({
        removeSandbox: () =>
          new Promise<{ ok: true }>((r) => {
            resolve = r;
          }),
      }),
    );
    dispatchIntent({ type: "delete" });
    dispatchIntent({ type: "confirmYes" });
    // Still in flight: row present and flagged as removing.
    expect(getLinkState().removingHandles.has("a")).toBe(true);
    expect([...getLinkState().sandboxes.keys()]).toEqual(["a", "b"]);
    resolve({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(getLinkState().removingHandles.has("a")).toBe(false);
    expect([...getLinkState().sandboxes.keys()]).toEqual(["b"]);
  });

  it("confirmYes surfaces the error and clears removing on failure", async () => {
    rows();
    setSelectedHandle("a");
    setLinkActions(
      fakeActions({
        removeSandbox: async () => ({ ok: false, error: "nope" }),
      }),
    );
    dispatchIntent({ type: "delete" });
    dispatchIntent({ type: "confirmYes" });
    await Promise.resolve();
    await Promise.resolve();
    expect(getLinkState().actionError).toBe("nope");
    expect(getLinkState().removingHandles.has("a")).toBe(false);
    expect([...getLinkState().sandboxes.keys()]).toEqual(["a", "b"]);
  });

  it("confirmNo clears the pending confirm", () => {
    rows();
    setSelectedHandle("a");
    setLinkActions(fakeActions());
    dispatchIntent({ type: "delete" });
    dispatchIntent({ type: "confirmNo" });
    expect(getLinkState().pendingConfirm).toBeNull();
  });
});
