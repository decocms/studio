import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessStreamInputWire } from "@decocms/sandbox/dispatch/schemas";
import { clientRejection } from "./claude-code";
import type { ImageBlock } from "./image-blocks";

interface Entry {
  type: "user" | "assistant";
  uuid: string;
  images: number;
}
interface Sent {
  session: string;
  resumed: boolean;
  images: number;
  historyImages: number;
  /** The memory settings of the `query` call whose CLI took this request. */
  settings: unknown;
}

/** What the fake provider answers a request with: an error text, or null to accept it. */
type Provider = (request: Sent) => { category: string; text: string } | null;

// A private copy of the runner: it keeps one SDK session per process, and the other test files share the default copy.
const RUNNER = "./claude-code?image-fallback";
// The memory tests keep sessions of their own, so they get another copy.
const MEMORY_RUNNER = "./claude-code?image-fallback-memory";
const runner = async (copy: string): Promise<typeof import("./claude-code")> =>
  import(copy);

const transcripts = new Map<string, Entry[]>();
const sent: Sent[] = [];
const forks: { from: string; upToMessageId: string | undefined }[] = [];
let queries = 0;
let provider: Provider = () => null;
/** Errors the next `query` calls throw before producing anything, in order. */
let throws: string[] = [];

/** The memory part of a `query` call's flag-layer settings; undefined when it sets none. */
const memoryOf = (settings: Record<string, unknown> = {}) => {
  const memory = Object.fromEntries(
    Object.entries(settings).filter(([key]) => key !== "skillOverrides"),
  );
  return Object.keys(memory).length ? memory : undefined;
};

const imagesIn = (content: unknown): number =>
  Array.isArray(content)
    ? content.filter((block) => block?.type === "image").length
    : 0;

/** The CLI's side of one user turn: it is persisted before the provider answers. */
async function* turn(
  session: string,
  resumed: boolean,
  content: unknown,
  uuid: string | undefined,
  first: boolean,
  settings: unknown,
) {
  const entries = transcripts.get(session) ?? [];
  transcripts.set(session, entries);
  entries.push({
    type: "user",
    uuid: uuid ?? crypto.randomUUID(),
    images: imagesIn(content),
  });
  const request = {
    session,
    resumed,
    images: imagesIn(content),
    historyImages: entries.reduce((sum, entry) => sum + entry.images, 0),
    settings,
  };
  sent.push(request);
  if (first) {
    yield {
      type: "system",
      subtype: "init",
      tools: [],
      skills: [],
      mcp_servers: [],
    };
  }
  const id = crypto.randomUUID();
  const refused = provider(request);
  entries.push({ type: "assistant", uuid: id, images: 0 });
  if (refused) {
    yield {
      type: "assistant",
      parent_tool_use_id: null,
      uuid: id,
      error: refused.category,
      message: {
        id,
        model: "<synthetic>",
        content: [{ type: "text", text: refused.text }],
      },
    };
    yield {
      type: "result",
      subtype: "success",
      is_error: true,
      result: refused.text,
      uuid: `${id}-r`,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    return;
  }
  yield {
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "message_start", message: { id: `msg_${id}` } },
  };
  yield {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: id,
    message: { id: `msg_${id}`, content: [{ type: "text", text: "Hello" }] },
  };
  yield {
    type: "result",
    subtype: "success",
    is_error: false,
    uuid: `${id}-r`,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({
    prompt,
    options,
  }: {
    prompt:
      | string
      | AsyncIterable<{ uuid?: string; message: { content: unknown } }>;
    options: {
      resume?: string;
      sessionId?: string;
      settings?: Record<string, unknown>;
    };
  }) => {
    queries++;
    const session = options.resume ?? options.sessionId ?? crypto.randomUUID();
    const resumed = options.resume !== undefined;
    const messages = async function* () {
      const failure = throws.shift();
      if (failure) throw new Error(failure);
      if (typeof prompt === "string") {
        yield* turn(
          session,
          resumed,
          prompt,
          undefined,
          true,
          memoryOf(options.settings),
        );
        return;
      }
      let first = true;
      for await (const message of prompt) {
        yield* turn(
          session,
          resumed,
          message.message.content,
          message.uuid,
          first,
          memoryOf(options.settings),
        );
        first = false;
      }
    };
    return Object.assign(messages(), { interrupt: async () => {} });
  },
  getSessionMessages: async (session: string) => transcripts.get(session) ?? [],
  forkSession: async (
    session: string,
    options?: { upToMessageId?: string },
  ) => {
    forks.push({ from: session, upToMessageId: options?.upToMessageId });
    const entries = transcripts.get(session) ?? [];
    const end = entries.findIndex(
      (entry) => entry.uuid === options?.upToMessageId,
    );
    const sessionId = crypto.randomUUID();
    transcripts.set(
      sessionId,
      entries
        .slice(0, end + 1)
        .map((entry) => ({ ...entry, uuid: crypto.randomUUID() })),
    );
    return { sessionId };
  },
}));

