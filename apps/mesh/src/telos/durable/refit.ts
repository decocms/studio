import { resolveCatalog } from "@/telos/catalog";
import type { OnboardingTarget } from "@/telos/target";
import { refitGoalFromFacts } from "@/telos/research";
import { DBOS, Debouncer } from "@dbos-inc/dbos-sdk";
import { telosBus } from "./bus";
import { telosSalt } from "./dev-salt";
import { TELOS_QUEUE } from "./queue";
import { requireTelosRuntime } from "./runtime";

// Goal re-fit from confirmed facts. Triggered (debounced) when the user edits
// facts — a burst of confirm/reject clicks coalesces into one re-fit. Separate
// from pursuit: pursuit reacts to the WORLD moving; this reacts to the user
// telling us who they are. Uses a debouncer (not an OAOO capability) precisely so
// it can re-run on every fresh edit.

const positiveMs = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const REFIT_DELAY_MS = positiveMs(process.env.TELOS_REFIT_DELAY_MS, 4_000);

// Read current goal + confirmed facts, ask for a conservative re-fit. Returns the
// new target (already validated/clamped) or null for "leave the goal as is".
async function computeRefit(
  organizationId: string,
): Promise<OnboardingTarget | null> {
  const { ledger, facts } = requireTelosRuntime().store;
  let current: Awaited<ReturnType<typeof ledger.latest>>;
  try {
    current = await ledger.latest(organizationId);
  } catch {
    return null; // no goal yet — nothing to re-fit
  }
  const confirmed = (await facts.list(organizationId))
    .filter((f) => f.status === "confirmed")
    .map((f) => ({ label: f.label, value: f.value }));
  return refitGoalFromFacts(
    confirmed,
    current.target,
    await resolveCatalog(organizationId),
  );
}

async function refitTickFn(organizationId: string): Promise<void> {
  // IO + LLM in a step (journaled, retried); installing + publishing in the
  // workflow body (publish enqueues capability workflows, which a step can't).
  const next = await DBOS.runStep(() => computeRefit(organizationId), {
    name: "telos.refit:compute",
    retriesAllowed: true,
    maxAttempts: 3,
    intervalSeconds: 2,
  });
  if (!next) return;

  const mover = await DBOS.runStep(
    () =>
      Promise.resolve(
        requireTelosRuntime().store.ledger.install(
          organizationId,
          next,
          "engine",
        ),
      ),
    { name: "telos.refit:install" },
  );

  await telosBus.publish({
    type: "goal.installed",
    organizationId,
    version: mover.version,
    title: next.title,
  });
}

let refitWf: ((organizationId: string) => Promise<void>) | null = null;
let refitDebouncer: Debouncer<[string], void> | null = null;
let registered = false;

// Must run BEFORE DBOS.launch(). Guarded so HMR repeats don't re-register.
export function registerRefitWorkflows(): void {
  if (registered) return;
  registered = true;
  refitWf = DBOS.registerWorkflow(refitTickFn, { name: "telos.refit.tick" });
  refitDebouncer = new Debouncer<[string], void>({
    workflow: refitWf,
    debounceTimeoutMs: Math.max(REFIT_DELAY_MS, 30_000),
    startWorkflowParams: { queueName: TELOS_QUEUE },
  });
}

// Debounced re-fit trigger. No-ops if not registered yet. Safe to call on every
// fact edit — the debouncer coalesces a burst into one re-fit.
export function pullRefit(organizationId: string): Promise<unknown> {
  if (!refitDebouncer) return Promise.resolve();
  return refitDebouncer.debounce(
    `telos:refit:${organizationId}${telosSalt()}`,
    REFIT_DELAY_MS,
    organizationId,
  );
}
