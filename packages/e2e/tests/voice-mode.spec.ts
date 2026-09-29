import { createServer } from "node:http";
import type { APIRequestContext } from "@playwright/test";
import { expect, newApiContext, test } from "../fixtures/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { signUpViaApi } from "../fixtures/auth-api";
import { connectDevDb } from "../fixtures/db";
import { sleep } from "@decocms/shared/std";

test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      ...(process.env.E2E_VOICE_WAV
        ? [
            `--use-file-for-fake-audio-capture=${process.env.E2E_VOICE_WAV}%noloop`,
          ]
        : []),
    ],
  },
  trace: "off",
});

async function createThread(api: APIRequestContext, org: string) {
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    org,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title: "Voice test agent",
        description: "Synthetic voice test",
        status: "active",
        pinned: false,
        connections: [],
      },
    },
  );
  const thread = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    org,
    "COLLECTION_THREADS_CREATE",
    { data: { virtual_mcp_id: agent.item.id } },
  );
  return { threadId: thread.item.id, agentId: agent.item.id };
}

async function setVoiceFlag(
  api: APIRequestContext,
  org: string,
  enabled: boolean,
) {
  const { id } = await callSelfMcpTool<{ id: string }>(
    api,
    org,
    "ORGANIZATION_GET",
    {},
  );
  await callSelfMcpTool(api, org, "ORGANIZATION_SETTINGS_UPDATE", {
    organizationId: id,
    flags: { voice_mode: enabled },
  });
  return id;
}

test("voice bootstrap checks membership, ownership and its default-off flag", async ({
  authedPage,
  playwright,
}) => {
  const { page, orgSlug } = authedPage;
  const api = page.context().request;
  const { threadId, agentId } = await createThread(api, orgSlug);
  const path = `/api/${orgSlug}/threads/${threadId}/voice/sessions`;
  expect((await api.post(path)).status()).toBe(403);
  const voiceTurn = await api.post(
    `/api/${orgSlug}/decopilot/threads/${threadId}/messages`,
    {
      data: {
        agent: { id: agentId },
        voiceMode: true,
        messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
      },
    },
  );
  expect(voiceTurn.status()).toBe(403);
  const outsider = await newApiContext(playwright);
  try {
    expect((await outsider.post(path)).status()).toBe(401);
    await signUpViaApi(outsider);
    expect((await outsider.post(path)).status()).toBe(403);
  } finally {
    await outsider.dispose();
  }
});

for (const harnessId of ["decopilot", "claude-code"]) {
  test(`voice UI preserves a draft on ${harnessId} when entering and leaving`, async ({
    authedPage,
  }) => {
    test.slow();
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const { threadId, agentId } = await createThread(api, orgSlug);
    const db = await connectDevDb();
    try {
      await db.query(
        "UPDATE threads SET harness_id = $1, message_storage_version = 2 WHERE id = $2",
        [harnessId, threadId],
      );
    } finally {
      await db.end();
    }
    // Listing one model makes the shared composer available without a paid provider.
    const model = await startModel();
    try {
      await configureModel(api, orgSlug, model.url);
      await page.goto(
        `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&sidepanel=true`,
      );
      await expect(page.locator('[data-chat-input="true"]')).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        page.getByRole("button", { name: "Start voice mode" }),
      ).toHaveCount(0);
      await page.goto(`/${orgSlug}/settings/general`);
      const toggle = page.getByRole("switch", {
        name: "Voice mode",
        exact: true,
      });
      await expect(toggle).not.toBeChecked({ timeout: 60_000 });
      await toggle.click();
      await expect(toggle).toBeChecked();
      await expect(toggle).toBeEnabled();
      await page.goto(
        `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&sidepanel=true`,
      );
      expect(
        await page.evaluate(() => typeof navigator.mediaDevices?.getUserMedia),
      ).toBe("function");
      expect(
        await callSelfMcpTool(api, orgSlug, "ORGANIZATION_SETTINGS_GET", {}),
      ).toMatchObject({ flags: { voice_mode: true } });
      const input = page.locator('[data-chat-input="true"]');
      await expect(input).toBeVisible({ timeout: 60_000 });
      await input.fill("Keep this draft");
      const url = page.url();
      await page.getByRole("button", { name: "Start voice mode" }).click();
      await expect(
        page.getByRole("region", { name: "Voice conversation" }),
      ).toBeVisible();
      await expect(input).toHaveCount(0);
      await page.getByRole("button", { name: "Back to chat" }).click();
      await expect(input).toHaveText("Keep this draft");
      expect(page.url()).toBe(url);
    } finally {
      await model.close();
    }
  });
}

