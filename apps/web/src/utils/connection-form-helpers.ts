import type { ConnectionFormData } from "@/components/details/connection/settings-tab/schema";
import type { StdioConnectionParameters } from "@decocms/shared/sdk/types";
import { envVarsToRecord, type EnvVar } from "@/components/env-vars-editor";
import type { RegistryItem } from "@/components/store/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionProviderHint = {
  id: "github" | "perplexity" | "registry";
  title?: string;
  description?: string | null;
  token?: {
    label: string;
    placeholder?: string;
    helperText?: string;
  };
  envVarKeys?: string[];
};

// ---------------------------------------------------------------------------
// URL normalization (trailing-slash / origin normalization for comparison)
// ---------------------------------------------------------------------------

function normalizeConnectionUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const normalizedPath =
      url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    return `${url.origin}${normalizedPath}`;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

export function parseNpxLikeCommand(
  input: string,
): { packageName: string } | null {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  const command = tokens[0]?.toLowerCase();
  if (command !== "npx" && command !== "bunx") return null;

  // Skip flags like -y, --yes
  const args = tokens.slice(1);
  const firstNonFlag = args.find((a) => !a.startsWith("-"));
  if (!firstNonFlag) return null;

  return { packageName: firstNonFlag };
}

// ---------------------------------------------------------------------------
// Provider hints (hardcoded well-known providers + registry matching)
// ---------------------------------------------------------------------------

export function inferHardcodedProviderHint(params: {
  uiType: ConnectionFormData["ui_type"];
  connectionUrl?: string;
  npxPackage?: string;
}): ConnectionProviderHint | null {
  const { uiType } = params;

  // GitHub Copilot MCP (hardcoded)
  const normalized = normalizeConnectionUrl(params.connectionUrl ?? "");
  if (
    (uiType === "HTTP" || uiType === "SSE" || uiType === "Websocket") &&
    normalized === normalizeConnectionUrl("https://api.githubcopilot.com/mcp/")
  ) {
    return {
      id: "github",
      title: "GitHub",
      description: "GitHub Copilot MCP",
      token: {
        label: "GitHub PAT",
        placeholder: "github_pat_…",
        helperText: "Paste a GitHub Personal Access Token (PAT)",
      },
    };
  }

  // Perplexity MCP (hardcoded)
  const npxPackage = (params.npxPackage ?? "").trim();
  if (uiType === "NPX" && npxPackage === "@perplexity-ai/mcp-server") {
    return {
      id: "perplexity",
      title: "Perplexity",
      description: "Perplexity MCP Server",
      envVarKeys: ["PERPLEXITY_API_KEY"],
    };
  }

  return null;
}

export function inferRegistryProviderHint(params: {
  uiType: ConnectionFormData["ui_type"];
  connectionUrl?: string;
  registryItems: RegistryItem[];
}): ConnectionProviderHint | null {
  if (params.registryItems.length === 0) return null;
  if (
    params.uiType !== "HTTP" &&
    params.uiType !== "SSE" &&
    params.uiType !== "Websocket"
  ) {
    return null;
  }

  const normalized = normalizeConnectionUrl(params.connectionUrl ?? "");
  if (!normalized) return null;

  const match = params.registryItems.find((item) => {
    const remotes = item.server?.remotes ?? [];
    return remotes.some(
      (r) => normalizeConnectionUrl(r.url ?? "") === normalized,
    );
  });

  if (!match) return null;

  const title =
    match.title ||
    match.name ||
    match.server?.title ||
    match.server?.name ||
    "";
  const description =
    match.server?.description || match.description || match.summary || null;

  if (!title) return null;

  return {
    id: "registry",
    title,
    description,
  };
}

// ---------------------------------------------------------------------------
// STDIO parameter builders
// ---------------------------------------------------------------------------

/**
 * Build STDIO connection_headers from NPX form fields
 */
export function buildNpxParameters(
  packageName: string,
  envVars: EnvVar[],
): StdioConnectionParameters {
  const params: StdioConnectionParameters = {
    command: "npx",
    args: ["-y", packageName],
  };
  const envRecord = envVarsToRecord(envVars);
  if (Object.keys(envRecord).length > 0) {
    params.envVars = envRecord;
  }
  return params;
}

/**
 * Build STDIO connection_headers from custom command form fields
 */
export function buildCustomStdioParameters(
  command: string,
  argsString: string,
  cwd: string | undefined,
  envVars: EnvVar[],
): StdioConnectionParameters {
  const params: StdioConnectionParameters = {
    command: command,
  };

  if (argsString.trim()) {
    params.args = argsString.trim().split(/\s+/);
  }

  if (cwd?.trim()) {
    params.cwd = cwd.trim();
  }

  const envRecord = envVarsToRecord(envVars);
  if (Object.keys(envRecord).length > 0) {
    params.envVars = envRecord;
  }

  return params;
}
