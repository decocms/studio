import { DBOS } from "@dbos-inc/dbos-sdk";

// One shared queue for all telos durable work (onboarding research + goal
// pursuit). Both paths are LLM/scrape-bound, so flow control protects the model
// gateway and the box on a signup burst — without it every concurrent signup
// fires an unbounded LLM call. workerConcurrency caps per-process concurrency;
// the rate limit is global across replicas.
export const TELOS_QUEUE = "telos";

const TELOS_WORKER_CONCURRENCY = 3;
const TELOS_RATE_LIMIT_PER_PERIOD = 30;
const TELOS_RATE_LIMIT_PERIOD_SEC = 60;

// Post-launch (registerQueue requires a launched DBOS). Idempotent: re-running
// on redeploy is a no-op when the persisted row already matches.
export async function initTelosDbos(): Promise<void> {
  await DBOS.registerQueue(TELOS_QUEUE, {
    workerConcurrency: TELOS_WORKER_CONCURRENCY,
    rateLimit: {
      limitPerPeriod: TELOS_RATE_LIMIT_PER_PERIOD,
      periodSec: TELOS_RATE_LIMIT_PERIOD_SEC,
    },
  });
}
