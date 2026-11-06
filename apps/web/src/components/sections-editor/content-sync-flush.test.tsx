import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { useAutosave } from "../sandbox/content/blog/use-autosave";
import {
  type FlushListener,
  resetContentSync,
  settleContentEdits,
  useContentFlushListener,
} from "./content-sync";
import { decofileWriteMutationKey, decofileWriteScope } from "./decofile-api";
import { openDraftTab } from "./preview-draft-link";

const ORG = "acme";
const VM = "vm-1";
const BRANCH = "draft-1";
const project = { orgSlug: ORG, virtualMcpId: VM };

afterEach(() => resetContentSync());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function target(queryClient: QueryClient) {
  return { queryClient, orgSlug: ORG, virtualMcpId: VM, branch: BRANCH };
}

/** A write of the draft, in the editor's write queue, done when `done` is. */
function queueWrite(queryClient: QueryClient, done: Promise<unknown>) {
  return queryClient
    .getMutationCache()
    .build(queryClient, {
      mutationKey: decofileWriteMutationKey(ORG, VM, BRANCH),
      scope: decofileWriteScope(ORG, VM, BRANCH),
      mutationFn: () => done,
    })
    .execute(undefined)
    .catch(() => {});
}

function registerFlush(listener: FlushListener) {
  return renderHook(() => useContentFlushListener(project, listener));
}

describe("settleContentEdits", () => {
  it("resolves at once with nothing armed or queued", async () => {
    const queryClient = new QueryClient();
    let settled = false;
    void settleContentEdits(target(queryClient)).then(() => (settled = true));
    await tick();
    expect(settled).toBe(true);
  });

  it("sends the armed saves and waits for them to land", async () => {
    const queryClient = new QueryClient();
    const write = deferred<void>();
    let flushed = 0;
    registerFlush(() => {
      if (flushed++ === 0) void queueWrite(queryClient, write.promise);
      return false;
    });
    let settled = false;
    void settleContentEdits(target(queryClient)).then(() => (settled = true));
    await tick();
    expect(flushed).toBe(1);
    expect(settled).toBe(false);
    write.resolve();
    await tick();
    expect(settled).toBe(true);
  });

  it("waits for a write queued behind the one on the wire", async () => {
    const queryClient = new QueryClient();
    const first = deferred<void>();
    const second = deferred<void>();
    void queueWrite(queryClient, first.promise);
    void queueWrite(queryClient, second.promise);
    let settled = false;
    void settleContentEdits(target(queryClient)).then(() => (settled = true));
    first.resolve();
    await tick();
    expect(settled).toBe(false);
    second.resolve();
    await tick();
    expect(settled).toBe(true);
  });

  it("asks again while an editor holds a save waiting for another, and gives up after a few rounds", async () => {
    const queryClient = new QueryClient();
    let asked = 0;
    registerFlush(() => {
      asked++;
      return true;
    });
    await settleContentEdits(target(queryClient));
    expect(asked).toBe(5);
  });

  it("resolves when a save fails (its own toast already said so)", async () => {
    const queryClient = new QueryClient();
    const write = deferred<void>();
    registerFlush(() => {
      void queueWrite(queryClient, write.promise);
      return false;
    });
    const settled = settleContentEdits(target(queryClient));
    write.reject(new Error("boom"));
    await expect(settled).resolves.toBeUndefined();
  });

  it("forgets an editor once it unmounts", async () => {
    const queryClient = new QueryClient();
    let asked = 0;
    const { unmount } = registerFlush(() => {
      asked++;
      return false;
    });
    unmount();
    await settleContentEdits(target(queryClient));
    expect(asked).toBe(0);
  });
});

describe("useAutosave with `content`", () => {
  it("saves the pending value once when the edits are settled, not again after the delay", async () => {
    const queryClient = new QueryClient();
    const saved: string[] = [];
    const { result } = renderHook(() =>
      useAutosave<string>("a", (value) => saved.push(value), {
        delay: 20,
        content: project,
      }),
    );
    act(() => result.current[1]("b"));
    act(() => result.current[1]("c"));
    await act(() => settleContentEdits(target(queryClient)));
    expect(saved).toEqual(["c"]);
    expect(result.current[3]).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(saved).toEqual(["c"]);
  });

  it("has nothing to send without `content`", async () => {
    const queryClient = new QueryClient();
    const saved: string[] = [];
    const { result } = renderHook(() =>
      useAutosave<string>("a", (value) => saved.push(value), {
        delay: 10_000,
      }),
    );
    act(() => result.current[1]("b"));
    await settleContentEdits(target(queryClient));
    expect(saved).toEqual([]);
  });
});

describe("openDraftTab", () => {
  it("opens the link at once when nothing is pending", () => {
    const queryClient = new QueryClient();
    const open = spyOn(window, "open").mockImplementation(() => null);
    openDraftTab(target(queryClient), () => "https://site.test/?__draft=d@1");
    expect(open).toHaveBeenCalledWith(
      "https://site.test/?__draft=d@1",
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
  });

  it("opens the tab at the click and sends it to the link built after the pending save", async () => {
    const queryClient = new QueryClient();
    const write = deferred<void>();
    let version = "1";
    registerFlush(() => {
      void queueWrite(
        queryClient,
        write.promise.then(() => {
          version = "2";
        }),
      );
      return false;
    });
    const tab = { opener: {} as unknown, location: { href: "" }, close() {} };
    const open = spyOn(window, "open").mockImplementation(
      () => tab as unknown as Window,
    );
    openDraftTab(
      target(queryClient),
      () => `https://site.test/?__draft=d@${version}`,
    );
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe("");
    write.resolve();
    await tick();
    expect(tab.location.href).toBe("https://site.test/?__draft=d@2");
    open.mockRestore();
  });
});
