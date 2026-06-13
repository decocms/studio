// Runnable demo: convergence to a fixed star, then a goal raised from above
// (v2) and re-pursuit — all without mutating any mover.
//   bun run example      # offline (no key)   |   bun run example:ai  # LLM

import {
  type Deliberator,
  type EventBus,
  InMemoryGoalLedger,
  inMemoryBus,
  ruleDeliberator,
  wire,
} from "../src/index";
import {
  fakeStorefrontIO,
  storefrontDomain,
  type StorefrontTarget,
} from "./domains/storefront";
import {
  calendarDomain,
  type EngagementTarget,
  fakeCalendarIO,
} from "./domains/calendar";

async function pickDeliberator(): Promise<Deliberator> {
  if (process.env.USE_AI === "1") {
    // dynamic import: only pull in `ai` when actually used
    const { aiDeliberator } = await import("../src/deliberate-ai");
    return aiDeliberator({
      model: process.env.MODEL ?? "anthropic/claude-opus-4-6",
    });
  }
  return ruleDeliberator;
}

/** Pump state.changed until the goal is reached or we hit the cap. */
async function pumpUntilReached<T>(
  bus: EventBus<T>,
  tenant: string,
  cap = 15,
): Promise<void> {
  let reached = false;
  bus.subscribe("unmovedMover.reached", async (e) => {
    if (e.tenant === tenant) reached = true;
  });
  for (let i = 0; i < cap && !reached; i++) {
    await bus.publish({ type: "state.changed", tenant });
  }
}

async function runStorefront(deliberator: Deliberator) {
  console.log("\n=== DOMAIN: storefront ===");
  const bus = inMemoryBus<StorefrontTarget>({ log: true });
  const ledger = new InMemoryGoalLedger<StorefrontTarget>();
  const io = fakeStorefrontIO();
  io.seed("acme", {
    conversionRate: 0.02,
    avgOrderValue: 55,
    bounceRate: 0.6,
    layout: ["sneaker", "hoodie", "cap"],
  });

  wire({ bus, ledger, domain: storefrontDomain(io), deliberator });

  console.log("\n-- install goal v1, pursue --");
  ledger.install("acme", {
    targetConversionRate: 0.045,
    targetAvgOrderValue: 80,
    maxBounceRate: 0.35,
  });
  await pumpUntilReached(bus, "acme");

  console.log("\n-- raise goal from above (v2), pursue again --");
  await bus.publish({
    type: "goal.updated",
    tenant: "acme",
    target: {
      targetConversionRate: 0.06,
      targetAvgOrderValue: 95,
      maxBounceRate: 0.3,
    },
  });
  await pumpUntilReached(bus, "acme");

  console.log(
    "\nledger history:",
    ledger
      .history("acme")
      .map((m) => `v${m.version}`)
      .join(" -> "),
  );
  console.log("final state:", await io.read("acme"));
}

async function runCalendar(deliberator: Deliberator) {
  console.log(
    "\n=== DOMAIN: content-calendar (same core, different matter) ===",
  );
  const bus = inMemoryBus<EngagementTarget>({ log: true });
  const ledger = new InMemoryGoalLedger<EngagementTarget>();
  const io = fakeCalendarIO();
  io.seed("creator1", {
    postsThisWeek: 1,
    avgEngagementRate: 0.02,
    backlog: ["behind the scenes", "Q&A", "tutorial", "hot take"],
  });

  wire({ bus, ledger, domain: calendarDomain(io), deliberator });

  console.log("\n-- install goal v1, pursue --");
  ledger.install("creator1", {
    targetPostsPerWeek: 4,
    targetEngagementRate: 0.04,
  });
  await pumpUntilReached(bus, "creator1");

  console.log("final state:", await io.read("creator1"));
}

async function main() {
  const deliberator = await pickDeliberator();
  console.log(
    `deliberator: ${process.env.USE_AI === "1" ? "AI (ToolLoopAgent)" : "rule-based (offline)"}`,
  );
  await runStorefront(deliberator);
  await runCalendar(deliberator);
  console.log("\ndone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