test("voice submissions retain a Claude Code runtime instead of falling back to Decopilot", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const api = page.context().request;
  const model = await startModel();
  const db = await connectDevDb();
  try {
    await configureModel(api, orgSlug, model.url);
    await setVoiceFlag(api, orgSlug, true);
    const { threadId, agentId } = await createThread(api, orgSlug);
    await db.query(
      "UPDATE threads SET harness_id = 'claude-code', message_storage_version = 2 WHERE id = $1",
      [threadId],
    );
    const response = await api.post(
      `/api/${orgSlug}/decopilot/threads/${threadId}/messages`,
      {
        data: {
          voiceMode: true,
          agent: { id: agentId },
          messages: [
            {
              id: crypto.randomUUID(),
              role: "user",
              parts: [{ type: "text", text: "Change the homepage title" }],
            },
          ],
        },
      },
    );
    expect(response.status()).toBe(202);
    // This provider is deliberately incompatible with Claude Code. A fallback
    // would call the stand-in and succeed, hiding the lost sandbox session.
    await expect
      .poll(
        async () => {
          const parts = await db.query(
            "SELECT payload FROM thread_message_parts WHERE thread_id = $1",
            [threadId],
          );
          return JSON.stringify(parts.rows);
        },
        { timeout: 30_000 },
      )
      .toContain("openai-compatible");
    const row = await db.query("SELECT harness_id FROM threads WHERE id = $1", [
      threadId,
    ]);
    expect(row.rows).toEqual([{ harness_id: "claude-code" }]);
    expect(model.prompts).toEqual([]);
  } finally {
    await db.end();
    await model.close();
  }
});

async function configureModel(
  api: APIRequestContext,
  org: string,
  url: string,
) {
  const key = await callSelfMcpTool<{ id: string }>(
    api,
    org,
    "AI_PROVIDER_KEY_CREATE",
    {
      providerId: "openai-compatible",
      label: "Synthetic voice model",
      apiKey: JSON.stringify({ baseUrl: url, apiKey: "synthetic-model-key" }),
    },
  );
  const { id } = await callSelfMcpTool<{ id: string }>(
    api,
    org,
    "ORGANIZATION_GET",
    {},
  );
  await callSelfMcpTool(api, org, "ORGANIZATION_SETTINGS_UPDATE", {
    organizationId: id,
    simple_mode: {
      tiers: {
        fast: null,
        smart: { keyId: key.id, modelId: "voice-test" },
        thinking: null,
        image: null,
        web_search: null,
        deep_research: null,
      },
    },
  });
}

async function startModel(delayMs = 0) {
  const prompts: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ data: [{ id: "voice-test", owned_by: "test" }] }),
      );
      return;
    }
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as {
      stream?: boolean;
      messages?: unknown;
    };
    prompts.push(JSON.stringify(payload.messages));
    const text = "Mensagem de voz recebida.";
    if (payload.stream) {
      const delay = JSON.stringify(payload.messages).includes(
        "This turn is a spoken conversation",
      )
        ? delayMs
        : 0;
      if (delay) delayMs = 0;
      if (delay > 0) await sleep(delay);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: "completion-example", object: "chat.completion.chunk", created: 1, model: "voice-test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.write(event({ role: "assistant", content: text }, null));
      response.end(event({}, "stop") + "data: [DONE]\n\n");
    } else {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "completion-example",
          object: "chat.completion",
          created: 1,
          model: "voice-test",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: text },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing model port");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    prompts,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

