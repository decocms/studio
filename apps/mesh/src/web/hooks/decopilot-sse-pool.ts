// `decopilot.*` view of the unified `/watch` pool (watch-sse-pool.ts).
import type { SSESubscription } from "./create-sse-subscription";

import { ALL_DECOPILOT_EVENT_TYPES } from "@decocms/mesh-sdk";
import {
  createSSESubscription,
} from "./create-sse-subscription";

export const decopilotSSE: SSESubscription = createSSESubscription({
  buildUrl: (orgSlug) => {
    const typesParam = ALL_DECOPILOT_EVENT_TYPES.join(",");
    return `/api/${encodeURIComponent(orgSlug)}/watch?types=${typesParam}`;
  },
  eventTypes: [...ALL_DECOPILOT_EVENT_TYPES],
});
