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
    };

export type TelosEventType = TelosEvent["type"];

export type TelosEventOf<K extends TelosEventType> = Extract<
  TelosEvent,
  { type: K }
>;
