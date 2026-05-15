/**
 * Dynamic agent instructions registry.
 *
 * Some agent templates need a system prompt that depends on org state at
 * run time — e.g. the brand-context agent reads back the current brand
 * row to the user. The static `metadata.instructions` on a virtual MCP
 * lives in `mesh-sdk` and can't touch `MeshContext`, so the dynamic part
 * lives here on the BE.
 *
 * Resolvers are predicate-keyed (mirrors how `isBrandContextSetup` keys
 * tool injection in dispatch-run). The first resolver to return a string
 * wins; nulls fall through. If no resolver matches, dispatch-run falls
 * back to the virtual MCP's static `metadata.instructions`.
 */

import type { MeshContext } from "@/core/mesh-context";

export type InstructionsResolver = (
  agentId: string,
  ctx: MeshContext,
) => Promise<string | null>;

class DynamicInstructionsRegistry {
  private resolvers: InstructionsResolver[] = [];

  register(resolver: InstructionsResolver): void {
    this.resolvers.push(resolver);
  }

  async resolve(agentId: string, ctx: MeshContext): Promise<string | null> {
    for (const r of this.resolvers) {
      const out = await r(agentId, ctx);
      if (out) return out;
    }
    return null;
  }
}

export const dynamicInstructions = new DynamicInstructionsRegistry();
