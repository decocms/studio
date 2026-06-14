import { DBOS } from "@dbos-inc/dbos-sdk";
import { CAPABILITIES, type CapabilityDef } from "./capability";
import type { TelosEvent } from "./events";
import { TELOS_QUEUE } from "./queue";
import { requireTelosRuntime } from "./runtime";

type Enqueue = (event: TelosEvent) => Promise<unknown>;

const handles = new Map<CapabilityDef, Enqueue>();
let registered = false;

// Must run BEFORE DBOS.launch(). Guarded so HMR repeats don't re-register.
export function registerTelosCapabilities(): void {
  if (registered) return;
  registered = true;

  for (const cap of CAPABILITIES) {
    const workflowFn = (event: TelosEvent): Promise<void> =>
      cap.run(event as never, {
        runtime: requireTelosRuntime(),
        step: (name, fn, retry) =>
          DBOS.runStep(fn, { name: `${cap.name}:${name}`, ...retry }),
      });

    const wf = DBOS.registerWorkflow(workflowFn, { name: `telos.${cap.name}` });
    // Enqueue onto the shared telos queue so capability fires obey its
    // concurrency + rate limits; the deterministic workflowID still gives OAOO
    // exactly-once on top of the queue.
    handles.set(cap, (event) =>
      DBOS.startWorkflow(wf, {
        queueName: TELOS_QUEUE,
        workflowID: `telos:${cap.name}:${cap.version}:${cap.key(event as never)}`,
      })(event),
    );
  }
}

// Durably enqueue every capability subscribed to this event; OAOO collapses
// double-fires. No-op for events with no subscribers.
export async function enqueueCapabilities(event: TelosEvent): Promise<void> {
  for (const cap of CAPABILITIES) {
    if (cap.on !== event.type) continue;
    const enqueue = handles.get(cap);
    if (!enqueue) continue;
    await enqueue(event);
  }
}
