// Triggers (user.signup) start capabilities; notifications (goal.installed)
// report durable work finished. Every event carries organizationId so the bus
// can scope the SSE notification.
export type TelosEvent =
  | {
      type: "user.signup";
      organizationId: string;
      userId: string;
      email: string;
      name?: string;
    }
  | {
      type: "goal.installed";
      organizationId: string;
      version: number;
      title: string;
    }
  | { type: "facts.updated"; organizationId: string }
  | { type: "goal.reached"; organizationId: string; version: number }
  | {
      type: "goal.suggestion";
      organizationId: string;
      version: number;
      kind: string;
      reason?: string;
    }
  // Ephemeral reasoning surfaced live as the agent works — research progress and
  // pursuit deliberation. SSE-only (notify, never enqueued): a missed thought is
  // harmless. `version` is absent during research (no goal yet).
  | {
      type: "goal.thought";
      organizationId: string;
      text: string;
      phase: "research" | "pursuit";
      version?: number;
    };

export type TelosEventType = TelosEvent["type"];

export type TelosEventOf<K extends TelosEventType> = Extract<
  TelosEvent,
  { type: K }
>;
