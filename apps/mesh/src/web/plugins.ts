import type { AnyClientPlugin } from "@decocms/bindings/plugins";
import { clientPlugin as workflowsPlugin } from "mesh-plugin-workflows/client";

// Registered plugins
export const sourcePlugins: AnyClientPlugin[] = [workflowsPlugin];
