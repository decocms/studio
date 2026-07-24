/**
 * Rewrite an agent's `metadata` for a different organization.
 *
 * An agent's metadata is full of ids that only mean something inside its own
 * org: connection ids on pinned views / home tiles / layout tabs, vault secret
 * ids on the sandbox env bag, sandbox handles, a linked site's storage
 * tenancy. Copying the JSON verbatim into another org produces an agent that
 * looks configured and is quietly broken — every one of those ids resolves to
 * nothing (or, worse, to an unrelated row that happens to share the id).
 *
 * So this module does two things, and reports both:
 *  - REMAP what has a counterpart in the target org (the connections and
 *    secrets the copy just created).
 *  - DROP what cannot travel at all, plus any single entry whose id had no
 *    counterpart.
 *
 * Everything dropped comes back in `skipped` and is surfaced to the operator.
 * The whole point of a copy tool is fidelity, so silence here would be the
 * bug: unknown metadata keys pass through untouched (`metadata` is a `.loose()`
 * schema and new fields get added to it regularly), and the ones we know are
 * org-bound are named explicitly below.
 *
 * Pure: no DB, no ctx. The caller creates the connections/secrets first and
 * passes the resulting id maps in.
 */

/** Maps built by the copy before metadata is rewritten. */
export interface RemapTargets {
  /** source connection id -> target connection id. Missing = cannot travel. */
  connections: Map<string, string>;
  /** source secret id -> target secret id. Missing = cannot travel. */
  secrets: Map<string, string>;
}

/**
 * Metadata keys that are meaningless outside their own org, with the reason
 * shown to the operator. Dropped wholesale — there is nothing to remap them to.
 */
const DROPPED_KEYS: Record<string, string> = {
  sandboxMap:
    "sandbox handles and preview URLs belong to the source org's running sandboxes",
  liveAgentId: "the dev/live agent pair only exists in the source org",
  siteSlug: "the linked site's storage tenancy belongs to the source org",
  productionUrl: "the production URL belongs to the source org's site",
  knowledge:
    "knowledge files live in the source org's Library (files are not copied)",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drop `key` from `obj` only if present, so we never invent explicit nulls. */
function omit(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  if (!(key in obj)) return obj;
  const { [key]: _dropped, ...rest } = obj;
  return rest;
}

export interface RemapResult {
  metadata: Record<string, unknown>;
  /** Human-readable lines describing everything dropped. */
  skipped: string[];
}

export function remapAgentMetadata(
  source: Record<string, unknown> | null | undefined,
  targets: RemapTargets,
): RemapResult {
  const skipped: string[] = [];
  if (!source) return { metadata: {}, skipped };

  let metadata: Record<string, unknown> = { ...source };

  for (const [key, reason] of Object.entries(DROPPED_KEYS)) {
    if (key in metadata && metadata[key] != null) {
      skipped.push(`metadata.${key} dropped — ${reason}.`);
    }
    metadata = omit(metadata, key);
  }

  if (Array.isArray(metadata.subAgents)) {
    metadata.subAgents = remapSubAgents(metadata.subAgents, targets, skipped);
  }
  if (isRecord(metadata.githubRepo)) {
    metadata.githubRepo = remapGithubRepo(
      metadata.githubRepo,
      targets,
      skipped,
    );
  }
  if (isRecord(metadata.runtime)) {
    metadata.runtime = remapRuntime(metadata.runtime, targets, skipped);
  }
  if (isRecord(metadata.ui)) {
    metadata.ui = remapUi(metadata.ui, targets, skipped);
  }

  return { metadata, skipped };
}

/**
 * A delegation allowlist mixing agent ids and connection ids. Only the copied
 * connections have a counterpart; source-org agents do not.
 *
 * An empty result is preserved rather than deleted: `[]` means "itself only"
 * and `null`/absent means "every active target in the org", so deleting the
 * field to be helpful would silently WIDEN what the copy may delegate to. A
 * broken-and-reported allowlist is the safer failure.
 */
function remapSubAgents(
  subAgents: unknown[],
  targets: RemapTargets,
  skipped: string[],
): string[] {
  const out: string[] = [];
  for (const entry of subAgents) {
    if (typeof entry !== "string") continue;
    const mapped = targets.connections.get(entry);
    if (mapped) {
      out.push(mapped);
    } else {
      skipped.push(
        `metadata.subAgents entry "${entry}" dropped — no counterpart in the target org.`,
      );
    }
  }
  if (out.length === 0 && subAgents.length > 0) {
    skipped.push(
      "metadata.subAgents is now empty, so the copy may only delegate to itself — re-pick its subagents in the target org.",
    );
  }
  return out;
}

/**
 * The GitHub App credentials for a repo. `connectionId` names the mcp-github
 * connection that holds the token and `installationId` the App install it came
 * from; without the connection the install id can't authenticate anything, so
 * both go and the repo falls back to public-clone mode.
 */
function remapGithubRepo(
  repo: Record<string, unknown>,
  targets: RemapTargets,
  skipped: string[],
): Record<string, unknown> {
  const sourceId = repo.connectionId;
  if (typeof sourceId !== "string") return repo;

  const mapped = targets.connections.get(sourceId);
  if (mapped) return { ...repo, connectionId: mapped };

  skipped.push(
    `metadata.githubRepo credentials dropped (connection "${sourceId}" was not copied) — the repo stays linked in public-clone mode.`,
  );
  return omit(omit(repo, "connectionId"), "installationId");
}

/** Sandbox runtime config: the secret-backed entries need the new vault ids. */
function remapRuntime(
  runtime: Record<string, unknown>,
  targets: RemapTargets,
  skipped: string[],
): Record<string, unknown> {
  const out = { ...runtime };

  if (Array.isArray(out.env)) {
    out.env = out.env.flatMap((entry) => {
      if (!isRecord(entry) || entry.kind !== "secret") return [entry];
      const sourceId = entry.secretId;
      if (typeof sourceId !== "string") return [entry];
      const mapped = targets.secrets.get(sourceId);
      if (mapped) return [{ ...entry, secretId: mapped }];
      skipped.push(
        `metadata.runtime.env "${String(entry.key)}" dropped — its secret could not be copied.`,
      );
      return [];
    });
  }

  if (Array.isArray(out.submoduleCredentials)) {
    out.submoduleCredentials = out.submoduleCredentials.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const sourceId = entry.secretId;
      if (typeof sourceId !== "string") return [entry];
      const mapped = targets.secrets.get(sourceId);
      if (mapped) return [{ ...entry, secretId: mapped }];
      skipped.push(
        `metadata.runtime.submoduleCredentials for "${String(entry.host)}" dropped — its secret could not be copied.`,
      );
      return [];
    });
  }

  return out;
}

