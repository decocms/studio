// `decopilot.*` view of the unified `/watch` pool (watch-sse-pool.ts).
import type { SSESubscription } from "./create-sse-subscription";
import { decopilotWatchView } from "./watch-sse-pool";

export const decopilotSSE: SSESubscription = decopilotWatchView;
