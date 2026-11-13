import { createHash } from "node:crypto";
import { repoIdentityKey } from "@decocms/shared/git-providers";
import type { RepoContentClient } from "@/git-providers";
import { getMerged, putMerged } from "./disk-cache";
import { createSingleFlight } from "./single-flight";

const metaFlight = createSingleFlight<string | null>();

/** Reauthorize and resolve the mutable ref before reading an immutable cache entry. */
export async function readCommittedMeta(
  client: RepoContentClient,
  branch: string,
  path: string,
): Promise<string | null> {
  const head = await client.getBranch(branch);
  if (!head) return null;
  const key = createHash("sha1")
    .update(JSON.stringify(["committed-meta-v1", head.sha, path]))
    .digest("hex");
  return metaFlight.run(`${repoIdentityKey(client.repo)}:${key}`, async () => {
    const { host, path: repoPath } = client.repo;
    // Schemas often exceed the blob area's 1 MiB cap. The document area has
    // bounded admission and eviction too, with room for the complete schema.
    const cached = await getMerged(host, repoPath, key);
    if (cached !== null) return cached;
    const text = await client.readFileAtRef(head.sha, path);
    if (text !== null) await putMerged(host, repoPath, key, text);
    return text;
  });
}