/** UI customization: pinned views, home tiles and layout tabs are all keyed by connection. */
function remapUi(
  ui: Record<string, unknown>,
  targets: RemapTargets,
  skipped: string[],
): Record<string, unknown> {
  const out = { ...ui };

  if (Array.isArray(out.pinnedViews)) {
    out.pinnedViews = out.pinnedViews.flatMap((view) => {
      if (!isRecord(view)) return [];
      const sourceId = view.connectionId;
      if (typeof sourceId !== "string") return [];
      const mapped = targets.connections.get(sourceId);
      if (mapped) return [{ ...view, connectionId: mapped }];
      skipped.push(
        `metadata.ui.pinnedViews entry "${String(view.label ?? view.toolName)}" dropped — connection "${sourceId}" was not copied.`,
      );
      return [];
    });
  }

  // Legacy single slot and the current array are both honored by the home board.
  if (isRecord(out.homeTile)) {
    out.homeTile = remapHomeTile(out.homeTile, targets, skipped);
  }
  if (Array.isArray(out.homeTiles)) {
    out.homeTiles = out.homeTiles.flatMap((tile) => {
      if (!isRecord(tile)) return [];
      const remapped = remapHomeTile(tile, targets, skipped);
      return remapped ? [remapped] : [];
    });
  }

  if (isRecord(out.layout)) {
    out.layout = remapLayout(out.layout, targets, skipped);
  }

  return out;
}

/**
 * A home tile renders a `ui://` resource from a specific connection. A tile
 * saved before `connectionId` existed has none — the home API already drops
 * those, so pass it through untouched rather than inventing a mapping.
 */
function remapHomeTile(
  tile: Record<string, unknown>,
  targets: RemapTargets,
  skipped: string[],
): Record<string, unknown> | null {
  const sourceId = tile.connectionId;
  if (typeof sourceId !== "string") return tile;
  const mapped = targets.connections.get(sourceId);
  if (mapped) return { ...tile, connectionId: mapped };
  skipped.push(
    `metadata.ui home tile "${String(tile.resourceUri)}" dropped — connection "${sourceId}" was not copied.`,
  );
  return null;
}

function remapLayout(
  layout: Record<string, unknown>,
  targets: RemapTargets,
  skipped: string[],
): Record<string, unknown> {
  const out = { ...layout };

  // `tabs[].view.appId` IS a connection id (the tab renders that connection's
  // MCP UI), despite the name.
  if (Array.isArray(out.tabs)) {
    out.tabs = out.tabs.flatMap((tab) => {
      if (!isRecord(tab) || !isRecord(tab.view)) return [];
      const sourceId = tab.view.appId;
      if (typeof sourceId !== "string") return [tab];
      const mapped = targets.connections.get(sourceId);
      if (mapped) {
        return [{ ...tab, view: { ...tab.view, appId: mapped } }];
      }
      skipped.push(
        `metadata.ui.layout tab "${String(tab.title ?? tab.id)}" dropped — connection "${sourceId}" was not copied.`,
      );
      return [];
    });
  }

  // `defaultMainView.id` is a connection id ONLY for a pinned-view default
  // (`ext-app`/`ext-apps` WITH a toolName). For every other type it names a
  // declared tab or a fixed system tab, so it must be left alone.
  const view = out.defaultMainView;
  if (isRecord(view)) {
    const isPinnedViewDefault =
      (view.type === "ext-app" || view.type === "ext-apps") &&
      typeof view.toolName === "string" &&
      typeof view.id === "string";
    if (isPinnedViewDefault && typeof view.id === "string") {
      const mapped = targets.connections.get(view.id);
      if (mapped) {
        out.defaultMainView = { ...view, id: mapped };
      } else {
        skipped.push(
          `metadata.ui.layout.defaultMainView reset — connection "${view.id}" was not copied.`,
        );
        out.defaultMainView = null;
      }
    }
  }

  return out;
}
