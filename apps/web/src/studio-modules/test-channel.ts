import type { ModuleMessage, StudioChannelModule } from "./channel";

/** Runs a module's default export with a channel the test drives. */
export async function startModule<
  In extends ModuleMessage,
  Out extends ModuleMessage,
>(module: StudioChannelModule<In, Out>) {
  const sent: Out[] = [];
  const listeners: ((message: In) => void)[] = [];
  await module({
    studioOrigin: "https://studio.example",
    url: "https://studio.example/studio-modules/v1/test.js",
    send: (message) => {
      sent.push(message);
    },
    on: (listener) => {
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    },
  });
  return {
    sent,
    /** Studio sends `message` to the module. */
    receive: (message: In) => {
      for (const listener of listeners.slice()) listener(message);
    },
    listeners,
  };
}
