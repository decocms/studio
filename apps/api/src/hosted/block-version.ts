/**
 * A block's version on the hosted CMS: the first 16 bytes of
 * `sha256(canonicalJson(block))`, as 22 characters of base64url (no
 * padding). It is what `ifMatch`, conflicts, `blocks.list`/`changes.*` and
 * the CLI's `.deco/pull.json` carry (contract §1.3), replacing
 * `gitBlobSha(serializeBlock(block))`.
 *
 * `canonicalJson` is `@decocms/blocks/protocol`'s own. The contract adds a
 * `blockVersion` export to that package; until a release carries it, this
 * is the same function over the same canonical form, checked against the
 * contract's vectors (`block-version.test.ts`).
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "@decocms/blocks/protocol";

export function blockVersion(block: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(block), "utf8")
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}
