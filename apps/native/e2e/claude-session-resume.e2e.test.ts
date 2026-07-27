/**
 * Black-box contract for native Claude Code chat continuity.
 *
 * Each turn launches a fresh CLI process with exactly one new user message.
 * SQLite preserves the first process's session id, and later processes receive
 * `--resume <id>` plus only the latest message. The fixture intentionally does
 * not re-emit its session id on resumed turns.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, it } from "bun:test";

import {
  signInAndCompleteSession,
  startAuthenticatedUpstream,
} from "./authenticated-upstream";
import {
  describeLocalApi,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  type LocalApi,
  startLocalApi,
  stopLocalApi,
  url,
} from "./helpers";

const STUB_CLAUDE_PATH = fileURLToPath(
  new URL("./fixtures/stub-claude-resume.mjs", import.meta.url),
);
const SYSTEM_SENTINEL = "SYSTEM_HISTORY_MUST_NOT_REACH_CLAUDE_74d011";

interface Invocation {
  args: string[];
  prompt: string;
  resumeSessionId: string | null;
}

function readInvocations(path: string): Invocation[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Invocation);
}

function parseText(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as unknown)
    .filter(
      (
        chunk,
      ): chunk is {
        type: string;
        delta?: string;
      } => typeof chunk === "object" && chunk !== null && "type" in chunk,
    )
    .filter((chunk) => chunk.type === "text-delta")
    .map((chunk) => chunk.delta ?? "")
    .join("");
}

async function dispatch(
  api: LocalApi,
  threadId: string,
  messageId: string,
  prompt: string,
): Promise<string> {
  const org = "claude-resume-org";
  const response = await fetch(
    url(api, `/api/${org}/decopilot/threads/${threadId}/messages`),
    {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        messages: [
          {
            id: `system-${messageId}`,
            role: "system",
            parts: [{ type: "text", text: SYSTEM_SENTINEL }],
          },
          {
            id: messageId,
            role: "user",
            parts: [{ type: "text", text: prompt }],
          },
        ],
        tier: "smart",
        mode: "default",
        toolApprovalLevel: "auto",
        agent: { id: "claude-resume-vmcp" },
        harnessId: "claude-code",
      }),
    },
  );
  expect(response.status).toBe(202);

  const stream = await fetch(
    url(api, `/api/${org}/decopilot/threads/${threadId}/stream`),
    { headers: jsonAuthHeaders() },
  );
  expect(stream.status).toBe(200);
  return stream.text();
}

describeLocalApi("native Claude Code session resume", () => {
  let api: LocalApi;
  let upstream: ReturnType<typeof startAuthenticatedUpstream>;
  let tempDir: string;
  let invocationLog: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "native-claude-resume-"));
    invocationLog = join(tempDir, "invocations.jsonl");
    upstream = startAuthenticatedUpstream();
    api = await startLocalApi({
      DECOCMS_UPSTREAM_URL: upstream.url,
      LOCAL_API_TOKEN_STORE: "memory",
      LOCAL_API_CLAUDE_BIN: JSON.stringify(["node", STUB_CLAUDE_PATH]),
      LOCAL_API_CODEX_BIN: join(tempDir, "missing-codex"),
      STUB_CLAUDE_INVOCATION_LOG: invocationLog,
    });
    await signInAndCompleteSession(api);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await stopLocalApi(api);
    upstream.server.stop(true);
    rmSync(tempDir, { recursive: true, force: true });
  }, HOOK_TIMEOUT_MS);

  it("keeps one session id and sends only the newest user message on every resumed turn", async () => {
    const threadId = "claude-resume-thread";
    const prompts = [
      "FIRST_ONLY_f57a26",
      "SECOND_ONLY_794caa",
      "THIRD_ONLY_3f1c82",
    ];

    for (const [index, prompt] of prompts.entries()) {
      const raw = await dispatch(
        api,
        threadId,
        `claude-resume-message-${index}`,
        prompt,
      );
      expect(parseText(raw)).toBe(`reply:${prompt}`);
    }

    const invocations = readInvocations(invocationLog);
    expect(invocations).toHaveLength(3);
    expect(invocations.map((invocation) => invocation.prompt)).toEqual(prompts);
    expect(invocations.map((invocation) => invocation.resumeSessionId)).toEqual(
      [
        null,
        "770886ee-0c27-444d-b6b1-85fa370466e7",
        "770886ee-0c27-444d-b6b1-85fa370466e7",
      ],
    );

    for (const [index, invocation] of invocations.entries()) {
      expect(invocation.args[1]).toBe(prompts[index]);
      expect(invocation.args).not.toContain(SYSTEM_SENTINEL);
      for (const olderPrompt of prompts.slice(0, index)) {
        expect(invocation.args).not.toContain(olderPrompt);
      }
    }
  }, 30_000);
});