const PATH_LINE = "- a.png: /app/org/upload/a.png (tool URL: x)";
const image: ImageBlock = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
};
const withImage = () => [image];
const withoutImage = () => [];

const input = (threadId: string, memory?: HarnessStreamInputWire["memory"]) =>
  ({
    threadId,
    ...(memory ? { memory } : {}),
    userMessage: { parts: [{ type: "text", text: `${PATH_LINE}\n\nlook` }] },
    harness: {},
    workspace: { cwd: null },
    models: { thinking: { id: "m", title: "M", credentialId: "c" } },
    mcp: { url: "", headers: {}, expiresAt: 1 },
    mode: "default",
    temperature: 0,
    toolApprovalLevel: "auto",
    user: { id: "u", email: "e@x.com" },
    organizationId: "org_1",
    agent: { id: "agent_1" },
  }) as HarnessStreamInputWire;

interface Outcome {
  types: string[];
  finish: string | undefined;
  errorText: string | undefined;
}

/** One Studio turn through the real runner, against the fake SDK above. */
async function run(
  threadId: string,
  readImages: () => ImageBlock[],
  memory?: HarnessStreamInputWire["memory"],
  copy = RUNNER,
): Promise<Outcome> {
  const { runClaudeCode } = await runner(copy);
  const chunks: { type: string; finishReason?: string; errorText?: string }[] =
    [];
  await runClaudeCode(
    input(threadId, memory),
    (frame) => {
      chunks.push(...(frame.chunks as typeof chunks));
    },
    0,
    undefined,
    readImages,
  );
  return {
    types: chunks.map((chunk) => chunk.type),
    finish: chunks.find((chunk) => chunk.type === "finish")?.finishReason,
    errorText: chunks.find((chunk) => chunk.type === "error")?.errorText,
  };
}

const opaque400: Provider = (request) =>
  request.historyImages > 0
    ? { category: "unknown", text: "API Error: 400 Provider returned error" }
    : null;

let logged: string[] = [];
const realError = console.error;
const fallbackLines = () =>
  logged.filter((line) => line.includes("refused a turn with image blocks"));
const storedSession = async (threadId: string) =>
  (
    await Bun.file(
      join(process.env.CLAUDE_CONFIG_DIR ?? "", "deco-sessions", threadId),
    ).text()
  ).trim();

beforeEach(() => {
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "runner-images-"));
  process.env.ANTHROPIC_BASE_URL = "https://provider.example/api";
  transcripts.clear();
  sent.length = 0;
  forks.length = 0;
  queries = 0;
  provider = () => null;
  throws = [];
  logged = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.join(" "));
  };
});

afterEach(() => {
  console.error = realError;
  delete process.env.ANTHROPIC_BASE_URL;
});

