/** The three runtime chat tiers a harness can dispatch. Portable literal
 *  mirroring `@/tools/organization/schema:ChatTierSchema` so the harness
 *  tree carries no `@/*` reach. */
export type ChatTier = "fast" | "smart" | "thinking";
