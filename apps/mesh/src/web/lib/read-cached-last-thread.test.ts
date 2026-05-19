import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetManagerRegistry,
  getOrOpenManager,
} from "@/web/components/chat/store/thread-manager-store";
import { readCachedLastThread } from "./read-cached-last-thread";
import type { Task } from "@/web/components/chat/task/types";

const ORG = "acme";
const LOCATOR = "org/proj";
const USER_ID = "user-1";
const AGENT_ID = "agent-1";

function task(overrides: Partial<Task>): Task {
  return {
    id: "t-default",
    title: "Test thread",
    created_at: "2026-04-29T00:00:00.000Z",
    updated_at: "2026-04-29T00:00:00.000Z",
    created_by: USER_ID,
    virtual_mcp_id: AGENT_ID,
    ...overrides,
  };
}

const realFetch = globalThis.fetch;
function stubFetchEmptySnapshot() {
  const enc = new TextEncoder();
  globalThis.fetch = (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`event: snapshot\ndata: {"threads":[]}\n\n`));
        c.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

function seed(items: Task[]) {
  stubFetchEmptySnapshot();
  const m = getOrOpenManager(ORG, LOCATOR);
  m.threads.set(items);
  return m;
}

afterEach(() => {
  __resetManagerRegistry();
  globalThis.fetch = realFetch;
});

describe("readCachedLastThread", () => {
  test("returns null when no manager is open for the (org, locator) pair", () => {
    expect(readCachedLastThread(ORG, LOCATOR, AGENT_ID, USER_ID)).toBeNull();
  });

  test("returns null when the store is empty", () => {
    seed([]);
    expect(readCachedLastThread(ORG, LOCATOR, AGENT_ID, USER_ID)).toBeNull();
  });

  test("returns the single matching thread", () => {
    seed([task({ id: "t1", updated_at: "2026-04-29T01:00:00.000Z" })]);
    const result = readCachedLastThread(ORG, LOCATOR, AGENT_ID, USER_ID);
    expect(result?.id).toBe("t1");
  });

  test("picks the freshest match", () => {
    seed([
      task({ id: "older", updated_at: "2026-04-29T01:00:00.000Z" }),
      task({ id: "newer", updated_at: "2026-04-29T05:00:00.000Z" }),
      task({ id: "oldest", updated_at: "2026-04-28T00:00:00.000Z" }),
    ]);
    const result = readCachedLastThread(ORG, LOCATOR, AGENT_ID, USER_ID);
    expect(result?.id).toBe("newer");
  });

  test("rejects threads for a different agent", () => {
    seed([task({ id: "wrong-agent", virtual_mcp_id: "agent-2" })]);
    expect(readCachedLastThread(ORG, LOCATOR, AGENT_ID, USER_ID)).toBeNull();
  });

  test("rejects threads created by a different user", () => {
    seed([task({ id: "wrong-user", created_by: "user-2" })]);
    expect(readCachedLastThread(ORG, LOCATOR, AGENT_ID, USER_ID)).toBeNull();
  });

  test("rejects archived (hidden) threads", () => {
    seed([
      task({
        id: "archived",
        hidden: true,
        updated_at: "2026-04-29T05:00:00.000Z",
      }),
      task({ id: "live", updated_at: "2026-04-29T01:00:00.000Z" }),
    ]);
    const result = readCachedLastThread(ORG, LOCATOR, AGENT_ID, USER_ID);
    expect(result?.id).toBe("live");
  });

  test("does not match when locator differs from the open manager", () => {
    seed([task({ id: "elsewhere" })]);
    expect(
      readCachedLastThread(ORG, "other-locator", AGENT_ID, USER_ID),
    ).toBeNull();
  });

  test("does not match when org differs from the open manager", () => {
    seed([task({ id: "elsewhere" })]);
    expect(
      readCachedLastThread("other-org", LOCATOR, AGENT_ID, USER_ID),
    ).toBeNull();
  });
});
