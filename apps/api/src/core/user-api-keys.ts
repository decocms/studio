/**
 * A user's API keys, listed and deleted through Better Auth's adapter.
 *
 * Its `listApiKeys` and `deleteApiKey` endpoints need a session from the
 * request headers, which the API key plugin refuses for a bearer that isn't
 * an API key (MCP OAuth, Studio JWTs). `listApiKeys` also reads one unordered
 * page of the adapter's `defaultFindManyLimit`, so a user with more keys
 * never sees the newest, and a delete that looks the key up in that list
 * answers "not found". These read every key, newest first, and delete only
 * the user's own key, as the endpoint does for database storage.
 */
import type { BetterAuthInstance, ListApiKeysResult } from "./studio-context";

const PAGE_SIZE = 500;

/** Stored JSON columns (`metadata`, `permissions`), parsed as the endpoint returns them. */
function parseStoredJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function listApiKeysForUser(
  auth: BetterAuthInstance,
  userId: string,
): Promise<ListApiKeysResult> {
  const { adapter } = await auth.$context;
  const keys: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await adapter.findMany<Record<string, unknown>>({
      model: "apikey",
      where: [{ field: "userId", value: userId }],
      sortBy: { field: "createdAt", direction: "desc" },
      limit: PAGE_SIZE,
      offset,
    });
    for (const { key: _hashedKey, ...row } of page) {
      keys.push({
        ...row,
        metadata: parseStoredJson(row.metadata),
        permissions: parseStoredJson(row.permissions),
      });
    }
    if (page.length < PAGE_SIZE) break;
  }
  return keys as ListApiKeysResult;
}

/** Deletes (revokes) one of the user's keys; another user's key reads as not found. */
export async function deleteApiKeyForUser(
  auth: BetterAuthInstance,
  userId: string,
  keyId: string,
): Promise<void> {
  const { adapter } = await auth.$context;
  const key = await adapter.findOne<{ userId: string }>({
    model: "apikey",
    where: [{ field: "id", value: keyId }],
  });
  if (!key || key.userId !== userId) throw new Error("API key not found");
  await adapter.delete({
    model: "apikey",
    where: [
      { field: "id", value: keyId },
      { field: "userId", value: userId },
    ],
  });
}
