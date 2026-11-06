import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import {
  CODEX_DEFAULT_MODEL,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
} from "@decocms/shared/harness/codex-models";
import { AIProviderFactory } from "../../ai-providers/factory";
import { InMemoryModelListCache } from "../../ai-providers/model-list-cache";
import { TierUnavailableError } from "../../core/resolve-tier";
import type { StudioContext } from "../../core/studio-context";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
} from "../../database/test-db-pg";
import { CredentialVault } from "../../encryption/credential-vault";
import {
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  claudeSubscriptionChatModel,
  GITHUB_COPILOT_PROVIDER_ID,
} from "../../harnesses/claude-code-env";
import { AIProviderKeyStorage } from "../../storage/ai-provider-keys";
import { ClaudeSubscriptionStorage } from "../../storage/claude-subscriptions";
import { CodexSubscriptionStorage } from "../../storage/codex-subscriptions";
import { OrgSharedPlanStorage } from "../../storage/org-shared-plans";
import { OrganizationSettingsStorage } from "../../storage/organization-settings";
import { resolveTaskRunModel } from "./task-run-harness";

describe("task run model (real Postgres)", () => {
  let database: StudioDatabase;
  const vault = new CredentialVault(CredentialVault.generateKey());

  beforeAll(async () => {
    database = await connectTestPgDatabase();
  });

  afterAll(async () => {
    if (database) await closeTestPgDatabase(database);
  });

  /** A fresh org with two members and the storage a task run resolves from. */
  async function org() {
    const id = `org_${crypto.randomUUID()}`;
    const dispatcher = `user_${crypto.randomUUID()}`;
    const teammate = `user_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES (${id}, ${id}, ${id}, ${now})
    `.execute(database.db);
    for (const userId of [dispatcher, teammate]) {
      await sql`
        INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
        VALUES (${userId}, ${`${userId}@example.com`}, false, ${userId}, ${now}, ${now})
      `.execute(database.db);
      await sql`
        INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
        VALUES (${crypto.randomUUID()}, ${userId}, ${id}, 'member', ${now})
      `.execute(database.db);
    }
    const aiProviderKeys = new AIProviderKeyStorage(database.db, vault);
    const modelLists = new InMemoryModelListCache();
    const storage = {
      organizationSettings: new OrganizationSettingsStorage(database.db),
      aiProviderKeys,
      orgSharedPlans: new OrgSharedPlanStorage(database.db),
      claudeSubscriptions: new ClaudeSubscriptionStorage(database.db, vault),
      githubCopilotSubscriptions: new ClaudeSubscriptionStorage(
        database.db,
        vault,
        "github_copilot_subscriptions",
      ),
      codexSubscriptions: new CodexSubscriptionStorage(database.db, vault),
    };
    // The org's context, as the Implementer runs with: no request user.
    const ctx = {
      organization: { id },
      auth: {},
      storage,
      aiProviders: new AIProviderFactory(aiProviderKeys, modelLists),
    } as unknown as StudioContext;
    return { id, dispatcher, teammate, storage, modelLists, ctx };
  }

  test("a subscription-only org runs on the dispatcher's Claude plan", async () => {
    const o = await org();
    await o.storage.claudeSubscriptions.upsert({
      userId: o.dispatcher,
      accessToken: "sk-ant-oat-example",
    });

    const model = await resolveTaskRunModel(
      o.ctx,
      o.id,
      o.dispatcher,
      "claude-code",
    );

    const plan = claudeSubscriptionChatModel(CLAUDE_SUBSCRIPTION_PROVIDER_ID);
    expect(model.credentialId).toBe(CLAUDE_SUBSCRIPTION_PROVIDER_ID);
    expect(model.modelId).toBe(plan.thinking.id);
  });

  test("a Copilot plan, the dispatcher's own or one shared with the org, counts too", async () => {
    const own = await org();
    await own.storage.githubCopilotSubscriptions.upsert({
      userId: own.dispatcher,
      accessToken: "github_pat_example",
    });
    expect(
      (
        await resolveTaskRunModel(
          own.ctx,
          own.id,
          own.dispatcher,
          "claude-code",
        )
      ).credentialId,
    ).toBe(GITHUB_COPILOT_PROVIDER_ID);

    const shared = await org();
    await shared.storage.githubCopilotSubscriptions.upsert({
      userId: shared.teammate,
      accessToken: "github_pat_shared_example",
    });
    await shared.storage.orgSharedPlans.share(
      shared.id,
      GITHUB_COPILOT_PROVIDER_ID,
      shared.teammate,
    );
    expect(
      (
        await resolveTaskRunModel(
          shared.ctx,
          shared.id,
          shared.dispatcher,
          "claude-code",
        )
      ).credentialId,
    ).toBe(GITHUB_COPILOT_PROVIDER_ID);
  });

  test("an org model key still wins over the dispatcher's plan", async () => {
    const o = await org();
    const key = await o.storage.aiProviderKeys.create({
      providerId: "anthropic",
      label: "Org key",
      apiKey: "sk-ant-api-example",
      organizationId: o.id,
      createdBy: o.dispatcher,
    });
    await o.modelLists.set(o.id, "anthropic", [
      {
        modelId: "claude-sonnet-5-5",
        title: "Claude Sonnet 5.5",
        providerId: "anthropic",
        capabilities: ["text"],
        description: null,
        limits: null,
        costs: null,
      },
    ]);
    await o.storage.organizationSettings.upsert(o.id, {
      simple_mode: {
        tiers: {
          fast: null,
          smart: { keyId: key.id, modelId: "claude-sonnet-5-5" },
          thinking: null,
          image: null,
          web_search: null,
          deep_research: null,
        },
      },
    });
    await o.storage.claudeSubscriptions.upsert({
      userId: o.dispatcher,
      accessToken: "sk-ant-oat-example",
    });

    const model = await resolveTaskRunModel(
      o.ctx,
      o.id,
      o.dispatcher,
      "claude-code",
    );

    expect(model.credentialId).toBe(key.id);
    expect(model.modelId).toBe("claude-sonnet-5-5");
  });

  test("no plan and no provider still refuses with the tier error", async () => {
    const o = await org();
    // Only a plan the run would not bill: a teammate's own, unshared.
    await o.storage.claudeSubscriptions.upsert({
      userId: o.teammate,
      accessToken: "sk-ant-oat-teammate",
    });
    // And the dispatcher's, expired.
    await o.storage.claudeSubscriptions.upsert({
      userId: o.dispatcher,
      accessToken: "sk-ant-oat-expired",
      expiresAt: new Date(Date.now() - 60_000),
    });

    const refused = resolveTaskRunModel(
      o.ctx,
      o.id,
      o.dispatcher,
      "claude-code",
    );

    await expect(refused).rejects.toBeInstanceOf(TierUnavailableError);
    await expect(refused).rejects.toMatchObject({ tier: "smart" });
  });

  test("Codex runs keep their own plan and never take a Claude plan", async () => {
    const o = await org();
    await o.storage.organizationSettings.upsert(o.id, {
      flags: { task_board_codex: true },
    });
    await o.storage.claudeSubscriptions.upsert({
      userId: o.dispatcher,
      accessToken: "sk-ant-oat-example",
    });

    await expect(
      resolveTaskRunModel(o.ctx, o.id, o.dispatcher, "codex"),
    ).rejects.toBeInstanceOf(TierUnavailableError);

    await o.storage.codexSubscriptions.upsert(
      o.dispatcher,
      JSON.stringify({ tokens: { access_token: "access_example" } }),
    );
    const model = await resolveTaskRunModel(o.ctx, o.id, o.dispatcher, "codex");
    expect(model.credentialId).toBe(CODEX_SUBSCRIPTION_PROVIDER_ID);
    expect(model.modelId).toBe(CODEX_DEFAULT_MODEL);
  });
});
