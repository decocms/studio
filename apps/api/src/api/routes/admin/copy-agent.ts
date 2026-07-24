/**
 * Copy an agent (Virtual MCP) from one organization to another, credentials
 * included — a deployment-admin operation.
 *
 * The motivating case: an agent was built and tuned in one org (usually deco's
 * own) and needs to exist, working, in a customer's org. Doing that by hand
 * means re-creating every connection, re-doing every OAuth dance, and
 * re-typing the system prompt — with no way to tell whether the result
 * actually matches.
 *
 * What travels:
 *  - the agent row: title, description, icon, system prompt (`metadata.instructions`)
 *    and the rest of its metadata, rewritten for the target org (see
 *    ./remap-agent-metadata)
 *  - every connection it aggregates, WITH its credentials — access token, OAuth
 *    config, configuration state, STDIO env vars. Storage decrypts on read and
 *    re-encrypts on write, so the plaintext only exists in memory here.
 *  - the vault secrets its sandbox env bag references
 *  - its kickstart prompts (org-fs) and per-plugin configs
 *
 * What does not, and why it is REPORTED rather than silently dropped: nested
 * agents, knowledge files, and everything listed in `DROPPED_KEYS`. The caller
 * surfaces `skipped` to the operator so a partial copy is never mistaken for a
 * complete one.
 *
 * Not transactional: connections and secrets are separate writes and a failure
 * midway leaves them behind as orphans in the target org. Deliberate — an admin
 * can delete them, and the alternative (threading one Kysely transaction
 * through five storage classes and two object stores) buys little for a
 * hand-triggered operation.
 */

import {
  isStudioPackAgent,
  WellKnownOrgMCPId,
  VirtualMCPCreateDataSchema,
} from "@decocms/shared/sdk";
import { sql } from "kysely";
import type { StudioContext } from "@/core/studio-context";
import type { ConnectionEntity } from "@/tools/connection/schema";
import { buildOrgFs } from "@/file-storage/build-org-fs";
import {
  readAgentPrompts,
  writeAgentPrompts,
} from "@/file-storage/agent-prompts";
import { remapAgentMetadata, type RemapTargets } from "./remap-agent-metadata";

/**
 * Connections every org gets on bootstrap, whose id embeds the org id. These
 * are remapped to the target org's own instance instead of copied — copying
 * would give the target a second, stale pointer at the SOURCE org's management
 * surface (and `<org>_self` in particular is that org's full admin API).
 */
const WELL_KNOWN_CONNECTION_MINTERS = [
  WellKnownOrgMCPId.SELF,
  WellKnownOrgMCPId.REGISTRY,
  WellKnownOrgMCPId.COMMUNITY_REGISTRY,
  WellKnownOrgMCPId.DEV_ASSETS,
  WellKnownOrgMCPId.SITE_DIAGNOSTICS,
  WellKnownOrgMCPId.COMMERCE_DISCOVERY,
];

function remapWellKnownConnection(
  id: string,
  sourceOrgId: string,
  targetOrgId: string,
): string | null {
  for (const mint of WELL_KNOWN_CONNECTION_MINTERS) {
    if (id === mint(sourceOrgId)) return mint(targetOrgId);
  }
  return null;
}

export class CopyAgentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
    this.name = "CopyAgentError";
  }
}

export interface CopyAgentInput {
  agentId: string;
  targetOrgId: string;
  /** Deployment admin performing the copy; recorded as creator in the target org. */
  actorUserId: string;
}

export interface CopyAgentResult {
  agentId: string;
  title: string;
  sourceOrgId: string;
  targetOrgId: string;
  /** Connections newly created in the target org. */
  copiedConnections: { sourceId: string; targetId: string; title: string }[];
  /** Well-known connections pointed at the target org's own instance. */
  remappedConnections: { sourceId: string; targetId: string }[];
  copiedSecrets: number;
  copiedPrompts: number;
  /** Everything that could not travel. Show this to the operator. */
  skipped: string[];
}