test.describe("ElevenLabs live voice", () => {
  test.skip(
    process.env.E2E_VOICE_LIVE !== "1" || !process.env.E2E_VOICE_WAV,
    "Requires a configured ElevenLabs API server and a synthetic WAV input",
  );
  test("a spoken turn uses the current agent and returns to text in the same chat", async ({
    authedPage,
  }) => {
    test.setTimeout(180_000);
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const model = await startModel(
      Number(process.env.E2E_VOICE_MODEL_DELAY_MS ?? 0),
    );
    try {
      await configureModel(api, orgSlug, model.url);
      await setVoiceFlag(api, orgSlug, true);
      const { threadId, agentId } = await createThread(api, orgSlug);
      await page.goto(
        `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&sidepanel=true`,
      );
      const turn = page.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          request.url().endsWith(`/threads/${threadId}/messages`),
        { timeout: 90_000 },
      );
      const bootstrap = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`/threads/${threadId}/voice/sessions`),
      );
      await page
        .getByRole("button", { name: "Start voice mode" })
        .click({ timeout: 60_000 });
      await expect(
        page.getByRole("region", { name: "Voice conversation" }),
      ).toBeVisible();
      const bootstrapped = await bootstrap;
      expect(bootstrapped.status()).toBe(200);
      const { token } = await bootstrapped.json();
      const sessionPath = `/api/${orgSlug}/threads/${threadId}/voice/sessions`;
      expect((await api.post(sessionPath)).status()).toBe(409);
      for (const text of ["", " ", "x".repeat(12_001)]) {
        expect(
          (
            await api.post(`${sessionPath}/speech`, { data: { token, text } })
          ).status(),
        ).toBe(400);
      }
      expect(
        (
          await api.post(`${sessionPath}/speech`, {
            data: { token: "invalid", text: "Hello" },
          })
        ).status(),
      ).toBe(403);
      const other = await createThread(api, orgSlug);
      expect(
        (
          await api.post(
            `/api/${orgSlug}/threads/${other.threadId}/voice/sessions/speech`,
            {
              data: { token, text: "Hello" },
            },
          )
        ).status(),
      ).toBe(403);
      const submitted = await turn;
      expect(submitted.postDataJSON()).toMatchObject({
        voiceMode: true,
        agent: { id: agentId },
      });
      await expect
        .poll(
          () =>
            model.prompts.some((prompt) =>
              prompt.includes("This turn is a spoken conversation"),
            ),
          { timeout: 60_000 },
        )
        .toBe(true);
      await expect(
        page.locator('.studio-voice-orb[data-phase="speaking"]'),
      ).toBeVisible({
        timeout: 60_000 + Number(process.env.E2E_VOICE_MODEL_DELAY_MS ?? 0),
      });
      if (process.env.E2E_VOICE_SCREENSHOT)
        await page.screenshot({ path: process.env.E2E_VOICE_SCREENSHOT });
      await page.getByRole("button", { name: "Mute microphone" }).click();
      await expect(
        page.getByRole("button", { name: "Unmute microphone" }),
      ).toHaveAttribute("aria-pressed", "true");
      const stopped = page.waitForResponse(
        (response) =>
          response.request().method() === "DELETE" &&
          response.url().endsWith(`/threads/${threadId}/voice/sessions`),
      );
      await page.getByRole("button", { name: "Back to chat" }).click();
      expect((await stopped).status()).toBe(204);
      expect(
        (
          await api.post(`${sessionPath}/speech`, {
            data: { token, text: "Hello" },
          })
        ).status(),
      ).toBe(403);
      await expect(page.locator('[data-chat-input="true"]')).toBeVisible();
      await expect(
        page.getByText("Mensagem de voz recebida.", { exact: true }).last(),
      ).toBeVisible();
      const replyCount = await page
        .getByText("Mensagem de voz recebida.", { exact: true })
        .count();
      const nextTurn = page.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          request.url().endsWith(`/threads/${threadId}/messages`),
      );
      await page.locator('[data-chat-input="true"]').fill("Continue in text");
      await page.locator('[data-chat-input="true"]').press("Enter");
      expect((await nextTurn).postDataJSON().voiceMode).toBe(false);
      await expect(
        page.getByText("Mensagem de voz recebida.", { exact: true }),
      ).toHaveCount(replyCount + 1, { timeout: 30_000 });
    } finally {
      await model.close();
    }
  });
});