describe("a turn whose image blocks the provider refuses", () => {
  test("is resent once as text, and the next turn runs on a session without the images", async () => {
    provider = opaque400;
    const outcome = await run("thrd_first", withImage);
    expect(outcome.finish).toBe("stop");
    expect(outcome.errorText).toBeUndefined();
    expect(outcome.types.filter((type) => type === "start")).toHaveLength(1);
    expect(sent.map((request) => request.images)).toEqual([1, 0]);
    // Nothing preceded the turn, so there is no history to copy.
    expect(forks).toEqual([]);
    expect(sent[1]).toMatchObject({ resumed: false, historyImages: 0 });
    expect(sent[1]?.session).not.toBe(sent[0]?.session);
    expect(await storedSession("thrd_first")).toBe(sent[1]?.session ?? "");

    const next = await run("thrd_first", withoutImage);
    expect(next.finish).toBe("stop");
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({
      session: sent[1]?.session,
      resumed: true,
      historyImages: 0,
    });
  });

  test("logs one line with the provider and status, never the image or its path", async () => {
    provider = opaque400;
    await run("thrd_log", withImage);
    expect(fallbackLines()).toHaveLength(1);
    expect(fallbackLines()[0]).toContain("provider.example");
    expect(fallbackLines()[0]).toContain("status 400");
    expect(logged.join("\n")).not.toContain(image.source.data);
    expect(logged.join("\n")).not.toContain("/app/org/upload/a.png");
  });

  test("on a resumed session keeps the history from before the turn", async () => {
    provider = opaque400;
    await run("thrd_resumed", withoutImage);
    const original = sent[0]?.session ?? "";
    const kept = [...(transcripts.get(original) ?? [])];
    expect(kept.map((entry) => entry.type)).toEqual(["user", "assistant"]);

    const outcome = await run("thrd_resumed", withImage);
    expect(outcome.finish).toBe("stop");
    expect(sent.slice(1).map((request) => request.images)).toEqual([1, 0]);
    expect(sent[1]).toMatchObject({ session: original, resumed: true });
    // Cut at the last message before the refused turn.
    expect(forks).toEqual([{ from: original, upToMessageId: kept[1]?.uuid }]);
    const fork = sent[2]?.session ?? "";
    expect(fork).not.toBe(original);
    expect(sent[2]).toMatchObject({ resumed: true, historyImages: 0 });
    expect((transcripts.get(fork) ?? []).map((entry) => entry.type)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(await storedSession("thrd_resumed")).toBe(fork);

    const next = await run("thrd_resumed", withoutImage);
    expect(next.finish).toBe("stop");
    expect(sent[3]).toMatchObject({
      session: fork,
      resumed: true,
      historyImages: 0,
    });
    expect(fallbackLines()).toHaveLength(1);
  });

  test("a refusal that is not about the images surfaces as itself after the one resend", async () => {
    provider = () => ({
      category: "unknown",
      text: "API Error: 400 Provider returned error",
    });
    const outcome = await run("thrd_other", withImage);
    expect(sent.map((request) => request.images)).toEqual([1, 0]);
    expect(queries).toBe(2);
    expect(outcome.finish).toBe("error");
    expect(outcome.errorText).toBe("API Error: 400 Provider returned error");
    expect(fallbackLines()).toHaveLength(1);
    // The session left behind is the one without the images.
    expect(await storedSession("thrd_other")).toBe(sent[1]?.session ?? "");
  });

  test("a 429 or 5xx the CLI reports is not resent without the images", async () => {
    for (const [category, text] of [
      ["rate_limit", "API Error: 429 Provider returned error"],
      ["server_error", "API Error: 502 Provider returned error"],
      ["overloaded", "API Error: 529 Overloaded"],
      ["unknown", "API Error: 408 Request timeout"],
    ]) {
      sent.length = 0;
      queries = 0;
      provider = () => ({ category: category ?? "", text: text ?? "" });
      const outcome = await run(`thrd_${category}`, withImage);
      expect(sent.map((request) => request.images)).toEqual([1]);
      expect(queries).toBe(1);
      expect(outcome.finish).toBe("error");
      expect(outcome.errorText).toBe(text);
    }
    expect(fallbackLines()).toEqual([]);
    expect(forks).toEqual([]);
  });

  test("a 5xx the SDK throws is retried as before, images included", async () => {
    throws = ["API Error: 502 Provider returned error"];
    const outcome = await run("thrd_thrown", withImage);
    expect(queries).toBe(2);
    expect(sent.map((request) => request.images)).toEqual([1]);
    expect(outcome.types).toContain("data-run-status");
    expect(outcome.finish).toBe("stop");
    expect(fallbackLines()).toEqual([]);
  });

  test("a text-only turn the provider refuses is not resent", async () => {
    provider = () => ({
      category: "unknown",
      text: "API Error: 400 Provider returned error",
    });
    const outcome = await run("thrd_text", withoutImage);
    expect(queries).toBe(1);
    expect(outcome.finish).toBe("error");
    expect(fallbackLines()).toEqual([]);
  });

  // Last: it leaves a kept session behind in the runner module.
  test("on a kept session moves to a copy cut before the turn, and keeps that one", async () => {
    process.env.HARNESS_RUNNER_PERSISTENT = "1";
    try {
      provider = opaque400;
      await run("thrd_kept", withoutImage);
      const original = sent[0]?.session ?? "";
      expect(queries).toBe(1);

      const outcome = await run("thrd_kept", withImage);
      expect(outcome.finish).toBe("stop");
      expect(outcome.types.filter((type) => type === "start")).toHaveLength(1);
      // The refused turn went to the kept session; the resend started a new one.
      expect(sent[1]).toMatchObject({ session: original, images: 1 });
      expect(queries).toBe(2);
      const fork = sent[2]?.session ?? "";
      expect(forks).toHaveLength(1);
      expect(sent[2]).toMatchObject({
        resumed: true,
        images: 0,
        historyImages: 0,
      });
      expect(fork).not.toBe(original);

      const next = await run("thrd_kept", withoutImage);
      expect(next.finish).toBe("stop");
      // Answered by the session the resend left running, which holds no image.
      expect(queries).toBe(2);
      expect(sent[3]).toMatchObject({ session: fork, historyImages: 0 });
      expect(await storedSession("thrd_kept")).toBe(fork);
    } finally {
      delete process.env.HARNESS_RUNNER_PERSISTENT;
    }
  });
});

describe("the memory a resend runs with", () => {
  const home = "/app/org/home/users/user_1";
  const on = { enabled: true, directory: home } as const;
  const off = { enabled: false } as const;
  const onSettings = { autoMemoryEnabled: true, autoMemoryDirectory: home };
  const offSettings = { autoMemoryEnabled: false };
  const runWith = (
    threadId: string,
    readImages: () => ImageBlock[],
    memory?: HarnessStreamInputWire["memory"],
  ) => run(threadId, readImages, memory, MEMORY_RUNNER);
  const settingsSent = () => sent.map((request) => request.settings);

  test("is the refused turn's, on a fresh session and on a copy of a resumed one", async () => {
    provider = opaque400;
    for (const [name, memory, settings] of [
      ["on", on, onSettings],
      ["off", off, offSettings],
      ["default", undefined, undefined],
    ] as const) {
      sent.length = 0;
      forks.length = 0;
      const thread = `thrd_memory_${name}`;
      // Refused on the thread's first turn: the resend starts a fresh session.
      await runWith(thread, withImage, memory);
      expect(sent.map((request) => request.images)).toEqual([1, 0]);
      expect(sent[1]?.resumed).toBe(false);
      expect(settingsSent()).toEqual([settings, settings]);
      // Refused on a resumed session: the resend resumes a copy cut before the turn.
      const outcome = await runWith(thread, withImage, memory);
      expect(outcome.finish).toBe("stop");
      expect(forks).toHaveLength(1);
      expect(sent[3]).toMatchObject({ resumed: true, images: 0 });
      expect(sent[3]?.session).not.toBe(sent[2]?.session);
      expect(settingsSent()).toEqual([settings, settings, settings, settings]);
    }
  });

  // Last: it leaves a kept session behind in the runner module.
  test("is kept by the session the resend leaves running, which a turn with another memory never reuses", async () => {
    process.env.HARNESS_RUNNER_PERSISTENT = "1";
    try {
      provider = opaque400;
      await runWith("thrd_memory_kept", withoutImage, on);
      expect(queries).toBe(1);
      // Refused on the kept session; the resend starts a CLI with the same memory.
      await runWith("thrd_memory_kept", withImage, on);
      expect(queries).toBe(2);
      expect(forks).toHaveLength(1);
      const resent = sent[2]?.session;
      expect(settingsSent()).toEqual([onSettings, onSettings, onSettings]);

      // Same memory: answered by the session the resend left running.
      await runWith("thrd_memory_kept", withoutImage, on);
      expect(queries).toBe(2);
      expect(sent[3]).toMatchObject({ session: resent, settings: onSettings });

      // Another memory: a new CLI on the same transcript, never the kept one.
      await runWith("thrd_memory_kept", withoutImage, off);
      expect(queries).toBe(3);
      expect(sent[4]).toMatchObject({
        session: resent,
        resumed: true,
        settings: offSettings,
      });

      // That one is kept in turn, and its resend is off as well.
      await runWith("thrd_memory_kept", withImage, off);
      expect(queries).toBe(4);
      expect(sent.slice(5).map((request) => request.images)).toEqual([1, 0]);
      expect(settingsSent().slice(5)).toEqual([offSettings, offSettings]);

      // No field after one was set is another memory too: the harness default.
      await runWith("thrd_memory_kept", withoutImage);
      expect(queries).toBe(5);
      expect(sent[7]?.settings).toBeUndefined();
    } finally {
      delete process.env.HARNESS_RUNNER_PERSISTENT;
    }
  });
});

describe("clientRejection", () => {
  test("a 4xx other than 408 and 429 is a client rejection", () => {
    for (const status of [400, 401, 402, 403, 404, 413, 422]) {
      expect(
        clientRejection(
          "unknown",
          `API Error: ${status} Provider returned error`,
        ),
      ).toBe(`status ${status}`);
    }
  });

  test("408, 429 and 5xx are not", () => {
    for (const status of [408, 429, 500, 502, 529]) {
      expect(
        clientRejection("invalid_request", `API Error: ${status} x`),
      ).toBeNull();
    }
  });

  test("without a status only the CLI's invalid_request category counts", () => {
    expect(
      clientRejection("invalid_request", "Request too large (max 32MB)."),
    ).toBe("invalid_request");
    for (const category of [
      "unknown",
      "rate_limit",
      "server_error",
      "authentication_failed",
      undefined,
    ]) {
      expect(
        clientRejection(category, "API Error: Connection error."),
      ).toBeNull();
    }
  });
});
