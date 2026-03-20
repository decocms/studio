import type { ProjectLocator } from "@decocms/mesh-sdk";
import type { AiProviderModel } from "../../../hooks/collections/use-llm";
import { LOCALSTORAGE_KEYS } from "../../../lib/localstorage-keys";

// ============================================================================
// Generic helpers
// ============================================================================

function readJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJSON<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage errors
  }
}

// ============================================================================
// Typed accessors
// ============================================================================

export function readActiveThreadId(locator: ProjectLocator): string | null {
  return readJSON<string>(LOCALSTORAGE_KEYS.assistantChatActiveTask(locator));
}

export function writeActiveThreadId(
  locator: ProjectLocator,
  threadId: string,
): void {
  writeJSON(LOCALSTORAGE_KEYS.assistantChatActiveTask(locator), threadId);
}

export function readSelectedModel(
  locator: ProjectLocator,
): AiProviderModel | null {
  const model = readJSON<AiProviderModel>(
    LOCALSTORAGE_KEYS.chatSelectedModel(locator),
  );
  // Guard against stale localStorage entries that predate the current schema.
  if (model && typeof model.modelId === "string" && !!model.title) {
    return model;
  }
  return null;
}

export function writeSelectedModel(
  locator: ProjectLocator,
  model: AiProviderModel,
): void {
  writeJSON(LOCALSTORAGE_KEYS.chatSelectedModel(locator), {
    modelId: model.modelId,
    title: model.title,
    description: model.description,
    logo: model.logo,
    providerId: model.providerId,
    capabilities: model.capabilities,
    limits: model.limits,
    costs: model.costs,
    keyId: model.keyId,
  });
}

export function readSelectedKeyId(locator: ProjectLocator): string | null {
  return readJSON<string>(LOCALSTORAGE_KEYS.chatSelectedKeyId(locator));
}

export function writeSelectedKeyId(
  locator: ProjectLocator,
  keyId: string | null,
): void {
  writeJSON(LOCALSTORAGE_KEYS.chatSelectedKeyId(locator), keyId);
}

export function readSelectedVirtualMcpId(
  locator: ProjectLocator,
): string | null {
  return readJSON<string>(`${locator}:selected-virtual-mcp-id`);
}

export function writeSelectedVirtualMcpId(
  locator: ProjectLocator,
  id: string | null,
): void {
  writeJSON(`${locator}:selected-virtual-mcp-id`, id);
}

const MAX_RECENT_AGENTS = 20;

export function readRecentAgentIds(locator: ProjectLocator): string[] {
  return readJSON<string[]>(`${locator}:recent-agent-ids`) ?? [];
}

export function pushRecentAgentId(locator: ProjectLocator, id: string): void {
  const current = readRecentAgentIds(locator).filter((x) => x !== id);
  writeJSON(
    `${locator}:recent-agent-ids`,
    [id, ...current].slice(0, MAX_RECENT_AGENTS),
  );
}

export function readOwnerFilter(locator: ProjectLocator): "me" | "everyone" {
  return (
    readJSON<"me" | "everyone">(
      LOCALSTORAGE_KEYS.chatTaskOwnerFilter(locator),
    ) ?? "me"
  );
}

export function writeOwnerFilter(
  locator: ProjectLocator,
  filter: "me" | "everyone",
): void {
  writeJSON(LOCALSTORAGE_KEYS.chatTaskOwnerFilter(locator), filter);
}