export async function copyAgentToOrg(
  ctx: StudioContext,
  input: CopyAgentInput,
): Promise<CopyAgentResult> {
  const { agentId, targetOrgId, actorUserId } = input;
  const skipped: string[] = [];

  const agent = await ctx.storage.virtualMcps.findById(agentId);
  if (!agent) {
    throw new CopyAgentError(`Agent ${agentId} not found`, 404);
  }
  const sourceOrgId = agent.organization_id;

  if (sourceOrgId === targetOrgId) {
    throw new CopyAgentError(
      "Source and target organization are the same",
      400,
    );
  }
  // Studio Pack agents are provisioned per-org by the platform and their ids
  // embed the org id; every org already has its own.
  if (isStudioPackAgent(agent.id)) {
    throw new CopyAgentError(
      "Studio Pack agents are system-managed — every org already has its own",
      400,
    );
  }

  const targetOrg = await ctx.db
    .selectFrom("organization")
    .select("id")
    .where("id", "=", targetOrgId)
    .executeTakeFirst();
  if (!targetOrg) {
    throw new CopyAgentError(`Organization ${targetOrgId} not found`, 404);
  }

  // ---- Connections -------------------------------------------------------
  const connectionMap = new Map<string, string>();
  const copiedConnections: CopyAgentResult["copiedConnections"] = [];
  const remappedConnections: CopyAgentResult["remappedConnections"] = [];

  for (const ref of agent.connections) {
    const sourceId = ref.connection_id;

    const wellKnown = remapWellKnownConnection(
      sourceId,
      sourceOrgId,
      targetOrgId,
    );
    if (wellKnown) {
      const exists = await ctx.storage.connections.findById(wellKnown);
      if (!exists) {
        skipped.push(
          `Built-in connection "${sourceId}" has no counterpart in the target org (expected "${wellKnown}") — the copy will not see its tools.`,
        );
        continue;
      }
      connectionMap.set(sourceId, wellKnown);
      remappedConnections.push({ sourceId, targetId: wellKnown });
      continue;
    }

    const source = await ctx.storage.connections.findById(sourceId);
    if (!source || source.organization_id !== sourceOrgId) {
      skipped.push(
        `Connection "${sourceId}" was skipped — it no longer exists in the source org.`,
      );
      continue;
    }
    if (source.connection_type === "VIRTUAL") {
      skipped.push(
        `Connection "${source.title}" is another agent — nested agents are not copied. Copy it separately and add it to this one.`,
      );
      continue;
    }

    const created = await copyConnection(
      ctx,
      source,
      targetOrgId,
      actorUserId,
      skipped,
    );
    connectionMap.set(sourceId, created.id);
    copiedConnections.push({
      sourceId,
      targetId: created.id,
      title: created.title,
    });
  }

  // ---- Secrets referenced by the sandbox runtime config -------------------
  const secretMap = new Map<string, string>();
  for (const secretId of collectSecretIds(agent.metadata)) {
    const targetId = await copySecret(
      ctx,
      secretId,
      sourceOrgId,
      targetOrgId,
      actorUserId,
      skipped,
    );
    if (targetId) secretMap.set(secretId, targetId);
  }

  // ---- Metadata ----------------------------------------------------------
  const targets: RemapTargets = {
    connections: connectionMap,
    secrets: secretMap,
  };
  const remapped = remapAgentMetadata(agent.metadata, targets);
  skipped.push(...remapped.skipped);

  if (agent.pinned) {
    skipped.push(
      "The copy is not pinned to the target org's sidebar — pinning is an org-admin choice.",
    );
  }

  // Parse instead of casting: this is the boundary where source-org JSON
  // becomes a write into another org, and a schema violation should fail loudly
  // here rather than land a malformed row.
  const createData = VirtualMCPCreateDataSchema.parse({
    title: agent.title,
    description: agent.description,
    icon: agent.icon,
    status: agent.status,
    pinned: false,
    metadata: remapped.metadata,
    connections: agent.connections
      .filter((ref) => connectionMap.has(ref.connection_id))
      .map((ref) => ({
        connection_id: connectionMap.get(ref.connection_id)!,
        selected_tools: ref.selected_tools,
        selected_resources: ref.selected_resources,
        selected_prompts: ref.selected_prompts,
      })),
  });

  const copy = await ctx.storage.virtualMcps.create(
    targetOrgId,
    actorUserId,
    createData,
  );

  // ---- Kickstart prompts (org-fs, not on the row) -------------------------
  const copiedPrompts = await copyPrompts(
    ctx,
    { sourceOrgId, targetOrgId },
    agent.id,
    copy.id,
    actorUserId,
    skipped,
  );

  // ---- Per-plugin configuration ------------------------------------------
  await copyPluginConfigs(ctx, agent.id, copy.id, connectionMap, skipped);

  return {
    agentId: copy.id,
    title: copy.title,
    sourceOrgId,
    targetOrgId,
    copiedConnections,
    remappedConnections,
    copiedSecrets: secretMap.size,
    copiedPrompts,
    skipped,
  };
}

/**
 * Recreate a connection under the target org with a fresh id.
 *
 * `findById` already decrypted the credentials and `createNew` re-encrypts
 * them, so passing the entity through copies the secrets without this module
 * ever touching the vault. `id` is omitted so a new one is minted — reusing the
 * source id would make the two orgs' rows collide on the shared primary key.
 */
async function copyConnection(
  ctx: StudioContext,
  source: ConnectionEntity,
  targetOrgId: string,
  actorUserId: string,
  skipped: string[],
): Promise<ConnectionEntity> {
  const { id: _id, created_at: _c, updated_at: _u, ...rest } = source;

  if (source.connection_type === "STDIO") {
    skipped.push(
      `Connection "${source.title}" is a local STDIO server — its command must be runnable wherever the target org's sandboxes run.`,
    );
  }

  return ctx.storage.connections.createNew({
    ...rest,
    organization_id: targetOrgId,
    created_by: actorUserId,
    updated_by: undefined,
  });
}

