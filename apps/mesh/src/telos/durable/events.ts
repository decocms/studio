// Mesh-native telos event union — the things the durable bus carries.
//
// Two kinds flow through the same bus:
//  - TRIGGERS (e.g. user.signup) start durable capabilities.
//  - NOTIFICATIONS (e.g. goal.installed) report that durable work finished, so
//    connected clients can update live (via the SSE hub).
//
// Every event carries `organizationId` (tenant === org in mesh) so the bus can
// scope the client notification without a per-type accessor.
export type TelosEvent =
  | {
      type: "user.signup";
      organizationId: string;
      userId: string;
      email: string;
    }
  | {
      type: "goal.installed";
      organizationId: string;
      version: number;
      title: string;
    }
  | { type: "facts.updated"; organizationId: string };

export type TelosEventType = TelosEvent["type"];

export type TelosEventOf<K extends TelosEventType> = Extract<
  TelosEvent,
  { type: K }
>;
