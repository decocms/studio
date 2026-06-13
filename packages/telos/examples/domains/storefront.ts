// Example world (fixture). The core never mentions any of this.

import { z } from "zod";
import type { Domain } from "../../src/index";

export interface Storefront {
  tenant: string;
  conversionRate: number;
  avgOrderValue: number;
  bounceRate: number;
  layout: string[];
}

export interface StorefrontTarget {
  targetConversionRate: number;
  targetAvgOrderValue: number;
  maxBounceRate: number;
}

interface StorefrontGap {
  conversion: number;
  aov: number;
  bounce: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Fake IO with mutable state that improves as actions land — so the demo converges. */
export function fakeStorefrontIO() {
  const db = new Map<string, Storefront>();
  return {
    seed(tenant: string, s: Omit<Storefront, "tenant">) {
      db.set(tenant, { tenant, ...s });
    },
    async read(tenant: string): Promise<Storefront> {
      return structuredClone(db.get(tenant)!);
    },
    async apply(
      tenant: string,
      change: { kind: string; payload?: unknown },
    ): Promise<void> {
      const s = db.get(tenant)!;
      if (change.kind === "surface_social_proof")
        s.conversionRate = round(s.conversionRate + 0.01);
      if (change.kind === "add_bundle")
        s.avgOrderValue = round(s.avgOrderValue + 8);
      if (change.kind === "reorder_hero")
        s.bounceRate = round(Math.max(0, s.bounceRate - 0.06));
    },
  };
}

export type StorefrontIO = ReturnType<typeof fakeStorefrontIO>;

export function storefrontDomain(
  io: StorefrontIO,
): Domain<Storefront, StorefrontTarget, StorefrontGap> {
  return {
    name: "storefront",

    observe: (tenant) => io.read(tenant),

    gap: (s, t) => ({
      conversion: round(t.targetConversionRate - s.conversionRate),
      aov: round(t.targetAvgOrderValue - s.avgOrderValue),
      bounce: round(s.bounceRate - t.maxBounceRate),
    }),

    satisfied: (s, t) =>
      s.conversionRate >= t.targetConversionRate &&
      s.avgOrderValue >= t.targetAvgOrderValue &&
      s.bounceRate <= t.maxBounceRate,

    instructions:
      "You optimize a storefront toward a FIXED target you cannot change. " +
      "Apply only actions that close the measured gap; stop when it is closed.",

    actions: [
      {
        kind: "surface_social_proof",
        description: "Add reviews/ratings/badges to lift conversion rate.",
        schema: z.object({ placement: z.enum(["pdp", "cart", "home"]) }),
        apply: (tenant, input) =>
          io.apply(tenant, { kind: "surface_social_proof", payload: input }),
      },
      {
        kind: "add_bundle",
        description: "Add cross-sell bundles to raise average order value.",
        schema: z.object({ anchorProduct: z.string() }),
        apply: (tenant, input) =>
          io.apply(tenant, { kind: "add_bundle", payload: input }),
      },
      {
        kind: "reorder_hero",
        description: "Reorder the hero layout to reduce bounce rate.",
        schema: z.object({ order: z.array(z.string()) }),
        apply: (tenant, input) =>
          io.apply(tenant, { kind: "reorder_hero", payload: input }),
      },
    ],

    plan: ({ state, gap }) => {
      const steps: Array<{ kind: string; input: unknown }> = [];
      if (gap.conversion > 0)
        steps.push({
          kind: "surface_social_proof",
          input: { placement: "pdp" },
        });
      if (gap.aov > 0)
        steps.push({
          kind: "add_bundle",
          input: { anchorProduct: state.layout[0] ?? "bestseller" },
        });
      if (gap.bounce > 0)
        steps.push({
          kind: "reorder_hero",
          input: { order: [...state.layout].reverse() },
        });
      return steps;
    },

    prompt: ({ state, target, gap, tenant, moverVersion }) =>
      `Tenant ${tenant}, goal v${moverVersion}.\n` +
      `Targets — conv >= ${target.targetConversionRate}, AOV >= ${target.targetAvgOrderValue}, bounce <= ${target.maxBounceRate}.\n` +
      `Current — conv ${state.conversionRate}, AOV ${state.avgOrderValue}, bounce ${state.bounceRate}.\n` +
      `Gap — conv ${gap.conversion}, AOV ${gap.aov}, bounce ${gap.bounce}.\n` +
      `Layout — ${state.layout.join(", ")}.`,
  };
}
