import type { RepositoryBinding } from "./sdk/types/virtual-mcp";

/** A checkout's full identity, including self-hosted git servers. */
export function repositoryBindingRef(
  binding: Pick<RepositoryBinding, "url">,
): { host: string; path: string } | null {
  try {
    const url = new URL(binding.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
    return path ? { host: url.host.toLowerCase(), path: path.slice(1) } : null;
  } catch {
    return null;
  }
}

export function repositoryBindingKey(
  binding: Pick<RepositoryBinding, "url">,
): string | null {
  const ref = repositoryBindingRef(binding);
  return ref ? `${ref.host}/${ref.path}`.toLowerCase() : null;
}

export function sameRepositoryBinding(
  left: Pick<RepositoryBinding, "url" | "repositoryId">,
  right: Pick<RepositoryBinding, "url" | "repositoryId">,
): boolean {
  if (left.repositoryId && right.repositoryId)
    return left.repositoryId === right.repositoryId;
  const key = repositoryBindingKey(left);
  return key !== null && key === repositoryBindingKey(right);
}
