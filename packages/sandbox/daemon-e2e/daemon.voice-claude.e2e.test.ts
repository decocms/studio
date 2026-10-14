import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TEXT_MODE_PROMPT, VOICE_MODE_PROMPT } from "@decocms/shared/voice";
import {
  jsonAuthHeaders,
  startDaemon,
  stopDaemon,
  url,
  type Daemon,
} from "./daemon.e2e.helpers";

// Opt in because this runs the real Claude Code executable and SDK, not a stub.
test.skipIf(process.env.DAEMON_E2E_CLAUDE_VOICE !== "1")(
  "Claude Code edits a file in voice mode and resumes the same session in text",
  async () => {
    const configDir = await mkdtemp(join(tmpdir(), "studio-voice-claude-"));
    let daemon: Daemon | null = null;
    const requests: Array<{ system: unknown; messages: unknown }> = [];
    let toolIssued = false;
    const model = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/messages/count_tokens")
          return Response.json({ input_tokens: 100 });
        if (path !== "/v1/messages") return Response.json({});
        const body = await request.json();
        requests.push({ system: body.system, messages: body.messages });
        const useTool =
          !toolIssued &&
          JSON.stringify(body.messages.at(-1)).includes(
            "Change the homepage title",
          );
        if (useTool) toolIssued = true;
        const message = {
          id: `msg_${requests.length}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1 },
        };
        const event = (type: string, fields: object = {}) =>
          `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
        const block = useTool
          ? {
              type: "tool_use",
              id: "tool_write_home",
              name: "Write",
              input: {},
            }
          : { type: "text", text: "" };
        const delta = useTool
          ? {
              type: "input_json_delta",
              partial_json: JSON.stringify({
                file_path: join(daemon!.appDir, "homepage.html"),
                content: "<h1>Changed by Claude Code</h1>\n",
              }),
            }
          : { type: "text_delta", text: "Atualizei o título da página." };
        return new Response(
          event("message_start", { message }) +
            event("content_block_start", { index: 0, content_block: block }) +
            event("content_block_delta", { index: 0, delta }) +
            event("content_block_stop", { index: 0 }) +
            event("message_delta", {
              delta: {
                stop_reason: useTool ? "tool_use" : "end_turn",
                stop_sequence: null,
              },
              usage: { output_tokens: 20 },
            }) +
            event("message_stop"),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      daemon = await startDaemon({
        HARNESS_RUNNER_CMD: JSON.stringify([
          process.execPath,
          resolve(import.meta.dir, "../../harness-runner/main.ts"),
        ]),
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_OAUTH_TOKEN: "",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_API_KEY: "synthetic-anthropic-key",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.port}`,
        CLAUDE_CODE_MODEL: "claude-sonnet-4-6",
      });
      const dispatch = async (voiceMode: boolean, text: string) => {
        const response = await fetch(url(daemon!, "/_sandbox/dispatch"), {
          method: "POST",
          headers: jsonAuthHeaders(),
          signal: AbortSignal.timeout(60_000),
          body: JSON.stringify({
            runId: crypto.randomUUID(),
            input: {
              threadId: "thread_voice_example",
              userMessage: {
                role: "user",
                parts: [
                  { type: "text", text },
                  {
                    type: "text",
                    text: voiceMode ? VOICE_MODE_PROMPT : TEXT_MODE_PROMPT,
                  },
                ],
              },
              harness: {},
              workspace: { cwd: "/repo", branch: null },
              models: {
                thinking: {
                  id: "claude-sonnet-4-6",
                  title: "Claude",
                  credentialId: "credential_example",
                },
              },
              mcp: { url: "", headers: {}, expiresAt: Date.now() + 60_000 },
              mode: "default",
              temperature: 0,
              toolApprovalLevel: "auto",
              user: { id: "user_example", email: "user@example.test" },
              organizationId: "org_example",
              agent: {
                id: "agent_example",
                instructions: "Edit the website when requested.",
              },
            },
          }),
        });
        const responseBody = await response.text();
        expect(response.status, responseBody).toBe(200);
        const frames = responseBody
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(frames.filter((frame) => frame.error)).toEqual([]);
        expect(frames.at(-1).done).toBe(true);
        expect(JSON.stringify(frames)).toContain(
          "Atualizei o título da página.",
        );
        return frames;
      };
      await dispatch(false, "Describe the project");
      const sessionFile = join(configDir, "deco-sessions/thread_voice_example");
      const sessionId = await readFile(sessionFile, "utf8");
      const voiceFrames = await dispatch(true, "Change the homepage title");
      expect(JSON.stringify(voiceFrames)).toContain("tool-output-available");
      expect(await readFile(join(daemon.appDir, "homepage.html"), "utf8")).toBe(
        "<h1>Changed by Claude Code</h1>\n",
      );
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(
        requests.some((request) =>
          JSON.stringify(request.messages).includes(VOICE_MODE_PROMPT),
        ),
      ).toBe(true);
      const voiceRequestCount = requests.length;
      await dispatch(false, "Explain the change in text");
      const followup = requests.slice(voiceRequestCount).at(-1)!;
      expect(JSON.stringify(followup.system)).not.toContain(VOICE_MODE_PROMPT);
      expect(JSON.stringify(followup.messages)).toContain(
        "Change the homepage title",
      );
      expect(JSON.stringify(followup.messages)).toContain("tool_write_home");
      expect(JSON.stringify(followup.messages)).toContain(
        "Explain the change in text",
      );
      expect(JSON.stringify(followup.messages)).toContain(TEXT_MODE_PROMPT);
      expect(await readFile(sessionFile, "utf8")).toBe(sessionId);
    } finally {
      await stopDaemon(daemon);
      await model.stop(true);
      await rm(configDir, { recursive: true, force: true });
    }
  },
  150_000,
);
