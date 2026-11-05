/**
 * The one import of the vendored `block-meta.ts`, under the path and name
 * `@decocms/blocks`'s own `blockMeta.ts` imports it from (`./canonical.ts`,
 * an async `blockVersion`), so that file stays a byte-identical copy of the
 * package's (`cmp` it). The hash is Studio's `block-version.ts`: the same
 * function over the same canonical form.
 */

import { blockVersion as hostedBlockVersion } from "./block-version";

export async function blockVersion(block: unknown): Promise<string> {
  return hostedBlockVersion(block);
}
