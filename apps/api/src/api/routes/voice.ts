import { Hono, type Context } from "hono";
import { VoiceSpeechSchema } from "@decocms/shared/voice";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { assertAiBudget, orgHasFeature } from "@/core/plan-feature-gate";
import type { VoiceSessions } from "@/voice/sessions";
import type { StudioContext } from "@/core/studio-context";
import { validateThreadOwnership } from "./decopilot/helpers";
import { assertHostedHarness } from "./decopilot/routes";

export function createVoiceRoutes(sessions: VoiceSessions) {
  const app = new Hono<{ Variables: { studioContext: StudioContext } }>();
  async function authorize(
    c: Context<{ Variables: { studioContext: StudioContext } }>,
  ) {
    const { ctx, organization, thread, taskId, userId } =
      await validateThreadOwnership(c);
    if (thread.metadata?.read_only)
      throw new HTTPException(409, { message: "Thread is read only" });
    assertHostedHarness(thread.harness_id);
    const settings = await ctx.storage.organizationSettings.get(
      organization.id,
    );
    if (!orgFlagEnabled(settings?.flags, "voice_mode"))
      throw new HTTPException(403, { message: "Voice mode is disabled" });
    if (!(await orgHasFeature(ctx, organization.id, "chat")))
      throw new HTTPException(403, {
        message: "Chat is not available on this plan",
      });
    await assertAiBudget(ctx, organization.id, "Chat");
    c.header("Cache-Control", "no-store");
    return { organizationId: organization.id, userId, threadId: taskId };
  }
  app.post("/threads/:threadId/voice/sessions", async (c) => {
    return c.json(await sessions.create(await authorize(c)));
  });
  app.post("/threads/:threadId/voice/sessions/speech", async (c) => {
    const scope = await authorize(c);
    const body = VoiceSpeechSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success)
      throw new HTTPException(400, { message: "Invalid speech request" });
    const response = await sessions.speak(
      scope,
      body.data.token,
      body.data.text,
      c.req.raw.signal,
    );
    return new Response(response.body, {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  });
  app.delete("/threads/:threadId/voice/sessions", async (c) => {
    const { organization, taskId, userId } = await validateThreadOwnership(c);
    const body = z
      .object({ token: z.string().max(4096) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      throw new HTTPException(400, { message: "Invalid voice session token" });
    await sessions.revoke(
      { organizationId: organization.id, userId, threadId: taskId },
      body.data.token,
    );
    return c.body(null, 204);
  });
  return app;
}
