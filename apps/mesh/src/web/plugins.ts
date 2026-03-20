import type { AnyClientPlugin } from "@decocms/bindings/plugins";
import { clientPlugin as privateRegistryPlugin } from "mesh-plugin-private-registry/client";
import { clientPlugin as workflowsPlugin } from "mesh-plugin-workflows/client";

// Registered plugins
export const sourcePlugins: AnyClientPlugin[] = [
  privateRegistryPlugin,
  workflowsPlugin,
];
