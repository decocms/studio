/**
 * Declare Binding
 *
 * Defines the minimal tool interface required for the declare plugin.
 * Connections must provide read_file, write_file, and bash tools.
 * Same as preview — both need filesystem and shell access.
 */

import { z } from "zod";
import type { Binder } from "@decocms/bindings";

export const DECLARE_BINDING = [
  {
    name: "read_file" as const,
    inputSchema: z.object({
      path: z.string(),
    }),
  },
  {
    name: "write_file" as const,
    inputSchema: z.object({
      path: z.string(),
      content: z.string(),
    }),
  },
  {
    name: "bash" as const,
    inputSchema: z.object({
      cmd: z.string(),
    }),
  },
] as const satisfies Binder;

export type DeclareBinding = typeof DECLARE_BINDING;