/** Every vault secret id the agent's runtime config depends on. */
function collectSecretIds(metadata: unknown): string[] {
  const ids = new Set<string>();
  if (typeof metadata !== "object" || metadata === null) return [];
  const runtime = (metadata as { runtime?: unknown }).runtime;
  if (typeof runtime !== "object" || runtime === null) return [];

  const lists = [
    (runtime as { env?: unknown }).env,
    (runtime as { submoduleCredentials?: unknown }).submoduleCredentials,
  ];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) continue;
      const secretId = (entry as { secretId?: unknown }).secretId;
      if (typeof secretId === "string" && secretId) ids.add(secretId);
    }
  }
  return [...ids];
}

/**
 * Copy one vault secret into the target org, or reuse the target's existing
 * secret of the same name.
 *
 * Reading the row directly bypasses `SecretStorage`'s per-caller visibility
 * check, which would reject a user-scoped secret owned by someone other than
 * the admin running the copy. That is the intended privilege of this surface —
 * it also grants org membership and impersonates users — but it means a
 * user-scoped secret becomes ORG-scoped in the target (the admin is typically
 * not a member there, so a user-scoped copy would be invisible to the people
 * who need it, and the agent would not boot). Reported, never silent.
 *
 * An existing same-name secret in the target is reused rather than
 * overwritten: `secrets` is uniquely indexed on (org, lower(name)) for org
 * scope, and clobbering a customer's live credential to make a copy tidy is
 * not a trade worth making.
 */
async function copySecret(
  ctx: StudioContext,
  secretId: string,
  sourceOrgId: string,
  targetOrgId: string,
  actorUserId: string,
  skipped: string[],
): Promise<string | null> {
  const row = await ctx.db
    .selectFrom("secrets")
    .selectAll()
    .where("id", "=", secretId)
    .where("organization_id", "=", sourceOrgId)
    .executeTakeFirst();

  if (!row) {
    skipped.push(
      `Secret "${secretId}" was skipped — it no longer exists in the source org.`,
    );
    return null;
  }

  const existing = await ctx.db
    .selectFrom("secrets")
    .select(["id"])
    .where("organization_id", "=", targetOrgId)
    .where("scope", "=", "organization")
    .where(sql<boolean>`lower(name) = lower(${row.name})`)
    .executeTakeFirst();

  if (existing) {
    skipped.push(
      `Secret "${row.name}" already exists in the target org — the copy reuses it instead of overwriting its value.`,
    );
    return existing.id;
  }

  if (row.scope === "user") {
    skipped.push(
      `Secret "${row.name}" was personal to one user in the source org and is now shared with the whole target org.`,
    );
  }

  try {
    const value = await ctx.vault.decrypt(row.encrypted_value);
    const created = await ctx.storage.secrets.create({
      organizationId: targetOrgId,
      scope: { kind: "organization" },
      name: row.name,
      value,
      description: row.description,
      createdBy: actorUserId,
    });
    return created.id;
  } catch (error) {
    skipped.push(
      `Secret "${row.name}" could not be copied: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * Copy the agent's kickstart prompts between the two orgs' filesystems. The
 * stored local `name` is intentionally dropped — `writeAgentPrompts` derives it
 * from the title and index, so the copy gets names consistent with its own set.
 */
async function copyPrompts(
  ctx: StudioContext,
  orgs: { sourceOrgId: string; targetOrgId: string },
  sourceAgentId: string,
  targetAgentId: string,
  actorUserId: string,
  skipped: string[],
): Promise<number> {
  try {
    const stored = await readAgentPrompts(
      buildOrgFs(ctx, orgs.sourceOrgId),
      sourceAgentId,
    );
    if (stored.length === 0) return 0;

    await writeAgentPrompts(
      buildOrgFs(ctx, orgs.targetOrgId),
      targetAgentId,
      actorUserId,
      stored.map(({ title, description, text }) => ({
        title,
        description,
        text,
      })),
    );
    return stored.length;
  } catch (error) {
    skipped.push(
      `Kickstart prompts were not copied: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  }
}

/** Per-plugin settings, with any bound connection pointed at its copy. */
async function copyPluginConfigs(
  ctx: StudioContext,
  sourceAgentId: string,
  targetAgentId: string,
  connectionMap: Map<string, string>,
  skipped: string[],
): Promise<void> {
  const configs = await ctx.storage.virtualMcpPluginConfigs.list(sourceAgentId);

  for (const config of configs) {
    let connectionId = config.connectionId;
    if (connectionId) {
      const mapped = connectionMap.get(connectionId);
      if (!mapped) {
        skipped.push(
          `Plugin "${config.pluginId}" lost its bound connection — "${connectionId}" was not copied.`,
        );
      }
      connectionId = mapped ?? null;
    }
    await ctx.storage.virtualMcpPluginConfigs.upsert(
      targetAgentId,
      config.pluginId,
      { connectionId, settings: config.settings },
    );
  }
}
