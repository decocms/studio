import {
  RepositoryBindingSchema,
  type RepositoryBinding,
} from "@decocms/shared/sdk/types/virtual-mcp";

type RepositoryMetadata = Record<string, unknown> & {
  repository?: RepositoryBinding | null;
  additionalRepositories?: RepositoryBinding[] | null;
};

// Database compatibility only: retain one physical spelling so older replicas
// can update or clear a binding without leaving a stale second copy behind.
const STORED_KEYS = {
  repository: "githubRepo",
  additionalRepositories: "githubRepos",
} as const;

export function repositoryMetadataStorageKey(key: string): string {
  return key === "repository" || key === "additionalRepositories"
    ? STORED_KEYS[key]
    : key;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function binding(value: unknown): RepositoryBinding | null {
  const source = object(value);
  // Compatibility: early GitHub bindings predate the required URL. Only those
  // two-segment records can recover a host without guessing another provider.
  const legacyUrl =
    source &&
    source.url === undefined &&
    typeof source.owner === "string" &&
    /^[\w.-]+$/.test(source.owner) &&
    typeof source.name === "string" &&
    /^[\w.-]+$/.test(source.name)
      ? `https://github.com/${source.owner}/${source.name}`
      : undefined;
  const parsed = RepositoryBindingSchema.safeParse(
    legacyUrl ? { ...source, url: legacyUrl } : value,
  );
  if (!parsed.success) return null;
  try {
    return bindingForStorage(parsed.data) ?? null;
  } catch {
    return null;
  }
}

export function readRepositoryMetadata(
  value: unknown,
): RepositoryMetadata | null {
  const source = object(value);
  if (!source) return null;
  const result: RepositoryMetadata = { ...source };
  for (const [key, storedKey] of Object.entries(STORED_KEYS)) {
    delete result[storedKey];
    if (!(key in source) && !(storedKey in source)) continue;
    const stored = Object.hasOwn(source, key) ? source[key] : source[storedKey];
    if (key === "repository") {
      result.repository = binding(stored);
    } else {
      result.additionalRepositories =
        stored === null
          ? null
          : Array.isArray(stored)
            ? stored
                .map(binding)
                .filter((repo): repo is RepositoryBinding => repo !== null)
            : [];
    }
  }
  return result;
}

function bindingForStorage(
  value: unknown,
): RepositoryBinding | null | undefined {
  if (value === null || value === undefined) return value;
  const parsed = RepositoryBindingSchema.parse(value);
  const url = new URL(parsed.url);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Repository URL must use HTTP or HTTPS");
  // Persist identity, never credentials embedded in an imported clone URL.
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return { ...parsed, url: url.toString() };
}

export function writeRepositoryMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const result = { ...metadata };
  for (const [key, storedKey] of Object.entries(STORED_KEYS)) {
    // Compatibility is for stored rows only. Reject old client payloads so an
    // outdated browser cannot silently erase a binding during a metadata write.
    if (Object.hasOwn(metadata, storedKey))
      throw new Error(
        `Repository metadata must use ${key}; ${storedKey} is a database compatibility key`,
      );
    delete result[key];
    delete result[storedKey];
    if (!Object.hasOwn(metadata, key)) continue;
    const value = metadata[key];
    if (key === "repository") result[storedKey] = bindingForStorage(value);
    else if (value === null || value === undefined) result[storedKey] = value;
    else {
      if (!Array.isArray(value))
        throw new Error("Additional repositories must be an array");
      result[storedKey] = value.map((repo) => bindingForStorage(repo));
    }
  }
  return result;
}
