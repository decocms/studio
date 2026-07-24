/**
 * Type-only tool input/output map.
 *
 * Derives `{ [toolName]: { input, output } }` from the concrete `CORE_TOOLS`
 * Zod schemas, giving the web client end-to-end types for REST tool calls
 * without codegen and without bundling any server code (consumers import this
 * with `import type` only).
 */
import type { z } from "zod";
import type { CoreTools } from "./index";

type CoreTool = CoreTools[number];

/** Per-tool request (input) and response (output) types, keyed by tool name. */
export type ToolIO = {
  [T in CoreTool as T["name"]]: {
    input: z.input<T["inputSchema"]>;
    output: z.infer<T["outputSchema"]>;
  };
};
